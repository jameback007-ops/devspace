# ChatGPT → LangChain Native Capability and Interaction Bridge

This experiment qualifies a specific architecture:

> ChatGPT WebChat remains the reasoning and coding owner while MCP projects
> native Deep Agents, LangGraph, Agent Server, A2A, sandbox, and observability
> capabilities into the WebChat tool loop.

The bridge is not a second coding agent. The default path contains no hidden
`create_deep_agent`, `model.invoke`, or delegated coding call.

```text
                         ChatGPT WebChat
                    reasoning / coding owner
                              │
                    explicit workstream ref
                              │
                              │ stable MCP ABI
                              ▼
                  WebChat-consumable capability plane
       ┌──────────────────────┼────────────────────────┐
       │                      │                        │
 Deep Agents             LangGraph /              Native sandbox
 backends                Agent Server             provider port
       │                      │                        │
 files/search/edit       checkpoint/store         isolated execute
 skills/memory           threads/runs             optional PTY/resume
 artifact transfer       optional specialists     provider lifecycle
       └──────────────────────┼────────────────────────┘
                              │
                    thin binding seam only
                  workstream ↔ native thread
                       ┌──────┴──────┐
                       │             │
                 Agent Server     LangSmith
                 thread status    Threads/Traces
                       │             │
                       └──────┬──────┘
                         Studio UI
```

## Versioned v3 candidate tool ABI

Phase 0 proved direct coding with 14 primitive tools. Version 2 added ten native
capability tools. Version 3 preserves those 24 descriptors and adds one grouped
provider-neutral interaction tool, for 25 total:

### Primitive coding

```text
capability_manifest
workspace_open
workspace_status
workspace_list
ls
read_file
write_file
edit_file
delete_file
glob
grep
execute
checkpoint_record
checkpoint_read
```

### Native capability planes

```text
context_discover       Deep Agents SkillsMiddleware + MemoryMiddleware
context_read           progressive skill / AGENTS.md disclosure
artifact_transfer      BackendProtocol upload_files / download_files
sandbox_workspace      provider-neutral native sandbox lifecycle
process                optional native PTY / stdin / cancel / reconnect
runtime_thread         threads / state / checkpoint history / native todos
runtime_run            durable runs / events / interrupts / Command resume
runtime_store          contained Agent Server Store namespace
specialist_task        explicit allowlisted specialists + native resume
observability_status   credential-safe LangSmith tracing state
interaction            neutral peer discovery/message/task/inbox adapter
```

ABI identity:

```text
chatgpt-langchain-capability-bridge.tools.v3
4b2cb616cd56135dc65bc06c39f0e68f1f000a36fdd95dacd8f7465fcea0747f
```

The descriptor fingerprint covers names, descriptions, schemas, and tool
annotations. Implementations and native providers may change behind this ABI;
descriptor changes require an explicit new ABI version and ChatGPT app rescan.
The tool count itself is not an architectural target or a long-term freeze.
Capabilities that are frequent, high-value, and clearer as first-class tools
may be promoted into the normal surface; low-frequency or provider-specific
operations may remain grouped or behind native runtime adapters. Tool placement
is a quality and ergonomics decision, not a fixed-count policy.

## Native-first implementation

The custom code is limited to:

- MCP transport and stable schemas;
- workspace/provider selection and path containment;
- bounded binary and process-output projection;
- capability allowlists and Agent Server Store prefixing;
- explicit state and evidence adapters;
- one thin WebChat workstream-ref binding to native Agent Server and LangSmith
  thread identities;
- provider-neutral interaction projection and endpoint allowlisting;
- WebChat-specific durable-pull delivery state.

The bridge reuses:

- Deep Agents `LocalShellBackend` for local container qualification;
- Deep Agents backend protocol for file, search, edit, execute, and transfer;
- Deep Agents `SkillsMiddleware` and `MemoryMiddleware` for native skills and
  `AGENTS.md` loading;
- LangChain `TodoListMiddleware`'s canonical `WriteTodosInput` schema, stored
  directly in Agent Server thread state rather than in a bridge planner;
- native LangGraph `interrupt()` plus Agent Server `Command(resume=...)` for
  HITL continuation without replaying the effect in MCP;
- LangGraph SQLite checkpointing in standalone mode;
- Agent Server threads, runs, checkpoint history, Store, and optional
  allowlisted assistants;
- Agent Server `threads.search` / `threads.create` as the runtime workstream
  state owner;
- Agent Server's native A2A endpoint and Agent Card for inbound peers;
- the official A2A Python SDK for cross-runtime discovery, messages, tasks,
  artifacts, streaming, and cancellation;
- LangSmith Threads for trace grouping and LangSmith Studio for inspection;
- a provider-neutral sandbox port, with a LangSmith Sandbox adapter included;
- the official MCP Python SDK and OpenAI Secure MCP Tunnel client.

## Exact WebChat boundary

Native capabilities can be exposed to WebChat, but Deep Agents cannot wrap
ChatGPT's private inference loop. Therefore:

| Capability | WebChat projection |
|---|---|
| Skills metadata and full `SKILL.md` | Explicit `context_discover` / `context_read` |
| `AGENTS.md` project memory | Explicit ordered memory discovery and read |
| Files, search, edits, execution | Direct primitive calls |
| LangGraph state and Agent Server services | Direct typed calls |
| WebChat workstream identity | Explicit ref bound to one native Agent Server thread and LangSmith `thread_id` |
| Structured planning / todos | Native `WriteTodosInput` in Agent Server thread state |
| Agent Server HITL / interrupts | Read native interrupt state and resume with `run_command` |
| Cross-runtime peer collaboration | `interaction` through a registered adapter; initial adapter is official A2A SDK |
| WebChat inbound peer updates | Native Agent Server A2A thread plus bounded durable-pull projection |
| Optional specialist agents | Explicit `specialist_task`, never automatic |
| Primitive WebChat tool approval | ChatGPT app/host permission boundary, not LangGraph middleware |
| Deep Agent hidden system prompt | **Cannot replace ChatGPT system prompt** |
| Deep Agent automatic history summarization | **Cannot summarize hidden WebChat history** |
| Deep Agent middleware around every model turn | **Not installed around WebChat** |

The last three remain model-loop boundaries. They may be characterized
empirically, but they are not parity requirements and do not justify cloning a
second model-loop harness around WebChat.

## Provider-neutral interaction and A2A

The current interaction substrate does not encode the current AOQ agent count, role names,
leadership tree, model provider, or workflow graph. It uses neutral references:

```text
participant / endpoint / capability
interaction / context / correlation
message / request / response / task / artifact / receipt
delivery state / trace context / authority refs
```

A2A is the first transport adapter, not the canonical ZES ontology. Internal
peers in one runtime may continue to use native LangGraph/Deep Agents calls;
opaque or cross-runtime peers can use A2A. Future Hermes, Codex, model-local,
or deterministic-service adapters can implement the same `InteractionAdapter`
without forcing the current role topology into transport code.

This layer is intentionally only a bounded interoperability substrate for now.
Agent-role definitions, product schemas, join policy, leadership behavior, and
multi-agent workflow are still evolving, so the bridge does not attempt to
freeze their message schemas or coordination graph early. Once those higher
layers stabilize, repeated interaction patterns can be promoted or specialized
using measured usage and quality rather than retrofitting today's assumptions.

For WebChat, outbound calls are direct while inbound collaboration is durable
pull: each workstream has a separate native interaction thread, Agent Server
Store retains only a bounded delivery projection, `workspace_open` reports
pending updates, and `interaction` reads or acknowledges them. No online,
thinking, idle, or hung presence is inferred.

Communication never grants ZES WorkItem, WorkspaceLease, execution, effect, or
publication authority. A2A Task IDs and LangGraph Run IDs remain native handles
linked by metadata rather than universal product identities.

See
[`docs/provider-neutral-interaction-a2a-architecture.md`](docs/provider-neutral-interaction-a2a-architecture.md)
and `evidence/native-a2a-interoperability-qualification-20260823.json`.

## Native workstream observability

The bridge does not clone DevSpace execution-scope storage or build another
dashboard. `workspace_open.thread_id` is treated as a WebChat workstream ref:

```text
WebChat workstream ref
        │
        ├─ Agent Server threads.search(metadata)
        │      └─ resolve one existing thread or create one
        │
        └─ LangSmith trace metadata.thread_id
               └─ native Threads / Traces / Runs / Studio views
```

If WebChat supplies no ref, the bridge mints a UUIDv7 and returns it. A supplied
ref is preferred because the first `workspace_open` trace can then be grouped
immediately. The binding is fail-open for coding: an Agent Server outage leaves
the workstream traceable in LangSmith and reports a typed degraded state rather
than creating a competing activity database.

The live qualification proved:

- exactly one Agent Server thread found by workstream metadata;
- native thread status `idle` and native `updated_at`;
- one LangSmith Thread containing `mcp.workspace_open`, `mcp.ls`, and
  `mcp.checkpoint_read` traces;
- no custom trace store, activity database, dashboard, or run state machine.

This does not expose ChatGPT's private reasoning interval. A silent WebChat gap
still cannot be classified authoritatively as reasoning versus hang.

See `evidence/native-workstream-observability-20260822.json`.

## Sandbox and persistent process state

`LocalShellBackend` is not a sandbox. It is allowed only inside the supplied
read-only Docker boundary with a disposable repository mount.

The MCP ABI is provider-neutral. `sandbox_workspace` selects one configured
native provider through `NativeSandboxProvider`; `process` is available only
when that provider supplies a resumable process handle with PTY, stdin, kill,
and reconnect semantics.

The included LangSmith Sandbox adapter is structurally qualified, but the
currently bound LangSmith workspace returned
`SandboxAuthenticationError: Sandbox feature is not enabled for this
organization`. No alternative provider credential was found on this VPS.
Consequently:

- provider-neutral sandbox composition: **implemented and tested**;
- LangSmith Sandbox live entitlement: **blocked externally**;
- persistent PTY live qualification: **still open**;
- direct WebChat coding through the isolated Docker backend: **not blocked**.

See `evidence/langsmith-sandbox-entitlement-probe-20260822.json`.

## Security boundary

The standalone qualification container uses:

- read-only root filesystem;
- all Linux capabilities dropped;
- `no-new-privileges`;
- PID limit and private Compose network;
- only one disposable repository plus a state volume mounted;
- no ZES checkout, VPS root, SSH directory, or provider key mounted.

Agent Server must be a dedicated bridge runtime. Its assistant IDs are
allowlisted, and Store access is prefixed under the configured bridge namespace.
Optional specialists are also alias-to-assistant allowlisted.

The tunnel sidecar receives only the OpenAI tunnel runtime credential file. The
bridge container does not receive those credentials.

## Local validation

```bash
uv sync --extra test --extra agent-server --python 3.13
uv lock --check
uv pip check
uv run pytest
uv run python -m compileall -q src
```

The suite covers primitive coding, path containment, HTTP MCP round trips,
LangGraph persistence, native skills and `AGENTS.md`, binary transfer, sandbox
provider composition, native command-handle projection, Agent Server
threads/runs/store, native todos, native interrupt/resume, explicit
specialists, provider-neutral interaction/A2A, and fail-open LangSmith tracing.

## Isolated coding server

Prepare a disposable failing repository and start the bridge:

```bash
SMOKE_REPO="$(uv run python scripts/prepare_smoke_workspace.py)"
export BRIDGE_WORKSPACE_HOST_PATH="$SMOKE_REPO"
docker compose up --build -d
uv run python scripts/probe_mcp.py
```

The decisive ChatGPT sequence remains primitive and model-owned:

```text
workspace_open
→ context_discover / context_read when relevant
→ ls / glob / read_file / grep
→ execute(pytest)
→ edit_file
→ execute(pytest)
→ execute(git diff --check && git diff)
→ checkpoint_record
```

## Agent Server seam

The same MCP application mounts at `/coding/mcp` as an Agent Server custom
route. Agent Server retains its native health, threads, runs, checkpoint,
assistants, Store, queue, and deployment surfaces. The built-in graph-as-tool
MCP route is not used as the primary benchmark because that would transfer the
coding loop to a graph-owned model.

Two deterministic no-model graphs are included for qualification:

- `bridge_journal` proves native runs, checkpoints, and todo state;
- `bridge_hitl` proves native `interrupt()` observation and
  `Command(resume=...)` continuation through the MCP runtime plane.
- `bridge_interaction` accepts native Agent Server A2A messages and writes the
  bounded WebChat delivery projection to Agent Server Store.

```bash
uv run langgraph dev --no-browser --no-reload --port 2026
uv run python scripts/probe_agent_server.py
uv run python scripts/probe_workstream_observability.py
```

The current live Agent Server qualification uses `langgraph dev` and its native
in-memory development runtime. The production path is now fixed as the licensed
standalone Agent Server with native Postgres and Redis. Its image and config are
ready, but activation is held because the production license is absent, the
current LangSmith key receives `403` from managed Deployment APIs, backing
services are not active, the process is still owned by DevSpace, and the host is
in a poor capacity window. The bridge does not substitute a custom persistence,
queue, deployment, or telemetry service. See
[`docs/native-agent-server-production-readiness.md`](docs/native-agent-server-production-readiness.md)
and `evidence/native-agent-server-production-readiness-20260822.json`.

The existing v2 Secure MCP Tunnel was also switched in place from the standalone
`/mcp` route to Agent Server `/coding/mcp` without changing the app catalog or
24-tool ABI. The already-connected `ZES_LangChain_Runtime` app remained usable:
it read the manifest, opened a workstream, resolved one native Agent Server
thread, called native runtime state, and recorded/read a checkpoint from Agent
Server Store. LangSmith grouped those direct calls into one Thread containing
five traces. See `evidence/direct-native-agent-server-route-20260822.json`.

A controlled tunnel-client-only restart preserved the same app namespace,
explicit workstream, native Agent Server thread, Agent Server Store checkpoint,
and LangSmith Thread without a rescan. The first direct call made immediately
after tunnel `ready` returned a host-side `UNKNOWN` error before any native tool
trace was created; subsequent direct calls succeeded and appended traces to the
existing LangSmith Thread. Reconnect continuity is therefore demonstrated, but
zero-gap availability is not. See
`evidence/direct-tunnel-reconnect-continuity-20260822.json`.

## Direct ChatGPT qualification

The preferred transport is OpenAI Secure MCP Tunnel:

```text
ChatGPT
  ↕ OpenAI tunnel control plane
tunnel-client sidecar
  ↕ private Compose network
bridge:8765/mcp
```

The runtime credentials already live outside the repository in a root-only
environment file. `compose.tunnel.yaml` reads that file through
`TUNNEL_RUNTIME_ENV_FILE` and never exposes the bridge publicly.

Use [`docs/secure-mcp-tunnel-runbook.md`](docs/secure-mcp-tunnel-runbook.md) for
Gate A. Gate A now passes through the uniquely named
`ZES_LangChain_Runtime` app: ChatGPT opened the disposable repository, read
native context, repaired the source, read the mutation back, passed two tests,
passed `git diff --check`, and persisted a checkpoint without Nexus, Legacy, or
a second model.

LangGraph, Deep Agents, Agent Server, and LangSmith are the owner-committed
long-term ZES direction. Remaining gates control production readiness and the
safe retirement order of incumbent machinery; they do not reopen platform
selection.

The v3 interaction candidate is intentionally not deployed to that live app.
It has 25 tools and therefore requires an explicit ChatGPT app rescan after the
candidate is integrated and the runtime activation boundary is approved. This
hold is about the maturity of the interaction/role/schema layer, not about
preserving a 24-tool count.

Gate C uses the subtractive characterization protocol in
[`docs/ab-benchmark-protocol.md`](docs/ab-benchmark-protocol.md). Deterministic
same-session replay is scored separately from independent fresh-chat behavior
so tool-plane behavior cannot be mistaken for model-quality evidence.

The first C0 characterization used identical multi-file billing clones. Both
DevSpace and the native route passed all four tests, passed `git diff --check`,
changed exactly the same two source files, and produced the same patch digest.
The evidence supports using native Deep Agents coding/context and native Agent
Server/LangSmith state and observability. It does **not** authorize a particular
tool-surface expansion from that benchmark alone, a DevSpace control-plane port,
or a platform winner claim. Tool additions remain independently admissible when
repeated use and quality justify them. DevSpace-only observations default to REJECT, RETIRE, or
DEFER_WITH_FALSIFIER. See
`evidence/gate-c0-harness-characterization-20260822.json`.

The apparent native call amplification was then localized without adding new
instrumentation: 31 unique Secure MCP Tunnel `tools/call` commands matched 31
LangSmith project root traces one-to-one. The 16 calls beyond the 13 visible C0
calls were only open/context/read/status; edits and executions were not
duplicated. The bridge and Agent Server did not synthesize retries. Current
disposition is to retain native LangSmith/tunnel OTel measurement and reject a
custom dedup or activity database. See
`evidence/gate-c0-call-amplification-diagnosis-20260822.json`.

Production activation is intentionally separate from capability qualification.
After licensed authority exists, the first sovereign staging deployment should
use the pinned native image plus the services generated by `langgraph up`, an
external root-only env file, and only a thin loopback-port/secret Compose
binding. It must prove Postgres/Redis persistence and direct ChatGPT continuity
before the development runtime is retired. The tracked
`.env.agent-server.production.example` contains names/placeholders only.

## Current development deployment — 2026-08-23

The v3 candidate is published on `owner/main` and runs as the independent,
loopback-only `zes-langchain-runtime-v3-dev.service` on port `2030`. The OpenAI
Secure MCP Tunnel now targets `/coding/mcp` on that runtime. Direct WebChat
qualification passed against a real `zes-worktree://zesnexus` lane, including
native Agent Server durable write/read/delete and a clean terminal Git state.
The prior port `2026` runtime remains available for bounded rollback.

The ChatGPT connector already observes the v3 manifest and existing tools. The
new `interaction` tool requires one draft-app **Scan tools** or connector refresh
before it becomes callable in the host catalog. This cutover is a development
runtime deployment, not licensed production activation; Postgres, Redis,
license authority, and production isolation remain separate gates. See
`evidence/dev-v3-cutover-20260823.json`.
