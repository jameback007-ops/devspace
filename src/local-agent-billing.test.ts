import assert from "node:assert/strict";
import test from "node:test";
import {
  assertLocalAgentBillingPolicy,
  localAgentBillingPolicy,
  parseLocalAgentBillingMode,
} from "./local-agent-billing.js";

test("subscription_only is the fail-closed default", () => {
  assert.equal(parseLocalAgentBillingMode(undefined), "subscription_only");
  assert.equal(parseLocalAgentBillingMode("subscription_only"), "subscription_only");
  assert.equal(parseLocalAgentBillingMode("payg_allowed"), "payg_allowed");
  assert.throws(
    () => parseLocalAgentBillingMode("auto"),
    /Invalid DEVSPACE_LOCAL_AGENT_BILLING_MODE: auto/,
  );
});

test("multi-provider harnesses are disabled unless PAYG is explicitly allowed", () => {
  for (const provider of ["opencode", "pi"] as const) {
    const policy = localAgentBillingPolicy(provider, "subscription_only", {});
    assert.equal(policy.allowed, false);
    assert.match(policy.reason ?? "", /does not pin it to one subscription-backed provider/);
    assert.equal(localAgentBillingPolicy(provider, "payg_allowed", {}).allowed, true);
  }
});

test("direct subscription providers reject billing-sensitive environment overrides", () => {
  const cases = [
    ["codex", "OPENAI_API_KEY"],
    ["codex", "CODEX_API_KEY"],
    ["codex", "OPENAI_BASE_URL"],
    ["claude", "ANTHROPIC_API_KEY"],
    ["claude", "ANTHROPIC_BASE_URL"],
    ["claude", "CLAUDE_CODE_USE_BEDROCK"],
    ["cursor", "CURSOR_API_KEY"],
    ["copilot", "COPILOT_PROVIDER_API_KEY"],
    ["copilot", "COPILOT_PROVIDER_BASE_URL"],
    ["copilot", "OPENROUTER_API_KEY"],
  ] as const;

  for (const [provider, variable] of cases) {
    const secret = "do-not-render-this-secret";
    const policy = localAgentBillingPolicy(provider, "subscription_only", {
      [variable]: secret,
    });
    assert.equal(policy.allowed, false);
    assert.deepEqual(policy.billingRiskVariables, [variable]);
    assert.match(policy.reason ?? "", new RegExp(variable));
    assert.doesNotMatch(policy.reason ?? "", /do-not-render-this-secret/);
    assert.throws(
      () => assertLocalAgentBillingPolicy(provider, "subscription_only", {
        [variable]: secret,
      }),
      /subscription_only/,
    );
  }
});

test("subscription auth tokens remain permitted when they are not PAYG credentials", () => {
  assert.equal(
    localAgentBillingPolicy("claude", "subscription_only", {
      CLAUDE_CODE_OAUTH_TOKEN: "subscription-oauth-token",
    }).allowed,
    true,
  );
  assert.equal(
    localAgentBillingPolicy("copilot", "subscription_only", {
      GITHUB_TOKEN: "github-copilot-user-token",
    }).allowed,
    true,
  );
});

test("payg_allowed is an explicit escape hatch", () => {
  const policy = localAgentBillingPolicy("codex", "payg_allowed", {
    OPENAI_API_KEY: "explicitly-allowed-key",
  });
  assert.equal(policy.allowed, true);
  assert.deepEqual(policy.billingRiskVariables, []);
});
