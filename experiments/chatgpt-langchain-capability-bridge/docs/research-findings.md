# Research findings and architecture disposition

## Decision question

Can ChatGPT WebChat use the LangChain ecosystem as a coding/runtime capability
plane through MCP while ChatGPT remains the primary reasoning and coding owner?

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

Disposition: **record as an A/B harness difference; never claim 100% Deep Agent
model-loop parity for WebChat**.

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
- live persistent PTY parity: **open migration subgate**;
- direct Docker-isolated WebChat coding: **may proceed independently**.

## Finding 9 — tracing must be fail-open and payload-minimal

LangSmith is useful for measuring tool latency/failure and comparing DevSpace
with the bridge, but a tracing outage must not break a coding tool. The adapter
therefore records only tool name and argument names, excludes values and
outputs, and suppresses trace setup/flush failures while preserving the real
tool outcome.

Disposition: **USE with fail-open semantics and a strict payload ceiling**.

## Finding 10 — catalog risk remains but is reduced

ChatGPT still owns the host-side app/tool snapshot. A transport or catalog
problem can therefore hide or stale the bridge even when the backend is
healthy. The mitigation is a versioned surface with an exact canonical
descriptor fingerprint:

```text
chatgpt-langchain-capability-bridge.tools.v2
071b7d38d9205565264541ecc3eb84b5fa3681544d462eaf3511abf90e6a47b7
```

Disposition: freeze the 24-tool v2 ABI throughout direct-host and A/B
qualification. Internal native implementations may evolve behind it.

## Finding 11 — Secure MCP Tunnel is the correct direct-host transport

The official tunnel client lets the private bridge make an outbound connection
to OpenAI and receive MCP work without a public shell-capable endpoint. The
user-owned tunnel and runtime key are already stored in a root-only file on the
VPS; the repository contains no credential.

Disposition: **USE for Gate A; do not route the new runtime through
Nexus/DevSpace or a public reverse proxy**.

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
- LangSmith tracing fail-open behavior passed;
- 24-tool descriptor generation is deterministic and frozen.

### Evidence ceiling

The bridge is ready for direct ChatGPT-host qualification over Secure MCP
Tunnel. Migration is not approved. Still open:

- direct ChatGPT scan and write-capable invocation;
- connector/catalog reconnect stability;
- a live native persistent-process provider;
- representative DevSpace versus bridge A/B workload;
- long-horizon cross-chat continuity.
