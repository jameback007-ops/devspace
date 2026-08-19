# Turn Continuity and Recovery Capsules

DevSpace separates mission continuity from assistant-turn duration. A model may
replan dynamically, cross task boundaries, follow blockers, and preserve full
verification quality while still leaving a clean recovery frontier before an
unknown host cutoff.

The feature has four cooperating but authority-separated parts:

- the **turn horizon** supplies advisory timing only;
- the **instability assessor** uses sanitized lifecycle evidence to detect
  rising recovery risk before the nominal horizon;
- the **operational landing envelope** persists bounded machine facts needed to
  locate a recoverable boundary after a cutoff or restart; and
- a **recovery capsule** stores the explicit bounded, Git-bound semantic
  frontier.

None is task, decision, writer, effect, publication, workflow, or
canonical-memory authority. The machine envelope never invents mission or next
action from tool events; semantic state comes only from an explicit capsule.

## Research disposition

The design deliberately borrows a small set of upstream reliability patterns
without importing a second workflow runtime:

- gRPC treats a deadline as an absolute caller boundary, propagates the
  remaining budget across downstream calls, and requires server-side work to
  stop or reconcile when the initiating call is cancelled. DevSpace therefore
  prefers exact host deadline metadata when available and derives advisory lead
  windows from it instead of replacing it with a local task deadline. See the
  official [gRPC deadline guide](https://grpc.io/docs/guides/deadlines/).
- Kubernetes graceful termination separates a bounded grace interval from
  eventual forced termination. During the grace interval an application drains
  or saves state, but it does not claim termination until the process is
  actually terminal. DevSpace applies the analogous rule to assistant turns:
  seek the nearest recoverable cut early enough, but treat a running process or
  unknown effect as reconciliation-required rather than completed. See the
  official [Pod termination flow](https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/).
- LangGraph persistence stores durable checkpoints under a stable thread
  identity so execution can resume from an established boundary rather than
  recompute the entire run. DevSpace keeps the equivalent concerns separated:
  the explicit capsule owns semantic frontier data, while the machine envelope
  owns bounded operational evidence. See the official
  [LangGraph persistence guide](https://docs.langchain.com/oss/javascript/langgraph/persistence).

The resulting disposition is `KEEP_CUSTOM`: DevSpace needs executor-local
turn-awareness around an external host cutoff, not a new canonical workflow
engine. Upstream patterns inform deadline propagation, graceful landing,
idempotent persistence, and same-identity resume; they do not grant task,
writer, effect, or publication authority.

## Advisory Horizon

An exact host may attach:

- `devspace/executor-turn` — one opaque value shared by every tool call in one
  assistant turn;
- `devspace/executor-deadline-ms` — an absolute Unix-millisecond deadline; or
- `devspace/executor-deadline-at` — an absolute ISO-8601 deadline.

The raw turn value is never persisted. DevSpace exposes only a non-reversible
`turnRef`. A new exact turn value starts a new advisory epoch automatically.

When the host supplies no turn identity, the first non-control tool call starts
an `implicit` epoch automatically. `turn_horizon_begin` remains available for
an explicit boundary, recovery after a cutoff, or a focused test. Its
idempotency key prevents a retried begin call from resetting the same epoch. A
different key intentionally begins another explicit epoch. Conversation scope
and conversation age are never treated as assistant-turn identity.

The default estimated envelope is 120 minutes:

- at 90 minutes, one `checkpoint_awareness` notice is emitted;
- at 100 minutes, one `landing_opportunity` notice is emitted; and
- at 108 minutes, one `urgent_landing` notice is emitted.

An exact host deadline uses equivalent lead margins: 30, 20, and 12 minutes
before the exact deadline by default. Passing the estimate or deadline does not
change tool availability. There is no `DRAIN`, `YIELD_REQUIRED`, or
blocked-tool state.

The model should interpret a landing opportunity as:

> Continue the current local causal chain to the nearest recoverable cut. Do
> not rush task completion, weaken validation, force a commit, retry an effect,
> or abandon the mission. Record a current capsule, then end only the assistant
> turn.

Urgent guidance means seek that cut now, not truncate validation or manufacture
a checkpoint. A normal clean commit is useful only when it is already the
natural validated boundary. An exact intentional-dirty boundary is preferable
to a partial commit created solely to make Git look clean.

## Instability-Aware Early Landing

Timing is not the only reason to improve recoverability. DevSpace assesses a
bounded recent window of persisted, sanitized execution lifecycle evidence and
reports one of four states:

- `normal` — no material recovery anomaly is established;
- `degraded` — refresh a rolling capsule at the next natural material
  transition;
- `unstable` — finish the current coherent causal slice, avoid opening a new
  long frontier, and seek the nearest recoverable landing; or
- `critical` — do not begin a new mutation or external effect; preserve and
  reconcile the current running process/effect identity and land at the nearest
  recoverable cut.

The assessor considers:

- MCP tool responses recorded as `error`, `blocked`, or `interrupted`;
- repeated normalized lifecycle failures;
- an observation interrupted by a DevSpace backend restart;
- an abandoned/stale non-process tool observation;
- a backend instance change since the latest machine envelope;
- mutations after the latest capsule and capsule refresh debt;
- running process exposure; and
- an explicit capsule whose effect is `in_flight`, `unknown`, or
  `reconcile_before_retry`.

False-positive controls are deliberate. A nonzero exit from an ordinary shell
command is still a completed `exec_command` receipt rather than an MCP
transport error. A legitimately long `exec_command` or `write_stdin` remains a
running process/tool exposure but is not classified as an abandoned ordinary
tool merely because it exceeds the short stale-tool threshold. A quiet process
alone does not establish a transport failure.

Instability is advisory evidence. It never blocks tools, cancels a process,
creates task priority, grants writer/effect authority, or proves that a model is
hung. Private model reasoning and provider generation remain unobservable
between MCP calls.

## Operational Landing Envelope

When a turn reaches an awareness/landing phase, instability becomes material,
or a turn-boundary capsule seals an epoch, DevSpace upserts one durable
operational envelope for that scope and epoch. It is refreshed when later
mutation or relevant lifecycle evidence changes the recovery boundary. A
bounded background observer also advances timing-only envelopes when no new
tool call arrives at the threshold. It cannot inject a notice into a model
without an MCP boundary, so the next tool or status response still carries the
advisory. The scan, retained horizons, and envelope generations remain bounded.

The envelope contains bounded machine facts only:

- opaque scope and epoch IDs;
- advisory phase and sealed-boundary metadata;
- latest retained event sequence and bounded observation window;
- opaque linked workspace IDs;
- last activity, mutation, and checkpoint timestamps/IDs;
- opaque running tool sequence and process session/workspace IDs with timing;
- sanitized instability counts and reason codes;
- backend instance/surface identity supplied by the runtime registry;
- the latest explicit capsule ID/time and whether mutation followed it; and
- explicit capsule effect state, retry policy, count, and a digest of effect
  refs rather than raw effect payloads.

The envelope does **not** contain prompts, transcripts, private reasoning, tool
output, exception messages, raw commands, patch bodies, credentials, arbitrary
paths, or inferred semantic intent. One envelope is idempotently updated per
scope/epoch, is character-bounded, is retained with the same broad recovery
horizon as capsules, and is pruned to a bounded number per scope.

`turn_horizon_status`, `recovery_capsule_status`, semantic scope recovery, and
`execution_scope_status.turnLanding` expose a resume projection that
distinguishes:

- a verified clean Git turn boundary;
- a machine envelope joined to a current explicit semantic capsule;
- a machine envelope with a missing or stale semantic capsule; and
- a running process or in-flight/unknown effect that requires reconciliation.

The projection may recommend same-mission continuation, but this is guidance,
not canonical task authority. Current Git/main, task/decision, writer, runtime,
and effect owners still have to be read again before relying on an exact action.

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

An `intent: turn_boundary` capsule seals the current assistant-turn epoch. A
read-only status call continues to show that sealed boundary; it does not start
a new epoch. The next non-control tool starts a fresh epoch automatically (or a
new exact host turn starts one), while the landing projection preserves the
prior explicit mission/frontier for same-mission continuation. A sealed epoch
does not complete the mission or task.

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
  -> exact host metadata or first non-control tool starts an advisory epoch
  -> inspect latest capsule, machine landing envelope, and canonical state
  -> continue dynamic mission work
  -> update a rolling capsule after material transitions or rising recovery debt
  -> timing/instability materializes a bounded machine envelope automatically
  -> on landing guidance, finish the current coherent causal slice
  -> preserve running process/effect identity; reconcile unknown effects before retry
  -> record and read back a turn_boundary capsule at the natural safe cut
  -> end only the assistant turn

next assistant turn
  -> the first non-control tool or new host turn begins a fresh epoch
  -> resume the same mission/frontier rather than restart research by default
  -> verify local workspace freshness
  -> rehydrate canonical/runtime/writer/effect owners
  -> compare exact current authority refs with the recorded baseline
  -> reconcile only changed state and replan when authority moved
  -> continue the same mission normally
```

This keeps the model mission-bounded rather than task-bounded while limiting
the amount of semantic work that can disappear at an abrupt host cutoff.
