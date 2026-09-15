import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "../src/core/extensions/types.ts";
import museSubagentsExtension, { type InProcessChildRunner } from "../src/extensions/muse-subagents.ts";

const mocks = vi.hoisted(() => ({
	openSessionFile: vi.fn(),
	createAgentSession: vi.fn(),
}));

vi.mock("../src/core/session-manager.ts", () => ({
	SessionManager: { open: mocks.openSessionFile },
}));

vi.mock("../src/core/sdk.ts", () => ({
	createAgentSession: mocks.createAgentSession,
}));

type Handler = (data: unknown) => void;

interface FakeSession {
	isStreaming?: boolean;
	prompt: ReturnType<typeof vi.fn>;
	getLastAssistantText?: () => string | null;
	dispose?: ReturnType<typeof vi.fn>;
}

interface FakeRecord {
	status?: string;
	session?: FakeSession;
	sessionFile?: string;
	pendingSteers?: string[];
}

interface ToolResult {
	content: Array<{ text: string }>;
	details: Record<string, unknown>;
}

const REGISTRY_KEY = Symbol.for("pi-subagents:manager");
const RUNNER_KEY = Symbol.for("pi-muse:subagent-runner");

type LifecycleHandler = (event: unknown, ctx: ExtensionContext) => void | Promise<void>;

function createFakeApi(subagentAvailable: boolean, options: { ctx?: ExtensionContext } = {}) {
	const handlers = new Map<string, Set<Handler>>();
	const lifecycle = new Map<string, LifecycleHandler[]>();
	const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
	const ctx =
		options.ctx ??
		({
			cwd: "/workspace",
			modelRegistry: { find: () => undefined, getAll: () => [] },
		} as unknown as ExtensionContext);

	const emit = (channel: string, data: unknown): void => {
		const params = (data ?? {}) as { requestId?: string };
		const replyChannel = `${channel}:reply:${params.requestId}`;
		if (!subagentAvailable) return;
		queueMicrotask(() => {
			let reply: unknown = { success: true };
			if (channel.endsWith(":ping")) reply = { success: true, data: { version: 2 } };
			else if (channel.endsWith(":spawn")) reply = { success: true, data: { id: "agent-1" } };
			for (const handler of handlers.get(replyChannel) ?? []) handler(reply);
		});
	};

	const events = {
		on: (channel: string, handler: Handler) => {
			const set = handlers.get(channel) ?? new Set<Handler>();
			set.add(handler);
			handlers.set(channel, set);
			return () => set.delete(handler);
		},
		emit,
	};

	const api = {
		events,
		on: (event: string, handler: LifecycleHandler) => {
			const list = lifecycle.get(event) ?? [];
			list.push(handler);
			lifecycle.set(event, list);
		},
		registerTool: (tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) => {
			tools.set(tool.name, tool);
		},
		registerProvider: () => {},
	} as unknown as ExtensionAPI;

	const runLifecycle = async (event: string): Promise<void> => {
		for (const handler of lifecycle.get(event) ?? []) await handler(undefined, ctx);
	};

	return {
		api,
		tools,
		ctx,
		start: () => runLifecycle("session_start"),
		shutdown: () => runLifecycle("session_shutdown"),
	};
}

async function startBridge(): Promise<ReturnType<typeof createFakeApi>> {
	const fake = createFakeApi(true);
	museSubagentsExtension(fake.api);
	await fake.start();
	return fake;
}

async function runTool(fake: ReturnType<typeof createFakeApi>, input: Record<string, unknown>): Promise<ToolResult> {
	return (await fake.tools.get("subagent_send_message")?.execute("t", input)) as ToolResult;
}

function installRecords(records: Record<string, FakeRecord>): void {
	(globalThis as Record<symbol, unknown>)[REGISTRY_KEY] = {
		getRecord: (id: string) => records[id],
	};
}

function installManager(manager: Record<string, unknown>): void {
	(globalThis as Record<symbol, unknown>)[REGISTRY_KEY] = {
		getRecord: () => undefined,
		...manager,
	};
}

function readRunner(): InProcessChildRunner | undefined {
	return (globalThis as Record<symbol, unknown>)[RUNNER_KEY] as InProcessChildRunner | undefined;
}

function scriptedModelContext(model: Record<string, unknown>, modelId: string): ExtensionContext {
	return {
		cwd: "/workspace",
		modelRegistry: {
			find: (provider: string, id: string) => (modelId === `${provider}/${id}` ? model : undefined),
			getAll: () => [model],
		},
	} as unknown as ExtensionContext;
}

function streamingSession(): FakeSession {
	return { isStreaming: true, prompt: vi.fn(async () => {}) };
}

function idleSession(reply: string): FakeSession {
	return {
		isStreaming: false,
		prompt: vi.fn(async () => {}),
		getLastAssistantText: () => reply,
	};
}

beforeEach(() => {
	(globalThis as Record<symbol, unknown>)[REGISTRY_KEY] = undefined;
	(globalThis as Record<symbol, unknown>)[RUNNER_KEY] = undefined;
	vi.resetAllMocks();
});

describe("muse-subagents bridge", () => {
	it("registers the subagent tools only when pi-subagents answers ping", async () => {
		const available = createFakeApi(true);
		museSubagentsExtension(available.api);
		await available.start();
		expect([...available.tools.keys()].sort()).toEqual([
			"subagent_cancel",
			"subagent_read_result",
			"subagent_send_message",
			"subagent_spawn",
			"subagent_status",
			"subagent_wait",
		]);

		const missing = createFakeApi(false);
		museSubagentsExtension(missing.api);
		await missing.start();
		expect(missing.tools.size).toBe(0);
	});

	it("maps Muse spawn args onto the pi-subagents spawn RPC", async () => {
		const fake = createFakeApi(true);
		museSubagentsExtension(fake.api);
		await fake.start();

		const spawn = fake.tools.get("subagent_spawn");
		const result = (await spawn?.execute("t", {
			command_id: "c1",
			role: "explore",
			objective: "find auth code",
			task_name: "auth-scan",
			worktree_isolation: true,
		})) as { content: Array<{ text: string }> };
		expect(result.content[0].text).toContain("agent-1");
	});

	it("requires a target for subagent_send_message", async () => {
		const fake = await startBridge();
		const result = await runTool(fake, { command_id: "c2", message: "check the auth flow" });
		expect(result.content[0].text).toContain("subagent_id or agent_path is required");
		expect(result.details).toMatchObject({ delivered: false, error: "subagent_id_or_agent_path_required" });
	});

	it("steers a streaming child for mode queue", async () => {
		const fake = await startBridge();
		const session = streamingSession();
		installRecords({ "agent-1": { status: "running", session } });

		const result = await runTool(fake, {
			command_id: "c3",
			message: "check the auth flow",
			subagent_id: "agent-1",
			mode: "queue",
		});

		expect(session.prompt).toHaveBeenCalledWith(
			"check the auth flow",
			expect.objectContaining({ streamingBehavior: "steer", expandPromptTemplates: false }),
		);
		expect(result.details).toMatchObject({
			delivered: true,
			target: "agent-1",
			channel: "steer",
			via: "live_session",
		});
		expect(result.content[0].text).toContain("steering message");
	});

	it("queues a follow-up for a streaming child in followup mode", async () => {
		const fake = await startBridge();
		const session = streamingSession();
		installRecords({ "agent-2": { status: "running", session } });

		const result = await runTool(fake, {
			command_id: "c4",
			message: "then write the tests",
			subagent_id: "agent-2",
			mode: "followup",
		});

		expect(session.prompt).toHaveBeenCalledWith(
			"then write the tests",
			expect.objectContaining({ streamingBehavior: "followUp" }),
		);
		expect(result.details).toMatchObject({ delivered: true, channel: "followUp" });
	});

	it("forces steering when interrupt is true even in followup mode", async () => {
		const fake = await startBridge();
		const session = streamingSession();
		installRecords({ "agent-3": { status: "running", session } });

		const result = await runTool(fake, {
			command_id: "c5",
			message: "stop and do this instead",
			subagent_id: "agent-3",
			mode: "followup",
			interrupt: true,
		});

		expect(session.prompt).toHaveBeenCalledWith(
			"stop and do this instead",
			expect.objectContaining({ streamingBehavior: "steer" }),
		);
		expect(result.details).toMatchObject({ delivered: true, channel: "steer" });
	});

	it("runs a new turn on an idle child session and returns the reply", async () => {
		const fake = await startBridge();
		const session = idleSession("all tests pass");
		installRecords({ "agent-4": { status: "completed", session } });

		const result = await runTool(fake, {
			command_id: "c6",
			message: "run the suite again",
			subagent_id: "agent-4",
		});

		expect(session.prompt).toHaveBeenCalledWith(
			"run the suite again",
			expect.objectContaining({ expandPromptTemplates: false }),
		);
		expect(result.details).toMatchObject({
			delivered: true,
			channel: "prompt",
			via: "live_session",
		});
		expect(result.content[0].text).toContain("all tests pass");
	});

	it("queues a message for a child whose session has not started yet", async () => {
		const fake = await startBridge();
		const record: FakeRecord = { status: "queued" };
		installRecords({ "agent-5": record });

		const result = await runTool(fake, {
			command_id: "c7",
			message: "warm up the cache",
			subagent_id: "agent-5",
		});

		expect(record.pendingSteers).toEqual(["warm up the cache"]);
		expect(result.details).toMatchObject({ delivered: true, channel: "pending", via: "pending_steers" });
		expect(result.content[0].text).toContain("session start");
	});

	it("reports a precise upstream gap when no session or session file exists", async () => {
		const fake = await startBridge();
		installRecords({ "agent-6": { status: "completed" } });

		const result = await runTool(fake, {
			command_id: "c8",
			message: "one more thing",
			subagent_id: "agent-6",
		});

		expect(result.details).toMatchObject({
			delivered: false,
			error: "child_session_unavailable",
			missing_upstream_method: "AgentManager.steer()/resume() exposed as a subagents:rpc:send handler",
		});
		expect(result.content[0].text).toContain("AgentManager");
	});

	it("reports subagent_not_found for an unknown target", async () => {
		const fake = await startBridge();
		installRecords({});

		const result = await runTool(fake, {
			command_id: "c9",
			message: "hello?",
			agent_path: "/root/agent-gone",
		});

		expect(result.details).toMatchObject({ delivered: false, error: "subagent_not_found" });
		expect(result.content[0].text).toContain("subagents:rpc:send");
	});

	it("reports the missing manager registry instead of faking delivery", async () => {
		const fake = await startBridge();
		const result = await runTool(fake, {
			command_id: "c10",
			message: "anyone there",
			subagent_id: "agent-7",
		});

		expect(result.details).toMatchObject({ delivered: false, error: "pi_subagents_registry_unavailable" });
	});

	it("resolves an @handle passed as agent_path", async () => {
		const fake = await startBridge();
		const session = streamingSession();
		installRecords({ "agent-8": { status: "running", session } });

		const result = await runTool(fake, {
			command_id: "c11",
			message: "handle delivery",
			agent_path: "@agent-8",
		});

		expect(result.details).toMatchObject({ delivered: true, target: "agent-8" });
	});

	it("reopens an evicted child session file with the pi-muse SDK runner", async () => {
		const fake = await startBridge();
		const reopened = idleSession("resumed reply");
		reopened.dispose = vi.fn();
		const sessionManager = { reopened: true };
		mocks.openSessionFile.mockReturnValue(sessionManager);
		mocks.createAgentSession.mockResolvedValue({ session: reopened });
		installRecords({ "agent-9": { status: "completed", sessionFile: "/tmp/agent-9.jsonl" } });

		const result = await runTool(fake, {
			command_id: "c12",
			message: "continue please",
			subagent_id: "agent-9",
		});

		expect(mocks.openSessionFile).toHaveBeenCalledWith("/tmp/agent-9.jsonl");
		expect(mocks.createAgentSession).toHaveBeenCalledWith({ sessionManager });
		expect(reopened.prompt).toHaveBeenCalledWith("continue please", { expandPromptTemplates: false });
		expect(reopened.dispose).toHaveBeenCalledTimes(1);
		expect(result.details).toMatchObject({
			delivered: true,
			channel: "prompt",
			via: "session_file",
			session_file: "/tmp/agent-9.jsonl",
		});
		expect(result.content[0].text).toContain("resumed reply");
	});

	it("replays a command_id without delivering twice", async () => {
		const fake = await startBridge();
		const session = streamingSession();
		installRecords({ "agent-10": { status: "running", session } });

		const first = await runTool(fake, {
			command_id: "same-command",
			message: "deliver once",
			subagent_id: "agent-10",
		});
		const second = await runTool(fake, {
			command_id: "same-command",
			message: "deliver once",
			subagent_id: "agent-10",
		});

		expect(session.prompt).toHaveBeenCalledTimes(1);
		expect(second.content[0].text).toBe(first.content[0].text);
		expect(second.details).toEqual(first.details);
	});

	it("surfaces delivery failures with delivered:false", async () => {
		const fake = await startBridge();
		const session: FakeSession = {
			isStreaming: true,
			prompt: vi.fn(async () => {
				throw new Error("child is gone");
			}),
		};
		installRecords({ "agent-11": { status: "running", session } });

		const result = await runTool(fake, {
			command_id: "c13",
			message: "hello",
			subagent_id: "agent-11",
		});

		expect(result.details).toMatchObject({ delivered: false, error: "delivery_failed" });
		expect(result.content[0].text).toContain("child is gone");
	});
});

describe("muse-subagents in-process child runner", () => {
	it("publishes the runner after ping and forwards the child request", async () => {
		const spawnAndWait = vi.fn(async () => ({
			id: "a1",
			record: {
				status: "completed",
				result: "done",
				lifetimeUsage: { input: 10, output: 5, cacheWrite: 1, cost: 0 },
			},
		}));
		installManager({ spawnAndWait, getMaxConcurrent: () => 10 });
		const ctx = {
			cwd: "/workspace",
			modelRegistry: { find: () => undefined, getAll: () => [] },
		} as unknown as ExtensionContext;
		const fake = createFakeApi(true, { ctx });
		museSubagentsExtension(fake.api);
		await fake.start();

		const runner = readRunner();
		expect(runner).toBeDefined();
		expect(runner?.maxConcurrent()).toBe(10);

		const result = await runner?.runChild({
			type: "Explore",
			prompt: "find auth",
			model: null,
			effort: "high",
			isolation: true,
			cwd: "/workspace",
		});

		expect(spawnAndWait).toHaveBeenCalledWith(
			fake.api,
			ctx,
			"Explore",
			"find auth",
			expect.objectContaining({
				description: "find auth",
				thinkingLevel: "high",
				isolation: "worktree",
				cwd: "/workspace",
			}),
		);
		expect(result).toEqual({ status: "completed", text: "done", error_kind: null, usage: { totalTokens: 16 } });
	});

	it("resolves a model override against the parent registry", async () => {
		const model = { id: "claude-haiku-4-5", name: "Haiku", provider: "anthropic" };
		const spawnAndWait = vi.fn(async () => ({ record: { status: "completed", result: "ok" } }));
		installManager({ spawnAndWait, getMaxConcurrent: () => undefined });
		const ctx = scriptedModelContext(model, "anthropic/claude-haiku-4-5");
		const fake = createFakeApi(true, { ctx });
		museSubagentsExtension(fake.api);
		await fake.start();

		const runner = readRunner();
		await runner?.runChild({
			type: "Explore",
			prompt: "p",
			model: "anthropic/claude-haiku-4-5",
			effort: null,
			isolation: false,
			cwd: null,
		});

		expect(spawnAndWait).toHaveBeenCalledWith(fake.api, ctx, "Explore", "p", expect.objectContaining({ model }));
	});

	it("reports model_not_found without spawning for an unknown model", async () => {
		const spawnAndWait = vi.fn();
		installManager({ spawnAndWait, getMaxConcurrent: () => undefined });
		const fake = createFakeApi(true);
		museSubagentsExtension(fake.api);
		await fake.start();

		const result = await readRunner()?.runChild({
			type: "Explore",
			prompt: "p",
			model: "unknown/model",
			effort: null,
			isolation: false,
			cwd: null,
		});

		expect(result?.error_kind).toBe("model_not_found");
		expect(spawnAndWait).not.toHaveBeenCalled();
	});

	it("does not publish the runner when ping fails", async () => {
		installManager({ spawnAndWait: vi.fn() });
		const fake = createFakeApi(false);
		museSubagentsExtension(fake.api);
		await fake.start();
		expect(readRunner()).toBeUndefined();
	});

	it("does not publish the runner when the manager does not expose spawnAndWait", async () => {
		installRecords({});
		const fake = createFakeApi(true);
		museSubagentsExtension(fake.api);
		await fake.start();
		expect(readRunner()).toBeUndefined();
	});

	it("unpublishes the runner on session shutdown", async () => {
		installManager({ spawnAndWait: vi.fn(), getMaxConcurrent: () => undefined });
		const fake = createFakeApi(true);
		museSubagentsExtension(fake.api);
		await fake.start();
		expect(readRunner()).toBeDefined();
		await fake.shutdown();
		expect(readRunner()).toBeUndefined();
	});
});
