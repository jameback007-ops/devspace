import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { ensureDevspaceDefaultSkills, resolveSubagentsFlag } from "./user-config.js";

const emptyConfigDir = mkdtempSync(join(tmpdir(), "devspace-empty-config-test-"));
const baseEnv = {
  DEVSPACE_CONFIG_DIR: emptyConfigDir,
  DEVSPACE_ALLOWED_ROOTS: process.cwd(),
  DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
};

assert.equal(loadConfig(baseEnv).widgets, "full");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_WIDGETS: "changes" }).widgets, "changes");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_WIDGETS: "full" }).widgets, "full");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_WIDGETS: "off" }).widgets, "off");
assert.equal(loadConfig(baseEnv).toolMode, "minimal");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_TOOL_MODE: "minimal" }).toolMode, "minimal");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_TOOL_MODE: "full" }).toolMode, "full");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_TOOL_MODE: "codex" }).toolMode, "codex");
assert.equal(loadConfig(baseEnv).codexNavigationTools, false);
assert.equal(loadConfig(baseEnv).mcpServerVersion, "1.0.7-zes.1");
assert.equal(
  loadConfig({
    ...baseEnv,
    DEVSPACE_MCP_SERVER_VERSION: "1.0.7-zes.2",
  }).mcpServerVersion,
  "1.0.7-zes.2",
);
assert.deepEqual(loadConfig(baseEnv).toolSurfaceFreshness, {});
assert.deepEqual(loadConfig(baseEnv).selfRepositoryPublication, {
  enabled: false,
  effectsEnabled: false,
  repositoryRoot: undefined,
  remoteName: "owner",
  branchName: "main",
  expectedRemoteUrl: undefined,
});
assert.deepEqual(loadConfig(baseEnv).conversationTransport, {
  enabled: false,
  effectsEnabled: false,
  bridgeSocketPath: "/run/zes-conversation-transport-bridge/bridge.sock",
  bridgeTimeoutMs: 20_000,
});
assert.deepEqual(
  loadConfig({
    ...baseEnv,
    DEVSPACE_CONVERSATION_TRANSPORT: "1",
    DEVSPACE_CONVERSATION_TRANSPORT_EFFECTS: "1",
    DEVSPACE_CONVERSATION_TRANSPORT_BRIDGE_SOCKET: join(
      emptyConfigDir,
      "conversation-bridge.sock",
    ),
    DEVSPACE_CONVERSATION_TRANSPORT_TIMEOUT_SECONDS: "45",
  }).conversationTransport,
  {
    enabled: true,
    effectsEnabled: true,
    bridgeSocketPath: join(emptyConfigDir, "conversation-bridge.sock"),
    bridgeTimeoutMs: 45_000,
  },
);
assert.throws(
  () => loadConfig({
    ...baseEnv,
    DEVSPACE_CONVERSATION_TRANSPORT_EFFECTS: "1",
  }),
  /requires DEVSPACE_CONVERSATION_TRANSPORT/,
);
assert.deepEqual(
  loadConfig({
    ...baseEnv,
    DEVSPACE_SELF_REPOSITORY_PUBLICATION: "1",
    DEVSPACE_SELF_REPOSITORY_PUBLICATION_EFFECTS: "1",
    DEVSPACE_SELF_REPOSITORY_ROOT: process.cwd(),
    DEVSPACE_SELF_REPOSITORY_REMOTE: "owner",
    DEVSPACE_SELF_REPOSITORY_BRANCH: "main",
    DEVSPACE_SELF_REPOSITORY_EXPECTED_REMOTE_URL:
      "https://github.com/example/devspace.git",
  }).selfRepositoryPublication,
  {
    enabled: true,
    effectsEnabled: true,
    repositoryRoot: process.cwd(),
    remoteName: "owner",
    branchName: "main",
    expectedRemoteUrl: "https://github.com/example/devspace.git",
  },
);
assert.throws(
  () => loadConfig({
    ...baseEnv,
    DEVSPACE_SELF_REPOSITORY_PUBLICATION: "1",
  }),
  /requires DEVSPACE_SELF_REPOSITORY_ROOT and DEVSPACE_SELF_REPOSITORY_EXPECTED_REMOTE_URL/,
);
assert.throws(
  () => loadConfig({
    ...baseEnv,
    DEVSPACE_SELF_REPOSITORY_PUBLICATION_EFFECTS: "1",
  }),
  /requires DEVSPACE_SELF_REPOSITORY_PUBLICATION/,
);
assert.throws(
  () => loadConfig({
    ...baseEnv,
    DEVSPACE_SELF_REPOSITORY_PUBLICATION: "1",
    DEVSPACE_SELF_REPOSITORY_ROOT: process.cwd(),
    DEVSPACE_SELF_REPOSITORY_REMOTE: "owner/main",
    DEVSPACE_SELF_REPOSITORY_EXPECTED_REMOTE_URL:
      "https://github.com/example/devspace.git",
  }),
  /Invalid DEVSPACE_SELF_REPOSITORY_REMOTE/,
);
assert.deepEqual(
  loadConfig({
    ...baseEnv,
    DEVSPACE_TOOL_SURFACE_MANIFEST: join(emptyConfigDir, "deployment.json"),
    DEVSPACE_TOOL_SURFACE_MANIFEST_SHA256: "a".repeat(64),
    DEVSPACE_TOOL_SURFACE_SOURCE_COMMIT: "commit-1",
    DEVSPACE_TOOL_SURFACE_SOURCE_TREE: "tree-1",
    DEVSPACE_TOOL_SURFACE_BUILD_ARTIFACT: join(emptyConfigDir, "dist", "server.js"),
    DEVSPACE_TOOL_SURFACE_EPOCH: "nexus:deployment-1",
    DEVSPACE_ACCELERATOR_PROFILE: join(emptyConfigDir, "accelerator.yaml"),
    DEVSPACE_ACCELERATOR_PROFILE_REF: "git:zes-main:accelerator.yaml",
    DEVSPACE_NATIVE_MCP_RUNTIME_IDENTITIES: join(emptyConfigDir, "native-mcps.json"),
  }).toolSurfaceFreshness,
  {
    deploymentManifestPath: join(emptyConfigDir, "deployment.json"),
    deploymentManifestDigestSha256: "a".repeat(64),
    sourceCommit: "commit-1",
    sourceTree: "tree-1",
    buildArtifactPath: join(emptyConfigDir, "dist", "server.js"),
    surfaceEpoch: "nexus:deployment-1",
    acceleratorProfilePath: join(emptyConfigDir, "accelerator.yaml"),
    acceleratorProfileRef: "git:zes-main:accelerator.yaml",
    nativeMcpRuntimeIdentitiesPath: join(emptyConfigDir, "native-mcps.json"),
  },
);
assert.throws(
  () => loadConfig({
    ...baseEnv,
    DEVSPACE_TOOL_SURFACE_MANIFEST_SHA256: "not-a-digest",
  }),
  /lowercase SHA-256 digest/,
);
assert.equal(
  loadConfig({ ...baseEnv, DEVSPACE_CODEX_NAVIGATION_TOOLS: "1" }).codexNavigationTools,
  true,
);
assert.equal(
  loadConfig({ ...baseEnv, DEVSPACE_CODEX_NAVIGATION_TOOLS: "0" }).codexNavigationTools,
  false,
);
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_MINIMAL_TOOLS: "0" }).toolMode, "full");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_MINIMAL_TOOLS: "1" }).toolMode, "minimal");
assert.equal(loadConfig(baseEnv).skillsEnabled, true);
assert.equal(loadConfig(baseEnv).devspaceSkillsDir, join(emptyConfigDir, "skills"));
assert.equal(loadConfig(baseEnv).devspaceAgentsDir, join(emptyConfigDir, "agents"));
assert.equal(loadConfig(baseEnv).subagents, false);
assert.equal(loadConfig(baseEnv).artifactsEnabled, false);
assert.equal(loadConfig(baseEnv).artifactMaxFileBytes, 100 * 1024 * 1024);
assert.equal("executorWindow" in loadConfig(baseEnv), false);
assert.deepEqual(loadConfig(baseEnv).executionObservability, {
  enabled: true,
  retentionMs: 7 * 24 * 60 * 60 * 1000,
  maxEventsPerScope: 1_000,
  idleAfterMs: 5 * 60 * 1000,
});
assert.deepEqual(loadConfig(baseEnv).executionMailbox, {
  enabled: true,
  defaultTtlMs: 7 * 24 * 60 * 60 * 1000,
  maxTtlMs: 30 * 24 * 60 * 60 * 1000,
  terminalRetentionMs: 7 * 24 * 60 * 60 * 1000,
  maxPendingPerScope: 500,
  maxBodyCharacters: 12_000,
});
assert.deepEqual(loadConfig(baseEnv).turnContinuity, {
  enabled: true,
  estimatedTurnMs: 120 * 60 * 1_000,
  awarenessAfterMs: 95 * 60 * 1_000,
  landingAfterMs: 110 * 60 * 1_000,
  capsuleRetentionMs: 30 * 24 * 60 * 60 * 1_000,
  maxCapsulesPerWorkspace: 50,
  maxCapsuleCharacters: 64_000,
});
assert.deepEqual(loadConfig(baseEnv).localAgentBilling, {
  mode: "subscription_only",
});
assert.deepEqual(loadConfig(baseEnv).zesResearchCycle, {
  mode: "off",
  repositoryRoot: "/srv/zes-codex/ZES-SYSTEM-BLUEPRINT",
  stateRoot: join(
    loadConfig(baseEnv).stateDir,
    "zes-research-cycles",
  ),
  timeoutMs: 60_000,
  trustedTraceRoots: [],
});
assert.deepEqual(
  loadConfig({
    ...baseEnv,
    DEVSPACE_ZES_RESEARCH_CYCLE_MODE: "enforce",
    DEVSPACE_ZES_RESEARCH_REPOSITORY_ROOT: join(emptyConfigDir, "zes"),
    DEVSPACE_ZES_RESEARCH_STATE_ROOT: join(emptyConfigDir, "research-state"),
    DEVSPACE_ZES_RESEARCH_TIMEOUT_SECONDS: "90",
    DEVSPACE_ZES_RESEARCH_TRUSTED_TRACE_ROOTS: [
      join(emptyConfigDir, "traces-a"),
      join(emptyConfigDir, "traces-b"),
    ].join(","),
  }).zesResearchCycle,
  {
    mode: "enforce",
    repositoryRoot: join(emptyConfigDir, "zes"),
    stateRoot: join(emptyConfigDir, "research-state"),
    timeoutMs: 90_000,
    trustedTraceRoots: [
      join(emptyConfigDir, "traces-a"),
      join(emptyConfigDir, "traces-b"),
    ],
  },
);
assert.throws(
  () => loadConfig({
    ...baseEnv,
    DEVSPACE_ZES_RESEARCH_CYCLE_MODE: "mandatory",
  }),
  /Invalid DEVSPACE_ZES_RESEARCH_CYCLE_MODE/,
);
assert.deepEqual(
  loadConfig({
    ...baseEnv,
    DEVSPACE_LOCAL_AGENT_BILLING_MODE: "payg_allowed",
  }).localAgentBilling,
  { mode: "payg_allowed" },
);
assert.deepEqual(loadConfig(baseEnv).localAgentQueue, {
  maxPendingPerAgent: 200,
  maxBodyCharacters: 24_000,
  maxResponseCharacters: 200_000,
  leaseMs: 120 * 1_000,
  heartbeatMs: 15 * 1_000,
  terminalRetentionMs: 7 * 24 * 60 * 60 * 1_000,
});
assert.deepEqual(
  loadConfig({
    ...baseEnv,
    DEVSPACE_LOCAL_AGENT_MAX_PENDING: "25",
    DEVSPACE_LOCAL_AGENT_MAX_BODY_CHARACTERS: "4096",
    DEVSPACE_LOCAL_AGENT_MAX_RESPONSE_CHARACTERS: "8192",
    DEVSPACE_LOCAL_AGENT_LEASE_SECONDS: "60",
    DEVSPACE_LOCAL_AGENT_HEARTBEAT_SECONDS: "5",
    DEVSPACE_LOCAL_AGENT_TERMINAL_RETENTION_HOURS: "48",
  }).localAgentQueue,
  {
    maxPendingPerAgent: 25,
    maxBodyCharacters: 4_096,
    maxResponseCharacters: 8_192,
    leaseMs: 60 * 1_000,
    heartbeatMs: 5 * 1_000,
    terminalRetentionMs: 48 * 60 * 60 * 1_000,
  },
);
assert.deepEqual(
  loadConfig({
    ...baseEnv,
    DEVSPACE_TURN_CONTINUITY: "0",
    DEVSPACE_TURN_HORIZON_MINUTES: "150",
    DEVSPACE_TURN_HORIZON_AWARENESS_MINUTES: "115",
    DEVSPACE_TURN_HORIZON_LANDING_MINUTES: "135",
    DEVSPACE_RECOVERY_CAPSULE_RETENTION_HOURS: "168",
    DEVSPACE_RECOVERY_CAPSULE_MAX_PER_WORKSPACE: "25",
    DEVSPACE_RECOVERY_CAPSULE_MAX_CHARACTERS: "32000",
  }).turnContinuity,
  {
    enabled: false,
    estimatedTurnMs: 150 * 60 * 1_000,
    awarenessAfterMs: 115 * 60 * 1_000,
    landingAfterMs: 135 * 60 * 1_000,
    capsuleRetentionMs: 168 * 60 * 60 * 1_000,
    maxCapsulesPerWorkspace: 25,
    maxCapsuleCharacters: 32_000,
  },
);
assert.deepEqual(
  loadConfig({
    ...baseEnv,
    DEVSPACE_EXECUTION_MAILBOX: "0",
    DEVSPACE_EXECUTION_MAILBOX_DEFAULT_TTL_HOURS: "12",
    DEVSPACE_EXECUTION_MAILBOX_MAX_TTL_HOURS: "24",
    DEVSPACE_EXECUTION_MAILBOX_TERMINAL_RETENTION_HOURS: "48",
    DEVSPACE_EXECUTION_MAILBOX_MAX_PENDING_PER_SCOPE: "25",
    DEVSPACE_EXECUTION_MAILBOX_MAX_BODY_CHARACTERS: "2048",
  }).executionMailbox,
  {
    enabled: false,
    defaultTtlMs: 12 * 60 * 60 * 1000,
    maxTtlMs: 24 * 60 * 60 * 1000,
    terminalRetentionMs: 48 * 60 * 60 * 1000,
    maxPendingPerScope: 25,
    maxBodyCharacters: 2_048,
  },
);
assert.deepEqual(
  loadConfig({
    ...baseEnv,
    DEVSPACE_EXECUTION_OBSERVABILITY: "0",
    DEVSPACE_EXECUTION_OBSERVABILITY_RETENTION_HOURS: "12",
    DEVSPACE_EXECUTION_OBSERVABILITY_MAX_EVENTS_PER_SCOPE: "250",
    DEVSPACE_EXECUTION_OBSERVABILITY_IDLE_MINUTES: "15",
  }).executionObservability,
  {
    enabled: false,
    retentionMs: 12 * 60 * 60 * 1000,
    maxEventsPerScope: 250,
    idleAfterMs: 15 * 60 * 1000,
  },
);
assert.equal(
  "executorWindow" in loadConfig({
    ...baseEnv,
    DEVSPACE_EXECUTOR_WINDOW: "1",
    DEVSPACE_EXECUTOR_WINDOW_DRAIN_MINUTES: "45",
    DEVSPACE_EXECUTOR_WINDOW_YIELD_MINUTES: "60",
    DEVSPACE_EXECUTOR_WINDOW_RETENTION_HOURS: "12",
  }),
  false,
);
assert.throws(
  () => loadConfig({
    ...baseEnv,
    DEVSPACE_TURN_HORIZON_AWARENESS_MINUTES: "110",
    DEVSPACE_TURN_HORIZON_LANDING_MINUTES: "110",
  }),
  /AWARENESS_MINUTES must be less than DEVSPACE_TURN_HORIZON_LANDING_MINUTES/,
);
assert.throws(
  () => loadConfig({
    ...baseEnv,
    DEVSPACE_TURN_HORIZON_MINUTES: "120",
    DEVSPACE_TURN_HORIZON_LANDING_MINUTES: "120",
  }),
  /LANDING_MINUTES must be less than DEVSPACE_TURN_HORIZON_MINUTES/,
);
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_ARTIFACTS: "1" }).artifactsEnabled, true);
assert.equal(
  loadConfig({ ...baseEnv, DEVSPACE_ARTIFACT_MAX_FILE_BYTES: "123" }).artifactMaxFileBytes,
  123,
);
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_SKILLS: "0" }).skillsEnabled, false);
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_SKILLS: "1" }).skillsEnabled, true);
assert.equal(
  loadConfig({ ...baseEnv, DEVSPACE_SUBAGENTS: "1" }).subagents,
  true,
);
assert.equal(resolveSubagentsFlag({}, {}), undefined);
assert.equal(resolveSubagentsFlag({ subagents: true }, {}), true);
assert.equal(resolveSubagentsFlag({ subagents: true }, { DEVSPACE_SUBAGENTS: "0" }), false);
assert.equal(resolveSubagentsFlag({}, { DEVSPACE_SUBAGENTS: "1" }), true);

const seededConfigDir = mkdtempSync(join(tmpdir(), "devspace-seeded-skills-test-"));
const seededSkillPaths = ensureDevspaceDefaultSkills({ DEVSPACE_CONFIG_DIR: seededConfigDir });
assert.deepEqual(seededSkillPaths, [join(seededConfigDir, "skills", "subagent-delegation", "SKILL.md")]);
assert.equal(existsSync(seededSkillPaths[0]), true);
assert.match(readFileSync(seededSkillPaths[0], "utf8"), /name: subagent-delegation/);
assert.deepEqual(ensureDevspaceDefaultSkills({ DEVSPACE_CONFIG_DIR: seededConfigDir }), []);

assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_WIDGETS: "invalid" }),
  /Invalid DEVSPACE_WIDGETS: invalid/,
);
assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_WIDGETS: "minimal" }),
  /Invalid DEVSPACE_WIDGETS: minimal/,
);
assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_WIDGETS: "write-only" }),
  /Invalid DEVSPACE_WIDGETS: write-only/,
);
assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_TOOL_MODE: "invalid" }),
  /Invalid DEVSPACE_TOOL_MODE: invalid/,
);

assert.deepEqual(loadConfig(baseEnv).logging, {
  level: "info",
  format: "json",
  requests: true,
  assets: false,
  toolCalls: true,
  shellCommands: false,
  trustProxy: false,
});

assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_LEVEL: "silent" }).logging.level, "silent");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_LEVEL: "error" }).logging.level, "error");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_LEVEL: "warn" }).logging.level, "warn");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_LEVEL: "info" }).logging.level, "info");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_LEVEL: "debug" }).logging.level, "debug");

assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_FORMAT: "json" }).logging.format, "json");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_FORMAT: "pretty" }).logging.format, "pretty");

assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_REQUESTS: "0" }).logging.requests, false);
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_ASSETS: "1" }).logging.assets, true);
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_TOOL_CALLS: "0" }).logging.toolCalls, false);
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_SHELL_COMMANDS: "1" }).logging.shellCommands, true);
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_TRUST_PROXY: "1" }).logging.trustProxy, true);

assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_LOG_LEVEL: "trace" }),
  /Invalid DEVSPACE_LOG_LEVEL: trace/,
);

assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_LOG_FORMAT: "color" }),
  /Invalid DEVSPACE_LOG_FORMAT: color/,
);

assert.equal(loadConfig(baseEnv).oauth.ownerToken, "test-owner-token-that-is-long-enough");
assert.deepEqual(loadConfig(baseEnv).oauth.scopes, ["devspace"]);
assert.deepEqual(loadConfig(baseEnv).oauth.allowedRedirectHosts, [
  "chatgpt.com",
  "localhost",
  "127.0.0.1",
]);
assert.equal(loadConfig(baseEnv).oauth.accessTokenTtlSeconds, 3600);
assert.equal(loadConfig(baseEnv).oauth.refreshTokenTtlSeconds, 2592000);

assert.deepEqual(
  loadConfig({ ...baseEnv, DEVSPACE_OAUTH_SCOPES: "devspace,admin" }).oauth.scopes,
  ["devspace", "admin"],
);
assert.deepEqual(
  loadConfig({ ...baseEnv, DEVSPACE_OAUTH_ALLOWED_REDIRECT_HOSTS: "chatgpt.com,example.com" }).oauth
    .allowedRedirectHosts,
  ["chatgpt.com", "example.com"],
);
assert.equal(
  loadConfig({ ...baseEnv, DEVSPACE_OAUTH_ACCESS_TOKEN_TTL_SECONDS: "120" }).oauth
    .accessTokenTtlSeconds,
  120,
);
assert.equal(
  loadConfig({ ...baseEnv, DEVSPACE_OAUTH_REFRESH_TOKEN_TTL_SECONDS: "240" }).oauth
    .refreshTokenTtlSeconds,
  240,
);

assert.throws(
  () => loadConfig({ DEVSPACE_CONFIG_DIR: emptyConfigDir, DEVSPACE_ALLOWED_ROOTS: process.cwd() }),
  /DEVSPACE_OAUTH_OWNER_TOKEN is required/,
);
assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_OAUTH_OWNER_TOKEN: "too-short" }),
  /DEVSPACE_OAUTH_OWNER_TOKEN must be at least 16 characters long/,
);
assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_OAUTH_ACCESS_TOKEN_TTL_SECONDS: "0" }),
  /Invalid DEVSPACE_OAUTH_ACCESS_TOKEN_TTL_SECONDS: 0/,
);
assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_ARTIFACT_MAX_FILE_BYTES: "0" }),
  /Invalid DEVSPACE_ARTIFACT_MAX_FILE_BYTES: 0/,
);
assert.throws(
  () => loadConfig({
    ...baseEnv,
    DEVSPACE_LOCAL_AGENT_BILLING_MODE: "auto",
  }),
  /Invalid DEVSPACE_LOCAL_AGENT_BILLING_MODE: auto/,
);
assert.throws(
  () => loadConfig({
    ...baseEnv,
    DEVSPACE_EXECUTION_OBSERVABILITY_MAX_EVENTS_PER_SCOPE: "0",
  }),
  /Invalid DEVSPACE_EXECUTION_OBSERVABILITY_MAX_EVENTS_PER_SCOPE: 0/,
);
assert.throws(
  () => loadConfig({
    ...baseEnv,
    DEVSPACE_EXECUTION_MAILBOX_DEFAULT_TTL_HOURS: "48",
    DEVSPACE_EXECUTION_MAILBOX_MAX_TTL_HOURS: "24",
  }),
  /DEFAULT_TTL_HOURS must not exceed/,
);
assert.throws(
  () => loadConfig({
    ...baseEnv,
    DEVSPACE_LOCAL_AGENT_LEASE_SECONDS: "10",
    DEVSPACE_LOCAL_AGENT_HEARTBEAT_SECONDS: "10",
  }),
  /HEARTBEAT_SECONDS must be less than/,
);
assert.equal(loadConfig(baseEnv).publicBaseUrl, "http://127.0.0.1:7676");
assert.deepEqual(loadConfig(baseEnv).allowedHosts, ["localhost", "127.0.0.1", "::1"]);

assert.equal(
  loadConfig({ ...baseEnv, DEVSPACE_PUBLIC_BASE_URL: "https://abc.trycloudflare.com/" }).publicBaseUrl,
  "https://abc.trycloudflare.com",
);
assert.deepEqual(
  loadConfig({ ...baseEnv, DEVSPACE_PUBLIC_BASE_URL: "https://abc.trycloudflare.com/" }).allowedHosts,
  ["localhost", "127.0.0.1", "::1", "abc.trycloudflare.com"],
);
assert.deepEqual(
  loadConfig({ ...baseEnv, DEVSPACE_ALLOWED_HOSTS: "*" }).allowedHosts,
  ["*"],
);

const configDir = mkdtempSync(join(tmpdir(), "devspace-config-test-"));
writeFileSync(
  join(configDir, "config.json"),
  JSON.stringify({
    port: 8787,
    allowedRoots: [process.cwd()],
    publicBaseUrl: "https://devspace.example.com",
    subagents: true,
    artifactsEnabled: true,
    artifactMaxFileBytes: 321,
    codexNavigationTools: true,
  }),
);
writeFileSync(
  join(configDir, "auth.json"),
  JSON.stringify({
    ownerToken: "persisted-owner-token-long-enough",
  }),
);

const fileConfig = loadConfig({ DEVSPACE_CONFIG_DIR: configDir });
assert.equal(fileConfig.port, 8787);
assert.equal(fileConfig.oauth.ownerToken, "persisted-owner-token-long-enough");
assert.equal(fileConfig.publicBaseUrl, "https://devspace.example.com");
assert.equal(fileConfig.subagents, true);
assert.equal(fileConfig.artifactsEnabled, true);
assert.equal(fileConfig.artifactMaxFileBytes, 321);
assert.equal(fileConfig.codexNavigationTools, true);
assert.deepEqual(fileConfig.allowedHosts, [
  "localhost",
  "127.0.0.1",
  "::1",
  "devspace.example.com",
]);
