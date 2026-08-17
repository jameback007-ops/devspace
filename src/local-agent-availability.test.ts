import assert from "node:assert/strict";
import {
  checkLocalAgentProviderAvailability,
  formatLocalAgentProviderAvailabilitySummary,
  getLocalAgentProviderAvailabilitySnapshot,
  isClaudeSubscriptionAuthStatus,
  isCodexSubscriptionLoginStatus,
} from "./local-agent-availability.js";

const subscriptionEnv = { ...process.env };
for (const name of [
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CURSOR_API_KEY",
  "COPILOT_PROVIDER_API_KEY",
  "COPILOT_PROVIDER_BASE_URL",
]) {
  delete subscriptionEnv[name];
}

assert.equal(isCodexSubscriptionLoginStatus("Logged in using ChatGPT\n"), true);
assert.equal(isCodexSubscriptionLoginStatus("Logged in using an API key\n"), false);
assert.equal(
  isClaudeSubscriptionAuthStatus({
    loggedIn: true,
    authMethod: "claude.ai",
    apiProvider: "firstParty",
    subscriptionType: "max",
  }),
  true,
);
assert.equal(
  isClaudeSubscriptionAuthStatus({
    loggedIn: true,
    apiProvider: "firstParty",
    subscriptionType: null,
  }),
  false,
);

{
  const availability = checkLocalAgentProviderAvailability(
    "codex",
    { ...subscriptionEnv, OPENAI_API_KEY: "billing-key" },
    "subscription_only",
  );
  assert.equal(availability.available, false);
  assert.match(availability.reason ?? "", /OPENAI_API_KEY/);
  assert.doesNotMatch(availability.reason ?? "", /billing-key/);
}

for (const provider of ["opencode", "pi"] as const) {
  const availability = checkLocalAgentProviderAvailability(
    provider,
    subscriptionEnv,
    "subscription_only",
  );
  assert.equal(availability.available, false);
  assert.match(availability.reason ?? "", /subscription_only/);
}

{
  const availability = checkLocalAgentProviderAvailability("opencode", {
    ...process.env,
    PATH: "",
  }, "payg_allowed");
  assert.equal(availability.available, false);
  assert.match(availability.reason ?? "", /opencode executable not found/);
}

{
  const availability = checkLocalAgentProviderAvailability("pi", {
    ...process.env,
    PI_COMMAND: "/definitely/missing/devspace-pi",
  }, "payg_allowed");
  assert.equal(availability.available, false);
  assert.match(availability.reason ?? "", /executable not found/);
}

{
  const snapshot = getLocalAgentProviderAvailabilitySnapshot({
    ...process.env,
    PI_COMMAND: "/definitely/missing/devspace-pi",
  }, "payg_allowed");
  assert.deepEqual(
    snapshot.map((provider) => provider.name),
    ["codex", "claude", "opencode", "pi", "cursor", "copilot"],
  );
  assert.equal(snapshot.find((provider) => provider.name === "pi")?.available, false);
}

assert.equal(
  formatLocalAgentProviderAvailabilitySummary([
    { name: "codex", available: true },
    { name: "pi", available: false, reason: "pi executable not found" },
  ]),
  "available: codex; unavailable: pi (pi executable not found)",
);
