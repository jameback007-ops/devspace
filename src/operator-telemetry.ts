import { createHash, randomUUID } from "node:crypto";
import { ROOT_CONTEXT, SpanKind, SpanStatusCode, type Attributes, type Span, type SpanContext } from "@opentelemetry/api";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BasicTracerProvider, BatchSpanProcessor, type SpanExporter } from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import type { ExecutionObservationHandle } from "./execution-observability.js";

const NUMBERS = new Set([
  "sessionId", "outputSessionId", "yieldTimeMs", "maxOutputTokens", "waitTimeMs",
  "afterSequence", "nextSequence", "cmdLength", "commandLength", "patternLength",
  "queryLength", "patchLength", "promptLength", "charactersWritten", "exitCode",
  "wallTimeMs", "outputDeltaBytes", "outputTotalBytes", "outputEventCount",
  "outputSequenceStart", "outputSequenceEnd", "additions", "removals", "fileReceiptCount",
]);
const BOOLEANS = new Set(["tty", "pollOnly", "interruptRequested", "running", "outputTruncated", "outputComplete", "gap", "hasMore"]);
const DIGESTS = new Set(["cmdDigestSha256", "commandDigestSha256", "patternDigestSha256", "queryDigestSha256", "patchDigestSha256", "outputDeltaDigestSha256", "outputDigestSha256"]);
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

// Explicit projection, never a spread of input, result, exception or SDK resource.
export function operatorAttributes(detail: Record<string, unknown>): Attributes {
  const attributes: Attributes = {};
  for (const [key, value] of Object.entries(detail)) {
    if (NUMBERS.has(key) && typeof value === "number" && Number.isSafeInteger(value)) attributes[`zes.${key}`] = value;
    else if (BOOLEANS.has(key) && typeof value === "boolean") attributes[`zes.${key}`] = value;
    else if (DIGESTS.has(key) && typeof value === "string" && /^[a-f0-9]{64}$/.test(value)) attributes[`zes.${key}`] = value;
    else if (["workspaceId", "processRef"].includes(key) && typeof value === "string" && /^(ws_[a-f0-9]{10}|prc_[a-f0-9]{32})$/.test(value)) attributes[`zes.${key}`] = value;
  }
  // Path equality is useful for repeated-read diagnosis; paths themselves can be sensitive.
  if (typeof detail.path === "string") attributes["zes.path_sha256"] = digest(detail.path);
  return attributes;
}

export class OperatorTelemetry {
  private readonly active = new Map<string, Span>();
  private readonly processes = new Map<string, SpanContext>();
  private readonly tracer;
  private readonly counters = { started: 0, ended: 0, capacityDropped: 0, instrumentationErrors: 0, exportAccepted: 0, exportFailed: 0 };

  constructor(private readonly provider: BasicTracerProvider, private readonly maxActive = 4096) {
    this.tracer = provider.getTracer("zes.operator.nexus", "1");
  }

  static fromEnvironment(env: NodeJS.ProcessEnv = process.env): OperatorTelemetry | undefined {
    const endpoint = env.ZES_OPERATOR_OTLP_ENDPOINT;
    if (!endpoint) return undefined;
    const url = new URL(endpoint);
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
      || url.username || url.password || url.search || url.hash || url.pathname !== "/v1/traces") {
      throw new Error("ZES_OPERATOR_OTLP_ENDPOINT must name the local operator Collector /v1/traces endpoint.");
    }
    const exporter = new OTLPTraceExporter({ url: endpoint, timeoutMillis: 3000 });
    let observer: OperatorTelemetry;
    const counted: SpanExporter = {
      export: (spans, callback) => exporter.export(spans, result => {
        if (observer) observer.counters[result.code === 0 ? "exportAccepted" : "exportFailed"] += spans.length;
        callback(result);
      }),
      shutdown: () => exporter.shutdown(),
    };
    const provider = new BasicTracerProvider({
      resource: resourceFromAttributes({
        "service.name": "zes-nexus-operator",
        "service.instance.id": randomUUID(),
        "service.version": env.DEVSPACE_MCP_SERVER_VERSION ?? "unbound",
        "openinference.project.name": "zes-operator-chatgpt",
        "zes.source.commit": /^[a-f0-9]{40}$/.test(env.DEVSPACE_TOOL_SURFACE_SOURCE_COMMIT ?? "") ? env.DEVSPACE_TOOL_SURFACE_SOURCE_COMMIT! : "unbound",
        "zes.observation.boundary": "nexus_mcp_only",
      }),
      spanProcessors: [new BatchSpanProcessor(counted, {
        maxQueueSize: 4096, maxExportBatchSize: 128,
        scheduledDelayMillis: 1000, exportTimeoutMillis: 4000,
      })],
      spanLimits: { attributeCountLimit: 80, attributeValueLengthLimit: 256, eventCountLimit: 8, linkCountLimit: 1 },
    });
    observer = new OperatorTelemetry(provider);
    return observer;
  }

  start(handle: ExecutionObservationHandle, adapter: string, detail: Record<string, unknown>): void {
    try {
      const key = this.key(handle);
      if (this.active.has(key)) return;
      if (this.active.size >= this.maxActive) { this.counters.capacityDropped++; return; }
      const processRef = detail.processRef;
      const linked = typeof processRef === "string" ? this.processes.get(processRef) : undefined;
      const span = this.tracer.startSpan(`mcp.${handle.toolName}`, {
        kind: SpanKind.SERVER, startTime: handle.startedAtMs,
        links: linked ? [{ context: linked }] : [],
        attributes: {
          ...operatorAttributes(detail),
          "openinference.span.kind": "TOOL", "tool.name": handle.toolName,
          "session.id": handle.scopeRef,
          "zes.host.adapter": ["openai", "anthropic", "generic"].includes(adapter) ? adapter : "other",
          "zes.event.sequence": handle.sequence,
          "zes.event.id": digest(`${handle.scopeRef}:${handle.sequence}:${handle.startedAtMs}`),
          "zes.observation.boundary": "nexus_mcp_only",
          "zes.model_internals_observed": false,
        },
      }, ROOT_CONTEXT);
      this.active.set(key, span);
      this.counters.started++;
    } catch { this.counters.instrumentationErrors++; }
  }

  finish(handle: ExecutionObservationHandle, outcome: string, detail: Record<string, unknown>, completedAtMs: number, errorKind?: string): void {
    const key = this.key(handle);
    const span = this.active.get(key);
    if (!span) return;
    this.active.delete(key);
    try {
      span.setAttributes(operatorAttributes(detail));
      span.setAttribute("zes.tool.outcome", outcome);
      span.setAttribute("zes.task.outcome", "not_assessed");
      if (errorKind) {
        span.setAttribute("zes.error.kind_sha256", digest(errorKind));
        if (/^(Error|TypeError|RangeError|McpError|ProcessInputError|ProcessOutputError)(:(E[A-Z0-9_]+|PROCESS_OUTPUT_[A-Z_]+|-?\d+))?$/.test(errorKind)) span.setAttribute("error.type", errorKind);
      }
      // This status describes MCP invocation only. A non-zero process exit is a separate attribute.
      span.setStatus({ code: outcome === "succeeded" ? SpanStatusCode.OK : SpanStatusCode.ERROR });
      const processRef = detail.processRef;
      if (handle.toolName === "write_stdin" && typeof processRef === "string") {
        const source = this.processes.get(processRef);
        if (source) span.addLink({ context: source });
      }
      if (handle.toolName === "exec_command" && typeof processRef === "string" && /^prc_[a-f0-9]{32}$/.test(processRef)) {
        if (this.processes.size >= 4096) this.processes.delete(this.processes.keys().next().value!);
        this.processes.set(processRef, span.spanContext());
      }
      span.end(Math.max(handle.startedAtMs, completedAtMs));
      this.counters.ended++;
    } catch { this.counters.instrumentationErrors++; span.end(); }
  }

  snapshot() {
    return { enabled: true, ...this.counters, active: this.active.size,
      deliveryBoundary: "exportAccepted_means_collector_ack_not_phoenix_query_visibility",
      unaccountedEnded: this.counters.ended - this.counters.exportAccepted - this.counters.exportFailed,
      unaccountedMeaning: "buffered_or_inflight_or_sdk_dropped_not_proof_of_delivery",
      coverage: "Nexus-audited MCP invocations only; no WebChat transcript, hidden reasoning, tokens or pre-handler failures" };
  }
  async forceFlush(): Promise<void> { await this.provider.forceFlush(); }
  async shutdown(): Promise<void> {
    for (const span of this.active.values()) {
      span.setAttribute("zes.tool.outcome", "observer_shutdown_incomplete");
      span.setAttribute("zes.task.outcome", "not_assessed");
      span.end();
      this.counters.ended++;
    }
    this.active.clear(); this.processes.clear();
    await this.provider.shutdown();
  }
  private key(handle: ExecutionObservationHandle): string { return `${handle.scopeRef}:${handle.sequence}:${handle.startedAtMs}`; }
}
