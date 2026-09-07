# MCP stability repair — 2026-09-08

## Confirmed boundaries

The public Nexus route used port 7683 / source 837181a while the obsolete
`devspace-zesnexus.service` on port 7677 remained running with the same state
directory. Both turn-continuity timers scanned all recent database scopes.
The old process overwrote the active process's landing envelope and manufactured
`backend_instance_changed_since_envelope` instability. Two shared-database
regressions reproduce cold-observer and draining-observer corruption.

The timer now visits only locally observed host scopes. It checks fresh horizon
activity and the persisted backend identity under an immediate SQLite transaction
before writing. A direct host boundary can observe a genuine backend change;
a standby timer or read-only peer inspection cannot claim the scope. This is
executor observation isolation, not a new task lease or permission mechanism.
Obsolete unpatched processes still require normal safe retirement.

The recovery controller was also pinned to the obsolete unit and port. Its
deployment-owned `ZES_NEXUS_PRIMARY_SERVICE_NAME` now binds inspection, restart,
receipts and isolated incident counters to one validated Nexus service. Pair it
with `ZES_NEXUS_PRIMARY_READY_URL` for that same service. Defaults retain the old
single-unit layout. Existing effect enablement, one-recovery-owner controls,
restart-safety checks and restart budgets remain unchanged. A deployment must
update the effective systemd configuration, not only the base unit file.

The LangChain tunnel had a runtime systemd drop-in pointing to v9 staging on
2035, overriding its base production route on 2031. The staging environment
allowed only `/tmp/zes-v9-continuity-fixture`. The bridge's old error printed
the allowed-root list after a misleading colon; it did not replace request
arguments. The revised error distinguishes `requested=` from `allowed=` and
keeps the containment check intact.

## Operational repair contract

Keep the v9 continuity capability and durable workspace state; do not silently
downgrade to the older production binary merely to obtain a different root
policy. A production promotion must explicitly bind the intended production
filesystem policy, immutable code, persistent state, native thread/run state,
and actual tunnel target. Preserve the restricted staging configuration for
rollback/testing rather than silently weakening it in place. Check quiescence
and durable state before replacing a service.

Retire an obsolete Nexus process only after exact instance, current proxy route,
zero active tool/process/service-child work, and recovery-controller target
reconciliation. Preserve its source, state and receipts. Source tests do not
prove this operational step happened.

## Host-owned limits

ChatGPT catalog refresh, app account reconnection and host safety decisions are
not controlled by Nexus. Do not mislabel unknown catalog visibility as a missing
server capability, copy a server fingerprint as a fabricated client attestation,
or change Codex approval/sandbox settings to fix direct DevSpace execution.
The earlier denied OAuth-verification script must not be retried or rerouted.
Keep actual connector-call evidence distinct from local transport probes.

Source publication, deployment, independent transport health, actual ChatGPT
callability and resolution of the original intermittent incident are separate
claims. Record each against its own observed receipt.
