import { type Dirent, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { getAgentDir } from "../../config.ts";
import { MUSE_BUNDLED_SKILLS, type MuseBundledSkill } from "../muse-skills/index.ts";
import type { ReminderProducer, ReminderSeed } from "./types.ts";

/** Default recency window (in model request steps) before a memory nudge repeats. */
export const DEFAULT_MEMORY_READ_RECENCY_STEPS = 8;

/** Default recency window before the skill catalog nudge repeats. */
export const DEFAULT_SKILL_READ_RECENCY_STEPS = 6;

function toPosixPath(value: string): string {
	return value.split(sep).join("/");
}

/** Recursively list `.md` files under `root` as sorted workspace-relative posix paths. */
export function listMemoryFiles(root: string): string[] {
	const files: string[] = [];
	const walk = (dir: string): void => {
		let entries: Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (entry.isDirectory()) {
				walk(join(dir, entry.name));
			} else if (entry.isFile() && entry.name.endsWith(".md")) {
				files.push(toPosixPath(relative(root, join(dir, entry.name))));
			}
		}
	};
	walk(root);
	return files.sort();
}

export interface MemoryReminderProducerOptions {
	/** Recency window in model request steps. */
	readRecencySteps?: number;
	/** Override the memory root; defaults to `<agent dir>/memory`. */
	memoryRoot?: string;
	/** Cap the number of unread memory files nudged per turn. */
	maxFiles?: number;
}

/**
 * `memory`-kind producer: fires for each memory file that exists but has not
 * been read within the recency window. The subject key is the memory path so a
 * snooze can narrow to one file.
 */
export function createMemoryReminderProducer(options: MemoryReminderProducerOptions = {}): ReminderProducer {
	const recency = options.readRecencySteps ?? DEFAULT_MEMORY_READ_RECENCY_STEPS;
	const maxFiles = options.maxFiles ?? 6;
	return {
		id: "memory",
		produce(context) {
			const root = options.memoryRoot ?? join(getAgentDir(), "memory");
			const seeds: ReminderSeed[] = [];
			for (const path of listMemoryFiles(root)) {
				if (seeds.length >= maxFiles) break;
				const lastRead = context.lastReadStep("memory", path);
				if (lastRead !== undefined && context.step - lastRead < recency) continue;
				seeds.push({
					kind: "memory",
					subjectKey: path,
					priority: 20,
					repeatEverySteps: recency,
					text: `Memory file \`${path}\` has not been read recently. Call read_memory with path "${path}" before relying on remembered context.`,
				});
			}
			return seeds;
		},
	};
}

export interface SkillReminderProducerOptions {
	/** Recency window in model request steps. */
	readRecencySteps?: number;
	/** Override the bundled catalog; defaults to the real `muse-skills` catalog. */
	skills?: readonly MuseBundledSkill[];
}

/**
 * `skill`-kind producer: nags the model to load a bundled skill before work
 * that matches the catalog. Data-driven from `muse-skills/index.ts`, so adding
 * a bundled skill extends the reminder with no core change.
 */
export function createSkillReminderProducer(options: SkillReminderProducerOptions = {}): ReminderProducer {
	const recency = options.readRecencySteps ?? DEFAULT_SKILL_READ_RECENCY_STEPS;
	const skills = options.skills ?? MUSE_BUNDLED_SKILLS;
	const subjectKey = "bundled-catalog";
	return {
		id: "skill",
		produce(context) {
			if (skills.length === 0) return [];
			const lastRead = context.lastReadStep("skill", subjectKey) ?? context.lastReadStep("skill");
			if (lastRead !== undefined && context.step - lastRead < recency) return [];
			const ids = skills.map((skill) => skill.id).join(", ");
			return [
				{
					kind: "skill",
					subjectKey,
					priority: 10,
					repeatEverySteps: recency,
					text: `The bundled skill catalog (${skills.length} skills) is available: ${ids}. Call read_skill with an id before starting work that matches one.`,
				},
			];
		},
	};
}

/**
 * Producers the default session wires. The bundled skill catalog is deliberately
 * not among them: the same catalog already rides in the developer message, and
 * Muse decides skill reminders in an out-of-band reminder-observer model call,
 * so re-emitting the catalog as an extra user item diverges from the capture.
 * `createSkillReminderProducer` stays available for callers that want it.
 */
export function createDefaultReminderProducers(): readonly ReminderProducer[] {
	return [createMemoryReminderProducer()];
}
