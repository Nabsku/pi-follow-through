import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const JEV_MODEL = "jev-latest";
const DEFAULT_THRESHOLD = 0.8;
const DEFAULT_INCLUDE_TOOL_DATA = true;
// Jev is normally fast; an unavailable/slow evaluator must never hold up Pi.
const REQUEST_TIMEOUT_MS = 2_000;
// Keep the evaluator payload well below Jev's context window; the payload marks truncation explicitly.
const MAX_STATE_CHARS = 24_000;
const MAX_FIELD_CHARS = 8_000;
const NUDGE_MESSAGE =
	"Continue useful work that is still within the user's request. Check for unfinished requested work and complete it now; do not invent follow-up work. If the request is complete, or progress needs user input, permission, or an external event, stop and say so.";

type UnknownRecord = Record<string, unknown>;

type FollowThroughConfig = {
	threshold: number;
	includeToolData: boolean;
};

type FinalRun = {
	finalOutput: string;
	stopReason?: string;
};

function clip(value: string, maxChars: number): string {
	return value.length <= maxChars ? value : `${value.slice(0, maxChars)}\n[truncated]`;
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";

	return content
		.map((part) => {
			if (!part || typeof part !== "object") return "";
			const value = part as UnknownRecord;
			return typeof value.text === "string" ? value.text : "";
		})
		.filter(Boolean)
		.join("\n");
}

function isRecord(value: unknown): value is UnknownRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readSettings(path: string): UnknownRecord {
	try {
		const value: unknown = JSON.parse(readFileSync(path, "utf8"));
		return isRecord(value) ? value : {};
	} catch {
		return {};
	}
}

function readFollowThroughSettings(settings: UnknownRecord): Partial<FollowThroughConfig> {
	const value = settings.followThrough;
	if (!isRecord(value)) return {};

	const config: Partial<FollowThroughConfig> = {};
	if (
		typeof value.threshold === "number" &&
		Number.isFinite(value.threshold) &&
		value.threshold >= 0 &&
		value.threshold <= 1
	) {
		config.threshold = value.threshold;
	}
	if (typeof value.includeToolData === "boolean") {
		config.includeToolData = value.includeToolData;
	}
	return config;
}

function configFromContext(ctx: Pick<ExtensionContext, "cwd" | "isProjectTrusted">): FollowThroughConfig {
	const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
	const global = readFollowThroughSettings(readSettings(join(agentDir, "settings.json")));
	const project = ctx.isProjectTrusted()
		? readFollowThroughSettings(readSettings(join(ctx.cwd, ".pi", "settings.json")))
		: {};

	return {
		threshold: project.threshold ?? global.threshold ?? DEFAULT_THRESHOLD,
		includeToolData: project.includeToolData ?? global.includeToolData ?? DEFAULT_INCLUDE_TOOL_DATA,
	};
}

function messageText(message: UnknownRecord): string {
	return textFromContent(message.content);
}

function toolCallsFromMessage(message: UnknownRecord): string[] {
	if (!Array.isArray(message.content)) return [];

	return message.content
		.map((part) => {
			if (!part || typeof part !== "object") return "";
			const value = part as UnknownRecord;
			if (value.type !== "toolCall" || typeof value.name !== "string") return "";
			let args = "";
			try {
				args = JSON.stringify(value.arguments ?? {});
			} catch {
				args = "[unserializable arguments]";
			}
			return `${value.name}(${args})`;
		})
		.filter(Boolean);
}

function entryText(entry: unknown, includeToolData: boolean): string {
	if (!entry || typeof entry !== "object") return "";
	const value = entry as UnknownRecord;
	const message = value.message as UnknownRecord | undefined;
	if (!message || typeof message !== "object") return "";

	const role = typeof message.role === "string" ? message.role : "message";
	const text = messageText(message);
	if (role === "assistant" || role === "user" || role === "custom") {
		return text ? `${role.toUpperCase()}: ${text}` : "";
	}
	if (role === "toolResult") {
		if (!includeToolData) return "";
		const toolName = typeof message.toolName === "string" ? message.toolName : "tool";
		return `${role.toUpperCase()} ${toolName}: ${text}`;
	}

	return text ? `${role.toUpperCase()}: ${text}` : "";
}

function latestAssistant(messages: unknown): FinalRun | undefined {
	if (!Array.isArray(messages)) return undefined;

	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (!message || typeof message !== "object") continue;
		const value = message as UnknownRecord;
		if (value.role !== "assistant") continue;

		return {
			finalOutput: clip(messageText(value), 8_000),
			stopReason: typeof value.stopReason === "string" ? value.stopReason : undefined,
		};
	}

	return undefined;
}

function branchEntries(ctx: ExtensionContext): unknown[] {
	try {
		return ctx.sessionManager.getBranch() as unknown[];
	} catch {
		return [];
	}
}

function buildState(ctx: ExtensionContext, finalOutput: string, includeToolData: boolean): UnknownRecord {
	const entries = branchEntries(ctx);
	const lines = entries.map((entry) => entryText(entry, includeToolData)).filter(Boolean);
	const requests = lines.filter((line) => line.startsWith("USER:")).slice(-8);
	const state: UnknownRecord = {
		task: clip(requests.join("\n\n"), MAX_FIELD_CHARS),
		recent_transcript: clip(lines.slice(-20).join("\n\n"), MAX_STATE_CHARS),
		final_output: clip(finalOutput, MAX_FIELD_CHARS),
	};
	const recentNudges = requests.filter((line) => line.includes(NUDGE_MESSAGE));
	state.previous_nudge = recentNudges.at(-1) ?? null;

	if (includeToolData) {
		const toolCalls = entries
			.map((entry) => {
				if (!entry || typeof entry !== "object") return [];
				const message = (entry as UnknownRecord).message;
				if (!message || typeof message !== "object") return [];
				return toolCallsFromMessage(message as UnknownRecord);
			})
			.flat()
			.slice(-20);
		state.tool_calls = clip(toolCalls.join("\n"), MAX_FIELD_CHARS);
	}

	return state;
}

function nudgeProbability(body: unknown): number | undefined {
	if (!body || typeof body !== "object") return undefined;
	const answers = (body as UnknownRecord).answers;
	if (!answers || typeof answers !== "object") return undefined;
	const answer = (answers as UnknownRecord).should_nudge;
	if (!answer || typeof answer !== "object") return undefined;

	const value = (answer as UnknownRecord).noul;
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
		? value
		: undefined;
}

async function askJev(state: UnknownRecord): Promise<number | undefined> {
	const apiKey = process.env.TYPESAFE_API_KEY ?? process.env.TYPESAFE_AI_API_KEY;
	if (!apiKey) return undefined;

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	timeout.unref?.();

	try {
		const response = await fetch(JEV_ENDPOINT, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				model: JEV_MODEL,
				state,
				questions: {
					should_nudge: {
						type: "noul",
						instructions:
							"Should the agent be prompted to continue work from the user's outstanding request? Answer true when any user-requested work remains unfinished and can be advanced now, even if the latest user message is only a confirmation such as Yes, Continue, or Retry. Treat an assistant statement that implementation, review, or requested work remains incomplete as strong evidence for true. Answer false when all requested work is complete, the user must provide a decision, permission, or information, or an external event is required. Do not expand scope or chase optional polish. A previous nudge is not by itself a reason to answer false: answer true when it led to meaningful progress or exposed a concrete authorized next step that can be completed now. Answer false only when the latest output merely repeats the same promise or blocker without new actionable progress.",
						criteria: {
							true: "A short continuation prompt would likely cause useful in-scope progress now.",
							false: "No useful continuation is available without inventing work or waiting for something outside the agent.",
						},
					},
				},
			}),
			signal: controller.signal,
		});

		if (!response.ok) {
			console.warn(`[pi-follow-through] TypeSafe returned HTTP ${response.status}; skipping nudge`);
			return undefined;
		}

		return nudgeProbability(await response.json());
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.warn(`[pi-follow-through] TypeSafe request failed: ${message}`);
		return undefined;
	} finally {
		clearTimeout(timeout);
	}
}

export default function followThrough(pi: ExtensionAPI): void {
	let runNumber = 0;
	let finalRun: FinalRun | undefined;

	pi.on("session_start", () => {
		runNumber += 1;
		finalRun = undefined;
	});

	pi.on("agent_start", () => {
		runNumber += 1;
		finalRun = undefined;
	});

	pi.on("agent_end", (event) => {
		finalRun = latestAssistant(event.messages);
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (
			(ctx.mode !== "tui" && ctx.mode !== "rpc") ||
			!finalRun ||
			finalRun.stopReason === "error" ||
			finalRun.stopReason === "aborted"
		) {
			return;
		}

		const settledRun = runNumber;
		const config = configFromContext(ctx);
		const state = buildState(ctx, finalRun.finalOutput, config.includeToolData);
		void askJev(state).then((probability) => {
			if (
				probability === undefined ||
				probability < config.threshold ||
				settledRun !== runNumber ||
				!ctx.isIdle()
			) {
				return;
			}

			pi.sendUserMessage(NUDGE_MESSAGE);
		}).catch((error) => {
			console.warn(`[pi-follow-through] Hook failed: ${error instanceof Error ? error.message : String(error)}`);
		});
	});
}
