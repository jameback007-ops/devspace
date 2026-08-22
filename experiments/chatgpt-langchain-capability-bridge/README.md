# ChatGPT → LangChain Coding Capability Bridge

This experiment tests one narrow architecture question:

> Can ChatGPT WebChat remain the reasoning and coding owner while MCP gives it
> direct, near-DevSpace coding capability implemented primarily by native
> LangChain ecosystem components?

It deliberately does **not** invoke a second LLM or a Deep Agent coding loop.
ChatGPT calls primitive tools itself:

```text
ChatGPT WebChat (reasoning owner)
        │
        │ MCP tool calls
        ▼
Official MCP Python SDK
        │
        ├── Deep Agents LocalShellBackend
        │     filesystem + search + edit + shell
        │
        └── LangGraph SqliteSaver
              durable tool-plane checkpoints
```

## Why this is native-first

The adapter contains only transport, workspace selection, path normalization,
and stable tool schemas. It delegates implementation to:

- `deepagents.LocalShellBackend` for `ls`, `read`, `write`, `edit`, `delete`,
  `glob`, `grep`, and `execute`;
- LangGraph `StateGraph` + `SqliteSaver` for durable checkpoint history;
- the official MCP Python SDK for streamable HTTP transport.

Git, worktrees, package installation, tests, builds, and language CLIs are
available through the native shell primitive rather than reimplemented as a
large custom tool suite.

## Security boundary

`LocalShellBackend` is explicitly unrestricted and is **not a sandbox**. The
prototype must therefore run inside the supplied Docker container or a native
Deep Agents remote sandbox provider. Do not expose the host-local process as a
remote write-capable MCP server.

The container should mount only an isolated test repository. The initial
compose file binds the MCP port to loopback and does not configure public auth.

## Run tests

```bash
uv sync --extra test --python 3.13
uv run pytest
```

The suite verifies:

1. native Deep Agents filesystem/search/edit/shell use;
2. Git-visible source mutation and execution;
3. path-containment checks for file tools;
4. LangGraph checkpoint persistence after reopening SQLite;
5. a real streamable-HTTP MCP initialize/list/call round trip.

## Run the isolated coding smoke server

Prepare a disposable failing repository:

```bash
SMOKE_REPO="$(uv run python scripts/prepare_smoke_workspace.py)"
export BRIDGE_WORKSPACE_HOST_PATH="$SMOKE_REPO"
docker compose up --build -d
uv run python scripts/probe_mcp.py
```

The probe intentionally leaves the failing source untouched. The decisive test
is performed from ChatGPT after connecting the MCP endpoint:

1. call `workspace_open` for `/workspace`;
2. inspect the repository with `ls`, `read_file`, `glob`, and `grep`;
3. run the failing tests with `execute`;
4. diagnose and repair the defect with `edit_file`;
5. rerun tests, inspect `git diff`, and record a checkpoint.

No `agent.run`, `delegate`, or hidden model call is present.

The deterministic capability qualification uses the same MCP calls to exercise
the complete repair path without introducing another model:

```bash
uv run python scripts/qualify_coding_fixture.py \
  --url http://127.0.0.1:8765/mcp \
  --workspace /workspace
```

This proves the tool plane. The separate WebChat qualification still matters
because only the ChatGPT host can prove model-facing tool discovery and actual
tool-selection behavior.

For a model-owner rehearsal without an installed ChatGPT app, `call_tool.py`
invokes exactly one primitive per process. This lets the current ChatGPT session
choose the sequence and interpret each result while the final direct-connector
gate remains pending:

```bash
uv run python scripts/call_tool.py workspace_open '{"path":"/workspace"}' \
  --url http://127.0.0.1:8765/mcp
```

## Run inside native Agent Server

The same MCP application can be inserted as an Agent Server custom route while
Agent Server retains its native runs, threads, assistants, store, auth, and
deployment APIs:

```bash
mkdir -p /tmp/chatgpt-langchain-agent-server-workspace
uv sync --extra agent-server --python 3.13
uv run langgraph dev --no-browser --no-reload --port 2026
```

The primitive MCP route is then `http://127.0.0.1:2026/coding/mcp`; Agent
Server's own health endpoint remains `http://127.0.0.1:2026/ok`. The built-in
Agent Server `/mcp` route is not used for this benchmark because it exposes a
whole graph as a tool rather than letting ChatGPT own each coding decision.

Run the combined qualification probe while the server is active:

```bash
uv run python scripts/probe_agent_server.py
```

It verifies one native Agent Server thread/run/checkpoint and one primitive MCP
checkpoint stored through Agent Server's own Store from the custom route.

The environment file is non-secret and exists only to keep `langgraph.json`
portable across `dev`, `build`, and `up`. Deployment credentials belong in the
deployment environment, not this file.

## Current evidence ceiling

The local prototype proves the native backend composition and MCP transport.
It does not yet prove ChatGPT host catalog stability, remote authentication,
persistent PTY/process continuation, or long-horizon WebChat continuity. Those
are explicit next gates rather than assumed properties.

See [`docs/research-findings.md`](docs/research-findings.md) and
[`docs/capability-parity-matrix.md`](docs/capability-parity-matrix.md).
The exact local qualification receipts and evidence ceiling are recorded in
[`evidence/qualification-summary.json`](evidence/qualification-summary.json).

For the actual private WebChat connection gate, use
[`docs/secure-mcp-tunnel-runbook.md`](docs/secure-mcp-tunnel-runbook.md). It
adds the official OpenAI `tunnel-client` as a sidecar and leaves the MCP server
on the private Docker network.
