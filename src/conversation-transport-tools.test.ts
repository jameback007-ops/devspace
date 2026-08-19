import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConversationTransportConfig } from "./config.js";
import type { ConversationTransportBridgePort } from "./conversation-transport-bridge-client.js";
import {
  CONVERSATION_TRANSPORT_BRIDGE_AUTHORITY,
  type ConversationBridgeDeliveryReceipt,
  type ConversationBridgeRequest,
  type ConversationBridgeTargetStatus,
} from "./conversation-transport-bridge-protocol.js";
import { ConversationTransportRuntime } from "./conversation-transport-tools.js";
import { executionScopeIdentity } from "./request-meta.js";

const actor = executionScopeIdentity({
  "devspace/execution-scope": "conversation-transport-test-actor",
});
assert.ok(actor);

const targetExecutionScopeRef = "1234567890abcdef";
const missionRef = "mission:direct-first-test";

function config(effectsEnabled = true): ConversationTransportConfig {
  return {
    enabled: true,
    effectsEnabled,
    bridgeSocketPath: "/tmp/not-used-conversation-bridge.sock",
    bridgeTimeoutMs: 20_000,
  };
}

function nativeStatus(alias = "codex-canary"): ConversationBridgeTargetStatus {
  const observedAtMs = Date.now();
  return {
    schemaVersion: 1,
    targetAlias: alias,
    targetKind: "codex_thread",
    targetRefDigestSha256: "a".repeat(64),
    bindingRef: `bridge-target:${alias}`,
    bindingGeneration: 1,
    candidates: [
      {
        transportId: `codex-app-server:${alias}`,
        targetKind: "codex_thread",
        kind: "native_rpc",
        availability: "available",
        transportHealth: "healthy",
        directInput: "available",
        binding: "exact",
        reconciliation: "available",
        surfaceTrust: "official",
        sessionLifecycle: "idle",
        evidenceRefs: ["codex-app-server:thread-read"],
      },
      {
        transportId: `app-server-mcp-playwright:${alias}`,
        targetKind: "codex_thread",
        kind: "web_ui",
        availability: "available",
        transportHealth: "healthy",
        directInput: "available",
        binding: "exact",
        reconciliation: "available",
        surfaceTrust: "ui_contract",
        sessionLifecycle: "responsive_idle",
        evidenceRefs: ["playwright:exact-binding"],
      },
    ],
    observedAt: new Date(observedAtMs).toISOString(),
    expiresAt: new Date(observedAtMs + 30_000).toISOString(),
    evidenceDigestSha256: "b".repeat(64),
    evidenceRefs: ["bridge-protocol:v1"],
    limitationCodes: [],
    authority: CONVERSATION_TRANSPORT_BRIDGE_AUTHORITY,
  };
}

function workStatus(alias = "work-canary"): ConversationBridgeTargetStatus {
  const status = nativeStatus(alias);
  return {
    ...status,
    targetKind: "chatgpt_work",
    targetRefDigestSha256: "c".repeat(64),
    candidates: [
      {
        ...status.candidates[0],
        transportId: `codex-app-server:${alias}`,
        targetKind: "chatgpt_work",
        availability: "unavailable",
        transportHealth: "unavailable",
        directInput: "unavailable",
        binding: "unknown",
        reconciliation: "unavailable",
        evidenceRefs: ["limitation:UPSTREAM_CHAT_WORK_NATIVE_CONTROL_PROTOCOL_UNATTESTED"],
      },
      {
        ...status.candidates[1],
        transportId: `app-server-mcp-playwright:${alias}`,
        targetKind: "chatgpt_work",
      },
    ],
    limitationCodes: ["UPSTREAM_CHAT_WORK_NATIVE_CONTROL_PROTOCOL_UNATTESTED"],
  };
}

class FakeBridge implements ConversationTransportBridgePort {
  readonly deliveries: Array<Extract<ConversationBridgeRequest, { command: "deliver" }>> = [];

  constructor(readonly statuses: Record<string, ConversationBridgeTargetStatus>) {}

  async status(targetAlias: string): Promise<ConversationBridgeTargetStatus> {
    const status = this.statuses[targetAlias];
    if (!status) throw new Error("target alias not allowlisted");
    return status;
  }

  async deliver(
    request: Extract<ConversationBridgeRequest, { command: "deliver" }>,
  ): Promise<ConversationBridgeDeliveryReceipt> {
    this.deliveries.push(request);
    const target = this.statuses[request.targetAlias];
    assert.ok(target);
    const selected = target.candidates.find(
      (candidate) => candidate.transportId === request.transportId,
    );
    if (selected) selected.sessionLifecycle = "active";
    return {
      schemaVersion: 1,
      targetAlias: request.targetAlias,
      targetKind: target.targetKind,
      permitRef: request.permitRef,
      transportId: request.transportId,
      transportKind: request.transportKind,
      routeDigestSha256: request.routeDigestSha256,
      messageId: request.messageId,
      promptDigestSha256: request.promptDigestSha256,
      state: "delivered",
      deliveryRef: "ctd_test_delivery",
      turnRef: "turn-test-1",
      itemRef: "item-test-1",
      generationBoundaryRefAfter: "turn-test-1",
      verificationRefs: ["reconciliation:client-message-id"],
      recordedAt: new Date().toISOString(),
      authority: CONVERSATION_TRANSPORT_BRIDGE_AUTHORITY,
    };
  }

  async reconcile(
    request: Extract<ConversationBridgeRequest, { command: "reconcile" }>,
  ): Promise<ConversationBridgeDeliveryReceipt> {
    throw new Error(`Unexpected reconciliation for ${request.messageId}`);
  }
}

{
  const root = mkdtempSync(join(tmpdir(), "devspace-conversation-transport-test-"));
  const bridge = new FakeBridge({ "codex-canary": nativeStatus() });
  const runtime = new ConversationTransportRuntime(config(true), root, { bridge });
  try {
    const bound = await runtime.bind({
      targetExecutionScopeRef,
      missionRef,
      targetAlias: "codex-canary",
    });
    assert.equal(bound.binding.targetAlias, "codex-canary");
    assert.equal(bound.binding.targetKind, "codex_thread");
    assert.equal("threadId" in bound.binding, false);
    assert.equal("url" in bound.binding, false);

    const assessment = await runtime.lowerPlane.assess({
      targetExecutionScopeRef,
      missionRef,
    });
    assert.equal(assessment.route.state, "selected");
    if (assessment.route.state !== "selected") throw new Error("expected selected route");
    assert.equal(assessment.route.selected.kind, "native_rpc");
    assert.equal(assessment.readiness.transportId, "codex-app-server:codex-canary");
    assert.equal(assessment.readiness.transportKind, "native_rpc");
    assert.equal(assessment.readiness.hostTurnGate?.state, "awaiting_input");
    assert.match(assessment.readiness.transportRouteDigestSha256 ?? "", /^[a-f0-9]{64}$/);

    const pending = runtime.wakeManager.recordPendingWork(actor, {
      idempotencyKey: "pending-work-1",
      targetExecutionScopeRef,
      missionRef,
      sourceGeneration: 1,
      workCycleRef: "cycle:1",
      correlationRef: "correlation:1",
      taskRefs: ["task:1"],
      sourceAuthorityRefs: ["authority:test"],
      actionableCount: 1,
    });
    assert.equal(pending.value.state, "pending");

    const result = await runtime.wakeManager.executeWake(actor, {
      idempotencyKey: "execute-wake-1",
      targetExecutionScopeRef,
      missionRef,
    });
    assert.equal(result.assessment.decision, "ALREADY_VERIFIED");
    assert.equal(result.attempt?.state, "verified");
    assert.equal(result.attempt?.permit.transportKind, "native_rpc");
    assert.equal(
      result.attempt?.permit.transportId,
      "codex-app-server:codex-canary",
    );
    assert.match(
      result.attempt?.permit.transportRouteDigestSha256 ?? "",
      /^[a-f0-9]{64}$/,
    );
    assert.equal(bridge.deliveries.length, 1);
    const delivery = bridge.deliveries[0];
    assert.equal("threadId" in delivery, false);
    assert.equal("url" in delivery, false);
    assert.equal(delivery.targetAlias, "codex-canary");
    assert.equal(delivery.promptDigestSha256, result.attempt?.permit.envelope.bodyDigestSha256);
    const lifecycle = runtime.hostTurns.status(
      targetExecutionScopeRef,
      missionRef,
      bound.binding.bindingRef,
      bound.binding.bindingGeneration,
    );
    assert.equal(lifecycle.currentTurn?.state, "started");
    assert.equal(lifecycle.currentTurn?.generation, 2);
    assert.equal(lifecycle.currentTurn?.wakePermitRef, result.attempt?.permit.permitRef);
    const activeAssessment = await runtime.lowerPlane.assess({
      targetExecutionScopeRef,
      missionRef,
    });
    assert.equal(activeAssessment.readiness.wakePermitted, false);
    assert.ok(activeAssessment.readiness.reasonCodes.some((code) =>
      code.includes("HOLD_ACTIVE_TURN")));
    const revisionBeforeStatus = runtime.hostTurns.status(
      targetExecutionScopeRef,
      missionRef,
      bound.binding.bindingRef,
      bound.binding.bindingGeneration,
    ).currentTurn?.revision;
    const transportStatus = await runtime.status({
      targetExecutionScopeRef,
      missionRef,
    });
    assert.equal(transportStatus.hostTurnLifecycle.currentTurn?.state, "running");
    assert.equal(
      transportStatus.hostTurnLifecycle.wakeGate.decision,
      "HOLD_ACTIVE_TURN",
    );
    assert.equal(
      runtime.hostTurns.status(
        targetExecutionScopeRef,
        missionRef,
        bound.binding.bindingRef,
        bound.binding.bindingGeneration,
      ).currentTurn?.revision,
      revisionBeforeStatus,
    );
    const wakeStatus = runtime.wakeStatus(actor, {
      targetExecutionScopeRef,
      missionRef,
    });
    assert.equal(wakeStatus.hostTurnLifecycle.currentTurn?.generation, 2);
    assert.equal(wakeStatus.currentPendingWork?.state, "wake_verified");

    const replay = await runtime.wakeManager.executeWake(actor, {
      idempotencyKey: "execute-wake-1",
      targetExecutionScopeRef,
      missionRef,
    });
    assert.equal(replay.idempotentReplay, true);
    assert.equal(bridge.deliveries.length, 1);
  } finally {
    runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
}

{
  const root = mkdtempSync(join(tmpdir(), "devspace-conversation-work-test-"));
  const bridge = new FakeBridge({ "work-canary": workStatus() });
  const runtime = new ConversationTransportRuntime(config(true), root, { bridge });
  try {
    await runtime.bind({
      targetExecutionScopeRef,
      missionRef: "mission:work-fallback",
      targetAlias: "work-canary",
    });
    const assessment = await runtime.lowerPlane.assess({
      targetExecutionScopeRef,
      missionRef: "mission:work-fallback",
    });
    assert.equal(assessment.route.state, "selected");
    if (assessment.route.state !== "selected") throw new Error("expected selected route");
    assert.equal(assessment.route.selected.kind, "web_ui");
    assert.equal(
      assessment.route.considered[0]?.observation.kind,
      "native_rpc",
    );
    assert.equal(assessment.route.considered[0]?.eligible, false);
    assert.equal(assessment.readiness.transportKind, "web_ui");
  } finally {
    runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
}

{
  const root = mkdtempSync(join(tmpdir(), "devspace-conversation-disabled-test-"));
  const bridge = new FakeBridge({ "codex-canary": nativeStatus() });
  const runtime = new ConversationTransportRuntime(config(false), root, { bridge });
  try {
    await runtime.bind({
      targetExecutionScopeRef,
      missionRef: "mission:effects-disabled",
      targetAlias: "codex-canary",
    });
    const assessment = await runtime.lowerPlane.assess({
      targetExecutionScopeRef,
      missionRef: "mission:effects-disabled",
    });
    assert.equal(assessment.readiness.wakePermitted, false);
    assert.deepEqual(
      assessment.readiness.reasonCodes,
      ["CONVERSATION_TRANSPORT_EFFECTS_DISABLED"],
    );
  } finally {
    runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
}

console.log("conversation transport integration tests passed");
