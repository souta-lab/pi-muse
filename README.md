# pi-muse

A fork of [Pi](https://github.com/earendil-works/pi) that runs Meta's **Muse Code**
harness interface on top of Pi's agent loop, TUI, session, and provider layers.

## Why this exists

Meta's **Muse Spark 1.3** is widely discussed as a "benchmaxxed" model. Meta
co-trained it inside Muse Code and locks its best behavior to that harness, so the
model reaches its advertised performance mainly when it is driven by Muse Code's
system prompt and tool interface. This project is an alternative, open, hackable
harness for the same model: it keeps Pi's runtime and swaps in Muse Code's system
prompt and tool contract, so you can run Muse Spark 1.3 (Meta Model API or the
OpenCode Go gateway) without depending on Meta's closed CLI.

*(The "benchmaxxed"/lock-in framing is the maintainer's motivation, not a statement
by Meta.)*

## Status

The harness interface is captured from a live Muse Code 1.2.1 session and verified by a
traffic-interception harness that runs the real `muse` CLI and `pi-muse` side by side,
replays the same canned response to both, and diffs their outbound requests:

| | |
|---|---|
| System prompt | byte-identical (40,445 chars, sent in the `instructions` field) |
| Tool surface | **29 / 29** tools, identical order, 0 description diffs, 0 parameter diffs |
| Per-session `developer` message | byte-identical, all sections |
| Request parameters | all core checks pass (`model`, `max_output_tokens`, `store`, `stream`, `reasoning`, `include`) |
| Round trip after a tool call | weighted fidelity 100%, tool-result strings equal |

Reproduce it with `npm run muse:parity`. Not implemented: an OS sandbox, deterministic
replay, hooks/MCP/plugins.

## Muse Code fidelity

The interface was captured from a live Muse Code 1.2.1 session (`muse-spark-1.3-contributor`)
rather than reconstructed from docs: the runtime `instructions`, the `muse` namespace
tool group, and the per-session `developer` message. The captured prompt is mirrored at
https://github.com/souta-lab/muse-code-system-prompt.

| Area | Status |
|---|---|
| Runtime system prompt | Byte-identical to the capture (40,445 chars, `muse.<tool>` refs included) |
| Tool surface | 29/29 tools; 0 description diffs; 0 parameter/`strict` leaf diffs; identical order |
| `read_file`, `write_file`, `edit_file`, `search`, `bash`, `bash_input`, `read_memory`, `add_memory`, `edit_memory`, `workflow`, `write_todos`, `snooze_reminder` | Exact schemas and official descriptions |
| `read_skill`, `work_status`, `work_stop`, `web_search` | Native, official descriptions |
| `get_goal`, `create_goal`, `update_goal`, `report_progress` | Native; session-scoped goal persisted through the session log, token budget, `percent_complete=100` == complete |
| `cron_create`, `cron_delete`, `cron_list` | Native; 5-field local-time cron, session-scoped jobs, 7-day recurring expiry, a fire injects a turn |
| Per-session context (`developer` message) | Byte-identical, including `session-identity` |
| Bundled skills | 18 Muse skills extracted from the 1.2.1 binary, resolvable with `read_skill` (e.g. `bundled:taste`) |
| Tool result shapes (`read_file` line numbers, `write_file` byte count and absolute path, `bash` JSON) | Matched to the captured formats |
| `subagent_*` | Built in through `@tintinweb/pi-subagents`; all 6 registered, and `subagent_send_message` delivers via the in-process manager |
| Approvals (`--disable-approval`, `--disable-sandbox`, `--yolo`), reminders, safe resume, cross-platform PTY | Implemented |
| OS sandbox, deterministic replay, hooks/MCP/plugins | Not implemented |

### Fidelity at a glance

Measured by `npm run muse:parity`, which runs the real Muse CLI and pi-muse through the
same local proxy, replays one canned response to both, and diffs their outbound
requests. Only inherently volatile values are normalized: the workspace path, the
session id, the session-log path, and per-request ids.

| Dimension | Measured | Fidelity |
|---|---|---|
| System prompt (`instructions`) | 40,445 / 40,445 chars, byte-identical | 100% |
| Tool surface | 29 / 29 tools, 0 description diffs, 0 parameter leaf diffs | **100%** |
| Tool order | identical to the capture | 100% |
| `developer` context | byte-identical, all sections | 100% |
| Request parameters (`model`, `max_output_tokens`, `store`, `stream`, `reasoning`, `include`) | 8 / 8 core checks pass | 100% |
| Post-tool-call request (round trip) | weighted fidelity 100%, tool-result strings equal | **100%** |
| Behaviour (tool-call sequence, result strings) | equal | 100% |
| OS sandbox, deterministic replay | not implemented | — |

`workflow` implements a documented subset of Workflow API V1: `agentType`, per-call
`model`/`effort`, and worktree isolation resolve through the built-in
`@tintinweb/pi-subagents` manager, while Muse's re-entrant runner model and provider
token ceilings are not implemented.

## Testing fidelity

- **Wire parity against the real CLI** — `npm run muse:parity` starts a local
  TLS-terminating proxy, runs the real `muse` CLI and pi-muse against the same canned
  response, and diffs both outbound requests: system prompt, tool surface, tool order,
  `developer` context, request parameters, and (after a tool call) the tool-result
  strings. `npm run muse:proxy` runs the proxy on its own for manual inspection. See
  `scripts/muse-proxy/README.md`; the live captures it produced are committed under
  `scripts/muse-proxy/fixtures/`.
- `test/muse-wire-parity.test.ts` recomputes the fidelity table above from the captures
  committed in `test/fixtures/muse/` and fails if any number regresses.
- `./test.sh` runs the non-e2e suite. `test/muse-tools.test.ts`, `test/muse-goals.test.ts`,
  `test/muse-cron.test.ts`, `test/muse-subagents.test.ts`, and `test/muse-integration.test.ts`
  cover each tool family (result wording, error paths, session handling, persistence), and
  `test/muse.test.ts` covers the prompt, providers, tool order, bash sessions, and memory.
- **Live capture of pi-muse alone:** `npm run muse:capture` points pi-muse at a local
  endpoint, sends one message, and writes the outbound request body for inspection. The
  mirror of the captured Muse assets is published at
  https://github.com/souta-lab/muse-code-system-prompt.

## What is different from upstream Pi

- The CLI binary is renamed to `pi-muse` (`packages/coding-agent/package.json`, `bin`).
- The captured Muse Code prompt is the default system prompt for **every session** (CLI
  and SDK), independent of provider and model; `--system-prompt` or a `.pi/SYSTEM.md`
  file can still override it.
- The model sees Muse Code's full tool set (**29 tools, in Muse's captured order**):
  `workflow`, `read_file`, `search`, `write_file`, `edit_file`, `read_memory`,
  `add_memory`, `edit_memory`, `work_stop`, `web_search`, `bash`, `bash_input`,
  `cron_create`, `cron_delete`, `cron_list`, `get_goal`, `create_goal`, `update_goal`,
  `report_progress`, `subagent_spawn`, `subagent_status`, `subagent_send_message`,
  `subagent_wait`, `subagent_read_result`, `subagent_cancel`, `read_skill`, `work_status`,
  `snooze_reminder`, `write_todos`. The six `subagent_*` tools and the four goal tools and
  three cron tools are registered by built-in extensions.
  - `workflow` runs a deterministic JavaScript module in a worker, with `host.agent`,
    `parallel`, `pipeline`, `log`, `phase`, `args`, and `budget`; scripts are persisted
    under `.pi/muse-workflows/` with a `sha256` `scriptHash`, and `resumeFromRunId`
    replays the unchanged completed child-call prefix.
  - `get_goal`/`create_goal`/`update_goal`/`report_progress` keep a session-scoped goal
    (objective, status, token budget, progress) persisted through the session log;
    `percent_complete=100` is equivalent to completing the goal.
  - `cron_create`/`cron_delete`/`cron_list` schedule prompts with a 5-field local-time
    cron; jobs are session-scoped, recurring jobs expire after seven days, and a fire
    injects a turn.
  - `edit_file` takes `{path, find, replace}` and replaces only on a unique exact match.
  - `bash` takes `yield_time_ms` and runs the command in a real PTY (Linux via `script`,
    macOS via BSD `script`, Windows via `winpty` when present); a command still running
    after the wait becomes a managed background session. `bash_input` sends stdin,
    snapshots, or terminates it.
  - When a background session finishes, its result is delivered back to the agent as a
    follow-up message and wakes it (while a session is active; `-p`/headless exits once
    the agent is idle).
  - `read_file` defaults to 500 lines. Memory tools store Markdown under
    `~/.pi/agent/memory`. `web_search` uses Exa or Brave via `EXA_API_KEY` /
    `BRAVE_API_KEY`.
- Approvals are launch-time and immutable: `--disable-approval` (never prompt),
  `--disable-sandbox`, and `--yolo` (both plus workspace trust). A mutating tool call is
  denied when approval is required and no interactive UI is available.
- Resuming a session repairs a tool call that was interrupted mid-run and reports it
  instead of auto-continuing.
- Built-in providers: `muse` (Meta Model API, Responses API) and `opencode-go` (OpenCode
  Go gateway, which additionally requires the `x-opencode-session` header this provider
  sets for you).
- Only the cheaper Contributor tier models are registered, and `pi-muse` defaults to
  `muse-spark-1.3-contributor` when no model is chosen.
- The Muse harness is provider-agnostic: any model runs under the same prompt and tool
  set, and this is the default for every session rather than an opt-in mode.
- Pi's standard tools (`read`, `write`, `edit`, `grep`, `find`) stay in the registry but
  are not exposed by default.

## Quick start

```bash
npm install --ignore-scripts
npm run build

# Meta Model API
export META_API_KEY=...
pi-muse --provider muse --model muse-spark-1.3-contributor

# or OpenCode Go
export OPENCODE_GO_API_KEY=...
pi-muse --provider opencode-go --model muse-spark-1.3-contributor
```

Install the binary first with `npm link -w @earendil-works/pi-coding-agent`, or run
the bundled CLI directly with
`node packages/coding-agent/dist/bundle/cli.js --provider muse --model muse-spark-1.3-contributor`.

Approval is fixed at launch: `--disable-approval` never prompts, `--disable-sandbox`
marks the sandbox off, and `--yolo` implies both plus workspace trust. Without a bypass,
a mutating tool call is denied in a session that has no interactive UI. A tool call that
was interrupted mid-run is reported when the session is resumed instead of being
silently continued.

Verify the harness against the real CLI at any time:

```bash
npm run muse:parity                                          # first request + parameters
node scripts/muse-proxy/run-parity.mjs --fixture tool-call    # adds the round trip
```

## License and attribution

- The code is **MIT**, inherited from upstream Pi (`LICENSE`, Copyright (c) 2025
  Mario Zechner) plus this fork's contributions.
- The following **captured Muse Code content** is third-party material, is **not**
  covered by the MIT license, and remains the property of Meta. It is included only for
  interoperability and research; remove or replace it if you are a rights holder or do
  not want it:
  - `packages/coding-agent/src/core/muse-system-prompt.ts` — Muse Code's system prompt,
    captured from a live Muse Code session. Replace it with a custom `~/.pi/SYSTEM.md`
    if you would rather not ship it.
  - `packages/coding-agent/src/core/muse-skills/**` — the 18 bundled skill bodies,
    extracted from the distributed Muse Code 1.2.1 binary.
  - `packages/coding-agent/test/fixtures/muse/**` and `scripts/muse-proxy/fixtures/**` —
    captured Requests, tool schemas, and the developer message, used as test fixtures.
  Captured copy: https://github.com/souta-lab/muse-code-system-prompt

---

<p align="center">
  <a href="https://pi.dev">
    <img alt="pi logo" src="https://pi.dev/logo-auto.svg" width="128">
  </a>
</p>
<p align="center">
  <a href="https://discord.com/invite/3cU7Bz4UPx"><img alt="Discord" src="https://img.shields.io/badge/discord-community-5865F2?style=flat-square&logo=discord&logoColor=white" /></a>
  <a href="https://www.npmjs.com/package/@earendil-works/pi-coding-agent"><img alt="npm" src="https://img.shields.io/npm/v/@earendil-works/pi-coding-agent?style=flat-square" /></a>
</p>

> New issues and PRs from new contributors are auto-closed by default. Maintainers review auto-closed issues daily. See [CONTRIBUTING.md](CONTRIBUTING.md).

# Pi Agent Harness

This is the home of the Pi agent harness project including our self extensible coding agent.

* **[@earendil-works/pi-coding-agent](packages/coding-agent)**: Interactive coding agent CLI
* **[@earendil-works/pi-agent-core](packages/agent)**: Agent runtime with tool calling and state management
* **[@earendil-works/pi-ai](packages/ai)**: Unified multi-provider LLM API (OpenAI, Anthropic, Google, …)

To learn more about Pi:

* [Visit pi.dev](https://pi.dev), the project website with demos
* [Read the documentation](https://pi.dev/docs/latest), but you can also ask the agent to explain itself

## All Packages

| Package | Description |
|---------|-------------|
| **[@earendil-works/chord](packages/chord)** | Standalone application-composition runtime for services, replicated state, RPC, and plugins |
| **[@earendil-works/pi-telemetry](packages/telemetry)** | Vendor-neutral telemetry contracts, reference adapter, conformance tests, and typed schemas |
| **[@earendil-works/pi-ai](packages/ai)** | Unified multi-provider LLM API (OpenAI, Anthropic, Google, etc.) |
| **[@earendil-works/pi-agent-core](packages/agent)** | Agent runtime with tool calling and state management |
| **[@earendil-works/pi-coding-agent](packages/coding-agent)** | Interactive coding agent CLI |
| **[@earendil-works/pi-tui](packages/tui)** | Terminal UI library with differential rendering |

For Slack/chat automation and workflows see [earendil-works/pi-chat](https://github.com/earendil-works/pi-chat).

## Permissions & Containerization

Pi does not include a built-in permission system for restricting filesystem, process, network, or credential access. By default, it runs with the permissions of the user and process that launched it.

If you need stronger boundaries, containerize or sandbox Pi. See [packages/coding-agent/docs/containerization.md](packages/coding-agent/docs/containerization.md) for three patterns:

- **Gondolin extension**: keep `pi` and provider auth on the host while routing built-in tools and `!` commands into a local Linux micro-VM.
- **Plain Docker**: run the whole `pi` process in a local container for simple isolation.
- **OpenShell**: run the whole `pi` process in a policy-controlled sandbox.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines and [AGENTS.md](AGENTS.md) for project-specific rules (for both humans and agents).  Longer term plans for Pi can also be found in [RFCs](https://rfc.earendil.com/keyword/pi/).

## Development

```bash
npm install --ignore-scripts  # Install all dependencies without running lifecycle scripts
npm run build         # Refresh model data, then build all packages
npm run build:offline # Rebuild using existing model data without network access
npm run check         # Lint, format, and type check
./test.sh            # Run tests (skips LLM-dependent tests without API keys)
./pi-test.sh         # Run pi from sources (can be run from any directory)
```

## Building standalone binaries from release source

GitHub releases include a versioned source archive covered by the release's `SHA256SUMS` file. Extract it and run the same build script used for the official standalone binaries:

```bash
VERSION="<release-version>"
tar -xzf "pi-${VERSION}-source.tar.gz"
cd "pi-${VERSION}"
./scripts/build-binaries.sh --offline-model-data --platform linux-x64 --out "$PWD/out"
```

The archive includes release model data and native prebuilds. `--offline-model-data` uses that model data without refreshing provider catalogs. The script installs dependencies and builds the executable with its runtime assets; pass `--skip-install` if dependencies are already provided.

## Supply-chain hardening

We treat npm dependency changes as reviewed code changes.

- Direct external dependencies are pinned to exact versions. Internal workspace packages remain version-ranged.
- `.npmrc` sets `save-exact=true` and `min-release-age=2` to avoid same-day dependency releases during npm resolution.
- `package-lock.json` is the dependency ground truth. Pre-commit blocks accidental lockfile commits unless `PI_ALLOW_LOCKFILE_CHANGE=1` is set.
- `npm run check` verifies pinned direct deps, native TypeScript import compatibility, and the generated coding-agent shrinkwrap.
- The published CLI package includes `packages/coding-agent/npm-shrinkwrap.json`, generated from the root lockfile, to pin transitive deps for npm users.
- Release smoke tests use `npm run release:local` to build, pack, and create isolated npm and Bun installs outside the repo before tagging a release.
- Local release installs, documented npm installs, and `pi update --self` use `--ignore-scripts` where supported.
- CI installs with `npm ci --ignore-scripts`, and a scheduled GitHub workflow runs `npm audit --omit=dev` plus `npm audit signatures --omit=dev`.
- Shrinkwrap generation has an explicit allowlist for dependency lifecycle scripts; new lifecycle-script deps fail checks until reviewed.

## Share your OSS coding agent sessions

If you use Pi or other coding agents for open source work, please share your sessions.

Public OSS session data helps improve coding agents with real-world tasks, tool use, failures, and fixes instead of toy benchmarks.

For the full explanation, see [this post on X](https://x.com/badlogicgames/status/2037811643774652911).

To publish sessions, use [`badlogic/pi-share-hf`](https://github.com/badlogic/pi-share-hf). Read its README.md for setup instructions. All you need is a Hugging Face account, the Hugging Face CLI, and `pi-share-hf`.

You can also watch [this video](https://x.com/badlogicgames/status/2041151967695634619), where I show how I publish my `pi-mono` sessions.

I regularly publish my own `pi-mono` work sessions here:

- [badlogicgames/pi-mono on Hugging Face](https://huggingface.co/datasets/badlogicgames/pi-mono)

## License

MIT

<p align="center">
  <a href="https://pi.dev">pi.dev</a> domain graciously donated by
  <br /><br />
  <a href="https://exe.dev"><img src="packages/coding-agent/docs/images/exy.png" alt="Exy mascot" width="48" /><br />exe.dev</a>
</p>
