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
  status?: (
    targetAlias: string,
    call: number,
  ) => ConversationBridgeTargetStatus;
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
    if (this.options.status) {
      return this.options.status(targetAlias, this.statusCalls);
    }
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
  targetKind: "codex_thread" | "chatgpt_chat" = "codex_thread",
): ConversationBridgeDeliveryReceipt {
  const recordedAt = new Date().toISOString();
  return {
    schemaVersion: 1,
    targetAlias: request.targetAlias,
    targetKind,
    permitRef: request.permitRef,
    transportId: request.transportId,
    transportKind: request.transportKind,
    routeDigestSha256: request.routeDigestSha256,
    messageId: request.messageId,
    promptDigestSha256: request.promptDigestSha256,
    conversationUrlDigestSha256: request.conversationUrlDigestSha256,
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

function webStatus(
  alias: string,
  lifecycle: string,
  conversationUrlDigestSha256: string,
): ConversationBridgeTargetStatus {
  const observedAtMs = Date.now();
  const candidate = {
    transportId: `app-server-mcp-playwright:${alias}`,
    targetKind: "chatgpt_chat" as const,
    kind: "web_ui" as const,
    availability: "available" as const,
    transportHealth: "healthy" as const,
    directInput: "available" as const,
    binding: "exact" as const,
    reconciliation: "available" as const,
    surfaceTrust: "ui_contract" as const,
    sessionLifecycle: lifecycle,
    conversationUrlDigestSha256,
    evidenceRefs: [
      `web-ui-lifecycle:${lifecycle}`,
      `conversation-url-sha256:${conversationUrlDigestSha256}`,
    ],
  };
  const evidenceRefs = ["bridge-protocol:v1", ...candidate.evidenceRefs];
  return {
    schemaVersion: 1,
    targetAlias: alias,
    targetKind: "chatgpt_chat",
    targetRefDigestSha256: "c".repeat(64),
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
  assert.equal(
    (context.runtime.database.sqlite.prepare(`
      select count(*) as count from interaction_broker_sessions
    `).get() as { count: number }).count,
    0,
  );
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

test("Web UI wake binds the exact conversation URL digest while the prompt stays ephemeral", async (t) => {
  const conversationUrlDigestSha256 = "d".repeat(64);
  const context = await fixture(t, {
    lifecycle: () => "responsive_idle",
    status: (alias) => webStatus(
      alias,
      "responsive_idle",
      conversationUrlDigestSha256,
    ),
    deliver: async (request) => deliveredReceipt(request, "chatgpt_chat"),
  });
  recordPending(context.runtime, "web-ui-exact-url");
  const result = await context.runtime.wakeManager.executeWake(actor, {
    idempotencyKey: "wake:web-ui-exact-url",
    targetExecutionScopeRef,
    missionRef,
  });
  assert.equal(result.attempt?.state, "verified");
  assert.equal(
    result.attempt?.permit.conversationUrlDigestSha256,
    conversationUrlDigestSha256,
  );
  assert.equal(context.bridge.deliveries.length, 1);
  const delivery = context.bridge.deliveries[0];
  assert.ok(delivery);
  assert.equal(delivery.conversationUrlDigestSha256, conversationUrlDigestSha256);
  assert.match(delivery.prompt, /Do not infer completion from silence/i);
  assert.equal(
    sha256(delivery.prompt),
    result.attempt?.permit.envelope.bodyDigestSha256,
  );
  assert.equal("body" in (result.attempt?.permit.envelope ?? {}), false);
  assert.doesNotMatch(
    JSON.stringify(result.attempt),
    /Do not infer completion from silence/i,
  );
  assert.equal(
    result.attempt?.lowerPlaneResult?.conversationUrlDigestSha256,
    conversationUrlDigestSha256,
  );
  const sessionRef = result.attempt?.lowerPlaneResult?.interactionSessionRef;
  assert.ok(sessionRef?.startsWith("ixs_wake_"));
  const persisted = context.runtime.database.sqlite.prepare(`
    select version, payload_json
    from interaction_broker_sessions
    where session_ref = ?
  `).get(sessionRef) as { version: number; payload_json: string } | undefined;
  assert.ok(persisted);
  assert.ok(persisted.version >= 5);
  const brokerRecord = JSON.parse(persisted.payload_json) as {
    checkpoint: { state: string; pendingAction?: unknown };
  };
  assert.equal(brokerRecord.checkpoint.state, "verified");
  assert.equal(brokerRecord.checkpoint.pendingAction, undefined);
  assert.doesNotMatch(
    persisted.payload_json,
    /Do not infer completion from silence/i,
  );
  assert.equal(
    (context.runtime.database.sqlite.prepare(`
      select count(*) as count
      from interaction_broker_leases
      where expires_at_ms > ?
    `).get(Date.now()) as { count: number }).count,
    0,
  );

});

test("Web UI URL-binding drift after permit issuance fails before prompt dispatch", async (t) => {
  const originalDigest = "d".repeat(64);
  const changedDigest = "e".repeat(64);
  const context = await fixture(t, {
    lifecycle: () => "responsive_idle",
    status: (alias, call) => webStatus(
      alias,
      "responsive_idle",
      call >= 4 ? changedDigest : originalDigest,
    ),
  });
  recordPending(context.runtime, "web-ui-url-drift");
  const result = await context.runtime.wakeManager.executeWake(actor, {
    idempotencyKey: "wake:web-ui-url-drift",
    targetExecutionScopeRef,
    missionRef,
  });
  assert.equal(result.attempt?.state, "failed_no_effect");
  assert.equal(
    result.attempt?.failureCode,
    "PREFLIGHT_CONVERSATION_URL_BINDING_CHANGED",
  );
  assert.equal(context.bridge.deliveries.length, 0);
});

test("an existing Web UI broker lease blocks the wake before bridge dispatch", async (t) => {
  const conversationUrlDigestSha256 = "d".repeat(64);
  const context = await fixture(t, {
    lifecycle: () => "responsive_idle",
    status: (alias) => webStatus(
      alias,
      "responsive_idle",
      conversationUrlDigestSha256,
    ),
  });
  const nowMs = Date.now();
  context.runtime.database.sqlite.prepare(`
    insert into interaction_broker_leases (
      resource_ref,
      lease_id,
      holder_scope_ref,
      generation,
      acquired_at_ms,
      expires_at_ms
    ) values (?, ?, ?, ?, ?, ?)
  `).run(
    "interaction-adapter:conversation-transport-web-ui-broker:zes-conversation-transport-playwright",
    "lease-competing-controller",
    "ffffffffffffffff",
    1,
    nowMs,
    nowMs + 60_000,
  );
  recordPending(context.runtime, "web-ui-broker-busy");
  const result = await context.runtime.wakeManager.executeWake(actor, {
    idempotencyKey: "wake:web-ui-broker-busy",
    targetExecutionScopeRef,
    missionRef,
  });
  assert.equal(result.attempt?.state, "failed_no_effect");
  assert.equal(result.attempt?.failureCode, "interaction_adapter_lease_busy");
  assert.equal(context.bridge.deliveries.length, 0);
  assert.equal(
    (context.runtime.database.sqlite.prepare(`
      select count(*) as count from interaction_broker_sessions
    `).get() as { count: number }).count,
    0,
  );
});

test("Web UI transport loss leaves both wake and interaction checkpoints indeterminate without persisting the prompt", async (t) => {
  const conversationUrlDigestSha256 = "d".repeat(64);
  const context = await fixture(t, {
    lifecycle: () => "responsive_idle",
    status: (alias) => webStatus(
      alias,
      "responsive_idle",
      conversationUrlDigestSha256,
    ),
    deliver: async () => {
      throw new Error("web UI transport lost after dispatch boundary");
    },
  });
  recordPending(context.runtime, "web-ui-indeterminate");
  const result = await context.runtime.wakeManager.executeWake(actor, {
    idempotencyKey: "wake:web-ui-indeterminate",
    targetExecutionScopeRef,
    missionRef,
  });
  assert.equal(result.attempt?.state, "indeterminate");
  assert.equal(context.bridge.deliveries.length, 1);
  const sessionRef = result.attempt?.lowerPlaneResult?.interactionSessionRef;
  assert.ok(sessionRef);
  const persisted = context.runtime.database.sqlite.prepare(`
    select payload_json
    from interaction_broker_sessions
    where session_ref = ?
  `).get(sessionRef) as { payload_json: string } | undefined;
  assert.ok(persisted);
  const brokerRecord = JSON.parse(persisted.payload_json) as {
    checkpoint: { state: string; pendingAction?: { payloadDigestSha256?: string } };
  };
  assert.equal(brokerRecord.checkpoint.state, "indeterminate");
  assert.equal(
    brokerRecord.checkpoint.pendingAction?.payloadDigestSha256,
    result.attempt?.permit.envelope.bodyDigestSha256,
  );
  assert.doesNotMatch(
    persisted.payload_json,
    /Do not infer completion from silence/i,
  );
  assert.equal(
    (context.runtime.database.sqlite.prepare(`
      select count(*) as count
      from interaction_broker_leases
      where expires_at_ms > ?
    `).get(Date.now()) as { count: number }).count,
    0,
  );

  assert.ok(result.attempt);
  const reconciled = context.runtime.wakeManager.reconcileAttempt(actor, {
    idempotencyKey: "wake:web-ui-indeterminate:reconcile-absent",
    attemptId: result.attempt.attemptId,
    expectedRevision: result.attempt.revision,
    resolution: "effect_absent",
    interactionReconciliationRef:
      "interaction-reconciliation:web-ui-effect-absent",
    authorityReadbackRef: "authority-readback:web-ui-effect-absent",
    effectReadbackRef: "effect-readback:web-ui-effect-absent",
    verificationRefs: ["verification:web-ui-effect-absent"],
  });
  assert.equal(reconciled.value.state, "reconciled_effect_absent");
  assert.ok(
    reconciled.value.lowerPlaneResult?.verificationRefs.some((reference) =>
      reference === "interaction-checkpoint-state:ready"),
  );
  const reconciledPersisted = context.runtime.database.sqlite.prepare(`
    select payload_json
    from interaction_broker_sessions
    where session_ref = ?
  `).get(sessionRef) as { payload_json: string } | undefined;
  assert.ok(reconciledPersisted);
  const reconciledRecord = JSON.parse(reconciledPersisted.payload_json) as {
    checkpoint: {
      state: string;
      pendingAction?: unknown;
      reconciliation?: { resolution: string };
    };
  };
  assert.equal(reconciledRecord.checkpoint.state, "ready");
  assert.equal(reconciledRecord.checkpoint.pendingAction, undefined);
  assert.equal(
    reconciledRecord.checkpoint.reconciliation?.resolution,
    "effect_absent",
  );
  assert.doesNotMatch(
    reconciledPersisted.payload_json,
    /Do not infer completion from silence/i,
  );
});

test("verified Web UI reconciliation advances wake, broker, and host turn atomically", async (t) => {
  const conversationUrlDigestSha256 = "d".repeat(64);
  const context = await fixture(t, {
    lifecycle: () => "responsive_idle",
    status: (alias) => webStatus(
      alias,
      "responsive_idle",
      conversationUrlDigestSha256,
    ),
    deliver: async () => {
      throw new Error("web UI outcome unavailable until authoritative readback");
    },
  });
  recordPending(context.runtime, "web-ui-reconciled-verified");
  const result = await context.runtime.wakeManager.executeWake(actor, {
    idempotencyKey: "wake:web-ui-reconciled-verified",
    targetExecutionScopeRef,
    missionRef,
  });
  assert.equal(result.attempt?.state, "indeterminate");
  assert.ok(result.attempt);
  const sessionRef = result.attempt.lowerPlaneResult?.interactionSessionRef;
  assert.ok(sessionRef);
  const generationBoundaryRefAfter = "host-turn:web-ui-readback-running";
  const reconciled = context.runtime.wakeManager.reconcileAttempt(actor, {
    idempotencyKey: "wake:web-ui-reconciled-verified:reconcile",
    attemptId: result.attempt.attemptId,
    expectedRevision: result.attempt.revision,
    resolution: "effect_verified",
    interactionReconciliationRef:
      "interaction-reconciliation:web-ui-effect-verified",
    authorityReadbackRef: "authority-readback:web-ui-effect-verified",
    effectReadbackRef: "effect-readback:web-ui-effect-verified",
    promptAdmissionRef: "prompt-admission:web-ui-effect-verified",
    generationBoundaryRefAfter,
    verificationRefs: ["verification:web-ui-effect-verified"],
  });
  assert.equal(reconciled.value.state, "reconciled_effect_verified");
  assert.equal(reconciled.value.lowerPlaneResult?.disposition, "verified");
  assert.equal(
    reconciled.value.lowerPlaneResult?.conversationUrlDigestSha256,
    conversationUrlDigestSha256,
  );
  assert.ok(
    reconciled.value.lowerPlaneResult?.verificationRefs.includes(
      "interaction-checkpoint-state:verified",
    ),
  );

  const persisted = context.runtime.database.sqlite.prepare(`
    select payload_json
    from interaction_broker_sessions
    where session_ref = ?
  `).get(sessionRef) as { payload_json: string } | undefined;
  assert.ok(persisted);
  const brokerRecord = JSON.parse(persisted.payload_json) as {
    checkpoint: {
      state: string;
      pendingAction?: unknown;
      reconciliation?: { resolution: string };
    };
  };
  assert.equal(brokerRecord.checkpoint.state, "verified");
  assert.equal(brokerRecord.checkpoint.pendingAction, undefined);
  assert.equal(
    brokerRecord.checkpoint.reconciliation?.resolution,
    "effect_verified",
  );
  assert.doesNotMatch(
    persisted.payload_json,
    /Do not infer completion from silence/i,
  );

  const lifecycle = context.runtime.hostTurns.status(
    targetExecutionScopeRef,
    missionRef,
    context.bindingRef,
    context.bindingGeneration,
  );
  assert.equal(lifecycle.currentTurn?.state, "running");
  assert.equal(
    lifecycle.currentTurn?.generationBoundaryRef,
    generationBoundaryRefAfter,
  );
  assert.equal(lifecycle.wakeGate.decision, "HOLD_ACTIVE_TURN");
});
