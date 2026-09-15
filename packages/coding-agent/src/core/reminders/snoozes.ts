import type { ReminderKind } from "./types.ts";

/**
 * One snooze window. `remainingSteps` counts MODEL REQUEST STEPS, not
 * wall-clock time; it is decremented once per model request turn.
 */
export interface ReminderSnooze {
	reminderKind: ReminderKind;
	subjectKey?: string;
	remainingSteps: number;
}

const reminderSnoozes = new Map<string, ReminderSnooze>();

function reminderSnoozeKey(reminderKind: string, subjectKey?: string): string {
	return `${reminderKind}\u0000${subjectKey ?? ""}`;
}

/**
 * True when a stored snooze suppresses this reminder.
 * Reminder kinds must match exactly; a caller subjectKey matches an exact
 * stored subject key or a snooze stored without a subject key (which
 * suppresses every subject of that kind).
 */
function snoozeMatches(snooze: ReminderSnooze, reminderKind: string, subjectKey?: string): boolean {
	if (snooze.reminderKind !== reminderKind) return false;
	if (subjectKey !== undefined && snooze.subjectKey !== undefined && snooze.subjectKey !== subjectKey) return false;
	return true;
}

/**
 * Store (or extend) a snooze window. The longer of the existing and requested
 * durations wins so repeated snoozes never shorten an active window.
 */
export function recordReminderSnooze(
	reminderKind: ReminderKind,
	durationSteps: number,
	subjectKey?: string,
): ReminderSnooze {
	const key = reminderSnoozeKey(reminderKind, subjectKey);
	const existing = reminderSnoozes.get(key);
	const remainingSteps = Math.max(existing?.remainingSteps ?? 0, durationSteps);
	const snooze: ReminderSnooze = { reminderKind, subjectKey, remainingSteps };
	reminderSnoozes.set(key, snooze);
	return snooze;
}

/**
 * Consume one model request step from a matching snooze. Returns true when a
 * snooze was active. Kept with its original exported semantics.
 */
export function consumeReminderSnooze(reminderKind: string, subjectKey?: string): boolean {
	for (const [key, snooze] of reminderSnoozes) {
		if (!snoozeMatches(snooze, reminderKind, subjectKey)) continue;
		snooze.remainingSteps -= 1;
		if (snooze.remainingSteps <= 0) reminderSnoozes.delete(key);
		return true;
	}
	return false;
}

/** Non-decrementing check used by the registry when filtering deliveries. */
export function hasReminderSnooze(reminderKind: string, subjectKey?: string): boolean {
	for (const snooze of reminderSnoozes.values()) {
		if (snoozeMatches(snooze, reminderKind, subjectKey)) return true;
	}
	return false;
}

/** Decrement every active snooze by one model request step and drop expired ones. */
export function advanceReminderSnoozes(): void {
	for (const [key, snooze] of reminderSnoozes) {
		snooze.remainingSteps -= 1;
		if (snooze.remainingSteps <= 0) reminderSnoozes.delete(key);
	}
}

/** Drop every snooze window. Intended for tests. */
export function resetReminderSnoozes(): void {
	reminderSnoozes.clear();
}

/** Snapshot of active snoozes, for diagnostics. */
export function listReminderSnoozes(): readonly ReminderSnooze[] {
	return [...reminderSnoozes.values()];
}
