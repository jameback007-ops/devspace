import type { LocalAgentProvider } from "./local-agent-profiles.js";

export type LocalAgentBillingMode = "subscription_only" | "payg_allowed";

export interface LocalAgentBillingConfig {
  mode: LocalAgentBillingMode;
}

export interface LocalAgentBillingPolicyResult {
  allowed: boolean;
  mode: LocalAgentBillingMode;
  reason?: string;
  billingRiskVariables: string[];
}

const MULTI_PROVIDER_UNCONSTRAINED = new Set<LocalAgentProvider>([
  "opencode",
  "pi",
]);

const BILLING_RISK_VARIABLES: Partial<Record<LocalAgentProvider, readonly string[]>> = {
  codex: [
    "OPENAI_API_KEY",
    "CODEX_API_KEY",
    "OPENAI_BASE_URL",
  ],
  claude: [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
  ],
  cursor: [
    "CURSOR_API_KEY",
  ],
  copilot: [
    "COPILOT_PROVIDER_API_KEY",
    "COPILOT_PROVIDER_BASE_URL",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "AZURE_OPENAI_API_KEY",
    "GOOGLE_API_KEY",
    "GEMINI_API_KEY",
    "XAI_API_KEY",
    "OPENROUTER_API_KEY",
    "MISTRAL_API_KEY",
    "GROQ_API_KEY",
  ],
};

export function parseLocalAgentBillingMode(
  value: string | undefined,
): LocalAgentBillingMode {
  if (!value || value === "subscription_only") return "subscription_only";
  if (value === "payg_allowed") return "payg_allowed";
  throw new Error(`Invalid DEVSPACE_LOCAL_AGENT_BILLING_MODE: ${value}`);
}

export function localAgentBillingPolicy(
  provider: LocalAgentProvider,
  mode: LocalAgentBillingMode,
  env: NodeJS.ProcessEnv = process.env,
): LocalAgentBillingPolicyResult {
  if (mode === "payg_allowed") {
    return { allowed: true, mode, billingRiskVariables: [] };
  }

  if (MULTI_PROVIDER_UNCONSTRAINED.has(provider)) {
    return {
      allowed: false,
      mode,
      billingRiskVariables: [],
      reason:
        `${provider} is disabled in subscription_only mode because this DevSpace adapter does not pin it to one subscription-backed provider; it can route through pay-as-you-go credentials.`,
    };
  }

  const billingRiskVariables = (BILLING_RISK_VARIABLES[provider] ?? [])
    .filter((name) => Boolean(env[name]?.trim()));
  if (billingRiskVariables.length > 0) {
    return {
      allowed: false,
      mode,
      billingRiskVariables,
      reason:
        `${provider} is blocked in subscription_only mode because billing-sensitive environment configuration is present: ${billingRiskVariables.join(", ")}. Remove it or explicitly set DEVSPACE_LOCAL_AGENT_BILLING_MODE=payg_allowed.`,
    };
  }

  return { allowed: true, mode, billingRiskVariables: [] };
}

export function assertLocalAgentBillingPolicy(
  provider: LocalAgentProvider,
  mode: LocalAgentBillingMode,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const policy = localAgentBillingPolicy(provider, mode, env);
  if (policy.allowed) return;
  throw new Error(policy.reason ?? `${provider} is blocked by local-agent billing policy.`);
}
