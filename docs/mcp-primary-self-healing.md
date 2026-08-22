# MCP Primary-First Self-Healing

Status: source and test integration candidate. The stable control-plane policy,
model-oriented capability directory, recovery-only Legacy projection,
functional readiness endpoint, and out-of-band recovery controller are
implemented. Production systemd activation, independently verified live Legacy
route attestation, ChatGPT host-refresh automation, and diagnostic-agent
dispatch remain separate governed effects.

## Purpose

The primary Nexus MCP must be repaired before the harness silently settles on
the lower-capability Legacy route. A fallback is useful for survival and
diagnosis, but availability alone does not make it quality-equivalent for a
specific mission.

The required operating order is:

```text
primary call or catalog problem
  -> bounded reconnect / catalog repair
  -> deterministic primary repair when proven safe
  -> one bounded diagnostic recovery owner when judgment is needed
  -> stable read-only control-plane projection when it exactly satisfies need
  -> typed quality-equivalent fallback only after repair is exhausted
  -> safe turn landing when missing capability would reduce quality
  -> verified failback to the primary
```

The sequence is policy, not a prompt convention. It is projected through the
stable `execution_scope_status` bootstrap and implemented by an independent
host recovery controller.

## Why fallback-first is unsafe

Legacy can preserve a coding loop with `open_workspace`, `read`, `apply_patch`,
`exec_command`, and `write_stdin`. It may still lack current research,
continuation, cross-session coordination, effect reconciliation, governed
publication, and conversation recovery capabilities.

Three failures result when the harness treats any available fallback as a
drop-in replacement:

1. A missing tool becomes an invisible quality reduction rather than an
   explicit degraded state.
2. The primary failure persists because every agent routes around it instead
   of electing one repair owner.
3. Multiple agents may independently reconnect, restart, or roll back the same
   primary and create a recovery storm.

The primary-first policy prevents all three.

## Current upstream and host boundaries

MCP supports optional `tools.listChanged` capability declaration and
`notifications/tools/list_changed`. These are useful cache-invalidation hints,
not proof that a particular host refreshed and approved its catalog.

ChatGPT custom MCP actions use an approved snapshot. Updates are not enabled
automatically; an owner or admin may need to review a diff and explicitly
refresh the app actions. A DevSpace server response cannot force the ChatGPT
host to perform that refresh.

The current MCP transport revision removes protocol-level sessions for the new
transport model, while compatibility with older stateful clients remains a
deployment concern. Transport reconnection and old-session recreation therefore
remain typed adapter responsibilities rather than generic retry guesses.

These boundaries produce two distinct recovery planes:

- **server and service recovery**, which ZES can automate out of band;
- **host catalog recovery**, which needs an attested host-native or semantic UI
  actuator and otherwise ends at a typed manual-refresh requirement.

## Components

### 0. Capability orientation and failure-layer separation

`src/mcp-capability-orientation.ts` projects an intent-oriented directory through
the stable `execution_scope_status` route. It separates:

- primary server registration;
- capability-directory classification;
- host catalog visibility;
- sibling fallback-route reachability;
- route attestation and planner admission.

This prevents a new session from treating a partial host catalog or missing
directory metadata as proof that DevSpace lacks a capability. Registered tools
that are not classified become explicit self-evolution candidates rather than
remaining invisible. See `docs/mcp-capability-orientation.md` for the full
contract.

### 1. Capability-aware primary recovery policy

`src/mcp-primary-recovery.ts` defines mission capability classes rather than
using raw total tool count as the work gate:

- `bootstrap`
- `workspace_read`
- `workspace_mutation`
- `process_continuation`
- `research_freshness`
- `continuation_readback`
- `cross_session_coordination`
- `repository_publication_preflight`
- `repository_publication_effect`
- `recovery_checkpoint`
- `conversation_recovery`
- `artifact_transfer`

The assessment compares:

- the server-registered surface;
- the complete client-attested surface when supplied;
- tools already proven callable in the current bootstrap;
- stable read-only capability projections;
- the exact task capability requirements;
- bounded recovery route and attempt state;
- fallback tool evidence, quality-equivalence attestation, and policy ref.

Its terminal dispositions are:

| State | Meaning |
| --- | --- |
| `CONTINUE_PRIMARY` | Primary and required capability subset are usable. |
| `FAILBACK_PRIMARY` | A mission running on fallback can return to a verified current primary. |
| `ATTEST_CLIENT_CATALOG` | Capability-critical work must wait for complete client catalog evidence. |
| `USE_STABLE_CONTROL_PLANE` | The exact read-only need is satisfied through the old stable bootstrap. |
| `REFRESH_CLIENT_CATALOG` | Host refresh/reconnect must run before material work. |
| `RECONNECT_PRIMARY` | Transport-level bounded reconnect is the next recovery step. |
| `REPAIR_PRIMARY` | One owner may execute an admitted deterministic repair. |
| `DIAGNOSE_PRIMARY` | Deterministic repair is unavailable or unsafe; bounded model judgment is required. |
| `WAIT_FOR_RECOVERY_OWNER` | Another owner holds the incident lease; competing repair is forbidden. |
| `USE_QUALITY_EQUIVALENT_FALLBACK` | Repair is exhausted and the fallback is caller-attested as a planner candidate; normal work remains held until an operation-scoped continuity selection is bound. |
| `SAFE_TURN_LANDING` | End the turn before capability loss lowers quality or safety. |
| `HARD_EXTERNAL_BLOCKER` | No safe repair, fallback, or landing route is available. |

Effectful capabilities never move implicitly to fallback. A fallback policy ref
and tool parity are necessary but not sufficient to transfer effect authority.
Even a planner-admitted read-only or non-effect candidate reports
`invocationAuthorized: false` until the fallback-continuity plane binds an
operation-scoped selection to the exact policy, descriptor fingerprint,
capability, quality, and safety contract.

### 2. Stable bootstrap projection

`execution_scope_status` accepts additive optional evidence:

- `requiredCapabilityRefs`
- `activeMcpRoute`
- `fallbackAvailable`
- `fallbackRouteReachable`
- `fallbackRouteRef`
- `fallbackRouteKind`
- `fallbackRouteAttestationState`
- `fallbackRouteAttestationRef`
- `fallbackFingerprintBasis`
- `fallbackObservedToolNames`
- `fallbackObservedFingerprintSha256`
- `fallbackQualityEquivalentAttested`
- `fallbackQualityEvidenceRefs`
- `fallbackPolicyRef`
- `fallbackStateIsolationEvidenceRef`
- `fallbackAuthorityIsolationEvidenceRef`
- `fallbackFailureDomainEvidenceRef`
- `fallbackRecoveryAuthorityRef`
- `fallbackFailbackProbeEvidenceRef`
- `fallbackRecoverySelectionRef`
- `catalogRefreshEvidenceRefs`
- `diagnosticEvidenceRefs`

The result appears under:

```text
stableControlPlane.capabilities.primaryMcpRecovery
stableControlPlane.capabilities.mcpCapabilityOrientation
stableControlPlane.capabilities.mcpFallbackRecovery
```

This is deliberately behind an existing stable ABI tool. A stale client does
not need to discover a new top-level recovery tool before learning that its
catalog is incomplete or that work must stop.

`fallbackAvailable` is retained as a compatibility alias for one
caller-observed route-reachability fact. Omission does not mean that Legacy is
unreachable because Nexus cannot observe sibling host connectors. New clients
must read route reachability, route attestation, and planner admission as
separate states.

The arguments are observations and task requirements only. They grant no
writer, deployment, runtime, publication, memory, or effect authority.

### 3. Functional readiness

`GET /healthz` remains a shallow process-liveness endpoint.

`GET /readyz` verifies the function the MCP path actually depends on:

- a read-only sentinel on the same long-lived SQLite connection used by
  execution-scope MCP calls;
- initialized non-empty runtime tool surface;
- active MCP tool count held in process memory;
- live workspace process count;
- every child process in the current Nexus systemd cgroup, independent of the
  SQLite queue. This covers shell jobs, local-agent workers, and provider
  children without counting Legacy processes in its separate cgroup.

It returns HTTP 200 only for `READY`, otherwise HTTP 503. A separate
`restartSafety` is `safe` only when no MCP tool, managed workspace process, or
Nexus service child is active and the cgroup observation itself succeeded. A
service may be functionally healthy while restart safety is deferred; readiness
and restart permission are intentionally separate.

The endpoint returns normalized error kind and SHA-256 evidence only. It does
not return raw SQLite errors, commands, outputs, credentials, or task state.

This closes the incident class in which `/healthz` remained 200 while every
`/mcp` request failed with a database I/O error.

### 4. Out-of-band recovery controller

`scripts/zes-nexus-primary-recovery.mjs` runs outside the primary Nexus service
failure domain. It never opens the live SQLite database itself.

Its bounded lifecycle is:

1. acquire one process lease;
2. probe fixed loopback `/readyz` and fixed systemd service state;
3. require a configurable consecutive-failure threshold;
4. defer while active tools or processes exist;
5. verify that no competing recovery/watchdog owner is active before effects;
6. persist a before-effect incident receipt;
7. restart only `devspace-zesnexus.service`, at most once per incident by
   default;
8. require multiple consecutive readiness probes from the same changed backend
   instance with one stable surface epoch and canonical complete tool-surface
   fingerprint, and require the server-side freshness assessment to confirm
   that this surface matches the digest-pinned deployment manifest;
9. clear the runtime incident state but explicitly withhold mission failback
   until the host catalog is refreshed or attested and the stable recovery
   projection returns `FAILBACK_PRIMARY`;
10. freeze further automatic repair and emit a bounded host-mediated
    recovery/diagnostic contract on
   failure.

Repeated probes in the same recovery state update the single incident state
file but do not create another durable receipt. A new durable receipt is emitted
only on a state transition or material repair attempt, preventing a degraded
timer from becoming unbounded storage growth.

The controller cannot deploy a release, roll back code, delete or copy a
database, mutate Legacy, or replay an MCP effect. Repair effects are disabled
unless `ZES_NEXUS_PRIMARY_RECOVERY_EFFECTS=1` is explicitly configured.
Even after runtime recovery succeeds, its receipt reports
`missionFailbackAuthorized: false`; runtime readiness and exact server-surface
identity do not prove that the host can call the complete current catalog.

When effects are enabled, the controller returns
`COMPETING_RECOVERY_OWNER` while the old
`devspace-zesnexus-health.timer` is active. Observation-only mode may coexist
temporarily, but restart ownership must be singular before the new controller
can mutate the service.

After automatic repair exhaustion, the controller now emits an actionable
recovery-only host contract instead of a vague manual fallback. It names the
minimum source-capable Legacy tool subset (`open_workspace`, `read`,
`apply_patch`, `exec_command`, and `write_stdin`), states that the Nexus
bootstrap ABI is not required, forbids mission/effect-replay authority, and
requires exact readiness, surface, catalog, and failback postconditions. Route
selection itself does not authorize a repair effect: source or runtime mutation
still requires a separate effect gate bound to the exact repair plan and effect
identity. Dispatch remains host-mediated because one MCP server cannot invoke a
sibling connector configured by the host, and the controller does not verify
caller-supplied sibling-route evidence on the host's behalf.

### 5. Diagnostic recovery agent

Some failures need judgment: WAL lifecycle faults, migration drift, proxy
misrouting, a corrupt release binding, or an unknown effect boundary cannot be
resolved safely by a fixed restart rule.

When deterministic recovery cannot proceed, the controller emits a sanitized
`diagnosticRequest` in the incident receipt. The intended dispatcher elects one
out-of-band recovery agent and supplies:

- readiness and service observations;
- release and runtime identity refs;
- normalized fault digests;
- active work and restart-safety state;
- effect/writer reconciliation refs when available;
- the exact allowed repair envelope.

The agent follows:

```text
observe -> hypothesize -> falsify -> propose -> safety classify
        -> bounded repair -> verify -> failback or escalate
```

It may perform only admitted repair classes. Database deletion, migration
rewrite, unknown-effect replay, arbitrary rollback, credential exposure, or
Legacy mutation remain blocked. The source candidate emits the dispatch
contract; production dispatch wiring is not yet activated.

### 6. Host catalog recovery

When the server exposes 63 tools and the host attests 34, the stable policy
returns `REFRESH_CLIENT_CATALOG` before capability-critical work. It does not
assume that starting a new conversation refreshed the app.

The preferred actuator order is:

1. host-native app action refresh/reconnect, when officially exposed;
2. a verified semantic Interaction Broker adapter for the ChatGPT app settings
   surface;
3. explicit operator refresh;
4. stable read-only projection for an exact supported need;
5. fallback or safe turn landing after the bounded repair cycle is exhausted.

The existing Conversation Web UI broker is scoped to prompt delivery and is not
silently reused for app-settings mutation. Catalog refresh needs its own target,
pre-state, approval, persistence, postcondition, and action-diff verification.

## Fallback admission

There are two different fallback classes:

1. **recovery-only fallback**, which may inspect, repair, and verify Nexus after
   explicit route attestation and operation-scoped selection; and
2. **mission fallback**, which continues the original work and therefore needs
   exact capability and quality equivalence.

Legacy does not need the full Nexus ABI or mission quality equivalence merely
to serve as a recovery-only primary-repair plane. It still needs independent
reachability, surface fingerprint, failure-domain/state/authority isolation,
bounded recovery authority, and a failback probe. That route never acquires the
original mission or effect-replay authority.

Fallback becomes a planner-admitted candidate only when all conditions hold:

1. primary reconnect, repair, and diagnostic stages are exhausted or proven
   unavailable;
2. the declared mission capability classes permit fallback;
3. the fallback attests every required direct tool or matching stable
   projection;
4. the complete fallback descriptor fingerprint is present;
5. a typed fallback policy ref and bounded quality-evidence refs are present;
6. quality equivalence is explicitly attested for this causal slice;
7. no effectful capability is being implicitly transferred.

Planner admission is not invocation. The operation remains held until a
separate fallback-continuity selection is recorded for the exact operation;
material effects additionally require their own fresh effect authority and
reconciliation gate.

If any condition fails and a recoverable frontier can be recorded, the policy
chooses `SAFE_TURN_LANDING`. Ending a turn is preferable to continuing with
missing research, validation, canonical-state, recovery, or effect controls.

## Production activation

Example units are under `examples/systemd/`.

Recommended activation sequence:

1. publish and deploy a release containing `/readyz` and this controller;
2. verify `/healthz` and `/readyz` locally and through the intended proxy;
3. copy the controller to a fixed host path outside the mutable release link;
4. install the service and timer with repair effects disabled; the example unit
   uses dedicated systemd `RuntimeDirectory` and `StateDirectory` roots so the
   sandbox never depends on a pre-existing writable receipt directory;
5. observe receipts under normal operation and one isolated failed probe;
6. attest the independent Legacy recovery-only route and rehearse the
   host-mediated selection without invoking a repair effect;
7. disable the old health-only restart timer so there is exactly one restart
   owner;
8. enable the effects drop-in and run a bounded non-production fault canary;
9. verify one controlled primary restart, stable probes, exact surface,
   catalog repair where supported, and session failback;
10. retain Legacy on its independent state/database and service path.

Do not activate this controller concurrently with another Nexus deployment or
runtime-repair owner.

## Example systemd behavior

The observation-only service is safe to install first:

```text
ZES_NEXUS_PRIMARY_RECOVERY_EFFECTS=0
```

After canary validation, a drop-in may set:

```text
ZES_NEXUS_PRIMARY_RECOVERY_EFFECTS=1
```

The timer runs every 30 seconds. systemd already serializes invocations of one
oneshot unit; the controller also holds its own lease to prevent manual or
cross-controller duplication.

## Validation

Load-bearing tests cover:

- partial client catalog repairs before fallback;
- stable projection use without new direct-tool discovery;
- reconnect and deterministic repair ordering;
- one recovery owner;
- fallback admission only after repair exhaustion;
- safe turn landing for research and effect capability deficits;
- verified failback to primary;
- explicit separation of fallback reachability, route attestation, and planner
  admission;
- rejection of post-restart probes whose backend instance, surface epoch, or
  complete tool-surface fingerprint is missing or drifts across the stability
  window;
- separation of runtime recovery from host catalog attestation and final
  `FAILBACK_PRIMARY` mission authority;
- recovery-only Legacy qualification without the Nexus bootstrap ABI;
- operation-scoped recovery selection and failback-before-mission behavior;
- capability-directory drift and host/server failure-layer classification;
- same-connection database readiness and active-tool accounting;
- functional HTTP `/readyz` response;
- restart threshold, active-work deferral, effects-off behavior, one-attempt
  budget, competing-watchdog rejection, and host-mediated diagnostic
  escalation;
- rejection of non-loopback readiness targets and exclusion of raw errors.

## Remaining work

The following are intentionally not claimed complete by this source candidate:

- production systemd installation and effect enablement;
- disabling the old health-only watchdog after observation-only canary evidence;
- live independent Legacy route attestation and host-mediated repair dispatch;
- a ChatGPT-host-native catalog refresh API;
- a verified semantic UI adapter for ChatGPT app action refresh;
- out-of-band diagnostic-agent dispatch and its canary;
- production fault injection proving the exact historical SQLite/WAL incident
  is detected and repaired end to end.

Those are activation and host-integration tails, not reasons to route directly
to Legacy. Until they are closed, the stable assessment makes the limitation
explicit and prefers a safe turn boundary over silent quality loss.
