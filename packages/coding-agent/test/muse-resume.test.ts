import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	RUN_END_CUSTOM_TYPE,
	RUN_START_CUSTOM_TYPE,
	SessionManager,
	TOOL_INTENT_CUSTOM_TYPE,
	TOOL_RESULT_CUSTOM_TYPE,
} from "../src/core/session-manager.ts";
import { detectInterruptedTurnNotice, repairSessionMessages } from "../src/core/session-repair.ts";

function toolCall(id: string, name: string): ToolCall {
	return { type: "toolCall", id, name, arguments: {} };
}

function assistant(...calls: ToolCall[]): AssistantMessage {
	return {
		role: "assistant",
		content: calls,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-test",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 1,
	};
}

function toolResult(toolCallId: string, toolName: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text: "ok" }],
		isError: false,
		timestamp: 2,
	};
}

describe("repairSessionMessages", () => {
	it("repairs a dangling tool call with a non-success result and reports it", () => {
		const messages: AgentMessage[] = [
			{ role: "user", content: "run it", timestamp: 1 },
			assistant(toolCall("call_1", "bash")),
		];

		const { messages: repaired, summary } = repairSessionMessages(messages);

		expect(summary.wasInterrupted).toBe(true);
		expect(summary.repaired).toEqual([{ toolCallId: "call_1", toolName: "bash" }]);
		expect(summary.toolNames).toEqual(["bash"]);

		const synthesized = repaired.find((message) => message.role === "toolResult") as ToolResultMessage;
		expect(synthesized).toBeDefined();
		expect(synthesized.toolCallId).toBe("call_1");
		expect(synthesized.toolName).toBe("bash");
		expect(synthesized.isError).toBe(true);
		expect(synthesized.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("not executed") });

		// Original messages are preserved; exactly one result was inserted.
		expect(repaired).toHaveLength(3);
		expect(repaired[0]).toBe(messages[0]);
		expect(repaired[1]).toBe(messages[1]);
	});

	it("only repairs the unmatched call when one result is present", () => {
		const messages: AgentMessage[] = [
			assistant(toolCall("call_1", "read"), toolCall("call_2", "bash")),
			toolResult("call_1", "read"),
		];

		const { messages: repaired, summary } = repairSessionMessages(messages);

		expect(summary.repaired).toEqual([{ toolCallId: "call_2", toolName: "bash" }]);
		const results = repaired.filter((message) => message.role === "toolResult") as ToolResultMessage[];
		expect(results.map((result) => result.toolCallId)).toEqual(["call_1", "call_2"]);
		expect(results[0].isError).toBe(false);
		expect(results[1].isError).toBe(true);
	});

	it("leaves a fully matched history untouched", () => {
		const messages: AgentMessage[] = [
			assistant(toolCall("call_1", "bash")),
			toolResult("call_1", "bash"),
			{ role: "user", content: "next", timestamp: 3 },
		];

		const { messages: repaired, summary } = repairSessionMessages(messages);

		expect(summary.wasInterrupted).toBe(false);
		expect(summary.repaired).toEqual([]);
		expect(summary.toolNames).toEqual([]);
		expect(repaired).toEqual(messages);
	});
});

describe("detectInterruptedTurnNotice", () => {
	it("names the interrupted tool", () => {
		const notice = detectInterruptedTurnNotice([assistant(toolCall("call_1", "bash"))]);

		expect(notice).toBeDefined();
		expect(notice).toContain("interrupted");
		expect(notice).toContain("bash");
	});

	it("returns undefined for a clean history", () => {
		const notice = detectInterruptedTurnNotice([assistant(toolCall("call_1", "bash")), toolResult("call_1", "bash")]);
		expect(notice).toBeUndefined();
	});
});

describe("reserved run/tool custom entries", () => {
	it("round-trips through the session manager without entering built context", () => {
		const session = SessionManager.inMemory();
		session.appendMessage({ role: "user", content: "hi", timestamp: 1 });
		session.appendRunStart("run_1");
		session.appendToolIntent({ runId: "run_1", toolCallId: "call_1", toolName: "bash" });
		session.appendToolResult({ runId: "run_1", toolCallId: "call_1", toolName: "bash", isError: false });
		session.appendRunEnd("run_1", "completed");

		const log = session.getToolExecutionLog();
		expect(log.runs).toEqual([
			{ kind: "start", data: { runId: "run_1", reason: undefined } },
			{ kind: "end", data: { runId: "run_1", reason: "completed" } },
		]);
		expect(log.intents).toEqual([{ runId: "run_1", toolCallId: "call_1", toolName: "bash" }]);
		expect(log.results).toEqual([{ runId: "run_1", toolCallId: "call_1", toolName: "bash", isError: false }]);
		expect(log.interrupted).toEqual([]);

		const customTypes = session
			.getEntries()
			.filter((entry) => entry.type === "custom")
			.map((entry) => entry.customType);
		expect(customTypes).toEqual([
			RUN_START_CUSTOM_TYPE,
			TOOL_INTENT_CUSTOM_TYPE,
			TOOL_RESULT_CUSTOM_TYPE,
			RUN_END_CUSTOM_TYPE,
		]);

		// Reserved bookkeeping must never leak into LLM context.
		const context = session.buildSessionContext();
		expect(context.messages).toEqual([{ role: "user", content: "hi", timestamp: 1 }]);
	});

	it("reports an intent with no result as interrupted", () => {
		const session = SessionManager.inMemory();
		session.appendRunStart("run_1");
		session.appendToolIntent({ runId: "run_1", toolCallId: "call_9", toolName: "bash" });

		const log = session.getToolExecutionLog();
		expect(log.interrupted).toEqual([{ runId: "run_1", toolCallId: "call_9", toolName: "bash" }]);
	});

	it("persists reserved entries across a session reload", () => {
		const dir = join(tmpdir(), `pi-muse-resume-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(dir, { recursive: true });
		try {
			const session = SessionManager.create(dir, dir);
			session.appendMessage(assistant(toolCall("call_1", "bash")));
			session.appendToolIntent({ runId: "run_1", toolCallId: "call_1", toolName: "bash" });
			const file = session.getSessionFile();
			expect(file).toBeDefined();

			const reopened = SessionManager.open(file as string);
			expect(reopened.getToolExecutionLog().intents).toEqual([
				{ runId: "run_1", toolCallId: "call_1", toolName: "bash" },
			]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
