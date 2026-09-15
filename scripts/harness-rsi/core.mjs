#!/usr/bin/env node
/**
 * Core decision logic for the harness recursive self-improvement (RSI) driver.
 *
 * This module is pure with respect to the outside world: every filesystem
 * access, clock read, process spawn and test execution is injected through the
 * `deps` object passed to `runHarnessRsi`. That is what makes the decision
 * logic (gap parsing, freshness proof, escalation, termination) deterministic
 * and testable without spawning the real Muse CLI or writing to the repo.
 *
 * The public surface is:
 *   - `deriveGaps(diffSummary)`            turn a parity `diff-summary.json` into an ordered gap list
 *   - `fingerprintGaps(gaps)`              stable hash used by the no-progress guard
 *   - `locateFreshCapture({...})`          prove a capture was produced by *this* invocation
 *   - `runHarnessRsi(options, deps)`       the iteration loop; always writes a declaration
 *   - `createFsIo()`                       real node:fs implementation of the io interface
 *
 * Termination is always explicit: `runHarnessRsi` returns only after attempting
 * to write `HARNESS_RSI_DECLARATION.json` (status `complete` only when the gap
 * list is empty, otherwise `blocked`) and verifying that it exists. If the
 * declaration cannot be written it reports failure with exit code 1 instead of
 * pretending to have succeeded.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";

export const DEFAULT_MAX_ITERATIONS = 8;
export const DEFAULT_FIXTURE = "tool-call";
/** Order in which gap categories are reported. */
export const GAP_CATEGORIES = ["core-check", "leaf", "tool-missing", "tool-schema", "section"];
/** `diff-requests.mjs` caps the per-pair `differences` array at this many entries. */
export const MAX_DIFFERENCE_ENTRIES = 400;
/** Tolerance when comparing wall-clock timestamps against this process's clock. */
const FRESHNESS_TOLERANCE_MS = 5000;

export class HarnessRsiError extends Error {
	constructor(message) {
		super(message);
		this.name = "HarnessRsiError";
	}
}

/** Render a value for the gap list without ever throwing on cyclic input. */
export function stringifyValue(value, max = 200) {
	let text;
	if (value === undefined) text = "<missing>";
	else if (value === null) text = "<null>";
	else if (typeof value === "string") text = value;
	else {
		try {
			text = JSON.stringify(value);
		} catch {
			text = String(value);
		}
	}
	if (typeof text !== "string") text = String(value);
	return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function describeToolDiffs(tool) {
	const parts = [`schema ${((tool.schemaSimilarity ?? 0) * 100).toFixed(2)}%`];
	if (tool.description && !tool.description.equal) {
		parts.push(`description ${tool.description.leftChars}->${tool.description.rightChars} chars`);
	}
	if (tool.strict && !tool.strict.equal) {
		parts.push(`strict ${stringifyValue(tool.strict.left)}->${stringifyValue(tool.strict.right)}`);
	}
	if (tool.additionalProperties && !tool.additionalProperties.equal) parts.push("additionalProperties differs");
	if (tool.properties && !tool.properties.equal) {
		parts.push(`properties -[${tool.properties.leftOnly.join(",")}] +[${tool.properties.rightOnly.join(",")}]`);
	}
	if (tool.required && !tool.required.equal) {
		parts.push(`required -[${tool.required.leftOnly.join(",")}] +[${tool.required.rightOnly.join(",")}]`);
	}
	return parts.join("; ");
}

/**
 * Turn one run's `diff-summary.json` into an explicit, ordered gap list.
 *
 * Covered, in report order:
 *   1. every failing core check            (`checks[].pass === false`)
 *   2. every compared leaf that differs    (`differences[]`, both values)
 *   3. every tool missing on either side   (`tools[].status !== "both"`)
 *   4. every shared tool whose schema is not byte-identical (`schemaSimilarity < 1`)
 *   5. every scored section under 100%     (`sections[].score < 1`, non-empty)
 *
 * Sections with zero leaves (absent from a request, e.g. `input.toolResult` on
 * the first turn) are NOT gaps: they carry no comparable content. The weighted
 * fidelity score is reported as evidence but deliberately not a gap, because it
 * is derived from these same categories and an absent weighted section would
 * otherwise make "zero differing leaves" unreachable.
 */
export function deriveGaps(diffSummary) {
	const pairs = Array.isArray(diffSummary) ? diffSummary : [];
	const gaps = [];
	const warnings = [];
	for (const pair of pairs) {
		if (!pair || typeof pair !== "object") continue;
		const pairIndex = typeof pair.index === "number" ? pair.index : 0;
		const pairLabel = pair.label ?? `request ${pairIndex + 1}`;
		const base = { pair: pairIndex, pairLabel };

		for (const check of Array.isArray(pair.checks) ? pair.checks : []) {
			if (check?.pass) continue;
			gaps.push({
				...base,
				category: "core-check",
				id: String(check?.name ?? "?"),
				left: stringifyValue(check?.left),
				right: stringifyValue(check?.right),
				detail: `core check "${check?.name ?? "?"}" differs on ${pairLabel}`,
			});
		}

		const differences = Array.isArray(pair.differences) ? pair.differences : [];
		for (const diff of differences) {
			gaps.push({
				...base,
				category: "leaf",
				id: String(diff?.path ?? "?"),
				left: stringifyValue(diff?.left),
				right: stringifyValue(diff?.right),
				detail: `compared leaf differs on ${pairLabel}`,
			});
		}
		if (differences.length >= MAX_DIFFERENCE_ENTRIES) {
			warnings.push({
				pair: pairIndex,
				kind: "differences-truncated",
				message: `pair ${pairIndex} has ${differences.length} differing leaves (the harness caps this list at ${MAX_DIFFERENCE_ENTRIES}); more may be hidden`,
			});
		}

		for (const tool of Array.isArray(pair.tools?.tools) ? pair.tools.tools : []) {
			if (tool?.status !== "both") {
				const leftOnly = tool?.status === "left-only";
				gaps.push({
					...base,
					category: "tool-missing",
					id: String(tool?.name ?? "?"),
					left: leftOnly ? "present (muse)" : "absent on muse",
					right: leftOnly ? "absent on pi-muse" : "present (pi-muse)",
					detail: leftOnly
						? "muse declares this tool, pi-muse does not"
						: "pi-muse declares this tool, muse does not",
				});
				continue;
			}
			if (typeof tool.schemaSimilarity === "number" && tool.schemaSimilarity < 1) {
				gaps.push({
					...base,
					category: "tool-schema",
					id: String(tool.name ?? "?"),
					left: `${(tool.schemaSimilarity * 100).toFixed(2)}%`,
					right: "100%",
					detail: describeToolDiffs(tool),
				});
			}
		}

		for (const section of Array.isArray(pair.sections) ? pair.sections : []) {
			if (typeof section?.score !== "number" || section.score >= 1) continue;
			if (!section.total) continue;
			gaps.push({
				...base,
				category: "section",
				id: String(section.name ?? "?"),
				left: `${(section.score * 100).toFixed(2)}% (${section.matched}/${section.total} leaves match)`,
				right: "100%",
				detail: `section "${section.name}" is not fully identical on ${pairLabel}`,
			});
		}
	}

	const rank = new Map(GAP_CATEGORIES.map((category, index) => [category, index]));
	gaps.sort((a, b) => (rank.get(a.category) ?? 99) - (rank.get(b.category) ?? 99) || a.pair - b.pair);
	return { gaps, warnings };
}

/** Stable hash over the exact gap set, used by the no-progress guard. */
export function fingerprintGaps(gaps) {
	const canonical = gaps
		.map((gap) => [gap.category, gap.pair, gap.id, gap.left, gap.right].join("\u0001"))
		.join("\u0002");
	return createHash("sha256").update(canonical).digest("hex");
}

export function formatGap(gap) {
	const where = gap.pairLabel ? `${gap.pairLabel} ` : "";
	return `[${gap.category}] ${where}${gap.id}: muse=${gap.left} | pi-muse=${gap.right}${gap.detail ? `  (${gap.detail})` : ""}`;
}

/**
 * Parse a capture timestamp. `run-parity.mjs` builds its run id and
 * `manifest.startedAt` by replacing `:` and `.` with `-`, so the value is not a
 * valid ISO string (`2026-09-15T16-47-02-205Z`). Accept both that mangled form
 * (optionally with the trailing `-<uuid8>` run-id suffix) and a real ISO value.
 */
export function parseCaptureTimestamp(value) {
	if (typeof value !== "string" || !value) return Number.NaN;
	const direct = Date.parse(value);
	if (Number.isFinite(direct)) return direct;
	const stripped = value.replace(/-[0-9a-f]{8}$/i, "");
	const match = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/.exec(stripped);
	if (!match) return Number.NaN;
	return Date.parse(`${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`);
}

function safeMtimeMs(io, path) {
	try {
		const value = io.statMtimeMs(path);
		return typeof value === "number" && Number.isFinite(value) ? value : null;
	} catch {
		return null;
	}
}

function isInside(root, candidate) {
	return candidate === root || candidate.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

/**
 * Prove that a capture directory was produced by the invocation that just ran.
 *
 * The strongest proof is the `captureRoot` echoed by `run-parity.mjs --json`,
 * which is generated inside that exact process. It is accepted only when all of
 * the following hold:
 *   - it is inside `capturesDir`
 *   - its directory name was not present before the invocation started
 *   - `manifest.json` and `diff-summary.json` both exist
 *   - `manifest.runId` equals the directory name
 *   - `manifest.startedAt` is not older than the invocation start (small skew tolerance)
 *   - the `diff-summary.json` mtime is not older than the invocation start
 *   - when a fixture is requested, `manifest.fixture` matches
 *
 * If no authoritative path is available, the newest not-pre-existing directory
 * with the same checks is used; if none passes, this throws instead of reusing
 * a stale capture.
 */
export function locateFreshCapture({
	io,
	capturesDir,
	beforeNames = [],
	invocationStartedAtMs,
	paritySummary = null,
	fixture = null,
}) {
	const beforeSet = new Set(beforeNames);
	const authoritative = typeof paritySummary?.captureRoot === "string" ? paritySummary.captureRoot : null;
	const candidates = [];

	if (authoritative) {
		candidates.push(authoritative);
	} else {
		const names = io.listNames(capturesDir);
		const withMtime = names
			.map((name) => ({ name, mtimeMs: safeMtimeMs(io, join(capturesDir, name)) }))
			.filter((entry) => entry.mtimeMs !== null)
			.sort((a, b) => b.mtimeMs - a.mtimeMs);
		for (const entry of withMtime) candidates.push(join(capturesDir, entry.name));
	}

	if (candidates.length === 0) {
		throw new HarnessRsiError(`could not locate any parity capture under ${capturesDir}`);
	}

	const rejections = [];
	for (const root of candidates) {
		const name = basename(root);
		if (!isInside(capturesDir, root)) {
			rejections.push(`${name}: capture root is outside ${capturesDir}`);
			continue;
		}
		if (beforeSet.has(name)) {
			rejections.push(`${name}: directory existed before this invocation`);
			continue;
		}
		const manifestPath = join(root, "manifest.json");
		const diffSummaryPath = join(root, "diff-summary.json");
		if (!io.exists(manifestPath) || !io.exists(diffSummaryPath)) {
			rejections.push(`${name}: manifest.json or diff-summary.json is missing`);
			continue;
		}
		let manifest;
		let diffSummary;
		try {
			manifest = io.readJson(manifestPath);
			diffSummary = io.readJson(diffSummaryPath);
		} catch (error) {
			rejections.push(`${name}: could not parse capture (${error?.message ?? error})`);
			continue;
		}
		if (manifest?.runId !== name) {
			rejections.push(`${name}: manifest.runId=${stringifyValue(manifest?.runId, 80)} does not match the directory`);
			continue;
		}
		const startedAtMs = parseCaptureTimestamp(manifest?.startedAt);
		if (!Number.isFinite(startedAtMs)) {
			rejections.push(`${name}: manifest.startedAt is not a valid timestamp`);
			continue;
		}
		if (startedAtMs + FRESHNESS_TOLERANCE_MS < invocationStartedAtMs) {
			rejections.push(`${name}: capture started at ${manifest.startedAt}, before this invocation`);
			continue;
		}
		const mtimeMs = safeMtimeMs(io, diffSummaryPath);
		if (mtimeMs !== null && mtimeMs + FRESHNESS_TOLERANCE_MS < invocationStartedAtMs) {
			rejections.push(`${name}: diff-summary.json mtime predates this invocation`);
			continue;
		}
		if (fixture && manifest?.fixture && manifest.fixture !== fixture) {
			rejections.push(`${name}: fixture ${manifest.fixture} != requested ${fixture}`);
			continue;
		}
		return {
			captureRoot: root,
			runId: name,
			manifest,
			diffSummary,
			manifestPath,
			diffSummaryPath,
			proof: {
				authoritative: Boolean(authoritative),
				startedAt: manifest.startedAt,
				invocationStartedAt: new Date(invocationStartedAtMs).toISOString(),
				diffSummaryMtimeMs: mtimeMs,
				beforeNameCount: beforeSet.size,
			},
		};
	}

	throw new HarnessRsiError(
		`could not prove a fresh parity capture under ${capturesDir}; refusing to reuse a stale capture: ${rejections.join("; ")}`,
	);
}

function tailText(text, lines) {
	const trimmed = String(text ?? "").trimEnd();
	if (!trimmed) return "";
	return trimmed.split("\n").slice(-lines).join("\n");
}

/** Build the prompt handed to pi-muse for one iteration. */
export function buildFixPrompt({
	repoRoot,
	fixture,
	iteration,
	maxIterations,
	gaps,
	warnings,
	escalation,
	focusedRuns,
}) {
	const lines = [];
	lines.push(`You are pi-muse improving its own source tree at ${repoRoot}.`);
	lines.push("");
	lines.push(
		`A traffic-interception parity harness (scripts/muse-proxy/run-parity.mjs) compared pi-muse's outbound Responses API request against the real muse CLI for fixture "${fixture}".`,
	);
	lines.push(
		`This is RSI iteration ${iteration} of ${maxIterations}. The harness computed the following explicit gap list; every entry names the field/tool and both values (muse vs pi-muse).`,
	);
	lines.push("");
	lines.push(`GAPS (${gaps.length}):`);
	if (gaps.length === 0) lines.push("  (none)");
	const perCategory = new Map();
	for (const gap of gaps) perCategory.set(gap.category, (perCategory.get(gap.category) ?? 0) + 1);
	for (const [category, count] of perCategory) lines.push(`  - ${category}: ${count}`);
	lines.push("");
	for (const [index, gap] of gaps.entries()) lines.push(`  ${index + 1}. ${formatGap(gap)}`);
	if (warnings.length > 0) {
		lines.push("");
		lines.push("WARNINGS (not gaps, but evidence):");
		for (const warning of warnings) lines.push(`  - ${warning.message}`);
	}
	lines.push("");
	if (escalation) {
		lines.push("ESCALATION — THE PREVIOUS ATTEMPT FAILED:");
		lines.push(
			"The gap list for this iteration is IDENTICAL to the previous iteration. The same approach failed; do NOT repeat it.",
		);
		lines.push(
			"Change the root cause or the file you edit. Inspect why the previous edits did not change the captured request.",
		);
		lines.push("");
		lines.push("Previous attempt's repository diff (read-only snapshot, may include other agents' edits):");
		lines.push("```diff");
		lines.push(escalation.previousDiff?.trim() ? escalation.previousDiff.trim() : "(no diff was recorded)");
		lines.push("```");
		lines.push("");
		if (escalation.previousTests) {
			lines.push(
				`Previous attempt's focused tests: ${escalation.previousTests.pass ? "PASS" : "FAIL"} (${escalation.previousTests.command ?? "unknown command"})`,
			);
			lines.push("");
		}
	}
	if (focusedRuns.length > 0) {
		const last = focusedRuns[focusedRuns.length - 1];
		lines.push(`Most recent focused test result: ${last.pass ? "PASS" : "FAIL"} (${last.command ?? "unknown"}).`);
		if (!last.pass) lines.push("Your changes must not leave these tests failing.");
		lines.push("");
	}
	lines.push("INSTRUCTIONS:");
	lines.push(
		"- Fix the pi-muse source so the gaps above disappear. Prefer the smallest change that changes the captured request.",
	);
	lines.push(
		"- Edit source under packages/ only. Do NOT modify scripts/muse-proxy/** (the harness), package.json, or README.md.",
	);
	lines.push("- Do NOT run git stash, git checkout ., or git clean -fd.");
	lines.push("- Re-run the Muse test suites the change could affect before finishing.");
	lines.push(
		`- Finish by running the harness yourself: node scripts/muse-proxy/run-parity.mjs --fixture ${fixture} --json  (a non-zero exit is expected while gaps remain).`,
	);
	lines.push("- Report which files you changed and what changed in the captured request.");
	return lines.join("\n");
}

/** The one invariant a declaration must never violate. Returns a message or null. */
export function declarationInvariantViolation(declaration) {
	if (!declaration || (declaration.status !== "complete" && declaration.status !== "blocked")) {
		return 'declaration.status must be "complete" or "blocked"';
	}
	if (declaration.status === "complete") {
		if ((declaration.gaps?.length ?? 0) > 0 || (declaration.remainingGaps?.length ?? 0) > 0) {
			return "refusing to declare complete while gaps remain";
		}
	}
	return null;
}

function buildDeclaration({
	status,
	reason,
	startedAt,
	finishedAt,
	iterations,
	maxIterations,
	gaps,
	warnings,
	focusedRuns,
	parityEvidence,
	iterationLogs,
	fixture,
	dryRun,
	internalError,
	history,
}) {
	const declaration = {
		status,
		startedAt,
		finishedAt,
		iterations,
		maxIterations,
		gaps,
		remainingGaps: status === "complete" ? [] : gaps,
		testSummary: {
			parity: parityEvidence
				? {
						runId: parityEvidence.runId ?? null,
						captureRoot: parityEvidence.captureRoot,
						diffSummaryPath: parityEvidence.diffSummaryPath,
						remainingGapCount: gaps.length,
					}
				: null,
			focused: focusedRuns,
		},
		evidence: {
			paritySummaryPath: parityEvidence?.diffSummaryPath ?? null,
			iterationLogs: [...iterationLogs],
		},
		reason,
		fixture,
		dryRun,
		escalations: history.filter((entry) => entry.escalated).length,
		history,
		warnings,
	};
	if (internalError) declaration.error = internalError.message ?? String(internalError);
	return declaration;
}

function pad2(value) {
	return String(value).padStart(2, "0");
}

/**
 * Run the RSI loop.
 *
 * @param {{maxIterations?: number, fixture?: string, dryRun?: boolean, repoRoot: string, declarationPath: string, capturesDir: string, iterationsDir: string}} options
 * @param {{
 *   io: ReturnType<typeof createFsIo>,
 *   now: () => Date,
 *   runParity: (ctx: {fixture: string, iteration: number, options: object}) => Promise<{exitCode: number, stdout: string, stderr: string}>,
 *   spawnPiMuse: (ctx: {prompt: string, cwd: string, logPath: string, iteration: number}) => Promise<{status: string, code: number|null, stdout?: string, stderr?: string, error?: Error}>,
 *   runFocusedTests: (ctx: {iteration: number, options: object}) => Promise<{pass: boolean, command?: string, suites?: string[], output?: string}>,
 *   captureRepoDiff: (ctx: {repoRoot: string, iteration: number}) => Promise<string>,
 *   log?: (message: string) => void,
 * }} deps
 */
export async function runHarnessRsi(options, deps) {
	const {
		maxIterations = DEFAULT_MAX_ITERATIONS,
		fixture = DEFAULT_FIXTURE,
		dryRun = false,
		repoRoot,
		declarationPath,
		capturesDir,
		iterationsDir,
	} = options;
	const io = deps.io;
	const now = deps.now;
	const log = deps.log ?? (() => {});
	if (!io || typeof now !== "function") throw new HarnessRsiError("runHarnessRsi requires deps.io and deps.now");
	if (!repoRoot || !declarationPath || !capturesDir || !iterationsDir) {
		throw new HarnessRsiError("runHarnessRsi requires repoRoot, declarationPath, capturesDir and iterationsDir");
	}

	const startedAt = now().toISOString();
	const iterationLogs = [];
	const history = [];
	const focusedRuns = [];
	let parityEvidence = null;
	let gaps = [];
	let warnings = [];
	let status = null;
	let reason = "";
	let internalError = null;
	let previousFingerprint = null;
	let previousDiff = "";
	let previousTests = null;
	let iterations = 0;

	try {
		for (let iteration = 1; iteration <= maxIterations; iteration++) {
			iterations = iteration;
			io.mkdirp(iterationsDir);
			const logPath = join(iterationsDir, `iteration-${pad2(iteration)}.log`);
			const logLines = [];
			const record = (message) => {
				logLines.push(message);
				log(message);
			};

			record(`[harness-rsi] iteration ${iteration}/${maxIterations} fixture=${fixture} dryRun=${dryRun}`);
			const beforeNames = io.listNames(capturesDir);
			const invocationStartedAtMs = now().getTime();
			record(`[harness-rsi] captures snapshot: ${beforeNames.length} existing run(s) under ${capturesDir}`);

			const parity = await deps.runParity({ fixture, iteration, options });
			record(`[harness-rsi] parity harness exit=${parity.exitCode}`);
			let paritySummary = null;
			try {
				paritySummary = parity.stdout?.trim() ? JSON.parse(parity.stdout) : null;
			} catch {
				paritySummary = null;
			}
			if (!paritySummary) {
				const recovered = extractLastJsonObject(parity.stdout ?? "");
				if (recovered) {
					paritySummary = recovered;
					record("[harness-rsi] recovered parity JSON from non-pure stdout");
				}
			}

			const fresh = locateFreshCapture({
				io,
				capturesDir,
				beforeNames,
				invocationStartedAtMs,
				paritySummary,
				fixture,
			});
			const derived = deriveGaps(fresh.diffSummary);
			gaps = derived.gaps;
			warnings = derived.warnings;
			parityEvidence = {
				captureRoot: fresh.captureRoot,
				diffSummaryPath: fresh.diffSummaryPath,
				runId: fresh.runId,
			};
			record(
				`[harness-rsi] fresh capture proven: ${fresh.captureRoot} (authoritative=${fresh.proof.authoritative})`,
			);
			record(`[harness-rsi] gaps=${gaps.length} warnings=${warnings.length}`);
			for (const gap of gaps) record(`[harness-rsi]   ${formatGap(gap)}`);

			const fingerprint = fingerprintGaps(gaps);

			// `--dry-run` always ends blocked with reason "dry-run", even when the
			// gap list happens to be empty: it never makes edits and never claims
			// success.
			if (dryRun) {
				status = "blocked";
				reason = "dry-run";
				history.push({ iteration, gapCount: gaps.length, fingerprint, verdict: "dry-run", escalated: false });
				record("[harness-rsi] dry-run: no edits performed, declaration will be blocked with reason=dry-run");
				io.writeFile(logPath, `${logLines.join("\n")}\n`);
				iterationLogs.push(logPath);
				break;
			}

			if (gaps.length === 0) {
				status = "complete";
				reason = "parity reached: all core checks pass, zero differing leaves, and the tool set matches";
				history.push({ iteration, gapCount: 0, fingerprint, verdict: "complete", escalated: false });
				record("[harness-rsi] no gaps: declaring complete");
				io.writeFile(logPath, `${logLines.join("\n")}\n`);
				iterationLogs.push(logPath);
				break;
			}

			const unchanged = previousFingerprint !== null && fingerprint === previousFingerprint;
			if (unchanged) record("[harness-rsi] ESCALATION: gap list unchanged since the previous iteration");
			const prompt = buildFixPrompt({
				repoRoot,
				fixture,
				iteration,
				maxIterations,
				gaps,
				warnings,
				escalation: unchanged ? { previousDiff, previousTests } : null,
				focusedRuns,
			});
			record(`[harness-rsi] invoking pi-muse (prompt ${prompt.length} chars)`);

			const piLogPath = join(iterationsDir, `pi-muse-iteration-${pad2(iteration)}.log`);
			const piResult = await deps.spawnPiMuse({ prompt, cwd: repoRoot, logPath: piLogPath, iteration });
			const piOutput = [piResult.stdout ?? "", piResult.stderr ?? ""].filter(Boolean).join("\n");
			io.writeFile(piLogPath, `${piOutput.slice(-500_000)}\n`);
			record(`[harness-rsi] pi-muse status=${piResult.status} code=${piResult.code ?? "null"}`);

			if (piResult.status === "spawn-error" || piResult.status === "not-found") {
				status = "blocked";
				reason = `pi-muse could not be spawned: ${piResult.error?.message ?? piResult.status}`;
				history.push({
					iteration,
					gapCount: gaps.length,
					fingerprint,
					verdict: "blocked",
					escalated: unchanged,
					piStatus: piResult.status,
				});
				record(`[harness-rsi] ${reason}`);
				io.writeFile(logPath, `${logLines.join("\n")}\n`);
				iterationLogs.push(logPath);
				break;
			}

			const testResult = await deps.runFocusedTests({ iteration, options });
			focusedRuns.push({
				iteration,
				pass: Boolean(testResult?.pass),
				command: testResult?.command ?? null,
				suites: testResult?.suites ?? [],
				outputTail: tailText(testResult?.output, 40),
			});
			record(
				`[harness-rsi] focused tests ${testResult?.pass ? "PASS" : "FAIL"}${testResult?.command ? ` (${testResult.command})` : ""}`,
			);

			previousDiff = await deps.captureRepoDiff({ repoRoot, iteration });
			previousTests = { pass: Boolean(testResult?.pass), command: testResult?.command ?? null };
			previousFingerprint = fingerprint;
			history.push({
				iteration,
				gapCount: gaps.length,
				fingerprint,
				verdict: "attempted",
				escalated: unchanged,
				piStatus: piResult.status,
				piCode: piResult.code ?? null,
				testsPass: Boolean(testResult?.pass),
			});
			io.writeFile(logPath, `${logLines.join("\n")}\n`);
			iterationLogs.push(logPath);
		}

		if (status === null) {
			status = "blocked";
			reason = `iteration cap reached (${maxIterations}) with ${gaps.length} gap(s) remaining`;
		}
	} catch (error) {
		internalError = error;
		status = "blocked";
		reason = `internal error: ${error?.message ?? String(error)}`;
		try {
			io.mkdirp(iterationsDir);
			const fallbackLog = join(iterationsDir, `iteration-${pad2(iterations || 1)}.log`);
			io.writeFile(fallbackLog, `[harness-rsi] ${reason}\n${error?.stack ?? ""}\n`);
			iterationLogs.push(fallbackLog);
		} catch {}
	}

	const invariant = declarationInvariantViolation({
		status,
		gaps,
		remainingGaps: status === "complete" ? [] : gaps,
	});
	if (invariant) {
		internalError = new HarnessRsiError(invariant);
		status = "blocked";
		reason = `internal error: ${invariant}`;
	}

	const finishedAt = now().toISOString();
	const declaration = buildDeclaration({
		status,
		reason,
		startedAt,
		finishedAt,
		iterations,
		maxIterations,
		gaps,
		warnings,
		focusedRuns,
		parityEvidence,
		iterationLogs,
		fixture,
		dryRun,
		internalError,
		history,
	});

	const payload = `${JSON.stringify(declaration, null, 2)}\n`;
	let declarationWritten = false;
	try {
		io.mkdirp(dirname(declarationPath));
		io.writeFile(declarationPath, payload);
		declarationWritten = io.exists(declarationPath) && io.readFile(declarationPath) === payload;
		if (!declarationWritten) {
			throw new HarnessRsiError(`declaration at ${declarationPath} was not written as expected`);
		}
	} catch (error) {
		return {
			exitCode: 1,
			declaration,
			declarationPath,
			declarationWritten: false,
			error,
			history,
			iterationLogs,
			gaps,
			warnings,
		};
	}

	const exitCode = status === "complete" ? 0 : internalError ? 1 : 2;
	return {
		exitCode,
		declaration,
		declarationPath,
		declarationWritten,
		history,
		iterationLogs,
		gaps,
		warnings,
		internalError,
	};
}

/** Recover the last top-level JSON object from mixed stdout, if any. */
export function extractLastJsonObject(text) {
	const trimmed = String(text ?? "").trim();
	if (!trimmed) return null;
	for (let start = trimmed.lastIndexOf("{"); start !== -1; start = trimmed.lastIndexOf("{", start - 1)) {
		const candidate = trimmed.slice(start);
		try {
			return JSON.parse(candidate);
		} catch {
			// keep scanning backwards
		}
	}
	return null;
}

/** Real `node:fs` implementation of the io interface. */
export function createFsIo() {
	return {
		exists: (path) => existsSync(path),
		readFile: (path) => readFileSync(path, "utf8"),
		readJson: (path) => JSON.parse(readFileSync(path, "utf8")),
		listNames: (dir) => {
			try {
				return readdirSync(dir);
			} catch {
				return [];
			}
		},
		statMtimeMs: (path) => {
			try {
				return statSync(path).mtimeMs;
			} catch {
				return null;
			}
		},
		mkdirp: (path) => {
			mkdirSync(path, { recursive: true });
		},
		writeFile: (path, data) => {
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, data);
		},
	};
}
