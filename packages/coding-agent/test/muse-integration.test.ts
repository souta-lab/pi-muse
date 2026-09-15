import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Model, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentSessionFromServices, createAgentSessionServices } from "../src/core/agent-session-services.ts";
import type { ExtensionUIContext } from "../src/core/extensions/types.ts";
import { MUSE_SYSTEM_PROMPT } from "../src/core/muse-system-prompt.ts";
import { resolvePermissionMode } from "../src/core/permissions/permission-mode.ts";
import { recordReminderSnooze, resetReminderSnoozes } from "../src/core/reminders/index.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { MUSE_SUBAGENT_TOOL_NAMES, MUSE_TOOL_NAMES } from "../src/core/tools/muse.ts";
import { builtInExtensions } from "../src/extensions/index.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

const SSE_COMPLETION_BODY = `${[
	`data: ${JSON.stringify({
		type: "response.completed",
		sequence_number: 1,
		response: {
			id: "resp_muse_integration",
			status: "completed",
			output: [
				{
					type: "message",
					id: "msg_muse_integration",
					role: "assistant",
					status: "completed",
					content: [{ type: "output_text", text: "Hi", annotations: [] }],
				},
			],
			usage: {
				input_tokens: 1,
				output_tokens: 1,
				total_tokens: 2,
				input_tokens_details: { cached_tokens: 0 },
			},
		},
	})}`,
].join("\n\n")}\n\ndata: [DONE]\n\n`;

function museModel(): Model<"openai-responses"> {
	return {
		id: "muse-spark-1.3-contributor",
		name: "Muse Spark 1.3 Contributor",
		api: "openai-responses",
		provider: "muse",
		baseUrl: "https://api.meta.ai/v1",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0.1, output: 0.2, cacheRead: 0.002, cacheWrite: 0 },
		contextWindow: 1_007_997,
		maxTokens: 32_768,
		thinkingLevelMap: {
			off: null,
			minimal: "minimal",
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "xhigh",
			max: "max",
		},
		compat: {
			supportsInstructionsField: true,
			toolNamespace: { name: "muse", description: "Muse Code tool set." },
		},
	};
}

function countingTool(
	name: string,
	parameters = Type.Object({ path: Type.Optional(Type.String()) }),
): {
	tool: AgentTool;
	calls: () => number;
} {
	let count = 0;
	const tool: AgentTool = {
		name,
		label: name,
		description: `${name} integration probe`,
		parameters,
		execute: async () => {
			count += 1;
			return { content: [{ type: "text", text: `${name} executed` }], details: undefined };
		},
	};
	return { tool, calls: () => count };
}

function fakeUiContext(confirm: (title: string, message: string) => Promise<boolean>): ExtensionUIContext {
	return { confirm } as unknown as ExtensionUIContext;
}

function toolResults(messages: AgentMessage[]): ToolResultMessage[] {
	return messages.filter((message): message is ToolResultMessage => message.role === "toolResult");
}

function requestText(body: string): string {
	const payload = JSON.parse(body) as { input?: Array<{ content?: unknown }> };
	return (payload.input ?? []).map(contentToText).join("\n");
}

function contentToText(message: { content?: unknown }): string {
	const content = message.content;
	if (typeof content === "string") {
		return content;
	}
	if (Array.isArray(content)) {
		return content
			.map((part) => {
				if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
					return (part as { text: string }).text;
				}
				return "";
			})
			.join("");
	}
	return "";
}

function assistantWithToolCall(id: string, name: string): AssistantMessage {
	const call: ToolCall = { type: "toolCall", id, name, arguments: {} };
	return {
		role: "assistant",
		content: [call],
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

describe("approval gate wiring", () => {
	const harnesses: Harness[] = [];
	const tempDirs: string[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
		resetReminderSnoozes();
		vi.restoreAllMocks();
	});

	it("denies a mutating tool with no UI and never calls execute", async () => {
		const { tool, calls } = countingTool("write_file");
		const harness = await createHarness({
			tools: [tool],
			initialActiveToolNames: ["write_file"],
			permissionMode: resolvePermissionMode(),
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("write_file", { path: "x" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("go");

		expect(calls()).toBe(0);
		const results = toolResults(harness.session.messages);
		expect(results).toHaveLength(1);
		expect(results[0].isError).toBe(true);
		expect(results[0].content[0]).toMatchObject({ type: "text", text: expect.stringContaining("write_file") });
	});

	it("allows the same mutating tool under --yolo", async () => {
		const { tool, calls } = countingTool("write_file");
		const harness = await createHarness({
			tools: [tool],
			initialActiveToolNames: ["write_file"],
			permissionMode: resolvePermissionMode({ yolo: true }),
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("write_file", { path: "x" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("go");

		expect(calls()).toBe(1);
		const results = toolResults(harness.session.messages);
		expect(results[0]?.isError).toBe(false);
	});

	it("never prompts for a read-only tool and runs it", async () => {
		const { tool, calls } = countingTool("read_file");
		const confirm = vi.fn(async () => false);
		const harness = await createHarness({
			tools: [tool],
			initialActiveToolNames: ["read_file"],
			permissionMode: resolvePermissionMode(),
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({ uiContext: fakeUiContext(confirm) });
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("read_file", { path: "x" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("go");

		expect(confirm).not.toHaveBeenCalled();
		expect(calls()).toBe(1);
	});

	it("prompts for a mutating tool when a UI is attached and honors the denial", async () => {
		const { tool, calls } = countingTool("write_file");
		const confirm = vi.fn(async () => false);
		const harness = await createHarness({
			tools: [tool],
			initialActiveToolNames: ["write_file"],
			permissionMode: resolvePermissionMode(),
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({ uiContext: fakeUiContext(confirm) });
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("write_file", { path: "x" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("go");

		expect(confirm).toHaveBeenCalledTimes(1);
		expect(calls()).toBe(0);
	});
});

describe("reminder delivery wiring", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
		resetReminderSnoozes();
		vi.restoreAllMocks();
	});

	async function captureRequest(): Promise<{ harness: Harness; read: () => string | undefined }> {
		const readFile: AgentTool = {
			name: "read_file",
			label: "read_file",
			description: "read stub",
			parameters: Type.Object({}),
			execute: async () => ({ content: [], details: undefined }),
		};
		const harness = await createHarness({
			tools: [readFile],
			initialActiveToolNames: ["read_file"],
			modelsJson: {
				providers: {
					muse: {
						name: "Meta Muse",
						baseUrl: "https://api.meta.ai/v1",
						api: "openai-responses",
						apiKey: "test-key",
						compat: {
							supportsInstructionsField: true,
							toolNamespace: { name: "muse", description: "Muse Code tool set." },
						},
						models: [
							{
								id: "muse-spark-1.3-contributor",
								name: "Muse Spark 1.3 Contributor",
								reasoning: true,
								input: ["text", "image"],
								cost: { input: 0.1, output: 0.2, cacheRead: 0.002, cacheWrite: 0 },
								contextWindow: 1_007_997,
								maxTokens: 32_768,
							},
						],
					},
				},
			},
		});
		harnesses.push(harness);
		harness.session.state.model = museModel();

		let captured: string | undefined;
		vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
			captured = String(init?.body);
			return new Response(SSE_COMPLETION_BODY, {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		});
		return { harness, read: () => captured };
	}

	it("delivers a due reminder in the outgoing request", async () => {
		const { harness, read } = await captureRequest();
		harness.session.reminders.registerReminder({ kind: "due-check", text: "DUE_REMINDER_SENTINEL" });

		await harness.session.prompt("hi");

		const body = read();
		expect(body).toBeDefined();
		const text = requestText(body!);
		expect(text).toContain("DUE_REMINDER_SENTINEL");
		expect(text).toContain('<system-reminder source="due-check">');
	});

	it("suppresses a snoozed reminder in the outgoing request", async () => {
		const { harness, read } = await captureRequest();
		harness.session.reminders.registerReminder({ kind: "snoozed-check", text: "SNOOZED_REMINDER_SENTINEL" });
		recordReminderSnooze("snoozed-check", 2);

		await harness.session.prompt("hi");

		const body = read();
		expect(body).toBeDefined();
		expect(requestText(body!)).not.toContain("SNOOZED_REMINDER_SENTINEL");
	});
});

describe("resume repair wiring", () => {
	const tempDirs: string[] = [];
	const sessions: Array<{ dispose: () => void }> = [];

	afterEach(() => {
		while (sessions.length > 0) {
			sessions.pop()?.dispose();
		}
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("repairs a dangling toolCall on restore and never executes the tool", async () => {
		const root = join(tmpdir(), `pi-muse-integration-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(root, { recursive: true });
		tempDirs.push(root);
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });

		let executed = 0;
		const sessionManager = SessionManager.inMemory(cwd);
		sessionManager.appendMessage(assistantWithToolCall("call_dangling", "repair_probe_tool"));

		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			sessionManager,
			tools: ["repair_probe_tool"],
			customTools: [
				{
					name: "repair_probe_tool",
					label: "Repair Probe",
					description: "Probe used to prove nothing auto-executes on restore",
					parameters: Type.Object({}),
					execute: async () => {
						executed += 1;
						return { content: [{ type: "text", text: "ran" }], details: {} };
					},
				},
			],
		});
		sessions.push(session);

		const results = toolResults(session.agent.state.messages);
		expect(results).toHaveLength(1);
		expect(results[0].toolCallId).toBe("call_dangling");
		expect(results[0].isError).toBe(true);
		expect(results[0].content[0]).toMatchObject({ type: "text", text: expect.stringContaining("not executed") });
		expect(executed).toBe(0);
		expect(existsSync(cwd)).toBe(true);
	});
});

describe("model-visible tool surface", () => {
	const tempDirs: string[] = [];
	const sessions: Array<{ dispose: () => void }> = [];

	afterEach(() => {
		while (sessions.length > 0) {
			sessions.pop()?.dispose();
		}
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("exposes exactly the Muse tool set and hides pi-subagents' own tools", async () => {
		const root = mkdtempSync(join(tmpdir(), `pi-muse-tool-surface-${Date.now()}-`));
		tempDirs.push(root);
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });

		const services = await createAgentSessionServices({
			cwd,
			agentDir,
			settingsManager: SettingsManager.inMemory(),
			resourceLoaderOptions: {
				defaultSystemPrompt: MUSE_SYSTEM_PROMPT,
				extensionFactories: builtInExtensions,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
			},
		});
		const expected = [...MUSE_TOOL_NAMES, ...MUSE_SUBAGENT_TOOL_NAMES];
		expect(expected).toHaveLength(22);
		const { session } = await createAgentSessionFromServices({
			services,
			sessionManager: SessionManager.inMemory(cwd),
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			tools: [...expected],
		});
		sessions.push(session);
		await session.bindExtensions({});

		expect([...session.getActiveToolNames()].sort()).toEqual([...expected].sort());

		const loadedExtensionPaths = services.resourceLoader
			.getExtensions()
			.extensions.map((extension) => extension.path);
		expect(loadedExtensionPaths.some((path) => path.includes("@tintinweb/pi-subagents"))).toBe(true);
		for (const name of ["Agent", "steer_subagent", "get_subagent_result", "SubagentWorkflow"]) {
			expect(session.getActiveToolNames()).not.toContain(name);
			expect(session.getAllTools().map((tool) => tool.name)).not.toContain(name);
		}
	});
});
