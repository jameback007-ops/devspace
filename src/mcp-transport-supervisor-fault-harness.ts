import {
  McpTransportFault,
  type McpCapabilityPolicy,
  type McpEffectReconciliation,
  type McpEffectReconciliationContext,
  type McpInvocationContext,
  type McpOutputAssessment,
  type McpReconnectContext,
  type McpStaleSessionRecoveryContext,
  type McpSubscriptionRecoveryContext,
  type McpSubscriptionRecoveryResult,
} from "./mcp-transport-supervisor.js";

export const MCP_RELIABILITY_FAULT_SCENARIOS = [
  "success",
  "timeout_before_response",
  "disconnect_during_call",
  "backend_success_response_lost",
  "empty_output",
  "truncated_output",
  "duplicate_delivery",
  "delayed_response",
  "backend_restart",
  "stale_connection",
  "legacy_unknown_session",
  "subscription_closed",
  "tool_result_error",
  "cancelled_after_dispatch",
  "partial_tool_availability",
  "indeterminate_effect_result",
] as const;

export type McpReliabilityFaultScenario =
  (typeof MCP_RELIABILITY_FAULT_SCENARIOS)[number];

type HarnessOutput<T> =
  | {
      harnessOutput: "usable";
      value: T;
      deliveryId: string;
      receiptRef?: string;
      completenessEvidenceRef?: string;
    }
  | {
      harnessOutput: "empty";
      reason: string;
    }
  | {
      harnessOutput: "truncated";
      reason: string;
    }
  | {
      harnessOutput: "tool_error";
      reason: string;
      explicitlyTransient: boolean;
    };

export interface McpReliabilityFaultHarnessOptions<T> {
  successValue: T;
  delayedResponseMs?: number;
  duplicateDeliveryId?: string;
  reconnectFailuresBeforeSuccess?: number;
  completenessEvidenceRef?: string;
  toolErrorTransient?: boolean;
  subscriptionFingerprintMismatch?: boolean;
}

export interface McpReliabilityFaultHarnessSnapshot {
  pendingScenarios: McpReliabilityFaultScenario[];
  invocations: number;
  reconnects: number;
  staleSessionRecreations: number;
  subscriptionRelistens: number;
  reconciliations: number;
  backendEffects: number;
  connected: boolean;
  connectionGeneration: number;
  subscriptionGeneration: number;
  effectReceiptKeys: string[];
}

interface EffectReceipt<T> {
  value: T;
  receiptRef: string;
  deliveryId: string;
}

function delay(delayMs: number, signal: AbortSignal): Promise<void> {
  if (delayMs <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined;
    const cleanup = () => signal.removeEventListener("abort", abort);
    const complete = () => {
      cleanup();
      resolve();
    };
    const abort = () => {
      if (timer) clearTimeout(timer);
      cleanup();
      const error = new Error("fault harness delay aborted");
      error.name = "AbortError";
      reject(error);
    };
    timer = setTimeout(complete, delayMs);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

/**
 * Deterministic scripted transport used to verify retry, reconnect, output,
 * circuit-breaker, and effect-reconciliation behavior without touching a live
 * MCP backend. Each invocation consumes exactly one queued scenario.
 */
export class McpReliabilityFaultHarness<T> {
  private readonly scenarios: McpReliabilityFaultScenario[];
  private readonly options: Required<
    Omit<
      McpReliabilityFaultHarnessOptions<T>,
      "successValue" | "completenessEvidenceRef"
    >
  > & Pick<
    McpReliabilityFaultHarnessOptions<T>,
    "successValue" | "completenessEvidenceRef"
  >;
  private readonly effectReceipts = new Map<string, EffectReceipt<T>>();
  private invocationCount = 0;
  private reconnectCount = 0;
  private staleSessionRecreationCount = 0;
  private subscriptionRelistenCount = 0;
  private reconciliationCount = 0;
  private backendEffectCount = 0;
  private connected = true;
  private connectionGeneration = 1;
  private subscriptionGeneration = 1;
  private remainingReconnectFailures: number;

  constructor(
    scenarios: readonly McpReliabilityFaultScenario[],
    options: McpReliabilityFaultHarnessOptions<T>,
  ) {
    this.scenarios = [...scenarios];
    this.options = {
      ...options,
      delayedResponseMs: options.delayedResponseMs ?? 25,
      duplicateDeliveryId:
        options.duplicateDeliveryId ?? "fault-harness:duplicate-delivery",
      reconnectFailuresBeforeSuccess:
        options.reconnectFailuresBeforeSuccess ?? 0,
      toolErrorTransient: options.toolErrorTransient ?? false,
      subscriptionFingerprintMismatch:
        options.subscriptionFingerprintMismatch ?? false,
    };
    this.remainingReconnectFailures =
      this.options.reconnectFailuresBeforeSuccess;
  }

  enqueue(...scenarios: McpReliabilityFaultScenario[]): void {
    this.scenarios.push(...scenarios);
  }

  snapshot(): McpReliabilityFaultHarnessSnapshot {
    return {
      pendingScenarios: [...this.scenarios],
      invocations: this.invocationCount,
      reconnects: this.reconnectCount,
      staleSessionRecreations: this.staleSessionRecreationCount,
      subscriptionRelistens: this.subscriptionRelistenCount,
      reconciliations: this.reconciliationCount,
      backendEffects: this.backendEffectCount,
      connected: this.connected,
      connectionGeneration: this.connectionGeneration,
      subscriptionGeneration: this.subscriptionGeneration,
      effectReceiptKeys: [...this.effectReceipts.keys()].sort(),
    };
  }

  partialToolAvailabilityPolicy(options: {
    requiredCapabilities?: readonly string[];
    availableCapabilities?: readonly string[];
    catalogFreshness?: McpCapabilityPolicy["catalogFreshness"];
    freshEvidenceRequired?: boolean;
    validationReadbackRequired?: boolean;
    canonicalStateRequiredForMutation?: boolean;
    effectTransportRequired?: boolean;
    qualityEquivalentFallbackAvailable?: boolean;
    fallbackPolicyRef?: string;
  } = {}): McpCapabilityPolicy {
    return {
      catalogFreshness: options.catalogFreshness ?? "fresh",
      requiredCapabilities:
        options.requiredCapabilities ?? ["research.fetch", "workspace.read"],
      availableCapabilities:
        options.availableCapabilities ?? ["workspace.read"],
      freshEvidenceRequired: options.freshEvidenceRequired,
      validationReadbackRequired: options.validationReadbackRequired,
      canonicalStateRequiredForMutation:
        options.canonicalStateRequiredForMutation,
      effectTransportRequired: options.effectTransportRequired,
      qualityEquivalentFallbackAvailable:
        options.qualityEquivalentFallbackAvailable,
      fallbackPolicyRef: options.fallbackPolicyRef,
    };
  }

  readonly invoke = async (context: McpInvocationContext): Promise<unknown> => {
    this.invocationCount += 1;
    const scenario = this.scenarios.shift() ?? "success";
    const deliveryId = `fault-harness:g${this.connectionGeneration}:call-${this.invocationCount}`;

    switch (scenario) {
      case "success": {
        context.markDispatched();
        return this.successOutput(context, deliveryId);
      }
      case "timeout_before_response": {
        throw new McpTransportFault(
          "Injected timeout before request dispatch.",
          {
            kind: "timeout_before_response",
            phase: "before_dispatch",
            retryable: true,
            backendOutcome: "not_started",
            detailCode: "fault_injection:timeout_before_response",
          },
        );
      }
      case "disconnect_during_call": {
        context.markDispatched();
        this.connected = false;
        throw new McpTransportFault(
          "Injected disconnect after request dispatch.",
          {
            kind: "disconnect_during_call",
            phase: "after_dispatch",
            retryable: true,
            backendOutcome: "unknown",
            detailCode: "fault_injection:disconnect_during_call",
          },
        );
      }
      case "backend_success_response_lost": {
        context.markDispatched();
        if (context.effectKey) {
          this.recordEffect(context.effectKey, deliveryId);
        }
        throw new McpTransportFault(
          "Injected backend success followed by response loss.",
          {
            kind: "response_lost_after_success",
            phase: "after_dispatch",
            retryable: true,
            backendOutcome: "succeeded",
            detailCode: "fault_injection:backend_success_response_lost",
          },
        );
      }
      case "empty_output": {
        context.markDispatched();
        return {
          harnessOutput: "empty",
          reason: "Injected empty tool output.",
        } satisfies HarnessOutput<T>;
      }
      case "truncated_output": {
        context.markDispatched();
        return {
          harnessOutput: "truncated",
          reason: "Injected truncated tool output.",
        } satisfies HarnessOutput<T>;
      }
      case "duplicate_delivery": {
        context.markDispatched();
        return this.successOutput(
          context,
          this.options.duplicateDeliveryId,
        );
      }
      case "delayed_response": {
        context.markDispatched();
        await delay(this.options.delayedResponseMs, context.signal);
        return this.successOutput(context, deliveryId);
      }
      case "backend_restart": {
        context.markDispatched();
        this.connected = false;
        throw new McpTransportFault(
          "Injected backend restart during request processing.",
          {
            kind: "backend_restart",
            phase: "after_dispatch",
            retryable: true,
            backendOutcome: "unknown",
            detailCode: "fault_injection:backend_restart",
          },
        );
      }
      case "stale_connection": {
        this.connected = false;
        throw new McpTransportFault(
          "Injected stale MCP session before dispatch.",
          {
            kind: "stale_connection",
            phase: "before_dispatch",
            retryable: true,
            backendOutcome: "not_started",
            detailCode: "fault_injection:stale_connection",
          },
        );
      }
      case "legacy_unknown_session": {
        this.connected = false;
        throw new McpTransportFault(
          "Injected typed legacy Unknown MCP session response.",
          {
            kind: "legacy_stale_session_pre_dispatch",
            phase: "before_dispatch",
            retryable: true,
            backendOutcome: "not_started",
            detailCode: "fault_injection:legacy_unknown_session",
            httpStatus: 404,
            protocolCode: -32000,
          },
        );
      }
      case "subscription_closed": {
        throw new McpTransportFault(
          "Injected closed modern subscription.",
          {
            kind: "subscription_closed",
            phase: "before_dispatch",
            retryable: true,
            backendOutcome: "not_started",
            detailCode: "fault_injection:subscription_closed",
          },
        );
      }
      case "tool_result_error": {
        context.markDispatched();
        return {
          harnessOutput: "tool_error",
          reason: "Injected MCP tool application error.",
          explicitlyTransient: this.options.toolErrorTransient ?? false,
        } satisfies HarnessOutput<T>;
      }
      case "cancelled_after_dispatch": {
        context.markDispatched();
        throw new McpTransportFault(
          "Injected cooperative cancellation after dispatch.",
          {
            kind: "caller_cancelled",
            phase: "after_dispatch",
            retryable: false,
            backendOutcome: "unknown",
            detailCode: "fault_injection:cancelled_after_dispatch",
          },
        );
      }
      case "partial_tool_availability": {
        throw new McpTransportFault(
          "Injected partial MCP tool availability.",
          {
            kind: "partial_tool_availability",
            phase: "before_dispatch",
            retryable: false,
            backendOutcome: "not_started",
            detailCode: "fault_injection:partial_tool_availability",
          },
        );
      }
      case "indeterminate_effect_result": {
        context.markDispatched();
        if (context.effectKey) this.backendEffectCount += 1;
        throw new McpTransportFault(
          "Injected material effect with no authoritative outcome receipt.",
          {
            kind: "indeterminate_effect_result",
            phase: "after_dispatch",
            retryable: false,
            backendOutcome: "unknown",
            detailCode: "fault_injection:indeterminate_effect_result",
          },
        );
      }
    }
  };

  readonly reconnect = async (
    _context: McpReconnectContext,
  ): Promise<void> => {
    this.reconnectCount += 1;
    if (this.remainingReconnectFailures > 0) {
      this.remainingReconnectFailures -= 1;
      throw new McpTransportFault("Injected reconnect failure.", {
        kind: "disconnect_during_call",
        phase: "before_dispatch",
        retryable: true,
        backendOutcome: "not_started",
        detailCode: "fault_injection:reconnect_failure",
      });
    }
    this.connected = true;
    this.connectionGeneration += 1;
  };

  readonly recoverStaleSession = async (
    _context: McpStaleSessionRecoveryContext,
  ): Promise<void> => {
    this.staleSessionRecreationCount += 1;
    this.connected = true;
    this.connectionGeneration += 1;
  };

  readonly recoverSubscription = async (
    _context: McpSubscriptionRecoveryContext,
  ): Promise<McpSubscriptionRecoveryResult> => {
    this.subscriptionRelistenCount += 1;
    this.subscriptionGeneration += 1;
    const expected = "a".repeat(64);
    return {
      subscriptionGeneration:
        `fault-harness:subscription:${this.subscriptionGeneration}`,
      forcedRefetch: true,
      expectedListFingerprintSha256: expected,
      observedListFingerprintSha256:
        this.options.subscriptionFingerprintMismatch
          ? "b".repeat(64)
          : expected,
      evidenceRef: "fault-harness:subscription-refetch",
    };
  };

  readonly reconcileEffect = async (
    context: McpEffectReconciliationContext,
  ): Promise<McpEffectReconciliation<T>> => {
    this.reconciliationCount += 1;
    const receipt = this.effectReceipts.get(context.effectKey);
    if (!receipt) {
      return {
        state: "indeterminate",
        reason: "Fault harness has no terminal receipt for the effect key.",
        evidenceRefs: ["fault-harness:effect-receipt-missing"],
      };
    }
    return {
      state: "succeeded",
      value: receipt.value,
      receiptRef: receipt.receiptRef,
      deliveryId: receipt.deliveryId,
    };
  };

  readonly assessOutput = (raw: unknown): McpOutputAssessment<T> => {
    if (
      typeof raw !== "object"
      || raw === null
      || !("harnessOutput" in raw)
    ) {
      return {
        status: "indeterminate",
        reason: "Fault harness received an unknown output envelope.",
        evidenceRef: "fault-harness:unknown-output-envelope",
      };
    }
    const output = raw as HarnessOutput<T>;
    if (output.harnessOutput === "empty") {
      return { status: "empty", reason: output.reason };
    }
    if (output.harnessOutput === "truncated") {
      return { status: "truncated", reason: output.reason };
    }
    if (output.harnessOutput === "tool_error") {
      return {
        status: "tool_error",
        reason: output.reason,
        evidenceRef: "fault-harness:tool-result-error",
        applicationErrorClass: "FAULT_HARNESS_TOOL_ERROR",
        explicitlyTransient: output.explicitlyTransient,
      };
    }
    return {
      status: "usable",
      value: output.value,
      deliveryId: output.deliveryId,
      receiptRef: output.receiptRef,
      completenessEvidenceRef: output.completenessEvidenceRef,
    };
  };

  private successOutput(
    context: McpInvocationContext,
    deliveryId: string,
  ): HarnessOutput<T> {
    let receiptRef: string | undefined;
    if (context.effectKey) {
      receiptRef = this.recordEffect(context.effectKey, deliveryId).receiptRef;
    }
    return {
      harnessOutput: "usable",
      value: this.options.successValue,
      deliveryId,
      receiptRef,
      completenessEvidenceRef: this.options.completenessEvidenceRef,
    };
  }

  private recordEffect(effectKey: string, deliveryId: string): EffectReceipt<T> {
    const existing = this.effectReceipts.get(effectKey);
    if (existing) return existing;
    this.backendEffectCount += 1;
    const receipt = {
      value: this.options.successValue,
      receiptRef: `fault-harness:effect-receipt:${effectKey}`,
      deliveryId,
    };
    this.effectReceipts.set(effectKey, receipt);
    return receipt;
  }
}
