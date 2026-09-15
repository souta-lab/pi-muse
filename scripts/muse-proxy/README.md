# Muse traffic-interception parity harness

A local, TLS-terminating HTTP `CONNECT` proxy that captures the exact Responses-API
requests produced by the **real Muse Code CLI** and by **pi-muse**, replays canned
Responses streams so no model/network is needed, and diffs the two requests.

Nothing outside this directory and `/tmp/opencode` is written. The proxy does **not**
install a CA into the system store, does not touch `/etc/hosts`, and does not touch
`/etc/resolv.conf` — clients are redirected purely with environment variables and a
per-run `settings.json`, and every write path is guarded in code
(`assertAllowedPath` in `lib.mjs`).

```
scripts/muse-proxy/
  certs.mjs          create/reuse a local CA + combined ca-bundle.pem (system roots + our CA)
  mitm.mjs           CONNECT + direct-TLS MITM proxy; --replay or --forward
  diff-requests.mjs  normalize two captures, structural + textual diff, fidelity score
  run-parity.mjs     orchestrator: run both clients, capture both, diff, verdict
  lib.mjs            shared helpers (path guard, openssl cert minting, SSE)
  fixtures/
    text-completion.json  one plain text completion
    tool-call.json        write_file tool call, then a final text turn
    muse-catalog.json     canned /muse-code/models response (the real CLI requires it)
```

## How interception works

| | real `muse` CLI | pi-muse |
|---|---|---|
| transport | `CONNECT` through `HTTPS_PROXY` | direct TLS to a `models.json` baseUrl |
| proxy listener | plain HTTP `proxyPort` | TLS `tlsPort` |
| endpoint | `https://api.meta.ai/v1/responses` | `https://127.0.0.1:<tlsPort>/v1/responses` |
| CA injection | `settings.endpoint_transport.ca_bundle` | `NODE_EXTRA_CA_CERTS` |
| token | copied `~/.config/muse/auth.json` (or `META_API_KEY`) | `apiKey` in the throwaway `models.json` |

`SSL_CERT_FILE` is **not** honored by the real binary on its model-catalog transport
(verified: `tlsv1 alert unknown ca`), and it reads only the first certificate in a PEM
file. The working knob is `settings.endpoint_transport.ca_bundle`; that field is
validated together with an mTLS identity, so a `client_cert`/`client_key` pair must be
present too (the MITM endpoint never requests one). `certs.mjs` still emits the combined
`ca-bundle.pem` because it is the right artifact for `NODE_EXTRA_CA_CERTS` and for any
other client that reads `SSL_CERT_FILE`.

The real CLI also fetches `https://api.meta.ai/muse-code/models` before its first model
call and fails if that fetch does not succeed. Replay mode therefore serves
`fixtures/muse-catalog.json` for `/muse-code/models`.

Muse additionally fires **reminder-observer** model calls that embed the main
conversation inside a different prompt. The proxy advances the fixture turn only for
main-agent requests, and the turn counter is keyed per listener channel, so the two
clients never steal each other's turns.

## Running

```bash
# one-time (or whenever you want to rotate): create CA + bundle
node scripts/muse-proxy/certs.mjs            # prints ca-bundle.pem path; --json for machine output

# replay parity, text fixture
npm run muse:parity -- --fixture text-completion

# replay parity, tool-call fixture (first request + post-tool-call request are both compared)
npm run muse:parity -- --fixture tool-call

# standalone proxy (replay a fixture, no orchestrator)
npm run muse:proxy -- --replay scripts/muse-proxy/fixtures/tool-call.json \
  --catalog scripts/muse-proxy/fixtures/muse-catalog.json --log-dir /tmp/opencode/muse-proxy-logs

# live forward against the OpenCode Go gateway (needs OPENCODE_GO_API_KEY)
OPENCODE_GO_API_KEY=... npm run muse:parity -- --live --fixture text-completion

# diff two captures directly
node scripts/muse-proxy/diff-requests.mjs a.json b.json --cwd /path/to/workspace
node scripts/muse-proxy/diff-requests.mjs requests.ndjson requests.ndjson --a-index 0 --b-index 2
```

Useful flags: `--only muse|pi|both`, `--keep` (keep the scratch dir), `--json`,
`--min-fidelity <0..1>`, `--max-diff-lines <n>`, `--muse-bin <path>`,
`--ssl-cert-file <path>`, `--pi-extra-arg <arg>`.

The scratch directory is `/tmp/opencode/muse-parity-<ts>/`; logs are
`logs/requests.ndjson` and `logs/responses.ndjson`. Credential-shaped headers are
redacted before anything is written to disk.

## What gets normalized (and why)

`diff-requests.mjs` compares the **body** for the fidelity score and reports headers
separately (the two clients use different HTTP stacks — Rust `hyper` vs the Stainless
OpenAI SDK — so header names such as `x-stainless-*`, `accept`, `host`, `user-agent`
can never match and would only distort the score).

Dropped/blanked before scoring:

| field | reason |
|---|---|
| `prompt_cache_key` | per-process cache key, never reproducible |
| `id`, `item_id`, `call_id`, `response_id`, `request_id`, `session_id`, … | generated per request; both sides blanked the same way so links still compare |
| `timestamp`, `created_at`, `recorded_at`, `expires_at`, `sequence_number` | wall-clock/sequence values |
| workspace root / `cwd` / `workspaceRoot` | environment-specific path → `<cwd>` |
| `/home/<user>` | environment-specific → `<home>` |
| UUIDs, `msg_…`/`resp_…`/`fc_…`/`call_…` id runs, ULIDs | generated identifiers → `<uuid>` / `<id>` |
| `required` arrays | sorted (a set, not an ordered list) |
| tool declaration order | tools (including a `namespace` group's inner tools) sorted by name |
| volatile headers (`authorization`, cookies, `x-opencode-session`, `traceparent`, `host`, `content-length`, `user-agent`, …) | secrets / per-process / client-stack values |

Everything else — `instructions` text, developer context, tool schemas, tool results,
and request parameters — is compared verbatim.

### Score

- **weighted fidelity** (primary): section scores combined with weights
  `params 0.20`, `instructions 0.20`, `input.developer 0.15`, `input.user 0.15`,
  `input.toolResult 0.05`, `input.other 0.05`, `tools 0.25`.
- **tools (per-tool avg)**: each tool name's full schema is compared as leaves and
  averaged over the union of tool names; a tool missing on one side scores 0.
- **strict-leaf**: raw matched/total normalized leaves. Kept for reference; it is
  dominated by verbose JSON-Schema leaves, so one wrong keyword in one tool can drown
  out otherwise-identical tools.
- `verdict = PASS` when both clients were intercepted and every compared pair's
  weighted fidelity is `>= --min-fidelity` (default 0.75). The `core checks` block
  (`model`, `max_output_tokens`, `store`, `stream`, `reasoning`, `include`,
  `input item count`, `no invented tools`) is reported for diagnosis.

## Current measured result

Machines used: real `muse-bin-1.2.1-R2847.1`, pi-muse runner `tsx cli.ts`
(`packages/coding-agent/src/cli.ts`, i.e. the working tree). The harness prefers the
source runner and falls back to the documented bundle
(`packages/coding-agent/dist/bundle/cli.js`) if concurrent `src/` edits break it; the
runner actually used is logged and included in the `--json` summary.

Replay, `--fixture tool-call` (`node scripts/muse-proxy/run-parity.mjs --fixture tool-call`):

| request | weighted | strict-leaf | tools (per-tool) | instructions | params |
|---|---|---|---|---|---|
| first request | **53.83%** | 18.05% | 50.00% | 100% | 85.71% |
| post-tool-call request | **61.25%** | 18.75% | 50.00% | 100% | 85.71% |

Replay, `--fixture text-completion`: first request **51%–54%** weighted / ~18% strict /
~50% tools. (The tree is under active edit; re-run to refresh.)

Behavioural surface for the tool fixture:

- tool-call sequence: **identical** — both send
  `muse.write_file({"path":"parity.txt","content":"hello from the parity harness\n"})`
- tool-result strings: differ only by path qualification —
  `wrote 30 bytes to <workspace>/parity.txt` (real) vs `wrote 30 bytes to parity.txt` (pi-muse)

Named gaps driving the score, all visible in the per-section report:

- real Muse exposes **29** namespace tools, pi-muse **22** (7 missing: `create_goal`,
  `get_goal`, `update_goal`, `report_progress`, `cron_create`, `cron_delete`,
  `cron_list`). The six `subagent_*` tools exist but use reduced schemas
  (`subagent_wait` 30%, `subagent_spawn` 31%).
- schema keywords differ on shared tools (`enum` + `additionalProperties` + `strict`
  on the real side vs `anyOf` / omitted in pi-muse), giving ~50% per-tool schema match.
- `max_output_tokens`: real reads the live catalog (`128000`) vs pi-muse `32768` — the
  only failing core check on the post-tool request.
- message content transport: real sends a plain string, pi-muse an array of
  `input_text` parts, and pi-muse adds an extra skill-catalog `user` item. This is why
  `input.developer` (33%) / `input.user` (12–20%) score low even though the text is the
  same.

These are measurements, not necessarily regressions: the real client advertises a newer
surface than the committed `test/fixtures/muse/REQUEST_SHAPE.json` capture (29 vs 22
tools), which is exactly what this harness is for.

## Crediting / data note

`fixtures/muse-catalog.json` is the live `/muse-code/models` response for
`muse-spark-1.3-contributor`, captured the same way the repository captured the system
prompt and tool schemas. It lives only in this harness.
