import type { ReminderDelivery, ReminderKind } from "./types.ts";

function escapeXml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

/** Render one reminder as the in-band block Muse models receive. */
export function renderReminderBlock(reminder: { kind: ReminderKind; text: string }): string {
	return `<system-reminder source="${escapeXml(reminder.kind)}">\n${reminder.text}\n</system-reminder>`;
}

/** Join deliveries for one turn with blank lines between blocks. */
export function renderReminderDeliveries(deliveries: readonly ReminderDelivery[]): string {
	return deliveries.map((delivery) => delivery.rendered).join("\n\n");
}
