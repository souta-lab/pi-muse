import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";
import {
	getShellConfig,
	getShellEnv,
	killProcessTree,
	trackDetachedChildPid,
	untrackDetachedChildPid,
} from "../../utils/shell.ts";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import { bashToolSystemPromptContribution } from "./bash.ts";
import { createEditToolDefinition, type EditToolDetails, type EditToolOptions } from "./edit.ts";
import { createGrepToolDefinition, type GrepToolOptions } from "./grep.ts";
import { createReadToolDefinition, type ReadToolOptions } from "./read.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { truncateTail } from "./truncate.ts";
import { createWriteToolDefinition, type WriteToolOptions } from "./write.ts";

export const MUSE_TOOL_NAMES = [
	"read_file",
	"write_file",
	"edit_file",
	"search",
	"bash",
	"bash_input",
	"write_todos",
] as const;

export type MuseToolName = (typeof MUSE_TOOL_NAMES)[number];

export const MUSE_READ_DEFAULT_LIMIT = 500;
const DEFAULT_YIELD_MS = 10_000;
const MAX_YIELD_MS = 300_000;
const SESSION_OUTPUT_CAP = 2 * 50 * 1024;

const editFileSchema = Type.Object({
	path: Type.String({ description: "Path to edit." }),
	find: Type.String({ description: "Exact text to replace." }),
	replace: Type.String({ description: "Replacement text." }),
});

export type EditFileToolInput = Static<typeof editFileSchema>;

const searchSchema = Type.Object({
	pattern: Type.String({ description: "Regular expression or literal text to search for." }),
	paths: Type.Optional(
		Type.Array(Type.String(), {
			description: "Files or directories to search. Omit paths to search the workspace root.",
		}),
	),
	glob: Type.Optional(Type.String({ description: "Filter files by glob pattern, e.g. '*.ts'." })),
	ignore_case: Type.Optional(Type.Boolean({ description: "Case-insensitive search." })),
	literal: Type.Optional(Type.Boolean({ description: "Treat pattern as a literal string instead of a regex." })),
	context_after: Type.Optional(Type.Number({ description: "Number of context lines to include after each match." })),
	max_matches: Type.Optional(Type.Number({ description: "Maximum matches to return before stopping early." })),
});

export type SearchToolInput = Static<typeof searchSchema>;

const bashSchema = Type.Object({
	command: Type.String({ description: "Shell command to execute from the workspace root." }),
	yield_time_ms: Type.Optional(
		Type.Number({
			description:
				"Foreground wait before the command moves to a managed background session. Slow builds and tests may need 120000-300000.",
		}),
	),
});

export type BashInput = Static<typeof bashSchema>;

const bashInputSchema = Type.Object({
	session_id: Type.String({ description: "Session id returned by bash for a still-running command." }),
	input: Type.Optional(Type.String({ description: "Bytes to send to the live session's stdin." })),
	terminate: Type.Optional(Type.Boolean({ description: "Stop the live session instead of sending input." })),
});

export type BashInputToolInput = Static<typeof bashInputSchema>;

const todoStatusSchema = Type.Union([
	Type.Literal("pending"),
	Type.Literal("in_progress"),
	Type.Literal("completed"),
	Type.Literal("cancelled"),
]);

const writeTodosSchema = Type.Object({
	todos: Type.Array(
		Type.Object({
			text: Type.String({ description: "Description of the task." }),
			status: todoStatusSchema,
		}),
		{ description: "The full todo list, replacing any previous list." },
	),
});

export type WriteTodosToolInput = Static<typeof writeTodosSchema>;
export type TodoStatus = Static<typeof todoStatusSchema>;

interface MuseShellSession {
	child: ChildProcess;
	output: string;
	delivered: number;
	exited: boolean;
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	exitedPromise: Promise<void>;
}

export interface BashDetails {
	exitCode?: number | null;
	signal?: string | null;
	sessionId?: string;
	running?: boolean;
}

export interface BashInputDetails {
	status?: "running" | "completed" | "terminated";
	exitCode?: number | null;
	originalOutputBytes?: number;
}

const shellSessions = new Map<string, MuseShellSession>();

function appendSessionOutput(session: MuseShellSession, text: string): void {
	session.output += text;
	if (session.output.length > SESSION_OUTPUT_CAP) {
		const overflow = session.output.length - SESSION_OUTPUT_CAP;
		session.output = session.output.slice(overflow);
		session.delivered = Math.max(0, session.delivered - overflow);
	}
}

function formatBashOutput(output: string): string {
	const truncation = truncateTail(output, { maxLines: 2000, maxBytes: 50 * 1024 });
	if (!truncation.truncated) return truncation.content;
	return `${truncation.content}\n[output truncated to the last ${truncation.outputLines} lines]`;
}

function buildBashEnv(ctx: ExtensionContext | undefined): NodeJS.ProcessEnv {
	const env = { ...getShellEnv() };
	delete env.PI_SESSION_ID;
	delete env.PI_SESSION_FILE;
	delete env.PI_PROVIDER;
	delete env.PI_MODEL;
	delete env.PI_REASONING_LEVEL;
	if (ctx) {
		const model = ctx.model;
		if (ctx.sessionManager) {
			env.PI_SESSION_ID = ctx.sessionManager.getSessionId();
			const sessionFile = ctx.sessionManager.getSessionFile();
			if (sessionFile) env.PI_SESSION_FILE = sessionFile;
		}
		if (model) {
			env.PI_PROVIDER = model.provider;
			env.PI_MODEL = model.id;
		}
		if (ctx.thinkingLevel) env.PI_REASONING_LEVEL = ctx.thinkingLevel;
	}
	return env;
}

export function createReadFileToolDefinition(
	cwd: string,
	options?: ReadToolOptions,
): ReturnType<typeof createReadToolDefinition> {
	const base = createReadToolDefinition(cwd, options);
	return {
		...base,
		name: "read_file",
		label: "read_file",
		description:
			"Read a line-numbered UTF-8 text file window, or attach a supported image file as model-visible output. Reads one regular file; use bash to list directories.",
		prepareArguments: (args: unknown) => {
			const input = args as { path: string; offset?: number; limit?: number };
			return { path: input.path, offset: input.offset, limit: input.limit ?? MUSE_READ_DEFAULT_LIMIT };
		},
	};
}

export function createWriteFileToolDefinition(
	cwd: string,
	options?: WriteToolOptions,
): ReturnType<typeof createWriteToolDefinition> {
	const base = createWriteToolDefinition(cwd, options);
	return {
		...base,
		name: "write_file",
		label: "write_file",
		description:
			"Create or overwrite a complete UTF-8 file. For a large file, write a small first chunk here and then grow it with edit_file; one huge write can exceed a single model response and fail to send.",
	};
}

export function createEditFileToolDefinition(
	cwd: string,
	options?: EditToolOptions,
): ToolDefinition<typeof editFileSchema, EditToolDetails | undefined> {
	const base = createEditToolDefinition(cwd, options);
	return {
		name: "edit_file",
		label: "edit_file",
		description:
			"Replace one unique exact text match in a file. find must match the current file content exactly once; zero or multiple matches error and no change is written.",
		promptSnippet: "Edit files with an exact find/replace pair",
		promptGuidelines: ["Use edit_file for precise changes (find must match exactly once)"],
		parameters: editFileSchema,
		constrainedSampling: { type: "json_schema", strict: "prefer" },
		execute(toolCallId, input, signal, onUpdate, ctx) {
			return base.execute(
				toolCallId,
				{ path: input.path, edits: [{ oldText: input.find, newText: input.replace }] },
				signal,
				onUpdate,
				ctx,
			);
		},
	};
}

export function createSearchToolDefinition(cwd: string, options?: GrepToolOptions): ToolDefinition<any, any> {
	const base = createGrepToolDefinition(cwd, options);
	return {
		name: "search",
		label: "search",
		description:
			"Search file contents for a pattern. Returns matching lines with file paths and line numbers. Respects .gitignore.",
		promptSnippet: base.promptSnippet,
		parameters: searchSchema,
		constrainedSampling: base.constrainedSampling,
		execute(toolCallId, input: SearchToolInput, signal, onUpdate, ctx) {
			return base.execute(
				toolCallId,
				{
					pattern: input.pattern,
					path: input.paths?.[0],
					glob: input.glob,
					ignoreCase: input.ignore_case,
					literal: input.literal,
					context: input.context_after,
					limit: input.max_matches,
				},
				signal,
				onUpdate,
				ctx,
			);
		},
	};
}

export function createMuseBashToolDefinition(cwd: string): ToolDefinition<any, BashDetails> {
	return {
		name: "bash",
		label: "bash",
		description:
			"Run a shell command in the workspace subject to runtime policy. Waits in the foreground for yield_time_ms, then returns a session_id for the still-running command.",
		promptSnippet: "Execute bash commands",
		promptGuidelines: [...bashToolSystemPromptContribution.guidelines],
		parameters: bashSchema,
		constrainedSampling: { type: "json_schema", strict: "prefer" },
		async execute(_toolCallId, input: BashInput, signal, _onUpdate, ctx) {
			const workingDir = ctx?.cwd || cwd;
			const shellConfig = getShellConfig();
			const commandFromStdin = shellConfig.commandTransport === "stdin";
			const child = spawn(
				shellConfig.shell,
				commandFromStdin ? shellConfig.args : [...shellConfig.args, input.command],
				{
					cwd: workingDir,
					detached: process.platform !== "win32",
					env: buildBashEnv(ctx),
					stdio: ["pipe", "pipe", "pipe"],
					windowsHide: true,
				},
			);
			if (commandFromStdin) {
				child.stdin?.on("error", () => {});
				child.stdin?.end(input.command);
			}
			if (child.pid) trackDetachedChildPid(child.pid);

			let resolveExit: () => void = () => {};
			const exitedPromise = new Promise<void>((resolve) => {
				resolveExit = resolve;
			});
			const session: MuseShellSession = {
				child,
				output: "",
				delivered: 0,
				exited: false,
				exitCode: null,
				signal: null,
				exitedPromise,
			};
			child.stdout?.on("data", (data: Buffer) => appendSessionOutput(session, data.toString()));
			child.stderr?.on("data", (data: Buffer) => appendSessionOutput(session, data.toString()));
			child.on("error", (error) => {
				appendSessionOutput(session, `${error.message}\n`);
				session.exited = true;
				session.exitCode = null;
				if (child.pid) untrackDetachedChildPid(child.pid);
				resolveExit();
			});
			child.on("close", (code, signalName) => {
				session.exited = true;
				session.exitCode = code;
				session.signal = signalName;
				if (child.pid) untrackDetachedChildPid(child.pid);
				resolveExit();
			});
			const onAbort = () => {
				if (child.pid) killProcessTree(child.pid);
			};
			if (signal) {
				if (signal.aborted) onAbort();
				else signal.addEventListener("abort", onAbort, { once: true });
			}

			const yieldMs = Math.min(Math.max(input.yield_time_ms ?? DEFAULT_YIELD_MS, 0), MAX_YIELD_MS);
			const finished = await Promise.race([
				exitedPromise.then(() => true),
				new Promise<boolean>((resolve) => setTimeout(() => resolve(false), yieldMs)),
			]);
			signal?.removeEventListener("abort", onAbort);

			if (finished) {
				const body = formatBashOutput(session.output);
				const details: BashDetails = { exitCode: session.exitCode, signal: session.signal };
				const failed = session.exitCode !== 0 || session.signal !== null || session.exitCode === null;
				const note = !failed
					? ""
					: `[exit_code: ${session.exitCode ?? "killed"}${session.signal ? ` signal: ${session.signal}` : ""}]`;
				return {
					content: [{ type: "text", text: `${body}${body && note ? "\n" : ""}${note}` }],
					details,
				};
			}

			const sessionId = randomUUID();
			shellSessions.set(sessionId, session);
			session.delivered = session.output.length;
			const body = formatBashOutput(session.output);
			return {
				content: [
					{
						type: "text",
						text: `${body}${body ? "\n" : ""}[status: running; session_id: ${sessionId}]`,
					},
				],
				details: { sessionId, running: true },
			};
		},
	};
}

export function createBashInputToolDefinition(): ToolDefinition<any, BashInputDetails> {
	return {
		name: "bash_input",
		label: "bash_input",
		description:
			"Send input to, snapshot, or terminate a running bash session using the session_id returned by bash. Each response returns only output not returned by an earlier response.",
		promptSnippet: "Send input to a running bash session",
		promptGuidelines: [],
		parameters: bashInputSchema,
		constrainedSampling: { type: "json_schema", strict: "prefer" },
		async execute(_toolCallId, input: BashInputToolInput) {
			const session = shellSessions.get(input.session_id);
			if (!session) {
				return {
					content: [{ type: "text", text: `No running bash session '${input.session_id}'.` }],
					details: {},
				};
			}

			if (input.input !== undefined && !session.exited) {
				session.child.stdin?.write(input.input);
			}
			if (input.terminate && !session.exited) {
				if (session.child.pid) killProcessTree(session.child.pid);
				await Promise.race([session.exitedPromise, new Promise<void>((resolve) => setTimeout(resolve, 2000))]);
			}

			const newOutput = session.output.slice(session.delivered);
			session.delivered = session.output.length;
			const originalOutputBytes = session.output.length;
			const status: BashInputDetails["status"] = session.exited ? "completed" : "running";
			if (session.exited) shellSessions.delete(input.session_id);

			const body = formatBashOutput(newOutput);
			const exitNote = session.exited && session.exitCode !== null ? `; exit_code: ${session.exitCode}` : "";
			return {
				content: [
					{
						type: "text",
						text: `${body}${body ? "\n" : ""}[status: ${status}; original_output_bytes: ${originalOutputBytes}${exitNote}]`,
					},
				],
				details: { status, exitCode: session.exitCode, originalOutputBytes },
			};
		},
	};
}

export function createWriteTodosToolDefinition(): ToolDefinition<typeof writeTodosSchema, undefined> {
	let todos: WriteTodosToolInput["todos"] = [];
	return {
		name: "write_todos",
		label: "write_todos",
		description:
			"Track a plan for a multi-step task. Each todo has a `text` and a `status` (pending, in_progress, completed, cancelled). The call replaces the full list.",
		promptSnippet: "Track a multi-step task as a todo list",
		promptGuidelines: ["Use write_todos for genuinely multi-step work; mark a todo completed as soon as it is done"],
		parameters: writeTodosSchema,
		constrainedSampling: { type: "json_schema", strict: "prefer" },
		execute(_toolCallId, input) {
			todos = input.todos;
			const counts: Record<TodoStatus, number> = { pending: 0, in_progress: 0, completed: 0, cancelled: 0 };
			const lines = todos.map((todo) => {
				counts[todo.status] += 1;
				return `[${todo.status}] ${todo.text}`;
			});
			const summary = `${counts.pending} pending, ${counts.in_progress} in_progress, ${counts.completed} completed, ${counts.cancelled} cancelled`;
			return Promise.resolve({
				content: [{ type: "text" as const, text: `${summary}\n${lines.join("\n")}`.trimEnd() }],
				details: undefined,
			});
		},
	};
}

export interface MuseToolsOptions {
	read?: ReadToolOptions;
	write?: WriteToolOptions;
	edit?: EditToolOptions;
	search?: GrepToolOptions;
}

export function createMuseToolDefinitions(
	cwd: string,
	options?: MuseToolsOptions,
): Record<MuseToolName, ToolDefinition<any, any>> {
	return {
		read_file: createReadFileToolDefinition(cwd, options?.read),
		write_file: createWriteFileToolDefinition(cwd, options?.write),
		edit_file: createEditFileToolDefinition(cwd, options?.edit),
		search: createSearchToolDefinition(cwd, options?.search),
		bash: createMuseBashToolDefinition(cwd),
		bash_input: createBashInputToolDefinition(),
		write_todos: createWriteTodosToolDefinition(),
	};
}

export function createMuseTools(cwd: string, options?: MuseToolsOptions): AgentTool[] {
	return Object.values(createMuseToolDefinitions(cwd, options)).map((definition) => wrapToolDefinition(definition));
}
