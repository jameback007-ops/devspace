# Operator observation: Codex and ChatGPT through Nexus

This is the operator/workforce observation slice for audit and improvement. It is
not the Product-wide observability authority, a replacement for LangSmith, an
execution scheduler, or a source of accepted business outcomes.

## Composition and actual coverage

Native Codex OTel uses its separate logs, traces and metrics exporters. The
`examples/operator-observability/codex-otel.toml` table targets a localhost native
Collector. Merge it only into the actual producer's config, preserving other
settings. Running App Servers retain startup configuration: configured future
launches do not establish uptake by existing processes. Do not restart active
worker turns just to enable this observer.

Nexus's optional `ZES_OPERATOR_OTLP_ENDPOINT=http://127.0.0.1:14319/v1/traces`
activates the native JS OTel SDK on existing audited MCP call boundaries. It
exports no tool arguments, result body, prompt, exception message, patches or raw
paths. Existing opaque scope IDs become Phoenix session IDs; path hashes support
same-path comparison without exposing names. Actual process refs link subsequent
control/observation to the originating exec span. No fabricated model parent is
introduced. The other two ZES MCPs and ChatGPT's built-in tools are not covered by
this Nexus instrumentation. Instrument them at their own admitted boundaries if
that becomes useful; do not claim their activity from Nexus traces.

ChatGPT tokens, private reasoning, provider generation, host approval/safety
failures before the handler and silent-interval model state remain unobserved.
Native Codex retains richer inner-tool and usage events, subject to version and
field availability. The current collector deliberately drops linked Codex spans
until a supported link-attribute minimization policy is qualified. Retained spans
can have missing parents and no allowed events; missing data is not zero work.

Phoenix routes by `openinference.project.name`, not `project.name`:
`zes-operator-codex` and `zes-operator-chatgpt`. Native log/trace copies of a Codex
call are not separate executions. Tool success, process exit, expected negative
test, accepted task outcome and deployment adoption are different claims.

## Native storage, loss and network boundary

Collector 0.160.0 performs allowlist filtering before file exports or the native
`file_storage` sending queue. Native batching, retry and bounded queues are used;
no custom collector or transcript reconstruction service is added. Logs and
metrics are retained as native OTLP JSONL; Phoenix receives traces. They are not
converted into fake spans just to make a dashboard look complete.

JS SDK: queue4096, batch128,1s scheduling,3s exporter timeout. The MCP request does
not wait for delivery. `/readyz.operatorTelemetry` exposes started/ended/export
acknowledged/failed and unaccounted counts. Collector acknowledgement is not
Phoenix query visibility. SDK queue overflow, process crash, storage exhaustion
and retry expiry can lose observations. Native Collector's queue is2048 batches,
retry10min. Monitor its localhost18888 Prometheus exporter for queue/send/drop
counters; do not interpret configured persistence as exactly-once delivery.

Rotated files are bounded by size/backup count and7-day rotation policy. Phoenix
has a14-day default retention policy. Retention is not disk quota; peak workload,
database size, deletion lag and native compaction need operated follow-through.

The example units use dedicated DynamicUsers, separate private StateDirectories,
memory/cgroup limits and localhost IP allow/deny rules. Phoenix20.8.0's native gRPC
listener binds `[::]` independently of `PHOENIX_HOST`; localhost HTTP configuration
alone is NOT network isolation. Apply and verify the units' IP policy (or a
separately qualified authenticated/private deployment) before enabling real
producers. Do not treat policy source files as deployed network protection.
The UI is not published through Caddy. Use an authenticated SSH tunnel after
admission rather than exposing an unauthenticated analysis endpoint publicly.

## Use native clients, not another dashboard

Pinned operator clients: `@arizeai/phoenix-cli@1.17.0` and
`@arizeai/phoenix-mcp@4.3.7` installed under
`/opt/zes-operator-observability/native` in the operated qualification environment.
The CLI executable is `native/node_modules/.bin/px`; Python is `venv/bin/python`.

```sh
px span list --endpoint http://127.0.0.1:16006 --project zes-operator-chatgpt \
  --last-n-minutes 60 --limit 100 --format raw --no-progress
px span list --endpoint http://127.0.0.1:16006 --project zes-operator-chatgpt \
  --attribute zes.exitCode:7 --format raw --no-progress
px trace get TRACE_ID --endpoint http://127.0.0.1:16006 --include-annotations
```

The native Phoenix MCP supports trace/session queries, annotation configs,
datasets and experiments. Its installation alone does not register it with any
host or ToolHive receiver. Keep its capabilities; connect it using the existing
capability fabric rather than add a generic privileged RPC proxy to Nexus.

`scripts/operator-audit.py --project zes-operator-chatgpt --limit 200` makes a
bounded native SDK query and reports distinct span IDs, per-tool timing and
returned bytes, nonzero process exits and repeated path-hash candidates. It
excludes synthetic sessions by default. This is a query/aggregation, not an
optimizer or autonomous correctness judgment. Investigate examples with native
evidence, annotate a scoped explanation, propose an intervention, and qualify the
changed behavior against contrasting cases. Fewer calls alone is not improvement.

## Qualification and current limits

`src/operator-telemetry.test.ts` is in the normal package test lifecycle. It
tests content minimization, duplicate finish, error scope, process links,
bounded capacity, disabled operation and actual execution-audit integration.
`scripts/qualify-operator-telemetry.py` sends marked synthetic protobuf traces and
logs through both local receivers, retrieves the exact span IDs with Phoenix's
native SDK and checks the private canary does not survive API/native-file
persistence. It creates no model call and never reads a real conversation.

On2026-09-08, the first synthetic test exposed incorrect project routing;
the corrected native end-to-end test retrieved both exact spans and passed the
content canary checks. Native CLI readback also worked. This does not certify
full future-data redaction or quantify operator performance.

One ephemeral native Codex run then executed an invented two-command fixture,
returning CLI exit7 and0. Its native tool-event trace was retrieved by exact span
ID from Phoenix, content canaries were absent, and account config was unchanged.
The4 native tool-result spans were not4 independent user commands: nested exec
and inner command boundaries must remain distinguishable. The863 spans in the
window are structural observations, not863 tasks or a measure of wasted work.
The native CLI wrote and read back one explicit synthetic-control annotation;
it did not assign correctness to a real worker.

Real producer enablement is a separate outcome. The network-isolation application
request was stopped by the host before execution. As of this source cut, no
default Codex config, running App Server or active Nexus exporter is enabled for
this pipeline. Native queue restart/outage tests, actual producer-to-query
correlation, longitudinal value and operator-wide coverage are still open.
Do not reroute a host-refused action via another connector or this observer.

The newly created operator Phoenix/Collector services were stopped after the
controlled tests (native stop returned0); no real worker was feeding them and
their retained state was not deleted. Their boot enablement was not performed.
The proposed native Nexus SDK-to-Phoenix export/readback request was also stopped
by the host before execution, so only its unit/audit-boundary tests, not a live
ChatGPT export, are established. Existing production Nexus and Codex remain on
their prior configurations. Resume admission with fresh allowed evidence rather
than interpreting these source/examples as an already-operating monitor.

## Sources

- https://developers.openai.com/codex/config-advanced
- https://developers.openai.com/codex/config-reference
- https://arize.com/docs/phoenix/tracing/how-to-tracing/setup-tracing/setup-projects
- https://arize.com/docs/phoenix/integrations/phoenix-mcp-server
- https://arize.com/docs/phoenix/sdk-api-reference/typescript/arizeai-phoenix-cli
- https://opentelemetry.io/docs/collector/resiliency/
- Retained Cleanroom `stage2/capability-productization/stewardship/phoenix/`
  and `native-producer/`: exact prior producer mappings, failure fixtures and
  attribution limitations. This implementation does not rewrite those receipts.
