# Codex native integration

DevSpace exposes a typed, full-lifecycle edge gateway to one or more native
Codex App Servers. The gateway lets ChatGPT work with Codex as another capable
developer: discover and inspect sessions, measure execution, exchange work,
start or resume sessions, steer turns, and manage supported lifecycle state.

It does **not** place Codex behind DevSpace and does not replace Codex's native
harness. Codex continues to execute directly through its own App Server,
workspace, model, tools, and subscription. DevSpace is an additional client.

```text
Codex native clients ---------------------> Codex App Server
                                                ^
                                                |
ChatGPT -> DevSpace MCP -> privileged gateway --+
```

## Authority boundary

The gateway owns executor-local transport machinery only:

- App Server aliases and connections;
- opaque server, workspace, session, turn, item, approval, cursor, and effect refs;
- bounded read projections and aggregate metrics;
- effect idempotency, receipts, and reconcile-before-retry state.

It does not own canonical task or decision state, Git authority, writer leases,
publication, runtime activation, or business effects. A successful Codex
gateway receipt proves only the exact native Codex operation named by that
receipt. Before overlapping source mutation, callers must still reconcile the
current project writer and active work boundaries.

## Why the surface is typed

The privileged adapter can use the native App Server protocol, but the MCP
surface intentionally has no generic `codex_rpc(method, params)` operation.
Callers cannot submit raw socket paths, filesystem paths, thread IDs, turn IDs,
or rollout paths. This keeps protocol/version translation, validation, secret
redaction, and effect reconciliation inside the adapter without reducing the
native capability set.

The public tools are:

| Area | Tools |
| --- | --- |
| Gateway and discovery | `codex_gateway_status`, `codex_session_list` |
| Session observation | `codex_session_read`, `codex_session_activity`, `codex_live_events` |
| Performance | `codex_session_metrics`, `codex_account_usage` |
| Native capability discovery | `codex_model_list` |
| Native approvals and input | `codex_approval_list`, `codex_approval_respond` |
| Session lifecycle | `codex_session_open`, `codex_session_control` |
| Turn lifecycle | `codex_turn_control` |
| Effect reconciliation | `codex_effect_status` |

`codex_session_open` supports start, resume, and fork. `codex_turn_control`
supports submit, exact-turn steer, and interrupt. Submit performs bounded
start-or-steer race reconciliation instead of assuming that a preceding idle
read remains true. `codex_session_control` supports name and goal updates,
compaction, conversation-history rollback, archive/unarchive, connection-local
unsubscribe, and permanent delete where the installed App Server supports
them.

Rollback changes Codex conversation history only; it does not revert files.
Rollback and permanent delete therefore require separate explicit
acknowledgements.

`codex_live_events` reads the bounded sequence-numbered buffer owned by the
persistent App Server channel. It complements persisted rollout inspection;
it does not replace `codex_session_activity`. Visible message and plan deltas,
lifecycle/status changes, and token updates are projected. Private reasoning
is dropped. Raw command/tool output, patches, audio, and SDP are represented by
size and digest rather than content. Buffer rollover returns `gapDetected`
instead of silently implying a complete stream.

The same connection receives server-initiated command, file, permission,
request-user-input, and MCP elicitation requests. `codex_approval_list` exposes
only bounded safe projections under opaque `approvalRef` values. The gateway
never auto-approves. `codex_approval_respond` sends a typed response on the
same connection generation, and the effect remains indeterminate until the
App Server emits `serverRequest/resolved` or reconciliation proves the result.
Session-wide approval and persistent policy amendments require explicit
acknowledgement. Secret questions and URL-mode elicitation acceptance are
forbidden on the model-facing route.

Approval age is advisory freshness, not request expiry. After
`codexGatewayApprovalStaleAfterSeconds`, a still-pending request is projected as
`stale=true` but remains answerable while the exact connection generation is
alive. Only native resolution or connection-generation loss makes the request
terminal. This avoids abandoning a server request that Codex is still waiting
to settle.

## Root-owned configuration

The privileged bridge reads a `0600` configuration based on
`examples/zes-conversation-transport-bridge.example.json`.

```json
{
  "codexGatewayEnabled": true,
  "codexGatewayEffectsEnabled": false,
  "codexGatewayPersistentChannels": true,
  "codexGatewayLiveEventCapacity": 2000,
  "codexGatewayApprovalStaleAfterSeconds": 900,
  "codexGatewayApprovalRetentionSeconds": 3600,
  "codexRolloutRoots": ["/root/.codex/sessions"],
  "codexAppServers": {
    "primary": {
      "socketPath": "/root/.codex/app-server-control/app-server-control.sock",
      "effectsEnabled": true,
      "workspaceBindings": {
        "zes-blueprint": "/srv/projects/zes-system-blueprint"
      }
    },
    "secondary": {
      "socketPath": "/run/codex-secondary/app-server.sock",
      "effectsEnabled": false,
      "workspaceBindings": {}
    }
  }
}
```

App Server and workspace aliases are server-owned. MCP receives only opaque
refs derived from those bindings. Multiple App Servers are first-class because
runtime liveness belongs to the daemon that owns a loaded thread; persisted
thread history alone is not sufficient runtime evidence.

The existing top-level `appServerSocket` remains the compatibility binding for
the older conversation-wake target registry. `codexAppServers` is the native
integration registry. They may point to the same primary daemon.

## DevSpace configuration

Enable tool registration in the DevSpace service:

```ini
Environment=DEVSPACE_CODEX_INTEGRATION=1
Environment=DEVSPACE_CODEX_INTEGRATION_BRIDGE_SOCKET=/run/zes-conversation-transport-bridge/bridge.sock
Environment=DEVSPACE_CODEX_INTEGRATION_TIMEOUT_SECONDS=30
```

Tool registration does not authorize effects. The root-owned bridge remains
the effect gate through `codexGatewayEffectsEnabled`; each server also has its
own `effectsEnabled` flag. This permits the complete stable tool surface to be
deployed and qualified while writes remain fail-closed.

## Observation and metrics

Session discovery distinguishes persisted, loaded, lifecycle, direct-input,
workspace, Git, and activity-readability evidence. Activity has three views:

- `messages`: visible user/assistant messages only;
- `combined`: messages plus lifecycle/tool metadata without arguments/results;
- `audit`: bounded redacted observable arguments/results, file changes, MCP
  calls, and web results.

Private reasoning and detected credentials are always excluded. Native IDs and
rollout locations remain inside the bridge.

`codex_live_events` is ephemeral transport observation. It reports channel
generation, reconnects, sequence bounds, pending approval count, and explicit
event gaps. A reconnect expires unresolved approval refs from the older
generation rather than answering a stale request on a new connection.

Time by itself never expires an approval. `freshness=stale` means the caller
should re-read current Codex/project state before deciding; it does not make a
same-generation request unanswerable. Terminal approval rows are retained only
for bounded later inspection.

`codex_session_metrics` incrementally indexes protected rollouts and persists
aggregates only. It reports session/turn duration, cumulative and per-turn token
samples, cache ratios, compaction, tool/MCP/web activity, repeated target
digests, file-change counts, and efficiency ratios. Validated 0.149 profiles
also expose native thread-scoped usage; validated 0.147 profiles report account
scope only and use rollout metrics for exact per-session evidence. Missing or
incomplete native telemetry is reported as unavailable rather than inferred.

## Effect lifecycle

Every write requires an exact caller-supplied `idempotencyKey`.

```text
new request -> in_flight -> succeeded | rejected | indeterminate
                                      \-> failed
```

- Reusing the key for the identical request returns the original receipt.
- Reusing it for a different request is rejected.
- Prompt and instruction text is not persisted; the ledger stores digests and
  lengths.
- A transport loss after dispatch becomes `indeterminate`.
- `codex_effect_status` performs bounded readback when exact reconciliation is
  possible. It never blindly replays an unknown effect.

Codex accepting a message or lifecycle request is not proof that a long-running
turn completed or that its source changes are valid. Read the session/turn
state and reconcile the target project's own authorities separately.

## Rollout sequence

1. Install the candidate bridge and DevSpace package with Codex gateway effects
   disabled.
2. Validate the root-owned config and Unix peer authorization.
3. Confirm `codex_gateway_status` sees every configured App Server.
4. Run list/read/activity/live-events/approval-list/metrics/account/model
   read-only canaries.
5. Verify the MCP tool catalog contains all fourteen tools and no raw native
   target fields.
6. Create a disposable workspace and Codex session for effect qualification.
7. Prove start, submit, race-to-steer, idempotent replay, interrupt, resume,
   fork, archive/unarchive, approval response/resolution, reconnect expiry, and
   indeterminate reconciliation.
8. Enable the bridge effect gate only after the disposable canary passes.

The legacy `codex_session_status`, `codex_session_tail`,
`codex_session_audit`, and `codex_workspace_*` tools remain an AOQ-specific
compatibility projection. New general collaboration should start with
`codex_gateway_status` and `codex_session_list`.
