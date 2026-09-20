import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentEndEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

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

type AgentMessage = AgentEndEvent["messages"][number];

type SessionEntry = ReturnType<ExtensionContext["sessionManager"]["getBranch"]>[number];

type FollowThroughAPI = Pick<ExtensionAPI, "on" | "sendUserMessage">;

type ContentMessage = Extract<AgentMessage, { role: "user" | "assistant" | "toolResult" | "custom" }>;

type JsonPrimitive = string | number | boolean | null;

type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;

type JsonObject = {
	readonly [key: string]: JsonValue;
};

type FollowThroughSettings = {
	threshold?: number;
	includeToolData?: boolean;
};

type SettingsFile = {
	followThrough?: FollowThroughSettings;
};

type FollowThroughConfig = {
	threshold: number;
	includeToolData: boolean;
};

type FinalRun = {
	finalOutput: string;
	stopReason?: string;
};

type JevState = {
	task: string;
	recent_transcript: string;
	final_output: string;
	previous_nudge: string | null;
	tool_calls?: string;
};

type JevResponse = {
	answers?: {
		should_nudge?: {
			noul?: number;
		};
	};
};

function clip(value: string, maxChars: number): string {
	return value.length <= maxChars ? value : `${value.slice(0, maxChars)}\n[truncated]`;
}

function isJsonObject(value: unknown): value is JsonObject {
	return (
		value !== null &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		Object.values(value).every(isJsonValue)
	);
}

function isJsonValue(value: unknown): value is JsonValue {
	if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
		return true;
	}

	return Array.isArray(value) ? value.every(isJsonValue) : isJsonObject(value);
}

function isJsonObjectValue(value: JsonValue | undefined): value is JsonObject {
	return value !== undefined && typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoolean(value: JsonValue | undefined): value is boolean {
	return typeof value === "boolean";
}

function isFiniteNumber(value: JsonValue | undefined): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function parseSettings(value: JsonValue): SettingsFile {
	if (!isJsonObjectValue(value)) return {};

	const rawFollowThrough = value.followThrough;

	if (!isJsonObjectValue(rawFollowThrough)) return {};

	const followThrough: FollowThroughSettings = {};

	if (
		isFiniteNumber(rawFollowThrough.threshold) &&
		rawFollowThrough.threshold >= 0 &&
		rawFollowThrough.threshold <= 1
	) {
		followThrough.threshold = rawFollowThrough.threshold;
	}

	if (isBoolean(rawFollowThrough.includeToolData)) {
		followThrough.includeToolData = rawFollowThrough.includeToolData;
	}

	return { followThrough };
}

function readSettings(path: string): SettingsFile {
	try {
		const value: unknown = JSON.parse(readFileSync(path, "utf8"));

		return isJsonValue(value) ? parseSettings(value) : {};
	} catch {
		return {};
	}
}

function configFromContext(ctx: Pick<ExtensionContext, "cwd" | "isProjectTrusted">): FollowThroughConfig {
	const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
	const global = readSettings(join(agentDir, "settings.json")).followThrough ?? {};

	const project = ctx.isProjectTrusted()
		? readSettings(join(ctx.cwd, ".pi", "settings.json")).followThrough ?? {}
		: {};

	return {
		threshold: project.threshold ?? global.threshold ?? DEFAULT_THRESHOLD,
		includeToolData: project.includeToolData ?? global.includeToolData ?? DEFAULT_INCLUDE_TOOL_DATA,
	};
}

function textFromContent(content: ContentMessage["content"]): string {
	if (!Array.isArray(content)) return content;

	return content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
}

function hasContent(message: AgentMessage): message is ContentMessage {
	return "content" in message;
}

function messageText(message: ContentMessage): string {
	return textFromContent(message.content);
}

function toolCallsFromMessage(message: AgentMessage): string[] {
	if (message.role !== "assistant") return [];

	return message.content
		.flatMap((part) => {
			if (part.type !== "toolCall") return [];
			let args = "";

			try {
				args = JSON.stringify(part.arguments ?? {}) ?? "[unserializable arguments]";
			} catch {
				args = "[unserializable arguments]";
			}

			return [`${part.name}(${args})`];
		})
}

function entryText(entry: SessionEntry, includeToolData: boolean): string {
	if (entry.type !== "message" || !hasContent(entry.message)) return "";

	const message = entry.message;
	const role = message.role;
	const text = messageText(message);

	if (role === "assistant" || role === "user" || role === "custom") {
		return text ? `${role.toUpperCase()}: ${text}` : "";
	}

	if (role === "toolResult") {
		if (!includeToolData) return "";
		const toolName = message.toolName;

		return `${role.toUpperCase()} ${toolName}: ${text}`;
	}

	return "";
}

function latestAssistant(messages: AgentEndEvent["messages"]): FinalRun | undefined {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];

		if (message.role !== "assistant") continue;

		return {
			finalOutput: clip(messageText(message), MAX_FIELD_CHARS),
			stopReason: message.stopReason,
		};
	}

	return undefined;
}

function branchEntries(ctx: ExtensionContext): SessionEntry[] {
	try {
		return ctx.sessionManager.getBranch();
	} catch {
		return [];
	}
}

function buildState(ctx: ExtensionContext, finalOutput: string, includeToolData: boolean): JevState {
	const entries = branchEntries(ctx);
	const lines = entries.map((entry) => entryText(entry, includeToolData)).filter(Boolean);
	const requests = lines.filter((line) => line.startsWith("USER:")).slice(-8);

	const state: JevState = {
		task: clip(requests.join("\n\n"), MAX_FIELD_CHARS),
		recent_transcript: clip(lines.slice(-20).join("\n\n"), MAX_STATE_CHARS),
		final_output: clip(finalOutput, MAX_FIELD_CHARS),
		previous_nudge: null,
	};

	const recentNudges = requests.filter((line) => line.includes(NUDGE_MESSAGE));
	state.previous_nudge = recentNudges.at(-1) ?? null;

	if (includeToolData) {
		const toolCalls = entries
			.flatMap((entry) => {
				return entry.type === "message" ? toolCallsFromMessage(entry.message) : [];
			})
			.slice(-20);

		state.tool_calls = clip(toolCalls.join("\n"), MAX_FIELD_CHARS);
	}

	return state;
}

function isJevResponse(value: unknown): value is JevResponse {
	if (!isJsonValue(value) || !isJsonObjectValue(value)) return false;

	const answers = value.answers;

	if (!isJsonObjectValue(answers)) return true;

	const shouldNudge = answers.should_nudge;

	if (!isJsonObjectValue(shouldNudge)) return true;

	const probability = shouldNudge.noul;

	return (
		probability === undefined ||
		(isFiniteNumber(probability) && probability >= 0 && probability <= 1)
	);
}

function nudgeProbability(body: JevResponse): number | undefined {
	return body.answers?.should_nudge?.noul;
}

async function askJev(state: JevState): Promise<number | undefined> {
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

		const body: unknown = await response.json();

		return isJevResponse(body) ? nudgeProbability(body) : undefined;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.warn(`[pi-follow-through] TypeSafe request failed: ${message}`);

		return undefined;
	} finally {
		clearTimeout(timeout);
	}
}

export default function followThrough(pi: FollowThroughAPI): void {
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
