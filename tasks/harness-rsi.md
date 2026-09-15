---
title: Harness RSI - recursive self-improvement until pi-muse explicitly declares Muse parity
description: Managed long-running task. The driver scripts/harness-rsi.mjs runs the traffic-interception parity harness (scripts/muse-proxy/run-parity.mjs), turns each run's diff-summary.json into an ordered gap list, and invokes pi-muse to fix its own source until the gap list is empty. Termination is always explicit via HARNESS_RSI_DECLARATION.json at the repo root; the process never exits silently and never declares complete while any gap remains.
status: active
owner: pi-muse
---

# Harness RSI

Recursive self-improvement driver for the Muse parity harness. It closes the gap
between pi-muse's outbound Responses API request and the real `muse` CLI as
measured by `scripts/muse-proxy/run-parity.mjs`.

## Goal

Reach zero-diff parity, measured by the harness, for a given fixture (default
`tool-call`):

- every core check passes (`model`, `max_output_tokens`, `store`, `stream`,
  `reasoning`, `include`, `input item count`, `no invented tools`),
- zero differing leaves after normalization (`differences` is empty and
  `leafScore` is 1 for every compared pair),
- the tool set matches exactly: 29/29 tools, identical per-tool schemas.

The driver improves **pi-muse itself**: when gaps remain it spawns
`pi-muse --yolo -p "<gap list + fix instructions + previous attempt diff>"` with
the repo as cwd, then re-runs the focused Muse test suites, then loops.

## Running

```bash
# full loop, up to 8 iterations, fixture tool-call
node scripts/harness-rsi.mjs

# inspect the gap list only; makes no edits
node scripts/harness-rsi.mjs --dry-run

# machine-readable result
node scripts/harness-rsi.mjs --json

# tune the loop
node scripts/harness-rsi.mjs --max-iterations 3 --fixture text-completion
```

CLI: `--max-iterations <n>` (default 8), `--fixture <name>` (default
`tool-call`), `--dry-run`, `--json`, `--repo-root`, `--declaration`,
`--captures-dir`, `--iterations-dir`, `--pi-bin`, `--parity-timeout-ms`,
`--pi-timeout-ms`, `--test-timeout-ms`, `--test-filter`.

Exit codes: `0` complete, `2` blocked (declared), `1` internal error. In every
case `HARNESS_RSI_DECLARATION.json` is written first. If the declaration cannot
be written, the driver reports failure with exit code 1 rather than pretending
to succeed.

## Acceptance criteria

1. `verdict: PASS` from `node scripts/muse-proxy/run-parity.mjs --fixture tool-call`.
2. All core checks pass on every compared pair.
3. 0 differing leaves (`differences` empty, `leafScore` 1).
4. 29/29 tools with identical schemas (no tool missing on either side, no
   shared tool below 100% schema similarity).
5. `HARNESS_RSI_DECLARATION.json` exists at the repo root with
   `status: "complete"` and empty `gaps` / `remainingGaps`.

The driver derives completeness only from the fresh capture of its own run. It
never reuses a stale capture: the capture directory must be new since the
invocation started, its `manifest.runId` must match the directory name, its
`manifest.startedAt` must not predate the invocation, and its
`diff-summary.json` mtime must not predate the invocation.

## Hard rules

- **Termination is explicit.** The process may only exit after writing
  `HARNESS_RSI_DECLARATION.json`. An iteration cap, a pi-muse spawn failure, or
  any internal error writes `status: "blocked"` with the remaining gaps, the
  blocker, and the iteration history. There is no silent exit.
- **Never declare complete with a gap.** `status: "complete"` requires an empty
  gap list, enforced by a declaration invariant that flips any violation to
  `blocked`/exit 1.
- **Never reuse a stale capture.** Freshness is proven as described above;
  otherwise the run is refused (exit 1) after writing a blocked declaration.
- **Dry-run makes no edits.** `--dry-run` computes and prints the gap list and
  writes a blocked declaration with `reason: "dry-run"`.

## Guard rails

- No-progress guard: if the gap list is byte-identical to the previous
  iteration, the next prompt is escalated with the previous attempt's
  `git diff` and an explicit "the same approach failed; do not repeat it".
- Focused tests: Muse suites (`vitest --run muse` from `packages/coding-agent`)
  are re-run after each pi-muse attempt and recorded in the declaration.
- Write scope: the driver writes only the declaration at the repo root, the
  capture root under `/tmp/opencode/muse-proxy-captures`, and per-iteration logs
  under `/tmp/opencode/harness-rsi/<runId>`.
- The spawned fixer is instructed not to modify `scripts/muse-proxy/**`,
  `package.json`, or `README.md`, and not to run `git stash`,
  `git checkout .`, or `git clean -fd`.
- The already-PASS baseline means a healthy run of the driver should complete on
  iteration 1 with zero gaps; a `blocked` result means a regression or an
  unprovable capture, not silent success.

## Evidence

`HARNESS_RSI_DECLARATION.json` records `paritySummaryPath`, per-iteration log
paths, focused test results, the iteration history, and the full gap list.
