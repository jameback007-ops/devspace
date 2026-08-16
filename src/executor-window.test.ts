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
});

test("window transitions from active to drain to yield required", () => {
  const { registry, advance } = fixture();
  const begun = registry.begin("conversation-1", "new_turn");
  assert.equal(begun.started, true);
  assert.equal(begun.status.phase, "active");
  assert.equal(begun.status.generation, 1);

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
  registry.begin("conversation-1", "new_turn");
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
  assert.equal(second.started, false);
  assert.equal(second.status.generation, 2);
  assert.equal(second.previousWindowId, resumed.status.windowId);
  assert.equal(
    second.previousHandoff?.nextAction,
    "Finish the transaction binding and rerun the focused test.",
  );
  assert.equal(second.status.phase, "active");
});

test("repeated begin cannot reset an active or draining window", () => {
  const { registry, advance } = fixture();
  const first = registry.begin("conversation-1", "new_turn");
  advance(95 * minute);
  const repeated = registry.begin("conversation-1", "new_turn");
  assert.equal(repeated.started, false);
  assert.equal(repeated.status.phase, "drain");
  assert.equal(repeated.status.windowId, first.status.windowId);
  assert.equal(repeated.status.generation, 1);
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
