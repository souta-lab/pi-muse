import { Type } from "typebox";
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "../core/extensions/types.ts";
import type { SessionEntry } from "../core/session-manager.ts";

/**
 * Muse's four session-goal tools, in the relative order captured in
 * `scripts/muse-proxy/fixtures/tool-schemas-live.json`. The orchestrator splices
 * this array into the ordered allowlist; the extension itself registers the
 * tools below.
 */
export const MUSE_GOAL_TOOL_NAMES = ["get_goal", "create_goal", "update_goal", "report_progress"] as const;

export type MuseGoalToolName = (typeof MUSE_GOAL_TOOL_NAMES)[number];

/**
 * Custom-entry type used to persist goal state. Like `pi.tool_intent`, this is a
 * plain `custom` entry: `buildSessionContext()` ignores it, so a resumed session
 * can rebuild its goal without any goal text leaking into LLM context.
 */
export const MUSE_GOAL_CUSTOM_TYPE = "pi.muse_goal";

export type GoalStatus = "active" | "complete" | "blocked";

/** The durable goal snapshot stored in one custom entry. */
export interface MuseGoalSnapshot {
	objective: string;
	status: GoalStatus;
	token_budget: number | null;
	percent_complete: number;
	current_work: string | null;
	next_work: string | null;
	created_at: string;
	updated_at: string;
}

const TERMINAL_GOAL_STATUSES = new Set<GoalStatus>(["complete", "blocked"]);

const getGoalSchema = Type.Unsafe({ type: "object", additionalProperties: false, properties: {} });

const createGoalSchema = Type.Unsafe({
	type: "object",
	additionalProperties: false,
	required: ["objective"],
	properties: {
		objective: { type: "string", description: "The concrete goal to keep working toward." },
		token_budget: { type: "integer", description: "Optional positive token budget for this goal." },
	},
});

const updateGoalSchema = Type.Unsafe({
	type: "object",
	additionalProperties: false,
	required: ["status"],
	properties: {
		status: { type: "string", enum: ["complete", "blocked"], description: "The terminal goal status to set." },
	},
});

const reportProgressSchema = Type.Unsafe({
	type: "object",
	additionalProperties: false,
	required: ["current_work", "next_work", "percent_complete"],
	properties: {
		current_work: { type: "string", description: "What you are doing now." },
		next_work: { type: "string", description: "What you will do next." },
		percent_complete: {
			type: "integer",
			minimum: 0,
			maximum: 100,
			description: "Approximate completion percentage from 0 to 100.",
		},
	},
});

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function isGoalStatus(value: unknown): value is GoalStatus {
	return value === "active" || value === "complete" || value === "blocked";
}

function parseGoal(data: unknown): MuseGoalSnapshot | undefined {
	if (!isRecord(data)) return undefined;
	const objective = readNonEmptyString(data.objective);
	if (objective === undefined || !isGoalStatus(data.status)) return undefined;
	const budget = data.token_budget;
	const percent = data.percent_complete;
	const createdAt = readNonEmptyString(data.created_at) ?? new Date(0).toISOString();
	return {
		objective,
		status: data.status,
		token_budget: typeof budget === "number" && Number.isFinite(budget) ? budget : null,
		percent_complete: typeof percent === "number" && Number.isFinite(percent) ? percent : 0,
		current_work: readNonEmptyString(data.current_work) ?? null,
		next_work: readNonEmptyString(data.next_work) ?? null,
		created_at: createdAt,
		updated_at: readNonEmptyString(data.updated_at) ?? createdAt,
	};
}

/** Last persisted snapshot wins; the session log is append-only. */
function readPersistedGoal(entries: SessionEntry[]): MuseGoalSnapshot | undefined {
	let goal: MuseGoalSnapshot | undefined;
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== MUSE_GOAL_CUSTOM_TYPE) continue;
		const parsed = parseGoal(entry.data);
		if (parsed) goal = parsed;
	}
	return goal;
}

/** Tokens spent since the goal started, so a token budget has something to measure against. */
function sumTokensSince(entries: SessionEntry[], sinceIso: string): number {
	const since = Date.parse(sinceIso);
	return entries.reduce((total, entry) => {
		if (Number.isFinite(since) && Date.parse(entry.timestamp) < since) return total;
		return entry.type === "message" && entry.message.role === "assistant"
			? total + (entry.message.usage?.totalTokens ?? 0)
			: total;
	}, 0);
}

type PublicGoal = MuseGoalSnapshot & { tokens_used: number };

function toPublicGoal(goal: MuseGoalSnapshot, tokensUsed: number): PublicGoal {
	return { ...goal, tokens_used: tokensUsed };
}

export default function museGoalsExtension(pi: ExtensionAPI): void {
	let goal: MuseGoalSnapshot | undefined;
	let readEntries: () => SessionEntry[] = () => [];

	const tokensUsed = (): number => (goal ? sumTokensSince(readEntries(), goal.created_at) : 0);

	const persist = (next: MuseGoalSnapshot): void => {
		goal = next;
		pi.appendEntry(MUSE_GOAL_CUSTOM_TYPE, next);
	};

	const ok = (text: string, details: Record<string, unknown>): AgentToolResult<Record<string, unknown>> => ({
		content: [{ type: "text" as const, text }],
		details,
	});

	const fail = (error: string, text: string): AgentToolResult<Record<string, unknown>> => ok(text, { error });

	pi.on("session_start", (_event, ctx: ExtensionContext) => {
		readEntries = () => ctx.sessionManager.getEntries();
		goal = readPersistedGoal(readEntries());

		pi.registerTool({
			name: "get_goal",
			label: "get_goal",
			description:
				'Read the active session goal and progress. Returns {"goal": null} when no goal is set. Do not call to orient yourself, to check whether a goal exists, or on a greeting — only call when you are already working on an explicit goal and need its current state.',
			parameters: getGoalSchema,
			execute: async () => {
				if (!goal) return ok('{"goal": null}', { goal: null });
				const publicGoal = toPublicGoal(goal, tokensUsed());
				return ok(JSON.stringify({ goal: publicGoal }), { goal: publicGoal });
			},
		});

		pi.registerTool({
			name: "create_goal",
			label: "create_goal",
			description:
				"Start a session goal only when requested. Fails if this session already has an unfinished goal; the failure message names the way out.",
			parameters: createGoalSchema,
			execute: async (_id: string, input: Record<string, unknown>) => {
				const objective = readNonEmptyString(input.objective);
				if (objective === undefined) {
					return fail("invalid_objective", "create_goal failed: objective must be a non-empty string.");
				}
				if (goal?.status === "active") {
					return fail(
						"goal_already_active",
						`create_goal failed: this session already has an unfinished goal ${JSON.stringify(goal.objective)}; ` +
							'finish it with muse.update_goal(status: "complete"), muse.update_goal(status: "blocked"), ' +
							"or muse.report_progress(percent_complete: 100) before starting another.",
					);
				}
				const rawBudget = input.token_budget;
				let tokenBudget: number | null = null;
				if (rawBudget !== undefined && rawBudget !== null) {
					if (typeof rawBudget !== "number" || !Number.isInteger(rawBudget) || rawBudget <= 0) {
						return fail("invalid_token_budget", "create_goal failed: token_budget must be a positive integer.");
					}
					tokenBudget = rawBudget;
				}
				const now = new Date().toISOString();
				const next: MuseGoalSnapshot = {
					objective,
					status: "active",
					token_budget: tokenBudget,
					percent_complete: 0,
					current_work: null,
					next_work: null,
					created_at: now,
					updated_at: now,
				};
				persist(next);
				const budgetNote = tokenBudget === null ? "" : `; token_budget ${tokenBudget}`;
				return ok(`Goal created: ${JSON.stringify(objective)}; status active${budgetNote}`, {
					goal: toPublicGoal(next, 0),
				});
			},
		});

		pi.registerTool({
			name: "update_goal",
			label: "update_goal",
			description: "Mark the active goal complete or blocked. Use complete only when no required work remains.",
			parameters: updateGoalSchema,
			execute: async (_id: string, input: Record<string, unknown>) => {
				const status = input.status;
				if (!isGoalStatus(status) || status === "active") {
					return fail(
						"invalid_status",
						`update_goal failed: invalid status ${JSON.stringify(status)}; expected "complete" or "blocked".`,
					);
				}
				if (!goal) {
					return fail(
						"no_active_goal",
						"update_goal failed: no active goal to update; start one with muse.create_goal.",
					);
				}
				if (TERMINAL_GOAL_STATUSES.has(goal.status)) {
					return fail(
						"goal_not_active",
						`update_goal failed: the goal is already ${goal.status}; start a new goal with muse.create_goal.`,
					);
				}
				const next: MuseGoalSnapshot = { ...goal, status, updated_at: new Date().toISOString() };
				persist(next);
				return ok(`Goal marked ${status}.`, { goal: toPublicGoal(next, tokensUsed()) });
			},
		});

		pi.registerTool({
			name: "report_progress",
			label: "report_progress",
			description:
				'Report active goal progress. percent_complete=100 is equivalent to muse.update_goal(status="complete").',
			parameters: reportProgressSchema,
			execute: async (_id: string, input: Record<string, unknown>) => {
				const currentWork = readNonEmptyString(input.current_work);
				const nextWork = readNonEmptyString(input.next_work);
				const percent = input.percent_complete;
				if (currentWork === undefined || nextWork === undefined || typeof percent !== "number") {
					return fail(
						"invalid_progress",
						"report_progress failed: current_work, next_work, and percent_complete are required.",
					);
				}
				if (!Number.isInteger(percent) || percent < 0 || percent > 100) {
					return fail(
						"invalid_percent",
						"report_progress failed: percent_complete must be an integer from 0 to 100.",
					);
				}
				if (!goal || TERMINAL_GOAL_STATUSES.has(goal.status)) {
					return fail(
						"no_active_goal",
						"report_progress failed: no active goal; start one with muse.create_goal.",
					);
				}
				const complete = percent === 100;
				const next: MuseGoalSnapshot = {
					...goal,
					status: complete ? "complete" : "active",
					percent_complete: percent,
					current_work: currentWork,
					next_work: nextWork,
					updated_at: new Date().toISOString(),
				};
				persist(next);
				const used = tokensUsed();
				const budgetNote = next.token_budget === null ? "" : `; tokens_used ${used}/${next.token_budget}`;
				const text = complete
					? `Progress reported: 100%; goal marked complete${budgetNote}`
					: `Progress reported: ${percent}%; current_work ${JSON.stringify(currentWork)}; next_work ${JSON.stringify(nextWork)}${budgetNote}`;
				return ok(text, { goal: toPublicGoal(next, used) });
			},
		});
	});
}
