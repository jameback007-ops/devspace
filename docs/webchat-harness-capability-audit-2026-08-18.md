# WebChat Harness Capability Audit and Development Record

Date: 2026-08-18
Candidate branch: `agent/webchat-harness-capability-rd-20260818`
Candidate base: ZES Nexus/DevSpace `5d7929ac1250a913d070c2c2ec0c2e01e9b2e0fa`
Fresh integration target reconciled and validated: `ab504b63091a7abe723b6bc9a88e31805bb164dd`
Live package at audit start: `1.0.7-zes.4`

## Purpose

This audit evaluates the local ChatGPT WebChat/DevSpace harness as an execution
environment for long-running AOQ and ZES development. It is not a gap-only
inventory. Every incumbent capability is classified by current quality:

- **KEEP** when its lifecycle and failure semantics are already strong;
- **MATERIALLY IMPROVE / REPLACE** when an incumbent exists but has a
  correctness, boundedness, recovery, or maintainability defect;
- **ADD** when a missing capability has clear leverage and a clean authority
  boundary;
- **DEFER / REJECT** when upstream is still moving, evidence is weak, or the
  capability would create a competing source of truth.

Conceptual overlap with ZES product/runtime is not itself a reason to reject a
harness capability. The deciding criteria are execution quality, leverage,
maintainability, composability, and whether authority remains explicit.

## Live-system baseline inspected

The audit started from the deployed and source state, not from this brief.

- Live Nexus reported source commit `5d7929ac...`, package
  `1.0.7-zes.4`, and a matching deployment/tool-surface fingerprint.
- Development was isolated in a managed worktree; the live checkout, service,
  writer, and deployment were not mutated.
- The concurrent `devspace-harness-hardening-and-worktree-gc` scope had already
  added persisted workspace lifecycle, status/close/GC, and stronger process
  output accounting. Those seams were treated as incumbent capability, not
  reimplemented.
- The concurrent `zes_continuation_preflight` scope had an independent
  read-only preflight candidate. Coordination confirmed only a mechanical
  `server.ts` overlap and no overlap in recovery/event semantics.
- ZES architecture and state-authority definitions were inspected before
  design. Product-owned `ContextLease`, `ContextManifest`, canonical work,
  memory, effect, and acceptance state remain outside DevSpace authority.
- The repository execution accelerator profile was inspected. Serena, Pants,
  Graphify, Context7, Exa, continuation hydration, and related routes remain
  reusable accelerators rather than targets for duplicate scripts.
- The installed AgentDock challenger was inspected as operational evidence,
  not source authority. Its core/supplemental smoke evidence passed checkout,
  worktree, process, audit, path-containment, interruption, and cleanup cases.

## Evaluation dimensions

Capabilities were judged on the following properties rather than feature
count:

1. **Correctness under interruption** — an abrupt cutoff must not manufacture
   completion or hide an indeterminate effect.
2. **Boundedness** — broad workspaces, output streams, context inventories, and
   evidence queries must have explicit limits and explicit incompleteness.
3. **Recovery fidelity** — a successor must distinguish semantic checkpoint
   state, current mechanical state, and later executor activity.
4. **Authority safety** — local evidence must not silently become canonical
   work, memory, writer, effect, or publication authority.
5. **Inspectability** — state and omissions must be machine-readable, not only
   prompt prose.
6. **Composability** — capabilities should reuse durable primitives and remain
   separable from providers and product runtime.
7. **Maintainability** — prefer upstream adaptation or small derived
   projections over parallel custom engines.
8. **Long-running ergonomics** — continuation, worktree reuse, process polling,
   coordination, and validation must remain usable over many turns.

## Upstream patterns evaluated

### LangGraph

Current LangGraph persistence separates thread checkpoints, pending writes,
task results, interrupts, resume input, and replay/checkpoint identity. Its
important transferable pattern is not “use a graph everywhere”; it is:

> durable state snapshot + explicit successor writes/events + deterministic or
> idempotent replay boundaries.

DevSpace already has durable scope events, process sessions, local-agent queue
state, and Git-bound recovery capsules. Importing a second graph runtime would
duplicate lifecycle authority. The valuable adaptation is to make successor
event evidence visible beside the explicit capsule.

### CrewAI Flows

CrewAI Flows expose persisted structured state, event listeners, routing,
human-feedback pending state, and resume. The useful pattern is an explicit
lifecycle transition and a resumable pending condition. DevSpace already uses
explicit queue/lease/indeterminate states and mailbox receipts. Recreating the
Crew/Flow abstraction would add ceremony without improving the current
authority model.

### Claude Code

Claude Code's lifecycle hooks cover session start/resume, tool boundaries,
subagent boundaries, worktrees, compaction, and task completion. Subagents can
have bounded tools, permissions, skills, model choice, memory, and isolation.
The transferable lessons are:

- context injected only at session start can become stale;
- lifecycle boundaries should be observable and machine-readable;
- delegation should carry explicit tools, permissions, isolation, and resume
  identity;
- compaction/resume should have a deliberate continuation payload.

DevSpace already has many equivalent primitives. The remaining leverage is in
freshness-aware context assembly and better delegated-run evidence, not a
prompt-hook clone.

### Codex and Codex App Server

Codex provides explicit thread resume/fork, interruption markers, sandbox and
workspace boundaries, and parallel execution. App Server realtime events are
useful during a live turn but are not themselves a durable replay contract.
The transferable pattern is to distinguish a durable thread/checkpoint from
ephemeral streaming events and to retain receipts needed after interruption.

### OpenHands

OpenHands uses a central action/observation event stream with persisted state.
Its persistence model separates an autosaved base state from incrementally
appended events. This matches the direction chosen here:

- the recovery capsule remains the explicit semantic snapshot;
- execution-scope events remain sanitized operational evidence;
- the recovery projection joins them without allowing events to rewrite the
  semantic checkpoint.

### AgentDock variants

The local challenger showed that AgentDock-style installation can provide a
usable core coding surface and safe path/process handling. It did not provide
evidence strong enough to replace DevSpace's current durable queue, capsule,
mailbox, tool-surface, and ZES-specific authority integration. It remains a
comparison target rather than a source owner.

### Current DevSpace upstream

At audit time upstream `main` was v1.0.7 at `b5b4ab62...`.

- PR #197 adds bounded nested instruction discovery. It is high leverage,
  narrow, independently testable, and was adapted in this candidate.
- PR #188 introduces a daemon/runtime pool and remains active.
- PR #207 adds typed provider-error foundations on top of the runtime work and
  was not yet independently mergeable.
- PR #178 strengthens change review and is a useful follow-up candidate.
- PR #201 modernizes MCP integration and should be reconciled after its
  interaction with the ZES fork is understood.

The candidate does not cherry-pick an upstream branch wholesale. It adapts the
relevant semantics to the ZES fork and preserves fork-owned capabilities.

## Capability quality decisions

| Capability | Decision | Evidence and action |
| --- | --- | --- |
| Explicit checkout/worktree isolation and path containment | **KEEP** | Strong boundary, managed worktree identity, source-dirty disclosure, tests for aliases/outside roots. |
| Persisted workspace status/close/GC | **KEEP / reconcile** | Newly hardened in `5d7929ac`; no competing implementation added. Integration must rebase on its live owner. |
| Root and nested instruction bootstrap | **MATERIALLY IMPROVE** | Existing recursive scan was unbounded and synchronous. Replaced by bounded, fail-explicit discovery in this candidate. |
| Skill/accelerator discovery | **KEEP** | Existing contextual skills plus host search and repository accelerator profile are composable. Avoid ad-hoc fallback scripts. |
| Tool-surface fingerprint/freshness | **KEEP** | Exact SDK descriptor fingerprint and deployment epoch provide a strong capability-discovery boundary. |
| Process sessions and output polling | **KEEP + improve receipts** | Existing running session, long poll, byte/digest/sequence fields are strong. Their safe receipts are now retained in execution evidence. |
| Execution-scope audit | **KEEP + improve composition** | Durable sanitized events already exist. They are now composed into recovery rather than exposed only through a separate audit call. |
| Git-bound recovery capsule | **KEEP** | Explicit semantic state, idempotency, workspace fingerprint, authority-ref reconciliation, and no task/effect authority are strong. |
| Post-capsule recovery evidence | **ADD by adapting incumbent primitives** | Previously only boolean/time-level activity was visible. Candidate adds bounded event receipts and completeness signals. |
| Execution-scope messaging/receipts | **KEEP** | Provider-neutral delivery at a target's next MCP boundary is useful for coordination without transcript coupling. |
| Local-agent queue/lease/indeterminate recovery | **KEEP** | Durable queue and reconciliation are higher quality than a new Crew/graph implementation. |
| Local-agent daemon/pool and typed provider failures | **DEFER upstream reconciliation** | #188/#207 are moving and stacked. Porting now would create high merge and lifecycle risk. |
| Planning/workflow graph engine | **REJECT for now** | Model planning plus durable queue/capsule/events already cover the local harness boundary. A second graph authority would duplicate ZES/Hatchet/runtime concepts without evidence of added quality. |
| Change review independent of widget mode | **MATERIALLY IMPROVE next** | Review checkpoints exist, but headless/final validation receipts should be available without relying on a particular widget configuration. Reconcile #178. |
| Provider-neutral context/evidence manifest | **ADD next as derived read model** | ZES PKG-05 and ContextManifest authority should be read/adapted. DevSpace may produce an executor snapshot with source refs, omissions, freshness, and digests, but not a second ContextLease or canonical context owner. |
| Artifact/evidence manifest | **ADD next** | Existing artifact tools and diff cards are useful, but a bounded manifest connecting artifacts, validation receipts, Git state, and capsule refs would improve handoff. |
| Automatic self-modification from traces | **DEFER** | First build a measured feedback-to-backlog loop. Unreviewed runtime self-rewrite would weaken authority and validation. |

## Implemented capability 1: bounded workspace instruction discovery

### Defect in the incumbent

`open_workspace` previously performed a recursive descendant walk to discover
every nested `AGENTS.md`/`CLAUDE.md`. The walk had no file-count limit, path-byte
budget, or time budget. A broad monorepo or accidental high-level root could:

- delay or hang the first MCP workspace response;
- consume memory proportional to the descendant tree;
- return a very large context catalog;
- fail without a structured statement that discovery was incomplete.

This defect directly affects long-running WebChat work because the model cannot
start correct project work until `open_workspace` returns.

### Candidate behavior

The candidate adds `src/workspace-instruction-discovery.ts` and adapts upstream
PR #197 with the following contract:

- use `fd` when available and a bounded-concurrency Node fallback otherwise;
- skip VCS, dependency, generated-build, and cache directories;
- preserve the supported exact filename/casing contract;
- cap nested instruction files at 100;
- cap returned relative-path bytes at 16 KiB;
- cap discovery at two seconds;
- discard partial results if any bound is exceeded;
- return `instructionDiscovery.status = "incomplete"` with either
  `deadline_exceeded` or `result_limit_exceeded`;
- tell the executor to open the narrower project directory before working
  inside the omitted tree;
- retain one bounded snapshot for a reused in-memory checkout so context does
  not silently change between repeated opens in the same conversation;
- expose the result consistently in structured MCP output, card metadata, UI,
  and tool-call logs.

### Why discarding partial results is correct

A partial list that looks complete is more dangerous than an explicit omission:
the executor may enter a subtree without reading its controlling instructions.
The new contract therefore fails explicit and narrow rather than silently
degrading context correctness.

### AOQ/ZES impact

- Broad roots no longer make workspace startup depend on an unbounded tree.
- A missing nested instruction is represented as an omission, not false
  completeness.
- The executor receives an actionable narrowing step.
- Reused sessions retain stable bootstrap context rather than observing an
  unexplained catalog drift.

## Implemented capability 2: evidence-grade recovery delta

### Defect in the incumbent

The existing recovery capsule is high quality as an explicit semantic and
Git-bound checkpoint. `execution_scope_status` also reported whether later
activity or a possible mutation occurred. However, after a server cutoff or
handoff, a successor could not answer from the recovery projection itself:

- which tools ran after the capsule;
- whether a process produced additional output;
- which output segment/digest was observed;
- which files an `apply_patch` changed;
- whether the visible evidence window is complete or retention-limited.

The separate audit tool contained some of this information, but response
summaries omitted process output receipts and patch result receipts. Recovery
therefore required extra calls and inference.

### Candidate behavior

The candidate strengthens the existing event/capsule composition without a new
database, checkpoint engine, task store, or workflow authority.

Execution event response summaries now retain only bounded safe receipts:

- process running/exit/signal/wall-time state;
- output delta and total byte counts;
- SHA-256 digests for delta and total output;
- output event count and sequence range;
- output completeness/truncation flags;
- patch addition/removal counts;
- at most 50 patch file receipts containing path, previous path, and operation.

They continue to exclude:

- raw commands;
- raw process output;
- patch bodies;
- prompts, private reasoning, credentials, and arbitrary result text.

`semanticRecovery.evidenceSinceCapsule` now provides:

- aggregate retained event and outcome counts;
- per-tool counts;
- the latest 20 sanitized successor events, ordered chronologically within the
  returned window;
- the capsule event sequence and newest retained sequence;
- an explicit truncation flag;
- whether the capsule's own event remains retained;
- a completeness classification distinguishing a complete retained window,
  a retained-only window after anchor pruning, and evidence that has been
  pruned or is unavailable.

The event evidence cannot modify the capsule's semantic mission, next action,
authority, writer, effect, or publication fields. It is local executor evidence
only.

### AOQ/ZES impact

- A successor can see the exact sanitized executor delta after a checkpoint
  without reconstructing it from filenames or process guesses.
- Long-running process output can be correlated by digest and sequence even if
  the output text is intentionally absent.
- Patch scope is inspectable after interruption without storing the patch body.
- Recovery can state when receipts are truncated or retention-limited instead
  of implying completeness.
- ZES authority remains intact: the evidence says what the local executor did,
  not whether canonical work was accepted or an effect succeeded.

## Authority and composition invariants

This candidate intentionally preserves the following boundaries:

1. DevSpace recovery is executor-local evidence, not canonical task or decision
   authority.
2. A fresh Git/worktree fingerprint does not prove current ZES/PG/runtime/effect
   state.
3. Event receipts cannot rewrite an explicit semantic capsule.
4. A capsule or event receipt does not grant a writer lease, effect retry,
   publication permission, or acceptance authority.
5. ZES `ContextLease`, `ContextManifest`, canonical WorkingSet/Handoff, memory,
   and product continuation remain owned by their architecture-defined owners.
6. Future executor context snapshots must be derived from authoritative refs
   and expose omissions/freshness; they must not become a second source of
   truth.
7. No live service restart, deployment, main-branch mutation, or publication is
   part of this candidate.

## Validation evidence at this checkpoint

Focused and repository-wide validation completed successfully:

- TypeScript typecheck.
- Six bounded-discovery unit tests covering exact filenames, skipped trees,
  symlinks, count/byte limits, deadlines, and competing-limit precedence.
- Workspace registry tests.
- Conversation reuse and stable instruction-snapshot tests.
- UI card expansion tests for incomplete discovery.
- MCP server black-box test proving 101 nested instruction files return only
  root context plus a structured incomplete reason.
- Execution-observability tests proving process digest/sequence receipts and
  patch file receipts are retained without raw command/patch/result text.
- Turn-continuity test with 25 post-capsule events proving only the latest 20
  receipts are returned, chronological order is preserved, truncation is
  explicit, and raw process output is absent.
- MCP cross-scope recovery test proving zero events immediately after the
  capsule and one sanitized `read` receipt after later activity.
- Full `npm test` suite: pass, with the existing platform-specific macOS alias
  case skipped and no failures.
- Production `npm run build`: pass. Vite retained its existing advisory that
  several generated UI chunks exceed 500 KiB; this is not caused by or treated
  as a correctness failure for this candidate.
- `git diff --check`: pass.

The candidate was then rebased onto fresh `owner/main` at `ab504b63...`, which
includes the fixed-route continuation-preflight capability. The only merge
conflict was the shared `package.json` test command; both test registrations
were preserved and `src/server.ts` merged without conflict. Post-rebase
typecheck, the full test suite, production build, and diff checks all passed.
The candidate is validated but remains isolated and is not deployed or
published to `owner/main` by this record.

## Highest-value follow-up work

### 1. Provider-neutral bounded hydration snapshot

Adapt ZES PKG-05 rather than creating a second memory/context plane. A harness
snapshot should identify:

- source authority refs and freshness;
- selected context and explicit omissions;
- workspace/Git/capsule/evidence refs;
- relevant accelerator/tool-surface epoch;
- validation and effect-safety receipts;
- a bounded next-action candidate that remains subordinate to current
  authority readback.

This should be generated at material boundaries, not every read.

### 2. Headless review and validation receipts

Reconcile upstream PR #178 and existing review checkpoints so every execution
mode can request a final machine-readable change/validation receipt without
depending on a particular widget mode. The receipt should bind command, exit,
output digest, affected files, Git state, and capsule/evidence refs without
storing unrestricted output.

### 3. Runtime/provider lifecycle reconciliation

Track upstream PR #188 and #207 until the daemon/pool and typed provider-error
contracts stabilize. Then adapt:

- typed retryability and indeterminate failure classes;
- provider-session identity and resume evidence;
- worker lifecycle events;
- cancellation/interrupt receipts;
- health and capacity reporting.

Do not port an unstable runtime wholesale into the ZES fork.

### 4. Artifact/evidence manifest

Add a bounded executor-local manifest that connects generated artifacts,
checksums, source refs, validation receipts, Git state, and recovery capsule.
The manifest should improve handoff and download correctness without becoming
canonical product state.

### 5. Delegation quality and feedback loop

Use the existing durable local-agent queue rather than a new Crew/graph layer.
Improve delegation briefs, budget/tool constraints, evidence return, resume
identity, and evaluator feedback. Feed measured failures and repeated manual
recovery steps into a reviewed harness backlog before attempting any automatic
self-modification.

## Integration rule

Before integration:

1. fetch current `owner/main`;
2. confirm the two concurrent DevSpace scopes and live deployment state;
3. rebase/reconcile this candidate on the exact fresh main;
4. resolve the expected mechanical `server.ts`/`package.json` overlap with
   continuation preflight without dropping either capability;
5. rerun typecheck, full tests, build, and diff checks;
6. hand the validated commit to the live Nexus owner for deployment/probe, or
   publish only under an explicitly acquired integration boundary.
