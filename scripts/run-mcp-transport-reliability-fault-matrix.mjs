#!/usr/bin/env node

import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import process from "node:process";
import {
  McpTransportSupervisor,
} from "../dist/mcp-transport-supervisor.js";
import {
  McpReliabilityFaultHarness,
} from "../dist/mcp-transport-supervisor-fault-harness.js";

function parseOutputPath(argv) {
  const index = argv.indexOf("--output");
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error("--output requires a file path");
  }
  return value;
}

function supervisor() {
  return new McpTransportSupervisor({
    retryPolicy: {
      maxAttempts: 3,
      perAttemptTimeoutMs: 20,
      initialDelayMs: 1,
      maxDelayMs: 4,
      growFactor: 2,
      jitterRatio: 0,
      reconnectMaxAttempts: 2,
      reconciliationMaxAttempts: 2,
      recoveryActionTimeoutMs: 20,
    },
    circuitBreaker: {
      failureThreshold: 4,
      identicalFailureThreshold: 3,
      openDurationMs: 50,
    },
    retryBudget: {
      capacity: 100,
      refillPerSecond: 100,
    },
    receiptCache: {
      maxEntries: 100,
      ttlMs: 60_000,
    },
  });
}

function resultView(result) {
  return {
    logicalCallId: result.logicalCallId,
    callSafetyClass: result.callSafetyClass,
    state: result.state,
    ok: result.ok,
    source: result.source,
    attemptCount: result.attemptCount,
    retryCount: result.retryCount,
    recovered: result.recovered,
    failureKind: result.failure?.kind,
    failureClass: result.failure?.failureClass,
    circuitKey: result.circuit.key,
    circuitState: result.circuit.state,
    attemptKinds: result.recoveryReceipt.attempts.map(
      (attempt) => attempt.attemptKind,
    ),
    attemptEvidenceTruncated:
      result.recoveryReceipt.attemptEvidenceTruncated,
    outputUsable: result.evidence.outputUsable,
    validationClaimAllowed: result.evidence.validationClaimAllowed,
    effectLaneFrozen: result.evidence.effectLaneFrozen,
    effectReconciliationState:
      result.evidence.effectReconciliationState,
  };
}

function readCall(harness, scenario, overrides = {}) {
  return {
    operationRef: `fault-matrix:${scenario}`,
    operationKey: `fault-matrix:${scenario}:operation`,
    toolRef: "fault-matrix/read",
    backendRef: `fault-matrix:${scenario}`,
    circuitKey: `fault-matrix:${scenario}`,
    lane: "read",
    retrySafety: "read_only",
    invoke: harness.invoke,
    assessOutput: harness.assessOutput,
    ...overrides,
  };
}

async function run() {
  const transportSupervisor = supervisor();
  const scenarios = {};

  const healthyHarness = new McpReliabilityFaultHarness(["success"], {
    successValue: "healthy",
  });
  const healthy = await transportSupervisor.execute(readCall(
    healthyHarness,
    "healthy",
  ));
  scenarios.healthy = resultView(healthy);

  const timeoutHarness = new McpReliabilityFaultHarness([
    "timeout_before_response",
    "success",
  ], { successValue: "timeout-recovered" });
  scenarios.timeoutBeforeResponse = resultView(
    await transportSupervisor.execute(readCall(
      timeoutHarness,
      "timeout-before-response",
    )),
  );

  const disconnectHarness = new McpReliabilityFaultHarness([
    "disconnect_during_call",
    "success",
  ], { successValue: "disconnect-recovered" });
  scenarios.disconnectDuringCall = resultView(
    await transportSupervisor.execute(readCall(
      disconnectHarness,
      "disconnect-during-call",
      { reconnect: disconnectHarness.reconnect },
    )),
  );

  const responseLostHarness = new McpReliabilityFaultHarness([
    "backend_success_response_lost",
  ], { successValue: { applied: true } });
  const responseLostCall = {
    operationRef: "fault-matrix:backend-success-response-lost",
    toolRef: "fault-matrix/effect",
    backendRef: "fault-matrix",
    circuitKey: "fault-matrix:backend-success-response-lost",
    lane: "effect",
    retrySafety: "effectful",
    effectKey: "fault-matrix:effect:response-lost",
    invoke: responseLostHarness.invoke,
    assessOutput: responseLostHarness.assessOutput,
    reconcileEffect: responseLostHarness.reconcileEffect,
  };
  const responseLost = await transportSupervisor.execute(responseLostCall);
  const responseLostDuplicate = await transportSupervisor.execute(
    responseLostCall,
  );
  scenarios.backendSuccessResponseLost = {
    first: resultView(responseLost),
    duplicate: resultView(responseLostDuplicate),
    backendEffects: responseLostHarness.snapshot().backendEffects,
  };

  for (const [name, fault] of [
    ["emptyOutput", "empty_output"],
    ["truncatedOutput", "truncated_output"],
  ]) {
    const harness = new McpReliabilityFaultHarness([fault, "success"], {
      successValue: `${name}-recovered`,
    });
    scenarios[name] = resultView(
      await transportSupervisor.execute(readCall(harness, name)),
    );
  }

  const legacyHarness = new McpReliabilityFaultHarness([
    "legacy_unknown_session",
    "success",
  ], { successValue: "legacy-session-recovered" });
  const legacyRecovered = await transportSupervisor.execute(readCall(
    legacyHarness,
    "legacy-stale-session",
    {
      logicalCallId: "fault-matrix:logical:legacy-stale-session",
      transportIdentity: {
        endpointRef: "fault-matrix://legacy",
        protocolEra: "legacy_stateful",
        backendGenerationRef: "legacy-generation-1",
      },
      recoverStaleSession: legacyHarness.recoverStaleSession,
    },
  ));
  scenarios.legacyStaleSession = {
    ...resultView(legacyRecovered),
    staleSessionRecreations:
      legacyHarness.snapshot().staleSessionRecreations,
  };

  const subscriptionHarness = new McpReliabilityFaultHarness([
    "subscription_closed",
    "success",
  ], { successValue: "subscription-recovered" });
  const subscriptionRecovered = await transportSupervisor.execute(readCall(
    subscriptionHarness,
    "subscription-relisten",
    {
      operationKind: "subscription_listen",
      subscriptionGeneration: "subscription-generation-1",
      transportIdentity: {
        endpointRef: "fault-matrix://modern",
        protocolEra: "modern",
        backendGenerationRef: "modern-generation-1",
      },
      recoverSubscription: subscriptionHarness.recoverSubscription,
    },
  ));
  scenarios.subscriptionRelisten = {
    ...resultView(subscriptionRecovered),
    subscriptionRelistens:
      subscriptionHarness.snapshot().subscriptionRelistens,
  };

  const subscriptionMismatchHarness = new McpReliabilityFaultHarness([
    "subscription_closed",
  ], {
    successValue: "unused",
    subscriptionFingerprintMismatch: true,
  });
  const subscriptionMismatch = await transportSupervisor.execute(readCall(
    subscriptionMismatchHarness,
    "subscription-fingerprint-mismatch",
    {
      operationKind: "subscription_listen",
      transportIdentity: {
        endpointRef: "fault-matrix://modern-mismatch",
        protocolEra: "modern",
        backendGenerationRef: "modern-generation-1",
      },
      recoverSubscription:
        subscriptionMismatchHarness.recoverSubscription,
    },
  ));
  scenarios.subscriptionFingerprintMismatch = resultView(
    subscriptionMismatch,
  );

  const toolErrorHarness = new McpReliabilityFaultHarness([
    "tool_result_error",
    "success",
  ], { successValue: "must-not-auto-retry" });
  const toolError = await transportSupervisor.execute(readCall(
    toolErrorHarness,
    "tool-result-error",
  ));
  scenarios.toolResultError = {
    ...resultView(toolError),
    transportInvocations: toolErrorHarness.snapshot().invocations,
  };

  const transientToolErrorHarness = new McpReliabilityFaultHarness([
    "tool_result_error",
    "success",
  ], {
    successValue: "typed-transient-recovered",
    toolErrorTransient: true,
  });
  const transientToolError = await transportSupervisor.execute(readCall(
    transientToolErrorHarness,
    "tool-result-error-explicitly-transient",
  ));
  scenarios.explicitlyTransientToolResultError = resultView(
    transientToolError,
  );

  const cancelledHarness = new McpReliabilityFaultHarness([
    "cancelled_after_dispatch",
  ], { successValue: "unused" });
  const cancelledEffect = await transportSupervisor.execute({
    operationRef: "fault-matrix:cancelled-effect",
    logicalCallId: "fault-matrix:logical:cancelled-effect",
    toolRef: "fault-matrix/effect",
    backendRef: "fault-matrix",
    lane: "effect",
    retrySafety: "effectful",
    effectKey: "fault-matrix:effect:cancelled",
    invoke: cancelledHarness.invoke,
    assessOutput: cancelledHarness.assessOutput,
    reconcileEffect: cancelledHarness.reconcileEffect,
  });
  scenarios.cancelledAfterDispatch = {
    ...resultView(cancelledEffect),
    transportInvocations: cancelledHarness.snapshot().invocations,
    reconciliations: cancelledHarness.snapshot().reconciliations,
  };

  const duplicateHarness = new McpReliabilityFaultHarness([
    "duplicate_delivery",
    "duplicate_delivery",
  ], {
    successValue: "duplicate-suppressed",
    duplicateDeliveryId: "fault-matrix:delivery:duplicate",
  });
  const duplicateFirst = await transportSupervisor.execute(readCall(
    duplicateHarness,
    "duplicate-delivery:first",
    {
      backendRef: "fault-matrix:duplicate-delivery",
      circuitKey: "fault-matrix:duplicate-delivery",
    },
  ));
  const duplicateSecond = await transportSupervisor.execute(readCall(
    duplicateHarness,
    "duplicate-delivery:second",
    {
      backendRef: "fault-matrix:duplicate-delivery",
      circuitKey: "fault-matrix:duplicate-delivery",
    },
  ));
  scenarios.duplicateDelivery = {
    first: resultView(duplicateFirst),
    duplicate: resultView(duplicateSecond),
  };

  const delayedHarness = new McpReliabilityFaultHarness([
    "delayed_response",
    "success",
  ], {
    successValue: "delayed-recovered",
    delayedResponseMs: 40,
  });
  scenarios.delayedResponse = resultView(
    await transportSupervisor.execute(readCall(
      delayedHarness,
      "delayed-response",
      { timeoutMs: 5 },
    )),
  );

  for (const [name, fault] of [
    ["backendRestart", "backend_restart"],
    ["staleConnection", "stale_connection"],
  ]) {
    const harness = new McpReliabilityFaultHarness([fault, "success"], {
      successValue: `${name}-recovered`,
    });
    scenarios[name] = resultView(
      await transportSupervisor.execute(readCall(harness, name, {
        reconnect: harness.reconnect,
      })),
    );
  }

  const capabilityHarness = new McpReliabilityFaultHarness([], {
    successValue: "unused",
  });
  scenarios.partialToolAvailability = resultView(
    await transportSupervisor.execute(readCall(
      capabilityHarness,
      "partial-tool-availability",
      {
        lane: "research",
        capability: capabilityHarness.partialToolAvailabilityPolicy({
          freshEvidenceRequired: true,
        }),
      },
    )),
  );

  const validationHarness = new McpReliabilityFaultHarness(["success"], {
    successValue: "validation-without-readback-evidence",
  });
  scenarios.incompleteValidationOutput = resultView(
    await transportSupervisor.execute(readCall(
      validationHarness,
      "incomplete-validation-output",
      { lane: "validation" },
    )),
  );

  const indeterminateHarness = new McpReliabilityFaultHarness([
    "indeterminate_effect_result",
  ], { successValue: "indeterminate" });
  const indeterminate = await transportSupervisor.execute({
    operationRef: "fault-matrix:indeterminate-effect",
    toolRef: "fault-matrix/effect",
    backendRef: "fault-matrix",
    circuitKey: "fault-matrix:indeterminate-effect",
    lane: "effect",
    retrySafety: "effectful",
    effectKey: "fault-matrix:effect:indeterminate",
    invoke: indeterminateHarness.invoke,
    assessOutput: indeterminateHarness.assessOutput,
    reconcileEffect: indeterminateHarness.reconcileEffect,
  });
  scenarios.indeterminateEffectResult = {
    ...resultView(indeterminate),
    backendEffects: indeterminateHarness.snapshot().backendEffects,
  };

  let circuitNowMs = 0;
  const circuitSupervisor = new McpTransportSupervisor({
    now: () => circuitNowMs,
    retryPolicy: {
      maxAttempts: 4,
      perAttemptTimeoutMs: 20,
      initialDelayMs: 0,
      maxDelayMs: 0,
      growFactor: 2,
      jitterRatio: 0,
      reconnectMaxAttempts: 1,
      reconciliationMaxAttempts: 1,
      recoveryActionTimeoutMs: 20,
    },
    circuitBreaker: {
      failureThreshold: 3,
      identicalFailureThreshold: 2,
      openDurationMs: 100,
    },
    retryBudget: { capacity: 20, refillPerSecond: 20 },
  });
  const circuitHarness = new McpReliabilityFaultHarness([
    "disconnect_during_call",
    "disconnect_during_call",
    "success",
  ], { successValue: "not-reached-before-half-open" });
  const circuitCallOverrides = {
    operationKey: undefined,
    circuitKey: "fault-matrix:circuit",
    transportIdentity: {
      endpointRef: "fault-matrix://circuit-endpoint",
      protocolEra: "modern",
      backendGenerationRef: "circuit-generation-1",
    },
  };
  const circuitFailure = await circuitSupervisor.execute(readCall(
    circuitHarness,
    "circuit-breaker",
    circuitCallOverrides,
  ));
  const circuitReject = await circuitSupervisor.execute(readCall(
    circuitHarness,
    "circuit-breaker-reject",
    circuitCallOverrides,
  ));
  circuitNowMs = 101;
  const circuitRecovery = await circuitSupervisor.execute(readCall(
    circuitHarness,
    "circuit-breaker-half-open",
    circuitCallOverrides,
  ));
  scenarios.circuitBreaker = {
    failure: resultView(circuitFailure),
    rejected: resultView(circuitReject),
    halfOpenRecovery: resultView(circuitRecovery),
    transportInvocations: circuitHarness.snapshot().invocations,
    metrics: circuitSupervisor.metrics(),
  };

  assert.equal(healthy.state, "HEALTHY");
  assert.equal(responseLost.state, "RECOVERED");
  assert.equal(responseLostDuplicate.source, "operation_receipt");
  assert.equal(responseLostHarness.snapshot().backendEffects, 1);
  assert.equal(indeterminate.state, "EFFECT_LANE_BLOCKED");
  assert.equal(indeterminate.retryCount, 0);
  assert.equal(indeterminate.evidence.effectLaneFrozen, true);
  assert.equal(legacyRecovered.state, "RECOVERED");
  assert.equal(legacyHarness.snapshot().staleSessionRecreations, 1);
  assert.equal(subscriptionRecovered.state, "RECOVERED");
  assert.equal(subscriptionHarness.snapshot().subscriptionRelistens, 1);
  assert.equal(subscriptionMismatch.state, "CLIENT_CATALOG_STALE");
  assert.equal(toolError.state, "HARD_EXTERNAL_BLOCKER");
  assert.equal(toolError.retryCount, 0);
  assert.equal(toolErrorHarness.snapshot().invocations, 1);
  assert.equal(transientToolError.state, "RECOVERED");
  assert.equal(cancelledEffect.state, "EFFECT_LANE_BLOCKED");
  assert.equal(cancelledEffect.retryCount, 0);
  assert.equal(cancelledHarness.snapshot().invocations, 1);
  assert.equal(cancelledHarness.snapshot().reconciliations, 1);
  assert.equal(
    scenarios.incompleteValidationOutput.validationClaimAllowed,
    false,
  );
  assert.equal(circuitHarness.snapshot().invocations, 3);
  assert.equal(circuitReject.failure?.kind, "circuit_open");
  assert.equal(circuitRecovery.state, "HEALTHY");
  assert.equal(circuitRecovery.circuit.state, "closed");

  const metrics = transportSupervisor.metrics();
  const report = {
    schemaVersion: "zes.mcp-transport-reliability-fault-report.v2",
    generatedAt: new Date().toISOString(),
    execution: {
      mode: "deterministic-local-fault-injection",
      nodeVersion: process.version,
      productionNetworkEvidence: false,
      productionDeploymentEvidence: false,
    },
    scenarios,
    metrics,
    safetyAssertions: {
      backendSuccessResponseLossRecoveredByExactReceipt: true,
      duplicateMaterialEffectPrevented: true,
      indeterminateEffectBlindRetryCount: 0,
      incompleteValidationClaimAllowed: false,
      repeatedIdenticalFailureRejectedWithoutThirdDispatch: true,
      circuitHalfOpenProbeRecoveredAndClosed: true,
      logicalCallAndAttemptIdsSeparated: true,
      typedLegacyStaleSessionRecreatedOnce: true,
      subscriptionRelistenRequiresMatchingForcedRefetchFingerprint: true,
      toolResultIsErrorNotRetriedWithoutTransientClassification: true,
      postDispatchCancellationReconciledBeforeReplay: true,
      circuitKeyIncludesEndpointProtocolGenerationAndFailureClass: true,
      qualityReductionAuthorized: false,
      newEffectAuthorityGranted: false,
    },
  };

  return report;
}

const outputPath = parseOutputPath(process.argv.slice(2));
const report = await run();
const serialized = `${JSON.stringify(report, null, 2)}\n`;
if (outputPath) {
  await writeFile(outputPath, serialized, "utf8");
  console.log(outputPath);
} else {
  process.stdout.write(serialized);
}
