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

export interface MuseDeveloperContextOptions {
	cwd: string;
	trusted: boolean;
	skills: Skill[];
	subagentsAvailable: boolean;
}

/**
 * Builds the per-session context Muse Code injects in its `developer` message:
 * workspace identity, permission mode, subagent delegation posture, and the skill
 * catalog. pi has no developer-message role, so this block is appended to the
 * system prompt instead.
 */
export function buildMuseDeveloperContext(options: MuseDeveloperContextOptions): string {
	const { cwd, trusted, skills, subagentsAvailable } = options;
	const sections: string[] = [];

	sections.push(
		[
			`<system-reminder source="workspace-identity">`,
			`Workspace root: ${cwd}`,
			`Workspace-relative tool paths resolve against this root.`,
			`</system-reminder>`,
			``,
			`Session permission mode (as of session start):`,
			`- Approval: no approval gate — tool calls never ask the user for approval in this session.`,
			`- Shell sandbox: off — shell commands run unsandboxed.`,
			`- Workspace trust: ${
				trusted
					? "trusted — project-local instructions, skills, and hooks are eligible to load."
					: "untrusted — project-local instructions, skills, and hooks are not loaded."
			}`,
		].join("\n"),
	);

	if (subagentsAvailable) {
		sections.push(`<system-reminder source="subagent-delegation">\n${SUBAGENT_DELEGATION}\n</system-reminder>`);
	}

	const visibleSkills = skills.filter((skill) => !skill.disableModelInvocation);
	if (visibleSkills.length > 0) {
		const catalog = visibleSkills.map((skill) => {
			const scope = skill.sourceInfo?.scope ?? "project";
			const description = escapeXml(skill.description);
			return [
				`<skill id="${escapeXml(skill.name)}" scope="${escapeXml(String(scope))}" path="${escapeXml(skill.filePath)}">`,
				`<description>${description}</description>`,
				`</skill>`,
			].join("\n");
		});
		sections.push(
			[
				`<system-reminder source="skills">`,
				`Muse Code loaded available skills at session open. These are summaries only. To load one skill's full instructions, call the read_skill tool with the skill's id or path from this catalog — do not read the path with read_file.`,
				``,
				`<skill-catalog>`,
				...catalog,
				`</skill-catalog>`,
				`</system-reminder>`,
			].join("\n"),
		);
	}

	return sections.join("\n\n");
}
