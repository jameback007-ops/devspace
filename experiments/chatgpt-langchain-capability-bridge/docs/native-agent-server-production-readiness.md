# Native Agent Server production readiness

## Decision

The production direction is the licensed standalone LangGraph Agent Server
using its native Postgres and Redis data plane. The current `langgraph dev`
process remains a qualification runtime only. Managed LangSmith Deployment is
not the selected fallback: the currently bound LangSmith key receives `403
Forbidden` from the deployment-list API, and no custom deployment control
plane will be built around that restriction.

```text
ChatGPT WebChat
      │
OpenAI Secure MCP Tunnel
      │ private loopback route
      ▼
licensed LangGraph Agent Server image
      ├─ native custom /coding/mcp route
      ├─ native Threads / Runs / Store / queue
      ├─ dedicated Postgres
      ├─ dedicated Redis
      └─ LangSmith tracing / Studio
```

## Current readiness state

### Ready

- `langgraph.json` validates with four native graphs and the custom HTTP app.
- Python 3.13 Wolfi production image builds successfully.
- Image runtime edition is `postgres`; API variant is `licensed`.
- Native image entrypoint contains the core API and Uvicorn lifecycle.
- Native OpenTelemetry auto-instrumentation is already present.
- Frozen 24-tool MCP ABI passes direct ChatGPT, Agent Server, tunnel reconnect,
  and deterministic multi-file characterization.
- Secure MCP Tunnel reaches the Agent Server custom route privately.
- The host has Docker and Compose available.
- License-verification egress to the LangChain beacon network is reachable.

### Externally blocked

- `LANGGRAPH_CLOUD_LICENSE_KEY` is not bound.
- The current LangSmith API key cannot use managed Deployment APIs (`403`).
- No production `DATABASE_URI` or `REDIS_URI` is bound.
- No dedicated Postgres or Redis service is active on the host.

### Operationally held

- The current development Agent Server is a child of
  `devspace-zesnexus.service`; it has no independent lifecycle.
- Root disk usage is 81 percent and swap is fully consumed.
- A separate DIND workload currently uses about 6.7 GiB and sustained
  multi-core CPU. Starting another persistent data plane in this window would
  weaken qualification evidence and rollback clarity.

Status: **activation held**. Code and image are ready; authority, backing
services, independent lifecycle, and a quieter capacity window are not.

## Native activation contract

The native CLI already generates the required services:

- `redis:6` with a health check;
- `pgvector/pgvector:pg16` with a durable `langgraph-data` volume when an
  external Postgres URI is not supplied;
- the LangGraph API image with `REDIS_URI` and Postgres connection settings.

Do not reproduce this with a custom state service or bespoke queue. Use either:

1. native `langgraph up` with its generated Postgres/Redis services for the
   first licensed standalone qualification; or
2. native `langgraph up --postgres-uri ...` with separately governed Postgres
   when ZES has an established database lifecycle.

Redis remains a dedicated native Agent Server dependency in either case.

## Secret and network boundary

Production values belong in a root-owned `0600` file outside Git, for example:

```text
/etc/devspace/chatgpt-langchain-production.env
```

The tracked `.env.agent-server` contains only non-secret bridge configuration.
Use `.env.agent-server.production.example` as a name/template reference only.

The API image listens on container `0.0.0.0:8000`, but the host publication
must be overridden to loopback only. The Secure MCP Tunnel then targets the
loopback production port. Do not publish the write-capable MCP route directly
to a public interface.

A minimal root-owned Compose overlay is acceptable for exactly two deployment
concerns:

- attach the external secret env file;
- replace the generated API port mapping with a loopback-only mapping.

That overlay is a deployment binding, not a replacement runtime or state
engine. It should be generated and installed only when the license authority
exists; no credential-bearing overlay is tracked in this repository.

## Activation sequence after authority exists

1. Bind the production license and LangSmith credential in the external
   root-only env file.
2. Select dedicated Postgres and Redis ownership. Do not reuse the stale,
   unrelated `atlasval-pg` container.
3. Choose a low-load maintenance window and preserve current tunnel/Agent
   Server evidence.
4. Start the native standalone stack on a new loopback staging port using the
   already-built pinned image.
5. Wait for native service health, migrations, `/ok`, thread, run, Store, todo,
   HITL, and `/coding/mcp` probes.
6. Run one disposable write-capable direct ChatGPT qualification against the
   staging route.
7. Verify Postgres/Redis persistence by restarting only the API container and
   reading the same thread, run state, Store entry, and bridge checkpoint.
8. Switch the Secure MCP Tunnel target in place while preserving the frozen
   24-tool ABI; verify connector reconnect and workstream continuity.
9. Retain the development server and standalone bridge only for a bounded
   rollback interval, then retire them after production evidence is stable.

## Rollback

Rollback is route substitution, not data replay:

- restore the tunnel target to the still-qualified development Agent Server or
  standalone bridge;
- do not replay an indeterminate mutation;
- reconcile repository and native state before retry;
- preserve the production Postgres/Redis volumes for diagnosis.

## Subtractive dispositions

| Item | Disposition | Reason |
|---|---|---|
| `langgraph dev` as steady state | RETIRE after cutover | in-memory and owned by DevSpace service lifecycle |
| Managed LangSmith Deployment | DEFER | current key is forbidden; no authority to create or list deployments |
| Licensed standalone Agent Server | USE NATIVE | sovereign path with native queue, Store, runs, and persistence |
| Custom checkpoint/database service | REJECT | Postgres and Agent Server already own durable runtime state |
| Custom Redis replacement | REJECT | native queue/streaming dependency already specified |
| Full self-hosted LangSmith stack | DEFER/REJECT for this lane | SaaS tracing and Studio already function; no measured sovereignty need here |
| Custom MCP OTel instrumentation | REJECT | Agent Server image and tunnel already expose native OTel paths |
| Kubernetes/Helm now | DEFER_WITH_FALSIFIER | current target is one VPS; adopt when HA, multi-node scaling, or isolation requires it |
| DevSpace execution-scope/recovery clone | REJECT | native Threads, Runs, Store, LangSmith, and tunnel evidence cover tested needs |
| Thin deployment overlay | ALLOW | only external secret env and loopback port binding |

## Exit criteria for the hold

Activation may begin only when all are true:

- licensed standalone authority is supplied;
- Postgres and Redis ownership is explicit;
- a root-only secret env file exists;
- staging and rollback ports are reserved;
- disk/swap/load permit a controlled test;
- tunnel target rollback is rehearsed;
- production state persistence can be validated without DevSpace.

Until then, keep the qualified development Agent Server and tunnel running and
continue native capability work without manufacturing a substitute production
platform.
