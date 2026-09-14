import { spawn } from "node:child_process";
import type { Static } from "typebox";
import { ensureTool } from "../../utils/tools-manager.ts";
import type { ExtensionContext } from "../extensions/types.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "./truncate.ts";

export interface MuseSearchInput {
	pattern: string;
	paths?: string[];
	glob?: string[];
	hidden?: boolean;
	no_ignore?: boolean;
	follow_symlinks?: boolean;
	binary?: string;
	output_mode?: string;
	mode?: string;
	case_sensitive?: boolean;
	smart_case?: boolean;
	whole_line?: boolean;
	word?: boolean;
	context_before?: number;
	context_after?: number;
	max_matches?: number;
}

function isSearchAsText(binary: string | undefined): boolean {
	if (!binary) return false;
	return /search|text|as[_-]?text/i.test(binary) && !/skip/i.test(binary);
}

export function buildRipgrepArgs(input: MuseSearchInput): string[] {
	const args = ["--color=never", "--no-heading", "--line-number"];
	if (input.output_mode === "files_with_matches") args.push("--files-with-matches");
	else if (input.output_mode === "json") args.push("--json");
	if (input.mode === undefined || input.mode === "literal") args.push("--fixed-strings");
	if (input.case_sensitive === true) args.push("--case-sensitive");
	else if (input.case_sensitive === false) args.push("--ignore-case");
	else if (input.smart_case === true) args.push("--smart-case");
	if (input.hidden) args.push("--hidden");
	if (input.no_ignore) args.push("--no-ignore");
	if (input.follow_symlinks) args.push("--follow");
	if (isSearchAsText(input.binary)) args.push("--text");
	if (input.whole_line) args.push("--line-regexp");
	if (input.word) args.push("--word-regexp");
	if (input.context_before !== undefined) args.push("-B", String(input.context_before));
	if (input.context_after !== undefined) args.push("-A", String(input.context_after));
	if (input.max_matches !== undefined) args.push("-m", String(input.max_matches));
	for (const glob of input.glob ?? []) args.push("-g", glob);
	args.push("-e", input.pattern);
	args.push(...(input.paths && input.paths.length > 0 ? input.paths : ["."]));
	return args;
}

export async function runMuseSearch(
	baseCwd: string,
	input: MuseSearchInput,
	ctx: ExtensionContext | undefined,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: undefined }> {
	const rgPath = await ensureTool("rg");
	if (!rgPath) {
		return { content: [{ type: "text", text: "ripgrep (rg) is not available" }], details: undefined };
	}
	const cwd = ctx?.cwd || baseCwd;
	const args = buildRipgrepArgs(input);
	const signal = ctx?.signal;

	return new Promise((resolve, reject) => {
		const child = spawn(rgPath, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
		const chunks: Buffer[] = [];
		let stderr = "";
		let settled = false;
		const cleanup = () => {
			signal?.removeEventListener("abort", onAbort);
		};
		const onAbort = () => {
			if (!settled) {
				settled = true;
				child.kill("SIGKILL");
				cleanup();
				reject(new Error("Operation aborted"));
			}
		};
		if (signal) {
			if (signal.aborted) return onAbort();
			signal.addEventListener("abort", onAbort, { once: true });
		}
		child.stdout?.on("data", (data: Buffer) => chunks.push(data));
		child.stderr?.on("data", (data: Buffer) => (stderr += data.toString()));
		child.on("error", (error) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(error);
		});
		child.on("close", () => {
			if (settled) return;
			settled = true;
			cleanup();
			const raw = Buffer.concat(chunks).toString("utf-8").trimEnd();
			if (raw.length === 0) {
				const note = stderr.trim();
				resolve({
					content: [{ type: "text", text: note.length > 0 ? `No matches. ${note}` : "No matches." }],
					details: undefined,
				});
				return;
			}
			const truncation = truncateHead(raw, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
			const notice = truncation.truncated
				? `\n\n[output truncated to ${DEFAULT_MAX_LINES} lines / ${formatSize(DEFAULT_MAX_BYTES)}]`
				: "";
			resolve({ content: [{ type: "text", text: `${truncation.content}${notice}` }], details: undefined });
		});
	});
}

export type { Static };
