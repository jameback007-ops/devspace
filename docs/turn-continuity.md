# Turn Continuity and Recovery Capsules

DevSpace separates mission continuity from assistant-turn duration. A model may
replan dynamically, cross task boundaries, follow blockers, and preserve full
verification quality while still leaving a clean recovery frontier before an
unknown host cutoff.

The feature has two independent parts:

- the **turn horizon** supplies advisory timing only;
- a **recovery capsule** stores a bounded, Git-bound executor handoff.

Neither part is task, decision, writer, effect, publication, checkpoint-store,
workflow, or canonical-memory authority.

## Advisory Horizon

An exact host may attach:

- `devspace/executor-turn` — one opaque value shared by every tool call in one
  assistant turn;
- `devspace/executor-deadline-ms` — an absolute Unix-millisecond deadline; or
- `devspace/executor-deadline-at` — an absolute ISO-8601 deadline.

The raw turn value is never persisted. DevSpace exposes only a non-reversible
`turnRef`. A new exact turn value starts a new advisory epoch automatically.

When the host supplies no turn identity, call `turn_horizon_begin` once near the
first tool call of every assistant turn. Its idempotency key prevents a retried
begin call from resetting the same epoch. A different key intentionally begins
the next epoch. Conversation scope and conversation age are never treated as
assistant-turn identity.

The default estimated horizon is 120 minutes:

- at 95 minutes, one `checkpoint_awareness` notice is emitted;
- at 110 minutes, one `landing_opportunity` notice is emitted.

An exact host deadline uses equivalent lead windows. Passing the estimate or
deadline does not change tool availability. There is no `DRAIN`,
`YIELD_REQUIRED`, or blocked-tool state.

The model should interpret a landing opportunity as:

> Continue the current local causal chain to the nearest recoverable cut. Do
> not rush task completion, weaken validation, force a commit, retry an effect,
> or abandon the mission. Record a current capsule, then end only the assistant
> turn.

### One-shot adoption guidance

After `turn_horizon_begin` (or exact host turn metadata), the first successful
explicit file/artifact mutation in a turn may append one
`[recovery capsule available]` notice when that turn has not yet recorded a
capsule. The notice is deliberately limited to `apply_patch`, write/edit
primitives, and artifact download; ordinary reads and generic shell inspection
do not trigger it.

The notice does not require an immediate capsule. It tells the model to continue
the current causal chain and record a rolling capsule at the next natural
material transition, once mission/frontier semantics are established. It never
blocks tools, forces a commit, changes task priority, reduces validation, or
grants authority. One notice is emitted per advisory turn epoch.

Older host conversations may retain a cached MCP schema that predates the
capsule tools. A fresh host connection is required before relying on this
adoption path; the server does not infer semantic state for an old scope that
cannot explicitly record it. `execution_scope_list`,
`execution_scope_status`, and `execution_scope_audit` expose the current
backend tool-surface fingerprint and critical recovery-tool registration so a
missing host-visible capsule tool can be classified as a catalog/connector
freshness problem rather than mistaken for absent backend implementation. The
server still cannot read the client's cached catalog or refresh it on the
client's behalf.

## Recovery Capsule

`recovery_capsule_record` accepts semantic recovery state such as:

- mission and current frontier;
- rightful authority-owner refs and exact observed authority-state refs;
- current local causal slice;
- what was actually established;
- validation state and receipt references;
- intentional dirty/clean worktree classification;
- writer and effect state;
- exact effect keys and retry policy;
- whether mutation or publication is currently safe;
- exact next causal action;
- unresolved items and do-not-repeat constraints.

Do not include credentials, signed URLs, unrestricted tool output, transcripts,
or private model reasoning.

The server binds that semantic payload to an exact mechanical fingerprint:

- canonical workspace and Git-root digests;
- branch, HEAD, and HEAD tree;
- porcelain status digest;
- tracked-diff digest;
- bounded untracked path/content digest;
- staged, unstaged, and untracked path counts.

The capsule may represent a clean commit, a validated dirty candidate, a known
test failure, staged source plus intentionally unstaged attestations, or an
effect-reconciliation boundary. Recording one never claims that the task is
finished.

Capsule writes are idempotent. Reusing one idempotency key for a different
semantic payload or workspace state fails instead of silently replacing the
prior record.

## Freshness and Cross-Session Use

`recovery_capsule_status` requires an already-open workspace. It selects the
latest retained capsule for that exact canonical workspace root, including a
capsule written by another execution scope, and recomputes the current Git
fingerprint.

Workspace freshness is reported independently:

- `fresh` — the recorded and current Git-bound state match;
- `stale` — HEAD, branch, tracked content, untracked content, or worktree state
  changed; or
- `unknown` — a content-complete comparison is unavailable, such as a non-Git
  workspace.

A locally `fresh` workspace does **not** prove that the recorded semantic
frontier is current relative to canonical Git/main, PostgreSQL work and
decision state, writer ownership, runtime state, or effect receipts. Another
executor may have advanced those owners without changing this workspace.

At record time, include exact immutable `authorityStateRefs` obtained from the
rightful owners. On resumption, rehydrate those owners again and pass the exact
current refs as `currentAuthorityStateRefs`. Authority freshness is then
reported independently as:

- `matched_supplied_refs` — the caller-supplied current refs equal the recorded
  baseline; DevSpace compares values but does not attest their provenance;
- `changed_from_recorded_refs` — the refs changed and the recorded exact action
  is historical; or
- `unverified` — either the recorded baseline or current owner readback is
  absent.

The exact-action candidate is conditionally available only when workspace state
is locally fresh **and** supplied current authority refs match. Even then,
DevSpace does not attest that those refs came from the rightful owners. The
result is an executor action candidate, not mutation, writer, effect, or
publication authorization; any live control preflight still applies.

Time or TTL alone never decides semantic validity. Retention only controls how
long DevSpace stores the executor-local capsule. A stale or unverified capsule
remains useful evidence about the previous frontier, but its next action is not
safe to replay blindly. In all cases, live product/runtime/effect readback
outranks the capsule.

## Recommended Long-Run Loop

```text
begin assistant turn
  -> inspect latest capsule and canonical state
  -> continue dynamic mission work
  -> update capsule after material transitions or rising recovery debt
  -> on landing opportunity, finish the current causal chain
  -> record and read back the capsule; require a fresh Git comparison
  -> end only the assistant turn

next assistant turn
  -> begin a new advisory epoch
  -> verify local workspace freshness
  -> rehydrate canonical/runtime/writer/effect owners
  -> compare exact current authority refs with the recorded baseline
  -> reconcile only changed state and replan when authority moved
  -> continue the same mission normally
```

This keeps the model mission-bounded rather than task-bounded while limiting
the amount of semantic work that can disappear at an abrupt host cutoff.
