import assert from "node:assert/strict";
import test from "node:test";
import {
  executionScopeDigestSha256,
  executionScopeIdentity,
  executionScopeRef,
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
