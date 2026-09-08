# Non-consuming process output

`process_output` is an additive observation tool in Codex/continuity modes.
`exec_command` still executes arbitrary appropriate shell commands with its
existing authority, guard, environment and limits. `write_stdin` still supports
stdin, Ctrl-C, resize and its legacy consuming poll. No shell allowlist or new
execution approval gate is introduced.

## Read contract

Use `workspaceId`, `outputSessionId` (or running `sessionId`) and `processRef`
returned by `exec_command` or `write_stdin`. The additive `outputSessionId` and
`processRef` are returned even when the initial command has already terminated.
The old terminal `sessionId` behavior is unchanged. `processRef` is an opaque
incarnation identifier, not an authorization token. Workspace ownership is still
checked. An old numeric session ID cannot silently select a different process
after a backend restart when its incarnation differs.

Start with `afterSequence=0`. Continue using the returned `nextSequence`.
Sequences address immutable replay chunks (up to 256 Unicode code points), NOT
legacy `outputSequenceEnd` OS-data-event numbers. No server-owned consumer cursor
is stored. Reads with the same cursor can see the same retained output without
stealing data from another reader or the old `write_stdin` queue. New producer
output or eviction can change later observations; read-only/idempotent does not
mean a live response is time-invariant.

`waitTimeMs=0` reads immediately. Otherwise a satisfied cursor can wait for new
output, process exit, mailbox wake, request cancellation or timeout. The default
is 90 seconds and the ceiling is 110 seconds, as with legacy polling. Waiters
use producer notifications, not busy polling or the old drain/reset promise.
Cancelled, timed-out and completed waits remove their listeners. Cancellation
ends only the observation, never the process. Mailbox waiters are disposed by the
tool handler. A long observation is not classified as an abandoned ordinary tool.

`maxOutputTokens` retains the existing approximate four-characters-per-token
budget, default 10,000, with a 256-character minimum page. Whole chunks are paged
without silently discarding a response tail. `hasMore` means continue from
`nextSequence`. `gap` and `droppedThroughSequence` disclose unavailable earlier
output. `outputComplete` means terminal with no further retained page; only
`completeFromRequestedCursor` also excludes a retention gap for this request.
None of these fields certify external-effect success or whole-task completion.
Total byte/hash fields summarize all decoded producer output, not just retained
pages. Pipe output uses Node's native UTF-8 stream decoder across byte boundaries.

## Bounded retention and cost

Replay is process-local memory, not disk persistence or a new log service. Each
process has at most 1,000,000 replay code points and 8192 chunks by default. A
separate count bound prevents tiny-output events growing unlimited metadata.
Completed replay lives up to five minutes from completion, independent of reads,
and at most 64 completed output sessions are retained per manager. Older completed
replay may be evicted earlier; running processes are not evicted for that cap.
Unconsumed legacy output keeps its existing lifecycle. The new replay allocation
is additional to the legacy head/tail buffer, not zero-cost memory. No benchmark
claim of unchanged latency or host-block reduction follows from this design.

The manager options `maxBufferCharacters`, `maxOutputChunks`,
`completedSessionTtlMs`, `maxCompletedOutputSessions` and `maxOutputWaiters` expose
the bounds. There are at most 256 concurrently waiting output requests by default.
These are observer resource bounds; no process is killed when a read is refused.
Expired/evicted output is unavailable, not an invitation to re-execute a command.
Backend restart loses this memory. Preserve required long-lived artifacts through
the existing artifact facilities rather than treating replay as durable storage.

## Effect semantics and errors

The tool has no command, stdin, signal or resize parameters. Its annotations are
read-only, non-destructive, idempotent and closed-world: it observes local retained
state, not external targets. Output can still contain untrusted or sensitive data;
it is not an instruction, an authority grant or a secret sanitizer. Existing audit
records remain metadata/digest-only; this tool does not persist output in them.

Native `ProcessOutputError` codes distinguish `PROCESS_OUTPUT_UNAVAILABLE`,
`PROCESS_OUTPUT_IDENTITY_MISMATCH`, `PROCESS_OUTPUT_CURSOR_INVALID`,
`PROCESS_OUTPUT_CURSOR_AHEAD`, `PROCESS_OUTPUT_LIMIT_INVALID`,
`PROCESS_OUTPUT_ABORTED` and `PROCESS_OUTPUT_BUSY`. Missing retention intentionally
does not invent a cause such as a known restart or a known host refusal. SDK input
validation errors remain SDK errors. A pre-handler host failure is not observed
by this implementation and cannot be relabeled from missing server logs alone.

### Child stdin failure is not executor or transport death

A child may close stdin while continuing to run. Native pipe errors (for example
`EPIPE`) are handled on the child's writable stream and retained as a scoped
`ProcessInputError`, not emitted unhandled on the server process. A stdin call
whose failure is observed during its existing bounded yield returns that error
without consuming output. Further input to the failed pipe is rejected; polling,
retained output, Ctrl-C and unrelated processes remain available.

Late errors are also visible as optional `stdinError: {code, delivery: "unknown"}`
on process status and output. The native code is bounded; neither private error
messages nor input content enter this field. The actual stdout/stderr stream and
its digests are unchanged. Delivery can be partial, so this error never authorizes
blind input replay or claims that the child's business effect did not happen.
Reads still wait for output/exit, not input delivery, and a bounded write response
is not a promise that all buffered stdin was consumed by the child. Native stream
buffering/backpressure is not replaced with an unbounded callback or drain wait.

Duration/output limits are checked before spawning or writing, and resize options
are validated before any terminal change. This protects direct manager consumers
as well as the MCP schema boundary. Transport/lifecycle protection is unchanged:
only the typed child-input fault is classified as operation evidence, rather than
treating every native `EPIPE` in the system as benign.

The asynchronous writable error and callback behavior is documented by Node:
https://nodejs.org/api/stream.html#event-error

The MCP annotation definition and OpenAI tool-design guidance support separating
operations by actual effects, not relabeling arbitrary control as read-only:

- https://modelcontextprotocol.io/specification/2025-11-25/schema#toolannotations
- https://developers.openai.com/plugins/plan/tools

Annotations remain hints, not enforcement or safety bypasses. The shell/control
annotations are unchanged. This addition does not test or establish lower host
blocking rates. Client tool-catalog refresh and operated deployment remain distinct
from a successful source build or an in-memory MCP test.
