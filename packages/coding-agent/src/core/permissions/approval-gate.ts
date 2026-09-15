/**
 * Approval gate for Muse tool calls.
 *
 * The gate is deliberately UI-agnostic: it receives a `confirm` port instead of
 * importing TUI code, so it can be unit tested and reused by every run mode.
 * When no port is supplied (headless `-p` / `--mode json|rpc` without a UI) the
 * gate fails closed and blocks approval-required tools.
 *
 * A denial returns the extension `tool_call` hook contract exactly:
 * `{ block: true, reason }` (`ToolCallEventResult`), which stops the tool from
 * executing. An allow is `undefined`, the hook's "no opinion" value.
 */

import type { ToolCallEventResult } from "../extensions/types.ts";
import { isSpawnCoveredTool, type PermissionMode, requiresApproval } from "./permission-mode.ts";

export interface ToolCallApprovalRequest {
	/** Tool name as it appears in the model's tool call. */
	readonly toolName: string;
	/** Optional human-readable summary (command, path, session id) shown in the prompt. */
	readonly detail?: string;
}

/** Injected confirm port. Resolves true to allow, false to deny. */
export type ApprovalConfirmPort = (question: string) => Promise<boolean>;

export interface ApprovalGateOptions {
	/** Launch-time permission mode. */
	readonly mode: PermissionMode;
	/**
	 * Interactive confirm port. When omitted the session has no UI and the gate
	 * fails closed for approval-required tools.
	 */
	readonly confirm?: ApprovalConfirmPort;
	/**
	 * Whether a real dialog-capable UI is attached. Defaults to `confirm !== undefined`.
	 *
	 * Pass this explicitly when the session always provides a confirm function but
	 * it is a no-op headless port that resolves false; without it the gate would
	 * treat that no-op port as an interactive UI and allow spawn-covered tools.
	 */
	readonly hasUI?: boolean;
}

/** Returns `undefined` to allow the call, or `{ block: true, reason }` to stop it. */
export type ApprovalGate = (request: ToolCallApprovalRequest) => Promise<ToolCallEventResult | undefined>;

/** Question text handed to the injected confirm port. */
export function formatApprovalQuestion(request: ToolCallApprovalRequest): string {
	return request.detail
		? `Allow the "${request.toolName}" tool to run?\n${request.detail}`
		: `Allow the "${request.toolName}" tool to run?`;
}

function block(reason: string): ToolCallEventResult {
	return { block: true, reason };
}

const HEADLESS_REASON_TEMPLATE = (toolName: string): string =>
	`Blocked "${toolName}": this tool requires user approval, but the session has no interactive UI. Launch with --disable-approval or --yolo to allow mutating tools.`;

const HEADLESS_SPAWN_REASON_TEMPLATE = (toolName: string): string =>
	`Blocked "${toolName}": its covering bash session cannot exist because approval requires an interactive UI that this session does not have.`;

/**
 * Build a gate bound to one session's mode and confirm port.
 *
 * Decision order:
 * 1. A bypassing launch mode allows everything.
 * 2. Spawn-covered tools (`bash_input`, including its interrupt/terminate action)
 *    are allowed when a UI exists because the covering `bash` spawn already
 *    passed this same gate; headless denies them since no approved spawn could
 *    have produced a session id.
 * 3. Read-only tools are allowed without prompting.
 * 4. Everything else prompts when a UI exists and fails closed when it does not.
 */
export function createApprovalGate(options: ApprovalGateOptions): ApprovalGate {
	const { mode, confirm } = options;
	const hasUI = options.hasUI ?? confirm !== undefined;

	return async (request) => {
		if (mode.approval === "bypass") {
			return undefined;
		}

		if (isSpawnCoveredTool(request.toolName)) {
			return hasUI ? undefined : block(HEADLESS_SPAWN_REASON_TEMPLATE(request.toolName));
		}

		if (!requiresApproval(request.toolName)) {
			return undefined;
		}

		if (!hasUI || !confirm) {
			return block(HEADLESS_REASON_TEMPLATE(request.toolName));
		}

		const approved = await confirm(formatApprovalQuestion(request));
		return approved ? undefined : block(`Denied by user: "${request.toolName}" requires approval in this session.`);
	};
}
