import { renderReminderBlock } from "./render.ts";
import { advanceReminderSnoozes, hasReminderSnooze } from "./snoozes.ts";
import type {
	Reminder,
	ReminderDelivery,
	ReminderKind,
	ReminderLifecycle,
	ReminderProduceContext,
	ReminderProducer,
	ReminderRegistryOptions,
	ReminderSeed,
} from "./types.ts";

function reminderKey(kind: ReminderKind, subjectKey?: string): string {
	return `${kind}\u0000${subjectKey ?? ""}`;
}

function reminderMatches(reminder: Reminder, kind: ReminderKind, subjectKey?: string): boolean {
	if (reminder.kind !== kind) return false;
	if (subjectKey === undefined) return true;
	return reminder.subjectKey === subjectKey;
}

/**
 * Per-session reminder registry.
 *
 * Call `onModelStep()` exactly once at the start of every model request turn.
 * It returns the reminders due that turn (deduplicated and rendered), advances
 * the model-step clock, and decrements any active snooze windows.
 */
export class ReminderRegistry {
	private readonly producers: ReminderProducer[] = [];
	private readonly active = new Map<string, Reminder>();
	private readonly terminal = new Map<string, Reminder>();
	private readonly readSteps = new Map<string, number>();
	private step = 0;
	private order = 0;

	constructor(options: ReminderRegistryOptions = {}) {
		for (const producer of options.producers ?? []) this.producers.push(producer);
	}

	/** Number of model request steps advanced so far. */
	get currentStep(): number {
		return this.step;
	}

	addProducer(producer: ReminderProducer): void {
		this.producers.push(producer);
	}

	/**
	 * Register a reminder explicitly (used by non-producer kinds and tests).
	 * Reactivates a previously acknowledged or dismissed reminder.
	 */
	registerReminder(seed: ReminderSeed): Reminder {
		return this.upsertSeed(seed, true);
	}

	/**
	 * Advance one model request step and return the reminders to hand to the
	 * request, ordered by priority then insertion order.
	 */
	onModelStep(): ReminderDelivery[] {
		this.step += 1;
		this.syncProducers();

		const due = [...this.active.values()]
			.filter((reminder) => this.isDue(reminder))
			.sort((a, b) => a.priority - b.priority || a.order - b.order);

		const deliveries: ReminderDelivery[] = [];
		for (const reminder of due) {
			if (hasReminderSnooze(reminder.kind, reminder.subjectKey)) {
				reminder.lifecycle = "snoozed";
				continue;
			}
			reminder.lifecycle = "delivered";
			reminder.lastDeliveredStep = this.step;
			reminder.deliveryCount += 1;
			deliveries.push({
				kind: reminder.kind,
				subjectKey: reminder.subjectKey,
				text: reminder.text,
				priority: reminder.priority,
				step: this.step,
				rendered: renderReminderBlock(reminder),
			});
		}

		advanceReminderSnoozes();
		return deliveries;
	}

	/**
	 * Acknowledge reminders so they stop delivering. A subject-less call
	 * acknowledges every subject of the kind. Also records a read marker so
	 * producers stay quiet until their recency window passes.
	 */
	acknowledgeReminder(kind: ReminderKind, subjectKey?: string): number {
		const count = this.moveToTerminal(kind, subjectKey, "acknowledged");
		this.markRead(kind, subjectKey);
		return count;
	}

	/** Dismiss reminders permanently; producers will not resurrect them. */
	dismissReminder(kind: ReminderKind, subjectKey?: string): number {
		return this.moveToTerminal(kind, subjectKey, "dismissed");
	}

	/** Active and terminal reminders, in insertion order. */
	listReminders(): readonly Reminder[] {
		return [...this.active.values(), ...this.terminal.values()].sort((a, b) => a.order - b.order);
	}

	getReminder(kind: ReminderKind, subjectKey?: string): Reminder | undefined {
		return this.active.get(reminderKey(kind, subjectKey)) ?? this.terminal.get(reminderKey(kind, subjectKey));
	}

	/** Drop all reminders, read markers, and the step clock. */
	clear(): void {
		this.active.clear();
		this.terminal.clear();
		this.readSteps.clear();
		this.step = 0;
		this.order = 0;
	}

	private upsertSeed(seed: ReminderSeed, force: boolean): Reminder {
		const key = reminderKey(seed.kind, seed.subjectKey);
		if (force) this.terminal.delete(key);
		const priority = seed.priority ?? 0;
		const existing = this.active.get(key);
		if (existing) {
			existing.text = seed.text;
			existing.priority = priority;
			existing.repeatEverySteps = seed.repeatEverySteps;
			return existing;
		}
		const reminder: Reminder = {
			kind: seed.kind,
			subjectKey: seed.subjectKey,
			text: seed.text,
			priority,
			repeatEverySteps: seed.repeatEverySteps,
			lifecycle: "pending",
			createdAtStep: this.step,
			deliveryCount: 0,
			order: this.order++,
		};
		this.active.set(key, reminder);
		return reminder;
	}

	private syncProducers(): void {
		const context: ReminderProduceContext = {
			step: this.step,
			lastReadStep: (kind, subjectKey) => this.lookupReadStep(kind, subjectKey),
		};
		for (const producer of this.producers) {
			for (const seed of producer.produce(context)) {
				const key = reminderKey(seed.kind, seed.subjectKey);
				const terminal = this.terminal.get(key);
				if (terminal?.lifecycle === "dismissed") continue;
				if (terminal?.lifecycle === "acknowledged") this.terminal.delete(key);
				this.upsertSeed(seed, false);
			}
		}
	}

	private isDue(reminder: Reminder): boolean {
		switch (reminder.lifecycle) {
			case "acknowledged":
			case "dismissed":
				return false;
			case "pending":
				return true;
			case "delivered":
				if (reminder.repeatEverySteps === undefined) return false;
				return this.cadenceElapsed(reminder);
			case "snoozed":
				if (reminder.repeatEverySteps === undefined) return reminder.lastDeliveredStep === undefined;
				return reminder.lastDeliveredStep === undefined || this.cadenceElapsed(reminder);
		}
	}

	private cadenceElapsed(reminder: Reminder): boolean {
		if (reminder.lastDeliveredStep === undefined) return true;
		return this.step - reminder.lastDeliveredStep >= (reminder.repeatEverySteps ?? 1);
	}

	private moveToTerminal(kind: ReminderKind, subjectKey: string | undefined, lifecycle: ReminderLifecycle): number {
		let count = 0;
		for (const [key, reminder] of this.active) {
			if (!reminderMatches(reminder, kind, subjectKey)) continue;
			reminder.lifecycle = lifecycle;
			this.active.delete(key);
			this.terminal.set(key, reminder);
			count += 1;
		}
		return count;
	}

	private markRead(kind: ReminderKind, subjectKey?: string): void {
		this.readSteps.set(reminderKey(kind, subjectKey), this.step);
	}

	private lookupReadStep(kind: ReminderKind, subjectKey?: string): number | undefined {
		const exact = this.readSteps.get(reminderKey(kind, subjectKey));
		if (exact !== undefined) return exact;
		if (subjectKey !== undefined) return this.readSteps.get(reminderKey(kind));
		return undefined;
	}
}
