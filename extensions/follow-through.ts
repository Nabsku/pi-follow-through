import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentEndEvent, ExtensionAPI, ExtensionContext, ToolResultEvent } from "@earendil-works/pi-coding-agent";

const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";

const JEV_MODEL = "jev-latest";

const DEFAULT_THRESHOLD = 0.8;

const DEFAULT_INCLUDE_TOOL_DATA = true;

// Jev is normally fast; an unavailable/slow evaluator must never hold up Pi.
const REQUEST_TIMEOUT_MS = 2_000;

// Keep the evaluator payload well below Jev's context window; the payload marks truncation explicitly.
const MAX_STATE_CHARS = 24_000;

const MAX_FIELD_CHARS = 8_000;

// TypeSafe Choice supports 255 options; reserve one option for "none".
const MAX_CHOICE_CANDIDATES = 254;

const TRUNCATION_MARKER = "\n[truncated]";

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

type StateCandidate = {
	id: string;
	text: string;
};

type ChoiceEntry = [string, string];

type JevState = {
	task: string;
	recent_transcript: string;
	final_output: string;
	previous_nudge: string | null;
	request_candidates: StateCandidate[];
	evidence_candidates: StateCandidate[];
	tool_calls?: string;
};

type JevNoulAnswer = {
	noul: number;
};

type JevChoiceAnswer = {
	choice: string;
};

type JevResponse = {
	answers: {
		should_nudge: JevNoulAnswer;
		request_evidence: JevChoiceAnswer;
		unfinished_evidence: JevChoiceAnswer;
		work_status: JevChoiceAnswer;
	};
};

type JevDecision = {
	probability: number;
};

function clip(value: string, maxChars: number): string {
	return value.length <= maxChars
		? value
		: `${value.slice(0, maxChars - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`;
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

type DelegatedWorkState = "running" | "settled" | undefined;

function stateFromText(value: string): DelegatedWorkState {
	const match = /\bstate\s*:\s*(running|complete|completed|failed|cancelled|canceled|stopped)\b/i.exec(value);

	if (match) return match[1].toLowerCase() === "running" ? "running" : "settled";

	return /\basync\s+(?:workflow|run)\b[\s\S]*\brunning\b/i.test(value) ? "running" : undefined;
}

function stateFromDetails(value: JsonValue | undefined): DelegatedWorkState {
	if (!isJsonObjectValue(value)) return undefined;

	for (const key of ["workflowState", "state"]) {
		const state = value[key];

		if (state === "running") return "running";

		if (
			state === "complete" ||
			state === "completed" ||
			state === "failed" ||
			state === "cancelled" ||
			state === "canceled" ||
			state === "stopped"
		) {
			return "settled";
		}
	}

	return stateFromDetails(value.workflowChildren);
}

function delegatedWorkState(event: ToolResultEvent): DelegatedWorkState {
	if (event.toolName !== "subagent" || event.isError) return undefined;

	const content = event.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");

	const details = isJsonValue(event.details) ? event.details : undefined;

	return stateFromText(content) ?? stateFromDetails(details);
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

function requestCandidates(lines: string[]): StateCandidate[] {
	const requests = lines
		.filter((value) => value.startsWith("USER:") && !value.includes(NUDGE_MESSAGE))
		.slice(-8)
		.map((line) => line.slice("USER: ".length));

	let remainingChars = MAX_FIELD_CHARS;

	return requests.map((text, index) => {
		const maxChars = Math.floor(remainingChars / (requests.length - index));
		const clipped = clip(text, maxChars);
		remainingChars -= clipped.length;

		return { id: `request_${index}`, text: clipped };
	});
}

function evidenceCandidates(finalOutput: string): StateCandidate[] {
	const candidates: StateCandidate[] = [];

	for (const line of finalOutput.split(/\r?\n/)) {
		const text = line.trim();

		if (!text) continue;

		candidates.push({ id: `evidence_${candidates.length}`, text });
	}

	return candidates.slice(-MAX_CHOICE_CANDIDATES);
}

function choiceCriteria(candidates: StateCandidate[], noneDescription: string) {
	const entries: ChoiceEntry[] = [["none", noneDescription]];

	for (const candidate of candidates) {
		entries.push([candidate.id, candidate.text]);
	}

	return Object.fromEntries(entries);
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
	const requests = requestCandidates(lines);

	const state: JevState = {
		task: clip(requests.map((request) => `USER: ${request.text}`).join("\n\n"), MAX_FIELD_CHARS),
		recent_transcript: clip(lines.slice(-20).join("\n\n"), MAX_STATE_CHARS),
		final_output: clip(finalOutput, MAX_FIELD_CHARS),
		previous_nudge: null,
		request_candidates: requests,
		evidence_candidates: evidenceCandidates(finalOutput),
	};

	const recentNudges = lines.filter(
		(line) => line.startsWith("USER:") && line.includes(NUDGE_MESSAGE),
	);

	state.previous_nudge = recentNudges.at(-1)?.slice("USER: ".length) ?? null;

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

	if (!isJsonObjectValue(answers)) return false;

	const shouldNudge = answers.should_nudge;

	if (!isJsonObjectValue(shouldNudge) || !isFiniteNumber(shouldNudge.noul)) return false;

	if (shouldNudge.noul < 0 || shouldNudge.noul > 1) return false;

	for (const key of ["request_evidence", "unfinished_evidence", "work_status"]) {
		const answer = answers[key];

		if (!isJsonObjectValue(answer) || typeof answer.choice !== "string") return false;
	}

	return true;
}

function hasCandidate(candidates: StateCandidate[], id: string): boolean {
	return candidates.some((candidate) => candidate.id === id);
}

function decisionFromResponse(body: JevResponse, state: JevState): JevDecision | undefined {
	const answers = body.answers;
	const requestCandidateId = answers.request_evidence.choice;
	const evidenceCandidateId = answers.unfinished_evidence.choice;

	if (answers.work_status.choice !== "incomplete") return undefined;

	if (requestCandidateId === "none" || evidenceCandidateId === "none") return undefined;

	if (!hasCandidate(state.request_candidates, requestCandidateId)) return undefined;

	if (!hasCandidate(state.evidence_candidates, evidenceCandidateId)) return undefined;

	return {
		probability: answers.should_nudge.noul,
	};
}

function progressFingerprint(state: JevState): string {
	return JSON.stringify({
		task: state.task,
		final_output: state.final_output,
		tool_calls: state.tool_calls ?? null,
	});
}

async function askJev(state: JevState): Promise<JevDecision | undefined> {
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
							"Should the agent be prompted to continue work from the user's outstanding request? Answer true only when an explicit active user request has an unfinished required step that the agent can perform now. If the active request is limited to diagnosis, explanation, review, or instructions, it is complete once that requested result is delivered; do not treat implementation, deployment, publishing, committing, or external-system changes as remaining unless the user explicitly requested that action. When the user did explicitly request implementation, a fix, verification, a commit, deployment, or cleanup, that unfinished action remains in scope. Treat an explicit statement that requested implementation, fix, verification, commit, deployment, or cleanup is not yet done and can be done now as strong evidence for true. Answer false when the requested result has been delivered, the user must provide a decision, permission, credentials, or information, or an external event is required. Statements that an unrequested mutation was not performed are not evidence of unfinished requested work. Do not expand scope or chase optional polish. When there was a previous nudge, answer true only if the latest output shows meaningful new progress or a newly exposed concrete authorized step, not the same promise or blocker.",
						criteria: {
							true: "A short continuation prompt would likely advance an unfinished action the user explicitly requested.",
							false: "The explicit request is complete, or continuation would require inventing scope, inferring authorization, user input, or an external event.",
						},
					},
					request_evidence: {
						type: "choice",
						instructions:
							"Which user request is the unfinished work about? Choose none unless one request is clearly still active and in scope.",
						criteria: choiceCriteria(
							state.request_candidates,
							"No user request is clearly still active and in scope.",
						),
					},
					unfinished_evidence: {
						type: "choice",
						instructions:
							"Which exact line from the final assistant output explicitly shows that requested work remains unfinished and can be advanced now? Choose none if no such line exists.",
						criteria: choiceCriteria(
							state.evidence_candidates,
							"The final assistant output contains no explicit evidence of unfinished, authorized work.",
						),
					},
					work_status: {
						type: "choice",
						instructions: "What is the status of the user's requested work in the final assistant output?",
						criteria: {
							complete: "The requested work is explicitly complete.",
							incomplete: "Requested work is explicitly unfinished and can continue now.",
							blocked: "Progress requires user input, permission, or an external event.",
							unknown: "The final output does not establish a safe continuation.",
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

		return isJevResponse(body) ? decisionFromResponse(body, state) : undefined;
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
	let lastNudgedProgress: string | undefined;
	let delegatedWorkPending = false;

	pi.on("session_start", () => {
		runNumber += 1;
		finalRun = undefined;
		lastNudgedProgress = undefined;
		delegatedWorkPending = false;
	});

	pi.on("agent_start", () => {
		runNumber += 1;
		finalRun = undefined;
		// The marker belongs to the preceding parent run; this run can mark it again.
		delegatedWorkPending = false;
	});

	pi.on("session_shutdown", () => {
		delegatedWorkPending = false;
	});

	pi.on("session_tree", () => {
		delegatedWorkPending = false;
	});

	pi.on("tool_result", (event) => {
		const state = delegatedWorkState(event);

		if (state === "running") delegatedWorkPending = true;

		if (state === "settled") delegatedWorkPending = false;
	});

	pi.on("agent_end", (event) => {
		finalRun = latestAssistant(event.messages);
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (
			(ctx.mode !== "tui" && ctx.mode !== "rpc") ||
			!finalRun ||
			finalRun.stopReason === "error" ||
			finalRun.stopReason === "aborted" ||
			delegatedWorkPending
		) {
			return;
		}

		const settledRun = runNumber;
		const config = configFromContext(ctx);
		const state = buildState(ctx, finalRun.finalOutput, config.includeToolData);
		void askJev(state).then((decision) => {
			if (
				decision === undefined ||
				decision.probability < config.threshold ||
				settledRun !== runNumber ||
				delegatedWorkPending ||
				!ctx.isIdle() ||
				lastNudgedProgress === progressFingerprint(state)
			) {
				return;
			}

			lastNudgedProgress = progressFingerprint(state);
			pi.sendUserMessage(NUDGE_MESSAGE);
		}).catch((error) => {
			console.warn(`[pi-follow-through] Hook failed: ${error instanceof Error ? error.message : String(error)}`);
		});
	});
}
