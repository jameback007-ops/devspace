# Research findings and architecture disposition

## Architecture question

LangGraph, Deep Agents, Agent Server, and LangSmith are the owner-committed
long-term ZES direction. The question is therefore not whether they defeat
DevSpace. It is which mature native capabilities can be used directly, which
WebChat boundaries require a thin binding, and which incumbent custom machinery
should be rejected, deferred, or retired.

## Finding 1 — the direct capability seam is real

Deep Agents backends expose filesystem, search, mutation, execution, and file
transfer independently of `create_deep_agent`. The Phase-0 bridge exercised
those methods through MCP and completed a real failing-test repair without
invoking another model.

Disposition: **USE**.

## Finding 2 — 14 primitive tools proved coding, not full harness parity

The original 14-tool ABI proved that ChatGPT can code through native backend
methods. It did not expose skills, project memory, artifact transfer, sandbox
lifecycle, resumable processes, Agent Server services, specialists, or tracing.

Disposition: retain v1 as evidence, supersede it for direct-host qualification
with the stable 24-tool v2 ABI.

## Finding 3 — skills and `AGENTS.md` can be projected natively

`SkillsMiddleware` can load skill metadata and `MemoryMiddleware` can load
ordered project memory without invoking a Deep Agent model. The v2 bridge uses
those native loaders, then exposes metadata-first progressive disclosure to
WebChat through `context_discover` and `context_read`.

This preserves the important native lifecycle while acknowledging that MCP
cannot inject middleware directly into ChatGPT's hidden prompt construction.

Disposition: **USE native loaders; keep the WebChat projection explicit**.

## Finding 4 — Agent Server is a service plane, not the default coder

Agent Server's native APIs are valuable for threads, runs, checkpoint history,
Store, streaming, cancellation, queueing, and optional assistants. Exposing a
whole model-backed graph as the default coding tool would transfer the coding
loop away from ChatGPT, which violates the experiment's primary condition.

The clean seam is:

```text
Agent Server
  ├─ native thread/run/store APIs
  └─ custom /coding/mcp route
       └─ primitive and grouped capability tools
```

The bridge restricts ordinary runtime runs to allowlisted assistant IDs,
prefixes Store namespaces, and exposes specialists only by configured alias.

Disposition: **USE as runtime/service plane; do not make graph-as-coder the
default route**.

## Finding 5 — native planning and HITL remain usable without owning WebChat

Two capabilities initially looked model-loop-bound but have clean service-plane
seams:

- `TodoListMiddleware` defines the canonical `WriteTodosInput` schema. The
  bridge validates that native schema and writes the resulting `todos` directly
  into Agent Server thread state. It does not create a separate planner or task
  database.
- LangGraph `interrupt()` and Agent Server's native `Command(resume=...)`
  payload can be observed and resumed through `runtime_run`. The bridge does
  not replay the interrupted action or synthesize its own approval state.

A deterministic no-model `bridge_hitl` graph now proves interrupt → persisted
thread state → resume → terminal result through the same custom MCP route.

Disposition: **USE native planning state and native interrupt/resume; keep
primitive WebChat confirmation at the ChatGPT host/app permission boundary**.

## Finding 6 — model-loop capabilities have a hard boundary

Deep Agents automatic summarization, context offloading, prompt middleware, and
hidden system prompt are applied inside a Deep Agent model loop. MCP cannot
wrap ChatGPT WebChat's private model loop or rewrite its hidden system prompt.

Equivalent content can be made available through skills, MCP server
instructions, `AGENTS.md`, explicit durable state, and artifacts, but the
execution semantics are not identical.

Disposition: **record as a WebChat boundary; do not turn it into a parity gate
or clone a second model-loop harness**.

## Finding 7 — sandbox capability should be provider-neutral

Deep Agents defines a common sandbox/backend capability, while concrete remote
providers differ in lifecycle and process features. The MCP surface should not
encode one vendor. Version 2 therefore uses a small `NativeSandboxProvider`
port and attaches the provider's native Deep Agents backend to the workspace
registry.

The included LangSmith adapter reuses `SandboxClient`, `LangSmithSandbox`, and
the native command handle. Other native providers can be added behind the same
port without changing the MCP ABI.

Disposition: **freeze the provider-neutral MCP ABI; replace providers behind
it**.

## Finding 8 — persistent PTY is provider-specific, not a base guarantee

The richer LangSmith command handle supports command identity, PTY, stdin,
process-group kill, output offsets, reconnect, and SDK auto-reconnect. The v2
`process` tool projects those semantics with only a bounded output buffer and
sequence cursor.

However, the currently bound LangSmith organization returned
`SandboxAuthenticationError: Sandbox feature is not enabled for this
organization`. The VPS has no credentials or installed clients for another
supported remote sandbox provider.

Disposition:

- provider-neutral and LangSmith adapters: **implemented and behavior-tested**;
- live LangSmith Sandbox: **blocked by external entitlement**;
- live persistent PTY qualification: **open production capability subgate**;
- direct Docker-isolated WebChat coding: **may proceed independently**.

## Finding 9 — tracing must be fail-open and payload-minimal

LangSmith is useful for measuring tool latency/failure and characterizing the
incumbent against the native route, but a tracing outage must not break a coding tool. The adapter
therefore records only tool name and argument names, excludes values and
outputs, and suppresses trace setup/flush failures while preserving the real
tool outcome.

Disposition: **USE with fail-open semantics and a strict payload ceiling**.

## Finding 10 — native Threads and Studio replace a custom observability stack

Agent Server already owns runtime thread status, timestamps, state, runs, and
history. LangSmith already groups traces into Threads through `thread_id`
metadata and exposes those Threads, Traces, and Runs through its native UI and
Studio. Recreating DevSpace's execution-scope database or dashboard would
duplicate these mature authorities.

The only irreducible WebChat gap is identity binding: ChatGPT does not expose a
durable public conversation ID to the MCP server. The bridge now treats
`workspace_open.thread_id` as an explicit workstream ref, resolves exactly one
Agent Server thread with `threads.search`, creates one when absent, and uses the
same ref as LangSmith trace `thread_id`. When no ref is supplied, it mints a
UUIDv7 and returns it.

Live evidence shows one Agent Server thread with native `idle` status and one
LangSmith Thread containing `mcp.workspace_open`, `mcp.ls`, and
`mcp.checkpoint_read`. No custom activity database, trace store, dashboard, or
run state machine was created.

Disposition: **USE Agent Server Threads + LangSmith Threads/Studio; keep only
the thin workstream binding seam**.

The transport was subsequently switched in place from the standalone bridge to
the Agent Server custom MCP route. Because the 24-tool descriptor ABI was
identical, ChatGPT required no app rescan and continued through the existing
`ZES_LangChain_Runtime` namespace. Direct calls produced one native Agent
Server thread, one LangSmith Thread with five MCP traces, and an Agent Server
Store checkpoint. This demonstrates that runtime substitution can remain an
implementation detail behind the frozen MCP contract.

A tunnel-client-only restart then preserved the explicit workstream ref,
native Agent Server thread, Agent Server Store checkpoint, and LangSmith
Thread. The first direct call after tunnel readiness failed before a native
trace was created, then the same app recovered without rescan and subsequent
calls used the existing identities. This isolates a brief host/control-plane
convergence window and prevents an overclaim of zero-gap availability.

OpenTelemetry remains a native optional infra layer rather than an immediate
bridge dependency. Agent Server already initializes native OTel metrics in the
qualified runtime, while LangSmith covers the current application/tool
trajectory. Add MCP-level OTel only after an infrastructure visibility gap is
measured; do not add parallel telemetry by default.

## Finding 11 — catalog risk remains but is reduced

ChatGPT still owns the host-side app/tool snapshot. A transport or catalog
problem can therefore hide or stale the bridge even when the backend is
healthy. The mitigation is a versioned surface with an exact canonical
descriptor fingerprint:

```text
chatgpt-langchain-capability-bridge.tools.v2
071b7d38d9205565264541ecc3eb84b5fa3681544d462eaf3511abf90e6a47b7
```

Disposition: freeze the 24-tool v2 ABI throughout direct-host qualification and
incumbent characterization. Internal native implementations may evolve behind
it.

## Finding 12 — Secure MCP Tunnel is the correct direct-host transport

The official tunnel client lets the private bridge make an outbound connection
to OpenAI and receive MCP work without a public shell-capable endpoint. The
user-owned tunnel and runtime key are already stored in a root-only file on the
VPS; the repository contains no credential.

Disposition: **USE for Gate A; do not route the new runtime through
Nexus/DevSpace or a public reverse proxy**.

## Finding 13 — C0 is an incumbent extraction instrument, not a platform vote

The deterministic multi-file billing replay started both lanes from the same
clean commit. Both reproduced two failures, passed all four tests after repair,
changed exactly the same two source files, passed `git diff --check`, and
produced the same patch digest.

The harness observations were:

- DevSpace exposed 12 visible calls, one atomic multi-file `apply_patch`, and a
  bounded audit with 333 ms of observed tool service time;
- the native route exposed 13 visible calls and completed the same repair using
  native context, five reads, two exact edits, and three executions;
- LangSmith recorded one native Thread with 29 root tool traces, zero errors,
  and 16 additional server-observed invocations beyond visible calls. The exact
  cause of those additional reads/open/status calls is not yet proven;
- the same session ran DevSpace first, so wall time, reasoning quality, token
  economy, and behavioral superiority are not valid comparisons.

Subtractive dispositions follow:

- filesystem, context, state, and observability: **USE NATIVE; RETIRE OR DO NOT
  PORT duplicate DevSpace implementations**;
- explicit WebChat workstream identity: **KEEP the existing thin binding**;
- atomic multi-file mutation: **DEFER_WITH_FALSIFIER**; one ergonomic sample
  does not justify expanding the frozen core;
- extra native host/server invocations: **MEASURE through LangSmith first**;
  do not create a new activity database;
- DevSpace execution-scope, recovery, and ceremony systems: **REJECT PORT FROM
  C0** because the workload did not falsify the mature native state plane.

The benchmark runner initially generated `__pycache__` files while scoring.
That observer effect was removed with `PYTHONDONTWRITEBYTECODE=1`, and the final
score leaves only the two expected tracked source changes.

Disposition: **use C0 to delete and replace first; require a durable measured
native gap before the smallest custom binding is considered**. See
`evidence/gate-c0-harness-characterization-20260822.json`.

## Qualification evidence to date

### Phase 0

- streamable-HTTP MCP initialize/list/call passed;
- a disposable bug was repaired through native primitives;
- tests changed from failing to `2 passed`;
- Git diff/check/commit and worktree lifecycle passed;
- dependency installation and bounded timeout passed;
- LangGraph checkpoint survived bridge restart;
- Agent Server custom route coexisted with native thread/run/Store;
- standalone and Agent Server images built on Python 3.13.

### Full native capability v2

- native skills metadata and full skill read passed;
- ordered root/nested `AGENTS.md` discovery and read passed;
- native binary upload/download with checksum passed;
- provider-neutral sandbox attachment/lifecycle contract passed;
- native command-handle start/poll/stdin/cancel/reconnect adapter passed with a
  contract-faithful fake;
- Agent Server thread/run/events/Store and explicit specialist adapters passed;
- native `WriteTodosInput` state passed in unit tests and on the live v2 route;
- native LangGraph interrupt and Agent Server `Command(resume)` passed on the
  live deterministic `bridge_hitl` graph;
- one WebChat workstream ref resolved to exactly one native Agent Server thread;
- the same workstream grouped three MCP traces into one LangSmith Thread;
- LangSmith tracing fail-open behavior passed;
- 24-tool descriptor generation is deterministic and frozen.

### Direct WebChat Gate A

- the initial generic `ZES` app namespace exposed one host-resource continuity
  incident after a non-terminal mutation attempt;
- renaming/reconnecting the app as `ZES_LangChain_Runtime` restored a unique
  namespace without recreating the tunnel or credentials;
- ChatGPT then performed the complete repair itself: native context read,
  failing tests, exact edit, source readback, `2 passed`, `git diff --check`,
  checkpoint record, and checkpoint read;
- no Nexus, Legacy, specialist, or second model performed the repair.

### C0 incumbent characterization

- identical DevSpace and native clones started at the same clean Git commit;
- both reproduced two failures and passed all four tests after repair;
- both changed exactly `discounts.py` and `invoice.py`;
- both produced patch digest
  `749a135c48de4db325545c6d02fdf421371d3bc225ac05ee2724a1f0ae58f8d9`;
- DevSpace audit and LangSmith Threads supplied the metrics without a new
  telemetry store;
- the evidence has no platform-selection or model-behavior authority.

### Evidence ceiling

Direct ChatGPT-host qualification and one deterministic incumbent
characterization now pass. The LangGraph ecosystem direction is already
committed; still open are production-readiness and optional broader
characterization questions:

- a live native persistent-process provider;
- repeated multi-workload characterization and optional fresh-chat C1 samples;
- long-horizon cross-chat/catalog continuity;
- production Agent Server activation with native Postgres/Redis and the
  required license authority.

The first direct-host run is recorded in
`evidence/direct-webchat-host-boundary-20260822.json`. It records both the
initial host namespace incident and the successful unique-namespace recovery.
The adapter promotes native backend `result.error` values to MCP tool errors so
a typed backend failure cannot be mistaken for a completed mutation; this
hardening does not change the 24-tool ABI.

Native workstream observability is recorded in
`evidence/native-workstream-observability-20260822.json`. The qualified Agent
Server is the native development runtime. The production image builds, but no
`LANGGRAPH_CLOUD_LICENSE_KEY` is bound, so the bridge does not claim or emulate
a standalone production deployment.

C0 characterization and subtractive dispositions are recorded in
`evidence/gate-c0-harness-characterization-20260822.json`. They do not authorize
a broad DevSpace port or expansion of the 24-tool core.
