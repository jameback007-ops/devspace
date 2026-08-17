import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { openDatabase } from "./db/client.js";
import {
  ExecutionMailboxManager,
  type ExecutionMailboxConfig,
} from "./execution-mailbox.js";
import { ExecutionScopeManager } from "./execution-observability.js";
import { ProcessSessionManager } from "./process-sessions.js";
import { executionScopeIdentity, type ExecutionScopeIdentity } from "./request-meta.js";

const mailboxConfig: ExecutionMailboxConfig = {
  enabled: true,
  defaultTtlMs: 7 * 24 * 60 * 60 * 1_000,
  maxTtlMs: 30 * 24 * 60 * 60 * 1_000,
  terminalRetentionMs: 7 * 24 * 60 * 60 * 1_000,
  maxPendingPerScope: 500,
  maxBodyCharacters: 12_000,
};

interface Fixture {
  stateDir: string;
  mailbox: ExecutionMailboxManager;
  scopes: ExecutionScopeManager;
  supervisor: ExecutionScopeIdentity;
  worker: ExecutionScopeIdentity;
  outsider: ExecutionScopeIdentity;
  advance(ms: number): void;
}

async function fixture(
  t: TestContext,
  options: Partial<ExecutionMailboxConfig> = {},
): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "devspace-execution-mailbox-"));
  const stateDir = join(root, ".state");
  let now = Date.parse("2026-08-17T04:00:00Z");
  const processes = new ProcessSessionManager();
  const scopes = new ExecutionScopeManager(
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
  const mailbox = new ExecutionMailboxManager(
    { ...mailboxConfig, ...options },
    stateDir,
    { now: () => now },
  );
  const supervisor = executionScopeIdentity({
    "devspace/execution-scope": "supervisor-scope",
  });
  const worker = executionScopeIdentity({
    "devspace/execution-scope": "worker-scope",
  });
  const outsider = executionScopeIdentity({
    "devspace/execution-scope": "outsider-scope",
  });
  assert.ok(supervisor);
  assert.ok(worker);
  assert.ok(outsider);
  registerScope(scopes, supervisor);
  registerScope(scopes, worker);
  registerScope(scopes, outsider);

  t.after(async () => {
    mailbox.close();
    scopes.close();
    processes.shutdown();
    await rm(root, { recursive: true, force: true });
  });

  return {
    stateDir,
    mailbox,
    scopes,
    supervisor,
    worker,
    outsider,
    advance(ms: number) {
      now += ms;
    },
  };
}

function registerScope(
  scopes: ExecutionScopeManager,
  identity: ExecutionScopeIdentity,
): void {
  const handle = scopes.beginTool(identity, "read", { path: "README.md" });
  scopes.finishTool(handle, "succeeded");
}

test("send is idempotent and target-bound receipts advance monotonically", async (t) => {
  const context = await fixture(t);
  const sent = context.mailbox.send(context.supervisor, {
    targetScopeRef: context.worker.scopeRef,
    idempotencyKey: "correction-001",
    kind: "correction",
    priority: "high",
    body: "Stop opening a new frontier and reconcile the current effect state.",
    correlationRef: "work:AOQ-1",
  });
  assert.equal(sent.idempotentReplay, false);
  assert.equal(sent.message.state, "accepted");
  assert.equal(sent.message.senderScopeRef, context.supervisor.scopeRef);
  assert.equal(sent.message.targetScopeRef, context.worker.scopeRef);

  const replay = context.mailbox.send(context.supervisor, {
    targetScopeRef: context.worker.scopeRef,
    idempotencyKey: "correction-001",
    kind: "correction",
    priority: "high",
    body: "Stop opening a new frontier and reconcile the current effect state.",
    correlationRef: "work:AOQ-1",
  });
  assert.equal(replay.idempotentReplay, true);
  assert.equal(replay.message.messageId, sent.message.messageId);
  assert.throws(
    () => context.mailbox.send(context.supervisor, {
      targetScopeRef: context.worker.scopeRef,
      idempotencyKey: "correction-001",
      kind: "correction",
      body: "A different payload must not reuse the same key.",
    }),
    /different message payload/,
  );
  assert.throws(
    () => context.mailbox.send(context.supervisor, {
      targetScopeRef: context.supervisor.scopeRef,
      idempotencyKey: "self-message",
      kind: "notice",
      body: "No self delivery.",
    }),
    /different execution scope/,
  );

  assert.deepEqual(context.mailbox.pendingSummary(context.worker), {
    pendingCount: 1,
    unobservedCount: 1,
    highestPriority: "high",
  });
  assert.match(
    context.mailbox.pendingNotice(context.worker) ?? "",
    /1 pending message.*1 unobserved.*high/i,
  );
  assert.deepEqual(context.mailbox.inbox(context.supervisor).messages, []);

  const inbox = context.mailbox.inbox(context.worker);
  assert.equal(inbox.messages.length, 1);
  assert.equal(inbox.messages[0]?.messageId, sent.message.messageId);
  assert.equal(inbox.messages[0]?.state, "observed");
  assert.equal(inbox.messages[0]?.body, sent.message.body);
  const alreadyObservedWaiter = context.mailbox.createWaiter(context.worker.scopeRef);
  const observedWake = await Promise.race([
    alreadyObservedWaiter.promise.then(() => "woke" as const),
    new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 25)),
  ]);
  alreadyObservedWaiter.cancel();
  assert.equal(observedWake, "timeout");
  assert.equal(context.mailbox.status(context.supervisor, sent.message.messageId).state, "observed");
  assert.throws(
    () => context.mailbox.status(context.outsider, sent.message.messageId),
    /Unknown execution message/,
  );

  const acknowledged = context.mailbox.receipt(context.worker, {
    messageId: sent.message.messageId,
    state: "acknowledged",
    note: "Correction received; inspecting the effect ledger.",
  });
  assert.equal(acknowledged.state, "acknowledged");
  assert.equal(
    acknowledged.acknowledgementNote,
    "Correction received; inspecting the effect ledger.",
  );
  const acted = context.mailbox.receipt(context.worker, {
    messageId: sent.message.messageId,
    state: "acted",
    note: "Effect reconciliation completed.",
  });
  assert.equal(acted.state, "acted");
  assert.equal(acted.actedNote, "Effect reconciliation completed.");

  const repeatedAck = context.mailbox.receipt(context.worker, {
    messageId: sent.message.messageId,
    state: "acknowledged",
    note: "Must not move the state backward.",
  });
  assert.equal(repeatedAck.state, "acted");
  assert.equal(
    repeatedAck.acknowledgementNote,
    "Correction received; inspecting the effect ledger.",
  );
  assert.deepEqual(context.mailbox.pendingSummary(context.worker), {
    pendingCount: 0,
    unobservedCount: 0,
    highestPriority: undefined,
  });

  const database = openDatabase(context.stateDir);
  try {
    const receipts = database.sqlite
      .prepare(`
        select state from execution_scope_message_receipts
         where message_id = ? order by recorded_at_ms, state
      `)
      .pluck()
      .all(sent.message.messageId) as string[];
    assert.deepEqual(new Set(receipts), new Set(["observed", "acknowledged", "acted"]));
    assert.equal(receipts.length, 3);
  } finally {
    database.close();
  }
});

test("inbox orders by priority, paginates, and cannot be read cross-scope", async (t) => {
  const context = await fixture(t);
  const messages = [
    ["low", "low"],
    ["urgent", "urgent"],
    ["normal", "normal"],
    ["high", "high"],
  ] as const;
  for (const [id, priority] of messages) {
    context.mailbox.send(context.supervisor, {
      targetScopeRef: context.worker.scopeRef,
      idempotencyKey: `priority-${id}`,
      kind: "instruction",
      priority,
      body: `${priority} message`,
    });
    context.advance(1);
  }

  const first = context.mailbox.inbox(context.worker, { limit: 2 });
  assert.deepEqual(first.messages.map((message) => message.priority), ["urgent", "high"]);
  assert.equal(typeof first.nextCursor, "string");
  const second = context.mailbox.inbox(context.worker, {
    limit: 2,
    cursor: first.nextCursor,
  });
  assert.deepEqual(second.messages.map((message) => message.priority), ["normal", "low"]);
  assert.equal(second.nextCursor, undefined);
  assert.throws(
    () => context.mailbox.inbox(context.worker, { cursor: "not-a-cursor" }),
    /Invalid execution mailbox cursor/,
  );
});

test("expiry, pending limits, terminal retention, and waiter wakeups are bounded", async (t) => {
  const context = await fixture(t, {
    maxPendingPerScope: 1,
    terminalRetentionMs: 1_000,
  });
  const waiter = context.mailbox.createWaiter(context.worker.scopeRef);
  let woke = false;
  void waiter.promise.then(() => {
    woke = true;
  });
  const sent = context.mailbox.send(context.supervisor, {
    targetScopeRef: context.worker.scopeRef,
    idempotencyKey: "short-lived",
    kind: "notice",
    body: "This message expires quickly.",
    expiresInHours: 0.001,
  });
  await waiter.promise;
  assert.equal(woke, true);
  assert.throws(
    () => context.mailbox.send(context.supervisor, {
      targetScopeRef: context.worker.scopeRef,
      idempotencyKey: "overflow",
      kind: "notice",
      body: "The pending limit should reject this.",
    }),
    /pending limit/,
  );

  context.advance(4_000);
  assert.equal(context.mailbox.pendingSummary(context.worker).pendingCount, 0);
  assert.equal(context.mailbox.inbox(context.worker).messages.length, 0);
  const terminal = context.mailbox.inbox(context.worker, { includeTerminal: true });
  assert.equal(terminal.messages[0]?.state, "expired");
  assert.throws(
    () => context.mailbox.receipt(context.worker, {
      messageId: sent.message.messageId,
      state: "acknowledged",
    }),
    /Expired execution messages/,
  );

  context.advance(2_000);
  context.mailbox.pendingSummary(context.worker);
  assert.throws(
    () => context.mailbox.status(context.worker, sent.message.messageId),
    /Unknown execution message/,
  );
});

test("mailbox messages preserve retained scope addresses and disabled mode fails closed", async (t) => {
  const context = await fixture(t);
  const sent = context.mailbox.send(context.supervisor, {
    targetScopeRef: context.worker.scopeRef,
    idempotencyKey: "retain-address",
    kind: "handoff",
    body: "Keep this target address reachable while the message remains retained.",
  });
  assert.equal(sent.message.state, "accepted");

  const database = openDatabase(context.stateDir);
  try {
    database.sqlite
      .prepare("delete from execution_scope_events")
      .run();
    database.sqlite
      .prepare("update execution_scopes set last_activity_at_ms = 0")
      .run();
  } finally {
    database.close();
  }
  registerScope(context.scopes, context.outsider);
  const refs = (context.scopes.list(context.outsider, 10).scopes as Array<{
    scopeRef: string;
  }>).map((scope) => scope.scopeRef);
  assert.ok(refs.includes(context.supervisor.scopeRef));
  assert.ok(refs.includes(context.worker.scopeRef));

  const disabled = new ExecutionMailboxManager(
    { ...mailboxConfig, enabled: false },
    join(context.stateDir, "disabled"),
  );
  try {
    assert.equal(disabled.pendingNotice(context.worker), undefined);
    assert.throws(
      () => disabled.send(context.supervisor, {
        targetScopeRef: context.worker.scopeRef,
        idempotencyKey: "disabled",
        kind: "notice",
        body: "Should fail.",
      }),
      /mailbox is disabled/,
    );
  } finally {
    disabled.close();
  }
});

test("an implicit-TTL idempotent retry survives a later default-TTL change", async (t) => {
  const context = await fixture(t);
  const first = context.mailbox.send(context.supervisor, {
    targetScopeRef: context.worker.scopeRef,
    idempotencyKey: "stable-across-config-change",
    kind: "instruction",
    body: "Use the same caller payload after a configuration change.",
  });

  const restarted = new ExecutionMailboxManager(
    { ...mailboxConfig, defaultTtlMs: 24 * 60 * 60 * 1_000 },
    context.stateDir,
  );
  t.after(() => restarted.close());
  const replay = restarted.send(context.supervisor, {
    targetScopeRef: context.worker.scopeRef,
    idempotencyKey: "stable-across-config-change",
    kind: "instruction",
    body: "Use the same caller payload after a configuration change.",
  });
  assert.equal(replay.idempotentReplay, true);
  assert.equal(replay.message.messageId, first.message.messageId);
});
