---
name: workflow-authoring
description: Use when authoring a non-trivial Workflow for research, review, migration, or other multi-agent work, especially when the task needs multiple evidence sources, verification, or synthesis.
user-invocable: false
---

# Workflow Authoring

Load this reference exactly once per parent session before the first non-trivial Workflow.
After a successful load, reuse that result for later Workflow authoring.
Do not call `read_skill` again after validation errors or for retries and resumes.
Select exactly one profile section from the active Workflow guidance.
Never mix symbols across profiles, and never use a call that the active
ToolSpec does not advertise.

## Shared research contract

A fixed batch count never proves completion. Scale the number and diversity of
children to the request, then stop on evidence state or an explicit caller or
runtime boundary.

For a review of a change the user has already identified, first take stock inline
of which files it touches and how large it is, then size the workflow to that
list: a small change gets a few focused children plus one verify vote, not the
full research shape.

Discovery pointers are not inspected evidence when the relevant body is
readable. Require each research child to open every implementation or test body
it cites before `submit_result` when readable; search and grep output only
locate candidates. Back every assigned claim with inspected evidence or name
it as unresolved. Ask research children for
`complete:boolean`, `evidence:string[]`, and `unresolved:string[]`; treat a
profile-specific unsuccessful result
envelope, missing or wrong-typed data, `complete !== true`, or nonempty
`unresolved` as incomplete.

Never use data from an unsuccessful envelope as evidence or a gap disposition.
Critic unavailability is a synthesis note, never a research gap. Preserve
compact evidence, provenance refs, and every unresolved item in synthesis.
Synthesize from compact `result.data`, not from uninspected summaries. Disclose
omitted scope.

Use independent verification when a claim has materially different failure
modes. Repeating the same prompt is not independent coverage.

Keep these reusable patterns when they fit the request:

- Multi-angle sweep: split initial researchers across genuinely different
  evidence surfaces, such as implementation, tests, design records, and
  operational traces; different role names do not increase coverage when they
  use the same search plan.
- Adversarial verification: give a skeptic a concrete falsification target for
  each material claim; retain only claims that survive inspected counterevidence,
  and mark an unavailable or invalid verdict unresolved.
- Judge panel: for an open solution space, generate candidates from different
  angles, score them against explicit criteria with independent judges, and
  synthesize the winner with useful runner-up ideas by provenance ref.
  A failed or invalid judge is not an affirmative vote.

## Two convergence rules

Open-ended discovery and a known evidence gap are different jobs. Do not apply
one loop rule to both.

### Example: open discovery

Maintain `seen` and `dryRounds` in deterministic Workflow state. In each round,
ask complementary finders for items not already in `seen`. Add every reported
item to `seen` before judging it:

- deduplicate against all seen items, including rejected findings;
- If a round adds any fresh item, reset the dry count to zero;
- if it adds none, increment the dry count; and
- After two consecutive dry rounds, stop discovery.

A caller limit, capacity boundary, or runtime budget may stop it earlier; that
stop is partial unless all requested scope is covered.

### Example: explicit gap follow-up

Track the lineage of each concrete unresolved gap.

- Dispatch exactly one focused follow-up for that gap lineage.
- After that attempt, carry the narrowed, reworded, or still-unresolved descendant unchanged into synthesis.
- Do not make its new wording look like a new gap and dispatch it again.

### Example: verification and omitted scope

For a claim involving behavior, abuse resistance, and a reported failure:

- use separate correctness, security, and reproduction lenses;
- give each verifier a distinct falsification target;
- State omitted scope for top-N, sampling, no-retry, capacity, caller limit, and runtime budget boundaries; and
- never describe a bounded sample as exhaustive.

## Workflow API V1

The API is available as bare globals - agent, parallel, pipeline, phase, log,
args, budget - and through the legacy host object. Use the V1 globals or their
`host` aliases described by the active ToolSpec. Read caller input from
`host.args`, the only advertised caller-input spelling.
For example, fan out independent research with `host.parallel(` and use
`host.agent` for the critic, one gap follow-up, and final synthesis:

```javascript
export default async function workflow(host) {
  const evidenceSchema = {
    type: "object",
    required: ["complete", "evidence", "unresolved"],
    properties: {
      complete: { type: "boolean" },
      evidence: { type: "array", items: { type: "string" } },
      unresolved: { type: "array", items: { type: "string" } },
    },
  };
  const compact = (result, scope, missing = `${scope}: missing complete evidence result`) => {
    const failed = result === null || result.error_kind;
    const data = !failed && result.data && typeof result.data === "object" ? result.data : null;
    const evidence = !failed && Array.isArray(data?.evidence) ? data.evidence.filter(Boolean) : [];
    const declared = !failed && Array.isArray(data?.unresolved) ? data.unresolved.filter(Boolean) : [];
    const complete = data?.complete === true && evidence.length > 0 && declared.length === 0;
    return {
      scope,
      ref: result?.ref ?? null,
      complete,
      evidence,
      unresolved: complete ? [] : (declared.length ? declared : [missing]),
    };
  };

  const reports = await host.parallel([
    { input: "Inspect the implementation body; return complete/evidence/unresolved.", schema: evidenceSchema },
    { input: "Inspect the tests; return complete/evidence/unresolved.", schema: evidenceSchema },
  ]);
  const compactReports = reports.map((result, index) => compact(result, `primary-${index}`));
  const synthesisNotes = [];
  const critic = await host.agent({
    input: `Find concrete gaps in this compact evidence: ${JSON.stringify(compactReports)}.`,
    schema: evidenceSchema,
  });
  const criticData = critic !== null && !critic.error_kind && critic.data && typeof critic.data === "object" ? critic.data : null;
  const criticEvidence = Array.isArray(criticData?.evidence) ? criticData.evidence.filter(Boolean) : [];
  const criticUnresolved = Array.isArray(criticData?.unresolved) ? criticData.unresolved.filter(Boolean) : [];
  const criticHasUsableDisposition = (criticData?.complete === true && criticEvidence.length > 0 && criticUnresolved.length === 0)
    || criticUnresolved.length > 0;
  const compactCritic = criticHasUsableDisposition
    ? compact(critic, "critic")
    : (synthesisNotes.push("completeness critic unavailable"), { scope: "critic", ref: critic?.ref ?? null, complete: true, evidence: [], unresolved: [] });
  const open = [...compactReports, compactCritic].flatMap((report) => report.unresolved);
  const firstGap = open[0];
  const followup = firstGap ? await host.agent({
    input: `Resolve this exact gap once, or return it unchanged: ${firstGap}`,
    schema: evidenceSchema,
  }) : null;
  const followupReport = firstGap ? compact(followup, firstGap, firstGap) : null;
  const all = followupReport ? [...compactReports, compactCritic, followupReport] : [...compactReports, compactCritic];
  const unresolved = firstGap ? [...open.slice(1), ...followupReport.unresolved] : open;
  const evidence = all.flatMap((report) => report.evidence.map((value) => ({ source: report.scope, ref: report.ref, value })));
  const refs = [...new Set(all.map((report) => report.ref).filter(Boolean))];
  const synthesis = await host.agent({
    input: `Synthesize only this compact evidence: ${JSON.stringify({ evidence, refs, unresolved, notes: synthesisNotes })}`,
    schema: evidenceSchema,
  });
  const synthesisFailed = synthesis === null || synthesis.error_kind;
  const synthesisData = !synthesisFailed && synthesis.data && typeof synthesis.data === "object" ? synthesis.data : null;
  const synthesisUnresolved = Array.isArray(synthesisData?.unresolved) ? synthesisData.unresolved.filter(Boolean) : [];
  const synthesisComplete = synthesisData?.complete === true
    && Array.isArray(synthesisData.evidence)
    && synthesisData.evidence.length > 0
    && synthesisUnresolved.length === 0;
  if (!synthesisComplete) synthesisNotes.push("synthesis unavailable or incomplete");
  return { status: unresolved.length || synthesisUnresolved.length || synthesisNotes.length > 0 ? "partial" : "complete", ref: synthesis?.ref ?? null, unresolved: [...unresolved, ...synthesisUnresolved], notes: synthesisNotes };
}
```

Wrap the shared discovery and gap-lineage state machine around these calls when
the request needs it. Use compact structured results and refs; follow the V1
ToolSpec for schemas, budgets, isolation, failures, and return shape.

## Diagnostic Workflow API V2

The diagnostic script surface is exactly Agent, Phase, Pipeline, ParallelGroup,
WorkflowCommandError, log, args, and budget. This profile is fresh-run and
terminal-only. Use deferred work inside the diagnostic containers for
parallelism, then read immutable results:

```javascript
const evidenceSchema = {
  type: "object",
  required: ["complete", "evidence", "unresolved"],
  properties: {
    complete: { type: "boolean" },
    evidence: { type: "array", items: { type: "string" } },
    unresolved: { type: "array", items: { type: "string" } },
  },
};
const group = await ParallelGroup.start({
  members: [
    Agent.defer.start({ input: "Inspect the implementation body; return complete/evidence/unresolved.", schema: evidenceSchema }),
    Agent.defer.start({ input: "Inspect the tests; return complete/evidence/unresolved.", schema: evidenceSchema }),
  ],
});
const reports = await group.result();
const fromAttemptOutcome = (outcome, scope) => {
  if (outcome?.kind !== "attempt" || !outcome.result?.ref) {
    return { scope, ref: null, complete: false, evidence: [], unresolved: [`${scope}: no completed attempt result`] };
  }
  const result = outcome.result;
  const ref = outcome.result.ref;
  const data = result?.data && typeof result.data === "object" ? result.data : null;
  const terminalOk = result.status === "completed" && result.ok === true && result.error == null && data !== null;
  const evidence = terminalOk && Array.isArray(data.evidence) ? data.evidence.filter(Boolean) : [];
  const declared = terminalOk && Array.isArray(data.unresolved) ? data.unresolved.filter(Boolean) : [];
  const complete = terminalOk && data.complete === true && evidence.length > 0 && declared.length === 0;
  return {
    scope,
    ref,
    complete,
    evidence: terminalOk ? evidence : [],
    unresolved: complete ? [] : (declared.length ? declared : [`${scope}: no completed attempt result`]),
  };
};
const compactReports = reports.map((outcome, index) => fromAttemptOutcome(outcome, `parallel-${index}`));
const pipeline = await Pipeline.start({
  items: reports,
  stages: [{
    title: "Check",
    run: ({ item, index }) => {
      if (item?.kind !== "attempt" || !item.result?.ref) {
        return { complete: false, evidence: [], unresolved: [`parallel-${index}: missing result ref`] };
      }
      return Agent.defer.start({ input: `Verify the evidence behind ${item.result.ref}; return complete/evidence/unresolved.`, schema: evidenceSchema });
    },
  }],
});
const checked = await pipeline.result();
const synthesisNotes = [];
const checkedReports = checked.map((item, index) => {
  if (item?.kind !== "completed" || !item.output?.ref) {
    return { scope: `pipeline-${index}`, ref: null, complete: false, evidence: [], unresolved: [`pipeline-${index}: not completed`] };
  }
  const data = item.output.data && typeof item.output.data === "object" ? item.output.data : null;
  const outputOk = item.output.status === "completed" && item.output.ok === true && item.output.error == null && data !== null;
  const evidence = outputOk && Array.isArray(data.evidence) ? data.evidence.filter(Boolean) : [];
  const declared = outputOk && Array.isArray(data.unresolved) ? data.unresolved.filter(Boolean) : [];
  const complete = outputOk && data.complete === true && evidence.length > 0 && declared.length === 0;
  return {
    scope: `pipeline-${index}`,
    ref: item.output.ref,
    complete,
    evidence: outputOk ? evidence : [],
    unresolved: complete ? [] : (declared.length ? declared : [`pipeline-${index}: missing structured output`]),
  };
});
const unresolved = [...compactReports, ...checkedReports].flatMap((report) => report.unresolved);
const refs = [...compactReports, ...checkedReports].map((report) => report.ref).filter(Boolean);
const evidence = [...compactReports, ...checkedReports].flatMap((report) => report.evidence.map((value) => ({ source: report.scope, ref: report.ref, value })));
const critic = await Agent.start({ input: `Find concrete gaps in this compact evidence: ${JSON.stringify({ evidence, refs, unresolved })}.`, schema: evidenceSchema });
const gaps = await critic.latestAttempt.result();
const criticData = gaps?.data && typeof gaps.data === "object" ? gaps.data : null;
const criticTerminalOk = gaps?.status === "completed"
  && gaps?.ok === true
  && gaps?.error == null
  && criticData !== null;
const criticGaps = criticTerminalOk && Array.isArray(criticData.unresolved) ? criticData.unresolved.filter(Boolean) : [];
if (criticTerminalOk && Array.isArray(criticData.evidence)) {
  evidence.push(...criticData.evidence.filter(Boolean).map((value) => ({ source: "critic", ref: gaps.ref, value })));
}
const criticComplete = criticTerminalOk
  && criticData?.complete === true
  && Array.isArray(criticData.evidence)
  && criticData.evidence.length > 0
  && Array.isArray(criticData.unresolved)
  && criticData.unresolved.length === 0;
if (!criticComplete && criticGaps.length === 0) {
  synthesisNotes.push("completeness critic unavailable");
}
const open = [...unresolved, ...criticGaps];
const firstGap = open[0];
let gapResult = null;
let gapDescendants = [];
if (firstGap) {
  const resolver = await Agent.start({ input: `Resolve this exact gap once, or return it unchanged: ${firstGap}`, schema: evidenceSchema });
  gapResult = await resolver.latestAttempt.result();
  const gapData = gapResult?.data && typeof gapResult.data === "object" ? gapResult.data : null;
  const gapTerminalOk = gapResult?.status === "completed"
    && gapResult?.ok === true
    && gapResult?.error == null
    && gapData !== null;
  const reportedDescendants = gapTerminalOk && Array.isArray(gapData.unresolved) ? gapData.unresolved.filter(Boolean) : [];
  if (gapTerminalOk && Array.isArray(gapData.evidence)) {
    evidence.push(...gapData.evidence.filter(Boolean).map((value) => ({ source: firstGap, ref: gapResult.ref, value })));
  }
  const gapComplete = gapTerminalOk
    && gapData?.complete === true
    && Array.isArray(gapData.evidence)
    && gapData.evidence.length > 0
    && reportedDescendants.length === 0;
  if (!gapComplete) gapDescendants = reportedDescendants.length > 0 ? reportedDescendants : [firstGap];
}
const finalUnresolved = firstGap ? [...open.slice(1), ...gapDescendants] : open;
const synthesisRefs = [...refs, gaps?.ref, gapResult?.ref].filter(Boolean);
const synthesisAgent = await Agent.start({
  input: `Synthesize only this compact evidence: ${JSON.stringify({ evidence, refs: synthesisRefs, unresolved: finalUnresolved, notes: synthesisNotes })}`,
  schema: evidenceSchema,
});
const synthesis = await synthesisAgent.latestAttempt.result();
const synthesisData = synthesis?.data && typeof synthesis.data === "object" ? synthesis.data : null;
const synthesisTerminalOk = synthesis?.status === "completed"
  && synthesis?.ok === true
  && synthesis?.error == null
  && synthesisData !== null;
const synthesisGaps = synthesisTerminalOk && Array.isArray(synthesisData.unresolved) ? synthesisData.unresolved.filter(Boolean) : [];
const synthesisComplete = synthesisTerminalOk
  && synthesisData?.complete === true
  && Array.isArray(synthesisData.evidence)
  && synthesisData.evidence.length > 0
  && synthesisGaps.length === 0;
if (!synthesisComplete) synthesisNotes.push("synthesis unavailable or incomplete");
return { status: finalUnresolved.length || synthesisGaps.length || synthesisNotes.length > 0 ? "partial" : "complete", ref: synthesis?.ref ?? null, reports: synthesisRefs, unresolved: [...finalUnresolved, ...synthesisGaps], notes: synthesisNotes };
```

Wrap the shared discovery and gap-lineage state machine around these calls when
needed. Do not invent durable control or recovery methods in this profile.

## Live Workflow API V2

The live Workflow API V2 surface in this activation slice is the Agent and
AgentAttempt path. Start each independent worker, then observe the exact
attempt. Use a follow-up only for an explicit gap lineage that has not already
received one:

```javascript
const evidenceSchema = {
  type: "object",
  required: ["complete", "evidence", "unresolved"],
  properties: {
    complete: { type: "boolean" },
    evidence: { type: "array", items: { type: "string" } },
    unresolved: { type: "array", items: { type: "string" } },
  },
};
const agent = await Agent.start({ input: "Inspect the implementation body; return complete/evidence/unresolved.", schema: evidenceSchema });
const tests = await Agent.start({ input: "Inspect the tests; return complete/evidence/unresolved.", schema: evidenceSchema });
const workers = [agent, tests];
const reports = await Promise.all([
  agent.latestAttempt.result(),
  tests.latestAttempt.result(),
]);
const compact = (result, scope) => {
  const data = result?.data && typeof result.data === "object" ? result.data : null;
  const terminalOk = result.status === "completed" && result.ok === true && result.error == null && data !== null;
  const evidence = terminalOk && Array.isArray(data.evidence) ? data.evidence.filter(Boolean) : [];
  const declared = terminalOk && Array.isArray(data.unresolved) ? data.unresolved.filter(Boolean) : [];
  const complete = terminalOk && data.complete === true && evidence.length > 0 && declared.length === 0;
  return {
    scope,
    ref: result?.ref ?? null,
    complete,
    evidence: terminalOk ? evidence : [],
    unresolved: complete ? [] : (declared.length ? declared : [`${scope}: missing complete evidence result`]),
  };
};
const compactReports = reports.map((result, index) => compact(result, `primary-${index}`));
const synthesisNotes = [];
const primaryRefs = compactReports.map((report) => report.ref).filter(Boolean);
const evidence = compactReports.flatMap((report) => report.evidence.map((value) => ({ source: report.scope, ref: report.ref, value })));
const primaryGaps = compactReports.flatMap((report) => report.unresolved);
const critic = await Agent.start({
  input: `Find concrete gaps in this compact evidence: ${JSON.stringify({ evidence, refs: primaryRefs, unresolved: primaryGaps })}.`,
  schema: evidenceSchema,
});
const criticResult = await critic.latestAttempt.result();
const criticData = criticResult?.data && typeof criticResult.data === "object" ? criticResult.data : null;
const criticTerminalOk = criticResult?.status === "completed"
  && criticResult?.ok === true
  && criticResult?.error == null
  && criticData !== null;
const criticGaps = criticTerminalOk && Array.isArray(criticData.unresolved) ? criticData.unresolved.filter(Boolean) : [];
if (criticTerminalOk && Array.isArray(criticData.evidence)) {
  evidence.push(...criticData.evidence.filter(Boolean).map((value) => ({ source: "critic", ref: criticResult.ref, value })));
}
const criticComplete = criticTerminalOk
  && criticData?.complete === true
  && Array.isArray(criticData.evidence)
  && criticData.evidence.length > 0
  && criticGaps.length === 0;
if (!criticComplete && criticGaps.length === 0) {
  synthesisNotes.push("completeness critic unavailable");
}
const open = [...primaryGaps, ...criticGaps];
const gapOwner = compactReports.findIndex((report) => report.unresolved.length > 0);
const firstGap = gapOwner >= 0 ? compactReports[gapOwner].unresolved[0] : (criticGaps[0] ?? null);
const gapAgent = gapOwner >= 0 ? workers[gapOwner] : critic;
const gapDescendants = [];
let followupRef = null;
if (firstGap) {
  const followupAttempt = await gapAgent.followup({ input: `Resolve this exact gap once, or return it unchanged: ${firstGap}` });
  const followupResult = await followupAttempt.result();
  followupRef = followupResult?.ref ?? null;
  const data = followupResult?.data && typeof followupResult.data === "object" ? followupResult.data : null;
  const followupTerminalOk = followupResult?.status === "completed"
    && followupResult?.ok === true
    && followupResult?.error == null
    && data !== null;
  const reportedDescendants = followupTerminalOk && Array.isArray(data.unresolved) ? data.unresolved.filter(Boolean) : [];
  if (followupTerminalOk && Array.isArray(data.evidence)) {
    evidence.push(...data.evidence.filter(Boolean).map((value) => ({ source: firstGap, ref: followupResult.ref, value })));
  }
  const descendants = reportedDescendants.length > 0 ? reportedDescendants : [firstGap];
  const followupComplete = followupTerminalOk
    && data?.complete === true
    && Array.isArray(data.evidence)
    && data.evidence.length > 0
    && reportedDescendants.length === 0;
  if (!followupComplete) gapDescendants.push(...descendants);
}
const unresolved = firstGap ? [...open.slice(1), ...gapDescendants] : open;
const synthesisRefs = [...primaryRefs, criticResult?.ref, followupRef].filter(Boolean);
const synthesis = await Agent.start({
  input: `Synthesize only this compact evidence: ${JSON.stringify({ evidence, refs: synthesisRefs, unresolved, notes: synthesisNotes })}`,
  schema: evidenceSchema,
});
const final = await synthesis.latestAttempt.result();
const finalData = final?.data && typeof final.data === "object" ? final.data : null;
const finalTerminalOk = final?.status === "completed"
  && final?.ok === true
  && final?.error == null
  && finalData !== null;
const finalUnresolved = finalTerminalOk && Array.isArray(finalData.unresolved) ? finalData.unresolved.filter(Boolean) : [];
const finalOk = finalTerminalOk
  && finalData?.complete === true
  && Array.isArray(finalData.evidence)
  && finalData.evidence.length > 0
  && Array.isArray(finalData.unresolved)
  && finalData.unresolved.length === 0;
if (!finalOk) synthesisNotes.push("synthesis unavailable or incomplete");
return { status: unresolved.length || finalUnresolved.length || synthesisNotes.length > 0 || !finalOk ? "partial" : "complete", ref: final?.ref ?? null, unresolved: [...unresolved, ...finalUnresolved], notes: synthesisNotes };
```

Read structured child data from `result.data`, including `data.unresolved`; the
top-level result object is only the envelope. To stop a whole launched run
from the parent conversation, call `work_stop` with `work_id` set to the
`workId` from the launch result when that tool is available. `interrupt()` stops
only one live child attempt: check `agent.latestAttempt.getStatus()` and call
`agent.latestAttempt.interrupt()` before awaiting
`agent.latestAttempt.result()`. After `result()` resolves, the attempt is
terminal.

For later-owner recovery, invoke the Workflow tool with the returned
`scriptPath` and `resumeFromRunId`; do not add those fields to the script API.
Wrap the shared discovery and gap-lineage state machine around the Agent calls,
and preserve unresolved descendants unchanged at the final boundary.
