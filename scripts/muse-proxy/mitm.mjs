#!/usr/bin/env node
/**
 * TLS-terminating HTTP CONNECT proxy for Responses-API parity captures.
 *
 *   node scripts/muse-proxy/mitm.mjs --replay scripts/muse-proxy/fixtures/text-completion.json
 *   node scripts/muse-proxy/mitm.mjs --forward --upstream https://opencode.ai \
 *        --upstream-base-path /zen/go --auth-bearer "$OPENCODE_GO_API_KEY" \
 *        --header x-opencode-session:pi-muse-parity-<uuid>
 *
 * Two listeners are started on 127.0.0.1:
 *   - proxyPort: plain HTTP for CONNECT tunneling. A client (the real `muse`
 *     binary) points at it with HTTPS_PROXY and trusts the CA with SSL_CERT_FILE.
 *   - tlsPort:   direct TLS for clients that can simply be pointed at a base URL
 *     (pi-muse, via a throwaway models.json + NODE_EXTRA_CA_CERTS).
 *
 * On CONNECT the proxy mints (or reuses) a leaf certificate for the requested
 * host, terminates TLS, fully buffers the request body, appends it to
 * `<log-dir>/requests.ndjson`, and then either replays a canned SSE fixture or
 * forwards to the real upstream (logging the response).
 *
 * Node built-ins only. The CA is created with the `openssl` CLI by lib.mjs.
 * No system state is modified: no CA-store install, no /etc/hosts, no resolver.
 */
import { randomUUID } from "node:crypto";
import http from "node:http";
import https from "node:https";
import { join } from "node:path";
import tls from "node:tls";
import {
	appendJsonLineGuarded,
	DEFAULT_CERT_DIR,
	ensureCa,
	ensureDir,
	log,
	mintLeafCert,
	parseCliArgs,
	readJsonFile,
	redactHeaders,
	secureContextForHost,
	serializeSse,
	splitHostPort,
	TMP_ROOT,
} from "./lib.mjs";

const MAX_BODY_BYTES = 64 * 1024 * 1024;
const MAX_LOGGED_RESPONSE_BYTES = 4 * 1024 * 1024;

const { options } = parseCliArgs(process.argv.slice(2), {
	mode: { type: "string", default: "" },
	replay: { type: "string", default: "" },
	fixture: { type: "string", default: "" },
	catalog: { type: "string", default: "" },
	forward: { type: "boolean", default: false },
	upstream: { type: "string", default: "https://api.meta.ai" },
	"upstream-base-path": { type: "string", default: "" },
	"auth-bearer": { type: "string", default: "" },
	header: { type: "array", default: [] },
	port: { type: "number", default: 0 },
	"tls-port": { type: "number", default: 0 },
	"cert-dir": { type: "string", default: DEFAULT_CERT_DIR },
	"log-dir": { type: "string", default: join(TMP_ROOT, "muse-proxy-logs") },
	label: { type: "string", default: "proxy" },
	"no-tls": { type: "boolean", default: false },
	quiet: { type: "boolean", default: false },
	help: { type: "boolean", default: false },
});

if (options.help) {
	process.stdout.write(
		[
			"usage: node scripts/muse-proxy/mitm.mjs [--mode replay|forward] [options]",
			"",
			"  --replay <fixture.json>      Serve canned Responses SSE turns (no network).",
			"  --forward                    Proxy to --upstream and log the response.",
			"  --fixture <fixture.json>     Alias for --replay.",
			"  --catalog <catalog.json>     Serve this model list for /muse-code/models (replay mode).",
			"  --upstream <origin>          Upstream origin (default https://api.meta.ai).",
			"  --upstream-base-path <path>  Prefix prepended to the incoming path (e.g. /zen/go).",
			"  --auth-bearer <token>        Replace the upstream Authorization header.",
			"  --header name:value          Extra/override upstream header (repeatable).",
			"  --port <n>                   CONNECT listener port (0 = ephemeral).",
			"  --tls-port <n>               Direct-TLS listener port (0 = ephemeral).",
			"  --cert-dir <dir>             CA/leaf storage (default scripts/muse-proxy/.certs).",
			"  --log-dir <dir>              requests.ndjson / responses.ndjson location.",
			"  --no-tls                     Do not start the direct-TLS listener.",
			"",
		].join("\n"),
	);
	process.exit(0);
}

const fixturePath = options.replay || options.fixture;
const mode = options.forward || options.mode === "forward" ? "forward" : fixturePath ? "replay" : "";
if (!mode) {
	process.stderr.write("mitm: specify --replay <fixture.json> or --forward\n");
	process.exit(2);
}
const fixture = mode === "replay" ? readJsonFile(fixturePath) : undefined;
if (fixture && (!Array.isArray(fixture.turns) || fixture.turns.length === 0)) {
	process.stderr.write(`mitm: ${fixturePath} has no "turns" array\n`);
	process.exit(2);
}
const catalog = options.catalog ? readJsonFile(options.catalog) : undefined;

const upstream = mode === "forward" ? new URL(options.upstream) : undefined;
const upstreamBasePath = (options["upstream-base-path"] || "").replace(/\/+$/, "");
const extraHeaders = {};
for (const raw of options.header) {
	const colon = raw.indexOf(":");
	if (colon === -1) throw new Error(`--header expects name:value, got ${raw}`);
	extraHeaders[raw.slice(0, colon).trim().toLowerCase()] = raw.slice(colon + 1).trim();
}

const logDir = ensureDir(options["log-dir"]);
const requestsPath = join(logDir, "requests.ndjson");
const responsesPath = join(logDir, "responses.ndjson");
const certDir = options["cert-dir"];

ensureCa(certDir);
const defaultLeaf = mintLeafCert("127.0.0.1", certDir);
const contextCache = new Map();
function contextForHost(host) {
	if (!contextCache.has(host)) contextCache.set(host, secureContextForHost(host, certDir));
	return contextCache.get(host);
}

let requestSeq = 0;
/** Per-channel main-agent turn counters: `connect` = real muse, `tls` = pi-muse. */
const mainTurnsByChannel = new Map();
const startedAt = new Date().toISOString();

function contentToText(content) {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) return content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("");
	return "";
}

/**
 * Muse fires auxiliary reminder-observer model calls that embed the main
 * conversation in a different prompt. Only real main-agent requests advance the
 * fixture turn counter; observers always receive the final turn so they can
 * finish without stealing a tool-call turn from the main agent.
 */
function isObserverRequest(entry) {
	const input = entry.body?.input;
	if (!Array.isArray(input)) return false;
	const firstUser = input.find((item) => item?.role === "user");
	const text = contentToText(firstUser?.content).trim();
	return text.startsWith("You are a reminder observer") || text.includes("submit_reminder_decision");
}

function say(message) {
	if (!options.quiet) log(message);
}

function sendJson(res, status, payload) {
	const body = `${JSON.stringify(payload)}\n`;
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": Buffer.byteLength(body),
	});
	res.end(body);
}

function serveReplay(res, entry) {
	const pathname = entry.url.split("?")[0];
	if (catalog && (/\/muse-code\/models$/.test(pathname) || /(^|\/)models$/.test(pathname))) {
		const body = Buffer.from(`${JSON.stringify(catalog)}\n`);
		res.writeHead(200, { "content-type": "application/json", "content-length": body.length });
		res.end(body);
		appendJsonLineGuarded(responsesPath, {
			seq: entry.seq,
			ts: new Date().toISOString(),
			mode,
			status: 200,
			url: entry.url,
			catalog: true,
			models: Array.isArray(catalog.data) ? catalog.data.length : 0,
		});
		say(`replay model catalog -> ${entry.url}`);
		return;
	}
	if (!entry.url.includes("responses")) {
		appendJsonLineGuarded(responsesPath, {
			seq: entry.seq,
			ts: new Date().toISOString(),
			mode,
			status: 404,
			url: entry.url,
		});
		sendJson(res, 404, { error: { message: `muse-proxy replay has no fixture for ${entry.url}` } });
		return;
	}
	const isObserver = isObserverRequest(entry);
	const channel = entry.channel ?? "unknown";
	const served = mainTurnsByChannel.get(channel) ?? 0;
	const turnIndex = isObserver ? fixture.turns.length - 1 : Math.min(served, fixture.turns.length - 1);
	if (!isObserver) mainTurnsByChannel.set(channel, served + 1);
	const turn = fixture.turns[turnIndex];
	const body = serializeSse(turn.events);
	res.writeHead(200, {
		"content-type": "text/event-stream; charset=utf-8",
		"cache-control": "no-cache, no-transform",
		connection: "keep-alive",
		"x-request-id": `req_proxy_${entry.seq}`,
	});
	res.write(body);
	res.end();
	appendJsonLineGuarded(responsesPath, {
		seq: entry.seq,
		ts: new Date().toISOString(),
		mode,
		status: 200,
		url: entry.url,
		channel,
		observer: isObserver,
		fixture: fixture.name,
		turn: turnIndex,
		label: turn.label ?? null,
		events: turn.events.length,
	});
	say(`replay turn ${turnIndex} -> ${entry.url} (${turn.events.length} events)`);
}

function serveForward(req, res, body, entry) {
	const path = `${upstreamBasePath}${entry.url}`;
	const headers = { ...req.headers };
	delete headers.host;
	delete headers["content-length"];
	delete headers["accept-encoding"];
	headers.host = upstream.host;
	headers.connection = "close";
	if (options["auth-bearer"]) headers.authorization = `Bearer ${options["auth-bearer"]}`;
	for (const [name, value] of Object.entries(extraHeaders)) headers[name] = value;

	const upstreamReq = https.request(
		{
			method: entry.method,
			host: upstream.hostname,
			port: upstream.port ? Number(upstream.port) : 443,
			path,
			headers,
		},
		(upstreamRes) => {
			res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
			const chunks = [];
			let bytes = 0;
			upstreamRes.on("data", (chunk) => {
				res.write(chunk);
				bytes += chunk.length;
				if (bytes <= MAX_LOGGED_RESPONSE_BYTES) chunks.push(chunk);
			});
			upstreamRes.on("end", () => {
				res.end();
				const text = Buffer.concat(chunks).toString("utf8");
				appendJsonLineGuarded(responsesPath, {
					seq: entry.seq,
					ts: new Date().toISOString(),
					mode,
					status: upstreamRes.statusCode,
					url: entry.url,
					upstreamUrl: `${upstream.origin}${path}`,
					bytes,
					contentType: upstreamRes.headers["content-type"] ?? null,
					body: text.length <= MAX_LOGGED_RESPONSE_BYTES ? text : undefined,
				});
				say(`forward ${entry.method} ${path} -> ${upstreamRes.statusCode} (${bytes} bytes)`);
			});
		},
	);
	upstreamReq.on("error", (error) => {
		if (!res.headersSent) sendJson(res, 502, { error: { message: `upstream error: ${error.message}` } });
		else res.end();
		appendJsonLineGuarded(responsesPath, {
			seq: entry.seq,
			ts: new Date().toISOString(),
			mode,
			status: 502,
			url: entry.url,
			upstreamUrl: `${upstream.origin}${path}`,
			error: error.message,
		});
		say(`forward ${path} failed: ${error.message}`);
	});
	upstreamReq.end(body);
}

function handleRequest(req, res) {
	const chunks = [];
	let size = 0;
	let aborted = false;
	req.on("data", (chunk) => {
		size += chunk.length;
		if (size > MAX_BODY_BYTES) {
			aborted = true;
			req.destroy();
			return;
		}
		chunks.push(chunk);
	});
	req.on("error", () => {
		if (!res.headersSent) sendJson(res, 400, { error: { message: "request stream error" } });
	});
	req.on("end", () => {
		if (aborted) return;
		const body = Buffer.concat(chunks);
		const text = body.toString("utf8");
		let parsed;
		try {
			parsed = JSON.parse(text);
		} catch {
			parsed = undefined;
		}
		const entry = {
			seq: ++requestSeq,
			ts: new Date().toISOString(),
			mode,
			label: options.label,
			channel: req.socket.__proxyChannel ?? "unknown",
			method: req.method ?? "",
			url: req.url ?? "",
			authority: req.headers.host ?? "",
			httpVersion: req.httpVersion,
			headers: redactHeaders(req.headers),
			bodyBytes: body.length,
			body: parsed,
			bodyRaw: parsed === undefined ? text.slice(0, MAX_LOGGED_RESPONSE_BYTES) : undefined,
		};
		appendJsonLineGuarded(requestsPath, entry);
		say(`${req.method} ${req.url} (${body.length} bytes)`);
		if (mode === "replay") serveReplay(res, entry);
		else serveForward(req, res, body, entry);
	});
}

const app = http.createServer(handleRequest);
const connectServer = http.createServer((_req, res) => {
	sendJson(res, 400, { error: { message: "muse-proxy expects CONNECT for TLS traffic" } });
});

connectServer.on("connect", (req, clientSocket, head) => {
	const { host } = splitHostPort(req.url);
	let context;
	try {
		context = contextForHost(host);
	} catch (error) {
		clientSocket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
		log(`CONNECT ${host} failed: ${error.message}`);
		return;
	}
	clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
	if (head?.length) clientSocket.unshift(head);
	const tlsSocket = new tls.TLSSocket(clientSocket, {
		isServer: true,
		secureContext: context,
		rejectUnauthorized: false,
	});
	tlsSocket.on("secure", () => say(`CONNECT ${host} TLS established (alpn=${tlsSocket.alpnProtocol || "none"})`));
	tlsSocket.on("error", (error) => {
		log(`CONNECT ${host} TLS error: ${error.message}`);
		clientSocket.destroy();
	});
	tlsSocket.on("close", () => say(`CONNECT ${host} closed`));
	tlsSocket.__proxyChannel = "connect";
	app.emit("connection", tlsSocket);
	say(`CONNECT ${req.url} (mode=${mode})`);
});

let tlsServer;
if (!options["no-tls"]) {
	tlsServer = tls.createServer(
		{
			key: defaultLeaf.key,
			cert: defaultLeaf.cert,
			SNICallback: (servername, callback) => {
				try {
					callback(null, contextForHost(servername));
				} catch (error) {
					callback(error);
				}
			},
		},
		(socket) => {
			socket.__proxyChannel = "tls";
			app.emit("connection", socket);
		},
	);
	tlsServer.on("tlsClientError", (error) => say(`TLS client error: ${error.message}`));
}

function shutdown(signal) {
	say(`shutting down (${signal})`);
	try {
		connectServer.close();
	} catch {}
	try {
		tlsServer?.close();
	} catch {}
	try {
		app.close();
	} catch {}
	process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

let pending = tlsServer ? 2 : 1;
function ready(which) {
	pending--;
	if (pending > 0) return;
	process.stdout.write(
		`${JSON.stringify({
			ok: true,
			mode,
			fixture: fixture?.name ?? null,
			proxyPort: connectServer.address().port,
			tlsPort: tlsServer?.address()?.port ?? null,
			logDir,
			requestsPath,
			responsesPath,
			proxyBaseUrl: `http://127.0.0.1:${connectServer.address().port}`,
			tlsBaseUrl: tlsServer ? `https://127.0.0.1:${tlsServer.address().port}` : null,
			startedAt,
			label: options.label,
			session: randomUUID(),
		})}\n`,
	);
	say(`${which} ready`);
}

connectServer.listen(options.port, "127.0.0.1", () => ready("CONNECT listener"));
tlsServer?.listen(options["tls-port"], "127.0.0.1", () => ready("TLS listener"));
