import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "../src/core/extensions/types.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import museGoalsExtension, { MUSE_GOAL_CUSTOM_TYPE, MUSE_GOAL_TOOL_NAMES } from "../src/extensions/muse-goals.ts";

/** Minimal assistant turn; the session file only flushes once an assistant message exists. */
function assistantMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "working on it" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-test",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

interface ToolResult {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
}

interface ToolLike {
	name: string;
	description: string;
	parameters: unknown;
	execute: (...args: unknown[]) => Promise<ToolResult>;
}

interface GoalDetails {
	objective: string;
	status: string;
	token_budget: number | null;
	tokens_used: number;
	percent_complete: number;
	current_work: string | null;
	next_work: string | null;
}

type LifecycleHandler = (event: unknown, ctx: ExtensionContext) => void | Promise<void>;

function createFake(session: SessionManager = SessionManager.inMemory()) {
	const lifecycle = new Map<string, LifecycleHandler[]>();
	const tools = new Map<string, ToolLike>();
	const ctx = {
		cwd: "/workspace",
		sessionManager: session,
		modelRegistry: { find: () => undefined, getAll: () => [] },
	} as unknown as ExtensionContext;

	const api = {
		on: (event: string, handler: LifecycleHandler) => {
			const list = lifecycle.get(event) ?? [];
			list.push(handler);
			lifecycle.set(event, list);
		},
		registerTool: (tool: ToolLike) => {
			tools.set(tool.name, tool);
		},
		appendEntry: (customType: string, data?: unknown) => {
			session.appendCustomEntry(customType, data);
		},
		events: { on: () => () => {}, emit: () => {} },
	} as unknown as ExtensionAPI;

	const start = async (): Promise<void> => {
		for (const handler of lifecycle.get("session_start") ?? []) await handler(undefined, ctx);
	};

	const run = async (name: string, input: Record<string, unknown>): Promise<ToolResult> => {
		const tool = tools.get(name);
		if (!tool) throw new Error(`tool ${name} is not registered`);
		return tool.execute("call-1", input, undefined, undefined, ctx);
	};

	return { api, tools, session, start, run };
}

function parseGoal(result: ToolResult): GoalDetails {
	const text = result.content[0]?.text ?? "";
	return (JSON.parse(text) as { goal: GoalDetails }).goal;
}

describe("muse goal tools", () => {
	it("exports the four goal tool names in Muse order", () => {
		expect([...MUSE_GOAL_TOOL_NAMES]).toEqual(["get_goal", "create_goal", "update_goal", "report_progress"]);
	});

	it("registers the four tools in order and matches the live Muse schemas", async () => {
		const fixture = JSON.parse(
			readFileSync(join(__dirname, "../../../scripts/muse-proxy/fixtures/tool-schemas-live.json"), "utf8"),
		) as Array<{ name: string; description: string; parameters: unknown; strict: boolean }>;
		const expected = new Map(fixture.map((tool) => [tool.name, tool]));

		const fake = createFake();
		museGoalsExtension(fake.api);
		await fake.start();

		expect([...fake.tools.keys()]).toEqual([...MUSE_GOAL_TOOL_NAMES]);
		for (const name of MUSE_GOAL_TOOL_NAMES) {
			const official = expected.get(name);
			expect(official).toBeDefined();
			expect(fake.tools.get(name)?.description).toBe(official?.description);
			expect(fake.tools.get(name)?.parameters).toEqual(official?.parameters);
		}
	});

	it("creates a goal and reads it back through get_goal", async () => {
		const fake = createFake();
		museGoalsExtension(fake.api);
		await fake.start();

		const created = await fake.run("create_goal", { objective: "Ship the goal tools", token_budget: 1000 });
		expect(created.details.goal).toMatchObject({
			objective: "Ship the goal tools",
			status: "active",
			token_budget: 1000,
			percent_complete: 0,
		});
		expect(created.content[0]?.text).toContain("Ship the goal tools");

		const got = await fake.run("get_goal", {});
		expect(parseGoal(got)).toMatchObject({ objective: "Ship the goal tools", status: "active" });
	});

	it("returns the null goal shape when no goal is set", async () => {
		const fake = createFake();
		museGoalsExtension(fake.api);
		await fake.start();

		const got = await fake.run("get_goal", {});
		expect(got.content[0]?.text).toBe('{"goal": null}');
		expect(got.details.goal).toBeNull();
	});

	it("rejects a second unfinished goal and names the way out", async () => {
		const fake = createFake();
		museGoalsExtension(fake.api);
		await fake.start();

		await fake.run("create_goal", { objective: "first" });
		const second = await fake.run("create_goal", { objective: "second" });

		expect(second.details.error).toBe("goal_already_active");
		expect(second.content[0]?.text).toContain("muse.update_goal");
		expect(second.content[0]?.text).toContain("muse.report_progress");
		expect(parseGoal(await fake.run("get_goal", {})).objective).toBe("first");
	});

	it("allows a new goal after the previous one is terminal", async () => {
		const fake = createFake();
		museGoalsExtension(fake.api);
		await fake.start();

		await fake.run("create_goal", { objective: "first" });
		await fake.run("update_goal", { status: "complete" });
		const created = await fake.run("create_goal", { objective: "second" });
		expect(created.details.error).toBeUndefined();
		expect(parseGoal(await fake.run("get_goal", {})).objective).toBe("second");
	});

	it("rejects status values outside Muse's enum", async () => {
		const fake = createFake();
		museGoalsExtension(fake.api);
		await fake.start();

		const updateSchema = fake.tools.get("update_goal")?.parameters as {
			properties: { status: { enum: string[] } };
		};
		expect(updateSchema.properties.status.enum).toEqual(["complete", "blocked"]);

		await fake.run("create_goal", { objective: "guarded" });
		for (const status of ["active", "paused", "", undefined]) {
			const rejected = await fake.run("update_goal", { status });
			expect(rejected.details.error).toBe("invalid_status");
			expect(rejected.content[0]?.text).toContain("failed");
		}
		expect(parseGoal(await fake.run("get_goal", {})).status).toBe("active");
	});

	it("completes the goal when report_progress reaches 100", async () => {
		const fake = createFake();
		museGoalsExtension(fake.api);
		await fake.start();

		await fake.run("create_goal", { objective: "finish", token_budget: 500 });
		const reported = await fake.run("report_progress", {
			current_work: "wrapping up",
			next_work: "nothing",
			percent_complete: 100,
		});

		expect(reported.details.goal).toMatchObject({ status: "complete", percent_complete: 100 });
		expect(reported.content[0]?.text).toContain("goal marked complete");
		expect(parseGoal(await fake.run("get_goal", {})).status).toBe("complete");

		const late = await fake.run("update_goal", { status: "blocked" });
		expect(late.details.error).toBe("goal_not_active");
	});

	it("records progress and reports token usage against the budget", async () => {
		const fake = createFake();
		museGoalsExtension(fake.api);
		await fake.start();

		await fake.run("create_goal", { objective: "measure", token_budget: 1000 });
		const reported = await fake.run("report_progress", {
			current_work: "halfway",
			next_work: "rest",
			percent_complete: 50,
		});

		expect(reported.details.goal).toMatchObject({
			status: "active",
			percent_complete: 50,
			current_work: "halfway",
			next_work: "rest",
			token_budget: 1000,
			tokens_used: 0,
		});
		expect(reported.content[0]?.text).toContain("tokens_used 0/1000");
	});

	it("survives a session save and restore through the custom-entry path", async () => {
		const dir = join(tmpdir(), `pi-muse-goals-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(dir, { recursive: true });
		try {
			const session = SessionManager.create(dir, dir);
			const original = createFake(session);
			museGoalsExtension(original.api);
			await original.start();
			await original.run("create_goal", { objective: "durable goal", token_budget: 750 });
			session.appendMessage(assistantMessage());
			await original.run("report_progress", {
				current_work: "persisting",
				next_work: "reloading",
				percent_complete: 40,
			});

			// The goal lives in a plain custom entry, so it never reaches LLM context.
			expect(
				session.getEntries().some((entry) => entry.type === "custom" && entry.customType === MUSE_GOAL_CUSTOM_TYPE),
			).toBe(true);
			const context = session.buildSessionContext();
			expect(context.messages.map((message) => message.role)).toEqual(["assistant"]);
			expect(JSON.stringify(context.messages)).not.toContain("durable goal");

			const file = session.getSessionFile();
			expect(file).toBeDefined();
			const reopened = SessionManager.open(file as string);

			const resumed = createFake(reopened);
			museGoalsExtension(resumed.api);
			await resumed.start();

			expect(parseGoal(await resumed.run("get_goal", {}))).toMatchObject({
				objective: "durable goal",
				status: "active",
				percent_complete: 40,
				current_work: "persisting",
				next_work: "reloading",
				token_budget: 750,
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
