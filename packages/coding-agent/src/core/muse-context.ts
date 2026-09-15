import { MUSE_BUNDLED_SKILLS } from "./muse-skills/index.ts";
import type { Skill } from "./skills.ts";

function escapeXml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

const SUBAGENT_DELEGATION = `Delegation posture for the native subagent tools: spawning children is optional. By default, prefer working inline — a lookup that a single \`search\` or \`read_file\` call can answer stays inline, and work one normal turn can handle stays one turn. When you do delegate, size the fan-out to the number of genuinely independent subtasks: batch related small queries into one child rather than one child per query, keyword, or directory. Queued spawns start automatically as slots free; never re-issue or duplicate a queued spawn. After spawning, wait for or read the child result instead of repeating the same work yourself. A wait that returns timeout or would_park means the child keeps running; do not poll — finished results are delivered to you automatically when your session is idle, so keep working or end your turn. User opt-outs ("don't use subagents", "single agent") always win.`;

const WORKFLOW_CHOICE = `Use the \`Workflow\` tool as the first execution tool only for clearly workflow-scale work: large reviews, migrations, research, multi-step plans, or work that should be split across focused agents. If the task would benefit from Workflow but is not clearly workflow-scale, do not call \`Workflow\` and do not silently skip it; explain that Workflow could help, estimate the likely extra agent/token/time cost, and ask the user before starting one. Explicit requests to use a workflow or write/run a workflow script should call \`Workflow\` first even when the workspace is tiny or small, unless the user explicitly opts out; migrations or focused-worker requests should call \`Workflow\` before repo discovery, with unknown repo or module shape discovered by workflow child agents. An earlier workflow request in this conversation does not set the scale of later asks: judge each new ask on its own size, and for a small follow-up prefer a small workflow or one normal turn (ask if unsure). If another skill also matches a clearly workflow-scale prompt, it does not replace \`Workflow\` for split-agent work; the adjacent cookbook separately controls whether \`workflow-authoring\` is read once before scripting. If the prompt says "if appropriate", asks for a quick look or brief review, names a small two-file scope, or otherwise may be handled by one normal turn, assess scope with normal read/search/bash tools first and skip \`Workflow\` when one normal turn can handle it. The phrase "if appropriate" is not permission to use Workflow. For small two-file reviews, start with normal read/search/bash tools; do not call Workflow first unless the user explicitly says to use a workflow. For a new run, put a small inline \`script\` and use the host API, for example: \`export default async function workflow(host) { const result = await host.agent({ input: "review correctness and highest-risk issues" }); return { status: "ok", ref: result.ref, text: result.text }; }\`; the runtime pins host API v1, persists that source, and returns an editable \`scriptPath\`. When durable recovery context names an interrupted run, inspect or edit that returned file and call \`Workflow\` with \`scriptPath\` plus the same-session \`resumeFromRunId\`; never invent a run id or resume a still-live owner task. For multiple child results, use a synthesis host.agent child and return one JSON object with \`synthesis.ref\` and \`synthesis.text\`; do not paste, join, or map several child results into one terminal return. Do not use \`Workflow\` for quick look or brief review prompts, routine questions, small edits, small two-file reviews one normal turn can handle, or other tasks one normal turn can handle. Do not call read_memory, add_memory, edit_memory, or get_goal before Workflow for clearly workflow-scale prompts; workflow child agents should do needed memory, goal, file, git diff, and repo discovery; for a review of an already-identified change, the parent takes stock of its files and size first and sizes the workflow to that list. Do not search the workspace or external sources for workflow docs, host API examples, or repo structure before calling Workflow for clearly workflow-scale requests; use only the optional \`workflow-authoring\` read and current Workflow ToolSpec for the API shape. The workflow tool executes immediately when called; there is no separate confirmation step.`;

const WORKFLOW_COOKBOOK = `Use only the active Workflow API V1 ToolSpec for syntax and lifecycle. A fixed batch count never proves completion. Discovery pointers are not inspected evidence when the relevant body is readable. Require each research child to open every implementation or test body it cites before \`submit_result\` when readable; search and grep output only locate candidates. Back every assigned claim with inspected evidence or name it as unresolved. Disclose omitted scope when caller, capacity, sampling, top-N, no-retry, or runtime-budget boundaries stop the work. Preserve compact evidence, provenance refs, and every unresolved item in synthesis. If \`workflow-authoring\` is available, call \`read_skill\` exactly once per parent session before the first non-trivial Workflow; after it succeeds, reuse that result and do not reload the skill after validation errors or for later Workflow calls, retries, or resumes. Otherwise continue from this kernel and the active Workflow ToolSpec.`;

const SKILLS_HEADER =
	"Muse Code loaded available skills at session open. These are summaries only. To load one skill's full instructions, call the read_skill tool with the skill's id or path from this catalog — do not read the path with read_file. A plugin:// or bundled:// path is a display locator, not a file read_file can open.";

export interface MuseDeveloperContextOptions {
	cwd: string;
	trusted: boolean;
	skills: Skill[];
	subagentsAvailable: boolean;
	/** Whether the Muse `Workflow` tool is available; gates the workflow reminders. */
	workflowAvailable: boolean;
}

/**
 * Builds the per-session context Muse Code injects in its `developer` message:
 * workspace identity, permission mode, workflow reminders, subagent delegation
 * posture, and the skill catalog. pi has no developer-message role, so this block
 * is appended to the system prompt instead.
 */
export function buildMuseDeveloperContext(options: MuseDeveloperContextOptions): string {
	const { cwd, trusted, skills, subagentsAvailable, workflowAvailable } = options;
	const sections: string[] = [];

	sections.push(
		[
			`<system-reminder source="workspace-identity">`,
			`Workspace root: ${cwd}`,
			`Workspace-relative tool paths resolve against this root.`,
			`</system-reminder>`,
			``,
			`Session permission mode (as of session start):`,
			`- Approval: bypassed at launch (--disable-approval / --yolo) — tool calls will not ask the user for approval in this session.`,
			`- Shell sandbox: off — shell commands run unsandboxed.`,
			`- Workspace trust: ${
				trusted
					? "trusted — project-local instructions, skills, and hooks are eligible to load."
					: "untrusted — project-local instructions, skills, and hooks are not loaded."
			}`,
			`The bypass flags --disable-approval, --disable-sandbox, and --yolo (both bypasses plus workspace trust) are fixed at launch; a restart changes them.`,
		].join("\n"),
	);

	if (workflowAvailable) {
		sections.push(`<system-reminder source="workflow-choice">\n${WORKFLOW_CHOICE}\n</system-reminder>`);
		sections.push(`<system-reminder source="workflow-cookbook">\n${WORKFLOW_COOKBOOK}\n</system-reminder>`);
	}

	if (subagentsAvailable) {
		sections.push(`<system-reminder source="subagent-delegation">\n${SUBAGENT_DELEGATION}\n</system-reminder>`);
	}

	const catalog = MUSE_BUNDLED_SKILLS.map((skill) => {
		const lines = [
			`<skill id="${skill.id}" scope="${skill.scope}" path="${skill.locator}">`,
			`<description>${skill.description}</description>`,
		];
		if (skill.shortDescription) {
			lines.push(`<short-description>${skill.shortDescription}</short-description>`);
		}
		lines.push(`</skill>`);
		return lines.join("\n");
	});

	const visiblePiSkills = skills.filter((skill) => !skill.disableModelInvocation);
	for (const skill of visiblePiSkills) {
		const scope = skill.sourceInfo?.scope ?? "project";
		catalog.push(
			[
				`<skill id="${escapeXml(skill.name)}" scope="${escapeXml(String(scope))}" path="${escapeXml(skill.filePath)}">`,
				`<description>${escapeXml(skill.description)}</description>`,
				`</skill>`,
			].join("\n"),
		);
	}

	sections.push(
		[
			`<system-reminder source="skills">`,
			SKILLS_HEADER,
			``,
			`<skill-catalog>`,
			...catalog,
			`</skill-catalog>`,
			`</system-reminder>`,
		].join("\n"),
	);

	return sections.join("\n\n");
}
