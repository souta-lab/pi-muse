#!/usr/bin/env node
/**
 * Recursive self-improvement (RSI) driver for the Muse parity harness.
 *
 * Each iteration:
 *   1. runs `scripts/muse-proxy/run-parity.mjs --fixture <fixture> --json`
 *   2. proves the capture it just produced is fresh (never reuses a stale one)
 *   3. derives an explicit ordered gap list from that run's `diff-summary.json`
 *   4. if the list is empty, writes a `complete` declaration and exits 0
 *   5. otherwise spawns `pi-muse -p "<gap list + fix instructions>"` with the repo
 *      as cwd and approvals bypassed, then re-runs the focused Muse test suites
 *   6. loops; a gap list unchanged across two iterations escalates the prompt
 *
 * Termination is always explicit: the process only exits after writing
 * `HARNESS_RSI_DECLARATION.json` at the repo root. An iteration cap, a pi-muse
 * spawn failure or any internal error produces `status: "blocked"` with the
 * remaining gaps, never a silent exit and never a premature `complete`.
 *
 * Exit codes: 0 complete, 2 blocked (declared), 1 internal error (declaration
 * still written first).
 *
 * Usage:
 *   node scripts/harness-rsi.mjs [--max-iterations <n>] [--fixture <name>]
 *                               [--dry-run] [--json] [--help]
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createFsIo, DEFAULT_FIXTURE, DEFAULT_MAX_ITERATIONS, formatGap, runHarnessRsi } from "./harness-rsi/core.mjs";
import { parseCliArgs, TMP_ROOT } from "./muse-proxy/lib.mjs";

export {
	createFsIo,
	declarationInvariantViolation,
	deriveGaps,
	fingerprintGaps,
	formatGap,
	HarnessRsiError,
	locateFreshCapture,
	runHarnessRsi,
} from "./harness-rsi/core.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");

function runProcess({ command, args, cwd, env, timeoutMs }) {
	return new Promise((resolveRun) => {
		let stdout = "";
		let stderr = "";
		let child;
		try {
			child = spawn(command, args, { cwd, env: env ?? process.env, stdio: ["ignore", "pipe", "pipe"] });
		} catch (error) {
			resolveRun({ status: "spawn-error", code: null, stdout, stderr, error });
			return;
		}
		child.stdout?.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr?.on("data", (chunk) => {
			stderr += chunk;
		});
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			resolveRun({ status: "timeout", code: null, stdout, stderr });
		}, timeoutMs);
		child.on("error", (error) => {
			clearTimeout(timer);
			resolveRun({
				status: error?.code === "ENOENT" ? "not-found" : "spawn-error",
				code: null,
				stdout,
				stderr,
				error,
			});
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolveRun({ status: "exit", code, stdout, stderr });
		});
	});
}

function resolvePiBin(repoRoot, override) {
	if (override) return override;
	if (process.env.HARNESS_RSI_PI_BIN) return process.env.HARNESS_RSI_PI_BIN;
	const local = join(repoRoot, "node_modules", ".bin", "pi-muse");
	if (existsSync(local)) return local;
	return "pi-muse";
}

async function main() {
	const { options } = parseCliArgs(process.argv.slice(2), {
		"max-iterations": { type: "number", default: DEFAULT_MAX_ITERATIONS },
		fixture: { type: "string", default: DEFAULT_FIXTURE },
		"dry-run": { type: "boolean", default: false },
		json: { type: "boolean", default: false },
		help: { type: "boolean", default: false },
		"repo-root": { type: "string", default: REPO_ROOT },
		declaration: { type: "string", default: "" },
		"captures-dir": { type: "string", default: "" },
		"iterations-dir": { type: "string", default: "" },
		"pi-bin": { type: "string", default: "" },
		"parity-timeout-ms": { type: "number", default: 300000 },
		"pi-timeout-ms": { type: "number", default: 1800000 },
		"test-timeout-ms": { type: "number", default: 900000 },
		"test-filter": { type: "string", default: "muse" },
	});

	if (options.help) {
		process.stdout.write(
			[
				"usage: node scripts/harness-rsi.mjs [options]",
				"",
				"  --max-iterations <n>    Iteration cap (default 8).",
				"  --fixture <name>        Parity fixture (default tool-call).",
				"  --dry-run               Compute and print the gap list, make no edits,",
				"                          write a blocked declaration with reason=dry-run.",
				"  --json                  Emit a machine-readable result.",
				"  --repo-root <dir>       Repository root (default: this repo).",
				"  --declaration <path>    Declaration path (default <repo>/HARNESS_RSI_DECLARATION.json).",
				"  --captures-dir <dir>    Capture root (default /tmp/opencode/muse-proxy-captures).",
				"  --iterations-dir <dir>  Per-iteration logs (default /tmp/opencode/harness-rsi/<runId>).",
				"  --pi-bin <path>         pi-muse binary used as the fixer (default node_modules/.bin/pi-muse).",
				"  --parity-timeout-ms <n> Parity harness timeout (default 300000).",
				"  --pi-timeout-ms <n>     pi-muse fixer timeout (default 1800000).",
				"  --test-timeout-ms <n>   Focused test timeout (default 900000).",
				"  --test-filter <text>    Vitest filename filter for the focused tests (default muse).",
				"  --help                  Show this help.",
				"",
				"exit codes: 0 complete, 2 blocked (declared), 1 internal error (declaration still written).",
				"",
			].join("\n"),
		);
		process.exit(0);
	}

	const repoRoot = resolve(options["repo-root"]);
	const runId = new Date().toISOString().replace(/[:.]/g, "-");
	const declarationPath = options.declaration
		? resolve(options.declaration)
		: join(repoRoot, "HARNESS_RSI_DECLARATION.json");
	const capturesDir = options["captures-dir"] || join(TMP_ROOT, "muse-proxy-captures");
	const iterationsDir = options["iterations-dir"] || join(TMP_ROOT, "harness-rsi", runId);
	const io = createFsIo();
	const log = (message) => process.stderr.write(`${message}\n`);

	const deps = {
		io,
		now: () => new Date(),
		log,
		runParity: async ({ fixture }) => {
			const result = await runProcess({
				command: process.execPath,
				args: [
					join(repoRoot, "scripts", "muse-proxy", "run-parity.mjs"),
					"--fixture",
					fixture,
					"--captures-dir",
					capturesDir,
					"--json",
				],
				cwd: repoRoot,
				timeoutMs: options["parity-timeout-ms"],
			});
			return { exitCode: result.code ?? 1, stdout: result.stdout, stderr: result.stderr, status: result.status };
		},
		spawnPiMuse: async ({ prompt, cwd }) => {
			const piBin = resolvePiBin(repoRoot, options["pi-bin"]);
			log(`[harness-rsi] pi-muse fixer: ${piBin} --yolo -p <prompt>`);
			const result = await runProcess({
				command: piBin,
				args: ["--yolo", "-p", prompt],
				cwd,
				timeoutMs: options["pi-timeout-ms"],
			});
			return {
				status: result.status,
				code: result.code,
				stdout: result.stdout,
				stderr: result.stderr,
				error: result.error,
			};
		},
		runFocusedTests: async () => {
			const filter = options["test-filter"];
			const command = `${process.execPath} ${join(repoRoot, "node_modules", "vitest", "dist", "cli.js")} --run ${filter}`;
			const result = await runProcess({
				command: process.execPath,
				args: [join(repoRoot, "node_modules", "vitest", "dist", "cli.js"), "--run", filter],
				cwd: join(repoRoot, "packages", "coding-agent"),
				timeoutMs: options["test-timeout-ms"],
			});
			return {
				pass: result.status === "exit" && result.code === 0,
				command,
				suites: [filter],
				output: `${result.stdout}\n${result.stderr}`,
			};
		},
		captureRepoDiff: async ({ repoRoot: root }) => {
			const status = await runProcess({
				command: "git",
				args: ["-C", root, "status", "--porcelain=v1"],
				timeoutMs: 30000,
			});
			const diff = await runProcess({
				command: "git",
				args: ["-C", root, "diff", "HEAD", "--no-color", "--stat", "--patch"],
				timeoutMs: 60000,
			});
			const text = `# git status --porcelain\n${status.stdout}\n# git diff HEAD --stat --patch\n${diff.stdout}`;
			return text.slice(-200_000);
		},
	};

	const result = await runHarnessRsi(
		{
			maxIterations: options["max-iterations"],
			fixture: options.fixture,
			dryRun: options["dry-run"],
			repoRoot,
			declarationPath,
			capturesDir,
			iterationsDir,
		},
		deps,
	);

	if (options.json) {
		process.stdout.write(
			`${JSON.stringify(
				{
					exitCode: result.exitCode,
					declarationPath: result.declarationPath,
					declarationWritten: result.declarationWritten,
					error: result.error?.message ?? null,
					declaration: result.declaration,
				},
				null,
				2,
			)}\n`,
		);
	} else if (result.declaration.status === "complete") {
		process.stdout.write(`HARNESS_RSI: COMPLETE\n`);
		process.stdout.write(`iterations: ${result.declaration.iterations}/${result.declaration.maxIterations}\n`);
		process.stdout.write(`parity summary: ${result.declaration.evidence.paritySummaryPath ?? "(none)"}\n`);
		process.stdout.write(`declaration: ${result.declarationPath}\n`);
		process.stdout.write(
			`iteration logs:\n${result.declaration.evidence.iterationLogs.map((p) => `  ${p}`).join("\n")}\n`,
		);
	} else {
		process.stdout.write(`HARNESS_RSI: BLOCKED (${result.declaration.reason})\n`);
		process.stdout.write(`iterations: ${result.declaration.iterations}/${result.declaration.maxIterations}\n`);
		process.stdout.write(`remaining gaps: ${result.declaration.remainingGaps.length}\n`);
		for (const gap of result.declaration.remainingGaps.slice(0, 40)) process.stdout.write(`  ${formatGap(gap)}\n`);
		if (result.declaration.remainingGaps.length > 40) {
			process.stdout.write(`  … ${result.declaration.remainingGaps.length - 40} more (see declaration)\n`);
		}
		process.stdout.write(`declaration: ${result.declarationPath}\n`);
	}
	if (!result.declarationWritten) {
		process.stderr.write(`[harness-rsi] FAILURE: declaration was not written at ${result.declarationPath}\n`);
		if (result.error) process.stderr.write(`[harness-rsi] ${result.error.message}\n`);
	}
	process.exitCode = result.exitCode;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	await main();
}
