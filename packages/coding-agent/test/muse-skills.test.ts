import { describe, expect, it } from "vitest";
import { buildMuseDeveloperContext } from "../src/core/muse-context.ts";
import {
	MUSE_BUNDLED_SKILLS,
	readMuseBundledSkillBody,
	resolveMuseBundledSkill,
} from "../src/core/muse-skills/index.ts";

const CAPTURED_IDS = [
	"bundled:browser-app-delivery",
	"bundled:create-skill",
	"bundled:doctor",
	"bundled:durable-test-collateral",
	"bundled:git",
	"bundled:greenfield-project-scaffolding",
	"bundled:grill",
	"bundled:import",
	"bundled:manage-settings",
	"bundled:migrate",
	"bundled:plan",
	"bundled:python-env",
	"bundled:read-session",
	"bundled:requirements-clarification",
	"bundled:table-fit",
	"bundled:taste",
	"bundled:workflow-authoring",
	"plugin:threejs:threejs",
];

const SECTION_ORDER = [
	'<system-reminder source="workspace-identity">',
	'<system-reminder source="workflow-choice">',
	'<system-reminder source="workflow-cookbook">',
	'<system-reminder source="subagent-delegation">',
	'<system-reminder source="skills">',
];

describe("muse bundled skills", () => {
	it("ships exactly the 18 captured skills in catalog order", () => {
		expect(MUSE_BUNDLED_SKILLS).toHaveLength(18);
		expect(MUSE_BUNDLED_SKILLS.map((skill) => skill.id)).toEqual(CAPTURED_IDS);
	});

	it("extracts a complete, clean SKILL.md body for every skill", () => {
		for (const skill of MUSE_BUNDLED_SKILLS) {
			const body = readMuseBundledSkillBody(skill.id);
			expect(body, `missing body for ${skill.id}`).toBeDefined();
			const text = body ?? "";
			expect(text.length, `empty body for ${skill.id}`).toBeGreaterThan(0);
			expect(text.includes("\uFFFD"), `replacement char in ${skill.id}`).toBe(false);
			expect(text.includes("\u0000"), `NUL byte in ${skill.id}`).toBe(false);
			const nameMatch = /^---\nname:\s*(.+?)\n/.exec(text);
			expect(nameMatch?.[1], `frontmatter name for ${skill.id}`).toBe(skill.skillDir);
			expect(text.endsWith("\n"), `body for ${skill.id} should end with newline`).toBe(true);
			expect(text.length, `body for ${skill.id} should be non-trivial`).toBeGreaterThan(500);
		}
	});

	it("resolves ids, locator paths, and skill directories", () => {
		expect(resolveMuseBundledSkill("bundled:taste")?.skillDir).toBe("taste");
		expect(resolveMuseBundledSkill("plugin:threejs:threejs")?.skillDir).toBe("threejs");
		expect(resolveMuseBundledSkill("bundled://muse-core/skills/git/SKILL.md")?.id).toBe("bundled:git");
		expect(resolveMuseBundledSkill("muse-core/skills/git/SKILL.md")?.id).toBe("bundled:git");
		expect(resolveMuseBundledSkill("git")?.id).toBe("bundled:git");
		expect(resolveMuseBundledSkill("does-not-exist")).toBeUndefined();
	});
});

describe("muse developer context parity", () => {
	it("reaches Muse's captured size and section order with workflowAvailable", () => {
		const context = buildMuseDeveloperContext({
			cwd: "/tmp/opencode/muse-work",
			trusted: true,
			skills: [],
			subagentsAvailable: true,
			workflowAvailable: true,
		});

		expect(context.length).toBeGreaterThanOrEqual(15000);

		let previous = -1;
		for (const marker of SECTION_ORDER) {
			const index = context.indexOf(marker);
			expect(index, `missing section ${marker}`).toBeGreaterThanOrEqual(0);
			expect(index, `${marker} out of order`).toBeGreaterThan(previous);
			previous = index;
		}

		for (const skill of MUSE_BUNDLED_SKILLS) {
			expect(context).toContain(`<skill id="${skill.id}" scope="${skill.scope}" path="${skill.locator}">`);
		}
	});

	it("reproduces the captured permission-mode wording", () => {
		const context = buildMuseDeveloperContext({
			cwd: "/tmp/opencode/muse-work",
			trusted: true,
			skills: [],
			subagentsAvailable: true,
			workflowAvailable: true,
		});

		expect(context).toContain(
			"- Approval: bypassed at launch (--disable-approval / --yolo) — tool calls will not ask the user for approval in this session.",
		);
		expect(context).toContain("- Shell sandbox: off — shell commands run unsandboxed.");
		expect(context).toContain(
			"The bypass flags --disable-approval, --disable-sandbox, and --yolo (both bypasses plus workspace trust) are fixed at launch; a restart changes them.",
		);
	});

	it("omits the workflow reminders when no Workflow tool exists", () => {
		const context = buildMuseDeveloperContext({
			cwd: "/tmp/opencode/muse-work",
			trusted: true,
			skills: [],
			subagentsAvailable: true,
			workflowAvailable: false,
		});

		expect(context).not.toContain('source="workflow-choice"');
		expect(context).not.toContain('source="workflow-cookbook"');
		expect(context).toContain('source="subagent-delegation"');
		expect(context).toContain('source="skills"');
	});
});
