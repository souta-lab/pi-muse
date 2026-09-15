import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildMuseDeveloperContext } from "../src/core/muse-context.ts";
import { MUSE_SYSTEM_PROMPT } from "../src/core/muse-system-prompt.ts";
import type { Skill } from "../src/core/skills.ts";
import { createSyntheticSourceInfo } from "../src/core/source-info.ts";
import { createHarness, type Harness } from "./suite/harness.ts";
import { createTestResourceLoader } from "./utilities.ts";

const SSE_COMPLETION_BODY = `${[
	`data: ${JSON.stringify({
		type: "response.completed",
		sequence_number: 1,
		response: {
			id: "resp_muse_session",
			status: "completed",
			output: [
				{
					type: "message",
					id: "msg_muse_session",
					role: "assistant",
					status: "completed",
					content: [{ type: "output_text", text: "Hi", annotations: [] }],
				},
			],
			usage: {
				input_tokens: 1,
				output_tokens: 1,
				total_tokens: 2,
				input_tokens_details: { cached_tokens: 0 },
			},
		},
	})}`,
].join("\n\n")}\n\ndata: [DONE]\n\n`;

function museModel(): Model<"openai-responses"> {
	return {
		id: "muse-spark-1.3-contributor",
		name: "Muse Spark 1.3 Contributor",
		api: "openai-responses",
		provider: "muse",
		baseUrl: "https://api.meta.ai/v1",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0.1, output: 0.2, cacheRead: 0.002, cacheWrite: 0 },
		contextWindow: 1_007_997,
		maxTokens: 32_768,
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
	};
}

function stubTool(name: string): AgentTool {
	return {
		name,
		label: name,
		description: `${name} stub`,
		parameters: Type.Object({}),
		execute: async () => ({ content: [], details: undefined }),
	};
}

interface CapturedRequest {
	instructions?: string;
	input: Array<{ role?: string; content?: unknown }>;
	tools?: Array<{
		type?: string;
		name?: string;
		description?: string;
		tools?: Array<{ type?: string; name?: string }>;
	}>;
}

describe("Muse session wire split", () => {
	let harness: Harness | undefined;

	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
		vi.restoreAllMocks();
	});

	it("sends the base prompt as instructions, the developer context as input[0], and one muse namespace", async () => {
		harness = await createHarness({
			tools: [stubTool("read_file"), stubTool("workflow")],
			initialActiveToolNames: ["read_file", "workflow"],
			modelsJson: {
				providers: {
					muse: {
						name: "Meta Muse",
						baseUrl: "https://api.meta.ai/v1",
						api: "openai-responses",
						apiKey: "test-key",
						compat: {
							supportsInstructionsField: true,
							toolNamespace: { name: "muse", description: "Muse Code tool set." },
						},
						models: [
							{
								id: "muse-spark-1.3-contributor",
								name: "Muse Spark 1.3 Contributor",
								reasoning: true,
								input: ["text", "image"],
								cost: { input: 0.1, output: 0.2, cacheRead: 0.002, cacheWrite: 0 },
								contextWindow: 1_007_997,
								maxTokens: 32_768,
							},
						],
					},
				},
			},
		});
		const session = harness.session;
		session.state.model = museModel();

		let captured: CapturedRequest | undefined;
		vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
			captured = JSON.parse(String(init?.body)) as CapturedRequest;
			return new Response(SSE_COMPLETION_BODY, {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		});

		await session.prompt("hi");

		if (!captured) throw new Error("no outbound request captured");
		const expectedDeveloper = buildMuseDeveloperContext({
			cwd: harness.tempDir,
			trusted: harness.settingsManager.isProjectTrusted(),
			skills: [],
			subagentsAvailable: false,
			workflowAvailable: true,
			sessionId: session.sessionId,
			sessionLogPath: session.sessionFile,
		});

		expect(captured.instructions).toBeTypeOf("string");
		expect(captured.input[0]).toMatchObject({ role: "developer", content: expectedDeveloper });
		expect(`${captured.instructions}\n\n${String(captured.input[0]?.content)}`).toBe(session.systemPrompt);

		expect(captured.tools).toHaveLength(1);
		const namespace = captured.tools?.[0];
		expect(namespace).toMatchObject({ type: "namespace", name: "muse", description: "Muse Code tool set." });
		expect(namespace?.tools?.map((tool) => tool.name)).toEqual(["read_file", "workflow"]);
		expect(namespace?.tools?.every((tool) => tool.type === "function")).toBe(true);
	});

	it("keeps a loaded skill and the cwd out of instructions by sending MUSE_SYSTEM_PROMPT verbatim", async () => {
		const fakeSkill: Skill = {
			name: "muse-parity-skill",
			description: "Loaded only to exercise the Muse skill-catalog gate.",
			filePath: "/tmp/muse-parity-skill/SKILL.md",
			baseDir: "/tmp/muse-parity-skill",
			sourceInfo: createSyntheticSourceInfo("/tmp/muse-parity-skill/SKILL.md", {
				source: "muse-session-wire-test",
			}),
			disableModelInvocation: false,
		};
		const baseLoader = createTestResourceLoader();
		harness = await createHarness({
			tools: [stubTool("read_file"), stubTool("bash")],
			initialActiveToolNames: ["read_file", "bash"],
			resourceLoader: {
				...baseLoader,
				getSystemPrompt: () => MUSE_SYSTEM_PROMPT,
				getSkills: () => ({ skills: [fakeSkill], diagnostics: [] }),
			},
			modelsJson: {
				providers: {
					muse: {
						name: "Meta Muse",
						baseUrl: "https://api.meta.ai/v1",
						api: "openai-responses",
						apiKey: "test-key",
						compat: {
							supportsInstructionsField: true,
							toolNamespace: { name: "muse", description: "Muse Code tool set." },
						},
						models: [
							{
								id: "muse-spark-1.3-contributor",
								name: "Muse Spark 1.3 Contributor",
								reasoning: true,
								input: ["text", "image"],
								cost: { input: 0.1, output: 0.2, cacheRead: 0.002, cacheWrite: 0 },
								contextWindow: 1_007_997,
								maxTokens: 32_768,
							},
						],
					},
				},
			},
		});
		const session = harness.session;
		session.state.model = museModel();

		let captured: CapturedRequest | undefined;
		vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
			captured = JSON.parse(String(init?.body)) as CapturedRequest;
			return new Response(SSE_COMPLETION_BODY, {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		});

		await session.prompt("hi");

		if (!captured) throw new Error("no outbound request captured");
		expect(captured.instructions).toBe(MUSE_SYSTEM_PROMPT);
		expect(captured.instructions).not.toContain(`Current working directory: ${harness.tempDir}`);
		expect(captured.instructions).not.toContain("<available_skills>");
		expect(String(captured.input[0]?.content)).toContain("muse-parity-skill");
	});
});
