# ChatGPT → LangChain Native Capability Bridge

This experiment qualifies a specific architecture:

> ChatGPT WebChat remains the reasoning and coding owner while MCP projects
> native Deep Agents, LangGraph, Agent Server, sandbox, and observability
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

## Stable v2 tool ABI

Phase 0 proved direct coding with 14 primitive tools. Version 2 preserves those
primitives and adds ten grouped native capability tools, for 24 total:

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
```

ABI identity:

```text
chatgpt-langchain-capability-bridge.tools.v2
071b7d38d9205565264541ecc3eb84b5fa3681544d462eaf3511abf90e6a47b7
```

The descriptor fingerprint covers names, descriptions, schemas, and tool
annotations. Implementations and native providers may change behind this ABI;
the qualification surface must not drift without an explicit new ABI version
and ChatGPT app rescan.

## Native-first implementation

The custom code is limited to:

- MCP transport and stable schemas;
- workspace/provider selection and path containment;
- bounded binary and process-output projection;
- capability allowlists and Agent Server Store prefixing;
- explicit state and evidence adapters;
- one thin WebChat workstream-ref binding to native Agent Server and LangSmith
  thread identities.

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
| Optional specialist agents | Explicit `specialist_task`, never automatic |
| Primitive WebChat tool approval | ChatGPT app/host permission boundary, not LangGraph middleware |
| Deep Agent hidden system prompt | **Cannot replace ChatGPT system prompt** |
| Deep Agent automatic history summarization | **Cannot summarize hidden WebChat history** |
| Deep Agent middleware around every model turn | **Not installed around WebChat** |

The last three remain model-loop differences and must be measured in the A/B
comparison rather than described as solved.

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

The v2 MCP ABI is provider-neutral. `sandbox_workspace` selects one configured
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
specialists, and fail-open LangSmith tracing.

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

```bash
uv run langgraph dev --no-browser --no-reload --port 2026
uv run python scripts/probe_agent_server.py
uv run python scripts/probe_workstream_observability.py
```

The current live Agent Server qualification uses `langgraph dev` and its native
in-memory development runtime. The production image builds successfully, but
steady-state standalone activation is intentionally held until the required
production license authority and native Postgres/Redis backing services are
available. The bridge does not substitute a custom persistence service.

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
a second model. Migration remains blocked until the representative A/B and
long-horizon continuity gates in
[`docs/capability-parity-matrix.md`](docs/capability-parity-matrix.md) pass.
