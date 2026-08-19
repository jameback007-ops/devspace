import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { ExecutionScopeManager } from "./execution-observability.js";
import { ProcessSessionManager } from "./process-sessions.js";
import {
  executionScopeIdentity,
  executorTurnMetadata,
} from "./request-meta.js";
import {
  TurnContinuityManager,
  type RecoveryCapsuleInput,
  type TurnContinuityConfig,
} from "./turn-continuity.js";

const execFileAsync = promisify(execFile);

const config: TurnContinuityConfig = {
  enabled: true,
  estimatedTurnMs: 1_000,
  awarenessAfterMs: 500,
  landingAfterMs: 800,
  urgentAfterMs: 900,
  instabilityWindowMs: 1_000,
  capsuleRefreshAfterMs: 250,
  staleRunningToolMs: 100,
  staleRunningProcessMs: 250,
  capsuleRetentionMs: 30 * 24 * 60 * 60 * 1_000,
  maxCapsulesPerWorkspace: 10,
  maxCapsuleCharacters: 64_000,
};

test("turn horizon is advisory-only, emits each threshold once, and explicit begin is idempotent", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-turn-horizon-test-"));
  let now = 10_000;
  const manager = new TurnContinuityManager(config, stateDir, { now: () => now });
  const identity = executionScopeIdentity({ "openai/session": "scope-one" });
  assert.ok(identity);
  t.after(async () => {
    manager.close();
    await rm(stateDir, { recursive: true, force: true });
  });

  const first = manager.begin(identity, {}, {
    idempotencyKey: "turn-one",
    reason: "new_turn",
  });
  assert.equal(first.started, true);
  const firstStatus = first.status as Record<string, unknown>;
  assert.equal(firstStatus.advisory, "normal");
  assert.equal(firstStatus.toolsBlocked, false);
  assert.equal(firstStatus.taskCompletionRequired, false);
  const semanticUnavailable = await manager.semanticProjectionForScope(
    identity.scopeRef,
  );
  assert.equal(semanticUnavailable.available, false);
  assert.equal(
    semanticUnavailable.reason,
    "no_explicit_recovery_capsule_for_scope",
  );

  manager.observeToolFinish(identity, {}, "apply_patch", {}, true);
  const adoption = manager.advisoryNotice(identity, {}, "apply_patch");
  assert.match(adoption ?? "", /recovery capsule available/i);
  assert.match(adoption ?? "", /Continue the current causal chain normally/i);
  assert.equal(manager.advisoryNotice(identity, {}, "read"), undefined);

  now += 600;
  const awareness = manager.advisoryNotice(identity, {}, "read");
  assert.match(awareness ?? "", /checkpoint|recovery capsule/i);
  assert.equal(manager.advisoryNotice(identity, {}, "read"), undefined);

  now += 200;
  const landing = manager.advisoryNotice(identity, {}, "read");
  assert.match(landing ?? "", /landing opportunity/i);
  assert.match(landing ?? "", /Tools remain fully available/i);
  assert.equal(manager.advisoryNotice(identity, {}, "read"), undefined);

  now += 100;
  const urgent = manager.advisoryNotice(identity, {}, "read");
  assert.match(urgent ?? "", /urgent landing guidance/i);
  assert.match(urgent ?? "", /Tools remain fully available/i);
  assert.equal(manager.advisoryNotice(identity, {}, "read"), undefined);

  await manager.recordCapsule(identity, { id: "ws_turn", root: stateDir }, {
    idempotencyKey: "turn-one-capsule",
    intent: "rolling",
    currentFrontier: "preserve the current test frontier",
    currentCausalSlice: "verify advisory and checkpoint behavior",
    validationState: "partial",
    worktreeState: "unknown",
    effectState: "none",
    retryPolicy: "normal",
    exactNextAction: "continue the focused test",
  });
  now += 1;
  manager.observeToolFinish(identity, {}, "apply_patch", {}, true);
  const staleNotice = manager.advisoryNotice(identity, {}, "read");
  assert.match(staleNotice ?? "", /Potentially mutating work occurred/i);
  assert.equal(manager.advisoryNotice(identity, {}, "read"), undefined);

  const replay = manager.begin(identity, {}, {
    idempotencyKey: "turn-one",
    reason: "new_turn",
  });
  assert.equal(replay.started, false);
  assert.equal(replay.idempotentReplay, true);
  assert.equal(
    (replay.status as Record<string, unknown>).startedAt,
    firstStatus.startedAt,
  );

  const next = manager.begin(identity, {}, {
    idempotencyKey: "turn-two",
    reason: "new_turn",
  });
  assert.equal(next.started, true);
  assert.equal((next.status as Record<string, unknown>).advisory, "normal");
});

test("host turn identity automatically resets advisory timing without using conversation age", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-host-turn-test-"));
  let now = 50_000;
  const manager = new TurnContinuityManager(config, stateDir, { now: () => now });
  const identity = executionScopeIdentity({ "openai/session": "conversation" });
  assert.ok(identity);
  t.after(async () => {
    manager.close();
    await rm(stateDir, { recursive: true, force: true });
  });

  const firstMeta = executorTurnMetadata({
    "devspace/executor-turn": "host-turn-one",
  });
  const first = manager.status(identity, firstMeta);
  const firstStatus = first.status as Record<string, unknown>;
  assert.equal(firstStatus.source, "host_turn");
  assert.equal(firstStatus.advisory, "normal");

  now += 800;
  assert.equal(
    ((manager.status(identity, firstMeta).status) as Record<string, unknown>).advisory,
    "landing_opportunity",
  );

  now += 100;
  assert.equal(
    ((manager.status(identity, firstMeta).status) as Record<string, unknown>).advisory,
    "urgent_landing",
  );

  const secondMeta = executorTurnMetadata({
    "devspace/executor-turn": "host-turn-two",
  });
  const secondStatus = manager.status(identity, secondMeta).status as Record<string, unknown>;
  assert.equal(secondStatus.advisory, "normal");
  assert.notEqual(secondStatus.epochId, firstStatus.epochId);
});

test("an exact host deadline uses lead-window advisories without enforcing the deadline", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-host-deadline-test-"));
  let now = 1_000_000;
  const manager = new TurnContinuityManager(config, stateDir, { now: () => now });
  const identity = executionScopeIdentity({ "openai/session": "deadline-scope" });
  assert.ok(identity);
  t.after(async () => {
    manager.close();
    await rm(stateDir, { recursive: true, force: true });
  });

  const metadata = executorTurnMetadata({
    "devspace/executor-turn": "deadline-turn",
    "devspace/executor-deadline-ms": now + 2_000,
  });
  const initial = manager.status(identity, metadata).status as Record<string, unknown>;
  assert.equal(initial.deadlineKind, "host_exact");
  assert.equal(initial.advisory, "normal");
  assert.equal(initial.toolsBlocked, false);

  now += 1_600;
  const awareness = manager.status(identity, metadata).status as Record<string, unknown>;
  assert.equal(awareness.advisory, "checkpoint_awareness");

  now += 250;
  const landing = manager.status(identity, metadata).status as Record<string, unknown>;
  assert.equal(landing.advisory, "landing_opportunity");
  assert.equal(landing.taskCompletionRequired, false);

  now += 75;
  const urgent = manager.status(identity, metadata).status as Record<string, unknown>;
  assert.equal(urgent.advisory, "urgent_landing");
  assert.equal(urgent.toolsBlocked, false);

  now += 500;
  const overrun = manager.status(identity, metadata).status as Record<string, unknown>;
  assert.equal(overrun.advisory, "urgent_landing");
  assert.equal(overrun.toolsBlocked, false);
  assert.ok(Number(overrun.overrunMs) > 0);
});

test("the first non-control tool starts an implicit horizon without a manual begin call", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-implicit-turn-test-"));
  let now = 2_000_000;
  const manager = new TurnContinuityManager(config, stateDir, { now: () => now });
  const identity = executionScopeIdentity({ "openai/session": "implicit-turn-scope" });
  assert.ok(identity);
  t.after(async () => {
    manager.close();
    await rm(stateDir, { recursive: true, force: true });
  });

  const before = manager.status(identity, {}).status as Record<string, unknown>;
  assert.equal(before.advisory, "not_started");

  manager.observeToolStart(identity, {}, "read");
  manager.observeToolFinish(identity, {}, "read", { path: "README.md" }, true);
  const after = manager.status(identity, {}).status as Record<string, unknown>;
  assert.equal(after.source, "implicit");
  assert.equal(after.advisory, "normal");
  assert.equal(after.toolsBlocked, false);
  assert.equal(after.taskCompletionRequired, false);
  assert.equal(after.commitRequired, false);
});

test("the background observer persists a landing envelope when timing becomes material without another tool call", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-background-landing-"));
  let now = 2_250_000;
  const manager = new TurnContinuityManager(config, stateDir, {
    now: () => now,
    operationalRefreshIntervalMs: false,
  });
  const identity = executionScopeIdentity({
    "openai/session": "background-landing-scope",
  });
  assert.ok(identity);
  t.after(async () => {
    manager.close();
    await rm(stateDir, { recursive: true, force: true });
  });

  const begun = manager.begin(identity, {}, {
    idempotencyKey: "background-landing-turn",
    reason: "new_turn",
  });
  const epochId = String((begun.status as Record<string, unknown>).epochId);
  now += config.awarenessAfterMs;

  assert.equal(
    manager.landingProjectionForScope(identity.scopeRef).operationalEnvelope,
    undefined,
  );
  manager.refreshOperationalLandingState();
  const landing = manager.landingProjectionForScope(identity.scopeRef);
  const envelope = landing.operationalEnvelope as Record<string, unknown>;
  assert.equal(envelope.epochId, epochId);
  assert.equal(envelope.triggerKind, "awareness_timing");
  assert.equal(
    landing.classification,
    "automatic_envelope_with_stale_or_missing_semantic_capsule",
  );
});

test("a turn-boundary capsule seals the epoch and the next non-control tool resumes the same mission in a fresh epoch", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-sealed-turn-test-"));
  const stateDir = join(root, ".state");
  const project = await createGitProject(root, "project");
  let now = 3_000_000;
  const manager = new TurnContinuityManager(config, stateDir, { now: () => now });
  const identity = executionScopeIdentity({ "openai/session": "sealed-turn-scope" });
  assert.ok(identity);
  const metadata = executorTurnMetadata({
    "devspace/executor-turn": "host-turn-one",
  });
  t.after(async () => {
    manager.close();
    await rm(root, { recursive: true, force: true });
  });

  const initial = manager.status(identity, metadata).status as Record<string, unknown>;
  const firstEpoch = String(initial.epochId);
  assert.equal(initial.source, "host_turn");
  assert.equal(initial.sealed, false);

  const recorded = await manager.recordCapsule(
    identity,
    { id: "ws_sealed_turn", root: project },
    {
      idempotencyKey: "sealed-turn-boundary",
      intent: "turn_boundary",
      missionRef: "MISSION-SAME-CAUSAL-FRONTIER",
      currentFrontier: "continue the same implementation after the assistant turn",
      currentCausalSlice: "finish the current coherent source edit",
      validationState: "passed",
      validationRefs: ["validation:focused:passed"],
      worktreeState: "clean",
      effectState: "none",
      writerState: "released",
      retryPolicy: "normal",
      exactNextAction: "continue the next focused source edit",
    },
  );
  assert.equal(recorded.recorded, true);

  const sealed = manager.status(identity, metadata).status as Record<string, unknown>;
  assert.equal(sealed.epochId, firstEpoch);
  assert.equal(sealed.sealed, true);
  const sealedLanding = sealed.landing as Record<string, unknown>;
  assert.equal(sealedLanding.classification, "clean_turn_boundary_landing");
  assert.equal(sealedLanding.sameMissionContinuationExpected, true);
  assert.match(String(sealedLanding.recommendedAction), /same mission/i);

  const repeatedStatus = manager.status(identity, metadata).status as Record<string, unknown>;
  assert.equal(repeatedStatus.epochId, firstEpoch);
  assert.equal(repeatedStatus.sealed, true);

  now += 1;
  manager.observeToolStart(identity, metadata, "read");
  const next = manager.status(identity, metadata).status as Record<string, unknown>;
  assert.notEqual(next.epochId, firstEpoch);
  assert.equal(next.source, "host_turn");
  assert.equal(next.sealed, false);
  const nextLanding = next.landing as Record<string, unknown>;
  assert.equal(nextLanding.sameMissionContinuationExpected, true);
  assert.equal(nextLanding.envelopeEpochRelation, "previous_epoch");

  const replay = await manager.recordCapsule(
    identity,
    { id: "ws_sealed_turn", root: project },
    {
      idempotencyKey: "sealed-turn-boundary",
      intent: "turn_boundary",
      missionRef: "MISSION-SAME-CAUSAL-FRONTIER",
      currentFrontier: "continue the same implementation after the assistant turn",
      currentCausalSlice: "finish the current coherent source edit",
      validationState: "passed",
      validationRefs: ["validation:focused:passed"],
      worktreeState: "clean",
      effectState: "none",
      writerState: "released",
      retryPolicy: "normal",
      exactNextAction: "continue the next focused source edit",
    },
  );
  assert.equal(replay.recorded, false);
  assert.equal(
    replay.horizonRelation,
    "historical_capsule_replay_after_successor_epoch",
  );
  const afterHistoricalReplay = manager.status(identity, metadata)
    .status as Record<string, unknown>;
  assert.equal(afterHistoricalReplay.epochId, next.epochId);
  assert.equal(afterHistoricalReplay.sealed, false);
});

test("repeated normalized tool lifecycle errors escalate early landing guidance without blocking tools", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-instability-errors-"));
  let now = 4_000_000;
  const processes = new ProcessSessionManager();
  const observations = new ExecutionScopeManager(
    {
      enabled: true,
      retentionMs: 7 * 24 * 60 * 60 * 1_000,
      maxEventsPerScope: 100,
      idleAfterMs: 5 * 60 * 1_000,
    },
    stateDir,
    processes,
    { now: () => now },
  );
  const manager = new TurnContinuityManager(config, stateDir, { now: () => now });
  const identity = executionScopeIdentity({ "openai/session": "instability-error-scope" });
  assert.ok(identity);
  t.after(async () => {
    observations.close();
    processes.shutdown();
    manager.close();
    await rm(stateDir, { recursive: true, force: true });
  });

  const firstHandle = observations.beginTool(identity, "read", {
    workspaceId: "ws_error",
    path: "one.ts",
  });
  observations.finishTool(firstHandle, "error", {
    error: new Error("first transport failure detail must remain private"),
  });
  manager.observeToolFinish(identity, {}, "read", { path: "one.ts" }, false);
  const degradedNotice = manager.advisoryNotice(identity, {}, "read");
  assert.match(degradedNotice ?? "", /turn-stability degraded/i);
  const degraded = manager.status(identity, {}).status as Record<string, unknown>;
  assert.equal((degraded.instability as Record<string, unknown>).state, "degraded");
  assert.equal(degraded.toolsBlocked, false);

  now += 10;
  const secondHandle = observations.beginTool(identity, "read", {
    workspaceId: "ws_error",
    path: "two.ts",
  });
  observations.finishTool(secondHandle, "error", {
    error: new Error("first transport failure detail must remain private"),
  });
  manager.observeToolFinish(identity, {}, "read", { path: "two.ts" }, false);
  const unstableNotice = manager.advisoryNotice(identity, {}, "read");
  assert.match(unstableNotice ?? "", /turn-stability unstable/i);
  assert.match(unstableNotice ?? "", /do not open a new long causal frontier/i);
  const unstable = manager.status(identity, {}).status as Record<string, unknown>;
  const instability = unstable.instability as Record<string, unknown>;
  assert.equal(instability.state, "unstable");
  assert.equal(
    (instability.reasonCodes as string[]).includes("repeated_normalized_tool_failure"),
    true,
  );
  assert.equal(
    (unstable.guidance as Record<string, unknown>).newMutationOrEffectAuthorityGranted,
    false,
  );
  assert.equal(manager.advisoryNotice(identity, {}, "read"), undefined);
});

test("distinct tool failures remain degraded instead of imitating repeated transport failure", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-instability-distinct-errors-"));
  let now = 4_500_000;
  const processes = new ProcessSessionManager();
  const observations = new ExecutionScopeManager(
    {
      enabled: true,
      retentionMs: 7 * 24 * 60 * 60 * 1_000,
      maxEventsPerScope: 100,
      idleAfterMs: 5 * 60 * 1_000,
    },
    stateDir,
    processes,
    { now: () => now },
  );
  const manager = new TurnContinuityManager(config, stateDir, { now: () => now });
  const identity = executionScopeIdentity({
    "openai/session": "instability-distinct-error-scope",
  });
  assert.ok(identity);
  t.after(async () => {
    observations.close();
    processes.shutdown();
    manager.close();
    await rm(stateDir, { recursive: true, force: true });
  });

  for (const [index, message] of ["missing file", "invalid selector"].entries()) {
    const handle = observations.beginTool(identity, "read", {
      workspaceId: "ws_distinct_error",
      path: `file-${index}.ts`,
    });
    observations.finishTool(handle, "error", { error: new Error(message) });
    manager.observeToolFinish(
      identity,
      {},
      "read",
      { path: `file-${index}.ts` },
      false,
    );
    now += 1;
  }

  const status = manager.status(identity, {}).status as Record<string, unknown>;
  const instability = status.instability as Record<string, unknown>;
  assert.equal(instability.state, "degraded");
  assert.equal(
    (instability.reasonCodes as string[]).includes("repeated_normalized_tool_failure"),
    false,
  );
  assert.equal(status.toolsBlocked, false);
});

test("generic tool error responses without a stable digest do not become a repeated failure", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-instability-generic-errors-"));
  let now = 4_750_000;
  const processes = new ProcessSessionManager();
  const observations = new ExecutionScopeManager(
    {
      enabled: true,
      retentionMs: 7 * 24 * 60 * 60 * 1_000,
      maxEventsPerScope: 100,
      idleAfterMs: 5 * 60 * 1_000,
    },
    stateDir,
    processes,
    { now: () => now },
  );
  const manager = new TurnContinuityManager(config, stateDir, { now: () => now });
  const identity = executionScopeIdentity({
    "openai/session": "instability-generic-error-scope",
  });
  assert.ok(identity);
  t.after(async () => {
    observations.close();
    processes.shutdown();
    manager.close();
    await rm(stateDir, { recursive: true, force: true });
  });

  for (let index = 0; index < 2; index += 1) {
    const handle = observations.beginTool(identity, "read", {
      workspaceId: "ws_generic_error",
      path: `missing-${index}.ts`,
    });
    observations.finishTool(handle, "error", {
      response: { isError: true },
    });
    manager.observeToolFinish(
      identity,
      {},
      "read",
      { path: `missing-${index}.ts` },
      false,
    );
    now += 1;
  }

  const status = manager.status(identity, {}).status as Record<string, unknown>;
  const instability = status.instability as Record<string, unknown>;
  assert.equal(instability.state, "degraded");
  assert.equal(
    (instability.recentOutcomes as Record<string, unknown>).repeatedFailureCount,
    0,
  );
});

test("a legitimate long exec and an ordinary nonzero command exit do not become transport instability", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-instability-false-positive-"));
  let now = 5_000_000;
  let runningProcesses = [{
    sessionId: 77,
    workspaceId: "ws_long_exec",
    startedAt: new Date(now).toISOString(),
    lastOutputAt: new Date(now).toISOString(),
    wallTimeMs: 0,
  }];
  const processes = new ProcessSessionManager();
  const observations = new ExecutionScopeManager(
    {
      enabled: true,
      retentionMs: 7 * 24 * 60 * 60 * 1_000,
      maxEventsPerScope: 100,
      idleAfterMs: 5 * 60 * 1_000,
    },
    stateDir,
    processes,
    { now: () => now },
  );
  const manager = new TurnContinuityManager(config, stateDir, {
    now: () => now,
    operationalObservation: () => ({ runningProcesses }),
  });
  const identity = executionScopeIdentity({ "openai/session": "normal-long-exec-scope" });
  assert.ok(identity);
  t.after(async () => {
    observations.close();
    processes.shutdown();
    manager.close();
    await rm(stateDir, { recursive: true, force: true });
  });

  const runningHandle = observations.beginTool(identity, "exec_command", {
    workspaceId: "ws_long_exec",
    cmd: "long legitimate build command",
  });
  manager.observeToolStart(identity, {}, "exec_command");
  now += 500;
  runningProcesses = [{
    ...runningProcesses[0],
    wallTimeMs: 500,
  }];
  const running = manager.status(identity, {}).status as Record<string, unknown>;
  assert.equal((running.instability as Record<string, unknown>).state, "normal");
  assert.equal(
    ((running.instability as Record<string, unknown>).exposure as Record<string, unknown>)
      .staleRunningToolCount,
    0,
  );
  assert.equal(
    (running.landing as Record<string, unknown>).processOrEffectReconciliationRequired,
    true,
  );

  observations.finishTool(runningHandle, "succeeded", {
    response: {
      structuredContent: {
        workspaceId: "ws_long_exec",
        exitCode: 1,
        running: false,
        outputComplete: true,
      },
    },
  });
  runningProcesses = [];
  manager.observeToolFinish(
    identity,
    {},
    "exec_command",
    { cmd: "long legitimate build command" },
    true,
  );
  const nonzero = manager.status(identity, {}).status as Record<string, unknown>;
  assert.equal((nonzero.instability as Record<string, unknown>).state, "normal");
  assert.equal(
    ((nonzero.instability as Record<string, unknown>).reasonCodes as string[])
      .includes("recent_tool_error_response"),
    false,
  );
});

test("a stale non-process tool observation triggers early landing while preserving advisory authority boundaries", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-stale-tool-observation-"));
  let now = 5_500_000;
  const processes = new ProcessSessionManager();
  const observations = new ExecutionScopeManager(
    {
      enabled: true,
      retentionMs: 7 * 24 * 60 * 60 * 1_000,
      maxEventsPerScope: 100,
      idleAfterMs: 5 * 60 * 1_000,
    },
    stateDir,
    processes,
    { now: () => now },
  );
  const manager = new TurnContinuityManager(config, stateDir, { now: () => now });
  const identity = executionScopeIdentity({ "openai/session": "stale-read-scope" });
  assert.ok(identity);
  t.after(async () => {
    observations.close();
    processes.shutdown();
    manager.close();
    await rm(stateDir, { recursive: true, force: true });
  });

  const handle = observations.beginTool(identity, "read", {
    workspaceId: "ws_stale",
    path: "README.md",
  });
  manager.observeToolStart(identity, {}, "read");
  now += 101;
  const status = manager.status(identity, {}).status as Record<string, unknown>;
  const instability = status.instability as Record<string, unknown>;
  assert.equal(instability.state, "unstable");
  assert.equal(
    (instability.reasonCodes as string[]).includes("stale_non_process_tool_observation"),
    true,
  );
  assert.equal(status.toolsBlocked, false);
  assert.equal(
    (status.guidance as Record<string, unknown>).taskCompletionRequired,
    false,
  );
  observations.finishTool(handle, "interrupted");
});

test("mutation after an aging capsule amplifies but does not manufacture instability authority", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-capsule-debt-risk-"));
  let now = 6_000_000;
  const processes = new ProcessSessionManager();
  const observations = new ExecutionScopeManager(
    {
      enabled: true,
      retentionMs: 7 * 24 * 60 * 60 * 1_000,
      maxEventsPerScope: 100,
      idleAfterMs: 5 * 60 * 1_000,
    },
    stateDir,
    processes,
    { now: () => now },
  );
  const manager = new TurnContinuityManager(config, stateDir, { now: () => now });
  const identity = executionScopeIdentity({ "openai/session": "capsule-debt-scope" });
  assert.ok(identity);
  t.after(async () => {
    observations.close();
    processes.shutdown();
    manager.close();
    await rm(stateDir, { recursive: true, force: true });
  });

  manager.observeToolFinish(identity, {}, "read", { path: "README.md" }, true);
  await manager.recordCapsule(identity, { id: "ws_capsule_debt", root: stateDir }, {
    idempotencyKey: "capsule-debt-baseline",
    intent: "rolling",
    missionRef: "CAPSULE-DEBT-MISSION",
    currentFrontier: "continue the current source slice",
    currentCausalSlice: "measure risk amplification without changing authority",
    validationState: "partial",
    worktreeState: "unknown",
    effectState: "none",
    retryPolicy: "normal",
    exactNextAction: "continue the source edit",
  });

  const handle = observations.beginTool(identity, "read", {
    workspaceId: "ws_capsule_debt",
    path: "missing.ts",
  });
  observations.finishTool(handle, "error", {
    error: new Error("bounded tool lifecycle anomaly"),
  });
  manager.observeToolFinish(identity, {}, "read", { path: "missing.ts" }, false);
  const baseline = manager.status(identity, {}).status as Record<string, unknown>;
  const baselineInstability = baseline.instability as Record<string, unknown>;
  assert.equal(baselineInstability.state, "degraded");
  const baselineScore = Number(baselineInstability.score);

  now += 300;
  manager.observeToolFinish(
    identity,
    {},
    "apply_patch",
    { patch: "*** Begin Patch\n*** End Patch" },
    true,
  );
  const amplified = manager.status(identity, {}).status as Record<string, unknown>;
  const amplifiedInstability = amplified.instability as Record<string, unknown>;
  assert.ok(Number(amplifiedInstability.score) > baselineScore);
  assert.equal(
    (amplifiedInstability.reasonCodes as string[]).includes("mutation_after_latest_capsule"),
    true,
  );
  assert.equal(
    (amplifiedInstability.reasonCodes as string[]).includes("capsule_refresh_debt"),
    true,
  );
  assert.equal(
    (amplified.guidance as Record<string, unknown>).newMutationOrEffectAuthorityGranted,
    false,
  );
});

test("in-flight and unknown effects require reconciliation without creating retry authority", async () => {
  for (const effectState of ["in_flight", "unknown"] as const) {
    const stateDir = await mkdtemp(join(tmpdir(), `devspace-effect-${effectState}-`));
    let manager: TurnContinuityManager | undefined;
    try {
      let now = 7_000_000;
      manager = new TurnContinuityManager(config, stateDir, { now: () => now });
      const identity = executionScopeIdentity({
        "openai/session": `effect-${effectState}-scope`,
      });
      assert.ok(identity);
      manager.observeToolFinish(identity, {}, "read", { path: "README.md" }, true);
      await manager.recordCapsule(
        identity,
        { id: `ws_effect_${effectState}`, root: stateDir },
        {
          idempotencyKey: `effect-${effectState}-capsule`,
          intent: "before_effect",
          missionRef: "EFFECT-RECONCILIATION-MISSION",
          currentFrontier: "preserve the exact external effect identity",
          currentCausalSlice: "hold replay until outcome reconciliation",
          validationState: "partial",
          worktreeState: "unknown",
          effectState,
          effectKeys: [`effect:${effectState}:one`],
          writerState: "held",
          retryPolicy: "reconcile_before_retry",
          safeToMutate: false,
          safeToPublish: false,
          exactNextAction: "reconcile the effect receipt before any retry",
        },
      );
      const status = manager.status(identity, {}).status as Record<string, unknown>;
      assert.equal(
        (status.landing as Record<string, unknown>).classification,
        "effect_or_process_reconciliation_required",
      );
      assert.match(
        String((status.landing as Record<string, unknown>).recommendedAction),
        /before retry/i,
      );
      assert.equal(status.toolsBlocked, false);
      assert.equal(
        (status.guidance as Record<string, unknown>).newMutationOrEffectAuthorityGranted,
        false,
      );
    } finally {
      manager?.close();
      await rm(stateDir, { recursive: true, force: true });
    }
  }
});

test("a no-effect capsule does not require effect reconciliation only because its retry policy is conservative", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-no-effect-reconciliation-"));
  const manager = new TurnContinuityManager(config, stateDir, { now: () => 7_500_000 });
  const identity = executionScopeIdentity({ "openai/session": "no-effect-scope" });
  assert.ok(identity);
  t.after(async () => {
    manager.close();
    await rm(stateDir, { recursive: true, force: true });
  });

  await manager.recordCapsule(identity, { id: "ws_no_effect", root: stateDir }, {
    idempotencyKey: "no-effect-conservative-retry",
    intent: "rolling",
    missionRef: "NO-EFFECT-MISSION",
    currentFrontier: "continue source-only work",
    currentCausalSlice: "preserve a conservative retry posture without an effect",
    validationState: "partial",
    worktreeState: "unknown",
    effectState: "none",
    effectKeys: [],
    retryPolicy: "reconcile_before_retry",
    exactNextAction: "continue the source-only slice",
  });

  const status = manager.status(identity, {}).status as Record<string, unknown>;
  const instability = status.instability as Record<string, unknown>;
  const exposure = instability.exposure as Record<string, unknown>;
  assert.equal(exposure.effectReconciliationRequired, false);
  assert.notEqual(
    (status.landing as Record<string, unknown>).classification,
    "effect_or_process_reconciliation_required",
  );
});

test("the operational landing envelope survives restart, detects backend epoch change, and excludes raw sensitive content", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-landing-envelope-restart-"));
  let now = 8_000_000;
  let backendInstance = "backend-one";
  let backendStartedAt = now - 1_000;
  const processes = new ProcessSessionManager();
  const observations = new ExecutionScopeManager(
    {
      enabled: true,
      retentionMs: 7 * 24 * 60 * 60 * 1_000,
      maxEventsPerScope: 100,
      idleAfterMs: 5 * 60 * 1_000,
    },
    stateDir,
    processes,
    { now: () => now },
  );
  let manager = new TurnContinuityManager(config, stateDir, {
    now: () => now,
    operationalObservation: () => ({
      backend: {
        instanceRef: backendInstance,
        startedAtMs: backendStartedAt,
        surfaceEpoch: "surface-one",
        fingerprintSha256: "a".repeat(64),
      },
    }),
  });
  const identity = executionScopeIdentity({ "openai/session": "envelope-restart-scope" });
  assert.ok(identity);
  t.after(async () => {
    observations.close();
    processes.shutdown();
    manager.close();
    await rm(stateDir, { recursive: true, force: true });
  });

  manager.observeToolFinish(identity, {}, "read", { path: "README.md" }, true);
  now += 800;
  const secret = "TOP-SECRET-COMMAND-AND-ERROR-CONTENT";
  const handle = observations.beginTool(identity, "exec_command", {
    workspaceId: "ws_envelope",
    cmd: `printf ${secret}`,
  });
  observations.finishTool(handle, "error", {
    error: new Error(secret),
  });
  manager.observeToolFinish(
    identity,
    {},
    "exec_command",
    { cmd: `printf ${secret}` },
    false,
  );
  manager.advisoryNotice(identity, {}, "exec_command");
  const beforeRestart = manager.status(identity, {}).status as Record<string, unknown>;
  const beforeLanding = beforeRestart.landing as Record<string, unknown>;
  const beforeEnvelope = beforeLanding.operationalEnvelope as Record<string, unknown>;
  assert.ok(beforeEnvelope);
  const beforeDigest = String(beforeEnvelope.digestSha256);
  const beforeGeneration = Number(beforeEnvelope.generation);
  const serializedBefore = JSON.stringify(beforeEnvelope);
  assert.equal(serializedBefore.includes(secret), false);
  assert.equal(serializedBefore.includes("printf"), false);
  assert.ok(serializedBefore.length < 40_000);

  now += 1;
  const repeated = manager.status(identity, {}).status as Record<string, unknown>;
  const repeatedEnvelope = (repeated.landing as Record<string, unknown>)
    .operationalEnvelope as Record<string, unknown>;
  assert.equal(repeatedEnvelope.digestSha256, beforeDigest);
  assert.equal(Number(repeatedEnvelope.generation), beforeGeneration);

  manager.close();
  backendInstance = "backend-two";
  backendStartedAt = now;
  manager = new TurnContinuityManager(config, stateDir, {
    now: () => now,
    operationalObservation: () => ({
      backend: {
        instanceRef: backendInstance,
        startedAtMs: backendStartedAt,
        surfaceEpoch: "surface-two",
        fingerprintSha256: "b".repeat(64),
      },
    }),
  });
  const afterRestart = manager.status(identity, {}).status as Record<string, unknown>;
  const afterEnvelope = (afterRestart.landing as Record<string, unknown>)
    .operationalEnvelope as Record<string, unknown>;
  assert.notEqual(afterEnvelope.digestSha256, beforeDigest);
  assert.ok(Number(afterEnvelope.generation) > Number(beforeEnvelope.generation));
  const afterInstability = afterRestart.instability as Record<string, unknown>;
  assert.equal(
    (afterInstability.reasonCodes as string[])
      .includes("backend_instance_changed_since_envelope"),
    true,
  );
  assert.equal(afterInstability.state, "unstable");
  assert.equal(JSON.stringify(afterEnvelope).includes(secret), false);
});

test("refreshing the semantic capsule upgrades a persisted machine envelope from missing to fresh", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-envelope-capsule-refresh-"));
  let now = 9_000_000;
  const manager = new TurnContinuityManager(config, stateDir, { now: () => now });
  const identity = executionScopeIdentity({ "openai/session": "envelope-refresh-scope" });
  assert.ok(identity);
  t.after(async () => {
    manager.close();
    await rm(stateDir, { recursive: true, force: true });
  });

  manager.observeToolFinish(
    identity,
    {},
    "apply_patch",
    { patch: "*** Begin Patch\n*** End Patch" },
    true,
  );
  now += 800;
  manager.advisoryNotice(identity, {}, "read");
  const missing = manager.status(identity, {}).status as Record<string, unknown>;
  const missingLanding = missing.landing as Record<string, unknown>;
  assert.equal(
    missingLanding.classification,
    "automatic_envelope_with_stale_or_missing_semantic_capsule",
  );
  assert.equal(missingLanding.semanticCapsuleState, "missing");
  const missingEnvelope = missingLanding.operationalEnvelope as Record<string, unknown>;

  await manager.recordCapsule(identity, { id: "ws_envelope_refresh", root: stateDir }, {
    idempotencyKey: "envelope-refresh-capsule",
    intent: "rolling",
    missionRef: "ENVELOPE-REFRESH-MISSION",
    currentFrontier: "resume the same material source slice",
    currentCausalSlice: "join the machine envelope to explicit semantic state",
    validationState: "partial",
    worktreeState: "unknown",
    effectState: "none",
    retryPolicy: "normal",
    exactNextAction: "continue the same source slice",
  });
  const refreshed = manager.status(identity, {}).status as Record<string, unknown>;
  const refreshedLanding = refreshed.landing as Record<string, unknown>;
  assert.equal(
    refreshedLanding.classification,
    "automatic_envelope_with_fresh_semantic_capsule",
  );
  assert.equal(refreshedLanding.semanticCapsuleState, "current_for_observed_mutation");
  assert.equal(refreshedLanding.sameMissionContinuationExpected, true);
  const refreshedEnvelope = refreshedLanding.operationalEnvelope as Record<string, unknown>;
  assert.ok(Number(refreshedEnvelope.generation) > Number(missingEnvelope.generation));
});

test("semantic recovery exposes only the latest bounded executor evidence window", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-recovery-evidence-window-"));
  let now = 75_000;
  const continuity = new TurnContinuityManager(config, stateDir, { now: () => now });
  const processes = new ProcessSessionManager();
  const observations = new ExecutionScopeManager(
    {
      enabled: true,
      retentionMs: 7 * 24 * 60 * 60 * 1_000,
      maxEventsPerScope: 100,
      idleAfterMs: 5 * 60 * 1_000,
    },
    stateDir,
    processes,
    { now: () => now },
  );
  const identity = executionScopeIdentity({ "openai/session": "evidence-window-scope" });
  assert.ok(identity);
  t.after(async () => {
    observations.close();
    processes.shutdown();
    continuity.close();
    await rm(stateDir, { recursive: true, force: true });
  });

  const capsuleHandle = observations.beginTool(
    identity,
    "recovery_capsule_record",
    { workspaceId: "ws_evidence" },
  );
  await continuity.recordCapsule(identity, { id: "ws_evidence", root: stateDir }, {
    idempotencyKey: "evidence-window-capsule",
    intent: "rolling",
    currentFrontier: "prove bounded event evidence",
    currentCausalSlice: "record more successor events than the projection returns",
    validationState: "partial",
    worktreeState: "unknown",
    effectState: "none",
    retryPolicy: "normal",
    exactNextAction: "inspect the bounded evidence window",
  });
  observations.finishTool(capsuleHandle, "succeeded");

  for (let index = 0; index < 25; index += 1) {
    now += 1;
    const tool = index % 2 === 0 ? "read" : "exec_command";
    const handle = observations.beginTool(identity, tool, {
      workspaceId: "ws_evidence",
      path: tool === "read" ? `file-${index}.ts` : undefined,
      cmd: tool === "exec_command" ? `printf secret-${index}` : undefined,
    });
    observations.finishTool(handle, "succeeded", {
      response: tool === "exec_command"
        ? {
            structuredContent: {
              output: `secret-${index}`,
              outputDeltaBytes: 8,
              outputDeltaDigestSha256: "a".repeat(64),
              outputTotalBytes: 8,
              outputDigestSha256: "b".repeat(64),
              outputEventCount: 1,
              outputComplete: true,
            },
          }
        : undefined,
    });
  }

  const projection = await continuity.semanticProjectionForScope(identity.scopeRef, {
    observedScopeLastActivityAtMs: now,
    observedScopeTotalEventCount: 26,
  });
  const evidence = projection.evidenceSinceCapsule as Record<string, unknown>;
  assert.equal(evidence.retainedEventCount, 25);
  assert.equal(evidence.returnedEventCount, 20);
  assert.equal(evidence.truncated, true);
  assert.equal(evidence.capsuleEventRetained, true);
  assert.equal(
    evidence.receiptWindowCompleteness,
    "complete_while_capsule_event_is_retained",
  );
  const events = evidence.events as Array<Record<string, unknown>>;
  assert.equal(events.length, 20);
  assert.ok(Number(events[0]?.sequence) < Number(events.at(-1)?.sequence));
  const serialized = JSON.stringify(evidence);
  assert.equal(serialized.includes("secret-"), false);
  assert.equal(serialized.includes("output\":"), false);
  assert.match(serialized, /outputDigestSha256/);
});

test("recovery capsule is Git-bound, detects stale tracked and untracked state, and survives another scope", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-recovery-capsule-test-"));
  const stateDir = join(root, ".state");
  const project = join(root, "project");
  await execFileAsync("mkdir", ["-p", project]);
  await writeFile(join(project, "README.md"), "initial\n");
  await git(project, ["init"]);
  await git(project, ["config", "user.email", "devspace@example.com"]);
  await git(project, ["config", "user.name", "DevSpace Test"]);
  await git(project, ["add", "."]);
  await git(project, ["commit", "-m", "initial"]);

  let now = 100_000;
  let manager = new TurnContinuityManager(config, stateDir, { now: () => now });
  const firstIdentity = executionScopeIdentity({ "openai/session": "first-scope" });
  assert.ok(firstIdentity);
  const workspace = { id: "ws_first", root: project };
  const semantic: RecoveryCapsuleInput = {
    idempotencyKey: "capsule-clean-1",
    intent: "rolling",
    missionRef: "AOQ-R136",
    authorityOwnerRefs: ["owner:git-main", "owner:material-work"],
    authorityStateRefs: ["git-main:A", "material-work:g1"],
    currentFrontier: "prepare source checkpoint",
    currentCausalSlice: "bind source projection without self-reference",
    established: ["focused tests passed"],
    validationState: "passed",
    validationRefs: ["receipt:test"],
    worktreeState: "clean",
    effectState: "terminal",
    effectKeys: ["effect:one"],
    writerState: "released",
    retryPolicy: "forbidden",
    safeToMutate: true,
    safeToPublish: false,
    exactNextAction: "stage the source projection",
    doNotRepeat: ["do not retry effect:one"],
    unresolved: ["publication not performed"],
  };

  t.after(async () => {
    manager.close();
    await rm(root, { recursive: true, force: true });
  });

  const recorded = await manager.recordCapsule(firstIdentity, workspace, semantic);
  assert.equal(recorded.recorded, true);
  const replay = await manager.recordCapsule(firstIdentity, workspace, semantic);
  assert.equal(replay.recorded, false);
  assert.equal(replay.idempotentReplay, true);
  await assert.rejects(
    manager.recordCapsule(firstIdentity, workspace, {
      ...semantic,
      exactNextAction: "a different action under the same key",
    }),
    /idempotency key was already used for a different payload/i,
  );
  assert.equal(
    ((recorded.capsule as Record<string, unknown>).fingerprint as Record<string, unknown>).kind,
    "git",
  );
  const localOnly = await manager.capsuleStatus(firstIdentity, workspace);
  assert.equal(localOnly.workspaceFreshness, "fresh");
  assert.equal(localOnly.authorityFreshness, "unverified");
  assert.equal(localOnly.exactActionCandidateAvailable, false);
  assert.match(String(localOnly.recommendedAction), /Rehydrate and reconcile/i);

  const fresh = await manager.capsuleStatus(firstIdentity, workspace, {
    currentAuthorityStateRefs: ["material-work:g1", "git-main:A"],
  });
  assert.equal(fresh.workspaceFreshness, "fresh");
  assert.equal(fresh.authorityFreshness, "matched_supplied_refs");
  assert.equal(fresh.exactActionCandidateAvailable, true);
  assert.equal(
    fresh.exactActionReliance,
    "candidate_available_after_supplied_authority_match",
  );
  assert.match(String(fresh.recommendedAction), /stage the source projection/i);

  const canonicalStale = await manager.capsuleStatus(firstIdentity, workspace, {
    currentAuthorityStateRefs: ["material-work:g2", "git-main:B"],
  });
  assert.equal(canonicalStale.workspaceFreshness, "fresh");
  assert.equal(canonicalStale.authorityFreshness, "changed_from_recorded_refs");
  assert.equal(canonicalStale.exactActionCandidateAvailable, false);
  assert.match(String(canonicalStale.recommendedAction), /authoritative state changed elsewhere/i);

  now += 14 * 24 * 60 * 60 * 1_000;
  const timeAloneDoesNotStale = await manager.capsuleStatus(firstIdentity, workspace, {
    currentAuthorityStateRefs: ["git-main:A", "material-work:g1"],
  });
  assert.equal(timeAloneDoesNotStale.workspaceFreshness, "fresh");
  assert.equal(
    timeAloneDoesNotStale.authorityFreshness,
    "matched_supplied_refs",
  );

  await writeFile(join(project, "README.md"), "tracked change\n");
  const trackedStale = await manager.capsuleStatus(firstIdentity, workspace);
  assert.equal(trackedStale.workspaceFreshness, "stale");
  assert.equal(trackedStale.exactActionCandidateAvailable, false);
  assert.ok(
    (trackedStale.workspaceStaleReasons as string[]).includes("tracked_content_changed"),
  );

  now += 1_000;
  await manager.recordCapsule(firstIdentity, workspace, {
    ...semantic,
    idempotencyKey: "capsule-dirty-tracked-1",
    worktreeState: "intentional_dirty",
    exactNextAction: "run the focused test",
  });
  assert.equal(
    (await manager.capsuleStatus(firstIdentity, workspace)).workspaceFreshness,
    "fresh",
  );

  await writeFile(join(project, "scratch.txt"), "one\n");
  now += 1_000;
  await manager.recordCapsule(firstIdentity, workspace, {
    ...semantic,
    idempotencyKey: "capsule-dirty-untracked-1",
    worktreeState: "intentional_dirty",
    exactNextAction: "inspect the untracked scratch artifact",
  });
  await writeFile(join(project, "scratch.txt"), "two\n");
  const untrackedStale = await manager.capsuleStatus(firstIdentity, workspace);
  assert.equal(untrackedStale.workspaceFreshness, "stale");
  assert.ok(
    (untrackedStale.workspaceStaleReasons as string[]).includes("untracked_content_changed"),
  );

  await writeFile(join(project, "scratch.txt"), "one\n");
  const restoredFresh = await manager.capsuleStatus(firstIdentity, workspace);
  assert.equal(restoredFresh.workspaceFreshness, "fresh");
  manager.close();

  manager = new TurnContinuityManager(config, stateDir, { now: () => now + 1_000 });
  const secondIdentity = executionScopeIdentity({ "openai/session": "second-scope" });
  assert.ok(secondIdentity);
  const crossScope = await manager.capsuleStatus(
    secondIdentity,
    { id: "ws_second", root: project },
  );
  assert.equal(crossScope.available, true);
  assert.equal(crossScope.workspaceFreshness, "fresh");
  assert.equal(crossScope.authorityFreshness, "unverified");
  assert.equal(crossScope.exactActionCandidateAvailable, false);
  assert.equal(
    (crossScope.capsule as Record<string, unknown>).sameExecutionScope,
    false,
  );
  assert.match(String(crossScope.recommendedAction), /Rehydrate and reconcile/i);
});

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

async function createGitProject(root: string, name: string): Promise<string> {
  const project = join(root, name);
  await execFileAsync("mkdir", ["-p", project]);
  await writeFile(join(project, "README.md"), "initial\n");
  await git(project, ["init"]);
  await git(project, ["config", "user.email", "devspace@example.com"]);
  await git(project, ["config", "user.name", "DevSpace Test"]);
  await git(project, ["add", "."]);
  await git(project, ["commit", "-m", "initial"]);
  return project;
}
