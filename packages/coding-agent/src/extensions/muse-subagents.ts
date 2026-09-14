import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import type { ExtensionAPI } from "../core/extensions/types.ts";

/**
 * Bridges Muse's subagent tools onto the community `@tintinweb/pi-subagents`
 * extension over the in-process `pi.events` RPC bus. The tools are registered
 * only when that extension answers `subagents:rpc:ping`, so pi-muse never
 * exposes dead tools. Install it with `pi install npm:@tintinweb/pi-subagents`.
 */

interface RpcReply {
	success: boolean;
	data?: unknown;
	error?: string;
}

interface AgentRecord {
	status: string;
	output?: string;
}

const RPC_PING = "subagents:rpc:ping";
const RPC_SPAWN = "subagents:rpc:spawn";
const RPC_STOP = "subagents:rpc:stop";
const RPC_CONSUME = "subagents:rpc:consume";

const LIFECYCLE: Array<[string, string]> = [
	["subagents:created", "created"],
	["subagents:started", "running"],
	["subagents:completed", "completed"],
	["subagents:failed", "failed"],
];

function readString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

export default function museSubagentsExtension(pi: ExtensionAPI): void {
	const records = new Map<string, AgentRecord>();
	const waiters = new Map<string, Array<(record: AgentRecord) => void>>();

	const notifyWaiters = (id: string, record: AgentRecord): void => {
		for (const waiter of waiters.get(id)?.splice(0) ?? []) waiter(record);
	};

	for (const [channel, status] of LIFECYCLE) {
		pi.events.on(channel, (raw: unknown) => {
			const data = (raw ?? {}) as Record<string, unknown>;
			const record = (data.record ?? {}) as Record<string, unknown>;
			const id = readString(data.agentId) ?? readString(data.id) ?? readString(record.id);
			if (!id) return;
			const output =
				readString(data.result) ??
				readString(data.resultText) ??
				readString(record.resultText) ??
				readString(record.output);
			const next: AgentRecord = { status, output: output ?? records.get(id)?.output };
			records.set(id, next);
			if (status === "completed" || status === "failed") notifyWaiters(id, next);
		});
	}

	const call = (channel: string, params: Record<string, unknown>, timeoutMs: number): Promise<RpcReply> =>
		new Promise((resolve) => {
			const requestId = randomUUID();
			const replyChannel = `${channel}:reply:${requestId}`;
			const off = pi.events.on(replyChannel, (raw: unknown) => {
				clearTimeout(timer);
				off();
				resolve((raw ?? { success: false, error: "empty reply" }) as RpcReply);
			});
			const timer = setTimeout(() => {
				off();
				resolve({ success: false, error: `RPC ${channel} timed out` });
			}, timeoutMs);
			pi.events.emit(channel, { requestId, ...params });
		});

	pi.on("session_start", async () => {
		const ping = await call(RPC_PING, {}, 2000);
		if (!ping.success) return;

		pi.registerTool({
			name: "subagent_spawn",
			label: "subagent_spawn",
			description: "Spawn a child agent. Returns a handle used by the other subagent tools.",
			parameters: Type.Object({
				command_id: Type.String({ description: "Caller-supplied idempotency id." }),
				role: Type.String({ description: "Role or agent type for the child." }),
				objective: Type.String({ description: "What the child must accomplish." }),
				subagent_type: Type.Optional(Type.String({ description: "Explicit agent definition id." })),
				task_name: Type.Optional(Type.String({ description: "Short display name for the child." })),
				worktree_isolation: Type.Optional(Type.Boolean({ description: "Run the child in its own git worktree." })),
				output_schema: Type.Optional(Type.Any({ description: "Optional structured result contract." })),
			}),
			execute: async (_id, input: Record<string, unknown>) => {
				const options: Record<string, unknown> = {};
				const name = readString(input.task_name) ?? readString(input.role);
				if (name) options.name = name;
				if (input.worktree_isolation === true) options.isolation = "worktree";
				const type = readString(input.subagent_type) ?? readString(input.role) ?? "general-purpose";
				const reply = await call(RPC_SPAWN, { type, prompt: readString(input.objective) ?? "", options }, 120_000);
				if (!reply.success) {
					return {
						content: [{ type: "text" as const, text: `subagent_spawn failed: ${reply.error}` }],
						details: {},
					};
				}
				const id = readString((reply.data as { id?: unknown })?.id);
				if (id) records.set(id, { status: "running" });
				return {
					content: [{ type: "text" as const, text: `Spawned subagent ${id ?? "(unknown)"} (${type})` }],
					details: {},
				};
			},
		});

		pi.registerTool({
			name: "subagent_status",
			label: "subagent_status",
			description: "Read the current state of one or more child agents.",
			parameters: Type.Object({ subagent_id: Type.Optional(Type.String({ description: "Child agent id." })) }),
			execute: async (_id, input: Record<string, unknown>) => {
				const id = readString(input.subagent_id);
				if (id) {
					const record = records.get(id);
					const text = record ? `${id}: ${record.status}` : `${id}: unknown`;
					return { content: [{ type: "text" as const, text }], details: {} };
				}
				const list = Array.from(records.entries()).map(([key, value]) => `${key}: ${value.status}`);
				return { content: [{ type: "text" as const, text: list.join("\n") || "No subagents." }], details: {} };
			},
		});

		pi.registerTool({
			name: "subagent_wait",
			label: "subagent_wait",
			description: "Block until a child agent settles, then return its status.",
			parameters: Type.Object({
				subagent_id: Type.String({ description: "Child agent id." }),
				timeout_ms: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum wait in milliseconds." })),
			}),
			execute: async (_id, input: Record<string, unknown>) => {
				const id = readString(input.subagent_id);
				if (!id) return { content: [{ type: "text" as const, text: "subagent_id is required" }], details: {} };
				if (records.get(id)?.status === "completed" || records.get(id)?.status === "failed") {
					return { content: [{ type: "text" as const, text: `${id}: ${records.get(id)?.status}` }], details: {} };
				}
				const timeoutMs = typeof input.timeout_ms === "number" ? input.timeout_ms : 600_000;
				const record = await new Promise<AgentRecord>((resolve) => {
					const list = waiters.get(id) ?? [];
					list.push(resolve);
					waiters.set(id, list);
					setTimeout(() => resolve(records.get(id) ?? { status: "unknown" }), timeoutMs);
				});
				return { content: [{ type: "text" as const, text: `${id}: ${record.status}` }], details: {} };
			},
		});

		pi.registerTool({
			name: "subagent_read_result",
			label: "subagent_read_result",
			description: "Read a settled child agent's result text.",
			parameters: Type.Object({ subagent_id: Type.String({ description: "Child agent id." }) }),
			execute: async (_id, input: Record<string, unknown>) => {
				const id = readString(input.subagent_id);
				if (!id) return { content: [{ type: "text" as const, text: "subagent_id is required" }], details: {} };
				const record = records.get(id);
				if (!record) return { content: [{ type: "text" as const, text: `${id}: unknown` }], details: {} };
				await call(RPC_CONSUME, { agentId: id }, 5000);
				return {
					content: [
						{ type: "text" as const, text: record.output ?? `${id}: ${record.status} (no captured result)` },
					],
					details: {},
				};
			},
		});

		pi.registerTool({
			name: "subagent_cancel",
			label: "subagent_cancel",
			description: "Stop a running child agent.",
			parameters: Type.Object({
				command_id: Type.String({ description: "Caller-supplied idempotency id." }),
				subagent_id: Type.String({ description: "Child agent id." }),
			}),
			execute: async (_id, input: Record<string, unknown>) => {
				const id = readString(input.subagent_id);
				if (!id) return { content: [{ type: "text" as const, text: "subagent_id is required" }], details: {} };
				const reply = await call(RPC_STOP, { agentId: id }, 10_000);
				return {
					content: [
						{
							type: "text" as const,
							text: reply.success ? `Stopped ${id}` : `subagent_cancel failed: ${reply.error}`,
						},
					],
					details: {},
				};
			},
		});
	});
}
