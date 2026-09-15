import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import {
	createWorkflowToolDefinition,
	type WorkflowChildRequest,
	type WorkflowChildResult,
	type WorkflowChildRunner,
	type WorkflowChildRunnerContext,
} from "../src/core/tools/muse-workflow.ts";

const tempDirs: string[] = [];

function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-muse-workflow-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
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
		const official = JSON.parse(readFileSync("/tmp/opencode/ref/schemas.json", "utf-8")) as {
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

	it("rejects a call without a script source and reports name-only lookup as not implemented", async () => {
		const cwd = makeTempDir();
		const stub = createStubRunner();
		const tool = createWorkflowToolDefinition(cwd, { childRunner: stub.runner });

		const empty = await executeWorkflow(cwd, tool, {});
		expect((empty.payload.error as { code: string }).code).toBe("invalid_input");

		const byName = await executeWorkflow(cwd, tool, { name: "generated.review-change" });
		expect((byName.payload.error as { code: string }).code).toBe("not_implemented");
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
