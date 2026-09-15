#!/usr/bin/env node
/**
 * Traffic-interception parity orchestrator.
 *
 * Replay mode (default):
 *   node scripts/muse-proxy/run-parity.mjs --fixture tool-call
 * starts the MITM proxy in `--replay` mode, runs the real `muse` CLI and
 * pi-muse with the same prompt and workspace shape, captures both outbound
 * Responses requests, and diffs them.
 *
 * Live mode:
 *   node scripts/muse-proxy/run-parity.mjs --live --fixture text-completion
 * runs both clients through the proxy in `--forward` mode against the
 * OpenCode Go gateway (`OPENCODE_GO_API_KEY`) and records request+response
 * pairs. In live mode the model text is non-deterministic, so only the request
 * and the behavioral surface (tool-call sequence, tool-result strings, final
 * answer shape) are compared, never the generated text byte-for-byte.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compareRequests, formatReport, normalizeString } from "./diff-requests.mjs";
import {
	assertAllowedPath,
	DEFAULT_CERT_DIR,
	ensureCa,
	ensureDir,
	log,
	parseCliArgs,
	readJsonFile,
	TMP_ROOT,
	writeFileGuarded,
} from "./lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const MODEL = "muse-spark-1.3-contributor";
const PARITY_PROVIDER = "muse-parity";
const OPENCODE_UPSTREAM = "https://opencode.ai";
const OPENCODE_BASE_PATH = "/zen/go";

const { options } = parseCliArgs(process.argv.slice(2), {
	fixture: { type: "string", default: "text-completion" },
	prompt: { type: "string", default: "" },
	live: { type: "boolean", default: false },
	"min-fidelity": { type: "number", default: 0.75 },
	"max-diff-lines": { type: "number", default: 120 },
	"work-dir": { type: "string", default: "" },
	"captures-dir": { type: "string", default: "" },
	"cert-dir": { type: "string", default: DEFAULT_CERT_DIR },
	"ssl-cert-file": { type: "string", default: "" },
	"muse-bin": { type: "string", default: "" },
	only: { type: "string", default: "both" },
	"pi-extra-arg": { type: "array", default: [] },
	"timeout-ms": { type: "number", default: 180000 },
	keep: { type: "boolean", default: false },
	json: { type: "boolean", default: false },
	help: { type: "boolean", default: false },
});

if (options.help) {
	process.stdout.write(
		[
			"usage: node scripts/muse-proxy/run-parity.mjs [--fixture <name|path>] [--live] [options]",
			"",
			"  --fixture <name|path>   text-completion (default) or tool-call, or a fixture path.",
			"  --prompt <text>         Prompt sent to both clients (default from the fixture).",
			"  --live                  Forward to the OpenCode Go gateway instead of replaying.",
			"  --min-fidelity <0..1>   Pass threshold (default 0.75).",
			"  --work-dir <dir>        Scratch dir (default /tmp/opencode/muse-parity-<ts>).",
			"  --captures-dir <dir>    Persisted capture root (default /tmp/opencode/muse-proxy-captures).",
			"  --cert-dir <dir>        CA/leaf storage (default scripts/muse-proxy/.certs).",
			"  --ssl-cert-file <path>  Override the CA file handed to the clients (default ca-bundle.pem).",
			"  --muse-bin <path>       Real Muse CLI (default $MUSE_BIN or `muse` on PATH).",
			"  --only muse|pi|both     Run only one client (default both).",
			"  --pi-extra-arg <arg>    Extra pi-muse arg (repeatable).",
			"  --timeout-ms <n>        Per-client timeout (default 180000).",
			"  --keep                  Keep the scratch dir after the run.",
			"  --json                  Emit a machine-readable summary.",
			"",
		].join("\n"),
	);
	process.exit(0);
}

function resolveFixture(name) {
	const direct = resolve(name);
	if (existsSync(direct)) return direct;
	const withJson = join(HERE, "fixtures", name.endsWith(".json") ? name : `${name}.json`);
	if (existsSync(withJson)) return withJson;
	throw new Error(`fixture not found: ${name}`);
}

function runProcess({ command, args, cwd, env, timeoutMs }) {
	return new Promise((resolveRun) => {
		let stdout = "";
		let stderr = "";
		let child;
		try {
			child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
		} catch (error) {
			resolveRun({ status: "spawn-error", error, stdout, stderr, code: null });
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
			resolveRun({ status: "timeout", stdout, stderr, code: null });
		}, timeoutMs);
		child.on("error", (error) => {
			clearTimeout(timer);
			resolveRun({ status: "spawn-error", error, stdout, stderr, code: null });
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolveRun({ status: "exit", code, stdout, stderr });
		});
	});
}

function readReadyLine(child) {
	return new Promise((resolveReady, rejectReady) => {
		let buffer = "";
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			rejectReady(new Error("proxy did not report readiness in time"));
		}, 20000);
		child.stdout.on("data", (chunk) => {
			buffer += chunk.toString();
			let index = buffer.indexOf("\n");
			while (index !== -1) {
				const line = buffer.slice(0, index).trim();
				buffer = buffer.slice(index + 1);
				index = buffer.indexOf("\n");
				if (!line) continue;
				try {
					const parsed = JSON.parse(line);
					if (parsed?.ok && !settled) {
						settled = true;
						clearTimeout(timer);
						resolveReady(parsed);
					}
				} catch {
					process.stderr.write(`[muse-proxy] proxy stdout: ${line}\n`);
				}
			}
		});
		child.on("exit", (code) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			rejectReady(new Error(`proxy exited before readiness (code ${code})`));
		});
	});
}

function ndjsonEntries(path) {
	if (!existsSync(path)) return [];
	const text = readFileSync(path, "utf8").trim();
	if (!text) return [];
	return text
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			try {
				return JSON.parse(line);
			} catch {
				return undefined;
			}
		})
		.filter(Boolean);
}

function contentToText(content) {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("");
	}
	return "";
}

/**
 * Muse issues auxiliary reminder-observer model calls that embed the main
 * conversation inside a different prompt. The main-agent request is the one
 * whose first user item is exactly the prompt we sent.
 */
function selectMainRequests(entries, prompt) {
	const wanted = prompt.trim();
	return entries.filter((entry) => {
		if (entry.method !== "POST") return false;
		const input = entry.body?.input;
		if (!Array.isArray(input)) return false;
		const firstUser = input.find((item) => item?.role === "user");
		if (!firstUser) return false;
		return contentToText(firstUser.content).trim() === wanted;
	});
}

function normalizeResultText(value) {
	if (value === undefined || value === null) return "";
	if (typeof value === "string") return value;
	if (Array.isArray(value)) return value.map((part) => (typeof part?.text === "string" ? part.text : "")).join("");
	if (typeof value === "object") return typeof value.text === "string" ? value.text : JSON.stringify(value);
	return String(value);
}

/**
 * Read the behavioral surface (tool calls + tool results) out of every captured
 * main-agent request, deduping by call_id so the first request's function_call
 * and the follow-up request's function_call_output are each counted once.
 */
function extractBehavior(entries, cwdPaths = []) {
	const toolCalls = [];
	const toolResults = [];
	const rawToolResults = [];
	const userPrompts = [];
	const seenCalls = new Set();
	const seenResults = new Set();
	const seenPrompts = new Set();
	for (const entry of entries) {
		const input = entry?.body?.input;
		if (!Array.isArray(input)) continue;
		for (const item of input) {
			if (item?.type === "function_call") {
				const args = typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments ?? null);
				const key = item.call_id ?? `${item.name}:${args}`;
				if (seenCalls.has(key)) continue;
				seenCalls.add(key);
				toolCalls.push(`${item.namespace ? `${item.namespace}.` : ""}${item.name}(${args})`);
			} else if (item?.type === "function_call_output") {
				const key = item.call_id ?? `output:${toolResults.length}`;
				if (seenResults.has(key)) continue;
				seenResults.add(key);
				const raw = normalizeResultText(item.output);
				rawToolResults.push(raw);
				toolResults.push(normalizeString(raw, cwdPaths));
			} else if (item?.role === "user" && typeof item.content === "string" && !seenPrompts.has(item.content)) {
				seenPrompts.add(item.content);
				userPrompts.push(item.content);
			}
		}
	}
	return { toolCalls, toolResults, rawToolResults, userPrompts };
}

function extractFinalText(sseText) {
	if (typeof sseText !== "string") return undefined;
	let text = "";
	let sawTerminal = false;
	for (const line of sseText.split("\n")) {
		if (!line.startsWith("data:")) continue;
		const payload = line.slice(5).trim();
		if (!payload || payload === "[DONE]") continue;
		let event;
		try {
			event = JSON.parse(payload);
		} catch {
			continue;
		}
		if (event.type === "response.output_text.done" && typeof event.text === "string") text = event.text;
		if (event.type === "response.completed") {
			sawTerminal = true;
			const message = (event.response?.output ?? []).find((item) => item?.type === "message");
			const part = (message?.content ?? []).find((block) => block?.type === "output_text");
			if (part?.text) text = part.text;
		}
	}
	return { text, sawTerminal };
}

function writeModelsJson(agentDir, baseUrl) {
	const models = {
		providers: {
			[PARITY_PROVIDER]: {
				name: "Muse Parity (proxy)",
				baseUrl,
				api: "openai-responses",
				apiKey: "pi-muse-parity-key",
				models: [
					{
						id: MODEL,
						name: "Muse Spark 1.3 Contributor",
						reasoning: true,
						input: ["text", "image"],
						cost: { input: 0.1, output: 0.2, cacheRead: 0.002, cacheWrite: 0 },
						contextWindow: 1007997,
						maxTokens: 128000,
						thinkingLevelMap: {
							off: null,
							minimal: "minimal",
							low: "low",
							medium: "medium",
							high: "high",
							xhigh: "xhigh",
							max: "max",
						},
						compat: {
							supportsInstructionsField: true,
							toolNamespace: { name: "muse", description: "Muse Code tool set." },
						},
					},
				],
			},
		},
	};
	ensureDir(agentDir);
	writeFileSync(join(agentDir, "models.json"), `${JSON.stringify(models, null, "\t")}\n`);
}

function piRunnerCandidates(prompt) {
	const args = [
		"--model",
		`${PARITY_PROVIDER}/${MODEL}`,
		"--thinking",
		"high",
		"--no-skills",
		"--no-context-files",
		"--no-prompt-templates",
		"--offline",
		// Same posture as the real client's `--yolo`: no approval prompts (there
		// is no UI in headless mode), no sandbox, workspace trusted.
		"--yolo",
		"-p",
		prompt,
		...options["pi-extra-arg"],
	];
	const candidates = [];
	const bundleCli = join(REPO_ROOT, "packages", "coding-agent", "dist", "bundle", "cli.js");
	const tsxBin = join(REPO_ROOT, "node_modules", ".bin", "tsx");
	const sourceCli = join(REPO_ROOT, "packages", "coding-agent", "src", "cli.ts");
	// Prefer the source runner so the capture reflects the working tree (the
	// same technique as scripts/muse-wire-capture.mjs); fall back to the
	// documented bundle entrypoint when concurrent src/ edits break it.
	if (existsSync(tsxBin) && existsSync(sourceCli)) {
		candidates.push({ label: "tsx cli.ts", command: tsxBin, args: [sourceCli, ...args] });
	}
	if (existsSync(bundleCli)) {
		candidates.push({ label: "bundle cli.js", command: process.execPath, args: [bundleCli, ...args] });
	}
	if (candidates.length === 0) {
		throw new Error("no pi-muse runner found (need dist/bundle/cli.js or node_modules/.bin/tsx + src/cli.ts)");
	}
	return candidates;
}

/**
 * Persist everything a run captured so it survives process exit. The scratch
 * work dir is deleted unless `--keep`, which used to take the in-memory request
 * bodies with it. Every path goes through `ensureDir`/`writeFileGuarded`, so
 * the same `assertAllowedPath` guard as the rest of the harness applies.
 */
function persistCaptures(captureRoot, { fixture, museRequests, piRequests, museMain, piMain, diffs, manifest }) {
	const written = {};
	const write = (name, value) => {
		written[name] = writeFileGuarded(join(captureRoot, name), `${JSON.stringify(value, null, "\t")}\n`);
	};
	write("manifest.json", manifest);
	write("diff-summary.json", diffs);
	write("muse-requests.json", museRequests);
	write("pi-requests.json", piRequests);
	write("muse-main-requests.json", museMain);
	write("pi-main-requests.json", piMain);
	if (fixture !== undefined) write("fixture.json", fixture);
	return written;
}

async function main() {
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	const workRoot = ensureDir(assertAllowedPath(options["work-dir"] || join(TMP_ROOT, `muse-parity-${timestamp}`)));
	const capturesRoot = assertAllowedPath(
		options["captures-dir"] || join(TMP_ROOT, "muse-proxy-captures"),
		"captures dir",
	);
	const runId = `${timestamp}-${randomUUID().slice(0, 8)}`;
	const captureRoot = ensureDir(join(capturesRoot, runId));
	const fixturePath = options.live ? undefined : resolveFixture(options.fixture);
	const fixture = fixturePath ? readJsonFile(fixturePath) : undefined;
	const prompt = options.prompt || fixture?.prompt || "Reply with one short sentence describing the parity harness.";
	const logsDir = ensureDir(join(workRoot, "logs"));
	const certDir = ensureCa(options["cert-dir"]);
	const certFile = options["ssl-cert-file"] || certDir.bundlePath;
	const museWorkspace = ensureDir(join(workRoot, "workspace-muse"));
	const piWorkspace = ensureDir(join(workRoot, "workspace-pi"));
	const museConfigRoot = ensureDir(join(workRoot, "muse-xdg-config"));
	const museDataRoot = ensureDir(join(workRoot, "muse-xdg-data"));
	const museTmp = ensureDir(join(workRoot, "muse-tmp"));
	const agentDir = ensureDir(join(workRoot, "pi-agent"));

	ensureDir(join(museConfigRoot, "muse"));
	// Synthetic credentials: replay mode never validates the token, and this
	// keeps the real ~/.config/muse/auth.json out of the harness entirely.
	writeFileSync(
		join(museConfigRoot, "muse", "auth.json"),
		`${JSON.stringify(
			{
				schema_version: 1,
				providers: {
					meta: {
						access_token: "pi-muse-parity-dummy-access",
						api_base_url: "https://api.meta.ai/v1",
						api_key: "pi-muse-parity-dummy-key",
						mechanism: "oauth",
						obtained_via: "device_code",
						user_email: "parity@example.invalid",
						user_full_name: "Parity Harness",
					},
				},
			},
			null,
			"\t",
		)}\n`,
	);
	// The real CLI ignores SSL_CERT_FILE on the model-catalog transport (verified:
	// `tlsv1 alert unknown ca`). It honors `settings.endpoint_transport.ca_bundle`,
	// but that field is validated together with an mTLS identity, so a client
	// cert/key must also be present; the MITM endpoint never requests one.
	writeFileSync(
		join(museConfigRoot, "muse", "settings.json"),
		`${JSON.stringify(
			{
				schema_version: 1,
				endpoint_transport: {
					ca_bundle: certFile,
					client_cert: certDir.certPath,
					client_key: certDir.keyPath,
				},
			},
			null,
			"\t",
		)}\n`,
	);
	writeFileSync(
		join(museConfigRoot, "muse", "trust.json"),
		`${JSON.stringify(
			{
				schema_version: 1,
				projects: {
					[museWorkspace]: { decision: "trusted" },
					[piWorkspace]: { decision: "trusted" },
				},
			},
			null,
			"\t",
		)}\n`,
	);

	const proxyArgs = [join(HERE, "mitm.mjs"), "--log-dir", logsDir, "--cert-dir", options["cert-dir"]];
	if (options.live) {
		const key = process.env.OPENCODE_GO_API_KEY;
		if (!key) throw new Error("--live requires OPENCODE_GO_API_KEY");
		proxyArgs.push(
			"--forward",
			"--upstream",
			OPENCODE_UPSTREAM,
			"--upstream-base-path",
			OPENCODE_BASE_PATH,
			"--auth-bearer",
			key,
			"--header",
			`x-opencode-session:pi-muse-parity-${randomUUID()}`,
		);
	} else {
		proxyArgs.push("--replay", fixturePath, "--catalog", join(HERE, "fixtures", "muse-catalog.json"));
	}

	const proxy = spawn(process.execPath, proxyArgs, { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] });
	let proxyStderr = "";
	proxy.stderr.on("data", (chunk) => {
		proxyStderr += chunk;
	});

	const summary = {
		mode: options.live ? "live" : "replay",
		fixture: fixture?.name ?? null,
		workRoot,
		pairs: [],
		pass: false,
	};
	try {
		const ready = await readReadyLine(proxy);
		log(`proxy ready: CONNECT ${ready.proxyBaseUrl}  TLS ${ready.tlsBaseUrl}`);
		if (!options.live) log(`fixture: ${fixture.name} (${fixture.turns.length} turns) from ${fixturePath}`);
		log(`prompt: ${JSON.stringify(prompt)}`);

		// --- debug: verify CA file exists so the failure mode is explicit ---
		if (!existsSync(certFile)) throw new Error(`CA bundle missing: ${certFile}`);

		// --- real muse CLI ---
		const museBin = options["muse-bin"] || process.env.MUSE_BIN || "muse";
		const museEnv = {
			...process.env,
			MUSE_NO_AUTO_UPDATE: "1",
			HTTPS_PROXY: ready.proxyBaseUrl,
			HTTP_PROXY: ready.proxyBaseUrl,
			ALL_PROXY: ready.proxyBaseUrl,
			https_proxy: ready.proxyBaseUrl,
			http_proxy: ready.proxyBaseUrl,
			all_proxy: ready.proxyBaseUrl,
			MUSE_HTTP_PROXY: ready.proxyBaseUrl,
			NO_PROXY: "",
			SSL_CERT_FILE: certFile,
			META_API_KEY: process.env.META_API_KEY || "pi-muse-parity-dummy-key",
			XDG_CONFIG_HOME: museConfigRoot,
			XDG_DATA_HOME: museDataRoot,
			TMPDIR: museTmp,
		};
		delete museEnv.NODE_EXTRA_CA_CERTS;
		delete museEnv.SSL_CERT_DIR;
		const runMuse = options.only !== "pi";
		const runPi = options.only !== "muse";
		let museResult = { status: "skipped", code: null, stdout: "", stderr: "" };
		let afterMuse = [];
		if (runMuse) {
			log(`running real muse: ${museBin} exec --provider meta --model ${MODEL} (workspace ${museWorkspace})`);
			museResult = await runProcess({
				command: museBin,
				args: [
					"exec",
					"--provider",
					"meta",
					"--model",
					MODEL,
					"--reasoning-effort",
					"high",
					"--workspace",
					museWorkspace,
					"--max-model-steps",
					"8",
					"--json",
					"--yolo",
					prompt,
				],
				cwd: museWorkspace,
				env: museEnv,
				timeoutMs: options["timeout-ms"],
			});
			afterMuse = ndjsonEntries(ready.requestsPath);
			log(
				`muse finished (${museResult.status}${museResult.code !== null ? ` code=${museResult.code}` : ""}); captured ${afterMuse.length} request(s)`,
			);
		}

		// --- pi-muse ---
		let piResult = { status: "skipped", code: null, stdout: "", stderr: "" };
		let piRequests = [];
		let piStderrDetail = "";
		let piRunnerLabel = "skipped";
		if (runPi) {
			writeModelsJson(agentDir, `${ready.tlsBaseUrl}/v1`);
			const piEnv = {
				...process.env,
				PI_CODING_AGENT_DIR: agentDir,
				NODE_EXTRA_CA_CERTS: certFile,
				HTTPS_PROXY: "",
				HTTP_PROXY: "",
				ALL_PROXY: "",
				https_proxy: "",
				http_proxy: "",
				all_proxy: "",
			};
			const attempts = [];
			for (const runner of piRunnerCandidates(prompt)) {
				const before = ndjsonEntries(ready.requestsPath).length;
				log(`running pi-muse: ${runner.label} (workspace ${piWorkspace})`);
				piResult = await runProcess({
					command: runner.command,
					args: runner.args,
					cwd: piWorkspace,
					env: piEnv,
					timeoutMs: options["timeout-ms"],
				});
				piRequests = ndjsonEntries(ready.requestsPath).slice(before);
				log(
					`pi-muse ${runner.label} finished (${piResult.status}${piResult.code !== null ? ` code=${piResult.code}` : ""}); captured ${piRequests.length} request(s)`,
				);
				if (piRequests.length > 0) {
					piRunnerLabel = runner.label;
					break;
				}
				attempts.push(`${runner.label}: ${piResult.status}\n${tail(piResult.stderr, 6)}`);
				log(`pi-muse ${runner.label} produced no request; trying the next runner`);
			}
			if (piRequests.length === 0) piStderrDetail = attempts.join("\n---\n");
		}

		const museRequests = afterMuse;
		const museMain = selectMainRequests(museRequests, prompt);
		const piMain = selectMainRequests(piRequests, prompt);
		log(
			`main-agent requests: muse ${museMain.length}/${museRequests.length}, pi-muse ${piMain.length}/${piRequests.length} (the rest are Muse reminder-observer calls)`,
		);
		const pairCount = Math.min(museMain.length, piMain.length);
		const cwdPaths = [museWorkspace, piWorkspace];
		const comparisons = [];
		for (let i = 0; i < pairCount; i++) {
			const comparison = compareRequests(museMain[i], piMain[i], {
				cwdPaths,
				minFidelity: options["min-fidelity"],
				maxDiffLines: options["max-diff-lines"],
			});
			comparisons.push(comparison);
			summary.pairs.push({
				index: i,
				label: i === 0 ? "first request" : `request ${i + 1}`,
				score: comparison.score,
				leafScore: comparison.leafScore,
				toolScore: comparison.toolScore,
				toolScoreUnion: comparison.toolScoreUnion,
				toolCategories: comparison.toolCategories,
				pass: comparison.pass,
				corePass: comparison.corePass,
			});
			if (!options.json) {
				process.stdout.write(
					`\n===== parity pair ${i} (${i === 0 ? "first" : `post-tool-call #${i}`} request: muse #${museMain[i].seq}, pi-muse #${piMain[i].seq}) =====\n`,
				);
				process.stdout.write(`${formatReport(comparison, { labelA: "muse", labelB: "pi-muse" })}\n`);
			}
		}

		const museBehavior = extractBehavior(museMain, cwdPaths);
		const piBehavior = extractBehavior(piMain, cwdPaths);
		const bothToolCallsEmpty = museBehavior.toolCalls.length === 0 && piBehavior.toolCalls.length === 0;
		// The fixture itself says a tool call was replayed if it declares `toolCall`
		// or has more than one turn. In that case "equal because both empty" is a
		// false pass and must fail loudly.
		const fixtureExpectsToolCall =
			Boolean(fixture?.toolCall) || (Array.isArray(fixture?.turns) && fixture.turns.length > 1);
		const observedToolCall = museBehavior.toolCalls.length > 0 || piBehavior.toolCalls.length > 0;
		const falsePass = fixtureExpectsToolCall && bothToolCallsEmpty;
		const behaviorEqual = {
			toolCalls: JSON.stringify(museBehavior.toolCalls) === JSON.stringify(piBehavior.toolCalls),
			toolResults: JSON.stringify(museBehavior.toolResults) === JSON.stringify(piBehavior.toolResults),
			userPrompts: JSON.stringify(museBehavior.userPrompts) === JSON.stringify(piBehavior.userPrompts),
		};
		const behaviorPass = fixtureExpectsToolCall
			? !bothToolCallsEmpty && behaviorEqual.toolCalls && behaviorEqual.toolResults
			: observedToolCall
				? behaviorEqual.toolCalls && behaviorEqual.toolResults
				: true;
		const responses = ndjsonEntries(ready.responsesPath);
		const finalTexts = responses.map((entry) => extractFinalText(entry.body));
		summary.behavior = {
			expectedToolCall: fixtureExpectsToolCall,
			falsePass,
			behaviorPass,
			equal: behaviorEqual,
			muse: museBehavior,
			piMuse: piBehavior,
		};
		if (!options.json) {
			process.stdout.write("\n===== behavioral surface (main agent) =====\n");
			process.stdout.write(`fixture expects a replayed tool call: ${fixtureExpectsToolCall}\n`);
			if (falsePass) {
				process.stdout.write(
					"FALSE PASS: the fixture declares a tool call but neither client produced one — verdict forced to FAIL\n",
				);
			}
			process.stdout.write(`tool-call sequence equal: ${behaviorEqual.toolCalls}\n`);
			process.stdout.write(`  muse:    ${museBehavior.toolCalls.join(" | ") || "(none)"}\n`);
			process.stdout.write(`  pi-muse: ${piBehavior.toolCalls.join(" | ") || "(none)"}\n`);
			process.stdout.write(`tool-result strings equal (after cwd normalization): ${behaviorEqual.toolResults}\n`);
			process.stdout.write(`  muse:    ${museBehavior.toolResults.join(" | ") || "(none)"}\n`);
			process.stdout.write(`  pi-muse: ${piBehavior.toolResults.join(" | ") || "(none)"}\n`);
			if (!behaviorEqual.toolResults && observedToolCall) {
				process.stdout.write(`  raw muse:    ${museBehavior.rawToolResults.join(" | ") || "(none)"}\n`);
				process.stdout.write(`  raw pi-muse: ${piBehavior.rawToolResults.join(" | ") || "(none)"}\n`);
			}
			process.stdout.write(`behavioral verdict: ${behaviorPass ? "PASS" : "FAIL"}\n`);
			if (options.live) {
				process.stdout.write(`final answer shapes: ${JSON.stringify(finalTexts)}\n`);
			}
		}

		summary.museReachedProxy = museMain.length > 0;
		summary.piMuseReachedProxy = piMain.length > 0;
		summary.museRunner = museBin;
		summary.piRunner = piRunnerLabel;
		summary.pass =
			summary.pairs.length > 0 &&
			summary.pairs.every((pair) => pair.pass) &&
			summary.museReachedProxy &&
			summary.piMuseReachedProxy &&
			behaviorPass;
		if (!summary.museReachedProxy && !options.json) {
			process.stdout.write("\n!!! the real muse CLI produced no main-agent request through the proxy !!!\n");
			process.stdout.write(
				`muse status: ${museResult.status}${museResult.code !== null ? ` code=${museResult.code}` : ""}\n`,
			);
			process.stdout.write(`muse stderr tail:\n${tail(museResult.stderr, 20)}\n`);
		}
		if (!summary.piMuseReachedProxy && !options.json) {
			process.stdout.write("\n!!! pi-muse produced no main-agent request through the proxy !!!\n");
			process.stdout.write(`pi-muse stderr tail:\n${tail(piStderrDetail || piResult.stderr, 20)}\n`);
		}
		if (museMain.length !== piMain.length && !options.json) {
			process.stdout.write(
				`\nnote: main-agent request counts differ (muse ${museMain.length}, pi-muse ${piMain.length}); compared ${pairCount} pair(s)\n`,
			);
		}

		// Persist the full captures (request bodies included) so they survive
		// process exit — the scratch workRoot is deleted unless --keep.
		const captureManifest = {
			runId,
			mode: summary.mode,
			replay: !options.live,
			fixture: fixture?.name ?? null,
			fixturePath: fixturePath ?? null,
			prompt,
			startedAt: timestamp,
			workRoot,
			captureRoot,
			museRunner: museBin,
			piRunner: piRunnerLabel,
			museReachedProxy: summary.museReachedProxy,
			piMuseReachedProxy: summary.piMuseReachedProxy,
			museRequestCount: museRequests.length,
			museMainRequestCount: museMain.length,
			piRequestCount: piRequests.length,
			piMainRequestCount: piMain.length,
			pass: summary.pass,
			corePass: summary.pairs.length > 0 && summary.pairs.every((pair) => pair.corePass),
			pairs: summary.pairs,
			behavior: {
				expectedToolCall: fixtureExpectsToolCall,
				falsePass,
				behaviorPass,
				equal: behaviorEqual,
			},
		};
		const diffSummary = comparisons.map((comparison, index) => ({
			index,
			label: index === 0 ? "first request" : `request ${index + 1}`,
			score: comparison.score,
			leafScore: comparison.leafScore,
			toolScore: comparison.toolScore,
			toolScoreUnion: comparison.toolScoreUnion,
			corePass: comparison.corePass,
			pass: comparison.pass,
			checks: comparison.checks,
			sections: comparison.sections,
			toolCategories: comparison.toolCategories,
			toolOrder: comparison.toolOrder,
			toolGaps: comparison.toolGaps,
			tools: comparison.tools,
			differences: comparison.differences,
			headerDiff: comparison.headerDiff,
			textual: comparison.textual,
			structural: comparison.structural,
		}));
		const capturePaths = persistCaptures(captureRoot, {
			fixture,
			museRequests,
			piRequests,
			museMain,
			piMain,
			diffs: diffSummary,
			manifest: captureManifest,
		});
		summary.captureRoot = captureRoot;
		summary.captureFiles = capturePaths;
		log(`captures persisted to ${captureRoot}`);
		if (!options.json) process.stdout.write(`\ncaptures: ${captureRoot}\n`);

		if (options.json) {
			summary.museStderrTail = tail(museResult.stderr, 20);
			summary.museStdoutTail = tail(museResult.stdout, 40);
			summary.piStderrTail = tail(piResult.stderr, 20);
			summary.piStderrDetail = piStderrDetail;
			summary.piStdoutTail = tail(piResult.stdout, 40);
			process.stdout.write(`${JSON.stringify(summary, null, "\t")}\n`);
		} else {
			process.stdout.write(`\nverdict: ${summary.pass ? "PASS" : "FAIL"}\n`);
		}
	} finally {
		proxy.kill("SIGTERM");
		await new Promise((resolveWait) => setTimeout(resolveWait, 250));
		if (proxy.exitCode === null) proxy.kill("SIGKILL");
		if (proxyStderr.trim() && !options.json)
			process.stderr.write(`[muse-proxy] proxy log tail:\n${tail(proxyStderr, 10)}\n`);
		if (!options.keep) {
			try {
				rmSync(workRoot, { recursive: true, force: true });
			} catch {}
		} else {
			log(`kept work dir: ${workRoot}`);
		}
	}
	process.exitCode = summary.pass ? 0 : 1;
}

function tail(text, lines) {
	return text.trim().split("\n").slice(-lines).join("\n");
}

await main();
