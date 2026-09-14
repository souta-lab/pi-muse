import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "../src/core/extensions/types.ts";
import { MUSE_SYSTEM_PROMPT } from "../src/core/muse-system-prompt.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import {
	createEditFileToolDefinition,
	createMuseToolDefinitions,
	createWriteTodosToolDefinition,
	MUSE_TOOL_NAMES,
	onShellSessionExit,
} from "../src/core/tools/muse.ts";
import museExtension, { MUSE_PROVIDER_ID, OPENCODE_GO_PROVIDER_ID } from "../src/extensions/muse.ts";

const tempDirs: string[] = [];

function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-muse-"));
	tempDirs.push(dir);
	return dir;
}

function makeAgentDir(cwd: string): string {
	const agentDir = join(cwd, "agent");
	mkdirSync(agentDir, { recursive: true });
	return agentDir;
}

const ctx = (cwd: string): ExtensionContext => ({ cwd }) as unknown as ExtensionContext;

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("muse tools", () => {
	it("exposes exactly the seven Muse tools", () => {
		const cwd = makeTempDir();
		const definitions = createMuseToolDefinitions(cwd);

		expect(Object.keys(definitions)).toEqual([...MUSE_TOOL_NAMES]);
		expect(Object.values(definitions).map((definition) => definition.name)).toEqual([...MUSE_TOOL_NAMES]);
		expect(MUSE_TOOL_NAMES).toEqual([
			"read_file",
			"write_file",
			"edit_file",
			"search",
			"bash",
			"bash_input",
			"read_memory",
			"add_memory",
			"edit_memory",
			"write_todos",
		]);
	});

	it("renames read_file, write_file and search but keeps the pi implementations", () => {
		const cwd = makeTempDir();
		const definitions = createMuseToolDefinitions(cwd);

		expect(definitions.read_file.label).toBe("read_file");
		expect(definitions.write_file.label).toBe("write_file");
		expect(definitions.edit_file.label).toBe("edit_file");
		expect(definitions.search.label).toBe("search");
		expect(definitions.bash.label).toBe("bash");
	});
});

describe("muse edit_file", () => {
	it("replaces an exact unique match", async () => {
		const cwd = makeTempDir();
		const file = join(cwd, "sample.txt");
		writeFileSync(file, "alpha\nbeta\ngamma\n");
		const definition = createEditFileToolDefinition(cwd);

		const result = await definition.execute(
			"edit-1",
			{ path: "sample.txt", find: "beta", replace: "BETA" },
			undefined,
			undefined,
			ctx(cwd),
		);

		expect(readFileSync(file, "utf-8")).toBe("alpha\nBETA\ngamma\n");
		expect(result.content[0]).toMatchObject({ type: "text" });
	});

	it("errors and writes nothing when find matches zero times", async () => {
		const cwd = makeTempDir();
		const file = join(cwd, "sample.txt");
		writeFileSync(file, "alpha\n");
		const definition = createEditFileToolDefinition(cwd);

		await expect(
			definition.execute(
				"edit-2",
				{ path: "sample.txt", find: "missing", replace: "x" },
				undefined,
				undefined,
				ctx(cwd),
			),
		).rejects.toThrow();
		expect(readFileSync(file, "utf-8")).toBe("alpha\n");
	});

	it("errors and writes nothing when find matches more than once", async () => {
		const cwd = makeTempDir();
		const file = join(cwd, "sample.txt");
		writeFileSync(file, "dup\ndup\n");
		const definition = createEditFileToolDefinition(cwd);

		await expect(
			definition.execute(
				"edit-3",
				{ path: "sample.txt", find: "dup", replace: "x" },
				undefined,
				undefined,
				ctx(cwd),
			),
		).rejects.toThrow();
		expect(readFileSync(file, "utf-8")).toBe("dup\ndup\n");
	});
});

describe("muse write_todos", () => {
	it("tracks text and status across calls", async () => {
		const definition = createWriteTodosToolDefinition();
		const first = await definition.execute(
			"todo-1",
			{
				todos: [
					{ text: "read code", status: "completed" },
					{ text: "write code", status: "in_progress" },
				],
			},
			undefined,
			undefined,
			ctx(process.cwd()),
		);
		const firstText = (first.content[0] as { text: string }).text;
		expect(firstText).toContain("1 completed");
		expect(firstText).toContain("1 in_progress");
		expect(firstText).toContain("[in_progress] write code");

		const second = await definition.execute(
			"todo-2",
			{ todos: [{ text: "write code", status: "completed" }] },
			undefined,
			undefined,
			ctx(process.cwd()),
		);
		const secondText = (second.content[0] as { text: string }).text;
		expect(secondText).toContain("1 completed");
		expect(secondText).not.toContain("read code");
	});
});

describe("muse bash sessions", () => {
	it("returns completed output for a fast command", async () => {
		const cwd = makeTempDir();
		const definitions = createMuseToolDefinitions(cwd);

		const result = await definitions.bash.execute(
			"bash-fast",
			{ command: "echo hi" },
			undefined,
			undefined,
			ctx(cwd),
		);
		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("hi");
		expect(text).not.toContain("session_id");
	});

	it("supports interactive stdin through a live session", async () => {
		const cwd = makeTempDir();
		const definitions = createMuseToolDefinitions(cwd);

		const started = await definitions.bash.execute(
			"bash-pty",
			{ command: "cat", yield_time_ms: 400 },
			undefined,
			undefined,
			ctx(cwd),
		);
		const startedText = (started.content[0] as { text: string }).text;
		const sessionId = startedText.match(/session_id: (\d+)/)?.[1];
		expect(sessionId).toBeTruthy();

		const sent = await definitions.bash_input.execute(
			"bash-pty-in",
			{ session_id: Number(sessionId), chars: "hello-pty\n" },
			undefined,
			undefined,
			ctx(cwd),
		);
		expect((sent.content[0] as { text: string }).text).toContain("hello-pty");

		const stopped = await definitions.bash_input.execute(
			"bash-pty-stop",
			{ session_id: Number(sessionId), terminate: true },
			undefined,
			undefined,
			ctx(cwd),
		);
		expect((stopped.content[0] as { text: string }).text).toContain("status: completed");
	});

	it("delivers the terminal result to an exit listener", async () => {
		const cwd = makeTempDir();
		const definitions = createMuseToolDefinitions(cwd);
		const exits: Array<{ sessionId: number; exitCode: number | null }> = [];
		const unsubscribe = onShellSessionExit((event) =>
			exits.push({ sessionId: event.sessionId, exitCode: event.exitCode }),
		);

		try {
			const started = await definitions.bash.execute(
				"bash-exit",
				{ command: "sleep 1; echo finished", yield_time_ms: 200 },
				undefined,
				undefined,
				ctx(cwd),
			);
			const sessionId = Number((started.content[0] as { text: string }).text.match(/session_id: (\d+)/)?.[1]);
			expect(sessionId).toBeTruthy();
			await new Promise((resolve) => setTimeout(resolve, 2000));
			expect(exits.some((event) => event.sessionId === sessionId && event.exitCode === 0)).toBe(true);
		} finally {
			unsubscribe();
		}
	});
});

describe("muse memory", () => {
	it("adds, reads, and edits a memory file", async () => {
		const agentDir = makeTempDir();
		const previous = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		try {
			const definitions = createMuseToolDefinitions(agentDir);
			await definitions.add_memory.execute(
				"m1",
				{ path: "notes.md", content: "hello" },
				undefined,
				undefined,
				ctx(agentDir),
			);
			await definitions.add_memory.execute(
				"m2",
				{ path: "notes.md", content: "world" },
				undefined,
				undefined,
				ctx(agentDir),
			);

			const first = await definitions.read_memory.execute(
				"m3",
				{ path: "notes.md" },
				undefined,
				undefined,
				ctx(agentDir),
			);
			const firstText = (first.content[0] as { text: string }).text;
			expect(firstText).toContain("hello");
			expect(firstText).toContain("world");

			await definitions.edit_memory.execute(
				"m4",
				{ path: "notes.md", old_str: "hello", new_str: "hi" },
				undefined,
				undefined,
				ctx(agentDir),
			);
			const second = await definitions.read_memory.execute(
				"m5",
				{ path: "notes.md" },
				undefined,
				undefined,
				ctx(agentDir),
			);
			expect((second.content[0] as { text: string }).text).toContain("hi");

			await expect(
				definitions.edit_memory.execute(
					"m6",
					{ path: "notes.md", old_str: "not-present", new_str: "x" },
					undefined,
					undefined,
					ctx(agentDir),
				),
			).rejects.toThrow();
		} finally {
			if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previous;
		}
	});
});

describe("muse system prompt", () => {
	async function loadPrompt(defaultSystemPrompt?: string): Promise<string | undefined> {
		const cwd = makeTempDir();
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir: makeAgentDir(cwd),
			settingsManager: SettingsManager.inMemory(),
			defaultSystemPrompt,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});
		await loader.reload();
		return loader.getSystemPrompt();
	}

	it("is the default when no SYSTEM.md or explicit prompt is configured", async () => {
		const prompt = await loadPrompt(MUSE_SYSTEM_PROMPT);
		expect(prompt).toContain("You are Muse Code");
		expect(prompt).toContain("Muse Code powered by Meta Muse Spark");
	});

	it("stays unset without the Muse default so SDK callers keep the pi prompt", async () => {
		expect(await loadPrompt()).toBeUndefined();
	});
});

describe("muse provider", () => {
	it("registers Meta Muse with Muse Spark 1.3 over the Responses API", () => {
		const registered: Array<{ name: string; config: unknown }> = [];
		const api = {
			registerProvider: (name: string, config: unknown) => registered.push({ name, config }),
		} as unknown as ExtensionAPI;

		museExtension(api);

		expect(registered.map((entry) => entry.name)).toEqual([MUSE_PROVIDER_ID, OPENCODE_GO_PROVIDER_ID]);
		expect(registered[0].name).toBe(MUSE_PROVIDER_ID);
		const config = registered[0].config as {
			baseUrl: string;
			api: string;
			models: Array<{ id: string; reasoning: boolean }>;
		};
		expect(config.baseUrl).toBe("https://api.meta.ai/v1");
		expect(config.api).toBe("openai-responses");
		expect(config.models.map((model) => model.id)).toContain("muse-spark-1.3-contributor");
		expect(config.models.every((model) => model.reasoning)).toBe(true);

		const opencodeGo = registered[1].config as {
			baseUrl: string;
			api: string;
			headers: Record<string, string>;
			models: Array<{ id: string }>;
		};
		expect(opencodeGo.baseUrl).toBe("https://opencode.ai/zen/go/v1");
		expect(opencodeGo.api).toBe("openai-responses");
		expect(opencodeGo.headers["x-opencode-session"]).toMatch(/^pi-muse-/);
		expect(opencodeGo.models.map((model) => model.id)).toContain("muse-spark-1.3-contributor");
	});
});
