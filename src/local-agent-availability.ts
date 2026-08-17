import { spawnSync } from "node:child_process";
import { delimiter, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { removeDevspaceNodeModulesBinFromPath } from "./local-agent-path.js";
import {
  localAgentBillingPolicy,
  parseLocalAgentBillingMode,
  type LocalAgentBillingMode,
} from "./local-agent-billing.js";
import {
  LOCAL_AGENT_PROVIDERS,
  type LocalAgentProvider,
} from "./local-agent-profiles.js";

export interface LocalAgentProviderAvailability {
  name: LocalAgentProvider;
  available: boolean;
  reason?: string;
}

export function getLocalAgentProviderAvailabilitySnapshot(
  env: NodeJS.ProcessEnv = process.env,
  billingMode: LocalAgentBillingMode = parseLocalAgentBillingMode(
    env.DEVSPACE_LOCAL_AGENT_BILLING_MODE,
  ),
): LocalAgentProviderAvailability[] {
  return LOCAL_AGENT_PROVIDERS.map((provider) =>
    checkLocalAgentProviderAvailability(provider, env, billingMode)
  );
}

export function checkLocalAgentProviderAvailability(
  provider: LocalAgentProvider,
  env: NodeJS.ProcessEnv = process.env,
  billingMode: LocalAgentBillingMode = parseLocalAgentBillingMode(
    env.DEVSPACE_LOCAL_AGENT_BILLING_MODE,
  ),
): LocalAgentProviderAvailability {
  const billing = localAgentBillingPolicy(provider, billingMode, env);
  if (!billing.allowed) {
    return {
      name: provider,
      available: false,
      reason: billing.reason,
    };
  }
  switch (provider) {
    case "codex": {
      const packageResult = packageAvailability(provider, "@openai/codex-sdk");
      if (!packageResult.available || billingMode === "payg_allowed") return packageResult;
      return codexSubscriptionAvailability(env);
    }
    case "claude": {
      const packageResult = packageAvailability(provider, "@anthropic-ai/claude-agent-sdk");
      if (!packageResult.available || billingMode === "payg_allowed") return packageResult;
      return claudeSubscriptionAvailability(env);
    }
    case "opencode":
      return packageAndCommandAvailability(
        provider,
        "@opencode-ai/sdk/v2",
        "opencode",
        env,
      );
    case "pi":
      return commandAvailability(provider, env.PI_COMMAND ?? "pi", {
        env: piAvailabilityEnvironment(env),
      });
    case "cursor":
      return commandAvailability(provider, "cursor-agent");
    case "copilot":
      return commandAvailability(provider, "copilot");
  }
}

export function assertLocalAgentProviderAvailable(
  provider: LocalAgentProvider,
  env: NodeJS.ProcessEnv = process.env,
  billingMode: LocalAgentBillingMode = parseLocalAgentBillingMode(
    env.DEVSPACE_LOCAL_AGENT_BILLING_MODE,
  ),
): void {
  const availability = checkLocalAgentProviderAvailability(provider, env, billingMode);
  if (availability.available) return;
  throw new Error(
    `${provider} provider is not available: ${availability.reason ?? "provider preflight failed"}`,
  );
}

export function formatLocalAgentProviderAvailabilitySummary(
  providers: LocalAgentProviderAvailability[],
): string {
  const available = providers
    .filter((provider) => provider.available)
    .map((provider) => provider.name);
  const unavailable = providers
    .filter((provider) => !provider.available)
    .map((provider) => `${provider.name} (${provider.reason ?? "unavailable"})`);
  return [
    available.length > 0 ? `available: ${available.join(", ")}` : undefined,
    unavailable.length > 0 ? `unavailable: ${unavailable.join(", ")}` : undefined,
  ].filter(Boolean).join("; ");
}

function packageAvailability(
  provider: LocalAgentProvider,
  packageName: string,
): LocalAgentProviderAvailability {
  try {
    import.meta.resolve(packageName);
    return { name: provider, available: true };
  } catch {
    return {
      name: provider,
      available: false,
      reason: `${packageName} package not found`,
    };
  }
}

export function isCodexSubscriptionLoginStatus(output: string): boolean {
  return /^Logged in using ChatGPT\s*$/m.test(output);
}

export function isClaudeSubscriptionAuthStatus(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const status = value as Record<string, unknown>;
  return status.loggedIn === true
    && status.apiProvider === "firstParty"
    && typeof status.subscriptionType === "string"
    && status.subscriptionType.trim().length > 0;
}

function codexSubscriptionAvailability(
  env: NodeJS.ProcessEnv,
): LocalAgentProviderAvailability {
  const command = resolveCommand("codex", env);
  const invocation = command
    ? { command, args: ["login", "status"] }
    : bundledCodexInvocation();
  if (!invocation) {
    return {
      name: "codex",
      available: false,
      reason: "Codex subscription auth could not be attested because no Codex CLI status command is available",
    };
  }
  const result = spawnSync(invocation.command, invocation.args, {
    encoding: "utf8",
    env,
    windowsHide: true,
    timeout: 10_000,
  });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (result.status === 0 && isCodexSubscriptionLoginStatus(output)) {
    return { name: "codex", available: true };
  }
  return {
    name: "codex",
    available: false,
    reason:
      "Codex is not attested as logged in with a ChatGPT subscription; API-key or ambiguous auth is blocked in subscription_only mode",
  };
}

function bundledCodexInvocation(): { command: string; args: string[] } | undefined {
  try {
    const script = fileURLToPath(import.meta.resolve("@openai/codex/bin/codex.js"));
    return { command: process.execPath, args: [script, "login", "status"] };
  } catch {
    return undefined;
  }
}

function claudeSubscriptionAvailability(
  env: NodeJS.ProcessEnv,
): LocalAgentProviderAvailability {
  const command = resolveCommand(env.CLAUDE_COMMAND ?? "claude", env);
  if (!command) {
    return {
      name: "claude",
      available: false,
      reason:
        "Claude subscription auth could not be attested because the Claude CLI status command is unavailable",
    };
  }
  const result = spawnSync(command, ["auth", "status"], {
    encoding: "utf8",
    env,
    windowsHide: true,
    timeout: 10_000,
  });
  if (result.status !== 0) {
    return {
      name: "claude",
      available: false,
      reason:
        "Claude subscription auth could not be attested; Console/API or ambiguous auth is blocked in subscription_only mode",
    };
  }
  try {
    if (isClaudeSubscriptionAuthStatus(JSON.parse(result.stdout ?? ""))) {
      return { name: "claude", available: true };
    }
  } catch {
    // Fail closed below. Never surface raw auth-status output.
  }
  return {
    name: "claude",
    available: false,
    reason:
      "Claude is not attested as first-party subscription auth; Console/API or ambiguous auth is blocked in subscription_only mode",
  };
}

function packageAndCommandAvailability(
  provider: LocalAgentProvider,
  packageName: string,
  command: string,
  env: NodeJS.ProcessEnv,
): LocalAgentProviderAvailability {
  const packageResult = packageAvailability(provider, packageName);
  if (!packageResult.available) return packageResult;
  return commandAvailability(provider, command, { env });
}

function commandAvailability(
  provider: LocalAgentProvider,
  command: string,
  options: { env?: NodeJS.ProcessEnv } = {},
): LocalAgentProviderAvailability {
  const executable = resolveCommand(command, options.env);
  if (!executable) {
    return {
      name: provider,
      available: false,
      reason: `${command} executable not found`,
    };
  }

  return { name: provider, available: true };
}

function resolveCommand(command: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const commandHasPath = command.includes("/") || command.includes("\\");
  if (commandHasPath) return executableExists(command, env) ? command : undefined;

  for (const candidate of candidateCommandPaths(command, env)) {
    if (executableExists(candidate, env)) return candidate;
  }
  return undefined;
}

function candidateCommandPaths(command: string, env: NodeJS.ProcessEnv): string[] {
  const path = env.PATH;
  if (!path) return [];
  const extensions = process.platform === "win32"
    ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
      .split(";")
      .filter(Boolean)
    : [""];
  const candidates: string[] = [];
  for (const directory of path.split(delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      candidates.push(resolve(directory, `${command}${extension}`));
    }
  }
  return candidates;
}

function executableExists(command: string, env: NodeJS.ProcessEnv): boolean {
  const result = spawnSync(command, ["--version"], {
    encoding: "utf8",
    env,
    windowsHide: true,
    timeout: 5_000,
  });
  const code = typeof result.error === "object" && result.error && "code" in result.error
    ? result.error.code
    : undefined;
  return code !== "ENOENT";
}

function piAvailabilityEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (env.PI_COMMAND) return env;
  const path = env.PATH;
  if (!path) return env;
  return {
    ...env,
    PATH: removeDevspaceNodeModulesBinFromPath(path),
  };
}
