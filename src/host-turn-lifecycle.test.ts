import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  DEFAULT_HOST_TURN_LIFECYCLE_CONFIG,
  HostTurnLifecycleManager,
  type HostTurnBindingInput,
  type HostTurnLifecycleConfig,
  type HostTurnObservationInput,
  type HostTurnWakeDispatchInput,
} from "./host-turn-lifecycle.js";
import type {
  HostTurnEventKind,
  HostTurnState,
  HostTurnWakeGateBinding,
} from "./host-turn-lifecycle-model.js";

interface Fixture {
  root: string;
  stateDir: string;
  manager: HostTurnLifecycleManager;
  targetExecutionScopeRef: string;
  observerExecutionScopeRef: string;
  missionRef: string;
  now(): number;
  advance(ms: number): void;
  binding(overrides?: Partial<HostTurnBindingInput>): HostTurnBindingInput;
}

async function fixture(
  t: TestContext,
  config: Partial<HostTurnLifecycleConfig> = {},
): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "devspace-host-turn-"));
  const stateDir = join(root, ".state");
  let currentTime = Date.parse("2026-08-19T03:00:00.000Z");
  let sequence = 0;
  const manager = new HostTurnLifecycleManager(
    {
      ...DEFAULT_HOST_TURN_LIFECYCLE_CONFIG,
      maximumObservationTtlMs: 60_000,
      cleanupIntervalMs: 1,
      ...config,
    },
    stateDir,
    {
      now: () => currentTime,
      installSchema: true,
      idFactory: (prefix) =>
        `${prefix}_${(++sequence).toString(16).padStart(32, "0")}`,
    },
  );
  t.after(async () => {
    manager.close();
    await rm(root, { recursive: true, force: true });
  });
  const targetExecutionScopeRef = "1111111111111111";
  const observerExecutionScopeRef = "2222222222222222";
  const missionRef = "mission:a2a-host-turn";
  return {
    root,
    stateDir,
    manager,
    targetExecutionScopeRef,
    observerExecutionScopeRef,
    missionRef,
    now: () => currentTime,
    advance(ms: number) {
      currentTime += ms;
    },
    binding(overrides = {}) {
      return {
        targetExecutionScopeRef,
        missionRef,
        conversationBindingRef: "binding:conversation:1",
        conversationBindingGeneration: 1,
        targetKind: "native_rpc",
        targetRefDigestSha256: "a".repeat(64),
        authorityReadbackRefs: ["authority:binding:1"],
        ...overrides,
      };
    },
  };
}

function observation(
  context: Fixture,
  idempotencyKey: string,
  eventKind: HostTurnEventKind,
  state: HostTurnState,
  overrides: Partial<HostTurnObservationInput> = {},
): HostTurnObservationInput {
  const observedAt = new Date(context.now()).toISOString();
  const evidenceExpiresAt = new Date(context.now() + 10_000).toISOString();
  const wakeEligible = [
    "awaiting_input",
    "completed",
    "failed",
    "cancelled",
  ].includes(state);
  return {
    idempotencyKey,
    observerExecutionScopeRef: context.observerExecutionScopeRef,
    ...context.binding(),
    eventKind,
    state,
    source: "conversation_transport",
    confidence: "verified",
    providerAdapterId: "conversation-transport:test",
    providerSessionRef: "provider-session:1",
    providerTurnRef: state === "awaiting_input"
      ? undefined
      : "provider-turn:1",
    generationBoundaryRef: `generation:${idempotencyKey}`,
    evidenceRefs: [`evidence:${idempotencyKey}`],
    authorityReadbackRefs: [`authority:${idempotencyKey}`],
    effectReadbackRefs: [],
    reasonCodes: [],
    observedAt,
    evidenceExpiresAt,
    terminationCauseCode: wakeEligible
      ? `explicit_${state}`
      : undefined,
    ...overrides,
  };
}

function requireGate(
  gate: ReturnType<HostTurnLifecycleManager["wakeGate"]>,
): HostTurnWakeGateBinding {
  assert.equal(gate.wakeAllowed, true);
  assert.ok(gate.binding);
  return gate.binding;
}

function dispatchInput(
  context: Fixture,
  gate: HostTurnWakeGateBinding,
  suffix: string,
): HostTurnWakeDispatchInput {
  return {
    idempotencyKey: `dispatch:${suffix}`,
    observerExecutionScopeRef: context.observerExecutionScopeRef,
    gate,
    ...context.binding(),
    providerAdapterId: "conversation-transport:test",
    providerSessionRef: "provider-session:1",
    providerTurnRef: `provider-turn:${suffix}`,
    generationBoundaryRef: `generation:after:${suffix}`,
    workCycleRef: `work-cycle:${suffix}`,
    correlationRef: `correlation:${suffix}`,
    pendingWorkRef: `pending:${suffix}`,
    wakePermitRef: `permit:${suffix}`,
    evidenceRefs: [`delivery:${suffix}`],
    authorityReadbackRefs: [`authority:delivery:${suffix}`],
    effectReadbackRefs: [],
    observedAt: new Date(context.now()).toISOString(),
    evidenceExpiresAt: new Date(context.now() + 10_000).toISOString(),
  };
}

test("wake gate requires an explicit fresh host-turn edge instead of MCP silence", async (t) => {
  const context = await fixture(t);
  const absent = context.manager.wakeGate(
    context.targetExecutionScopeRef,
    context.missionRef,
    "binding:conversation:1",
    1,
  );
  assert.equal(absent.decision, "HOLD_NO_SESSION");
  assert.equal(absent.wakeAllowed, false);

  context.manager.ensureBinding(context.binding());
  const unobserved = context.manager.wakeGate(
    context.targetExecutionScopeRef,
    context.missionRef,
    "binding:conversation:1",
    1,
  );
  assert.equal(unobserved.decision, "HOLD_NO_EXPLICIT_TURN_STATE");

  const input = observation(
    context,
    "turn:awaiting:1",
    "awaiting_input_observed",
    "awaiting_input",
  );
  const first = context.manager.observe(input);
  assert.equal(first.idempotentReplay, false);
  assert.equal(first.value.state, "awaiting_input");
  const replay = context.manager.observe(input);
  assert.equal(replay.idempotentReplay, true);
  assert.deepEqual(replay.value, first.value);

  const eligible = context.manager.wakeGate(
    context.targetExecutionScopeRef,
    context.missionRef,
    "binding:conversation:1",
    1,
  );
  assert.equal(eligible.decision, "ALLOW_AWAITING_INPUT");
  assert.equal(eligible.binding?.hostTurnGeneration, 1);
});

test("active provider generation remains active after a silent interval", async (t) => {
  const context = await fixture(t);
  context.manager.observe(observation(
    context,
    "turn:awaiting:before-dispatch",
    "awaiting_input_observed",
    "awaiting_input",
  ));
  const gate = requireGate(context.manager.wakeGate(
    context.targetExecutionScopeRef,
    context.missionRef,
    "binding:conversation:1",
    1,
  ));
  const started = context.manager.recordWakeDispatchStarted(
    dispatchInput(context, gate, "active"),
  ).value;
  assert.equal(started.state, "started");
  assert.equal(started.generation, 2);

  context.advance(30_000);
  const held = context.manager.wakeGate(
    context.targetExecutionScopeRef,
    context.missionRef,
    "binding:conversation:1",
    1,
  );
  assert.equal(held.decision, "HOLD_ACTIVE_TURN");
  assert.equal(held.wakeAllowed, false);
  assert.ok(held.reasonCodes.includes("HOST_TURN_STARTED"));
});

test("advisory evidence cannot create a terminal or awaiting-input boundary", async (t) => {
  const context = await fixture(t);
  assert.throws(
    () => context.manager.observe(observation(
      context,
      "turn:advisory-idle",
      "awaiting_input_observed",
      "awaiting_input",
      { confidence: "advisory" },
    )),
    /Advisory evidence cannot create a wake-eligible host-turn state/,
  );
});

test("expired explicit terminal evidence fails closed", async (t) => {
  const context = await fixture(t);
  context.manager.observe(observation(
    context,
    "turn:short-lived-idle",
    "awaiting_input_observed",
    "awaiting_input",
    { evidenceExpiresAt: new Date(context.now() + 100).toISOString() },
  ));
  context.advance(101);
  const held = context.manager.wakeGate(
    context.targetExecutionScopeRef,
    context.missionRef,
    "binding:conversation:1",
    1,
  );
  assert.equal(held.decision, "HOLD_STALE_EVIDENCE");
});

test("binding changes are blocked while a turn is active and require a fresh boundary after terminal state", async (t) => {
  const context = await fixture(t);
  context.manager.observe(observation(
    context,
    "turn:running",
    "turn_running",
    "running",
  ));
  assert.throws(
    () => context.manager.ensureBinding(context.binding({
      conversationBindingRef: "binding:conversation:2",
      conversationBindingGeneration: 2,
      targetRefDigestSha256: "b".repeat(64),
    })),
    /cannot change while host turn .* is running/,
  );

  context.manager.observe(observation(
    context,
    "turn:completed",
    "turn_completed",
    "completed",
    { terminationCauseCode: "provider_completed" },
  ));
  context.manager.ensureBinding(context.binding({
    conversationBindingRef: "binding:conversation:2",
    conversationBindingGeneration: 2,
    targetRefDigestSha256: "b".repeat(64),
  }));
  const mismatch = context.manager.wakeGate(
    context.targetExecutionScopeRef,
    context.missionRef,
    "binding:conversation:2",
    2,
  );
  assert.equal(mismatch.decision, "HOLD_BINDING_MISMATCH");

  context.manager.observe(observation(
    context,
    "turn:new-binding-idle",
    "awaiting_input_observed",
    "awaiting_input",
    {
      conversationBindingRef: "binding:conversation:2",
      conversationBindingGeneration: 2,
      targetRefDigestSha256: "b".repeat(64),
      providerTurnRef: undefined,
    },
  ));
  const eligible = context.manager.wakeGate(
    context.targetExecutionScopeRef,
    context.missionRef,
    "binding:conversation:2",
    2,
  );
  assert.equal(eligible.wakeAllowed, true);
  assert.equal(eligible.binding?.hostTurnGeneration, 2);
});

test("indeterminate delivery blocks replay until effect reconciliation", async (t) => {
  const context = await fixture(t);
  context.manager.observe(observation(
    context,
    "turn:idle-before-unknown",
    "awaiting_input_observed",
    "awaiting_input",
  ));
  const gate = requireGate(context.manager.wakeGate(
    context.targetExecutionScopeRef,
    context.missionRef,
    "binding:conversation:1",
    1,
  ));
  const uncertain = context.manager.recordWakeDispatchIndeterminate({
    ...dispatchInput(context, gate, "unknown"),
    providerTurnRef: undefined,
    effectReadbackRefs: ["effect:unknown"],
    indeterminateReasonCodes: ["TRANSPORT_LOST_AFTER_DISPATCH"],
  }).value;
  assert.equal(uncertain.state, "indeterminate");
  assert.equal(uncertain.generation, 2);
  const held = context.manager.wakeGate(
    context.targetExecutionScopeRef,
    context.missionRef,
    "binding:conversation:1",
    1,
  );
  assert.equal(held.decision, "HOLD_INDETERMINATE_TURN");

  const reconciled = context.manager.reconcileWakeDispatch({
    idempotencyKey: "reconcile:effect-absent",
    observerExecutionScopeRef: context.observerExecutionScopeRef,
    targetExecutionScopeRef: context.targetExecutionScopeRef,
    missionRef: context.missionRef,
    wakePermitRef: "permit:unknown",
    resolution: "effect_absent",
    generationBoundaryRef: "generation:reconciled:absent",
    evidenceRefs: ["reconciliation:effect-absent"],
    authorityReadbackRefs: ["authority:reconciliation"],
    effectReadbackRefs: ["effect-readback:absent"],
    reasonCodes: ["PROMPT_NOT_ADMITTED"],
    observedAt: new Date(context.now()).toISOString(),
    evidenceExpiresAt: new Date(context.now() + 10_000).toISOString(),
  }).value;
  assert.equal(reconciled.state, "cancelled");
  assert.equal(context.manager.wakeGate(
    context.targetExecutionScopeRef,
    context.missionRef,
    "binding:conversation:1",
    1,
  ).decision, "ALLOW_TERMINAL_TURN");
});

test("verified reconciliation restores a running turn rather than manufacturing idle", async (t) => {
  const context = await fixture(t);
  context.manager.observe(observation(
    context,
    "turn:idle-before-verified-reconcile",
    "awaiting_input_observed",
    "awaiting_input",
  ));
  const gate = requireGate(context.manager.wakeGate(
    context.targetExecutionScopeRef,
    context.missionRef,
    "binding:conversation:1",
    1,
  ));
  context.manager.recordWakeDispatchIndeterminate({
    ...dispatchInput(context, gate, "verified-reconcile"),
    providerTurnRef: undefined,
    effectReadbackRefs: ["effect:unknown"],
  });
  const reconciled = context.manager.reconcileWakeDispatch({
    idempotencyKey: "reconcile:effect-verified",
    observerExecutionScopeRef: context.observerExecutionScopeRef,
    targetExecutionScopeRef: context.targetExecutionScopeRef,
    missionRef: context.missionRef,
    wakePermitRef: "permit:verified-reconcile",
    resolution: "effect_verified",
    generationBoundaryRef: "generation:reconciled:running",
    providerTurnRef: "provider-turn:verified",
    evidenceRefs: ["reconciliation:effect-verified"],
    authorityReadbackRefs: ["authority:reconciliation"],
    effectReadbackRefs: ["effect-readback:verified"],
    observedAt: new Date(context.now()).toISOString(),
    evidenceExpiresAt: new Date(context.now() + 10_000).toISOString(),
  }).value;
  assert.equal(reconciled.state, "running");
  assert.equal(context.manager.wakeGate(
    context.targetExecutionScopeRef,
    context.missionRef,
    "binding:conversation:1",
    1,
  ).decision, "HOLD_ACTIVE_TURN");
});

test("lifecycle state and idempotency survive restart", async (t) => {
  const context = await fixture(t);
  const input = observation(
    context,
    "turn:persisted-idle",
    "awaiting_input_observed",
    "awaiting_input",
  );
  const first = context.manager.observe(input);
  context.manager.close();

  const reopened = new HostTurnLifecycleManager(
    {
      ...DEFAULT_HOST_TURN_LIFECYCLE_CONFIG,
      maximumObservationTtlMs: 60_000,
      cleanupIntervalMs: 1,
    },
    context.stateDir,
    { now: context.now },
  );
  t.after(() => reopened.close());
  const replay = reopened.observe(input);
  assert.equal(replay.idempotentReplay, true);
  assert.deepEqual(replay.value, first.value);
  const status = reopened.status(
    context.targetExecutionScopeRef,
    context.missionRef,
    "binding:conversation:1",
    1,
  );
  assert.equal(status.currentTurn?.state, "awaiting_input");
  assert.equal(status.wakeGate.wakeAllowed, true);
});
