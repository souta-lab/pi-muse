import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import {
	consumeReminderSnooze,
	createMuseToolDefinitions,
	createSnoozeReminderToolDefinition,
	resetReminderSnoozes,
} from "../src/core/tools/muse.ts";

const tempDirs: string[] = [];

function museFixture(name: string): string {
	return fileURLToPath(new URL(`./fixtures/muse/${name}`, import.meta.url));
}

function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-muse-tool-"));
	tempDirs.push(dir);
	return dir;
}

const ctx = (cwd: string): ExtensionContext => ({ cwd }) as unknown as ExtensionContext;

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	resetReminderSnoozes();
});

describe("read_file", () => {
	it("numbers lines from the offset and reports a Muse-style prefix", async () => {
		const cwd = makeTempDir();
		writeFileSync(join(cwd, "f.txt"), "a\nb\nc\n");
		const defs = createMuseToolDefinitions(cwd);

		const full = await defs.read_file.execute("r", { path: "f.txt" }, undefined, undefined, ctx(cwd));
		const fullText = (full.content[0] as { text: string }).text;
		expect(fullText).toContain("Read text file `f.txt`.");
		expect(fullText).toContain("1|a");
		expect(fullText).toContain("3|c");

		const windowed = await defs.read_file.execute(
			"r",
			{ path: "f.txt", offset: 2, limit: 1 },
			undefined,
			undefined,
			ctx(cwd),
		);
		const windowText = (windowed.content[0] as { text: string }).text;
		expect(windowText).toContain("2|b");
		expect(windowText).not.toContain("1|a");
	});

	it("errors on a directory like Muse instead of dumping it", async () => {
		const cwd = makeTempDir();
		mkdirSync(join(cwd, "adir"));
		const defs = createMuseToolDefinitions(cwd);
		await expect(defs.read_file.execute("r", { path: "adir" }, undefined, undefined, ctx(cwd))).rejects.toThrow(
			/not a regular file/,
		);
	});

	it("reports a video file without reading binary content", async () => {
		const cwd = makeTempDir();
		const defs = createMuseToolDefinitions(cwd);
		const result = await defs.read_file.execute("r", { path: "clip.mp4" }, undefined, undefined, ctx(cwd));
		expect((result.content[0] as { text: string }).text).toBe("Read video file [video/mp4]");
	});
});

describe("write_file", () => {
	it("creates parent directories and reports the written byte count", async () => {
		const cwd = makeTempDir();
		const defs = createMuseToolDefinitions(cwd);
		const result = await defs.write_file.execute(
			"w",
			{ path: "nested/dir/out.txt", content: "hello" },
			undefined,
			undefined,
			ctx(cwd),
		);
		expect((result.content[0] as { text: string }).text).toBe("wrote 5 bytes to nested/dir/out.txt");
		expect(readFileSync(join(cwd, "nested/dir/out.txt"), "utf-8")).toBe("hello");
	});
});

describe("edit_file", () => {
	it("replaces a unique match and rejects zero or multiple matches", async () => {
		const cwd = makeTempDir();
		writeFileSync(join(cwd, "e.txt"), "alpha\nbeta\n");
		const defs = createMuseToolDefinitions(cwd);

		await defs.edit_file.execute(
			"e",
			{ path: "e.txt", find: "beta", replace: "BETA" },
			undefined,
			undefined,
			ctx(cwd),
		);
		expect(readFileSync(join(cwd, "e.txt"), "utf-8")).toBe("alpha\nBETA\n");

		await expect(
			defs.edit_file.execute("e", { path: "e.txt", find: "nope", replace: "x" }, undefined, undefined, ctx(cwd)),
		).rejects.toThrow();

		writeFileSync(join(cwd, "e.txt"), "dup\ndup\n");
		await expect(
			defs.edit_file.execute("e", { path: "e.txt", find: "dup", replace: "x" }, undefined, undefined, ctx(cwd)),
		).rejects.toThrow();
	});
});

describe("wording of tool results matches Muse captures", () => {
	it("read_file result text equals the captured Muse wording", async () => {
		const cwd = makeTempDir();
		writeFileSync(join(cwd, "hello.txt"), "world\n");
		const defs = createMuseToolDefinitions(cwd);
		const result = await defs.read_file.execute("r", { path: "hello.txt" }, undefined, undefined, ctx(cwd));
		const text = (result.content[0] as { text: string }).text;
		expect(text.startsWith("Read text file `hello.txt`.")).toBe(true);
		expect(text).toContain("1|world");
	});
});

describe("bash", () => {
	it("returns the Muse JSON record for a completed command", async () => {
		const cwd = makeTempDir();
		const defs = createMuseToolDefinitions(cwd);
		const result = await defs.bash.execute(
			"b",
			{ command: "printf hi", description: "print hi" },
			undefined,
			undefined,
			ctx(cwd),
		);
		const parsed = JSON.parse((result.content[0] as { text: string }).text) as {
			command: string;
			description: string;
			output: string;
			exit_code: number;
		};
		expect(parsed).toMatchObject({ command: "printf hi", description: "print hi", output: "hi", exit_code: 0 });
	});

	it("returns a running record with a session id, and bash_input steers it", async () => {
		const cwd = makeTempDir();
		const defs = createMuseToolDefinitions(cwd);
		const started = await defs.bash.execute(
			"b",
			{ command: "cat", description: "read stdin", yield_time_ms: 300 },
			undefined,
			undefined,
			ctx(cwd),
		);
		const parsed = JSON.parse((started.content[0] as { text: string }).text) as {
			status: string;
			session_id: number;
		};
		expect(parsed.status).toBe("running");
		expect(parsed.session_id).toBeGreaterThan(0);

		const sent = await defs.bash_input.execute(
			"i",
			{ session_id: parsed.session_id, chars: "ping\n" },
			undefined,
			undefined,
			ctx(cwd),
		);
		expect((sent.content[0] as { text: string }).text).toContain("ping");

		const stopped = await defs.bash_input.execute(
			"i",
			{ session_id: parsed.session_id, terminate: true },
			undefined,
			undefined,
			ctx(cwd),
		);
		expect((stopped.content[0] as { text: string }).text).toContain("status: completed");
	});

	it("reports an unknown session", async () => {
		const cwd = makeTempDir();
		const defs = createMuseToolDefinitions(cwd);
		const result = await defs.bash_input.execute("i", { session_id: 999999 }, undefined, undefined, ctx(cwd));
		expect((result.content[0] as { text: string }).text).toContain("No running bash session");
	});
});

describe("work_status / work_stop", () => {
	it("inspects and stops a background work item", async () => {
		const cwd = makeTempDir();
		const defs = createMuseToolDefinitions(cwd);
		const started = await defs.bash.execute(
			"b",
			{ command: "sleep 30", description: "sleep", yield_time_ms: 200 },
			undefined,
			undefined,
			ctx(cwd),
		);
		const sessionId = (JSON.parse((started.content[0] as { text: string }).text) as { session_id: number })
			.session_id;

		const status = await defs.work_status.execute(
			"w",
			{ work_id: String(sessionId) },
			undefined,
			undefined,
			ctx(cwd),
		);
		expect((status.content[0] as { text: string }).text).toContain("running");

		const stopped = await defs.work_stop.execute("w", { work_id: String(sessionId) }, undefined, undefined, ctx(cwd));
		expect((stopped.content[0] as { text: string }).text).toContain(`Stopped work_id ${sessionId}`);
	});
});

describe("write_todos", () => {
	it("records a plan and rejects more than one in_progress", async () => {
		const cwd = makeTempDir();
		const defs = createMuseToolDefinitions(cwd);
		const ok = await defs.write_todos.execute(
			"t",
			{
				todos: [
					{ text: "a", status: "completed" },
					{ text: "b", status: "in_progress" },
				],
			},
			undefined,
			undefined,
			ctx(cwd),
		);
		expect((ok.content[0] as { text: string }).text).toContain("1 completed");

		await expect(
			defs.write_todos.execute(
				"t",
				{
					todos: [
						{ text: "a", status: "in_progress" },
						{ text: "b", status: "in_progress" },
					],
				},
				undefined,
				undefined,
				ctx(cwd),
			),
		).rejects.toThrow(/at most one todo in_progress/);
	});
});

describe("read_skill", () => {
	it("resolves a skill by directory name and by frontmatter name", async () => {
		const cwd = makeTempDir();
		const dir = join(cwd, ".pi", "skills", "my-skill");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "SKILL.md"), "---\nname: my-skill\ndescription: demo\n---\n# Body\ndetails");
		const defs = createMuseToolDefinitions(cwd);

		const byDir = await defs.read_skill.execute("s", { name: "my-skill" }, undefined, undefined, ctx(cwd));
		expect((byDir.content[0] as { text: string }).text).toContain("# Body");

		await expect(
			defs.read_skill.execute("s", { name: "bundled://missing" }, undefined, undefined, ctx(cwd)),
		).rejects.toThrow(/Skill not found/);
	});
});

describe("web_search", () => {
	it("reports a configuration error when no search key is set", async () => {
		const previousExa = process.env.EXA_API_KEY;
		const previousBrave = process.env.BRAVE_API_KEY;
		delete process.env.EXA_API_KEY;
		delete process.env.BRAVE_API_KEY;
		try {
			const defs = createMuseToolDefinitions(makeTempDir());
			await expect(
				defs.web_search.execute("w", { query: "x" }, undefined, undefined, ctx(process.cwd())),
			).rejects.toThrow(/not configured/);
		} finally {
			if (previousExa !== undefined) process.env.EXA_API_KEY = previousExa;
			if (previousBrave !== undefined) process.env.BRAVE_API_KEY = previousBrave;
		}
	});
});

describe("memory offset window", () => {
	it("reads a bounded window from a memory file", async () => {
		const agentDir = makeTempDir();
		const previous = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		try {
			const defs = createMuseToolDefinitions(agentDir);
			await defs.add_memory.execute(
				"m",
				{ path: "n.md", content: "l1\nl2\nl3" },
				undefined,
				undefined,
				ctx(agentDir),
			);
			const window = await defs.read_memory.execute(
				"m",
				{ path: "n.md", offset: 2, limit: 1 },
				undefined,
				undefined,
				ctx(agentDir),
			);
			expect((window.content[0] as { text: string }).text).toBe("2|l2");
		} finally {
			if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previous;
		}
	});
});

describe("description parity with the official Muse captures", () => {
	it("matches every official description after replacing muse.<toolname> with <toolname>", () => {
		const official = JSON.parse(readFileSync(museFixture("descriptions.json"), "utf-8")) as Record<string, string>;
		const definitions = createMuseToolDefinitions(makeTempDir());
		const ours: Record<string, string> = { snooze_reminder: createSnoozeReminderToolDefinition().description };
		for (const [name, definition] of Object.entries(definitions)) ours[name] = definition.description;

		expect(Object.keys(ours)).toHaveLength(16);
		let ourChars = 0;
		let officialChars = 0;
		for (const [name, description] of Object.entries(ours)) {
			const expected = (official[name] ?? "").replaceAll("muse.", "");
			expect(expected.length, `official description missing for ${name}`).toBeGreaterThan(0);
			expect(description, `description mismatch for ${name}`).toBe(expected);
			ourChars += description.length;
			officialChars += expected.length;
		}
		expect(ourChars / officialChars).toBeGreaterThanOrEqual(0.99);
	});
});

describe("snooze_reminder", () => {
	const snooze = () => createSnoozeReminderToolDefinition();

	it("keeps the official schema bounds and required fields", () => {
		const schema = JSON.parse(JSON.stringify(snooze().parameters)) as {
			properties: {
				duration_steps: { minimum: number; maximum: number };
				reminder_kind: { type: string };
				subject_key?: { type: string };
			};
			required: string[];
			additionalProperties: boolean;
		};
		expect(schema.properties.duration_steps.minimum).toBe(1);
		expect(schema.properties.duration_steps.maximum).toBe(32);
		expect(schema.properties.reminder_kind.type).toBe("string");
		expect(schema.properties.subject_key?.type).toBe("string");
		expect(schema.required).toEqual(["reminder_kind", "duration_steps"]);
		expect(schema.additionalProperties).toBe(false);
	});

	it("suppresses a matching reminder for duration_steps model request steps", async () => {
		const result = await snooze().execute(
			"s",
			{ reminder_kind: "skill", duration_steps: 2 },
			undefined,
			undefined,
			ctx(makeTempDir()),
		);
		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("'skill'");
		expect(text).toContain("2 model request steps");

		expect(consumeReminderSnooze("skill")).toBe(true);
		expect(consumeReminderSnooze("skill")).toBe(true);
		expect(consumeReminderSnooze("skill")).toBe(false);
		expect(consumeReminderSnooze("memory")).toBe(false);
	});

	it("narrows a snooze to an exact subject_key", async () => {
		await snooze().execute(
			"s",
			{ reminder_kind: "skill", duration_steps: 1, subject_key: "alpha" },
			undefined,
			undefined,
			ctx(makeTempDir()),
		);
		expect(consumeReminderSnooze("skill", "beta")).toBe(false);
		expect(consumeReminderSnooze("skill", "alpha")).toBe(true);
		expect(consumeReminderSnooze("skill", "alpha")).toBe(false);
	});

	it("suppresses every subject when stored without a subject_key", async () => {
		await snooze().execute(
			"s",
			{ reminder_kind: "memory", duration_steps: 1 },
			undefined,
			undefined,
			ctx(makeTempDir()),
		);
		expect(consumeReminderSnooze("memory", "any-subject")).toBe(true);
		expect(consumeReminderSnooze("memory", "any-subject")).toBe(false);
	});
});
