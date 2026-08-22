# Degraded Operational Continuity

`DEVSPACE_TOOL_MODE=continuity` defines the secondary DevSpace runtime used
when Nexus is unavailable and bounded primary repair cannot restore the exact
capabilities needed by the current operation. Its purpose is to make primary
repair failure distinct from execution failure.

The continuity service is not a second Nexus. It is an independently deployed,
independently stateful execution plane with a smaller authority surface. It can
continue a bounded engineering loop while publication, runtime activation,
fresh research, and other authority-bearing operations remain frozen.

## Operating objective

The minimum successful continuity loop is:

```text
inspect current Git and local evidence
  -> open or reuse a workspace; prefer a managed worktree for mutation
  -> read/search source
  -> apply an explicit patch
  -> run and continue tests or builds
  -> record a Git-bound recovery capsule
  -> hand off to another continuity-local session when needed
  -> preserve the candidate until Nexus is verified or a rightful owner acts
```

The loop deliberately ends before repository publication or runtime
deployment. A candidate created under continuity mode is ordinary local Git
state. It does not become canonical merely because the primary is unavailable.

## Recovery and fallback state machine

Continuity is entered only through a bounded transition:

```text
primary route requested
  |
  +--> primary functional and exact capability present --> use primary
  |
  +--> reconnect / catalog repair / functional repair available
  |       --> one recovery owner attempts bounded repair
  |
  +--> unknown effect or repair outcome
  |       --> reconcile; do not replay or reroute that effect
  |
  +--> repair exhausted or blocked
          |
          +--> continuity route independently reachable
          +--> exact tools/list fingerprint observed
          +--> required capability subset qualified
          +--> isolation and failback evidence present
          +--> one operation-scoped route selection recorded
                  |
                  v
             continue bounded work
```

Reachability alone is insufficient. The selected route is bound to the exact
operation contract and exact continuity surface fingerprint. A tool-surface,
policy, capability, or safety change invalidates the prior selection.

## Fixed capability boundary

The profile is degraded globally but may be qualified as equivalent for one
exact operation in the survival core.

| Capability class | Continuity status | Boundary |
| --- | --- | --- |
| `workspace_read` | admitted | Workspace-bounded open, read, search, glob, and directory listing. |
| `workspace_mutation` | admitted | Explicit `apply_patch` mutation in an opened workspace; no hidden shell-file writer. |
| `process_continuation` | admitted | `exec_command` plus durable `write_stdin` polling or interaction. |
| `cross_session_coordination` | admitted locally | Execution-scope list/status/audit and mailbox handoff among sessions connected to the same continuity service. |
| `recovery_checkpoint` | admitted locally | Advisory turn horizon and Git-bound recovery capsule in continuity-owned state. |
| `artifact_transfer` | optional | Available only when artifact ingress is configured and present in the exact surface. |
| `research_freshness` | excluded | No Research Reflex provider or fresh-research sufficiency claim. |
| `repository_publication_effect` | excluded | No push/publication tool or publication authority. |
| `conversation_recovery` | excluded | No wake, browser, or conversation-delivery effect. |
| Codex control | excluded | Read-only fixed Codex/AOQ inspection may remain available; generic Codex session or turn effects do not. |
| destructive workspace lifecycle | excluded | Inventory and GC preview may be read; close and GC execution are absent. |

This boundary is enforced at startup. Continuity mode rejects configuration
that enables subagents, Research Reflex, self-repository publication,
conversation transport, or Codex integration, or disables the observability,
mailbox, or turn-continuity core.

## Machine-readable contract

`execution_scope_status` includes:

```text
backendRuntime.continuityProfile
```

The projection uses schema `devspace.continuity-profile.v1` and reports:

- the exact complete MCP descriptor fingerprint and continuity surface epoch;
- required and missing survival-core tools;
- admitted and excluded capability references;
- the operation-scoped selection and deterministic-failback requirements;
- the prohibition on research, publication, deployment, conversation effects,
  effect replay, and destructive workspace lifecycle operations;
- the required service, state-directory, and release isolation;
- the explicit lack of canonical task, decision, writer, publication, runtime,
  or replay authority.

The profile reports `ready` only when every required survival-core tool is
registered. It is an executor observation, not permission to reroute or mutate
canonical state.

## State topology

The secondary must use a different:

- systemd service and process;
- immutable release path;
- configuration and OAuth secret;
- state directory and SQLite database;
- worktree root;
- network port and public connector identity;
- route fingerprint and surface epoch.

It must not mount or copy the Nexus execution database as writable state. It
must not consume Nexus effect receipts as retry authorization. A recovery
capsule may carry bounded references to rightful owners, but current Git,
writer, runtime, and effect authority must be read again before exact action.

Running both services on the same host still leaves a host-level correlated
failure domain. The separate process/state/release boundary protects against a
large class of Nexus code, configuration, database, deployment, and restart
failures, but it does not protect against host loss, disk loss, kernel failure,
or host-wide network isolation. A future remote secondary may reduce that
ceiling, but it must preserve the same authority and operation-selection rules.

## Cross-service handoff

Nexus scopes and continuity scopes do not silently share mailboxes or semantic
capsules. During failover:

1. Preserve the latest available Nexus capsule or Git-bound frontier.
2. Open the exact repository/worktree through continuity mode.
3. Re-read current Git and rightful owner state.
4. Record a new continuity-local capsule that references, but does not import
   authority from, the prior Nexus evidence.
5. Coordinate subsequent sessions through the continuity-local mailbox.

When Nexus recovers, perform the inverse reconciliation. Do not copy the
continuity SQLite database into Nexus. Reconcile the exact Git candidate,
validation receipts, current remote main, writer state, and any external effect
before resuming an authority-bearing lane.

## Failback

Failback is mandatory after verified recovery. The minimum probe binds:

- primary functional readiness, not liveness alone;
- the exact expected Nexus runtime identity;
- the exact complete Nexus tool-surface fingerprint and epoch;
- the capabilities required by the next operation;
- current host catalog visibility when a new or privileged tool is required;
- reconciliation of any in-flight or indeterminate effect.

After those conditions pass, retire the operation-scoped continuity selection
and route new work to Nexus. Existing continuity-local worktrees remain ordinary
Git candidates and are not deleted automatically.

## Qualification canary

A release is not continuity-capable until an isolated canary proves the whole
survival loop with no Nexus calls:

1. Start the candidate from its own immutable release, port, state directory,
   and worktree root.
2. Verify `implementation=devspace-continuity`, a `continuity:` surface epoch,
   and `continuityProfile.state=ready`.
3. Assert every required core tool is present and every excluded effect tool is
   absent.
4. Open a disposable Git worktree for the mutation canary.
5. Read and search a fixture.
6. Apply a bounded patch.
7. Run a validation process and exercise `write_stdin` continuation.
8. Record and read a recovery capsule.
9. Send, observe, acknowledge, and act on one continuity-local peer message.
10. Confirm no repository publication, runtime deployment, conversation effect,
    Codex control, or destructive workspace-lifecycle route exists.
11. Stop the candidate and prove the current production Legacy and Nexus
    services were unchanged.

The acceptance result should bind the immutable build digest, exact descriptor
fingerprint, configuration digest, test artifacts, and cleanup receipt. A
passing source-level test alone is not production activation evidence.

## Deployment and rollback gates

Use the example files under `examples/systemd/` as templates. Activation must
remain separate from source publication and should follow this order:

1. Publish a clean, validated source candidate.
2. Build an immutable continuity release without modifying the Nexus release.
3. Generate and pin the exact continuity tool-surface manifest.
4. Run the isolated canary on a non-production port.
5. Install a separate continuity systemd service and environment file.
6. Verify the host connector sees the exact continuity fingerprint.
7. Retain the previous Legacy binary/service definition as the rollback target.
8. Change the host connector only after the secondary is independently ready.
9. Do not stop or restart Nexus merely to activate the secondary.

Rollback means restoring the previous Legacy connector target and service,
then verifying that no continuity-local effect was treated as canonical. Local
worktrees and capsules are preserved for explicit reconciliation rather than
silently discarded.

## Reopen conditions

Reopen the survival-core design when:

- a real outage blocks a common coding loop because a required capability is
  absent;
- a supposedly independent route shares a newly discovered Nexus failure
  dependency;
- a continuity-local operation accidentally requires publication, runtime, or
  canonical authority;
- the host gains a stronger native connector-failover mechanism;
- failback cannot reconcile a continuity-created candidate without manual
  state archaeology.

The default response is to add the narrow missing operation or improve the
handoff contract, not to copy the full Nexus control plane into the secondary.
