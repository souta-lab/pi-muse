import { randomUUID } from "node:crypto";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "../core/extensions/types.ts";
import type { SessionEntry } from "../core/session-manager.ts";

/**
 * Muse's three cron tools: `cron_create`, `cron_delete`, and `cron_list`.
 *
 * The live Muse CLI schedules prompts with a 5-field local-time cron. This
 * extension reproduces the observable contract:
 *  - jobs are session-scoped and persisted through append-only `custom` session
 *    entries (`pi.muse_cron`), so a resumed session reconstructs and re-arms
 *    them;
 *  - recurring jobs auto-expire 7 days after creation;
 *  - a fire injects the stored prompt as a custom message with
 *    `{ deliverAs: "followUp", triggerTurn: true }`, the same delivery the
 *    background-bash result uses, so an idle session starts a new turn and an
 *    active run receives the prompt as a follow-up.
 *
 * Timers are unref'ed and cleared on `session_shutdown`. Scheduling logic is
 * driven entirely through an injected clock and timer hooks so tests never
 * sleep.
 */

/** Tool names registered by this extension, in Muse's relative order. */
export const MUSE_CRON_TOOL_NAMES = ["cron_create", "cron_delete", "cron_list"] as const;

export type MuseCronToolName = (typeof MUSE_CRON_TOOL_NAMES)[number];

/** Session custom-entry type carrying the append-only cron job event log. */
export const MUSE_CRON_CUSTOM_TYPE = "pi.muse_cron";

/** Recurring jobs auto-expire this long after their creation (7 days). */
export const MUSE_CRON_RECURRING_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** customType of the injected message that delivers a fired prompt to the agent. */
export const MUSE_CRON_FIRE_CUSTOM_TYPE = "muse_cron_fire";

/** Hard cap on field-by-field search steps so impossible expressions terminate. */
const MAX_CRON_SEARCH_STEPS = 100_000;

// ============================================================================
// Cron parsing and evaluation (5 fields: minute hour day-of-month month day-of-week)
// ============================================================================

export interface CronField {
	readonly values: ReadonlySet<number>;
	/**
	 * False only for the bare `*` field. Used for the day-of-month/day-of-week
	 * rule: when both are restricted, the standard cron OR semantics apply.
	 */
	readonly restricted: boolean;
}

export interface ParsedCron {
	readonly minute: CronField;
	readonly hour: CronField;
	readonly dayOfMonth: CronField;
	readonly month: CronField;
	/** Canonical values 0-6 where Sunday is 0; the range accepts 0-7 and maps 7 to 0. */
	readonly dayOfWeek: CronField;
}

export interface CronFieldConfig {
	name: string;
	min: number;
	max: number;
	/** Maps a raw value to its canonical value (e.g. 7 -> 0 for Sunday). */
	normalize?: (value: number) => number;
}

function canonicalize(value: number, config: CronFieldConfig): number {
	return config.normalize ? config.normalize(value) : value;
}

function parseCronValue(text: string, config: CronFieldConfig): number {
	if (!/^\d+$/.test(text)) {
		throw new Error(`cron ${config.name} value "${text}" is not a number`);
	}
	const value = Number(text);
	if (value < config.min || value > config.max) {
		throw new Error(`cron ${config.name} value ${value} is out of range ${config.min}-${config.max}`);
	}
	return value;
}

/**
 * Expand `start-end` (inclusive) by `step`. A range whose start is greater than
 * its end wraps around the field boundary (e.g. hours `22-2` -> 22,23,0,1,2).
 * Values are canonicalized before insertion (day-of-week 7 -> 0).
 */
function expandRange(start: number, end: number, step: number, config: CronFieldConfig, out: Set<number>): void {
	const span = config.max - config.min + 1;
	const startIndex = start - config.min;
	let endIndex = end - config.min;
	if (startIndex > endIndex) endIndex += span;
	for (let index = startIndex; index <= endIndex; index += step) {
		out.add(canonicalize(config.min + (index % span), config));
	}
}

/**
 * Parse one cron field. Supports wildcards, lists (`1,2,5`), ranges (`1-5`),
 * steps (`0-59/15`, `10-20/5`, `50/5`), and wraparound ranges.
 */
export function parseCronField(spec: string, config: CronFieldConfig): CronField {
	const trimmed = spec.trim();
	if (trimmed.length === 0) {
		throw new Error(`cron ${config.name} field is empty`);
	}
	const restricted = trimmed !== "*";
	const values = new Set<number>();

	for (const rawSegment of trimmed.split(",")) {
		const segment = rawSegment.trim();
		if (segment.length === 0) {
			throw new Error(`cron ${config.name} field contains an empty list item`);
		}
		const slash = segment.indexOf("/");
		const base = slash === -1 ? segment : segment.slice(0, slash);
		const stepText = slash === -1 ? undefined : segment.slice(slash + 1);
		let step = 1;
		if (stepText !== undefined) {
			if (!/^\d+$/.test(stepText) || Number(stepText) < 1) {
				throw new Error(`cron ${config.name} step "${stepText}" must be a positive integer`);
			}
			step = Number(stepText);
		}

		if (base === "*") {
			expandRange(config.min, config.max, step, config, values);
			continue;
		}
		const dash = base.indexOf("-");
		if (dash !== -1) {
			const start = parseCronValue(base.slice(0, dash), config);
			const end = parseCronValue(base.slice(dash + 1), config);
			expandRange(start, end, step, config, values);
			continue;
		}
		const single = parseCronValue(base, config);
		if (stepText === undefined) {
			values.add(canonicalize(single, config));
			continue;
		}
		// `N/step` means N through the field maximum, stepping by `step`.
		expandRange(single, config.max, step, config, values);
	}

	return { values, restricted };
}

const MINUTE_CONFIG: CronFieldConfig = { name: "minute", min: 0, max: 59 };
const HOUR_CONFIG: CronFieldConfig = { name: "hour", min: 0, max: 23 };
const DAY_OF_MONTH_CONFIG: CronFieldConfig = { name: "day-of-month", min: 1, max: 31 };
const MONTH_CONFIG: CronFieldConfig = { name: "month", min: 1, max: 12 };
const DAY_OF_WEEK_CONFIG: CronFieldConfig = {
	name: "day-of-week",
	min: 0,
	max: 7,
	normalize: (value) => (value === 7 ? 0 : value),
};

/** Parse a complete 5-field local-time cron expression. Throws on invalid input. */
export function parseCron(expression: string): ParsedCron {
	const fields = expression.trim().split(/\s+/);
	if (fields.length !== 5) {
		throw new Error(
			`cron must have exactly 5 fields (minute hour day-of-month month day-of-week), got ${fields.length}`,
		);
	}
	return {
		minute: parseCronField(fields[0], MINUTE_CONFIG),
		hour: parseCronField(fields[1], HOUR_CONFIG),
		dayOfMonth: parseCronField(fields[2], DAY_OF_MONTH_CONFIG),
		month: parseCronField(fields[3], MONTH_CONFIG),
		dayOfWeek: parseCronField(fields[4], DAY_OF_WEEK_CONFIG),
	};
}

/**
 * Day match with the standard cron rule: if both day-of-month and day-of-week
 * are restricted (neither is `*`), the day matches when EITHER field matches;
 * otherwise both fields must match (an unrestricted field matches every day).
 */
function cronDayMatches(cron: ParsedCron, date: Date): boolean {
	const dayOfMonth = cron.dayOfMonth.values.has(date.getDate());
	const dayOfWeek = cron.dayOfWeek.values.has(date.getDay());
	if (cron.dayOfMonth.restricted && cron.dayOfWeek.restricted) {
		return dayOfMonth || dayOfWeek;
	}
	return dayOfMonth && dayOfWeek;
}

/**
 * Earliest occurrence strictly after `from`, evaluated against the process's
 * local timezone. The search advances by whole months/days/hours where possible
 * so rare expressions (e.g. Feb 29) resolve quickly, and throws when no
 * occurrence exists within the search horizon.
 */
export function nextCronFire(cron: ParsedCron, from: Date): Date {
	const start = new Date(
		from.getFullYear(),
		from.getMonth(),
		from.getDate(),
		from.getHours(),
		from.getMinutes(),
		0,
		0,
	);
	let candidate = new Date(start.getTime() + 60_000);

	for (let step = 0; step < MAX_CRON_SEARCH_STEPS; step += 1) {
		if (!cron.month.values.has(candidate.getMonth() + 1)) {
			candidate = new Date(candidate.getFullYear(), candidate.getMonth() + 1, 1, 0, 0, 0, 0);
			continue;
		}
		if (!cronDayMatches(cron, candidate)) {
			candidate = new Date(candidate.getFullYear(), candidate.getMonth(), candidate.getDate() + 1, 0, 0, 0, 0);
			continue;
		}
		if (!cron.hour.values.has(candidate.getHours())) {
			candidate = new Date(
				candidate.getFullYear(),
				candidate.getMonth(),
				candidate.getDate(),
				candidate.getHours() + 1,
				0,
				0,
				0,
			);
			continue;
		}
		if (!cron.minute.values.has(candidate.getMinutes())) {
			candidate = new Date(candidate.getTime() + 60_000);
			continue;
		}
		return candidate;
	}

	throw new Error("cron expression has no occurrence within the search horizon");
}

// ============================================================================
// Job model, persistence, and scheduler
// ============================================================================

/** Persisted job fields. `nextFireAt` is the fire slot known when the entry was written. */
export interface PersistedCronJob {
	id: string;
	cron: string;
	prompt: string;
	recurring: boolean;
	fireWhenActiveRun: boolean;
	createdAt: number;
	nextFireAt: number;
}

/** Append-only event stored in one `pi.muse_cron` custom session entry. */
export type PersistedCronEvent = { kind: "create"; job: PersistedCronJob } | { kind: "delete"; id: string };

/** In-memory job: persisted fields plus the derived recurring expiry. */
export interface CronJob extends PersistedCronJob {
	expiresAt: number | null;
}

export interface CronSchedulerHooks {
	now(): number;
	/** Called once per due job, after its slot is consumed and its state advanced. */
	onDue(job: CronJob): void;
	/**
	 * Called whenever the scheduler itself drops a job (one-shot fired, recurring
	 * expired, or explicit delete). `dispose()` and restore-time drops do not call
	 * it. Lets callers persist the removal so a resume does not resurrect the job.
	 */
	onRemoved(job: CronJob): void;
	setTimer(callback: () => void, delayMs: number): unknown;
	clearTimer(handle: unknown): void;
}

export interface CronCreateInput {
	cron: string;
	prompt: string;
	recurring: boolean;
	fireWhenActiveRun: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isPersistedCronJob(value: unknown): value is PersistedCronJob {
	if (!isRecord(value)) return false;
	return (
		typeof value.id === "string" &&
		typeof value.cron === "string" &&
		typeof value.prompt === "string" &&
		typeof value.recurring === "boolean" &&
		typeof value.fireWhenActiveRun === "boolean" &&
		typeof value.createdAt === "number" &&
		typeof value.nextFireAt === "number"
	);
}

/**
 * Replay `pi.muse_cron` entries from an active session branch into the
 * create/delete events they encode. Entries on other branches are ignored
 * because the caller passes `sessionManager.getBranch()`.
 */
export function readPersistedCronEvents(entries: readonly SessionEntry[]): PersistedCronEvent[] {
	const events: PersistedCronEvent[] = [];
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== MUSE_CRON_CUSTOM_TYPE) continue;
		const data = entry.data;
		if (!isRecord(data)) continue;
		if (data.kind === "create" && isPersistedCronJob(data.job)) {
			events.push({ kind: "create", job: data.job });
		} else if (data.kind === "delete" && typeof data.id === "string") {
			events.push({ kind: "delete", id: data.id });
		}
	}
	return events;
}

function toPersistedJob(job: CronJob): PersistedCronJob {
	return {
		id: job.id,
		cron: job.cron,
		prompt: job.prompt,
		recurring: job.recurring,
		fireWhenActiveRun: job.fireWhenActiveRun,
		createdAt: job.createdAt,
		nextFireAt: job.nextFireAt,
	};
}

/**
 * Wall-clock scheduler with an injected clock and timer hooks. Every method is
 * synchronous and deterministic given the injected clock, so tests drive it via
 * `tick()`/timer callbacks instead of sleeping.
 */
export class MuseCronScheduler {
	private readonly hooks: CronSchedulerHooks;
	private readonly jobs = new Map<string, CronJob>();
	private readonly parsedByExpression = new Map<string, ParsedCron>();
	private timer: unknown;

	constructor(hooks: CronSchedulerHooks) {
		this.hooks = hooks;
	}

	private parse(expression: string): ParsedCron {
		const cached = this.parsedByExpression.get(expression);
		if (cached) return cached;
		const parsed = parseCron(expression);
		this.parsedByExpression.set(expression, parsed);
		return parsed;
	}

	/**
	 * Rebuild jobs from the persisted event log.
	 *
	 * Missed-fire policy:
	 *  - recurring jobs skip slots that elapsed while the session was closed and
	 *    are re-armed at the first slot strictly after now; jobs already past
	 *    their 7-day expiry are dropped;
	 *  - a one-shot whose stored slot has passed fires once on resume (it never
	 *    ran), while one still in the future keeps its slot.
	 */
	restore(events: readonly PersistedCronEvent[]): void {
		const now = this.hooks.now();
		for (const event of events) {
			if (event.kind === "delete") {
				this.jobs.delete(event.id);
				continue;
			}
			const job = event.job;
			let parsed: ParsedCron;
			try {
				parsed = this.parse(job.cron);
			} catch {
				continue; // Corrupt or no-longer-valid expression: drop it rather than crash resume.
			}
			if (job.recurring) {
				const expiresAt = job.createdAt + MUSE_CRON_RECURRING_TTL_MS;
				if (expiresAt <= now) continue;
				const nextFireAt = job.nextFireAt > now ? job.nextFireAt : nextCronFire(parsed, new Date(now)).getTime();
				if (nextFireAt >= expiresAt) continue;
				this.jobs.set(job.id, { ...job, expiresAt, nextFireAt });
			} else {
				const nextFireAt = job.nextFireAt > now ? job.nextFireAt : now;
				this.jobs.set(job.id, { ...job, expiresAt: null, nextFireAt });
			}
		}
	}

	/** Create a job at the first cron slot strictly after now. Throws on invalid/never-firing expressions. */
	create(input: CronCreateInput): CronJob {
		const parsed = this.parse(input.cron);
		const now = this.hooks.now();
		const nextFireAt = nextCronFire(parsed, new Date(now)).getTime();
		const expiresAt = input.recurring ? now + MUSE_CRON_RECURRING_TTL_MS : null;
		if (expiresAt !== null && nextFireAt >= expiresAt) {
			throw new Error(`cron "${input.cron}" has no occurrence within the 7-day recurring lifetime`);
		}
		const job: CronJob = {
			id: randomUUID(),
			cron: input.cron,
			prompt: input.prompt,
			recurring: input.recurring,
			fireWhenActiveRun: input.fireWhenActiveRun,
			createdAt: now,
			expiresAt,
			nextFireAt,
		};
		this.jobs.set(job.id, job);
		return job;
	}

	/** Remove a job. Returns false when the id is unknown. */
	remove(id: string): boolean {
		const job = this.jobs.get(id);
		if (!job) return false;
		this.jobs.delete(id);
		this.hooks.onRemoved(job);
		return true;
	}

	get(id: string): CronJob | undefined {
		return this.jobs.get(id);
	}

	/** Jobs ordered by next fire time. */
	list(): CronJob[] {
		return [...this.jobs.values()].sort((a, b) => a.nextFireAt - b.nextFireAt);
	}

	/**
	 * Consume every job due at `now`: fire once per overdue job (missed recurring
	 * slots are coalesced, not replayed), delete one-shots, reschedule or expire
	 * recurring jobs, then invoke `onDue` for each fired job.
	 */
	tick(now: number = this.hooks.now()): CronJob[] {
		const fired: CronJob[] = [];
		for (const job of [...this.jobs.values()]) {
			if (job.nextFireAt > now) continue;

			if (job.recurring && job.expiresAt !== null && now >= job.expiresAt) {
				this.jobs.delete(job.id);
				this.hooks.onRemoved(job);
				continue;
			}

			fired.push({ ...job });

			if (!job.recurring) {
				this.jobs.delete(job.id);
				this.hooks.onRemoved(job);
				continue;
			}

			const next = nextCronFire(this.parse(job.cron), new Date(now)).getTime();
			if (job.expiresAt !== null && next >= job.expiresAt) {
				this.jobs.delete(job.id);
				this.hooks.onRemoved(job);
			} else {
				job.nextFireAt = next;
			}
		}
		for (const job of fired) this.hooks.onDue(job);
		return fired;
	}

	/** (Re)schedule a single timer for the earliest next fire; unref'd by the default hook. */
	arm(): void {
		this.hooks.clearTimer(this.timer);
		this.timer = undefined;
		let earliest: number | undefined;
		for (const job of this.jobs.values()) {
			if (earliest === undefined || job.nextFireAt < earliest) earliest = job.nextFireAt;
		}
		if (earliest === undefined) return;
		const delay = Math.max(0, earliest - this.hooks.now());
		this.timer = this.hooks.setTimer(() => {
			this.timer = undefined;
			this.tick();
			this.arm();
		}, delay);
	}

	/** Clear the pending timer and drop in-memory jobs (session shutdown). */
	dispose(): void {
		this.hooks.clearTimer(this.timer);
		this.timer = undefined;
		this.jobs.clear();
	}
}

// ============================================================================
// Extension wiring
// ============================================================================

export interface MuseCronExtensionOptions {
	/** Injected wall clock (epoch ms). Defaults to `Date.now`. */
	now?(): number;
	/** Injected timer registration. Defaults to an unref'ed `setTimeout`. */
	setTimer?(callback: () => void, delayMs: number): unknown;
	/** Injected timer cancellation. Defaults to `clearTimeout`. */
	clearTimer?(handle: unknown): void;
}

function setUnrefTimer(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> {
	const timer = setTimeout(callback, delayMs);
	timer.unref();
	return timer;
}

function clearRealTimer(handle: unknown): void {
	if (handle === undefined || handle === null) return;
	clearTimeout(handle as ReturnType<typeof setTimeout>);
}

function readString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function pad(value: number): string {
	return String(value).padStart(2, "0");
}

/** Local wall-clock minute, e.g. `2026-01-05 09:30`. */
function formatLocalMinute(ms: number): string {
	const date = new Date(ms);
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function describeCadence(job: CronJob): string {
	if (!job.recurring) return "once";
	return job.expiresAt === null ? "recurring" : `recurring until ${formatLocalMinute(job.expiresAt)}`;
}

function failureResult(tool: string, message: string): AgentToolResult<Record<string, unknown>> {
	return {
		content: [{ type: "text" as const, text: `${tool} failed: ${message}` }],
		details: { error: message },
	};
}

function registerCronTools(pi: ExtensionAPI, getScheduler: () => MuseCronScheduler | undefined): void {
	pi.registerTool({
		name: "cron_create",
		label: "cron_create",
		description:
			"Schedule a prompt to run later — once, or on a repeating 5-field local-time cron. Recurring jobs auto-expire after 7 days. Returns a job id you can pass to muse.cron_delete.",
		parameters: Type.Unsafe({
			type: "object",
			additionalProperties: false,
			required: ["cron", "prompt"],
			properties: {
				cron: {
					type: "string",
					description: '5-field cron in local time: "M H DoM Mon DoW". Avoid :00/:30 for approximate times.',
				},
				fire_immediately: {
					type: "boolean",
					description:
						"false (default) waits for the first cron slot; true requires recurring=true and returns an instruction to run the prompt now in this same turn while the stored job starts at the next cron slot.",
				},
				fire_when_active_run: {
					type: "boolean",
					description:
						"true (default) fires even while a run is active; false skips every scheduled fire that lands during an active run.",
				},
				prompt: {
					type: "string",
					description: "The prompt to run at each fire.",
				},
				recurring: {
					type: "boolean",
					description: "true (default) repeats until deleted/expired; false fires once then deletes.",
				},
			},
		}),
		execute: async (_toolCallId, input: Record<string, unknown>) => {
			const scheduler = getScheduler();
			if (!scheduler) {
				return failureResult("cron_create", "the cron scheduler is not initialized for this session");
			}
			const cron = readString(input.cron);
			const prompt = readString(input.prompt);
			if (!cron) return failureResult("cron_create", "cron is required");
			if (!prompt) return failureResult("cron_create", "prompt is required");
			const recurring = input.recurring !== false;
			const fireWhenActiveRun = input.fire_when_active_run !== false;
			const fireImmediately = input.fire_immediately === true;
			if (fireImmediately && !recurring) {
				return failureResult("cron_create", "fire_immediately=true requires recurring=true");
			}

			let job: CronJob;
			try {
				job = scheduler.create({ cron, prompt, recurring, fireWhenActiveRun });
			} catch (error) {
				return failureResult("cron_create", errorMessage(error));
			}
			pi.appendEntry(MUSE_CRON_CUSTOM_TYPE, {
				kind: "create",
				job: toPersistedJob(job),
			} satisfies PersistedCronEvent);
			scheduler.arm();

			let text = `Scheduled job ${job.id} (${describeCadence(job)}). Cron: ${job.cron}. Next fire: ${formatLocalMinute(job.nextFireAt)}.`;
			if (fireImmediately) {
				text += `\nRun this prompt now in this same turn: ${job.prompt}`;
			}
			return {
				content: [{ type: "text" as const, text }],
				details: {
					id: job.id,
					cron: job.cron,
					recurring: job.recurring,
					fire_when_active_run: job.fireWhenActiveRun,
					next_fire_at: job.nextFireAt,
					expires_at: job.expiresAt,
				},
			};
		},
	});

	pi.registerTool({
		name: "cron_delete",
		label: "cron_delete",
		description: "Cancel a scheduled job by its id (from muse.cron_create/muse.cron_list).",
		parameters: Type.Unsafe({
			type: "object",
			additionalProperties: false,
			required: ["id"],
			properties: {
				id: {
					type: "string",
					description: "Job id to cancel.",
				},
			},
		}),
		execute: async (_toolCallId, input: Record<string, unknown>) => {
			const scheduler = getScheduler();
			if (!scheduler) {
				return failureResult("cron_delete", "the cron scheduler is not initialized for this session");
			}
			const id = readString(input.id);
			if (!id) return failureResult("cron_delete", "id is required");

			if (!scheduler.remove(id)) {
				return {
					content: [{ type: "text" as const, text: `No scheduled job with id ${id}.` }],
					details: { id, deleted: false },
				};
			}
			scheduler.arm();
			return {
				content: [{ type: "text" as const, text: `Cancelled scheduled job ${id}.` }],
				details: { id, deleted: true },
			};
		},
	});

	pi.registerTool({
		name: "cron_list",
		label: "cron_list",
		description: "List all scheduled jobs for this session, with their cadence and next fire time.",
		parameters: Type.Unsafe({
			type: "object",
			additionalProperties: false,
			properties: {},
		}),
		execute: async () => {
			const scheduler = getScheduler();
			if (!scheduler) {
				return failureResult("cron_list", "the cron scheduler is not initialized for this session");
			}
			const jobs = scheduler.list();
			if (jobs.length === 0) {
				return {
					content: [{ type: "text" as const, text: "No scheduled jobs for this session." }],
					details: { count: 0, jobs: [] },
				};
			}
			const lines = jobs.map(
				(job) => `${job.id}  ${job.cron}  ${describeCadence(job)}  next: ${formatLocalMinute(job.nextFireAt)}`,
			);
			return {
				content: [{ type: "text" as const, text: lines.join("\n") }],
				details: {
					count: jobs.length,
					jobs: jobs.map((job) => ({
						id: job.id,
						cron: job.cron,
						recurring: job.recurring,
						fire_when_active_run: job.fireWhenActiveRun,
						next_fire_at: job.nextFireAt,
						expires_at: job.expiresAt,
					})),
				},
			};
		},
	});
}

export default function museCronExtension(pi: ExtensionAPI, options: MuseCronExtensionOptions = {}): void {
	const now = options.now ?? (() => Date.now());
	const setTimer = options.setTimer ?? setUnrefTimer;
	const clearTimer = options.clearTimer ?? clearRealTimer;
	let scheduler: MuseCronScheduler | undefined;
	let activeContext: ExtensionContext | undefined;

	const fire = (job: CronJob): void => {
		const ctx = activeContext;
		// Official semantics: false skips every fire that lands during an active run.
		if (!job.fireWhenActiveRun && ctx !== undefined && !ctx.isIdle()) return;
		pi.sendMessage(
			{
				customType: MUSE_CRON_FIRE_CUSTOM_TYPE,
				content: job.prompt,
				display: false,
				details: { cron_job_id: job.id, cron: job.cron },
			},
			{ deliverAs: "followUp", triggerTurn: true },
		);
	};

	const onRemoved = (job: CronJob): void => {
		pi.appendEntry(MUSE_CRON_CUSTOM_TYPE, { kind: "delete", id: job.id } satisfies PersistedCronEvent);
	};

	pi.on("session_shutdown", () => {
		scheduler?.dispose();
		scheduler = undefined;
		activeContext = undefined;
	});

	pi.on("session_start", (_event, ctx) => {
		activeContext = ctx;
		const activeScheduler = new MuseCronScheduler({ now, onDue: fire, onRemoved, setTimer, clearTimer });
		scheduler = activeScheduler;
		activeScheduler.restore(readPersistedCronEvents(ctx.sessionManager.getBranch()));
		activeScheduler.arm();
		registerCronTools(pi, () => scheduler);
	});
}
