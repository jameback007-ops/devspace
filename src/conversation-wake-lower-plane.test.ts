import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { ConversationTransportConfig } from "./config.js";
import type { ConversationTransportBridgePort } from "./conversation-transport-bridge-client.js";
import {
  CONVERSATION_TRANSPORT_BRIDGE_AUTHORITY,
  type ConversationBridgeDeliveryReceipt,
  type ConversationBridgeRequest,
  type ConversationBridgeTargetStatus,
} from "./conversation-transport-bridge-protocol.js";
import { ConversationTransportRuntime } from "./conversation-transport-tools.js";
import {
  canonicalJson,
  sha256,
} from "./execution-wake-coordination-model.js";
import { executionScopeIdentity } from "./request-meta.js";

const targetExecutionScopeRef = "1234567890abcdef";
const missionRef = "mission:conversation-host-turn-seam";
const actor = executionScopeIdentity({
  "devspace/execution-scope": "conversation-host-turn-seam-actor",
});
assert.ok(actor);

function config(): ConversationTransportConfig {
  return {
    enabled: true,
    effectsEnabled: true,
    bridgeSocketPath: "/tmp/not-used-conversation-host-turn.sock",
    bridgeTimeoutMs: 20_000,
  };
}

interface ScenarioBridgeOptions {
  lifecycle(call: number): string;
  deliver?: (
    request: Extract<ConversationBridgeRequest, { command: "deliver" }>,
  ) => Promise<ConversationBridgeDeliveryReceipt>;
}

class ScenarioBridge implements ConversationTransportBridgePort {
  statusCalls = 0;
  readonly deliveries: Array<Extract<
    ConversationBridgeRequest,
    { command: "deliver" }
  >> = [];

  constructor(private readonly options: ScenarioBridgeOptions) {}

  async status(targetAlias: string): Promise<ConversationBridgeTargetStatus> {
    this.statusCalls += 1;
    return status(targetAlias, this.options.lifecycle(this.statusCalls));
  }

  async deliver(
    request: Extract<ConversationBridgeRequest, { command: "deliver" }>,
  ): Promise<ConversationBridgeDeliveryReceipt> {
    this.deliveries.push(request);
    if (this.options.deliver) return this.options.deliver(request);
    return deliveredReceipt(request);
  }

  async reconcile(
    request: Extract<ConversationBridgeRequest, { command: "reconcile" }>,
  ): Promise<ConversationBridgeDeliveryReceipt> {
    throw new Error(`Unexpected bridge reconciliation: ${request.messageId}`);
  }
}

interface Fixture {
  root: string;
  runtime: ConversationTransportRuntime;
  bridge: ScenarioBridge;
  bindingRef: string;
  bindingGeneration: number;
}

async function fixture(
  t: TestContext,
  options: ScenarioBridgeOptions,
): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "devspace-conversation-wake-seam-"));
  const bridge = new ScenarioBridge(options);
  const runtime = new ConversationTransportRuntime(config(), root, { bridge });
  const bound = await runtime.bind({
    targetExecutionScopeRef,
    missionRef,
    targetAlias: "codex-seam",
  });
  t.after(async () => {
    runtime.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    runtime,
    bridge,
    bindingRef: bound.binding.bindingRef,
    bindingGeneration: bound.binding.bindingGeneration,
  };
}

function status(alias: string, lifecycle: string): ConversationBridgeTargetStatus {
  const observedAtMs = Date.now();
  const candidate = {
    transportId: `codex-app-server:${alias}`,
    targetKind: "codex_thread" as const,
    kind: "native_rpc" as const,
    availability: "available" as const,
    transportHealth: "healthy" as const,
    directInput: "available" as const,
    binding: "exact" as const,
    reconciliation: "available" as const,
    surfaceTrust: "official" as const,
    sessionLifecycle: lifecycle,
    evidenceRefs: [`codex-thread-lifecycle:${lifecycle}`],
  };
  const evidenceRefs = ["bridge-protocol:v1", ...candidate.evidenceRefs];
  return {
    schemaVersion: 1,
    targetAlias: alias,
    targetKind: "codex_thread",
    targetRefDigestSha256: "a".repeat(64),
    bindingRef: `bridge-target:${alias}`,
    bindingGeneration: 1,
    candidates: [candidate],
    observedAt: new Date(observedAtMs).toISOString(),
    expiresAt: new Date(observedAtMs + 30_000).toISOString(),
    evidenceDigestSha256: sha256(canonicalJson({
      candidates: [candidate],
      evidenceRefs,
    })),
    evidenceRefs,
    limitationCodes: [],
    authority: CONVERSATION_TRANSPORT_BRIDGE_AUTHORITY,
  };
}

function deliveredReceipt(
  request: Extract<ConversationBridgeRequest, { command: "deliver" }>,
): ConversationBridgeDeliveryReceipt {
  const recordedAt = new Date().toISOString();
  return {
    schemaVersion: 1,
    targetAlias: request.targetAlias,
    targetKind: "codex_thread",
    permitRef: request.permitRef,
    transportId: request.transportId,
    transportKind: request.transportKind,
    routeDigestSha256: request.routeDigestSha256,
    messageId: request.messageId,
    promptDigestSha256: request.promptDigestSha256,
    state: "delivered",
    deliveryRef: `delivery:${request.permitRef}`,
    turnRef: `turn:${request.permitRef}`,
    itemRef: `item:${request.permitRef}`,
    generationBoundaryRefAfter: `generation:${request.permitRef}`,
    verificationRefs: [`verification:${request.permitRef}`],
    recordedAt,
    authority: CONVERSATION_TRANSPORT_BRIDGE_AUTHORITY,
  };
}

function recordPending(runtime: ConversationTransportRuntime, suffix: string) {
  return runtime.wakeManager.recordPendingWork(actor, {
    idempotencyKey: `pending:${suffix}`,
    targetExecutionScopeRef,
    missionRef,
    sourceGeneration: 1,
    workCycleRef: `cycle:${suffix}`,
    correlationRef: `correlation:${suffix}`,
    taskRefs: [`task:${suffix}`],
    sourceAuthorityRefs: [`authority:${suffix}`],
    actionableCount: 1,
  }).value;
}

test("unobserved provider lifecycle never creates a wake permit", async (t) => {
  const context = await fixture(t, { lifecycle: () => "not_observed" });
  recordPending(context.runtime, "unknown");
  const result = await context.runtime.wakeManager.executeWake(actor, {
    idempotencyKey: "wake:unknown",
    targetExecutionScopeRef,
    missionRef,
  });
  assert.equal(result.assessment.decision, "HOLD");
  assert.equal(result.attempt, undefined);
  assert.equal(context.bridge.deliveries.length, 0);
  assert.ok(result.assessment.reasonCodes.includes("HOST_TURN_WAKE_GATE_MISSING"));
  const lifecycle = context.runtime.hostTurns.status(
    targetExecutionScopeRef,
    missionRef,
    context.bindingRef,
    context.bindingGeneration,
  );
  assert.equal(lifecycle.wakeGate.decision, "HOLD_NO_SESSION");
});

test("provider becoming active after lease acquisition prevents the external effect", async (t) => {
  const context = await fixture(t, {
    // bind=1, first assessment=2, post-lease assessment=3, effect preflight=4
    lifecycle: (call) => call >= 4 ? "active" : "idle",
  });
  recordPending(context.runtime, "preflight-active");
  const result = await context.runtime.wakeManager.executeWake(actor, {
    idempotencyKey: "wake:preflight-active",
    targetExecutionScopeRef,
    missionRef,
  });
  assert.equal(result.attempt?.state, "failed_no_effect");
  assert.equal(
    result.attempt?.failureCode,
    "PREFLIGHT_HOST_TURN_NOT_WAKE_ELIGIBLE",
  );
  assert.equal(context.bridge.deliveries.length, 0);
  const lifecycle = context.runtime.hostTurns.status(
    targetExecutionScopeRef,
    missionRef,
    context.bindingRef,
    context.bindingGeneration,
  );
  assert.equal(lifecycle.currentTurn?.state, "running");
  assert.equal(lifecycle.wakeGate.decision, "HOLD_ACTIVE_TURN");
});

test("transport loss after the effect boundary becomes durable indeterminate and reconciliation closes both planes", async (t) => {
  const context = await fixture(t, {
    lifecycle: () => "idle",
    deliver: async () => {
      throw new Error("transport lost after dispatch boundary");
    },
  });
  recordPending(context.runtime, "indeterminate");
  const result = await context.runtime.wakeManager.executeWake(actor, {
    idempotencyKey: "wake:indeterminate",
    targetExecutionScopeRef,
    missionRef,
  });
  assert.equal(result.attempt?.state, "indeterminate");
  assert.ok(result.attempt);
  assert.equal(context.bridge.deliveries.length, 1);
  let lifecycle = context.runtime.hostTurns.status(
    targetExecutionScopeRef,
    missionRef,
    context.bindingRef,
    context.bindingGeneration,
  );
  assert.equal(lifecycle.currentTurn?.state, "indeterminate");
  assert.equal(lifecycle.wakeGate.decision, "HOLD_INDETERMINATE_TURN");

  const reconciled = context.runtime.wakeManager.reconcileAttempt(actor, {
    idempotencyKey: "wake:indeterminate:reconcile",
    attemptId: result.attempt.attemptId,
    expectedRevision: result.attempt.revision,
    resolution: "effect_absent",
    interactionReconciliationRef: "interaction-reconciliation:absent",
    authorityReadbackRef: "authority-readback:absent",
    effectReadbackRef: "effect-readback:absent",
    verificationRefs: ["verification:effect-absent"],
  });
  assert.equal(reconciled.value.state, "reconciled_effect_absent");
  lifecycle = context.runtime.hostTurns.status(
    targetExecutionScopeRef,
    missionRef,
    context.bindingRef,
    context.bindingGeneration,
  );
  assert.equal(lifecycle.currentTurn?.state, "cancelled");
  assert.equal(lifecycle.wakeGate.decision, "ALLOW_TERMINAL_TURN");
});
