import { describe, expect, it } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "../src/core/extensions/types.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import museCronExtension, {
	type CronField,
	type CronJob,
	MUSE_CRON_CUSTOM_TYPE,
	MUSE_CRON_FIRE_CUSTOM_TYPE,
	MUSE_CRON_RECURRING_TTL_MS,
	MUSE_CRON_TOOL_NAMES,
	MuseCronScheduler,
	nextCronFire,
	parseCron,
	readPersistedCronEvents,
} from "../src/extensions/muse-cron.ts";

/** Fixed local wall clock used across scheduler/tool tests: 2026-01-05 12:30 local (a Monday). */
const START = new Date(2026, 0, 5, 12, 30, 0, 0).getTime();
const MINUTE = 60_000;

function fieldValues(field: CronField): number[] {
	return [...field.values].sort((a, b) => a - b);
}

function next(cron: string, from: Date): number {
	return nextCronFire(parseCron(cron), from).getTime();
}

// ============================================================================
// Cron field parsing
// ============================================================================

describe("cron field parsing", () => {
	it("parses wildcards as unrestricted full ranges", () => {
		const parsed = parseCron("* * * * *");
		expect(parsed.minute.restricted).toBe(false);
		expect(parsed.dayOfMonth.restricted).toBe(false);
		expect(parsed.month.values.size).toBe(12);
		expect(parsed.hour.values.size).toBe(24);
	});

	it("parses lists", () => {
		expect(fieldValues(parseCron("1,15,30 * * * *").minute)).toEqual([1, 15, 30]);
	});

	it("parses ranges", () => {
		expect(fieldValues(parseCron("10-12 * * * *").minute)).toEqual([10, 11, 12]);
	});

	it("parses steps", () => {
		expect(fieldValues(parseCron("*/15 * * * *").minute)).toEqual([0, 15, 30, 45]);
	});

	it("parses range steps and single-value steps", () => {
		expect(fieldValues(parseCron("10-20/5 * * * *").minute)).toEqual([10, 15, 20]);
		expect(fieldValues(parseCron("50/5 * * * *").minute)).toEqual([50, 55]);
	});

	it("parses wraparound ranges across the field boundary", () => {
		expect(fieldValues(parseCron("* 22-2 * * *").hour)).toEqual([0, 1, 2, 22, 23]);
		expect(fieldValues(parseCron("* * * * 5-1").dayOfWeek)).toEqual([0, 1, 5, 6]);
	});

	it("maps day-of-week 7 to Sunday 0", () => {
		expect(fieldValues(parseCron("* * * * 7").dayOfWeek)).toEqual([0]);
		expect(fieldValues(parseCron("* * * * 0").dayOfWeek)).toEqual([0]);
		expect(fieldValues(parseCron("* * * * 1-5").dayOfWeek)).toEqual([1, 2, 3, 4, 5]);
	});

	it("rejects malformed fields and expressions", () => {
		expect(() => parseCron("* * * *")).toThrow(/exactly 5 fields/);
		expect(() => parseCron("60 * * * *")).toThrow(/out of range/);
		expect(() => parseCron("a * * * *")).toThrow(/not a number/);
		expect(() => parseCron("*/0 * * * *")).toThrow(/positive integer/);
		expect(() => parseCron("1,,2 * * * *")).toThrow(/empty list item/);
		expect(() => parseCron("0 0 30 2 *")).not.toThrow(); // valid syntax, but never fires
	});
});

// ============================================================================
// Next-fire computation
// ============================================================================

describe("next cron fire", () => {
	it("advances to the next minute boundary after the from time", () => {
		expect(next("* * * * *", new Date(2026, 0, 5, 12, 30, 0))).toBe(new Date(2026, 0, 5, 12, 31).getTime());
		expect(next("* * * * *", new Date(2026, 0, 5, 12, 30, 45))).toBe(new Date(2026, 0, 5, 12, 31).getTime());
	});

	it("finds the next matching minute within the hour", () => {
		expect(next("*/15 * * * *", new Date(2026, 0, 5, 12, 7, 0))).toBe(new Date(2026, 0, 5, 12, 15).getTime());
	});

	it("rolls forward by day for a fixed daily time", () => {
		expect(next("30 9 * * *", new Date(2026, 0, 5, 10, 0, 0))).toBe(new Date(2026, 0, 6, 9, 30).getTime());
	});

	it("handles wraparound hours", () => {
		expect(next("30 22-2 * * *", new Date(2026, 0, 5, 12, 0, 0))).toBe(new Date(2026, 0, 5, 22, 30).getTime());
		expect(next("30 22-2 * * *", new Date(2026, 0, 5, 23, 40, 0))).toBe(new Date(2026, 0, 6, 0, 30).getTime());
	});

	it("uses OR when both day-of-month and day-of-week are restricted", () => {
		// 2026-01-01 is a Thursday, so the next Sunday is 2026-01-04.
		expect(next("0 0 1 * 0", new Date(2026, 0, 2, 12, 0, 0))).toBe(new Date(2026, 0, 4, 0, 0).getTime());
	});

	it("uses AND when one day field is unrestricted", () => {
		expect(next("0 0 1 * *", new Date(2026, 0, 2, 12, 0, 0))).toBe(new Date(2026, 0, 1 + 31, 0, 0).getTime());
		// 2026-01-05 is a Monday.
		expect(next("0 0 * * 1", new Date(2026, 0, 2, 12, 0, 0))).toBe(new Date(2026, 0, 5, 0, 0).getTime());
	});

	it("throws for expressions with no future occurrence", () => {
		expect(() => next("0 0 30 2 *", new Date(2026, 0, 1, 0, 0, 0))).toThrow(/no occurrence/);
	});
});

// ============================================================================
// Scheduler (injected clock, no timers)
// ============================================================================

interface Harness {
	scheduler: MuseCronScheduler;
	fired: CronJob[];
	lastTimer(): (() => void) | undefined;
	now(): number;
	setNow(ms: number): void;
	advance(ms: number): void;
}

function createHarness(startMs: number): Harness {
	let current = startMs;
	const fired: CronJob[] = [];
	let lastTimer: (() => void) | undefined;
	const scheduler = new MuseCronScheduler({
		now: () => current,
		onDue: (job) => fired.push(job),
		onRemoved: () => {},
		setTimer: (callback) => {
			lastTimer = callback;
			return callback;
		},
		clearTimer: () => {},
	});
	return {
		scheduler,
		fired,
		lastTimer: () => lastTimer,
		now: () => current,
		setNow: (ms) => {
			current = ms;
		},
		advance: (ms) => {
			current += ms;
		},
	};
}

describe("MuseCronScheduler", () => {
	it("creates, lists, and deletes jobs", () => {
		const h = createHarness(START);
		const a = h.scheduler.create({ cron: "*/5 * * * *", prompt: "a", recurring: true, fireWhenActiveRun: true });
		const b = h.scheduler.create({ cron: "0 9 * * *", prompt: "b", recurring: false, fireWhenActiveRun: true });

		expect(a.nextFireAt).toBe(new Date(2026, 0, 5, 12, 35).getTime());
		expect(a.expiresAt).toBe(START + MUSE_CRON_RECURRING_TTL_MS);
		expect(b.expiresAt).toBeNull();
		expect(h.scheduler.list().map((job) => job.id)).toEqual([a.id, b.id]);
		expect(h.scheduler.get(a.id)?.prompt).toBe("a");

		expect(h.scheduler.remove("missing")).toBe(false);
		expect(h.scheduler.remove(a.id)).toBe(true);
		expect(h.scheduler.list().map((job) => job.id)).toEqual([b.id]);
	});

	it("fires due jobs and advances recurring ones to the next slot", () => {
		const h = createHarness(START);
		const job = h.scheduler.create({ cron: "* * * * *", prompt: "p", recurring: true, fireWhenActiveRun: true });

		h.advance(MINUTE);
		const fired = h.scheduler.tick();

		expect(fired).toHaveLength(1);
		expect(fired[0].id).toBe(job.id);
		expect(fired[0].nextFireAt).toBe(new Date(2026, 0, 5, 12, 31).getTime());
		expect(h.scheduler.get(job.id)?.nextFireAt).toBe(new Date(2026, 0, 5, 12, 32).getTime());
	});

	it("coalesces missed recurring slots into a single fire", () => {
		const h = createHarness(START);
		h.scheduler.create({ cron: "* * * * *", prompt: "p", recurring: true, fireWhenActiveRun: true });

		h.advance(10 * MINUTE);
		const fired = h.scheduler.tick();

		expect(fired).toHaveLength(1);
		expect(h.scheduler.list()[0].nextFireAt).toBe(h.now() + MINUTE);
	});

	it("deletes one-shot jobs after they fire", () => {
		const h = createHarness(START);
		const job = h.scheduler.create({ cron: "* * * * *", prompt: "p", recurring: false, fireWhenActiveRun: true });

		h.advance(MINUTE);
		h.scheduler.tick();

		expect(h.scheduler.get(job.id)).toBeUndefined();
		expect(h.scheduler.list()).toHaveLength(0);
	});

	it("fires recurring jobs until the 7-day expiry, then drops them", () => {
		const h = createHarness(START);
		const job = h.scheduler.create({ cron: "* * * * *", prompt: "p", recurring: true, fireWhenActiveRun: true });

		// One minute before expiry the job fires and then expires (its next slot is the expiry instant).
		h.setNow(job.expiresAt! - MINUTE);
		h.scheduler.tick();
		expect(h.fired).toHaveLength(1);
		expect(h.scheduler.get(job.id)).toBeUndefined();
	});

	it("expires an overdue recurring job without firing it", () => {
		const h = createHarness(START);
		const job = h.scheduler.create({ cron: "* * * * *", prompt: "p", recurring: true, fireWhenActiveRun: true });

		h.setNow(job.expiresAt!);
		h.scheduler.tick();

		expect(h.fired).toHaveLength(0);
		expect(h.scheduler.get(job.id)).toBeUndefined();
	});

	it("rejects recurring crons with no occurrence inside the 7-day lifetime", () => {
		const h = createHarness(new Date(2026, 1, 1, 0, 0, 0, 0).getTime()); // 2026-02-01
		expect(() =>
			h.scheduler.create({ cron: "0 0 29 2 *", prompt: "leap", recurring: true, fireWhenActiveRun: true }),
		).toThrow(/no occurrence within the 7-day/);
	});

	it("restore skips missed recurring slots and fires missed one-shots once", () => {
		const h = createHarness(START);
		const recurring = {
			id: "r1",
			cron: "* * * * *",
			prompt: "r",
			recurring: true,
			fireWhenActiveRun: true,
			createdAt: START,
			nextFireAt: START + MINUTE,
		};
		const once = {
			id: "o1",
			cron: "* * * * *",
			prompt: "o",
			recurring: false,
			fireWhenActiveRun: true,
			createdAt: START,
			nextFireAt: START + MINUTE,
		};
		h.setNow(START + 30 * MINUTE);
		h.scheduler.restore([
			{ kind: "create", job: recurring },
			{ kind: "create", job: once },
		]);

		// Recurring: re-armed in the future, no catch-up.
		expect(h.scheduler.get("r1")?.nextFireAt).toBe(h.now() + MINUTE);
		expect(h.scheduler.get("o1")?.nextFireAt).toBe(h.now());

		const fired = h.scheduler.tick();
		expect(fired.map((job) => job.id)).toEqual(["o1"]);
		expect(h.scheduler.get("o1")).toBeUndefined();
	});

	it("restore drops expired recurring jobs and applies delete events in order", () => {
		const h = createHarness(START);
		const base = {
			cron: "* * * * *",
			prompt: "p",
			recurring: true,
			fireWhenActiveRun: true,
			nextFireAt: START + MINUTE,
		};
		h.scheduler.restore([
			{ kind: "create", job: { ...base, id: "expired", createdAt: START - MUSE_CRON_RECURRING_TTL_MS } },
			{ kind: "create", job: { ...base, id: "kept", createdAt: START } },
			{ kind: "delete", id: "kept" },
		]);
		expect(h.scheduler.list()).toHaveLength(0);
	});
});

// ============================================================================
// Tool + extension integration
// ============================================================================

interface CronToolResult {
	content: Array<{ type: string; text: string }>;
	details: Record<string, unknown>;
}

interface ToolCall {
	name: string;
	execute: (...args: unknown[]) => Promise<CronToolResult>;
}

interface FakePi {
	api: ExtensionAPI;
	tools: Map<string, ToolCall>;
	sent: Array<{ message: Record<string, unknown>; options: Record<string, unknown> }>;
	lifecycle: Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>;
}

function createFakePi(sessionManager: SessionManager): FakePi {
	const lifecycle = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>();
	const tools = new Map<string, ToolCall>();
	const sent: FakePi["sent"] = [];
	const api = {
		on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
			const list = lifecycle.get(event) ?? [];
			list.push(handler);
			lifecycle.set(event, list);
		},
		registerTool: (tool: ToolCall) => {
			tools.set(tool.name, tool);
		},
		appendEntry: (customType: string, data?: unknown) => {
			sessionManager.appendCustomEntry(customType, data);
		},
		sendMessage: (message: Record<string, unknown>, options: Record<string, unknown>) => {
			sent.push({ message, options });
		},
	} as unknown as ExtensionAPI;
	return { api, tools, sent, lifecycle };
}

function createFakeContext(sessionManager: SessionManager, isIdle: () => boolean): ExtensionContext {
	return { sessionManager, cwd: "/workspace", isIdle } as unknown as ExtensionContext;
}

async function emitLifecycle(
	fake: FakePi,
	event: "session_start" | "session_shutdown",
	ctx: ExtensionContext,
): Promise<void> {
	for (const handler of fake.lifecycle.get(event) ?? []) await handler({ type: event }, ctx);
}

interface ExtensionHarness {
	fake: FakePi;
	ctx: ExtensionContext;
	now: () => number;
	setNow: (ms: number) => void;
	advance: (ms: number) => void;
	lastTimer: () => (() => void) | undefined;
	setIdle: (value: boolean) => void;
	tool(name: string): ToolCall;
}

async function createExtensionHarness(
	sessionManager: SessionManager = SessionManager.inMemory("/workspace"),
): Promise<ExtensionHarness> {
	let current = START;
	let idle = true;
	let lastTimer: (() => void) | undefined;
	const fake = createFakePi(sessionManager);
	museCronExtension(fake.api, {
		now: () => current,
		setTimer: (callback) => {
			lastTimer = callback;
			return callback;
		},
		clearTimer: () => {},
	});
	const ctx = createFakeContext(sessionManager, () => idle);
	await emitLifecycle(fake, "session_start", ctx);
	return {
		fake,
		ctx,
		now: () => current,
		setNow: (ms) => {
			current = ms;
		},
		advance: (ms) => {
			current += ms;
		},
		lastTimer: () => lastTimer,
		setIdle: (value) => {
			idle = value;
		},
		tool: (name) => {
			const tool = fake.tools.get(name);
			if (!tool) throw new Error(`tool ${name} was not registered`);
			return tool;
		},
	};
}

describe("muse cron tools", () => {
	it("registers exactly the three Muse cron tool names", async () => {
		const h = await createExtensionHarness();
		expect([...h.fake.tools.keys()].sort()).toEqual([...MUSE_CRON_TOOL_NAMES].sort());
	});

	it("creates, lists, and deletes jobs in a round trip", async () => {
		const h = await createExtensionHarness();
		const created = await h.tool("cron_create").execute("t", {
			cron: "*/5 * * * *",
			prompt: "check the build",
		});
		const id = created.details.id as string;
		expect(created.content[0].text).toContain(`Scheduled job ${id}`);
		expect(created.details.recurring).toBe(true);

		const listed = await h.tool("cron_list").execute("t", {});
		expect(listed.content[0].text).toContain(id);
		expect(listed.content[0].text).toContain("*/5 * * * *");
		expect(listed.content[0].text).toContain("next:");
		expect(listed.content[0].text).toContain("recurring");

		const deleted = await h.tool("cron_delete").execute("t", { id });
		expect(deleted.details.deleted).toBe(true);

		const empty = await h.tool("cron_list").execute("t", {});
		expect(empty.content[0].text).toBe("No scheduled jobs for this session.");
	});

	it("reports an unknown id honestly", async () => {
		const h = await createExtensionHarness();
		const result = await h.tool("cron_delete").execute("t", { id: "does-not-exist" });
		expect(result.content[0].text).toBe("No scheduled job with id does-not-exist.");
		expect(result.details.deleted).toBe(false);
	});

	it("fire_immediately returns a same-turn instruction and still schedules the next slot", async () => {
		const h = await createExtensionHarness();
		const result = await h.tool("cron_create").execute("t", {
			cron: "0 9 * * *",
			prompt: "post the standup",
			fire_immediately: true,
		});
		expect(result.content[0].text).toContain("Run this prompt now in this same turn: post the standup");
		expect(result.details.next_fire_at).toBe(new Date(2026, 0, 6, 9, 0).getTime());
		expect(h.fake.sent).toHaveLength(0);
	});

	it("rejects fire_immediately without recurring", async () => {
		const h = await createExtensionHarness();
		const result = await h.tool("cron_create").execute("t", {
			cron: "* * * * *",
			prompt: "x",
			fire_immediately: true,
			recurring: false,
		});
		expect(result.content[0].text).toContain("fire_immediately=true requires recurring=true");
	});

	it("reports invalid cron expressions instead of throwing", async () => {
		const h = await createExtensionHarness();
		const result = await h.tool("cron_create").execute("t", { cron: "not a cron", prompt: "x" });
		expect(result.content[0].text).toContain("cron_create failed");
	});

	it("injects the prompt as a turn-triggering followUp when a job fires", async () => {
		const h = await createExtensionHarness();
		await h.tool("cron_create").execute("t", { cron: "* * * * *", prompt: "do the thing" });

		const timer = h.lastTimer();
		expect(timer).toBeTypeOf("function");
		h.advance(MINUTE);
		timer?.();

		expect(h.fake.sent).toHaveLength(1);
		expect(h.fake.sent[0].message).toMatchObject({
			customType: MUSE_CRON_FIRE_CUSTOM_TYPE,
			content: "do the thing",
			display: false,
		});
		expect(h.fake.sent[0].options).toEqual({ deliverAs: "followUp", triggerTurn: true });
	});

	it("skips fires during an active run when fire_when_active_run is false", async () => {
		const h = await createExtensionHarness();
		h.setIdle(false);
		await h.tool("cron_create").execute("t", {
			cron: "* * * * *",
			prompt: "skip me",
			fire_when_active_run: false,
		});

		const timer = h.lastTimer();
		h.advance(MINUTE);
		timer?.();

		expect(h.fake.sent).toHaveLength(0);
		const listed = await h.tool("cron_list").execute("t", {});
		expect(listed.details.count).toBe(1);
	});

	it("fires during an active run when fire_when_active_run is true", async () => {
		const h = await createExtensionHarness();
		h.setIdle(false);
		await h.tool("cron_create").execute("t", { cron: "* * * * *", prompt: "fire anyway" });

		const timer = h.lastTimer();
		h.advance(MINUTE);
		timer?.();

		expect(h.fake.sent).toHaveLength(1);
	});

	it("clears the timer on session shutdown", async () => {
		const h = await createExtensionHarness();
		await h.tool("cron_create").execute("t", { cron: "* * * * *", prompt: "p" });
		await emitLifecycle(h.fake, "session_shutdown", h.ctx);
		// Dispose drops the in-memory jobs; a resumed session rebuilds them from entries.
		expect(h.fake.sent).toHaveLength(0);
	});
});

// ============================================================================
// Persistence through the session manager custom-entry path
// ============================================================================

describe("cron persistence", () => {
	it("writes create/delete events as pi.muse_cron custom entries", async () => {
		const sessionManager = SessionManager.inMemory("/workspace");
		const h = await createExtensionHarness(sessionManager);
		const created = await h.tool("cron_create").execute("t", { cron: "*/5 * * * *", prompt: "persist me" });
		const id = created.details.id as string;
		await h.tool("cron_delete").execute("t", { id });

		const entries = sessionManager.getEntries().filter((entry) => entry.type === "custom");
		expect(entries).toHaveLength(2);
		expect(entries.every((entry) => entry.customType === MUSE_CRON_CUSTOM_TYPE)).toBe(true);
	});

	it("restores a resumed session's jobs from replayed custom entries", async () => {
		const sessionManager = SessionManager.inMemory("/workspace");
		const h = await createExtensionHarness(sessionManager);
		await h.tool("cron_create").execute("t", { cron: "*/5 * * * *", prompt: "resume me" });

		const entries = sessionManager.getEntries();
		const resumed = SessionManager.inMemory("/workspace", undefined, entries);
		const events = readPersistedCronEvents(resumed.getBranch());
		expect(events).toHaveLength(1);

		const scheduler = new MuseCronScheduler({
			now: () => START,
			onDue: () => {},
			onRemoved: () => {},
			setTimer: () => undefined,
			clearTimer: () => {},
		});
		scheduler.restore(events);

		const jobs = scheduler.list();
		expect(jobs).toHaveLength(1);
		expect(jobs[0].prompt).toBe("resume me");
		expect(jobs[0].nextFireAt).toBeGreaterThan(START);
	});

	it("does not resurrect a job deleted before resume", async () => {
		const sessionManager = SessionManager.inMemory("/workspace");
		const h = await createExtensionHarness(sessionManager);
		const created = await h.tool("cron_create").execute("t", { cron: "*/5 * * * *", prompt: "temp" });
		await h.tool("cron_delete").execute("t", { id: created.details.id as string });

		const resumed = SessionManager.inMemory("/workspace", undefined, sessionManager.getEntries());
		const events = readPersistedCronEvents(resumed.getBranch());
		const scheduler = new MuseCronScheduler({
			now: () => START,
			onDue: () => {},
			onRemoved: () => {},
			setTimer: () => undefined,
			clearTimer: () => {},
		});
		scheduler.restore(events);
		expect(scheduler.list()).toHaveLength(0);
	});

	it("ignores custom entries from other extensions and malformed data", () => {
		const sessionManager = SessionManager.inMemory("/workspace");
		sessionManager.appendCustomEntry("pi.tool_intent", { toolName: "read" });
		sessionManager.appendCustomEntry(MUSE_CRON_CUSTOM_TYPE, { kind: "create", job: { nope: true } });
		sessionManager.appendCustomEntry(MUSE_CRON_CUSTOM_TYPE, { kind: "delete", id: 42 });
		expect(readPersistedCronEvents(sessionManager.getBranch())).toEqual([]);
	});

	it("persists a one-shot removal when it fires so a resume does not replay it", async () => {
		const sessionManager = SessionManager.inMemory("/workspace");
		const h = await createExtensionHarness(sessionManager);
		await h.tool("cron_create").execute("t", { cron: "* * * * *", prompt: "once", recurring: false });

		const timer = h.lastTimer();
		h.advance(MINUTE);
		timer?.();

		expect(h.fake.sent).toHaveLength(1);
		const resumed = SessionManager.inMemory("/workspace", undefined, sessionManager.getEntries());
		const events = readPersistedCronEvents(resumed.getBranch());
		const scheduler = new MuseCronScheduler({
			now: () => START,
			onDue: () => {},
			onRemoved: () => {},
			setTimer: () => undefined,
			clearTimer: () => {},
		});
		scheduler.restore(events);
		expect(scheduler.list()).toHaveLength(0);
	});

	it("persists a recurring expiry removal", async () => {
		const sessionManager = SessionManager.inMemory("/workspace");
		const h = await createExtensionHarness(sessionManager);
		const created = await h.tool("cron_create").execute("t", { cron: "* * * * *", prompt: "recur" });
		expect(created.details.expires_at).toBe(START + MUSE_CRON_RECURRING_TTL_MS);

		h.setNow((created.details.expires_at as number) + MINUTE);
		h.lastTimer()?.();

		expect(h.fake.sent).toHaveLength(0);
		const resumed = SessionManager.inMemory("/workspace", undefined, sessionManager.getEntries());
		const scheduler = new MuseCronScheduler({
			now: () => START,
			onDue: () => {},
			onRemoved: () => {},
			setTimer: () => undefined,
			clearTimer: () => {},
		});
		scheduler.restore(readPersistedCronEvents(resumed.getBranch()));
		expect(scheduler.list()).toHaveLength(0);
	});
});
