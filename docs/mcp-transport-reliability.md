# MCP Transport Reliability Supervisor

Status: the transport supervisor source is integrated. Production host/client
adoption and the separate primary self-healing activation remain governed
follow-up effects. See `mcp-primary-self-healing.md`.

## Scope and authority boundary

This work owns executor/client-side reliability after a tool contract has been
selected:

```text
agent reasoning loop
        |
        v
Transport/Capability Supervisor
        |
        v
official MCP Client / host adapter / transport
```

It does not own:

- the Stable MCP Tool ABI, stable bootstrap schema, frozen client catalog
  projection, or compatibility contract;
- canonical task, decision, memory, writer, publication, release, runtime, or
  effect authority;
- production deployment or reverse-proxy configuration;
- host behavior that has not adopted the supervisor adapter.

The current ChatGPT-host call path is outside the DevSpace server process. A
server cannot transparently recover a response that the host discarded after a
successful backend effect. This candidate therefore provides a reusable
supervisor and official MCP `Client` adapter for host/client consumers, plus
effect-receipt semantics that remain safe when a response is lost. It does not
claim that the live ChatGPT host has adopted the adapter.

Primary service and catalog recovery are specified separately. The Transport
Supervisor owns one logical MCP call; the primary self-healing plane owns
cross-call functional readiness, one incident owner, bounded service repair,
diagnostic escalation, fallback admission, safe turn landing, and verified
failback. Neither layer silently grants the other effect authority.

The ZES Research Reflex action was attempted before source mutation and returned
`RESEARCH_CYCLE_WORKSPACE_NOT_MANAGED` because this DevSpace repository is not an
enabled ZES-managed research workspace. External research therefore used the
official MCP specification, the installed official TypeScript SDK source, and
production resilience references directly. No lifecycle receipt was fabricated.

## What upstream MCP and the installed SDK already provide

The MCP Streamable HTTP specification already defines:

- JSON-RPC over HTTP POST, with either direct JSON or SSE responses;
- disconnection as distinct from explicit request cancellation;
- optional SSE event IDs, `Last-Event-ID` resumption, and stream-scoped
  redelivery;
- optional stateful session IDs;
- mandatory client re-initialization after an expired session returns HTTP 404.

The installed `@modelcontextprotocol/sdk` 1.29.0 already provides:

- request timeout and cancellation support in `RequestOptions`;
- bounded SSE reconnection configuration;
- SSE resumption tokens and replay message IDs;
- structured JSON-RPC and tool-output schema parsing;
- transport error callbacks and explicit close/terminate operations.

Those native features are reused. The supervisor does not reimplement SSE
framing, JSON-RPC correlation, OAuth, protocol negotiation, or event replay.

## What remains a ZES/host responsibility

Neither the protocol nor the installed SDK provides end-to-end policy for:

- retry safety by operation semantics;
- backend success followed by response loss;
- material-effect idempotency and authoritative receipt reconciliation;
- generic empty, truncated, delayed, or semantically incomplete tool output;
- retry budgets and jitter coordinated above a single transport stream;
- circuit breaking after repeated equivalent failures;
- lane-specific fail-closed behavior for research, validation, canonical-state
  mutation, and publication effects;
- duplicate host delivery suppression;
- reliability SLO metrics and ceremony-cost accounting.

The installed SDK's Streamable HTTP client performs bounded SSE reconnection,
but ordinary `send()` failures are surfaced to the caller. Its direct JSON path
parses one response and fails if the body is missing or incomplete. Stream
resumption also cannot decide whether a material tool effect may be replayed.

## Compatibility-lab reconciliation

The isolated MCP upstream/ChatGPT-host compatibility lab produced source-only
commit `444ee06b175277fb1db2c74fecd63df10a2d5419` and a typed Transport
Supervisor handoff. This candidate consumes that handoff without modifying or
publishing the lab candidate.

The lab established several boundaries that are now explicit contracts here:

- one logical call has a stable `logicalCallId`; every primary, reconnect,
  legacy-session recreation, subscription re-listen, and effect-reconciliation
  attempt has a distinct `attemptId`;
- a legacy session is recreated only after the exact typed combination of HTTP
  404, JSON-RPC code `-32000`, the `Unknown MCP session` message, and an
  attested `legacy_stateful` protocol era;
- authentication failures, generic 404s, 5xx/network failures, and unsupported
  negotiation outcomes never masquerade as a stale legacy session;
- a closed modern subscription is recovered only through bounded re-listen
  followed by a forced `tools/list` refetch whose complete fingerprint matches
  the expected fingerprint;
- MCP transport success, HTTP success, JSON/MCP envelope validity, tool-level
  `isError`, semantic usability, and material-effect terminality are separate
  evidence layers;
- cooperative cancellation after possible dispatch does not establish that an
  effect stopped; the exact effect key must be reconciled before replay;
- tool-level `isError` is not automatically retried unless a domain assessor
  explicitly classifies that application error as transient;
- MCP silence is not classified as model reasoning, provider queueing, or a
  hang. The supervisor operates only on observed call/transport evidence.

The bounded recovery receipt records metadata and digests, not raw payloads. It
contains the call safety class, a credential-free opaque endpoint reference,
protocol era/revision, backend generation, dispatch certainty, HTTP/protocol
class, response body length/digest when available, semantic output class,
subscription generation and forced-refetch fingerprints, effect
terminality/receipt reference, a SHA-256 digest rather than the raw
idempotency/effect key, circuit key, and final disposition. Credential-bearing
userinfo, query parameters, control characters, and whitespace are rejected at
the input boundary; unsafe output evidence references are reduced to digests.

## Supervisor states

| State | Meaning | Required caller action |
| --- | --- | --- |
| `HEALTHY` | Primary call returned usable output on the first attempt. | Continue normally. |
| `TRANSIENT_RETRYING` | Non-terminal internal transition while a retry or repair remains safe and within budget. | No model-level retry ceremony. |
| `TRANSPORT_DEGRADED` | Primary transport or capability subset is unavailable after bounded repair. | Use only an explicitly typed, quality-equivalent route or wait for recovery. |
| `OUTPUT_INDETERMINATE` | No complete usable result can be established. | Do not consume the result or claim research/validation completion. |
| `CLIENT_CATALOG_STALE` | The required capability is absent while the client catalog is stale or unobserved. | Refresh/reconnect the catalog; do not infer capability absence from the stale view. |
| `EFFECT_LANE_BLOCKED` | A material effect lacks a safe key/receipt path, or its outcome is uncertain. | Freeze only the effect lane and reconcile the exact effect key. |
| `RECOVERED` | Retry, reconnect, duplicate suppression, or effect reconciliation restored a usable result. | Continue on the normal path without manual re-check loops. |
| `HARD_EXTERNAL_BLOCKER` | Required evidence/readback/canonical state is unavailable without lowering quality. | Stop the dependent lane and preserve the causal frontier. |

Terminal results are short, typed, and actionable. `TRANSIENT_RETRYING` is an
internal transition hook rather than a terminal result, so the agent does not
need to perform `check -> retry -> inspect -> reconnect` itself.

## Retry safety

Every call declares one retry-safety class:

### `read_only`

Bounded retry is allowed for normalized retryable transport failures. A stable
operation key is optional but enables duplicate-delivery suppression.

### `idempotent`

Bounded retry is allowed only when the caller supplies a stable operation key.
The key scopes a bounded local receipt cache and must represent the same logical
operation across attempts.

### `effectful`

The call is rejected before dispatch unless it supplies:

- an exact effect key; and
- an authoritative `reconcileEffect` route.

After dispatch, timeout, disconnect, missing output, or response loss never
causes blind replay. The supervisor first reconciles the exact effect key:

- `succeeded`: return `RECOVERED` from the authoritative receipt;
- `not_applied`: retry the same effect key only within the remaining bounded
  budget;
- `terminal_failure`: stop and expose the terminal receipt;
- `indeterminate`: return `EFFECT_LANE_BLOCKED`.

An explicitly proven pre-dispatch failure with backend outcome `not_started` may
be retried. Unknown dispatch state is treated conservatively.

The recovery receipt exposes the equivalent uppercase safety classes
`READ_ONLY`, `IDEMPOTENT_EFFECT`, and `NON_IDEMPOTENT_EFFECT`. This classifies
retry semantics; it does not grant effect authority.

## Typed session and subscription recovery

Legacy stale-session recovery is deliberately narrow. A generic timeout,
disconnect, HTTP 404, authentication error, or protocol-negotiation failure
cannot invoke the recreation callback. The exact typed stale-session signal may
recreate the client and transport once for the same logical call, then retry
within the remaining shared budget. A second stale-session signal stops instead
of creating an unbounded recreation loop.

Modern subscription recovery is a separate path. A `subscription_closed` fault
may trigger bounded re-listen. Recovery is accepted only when the adapter also
performs a forced catalog refetch and returns equal expected/observed SHA-256
fingerprints. Mismatch returns `CLIENT_CATALOG_STALE`; it does not open a
network circuit and does not authorize use of the old catalog.

## Capability and quality policy

Capability degradation does not authorize epistemic or safety degradation.

- Missing research capability when fresh evidence is required returns
  `HARD_EXTERNAL_BLOCKER`.
- Missing validation readback prevents any validation claim.
- Missing canonical state needed for mutation blocks that mutation.
- Missing publication/effect transport freezes only the effect lane.
- Stale catalog plus a missing required capability returns
  `CLIENT_CATALOG_STALE` rather than falsely declaring the capability absent.
- A declared quality-equivalent fallback remains a typed option; availability
  alone does not cause implicit rerouting. The caller must explicitly select the
  policy route.

## Retry budget and backoff

The default policy is:

- at most three primary attempts;
- per-attempt timeout of 30 seconds;
- exponential backoff from 100 ms, capped at two seconds;
- 20 percent jitter;
- at most two reconnect attempts;
- at most two read-only effect-reconciliation attempts;
- a shared token-bucket retry budget.

Callers may narrow these bounds. They may not obtain material-effect retry
authority by increasing them.

Retries are performed at this single supervisor layer. This avoids multiplicative
retry storms when the SDK, proxy, backend, and model each retry independently.

## Circuit breaker

Circuit state uses a composite key:

```text
caller circuit namespace
  + endpoint
  + protocol era
  + backend generation
  + normalized failure class
```

This prevents a host-catalog mismatch, application-level tool error, or old
backend generation from opening the network circuit for a healthy current
generation. Authentication failures, unsupported protocol revisions,
tool-level `isError`, caller cancellation, and terminal effect receipts do not
trip transport circuits. Capability/catalog gates are evaluated before circuit
admission.

The breaker implements closed, open, and half-open states:

- consecutive failures open the circuit at the configured threshold;
- repeated identical normalized failures can open it earlier;
- open circuits reject calls without transport dispatch;
- one half-open probe is admitted after cooldown;
- a successful probe closes the circuit;
- a failed probe reopens it.

Effect uncertainty remains an effect-key problem even when a transport circuit
also opens. A breaker never proves an effect succeeded or failed.

## Output usability

The generic assessor rejects:

- `null` or `undefined` results;
- empty strings;
- empty MCP content with no structured result;
- results containing only empty text.

The official client adapter additionally validates `tools/list` descriptor shape
and delegates `tools/call` structured output validation to the official SDK.
`tools/call` results with `isError: true` are classified as application-level
tool failures even when HTTP, JSON-RPC, and MCP transport layers succeeded.
They are non-retryable by default; only an explicit domain assessor may mark a
specific application error class transient.

Semantic truncation cannot be inferred generically. Validation, research, and
domain-specific tools should provide an `assessOutput` function that checks
expected schema, terminal markers, count/digest/readback evidence, or other
tool-specific completeness conditions. Without that evidence the supervisor does
not claim validation.

## Duplicate suppression and receipts

The supervisor maintains bounded, expiring local caches keyed by:

- `backendRef + toolRef + operationKey`; and
- `backendRef + toolRef + deliveryId`.

These caches suppress duplicate host delivery and same-runtime replay. They are
operational evidence only, not canonical effect authority. Material effects still
rely on the authoritative effect-owner receipt route, especially after process
restart or cache expiry.

## Reliability metrics

`McpTransportSupervisor.metrics()` exposes:

- operation calls and productive operations;
- successful operation rate;
- primary attempts and retries;
- p50, p95, and maximum operation latency;
- timeout/drop rate;
- missing-output rate;
- retries per productive operation;
- recovery action success rate;
- recovery/ceremony calls per productive call;
- time lost to infrastructure recovery;
- false retries prevented;
- duplicate deliveries and duplicate effects prevented;
- circuit trips/rejections;
- capability and effect-lane blocks.

The current values are candidate/harness measurements. Production SLOs require
the host/runtime adapter to emit these snapshots into the existing observability
plane.

Suggested initial canary objectives, to be calibrated from real traffic:

- no duplicate material effects in injected or canary uncertainty cases;
- 100 percent fail-closed behavior for indeterminate effects;
- at least 99 percent automatic recovery for a single injected transient failure;
- zero validation/research success claims from empty or truncated output;
- fewer than 0.25 recovery/ceremony calls per productive call during healthy
  steady state;
- bounded p95 recovery latency within the configured retry horizon.

These are rollout objectives, not production measurements from this source-only
candidate.

## Fault-injection harness

`McpReliabilityFaultHarness` provides deterministic scripted scenarios for:

| Required failure | Harness scenario |
| --- | --- |
| Timeout before response | `timeout_before_response` |
| Disconnect during call | `disconnect_during_call` |
| Backend success, response lost | `backend_success_response_lost` |
| Empty output | `empty_output` |
| Truncated output | `truncated_output` |
| Duplicate delivery | `duplicate_delivery` |
| Delayed response | `delayed_response` |
| Backend restart | `backend_restart` |
| Stale connection/session | `stale_connection` |
| Exact legacy unknown session | `legacy_unknown_session` |
| Closed modern subscription | `subscription_closed` |
| MCP tool application error | `tool_result_error` |
| Cancellation after possible dispatch | `cancelled_after_dispatch` |
| Partial tool availability | `partial_tool_availability` plus capability policy |
| Indeterminate effect result | `indeterminate_effect_result` |

The tests prove:

- safe calls retry only within bounds;
- reconnect is automatic when an adapter supplies the lifecycle hook;
- response loss after backend effect success returns from the exact receipt and
  does not execute the effect twice;
- empty and truncated outputs cannot become successful results;
- duplicate operation/delivery processing is suppressed;
- repeated equivalent failures trip the breaker;
- stale catalogs and partial capabilities produce typed states;
- research, validation, canonical mutation, and effect lanes fail closed;
- retry-budget exhaustion stops further transport dispatch;
- logical and per-attempt identities remain distinct across recovery;
- exact legacy stale-session recreation occurs at most once per logical call;
- subscription recovery requires a matching forced-refetch fingerprint;
- non-transient `isError` results do not cause automatic replay;
- post-dispatch cancellation of a material call enters effect reconciliation;
- circuit keys isolate endpoint, protocol era, backend generation, and failure
  class;
- one bounded recovery receipt consolidates all attempt evidence without raw
  response content.

## Integration in this candidate

Source files:

- `src/mcp-transport-supervisor.ts`: policy engine, retry budget, circuit breaker,
  receipts, effect reconciliation, typed results, metrics;
- `src/mcp-transport-supervisor-client.ts`: adapter around the official MCP
  `Client.listTools()` and `Client.callTool()` APIs;
- `src/mcp-transport-supervisor-fault-harness.ts`: deterministic fault injector;
- `src/mcp-transport-supervisor.test.ts`: reliability and negative-path tests.
- `scripts/run-mcp-transport-reliability-fault-matrix.mjs`: deterministic
  report generator using schema
  `zes.mcp-transport-reliability-fault-report.v2`.

`probeToolSurface()` now uses `SupervisedMcpClient.listTools()` and records the
supervisor result/metrics in its probe envelope. This is a real official MCP
client consumer, not a mock-only library integration. The probe uses in-memory
transport and therefore validates integration shape, not production network SLOs.

The existing live DevSpace MCP server remains unchanged. Server-side session
cleanup and turn-continuity advisory logic remain separate:

- session cleanup owns idle transport lifecycle;
- turn continuity detects rising instability and preserves a safe landing;
- this supervisor owns bounded client-call repair and typed failure semantics.

## Production adoption gates

Before live Nexus or a ChatGPT host adopts the supervisor:

1. Reconcile the candidate with current `owner/main` and the published Stable ABI.
2. Bind a real host/client reconnect function that creates a fresh session after
   the exact typed legacy stale-session response and respects native SSE
   resumption where available. Generic 404 must remain an HTTP failure.
3. Bind subscription re-listen to a forced complete catalog refetch and
   fingerprint comparison.
4. Define explicit retry safety and operation/effect keys for every exposed call.
5. Add tool-specific output completeness assessors for research, validation, and
   material-effect tools.
6. Route effect reconciliation to authoritative owner receipts, not the local
   supervisor cache.
7. Export metrics to the existing execution observability plane and establish a
   pre-canary baseline.
8. Run the same fault matrix through the actual reverse proxy and host transport.
9. Deploy through the rightful runtime/effect authority with Legacy left intact.

No step above is authorized or claimed complete by this candidate.

## Research references

- MCP Streamable HTTP transport specification, protocol version 2025-11-25:
  <https://modelcontextprotocol.io/specification/2025-11-25/basic/transports>
- Installed official TypeScript SDK 1.29.0 source:
  `node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js`,
  `shared/protocol.d.ts`, and `server/streamableHttp.d.ts`.
- Isolated MCP upstream/ChatGPT-host compatibility lab commit
  `444ee06b175277fb1db2c74fecd63df10a2d5419`, especially
  `experiments/mcp-compatibility-lab/handoff/transport-supervisor-requirements.json`
  and its dated results. The lab candidate remains independently owned and
  unpublished at the time of this source integration.
- Official TypeScript SDK repository:
  <https://github.com/modelcontextprotocol/typescript-sdk>
- AWS Builders' Library, timeouts/retries/backoff with jitter:
  <https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/>
- AWS Builders' Library, safe retries with idempotent APIs:
  <https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/>
- Microsoft Azure Architecture Center, circuit breaker pattern:
  <https://learn.microsoft.com/azure/architecture/patterns/circuit-breaker>
