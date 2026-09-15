import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	declarationInvariantViolation,
	deriveGaps,
	fingerprintGaps,
	locateFreshCapture,
	parseCaptureTimestamp,
	runHarnessRsi,
} from "./harness-rsi/core.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const GAPPY = JSON.parse(readFileSync(join(HERE, "harness-rsi", "fixtures", "diff-summary.gappy.json"), "utf8"));
const PARITY = JSON.parse(readFileSync(join(HERE, "harness-rsi", "fixtures", "diff-summary.parity.json"), "utf8"));

/**
 * In-memory io. Every path the driver touches goes through this object, so the
 * tests never read or write the real repository or a real temp directory.
 */
function createMemoryIo() {
	const files = new Map();
	const clean = (path) => String(path).replace(/\/+$/g, "") || "/";
	const api = {
		files,
		seedDir(path, mtimeMs = null) {
			files.set(clean(path), { data: "", isDir: true, mtimeMs });
		},
		seedFile(path, data, mtimeMs = null) {
			files.set(clean(path), { data: String(data), isDir: false, mtimeMs });
		},
		exists(path) {
			return files.has(clean(path));
		},
		readFile(path) {
			const entry = files.get(clean(path));
			if (!entry) throw new Error(`ENOENT: ${path}`);
			return entry.data;
		},
		readJson(path) {
			return JSON.parse(api.readFile(path));
		},
		listNames(dir) {
			const prefix = `${clean(dir)}/`;
			const names = new Set();
			for (const key of files.keys()) {
				if (!key.startsWith(prefix)) continue;
				const rest = key.slice(prefix.length);
				if (rest) names.add(rest.split("/")[0]);
			}
			return [...names];
		},
		statMtimeMs(path) {
			const entry = files.get(clean(path));
			return entry && typeof entry.mtimeMs === "number" ? entry.mtimeMs : null;
		},
		mkdirp(path) {
			if (!files.has(clean(path))) files.set(clean(path), { data: "", isDir: true, mtimeMs: null });
		},
		writeFile(path, data) {
			files.set(clean(path), { data: String(data), isDir: false, mtimeMs: null });
		},
	};
	return api;
}

/** Build a fully injected driver context plus call recorders. */
function makeHarness({ summaries = [PARITY], maxIterations = 1, dryRun = false, staleCapture = false } = {}) {
	const io = createMemoryIo();
	const capturesDir = "/mem/captures";
	const iterationsDir = "/mem/iterations";
	const declarationPath = "/mem/HARNESS_RSI_DECLARATION.json";
	io.seedDir(capturesDir);
	io.seedDir(iterationsDir);

	let clockMs = Date.parse("2026-01-01T00:00:00.000Z");
	const now = () => new Date(clockMs);
	const calls = { parity: 0, spawn: [], tests: 0, diffs: 0 };

	if (staleCapture) {
		const staleRoot = `${capturesDir}/stale-run`;
		io.seedDir(staleRoot);
		io.seedFile(
			`${staleRoot}/manifest.json`,
			JSON.stringify({
				runId: "stale-run",
				fixture: "tool-call",
				startedAt: new Date(clockMs - 3_600_000).toISOString(),
			}),
			clockMs - 3_600_000,
		);
		io.seedFile(`${staleRoot}/diff-summary.json`, JSON.stringify(summaries[0]), clockMs - 3_600_000);
	}

	const runParity = async () => {
		calls.parity += 1;
		if (staleCapture) {
			return { exitCode: 1, stdout: JSON.stringify({ captureRoot: `${capturesDir}/stale-run` }), stderr: "" };
		}
		const runId = `run-${calls.parity}`;
		const root = `${capturesDir}/${runId}`;
		const summary = summaries[Math.min(calls.parity - 1, summaries.length - 1)];
		io.seedDir(root);
		io.seedFile(
			`${root}/manifest.json`,
			JSON.stringify({ runId, fixture: "tool-call", startedAt: now().toISOString(), pass: false }),
			clockMs,
		);
		io.seedFile(`${root}/diff-summary.json`, JSON.stringify(summary), clockMs);
		clockMs += 1000;
		return {
			exitCode: 1,
			stdout: JSON.stringify({ captureRoot: root, fixture: "tool-call", pass: false }),
			stderr: "",
		};
	};
	const spawnPiMuse = async ({ prompt }) => {
		calls.spawn.push({ prompt });
		return { status: "exit", code: 0, stdout: "done", stderr: "" };
	};
	const runFocusedTests = async () => {
		calls.tests += 1;
		return { pass: true, command: "vitest --run muse", suites: ["muse"], output: "ok" };
	};
	const captureRepoDiff = async () => {
		calls.diffs += 1;
		return "diff --git a/packages/x b/packages/x\n+change";
	};
	const options = {
		maxIterations,
		fixture: "tool-call",
		dryRun,
		repoRoot: "/mem-repo",
		declarationPath,
		capturesDir,
		iterationsDir,
	};
	const deps = { io, now, runParity, spawnPiMuse, runFocusedTests, captureRepoDiff, log: () => {} };
	return { io, options, deps, calls };
}

test("deriveGaps turns a fixture diff-summary.json into an ordered, explicit gap list", () => {
	const { gaps, warnings } = deriveGaps(GAPPY);
	assert.deepEqual(
		gaps.map((gap) => `${gap.category}|${gap.pair}|${gap.id}`),
		[
			"core-check|0|max_output_tokens",
			"core-check|0|no invented tools",
			"leaf|0|input.0.content",
			"leaf|0|tools.create_goal",
			"leaf|1|input.0.content",
			"tool-missing|0|create_goal",
			"tool-missing|0|extra_tool",
			"tool-schema|0|subagent_wait",
			"section|0|tools",
			"section|1|input.user",
		],
	);
	assert.equal(warnings.length, 0);

	const tokens = gaps[0];
	assert.equal(tokens.left, "128000");
	assert.equal(tokens.right, "32768");

	const content = gaps[2];
	assert.equal(content.left, "plain string");
	assert.equal(content.right, JSON.stringify([{ type: "input_text", text: "plain string" }]));

	const missing = gaps.find((gap) => gap.category === "tool-missing" && gap.id === "create_goal");
	assert.equal(missing.left, "present (muse)");
	assert.equal(missing.right, "absent on pi-muse");

	const schema = gaps.find((gap) => gap.category === "tool-schema");
	assert.equal(schema.left, "30.00%");
	assert.equal(schema.right, "100%");
	assert.match(schema.detail, /schema 30\.00%/);
});

test("deriveGaps reports zero gaps for the parity fixture", () => {
	const { gaps, warnings } = deriveGaps(PARITY);
	assert.deepEqual(gaps, []);
	assert.deepEqual(warnings, []);
});

test("empty gap list writes a complete declaration and never spawns the fixer", async () => {
	const { io, options, deps, calls } = makeHarness({ summaries: [PARITY] });
	const result = await runHarnessRsi(options, deps);
	assert.equal(result.exitCode, 0);
	assert.equal(result.declaration.status, "complete");
	assert.deepEqual(result.declaration.gaps, []);
	assert.deepEqual(result.declaration.remainingGaps, []);
	assert.equal(result.declaration.iterations, 1);
	assert.equal(result.declarationWritten, true);
	assert.equal(calls.parity, 1);
	assert.equal(calls.spawn.length, 0);
	assert.equal(calls.tests, 0);
	assert.ok(io.exists(options.declarationPath));
	const written = JSON.parse(io.readFile(options.declarationPath));
	assert.equal(written.status, "complete");
	assert.ok(written.evidence.paritySummaryPath.endsWith("diff-summary.json"));
});

test("unchanged gaps across iterations escalate the prompt and are recorded in the log", async () => {
	const { io, options, deps, calls } = makeHarness({ summaries: [GAPPY, GAPPY, GAPPY], maxIterations: 3 });
	const result = await runHarnessRsi(options, deps);
	assert.equal(result.exitCode, 2);
	assert.equal(result.declaration.status, "blocked");
	assert.ok(result.declaration.remainingGaps.length > 0);
	assert.equal(result.declaration.escalations, 2);
	assert.equal(calls.spawn.length, 3);
	assert.match(calls.spawn[1].prompt, /ESCALATION/);
	assert.match(calls.spawn[1].prompt, /same approach failed/i);
	assert.doesNotMatch(calls.spawn[0].prompt, /ESCALATION/);
	const iterationTwoLog = io.readFile(join(options.iterationsDir, "iteration-02.log"));
	assert.match(iterationTwoLog, /ESCALATION/);
});

test("iteration cap writes a blocked declaration carrying the remaining gaps", async () => {
	const { options, deps } = makeHarness({ summaries: [GAPPY], maxIterations: 1 });
	const result = await runHarnessRsi(options, deps);
	assert.equal(result.exitCode, 2);
	assert.equal(result.declaration.status, "blocked");
	assert.match(result.declaration.reason, /iteration cap/);
	assert.ok(result.declaration.gaps.length > 0);
	assert.deepEqual(result.declaration.remainingGaps, result.declaration.gaps);
	assert.equal(result.declaration.iterations, 1);
	assert.equal(result.declarationWritten, true);
});

test("dry-run computes gaps but never edits, tests, or leaves the declaration complete", async () => {
	const { options, deps, calls } = makeHarness({ summaries: [GAPPY], maxIterations: 5, dryRun: true });
	const result = await runHarnessRsi(options, deps);
	assert.equal(result.exitCode, 2);
	assert.equal(result.declaration.status, "blocked");
	assert.equal(result.declaration.reason, "dry-run");
	assert.ok(result.declaration.gaps.length > 0);
	assert.equal(calls.spawn.length, 0);
	assert.equal(calls.tests, 0);
	assert.equal(calls.diffs, 0);
	assert.equal(result.declaration.iterations, 1);
});

test("dry-run stays blocked with reason=dry-run even when the gap list is empty", async () => {
	const { options, deps, calls } = makeHarness({ summaries: [PARITY], maxIterations: 3, dryRun: true });
	const result = await runHarnessRsi(options, deps);
	assert.equal(result.exitCode, 2);
	assert.equal(result.declaration.status, "blocked");
	assert.equal(result.declaration.reason, "dry-run");
	assert.deepEqual(result.declaration.gaps, []);
	assert.deepEqual(result.declaration.remainingGaps, []);
	assert.equal(calls.spawn.length, 0);
	assert.equal(calls.tests, 0);
	assert.equal(result.declaration.iterations, 1);
});

test("refuses to report success when the declaration cannot be written", async () => {
	const { io, options, deps } = makeHarness({ summaries: [PARITY] });
	const realWrite = io.writeFile.bind(io);
	io.writeFile = (path, data) => {
		if (path === options.declarationPath) return;
		realWrite(path, data);
	};
	const result = await runHarnessRsi(options, deps);
	assert.equal(result.exitCode, 1);
	assert.equal(result.declarationWritten, false);
	assert.ok(result.error);
	assert.match(String(result.error.message), /declaration/);
	assert.equal(io.exists(options.declarationPath), false);
});

test("refuses to proceed when the only capture predates this invocation", async () => {
	const { options, deps } = makeHarness({ staleCapture: true });
	const result = await runHarnessRsi(options, deps);
	assert.equal(result.exitCode, 1);
	assert.equal(result.declaration.status, "blocked");
	assert.match(result.declaration.reason, /fresh parity capture/);
	assert.equal(result.declarationWritten, true);
});

test("locateFreshCapture proves freshness from the authoritative captureRoot and rejects stale ones", () => {
	const io = createMemoryIo();
	const capturesDir = "/mem/captures";
	io.seedDir(capturesDir);
	io.seedDir("/mem/captures/fresh", Date.parse("2026-01-01T00:00:10.000Z"));
	io.seedFile(
		"/mem/captures/fresh/manifest.json",
		JSON.stringify({ runId: "fresh", fixture: "tool-call", startedAt: "2026-01-01T00:00:10.000Z" }),
		Date.parse("2026-01-01T00:00:10.000Z"),
	);
	io.seedFile("/mem/captures/fresh/diff-summary.json", "[]", Date.parse("2026-01-01T00:00:10.000Z"));

	const invocationStartedAtMs = Date.parse("2026-01-01T00:00:00.000Z");
	const fresh = locateFreshCapture({
		io,
		capturesDir,
		beforeNames: [],
		invocationStartedAtMs,
		paritySummary: { captureRoot: "/mem/captures/fresh" },
		fixture: "tool-call",
	});
	assert.equal(fresh.runId, "fresh");
	assert.equal(fresh.proof.authoritative, true);

	assert.throws(
		() =>
			locateFreshCapture({
				io,
				capturesDir,
				beforeNames: ["fresh"],
				invocationStartedAtMs,
				paritySummary: { captureRoot: "/mem/captures/fresh" },
				fixture: "tool-call",
			}),
		/fresh parity capture/,
	);
	assert.throws(
		() =>
			locateFreshCapture({
				io,
				capturesDir,
				beforeNames: [],
				invocationStartedAtMs: Date.parse("2026-01-02T00:00:00.000Z"),
				paritySummary: null,
				fixture: "tool-call",
			}),
		/fresh parity capture/,
	);
});

test("parseCaptureTimestamp accepts both the harness run-id format and real ISO", () => {
	const expected = Date.parse("2026-09-15T16:47:02.205Z");
	assert.equal(parseCaptureTimestamp("2026-09-15T16-47-02-205Z"), expected);
	assert.equal(parseCaptureTimestamp("2026-09-15T16-47-02-205Z-6788c3ae"), expected);
	assert.equal(parseCaptureTimestamp("2026-01-01T00:00:00.000Z"), Date.parse("2026-01-01T00:00:00.000Z"));
	assert.ok(Number.isNaN(parseCaptureTimestamp("not-a-timestamp")));
	assert.ok(Number.isNaN(parseCaptureTimestamp(undefined)));
});

test("locateFreshCapture accepts the mangled startedAt the harness actually writes", () => {
	const io = createMemoryIo();
	const capturesDir = "/mem/captures";
	io.seedDir(capturesDir);
	io.seedDir("/mem/captures/2026-09-15T16-47-02-205Z-6788c3ae", Date.parse("2026-09-15T16:47:03.000Z"));
	io.seedFile(
		"/mem/captures/2026-09-15T16-47-02-205Z-6788c3ae/manifest.json",
		JSON.stringify({
			runId: "2026-09-15T16-47-02-205Z-6788c3ae",
			fixture: "tool-call",
			startedAt: "2026-09-15T16-47-02-205Z",
		}),
		Date.parse("2026-09-15T16:47:03.000Z"),
	);
	io.seedFile(
		"/mem/captures/2026-09-15T16-47-02-205Z-6788c3ae/diff-summary.json",
		"[]",
		Date.parse("2026-09-15T16:47:03.000Z"),
	);

	const fresh = locateFreshCapture({
		io,
		capturesDir,
		beforeNames: [],
		invocationStartedAtMs: Date.parse("2026-09-15T16:47:00.000Z"),
		paritySummary: { captureRoot: "/mem/captures/2026-09-15T16-47-02-205Z-6788c3ae" },
		fixture: "tool-call",
	});
	assert.equal(fresh.runId, "2026-09-15T16-47-02-205Z-6788c3ae");
});

test("declarationInvariantViolation forbids complete-with-gaps", () => {
	const gap = { category: "leaf", pair: 0, id: "x", left: "a", right: "b" };
	assert.equal(
		declarationInvariantViolation({ status: "complete", gaps: [gap], remainingGaps: [] }),
		"refusing to declare complete while gaps remain",
	);
	assert.equal(
		declarationInvariantViolation({ status: "complete", gaps: [gap], remainingGaps: [gap] }),
		"refusing to declare complete while gaps remain",
	);
	assert.equal(declarationInvariantViolation({ status: "complete", gaps: [], remainingGaps: [] }), null);
	assert.equal(declarationInvariantViolation({ status: "blocked", gaps: [gap], remainingGaps: [gap] }), null);
	assert.equal(
		declarationInvariantViolation({ status: "weird", gaps: [], remainingGaps: [] }),
		'declaration.status must be "complete" or "blocked"',
	);
});

test("fingerprintGaps is stable and sensitive to values", () => {
	const first = deriveGaps(GAPPY).gaps;
	const second = deriveGaps(GAPPY).gaps;
	assert.equal(fingerprintGaps(first), fingerprintGaps(second));
	const mutated = first.map((gap, index) => (index === 0 ? { ...gap, right: "1" } : gap));
	assert.notEqual(fingerprintGaps(first), fingerprintGaps(mutated));
});
