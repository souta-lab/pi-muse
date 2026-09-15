import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { spawn, spawnSync } from "child_process";
import { getBinDir } from "../config.ts";

export interface ShellConfig {
	shell: string;
	args: string[];
	commandTransport?: "argv" | "stdin";
}

/**
 * Find bash executable on PATH (cross-platform)
 */
function isLegacyWslBashPath(path: string): boolean {
	const normalized = path.replace(/\//g, "\\").toLowerCase();
	return /^[a-z]:\\windows\\(?:system32|sysnative)\\bash\.exe$/.test(normalized);
}

function getBashShellConfig(shell: string): ShellConfig {
	return isLegacyWslBashPath(shell) ? { shell, args: ["-s"], commandTransport: "stdin" } : { shell, args: ["-c"] };
}

function findExecutableOnPath(executable: string): string | null {
	if (process.platform === "win32") {
		// Windows: Use 'where' and verify file exists (where can return non-existent paths)
		try {
			const result = spawnSync("where", [executable], {
				encoding: "utf-8",
				timeout: 5000,
				windowsHide: true,
			});
			if (result.status === 0 && result.stdout) {
				const firstMatch = result.stdout.trim().split(/\r?\n/)[0];
				if (firstMatch && existsSync(firstMatch)) {
					return firstMatch;
				}
			}
		} catch {
			// Ignore errors
		}
		return null;
	}

	// Unix: Use 'which' and trust its output (handles Termux and special filesystems)
	try {
		const result = spawnSync("which", [executable], { encoding: "utf-8", timeout: 5000 });
		if (result.status === 0 && result.stdout) {
			const firstMatch = result.stdout.trim().split(/\r?\n/)[0];
			if (firstMatch) {
				return firstMatch;
			}
		}
	} catch {
		// Ignore errors
	}
	return null;
}

/**
 * Resolve shell configuration based on platform and an optional explicit shell path.
 * Resolution order:
 * 1. User-specified shellPath
 * 2. On Windows: Git Bash in known locations, then bash on PATH
 * 3. On Unix: /bin/bash, then bash on PATH, then fallback to sh
 */
export function getShellConfig(customShellPath?: string): ShellConfig {
	// 1. Check user-specified shell path
	if (customShellPath) {
		if (existsSync(customShellPath)) {
			return getBashShellConfig(customShellPath);
		}
		throw new Error(`Custom shell path not found: ${customShellPath}`);
	}

	if (process.platform === "win32") {
		// 2. Try Git Bash in known locations
		const paths: string[] = [];
		const programFiles = process.env.ProgramFiles;
		if (programFiles) {
			paths.push(`${programFiles}\\Git\\bin\\bash.exe`);
		}
		const programFilesX86 = process.env["ProgramFiles(x86)"];
		if (programFilesX86) {
			paths.push(`${programFilesX86}\\Git\\bin\\bash.exe`);
		}

		for (const path of paths) {
			if (existsSync(path)) {
				return getBashShellConfig(path);
			}
		}

		// 3. Fallback: search bash.exe on PATH (Cygwin, MSYS2, WSL, etc.)
		const bashOnPath = findExecutableOnPath("bash.exe");
		if (bashOnPath) {
			return getBashShellConfig(bashOnPath);
		}

		// 4. Fallback: run through the OS shell with piped stdio. This is NOT bash-compatible
		// (bash syntax will not parse), but Muse's bash contract (JSON record, session ids,
		// background delivery) still holds, so the tool stays usable without Git Bash.
		const comspec = process.env.ComSpec ?? process.env.COMSPEC;
		if (comspec && existsSync(comspec)) {
			// /d skips AutoRun scripts, /s preserves the /c command string verbatim.
			return { shell: comspec, args: ["/d", "/s", "/c"] };
		}
		try {
			return getPowerShellConfig();
		} catch {
			// Fall through to the error below.
		}

		throw new Error(
			`No bash shell found and no cmd.exe/PowerShell fallback available. Options:\n` +
				`  1. Install Git for Windows: https://git-scm.com/download/win\n` +
				`  2. Add your bash to PATH (Cygwin, MSYS2, etc.)\n` +
				"  3. Set shellPath in settings.json\n\n" +
				`Searched Git Bash in:\n${paths.map((p) => `  ${p}`).join("\n")}`,
		);
	}

	// Unix: try /bin/bash, then bash on PATH, then fallback to sh
	if (existsSync("/bin/bash")) {
		return getBashShellConfig("/bin/bash");
	}

	const bashOnPath = findExecutableOnPath("bash");
	if (bashOnPath) {
		return getBashShellConfig(bashOnPath);
	}

	return { shell: "sh", args: ["-c"] };
}

export const POWERSHELL_ARGS = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"] as const;

/** Resolve PowerShell on Windows, preferring PowerShell 7 when available. */
export function getPowerShellConfig(): ShellConfig {
	if (process.platform !== "win32") {
		throw new Error("The powershell tool is only available on Windows.");
	}

	const shell = findExecutableOnPath("pwsh.exe") ?? findExecutableOnPath("powershell.exe");
	if (!shell) {
		throw new Error("No PowerShell executable found. Install PowerShell or add powershell.exe/pwsh.exe to PATH.");
	}

	return { shell, args: [...POWERSHELL_ARGS] };
}

export function getShellEnv(): NodeJS.ProcessEnv {
	const binDir = getBinDir();
	const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
	const currentPath = process.env[pathKey] ?? "";
	const pathEntries = currentPath.split(delimiter).filter(Boolean);
	const hasBinDir = pathEntries.includes(binDir);
	const updatedPath = hasBinDir ? currentPath : [binDir, currentPath].filter(Boolean).join(delimiter);

	return {
		...process.env,
		[pathKey]: updatedPath,
	};
}

/**
 * Sanitize binary output for display/storage.
 * Removes characters that crash string-width or cause display issues:
 * - Control characters (except tab, newline, carriage return)
 * - Lone surrogates
 * - Unicode Format characters (crash string-width due to a bug)
 * - Characters with undefined code points
 */
export function sanitizeBinaryOutput(str: string): string {
	// Use Array.from to properly iterate over code points (not code units)
	// This handles surrogate pairs correctly and catches edge cases where
	// codePointAt() might return undefined
	return Array.from(str)
		.filter((char) => {
			// Filter out characters that cause string-width to crash
			// This includes:
			// - Unicode format characters
			// - Lone surrogates (already filtered by Array.from)
			// - Control chars except \t \n \r
			// - Characters with undefined code points

			const code = char.codePointAt(0);

			// Skip if code point is undefined (edge case with invalid strings)
			if (code === undefined) return false;

			// Allow tab, newline, carriage return
			if (code === 0x09 || code === 0x0a || code === 0x0d) return true;

			// Filter out control characters (0x00-0x1F, except 0x09, 0x0a, 0x0x0d)
			if (code <= 0x1f) return false;

			// Filter out Unicode format characters
			if (code >= 0xfff9 && code <= 0xfffb) return false;

			return true;
		})
		.join("");
}

/**
 * Detached child processes must be tracked so they can be killed on parent
 * shutdown signals (SIGHUP/SIGTERM).
 */
const trackedDetachedChildPids = new Set<number>();

export function trackDetachedChildPid(pid: number): void {
	trackedDetachedChildPids.add(pid);
}

export function untrackDetachedChildPid(pid: number): void {
	trackedDetachedChildPids.delete(pid);
}

export function killTrackedDetachedChildren(): void {
	for (const pid of trackedDetachedChildPids) {
		killProcessTree(pid);
	}
	trackedDetachedChildPids.clear();
}

/**
 * Kill a process and all its children (cross-platform)
 */
export function killProcessTree(pid: number): void {
	if (process.platform === "win32") {
		// Use the trusted System32 executable so cleanup does not depend on PATH.
		try {
			const child = spawn(
				join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
				["/F", "/T", "/PID", String(pid)],
				{
					stdio: "ignore",
					detached: true,
					windowsHide: true,
				},
			);
			// A failed spawn emits "error" asynchronously; consume it to avoid crashing Node.
			child.once("error", () => {});
		} catch {
			// Ignore errors if taskkill fails.
		}
	} else {
		// Use SIGKILL on Unix/Linux/Mac
		try {
			process.kill(-pid, "SIGKILL");
		} catch {
			// Fallback to killing just the child if process group kill fails
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				// Process already dead
			}
		}
	}
}

/** PTY mechanism used for a bash session, best effort per platform. */
export type PtyKind = "gnu-script" | "bsd-script" | "winpty" | "pipes";

export interface PtyStrategy {
	kind: PtyKind;
	/** Detected helper binary (`script` or `winpty.exe`); null for the "pipes" fallback. */
	path: string | null;
}

const PTY_SCRIPT_PATHS = ["/usr/bin/script", "/bin/script", "/usr/local/bin/script"];

/**
 * Pure platform -> PTY mechanism mapping. Linux ships util-linux `script` (GNU argv form),
 * macOS and the BSDs ship BSD `script` (no -c/-e; the command follows the record file), and
 * Windows has no PTY API reachable from plain Node, so `winpty` is the closest equivalent.
 */
export function resolvePtyKind(platform: NodeJS.Platform): PtyKind {
	switch (platform) {
		case "linux":
			return "gnu-script";
		case "darwin":
		case "freebsd":
		case "netbsd":
		case "openbsd":
			return "bsd-script";
		case "win32":
			return "winpty";
		default:
			return "pipes";
	}
}

function findFileInPath(executable: string, pathValue: string, exists: (path: string) => boolean): string | null {
	for (const entry of pathValue.split(delimiter)) {
		const dir = entry.trim().replace(/^"(.*)"$/, "$1");
		if (!dir) continue;
		const candidate = join(dir, executable);
		if (exists(candidate)) return candidate;
	}
	return null;
}

/**
 * Detect the concrete PTY helper to spawn. File probes are injectable so the
 * platform-to-mechanism mapping can be tested without running on the foreign platform.
 */
export function detectPtyStrategy(
	platform: NodeJS.Platform = process.platform,
	exists: (path: string) => boolean = existsSync,
): PtyStrategy {
	const kind = resolvePtyKind(platform);
	if (kind === "gnu-script" || kind === "bsd-script") {
		const path = PTY_SCRIPT_PATHS.find((candidate) => exists(candidate)) ?? null;
		return path ? { kind, path } : { kind: "pipes", path: null };
	}
	if (kind === "winpty") {
		const path = findFileInPath("winpty.exe", process.env.PATH ?? "", exists);
		return path ? { kind, path } : { kind: "pipes", path: null };
	}
	return { kind: "pipes", path: null };
}

export interface PtyCommandPlan {
	kind: PtyKind;
	command: string;
	args: string[];
	/** True when the caller writes the command to the child's stdin instead of passing it in argv. */
	commandOnStdin: boolean;
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

function shellToken(value: string): string {
	return /^[\w@%+=:,./-]+$/.test(value) ? value : shellQuote(value);
}

/**
 * Build the spawn plan for one shell command. `command: null` means the shell reads the command
 * from stdin (legacy WSL bash with `-s`), so argv carries only the shell invocation.
 *
 * Fidelity differences, documented because the Muse bash contract hides them from callers:
 * - winpty restores console semantics (line editing, colors) through a hidden console, but it
 *   re-renders the console screen buffer, so very long output and full-screen TUIs are lossy.
 * - The "pipes" fallback is not a PTY on any platform: no line discipline and no tty detection,
 *   so interactive/full-screen programs and `[ -t 1 ]` checks behave differently, while the bash
 *   result contract (JSON record, integer session ids, background delivery) stays identical.
 */
export function planPtyCommand(input: {
	kind: PtyKind;
	ptyPath: string | null;
	shellPath: string;
	shellArgs: string[];
	command: string | null;
}): PtyCommandPlan {
	const commandOnStdin = input.command === null;
	const commandArgs = input.command === null ? [] : [input.command];
	switch (input.kind) {
		case "gnu-script": {
			const inner = [shellToken(input.shellPath), ...input.shellArgs.map(shellToken)];
			if (input.command !== null) inner.push(shellQuote(input.command));
			return {
				kind: "gnu-script",
				command: input.ptyPath ?? input.shellPath,
				args: ["-q", "-e", "-c", inner.join(" "), "/dev/null"],
				commandOnStdin,
			};
		}
		case "bsd-script":
			return {
				kind: "bsd-script",
				command: input.ptyPath ?? input.shellPath,
				args: ["-q", "/dev/null", input.shellPath, ...input.shellArgs, ...commandArgs],
				commandOnStdin,
			};
		case "winpty":
			return {
				kind: "winpty",
				command: input.ptyPath ?? input.shellPath,
				args: ["-Xallow-non-tty", "--", input.shellPath, ...input.shellArgs, ...commandArgs],
				commandOnStdin,
			};
		default:
			return { kind: "pipes", command: input.shellPath, args: [...input.shellArgs, ...commandArgs], commandOnStdin };
	}
}
