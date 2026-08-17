import assert from "node:assert/strict";
import test from "node:test";
import {
  ExecutorWindowRegistry,
  executorWindowBlockedText,
  executorWindowFooter,
  type ExecutorWindowConfig,
} from "./executor-window.js";

const minute = 60 * 1000;
const config: ExecutorWindowConfig = {
  enabled: true,
  drainAfterMs: 90 * minute,
  yieldAfterMs: 100 * minute,
  retentionMs: 24 * 60 * minute,
};

function fixture() {
  let now = Date.parse("2026-08-16T00:00:00Z");
  const registry = new ExecutorWindowRegistry(config, { now: () => now });
  return {
    registry,
    advance(ms: number) {
      now += ms;
    },
  };
}

test("a scoped turn begins automatically on its first substantive tool", () => {
  const { registry } = fixture();
  const status = registry.status("conversation-1");
  assert.equal(status.phase, "not_started");

  const decision = registry.beforeTool(
    "conversation-1",
    "exec_command",
    { cmd: "git status" },
    false,
  );
  assert.equal(decision.allowed, true);
  assert.equal(decision.status.phase, "active");
  assert.equal(decision.status.generation, 1);
  assert.equal(decision.status.boundarySource, "inferred");
  assert.equal(decision.status.enforcement, "advisory");
});

test("window transitions from active to drain to yield required", () => {
  const { registry, advance } = fixture();
  const begun = registry.begin("conversation-1", "new_turn", {
    turnId: "turn-1",
    boundarySource: "host_turn",
  });
  assert.equal(begun.started, true);
  assert.equal(begun.status.phase, "active");
  assert.equal(begun.status.generation, 1);
  assert.equal(begun.status.boundarySource, "host_turn");
  assert.equal(begun.status.enforcement, "hard");

  advance(89 * minute);
  assert.equal(registry.status("conversation-1").phase, "active");

  advance(1 * minute);
  const drain = registry.status("conversation-1");
  assert.equal(drain.phase, "drain");
  assert.equal(drain.yieldInMs, 10 * minute);
  assert.match(executorWindowFooter(drain), /do not open a new major frontier/i);

  advance(10 * minute);
  const required = registry.status("conversation-1");
  assert.equal(required.phase, "yield_required");
  assert.equal(required.yieldInMs, 0);
});

test("yield-required mode blocks new mutation and commands but permits landing reads", () => {
  const { registry, advance } = fixture();
  registry.begin("conversation-1", "new_turn", {
    turnId: "turn-1",
    boundarySource: "host_turn",
  });
  advance(100 * minute);

  assert.equal(
    registry.beforeTool(
      "conversation-1",
      "exec_command",
      { cmd: "git status" },
      false,
    ).allowed,
    false,
  );
  assert.equal(
    registry.beforeTool(
      "conversation-1",
      "apply_patch",
      { patch: "*** Begin Patch" },
      false,
    ).allowed,
    false,
  );
  assert.equal(
    registry.beforeTool(
      "conversation-1",
      "read",
      { path: "README.md" },
      true,
    ).allowed,
    true,
  );
  assert.equal(
    registry.beforeTool(
      "conversation-1",
      "write_stdin",
      { sessionId: 1, chars: "" },
      false,
    ).allowed,
    true,
  );
  assert.equal(
    registry.beforeTool(
      "conversation-1",
      "write_stdin",
      { sessionId: 1, chars: "\u0003" },
      false,
    ).allowed,
    true,
  );
  assert.equal(
    registry.beforeTool(
      "conversation-1",
      "write_stdin",
      { sessionId: 1, chars: "continue\n" },
      false,
    ).allowed,
    false,
  );
  assert.equal(
    registry.beforeTool(
      "conversation-1",
      "open_workspace",
      { path: "/tmp/project", mode: "checkout" },
      true,
    ).allowed,
    false,
  );
  assert.equal(
    registry.beforeTool(
      "conversation-1",
      "open_workspace",
      { path: "/tmp/project", mode: "worktree" },
      true,
    ).allowed,
    false,
  );
  assert.equal(
    registry.beforeTool(
      "conversation-1",
      "execution_scope_message_send",
      {
        targetScopeRef: "0123456789abcdef",
        idempotencyKey: "landing-handoff",
        kind: "handoff",
        body: "Continue from the persisted checkpoint.",
      },
      false,
    ).allowed,
    true,
  );
  for (const tool of [
    "local_agent_session_list",
    "local_agent_session_status",
    "local_agent_turn_status",
    "local_agent_turn_cancel",
  ]) {
    assert.equal(
      registry.beforeTool(
        "conversation-1",
        tool,
        {},
        tool !== "local_agent_turn_cancel",
      ).allowed,
      true,
      `${tool} should remain available for bounded landing/reconciliation`,
    );
  }
  for (const tool of [
    "local_agent_message_send",
    "local_agent_session_resume",
    "local_agent_turn_resolve",
  ]) {
    assert.equal(
      registry.beforeTool("conversation-1", tool, {}, false).allowed,
      false,
      `${tool} should not open new provider work after the hard landing boundary`,
    );
  }
});

test("yield records an advisory handoff and a later begin carries it forward", () => {
  const { registry } = fixture();
  const first = registry.begin("conversation-1", "new_turn");
  const yielded = registry.yield("conversation-1", {
    summary: "Root cause proven; implementation remains intentionally dirty.",
    nextAction: "Finish the transaction binding and rerun the focused test.",
    worktreeState: "intentional_dirty",
    effectState: "none",
    checkpointRefs: ["git:abc123"],
    unresolved: ["One focused test remains red."],
  });
  assert.equal(yielded.phase, "yielded");
  assert.equal(yielded.handoff?.worktreeState, "intentional_dirty");

  const resumed = registry.beforeTool(
    "conversation-1",
    "read",
    { path: "README.md" },
    true,
  );
  assert.equal(resumed.allowed, true);
  assert.equal(resumed.status.phase, "active");
  assert.equal(resumed.status.generation, 2);

  const second = registry.begin("conversation-1", "new_turn");
  assert.equal(second.started, true);
  assert.equal(second.status.generation, 3);
  assert.equal(second.previousWindowId, resumed.status.windowId);
  assert.equal(
    second.previousHandoff?.nextAction,
    "Finish the transaction binding and rerun the focused test.",
  );
  assert.equal(second.status.phase, "active");
});

test("explicit new-turn begin resets an active or draining conversation window", () => {
  const { registry, advance } = fixture();
  const first = registry.begin("conversation-1", "new_turn");
  advance(95 * minute);
  const repeated = registry.begin("conversation-1", "new_turn");
  assert.equal(repeated.started, true);
  assert.equal(repeated.status.phase, "active");
  assert.notEqual(repeated.status.windowId, first.status.windowId);
  assert.equal(repeated.status.generation, 2);
  assert.equal(repeated.status.elapsedMs, 0);
});

test("one host turn identity is idempotent and a new host turn resets automatically", () => {
  const { registry, advance } = fixture();
  const first = registry.beforeTool(
    "conversation-1",
    "exec_command",
    { cmd: "git status" },
    false,
    "turn-1",
  );
  assert.equal(first.transition, "auto_begin_host_turn");
  assert.equal(first.status.boundarySource, "host_turn");
  assert.equal(first.status.enforcement, "hard");

  advance(95 * minute);
  const sameTurn = registry.begin("conversation-1", "new_turn", {
    turnId: "turn-1",
    boundarySource: "host_turn",
  });
  assert.equal(sameTurn.started, false);
  assert.equal(sameTurn.status.phase, "drain");
  assert.equal(sameTurn.status.generation, 1);

  const nextTurn = registry.beforeTool(
    "conversation-1",
    "read",
    { path: "README.md" },
    true,
    "turn-2",
  );
  assert.equal(nextTurn.transition, "auto_begin_host_turn");
  assert.equal(nextTurn.status.phase, "active");
  assert.equal(nextTurn.status.generation, 2);
  assert.notEqual(nextTurn.status.windowId, first.status.windowId);
});

test("an exact yielded turn cannot resume substantive work under the same host turn id", () => {
  const { registry } = fixture();
  registry.begin("conversation-1", "new_turn", {
    turnId: "turn-1",
    boundarySource: "host_turn",
  });
  registry.yield(
    "conversation-1",
    {
      summary: "Turn landed safely.",
      nextAction: "Continue in the next host turn.",
      worktreeState: "clean",
      effectState: "none",
      checkpointRefs: [],
      unresolved: [],
    },
    "turn-1",
  );

  const sameTurn = registry.beforeTool(
    "conversation-1",
    "read",
    { path: "README.md" },
    true,
    "turn-1",
  );
  assert.equal(sameTurn.allowed, false);
  assert.equal(sameTurn.reason, "window_yielded");
  assert.equal(sameTurn.status.phase, "yielded");

  const nextTurn = registry.beforeTool(
    "conversation-1",
    "read",
    { path: "README.md" },
    true,
    "turn-2",
  );
  assert.equal(nextTurn.allowed, true);
  assert.equal(nextTurn.status.phase, "active");
  assert.equal(nextTurn.status.generation, 2);
});

test("an inferred fallback window rolls over instead of blocking across turns", () => {
  const { registry, advance } = fixture();
  const first = registry.beforeTool(
    "conversation-1",
    "exec_command",
    { cmd: "git status" },
    false,
  );
  assert.equal(first.status.enforcement, "advisory");
  advance(100 * minute);

  const rollover = registry.beforeTool(
    "conversation-1",
    "apply_patch",
    { patch: "*** Begin Patch" },
    false,
  );
  assert.equal(rollover.allowed, true);
  assert.equal(rollover.transition, "auto_rollover_advisory");
  assert.equal(rollover.status.phase, "active");
  assert.equal(rollover.status.generation, 2);
  assert.equal(rollover.status.enforcement, "advisory");
});

test("unscoped and disabled clients are not hard blocked", () => {
  const scoped = fixture().registry;
  assert.equal(scoped.status(undefined).phase, "unscoped");
  assert.equal(
    scoped.beforeTool(undefined, "exec_command", {}, false).allowed,
    true,
  );

  const disabled = new ExecutorWindowRegistry({ ...config, enabled: false });
  assert.equal(disabled.status("conversation-1").phase, "disabled");
  assert.equal(
    disabled.beforeTool("conversation-1", "exec_command", {}, false).allowed,
    true,
  );
});

test("invalid timing configuration fails closed", () => {
  assert.throws(
    () => new ExecutorWindowRegistry({
      ...config,
      yieldAfterMs: config.drainAfterMs,
    }),
    /yieldAfterMs must be greater/,
  );
  assert.throws(
    () => new ExecutorWindowRegistry({
      ...config,
      retentionMs: config.yieldAfterMs - 1,
    }),
    /retentionMs must be at least/,
  );
});
