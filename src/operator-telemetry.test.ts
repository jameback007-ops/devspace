import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { parse } from "yaml";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BasicTracerProvider, SimpleSpanProcessor, InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { OperatorTelemetry, operatorAttributes } from "./operator-telemetry.js";
import { ExecutionScopeManager } from "./execution-observability.js";
import { ProcessSessionManager } from "./process-sessions.js";
import { executionScopeIdentity } from "./request-meta.js";

function fixture(maxActive?: number) {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  return { exporter, observer: new OperatorTelemetry(provider, maxActive) };
}
const handle = { scopeRef: "0123456789abcdef", sequence: 1, startedAtMs: 1000, toolName: "exec_command" };

test("operator projection never exports raw content or paths", () => {
  const attributes = operatorAttributes({ cmd: "SECRET_COMMAND", prompt: "SECRET_PROMPT", output: "SECRET_OUTPUT", path: "SECRET_PATH", error: "SECRET_EXCEPTION", files: [{ path: "SECRET_FILE" }], cmdLength: 14, exitCode: 7, running: false });
  assert.doesNotMatch(JSON.stringify(attributes), /SECRET/);
  assert.match(String(attributes["zes.path_sha256"]), /^[a-f0-9]{64}$/);
  assert.equal(attributes["zes.exitCode"], 7);
  assert.equal(attributes["zes.running"], false);
});

test("tool success, process exit and task acceptance remain separate; duplicate finish does not re-export", async () => {
  const { observer, exporter } = fixture();
  observer.start(handle, "openai", { cmdLength: 20 });
  observer.start(handle, "openai", {});
  observer.finish(handle, "succeeded", { exitCode: 7, running: false, output: "SECRET" }, 1010);
  observer.finish(handle, "succeeded", {}, 1011);
  await observer.forceFlush();
  const spans = exporter.getFinishedSpans();
  assert.equal(spans.length, 1);
  assert.equal(spans[0].status.code, 1);
  assert.equal(spans[0].attributes["zes.exitCode"], 7);
  assert.equal(spans[0].attributes["zes.task.outcome"], "not_assessed");
  assert.equal(spans[0].attributes["session.id"], handle.scopeRef);
  assert.doesNotMatch(JSON.stringify(spans[0].attributes), /SECRET|token_count/);
  await observer.shutdown();
});

test("error metadata remains scoped and private messages are never recorded", async () => {
  const { observer, exporter } = fixture();
  observer.start(handle, "secret-host-string", {});
  observer.finish(handle, "error", { error: "SECRET" }, 1010, "ProcessInputError:EPIPE");
  await observer.forceFlush();
  const span = exporter.getFinishedSpans()[0];
  assert.equal(span.status.code, 2);
  assert.equal(span.attributes["error.type"], "ProcessInputError:EPIPE");
  assert.equal(span.attributes["zes.host.adapter"], "other");
  assert.equal(span.events.length, 0);
  await observer.shutdown();
});

test("process observation links reference the originating span, not a fabricated model parent", async () => {
  const { observer, exporter } = fixture();
  const processRef = `prc_${"a".repeat(32)}`;
  observer.start(handle, "openai", {});
  observer.finish(handle, "succeeded", { processRef, running: true }, 1010);
  const poll = { ...handle, toolName: "process_output", sequence: 2, startedAtMs: 1020 };
  observer.start(poll, "openai", { processRef });
  observer.finish(poll, "succeeded", {}, 1030);
  await observer.forceFlush();
  const [a, b] = exporter.getFinishedSpans();
  assert.equal(b.links[0].context.spanId, a.spanContext().spanId);
  assert.equal(b.parentSpanContext, undefined);
  await observer.shutdown();
});

test("capacity is bounded and shutdown is explicitly incomplete", async () => {
  const { observer, exporter } = fixture(1);
  observer.start(handle, "openai", {});
  observer.start({ ...handle, sequence: 2 }, "openai", {});
  assert.equal(observer.snapshot().capacityDropped, 1);
  assert.equal(observer.snapshot().active, 1);
  observer.finish(handle, "interrupted", {}, 1010);
  await observer.forceFlush();
  assert.equal(exporter.getFinishedSpans().length, 1);
  await observer.shutdown();
});

test("disabled instrumentation has no provider; configured destinations cannot silently export outside local collector", () => {
  assert.equal(OperatorTelemetry.fromEnvironment({}), undefined);
  for (const endpoint of ["https://example.com/v1/traces", "http://127.0.0.1:4318/bad", "http://a:b@127.0.0.1/v1/traces", "http://127.0.0.1/v1/traces?token=secret"]) {
    assert.throws(() => OperatorTelemetry.fromEnvironment({ ZES_OPERATOR_OTLP_ENDPOINT: endpoint }));
  }
});

test("real execution audit emits one content-safe span without mutating tool outcome", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "zes-operator-test-"));
  const { observer, exporter } = fixture();
  const processes = new ProcessSessionManager();
  const manager = new ExecutionScopeManager({ enabled: true, retentionMs: 86400000, idleAfterMs: 60000, maxEventsPerScope: 100 }, stateDir, processes, { operatorTelemetry: observer });
  t.after(async () => { manager.close(); processes.shutdown(); await observer.shutdown(); await rm(stateDir, { recursive: true, force: true }); });
  const identity = executionScopeIdentity({ "openai/session": "PRIVATE_HOST_SESSION" });
  const observed = manager.beginTool(identity, "exec_command", { workspaceId: "ws_0123456789", cmd: "SECRET_COMMAND" });
  manager.finishTool(observed, "succeeded", { response: { structuredContent: { output: "SECRET_RESULT", exitCode: 7, running: false, outputTotalBytes: 13 } } });
  await observer.forceFlush();
  const span = exporter.getFinishedSpans()[0];
  assert.equal(span.attributes["zes.exitCode"], 7);
  assert.equal(span.attributes["zes.outputTotalBytes"], 13);
  assert.equal(span.attributes["zes.tool.outcome"], "succeeded");
  assert.doesNotMatch(JSON.stringify(span.attributes), /PRIVATE_HOST_SESSION|SECRET/);
});

test("trace admission cannot be acknowledged by volatile batch ahead of the persistent queue", async () => {
  const config = parse(await readFile(new URL("../examples/operator-observability/collector.yaml", import.meta.url), "utf8"));
  for (const lane of ["codex", "nexus"]) {
    const pipeline = config.service.pipelines[`traces/${lane}`];
    assert.ok(pipeline.processors.includes(`transform/${lane}`));
    assert.ok(!pipeline.processors.some((name: string) => name.split("/")[0] === "batch"));
    assert.ok(pipeline.exporters.includes("otlp_http/phoenix"));
  }
  const exporter = config.exporters["otlp_http/phoenix"];
  assert.equal(exporter.sending_queue.storage, "file_storage");
  assert.equal(config.extensions.file_storage.fsync, true);
  assert.equal(exporter.sending_queue.batch.sizer, "items");
  assert.equal(exporter.sending_queue.batch.min_size, 128);
  assert.equal(exporter.sending_queue.batch.max_size, 256);
});

test("stored traces use bounded queues and report overflow rather than a false success", async () => {
  const config = parse(await readFile(new URL("../examples/operator-observability/collector.yaml", import.meta.url), "utf8"));
  const exporter = config.exporters["otlp_http/phoenix"];
  assert.equal(exporter.sending_queue.queue_size, 2048);
  assert.equal(exporter.sending_queue.block_on_overflow, false);
  assert.equal(exporter.retry_on_failure.max_elapsed_time, "0s");
  assert.ok(config.service.telemetry.metrics.readers.length > 0);
  // Logs/metrics are explicit diagnostic file streams, not falsely presented
  // as durable Phoenix traces or included in a unique-command count.
  assert.deepEqual(config.service.pipelines["logs/codex"].exporters, ["file/logs"]);
  assert.deepEqual(config.service.pipelines["metrics/codex"].exporters, ["file/metrics"]);
});
