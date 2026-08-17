import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig, type ServerConfig } from "./config.js";
import { openDatabase } from "./db/client.js";
import {
  LocalAgentCoordinator,
  formatLocalAgentTurnEnvelope,
  localAgentProviderSupportsContinuation,
} from "./local-agent-coordinator.js";
import type { LocalAgentRunInput, LocalAgentRunResult } from "./local-agent-runtime.js";
import { executionScopeIdentity } from "./request-meta.js";

interface CoordinatorFixture {
  root: string;
  config: ServerConfig;
  coordinator: LocalAgentCoordinator;
  launched: Array<{ agentId: string; workerId: string }>;
  providerCalls: Array<{ provider: string; input: LocalAgentRunInput }>;
}

async function fixture(
  t: test.TestContext,
  runProvider?: (
    provider: string,
    input: LocalAgentRunInput,
  ) => Promise<LocalAgentRunResult>,
): Promise<CoordinatorFixture> {
  const root = await mkdtemp(join(tmpdir(), "devspace-local-agent-coordinator-"));
  const base = loadConfig({
    DEVSPACE_CONFIG_DIR: join(root, ".config"),
    DEVSPACE_ALLOWED_ROOTS: root,
    DEVSPACE_STATE_DIR: join(root, ".state"),
    DEVSPACE_SUBAGENTS: "1",
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    PORT: "1",
  });
  const config: ServerConfig = {
    ...base,
    localAgentQueue: {
      ...base.localAgentQueue,
      leaseMs: 1_000,
      heartbeatMs: 100,
    },
  };
  const launched: Array<{ agentId: string; workerId: string }> = [];
  const providerCalls: Array<{ provider: string; input: LocalAgentRunInput }> = [];
  const coordinator = new LocalAgentCoordinator(config, {
    launchWorker: (agentId, workerId) => launched.push({ agentId, workerId }),
    assertProviderAvailable: () => undefined,
    loadProfiles: async () => [],
    runProvider: async (provider, input) => {
      providerCalls.push({ provider, input });
      if (runProvider) return runProvider(provider, input);
      const providerSessionId = input.providerSessionId ?? "provider-session-1";
      return {
        provider,
        providerSessionId,
        finalResponse: `response-${providerCalls.length}`,
        items: [],
      };
    },
  });
  t.after(async () => {
    coordinator.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, config, coordinator, launched, providerCalls };
}

function createAgent(context: CoordinatorFixture, provider = "codex") {
  const record = context.coordinator.store.create({
    workspaceId: "ws_test",
    workspaceRoot: join(context.root, "project"),
    profileName: provider,
    provider,
  });
  return context.coordinator.store.update(record.id, { status: "idle" });
}

function launchedWorkerId(
  context: CoordinatorFixture,
  index = context.launched.length - 1,
): string {
  const workerId = context.launched[index]?.workerId;
  assert.ok(workerId, `Expected launched worker at index ${index}.`);
  return workerId;
}

test("coordinator serializes priority turns and resumes the provider session", async (t) => {
  const context = await fixture(t);
  const agent = createAgent(context);
  const sender = executionScopeIdentity({ "openai/session": "supervisor-session" });
  assert.ok(sender);

  const normal = context.coordinator.enqueueExecutionMessage(sender, {
    agentId: agent.id,
    idempotencyKey: "normal",
    kind: "instruction",
    priority: "normal",
    body: "Do the normal task.",
    correlationRef: "work:normal",
  });
  const urgent = context.coordinator.enqueueExecutionMessage(sender, {
    agentId: agent.id,
    idempotencyKey: "urgent",
    kind: "correction",
    priority: "urgent",
    body: "Correct the current assumption first.",
    correlationRef: "work:urgent",
  });
  assert.equal(context.launched.length, 1);

  const worker = await context.coordinator.runWorker(
    agent.id,
    launchedWorkerId(context, 0),
  );
  assert.equal(worker.acquired, true);
  assert.deepEqual(worker.processedTurnIds, [
    urgent.turn.turnId,
    normal.turn.turnId,
  ]);
  assert.equal(context.providerCalls.length, 2);
  assert.equal(context.providerCalls[0]?.provider, "codex");
  assert.equal(context.providerCalls[0]?.input.providerSessionId, undefined);
  assert.equal(
    context.providerCalls[1]?.input.providerSessionId,
    "provider-session-1",
  );
  assert.match(
    context.providerCalls[0]?.input.prompt ?? "",
    /Kind: correction[\s\S]*Priority: urgent[\s\S]*Correct the current assumption first/,
  );
  assert.match(
    context.providerCalls[1]?.input.prompt ?? "",
    /Kind: instruction[\s\S]*Do the normal task/,
  );
  const status = context.coordinator.sessionStatus(agent.id, {
    includeRecentTurns: true,
  });
  assert.equal(status.status, "idle");
  assert.equal(status.providerSessionId, "provider-session-1");
  assert.equal(status.latestResponse, "response-2");
  assert.equal(status.queue.running, 0);
  assert.equal(context.coordinator.turnStatus(urgent.turn.turnId).status, "succeeded");
  assert.equal(context.coordinator.turnStatus(normal.turn.turnId).status, "succeeded");
});

test("queued turns snapshot provider configuration and preserve implicit idempotency", async (t) => {
  const context = await fixture(t);
  const created = context.coordinator.store.create({
    workspaceId: "ws_test",
    workspaceRoot: join(context.root, "project"),
    profileName: "codex",
    provider: "codex",
    model: "model-a",
    thinking: "medium",
  });
  const agent = context.coordinator.store.update(created.id, { status: "idle" });

  const first = context.coordinator.enqueueCliPrompt(agent.id, "first", {
    idempotencyKey: "snapshot-first",
  });
  const second = context.coordinator.enqueueCliPrompt(agent.id, "second", {
    idempotencyKey: "snapshot-second",
    model: "model-b",
    thinking: "high",
  });
  assert.equal(first.turn.model, "model-a");
  assert.equal(first.turn.thinking, "medium");
  assert.equal(second.turn.model, "model-b");
  assert.equal(second.turn.thinking, "high");
  assert.equal(context.coordinator.store.get(agent.id)?.model, "model-b");

  const replay = context.coordinator.enqueueCliPrompt(agent.id, "first", {
    idempotencyKey: "snapshot-first",
  });
  assert.equal(replay.idempotentReplay, true);
  assert.equal(replay.turn.turnId, first.turn.turnId);
  assert.equal(replay.turn.model, "model-a");
  assert.throws(
    () => context.coordinator.enqueueCliPrompt(agent.id, "first", {
      idempotencyKey: "snapshot-first",
      model: "model-c",
    }),
    /different payload/,
  );

  await context.coordinator.runWorker(agent.id, launchedWorkerId(context, 0));
  assert.deepEqual(
    context.providerCalls.map((call) => [call.input.model, call.input.thinking]),
    [
      ["model-a", "medium"],
      ["model-b", "high"],
    ],
  );
});

test("a second worker cannot overlap and running cancellation reaches the provider signal", async (t) => {
  let providerStartedResolve = (): void => undefined;
  const providerStarted = new Promise<void>((resolve) => {
    providerStartedResolve = resolve;
  });
  const context = await fixture(t, async (provider, input) => {
    providerStartedResolve();
    await new Promise<never>((_resolve, reject) => {
      input.signal?.addEventListener("abort", () => {
        const error = new Error("cancelled by test");
        error.name = "AbortError";
        reject(error);
      }, { once: true });
    });
    return {
      provider,
      providerSessionId: null,
      finalResponse: "unreachable",
      items: [],
    };
  });
  const agent = createAgent(context);
  const queued = context.coordinator.enqueueCliPrompt(agent.id, "long task");
  const firstWorker = context.coordinator.runWorker(
    agent.id,
    launchedWorkerId(context, 0),
  );
  await providerStarted;
  const secondWorker = await context.coordinator.runWorker(agent.id, "worker-2");
  assert.equal(secondWorker.acquired, false);

  const cancelRequested = context.coordinator.cancelTurn(
    queued.turn.turnId,
    "Owner requested cancellation.",
  );
  assert.equal(cancelRequested.status, "cancel_requested");
  const firstResult = await firstWorker;
  assert.deepEqual(firstResult.processedTurnIds, [queued.turn.turnId]);
  assert.equal(
    context.coordinator.turnStatus(queued.turn.turnId).status,
    "cancelled",
  );
});

test("provider failure stops the current worker and leaves later turns queued", async (t) => {
  let call = 0;
  const context = await fixture(t, async (provider) => {
    call += 1;
    if (call === 1) throw new Error("provider unavailable");
    return {
      provider,
      providerSessionId: "session-after-recovery",
      finalResponse: "later",
      items: [],
    };
  });
  const agent = createAgent(context);
  const first = context.coordinator.enqueueCliPrompt(agent.id, "first");
  const second = context.coordinator.enqueueCliPrompt(agent.id, "second");
  const result = await context.coordinator.runWorker(
    agent.id,
    launchedWorkerId(context, 0),
  );
  assert.equal(result.stoppedAfterFailure, true);
  assert.deepEqual(result.processedTurnIds, [first.turn.turnId]);
  assert.equal(context.coordinator.turnStatus(first.turn.turnId).status, "failed");
  assert.equal(context.coordinator.turnStatus(second.turn.turnId).status, "queued");
  assert.equal(context.coordinator.sessionStatus(agent.id).status, "error");
  const resumed = context.coordinator.resumeSession(
    agent.id,
    "Provider availability was restored.",
  );
  assert.equal(resumed.workerRequested, true);
  assert.equal(context.launched.length, 2);
  await context.coordinator.runWorker(agent.id, launchedWorkerId(context, 1));
  assert.equal(context.coordinator.turnStatus(second.turn.turnId).status, "succeeded");
  assert.equal(context.coordinator.sessionStatus(agent.id).status, "idle");
});

test("lease loss during provider execution becomes indeterminate instead of admitting a result", async (t) => {
  let providerStartedResolve = (): void => undefined;
  const providerStarted = new Promise<void>((resolve) => {
    providerStartedResolve = resolve;
  });
  const context = await fixture(t, async (provider, input) => {
    providerStartedResolve();
    await new Promise<never>((_resolve, reject) => {
      input.signal?.addEventListener("abort", () => {
        reject(new Error("provider stopped after lease loss"));
      }, { once: true });
    });
    return {
      provider,
      providerSessionId: "unsafe-session",
      finalResponse: "unsafe",
      items: [],
    };
  });
  const agent = createAgent(context);
  const queued = context.coordinator.enqueueCliPrompt(agent.id, "long task");
  const worker = context.coordinator.runWorker(
    agent.id,
    launchedWorkerId(context, 0),
  );
  await providerStarted;

  const database = openDatabase(context.config.stateDir);
  try {
    database.sqlite
      .prepare("delete from local_agent_worker_leases where agent_id = ?")
      .run(agent.id);
  } finally {
    database.close();
  }

  const result = await worker;
  assert.deepEqual(result.blockedTurnIds, [queued.turn.turnId]);
  assert.equal(result.processedTurnIds.length, 0);
  assert.equal(
    context.coordinator.turnStatus(queued.turn.turnId).status,
    "indeterminate",
  );
  assert.equal(context.coordinator.sessionStatus(agent.id).status, "blocked");
});

test("session resume reconciles stale active work even without a new message", async (t) => {
  const context = await fixture(t);
  const agent = createAgent(context);
  const queued = context.coordinator.enqueueCliPrompt(agent.id, "stale active task");
  const workerId = launchedWorkerId(context, 0);
  context.coordinator.queue.claimNext(agent.id, workerId);
  context.coordinator.queue.markRunning(queued.turn.turnId, workerId);

  const database = openDatabase(context.config.stateDir);
  try {
    database.sqlite
      .prepare("delete from local_agent_worker_leases where agent_id = ?")
      .run(agent.id);
  } finally {
    database.close();
  }

  const recovered = context.coordinator.resumeSession(
    agent.id,
    "Recover a worker that disappeared before reporting its result.",
  );
  assert.equal(recovered.workerRequested, false);
  assert.equal(recovered.session.status, "blocked");
  assert.equal(
    context.coordinator.turnStatus(queued.turn.turnId).status,
    "indeterminate",
  );
});

test("a provider result that cannot be durably admitted becomes indeterminate", async (t) => {
  const context = await fixture(t, async (provider) => ({
    provider,
    providerSessionId: "provider-session-too-large",
    finalResponse: "x".repeat(200_001),
    items: [],
  }));
  const agent = createAgent(context);
  const queued = context.coordinator.enqueueCliPrompt(agent.id, "produce a large result");
  const result = await context.coordinator.runWorker(
    agent.id,
    launchedWorkerId(context, 0),
  );
  assert.deepEqual(result.blockedTurnIds, [queued.turn.turnId]);
  const turn = context.coordinator.turnStatus(queued.turn.turnId);
  assert.equal(turn.status, "indeterminate");
  assert.equal(turn.errorKind, "provider_result_admission_failed");
  assert.equal(turn.providerSessionIdAfter, "provider-session-too-large");
  assert.equal(turn.finalResponse, undefined);
  assert.equal(turn.resultCharacters, 200_001);
  assert.match(turn.resultDigestSha256 ?? "", /^[a-f0-9]{64}$/);
  assert.equal(
    context.coordinator.sessionStatus(agent.id).providerSessionId,
    undefined,
  );
  assert.equal(context.coordinator.sessionStatus(agent.id).status, "blocked");
});

test("resolving an indeterminate turn starts queued work for every terminal resolution", async (t) => {
  const context = await fixture(t);
  const agent = createAgent(context);
  const first = context.coordinator.enqueueCliPrompt(agent.id, "uncertain");
  const second = context.coordinator.enqueueCliPrompt(agent.id, "later");
  const workerId = launchedWorkerId(context, 0);
  context.coordinator.queue.claimNext(agent.id, workerId);
  context.coordinator.queue.markRunning(first.turn.turnId, workerId);
  context.coordinator.queue.markIndeterminate(
    first.turn.turnId,
    workerId,
    "test_uncertain",
    "provider effect is unknown",
  );
  context.coordinator.queue.releaseLease(agent.id, workerId);

  const resolved = context.coordinator.resolveTurn(
    first.turn.turnId,
    "cancelled",
    "Owner verified the uncertain result should be abandoned.",
  );
  assert.equal(resolved.turn.status, "cancelled");
  assert.equal(resolved.workerRequested, true);
  assert.equal(context.launched.length, 2);
  await context.coordinator.runWorker(agent.id, launchedWorkerId(context, 1));
  assert.equal(context.coordinator.turnStatus(second.turn.turnId).status, "succeeded");
});

test("unsupported provider continuation is rejected without inventing resume semantics", async (t) => {
  const context = await fixture(t);
  const agent = createAgent(context, "cursor");
  const sender = executionScopeIdentity({ "openai/session": "supervisor-session" });
  assert.ok(sender);
  assert.equal(localAgentProviderSupportsContinuation("cursor"), false);
  assert.throws(
    () => context.coordinator.enqueueExecutionMessage(sender, {
      agentId: agent.id,
      idempotencyKey: "cursor-message",
      kind: "instruction",
      body: "continue",
    }),
    /does not expose a qualified provider-session continuation adapter/,
  );
  const initial = context.coordinator.enqueueCliPrompt(agent.id, "initial ACP turn");
  assert.equal(initial.turn.status, "queued");
  assert.throws(
    () => context.coordinator.enqueueCliPrompt(agent.id, "overlapping follow-up"),
    /only one initial turn may be pending/,
  );
});

test("execution message envelope is explicit and excludes hidden context claims", () => {
  const prompt = formatLocalAgentTurnEnvelope({
    schemaVersion: 1,
    turnId: "atn_0123456789abcdef0123456789abcdef",
    agentId: "agt_01234567",
    sourceKind: "execution_scope",
    senderScopeRef: "aaaaaaaaaaaaaaaa",
    kind: "question",
    priority: "high",
    body: "What evidence remains?",
    correlationRef: "work:123",
    status: "queued",
    sequence: 1,
    createdAt: "2026-08-17T00:00:00.000Z",
  });
  assert.match(prompt, /Sender scope: aaaaaaaaaaaaaaaa/);
  assert.match(prompt, /Correlation: work:123/);
  assert.match(prompt, /What evidence remains\?/);
  assert.doesNotMatch(prompt, /private reasoning|transcript/i);
});
