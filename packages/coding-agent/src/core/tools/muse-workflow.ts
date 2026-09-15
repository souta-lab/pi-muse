/**
 * Muse `workflow` tool — a deterministic JavaScript orchestration tool.
 *
 * The tool persists a workflow module under `<cwd>/.pi/muse-workflows/<runId>.mjs`
 * and executes it in a `node:worker_threads` worker. The worker only owns the
 * script; every child agent call travels back to this process over the worker
 * message channel, so children are real sessions started by the configured
 * runner (by default the in-process SDK `AgentSession` path). The community
 * pi-subagents RPC bus is not reachable from a `ToolDefinition` because
 * `ExtensionContext` exposes no event bus, so the SDK path is the built-in
 * runner.
 *
 * Official Workflow API V1 surface — implemented:
 *   - Tool parameters `script`, `scriptPath`, `resumeFromRunId`, `args`,
 *     `expectedScriptHash`, `name` (display-only when a source is given), and
 *     `description`/`title` (accepted, not executed).
 *   - Both documented script shapes: `export default async function
 *     workflow(host)` modules, and the CC-style bare-globals body (wrapped into
 *     a module function at execution time, where `return`, `agent`, `parallel`,
 *     `pipeline`, `log`, `phase`, `args`, and `budget` are in scope).
 *   - Persistence of every inline script plus `scriptHash` (`sha256:<64
 *     lowercase hex>` over the script bytes) echoed in the tool result, and
 *     `scriptPath` as an explicit in-workspace persistence target.
 *   - `expectedScriptHash`: canonical-shape validation during input
 *     normalization and byte comparison before the script is persisted or any
 *     child work starts.
 *   - `resumeFromRunId`: same-session script reuse plus replay of the longest
 *     unchanged completed child-call prefix (journal kept in memory and in
 *     `<workflowDir>/<runId>.journal.json`; any script byte change drops it).
 *   - Host API: `agent()` (request object plus positional `agent("prompt", {})`),
 *     `parallel([...])` (request objects and thunks), `pipeline(items,
 *     ...stages)`, `log()`, `phase()`, deep-frozen `args`, frozen `budget`,
 *     plus `cwd`/`runId` provenance.
 *   - V1 runner bounds: 16 concurrent children, 1000 total agent/pipeline/
 *     parallel item calls, 512 progress markers, and a whole-run plus per-child
 *     wall-clock timeout that bounds a runaway script.
 *   - Structured `not_admitted` results once the call cap is reached, and
 *     child-runner failures resolved as ordinary results with `error_kind`.
 *   - Inline JSON-schema validation of child results: `schema` is checked
 *     against the closed type/enum/required/properties/items subset with
 *     4 KiB, depth-16, and 16-entry bounds before the child launches, and a
 *     malformed schema resolves that slot with `error_kind: "invalid_schema"`.
 *     An admitted result whose `data` violates the schema records
 *     `schema_invalid` and resolves to `null` at the script boundary, matching
 *     the V1 "third rejection" terminal behavior (this runner does not re-prompt
 *     for corrected calls, so the first failed validation is terminal).
 *   - `phase()` progress grouping: markers are grouped by title into
 *     `details.phaseGroups`, and an optional per-call `phase` on
 *     agent/pipeline/parallel requests assigns that call to a group without
 *     racing the global `phase()` state.
 *   - `isolation` worktree isolation: when the child runs through the
 *     in-process pi-subagents runner published at
 *     `Symbol.for("pi-muse:subagent-runner")`, an affirmative isolation request
 *     is forwarded to `spawnAndWait` as `isolation: "worktree"`. When the
 *     fallback SDK runner is used (no pi-subagents), the tool creates a detached
 *     `git worktree` under a temp root itself; a clean or ignored-only worktree
 *     is removed after the child settles, while tracked changes, non-ignored
 *     untracked files, or a changed HEAD retain it and the outcome is reported
 *     as `result.isolation`. A missing git binary / non-git workspace resolves
 *     with `error_kind: "isolation_unavailable"`, and every other isolation
 *     shape resolves with `error_kind: "invalid_isolation"`.
 *   - Per-call `model`/`effort`: forwarded to the selected runner. The
 *     in-process pi-subagents runner resolves a model id against
 *     `ctx.modelRegistry` and passes the mapped `thinkingLevel`; the SDK
 *     fallback applies them through `resolveChildLaunchOptions` (model resolved
 *     by id against the parent route/registry, `effort` mapped to the thinking
 *     level); an unresolvable model resolves with `error_kind:
 *     "model_not_found"`. The parent route (model + thinking level) is passed to
 *     the runner for inheritance.
 *   - `agentType` Agent Definition resolution: the request's `agentType`
 *     (default `general-purpose`) is forwarded as the pi-subagents `type`, so
 *     pi-subagents resolves the Agent Definition (embedded defaults plus user
 *     agents under `.pi/agents`, `.agents/agents`, and the global agents dir)
 *     and applies its prompt and tools. With the SDK fallback the field is inert
 *     and the child uses the built-in identity.
 *   - In-process child runner: when muse-subagents has reached pi-subagents
 *     (`spawnAndWait` present in the manager registry) it publishes a runner at
 *     `Symbol.for("pi-muse:subagent-runner")`; the tool reads that symbol (no
 *     import cycle), prefers it over the SDK runner, and clamps its concurrency
 *     to the manager's `maxConcurrent()` when that reports a positive limit.
 *     When the symbol is absent the SDK runner is used unchanged.
 *   - Name-only saved-workflow lookup: with no `script`/`scriptPath`/
 *     `resumeFromRunId`, `name` resolves a module in the project
 *     `.agents`/`.codex`/`.claude` workflows directories or the user config
 *     `workflows` directory; an unknown name fails with the discovered names.
 *     The pi-muse convention is `<dir>/<name>.mjs` (then `<name>.js`); the
 *     directory list is overridable through `workflowRegistryDirs` for tests.
 *
 * Official Workflow API V1 surface — deferred (explicitly not implemented):
 *   - Muse's re-execute-the-module-as-child-results-arrive runner model; this
 *     tool executes the module once and recovers via the journaled prefix. The
 *     re-entrant runner lives in Muse's Workflow owner process behind the same
 *     RPC bus; `worker_threads` can only run a module to completion once, so
 *     faithful re-execution needs that owner-side coordinator.
 *   - Provider reliability policy, token ceilings, and retained-session or
 *     workspace prerequisites beyond the runner bounds listed above.
 *     `host.budget.total` is wired from `runWorkflowWorker`'s `budgetTotal`,
 *     which is hard-coded to `null`; `Settings`/`SettingsManager`
 *     (src/core/settings-manager.ts) has no workflow token-ceiling field (only
 *     `thinkingBudgets`), and adding one would require editing that file, so
 *     there is no user-configured ceiling to plumb.
 *
 * The per-run `workflow-choice` / `workflow-cookbook` policy reminders are
 * injected by the orchestrator's system prompt, not by this tool.
 */

import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import type { AgentToolUpdateCallback, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { type Static, type TSchema, Type } from "typebox";
import { Value } from "typebox/value";
import { getAgentDir } from "../../config.ts";
import type { InProcessChildRunner, InProcessChildRunRequest } from "../../extensions/muse-subagents.ts";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import type { ModelRegistry } from "../model-registry.ts";
import { createAgentSession } from "../sdk.ts";
import { SessionManager } from "../session-manager.ts";

const WORKFLOW_TOOL_DESCRIPTION =
	'Use this to orchestrate multi-agent work with a deterministic JavaScript workflow. Follow the current workflow availability context to decide whether to launch, propose, or abstain; this static tool description does not override that per-run policy. For a new run, provide an inline `script` as a JavaScript module such as `export default async function workflow(host) { return await host.agent({ input: "review the change" }); }`; the runtime persists it and returns an editable `scriptPath`. To repair a recoverable run, inspect or edit that file and call workflow with `scriptPath` plus the same-session `resumeFromRunId`. When both source fields are present, inline `script` is the content and `scriptPath` is its persistence target. Set unused optional fields to null or omit them; whitespace-only `scriptPath` and `resumeFromRunId` are normalized to absence (an inline `script` must be non-empty). Put repo discovery in a child agent inside the workflow script when decomposition is selected. `agentType` is optional: omit it or pass null/undefined to use the built-in `workflow-subagent` identity and current default launch; if supplied, use a #7546 canonical rendered Agent Definition id of at most 385 UTF-8 bytes (plugin-scoped ids included; its unscoped or final definition name is at most 128 UTF-8 bytes). An explicit `agentType` selects that registered Agent Definition; its prompt is appended as one developer context block, and its `tools`/`disallowedTools` may only narrow the inherited Work-tool grant. Definition-carried model and effort remain inert; per-call `model`/`effort` options or parent inheritance control execution. Prefer omitting `model` so children inherit the parent route; specify it only when a child task clearly needs a different capability or cost tier, and remember a weaker model\'s output flows back into the parent\'s synthesis. Every child inherits the parent session\'s current effective Work tools as its upper bound (write tools included when the session has them). Choose isolation (true or an empty object) when the user requests subagent isolation or when parallel children may write, because concurrent writers can corrupt a shared checkout even when their intended files differ. Keep read-only children in the shared checkout. An affirmative isolation request may reject when capability, provider, retained-session, workspace, or Git prerequisites are unavailable. The runtime automatically removes a clean or ignored-only isolated worktree after the child reaches its terminal and becomes quiescent. It retains a worktree with tracked changes, non-ignored untracked files, or a changed HEAD. Per-call `tools` is unsupported and must be omitted. Explicit user opt-outs always win, and genuinely atomic quick checks, one-file typo fixes, short explanations, or direct small edits stay in one turn. Size guideline: keep one workflow under 15 child agents in total unless the request itself calls for a different scale; this is a guideline, not a runtime limit. Size the fan-out to the work list actually in scope (files, claims, items), not to the wording of the request. Orchestration quality: agent and pipeline run the same kind of child (the name changes only labels), and a batch array goes only to parallel([...]) - agent and pipeline take one request object with input, agentType, schema, isolation, and label; the same fields are available on every parallel([...]) request object. agent also accepts the positional agent("prompt", { agentType, schema, isolation, label }) form. parallel([...]) accepts request objects and always resolves to an array of results in input order, including a one-entry batch; a single agent or pipeline call resolves to one result object. pipeline(items, ...stages) runs each stage function as (prev, item, index) per item and drops an item to null for later stages when its stage throws. Design flow, not call names: the runner keeps at most 16 child agents active at once and queues additional calls, and one workflow may make up to 1000 total agent/pipeline/parallel item calls. Plain Promise.all over individual agent()/pipeline() calls and thunk-array parallel batches are for at most 16 pending calls; for wider same-kind work, use one parallel(items.map(...)) request array. The runner re-executes the module as child results arrive, so per-item chains can continue without waiting for every sibling; open later calls only when their inputs interpolate an earlier result\'s ref, summary, text, or data, or an earlier result gates whether the call runs at all. Inline schemas use the closed type, enum, required, properties, and items subset with 4 KiB, depth-16, and 16-entry bounds; any unsupported keyword or invalid shape rejects before child launch. At submission, type and enum constraints are enforced recursively. Validation permits two corrected calls in the same child run; for an inline schema, the third rejection records terminal "schema_invalid" internally and resolves to null at the V1 call boundary. Check result === null before reading result.error_kind or result.data. Admitted child failures remain ordinary child results with result.error_kind; they never throw, so try/catch cannot see them - branch on error_kind. Inline-schema validation exhaustion is the exception because it resolves to null rather than a child-result object. A zero-attempt capacity-one outcome resolves with result.kind === "not_admitted" and result.error.code; it has no ref or error_kind. A not_admitted result is truthy; never use .filter(Boolean) as an admitted-result filter. A child has no owner-side wall-clock lifetime deadline; typed provider stalls may retry under reliability policy, while token budgets and explicit cancellation remain its runtime bounds. Each non-null admitted result includes ref, summary, text (at most 32768 characters), optional model-authored result.notes, error_kind, and data. Selector failures resolve only that slot with result.error_kind set to one of "agent_definition_not_found", "agent_definition_ambiguous", "agent_definition_invalid", "agent_definition_unavailable", "agent_definition_policy_denied", or "agent_definition_lookup_expectation_mismatch"; valid siblings run and the workflow continues. End with any JSON-serializable terminal value; prefer a small object with status plus refs/summaries/text for the parent. Legacy { output_ref: result.ref } returns are still accepted. Returning undefined fails the run because it is not JSON, so when a stage finds nothing, run a fallback/synthesis child or return an explicit JSON no-findings object. host.budget reports any user-configured token ceiling and observed spend; a typical child consumes 30k-150k tokens, and a wide planning batch can exceed 800k tokens total; the model cannot set the ceiling. Child call options: agent and pipeline take one { input, agentType, schema, isolation, label } request object; every parallel([...]) request-array entry accepts the same fields. agent also accepts agent("prompt", { agentType, schema, isolation, label }). When the user names a child, pass that name as label; when parallel peers need distinct identities, give each a distinct label. label is display-only and does not change the child type, prompt, tools, or execution identity. pipeline(items, ...stages) advances each item to its next stage independently as its prior result arrives. For non-trivial Workflow authoring, call `read_skill` exactly once per parent session for `workflow-authoring` when available; after it succeeds, reuse that result and do not reload the skill after validation errors or for later Workflow calls, retries, or resumes.';

const DEFAULT_RUN_TIMEOUT_MS = 45 * 60_000;
const DEFAULT_AGENT_CALL_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_MAX_CONCURRENT_CHILDREN = 16;
const DEFAULT_MAX_TOTAL_AGENT_CALLS = 1000;
const DEFAULT_MAX_PROGRESS_MARKERS = 512;
const SCRIPT_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;

// Workflow V1 inline-schema subset bounds. The accepted keyword set is closed
// to type/enum/required/properties/items; any other key is rejected.
const INLINE_SCHEMA_MAX_BYTES = 4096;
const INLINE_SCHEMA_MAX_DEPTH = 16;
const INLINE_SCHEMA_MAX_ENTRIES = 16;
const INLINE_SCHEMA_TYPES = ["object", "array", "string", "number", "integer", "boolean", "null"] as const;
const INLINE_SCHEMA_KEYWORDS = new Set(["type", "enum", "required", "properties", "items"]);
const WORKFLOW_EFFORT_LEVELS = new Set<string>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

/** muse-subagents publishes its in-process runner here; read-only, no import cycle. */
const IN_PROCESS_CHILD_RUNNER_SYMBOL = Symbol.for("pi-muse:subagent-runner");

/**
 * The official Workflow V1 tool schema, verbatim from Muse's tool spec.
 * Property order, descriptions, optionality, and `additionalProperties: false`
 * match `/tmp/opencode/ref/schemas.json`; there are no required properties.
 */
const workflowSchema = Type.Object(
	{
		args: Type.Optional(
			Type.Unknown({
				description:
					'Workflow arguments exposed to the script as args; accepts any JSON value. Pass the value itself (e.g. {"topic": "x"}), not a JSON-encoded string: a string arrives in the script as a string.',
			}),
		),
		description: Type.Optional(
			Type.String({ description: "Optional CC-compatible display metadata. Accepted but not executed." }),
		),
		expectedScriptHash: Type.Optional(
			Type.String({
				description:
					"Optional canonical `sha256:<64 lowercase hex>` hash of the intended script bytes (the same form the result echoes as `scriptHash`). When present, the launch is rejected before any child work unless the selected source bytes hash to it \u2014 use this when the script bytes come from a checked-in file whose digest a deterministic step already computed, so a retyped or corrupted inline copy cannot launch. Whitespace-only normalizes to absence; any other non-canonical shape rejects as invalid input.",
			}),
		),
		name: Type.Optional(
			Type.String({
				description:
					"Short workflow id, such as generated.review-change. When neither script nor scriptPath is given, name launches a saved workflow from the local registry (project .agents/.codex/.claude workflows directories or the user config workflows directory); an unknown name fails with the available names. When script or scriptPath is present, name is display-only: it labels the run and does not select a saved workflow.",
			}),
		),
		resumeFromRunId: Type.Optional(
			Type.String({
				description:
					"Same-session logical workflow run id to resume after its previous owner task has stopped. Internal opaque control handle for Workflow calls only. Pass this exact value only as resumeFromRunId; never repeat it in user-facing prose. Re-executes the selected script from the top and reuses only the longest unchanged completed call prefix.",
			}),
		),
		script: Type.Optional(
			Type.String({
				description:
					// biome-ignore lint/suspicious/noTemplateCurlyInString: the official description is copied verbatim and documents `${...}` interpolation examples
					'JavaScript workflow source for release V8 host API v1. Two accepted shapes: (1) a CC-shaped top-level-await script body with no default export that calls the bare globals directly, e.g. const result = await agent("review the change"); return { status: "ok", ref: result.ref, text: result.text }; (2) a legacy module export default async function workflow(host) { ... } using host.agent, host.pipeline, host.parallel - the same functions as the bare globals agent, pipeline, parallel. args exposes the caller arguments (any JSON value, deeply frozen); budget is a frozen per-slice snapshot with total, used, spent(), remaining(), localConcurrencyCap, totalAgentCallCap, reinstalled with observed usage as child results arrive. agent and pipeline accept one { input, agentType, schema, isolation, label } request object; parallel request-array entries use the same fields. agent also accepts the positional agent("prompt", { agentType, schema: { required: [...] }, isolation, label }) form. When the user names a child, pass that name as label; give parallel peers distinct labels. label is display-only and does not change the child type, prompt, tools, or execution identity. agentType is optional: omit it or pass null/undefined to use the built-in workflow-subagent identity and current default launch; if supplied, use a #7546 canonical rendered Agent Definition id of at most 385 UTF-8 bytes (plugin-scoped ids included; its unscoped or final definition name is at most 128 UTF-8 bytes). An explicit agentType selects that registered Agent Definition; its prompt is appended as one developer context block, and its tools/disallowedTools may only narrow the inherited Work-tool grant. Definition-carried model and effort remain inert; per-call `model`/`effort` options or parent inheritance control execution. isolation accepts true, a case-insensitive "true" string, or a non-array, non-function object to request an isolated worktree; false, a case-insensitive "false" string, null, undefined, or omission uses the parent workspace, and every other shape rejects. Choose isolation (true or an empty object) when the user requests subagent isolation or when parallel children may write, because concurrent writers can corrupt a shared checkout even when their intended files differ. Keep read-only children in the shared checkout. An affirmative isolation request may reject when capability, provider, retained-session, workspace, or Git prerequisites are unavailable. Every child inherits the parent session\'s current effective Work tools as its upper bound (write tools included when the session has them). Per-call tools is unsupported and must be omitted. An optional phase: "Title" (up to 128 chars) on agent/pipeline/parallel calls and parallel array items explicitly assigns that agent to a progress group - use it inside pipeline()/parallel() stages to avoid races on the global phase() state; same phase string, same group box. Each result includes ref, summary, text (at most 32768 characters), optional model-authored notes, error_kind, and data; ref remains the durable full-result handle. For up to 16 independent mixed host calls, start them together with Promise.all([host.agent({ input: "..." }), host.pipeline({ input: "..." })]). For wider same-kind work, use one parallel request array: const reports = await host.parallel(items.slice(0, 900).map((item) => ({ input: `Review ${item}` }))); array input always resolves to an array of results in input order, one-entry batches included. Zero-argument thunk arrays such as parallel([() => agent("..."), () => agent("...")]) are also limited to the 16 pending-call slice cap; use request arrays for larger batches. pipeline(items, ...stages) runs stage functions (prev, item, index) per item and advances each item to its next stage independently as its prior result arrives, dropping an item to null for later stages when its stage throws. Do not join, concatenate, array, or map() several child refs/texts into a fake output_ref. For multiple child results, call a synthesis host.agent child and return a small JSON object with synthesis.ref and synthesis.text; legacy { output_ref: synthesis.ref } returns are still accepted. When a later synthesis child needs earlier child outputs, include those refs in the later input, e.g. const synthesis = await host.agent({ input: `Synthesize reports: ${reports.map((report) => report.ref).join("\\n")}` }); return { status: "ok", ref: synthesis.ref, text: synthesis.text }. For one child, use const result = await host.agent({ input: "..." }); return { status: "ok", ref: result.ref, text: result.text }. Put repo discovery in child agent input when target files or git diff are unclear. For repository research, ask the child to use its inherited Work tools to inspect the source and test bodies needed for its assigned claims; omit bash workdir unless you already observed an existing directory. phase("title") (up to 128 chars) and log("message") (up to 512 chars) record progress markers: they return undefined immediately, never barrier the script, cost no batches or agent calls, and are capped at 512 per run.',
			}),
		),
		scriptPath: Type.Optional(
			Type.String({
				description:
					"Local JavaScript workflow path. For a fresh inline run, omit `scriptPath`; the runtime persists `script` and returns the persisted path as `scriptPath`. When non-empty `script` is present, `scriptPath` is only an explicit persistence target; whether relative or absolute, its existing parent directory must resolve inside the active workspace. Only for a path-only read with no `script` may an absolute local `scriptPath` be used without workspace context; relative path-only sources resolve against the active workspace. Use the returned `scriptPath` with `resumeFromRunId` after inspecting or editing a recoverable workflow.",
			}),
		),
		title: Type.Optional(
			Type.String({ description: "Optional CC-compatible display metadata. Accepted but not executed." }),
		),
	},
	{ additionalProperties: false },
);

export type WorkflowToolInput = Static<typeof workflowSchema>;

/** One child agent request as seen by a {@link WorkflowChildRunner}. */
export interface WorkflowChildRequest {
	input: string;
	agentType: string | null;
	schema: unknown;
	isolation: unknown;
	label: string | null;
	phase: string | null;
	model: string | null;
	effort: string | null;
}

/** Isolation outcome attached to a child result when the request asked for a worktree. */
export interface WorkflowIsolationOutcome {
	worktree_path: string;
	retained: boolean;
	reason?: string;
}

/** A retained or transient worktree handed to the child runner. */
export interface WorkflowIsolationContext {
	worktreePath: string;
	baseCwd: string;
}

/** Parent route forwarded to the child runner so children can inherit or override it. */
export interface WorkflowParentRoute {
	model?: Model<Api> | undefined;
	thinkingLevel?: ThinkingLevel | undefined;
	findModel?: ((modelId: string) => Model<Api> | undefined) | undefined;
}

/** A child agent result. Missing fields are normalized before the script sees them. */
export interface WorkflowChildResult {
	ref?: string | null;
	text?: string;
	summary?: string;
	data?: unknown;
	notes?: unknown;
	kind?: string;
	error_kind?: string | null;
	error?: { code: string; message?: string };
	usage?: { totalTokens?: number };
	isolation?: WorkflowIsolationOutcome | null;
}

interface NormalizedChildResult {
	ref: string | null;
	text: string;
	summary?: string;
	data?: unknown;
	notes?: unknown;
	kind?: string;
	error_kind: string | null;
	error?: { code: string; message?: string };
	usage?: { totalTokens?: number };
	isolation?: WorkflowIsolationOutcome | null;
	schema_invalid?: boolean;
}

export interface WorkflowChildRunnerContext {
	cwd: string;
	runId: string;
	callIndex: number;
	signal: AbortSignal | undefined;
	isolation: WorkflowIsolationContext | null;
	parent: WorkflowParentRoute | null;
}

/** Starts one child agent and resolves its settled result. Never rejects on child failure. */
export type WorkflowChildRunner = (
	request: WorkflowChildRequest,
	context: WorkflowChildRunnerContext,
) => Promise<WorkflowChildResult>;

export interface WorkflowToolOptions {
	/** Child runner. Defaults to the in-process SDK `AgentSession` session path. */
	childRunner?: WorkflowChildRunner;
	/** Directory for persisted scripts and journals. Defaults to `<cwd>/.pi/muse-workflows`. */
	workflowDir?: string;
	/** Child agents allowed to run at once. Workflow V1 runner cap: 16. */
	maxConcurrentChildren?: number;
	/** Total agent/pipeline/parallel item calls per run. Workflow V1 cap: 1000. */
	maxTotalAgentCalls?: number;
	/** Whole-run wall-clock budget. Defaults to 45 minutes. */
	runTimeoutMs?: number;
	/** Per-child wall-clock budget. Defaults to 30 minutes. */
	agentCallTimeoutMs?: number;
	/** Retained `log`/`phase` markers per run. Workflow V1 cap: 512. */
	maxProgressMarkers?: number;
	/** Directories searched for saved workflows by `name`. Defaults to the project/user registry. */
	workflowRegistryDirs?: string[];
	/** Temp root for isolated child worktrees. Defaults to `<tmpdir>/pi-muse-worktrees`. */
	worktreeRoot?: string;
	/** Parent model available to children for inheritance and `model` override resolution. */
	parentModel?: Model<Api>;
	/** Parent thinking level available to children for inheritance. */
	parentThinkingLevel?: ThinkingLevel;
	/** Model-id resolver used for per-call `model` overrides. */
	findModel?: (modelId: string) => Model<Api> | undefined;
}

/** One progress group assembled from `phase()` markers and per-call `phase` requests. */
export interface WorkflowPhaseGroup {
	title: string;
	logs: string[];
	agentCalls: number;
}

export interface WorkflowRunError {
	code: string;
	message: string;
}

/** JSON payload echoed as the tool result text. */
export interface WorkflowToolPayload {
	runId: string;
	scriptPath?: string;
	scriptHash?: string;
	status: "ok" | "error";
	result?: unknown;
	outputRef?: string;
	error?: WorkflowRunError;
	agentCalls: number;
	durationMs: number;
	name?: string;
}

export interface WorkflowToolDetails {
	runId: string;
	scriptPath?: string;
	scriptHash?: string;
	status: "ok" | "error";
	errorCode?: string;
	agentCalls: number;
	durationMs: number;
	logs: string[];
	phases: string[];
	phaseGroups: WorkflowPhaseGroup[];
}

interface WorkflowJournalEntry {
	hash: string;
	result: NormalizedChildResult;
}

interface WorkflowJournalFile {
	version: 1;
	runId: string;
	scriptHash: string;
	entries: Array<WorkflowJournalEntry | null>;
}

interface WorkflowRunState {
	scriptPath: string;
	scriptHash: string;
	journal: Array<WorkflowJournalEntry | null>;
	status: "running" | "succeeded" | "failed";
}

/**
 * Same-session run registry. `resumeFromRunId` resolves its persisted script
 * and journaled call prefix through this map before falling back to disk.
 */
const workflowRunStates = new Map<string, WorkflowRunState>();

interface WorkerAgentCallMessage {
	type: "agent";
	id: number;
	index: number;
	request: WorkflowChildRequest;
	requestHash: string;
}

interface WorkerMarkerMessage {
	type: "marker";
	kind: "log" | "phase";
	text: string;
}

interface WorkerDoneMessage {
	type: "done";
	json: string;
}

interface WorkerErrorMessage {
	type: "error";
	code?: string;
	message: string;
	stack?: string;
}

type WorkerToMainMessage = WorkerAgentCallMessage | WorkerMarkerMessage | WorkerDoneMessage | WorkerErrorMessage;

interface WorkerAgentResultMessage {
	type: "agent:result";
	id: number;
	result: NormalizedChildResult;
}

/**
 * Worker bootstrap. Runs as CommonJS (`eval: true`) and only needs dynamic
 * `import()` for the workflow module itself. No template literals or `${`
 * interpolation here: this source is embedded in a TypeScript template string.
 */
const WORKFLOW_WORKER_BOOTSTRAP = `
const { parentPort, workerData } = require("node:worker_threads");
const { createHash } = require("node:crypto");

const pending = new Map();
const journal = Array.isArray(workerData.journal) ? workerData.journal : [];
const markerCap = typeof workerData.maxProgressMarkers === "number" ? workerData.maxProgressMarkers : 512;
const maxConcurrent = Math.max(1, typeof workerData.maxConcurrentChildren === "number" ? workerData.maxConcurrentChildren : 16);
const totalCallCap = Math.max(1, typeof workerData.maxTotalAgentCalls === "number" ? workerData.maxTotalAgentCalls : 1000);
const budgetTotal = typeof workerData.budgetTotal === "number" ? workerData.budgetTotal : null;

let nextRequestId = 1;
let callIndex = 0;
let markerCount = 0;
let activeCalls = 0;
let usedTokens = 0;
const waitingSlots = [];

parentPort.on("message", (message) => {
  if (!message || message.type !== "agent:result") return;
  const resolve = pending.get(message.id);
  if (!resolve) return;
  pending.delete(message.id);
  resolve(message.result);
});

function hashRequest(request) {
  return createHash("sha256").update(JSON.stringify(request)).digest("hex");
}

function callRunner(index, request) {
  return new Promise((resolve) => {
    const id = nextRequestId++;
    pending.set(id, resolve);
    parentPort.postMessage({
      type: "agent",
      id: id,
      index: index,
      request: request,
      requestHash: hashRequest(request),
    });
  });
}

function withSlot(run) {
  return new Promise((resolve, reject) => {
    const start = () => {
      activeCalls += 1;
      Promise.resolve()
        .then(run)
        .then(resolve, reject)
        .finally(() => {
          activeCalls -= 1;
          const next = waitingSlots.shift();
          if (next) next();
        });
    };
    if (activeCalls < maxConcurrent) start();
    else waitingSlots.push(start);
  });
}

function normalizeRequest(first, second) {
  let base;
  if (typeof first === "string") {
    base = Object.assign({}, second || {}, { input: first });
  } else if (first && typeof first === "object") {
    base = first;
  } else {
    base = { input: first === undefined || first === null ? "" : String(first) };
  }
  const input =
    typeof base.input === "string"
      ? base.input
      : base.input === undefined || base.input === null
        ? ""
        : String(base.input);
  return {
    input: input,
    agentType: base.agentType === undefined ? null : base.agentType,
    schema: base.schema === undefined ? null : base.schema,
    isolation: base.isolation === undefined ? null : base.isolation,
    label: base.label === undefined ? null : base.label,
    phase: base.phase === undefined ? null : base.phase,
    model: base.model === undefined ? null : base.model,
    effort: base.effort === undefined ? null : base.effort,
  };
}

async function agent(first, second) {
  const request = normalizeRequest(first, second);
  const index = callIndex++;
  const hash = hashRequest(request);
  const memo = index < journal.length ? journal[index] : null;
  if (memo && memo.hash === hash) {
    if (memo.result && memo.result.schema_invalid === true) return null;
    return memo.result;
  }
  if (index >= totalCallCap) {
    return {
      ref: null,
      text: "",
      error_kind: null,
      kind: "not_admitted",
      error: { code: "agent_call_cap_exceeded", message: "agent call cap reached: " + totalCallCap },
    };
  }
  const result = await withSlot(() => callRunner(index, request));
  if (result && typeof result === "object" && result.schema_invalid === true) return null;
  if (result && typeof result === "object" && result.usage && typeof result.usage.totalTokens === "number") {
    usedTokens += result.usage.totalTokens;
  }
  return result;
}

async function parallel(tasks) {
  const list = Array.isArray(tasks) ? tasks : [];
  return await Promise.all(list.map((task) => (typeof task === "function" ? task() : agent(task))));
}

async function pipeline(items) {
  const stages = Array.prototype.slice.call(arguments, 1);
  const list = Array.isArray(items) ? items : [];
  return await Promise.all(
    list.map(async (item, index) => {
      let previous = null;
      for (const stage of stages) {
        try {
          previous = await stage(previous, item, index);
        } catch (error) {
          return null;
        }
      }
      return previous;
    }),
  );
}

function recordMarker(kind, text, limit) {
  if (markerCount >= markerCap) return;
  markerCount += 1;
  const value = typeof text === "string" ? text : String(text === undefined || text === null ? "" : text);
  parentPort.postMessage({ type: "marker", kind: kind, text: value.slice(0, limit) });
}

function log(message) {
  recordMarker("log", message, 512);
}

function phase(title) {
  recordMarker("phase", title, 128);
}

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return value;
}

const budget = Object.freeze({
  total: budgetTotal,
  localConcurrencyCap: maxConcurrent,
  totalAgentCallCap: totalCallCap,
  spent: () => usedTokens,
  remaining: () => (budgetTotal === null ? Infinity : Math.max(0, budgetTotal - usedTokens)),
});

const host = Object.freeze({
  agent: agent,
  parallel: parallel,
  pipeline: pipeline,
  log: log,
  phase: phase,
  args: deepFreeze(workerData.args === undefined ? null : workerData.args),
  budget: budget,
  cwd: workerData.cwd,
  runId: workerData.runId,
});

function wrapSource(source) {
  return (
    "export default async function workflow(host) {\\n" +
    "const { agent, parallel, pipeline, log, phase, args, budget } = host;\\n" +
    source +
    "\\n}\\n"
  );
}

function sourceUrl(source) {
  return "data:text/javascript;base64," + Buffer.from(source, "utf8").toString("base64");
}

function fail(code, error) {
  const message = error && error.message ? String(error.message) : String(error);
  parentPort.postMessage({
    type: "error",
    code: code,
    message: message,
    stack: error && error.stack ? String(error.stack) : undefined,
  });
}

(async () => {
  try {
    let exported = null;
    if (workerData.usesDefaultExport) {
      const module = await import(workerData.fileUrl);
      if (typeof module.default === "function") exported = module.default;
    }
    if (!exported) {
      const wrapped = await import(sourceUrl(wrapSource(workerData.source)));
      if (typeof wrapped.default === "function") exported = wrapped.default;
    }
    if (!exported) {
      fail(
        "script_error",
        new Error("workflow script must export default async function workflow(host) or use the bare-globals script shape"),
      );
      return;
    }
    const value = await exported(host);
    if (value === undefined) {
      fail("undefined_result", new Error("workflow script returned undefined; return a JSON-serializable value"));
      return;
    }
    let json;
    try {
      json = JSON.stringify(value);
    } catch (error) {
      fail("unserializable_result", error);
      return;
    }
    if (typeof json !== "string") {
      fail("undefined_result", new Error("workflow script returned a value that cannot be serialized as JSON"));
      return;
    }
    parentPort.postMessage({ type: "done", json: json });
  } catch (error) {
    fail("script_error", error);
  }
})();
`;

/** Read the in-process runner muse-subagents publishes, if it is present and shaped correctly. */
export function readInProcessChildRunner(): InProcessChildRunner | undefined {
	const value: unknown = (globalThis as Record<symbol, unknown>)[IN_PROCESS_CHILD_RUNNER_SYMBOL];
	if (typeof value !== "object" || value === null) return undefined;
	if (typeof (value as { runChild?: unknown }).runChild !== "function") return undefined;
	return value as InProcessChildRunner;
}

/** Adapt the in-process pi-subagents runner to the workflow child-runner contract. */
export function createInProcessChildRunner(handle: InProcessChildRunner): WorkflowChildRunner {
	return async (request, context) => {
		const ref = `pi-subagents:${context.runId}:${context.callIndex}`;
		const isolation = resolveWorkflowIsolationShape(request.isolation);
		const runRequest: InProcessChildRunRequest = {
			type:
				typeof request.agentType === "string" && request.agentType.trim().length > 0
					? request.agentType
					: "general-purpose",
			prompt: request.input,
			model: request.model,
			effort: request.effort,
			// A tool-prepared worktree already isolates the child; requesting a
			// second pi-subagents worktree over it would nest two copies.
			isolation: context.isolation === null && isolation.ok ? isolation.enabled : false,
			cwd: context.isolation?.worktreePath ?? context.cwd,
		};
		try {
			const result = await handle.runChild(runRequest);
			return {
				ref,
				text: result.text,
				summary: summarizeChildText(result.text),
				data: result.data,
				error_kind: result.error_kind,
				error: result.error,
				usage: result.usage,
			};
		} catch (error) {
			return {
				ref,
				text: "",
				error_kind: "runner_error",
				error: { code: "runner_error", message: errorMessage(error) },
			};
		}
	};
}

/** Default runner: the in-process pi-subagents runner when published, else one SDK session per child. */
export const defaultWorkflowChildRunner: WorkflowChildRunner = async (request, context) => {
	const inProcess = readInProcessChildRunner();
	if (inProcess) return createInProcessChildRunner(inProcess)(request, context);
	return runWorkflowChildViaSdk(request, context);
};

async function runWorkflowChildViaSdk(
	request: WorkflowChildRequest,
	context: WorkflowChildRunnerContext,
): Promise<WorkflowChildResult> {
	const fallbackRef = `wf:${context.runId}:${context.callIndex}`;
	const launch = resolveChildLaunchOptions(request, context.parent);
	if (!launch.ok) {
		return {
			ref: fallbackRef,
			text: "",
			error_kind: launch.error_kind,
			error: { code: launch.error_kind, message: launch.message },
		};
	}
	const childCwd = context.isolation?.worktreePath ?? context.cwd;
	const { session } = await createAgentSession({
		cwd: childCwd,
		sessionManager: SessionManager.inMemory(childCwd),
		excludeTools: ["workflow"],
		model: launch.model,
		thinkingLevel: launch.thinkingLevel,
	});
	const onAbort = (): void => session.dispose();
	try {
		if (context.signal?.aborted) throw new Error("workflow run cancelled before the child started");
		context.signal?.addEventListener("abort", onAbort, { once: true });
		await session.prompt(request.input, { expandPromptTemplates: false });
		const text = session.getLastAssistantText() ?? "";
		return { ref: fallbackRef, text, summary: summarizeChildText(text), error_kind: null };
	} finally {
		context.signal?.removeEventListener("abort", onAbort);
		session.dispose();
	}
}

function summarizeChildText(text: string): string | undefined {
	const firstLine = text.split("\n").find((line) => line.trim().length > 0);
	if (firstLine === undefined) return undefined;
	return firstLine.trim().slice(0, 280);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function normalizeOptionalText(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	return value.trim().length === 0 ? undefined : value;
}

function sha256Of(source: string): string {
	return `sha256:${createHash("sha256").update(Buffer.from(source, "utf-8")).digest("hex")}`;
}

function isInside(root: string, candidate: string): boolean {
	const rel = relative(root, candidate);
	return rel.length === 0 || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

function toDisplayPath(cwd: string, absolutePath: string): string {
	if (!isInside(cwd, absolutePath)) return absolutePath.split(sep).join("/");
	const rel = relative(cwd, absolutePath);
	return rel.length === 0 ? "." : rel.split(sep).join("/");
}

function workflowDirFor(cwd: string, options: WorkflowToolOptions | undefined): string {
	return options?.workflowDir ?? join(cwd, ".pi", "muse-workflows");
}

function defaultScriptPath(workflowDir: string, runId: string): string {
	return join(workflowDir, `${runId}.mjs`);
}

function journalPath(workflowDir: string, runId: string): string {
	return join(workflowDir, `${runId}.journal.json`);
}

function usesDefaultExport(source: string): boolean {
	return /export\s+default\b/.test(source);
}

function normalizeChildResult(value: WorkflowChildResult, fallbackRef: string): NormalizedChildResult {
	return {
		ref: typeof value.ref === "string" ? value.ref : value.ref === null ? null : fallbackRef,
		text: typeof value.text === "string" ? value.text : "",
		summary: typeof value.summary === "string" ? value.summary : undefined,
		data: value.data,
		notes: value.notes,
		kind: typeof value.kind === "string" ? value.kind : undefined,
		error_kind: typeof value.error_kind === "string" ? value.error_kind : null,
		error: value.error,
		usage: value.usage,
		isolation: value.isolation ?? undefined,
	};
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

type InlineSchemaValidation = { ok: true; schema: TSchema } | { ok: false; message: string };

function buildInlineTypebox(schema: Record<string, unknown>, depth: number): InlineSchemaValidation {
	if (depth > INLINE_SCHEMA_MAX_DEPTH) {
		return { ok: false, message: `inline schema exceeds the depth-${INLINE_SCHEMA_MAX_DEPTH} bound` };
	}
	for (const key of Object.keys(schema)) {
		if (!INLINE_SCHEMA_KEYWORDS.has(key)) {
			return { ok: false, message: `inline schema uses unsupported keyword "${key}"` };
		}
	}
	const typeValue = schema.type;
	if (typeValue !== undefined) {
		if (
			typeof typeValue !== "string" ||
			!INLINE_SCHEMA_TYPES.includes(typeValue as (typeof INLINE_SCHEMA_TYPES)[number])
		) {
			return { ok: false, message: `inline schema \`type\` must be one of ${INLINE_SCHEMA_TYPES.join(", ")}` };
		}
	}
	const enumValue = schema.enum;
	if (enumValue !== undefined) {
		if (!Array.isArray(enumValue) || enumValue.length === 0 || enumValue.length > INLINE_SCHEMA_MAX_ENTRIES) {
			return {
				ok: false,
				message: `inline schema \`enum\` must be a non-empty array of at most ${INLINE_SCHEMA_MAX_ENTRIES} entries`,
			};
		}
		for (const entry of enumValue) {
			if (entry === null || typeof entry !== "object") continue;
			return { ok: false, message: "inline schema `enum` accepts only primitive entries" };
		}
	}
	let required: string[] | undefined;
	if (schema.required !== undefined) {
		if (
			!Array.isArray(schema.required) ||
			schema.required.length > INLINE_SCHEMA_MAX_ENTRIES ||
			schema.required.some((entry) => typeof entry !== "string")
		) {
			return {
				ok: false,
				message: `inline schema \`required\` must be an array of at most ${INLINE_SCHEMA_MAX_ENTRIES} strings`,
			};
		}
		required = schema.required as string[];
	}
	const properties = new Map<string, TSchema>();
	if (schema.properties !== undefined) {
		if (typeValue !== "object") {
			return { ok: false, message: 'inline schema `properties` requires `type: "object"`' };
		}
		if (!isPlainObject(schema.properties)) {
			return { ok: false, message: "inline schema `properties` must be an object" };
		}
		const keys = Object.keys(schema.properties);
		if (keys.length > INLINE_SCHEMA_MAX_ENTRIES) {
			return {
				ok: false,
				message: `inline schema \`properties\` exceeds the ${INLINE_SCHEMA_MAX_ENTRIES}-entry bound`,
			};
		}
		for (const key of keys) {
			const childValue = schema.properties[key];
			if (!isPlainObject(childValue))
				return { ok: false, message: `inline schema property "${key}" must be an object` };
			const child = buildInlineTypebox(childValue, depth + 1);
			if (!child.ok) return child;
			properties.set(key, child.schema);
		}
	}
	if (required !== undefined && typeValue !== "object") {
		return { ok: false, message: 'inline schema `required` requires `type: "object"`' };
	}
	let items: TSchema | undefined;
	if (schema.items !== undefined) {
		if (typeValue !== "array") return { ok: false, message: 'inline schema `items` requires `type: "array"`' };
		if (!isPlainObject(schema.items)) return { ok: false, message: "inline schema `items` must be an object" };
		const child = buildInlineTypebox(schema.items, depth + 1);
		if (!child.ok) return child;
		items = child.schema;
	}
	if (enumValue !== undefined) {
		const literals = enumValue.map((entry) =>
			entry === null ? Type.Null() : Type.Literal(entry as string | number | boolean),
		);
		return { ok: true, schema: literals.length === 1 ? literals[0]! : Type.Union(literals) };
	}
	switch (typeValue) {
		case "object": {
			const props: Record<string, TSchema> = {};
			for (const [key, value] of properties) {
				props[key] = required?.includes(key) ? value : Type.Optional(value);
			}
			return { ok: true, schema: Type.Object(props) };
		}
		case "array":
			return { ok: true, schema: Type.Array(items ?? Type.Unknown()) };
		case "string":
			return { ok: true, schema: Type.String() };
		case "number":
			return { ok: true, schema: Type.Number() };
		case "integer":
			return { ok: true, schema: Type.Integer() };
		case "boolean":
			return { ok: true, schema: Type.Boolean() };
		case "null":
			return { ok: true, schema: Type.Null() };
		default:
			return { ok: false, message: "inline schema needs a supported `type` or `enum`" };
	}
}

export function validateWorkflowInlineSchema(schema: unknown): InlineSchemaValidation {
	if (!isPlainObject(schema)) return { ok: false, message: "inline schema must be an object" };
	let size: number;
	try {
		size = Buffer.byteLength(JSON.stringify(schema), "utf-8");
	} catch {
		return { ok: false, message: "inline schema is not JSON-serializable" };
	}
	if (size > INLINE_SCHEMA_MAX_BYTES) {
		return { ok: false, message: `inline schema exceeds the ${INLINE_SCHEMA_MAX_BYTES}-byte bound` };
	}
	return buildInlineTypebox(schema, 1);
}

function formatInlineSchemaErrors(schema: TSchema, data: unknown): string {
	const errors = [...Value.Errors(schema, data)]
		.slice(0, 3)
		.map((error) => `${error.instancePath || "root"}: ${error.message}`);
	return errors.length > 0 ? errors.join("; ") : "value does not match the inline schema";
}

type IsolationShape = { ok: true; enabled: boolean } | { ok: false; message: string };

export function resolveWorkflowIsolationShape(value: unknown): IsolationShape {
	if (value === undefined || value === null || value === false) return { ok: true, enabled: false };
	if (value === true) return { ok: true, enabled: true };
	if (typeof value === "string") {
		const normalized = value.toLowerCase();
		if (normalized === "true") return { ok: true, enabled: true };
		if (normalized === "false") return { ok: true, enabled: false };
		return { ok: false, message: 'isolation string must be "true" or "false"' };
	}
	if (typeof value === "object" && !Array.isArray(value)) return { ok: true, enabled: true };
	return { ok: false, message: 'isolation must be true, a "true"/"false" string, an object, null, or omitted' };
}

const GIT_TIMEOUT_MS = 60_000;

type GitResult = { ok: true; stdout: string } | { ok: false; message: string };

function runGit(cwd: string, args: string[]): Promise<GitResult> {
	return new Promise((resolveGit) => {
		execFile(
			"git",
			args,
			{ cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
			(error, stdout, stderr) => {
				if (error) {
					const detail = `${stderr}${stdout}`.trim() || error.message;
					resolveGit({ ok: false, message: detail });
					return;
				}
				resolveGit({ ok: true, stdout: stdout.toString().trim() });
			},
		);
	});
}

interface PreparedIsolation {
	root: string;
	worktreePath: string;
	baseHead: string;
}

type PrepareIsolationResult = { ok: true; handle: PreparedIsolation } | { ok: false; message: string };

async function prepareIsolationWorktree(params: {
	worktreeRoot: string;
	baseCwd: string;
	runId: string;
	callIndex: number;
}): Promise<PrepareIsolationResult> {
	const root = await runGit(params.baseCwd, ["rev-parse", "--show-toplevel"]);
	if (!root.ok || root.stdout.length === 0) {
		const detail = root.ok ? "no repository root found" : root.message;
		return { ok: false, message: `git worktree isolation needs a Git workspace: ${detail}` };
	}
	const head = await runGit(root.stdout, ["rev-parse", "HEAD"]);
	if (!head.ok) return { ok: false, message: `could not resolve HEAD for isolation: ${head.message}` };
	const worktreePath = join(params.worktreeRoot, `${params.runId}-${params.callIndex}`);
	await rm(worktreePath, { recursive: true, force: true });
	await mkdir(params.worktreeRoot, { recursive: true });
	const add = await runGit(root.stdout, ["worktree", "add", "--detach", worktreePath, "HEAD"]);
	if (!add.ok) return { ok: false, message: `git worktree add failed: ${add.message}` };
	return { ok: true, handle: { root: root.stdout, worktreePath, baseHead: head.stdout } };
}

async function finalizeIsolationWorktree(handle: PreparedIsolation): Promise<{ retained: boolean; reason: string }> {
	const status = await runGit(handle.worktreePath, ["status", "--porcelain"]);
	const head = await runGit(handle.worktreePath, ["rev-parse", "HEAD"]);
	const hasChanges = !status.ok || status.stdout.length > 0;
	const headChanged = !head.ok || head.stdout !== handle.baseHead;
	if (!hasChanges && !headChanged) {
		const removed = await runGit(handle.root, ["worktree", "remove", "--force", handle.worktreePath]);
		if (removed.ok) return { retained: false, reason: "clean" };
		return { retained: true, reason: `worktree remove failed: ${removed.message}` };
	}
	return { retained: true, reason: hasChanges ? "uncommitted changes" : "HEAD changed" };
}

export type WorkflowChildLaunchResolution =
	| { ok: true; model?: Model<Api>; thinkingLevel?: ThinkingLevel }
	| { ok: false; error_kind: "model_not_found"; message: string };

export function normalizeWorkflowEffort(effort: string | null | undefined): ThinkingLevel | undefined {
	if (typeof effort !== "string") return undefined;
	const normalized = effort.trim().toLowerCase();
	return WORKFLOW_EFFORT_LEVELS.has(normalized) ? (normalized as ThinkingLevel) : undefined;
}

export function resolveChildLaunchOptions(
	request: Pick<WorkflowChildRequest, "model" | "effort">,
	parent: WorkflowParentRoute | null | undefined,
): WorkflowChildLaunchResolution {
	const route = parent ?? {};
	let model = route.model;
	const requestedModel = typeof request.model === "string" ? request.model.trim() : "";
	if (requestedModel.length > 0) {
		const found =
			route.findModel?.(requestedModel) ??
			(route.model &&
			(route.model.id === requestedModel || `${route.model.provider}/${route.model.id}` === requestedModel)
				? route.model
				: undefined);
		if (!found) {
			return {
				ok: false,
				error_kind: "model_not_found",
				message: `model override "${requestedModel}" is not available to this workflow`,
			};
		}
		model = found;
	}
	return { ok: true, model, thinkingLevel: normalizeWorkflowEffort(request.effort) ?? route.thinkingLevel };
}

export function findModelInRegistry(
	registry: ModelRegistry | undefined,
): ((modelId: string) => Model<Api> | undefined) | undefined {
	if (!registry) return undefined;
	return (modelId: string) => {
		const direct = registry.getAll().find((model) => model.id === modelId);
		if (direct) return direct;
		const separator = modelId.indexOf("/");
		if (separator <= 0 || separator === modelId.length - 1) return undefined;
		return registry.find(modelId.slice(0, separator), modelId.slice(separator + 1));
	};
}

function parentRouteFor(options: WorkflowToolOptions | undefined, ctx: ExtensionContext): WorkflowParentRoute {
	return {
		model: options?.parentModel ?? ctx?.model,
		thinkingLevel: options?.parentThinkingLevel ?? ctx?.thinkingLevel,
		findModel: options?.findModel ?? findModelInRegistry(ctx?.modelRegistry),
	};
}

const SAVED_WORKFLOW_EXTENSIONS = [".mjs", ".js"] as const;

function defaultWorkflowRegistryDirs(cwd: string): string[] {
	return [
		join(cwd, ".agents", "workflows"),
		join(cwd, ".codex", "workflows"),
		join(cwd, ".claude", "workflows"),
		join(getAgentDir(), "workflows"),
	];
}

async function discoverSavedWorkflows(dirs: string[]): Promise<Map<string, string>> {
	const found = new Map<string, string>();
	for (const dir of dirs) {
		let entries: string[];
		try {
			entries = await readdir(dir);
		} catch {
			continue;
		}
		for (const entry of entries) {
			const extension = SAVED_WORKFLOW_EXTENSIONS.find((candidate) => entry.endsWith(candidate));
			if (extension === undefined) continue;
			const name = entry.slice(0, entry.length - extension.length);
			if (name.length === 0 || found.has(name)) continue;
			found.set(name, join(dir, entry));
		}
	}
	return found;
}

interface NormalizedWorkflowInput {
	script?: string;
	scriptPath?: string;
	resumeFromRunId?: string;
	expectedScriptHash?: string;
	args: unknown;
	displayName?: string;
}

function normalizeWorkflowInput(
	input: WorkflowToolInput,
): { ok: true; value: NormalizedWorkflowInput } | { ok: false; error: WorkflowRunError } {
	const script = typeof input.script === "string" ? input.script : undefined;
	if (script !== undefined && script.trim().length === 0) {
		return { ok: false, error: { code: "invalid_input", message: "workflow `script` must be non-empty" } };
	}
	const expectedScriptHash = normalizeOptionalText(input.expectedScriptHash);
	if (expectedScriptHash !== undefined && !SCRIPT_HASH_PATTERN.test(expectedScriptHash)) {
		return {
			ok: false,
			error: {
				code: "invalid_input",
				message: "expectedScriptHash must be a canonical `sha256:<64 lowercase hex>` hash",
			},
		};
	}
	return {
		ok: true,
		value: {
			script,
			scriptPath: normalizeOptionalText(input.scriptPath),
			resumeFromRunId: normalizeOptionalText(input.resumeFromRunId),
			expectedScriptHash,
			args: input.args === undefined ? null : input.args,
			displayName: normalizeOptionalText(input.name),
		},
	};
}

interface ResolvedWorkflowSource {
	runId: string;
	scriptPath: string;
	scriptSource: string;
	scriptHash: string;
	journal: Array<WorkflowJournalEntry | null>;
}

async function resolveInlineScriptTarget(
	cwd: string,
	workflowDir: string,
	runId: string,
	scriptPath: string | undefined,
): Promise<{ ok: true; path: string } | { ok: false; error: WorkflowRunError }> {
	if (scriptPath === undefined) return { ok: true, path: defaultScriptPath(workflowDir, runId) };
	const target = isAbsolute(scriptPath) ? resolve(scriptPath) : resolve(cwd, scriptPath);
	if (!isInside(cwd, dirname(target))) {
		return {
			ok: false,
			error: {
				code: "invalid_input",
				message: `scriptPath must resolve inside the active workspace when script is present: ${scriptPath}`,
			},
		};
	}
	return { ok: true, path: target };
}

async function loadJournaledPrefix(
	workflowDir: string,
	runId: string,
	scriptHash: string,
): Promise<Array<WorkflowJournalEntry | null>> {
	const inMemory = workflowRunStates.get(runId);
	if (inMemory && inMemory.scriptHash === scriptHash && inMemory.journal.length > 0) {
		return inMemory.journal.map((entry) => entry);
	}
	try {
		const raw = await readFile(journalPath(workflowDir, runId), "utf-8");
		const parsed = JSON.parse(raw) as Partial<WorkflowJournalFile>;
		if (parsed.scriptHash !== scriptHash || !Array.isArray(parsed.entries)) return [];
		return parsed.entries.map((entry) =>
			entry && typeof entry === "object" && typeof entry.hash === "string" && entry.result
				? { hash: entry.hash, result: entry.result as NormalizedChildResult }
				: null,
		);
	} catch {
		return [];
	}
}

async function persistJournal(
	workflowDir: string,
	runId: string,
	scriptHash: string,
	journal: Array<WorkflowJournalEntry | null>,
): Promise<void> {
	try {
		const entries = journal.slice();
		while (entries.length > 0 && entries[entries.length - 1] === null) entries.pop();
		const payload: WorkflowJournalFile = { version: 1, runId, scriptHash, entries };
		await mkdir(workflowDir, { recursive: true });
		await writeFile(journalPath(workflowDir, runId), JSON.stringify(payload), "utf-8");
	} catch {
		// Journaling is best effort; a failed write never fails the run itself.
	}
}

async function resolveWorkflowSource(params: {
	cwd: string;
	workflowDir: string;
	registryDirs: string[];
	input: NormalizedWorkflowInput;
}): Promise<{ ok: true; source: ResolvedWorkflowSource } | { ok: false; error: WorkflowRunError }> {
	const { cwd, workflowDir, registryDirs, input } = params;
	const runId = input.resumeFromRunId ?? randomUUID();
	const priorState = input.resumeFromRunId !== undefined ? workflowRunStates.get(input.resumeFromRunId) : undefined;
	if (priorState?.status === "running") {
		return {
			ok: false,
			error: {
				code: "run_in_progress",
				message: `workflow run ${runId} is still live in this session; wait for it to settle before resuming`,
			},
		};
	}

	let scriptPath: string;
	let scriptSource: string;

	if (input.script === undefined && input.scriptPath === undefined && input.resumeFromRunId === undefined) {
		if (input.displayName === undefined) {
			return {
				ok: false,
				error: { code: "invalid_input", message: "workflow requires one of: script, scriptPath, resumeFromRunId" },
			};
		}
		const found = await discoverSavedWorkflows(registryDirs);
		const savedPath = found.get(input.displayName);
		if (savedPath === undefined) {
			const available = Array.from(found.keys()).sort();
			const suffix =
				available.length > 0 ? `available workflows: ${available.join(", ")}` : "no saved workflows found";
			return {
				ok: false,
				error: {
					code: "workflow_not_found",
					message: `saved workflow "${input.displayName}" was not found (${suffix})`,
				},
			};
		}
		scriptPath = savedPath;
		try {
			scriptSource = await readFile(scriptPath, "utf-8");
		} catch (error) {
			return {
				ok: false,
				error: { code: "script_not_found", message: `saved workflow not readable: ${errorMessage(error)}` },
			};
		}
	} else if (input.script !== undefined) {
		const target = await resolveInlineScriptTarget(cwd, workflowDir, runId, input.scriptPath);
		if (!target.ok) return target;
		scriptPath = target.path;
		scriptSource = input.script;
	} else if (input.scriptPath !== undefined) {
		scriptPath = isAbsolute(input.scriptPath) ? resolve(input.scriptPath) : resolve(cwd, input.scriptPath);
		try {
			scriptSource = await readFile(scriptPath, "utf-8");
		} catch (error) {
			return {
				ok: false,
				error: { code: "script_not_found", message: `workflow script not readable: ${errorMessage(error)}` },
			};
		}
	} else {
		scriptPath = priorState?.scriptPath ?? defaultScriptPath(workflowDir, runId);
		try {
			scriptSource = await readFile(scriptPath, "utf-8");
		} catch {
			return {
				ok: false,
				error: {
					code: "run_not_found",
					message: `no persisted workflow script for runId ${runId} at ${toDisplayPath(cwd, scriptPath)}`,
				},
			};
		}
	}

	const scriptHash = sha256Of(scriptSource);
	if (input.expectedScriptHash !== undefined && input.expectedScriptHash !== scriptHash) {
		return {
			ok: false,
			error: {
				code: "hash_mismatch",
				message: `expectedScriptHash ${input.expectedScriptHash} does not match the selected script bytes (${scriptHash})`,
			},
		};
	}

	if (input.script !== undefined) {
		try {
			await mkdir(dirname(scriptPath), { recursive: true });
			await writeFile(scriptPath, input.script, "utf-8");
		} catch (error) {
			return {
				ok: false,
				error: {
					code: "script_not_persisted",
					message: `could not persist workflow script: ${errorMessage(error)}`,
				},
			};
		}
	}

	const journal = input.resumeFromRunId !== undefined ? await loadJournaledPrefix(workflowDir, runId, scriptHash) : [];
	return { ok: true, source: { runId, scriptPath, scriptSource, scriptHash, journal } };
}

interface WorkerRunOutcome {
	status: "ok" | "error";
	result?: unknown;
	error?: WorkflowRunError;
}

interface WorkerRunResult {
	outcome: WorkerRunOutcome;
	journal: Array<WorkflowJournalEntry | null>;
	agentCalls: number;
}

interface WorkerRunParams {
	cwd: string;
	runId: string;
	scriptPath: string;
	scriptSource: string;
	args: unknown;
	journal: Array<WorkflowJournalEntry | null>;
	childRunner: WorkflowChildRunner;
	parent: WorkflowParentRoute | null;
	worktreeRoot: string;
	runnerHandlesIsolation: boolean;
	signal: AbortSignal | undefined;
	onMarker: (kind: "log" | "phase", text: string) => void;
	onAgentCall: (phase: string | null) => void;
	limits: {
		maxConcurrentChildren: number;
		maxTotalAgentCalls: number;
		maxProgressMarkers: number;
		runTimeoutMs: number;
		agentCallTimeoutMs: number;
	};
}

function callChildRunnerWithTimeout(
	runner: WorkflowChildRunner,
	request: WorkflowChildRequest,
	context: WorkflowChildRunnerContext,
	timeoutMs: number,
): Promise<WorkflowChildResult> {
	if (timeoutMs <= 0) return runner(request, context);
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => {
			const error = new Error(`child agent call timed out after ${timeoutMs}ms`);
			error.name = "WorkflowChildTimeoutError";
			reject(error);
		}, timeoutMs);
	});
	return Promise.race([runner(request, context), timeout]).finally(() => {
		if (timer) clearTimeout(timer);
	});
}

function runWorkflowWorker(params: WorkerRunParams): Promise<WorkerRunResult> {
	const { limits } = params;
	const journal: Array<WorkflowJournalEntry | null> = [];
	let agentCalls = 0;
	let settled = false;

	return new Promise<WorkerRunResult>((resolve) => {
		const controller = new AbortController();
		let worker: Worker;
		try {
			worker = new Worker(WORKFLOW_WORKER_BOOTSTRAP, {
				eval: true,
				workerData: {
					cwd: params.cwd,
					runId: params.runId,
					fileUrl: pathToFileURL(params.scriptPath).href,
					source: params.scriptSource,
					usesDefaultExport: usesDefaultExport(params.scriptSource),
					args: params.args,
					journal: params.journal.map((entry) => (entry ? { hash: entry.hash, result: entry.result } : null)),
					maxConcurrentChildren: limits.maxConcurrentChildren,
					maxTotalAgentCalls: limits.maxTotalAgentCalls,
					maxProgressMarkers: limits.maxProgressMarkers,
					budgetTotal: null,
				},
			});
		} catch (error) {
			resolve({
				outcome: {
					status: "error",
					error: { code: "invalid_args", message: `could not start workflow worker: ${errorMessage(error)}` },
				},
				journal,
				agentCalls,
			});
			return;
		}

		const onToolAbort = (): void => {
			controller.abort();
			finish({ status: "error", error: { code: "aborted", message: "workflow run aborted by the caller" } });
		};

		const runTimer = setTimeout(() => {
			finish({
				status: "error",
				error: { code: "run_timeout", message: `workflow run exceeded ${limits.runTimeoutMs}ms` },
			});
		}, limits.runTimeoutMs);

		const finish = (outcome: WorkerRunOutcome): void => {
			if (settled) return;
			settled = true;
			clearTimeout(runTimer);
			params.signal?.removeEventListener("abort", onToolAbort);
			controller.abort();
			void worker.terminate();
			resolve({ outcome, journal, agentCalls });
		};

		const postToWorker = (message: WorkerAgentResultMessage): void => {
			if (settled) return;
			try {
				worker.postMessage(message);
			} catch {
				// The worker is already gone; nothing consumes the result.
			}
		};

		const handleAgentCall = async (message: WorkerAgentCallMessage): Promise<void> => {
			if (settled) return;
			const fallbackRef = `wf:${params.runId}:${message.index}`;
			if (message.index >= limits.maxTotalAgentCalls) {
				postToWorker({
					type: "agent:result",
					id: message.id,
					result: {
						ref: null,
						text: "",
						error_kind: null,
						kind: "not_admitted",
						error: { code: "agent_call_cap_exceeded", message: "agent call cap reached" },
					},
				});
				return;
			}

			let schemaValidator: TSchema | null = null;
			if (message.request.schema !== null && message.request.schema !== undefined) {
				const validatedSchema = validateWorkflowInlineSchema(message.request.schema);
				if (!validatedSchema.ok) {
					postToWorker({
						type: "agent:result",
						id: message.id,
						result: {
							ref: fallbackRef,
							text: "",
							error_kind: "invalid_schema",
							error: { code: "invalid_schema", message: validatedSchema.message },
						},
					});
					return;
				}
				schemaValidator = validatedSchema.schema;
			}

			const isolationShape = resolveWorkflowIsolationShape(message.request.isolation);
			if (!isolationShape.ok) {
				postToWorker({
					type: "agent:result",
					id: message.id,
					result: {
						ref: fallbackRef,
						text: "",
						error_kind: "invalid_isolation",
						error: { code: "invalid_isolation", message: isolationShape.message },
					},
				});
				return;
			}

			let isolationHandle: PreparedIsolation | null = null;
			if (isolationShape.enabled && !params.runnerHandlesIsolation) {
				const prepared = await prepareIsolationWorktree({
					worktreeRoot: params.worktreeRoot,
					baseCwd: params.cwd,
					runId: params.runId,
					callIndex: message.index,
				});
				if (!prepared.ok) {
					postToWorker({
						type: "agent:result",
						id: message.id,
						result: {
							ref: fallbackRef,
							text: "",
							error_kind: "isolation_unavailable",
							error: { code: "isolation_unavailable", message: prepared.message },
						},
					});
					return;
				}
				isolationHandle = prepared.handle;
			}

			agentCalls += 1;
			params.onAgentCall(typeof message.request.phase === "string" ? message.request.phase : null);
			let result: NormalizedChildResult;
			const isolationContext: WorkflowIsolationContext | null = isolationHandle
				? { worktreePath: isolationHandle.worktreePath, baseCwd: params.cwd }
				: null;
			try {
				const raw = await callChildRunnerWithTimeout(
					params.childRunner,
					message.request,
					{
						cwd: params.cwd,
						runId: params.runId,
						callIndex: message.index,
						signal: controller.signal,
						isolation: isolationContext,
						parent: params.parent,
					},
					limits.agentCallTimeoutMs,
				);
				result = normalizeChildResult(raw, fallbackRef);
			} catch (error) {
				const timedOut = error instanceof Error && error.name === "WorkflowChildTimeoutError";
				result = {
					ref: fallbackRef,
					text: "",
					error_kind: timedOut ? "agent_timeout" : "runner_error",
					error: {
						code: timedOut ? "agent_timeout" : "runner_error",
						message: errorMessage(error),
					},
				};
			}
			if (isolationHandle) {
				const finalized = await finalizeIsolationWorktree(isolationHandle);
				result = {
					...result,
					isolation: {
						worktree_path: isolationHandle.worktreePath,
						retained: finalized.retained,
						reason: finalized.reason,
					},
				};
			}
			if (schemaValidator && result.error_kind === null && !Value.Check(schemaValidator, result.data)) {
				result = {
					...result,
					data: null,
					error_kind: "schema_invalid",
					schema_invalid: true,
					error: {
						code: "schema_invalid",
						message: `child result did not match the inline schema: ${formatInlineSchemaErrors(schemaValidator, result.data)}`,
					},
				};
			}
			if (result.error_kind === null || result.schema_invalid === true) {
				journal[message.index] = { hash: message.requestHash, result };
			}
			postToWorker({ type: "agent:result", id: message.id, result });
		};

		worker.on("message", (raw: unknown) => {
			if (raw === null || typeof raw !== "object") return;
			const message = raw as WorkerToMainMessage;
			switch (message.type) {
				case "agent":
					void handleAgentCall(message);
					return;
				case "marker":
					params.onMarker(message.kind, message.text);
					return;
				case "done":
					try {
						finish({ status: "ok", result: JSON.parse(message.json) });
					} catch (error) {
						finish({
							status: "error",
							error: {
								code: "invalid_result",
								message: `workflow result was not valid JSON: ${errorMessage(error)}`,
							},
						});
					}
					return;
				case "error":
					finish({
						status: "error",
						error: { code: message.code ?? "script_error", message: message.message },
					});
					return;
				default:
					return;
			}
		});
		worker.on("error", (error) => {
			finish({ status: "error", error: { code: "worker_error", message: errorMessage(error) } });
		});
		worker.on("exit", (code) => {
			if (!settled) {
				finish({
					status: "error",
					error: {
						code: "worker_error",
						message: `workflow worker exited before returning a result (code ${code})`,
					},
				});
			}
		});

		if (params.signal) {
			if (params.signal.aborted) onToolAbort();
			else params.signal.addEventListener("abort", onToolAbort, { once: true });
		}
	});
}

interface WorkflowExecution {
	payload: WorkflowToolPayload;
	details: WorkflowToolDetails;
}

async function runWorkflow(
	cwd: string,
	input: WorkflowToolInput,
	options: WorkflowToolOptions | undefined,
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<WorkflowToolDetails> | undefined,
	parent: WorkflowParentRoute,
): Promise<WorkflowExecution> {
	const startedAt = Date.now();
	const workflowDir = workflowDirFor(cwd, options);
	const inProcess = options?.childRunner === undefined ? readInProcessChildRunner() : undefined;
	const inProcessLimit = inProcess?.maxConcurrent();
	const limits = {
		maxConcurrentChildren:
			typeof inProcessLimit === "number" && Number.isFinite(inProcessLimit) && inProcessLimit > 0
				? Math.min(options?.maxConcurrentChildren ?? DEFAULT_MAX_CONCURRENT_CHILDREN, inProcessLimit)
				: (options?.maxConcurrentChildren ?? DEFAULT_MAX_CONCURRENT_CHILDREN),
		maxTotalAgentCalls: options?.maxTotalAgentCalls ?? DEFAULT_MAX_TOTAL_AGENT_CALLS,
		maxProgressMarkers: options?.maxProgressMarkers ?? DEFAULT_MAX_PROGRESS_MARKERS,
		runTimeoutMs: options?.runTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS,
		agentCallTimeoutMs: options?.agentCallTimeoutMs ?? DEFAULT_AGENT_CALL_TIMEOUT_MS,
	};
	const logs: string[] = [];
	const phases: string[] = [];
	const phaseGroups: WorkflowPhaseGroup[] = [];
	let activePhase: WorkflowPhaseGroup | null = null;

	const ensurePhaseGroup = (title: string): WorkflowPhaseGroup => {
		let group = phaseGroups.find((candidate) => candidate.title === title);
		if (group === undefined) {
			group = { title, logs: [], agentCalls: 0 };
			phaseGroups.push(group);
		}
		return group;
	};

	const baseDetails = (runId: string, scriptPath?: string, scriptHash?: string): WorkflowToolDetails => ({
		runId,
		scriptPath,
		scriptHash,
		status: "error",
		agentCalls: 0,
		durationMs: Date.now() - startedAt,
		logs,
		phases,
		phaseGroups,
	});

	const fail = (
		error: WorkflowRunError,
		runId: string,
		scriptPath?: string,
		scriptHash?: string,
	): WorkflowExecution => ({
		payload: {
			runId,
			scriptPath: scriptPath === undefined ? undefined : toDisplayPath(cwd, scriptPath),
			scriptHash,
			status: "error",
			error,
			agentCalls: 0,
			durationMs: Date.now() - startedAt,
		},
		details: {
			...baseDetails(runId, scriptPath === undefined ? undefined : toDisplayPath(cwd, scriptPath), scriptHash),
			errorCode: error.code,
		},
	});

	const normalized = normalizeWorkflowInput(input);
	if (!normalized.ok) return fail(normalized.error, "");

	const registryDirs = options?.workflowRegistryDirs ?? defaultWorkflowRegistryDirs(cwd);
	const resolved = await resolveWorkflowSource({ cwd, workflowDir, registryDirs, input: normalized.value });
	if (!resolved.ok) return fail(resolved.error, normalized.value.resumeFromRunId ?? "");
	const source = resolved.source;
	let liveAgentCalls = 0;
	workflowRunStates.set(source.runId, {
		scriptPath: source.scriptPath,
		scriptHash: source.scriptHash,
		journal: source.journal,
		status: "running",
	});

	const onMarker = (kind: "log" | "phase", text: string): void => {
		if (kind === "log") {
			logs.push(text);
			activePhase?.logs.push(text);
		} else {
			phases.push(text);
			activePhase = ensurePhaseGroup(text);
		}
		try {
			onUpdate?.({
				content: [
					{
						type: "text",
						text: JSON.stringify({
							runId: source.runId,
							status: "running",
							logs: logs.slice(-5),
							phases,
							phaseGroups,
							agentCalls: liveAgentCalls,
						}),
					},
				],
				details: {
					runId: source.runId,
					scriptPath: toDisplayPath(cwd, source.scriptPath),
					scriptHash: source.scriptHash,
					status: "error",
					agentCalls: liveAgentCalls,
					durationMs: Date.now() - startedAt,
					logs,
					phases,
					phaseGroups,
				},
			});
		} catch {
			// Progress updates are advisory; a failing renderer must not fail the run.
		}
	};

	const run = await runWorkflowWorker({
		cwd,
		runId: source.runId,
		scriptPath: source.scriptPath,
		scriptSource: source.scriptSource,
		args: normalized.value.args,
		journal: source.journal,
		childRunner: options?.childRunner ?? defaultWorkflowChildRunner,
		parent,
		worktreeRoot: options?.worktreeRoot ?? join(tmpdir(), "pi-muse-worktrees"),
		runnerHandlesIsolation: inProcess !== undefined,
		signal,
		onMarker,
		onAgentCall: (phase) => {
			liveAgentCalls += 1;
			if (typeof phase === "string" && phase.length > 0) ensurePhaseGroup(phase).agentCalls += 1;
		},
		limits,
	});
	const outcome = run.outcome;
	const { journal, agentCalls } = run;
	await persistJournal(workflowDir, source.runId, source.scriptHash, journal);
	workflowRunStates.set(source.runId, {
		scriptPath: source.scriptPath,
		scriptHash: source.scriptHash,
		journal,
		status: outcome.status === "ok" ? "succeeded" : "failed",
	});

	const payload: WorkflowToolPayload = {
		runId: source.runId,
		scriptPath: toDisplayPath(cwd, source.scriptPath),
		scriptHash: source.scriptHash,
		status: outcome.status,
		result: outcome.result,
		error: outcome.error,
		agentCalls,
		durationMs: Date.now() - startedAt,
		name: normalized.value.displayName,
	};
	if (outcome.status === "ok" && typeof outcome.result === "object" && outcome.result !== null) {
		const outputRef = (outcome.result as { output_ref?: unknown }).output_ref;
		if (typeof outputRef === "string") payload.outputRef = outputRef;
	}
	return {
		payload,
		details: {
			runId: source.runId,
			scriptPath: toDisplayPath(cwd, source.scriptPath),
			scriptHash: source.scriptHash,
			status: outcome.status,
			errorCode: outcome.error?.code,
			agentCalls,
			durationMs: Date.now() - startedAt,
			logs,
			phases,
			phaseGroups,
		},
	};
}

/**
 * Create the Muse `workflow` tool.
 *
 * @param cwd Workspace root used for script persistence and child agents.
 * @param options Child runner injection plus run bounds; tests inject a stub
 *   `childRunner` so no network or model auth is required.
 */
export function createWorkflowToolDefinition(
	cwd: string,
	options?: WorkflowToolOptions,
): ToolDefinition<typeof workflowSchema, WorkflowToolDetails> {
	return {
		name: "workflow",
		label: "workflow",
		description: WORKFLOW_TOOL_DESCRIPTION,
		promptSnippet: "Orchestrate focused child agents with a deterministic JavaScript workflow",
		parameters: workflowSchema,
		constrainedSampling: { type: "json_schema", strict: "prefer" },
		async execute(_toolCallId: string, input: WorkflowToolInput, signal, onUpdate, ctx: ExtensionContext) {
			const execution = await runWorkflow(
				ctx?.cwd || cwd,
				input,
				options,
				signal,
				onUpdate,
				parentRouteFor(options, ctx),
			);
			return {
				content: [{ type: "text" as const, text: JSON.stringify(execution.payload) }],
				details: execution.details,
			};
		},
	};
}
