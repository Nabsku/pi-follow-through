import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import followThrough from "../extensions/follow-through.ts";

type Handler = (...args: unknown[]) => void | Promise<void>;

type TestContentPart = {
	type?: string;
	text?: string;
	name?: string;
	arguments?: { command: string };
};

type TestMessage = {
	role: string;
	content: string | TestContentPart[];
	toolName?: string;
};

type TestEntry = {
	type: "message";
	message: TestMessage;
};

type TestContext = {
	mode: "tui";
	cwd: string;
	isProjectTrusted(): boolean;
	isIdle(): boolean;
	sessionManager: { getBranch(): TestEntry[] };
	modelRegistry?: TestModelRegistry;
};

type SettingsFixture = {
	followThrough: {
		threshold: number;
		includeToolData: boolean;
	};
};

type StateCandidate = {
	id: string;
	text: string;
};

type RequestState = {
	task: string;
	recent_transcript: string;
	final_output: string;
	previous_nudge: string | null;
	request_candidates: StateCandidate[];
	evidence_candidates: StateCandidate[];
	tool_calls?: string;
};

type RequestBody = {
	state: RequestState;
};

type ClassifierTestContext = {
	state: RequestState;
	questions: Record<string, { type: string }>;
};

type ClassifierTestProvider = {
	getAllModels(): { type: "classifier"; id: string }[];
	classify(
		model: { type: "classifier"; id: string },
		context: ClassifierTestContext,
		options?: { apiKey?: string; maxRetries?: number },
	): Promise<{
		stopReason: "stop" | "error" | "aborted";
		answers: {
			should_nudge: { type: "bool"; probability: number };
			request_evidence: { type: "choice"; choice: string };
			unfinished_evidence: { type: "choice"; choice: string };
			work_status: { type: "choice"; choice: string };
		};
	}>;
};

type TestModelRegistry = {
	getProvider(provider: string): ClassifierTestProvider | undefined;
	getApiKeyForProvider(provider: string): Promise<string | undefined>;
};

type UserMessage = Parameters<ExtensionAPI["sendUserMessage"]>[0];

type FakePi = {
	handlers: Map<string, Handler[]>;
	sentMessages: UserMessage[];
	on: ExtensionAPI["on"];
	sendUserMessage: ExtensionAPI["sendUserMessage"];
};

function createPi(): FakePi {
	const handlers = new Map<string, Handler[]>();
	const sentMessages: UserMessage[] = [];

	const on = (event: string, handler: Handler): void => {
		const eventHandlers = handlers.get(event) ?? [];
		eventHandlers.push(handler);
		handlers.set(event, eventHandlers);
	};

	const sendUserMessage = (message: UserMessage): void => {
		sentMessages.push(message);
	};

	return {
		handlers,
		sentMessages,
		// SAFETY: `on` stores and dispatches the event handlers used by this test double.
		on: on as ExtensionAPI["on"],
		sendUserMessage,
	};
}

function install(pi: FakePi): void {
	followThrough(pi);
}

function createContext(cwd: string, branch: TestEntry[], trusted = true): TestContext {
	return {
		mode: "tui",
		cwd,
		isProjectTrusted: () => trusted,
		isIdle: () => true,
		sessionManager: { getBranch: () => branch },
	};
}

async function emit(pi: FakePi, event: string, ...args: unknown[]): Promise<void> {
	for (const handler of pi.handlers.get(event) ?? []) {
		await handler(...args);
	}
}

async function settle(pi: FakePi, ctx: TestContext, finalOutput = "Done"): Promise<void> {
	await emit(pi, "session_start", {});
	await emit(pi, "agent_start", {});
	await emit(pi, "agent_end", {
		messages: [{ role: "assistant", content: finalOutput }],
	});
	await emit(pi, "agent_settled", {}, ctx);
	await new Promise<void>((resolve) => setImmediate(resolve));
}

async function writeJson(path: string, value: SettingsFixture): Promise<void> {
	await writeFile(path, `${JSON.stringify(value)}\n`);
}

async function withEnv(values: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
	const previous = new Map<string, string | undefined>();

	for (const [name, value] of Object.entries(values)) {
		previous.set(name, process.env[name]);

		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}

	try {
		await fn();
	} finally {
		for (const [name, value] of previous) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
}

function jevResponse(
	state: RequestState,
	workStatus: "complete" | "incomplete" | "blocked" | "unknown" = "incomplete",
	probability = 0.9,
): Response {
	return new Response(
		JSON.stringify({
			answers: {
				should_nudge: { type: "noul", noul: probability },
				request_evidence: { type: "choice", choice: state.request_candidates[0]?.id ?? "none" },
				unfinished_evidence: { type: "choice", choice: state.evidence_candidates[0]?.id ?? "none" },
				work_status: { type: "choice", choice: workStatus },
			},
		}),
		{ status: 200 },
	);
}

test("does not call TypeSafe or nudge without an API key", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-follow-through-"));
	const originalFetch = globalThis.fetch;
	let fetchCalls = 0;
	globalThis.fetch = async () => {
		fetchCalls += 1;
		throw new Error("network access should be skipped without an API key");
	};

	try {
		await withEnv(
			{
				PI_CODING_AGENT_DIR: agentDir,
				TYPESAFE_API_KEY: undefined,
				TYPESAFE_AI_API_KEY: undefined,
			},
			async () => {
				const pi = createPi();
				install(pi);
				await settle(pi, createContext(agentDir, []));
				assert.equal(fetchCalls, 0);
				assert.deepEqual(pi.sentMessages, []);
			},
		);
	} finally {
		globalThis.fetch = originalFetch;
		await rm(agentDir, { recursive: true, force: true });
	}
});

test("uses Pi's classifier provider when available", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-follow-through-"));
	const originalFetch = globalThis.fetch;
	let fetchCalls = 0;
	let classifyCalls = 0;

	globalThis.fetch = async () => {
		fetchCalls += 1;
		throw new Error("the Pi classifier provider should handle this request");
	};

	try {
		await withEnv(
			{ PI_CODING_AGENT_DIR: agentDir, TYPESAFE_API_KEY: "legacy-key", TYPESAFE_AI_API_KEY: undefined },
			async () => {
				const pi = createPi();

				const ctx = createContext(agentDir, [
					{ type: "message", message: { role: "user", content: "Finish the implementation." } },
				]);

				const classifierProvider: ClassifierTestProvider = {
					getAllModels: () => [{ type: "classifier", id: "jev-latest" }],
					classify: async (model, context, options) => {
						classifyCalls += 1;
						assert.deepEqual(model, { type: "classifier", id: "jev-latest" });
						assert.equal(context.questions.should_nudge?.type, "bool");
						assert.equal(options?.apiKey, "test-key");
						assert.equal(options?.maxRetries, 0);

						return {
							stopReason: "stop",
							answers: {
								should_nudge: { type: "bool", probability: 0.9 },
								request_evidence: {
									type: "choice",
									choice: context.state.request_candidates[0]?.id ?? "none",
								},
								unfinished_evidence: {
									type: "choice",
									choice: context.state.evidence_candidates[0]?.id ?? "none",
								},
								work_status: { type: "choice", choice: "incomplete" },
							},
						};
					},
				};

				ctx.modelRegistry = {
					getProvider: (provider) => (provider === "typesafe" ? classifierProvider : undefined),
					getApiKeyForProvider: async (provider) => (provider === "typesafe" ? "test-key" : undefined),
				};
				install(pi);
				await settle(pi, ctx, "The implementation remains incomplete; I can finish it now.");

				assert.equal(classifyCalls, 1);
				assert.equal(fetchCalls, 0);
				assert.equal(pi.sentMessages.length, 1);
			},
		);
	} finally {
		globalThis.fetch = originalFetch;
		await rm(agentDir, { recursive: true, force: true });
	}
});

test("uses trusted project settings and omits tool data when configured", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-follow-through-"));
	const projectDir = await mkdtemp(join(tmpdir(), "pi-follow-through-project-"));
	const projectConfigDir = join(projectDir, ".pi");
	await mkdir(projectConfigDir);
	await writeJson(join(agentDir, "settings.json"), {
		followThrough: { threshold: 0.4, includeToolData: true },
	});
	await writeJson(join(projectConfigDir, "settings.json"), {
		followThrough: { threshold: 0.95, includeToolData: false },
	});

	const branch: TestEntry[] = [
		{ type: "message", message: { role: "user", content: "Finish the implementation." } },
		{
			type: "message",
			message: {
				role: "assistant",
				content: [{ type: "toolCall", name: "bash", arguments: { command: "cat secret" } }],
			},
		},
		{ type: "message", message: { role: "toolResult", toolName: "bash", content: "secret output" } },
		{ type: "message", message: { role: "assistant", content: "Implementation remains incomplete." } },
	];

	const originalFetch = globalThis.fetch;
	const requests: RequestBody[] = [];
	globalThis.fetch = async (_input, init) => {
		// SAFETY: the extension under test serializes a request with this exact body shape.
		const request = JSON.parse(String(init?.body)) as RequestBody;
		requests.push(request);

		return jevResponse(request.state);
	};

	try {
		await withEnv(
			{ PI_CODING_AGENT_DIR: agentDir, TYPESAFE_API_KEY: "test-key", TYPESAFE_AI_API_KEY: undefined },
			async () => {
				const pi = createPi();
				install(pi);
				await settle(pi, createContext(projectDir, branch), "Implementation remains incomplete.");
				assert.equal(requests.length, 1);
				assert.deepEqual(pi.sentMessages, []);

				const request = requests[0];
				assert.ok(request);
				const state = request.state;
				assert.equal("tool_calls" in state, false);
				assert.equal(state.recent_transcript.includes("secret output"), false);
				assert.equal(state.recent_transcript.includes("Implementation remains incomplete."), true);
			},
		);
	} finally {
		globalThis.fetch = originalFetch;
		await Promise.all([
			rm(agentDir, { recursive: true, force: true }),
			rm(projectDir, { recursive: true, force: true }),
		]);
	}
});

test("caps request candidate text across the last eight user requests", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-follow-through-"));

	const branch: TestEntry[] = Array.from({ length: 8 }, (_, index) => ({
		type: "message",
		message: { role: "user", content: `request ${index}: ${"x".repeat(10_000)}` },
	}));

	const originalFetch = globalThis.fetch;
	let request: RequestBody | undefined;
	globalThis.fetch = async (_input, init) => {
		// SAFETY: The extension under test serializes this request with the RequestBody shape.
		request = JSON.parse(String(init?.body)) as RequestBody;

		return jevResponse(request.state);
	};

	try {
		await withEnv(
			{ PI_CODING_AGENT_DIR: agentDir, TYPESAFE_API_KEY: "test-key", TYPESAFE_AI_API_KEY: undefined },
			async () => {
				const pi = createPi();
				install(pi);
				await settle(pi, createContext(agentDir, branch), "Implementation remains incomplete.");
			},
		);

		assert.ok(request);
		assert.equal(request.state.request_candidates.length, 8);
		assert.ok(
			request.state.request_candidates.reduce((total, candidate) => total + candidate.text.length, 0) <= 8_000,
		);
		assert.match(request.state.request_candidates.at(-1)?.text ?? "", /^request 7:/);
		assert.match(request.state.request_candidates.at(-1)?.text ?? "", /\[truncated\]$/);
	} finally {
		globalThis.fetch = originalFetch;
		await rm(agentDir, { recursive: true, force: true });
	}
});

test("keeps follow-up actions within the explicit user request", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-follow-through-"));
	const originalFetch = globalThis.fetch;
	let instructions: Record<string, string> = {};

	globalThis.fetch = async (_input, init) => {
		// SAFETY: The extension under test serializes this request with the asserted question shape.
		const request = JSON.parse(String(init?.body)) as RequestBody & {
			questions: Record<string, { instructions: string }>;
		};

		instructions = Object.fromEntries(
			Object.entries(request.questions).map(([id, question]) => [id, question.instructions]),
		);

		return jevResponse(request.state);
	};

	try {
		await withEnv(
			{ PI_CODING_AGENT_DIR: agentDir, TYPESAFE_API_KEY: "test-key", TYPESAFE_AI_API_KEY: undefined },
			async () => {
				const pi = createPi();
				install(pi);
				await settle(
					pi,
					createContext(agentDir, [
						{ type: "message", message: { role: "user", content: "Figure out why deployment failed." } },
					]),
					"The failure is caused by missing credentials. I did not deploy a fix.",
				);
			},
		);

		assert.match(instructions.should_nudge ?? "", /limited to diagnosis, explanation, review, or instructions/);
		assert.match(instructions.should_nudge ?? "", /unless the user explicitly requested that action/);
		assert.match(
			instructions.should_nudge ?? "",
			/requested implementation, fix, verification, commit, deployment, or cleanup is not yet done/,
		);
		assert.match(instructions.should_nudge ?? "", /`request_candidates`/);
		assert.match(instructions.should_nudge ?? "", /`final_output`/);
		assert.match(instructions.request_evidence ?? "", /`request_candidates`/);
		assert.match(instructions.unfinished_evidence ?? "", /`evidence_candidates`/);
		assert.match(instructions.work_status ?? "", /`final_output`/);
	} finally {
		globalThis.fetch = originalFetch;
		await rm(agentDir, { recursive: true, force: true });
	}
});

test("nudges only when Jev cites current request evidence", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-follow-through-"));

	const branch: TestEntry[] = [
		{ type: "message", message: { role: "user", content: "Finish the implementation." } },
	];

	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (_input, init) => {
		// SAFETY: The extension under test serializes this request with the RequestBody shape.
		const request = JSON.parse(String(init?.body)) as RequestBody;

		return jevResponse(request.state);
	};

	try {
		await withEnv(
			{ PI_CODING_AGENT_DIR: agentDir, TYPESAFE_API_KEY: "test-key", TYPESAFE_AI_API_KEY: undefined },
			async () => {
				const pi = createPi();
				install(pi);
				await settle(
					pi,
					createContext(agentDir, branch),
					"The implementation remains incomplete; I can finish it now.",
				);
				await emit(pi, "agent_start", {});
				await emit(pi, "agent_end", {
					messages: [{ role: "assistant", content: "The implementation remains incomplete; I can finish it now." }],
				});
				await emit(pi, "agent_settled", {}, createContext(agentDir, branch));
				await new Promise<void>((resolve) => setImmediate(resolve));
				assert.equal(pi.sentMessages.length, 1);
			},
		);
	} finally {
		globalThis.fetch = originalFetch;
		await rm(agentDir, { recursive: true, force: true });
	}
});

test("rejects a completion status even with a high Jev probability", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-follow-through-"));

	const branch: TestEntry[] = [
		{ type: "message", message: { role: "user", content: "Finish the implementation." } },
	];

	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (_input, init) => {
		// SAFETY: The extension under test serializes this request with the RequestBody shape.
		const request = JSON.parse(String(init?.body)) as RequestBody;

		return jevResponse(request.state, "complete", 1);
	};

	try {
		await withEnv(
			{ PI_CODING_AGENT_DIR: agentDir, TYPESAFE_API_KEY: "test-key", TYPESAFE_AI_API_KEY: undefined },
			async () => {
				const pi = createPi();
				install(pi);
				await settle(pi, createContext(agentDir, branch), "The implementation is complete.");
				assert.deepEqual(pi.sentMessages, []);
			},
		);
	} finally {
		globalThis.fetch = originalFetch;
		await rm(agentDir, { recursive: true, force: true });
	}
});

test("rejects citations that are not present in the current state", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-follow-through-"));

	const branch: TestEntry[] = [
		{ type: "message", message: { role: "user", content: "Finish the implementation." } },
	];

	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (_input, init) => {
		// SAFETY: The extension under test serializes this request with the RequestBody shape.
		const request = JSON.parse(String(init?.body)) as RequestBody;

		const response = jevResponse(request.state);

		// SAFETY: The fixture was created by jevResponse and contains the fields below.
		const body = (await response.json()) as {
			answers: {
				request_evidence: { choice: string };
				unfinished_evidence: { choice: string };
			};
		};

		body.answers.request_evidence.choice = "request_missing";

		return new Response(JSON.stringify(body), { status: 200 });
	};

	try {
		await withEnv(
			{ PI_CODING_AGENT_DIR: agentDir, TYPESAFE_API_KEY: "test-key", TYPESAFE_AI_API_KEY: undefined },
			async () => {
				const pi = createPi();
				install(pi);
				await settle(
					pi,
					createContext(agentDir, branch),
					"The implementation remains incomplete; I can finish it now.",
				);
				assert.deepEqual(pi.sentMessages, []);
			},
		);
	} finally {
		globalThis.fetch = originalFetch;
		await rm(agentDir, { recursive: true, force: true });
	}
});

test("rejects answers whose declared types do not match their questions", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-follow-through-"));

	const branch: TestEntry[] = [
		{ type: "message", message: { role: "user", content: "Finish the implementation." } },
	];

	const originalFetch = globalThis.fetch;

	globalThis.fetch = async (_input, init) => {
		// SAFETY: The extension under test serializes this request with the RequestBody shape.
		const request = JSON.parse(String(init?.body)) as RequestBody;
		const response = jevResponse(request.state);

		// SAFETY: The fixture was created by jevResponse and contains the field below.
		const body = (await response.json()) as {
			answers: { should_nudge: { type: string } };
		};

		body.answers.should_nudge.type = "choice";

		return new Response(JSON.stringify(body), { status: 200 });
	};

	try {
		await withEnv(
			{ PI_CODING_AGENT_DIR: agentDir, TYPESAFE_API_KEY: "test-key", TYPESAFE_AI_API_KEY: undefined },
			async () => {
				const pi = createPi();
				install(pi);
				await settle(
					pi,
					createContext(agentDir, branch),
					"The implementation remains incomplete; I can finish it now.",
				);
				assert.deepEqual(pi.sentMessages, []);
			},
		);
	} finally {
		globalThis.fetch = originalFetch;
		await rm(agentDir, { recursive: true, force: true });
	}
});

test("does not nudge while an async subagent workflow is running", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-follow-through-"));

	const branch: TestEntry[] = [
		{ type: "message", message: { role: "user", content: "Finish the implementation." } },
	];

	const originalFetch = globalThis.fetch;
	let fetchCalls = 0;
	globalThis.fetch = async (_input, init) => {
		fetchCalls += 1;

		// SAFETY: The extension under test serializes a request with this exact body shape.
		const request = JSON.parse(String(init?.body)) as RequestBody;

		return jevResponse(request.state);
	};

	try {
		await withEnv(
			{ PI_CODING_AGENT_DIR: agentDir, TYPESAFE_API_KEY: "test-key", TYPESAFE_AI_API_KEY: undefined },
			async () => {
				const pi = createPi();
				const ctx = createContext(agentDir, branch);
				install(pi);

				await emit(pi, "session_start", {});
				await emit(pi, "agent_start", {});
				await emit(
					pi,
					"tool_result",
					{
						type: "tool_result",
						toolCallId: "subagent-call",
						toolName: "subagent",
						input: {},
						content: [{ type: "text", text: "Async workflow [workflow-id]\n\nThe async run is detached and running in the background." }],
						isError: false,
						details: { workflowChildren: { workflowState: "running" } },
					},
					ctx,
				);
				await emit(pi, "agent_end", {
					messages: [{ role: "assistant", content: "The implementation remains incomplete; I can finish it now." }],
				});
				await emit(pi, "agent_settled", {}, ctx);
				await new Promise<void>((resolve) => setImmediate(resolve));

				assert.deepEqual(pi.sentMessages, []);
				assert.equal(fetchCalls, 0);

				await emit(pi, "agent_start", {});
				await emit(pi, "agent_end", {
					messages: [{ role: "assistant", content: "The implementation remains incomplete; continue now." }],
				});
				await emit(pi, "agent_settled", {}, ctx);
				await new Promise<void>((resolve) => setImmediate(resolve));

				assert.deepEqual(pi.sentMessages, []);
				assert.equal(fetchCalls, 0);

				await emit(
					pi,
					"tool_result",
					{
						type: "tool_result",
						toolCallId: "subagent-call-complete",
						toolName: "subagent",
						input: {},
						content: [{ type: "text", text: "Workflow failed: [workflow-id]." }],
						isError: true,
						details: { workflowChildren: { workflowState: "failed" } },
					},
					ctx,
				);
				await emit(pi, "agent_start", {});
				await emit(pi, "agent_end", {
					messages: [{ role: "assistant", content: "The implementation remains incomplete; continue now." }],
				});
				await emit(pi, "agent_settled", {}, ctx);
				await new Promise<void>((resolve) => setImmediate(resolve));

				assert.equal(pi.sentMessages.length, 1);
				assert.equal(fetchCalls, 1);
			},
		);
	} finally {
		globalThis.fetch = originalFetch;
		await rm(agentDir, { recursive: true, force: true });
	}
});
