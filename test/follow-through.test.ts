import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import followThrough from "../extensions/follow-through.ts";

type Handler = (...args: unknown[]) => unknown;

type FakePi = {
	handlers: Map<string, Handler[]>;
	sentMessages: string[];
	on(event: string, handler: Handler): void;
	sendUserMessage(message: string): void;
};

function createPi(): FakePi {
	const handlers = new Map<string, Handler[]>();
	return {
		handlers,
		sentMessages: [],
		on(event, handler) {
			const eventHandlers = handlers.get(event) ?? [];
			eventHandlers.push(handler);
			handlers.set(event, eventHandlers);
		},
		sendUserMessage(message) {
			this.sentMessages.push(message);
		},
	};
}

function createContext(cwd: string, branch: unknown[], trusted = true): unknown {
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

async function settle(pi: FakePi, ctx: unknown, finalOutput = "Done"): Promise<void> {
	await emit(pi, "session_start", {});
	await emit(pi, "agent_start", {});
	await emit(pi, "agent_end", {
		messages: [{ role: "assistant", content: finalOutput }],
	});
	await emit(pi, "agent_settled", {}, ctx);
	await new Promise<void>((resolve) => setImmediate(resolve));
}

async function writeJson(path: string, value: unknown): Promise<void> {
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
	globalThis.fetch = (() => {
		fetchCalls += 1;
		throw new Error("network access should be skipped without an API key");
	}) as typeof fetch;

	try {
		await withEnv(
			{
				PI_CODING_AGENT_DIR: agentDir,
				TYPESAFE_API_KEY: undefined,
				TYPESAFE_AI_API_KEY: undefined,
			},
			async () => {
				const pi = createPi();
				followThrough(pi as never);
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

	const branch = [
		{ message: { role: "user", content: "Finish the implementation." } },
		{
			message: {
				role: "assistant",
				content: [{ type: "toolCall", name: "bash", arguments: { command: "cat secret" } }],
			},
		},
		{ message: { role: "toolResult", toolName: "bash", content: "secret output" } },
		{ message: { role: "assistant", content: "Implementation remains incomplete." } },
	];
	const originalFetch = globalThis.fetch;
	const requests: Array<Record<string, unknown>> = [];
	globalThis.fetch = (async (_input, init) => {
		requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
		return {
			ok: true,
			status: 200,
			json: async () => ({ answers: { should_nudge: { noul: 0.9 } } }),
		} as Response;
	}) as typeof fetch;

	try {
		await withEnv(
			{ PI_CODING_AGENT_DIR: agentDir, TYPESAFE_API_KEY: "test-key", TYPESAFE_AI_API_KEY: undefined },
			async () => {
				const pi = createPi();
				followThrough(pi as never);
				await settle(pi, createContext(projectDir, branch));
				assert.equal(requests.length, 1);
				assert.deepEqual(pi.sentMessages, []);

				const state = requests[0]?.state as Record<string, unknown>;
				assert.equal("tool_calls" in state, false);
				assert.equal(String(state.recent_transcript).includes("secret output"), false);
				assert.equal(String(state.recent_transcript).includes("Implementation remains incomplete."), true);
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
