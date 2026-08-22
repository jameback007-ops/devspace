# Secure MCP Tunnel qualification runbook

This is the preferred ChatGPT WebChat test path. It keeps the coding MCP server
private and uses OpenAI's outbound-only Secure MCP Tunnel rather than a public
reverse proxy or an ad hoc tunnel.

## Preconditions

The operator needs all of the following from OpenAI Platform and ChatGPT:

1. a `tunnel_id` associated with the target ChatGPT workspace;
2. a **runtime** API key whose principal has Tunnels Read + Use;
3. ChatGPT developer-mode access and permission to create a draft app;
4. a disposable repository prepared for the coding test.

Tunnel CRUD permissions and ChatGPT developer-mode permissions are separate.
Do not give an OpenAI admin key to the long-running tunnel daemon.

Current OpenAI product documentation describes full write/modify MCP actions as
a Business and Enterprise/Edu beta. Pro availability is documented as
read/fetch-only, although pre-existing or separately enabled connectors may
behave differently. The WebChat qualification must therefore verify the actual
workspace entitlement instead of assuming write access.

## Prepare the isolated repository

```bash
cd experiments/chatgpt-langchain-capability-bridge
uv sync --extra test --python 3.13
export BRIDGE_WORKSPACE_HOST_PATH="$(uv run python scripts/prepare_smoke_workspace.py)"
export BRIDGE_PORT=18765
```

The bridge container receives only this repository and a checkpoint volume. It
does not mount the VPS root, ZES checkout, SSH directory, or provider secrets.

## Start the private MCP server and official tunnel client

Supply credentials through the shell, a credential store, or systemd—not a
committed `.env` file:

```bash
export CONTROL_PLANE_TUNNEL_ID='tunnel_...'
export CONTROL_PLANE_API_KEY='sk-...runtime-key...'

docker compose \
  -f compose.yaml \
  -f compose.tunnel.yaml \
  --profile tunnel \
  up --build -d
```

Local operator checks:

```bash
curl -fsS http://127.0.0.1:18080/healthz
curl -fsS http://127.0.0.1:18080/readyz
```

The tunnel client must remain healthy and ready during app discovery and every
subsequent MCP call. Its admin UI is loopback-only at
`http://127.0.0.1:18080/ui`.

## Connect from ChatGPT

In ChatGPT developer mode:

1. create a draft app;
2. select **Tunnel** as the connection type;
3. select or paste the same `tunnel_id`;
4. scan the tools;
5. confirm that the stable 14-tool primitive surface appears and that
   `capability_manifest.tool_abi.fingerprint_sha256` is
   `8006cdd2a6c03e94b29fefbdab7f0dd1b9e1d7904e495d51c8e9f3ffab7b77e2`;
6. keep the app as a draft during qualification.

The MCP surface must remain frozen during the A/B test. Implementations can
change behind it, but changing required inputs or removing tools can invalidate
ChatGPT's frozen tool snapshot and cause opaque call failures.

## Decisive WebChat prompt

The test must make ChatGPT itself own the coding loop:

> Open the disposable repository. Inspect it, run the tests, diagnose the
> defect, edit the source yourself, rerun validation until it passes, inspect
> the Git diff, and record a checkpoint. Do not delegate coding to another
> model or agent.

Expected observable sequence:

```text
workspace_open → ls/glob/read_file/grep → execute(pytest)
→ edit_file → execute(pytest) → execute(git diff --check && git diff)
→ checkpoint_record
```

No `agent.run`, model invocation, or delegated coding tool exists in the
prototype.

## Pass criteria

- ChatGPT discovers and calls the primitive tools itself.
- The initial tests fail and the repaired tests pass.
- The source diff is minimal and valid.
- No second LLM or Deep Agent model loop performs the repair.
- The checkpoint is readable after reconnecting the draft app or opening a new
  chat.
- Tunnel `/readyz` remains healthy and the private MCP server never acquires a
  public listener.

## Failure classification

| Symptom | Likely layer |
|---|---|
| Tunnel absent from ChatGPT | workspace association or Tunnels Read + Use |
| `/healthz` passes but `/readyz` fails | control-plane polling or API-key permission |
| Tool scan fails | tunnel client, MCP protocol, or ChatGPT entitlement |
| Tool exists but call schema errors | frozen ChatGPT tool snapshot vs live ABI |
| File/shell operation fails | Deep Agents backend or container capability |
| Checkpoint missing | LangGraph/Agent Server Store boundary |

Do not repair a ChatGPT catalog problem by broadening the container mount or
making the MCP server public.
