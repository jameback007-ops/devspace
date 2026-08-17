import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import * as z from "zod/v4";
import type { ServerConfig } from "./config.js";

type JsonPrimitive = boolean | number | string | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

interface RuntimeCapabilityRegistryOptions {
  now?: () => number;
  instanceRef?: string;
}

interface RegisteredToolDefinition {
  title?: string;
  description?: string;
  inputSchema?: JsonValue;
  outputSchema?: JsonValue;
  annotations?: JsonValue;
}

interface CriticalToolGroupDefinition {
  configured: boolean;
  expectedTools: readonly string[];
}

const PACKAGE_VERSION = readPackageVersion();

/**
 * MCP server version is kept separate from the npm package version because the
 * ZES deployment carries executor-local additions that are not an upstream npm
 * release. The exact model-facing tool surface is identified independently by
 * a content fingerprint.
 */
export const DEVSPACE_MCP_SERVER_VERSION = `${PACKAGE_VERSION}-zes.1`;

const CRITICAL_TOOL_GROUPS = {
  executionObservability: [
    "execution_scope_list",
    "execution_scope_status",
    "execution_scope_audit",
  ],
  executionMessaging: [
    "execution_scope_message_send",
    "execution_scope_message_inbox",
    "execution_scope_message_status",
    "execution_scope_message_receipt",
  ],
  turnContinuity: [
    "turn_horizon_begin",
    "turn_horizon_status",
  ],
  recoveryCapsules: [
    "recovery_capsule_record",
    "recovery_capsule_status",
  ],
  localAgentContinuation: [
    "local_agent_session_list",
    "local_agent_session_status",
    "local_agent_session_resume",
    "local_agent_message_send",
    "local_agent_turn_status",
    "local_agent_turn_cancel",
    "local_agent_turn_resolve",
  ],
  nativeNavigation: ["grep", "glob", "ls"],
  artifactDownload: ["download_artifact"],
} as const;

/**
 * Read-only observation of the exact tools registered through the normal
 * DevSpace registration path. This registry never controls registration and is
 * deliberately not a second tool catalog or execution authority.
 */
export class RuntimeCapabilityRegistry {
  readonly startedAtMs: number;
  readonly instanceRef: string;

  private readonly tools = new Map<string, RegisteredToolDefinition>();
  private readonly now: () => number;
  private fingerprintSha256: string | undefined;

  constructor(
    private readonly config: ServerConfig,
    options: RuntimeCapabilityRegistryOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.startedAtMs = this.now();
    this.instanceRef = options.instanceRef
      ?? sha256(randomUUID()).slice(0, 16);
  }

  registerTool(name: string, toolConfig: Record<string, unknown>): void {
    // OpenAI's stateless transport creates a fresh McpServer for each POST,
    // while one RuntimeCapabilityRegistry is shared for the backend process.
    // Tool definitions are static for that process/configuration, so normalize
    // each name only once instead of rebuilding every JSON schema per tool call.
    if (this.tools.has(name)) return;
    this.tools.set(name, normalizeToolDefinition(toolConfig));
    this.fingerprintSha256 = undefined;
  }

  snapshot(): Record<string, unknown> {
    const toolEntries = Array.from(this.tools.entries())
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, definition]) => ({ name, ...definition }));
    const toolNames = toolEntries.map((entry) => entry.name);
    const safeConfiguration = this.safeConfiguration();
    const fingerprintSha256 = this.fingerprintSha256 ?? sha256(stableJson({
      schemaVersion: 1,
      mcpServerVersion: DEVSPACE_MCP_SERVER_VERSION,
      configuration: safeConfiguration,
      tools: toolEntries,
    }));
    this.fingerprintSha256 = fingerprintSha256;

    return {
      schemaVersion: 1,
      backend: {
        name: "devspace",
        implementation: "zes-nexus",
        packageVersion: PACKAGE_VERSION,
        mcpServerVersion: DEVSPACE_MCP_SERVER_VERSION,
        instanceRef: this.instanceRef,
        startedAt: new Date(this.startedAtMs).toISOString(),
        uptimeMs: Math.max(0, this.now() - this.startedAtMs),
      },
      toolSurface: {
        fingerprintSha256,
        toolCount: toolNames.length,
        toolNames,
        configuration: safeConfiguration,
        criticalToolGroups: this.criticalToolGroups(new Set(toolNames)),
      },
      clientCatalogObservation: {
        observable: false,
        freshness: "unavailable",
        reason:
          "MCP tool calls do not include the client-side cached tools/list result.",
        backendRegisteredSurfaceObservable: true,
        missingRegisteredToolDoesNotImplyBackendCapabilityAbsent: true,
        actionWhenClientLacksRegisteredTool:
          "Refresh or reconnect the MCP connector, then inspect the newly listed tool schema.",
      },
      policy: {
        authority: "executor_local_runtime_observation_only",
        controlsToolRegistration: false,
        canonicalTaskOrDecisionAuthority: false,
        transcriptCaptured: false,
        promptsCaptured: false,
        privateReasoningCaptured: false,
        credentialsCaptured: false,
      },
    };
  }

  private safeConfiguration(): Record<string, unknown> {
    return {
      toolMode: this.config.toolMode,
      widgets: this.config.widgets,
      codexNavigationTools: this.config.codexNavigationTools,
      executionObservabilityEnabled: this.config.executionObservability.enabled,
      executionMailboxEnabled: this.config.executionMailbox.enabled,
      turnContinuityEnabled: this.config.turnContinuity.enabled,
      localAgentContinuationEnabled: this.config.subagents,
      artifactDownloadConfigured: this.config.artifactsEnabled,
    };
  }

  private criticalToolGroups(
    registered: Set<string>,
  ): Record<string, unknown> {
    const groups: Record<string, CriticalToolGroupDefinition> = {
      executionObservability: {
        configured: this.config.executionObservability.enabled,
        expectedTools: CRITICAL_TOOL_GROUPS.executionObservability,
      },
      executionMessaging: {
        configured: this.config.executionMailbox.enabled,
        expectedTools: CRITICAL_TOOL_GROUPS.executionMessaging,
      },
      turnContinuity: {
        configured: this.config.turnContinuity.enabled,
        expectedTools: CRITICAL_TOOL_GROUPS.turnContinuity,
      },
      recoveryCapsules: {
        configured: this.config.turnContinuity.enabled,
        expectedTools: CRITICAL_TOOL_GROUPS.recoveryCapsules,
      },
      localAgentContinuation: {
        configured: this.config.subagents,
        expectedTools: CRITICAL_TOOL_GROUPS.localAgentContinuation,
      },
      nativeNavigation: {
        configured:
          this.config.toolMode === "full"
          || (this.config.toolMode === "codex" && this.config.codexNavigationTools),
        expectedTools: CRITICAL_TOOL_GROUPS.nativeNavigation,
      },
      artifactDownload: {
        configured: this.config.artifactsEnabled,
        expectedTools: CRITICAL_TOOL_GROUPS.artifactDownload,
      },
    };

    return Object.fromEntries(
      Object.entries(groups).map(([name, group]) => {
        const registeredTools = group.expectedTools.filter((tool) => registered.has(tool));
        return [name, {
          configured: group.configured,
          expectedTools: [...group.expectedTools],
          registeredTools,
          registrationState:
            registeredTools.length === 0
              ? "absent"
              : registeredTools.length === group.expectedTools.length
                ? "complete"
                : "partial",
          registeredComplete:
            registeredTools.length === group.expectedTools.length,
          available:
            group.configured
            && registeredTools.length === group.expectedTools.length,
        }];
      }),
    );
  }
}

function normalizeToolDefinition(
  toolConfig: Record<string, unknown>,
): RegisteredToolDefinition {
  return {
    title: typeof toolConfig.title === "string" ? toolConfig.title : undefined,
    description:
      typeof toolConfig.description === "string" ? toolConfig.description : undefined,
    inputSchema: jsonSchemaForRawShape(toolConfig.inputSchema),
    outputSchema: jsonSchemaForRawShape(toolConfig.outputSchema),
    annotations: canonicalJson(toolConfig.annotations),
  };
}

function jsonSchemaForRawShape(value: unknown): JsonValue | undefined {
  if (!isRecord(value)) return canonicalJson(value);
  try {
    return canonicalJson(
      z.toJSONSchema(z.object(value as Record<string, z.ZodType>)),
    );
  } catch {
    return canonicalJson(value);
  }
}

function canonicalJson(value: unknown): JsonValue | undefined {
  if (
    value === null
    || typeof value === "boolean"
    || typeof value === "number"
    || typeof value === "string"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .map(canonicalJson)
      .filter((item): item is JsonValue => item !== undefined);
  }
  if (!isRecord(value)) return undefined;

  const entries = Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([key, child]) => {
      const normalized = canonicalJson(child);
      return normalized === undefined ? [] : [[key, normalized] as const];
    });
  return Object.fromEntries(entries);
}

function stableJson(value: unknown): string {
  return JSON.stringify(canonicalJson(value));
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function readPackageVersion(): string {
  try {
    const parsed = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version?: unknown };
    return typeof parsed.version === "string" && parsed.version.length > 0
      ? parsed.version
      : "unknown";
  } catch {
    return "unknown";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
