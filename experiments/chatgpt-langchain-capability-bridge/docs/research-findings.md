# Research findings and architecture disposition

## Decision question

Can WebChat use LangChain ecosystem capabilities as its coding harness through
MCP without delegating coding to another model and without rebuilding DevSpace?

## Finding 1 — direct capability composition is viable

Deep Agents exposes a public backend protocol with native filesystem, search,
mutation, file transfer, and shell execution methods. Those methods are usable
without constructing or invoking `create_deep_agent`. An MCP adapter can expose
them as primitives while ChatGPT remains the tool-loop owner.

Disposition: **KEEP / PROTOTYPE**.

## Finding 2 — Agent Server's default MCP direction is not the required seam

Agent Server naturally exposes deployed graphs or agents to callers. Calling
that graph from ChatGPT would make ChatGPT delegate a task to the graph's model
loop. That is useful later for specialist agents, but it does not prove the
owner requirement for this experiment.

Disposition: **DEFER as the WebChat coding seam**; retain Agent Server for
durable internal agents, background runs, and production deployment later.

Agent Server supports arbitrary Starlette/FastAPI custom routes in the same
deployment. The prototype therefore mounts the primitive MCP server at
`/coding/mcp` while preserving the native Agent Server API surface. Its
checkpoint tools use Agent Server's native Store from the custom-route request
context; the standalone bridge retains SQLite only as a local fallback. This is
the clean insertion seam: Agent Server hosts, persists, and can secure the
capability plane, but does not become a second coding model loop.

## Finding 3 — LangGraph can still provide native durable state

A deterministic `StateGraph` compiled with `SqliteSaver` persists checkpoint
history without an LLM. The bridge uses this only for explicit tool-plane
frontiers. It does not claim to checkpoint ChatGPT's hidden reasoning state.

Disposition: **USE**, with a strict claim boundary.

## Finding 4 — LocalShellBackend requires an outer sandbox

`LocalShellBackend` intentionally executes arbitrary host shell commands. Its
`root_dir` controls the working directory and file-tool routing, not shell
isolation. Running it directly on the ZES VPS would reproduce DevSpace's broad
host authority and expose credentials or unrelated workspaces.

The lowest-custom native-first option for the experiment is therefore:

```text
Docker/container boundary
  └─ MCP bridge
       └─ Deep Agents LocalShellBackend
            └─ isolated mounted repository
```

When credentials and deployment policy are ready, a supported Deep Agents
remote sandbox provider can replace Docker without changing the MCP surface.

Disposition: **USE only inside an isolation boundary**.

## Finding 5 — tool parity is different from harness parity

The bridge can expose enough primitive authority for ChatGPT to code directly.
It cannot inject Deep Agents middleware, summarization, subagent scheduling, or
context offloading into ChatGPT's private inference loop. Those features remain
available to internal Deep Agents, not automatically to WebChat.

The migration decision must therefore measure two independent dimensions:

1. **coding capability parity** — can ChatGPT inspect, modify, execute, test,
   build, use Git, and recover state?
2. **model-loop harness parity** — does WebChat itself gain enough continuity,
   context management, and operational reliability to outperform DevSpace?

Disposition: **do not overclaim from the first smoke test**.

## Finding 6 — MCP catalog instability remains possible but cheaper

ChatGPT still owns the outer MCP catalog. A host-side binding or snapshot issue
can therefore hide the bridge. The architectural improvement is that the
surface is small, versioned, stable, and backed by replaceable native
components. Deep Agents and LangGraph can evolve behind the same schemas.

Disposition: freeze the top-level tool ABI during the experiment; change
implementation behind it rather than adding tools repeatedly. The prototype
now enforces an exact canonical descriptor fingerprint in tests and exposes it
through `capability_manifest` so a ChatGPT draft app can be checked against the
intended surface before a coding run.

## Prototype conclusion

The seam exists. It requires a thin MCP adapter, not a custom coding harness.
The current implementation is sufficient to proceed to a real WebChat coding
test in an isolated repository. Migration is not yet approved; the remaining
gates are empirical.

## Executed prototype evidence

- Seven local behavioral tests pass, including a real streamable-HTTP MCP
  initialize/list/call cycle and both SQLite and Agent Server Store journals.
- The standalone bridge runs in a read-only Docker container with all Linux
  capabilities dropped and only the disposable repository plus state volume
  mounted.
- The MCP repair qualification observed failing tests, edited the source through
  the Deep Agents backend, produced `2 passed`, validated `git diff --check`, and
  persisted its checkpoint across a container restart.
- The current ChatGPT session also performed a model-owner rehearsal one
  primitive at a time through the MCP client relay: it selected inspection
  calls, interpreted both failures, read the implementation and tests, chose
  the correction, invoked `edit_file`, validated `2 passed` plus the Git diff,
  and recorded checkpoint `model-owner-rehearsal-20260822`. No second model or
  agent participated. This proves the reasoning/tool sequence but not direct
  ChatGPT host discovery, because Legacy still relayed each MCP request.
- The shell plane created and committed inside a disposable Git worktree,
  installed a pinned dependency from the network, exercised Node and Git, and
  returned an explicit timeout receipt for a bounded long-running command.
- Agent Server loaded the same MCP application as `/coding/mcp`, kept `/ok`,
  assistants, threads, runs, checkpoints, queue workers, metrics, and Store
  available, and completed a native thread/run/checkpoint probe.

The remaining highest-value falsifiers are actual ChatGPT connector discovery,
OAuth-protected remote ingress, persistent command streaming/resume, and an A/B
coding task against DevSpace on identical repository clones.

## Finding 7 — an official private WebChat insertion path now exists

OpenAI Secure MCP Tunnel is a better qualification route than publishing a
shell-capable endpoint. Its customer-run `tunnel-client` opens outbound HTTPS,
polls the OpenAI tunnel control plane, forwards requests to the private MCP
server, and exposes local health/readiness/operator surfaces. The official
client is available as a public binary and container image.

The prototype includes a pinned `ghcr.io/openai/tunnel-client:v0.0.12` sidecar
that reaches the bridge only over the private Compose network. Starting it is
intentionally blocked until a real tunnel ID and runtime API key are supplied.

Disposition: **USE for the decisive WebChat test**. Do not substitute ngrok or
expose an unauthenticated write-capable endpoint.

## Finding 8 — production Agent Server has an independent commercial gate

The custom route and native threads/runs/store work in local Agent Server dev
mode, and a production image builds successfully. Running the Postgres/Redis
Agent Server image locally then requires either a LangSmith API key with the
required LangGraph access or a LangGraph Cloud license key. This is not a
technical failure of the bridge, but it means the migration decision must
separate:

- open-source LangGraph + Deep Agents capability quality;
- Agent Server development capability;
- licensed or managed production deployment economics.

Disposition: **do not make Agent Server licensing a prerequisite for the first
WebChat coding test**. Use the standalone private bridge plus Secure MCP Tunnel,
then evaluate managed/licensed deployment after capability parity is proven.
