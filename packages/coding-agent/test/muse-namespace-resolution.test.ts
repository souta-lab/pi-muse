import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type { Model, ToolResultMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "./suite/harness.ts";

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

function sse(events: unknown[]): string {
	return `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
}

/** Muse sends namespaced calls: `namespace` rides beside the bare function `name`. */
function namespacedReadFileResponse(): string {
	return sse([
		{ type: "response.created", sequence_number: 0, response: { id: "resp_ns" } },
		{
			type: "response.output_item.added",
			sequence_number: 1,
			output_index: 0,
			item: { type: "function_call", id: "fc_ns", call_id: "call_ns", name: "read_file", arguments: "" },
		},
		{
			type: "response.output_item.done",
			sequence_number: 2,
			output_index: 0,
			item: {
				type: "function_call",
				id: "fc_ns",
				call_id: "call_ns",
				name: "read_file",
				arguments: '{"path":"x"}',
				namespace: "muse",
			},
		},
		{
			type: "response.completed",
			sequence_number: 3,
			response: {
				id: "resp_ns",
				status: "completed",
				output: [],
				usage: {
					input_tokens: 1,
					output_tokens: 1,
					total_tokens: 2,
					input_tokens_details: { cached_tokens: 0 },
				},
			},
		},
	]);
}

function finalResponse(): string {
	return sse([
		{
			type: "response.completed",
			sequence_number: 1,
			response: {
				id: "resp_final",
				status: "completed",
				output: [
					{
						type: "message",
						id: "msg_final",
						role: "assistant",
						status: "completed",
						content: [{ type: "output_text", text: "done", annotations: [] }],
					},
				],
				usage: {
					input_tokens: 1,
					output_tokens: 1,
					total_tokens: 2,
					input_tokens_details: { cached_tokens: 0 },
				},
			},
		},
	]);
}

function toolResults(messages: AgentMessage[]): ToolResultMessage[] {
	return messages.filter((message): message is ToolResultMessage => message.role === "toolResult");
}

describe("namespaced Muse tool-call resolution", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
		vi.restoreAllMocks();
	});

	it("executes our read_file for an incoming namespace=muse name=read_file call", async () => {
		let executed = 0;
		const readFile: AgentTool = {
			name: "read_file",
			label: "read_file",
			description: "read stub",
			parameters: Type.Object({ path: Type.String() }),
			execute: async () => {
				executed += 1;
				return { content: [{ type: "text", text: "read_file executed" }], details: undefined };
			},
		};
		const harness = await createHarness({
			tools: [readFile],
			initialActiveToolNames: ["read_file"],
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
		harnesses.push(harness);
		harness.session.state.model = museModel();

		let calls = 0;
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
			calls += 1;
			const body = calls === 1 ? namespacedReadFileResponse() : finalResponse();
			return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
		});

		await harness.session.prompt("go");

		const assistant = harness.session.messages.find((message) => message.role === "assistant");
		const toolCall = assistant?.content.find((block) => block.type === "toolCall");
		expect(toolCall).toMatchObject({ type: "toolCall", name: "read_file", namespace: "muse" });

		expect(calls).toBe(2);
		expect(executed).toBe(1);
		const results = toolResults(harness.session.messages);
		expect(results).toHaveLength(1);
		expect(results[0].isError).toBe(false);
		expect(results[0].content[0]).toMatchObject({ type: "text", text: "read_file executed" });
	});
});
