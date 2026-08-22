# MCP Capability Orientation and Self-Evolution

Status: source integration candidate. The capability directory, ambiguity
repair, recovery-only Legacy projection, and recovery-owner checks are
implemented and covered by deterministic tests. Production activation of the
new recovery controller remains a separate governed runtime effect.

## Problem

DevSpace exposes a large MCP surface. A new model session may still fail to use
it for three unrelated reasons:

1. the primary server did not register the capability;
2. the host cached an older or partial `tools/list` surface;
3. the tool exists, but the model does not know which intent it serves or which
   entry tool begins the workflow.

These states were previously easy to collapse into one vague claim such as
"the MCP cannot do that." The same ambiguity affected fallback recovery:
`fallback.available=false` could be read as "Legacy is unreachable" even when
it only meant that no independently attested route had been admitted by the
autonomous planner.

The fix is an additive stable-bootstrap projection, not another opaque agent
runtime and not a generic arbitrary-RPC tool.

## Five separate layers

Every capability or fallback claim must preserve five distinct layers:

| Layer | Question | Owner of observation |
| --- | --- | --- |
| Primary registration | Did the Nexus server register the expected tools? | Nexus runtime |
| Capability orientation | Does the model-facing directory explain the intent, purpose, and entry path? | DevSpace source/runtime |
| Host catalog visibility | Did this host expose the current registered descriptors to the session? | Host attestation |
| Sibling-route reachability | Did the host or executor actually reach Legacy or another continuity MCP? | Independent caller observation |
| Planner admission | Is that exact route eligible and selected for this exact operation? | Typed recovery/continuity policy |

No boolean is allowed to stand for all five.

In particular:

```text
fallback route not observed
  != fallback connector unreachable
  != fallback route unattested
  != fallback route not selected
  != fallback route forbidden for every operation
```

## Stable capability directory

`src/mcp-capability-orientation.ts` derives
`devspace.mcp-capability-orientation.v1` from the same registered runtime tool
descriptors and configuration used by Nexus.

It is returned through the already-stable `execution_scope_status` route under:

```text
capabilityQuickstart
stableControlPlane.capabilities.mcpCapabilityOrientation
```

`capabilityQuickstart` is the compact front-loaded view intended for a model
that does not yet know the surface. It lists configured intent groups,
recommended entry tools, effect class, server state, and observed client state
before the heavier workspace/runtime payload. The full stable-control-plane
projection retains diagnostics, findings, and bounded self-evolution
candidates.

This matters because a client with a frozen catalog cannot be required to
discover a newly added orientation tool before learning what the current server
can do.

Each group exposes:

- a human-readable title and purpose;
- intent references that a model can match against the current task;
- recommended entry tools rather than a flat undifferentiated tool list;
- the expected and registered server tools;
- server state, observed client name coverage, and independently assessed
  client-catalog freshness;
- missing server or client tools;
- the effect class of the group.

The current groups cover:

- workspace execution and native navigation;
- skill discovery;
- execution-scope observation and messaging;
- turn continuity and semantic recovery capsules;
- fixed continuation control;
- workspace lifecycle and self-repository publication;
- bounded local-agent continuation;
- Research Reflex and Shared Research Lab execution;
- conversation transport and wake recovery;
- native Codex integration and live-workspace inspection;
- cross-executor coordination;
- artifact transfer.

The directory is descriptive. It does not dispatch tools, infer hidden model
intent, own tasks, acquire writers, authorize effects, publish repositories, or
become canonical memory.

## Orientation states

The projection reports one of these states:

| State | Meaning |
| --- | --- |
| `SERVER_READY_CLIENT_CURRENT` | Registered server groups and the complete host catalog agree. |
| `SERVER_READY_CLIENT_PARTIAL` | Server groups exist, but the observed host tool names are missing tools. This may be diagnostic name coverage rather than a current complete-catalog attestation. |
| `SERVER_READY_CLIENT_UNVERIFIED` | Observed tool names cover the configured groups, but the canonical complete descriptor fingerprint is absent, stale, or otherwise not current. |
| `SERVER_READY_CLIENT_UNOBSERVED` | Server groups are known; the host catalog was not attested. |
| `SERVER_READY_DIRECTORY_DRIFT` | Registered tools exist but lack intent-oriented directory metadata. |
| `SERVER_CAPABILITY_DEGRADED` | A configured primary capability group is incomplete on the server. |

The distinction determines the repair class:

```text
server capability degraded
  -> repair primary registration/configuration

directory drift
  -> update source metadata and tests

client partial, unverified, or unobserved
  -> attest or refresh the host catalog
```

Host catalog lag is never reported as missing server capability. An
unclassified registered tool is never reported as absent; it becomes an
explicit self-evolution candidate. Supplying tool names alone establishes only
observed name coverage. `clientCatalogAttested` becomes true only when the
canonical complete descriptor fingerprint is assessed as current.

## Bounded self-evolution loop

DevSpace follows a reconciliation loop derived from self-describing protocol,
controller, and autonomic-computing patterns:

```text
observe registered server surface
  + observe safe runtime configuration
  + optionally attest complete host catalog
  -> compare with compiled capability groups and Stable Tool ABI
  -> classify the failure layer
  -> emit a bounded repair candidate
  -> execute only through the ordinary source or runtime effect gate
  -> verify exact postconditions and surface identity
  -> retain evidence and reopen when a new gap appears
```

The loop can identify three candidate classes:

- repair a configured primary capability group;
- classify newly registered tools in the capability directory;
- refresh or attest a host catalog.

Candidate generation does not authorize automatic source mutation. Source
changes still use the normal isolated-worktree, validation, commit, publication,
and deployment lifecycle. Runtime repair still requires one exact recovery
owner and its own effect gate.

## Fallback ambiguity repair

`src/mcp-primary-recovery.ts` retains `fallback.available` only as a
compatibility alias. Its exact meaning is now:

> the caller observed this route reachable for this assessment

It does not mean that Nexus can observe sibling host connectors, and omission
does not mean that Legacy is unreachable.

New output separates:

- `routeReachability.state`;
- `routeAttestationState`;
- `plannerAdmissionState`;
- `exactAttestationNextAction`.

The reachability states are:

- `unobservable_by_primary`;
- `caller_observed_reachable`;
- `caller_observed_unreachable`;
- `conflicting_caller_observation`.

Supplying contradictory legacy and new aliases fails closed rather than choosing
one silently.

The generic `routeAttestationState` is deliberately scoped to the caller's
evidence for the current assessment:

- `missing` — no caller route observation;
- `incomplete` — unreachable, conflicting, or missing surface identity;
- `surface_observed` — reachability, names, and descriptor fingerprint were
  supplied, but no typed quality/policy qualification is bound;
- `caller_attested` — the caller also supplied quality-equivalence evidence and
  a typed policy ref.

`caller_attested` does not mean that Nexus independently verified those refs.
Planner admission, route selection, repair-effect authorization, invocation,
and terminal outcome remain separate states.

## Legacy as a recovery-only repair plane

`src/mcp-fallback-recovery-route.ts` wires the existing fallback-continuity
planner into the live stable status projection.

Legacy does not need the full Nexus ABI to repair Nexus. The minimum direct
repair subset is:

```text
open_workspace
read
apply_patch
exec_command
write_stdin
```

`apply_patch` is required for a source-capable repair plane so recovery does not
fall back to shell-based source editing. `download_artifact` remains optional.
In particular,
`execution_scope_status` is a Nexus bootstrap tool and is not required on
Legacy merely to establish primary-repair capability.

Recovery readiness still requires explicit evidence for:

- route reachability and an exact complete descriptor fingerprint;
- independent failure domain;
- state and authority isolation;
- a typed recovery-only policy;
- bounded primary-repair authority;
- the required post-repair failback probe.

An eligible route is not selected until an operation-scoped selection receipt
is supplied. That selection identifies the recovery plane only; it does not
authorize or dispatch a repair effect. Any source or runtime mutation still
requires a separate effect gate bound to the exact repair plan and effect
identity. The route receives no original mission authority, canonical state,
writer, publication, memory, or effect-replay authority. Caller-supplied
attestation and evidence refs are classified but are not independently verified
by the Nexus projection.

## Recovery and failback sequence

The complete intended sequence is:

```text
primary Nexus unavailable or capability-incomplete
  -> primary reconnect / catalog / deterministic repair cycle
  -> one recovery owner
  -> independently observe and attest Legacy or continuity route
  -> select recovery-only operation
  -> host or executor dispatches bounded primary repair
  -> verify /readyz and exact Nexus surface
  -> refresh or attest host catalog where the host supports it
  -> receive FAILBACK_PRIMARY
  -> return mission work to Nexus
  -> retire temporary recovery selection
```

The primary Nexus process cannot invoke a sibling MCP connector merely because
the host configured both. That dispatch remains a host/executor boundary unless
a separate independently surviving bridge is introduced. The controller now
states this external boundary explicitly instead of reporting a vague
unavailable fallback.

## Recovery-owner safety

The stronger controller and the old health-only watchdog must not both restart
Nexus.

`scripts/zes-nexus-primary-recovery.mjs` now observes configured competing
systemd units. Effects-enabled recovery returns
`COMPETING_RECOVERY_OWNER` while the old
`devspace-zesnexus-health.timer` is active. Observation-only mode remains safe
to run before cutover.

When the bounded restart budget is exhausted or restart safety is unverified,
the controller emits a concrete host-mediated recovery contract containing:

- the Legacy repair tool subset;
- required inspect/repair/verify capabilities;
- explicit no-Nexus-bootstrap requirement;
- host-dispatch boundary;
- no mission or replay authority;
- exact failback postconditions.

## Production activation boundary

Source publication does not activate the new recovery controller.

The safe runtime sequence remains:

1. deploy the new source in observation-only mode;
2. verify normal-operation receipts and a bounded degraded probe;
3. run an isolated recovery-only route attestation and failback canary;
4. disable the old health-only watchdog;
5. enable new controller effects;
6. inject one bounded fault;
7. verify one owner, one repair attempt, exact readiness/surface postconditions,
   and failback;
8. preserve Legacy as an independent recovery route, not a shadow authority.

## Native successor direction

The stable projection is the compatibility path for current ChatGPT hosts. The
longer-term native path is MCP protocol self-description and discovery through
the current SDK generation. Moving to that path must preserve the frozen
bootstrap ABI for existing clients and must not assume that a protocol
notification proves host catalog refresh.

Relevant external patterns:

- MCP server discovery and tool-list change notification in the current MCP
  specification;
- desired/current-state reconciliation and single-controller ownership from
  Kubernetes controllers;
- monitor/analyze/plan/execute over explicit knowledge from autonomic-computing
  systems.

These patterns guide the mechanism; DevSpace-specific admission, authority,
and host-boundary decisions remain locally validated.
