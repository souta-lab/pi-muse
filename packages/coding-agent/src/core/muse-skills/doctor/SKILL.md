---
name: doctor
description: Diagnose Muse Code product/runtime issues from installed binary evidence. Use ONLY when the user explicitly invokes the doctor skill, asks to debug/troubleshoot Muse Code itself, asks what happened earlier in the current Muse Code session, or explicitly selects an earlier Muse Code session. Do NOT use for ordinary repository code failures or history, benchmark tasks, implementation debugging, build/test hangs, or third-party project issues.
---

# Diagnose

Diagnose Muse Code as an installed product. Use this skill only when the user
explicitly invokes `doctor` or clearly asks to debug/troubleshoot Muse Code
itself from binary/runtime evidence. Assume the user has the binary, not the
source tree. Help them understand how the app works, collect the smallest safe
evidence set, identify the likely failing layer, and give the next safe action.

## Scope

- Use this skill ONLY when the user explicitly invokes `doctor`, asks to use
  the doctor skill, or clearly asks to debug/troubleshoot broken Muse Code
  product behavior: app, CLI, TUI, desktop, crash, provider/model, settings,
  auth, trust, skills, plugins, MCP, session, resume, export, trace, approvals,
  sandbox, update, or unexpected output.
- Use this skill when the user asks how Muse Code itself works, where Muse Code
  stores state, what a Muse Code log/session/trace means, or how to collect a
  Muse Code support bundle.
- Use this skill when the user asks what happened earlier in the current
  Muse Code session or explicitly selects an earlier Muse Code session for
  evidence. This does not include ordinary repository history or an unspecified
  third-party agent session.
- Do NOT use this skill for ordinary repository engineering: code
  implementation, third-party project bugs, benchmark/eval tasks, build or test
  failures, command hangs, toolchain issues, CI failures, or local debugging
  inside a non-Muse Code codebase. Handle those with the normal engineering
  workflow unless the evidence points to Muse Code itself.
- Treat the user as a product user first, not as a repository engineer.
- For pure settings questions or explicitly requested settings edits with no
  product failure to investigate, use the `manage-settings` skill instead;
  Diagnose reads settings only as evidence for a failure it is investigating.
- Do not create issues, branches, commits, PRs, install/enable/disable skills or
  plugins, change settings/auth/trust, upload logs, run live-provider/network
  checks, or edit code unless the user explicitly asks.
- Do not print secrets, raw prompts, raw model payloads, auth tokens, API keys,
  cookies, bearer headers, or full session logs. Prefer redacted exports,
  key/value presence checks, and concise summaries.
- If a surface has no standalone app log, say so and use session logs, crash
  reports, trace inspection, or export evidence instead of inventing a path.

## Mental Model

Explain the relevant product path before asking for logs:

- The binary reads settings/auth/trust from the user's config directory and
  writes sessions, crashes, model catalog cache, and memory under the data
  directory.
- A Muse Code session is the main handle for resume, trace inspection, export,
  and support. Prefer a session id or session log path over screenshots of
  terminal output.
- Provider/auth failures are often config, environment, model catalog, network,
  or credential problems. Separate those before blaming the model.
- Skills/plugins/MCP are loaded product capabilities. Diagnose discovery,
  activation, trust, validation, and runtime errors separately.
- A trace/export explains what the binary saw and did. It is evidence, not a
  transcript to paste raw.

## Triage Questions

1. Name the failing surface and exact symptom.
2. Record the command, cwd, session id/path if provided, whether the user wants
   to inspect or continue that session, approximate time, provider/model if
   relevant, and whether the issue reproduces.
3. Ask for one missing handle only when it blocks a safe local check. Prefer:
   exact command, session id/path, time window, and whether they can reproduce.
4. If the user only wants an explanation, explain first and avoid running checks.

## Product Evidence Map

Collect the smallest read-only set that explains the issue. Adapt the map to the
symptom; do not run every row by default.

The config/data roots below are Muse Code's entire local state surface. A
config, log, or session file outside them is not Muse Code state —
never present one as the product's active configuration, logs, or session
evidence.
Variables such as `CODEX_HOME` matter only for explicitly requested
import/compat evidence and stay attributed to the product that owns them.

1. Build/provenance: `muse --version`; also note `command -v muse` when
   multiple copies may exist.
2. Config/data roots: `$XDG_CONFIG_HOME/muse` or `$HOME/.config/muse`;
   `$XDG_DATA_HOME/muse` or `$HOME/.local/share/muse`.
3. Local files: `settings.json`, `auth.json`, and `trust.json`; read settings
   when relevant, but report auth/trust presence and provider names only.
4. Data dirs: `sessions`, `memory`, `model-catalog`, and `crashes` under the
   data dir. For crashes, summarize report metadata and file path, not session
   content.
5. Session evidence: prefer `muse export --redacted --out <file>` for the
   latest workspace session, or `muse export --session <id-or-session.jsonl>
   --redacted --out <file>` when the user provides a handle.
6. Continuation handles: if the user provides a Muse Code session id and wants
   to continue that session, point them to `muse resume <session-id>` or
   `muse resume --last` for interactive continuation. Use
   `muse exec --session-id <session-id> "<follow-up>"` only on explicit
   request for headless continuation. Add `--allow-workspace-switch` to the
   `muse exec --session-id` command only after confirming the session
   belongs to another workspace; interactive `muse resume` does not take
   this flag. If an exit, fork, or handoff message printed
   `muse resume <session-id>`, treat that command as the canonical handle.
7. Trace evidence: use `muse trace inspect --session-log <session.jsonl>
   --render-mode compact`; add `--run-id <uuid>` or `--all-runs` for multi-run
   logs; use `--format json` only when structured analysis is needed.
8. User support bundle: use `/feedback` when available; otherwise prefer a
   redacted export, trace inspection, crash metadata, and concise reproduction
   steps.
9. Skills/plugins/MCP: use `muse skills list --enabled-only --json` and safe
   `muse plugins ... --help` or validation commands when the symptom points
   there.
10. Environment: check relevant non-secret variables by presence/value only, such
   as `MUSE_MODEL`, base-url variables with credentials redacted, XDG dirs,
   `CODEX_HOME` for import/compat issues, and telemetry variables by presence
   only.

## Use Current Session Evidence First

For a question about what happened earlier in the current Muse Code session,
use the sibling `scripts/session-evidence.py` helper before export or full trace
inspection. After `read_skill` gives the physical Diagnose package path, run:

```bash
python3 <doctor-skill-dir>/scripts/session-evidence.py --session-log <current-session.jsonl> --workspace "$PWD"
```

The runtime session-identity context already contains the exact current log
path. Do not ask the user for a path already present there, do not guess a
latest session, and do not search the session store first. A host may instead
provide `MUSE_CURRENT_SESSION_LOG`, in which case the helper can run without a
selector.

For an explicitly selected earlier Muse Code session, use the exact path or id:

```bash
python3 <doctor-skill-dir>/scripts/session-evidence.py --session-log <explicit-session.jsonl> --workspace "$PWD"
python3 <doctor-skill-dir>/scripts/session-evidence.py --session-id <explicit-session-id> --workspace "$PWD"
```

Both explicit earlier-session forms are current-workspace scoped and fail
closed on unknown workspace metadata, a mismatch, or ambiguity. Use `--kind`,
`--path`, `--tool`, `--run-id`, or sequence bounds to narrow follow-up evidence.
Projected events retain their source stream, and the default bound reserves
evidence for both the main session and child sessions so a busy child cannot
erase the parent timeline. Always compare durable actions with assistant claims,
especially across compaction and child activity. Use a
redacted export or compact trace only when this bounded projection is
insufficient. Never paste the raw session log into model context.

## Diagnose Live Session Ownership Safely

Use this path when resume says a session is already open or the original
terminal no longer accepts input:

1. Select the exact session first and run `scripts/session-evidence.py` as
   above. Bound the output and compare its latest durable activity timestamps;
   do not start with a store-wide process or file search.
2. Treat `.session.lock` as an inode-backed kernel lease, not a marker file:
   file existence is not lock ownership, and `flock` protects an open inode.
   Unlinking a contended pathname can let another process create and lock a new
   inode while the original writer still owns the old inode.
3. Probe the exact lock read-only with a non-blocking exclusive `flock`. Open it
   without truncation, report only `acquirable`, `contended`, `missing`, or the
   read error, then close it immediately. Never resume the session as a probe.
4. Read the lock body's PID only as a hint. A tool sandbox or PID namespace may
   not see the host process; `ps`/`kill -0` absence inside it cannot prove that
   the host owner died. Request a host-shell check when that distinction matters.
5. Check the bounded session evidence for prior file mutation involving
   `.session.lock`, especially `rm`, unlink, replacement, truncation, or
   recreation. If the path is missing while old activity advances, stop resume
   attempts and preserve evidence.

Never remove, replace, truncate, or recreate `.session.lock` as diagnosis or
repair. Never signal the owner from Diagnose. Do not request takeover or use an
owner-control endpoint. Ask the user to exit the owning process normally, then
explicitly retry ordinary resume.

Classify the result before recommending an action:

| Evidence | Classification | Safe next action |
| --- | --- | --- |
| Lease is acquirable | No current kernel owner; a leftover pathname is harmless | Retry normal resume; do not clean the file for tidiness |
| contended lease with advancing session activity | Live owner and active runtime; terminal attachment may be the failed layer | Preserve the owner; inspect terminal/PTY evidence or exit it normally |
| Contended lease with bounded activity idle | Live kernel owner, runtime/terminal health unknown | Ask the user to exit the owning process normally, then explicitly retry ordinary resume |
| Legacy owner-control artifacts are present | Diagnostic leftovers from an old binary; the kernel lease remains authoritative | Treat them as diagnostic only; exit the owning process normally before ordinary resume retry |
| Lock path was unlinked or replaced while old activity continues | Unsafe prior mutation with possible dual writers | Stop further resume attempts, preserve both inode/session timelines, and escalate; do not recreate the lock |

A contended lease proves a live kernel owner, not that its TUI, terminal,
provider, or runtime is healthy. Pin the failing layer from activity plus
host-visible evidence before proposing a product fix.

## Narrowing Loop

Work from evidence:

1. State the most likely layer in one or two concrete sentences.
2. Say why the next check will confirm or reject that hypothesis, then run that
   one safe local check.
3. Update the hypothesis from the result and continue only while the next check
   is still relevant and safe.
4. If a live provider, live network, destructive command, or upload is required,
   state why and get explicit user approval first.
5. If customization or local state is suspected, compare against an isolated
   temporary XDG config/data profile only after explaining that it will not read
   or mutate the user's real settings.

## Common Diagnosis Paths

- Startup/auth: binary path -> version -> config load -> auth provider present
  -> model/catalog selection -> first network boundary.
- Provider/model: selected provider/model -> base URL with credentials redacted
  -> auth presence -> model catalog cache -> trace request/error summary.
- Session/resume: session id/path -> workspace match -> session log exists ->
  resume/export/trace command -> whether the user wants inspection or
  continuation.
- Skills/plugins/MCP: list/discovery -> activation/trust -> validation output ->
  runtime trace or startup diagnostic.
- Desktop/TUI: packaged app/binary version -> session id -> UI-visible symptom
  -> crash/report metadata -> trace/export evidence. Say when source-only tests
  cannot prove a packaged-app issue.

## Fix Boundary

- Settings-only fix: propose the exact change and apply it only after explicit
  user request; preserve unknown settings fields and verify with a read-back or
  focused command.
- Workspace code fix: switch to the RED-before-GREEN engineering loop only when
  the user explicitly asks to fix code in the current repo. Reproduce first,
  edit surgically, rerun the same check, and report incomplete if it still
  fails.
- Product bug report: if the evidence points to Muse Code itself and no local fix
  is safe, give a concise support bundle with symptom, version, config/data
  paths, session/crash paths, redacted export/trace evidence, likely cause, and
  next action.

## Completion Report

Include:

- Symptom and affected surface.
- Product mental model relevant to this failure.
- Evidence collected, paths inspected, commands and outcomes.
- Redactions applied.
- Most likely cause and confidence.
- Fix made, proposed, or not made.
- Remaining uncertainty and the next safest check.
skills/doctor/scripts/session-evidence.py#!/usr/bin/env python3
"""Bounded, redacted projections of retained Muse Code sessions."""

from __future__ import annotations

import argparse
import collections
import json
import os
import re
import shlex
import sys
from pathlib import Path
from typing import Iterable

SCHEMA_VERSION = 1
SESSION_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}")
SENSITIVE_KEY = re.compile(
    r"(?:api.?key|authorization|bearer|cookie|credential|password|secret|token)", re.I
)
SENSITIVE_TEXT = (
    re.compile(r"(?i)\bBearer\s+[^\s,;]+"),
    re.compile(
        r"(?i)\b(api[_-]?key|authorization|cookie|credential|password|secret|token)"
        r"(?:\\)?(\s*[\"']?\s*[:=]\s*)(?:\\)?"
    ),
)
PRIVATE_KEY_BLOCK = re.compile(
    r"-----BEGIN ([A-Z ]*PRIVATE KEY)-----.*?(?:-----END \1-----|\Z)", re.S
)
STANDALONE_SECRET = re.compile(
    r"(?<![A-Za-z0-9])(?:"
    r"sk[-_][A-Za-z0-9_-]{8,}|"
    r"gh[pousr]_[A-Za-z0-9_]{8,}|"
    r"github_pat_[A-Za-z0-9_]{8,}|"
    r"(?:AKIA|ASIA)[0-9A-Z]{12,}|"
    r"AIza[A-Za-z0-9_-]{20,}|"
    r"npm_[A-Za-z0-9_-]{8,}|"
    r"xox[baprs]-[A-Za-z0-9-]{8,}|"
    r"LLM\|[^\s,;]+|"
    r"eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}"
    r")(?![A-Za-z0-9])"
)
DIRECT_MUTATORS = {
    "apply_patch",
    "delete_file",
    "edit_file",
    "write_file",
}
SHELL_TOOLS = {"bash", "exec_command", "shell"}
SHELL_MUTATORS = {
    "cp",
    "git",
    "install",
    "mv",
    "rm",
    "rmdir",
    "sed",
    "tee",
    "truncate",
    "unlink",
}


class SelectionError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def _emit(value: dict) -> None:
    sys.stdout.write(json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n")


def _error(code: str, message: str) -> int:
    _emit({"schema_version": SCHEMA_VERSION, "status": "error", "code": code, "message": message})
    return 2


def _canonical(path: Path) -> Path:
    return path.expanduser().resolve(strict=False)


def _matches_workspace(metadata: str, workspace: Path) -> bool:
    return _canonical(workspace).is_relative_to(_canonical(Path(metadata)))


def _session_root(data_root: Path) -> Path:
    return data_root.expanduser().absolute() / "muse" / "sessions"


def _workspace_metadata(path: Path) -> str | None:
    latest: str | None = None
    try:
        with path.open("r", encoding="utf-8", errors="replace") as handle:
            for line in handle:
                try:
                    record = json.loads(line)
                except (ValueError, UnicodeError):
                    continue
                if not isinstance(record, dict):
                    continue
                payload = record.get("payload")
                if not isinstance(payload, dict):
                    continue
                workspace_root: object = None
                if record.get("payload_type") == "runtime.session.metadata":
                    workspace_root = payload.get("workspace_root")
                    nested = payload.get("record")
                    if not isinstance(workspace_root, str) and isinstance(nested, dict):
                        workspace_root = nested.get("workspace_root")
                    latest = workspace_root if isinstance(workspace_root, str) else None
                elif record.get("payload_type") == "runtime.session":
                    event = payload.get("event")
                    if (
                        isinstance(event, dict)
                        and event.get("kind") == "context_projection_checkpoint"
                    ):
                        checkpoint_metadata = event.get("session_metadata")
                        if isinstance(checkpoint_metadata, dict):
                            workspace_root = checkpoint_metadata.get("workspace_root")
                            latest = (
                                workspace_root if isinstance(workspace_root, str) else None
                            )
    except OSError:
        return None
    return latest


def _select_by_id(session_id: str, data_root: Path, workspace: Path) -> Path:
    if not SESSION_ID.fullmatch(session_id):
        raise SelectionError("invalid_session_id", "Session id contains unsupported characters")
    root = _session_root(data_root)
    if not root.is_dir():
        raise SelectionError("session_not_found", "No retained session root exists under the data directory")
    candidates: list[Path] = []
    for directory, _dirnames, filenames in os.walk(root):
        path = Path(directory)
        if path.name != session_id or "session.jsonl" not in filenames:
            continue
        relative = path.relative_to(root)
        if "subagent" not in relative.parts:
            candidates.append(path / "session.jsonl")
    if not candidates:
        raise SelectionError("session_not_found", f"No retained session matches id {session_id!r}")
    matches: list[Path] = []
    unknown = 0
    mismatched = 0
    for candidate in sorted(candidates):
        metadata = _workspace_metadata(candidate)
        if metadata is None:
            unknown += 1
        elif _matches_workspace(metadata, workspace):
            matches.append(candidate)
        else:
            mismatched += 1
    if len(matches) > 1:
        raise SelectionError("session_ambiguous", "More than one retained session id matches this workspace")
    if len(matches) == 1:
        return matches[0]
    if unknown:
        raise SelectionError(
            "session_workspace_unknown",
            "The selected earlier session has no durable workspace metadata",
        )
    if mismatched:
        raise SelectionError(
            "session_workspace_mismatch",
            "The selected earlier session belongs to another workspace",
        )
    raise SelectionError("session_not_found", f"No retained session matches id {session_id!r}")


def _select(args: argparse.Namespace) -> tuple[Path, str]:
    validate_workspace = False
    if args.session_log:
        path = Path(args.session_log).expanduser().absolute()
        mode = "current_path"
        validate_workspace = True
    elif args.session_id:
        data_root = Path(args.data_root) if args.data_root else _default_data_root()
        path = _select_by_id(args.session_id, data_root, Path(args.workspace))
        mode = "explicit_id"
    else:
        current = os.environ.get("MUSE_CURRENT_SESSION_LOG")
        if not current:
            raise SelectionError(
                "current_session_required",
                "Pass the startup-injected current session log or an explicit earlier session id/path",
            )
        path = Path(current).expanduser().absolute()
        mode = "current_env"
    if not path.is_file():
        raise SelectionError("session_log_unavailable", f"Session log is unavailable: {path}")
    if validate_workspace:
        metadata = _workspace_metadata(path)
        if metadata is None:
            raise SelectionError(
                "session_workspace_unknown",
                "The selected session path has no durable workspace metadata",
            )
        if not _matches_workspace(metadata, Path(args.workspace)):
            raise SelectionError(
                "session_workspace_mismatch",
                "The selected session path belongs to another workspace",
            )
    return path, mode


def _default_data_root() -> Path:
    value = os.environ.get("XDG_DATA_HOME")
    return Path(value) if value else Path.home() / ".local" / "share"


def _event(record: dict) -> dict:
    payload = record.get("payload")
    if not isinstance(payload, dict):
        return {}
    event = payload.get("event")
    return event if isinstance(event, dict) else {}


def _tool_name(value: object) -> str:
    if not isinstance(value, str):
        return ""
    name = value
    for separator in ("__", ".", "/"):
        if separator in name:
            name = name.rsplit(separator, 1)[-1]
    return name


def _args(value: object) -> dict | str:
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except ValueError:
            return "[REDACTED]"
        return parsed if isinstance(parsed, dict) else "[REDACTED]"
    return {}


def _truncate(text: str, maximum: int, omissions: dict) -> str:
    encoded = text.encode("utf-8")
    if len(encoded) <= maximum:
        return text
    omissions["text_truncations"] += 1
    return encoded[:maximum].decode("utf-8", errors="ignore") + "…[truncated]"


def _sensitive_value_end(text: str, start: int) -> int:
    if start >= len(text):
        return start
    opener = text[start]
    if opener in "{[":
        closers = {"{": "}", "[": "]"}
        stack = [closers[opener]]
        quote: str | None = None
        escaped = False
        for index in range(start + 1, len(text)):
            character = text[index]
            if quote is not None:
                if escaped:
                    escaped = False
                elif character == "\\":
                    escaped = True
                elif character == quote:
                    quote = None
            elif character in "\"'":
                quote = character
            elif character in closers:
                stack.append(closers[character])
            elif character == stack[-1]:
                stack.pop()
                if not stack:
                    return index + 1
        return len(text)
    if opener in "\"'":
        if start > 0 and text[start - 1] == "\\":
            index = start + 1
            inner_escaped = False
            # JSON encoding adds one escape layer: scan `\x` units and close on
            # `\<opener>` unless preceded by `\\`; no closer redacts to the end.
            while index < len(text):
                if text[index] == "\\" and index + 1 < len(text):
                    unit = text[index + 1]
                    index += 2
                    if inner_escaped:
                        inner_escaped = False
                    elif unit == "\\":
                        inner_escaped = True
                    elif unit == opener:
                        return index
                else:
                    index += 1
                    inner_escaped = False
            return len(text)
        escaped = False
        for index in range(start + 1, len(text)):
            character = text[index]
            if escaped:
                escaped = False
            elif character == "\\":
                escaped = True
            elif character == opener:
                return index + 1
        return len(text)
    end = start
    while end < len(text) and text[end] not in "\t\r\n ,;":
        end += 1
    return end


def _redact_sensitive_values(text: str) -> str:
    parts: list[str] = []
    position = 0
    while match := SENSITIVE_TEXT[1].search(text, position):
        parts.extend(
            (text[position : match.start()], match.group(1), match.group(2), "[REDACTED]")
        )
        position = _sensitive_value_end(text, match.end())
    parts.append(text[position:])
    return "".join(parts)


def _redact_text(text: str, maximum: int, omissions: dict) -> str:
    redacted = PRIVATE_KEY_BLOCK.sub("[REDACTED]", text)
    redacted = SENSITIVE_TEXT[0].sub("Bearer [REDACTED]", redacted)
    redacted = _redact_sensitive_values(redacted)
    redacted = STANDALONE_SECRET.sub("[REDACTED]", redacted)
    return _truncate(redacted, maximum, omissions)


def _sanitize(value: object, maximum: int, omissions: dict, key: str = "") -> object:
    if SENSITIVE_KEY.search(key):
        return "[REDACTED]"
    if isinstance(value, str):
        return _redact_text(value, maximum, omissions)
    if isinstance(value, dict):
        return {
            str(child_key): _sanitize(child_value, maximum, omissions, str(child_key))
            for child_key, child_value in value.items()
        }
    if isinstance(value, list):
        return [_sanitize(item, maximum, omissions) for item in value]
    if isinstance(value, (int, float, bool)) or value is None:
        return value
    return _redact_text(str(value), maximum, omissions)


def _summary(value: object, maximum: int, omissions: dict) -> str:
    sanitized = _sanitize(value, maximum, omissions)
    if isinstance(sanitized, str):
        return sanitized
    return _truncate(
        json.dumps(sanitized, sort_keys=True, separators=(",", ":")), maximum, omissions
    )


def _path_from_args(args: dict) -> str | None:
    for key in ("path", "file_path", "target_path", "target", "filename"):
        value = args.get(key)
        if isinstance(value, str):
            return value
    patch = args.get("patch") or args.get("input")
    if isinstance(patch, str):
        match = re.search(r"^\*\*\* (?:Add|Update|Delete) File: (.+)$", patch, re.M)
        if match:
            return match.group(1)
    return None


def _shell_segments(command: str) -> list[list[str]]:
    try:
        lexer = shlex.shlex(command, posix=True, punctuation_chars=";&|")
        lexer.whitespace_split = True
        lexer.commenters = "#"
        tokens = list(lexer)
    except ValueError:
        return []
    segments: list[list[str]] = []
    current: list[str] = []
    for token in tokens:
        if token and all(character in ";|&" for character in token):
            if current:
                segments.append(current)
                current = []
        else:
            current.append(token)
    if current:
        segments.append(current)
    return segments


def _shell_segment_mutation(tokens: list[str]) -> tuple[bool, str | None]:
    if not tokens:
        return False, None
    start = 0
    while start < len(tokens) and "=" in tokens[start] and not tokens[start].startswith(("/", "./")):
        start += 1
    if start >= len(tokens):
        return False, None
    executable = Path(tokens[start]).name
    if executable not in SHELL_MUTATORS:
        return False, None
    args = tokens[start + 1 :]
    if executable == "git":
        index = 0
        git_workspace: str | None = None
        while index < len(args):
            token = args[index]
            if token in {"-C", "-c", "--git-dir", "--work-tree", "--namespace"}:
                if token == "-C" and index + 1 < len(args):
                    git_workspace = args[index + 1]
                index += 2
            elif token.startswith(("--git-dir=", "--work-tree=", "--namespace=")):
                index += 1
            elif token.startswith("-"):
                index += 1
            else:
                break
        if index >= len(args):
            return False, None
        operation = args[index]
        if operation == "worktree":
            remainder = args[index + 1 :]
            subcommand = next(
                (token for token in remainder if not token.startswith("-")), None
            )
            if subcommand != "remove":
                return False, None
            operands = [
                token
                for token in remainder[remainder.index(subcommand) + 1 :]
                if token != "--" and not token.startswith("-")
            ]
            return True, operands[-1] if operands else git_workspace
        if operation == "switch":
            if not any(
                token in {"--discard-changes", "--force", "-f"}
                for token in args[index + 1 :]
            ):
                return False, None
        elif operation not in {"checkout", "clean", "reset", "restore", "rm"}:
            return False, None
        operands = [
            token
            for token in args[index + 1 :]
            if token != "--" and not token.startswith("-")
        ]
        return True, operands[-1] if operands else git_workspace
    operands = [token for token in args if token != "--" and not token.startswith("-")]
    path = operands[-1] if operands else None
    return True, path


def _shell_mutation(command: str) -> tuple[bool, str | None]:
    for segment in _shell_segments(command):
        mutation, path = _shell_segment_mutation(segment)
        if mutation:
            return mutation, path
    return False, None


def _base_event(record: dict, source: str, kind: str, run_id: str | None) -> dict:
    value = {
        "source": source,
        "sequence": record.get("sequence"),
        "recorded_at": record.get("recorded_at"),
        "run_id": run_id,
        "kind": kind,
    }
    stream = record.get("stream")
    if isinstance(stream, dict):
        value["stream"] = {
            key: stream[key]
            for key in ("id", "kind")
            if isinstance(stream.get(key), (str, int))
        }
    elif isinstance(stream, str):
        value["stream"] = {"id": stream}
    return value


def _project(
    record: dict,
    source: str,
    maximum: int,
    omissions: dict,
    call_tools: collections.OrderedDict[tuple[str, str], str],
) -> list[dict]:
    payload = record.get("payload")
    if not isinstance(payload, dict):
        return []
    payload_type = str(record.get("payload_type") or "")
    event = _event(record)
    payload_kind = str(payload.get("kind") or "")
    kind = str(event.get("kind") or payload_kind)
    run_id = payload.get("run_id") or event.get("run_id")
    run_id = run_id if isinstance(run_id, str) else None
    projected: list[dict] = []

    if kind == "started" and payload_kind == "run":
        prompt = event.get("prompt")
        if isinstance(prompt, str):
            item = _base_event(record, source, "user_message", run_id)
            item["summary"] = _redact_text(prompt, maximum, omissions)
            projected.append(item)
        item = _base_event(record, source, "run", run_id)
        item["summary"] = "run started"
        projected.append(item)
    elif kind == "assistant_message_committed":
        item = _base_event(record, source, "assistant_message", run_id)
        item["summary"] = _summary(event.get("text", ""), maximum, omissions)
        projected.append(item)
    elif kind == "assistant_tool_calls_committed":
        for call in event.get("tool_calls") or []:
            if not isinstance(call, dict):
                continue
            tool = _tool_name(call.get("name"))
            call_args = call.get("args")
            args = _args(call_args)
            if isinstance(args, str):
                args = {"raw_args": args}
            call_id = call.get("call_id") or call.get("id")
            call_id = call_id if isinstance(call_id, str) else None
            path = _path_from_args(args)
            item = _base_event(record, source, "tool_call", run_id)
            item.update({"tool": tool, "summary": _summary(args, maximum, omissions)})
            if call_id is not None:
                item["call_id"] = call_id
                call_tools[(source, call_id)] = tool
                call_tools.move_to_end((source, call_id))
                if len(call_tools) > 4096:
                    call_tools.popitem(last=False)
            if path is not None:
                item["path"] = _redact_text(path, maximum, omissions)
            projected.append(item)
            mutation = tool in DIRECT_MUTATORS
            if tool in SHELL_TOOLS:
                command = args.get("cmd") or args.get("command")
                if not command and isinstance(call_args, str):
                    command = call_args
                if isinstance(command, str):
                    mutation, shell_path = _shell_mutation(command)
                    path = shell_path or path
            if mutation:
                changed = _base_event(record, source, "file_mutation", run_id)
                changed.update({"tool": tool, "summary": item["summary"]})
                if call_id is not None:
                    changed["call_id"] = call_id
                if path is not None:
                    changed["path"] = _redact_text(path, maximum, omissions)
                projected.append(changed)
    elif kind in {
        "tool_result",
        "tool_result_batch_committed",
        "tool_results_committed",
        "tool_result_committed",
    }:
        results = event.get("results")
        if not isinstance(results, list):
            results = [event]
        for result in results:
            if not isinstance(result, dict):
                continue
            text = result.get("text") or result.get("output") or result.get("result") or ""
            call_id = result.get("tool_call_id") or result.get("call_id")
            call_id = call_id if isinstance(call_id, str) else None
            item = _base_event(record, source, "tool_result", run_id)
            item["summary"] = _summary(text, maximum, omissions)
            if call_id is not None:
                item["call_id"] = call_id
                tool = call_tools.get((source, call_id))
                if tool is not None:
                    item["tool"] = tool
            projected.append(item)
    elif "compaction" in kind:
        item = _base_event(record, source, "compaction", run_id)
        item["summary"] = _summary(event, maximum, omissions)
        projected.append(item)
    elif (
        "approval" in kind.lower()
        or "approval" in payload_kind.lower()
        or "approval" in payload_type.lower()
    ):
        item = _base_event(record, source, "approval", run_id)
        approval = dict(event or payload)
        if "raw_args" in approval:
            approval["raw_args"] = _args(approval["raw_args"])
        item["summary"] = _summary(approval, maximum, omissions)
        projected.append(item)
    elif kind == "terminal":
        item = _base_event(record, source, "run", run_id)
        item["summary"] = f"run {event.get('terminal', 'terminal')}"
        projected.append(item)

    if "subagent" in payload_type.lower() or "subagent" in kind.lower():
        item = _base_event(record, source, "subagent", run_id)
        item["summary"] = _summary(event or payload, maximum, omissions)
        projected.append(item)
    return projected


def _sources(session_log: Path, include_subagents: bool) -> Iterable[tuple[str, Path]]:
    yield "main", session_log
    if not include_subagents:
        return
    root = session_log.parent / "subagent"
    if not root.is_dir():
        return
    for directory, dirnames, filenames in os.walk(root):
        dirnames.sort()
        if "session.jsonl" not in filenames:
            continue
        path = Path(directory) / "session.jsonl"
        relative = path.parent.relative_to(root).as_posix()
        yield f"subagent/{relative}", path


def _matches(event: dict, args: argparse.Namespace) -> bool:
    if args.kind and event.get("kind") != args.kind:
        return False
    if args.path and args.path not in str(event.get("path") or ""):
        return False
    if args.tool and event.get("tool") != _tool_name(args.tool):
        return False
    if args.run_id and event.get("run_id") != args.run_id:
        return False
    sequence = event.get("sequence")
    if args.from_sequence is not None and (not isinstance(sequence, int) or sequence < args.from_sequence):
        return False
    if args.to_sequence is not None and (not isinstance(sequence, int) or sequence > args.to_sequence):
        return False
    return True


def _read_projection(session_log: Path, args: argparse.Namespace) -> tuple[list[dict], dict, dict]:
    omissions = {
        "events_before_limit": 0,
        "output_byte_cap_unsatisfied": False,
        "output_events_dropped": 0,
        "selection_fields_truncated": 0,
        "text_truncations": 0,
        "unreadable_sources": 0,
        "subagents_excluded": not args.include_subagents,
    }
    bounds = {
        "records_read": 0,
        "malformed_lines": 0,
        "matched_events": 0,
        "truncated": False,
    }
    main_events: collections.deque[dict] = collections.deque(maxlen=args.limit)
    child_events: collections.deque[dict] = collections.deque(maxlen=args.limit)
    call_tools: collections.OrderedDict[tuple[str, str], str] = collections.OrderedDict()
    for source, path in _sources(session_log, args.include_subagents):
        try:
            handle = path.open("r", encoding="utf-8", errors="replace")
        except OSError:
            omissions["unreadable_sources"] += 1
            continue
        with handle:
            for line in handle:
                try:
                    record = json.loads(line)
                except (ValueError, UnicodeError):
                    bounds["malformed_lines"] += 1
                    continue
                if not isinstance(record, dict):
                    bounds["malformed_lines"] += 1
                    continue
                bounds["records_read"] += 1
                for event in _project(
                    record, source, args.max_text_bytes, omissions, call_tools
                ):
                    if not _matches(event, args):
                        continue
                    bounds["matched_events"] += 1
                    target = main_events if source == "main" else child_events
                    target.append(event)
    main = list(main_events)
    children = list(child_events)
    if not main:
        events = children[-args.limit :]
    elif not children:
        events = main[-args.limit :]
    else:
        main_count = min(len(main), max(1, args.limit // 2))
        child_count = min(len(children), args.limit - main_count)
        remaining = args.limit - main_count - child_count
        if remaining:
            extra_main = min(remaining, len(main) - main_count)
            main_count += extra_main
            remaining -= extra_main
        if remaining:
            child_count += min(remaining, len(children) - child_count)
        events = (main[-main_count:] if main_count else []) + (
            children[-child_count:] if child_count else []
        )
    omissions["events_before_limit"] = max(0, bounds["matched_events"] - len(events))
    bounds["truncated"] = bool(
        omissions["events_before_limit"] or omissions["text_truncations"]
    )
    return list(events), bounds, omissions


def _bounded_output(payload: dict, maximum: int) -> bytes:
    while True:
        encoded = (json.dumps(payload, sort_keys=True, separators=(",", ":")) + "\n").encode()
        if len(encoded) <= maximum:
            return encoded
        marker = "[omitted]"
        selection_truncated = False
        for key in ("session_log", "workspace", "session_id"):
            value = payload["selection"].get(key)
            if isinstance(value, str) and len(value) > len(marker):
                payload["selection"][key] = marker
                payload["omissions"]["selection_fields_truncated"] += 1
                payload["bounds"]["truncated"] = True
                selection_truncated = True
                break
        if selection_truncated:
            continue
        if not payload["events"]:
            return encoded
        main_indices = [
            index
            for index, event in enumerate(payload["events"])
            if event.get("source") == "main"
        ]
        child_indices = [
            index
            for index, event in enumerate(payload["events"])
            if event.get("source") != "main"
        ]
        if len(main_indices) <= 1 and len(child_indices) <= 1:
            compacted = False
            for event in payload["events"]:
                for key in ("run_id", "call_id", "path", "summary"):
                    value = event.get(key)
                    if isinstance(value, str) and len(value) > len(marker):
                        event[key] = marker
                        payload["omissions"]["text_truncations"] += 1
                        compacted = True
                stream = event.get("stream")
                if isinstance(stream, dict):
                    value = stream.get("id")
                    if isinstance(value, str) and len(value) > len(marker):
                        stream["id"] = marker
                        payload["omissions"]["text_truncations"] += 1
                        compacted = True
            if compacted:
                payload["bounds"]["truncated"] = True
                continue
        if len(child_indices) > len(main_indices) and len(child_indices) > 1:
            drop_index = child_indices[0]
        elif len(main_indices) > 1:
            drop_index = main_indices[0]
        elif len(child_indices) > 1:
            drop_index = child_indices[0]
        else:
            payload["omissions"]["output_byte_cap_unsatisfied"] = True
            payload["bounds"]["truncated"] = True
            return (
                json.dumps(payload, sort_keys=True, separators=(",", ":")) + "\n"
            ).encode()
        payload["events"].pop(drop_index)
        payload["omissions"]["output_events_dropped"] += 1
        payload["bounds"]["truncated"] = True


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    selector = parser.add_mutually_exclusive_group()
    selector.add_argument("--session-log")
    selector.add_argument("--session-id")
    parser.add_argument("--data-root")
    parser.add_argument("--workspace", default=os.getcwd())
    parser.add_argument("--kind")
    parser.add_argument("--path")
    parser.add_argument("--tool")
    parser.add_argument("--run-id")
    parser.add_argument("--from-sequence", type=int)
    parser.add_argument("--to-sequence", type=int)
    parser.add_argument("--limit", type=int, default=200)
    parser.add_argument("--max-text-bytes", type=int, default=2048)
    parser.add_argument("--max-output-bytes", type=int, default=131072)
    parser.add_argument("--no-subagents", dest="include_subagents", action="store_false")
    parser.set_defaults(include_subagents=True)
    return parser


def main(argv: list[str]) -> int:
    parser = _parser()
    args = parser.parse_args(argv)
    if args.limit < 1 or args.max_text_bytes < 16 or args.max_output_bytes < 1024:
        return _error("invalid_bound", "Bounds must be positive and max output must be at least 1024 bytes")
    try:
        session_log, mode = _select(args)
    except SelectionError as error:
        return _error(error.code, error.message)
    events, bounds, omissions = _read_projection(session_log, args)
    payload = {
        "schema_version": SCHEMA_VERSION,
        "status": "ok",
        "selection": {
            "mode": mode,
            "session_id": session_log.parent.name,
            "session_log": str(session_log),
            "workspace": str(_canonical(Path(args.workspace))),
        },
        "bounds": bounds,
        "omissions": omissions,
        "events": events,
    }
    sys.stdout.buffer.write(_bounded_output(payload, args.max_output_bytes))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
