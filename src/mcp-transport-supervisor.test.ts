import assert from "node:assert/strict";
import {
  classifyMcpTransportError,
  McpTransportFault,
  McpTransportSupervisor,
  type McpSupervisedCall,
  type McpSupervisorTransition,
  type McpTransportSupervisorOptions,
} from "./mcp-transport-supervisor.js";
import {
  McpReliabilityFaultHarness,
  MCP_RELIABILITY_FAULT_SCENARIOS,
} from "./mcp-transport-supervisor-fault-harness.js";
import {
  SupervisedMcpClient,
  type McpClientLike,
} from "./mcp-transport-supervisor-client.js";

function createSupervisor(
  options: McpTransportSupervisorOptions = {},
): McpTransportSupervisor {
  return new McpTransportSupervisor({
    sleep: async () => undefined,
    random: () => 0.5,
    retryPolicy: {
      maxAttempts: 3,
      perAttemptTimeoutMs: 100,
      initialDelayMs: 0,
      maxDelayMs: 0,
      growFactor: 2,
      jitterRatio: 0,
      reconnectMaxAttempts: 2,
      reconciliationMaxAttempts: 2,
      recoveryActionTimeoutMs: 100,
      ...options.retryPolicy,
    },
    circuitBreaker: {
      failureThreshold: 4,
      identicalFailureThreshold: 3,
      openDurationMs: 100,
      ...options.circuitBreaker,
    },
    retryBudget: {
      capacity: 100,
      refillPerSecond: 100,
      ...options.retryBudget,
    },
    receiptCache: {
      maxEntries: 100,
      ttlMs: 60_000,
      ...options.receiptCache,
    },
    latencySampleSize: options.latencySampleSize ?? 100,
    attemptEvidenceLimit: options.attemptEvidenceLimit ?? 100,
    now: options.now,
  });
}

function readCall<T>(
  harness: McpReliabilityFaultHarness<T>,
  operationRef: string,
  overrides: Partial<McpSupervisedCall<T>> = {},
): McpSupervisedCall<T> {
  return {
    operationRef,
    operationKey: `${operationRef}:key`,
    toolRef: "fault-harness/read",
    lane: "read",
    retrySafety: "read_only",
    invoke: harness.invoke,
    assessOutput: harness.assessOutput,
    ...overrides,
  };
}

assert.deepEqual(MCP_RELIABILITY_FAULT_SCENARIOS, [
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
]);

{
  const supervisor = createSupervisor();
  const harness = new McpReliabilityFaultHarness(["success"], {
    successValue: { status: "ok" },
  });
  const result = await supervisor.execute(readCall(harness, "healthy"));
  assert.equal(result.state, "HEALTHY");
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, { status: "ok" });
  assert.equal(result.attemptCount, 1);
  assert.equal(result.retryCount, 0);
  assert.equal(harness.snapshot().invocations, 1);
}

{
  const transitions: McpSupervisorTransition[] = [];
  const supervisor = createSupervisor();
  const harness = new McpReliabilityFaultHarness([
    "timeout_before_response",
    "success",
  ], { successValue: "recovered-timeout" });
  const result = await supervisor.execute(readCall(harness, "timeout", {
    onTransition: (transition) => transitions.push(transition),
  }));
  assert.equal(result.state, "RECOVERED");
  assert.equal(result.source, "retry");
  assert.equal(result.attemptCount, 2);
  assert.equal(result.retryCount, 1);
  assert.equal(harness.snapshot().invocations, 2);
  assert.deepEqual(
    transitions.map((transition) => transition.state),
    ["TRANSIENT_RETRYING"],
  );
  const metrics = supervisor.metrics();
  assert.equal(metrics.totals.timeouts, 1);
  assert.equal(metrics.totals.retries, 1);
  assert.equal(metrics.rates.successfulCallRate, 1);
  assert.ok(metrics.rates.timeoutDropRate > 0);
}

{
  const supervisor = createSupervisor();
  const harness = new McpReliabilityFaultHarness([
    "disconnect_during_call",
    "success",
  ], { successValue: "recovered-disconnect" });
  const result = await supervisor.execute(readCall(harness, "disconnect", {
    reconnect: harness.reconnect,
  }));
  assert.equal(result.state, "RECOVERED");
  assert.equal(harness.snapshot().reconnects, 1);
  const metrics = supervisor.metrics();
  assert.equal(metrics.totals.drops, 1);
  assert.equal(metrics.totals.recoveryActions, 1);
  assert.equal(metrics.totals.successfulRecoveryActions, 1);
  assert.equal(metrics.rates.recoverySuccessRate, 1);
  assert.equal(metrics.rates.ceremonyCallsPerProductiveCall, 1);
}

{
  const supervisor = createSupervisor();
  const harness = new McpReliabilityFaultHarness([
    "backend_success_response_lost",
  ], { successValue: { published: true } });
  const effectCall: McpSupervisedCall<{ published: boolean }> = {
    operationRef: "effect-response-lost",
    toolRef: "fault-harness/effect",
    lane: "effect",
    retrySafety: "effectful",
    effectKey: "effect-1",
    invoke: harness.invoke,
    assessOutput: harness.assessOutput,
    reconcileEffect: harness.reconcileEffect,
  };
  const result = await supervisor.execute(effectCall);
  assert.equal(result.state, "RECOVERED");
  assert.equal(result.source, "effect_receipt");
  assert.equal(result.attemptCount, 1);
  assert.equal(result.retryCount, 0);
  assert.equal(result.evidence.effectReconciled, true);
  assert.equal(result.evidence.effectReconciliationState, "succeeded");
  assert.equal(
    result.evidence.effectReconciliationReceiptRef,
    "fault-harness:effect-receipt:effect-1",
  );
  assert.equal(result.evidence.receiptRef, "fault-harness:effect-receipt:effect-1");
  assert.equal(harness.snapshot().backendEffects, 1);
  assert.equal(harness.snapshot().reconciliations, 1);

  const duplicate = await supervisor.execute(effectCall);
  assert.equal(duplicate.state, "RECOVERED");
  assert.equal(duplicate.source, "operation_receipt");
  assert.equal(duplicate.attemptCount, 0);
  assert.equal(duplicate.evidence.effectReconciliationState, "succeeded");
  assert.equal(harness.snapshot().backendEffects, 1);
  const metrics = supervisor.metrics();
  assert.equal(metrics.totals.duplicateEffectsPrevented, 1);
  assert.equal(metrics.totals.falseRetriesPrevented, 1);
}

for (const scenario of ["empty_output", "truncated_output"] as const) {
  const supervisor = createSupervisor();
  const harness = new McpReliabilityFaultHarness([scenario, "success"], {
    successValue: `recovered-${scenario}`,
  });
  const result = await supervisor.execute(readCall(
    harness,
    `output-${scenario}`,
  ));
  assert.equal(result.state, "RECOVERED");
  assert.equal(result.retryCount, 1);
  assert.equal(supervisor.metrics().totals.missingOutputs, 1);
}

{
  const supervisor = createSupervisor();
  const harness = new McpReliabilityFaultHarness([
    "duplicate_delivery",
    "duplicate_delivery",
  ], {
    successValue: "deduplicated",
    duplicateDeliveryId: "delivery-1",
  });
  const first = await supervisor.execute(readCall(harness, "delivery-a", {
    operationKey: "delivery-a",
  }));
  const duplicate = await supervisor.execute(readCall(harness, "delivery-b", {
    operationKey: "delivery-b",
  }));
  assert.equal(first.state, "HEALTHY");
  assert.equal(duplicate.state, "RECOVERED");
  assert.equal(duplicate.source, "delivery_receipt");
  assert.equal(harness.snapshot().invocations, 2);
  assert.equal(supervisor.metrics().totals.duplicateDeliveriesPrevented, 1);
}

{
  const supervisor = createSupervisor();
  const harness = new McpReliabilityFaultHarness([
    "delayed_response",
    "success",
  ], {
    successValue: "recovered-delay",
    delayedResponseMs: 30,
  });
  const result = await supervisor.execute(readCall(harness, "delay", {
    timeoutMs: 5,
  }));
  assert.equal(result.state, "RECOVERED");
  assert.equal(result.retryCount, 1);
  assert.equal(supervisor.metrics().totals.timeouts, 1);
}

for (const scenario of ["backend_restart", "stale_connection"] as const) {
  const supervisor = createSupervisor();
  const harness = new McpReliabilityFaultHarness([scenario, "success"], {
    successValue: `recovered-${scenario}`,
  });
  const result = await supervisor.execute(readCall(
    harness,
    `connection-${scenario}`,
    { reconnect: harness.reconnect },
  ));
  assert.equal(result.state, "RECOVERED");
  assert.equal(harness.snapshot().reconnects, 1);
  assert.equal(harness.snapshot().connectionGeneration, 2);
}

{
  const supervisor = createSupervisor();
  const harness = new McpReliabilityFaultHarness([], { successValue: "unused" });
  const ordinary = await supervisor.execute(readCall(harness, "partial", {
    capability: harness.partialToolAvailabilityPolicy(),
  }));
  assert.equal(ordinary.state, "TRANSPORT_DEGRADED");
  assert.equal(ordinary.attemptCount, 0);

  const stale = await supervisor.execute(readCall(harness, "catalog-stale", {
    capability: harness.partialToolAvailabilityPolicy({
      catalogFreshness: "stale",
    }),
  }));
  assert.equal(stale.state, "CLIENT_CATALOG_STALE");

  const research = await supervisor.execute(readCall(harness, "research-block", {
    lane: "research",
    capability: harness.partialToolAvailabilityPolicy({
      freshEvidenceRequired: true,
    }),
  }));
  assert.equal(research.state, "HARD_EXTERNAL_BLOCKER");
  assert.match(research.action, /fresh research/i);

  const validation = await supervisor.execute(readCall(
    harness,
    "validation-block",
    {
      lane: "validation",
      capability: harness.partialToolAvailabilityPolicy({
        validationReadbackRequired: true,
      }),
    },
  ));
  assert.equal(validation.state, "HARD_EXTERNAL_BLOCKER");
  assert.equal(validation.evidence.validationClaimAllowed, false);

  const canonical = await supervisor.execute(readCall(
    harness,
    "canonical-block",
    {
      capability: harness.partialToolAvailabilityPolicy({
        canonicalStateRequiredForMutation: true,
      }),
    },
  ));
  assert.equal(canonical.state, "HARD_EXTERNAL_BLOCKER");

  const effect = await supervisor.execute(readCall(harness, "effect-capability", {
    lane: "effect",
    retrySafety: "effectful",
    effectKey: "missing-effect-transport",
    reconcileEffect: harness.reconcileEffect,
    capability: harness.partialToolAvailabilityPolicy({
      effectTransportRequired: true,
    }),
  }));
  assert.equal(effect.state, "EFFECT_LANE_BLOCKED");
  assert.equal(effect.evidence.effectLaneFrozen, true);

  const typedFallback = await supervisor.execute(readCall(
    harness,
    "typed-fallback-selection",
    {
      lane: "research",
      capability: harness.partialToolAvailabilityPolicy({
        freshEvidenceRequired: true,
        qualityEquivalentFallbackAvailable: true,
        fallbackPolicyRef: "policy:research-equivalent-v1",
      }),
    },
  ));
  assert.equal(typedFallback.state, "TRANSPORT_DEGRADED");
  assert.equal(
    typedFallback.capability?.fallbackDisposition,
    "quality_equivalent_available",
  );
  assert.equal(harness.snapshot().invocations, 0);
}

{
  const supervisor = createSupervisor();
  const harness = new McpReliabilityFaultHarness([
    "indeterminate_effect_result",
  ], { successValue: "unknown-effect" });
  const result = await supervisor.execute<string>({
    operationRef: "indeterminate-effect",
    toolRef: "fault-harness/effect",
    lane: "effect",
    retrySafety: "effectful",
    effectKey: "effect-indeterminate",
    invoke: harness.invoke,
    assessOutput: harness.assessOutput,
    reconcileEffect: harness.reconcileEffect,
  });
  assert.equal(result.state, "EFFECT_LANE_BLOCKED");
  assert.equal(result.retryCount, 0);
  assert.equal(result.evidence.effectLaneFrozen, true);
  assert.equal(result.evidence.effectReconciled, false);
  assert.equal(result.evidence.effectReconciliationState, "indeterminate");
  assert.deepEqual(
    result.evidence.effectReconciliationEvidenceRefs,
    ["fault-harness:effect-receipt-missing"],
  );
  assert.equal(harness.snapshot().backendEffects, 1);
  assert.equal(harness.snapshot().reconciliations, 1);
}

{
  const supervisor = createSupervisor();
  const harness = new McpReliabilityFaultHarness([], { successValue: "unused" });
  const missingKey = await supervisor.execute<string>({
    operationRef: "missing-effect-key",
    toolRef: "fault-harness/effect",
    lane: "effect",
    retrySafety: "effectful",
    invoke: harness.invoke,
    assessOutput: harness.assessOutput,
  });
  assert.equal(missingKey.state, "EFFECT_LANE_BLOCKED");
  assert.equal(missingKey.attemptCount, 0);
  assert.equal(harness.snapshot().invocations, 0);

  const missingOperationKey = await supervisor.execute(readCall(
    harness,
    "missing-idempotency-key",
    {
      retrySafety: "idempotent",
      operationKey: undefined,
    },
  ));
  assert.equal(missingOperationKey.state, "HARD_EXTERNAL_BLOCKER");
  assert.equal(harness.snapshot().invocations, 0);
}

{
  const supervisor = createSupervisor({
    retryPolicy: { maxAttempts: 4 },
    circuitBreaker: {
      failureThreshold: 3,
      identicalFailureThreshold: 2,
      openDurationMs: 10_000,
    },
  });
  const harness = new McpReliabilityFaultHarness([
    "disconnect_during_call",
    "disconnect_during_call",
    "success",
  ], { successValue: "must-not-reach-until-half-open" });
  const first = await supervisor.execute(readCall(harness, "circuit", {
    operationKey: undefined,
    circuitKey: "circuit:test",
  }));
  assert.equal(first.state, "TRANSPORT_DEGRADED");
  assert.equal(first.attemptCount, 2);
  assert.equal(first.circuit.state, "open");
  assert.equal(harness.snapshot().invocations, 2);

  const rejected = await supervisor.execute(readCall(harness, "circuit-reject", {
    operationKey: undefined,
    circuitKey: "circuit:test",
  }));
  assert.equal(rejected.state, "TRANSPORT_DEGRADED");
  assert.equal(rejected.failure?.kind, "circuit_open");
  assert.equal(rejected.attemptCount, 0);
  assert.equal(harness.snapshot().invocations, 2);
  assert.equal(supervisor.metrics().totals.circuitTrips, 1);
  assert.equal(supervisor.metrics().totals.circuitRejects, 1);
}

{
  let nowMs = 0;
  const supervisor = createSupervisor({
    now: () => nowMs,
    retryPolicy: { maxAttempts: 4 },
    circuitBreaker: {
      failureThreshold: 3,
      identicalFailureThreshold: 2,
      openDurationMs: 100,
    },
  });
  const harness = new McpReliabilityFaultHarness([
    "disconnect_during_call",
    "disconnect_during_call",
    "success",
  ], { successValue: "half-open-recovered" });
  const first = await supervisor.execute(readCall(harness, "half-open-first", {
    operationKey: undefined,
    circuitKey: "circuit:half-open",
  }));
  assert.equal(first.state, "TRANSPORT_DEGRADED");
  assert.equal(first.circuit.state, "open");

  const rejected = await supervisor.execute(readCall(
    harness,
    "half-open-rejected",
    {
      operationKey: undefined,
      circuitKey: "circuit:half-open",
    },
  ));
  assert.equal(rejected.failure?.kind, "circuit_open");
  assert.equal(harness.snapshot().invocations, 2);

  nowMs = 101;
  const recovered = await supervisor.execute(readCall(
    harness,
    "half-open-recovered",
    {
      operationKey: undefined,
      circuitKey: "circuit:half-open",
    },
  ));
  assert.equal(recovered.state, "HEALTHY");
  assert.equal(recovered.circuit.state, "closed");
  assert.equal(recovered.value, "half-open-recovered");
  assert.equal(harness.snapshot().invocations, 3);
}

{
  const supervisor = createSupervisor({
    retryBudget: { capacity: 0, refillPerSecond: 0 },
  });
  const harness = new McpReliabilityFaultHarness([
    "timeout_before_response",
    "success",
  ], { successValue: "budget-blocked" });
  const result = await supervisor.execute(readCall(harness, "retry-budget"));
  assert.equal(result.state, "TRANSPORT_DEGRADED");
  assert.equal(result.failure?.kind, "retry_budget_exhausted");
  assert.equal(result.retryCount, 0);
  assert.equal(harness.snapshot().invocations, 1);
}

{
  let listCalls = 0;
  let toolCalls = 0;
  const fakeClient = {
    async listTools() {
      listCalls += 1;
      if (listCalls === 1) {
        throw new McpTransportFault("first list failed", {
          kind: "disconnect_during_call",
          phase: "after_dispatch",
          retryable: true,
          backendOutcome: "unknown",
        });
      }
      return {
        tools: [{
          name: "read",
          inputSchema: { type: "object" as const },
        }],
      };
    },
    async callTool() {
      toolCalls += 1;
      return { content: [{ type: "text" as const, text: "ok" }] };
    },
  } as unknown as McpClientLike;
  const supervisor = createSupervisor();
  const client = new SupervisedMcpClient(fakeClient, supervisor, {
    backendRef: "fake-mcp",
    operationPrefix: "test",
  });
  const listed = await client.listTools(undefined, {
    operationKey: "list-tools",
  });
  assert.equal(listed.state, "RECOVERED");
  assert.equal(listCalls, 2);
  assert.equal(listed.value?.tools[0]?.name, "read");

  const blockedEffect = await client.callTool(
    { name: "publish", arguments: {} },
    { lane: "effect", retrySafety: "effectful" },
  );
  assert.equal(blockedEffect.state, "EFFECT_LANE_BLOCKED");
  assert.equal(toolCalls, 0);
}

{
  const supervisor = createSupervisor();
  const firstBackend = new McpReliabilityFaultHarness(["success"], {
    successValue: "backend-a",
  });
  const secondBackend = new McpReliabilityFaultHarness(["success"], {
    successValue: "backend-b",
  });
  const first = await supervisor.execute(readCall(firstBackend, "backend-key-a", {
    backendRef: "backend-a",
    operationKey: "shared-operation-key",
  }));
  const second = await supervisor.execute(readCall(secondBackend, "backend-key-b", {
    backendRef: "backend-b",
    operationKey: "shared-operation-key",
  }));
  assert.equal(first.value, "backend-a");
  assert.equal(second.value, "backend-b");
  assert.equal(second.source, "primary");
  assert.equal(secondBackend.snapshot().invocations, 1);
}

{
  const supervisor = createSupervisor();
  const harness = new McpReliabilityFaultHarness([
    "timeout_before_response",
    "success",
  ], { successValue: "idempotent-recovered" });
  const missingEvidence = await supervisor.execute(readCall(
    harness,
    "idempotency-binding-missing",
    {
      retrySafety: "idempotent",
      operationKey: "idempotent-key",
    },
  ));
  assert.equal(missingEvidence.state, "HARD_EXTERNAL_BLOCKER");
  assert.equal(
    missingEvidence.failure?.detailCode,
    "idempotency_binding_evidence_missing",
  );
  assert.equal(harness.snapshot().invocations, 0);

  const recovered = await supervisor.execute(readCall(
    harness,
    "idempotency-binding-present",
    {
      retrySafety: "idempotent",
      operationKey: "idempotent-key-bound",
      idempotencyEvidenceRef: "tool-contract:read:v1#operation-key",
    },
  ));
  assert.equal(recovered.state, "RECOVERED");
  assert.equal(recovered.retryCount, 1);
  assert.equal(
    recovered.evidence.idempotencyEvidenceRef,
    "tool-contract:read:v1#operation-key",
  );
}

{
  const supervisor = createSupervisor();
  const noEvidenceHarness = new McpReliabilityFaultHarness(["success"], {
    successValue: "validation-output",
  });
  const blocked = await supervisor.execute(readCall(
    noEvidenceHarness,
    "validation-completeness-missing",
    { lane: "validation" },
  ));
  assert.equal(blocked.state, "OUTPUT_INDETERMINATE");
  assert.equal(blocked.failure?.kind, "indeterminate_output");
  assert.equal(blocked.evidence.validationClaimAllowed, false);

  const evidenceHarness = new McpReliabilityFaultHarness(["success"], {
    successValue: "validation-output",
    completenessEvidenceRef: "readback:sha256:validated",
  });
  const validated = await supervisor.execute(readCall(
    evidenceHarness,
    "validation-completeness-present",
    { lane: "validation" },
  ));
  assert.equal(validated.state, "HEALTHY");
  assert.equal(validated.evidence.validationClaimAllowed, true);
  assert.equal(
    validated.evidence.completenessEvidenceRef,
    "readback:sha256:validated",
  );
}

{
  const supervisor = createSupervisor();
  const harness = new McpReliabilityFaultHarness([
    "partial_tool_availability",
  ], { successValue: "unused" });
  const result = await supervisor.execute(readCall(
    harness,
    "partial-tool-runtime-fault",
    { operationKey: undefined },
  ));
  assert.equal(result.state, "TRANSPORT_DEGRADED");
  assert.equal(result.failure?.kind, "partial_tool_availability");
  assert.equal(result.attemptCount, 1);
}

{
  const supervisor = createSupervisor();
  const harness = new McpReliabilityFaultHarness([], { successValue: "unused" });
  const invalidFallback = await supervisor.execute(readCall(
    harness,
    "fallback-policy-ref-missing",
    {
      lane: "research",
      capability: harness.partialToolAvailabilityPolicy({
        freshEvidenceRequired: true,
        qualityEquivalentFallbackAvailable: true,
      }),
    },
  ));
  assert.equal(invalidFallback.state, "HARD_EXTERNAL_BLOCKER");
  assert.equal(
    invalidFallback.failure?.detailCode,
    "typed_fallback_policy_ref_missing",
  );
  assert.equal(
    invalidFallback.capability?.fallbackDisposition,
    "denied_to_preserve_quality",
  );
}

{
  const supervisor = createSupervisor();
  const result = await supervisor.execute<string>({
    operationRef: "classifier-failure",
    toolRef: "fault-harness/read",
    lane: "read",
    retrySafety: "read_only",
    invoke: async ({ markDispatched }) => {
      markDispatched();
      throw new Error("transport exploded");
    },
    classifyError: () => {
      throw new Error("classifier exploded");
    },
  });
  assert.equal(result.state, "TRANSPORT_DEGRADED");
  assert.equal(result.failure?.kind, "protocol_error");
  assert.equal(result.failure?.phase, "after_dispatch");
  assert.equal(result.failure?.detailCode, "custom_error_classifier_failed");
}

{
  const supervisor = createSupervisor();
  const harness = new McpReliabilityFaultHarness(["success"], {
    successValue: "unused",
  });
  await assert.rejects(
    supervisor.execute(readCall(harness, "invalid-call-retry-policy", {
      retryPolicy: { jitterRatio: 2 },
    })),
    /call\.retryPolicy\.jitterRatio must be between 0 and 1/,
  );
  assert.equal(harness.snapshot().invocations, 0);
}

{
  const supervisor = createSupervisor();
  const terminal = await supervisor.execute<string>({
    operationRef: "effect-terminal-failure",
    toolRef: "fault-harness/effect",
    lane: "effect",
    retrySafety: "effectful",
    effectKey: "effect-terminal",
    invoke: async ({ markDispatched }) => {
      markDispatched();
      throw new McpTransportFault("response lost", {
        kind: "response_lost_after_success",
        phase: "after_dispatch",
        retryable: true,
        backendOutcome: "unknown",
      });
    },
    reconcileEffect: async () => ({
      state: "terminal_failure",
      receiptRef: "effect-receipt:terminal",
      reason: "effect owner rejected the operation",
    }),
  });
  assert.equal(terminal.state, "EFFECT_LANE_BLOCKED");
  assert.equal(terminal.failure?.detailCode, "effect_terminal_failure");
  assert.equal(terminal.evidence.effectReconciled, true);
  assert.equal(
    terminal.evidence.effectReconciliationState,
    "terminal_failure",
  );
  assert.equal(
    terminal.evidence.effectReconciliationReceiptRef,
    "effect-receipt:terminal",
  );
  assert.equal(terminal.evidence.receiptRef, "effect-receipt:terminal");
}

{
  const supervisor = createSupervisor();
  let attempts = 0;
  const result = await supervisor.execute<string>({
    operationRef: "effect-not-applied-retry",
    toolRef: "fault-harness/effect",
    lane: "effect",
    retrySafety: "effectful",
    effectKey: "effect-not-applied",
    invoke: async ({ markDispatched }) => {
      attempts += 1;
      markDispatched();
      if (attempts === 1) {
        throw new McpTransportFault("response lost", {
          kind: "response_lost_after_success",
          phase: "after_dispatch",
          retryable: true,
          backendOutcome: "unknown",
        });
      }
      return "effect-applied";
    },
    assessOutput: (raw) => ({
      status: "usable",
      value: raw as string,
      receiptRef: "effect-receipt:applied",
    }),
    reconcileEffect: async () => ({
      state: "not_applied",
      receiptRef: "effect-receipt:not-applied",
    }),
  });
  assert.equal(result.state, "RECOVERED");
  assert.equal(result.retryCount, 1);
  assert.equal(attempts, 2);
  assert.equal(result.evidence.effectReconciliationState, "not_applied");
  assert.equal(result.evidence.effectReconciled, true);
  assert.equal(
    result.evidence.effectReconciliationReceiptRef,
    "effect-receipt:not-applied",
  );
  assert.equal(result.evidence.receiptRef, "effect-receipt:applied");
}

{
  const supervisor = createSupervisor();
  const harness = new McpReliabilityFaultHarness(["success"], {
    successValue: { secretPayload: "not-copied-into-attempt-receipt" },
  });
  const result = await supervisor.execute(readCall(
    harness,
    "logical-call-attempt-evidence",
    {
      logicalCallId: "logical-call:attempt-evidence",
      transportIdentity: {
        endpointRef: "https://nexus.example/mcp",
        protocolEra: "modern",
        protocolRevision: "2025-11-25",
        backendGenerationRef: "generation-7",
      },
    },
  ));
  assert.equal(result.logicalCallId, "logical-call:attempt-evidence");
  assert.equal(result.callSafetyClass, "READ_ONLY");
  assert.equal(result.recoveryReceipt.logicalCallId, result.logicalCallId);
  assert.equal(result.recoveryReceipt.attempts.length, 1);
  const attempt = result.recoveryReceipt.attempts[0]!;
  assert.notEqual(attempt.attemptId, result.logicalCallId);
  assert.equal(attempt.logicalCallId, result.logicalCallId);
  assert.equal(attempt.attemptKind, "primary");
  assert.equal(attempt.callSafetyClass, "READ_ONLY");
  assert.equal(attempt.protocolEra, "modern");
  assert.equal(
    attempt.endpointAndBackendGeneration.backendGenerationRef,
    "generation-7",
  );
  assert.equal(attempt.semanticOutputClass, "usable");
  assert.equal(attempt.outcome, "succeeded");
  assert.match(
    attempt.idempotencyKeyOrEffectKeyDigestSha256 ?? "",
    /^[a-f0-9]{64}$/,
  );
  assert.match(
    attempt.circuitKey,
    /https:\/\/nexus\.example\/mcp:modern:generation-7:/,
  );
  assert.doesNotMatch(
    JSON.stringify(result.recoveryReceipt),
    /not-copied-into-attempt-receipt/,
  );
  assert.doesNotMatch(
    JSON.stringify(result.recoveryReceipt),
    /logical-call-attempt-evidence:key/,
  );
}

{
  const supervisor = createSupervisor();
  const harness = new McpReliabilityFaultHarness(["success"], {
    successValue: "safe-reference-output",
  });
  await assert.rejects(
    supervisor.execute(readCall(harness, "credential-endpoint-rejected", {
      transportIdentity: {
        endpointRef: "https://user:password@example.test/mcp",
        protocolEra: "modern",
      },
    })),
    /transportIdentity\.endpointRef may not embed credential-bearing material/,
  );
  await assert.rejects(
    supervisor.execute(readCall(harness, "credential-query-rejected", {
      transportIdentity: {
        endpointRef: "https://example.test/mcp?access_token=secret",
        protocolEra: "modern",
      },
    })),
    /transportIdentity\.endpointRef must not contain a query string or fragment/,
  );
  assert.equal(harness.snapshot().invocations, 0);

  const unsafeReceipt = await supervisor.execute(readCall(
    harness,
    "unsafe-output-receipt-is-digested",
    {
      assessOutput: (raw) => ({
        status: "usable",
        value: raw as string,
        receiptRef: "https://example.test/receipt?access_token=secret",
      }),
    },
  ));
  assert.match(
    unsafeReceipt.evidence.receiptRef ?? "",
    /^evidence-sha256:[a-f0-9]{64}$/,
  );
  assert.doesNotMatch(
    JSON.stringify(unsafeReceipt),
    /access_token=secret/,
  );
}

{
  const unknownSession = Object.assign(
    new Error(
      'Error POSTing to endpoint: {"code":-32000,"message":"Unknown MCP session"}',
    ),
    { code: 404 },
  );
  const legacy = classifyMcpTransportError(unknownSession, {
    dispatched: true,
    callerAborted: false,
    protocolEra: "legacy_stateful",
    operationKind: "tool_call",
  });
  assert.equal(legacy.kind, "legacy_stale_session_pre_dispatch");
  assert.equal(legacy.phase, "before_dispatch");
  assert.equal(legacy.backendOutcome, "not_started");
  assert.equal(legacy.httpStatus, 404);
  assert.equal(legacy.protocolCode, -32000);

  const modern = classifyMcpTransportError(unknownSession, {
    dispatched: false,
    callerAborted: false,
    protocolEra: "modern",
    operationKind: "tool_call",
  });
  assert.equal(modern.kind, "http_non_success");
  assert.equal(modern.retryable, false);
  assert.equal(
    modern.detailCode,
    "unknown_session_without_legacy_stateful_attestation",
  );

  const generic404 = classifyMcpTransportError(
    Object.assign(new Error("HTTP 404 route not found"), { code: 404 }),
    {
      dispatched: false,
      callerAborted: false,
      protocolEra: "legacy_stateful",
      operationKind: "tool_call",
    },
  );
  assert.equal(generic404.kind, "http_non_success");
  assert.notEqual(generic404.kind, "legacy_stale_session_pre_dispatch");

  const unauthorized = classifyMcpTransportError(
    Object.assign(new Error("HTTP 401"), { code: 401 }),
    {
      dispatched: false,
      callerAborted: false,
      protocolEra: "legacy_stateful",
      operationKind: "protocol_negotiation",
    },
  );
  assert.equal(unauthorized.kind, "authentication_failure");

  const infrastructure = classifyMcpTransportError(
    Object.assign(new Error("HTTP 503"), { code: 503 }),
    {
      dispatched: false,
      callerAborted: false,
      protocolEra: "unknown",
      operationKind: "protocol_negotiation",
    },
  );
  assert.equal(
    infrastructure.kind,
    "protocol_negotiation_infrastructure_failure",
  );
  assert.notEqual(infrastructure.kind, "protocol_negotiation_unsupported");

  const unsupported = classifyMcpTransportError(
    Object.assign(new Error("Unsupported protocol version"), { code: -32022 }),
    {
      dispatched: false,
      callerAborted: false,
      protocolEra: "unknown",
      operationKind: "protocol_negotiation",
    },
  );
  assert.equal(unsupported.kind, "protocol_negotiation_unsupported");
  assert.equal(unsupported.retryable, false);
}

{
  const supervisor = createSupervisor();
  const harness = new McpReliabilityFaultHarness([
    "legacy_unknown_session",
    "success",
  ], { successValue: "legacy-recovered" });
  const result = await supervisor.execute(readCall(
    harness,
    "typed-legacy-session-recovery",
    {
      logicalCallId: "logical:legacy-recovery",
      transportIdentity: {
        endpointRef: "legacy://nexus",
        protocolEra: "legacy_stateful",
        backendGenerationRef: "legacy-generation-1",
      },
      recoverStaleSession: harness.recoverStaleSession,
    },
  ));
  assert.equal(result.state, "RECOVERED");
  assert.equal(result.retryCount, 1);
  assert.equal(harness.snapshot().staleSessionRecreations, 1);
  assert.equal(harness.snapshot().invocations, 2);
  assert.deepEqual(
    result.recoveryReceipt.attempts.map((entry) => entry.attemptKind),
    ["primary", "legacy_session_recreate", "primary"],
  );
  assert.equal(
    new Set(result.recoveryReceipt.attempts.map((entry) => entry.attemptId)).size,
    3,
  );
  assert.ok(result.recoveryReceipt.attempts.every(
    (entry) => entry.logicalCallId === "logical:legacy-recovery",
  ));
}

{
  const supervisor = createSupervisor();
  const harness = new McpReliabilityFaultHarness([
    "legacy_unknown_session",
    "legacy_unknown_session",
    "success",
  ], { successValue: "must-not-reach-third-attempt" });
  const result = await supervisor.execute(readCall(
    harness,
    "typed-legacy-session-recovery-once",
    {
      transportIdentity: {
        endpointRef: "legacy://nexus",
        protocolEra: "legacy_stateful",
        backendGenerationRef: "legacy-generation-1",
      },
      recoverStaleSession: harness.recoverStaleSession,
    },
  ));
  assert.equal(result.state, "TRANSPORT_DEGRADED");
  assert.equal(harness.snapshot().staleSessionRecreations, 1);
  assert.equal(harness.snapshot().invocations, 2);
  assert.equal(
    result.failure?.detailCode,
    "legacy_stale_session_recovery_already_used",
  );
}

{
  let staleClientCalls = 0;
  let replacementClientCalls = 0;
  let recreationCalls = 0;
  const staleError = Object.assign(
    new Error(
      'Error POSTing to endpoint: {"code":-32000,"message":"Unknown MCP session"}',
    ),
    { code: 404 },
  );
  const staleClient = {
    async listTools() {
      staleClientCalls += 1;
      throw staleError;
    },
    async callTool() {
      throw new Error("not used");
    },
  } as unknown as McpClientLike;
  const replacementClient = {
    async listTools() {
      replacementClientCalls += 1;
      return {
        tools: [{
          name: "read",
          inputSchema: { type: "object" as const },
        }],
      };
    },
    async callTool() {
      throw new Error("not used");
    },
  } as unknown as McpClientLike;
  const client = new SupervisedMcpClient(
    staleClient,
    createSupervisor(),
    {
      backendRef: "legacy-client",
      transportIdentity: {
        endpointRef: "https://legacy.example/mcp",
        protocolEra: "legacy_stateful",
        backendGenerationRef: "legacy-generation",
      },
      recreateLegacyClient: async () => {
        recreationCalls += 1;
        return replacementClient;
      },
    },
  );
  const result = await client.listTools(undefined, {
    logicalCallId: "logical:official-sdk-legacy-recreate",
  });
  assert.equal(result.state, "RECOVERED");
  assert.equal(staleClientCalls, 1);
  assert.equal(replacementClientCalls, 1);
  assert.equal(recreationCalls, 1);
  assert.deepEqual(
    result.recoveryReceipt.attempts.map((entry) => entry.attemptKind),
    ["primary", "legacy_session_recreate", "primary"],
  );
}

{
  let toolCalls = 0;
  const client = new SupervisedMcpClient(
    {
      async listTools() {
        return { tools: [] };
      },
      async callTool() {
        toolCalls += 1;
        return {
          isError: true,
          content: [{
            type: "text" as const,
            text: "application rejected the request",
          }],
        };
      },
    } as unknown as McpClientLike,
    createSupervisor(),
    {
      backendRef: "official-sdk-is-error",
      transportIdentity: {
        endpointRef: "in-memory://official-sdk-is-error",
        protocolEra: "modern",
        backendGenerationRef: "test-generation",
      },
    },
  );
  const result = await client.callTool(
    { name: "read", arguments: {} },
    { lane: "read", retrySafety: "read_only" },
  );
  assert.equal(result.state, "HARD_EXTERNAL_BLOCKER");
  assert.equal(result.failure?.failureClass, "TOOL_RESULT_IS_ERROR");
  assert.equal(result.retryCount, 0);
  assert.equal(toolCalls, 1);
}

{
  const supervisor = createSupervisor();
  const harness = new McpReliabilityFaultHarness([
    "subscription_closed",
    "success",
  ], { successValue: "subscription-recovered" });
  const result = await supervisor.execute(readCall(
    harness,
    "subscription-relisten",
    {
      operationKind: "subscription_listen",
      subscriptionGeneration: "subscription-1",
      transportIdentity: {
        endpointRef: "https://modern.example/mcp",
        protocolEra: "modern",
        backendGenerationRef: "modern-generation-1",
      },
      recoverSubscription: harness.recoverSubscription,
    },
  ));
  assert.equal(result.state, "RECOVERED");
  assert.equal(result.retryCount, 1);
  assert.equal(harness.snapshot().subscriptionRelistens, 1);
  assert.deepEqual(
    result.recoveryReceipt.attempts.map((entry) => entry.attemptKind),
    ["primary", "subscription_relisten", "primary"],
  );
  assert.equal(
    result.recoveryReceipt.attempts[1]?.mcpResultOrErrorClass,
    "SUBSCRIPTION_RELISTEN_AND_REFETCH_FINGERPRINT_VERIFIED",
  );
  assert.equal(
    result.recoveryReceipt.attempts[1]
      ?.subscriptionRefetch?.expectedListFingerprintSha256,
    "a".repeat(64),
  );
  assert.equal(
    result.recoveryReceipt.attempts[1]
      ?.subscriptionRefetch?.observedListFingerprintSha256,
    "a".repeat(64),
  );
}

{
  const supervisor = createSupervisor();
  const harness = new McpReliabilityFaultHarness([
    "subscription_closed",
  ], {
    successValue: "unused",
    subscriptionFingerprintMismatch: true,
  });
  const result = await supervisor.execute(readCall(
    harness,
    "subscription-fingerprint-mismatch",
    {
      operationKind: "subscription_listen",
      transportIdentity: {
        endpointRef: "https://modern.example/mcp",
        protocolEra: "modern",
        backendGenerationRef: "modern-generation-1",
      },
      recoverSubscription: harness.recoverSubscription,
    },
  ));
  assert.equal(result.state, "CLIENT_CATALOG_STALE");
  assert.equal(result.failure?.kind, "client_catalog_stale");
  assert.equal(
    result.failure?.detailCode,
    "subscription_refetch_fingerprint_mismatch",
  );
  assert.equal(harness.snapshot().invocations, 1);
  assert.equal(harness.snapshot().subscriptionRelistens, 1);
}

{
  const supervisor = createSupervisor();
  const harness = new McpReliabilityFaultHarness([
    "tool_result_error",
    "success",
  ], { successValue: "must-not-auto-retry" });
  const result = await supervisor.execute(readCall(
    harness,
    "tool-result-error-non-transient",
  ));
  assert.equal(result.state, "HARD_EXTERNAL_BLOCKER");
  assert.equal(result.failure?.kind, "tool_result_error");
  assert.equal(result.failure?.failureClass, "TOOL_RESULT_IS_ERROR");
  assert.equal(result.retryCount, 0);
  assert.equal(harness.snapshot().invocations, 1);

  const transientHarness = new McpReliabilityFaultHarness([
    "tool_result_error",
    "success",
  ], {
    successValue: "typed-transient-recovered",
    toolErrorTransient: true,
  });
  const transient = await supervisor.execute(readCall(
    transientHarness,
    "tool-result-error-explicitly-transient",
  ));
  assert.equal(transient.state, "RECOVERED");
  assert.equal(transient.retryCount, 1);
  assert.equal(transientHarness.snapshot().invocations, 2);
}

{
  const supervisor = createSupervisor();
  const harness = new McpReliabilityFaultHarness([
    "cancelled_after_dispatch",
  ], { successValue: "unused" });
  const result = await supervisor.execute<string>({
    operationRef: "post-dispatch-cancellation-effect",
    logicalCallId: "logical:cancelled-effect",
    toolRef: "fault-harness/effect",
    lane: "effect",
    retrySafety: "effectful",
    effectKey: "effect:cancelled-after-dispatch",
    invoke: harness.invoke,
    assessOutput: harness.assessOutput,
    reconcileEffect: harness.reconcileEffect,
  });
  assert.equal(result.state, "EFFECT_LANE_BLOCKED");
  assert.equal(result.retryCount, 0);
  assert.equal(harness.snapshot().invocations, 1);
  assert.equal(harness.snapshot().reconciliations, 1);
  assert.equal(
    result.recoveryReceipt.attempts[0]?.failureClass,
    "CANCELLED_DISPATCH_UNKNOWN",
  );
  assert.deepEqual(
    result.recoveryReceipt.attempts.map((entry) => entry.attemptKind),
    ["primary", "effect_reconciliation"],
  );
  assert.equal(result.evidence.effectLaneFrozen, true);
}

{
  const supervisor = createSupervisor({
    circuitBreaker: {
      failureThreshold: 1,
      identicalFailureThreshold: 1,
      openDurationMs: 1_000,
    },
  });
  const transportIdentity = {
    endpointRef: "https://circuit.example/mcp",
    protocolEra: "modern" as const,
    backendGenerationRef: "generation-1",
  };
  const failedHarness = new McpReliabilityFaultHarness([
    "disconnect_during_call",
  ], { successValue: "unused" });
  const failed = await supervisor.execute(readCall(
    failedHarness,
    "failure-class-circuit",
    {
      operationKey: undefined,
      transportIdentity,
    },
  ));
  assert.equal(failed.circuit.state, "open");
  assert.match(failed.circuit.key, /NETWORK_DISPATCH_UNKNOWN$/);

  const catalogHarness = new McpReliabilityFaultHarness([], {
    successValue: "unused",
  });
  const catalog = await supervisor.execute(readCall(
    catalogHarness,
    "catalog-mismatch-not-network-circuit",
    {
      operationKey: undefined,
      transportIdentity,
      capability: {
        catalogFreshness: "stale",
        requiresFreshCatalog: true,
        requiredCapabilities: ["tool:new"],
        availableCapabilities: [],
      },
    },
  ));
  assert.equal(catalog.state, "CLIENT_CATALOG_STALE");
  assert.equal(catalog.failure?.kind, "client_catalog_stale");
  assert.equal(catalogHarness.snapshot().invocations, 0);

  const newGenerationHarness = new McpReliabilityFaultHarness(["success"], {
    successValue: "new-generation-healthy",
  });
  const newGeneration = await supervisor.execute(readCall(
    newGenerationHarness,
    "new-backend-generation-not-blocked",
    {
      operationKey: undefined,
      transportIdentity: {
        ...transportIdentity,
        backendGenerationRef: "generation-2",
      },
    },
  ));
  assert.equal(newGeneration.state, "HEALTHY");
  assert.equal(newGenerationHarness.snapshot().invocations, 1);
}

{
  const supervisor = createSupervisor({ attemptEvidenceLimit: 2 });
  const harness = new McpReliabilityFaultHarness([
    "disconnect_during_call",
    "success",
  ], { successValue: "bounded-receipt" });
  const result = await supervisor.execute(readCall(
    harness,
    "bounded-attempt-receipt",
    { reconnect: harness.reconnect },
  ));
  assert.equal(result.state, "RECOVERED");
  assert.equal(result.recoveryReceipt.attempts.length, 2);
  assert.equal(result.recoveryReceipt.attemptEvidenceTruncated, true);
  assert.equal(result.recoveryReceipt.attempts[0]?.attemptKind, "primary");
  assert.equal(result.recoveryReceipt.attempts[1]?.attemptKind, "primary");
  assert.equal(result.recoveryReceipt.attempts[1]?.ordinal, 2);
  assert.equal(
    result.recoveryReceipt.policy.modelLevelRetryCeremonyRequired,
    false,
  );
}

{
  assert.throws(
    () => createSupervisor({ attemptEvidenceLimit: 1_001 }),
    /attemptEvidenceLimit must not exceed 1000/,
  );
  const supervisor = createSupervisor();
  const harness = new McpReliabilityFaultHarness(["success"], {
    successValue: "unused",
  });
  await assert.rejects(
    supervisor.execute(readCall(harness, "unbounded-primary-attempts", {
      retryPolicy: { maxAttempts: 21 },
    })),
    /call\.retryPolicy\.maxAttempts must not exceed 20/,
  );
  await assert.rejects(
    supervisor.execute(readCall(harness, "unattested-stale-recovery", {
      recoverStaleSession: harness.recoverStaleSession,
    })),
    /recoverStaleSession requires an attested legacy_stateful transport identity/,
  );
  assert.equal(harness.snapshot().invocations, 0);
}

console.log("mcp transport supervisor tests passed");
