#!/usr/bin/env node
/**
 * Extract the live Muse inner tool surface from a persisted parity capture and
 * write two committed fixtures:
 *
 *   tool-names-live.json    the inner tool names, in Muse's exact order
 *   tool-schemas-live.json  { name, description, parameters, strict } per tool
 *
 * Usage:
 *   node scripts/muse-proxy/extract-live-fixtures.mjs \
 *     --capture /tmp/opencode/muse-proxy-captures/<runId>
 *   node scripts/muse-proxy/extract-live-fixtures.mjs \
 *     --capture /tmp/opencode/muse-proxy-captures/<runId>/muse-main-requests.json
 *
 * A capture dir is resolved to `muse-main-requests.json`; a `requests.ndjson`
 * file is parsed line by line. The first request carrying a Responses `namespace`
 * tool group is used. Output defaults to this directory's `fixtures/`.
 *
 * Everything is written through `writeFileGuarded`, so the same
 * `assertAllowedPath` guard as the rest of the harness applies.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertAllowedPath, ensureDir, parseCliArgs, writeFileGuarded } from "./lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

const { options } = parseCliArgs(process.argv.slice(2), {
	capture: { type: "string", default: "" },
	"out-dir": { type: "string", default: "" },
	help: { type: "boolean", default: false },
});

if (options.help || !options.capture) {
	process.stdout.write(
		[
			"usage: node scripts/muse-proxy/extract-live-fixtures.mjs --capture <dir|json|ndjson> [--out-dir <dir>]",
			"",
			"  --capture <path>  A persisted capture dir, a JSON request file, or an NDJSON capture.",
			"  --out-dir <dir>   Fixture output dir (default scripts/muse-proxy/fixtures).",
			"",
		].join("\n"),
	);
	process.exit(options.help ? 0 : 2);
}

function readCapture(path) {
	const direct = resolve(path);
	const target = existsSync(join(direct, "muse-main-requests.json"))
		? join(direct, "muse-main-requests.json")
		: direct;
	const text = readFileSync(target, "utf8").trim();
	if (!text) throw new Error(`capture is empty: ${target}`);
	if (target.endsWith(".ndjson")) {
		return {
			target,
			entries: text
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line)),
		};
	}
	const parsed = JSON.parse(text);
	return { target, entries: Array.isArray(parsed) ? parsed : [parsed] };
}

function requestBody(entry) {
	if (entry && typeof entry === "object" && entry.body && typeof entry.body === "object") return entry.body;
	return entry;
}

/** First Responses `namespace` tool group in the capture. */
function extractTools(entries) {
	for (const entry of entries) {
		const body = requestBody(entry);
		const namespaces = (body?.tools ?? []).filter((tool) => tool?.type === "namespace" && Array.isArray(tool.tools));
		if (namespaces.length > 0) return { namespace: namespaces[0].name ?? null, tools: namespaces[0].tools };
	}
	throw new Error("no namespaced tool list found in the capture");
}

const { target, entries } = readCapture(options.capture);
const { namespace, tools } = extractTools(entries);
if (tools.length === 0) throw new Error(`namespace ${namespace ?? "?"} has no inner tools in ${target}`);

// Exact wire shape: name order preserved, each schema carries exactly the four
// fields Muse sent (type/namespace grouping is carried by tool-names-live.json).
const names = tools.map((tool) => tool?.name ?? null);
const schemas = tools.map((tool) => ({
	name: tool?.name ?? null,
	description: tool?.description ?? null,
	parameters: tool?.parameters ?? null,
	strict: tool?.strict ?? null,
}));

const outDir = ensureDir(assertAllowedPath(options["out-dir"] || join(HERE, "fixtures"), "fixtures dir"));
const namesPath = writeFileGuarded(join(outDir, "tool-names-live.json"), `${JSON.stringify(names, null, "\t")}\n`);
const schemasPath = writeFileGuarded(
	join(outDir, "tool-schemas-live.json"),
	`${JSON.stringify(schemas, null, "\t")}\n`,
);

process.stdout.write(
	`${JSON.stringify(
		{
			capture: target,
			namespace,
			toolCount: names.length,
			outDir,
			files: { "tool-names-live.json": namesPath, "tool-schemas-live.json": schemasPath },
			names,
		},
		null,
		"\t",
	)}\n`,
);
