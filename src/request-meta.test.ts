import assert from "node:assert/strict";
import test from "node:test";
import {
  executionScopeDigestSha256,
  executionScopeIdentity,
  executionScopeRef,
  executorDeadlineAtMs,
  executorTurnIdentity,
  executorTurnMetadata,
  executorTurnRef,
  openAiConversationScopeId,
} from "./request-meta.js";

test("undefined request metadata has no conversation scope", () => {
  assert.equal(openAiConversationScopeId(undefined), undefined);
});

test("missing session metadata has no conversation scope", () => {
  assert.equal(openAiConversationScopeId({}), undefined);
});

test("an empty session string has no conversation scope", () => {
  assert.equal(openAiConversationScopeId({ "openai/session": "" }), undefined);
});

test("a non-string session value has no conversation scope", () => {
  assert.equal(openAiConversationScopeId({ "openai/session": 42 }), undefined);
  assert.equal(openAiConversationScopeId({ "openai/session": {} }), undefined);
});

test("valid OpenAI session metadata returns the raw opaque session value", () => {
  assert.equal(
    openAiConversationScopeId({ "openai/session": "chat-session-opaque-value" }),
    "chat-session-opaque-value",
  );
});

test("unrelated metadata fields do not alter the selected conversation scope", () => {
  assert.equal(
    openAiConversationScopeId({
      "openai/session": "chat-session-opaque-value",
      "openai/subject": "user-1",
      "openai/organization": "org-1",
    }),
    "chat-session-opaque-value",
  );
});

test("execution scopes expose only a stable hashed reference", () => {
  const identity = executionScopeIdentity({
    "openai/session": "chat-session-opaque-value",
  });
  assert.deepEqual(identity, {
    scopeId: "chat-session-opaque-value",
    scopeDigestSha256: executionScopeDigestSha256("chat-session-opaque-value"),
    scopeRef: executionScopeRef("chat-session-opaque-value"),
    adapter: "openai",
  });
  assert.equal(identity?.scopeRef.length, 16);
  assert.equal(identity?.scopeRef.includes("chat-session"), false);
});

test("generic execution scope metadata wins at the provider adapter edge", () => {
  assert.deepEqual(
    executionScopeIdentity({
      "devspace/execution-scope": "generic-scope",
      "openai/session": "openai-scope",
    }),
    {
      scopeId: "generic-scope",
      scopeDigestSha256: executionScopeDigestSha256("generic-scope"),
      scopeRef: executionScopeRef("generic-scope"),
      adapter: "devspace",
    },
  );
});

test("legacy executor-window scope metadata remains a compatibility alias", () => {
  assert.deepEqual(
    executionScopeIdentity({
      "devspace/executor-window-scope": "legacy-generic-scope",
      "openai/session": "openai-scope",
    }),
    {
      scopeId: "legacy-generic-scope",
      scopeDigestSha256: executionScopeDigestSha256("legacy-generic-scope"),
      scopeRef: executionScopeRef("legacy-generic-scope"),
      adapter: "devspace",
    },
  );
});

test("executor turn identity is provider-neutral and never inferred from conversation scope", () => {
  assert.equal(
    executorTurnIdentity({ "openai/session": "conversation-only" }),
    undefined,
  );
  assert.deepEqual(
    executorTurnIdentity({
      "devspace/executor-turn": "opaque-turn-value",
      "openai/session": "conversation-only",
    }),
    {
      turnId: "opaque-turn-value",
      turnRef: executorTurnRef("opaque-turn-value"),
    },
  );
});

test("executor deadline accepts exact epoch or ISO metadata and rejects malformed values", () => {
  assert.equal(
    executorDeadlineAtMs({ "devspace/executor-deadline-ms": 1_900_000_000_000 }),
    1_900_000_000_000,
  );
  assert.equal(
    executorDeadlineAtMs({
      "devspace/executor-deadline-at": "2030-03-04T05:06:07.000Z",
    }),
    Date.parse("2030-03-04T05:06:07.000Z"),
  );
  assert.equal(
    executorDeadlineAtMs({ "devspace/executor-deadline-ms": "not-a-number" }),
    undefined,
  );
  assert.equal(
    executorDeadlineAtMs({ "devspace/executor-deadline-at": "not-a-date" }),
    undefined,
  );
});

test("executor turn metadata keeps identity and deadline independent", () => {
  assert.deepEqual(
    executorTurnMetadata({
      "devspace/executor-turn": "turn-1",
      "devspace/executor-deadline-ms": "1900000000000",
    }),
    {
      identity: {
        turnId: "turn-1",
        turnRef: executorTurnRef("turn-1"),
      },
      deadlineAtMs: 1_900_000_000_000,
    },
  );
});
