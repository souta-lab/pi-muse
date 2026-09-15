import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "../core/extensions/types.ts";
import { createAgentSession } from "../core/sdk.ts";
import { SessionManager } from "../core/session-manager.ts";

/**
 * Bridges Muse's subagent tools onto the community `@tintinweb/pi-subagents`
 * extension. The tools are registered only when that extension answers
 * `subagents:rpc:ping`, so pi-muse never exposes dead tools. Install it with
 * `pi install npm:@tintinweb/pi-subagents`.
 *
 * Message delivery (`subagent_send_message`) does not go over the RPC bus:
 * protocol v2 registers only ping/spawn/stop/consume, and `resumeSessionFile`
 * plus `reclaim` are deliberately stripped from every cross-extension spawn,
 * so no bus channel can reach an existing child. This bridge instead drives the
 * child through the manager registry pi-subagents publishes in-process at
 * `Symbol.for("pi-subagents:manager")`. Its `getRecord(id)` returns the live
 * `AgentRecord`, whose `session` is the child's pi-muse `AgentSession` — the
 * same object pi-subagents' own `steer_subagent` tool and resume path drive:
 *  - a streaming child receives `prompt(message, { streamingBehavior })`, which
 *    queues a steering message (`mode:"queue"`, or `interrupt:true`) or a
 *    follow-up (`mode:"followup"`) without interrupting the run;
 *  - an idle child (already finished, record still live) gets a new turn on
 *    that session and the reply is returned;
 *  - an evicted child (records live ~10 minutes) is reopened from its recorded
 *    `sessionFile` with pi-muse's own `SessionManager` + `createAgentSession`
 *    SDK path — the same runner the workflow tool uses for its children — and
 *    the message is delivered as a new turn.
 *
 * Only when neither a live session nor a session file exists does the tool
 * report the upstream gap: an RPC send/steer channel backed by
 * `AgentManager.steer()`/`resume()`.
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
 * The upstream change needed to reach a child that pi-subagents has fully
 * forgotten (no live record, no transcript path). Kept verbatim in the tool
 * result so the gap is actionable.
 */
const RPC_SEND_MISSING =
	"pi-subagents protocol v2 has no send/steer RPC and its manager registry exposes no resume(); " +
	"the upstream change needed is a subagents:rpc:send (or :steer) handler backed by AgentManager.steer()/resume(), " +
	"because resumeSessionFile/reclaim are deliberately stripped from cross-extension spawns";

const LIFECYCLE: Array<[string, string]> = [
	["subagents:created", "created"],
	["subagents:started", "running"],
	["subagents:completed", "completed"],
	["subagents:failed", "failed"],
];

const MANAGER_REGISTRY_KEY = Symbol.for("pi-subagents:manager");
const MAX_REPLY_CHARS = 32_000;
const MAX_REMEMBERED_COMMANDS = 512;

/**
 * Cross-package slot for the in-process child runner the workflow tool prefers.
 * A `Symbol.for` key (same pattern as the pi-subagents manager registry) keeps
 * the consumer decoupled: the workflow tool reads the symbol and imports no
 * extension code at runtime.
 */
const CHILD_RUNNER_KEY = Symbol.for("pi-muse:subagent-runner");

const SUBAGENT_THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const MAX_DESCRIPTION_CHARS = 60;

/** One child request the workflow tool routes through the pi-subagents manager. */
export interface InProcessChildRunRequest {
	type: string;
	prompt: string;
	model: string | null;
	effort: string | null;
	isolation: boolean;
	cwd: string | null;
}

/** Plain child outcome: terminal status, result text, and accumulated usage. */
export interface InProcessChildRunResult {
	status: string;
	text: string;
	error_kind: string | null;
	error?: { code: string; message?: string };
	usage?: { totalTokens: number };
	data?: unknown;
}

/** The in-process runner published under {@link CHILD_RUNNER_KEY}. */
export interface InProcessChildRunner {
	runChild(request: InProcessChildRunRequest): Promise<InProcessChildRunResult>;
	maxConcurrent(): number | undefined;
}

/** Options accepted by pi-muse's `AgentSession.prompt()` that this bridge uses. */
interface SubagentPromptOptions {
	streamingBehavior?: "steer" | "followUp";
	expandPromptTemplates?: boolean;
}

/** The slice of pi-muse's `AgentSession` the bridge drives. */
interface SubagentSession {
	readonly isStreaming?: boolean;
	prompt(text: string, options?: SubagentPromptOptions): Promise<void>;
	getLastAssistantText?(): string | null;
	dispose?(): void;
}

/**
 * The slice of pi-subagents' `AgentRecord` the bridge reads. `getRecord()`
 * returns the live record by reference, so `session` and `sessionFile` are the
 * child's real session objects, not copies.
 */
interface SubagentRecord {
	status?: string;
	session?: SubagentSession;
	sessionFile?: string;
	pendingSteers?: string[];
}

interface SubagentManagerRegistry {
	getRecord(id: string): SubagentRecord | undefined;
	spawnAndWait?: (
		pi: ExtensionAPI,
		ctx: ExtensionContext,
		type: string,
		prompt: string,
		options: Record<string, unknown>,
		onSpawned?: (id: string) => void,
	) => Promise<unknown>;
	getMaxConcurrent?: () => number;
}

function readString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function canonicalTarget(target: string): string {
	if (target.startsWith("@")) return target.slice(1);
	const slash = target.lastIndexOf("/");
	return slash !== -1 && slash + 1 < target.length ? target.slice(slash + 1) : target;
}

function readStatusTarget(input: Record<string, unknown>): string | undefined {
	const direct = readString(input.subagent_id) ?? readString(input.agent_path);
	return direct ? canonicalTarget(direct) : undefined;
}

function isWorktreeIsolationRequest(value: unknown): boolean {
	if (value === true) return true;
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The captured subagent schemas document more parameters than the pi-subagents
 * bridge can honour. Accept them for contract parity, but name the ones a caller
 * actually supplied so the result never implies unsupported behaviour ran.
 */
function unsupportedParamNotice(
	input: Record<string, unknown>,
	unsupported: readonly string[],
): { note: string; ignored: string[] } {
	const ignored = unsupported.filter((key) => input[key] !== undefined && input[key] !== null);
	if (ignored.length === 0) return { note: "", ignored: [] };
	return { note: ` Not honoured by the pi-subagents bridge: ${ignored.join(", ")}.`, ignored };
}

function ignoredParamDetails(ignored: string[]): Record<string, unknown> {
	return ignored.length > 0 ? { ignored_params: ignored } : {};
}

function clampWaitTimeout(value: unknown): number {
	const raw = typeof value === "number" && Number.isFinite(value) ? value : 30_000;
	return Math.min(Math.max(raw, 10_000), 300_000);
}

function readManagerRegistry(): SubagentManagerRegistry | undefined {
	const value: unknown = (globalThis as Record<symbol, unknown>)[MANAGER_REGISTRY_KEY];
	if (typeof value !== "object" || value === null) return undefined;
	const getRecord = (value as { getRecord?: unknown }).getRecord;
	return typeof getRecord === "function" ? (value as SubagentManagerRegistry) : undefined;
}

/**
 * Resolve a Muse target — the spawn-returned id, an `@handle`, or a path whose
 * last segment is one of those — against the live pi-subagents records.
 */
function resolveSubagentRecord(
	registry: SubagentManagerRegistry,
	target: string,
): { id: string; record: SubagentRecord } | undefined {
	const candidates = [target];
	if (target.startsWith("@")) candidates.push(target.slice(1));
	const slash = target.lastIndexOf("/");
	if (slash !== -1 && slash + 1 < target.length) candidates.push(target.slice(slash + 1));
	for (const candidate of candidates) {
		const record = registry.getRecord(candidate);
		if (record) return { id: candidate, record };
	}
	return undefined;
}

function truncateReply(reply: string): string {
	return reply.length > MAX_REPLY_CHARS ? `${reply.slice(0, MAX_REPLY_CHARS)}\n… (truncated)` : reply;
}

function readReply(session: SubagentSession): string {
	if (typeof session.getLastAssistantText !== "function") return "";
	return session.getLastAssistantText() ?? "";
}

/**
 * pi-muse-owned runner for a child whose pi-subagents record was evicted but
 * whose transcript is still on disk: open the recorded session file and run the
 * message as a new turn in that conversation.
 */
async function runReopenedChildSession(
	sessionFile: string,
	message: string,
): Promise<{ reply: string } | { error: string }> {
	try {
		const sessionManager = SessionManager.open(sessionFile);
		const { session } = await createAgentSession({ sessionManager });
		try {
			await session.prompt(message, { expandPromptTemplates: false });
			return { reply: session.getLastAssistantText() ?? "" };
		} finally {
			session.dispose();
		}
	} catch (error) {
		return { error: errorMessage(error) };
	}
}

/**
 * Serialize reopened runs per session file: a second message must not open a
 * second writer over the same transcript while the first turn is still running.
 */
const sessionFileRuns = new Map<string, Promise<void>>();

function serializeBySessionFile<T>(sessionFile: string, run: () => Promise<T>): Promise<T> {
	const previous = sessionFileRuns.get(sessionFile) ?? Promise.resolve();
	const next = previous.then(run, run);
	sessionFileRuns.set(
		sessionFile,
		next.then(
			() => undefined,
			() => undefined,
		),
	);
	return next;
}

function deliveryText(target: string, channel: "steer" | "followUp" | "pending" | "prompt", reply: string): string {
	if (channel === "steer") {
		return `Sent steering message to subagent ${target}; it is delivered after the child's current tool call.`;
	}
	if (channel === "followUp") {
		return `Queued follow-up message for subagent ${target}; it is delivered when the child finishes its current work.`;
	}
	if (channel === "pending") {
		return `Queued steering message for subagent ${target}; its session has not started yet, so it is delivered at session start.`;
	}
	const base = `Delivered message to subagent ${target}; the child ran a new turn on its existing session.`;
	return reply ? `${base}\n\nReply:\n${truncateReply(reply)}` : base;
}

function describeRun(prompt: string): string {
	const firstLine =
		prompt
			.split("\n")
			.find((line) => line.trim().length > 0)
			?.trim() ?? "";
	if (firstLine.length === 0) return "workflow child";
	return firstLine.length > MAX_DESCRIPTION_CHARS ? `${firstLine.slice(0, MAX_DESCRIPTION_CHARS - 1)}…` : firstLine;
}

function resolveSpawnModel(ctx: ExtensionContext, modelId: string): unknown {
	const registry = ctx.modelRegistry;
	if (!registry) return undefined;
	const slash = modelId.indexOf("/");
	if (slash > 0 && slash < modelId.length - 1) {
		const byProvider = registry.find(modelId.slice(0, slash), modelId.slice(slash + 1));
		if (byProvider) return byProvider;
	}
	const lower = modelId.toLowerCase();
	return registry.getAll().find((model) => model.id === modelId || model.name.toLowerCase() === lower);
}

function readUsageTotal(value: unknown): number | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const usage = value as { input?: unknown; output?: unknown; cacheWrite?: unknown };
	const input = typeof usage.input === "number" ? usage.input : 0;
	const output = typeof usage.output === "number" ? usage.output : 0;
	const cacheWrite = typeof usage.cacheWrite === "number" ? usage.cacheWrite : 0;
	const total = input + output + cacheWrite;
	return total > 0 ? total : undefined;
}

function normalizeChildRunResult(raw: unknown): InProcessChildRunResult {
	const record = (raw as { record?: unknown } | null | undefined)?.record;
	if (typeof record !== "object" || record === null) {
		return {
			status: "error",
			text: "",
			error_kind: "invalid_result",
			error: { code: "invalid_result", message: "pi-subagents manager returned no child record" },
		};
	}
	const fields = record as Record<string, unknown>;
	const status = readString(fields.status) ?? "error";
	const text = readString(fields.result) ?? "";
	const failed = status !== "completed" && status !== "steered";
	const result: InProcessChildRunResult = { status, text, error_kind: failed ? status : null };
	if (failed) {
		result.error = { code: status, message: readString(fields.error) ?? `pi-subagents child ended ${status}` };
	}
	const totalTokens = readUsageTotal(fields.lifetimeUsage);
	if (totalTokens !== undefined) result.usage = { totalTokens };
	const structuredJson = readString(fields.structuredJson);
	if (structuredJson !== undefined) {
		try {
			result.data = JSON.parse(structuredJson);
		} catch {
			result.data = undefined;
		}
	}
	return result;
}

async function runChildViaManager(
	manager: SubagentManagerRegistry,
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	request: InProcessChildRunRequest,
): Promise<InProcessChildRunResult> {
	const spawnAndWait = manager.spawnAndWait;
	if (typeof spawnAndWait !== "function") {
		return {
			status: "error",
			text: "",
			error_kind: "runner_unavailable",
			error: { code: "runner_unavailable", message: "pi-subagents registry does not expose spawnAndWait" },
		};
	}
	const options: Record<string, unknown> = { description: describeRun(request.prompt) };
	if (request.model) {
		const model = resolveSpawnModel(ctx, request.model);
		if (model === undefined) {
			return {
				status: "error",
				text: "",
				error_kind: "model_not_found",
				error: { code: "model_not_found", message: `model override "${request.model}" is not available` },
			};
		}
		options.model = model;
	}
	if (request.effort) {
		const level = request.effort.trim().toLowerCase();
		if (SUBAGENT_THINKING_LEVELS.has(level)) options.thinkingLevel = level;
	}
	if (request.isolation) options.isolation = "worktree";
	if (request.cwd) options.cwd = request.cwd;
	try {
		const raw = await spawnAndWait.call(manager, pi, ctx, request.type, request.prompt, options);
		return normalizeChildRunResult(raw);
	} catch (error) {
		return {
			status: "error",
			text: "",
			error_kind: "spawn_failed",
			error: { code: "spawn_failed", message: errorMessage(error) },
		};
	}
}

function publishChildRunner(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	manager: SubagentManagerRegistry,
): InProcessChildRunner | undefined {
	const global = globalThis as Record<symbol, unknown>;
	if (global[CHILD_RUNNER_KEY] !== undefined) return undefined;
	if (typeof manager.spawnAndWait !== "function") return undefined;
	const handle: InProcessChildRunner = {
		runChild: (request) => runChildViaManager(manager, pi, ctx, request),
		maxConcurrent: () => {
			const getMax = manager.getMaxConcurrent;
			return typeof getMax === "function" ? getMax.call(manager) : undefined;
		},
	};
	global[CHILD_RUNNER_KEY] = handle;
	return handle;
}

export default function museSubagentsExtension(pi: ExtensionAPI): void {
	const records = new Map<string, AgentRecord>();
	const waiters = new Map<string, Array<(record: AgentRecord) => void>>();
	const deliveredCommands = new Map<string, { text: string; details: Record<string, unknown> }>();
	let publishedChildRunner: InProcessChildRunner | undefined;

	pi.on("session_shutdown", () => {
		if (publishedChildRunner === undefined) return;
		const global = globalThis as Record<symbol, unknown>;
		if (global[CHILD_RUNNER_KEY] === publishedChildRunner) delete global[CHILD_RUNNER_KEY];
		publishedChildRunner = undefined;
	});

	const notifyWaiters = (id: string, record: AgentRecord): void => {
		for (const waiter of waiters.get(id)?.splice(0) ?? []) waiter(record);
	};

	const settle = (id: string, status: string, output?: string): AgentRecord => {
		const next: AgentRecord = { status, output: output ?? records.get(id)?.output };
		records.set(id, next);
		notifyWaiters(id, next);
		return next;
	};

	const rememberDelivered = (commandId: string, text: string, details: Record<string, unknown>): void => {
		if (!commandId) return;
		if (deliveredCommands.size >= MAX_REMEMBERED_COMMANDS) {
			const oldest = deliveredCommands.keys().next().value;
			if (oldest !== undefined) deliveredCommands.delete(oldest);
		}
		deliveredCommands.set(commandId, { text, details });
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

	pi.on("session_start", async (_event, ctx) => {
		const ping = await call(RPC_PING, {}, 2000);
		if (!ping.success) return;

		const manager = readManagerRegistry();
		if (manager) publishedChildRunner = publishChildRunner(pi, ctx, manager);

		pi.registerTool({
			name: "subagent_spawn",
			label: "subagent_spawn",
			description:
				"Spawn a simple child agent. The root Agent Tree can execute up to 8 agents at once by default, including the root; the configured limit may vary from 1 to 64. A spawn attempted while the root pool is full is rejected with root_capacity_exhausted; wait for an Agent to finish before retrying. An accepted child may remain queued by the host-scaled runtime scheduler and starts automatically when a scheduler slot frees. Choose worktree_isolation (true or an empty object) when the user requests subagent isolation or when parallel children may write, because concurrent writers can corrupt a shared checkout even when their intended files differ. Keep read-only children in the shared checkout. Isolation may be unavailable for the current profile or workspace.",
			parameters: Type.Unsafe({
				type: "object",
				additionalProperties: false,
				required: ["command_id", "role", "objective"],
				properties: {
					command_id: { type: "string" },
					context_policy_ref: { type: "string" },
					objective: { type: "string" },
					output_schema: {
						type: ["object", "null"],
						additionalProperties: false,
						description:
							"Optional bounded structured-result contract. Omit or pass null to keep the native final-text result channel.",
						properties: {
							required_fields: {
								type: "array",
								maxItems: 16,
								items: { type: "string", maxLength: 128 },
							},
							schema_ref: { type: "string", maxLength: 256 },
						},
						required: ["schema_ref", "required_fields"],
					},
					role: { type: "string" },
					subagent_type: {
						type: ["string", "null"],
						description:
							"Agent Definition ID: lowercase ASCII letter segments joined by `-`; scoped: `<plugin-id>[/<scope>...]/<name>`. Omit/null: general-purpose.",
					},
					task_name: { type: "string", maxLength: 80, description: "[^/]{1,80}; omit/null=`role`" },
					worktree_isolation: {
						type: ["boolean", "object"],
						description:
							"Choose worktree_isolation (true or an empty object) when the user requests subagent isolation or when parallel children may write, because concurrent writers can corrupt a shared checkout even when their intended files differ. Keep read-only children in the shared checkout. false, null, or omission spawns without isolation.",
					},
				},
			}),
			execute: async (_id, input: Record<string, unknown>) => {
				const options: Record<string, unknown> = {};
				const name = readString(input.task_name) ?? readString(input.role);
				if (name) options.name = name;
				if (isWorktreeIsolationRequest(input.worktree_isolation)) options.isolation = "worktree";
				const type = readString(input.subagent_type) ?? readString(input.role) ?? "general-purpose";
				const notice = unsupportedParamNotice(input, ["context_policy_ref", "output_schema"]);
				const reply = await call(RPC_SPAWN, { type, prompt: readString(input.objective) ?? "", options }, 120_000);
				if (!reply.success) {
					return {
						content: [{ type: "text" as const, text: `subagent_spawn failed: ${reply.error}${notice.note}` }],
						details: ignoredParamDetails(notice.ignored),
					};
				}
				const id = readString((reply.data as { id?: unknown })?.id);
				if (id) records.set(id, { status: "running" });
				return {
					content: [
						{ type: "text" as const, text: `Spawned subagent ${id ?? "(unknown)"} (${type})${notice.note}` },
					],
					details: ignoredParamDetails(notice.ignored),
				};
			},
		});

		pi.registerTool({
			name: "subagent_status",
			label: "subagent_status",
			description: "Read subagent status from the replayable owner registry.",
			parameters: Type.Unsafe({
				type: "object",
				additionalProperties: false,
				required: [],
				properties: {
					agent_path: { type: "string" },
					parent_session_id: { type: "string" },
					path_prefix: { type: "string" },
					status_filter: { type: "string" },
					subagent_id: { type: "string" },
				},
			}),
			execute: async (_id, input: Record<string, unknown>) => {
				const notice = unsupportedParamNotice(input, ["parent_session_id", "path_prefix", "status_filter"]);
				const id = readStatusTarget(input);
				if (id) {
					const record = records.get(id);
					const text = record ? `${id}: ${record.status}` : `${id}: unknown`;
					return {
						content: [{ type: "text" as const, text: `${text}${notice.note}` }],
						details: ignoredParamDetails(notice.ignored),
					};
				}
				const list = Array.from(records.entries()).map(([key, value]) => `${key}: ${value.status}`);
				return {
					content: [{ type: "text" as const, text: `${list.join("\n") || "No subagents."}${notice.note}` }],
					details: ignoredParamDetails(notice.ignored),
				};
			},
		});

		pi.registerTool({
			name: "subagent_send_message",
			label: "subagent_send_message",
			description: "Queue a message for a running child. Pass the spawn-returned subagent_id or exact agent_path.",
			parameters: Type.Unsafe({
				type: "object",
				additionalProperties: false,
				required: ["command_id", "message"],
				properties: {
					agent_path: { type: "string" },
					artifact_ref: { type: "string" },
					command_id: {
						type: "string",
						description: "Idempotency key for this operation; does not select the child.",
					},
					interrupt: { type: "boolean" },
					message: { type: "string" },
					mode: { type: "string", enum: ["queue", "followup"] },
					subagent_id: { type: "string" },
				},
			}),
			execute: async (_id, input: Record<string, unknown>): Promise<AgentToolResult<Record<string, unknown>>> => {
				const notice = unsupportedParamNotice(input, ["artifact_ref"]);
				const target = readString(input.subagent_id) ?? readString(input.agent_path);
				if (!target) {
					return {
						content: [
							{
								type: "text" as const,
								text: `subagent_send_message failed: subagent_id or agent_path is required${notice.note}`,
							},
						],
						details: {
							error: "subagent_id_or_agent_path_required",
							delivered: false,
							...ignoredParamDetails(notice.ignored),
						},
					};
				}

				const commandId = readString(input.command_id) ?? "";
				const cached = commandId ? deliveredCommands.get(commandId) : undefined;
				if (cached) {
					return { content: [{ type: "text" as const, text: cached.text }], details: cached.details };
				}

				const failure = (error: string, text: string, extra?: Record<string, unknown>) => ({
					content: [{ type: "text" as const, text: `subagent_send_message failed: ${text}${notice.note}` }],
					details: { error, delivered: false, target, ...ignoredParamDetails(notice.ignored), ...extra },
				});

				const registry = readManagerRegistry();
				if (!registry) {
					return failure(
						"pi_subagents_registry_unavailable",
						"the pi-subagents manager registry is not available in this process, so no child session can be reached. " +
							RPC_SEND_MISSING,
					);
				}
				const resolved = resolveSubagentRecord(registry, target);
				if (!resolved) {
					return failure(
						"subagent_not_found",
						`no live pi-subagents record for ${target}; it may never have existed or have finished and been evicted (records live about 10 minutes). ` +
							RPC_SEND_MISSING,
					);
				}

				const { id, record } = resolved;
				const message = readString(input.message) ?? "";
				const mode = readString(input.mode) === "followup" ? "followup" : "queue";
				const channel = mode === "followup" && input.interrupt !== true ? "followUp" : "steer";
				const session = record.session;

				if (session) {
					const streaming = session.isStreaming === true;
					try {
						await session.prompt(message, { streamingBehavior: channel, expandPromptTemplates: false });
					} catch (error) {
						// A streaming child keeps its original run: only the queued
						// message failed, so its status must not be rewritten.
						if (!streaming) settle(id, "failed");
						return failure("delivery_failed", `${errorMessage(error)} (message for ${id} was not delivered)`);
					}
					if (streaming) {
						const details = {
							delivered: true,
							target: id,
							channel,
							via: "live_session",
							...(commandId ? { command_id: commandId } : {}),
							...ignoredParamDetails(notice.ignored),
						};
						const text = `${deliveryText(id, channel, "")}${notice.note}`;
						rememberDelivered(commandId, text, details);
						return { content: [{ type: "text" as const, text }], details };
					}
					const reply = readReply(session);
					settle(id, "completed", reply || records.get(id)?.output);
					const details = {
						delivered: true,
						target: id,
						channel: "prompt",
						via: "live_session",
						...(commandId ? { command_id: commandId } : {}),
						...ignoredParamDetails(notice.ignored),
					};
					const text = `${deliveryText(id, "prompt", reply)}${notice.note}`;
					rememberDelivered(commandId, text, details);
					return { content: [{ type: "text" as const, text }], details };
				}

				if (record.status === "running" || record.status === "queued") {
					if (!record.pendingSteers) {
						record.pendingSteers = [];
					}
					record.pendingSteers.push(message);
					const details = {
						delivered: true,
						target: id,
						channel: "pending",
						via: "pending_steers",
						...(commandId ? { command_id: commandId } : {}),
						...ignoredParamDetails(notice.ignored),
					};
					const text = `${deliveryText(id, "pending", "")}${notice.note}`;
					rememberDelivered(commandId, text, details);
					return { content: [{ type: "text" as const, text }], details };
				}

				const sessionFile = record.sessionFile;
				if (!sessionFile) {
					return failure(
						"child_session_unavailable",
						`subagent ${id} has no live session and recorded no session file (status: ${record.status ?? "unknown"}), so the ${mode} message was not delivered. ` +
							RPC_SEND_MISSING,
						{ missing_upstream_method: "AgentManager.steer()/resume() exposed as a subagents:rpc:send handler" },
					);
				}

				settle(id, "running");
				const run = await serializeBySessionFile(sessionFile, () => runReopenedChildSession(sessionFile, message));
				if ("error" in run) {
					settle(id, "failed");
					return failure(
						"delivery_failed",
						`reopening ${sessionFile} failed: ${run.error} (message for ${id} was not delivered)`,
						{ session_file: sessionFile },
					);
				}
				const reply = run.reply;
				settle(id, "completed", reply || records.get(id)?.output);
				const details = {
					delivered: true,
					target: id,
					channel: "prompt",
					via: "session_file",
					session_file: sessionFile,
					...(commandId ? { command_id: commandId } : {}),
					...ignoredParamDetails(notice.ignored),
				};
				const text = `${deliveryText(id, "prompt", reply)}${notice.note}`;
				rememberDelivered(commandId, text, details);
				return { content: [{ type: "text" as const, text }], details };
			},
		});

		pi.registerTool({
			name: "subagent_wait",
			label: "subagent_wait",
			description:
				"Wait for a child result. timeout_ms defaults to 30000 ms and accepts 10000-300000. timeout or would_park leaves the child running. Finished results arrive automatically when your session is idle. Use muse.subagent_cancel to stop the child. Pass the spawn-returned subagent_id or exact agent_path.",
			parameters: Type.Unsafe({
				type: "object",
				additionalProperties: false,
				required: ["command_id"],
				properties: {
					agent_path: { type: "string" },
					attempt_ref: { type: "string" },
					cancellation_token_ref: { type: "string" },
					command_id: {
						type: "string",
						description: "Idempotency key for this operation; does not select the child.",
					},
					subagent_id: { type: "string" },
					timeout_ms: {
						type: "integer",
						default: 30000,
						minimum: 10000,
						maximum: 300000,
						description:
							"Live-wait deadline in milliseconds. Defaults to 30000 when omitted; valid range is 10000 through 300000. Expiry returns timeout and leaves the child running.",
					},
					wait_for: {
						type: "string",
						enum: ["result_ready", "task_terminal"],
						description:
							"Use result_ready for the child result envelope. Use task_terminal only when a terminal task ref is enough.",
					},
				},
			}),
			execute: async (_id, input: Record<string, unknown>) => {
				const notice = unsupportedParamNotice(input, ["attempt_ref", "cancellation_token_ref", "wait_for"]);
				const id = readStatusTarget(input);
				if (!id) {
					return {
						content: [
							{
								type: "text" as const,
								text: `subagent_wait requires subagent_id or agent_path.${notice.note}`,
							},
						],
						details: ignoredParamDetails(notice.ignored),
					};
				}
				const finished = records.get(id)?.status;
				if (finished === "completed" || finished === "failed") {
					return {
						content: [{ type: "text" as const, text: `${id}: ${finished}${notice.note}` }],
						details: ignoredParamDetails(notice.ignored),
					};
				}
				const timeoutMs = clampWaitTimeout(input.timeout_ms);
				const record = await new Promise<AgentRecord>((resolve) => {
					const list = waiters.get(id) ?? [];
					list.push(resolve);
					waiters.set(id, list);
					setTimeout(() => resolve(records.get(id) ?? { status: "unknown" }), timeoutMs);
				});
				return {
					content: [{ type: "text" as const, text: `${id}: ${record.status}${notice.note}` }],
					details: ignoredParamDetails(notice.ignored),
				};
			},
		});

		pi.registerTool({
			name: "subagent_read_result",
			label: "subagent_read_result",
			description:
				"Read a bounded result envelope and artifact refs. Pass the spawn-returned subagent_id or exact agent_path.",
			parameters: Type.Unsafe({
				type: "object",
				additionalProperties: false,
				required: [],
				properties: {
					agent_path: { type: "string" },
					artifact_ref: { type: "string" },
					attempt_ref: { type: "string" },
					result_cursor: { type: "string" },
					subagent_id: { type: "string" },
				},
			}),
			execute: async (_id, input: Record<string, unknown>) => {
				const notice = unsupportedParamNotice(input, ["artifact_ref", "attempt_ref", "result_cursor"]);
				const id = readStatusTarget(input);
				if (!id) {
					return {
						content: [
							{
								type: "text" as const,
								text: `subagent_read_result requires subagent_id or agent_path.${notice.note}`,
							},
						],
						details: ignoredParamDetails(notice.ignored),
					};
				}
				const record = records.get(id);
				if (!record) {
					return {
						content: [{ type: "text" as const, text: `${id}: unknown${notice.note}` }],
						details: ignoredParamDetails(notice.ignored),
					};
				}
				await call(RPC_CONSUME, { agentId: id }, 5000);
				return {
					content: [
						{
							type: "text" as const,
							text: `${record.output ?? `${id}: ${record.status} (no captured result)`}${notice.note}`,
						},
					],
					details: ignoredParamDetails(notice.ignored),
				};
			},
		});

		pi.registerTool({
			name: "subagent_cancel",
			label: "subagent_cancel",
			description: "Request child cancellation. Pass the spawn-returned subagent_id or exact agent_path.",
			parameters: Type.Unsafe({
				type: "object",
				additionalProperties: false,
				required: ["command_id"],
				properties: {
					agent_path: { type: "string" },
					command_id: {
						type: "string",
						description: "Idempotency key for this operation; does not select the child.",
					},
					reason: { type: "string" },
					subagent_id: { type: "string" },
				},
			}),
			execute: async (_id, input: Record<string, unknown>) => {
				const notice = unsupportedParamNotice(input, ["reason"]);
				const id = readStatusTarget(input);
				if (!id) {
					return {
						content: [
							{
								type: "text" as const,
								text: `subagent_cancel requires subagent_id or agent_path.${notice.note}`,
							},
						],
						details: ignoredParamDetails(notice.ignored),
					};
				}
				const reply = await call(RPC_STOP, { agentId: id }, 10_000);
				return {
					content: [
						{
							type: "text" as const,
							text: `${reply.success ? `Stopped ${id}` : `subagent_cancel failed: ${reply.error}`}${notice.note}`,
						},
					],
					details: ignoredParamDetails(notice.ignored),
				};
			},
		});
	});
}
