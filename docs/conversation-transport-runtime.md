# Direct-first conversation transport runtime

This runtime extends DevSpace execution-scope wake coordination with one
provider-neutral transport boundary:

```text
durable pending work
  -> exact scope/mission target binding
  -> bridge-attested transport observations
  -> deterministic native_rpc > local_agent > web_ui route
  -> explicit fresh host-turn wake gate
  -> transport-bound wake permit
  -> post-lease route and host-turn readback
  -> native_rpc: persist-before-dispatch delivery
  -> web_ui: durable InteractionBroker lease and checkpoint
  -> bounded bridge sensor/actuator delivery
  -> new host-turn generation or durable indeterminate state
  -> exact admission and three-plane reconciliation
  -> fallback only after no-effect proof
```

## Proven surface boundary

The installed Codex App Server is a supported bidirectional JSON-RPC control
plane for Codex threads and turns. A fixed Codex thread target can therefore
use `native_rpc` without browser automation. Exact admission is reconciled by
the deterministic `clientUserMessageId` recorded in the thread turn history.

ChatGPT `Chat` and `Work` are separate from the Codex thread history. The
installed App Server schema exposes no external method to address, attach, or
send to a Chat/Work conversation. ChatGPT authentication on the Codex App
Server does not change that protocol boundary. Until an official or registered
Chat/Work control protocol is attested, the native candidate is returned as:

```text
UPSTREAM_CHAT_WORK_NATIVE_CONTROL_PROTOCOL_UNATTESTED
```

This is a typed upstream constraint, not a signal to replay private web
endpoints. Chat/Work may use the governed `web_ui` route only when an exact,
fresh browser binding and selector contract are configured and observed.

## Authority split

The MCP surface accepts only:

- an execution-scope reference;
- a mission reference;
- a fixed target alias;
- durable work references and idempotency keys.

Raw thread IDs, conversation URLs, browser profile paths, App Server socket
paths, cookies, extension tokens, and credentials remain in the root-owned
bridge configuration. The DevSpace database stores only target aliases,
digests, route IDs, permit state, receipts, and bounded InteractionBroker
checkpoints.

Neither the upper wake attempt nor the InteractionBroker checkpoint stores the
rendered continuation prompt. The upper plane persists a deterministic prompt
template, bounded durable references, and the resulting SHA-256 digest. The
prompt is materialized and digest-checked only at the lower effect boundary.
The broker persists only that digest with the exact prepared action. The bridge
delivery ledger likewise stores a prompt digest, deterministic message ID,
route digest, permit reference, and reconciliation receipts. Rendered prompt
text exists in process memory only for the duration of one delivery call.

## Runtime components

`scripts/zes-conversation-transport-bridge.py`

- root-owned allowlisted target registry;
- local App Server RPC client through the existing relay implementation;
- App Server-mediated access to the already registered Playwright MCP server;
- Unix peer-credential authorization;
- idempotent delivery ledger and reconcile-before-retry semantics;
- no arbitrary target or socket arguments.

`ConversationTransportRuntime`

- executor-local scope/mission target bindings;
- provider-neutral route selection;
- durable provider-neutral host-turn lifecycle and evidence expiry;
- wake scheduling and attempt throttles;
- permit issuance with transport route plus an exact host-turn gate snapshot;
- native RPC delivery without browser ownership or UI serialization;
- Web UI delivery through the durable single-client InteractionBroker before
  the privileged bridge may compose or submit;
- shared transactional reconciliation across scheduler, host-turn lifecycle,
  and InteractionBroker state;
- MCP tools for bind, status, pending work, assess, execute, and reconcile.

`SqliteInteractionBrokerStore` and
`ConversationWebUiInteractionBroker`

- one monotonic lease generation for the shared Playwright actuator;
- SQLite compare-and-swap checkpoints in the existing DevSpace WAL database;
- `acting` persisted before the bridge receives the prompt;
- exact permit, host-turn gate, route, prompt digest, and browser conversation
  URL-digest approval binding;
- verified, no-effect, and indeterminate outcomes mapped back into the upper
  wake attempt;
- exact effect reconciliation performed inside the same SQLite transaction as
  scheduler and host-turn reconciliation.

The bridge's process/file lock remains a final actuator-local concurrency
guard. It is not a replacement for the durable InteractionBroker lease and
checkpoint.

The same privileged bridge also hosts the independent full-lifecycle Codex
integration gateway. That gateway is not part of wake routing and does not
wrap Codex. It reuses the existing Unix peer boundary, App Server relay, and
durable effect ledger while exposing typed multi-server/session discovery,
activity, metrics, session/turn lifecycle, and reconciliation to DevSpace. See
[`codex-native-integration.md`](./codex-native-integration.md).

The detailed state model, evidence rules, and failure semantics are documented
in [`host-turn-lifecycle.md`](./host-turn-lifecycle.md).

## Root-owned bridge configuration

Install a `0600` JSON document based on
`examples/zes-conversation-transport-bridge.example.json`. Each target must
have a fixed alias and target kind.

For a Codex native target:

```json
{
  "targetKind": "codex_thread",
  "bindingGeneration": 1,
  "native": { "threadId": "<allowlisted-codex-thread-id>" }
}
```

For Chat or Work, omit `native` unless a supported protocol is later attested.
A Web UI fallback additionally requires:

- the fixed Codex thread that owns the existing Playwright MCP connection;
- the exact normalized ChatGPT conversation URL digest;
- an expected origin;
- bounded attestation and expiry timestamps;
- a selector contract;
- `webUi.effectsEnabled=true` only after read-only observation passes.

The normalized URL is `scheme://host/path` with query and fragment removed.
Only its SHA-256 digest is returned outside the bridge.

## Rollout gates

Use two independent effect gates:

1. bridge configuration `effectsEnabled`;
2. DevSpace `DEVSPACE_CONVERSATION_TRANSPORT_EFFECTS`.

The safe rollout is:

1. deploy both services with both gates off;
2. validate bridge config and Unix peer authorization;
3. verify Codex native status is `available/exact`;
4. verify explicit host-turn state is wake-eligible and fresh;
5. verify Chat/Work reports the typed native limitation;
6. verify no Web UI route is eligible without an exact binding;
7. prove the InteractionBroker migration, cross-handle lease exclusion, CAS,
   restart recovery, and indeterminate reconciliation tests;
8. create a disposable Codex thread and perform one native canary;
9. prove one `clientUserMessageId` admission and one new turn boundary;
10. enable DevSpace effects only after the bridge canary passes;
11. enable Web UI effects separately after a reversible observation/staging
    canary proves the current selector contract and the broker lease is visible
    as the only UI serialization owner.

An attempt in `accepted`, `sending`, or `indeterminate` state blocks retry and
cross-transport fallback. A Web UI attempt additionally leaves an
InteractionBroker checkpoint in `indeterminate`; `execution_wake_reconcile`
must close the wake attempt, broker checkpoint, and host turn atomically before
another dispatch. Silence is never effect evidence.
Likewise, `started`, `running`, `disconnected`, or `indeterminate` host-turn
state blocks a wake even when no MCP tool or process is currently visible.

## Systemd hardening

Use the example unit in
`examples/systemd/zes-conversation-transport-bridge.service` and the DevSpace
drop-in in `examples/systemd/devspace-conversation-transport.conf`.

The bridge should run with:

- `UMask=0077`;
- `RestrictAddressFamilies=AF_UNIX`;
- `NoNewPrivileges=true`;
- read-only access to the App Server socket and relay module;
- write access only to its `/run` and `/var/lib` directories.

Do not pass browser-extension credentials on a process command line. The bridge
does not require the Playwright extension token: it calls the Playwright MCP
tool through the authenticated App Server connection that already owns it.

## MCP tools

- `conversation_transport_bind`
- `conversation_transport_status`
- `execution_wake_pending_record`
- `execution_wake_status`
- `execution_wake_assess`
- `execution_wake_execute`
- `execution_wake_reconcile`

`execution_wake_execute` may send one prompt and remains unavailable as an
effect while either rollout gate is off.
