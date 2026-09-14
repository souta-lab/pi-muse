import type { ExtensionAPI } from "../core/extensions/types.ts";

export const MUSE_PROVIDER_ID = "muse";

/**
 * Meta Model API is OpenAI-compatible. The Responses API is used because it carries
 * Muse Spark's encrypted reasoning across turns, which the Chat Completions surface
 * does not.
 */
const MUSE_BASE_URL = "https://api.meta.ai/v1";

export default function museExtension(pi: ExtensionAPI): void {
	pi.registerProvider(MUSE_PROVIDER_ID, {
		name: "Meta Muse",
		baseUrl: MUSE_BASE_URL,
		apiKey: "$MUSE_API_KEY",
		api: "openai-responses",
		models: [
			{
				id: "muse-spark-1.3",
				name: "Muse Spark 1.3",
				reasoning: true,
				input: ["text", "image"],
				thinkingLevelMap: { off: null },
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 1_048_576,
				maxTokens: 131_072,
			},
			{
				id: "muse-spark-1.2",
				name: "Muse Spark 1.2",
				reasoning: true,
				input: ["text", "image"],
				thinkingLevelMap: { off: null },
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 1_048_576,
				maxTokens: 131_072,
			},
		],
	});
}
