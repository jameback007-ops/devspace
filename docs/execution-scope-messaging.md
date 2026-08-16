# Execution-Scope Messaging

DevSpace provides a durable provider-neutral mailbox for coordination between
independent host conversations and executor scopes. A supervisor WebChat can
leave a correction, question, instruction, notice, or handoff for a worker
scope without merging their model contexts or requiring both scopes to write
the same checkout.

The mailbox is not direct ChatGPT transcript injection. DevSpace does not own
the WebChat model runtime and cannot create a new user message or start a model
turn in an inactive conversation. A WebChat target receives mail at its next
MCP boundary. If it is already waiting in a pure `write_stdin` poll, a new
message wakes that poll immediately so the normal tool result can surface the
pending-mail notice.

## Addressing

Messages use the opaque 16-character `scopeRef` returned by
`execution_scope_list`. The sender identity always comes from authenticated MCP
request metadata; callers cannot spoof a sender scope in tool arguments.

The target must already be a known retained execution scope. This prevents
messages from being sent to invented identifiers. Retained mailbox rows keep
their sender and target addresses discoverable until mailbox cleanup removes
the last associated message.

## Tools

### `execution_scope_message_send`

Stores one message for another scope. Required fields are:

- `targetScopeRef`;
- `idempotencyKey` chosen by the sender;
- `kind` (`instruction`, `correction`, `question`, `notice`, or `handoff`);
- `body`.

Optional fields include priority, correlation reference, and expiry. The same
idempotency key may be retried only with the exact same normalized payload. A
different payload under the same key fails closed.

The send result distinguishes a new acceptance from an idempotent replay.
Acceptance proves only that the owner-local SQLite transaction committed. It
does not prove that the target saw, understood, acknowledged, or acted on the
message.

### `execution_scope_message_inbox`

Reads messages addressed to the current scope. It cannot inspect another
scope's inbox. Returned messages are atomically marked `observed` and receive an
append-only observed receipt. Messages are ordered by priority and then age,
with opaque cursor pagination.

By default the inbox returns unexpired messages that have not reached `acted`.
`includeTerminal=true` may be used for local review of acted or expired rows
while they remain inside retention.

### `execution_scope_message_status`

Returns the current lifecycle projection for one message. Only its sender or
target may inspect it. This lets a supervisor distinguish storage acceptance
from actual target progress.

### `execution_scope_message_receipt`

The target records either `acknowledged` or `acted`. Receipt transitions are
monotonic and idempotent:

```text
accepted → observed → acknowledged → acted
                    ↘ expired
```

Recording `acted` also fills missing observed and acknowledged timestamps and
receipts. Later retries cannot move an acted message backward. Optional notes
are bounded and first-writer-preserving for each stage.

## Pending Notices and Poll Wakeups

Normal DevSpace tool results for the target append only a compact notice:

```text
[execution-mailbox] 2 pending message(s), 1 unobserved; highest priority urgent.
```

The notice does not expose message bodies. The target explicitly calls its
inbox to read them. Notices continue until messages are acted or expire.

For a running process, a pure `write_stdin` poll races four conditions:

```text
new process output
process exit
new target-scope mail
bounded poll timeout
```

Mail wakeup does not consume the message and does not interrupt or terminate
the process. The result reports `wakeReason=mailbox`, remains associated with
the original process session, and carries the normal pending-mail notice.
Calls that write characters, resize a PTY, or send Ctrl-C retain their existing
interaction semantics and do not use mailbox wakeup.

Only unobserved mail triggers the immediate poll wake. Once the target reads its
inbox, repeated process polls do not spin on the same acknowledged or unacted
message; compact pending notices remain visible until it is acted or expires.

## Persistence, Idempotency, and Retention

Messages and append-only receipts live in the existing owner-only DevSpace
SQLite database. The message row also stores the efficient current lifecycle
projection. The default policy is:

- seven-day message TTL;
- maximum 30-day caller-selected TTL;
- seven-day retention after expiry or acted completion;
- at most 500 live pending messages per target scope;
- at most 12,000 characters in one body.

All values are configurable. Cleanup is bounded and runs during normal mailbox
activity as well as server startup. An idempotent retry does not create another
row, consume another pending slot, or wake the target again.

## Content and Security Boundary

Unlike execution-scope observability, the mailbox intentionally stores message
body text because delivery is its purpose. Do not place credentials, bearer
tokens, private model reasoning, signed URLs, or unrestricted tool output in a
message. The sender should send the minimum context and durable references
needed for the target to recover authoritative state itself.

Observability does not duplicate mailbox bodies. Audit events for mailbox tools
retain only bounded lengths and digests for sensitive fields. Inbox access and
receipt mutation are target-bound; status is limited to the sender and target;
all tools remain behind the existing single-Owner OAuth boundary.

## Authority Boundary

Mailbox state is executor-local coordination evidence. It is not:

- canonical task or material-work state;
- writer ownership or a lease transfer;
- an accepted decision;
- proof that an external effect occurred;
- a release or checkpoint;
- standing memory or knowledge authority.

A message may ask a target to stop, inspect, hand off, or take over, but the
target must still reconcile Git, canonical product state, workflow/effect
readback, and the real writer or lease contract before relying on that request.

## Downstream Executor Adapters

The same envelope can later support stronger delivery adapters without changing
mailbox semantics:

- DevSpace-managed Codex, Claude, OpenCode, or Pi sessions can dequeue a message
  into a serialized provider-session continuation;
- Codex App Server can map it to its native thread relay;
- Hermes or a ZES-owned executor can receive direct queue wakeups;
- WebChat remains next-MCP-boundary delivery unless the host provides a future
  supported push API.

Adapter-specific delivery must never weaken idempotency, target binding, receipt
semantics, or the distinction between stored mail and authoritative product
state.
