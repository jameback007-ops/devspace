import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openDatabase } from "./db/client.js";
import { LocalAgentTurnQueue, type LocalAgentQueueConfig } from "./local-agent-queue.js";
import { LocalAgentStore } from "./local-agent-store.js";

const queueConfig: LocalAgentQueueConfig = {
  maxPendingPerAgent: 20,
  maxBodyCharacters: 10_000,
  maxResponseCharacters: 200_000,
  leaseMs: 1_000,
  heartbeatMs: 100,
  terminalRetentionMs: 10_000,
};

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "devspace-local-agent-queue-"));
  let now = Date.parse("2026-08-17T00:00:00Z");
  const store = new LocalAgentStore(root);
  const agent = store.create({
    workspaceId: "ws_test",
    workspaceRoot: join(root, "project"),
    profileName: "codex",
    provider: "codex",
  });
  store.update(agent.id, { status: "idle" });
  const queue = new LocalAgentTurnQueue(queueConfig, root, { now: () => now });
  t.after(async () => {
    queue.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    store,
    queue,
    agentId: agent.id,
    advance(ms: number) {
      now += ms;
    },
  };
}

test("turn queue is idempotent, priority ordered, and serializes one worker", async (t) => {
  const context = await fixture(t);
  const normal = context.queue.enqueue({
    agentId: context.agentId,
    sourceKind: "execution_scope",
    senderScopeRef: "aaaaaaaaaaaaaaaa",
    idempotencyKey: "normal-1",
    kind: "instruction",
    priority: "normal",
    body: "normal work",
  });
  const urgent = context.queue.enqueue({
    agentId: context.agentId,
    sourceKind: "execution_scope",
    senderScopeRef: "aaaaaaaaaaaaaaaa",
    idempotencyKey: "urgent-1",
    kind: "correction",
    priority: "urgent",
    body: "urgent correction",
  });
  const replay = context.queue.enqueue({
    agentId: context.agentId,
    sourceKind: "execution_scope",
    senderScopeRef: "aaaaaaaaaaaaaaaa",
    idempotencyKey: "urgent-1",
    kind: "correction",
    priority: "urgent",
    body: "urgent correction",
  });
  assert.equal(replay.idempotentReplay, true);
  assert.equal(replay.turn.turnId, urgent.turn.turnId);
  assert.throws(
    () => context.queue.enqueue({
      agentId: context.agentId,
      sourceKind: "execution_scope",
      senderScopeRef: "aaaaaaaaaaaaaaaa",
      idempotencyKey: "urgent-1",
      kind: "correction",
      priority: "urgent",
      body: "different payload",
    }),
    /different payload/,
  );

  assert.equal(context.queue.acquireLease(context.agentId, "worker-1").acquired, true);
  assert.equal(context.queue.acquireLease(context.agentId, "worker-2").acquired, false);
  const first = context.queue.claimNext(context.agentId, "worker-1");
  assert.equal(first.turn?.turnId, urgent.turn.turnId);
  context.queue.markRunning(urgent.turn.turnId, "worker-1");
  context.queue.completeSuccess(urgent.turn.turnId, "worker-1", {
    providerSessionId: "thread-1",
    finalResponse: "urgent done",
  });
  const second = context.queue.claimNext(context.agentId, "worker-1");
  assert.equal(second.turn?.turnId, normal.turn.turnId);
  assert.equal(second.turn?.providerSessionIdBefore, "thread-1");
  context.queue.markRunning(normal.turn.turnId, "worker-1");
  context.queue.completeFailure(normal.turn.turnId, "worker-1", new Error("provider failed"));
  context.queue.releaseLease(context.agentId, "worker-1");
  assert.equal(context.store.get(context.agentId)?.status, "error");

  const recovery = context.queue.enqueue({
    agentId: context.agentId,
    sourceKind: "cli",
    idempotencyKey: "recovery-1",
    kind: "instruction",
    body: "recover",
  });
  context.queue.resumeAfterFailure(
    context.agentId,
    "Retry after inspecting the failed provider turn.",
  );
  assert.equal(context.queue.acquireLease(context.agentId, "worker-3").acquired, true);
  assert.equal(
    context.queue.claimNext(context.agentId, "worker-3").turn?.turnId,
    recovery.turn.turnId,
  );
  context.queue.markRunning(recovery.turn.turnId, "worker-3");
  context.queue.completeSuccess(recovery.turn.turnId, "worker-3", {
    providerSessionId: "thread-1",
    finalResponse: "recovered",
  });
  context.queue.releaseLease(context.agentId, "worker-3");
  assert.equal(context.store.get(context.agentId)?.status, "idle");
});

test("idle release closes the enqueue race without losing newly queued work", async (t) => {
  const context = await fixture(t);
  context.queue.acquireLease(context.agentId, "worker-race");
  assert.equal(
    context.queue.claimNext(context.agentId, "worker-race").state,
    "empty",
  );
  const turn = context.queue.enqueue({
    agentId: context.agentId,
    sourceKind: "cli",
    idempotencyKey: "arrived-before-release",
    kind: "instruction",
    body: "newly queued work",
  }).turn;
  assert.equal(
    context.queue.releaseLeaseIfIdle(context.agentId, "worker-race"),
    "work_available",
  );
  assert.equal(
    context.queue.claimNext(context.agentId, "worker-race").turn?.turnId,
    turn.turnId,
  );
});

test("queued supersession never replaces running work", async (t) => {
  const context = await fixture(t);
  const first = context.queue.enqueue({
    agentId: context.agentId,
    sourceKind: "cli",
    idempotencyKey: "first",
    kind: "instruction",
    body: "first",
  });
  const second = context.queue.enqueue({
    agentId: context.agentId,
    sourceKind: "cli",
    idempotencyKey: "second",
    kind: "instruction",
    body: "second",
  });
  assert.equal(context.queue.acquireLease(context.agentId, "worker-1").acquired, true);
  context.queue.claimNext(context.agentId, "worker-1");
  context.queue.markRunning(first.turn.turnId, "worker-1");

  const replacement = context.queue.enqueue({
    agentId: context.agentId,
    sourceKind: "execution_scope",
    senderScopeRef: "bbbbbbbbbbbbbbbb",
    idempotencyKey: "replacement",
    kind: "correction",
    priority: "high",
    body: "replace pending only",
    supersedePending: true,
  });
  assert.deepEqual(replacement.supersededTurnIds, [second.turn.turnId]);
  assert.equal(context.queue.getTurn(first.turn.turnId).status, "running");
  assert.equal(context.queue.getTurn(second.turn.turnId).status, "cancelled");
  assert.equal(context.queue.getTurn(replacement.turn.turnId).status, "queued");
});

test("supersession can replace a full queued backlog but not a full active backlog", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-local-agent-supersede-limit-"));
  const store = new LocalAgentStore(root);
  const agent = store.create({
    workspaceRoot: join(root, "project"),
    profileName: "codex",
    provider: "codex",
  });
  store.update(agent.id, { status: "idle" });
  const queue = new LocalAgentTurnQueue(
    { ...queueConfig, maxPendingPerAgent: 1 },
    root,
  );
  t.after(() => {
    queue.close();
    store.close();
    return rm(root, { recursive: true, force: true });
  });

  const queued = queue.enqueue({
    agentId: agent.id,
    sourceKind: "cli",
    idempotencyKey: "queued-full",
    kind: "instruction",
    body: "queued",
  }).turn;
  const replacement = queue.enqueue({
    agentId: agent.id,
    sourceKind: "cli",
    idempotencyKey: "replacement",
    kind: "correction",
    body: "replacement",
    supersedePending: true,
  });
  assert.deepEqual(replacement.supersededTurnIds, [queued.turnId]);
  assert.equal(replacement.turn.status, "queued");

  queue.acquireLease(agent.id, "worker-limit");
  queue.claimNext(agent.id, "worker-limit");
  queue.markRunning(replacement.turn.turnId, "worker-limit");
  assert.throws(
    () => queue.enqueue({
      agentId: agent.id,
      sourceKind: "cli",
      idempotencyKey: "cannot-replace-running",
      kind: "correction",
      body: "new",
      supersedePending: true,
    }),
    /pending limit/,
  );
  assert.equal(queue.getTurn(replacement.turn.turnId).status, "running");
});

test("execution-scope idempotency keys are namespaced by sender", async (t) => {
  const context = await fixture(t);
  const first = context.queue.enqueue({
    agentId: context.agentId,
    sourceKind: "execution_scope",
    senderScopeRef: "aaaaaaaaaaaaaaaa",
    idempotencyKey: "shared-key",
    kind: "instruction",
    body: "message from A",
  });
  const second = context.queue.enqueue({
    agentId: context.agentId,
    sourceKind: "execution_scope",
    senderScopeRef: "bbbbbbbbbbbbbbbb",
    idempotencyKey: "shared-key",
    kind: "instruction",
    body: "message from B",
  });
  assert.equal(first.idempotentReplay, false);
  assert.equal(second.idempotentReplay, false);
  assert.notEqual(first.turn.turnId, second.turn.turnId);
});

test("stale claimed work requeues but stale provider execution becomes indeterminate", async (t) => {
  const context = await fixture(t);
  const turn = context.queue.enqueue({
    agentId: context.agentId,
    sourceKind: "cli",
    idempotencyKey: "stale-1",
    kind: "instruction",
    body: "work",
  }).turn;
  context.queue.acquireLease(context.agentId, "worker-1");
  context.queue.claimNext(context.agentId, "worker-1");
  context.advance(queueConfig.leaseMs + 1);
  const recoveredClaim = context.queue.acquireLease(context.agentId, "worker-2");
  assert.equal(recoveredClaim.acquired, true);
  assert.equal(recoveredClaim.recoveredClaimedCount, 1);
  assert.equal(
    context.queue.claimNext(context.agentId, "worker-2").turn?.turnId,
    turn.turnId,
  );
  context.queue.markRunning(turn.turnId, "worker-2");

  context.advance(queueConfig.leaseMs + 1);
  const recoveredRunning = context.queue.acquireLease(context.agentId, "worker-3");
  assert.deepEqual(recoveredRunning.indeterminateTurnIds, [turn.turnId]);
  assert.equal(context.queue.getTurn(turn.turnId).status, "indeterminate");
  assert.equal(context.store.get(context.agentId)?.status, "blocked");
  const blocked = context.queue.claimNext(context.agentId, "worker-3");
  assert.equal(blocked.state, "blocked");
  assert.deepEqual(blocked.blockingTurnIds, [turn.turnId]);

  const retried = context.queue.resolveIndeterminate({
    turnId: turn.turnId,
    resolution: "retry",
    note: "Owner verified the prior provider process never admitted an effect.",
  });
  assert.equal(retried.status, "queued");
  assert.equal(
    context.queue.claimNext(context.agentId, "worker-3").turn?.turnId,
    turn.turnId,
  );
});

test("long-expired leases retain recovery evidence across queue restart", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-local-agent-long-stale-"));
  let now = Date.parse("2026-08-17T00:00:00Z");
  const store = new LocalAgentStore(root);
  const agent = store.create({
    workspaceRoot: join(root, "project"),
    profileName: "codex",
    provider: "codex",
  });
  store.update(agent.id, { status: "idle" });
  const first = new LocalAgentTurnQueue(queueConfig, root, { now: () => now });
  const turn = first.enqueue({
    agentId: agent.id,
    sourceKind: "cli",
    idempotencyKey: "long-stale",
    kind: "instruction",
    body: "provider work",
  }).turn;
  first.acquireLease(agent.id, "worker-old");
  first.claimNext(agent.id, "worker-old");
  first.markRunning(turn.turnId, "worker-old");
  first.close();

  now += queueConfig.leaseMs * 10;
  const restored = new LocalAgentTurnQueue(queueConfig, root, { now: () => now });
  t.after(() => {
    restored.close();
    store.close();
    return rm(root, { recursive: true, force: true });
  });
  const recovered = restored.acquireLease(agent.id, "worker-new");
  assert.deepEqual(recovered.indeterminateTurnIds, [turn.turnId]);
  assert.equal(restored.getTurn(turn.turnId).status, "indeterminate");
});

test("orphaned active turns recover conservatively even when the lease row is missing", async (t) => {
  const context = await fixture(t);
  const turn = context.queue.enqueue({
    agentId: context.agentId,
    sourceKind: "cli",
    idempotencyKey: "orphaned-running",
    kind: "instruction",
    body: "provider work",
  }).turn;
  context.queue.acquireLease(context.agentId, "worker-orphaned");
  context.queue.claimNext(context.agentId, "worker-orphaned");
  context.queue.markRunning(turn.turnId, "worker-orphaned");

  const database = openDatabase(context.root);
  try {
    database.sqlite
      .prepare("delete from local_agent_worker_leases where agent_id = ?")
      .run(context.agentId);
  } finally {
    database.close();
  }

  const recovered = context.queue.acquireLease(context.agentId, "worker-new");
  assert.deepEqual(recovered.indeterminateTurnIds, [turn.turnId]);
  assert.equal(context.queue.getTurn(turn.turnId).status, "indeterminate");
  assert.equal(context.store.get(context.agentId)?.status, "blocked");
});

test("cancellation is monotonic and running cancellation waits for provider termination", async (t) => {
  const context = await fixture(t);
  const queued = context.queue.enqueue({
    agentId: context.agentId,
    sourceKind: "cli",
    idempotencyKey: "cancel-queued",
    kind: "instruction",
    body: "queued",
  }).turn;
  assert.equal(context.queue.requestCancel(queued.turnId, "no longer needed").status, "cancelled");

  const running = context.queue.enqueue({
    agentId: context.agentId,
    sourceKind: "cli",
    idempotencyKey: "cancel-running",
    kind: "instruction",
    body: "running",
  }).turn;
  context.queue.acquireLease(context.agentId, "worker-1");
  context.queue.claimNext(context.agentId, "worker-1");
  context.queue.markRunning(running.turnId, "worker-1");
  const requested = context.queue.requestCancel(running.turnId, "stop safely");
  assert.equal(requested.status, "cancel_requested");
  assert.equal(context.queue.cancellationRequested(running.turnId, "worker-1"), true);
  const terminal = context.queue.completeFailure(
    running.turnId,
    "worker-1",
    new Error("provider process exited after SIGINT"),
  );
  assert.equal(terminal.status, "cancelled");
  assert.equal(terminal.errorKind, "cancelled");

  const unrelated = context.queue.enqueue({
    agentId: context.agentId,
    sourceKind: "cli",
    idempotencyKey: "cancel-unrelated-failure",
    kind: "instruction",
    body: "running again",
  }).turn;
  context.queue.claimNext(context.agentId, "worker-1");
  context.queue.markRunning(unrelated.turnId, "worker-1");
  context.queue.requestCancel(unrelated.turnId, "stop if possible");
  const failed = context.queue.completeFailure(
    unrelated.turnId,
    "worker-1",
    new Error("provider authentication failed"),
  );
  assert.equal(failed.status, "failed");
  assert.equal(failed.errorKind, "Error");
});

test("failed sessions pause queued work until explicitly resumed", async (t) => {
  const context = await fixture(t);
  const failedTurn = context.queue.enqueue({
    agentId: context.agentId,
    sourceKind: "cli",
    idempotencyKey: "pause-failure",
    kind: "instruction",
    body: "first",
  }).turn;
  const queuedTurn = context.queue.enqueue({
    agentId: context.agentId,
    sourceKind: "cli",
    idempotencyKey: "pause-queued",
    kind: "instruction",
    body: "second",
  }).turn;
  context.queue.acquireLease(context.agentId, "worker-pause");
  context.queue.claimNext(context.agentId, "worker-pause");
  context.queue.markRunning(failedTurn.turnId, "worker-pause");
  context.queue.completeFailure(
    failedTurn.turnId,
    "worker-pause",
    new Error("provider unavailable"),
  );
  context.queue.releaseLease(context.agentId, "worker-pause");
  assert.equal(context.store.get(context.agentId)?.status, "error");

  context.queue.acquireLease(context.agentId, "worker-blocked");
  const blocked = context.queue.claimNext(context.agentId, "worker-blocked");
  assert.equal(blocked.state, "blocked");
  assert.deepEqual(blocked.blockingTurnIds, [failedTurn.turnId]);
  context.queue.releaseLease(context.agentId, "worker-blocked");

  const resumed = context.queue.resumeAfterFailure(
    context.agentId,
    "Provider availability was restored.",
  );
  assert.equal(resumed.queued, 1);
  assert.equal(context.store.get(context.agentId)?.status, "queued");
  assert.equal(
    context.queue.getTurn(failedTurn.turnId).resolution,
    "resume_authorized",
  );
  context.queue.acquireLease(context.agentId, "worker-resumed");
  assert.equal(
    context.queue.claimNext(context.agentId, "worker-resumed").turn?.turnId,
    queuedTurn.turnId,
  );
});

test("resume revokes a finishing failed worker without deleting the replacement lease", async (t) => {
  const context = await fixture(t);
  const failedTurn = context.queue.enqueue({
    agentId: context.agentId,
    sourceKind: "cli",
    idempotencyKey: "resume-race-failed",
    kind: "instruction",
    body: "fail",
  }).turn;
  context.queue.enqueue({
    agentId: context.agentId,
    sourceKind: "cli",
    idempotencyKey: "resume-race-queued",
    kind: "instruction",
    body: "later",
  });
  context.queue.acquireLease(context.agentId, "worker-old");
  context.queue.claimNext(context.agentId, "worker-old");
  context.queue.markRunning(failedTurn.turnId, "worker-old");
  context.queue.completeFailure(
    failedTurn.turnId,
    "worker-old",
    new Error("provider failed"),
  );

  context.queue.resumeAfterFailure(context.agentId, "Resume immediately.");
  assert.equal(context.queue.acquireLease(context.agentId, "worker-new").acquired, true);
  assert.equal(context.queue.releaseLease(context.agentId, "worker-old"), false);
  assert.equal(context.queue.summary(context.agentId).workerLeaseActive, true);
});

test("retention pins the failure that still pauses a session", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-local-agent-failure-retention-"));
  let now = Date.parse("2026-08-17T00:00:00Z");
  const store = new LocalAgentStore(root);
  const agent = store.create({
    workspaceRoot: join(root, "project"),
    profileName: "codex",
    provider: "codex",
  });
  store.update(agent.id, { status: "idle" });
  const config = { ...queueConfig, terminalRetentionMs: 1_000 };
  const queue = new LocalAgentTurnQueue(config, root, { now: () => now });
  t.after(() => {
    queue.close();
    store.close();
    return rm(root, { recursive: true, force: true });
  });

  const turn = queue.enqueue({
    agentId: agent.id,
    sourceKind: "cli",
    idempotencyKey: "retained-failure",
    kind: "instruction",
    body: "fail",
  }).turn;
  queue.acquireLease(agent.id, "worker-retention");
  queue.claimNext(agent.id, "worker-retention");
  queue.markRunning(turn.turnId, "worker-retention");
  queue.completeFailure(
    turn.turnId,
    "worker-retention",
    new Error("provider failed"),
  );
  queue.releaseLease(agent.id, "worker-retention");

  now += 2_000;
  queue.listTurns(agent.id, { includeTerminal: true });
  assert.equal(queue.getTurn(turn.turnId).status, "failed");
  queue.resumeAfterFailure(agent.id, "Failure was inspected.");

  now += 1_001;
  queue.enqueue({
    agentId: agent.id,
    sourceKind: "cli",
    idempotencyKey: "cleanup-trigger",
    kind: "instruction",
    body: "new work",
  });
  assert.throws(() => queue.getTurn(turn.turnId), /Unknown local agent turn/);
});

test("a worker that loses authority cannot admit a provider result", async (t) => {
  const context = await fixture(t);
  const turn = context.queue.enqueue({
    agentId: context.agentId,
    sourceKind: "cli",
    idempotencyKey: "lease-lost",
    kind: "instruction",
    body: "work",
  }).turn;
  context.queue.acquireLease(context.agentId, "worker-1");
  context.queue.claimNext(context.agentId, "worker-1");
  context.queue.markRunning(turn.turnId, "worker-1");
  const indeterminate = context.queue.markIndeterminate(
    turn.turnId,
    "worker-1",
    "worker_lease_lost",
    "lease disappeared before result admission",
  );
  assert.equal(indeterminate.status, "indeterminate");
  assert.equal(context.store.get(context.agentId)?.status, "blocked");
  const rejected = context.queue.completeSuccess(turn.turnId, "worker-1", {
    providerSessionId: "unsafe-session",
    finalResponse: "unsafe result",
  });
  assert.equal(rejected.status, "indeterminate");
  assert.equal(rejected.providerSessionIdAfter, "unsafe-session");
  assert.equal(rejected.finalResponse, "unsafe result");
  assert.equal(rejected.resultCharacters, "unsafe result".length);
  assert.match(rejected.resultDigestSha256 ?? "", /^[a-f0-9]{64}$/);
  assert.equal(context.store.get(context.agentId)?.providerSessionId, undefined);
});

test("succeeded reconciliation promotes candidate provider evidence without resupplying it", async (t) => {
  const context = await fixture(t);
  const turn = context.queue.enqueue({
    agentId: context.agentId,
    sourceKind: "cli",
    idempotencyKey: "candidate-promote",
    kind: "instruction",
    body: "work",
  }).turn;
  context.queue.acquireLease(context.agentId, "worker-candidate");
  context.queue.claimNext(context.agentId, "worker-candidate");
  context.queue.markRunning(turn.turnId, "worker-candidate");
  const candidate = context.queue.markIndeterminate(
    turn.turnId,
    "worker-candidate",
    "provider_result_admission_failed",
    "result returned after authority became uncertain",
    {
      providerSessionIdAfter: "candidate-session",
      finalResponse: "candidate response",
    },
  );
  context.queue.releaseLease(context.agentId, "worker-candidate");
  assert.equal(candidate.providerSessionIdAfter, "candidate-session");
  assert.equal(candidate.finalResponse, "candidate response");
  assert.equal(candidate.resultCharacters, "candidate response".length);
  assert.match(candidate.resultDigestSha256 ?? "", /^[a-f0-9]{64}$/);
  assert.equal(context.store.get(context.agentId)?.providerSessionId, undefined);

  const resolved = context.queue.resolveIndeterminate({
    turnId: turn.turnId,
    resolution: "succeeded",
    note: "Owner verified the provider result and session identity.",
  });
  assert.equal(resolved.status, "succeeded");
  assert.equal(resolved.providerSessionIdAfter, "candidate-session");
  assert.equal(resolved.finalResponse, "candidate response");
  assert.equal(context.store.get(context.agentId)?.providerSessionId, "candidate-session");
  assert.equal(context.store.get(context.agentId)?.latestResponse, "candidate response");
});

test("retry reconciliation clears candidate result evidence before replay", async (t) => {
  const context = await fixture(t);
  const turn = context.queue.enqueue({
    agentId: context.agentId,
    sourceKind: "cli",
    idempotencyKey: "candidate-retry",
    kind: "instruction",
    body: "work",
  }).turn;
  context.queue.acquireLease(context.agentId, "worker-retry-evidence");
  context.queue.claimNext(context.agentId, "worker-retry-evidence");
  context.queue.markRunning(turn.turnId, "worker-retry-evidence");
  context.queue.markIndeterminate(
    turn.turnId,
    "worker-retry-evidence",
    "provider_result_admission_failed",
    "candidate result cannot be trusted",
    {
      providerSessionIdAfter: "discarded-session",
      finalResponse: "discarded response",
    },
  );
  context.queue.releaseLease(context.agentId, "worker-retry-evidence");

  const retried = context.queue.resolveIndeterminate({
    turnId: turn.turnId,
    resolution: "retry",
    note: "Evidence shows the candidate must not be admitted.",
  });
  assert.equal(retried.status, "queued");
  assert.equal(retried.providerSessionIdAfter, undefined);
  assert.equal(retried.finalResponse, undefined);
  assert.equal(retried.resultCharacters, undefined);
  assert.equal(retried.resultDigestSha256, undefined);
});

test("terminal result admission is fenced by the live worker lease", async (t) => {
  const context = await fixture(t);
  const turn = context.queue.enqueue({
    agentId: context.agentId,
    sourceKind: "cli",
    idempotencyKey: "lease-fence",
    kind: "instruction",
    body: "work",
  }).turn;
  context.queue.acquireLease(context.agentId, "worker-1");
  context.queue.claimNext(context.agentId, "worker-1");
  context.queue.markRunning(turn.turnId, "worker-1");
  context.advance(queueConfig.leaseMs + 1);
  const fenced = context.queue.completeSuccess(turn.turnId, "worker-1", {
    providerSessionId: "late-session",
    finalResponse: "late result",
  });
  assert.equal(fenced.status, "indeterminate");
  assert.equal(fenced.providerSessionIdAfter, "late-session");
  assert.equal(fenced.finalResponse, "late result");
  assert.equal(fenced.resultCharacters, "late result".length);
  assert.match(fenced.resultDigestSha256 ?? "", /^[a-f0-9]{64}$/);
  assert.equal(context.store.get(context.agentId)?.providerSessionId, undefined);
});

test("an empty provider response can still be a successful durable turn", async (t) => {
  const context = await fixture(t);
  const turn = context.queue.enqueue({
    agentId: context.agentId,
    sourceKind: "cli",
    idempotencyKey: "empty-success",
    kind: "instruction",
    body: "perform a tool-only action",
  }).turn;
  context.queue.acquireLease(context.agentId, "worker-empty");
  context.queue.claimNext(context.agentId, "worker-empty");
  context.queue.markRunning(turn.turnId, "worker-empty");
  const completed = context.queue.completeSuccess(turn.turnId, "worker-empty", {
    providerSessionId: "session-empty",
    finalResponse: "",
  });
  assert.equal(completed.status, "succeeded");
  assert.equal(completed.finalResponse, "");
  assert.equal(completed.resultCharacters, 0);
  assert.match(completed.resultDigestSha256 ?? "", /^[a-f0-9]{64}$/);
  assert.equal(context.store.get(context.agentId)?.latestResponse, "");
});

test("queue configuration rejects unsafe lease relationships", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-local-agent-queue-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.throws(
    () => new LocalAgentTurnQueue(
      { ...queueConfig, heartbeatMs: queueConfig.leaseMs },
      root,
    ),
    /heartbeatMs must be positive and less than leaseMs/,
  );
});
