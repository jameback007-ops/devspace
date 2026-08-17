# Local-Agent Session Continuation

DevSpace can keep a provider conversation alive across several durable turns and
accept new work from either the CLI or another execution scope. This layer is
for DevSpace-managed provider sessions; it is separate from WebChat execution
scopes and from canonical ZES task, decision, writer, effect, or memory state.

## Supported continuation adapters

This version qualifies provider-session continuation for:

- Codex through the Codex SDK thread ID;
- Claude through the Agent SDK resume session ID;
- OpenCode through its session API;
- Pi through its RPC session ID.

Cursor and Copilot remain available for an initial ACP-backed invocation, but
DevSpace does not claim durable continuation for an existing ACP session in this
version. A follow-up to one of those existing sessions fails explicitly instead
of silently starting an unrelated provider conversation.

## Durable turn queue

Every new prompt becomes a row in `local_agent_turns`. The queue records:

- source (`cli` or `execution_scope`);
- sender scope reference when applicable;
- idempotency key and payload digest;
- message kind, priority, body, and correlation reference;
- effective model and thinking configuration snapshotted at enqueue time;
- per-agent sequence and lifecycle timestamps;
- provider session ID before and after execution;
- final response or normalized error evidence;
- cancellation, resolution, and supersession metadata.

Priority controls claim order (`urgent`, `high`, `normal`, `low`). Sequence
preserves stable order within one priority. Queue sequence is not completion
order: an urgent correction may execute before an older normal turn.

Model and thinking values are snapshotted onto each turn. A later CLI override
updates the session default for later turns but does not rewrite work already in
the queue. Idempotency compares explicit caller overrides, so a retry that used
the session default still returns its original turn even if that default changed
after admission.

One sender may retry a request with the same idempotency key and exact payload.
Execution-scope keys are namespaced by sender scope; CLI keys use a separate
local namespace. The existing turn is returned. Reusing a key in the same
namespace with a different payload is rejected.

`supersedePending=true` cancels older queued turns before admitting the new
turn. It never replaces a claimed, running, cancel-requested, or indeterminate
turn.

## Worker lease and serialization

`local_agent_worker_leases` permits one active provider worker per local-agent
session. The sender atomically reserves that lease before spawning a detached
worker, so concurrent enqueue requests coalesce instead of creating a process
storm. The child activates the same opaque worker ID, renews its lease while the
provider call is active, and processes turns one at a time.

`workerLeaseActive` in status means only that the SQLite lease has not expired;
it is not independent proof that the operating-system process is alive. A
queued/active turn with no live lease can be reconciled through session resume.

The worker loads the latest provider session ID immediately before each turn.
On success, the returned provider session ID is committed before the next turn
is claimed. This gives the next prompt the exact provider continuation produced
by its predecessor.

Provider failure terminates the current worker loop and pauses the agent session
in `error`. Later turns remain durable but are not claimed until the Owner or a
supervisor calls `local_agent_session_resume` or `devspace agents resume` after
inspecting the failure. This prevents both silent cascades and queued work being
left ambiguously runnable.

The final idle check and lease release are one SQLite transaction. If a turn is
enqueued while a worker is deciding whether to exit, the worker sees
`work_available` and continues; if the lease is released first, the enqueue
atomically reserves and launches a replacement worker.

## Crash recovery and indeterminate effects

DevSpace distinguishes a worker crash before provider execution from one after
provider execution began:

- stale `claimed` turn: safely returned to `queued` because no provider call was
  admitted;
- stale `running` or `cancel_requested` turn: changed to `indeterminate` because
  the provider may have produced output, modified files, or caused another
  effect before the worker disappeared.

An indeterminate turn blocks later turns for that agent until explicitly
reconciled:

- `retry`: requeue after evidence indicates replay is acceptable; this may
  duplicate an unknown provider effect;
- `cancelled`: record evidence that the prior turn should be treated as
  cancelled;
- `succeeded`: record evidence that it completed, optionally with the recovered
  provider session ID and final response.

DevSpace never automatically retries a provider call whose effect boundary is
unknown.

When a provider returned a candidate result but the worker could not admit it
authoritatively, the indeterminate turn retains bounded evidence: candidate
provider session ID, response body when within the configured response limit,
and response length/digest. None of that candidate state is promoted to the
agent session until an evidence-backed `succeeded` reconciliation. `retry`
clears candidate result evidence before replay.

## Cancellation

Cancelling a queued or merely claimed turn is immediate. Cancelling a running
turn records `cancel_requested` and invokes the best available provider-native
mechanism:

- Codex `AbortSignal`;
- Claude SDK `AbortController`;
- OpenCode session abort;
- ACP `session/cancel` for applicable adapters;
- Pi process interrupt.

Cancellation is best effort. The turn remains `cancel_requested` until the
provider terminates. If the provider completes successfully despite the
request, the durable result is `succeeded`, not a fabricated cancellation.

## MCP tools

When `DEVSPACE_SUBAGENTS=1`, DevSpace exposes:

- `local_agent_session_list` — sessions and queue summaries;
- `local_agent_session_status` — one session, continuation capability, lease,
  and recent turns;
- `local_agent_session_resume` — clear an ordinary failed-session pause and
  request one worker for remaining queued turns;
- `local_agent_message_send` — enqueue an idempotent provider turn;
- `local_agent_turn_status` — inspect one durable turn;
- `local_agent_turn_cancel` — cancel queued work or request running
  cancellation;
- `local_agent_turn_resolve` — explicitly reconcile an indeterminate turn.

`local_agent_message_send` requires a stable execution scope so the sender is
recorded. Acceptance means queued, not started or completed. The tool may
request a detached worker; the worker lease remains the actual serialization
boundary.

The local-agent tools share the same single-Owner MCP security boundary as the
rest of DevSpace. Turn status and reconciliation are not hidden from another
authenticated execution scope; execution scopes are cooperation lanes for one
Owner, not separate tenants.

## CLI

The CLI uses the same queue and worker state machine:

```text
devspace agents ls
devspace agents run <profile-or-provider-or-id> "<prompt>"
devspace agents show <agent-id>
devspace agents turn <turn-id>
devspace agents cancel <turn-id> [note]
devspace agents resume <agent-id> [note]
devspace agents resolve <turn-id> <retry|cancelled|succeeded> <note>
```

`agents run <existing-agent-id>` no longer launches an uncoordinated provider
worker for every prompt. It enqueues the prompt, prints the durable turn ID, and
requests a worker that must acquire the same lease used by MCP-originated work.

For a retry after an uncertain terminal disconnect, preserve one exact key:

```text
devspace agents run <agent-id> --idempotency-key <stable-key> "<same prompt>"
```

Use `--supersede-pending` only when older queued turns should be cancelled. It
never replaces running or indeterminate work.

## Storage and privacy

Queue delivery intentionally stores prompt body and provider final response in
the owner-only DevSpace SQLite database. Do not place credentials, bearer
tokens, signed URLs, or private model reasoning in these messages.

Execution-scope observability does not duplicate those bodies. It records only
safe locators, lengths, and digests for local-agent tool calls. Provider error
messages are represented in the queue by a normalized category, generic
summary, and digest rather than arbitrary raw exception text.

Terminal turns are retained for a bounded period, then pruned. Active,
cancel-requested, and indeterminate turns are never removed by terminal
retention cleanup.

## Authority boundary

A local-agent session is provider-native executor machinery. Its queue and
response do not establish:

- canonical work completion;
- writer or effect ownership;
- accepted decisions;
- release readiness;
- canonical memory;
- permission to take over a shared checkout.

Callers must still inspect Git, canonical product state, workflow/effect
readback, and the applicable writer or lease contract before relying on a
provider response.
