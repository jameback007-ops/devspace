import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { expandHomePath } from "./roots.js";
import type { LoggingConfig, LogFormat, LogLevel } from "./logger.js";
import type { OAuthConfig } from "./oauth-provider.js";
import type { ExecutionObservabilityConfig } from "./execution-observability.js";
import type { ExecutionMailboxConfig } from "./execution-mailbox.js";
import type { TurnContinuityConfig } from "./turn-continuity.js";
import {
  parseLocalAgentBillingMode,
  type LocalAgentBillingConfig,
} from "./local-agent-billing.js";
import type { LocalAgentQueueConfig } from "./local-agent-queue.js";
import { devspaceAgentsDir, devspaceSkillsDir, loadDevspaceFiles } from "./user-config.js";
import { DEFAULT_DEVSPACE_MCP_SERVER_VERSION } from "./version.js";

export type ToolMode = "minimal" | "full" | "codex";
export type WidgetMode = "off" | "changes" | "full";
export type ZesResearchCycleMode = "off" | "observe" | "enforce";

export interface ZesResearchCycleConfig {
  mode: ZesResearchCycleMode;
  repositoryRoot: string;
  stateRoot: string;
  timeoutMs: number;
  trustedTraceRoots: string[];
}

export interface ToolSurfaceFreshnessConfig {
  deploymentManifestPath?: string;
  deploymentManifestDigestSha256?: string;
  sourceCommit?: string;
  sourceTree?: string;
  buildArtifactPath?: string;
  surfaceEpoch?: string;
  acceleratorProfilePath?: string;
  acceleratorProfileRef?: string;
  nativeMcpRuntimeIdentitiesPath?: string;
}
export interface SelfRepositoryPublicationConfig {
  enabled: boolean;
  effectsEnabled: boolean;
  repositoryRoot?: string;
  remoteName: string;
  branchName: string;
  expectedRemoteUrl?: string;
}

export interface ConversationTransportConfig {
  enabled: boolean;
  effectsEnabled: boolean;
  bridgeSocketPath: string;
  bridgeTimeoutMs: number;
}
const DEFAULT_OAUTH_ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
const DEFAULT_OAUTH_REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
const DEFAULT_ARTIFACT_MAX_FILE_BYTES = 100 * 1024 * 1024;
const DEFAULT_EXECUTION_OBSERVABILITY_RETENTION_HOURS = 7 * 24;
const DEFAULT_EXECUTION_OBSERVABILITY_MAX_EVENTS_PER_SCOPE = 1_000;
const DEFAULT_EXECUTION_OBSERVABILITY_IDLE_MINUTES = 5;
const DEFAULT_EXECUTION_MAILBOX_TTL_HOURS = 7 * 24;
const DEFAULT_EXECUTION_MAILBOX_MAX_TTL_HOURS = 30 * 24;
const DEFAULT_EXECUTION_MAILBOX_TERMINAL_RETENTION_HOURS = 7 * 24;
const DEFAULT_EXECUTION_MAILBOX_MAX_PENDING_PER_SCOPE = 500;
const DEFAULT_EXECUTION_MAILBOX_MAX_BODY_CHARACTERS = 12_000;
const DEFAULT_TURN_HORIZON_MINUTES = 120;
const DEFAULT_TURN_HORIZON_AWARENESS_MINUTES = 90;
const DEFAULT_TURN_HORIZON_LANDING_MINUTES = 100;
const DEFAULT_TURN_HORIZON_URGENT_MINUTES = 108;
const DEFAULT_TURN_INSTABILITY_WINDOW_MINUTES = 15;
const DEFAULT_TURN_CAPSULE_REFRESH_MINUTES = 30;
const DEFAULT_TURN_STALE_TOOL_MINUTES = 5;
const DEFAULT_TURN_STALE_PROCESS_MINUTES = 20;
const DEFAULT_RECOVERY_CAPSULE_RETENTION_HOURS = 30 * 24;
const DEFAULT_RECOVERY_CAPSULE_MAX_PER_WORKSPACE = 50;
const DEFAULT_RECOVERY_CAPSULE_MAX_CHARACTERS = 64_000;
const DEFAULT_LOCAL_AGENT_MAX_PENDING = 200;
const DEFAULT_LOCAL_AGENT_MAX_BODY_CHARACTERS = 24_000;
const DEFAULT_LOCAL_AGENT_MAX_RESPONSE_CHARACTERS = 200_000;
const DEFAULT_LOCAL_AGENT_LEASE_SECONDS = 120;
const DEFAULT_LOCAL_AGENT_HEARTBEAT_SECONDS = 15;
const DEFAULT_LOCAL_AGENT_TERMINAL_RETENTION_HOURS = 7 * 24;

export interface ServerConfig {
  host: string;
  port: number;
  oauth: OAuthConfig;
  allowedRoots: string[];
  allowedHosts: string[];
  publicBaseUrl: string;
  mcpServerVersion: string;
  toolMode: ToolMode;
  codexNavigationTools: boolean;
  widgets: WidgetMode;
  stateDir: string;
  worktreeRoot: string;
  artifactsEnabled: boolean;
  artifactMaxFileBytes: number;
  skillsEnabled: boolean;
  skillPaths: string[];
  devspaceSkillsDir: string;
  devspaceAgentsDir: string;
  workspaceSystemIndexPaths: string[];
  subagents: boolean;
  agentDir: string;
  executionObservability: ExecutionObservabilityConfig;
  executionMailbox: ExecutionMailboxConfig;
  turnContinuity: TurnContinuityConfig;
  localAgentBilling: LocalAgentBillingConfig;
  localAgentQueue: LocalAgentQueueConfig;
  zesResearchCycle: ZesResearchCycleConfig;
  toolSurfaceFreshness: ToolSurfaceFreshnessConfig;
  selfRepositoryPublication: SelfRepositoryPublicationConfig;
  conversationTransport: ConversationTransportConfig;
  logging: LoggingConfig;
}

function parsePort(value: string | number | undefined): number {
  if (value === undefined || value === "") return 7676;

  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT: ${value}`);
  }

  return port;
}

function parseAllowedRoots(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) {
    const roots = value.map((entry) => entry.trim()).filter(Boolean);
    return (roots.length > 0 ? roots : [process.cwd()]).map((root) => resolve(expandHomePath(root)));
  }

  const rawRoots =
    value
      ?.split(",")
      .map((entry) => entry.trim())
      .filter(Boolean) ?? [];

  const roots = rawRoots.length > 0 ? rawRoots : [process.cwd()];
  return roots.map((root) => resolve(expandHomePath(root)));
}

function parseAllowedHosts(value: string | string[] | undefined, derivedHosts: string[]): string[] {
  if (Array.isArray(value)) {
    return normalizeAllowedHosts(value, derivedHosts);
  }

  const rawHosts =
    value
      ?.split(",")
      .map((entry) => entry.trim())
      .filter(Boolean) ?? [];

  return normalizeAllowedHosts(rawHosts, derivedHosts);
}

function normalizeAllowedHosts(rawHosts: string[], derivedHosts: string[]): string[] {
  const hosts = rawHosts.length > 0 ? rawHosts : derivedHosts;
  if (hosts.includes("*")) return ["*"];
  return Array.from(new Set(hosts.map((host) => host.trim()).filter(Boolean)));
}

function parseBoolean(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes(value?.toLowerCase() ?? "");
}

function parseOptionalString(
  value: string | undefined,
  name: string,
  maxLength = 1_024,
): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > maxLength) {
    throw new Error(`Invalid ${name}: expected a non-empty value no longer than ${maxLength} characters`);
  }
  return trimmed;
}

function parseOptionalSha256(value: string | undefined, name: string): string | undefined {
  const parsed = parseOptionalString(value, name, 64);
  if (parsed !== undefined && !/^[a-f0-9]{64}$/.test(parsed)) {
    throw new Error(`Invalid ${name}: expected a lowercase SHA-256 digest`);
  }
  return parsed;
}

function parseOptionalAbsolutePath(value: string | undefined, name: string): string | undefined {
  const parsed = parseOptionalString(value, name, 4_096);
  return parsed === undefined ? undefined : resolve(expandHomePath(parsed));
}

function parseToolSurfaceFreshnessConfig(
  env: NodeJS.ProcessEnv,
): ToolSurfaceFreshnessConfig {
  const parsed: ToolSurfaceFreshnessConfig = {
    deploymentManifestPath: parseOptionalAbsolutePath(
      env.DEVSPACE_TOOL_SURFACE_MANIFEST,
      "DEVSPACE_TOOL_SURFACE_MANIFEST",
    ),
    deploymentManifestDigestSha256: parseOptionalSha256(
      env.DEVSPACE_TOOL_SURFACE_MANIFEST_SHA256,
      "DEVSPACE_TOOL_SURFACE_MANIFEST_SHA256",
    ),
    sourceCommit: parseOptionalString(
      env.DEVSPACE_TOOL_SURFACE_SOURCE_COMMIT,
      "DEVSPACE_TOOL_SURFACE_SOURCE_COMMIT",
    ),
    sourceTree: parseOptionalString(
      env.DEVSPACE_TOOL_SURFACE_SOURCE_TREE,
      "DEVSPACE_TOOL_SURFACE_SOURCE_TREE",
    ),
    buildArtifactPath: parseOptionalAbsolutePath(
      env.DEVSPACE_TOOL_SURFACE_BUILD_ARTIFACT,
      "DEVSPACE_TOOL_SURFACE_BUILD_ARTIFACT",
    ),
    surfaceEpoch: parseOptionalString(
      env.DEVSPACE_TOOL_SURFACE_EPOCH,
      "DEVSPACE_TOOL_SURFACE_EPOCH",
      256,
    ),
    acceleratorProfilePath: parseOptionalAbsolutePath(
      env.DEVSPACE_ACCELERATOR_PROFILE,
      "DEVSPACE_ACCELERATOR_PROFILE",
    ),
    acceleratorProfileRef: parseOptionalString(
      env.DEVSPACE_ACCELERATOR_PROFILE_REF,
      "DEVSPACE_ACCELERATOR_PROFILE_REF",
    ),
    nativeMcpRuntimeIdentitiesPath: parseOptionalAbsolutePath(
      env.DEVSPACE_NATIVE_MCP_RUNTIME_IDENTITIES,
      "DEVSPACE_NATIVE_MCP_RUNTIME_IDENTITIES",
    ),
  };
  return Object.fromEntries(
    Object.entries(parsed).filter(([, value]) => value !== undefined),
  ) as ToolSurfaceFreshnessConfig;
}

function parseSelfRepositoryPublicationConfig(
  env: NodeJS.ProcessEnv,
): SelfRepositoryPublicationConfig {
  const enabled = parseBoolean(env.DEVSPACE_SELF_REPOSITORY_PUBLICATION);
  const effectsEnabled = parseBoolean(
    env.DEVSPACE_SELF_REPOSITORY_PUBLICATION_EFFECTS,
  );
  const repositoryRoot = parseOptionalAbsolutePath(
    env.DEVSPACE_SELF_REPOSITORY_ROOT,
    "DEVSPACE_SELF_REPOSITORY_ROOT",
  );
  const remoteName = parseOptionalString(
    env.DEVSPACE_SELF_REPOSITORY_REMOTE,
    "DEVSPACE_SELF_REPOSITORY_REMOTE",
    256,
  ) ?? "owner";
  const branchName = parseOptionalString(
    env.DEVSPACE_SELF_REPOSITORY_BRANCH,
    "DEVSPACE_SELF_REPOSITORY_BRANCH",
    512,
  ) ?? "main";
  const expectedRemoteUrl = parseOptionalString(
    env.DEVSPACE_SELF_REPOSITORY_EXPECTED_REMOTE_URL,
    "DEVSPACE_SELF_REPOSITORY_EXPECTED_REMOTE_URL",
    4_096,
  );

  if (!/^[A-Za-z0-9._-]+$/.test(remoteName)) {
    throw new Error(`Invalid DEVSPACE_SELF_REPOSITORY_REMOTE: ${remoteName}`);
  }
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branchName)
    || branchName.includes("..")
    || branchName.includes("@{")
    || branchName.endsWith("/")
    || branchName.endsWith(".")
  ) {
    throw new Error(`Invalid DEVSPACE_SELF_REPOSITORY_BRANCH: ${branchName}`);
  }
  if (effectsEnabled && !enabled) {
    throw new Error(
      "DEVSPACE_SELF_REPOSITORY_PUBLICATION_EFFECTS requires DEVSPACE_SELF_REPOSITORY_PUBLICATION",
    );
  }
  if (enabled && (!repositoryRoot || !expectedRemoteUrl)) {
    throw new Error(
      "DEVSPACE_SELF_REPOSITORY_PUBLICATION requires DEVSPACE_SELF_REPOSITORY_ROOT and DEVSPACE_SELF_REPOSITORY_EXPECTED_REMOTE_URL",
    );
  }

  return {
    enabled,
    effectsEnabled,
    repositoryRoot,
    remoteName,
    branchName,
    expectedRemoteUrl,
  };
}

function parseConversationTransportConfig(
  env: NodeJS.ProcessEnv,
): ConversationTransportConfig {
  const enabled = parseBoolean(env.DEVSPACE_CONVERSATION_TRANSPORT);
  const effectsEnabled = parseBoolean(
    env.DEVSPACE_CONVERSATION_TRANSPORT_EFFECTS,
  );
  if (effectsEnabled && !enabled) {
    throw new Error(
      "DEVSPACE_CONVERSATION_TRANSPORT_EFFECTS requires DEVSPACE_CONVERSATION_TRANSPORT",
    );
  }
  return {
    enabled,
    effectsEnabled,
    bridgeSocketPath:
      parseOptionalAbsolutePath(
        env.DEVSPACE_CONVERSATION_TRANSPORT_BRIDGE_SOCKET,
        "DEVSPACE_CONVERSATION_TRANSPORT_BRIDGE_SOCKET",
      ) ?? "/run/zes-conversation-transport-bridge/bridge.sock",
    bridgeTimeoutMs: parsePositiveInteger(
      env.DEVSPACE_CONVERSATION_TRANSPORT_TIMEOUT_SECONDS,
      20,
      "DEVSPACE_CONVERSATION_TRANSPORT_TIMEOUT_SECONDS",
      120,
    ) * 1_000,
  };
}

function parseToolMode(env: NodeJS.ProcessEnv): ToolMode {
  const mode = env.DEVSPACE_TOOL_MODE;
  if (mode === "minimal" || mode === "full" || mode === "codex") return mode;
  if (mode) throw new Error(`Invalid DEVSPACE_TOOL_MODE: ${mode}`);

  if (env.DEVSPACE_MINIMAL_TOOLS !== undefined) {
    return parseBoolean(env.DEVSPACE_MINIMAL_TOOLS) ? "minimal" : "full";
  }
  return "minimal";
}

function parseLogLevel(value: string | undefined): LogLevel {
  if (!value || value === "info") return "info";
  if (["silent", "error", "warn", "debug"].includes(value)) return value as LogLevel;

  throw new Error(`Invalid DEVSPACE_LOG_LEVEL: ${value}`);
}

function parseLogFormat(value: string | undefined): LogFormat {
  if (!value || value === "json") return "json";
  if (value === "pretty") return "pretty";

  throw new Error(`Invalid DEVSPACE_LOG_FORMAT: ${value}`);
}

function parsePathList(value: string | undefined): string[] {
  return (
    value
      ?.split(",")
      .map((entry) => entry.trim())
      .filter(Boolean) ?? []
  );
}

function parseConfiguredPathList(value: unknown, name: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`Invalid ${name}: expected an array of path strings`);
  }

  return value
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseStringList(value: string | undefined, fallback: string[]): string[] {
  const entries = value
    ?.split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  return entries && entries.length > 0 ? entries : fallback;
}

function parsePositiveInteger(
  value: string | undefined,
  fallback: number,
  name: string,
  max = Number.MAX_SAFE_INTEGER,
): number {
  if (!value) return fallback;

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) {
    throw new Error(`Invalid ${name}: ${value}`);
  }

  return parsed;
}

function parseLoggingConfig(env: NodeJS.ProcessEnv): LoggingConfig {
  return {
    level: parseLogLevel(env.DEVSPACE_LOG_LEVEL),
    format: parseLogFormat(env.DEVSPACE_LOG_FORMAT),
    requests: env.DEVSPACE_LOG_REQUESTS === undefined ? true : parseBoolean(env.DEVSPACE_LOG_REQUESTS),
    assets: parseBoolean(env.DEVSPACE_LOG_ASSETS),
    toolCalls: env.DEVSPACE_LOG_TOOL_CALLS === undefined ? true : parseBoolean(env.DEVSPACE_LOG_TOOL_CALLS),
    shellCommands: parseBoolean(env.DEVSPACE_LOG_SHELL_COMMANDS),
    trustProxy: parseBoolean(env.DEVSPACE_TRUST_PROXY),
  };
}

function parseExecutionObservabilityConfig(
  env: NodeJS.ProcessEnv,
): ExecutionObservabilityConfig {
  const retentionHours = parsePositiveInteger(
    env.DEVSPACE_EXECUTION_OBSERVABILITY_RETENTION_HOURS,
    DEFAULT_EXECUTION_OBSERVABILITY_RETENTION_HOURS,
    "DEVSPACE_EXECUTION_OBSERVABILITY_RETENTION_HOURS",
    24 * 90,
  );
  const maxEventsPerScope = parsePositiveInteger(
    env.DEVSPACE_EXECUTION_OBSERVABILITY_MAX_EVENTS_PER_SCOPE,
    DEFAULT_EXECUTION_OBSERVABILITY_MAX_EVENTS_PER_SCOPE,
    "DEVSPACE_EXECUTION_OBSERVABILITY_MAX_EVENTS_PER_SCOPE",
    100_000,
  );
  const idleMinutes = parsePositiveInteger(
    env.DEVSPACE_EXECUTION_OBSERVABILITY_IDLE_MINUTES,
    DEFAULT_EXECUTION_OBSERVABILITY_IDLE_MINUTES,
    "DEVSPACE_EXECUTION_OBSERVABILITY_IDLE_MINUTES",
    24 * 60,
  );
  return {
    enabled:
      env.DEVSPACE_EXECUTION_OBSERVABILITY === undefined
        ? true
        : parseBoolean(env.DEVSPACE_EXECUTION_OBSERVABILITY),
    retentionMs: retentionHours * 60 * 60 * 1_000,
    maxEventsPerScope,
    idleAfterMs: idleMinutes * 60 * 1_000,
  };
}

function parseExecutionMailboxConfig(
  env: NodeJS.ProcessEnv,
): ExecutionMailboxConfig {
  const defaultTtlHours = parsePositiveInteger(
    env.DEVSPACE_EXECUTION_MAILBOX_DEFAULT_TTL_HOURS,
    DEFAULT_EXECUTION_MAILBOX_TTL_HOURS,
    "DEVSPACE_EXECUTION_MAILBOX_DEFAULT_TTL_HOURS",
    24 * 30,
  );
  const maxTtlHours = parsePositiveInteger(
    env.DEVSPACE_EXECUTION_MAILBOX_MAX_TTL_HOURS,
    DEFAULT_EXECUTION_MAILBOX_MAX_TTL_HOURS,
    "DEVSPACE_EXECUTION_MAILBOX_MAX_TTL_HOURS",
    24 * 365,
  );
  if (defaultTtlHours > maxTtlHours) {
    throw new Error(
      "DEVSPACE_EXECUTION_MAILBOX_DEFAULT_TTL_HOURS must not exceed DEVSPACE_EXECUTION_MAILBOX_MAX_TTL_HOURS",
    );
  }
  return {
    enabled:
      env.DEVSPACE_EXECUTION_MAILBOX === undefined
        ? true
        : parseBoolean(env.DEVSPACE_EXECUTION_MAILBOX),
    defaultTtlMs: defaultTtlHours * 60 * 60 * 1_000,
    maxTtlMs: maxTtlHours * 60 * 60 * 1_000,
    terminalRetentionMs: parsePositiveInteger(
      env.DEVSPACE_EXECUTION_MAILBOX_TERMINAL_RETENTION_HOURS,
      DEFAULT_EXECUTION_MAILBOX_TERMINAL_RETENTION_HOURS,
      "DEVSPACE_EXECUTION_MAILBOX_TERMINAL_RETENTION_HOURS",
      24 * 365,
    ) * 60 * 60 * 1_000,
    maxPendingPerScope: parsePositiveInteger(
      env.DEVSPACE_EXECUTION_MAILBOX_MAX_PENDING_PER_SCOPE,
      DEFAULT_EXECUTION_MAILBOX_MAX_PENDING_PER_SCOPE,
      "DEVSPACE_EXECUTION_MAILBOX_MAX_PENDING_PER_SCOPE",
      100_000,
    ),
    maxBodyCharacters: parsePositiveInteger(
      env.DEVSPACE_EXECUTION_MAILBOX_MAX_BODY_CHARACTERS,
      DEFAULT_EXECUTION_MAILBOX_MAX_BODY_CHARACTERS,
      "DEVSPACE_EXECUTION_MAILBOX_MAX_BODY_CHARACTERS",
      100_000,
    ),
  };
}

function parseTurnContinuityConfig(
  env: NodeJS.ProcessEnv,
): TurnContinuityConfig {
  const estimatedMinutes = parsePositiveInteger(
    env.DEVSPACE_TURN_HORIZON_MINUTES,
    DEFAULT_TURN_HORIZON_MINUTES,
    "DEVSPACE_TURN_HORIZON_MINUTES",
    24 * 60,
  );
  const awarenessMinutes = parsePositiveInteger(
    env.DEVSPACE_TURN_HORIZON_AWARENESS_MINUTES,
    DEFAULT_TURN_HORIZON_AWARENESS_MINUTES,
    "DEVSPACE_TURN_HORIZON_AWARENESS_MINUTES",
    24 * 60,
  );
  const landingMinutes = parsePositiveInteger(
    env.DEVSPACE_TURN_HORIZON_LANDING_MINUTES,
    DEFAULT_TURN_HORIZON_LANDING_MINUTES,
    "DEVSPACE_TURN_HORIZON_LANDING_MINUTES",
    24 * 60,
  );
  const urgentMinutes = parsePositiveInteger(
    env.DEVSPACE_TURN_HORIZON_URGENT_MINUTES,
    DEFAULT_TURN_HORIZON_URGENT_MINUTES,
    "DEVSPACE_TURN_HORIZON_URGENT_MINUTES",
    24 * 60,
  );
  if (awarenessMinutes >= landingMinutes) {
    throw new Error(
      "DEVSPACE_TURN_HORIZON_AWARENESS_MINUTES must be less than DEVSPACE_TURN_HORIZON_LANDING_MINUTES",
    );
  }
  if (landingMinutes >= urgentMinutes) {
    throw new Error(
      "DEVSPACE_TURN_HORIZON_LANDING_MINUTES must be less than DEVSPACE_TURN_HORIZON_URGENT_MINUTES",
    );
  }
  if (urgentMinutes >= estimatedMinutes) {
    throw new Error(
      "DEVSPACE_TURN_HORIZON_URGENT_MINUTES must be less than DEVSPACE_TURN_HORIZON_MINUTES",
    );
  }
  return {
    enabled:
      env.DEVSPACE_TURN_CONTINUITY === undefined
        ? true
        : parseBoolean(env.DEVSPACE_TURN_CONTINUITY),
    estimatedTurnMs: estimatedMinutes * 60 * 1_000,
    awarenessAfterMs: awarenessMinutes * 60 * 1_000,
    landingAfterMs: landingMinutes * 60 * 1_000,
    urgentAfterMs: urgentMinutes * 60 * 1_000,
    instabilityWindowMs: parsePositiveInteger(
      env.DEVSPACE_TURN_INSTABILITY_WINDOW_MINUTES,
      DEFAULT_TURN_INSTABILITY_WINDOW_MINUTES,
      "DEVSPACE_TURN_INSTABILITY_WINDOW_MINUTES",
      24 * 60,
    ) * 60 * 1_000,
    capsuleRefreshAfterMs: parsePositiveInteger(
      env.DEVSPACE_TURN_CAPSULE_REFRESH_MINUTES,
      DEFAULT_TURN_CAPSULE_REFRESH_MINUTES,
      "DEVSPACE_TURN_CAPSULE_REFRESH_MINUTES",
      24 * 60,
    ) * 60 * 1_000,
    staleRunningToolMs: parsePositiveInteger(
      env.DEVSPACE_TURN_STALE_TOOL_MINUTES,
      DEFAULT_TURN_STALE_TOOL_MINUTES,
      "DEVSPACE_TURN_STALE_TOOL_MINUTES",
      24 * 60,
    ) * 60 * 1_000,
    staleRunningProcessMs: parsePositiveInteger(
      env.DEVSPACE_TURN_STALE_PROCESS_MINUTES,
      DEFAULT_TURN_STALE_PROCESS_MINUTES,
      "DEVSPACE_TURN_STALE_PROCESS_MINUTES",
      24 * 60,
    ) * 60 * 1_000,
    capsuleRetentionMs: parsePositiveInteger(
      env.DEVSPACE_RECOVERY_CAPSULE_RETENTION_HOURS,
      DEFAULT_RECOVERY_CAPSULE_RETENTION_HOURS,
      "DEVSPACE_RECOVERY_CAPSULE_RETENTION_HOURS",
      24 * 365,
    ) * 60 * 60 * 1_000,
    maxCapsulesPerWorkspace: parsePositiveInteger(
      env.DEVSPACE_RECOVERY_CAPSULE_MAX_PER_WORKSPACE,
      DEFAULT_RECOVERY_CAPSULE_MAX_PER_WORKSPACE,
      "DEVSPACE_RECOVERY_CAPSULE_MAX_PER_WORKSPACE",
      10_000,
    ),
    maxCapsuleCharacters: parsePositiveInteger(
      env.DEVSPACE_RECOVERY_CAPSULE_MAX_CHARACTERS,
      DEFAULT_RECOVERY_CAPSULE_MAX_CHARACTERS,
      "DEVSPACE_RECOVERY_CAPSULE_MAX_CHARACTERS",
      1_000_000,
    ),
  };
}

function parseLocalAgentQueueConfig(env: NodeJS.ProcessEnv): LocalAgentQueueConfig {
  const leaseSeconds = parsePositiveInteger(
    env.DEVSPACE_LOCAL_AGENT_LEASE_SECONDS,
    DEFAULT_LOCAL_AGENT_LEASE_SECONDS,
    "DEVSPACE_LOCAL_AGENT_LEASE_SECONDS",
    24 * 60 * 60,
  );
  const heartbeatSeconds = parsePositiveInteger(
    env.DEVSPACE_LOCAL_AGENT_HEARTBEAT_SECONDS,
    DEFAULT_LOCAL_AGENT_HEARTBEAT_SECONDS,
    "DEVSPACE_LOCAL_AGENT_HEARTBEAT_SECONDS",
    60 * 60,
  );
  if (heartbeatSeconds >= leaseSeconds) {
    throw new Error(
      "DEVSPACE_LOCAL_AGENT_HEARTBEAT_SECONDS must be less than DEVSPACE_LOCAL_AGENT_LEASE_SECONDS",
    );
  }
  return {
    maxPendingPerAgent: parsePositiveInteger(
      env.DEVSPACE_LOCAL_AGENT_MAX_PENDING,
      DEFAULT_LOCAL_AGENT_MAX_PENDING,
      "DEVSPACE_LOCAL_AGENT_MAX_PENDING",
      100_000,
    ),
    maxBodyCharacters: parsePositiveInteger(
      env.DEVSPACE_LOCAL_AGENT_MAX_BODY_CHARACTERS,
      DEFAULT_LOCAL_AGENT_MAX_BODY_CHARACTERS,
      "DEVSPACE_LOCAL_AGENT_MAX_BODY_CHARACTERS",
      200_000,
    ),
    maxResponseCharacters: parsePositiveInteger(
      env.DEVSPACE_LOCAL_AGENT_MAX_RESPONSE_CHARACTERS,
      DEFAULT_LOCAL_AGENT_MAX_RESPONSE_CHARACTERS,
      "DEVSPACE_LOCAL_AGENT_MAX_RESPONSE_CHARACTERS",
      2_000_000,
    ),
    leaseMs: leaseSeconds * 1_000,
    heartbeatMs: heartbeatSeconds * 1_000,
    terminalRetentionMs: parsePositiveInteger(
      env.DEVSPACE_LOCAL_AGENT_TERMINAL_RETENTION_HOURS,
      DEFAULT_LOCAL_AGENT_TERMINAL_RETENTION_HOURS,
      "DEVSPACE_LOCAL_AGENT_TERMINAL_RETENTION_HOURS",
      24 * 365,
    ) * 60 * 60 * 1_000,
  };
}

function parseWidgetMode(value: string | undefined): WidgetMode {
  if (!value || value === "full") return "full";
  if (value === "off" || value === "changes") return value;

  throw new Error(`Invalid DEVSPACE_WIDGETS: ${value}`);
}

function parseZesResearchCycleMode(
  value: string | undefined,
): ZesResearchCycleMode {
  if (value === undefined || value.trim() === "" || value === "off") {
    return "off";
  }
  if (value === "observe" || value === "enforce") return value;
  throw new Error(`Invalid DEVSPACE_ZES_RESEARCH_CYCLE_MODE: ${value}`);
}

function parseRequiredSecret(value: string | undefined, name: string): string {
  const secret = value?.trim();
  if (!secret) {
    throw new Error(`${name} is required for DevSpace OAuth. Run: devspace init`);
  }
  if (secret.length < 16) {
    throw new Error(`${name} must be at least 16 characters long.`);
  }
  return secret;
}

function parseOAuthConfig(env: NodeJS.ProcessEnv, ownerToken: string | undefined): OAuthConfig {
  return {
    ownerToken: parseRequiredSecret(env.DEVSPACE_OAUTH_OWNER_TOKEN ?? ownerToken, "DEVSPACE_OAUTH_OWNER_TOKEN"),
    accessTokenTtlSeconds: parsePositiveInteger(
      env.DEVSPACE_OAUTH_ACCESS_TOKEN_TTL_SECONDS,
      DEFAULT_OAUTH_ACCESS_TOKEN_TTL_SECONDS,
      "DEVSPACE_OAUTH_ACCESS_TOKEN_TTL_SECONDS",
    ),
    refreshTokenTtlSeconds: parsePositiveInteger(
      env.DEVSPACE_OAUTH_REFRESH_TOKEN_TTL_SECONDS,
      DEFAULT_OAUTH_REFRESH_TOKEN_TTL_SECONDS,
      "DEVSPACE_OAUTH_REFRESH_TOKEN_TTL_SECONDS",
    ),
    scopes: parseStringList(env.DEVSPACE_OAUTH_SCOPES, ["devspace"]),
    allowedRedirectHosts: parseStringList(env.DEVSPACE_OAUTH_ALLOWED_REDIRECT_HOSTS, [
      "chatgpt.com",
      "localhost",
      "127.0.0.1",
    ]),
  };
}

function defaultStateDir(): string {
  return join(homedir(), ".local", "share", "devspace");
}

function defaultWorktreeRoot(): string {
  return join(homedir(), ".devspace", "worktrees");
}

function defaultAgentDir(): string {
  return join(homedir(), ".codex");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const files = loadDevspaceFiles(env);
  const host = env.HOST ?? files.config.host ?? "127.0.0.1";
  const port = parsePort(env.PORT ?? files.config.port);
  const publicBaseUrl = parsePublicBaseUrl(
    env.DEVSPACE_PUBLIC_BASE_URL ?? files.config.publicBaseUrl ?? localPublicBaseUrl(host, port),
  );
  const derivedAllowedHosts = [
    "localhost",
    "127.0.0.1",
    "::1",
    host,
    new URL(publicBaseUrl).hostname,
    ...(files.config.allowedHosts ?? []),
  ];
  const stateDir = resolve(
    expandHomePath(
      env.DEVSPACE_STATE_DIR ?? files.config.stateDir ?? defaultStateDir(),
    ),
  );
  const zesRepositoryRoot = resolve(
    expandHomePath(
      env.DEVSPACE_ZES_RESEARCH_REPOSITORY_ROOT
        ?? env.DEVSPACE_ZES_REPOSITORY_ROOT
        ?? "/srv/zes-codex/ZES-SYSTEM-BLUEPRINT",
    ),
  );

  return {
    host,
    port,
    oauth: parseOAuthConfig(env, files.auth.ownerToken),
    allowedRoots: parseAllowedRoots(env.DEVSPACE_ALLOWED_ROOTS ?? files.config.allowedRoots),
    allowedHosts: parseAllowedHosts(env.DEVSPACE_ALLOWED_HOSTS, derivedAllowedHosts),
    publicBaseUrl,
    mcpServerVersion:
      parseOptionalString(
        env.DEVSPACE_MCP_SERVER_VERSION,
        "DEVSPACE_MCP_SERVER_VERSION",
        256,
      ) ?? DEFAULT_DEVSPACE_MCP_SERVER_VERSION,
    toolMode: parseToolMode(env),
    codexNavigationTools:
      env.DEVSPACE_CODEX_NAVIGATION_TOOLS === undefined
        ? files.config.codexNavigationTools === true
        : parseBoolean(env.DEVSPACE_CODEX_NAVIGATION_TOOLS),
    widgets: parseWidgetMode(env.DEVSPACE_WIDGETS),
    stateDir,
    worktreeRoot: resolve(expandHomePath(env.DEVSPACE_WORKTREE_ROOT ?? files.config.worktreeRoot ?? defaultWorktreeRoot())),
    artifactsEnabled:
      env.DEVSPACE_ARTIFACTS === undefined
        ? files.config.artifactsEnabled === true
        : parseBoolean(env.DEVSPACE_ARTIFACTS),
    artifactMaxFileBytes: parsePositiveInteger(
      env.DEVSPACE_ARTIFACT_MAX_FILE_BYTES ?? numberConfigValue(files.config.artifactMaxFileBytes),
      DEFAULT_ARTIFACT_MAX_FILE_BYTES,
      "DEVSPACE_ARTIFACT_MAX_FILE_BYTES",
    ),
    skillsEnabled: env.DEVSPACE_SKILLS === undefined ? true : parseBoolean(env.DEVSPACE_SKILLS),
    skillPaths: parsePathList(env.DEVSPACE_SKILL_PATHS),
    devspaceSkillsDir: devspaceSkillsDir(env),
    devspaceAgentsDir: devspaceAgentsDir(env),
    workspaceSystemIndexPaths: (
      env.DEVSPACE_WORKSPACE_SYSTEM_INDEX_PATHS === undefined
        ? parseConfiguredPathList(
            files.config.workspaceSystemIndexPaths,
            "config.workspaceSystemIndexPaths",
          )
        : parsePathList(env.DEVSPACE_WORKSPACE_SYSTEM_INDEX_PATHS)
    ).map((path) => resolve(expandHomePath(path))),
    subagents:
      env.DEVSPACE_SUBAGENTS === undefined
        ? files.config.subagents === true
        : parseBoolean(env.DEVSPACE_SUBAGENTS),
    agentDir: resolve(expandHomePath(env.DEVSPACE_AGENT_DIR ?? files.config.agentDir ?? defaultAgentDir())),
    executionObservability: parseExecutionObservabilityConfig(env),
    executionMailbox: parseExecutionMailboxConfig(env),
    turnContinuity: parseTurnContinuityConfig(env),
    localAgentBilling: {
      mode: parseLocalAgentBillingMode(env.DEVSPACE_LOCAL_AGENT_BILLING_MODE),
    },
    localAgentQueue: parseLocalAgentQueueConfig(env),
    zesResearchCycle: {
      mode: parseZesResearchCycleMode(
        env.DEVSPACE_ZES_RESEARCH_CYCLE_MODE,
      ),
      repositoryRoot: zesRepositoryRoot,
      stateRoot: resolve(
        expandHomePath(
          env.DEVSPACE_ZES_RESEARCH_STATE_ROOT
            ?? join(stateDir, "zes-research-cycles"),
        ),
      ),
      timeoutMs: parsePositiveInteger(
        env.DEVSPACE_ZES_RESEARCH_TIMEOUT_SECONDS,
        60,
        "DEVSPACE_ZES_RESEARCH_TIMEOUT_SECONDS",
        300,
      ) * 1_000,
      trustedTraceRoots: parsePathList(
        env.DEVSPACE_ZES_RESEARCH_TRUSTED_TRACE_ROOTS,
      ),
    },
    toolSurfaceFreshness: parseToolSurfaceFreshnessConfig(env),
    selfRepositoryPublication: parseSelfRepositoryPublicationConfig(env),
    conversationTransport: parseConversationTransportConfig(env),
    logging: parseLoggingConfig(env),
  };
}

function numberConfigValue(value: number | undefined): string | undefined {
  return value === undefined ? undefined : String(value);
}

function parsePublicBaseUrl(value: string): string {
  const parsed = new URL(value);
  parsed.hash = "";
  parsed.search = "";
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed.toString().replace(/\/$/, "");
}

function localPublicBaseUrl(host: string, port: number): string {
  const publicHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  const formattedHost = publicHost.includes(":") && !publicHost.startsWith("[")
    ? `[${publicHost}]`
    : publicHost;
  return `http://${formattedHost}:${port}`;
}
