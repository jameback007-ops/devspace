import { createHash } from "node:crypto";

export const MCP_TRANSPORT_SUPERVISOR_RESULT_SCHEMA =
  "zes.mcp-transport-supervisor.result.v1" as const;

export const MCP_TRANSPORT_SUPERVISOR_STATES = [
  "HEALTHY",
  "TRANSIENT_RETRYING",
  "TRANSPORT_DEGRADED",
  "OUTPUT_INDETERMINATE",
  "CLIENT_CATALOG_STALE",
  "EFFECT_LANE_BLOCKED",
  "RECOVERED",
  "HARD_EXTERNAL_BLOCKER",
] as const;

export type McpTransportSupervisorState =
  (typeof MCP_TRANSPORT_SUPERVISOR_STATES)[number];

export type McpCallLane =
  | "control"
  | "read"
  | "research"
  | "validation"
  | "effect";

export type McpRetrySafety = "read_only" | "idempotent" | "effectful";

export type McpCallSafetyClass =
  | "READ_ONLY"
  | "IDEMPOTENT_EFFECT"
  | "NON_IDEMPOTENT_EFFECT";

export type McpProtocolEra =
  | "legacy_stateful"
  | "legacy_stateless"
  | "modern"
  | "unknown";

export type McpOperationKind =
  | "protocol_negotiation"
  | "subscription_listen"
  | "catalog_refresh"
  | "tool_call";

export const MCP_FAILURE_CLASSES = [
  "CONNECT_AUTHENTICATION",
  "PROTOCOL_NEGOTIATION_UNSUPPORTED",
  "PROTOCOL_NEGOTIATION_INFRASTRUCTURE_FAILURE",
  "LEGACY_STALE_SESSION_PRE_DISPATCH",
  "SUBSCRIPTION_CLOSED",
  "NETWORK_NOT_DISPATCHED",
  "NETWORK_DISPATCH_UNKNOWN",
  "HTTP_NON_SUCCESS",
  "HTTP_BODY_TRUNCATED_OR_EMPTY",
  "JSON_PROTOCOL_PARSE_ERROR",
  "MCP_PROTOCOL_ERROR",
  "TOOL_RESULT_IS_ERROR",
  "SEMANTIC_OUTPUT_EMPTY_OR_UNUSABLE",
  "CANCELLED_BEFORE_DISPATCH",
  "CANCELLED_DISPATCH_UNKNOWN",
  "EFFECT_TERMINAL",
  "EFFECT_TERMINALITY_UNKNOWN",
] as const;

export type McpFailureClass = (typeof MCP_FAILURE_CLASSES)[number];

export type McpRequestDispatchCertainty =
  | "not_dispatched"
  | "possibly_dispatched"
  | "dispatched";

export type McpCatalogFreshness = "fresh" | "stale" | "unknown";

export type McpFailurePhase =
  | "before_dispatch"
  | "after_dispatch"
  | "unknown";

export type McpBackendOutcome =
  | "not_started"
  | "unknown"
  | "succeeded"
  | "failed";

export type McpTransportFaultKind =
  | "authentication_failure"
  | "protocol_negotiation_unsupported"
  | "protocol_negotiation_infrastructure_failure"
  | "legacy_stale_session_pre_dispatch"
  | "subscription_closed"
  | "timeout_before_response"
  | "disconnect_during_call"
  | "response_lost_after_success"
  | "http_non_success"
  | "json_protocol_parse_error"
  | "tool_result_error"
  | "empty_output"
  | "truncated_output"
  | "indeterminate_output"
  | "duplicate_delivery"
  | "delayed_response"
  | "backend_restart"
  | "stale_connection"
  | "partial_tool_availability"
  | "indeterminate_effect_result"
  | "client_catalog_stale"
  | "circuit_open"
  | "retry_budget_exhausted"
  | "caller_cancelled"
  | "protocol_error"
  | "external_blocker"
  | "unknown";

export interface McpTransportFaultOptions {
  kind: McpTransportFaultKind;
  phase?: McpFailurePhase;
  retryable?: boolean;
  backendOutcome?: McpBackendOutcome;
  retryAfterMs?: number;
  detailCode?: string;
  httpStatus?: number;
  protocolCode?: number;
  source?: unknown;
}

/**
 * A normalized transport failure. Adapters should prefer constructing this
 * type from structured transport/SDK evidence instead of asking the model to
 * infer retry safety from prose error messages.
 */
export class McpTransportFault extends Error {
  readonly kind: McpTransportFaultKind;
  readonly phase: McpFailurePhase;
  readonly retryable: boolean;
  readonly backendOutcome: McpBackendOutcome;
  readonly retryAfterMs?: number;
  readonly detailCode?: string;
  readonly httpStatus?: number;
  readonly protocolCode?: number;
  readonly source?: unknown;

  constructor(message: string, options: McpTransportFaultOptions) {
    super(message);
    this.name = "McpTransportFault";
    this.kind = options.kind;
    this.phase = options.phase ?? "unknown";
    this.retryable = options.retryable ?? false;
    this.backendOutcome = options.backendOutcome ?? "unknown";
    this.retryAfterMs = options.retryAfterMs;
    this.detailCode = options.detailCode;
    this.httpStatus = options.httpStatus;
    this.protocolCode = options.protocolCode;
    this.source = options.source;
  }
}

export interface McpUsableOutput<T> {
  status: "usable";
  value: T;
  deliveryId?: string;
  receiptRef?: string;
  completenessEvidenceRef?: string;
}

export interface McpUnusableOutput {
  status: "empty" | "truncated" | "indeterminate" | "tool_error";
  reason: string;
  deliveryId?: string;
  evidenceRef?: string;
  applicationErrorClass?: string;
  explicitlyTransient?: boolean;
}

export type McpOutputAssessment<T> = McpUsableOutput<T> | McpUnusableOutput;

export interface McpCapabilityPolicy {
  catalogFreshness?: McpCatalogFreshness;
  requiredCapabilities?: readonly string[];
  availableCapabilities?: readonly string[];
  requiresFreshCatalog?: boolean;
  freshEvidenceRequired?: boolean;
  validationReadbackRequired?: boolean;
  canonicalStateRequiredForMutation?: boolean;
  effectTransportRequired?: boolean;
  qualityEquivalentFallbackAvailable?: boolean;
  fallbackPolicyRef?: string;
}

export type McpEffectReconciliation<T> =
  | {
      state: "succeeded";
      value: T;
      receiptRef: string;
      deliveryId?: string;
    }
  | {
      state: "not_applied";
      receiptRef: string;
    }
  | {
      state: "terminal_failure";
      receiptRef: string;
      reason: string;
    }
  | {
      state: "indeterminate";
      reason: string;
      evidenceRefs?: readonly string[];
    };

export interface McpInvocationContext {
  attempt: number;
  logicalCallId: string;
  attemptId: string;
  callSafetyClass: McpCallSafetyClass;
  signal: AbortSignal;
  operationKey?: string;
  effectKey?: string;
  markDispatched(): void;
}

export interface McpReconnectContext {
  attempt: number;
  logicalCallId: string;
  attemptId: string;
  signal: AbortSignal;
  reason: McpTransportFault;
}

export interface McpStaleSessionRecoveryContext {
  attempt: 1;
  logicalCallId: string;
  attemptId: string;
  signal: AbortSignal;
  reason: McpTransportFault;
}

export interface McpSubscriptionRecoveryContext {
  attempt: number;
  logicalCallId: string;
  attemptId: string;
  signal: AbortSignal;
  reason: McpTransportFault;
  priorSubscriptionGeneration?: string;
}

export interface McpSubscriptionRecoveryResult {
  subscriptionGeneration: string;
  forcedRefetch: true;
  expectedListFingerprintSha256: string;
  observedListFingerprintSha256: string;
  evidenceRef?: string;
}

export interface McpEffectReconciliationContext {
  attempt: number;
  logicalCallId: string;
  attemptId: string;
  signal: AbortSignal;
  effectKey: string;
  reason: McpTransportFault;
}

export interface McpSupervisorTransition {
  schemaVersion: 1;
  observedAt: string;
  operationRef: string;
  logicalCallId: string;
  toolRef: string;
  state: McpTransportSupervisorState;
  attempt: number;
  attemptId?: string;
  reasonCode: string;
  action: string;
}

export interface McpRetryPolicy {
  maxAttempts: number;
  perAttemptTimeoutMs: number;
  initialDelayMs: number;
  maxDelayMs: number;
  growFactor: number;
  jitterRatio: number;
  reconnectMaxAttempts: number;
  reconciliationMaxAttempts: number;
  recoveryActionTimeoutMs: number;
}

export interface McpCircuitBreakerPolicy {
  failureThreshold: number;
  identicalFailureThreshold: number;
  openDurationMs: number;
  maxEntries: number;
  idleTtlMs: number;
}

export interface McpRetryBudgetPolicy {
  capacity: number;
  refillPerSecond: number;
}

export interface McpReceiptCachePolicy {
  maxEntries: number;
  ttlMs: number;
}

export interface McpTransportSupervisorOptions {
  now?: () => number;
  sleep?: (delayMs: number) => Promise<void>;
  random?: () => number;
  retryPolicy?: Partial<McpRetryPolicy>;
  circuitBreaker?: Partial<McpCircuitBreakerPolicy>;
  retryBudget?: Partial<McpRetryBudgetPolicy>;
  receiptCache?: Partial<McpReceiptCachePolicy>;
  latencySampleSize?: number;
  attemptEvidenceLimit?: number;
}

export interface McpTransportIdentity {
  endpointRef: string;
  protocolEra?: McpProtocolEra;
  protocolRevision?: string;
  backendGenerationRef?: string;
}

export type McpAttemptKind =
  | "primary"
  | "reconnect"
  | "legacy_session_recreate"
  | "subscription_relisten"
  | "effect_reconciliation";

export interface McpAttemptEvidence {
  schemaVersion: 1;
  logicalCallId: string;
  attemptId: string;
  attemptKind: McpAttemptKind;
  ordinal: number;
  toolName: string;
  callSafetyClass: McpCallSafetyClass;
  idempotencyKeyOrEffectKeyDigestSha256?: string;
  protocolEra: McpProtocolEra;
  protocolRevision?: string;
  endpointAndBackendGeneration: {
    endpointRef: string;
    backendGenerationRef?: string;
  };
  requestDispatchCertainty: McpRequestDispatchCertainty;
  httpStatus?: number;
  responseBodyLengthAndDigest?: {
    byteLength: number;
    digestSha256: string;
  };
  mcpResultOrErrorClass: string;
  semanticOutputClass:
    | "not_observed"
    | "usable"
    | "empty"
    | "truncated"
    | "indeterminate"
    | "tool_error";
  subscriptionGeneration?: string;
  subscriptionRefetch?: {
    forcedRefetch: true;
    expectedListFingerprintSha256: string;
    observedListFingerprintSha256: string;
    evidenceRef?: string;
  };
  effectReceiptOrTerminality?: {
    state:
      | "not_applicable"
      | "not_needed"
      | "succeeded"
      | "not_applied"
      | "terminal_failure"
      | "indeterminate"
      | "unavailable";
    receiptRef?: string;
  };
  failureClass?: McpFailureClass;
  circuitKey: string;
  outcome: "succeeded" | "failed" | "indeterminate";
  startedAt: string;
  completedAt: string;
  durationMs: number;
}

export interface McpBoundedRecoveryReceipt {
  schemaVersion: "zes.mcp-transport-supervisor.recovery-receipt.v1";
  logicalCallId: string;
  callSafetyClass: McpCallSafetyClass;
  finalDisposition: Exclude<
    McpTransportSupervisorState,
    "TRANSIENT_RETRYING"
  >;
  attempts: McpAttemptEvidence[];
  attemptEvidenceTruncated: boolean;
  generatedAt: string;
  policy: {
    boundedAutomaticRecovery: true;
    modelLevelRetryCeremonyRequired: false;
    qualityReductionAuthorized: false;
    newEffectAuthorityGranted: false;
  };
}

export interface McpSupervisedCall<T> {
  operationRef: string;
  logicalCallId?: string;
  toolRef: string;
  lane: McpCallLane;
  retrySafety: McpRetrySafety;
  operationKey?: string;
  /**
   * Exact contract/evidence proving that operationKey is bound to the backend
   * idempotency semantics. A local cache key alone never makes a remote
   * operation idempotent.
   */
  idempotencyEvidenceRef?: string;
  effectKey?: string;
  backendRef?: string;
  transportIdentity?: McpTransportIdentity;
  circuitKey?: string;
  circuitFailureClass?: McpFailureClass;
  operationKind?: McpOperationKind;
  subscriptionGeneration?: string;
  capability?: McpCapabilityPolicy;
  timeoutMs?: number;
  signal?: AbortSignal;
  retryPolicy?: Partial<McpRetryPolicy>;
  /**
   * Require a tool/domain assessor to return completenessEvidenceRef or a
   * terminal receipt. Validation calls default to true.
   */
  requiresCompletenessEvidence?: boolean;
  invoke(context: McpInvocationContext): Promise<unknown>;
  assessOutput?: (
    raw: unknown,
  ) => McpOutputAssessment<T> | Promise<McpOutputAssessment<T>>;
  classifyError?: (
    error: unknown,
    context: {
      dispatched: boolean;
      callerAborted: boolean;
    },
  ) => McpTransportFault;
  reconnect?: (context: McpReconnectContext) => Promise<void>;
  recoverStaleSession?: (
    context: McpStaleSessionRecoveryContext,
  ) => Promise<void>;
  recoverSubscription?: (
    context: McpSubscriptionRecoveryContext,
  ) => Promise<McpSubscriptionRecoveryResult>;
  reconcileEffect?: (
    context: McpEffectReconciliationContext,
  ) => Promise<McpEffectReconciliation<T>>;
  onTransition?: (transition: McpSupervisorTransition) => void;
}

export interface McpFailureView {
  kind: McpTransportFaultKind;
  failureClass: McpFailureClass;
  phase: McpFailurePhase;
  retryable: boolean;
  backendOutcome: McpBackendOutcome;
  detailCode?: string;
  httpStatus?: number;
  protocolCode?: number;
  fingerprintSha256: string;
}

export interface McpCapabilityView {
  catalogFreshness: McpCatalogFreshness;
  requiredCapabilities: string[];
  availableCapabilities: string[];
  missingCapabilities: string[];
  fallbackDisposition:
    | "not_needed"
    | "quality_equivalent_available"
    | "not_available"
    | "denied_to_preserve_quality";
  fallbackPolicyRef?: string;
}

export interface McpCircuitView {
  key: string;
  state: "closed" | "open" | "half_open";
  consecutiveFailures: number;
  identicalFailureCount: number;
  openUntil?: string;
}

export interface McpSupervisedResult<T> {
  schemaVersion: typeof MCP_TRANSPORT_SUPERVISOR_RESULT_SCHEMA;
  operationRef: string;
  logicalCallId: string;
  callSafetyClass: McpCallSafetyClass;
  toolRef: string;
  lane: McpCallLane;
  state: Exclude<McpTransportSupervisorState, "TRANSIENT_RETRYING">;
  ok: boolean;
  value?: T;
  source:
    | "primary"
    | "retry"
    | "operation_receipt"
    | "delivery_receipt"
    | "effect_receipt"
    | "policy_gate";
  attemptCount: number;
  retryCount: number;
  recovered: boolean;
  action: string;
  failure?: McpFailureView;
  capability?: McpCapabilityView;
  circuit: McpCircuitView;
  recoveryReceipt: McpBoundedRecoveryReceipt;
  evidence: {
    outputUsable: boolean;
    completenessEvidenceRef?: string;
    receiptRef?: string;
    idempotencyEvidenceRef?: string;
    effectReconciled: boolean;
    effectReconciliationState:
      | "not_applicable"
      | "not_needed"
      | "succeeded"
      | "not_applied"
      | "terminal_failure"
      | "indeterminate"
      | "unavailable";
    effectReconciliationReceiptRef?: string;
    effectReconciliationEvidenceRefs?: string[];
    effectLaneFrozen: boolean;
    validationClaimAllowed: boolean;
    qualityReductionAuthorized: false;
    newEffectAuthorityGranted: false;
  };
}

export interface McpTransportReliabilityMetrics {
  schemaVersion: "zes.mcp-transport-reliability-metrics.v1";
  totals: {
    operationCalls: number;
    productiveOperations: number;
    successfulOperations: number;
    primaryAttempts: number;
    retries: number;
    timeouts: number;
    drops: number;
    missingOutputs: number;
    recoveryActions: number;
    successfulRecoveryActions: number;
    ceremonyCalls: number;
    infrastructureRecoveryMs: number;
    falseRetriesPrevented: number;
    duplicateDeliveriesPrevented: number;
    duplicateEffectsPrevented: number;
    circuitTrips: number;
    circuitRejects: number;
    capabilityBlocks: number;
    effectLaneBlocks: number;
  };
  rates: {
    successfulCallRate: number;
    timeoutDropRate: number;
    missingOutputRate: number;
    retriesPerProductiveOperation: number;
    recoverySuccessRate: number;
    ceremonyCallsPerProductiveCall: number;
  };
  latencyMs: {
    sampleCount: number;
    p50: number;
    p95: number;
    max: number;
  };
}

interface MutableMetrics {
  operationCalls: number;
  productiveOperations: number;
  successfulOperations: number;
  primaryAttempts: number;
  retries: number;
  timeouts: number;
  drops: number;
  missingOutputs: number;
  recoveryActions: number;
  successfulRecoveryActions: number;
  ceremonyCalls: number;
  infrastructureRecoveryMs: number;
  falseRetriesPrevented: number;
  duplicateDeliveriesPrevented: number;
  duplicateEffectsPrevented: number;
  circuitTrips: number;
  circuitRejects: number;
  capabilityBlocks: number;
  effectLaneBlocks: number;
}

interface CachedReceipt {
  value: unknown;
  toolRef: string;
  operationKey?: string;
  effectKey?: string;
  deliveryId?: string;
  receiptRef?: string;
  completenessEvidenceRef?: string;
  idempotencyEvidenceRef?: string;
  effectReconciliationState?: McpSupervisedResult<unknown>["evidence"]["effectReconciliationState"];
  effectReconciliationReceiptRef?: string;
  effectReconciliationEvidenceRefs?: string[];
  storedAtMs: number;
}

interface CircuitRecord {
  state: "closed" | "open" | "half_open";
  consecutiveFailures: number;
  lastFailureFingerprint?: string;
  identicalFailureCount: number;
  openedAtMs?: number;
  halfOpenProbeInFlight: boolean;
  lastTouchedAtMs: number;
}

interface CircuitAdmission {
  allowed: boolean;
  view: McpCircuitView;
}

interface CapabilityGate {
  state: Exclude<McpTransportSupervisorState, "TRANSIENT_RETRYING">;
  action: string;
  view: McpCapabilityView;
  fault: McpTransportFault;
}

interface TimedInvocationResult {
  raw: unknown;
  dispatched: boolean;
}

interface ReconciliationAttempt<T> {
  result?: McpEffectReconciliation<T>;
  fault?: McpTransportFault;
}

class McpInvocationFailure extends Error {
  readonly source: unknown;
  readonly dispatched: boolean;

  constructor(source: unknown, dispatched: boolean) {
    super("MCP invocation failed before producing a usable result.");
    this.name = "McpInvocationFailure";
    this.source = source;
    this.dispatched = dispatched;
  }
}

interface ResultEvidenceOverrides {
  receiptRef?: string;
  completenessEvidenceRef?: string;
  effectReconciliationState?: McpSupervisedResult<unknown>["evidence"]["effectReconciliationState"];
  effectReconciliationReceiptRef?: string;
  effectReconciliationEvidenceRefs?: readonly string[];
}

interface AttemptDraft {
  logicalCallId: string;
  attemptId: string;
  attemptKind: McpAttemptKind;
  ordinal: number;
  toolName: string;
  callSafetyClass: McpCallSafetyClass;
  idempotencyKeyOrEffectKeyDigestSha256?: string;
  protocolEra: McpProtocolEra;
  protocolRevision?: string;
  endpointRef: string;
  backendGenerationRef?: string;
  subscriptionGeneration?: string;
  circuitKey: string;
  startedAtMs: number;
}

interface AttemptCompletion {
  requestDispatchCertainty: McpRequestDispatchCertainty;
  httpStatus?: number;
  responseBodyLengthAndDigest?: {
    byteLength: number;
    digestSha256: string;
  };
  mcpResultOrErrorClass: string;
  semanticOutputClass: McpAttemptEvidence["semanticOutputClass"];
  subscriptionGeneration?: string;
  subscriptionRefetch?: McpAttemptEvidence["subscriptionRefetch"];
  effectReceiptOrTerminality?: McpAttemptEvidence["effectReceiptOrTerminality"];
  failureClass?: McpFailureClass;
  outcome: McpAttemptEvidence["outcome"];
}

interface SubscriptionRecoveryAttempt {
  result?: McpSubscriptionRecoveryResult;
  fault?: McpTransportFault;
}

interface RecoveryAttemptOutcome {
  recovered: boolean;
  fault?: McpTransportFault;
}

interface ExecutionReceiptContext {
  logicalCallId: string;
  callSafetyClass: McpCallSafetyClass;
  attempts: McpAttemptEvidence[];
  attemptEvidenceTruncated: boolean;
}

const DEFAULT_RETRY_POLICY: McpRetryPolicy = {
  maxAttempts: 3,
  perAttemptTimeoutMs: 30_000,
  initialDelayMs: 100,
  maxDelayMs: 2_000,
  growFactor: 2,
  jitterRatio: 0.2,
  reconnectMaxAttempts: 2,
  reconciliationMaxAttempts: 2,
  recoveryActionTimeoutMs: 10_000,
};

const DEFAULT_CIRCUIT_BREAKER_POLICY: McpCircuitBreakerPolicy = {
  failureThreshold: 3,
  identicalFailureThreshold: 2,
  openDurationMs: 30_000,
  maxEntries: 500,
  idleTtlMs: 15 * 60_000,
};

const DEFAULT_RETRY_BUDGET_POLICY: McpRetryBudgetPolicy = {
  capacity: 20,
  refillPerSecond: 2,
};

const DEFAULT_RECEIPT_CACHE_POLICY: McpReceiptCachePolicy = {
  maxEntries: 500,
  ttlMs: 15 * 60_000,
};

const MAX_PRIMARY_ATTEMPTS = 20;
const MAX_RECOVERY_ATTEMPTS = 10;
const MAX_TIMEOUT_MS = 15 * 60_000;
const MAX_BACKOFF_DELAY_MS = 60_000;
const MAX_ATTEMPT_EVIDENCE = 1_000;

const RECONNECT_FAULTS = new Set<McpTransportFaultKind>([
  "disconnect_during_call",
  "response_lost_after_success",
  "backend_restart",
  "stale_connection",
]);

const OUTPUT_FAULTS = new Set<McpTransportFaultKind>([
  "response_lost_after_success",
  "empty_output",
  "truncated_output",
  "indeterminate_output",
  "json_protocol_parse_error",
]);

const DROP_FAULTS = new Set<McpTransportFaultKind>([
  "disconnect_during_call",
  "response_lost_after_success",
  "backend_restart",
  "stale_connection",
]);

function defaultSleep(delayMs: number): Promise<void> {
  if (delayMs <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNonNegative(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a finite non-negative number.`);
  }
  return value;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function ratio(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

function percentile(sorted: readonly number[], percentileValue: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.max(
    0,
    Math.min(sorted.length - 1, Math.ceil(sorted.length * percentileValue) - 1),
  );
  return sorted[index] ?? 0;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeReference(
  value: string,
  label: string,
  maximum: number,
  options: { uriLike?: boolean; queryOrFragmentAllowed?: boolean } = {},
): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) {
    throw new Error(`${label} must contain 1-${maximum} characters.`);
  }
  if (normalized !== value || /[\u0000-\u001f\u007f\s]/.test(normalized)) {
    throw new Error(
      `${label} must not contain whitespace or control characters.`,
    );
  }
  if (options.uriLike && !/^[a-z][a-z0-9+.-]*:[^\s]+$/i.test(normalized)) {
    throw new Error(`${label} must be an opaque URI-like reference.`);
  }
  if (!options.queryOrFragmentAllowed && /[?#]/.test(normalized)) {
    throw new Error(
      `${label} must not contain a query string or fragment; use a safe opaque endpoint identity.`,
    );
  }
  if (
    /(?:^|[?&#;])(?:token|access_token|refresh_token|secret|password|passwd|api[_-]?key|authorization|cookie|session|signature|sig|code)=/i
      .test(normalized)
    || /^[a-z][a-z0-9+.-]*:\/\/[^/]*@/i.test(normalized)
  ) {
    throw new Error(`${label} may not embed credential-bearing material.`);
  }
  return normalized;
}

function safeOptionalEvidenceRef(
  value: string | undefined,
  label: string,
): string | undefined {
  return value === undefined
    ? undefined
    : safeReference(value, label, 4_000, {
        queryOrFragmentAllowed: true,
      });
}

function exposedDetailCode(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (/^[a-z0-9_.:-]{1,256}$/i.test(normalized)) return normalized;
  return `detail-sha256:${sha256(normalized)}`;
}

function exposedEvidenceRef(
  value: string | undefined,
  label: string,
): string | undefined {
  if (value === undefined) return undefined;
  try {
    return safeOptionalEvidenceRef(value, label);
  } catch {
    return `evidence-sha256:${sha256(value)}`;
  }
}

function exposedReference(
  value: string | undefined,
  label: string,
  maximum = 1_024,
): string | undefined {
  if (value === undefined) return undefined;
  try {
    return safeReference(value, label, maximum, {
      queryOrFragmentAllowed: true,
    });
  } catch {
    return `ref-sha256:${sha256(value)}`;
  }
}

function callSafetyClass(retrySafety: McpRetrySafety): McpCallSafetyClass {
  if (retrySafety === "read_only") return "READ_ONLY";
  if (retrySafety === "idempotent") return "IDEMPOTENT_EFFECT";
  return "NON_IDEMPOTENT_EFFECT";
}

function transportIdentityFor(
  call: McpSupervisedCall<unknown>,
): Required<Pick<McpTransportIdentity, "endpointRef" | "protocolEra">>
  & Pick<McpTransportIdentity, "protocolRevision" | "backendGenerationRef"> {
  return {
    endpointRef: call.transportIdentity?.endpointRef
      ?? call.backendRef
      ?? "mcp",
    protocolEra: call.transportIdentity?.protocolEra ?? "unknown",
    protocolRevision: call.transportIdentity?.protocolRevision,
    backendGenerationRef: call.transportIdentity?.backendGenerationRef,
  };
}

function failureClassForFault(
  fault: McpTransportFault,
  operationKind: McpOperationKind | undefined,
): McpFailureClass {
  if (fault.kind === "authentication_failure") {
    return "CONNECT_AUTHENTICATION";
  }
  if (fault.kind === "protocol_negotiation_unsupported") {
    return "PROTOCOL_NEGOTIATION_UNSUPPORTED";
  }
  if (fault.kind === "protocol_negotiation_infrastructure_failure") {
    return "PROTOCOL_NEGOTIATION_INFRASTRUCTURE_FAILURE";
  }
  if (fault.kind === "legacy_stale_session_pre_dispatch") {
    return "LEGACY_STALE_SESSION_PRE_DISPATCH";
  }
  if (fault.kind === "subscription_closed") return "SUBSCRIPTION_CLOSED";
  if (fault.kind === "http_non_success") return "HTTP_NON_SUCCESS";
  if (fault.kind === "json_protocol_parse_error") {
    return "JSON_PROTOCOL_PARSE_ERROR";
  }
  if (fault.kind === "protocol_error") return "MCP_PROTOCOL_ERROR";
  if (fault.kind === "tool_result_error") return "TOOL_RESULT_IS_ERROR";
  if (fault.kind === "truncated_output") {
    return "HTTP_BODY_TRUNCATED_OR_EMPTY";
  }
  if (fault.kind === "empty_output" || fault.kind === "indeterminate_output") {
    return "SEMANTIC_OUTPUT_EMPTY_OR_UNUSABLE";
  }
  if (fault.kind === "caller_cancelled") {
    return fault.phase === "before_dispatch"
      ? "CANCELLED_BEFORE_DISPATCH"
      : "CANCELLED_DISPATCH_UNKNOWN";
  }
  if (fault.kind === "indeterminate_effect_result"
    || fault.kind === "response_lost_after_success"
    || fault.kind === "duplicate_delivery") {
    return "EFFECT_TERMINALITY_UNKNOWN";
  }
  if (fault.detailCode === "effect_terminal_failure") {
    return "EFFECT_TERMINAL";
  }
  if (operationKind === "protocol_negotiation" && [
    "timeout_before_response",
    "disconnect_during_call",
    "backend_restart",
    "stale_connection",
  ].includes(fault.kind)) {
    return "PROTOCOL_NEGOTIATION_INFRASTRUCTURE_FAILURE";
  }
  if ([
    "timeout_before_response",
    "disconnect_during_call",
    "backend_restart",
    "stale_connection",
    "delayed_response",
  ].includes(fault.kind)) {
    return fault.phase === "before_dispatch"
      && fault.backendOutcome === "not_started"
      ? "NETWORK_NOT_DISPATCHED"
      : "NETWORK_DISPATCH_UNKNOWN";
  }
  return fault.phase === "before_dispatch"
    && fault.backendOutcome === "not_started"
    ? "NETWORK_NOT_DISPATCHED"
    : "MCP_PROTOCOL_ERROR";
}

function requestDispatchCertainty(
  dispatched: boolean,
  fault?: McpTransportFault,
): McpRequestDispatchCertainty {
  if (fault?.phase === "before_dispatch"
    && fault.backendOutcome === "not_started") {
    return "not_dispatched";
  }
  if (dispatched && fault === undefined) return "dispatched";
  if (dispatched || fault?.phase !== "before_dispatch") {
    return "possibly_dispatched";
  }
  return "not_dispatched";
}

function responseBodyObservation(
  raw: unknown,
): { byteLength: number; digestSha256: string } | undefined {
  try {
    const serialized = JSON.stringify(raw);
    if (serialized === undefined) return undefined;
    return {
      byteLength: Buffer.byteLength(serialized),
      digestSha256: sha256(serialized),
    };
  } catch {
    return undefined;
  }
}

function semanticOutputClassForFault(
  fault: McpTransportFault,
  observed: McpAttemptEvidence["semanticOutputClass"],
): McpAttemptEvidence["semanticOutputClass"] {
  if (fault.kind === "tool_result_error") return "tool_error";
  if (fault.kind === "empty_output") return "empty";
  if (fault.kind === "truncated_output"
    || fault.kind === "json_protocol_parse_error") {
    return "truncated";
  }
  if (fault.kind === "indeterminate_output"
    || fault.kind === "response_lost_after_success"
    || fault.kind === "indeterminate_effect_result") {
    return "indeterminate";
  }
  return observed;
}

function exactLegacyUnknownSessionError(error: unknown): boolean {
  const record = isRecord(error) ? error : undefined;
  const status = typeof record?.status === "number"
    ? record.status
    : typeof record?.statusCode === "number"
      ? record.statusCode
      : typeof record?.code === "number" && record.code === 404
        ? 404
        : undefined;
  if (status !== 404) return false;
  const message = error instanceof Error
    ? error.message
    : typeof record?.message === "string"
      ? record.message
      : "";
  return /(?:"code"\s*:\s*-32000|-32000)/.test(message)
    && /unknown mcp session/i.test(message);
}

function failureFingerprint(
  toolRef: string,
  fault: McpTransportFault,
  operationKind?: McpOperationKind,
): string {
  return sha256([
    toolRef,
    failureClassForFault(fault, operationKind),
    fault.kind,
    fault.phase,
    fault.backendOutcome,
    fault.detailCode ?? "",
    String(fault.httpStatus ?? ""),
    String(fault.protocolCode ?? ""),
  ].join("\u0000"));
}

function operationReceiptKey(
  backendRef: string | undefined,
  toolRef: string,
  operationKey: string,
): string {
  return `${backendRef ?? "mcp"}\u0000${toolRef}\u0000${operationKey}`;
}

function deliveryReceiptKey(
  backendRef: string | undefined,
  toolRef: string,
  deliveryId: string,
): string {
  return `${backendRef ?? "mcp"}\u0000${toolRef}\u0000${deliveryId}`;
}

function circuitKeyFor(
  call: McpSupervisedCall<unknown>,
  failureClass: McpFailureClass,
): string {
  const identity = transportIdentityFor(call);
  return [
    call.circuitKey ?? "mcp-transport",
    identity.endpointRef,
    identity.protocolEra,
    identity.backendGenerationRef ?? "unknown-generation",
    failureClass,
  ].join(":");
}

function outputFault<T>(assessment: McpUnusableOutput): McpTransportFault {
  const kind: McpTransportFaultKind = assessment.status === "empty"
    ? "empty_output"
    : assessment.status === "truncated"
      ? "truncated_output"
      : assessment.status === "tool_error"
        ? "tool_result_error"
        : "indeterminate_output";
  return new McpTransportFault(assessment.reason, {
    kind,
    phase: "after_dispatch",
    retryable: assessment.status === "tool_error"
      ? assessment.explicitlyTransient === true
      : assessment.status !== "indeterminate",
    backendOutcome: assessment.status === "tool_error" ? "failed" : "unknown",
    detailCode: assessment.applicationErrorClass ?? assessment.evidenceRef,
  });
}

export function defaultMcpOutputAssessment<T>(raw: unknown): McpOutputAssessment<T> {
  if (raw === null || raw === undefined) {
    return { status: "empty", reason: "MCP call returned no result value." };
  }
  if (typeof raw === "string" && raw.trim().length === 0) {
    return { status: "empty", reason: "MCP call returned an empty string." };
  }
  if (isRecord(raw) && raw.isError === true) {
    return {
      status: "tool_error",
      reason: "The MCP tool returned an application-level error result.",
      evidenceRef: "mcp:tool-result-is-error",
      explicitlyTransient: false,
    };
  }
  if (isRecord(raw) && Array.isArray(raw.content)) {
    const hasStructured = raw.structuredContent !== undefined
      || raw.toolResult !== undefined
      || raw.result !== undefined;
    if (raw.content.length === 0 && !hasStructured) {
      return {
        status: "empty",
        reason: "MCP result had neither content nor structured output.",
      };
    }
    const contentIsOnlyEmptyText = raw.content.length > 0
      && raw.content.every((entry) =>
        isRecord(entry)
        && entry.type === "text"
        && typeof entry.text === "string"
        && entry.text.trim().length === 0);
    if (contentIsOnlyEmptyText && !hasStructured) {
      return {
        status: "empty",
        reason: "MCP result contained only empty text content.",
      };
    }
  }
  return { status: "usable", value: raw as T };
}

export function classifyMcpTransportError(
  error: unknown,
  context: {
    dispatched: boolean;
    callerAborted: boolean;
    protocolEra?: McpProtocolEra;
    operationKind?: McpOperationKind;
  },
): McpTransportFault {
  if (error instanceof McpTransportFault) return error;

  if (context.callerAborted) {
    return new McpTransportFault("The caller cancelled the MCP operation.", {
      kind: "caller_cancelled",
      phase: context.dispatched ? "after_dispatch" : "before_dispatch",
      retryable: false,
      backendOutcome: context.dispatched ? "unknown" : "not_started",
      source: error,
    });
  }

  if (error instanceof SyntaxError) {
    return new McpTransportFault("The MCP response could not be parsed completely.", {
      kind: "json_protocol_parse_error",
      phase: "after_dispatch",
      retryable: false,
      backendOutcome: "unknown",
      source: error,
    });
  }

  const record = isRecord(error) ? error : undefined;
  const numericCode = typeof record?.code === "number" ? record.code : undefined;
  const stringCode = typeof record?.code === "string" ? record.code : undefined;
  const status = typeof record?.status === "number"
    ? record.status
    : typeof record?.statusCode === "number"
      ? record.statusCode
      : undefined;
  const httpStatus = status ?? (
    numericCode !== undefined && numericCode >= 400 && numericCode <= 599
      ? numericCode
      : undefined
  );

  if (exactLegacyUnknownSessionError(error)) {
    if (context.protocolEra === "legacy_stateful") {
      return new McpTransportFault(
        "The legacy MCP server rejected a stale session before tool dispatch.",
        {
          kind: "legacy_stale_session_pre_dispatch",
          phase: "before_dispatch",
          retryable: true,
          backendOutcome: "not_started",
          detailCode: "typed_unknown_legacy_session",
          httpStatus: 404,
          protocolCode: -32000,
          source: error,
        },
      );
    }
    return new McpTransportFault(
      "An unknown-session response was observed outside an attested legacy stateful route.",
      {
        kind: "http_non_success",
        phase: context.dispatched ? "after_dispatch" : "unknown",
        retryable: false,
        backendOutcome: context.dispatched ? "unknown" : "not_started",
        detailCode: "unknown_session_without_legacy_stateful_attestation",
        httpStatus: 404,
        protocolCode: -32000,
        source: error,
      },
    );
  }

  if (httpStatus === 401 || httpStatus === 403) {
    return new McpTransportFault(
      "The MCP endpoint rejected authentication or authorization.",
      {
        kind: "authentication_failure",
        phase: "before_dispatch",
        retryable: false,
        backendOutcome: "not_started",
        httpStatus,
        source: error,
      },
    );
  }

  if (numericCode === -32022
    || (context.operationKind === "protocol_negotiation"
      && /unsupported protocol version/i.test(
        error instanceof Error ? error.message : String(error),
      ))) {
    return new McpTransportFault(
      "The requested MCP protocol revision is not supported.",
      {
        kind: "protocol_negotiation_unsupported",
        phase: "before_dispatch",
        retryable: false,
        backendOutcome: "not_started",
        detailCode: "typed_unsupported_protocol_revision",
        httpStatus,
        protocolCode: -32022,
        source: error,
      },
    );
  }

  if (numericCode === -32001) {
    return new McpTransportFault("The MCP request timed out before a usable response.", {
      kind: "timeout_before_response",
      phase: context.dispatched ? "after_dispatch" : "unknown",
      retryable: true,
      backendOutcome: context.dispatched ? "unknown" : "not_started",
      source: error,
    });
  }
  if (numericCode === -32000) {
    return new McpTransportFault("The MCP connection closed before completion.", {
      kind: "stale_connection",
      phase: context.dispatched ? "after_dispatch" : "before_dispatch",
      retryable: true,
      backendOutcome: context.dispatched ? "unknown" : "not_started",
      protocolCode: numericCode,
      source: error,
    });
  }
  if (numericCode === -32700) {
    return new McpTransportFault("The MCP response was not valid complete JSON-RPC.", {
      kind: "json_protocol_parse_error",
      phase: "after_dispatch",
      retryable: false,
      backendOutcome: "unknown",
      protocolCode: numericCode,
      source: error,
    });
  }
  if (httpStatus === 502 || httpStatus === 503 || httpStatus === 504) {
    if (context.operationKind === "protocol_negotiation") {
      return new McpTransportFault(
        "Protocol negotiation could not complete because the endpoint infrastructure was unavailable.",
        {
          kind: "protocol_negotiation_infrastructure_failure",
          phase: context.dispatched ? "after_dispatch" : "before_dispatch",
          retryable: true,
          backendOutcome: context.dispatched ? "unknown" : "not_started",
          httpStatus,
          source: error,
        },
      );
    }
    return new McpTransportFault("The MCP backend or proxy was temporarily unavailable.", {
      kind: "backend_restart",
      phase: context.dispatched ? "after_dispatch" : "before_dispatch",
      retryable: true,
      backendOutcome: context.dispatched ? "unknown" : "not_started",
      httpStatus,
      source: error,
    });
  }
  if (httpStatus !== undefined) {
    const transient = [408, 425, 429, 500].includes(httpStatus);
    return new McpTransportFault(
      `The MCP endpoint returned HTTP ${httpStatus}.`,
      {
        kind: context.operationKind === "protocol_negotiation" && transient
          ? "protocol_negotiation_infrastructure_failure"
          : "http_non_success",
        phase: context.dispatched ? "after_dispatch" : "before_dispatch",
        retryable: transient,
        backendOutcome: context.dispatched ? "unknown" : "not_started",
        httpStatus,
        source: error,
      },
    );
  }
  if (stringCode && [
    "ECONNRESET",
    "ECONNREFUSED",
    "EPIPE",
    "ETIMEDOUT",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_SOCKET",
  ].includes(stringCode)) {
    return new McpTransportFault("The MCP network connection failed transiently.", {
      kind: stringCode === "ETIMEDOUT" || stringCode === "UND_ERR_CONNECT_TIMEOUT"
        ? "timeout_before_response"
        : "disconnect_during_call",
      phase: context.dispatched ? "after_dispatch" : "before_dispatch",
      retryable: true,
      backendOutcome: context.dispatched ? "unknown" : "not_started",
      detailCode: stringCode,
      source: error,
    });
  }
  if (error instanceof Error && error.name === "AbortError") {
    return new McpTransportFault("The MCP request was aborted before a usable response.", {
      kind: "timeout_before_response",
      phase: context.dispatched ? "after_dispatch" : "unknown",
      retryable: true,
      backendOutcome: context.dispatched ? "unknown" : "not_started",
      source: error,
    });
  }

  return new McpTransportFault("The MCP operation failed without retry-safe transport evidence.", {
    kind: "unknown",
    phase: context.dispatched ? "after_dispatch" : "unknown",
    retryable: false,
    backendOutcome: context.dispatched ? "unknown" : "not_started",
    source: error,
  });
}

export class McpTransportSupervisor {
  private readonly now: () => number;
  private readonly sleep: (delayMs: number) => Promise<void>;
  private readonly random: () => number;
  private readonly retryPolicy: McpRetryPolicy;
  private readonly circuitPolicy: McpCircuitBreakerPolicy;
  private readonly retryBudgetPolicy: McpRetryBudgetPolicy;
  private readonly receiptPolicy: McpReceiptCachePolicy;
  private readonly latencySampleSize: number;
  private readonly attemptEvidenceLimit: number;
  private readonly circuits = new Map<string, CircuitRecord>();
  private readonly operationReceipts = new Map<string, CachedReceipt>();
  private readonly deliveryReceipts = new Map<string, CachedReceipt>();
  private readonly latencySamples: number[] = [];
  private retryTokens: number;
  private retryBudgetUpdatedAtMs: number;
  private attemptSequence = 0;
  private readonly mutableMetrics: MutableMetrics = {
    operationCalls: 0,
    productiveOperations: 0,
    successfulOperations: 0,
    primaryAttempts: 0,
    retries: 0,
    timeouts: 0,
    drops: 0,
    missingOutputs: 0,
    recoveryActions: 0,
    successfulRecoveryActions: 0,
    ceremonyCalls: 0,
    infrastructureRecoveryMs: 0,
    falseRetriesPrevented: 0,
    duplicateDeliveriesPrevented: 0,
    duplicateEffectsPrevented: 0,
    circuitTrips: 0,
    circuitRejects: 0,
    capabilityBlocks: 0,
    effectLaneBlocks: 0,
  };

  constructor(options: McpTransportSupervisorOptions = {}) {
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
    this.random = options.random ?? Math.random;
    this.retryPolicy = {
      ...DEFAULT_RETRY_POLICY,
      ...options.retryPolicy,
    };
    this.circuitPolicy = {
      ...DEFAULT_CIRCUIT_BREAKER_POLICY,
      ...options.circuitBreaker,
    };
    this.retryBudgetPolicy = {
      ...DEFAULT_RETRY_BUDGET_POLICY,
      ...options.retryBudget,
    };
    this.receiptPolicy = {
      ...DEFAULT_RECEIPT_CACHE_POLICY,
      ...options.receiptCache,
    };
    this.latencySampleSize = options.latencySampleSize ?? 1_000;
    this.attemptEvidenceLimit = options.attemptEvidenceLimit ?? 100;
    this.validateOptions();
    this.retryTokens = this.retryBudgetPolicy.capacity;
    this.retryBudgetUpdatedAtMs = this.now();
  }

  metrics(): McpTransportReliabilityMetrics {
    const sorted = [...this.latencySamples].sort((a, b) => a - b);
    const totals = { ...this.mutableMetrics };
    return {
      schemaVersion: "zes.mcp-transport-reliability-metrics.v1",
      totals,
      rates: {
        successfulCallRate: ratio(
          totals.successfulOperations,
          totals.operationCalls,
        ),
        timeoutDropRate: ratio(
          totals.timeouts + totals.drops,
          totals.primaryAttempts,
        ),
        missingOutputRate: ratio(
          totals.missingOutputs,
          totals.primaryAttempts,
        ),
        retriesPerProductiveOperation: ratio(
          totals.retries,
          totals.productiveOperations,
        ),
        recoverySuccessRate: ratio(
          totals.successfulRecoveryActions,
          totals.recoveryActions,
        ),
        ceremonyCallsPerProductiveCall: ratio(
          totals.ceremonyCalls,
          totals.productiveOperations,
        ),
      },
      latencyMs: {
        sampleCount: sorted.length,
        p50: percentile(sorted, 0.5),
        p95: percentile(sorted, 0.95),
        max: sorted.at(-1) ?? 0,
      },
    };
  }

  circuitSnapshot(circuitKey: string): McpCircuitView {
    return this.circuitView(circuitKey, this.now());
  }

  private executionReceiptContext<T>(
    call: McpSupervisedCall<T>,
  ): ExecutionReceiptContext {
    return {
      logicalCallId: call.logicalCallId?.trim() || call.operationRef,
      callSafetyClass: callSafetyClass(call.retrySafety),
      attempts: [],
      attemptEvidenceTruncated: false,
    };
  }

  private beginAttempt<T>(
    call: McpSupervisedCall<T>,
    receiptContext: ExecutionReceiptContext,
    attemptKind: McpAttemptKind,
    ordinal: number,
    circuitKey: string,
    subscriptionGeneration?: string,
  ): AttemptDraft {
    this.attemptSequence += 1;
    const startedAtMs = this.now();
    const identity = transportIdentityFor(
      call as McpSupervisedCall<unknown>,
    );
    const attemptId = `mcp-attempt:${sha256([
      receiptContext.logicalCallId,
      attemptKind,
      String(ordinal),
      String(this.attemptSequence),
      String(startedAtMs),
    ].join("\u0000")).slice(0, 32)}`;
    return {
      logicalCallId: receiptContext.logicalCallId,
      attemptId,
      attemptKind,
      ordinal,
      toolName: call.toolRef,
      callSafetyClass: receiptContext.callSafetyClass,
      idempotencyKeyOrEffectKeyDigestSha256:
        call.effectKey ?? call.operationKey
          ? sha256((call.effectKey ?? call.operationKey)!)
          : undefined,
      protocolEra: identity.protocolEra,
      protocolRevision: identity.protocolRevision,
      endpointRef: identity.endpointRef,
      backendGenerationRef: identity.backendGenerationRef,
      subscriptionGeneration:
        subscriptionGeneration ?? call.subscriptionGeneration,
      circuitKey,
      startedAtMs,
    };
  }

  private finishAttempt(
    receiptContext: ExecutionReceiptContext,
    draft: AttemptDraft,
    completion: AttemptCompletion,
  ): McpAttemptEvidence {
    const completedAtMs = this.now();
    const evidence: McpAttemptEvidence = {
      schemaVersion: 1,
      logicalCallId: draft.logicalCallId,
      attemptId: draft.attemptId,
      attemptKind: draft.attemptKind,
      ordinal: draft.ordinal,
      toolName: draft.toolName,
      callSafetyClass: draft.callSafetyClass,
      idempotencyKeyOrEffectKeyDigestSha256:
        draft.idempotencyKeyOrEffectKeyDigestSha256,
      protocolEra: draft.protocolEra,
      protocolRevision: draft.protocolRevision,
      endpointAndBackendGeneration: {
        endpointRef: draft.endpointRef,
        backendGenerationRef: draft.backendGenerationRef,
      },
      requestDispatchCertainty: completion.requestDispatchCertainty,
      httpStatus: completion.httpStatus,
      responseBodyLengthAndDigest: completion.responseBodyLengthAndDigest,
      mcpResultOrErrorClass: completion.mcpResultOrErrorClass,
      semanticOutputClass: completion.semanticOutputClass,
      subscriptionGeneration:
        exposedReference(
          completion.subscriptionGeneration ?? draft.subscriptionGeneration,
          "attempt.subscriptionGeneration",
        ),
      subscriptionRefetch: completion.subscriptionRefetch === undefined
        ? undefined
        : {
            ...completion.subscriptionRefetch,
            evidenceRef: exposedEvidenceRef(
              completion.subscriptionRefetch.evidenceRef,
              "attempt.subscriptionRefetch.evidenceRef",
            ),
          },
      effectReceiptOrTerminality:
        completion.effectReceiptOrTerminality === undefined
          ? undefined
          : {
              ...completion.effectReceiptOrTerminality,
              receiptRef: exposedEvidenceRef(
                completion.effectReceiptOrTerminality.receiptRef,
                "attempt.effectReceiptOrTerminality.receiptRef",
              ),
            },
      failureClass: completion.failureClass,
      circuitKey: draft.circuitKey,
      outcome: completion.outcome,
      startedAt: new Date(draft.startedAtMs).toISOString(),
      completedAt: new Date(completedAtMs).toISOString(),
      durationMs: Math.max(0, completedAtMs - draft.startedAtMs),
    };
    if (receiptContext.attempts.length < this.attemptEvidenceLimit) {
      receiptContext.attempts.push(evidence);
    } else {
      receiptContext.attemptEvidenceTruncated = true;
      receiptContext.attempts[this.attemptEvidenceLimit - 1] = evidence;
    }
    return evidence;
  }

  private recoveryReceipt(
    receiptContext: ExecutionReceiptContext,
    finalDisposition: Exclude<
      McpTransportSupervisorState,
      "TRANSIENT_RETRYING"
    >,
  ): McpBoundedRecoveryReceipt {
    return {
      schemaVersion: "zes.mcp-transport-supervisor.recovery-receipt.v1",
      logicalCallId: receiptContext.logicalCallId,
      callSafetyClass: receiptContext.callSafetyClass,
      finalDisposition,
      attempts: receiptContext.attempts.map((attempt) => ({ ...attempt })),
      attemptEvidenceTruncated: receiptContext.attemptEvidenceTruncated,
      generatedAt: new Date(this.now()).toISOString(),
      policy: {
        boundedAutomaticRecovery: true,
        modelLevelRetryCeremonyRequired: false,
        qualityReductionAuthorized: false,
        newEffectAuthorityGranted: false,
      },
    };
  }

  private circuitRoutePrefix<T>(call: McpSupervisedCall<T>): string {
    const identity = transportIdentityFor(
      call as McpSupervisedCall<unknown>,
    );
    return [
      call.circuitKey ?? "mcp-transport",
      identity.endpointRef,
      identity.protocolEra,
      identity.backendGenerationRef ?? "unknown-generation",
    ].join(":");
  }

  private admitCircuitForCall<T>(
    call: McpSupervisedCall<T>,
    nowMs: number,
  ): CircuitAdmission {
    const prefix = `${this.circuitRoutePrefix(call)}:`;
    for (const [key, record] of this.circuits) {
      if (!key.startsWith(prefix) || record.state === "closed") continue;
      return this.admitCircuit(key, nowMs);
    }
    return this.admitCircuit(
      circuitKeyFor(
        call as McpSupervisedCall<unknown>,
        call.circuitFailureClass ?? "NETWORK_DISPATCH_UNKNOWN",
      ),
      nowMs,
    );
  }

  private circuitEligible(failureClass: McpFailureClass): boolean {
    return ![
      "CONNECT_AUTHENTICATION",
      "PROTOCOL_NEGOTIATION_UNSUPPORTED",
      "TOOL_RESULT_IS_ERROR",
      "CANCELLED_BEFORE_DISPATCH",
      "CANCELLED_DISPATCH_UNKNOWN",
      "EFFECT_TERMINAL",
    ].includes(failureClass);
  }

  async execute<T>(call: McpSupervisedCall<T>): Promise<McpSupervisedResult<T>> {
    this.validateCall(call);
    this.mutableMetrics.operationCalls += 1;
    const operationStartedAtMs = this.now();
    const receiptContext = this.executionReceiptContext(call);
    this.pruneReceipts(operationStartedAtMs);
    this.pruneCircuits(operationStartedAtMs);
    const effectiveOperationKey = call.operationKey
      ?? (call.retrySafety === "effectful" && call.effectKey
        ? `effect:${call.effectKey}`
        : undefined);
    let circuitKey = circuitKeyFor(
      call as McpSupervisedCall<unknown>,
      call.circuitFailureClass ?? "NETWORK_DISPATCH_UNKNOWN",
    );

    if (effectiveOperationKey) {
      const cached = this.operationReceipts.get(
        operationReceiptKey(
          call.backendRef,
          call.toolRef,
          effectiveOperationKey,
        ),
      );
      if (cached) {
        this.mutableMetrics.successfulOperations += 1;
        this.mutableMetrics.falseRetriesPrevented += 1;
        this.mutableMetrics.duplicateDeliveriesPrevented += 1;
        if (call.retrySafety === "effectful") {
          this.mutableMetrics.duplicateEffectsPrevented += 1;
        }
        return this.successResult(call, {
          value: cached.value as T,
          source: "operation_receipt",
          state: "RECOVERED",
          attempts: 0,
          retries: 0,
          recovered: true,
          action: "Use the validated local operation receipt; do not replay the MCP call.",
          receiptRef: cached.receiptRef,
          completenessEvidenceRef: cached.completenessEvidenceRef,
          idempotencyEvidenceRef: cached.idempotencyEvidenceRef,
          effectReconciliationState: cached.effectReconciliationState,
          effectReconciliationReceiptRef:
            cached.effectReconciliationReceiptRef,
          effectReconciliationEvidenceRefs:
            cached.effectReconciliationEvidenceRefs,
          circuitKey,
        }, operationStartedAtMs, receiptContext);
      }
    }

    const capabilityGate = this.capabilityGate(call);
    if (capabilityGate) {
      this.mutableMetrics.capabilityBlocks += 1;
      if (capabilityGate.state === "EFFECT_LANE_BLOCKED") {
        this.mutableMetrics.effectLaneBlocks += 1;
      }
      return this.failureResult(
        call,
        capabilityGate.state,
        capabilityGate.action,
        capabilityGate.fault,
        0,
        0,
        circuitKey,
        operationStartedAtMs,
        receiptContext,
        capabilityGate.view,
      );
    }

    const contractFault = this.effectContractFault(call, effectiveOperationKey);
    if (contractFault) {
      this.mutableMetrics.effectLaneBlocks += 1;
      return this.failureResult(
        call,
        call.retrySafety === "effectful"
          ? "EFFECT_LANE_BLOCKED"
          : "HARD_EXTERNAL_BLOCKER",
        call.retrySafety === "effectful"
          ? "Freeze the effect lane until an exact effect key and authoritative reconciliation route are supplied."
          : "Supply a stable operation key before enabling automatic idempotent retry.",
        contractFault,
        0,
        0,
        circuitKey,
        operationStartedAtMs,
        receiptContext,
        this.capabilityView(call.capability),
      );
    }

    const admission = this.admitCircuitForCall(call, operationStartedAtMs);
    circuitKey = admission.view.key;
    if (!admission.allowed) {
      this.mutableMetrics.circuitRejects += 1;
      const fault = new McpTransportFault(
        "The transport circuit is open after repeated equivalent failures.",
        {
          kind: "circuit_open",
          phase: "before_dispatch",
          retryable: false,
          backendOutcome: "not_started",
        },
      );
      const state = call.lane === "effect"
        ? "EFFECT_LANE_BLOCKED"
        : "TRANSPORT_DEGRADED";
      if (state === "EFFECT_LANE_BLOCKED") {
        this.mutableMetrics.effectLaneBlocks += 1;
      }
      return this.failureResult(
        call,
        state,
        state === "EFFECT_LANE_BLOCKED"
          ? "Keep the effect lane frozen; wait for circuit half-open probing and reconcile any existing effect key before retry."
          : "Do not repeat the identical call. Wait for the bounded circuit cooldown or use an explicitly quality-equivalent route.",
        fault,
        0,
        0,
        circuitKey,
        operationStartedAtMs,
        receiptContext,
        this.capabilityView(call.capability),
      );
    }

    const policy = this.callRetryPolicy(call);
    let retries = 0;
    let lastFault: McpTransportFault | undefined;
    let recoveryStartedAtMs: number | undefined;
    let priorEffectReconciliationState:
      | McpSupervisedResult<T>["evidence"]["effectReconciliationState"]
      | undefined;
    let priorEffectReconciliationReceiptRef: string | undefined;
    let staleSessionRecoveryUsed = false;
    let currentSubscriptionGeneration = call.subscriptionGeneration;
    this.mutableMetrics.productiveOperations += 1;

    for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
      const primaryAttempt = this.beginAttempt(
        call,
        receiptContext,
        "primary",
        attempt,
        circuitKey,
        currentSubscriptionGeneration,
      );
      if (call.signal?.aborted) {
        const fault = classifyMcpTransportError(
          new Error("caller aborted"),
          {
            dispatched: false,
            callerAborted: true,
            protocolEra: transportIdentityFor(
              call as McpSupervisedCall<unknown>,
            ).protocolEra,
            operationKind: call.operationKind,
          },
        );
        const failureClass = failureClassForFault(fault, call.operationKind);
        circuitKey = circuitKeyFor(
          call as McpSupervisedCall<unknown>,
          failureClass,
        );
        primaryAttempt.circuitKey = circuitKey;
        this.finishAttempt(receiptContext, primaryAttempt, {
          requestDispatchCertainty: "not_dispatched",
          mcpResultOrErrorClass: failureClass,
          semanticOutputClass: "not_observed",
          effectReceiptOrTerminality: {
            state: call.retrySafety === "effectful"
              ? "not_needed"
              : "not_applicable",
          },
          failureClass,
          outcome: "failed",
        });
        return this.failureResult(
          call,
          "HARD_EXTERNAL_BLOCKER",
          "The caller cancelled this operation. Preserve the current causal state instead of retrying.",
          fault,
          attempt - 1,
          retries,
          circuitKey,
          operationStartedAtMs,
          receiptContext,
          this.capabilityView(call.capability),
          recoveryStartedAtMs,
        );
      }

      this.mutableMetrics.primaryAttempts += 1;
      let outputAssessmentStarted = false;
      let observedDispatch = false;
      let responseObservation:
        | { byteLength: number; digestSha256: string }
        | undefined;
      let semanticOutputClass:
        McpAttemptEvidence["semanticOutputClass"] = "not_observed";
      try {
        const invocation = await this.invokeWithTimeout(
          call,
          attempt,
          effectiveOperationKey,
          policy.perAttemptTimeoutMs,
          receiptContext.logicalCallId,
          primaryAttempt.attemptId,
          receiptContext.callSafetyClass,
        );
        observedDispatch = invocation.dispatched;
        responseObservation = responseBodyObservation(invocation.raw);
        outputAssessmentStarted = true;
        const assessment = await (
          call.assessOutput ?? defaultMcpOutputAssessment<T>
        )(invocation.raw);
        semanticOutputClass = assessment.status;
        if (assessment.status !== "usable") {
          throw outputFault(assessment);
        }
        const completenessEvidenceRequired =
          call.requiresCompletenessEvidence ?? call.lane === "validation";
        if (
          completenessEvidenceRequired
          && assessment.completenessEvidenceRef === undefined
          && assessment.receiptRef === undefined
        ) {
          semanticOutputClass = "indeterminate";
          throw new McpTransportFault(
            "The MCP result lacks the required completeness or terminal receipt evidence.",
            {
              kind: "indeterminate_output",
              phase: "after_dispatch",
              retryable: false,
              backendOutcome: "unknown",
              detailCode: "required_completeness_evidence_missing",
            },
          );
        }

        if (assessment.deliveryId) {
          const deliveryKey = deliveryReceiptKey(
            call.backendRef,
            call.toolRef,
            assessment.deliveryId,
          );
          const priorDelivery = this.deliveryReceipts.get(deliveryKey);
          if (priorDelivery) {
            if (
              call.retrySafety === "effectful"
              && priorDelivery.effectKey !== call.effectKey
            ) {
              const collision = new McpTransportFault(
                "A delivery receipt was reused for a different material effect key.",
                {
                  kind: "duplicate_delivery",
                  phase: "after_dispatch",
                  retryable: false,
                  backendOutcome: "unknown",
                  detailCode: "delivery_effect_key_collision",
                },
              );
              const collisionClass = failureClassForFault(
                collision,
                call.operationKind,
              );
              circuitKey = circuitKeyFor(
                call as McpSupervisedCall<unknown>,
                collisionClass,
              );
              primaryAttempt.circuitKey = circuitKey;
              this.finishAttempt(receiptContext, primaryAttempt, {
                requestDispatchCertainty: "dispatched",
                responseBodyLengthAndDigest: responseObservation,
                mcpResultOrErrorClass: collisionClass,
                semanticOutputClass: "indeterminate",
                effectReceiptOrTerminality: {
                  state: "indeterminate",
                },
                failureClass: collisionClass,
                outcome: "indeterminate",
              });
              this.mutableMetrics.effectLaneBlocks += 1;
              return this.failureResult(
                call,
                "EFFECT_LANE_BLOCKED",
                "Freeze the effect lane and reconcile the conflicting delivery and effect receipts.",
                collision,
                attempt,
                retries,
                circuitKey,
                operationStartedAtMs,
                receiptContext,
                this.capabilityView(call.capability),
                recoveryStartedAtMs,
              );
            }
            this.finishAttempt(receiptContext, primaryAttempt, {
              requestDispatchCertainty: "dispatched",
              responseBodyLengthAndDigest: responseObservation,
              mcpResultOrErrorClass: "MCP_RESULT_DUPLICATE_DELIVERY",
              semanticOutputClass: "usable",
              subscriptionGeneration: currentSubscriptionGeneration,
              effectReceiptOrTerminality: {
                state: priorDelivery.effectReconciliationState
                  ?? (call.retrySafety === "effectful"
                    ? "not_needed"
                    : "not_applicable"),
                receiptRef:
                  priorDelivery.effectReconciliationReceiptRef
                  ?? priorDelivery.receiptRef,
              },
              outcome: "succeeded",
            });
            this.mutableMetrics.duplicateDeliveriesPrevented += 1;
            this.mutableMetrics.falseRetriesPrevented += 1;
            if (call.retrySafety === "effectful") {
              this.mutableMetrics.duplicateEffectsPrevented += 1;
            }
            this.recordCircuitSuccess(circuitKey);
            this.mutableMetrics.successfulOperations += 1;
            return this.successResult(call, {
              value: priorDelivery.value as T,
              source: "delivery_receipt",
              state: "RECOVERED",
              attempts: attempt,
              retries,
              recovered: true,
              action: "Use the prior validated delivery receipt; suppress duplicate processing.",
              receiptRef: priorDelivery.receiptRef,
              completenessEvidenceRef:
                priorDelivery.completenessEvidenceRef,
              idempotencyEvidenceRef:
                priorDelivery.idempotencyEvidenceRef,
              effectReconciliationState:
                priorDelivery.effectReconciliationState,
              effectReconciliationReceiptRef:
                priorDelivery.effectReconciliationReceiptRef,
              effectReconciliationEvidenceRefs:
                priorDelivery.effectReconciliationEvidenceRefs,
              circuitKey,
            }, operationStartedAtMs, receiptContext, recoveryStartedAtMs);
          }
        }

        const receipt: CachedReceipt = {
          value: assessment.value,
          toolRef: call.toolRef,
          operationKey: effectiveOperationKey,
          effectKey: call.effectKey,
          deliveryId: assessment.deliveryId,
          receiptRef: assessment.receiptRef,
          completenessEvidenceRef: assessment.completenessEvidenceRef,
          idempotencyEvidenceRef: call.idempotencyEvidenceRef,
          effectReconciliationState: call.retrySafety === "effectful"
            ? priorEffectReconciliationState ?? "not_needed"
            : "not_applicable",
          effectReconciliationReceiptRef:
            priorEffectReconciliationReceiptRef,
          storedAtMs: this.now(),
        };
        this.storeReceipt(call, effectiveOperationKey, receipt);
        this.recordCircuitSuccess(circuitKey);
        this.finishAttempt(receiptContext, primaryAttempt, {
          requestDispatchCertainty: observedDispatch
            ? "dispatched"
            : "not_dispatched",
          responseBodyLengthAndDigest: responseObservation,
          mcpResultOrErrorClass: "MCP_RESULT",
          semanticOutputClass: "usable",
          subscriptionGeneration: currentSubscriptionGeneration,
          effectReceiptOrTerminality: {
            state: call.retrySafety === "effectful"
              ? priorEffectReconciliationState ?? "not_needed"
              : "not_applicable",
            receiptRef:
              priorEffectReconciliationReceiptRef ?? assessment.receiptRef,
          },
          outcome: "succeeded",
        });
        this.mutableMetrics.successfulOperations += 1;
        return this.successResult(call, {
          value: assessment.value,
          source: retries > 0 ? "retry" : "primary",
          state: retries > 0 ? "RECOVERED" : "HEALTHY",
          attempts: attempt,
          retries,
          recovered: retries > 0,
          action: retries > 0
            ? "Primary MCP path recovered automatically; continue without manual transport re-checks."
            : "Continue on the primary MCP path.",
          receiptRef: assessment.receiptRef,
          completenessEvidenceRef: assessment.completenessEvidenceRef,
          idempotencyEvidenceRef: call.idempotencyEvidenceRef,
          effectReconciliationState: call.retrySafety === "effectful"
            ? priorEffectReconciliationState ?? "not_needed"
            : "not_applicable",
          effectReconciliationReceiptRef:
            priorEffectReconciliationReceiptRef,
          circuitKey,
        }, operationStartedAtMs, receiptContext, recoveryStartedAtMs);
      } catch (error) {
        if (recoveryStartedAtMs === undefined) {
          recoveryStartedAtMs = this.now();
        }
        const sourceError = error instanceof McpInvocationFailure
          ? error.source
          : error;
        const dispatched = error instanceof McpTransportFault
          ? error.phase === "after_dispatch"
          : error instanceof McpInvocationFailure
            ? error.dispatched
            : outputAssessmentStarted || call.retrySafety !== "read_only";
        observedDispatch = observedDispatch || dispatched;
        const fault = this.classifyCallError(call, sourceError, {
          dispatched,
          callerAborted: call.signal?.aborted === true,
        });
        lastFault = fault;
        this.recordFaultMetrics(fault);
        const failureClass = failureClassForFault(fault, call.operationKind);
        circuitKey = circuitKeyFor(
          call as McpSupervisedCall<unknown>,
          failureClass,
        );
        primaryAttempt.circuitKey = circuitKey;
        this.finishAttempt(receiptContext, primaryAttempt, {
          requestDispatchCertainty: requestDispatchCertainty(
            observedDispatch,
            fault,
          ),
          httpStatus: fault.httpStatus,
          responseBodyLengthAndDigest: responseObservation,
          mcpResultOrErrorClass: failureClass,
          semanticOutputClass: semanticOutputClassForFault(
            fault,
            semanticOutputClass,
          ),
          subscriptionGeneration: currentSubscriptionGeneration,
          effectReceiptOrTerminality: {
            state: call.retrySafety === "effectful"
              ? this.effectMayHaveRun(fault)
                ? "indeterminate"
                : "not_needed"
              : "not_applicable",
          },
          failureClass,
          outcome: call.retrySafety === "effectful"
            && this.effectMayHaveRun(fault)
            ? "indeterminate"
            : "failed",
        });
        const circuitOpened = this.circuitEligible(failureClass)
          ? this.recordCircuitFailure(
              circuitKey,
              failureFingerprint(call.toolRef, fault, call.operationKind),
            )
          : false;

        if (call.retrySafety === "effectful" && this.effectMayHaveRun(fault)) {
          const reconciled = await this.reconcileEffect(
            call,
            fault,
            policy,
            receiptContext,
            circuitKey,
          );
          if (reconciled.result?.state === "succeeded") {
            const effectReceipt: CachedReceipt = {
              value: reconciled.result.value,
              toolRef: call.toolRef,
              operationKey: effectiveOperationKey,
              effectKey: call.effectKey,
              deliveryId: reconciled.result.deliveryId,
              receiptRef: reconciled.result.receiptRef,
              effectReconciliationState: "succeeded",
              effectReconciliationReceiptRef:
                reconciled.result.receiptRef,
              storedAtMs: this.now(),
            };
            this.storeReceipt(call, effectiveOperationKey, effectReceipt);
            this.recordCircuitSuccess(circuitKey);
            this.mutableMetrics.successfulOperations += 1;
            return this.successResult(call, {
              value: reconciled.result.value,
              source: "effect_receipt",
              state: "RECOVERED",
              attempts: attempt,
              retries,
              recovered: true,
              action: "Use the authoritative effect receipt; do not replay the material call.",
              receiptRef: reconciled.result.receiptRef,
              circuitKey,
              effectReconciliationState: "succeeded",
              effectReconciliationReceiptRef:
                reconciled.result.receiptRef,
            }, operationStartedAtMs, receiptContext, recoveryStartedAtMs);
          }
          if (reconciled.result?.state === "not_applied") {
            if (
              attempt < policy.maxAttempts
              && !circuitOpened
              && this.consumeRetryBudget()
            ) {
              priorEffectReconciliationState = "not_applied";
              priorEffectReconciliationReceiptRef =
                reconciled.result.receiptRef;
              retries += 1;
              this.mutableMetrics.retries += 1;
              this.emitTransition(call, {
                state: "TRANSIENT_RETRYING",
                attempt,
                attemptId: primaryAttempt.attemptId,
                reasonCode: "effect_receipt_confirmed_not_applied",
                action: "Retry the same effect key once the authoritative receipt proves no prior application.",
              });
              await this.sleep(this.retryDelay(policy, retries, fault));
              continue;
            }
            const stopFault = circuitOpened
              ? new McpTransportFault(
                  "The transport circuit opened after the effect owner proved the effect was not applied.",
                  {
                    kind: "circuit_open",
                    phase: "before_dispatch",
                    retryable: false,
                    backendOutcome: "not_started",
                    detailCode: "effect_not_applied_circuit_open",
                  },
                )
              : attempt >= policy.maxAttempts
                ? new McpTransportFault(
                    "The bounded primary-attempt horizon ended after the effect owner proved the effect was not applied.",
                    {
                      kind: "external_blocker",
                      phase: "before_dispatch",
                      retryable: false,
                      backendOutcome: "not_started",
                      detailCode: "effect_not_applied_attempt_horizon_exhausted",
                    },
                  )
                : new McpTransportFault(
                    "The shared retry budget is exhausted after the effect owner proved the effect was not applied.",
                    {
                      kind: "retry_budget_exhausted",
                      phase: "before_dispatch",
                      retryable: false,
                      backendOutcome: "not_started",
                      detailCode: "effect_not_applied_retry_budget_exhausted",
                    },
                  );
            this.mutableMetrics.effectLaneBlocks += 1;
            return this.failureResult(
              call,
              "EFFECT_LANE_BLOCKED",
              "The effect is authoritatively not applied, but the bounded retry route is unavailable. Keep the effect lane frozen until a fresh safe attempt is admitted.",
              stopFault,
              attempt,
              retries,
              circuitKey,
              operationStartedAtMs,
              receiptContext,
              this.capabilityView(call.capability),
              recoveryStartedAtMs,
              {
                receiptRef: reconciled.result.receiptRef,
                effectReconciliationState: "not_applied",
                effectReconciliationReceiptRef:
                  reconciled.result.receiptRef,
              },
            );
          }
          if (reconciled.result?.state === "terminal_failure") {
            this.mutableMetrics.effectLaneBlocks += 1;
            return this.failureResult(
              call,
              "EFFECT_LANE_BLOCKED",
              "The effect owner returned a terminal failure receipt. Do not retry this effect key unless its owner explicitly authorizes a successor effect.",
              new McpTransportFault(reconciled.result.reason, {
                kind: "external_blocker",
                phase: "after_dispatch",
                retryable: false,
                backendOutcome: "failed",
                detailCode: "effect_terminal_failure",
              }),
              attempt,
              retries,
              circuitKey,
              operationStartedAtMs,
              receiptContext,
              this.capabilityView(call.capability),
              recoveryStartedAtMs,
              {
                receiptRef: reconciled.result.receiptRef,
                effectReconciliationState: "terminal_failure",
                effectReconciliationReceiptRef:
                  reconciled.result.receiptRef,
              },
            );
          }
          if (reconciled.result?.state === "indeterminate") {
            this.mutableMetrics.effectLaneBlocks += 1;
            return this.failureResult(
              call,
              "EFFECT_LANE_BLOCKED",
              "Freeze only the material-effect lane. The authoritative owner still reports the exact effect outcome as indeterminate.",
              new McpTransportFault(reconciled.result.reason, {
                kind: "indeterminate_effect_result",
                phase: "after_dispatch",
                retryable: false,
                backendOutcome: "unknown",
                detailCode: "effect_owner_indeterminate",
              }),
              attempt,
              retries,
              circuitKey,
              operationStartedAtMs,
              receiptContext,
              this.capabilityView(call.capability),
              recoveryStartedAtMs,
              {
                effectReconciliationState: "indeterminate",
                effectReconciliationEvidenceRefs:
                  reconciled.result.evidenceRefs,
              },
            );
          }

          this.mutableMetrics.effectLaneBlocks += 1;
          const reconciliationFault = reconciled.fault
            ?? new McpTransportFault(
              "No authoritative effect reconciliation result was returned.",
              {
                kind: "indeterminate_effect_result",
                phase: "after_dispatch",
                retryable: false,
                backendOutcome: "unknown",
                detailCode: "effect_reconciliation_result_missing",
              },
            );
          return this.failureResult(
            call,
            "EFFECT_LANE_BLOCKED",
            "Freeze only the material-effect lane. Restore the authoritative reconciliation route before any retry or publication claim.",
            reconciliationFault,
            attempt,
            retries,
            circuitKey,
            operationStartedAtMs,
            receiptContext,
            this.capabilityView(call.capability),
            recoveryStartedAtMs,
            { effectReconciliationState: "unavailable" },
          );
        }

        if (fault.kind === "legacy_stale_session_pre_dispatch") {
          if (
            staleSessionRecoveryUsed
            || !call.recoverStaleSession
            || attempt >= policy.maxAttempts
            || circuitOpened
            || !this.consumeRetryBudget()
          ) {
            lastFault = new McpTransportFault(
              "The typed legacy stale-session route could not be recreated within its single bounded recovery allowance.",
              {
                kind: "legacy_stale_session_pre_dispatch",
                phase: "before_dispatch",
                retryable: false,
                backendOutcome: "not_started",
                detailCode: staleSessionRecoveryUsed
                  ? "legacy_stale_session_recovery_already_used"
                  : call.recoverStaleSession
                    ? "legacy_stale_session_recovery_unavailable"
                    : "legacy_stale_session_recovery_callback_missing",
                httpStatus: fault.httpStatus,
                protocolCode: fault.protocolCode,
              },
            );
            break;
          }
          staleSessionRecoveryUsed = true;
          const recreated = await this.recoverLegacyStaleSession(
            call,
            fault,
            policy,
            receiptContext,
            circuitKey,
          );
          if (!recreated.recovered) {
            lastFault = recreated.fault ?? new McpTransportFault(
              "The legacy MCP client/transport recreation did not recover the route.",
              {
                kind: "legacy_stale_session_pre_dispatch",
                phase: "before_dispatch",
                retryable: false,
                backendOutcome: "not_started",
                detailCode: "legacy_stale_session_recreate_failed",
              },
            );
            break;
          }
          retries += 1;
          this.mutableMetrics.retries += 1;
          this.emitTransition(call, {
            state: "TRANSIENT_RETRYING",
            attempt,
            attemptId: primaryAttempt.attemptId,
            reasonCode: "typed_legacy_stale_session_recreated",
            action: "Retry once with the recreated legacy client and transport under the same logical call.",
          });
          await this.sleep(this.retryDelay(policy, retries, fault));
          continue;
        }

        if (fault.kind === "subscription_closed") {
          if (
            !call.recoverSubscription
            || attempt >= policy.maxAttempts
            || circuitOpened
            || !this.consumeRetryBudget()
          ) {
            lastFault = new McpTransportFault(
              "The closed MCP subscription could not be re-established and verified within policy.",
              {
                kind: "subscription_closed",
                phase: "before_dispatch",
                retryable: false,
                backendOutcome: "not_started",
                detailCode: call.recoverSubscription
                  ? "subscription_relisten_unavailable"
                  : "subscription_recovery_callback_missing",
              },
            );
            break;
          }
          const recoveredSubscription = await this.recoverSubscription(
            call,
            fault,
            policy,
            receiptContext,
            circuitKey,
            currentSubscriptionGeneration,
          );
          if (!recoveredSubscription.result) {
            lastFault = recoveredSubscription.fault ?? new McpTransportFault(
              "The bounded subscription re-listen did not recover the route.",
              {
                kind: "subscription_closed",
                phase: "before_dispatch",
                retryable: false,
                backendOutcome: "not_started",
                detailCode: "subscription_relisten_exhausted",
              },
            );
            break;
          }
          currentSubscriptionGeneration =
            recoveredSubscription.result.subscriptionGeneration;
          retries += 1;
          this.mutableMetrics.retries += 1;
          this.emitTransition(call, {
            state: "TRANSIENT_RETRYING",
            attempt,
            attemptId: primaryAttempt.attemptId,
            reasonCode: "subscription_relisten_and_refetch_verified",
            action: "Resume with the verified subscription generation and matching forced-refetch fingerprint.",
          });
          await this.sleep(this.retryDelay(policy, retries, fault));
          continue;
        }

        const retrySafe = this.retrySafe(
          call,
          effectiveOperationKey,
          fault,
        );
        if (
          retrySafe
          && attempt < policy.maxAttempts
          && !circuitOpened
          && this.consumeRetryBudget()
        ) {
          if (call.reconnect && RECONNECT_FAULTS.has(fault.kind)) {
            const reconnected = await this.reconnect(
              call,
              fault,
              policy,
              receiptContext,
              circuitKey,
            );
            if (!reconnected) {
              lastFault = new McpTransportFault(
                "The bounded MCP reconnect lifecycle did not recover the route.",
                {
                  kind: "stale_connection",
                  phase: "before_dispatch",
                  retryable: false,
                  backendOutcome: "not_started",
                  detailCode: "bounded_reconnect_exhausted",
                },
              );
              break;
            }
          }
          retries += 1;
          this.mutableMetrics.retries += 1;
          this.emitTransition(call, {
            state: "TRANSIENT_RETRYING",
            attempt,
            attemptId: primaryAttempt.attemptId,
            reasonCode: fault.kind,
            action: "Retry automatically within the bounded budget; suppress model-level retry ceremony.",
          });
          await this.sleep(this.retryDelay(policy, retries, fault));
          continue;
        }

        if (retrySafe && attempt < policy.maxAttempts && !circuitOpened) {
          lastFault = new McpTransportFault(
            "The shared MCP retry budget is exhausted.",
            {
              kind: "retry_budget_exhausted",
              phase: "before_dispatch",
              retryable: false,
              backendOutcome: "not_started",
            },
          );
        }
        break;
      }
    }

    const terminalFault = lastFault ?? new McpTransportFault(
      "The MCP operation ended without a usable result.",
      {
        kind: "unknown",
        phase: "unknown",
        retryable: false,
        backendOutcome: "unknown",
      },
    );
    const terminalState = this.terminalState(call, terminalFault);
    if (terminalState === "EFFECT_LANE_BLOCKED") {
      this.mutableMetrics.effectLaneBlocks += 1;
    }
    return this.failureResult(
      call,
      terminalState,
      this.terminalAction(call, terminalState, terminalFault),
      terminalFault,
      this.mutableAttemptCount(policy.maxAttempts, retries),
      retries,
      circuitKey,
      operationStartedAtMs,
      receiptContext,
      this.capabilityView(call.capability),
      recoveryStartedAtMs,
    );
  }

  private validateOptions(): void {
    this.validateRetryPolicy(this.retryPolicy, "retryPolicy");
    positiveInteger(
      this.circuitPolicy.failureThreshold,
      "circuitBreaker.failureThreshold",
    );
    positiveInteger(
      this.circuitPolicy.identicalFailureThreshold,
      "circuitBreaker.identicalFailureThreshold",
    );
    finiteNonNegative(
      this.circuitPolicy.openDurationMs,
      "circuitBreaker.openDurationMs",
    );
    positiveInteger(
      this.circuitPolicy.maxEntries,
      "circuitBreaker.maxEntries",
    );
    finiteNonNegative(
      this.circuitPolicy.idleTtlMs,
      "circuitBreaker.idleTtlMs",
    );
    finiteNonNegative(
      this.retryBudgetPolicy.capacity,
      "retryBudget.capacity",
    );
    finiteNonNegative(
      this.retryBudgetPolicy.refillPerSecond,
      "retryBudget.refillPerSecond",
    );
    positiveInteger(this.receiptPolicy.maxEntries, "receiptCache.maxEntries");
    finiteNonNegative(this.receiptPolicy.ttlMs, "receiptCache.ttlMs");
    positiveInteger(this.latencySampleSize, "latencySampleSize");
    positiveInteger(this.attemptEvidenceLimit, "attemptEvidenceLimit");
    if (this.attemptEvidenceLimit > MAX_ATTEMPT_EVIDENCE) {
      throw new Error(
        `attemptEvidenceLimit must not exceed ${MAX_ATTEMPT_EVIDENCE}.`,
      );
    }
  }

  private validateCall<T>(call: McpSupervisedCall<T>): void {
    safeReference(call.operationRef, "operationRef", 1_024);
    safeReference(call.toolRef, "toolRef", 1_024);
    if (call.logicalCallId !== undefined) {
      safeReference(call.logicalCallId, "logicalCallId", 1_024);
    }
    if (call.operationKey !== undefined) {
      safeReference(call.operationKey, "operationKey", 4_000, {
        queryOrFragmentAllowed: true,
      });
    }
    if (call.effectKey !== undefined) {
      safeReference(call.effectKey, "effectKey", 4_000, {
        queryOrFragmentAllowed: true,
      });
    }
    if (call.idempotencyEvidenceRef !== undefined) {
      safeOptionalEvidenceRef(
        call.idempotencyEvidenceRef,
        "idempotencyEvidenceRef",
      );
    }
    if (call.backendRef !== undefined) {
      safeReference(call.backendRef, "backendRef", 1_024);
    }
    if (call.circuitKey !== undefined) {
      safeReference(call.circuitKey, "circuitKey", 1_024);
    }
    if (call.subscriptionGeneration !== undefined) {
      safeReference(
        call.subscriptionGeneration,
        "subscriptionGeneration",
        1_024,
      );
    }
    if (call.transportIdentity) {
      safeReference(
        call.transportIdentity.endpointRef,
        "transportIdentity.endpointRef",
        2_048,
        { uriLike: true },
      );
      if (call.transportIdentity.protocolRevision !== undefined) {
        safeReference(
          call.transportIdentity.protocolRevision,
          "transportIdentity.protocolRevision",
          256,
        );
      }
      if (call.transportIdentity.backendGenerationRef !== undefined) {
        safeReference(
          call.transportIdentity.backendGenerationRef,
          "transportIdentity.backendGenerationRef",
          1_024,
        );
      }
    }
    if (call.capability?.fallbackPolicyRef !== undefined) {
      safeOptionalEvidenceRef(
        call.capability.fallbackPolicyRef,
        "capability.fallbackPolicyRef",
      );
    }
    if (
      call.recoverStaleSession
      && call.transportIdentity?.protocolEra !== "legacy_stateful"
    ) {
      throw new Error(
        "recoverStaleSession requires an attested legacy_stateful transport identity.",
      );
    }
    if (call.timeoutMs !== undefined) {
      finiteNonNegative(call.timeoutMs, "call.timeoutMs");
    }
  }

  private callRetryPolicy<T>(call: McpSupervisedCall<T>): McpRetryPolicy {
    const policy = {
      ...this.retryPolicy,
      ...call.retryPolicy,
      ...(call.timeoutMs === undefined
        ? {}
        : { perAttemptTimeoutMs: call.timeoutMs }),
    };
    this.validateRetryPolicy(policy, "call.retryPolicy");
    return policy;
  }

  private validateRetryPolicy(
    policy: McpRetryPolicy,
    prefix: string,
  ): void {
    positiveInteger(policy.maxAttempts, `${prefix}.maxAttempts`);
    if (policy.maxAttempts > MAX_PRIMARY_ATTEMPTS) {
      throw new Error(
        `${prefix}.maxAttempts must not exceed ${MAX_PRIMARY_ATTEMPTS}.`,
      );
    }
    positiveInteger(
      policy.reconnectMaxAttempts,
      `${prefix}.reconnectMaxAttempts`,
    );
    if (policy.reconnectMaxAttempts > MAX_RECOVERY_ATTEMPTS) {
      throw new Error(
        `${prefix}.reconnectMaxAttempts must not exceed ${MAX_RECOVERY_ATTEMPTS}.`,
      );
    }
    positiveInteger(
      policy.reconciliationMaxAttempts,
      `${prefix}.reconciliationMaxAttempts`,
    );
    if (policy.reconciliationMaxAttempts > MAX_RECOVERY_ATTEMPTS) {
      throw new Error(
        `${prefix}.reconciliationMaxAttempts must not exceed ${MAX_RECOVERY_ATTEMPTS}.`,
      );
    }
    finiteNonNegative(
      policy.perAttemptTimeoutMs,
      `${prefix}.perAttemptTimeoutMs`,
    );
    if (policy.perAttemptTimeoutMs > MAX_TIMEOUT_MS) {
      throw new Error(
        `${prefix}.perAttemptTimeoutMs must not exceed ${MAX_TIMEOUT_MS}.`,
      );
    }
    finiteNonNegative(
      policy.recoveryActionTimeoutMs,
      `${prefix}.recoveryActionTimeoutMs`,
    );
    if (policy.recoveryActionTimeoutMs > MAX_TIMEOUT_MS) {
      throw new Error(
        `${prefix}.recoveryActionTimeoutMs must not exceed ${MAX_TIMEOUT_MS}.`,
      );
    }
    finiteNonNegative(policy.initialDelayMs, `${prefix}.initialDelayMs`);
    finiteNonNegative(policy.maxDelayMs, `${prefix}.maxDelayMs`);
    if (policy.initialDelayMs > MAX_BACKOFF_DELAY_MS
      || policy.maxDelayMs > MAX_BACKOFF_DELAY_MS) {
      throw new Error(
        `${prefix} backoff delays must not exceed ${MAX_BACKOFF_DELAY_MS}.`,
      );
    }
    if (policy.initialDelayMs > policy.maxDelayMs) {
      throw new Error(
        `${prefix}.initialDelayMs must not exceed ${prefix}.maxDelayMs.`,
      );
    }
    if (!Number.isFinite(policy.growFactor) || policy.growFactor < 1) {
      throw new Error(`${prefix}.growFactor must be at least 1.`);
    }
    if (!Number.isFinite(policy.jitterRatio)
      || policy.jitterRatio < 0
      || policy.jitterRatio > 1) {
      throw new Error(`${prefix}.jitterRatio must be between 0 and 1.`);
    }
  }

  private effectContractFault<T>(
    call: McpSupervisedCall<T>,
    effectiveOperationKey: string | undefined,
  ): McpTransportFault | undefined {
    if (call.retrySafety === "idempotent" && !effectiveOperationKey) {
      return new McpTransportFault(
        "Automatic idempotent retry requires a stable operation key.",
        {
          kind: "external_blocker",
          phase: "before_dispatch",
          retryable: false,
          backendOutcome: "not_started",
          detailCode: "idempotent_operation_key_missing",
        },
      );
    }
    if (
      call.retrySafety === "idempotent"
      && !call.idempotencyEvidenceRef?.trim()
    ) {
      return new McpTransportFault(
        "Automatic idempotent retry requires evidence that the operation key is bound to the backend contract.",
        {
          kind: "external_blocker",
          phase: "before_dispatch",
          retryable: false,
          backendOutcome: "not_started",
          detailCode: "idempotency_binding_evidence_missing",
        },
      );
    }
    if (call.retrySafety !== "effectful") return undefined;
    if (!call.effectKey) {
      return new McpTransportFault(
        "A material MCP effect requires an exact effect key.",
        {
          kind: "indeterminate_effect_result",
          phase: "before_dispatch",
          retryable: false,
          backendOutcome: "not_started",
          detailCode: "effect_key_missing",
        },
      );
    }
    if (!call.reconcileEffect) {
      return new McpTransportFault(
        "A material MCP effect requires an authoritative reconciliation route.",
        {
          kind: "indeterminate_effect_result",
          phase: "before_dispatch",
          retryable: false,
          backendOutcome: "not_started",
          detailCode: "effect_reconciliation_route_missing",
        },
      );
    }
    return undefined;
  }

  private capabilityGate<T>(call: McpSupervisedCall<T>): CapabilityGate | undefined {
    const capability = call.capability;
    if (!capability) return undefined;
    const view = this.capabilityView(capability)!;
    if (
      view.missingCapabilities.length > 0
      && capability.qualityEquivalentFallbackAvailable
      && !capability.fallbackPolicyRef?.trim()
    ) {
      return {
        state: "HARD_EXTERNAL_BLOCKER",
        action: "Declare the exact fallback policy reference before treating an alternate route as quality-equivalent.",
        view,
        fault: new McpTransportFault(
          "The declared quality-equivalent fallback has no policy reference.",
          {
            kind: "external_blocker",
            phase: "before_dispatch",
            retryable: false,
            backendOutcome: "not_started",
            detailCode: "typed_fallback_policy_ref_missing",
          },
        ),
      };
    }
    const catalogUnusable = capability.requiresFreshCatalog === true
      && view.catalogFreshness !== "fresh";
    if (catalogUnusable || (
      view.missingCapabilities.length > 0
      && view.catalogFreshness !== "fresh"
    )) {
      return {
        state: "CLIENT_CATALOG_STALE",
        action: "Refresh or reconnect the MCP client catalog before relying on the missing capability.",
        view,
        fault: new McpTransportFault("The client catalog is stale or unobserved.", {
          kind: "client_catalog_stale",
          phase: "before_dispatch",
          retryable: false,
          backendOutcome: "not_started",
        }),
      };
    }
    if (view.missingCapabilities.length === 0) return undefined;
    if (capability.effectTransportRequired || call.lane === "effect") {
      return {
        state: "EFFECT_LANE_BLOCKED",
        action: "Freeze only the effect lane until its required transport capability is healthy.",
        view,
        fault: new McpTransportFault("The required material-effect transport is unavailable.", {
          kind: "partial_tool_availability",
          phase: "before_dispatch",
          retryable: false,
          backendOutcome: "not_started",
          detailCode: "effect_transport_missing",
        }),
      };
    }
    const qualityCritical = capability.freshEvidenceRequired
      || capability.validationReadbackRequired
      || capability.canonicalStateRequiredForMutation;
    if (qualityCritical && !capability.qualityEquivalentFallbackAvailable) {
      return {
        state: "HARD_EXTERNAL_BLOCKER",
        action: capability.freshEvidenceRequired
          ? "Stop the evidence-dependent lane; do not substitute stale local judgment for required fresh research."
          : capability.validationReadbackRequired
            ? "Stop before validation claims; a missing readback cannot be treated as validated."
            : "Stop mutation until the required canonical state is visible.",
        view,
        fault: new McpTransportFault("A quality-critical MCP capability is unavailable.", {
          kind: "partial_tool_availability",
          phase: "before_dispatch",
          retryable: false,
          backendOutcome: "not_started",
          detailCode: "quality_critical_capability_missing",
        }),
      };
    }
    if (qualityCritical && capability.qualityEquivalentFallbackAvailable) {
      return {
        state: "TRANSPORT_DEGRADED",
        action: "Select the explicitly declared quality-equivalent fallback policy before invoking; availability alone does not authorize implicit rerouting.",
        view,
        fault: new McpTransportFault(
          "A quality-equivalent fallback exists but has not been explicitly selected.",
          {
            kind: "partial_tool_availability",
            phase: "before_dispatch",
            retryable: false,
            backendOutcome: "not_started",
            detailCode: "typed_fallback_selection_required",
          },
        ),
      };
    }
    return {
      state: "TRANSPORT_DEGRADED",
      action: "Use only the explicitly typed available capability subset; do not improvise an unqualified fallback.",
      view,
      fault: new McpTransportFault("The MCP route has partial tool availability.", {
        kind: "partial_tool_availability",
        phase: "before_dispatch",
        retryable: false,
        backendOutcome: "not_started",
      }),
    };
  }

  private capabilityView(
    capability: McpCapabilityPolicy | undefined,
  ): McpCapabilityView | undefined {
    if (!capability) return undefined;
    const required = [...new Set(capability.requiredCapabilities ?? [])].sort();
    const available = [...new Set(capability.availableCapabilities ?? [])].sort();
    const availableSet = new Set(available);
    const missing = required.filter((entry) => !availableSet.has(entry));
    const qualityCritical = capability.freshEvidenceRequired
      || capability.validationReadbackRequired
      || capability.canonicalStateRequiredForMutation
      || capability.effectTransportRequired;
    let fallbackDisposition: McpCapabilityView["fallbackDisposition"] =
      "not_needed";
    if (missing.length > 0) {
      fallbackDisposition = capability.qualityEquivalentFallbackAvailable
        && Boolean(capability.fallbackPolicyRef?.trim())
        ? "quality_equivalent_available"
        : qualityCritical
          ? "denied_to_preserve_quality"
          : "not_available";
    }
    return {
      catalogFreshness: capability.catalogFreshness ?? "unknown",
      requiredCapabilities: required,
      availableCapabilities: available,
      missingCapabilities: missing,
      fallbackDisposition,
      fallbackPolicyRef: capability.fallbackPolicyRef,
    };
  }

  private classifyCallError<T>(
    call: McpSupervisedCall<T>,
    error: unknown,
    context: { dispatched: boolean; callerAborted: boolean },
  ): McpTransportFault {
    if (!call.classifyError) {
      const identity = transportIdentityFor(
        call as McpSupervisedCall<unknown>,
      );
      return classifyMcpTransportError(error, {
        ...context,
        protocolEra: identity.protocolEra,
        operationKind: call.operationKind,
      });
    }
    try {
      return call.classifyError(error, context);
    } catch (classifierError) {
      return new McpTransportFault(
        "The custom MCP error classifier failed; automatic retry is disabled.",
        {
          kind: "protocol_error",
          phase: context.dispatched ? "after_dispatch" : "unknown",
          retryable: false,
          backendOutcome: context.dispatched ? "unknown" : "not_started",
          detailCode: "custom_error_classifier_failed",
          source: classifierError,
        },
      );
    }
  }

  private async invokeWithTimeout<T>(
    call: McpSupervisedCall<T>,
    attempt: number,
    operationKey: string | undefined,
    timeoutMs: number,
    logicalCallId: string,
    attemptId: string,
    safetyClass: McpCallSafetyClass,
  ): Promise<TimedInvocationResult> {
    const controller = new AbortController();
    let dispatched = false;
    let timeout: NodeJS.Timeout | undefined;
    let callerAbortListener: (() => void) | undefined;
    if (call.signal) {
      callerAbortListener = () => controller.abort(call.signal?.reason);
      if (call.signal.aborted) callerAbortListener();
      else call.signal.addEventListener("abort", callerAbortListener, { once: true });
    }

    try {
      const invocation = Promise.resolve()
        .then(() => call.invoke({
          attempt,
          logicalCallId,
          attemptId,
          callSafetyClass: safetyClass,
          signal: controller.signal,
          operationKey,
          effectKey: call.effectKey,
          markDispatched: () => {
            dispatched = true;
          },
        }))
        .catch((error: unknown) => {
          throw new McpInvocationFailure(error, dispatched);
        });
      if (timeoutMs === 0) {
        return { raw: await invocation, dispatched };
      }
      const timedOut = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          controller.abort(new Error("mcp supervisor attempt timeout"));
          reject(new McpTransportFault(
            `The MCP attempt exceeded ${timeoutMs}ms without a usable response.`,
            {
              kind: "timeout_before_response",
              phase: call.retrySafety === "effectful"
                ? dispatched ? "after_dispatch" : "unknown"
                : dispatched ? "after_dispatch" : "before_dispatch",
              retryable: true,
              backendOutcome: dispatched ? "unknown" : "not_started",
              detailCode: "supervisor_attempt_timeout",
            },
          ));
        }, timeoutMs);
      });
      return { raw: await Promise.race([invocation, timedOut]), dispatched };
    } finally {
      if (timeout) clearTimeout(timeout);
      if (call.signal && callerAbortListener) {
        call.signal.removeEventListener("abort", callerAbortListener);
      }
    }
  }

  private effectMayHaveRun(fault: McpTransportFault): boolean {
    return fault.phase !== "before_dispatch"
      || fault.backendOutcome !== "not_started"
      || OUTPUT_FAULTS.has(fault.kind);
  }

  private retrySafe<T>(
    call: McpSupervisedCall<T>,
    operationKey: string | undefined,
    fault: McpTransportFault,
  ): boolean {
    if (!fault.retryable) return false;
    if (call.retrySafety === "read_only") return true;
    if (call.retrySafety === "idempotent") return operationKey !== undefined;
    return fault.phase === "before_dispatch"
      && fault.backendOutcome === "not_started";
  }

  private async reconnect<T>(
    call: McpSupervisedCall<T>,
    reason: McpTransportFault,
    policy: McpRetryPolicy,
    receiptContext: ExecutionReceiptContext,
    circuitKey: string,
  ): Promise<boolean> {
    if (!call.reconnect) return true;
    for (
      let attempt = 1;
      attempt <= policy.reconnectMaxAttempts;
      attempt += 1
    ) {
      const recoveryAttempt = this.beginAttempt(
        call,
        receiptContext,
        "reconnect",
        attempt,
        circuitKey,
      );
      this.mutableMetrics.recoveryActions += 1;
      this.mutableMetrics.ceremonyCalls += 1;
      try {
        await this.runRecoveryAction(
          (signal) => call.reconnect!({
            attempt,
            logicalCallId: receiptContext.logicalCallId,
            attemptId: recoveryAttempt.attemptId,
            signal,
            reason,
          }),
          policy.recoveryActionTimeoutMs,
          "bounded_reconnect_timeout",
          call.signal,
        );
        this.finishAttempt(receiptContext, recoveryAttempt, {
          requestDispatchCertainty: "dispatched",
          mcpResultOrErrorClass: "TRANSPORT_RECONNECTED",
          semanticOutputClass: "not_observed",
          effectReceiptOrTerminality: {
            state: call.retrySafety === "effectful"
              ? "unavailable"
              : "not_applicable",
          },
          outcome: "succeeded",
        });
        this.mutableMetrics.successfulRecoveryActions += 1;
        return true;
      } catch (error) {
        const fault = this.classifyCallError(call, error, {
          dispatched: false,
          callerAborted: call.signal?.aborted === true,
        });
        const failureClass = failureClassForFault(fault, call.operationKind);
        this.finishAttempt(receiptContext, recoveryAttempt, {
          requestDispatchCertainty: requestDispatchCertainty(false, fault),
          httpStatus: fault.httpStatus,
          mcpResultOrErrorClass: failureClass,
          semanticOutputClass: semanticOutputClassForFault(
            fault,
            "not_observed",
          ),
          effectReceiptOrTerminality: {
            state: call.retrySafety === "effectful"
              ? "unavailable"
              : "not_applicable",
          },
          failureClass,
          outcome: "failed",
        });
        if (
          !fault.retryable
          || attempt >= policy.reconnectMaxAttempts
          || !this.consumeRetryBudget()
        ) {
          return false;
        }
        await this.sleep(this.retryDelay(policy, attempt, fault));
      }
    }
    return false;
  }

  private async recoverLegacyStaleSession<T>(
    call: McpSupervisedCall<T>,
    reason: McpTransportFault,
    policy: McpRetryPolicy,
    receiptContext: ExecutionReceiptContext,
    circuitKey: string,
  ): Promise<RecoveryAttemptOutcome> {
    if (!call.recoverStaleSession) return { recovered: false };
    const recoveryAttempt = this.beginAttempt(
      call,
      receiptContext,
      "legacy_session_recreate",
      1,
      circuitKey,
    );
    this.mutableMetrics.recoveryActions += 1;
    this.mutableMetrics.ceremonyCalls += 1;
    try {
      await this.runRecoveryAction(
        (signal) => call.recoverStaleSession!({
          attempt: 1,
          logicalCallId: receiptContext.logicalCallId,
          attemptId: recoveryAttempt.attemptId,
          signal,
          reason,
        }),
        policy.recoveryActionTimeoutMs,
        "legacy_stale_session_recreate_timeout",
        call.signal,
      );
      this.finishAttempt(receiptContext, recoveryAttempt, {
        requestDispatchCertainty: "dispatched",
        httpStatus: 200,
        mcpResultOrErrorClass: "LEGACY_SESSION_RECREATED",
        semanticOutputClass: "not_observed",
        effectReceiptOrTerminality: {
          state: call.retrySafety === "effectful"
            ? "not_needed"
            : "not_applicable",
        },
        outcome: "succeeded",
      });
      this.mutableMetrics.successfulRecoveryActions += 1;
      return { recovered: true };
    } catch (error) {
      const fault = this.classifyCallError(call, error, {
        dispatched: false,
        callerAborted: call.signal?.aborted === true,
      });
      const failureClass = failureClassForFault(fault, call.operationKind);
      this.finishAttempt(receiptContext, recoveryAttempt, {
        requestDispatchCertainty: requestDispatchCertainty(false, fault),
        httpStatus: fault.httpStatus,
        mcpResultOrErrorClass: failureClass,
        semanticOutputClass: semanticOutputClassForFault(
          fault,
          "not_observed",
        ),
        effectReceiptOrTerminality: {
          state: call.retrySafety === "effectful"
            ? "not_needed"
            : "not_applicable",
        },
        failureClass,
        outcome: "failed",
      });
      return { recovered: false, fault };
    }
  }

  private async recoverSubscription<T>(
    call: McpSupervisedCall<T>,
    reason: McpTransportFault,
    policy: McpRetryPolicy,
    receiptContext: ExecutionReceiptContext,
    circuitKey: string,
    priorSubscriptionGeneration?: string,
  ): Promise<SubscriptionRecoveryAttempt> {
    if (!call.recoverSubscription) return {};
    let lastFault: McpTransportFault | undefined;
    for (
      let attempt = 1;
      attempt <= policy.reconnectMaxAttempts;
      attempt += 1
    ) {
      const recoveryAttempt = this.beginAttempt(
        call,
        receiptContext,
        "subscription_relisten",
        attempt,
        circuitKey,
        priorSubscriptionGeneration,
      );
      this.mutableMetrics.recoveryActions += 1;
      this.mutableMetrics.ceremonyCalls += 1;
      try {
        const result = await this.runRecoveryAction(
          (signal) => call.recoverSubscription!({
            attempt,
            logicalCallId: receiptContext.logicalCallId,
            attemptId: recoveryAttempt.attemptId,
            signal,
            reason,
            priorSubscriptionGeneration,
          }),
          policy.recoveryActionTimeoutMs,
          "subscription_relisten_timeout",
          call.signal,
        );
        const digestPattern = /^[a-f0-9]{64}$/;
        let subscriptionGenerationValid = true;
        try {
          safeReference(
            result.subscriptionGeneration,
            "subscriptionRecovery.subscriptionGeneration",
            1_024,
          );
        } catch {
          subscriptionGenerationValid = false;
        }
        const valid = result.forcedRefetch === true
          && subscriptionGenerationValid
          && digestPattern.test(result.expectedListFingerprintSha256)
          && digestPattern.test(result.observedListFingerprintSha256)
          && result.expectedListFingerprintSha256
            === result.observedListFingerprintSha256;
        if (!valid) {
          lastFault = new McpTransportFault(
            "The recovered subscription did not produce a matching forced-refetch tools/list fingerprint.",
            {
              kind: "client_catalog_stale",
              phase: "after_dispatch",
              retryable: false,
              backendOutcome: "succeeded",
              detailCode: "subscription_refetch_fingerprint_mismatch",
            },
          );
          this.finishAttempt(receiptContext, recoveryAttempt, {
            requestDispatchCertainty: "dispatched",
            mcpResultOrErrorClass: "SUBSCRIPTION_REFETCH_FINGERPRINT_MISMATCH",
            semanticOutputClass: "indeterminate",
            subscriptionGeneration: result.subscriptionGeneration,
            subscriptionRefetch: {
              forcedRefetch: true,
              expectedListFingerprintSha256:
                result.expectedListFingerprintSha256,
              observedListFingerprintSha256:
                result.observedListFingerprintSha256,
              evidenceRef: result.evidenceRef,
            },
            effectReceiptOrTerminality: { state: "not_applicable" },
            failureClass: "MCP_PROTOCOL_ERROR",
            outcome: "failed",
          });
          return { fault: lastFault };
        }
        this.finishAttempt(receiptContext, recoveryAttempt, {
          requestDispatchCertainty: "dispatched",
          mcpResultOrErrorClass:
            "SUBSCRIPTION_RELISTEN_AND_REFETCH_FINGERPRINT_VERIFIED",
          semanticOutputClass: "usable",
          subscriptionGeneration: result.subscriptionGeneration,
          subscriptionRefetch: {
            forcedRefetch: true,
            expectedListFingerprintSha256:
              result.expectedListFingerprintSha256,
            observedListFingerprintSha256:
              result.observedListFingerprintSha256,
            evidenceRef: result.evidenceRef,
          },
          effectReceiptOrTerminality: { state: "not_applicable" },
          outcome: "succeeded",
        });
        this.mutableMetrics.successfulRecoveryActions += 1;
        return { result };
      } catch (error) {
        lastFault = this.classifyCallError(call, error, {
          dispatched: false,
          callerAborted: call.signal?.aborted === true,
        });
        const failureClass = failureClassForFault(
          lastFault,
          call.operationKind,
        );
        this.finishAttempt(receiptContext, recoveryAttempt, {
          requestDispatchCertainty: requestDispatchCertainty(false, lastFault),
          httpStatus: lastFault.httpStatus,
          mcpResultOrErrorClass: failureClass,
          semanticOutputClass: semanticOutputClassForFault(
            lastFault,
            "not_observed",
          ),
          subscriptionGeneration: priorSubscriptionGeneration,
          effectReceiptOrTerminality: { state: "not_applicable" },
          failureClass,
          outcome: "failed",
        });
        if (
          !lastFault.retryable
          || attempt >= policy.reconnectMaxAttempts
          || !this.consumeRetryBudget()
        ) {
          break;
        }
        await this.sleep(this.retryDelay(policy, attempt, lastFault));
      }
    }
    return { fault: lastFault };
  }

  private async reconcileEffect<T>(
    call: McpSupervisedCall<T>,
    reason: McpTransportFault,
    policy: McpRetryPolicy,
    receiptContext: ExecutionReceiptContext,
    circuitKey: string,
  ): Promise<ReconciliationAttempt<T>> {
    if (!call.effectKey || !call.reconcileEffect) {
      return {
        fault: new McpTransportFault(
          "The effect result cannot be reconciled without an exact key and receipt route.",
          {
            kind: "indeterminate_effect_result",
            phase: "after_dispatch",
            retryable: false,
            backendOutcome: "unknown",
          },
        ),
      };
    }
    let lastFault: McpTransportFault | undefined;
    for (
      let attempt = 1;
      attempt <= policy.reconciliationMaxAttempts;
      attempt += 1
    ) {
      const reconciliationAttempt = this.beginAttempt(
        call,
        receiptContext,
        "effect_reconciliation",
        attempt,
        circuitKey,
      );
      this.mutableMetrics.recoveryActions += 1;
      this.mutableMetrics.ceremonyCalls += 1;
      try {
        const result = await this.runRecoveryAction(
          (signal) => call.reconcileEffect!({
            attempt,
            logicalCallId: receiptContext.logicalCallId,
            attemptId: reconciliationAttempt.attemptId,
            signal,
            effectKey: call.effectKey!,
            reason,
          }),
          policy.recoveryActionTimeoutMs,
          "effect_reconciliation_timeout",
          call.signal,
        );
        this.finishAttempt(receiptContext, reconciliationAttempt, {
          requestDispatchCertainty: "dispatched",
          mcpResultOrErrorClass:
            `EFFECT_RECONCILIATION_${result.state.toUpperCase()}`,
          semanticOutputClass: result.state === "indeterminate"
            ? "indeterminate"
            : "usable",
          effectReceiptOrTerminality: {
            state: result.state,
            receiptRef: "receiptRef" in result
              ? result.receiptRef
              : undefined,
          },
          outcome: result.state === "indeterminate"
            ? "indeterminate"
            : "succeeded",
        });
        this.mutableMetrics.successfulRecoveryActions += 1;
        return { result };
      } catch (error) {
        lastFault = this.classifyCallError(call, error, {
          dispatched: false,
          callerAborted: call.signal?.aborted === true,
        });
        const failureClass = failureClassForFault(
          lastFault,
          call.operationKind,
        );
        this.finishAttempt(receiptContext, reconciliationAttempt, {
          requestDispatchCertainty: requestDispatchCertainty(false, lastFault),
          httpStatus: lastFault.httpStatus,
          mcpResultOrErrorClass: failureClass,
          semanticOutputClass: semanticOutputClassForFault(
            lastFault,
            "not_observed",
          ),
          effectReceiptOrTerminality: { state: "unavailable" },
          failureClass,
          outcome: "failed",
        });
        if (
          !lastFault.retryable
          || attempt >= policy.reconciliationMaxAttempts
          || !this.consumeRetryBudget()
        ) {
          break;
        }
        await this.sleep(this.retryDelay(policy, attempt, lastFault));
      }
    }
    return { fault: lastFault };
  }

  private async runRecoveryAction<T>(
    action: (signal: AbortSignal) => Promise<T>,
    timeoutMs: number,
    detailCode: string,
    callerSignal?: AbortSignal,
  ): Promise<T> {
    if (callerSignal?.aborted) {
      throw new McpTransportFault(
        "The caller cancelled before the recovery action was dispatched.",
        {
          kind: "caller_cancelled",
          phase: "before_dispatch",
          retryable: false,
          backendOutcome: "not_started",
          detailCode: "recovery_cancelled_before_dispatch",
        },
      );
    }
    const controller = new AbortController();
    let timeout: NodeJS.Timeout | undefined;
    let callerAbortListener: (() => void) | undefined;
    if (callerSignal) {
      callerAbortListener = () => controller.abort(callerSignal.reason);
      callerSignal.addEventListener("abort", callerAbortListener, { once: true });
    }
    try {
      const actionPromise = Promise.resolve().then(() => action(controller.signal));
      if (timeoutMs === 0) return await actionPromise;
      const timedOut = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          controller.abort(new Error(detailCode));
          reject(new McpTransportFault("A bounded recovery action timed out.", {
            kind: "timeout_before_response",
            phase: "before_dispatch",
            retryable: true,
            backendOutcome: "not_started",
            detailCode,
          }));
        }, timeoutMs);
      });
      return await Promise.race([actionPromise, timedOut]);
    } finally {
      if (timeout) clearTimeout(timeout);
      if (callerSignal && callerAbortListener) {
        callerSignal.removeEventListener("abort", callerAbortListener);
      }
    }
  }

  private retryDelay(
    policy: McpRetryPolicy,
    retryNumber: number,
    fault: McpTransportFault,
  ): number {
    if (fault.retryAfterMs !== undefined) {
      return Math.min(policy.maxDelayMs, Math.max(0, fault.retryAfterMs));
    }
    const base = Math.min(
      policy.maxDelayMs,
      policy.initialDelayMs * Math.pow(policy.growFactor, retryNumber - 1),
    );
    if (base === 0 || policy.jitterRatio === 0) return base;
    const randomCentered = Math.max(0, Math.min(1, this.random())) * 2 - 1;
    return Math.max(0, Math.round(
      base * (1 + randomCentered * policy.jitterRatio),
    ));
  }

  private consumeRetryBudget(): boolean {
    const nowMs = this.now();
    const elapsedSeconds = Math.max(
      0,
      (nowMs - this.retryBudgetUpdatedAtMs) / 1_000,
    );
    this.retryTokens = Math.min(
      this.retryBudgetPolicy.capacity,
      this.retryTokens
        + elapsedSeconds * this.retryBudgetPolicy.refillPerSecond,
    );
    this.retryBudgetUpdatedAtMs = nowMs;
    if (this.retryTokens < 1) return false;
    this.retryTokens -= 1;
    return true;
  }

  private admitCircuit(circuitKey: string, nowMs: number): CircuitAdmission {
    const record = this.circuits.get(circuitKey) ?? {
      state: "closed" as const,
      consecutiveFailures: 0,
      identicalFailureCount: 0,
      halfOpenProbeInFlight: false,
      lastTouchedAtMs: nowMs,
    };
    record.lastTouchedAtMs = nowMs;
    this.circuits.set(circuitKey, record);
    this.enforceCircuitBound();
    if (record.state === "open") {
      const openUntilMs = (record.openedAtMs ?? nowMs)
        + this.circuitPolicy.openDurationMs;
      if (nowMs < openUntilMs) {
        return { allowed: false, view: this.circuitView(circuitKey, nowMs) };
      }
      record.state = "half_open";
      record.halfOpenProbeInFlight = false;
    }
    if (record.state === "half_open") {
      if (record.halfOpenProbeInFlight) {
        return { allowed: false, view: this.circuitView(circuitKey, nowMs) };
      }
      record.halfOpenProbeInFlight = true;
    }
    return { allowed: true, view: this.circuitView(circuitKey, nowMs) };
  }

  private recordCircuitFailure(
    circuitKey: string,
    fingerprint: string,
  ): boolean {
    const nowMs = this.now();
    const record = this.circuits.get(circuitKey) ?? {
      state: "closed" as const,
      consecutiveFailures: 0,
      identicalFailureCount: 0,
      halfOpenProbeInFlight: false,
      lastTouchedAtMs: nowMs,
    };
    record.lastTouchedAtMs = nowMs;
    const wasOpen = record.state === "open";
    record.consecutiveFailures += 1;
    if (record.lastFailureFingerprint === fingerprint) {
      record.identicalFailureCount += 1;
    } else {
      record.lastFailureFingerprint = fingerprint;
      record.identicalFailureCount = 1;
    }
    record.halfOpenProbeInFlight = false;
    const shouldOpen = record.state === "half_open"
      || record.consecutiveFailures >= this.circuitPolicy.failureThreshold
      || record.identicalFailureCount
        >= this.circuitPolicy.identicalFailureThreshold;
    if (shouldOpen) {
      record.state = "open";
      record.openedAtMs = nowMs;
      if (!wasOpen) this.mutableMetrics.circuitTrips += 1;
    }
    this.circuits.set(circuitKey, record);
    this.enforceCircuitBound();
    return shouldOpen;
  }

  private recordCircuitSuccess(circuitKey: string): void {
    const nowMs = this.now();
    this.circuits.set(circuitKey, {
      state: "closed",
      consecutiveFailures: 0,
      identicalFailureCount: 0,
      halfOpenProbeInFlight: false,
      lastTouchedAtMs: nowMs,
    });
    this.enforceCircuitBound();
  }

  private circuitView(circuitKey: string, nowMs: number): McpCircuitView {
    const record = this.circuits.get(circuitKey) ?? {
      state: "closed" as const,
      consecutiveFailures: 0,
      identicalFailureCount: 0,
      halfOpenProbeInFlight: false,
      lastTouchedAtMs: nowMs,
    };
    const openUntilMs = record.state === "open"
      ? (record.openedAtMs ?? nowMs) + this.circuitPolicy.openDurationMs
      : undefined;
    return {
      key: circuitKey,
      state: record.state,
      consecutiveFailures: record.consecutiveFailures,
      identicalFailureCount: record.identicalFailureCount,
      openUntil: openUntilMs === undefined
        ? undefined
        : new Date(openUntilMs).toISOString(),
    };
  }

  private pruneCircuits(nowMs: number): void {
    for (const [key, record] of this.circuits) {
      if (
        record.state === "closed"
        && nowMs - record.lastTouchedAtMs >= this.circuitPolicy.idleTtlMs
      ) {
        this.circuits.delete(key);
      }
    }
    this.enforceCircuitBound();
  }

  private enforceCircuitBound(): void {
    const overflow = this.circuits.size - this.circuitPolicy.maxEntries;
    if (overflow <= 0) return;
    const candidates = [...this.circuits.entries()].sort((left, right) => {
      const stateRank = (record: CircuitRecord): number => {
        if (record.state === "closed") return 0;
        if (record.state === "open") return 1;
        return 2;
      };
      const rankDelta = stateRank(left[1]) - stateRank(right[1]);
      if (rankDelta !== 0) return rankDelta;
      return left[1].lastTouchedAtMs - right[1].lastTouchedAtMs;
    });
    for (let index = 0; index < overflow; index += 1) {
      const candidate = candidates[index];
      if (candidate) this.circuits.delete(candidate[0]);
    }
  }

  private recordFaultMetrics(fault: McpTransportFault): void {
    if (fault.kind === "timeout_before_response"
      || fault.kind === "delayed_response") {
      this.mutableMetrics.timeouts += 1;
    }
    if (DROP_FAULTS.has(fault.kind)) this.mutableMetrics.drops += 1;
    if (OUTPUT_FAULTS.has(fault.kind)
      || fault.kind === "indeterminate_effect_result") {
      this.mutableMetrics.missingOutputs += 1;
    }
  }

  private storeReceipt<T>(
    call: McpSupervisedCall<T>,
    operationKey: string | undefined,
    receipt: CachedReceipt,
  ): void {
    const storedReceipt: CachedReceipt = {
      ...receipt,
      receiptRef: exposedEvidenceRef(
        receipt.receiptRef,
        "cachedReceipt.receiptRef",
      ),
      completenessEvidenceRef: exposedEvidenceRef(
        receipt.completenessEvidenceRef,
        "cachedReceipt.completenessEvidenceRef",
      ),
      idempotencyEvidenceRef: exposedEvidenceRef(
        receipt.idempotencyEvidenceRef,
        "cachedReceipt.idempotencyEvidenceRef",
      ),
      effectReconciliationReceiptRef: exposedEvidenceRef(
        receipt.effectReconciliationReceiptRef,
        "cachedReceipt.effectReconciliationReceiptRef",
      ),
      effectReconciliationEvidenceRefs:
        receipt.effectReconciliationEvidenceRefs?.map(
          (reference, index) => exposedEvidenceRef(
            reference,
            `cachedReceipt.effectReconciliationEvidenceRefs[${index}]`,
          )!,
        ),
    };
    if (operationKey) {
      this.operationReceipts.set(
        operationReceiptKey(call.backendRef, call.toolRef, operationKey),
        storedReceipt,
      );
    }
    if (storedReceipt.deliveryId) {
      this.deliveryReceipts.set(
        deliveryReceiptKey(
          call.backendRef,
          call.toolRef,
          storedReceipt.deliveryId,
        ),
        storedReceipt,
      );
    }
    this.enforceReceiptBound();
  }

  private pruneReceipts(nowMs: number): void {
    const cutoff = nowMs - this.receiptPolicy.ttlMs;
    for (const [key, receipt] of this.operationReceipts) {
      if (receipt.storedAtMs < cutoff) this.operationReceipts.delete(key);
    }
    for (const [key, receipt] of this.deliveryReceipts) {
      if (receipt.storedAtMs < cutoff) this.deliveryReceipts.delete(key);
    }
    this.enforceReceiptBound();
  }

  private enforceReceiptBound(): void {
    while (this.operationReceipts.size > this.receiptPolicy.maxEntries) {
      const oldest = this.operationReceipts.keys().next().value as
        | string
        | undefined;
      if (oldest === undefined) break;
      this.operationReceipts.delete(oldest);
    }
    while (this.deliveryReceipts.size > this.receiptPolicy.maxEntries) {
      const oldest = this.deliveryReceipts.keys().next().value as
        | string
        | undefined;
      if (oldest === undefined) break;
      this.deliveryReceipts.delete(oldest);
    }
  }

  private terminalState<T>(
    call: McpSupervisedCall<T>,
    fault: McpTransportFault,
  ): Exclude<McpTransportSupervisorState, "TRANSIENT_RETRYING"> {
    if (call.retrySafety === "effectful" || call.lane === "effect") {
      return "EFFECT_LANE_BLOCKED";
    }
    if (fault.kind === "client_catalog_stale") return "CLIENT_CATALOG_STALE";
    if (fault.kind === "caller_cancelled"
      || fault.kind === "external_blocker"
      || fault.kind === "authentication_failure"
      || fault.kind === "protocol_negotiation_unsupported"
      || fault.kind === "tool_result_error"
      || (fault.kind === "http_non_success" && !fault.retryable)) {
      return "HARD_EXTERNAL_BLOCKER";
    }
    if (OUTPUT_FAULTS.has(fault.kind)
      || fault.kind === "indeterminate_effect_result") {
      return "OUTPUT_INDETERMINATE";
    }
    return "TRANSPORT_DEGRADED";
  }

  private terminalAction<T>(
    call: McpSupervisedCall<T>,
    state: Exclude<McpTransportSupervisorState, "TRANSIENT_RETRYING">,
    fault: McpTransportFault,
  ): string {
    if (state === "EFFECT_LANE_BLOCKED") {
      return "Freeze only the effect lane and reconcile the exact effect key/receipt before retry.";
    }
    if (state === "OUTPUT_INDETERMINATE") {
      if (call.lane === "validation") {
        return "Do not claim validation. Restore a complete readback route before continuing.";
      }
      if (call.lane === "research") {
        return "Do not treat missing or truncated evidence as fresh research; restore the evidence route.";
      }
      return "Do not consume or claim the output. Retry later only through the bounded safe policy.";
    }
    if (state === "HARD_EXTERNAL_BLOCKER") {
      return "Stop this dependency lane and preserve the current causal frontier; quality reduction is not authorized.";
    }
    if (fault.kind === "circuit_open") {
      return "Wait for the circuit half-open probe; do not repeat the identical failing call.";
    }
    return "Use only a typed quality-equivalent route or resume the primary path after transport health recovers.";
  }

  private successResult<T>(
    call: McpSupervisedCall<T>,
    data: {
      value: T;
      source: McpSupervisedResult<T>["source"];
      state: "HEALTHY" | "RECOVERED";
      attempts: number;
      retries: number;
      recovered: boolean;
      action: string;
      circuitKey: string;
      receiptRef?: string;
      completenessEvidenceRef?: string;
      idempotencyEvidenceRef?: string;
      effectReconciliationState?: McpSupervisedResult<T>["evidence"]["effectReconciliationState"];
      effectReconciliationReceiptRef?: string;
      effectReconciliationEvidenceRefs?: readonly string[];
    },
    operationStartedAtMs: number,
    receiptContext: ExecutionReceiptContext,
    recoveryStartedAtMs?: number,
  ): McpSupervisedResult<T> {
    this.recordCompletion(operationStartedAtMs, recoveryStartedAtMs);
    const effectReconciliationState = data.effectReconciliationState
      ?? (call.retrySafety === "effectful" ? "not_needed" : "not_applicable");
    const effectReconciled = effectReconciliationState === "succeeded"
      || effectReconciliationState === "not_applied"
      || effectReconciliationState === "terminal_failure";
    return {
      schemaVersion: MCP_TRANSPORT_SUPERVISOR_RESULT_SCHEMA,
      operationRef: call.operationRef,
      logicalCallId: receiptContext.logicalCallId,
      callSafetyClass: receiptContext.callSafetyClass,
      toolRef: call.toolRef,
      lane: call.lane,
      state: data.state,
      ok: true,
      value: data.value,
      source: data.source,
      attemptCount: data.attempts,
      retryCount: data.retries,
      recovered: data.recovered,
      action: data.action,
      capability: this.capabilityView(call.capability),
      circuit: this.circuitView(data.circuitKey, this.now()),
      recoveryReceipt: this.recoveryReceipt(
        receiptContext,
        data.state,
      ),
      evidence: {
        outputUsable: true,
        completenessEvidenceRef: exposedEvidenceRef(
          data.completenessEvidenceRef,
          "result.completenessEvidenceRef",
        ),
        receiptRef: exposedEvidenceRef(
          data.receiptRef,
          "result.receiptRef",
        ),
        idempotencyEvidenceRef: exposedEvidenceRef(
          data.idempotencyEvidenceRef,
          "result.idempotencyEvidenceRef",
        ),
        effectReconciled,
        effectReconciliationState,
        effectReconciliationReceiptRef:
          exposedEvidenceRef(
            data.effectReconciliationReceiptRef,
            "result.effectReconciliationReceiptRef",
          ),
        effectReconciliationEvidenceRefs:
          data.effectReconciliationEvidenceRefs === undefined
            ? undefined
            : data.effectReconciliationEvidenceRefs.map(
                (reference, index) => exposedEvidenceRef(
                  reference,
                  `result.effectReconciliationEvidenceRefs[${index}]`,
                )!,
              ),
        effectLaneFrozen: false,
        validationClaimAllowed: call.lane !== "validation"
          || data.completenessEvidenceRef !== undefined
          || data.receiptRef !== undefined,
        qualityReductionAuthorized: false,
        newEffectAuthorityGranted: false,
      },
    };
  }

  private failureResult<T>(
    call: McpSupervisedCall<T>,
    state: Exclude<McpTransportSupervisorState, "TRANSIENT_RETRYING">,
    action: string,
    fault: McpTransportFault,
    attempts: number,
    retries: number,
    circuitKey: string,
    operationStartedAtMs: number,
    receiptContext: ExecutionReceiptContext,
    capability?: McpCapabilityView,
    recoveryStartedAtMs?: number,
    evidenceOverrides: ResultEvidenceOverrides = {},
  ): McpSupervisedResult<T> {
    this.recordCompletion(operationStartedAtMs, recoveryStartedAtMs);
    const effectReconciliationState =
      evidenceOverrides.effectReconciliationState
      ?? (call.retrySafety === "effectful" || call.lane === "effect"
        ? "unavailable"
        : "not_applicable");
    const effectReconciled = effectReconciliationState === "succeeded"
      || effectReconciliationState === "not_applied"
      || effectReconciliationState === "terminal_failure";
    return {
      schemaVersion: MCP_TRANSPORT_SUPERVISOR_RESULT_SCHEMA,
      operationRef: call.operationRef,
      logicalCallId: receiptContext.logicalCallId,
      callSafetyClass: receiptContext.callSafetyClass,
      toolRef: call.toolRef,
      lane: call.lane,
      state,
      ok: false,
      source: "policy_gate",
      attemptCount: attempts,
      retryCount: retries,
      recovered: false,
      action,
      failure: {
        kind: fault.kind,
        failureClass: failureClassForFault(fault, call.operationKind),
        phase: fault.phase,
        retryable: fault.retryable,
        backendOutcome: fault.backendOutcome,
        detailCode: exposedDetailCode(fault.detailCode),
        httpStatus: fault.httpStatus,
        protocolCode: fault.protocolCode,
        fingerprintSha256: failureFingerprint(
          call.toolRef,
          fault,
          call.operationKind,
        ),
      },
      capability,
      circuit: this.circuitView(circuitKey, this.now()),
      recoveryReceipt: this.recoveryReceipt(receiptContext, state),
      evidence: {
        outputUsable: false,
        completenessEvidenceRef: exposedEvidenceRef(
          evidenceOverrides.completenessEvidenceRef,
          "failure.completenessEvidenceRef",
        ),
        receiptRef: exposedEvidenceRef(
          evidenceOverrides.receiptRef,
          "failure.receiptRef",
        ),
        idempotencyEvidenceRef: exposedEvidenceRef(
          call.idempotencyEvidenceRef,
          "failure.idempotencyEvidenceRef",
        ),
        effectReconciled,
        effectReconciliationState,
        effectReconciliationReceiptRef:
          exposedEvidenceRef(
            evidenceOverrides.effectReconciliationReceiptRef,
            "failure.effectReconciliationReceiptRef",
          ),
        effectReconciliationEvidenceRefs:
          evidenceOverrides.effectReconciliationEvidenceRefs === undefined
            ? undefined
            : evidenceOverrides.effectReconciliationEvidenceRefs.map(
                (reference, index) => exposedEvidenceRef(
                  reference,
                  `failure.effectReconciliationEvidenceRefs[${index}]`,
                )!,
              ),
        effectLaneFrozen: state === "EFFECT_LANE_BLOCKED",
        validationClaimAllowed: false,
        qualityReductionAuthorized: false,
        newEffectAuthorityGranted: false,
      },
    };
  }

  private emitTransition<T>(
    call: McpSupervisedCall<T>,
    transition: Omit<
      McpSupervisorTransition,
      | "schemaVersion"
      | "observedAt"
      | "operationRef"
      | "logicalCallId"
      | "toolRef"
    >,
  ): void {
    if (!call.onTransition) return;
    try {
      call.onTransition({
        schemaVersion: 1,
        observedAt: new Date(this.now()).toISOString(),
        operationRef: call.operationRef,
        logicalCallId: call.logicalCallId?.trim() || call.operationRef,
        toolRef: call.toolRef,
        ...transition,
      });
    } catch {
      // Observability hooks must never change retry or effect semantics.
    }
  }

  private recordCompletion(
    operationStartedAtMs: number,
    recoveryStartedAtMs?: number,
  ): void {
    const completedAtMs = this.now();
    this.latencySamples.push(Math.max(0, completedAtMs - operationStartedAtMs));
    if (this.latencySamples.length > this.latencySampleSize) {
      this.latencySamples.splice(
        0,
        this.latencySamples.length - this.latencySampleSize,
      );
    }
    if (recoveryStartedAtMs !== undefined) {
      this.mutableMetrics.infrastructureRecoveryMs += Math.max(
        0,
        completedAtMs - recoveryStartedAtMs,
      );
    }
  }

  private mutableAttemptCount(maxAttempts: number, retries: number): number {
    return Math.min(maxAttempts, Math.max(1, retries + 1));
  }
}
