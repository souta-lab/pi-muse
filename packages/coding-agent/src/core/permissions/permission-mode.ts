/**
 * Muse Code launch-time permission modes.
 *
 * A mode is resolved once, at launch, from the CLI flags plus the resolved
 * project trust decision. It is a frozen snapshot: nothing here reads mutable
 * settings after construction, so a mid-session settings change (or a `/trust`
 * toggle) cannot silently flip approvals off.
 *
 * Tool classification splits the Muse tool surface into tools that can change
 * the workspace or run shell commands (approval required) and read-only tools
 * that never need approval.
 */

export type PermissionApproval = "prompt" | "bypass";
export type PermissionSandbox = "on" | "off";

/**
 * Immutable launch-time permission mode.
 *
 * - `approval`: `"prompt"` asks before mutating/shell tools run; `"bypass"` never asks.
 * - `sandbox`: `"on"` keeps shell commands in the workspace sandbox; `"off"` runs them unsandboxed.
 * - `workspaceTrust`: whether project-local instructions, skills, and hooks load.
 * - `yolo`: `--yolo` shorthand, which implies all of the above being bypassed/trusted.
 */
export interface PermissionMode {
	readonly approval: PermissionApproval;
	readonly sandbox: PermissionSandbox;
	readonly workspaceTrust: boolean;
	readonly yolo: boolean;
}

/** Raw launch flags that resolve into a `PermissionMode`. */
export interface PermissionModeFlags {
	/** `--disable-approval`: never prompt for approval in this session. */
	readonly disableApproval?: boolean;
	/** `--disable-sandbox`: run shell commands unsandboxed. */
	readonly disableSandbox?: boolean;
	/** `--yolo`: approval bypass + sandbox off + workspace trust. */
	readonly yolo?: boolean;
	/** Resolved project trust for this launch (from the trust store / `--approve`). */
	readonly workspaceTrust?: boolean;
}

/**
 * Resolve a frozen `PermissionMode` from launch flags.
 *
 * `--yolo` implies approval bypass, sandbox off, and workspace trust. The
 * returned object is frozen and must be treated as read-only for the session's
 * lifetime; modes are fixed at launch and a restart changes them.
 */
export function resolvePermissionMode(flags: PermissionModeFlags = {}): PermissionMode {
	const yolo = flags.yolo === true;
	const mode: PermissionMode = {
		approval: yolo || flags.disableApproval === true ? "bypass" : "prompt",
		sandbox: yolo || flags.disableSandbox === true ? "off" : "on",
		workspaceTrust: yolo || flags.workspaceTrust === true,
		yolo,
	};
	return Object.freeze(mode);
}

/**
 * Tools that can change the workspace or execute code. They require approval
 * unless the launch mode bypasses approval.
 */
export const APPROVAL_REQUIRED_TOOL_NAMES = [
	"bash",
	"bash_input",
	"write_file",
	"edit_file",
	"subagent_spawn",
	"workflow",
] as const;

/** Read-only tools that never need approval and run even in a headless session. */
export const AUTO_ALLOWED_TOOL_NAMES = [
	"read_file",
	"search",
	"write_todos",
	"read_memory",
	"work_status",
	"read_skill",
	"web_search",
] as const;

/**
 * Tools whose approval is decided when the shell session they act on is
 * spawned, not per call. `bash_input` can only target an internal session id
 * returned by a `bash` call, so the `bash` spawn decision already covers each
 * later write and the `terminate`/interrupt action. Prompting again per write
 * would duplicate that decision without adding a security boundary.
 */
export const SPAWN_COVERED_TOOL_NAMES = ["bash_input"] as const;

export type ApprovalRequiredToolName = (typeof APPROVAL_REQUIRED_TOOL_NAMES)[number];
export type AutoAllowedToolName = (typeof AUTO_ALLOWED_TOOL_NAMES)[number];
export type SpawnCoveredToolName = (typeof SPAWN_COVERED_TOOL_NAMES)[number];

const APPROVAL_REQUIRED_TOOL_SET: ReadonlySet<string> = new Set(APPROVAL_REQUIRED_TOOL_NAMES);
const AUTO_ALLOWED_TOOL_SET: ReadonlySet<string> = new Set(AUTO_ALLOWED_TOOL_NAMES);
const SPAWN_COVERED_TOOL_SET: ReadonlySet<string> = new Set(SPAWN_COVERED_TOOL_NAMES);

/** Whether a tool is on the read-only allowlist. */
export function isAutoAllowedTool(toolName: string): boolean {
	return AUTO_ALLOWED_TOOL_SET.has(toolName);
}

/** Whether a tool's approval is delegated to the shell session spawn decision. */
export function isSpawnCoveredTool(toolName: string): boolean {
	return SPAWN_COVERED_TOOL_SET.has(toolName);
}

/**
 * Whether a tool call needs approval in a prompting session.
 *
 * This fails closed: the named mutating/shell tools and anything not on the
 * read-only allowlist return `true`, so a newly registered tool (including
 * Pi's own `write`/`edit`/`bash`) can never silently skip the gate.
 */
export function requiresApproval(toolName: string): boolean {
	if (APPROVAL_REQUIRED_TOOL_SET.has(toolName)) {
		return true;
	}
	return !AUTO_ALLOWED_TOOL_SET.has(toolName);
}

// ============================================================================
// Muse developer-message permission lines
// ============================================================================

/** First line of the permission block Muse injects into its `developer` message. */
export const MUSE_PERMISSION_SECTION_HEADER = "Session permission mode (as of session start):";

/** Muse's captured approval line for a bypassing launch. */
export const MUSE_PERMISSION_APPROVAL_BYPASS_LINE =
	"- Approval: bypassed at launch (--disable-approval / --yolo) — tool calls will not ask the user for approval in this session.";

/** Non-bypass approval wording. No capture exists; render the honest state. */
export const MUSE_PERMISSION_APPROVAL_PROMPT_LINE =
	"- Approval: prompt — tool calls that modify the workspace or run shell commands ask the user for approval in this session.";

/** Muse's captured sandbox line when the sandbox is disabled. */
export const MUSE_PERMISSION_SANDBOX_OFF_LINE = "- Shell sandbox: off — shell commands run unsandboxed.";

/** Non-bypass sandbox wording. No capture exists; render the honest state. */
export const MUSE_PERMISSION_SANDBOX_ON_LINE = "- Shell sandbox: on — shell commands run inside the workspace sandbox.";

/** Muse's captured workspace-trust line for a trusted workspace. */
export const MUSE_PERMISSION_WORKSPACE_TRUSTED_LINE =
	"- Workspace trust: trusted — project-local instructions, skills, and hooks are eligible to load.";

/** Non-bypass workspace-trust line for an untrusted workspace. */
export const MUSE_PERMISSION_WORKSPACE_UNTRUSTED_LINE =
	"- Workspace trust: untrusted — project-local instructions, skills, and hooks are not loaded.";

/** Muse's captured closing line stating the launch-time mode is fixed. */
export const MUSE_PERMISSION_FIXED_AT_LAUNCH_LINE =
	"The bypass flags --disable-approval, --disable-sandbox, and --yolo (both bypasses plus workspace trust) are fixed at launch; a restart changes them.";
