import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import type { AgentToolResult, ExtensionAPI } from "../core/extensions/types.ts";

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

/**
 * `subagent_send_message` has no counterpart on the pi-subagents RPC bus.
 * Protocol v2 (`registerRpcHandlers` in @tintinweb/pi-subagents, still current
 * on master and in the latest published 0.19.0) registers exactly four
 * channels — ping, spawn, stop, consume — and its docs/rpc.md says the same.
 * Message delivery to a running child exists only in-process: `AgentManager.steer()`
 * backs the extension's own `steer_subagent` tool and fleet UI, and `nested-tools.ts`
 * calls `session.steer()` directly. Neither crosses the event bus, so until
 * upstream exposes a send/steer RPC (e.g. `subagents:rpc:send`) this tool
 * reports the gap instead of faking delivery with a second spawn.
 */
const SEND_MESSAGE_UNSUPPORTED =
	"Protocol v2 exposes only subagents:rpc:ping, subagents:rpc:spawn, subagents:rpc:stop and subagents:rpc:consume; " +
	"sending needs an upstream send/steer RPC backed by AgentManager.steer(), which is currently reachable only in-process.";

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
			description:
				"Spawn a simple child agent. The root Agent Tree can execute up to 8 agents at once by default, including the root; the configured limit may vary from 1 to 64. A spawn attempted while the root pool is full is rejected with root_capacity_exhausted; wait for an Agent to finish before retrying. An accepted child may remain queued by the host-scaled runtime scheduler and starts automatically when a scheduler slot frees. Choose worktree_isolation (true or an empty object) when the user requests subagent isolation or when parallel children may write, because concurrent writers can corrupt a shared checkout even when their intended files differ. Keep read-only children in the shared checkout. Isolation may be unavailable for the current profile or workspace.",
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
			name: "subagent_send_message",
			label: "subagent_send_message",
			description: "Queue a message for a running child. Pass the spawn-returned subagent_id or exact agent_path.",
			parameters: Type.Object({
				command_id: Type.String({ description: "Idempotency key for this operation; does not select the child." }),
				message: Type.String(),
				subagent_id: Type.Optional(Type.String()),
				agent_path: Type.Optional(Type.String()),
				mode: Type.Optional(Type.Union([Type.Literal("queue"), Type.Literal("followup")])),
				interrupt: Type.Optional(Type.Boolean()),
				artifact_ref: Type.Optional(Type.String()),
			}),
			execute: async (_id, input: Record<string, unknown>): Promise<AgentToolResult<Record<string, unknown>>> => {
				const target = readString(input.subagent_id) ?? readString(input.agent_path);
				if (!target) {
					return {
						content: [
							{
								type: "text" as const,
								text: "subagent_send_message failed: subagent_id or agent_path is required",
							},
						],
						details: {},
					};
				}
				const mode = readString(input.mode) ?? "queue";
				return {
					content: [
						{
							type: "text" as const,
							text:
								`subagent_send_message failed: unsupported by the installed pi-subagents RPC — ` +
								`the ${mode} message for ${target} was not delivered. ${SEND_MESSAGE_UNSUPPORTED}`,
						},
					],
					details: {
						error: "unsupported_by_pi_subagents_rpc",
						missing_upstream_method: "AgentManager.steer() is not exposed over the pi-subagents RPC bus",
						delivered: false,
						target,
					},
				};
			},
		});

		pi.registerTool({
			name: "subagent_status",
			label: "subagent_status",
			description: "Read subagent status from the replayable owner registry.",
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
			description:
				"Wait for a child result. timeout_ms defaults to 30000 ms and accepts 10000-300000. timeout or would_park leaves the child running. Finished results arrive automatically when your session is idle. Use subagent_cancel to stop the child. Pass the spawn-returned subagent_id or exact agent_path.",
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
			description:
				"Read a bounded result envelope and artifact refs. Pass the spawn-returned subagent_id or exact agent_path.",
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
			description: "Request child cancellation. Pass the spawn-returned subagent_id or exact agent_path.",
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
