# Secure MCP Tunnel direct-WebChat qualification

This runbook connects ChatGPT directly to the LangChain capability bridge. It
must not bind the tunnel to Nexus/DevSpace.

## Fixed topology

```text
ChatGPT workspace
   ↕ OpenAI Secure MCP Tunnel
official tunnel-client v0.0.12
   ↕ private Docker network
chatgpt-langchain bridge:8765/mcp
   ↕
disposable repository + isolated checkpoint volume
```

The bridge does not receive the OpenAI tunnel runtime key. The tunnel sidecar
does not receive repository or LangSmith credentials.

## Prepared host state

The VPS already has:

- official `tunnel-client` v0.0.12;
- the user-created tunnel ID and runtime API key in
  `/etc/tunnel-client/zes-agent-runtime.secret.env`;
- file ownership/mode `root:root 0600`;
- the LangSmith binding separately in
  `/etc/devspace/chatgpt-langchain.env`;
- no active agent-runtime tunnel daemon yet.

Never print, hash, copy to argv, or commit either credential file.

## 1. Validate the frozen bridge

```bash
cd experiments/chatgpt-langchain-capability-bridge
uv sync --extra test --extra agent-server --python 3.13
uv lock --check
uv pip check
uv run pytest
```

Expected model-facing ABI:

```text
version: chatgpt-langchain-capability-bridge.tools.v2
tool count: 24
fingerprint: 071b7d38d9205565264541ecc3eb84b5fa3681544d462eaf3511abf90e6a47b7
```

Do not start the tunnel if any descriptor or test differs.

## 2. Prepare the disposable coding repository

```bash
export BRIDGE_WORKSPACE_HOST_PATH="$(uv run python scripts/prepare_smoke_workspace.py)"
export TUNNEL_RUNTIME_ENV_FILE=/etc/tunnel-client/zes-agent-runtime.secret.env
```

The bridge container mounts only this repository and its isolated state volume.
It must not mount ZES, `/root`, `~/.ssh`, or `/etc`.

## 3. Start the private bridge

```bash
docker compose up --build -d bridge
docker compose ps
curl -fsS http://127.0.0.1:${BRIDGE_PORT:-8765}/healthz
uv run python scripts/probe_mcp.py
```

The MCP listener may bind to VPS loopback for operator probes. It must not bind
the public interface.

## 4. Run tunnel doctor against the real MCP target

Use the root-only runtime environment file without expanding values into the
command line:

```bash
set -a
. "$TUNNEL_RUNTIME_ENV_FILE"
set +a

tunnel-client doctor \
  --control-plane.api-key env:CONTROL_PLANE_API_KEY \
  --control-plane.tunnel-id "$CONTROL_PLANE_TUNNEL_ID" \
  --mcp.server-url url=http://127.0.0.1:${BRIDGE_PORT:-8765}/mcp,channel=main \
  --health.listen-addr 127.0.0.1:18080 \
  --json
```

Doctor must pass the control-plane and MCP target checks. Do not substitute the
Nexus URL or port.

## 5. Start the official tunnel sidecar

```bash
docker compose \
  -f compose.yaml \
  -f compose.tunnel.yaml \
  --profile tunnel \
  up --build -d
```

Operator checks:

```bash
curl -fsS http://127.0.0.1:18080/healthz
curl -fsS http://127.0.0.1:18080/readyz
docker compose -f compose.yaml -f compose.tunnel.yaml logs --tail=100 tunnel-client
```

The admin UI remains loopback-only at `http://127.0.0.1:18080/ui`.

## 6. Scan the app in ChatGPT

In the ChatGPT workspace associated with the tunnel:

1. enable developer mode;
2. create or edit the draft app;
3. give the app a unique name that cannot collide with existing connector
   namespaces; for this repository use `ZES LangChain Runtime`, not the generic
   `ZES` name when `ZES_Nexus` or `ZES_Legacy` are also installed;
4. choose **Tunnel** connection;
5. select the prepared tunnel;
6. scan tools;
7. verify 24 exact tool names;
8. call `capability_manifest` and verify the v2 fingerprint;
9. keep the app in draft during qualification.

The app scan is the authority for what ChatGPT currently sees. Backend health
alone does not prove host catalog freshness.

## 7. Direct ChatGPT coding test

Use this mission:

> Open the disposable repository. Discover relevant project instructions and
> skills. Inspect the source and tests, run the failing tests, diagnose the
> defect, edit the source yourself, rerun validation, inspect the Git diff, and
> record a checkpoint. Do not delegate the repair to another model or agent.

Expected core sequence:

```text
workspace_open
→ context_discover / context_read
→ ls / glob / read_file / grep
→ execute(pytest)
→ edit_file
→ execute(pytest)
→ execute(git diff --check && git diff)
→ checkpoint_record
```

For every mutation, inspect the structured result and immediately read back the
changed source or state. An empty result, a result containing a native backend
error, or a resource disappearing before readback is non-terminal and fails the
gate. Do not infer mutation success from HTTP 200 or tunnel readiness alone.

`specialist_task` must not be used during Gate A. Sandbox/process tools are
optional and currently blocked by live provider entitlement; they are not
required for this disposable repair.

## Pass criteria

- ChatGPT discovers the exact 24-tool v2 ABI.
- The app uses a unique host namespace throughout the turn.
- Calls travel through the new Secure MCP Tunnel, not Legacy/Nexus.
- ChatGPT itself selects the inspection, patch, and validation sequence.
- Initial tests fail and repaired tests pass.
- Diff is minimal and `git diff --check` passes.
- Checkpoint is readable after a connector reconnect or new chat.
- Mutation tool results are terminal and source/state readback confirms them.
- Tunnel remains ready and bridge remains private.
- No credential, hidden reasoning, or source payload is emitted to logs/traces.

## Failure classification

| Symptom | Likely layer |
|---|---|
| Tunnel absent from ChatGPT | workspace association or Tunnel permissions |
| `healthz` passes but `readyz` fails | control-plane key/polling/tunnel binding |
| MCP doctor target fails | bridge health, path, or private routing |
| Tool scan count/fingerprint differs | ChatGPT app snapshot or live ABI drift |
| Direct resource disappears while tunnel stays ready | ChatGPT host app catalog or namespace routing |
| Mutation returns no terminal result and source is unchanged | Host confirmation/cancellation or typed backend error hidden as success |
| Primitive file/shell call fails | Deep Agents backend/container boundary |
| Skill/memory missing | source path or native middleware loading |
| Checkpoint missing | LangGraph/Agent Server state boundary |
| Sandbox says provider not configured | expected unless a provider is selected |
| LangSmith Sandbox auth failure | external organization feature entitlement |

Do not repair a ChatGPT catalog problem by widening mounts, exposing a public
MCP endpoint, or routing this runtime through DevSpace.

## Stop and preserve evidence

```bash
docker compose -f compose.yaml -f compose.tunnel.yaml down
```

Preserve only bounded logs, test receipts, tool count/fingerprint, checkpoint
identity, and Git diff. Do not preserve credential values or raw WebChat
transcripts in repository evidence.
