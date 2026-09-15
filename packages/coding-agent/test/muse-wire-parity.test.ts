/**
 * Deterministic wire-level parity checks against the captured Muse Code 1.2.1 request.
 *
 * The fixtures are snapshots taken from a live Muse Code CLI (model
 * `muse-spark-1.3-contributor`) and are committed under `test/fixtures/muse`:
 *   fixtures/muse/REQUEST_SHAPE.json      - the full captured Responses request
 *   fixtures/muse/TOOLS.json              - the 22 official function tools
 *   fixtures/muse/SYSTEM_PROMPT.runtime.md - the captured runtime system prompt
 *   fixtures/muse/schemas.json            - per-tool argument schemas
 *   fixtures/muse/descriptions.json       - per-tool official descriptions
 *
 * When a fixture is absent the suite skips with an explicit message so the test
 * still passes on a machine without the capture. Every assertion below compares
 * against fixture data, never against a regenerated expectation.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import type { ExtensionAPI, ProviderConfig } from "../src/core/extensions/types.ts";
import { buildMuseDeveloperContext } from "../src/core/muse-context.ts";
import { MUSE_SYSTEM_PROMPT } from "../src/core/muse-system-prompt.ts";
import type { Skill } from "../src/core/skills.ts";
import { buildSystemPrompt } from "../src/core/system-prompt.ts";
import { createMuseToolDefinitions, createMuseTools } from "../src/core/tools/muse.ts";
import museExtension, { MUSE_PROVIDER_ID } from "../src/extensions/muse.ts";
import museSubagentsExtension from "../src/extensions/muse-subagents.ts";

const FIXTURE_DIR = fileURLToPath(new URL("./fixtures/muse", import.meta.url));
const REQUEST_FIXTURE = join(FIXTURE_DIR, "REQUEST_SHAPE.json");
const TOOLS_FIXTURE = join(FIXTURE_DIR, "TOOLS.json");
const SYSTEM_PROMPT_FIXTURE = join(FIXTURE_DIR, "SYSTEM_PROMPT.runtime.md");
const SCHEMAS_FIXTURE = join(FIXTURE_DIR, "schemas.json");
const DESCRIPTIONS_FIXTURE = join(FIXTURE_DIR, "descriptions.json");

/** Workspace root used by the captured session; also the cwd handed to tool factories. */
const CAPTURED_CWD = "/tmp/opencode/muse-work";

/** The captured runtime prompt contains exactly this many `muse.<tool>` references. */
const SYSTEM_PROMPT_MUSE_REFERENCE_COUNT = 25;

/**
 * The restored descriptions must equal the official text exactly, so the
 * coverage ratios are pinned at 1.0: any shortening relative to the capture
 * fails here instead of regressing silently.
 */
const DESCRIPTION_COVERAGE_EXACT = 1;

/** How many of the 22 official tool names pi-muse must keep visible (native + bridged); measured 22. */
const TOOL_COVERAGE_BASELINE = 22;

/** The 14 Muse tools whose descriptions the original fidelity table measured. */
const MIRRORED_TOOL_NAMES = [
	"read_file",
	"write_file",
	"edit_file",
	"search",
	"bash",
	"bash_input",
	"read_memory",
	"add_memory",
	"edit_memory",
	"read_skill",
	"work_status",
	"work_stop",
	"web_search",
	"write_todos",
] as const;

report(`fixtures: ${FIXTURE_DIR}`);

const missingMirrorFixtures = [REQUEST_FIXTURE, TOOLS_FIXTURE, SYSTEM_PROMPT_FIXTURE].filter(
	(path) => !existsSync(path),
);
const hasMirrorFixtures = missingMirrorFixtures.length === 0;
if (!hasMirrorFixtures) {
	report(`SKIP: capture mirror absent; missing ${missingMirrorFixtures.join(", ")}`);
}

interface OfficialTool {
	type: string;
	name: string;
	description: string;
	parameters: {
		type?: string;
		properties?: Record<string, unknown>;
		required?: string[];
	};
	strict?: boolean;
}

interface CapturedRequestShape {
	model: string;
	input: Array<{ role: string; type?: string; content: unknown }>;
	instructions?: string;
	max_output_tokens: number;
	store: boolean;
	tools: Array<{ type: string; name: string; description?: string; tools: OfficialTool[] }>;
	reasoning: { effort: string; summary: string };
	include: string[];
	prompt_cache_key?: string;
	stream: boolean;
}

interface ToolSurface {
	properties: string[];
	required: string[];
}

interface ExposedTool {
	name: string;
	description: string;
	surface: ToolSurface;
	parameters: unknown;
	origin: "native" | "bridged";
}

function report(line: string): void {
	// process.stdout.write survives vitest's `silent: "passed-only"` console patch,
	// so the measured numbers stay visible in the test log.
	process.stdout.write(`[muse-wire-parity] ${line}\n`);
}

function readJson<T>(path: string): T {
	return JSON.parse(readFileSync(path, "utf8")) as T;
}

function readText(path: string): string {
	return readFileSync(path, "utf8");
}

function toLines(text: string): string[] {
	return text.replace(/\r\n/g, "\n").trimEnd().split("\n");
}

function toolSurface(parameters: unknown): ToolSurface {
	const schema = (parameters ?? {}) as { properties?: Record<string, unknown>; required?: unknown };
	return {
		properties: Object.keys(schema.properties ?? {}).sort(),
		required: Array.isArray(schema.required) ? schema.required.map(String).sort() : [],
	};
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Collect every leaf where our parameter schema differs from the official one:
 * scalar mismatches, missing/extra keys, and array element or length differences
 * (so an `anyOf`/`const` chain versus an `enum` counts as a difference).
 */
function schemaDiffLeaves(ours: unknown, official: unknown, path: string, out: string[]): void {
	if (Array.isArray(official) || Array.isArray(ours)) {
		if (!Array.isArray(official) || !Array.isArray(ours)) {
			out.push(`${path}: shape`);
			return;
		}
		const max = Math.max(ours.length, official.length);
		for (let index = 0; index < max; index++) {
			if (index >= ours.length) out.push(`${path}[${index}]: missing`);
			else if (index >= official.length) out.push(`${path}[${index}]: extra`);
			else schemaDiffLeaves(ours[index], official[index], `${path}[${index}]`, out);
		}
		return;
	}
	if (isPlainObject(official) || isPlainObject(ours)) {
		if (!isPlainObject(official) || !isPlainObject(ours)) {
			out.push(`${path}: shape`);
			return;
		}
		const keys = new Set([...Object.keys(ours), ...Object.keys(official)]);
		for (const key of [...keys].sort()) {
			const hasOurs = Object.hasOwn(ours, key);
			const hasOfficial = Object.hasOwn(official, key);
			if (hasOurs && !hasOfficial) out.push(`${path}.${key}: extra`);
			else if (!hasOurs && hasOfficial) out.push(`${path}.${key}: missing`);
			else schemaDiffLeaves(ours[key], official[key], `${path}.${key}`, out);
		}
		return;
	}
	if (JSON.stringify(ours) !== JSON.stringify(official)) out.push(`${path}: differs`);
}

function sumDescriptionChars(tools: ExposedTool[]): number {
	return tools.reduce((total, tool) => total + tool.description.length, 0);
}

function extractSectionSources(text: string): string[] {
	const sources: string[] = [];
	const pattern = /<system-reminder source="([^"]+)"/g;
	for (const match of text.matchAll(pattern)) {
		sources.push(match[1]);
	}
	return sources;
}

function contentToText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((part) => {
				const block = (part ?? {}) as { text?: unknown };
				return typeof block.text === "string" ? block.text : "";
			})
			.join("");
	}
	return "";
}

function nativeTools(): ExposedTool[] {
	const definitions = createMuseToolDefinitions(CAPTURED_CWD);
	return Object.values(definitions).map((definition) => ({
		name: definition.name,
		description: definition.description,
		surface: toolSurface(definition.parameters),
		parameters: definition.parameters,
		origin: "native" as const,
	}));
}

/**
 * The subagent tools are registered at session start by the bridge extension only
 * when the external pi-subagents RPC answers its ping. The mock makes that
 * handshake deterministic, which is what lets the bridge surface be measured.
 */
async function bridgedTools(): Promise<ExposedTool[]> {
	type Handler = (data: unknown) => void;
	const handlers = new Map<string, Set<Handler>>();
	const startHandlers: Array<() => void | Promise<void>> = [];
	const tools: ExposedTool[] = [];

	const emit = (channel: string, data: unknown): void => {
		const params = (data ?? {}) as { requestId?: string };
		if (!params.requestId) return;
		const replyChannel = `${channel}:reply:${params.requestId}`;
		queueMicrotask(() => {
			const reply = channel.endsWith(":ping") ? { success: true, data: { version: 2 } } : { success: true };
			for (const handler of handlers.get(replyChannel) ?? []) handler(reply);
		});
	};

	const api = {
		events: {
			on: (channel: string, handler: Handler) => {
				const set = handlers.get(channel) ?? new Set<Handler>();
				set.add(handler);
				handlers.set(channel, set);
				return () => set.delete(handler);
			},
			emit,
		},
		on: (event: string, handler: () => void | Promise<void>) => {
			if (event === "session_start") startHandlers.push(handler);
		},
		registerTool: (definition: { name: string; description?: string; parameters?: unknown }) => {
			tools.push({
				name: definition.name,
				description: definition.description ?? "",
				surface: toolSurface(definition.parameters),
				parameters: definition.parameters,
				origin: "bridged",
			});
		},
	} as unknown as ExtensionAPI;

	museSubagentsExtension(api);
	for (const handler of startHandlers) await handler();
	return tools;
}

function captureMuseProviders(): Map<string, ProviderConfig> {
	const providers = new Map<string, ProviderConfig>();
	const api = {
		registerProvider: (id: string, config: ProviderConfig) => {
			providers.set(id, config);
		},
	} as unknown as ExtensionAPI;
	museExtension(api);
	return providers;
}

const SSE_COMPLETION_BODY = [
	'data: {"type":"response.completed","sequence_number":1,"response":{"id":"resp_parity","status":"completed","output":[],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2,"input_tokens_details":{"cached_tokens":0}}}}',
	"",
	"data: [DONE]",
	"",
].join("\n");

describe.skipIf(!hasMirrorFixtures)("Muse wire parity against captured Muse Code 1.2.1", () => {
	it("system prompt matches the captured runtime prompt byte-for-byte", () => {
		const fixture = readText(SYSTEM_PROMPT_FIXTURE);
		const museReferences = (MUSE_SYSTEM_PROMPT.match(/muse\./g) ?? []).length;
		const identical = MUSE_SYSTEM_PROMPT === fixture;

		report(
			`system prompt: ${identical ? "byte-identical" : "MISMATCH"} to the capture (${Buffer.byteLength(MUSE_SYSTEM_PROMPT)}/${Buffer.byteLength(fixture)} bytes)`,
		);
		report(`system prompt: ${toLines(MUSE_SYSTEM_PROMPT).length} lines, ${MUSE_SYSTEM_PROMPT.length} chars`);
		report(
			`system prompt: ${museReferences} muse.<tool> references (captured ${SYSTEM_PROMPT_MUSE_REFERENCE_COUNT})`,
		);

		expect(MUSE_SYSTEM_PROMPT).toBe(fixture);
		expect(museReferences).toBe(SYSTEM_PROMPT_MUSE_REFERENCE_COUNT);
		expect(toLines(MUSE_SYSTEM_PROMPT).length).toBeGreaterThan(0);
	});

	it("exposes the official tool argument surface, reports coverage, and never shortens descriptions", async () => {
		const officialTools = readJson<CapturedRequestShape>(REQUEST_FIXTURE).tools[0].tools;
		const officialToolsFixture = readJson<OfficialTool[]>(TOOLS_FIXTURE);
		expect(officialTools).toHaveLength(22);
		expect(officialTools.map((tool) => tool.name).sort()).toEqual(
			officialToolsFixture.map((tool) => tool.name).sort(),
		);

		// Every captured inner tool carries `strict` explicitly (captured value: false).
		for (const tool of officialTools) {
			expect(Object.keys(tool)).toEqual(["type", "name", "description", "parameters", "strict"]);
			expect(tool.strict).toBe(false);
		}
		report(`official inner tools: all ${officialTools.length} carry keys type,name,description,parameters,strict`);

		const native = nativeTools();
		const bridged = await bridgedTools();
		const exposed = [...native, ...bridged];
		const exposedByName = new Map(exposed.map((tool) => [tool.name, tool]));
		const officialByName = new Map(officialTools.map((tool) => [tool.name, tool]));

		// Native Muse tools must match the captured argument surface exactly.
		for (const tool of native) {
			const official = officialByName.get(tool.name);
			expect(official, `native tool ${tool.name} must exist in the captured request`).toBeDefined();
			expect(tool.surface, `tool ${tool.name} argument surface`).toEqual({
				properties: Object.keys(official?.parameters.properties ?? {}).sort(),
				required: [...(official?.parameters.required ?? [])].sort(),
			});
		}

		// Bridged subagent tools carry a deliberately reduced pi-subagents surface; assert
		// they never invent an argument name the official schema does not know.
		for (const tool of bridged) {
			const official = officialByName.get(tool.name);
			expect(official, `bridged tool ${tool.name} must exist in the captured request`).toBeDefined();
			const officialProperties = new Set(Object.keys(official?.parameters.properties ?? {}));
			const unknownProperties = tool.surface.properties.filter((property) => !officialProperties.has(property));
			expect(unknownProperties, `bridged tool ${tool.name} invented arguments`).toEqual([]);
		}

		const visibleOfficialNames = officialTools.map((tool) => tool.name).filter((name) => exposedByName.has(name));
		const missingToolNames = officialTools.map((tool) => tool.name).filter((name) => !exposedByName.has(name));

		report(
			`tool schemas: ${native.length} native tools match the captured argument surface exactly (${native.map((tool) => tool.name).join(", ")})`,
		);
		report(
			`tool schemas: ${bridged.length} bridged subagent tools expose only captured argument names (${bridged.map((tool) => `${tool.name}: ${tool.surface.properties.length} args`).join(", ")})`,
		);
		report(`tool coverage: ${visibleOfficialNames.length}/22 visible (baseline >= ${TOOL_COVERAGE_BASELINE})`);
		report(`tool coverage: missing tools: ${missingToolNames.length > 0 ? missingToolNames.join(", ") : "(none)"}`);
		expect(visibleOfficialNames.length).toBeGreaterThanOrEqual(TOOL_COVERAGE_BASELINE);

		// Tool descriptions: print per-set coverage against the captured official text.
		const mirroredOfficialChars = MIRRORED_TOOL_NAMES.reduce(
			(total, name) => total + (officialByName.get(name)?.description.length ?? 0),
			0,
		);
		const mirroredOurChars = MIRRORED_TOOL_NAMES.reduce(
			(total, name) => total + (exposedByName.get(name)?.description.length ?? 0),
			0,
		);
		const official22Chars = officialTools.reduce((total, tool) => total + tool.description.length, 0);
		const exposedOfficialChars = visibleOfficialNames.reduce(
			(total, name) => total + (officialByName.get(name)?.description.length ?? 0),
			0,
		);
		const ourVisibleChars = visibleOfficialNames.reduce(
			(total, name) => total + (exposedByName.get(name)?.description.length ?? 0),
			0,
		);
		const mirroredRatio = mirroredOfficialChars === 0 ? 0 : mirroredOurChars / mirroredOfficialChars;
		const official22Ratio = official22Chars === 0 ? 0 : ourVisibleChars / official22Chars;
		const exposedRatio = exposedOfficialChars === 0 ? 0 : ourVisibleChars / exposedOfficialChars;

		report(
			`tool descriptions (14 mirrored tools): ${mirroredOurChars}/${mirroredOfficialChars} chars (ratio ${mirroredRatio.toFixed(4)}, exact ${DESCRIPTION_COVERAGE_EXACT})`,
		);
		report(
			`tool descriptions (all 22 official): ${ourVisibleChars}/${official22Chars} chars (ratio ${official22Ratio.toFixed(4)}, exact ${DESCRIPTION_COVERAGE_EXACT})`,
		);
		report(`tool descriptions (visible official subset): ratio ${exposedRatio.toFixed(4)}, exact 1.0`);
		report(
			`tool descriptions: native ${sumDescriptionChars(native)} chars, bridged ${sumDescriptionChars(bridged)} chars`,
		);

		expect(mirroredRatio).toBe(DESCRIPTION_COVERAGE_EXACT);
		expect(official22Ratio).toBe(DESCRIPTION_COVERAGE_EXACT);
		expect(exposedRatio).toBe(DESCRIPTION_COVERAGE_EXACT);

		if (existsSync(SCHEMAS_FIXTURE) && existsSync(DESCRIPTIONS_FIXTURE)) {
			const schemas = readJson<Record<string, OfficialTool>>(SCHEMAS_FIXTURE);
			const descriptions = readJson<Record<string, string>>(DESCRIPTIONS_FIXTURE);
			expect(Object.keys(schemas).sort()).toEqual(officialTools.map((tool) => tool.name).sort());
			expect(Object.keys(descriptions).sort()).toEqual(officialTools.map((tool) => tool.name).sort());
			const refDescriptionChars = Object.values(descriptions).reduce((total, text) => total + text.length, 0);
			expect(refDescriptionChars).toBe(official22Chars);
		} else {
			report("tool schemas: /tmp/opencode/ref cross-check skipped (ref fixtures absent)");
		}
	});

	it.skipIf(!existsSync(SCHEMAS_FIXTURE))("matches every official inner parameter schema leaf-for-leaf", async () => {
		const officialTools = readJson<CapturedRequestShape>(REQUEST_FIXTURE).tools[0].tools;
		const schemas = readJson<Record<string, OfficialTool>>(SCHEMAS_FIXTURE);
		expect(Object.keys(schemas).sort()).toEqual(officialTools.map((tool) => tool.name).sort());

		const oursByName = new Map(
			[...nativeTools(), ...(await bridgedTools())].map((tool) => [tool.name, tool] as const),
		);

		const perTool: Record<string, number> = {};
		let totalLeaves = 0;
		for (const [name, official] of Object.entries(schemas)) {
			const tool = oursByName.get(name);
			expect(tool, `tool ${name} must be exposed`).toBeDefined();
			const leaves: string[] = [];
			schemaDiffLeaves(tool?.parameters, official.parameters, name, leaves);
			perTool[name] = leaves.length;
			totalLeaves += leaves.length;
		}

		report(`parameter schemas: ${Object.keys(schemas).length} tools, ${totalLeaves} differing leaves`);
		for (const [name, count] of Object.entries(perTool)) {
			if (count > 0) report(`parameter schema: ${name} has ${count} differing leaves`);
		}
		expect(totalLeaves).toBe(0);
	});

	it("provider specs produce the captured request parameters", async () => {
		const shape = readJson<CapturedRequestShape>(REQUEST_FIXTURE);
		const providers = captureMuseProviders();
		const provider = providers.get(MUSE_PROVIDER_ID);
		expect(provider?.api).toBe("openai-responses");
		expect(provider?.baseUrl).toBe("https://api.meta.ai/v1");

		const spec = provider?.models?.find((model) => model.id === shape.model);
		expect(spec, `registered muse provider must expose the captured model ${shape.model}`).toBeDefined();
		expect(spec?.reasoning).toBe(true);
		expect(spec?.thinkingLevelMap?.high).toBe("high");
		// The older REQUEST_SHAPE capture recorded a session-specific 32768 cap, while
		// both the model catalog and the live capture send the 128k output cap.
		expect(spec?.maxTokens).toBe(128_000);

		const model: Model<"openai-responses"> = {
			id: spec!.id,
			name: spec!.name,
			api: "openai-responses",
			provider: MUSE_PROVIDER_ID,
			baseUrl: provider?.baseUrl ?? "",
			reasoning: spec!.reasoning,
			input: spec!.input,
			cost: spec!.cost,
			contextWindow: spec!.contextWindow,
			maxTokens: spec!.maxTokens,
			thinkingLevelMap: spec!.thinkingLevelMap,
		};

		let capturedPayload: Record<string, unknown> | undefined;
		const stream = streamSimple(
			model,
			{ messages: [{ role: "user", content: "ping", timestamp: 0 }] },
			{
				apiKey: "parity-test-key",
				reasoning: "high",
				sessionId: "muse-wire-parity",
				onPayload: (params) => {
					capturedPayload = params as Record<string, unknown>;
					return params;
				},
				fetch: async () =>
					new Response(SSE_COMPLETION_BODY, { status: 200, headers: { "content-type": "text/event-stream" } }),
			},
		);
		await stream.result();
		expect(capturedPayload).toBeDefined();

		const payload = capturedPayload!;
		report(
			`request params: model=${String(payload.model)} max_output_tokens=${String(payload.max_output_tokens)} (captured ${shape.max_output_tokens})`,
		);
		report(
			`request params: reasoning=${JSON.stringify(payload.reasoning)} (captured ${JSON.stringify(shape.reasoning)}), include=${JSON.stringify(payload.include)}`,
		);
		report(
			`request params: store=${String(payload.store)} (captured ${shape.store}), stream=${String(payload.stream)} (captured ${shape.stream}), prompt_cache_key=${typeof payload.prompt_cache_key === "string" ? "present" : "absent"}`,
		);

		expect(payload.model).toBe(shape.model);
		expect(payload.max_output_tokens).toBe(128_000);
		expect(payload.reasoning).toEqual(shape.reasoning);
		expect(payload.include).toEqual(shape.include);
		expect(payload.store).toBe(shape.store);
		expect(payload.stream).toBe(shape.stream);
		expect(typeof payload.prompt_cache_key === "string" && payload.prompt_cache_key.length > 0).toBe(true);
	});

	it("encodes developer and user input items in the captured Muse shape", async () => {
		const shape = readJson<CapturedRequestShape>(REQUEST_FIXTURE);
		for (const item of shape.input) {
			expect(item.type).toBe("message");
			expect(typeof item.content).toBe("string");
		}

		const providers = captureMuseProviders();
		const provider = providers.get(MUSE_PROVIDER_ID);
		const spec = provider?.models?.find((model) => model.id === shape.model);
		expect(spec, "registered muse provider must expose the captured model").toBeDefined();

		const model: Model<"openai-responses"> = {
			id: spec!.id,
			name: spec!.name,
			api: "openai-responses",
			provider: MUSE_PROVIDER_ID,
			baseUrl: provider?.baseUrl ?? "",
			reasoning: spec!.reasoning,
			input: spec!.input,
			cost: spec!.cost,
			contextWindow: spec!.contextWindow,
			maxTokens: spec!.maxTokens,
			thinkingLevelMap: spec!.thinkingLevelMap,
			compat: {
				supportsInstructionsField: true,
				toolNamespace: { name: "muse", description: "Muse Code tool set." },
			},
		};

		let capturedPayload: Record<string, unknown> | undefined;
		const stream = streamSimple(
			model,
			{
				instructions: "base system prompt",
				developerContext: "per-session developer context",
				messages: [{ role: "user", content: shape.input[1].content as string, timestamp: 0 }],
			},
			{
				apiKey: "parity-test-key",
				reasoning: "high",
				sessionId: "muse-wire-parity-input-shape",
				onPayload: (params) => {
					capturedPayload = params as Record<string, unknown>;
					return params;
				},
				fetch: async () =>
					new Response(SSE_COMPLETION_BODY, { status: 200, headers: { "content-type": "text/event-stream" } }),
			},
		);
		await stream.result();

		const input = (capturedPayload?.input ?? []) as Array<{ type?: string; role?: string; content: unknown }>;
		expect(input).toHaveLength(shape.input.length);
		expect(input.map((item) => item.type)).toEqual(shape.input.map((item) => item.type));
		for (const item of input) {
			expect(Object.keys(item)).toEqual(["type", "role", "content"]);
		}

		const developer = input.find((item) => item.role === "developer");
		const user = input.find((item) => item.role === "user");
		expect(developer?.type).toBe("message");
		expect(typeof developer?.content).toBe("string");
		expect(user?.type).toBe("message");
		expect(user?.content).toBe(shape.input[1].content);
		expect(Array.isArray(user?.content)).toBe(false);
		report(
			`input shape: developer(type=${String(developer?.type)}, content=${Array.isArray(developer?.content) ? "array" : typeof developer?.content}), user(type=${String(user?.type)}, content=${Array.isArray(user?.content) ? "array" : typeof user?.content})`,
		);
	});

	it("replays an assistant tool call with Muse's dotted name and no namespace field", async () => {
		const providers = captureMuseProviders();
		const provider = providers.get(MUSE_PROVIDER_ID);
		const spec = provider?.models?.find((model) => model.id === "muse-spark-1.3-contributor");
		expect(spec, "registered muse provider must expose the captured model").toBeDefined();

		const model: Model<"openai-responses"> = {
			id: spec!.id,
			name: spec!.name,
			api: "openai-responses",
			provider: MUSE_PROVIDER_ID,
			baseUrl: provider?.baseUrl ?? "",
			reasoning: spec!.reasoning,
			input: spec!.input,
			cost: spec!.cost,
			contextWindow: spec!.contextWindow,
			maxTokens: spec!.maxTokens,
			thinkingLevelMap: spec!.thinkingLevelMap,
			compat: {
				supportsInstructionsField: true,
				toolNamespace: { name: "muse", description: "Muse Code tool set." },
			},
		};

		const assistant: AssistantMessage = {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "call_parity|fc_parity",
					name: "write_file",
					arguments: { path: "parity.txt" },
					namespace: "muse",
				},
			],
			api: "openai-responses",
			provider: MUSE_PROVIDER_ID,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: 0,
		};

		let capturedPayload: Record<string, unknown> | undefined;
		const stream = streamSimple(
			model,
			{ messages: [assistant] },
			{
				apiKey: "parity-test-key",
				reasoning: "high",
				sessionId: "muse-wire-parity-tool-call",
				onPayload: (params) => {
					capturedPayload = params as Record<string, unknown>;
					return params;
				},
				fetch: async () =>
					new Response(SSE_COMPLETION_BODY, { status: 200, headers: { "content-type": "text/event-stream" } }),
			},
		);
		await stream.result();

		const input = (capturedPayload?.input ?? []) as Array<Record<string, unknown>>;
		const functionCall = input.find((item) => item.type === "function_call");
		expect(functionCall).toMatchObject({ type: "function_call", name: "muse.write_file" });
		expect(functionCall).not.toHaveProperty("namespace");
		report(`tool-call item: name=${String(functionCall?.name)}, namespace=${"namespace" in (functionCall ?? {})}`);
	});

	it("emits strict:false on every namespace inner tool through the Muse provider path", async () => {
		const providers = captureMuseProviders();
		const provider = providers.get(MUSE_PROVIDER_ID);
		const spec = provider?.models?.find((model) => model.id === "muse-spark-1.3-contributor");
		expect(spec, "registered muse provider must expose the captured model").toBeDefined();

		const model: Model<"openai-responses"> = {
			id: spec!.id,
			name: spec!.name,
			api: "openai-responses",
			provider: MUSE_PROVIDER_ID,
			baseUrl: provider?.baseUrl ?? "",
			reasoning: spec!.reasoning,
			input: spec!.input,
			cost: spec!.cost,
			contextWindow: spec!.contextWindow,
			maxTokens: spec!.maxTokens,
			thinkingLevelMap: spec!.thinkingLevelMap,
			compat: {
				supportsInstructionsField: true,
				toolNamespace: { name: "muse", description: "Muse Code tool set." },
			},
		};

		const museTools = createMuseTools(CAPTURED_CWD);
		let capturedPayload: Record<string, unknown> | undefined;
		const stream = streamSimple(
			model,
			{ messages: [{ role: "user", content: "ping", timestamp: 0 }], tools: museTools },
			{
				apiKey: "parity-test-key",
				reasoning: "high",
				sessionId: "muse-wire-parity-strict",
				onPayload: (params) => {
					capturedPayload = params as Record<string, unknown>;
					return params;
				},
				fetch: async () =>
					new Response(SSE_COMPLETION_BODY, { status: 200, headers: { "content-type": "text/event-stream" } }),
			},
		);
		await stream.result();

		const namespaceTools = (capturedPayload?.tools ?? []) as Array<{
			type?: string;
			name?: string;
			tools?: Array<Record<string, unknown>>;
		}>;
		expect(namespaceTools).toHaveLength(1);
		expect(namespaceTools[0]?.type).toBe("namespace");
		expect(namespaceTools[0]?.name).toBe("muse");

		const innerTools = namespaceTools[0]?.tools ?? [];
		expect(innerTools).toHaveLength(museTools.length);
		for (const tool of innerTools) {
			expect(Object.keys(tool)).toEqual(["type", "name", "description", "parameters", "strict"]);
			expect(tool.strict).toBe(false);
		}
		report(`namespace strict: ${innerTools.length} inner tools all carry strict:false`);
	});

	it("builds the Muse-harness base prompt exactly equal to the captured instructions", () => {
		const shape = readJson<CapturedRequestShape>(REQUEST_FIXTURE);
		expect(typeof shape.instructions).toBe("string");

		const musePrompt = buildSystemPrompt({
			customPrompt: MUSE_SYSTEM_PROMPT,
			selectedTools: ["read_file", "bash"],
			cwd: CAPTURED_CWD,
			contextFiles: [],
			skills: [],
			museHarness: true,
		});
		const nativePrompt = buildSystemPrompt({
			customPrompt: MUSE_SYSTEM_PROMPT,
			selectedTools: ["read_file", "bash"],
			cwd: CAPTURED_CWD,
			contextFiles: [],
			skills: [],
			museHarness: false,
		});

		report(
			`instructions: muse-harness prompt ${musePrompt.length} chars vs captured ${shape.instructions!.length} chars`,
		);
		expect(musePrompt).toBe(shape.instructions);
		expect(nativePrompt).toBe(`${musePrompt}\nCurrent working directory: ${CAPTURED_CWD}\n`);
	});

	it("developer context carries the captured section sources in the same order", () => {
		const shape = readJson<CapturedRequestShape>(REQUEST_FIXTURE);
		const developerMessage = shape.input.find((message) => message.role === "developer");
		expect(developerMessage, "captured request must contain a developer message").toBeDefined();
		const capturedSources = extractSectionSources(contentToText(developerMessage?.content));
		expect(capturedSources.length).toBeGreaterThan(0);

		const skill: Skill = {
			name: "parity-skill",
			description: "Skill entry used only to exercise the catalog section of the parity test.",
			filePath: join(CAPTURED_CWD, ".pi", "skills", "parity-skill", "SKILL.md"),
			baseDir: join(CAPTURED_CWD, ".pi", "skills", "parity-skill"),
			sourceInfo: {
				path: join(CAPTURED_CWD, ".pi", "skills", "parity-skill", "SKILL.md"),
				source: "parity-test",
				scope: "project",
				origin: "top-level",
			},
			disableModelInvocation: false,
		};

		const developerContext = buildMuseDeveloperContext({
			cwd: CAPTURED_CWD,
			trusted: true,
			skills: [skill],
			subagentsAvailable: true,
			workflowAvailable: true,
		});
		const ourSources = extractSectionSources(developerContext);

		report(`developer context sources: ${ourSources.join(" > ")}`);
		report(
			`developer context: ${ourSources.length}/${capturedSources.length} captured sources present in order (captured: ${capturedSources.join(" > ")})`,
		);

		expect(ourSources).toEqual(capturedSources);
	});
});
