import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import type { AgentToolResult, ExtensionAPI } from "../core/extensions/types.ts";

/**
 * Recursive self-improvement driver for pi-muse.
 *
 * The companion `scripts/harness-rsi.mjs` driver measures pi-muse against the
 * real Muse Code CLI through the parity harness, has pi-muse patch its own
 * source, and repeats until it explicitly declares parity or blockage. This
 * extension exposes that loop to the model (`harness_rsi`) and to a human
 * (`/harness-rsi`).
 *
 * Contract assumed for the driver (owned by a parallel agent):
 *   node scripts/harness-rsi.mjs [--max-iterations <n>] [--fixture <name>] [--dry-run] [--json]
 *   - writes `HARNESS_RSI_DECLARATION.json` at the repository root;
 *   - prints `HARNESS_RSI: COMPLETE` or `HARNESS_RSI: BLOCKED`;
 *   - exit codes: 0 complete, 2 blocked, 1 internal error (a declaration is still written).
 *
 * The declaration file, not the exit code, is the source of truth: a driver can
 * exit 0 while still declaring blockage, so the result is always read back from
 * disk.
 */

/** Tool names registered by this extension, so the orchestrator can splice them into the allowlist. */
export const MUSE_RSI_TOOL_NAMES = ["harness_rsi"] as const;

export type MuseRsiToolName = (typeof MUSE_RSI_TOOL_NAMES)[number];

/** Driver script path relative to the pi-muse repository root. */
export const MUSE_RSI_DRIVER_SCRIPT = "scripts/harness-rsi.mjs";

/** Declaration written by the driver at the repository root. */
export const MUSE_RSI_DECLARATION_FILE = "HARNESS_RSI_DECLARATION.json";

/**
 * Env var the driver sets for its child pi-muse. When present, this extension
 * refuses to run so a child can never start a nested RSI loop.
 */
export const MUSE_RSI_CHILD_ENV = "HARNESS_RSI_CHILD";

/** Slash command a human uses to start the same loop. */
export const MUSE_RSI_COMMAND_NAME = "harness-rsi";

/** Cap on captured driver output kept in the tool result and streamed to the model. */
const OUTPUT_LIMIT = 16_000;

/** How far up the directory tree the repo-root search walks before giving up. */
const REPO_ROOT_SEARCH_DEPTH = 16;

export type HarnessRsiStatus = "complete" | "blocked";

/** Normalized declaration read back from `HARNESS_RSI_DECLARATION.json`. */
export interface HarnessRsiDeclaration {
	status: HarnessRsiStatus;
	iterations: number;
	remaining_gaps: string[];
	/** Driver's short cause for a blockage, e.g. "dry-run", "iteration-cap", "internal-error". */
	reason?: string;
	/** Driver-side internal error message, when it wrote one into the declaration. */
	driver_error?: string;
}

/** Parameters accepted by `harness_rsi`, mirrored by the tool schema. */
export interface HarnessRsiRunParams {
	max_iterations?: number;
	fixture?: string;
	dry_run?: boolean;
}

/**
 * Tool/command result. `error` is a stable code, `message` the actionable text.
 * When `status` is set the declaration was read successfully and is truthful.
 */
export interface HarnessRsiDetails {
	status: HarnessRsiStatus | null;
	iterations: number | null;
	remaining_gaps: string[];
	declaration_path: string;
	exit_code: number | null;
	exit_signal: string | null;
	output: string;
	reason?: string;
	driver_error?: string;
	error?: string;
	message?: string;
}

/** Child process surface used by the spawn adapter; narrow on purpose so tests can stub it. */
export interface HarnessRsiChild {
	readonly stdout: NodeJS.ReadableStream | null;
	readonly stderr: NodeJS.ReadableStream | null;
	once(event: "error", listener: (error: Error) => void): void;
	once(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
	kill(signal?: NodeJS.Signals): boolean;
}

export interface HarnessRsiSpawnOptions {
	cwd: string;
	env: NodeJS.ProcessEnv;
}

/** Injectable spawn so tests never launch a real driver. */
export type HarnessRsiSpawn = (executable: string, args: string[], options: HarnessRsiSpawnOptions) => HarnessRsiChild;

export interface MuseRsiExecuteHooks {
	/** Override the process spawn (tests). */
	spawn?: HarnessRsiSpawn;
	/** Explicit repository root, bypassing driver discovery (tests). */
	repoRoot?: string;
	/** Session working directory used when discovering the repository root. */
	cwd?: string;
	/** Aborts the driver. */
	signal?: AbortSignal;
	/** Called with the accumulated output as it grows. */
	onProgress?: (output: string) => void;
}

export interface MuseRsiExtensionOptions extends MuseRsiExecuteHooks {}

const defaultSpawn: HarnessRsiSpawn = (executable, args, options) =>
	spawn(executable, args, { cwd: options.cwd, env: options.env });

const harnessRsiSchema = Type.Unsafe({
	type: "object",
	additionalProperties: false,
	properties: {
		max_iterations: {
			type: "integer",
			minimum: 1,
			maximum: 64,
			description: "Maximum number of fix-and-measure cycles before the driver gives up. Accepts 1 through 64.",
		},
		fixture: {
			type: "string",
			description: "Named parity fixture to measure against; omit to let the driver pick its default set.",
		},
		dry_run: {
			type: "boolean",
			description: "true measures and reports gaps without letting pi-muse edit its own source.",
		},
	},
});

const ALLOWED_PARAMS: ReadonlySet<string> = new Set(["max_iterations", "fixture", "dry_run"]);

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function emptyDetails(): HarnessRsiDetails {
	return {
		status: null,
		iterations: null,
		remaining_gaps: [],
		declaration_path: "",
		exit_code: null,
		exit_signal: null,
		output: "",
	};
}

/**
 * Validate raw tool/command input against the schema range. The framework
 * validates LLM calls, but commands and direct callers need the same checks.
 */
export function validateHarnessRsiParams(
	input: Record<string, unknown>,
): { params: HarnessRsiRunParams } | { error: string } {
	for (const key of Object.keys(input)) {
		if (!ALLOWED_PARAMS.has(key)) return { error: `unknown parameter ${JSON.stringify(key)}` };
	}
	const params: HarnessRsiRunParams = {};

	const rawMax = input.max_iterations;
	if (rawMax !== undefined && rawMax !== null) {
		if (typeof rawMax !== "number" || !Number.isInteger(rawMax) || rawMax < 1 || rawMax > 64) {
			return { error: "max_iterations must be an integer from 1 to 64" };
		}
		params.max_iterations = rawMax;
	}

	const rawFixture = input.fixture;
	if (rawFixture !== undefined && rawFixture !== null) {
		if (typeof rawFixture !== "string" || rawFixture.trim().length === 0) {
			return { error: "fixture must be a non-empty string" };
		}
		params.fixture = rawFixture;
	}

	const rawDryRun = input.dry_run;
	if (rawDryRun !== undefined && rawDryRun !== null) {
		if (typeof rawDryRun !== "boolean") return { error: "dry_run must be a boolean" };
		params.dry_run = rawDryRun;
	}

	return { params };
}

/** Build the driver argv (script first) from validated parameters. */
export function buildHarnessRsiDriverArgs(params: HarnessRsiRunParams): string[] {
	const args = [MUSE_RSI_DRIVER_SCRIPT];
	if (params.max_iterations !== undefined) args.push("--max-iterations", String(params.max_iterations));
	if (params.fixture !== undefined) args.push("--fixture", params.fixture);
	if (params.dry_run) args.push("--dry-run");
	return args;
}

function readText(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function readStatus(value: unknown): HarnessRsiStatus | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim().toLowerCase();
	if (normalized === "complete" || normalized === "completed" || normalized === "parity") return "complete";
	if (normalized === "blocked" || normalized === "block") return "blocked";
	return undefined;
}

function readIterations(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/**
 * Render one gap entry. The driver writes structured gap objects
 * (`{ category, pairLabel, id, left, right, detail }`) and its own console
 * report uses this exact readable form, so the model sees the same text.
 */
function formatGapEntry(entry: unknown): string {
	if (typeof entry === "string") return entry;
	if (isRecord(entry)) {
		const category = readText(entry.category);
		const left = readText(entry.left);
		const right = readText(entry.right);
		if (category !== undefined && (left !== undefined || right !== undefined)) {
			const label = readText(entry.pairLabel);
			const where = label ? `${label} ` : "";
			const id = readText(entry.id) ?? readText(entry.name) ?? "?";
			const detail = readText(entry.detail);
			const compare = `muse=${left ?? "?"} | pi-muse=${right ?? "?"}`;
			return `[${category}] ${where}${id}: ${compare}${detail ? `  (${detail})` : ""}`;
		}
	}
	return JSON.stringify(entry);
}

function readGaps(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const gaps: string[] = [];
	for (const entry of value) {
		const text = formatGapEntry(entry);
		if (text !== undefined && text.length > 0) gaps.push(text);
	}
	return gaps;
}

/**
 * Normalize a parsed declaration. Accepts the canonical
 * `{ status, iterations, remaining_gaps }` plus a few common aliases so a
 * driver-side rename does not silently look like a missing declaration.
 */
export function parseHarnessRsiDeclaration(value: unknown): HarnessRsiDeclaration | undefined {
	if (!isRecord(value)) return undefined;
	const status = readStatus(value.status ?? value.declaration ?? value.result);
	if (status === undefined) return undefined;
	const iterations = readIterations(value.iterations ?? value.iteration_count ?? value.iterations_completed) ?? 0;
	const declaration: HarnessRsiDeclaration = {
		status,
		iterations,
		remaining_gaps: readGaps(value.remaining_gaps ?? value.remainingGaps ?? value.gaps),
	};
	const reason = readText(value.reason);
	if (reason !== undefined) declaration.reason = reason;
	const driverError = readText(value.error);
	if (driverError !== undefined) declaration.driver_error = driverError;
	return declaration;
}

/** Walk up from `start` looking for the directory that contains the driver script. */
function findRepoRoot(start: string): string | undefined {
	let dir = resolve(start);
	for (let depth = 0; depth < REPO_ROOT_SEARCH_DEPTH; depth += 1) {
		if (existsSync(join(dir, MUSE_RSI_DRIVER_SCRIPT))) return dir;
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
	return undefined;
}

/**
 * Prefer an explicit root, then the running pi-muse source tree (this file
 * lives in the repo), then the session/process working directories.
 */
function resolveRepoRoot(explicit: string | undefined, contexts: readonly (string | undefined)[]): string | undefined {
	if (explicit) return explicit;
	const candidates: string[] = [dirname(fileURLToPath(import.meta.url))];
	for (const context of contexts) {
		if (context) candidates.push(context);
	}
	for (const candidate of candidates) {
		const found = findRepoRoot(candidate);
		if (found) return found;
	}
	return undefined;
}

interface HarnessRsiChildOutcome {
	exit_code: number | null;
	signal: string | null;
	output: string;
	error?: string;
}

function appendChunk(current: string, chunk: unknown): string {
	const text = typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
	if (current.length >= OUTPUT_LIMIT) return current;
	return (current + text).slice(0, OUTPUT_LIMIT);
}

/** Run the driver to completion, collecting and optionally streaming its output. */
function runDriverChild(
	spawnFn: HarnessRsiSpawn,
	args: string[],
	repoRoot: string,
	signal: AbortSignal | undefined,
	onProgress: ((output: string) => void) | undefined,
): Promise<HarnessRsiChildOutcome> {
	return new Promise((resolvePromise) => {
		let child: HarnessRsiChild;
		try {
			child = spawnFn(process.execPath, args, { cwd: repoRoot, env: { ...process.env } });
		} catch (error) {
			resolvePromise({ exit_code: null, signal: null, output: "", error: errorMessage(error) });
			return;
		}

		let output = "";
		let settled = false;
		const append = (chunk: unknown): void => {
			const next = appendChunk(output, chunk);
			if (next === output) return;
			output = next;
			onProgress?.(output);
		};
		child.stdout?.on("data", append);
		child.stderr?.on("data", append);

		const onAbort = (): void => {
			child.kill("SIGTERM");
		};
		if (signal) {
			if (signal.aborted) onAbort();
			else signal.addEventListener("abort", onAbort, { once: true });
		}

		const finish = (outcome: HarnessRsiChildOutcome): void => {
			if (settled) return;
			settled = true;
			signal?.removeEventListener("abort", onAbort);
			resolvePromise(outcome);
		};

		child.once("error", (error) => finish({ exit_code: null, signal: null, output, error: errorMessage(error) }));
		child.once("close", (code, closeSignal) =>
			finish({ exit_code: code, signal: closeSignal ? String(closeSignal) : null, output }),
		);
	});
}

type DeclarationReadResult = { declaration: HarnessRsiDeclaration } | { code: string; error: string };

/** Read the declaration file — the only trusted source of the loop's outcome. */
function readDeclaration(path: string): DeclarationReadResult {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		return { code: "declaration_missing", error: `declaration file not found at ${path}: ${errorMessage(error)}` };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		return {
			code: "declaration_invalid",
			error: `declaration file at ${path} is not valid JSON: ${errorMessage(error)}`,
		};
	}
	const declaration = parseHarnessRsiDeclaration(parsed);
	if (!declaration) {
		return { code: "declaration_invalid", error: `declaration file at ${path} has an unrecognized shape` };
	}
	return { declaration };
}

/**
 * Run the RSI driver and report the declaration's truth.
 *
 * Refuses inside an RSI child so the loop can never recurse, and refuses when
 * the repository root (and therefore the driver) cannot be found.
 */
export async function executeHarnessRsi(
	params: HarnessRsiRunParams,
	hooks: MuseRsiExecuteHooks = {},
): Promise<HarnessRsiDetails> {
	const repoRoot = resolveRepoRoot(hooks.repoRoot, [hooks.cwd, process.cwd()]);
	const declarationPath = repoRoot ? join(repoRoot, MUSE_RSI_DECLARATION_FILE) : MUSE_RSI_DECLARATION_FILE;
	const base: HarnessRsiDetails = { ...emptyDetails(), declaration_path: declarationPath };

	if (process.env[MUSE_RSI_CHILD_ENV]) {
		return {
			...base,
			error: "nested_rsi_disabled",
			message:
				`nested RSI is disabled: ${MUSE_RSI_CHILD_ENV} is set, so this pi-muse is a child of the harness RSI driver. ` +
				"Start the loop from a top-level pi-muse session instead.",
		};
	}
	if (!repoRoot) {
		return {
			...base,
			error: "driver_not_found",
			message:
				`could not find ${MUSE_RSI_DRIVER_SCRIPT} in any parent directory of ${process.cwd()}; ` +
				"run pi-muse from the pi-muse repository so the RSI driver is discoverable.",
		};
	}

	const outcome = await runDriverChild(
		hooks.spawn ?? defaultSpawn,
		buildHarnessRsiDriverArgs(params),
		repoRoot,
		hooks.signal,
		hooks.onProgress,
	);

	const read = readDeclaration(declarationPath);
	if ("code" in read) {
		const withRun: HarnessRsiDetails = {
			...base,
			exit_code: outcome.exit_code,
			exit_signal: outcome.signal,
			output: outcome.output,
		};
		if (outcome.error) {
			return { ...withRun, error: "spawn_failed", message: outcome.error };
		}
		return { ...withRun, error: read.code, message: read.error };
	}

	const declaration = read.declaration;
	return {
		...base,
		status: declaration.status,
		iterations: declaration.iterations,
		remaining_gaps: declaration.remaining_gaps,
		exit_code: outcome.exit_code,
		exit_signal: outcome.signal,
		output: outcome.output,
		...(declaration.reason !== undefined ? { reason: declaration.reason } : {}),
		...(declaration.driver_error !== undefined ? { driver_error: declaration.driver_error } : {}),
	};
}

/** Human/LLM-facing summary of a run, used for both tool content and the command. */
export function formatHarnessRsiDetails(details: HarnessRsiDetails): string {
	if (details.error) {
		const exitNote = details.exit_code === null ? "" : ` (driver exit code ${details.exit_code})`;
		const declarationNote = details.declaration_path ? ` Declaration: ${details.declaration_path}.` : "";
		return `harness_rsi ${details.error}: ${details.message ?? "unknown error"}${exitNote}.${declarationNote}`;
	}
	if (details.status === "complete") {
		return `HARNESS_RSI: COMPLETE — pi-muse reached parity with Muse Code after ${details.iterations ?? 0} iteration(s). Declaration: ${details.declaration_path}`;
	}
	const gaps = details.remaining_gaps.length === 0 ? "none reported" : details.remaining_gaps.join("; ");
	const reason = details.reason ? ` (reason: ${details.reason})` : "";
	const driverError = details.driver_error ? ` Driver error: ${details.driver_error}.` : "";
	return `HARNESS_RSI: BLOCKED after ${details.iterations ?? 0} iteration(s)${reason}. Remaining gaps: ${gaps}.${driverError} Declaration: ${details.declaration_path}`;
}

function toToolResult(details: HarnessRsiDetails): AgentToolResult<HarnessRsiDetails> {
	return { content: [{ type: "text" as const, text: formatHarnessRsiDetails(details) }], details };
}

/** Parse `/harness-rsi` arguments into the same parameters as the tool. */
export function parseHarnessRsiCommandArgs(args: string): { params: HarnessRsiRunParams } | { error: string } {
	const tokens = args.trim().length > 0 ? args.trim().split(/\s+/) : [];
	const input: Record<string, unknown> = {};
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (token === "--dry-run") {
			input.dry_run = true;
			continue;
		}
		if (token === "--max-iterations" || token === "--fixture") {
			const value = tokens[index + 1];
			if (value === undefined) return { error: `${token} requires a value` };
			if (token === "--max-iterations") {
				const parsed = Number(value);
				if (!Number.isInteger(parsed)) return { error: "--max-iterations must be an integer" };
				input.max_iterations = parsed;
			} else {
				input.fixture = value;
			}
			index += 1;
			continue;
		}
		return { error: `unknown option ${JSON.stringify(token)}` };
	}
	return validateHarnessRsiParams(input);
}

export default function museRsiExtension(pi: ExtensionAPI, options: MuseRsiExtensionOptions = {}): void {
	let sessionCwd: string | undefined;
	const hooks = (signal: AbortSignal | undefined, onProgress?: (output: string) => void): MuseRsiExecuteHooks => ({
		spawn: options.spawn,
		repoRoot: options.repoRoot,
		cwd: options.cwd ?? sessionCwd,
		signal,
		onProgress,
	});

	pi.on("session_start", (_event, ctx) => {
		sessionCwd = ctx.cwd;
		pi.registerTool({
			name: MUSE_RSI_TOOL_NAMES[0],
			label: "harness_rsi",
			description:
				"Measure this harness against the real Muse Code CLI through the parity harness, have pi-muse fix its own source, and repeat until the driver explicitly declares parity or blockage. Long-running: spawns `node scripts/harness-rsi.mjs` with the pi-muse repository as its working directory and waits for it to finish. It writes `HARNESS_RSI_DECLARATION.json` at the repo root; the result reports that declaration's status, iteration count, and remaining gaps, read back from the file rather than inferred from the exit code. Refused inside an RSI child to prevent infinite recursion. Optional parameters: max_iterations (1-64), fixture, dry_run.",
			parameters: harnessRsiSchema,
			executionMode: "sequential",
			execute: async (_toolCallId, input: Record<string, unknown>, signal, onUpdate) => {
				const validated = validateHarnessRsiParams(input);
				if ("error" in validated) {
					const details: HarnessRsiDetails = {
						...emptyDetails(),
						error: "invalid_params",
						message: validated.error,
					};
					return toToolResult(details);
				}
				const details = await executeHarnessRsi(
					validated.params,
					hooks(signal, (output) => {
						onUpdate?.({
							content: [{ type: "text" as const, text: `harness_rsi running…\n${output}` }],
							details: { ...emptyDetails(), output },
						});
					}),
				);
				return toToolResult(details);
			},
		});
	});

	pi.registerCommand(MUSE_RSI_COMMAND_NAME, {
		description:
			"Run the harness recursive-self-improvement loop: measure pi-muse against the real Muse Code CLI until the driver declares parity or blockage.",
		handler: async (args, ctx) => {
			const parsed = parseHarnessRsiCommandArgs(args);
			if ("error" in parsed) {
				ctx.ui.notify(`harness-rsi: ${parsed.error}`, "error");
				return;
			}
			ctx.ui.notify("harness-rsi started; this can take a long time…", "info");
			const details = await executeHarnessRsi(
				parsed.params,
				hooks(undefined, (output) =>
					ctx.ui.setStatus(MUSE_RSI_COMMAND_NAME, `harness-rsi: ${output.length} chars`),
				),
			);
			ctx.ui.setStatus(MUSE_RSI_COMMAND_NAME, undefined);
			ctx.ui.notify(
				formatHarnessRsiDetails(details),
				details.error || details.status === "blocked" ? "error" : "info",
			);
		},
	});
}
