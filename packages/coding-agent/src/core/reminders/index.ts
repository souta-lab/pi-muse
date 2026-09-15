import { createDefaultReminderProducers } from "./producers.ts";
import { ReminderRegistry } from "./registry.ts";
import { renderReminderDeliveries } from "./render.ts";
import type { ReminderDelivery, ReminderRegistryOptions } from "./types.ts";

export * from "./producers.ts";
export { ReminderRegistry } from "./registry.ts";
export * from "./render.ts";
export * from "./snoozes.ts";
export * from "./types.ts";

/** Result of advancing one model request turn's reminder delivery. */
export interface ReminderStepResult {
	deliveries: readonly ReminderDelivery[];
	/** The joined `<system-reminder>` blocks to append to the request. */
	prompt: string;
}

/**
 * Build the per-session registry with the built-in `skill` and `memory`
 * producers. Pass `options.producers` to supply a custom, data-driven set.
 */
export function createMuseReminderRegistry(options: ReminderRegistryOptions = {}): ReminderRegistry {
	return new ReminderRegistry({
		producers: options.producers ?? createDefaultReminderProducers(),
	});
}

/**
 * Integration helper: advance one model request step and render the due
 * reminders. Call this once at the start of each model request turn.
 */
export function collectReminderPrompt(registry: ReminderRegistry): ReminderStepResult {
	const deliveries = registry.onModelStep();
	return { deliveries, prompt: renderReminderDeliveries(deliveries) };
}
