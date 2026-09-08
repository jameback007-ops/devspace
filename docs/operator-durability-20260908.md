# Operator trace durability and truthful audit — 2026-09-08

This continuation repairs the already-published `a4c062b` trace composition.
It changes native Collector configuration and the existing Phoenix audit query,
not live worker configuration, network policy, Caddy or an execution permission.
All fault workloads are invented; there are no new model calls or raw rollouts.

## Reproduced loss, not hypothetical configuration debt

The original config placed the pipeline `batch` processor before the exporter
WAL. A disposable Collector0.160.0 acknowledged six spans from both existing
ingress pipelines. The test killed that exact child within about11ms from the
start of submission, before the1s batch timeout, and reopened the same native
queue. The healthy test sink received none of the six during the bounded4s
recovery window. The downstream had not received any attempted export.

Baseline config SHA256:
`e0e518d49553fcc66f34573a0a642ddb70b506b2ffc01725a8ca49765f0b362b`.

The repair uses native `sending_queue.batch` after persistent admission, enables
file_storage fsync, and avoids time-expiring traces already on disk during a
temporary backend outage. The2048-request queue remains bounded and refuses
overflow; no extra queue daemon, broker, transcript parser or custom exporter is
introduced. A disk error, permanent downstream rejection, SDK loss or exhausted
queue can still lose data. fsync has an I/O cost; this is not a throughput benchmark
or a proof against power loss.

Corrected config SHA256:
`8d411375df06e92c8aa2941173dad03d55a87085eb02178840ba9664a34e1c33`.
Native binary SHA256:
`8524ac54f6e1d4d00d9ba5eea91daadec2ebc31e4da80db9c17eba2e859ecdd4`.

## Operated native fault cases

`scripts/qualify-operator-durability.py` changes only endpoints/storage locations
and the intentionally tiny queue for overflow. It retains source filter/transform
rules, sends protobuf OTLP, validates the native configuration, and stops only
the Collector and protocol sink it created. The sink is NOT Phoenix.

| Case | Actual result |
| --- | --- |
| SIGKILL after acknowledgement, then reopen WAL |6acknowledged /6recovered, no missing identity |
| HTTP503 downstream, then recovery without resubmitting |2failed attempts;6/6recovered on native retry |
| Queue reduced to2requests and1consumer |6spans admitted,18rejected; all6admitted survived restart |
| Sink accepts a batch but loses its acknowledgement |12deliveries,6unique span IDs;6duplicates |

Both source project identities survived. The private-content sentinel was absent
from downstream records and from the retained queue bytes inspected after the
crash cases. Each created Collector was terminal at test completion. This is
evidence for these controlled faults, not arbitrary sensitive-field sanitization,
production load, power loss, disk exhaustion, Phoenix ingestion or continuous use.

Retained native reports: `/tmp/zes-operator-durability-baseline-20260908/report.json`
and `/tmp/zes-operator-durability-queue-r2-20260908/report.json`. Intermediate
queue-r1 evidence remains separate. A missing response to an accepted export can
cause replay of the same span: do not count deliveries as commands or claim
exactly-once behavior from these tests.

The native fixture checks its generated span IDs and source project attributes;
the separate audit query uses the full trace-ID/span-ID pair. The fixture does
not prove parent/trace topology preservation through Phoenix.

## Audit repair

The old query treated any named span as a tool call, including `codex.native`
structural parents. Added regressions first reproduced three failed assertions
and two errors. The revised query separates attributed Nexus invocations, native
Codex tool-result event occurrences and other spans; it preserves duplicate and
conflicting-copy counts. A malformed bytes/exit/time measurement is visible rather
than crashing the query or manufacturing a successful command result.

Nine offline query tests and nine telemetry/config tests pass; both files remain
in the normal package test lifecycle. Native fault execution is explicit because
it requires an installed Collector and owns temporary OS processes. To reproduce
against a new candidate, use a NEW output directory and fresh fixture identities:

```sh
/opt/zes-operator-observability/venv/bin/python scripts/qualify-operator-durability.py \
  --collector /opt/zes-operator-observability/otelcol-contrib \
  --config examples/operator-observability/collector.yaml \
  --output /tmp/zes-operator-durability-NEW-GENERATION
```

## Still not activated

Phoenix/Collector service activation and the previously host-stopped network-policy
and Nexus-to-Phoenix requests are not retried here. No running Codex/App Server
or Nexus process is restarted. The new configuration is a tested source candidate
for later admitted deployment, not proof of ongoing actual ChatGPT/Codex capture.
The existing operator mission remains open through that real uptake.

## Upstream basis

- OpenTelemetry Collector exporterhelper0.160.0 README: native persistent queue,
  batch placement, bounded capacity, overflow and retry settings.
- Collector Contrib file_storage0.160.0 README: fsync and its performance cost.
- Exact external acquisition retained at research capture
  `e28b5991345d54fbf0e4c1b5d0e0611de39a7b920ee4e4bc7ad85d90173c5eaf`.
- https://opentelemetry.io/docs/collector/resiliency/
- https://github.com/open-telemetry/opentelemetry-collector/tree/v0.160.0/exporter/exporterhelper
- https://github.com/open-telemetry/opentelemetry-collector-contrib/tree/v0.160.0/extension/storage/filestorage
