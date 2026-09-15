#!/usr/bin/env node
/**
 * Normalize two captured Responses requests and print a structural + textual
 * diff with a fidelity score.
 *
 *   node scripts/muse-proxy/diff-requests.mjs a.json b.json
 *   node scripts/muse-proxy/diff-requests.mjs requests.ndjson requests.ndjson --a-index 0 --b-index 2
 *
 * Normalization is deliberately explicit and conservative. Fields dropped or
 * blanked, and why:
 *   - `prompt_cache_key`          per-process cache key, never reproducible.
 *   - `id`/`item_id`/`call_id`/…  generated per request; links stay comparable
 *                                 because both sides are blanked the same way.
 *   - `timestamp`/`created_at`/…  wall-clock values.
 *   - workspace root / `cwd`      environment-specific path, replaced with <cwd>.
 *   - home directory              replaced with <home>.
 *   - UUIDs and generated id runs replaced with <uuid> / <id>.
 *   - volatile headers            authorization, cookies, x-opencode-session,
 *                                 traceparent, content-length, host and
 *                                 user-agent (the two clients are different
 *                                 programs, so the raw value carries no parity
 *                                 signal).
 * Everything else — instructions text, developer context, tool schemas, tool
 * results and request parameters — is compared verbatim.
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseCliArgs } from "./lib.mjs";

const DROP_KEYS = new Set(["prompt_cache_key"]);
const ID_KEYS =
	/^(id|item_id|call_id|response_id|request_id|session_id|turn_id|run_id|trace_id|span_id|message_id|tool_use_id)$/i;
const TIMESTAMP_KEYS = /^(timestamp|created_at|updated_at|recorded_at|expires_at|obtained_at|sequence_number)$/i;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const GENERATED_ID_RE = /\b(msg|resp|fc|call|item|run|turn|ses|req|evt|rs)_[A-Za-z0-9-]{6,}\b/g;
const ULID_RE = /\b01[a-z0-9]{20,}\b/g;
const VOLATILE_HEADERS = new Set([
	"authorization",
	"cookie",
	"proxy-authorization",
	"set-cookie",
	"x-api-key",
	"x-opencode-session",
	"x-client-request-id",
	"x-request-id",
	"request-id",
	"traceparent",
	"tracestate",
	"x-meta-ai-gateway-session-id",
	"content-length",
	"connection",
	"host",
	"user-agent",
]);

export function normalizeString(input, cwdPaths = []) {
	let out = input;
	for (const cwd of cwdPaths) {
		if (!cwd) continue;
		out = out.split(cwd).join("<cwd>");
		out = out.replace(new RegExp(escapeRegExp(cwd), "g"), "<cwd>");
	}
	out = out.replace(/\/home\/[^/\\"\s]+/g, "<home>");
	out = out.replace(UUID_RE, "<uuid>");
	out = out.replace(ULID_RE, "<id>");
	out = out.replace(GENERATED_ID_RE, "$1_<id>");
	return out;
}

function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeValue(value, cwdPaths) {
	if (typeof value === "string") return normalizeString(value, cwdPaths);
	if (Array.isArray(value)) return value.map((item) => normalizeValue(item, cwdPaths));
	if (value && typeof value === "object") {
		const out = {};
		for (const [key, child] of Object.entries(value)) {
			if (DROP_KEYS.has(key)) continue;
			if (TIMESTAMP_KEYS.test(key)) {
				out[key] = "<timestamp>";
				continue;
			}
			if (ID_KEYS.test(key)) {
				out[key] = "<id>";
				continue;
			}
			if (key === "cwd" || key === "workspaceRoot" || key === "workspace_root") {
				out[key] = "<cwd>";
				continue;
			}
			// `required` is a set, not an ordered list: sort so a different
			// declaration order does not count as a schema difference.
			if (key === "required" && Array.isArray(child) && child.every((item) => typeof item === "string")) {
				out[key] = [...child].sort();
				continue;
			}
			out[key] = normalizeValue(child, cwdPaths);
		}
		return out;
	}
	return value;
}

export function normalizeHeaders(headers = {}) {
	const out = {};
	for (const [rawKey, rawValue] of Object.entries(headers)) {
		const key = rawKey.toLowerCase();
		if (VOLATILE_HEADERS.has(key)) {
			out[key] = key === "host" ? "<host>" : key === "user-agent" ? "<user-agent>" : "<redacted>";
			continue;
		}
		out[key] = Array.isArray(rawValue) ? rawValue.join(", ") : rawValue;
	}
	return out;
}

/** A proxy NDJSON entry is `{ ..., body }`; a raw request is the body itself. */
export function extractBody(value) {
	if (value && typeof value === "object" && value.body && typeof value.body === "object" && "seq" in value) {
		return value.body;
	}
	return value;
}

export function normalizeRequest(request, { cwdPaths = [] } = {}) {
	const body = extractBody(request);
	const headers =
		request && typeof request === "object" && request.headers ? normalizeHeaders(request.headers) : undefined;
	const normalized = normalizeValue(body, cwdPaths);
	if (headers) normalized.headers = headers;
	// Tool declarations are a set: sort by name so a different declaration order
	// is not scored as a difference. (The model sees an order too, but that is
	// reported separately rather than dominating the fidelity score.)
	if (Array.isArray(normalized.tools)) {
		normalized.tools = [...normalized.tools]
			.sort((a, b) => `${a?.type ?? ""}:${a?.name ?? ""}`.localeCompare(`${b?.type ?? ""}:${b?.name ?? ""}`))
			.map((tool) =>
				Array.isArray(tool?.tools)
					? {
							...tool,
							tools: [...tool.tools].sort((a, b) => String(a?.name ?? "").localeCompare(String(b?.name ?? ""))),
						}
					: tool,
			);
	}
	return normalized;
}

function collectLeaves(value, prefix, out) {
	if (Array.isArray(value)) {
		value.forEach((item, index) => {
			collectLeaves(item, prefix ? `${prefix}.${index}` : String(index), out);
		});
		return out;
	}
	if (value && typeof value === "object") {
		for (const [key, child] of Object.entries(value)) collectLeaves(child, prefix ? `${prefix}.${key}` : key, out);
		return out;
	}
	out.set(prefix, value);
	return out;
}

function flattenTools(tools) {
	const map = new Map();
	for (const tool of Array.isArray(tools) ? tools : []) {
		if (tool?.type === "namespace" && Array.isArray(tool.tools)) {
			for (const inner of tool.tools) map.set(inner.name, { tool: inner, group: tool.name });
		} else if (tool?.name) {
			map.set(tool.name, { tool, group: null });
		}
	}
	return map;
}

/** Leaf-level match counts between two values (an undefined side counts as absent). */
function leafStats(a, b) {
	const leavesA = a === undefined ? new Map() : collectLeaves(a, "", new Map());
	const leavesB = b === undefined ? new Map() : collectLeaves(b, "", new Map());
	const union = new Set([...leavesA.keys(), ...leavesB.keys()]);
	if (union.size === 0) return { matched: 0, total: 0, similarity: 1 };
	let matched = 0;
	for (const path of union) {
		if (leavesA.has(path) && leavesB.has(path) && Object.is(leavesA.get(path), leavesB.get(path))) matched++;
	}
	return { matched, total: union.size, similarity: matched / union.size };
}

function leafDifferences(a, b, limit = 200) {
	const leavesA = a === undefined ? new Map() : collectLeaves(a, "", new Map());
	const leavesB = b === undefined ? new Map() : collectLeaves(b, "", new Map());
	const union = [...new Set([...leavesA.keys(), ...leavesB.keys()])].sort();
	const out = [];
	for (const path of union) {
		const hasA = leavesA.has(path);
		const hasB = leavesB.has(path);
		if (hasA && hasB && Object.is(leavesA.get(path), leavesB.get(path))) continue;
		out.push({
			path,
			left: hasA ? leavesA.get(path) : "<missing>",
			right: hasB ? leavesB.get(path) : "<missing>",
		});
		if (out.length >= limit) break;
	}
	return out;
}

/**
 * Declaration order of every function tool, including the members of a
 * Responses `namespace` group. This is reported separately from the field diff
 * so a different order never shows up as shifted field differences.
 */
function toolOrder(tools) {
	const flat = [];
	const groups = [];
	for (const tool of Array.isArray(tools) ? tools : []) {
		if (tool?.type === "namespace" && Array.isArray(tool.tools)) {
			const inner = tool.tools.map((entry) => entry?.name ?? "?");
			groups.push({ group: tool.name ?? null, tools: inner });
			flat.push(...inner);
		} else if (tool?.name) {
			groups.push({ group: null, tools: [tool.name] });
			flat.push(tool.name);
		}
	}
	return { flat, groups };
}

/** Average per-tool schema similarity; a tool missing on one side scores 0. */
function perToolScore(toolDiff) {
	const tools = toolDiff?.tools ?? [];
	if (tools.length === 0) return 1;
	let sum = 0;
	for (const tool of tools) sum += tool.schemaSimilarity ?? 0;
	return sum / tools.length;
}

const IMPACT_RANK = { high: 0, medium: 1, low: 2 };

function buildToolGaps(tools) {
	const gaps = [];
	for (const tool of tools) {
		if (tool.status !== "both") {
			gaps.push({
				impact: "high",
				kind:
					tool.status === "left-only"
						? "present in muse, missing in pi-muse"
						: "present in pi-muse, missing in muse",
				name: tool.name,
				detail: "",
				similarity: 0,
			});
			continue;
		}
		if (tool.schemaSimilarity >= 1) continue;
		const descriptionFields = tool.fieldDifferences.filter((diff) => diff.path.endsWith(".description"));
		gaps.push({
			impact: tool.schemaSimilarity < 0.5 ? "high" : tool.schemaSimilarity < 0.8 ? "medium" : "low",
			kind: "schema",
			name: tool.name,
			detail: `${(tool.schemaSimilarity * 100).toFixed(0)}% schema; ${descriptionFields.length} description field(s) differ`,
			similarity: tool.schemaSimilarity,
		});
	}
	gaps.sort(
		(a, b) =>
			IMPACT_RANK[a.impact] - IMPACT_RANK[b.impact] || a.similarity - b.similarity || a.name.localeCompare(b.name),
	);
	for (const [index, gap] of gaps.entries()) gap.rank = index + 1;
	return gaps;
}

/**
 * Tools are matched BY NAME in both directions. A tool present on one side and
 * absent on the other is its own category; description/parameters/strict are
 * compared only for tools that exist on both sides.
 */
function compareTools(a, b) {
	const mapA = flattenTools(a?.tools);
	const mapB = flattenTools(b?.tools);
	const names = [...new Set([...mapA.keys(), ...mapB.keys()])].sort();
	const tools = [];
	for (const name of names) {
		const entryA = mapA.get(name);
		const entryB = mapB.get(name);
		if (!entryA || !entryB) {
			tools.push({
				name,
				status: entryA ? "left-only" : "right-only",
				description: { equal: false, leftChars: 0, rightChars: 0, charDelta: 0 },
				schemaStats: leafStats(entryA?.tool, entryB?.tool),
				schemaSimilarity: 0,
				fieldDifferences: leafDifferences(entryA?.tool, entryB?.tool, 20),
				descriptionFields: [],
			});
			continue;
		}
		const propsA = new Set(Object.keys(entryA.tool.parameters?.properties ?? {}));
		const propsB = new Set(Object.keys(entryB.tool.parameters?.properties ?? {}));
		const reqA = new Set(entryA.tool.parameters?.required ?? []);
		const reqB = new Set(entryB.tool.parameters?.required ?? []);
		const descriptionA = entryA.tool.description ?? "";
		const descriptionB = entryB.tool.description ?? "";
		const schemaStats = leafStats(entryA.tool, entryB.tool);
		const fieldDiffs = leafDifferences(entryA.tool, entryB.tool, 60);
		const descriptionFields = fieldDiffs
			.filter((diff) => typeof diff.path === "string" && diff.path.endsWith(".description"))
			.map((diff) => {
				const leftChars = typeof diff.left === "string" ? diff.left.length : String(diff.left).length;
				const rightChars = typeof diff.right === "string" ? diff.right.length : String(diff.right).length;
				return {
					path: diff.path.slice(0, -".description".length),
					leftChars,
					rightChars,
					charDelta: rightChars - leftChars,
				};
			});
		tools.push({
			name,
			status: "both",
			group: { left: entryA.group, right: entryB.group },
			schemaStats,
			schemaSimilarity: schemaStats.similarity,
			description: {
				equal: descriptionA === descriptionB,
				leftChars: descriptionA.length,
				rightChars: descriptionB.length,
				charDelta: descriptionB.length - descriptionA.length,
			},
			strict: {
				left: entryA.tool.strict,
				right: entryB.tool.strict,
				equal: entryA.tool.strict === entryB.tool.strict,
			},
			additionalProperties: {
				left: entryA.tool.parameters?.additionalProperties,
				right: entryB.tool.parameters?.additionalProperties,
				equal:
					JSON.stringify(entryA.tool.parameters?.additionalProperties) ===
					JSON.stringify(entryB.tool.parameters?.additionalProperties),
			},
			properties: {
				equal: [...propsA].sort().join(",") === [...propsB].sort().join(","),
				leftOnly: [...propsA].filter((key) => !propsB.has(key)),
				rightOnly: [...propsB].filter((key) => !propsA.has(key)),
			},
			required: {
				equal: [...reqA].sort().join(",") === [...reqB].sort().join(","),
				leftOnly: [...reqA].filter((key) => !reqB.has(key)),
				rightOnly: [...reqB].filter((key) => !reqA.has(key)),
			},
			fieldDifferences: leafDifferences(entryA.tool, entryB.tool, 60),
			descriptionFields,
		});
	}
	const sameSet = mapA.size === mapB.size && tools.every((tool) => tool.status === "both");
	return { leftCount: mapA.size, rightCount: mapB.size, sameSet, tools, toolGaps: buildToolGaps(tools) };
}

/**
 * Name-keyed tools for the textual diff: index positions are replaced by tool
 * names so a reordered or partially missing tool list cannot produce shifted
 * `tools.0.tools.10`-style noise.
 */
function forTextual(body) {
	if (!Array.isArray(body?.tools)) return body;
	const tools = {};
	const sorted = [...body.tools].sort((a, b) =>
		`${a?.type ?? ""}:${a?.name ?? ""}`.localeCompare(`${b?.type ?? ""}:${b?.name ?? ""}`),
	);
	for (const tool of sorted) {
		if (tool?.type === "namespace" && Array.isArray(tool.tools)) {
			const inner = {};
			for (const entry of [...tool.tools].sort((a, b) =>
				String(a?.name ?? "").localeCompare(String(b?.name ?? "")),
			)) {
				inner[entry?.name ?? "?"] = entry;
			}
			tools[`namespace:${tool.name ?? "?"}`] = { ...tool, tools: inner };
		} else {
			tools[tool?.name ?? `tool:${Object.keys(tools).length}`] = tool;
		}
	}
	return { ...body, tools };
}

const LOOKAHEAD = 96;
function diffLinesGreedy(left, right) {
	const ops = [];
	let i = 0;
	let j = 0;
	while (i < left.length && j < right.length) {
		if (left[i] === right[j]) {
			ops.push({ kind: "equal", line: left[i] });
			i++;
			j++;
			continue;
		}
		let skipLeft = -1;
		let skipRight = -1;
		for (let d = 1; d <= LOOKAHEAD; d++) {
			if (skipLeft === -1 && i + d < left.length && left[i + d] === right[j]) skipLeft = i + d;
			if (skipRight === -1 && j + d < right.length && right[j + d] === left[i]) skipRight = j + d;
			if (skipLeft !== -1 || skipRight !== -1) break;
		}
		if (skipLeft !== -1 && (skipRight === -1 || skipLeft - i <= skipRight - j)) {
			while (i < skipLeft) ops.push({ kind: "remove", line: left[i++] });
		} else if (skipRight !== -1) {
			while (j < skipRight) ops.push({ kind: "add", line: right[j++] });
		} else {
			ops.push({ kind: "remove", line: left[i++] });
		}
	}
	while (i < left.length) ops.push({ kind: "remove", line: left[i++] });
	while (j < right.length) ops.push({ kind: "add", line: right[j++] });
	return ops;
}

function renderDiff(ops, maxLines) {
	const lines = [];
	let emitted = 0;
	// Emit with 2 lines of context around each change.
	for (let index = 0; index < ops.length; index++) {
		if (ops[index].kind === "equal") continue;
		const from = Math.max(0, index - 2);
		const to = Math.min(ops.length, index + 3);
		for (let k = from; k < to; k++) {
			const op = ops[k];
			if (op.kind === "equal") continue;
			const prefix = op.kind === "remove" ? "- " : "+ ";
			if (emitted >= maxLines) {
				lines.push(`… diff truncated after ${maxLines} changed lines`);
				return lines;
			}
			lines.push(`${prefix}${op.line}`);
			emitted++;
		}
		index = to - 1;
	}
	return lines;
}

function isObject(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function compareRequests(requestA, requestB, opts = {}) {
	const cwdPaths = opts.cwdPaths ?? [];
	const minFidelity = opts.minFidelity ?? 0.75;
	const maxDiffLines = opts.maxDiffLines ?? 120;
	const normA = normalizeRequest(requestA, { cwdPaths });
	const normB = normalizeRequest(requestB, { cwdPaths });
	const { headers: headersA, ...bodyA } = normA;
	const { headers: headersB, ...bodyB } = normB;

	// Declaration order comes from the raw (pre-sort) tools array.
	const rawOrderA = toolOrder(extractBody(requestA)?.tools);
	const rawOrderB = toolOrder(extractBody(requestB)?.tools);
	const toolOrderDiff = {
		left: rawOrderA.flat,
		right: rawOrderB.flat,
		equal: JSON.stringify(rawOrderA.flat) === JSON.stringify(rawOrderB.flat),
		groups: { left: rawOrderA.groups, right: rawOrderB.groups },
	};

	const isToolPath = (path) => path === "tools" || path.startsWith("tools.");
	const leavesA = collectLeaves(bodyA, "", new Map());
	const leavesB = collectLeaves(bodyB, "", new Map());
	const allPaths = [...new Set([...leavesA.keys(), ...leavesB.keys()])].sort();
	const contentPaths = allPaths.filter((path) => !isToolPath(path));

	const inputRoles = (normalized, index) => {
		const item = normalized?.input?.[index];
		if (!isObject(item)) return "other";
		if (item.role === "developer") return "developer";
		if (item.role === "user") return "user";
		if (item.type === "function_call_output" || item.role === "tool") return "toolResult";
		return "other";
	};
	const sectionOf = (path) => {
		if (path.startsWith("headers")) return "headers";
		if (path.startsWith("instructions")) return "instructions";
		if (path.startsWith("tools")) return "tools";
		const match = /^input\.(\d+)/.exec(path);
		if (match) {
			const index = Number(match[1]);
			const role = inputRoles(normA, index) !== "other" ? inputRoles(normA, index) : inputRoles(normB, index);
			if (role === "developer") return "input.developer";
			if (role === "user") return "input.user";
			if (role === "toolResult") return "input.toolResult";
			return "input.other";
		}
		return "params";
	};

	const sectionStats = new Map();
	let baseMatched = 0;
	const differences = [];
	for (const path of contentPaths) {
		const hasA = leavesA.has(path);
		const hasB = leavesB.has(path);
		const same = hasA && hasB && Object.is(leavesA.get(path), leavesB.get(path));
		if (same) baseMatched++;
		else if (differences.length < 400) {
			differences.push({
				path,
				left: hasA ? leavesA.get(path) : "<missing>",
				right: hasB ? leavesB.get(path) : "<missing>",
			});
		}
		const section = sectionOf(path);
		const stats = sectionStats.get(section) ?? { matched: 0, total: 0 };
		stats.total++;
		if (same) stats.matched++;
		sectionStats.set(section, stats);
	}

	const tools = compareTools(normA, normB);
	const toolScore = perToolScore(tools);
	let toolMatched = 0;
	let toolTotal = 0;
	for (const tool of tools.tools) {
		toolMatched += tool.schemaStats.matched;
		toolTotal += tool.schemaStats.total;
	}
	sectionStats.set("tools", { matched: toolMatched, total: toolTotal });
	// Tool differences are reported by name, never by array index.
	for (const tool of tools.tools) {
		if (differences.length >= 400) break;
		if (tool.status !== "both") {
			differences.push({
				path: `tools.${tool.name}`,
				left: tool.status === "left-only" ? "<present>" : "<missing>",
				right: tool.status === "left-only" ? "<missing>" : "<present>",
			});
			continue;
		}
		if (!tool.description.equal) {
			differences.push({
				path: `tools.${tool.name}.description`,
				left: `${tool.description.leftChars} chars`,
				right: `${tool.description.rightChars} chars`,
			});
		}
		for (const fieldDiff of tool.fieldDifferences) {
			if (differences.length >= 400) break;
			differences.push({
				path: `tools.${tool.name}.${fieldDiff.path}`,
				left: fieldDiff.left,
				right: fieldDiff.right,
			});
		}
	}

	const matched = baseMatched + toolMatched;
	const totalLeaves = contentPaths.length + toolTotal;
	const leafScore = totalLeaves === 0 ? 1 : matched / totalLeaves;
	const sections = [...sectionStats.entries()]
		.map(([name, stats]) => ({
			name,
			score: stats.total ? stats.matched / stats.total : 1,
			...(name === "tools" ? { perToolScore: toolScore } : {}),
			...stats,
		}))
		.sort((a, b) => a.name.localeCompare(b.name));

	// Headers are reported separately and never scored: the two clients use
	// different HTTP stacks (Rust hyper vs the Stainless OpenAI SDK), so header
	// names/values can never match and would only muddy the body fidelity.
	const headerLeavesA = collectLeaves(headersA ?? {}, "", new Map());
	const headerLeavesB = collectLeaves(headersB ?? {}, "", new Map());
	const headerPaths = [...new Set([...headerLeavesA.keys(), ...headerLeavesB.keys()])].sort();
	let headerMatched = 0;
	const headerDifferences = [];
	for (const path of headerPaths) {
		const hasA = headerLeavesA.has(path);
		const hasB = headerLeavesB.has(path);
		const same = hasA && hasB && Object.is(headerLeavesA.get(path), headerLeavesB.get(path));
		if (same) headerMatched++;
		else {
			headerDifferences.push({
				header: path,
				left: hasA ? headerLeavesA.get(path) : "<missing>",
				right: hasB ? headerLeavesB.get(path) : "<missing>",
			});
		}
	}
	const headerDiff = {
		matched: headerMatched,
		total: headerPaths.length,
		score: headerPaths.length === 0 ? 1 : headerMatched / headerPaths.length,
		differences: headerDifferences,
	};

	const prettyA = JSON.stringify(forTextual(bodyA), null, 2).split("\n");
	const prettyB = JSON.stringify(forTextual(bodyB), null, 2).split("\n");
	const ops = diffLinesGreedy(prettyA, prettyB);
	const equalLines = ops.filter((op) => op.kind === "equal").length;
	const removedLines = ops.filter((op) => op.kind === "remove").length;
	const addedLines = ops.filter((op) => op.kind === "add").length;
	const textual = {
		leftLines: prettyA.length,
		rightLines: prettyB.length,
		equalLines,
		removedLines,
		addedLines,
		similarity:
			Math.max(prettyA.length, prettyB.length) === 0 ? 1 : equalLines / Math.max(prettyA.length, prettyB.length),
		lines: renderDiff(ops, maxDiffLines),
	};

	const inputRolesA = (normA.input ?? []).map((_, index) => inputRoles(normA, index));
	const inputRolesB = (normB.input ?? []).map((_, index) => inputRoles(normB, index));
	const structural = {
		topLevelKeys: {
			left: Object.keys(normA).sort(),
			right: Object.keys(normB).sort(),
		},
		inputCount: { left: inputRolesA.length, right: inputRolesB.length },
		inputRoles: { left: inputRolesA, right: inputRolesB },
		instructionsChars: {
			left: typeof normA.instructions === "string" ? normA.instructions.length : 0,
			right: typeof normB.instructions === "string" ? normB.instructions.length : 0,
		},
	};
	// Weighted fidelity is the primary score: a strict leaf score is dominated
	// by verbose JSON Schema leaves, so a single wrong keyword in one tool can
	// drown out otherwise-identical tools. Tools are scored per tool and each
	// model-facing section gets an explicit weight.
	const SECTION_WEIGHTS = {
		params: 0.2,
		instructions: 0.2,
		"input.developer": 0.15,
		"input.user": 0.15,
		"input.toolResult": 0.05,
		"input.other": 0.05,
		tools: 0.25,
	};
	const sectionScoreByName = new Map(sections.map((section) => [section.name, section.score]));
	sectionScoreByName.set("tools", toolScore);
	let weightSum = 0;
	let weightedSum = 0;
	for (const [name, weight] of Object.entries(SECTION_WEIGHTS)) {
		weightSum += weight;
		weightedSum += weight * (sectionScoreByName.get(name) ?? 0);
	}
	const score = weightSum === 0 ? 1 : weightedSum / weightSum;

	const isEqual = (key) => JSON.stringify(normA[key]) === JSON.stringify(normB[key]);
	const checks = [
		{ name: "model", pass: isEqual("model"), left: normA.model, right: normB.model },
		{
			name: "max_output_tokens",
			pass: isEqual("max_output_tokens"),
			left: normA.max_output_tokens,
			right: normB.max_output_tokens,
		},
		{ name: "store", pass: isEqual("store"), left: normA.store, right: normB.store },
		{ name: "stream", pass: isEqual("stream"), left: normA.stream, right: normB.stream },
		{ name: "reasoning", pass: isEqual("reasoning"), left: normA.reasoning, right: normB.reasoning },
		{ name: "include", pass: isEqual("include"), left: normA.include, right: normB.include },
		{
			name: "input item count",
			pass: inputRolesA.length === inputRolesB.length,
			left: inputRolesA.length,
			right: inputRolesB.length,
		},
		{
			name: "no invented tools",
			pass: tools.tools.every((tool) => tool.status !== "right-only"),
			left: tools.leftCount,
			right: tools.rightCount,
		},
	];
	const corePass = checks.every((check) => check.pass);
	return {
		score,
		leafScore,
		toolScore,
		matchedLeaves: matched,
		totalLeaves,
		minFidelity,
		corePass,
		pass: score >= minFidelity,
		sections,
		differences,
		structural,
		tools,
		toolGaps: tools.toolGaps,
		toolOrder: toolOrderDiff,
		textual,
		headerDiff,
		checks,
	};
}

function formatReport(result, { labelA = "left", labelB = "right" } = {}) {
	const lines = [];
	lines.push(
		`fidelity (weighted): ${(result.score * 100).toFixed(2)}%   strict-leaf: ${(result.leafScore * 100).toFixed(2)}%   tools(per-tool avg): ${(result.toolScore * 100).toFixed(2)}%`,
	);
	lines.push(
		`threshold: ${(result.minFidelity * 100).toFixed(0)}%  core checks: ${result.corePass ? "pass" : "FAIL"}  verdict: ${result.pass ? "PASS" : "FAIL"}`,
	);
	lines.push("");
	lines.push("section fidelity:");
	for (const section of result.sections) {
		const suffix =
			section.name === "tools" && section.perToolScore !== undefined
				? `   [gap-inclusive per-tool avg ${(section.perToolScore * 100).toFixed(2)}%]`
				: "";
		lines.push(
			`  ${section.name.padEnd(18)} ${(section.score * 100).toFixed(2).padStart(7)}%  (${section.matched}/${section.total})${suffix}`,
		);
	}
	lines.push("");
	lines.push("tool order (declaration order; reported separately, not scored):");
	lines.push(`  ${labelA}: ${result.toolOrder.left.join(", ") || "(none)"}`);
	lines.push(`  ${labelB}: ${result.toolOrder.right.join(", ") || "(none)"}`);
	lines.push(`  identical order: ${result.toolOrder.equal}`);
	lines.push("");
	lines.push("structural:");
	lines.push(`  input roles ${labelA}: ${result.structural.inputRoles.left.join(", ") || "(none)"}`);
	lines.push(`  input roles ${labelB}: ${result.structural.inputRoles.right.join(", ") || "(none)"}`);
	lines.push(
		`  instructions chars ${labelA}=${result.structural.instructionsChars.left} ${labelB}=${result.structural.instructionsChars.right}`,
	);
	lines.push("");
	lines.push("core checks:");
	for (const check of result.checks) {
		lines.push(`  ${check.pass ? "ok  " : "FAIL"} ${check.name}`);
	}
	lines.push("");
	lines.push(
		`tools: ${result.tools.leftCount} ${labelA} vs ${result.tools.rightCount} ${labelB}; identical set: ${result.tools.sameSet}`,
	);
	for (const tool of result.tools.tools) {
		if (tool.status !== "both") {
			lines.push(`  [${tool.status}] ${tool.name}`);
			continue;
		}
		const flags = [];
		if (tool.schemaSimilarity < 1) flags.push(`schema ${(tool.schemaSimilarity * 100).toFixed(0)}%`);
		if (!tool.description.equal)
			flags.push(`description ${tool.description.charDelta >= 0 ? "+" : ""}${tool.description.charDelta} chars`);
		if (tool.strict && !tool.strict.equal)
			flags.push(`strict ${JSON.stringify(tool.strict.left)} -> ${JSON.stringify(tool.strict.right)}`);
		if (tool.additionalProperties && !tool.additionalProperties.equal)
			flags.push(
				`additionalProperties ${JSON.stringify(tool.additionalProperties.left)} -> ${JSON.stringify(tool.additionalProperties.right)}`,
			);
		if (!tool.properties.equal)
			flags.push(`properties -[${tool.properties.leftOnly.join(",")}] +[${tool.properties.rightOnly.join(",")}]`);
		if (!tool.required.equal)
			flags.push(`required -[${tool.required.leftOnly.join(",")}] +[${tool.required.rightOnly.join(",")}]`);
		lines.push(`  ${tool.name}${flags.length === 0 ? ": identical" : `: ${flags.join("; ")}`}`);
	}
	lines.push("");
	const descriptionFieldLines = [];
	for (const tool of result.tools.tools) {
		if (tool.status !== "both") continue;
		if (!tool.description.equal) {
			descriptionFieldLines.push(
				`  ${tool.name}.description: ${tool.description.leftChars} -> ${tool.description.rightChars} chars (${signed(tool.description.charDelta)})`,
			);
		}
		for (const field of tool.descriptionFields ?? []) {
			descriptionFieldLines.push(
				`  ${tool.name}.${field.path}.description: ${field.leftChars} -> ${field.rightChars} chars (${signed(field.charDelta)})`,
			);
		}
	}
	lines.push(`tool description differences (${descriptionFieldLines.length} field(s)):`);
	if (descriptionFieldLines.length === 0) lines.push("  (none)");
	else lines.push(...descriptionFieldLines);
	lines.push("");
	lines.push(`tool gaps ranked by model-visible impact (${result.toolGaps.length}):`);
	if (result.toolGaps.length === 0) {
		lines.push("  (none)");
	} else {
		for (const gap of result.toolGaps) {
			lines.push(
				`  ${String(gap.rank).padStart(2)}. [${gap.impact}] ${gap.name}: ${gap.kind}${gap.detail ? ` — ${gap.detail}` : ""}`,
			);
		}
	}
	lines.push("");
	lines.push(
		`headers (reported, not scored): ${(result.headerDiff.score * 100).toFixed(1)}% match (${result.headerDiff.matched}/${result.headerDiff.total})`,
	);
	for (const diff of result.headerDiff.differences.slice(0, 20)) {
		lines.push(`  ${diff.header}: ${truncate(diff.left)} -> ${truncate(diff.right)}`);
	}
	if (result.headerDiff.differences.length > 20) {
		lines.push(`  … ${result.headerDiff.differences.length - 20} more header differences`);
	}
	lines.push("");
	lines.push(
		`textual diff (body only): ${result.textual.equalLines} equal lines, -${result.textual.removedLines}, +${result.textual.addedLines} (line similarity ${(result.textual.similarity * 100).toFixed(2)}%)`,
	);
	for (const line of result.textual.lines) lines.push(`  ${line}`);
	if (result.differences.length > 0) {
		lines.push("");
		lines.push(`first differing leaves (${result.differences.length} shown):`);
		for (const diff of result.differences.slice(0, 40))
			lines.push(`  ${diff.path}: ${truncate(diff.left)} -> ${truncate(diff.right)}`);
	} else {
		lines.push("");
		lines.push("no differing leaves after normalization");
	}
	return lines.join("\n");
}

function signed(value) {
	return value >= 0 ? `+${value}` : `${value}`;
}

function truncate(value) {
	const text = typeof value === "string" ? value : JSON.stringify(value);
	if (text.length <= 120) return text;
	return `${text.slice(0, 117)}...`;
}

function readInput(path, index) {
	const text = readFileSync(path, "utf8").trim();
	if (index !== undefined) {
		const lineEntries = text.split("\n").filter(Boolean);
		if (index < 0 || index >= lineEntries.length) throw new Error(`${path} has no line ${index}`);
		return JSON.parse(lineEntries[index]);
	}
	try {
		return JSON.parse(text);
	} catch {
		const lineEntries = text.split("\n").filter(Boolean);
		if (lineEntries.length > 0) return JSON.parse(lineEntries[0]);
		throw new Error(`could not parse ${path}`);
	}
}

async function main() {
	const { options, positional } = parseCliArgs(process.argv.slice(2), {
		"a-index": { type: "number" },
		"b-index": { type: "number" },
		cwd: { type: "array", default: [] },
		"min-fidelity": { type: "number", default: 0.75 },
		"max-diff-lines": { type: "number", default: 120 },
		json: { type: "boolean", default: false },
		help: { type: "boolean", default: false },
	});
	if (options.help || positional.length < 2) {
		process.stdout.write(
			[
				"usage: node scripts/muse-proxy/diff-requests.mjs <a.json> <b.json> [options]",
				"",
				"  --a-index <n> / --b-index <n>  pick a line from an NDJSON capture",
				"  --cwd <path>                   workspace root to normalize (repeatable)",
				"  --min-fidelity <0..1>          pass threshold (default 0.75)",
				"  --max-diff-lines <n>           textual diff line budget (default 120)",
				"  --json                         emit the raw result as JSON",
				"",
			].join("\n"),
		);
		process.exit(positional.length < 2 ? 2 : 0);
	}
	const a = readInput(positional[0], options["a-index"]);
	const b = readInput(positional[1], options["b-index"]);
	const result = compareRequests(a, b, {
		cwdPaths: options.cwd,
		minFidelity: options["min-fidelity"],
		maxDiffLines: options["max-diff-lines"],
	});
	if (options.json) {
		process.stdout.write(`${JSON.stringify(result, null, "\t")}\n`);
	} else {
		process.stdout.write(`${formatReport(result)}\n`);
	}
	process.exitCode = result.pass ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	await main();
}

export { formatReport, readInput };
