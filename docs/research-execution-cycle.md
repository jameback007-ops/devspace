# ZES Research Reflex execution cycle

DevSpace can bind material work in a ZES checkout to the native capability-bound
ZES Research Reflex v3 admission contract. The adapter owns only executor-local lifecycle,
receipt verification, and effect observation. It does not become a second
research engine or grant task, semantic, writer, publication, release,
activation, runtime, or effect authority.

The feature is disabled by default and applies only when both conditions hold:

1. `DEVSPACE_ZES_RESEARCH_CYCLE_MODE` is `observe` or `enforce`; and
2. the opened workspace contains
   `packages/zes-control-kernel/pyproject.toml`.

Generic DevSpace workspaces are unchanged.

## Lifecycle

The model-facing flow is:

1. `zes_research_cycle_open` records the material decision question, initial
   research-depth hypothesis, known local evidence, uncertainty, falsifier,
   reopen trigger, candidate paths, and actor identity against a clean Git
   baseline in enforce mode.
2. `zes_research_cycle_prepare` binds the exact Git repository identity, HEAD,
   tree, working-content digest, path prefixes, operation classes, evidence
   regime, source identity, decision scope, implementation boundary, action
   scope, and every exact shell command expected to mutate source or dependency
   files. Only command digests are persisted.
3. When the decision needs open-world candidate discovery or a current
   community/field portfolio, `zes_research_discovery_plan` freezes a bounded,
   source-origin-neutral Exa-search portfolio for the current prepared
   generation. The plan records the temporal regime, coverage profile, exact
   required/conditional/not-applicable lanes and reasons, query text and refs,
   result bounds, lookback/revalidation interval, and policy/portfolio/plan
   digests. Planning calls no provider.
4. `zes_research_discovery_acquire` executes all or an exact subset of that
   frozen portfolio through the existing fixed Exa-search broker. Each query is
   durably reserved before the external call, receives one attempt, and is
   terminally recorded as acquired or failed. DevSpace performs no automatic
   retry and never replays a completed or indeterminate open-world effect.
   Required coverage remains incomplete until every frozen query in each
   required lane has immutable evidence and trace identities.
5. `zes_research_horizon_record` records a typed post-acquisition freshness
   checkpoint for the exact plan, generation, portfolio, policy, evidence and
   trace digests. The caller supplies exact evidence-bound observations rather
   than free-form provider prose. `zes_research_horizon_status` reads this
   checkpoint and derives dynamic expiry. Expiry means revalidation is
   required; it does not declare prior evidence false.
6. `zes_research_provider_invoke` may separately acquire one exact provider
   receipt and bind it to provider-execution evidence v2 inside the cycle's
   private evidence directory. The broker exposes only typed Context7, Exa, and
   targeted-Web operations. It accepts no provider endpoint, command,
   credential, or output path from the model.
7. When a material claim requires experimental rather than documentary
   evidence, `zes_research_instrument_plan` selects a bounded capability-shaped
   route without executing it. An external optional adapter may then run a
   notebook, property/stateful falsifier, disposable real-dependency test,
   treatment/control agent evaluation, trace analysis, bounded counterfactual,
   or separately authorized live canary. `zes_research_instrument_record` binds
   exact typed results and artifact digests to the current research generation;
   `zes_research_instrument_status` verifies their continued integrity. See
   [Research Instrumentation Cycle](research-instrumentation-cycle.md).
8. `zes_research_cycle_assess` invokes the fixed native
   `zes-research-reflex assess` application port. DevSpace stores and hashes the
   returned v3 receipt and lease; it does not recompute sufficiency. Every
   `research-instrument-evidence:*` ref in the native request is automatically
   verified against the current research generation and artifact digests.
   Optional `instrumentEvidenceRefs` make the intended set explicit, but cannot
   introduce a ref that is absent from the request. When an active discovery
   plan exists, assessment additionally requires complete required-lane
   coverage, the exact full acquired evidence set, unchanged private files and
   a horizon checkpoint for that plan. All discovery evidence refs must also be
   present in native `provider_execution_evidence`; DevSpace merges their exact
   traces into native verification. Historical v1/v2 receipts remain
   decodeable, but they cannot create a new admission through this action gate.
9. `zes_research_cycle_invalidate` reopens judgment after counterevidence,
   architecture or semantic forks, dependency/upstream changes, owner direction
   changes, repeated distinct failures, scope drift, or source-currentness
   expiry.
10. `zes_research_cycle_verify_pre_commit` re-verifies the native receipt and
   binds the complete current working-content digest, validation refs,
   currentness checks, assumptions, limitations, unresolved risks, and stopping
   reason. Instrument refs in `validationRefs` are automatically verified again
   at the commit boundary; optional `instrumentEvidenceRefs` must be a subset of
   that validation set. An active discovery plan is also rechecked for exact
   policy/portfolio/plan identity, complete required coverage, private
   evidence/trace integrity, currentness and horizon ordering. A horizon signal
   recorded after admission requires a fresh native assessment.
11. The normal Git commit is observed. A successful commit is accepted by the
   lifecycle only when it contains the complete pre-commit-verified change set.
12. `zes_research_cycle_close` records the terminal outcome, decision delta,
   reusable findings, and reversal conditions. Fresh or reused external
   research must also compile a native Research Reflex episode packet for
   Task N→N+k reuse.

Publication remains separately governed. The research cycle merely requires a
closed, committed, clean, exact-HEAD lifecycle before a publication command can
proceed through this gate.

## Modes

`off` registers no research-cycle tools and performs no checks.

`observe` registers the tools and records lifecycle signals. Guard findings are
returned as advisory but do not block the underlying DevSpace operation. If a
direct mutation crosses the prepared path or dependency boundary, the cycle is
set to `reassessment_required`.

`enforce` fail-closes source mutation, commit preparation, commit, and
publication when the exact current admission, scope, lease, pre-commit
checkpoint, commit, or closure is absent or stale. Read-only inspection,
validation, and research-control commands remain usable before a cycle exists.
Runtime effects are never authorized by research admission and remain held by
this gate until handled through the rightful runtime/effect control plane.

## Tool-bound enforcement

The adapter is wired into the normal DevSpace execution paths rather than a
parallel implementation:

- `apply_patch`, `write`, and `edit` guard exact workspace-relative paths and
  record the paths actually changed;
- `exec_command` and `bash` classify commands before dispatch and observe
  terminal outcomes;
- shell source/dependency mutation must match an exact command digest prepared
  before native admission; unknown or changed commands are held in enforce mode;
- dependency-changing shell commands additionally require the
  `dependency_change` operation class;
- long-running `exec_command` processes retain their original command binding
  across `write_stdin` polls;
- non-empty interactive input is conservatively checked before it is sent;
- two distinct failed commands after admission trigger typed reassessment;
- observation failure after an already completed effect returns an explicit
  indeterminate warning and never recommends blind replay.

The command classifier is deliberately conservative. Unknown commands are
treated as potentially mutating and require an exact prepared command digest in
enforce mode. It is a safety boundary, not a shell parser or proof that an
arbitrary command is side-effect-free. Prefer `apply_patch`, `write`, or `edit`
for ordinary source changes because those tools can be held against exact paths
before the effect.

## Evidence-provider routing

Provider selection follows the evidence need rather than whichever route is
cheapest or easiest to call:

- Context7 is the default for exact upstream library and versioned
  documentation semantics.
- Targeted Web is allowed only when the exact fact, named document, publisher,
  or official source identity is already known and only its current location or
  content needs confirmation. It performs bounded pinned-HTTPS fetches and
  explicitly records that no open-world candidate discovery occurred.
- Exa `search` is the registered operation for unknown candidate space,
  competitive alternatives, field failures, community patterns, and broad
  multi-source discovery.
- Exa `fetch` is a known-source acquisition operation. It remains useful for
  reading an already-selected URL, but it does not prove that open-world
  candidate discovery occurred merely because it uses the Exa service.
- A different provider may replace Exa search only after its exact provider
  route and open-world capability are registered and emitted by a verified
  provider receipt. Caller-selected capability labels, free text, and an
  override reason alone are insufficient.

Targeted Web, ordinary host Web Search, Context7, Exa fetch, and one
already-known source never silently substitute for unavailable Exa search on an
open-world evidence need. That boundary remains held as provider-degraded until
Exa search or a registered receipt-verified equivalent open-world provider
succeeds. Conversely, a narrow uniquely
authoritative fact does not have to spend an Exa call merely to retrieve a
known official source.

The Exa credential remains in the DevSpace service environment. The fixed
broker copies only the `EXA_API_KEY` handle into the exact Exa child process;
the model-facing result, provider receipt, logs, bind process, and arbitrary
`exec_command` environment receive neither the value nor its digest. Context7
may similarly consume an optional `CONTEXT7_API_KEY`; the public pinned CLI
route remains usable without it when the upstream permits anonymous access.
The generic command-environment passthrough also rejects both reserved names.
Provider timeouts and output ceilings terminate the complete child process
group. The fixed ZES accelerator first writes its receipt below the configured
ZES repository's private Git metadata, which is already inside the
accelerator-owned receipt allowlist and outside the worktree. DevSpace opens
that staging file no-follow, owner-checks it as a single-link private file,
imports the exact bytes once into the cycle-private evidence directory with an
exclusive write, verifies the imported digest, and removes the staging file on
every terminal path. The retained receipt/evidence files are then rebound to
the exact requested provider, operation, route ref, transport, capability
refs, open-world-performed proof, purpose, and cycle framing before admission.
Neither the model nor provider request may select a staging or receipt root.

## Configuration

```text
DEVSPACE_ZES_RESEARCH_CYCLE_MODE=observe
DEVSPACE_ZES_RESEARCH_REPOSITORY_ROOT=/srv/zes-codex/ZES-SYSTEM-BLUEPRINT
DEVSPACE_ZES_RESEARCH_STATE_ROOT=/var/lib/devspace-zesnexus/zes-research-cycles
DEVSPACE_ZES_RESEARCH_TIMEOUT_SECONDS=60
DEVSPACE_ZES_RESEARCH_TRUSTED_TRACE_ROOTS=/srv/zes-aoq/aoq01-e77671a/state/provider-traces
# Service-held provider handles used only by zes_research_provider_invoke.
EXA_API_KEY=<managed-secret>
# CONTEXT7_API_KEY=<optional-managed-secret>
```

The repository root supplies the fixed native application port. The default is
`/srv/zes-codex/ZES-SYSTEM-BLUEPRINT`; the existing
`DEVSPACE_ZES_REPOSITORY_ROOT` is accepted as a compatibility fallback.

State defaults to `<DEVSPACE_STATE_DIR>/zes-research-cycles`. State and the
byte-exact imported receipts are owner-local executor evidence, not canonical
ZES task or memory state. The temporary accelerator staging directory is
`<DEVSPACE_ZES_RESEARCH_REPOSITORY_ROOT>/.git/devspace-research-provider-receipts`;
only unique receipt files are created there, they are removed after import,
and no repository source or Git index entry is changed.

Provider trace files used by native `verify-admission` must resolve under the
opened workspace, the cycle-private evidence directory, or an explicitly
configured trusted trace root. Trace refs must be unique. Provider outputs are
treated as untrusted evidence until the native Research Reflex verification
accepts their exact identity.

## Model-facing tools

- `zes_research_cycle_open`
- `zes_research_cycle_prepare`
- `zes_research_discovery_plan`
- `zes_research_discovery_acquire`
- `zes_research_horizon_record`
- `zes_research_horizon_status`
- `zes_research_instrument_plan`
- `zes_research_instrument_record`
- `zes_research_instrument_status`
- `zes_research_provider_invoke`
- `zes_research_cycle_assess`
- `zes_research_cycle_invalidate`
- `zes_research_cycle_verify_pre_commit`
- `zes_research_cycle_status`
- `zes_research_cycle_close`

The complete registered group is reported through the existing runtime
tool-surface fingerprint and critical capability-group assessment.

## Failure and recovery rules

- Provider failure cannot silently become `NO_SEARCH`.
- Exa search failure cannot silently downgrade an open-world decision to Exa
  fetch, targeted Web, Context7, or one known source.
- Provider credentials remain service-held handles and are never accepted as
  model input or passed to arbitrary shell execution.
- Only a new native v3 admission receipt and lease can admit an action through
  this DevSpace action gate. Historical v1/v2 receipts remain available for
  immutable decode and verification but do not create a new admission.
- A receipt is bound to task, material decision, decision boundary, source
  identity, implementation boundary, action scope, and exact admitted shell
  mutation command digests.
- A changed or missing receipt file, expired lease, changed HEAD, changed
  working-content digest, new dependency-sensitive path, or out-of-scope path
  requires reconciliation or reassessment.
- A process effect that completed but could not be recorded is indeterminate;
  inspect the workspace and cycle before retrying.
- Local lifecycle success does not authorize Git publication or runtime/effect
  execution. Use the separate continuation/publication and runtime control
  planes at effect time.

## Freshness and community discovery v2

Freshness/community discovery is an executor-local lifecycle extension around
the existing provider-execution evidence v2 broker and native Research Reflex
v3 admission. It does not add an `exa_advanced` provider, a new provider
evidence schema, or a new native admission version. It also does not claim that
query text is equivalent to a provider-native publication-date or domain
filter.

### Frozen portfolio contract

`zes_research_discovery_plan` converts one prepared decision into a bounded
portfolio with at most eighteen queries and at most two queries per coverage
lane. Every executable query is fixed to:

- provider `exa`;
- operation `search`;
- the registered `capability:open-world-candidate-discovery:v1` route;
- a maximum of eight results;
- exact query text and a deterministic query ref; and
- a `query_text_only` temporal constraint that explicitly records that no
  provider-native date or domain filter was applied.

The plan is source-origin-neutral. Lanes describe evidence functions, not a
publisher prestige order or a truth score:

- official or release delta;
- open-source or independent implementation;
- failure reproduction or maintainer discussion;
- competing alternative or successor;
- practitioner or production experience; and
- counterevidence or falsifier.

Profiles assign each lane a `required`, `conditional`, or `not_applicable`
disposition. An explicit override must include a reason and may strengthen a
lane, but it cannot erase a lane that the selected profile requires. Required
coverage closes only when every frozen query in every required lane has an
acquired, immutable evidence record. Source count, popularity, stars, mentions,
or the presence of one official result cannot close a broad portfolio.

The plan binds:

- the current Research Reflex generation and exact cycle ref;
- subject question, subject ref, known candidates, incumbent and optional prior
  snapshot ref;
- temporal regime, `asOf`, derived lookback start and revalidation boundary;
- lane dispositions and reasons;
- exact query portfolio; and
- policy, portfolio and plan SHA-256 identities.

An identical request is idempotent. A materially changed plan receives a new
identity, records typed invalidation reasons, clears active local acquisitions
and horizon state, and never replays the prior plan's external effects.

### Temporal regimes

The current executor policy uses these regime-aware intervals:

| Regime | Lookback | Revalidate after |
| --- | ---: | ---: |
| `rapidly_volatile` | 14 days | 1 day |
| `evolving_practice` | 30 days | 7 days |
| `version_bound_fact` | 180 days | 60 days |
| `durable_principle_or_invariant` | 365 days | 180 days |
| `historical_lineage` | 730 days | 365 days |

These intervals govern portfolio construction and local currentness. They do
not assert that newer evidence is automatically better or that evidence becomes
false when its revalidation boundary passes.

### Acquisition and recovery semantics

`zes_research_discovery_acquire` durably writes one `pending` attempt record
before invoking the fixed Exa-search broker. It then releases the research-cycle
lock around the external call so the broker can read cycle context without a
re-entrant deadlock. After the call, it reacquires the lock and binds the result
only if the exact cycle, generation, plan digest, query and attempt identity are
still current.

Each query has attempt ordinal one and `noRetryPerformed: true`. A successful
result must prove Exa search, the registered open-world capability, the exact
purpose, owner-seeded framing and trace source. DevSpace accepts only bounded,
owner-private, single-link regular evidence and trace files inside the cycle's
private evidence directory and rechecks their exact SHA-256 identities on every
state read that relies on them.

A provider or validation failure is terminal for that query and stops the
remaining portfolio call sequence. Repeating the acquisition action returns the
persisted terminal record rather than calling the provider again. A context
change while an external call is in flight is held for reconciliation; the
caller must inspect the preserved attempt and current plan instead of assuming
that replay is safe.

### Horizon checkpoint

`zes_research_horizon_record` is available only while the exact discovery
generation remains prepared and required coverage is complete. It records a
deterministic checkpoint over the plan, policy, portfolio, generation, complete
acquired evidence set, trace identities, optional typed prior snapshot and
typed event observations. Persisted horizon identity, ordering and evidence
lineage are recomputed when state is read.

Supported event classes are:

- `new_candidate_detected`;
- `upstream_semantics_changed`;
- `community_failure_cluster_detected`;
- `prior_selection_superseded_candidate`;
- `new_reproduction_or_counterevidence`; and
- derived `current_source_expired`.

The caller must bind every non-expiry observation to current-plan evidence refs,
exact subject refs and a rationale. Event-specific checks require, for example,
failure-cluster evidence from the frozen failure/maintainer lane and
counterevidence/reproduction from the matching failure or falsifier lane.
DevSpace does not parse provider prose, infer semantic change, select a winner,
or convert source origin into authority.

When `asOf` passes the plan's `revalidateBy`, the checkpoint records
`current_source_expired`. This is a typed requirement to refresh the Research
Reflex decision. The retained rationale explicitly states that the prior
evidence is not thereby declared false.

### Assessment and commit boundary

When a discovery plan exists, `zes_research_cycle_assess` fails closed unless:

1. required-lane coverage is complete;
2. the plan is current for the assessment timestamp;
3. every acquired evidence and trace file still has its recorded identity;
4. a horizon checkpoint exists for the exact plan and generation;
5. the supplied discovery ref set exactly equals the complete acquired set; and
6. every discovery evidence ref appears in native
   `provider_execution_evidence`.

DevSpace merges the corresponding immutable trace refs into the native v3
verification call, but the native Research Reflex remains the research
sufficiency and admission authority. Pre-commit verification repeats plan,
coverage, currentness, evidence, trace and horizon checks. If a refresh signal
was recorded after the current native admission, a new assessment is required.

This lifecycle grants no task, semantic, writer, publication, deployment,
activation, runtime or effect authority. Git publication and runtime activation
remain separate gated effects, and a terminal historical open-world effect is
never replayed merely to rebuild executor-local discovery state.

Example plan input:

```json
{
  "workspaceId": "ws_example",
  "subjectRef": "component:agent-memory",
  "subjectQuestion": "Which current agent-memory approaches, failures, and successors materially change this decision?",
  "temporalRegime": "rapidly_volatile",
  "asOf": "2026-08-19T05:00:00Z",
  "knownCandidateRefs": ["candidate:current-memory-stack"],
  "incumbentRef": "candidate:current-memory-stack",
  "priorSnapshotRef": "research-discovery-snapshot:previous",
  "discoveryProfile": "balanced_frontier"
}
```

Example horizon observation input after acquisition:

```json
{
  "workspaceId": "ws_example",
  "planRef": "research-discovery:plan:example:1:0123456789abcdef",
  "expectedGeneration": 1,
  "asOf": "2026-08-19T05:30:00Z",
  "observations": [
    {
      "kind": "community_failure_cluster_detected",
      "evidenceRefs": ["research-provider-evidence:exa:example"],
      "subjectRefs": ["component:agent-memory"],
      "rationale": "Independent failure reproductions changed the supported operating envelope."
    }
  ]
}
```
