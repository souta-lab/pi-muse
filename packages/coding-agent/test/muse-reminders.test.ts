import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { MUSE_BUNDLED_SKILLS } from "../src/core/muse-skills/index.ts";
import {
	BUILT_IN_REMINDER_KINDS,
	collectReminderPrompt,
	createDefaultReminderProducers,
	createMemoryReminderProducer,
	createMuseReminderRegistry,
	createSkillReminderProducer,
	ReminderRegistry,
	resetReminderSnoozes,
} from "../src/core/reminders/index.ts";
import { consumeReminderSnooze, createSnoozeReminderToolDefinition } from "../src/core/tools/muse.ts";

const tempDirs: string[] = [];

function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-muse-reminder-"));
	tempDirs.push(dir);
	return dir;
}

const ctx = (cwd: string): ExtensionContext => ({ cwd }) as unknown as ExtensionContext;

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	resetReminderSnoozes();
});

describe("reminder delivery", () => {
	it("delivers a due reminder as a system-reminder block", () => {
		const registry = new ReminderRegistry();
		registry.registerReminder({ kind: "memory", subjectKey: "notes.md", text: "Read the memory file." });

		const deliveries = registry.onModelStep();

		expect(deliveries).toHaveLength(1);
		expect(deliveries[0].kind).toBe("memory");
		expect(deliveries[0].subjectKey).toBe("notes.md");
		expect(deliveries[0].rendered).toBe(
			'<system-reminder source="memory">\nRead the memory file.\n</system-reminder>',
		);
		expect(registry.getReminder("memory", "notes.md")?.lifecycle).toBe("delivered");
	});

	it("collects joined blocks for one turn with collectReminderPrompt", () => {
		const registry = new ReminderRegistry();
		registry.registerReminder({ kind: "memory", text: "m" });

		const { deliveries, prompt } = collectReminderPrompt(registry);

		expect(deliveries).toHaveLength(1);
		expect(prompt).toContain('<system-reminder source="memory">');
	});
});

describe("bounded cadence and dedupe", () => {
	it("re-delivers a repeating reminder on its step cadence, not every step", () => {
		const registry = new ReminderRegistry();
		registry.registerReminder({ kind: "skill", subjectKey: "catalog", text: "nudge", repeatEverySteps: 3 });

		expect(registry.onModelStep()).toHaveLength(1);
		expect(registry.onModelStep()).toHaveLength(0);
		expect(registry.onModelStep()).toHaveLength(0);
		expect(registry.onModelStep()).toHaveLength(1);
	});

	it("delivers a one-shot reminder exactly once", () => {
		const registry = new ReminderRegistry();
		registry.registerReminder({ kind: "memory", text: "once" });

		expect(registry.onModelStep()).toHaveLength(1);
		expect(registry.onModelStep()).toHaveLength(0);
	});

	it("never duplicates a reminder within one turn even if a producer emits it twice", () => {
		const registry = new ReminderRegistry({
			producers: [
				{
					id: "dup",
					produce: () => [
						{ kind: "skill", subjectKey: "x", text: "a" },
						{ kind: "skill", subjectKey: "x", text: "b" },
					],
				},
			],
		});

		const deliveries = registry.onModelStep();

		expect(deliveries).toHaveLength(1);
		expect(new Set(deliveries.map((delivery) => `${delivery.kind}\u0000${delivery.subjectKey}`)).size).toBe(1);
	});
});

describe("snooze_reminder integration", () => {
	const snooze = () => createSnoozeReminderToolDefinition();

	it("suppresses a matching kind for the requested model request steps", async () => {
		const registry = new ReminderRegistry();
		registry.registerReminder({ kind: "skill", subjectKey: "catalog", text: "nudge", repeatEverySteps: 1 });
		await snooze().execute(
			"s",
			{ reminder_kind: "skill", duration_steps: 2 },
			undefined,
			undefined,
			ctx(makeTempDir()),
		);

		expect(registry.onModelStep()).toHaveLength(0);
		expect(registry.onModelStep()).toHaveLength(0);
		expect(registry.onModelStep()).toHaveLength(1);
	});

	it("narrows a snooze to one subject key", async () => {
		const registry = new ReminderRegistry();
		registry.registerReminder({ kind: "skill", subjectKey: "alpha", text: "a", repeatEverySteps: 1 });
		registry.registerReminder({ kind: "skill", subjectKey: "beta", text: "b", repeatEverySteps: 1 });
		await snooze().execute(
			"s",
			{ reminder_kind: "skill", duration_steps: 1, subject_key: "alpha" },
			undefined,
			undefined,
			ctx(makeTempDir()),
		);

		const deliveries = registry.onModelStep();

		expect(deliveries.map((delivery) => delivery.subjectKey)).toEqual(["beta"]);
	});

	it("drops a snooze after its step budget expires", async () => {
		const registry = new ReminderRegistry();
		registry.registerReminder({ kind: "memory", subjectKey: "n.md", text: "m" });
		await snooze().execute(
			"s",
			{ reminder_kind: "memory", duration_steps: 3 },
			undefined,
			undefined,
			ctx(makeTempDir()),
		);

		expect(registry.onModelStep()).toHaveLength(0);
		expect(registry.onModelStep()).toHaveLength(0);
		expect(registry.onModelStep()).toHaveLength(0);
		expect(registry.onModelStep()).toHaveLength(1);
	});

	it("keeps the consumeReminderSnooze semantics re-exported from the tool module", async () => {
		await snooze().execute(
			"s",
			{ reminder_kind: "memory", duration_steps: 1 },
			undefined,
			undefined,
			ctx(makeTempDir()),
		);

		expect(consumeReminderSnooze("memory", "any-subject")).toBe(true);
		expect(consumeReminderSnooze("memory", "any-subject")).toBe(false);
		expect(consumeReminderSnooze("skill")).toBe(false);
	});
});

describe("acknowledgement and dismissal", () => {
	it("stops delivery after acknowledgement and reports the terminal lifecycle", () => {
		const registry = new ReminderRegistry();
		registry.registerReminder({ kind: "memory", subjectKey: "notes.md", text: "m" });
		expect(registry.onModelStep()).toHaveLength(1);

		expect(registry.acknowledgeReminder("memory", "notes.md")).toBe(1);
		expect(registry.onModelStep()).toHaveLength(0);
		expect(registry.getReminder("memory", "notes.md")?.lifecycle).toBe("acknowledged");
	});

	it("acknowledges every subject when called without a subject key", () => {
		const registry = new ReminderRegistry();
		registry.registerReminder({ kind: "memory", subjectKey: "a", text: "a" });
		registry.registerReminder({ kind: "memory", subjectKey: "b", text: "b" });

		expect(registry.acknowledgeReminder("memory")).toBe(2);
		expect(registry.onModelStep()).toHaveLength(0);
	});

	it("does not resurrect a dismissed reminder from a producer", () => {
		const registry = new ReminderRegistry({
			producers: [{ id: "always", produce: () => [{ kind: "skill", subjectKey: "x", text: "a" }] }],
		});
		expect(registry.onModelStep()).toHaveLength(1);

		expect(registry.dismissReminder("skill", "x")).toBe(1);
		expect(registry.onModelStep()).toHaveLength(0);
		expect(registry.getReminder("skill", "x")?.lifecycle).toBe("dismissed");
	});
});

describe("built-in producers", () => {
	it("names the two official kinds", () => {
		expect(BUILT_IN_REMINDER_KINDS).toEqual(["skill", "memory"]);
	});

	it("memory producer fires for unread memory files and quiets after a read", () => {
		const dir = makeTempDir();
		writeFileSync(join(dir, "notes.md"), "# notes");
		const registry = new ReminderRegistry({
			producers: [createMemoryReminderProducer({ memoryRoot: dir, readRecencySteps: 2 })],
		});

		const deliveries = registry.onModelStep();

		expect(deliveries).toHaveLength(1);
		expect(deliveries[0].kind).toBe("memory");
		expect(deliveries[0].subjectKey).toBe("notes.md");
		expect(deliveries[0].rendered).toContain('<system-reminder source="memory">');

		registry.acknowledgeReminder("memory", "notes.md");
		expect(registry.onModelStep()).toHaveLength(0);
		expect(registry.onModelStep()).toHaveLength(1);
	});

	it("emits no memory reminder when the memory root is empty", () => {
		const registry = new ReminderRegistry({
			producers: [createMemoryReminderProducer({ memoryRoot: makeTempDir() })],
		});
		expect(registry.onModelStep()).toHaveLength(0);
	});

	it("skill producer is data-driven from the bundled catalog", () => {
		const registry = new ReminderRegistry({ producers: [createSkillReminderProducer({ readRecencySteps: 4 })] });

		const deliveries = registry.onModelStep();

		expect(deliveries).toHaveLength(1);
		expect(deliveries[0].kind).toBe("skill");
		expect(deliveries[0].rendered).toContain('<system-reminder source="skill">');
		expect(deliveries[0].text).toContain(MUSE_BUNDLED_SKILLS[0].id);
	});

	it("emits nothing when the catalog is empty", () => {
		const registry = new ReminderRegistry({ producers: [createSkillReminderProducer({ skills: [] })] });
		expect(registry.onModelStep()).toHaveLength(0);
	});

	it("leaves the skill-catalog producer out of the default session producers", () => {
		expect(createDefaultReminderProducers().map((producer) => producer.id)).toEqual(["memory"]);
	});

	it("emits no skill reminder from the default registry, so the developer-message catalog is not duplicated", () => {
		const registry = createMuseReminderRegistry();

		const deliveries = registry.onModelStep();

		expect(deliveries.filter((delivery) => delivery.kind === "skill")).toEqual([]);
	});
});
