export {
	type BashOperations,
	type BashSpawnContext,
	type BashSpawnHook,
	type BashToolDetails,
	type BashToolInput,
	type BashToolOptions,
	createBashTool,
	createBashToolDefinition,
	createLocalBashOperations,
} from "./bash.ts";
export {
	createEditTool,
	createEditToolDefinition,
	type EditOperations,
	type EditToolDetails,
	type EditToolInput,
	type EditToolOptions,
} from "./edit.ts";
export { withFileMutationQueue } from "./file-mutation-queue.ts";
export {
	createFindTool,
	createFindToolDefinition,
	type FindOperations,
	type FindToolDetails,
	type FindToolInput,
	type FindToolOptions,
} from "./find.ts";
export {
	createGrepTool,
	createGrepToolDefinition,
	type GrepOperations,
	type GrepToolDetails,
	type GrepToolInput,
	type GrepToolOptions,
} from "./grep.ts";
export {
	createLsTool,
	createLsToolDefinition,
	type LsOperations,
	type LsToolDetails,
	type LsToolInput,
	type LsToolOptions,
} from "./ls.ts";
export {
	type BashDetails,
	type BashInputDetails,
	createBashInputToolDefinition,
	createEditFileToolDefinition,
	createMuseBashToolDefinition,
	createMuseToolDefinitions,
	createMuseTools,
	createReadFileToolDefinition,
	createSearchToolDefinition,
	createWriteFileToolDefinition,
	createWriteTodosToolDefinition,
	type EditFileToolInput,
	MUSE_READ_DEFAULT_LIMIT,
	MUSE_TOOL_NAMES,
	type MuseToolName,
	type MuseToolsOptions,
	type SearchToolInput,
	type TodoStatus,
	type WriteTodosToolInput,
} from "./muse.ts";
export {
	createLocalPowerShellOperations,
	createPowerShellTool,
	createPowerShellToolDefinition,
	type PowerShellOperations,
	type PowerShellSpawnContext,
	type PowerShellSpawnHook,
	type PowerShellToolDetails,
	type PowerShellToolInput,
	type PowerShellToolOptions,
} from "./powershell.ts";
export {
	createReadTool,
	createReadToolDefinition,
	type ReadOperations,
	type ReadToolDetails,
	type ReadToolInput,
	type ReadToolOptions,
} from "./read.ts";
export {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type TruncationOptions,
	type TruncationResult,
	truncateHead,
	truncateLine,
	truncateTail,
} from "./truncate.ts";
export {
	createWriteTool,
	createWriteToolDefinition,
	type WriteOperations,
	type WriteToolInput,
	type WriteToolOptions,
} from "./write.ts";

import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ToolDefinition } from "../extensions/types.ts";
import { type BashToolOptions, createBashTool, createBashToolDefinition } from "./bash.ts";
import { createEditTool, createEditToolDefinition, type EditToolOptions } from "./edit.ts";
import { createFindTool, createFindToolDefinition, type FindToolOptions } from "./find.ts";
import { createGrepTool, createGrepToolDefinition, type GrepToolOptions } from "./grep.ts";
import { createLsTool, createLsToolDefinition, type LsToolOptions } from "./ls.ts";
import {
	createAddMemoryToolDefinition,
	createBashInputToolDefinition,
	createEditFileToolDefinition,
	createEditMemoryToolDefinition,
	createMuseBashToolDefinition,
	createMuseToolDefinitions,
	createReadFileToolDefinition,
	createReadMemoryToolDefinition,
	createSearchToolDefinition,
	createWriteFileToolDefinition,
	createWriteTodosToolDefinition,
} from "./muse.ts";
import { createPowerShellTool, createPowerShellToolDefinition, type PowerShellToolOptions } from "./powershell.ts";
import { createReadTool, createReadToolDefinition, type ReadToolOptions } from "./read.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { createWriteTool, createWriteToolDefinition, type WriteToolOptions } from "./write.ts";

export type Tool = AgentTool<any>;
export type ToolDef = ToolDefinition<any, any>;
export type ToolName =
	| "read"
	| "bash"
	| "powershell"
	| "edit"
	| "write"
	| "grep"
	| "find"
	| "ls"
	| "read_file"
	| "write_file"
	| "edit_file"
	| "search"
	| "bash_input"
	| "read_memory"
	| "add_memory"
	| "edit_memory"
	| "write_todos";
export const allToolNames: Set<ToolName> = new Set([
	"read",
	"bash",
	"powershell",
	"edit",
	"write",
	"grep",
	"find",
	"ls",
	"read_file",
	"write_file",
	"edit_file",
	"search",
	"bash_input",
	"read_memory",
	"add_memory",
	"edit_memory",
	"write_todos",
]);

export interface ToolsOptions {
	read?: ReadToolOptions;
	bash?: BashToolOptions;
	powershell?: PowerShellToolOptions;
	write?: WriteToolOptions;
	edit?: EditToolOptions;
	grep?: GrepToolOptions;
	find?: FindToolOptions;
	ls?: LsToolOptions;
}

export function createToolDefinition(toolName: ToolName, cwd: string, options?: ToolsOptions): ToolDef {
	switch (toolName) {
		case "read":
			return createReadToolDefinition(cwd, options?.read);
		case "bash":
			return createMuseBashToolDefinition(cwd);
		case "powershell":
			return createPowerShellToolDefinition(cwd, options?.powershell);
		case "edit":
			return createEditToolDefinition(cwd, options?.edit);
		case "write":
			return createWriteToolDefinition(cwd, options?.write);
		case "grep":
			return createGrepToolDefinition(cwd, options?.grep);
		case "find":
			return createFindToolDefinition(cwd, options?.find);
		case "ls":
			return createLsToolDefinition(cwd, options?.ls);
		case "read_file":
			return createReadFileToolDefinition(cwd, options?.read);
		case "write_file":
			return createWriteFileToolDefinition(cwd, options?.write);
		case "edit_file":
			return createEditFileToolDefinition(cwd, options?.edit);
		case "search":
			return createSearchToolDefinition(cwd, options?.grep);
		case "bash_input":
			return createBashInputToolDefinition();
		case "read_memory":
			return createReadMemoryToolDefinition();
		case "add_memory":
			return createAddMemoryToolDefinition();
		case "edit_memory":
			return createEditMemoryToolDefinition();
		case "write_todos":
			return createWriteTodosToolDefinition();
		default:
			throw new Error(`Unknown tool name: ${toolName}`);
	}
}

export function createTool(toolName: ToolName, cwd: string, options?: ToolsOptions): Tool {
	switch (toolName) {
		case "read":
			return createReadTool(cwd, options?.read);
		case "bash":
			return wrapToolDefinition(createMuseBashToolDefinition(cwd));
		case "powershell":
			return createPowerShellTool(cwd, options?.powershell);
		case "edit":
			return createEditTool(cwd, options?.edit);
		case "write":
			return createWriteTool(cwd, options?.write);
		case "grep":
			return createGrepTool(cwd, options?.grep);
		case "find":
			return createFindTool(cwd, options?.find);
		case "ls":
			return createLsTool(cwd, options?.ls);
		case "read_file":
			return wrapToolDefinition(createReadFileToolDefinition(cwd, options?.read));
		case "write_file":
			return wrapToolDefinition(createWriteFileToolDefinition(cwd, options?.write));
		case "edit_file":
			return wrapToolDefinition(createEditFileToolDefinition(cwd, options?.edit));
		case "search":
			return wrapToolDefinition(createSearchToolDefinition(cwd, options?.grep));
		case "bash_input":
			return wrapToolDefinition(createBashInputToolDefinition());
		case "read_memory":
			return wrapToolDefinition(createReadMemoryToolDefinition());
		case "add_memory":
			return wrapToolDefinition(createAddMemoryToolDefinition());
		case "edit_memory":
			return wrapToolDefinition(createEditMemoryToolDefinition());
		case "write_todos":
			return wrapToolDefinition(createWriteTodosToolDefinition());
		default:
			throw new Error(`Unknown tool name: ${toolName}`);
	}
}

export function createCodingToolDefinitions(cwd: string, options?: ToolsOptions): ToolDef[] {
	return [
		createReadToolDefinition(cwd, options?.read),
		createBashToolDefinition(cwd, options?.bash),
		createEditToolDefinition(cwd, options?.edit),
		createWriteToolDefinition(cwd, options?.write),
	];
}

export function createReadOnlyToolDefinitions(cwd: string, options?: ToolsOptions): ToolDef[] {
	return [
		createReadToolDefinition(cwd, options?.read),
		createGrepToolDefinition(cwd, options?.grep),
		createFindToolDefinition(cwd, options?.find),
		createLsToolDefinition(cwd, options?.ls),
	];
}

export function createAllToolDefinitions(cwd: string, options?: ToolsOptions): Record<ToolName, ToolDef> {
	return {
		read: createReadToolDefinition(cwd, options?.read),
		powershell: createPowerShellToolDefinition(cwd, options?.powershell),
		edit: createEditToolDefinition(cwd, options?.edit),
		write: createWriteToolDefinition(cwd, options?.write),
		grep: createGrepToolDefinition(cwd, options?.grep),
		find: createFindToolDefinition(cwd, options?.find),
		ls: createLsToolDefinition(cwd, options?.ls),
		...createMuseToolDefinitions(cwd, {
			read: options?.read,
			write: options?.write,
			edit: options?.edit,
			search: options?.grep,
		}),
	};
}

export function createCodingTools(cwd: string, options?: ToolsOptions): Tool[] {
	return [
		createReadTool(cwd, options?.read),
		createBashTool(cwd, options?.bash),
		createEditTool(cwd, options?.edit),
		createWriteTool(cwd, options?.write),
	];
}

export function createReadOnlyTools(cwd: string, options?: ToolsOptions): Tool[] {
	return [
		createReadTool(cwd, options?.read),
		createGrepTool(cwd, options?.grep),
		createFindTool(cwd, options?.find),
		createLsTool(cwd, options?.ls),
	];
}

export function createAllTools(cwd: string, options?: ToolsOptions): Record<ToolName, Tool> {
	return {
		read: createReadTool(cwd, options?.read),
		powershell: createPowerShellTool(cwd, options?.powershell),
		edit: createEditTool(cwd, options?.edit),
		write: createWriteTool(cwd, options?.write),
		grep: createGrepTool(cwd, options?.grep),
		find: createFindTool(cwd, options?.find),
		ls: createLsTool(cwd, options?.ls),
		read_file: wrapToolDefinition(createReadFileToolDefinition(cwd, options?.read)),
		write_file: wrapToolDefinition(createWriteFileToolDefinition(cwd, options?.write)),
		edit_file: wrapToolDefinition(createEditFileToolDefinition(cwd, options?.edit)),
		search: wrapToolDefinition(createSearchToolDefinition(cwd, options?.grep)),
		bash: wrapToolDefinition(createMuseBashToolDefinition(cwd)),
		bash_input: wrapToolDefinition(createBashInputToolDefinition()),
		read_memory: wrapToolDefinition(createReadMemoryToolDefinition()),
		add_memory: wrapToolDefinition(createAddMemoryToolDefinition()),
		edit_memory: wrapToolDefinition(createEditMemoryToolDefinition()),
		write_todos: wrapToolDefinition(createWriteTodosToolDefinition()),
	};
}
