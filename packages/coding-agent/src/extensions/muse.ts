import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "../core/extensions/types.ts";
import { onShellSessionExit } from "../core/tools/muse.ts";

export const MUSE_PROVIDER_ID = "muse";
export const OPENCODE_GO_PROVIDER_ID = "opencode-go";

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

const MUSE_MODELS = [
	{ id: "muse-spark-1.3", name: "Muse Spark 1.3" },
	{ id: "muse-spark-1.2", name: "Muse Spark 1.2" },
];

const OPENCODE_GO_MODELS = [
	{ id: "muse-spark-1.3-contributor", name: "Muse Spark 1.3 Contributor" },
	{ id: "muse-spark-1.2-contributor", name: "Muse Spark 1.2 Contributor" },
];

export default function museExtension(pi: ExtensionAPI): void {
	pi.registerProvider(MUSE_PROVIDER_ID, {
		name: "Meta Muse",
		baseUrl: MUSE_BASE_URL,
		apiKey: "$META_API_KEY",
		api: "openai-responses",
		models: MUSE_MODELS.map((model) => ({
			id: model.id,
			name: model.name,
			reasoning: true,
			input: ["text", "image"] as ("text" | "image")[],
			thinkingLevelMap: { off: null },
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1_048_576,
			maxTokens: 131_072,
		})),
	});

	pi.registerProvider(OPENCODE_GO_PROVIDER_ID, {
		name: "OpenCode Go",
		baseUrl: OPENCODE_GO_BASE_URL,
		apiKey: "$OPENCODE_GO_API_KEY",
		api: "openai-responses",
		headers: { "x-opencode-session": `pi-muse-${randomUUID()}` },
		models: OPENCODE_GO_MODELS.map((model) => ({
			id: model.id,
			name: model.name,
			reasoning: true,
			input: ["text"] as ("text" | "image")[],
			thinkingLevelMap: { off: null },
			cost: { input: 0.1, output: 0.2, cacheRead: 0.002, cacheWrite: 0 },
			contextWindow: 1_048_576,
			maxTokens: 131_072,
		})),
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
