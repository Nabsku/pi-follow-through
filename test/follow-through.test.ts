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
};

type SettingsFixture = {
	followThrough: {
		threshold: number;
		includeToolData: boolean;
	};
};

type RequestState = {
	task: string;
	recent_transcript: string;
	final_output: string;
	previous_nudge: string | null;
	tool_calls?: string;
};

type RequestBody = {
	state: RequestState;
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
		requests.push(JSON.parse(String(init?.body)) as RequestBody);

		return new Response(JSON.stringify({ answers: { should_nudge: { noul: 0.9 } } }), {
			status: 200,
		});
	};

	try {
		await withEnv(
			{ PI_CODING_AGENT_DIR: agentDir, TYPESAFE_API_KEY: "test-key", TYPESAFE_AI_API_KEY: undefined },
			async () => {
				const pi = createPi();
				install(pi);
				await settle(pi, createContext(projectDir, branch));
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
