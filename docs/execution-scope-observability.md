# Execution-Scope Observability

DevSpace can expose several independent MCP host conversations against the same
machine or project. Each host conversation remains a separate execution scope,
even when two scopes open the same checkout. `execution_scope_list`,
`execution_scope_status`, and `execution_scope_audit` let an authenticated Owner
or supervisor inspect those scopes without merging their model context or
turning DevSpace into a transcript database.

## Identity Model

An **execution scope** is a stable, provider-neutral host conversation or task
scope supplied through MCP request metadata. DevSpace currently accepts:

- `devspace/executor-window-scope` as the generic contract;
- `openai/session` through the OpenAI adapter when the generic field is absent.

The raw host value enters at the live MCP adapter edge, but the execution-scope
observability tables never persist it. They retain the full SHA-256 digest for
collision detection, while inspection tools expose only a deterministic
16-character digest-derived `scopeRef`. Other DevSpace features, such as the
pre-existing checkout-reuse binding, retain their own separate storage
contract.
MCP transport sessions are different: ChatGPT may use stateless transports for
individual tool calls while preserving one execution scope across those calls.

An execution scope is executor-local machinery. It is not a product task ID,
writer lease, checkpoint, accepted decision, release, effect record, canonical
memory, or standing agent identity.

## Tools

### `execution_scope_list`

Returns recent scopes ordered by activity. Each summary includes the opaque
`scopeRef`, current-scope marker, adapter, activity state, last tool outcome,
workspace and live-process counts, and executor-window phase.

### `execution_scope_status`

Returns one scope's current projection:

- linked checkout and worktree workspaces;
- live or recently completed tracked DevSpace process sessions;
- executor-window state and bounded handoff;
- activity and audit counters.

Omit `scopeRef` to inspect the current scope. Supply a `scopeRef` from
`execution_scope_list` to inspect another scope.

### `execution_scope_audit`

Returns a bounded newest-first event stream with opaque pagination. Events show
tool lifecycle, outcome, timing, safe workspace/process locators, selected input
metadata, digests, and normalized error categories.

The inspection tools do not audit themselves. This preserves genuinely
read-only inspection and prevents supervisor queries from contaminating the
target audit.

## Captured Data

DevSpace persists only the operational data needed to understand and recover an
executor lane:

- scope reference, full collision-check digest, and adapter class;
- first and last activity times;
- tool name, lifecycle outcome, and duration;
- workspace IDs and safe path/mode locators;
- process IDs, state, timing, command length, and command digest;
- bounded safe input metadata such as line limits or terminal dimensions;
- file paths parsed from a Codex patch envelope, without patch content;
- normalized error category and digest;
- executor-window phase at tool completion.

Running observations that survive an unclean server stop are marked
`interrupted` on restart rather than remaining falsely active.

## Data Never Captured

Execution-scope observability does not store or return:

- user or assistant transcript text;
- prompts or private model reasoning;
- tool output or file contents;
- raw shell commands;
- patch bodies or edit replacement text;
- native file objects, signed URLs, or connector-private handles;
- credentials, bearer tokens, or environment secrets.

Sensitive string fields are represented only by bounded length and SHA-256
digest metadata. Arbitrary exception messages are never persisted; audit stores
only a normalized error category, a generic diagnostic sentence, and a digest
of the original message. The SQLite database and state directory retain
owner-only permissions through the existing DevSpace database boundary.

Long-running commands are attributed to the execution scope that started them.
A scope receives details only for its own live process sessions. Within the
workspace IDs linked to that scope, the status response reports a separate
`otherOrUnattributedRunningProcessCount` without exposing foreign process
details. Child processes receive the opaque `DEVSPACE_EXECUTION_SCOPE_REF`
environment variable so downstream tracing can correlate work without a raw
provider session identifier.

## Persistence and Retention

Execution scopes, workspace links, and audit events live in the existing
DevSpace SQLite database. They survive a registry or server restart. Live
process handles and executor-window timers remain process-local and are joined
at query time; they are observations, not reconstructed authority.

Conversation scope and assistant-turn window are deliberately separate. The
stable `scopeRef` identifies a conversation/executor lane; an optional
`devspace/executor-turn` value identifies one exact host turn. Observability may
show the current window projection, but it must not infer turn age from the age
of the conversation scope.

Defaults:

- observability enabled;
- seven-day event retention;
- 1,000 retained events per scope;
- five minutes before a non-running scope is classified idle.

All limits are configurable. Pruning removes old audit events and scopes that
have no retained events or mailbox references. `totalEventCount` remains
cumulative while the scope row exists, so a bounded audit does not imply that
only the retained events ever occurred.

## Relationship to the Mailbox

Execution-scope messaging is a separate content-bearing contract. The mailbox
intentionally stores body and receipt notes for delivery, while observability
records only bounded lengths and digests for those sensitive fields. Reading an
inbox or recording a receipt is auditable lifecycle metadata, but the message
body is not duplicated into the audit stream. See
[Execution-Scope Messaging](execution-scope-messaging.md).

## Concurrency and Authority

Two execution scopes can point at the same checkout. Inspection does not grant
either one writer ownership. A supervisor must still reconcile Git state,
canonical product work, runtime/effect outcomes, and the actual writer or lease
contract before authorizing takeover or mutation. Use isolated worktrees for
parallel writers.

The projection is deliberately fail-open for ordinary coding tools: a failure
to record observability is logged but does not block the underlying tool call.
Calling an inspection tool may still report an observability-store error because
that store is the data source being requested.

## Langfuse and OpenTelemetry

Execution scopes provide the local executor identity needed for later trace
correlation, but they are not a telemetry backend. A future adapter may attach
an execution `scopeRef`, workspace ID, process session ID, ZES lifecycle/task
reference, and W3C trace context to Langfuse or OpenTelemetry events. Langfuse
and OTel/Tempo then explain what happened across services, while Git,
PostgreSQL, workflow/effect state, and product-native continuation remain the
authorities for what is currently true.

This separation lets supervision evolve from "what is WebChat window A doing?"
to "what is happening to this work lifecycle across WebChat, Codex, Hermes, and
other executors?" without making any one provider session the root of truth.
