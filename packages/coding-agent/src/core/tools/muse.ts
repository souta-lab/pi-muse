import { type ChildProcess, spawn } from "node:child_process";
import { type Dirent, existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";
import { getAgentDir } from "../../config.ts";
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
import { runMuseSearch } from "./muse-search.ts";
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
	"read_memory",
	"add_memory",
	"edit_memory",
	"read_skill",
	"work_status",
	"work_stop",
	"web_search",
	"write_todos",
] as const;

export type MuseToolName = (typeof MUSE_TOOL_NAMES)[number];

/** Subagent tools registered dynamically by the muse-subagents bridge when installed. */
export const MUSE_SUBAGENT_TOOL_NAMES = [
	"subagent_spawn",
	"subagent_status",
	"subagent_wait",
	"subagent_read_result",
	"subagent_cancel",
] as const;

export const MUSE_READ_DEFAULT_LIMIT = 500;
const DEFAULT_YIELD_MS = 10_000;
const MAX_YIELD_MS = 300_000;
const SESSION_OUTPUT_CAP = 2 * 50 * 1024;

const readFileSchema = Type.Object({
	path: Type.String({
		description:
			"Path of ONE regular file to read. Never a directory — a directory path fails with 'not a regular file'; list directories with the bash tool instead.",
	}),
	offset: Type.Optional(
		Type.Integer({
			minimum: 1,
			description: "1-based line number where the text read window starts. Defaults to 1.",
		}),
	),
	limit: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: 2000,
			description: "Maximum number of text lines to return. Defaults to 500.",
		}),
	),
});

const writeFileSchema = Type.Object({
	path: Type.String({ description: "Path to create or overwrite." }),
	content: Type.String({
		description:
			"Complete UTF-8 file content to write. Keep it modest; for a large file write a first chunk and append the rest with edit_file, since one very large content value can fail to send.",
	}),
});

const editFileSchema = Type.Object({
	path: Type.String({ description: "Path to edit." }),
	find: Type.String({ description: "Exact text to replace." }),
	replace: Type.String({ description: "Replacement text." }),
});

export type EditFileToolInput = Static<typeof editFileSchema>;

const searchSchema = Type.Object({
	pattern: Type.String({ description: "Regex or literal pattern to search for in file contents." }),
	paths: Type.Optional(
		Type.Array(Type.String(), { description: "Files or directories to search. Omit to search the root." }),
	),
	glob: Type.Optional(
		Type.Array(Type.String(), {
			description: "Ripgrep-style include or exclude globs. Prefix a glob with ! to exclude.",
		}),
	),
	hidden: Type.Optional(Type.Boolean({ description: "Include hidden files and directories." })),
	no_ignore: Type.Optional(
		Type.Boolean({ description: "Disable ignore-file filtering while preserving runtime work limits." }),
	),
	follow_symlinks: Type.Optional(
		Type.Boolean({ description: "Follow symlinks admitted by the current filesystem policy." }),
	),
	binary: Type.Optional(Type.String({ description: "Skip binary files or search them as text. Defaults to skip." })),
	output_mode: Type.Optional(
		Type.String({ description: "Return rg-like text, JSON lines, or only files with matches." }),
	),
	mode: Type.Optional(
		Type.String({ description: "Interpret pattern as a regex or as literal text. Defaults to literal." }),
	),
	case_sensitive: Type.Optional(Type.Boolean({ description: "Force case-sensitive or case-insensitive matching." })),
	smart_case: Type.Optional(Type.Boolean({ description: "Use smart-case matching when case_sensitive is not set." })),
	whole_line: Type.Optional(Type.Boolean({ description: "Only report matches that span an entire line." })),
	word: Type.Optional(Type.Boolean({ description: "Only report matches surrounded by word boundaries." })),
	context_before: Type.Optional(
		Type.Integer({ description: "Number of context lines to include before each match." }),
	),
	context_after: Type.Optional(Type.Integer({ description: "Number of context lines to include after each match." })),
	max_matches: Type.Optional(Type.Integer({ description: "Maximum matches to return before stopping early." })),
});

export type SearchToolInput = Static<typeof searchSchema>;

const bashSchema = Type.Object({
	command: Type.String({ description: "Bash-compatible shell command to execute." }),
	description: Type.String({
		description:
			"3-8 words; one line; sentence case; begin with a base-form action verb; avoid lifecycle or outcome words; no final period",
	}),
	yield_time_ms: Type.Optional(
		Type.Integer({
			minimum: 0,
			description: "Milliseconds to wait before returning output. Defaults to 10000ms, capped at 300000ms.",
		}),
	),
	timeout_ms: Type.Optional(
		Type.Integer({
			minimum: 1,
			description:
				"Optional hard kill deadline in milliseconds; when it expires the process is killed and reported as timed_out.",
		}),
	),
	workdir: Type.Optional(
		Type.String({ description: "Optional working directory. Omit to run in the workspace root." }),
	),
	shell: Type.Optional(Type.String({ description: "Shell executable to run." })),
	login: Type.Optional(Type.Boolean({ description: "Run the shell with login semantics." })),
	tty: Type.Optional(Type.Boolean({ description: "Allocate a PTY for interactive commands." })),
	max_output_tokens: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum visible output budget." })),
	sandbox_permissions: Type.Optional(
		Type.Union([Type.Literal("use_default"), Type.Literal("require_escalated")], {
			description: "Per-command sandbox override. Accepted but not enforced by pi-muse.",
		}),
	),
});

export type BashInput = Static<typeof bashSchema>;

const bashInputSchema = Type.Object({
	session_id: Type.Integer({ description: "Internal bash session ID returned by bash." }),
	chars: Type.Optional(Type.String({ description: "Characters to write. Empty or omitted means poll only." })),
	terminate: Type.Optional(Type.Boolean({ description: "Terminate the live session instead of writing input." })),
	yield_time_ms: Type.Optional(
		Type.Integer({
			minimum: 0,
			description:
				"Milliseconds to wait before returning output. Defaults to 250ms when chars are sent, 5000ms for an empty poll.",
		}),
	),
	max_output_tokens: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum visible output budget." })),
});

export type BashInputToolInput = Static<typeof bashInputSchema>;

const memoryScopeSchema = Type.Union(
	[Type.Literal("personal_project"), Type.Literal("personal"), Type.Literal("project")],
	{ description: "Memory scope. Defaults to personal_project." },
);

const readMemorySchema = Type.Object({
	path: Type.String({ description: "Relative Markdown path under the selected memory scope root." }),
	offset: Type.Optional(
		Type.Integer({ minimum: 1, description: "1-based line number where the read window starts. Defaults to 1." }),
	),
	limit: Type.Optional(
		Type.Integer({ minimum: 1, description: "Maximum number of lines to return. Defaults to 500." }),
	),
	scope: Type.Optional(memoryScopeSchema),
});

const addMemorySchema = Type.Object({
	path: Type.String({ description: "Relative Markdown path under the selected memory scope root." }),
	content: Type.String({ description: "Markdown content to append. Existing file content is preserved." }),
	description: Type.Optional(Type.String({ description: "Optional short summary for future recall." })),
	type: Type.Optional(Type.String({ description: "Optional memory note type for future recall." })),
	scope: Type.Optional(memoryScopeSchema),
});

const editMemorySchema = Type.Object({
	path: Type.String({ description: "Relative Markdown path under the selected memory scope root." }),
	old_str: Type.String({ description: "Exact text to replace. Must match exactly once." }),
	new_str: Type.String({ description: "Replacement text. May be empty." }),
	scope: Type.Optional(memoryScopeSchema),
});

const todoStatusSchema = Type.Union([
	Type.Literal("pending"),
	Type.Literal("in_progress"),
	Type.Literal("completed"),
	Type.Literal("cancelled"),
]);

const writeTodosSchema = Type.Object({
	todos: Type.Array(
		Type.Object({
			text: Type.String({ description: "Todo item text." }),
			status: todoStatusSchema,
		}),
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
	sessionId?: number;
	notified?: boolean;
	waiters: Array<() => void>;
}

export interface ShellSessionExit {
	sessionId: number;
	output: string;
	exitCode: number | null;
	signal: NodeJS.Signals | null;
}

const shellSessions = new Map<number, MuseShellSession>();
let nextSessionId = 1;
const shellExitListeners = new Set<(event: ShellSessionExit) => void>();

/** Subscribe to background shell sessions finishing so callers can wake the agent. */
export function onShellSessionExit(listener: (event: ShellSessionExit) => void): () => void {
	shellExitListeners.add(listener);
	return () => shellExitListeners.delete(listener);
}

function notifyShellSessionExit(session: MuseShellSession, maxBytes: number): void {
	if (session.sessionId === undefined || session.notified) return;
	session.notified = true;
	const event: ShellSessionExit = {
		sessionId: session.sessionId,
		output: capOutput(session.output, maxBytes),
		exitCode: session.exitCode,
		signal: session.signal,
	};
	for (const listener of shellExitListeners) {
		try {
			listener(event);
		} catch {
			// A failing listener must not break the shell session.
		}
	}
}

function appendSessionOutput(session: MuseShellSession, text: string): void {
	session.output += text;
	if (session.output.length > SESSION_OUTPUT_CAP) {
		const overflow = session.output.length - SESSION_OUTPUT_CAP;
		session.output = session.output.slice(overflow);
		session.delivered = Math.max(0, session.delivered - overflow);
	}
}

function capOutput(text: string, maxBytes?: number): string {
	const budget = maxBytes && maxBytes > 0 ? maxBytes : 50 * 1024;
	const truncation = truncateTail(text, { maxLines: 2000, maxBytes: budget });
	if (!truncation.truncated) return truncation.content;
	return `${truncation.content}\n[output truncated to the last ${truncation.outputLines} lines]`;
}

function tokensToBytes(maxOutputTokens?: number): number | undefined {
	return maxOutputTokens && maxOutputTokens > 0 ? maxOutputTokens * 4 : undefined;
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

const SCRIPT_PATHS = ["/usr/bin/script", "/bin/script", "/usr/local/bin/script"];
let cachedScriptPath: string | null | undefined;

function resolveScriptPath(): string | null {
	if (cachedScriptPath === undefined) {
		cachedScriptPath = process.platform === "linux" ? (SCRIPT_PATHS.find((path) => existsSync(path)) ?? null) : null;
	}
	return cachedScriptPath;
}

function normalizeShellOutput(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "");
}

interface SpawnedShellCommand {
	child: ChildProcess;
	pty: boolean;
}

function spawnShellCommand(
	command: string,
	cwd: string,
	env: NodeJS.ProcessEnv,
	options: { shell?: string; login?: boolean; tty?: boolean },
): SpawnedShellCommand {
	const shellConfig = getShellConfig(options.shell);
	const shellPath = shellConfig.shell;
	const shellArgs = options.login ? ["-lc", command] : ["-c", command];
	const scriptPath = resolveScriptPath();
	const usePty = options.tty !== false && scriptPath !== null;
	if (usePty && scriptPath) {
		const child = spawn(
			scriptPath,
			["-q", "-e", "-c", `${shellPath} ${options.login ? "-lc" : "-c"} ${shellQuote(command)}`, "/dev/null"],
			{
				cwd,
				env: { ...env, SHELL: shellPath },
				detached: process.platform !== "win32",
				stdio: ["pipe", "pipe", "pipe"],
				windowsHide: true,
			},
		);
		return { child, pty: true };
	}
	const child = spawn(shellPath, shellArgs, {
		cwd,
		detached: process.platform !== "win32",
		env,
		stdio: ["pipe", "pipe", "pipe"],
		windowsHide: true,
	});
	return { child, pty: false };
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

const VIDEO_MIME: Record<string, string> = { mp4: "video/mp4", mov: "video/quicktime" };

function isNoticeLine(line: string): boolean {
	return /^\s*\[/.test(line);
}

function formatReadFileResult(path: string, startLine: number, text: string): string {
	const trimmed = text.endsWith("\n") ? text.slice(0, -1) : text;
	let n = startLine;
	const numbered = trimmed.split("\n").map((line) => {
		if (isNoticeLine(line)) return line;
		const value = `${n}|${line}`;
		n += 1;
		return value;
	});
	return `Read text file \`${path}\`.\n${numbered.join("\n")}`;
}

function videoMimeFor(path: string): string | undefined {
	const match = /\.([a-z0-9]+)$/i.exec(path);
	return match ? VIDEO_MIME[match[1].toLowerCase()] : undefined;
}

export function createReadFileToolDefinition(cwd: string, options?: ReadToolOptions): ToolDefinition<any, any> {
	const base = createReadToolDefinition(cwd, options);
	return {
		name: "read_file",
		label: "read_file",
		description:
			"Read a line-numbered UTF-8 text file window, or attach a supported image or MP4/MOV video file as model-visible output.",
		promptSnippet: base.promptSnippet,
		promptGuidelines: base.promptGuidelines,
		parameters: readFileSchema,
		constrainedSampling: base.constrainedSampling,
		prepareArguments: (args: unknown) => {
			const input = args as { path: string; offset?: number; limit?: number };
			return { path: input.path, offset: input.offset, limit: input.limit ?? MUSE_READ_DEFAULT_LIMIT };
		},
		execute(toolCallId, input, signal, onUpdate, ctx) {
			const typed = input as { path: string; offset?: number; limit?: number };
			const mime = videoMimeFor(typed.path);
			if (mime) {
				return Promise.resolve({
					content: [{ type: "text" as const, text: `Read video file [${mime}]` }],
					details: undefined,
				});
			}
			return Promise.resolve(base.execute(toolCallId, typed, signal, onUpdate, ctx))
				.then((result) => {
					const content = result.content as Array<{ type: string; text?: string }>;
					if (content.some((item) => item.type === "image")) return result;
					const text = content.map((item) => (item.type === "text" ? (item.text ?? "") : "")).join("");
					return {
						...result,
						content: [{ type: "text" as const, text: formatReadFileResult(typed.path, typed.offset ?? 1, text) }],
					};
				})
				.catch((error: unknown) => {
					const message = error instanceof Error ? error.message : String(error);
					if (/EISDIR|illegal operation on a directory|is a directory/i.test(message)) {
						throw new Error(
							`Cannot read \`${typed.path}\`: not a regular file. Use bash (e.g. ls) to list directories.`,
						);
					}
					throw error;
				});
		},
	};
}

export function createWriteFileToolDefinition(cwd: string, options?: WriteToolOptions): ToolDefinition<any, any> {
	const base = createWriteToolDefinition(cwd, options);
	return {
		name: "write_file",
		label: "write_file",
		description:
			"Create or overwrite a complete UTF-8 file. For a LARGE file, write a small first chunk here and then grow it with edit_file; one huge write can exceed a single model response and fail to send.",
		promptSnippet: base.promptSnippet,
		promptGuidelines: base.promptGuidelines,
		parameters: writeFileSchema,
		constrainedSampling: base.constrainedSampling,
		execute(toolCallId, input, signal, onUpdate, ctx) {
			const typed = input as { path: string; content: string };
			return Promise.resolve(base.execute(toolCallId, typed, signal, onUpdate, ctx)).then((result) => ({
				...result,
				content: [
					{
						type: "text" as const,
						text: `wrote ${Buffer.byteLength(typed.content, "utf-8")} bytes to ${typed.path}`,
					},
				],
			}));
		},
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
			"Replace one unique exact text match in a file. Also use this to grow a large file in steps: match its current last line(s) and replace them with those line(s) plus more.",
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

export function createSearchToolDefinition(cwd: string): ToolDefinition<any, any> {
	return {
		name: "search",
		label: "search",
		description:
			"Search files with native ripgrep semantics. Results are confined to the workspace and respect ignore files by default.",
		promptSnippet: "Search file contents for patterns (respects .gitignore)",
		parameters: searchSchema,
		constrainedSampling: { type: "json_schema", strict: "prefer" },
		execute(_toolCallId, input: SearchToolInput, _signal, _onUpdate, ctx) {
			return runMuseSearch(cwd, input, ctx);
		},
	};
}

export interface BashDetails {
	exitCode?: number | null;
	signal?: string | null;
	sessionId?: number;
	running?: boolean;
	timedOut?: boolean;
}

export function createMuseBashToolDefinition(cwd: string): ToolDefinition<any, BashDetails> {
	return {
		name: "bash",
		label: "bash",
		description:
			"Run a bash-compatible shell command. Waits in the foreground up to yield_time_ms (default 10000ms), then returns an internal session_id for a still-running command; its final output arrives later as runtime context.",
		promptSnippet: "Execute bash commands",
		promptGuidelines: [...bashToolSystemPromptContribution.guidelines],
		parameters: bashSchema,
		constrainedSampling: { type: "json_schema", strict: "prefer" },
		async execute(_toolCallId, input: BashInput, signal, _onUpdate, ctx) {
			const baseCwd = ctx?.cwd || cwd;
			const workingDir = input.workdir ? resolve(baseCwd, input.workdir) : baseCwd;
			const { child, pty } = spawnShellCommand(input.command, workingDir, buildBashEnv(ctx), {
				shell: input.shell,
				login: input.login,
				tty: input.tty,
			});
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
				waiters: [],
			};
			const maxBytes = tokensToBytes(input.max_output_tokens);
			const onData = (data: Buffer) => {
				appendSessionOutput(session, pty ? normalizeShellOutput(data.toString()) : data.toString());
				for (const waiter of session.waiters.splice(0)) waiter();
			};
			child.stdout?.on("data", onData);
			child.stderr?.on("data", onData);
			child.on("error", (error) => {
				appendSessionOutput(session, `${error.message}\n`);
				session.exited = true;
				session.exitCode = null;
				if (child.pid) untrackDetachedChildPid(child.pid);
				resolveExit();
				notifyShellSessionExit(session, maxBytes ?? 50 * 1024);
			});
			child.on("close", (code, signalName) => {
				session.exited = true;
				session.exitCode = code;
				session.signal = signalName;
				if (child.pid) untrackDetachedChildPid(child.pid);
				resolveExit();
				notifyShellSessionExit(session, maxBytes ?? 50 * 1024);
			});
			let timedOut = false;
			const hardKill = input.timeout_ms
				? setTimeout(() => {
						timedOut = true;
						if (child.pid) killProcessTree(child.pid);
					}, input.timeout_ms)
				: undefined;
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
			if (hardKill) clearTimeout(hardKill);

			if (finished) {
				const body = capOutput(session.output, maxBytes);
				const payload: Record<string, unknown> = {
					command: input.command,
					description: input.description,
					output: body,
					exit_code: session.exitCode,
				};
				if (timedOut) payload.status = "timed_out";
				if (session.signal) payload.signal = session.signal;
				return {
					content: [{ type: "text", text: JSON.stringify(payload) }],
					details: { exitCode: session.exitCode, signal: session.signal, timedOut },
				};
			}

			const sessionId = nextSessionId++;
			shellSessions.set(sessionId, session);
			session.sessionId = sessionId;
			session.delivered = session.output.length;
			if (session.exited) notifyShellSessionExit(session, maxBytes ?? 50 * 1024);
			const body = capOutput(session.output, maxBytes);
			return {
				content: [
					{
						type: "text",
						text: JSON.stringify({
							command: input.command,
							description: input.description,
							output: body,
							status: "running",
							session_id: sessionId,
						}),
					},
				],
				details: { sessionId, running: true },
			};
		},
	};
}

export interface BashInputDetails {
	status?: "running" | "completed";
	exitCode?: number | null;
	originalOutputBytes?: number;
}

export function createBashInputToolDefinition(): ToolDefinition<any, BashInputDetails> {
	return {
		name: "bash_input",
		label: "bash_input",
		description:
			"Send input to, or terminate, a running bash session using the session_id returned by bash. Each response returns only output not returned by an earlier response; original_output_bytes remains cumulative.",
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
			const maxBytes = tokensToBytes(input.max_output_tokens);
			const hasChars = input.chars !== undefined && input.chars.length > 0;
			const waitMs = Math.min(
				Math.max(input.yield_time_ms ?? (hasChars ? 250 : 5000), 0),
				hasChars ? 30_000 : MAX_YIELD_MS,
			);

			if (hasChars && !session.exited) {
				session.child.stdin?.write(input.chars);
				await Promise.race([
					new Promise<void>((resolve) => session.waiters.push(resolve)),
					new Promise<void>((resolve) => setTimeout(resolve, waitMs)),
				]);
			} else if (!input.terminate && !session.exited && waitMs > 0) {
				await Promise.race([session.exitedPromise, new Promise<void>((resolve) => setTimeout(resolve, waitMs))]);
			}
			if (input.terminate && !session.exited) {
				if (session.child.pid) killProcessTree(session.child.pid);
				await Promise.race([session.exitedPromise, new Promise<void>((resolve) => setTimeout(resolve, 5000))]);
			}

			const newOutput = session.output.slice(session.delivered);
			session.delivered = session.output.length;
			const originalOutputBytes = session.output.length;
			const status: BashInputDetails["status"] = session.exited ? "completed" : "running";
			if (session.exited) shellSessions.delete(input.session_id);
			const body = capOutput(newOutput, maxBytes);
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

function memoryRoot(scope: string | undefined): string {
	const base = join(getAgentDir(), "memory");
	return scope && scope !== "personal_project" ? join(base, scope) : base;
}

function resolveMemoryPath(scope: string | undefined, relativePath: string): string {
	const root = memoryRoot(scope);
	const full = resolve(root, relativePath);
	const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
	if (full !== root && !full.startsWith(prefix)) {
		throw new Error(`Memory path escapes its scope root: ${relativePath}`);
	}
	if (!full.endsWith(".md")) {
		throw new Error("Memory files must use the .md extension");
	}
	return full;
}

function toPosix(p: string): string {
	return p.split(sep).join("/");
}

export function createReadMemoryToolDefinition(): ToolDefinition<any, undefined> {
	return {
		name: "read_memory",
		label: "read_memory",
		description: "Read a bounded line window from one local Markdown memory file. Reads never write to memory.",
		promptSnippet: "Read a local memory file",
		parameters: readMemorySchema,
		execute(_toolCallId, input: Static<typeof readMemorySchema>) {
			const full = resolveMemoryPath(input.scope, input.path);
			return (async () => {
				const text = await readFile(full, "utf-8");
				const lines = text.split("\n");
				const start = Math.max(0, (input.offset ?? 1) - 1);
				const limit = input.limit ?? 500;
				const window = lines.slice(start, start + limit);
				const labeled = window.map((line, index) => `${start + index + 1}|${line}`).join("\n");
				return { content: [{ type: "text" as const, text: labeled }], details: undefined };
			})();
		},
	};
}

export function createAddMemoryToolDefinition(): ToolDefinition<any, undefined> {
	return {
		name: "add_memory",
		label: "add_memory",
		description:
			"Add Markdown content to local memory: creates the file when missing, appends when it exists, and does not overwrite existing content.",
		promptSnippet: "Append to a local memory file",
		parameters: addMemorySchema,
		execute(_toolCallId, input: Static<typeof addMemorySchema>) {
			const full = resolveMemoryPath(input.scope, input.path);
			return (async () => {
				await mkdir(dirname(full), { recursive: true });
				let existing = "";
				try {
					existing = await readFile(full, "utf-8");
				} catch {}
				const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
				await writeFile(full, `${existing}${separator}${input.content}`, "utf-8");
				return {
					content: [{ type: "text" as const, text: `Appended to memory ${toPosix(input.path)}` }],
					details: undefined,
				};
			})();
		},
	};
}

export function createEditMemoryToolDefinition(): ToolDefinition<any, undefined> {
	return {
		name: "edit_memory",
		label: "edit_memory",
		description:
			"Replace one exact string in local memory. The edit fails unless old_str appears exactly once; use add_memory to append new content.",
		promptSnippet: "Edit a local memory file",
		parameters: editMemorySchema,
		execute(_toolCallId, input: Static<typeof editMemorySchema>) {
			const full = resolveMemoryPath(input.scope, input.path);
			return (async () => {
				const text = await readFile(full, "utf-8");
				const first = text.indexOf(input.old_str);
				if (first < 0) throw new Error(`old_str not found in memory ${toPosix(input.path)}`);
				if (text.indexOf(input.old_str, first + 1) >= 0) {
					throw new Error(`old_str appears more than once in memory ${toPosix(input.path)}`);
				}
				const updated = `${text.slice(0, first)}${input.new_str}${text.slice(first + input.old_str.length)}`;
				await writeFile(full, updated, "utf-8");
				return {
					content: [{ type: "text" as const, text: `Updated memory ${toPosix(input.path)}` }],
					details: undefined,
				};
			})();
		},
	};
}

const readSkillSchema = Type.Object({
	name: Type.String({ description: "Skill name, id, or display path from the skills catalog." }),
});

export function createReadSkillToolDefinition(cwd: string): ToolDefinition<any, undefined> {
	return {
		name: "read_skill",
		label: "read_skill",
		description: "Read one available SKILL.md body as a tool result.",
		promptSnippet: "Read a skill's SKILL.md",
		parameters: readSkillSchema,
		execute(_toolCallId, input: Static<typeof readSkillSchema>) {
			return (async () => {
				const wanted = input.name.replace(/^(bundled|plugin|project|personal):\/\//, "");
				const roots = [join(cwd, ".pi", "skills"), join(getAgentDir(), "skills")];
				for (const root of roots) {
					if (!existsSync(root)) continue;
					let entries: Dirent[];
					try {
						entries = await readdir(root, { recursive: true, withFileTypes: true });
					} catch {
						continue;
					}
					for (const entry of entries) {
						if (!entry.isFile() || entry.name !== "SKILL.md") continue;
						const parent = entry.parentPath ?? root;
						const filePath = join(parent, "SKILL.md");
						const body = await readFile(filePath, "utf-8");
						const frontmatterName = /^---\s*\n[\s\S]*?\nname:\s*(.+?)\s*\n[\s\S]*?\n---/.exec(body)?.[1];
						const candidates = [basename(parent), filePath, frontmatterName].filter(
							(value): value is string => typeof value === "string" && value.length > 0,
						);
						if (candidates.includes(input.name) || candidates.includes(wanted)) {
							return { content: [{ type: "text" as const, text: body }], details: undefined };
						}
					}
				}
				throw new Error(`Skill not found: ${input.name}`);
			})();
		},
	};
}

const workIdSchema = Type.Object({
	work_id: Type.String({ description: "Canonical Work ID, e.g. a background bash session id." }),
});

function resolveWorkSession(workId: string): { id: number; session: MuseShellSession } {
	const id = Number(workId);
	if (!Number.isInteger(id)) throw new Error(`Unknown work id: ${workId}`);
	const session = shellSessions.get(id);
	if (!session) throw new Error(`Work item not found: ${workId}`);
	return { id, session };
}

export function createWorkStatusToolDefinition(): ToolDefinition<any, undefined> {
	return {
		name: "work_status",
		label: "work_status",
		description: "Read the current state of one Work item by its canonical Work ID (a background bash session id).",
		promptSnippet: "Check a background work item",
		parameters: workIdSchema,
		execute(_toolCallId, input: Static<typeof workIdSchema>) {
			const { id, session } = resolveWorkSession(input.work_id);
			const status = session.exited ? "completed" : "running";
			const exitNote = session.exited && session.exitCode !== null ? `, exit_code ${session.exitCode}` : "";
			return Promise.resolve({
				content: [
					{
						type: "text" as const,
						text: `work_id ${id}: ${status}${exitNote}; output_bytes ${session.output.length}`,
					},
				],
				details: undefined,
			});
		},
	};
}

export function createWorkStopToolDefinition(): ToolDefinition<any, undefined> {
	return {
		name: "work_stop",
		label: "work_stop",
		description: "Stop one runtime-owned work item by canonical Work ID (terminates the background bash session).",
		promptSnippet: "Stop a background work item",
		parameters: workIdSchema,
		execute(_toolCallId, input: Static<typeof workIdSchema>) {
			return (async () => {
				const { id, session } = resolveWorkSession(input.work_id);
				if (!session.exited && session.child.pid) killProcessTree(session.child.pid);
				await Promise.race([session.exitedPromise, new Promise<void>((resolve) => setTimeout(resolve, 5000))]);
				return {
					content: [
						{
							type: "text" as const,
							text: `Stopped work_id ${id}; status ${session.exited ? "completed" : "stopping"}`,
						},
					],
					details: undefined,
				};
			})();
		},
	};
}

const webSearchSchema = Type.Object({
	query: Type.String({ description: "Search query." }),
});

export function createWebSearchToolDefinition(): ToolDefinition<any, undefined> {
	return {
		name: "web_search",
		label: "web_search",
		description: "Search the web and return a short list of source results with title, URL, and snippet.",
		promptSnippet: "Search the web",
		parameters: webSearchSchema,
		execute(_toolCallId, input: Static<typeof webSearchSchema>) {
			return (async () => {
				const exa = process.env.EXA_API_KEY;
				const brave = process.env.BRAVE_API_KEY;
				if (exa) {
					const response = await fetch("https://api.exa.ai/search", {
						method: "POST",
						headers: { "Content-Type": "application/json", "x-api-key": exa },
						body: JSON.stringify({ query: input.query, numResults: 5, type: "auto" }),
					});
					if (!response.ok) throw new Error(`Exa search failed: ${response.status}`);
					const payload = (await response.json()) as {
						results?: Array<{ title?: string; url?: string; text?: string }>;
					};
					const lines = (payload.results ?? []).map(
						(r) => `- ${r.title ?? ""} ${r.url ?? ""}\n  ${(r.text ?? "").slice(0, 200)}`,
					);
					return {
						content: [{ type: "text" as const, text: lines.join("\n") || "No results." }],
						details: undefined,
					};
				}
				if (brave) {
					const response = await fetch(
						`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(input.query)}`,
						{ headers: { Accept: "application/json", "X-Subscription-Token": brave } },
					);
					if (!response.ok) throw new Error(`Brave search failed: ${response.status}`);
					const payload = (await response.json()) as {
						web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
					};
					const lines = (payload.web?.results ?? [])
						.slice(0, 5)
						.map((r) => `- ${r.title ?? ""} ${r.url ?? ""}\n  ${(r.description ?? "").slice(0, 200)}`);
					return {
						content: [{ type: "text" as const, text: lines.join("\n") || "No results." }],
						details: undefined,
					};
				}
				throw new Error("web_search is not configured: set EXA_API_KEY or BRAVE_API_KEY");
			})();
		},
	};
}

export function createWriteTodosToolDefinition(): ToolDefinition<typeof writeTodosSchema, undefined> {
	let todos: WriteTodosToolInput["todos"] = [];
	return {
		name: "write_todos",
		label: "write_todos",
		description:
			"Records the task's todo plan. Call it at the start of any task with three or more distinct steps, then update it as each step finishes. Always send the full list; keep exactly one item in_progress.",
		promptSnippet: "Track a multi-step task as a todo list",
		promptGuidelines: ["Use write_todos for genuinely multi-step work; mark a todo completed as soon as it is done"],
		parameters: writeTodosSchema,
		constrainedSampling: { type: "json_schema", strict: "prefer" },
		async execute(_toolCallId, input) {
			if (input.todos.filter((todo) => todo.status === "in_progress").length > 1) {
				throw new Error("write_todos: keep at most one todo in_progress");
			}
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
}

export function createMuseToolDefinitions(
	cwd: string,
	options?: MuseToolsOptions,
): Record<MuseToolName, ToolDefinition<any, any>> {
	return {
		read_file: createReadFileToolDefinition(cwd, options?.read),
		write_file: createWriteFileToolDefinition(cwd, options?.write),
		edit_file: createEditFileToolDefinition(cwd, options?.edit),
		search: createSearchToolDefinition(cwd),
		bash: createMuseBashToolDefinition(cwd),
		bash_input: createBashInputToolDefinition(),
		read_memory: createReadMemoryToolDefinition(),
		add_memory: createAddMemoryToolDefinition(),
		edit_memory: createEditMemoryToolDefinition(),
		read_skill: createReadSkillToolDefinition(cwd),
		work_status: createWorkStatusToolDefinition(),
		work_stop: createWorkStopToolDefinition(),
		web_search: createWebSearchToolDefinition(),
		write_todos: createWriteTodosToolDefinition(),
	};
}

export function createMuseTools(cwd: string, options?: MuseToolsOptions): AgentTool[] {
	return Object.values(createMuseToolDefinitions(cwd, options)).map((definition) => wrapToolDefinition(definition));
}
