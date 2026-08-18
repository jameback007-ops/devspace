import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { openDatabase } from "./db/client.js";
import {
  DEFAULT_EXECUTION_WAKE_COORDINATION_CONFIG,
  ExecutionWakeCoordinationManager,
  type ExecutionWakeCoordinationConfig,
} from "./execution-wake-coordination.js";
import {
  EXECUTION_WAKE_COORDINATION_AUTHORITY,
  sha256,
  type ExecutionWakeLowerPlanePort,
  type LowerPlaneWakeReadiness,
  type WakeLowerPlaneDispatchResult,
  type WakePermit,
} from "./execution-wake-coordination-model.js";
import { executionScopeIdentity, type ExecutionScopeIdentity } from "./request-meta.js";

class FakeLowerPlane implements ExecutionWakeLowerPlanePort {
  assessCalls: Array<Parameters<ExecutionWakeLowerPlanePort["assessReadiness"]>[0]> = [];
  permits: WakePermit[] = [];
  readinessFactory: (
    input: Parameters<ExecutionWakeLowerPlanePort["assessReadiness"]>[0],
  ) => Promise<LowerPlaneWakeReadiness>;
  dispatchFactory: (permit: WakePermit) => Promise<WakeLowerPlaneDispatchResult>;

  constructor(
    private readonly now: () => number,
  ) {
    this.readinessFactory = async (input) => eligibleReadiness(input, this.now());
    this.dispatchFactory = async (permit) => verifiedDispatch(permit, this.now());
  }

  async assessReadiness(
    input: Parameters<ExecutionWakeLowerPlanePort["assessReadiness"]>[0],
  ): Promise<LowerPlaneWakeReadiness> {
    this.assessCalls.push(input);
    return this.readinessFactory(input);
  }

  async consumeWakePermit(
    permit: WakePermit,
  ): Promise<WakeLowerPlaneDispatchResult> {
    this.permits.push(permit);
    return this.dispatchFactory(permit);
  }
}

interface Fixture {
  root: string;
  stateDir: string;
  orchestrator: ExecutionScopeIdentity;
  target: ExecutionScopeIdentity;
  other: ExecutionScopeIdentity;
  lower: FakeLowerPlane;
  manager: ExecutionWakeCoordinationManager;
  now(): number;
  advance(ms: number): void;
  restart(): ExecutionWakeCoordinationManager;
}

async function fixture(
  t: TestContext,
  overrides: Partial<ExecutionWakeCoordinationConfig> = {},
): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "devspace-wake-coordination-"));
  const stateDir = join(root, ".state");
  let nowMs = Date.parse("2026-08-18T07:00:00Z");
  const counters = new Map<string, number>();
  const idFactory = (prefix: string) => {
    const next = (counters.get(prefix) ?? 0) + 1;
    counters.set(prefix, next);
    return `${prefix}_${next.toString(16).padStart(32, "0")}`;
  };
  const config: ExecutionWakeCoordinationConfig = {
    ...DEFAULT_EXECUTION_WAKE_COORDINATION_CONFIG,
    pendingWorkDefaultTtlMs: 60_000,
    pendingWorkMaxTtlMs: 60 * 60 * 1_000,
    wakePermitTtlMs: 10_000,
    wakeLeaseTtlMs: 5_000,
    executionCommandReservationTtlMs: 5_000,
    minimumCooldownMs: 1_000,
    maximumCooldownMs: 8_000,
    automaticAttemptWindowMs: 60_000,
    maximumAutomaticAttemptsPerWindow: 3,
    maximumAutomaticAttemptsPerPendingWork: 2,
    loopGuardHoldMs: 10_000,
    indeterminateHumanHoldMs: 60_000,
    cleanupIntervalMs: 1,
    ...overrides,
  };
  const lower = new FakeLowerPlane(() => nowMs);
  const managers: ExecutionWakeCoordinationManager[] = [];
  const create = (installSchema: boolean) => {
    const manager = new ExecutionWakeCoordinationManager(
      config,
      stateDir,
      lower,
      {
        now: () => nowMs,
        idFactory,
        installSchema,
      },
    );
    managers.push(manager);
    return manager;
  };
  const result: Fixture = {
    root,
    stateDir,
    orchestrator: identity("wake-orchestrator"),
    target: identity("wake-target-session"),
    other: identity("wake-other-session"),
    lower,
    manager: create(true),
    now: () => nowMs,
    advance(ms: number) {
      nowMs += ms;
    },
    restart: () => create(false),
  };
  t.after(async () => {
    for (const manager of managers) manager.close();
    await rm(root, { recursive: true, force: true });
  });
  return result;
}

function identity(value: string): ExecutionScopeIdentity {
  const result = executionScopeIdentity({
    "devspace/execution-scope": value,
  });
  assert.ok(result);
  return result;
}

function pendingInput(
  context: Fixture,
  id: string,
  overrides: Partial<Parameters<ExecutionWakeCoordinationManager["recordPendingWork"]>[1]> = {},
) {
  return {
    idempotencyKey: `pending:${id}`,
    targetExecutionScopeRef: context.target.scopeRef,
    missionRef: "mission:wake-target",
    sourceGeneration: 1,
    workCycleRef: `cycle:${id}`,
    correlationRef: `correlation:${id}`,
    taskRefs: [`task:${id}`],
    messageRefs: [`message:${id}`],
    sourceAuthorityRefs: [`coordination-status:${id}`],
    actionableCount: 2,
    highestPriority: "high" as const,
    ...overrides,
  };
}

function recordPending(
  context: Fixture,
  id: string,
  overrides: Partial<Parameters<ExecutionWakeCoordinationManager["recordPendingWork"]>[1]> = {},
) {
  return context.manager.recordPendingWork(
    context.orchestrator,
    pendingInput(context, id, overrides),
  ).value;
}

function eligibleReadiness(
  input: Parameters<ExecutionWakeLowerPlanePort["assessReadiness"]>[0],
  nowMs: number,
  overrides: Partial<LowerPlaneWakeReadiness> = {},
): LowerPlaneWakeReadiness {
  return {
    schemaVersion: 1,
    assessmentRef: `assessment:${input.pendingWorkId}:${input.pendingWorkGeneration}`,
    targetExecutionScopeRef: input.targetExecutionScopeRef,
    missionRef: input.missionRef,
    sessionUiBindingRef: `session-ui-binding:${input.targetExecutionScopeRef}`,
    bindingGeneration: 3,
    operationalState: "responsive_idle",
    exactTargetVerified: true,
    selectorContractVerified: true,
    accountAutomationWarningAbsent: true,
    wakePermitted: true,
    maximumAutomaticRecoveryTier: "minimal_continuation",
    observationRef: `observation:${input.pendingWorkId}`,
    generationBoundaryRefBefore: "generation:before:1",
    evidenceDigestSha256: sha256(`evidence:${input.pendingWorkId}`),
    evidenceRefs: [`evidence:${input.pendingWorkId}`],
    reasonCodes: ["RESPONSIVE_IDLE_PROVEN"],
    assessedAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + 5_000).toISOString(),
    lowerPlaneAuthorityRef: "interaction-lifecycle:classifier:v1",
    ...overrides,
  };
}

function verifiedDispatch(
  permit: WakePermit,
  nowMs: number,
  overrides: Partial<WakeLowerPlaneDispatchResult> = {},
): WakeLowerPlaneDispatchResult {
  return {
    schemaVersion: 1,
    permitRef: permit.permitRef,
    disposition: "verified",
    interactionSessionRef: permit.sessionUiBindingRef,
    interactionActionId: `interaction-action:${permit.permitRef}`,
    interactionReceiptRef: `interaction-receipt:${permit.permitRef}`,
    promptAdmissionRef: `prompt-admission:${permit.permitRef}`,
    generationBoundaryRefAfter: `generation:after:${permit.permitRef}`,
    verificationRefs: [`verification:${permit.permitRef}`],
    completedAt: new Date(nowMs).toISOString(),
    ...overrides,
  };
}

function failedNoEffectDispatch(
  permit: WakePermit,
  nowMs: number,
): WakeLowerPlaneDispatchResult {
  return {
    schemaVersion: 1,
    permitRef: permit.permitRef,
    disposition: "failed_no_effect",
    interactionSessionRef: permit.sessionUiBindingRef,
    noEffectProofRef: `no-effect:${permit.permitRef}`,
    verificationRefs: [`verification:no-effect:${permit.permitRef}`],
    failureCode: "PROMPT_NOT_ADMITTED",
    completedAt: new Date(nowMs).toISOString(),
  };
}

test("pending work is generation-fenced and refresh cannot manufacture a new wake cycle", async (t) => {
  const context = await fixture(t);
  const first = context.manager.recordPendingWork(
    context.orchestrator,
    pendingInput(context, "generation"),
  );
  const replay = context.manager.recordPendingWork(
    context.orchestrator,
    pendingInput(context, "generation"),
  );
  assert.equal(replay.idempotentReplay, true);
  assert.deepEqual(replay.value, first.value);

  const refresh = context.manager.recordPendingWork(
    context.orchestrator,
    {
      ...pendingInput(context, "generation"),
      idempotencyKey: "pending:generation:refresh",
    },
  ).value;
  assert.equal(refresh.pendingWorkId, first.value.pendingWorkId);
  assert.equal(refresh.generation, 1);
  assert.equal(refresh.revision, 2);

  assert.throws(
    () => context.manager.recordPendingWork(context.orchestrator, {
      ...pendingInput(context, "generation"),
      idempotencyKey: "pending:generation:mutated",
      taskRefs: ["task:mutated"],
    }),
    /source generation cannot be reused/i,
  );
  assert.throws(
    () => context.manager.recordPendingWork(context.orchestrator, {
      ...pendingInput(context, "generation"),
      idempotencyKey: "pending:generation:same-cycle",
      sourceGeneration: 2,
    }),
    /requires a new workCycleRef/i,
  );

  const second = context.manager.recordPendingWork(context.orchestrator, {
    ...pendingInput(context, "generation-2"),
    idempotencyKey: "pending:generation:new-cycle",
    sourceGeneration: 2,
    workCycleRef: "cycle:generation:2",
  }).value;
  assert.equal(second.generation, 2);
  assert.notEqual(second.pendingWorkId, first.value.pendingWorkId);
  const old = context.manager.status(
    context.orchestrator,
    context.target.scopeRef,
    "mission:wake-target",
  ).attempts;
  assert.deepEqual(old, []);
});

test("no pending work or lower-plane UNKNOWN never becomes a wake", async (t) => {
  const context = await fixture(t);
  const none = await context.manager.assessWake(
    context.orchestrator,
    context.target.scopeRef,
    "mission:wake-target",
  );
  assert.equal(none.decision, "NO_PENDING_WORK");

  recordPending(context, "unknown");
  context.lower.readinessFactory = async (input) => eligibleReadiness(input, context.now(), {
    operationalState: "unknown",
    exactTargetVerified: false,
    selectorContractVerified: false,
    accountAutomationWarningAbsent: false,
    wakePermitted: false,
    maximumAutomaticRecoveryTier: "human_required",
    reasonCodes: ["MCP_SILENCE_ONLY", "INSUFFICIENT_SIGNALS"],
  });
  const held = await context.manager.assessWake(
    context.orchestrator,
    context.target.scopeRef,
    "mission:wake-target",
  );
  assert.equal(held.decision, "HOLD");
  assert.ok(held.reasonCodes.includes("EXACT_TARGET_NOT_VERIFIED"));
  assert.ok(held.reasonCodes.includes("LOWER_PLANE_WAKE_NOT_PERMITTED"));
  assert.equal(context.lower.permits.length, 0);
});

test("verified wake persists before dispatch, admits one prompt, and never repeats the work generation", async (t) => {
  const context = await fixture(t);
  const pending = recordPending(context, "verified");
  const result = await context.manager.executeWake(context.orchestrator, {
    idempotencyKey: "wake:verified",
    targetExecutionScopeRef: context.target.scopeRef,
    missionRef: pending.missionRef,
  });
  assert.equal(result.attempt?.state, "verified");
  assert.equal(context.lower.permits.length, 1);
  const permit = context.lower.permits[0];
  assert.ok(permit);
  assert.equal(permit.allowedEffect, "submit_correlated_continuation");
  assert.deepEqual(permit.forbiddenEffects, [
    "stop_generation",
    "regenerate_response",
    "reload_page",
    "open_duplicate_conversation",
    "navigate_away",
    "publish",
    "repeat_external_effect",
  ]);
  assert.match(permit.envelope.body, /Do not infer completion from silence/i);

  const status = context.manager.status(
    context.orchestrator,
    context.target.scopeRef,
    pending.missionRef,
  );
  assert.equal(status.currentPendingWork?.state, "wake_verified");
  assert.equal(status.attempts[0]?.state, "verified");

  const replay = await context.manager.executeWake(context.orchestrator, {
    idempotencyKey: "wake:verified",
    targetExecutionScopeRef: context.target.scopeRef,
    missionRef: pending.missionRef,
  });
  assert.equal(replay.idempotentReplay, true);
  assert.equal(replay.attempt?.attemptId, result.attempt?.attemptId);
  assert.equal(context.lower.permits.length, 1);

  const anotherKey = await context.manager.executeWake(context.orchestrator, {
    idempotencyKey: "wake:verified:new-key",
    targetExecutionScopeRef: context.target.scopeRef,
    missionRef: pending.missionRef,
  });
  assert.equal(anotherKey.assessment.decision, "ALREADY_VERIFIED");
  assert.equal(context.lower.permits.length, 1);
});

test("target consumption is authoritative for the scheduler and survives a later dispatch receipt", async (t) => {
  const context = await fixture(t);
  const pending = recordPending(context, "consume-race");
  let resolveDispatch: ((value: WakeLowerPlaneDispatchResult) => void) | undefined;
  context.lower.dispatchFactory = (permit) => new Promise((resolve) => {
    resolveDispatch = (value) => resolve(value);
    void permit;
  });
  const execution = context.manager.executeWake(context.orchestrator, {
    idempotencyKey: "wake:consume-race",
    targetExecutionScopeRef: context.target.scopeRef,
    missionRef: pending.missionRef,
  });
  await waitFor(() => context.lower.permits.length === 1);
  const inflight = context.manager.status(
    context.orchestrator,
    context.target.scopeRef,
    pending.missionRef,
  ).currentPendingWork;
  assert.equal(inflight?.state, "wake_inflight");
  assert.ok(inflight);
  const consumed = context.manager.consumePendingWork(context.target, {
    idempotencyKey: "consume:race",
    pendingWorkId: inflight.pendingWorkId,
    expectedRevision: inflight.revision,
    consumptionRefs: ["target-inbox:acted"],
  }).value;
  assert.equal(consumed.state, "consumed");
  const permit = context.lower.permits[0];
  assert.ok(permit);
  resolveDispatch?.(verifiedDispatch(permit, context.now()));
  const result = await execution;
  assert.equal(result.attempt?.state, "verified");
  assert.equal(context.manager.status(
    context.orchestrator,
    context.target.scopeRef,
    pending.missionRef,
  ).currentPendingWork?.state, "consumed");
});

test("failed-no-effect wakes back off and the per-work loop guard stops repeated prompts", async (t) => {
  const context = await fixture(t, {
    maximumAutomaticAttemptsPerPendingWork: 2,
    maximumAutomaticAttemptsPerWindow: 5,
  });
  const pending = recordPending(context, "backoff");
  context.lower.dispatchFactory = async (permit) => failedNoEffectDispatch(permit, context.now());

  const first = await context.manager.executeWake(context.orchestrator, {
    idempotencyKey: "wake:backoff:1",
    targetExecutionScopeRef: context.target.scopeRef,
    missionRef: pending.missionRef,
  });
  assert.equal(first.attempt?.state, "failed_no_effect");
  const immediate = await context.manager.assessWake(
    context.orchestrator,
    context.target.scopeRef,
    pending.missionRef,
  );
  assert.equal(immediate.decision, "COOLDOWN");

  context.advance(1_001);
  const second = await context.manager.executeWake(context.orchestrator, {
    idempotencyKey: "wake:backoff:2",
    targetExecutionScopeRef: context.target.scopeRef,
    missionRef: pending.missionRef,
  });
  assert.equal(second.attempt?.state, "failed_no_effect");
  const guarded = await context.manager.assessWake(
    context.orchestrator,
    context.target.scopeRef,
    pending.missionRef,
  );
  assert.equal(guarded.decision, "LOOP_GUARD");
  assert.equal(context.lower.permits.length, 2);
});

test("transport loss becomes indeterminate, blocks replay, and requires exact effect reconciliation", async (t) => {
  const context = await fixture(t);
  const pending = recordPending(context, "indeterminate");
  context.lower.dispatchFactory = async () => {
    throw new Error("transport lost after dispatch");
  };
  const result = await context.manager.executeWake(context.orchestrator, {
    idempotencyKey: "wake:indeterminate",
    targetExecutionScopeRef: context.target.scopeRef,
    missionRef: pending.missionRef,
  });
  assert.equal(result.attempt?.state, "indeterminate");
  const held = await context.manager.executeWake(context.orchestrator, {
    idempotencyKey: "wake:indeterminate:new-key",
    targetExecutionScopeRef: context.target.scopeRef,
    missionRef: pending.missionRef,
  });
  assert.equal(held.assessment.decision, "HOLD");
  assert.equal(context.lower.permits.length, 1);
  assert.throws(
    () => context.manager.releaseHold(context.orchestrator, {
      idempotencyKey: "release:indeterminate",
      targetExecutionScopeRef: context.target.scopeRef,
      missionRef: pending.missionRef,
      releaseRef: "human:release",
    }),
    /indeterminate attempt remains unreconciled/i,
  );
  assert.ok(result.attempt);
  const reconciled = context.manager.reconcileAttempt(context.orchestrator, {
    idempotencyKey: "reconcile:indeterminate:absent",
    attemptId: result.attempt.attemptId,
    expectedRevision: result.attempt.revision,
    resolution: "effect_absent",
    interactionReconciliationRef: "interaction-broker:reconciliation:1",
    authorityReadbackRef: "interaction-broker:authority-readback:1",
    effectReadbackRef: "interaction-broker:effect-absent:1",
    verificationRefs: ["interaction-broker:verification:1"],
  }).value;
  assert.equal(reconciled.state, "reconciled_effect_absent");
  assert.equal(context.manager.status(
    context.orchestrator,
    context.target.scopeRef,
    pending.missionRef,
  ).currentPendingWork?.state, "pending");
});

test("verified reconciliation requires prompt admission and a genuinely new generation boundary", async (t) => {
  const context = await fixture(t);
  const pending = recordPending(context, "reconcile-verified");
  context.lower.dispatchFactory = async (permit) => ({
    schemaVersion: 1,
    permitRef: permit.permitRef,
    disposition: "indeterminate",
    interactionSessionRef: permit.sessionUiBindingRef,
    verificationRefs: [],
    failureCode: "TRANSPORT_LOST",
    completedAt: new Date(context.now()).toISOString(),
  });
  const result = await context.manager.executeWake(context.orchestrator, {
    idempotencyKey: "wake:reconcile-verified",
    targetExecutionScopeRef: context.target.scopeRef,
    missionRef: pending.missionRef,
  });
  assert.ok(result.attempt);
  assert.throws(
    () => context.manager.reconcileAttempt(context.orchestrator, {
      idempotencyKey: "reconcile:verified:missing",
      attemptId: result.attempt!.attemptId,
      expectedRevision: result.attempt!.revision,
      resolution: "effect_verified",
      interactionReconciliationRef: "interaction:reconcile",
      authorityReadbackRef: "interaction:authority",
      effectReadbackRef: "interaction:effect",
      verificationRefs: ["interaction:verification"],
    }),
    /requires prompt admission and a new generation boundary/i,
  );
  assert.throws(
    () => context.manager.reconcileAttempt(context.orchestrator, {
      idempotencyKey: "reconcile:verified:same-boundary",
      attemptId: result.attempt!.attemptId,
      expectedRevision: result.attempt!.revision,
      resolution: "effect_verified",
      interactionReconciliationRef: "interaction:reconcile",
      authorityReadbackRef: "interaction:authority",
      effectReadbackRef: "interaction:effect",
      promptAdmissionRef: "interaction:admission",
      generationBoundaryRefAfter: "generation:before:1",
      verificationRefs: ["interaction:verification"],
    }),
    /generation boundary did not advance/i,
  );
  const verified = context.manager.reconcileAttempt(context.orchestrator, {
    idempotencyKey: "reconcile:verified:success",
    attemptId: result.attempt.attemptId,
    expectedRevision: result.attempt.revision,
    resolution: "effect_verified",
    interactionReconciliationRef: "interaction:reconcile",
    authorityReadbackRef: "interaction:authority",
    effectReadbackRef: "interaction:effect",
    promptAdmissionRef: "interaction:admission",
    generationBoundaryRefAfter: "generation:after:verified",
    verificationRefs: ["interaction:verification"],
  }).value;
  assert.equal(verified.state, "reconciled_effect_verified");
  assert.equal(context.manager.status(
    context.orchestrator,
    context.target.scopeRef,
    pending.missionRef,
  ).currentPendingWork?.state, "wake_verified");
});

test("invalid lower-plane verified receipts are fenced as indeterminate", async (t) => {
  const context = await fixture(t);
  const pending = recordPending(context, "invalid-receipt");
  context.lower.dispatchFactory = async (permit) => verifiedDispatch(permit, context.now(), {
    promptAdmissionRef: undefined,
    generationBoundaryRefAfter: "generation:before:1",
    verificationRefs: [],
  });
  const result = await context.manager.executeWake(context.orchestrator, {
    idempotencyKey: "wake:invalid-receipt",
    targetExecutionScopeRef: context.target.scopeRef,
    missionRef: pending.missionRef,
  });
  assert.equal(result.attempt?.state, "indeterminate");
  assert.match(result.attempt?.failureCode ?? "", /LOWER_PLANE_RESULT_INVALID/);
});

test("concurrent identical wake commands share one durable reservation and one dispatch", async (t) => {
  const context = await fixture(t);
  const pending = recordPending(context, "concurrent");
  let releaseAssessment: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    releaseAssessment = resolve;
  });
  let firstAssessment = true;
  context.lower.readinessFactory = async (input) => {
    if (firstAssessment) {
      firstAssessment = false;
      await gate;
    }
    return eligibleReadiness(input, context.now());
  };
  const firstPromise = context.manager.executeWake(context.orchestrator, {
    idempotencyKey: "wake:concurrent",
    targetExecutionScopeRef: context.target.scopeRef,
    missionRef: pending.missionRef,
  });
  await waitFor(() => context.lower.assessCalls.length === 1);
  const second = await context.manager.executeWake(context.orchestrator, {
    idempotencyKey: "wake:concurrent",
    targetExecutionScopeRef: context.target.scopeRef,
    missionRef: pending.missionRef,
  });
  assert.equal(second.assessment.decision, "IN_FLIGHT");
  assert.equal(second.idempotentReplay, true);
  releaseAssessment?.();
  const first = await firstPromise;
  assert.equal(first.attempt?.state, "verified");
  assert.equal(context.lower.permits.length, 1);
});

test("dispatching attempts survive restart and become indeterminate instead of replaying", async (t) => {
  const context = await fixture(t, {
    wakeLeaseTtlMs: 1_000,
  });
  const pending = recordPending(context, "restart-dispatching");
  context.lower.dispatchFactory = () => new Promise(() => undefined);
  void context.manager.executeWake(context.orchestrator, {
    idempotencyKey: "wake:restart-dispatching",
    targetExecutionScopeRef: context.target.scopeRef,
    missionRef: pending.missionRef,
  });
  await waitFor(() => context.lower.permits.length === 1);
  const before = context.manager.status(
    context.orchestrator,
    context.target.scopeRef,
    pending.missionRef,
  );
  assert.equal(before.attempts[0]?.state, "dispatching");
  context.manager.close();
  context.advance(1_001);
  const restarted = context.restart();
  const recovered = restarted.recoverStalledAttempts(
    context.orchestrator,
    context.target.scopeRef,
    pending.missionRef,
  );
  assert.equal(recovered[0]?.state, "indeterminate");
  assert.equal(context.lower.permits.length, 1);
  const status = restarted.status(
    context.orchestrator,
    context.target.scopeRef,
    pending.missionRef,
  );
  assert.equal(status.currentPendingWork?.state, "held");
  assert.equal(status.throttle.state, "human_hold");
});

test("stale command reservations can be taken over without creating duplicate work", async (t) => {
  const context = await fixture(t, {
    executionCommandReservationTtlMs: 1_000,
  });
  const pending = recordPending(context, "reservation-takeover");
  let releaseAssessment: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    releaseAssessment = resolve;
  });
  context.lower.readinessFactory = async (input) => {
    await gate;
    return eligibleReadiness(input, context.now());
  };
  void context.manager.executeWake(context.orchestrator, {
    idempotencyKey: "wake:reservation-takeover",
    targetExecutionScopeRef: context.target.scopeRef,
    missionRef: pending.missionRef,
  });
  await waitFor(() => context.lower.assessCalls.length === 1);
  context.advance(1_001);
  context.lower.readinessFactory = async (input) => eligibleReadiness(input, context.now());
  const takeover = await context.manager.executeWake(context.orchestrator, {
    idempotencyKey: "wake:reservation-takeover",
    targetExecutionScopeRef: context.target.scopeRef,
    missionRef: pending.missionRef,
  });
  assert.equal(takeover.attempt?.state, "verified");
  releaseAssessment?.();
  assert.equal(context.lower.permits.length, 1);
});

test("wake state and idempotency persist across a normal restart", async (t) => {
  const context = await fixture(t);
  const pending = recordPending(context, "restart-normal");
  const first = await context.manager.executeWake(context.orchestrator, {
    idempotencyKey: "wake:restart-normal",
    targetExecutionScopeRef: context.target.scopeRef,
    missionRef: pending.missionRef,
  });
  context.manager.close();
  const restarted = context.restart();
  const replay = await restarted.executeWake(context.orchestrator, {
    idempotencyKey: "wake:restart-normal",
    targetExecutionScopeRef: context.target.scopeRef,
    missionRef: pending.missionRef,
  });
  assert.equal(replay.idempotentReplay, true);
  assert.equal(replay.attempt?.attemptId, first.attempt?.attemptId);
  assert.equal(context.lower.permits.length, 1);
});

test("wake coordination fails closed when disabled or persistence is absent", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-wake-coordination-missing-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lower = new FakeLowerPlane(Date.now);
  const unmigrated = openDatabase(join(root, "missing"));
  unmigrated.sqlite.exec("drop table execution_wake_coordination_schema_versions");
  try {
    assert.throws(
      () => new ExecutionWakeCoordinationManager(
        DEFAULT_EXECUTION_WAKE_COORDINATION_CONFIG,
        join(root, "missing"),
        lower,
        { database: unmigrated },
      ),
      /persistence is not installed/i,
    );
  } finally {
    unmigrated.close();
  }

  const context = await fixture(t, { enabled: false });
  assert.throws(
    () => context.manager.status(
      context.orchestrator,
      context.target.scopeRef,
      "mission:wake-target",
    ),
    /wake coordination is disabled/i,
  );
});

async function waitFor(
  predicate: () => boolean,
  attempts = 100,
): Promise<void> {
  for (let index = 0; index < attempts; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.fail("Condition did not become true before the test deadline.");
}

test("authority ceiling remains executor-local throughout wake artifacts", async (t) => {
  const context = await fixture(t);
  const pending = recordPending(context, "authority");
  const result = await context.manager.executeWake(context.orchestrator, {
    idempotencyKey: "wake:authority",
    targetExecutionScopeRef: context.target.scopeRef,
    missionRef: pending.missionRef,
  });
  assert.deepEqual(result.authority, EXECUTION_WAKE_COORDINATION_AUTHORITY);
  assert.equal(result.authority.publicationAuthority, false);
  assert.equal(result.authority.browserOwnershipAuthority, false);
  assert.equal(result.authority.completionInferredFromSilence, false);
  assert.equal(result.attempt?.permit.authority.tierOneMayReload, false);
});
