import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "../src/core/extensions/types.ts";
import museRsiExtension, {
	buildHarnessRsiDriverArgs,
	type HarnessRsiChild,
	type HarnessRsiSpawn,
	MUSE_RSI_CHILD_ENV,
	MUSE_RSI_COMMAND_NAME,
	MUSE_RSI_DECLARATION_FILE,
	MUSE_RSI_DRIVER_SCRIPT,
	MUSE_RSI_TOOL_NAMES,
	parseHarnessRsiDeclaration,
} from "../src/extensions/muse-rsi.ts";

// ============================================================================
// Fakes: no real process is ever spawned.
// ============================================================================

interface ToolResult {
	content: Array<{ type: string; text: string }>;
	details: Record<string, unknown>;
}

interface ToolLike {
	name: string;
	description: string;
	parameters: { additionalProperties?: boolean; properties?: Record<string, unknown> };
	execute: (...args: unknown[]) => Promise<ToolResult>;
}

interface CommandLike {
	description?: string;
	handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
}

interface SpawnCall {
	executable: string;
	args: string[];
	cwd: string;
}

interface StubConfig {
	declaration?: unknown;
	exit_code?: number | null;
	output?: string;
	write_declaration?: boolean;
}

/** A scriptable spawn: writes the requested declaration, then emits output and close. */
function createStubSpawn(config: StubConfig = {}): { spawn: HarnessRsiSpawn; calls: SpawnCall[] } {
	const calls: SpawnCall[] = [];
	const spawnFn: HarnessRsiSpawn = (executable, args, options) => {
		calls.push({ executable, args, cwd: options.cwd });
		if (config.write_declaration !== false && config.declaration !== undefined) {
			writeFileSync(join(options.cwd, MUSE_RSI_DECLARATION_FILE), JSON.stringify(config.declaration));
		}
		const stdout = new EventEmitter();
		const stderr = new EventEmitter();
		const events = new EventEmitter();
		const child = {
			stdout,
			stderr,
			once: (event: string, listener: (...listenerArgs: unknown[]) => void) => {
				events.once(event, listener);
			},
			kill: () => true,
		} as unknown as HarnessRsiChild;
		const output = config.output ?? "";
		queueMicrotask(() => {
			if (output.length > 0) stdout.emit("data", output);
		});
		queueMicrotask(() => events.emit("close", config.exit_code ?? 0, null));
		return child;
	};
	return { spawn: spawnFn, calls };
}

interface FakeApi {
	api: ExtensionAPI;
	tools: Map<string, ToolLike>;
	commands: Map<string, CommandLike>;
	start(ctx: ExtensionContext): Promise<void>;
}

function createFakeApi(): FakeApi {
	const tools = new Map<string, ToolLike>();
	const commands = new Map<string, CommandLike>();
	const handlers: Array<(event: unknown, ctx: ExtensionContext) => void | Promise<void>> = [];
	const api = {
		on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => void | Promise<void>) => {
			if (event === "session_start") handlers.push(handler);
		},
		registerTool: (tool: ToolLike) => tools.set(tool.name, tool),
		registerCommand: (name: string, command: CommandLike) => commands.set(name, command),
	} as unknown as ExtensionAPI;
	return {
		api,
		tools,
		commands,
		start: async (ctx) => {
			for (const handler of handlers) await handler(undefined, ctx);
		},
	};
}

interface Notification {
	message: string;
	type?: "info" | "warning" | "error";
}

function createContext(cwd: string): {
	ctx: ExtensionCommandContext;
	notifications: Notification[];
	statuses: Array<{ key: string; text: string | undefined }>;
} {
	const notifications: Notification[] = [];
	const statuses: Array<{ key: string; text: string | undefined }> = [];
	const ctx = {
		cwd,
		ui: {
			notify: (message: string, type?: "info" | "warning" | "error") => notifications.push({ message, type }),
			setStatus: (key: string, text: string | undefined) => statuses.push({ key, text }),
		},
	} as unknown as ExtensionCommandContext;
	return { ctx, notifications, statuses };
}

interface Setup {
	fake: FakeApi;
	ctx: ExtensionCommandContext;
	notifications: Notification[];
}

async function setupExtension(options: { spawn: HarnessRsiSpawn; repoRoot: string }): Promise<Setup> {
	const fake = createFakeApi();
	museRsiExtension(fake.api, options);
	const { ctx, notifications } = createContext(options.repoRoot);
	await fake.start(ctx);
	return { fake, ctx, notifications };
}

async function runTool(setup: Setup, input: Record<string, unknown>): Promise<ToolResult> {
	const tool = setup.fake.tools.get("harness_rsi");
	if (!tool) throw new Error("harness_rsi is not registered");
	return tool.execute("call-1", input, undefined, undefined, setup.ctx);
}

const tempDirs: string[] = [];

function makeRepoRoot(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-muse-rsi-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	vi.unstubAllEnvs();
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// ============================================================================
// Registration
// ============================================================================

describe("muse-rsi extension", () => {
	it("exports the harness_rsi tool name for the orchestrator allowlist", () => {
		expect([...MUSE_RSI_TOOL_NAMES]).toEqual(["harness_rsi"]);
	});

	it("registers harness_rsi and the harness-rsi command with the expected schema", async () => {
		const repoRoot = makeRepoRoot();
		const stub = createStubSpawn({ declaration: { status: "complete", iterations: 0, remaining_gaps: [] } });
		const setup = await setupExtension({ spawn: stub.spawn, repoRoot });

		const tool = setup.fake.tools.get("harness_rsi");
		expect(tool).toBeDefined();
		expect(tool?.description).toMatch(/Muse Code/);
		expect(tool?.description).toMatch(/HARNESS_RSI_DECLARATION\.json/);
		expect(tool?.description).toMatch(/recursion/);
		expect(tool?.parameters.additionalProperties).toBe(false);
		expect(Object.keys(tool?.parameters.properties ?? {}).sort()).toEqual(["dry_run", "fixture", "max_iterations"]);
		expect((tool?.parameters.properties?.max_iterations as { minimum: number }).minimum).toBe(1);
		expect((tool?.parameters.properties?.max_iterations as { maximum: number }).maximum).toBe(64);
		expect((tool?.parameters.properties?.dry_run as { type: string }).type).toBe("boolean");
		expect(setup.fake.commands.has(MUSE_RSI_COMMAND_NAME)).toBe(true);
	});

	// ==========================================================================
	// Declaration reporting (the file is the source of truth)
	// ==========================================================================

	it("reports a complete declaration read back from the file", async () => {
		const repoRoot = makeRepoRoot();
		const stub = createStubSpawn({
			declaration: { status: "complete", iterations: 2, remaining_gaps: [] },
			exit_code: 0,
			output: "HARNESS_RSI: COMPLETE\n",
		});
		const setup = await setupExtension({ spawn: stub.spawn, repoRoot });

		const result = await runTool(setup, { max_iterations: 3 });

		expect(result.details.status).toBe("complete");
		expect(result.details.iterations).toBe(2);
		expect(result.details.remaining_gaps).toEqual([]);
		expect(result.details.declaration_path).toBe(join(repoRoot, MUSE_RSI_DECLARATION_FILE));
		expect(result.details.exit_code).toBe(0);
		expect(result.content[0]?.text).toContain("HARNESS_RSI: COMPLETE");
		expect(result.content[0]?.text).toContain("2 iteration(s)");
		expect(stub.calls).toHaveLength(1);
		expect(stub.calls[0]?.cwd).toBe(repoRoot);
		expect(stub.calls[0]?.executable).toBe(process.execPath);
		expect(stub.calls[0]?.args).toEqual([MUSE_RSI_DRIVER_SCRIPT, "--max-iterations", "3"]);
	});

	it("reports the remaining gaps when the driver declares blockage", async () => {
		const repoRoot = makeRepoRoot();
		const stub = createStubSpawn({
			declaration: {
				status: "blocked",
				iterations: 5,
				remaining_gaps: ["prompt parity", "tool X shape"],
				reason: "iteration-cap",
			},
			exit_code: 2,
		});
		const setup = await setupExtension({ spawn: stub.spawn, repoRoot });

		const result = await runTool(setup, {});

		expect(result.details.status).toBe("blocked");
		expect(result.details.iterations).toBe(5);
		expect(result.details.remaining_gaps).toEqual(["prompt parity", "tool X shape"]);
		expect(result.details.reason).toBe("iteration-cap");
		expect(result.details.error).toBeUndefined();
		expect(result.content[0]?.text).toContain("HARNESS_RSI: BLOCKED");
		expect(result.content[0]?.text).toContain("iteration-cap");
		expect(result.content[0]?.text).toContain("prompt parity");
	});

	it("trusts the declaration over the driver exit code", async () => {
		const blockedRoot = makeRepoRoot();
		const blocked = createStubSpawn({
			declaration: { status: "blocked", iterations: 1, remaining_gaps: ["still short"] },
			exit_code: 0,
		});
		const blockedSetup = await setupExtension({ spawn: blocked.spawn, repoRoot: blockedRoot });
		const blockedResult = await runTool(blockedSetup, {});
		expect(blockedResult.details.status).toBe("blocked");
		expect(blockedResult.details.exit_code).toBe(0);

		const completeRoot = makeRepoRoot();
		const complete = createStubSpawn({
			declaration: { status: "complete", iterations: 9, remaining_gaps: [] },
			exit_code: 2,
		});
		const completeSetup = await setupExtension({ spawn: complete.spawn, repoRoot: completeRoot });
		const completeResult = await runTool(completeSetup, {});
		expect(completeResult.details.status).toBe("complete");
		expect(completeResult.details.exit_code).toBe(2);
	});

	it("reports a missing declaration file as an error instead of success", async () => {
		const repoRoot = makeRepoRoot();
		const stub = createStubSpawn({ write_declaration: false, exit_code: 0 });
		const setup = await setupExtension({ spawn: stub.spawn, repoRoot });

		const result = await runTool(setup, {});

		expect(result.details.error).toBe("declaration_missing");
		expect(result.details.status).toBeNull();
		expect(result.content[0]?.text).toContain("declaration_missing");
	});

	it("reports a malformed declaration file as an error", async () => {
		const repoRoot = makeRepoRoot();
		const stub = createStubSpawn({ declaration: { unexpected: true }, exit_code: 1 });
		const setup = await setupExtension({ spawn: stub.spawn, repoRoot });

		const result = await runTool(setup, {});

		expect(result.details.error).toBe("declaration_invalid");
		expect(result.details.status).toBeNull();
	});

	// ==========================================================================
	// Recursion guard
	// ==========================================================================

	it("refuses to run when it is already inside an RSI child", async () => {
		const repoRoot = makeRepoRoot();
		const stub = createStubSpawn({ declaration: { status: "complete", iterations: 0, remaining_gaps: [] } });
		const setup = await setupExtension({ spawn: stub.spawn, repoRoot });
		vi.stubEnv(MUSE_RSI_CHILD_ENV, "1");

		const result = await runTool(setup, {});

		expect(result.details.error).toBe("nested_rsi_disabled");
		expect(result.details.status).toBeNull();
		expect(result.content[0]?.text).toContain("nested RSI is disabled");
		expect(stub.calls).toHaveLength(0);
	});

	// ==========================================================================
	// Parameter validation
	// ==========================================================================

	const invalidCases: Array<[string, Record<string, unknown>]> = [
		["max_iterations below range", { max_iterations: 0 }],
		["max_iterations above range", { max_iterations: 65 }],
		["non-integer max_iterations", { max_iterations: 1.5 }],
		["empty fixture", { fixture: "   " }],
		["non-boolean dry_run", { dry_run: "yes" }],
		["unknown parameter", { turbo: true }],
	];

	it.each(invalidCases)("rejects invalid parameters: %s", async (_label, input) => {
		const repoRoot = makeRepoRoot();
		const stub = createStubSpawn({ declaration: { status: "complete", iterations: 0, remaining_gaps: [] } });
		const setup = await setupExtension({ spawn: stub.spawn, repoRoot });

		const result = await runTool(setup, input);

		expect(result.details.error).toBe("invalid_params");
		expect(stub.calls).toHaveLength(0);
	});

	// ==========================================================================
	// Slash command
	// ==========================================================================

	it("runs the same loop from /harness-rsi and reports the declaration", async () => {
		const repoRoot = makeRepoRoot();
		const stub = createStubSpawn({ declaration: { status: "complete", iterations: 1, remaining_gaps: [] } });
		const setup = await setupExtension({ spawn: stub.spawn, repoRoot });
		const command = setup.fake.commands.get(MUSE_RSI_COMMAND_NAME);
		if (!command) throw new Error("harness-rsi command is not registered");

		await command.handler("--max-iterations 2 --dry-run", setup.ctx);

		expect(stub.calls[0]?.args).toEqual([MUSE_RSI_DRIVER_SCRIPT, "--max-iterations", "2", "--dry-run"]);
		const final = setup.notifications.at(-1);
		expect(final?.message).toContain("HARNESS_RSI: COMPLETE");
		expect(final?.type).toBe("info");
	});

	it("rejects an unknown command option without spawning", async () => {
		const repoRoot = makeRepoRoot();
		const stub = createStubSpawn({ declaration: { status: "complete", iterations: 0, remaining_gaps: [] } });
		const setup = await setupExtension({ spawn: stub.spawn, repoRoot });
		const command = setup.fake.commands.get(MUSE_RSI_COMMAND_NAME);
		if (!command) throw new Error("harness-rsi command is not registered");

		await command.handler("--wat", setup.ctx);

		expect(setup.notifications.at(-1)?.type).toBe("error");
		expect(stub.calls).toHaveLength(0);
	});
});

// ============================================================================
// Pure helpers
// ============================================================================

describe("harness-rsi declaration parsing", () => {
	it("reads the canonical declaration shape", () => {
		expect(parseHarnessRsiDeclaration({ status: "complete", iterations: 2, remaining_gaps: ["a", "b"] })).toEqual({
			status: "complete",
			iterations: 2,
			remaining_gaps: ["a", "b"],
		});
	});

	it("accepts common field aliases", () => {
		expect(parseHarnessRsiDeclaration({ result: "blocked", iteration_count: 4, gaps: ["b"] })).toEqual({
			status: "blocked",
			iterations: 4,
			remaining_gaps: ["b"],
		});
	});

	it("reads the driver's camelCase remainingGaps, reason, and structured gap objects", () => {
		expect(
			parseHarnessRsiDeclaration({
				status: "blocked",
				iterations: 3,
				remainingGaps: [
					{
						category: "tool-schema",
						pairLabel: "request 1",
						id: "workflow",
						left: "90.00%",
						right: "100%",
						detail: "schema differs",
					},
				],
				reason: "parity-gaps",
			}),
		).toEqual({
			status: "blocked",
			iterations: 3,
			remaining_gaps: ["[tool-schema] request 1 workflow: muse=90.00% | pi-muse=100%  (schema differs)"],
			reason: "parity-gaps",
		});
	});

	it("surfaces a driver-side internal error written into the declaration", () => {
		expect(
			parseHarnessRsiDeclaration({ status: "blocked", iterations: 1, remainingGaps: [], error: "boom" }),
		).toEqual({ status: "blocked", iterations: 1, remaining_gaps: [], driver_error: "boom" });
	});

	it("returns undefined for an unrecognized status", () => {
		expect(parseHarnessRsiDeclaration({ status: "maybe" })).toBeUndefined();
		expect(parseHarnessRsiDeclaration(null)).toBeUndefined();
	});
});

describe("harness-rsi driver args", () => {
	it("passes only the supplied flags", () => {
		expect(buildHarnessRsiDriverArgs({})).toEqual([MUSE_RSI_DRIVER_SCRIPT]);
		expect(buildHarnessRsiDriverArgs({ max_iterations: 5, fixture: "basic", dry_run: true })).toEqual([
			MUSE_RSI_DRIVER_SCRIPT,
			"--max-iterations",
			"5",
			"--fixture",
			"basic",
			"--dry-run",
		]);
	});
});
