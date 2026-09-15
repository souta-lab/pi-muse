import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import {
	createWorkflowToolDefinition,
	normalizeWorkflowEffort,
	readInProcessChildRunner,
	resolveChildLaunchOptions,
	resolveWorkflowIsolationShape,
	validateWorkflowInlineSchema,
	type WorkflowChildRequest,
	type WorkflowChildResult,
	type WorkflowChildRunner,
	type WorkflowChildRunnerContext,
	type WorkflowPhaseGroup,
} from "../src/core/tools/muse-workflow.ts";
import type {
	InProcessChildRunner,
	InProcessChildRunRequest,
	InProcessChildRunResult,
} from "../src/extensions/muse-subagents.ts";

const sdkMocks = vi.hoisted(() => ({ createAgentSession: vi.fn() }));

vi.mock("../src/core/sdk.ts", () => ({ createAgentSession: sdkMocks.createAgentSession }));

const tempDirs: string[] = [];
const IN_PROCESS_RUNNER_KEY = Symbol.for("pi-muse:subagent-runner");

function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-muse-workflow-"));
	tempDirs.push(dir);
	return dir;
}

function initGitRepo(dir: string): void {
	execFileSync("git", ["init", "-q"], { cwd: dir });
	execFileSync(
		"git",
		["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-q", "--allow-empty", "-m", "init"],
		{
			cwd: dir,
		},
	);
}

interface InstalledInProcessRunner {
	calls: InProcessChildRunRequest[];
	maxInFlight: () => number;
}

function installInProcessRunner(
	options: {
		maxConcurrent?: number;
		onRun?: (request: InProcessChildRunRequest) => Promise<InProcessChildRunResult> | InProcessChildRunResult;
	} = {},
): InstalledInProcessRunner {
	const calls: InProcessChildRunRequest[] = [];
	let inFlight = 0;
	let maxInFlight = 0;
	const handle: InProcessChildRunner = {
		async runChild(request) {
			calls.push(request);
			inFlight += 1;
			maxInFlight = Math.max(maxInFlight, inFlight);
			try {
				if (options.onRun) return await options.onRun(request);
				return {
					status: "completed",
					text: `child:${request.type}`,
					error_kind: null,
					usage: { totalTokens: 42 },
				};
			} finally {
				inFlight -= 1;
			}
		},
		maxConcurrent: () => options.maxConcurrent,
	};
	(globalThis as Record<symbol, unknown>)[IN_PROCESS_RUNNER_KEY] = handle;
	return { calls, maxInFlight: () => maxInFlight };
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	delete (globalThis as Record<symbol, unknown>)[IN_PROCESS_RUNNER_KEY];
	sdkMocks.createAgentSession.mockReset();
});

const ctx = (cwd: string): ExtensionContext => ({ cwd }) as unknown as ExtensionContext;

type WorkflowTool = ReturnType<typeof createWorkflowToolDefinition>;
type WorkflowParams = Parameters<WorkflowTool["execute"]>[1];

interface ExecutedWorkflow {
	content: Array<{ type: string; text?: string }>;
	details: {
		runId: string;
		scriptPath?: string;
		scriptHash?: string;
		status: "ok" | "error";
		errorCode?: string;
		agentCalls: number;
		logs: string[];
		phases: string[];
		phaseGroups: WorkflowPhaseGroup[];
	};
}

async function executeWorkflow(
	cwd: string,
	tool: WorkflowTool,
	params: WorkflowParams,
): Promise<{ payload: Record<string, unknown>; details: ExecutedWorkflow["details"] }> {
	const result = (await tool.execute("workflow-call", params, undefined, undefined, ctx(cwd))) as ExecutedWorkflow;
	const first = result.content[0];
	if (!first || first.type !== "text" || typeof first.text !== "string") {
		throw new Error("workflow tool returned no text payload");
	}
	return { payload: JSON.parse(first.text) as Record<string, unknown>, details: result.details };
}

interface StubCall {
	request: WorkflowChildRequest;
	runId: string;
	callIndex: number;
}

interface StubRunnerOptions {
	delayMs?: number;
	onCall?: (
		request: WorkflowChildRequest,
		context: WorkflowChildRunnerContext,
	) => Partial<WorkflowChildResult> | undefined;
}

interface StubRunner {
	runner: WorkflowChildRunner;
	calls: StubCall[];
	callCount: () => number;
	maxInFlight: () => number;
}

function createStubRunner(options: StubRunnerOptions = {}): StubRunner {
	const calls: StubCall[] = [];
	let inFlight = 0;
	let maxInFlight = 0;
	const runner: WorkflowChildRunner = async (request, context) => {
		calls.push({ request, runId: context.runId, callIndex: context.callIndex });
		inFlight += 1;
		maxInFlight = Math.max(maxInFlight, inFlight);
		try {
			await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, options.delayMs ?? 5));
			const override = options.onCall?.(request, context);
			return {
				ref: `stub:${context.callIndex}`,
				text: `echo:${request.input}`,
				summary: request.input,
				error_kind: null,
				...override,
			};
		} finally {
			inFlight -= 1;
		}
	};
	return { runner, calls, callCount: () => calls.length, maxInFlight: () => maxInFlight };
}

const SIMPLE_SCRIPT = 'export default async function workflow(host) { return { status: "ok" }; }';

describe("workflow tool schema parity", () => {
	it("matches the official Muse schema property names, descriptions, and required set", () => {
		const official = JSON.parse(readFileSync(new URL("./fixtures/muse/schemas.json", import.meta.url), "utf-8")) as {
			workflow: {
				description: string;
				parameters: {
					type: string;
					additionalProperties: boolean;
					required?: string[];
					properties: Record<string, { description?: string }>;
				};
			};
		};
		const ref = official.workflow;
		const tool = createWorkflowToolDefinition(makeTempDir(), { childRunner: createStubRunner().runner });
		const parameters = tool.parameters as unknown as {
			type: string;
			additionalProperties: boolean;
			required?: string[];
			properties: Record<string, { description?: string }>;
		};

		expect(tool.description).toBe(ref.description);
		expect(parameters.type).toBe("object");
		expect(parameters.additionalProperties).toBe(false);
		expect(Object.keys(parameters.properties).sort()).toEqual(Object.keys(ref.parameters.properties).sort());
		expect(parameters.required ?? []).toEqual(ref.parameters.required ?? []);
		for (const [name, property] of Object.entries(ref.parameters.properties)) {
			expect(parameters.properties[name]?.description).toBe(property.description);
		}
	});
});

describe("workflow script persistence", () => {
	it("persists the inline script under .pi/muse-workflows and echoes runId, scriptPath, and scriptHash", async () => {
		const cwd = makeTempDir();
		const stub = createStubRunner();
		const tool = createWorkflowToolDefinition(cwd, { childRunner: stub.runner });

		const { payload } = await executeWorkflow(cwd, tool, { script: SIMPLE_SCRIPT });

		const runId = payload.runId as string;
		const expectedHash = `sha256:${createHash("sha256").update(SIMPLE_SCRIPT, "utf-8").digest("hex")}`;
		const persistedPath = join(cwd, ".pi", "muse-workflows", `${runId}.mjs`);

		expect(runId.length).toBeGreaterThan(0);
		expect(payload.status).toBe("ok");
		expect(payload.scriptHash).toBe(expectedHash);
		expect(payload.scriptPath).toBe(`.pi/muse-workflows/${runId}.mjs`);
		expect(readFileSync(persistedPath, "utf-8")).toBe(SIMPLE_SCRIPT);
		expect(resolve(cwd, payload.scriptPath as string)).toBe(persistedPath);
		expect(stub.callCount()).toBe(0);
	});

	it("honors an explicit in-workspace scriptPath as the persistence target", async () => {
		const cwd = makeTempDir();
		const stub = createStubRunner();
		const tool = createWorkflowToolDefinition(cwd, { childRunner: stub.runner });

		const { payload } = await executeWorkflow(cwd, tool, {
			script: SIMPLE_SCRIPT,
			scriptPath: "custom/location/flow.mjs",
		});

		expect(readFileSync(join(cwd, "custom", "location", "flow.mjs"), "utf-8")).toBe(SIMPLE_SCRIPT);
		expect(payload.scriptPath).toBe("custom/location/flow.mjs");
	});

	it("runs a persisted script read from scriptPath without an inline script", async () => {
		const cwd = makeTempDir();
		const stub = createStubRunner();
		const tool = createWorkflowToolDefinition(cwd, { childRunner: stub.runner });
		const scriptPath = join(cwd, ".pi", "muse-workflows", "persisted.mjs");
		mkdirSync(join(cwd, ".pi", "muse-workflows"), { recursive: true });
		writeFileSync(scriptPath, SIMPLE_SCRIPT);

		const { payload, details } = await executeWorkflow(cwd, tool, { scriptPath });

		expect(payload.status).toBe("ok");
		expect(payload.scriptPath).toBe(".pi/muse-workflows/persisted.mjs");
		expect(details.status).toBe("ok");
		expect(readFileSync(scriptPath, "utf-8")).toBe(SIMPLE_SCRIPT);
	});
});

describe("workflow args and host API", () => {
	it("passes args through deeply frozen and resolves host.agent results", async () => {
		const cwd = makeTempDir();
		const stub = createStubRunner();
		const tool = createWorkflowToolDefinition(cwd, { childRunner: stub.runner });
		const script = `export default async function workflow(host) {
	const first = await host.agent({ input: "alpha", label: "A" });
	const second = await host.agent("beta", { label: "B" });
	const batch = await host.parallel([{ input: "p1" }, { input: "p2" }]);
	host.log("did work");
	host.phase("Synthesis");
	return {
		status: "ok",
		ref: first.ref,
		text: second.text,
		batch: batch.map((item) => item.text),
		frozen: Object.isFrozen(host.args) && Object.isFrozen(host.args.nested),
		args: host.args,
	};
}`;
		const args = { topic: "x", nested: { depth: 1 } };

		const { payload, details } = await executeWorkflow(cwd, tool, { script, args });

		expect(payload.status).toBe("ok");
		expect(payload.result).toEqual({
			status: "ok",
			ref: "stub:0",
			text: "echo:beta",
			batch: ["echo:p1", "echo:p2"],
			frozen: true,
			args,
		});
		expect(payload.agentCalls).toBe(4);
		expect(stub.calls.map((call) => call.request.input)).toEqual(["alpha", "beta", "p1", "p2"]);
		expect(stub.calls[1]?.request.label).toBe("B");
		expect(details.logs).toEqual(["did work"]);
		expect(details.phases).toEqual(["Synthesis"]);
	});

	it("passes a primitive args value through as the same primitive", async () => {
		const cwd = makeTempDir();
		const stub = createStubRunner();
		const tool = createWorkflowToolDefinition(cwd, { childRunner: stub.runner });
		const script = `export default async function workflow(host) { return { args: host.args, type: typeof host.args }; }`;

		const { payload } = await executeWorkflow(cwd, tool, { script, args: "plain-string" });

		expect(payload.result).toEqual({ args: "plain-string", type: "string" });
	});

	it("supports the bare-globals script shape with agent, log, and top-level return", async () => {
		const cwd = makeTempDir();
		const stub = createStubRunner();
		const tool = createWorkflowToolDefinition(cwd, { childRunner: stub.runner });
		const script = `const result = await agent("bare hello");
log("bare log");
return { status: "ok", ref: result.ref, text: result.text };`;

		const { payload, details } = await executeWorkflow(cwd, tool, { script });

		expect(payload.status).toBe("ok");
		expect(payload.result).toEqual({ status: "ok", ref: "stub:0", text: "echo:bare hello" });
		expect(details.logs).toEqual(["bare log"]);
	});

	it("drops a pipeline item to null when one of its stages throws", async () => {
		const cwd = makeTempDir();
		const stub = createStubRunner();
		const tool = createWorkflowToolDefinition(cwd, { childRunner: stub.runner });
		const script = `export default async function workflow(host) {
	const results = await host.pipeline(["keep", "drop"], async (prev, item) => {
		if (item === "drop") throw new Error("boom");
		return await host.agent({ input: item });
	});
	return { results };
}`;

		const { payload } = await executeWorkflow(cwd, tool, { script });

		const result = payload.result as { results: Array<{ text?: string } | null> };
		expect(result.results[0]?.text).toBe("echo:keep");
		expect(result.results[1]).toBeNull();
	});
});

describe("workflow guard rails", () => {
	it("rejects a non-canonical expectedScriptHash as invalid input", async () => {
		const cwd = makeTempDir();
		const stub = createStubRunner();
		const tool = createWorkflowToolDefinition(cwd, { childRunner: stub.runner });

		const { payload, details } = await executeWorkflow(cwd, tool, {
			script: SIMPLE_SCRIPT,
			expectedScriptHash: "sha256:NOT-A-HASH",
		});

		expect(payload.status).toBe("error");
		expect((payload.error as { code: string }).code).toBe("invalid_input");
		expect(details.errorCode).toBe("invalid_input");
		expect(stub.callCount()).toBe(0);
	});

	it("rejects a mismatching expectedScriptHash before persisting or launching any child", async () => {
		const cwd = makeTempDir();
		const stub = createStubRunner();
		const tool = createWorkflowToolDefinition(cwd, { childRunner: stub.runner });
		const wrongHash = `sha256:${"0".repeat(64)}`;

		const { payload } = await executeWorkflow(cwd, tool, {
			script: SIMPLE_SCRIPT,
			expectedScriptHash: wrongHash,
		});

		expect(payload.status).toBe("error");
		expect((payload.error as { code: string }).code).toBe("hash_mismatch");
		expect(stub.callCount()).toBe(0);
		expect(existsSync(join(cwd, ".pi", "muse-workflows"))).toBe(false);
	});

	it("launches when expectedScriptHash matches the selected bytes", async () => {
		const cwd = makeTempDir();
		const stub = createStubRunner();
		const tool = createWorkflowToolDefinition(cwd, { childRunner: stub.runner });
		const expected = `sha256:${createHash("sha256").update(SIMPLE_SCRIPT, "utf-8").digest("hex")}`;

		const { payload } = await executeWorkflow(cwd, tool, { script: SIMPLE_SCRIPT, expectedScriptHash: expected });

		expect(payload.status).toBe("ok");
		expect(payload.scriptHash).toBe(expected);
	});

	it("returns a structured error when the script returns undefined", async () => {
		const cwd = makeTempDir();
		const stub = createStubRunner();
		const tool = createWorkflowToolDefinition(cwd, { childRunner: stub.runner });

		const { payload } = await executeWorkflow(cwd, tool, {
			script: "export default async function workflow() {}",
		});

		expect(payload.status).toBe("error");
		expect((payload.error as { code: string }).code).toBe("undefined_result");
	});

	it("returns a structured error when the script throws", async () => {
		const cwd = makeTempDir();
		const stub = createStubRunner();
		const tool = createWorkflowToolDefinition(cwd, { childRunner: stub.runner });

		const { payload } = await executeWorkflow(cwd, tool, {
			script: 'export default async function workflow() { throw new Error("script exploded"); }',
		});

		expect(payload.status).toBe("error");
		expect((payload.error as { code: string }).code).toBe("script_error");
		expect((payload.error as { message: string }).message).toContain("script exploded");
	});

	it("rejects a call without any source and reports an unknown saved-workflow name", async () => {
		const cwd = makeTempDir();
		const stub = createStubRunner();
		const tool = createWorkflowToolDefinition(cwd, { childRunner: stub.runner });

		const empty = await executeWorkflow(cwd, tool, {});
		expect((empty.payload.error as { code: string }).code).toBe("invalid_input");

		const byName = await executeWorkflow(cwd, tool, { name: "generated.review-change" });
		expect((byName.payload.error as { code: string }).code).toBe("workflow_not_found");
	});

	it("bounds parallel fan-out to maxConcurrentChildren", async () => {
		const cwd = makeTempDir();
		const stub = createStubRunner({ delayMs: 25 });
		const tool = createWorkflowToolDefinition(cwd, { childRunner: stub.runner, maxConcurrentChildren: 2 });
		const script = `export default async function workflow(host) {
	const results = await host.parallel(${JSON.stringify([1, 2, 3, 4, 5, 6].map((n) => ({ input: `task-${n}` })))});
	return { count: results.length };
}`;

		const { payload } = await executeWorkflow(cwd, tool, { script });

		expect(payload.status).toBe("ok");
		expect(payload.result).toEqual({ count: 6 });
		expect(stub.callCount()).toBe(6);
		expect(stub.maxInFlight()).toBeLessThanOrEqual(2);
	});

	it("rejects a resume while the run is still live in this session", async () => {
		const cwd = makeTempDir();
		const workflowDir = join(cwd, ".pi", "muse-workflows");
		mkdirSync(workflowDir, { recursive: true });
		writeFileSync(
			join(workflowDir, "live-run.mjs"),
			`export default async function workflow(host) {
	const first = await host.agent({ input: "slow" });
	return { status: "ok", ref: first.ref };
}`,
		);
		const stub = createStubRunner({ delayMs: 200 });
		const tool = createWorkflowToolDefinition(cwd, { childRunner: stub.runner });

		const running = executeWorkflow(cwd, tool, { resumeFromRunId: "live-run" });
		await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 100));
		const blocked = await executeWorkflow(cwd, tool, { resumeFromRunId: "live-run" });

		expect(blocked.payload.status).toBe("error");
		expect((blocked.payload.error as { code: string }).code).toBe("run_in_progress");

		const finished = await running;
		expect(finished.payload.status).toBe("ok");
	});

	it("times out a runaway script instead of hanging the session", async () => {
		const cwd = makeTempDir();
		const stub = createStubRunner();
		const tool = createWorkflowToolDefinition(cwd, { childRunner: stub.runner, runTimeoutMs: 250 });

		const { payload } = await executeWorkflow(cwd, tool, {
			script: "export default async function workflow() { await new Promise(() => {}); }",
		});

		expect(payload.status).toBe("error");
		expect((payload.error as { code: string }).code).toBe("run_timeout");
	});
});

describe("workflow resume", () => {
	it("re-runs the persisted script of a run and replays the journaled call prefix", async () => {
		const cwd = makeTempDir();
		const stub = createStubRunner();
		const tool = createWorkflowToolDefinition(cwd, { childRunner: stub.runner });
		const script = `export default async function workflow(host) {
	const first = await host.agent({ input: "one" });
	const second = await host.agent({ input: "two" });
	return { status: "ok", refs: [first.ref, second.ref] };
}`;

		const first = await executeWorkflow(cwd, tool, { script });
		const runId = first.payload.runId as string;
		const scriptPath = join(cwd, ".pi", "muse-workflows", `${runId}.mjs`);
		expect(stub.callCount()).toBe(2);

		const resumed = await executeWorkflow(cwd, tool, { scriptPath, resumeFromRunId: runId });

		expect(resumed.payload.status).toBe("ok");
		expect(resumed.payload.runId).toBe(runId);
		expect(resumed.payload.scriptHash).toBe(first.payload.scriptHash);
		expect(resumed.payload.result).toEqual(first.payload.result);
		expect(stub.callCount()).toBe(2);
		expect(readFileSync(scriptPath, "utf-8")).toBe(script);
	});

	it("drops the journal and runs live calls once the persisted bytes change", async () => {
		const cwd = makeTempDir();
		const stub = createStubRunner();
		const tool = createWorkflowToolDefinition(cwd, { childRunner: stub.runner });
		const script = `export default async function workflow(host) {
	const first = await host.agent({ input: "one" });
	return { status: "ok", ref: first.ref };
}`;

		const first = await executeWorkflow(cwd, tool, { script });
		const runId = first.payload.runId as string;
		const scriptPath = join(cwd, ".pi", "muse-workflows", `${runId}.mjs`);
		expect(stub.callCount()).toBe(1);

		writeFileSync(scriptPath, script.replace('"one"', '"one-edited"'));
		const resumed = await executeWorkflow(cwd, tool, { scriptPath, resumeFromRunId: runId });

		expect(resumed.payload.status).toBe("ok");
		expect(resumed.payload.runId).toBe(runId);
		expect(resumed.payload.scriptHash).not.toBe(first.payload.scriptHash);
		expect(stub.callCount()).toBe(2);
		expect(stub.calls[1]?.request.input).toBe("one-edited");
	});

	it("resumes from the on-disk script and journal after the session's in-memory state is gone", async () => {
		const cwd = makeTempDir();
		const script = `export default async function workflow(host) {
	const first = await host.agent({ input: "persisted" });
	return { status: "ok", ref: first.ref };
}`;
		const firstStub = createStubRunner();
		const firstTool = createWorkflowToolDefinition(cwd, { childRunner: firstStub.runner });
		const first = await executeWorkflow(cwd, firstTool, { script });
		const runId = first.payload.runId as string;
		expect(firstStub.callCount()).toBe(1);

		vi.resetModules();
		const freshModule = await import("../src/core/tools/muse-workflow.ts");
		const secondStub = createStubRunner();
		const secondTool = freshModule.createWorkflowToolDefinition(cwd, {
			childRunner: secondStub.runner,
		}) as unknown as WorkflowTool;
		const persisted = await executeWorkflow(cwd, secondTool, { resumeFromRunId: runId });

		expect(persisted.payload.status).toBe("ok");
		expect(persisted.payload.runId).toBe(runId);
		expect(persisted.payload.scriptHash).toBe(first.payload.scriptHash);
		expect(persisted.payload.result).toEqual(first.payload.result);
		expect(secondStub.callCount()).toBe(0);

		const unknown = await executeWorkflow(cwd, secondTool, { resumeFromRunId: "missing-run-id" });
		expect(unknown.payload.status).toBe("error");
		expect((unknown.payload.error as { code: string }).code).toBe("run_not_found");
	});

	it("persists a journal file next to the run for recovery", async () => {
		const cwd = makeTempDir();
		const stub = createStubRunner();
		const tool = createWorkflowToolDefinition(cwd, { childRunner: stub.runner });
		const script = `export default async function workflow(host) {
	const first = await host.agent({ input: "journaled" });
	return { status: "ok", ref: first.ref };
}`;

		const { payload } = await executeWorkflow(cwd, tool, { script });
		const runId = payload.runId as string;
		const journalEntries = readdirSync(join(cwd, ".pi", "muse-workflows")).filter((name) =>
			name.endsWith(".journal.json"),
		);
		expect(journalEntries).toEqual([`${runId}.journal.json`]);
		const journal = JSON.parse(
			readFileSync(join(cwd, ".pi", "muse-workflows", `${runId}.journal.json`), "utf-8"),
		) as { scriptHash: string; entries: Array<{ hash: string } | null> };
		expect(journal.scriptHash).toBe(payload.scriptHash);
		expect(journal.entries).toHaveLength(1);
		expect(typeof journal.entries[0]?.hash).toBe("string");
	});
});

describe("workflow saved registry lookup", () => {
	it("runs a saved workflow resolved by name from a registry directory", async () => {
		const cwd = makeTempDir();
		const registryDir = makeTempDir();
		writeFileSync(
			join(registryDir, "review-change.mjs"),
			`export default async function workflow(host) {
	const result = await host.agent({ input: "named" });
	return { status: "ok", ref: result.ref };
}`,
		);
		const stub = createStubRunner();
		const tool = createWorkflowToolDefinition(cwd, { childRunner: stub.runner, workflowRegistryDirs: [registryDir] });

		const { payload } = await executeWorkflow(cwd, tool, { name: "review-change" });

		expect(payload.status).toBe("ok");
		expect(payload.name).toBe("review-change");
		expect(payload.result).toEqual({ status: "ok", ref: "stub:0" });
		expect(stub.calls[0]?.request.input).toBe("named");
	});

	it("fails an unknown name with the discovered workflow names", async () => {
		const cwd = makeTempDir();
		const registryDir = makeTempDir();
		writeFileSync(join(registryDir, "alpha.mjs"), SIMPLE_SCRIPT);
		writeFileSync(join(registryDir, "beta.js"), SIMPLE_SCRIPT);
		const tool = createWorkflowToolDefinition(cwd, {
			childRunner: createStubRunner().runner,
			workflowRegistryDirs: [registryDir],
		});

		const { payload } = await executeWorkflow(cwd, tool, { name: "missing" });

		expect(payload.status).toBe("error");
		expect((payload.error as { code: string }).code).toBe("workflow_not_found");
		const message = (payload.error as { message: string }).message;
		expect(message).toContain("alpha");
		expect(message).toContain("beta");
	});

	it("prefers an earlier registry directory when the same name appears twice", async () => {
		const cwd = makeTempDir();
		const firstDir = makeTempDir();
		const secondDir = makeTempDir();
		writeFileSync(
			join(firstDir, "dup.mjs"),
			`export default async function workflow(host) {
	const result = await host.agent({ input: "first" });
	return { status: "ok", ref: result.ref };
}`,
		);
		writeFileSync(
			join(secondDir, "dup.mjs"),
			`export default async function workflow(host) {
	const result = await host.agent({ input: "second" });
	return { status: "ok", ref: result.ref };
}`,
		);
		const stub = createStubRunner();
		const tool = createWorkflowToolDefinition(cwd, {
			childRunner: stub.runner,
			workflowRegistryDirs: [firstDir, secondDir],
		});

		await executeWorkflow(cwd, tool, { name: "dup" });

		expect(stub.calls[0]?.request.input).toBe("first");
	});
});

describe("workflow inline schema validation", () => {
	it("accepts the closed type/enum/required/properties/items subset", () => {
		expect(validateWorkflowInlineSchema({ type: "string" }).ok).toBe(true);
		expect(
			validateWorkflowInlineSchema({
				type: "object",
				required: ["complete"],
				properties: { complete: { type: "boolean" }, tags: { type: "array", items: { type: "string" } } },
			}).ok,
		).toBe(true);
		expect(validateWorkflowInlineSchema({ enum: ["a", "b", null] }).ok).toBe(true);
	});

	it("rejects unsupported keywords, invalid types, and out-of-bounds shapes", () => {
		expect(validateWorkflowInlineSchema({ type: "string", minLength: 1 }).ok).toBe(false);
		expect(validateWorkflowInlineSchema({ type: "object", additionalProperties: false }).ok).toBe(false);
		expect(validateWorkflowInlineSchema({ type: "widget" }).ok).toBe(false);
		expect(validateWorkflowInlineSchema({ type: "object", properties: {} }).ok).toBe(true);
		expect(validateWorkflowInlineSchema({ type: "string", enum: new Array(17).fill("x") }).ok).toBe(false);
		expect(validateWorkflowInlineSchema({ type: "string", enum: ["x".repeat(6000)] }).ok).toBe(false);
		let nested: Record<string, unknown> = { type: "string" };
		for (let depth = 0; depth < 18; depth += 1) {
			nested = { type: "array", items: nested };
		}
		expect(validateWorkflowInlineSchema(nested).ok).toBe(false);
	});

	it("rejects a malformed inline schema before launching any child", async () => {
		const cwd = makeTempDir();
		const stub = createStubRunner();
		const tool = createWorkflowToolDefinition(cwd, { childRunner: stub.runner });
		const script = `export default async function workflow(host) {
	const result = await host.agent({ input: "x", schema: { type: "object", bogus: true } });
	return result;
}`;

		const { payload } = await executeWorkflow(cwd, tool, { script });

		expect(stub.callCount()).toBe(0);
		expect((payload.result as { error_kind: string }).error_kind).toBe("invalid_schema");
	});

	it("resolves null when an admitted child result violates the inline schema", async () => {
		const cwd = makeTempDir();
		const stub = createStubRunner({ onCall: () => ({ data: { complete: "yes" } }) });
		const tool = createWorkflowToolDefinition(cwd, { childRunner: stub.runner });
		const script = `export default async function workflow(host) {
	const result = await host.agent({
		input: "x",
		schema: { type: "object", required: ["complete"], properties: { complete: { type: "boolean" } } },
	});
	return { isNull: result === null };
}`;

		const { payload } = await executeWorkflow(cwd, tool, { script });

		expect(stub.callCount()).toBe(1);
		expect(payload.result).toEqual({ isNull: true });
	});

	it("passes a child result that satisfies the inline schema", async () => {
		const cwd = makeTempDir();
		const stub = createStubRunner({ onCall: () => ({ data: { complete: true } }) });
		const tool = createWorkflowToolDefinition(cwd, { childRunner: stub.runner });
		const script = `export default async function workflow(host) {
	const result = await host.agent({
		input: "x",
		schema: { type: "object", required: ["complete"], properties: { complete: { type: "boolean" } } },
	});
	return { isNull: result === null, data: result && result.data, errorKind: result && result.error_kind };
}`;

		const { payload } = await executeWorkflow(cwd, tool, { script });

		expect(payload.result).toEqual({ isNull: false, data: { complete: true }, errorKind: null });
	});
});

describe("workflow phase grouping", () => {
	it("groups logs and per-call phases without racing the global phase state", async () => {
		const cwd = makeTempDir();
		const stub = createStubRunner();
		const tool = createWorkflowToolDefinition(cwd, { childRunner: stub.runner });
		const script = `export default async function workflow(host) {
	host.phase("Alpha");
	host.log("a-log");
	await host.agent({ input: "in-alpha", phase: "Alpha" });
	host.phase("Beta");
	host.log("b-log");
	await host.agent({ input: "in-beta", phase: "Beta" });
	return { status: "ok" };
}`;

		const { payload, details } = await executeWorkflow(cwd, tool, { script });

		expect(payload.status).toBe("ok");
		expect(details.phases).toEqual(["Alpha", "Beta"]);
		expect(details.phaseGroups).toEqual([
			{ title: "Alpha", logs: ["a-log"], agentCalls: 1 },
			{ title: "Beta", logs: ["b-log"], agentCalls: 1 },
		]);
	});

	it("merges repeated phase titles into the same group", async () => {
		const cwd = makeTempDir();
		const stub = createStubRunner();
		const tool = createWorkflowToolDefinition(cwd, { childRunner: stub.runner });
		const script = `export default async function workflow(host) {
	host.phase("Shared");
	host.log("one");
	await host.agent({ input: "s1", phase: "Shared" });
	host.phase("Other");
	host.phase("Shared");
	host.log("two");
	return { status: "ok" };
}`;

		const { details } = await executeWorkflow(cwd, tool, { script });

		const shared = details.phaseGroups.find((group) => group.title === "Shared");
		const other = details.phaseGroups.find((group) => group.title === "Other");
		expect(shared).toEqual({ title: "Shared", logs: ["one", "two"], agentCalls: 1 });
		expect(other).toEqual({ title: "Other", logs: [], agentCalls: 0 });
	});

	it("emits the grouped structure in progress updates", async () => {
		const cwd = makeTempDir();
		const stub = createStubRunner();
		const tool = createWorkflowToolDefinition(cwd, { childRunner: stub.runner });
		const updates: Array<{ phaseGroups: WorkflowPhaseGroup[] }> = [];
		const script = `export default async function workflow(host) {
	host.phase("Solo");
	host.log("mark");
	return { status: "ok" };
}`;

		await tool.execute(
			"workflow-call",
			{ script },
			undefined,
			(update) => {
				updates.push(update.details as { phaseGroups: WorkflowPhaseGroup[] });
			},
			ctx(cwd),
		);

		expect(updates.length).toBeGreaterThan(0);
		expect(updates.at(-1)?.phaseGroups).toEqual([{ title: "Solo", logs: ["mark"], agentCalls: 0 }]);
	});
});

describe("workflow isolation", () => {
	it("classifies isolation request shapes per the V1 contract", () => {
		expect(resolveWorkflowIsolationShape(true)).toEqual({ ok: true, enabled: true });
		expect(resolveWorkflowIsolationShape("TRUE")).toEqual({ ok: true, enabled: true });
		expect(resolveWorkflowIsolationShape({})).toEqual({ ok: true, enabled: true });
		expect(resolveWorkflowIsolationShape(false)).toEqual({ ok: true, enabled: false });
		expect(resolveWorkflowIsolationShape("False")).toEqual({ ok: true, enabled: false });
		expect(resolveWorkflowIsolationShape(null)).toEqual({ ok: true, enabled: false });
		expect(resolveWorkflowIsolationShape(undefined)).toEqual({ ok: true, enabled: false });
		expect(resolveWorkflowIsolationShape([]).ok).toBe(false);
		expect(resolveWorkflowIsolationShape(3).ok).toBe(false);
		expect(resolveWorkflowIsolationShape("maybe").ok).toBe(false);
	});

	it("runs an isolated child in a worktree and removes a clean worktree", async () => {
		const cwd = makeTempDir();
		initGitRepo(cwd);
		const worktreeRoot = makeTempDir();
		const seen: { path: string | null } = { path: null };
		const stub = createStubRunner({
			onCall: (_request, context) => {
				seen.path = context.isolation?.worktreePath ?? null;
				return { data: null };
			},
		});
		const tool = createWorkflowToolDefinition(cwd, { childRunner: stub.runner, worktreeRoot });
		const script = `export default async function workflow(host) {
	const result = await host.agent({ input: "iso", isolation: true });
	return { isolation: result.isolation };
}`;

		const { payload } = await executeWorkflow(cwd, tool, { script });

		const outcome = (payload.result as { isolation: { worktree_path: string; retained: boolean } }).isolation;
		expect(seen.path).not.toBeNull();
		expect(outcome.worktree_path).toBe(seen.path);
		expect(outcome.retained).toBe(false);
		expect(existsSync(seen.path ?? "")).toBe(false);
	});

	it("retains a worktree whose child left non-ignored changes", async () => {
		const cwd = makeTempDir();
		initGitRepo(cwd);
		const worktreeRoot = makeTempDir();
		const seen: { path: string | null } = { path: null };
		const stub = createStubRunner({
			onCall: (_request, context) => {
				seen.path = context.isolation?.worktreePath ?? null;
				if (seen.path) writeFileSync(join(seen.path, "child-output.txt"), "artifact");
				return { data: null };
			},
		});
		const tool = createWorkflowToolDefinition(cwd, { childRunner: stub.runner, worktreeRoot });
		const script = `export default async function workflow(host) {
	const result = await host.agent({ input: "iso", isolation: true });
	return { isolation: result.isolation };
}`;

		const { payload } = await executeWorkflow(cwd, tool, { script });

		const outcome = (payload.result as { isolation: { worktree_path: string; retained: boolean } }).isolation;
		expect(outcome.retained).toBe(true);
		expect(seen.path).not.toBeNull();
		expect(existsSync(join(seen.path ?? "", "child-output.txt"))).toBe(true);
	});

	it("rejects an invalid isolation shape before launching a child", async () => {
		const cwd = makeTempDir();
		const stub = createStubRunner();
		const tool = createWorkflowToolDefinition(cwd, { childRunner: stub.runner });
		const script = `export default async function workflow(host) {
	const result = await host.agent({ input: "x", isolation: 5 });
	return result;
}`;

		const { payload } = await executeWorkflow(cwd, tool, { script });

		expect(stub.callCount()).toBe(0);
		expect((payload.result as { error_kind: string }).error_kind).toBe("invalid_isolation");
	});

	it("reports isolation_unavailable when the workspace is not a git repository", async () => {
		const cwd = makeTempDir();
		const worktreeRoot = makeTempDir();
		const stub = createStubRunner();
		const tool = createWorkflowToolDefinition(cwd, { childRunner: stub.runner, worktreeRoot });
		const script = `export default async function workflow(host) {
	const result = await host.agent({ input: "x", isolation: true });
	return result;
}`;

		const { payload } = await executeWorkflow(cwd, tool, { script });

		expect(stub.callCount()).toBe(0);
		expect((payload.result as { error_kind: string }).error_kind).toBe("isolation_unavailable");
	});
});

describe("workflow model and effort overrides", () => {
	it("forwards per-call model and effort to the child runner", async () => {
		const cwd = makeTempDir();
		const stub = createStubRunner();
		const tool = createWorkflowToolDefinition(cwd, { childRunner: stub.runner });
		const script = `export default async function workflow(host) {
	await host.agent({ input: "m", model: "openai/gpt-4o", effort: "high" });
	return { status: "ok" };
}`;

		await executeWorkflow(cwd, tool, { script });

		expect(stub.calls[0]?.request.model).toBe("openai/gpt-4o");
		expect(stub.calls[0]?.request.effort).toBe("high");
	});

	it("maps effort values to thinking levels", () => {
		expect(normalizeWorkflowEffort("HIGH")).toBe("high");
		expect(normalizeWorkflowEffort("off")).toBe("off");
		expect(normalizeWorkflowEffort("bogus")).toBeUndefined();
		expect(normalizeWorkflowEffort(null)).toBeUndefined();
	});

	it("resolves a model override by id and inherits the parent route by default", () => {
		const model = { id: "gpt-4o", provider: "openai" } as unknown as Model<Api>;
		const parent = {
			thinkingLevel: "medium" as ThinkingLevel,
			findModel: (modelId: string) => (modelId === "gpt-4o" ? model : undefined),
		};

		expect(resolveChildLaunchOptions({ model: "gpt-4o", effort: "low" }, parent)).toEqual({
			ok: true,
			model,
			thinkingLevel: "low",
		});
		expect(resolveChildLaunchOptions({ model: null, effort: null }, parent)).toEqual({
			ok: true,
			model: undefined,
			thinkingLevel: "medium",
		});

		const missing = resolveChildLaunchOptions({ model: "unknown-model", effort: null }, parent);
		expect(missing.ok).toBe(false);
		if (!missing.ok) expect(missing.error_kind).toBe("model_not_found");
	});
});

describe("workflow in-process pi-subagents runner", () => {
	it("prefers the published runner and forwards agentType, model, effort, and isolation", async () => {
		const cwd = makeTempDir();
		const installed = installInProcessRunner();
		const tool = createWorkflowToolDefinition(cwd, {});
		const script = `export default async function workflow(host) {
	const result = await host.agent({
		input: "review",
		agentType: "Explore",
		model: "anthropic/claude-haiku-4-5",
		effort: "high",
		isolation: true,
	});
	return { text: result.text, usage: result.usage };
}`;

		const { payload } = await executeWorkflow(cwd, tool, { script });

		expect(payload.status).toBe("ok");
		expect(installed.calls).toHaveLength(1);
		expect(installed.calls[0]).toMatchObject({
			type: "Explore",
			prompt: "review",
			model: "anthropic/claude-haiku-4-5",
			effort: "high",
			isolation: true,
			cwd,
		});
		expect(payload.result).toEqual({ text: "child:Explore", usage: { totalTokens: 42 } });
	});

	it("defaults the agent type to general-purpose and maps a falsy isolation request", async () => {
		const cwd = makeTempDir();
		const installed = installInProcessRunner();
		const tool = createWorkflowToolDefinition(cwd, {});
		const script = `export default async function workflow(host) {
	await host.agent({ input: "plain" });
	return { status: "ok" };
}`;

		await executeWorkflow(cwd, tool, { script });

		expect(installed.calls[0]?.type).toBe("general-purpose");
		expect(installed.calls[0]?.isolation).toBe(false);
	});

	it("clamps child concurrency to the in-process runner's limit", async () => {
		const cwd = makeTempDir();
		const installed = installInProcessRunner({
			maxConcurrent: 2,
			onRun: async () => {
				await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 25));
				return { status: "completed", text: "ok", error_kind: null };
			},
		});
		const tool = createWorkflowToolDefinition(cwd, {});
		const script = `export default async function workflow(host) {
	const results = await host.parallel(${JSON.stringify([1, 2, 3, 4, 5, 6].map((n) => ({ input: `task-${n}` })))});
	return { count: results.length };
}`;

		const { payload } = await executeWorkflow(cwd, tool, { script });

		expect(payload.result).toEqual({ count: 6 });
		expect(installed.calls).toHaveLength(6);
		expect(installed.maxInFlight()).toBeLessThanOrEqual(2);
	});

	it("falls back to the SDK runner when no in-process runner is published", async () => {
		const cwd = makeTempDir();
		expect(readInProcessChildRunner()).toBeUndefined();
		const session = {
			prompt: vi.fn(async () => {}),
			getLastAssistantText: () => "sdk reply",
			dispose: vi.fn(),
		};
		sdkMocks.createAgentSession.mockResolvedValue({ session });
		const tool = createWorkflowToolDefinition(cwd, {});
		const script = `export default async function workflow(host) {
	const result = await host.agent({ input: "sdk" });
	return { text: result.text };
}`;

		const { payload } = await executeWorkflow(cwd, tool, { script });

		expect(sdkMocks.createAgentSession).toHaveBeenCalledTimes(1);
		expect(session.prompt).toHaveBeenCalledWith("sdk", { expandPromptTemplates: false });
		expect(session.dispose).toHaveBeenCalledTimes(1);
		expect(payload.result).toEqual({ text: "sdk reply" });
	});
});
