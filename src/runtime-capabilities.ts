import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import * as z from "zod/v4";
import type { ServerConfig } from "./config.js";
import {
  assessNexusBackendFreshness,
  enrichNexusBackendRuntime,
  type ExistingStatusToolClientInput,
  type NexusBackendRuntimeObservation,
  type NexusRuntimeBindingObservation,
} from "./nexus-backend-freshness-adapter.js";
import {
  createToolSurfaceIdentity,
  freshnessHeaders,
  loadDeploymentManifestEnvelopeSync,
  observeFileIdentitySync,
  observePathIdentitySync,
  validateRuntimeNativeMcpIdentities,
  type ClientCatalogAttestation,
  type LoadedDeploymentManifest,
  type McpToolDescriptor,
  type RuntimeNativeMcpIdentity,
  type ToolSurfaceIdentity,
} from "./tool-surface-freshness.js";
import { DEVSPACE_PACKAGE_VERSION } from "./version.js";
import { assessStableToolAbi } from "./stable-tool-abi.js";

interface RuntimeCapabilityRegistryOptions {
  now?: () => number;
  instanceRef?: string;
}

export interface RuntimeCapabilitySnapshotOptions {
  clientInput?: ExistingStatusToolClientInput;
  clientAttestation?: ClientCatalogAttestation;
}

interface CriticalToolGroupDefinition {
  configured: boolean;
  expectedTools: readonly string[];
}

const PACKAGE_VERSION = DEVSPACE_PACKAGE_VERSION;

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
  workspaceLifecycle: [
    "workspace_list",
    "workspace_status",
    "workspace_close",
    "workspace_candidate_inventory",
    "workspace_gc_preview",
    "workspace_gc_execute",
  ],
  selfRepositoryPublication: [
    "self_repository_publication_preflight",
    "self_repository_publish",
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
  zesResearchCycle: [
    "zes_research_cycle_open",
    "zes_research_cycle_prepare",
    "zes_research_discovery_plan",
    "zes_research_discovery_acquire",
    "zes_research_horizon_record",
    "zes_research_horizon_status",
    "zes_research_instrument_plan",
    "zes_research_instrument_record",
    "zes_research_instrument_status",
    "zes_research_provider_invoke",
    "zes_research_cycle_assess",
    "zes_research_cycle_invalidate",
    "zes_research_cycle_verify_pre_commit",
    "zes_research_cycle_status",
    "zes_research_cycle_close",
  ],
  conversationTransport: [
    "conversation_transport_bind",
    "conversation_transport_status",
    "execution_wake_pending_record",
    "execution_wake_status",
    "execution_wake_assess",
    "execution_wake_execute",
    "execution_wake_reconcile",
  ],
  nativeNavigation: ["grep", "glob", "ls"],
  artifactDownload: ["download_artifact"],
} as const;

const REQUIRED_CLIENT_TOOLS = [
  "execution_scope_list",
  "execution_scope_status",
  "open_workspace",
  "read",
  "exec_command",
  "skill_search",
] as const;

/**
 * Read-only observation of the exact tools registered through the normal
 * DevSpace registration path. This registry never controls registration and is
 * deliberately not a second tool catalog or execution authority.
 */
export class RuntimeCapabilityRegistry {
  readonly startedAtMs: number;
  readonly instanceRef: string;

  private readonly tools = new Map<string, McpToolDescriptor>();
  private readonly now: () => number;
  private readonly deployment: LoadedDeploymentManifest | undefined;
  private readonly runtimeBindings: NexusRuntimeBindingObservation;
  private readonly deploymentDiagnostics: Record<string, unknown>;
  private toolSurfaceIdentity: ToolSurfaceIdentity | undefined;

  constructor(
    private readonly config: ServerConfig,
    options: RuntimeCapabilityRegistryOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.startedAtMs = this.now();
    this.instanceRef = options.instanceRef
      ?? sha256(randomUUID()).slice(0, 16);
    const loaded = loadDeploymentState(config);
    this.deployment = loaded.deployment;
    this.runtimeBindings = loaded.runtimeBindings;
    this.deploymentDiagnostics = loaded.diagnostics;
  }

  registerTool(name: string, toolConfig: Record<string, unknown>): void {
    // OpenAI's stateless transport creates a fresh McpServer for each POST,
    // while one RuntimeCapabilityRegistry is shared for the backend process.
    // Tool definitions are static for that process/configuration, so normalize
    // each name only once instead of rebuilding every JSON schema per tool call.
    if (this.tools.has(name)) return;
    this.tools.set(name, normalizeToolDefinition(name, toolConfig));
    this.toolSurfaceIdentity = undefined;
  }

  descriptors(): McpToolDescriptor[] {
    return [...this.tools.values()]
      .map((entry) => structuredClone(entry));
  }

  snapshot(options: RuntimeCapabilitySnapshotOptions = {}): Record<string, unknown> {
    const toolEntries = this.descriptors();
    const identity = this.toolSurfaceIdentity
      ?? createToolSurfaceIdentity(toolEntries);
    this.toolSurfaceIdentity = identity;
    const toolNames = identity.toolNames;
    const safeConfiguration = this.safeConfiguration();
    const stableToolAbi = assessStableToolAbi(toolEntries, {
      selfRepositoryPublicationConfigured:
        this.config.selfRepositoryPublication.enabled,
      selfRepositoryPublicationEffectsEnabled:
        this.config.selfRepositoryPublication.effectsEnabled,
    });
    const surfaceEpoch = this.runtimeBindings.surfaceEpoch
      ?? `nexus:${identity.fingerprintSha256.slice(0, 16)}`;
    const initialized = toolNames.length > 0;

    const backendRuntime: NexusBackendRuntimeObservation = {
      schemaVersion: 1,
      backend: {
        name: "devspace",
        implementation: "zes-nexus",
        packageVersion: PACKAGE_VERSION,
        mcpServerVersion: this.config.mcpServerVersion,
        instanceRef: this.instanceRef,
        startedAt: new Date(this.startedAtMs).toISOString(),
        uptimeMs: Math.max(0, this.now() - this.startedAtMs),
      },
      toolSurface: {
        initialized,
        fingerprintSha256: identity.fingerprintSha256,
        surfaceEpoch,
        toolCount: identity.toolCount,
        toolNames,
        requiredClientTools: [...REQUIRED_CLIENT_TOOLS],
        fingerprintBasis: "canonical_complete_mcp_tools_list_descriptors",
        stableToolAbi,
        configuration: safeConfiguration,
        criticalToolGroups: this.criticalToolGroups(new Set(toolNames)),
      },
      deploymentManifestObservation: this.deploymentDiagnostics,
      policy: {
        authority: "executor_local_runtime_observation_only",
        controlsToolRegistration: false,
        stableToolAbiControlsRegistration: false,
        stableToolAbiIsCompatibilityAssessmentOnly: true,
        canonicalTaskOrDecisionAuthority: false,
        transcriptCaptured: false,
        promptsCaptured: false,
        privateReasoningCaptured: false,
        credentialsCaptured: false,
      },
    };

    const { runtime, assessment } = assessNexusBackendFreshness({
      backendRuntime,
      bindings: {
        ...this.runtimeBindings,
        surfaceEpoch,
      },
      expected: this.deployment?.manifest,
      clientInput: options.clientInput,
      clientAttestation: options.clientAttestation,
      assessedAt: new Date(this.now()).toISOString(),
    });
    const enriched = enrichNexusBackendRuntime(backendRuntime, assessment);
    enriched.clientCatalogObservation = {
      ...assessment.clientCatalogObservation,
      status: assessment.status,
      backendRegisteredSurfaceObservable: true,
      missingRegisteredToolDoesNotImplyBackendCapabilityAbsent: true,
      actionWhenClientLacksRegisteredTool:
        "Refresh or reconnect the MCP connector, then attest the complete tools/list fingerprint.",
    };
    return {
      ...enriched,
      runtimeBindingObservation: {
        build: runtime.build,
        acceleratorProfile: runtime.acceleratorProfile,
        nativeMcps: runtime.nativeMcps,
      },
    };
  }

  responseHeaders(
    clientAttestation?: ClientCatalogAttestation,
  ): Record<string, string> {
    const headers: Record<string, string> = {
      "Cache-Control": "no-store",
      "X-ZES-Nexus-Instance-Ref": this.instanceRef,
    };
    if (this.tools.size === 0) return headers;
    const snapshot = this.snapshot({ clientAttestation });
    const toolSurface = snapshot.toolSurface as Record<string, unknown>;
    const freshness = snapshot.toolSurfaceFreshness as Record<string, unknown>;
    const runtime = {
      instanceRef: this.instanceRef,
      startedAt: new Date(this.startedAtMs).toISOString(),
      surfaceEpoch:
        typeof toolSurface.surfaceEpoch === "string"
          ? toolSurface.surfaceEpoch
          : undefined,
      build: {
        packageVersion: PACKAGE_VERSION,
        mcpServerVersion: this.config.mcpServerVersion,
      },
      toolSurface: {
        fingerprintSha256: String(toolSurface.fingerprintSha256),
        toolCount: Number(toolSurface.toolCount),
        toolNames: Array.isArray(toolSurface.toolNames)
          ? toolSurface.toolNames.filter((entry): entry is string => typeof entry === "string")
          : [],
      },
      nativeMcps: [],
    };
    return {
      ...headers,
      ...freshnessHeaders(
        freshness as unknown as Parameters<typeof freshnessHeaders>[0],
        runtime,
      ),
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
      zesResearchCycleMode: this.config.zesResearchCycle.mode,
      artifactDownloadConfigured: this.config.artifactsEnabled,
      workspaceSystemIndexConfiguredCount:
        this.config.workspaceSystemIndexPaths.length,
      selfRepositoryPublicationConfigured:
        this.config.selfRepositoryPublication.enabled,
      selfRepositoryPublicationEffectsEnabled:
        this.config.selfRepositoryPublication.effectsEnabled,
      conversationTransportEnabled:
        this.config.conversationTransport.enabled,
      conversationTransportEffectsEnabled:
        this.config.conversationTransport.effectsEnabled,
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
      workspaceLifecycle: {
        configured: true,
        expectedTools: CRITICAL_TOOL_GROUPS.workspaceLifecycle,
      },
      selfRepositoryPublication: {
        configured: this.config.selfRepositoryPublication.enabled,
        expectedTools: this.config.selfRepositoryPublication.effectsEnabled
          ? CRITICAL_TOOL_GROUPS.selfRepositoryPublication
          : CRITICAL_TOOL_GROUPS.selfRepositoryPublication.slice(0, 1),
      },
      localAgentContinuation: {
        configured: this.config.subagents,
        expectedTools: CRITICAL_TOOL_GROUPS.localAgentContinuation,
      },
      zesResearchCycle: {
        configured: this.config.zesResearchCycle.mode !== "off",
        expectedTools: CRITICAL_TOOL_GROUPS.zesResearchCycle,
      },
      conversationTransport: {
        configured: this.config.conversationTransport.enabled,
        expectedTools: CRITICAL_TOOL_GROUPS.conversationTransport,
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
  name: string,
  toolConfig: Record<string, unknown>,
): McpToolDescriptor {
  const descriptor: McpToolDescriptor = {
    name,
    title: typeof toolConfig.title === "string" ? toolConfig.title : undefined,
    description:
      typeof toolConfig.description === "string" ? toolConfig.description : undefined,
    inputSchema:
      jsonSchemaForRawShape(toolConfig.inputSchema, "input")
      ?? { type: "object", properties: {} },
    annotations: cloneJsonValue(toolConfig.annotations),
    execution: { taskSupport: "forbidden" },
    _meta: normalizeAppToolMetadata(toolConfig._meta),
  };
  const outputSchema = jsonSchemaForRawShape(toolConfig.outputSchema, "output");
  if (outputSchema !== undefined) descriptor.outputSchema = outputSchema;
  return descriptor;
}

function normalizeAppToolMetadata(value: unknown): unknown {
  const cloned = cloneJsonValue(value);
  if (!isRecord(cloned)) return cloned;
  const nestedUi = isRecord(cloned.ui) ? cloned.ui : undefined;
  const nestedResourceUri = typeof nestedUi?.resourceUri === "string"
    ? nestedUi.resourceUri
    : undefined;
  const legacyResourceUri = typeof cloned["ui/resourceUri"] === "string"
    ? cloned["ui/resourceUri"]
    : undefined;
  if (nestedResourceUri && !legacyResourceUri) {
    return { ...cloned, "ui/resourceUri": nestedResourceUri };
  }
  if (legacyResourceUri && !nestedResourceUri) {
    return {
      ...cloned,
      ui: { ...nestedUi, resourceUri: legacyResourceUri },
    };
  }
  return cloned;
}

function jsonSchemaForRawShape(
  value: unknown,
  pipeStrategy: "input" | "output",
): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  try {
    return toJsonSchemaCompat(
      z.object(value as Record<string, z.ZodType>),
      { strictUnions: true, pipeStrategy },
    ) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function cloneJsonValue(value: unknown): unknown {
  if (value === undefined) return undefined;
  try {
    return structuredClone(value);
  } catch {
    return undefined;
  }
}

interface LoadedDeploymentState {
  deployment?: LoadedDeploymentManifest;
  runtimeBindings: NexusRuntimeBindingObservation;
  diagnostics: Record<string, unknown>;
}

function loadDeploymentState(config: ServerConfig): LoadedDeploymentState {
  const freshness = config.toolSurfaceFreshness;
  const errors: Array<Record<string, unknown>> = [];
  let deployment: LoadedDeploymentManifest | undefined;
  let buildArtifactDigestSha256: string | undefined;
  let acceleratorProfile: ReturnType<typeof observeFileIdentitySync> | undefined;
  let nativeMcps: RuntimeNativeMcpIdentity[] = [];

  if (
    freshness.deploymentManifestPath
    && freshness.deploymentManifestDigestSha256
  ) {
    try {
      deployment = loadDeploymentManifestEnvelopeSync(
        freshness.deploymentManifestPath,
        freshness.deploymentManifestPath,
        freshness.deploymentManifestDigestSha256,
      );
    } catch (error) {
      errors.push({
        scope: "deployment_manifest",
        path: freshness.deploymentManifestPath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  } else if (freshness.deploymentManifestPath) {
    errors.push({
      scope: "deployment_manifest",
      path: freshness.deploymentManifestPath,
      error: "DEVSPACE_TOOL_SURFACE_MANIFEST requires DEVSPACE_TOOL_SURFACE_MANIFEST_SHA256",
    });
  } else if (freshness.deploymentManifestDigestSha256) {
    errors.push({
      scope: "deployment_manifest",
      error: "DEVSPACE_TOOL_SURFACE_MANIFEST_SHA256 is set without DEVSPACE_TOOL_SURFACE_MANIFEST",
    });
  }

  if (freshness.buildArtifactPath) {
    try {
      buildArtifactDigestSha256 = observePathIdentitySync(
        freshness.buildArtifactPath,
        `build-artifact:${freshness.buildArtifactPath}`,
      ).digestSha256;
    } catch (error) {
      errors.push({
        scope: "server_build",
        path: freshness.buildArtifactPath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (freshness.acceleratorProfilePath) {
    try {
      acceleratorProfile = observeFileIdentitySync(
        freshness.acceleratorProfilePath,
        freshness.acceleratorProfileRef ?? freshness.acceleratorProfilePath,
      );
    } catch (error) {
      errors.push({
        scope: "accelerator_profile",
        path: freshness.acceleratorProfilePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (freshness.nativeMcpRuntimeIdentitiesPath) {
    try {
      nativeMcps = validateRuntimeNativeMcpIdentities(
        JSON.parse(readFileSync(freshness.nativeMcpRuntimeIdentitiesPath, "utf8")),
      );
    } catch (error) {
      errors.push({
        scope: "native_mcp",
        path: freshness.nativeMcpRuntimeIdentitiesPath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    deployment,
    runtimeBindings: {
      sourceCommit: freshness.sourceCommit,
      sourceTree: freshness.sourceTree,
      buildArtifactDigestSha256,
      surfaceEpoch: freshness.surfaceEpoch,
      acceleratorProfile,
      nativeMcps,
      observationErrors: errors,
    },
    diagnostics: {
      configured: Boolean(freshness.deploymentManifestPath),
      path: freshness.deploymentManifestPath,
      digestPinned: Boolean(freshness.deploymentManifestDigestSha256),
      expectedDigestSha256: freshness.deploymentManifestDigestSha256,
      loaded: Boolean(deployment),
      observedDigestSha256: deployment?.identity.digestSha256,
      generatedAt: deployment?.manifest.generatedAt,
      surfaceEpoch: deployment?.manifest.surfaceEpoch,
      errors,
    },
  };
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
