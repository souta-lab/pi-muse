import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stream as streamOpenAIResponses } from "../src/api/openai-responses.ts";
import { getModel } from "../src/compat.ts";
import type { Context, Model } from "../src/types.ts";

const SSE_COMPLETION_BODY = `${[
	`data: ${JSON.stringify({
		type: "response.completed",
		sequence_number: 1,
		response: {
			id: "resp_test",
			status: "completed",
			output: [],
			usage: {
				input_tokens: 1,
				output_tokens: 1,
				total_tokens: 2,
				input_tokens_details: { cached_tokens: 0 },
			},
		},
	})}`,
].join("\n\n")}\n\ndata: [DONE]\n\n`;

type CapturedPayload = {
	instructions?: string;
	input: Array<{ role?: string; content?: unknown }>;
	tools?: Array<{
		type?: string;
		name?: string;
		description?: string;
		strict?: unknown;
		tools?: Array<{ type?: string; name?: string; description?: string; strict?: unknown }>;
	}>;
};

function responsesModel(compat?: Model<"openai-responses">["compat"]): Model<"openai-responses"> {
	const base = getModel("openai", "gpt-5.4");
	return { ...base, compat };
}

async function capturePayload(model: Model<"openai-responses">, context: Context): Promise<CapturedPayload> {
	let captured: CapturedPayload | undefined;
	vi.spyOn(globalThis, "fetch").mockResolvedValue(
		new Response(SSE_COMPLETION_BODY, { status: 200, headers: { "content-type": "text/event-stream" } }),
	);

	const stream = streamOpenAIResponses(model, context, {
		apiKey: "test-key",
		onPayload: (payload) => {
			captured = payload as CapturedPayload;
			return payload;
		},
	});

	for await (const event of stream) {
		if (event.type === "done" || event.type === "error") break;
	}

	if (!captured) throw new Error("payload was not captured");
	return captured;
}

function developerItems(payload: CapturedPayload): Array<{ role?: string; content?: unknown }> {
	return payload.input.filter((item) => item.role === "developer");
}

describe("openai-responses instructions field compat", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	const splitContext: Context = {
		systemPrompt: "merged base and developer prompt",
		instructions: "base system prompt",
		developerContext: "per-session developer context",
		messages: [{ role: "user", content: "hi", timestamp: 0 }],
	};

	it("sends context.instructions and a leading developer item when the split is enabled", async () => {
		const payload = await capturePayload(responsesModel({ supportsInstructionsField: true }), splitContext);

		expect(payload.instructions).toBe("base system prompt");
		expect(payload.input[0]).toMatchObject({ role: "developer", content: "per-session developer context" });
		const developers = developerItems(payload);
		expect(developers).toHaveLength(1);
		expect(developers[0]?.content).not.toBe("merged base and developer prompt");
	});

	it("sanitizes unpaired surrogates in instructions and the developer item", async () => {
		const payload = await capturePayload(responsesModel({ supportsInstructionsField: true }), {
			...splitContext,
			instructions: `base${String.fromCharCode(0xd83d)}prompt`,
			developerContext: `developer${String.fromCharCode(0xdc00)}context`,
		});

		expect(payload.instructions).toBe("baseprompt");
		expect(payload.input[0]?.content).toBe("developercontext");
	});

	it("keeps the merged system prompt as the developer item when the split is off", async () => {
		const payload = await capturePayload(responsesModel(), splitContext);

		expect(payload.instructions).toBeUndefined();
		expect(payload.input[0]).toMatchObject({ role: "developer", content: "merged base and developer prompt" });
		expect(developerItems(payload)).toHaveLength(1);
	});

	it("ignores the split fields when instructions is absent", async () => {
		const payload = await capturePayload(responsesModel({ supportsInstructionsField: true }), {
			systemPrompt: "plain system prompt",
			developerContext: "ignored developer context",
			messages: [{ role: "user", content: "hi", timestamp: 0 }],
		});

		expect(payload.instructions).toBeUndefined();
		expect(payload.input[0]).toMatchObject({ role: "developer", content: "plain system prompt" });
	});
});

describe("openai-responses tool namespace compat", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	const context: Context = {
		messages: [{ role: "user", content: "hi", timestamp: 0 }],
		tools: [
			{ name: "read_file", description: "Read", parameters: Type.Object({ path: Type.String() }) },
			{ name: "write_file", description: "Write", parameters: Type.Object({ path: Type.String() }) },
		],
	};

	it("emits one namespace group containing the flat tools when configured", async () => {
		const payload = await capturePayload(
			responsesModel({ toolNamespace: { name: "muse", description: "Muse Code tool set." } }),
			context,
		);

		expect(payload.tools).toHaveLength(1);
		const group = payload.tools?.[0];
		expect(group).toMatchObject({
			type: "namespace",
			name: "muse",
			description: "Muse Code tool set.",
		});
		expect(group?.tools?.map((tool) => tool.name)).toEqual(["read_file", "write_file"]);
		expect(group?.tools?.every((tool) => tool.type === "function")).toBe(true);
	});

	it("emits strict:false on every namespace inner tool even without strict-mode support", async () => {
		const payload = await capturePayload(
			responsesModel({ toolNamespace: { name: "muse", description: "Muse Code tool set." } }),
			context,
		);

		const innerTools = payload.tools?.[0]?.tools ?? [];
		expect(innerTools).toHaveLength(2);
		for (const tool of innerTools) {
			expect(Object.keys(tool)).toEqual(["type", "name", "description", "parameters", "strict"]);
			expect(tool.strict).toBe(false);
		}
	});

	it("keeps flat function tools when no namespace is configured", async () => {
		const payload = await capturePayload(responsesModel(), context);

		expect(payload.tools).toHaveLength(2);
		expect(payload.tools?.map((tool) => tool.name)).toEqual(["read_file", "write_file"]);
		expect(payload.tools?.every((tool) => tool.type === "function")).toBe(true);
		expect(payload.tools?.some((tool) => tool.type === "namespace")).toBe(false);
		expect(payload.tools?.every((tool) => !("strict" in tool))).toBe(true);
	});
});
