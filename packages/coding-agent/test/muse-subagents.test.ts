import { describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import museSubagentsExtension from "../src/extensions/muse-subagents.ts";

type Handler = (data: unknown) => void;

function createFakeApi(subagentAvailable: boolean) {
	const handlers = new Map<string, Set<Handler>>();
	const startHandlers: Array<() => void | Promise<void>> = [];
	const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();

	const emit = (channel: string, data: unknown): void => {
		const params = (data ?? {}) as { requestId?: string };
		const replyChannel = `${channel}:reply:${params.requestId}`;
		if (!subagentAvailable) return;
		queueMicrotask(() => {
			let reply: unknown = { success: true };
			if (channel.endsWith(":ping")) reply = { success: true, data: { version: 2 } };
			else if (channel.endsWith(":spawn")) reply = { success: true, data: { id: "agent-1" } };
			for (const handler of handlers.get(replyChannel) ?? []) handler(reply);
		});
	};

	const events = {
		on: (channel: string, handler: Handler) => {
			const set = handlers.get(channel) ?? new Set<Handler>();
			set.add(handler);
			handlers.set(channel, set);
			return () => set.delete(handler);
		},
		emit,
	};

	const api = {
		events,
		on: (event: string, handler: () => void | Promise<void>) => {
			if (event === "session_start") startHandlers.push(handler);
		},
		registerTool: (tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) => {
			tools.set(tool.name, tool);
		},
		registerProvider: () => {},
	} as unknown as ExtensionAPI;

	return {
		api,
		tools,
		start: async () => {
			for (const handler of startHandlers) await handler();
		},
	};
}

describe("muse-subagents bridge", () => {
	it("registers the subagent tools only when pi-subagents answers ping", async () => {
		const available = createFakeApi(true);
		museSubagentsExtension(available.api);
		await available.start();
		expect([...available.tools.keys()].sort()).toEqual([
			"subagent_cancel",
			"subagent_read_result",
			"subagent_spawn",
			"subagent_status",
			"subagent_wait",
		]);

		const missing = createFakeApi(false);
		museSubagentsExtension(missing.api);
		await missing.start();
		expect(missing.tools.size).toBe(0);
	});

	it("maps Muse spawn args onto the pi-subagents spawn RPC", async () => {
		const fake = createFakeApi(true);
		museSubagentsExtension(fake.api);
		await fake.start();

		const spawn = fake.tools.get("subagent_spawn");
		const result = (await spawn?.execute("t", {
			command_id: "c1",
			role: "explore",
			objective: "find auth code",
			task_name: "auth-scan",
			worktree_isolation: true,
		})) as { content: Array<{ text: string }> };
		expect(result.content[0].text).toContain("agent-1");
	});
});
