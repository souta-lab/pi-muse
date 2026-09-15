#!/usr/bin/env node
/**
 * Live wire capture for pi-muse.
 *
 * Starts a loopback HTTP server that answers one OpenAI Responses request with a
 * minimal SSE completion, points the real pi-muse CLI at it, sends one trivial
 * user message, and writes the exact outbound request body to
 * ./tmp/pi-muse-outbound.json (relative to the repository root).
 *
 * How pi-muse is pointed at the loopback endpoint without touching source:
 * the CLI has no --base-url flag and packages/ai has no generic base URL env
 * override (only Azure has one). The supported knob is the user-level
 * `models.json`, which may declare a provider with `baseUrl`, `api`, `apiKey`,
 * and models. `provider-composer.ts` gives an extension-registered baseUrl
 * precedence over models.json, so this script declares a separate
 * `muse-capture` provider (api `openai-responses`, same captured model id and
 * limits) rather than trying to override the built-in `muse` provider. The
 * request body is produced by the full pi-muse harness: same system prompt,
 * same Muse tool set, same developer context.
 *
 * The CLI is run from source with tsx when available (so the capture reflects
 * the working tree), falling back to the built bundles under dist/.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT_PATH = join(REPO_ROOT, "tmp", "pi-muse-outbound.json");
const CAPTURE_PROVIDER_ID = "muse-capture";
const CAPTURE_MODEL_ID = "muse-spark-1.3-contributor";
const CAPTURE_USER_MESSAGE = "Say hi in one word.";
const CHILD_TIMEOUT_MS = 120_000;

const log = (message) => console.log(`[muse:capture] ${message}`);

function sseEvent(event) {
	return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

function sseCompletionBody() {
	const message = {
		type: "message",
		id: "msg_capture",
		role: "assistant",
		status: "completed",
		content: [{ type: "output_text", text: "Hi", annotations: [] }],
	};
	const events = [
		{ type: "response.created", response: { id: "resp_capture", status: "in_progress", output: [] } },
		{
			type: "response.output_item.added",
			output_index: 0,
			item: { ...message, status: "in_progress", content: [] },
		},
		{ type: "response.output_text.delta", output_index: 0, item_id: message.id, delta: "Hi" },
		{ type: "response.output_item.done", output_index: 0, item: message },
		{
			type: "response.completed",
			response: {
				id: "resp_capture",
				status: "completed",
				output: [message],
				usage: {
					input_tokens: 1,
					output_tokens: 1,
					total_tokens: 2,
					input_tokens_details: { cached_tokens: 0 },
				},
			},
		},
	];
	return `${events.map(sseEvent).join("")}data: [DONE]\n\n`;
}

function startServer() {
	let captured;
	const server = createServer((request, response) => {
		let body = "";
		request.setEncoding("utf8");
		request.on("data", (chunk) => {
			body += chunk;
		});
		request.on("end", () => {
			log(`received ${request.method} ${request.url} (${body.length} bytes)`);
			if (captured === undefined) {
				try {
					captured = JSON.parse(body);
				} catch (error) {
					captured = { parseError: String(error), rawBody: body };
				}
			}
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.end(sseCompletionBody());
		});
	});
	return new Promise((resolveServer, rejectServer) => {
		server.on("error", rejectServer);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			resolveServer({ server, port: address.port, getCaptured: () => captured });
		});
	});
}

function writeCaptureAgentDir(port) {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-muse-capture-"));
	const models = {
		providers: {
			[CAPTURE_PROVIDER_ID]: {
				name: "Muse Capture",
				baseUrl: `http://127.0.0.1:${port}/v1`,
				api: "openai-responses",
				apiKey: "pi-muse-capture-key",
				models: [
					{
						id: CAPTURE_MODEL_ID,
						name: "Muse Spark 1.3 Contributor",
						reasoning: true,
						input: ["text", "image"],
						cost: { input: 0.1, output: 0.2, cacheRead: 0.002, cacheWrite: 0 },
						contextWindow: 1007997,
						maxTokens: 32768,
						thinkingLevelMap: {
							off: null,
							minimal: "minimal",
							low: "low",
							medium: "medium",
							high: "high",
							xhigh: "xhigh",
							max: "max",
						},
					},
				],
			},
		},
	};
	writeFileSync(join(agentDir, "models.json"), `${JSON.stringify(models, null, "\t")}\n`);
	return agentDir;
}

function cliArgs() {
	return [
		"--model",
		`${CAPTURE_PROVIDER_ID}/${CAPTURE_MODEL_ID}`,
		"--thinking",
		"high",
		"--no-session",
		"--no-skills",
		"--no-context-files",
		"--no-prompt-templates",
		"--offline",
		"-p",
		CAPTURE_USER_MESSAGE,
	];
}

function runnerCandidates() {
	const sourceCli = join(REPO_ROOT, "packages", "coding-agent", "src", "cli.ts");
	const bundleCli = join(REPO_ROOT, "packages", "coding-agent", "dist", "bundle", "cli.js");
	const distCli = join(REPO_ROOT, "packages", "coding-agent", "dist", "cli.js");
	const tsxBin =
		process.platform === "win32"
			? join(REPO_ROOT, "node_modules", ".bin", "tsx.cmd")
			: join(REPO_ROOT, "node_modules", ".bin", "tsx");
	return [
		{
			label: `tsx ${sourceCli.replace(`${REPO_ROOT}/`, "")}`,
			command: tsxBin,
			args: [sourceCli, ...cliArgs()],
			check: tsxBin,
		},
		{
			label: `bundle ${bundleCli.replace(`${REPO_ROOT}/`, "")}`,
			command: process.execPath,
			args: [bundleCli, ...cliArgs()],
			check: bundleCli,
		},
		{
			label: `bundle ${distCli.replace(`${REPO_ROOT}/`, "")}`,
			command: process.execPath,
			args: [distCli, ...cliArgs()],
			check: distCli,
		},
	];
}

function runCandidate(candidate, agentDir) {
	return new Promise((resolveRun) => {
		const child = spawn(candidate.command, candidate.args, {
			cwd: REPO_ROOT,
			env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let output = "";
		child.stdout.on("data", (chunk) => {
			output += chunk;
		});
		child.stderr.on("data", (chunk) => {
			output += chunk;
		});
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			resolveRun({ status: "timeout", output });
		}, CHILD_TIMEOUT_MS);
		child.on("error", (error) => {
			clearTimeout(timer);
			resolveRun({ status: "spawn-error", error, output });
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolveRun({ status: "exit", code, output });
		});
	});
}

function summarize(body) {
	const input = Array.isArray(body.input) ? body.input : [];
	return {
		model: body.model,
		max_output_tokens: body.max_output_tokens,
		reasoning: body.reasoning,
		include: body.include,
		store: body.store,
		stream: body.stream,
		prompt_cache_key: typeof body.prompt_cache_key === "string" ? "present" : "absent",
		instructions_chars: typeof body.instructions === "string" ? body.instructions.length : "absent",
		input_roles: input.map((message) => message.role),
		tools: Array.isArray(body.tools) ? body.tools.length : 0,
	};
}

async function main() {
	const { server, port, getCaptured } = await startServer();
	log(`listening on http://127.0.0.1:${port}/v1 (endpoint: /v1/responses)`);
	const agentDir = writeCaptureAgentDir(port);

	const attempts = [];
	const candidates = runnerCandidates().filter((candidate) => existsSync(candidate.check));
	if (candidates.length === 0) {
		server.close();
		rmSync(agentDir, { recursive: true, force: true });
		console.error(
			[
				"[muse:capture] nothing to run pi-muse with. Missing all of:",
				`  - ${join(REPO_ROOT, "node_modules", ".bin", "tsx")} (with packages/coding-agent/src/cli.ts)`,
				`  - ${join(REPO_ROOT, "packages", "coding-agent", "dist", "bundle", "cli.js")}`,
				`  - ${join(REPO_ROOT, "packages", "coding-agent", "dist", "cli.js")}`,
				"Install dependencies (npm install) or build the coding agent (npm run build) first.",
			].join("\n"),
		);
		process.exitCode = 1;
		return;
	}

	for (const candidate of candidates) {
		log(`running ${candidate.label}`);
		const result = await runCandidate(candidate, agentDir);
		if (getCaptured() !== undefined) {
			log(`${candidate.label} produced a request (status: ${result.status})`);
			break;
		}
		const detail = result.output.trim().split("\n").slice(-8).join("\n");
		attempts.push(`${candidate.label}: ${result.status}${detail ? `\n${detail}` : ""}`);
		log(`${candidate.label} produced no request; trying next runner`);
	}

	const captured = getCaptured();
	server.close();
	rmSync(agentDir, { recursive: true, force: true });

	if (captured === undefined) {
		console.error(
			[
				"[muse:capture] no outbound request was captured. Runner attempts:",
				...attempts.map((attempt) => `  - ${attempt}`),
				"Ensure the models.json capture provider is accepted and the CLI can start offline in print mode.",
			].join("\n"),
		);
		process.exitCode = 1;
		return;
	}

	mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
	const serialized = `${JSON.stringify(captured, null, "\t")}\n`;
	writeFileSync(OUTPUT_PATH, serialized);
	const summary = summarize(captured);
	log(`wrote ${OUTPUT_PATH} (${Buffer.byteLength(serialized)} bytes)`);
	log(`captured: ${JSON.stringify(summary, null, "\t")}`);
}

await main();
