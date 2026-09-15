import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "../core/extensions/types.ts";
import { onShellSessionExit } from "../core/tools/muse.ts";

export const MUSE_PROVIDER_ID = "muse";
export const OPENCODE_GO_PROVIDER_ID = "opencode-go";
export const MUSE_DEFAULT_MODEL_ID = "muse-spark-1.3-contributor";

/**
 * Meta Model API is OpenAI-compatible. The Responses API carries Muse Spark's
 * encrypted reasoning across turns, which the Chat Completions surface does not.
 */
const MUSE_BASE_URL = "https://api.meta.ai/v1";

/**
 * OpenCode Go is an OpenAI-compatible gateway. Muse Spark is only routed over the
 * Responses API there, and the gateway requires an `x-opencode-session` header for
 * request routing (a static per-process value is enough; it is not an auth token).
 */
const OPENCODE_GO_BASE_URL = "https://opencode.ai/zen/go/v1";

interface MuseModelSpec {
	id: string;
	name: string;
	contextWindow: number;
	maxTokens: number;
	supportsMax: boolean;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

const MUSE_MODELS: MuseModelSpec[] = [
	{
		id: "muse-spark-1.3-contributor",
		name: "Muse Spark 1.3 Contributor",
		contextWindow: 1_007_997,
		maxTokens: 32_768,
		supportsMax: true,
		cost: { input: 0.1, output: 0.2, cacheRead: 0.002, cacheWrite: 0 },
	},
	{
		id: "muse-spark-1.2-contributor",
		name: "Muse Spark 1.2 Contributor",
		contextWindow: 1_007_997,
		maxTokens: 32_768,
		supportsMax: false,
		cost: { input: 0.1, output: 0.2, cacheRead: 0.002, cacheWrite: 0 },
	},
];

const OPENCODE_GO_MODELS: MuseModelSpec[] = [
	{
		id: "muse-spark-1.3-contributor",
		name: "Muse Spark 1.3 Contributor",
		contextWindow: 1_048_576,
		maxTokens: 32_768,
		supportsMax: true,
		cost: { input: 0.1, output: 0.2, cacheRead: 0.002, cacheWrite: 0 },
	},
	{
		id: "muse-spark-1.2-contributor",
		name: "Muse Spark 1.2 Contributor",
		contextWindow: 1_048_576,
		maxTokens: 32_768,
		supportsMax: false,
		cost: { input: 0.1, output: 0.2, cacheRead: 0.002, cacheWrite: 0 },
	},
];

function toProviderModels(models: MuseModelSpec[], supportsImages: boolean) {
	return models.map((model) => ({
		id: model.id,
		name: model.name,
		reasoning: true,
		input: (supportsImages ? ["text", "image"] : ["text"]) as ("text" | "image")[],
		thinkingLevelMap: {
			off: null,
			minimal: "minimal",
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "xhigh",
			max: model.supportsMax ? "max" : null,
		},
		cost: model.cost,
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
		compat: {
			supportsInstructionsField: true,
			toolNamespace: { name: "muse", description: "Muse Code tool set." },
		},
	}));
}

export default function museExtension(pi: ExtensionAPI): void {
	pi.registerProvider(MUSE_PROVIDER_ID, {
		name: "Meta Muse",
		baseUrl: MUSE_BASE_URL,
		apiKey: "$META_API_KEY",
		api: "openai-responses",
		models: toProviderModels(MUSE_MODELS, true),
	});

	pi.registerProvider(OPENCODE_GO_PROVIDER_ID, {
		name: "OpenCode Go",
		baseUrl: OPENCODE_GO_BASE_URL,
		apiKey: "$OPENCODE_GO_API_KEY",
		api: "openai-responses",
		headers: { "x-opencode-session": `pi-muse-${randomUUID()}` },
		models: toProviderModels(OPENCODE_GO_MODELS, false),
	});

	onShellSessionExit(({ sessionId, output, exitCode, signal }) => {
		const status =
			exitCode !== null ? `exit_code ${exitCode}` : signal ? `signal ${signal}` : "no exit code recorded";
		const text = `[background bash session ${sessionId} finished (${status})]\n${output}`;
		pi.sendMessage(
			{ customType: "muse_bash_result", content: text, display: false },
			{ deliverAs: "followUp", triggerTurn: true },
		);
	});
}
