/**
 * Safe-resume repair and bookkeeping for restored sessions.
 *
 * WHAT THIS MODULE GUARANTEES
 * - `repairSessionMessages()` is a pure, deterministic function: the same input
 *   message list always produces the same repaired list and summary. It performs
 *   no I/O and reads no clock.
 * - Every assistant `toolCall` that has no matching `toolResult` anywhere in the
 *   restored history receives a synthesized `toolResult` with `isError: true`
 *   whose text states the call was interrupted / not executed. A successful
 *   result is never fabricated.
 * - The returned summary lists every synthesized result by tool name and tool
 *   call id, so a caller can explain what was interrupted.
 * - `formatInterruptedTurnNotice()` yields a human-readable notice naming the
 *   interrupted tools, or `undefined` when nothing was repaired.
 *
 * WHAT THIS MODULE DOES NOT GUARANTEE
 * - This is NOT deterministic replay or event sourcing. It does not reconstruct
 *   prior tool side effects, re-run tools, or prove what a process actually did;
 *   it only patches a restored message list so it is safe to send to a provider.
 * - This is NOT a cross-process owner registry. It cannot tell whether another
 *   live process still owns the session or is mid-tool-call. Concurrent writers
 *   are outside its scope.
 * - It does not validate tool arguments or results, and it does not guarantee
 *   provider acceptance for histories broken in ways other than dangling calls.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";

/** A tool call that was missing its result and received a synthesized interrupted result. */
export interface RepairedToolCall {
	toolCallId: string;
	toolName: string;
}

/** Deterministic description of what a repair pass changed. */
export interface SessionRepairSummary {
	/** Repaired tool calls in first-encounter order. */
	repaired: RepairedToolCall[];
	/** Unique tool names among repaired calls, in first-seen order. */
	toolNames: string[];
	/** True when at least one dangling tool call was repaired. */
	wasInterrupted: boolean;
}

/** Result of repairing a restored message list. */
export interface SessionRepairResult {
	/** Repaired list. Equal to the input when nothing needed repair. */
	messages: AgentMessage[];
	summary: SessionRepairSummary;
}

function getToolCalls(message: AssistantMessage): ToolCall[] {
	return message.content.filter((block): block is ToolCall => block.type === "toolCall");
}

function createInterruptedToolResult(call: ToolCall, timestamp: number): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: call.id,
		toolName: call.name,
		content: [
			{
				type: "text",
				text: `Interrupted: tool "${call.name}" was not executed. The previous turn ended before this tool call completed.`,
			},
		],
		isError: true,
		timestamp: Number.isFinite(timestamp) ? timestamp : 0,
	};
}

/**
 * Repair dangling tool calls in a restored message list.
 *
 * A tool call is dangling when an assistant message contains a `toolCall` whose
 * id has no matching `toolResult` anywhere in the list. Each dangling call is
 * given a synthesized, error-marked result placed after the assistant message
 * and its existing tool results, so the relative order of matched calls is kept.
 *
 * Pure and deterministic: no I/O, no clock reads, no mutation of inputs.
 */
export function repairSessionMessages(messages: AgentMessage[]): SessionRepairResult {
	const resultIds = new Set<string>();
	for (const message of messages) {
		if (message.role === "toolResult") {
			resultIds.add((message as ToolResultMessage).toolCallId);
		}
	}

	const insertions = new Map<number, AgentMessage[]>();
	const repaired: RepairedToolCall[] = [];
	const toolNames: string[] = [];
	const synthesizedIds = new Set<string>();

	for (let i = 0; i < messages.length; i++) {
		const message = messages[i];
		if (message.role !== "assistant") continue;

		const calls = getToolCalls(message as AssistantMessage);
		if (calls.length === 0) continue;

		// Insert after the run of tool results that already follow this assistant
		// message, so existing matches stay ahead of synthesized ones.
		let insertAt = i + 1;
		while (insertAt < messages.length && messages[insertAt].role === "toolResult") {
			insertAt++;
		}

		const pending: AgentMessage[] = [];
		for (const call of calls) {
			if (resultIds.has(call.id) || synthesizedIds.has(call.id)) continue;
			synthesizedIds.add(call.id);
			repaired.push({ toolCallId: call.id, toolName: call.name });
			if (!toolNames.includes(call.name)) {
				toolNames.push(call.name);
			}
			pending.push(createInterruptedToolResult(call, (message as AssistantMessage).timestamp));
		}

		if (pending.length > 0) {
			insertions.set(insertAt, [...(insertions.get(insertAt) ?? []), ...pending]);
		}
	}

	if (repaired.length === 0) {
		return { messages, summary: { repaired, toolNames, wasInterrupted: false } };
	}

	const output: AgentMessage[] = [];
	for (let i = 0; i <= messages.length; i++) {
		const inserted = insertions.get(i);
		if (inserted) {
			output.push(...inserted);
		}
		if (i < messages.length) {
			output.push(messages[i]);
		}
	}

	return { messages: output, summary: { repaired, toolNames, wasInterrupted: true } };
}

/**
 * Build the human-readable resume notice for a repair summary.
 * Returns `undefined` when nothing was interrupted.
 */
export function formatInterruptedTurnNotice(summary: SessionRepairSummary): string | undefined {
	if (!summary.wasInterrupted) return undefined;
	const toolList = summary.toolNames.join(", ");
	const count = summary.repaired.length;
	const plural = count === 1 ? "" : "s";
	return `The previous turn was interrupted while running ${toolList}. ${count} tool call${plural} did not complete and ${
		count === 1 ? "was" : "were"
	} not executed; nothing was re-run on resume.`;
}

/**
 * Convenience wrapper for a restored message list: repairs the messages and
 * returns the interrupted-turn notice, or `undefined` when the history is clean.
 */
export function detectInterruptedTurnNotice(messages: AgentMessage[]): string | undefined {
	return formatInterruptedTurnNotice(repairSessionMessages(messages).summary);
}
