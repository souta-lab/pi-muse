import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { parseArgs } from "../src/cli/args.ts";
import { buildMuseDeveloperContext } from "../src/core/muse-context.ts";
import { createApprovalGate } from "../src/core/permissions/approval-gate.ts";
import {
	APPROVAL_REQUIRED_TOOL_NAMES,
	AUTO_ALLOWED_TOOL_NAMES,
	isAutoAllowedTool,
	isSpawnCoveredTool,
	MUSE_PERMISSION_APPROVAL_BYPASS_LINE,
	MUSE_PERMISSION_SANDBOX_OFF_LINE,
	MUSE_PERMISSION_WORKSPACE_TRUSTED_LINE,
	type PermissionMode,
	requiresApproval,
	resolvePermissionMode,
} from "../src/core/permissions/permission-mode.ts";

const DEVELOPER_MESSAGE_FIXTURE = fileURLToPath(new URL("./fixtures/muse/developer-message.md", import.meta.url));

/** Workspace root used by the captured Muse Code session. */
const CAPTURED_CWD = "/tmp/opencode/muse-work";

describe("permission mode resolution", () => {
	it("defaults to prompting with the sandbox on and no trust", () => {
		expect(resolvePermissionMode()).toEqual({
			approval: "prompt",
			sandbox: "on",
			workspaceTrust: false,
			yolo: false,
		});
	});

	it("--disable-approval bypasses approval only", () => {
		expect(resolvePermissionMode({ disableApproval: true })).toEqual({
			approval: "bypass",
			sandbox: "on",
			workspaceTrust: false,
			yolo: false,
		});
	});

	it("--disable-sandbox turns the sandbox off only", () => {
		expect(resolvePermissionMode({ disableSandbox: true })).toEqual({
			approval: "prompt",
			sandbox: "off",
			workspaceTrust: false,
			yolo: false,
		});
	});

	it("--yolo implies approval bypass, sandbox off, and workspace trust", () => {
		expect(resolvePermissionMode({ yolo: true })).toEqual({
			approval: "bypass",
			sandbox: "off",
			workspaceTrust: true,
			yolo: true,
		});
	});

	it("--yolo wins over explicitly false companion flags", () => {
		expect(
			resolvePermissionMode({
				yolo: true,
				disableApproval: false,
				disableSandbox: false,
				workspaceTrust: false,
			}),
		).toEqual({ approval: "bypass", sandbox: "off", workspaceTrust: true, yolo: true });
	});

	it("carries the resolved workspace trust for non-yolo launches", () => {
		expect(resolvePermissionMode({ workspaceTrust: true }).workspaceTrust).toBe(true);
		expect(resolvePermissionMode({ workspaceTrust: false }).workspaceTrust).toBe(false);
	});

	it("freezes the mode so it cannot change after launch", () => {
		expect(Object.isFrozen(resolvePermissionMode())).toBe(true);
		expect(Object.isFrozen(resolvePermissionMode({ yolo: true }))).toBe(true);
	});
});

describe("tool classification", () => {
	it("flags the named mutating and shell tools as approval-required", () => {
		for (const toolName of APPROVAL_REQUIRED_TOOL_NAMES) {
			expect(requiresApproval(toolName), toolName).toBe(true);
		}
	});

	it("treats the read-only allowlist as auto-allowed", () => {
		for (const toolName of AUTO_ALLOWED_TOOL_NAMES) {
			expect(isAutoAllowedTool(toolName), toolName).toBe(true);
			expect(requiresApproval(toolName), toolName).toBe(false);
		}
	});

	it("fails closed for unknown and Pi-native tools", () => {
		for (const toolName of ["write", "edit", "read", "add_memory", "edit_memory", "not_a_tool"]) {
			expect(requiresApproval(toolName), toolName).toBe(true);
		}
	});

	it("marks bash_input as spawn-covered rather than per-write gated", () => {
		expect(isSpawnCoveredTool("bash_input")).toBe(true);
		expect(requiresApproval("bash_input")).toBe(true);
	});
});

describe("approval gate decisions", () => {
	it("allows read-only tools without prompting", async () => {
		const confirm = vi.fn(async () => true);
		const gate = createApprovalGate({ mode: resolvePermissionMode(), confirm });

		for (const toolName of AUTO_ALLOWED_TOOL_NAMES) {
			expect(await gate({ toolName }), toolName).toBeUndefined();
		}
		expect(confirm).not.toHaveBeenCalled();
	});

	it("prompts for mutating tools and allows on user approval", async () => {
		const confirm = vi.fn(async (_question: string) => true);
		const gate = createApprovalGate({ mode: resolvePermissionMode(), confirm });

		expect(await gate({ toolName: "write_file", detail: "write /tmp/x" })).toBeUndefined();
		expect(confirm).toHaveBeenCalledTimes(1);
		expect(confirm.mock.calls[0][0]).toContain("write_file");
		expect(confirm.mock.calls[0][0]).toContain("write /tmp/x");
	});

	it("returns the tool_call hook block shape when the user denies", async () => {
		const gate = createApprovalGate({ mode: resolvePermissionMode(), confirm: async () => false });

		expect(await gate({ toolName: "bash", detail: "rm -rf /" })).toEqual({
			block: true,
			reason: expect.stringContaining("bash"),
		});
	});

	it("fails closed in a headless session unless approval is bypassed", async () => {
		const headless = createApprovalGate({ mode: resolvePermissionMode() });
		expect(await headless({ toolName: "edit_file" })).toEqual({ block: true, reason: expect.any(String) });

		const yolo = createApprovalGate({ mode: resolvePermissionMode({ yolo: true }) });
		expect(await yolo({ toolName: "edit_file" })).toBeUndefined();

		const bypassOnly = createApprovalGate({ mode: resolvePermissionMode({ disableApproval: true }) });
		expect(await bypassOnly({ toolName: "bash" })).toBeUndefined();
	});

	it("allows read-only tools even without a UI", async () => {
		const headless = createApprovalGate({ mode: resolvePermissionMode() });
		expect(await headless({ toolName: "read_file" })).toBeUndefined();
	});

	it("short-circuits mutating tools when the launch mode bypasses approval", async () => {
		const confirm = vi.fn(async () => false);
		const gate = createApprovalGate({ mode: resolvePermissionMode({ yolo: true }), confirm });

		expect(await gate({ toolName: "workflow" })).toBeUndefined();
		expect(await gate({ toolName: "subagent_spawn" })).toBeUndefined();
		expect(confirm).not.toHaveBeenCalled();
	});

	it("decides bash_input at the bash spawn level, not per write", async () => {
		// Interactive: the covering bash spawn already passed this same gate, so
		// sending stdin or terminating (interrupt) does not prompt again.
		const confirm = vi.fn(async () => true);
		const interactive = createApprovalGate({ mode: resolvePermissionMode(), confirm });
		expect(await interactive({ toolName: "bash_input", detail: "terminate session 1" })).toBeUndefined();
		expect(confirm).not.toHaveBeenCalled();

		// Headless: no approved bash spawn could have produced a session id, so the
		// inherited spawn decision is a deny.
		const headless = createApprovalGate({ mode: resolvePermissionMode() });
		expect(await headless({ toolName: "bash_input" })).toEqual({ block: true, reason: expect.any(String) });
	});

	it("treats a no-op confirm port with hasUI=false as headless", async () => {
		const confirm = vi.fn(async () => false);
		const gate = createApprovalGate({ mode: resolvePermissionMode(), confirm, hasUI: false });

		expect(await gate({ toolName: "bash_input" })).toEqual({ block: true, reason: expect.any(String) });
		expect(await gate({ toolName: "write_file" })).toEqual({ block: true, reason: expect.any(String) });
		expect(confirm).not.toHaveBeenCalled();
	});
});

describe("approval CLI flags", () => {
	it("parses --disable-approval, --disable-sandbox, and --yolo", () => {
		expect(parseArgs(["--disable-approval"]).disableApproval).toBe(true);
		expect(parseArgs(["--disable-sandbox"]).disableSandbox).toBe(true);
		expect(parseArgs(["--yolo"]).yolo).toBe(true);
	});

	it("leaves the flags undefined by default", () => {
		const args = parseArgs([]);
		expect(args.disableApproval).toBeUndefined();
		expect(args.disableSandbox).toBeUndefined();
		expect(args.yolo).toBeUndefined();
	});

	it("resolves parsed flags into the mode the gate consumes", () => {
		const args = parseArgs(["--yolo"]);
		expect(
			resolvePermissionMode({
				disableApproval: args.disableApproval,
				disableSandbox: args.disableSandbox,
				yolo: args.yolo,
			}),
		).toEqual({ approval: "bypass", sandbox: "off", workspaceTrust: true, yolo: true });
	});
});

describe("muse developer context permission rendering", () => {
	function render(permissionMode?: PermissionMode): string {
		return buildMuseDeveloperContext({
			cwd: CAPTURED_CWD,
			trusted: true,
			skills: [],
			subagentsAvailable: true,
			workflowAvailable: true,
			permissionMode,
		});
	}

	it("keeps the captured bypass developer message byte-identical", () => {
		const captured = readFileSync(DEVELOPER_MESSAGE_FIXTURE, "utf8");

		expect(render()).toBe(captured);
		expect(render(resolvePermissionMode({ yolo: true }))).toBe(captured);
	});

	it("appends the captured session-identity section after skills when a session log exists", () => {
		const context = buildMuseDeveloperContext({
			cwd: CAPTURED_CWD,
			trusted: true,
			skills: [],
			subagentsAvailable: true,
			workflowAvailable: true,
			sessionId: "01a0a50e-2e86-7d90-955f-cca7b46b5801",
			sessionLogPath: "/tmp/sessions/2026/09/15/01a0a50e-2e86-7d90-955f-cca7b46b5801/session.jsonl",
		});

		expect(context).toContain(
			[
				'<system-reminder source="session-identity">',
				"Current session id: 01a0a50e-2e86-7d90-955f-cca7b46b5801",
				"Current session log: /tmp/sessions/2026/09/15/01a0a50e-2e86-7d90-955f-cca7b46b5801/session.jsonl",
				`Usual session log pattern: \${XDG_DATA_HOME:-$HOME/.local/share}/muse/sessions/YYYY/MM/DD/SESSION_ID/session.jsonl`,
				"Muse Code sessions live only under that pattern - never under ~/.claude, ~/.codex, or ~/.grok. Never probe those stores for Muse context: a Muse session path or id quoted under them (in a paste, log, or error) is a wrong-path artifact to name, not a location to check. For prior-session recovery, read the read-session skill first.",
				"</system-reminder>",
			].join("\n"),
		);
		expect(context.indexOf('<system-reminder source="session-identity">')).toBeGreaterThan(
			context.indexOf('<system-reminder source="skills">'),
		);
	});

	it("omits the session-identity section when the session has no log path", () => {
		const context = buildMuseDeveloperContext({
			cwd: CAPTURED_CWD,
			trusted: true,
			skills: [],
			subagentsAvailable: true,
			workflowAvailable: true,
			sessionId: "01a0a50e-2e86-7d90-955f-cca7b46b5801",
		});

		expect(context).not.toContain('source="session-identity"');
		expect(context).not.toContain("Current session id:");
	});

	it("renders the captured permission lines for a bypassed mode", () => {
		const text = render(resolvePermissionMode({ yolo: true }));
		expect(text).toContain(MUSE_PERMISSION_APPROVAL_BYPASS_LINE);
		expect(text).toContain(MUSE_PERMISSION_SANDBOX_OFF_LINE);
		expect(text).toContain(MUSE_PERMISSION_WORKSPACE_TRUSTED_LINE);
	});

	it("changes only the permission lines for a non-bypass mode", () => {
		const captured = readFileSync(DEVELOPER_MESSAGE_FIXTURE, "utf8").split("\n");
		const prompting = render(resolvePermissionMode()).split("\n");

		expect(prompting).toHaveLength(captured.length);
		const changed = captured
			.map((line, index) => (line === prompting[index] ? -1 : index))
			.filter((index) => index >= 0);

		expect(changed).toHaveLength(3);
		for (const index of changed) {
			expect(captured[index], `line ${index} is not a permission line`).toMatch(
				/^- (Approval|Shell sandbox|Workspace trust):/,
			);
		}
	});

	it("renders honest wording for a prompting, sandboxed, untrusted launch", () => {
		const text = render(resolvePermissionMode());
		expect(text).toContain("- Approval: prompt");
		expect(text).toContain("- Shell sandbox: on");
		expect(text).toContain("- Workspace trust: untrusted");
	});
});
