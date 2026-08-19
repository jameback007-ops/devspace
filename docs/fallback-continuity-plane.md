# Fallback Continuity Plane

The fallback continuity plane is a provider-neutral policy boundary for deciding
what may happen after the primary Nexus route is degraded or unavailable. It is
not a second Nexus, a hidden router, or a new source of task, writer, release,
memory, publication, or effect authority.

The initial implementation is source-only. It does not start, restart, deploy,
or mutate the Legacy service. It does not automatically invoke a fallback. It
turns current primary-recovery evidence and independently verified route
attestations into a bounded decision that a caller may enforce.

The external contracts are versioned as
`zes.fallback-route-attestation.v1`, `zes.fallback-selection.v1`,
`zes.fallback-operation-contract.v1`, and
`zes.fallback-continuity-assessment.v1`. Unknown route or selection versions
fail closed rather than being interpreted as the current semantics.

## Position in the recovery path

```text
requested operation
        |
        v
MCP primary-recovery assessment
        |
        +--> primary healthy ----------------------> use primary
        |
        +--> bounded primary repair available ----> repair primary
        |
        +--> repair in progress -------------------> wait for one owner
        |
        +--> repair exhausted or blocked
                    |
                    v
          fallback continuity assessment
                    |
                    +--> exact equivalent route ---> explicit selection
                    +--> bounded read route --------> read-only claim ceiling
                    +--> recovery route ------------> repair/preserve only
                    +--> survival route ------------> checkpoint and safe-land
                    +--> no safe route --------------> hard block
```

The policy consumes the published
`zes.mcp-primary-recovery-assessment.v1` contract through
`assessFallbackContinuityFromPrimaryRecovery`. It does not fork or replace the
primary-recovery state machine. Transport retry, reconnect, circuit breaking,
output usability, and exact effect reconciliation remain responsibilities of
the MCP Transport Supervisor and the authoritative effect owner.

When that upstream assessment directs catalog attestation, refresh, reconnect,
functional repair, or bounded diagnosis, the continuity plane returns
`repair_primary` without selecting a competing alternate recovery route. A
`WAIT_FOR_RECOVERY_OWNER` assessment likewise preserves the single active
owner. Richer fallback evaluation begins only after the authoritative primary
recovery path is exhausted or blocked.

## Route quality classes

| Class | Permitted use | Explicitly not permitted |
| --- | --- | --- |
| `quality_equivalent` | One exact selected operation when capability, authority, freshness, quality, isolation, fingerprint, and failback evidence all pass. | Implicit rerouting, authority transfer, shared state, or blind effect replay. |
| `degraded_read_only` | A bounded ordinary read whose output is not used for a quality-critical claim. | Fresh research, validation, canonical mutation, publication, or any material effect. |
| `recovery_only` | Independent inspection, primary repair, post-repair verification, state preservation, or recovery support. | Normal mission execution or acquisition of canonical authority. |
| `survival_only` | Preserve exact state, record a checkpoint, and end the turn cleanly. | Continuing material work or claiming mission completion. |
| `insufficient` | No operational use. | All work and recovery claims. |

The class describes semantic capability, not route health. Every admitted route
must also be functionally healthy and carry a verified attestation.

## Required route evidence

A route name or matching tool name is not equivalence evidence. An eligible
route is bound to all of the following:

- exact route and typed policy references;
- a verified route attestation and healthy functional state;
- a named canonical fingerprint basis plus a lowercase SHA-256 fingerprint of
  the complete current route contract or tool descriptors;
- the exact required capability subset;
- the exact required authority classes;
- evidence that fallback state is isolated from primary state;
- evidence that fallback authority is isolated from primary authority;
- evidence that the route is in a failure domain independent enough to remain
  useful during the observed primary failure;
- quality-equivalence evidence when the route claims equivalence;
- fresh-research, validation-readback, or canonical-state evidence when the
  operation requires those properties;
- an evidence reference for the post-recovery primary probe used by
  deterministic failback.

Route limitations are carried as bounded machine codes, not free-form prose, so
an untrusted route probe cannot inject model-facing instructions through the
assessment payload.

The planner checks the typed envelope and evidence presence. It does not
dereference or independently prove arbitrary evidence references. A future
route-attestation provider must verify the underlying route and issue the
bounded descriptor consumed by this policy.

## Explicit selection

An eligible route is still not selected automatically. One selection binds:

```text
route reference
  + policy reference
  + exact fingerprint basis
  + exact current route fingerprint
  + exact operation-contract digest
  + verified selection-attestation state
  + selection evidence reference
```

The operation-contract digest covers the operation reference, intent, retry or
effect safety class, required capability and authority sets, quality
requirements, and exact effect key when present. If either the operation
contract or route fingerprint changes, the prior selection is stale and the
planner rejects it. This prevents a selection made for one semantic operation
or one Legacy/continuity build from silently authorizing another.

This explicit-selection rule applies to **mission fallback**. A verified
recovery-only route may be identified as the bounded primary-repair path, and a
verified survival route may be identified for checkpoint/safe-landing, because
neither path is admitted to perform the original mission. The planner still
does not invoke either route and grants no effect authority.

## Quality-critical operations

The assessment treats research, validation, source mutation, repository
publication, runtime effects, and conversation effects as quality-critical.
The primary route and a proposed equivalent route must carry the specific
evidence required by the request:

- fresh research requires fresh-evidence references;
- validation requires authoritative readback evidence;
- canonical mutation requires canonical-state evidence;
- an effect requires an exact authority reference and an authoritative
  reconciliation route.

Missing evidence does not become permission to use stale local judgment. The
plane selects a survival route when available, otherwise it returns a hard
block.

## Effect safety

Fallback does not weaken effect rules.

- An indeterminate effect is reconciled through its authoritative owner before
  any retry or cross-route fallback.
- Without an authoritative reconciliation route, only that effect lane is
  frozen.
- A terminally successful effect is consumed from its receipt and never
  replayed.
- A terminal failure requires an owner-authorized distinct successor effect.
- Even a quality-equivalent fallback effect requires explicit owner
  authorization with a verified attestation state for the exact fallback effect
  route.

The returned policy always reports `effectReplayAuthorized: false` and
`canonicalAuthorityTransferred: false`.

## Failback

Fallback is temporary continuity, not a new default. The planner returns
`failback_to_primary` only when the current primary route is healthy, its exact
required capability and authority subset is available, its attestation is
verified, its fingerprint is present, and a claimed recovery carries recovery
evidence. Mission fallback routes other than survival routes must carry the
evidence reference for the exact primary failback probe.

The intended lifecycle is:

```text
primary fails
  -> primary-first bounded recovery
  -> explicit fallback only if recovery cannot preserve the operation
  -> periodic or event-driven primary probe
  -> verified primary readiness and catalog/capability attestation
  -> deterministic failback
  -> retire the temporary operation selection
```

## State and authority isolation

Capability overlap is allowed. Authority duplication is not.

The Legacy or continuity service may expose compatible read, recovery, or
checkpoint capabilities, but it must not silently share the Nexus database or
become a shadow source of canonical work, accepted decisions, writer ownership,
publication state, effect receipts, or durable product memory. State replication
for observability or recovery must remain explicitly non-authoritative and
reconcilable with the rightful owner.

## Current source boundary

The initial source slice provides:

- `assessFallbackContinuity` for a normalized provider-neutral request;
- `assessFallbackContinuityFromPrimaryRecovery` for the published primary MCP
  recovery assessment;
- deterministic decision and route assessment output;
- strict input/reference validation and credential-bearing URI rejection;
- behavioral tests for primary preference, repair-first routing, explicit
  selection, fingerprint drift, quality classes, research/validation evidence,
  failure-domain isolation, effect terminality, safe landing, and failback.

It deliberately does not yet provide:

- a live Legacy route-attestation provider;
- a persistent fallback registry or a second control database;
- a fallback invocation actuator;
- automatic production failover;
- runtime deployment or systemd ownership;
- production SLO measurements.

## Next integration slice

The next runtime-facing slice should remain additive and read-only first:

1. Observe the actual Legacy/continuity endpoint through an independent probe.
2. Produce a bounded route descriptor with complete fingerprint, functional
   readiness, capability, authority, isolation, and failure-domain evidence.
3. Project the assessment through the existing stable
   `execution_scope_status` control plane without requiring a new bootstrap
   tool.
4. Run observation-only canaries for each quality class and failback transition.
5. Enable any invocation effect only under a separate single-owner runtime
   effect with rollback and post-effect readback.

Production activation must remain separate from source publication. A local
build or passing policy test is not evidence that Legacy or Nexus failover is
active.
