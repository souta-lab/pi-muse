/**
 * Core types for Muse's per-session async reminder subsystem.
 *
 * A reminder is a small in-band nudge the model receives as a
 * `<system-reminder source="<kind>">` block. Reminders are produced at the start
 * of a model request turn, delivered on a bounded cadence, and suppressed by
 * `snooze_reminder` or by an acknowledgement/dismissal.
 */

/** Built-in kinds named by the official `snooze_reminder` description. */
export const BUILT_IN_REMINDER_KINDS = ["skill", "memory"] as const;

export type BuiltInReminderKind = (typeof BUILT_IN_REMINDER_KINDS)[number];

/**
 * A reminder kind. Built-in kinds keep literal autocomplete while any producer
 * can register a new kind without editing the core.
 */
export type ReminderKind = BuiltInReminderKind | (string & {});

/**
 * Reminder lifecycle:
 * `pending` -> `delivered` -> `acknowledged` | `dismissed`, with `snoozed`
 * applied as a suppression overlay while an active snooze matches.
 */
export type ReminderLifecycle = "pending" | "delivered" | "snoozed" | "acknowledged" | "dismissed";

/** What a producer (or a manual caller) hands to the registry. */
export interface ReminderSeed {
	kind: ReminderKind;
	/** Optional narrower subject; a reminder without one is kind-wide. */
	subjectKey?: string;
	/** The in-band text delivered inside the `<system-reminder>` block. */
	text: string;
	/** Lower priority delivers first. Defaults to `0`. */
	priority?: number;
	/**
	 * Minimum number of model request steps between deliveries. `undefined`
	 * means a one-shot reminder that delivers once until acknowledged.
	 */
	repeatEverySteps?: number;
}

/** A tracked reminder with its lifecycle state and delivery bookkeeping. */
export interface Reminder {
	kind: ReminderKind;
	subjectKey?: string;
	text: string;
	priority: number;
	repeatEverySteps?: number;
	lifecycle: ReminderLifecycle;
	createdAtStep: number;
	lastDeliveredStep?: number;
	deliveryCount: number;
	/** Insertion order used as a stable tiebreaker after priority. */
	order: number;
}

/** One reminder handed to a model request turn. */
export interface ReminderDelivery {
	kind: ReminderKind;
	subjectKey?: string;
	text: string;
	priority: number;
	step: number;
	/** The full `<system-reminder source="...">…</system-reminder>` block. */
	rendered: string;
}

/** Read-only view a producer sees for the current step. */
export interface ReminderProduceContext {
	step: number;
	/**
	 * The last step at which a reminder of this kind/subject was acknowledged.
	 * A subject-less lookup falls back to the kind-wide read marker.
	 */
	lastReadStep(kind: ReminderKind, subjectKey?: string): number | undefined;
}

/** Produces the reminders that should exist at the current step. */
export interface ReminderProducer {
	readonly id: string;
	produce(context: ReminderProduceContext): readonly ReminderSeed[];
}

export interface ReminderRegistryOptions {
	producers?: readonly ReminderProducer[];
}
