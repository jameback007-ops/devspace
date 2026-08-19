import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import {
  McpTransportSupervisor,
  defaultMcpOutputAssessment,
  type McpFailureClass,
  type McpCallLane,
  type McpCapabilityPolicy,
  type McpEffectReconciliation,
  type McpEffectReconciliationContext,
  type McpOperationKind,
  type McpOutputAssessment,
  type McpReconnectContext,
  type McpRetryPolicy,
  type McpRetrySafety,
  type McpStaleSessionRecoveryContext,
  type McpSubscriptionRecoveryContext,
  type McpSubscriptionRecoveryResult,
  type McpSupervisedResult,
  type McpSupervisorTransition,
  type McpTransportIdentity,
  type McpTransportFault,
} from "./mcp-transport-supervisor.js";

export type McpClientLike = Pick<Client, "listTools" | "callTool">;

export type McpListToolsParams = Parameters<McpClientLike["listTools"]>[0];
export type McpListToolsResult = Awaited<
  ReturnType<McpClientLike["listTools"]>
>;
export type McpCallToolParams = Parameters<McpClientLike["callTool"]>[0];
export type McpCallToolResultSchema = Parameters<
  McpClientLike["callTool"]
>[1];
export type McpCallToolResult = Awaited<
  ReturnType<McpClientLike["callTool"]>
>;

export interface SupervisedMcpClientOptions {
  backendRef?: string;
  transportIdentity?: McpTransportIdentity;
  operationPrefix?: string;
  defaultTimeoutMs?: number;
  reconnect?: (context: McpReconnectContext) => Promise<void>;
  recreateLegacyClient?: (
    context: McpStaleSessionRecoveryContext,
  ) => Promise<McpClientLike>;
  recoverSubscription?: (
    context: McpSubscriptionRecoveryContext,
  ) => Promise<McpSubscriptionRecoveryResult>;
}

export interface SupervisedListToolsOptions {
  operationRef?: string;
  logicalCallId?: string;
  operationKey?: string;
  circuitKey?: string;
  circuitFailureClass?: McpFailureClass;
  transportIdentity?: McpTransportIdentity;
  subscriptionGeneration?: string;
  operationKind?: McpOperationKind;
  timeoutMs?: number;
  signal?: AbortSignal;
  requestOptions?: RequestOptions;
  capability?: McpCapabilityPolicy;
  retryPolicy?: Partial<McpRetryPolicy>;
  requiresCompletenessEvidence?: boolean;
  onTransition?: (transition: McpSupervisorTransition) => void;
  reconnect?: (context: McpReconnectContext) => Promise<void>;
  recoverStaleSession?: (
    context: McpStaleSessionRecoveryContext,
  ) => Promise<void>;
  recoverSubscription?: (
    context: McpSubscriptionRecoveryContext,
  ) => Promise<McpSubscriptionRecoveryResult>;
  assessOutput?: (
    raw: unknown,
  ) => McpOutputAssessment<McpListToolsResult>
    | Promise<McpOutputAssessment<McpListToolsResult>>;
  classifyError?: (
    error: unknown,
    context: { dispatched: boolean; callerAborted: boolean },
  ) => McpTransportFault;
}

export interface SupervisedCallToolOptions {
  operationRef?: string;
  logicalCallId?: string;
  operationKey?: string;
  idempotencyEvidenceRef?: string;
  effectKey?: string;
  lane: McpCallLane;
  retrySafety: McpRetrySafety;
  circuitKey?: string;
  circuitFailureClass?: McpFailureClass;
  transportIdentity?: McpTransportIdentity;
  timeoutMs?: number;
  signal?: AbortSignal;
  resultSchema?: McpCallToolResultSchema;
  requestOptions?: RequestOptions;
  capability?: McpCapabilityPolicy;
  retryPolicy?: Partial<McpRetryPolicy>;
  requiresCompletenessEvidence?: boolean;
  onTransition?: (transition: McpSupervisorTransition) => void;
  reconnect?: (context: McpReconnectContext) => Promise<void>;
  recoverStaleSession?: (
    context: McpStaleSessionRecoveryContext,
  ) => Promise<void>;
  reconcileEffect?: (
    context: McpEffectReconciliationContext,
  ) => Promise<McpEffectReconciliation<McpCallToolResult>>;
  assessOutput?: (
    raw: unknown,
  ) => McpOutputAssessment<McpCallToolResult>
    | Promise<McpOutputAssessment<McpCallToolResult>>;
  classifyError?: (
    error: unknown,
    context: { dispatched: boolean; callerAborted: boolean },
  ) => McpTransportFault;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requestOptions(
  existing: RequestOptions | undefined,
  signal: AbortSignal,
  timeoutMs: number | undefined,
): RequestOptions {
  return {
    ...existing,
    signal,
    ...(timeoutMs === undefined ? {} : { timeout: timeoutMs }),
  };
}

export function assessMcpListToolsOutput(
  raw: unknown,
): McpOutputAssessment<McpListToolsResult> {
  if (!isRecord(raw) || !Array.isArray(raw.tools)) {
    return {
      status: "indeterminate",
      reason: "MCP tools/list returned no schema-valid tools array.",
      evidenceRef: "mcp-sdk:tools-list-shape-missing",
    };
  }
  const invalidDescriptor = raw.tools.find((tool) =>
    !isRecord(tool)
    || typeof tool.name !== "string"
    || tool.name.trim().length === 0
    || !isRecord(tool.inputSchema));
  if (invalidDescriptor !== undefined) {
    return {
      status: "truncated",
      reason: "MCP tools/list contained an incomplete tool descriptor.",
      evidenceRef: "mcp-sdk:tool-descriptor-incomplete",
    };
  }
  return {
    status: "usable",
    value: raw as McpListToolsResult,
    completenessEvidenceRef: "mcp-sdk:tools-list-schema-valid",
  };
}

export function assessMcpCallToolOutput(
  raw: unknown,
): McpOutputAssessment<McpCallToolResult> {
  if (!isRecord(raw)) {
    return {
      status: "indeterminate",
      reason: "MCP tools/call returned no object result.",
      evidenceRef: "mcp-sdk:call-tool-result-shape-missing",
    };
  }
  if (raw.isError === true) {
    return {
      status: "tool_error",
      reason: "MCP tools/call returned an application-level error result.",
      evidenceRef: "mcp-sdk:call-tool-is-error",
      explicitlyTransient: false,
    };
  }
  if (Object.hasOwn(raw, "toolResult")) {
    return {
      status: "usable",
      value: raw as McpCallToolResult,
    };
  }
  return defaultMcpOutputAssessment<McpCallToolResult>(raw);
}

/**
 * Official MCP Client adapter for the transport supervisor. The adapter keeps
 * retry policy explicit per operation and never infers material-effect safety
 * from a model prompt or a possibly stale tool catalog.
 */
export class SupervisedMcpClient {
  private client: McpClientLike;
  private readonly supervisor: McpTransportSupervisor;
  private readonly options: SupervisedMcpClientOptions;
  private legacyClientRecreation?: Promise<void>;

  constructor(
    client: McpClientLike,
    supervisor: McpTransportSupervisor,
    options: SupervisedMcpClientOptions = {},
  ) {
    this.client = client;
    this.supervisor = supervisor;
    this.options = options;
  }

  private recoverLegacyClient(
    context: McpStaleSessionRecoveryContext,
  ): Promise<void> {
    if (!this.options.recreateLegacyClient) {
      return Promise.reject(
        new Error("No legacy MCP client recreation route is configured."),
      );
    }
    this.legacyClientRecreation ??= this.options
      .recreateLegacyClient(context)
      .then((client) => {
        this.client = client;
      })
      .finally(() => {
        this.legacyClientRecreation = undefined;
      });
    return this.legacyClientRecreation;
  }

  listTools(
    params?: McpListToolsParams,
    options: SupervisedListToolsOptions = {},
  ): Promise<McpSupervisedResult<McpListToolsResult>> {
    const timeoutMs = options.timeoutMs ?? this.options.defaultTimeoutMs;
    const transportIdentity =
      options.transportIdentity ?? this.options.transportIdentity;
    return this.supervisor.execute<McpListToolsResult>({
      operationRef: options.operationRef
        ?? `${this.options.operationPrefix ?? "mcp"}:tools/list`,
      logicalCallId: options.logicalCallId,
      operationKey: options.operationKey,
      toolRef: "tools/list",
      lane: "control",
      retrySafety: "read_only",
      backendRef: this.options.backendRef,
      transportIdentity,
      circuitKey: options.circuitKey,
      circuitFailureClass: options.circuitFailureClass,
      operationKind: options.operationKind ?? "catalog_refresh",
      subscriptionGeneration: options.subscriptionGeneration,
      timeoutMs,
      signal: options.signal,
      capability: options.capability,
      retryPolicy: options.retryPolicy,
      requiresCompletenessEvidence:
        options.requiresCompletenessEvidence ?? true,
      reconnect: options.reconnect ?? this.options.reconnect,
      recoverStaleSession: options.recoverStaleSession
        ?? (this.options.recreateLegacyClient
          && transportIdentity?.protocolEra === "legacy_stateful"
          ? (context) => this.recoverLegacyClient(context)
          : undefined),
      recoverSubscription: options.recoverSubscription
        ?? this.options.recoverSubscription,
      onTransition: options.onTransition,
      assessOutput: options.assessOutput ?? assessMcpListToolsOutput,
      classifyError: options.classifyError,
      invoke: async ({ signal, markDispatched }) => {
        markDispatched();
        return this.client.listTools(
          params,
          requestOptions(options.requestOptions, signal, timeoutMs),
        );
      },
    });
  }

  callTool(
    params: McpCallToolParams,
    options: SupervisedCallToolOptions,
  ): Promise<McpSupervisedResult<McpCallToolResult>> {
    const timeoutMs = options.timeoutMs ?? this.options.defaultTimeoutMs;
    const transportIdentity =
      options.transportIdentity ?? this.options.transportIdentity;
    return this.supervisor.execute<McpCallToolResult>({
      operationRef: options.operationRef
        ?? `${this.options.operationPrefix ?? "mcp"}:tools/call:${params.name}`,
      logicalCallId: options.logicalCallId,
      operationKey: options.operationKey,
      idempotencyEvidenceRef: options.idempotencyEvidenceRef,
      effectKey: options.effectKey,
      toolRef: `tools/call:${params.name}`,
      lane: options.lane,
      retrySafety: options.retrySafety,
      backendRef: this.options.backendRef,
      transportIdentity,
      circuitKey: options.circuitKey,
      circuitFailureClass: options.circuitFailureClass,
      operationKind: "tool_call",
      timeoutMs,
      signal: options.signal,
      capability: options.capability,
      retryPolicy: options.retryPolicy,
      requiresCompletenessEvidence: options.requiresCompletenessEvidence,
      reconnect: options.reconnect ?? this.options.reconnect,
      recoverStaleSession: options.recoverStaleSession
        ?? (this.options.recreateLegacyClient
          && transportIdentity?.protocolEra === "legacy_stateful"
          ? (context) => this.recoverLegacyClient(context)
          : undefined),
      reconcileEffect: options.reconcileEffect,
      onTransition: options.onTransition,
      assessOutput: options.assessOutput ?? assessMcpCallToolOutput,
      classifyError: options.classifyError,
      invoke: async ({ signal, markDispatched }) => {
        markDispatched();
        return this.client.callTool(
          params,
          options.resultSchema,
          requestOptions(options.requestOptions, signal, timeoutMs),
        );
      },
    });
  }
}
