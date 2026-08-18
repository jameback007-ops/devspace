import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { access, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { checkResourceAllowed, resourceUrlFromServerUrl } from "@modelcontextprotocol/sdk/shared/auth-utils.js";
import {
  registerAppResource,
  registerAppTool as registerMcpAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import express from "express";
import type { Request, Response } from "express";
import * as z from "zod/v4";
import { applyPatch } from "./apply-patch.js";
import {
  isArtifactDownloadSupportedPlatform,
  registerArtifactTools,
} from "./artifact-tools.js";
import { loadConfig, type ServerConfig, type WidgetMode } from "./config.js";
import { ExecutionScopeManager } from "./execution-observability.js";
import {
  ExecutionMailboxManager,
  type ExecutionMessageKind,
  type ExecutionMessagePriority,
  type ExecutionMessageReceiptState,
} from "./execution-mailbox.js";
import {
  createOpenAIIncomingArtifactAdapter,
  type IncomingArtifactAdapter,
} from "./incoming-artifacts.js";
import {
  logEvent,
  requestIp,
  requestPath,
  commandPreview,
  sessionIdPrefix,
} from "./logger.js";
import {
  editFileTool,
  findFilesTool,
  grepFilesTool,
  listDirectoryTool,
  readFileTool,
  runShellTool,
  writeFileTool,
} from "./pi-tools.js";
import { SingleUserOAuthProvider } from "./oauth-provider.js";
import {
  McpSessionRegistry,
  type McpSessionCloseResult,
} from "./mcp-sessions.js";
import {
  DEFAULT_EXEC_YIELD_MS,
  DEFAULT_INTERACTIVE_YIELD_MS,
  DEFAULT_POLL_YIELD_MS,
  MAX_COMMAND_YIELD_MS,
  MAX_POLL_YIELD_MS,
  ProcessSessionManager,
  type ProcessSnapshot,
} from "./process-sessions.js";
import { createReviewCheckpointManager } from "./review-checkpoints.js";
import {
  executionScopeIdentity,
  executorTurnMetadata,
} from "./request-meta.js";
import { shutdownHttpServer } from "./server-shutdown.js";
import { formatPathForPrompt } from "./skills.js";
import {
  RuntimeCapabilityRegistry,
} from "./runtime-capabilities.js";
import {
  type ResearchGuardDecision,
  type ResearchWorkspace,
  ZesResearchCycleManager,
} from "./research-cycle.js";
import { registerZesResearchCycleTools } from "./research-cycle-tools.js";
import {
  clientAttestationFromHeaders,
  type ClientCatalogAttestation,
} from "./tool-surface-freshness.js";
import {
  ZesScopePublicationPreflightAssessor,
  type ScopePublicationPreflight,
  type ScopePublicationPreflightSource,
} from "./scope-publication-preflight.js";
import { registerZesCodexInspectionTools } from "./zes-codex-inspection.js";
import {
  registerZesContinuationPreflightTool,
  ZesContinuationPreflightProjector,
  type ZesContinuationPreflightProjection,
  type ZesContinuationPreflightProjectionSource,
} from "./zes-continuation-preflight.js";
import { createWorkspaceStore } from "./workspace-store.js";
import { WorkspaceLifecycleManager } from "./workspace-lifecycle.js";
import {
  formatAgentsPath,
  WorkspaceRegistry,
  type WorkspaceInstructionDiscovery,
} from "./workspaces.js";
import { summarizeLocalAgentProfile } from "./local-agent-profiles.js";
import {
  formatLocalAgentProviderAvailabilitySummary,
  getLocalAgentProviderAvailabilitySnapshot,
  type LocalAgentProviderAvailability,
} from "./local-agent-availability.js";
import {
  LocalAgentCoordinator,
  launchDetachedLocalAgentWorker,
} from "./local-agent-coordinator.js";
import {
  TurnContinuityManager,
  type RecoveryCapsuleInput,
  type RecoveryCapsuleIntent,
  type RecoveryEffectState,
  type RecoveryRetryPolicy,
  type RecoveryValidationState,
  type RecoveryWorktreeState,
  type RecoveryWriterState,
  type TurnHorizonBeginReason,
} from "./turn-continuity.js";

type Transport = StreamableHTTPServerTransport;
// MCP clients can reconnect without closing the previous transport. Bound stale
// session retention so abandoned MCP servers do not accumulate for the life of the process.
const MCP_SESSION_IDLE_TIMEOUT_MS = 24 * 60 * 60 * 1_000;
const MCP_SESSION_CLEANUP_INTERVAL_MS = 5 * 60 * 1_000;
const WORKSPACE_APP_URI = "ui://devspace/workspace-app.html";
const WORKSPACE_APP_MANIFEST_ENTRY = "workspace-app.html";
const CODEX_SESSION_TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
const WRITE_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};
const EDIT_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};
const SHELL_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};

interface RunningServer {
  app: ReturnType<typeof createMcpExpressApp>;
  config: ServerConfig;
  localAgentProviders: LocalAgentProviderAvailability[];
  close(): Promise<void>;
}

type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

interface WorkspaceAppManifestEntry {
  file: string;
  css?: string[];
  isEntry?: boolean;
}

type WorkspaceAppManifest = Record<string, WorkspaceAppManifestEntry>;

interface DiffStats {
  additions: number;
  removals: number;
}

type ToolWidgetKind =
  | "workspace"
  | "read"
  | "write"
  | "edit"
  | "search"
  | "directory"
  | "shell"
  | "show_changes";

interface ToolDefinitionMeta extends Record<string, unknown> {
  ui: {
    resourceUri: string;
    visibility: ["model"];
  };
}

type EmptyToolDefinitionMeta = Record<string, unknown> & {
  "ui/resourceUri"?: string;
};

interface ToolWidgetDescriptorMeta {
  _meta: ToolDefinitionMeta | EmptyToolDefinitionMeta;
}

function shouldAttachWidget(mode: WidgetMode, kind: ToolWidgetKind): boolean {
  switch (mode) {
    case "off":
      return false;
    case "changes":
      return kind === "workspace" || kind === "show_changes";
    case "full":
      return true;
  }
}

function toolWidgetDescriptorMeta(
  config: ServerConfig,
  kind: ToolWidgetKind,
): ToolWidgetDescriptorMeta {
  if (!shouldAttachWidget(config.widgets, kind)) return { _meta: {} };

  return {
    _meta: {
      ui: {
        resourceUri: WORKSPACE_APP_URI,
        visibility: ["model"],
      },
    },
  };
}

const toolNames = {
  openWorkspace: "open_workspace",
  workspaceList: "workspace_list",
  workspaceStatus: "workspace_status",
  workspaceClose: "workspace_close",
  workspaceGcPreview: "workspace_gc_preview",
  workspaceGcExecute: "workspace_gc_execute",
  skillSearch: "skill_search",
  read: "read",
  write: "write",
  edit: "edit",
  grep: "grep",
  glob: "glob",
  ls: "ls",
  shell: "bash",
} as const;

const workspaceIdDescription =
  "Workspace to use. Reuse the current project's workspaceId.";

interface ToolLogFields {
  tool: string;
  workspaceId?: string;
  path?: string;
  workingDirectory?: string;
  command?: string;
  commandLength?: number;
  success: boolean;
  durationMs: number;
  error?: string;
  instructionDiscoveryStatus?: WorkspaceInstructionDiscovery["status"];
  instructionDiscoveryReason?: "deadline_exceeded" | "result_limit_exceeded";
  instructionDiscoveryFinder?: "fd" | "node";
}

const toolExecutionContexts = new WeakMap<
  object,
  {
    executionScopes: ExecutionScopeManager;
    executionMailbox: ExecutionMailboxManager;
    turnContinuity: TurnContinuityManager;
    runtimeCapabilities: RuntimeCapabilityRegistry;
    config: ServerConfig;
  }
>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function appendToolNotice<T>(
  response: T,
  notice: string | undefined,
  metadataKey: string,
): T {
  if (!notice || !isRecord(response)) return response;
  const content = Array.isArray(response.content)
    ? [...response.content, { type: "text", text: notice }]
    : [{ type: "text", text: notice }];
  const structuredContent = isRecord(response.structuredContent)
    ? {
        ...response.structuredContent,
        ...(typeof response.structuredContent.result === "string"
          ? { result: `${response.structuredContent.result}\n\n${notice}` }
          : {}),
      }
    : response.structuredContent;
  const metadata = isRecord(response._meta)
    ? { ...response._meta, [metadataKey]: notice }
    : { [metadataKey]: notice };
  return {
    ...response,
    content,
    _meta: metadata,
    ...(structuredContent === undefined ? {} : { structuredContent }),
  } as T;
}

function appendExecutionMailboxNotice(
  response: unknown,
  notice: string | undefined,
): unknown {
  return appendToolNotice(response, notice, "executionMailboxNotice");
}

function appendTurnContinuityNotice(
  response: unknown,
  notice: string | undefined,
): unknown {
  return appendToolNotice(response, notice, "turnContinuityNotice");
}

const registerAppTool = ((
  server: Pick<McpServer, "registerTool">,
  name: string,
  toolConfig: Record<string, unknown>,
  callback: (input: unknown, extra: { _meta?: unknown }) => unknown,
) => {
  const toolContext = toolExecutionContexts.get(server as object);
  if (!toolContext) {
    return registerMcpAppTool(
      server,
      name,
      toolConfig as never,
      callback as never,
    );
  }

  const registeredTool = registerMcpAppTool(
    server,
    name,
    toolConfig as never,
    (async (input: unknown, extra: { _meta?: unknown }) => {
      const {
        executionScopes,
        executionMailbox,
        turnContinuity,
        config,
      } = toolContext;
      const executionIdentity = executionScopeIdentity(extra?._meta);
      const turnMetadata = executorTurnMetadata(extra?._meta);
      let observation: ReturnType<ExecutionScopeManager["beginTool"]>;
      try {
        observation = executionScopes.beginTool(executionIdentity, name, input);
      } catch (error) {
        observation = undefined;
        logEvent(config.logging, "warn", "execution_scope_observation_failed", {
          stage: "begin",
          tool: name,
          scopeRef: executionIdentity?.scopeRef,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      try {
        turnContinuity.observeToolStart(
          executionIdentity,
          turnMetadata,
          name,
        );
      } catch (error) {
        logEvent(config.logging, "warn", "turn_continuity_observation_failed", {
          stage: "begin",
          tool: name,
          scopeRef: executionIdentity?.scopeRef,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      try {
        const response = await callback(input, extra);
        const succeeded = !(isRecord(response) && response.isError === true);
        try {
          executionScopes.finishTool(
            observation,
            executionScopes.outcomeForResponse(response),
            { response },
          );
        } catch (error) {
          logEvent(config.logging, "warn", "execution_scope_observation_failed", {
            stage: "finish",
            tool: name,
            scopeRef: executionIdentity?.scopeRef,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        try {
          turnContinuity.observeToolFinish(
            executionIdentity,
            turnMetadata,
            name,
            input,
            succeeded,
          );
        } catch (error) {
          logEvent(config.logging, "warn", "turn_continuity_observation_failed", {
            stage: "finish",
            tool: name,
            scopeRef: executionIdentity?.scopeRef,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        let mailboxNotice: string | undefined;
        if (!name.startsWith("execution_scope_message_")) {
          try {
            mailboxNotice = executionMailbox.pendingNotice(executionIdentity);
          } catch (error) {
            logEvent(config.logging, "warn", "execution_mailbox_notice_failed", {
              tool: name,
              scopeRef: executionIdentity?.scopeRef,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
        let continuityNotice: string | undefined;
        try {
          continuityNotice = turnContinuity.advisoryNotice(
            executionIdentity,
            turnMetadata,
            name,
          );
        } catch (error) {
          logEvent(config.logging, "warn", "turn_continuity_notice_failed", {
            tool: name,
            scopeRef: executionIdentity?.scopeRef,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        const responseWithMailbox = appendExecutionMailboxNotice(
          response,
          mailboxNotice,
        );
        return appendTurnContinuityNotice(
          responseWithMailbox,
          continuityNotice,
        );
      } catch (error) {
        try {
          executionScopes.finishTool(observation, "error", {
            error,
          });
        } catch (observationError) {
          logEvent(config.logging, "warn", "execution_scope_observation_failed", {
            stage: "finish_error",
            tool: name,
            scopeRef: executionIdentity?.scopeRef,
            error:
              observationError instanceof Error
                ? observationError.message
                : String(observationError),
          });
        }
        try {
          turnContinuity.observeToolFinish(
            executionIdentity,
            turnMetadata,
            name,
            input,
            false,
          );
        } catch (continuityError) {
          logEvent(config.logging, "warn", "turn_continuity_observation_failed", {
            stage: "finish_error",
            tool: name,
            scopeRef: executionIdentity?.scopeRef,
            error:
              continuityError instanceof Error
                ? continuityError.message
                : String(continuityError),
          });
        }
        throw error;
      }
    }) as never,
  );
  toolContext.runtimeCapabilities.registerTool(name, toolConfig);
  return registeredTool;
}) as unknown as typeof registerMcpAppTool;

function serverInstructions(config: ServerConfig): string {
  const codexSessionInstruction =
    " To inspect the allowlisted AOQ Codex executor adapter, use codex_session_status, codex_session_tail, or codex_session_audit. These tools report adapter transport health separately from the Codex thread lifecycle and never represent DevSpace, VPS, workspace, or ZES product health. To inspect the exact live AOQ worktree, use codex_workspace_git_status, codex_workspace_tree, codex_workspace_read, codex_workspace_search, or codex_workspace_diff. These brokered commands are read-only and independent from the Codex thread lifecycle.";
  const zesContinuationInstruction =
    " Before governed-main integration or repository publication, use zes_continuation_preflight with the matching intent when that direct tool is present. If a frozen host catalog does not expose it, call the already-known execution_scope_status tool and read stableControlPlane.capabilities.continuationPreflight plus stableControlPlane.capabilities.scopePublicationPreflight instead of passing DSN, credential, thread, repository, or filesystem paths through exec_command. The fixed product preflight reports global rightful-owner state; the scope-publication projection joins it with the exact linked candidate worktree and its fresh HEAD-bound validation capsule. publication_disposition=not_required on the governed checkout means that checkout has no unpublished commit and is not a denial of a separately assessed candidate. Runtime reconciliation findings apply to runtime takeover, effect retry, or reliance on runtime state and do not by themselves block unrelated repository source actions. Catalog staleness is a discovery condition and must not be translated into writer uncertainty or missing publication controls. Neither route creates writer, publication, takeover, or effect authority; any publication still requires the exact compare-and-swap binding and remote readback returned by the candidate assessment.";
  const zesResearchCycleInstruction = config.zesResearchCycle.mode === "off"
    ? ""
    : " For a workspace containing the ZES control-kernel marker, use zes_research_cycle_open before material design or mutation, then prepare exact action bindings and obtain a native ZES Research Reflex v2 admission with zes_research_cycle_assess. Reopen judgment with zes_research_cycle_invalidate when evidence, scope, architecture, dependencies, currentness, owner direction, or failure causality changes. Before commit, use zes_research_cycle_verify_pre_commit; close the episode after the exact commit or terminal no-change/deferred/abandoned outcome. observe mode reports lifecycle drift without blocking; enforce mode holds source mutation, commit preparation, commit, and publication when the exact current lifecycle is absent or stale. These executor-local tools verify native receipts but never create semantic, writer, publication, release, activation, runtime, or effect authority.";
  const executionScopeInstruction = config.executionObservability.enabled
    ? " Use execution_scope_list to discover recent DevSpace execution scopes. When a target explicitly recorded a recovery capsule, the list includes a compact capsule-derived semantic label/frontier hint; it is not a host chat title and absent capsule means unknown mission. Use execution_scope_status for linked workspaces, live processes, explicit semantic recovery state, the observation gap since the last MCP/tool event, and additive read-only stable control-plane projections. Scope inspection also returns the current backend runtime instance and an exact fingerprint of the registered model-facing tool surface. The server cannot see the host's cached tools/list result. A frozen catalog may still consume compatible additive control state through execution_scope_status; refresh or reconnect is needed only when the task genuinely requires a newer top-level tool or changed input schema rather than a compatible stable projection. A no-tool interval does not reveal whether the model is reasoning, queued, generating, or hung; model progress and provider generation remain unobservable between MCP calls. Use execution_scope_audit for bounded metadata-only tool lifecycle. Semantic state is never inferred from filenames or tool events, cross-scope authority freshness remains unverified unless a fixed rightful-owner projection explicitly revalidates it, and a recorded exact action remains historical until current canonical/runtime/writer/effect owners are rehydrated. These views never replace Git, canonical product state, runtime/effect readback, or writer/lease reconciliation, and they do not contain transcripts, prompts, private reasoning, tool outputs, patches, credentials, or raw commands."
    : "";
  const executionMailboxInstruction = config.executionMailbox.enabled
    ? " Use execution_scope_message_send to leave a durable message for another known scope, reusing one idempotencyKey for retries. Acceptance means stored, not observed. When a tool result reports pending mail, call execution_scope_message_inbox before opening a new major frontier, then record acknowledged or acted state with execution_scope_message_receipt. Use execution_scope_message_status to inspect a message you sent or received. The mailbox is executor-local coordination, not task, decision, effect, writer, or canonical-memory authority, and it cannot wake or inject text directly into an inactive WebChat transcript."
    : "";
  const turnContinuityInstruction = config.turnContinuity.enabled
    ? " When the host supplies no exact assistant-turn identity, call turn_horizon_begin once near the first tool call of each assistant turn with a new idempotencyKey. The horizon is advisory only: never rush task completion, reduce validation, force a commit, abandon dynamic replanning, or stop because of elapsed time. At material transitions and before ending a long turn, use recovery_capsule_record to persist the current causal frontier, exact next action, validation/effect safety, do-not-repeat constraints, and exact authorityStateRefs from current rightful-owner readback, then read it back with recovery_capsule_status before ending the turn. A capsule may describe an intentional dirty worktree and never claims task completion or canonical authority. On resumption, local workspace freshness is insufficient: rehydrate current canonical Git/main, task, decision, writer, runtime, and effect owners, then pass exact currentAuthorityStateRefs to recovery_capsule_status. Stale Git or changed authority state requires reconciliation and replanning, not blind replay."
    : "";
  const localAgentInstruction = config.subagents
    ? " Use local_agent_session_list and local_agent_session_status to discover DevSpace-managed provider sessions. Provider availability is constrained by the configured billing policy; do not bypass an unavailable provider by supplying API credentials unless the Owner explicitly enabled payg_allowed. local_agent_message_send enqueues one idempotent turn for an existing qualified provider session; one worker lease serializes provider turns and acceptance means queued, not completed. Inspect local_agent_turn_status for the result. local_agent_turn_cancel is best-effort for running providers. An ordinary provider failure pauses later queued turns; use local_agent_session_resume after inspecting the failure. Never retry an indeterminate turn without explicit evidence-backed reconciliation through local_agent_turn_resolve because the prior provider effect may be unknown. Local-agent sessions and queues are executor-local coordination, not standing ZES identity, task, decision, writer, effect, or canonical-memory authority."
    : "";
  const artifactInstruction = config.artifactsEnabled && isArtifactDownloadSupportedPlatform()
    ? " When the user supplies or generates a file that is not present on the DevSpace host, use download_artifact with its native file value, the existing workspace ID, and a suitable relative destination path chosen from the user's request and project structure. The tool refuses to overwrite an existing destination and returns the normalized workspace-relative path. Use normal workspace tools when explicit inspection, replacement, movement, renaming, or deletion is needed. Do not recreate binary files with write/edit calls or place signed URLs, native file objects, base64 content, or invented host paths in shell commands or logs."
    : "";
  const workspaceLifecycleInstruction =
    " Use workspace_list and workspace_status to inspect persisted workspace lifecycle. Use workspace_close for one explicit workspace. For bulk cleanup, always call workspace_gc_preview first, inspect its protected/candidate reasons, and pass the exact returned plan digest with identical options to workspace_gc_execute. Never force-remove dirty, process-bound, or unpublished worktree state merely to reclaim space.";
  const showChangesInstruction =
    config.widgets === "changes"
      ? " If the turn successfully modifies files by creating, editing, overwriting, deleting, moving, or applying patches, call show_changes exactly once for that workspace after the final related file change and before your final response so the user can inspect the aggregate diff for that turn. Do not call it after every individual file change; do not skip it because individual file-change tools already returned diffs."
      : "";

  if (config.toolMode === "codex") {
    const codexInspectionInstruction = config.codexNavigationTools
      ? ` Use ${toolNames.read} for direct file reads and prefer the native ${toolNames.grep}, ${toolNames.glob}, and ${toolNames.ls} tools for bounded workspace search and navigation. Use exec_command for tests, builds, Git inspection, package scripts, and commands that genuinely require a shell.`
      : ` Use ${toolNames.read} for direct file reads and exec_command for inspection, tests, builds, and other commands.`;
    return `Use DevSpace for coding work. Call ${toolNames.openWorkspace} once for each project folder or isolated worktree, then keep using its workspaceId. During continued work in the same project or worktree, do not call ${toolNames.openWorkspace} again. Open another workspace only when changing projects, switching checkout/worktree mode, creating another isolated worktree, or when the current workspaceId is rejected.${codexInspectionInstruction} Use apply_patch for all file modifications and write_stdin to poll or interact with running processes. Follow instructions returned by ${toolNames.openWorkspace}; read applicable instruction and skill files before working in their scope.${workspaceLifecycleInstruction}${artifactInstruction}${showChangesInstruction}${codexSessionInstruction}${zesContinuationInstruction}${zesResearchCycleInstruction}${executionScopeInstruction}${executionMailboxInstruction}${turnContinuityInstruction}${localAgentInstruction}`;
  }

  const inspection = config.toolMode !== "full"
    ? `In minimal tool mode, ${toolNames.grep}, ${toolNames.glob}, and ${toolNames.ls} are disabled; use ${toolNames.shell} with command-line tools such as grep, rg, find, ls, and tree for search and directory inspection. `
    : `Prefer ${toolNames.read}, ${toolNames.grep}, ${toolNames.glob}, and ${toolNames.ls} for file inspection. `;

  const skills = config.skillsEnabled
    ? `When ${toolNames.openWorkspace} returns a relevant skill and the task matches it, use ${toolNames.read} to read that skill's path before proceeding. Use ${toolNames.skillSearch} only when a specialized project or host capability is needed but was not listed automatically. Skill paths may be outside the workspace, but ${toolNames.read} only permits skills advertised by ${toolNames.openWorkspace} or ${toolNames.skillSearch}, plus files under a skill directory after its SKILL.md has been read. `
    : "";

  const agentsMd = `Follow instructions returned by ${toolNames.openWorkspace}. Before working under a path listed in availableAgentsFiles, use ${toolNames.read} to inspect that instruction file and follow it. `;

  return `Use DevSpace for coding work. Call ${toolNames.openWorkspace} once for each project folder or isolated worktree, then keep using its workspaceId. During continued work in the same project or worktree, do not call ${toolNames.openWorkspace} again. Open another workspace only when changing projects, switching checkout/worktree mode, creating another isolated worktree, or when the current workspaceId is rejected. ${agentsMd}${skills}${inspection}Prefer ${toolNames.edit} for targeted modifications, ${toolNames.write} only for new files or complete rewrites, and ${toolNames.shell} for tests, builds, git inspection, package scripts, and commands that are better executed by the shell. Do not create or modify files with ${toolNames.shell}; avoid shell redirection, heredocs, tee, sed -i, perl -i, node/python/ruby scripts, or any command whose purpose is to write project files.${workspaceLifecycleInstruction}${artifactInstruction}${showChangesInstruction}${codexSessionInstruction}${zesContinuationInstruction}${zesResearchCycleInstruction}${executionScopeInstruction}${executionMailboxInstruction}${turnContinuityInstruction}${localAgentInstruction}`;
}

function formatVisibleAgent(agent: {
  name: string;
  provider: string;
  model?: string;
  thinking?: string;
  providerAvailable?: boolean;
  providerUnavailableReason?: string;
}): string {
  const model = agent.model ? `, model ${agent.model}` : "";
  const thinking = agent.thinking ? `, thinking ${agent.thinking}` : "";
  const availability = agent.providerAvailable === false
    ? `, unavailable: ${agent.providerUnavailableReason ?? "provider unavailable"}`
    : "";
  return `${agent.name} (${agent.provider}${model}${thinking}${availability})`;
}

function formatUnavailableAgentProvider(provider: LocalAgentProviderAvailability): string {
  return `${provider.name} (${provider.reason ?? "unavailable"})`;
}

function resultOutputSchema(extra: z.ZodRawShape = {}): z.ZodRawShape {
  return {
    result: z
      .string()
      .describe(
        "Model-readable result text for follow-up reasoning and plain MCP hosts.",
      ),
    ...extra,
  };
}

const workspaceSkillOutputSchema = z.object({
  name: z.string(),
  description: z.string(),
  path: z.string(),
});

const workspaceAgentsFileOutputSchema = z.object({
  path: z.string(),
  content: z.string(),
});

const workspaceLocalAgentOutputSchema = z.object({
  name: z.string(),
  description: z.string(),
  provider: z.string(),
  model: z.string().optional(),
  thinking: z.string().optional(),
  providerAvailable: z.boolean().optional(),
  providerUnavailableReason: z.string().optional(),
});

const workspaceLocalAgentProviderOutputSchema = z.object({
  name: z.string(),
  available: z.boolean(),
  reason: z.string().optional(),
});

const workspaceAvailableAgentsFileOutputSchema = z.object({
  path: z.string(),
});

const workspaceInstructionDiscoveryOutputSchema = z.object({
  status: z.literal("incomplete"),
  reason: z.enum(["deadline_exceeded", "result_limit_exceeded"]),
});

function incompleteInstructionDiscoveryMessage(
  discovery: WorkspaceInstructionDiscovery,
): string | undefined {
  if (discovery.status === "complete") return undefined;

  const reason = discovery.reason === "deadline_exceeded"
    ? "Nested instruction discovery exceeded its time budget."
    : "More nested instruction files were found than can be safely returned.";
  return `${reason} Only global and root-level instructions are loaded. Open the specific project directory before working inside it.`;
}

const reviewFileOutputSchema = z.object({
  path: z.string(),
  previousPath: z.string().optional(),
  type: z.enum(["change", "rename-pure", "rename-changed", "new", "deleted"]),
  additions: z.number(),
  removals: z.number(),
});

const reviewSummaryOutputSchema = z.object({
  files: z.number(),
  additions: z.number(),
  removals: z.number(),
});

function sendJsonRpcError(
  res: Response,
  status: number,
  code: number,
  message: string,
): void {
  res.status(status).json({
    jsonrpc: "2.0",
    error: { code, message },
    id: null,
  });
}

function requestLogFields(req: Request, config: ServerConfig): Record<string, unknown> {
  return {
    ip: requestIp(req, config.logging.trustProxy),
    host: req.header("host"),
    userAgent: req.header("user-agent"),
    origin: req.header("origin"),
    referer: req.header("referer"),
    contentLength: req.header("content-length"),
  };
}

function logToolCall(config: ServerConfig, fields: ToolLogFields): void {
  if (!config.logging.toolCalls) return;

  const { command, ...safeFields } = fields;
  logEvent(config.logging, fields.success ? "info" : "warn", "tool_call", {
    ...safeFields,
    commandPreview: config.logging.shellCommands && command ? commandPreview(command) : undefined,
  });
}

function contentText(content: ToolContent[]): string {
  return content
    .filter(
      (item): item is { type: "text"; text: string } => item.type === "text",
    )
    .map((item) => item.text)
    .join("\n");
}

function toolErrorPreview(content: ToolContent[]): string | undefined {
  const text = contentText(content).replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return text.length > 240 ? `${text.slice(0, 237)}...` : text;
}

function logFailedToolResponse(
  config: ServerConfig,
  fields: Omit<ToolLogFields, "success" | "durationMs" | "error">,
  content: ToolContent[],
  startedAt: number,
): void {
  logToolCall(config, {
    ...fields,
    success: false,
    durationMs: Math.round(performance.now() - startedAt),
    error: toolErrorPreview(content),
  });
}

function textBlock(text: string): ToolContent {
  return { type: "text", text };
}

function textSummary(content: ToolContent[]): {
  lines: number;
  characters: number;
} {
  const text = contentText(content);
  return {
    lines: text.length === 0 ? 0 : text.split("\n").length,
    characters: text.length,
  };
}

function contentLineCount(content: string): number {
  if (content.length === 0) return 0;
  return content.endsWith("\n")
    ? content.slice(0, -1).split("\n").length
    : content.split("\n").length;
}

function countDiffStats(diff: string | undefined): DiffStats {
  if (!diff) return { additions: 0, removals: 0 };

  let additions = 0;
  let removals = 0;

  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions++;
    if (line.startsWith("-") && !line.startsWith("---")) removals++;
  }

  return { additions, removals };
}

function newFilePatch(path: string, content: string): string {
  const lines =
    content.length === 0
      ? []
      : content.endsWith("\n")
        ? content.slice(0, -1).split("\n")
        : content.split("\n");
  const hunkLength = lines.length;
  const hunkRange = hunkLength === 0 ? "+0,0" : `+1,${hunkLength}`;
  const body = lines.map((line) => `+${line}`).join("\n");

  return [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "index 0000000..0000000",
    "--- /dev/null",
    `+++ b/${path}`,
    `@@ -0,0 ${hunkRange} @@`,
    body,
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

function assetBaseUrl(config: ServerConfig): string {
  return `${config.publicBaseUrl.replace(/\/+$/, "")}/mcp-app-assets`;
}

function uiManifestUrl(): URL {
  return new URL("../dist/ui/.vite/manifest.json", import.meta.url);
}

function readWorkspaceAppManifest(): WorkspaceAppManifest {
  return JSON.parse(readFileSync(uiManifestUrl(), "utf8")) as WorkspaceAppManifest;
}

function getWorkspaceAppManifestEntry(): WorkspaceAppManifestEntry {
  const manifest = readWorkspaceAppManifest();
  const entry = manifest[WORKSPACE_APP_MANIFEST_ENTRY];

  if (!entry?.file) {
    throw new Error(`Missing ${WORKSPACE_APP_MANIFEST_ENTRY} in UI manifest.`);
  }

  return entry;
}

function assetUrl(baseUrl: string, assetPath: string): string {
  return `${baseUrl}/${assetPath.replace(/^\/+/, "")}`;
}

function workspaceAppHtml(config: ServerConfig): string {
  const baseUrl = assetBaseUrl(config);
  const entry = getWorkspaceAppManifestEntry();
  const stylesheets = (entry.css ?? [])
    .map(
      (stylesheet) =>
        `    <link rel="stylesheet" crossorigin href="${assetUrl(baseUrl, stylesheet)}" />`,
    )
    .join("\n");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>DevSpace Workspace</title>
    <script type="module" crossorigin src="${assetUrl(baseUrl, entry.file)}"></script>
${stylesheets}
  </head>
  <body>
    <main id="app" class="shell">
      <section class="empty">Waiting for a tool result.</section>
    </main>
  </body>
</html>`;
}

function appCsp(config: ServerConfig): {
  resourceDomains: string[];
  connectDomains: string[];
} {
  const publicBaseUrl = config.publicBaseUrl.replace(/\/+$/, "");
  return {
    resourceDomains: [publicBaseUrl],
    connectDomains: [publicBaseUrl],
  };
}

function uiBuildDirectory(): string {
  return fileURLToPath(new URL("../dist/ui", import.meta.url));
}

function setAssetHeaders(res: Response): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Range");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
}

async function assertWorkspaceAppAssets(): Promise<void> {
  const entry = getWorkspaceAppManifestEntry();
  const candidates = [entry.file, ...(entry.css ?? [])].map(
    (assetPath) => new URL(`../dist/ui/${assetPath}`, import.meta.url),
  );

  for (const candidate of candidates) {
    await access(candidate);
  }
}

function processResult(snapshot: ProcessSnapshot): string {
  const status = snapshot.running
    ? snapshot.wakeReason === "mailbox"
      ? `Process still running with session ID ${snapshot.sessionId}; poll woke for pending execution-scope mail.`
      : `Process running with session ID ${snapshot.sessionId}.`
    : snapshot.signal
      ? `Process exited after signal ${snapshot.signal}.`
      : `Process exited with code ${snapshot.exitCode ?? "unknown"}.`;
  return snapshot.output ? `${snapshot.output.replace(/\n$/, "")}\n${status}` : status;
}

function processOutputSchema(): z.ZodRawShape {
  return resultOutputSchema({
    output: z.string(),
    sessionId: z.number().optional(),
    running: z.boolean(),
    exitCode: z.number().int().optional(),
    signal: z.string().optional(),
    wakeReason: z.enum(["mailbox"]).optional(),
    wallTimeMs: z.number().nonnegative(),
    outputTruncated: z.boolean(),
    outputDeltaBytes: z.number().int().nonnegative(),
    outputDeltaDigestSha256: z.string().regex(/^[a-f0-9]{64}$/),
    outputTotalBytes: z.number().int().nonnegative(),
    outputDigestSha256: z.string().regex(/^[a-f0-9]{64}$/),
    outputEventCount: z.number().int().nonnegative(),
    outputSequenceStart: z.number().int().positive().optional(),
    outputSequenceEnd: z.number().int().positive().optional(),
    outputComplete: z.boolean(),
  });
}

function processToolResponse(
  tool: "exec_command" | "write_stdin",
  workspaceId: string,
  snapshot: ProcessSnapshot,
  summary: Record<string, unknown>,
) {
  const result = processResult(snapshot);
  const content = [textBlock(result)];
  const outputSummary = textSummary(snapshot.output ? [textBlock(snapshot.output)] : []);
  return {
    content,
    _meta: {
      tool,
      card: {
        workspaceId,
        summary: { ...summary, ...outputSummary },
        payload: { content },
      },
    },
    structuredContent: {
      result,
      output: snapshot.output,
      sessionId: snapshot.sessionId,
      running: snapshot.running,
      exitCode: snapshot.exitCode,
      signal: snapshot.signal,
      wakeReason: snapshot.wakeReason,
      wallTimeMs: snapshot.wallTimeMs,
      outputTruncated: snapshot.outputTruncated,
      outputDeltaBytes: snapshot.outputDeltaBytes,
      outputDeltaDigestSha256: snapshot.outputDeltaDigestSha256,
      outputTotalBytes: snapshot.outputTotalBytes,
      outputDigestSha256: snapshot.outputDigestSha256,
      outputEventCount: snapshot.outputEventCount,
      outputSequenceStart: snapshot.outputSequenceStart,
      outputSequenceEnd: snapshot.outputSequenceEnd,
      outputComplete: snapshot.outputComplete,
    },
  };
}

function researchWorkspace(
  workspaces: WorkspaceRegistry,
  workspaceId: string,
): ResearchWorkspace {
  const workspace = workspaces.getWorkspace(workspaceId);
  return { workspaceId: workspace.id, root: workspace.root };
}

function researchGuardFailure(decision: ResearchGuardDecision) {
  const data = {
    status: "held",
    code: "ZES_RESEARCH_CYCLE_GUARD_HELD",
    classification: decision.classification,
    reasons: decision.reasons,
    cycleRef: decision.cycleRef,
    phase: decision.phase,
    policy: {
      authority:
        "executor_local_lifecycle_and_native_receipt_verification_only",
      semanticJudgmentAuthority: false,
      writerAuthority: false,
      publicationAuthority: false,
      runtimeOrEffectAuthority: false,
      retryWithoutReconciliation: false,
    },
  };
  return {
    isError: true,
    content: [textBlock(JSON.stringify(data, null, 2))],
  };
}

async function researchObservationNotice(
  config: ServerConfig,
  operation: string,
  observe: () => Promise<void>,
): Promise<string | undefined> {
  try {
    await observe();
    return undefined;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logEvent(config.logging, "warn", "zes_research_cycle_observation_failed", {
      operation,
      error: message.slice(0, 500),
    });
    return `[zes-research-cycle] The ${operation} effect completed, but executor-local research-cycle observation failed: ${message.slice(0, 500)}. Do not replay the effect blindly; inspect the workspace and reconcile the cycle first.`;
  }
}

function jsonToolResponse(data: unknown) {
  const result = JSON.stringify(data, null, 2);
  return {
    content: [textBlock(result)],
    structuredContent: { result, data },
  };
}

function scopeRuntimeRelation(
  scope: Record<string, unknown>,
  runtime: Record<string, unknown>,
): Record<string, unknown> {
  const backend = isRecord(runtime.backend) ? runtime.backend : undefined;
  const toolSurface = isRecord(runtime.toolSurface) ? runtime.toolSurface : undefined;
  const backendStartedAt = typeof backend?.startedAt === "string"
    ? backend.startedAt
    : undefined;
  const backendStartedAtMs = backendStartedAt ? Date.parse(backendStartedAt) : Number.NaN;
  const scopeCreatedAtMs = typeof scope.createdAt === "string"
    ? Date.parse(scope.createdAt)
    : Number.NaN;
  const scopeLastActivityAtMs = typeof scope.lastActivityAt === "string"
    ? Date.parse(scope.lastActivityAt)
    : Number.NaN;

  return {
    currentBackendInstanceRef:
      typeof backend?.instanceRef === "string" ? backend.instanceRef : undefined,
    currentBackendStartedAt: backendStartedAt,
    currentBackendToolSurfaceFingerprintSha256:
      typeof toolSurface?.fingerprintSha256 === "string"
        ? toolSurface.fingerprintSha256
        : undefined,
    currentBackendToolSurfaceEpoch:
      typeof toolSurface?.surfaceEpoch === "string"
        ? toolSurface.surfaceEpoch
        : undefined,
    requiredClientTools: Array.isArray(toolSurface?.requiredClientTools)
      ? toolSurface.requiredClientTools
      : undefined,
    scopeCreatedBeforeCurrentBackendInstance:
      Number.isFinite(scopeCreatedAtMs) && Number.isFinite(backendStartedAtMs)
        ? scopeCreatedAtMs < backendStartedAtMs
        : undefined,
    lastMcpActivityAtOrAfterCurrentBackendStart:
      Number.isFinite(scopeLastActivityAtMs) && Number.isFinite(backendStartedAtMs)
        ? scopeLastActivityAtMs >= backendStartedAtMs
        : undefined,
    exactBackendInstanceForHistoricalActivityPersisted: false,
    clientToolCatalogObservable: false,
    catalogFreshnessDetermination: "unavailable",
  };
}

function stableControlPlaneProjection(
  continuationPreflight: ZesContinuationPreflightProjection,
  scopePublicationPreflight?: ScopePublicationPreflight,
) {
  const capabilities = {
    continuationPreflight,
    ...(scopePublicationPreflight === undefined
      ? {}
      : { scopePublicationPreflight }),
  };
  return {
    schemaVersion: 1,
    route: "execution_scope_status",
    capabilityRefs: Object.values(capabilities).map(
      (capability) => capability.capabilityRef,
    ),
    capabilities,
    policy: {
      authority: "read_only_additive_projection_of_fixed_server_owned_capabilities",
      additiveProjection: true,
      stableBootstrapTool: "execution_scope_status",
      frozenClientCatalogCompatible: true,
      newTopLevelToolDiscoveryRequired: false,
      clientCatalogAttestationRequiredForControlPlaneReadback: false,
      unknownClientCatalogDoesNotEstablishWriterUncertainty: true,
      canonicalTaskDecisionWriterEffectOrPublicationAuthorityGranted: false,
    },
  } as const;
}

function setRuntimeCapabilityHeaders(
  res: Response,
  runtimeCapabilities: RuntimeCapabilityRegistry,
  clientAttestation?: ClientCatalogAttestation,
): void {
  for (const [name, value] of Object.entries(
    runtimeCapabilities.responseHeaders(clientAttestation),
  )) {
    res.setHeader(name, value);
  }
}

function requestClientCatalogAttestation(
  req: Request,
): ClientCatalogAttestation | undefined {
  try {
    return clientAttestationFromHeaders(req.headers);
  } catch {
    // Never treat malformed optional attestation as proof. The request remains
    // usable and the response reports the client catalog as unknown.
    return undefined;
  }
}

function registerExecutionScopeTools(
  server: McpServer,
  config: ServerConfig,
  executionScopes: ExecutionScopeManager,
  turnContinuity: TurnContinuityManager,
  runtimeCapabilities: RuntimeCapabilityRegistry,
  continuationPreflightProjector?: ZesContinuationPreflightProjectionSource,
  scopePublicationPreflight?: ScopePublicationPreflightSource,
): void {
  const scopeRefSchema = z
    .string()
    .regex(/^[a-f0-9]{16}$/)
    .describe(
      "Opaque execution scope reference returned by execution_scope_list. Omit to inspect the current scope.",
    );
  const clientCatalogInputSchema = {
    clientObservedSurfaceEpoch: z
      .string()
      .min(1)
      .max(256)
      .optional()
      .describe(
        "Optional exact surface epoch observed by this client after tools/list. This is an attestation, not server inference.",
      ),
    clientObservedFingerprintSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional()
      .describe(
        "Optional SHA-256 of the canonical complete client-observed tools/list descriptors.",
      ),
    clientObservedToolNames: z
      .array(z.string().min(1).max(1_024))
      .max(10_000)
      .optional()
      .describe(
        "Optional exact tool names from the same client-observed tools/list response.",
      ),
  };

  registerAppTool(
    server,
    "execution_scope_list",
    {
      title: "List DevSpace execution scopes",
      description:
        "List recent provider-neutral DevSpace execution scopes with activity, workspace, process, explicit capsule-derived semantic hints when available, and the current backend tool-surface fingerprint. The backend surface can be compared with the host-visible catalog, but DevSpace cannot read the host's cached tools/list result. A displayLabel is derived from the capsule mission/frontier and is not a host chat title. No semantic state is inferred from filenames or tool events. Observation gaps expose that model progress and provider generation are unobservable between MCP calls; they do not classify a model as reasoning or hung. This is read-only executor observability, not a transcript, task store, writer lease, checkpoint, memory, or product authority.",
      inputSchema: {
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Maximum scopes to return. Defaults to 20."),
        ...clientCatalogInputSchema,
      },
      outputSchema: resultOutputSchema({ data: z.unknown() }),
      ...toolWidgetDescriptorMeta(config, "read"),
      annotations: CODEX_SESSION_TOOL_ANNOTATIONS,
    },
    async ({
      limit,
      clientObservedSurfaceEpoch,
      clientObservedFingerprintSha256,
      clientObservedToolNames,
    }, { _meta }) => {
      const listed = executionScopes.list(executionScopeIdentity(_meta), limit);
      const backendRuntime = runtimeCapabilities.snapshot({
        clientInput: {
          clientObservedSurfaceEpoch,
          clientObservedFingerprintSha256,
          clientObservedToolNames,
        },
      });
      if (!Array.isArray(listed.scopes)) {
        return jsonToolResponse({ ...listed, backendRuntime });
      }
      const scopes = listed.scopes.filter(isRecord);
      return jsonToolResponse({
        ...listed,
        backendRuntime,
        scopes: scopes.map((scope) => {
          const scopeRef = typeof scope.scopeRef === "string"
            ? scope.scopeRef
            : undefined;
          const totalEventCount = typeof scope.totalEventCount === "number"
            ? scope.totalEventCount
            : undefined;
          const semanticHint = scopeRef
            ? turnContinuity.semanticListHintForScope(
                scopeRef,
                { observedScopeTotalEventCount: totalEventCount },
              )
            : undefined;
          const displayLabel = semanticHint?.available === true
            && typeof semanticHint.displayLabel === "string"
              ? semanticHint.displayLabel
              : undefined;
          return {
            ...scope,
            runtimeRelation: scopeRuntimeRelation(scope, backendRuntime),
            ...(displayLabel
              ? {
                  displayLabel,
                  displayLabelSource: semanticHint?.displayLabelSource,
                  displayLabelIsHostChatTitle: false,
                }
              : {}),
            ...(semanticHint === undefined ? {} : { semanticHint }),
          };
        }),
      });
    },
  );

  registerAppTool(
    server,
    "execution_scope_status",
    {
      title: "Inspect DevSpace execution scope",
      description:
        "Read one DevSpace execution scope by opaque scopeRef, including linked workspaces, live process sessions, the observation gap since the last MCP/tool event, the current backend runtime/tool-surface fingerprint, and—when the target explicitly recorded one—the latest bounded semantic recovery capsule joined with local workspace freshness and later activity. Omit scopeRef for the current host scope. This stable bootstrap route can also carry additive read-only server-owned control-plane capability projections, so a frozen client catalog does not have to discover a newer top-level tool before reading a fixed continuation preflight. The server reports which critical tools are currently registered but cannot observe the host's cached tools/list result. Model progress and provider generation are not observable between MCP calls, so status never claims that a silent interval is normal reasoning or a hang. Semantic state is never inferred from filenames or tool events. Raw host session IDs, prompts, private reasoning, credentials, tool outputs, patches, and raw commands are never returned; capsule and control-plane projections remain executor-local observation rather than task, decision, writer, effect, or publication authority.",
      inputSchema: {
        scopeRef: scopeRefSchema.optional(),
        ...clientCatalogInputSchema,
      },
      outputSchema: resultOutputSchema({ data: z.unknown() }),
      ...toolWidgetDescriptorMeta(config, "read"),
      annotations: CODEX_SESSION_TOOL_ANNOTATIONS,
    },
    async ({
      scopeRef,
      clientObservedSurfaceEpoch,
      clientObservedFingerprintSha256,
      clientObservedToolNames,
    }, { _meta }) => {
      const status = executionScopes.status(
        scopeRef,
        executionScopeIdentity(_meta),
      );
      const scope = isRecord(status.scope) ? status.scope : undefined;
      const targetScopeRef = typeof scope?.scopeRef === "string"
        ? scope.scopeRef
        : undefined;
      const lastActivityAtMs = typeof scope?.lastActivityAt === "string"
        ? Date.parse(scope.lastActivityAt)
        : undefined;
      const totalEventCount = typeof scope?.totalEventCount === "number"
        ? scope.totalEventCount
        : undefined;
      const semanticRecovery = targetScopeRef
        ? await turnContinuity.semanticProjectionForScope(targetScopeRef, {
            observedScopeLastActivityAtMs:
              lastActivityAtMs !== undefined && Number.isFinite(lastActivityAtMs)
                ? lastActivityAtMs
                : undefined,
            observedScopeTotalEventCount: totalEventCount,
          })
        : undefined;
      const backendRuntime = runtimeCapabilities.snapshot({
        clientInput: {
          clientObservedSurfaceEpoch,
          clientObservedFingerprintSha256,
          clientObservedToolNames,
        },
      });
      const continuationPreflight = continuationPreflightProjector
        ? await continuationPreflightProjector.project()
        : undefined;
      const scopePublication = continuationPreflight && scopePublicationPreflight
        ? await scopePublicationPreflight.assess({
            workspaces: status.workspaces,
            semanticRecovery,
            continuationPreflight,
          })
        : undefined;
      const stableControlPlane = continuationPreflight
        ? stableControlPlaneProjection(
            continuationPreflight,
            scopePublication,
          )
        : undefined;
      return jsonToolResponse({
        ...status,
        backendRuntime,
        ...(scope === undefined
          ? {}
          : { runtimeRelation: scopeRuntimeRelation(scope, backendRuntime) }),
        ...(semanticRecovery === undefined ? {} : { semanticRecovery }),
        ...(stableControlPlane === undefined ? {} : { stableControlPlane }),
      });
    },
  );

  registerAppTool(
    server,
    "execution_scope_audit",
    {
      title: "Audit DevSpace execution scope",
      description:
        "Read a bounded newest-first operational audit for one DevSpace execution scope together with the current backend runtime/tool-surface fingerprint. Events contain tool lifecycle, safe workspace/process locators, digests and normalized error categories only; no transcript, prompts, private reasoning, tool output, native file handles, credentials, patches, raw exception messages, or raw shell commands are captured.",
      inputSchema: {
        scopeRef: scopeRefSchema.optional(),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Maximum events to return. Defaults to 30."),
        cursor: z
          .string()
          .max(64)
          .optional()
          .describe("Opaque nextCursor returned by a prior audit call."),
      },
      outputSchema: resultOutputSchema({ data: z.unknown() }),
      ...toolWidgetDescriptorMeta(config, "read"),
      annotations: CODEX_SESSION_TOOL_ANNOTATIONS,
    },
    async ({ scopeRef, limit, cursor }, { _meta }) => jsonToolResponse({
      ...executionScopes.audit(
        scopeRef,
        executionScopeIdentity(_meta),
        { limit, cursor },
      ),
      backendRuntime: runtimeCapabilities.snapshot(),
    }),
  );
}

function registerExecutionMailboxTools(
  server: McpServer,
  config: ServerConfig,
  executionMailbox: ExecutionMailboxManager,
): void {
  if (!config.executionMailbox.enabled) return;
  const scopeRefSchema = z
    .string()
    .regex(/^[a-f0-9]{16}$/)
    .describe("Opaque target scopeRef returned by execution_scope_list.");
  const messageIdSchema = z
    .string()
    .regex(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
    .describe("Execution message identifier returned by send or inbox.");
  const mailboxAnnotations = {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  };

  registerAppTool(
    server,
    "execution_scope_message_send",
    {
      title: "Send execution-scope message",
      description:
        "Persist one provider-neutral message for another DevSpace execution scope. Acceptance means the owner-only mailbox stored it; it does not mean the target WebChat was awakened or has observed it. Reuse the exact idempotencyKey on retries.",
      inputSchema: {
        targetScopeRef: scopeRefSchema,
        idempotencyKey: z
          .string()
          .min(1)
          .max(200)
          .describe("Stable sender-chosen retry key. Reuse it only for the exact same payload."),
        kind: z.enum([
          "instruction",
          "correction",
          "question",
          "notice",
          "handoff",
        ]),
        priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
        body: z
          .string()
          .min(1)
          .max(config.executionMailbox.maxBodyCharacters)
          .describe("Message content. Do not include credentials or private model reasoning."),
        correlationRef: z.string().min(1).max(1_000).optional(),
        expiresInHours: z
          .number()
          .positive()
          .max(config.executionMailbox.maxTtlMs / 3_600_000)
          .optional(),
      },
      outputSchema: resultOutputSchema({ data: z.unknown() }),
      ...toolWidgetDescriptorMeta(config, "read"),
      annotations: mailboxAnnotations,
    },
    async (
      {
        targetScopeRef,
        idempotencyKey,
        kind,
        priority,
        body,
        correlationRef,
        expiresInHours,
      },
      { _meta },
    ) => jsonToolResponse(
      executionMailbox.send(executionScopeIdentity(_meta), {
        targetScopeRef,
        idempotencyKey,
        kind: kind as ExecutionMessageKind,
        priority: priority as ExecutionMessagePriority | undefined,
        body,
        correlationRef,
        expiresInHours,
      }),
    ),
  );

  registerAppTool(
    server,
    "execution_scope_message_inbox",
    {
      title: "Read execution-scope inbox",
      description:
        "Read messages addressed to the current execution scope. Returned messages are atomically marked observed. This cannot read another scope's inbox and does not imply acknowledgement or action.",
      inputSchema: {
        limit: z.number().int().min(1).max(50).optional(),
        cursor: z.string().max(512).optional(),
        includeTerminal: z
          .boolean()
          .optional()
          .describe("Include acted and expired messages for local review. Defaults to false."),
      },
      outputSchema: resultOutputSchema({ data: z.unknown() }),
      ...toolWidgetDescriptorMeta(config, "read"),
      annotations: mailboxAnnotations,
    },
    async ({ limit, cursor, includeTerminal }, { _meta }) => jsonToolResponse(
      executionMailbox.inbox(
        executionScopeIdentity(_meta),
        { limit, cursor, includeTerminal },
      ),
    ),
  );

  registerAppTool(
    server,
    "execution_scope_message_status",
    {
      title: "Read execution message status",
      description:
        "Read accepted, observed, acknowledged, acted, or expired state for one message. Only its sender or target scope may inspect it.",
      inputSchema: { messageId: messageIdSchema },
      outputSchema: resultOutputSchema({ data: z.unknown() }),
      ...toolWidgetDescriptorMeta(config, "read"),
      annotations: CODEX_SESSION_TOOL_ANNOTATIONS,
    },
    async ({ messageId }, { _meta }) => jsonToolResponse(
      executionMailbox.status(executionScopeIdentity(_meta), messageId),
    ),
  );

  registerAppTool(
    server,
    "execution_scope_message_receipt",
    {
      title: "Record execution message receipt",
      description:
        "Record a monotonic target-bound acknowledgement or acted receipt. Only the addressed execution scope may update the message; retries are idempotent and cannot move state backward.",
      inputSchema: {
        messageId: messageIdSchema,
        state: z.enum(["acknowledged", "acted"]),
        note: z.string().min(1).max(4_000).optional(),
      },
      outputSchema: resultOutputSchema({ data: z.unknown() }),
      ...toolWidgetDescriptorMeta(config, "read"),
      annotations: mailboxAnnotations,
    },
    async ({ messageId, state, note }, { _meta }) => jsonToolResponse(
      executionMailbox.receipt(executionScopeIdentity(_meta), {
        messageId,
        state: state as ExecutionMessageReceiptState,
        note,
      }),
    ),
  );
}

function registerTurnContinuityTools(
  server: McpServer,
  config: ServerConfig,
  turnContinuity: TurnContinuityManager,
  workspaces: WorkspaceRegistry,
): void {
  if (!config.turnContinuity.enabled) return;
  const advisoryWriteAnnotations = {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  };
  const listSchema = z
    .array(z.string().min(1).max(2_000))
    .max(50)
    .optional();

  registerAppTool(
    server,
    "turn_horizon_begin",
    {
      title: "Begin advisory turn horizon",
      description:
        "Begin or recover one advisory assistant-turn horizon when the MCP host supplies no exact turn identity. This never creates, limits, completes, or schedules a task; it never blocks tools. Reuse the exact idempotencyKey only when retrying the same begin call.",
      inputSchema: {
        idempotencyKey: z
          .string()
          .min(1)
          .max(200)
          .describe("Stable retry key for this exact assistant-turn begin call."),
        reason: z.enum(["new_turn", "recovery_after_cutoff", "manual_test"]),
      },
      outputSchema: resultOutputSchema({ data: z.unknown() }),
      ...toolWidgetDescriptorMeta(config, "read"),
      annotations: advisoryWriteAnnotations,
    },
    async ({ idempotencyKey, reason }, { _meta }) => jsonToolResponse(
      turnContinuity.begin(
        executionScopeIdentity(_meta),
        executorTurnMetadata(_meta),
        {
          idempotencyKey,
          reason: reason as TurnHorizonBeginReason,
        },
      ),
    ),
  );

  registerAppTool(
    server,
    "turn_horizon_status",
    {
      title: "Read advisory turn horizon",
      description:
        "Read the current advisory horizon, estimated or exact remaining time, and whether observed mutations occurred after the latest capsule. This is scheduling guidance only: tools remain available and no task completion, commit, yield, or quality reduction is required.",
      inputSchema: {},
      outputSchema: resultOutputSchema({ data: z.unknown() }),
      ...toolWidgetDescriptorMeta(config, "read"),
      annotations: CODEX_SESSION_TOOL_ANNOTATIONS,
    },
    async (_input, { _meta }) => jsonToolResponse(
      turnContinuity.status(
        executionScopeIdentity(_meta),
        executorTurnMetadata(_meta),
      ),
    ),
  );

  registerAppTool(
    server,
    "recovery_capsule_record",
    {
      title: "Record executor recovery capsule",
      description:
        "Persist one Git-bound executor-local recovery capsule for the exact opened workspace. It records a recoverable causal frontier, not task completion or canonical truth. Include exact authorityStateRefs from current rightful-owner readback when available; local Git freshness alone never proves canonical freshness. Intentional dirty state is valid. Do not include credentials, transcripts, or private model reasoning; reuse the exact idempotencyKey only for the same semantic payload and workspace state.",
      inputSchema: {
        workspaceId: z.string().describe(workspaceIdDescription),
        idempotencyKey: z
          .string()
          .min(1)
          .max(200)
          .describe("Stable retry key for this exact capsule payload and workspace state."),
        intent: z.enum(["rolling", "turn_boundary", "before_effect", "after_effect"]),
        missionRef: z.string().min(1).max(1_000).optional(),
        authorityOwnerRefs: listSchema.describe(
          "Rightful canonical/runtime/writer/effect owners consulted for this frontier.",
        ),
        authorityStateRefs: listSchema.describe(
          "Exact immutable generation, decision, Git-main, writer, runtime, or effect refs observed from those owners at record time.",
        ),
        currentFrontier: z.string().min(1).max(4_000),
        currentCausalSlice: z.string().min(1).max(4_000),
        established: listSchema,
        validationState: z.enum(["unknown", "not_run", "partial", "failed", "passed"]),
        validationRefs: listSchema,
        worktreeState: z.enum(["clean", "intentional_dirty", "unknown"]),
        effectState: z.enum(["none", "in_flight", "terminal", "unknown"]),
        effectKeys: listSchema,
        writerState: z.enum(["none", "held", "released", "unknown"]).optional(),
        writerRefs: listSchema,
        retryPolicy: z.enum([
          "normal",
          "forbidden",
          "reconcile_before_retry",
          "owner_authorization_required",
        ]),
        safeToMutate: z.boolean().optional(),
        safeToPublish: z.boolean().optional(),
        exactNextAction: z.string().min(1).max(4_000),
        doNotRepeat: listSchema,
        unresolved: listSchema,
        checkpointRefs: listSchema,
        notes: z.string().min(1).max(4_000).optional(),
      },
      outputSchema: resultOutputSchema({ data: z.unknown() }),
      ...toolWidgetDescriptorMeta(config, "read"),
      annotations: advisoryWriteAnnotations,
    },
    async (
      {
        workspaceId,
        idempotencyKey,
        intent,
        missionRef,
        authorityOwnerRefs,
        authorityStateRefs,
        currentFrontier,
        currentCausalSlice,
        established,
        validationState,
        validationRefs,
        worktreeState,
        effectState,
        effectKeys,
        writerState,
        writerRefs,
        retryPolicy,
        safeToMutate,
        safeToPublish,
        exactNextAction,
        doNotRepeat,
        unresolved,
        checkpointRefs,
        notes,
      },
      { _meta },
    ) => jsonToolResponse(
      await turnContinuity.recordCapsule(
        executionScopeIdentity(_meta),
        workspaces.getWorkspace(workspaceId),
        {
          idempotencyKey,
          intent: intent as RecoveryCapsuleIntent,
          missionRef,
          authorityOwnerRefs,
          authorityStateRefs,
          currentFrontier,
          currentCausalSlice,
          established,
          validationState: validationState as RecoveryValidationState,
          validationRefs,
          worktreeState: worktreeState as RecoveryWorktreeState,
          effectState: effectState as RecoveryEffectState,
          effectKeys,
          writerState: writerState as RecoveryWriterState | undefined,
          writerRefs,
          retryPolicy: retryPolicy as RecoveryRetryPolicy,
          safeToMutate,
          safeToPublish,
          exactNextAction,
          doNotRepeat,
          unresolved,
          checkpointRefs,
          notes,
        } satisfies RecoveryCapsuleInput,
      ),
    ),
  );

  registerAppTool(
    server,
    "recovery_capsule_status",
    {
      title: "Read executor recovery capsule",
      description:
        "Read the latest capsule for the exact opened workspace root across retained execution scopes and compare it with current Git-bound state. Optionally supply exact currentAuthorityStateRefs obtained from fresh rightful-owner readback; without them, canonical freshness remains unverified even when the local workspace matches. A stale capsule is returned for reconciliation but cannot authorize blind replay, mutation, effect retry, or publication.",
      inputSchema: {
        workspaceId: z.string().describe(workspaceIdDescription),
        currentAuthorityStateRefs: listSchema.describe(
          "Exact current canonical/runtime/writer/effect refs from fresh external owner readback. Time or TTL is not a substitute.",
        ),
      },
      outputSchema: resultOutputSchema({ data: z.unknown() }),
      ...toolWidgetDescriptorMeta(config, "read"),
      annotations: CODEX_SESSION_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, currentAuthorityStateRefs }, { _meta }) => jsonToolResponse(
      await turnContinuity.capsuleStatus(
        executionScopeIdentity(_meta),
        workspaces.getWorkspace(workspaceId),
        { currentAuthorityStateRefs },
      ),
    ),
  );
}

function registerLocalAgentTools(
  server: McpServer,
  config: ServerConfig,
  coordinator: LocalAgentCoordinator,
): void {
  if (!config.subagents) return;
  const agentIdSchema = z
    .string()
    .regex(/^agt_[a-f0-9]{8}$/)
    .describe("Exact DevSpace local-agent session ID returned by list or status.");
  const turnIdSchema = z
    .string()
    .regex(/^atn_[a-f0-9]{32}$/)
    .describe("Exact durable local-agent turn ID returned by send or status.");
  const agentMessageAnnotations = {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  };
  const agentControlAnnotations = {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  };

  registerAppTool(
    server,
    "local_agent_session_list",
    {
      title: "List DevSpace local-agent sessions",
      description:
        "List durable DevSpace-managed agent sessions and queue summaries. These are executor-local provider sessions, not standing ZES agent identities or canonical work authority.",
      inputSchema: {
        workspaceId: z
          .string()
          .optional()
          .describe("Optionally restrict sessions to one open DevSpace workspace."),
      },
      outputSchema: resultOutputSchema({ data: z.unknown() }),
      ...toolWidgetDescriptorMeta(config, "read"),
      annotations: CODEX_SESSION_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId }) => jsonToolResponse({
      sessions: coordinator.listSessions(workspaceId ? { workspaceId } : {}),
    }),
  );

  registerAppTool(
    server,
    "local_agent_session_status",
    {
      title: "Inspect DevSpace local-agent session",
      description:
        "Read one local-agent provider session, continuation capability, queue state, lease state, and recent durable turns.",
      inputSchema: {
        agentId: agentIdSchema,
        turnLimit: z.number().int().min(1).max(100).optional(),
      },
      outputSchema: resultOutputSchema({ data: z.unknown() }),
      ...toolWidgetDescriptorMeta(config, "read"),
      annotations: CODEX_SESSION_TOOL_ANNOTATIONS,
    },
    async ({ agentId, turnLimit }) => jsonToolResponse(
      coordinator.sessionStatus(agentId, {
        includeRecentTurns: true,
        turnLimit,
      }),
    ),
  );

  registerAppTool(
    server,
    "local_agent_session_resume",
    {
      title: "Resume paused DevSpace local-agent session",
      description:
        "Clear an ordinary failed-session pause or reconcile queued/active work whose worker lease disappeared, then request one serialized worker when safe. This cannot bypass an indeterminate turn; reconcile that exact turn first.",
      inputSchema: {
        agentId: agentIdSchema,
        note: z
          .string()
          .min(1)
          .max(4_000)
          .optional()
          .describe("Optional reason or evidence for resuming after the provider failure."),
      },
      outputSchema: resultOutputSchema({ data: z.unknown() }),
      ...toolWidgetDescriptorMeta(config, "read"),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ agentId, note }) => jsonToolResponse(
      coordinator.resumeSession(agentId, note),
    ),
  );

  registerAppTool(
    server,
    "local_agent_message_send",
    {
      title: "Send message to DevSpace local-agent session",
      description:
        "Enqueue one durable provider-neutral message for an existing DevSpace-managed Codex, Claude, OpenCode, or Pi session. A worker lease serializes provider turns; acceptance means queued, not completed. Reuse the exact idempotencyKey on retries.",
      inputSchema: {
        agentId: agentIdSchema,
        idempotencyKey: z.string().min(1).max(200),
        kind: z.enum([
          "instruction",
          "correction",
          "question",
          "notice",
          "handoff",
        ]),
        priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
        body: z
          .string()
          .min(1)
          .max(config.localAgentQueue.maxBodyCharacters)
          .describe("Message content. Do not include credentials or private reasoning."),
        correlationRef: z.string().min(1).max(1_000).optional(),
        supersedePending: z
          .boolean()
          .optional()
          .describe("Cancel older queued turns before adding this turn. Running work is never superseded."),
      },
      outputSchema: resultOutputSchema({ data: z.unknown() }),
      ...toolWidgetDescriptorMeta(config, "read"),
      annotations: agentMessageAnnotations,
    },
    async (
      {
        agentId,
        idempotencyKey,
        kind,
        priority,
        body,
        correlationRef,
        supersedePending,
      },
      { _meta },
    ) => jsonToolResponse(
      coordinator.enqueueExecutionMessage(executionScopeIdentity(_meta), {
        agentId,
        idempotencyKey,
        kind: kind as ExecutionMessageKind,
        priority: priority as ExecutionMessagePriority | undefined,
        body,
        correlationRef,
        supersedePending,
      }),
    ),
  );

  registerAppTool(
    server,
    "local_agent_turn_status",
    {
      title: "Read local-agent turn status",
      description:
        "Read queued, claimed, running, cancel-requested, succeeded, failed, cancelled, or indeterminate state for one durable provider turn.",
      inputSchema: { turnId: turnIdSchema },
      outputSchema: resultOutputSchema({ data: z.unknown() }),
      ...toolWidgetDescriptorMeta(config, "read"),
      annotations: CODEX_SESSION_TOOL_ANNOTATIONS,
    },
    async ({ turnId }) => jsonToolResponse(coordinator.turnStatus(turnId)),
  );

  registerAppTool(
    server,
    "local_agent_turn_cancel",
    {
      title: "Cancel local-agent turn",
      description:
        "Cancel a queued/claimed turn immediately or request best-effort native cancellation for a running provider turn. A request is not reported as cancelled until provider execution actually stops or terminates.",
      inputSchema: {
        turnId: turnIdSchema,
        note: z.string().min(1).max(4_000).optional(),
      },
      outputSchema: resultOutputSchema({ data: z.unknown() }),
      ...toolWidgetDescriptorMeta(config, "read"),
      annotations: agentControlAnnotations,
    },
    async ({ turnId, note }) => jsonToolResponse(
      coordinator.cancelTurn(turnId, note),
    ),
  );

  registerAppTool(
    server,
    "local_agent_turn_resolve",
    {
      title: "Reconcile indeterminate local-agent turn",
      description:
        "Explicitly reconcile a turn left indeterminate after a stale worker lease. retry may duplicate an unknown provider effect; cancelled or succeeded records the Owner's evidence-backed resolution and unblocks later queued turns.",
      inputSchema: {
        turnId: turnIdSchema,
        resolution: z.enum(["retry", "cancelled", "succeeded"]),
        note: z.string().min(1).max(4_000),
        providerSessionIdAfter: z.string().min(1).max(2_000).optional(),
        finalResponse: z
          .string()
          .max(config.localAgentQueue.maxResponseCharacters)
          .optional(),
      },
      outputSchema: resultOutputSchema({ data: z.unknown() }),
      ...toolWidgetDescriptorMeta(config, "read"),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (
      {
        turnId,
        resolution,
        note,
        providerSessionIdAfter,
        finalResponse,
      },
    ) => jsonToolResponse(
      coordinator.resolveTurn(turnId, resolution, note, {
        providerSessionIdAfter,
        finalResponse,
      }),
    ),
  );
}

function localAgentWorkerEntrypoint(): string {
  const currentModule = fileURLToPath(import.meta.url);
  return fileURLToPath(
    new URL(currentModule.endsWith(".ts") ? "./cli.ts" : "./cli.js", import.meta.url),
  );
}

function registerCodexProcessTools(
  server: McpServer,
  config: ServerConfig,
  workspaces: WorkspaceRegistry,
  processSessions: ProcessSessionManager,
  executionMailbox: ExecutionMailboxManager,
  researchCycle: ZesResearchCycleManager,
): void {
  registerAppTool(
    server,
    "exec_command",
    {
      title: "Execute command",
      description:
        "Run a command in a workspace. Returns its result when it exits during the yield window, otherwise returns a sessionId for write_stdin. Use this for file inspection, tests, builds, package scripts, and long-running processes.",
      inputSchema: {
        workspaceId: z.string().describe(workspaceIdDescription),
        cmd: z.string().min(1).describe("Shell command to execute."),
        tty: z
          .boolean()
          .optional()
          .describe("Allocate a pseudo-terminal for interactive commands. Defaults to false."),
        columns: z.number().int().min(1).max(1_000).optional().describe("Initial PTY width. Defaults to 80."),
        rows: z.number().int().min(1).max(1_000).optional().describe("Initial PTY height. Defaults to 24."),
        workingDirectory: z
          .string()
          .optional()
          .describe("Working directory relative to the workspace root. Defaults to the workspace root."),
        yieldTimeMs: z
          .number()
          .int()
          .min(0)
          .max(MAX_COMMAND_YIELD_MS)
          .optional()
          .describe(
            `Milliseconds to wait before returning a running session. Defaults to ${DEFAULT_EXEC_YIELD_MS}.`,
          ),
        maxOutputTokens: z
          .number()
          .int()
          .positive()
          .max(100_000)
          .optional()
          .describe("Approximate output token budget. Defaults to 10000."),
      },
      outputSchema: processOutputSchema(),
      ...toolWidgetDescriptorMeta(config, "shell"),
      annotations: SHELL_TOOL_ANNOTATIONS,
    },
    async (
      { workspaceId, cmd, tty, columns, rows, workingDirectory, yieldTimeMs, maxOutputTokens },
      { _meta },
    ) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      const researchTarget = {
        workspaceId: workspace.id,
        root: workspace.root,
      };
      const guard = await researchCycle.guardCommand(researchTarget, cmd);
      if (!guard.allowed) return researchGuardFailure(guard);
      const cwd = workspaces.resolveWorkingDirectory(workspace, workingDirectory);
      const snapshot = await processSessions.start({
        workspaceId,
        executionScopeRef: executionScopeIdentity(_meta)?.scopeRef,
        command: cmd,
        cwd,
        workspaceRoot: workspace.root,
        tty,
        columns,
        rows,
        yieldTimeMs,
        maxOutputTokens,
      });
      const researchNotice = await researchObservationNotice(
        config,
        "exec_command",
        () => researchCycle.observeCommandSnapshot(
          researchTarget,
          cmd,
          snapshot,
        ),
      );

      logToolCall(config, {
        tool: "exec_command",
        workspaceId,
        workingDirectory: workingDirectory ?? ".",
        command: cmd,
        commandLength: cmd.length,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return appendToolNotice(
        processToolResponse("exec_command", workspaceId, snapshot, {
          command: cmd,
          workingDirectory: workingDirectory ?? ".",
          running: snapshot.running,
          exitCode: snapshot.exitCode,
          wallTimeMs: snapshot.wallTimeMs,
        }),
        researchNotice,
        "zesResearchCycleNotice",
      );
    },
  );

  registerAppTool(
    server,
    "write_stdin",
    {
      title: "Write to process",
      description:
        "Poll or write characters to a process returned by exec_command. A pure poll returns as soon as new output arrives or the process exits; its timeout is only a bounded ceiling. Omit chars or pass an empty string to poll. Pass \\u0003 to send Ctrl-C.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace identifier used to start the process."),
        sessionId: z.number().describe("Process session identifier returned by exec_command."),
        chars: z.string().optional().describe("Characters to write. Omit or pass an empty string to poll."),
        columns: z.number().int().min(1).max(1_000).optional().describe("Resize a PTY to this width."),
        rows: z.number().int().min(1).max(1_000).optional().describe("Resize a PTY to this height."),
        yieldTimeMs: z
          .number()
          .int()
          .min(0)
          .max(MAX_POLL_YIELD_MS)
          .optional()
          .describe(
            `For a pure poll, the maximum wait for new output or completion; defaults to ${DEFAULT_POLL_YIELD_MS} and supports up to ${MAX_POLL_YIELD_MS}. Calls that send input or resize default to ${DEFAULT_INTERACTIVE_YIELD_MS} and are bounded to ${MAX_COMMAND_YIELD_MS}.`,
          ),
        maxOutputTokens: z
          .number()
          .int()
          .positive()
          .max(100_000)
          .optional()
          .describe("Approximate output token budget. Defaults to 10000."),
      },
      outputSchema: processOutputSchema(),
      ...toolWidgetDescriptorMeta(config, "shell"),
      annotations: SHELL_TOOL_ANNOTATIONS,
    },
    async (
      { workspaceId, sessionId, chars, columns, rows, yieldTimeMs, maxOutputTokens },
      { _meta },
    ) => {
      const startedAt = performance.now();
      const researchTarget = researchWorkspace(workspaces, workspaceId);
      if (chars && chars !== "\u0003") {
        const guard = await researchCycle.guardProcessInput(
          researchTarget,
          sessionId,
        );
        if (!guard.allowed) return researchGuardFailure(guard);
      }
      const identity = executionScopeIdentity(_meta);
      const purePoll = (chars ?? "") === ""
        && columns === undefined
        && rows === undefined;
      const waiter =
        purePoll && identity && config.executionMailbox.enabled
          ? executionMailbox.createWaiter(identity.scopeRef)
          : undefined;
      let snapshot: ProcessSnapshot;
      try {
        snapshot = await processSessions.write({
          workspaceId,
          sessionId,
          chars,
          columns,
          rows,
          yieldTimeMs,
          maxOutputTokens,
          externalWake: waiter?.promise,
        });
      } finally {
        waiter?.cancel();
      }
      const researchNotice = await researchObservationNotice(
        config,
        "write_stdin",
        () => researchCycle.observeProcessSnapshot(
          researchTarget,
          sessionId,
          snapshot,
        ),
      );

      logToolCall(config, {
        tool: "write_stdin",
        workspaceId,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return appendToolNotice(
        processToolResponse("write_stdin", workspaceId, snapshot, {
          sessionId,
          charactersWritten: chars?.length ?? 0,
          running: snapshot.running,
          exitCode: snapshot.exitCode,
          wakeReason: snapshot.wakeReason,
          wallTimeMs: snapshot.wallTimeMs,
        }),
        researchNotice,
        "zesResearchCycleNotice",
      );
    },
  );
}

export function createMcpServer(
  config: ServerConfig,
  workspaces: WorkspaceRegistry,
  reviewCheckpoints: ReturnType<typeof createReviewCheckpointManager>,
  processSessions: ProcessSessionManager,
  localAgentProviders: LocalAgentProviderAvailability[],
  incomingArtifactAdapters: readonly IncomingArtifactAdapter[],
  executionScopes?: ExecutionScopeManager,
  executionMailbox?: ExecutionMailboxManager,
  localAgentCoordinator?: LocalAgentCoordinator,
  turnContinuity?: TurnContinuityManager,
  runtimeCapabilities?: RuntimeCapabilityRegistry,
  researchCycle?: ZesResearchCycleManager,
  continuationPreflightProjector?: ZesContinuationPreflightProjectionSource,
  scopePublicationPreflight?: ScopePublicationPreflightSource,
): McpServer {
  const ownsExecutionScopes = executionScopes === undefined;
  const ownsExecutionMailbox = executionMailbox === undefined;
  const ownsLocalAgentCoordinator = config.subagents && localAgentCoordinator === undefined;
  const ownsTurnContinuity = turnContinuity === undefined;
  const activeExecutionScopes = executionScopes ?? new ExecutionScopeManager(
    config.executionObservability,
    config.stateDir,
    processSessions,
  );
  const activeExecutionMailbox = executionMailbox ?? new ExecutionMailboxManager(
    config.executionMailbox,
    config.stateDir,
  );
  const activeTurnContinuity = turnContinuity ?? new TurnContinuityManager(
    config.turnContinuity,
    config.stateDir,
  );
  const activeRuntimeCapabilities = runtimeCapabilities
    ?? new RuntimeCapabilityRegistry(config);
  const activeResearchCycle = researchCycle
    ?? new ZesResearchCycleManager(config.zesResearchCycle);
  const lifecycleStore = workspaces.lifecycleStore();
  const activeWorkspaceLifecycle = lifecycleStore
    ? new WorkspaceLifecycleManager(
        config,
        lifecycleStore,
        workspaces,
        processSessions,
      )
    : undefined;
  const activeLocalAgentCoordinator = config.subagents
    ? localAgentCoordinator ?? new LocalAgentCoordinator(config, {
        launchWorker: (agentId, workerId) => launchDetachedLocalAgentWorker(
          localAgentWorkerEntrypoint(),
          agentId,
          workerId,
        ),
      })
    : undefined;
  const server = new McpServer(
    {
      name: "devspace",
      title: "DevSpace",
      version: config.mcpServerVersion,
      description:
        "Coding tools for project workspaces, advisory turn continuity and Git-bound recovery capsules, execution-scope observability and messaging, serialized local-agent provider continuation, and optional read-only inspection of the exact live AOQ Codex adapter and worktree.",
    },
    {
      instructions: serverInstructions(config),
    },
  );

  toolExecutionContexts.set(server, {
    executionScopes: activeExecutionScopes,
    executionMailbox: activeExecutionMailbox,
    turnContinuity: activeTurnContinuity,
    runtimeCapabilities: activeRuntimeCapabilities,
    config,
  });

  registerAppResource(
    server,
    "DevSpace Diff Card",
    WORKSPACE_APP_URI,
    {
      description: "Interactive card for viewing DevSpace file diffs.",
      _meta: {
        ui: {
          csp: appCsp(config),
        },
      },
    },
    async () => {
      await assertWorkspaceAppAssets();
      return {
        contents: [
          {
            uri: WORKSPACE_APP_URI,
            mimeType: RESOURCE_MIME_TYPE,
            text: workspaceAppHtml(config),
            _meta: {
              ui: {
                csp: appCsp(config),
              },
            },
          },
        ],
      };
    },
  );

  registerExecutionScopeTools(
    server,
    config,
    activeExecutionScopes,
    activeTurnContinuity,
    activeRuntimeCapabilities,
    continuationPreflightProjector,
    scopePublicationPreflight,
  );
  registerExecutionMailboxTools(server, config, activeExecutionMailbox);
  registerTurnContinuityTools(
    server,
    config,
    activeTurnContinuity,
    workspaces,
  );
  if (activeLocalAgentCoordinator) {
    registerLocalAgentTools(server, config, activeLocalAgentCoordinator);
  }
  registerZesCodexInspectionTools(server, config, registerAppTool);
  registerZesContinuationPreflightTool(server, config, registerAppTool);
  registerZesResearchCycleTools(
    server,
    config,
    activeResearchCycle,
    (workspaceId) => researchWorkspace(workspaces, workspaceId),
    registerAppTool,
  );

  registerAppTool(
    server,
    "open_workspace",
    {
      title: "Open workspace",
      description:
        "Start work in a project directory or isolated worktree when no usable workspaceId exists for it. During continued work, reuse the existing workspaceId instead of calling this tool again. By default this uses the actual checkout; set mode=\"worktree\" for isolated or parallel work.",
      inputSchema: {
        path: z
          .string()
          .describe(
            "Absolute path, or a leading-tilde home path such as ~/project, to a project directory inside an allowed root.",
          ),
        mode: z
          .enum(["checkout", "worktree"])
          .optional()
          .describe(
            "Defaults to checkout, which works in the actual directory. Use worktree for isolated or parallel Git work.",
          ),
        baseRef: z
          .string()
          .optional()
          .describe("Git ref to base a worktree on. Only used with mode=\"worktree\". Defaults to HEAD."),
      },
      outputSchema: {
        workspaceId: z.string(),
        root: z.string(),
        mode: z.enum(["checkout", "worktree"]),
        sourceRoot: z.string().optional(),
        worktree: z
          .object({
            sourceRoot: z.string(),
            path: z.string(),
            baseRef: z.string(),
            baseSha: z.string(),
            dirtySource: z.boolean(),
            detached: z.boolean(),
            managed: z.boolean(),
          })
          .optional(),
        agentsFiles: z.array(workspaceAgentsFileOutputSchema).optional(),
        availableAgentsFiles: z.array(workspaceAvailableAgentsFileOutputSchema).optional(),
        instructionDiscovery: workspaceInstructionDiscoveryOutputSchema.optional(),
        skills: z.array(workspaceSkillOutputSchema).optional(),
        agentProviders: z.array(workspaceLocalAgentProviderOutputSchema).optional(),
        agents: z.array(workspaceLocalAgentOutputSchema).optional(),
        skillDiagnostics: z.array(z.unknown()).optional(),
        instruction: z.string(),
      },
      ...toolWidgetDescriptorMeta(config, "workspace"),
      annotations: { readOnlyHint: true },
    },
    async ({ path, mode, baseRef }, { _meta }) => {
      const startedAt = performance.now();
      const {
        workspace,
        agentsFiles,
        availableAgentsFiles,
        instructionDiscovery,
        workspaceReused,
        includeBootstrapContext,
      } = await workspaces.openWorkspace(
        { path, mode, baseRef },
        { conversationScopeId: executionScopeIdentity(_meta)?.scopeId },
      );
      if (config.widgets === "changes") {
        await reviewCheckpoints.initializeWorkspace({
          workspaceId: workspace.id,
          root: workspace.root,
        });
      }
      const cardSkills = workspace.skills
        .filter((skill) => !skill.disableModelInvocation)
        .map((skill) => ({
          name: skill.name,
          description: skill.description,
          path: formatPathForPrompt(skill.filePath),
        }));
      const cardAgentProviders = config.subagents ? localAgentProviders : [];
      const cardAgents = workspace.agentProfiles.map((profile) => {
        const summary = summarizeLocalAgentProfile(profile);
        const availability = cardAgentProviders.find((provider) => provider.name === summary.provider);
        return {
          ...summary,
          providerAvailable: availability?.available,
          providerUnavailableReason: availability?.reason,
        };
      });
      const cardAgentsFiles = agentsFiles.map((file) => ({
        path: formatAgentsPath(file.path, workspace.root),
        content: file.content,
      }));
      const cardAvailableAgentsFiles = availableAgentsFiles.map((file) => ({
        path: formatAgentsPath(file.path, workspace.root),
      }));
      const visibleSkills = includeBootstrapContext ? cardSkills : [];
      const visibleAgentProviders = includeBootstrapContext ? cardAgentProviders : [];
      const visibleAgents = includeBootstrapContext ? cardAgents : [];
      const loadedAgentsFiles = includeBootstrapContext ? cardAgentsFiles : [];
      const availableAgentsFileOutputs = includeBootstrapContext ? cardAvailableAgentsFiles : [];
      const discoveryWarning = incompleteInstructionDiscoveryMessage(instructionDiscovery);
      const standardCardInstruction = config.skillsEnabled
        ? "Use this workspaceId for subsequent work in this project. Keep reusing it while working in this project. Follow loaded agentsFiles instructions. Before working under a path listed in availableAgentsFiles, read that instruction file. When a task matches a listed skill, read its path before proceeding. Use skill_search only when a specialized project or host capability is needed but was not listed automatically."
        : "Use this workspaceId for subsequent work in this project. Keep reusing it while working in this project. Follow loaded agentsFiles instructions. Before working under a path listed in availableAgentsFiles, read that instruction file.";
      const cardInstruction = [standardCardInstruction, discoveryWarning]
        .filter(Boolean)
        .join("\n\n");
      const baseInstruction = workspaceReused
        ? [
            `Workspace already open as ${workspace.id}.`,
            "Continue with this workspaceId.",
            "Keep following the project instructions, nested instruction files, skills, agent profiles, and diagnostics already provided for this workspace.",
          ].join("\n\n")
        : workspace.mode === "worktree"
          ? "Use this workspaceId for subsequent work in this isolated worktree. Keep reusing it while working in this worktree. Follow the project instructions, nested instruction files, skills, agent profiles, and diagnostics returned for it."
          : standardCardInstruction;
      const instruction = [baseInstruction, discoveryWarning]
        .filter(Boolean)
        .join("\n\n");
      const resultContent: ToolContent[] = [
        {
          type: "text" as const,
          text: [
            workspaceReused
              ? `Workspace already open as ${workspace.id}.`
              : workspace.mode === "worktree"
                ? `Opened isolated worktree workspace ${workspace.id}.`
                : `Opened workspace ${workspace.id}.`,
            `Root: ${workspace.root}`,
            `Mode: ${workspace.mode}`,
            loadedAgentsFiles.length > 0
              ? `Loaded project instructions: ${loadedAgentsFiles.map((file) => file.path).join(", ")}`
              : undefined,
            availableAgentsFileOutputs.length > 0
              ? `Available nested instructions: ${availableAgentsFileOutputs.map((file) => file.path).join(", ")}`
              : undefined,
            discoveryWarning,
            visibleSkills.length > 0
              ? `Available skills: ${visibleSkills.map((skill) => skill.name).join(", ")}`
              : undefined,
            visibleAgentProviders.some((provider) => provider.available)
              ? `Available subagent providers: ${visibleAgentProviders.filter((provider) => provider.available).map((provider) => provider.name).join(", ")}`
              : undefined,
            visibleAgentProviders.some((provider) => !provider.available)
              ? `Unavailable subagent providers: ${visibleAgentProviders.filter((provider) => !provider.available).map(formatUnavailableAgentProvider).join(", ")}`
              : undefined,
            visibleAgents.length > 0
              ? `Available subagent profiles: ${visibleAgents.map(formatVisibleAgent).join(", ")}`
              : undefined,
            instruction,
          ].filter(Boolean).join("\n"),
        },
      ];
      logToolCall(config, {
        tool: "open_workspace",
        workspaceId: workspace.id,
        path: workspace.root,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
        instructionDiscoveryStatus: instructionDiscovery.status,
        instructionDiscoveryReason:
          instructionDiscovery.status === "incomplete" ? instructionDiscovery.reason : undefined,
        instructionDiscoveryFinder: instructionDiscovery.finder,
      });

      return {
        content: resultContent,
        _meta: {
          tool: "open_workspace",
          card: {
            workspaceId: workspace.id,
            root: workspace.root,
            path: workspace.root,
            mode: workspace.mode,
            workspaceReused,
            includeBootstrapContext,
            sourceRoot: workspace.sourceRoot,
            worktree: workspace.worktree,
            agentsFiles: cardAgentsFiles,
            ...(instructionDiscovery.status === "complete"
              ? { availableAgentsFiles: cardAvailableAgentsFiles }
              : {
                  instructionDiscovery: {
                    status: instructionDiscovery.status,
                    reason: instructionDiscovery.reason,
                  },
                }),
            skills: cardSkills,
            agentProviders: cardAgentProviders,
            agents: cardAgents,
            instruction: cardInstruction,
            summary: {
              mode: workspace.mode,
              agentsFiles: cardAgentsFiles.length,
              availableAgentsFiles: cardAvailableAgentsFiles.length,
              instructionDiscovery: instructionDiscovery.status,
              skills: cardSkills.length,
              agentProviders: cardAgentProviders.length,
              agents: cardAgents.length,
            },
          },
        },
        structuredContent: {
          workspaceId: workspace.id,
          root: workspace.root,
          mode: workspace.mode,
          sourceRoot: workspace.sourceRoot,
          worktree: workspace.worktree,
          ...(includeBootstrapContext
            ? {
                agentsFiles: loadedAgentsFiles,
                ...(instructionDiscovery.status === "complete"
                  ? { availableAgentsFiles: availableAgentsFileOutputs }
                  : {
                      instructionDiscovery: {
                        status: instructionDiscovery.status,
                        reason: instructionDiscovery.reason,
                      },
                    }),
                skills: visibleSkills,
                agentProviders: visibleAgentProviders,
                agents: visibleAgents,
                skillDiagnostics: workspace.skillDiagnostics,
              }
            : {}),
          instruction,
        },
      };
    },
  );

  if (activeWorkspaceLifecycle) {
    const gcInputSchema = {
      olderThanHours: z
        .number()
        .min(1)
        .max(365 * 24)
        .optional()
        .describe("Protect worktrees with activity newer than this many hours. Defaults to 24."),
      capsuleProtectionHours: z
        .number()
        .min(1)
        .max(365 * 24)
        .optional()
        .describe("Protect worktrees with a recovery capsule newer than this many hours. Defaults to 72."),
      includeSizes: z
        .boolean()
        .optional()
        .describe("Measure directory sizes for the plan. This can make preview slower."),
    };

    registerAppTool(
      server,
      toolNames.workspaceList,
      {
        title: "List workspaces",
        description:
          "List persisted DevSpace workspace sessions, optionally filtered by lifecycle state, mode, or managed-worktree ownership. This is executor-local state, not canonical task or writer authority.",
        inputSchema: {
          status: z.enum(["active", "closed"]).optional(),
          mode: z.enum(["checkout", "worktree"]).optional(),
          managed: z.boolean().optional(),
          limit: z.number().int().min(1).max(500).optional(),
        },
        outputSchema: resultOutputSchema({ data: z.unknown() }),
        ...toolWidgetDescriptorMeta(config, "workspace"),
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async (input) => {
        const startedAt = performance.now();
        const data = activeWorkspaceLifecycle.list(input);
        logToolCall(config, {
          tool: toolNames.workspaceList,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });
        return jsonToolResponse(data);
      },
    );

    registerAppTool(
      server,
      toolNames.workspaceStatus,
      {
        title: "Read workspace status",
        description:
          "Inspect one persisted workspace, including existence, Git preservation state, linked process sessions, external process references, and current close safety.",
        inputSchema: {
          workspaceId: z.string().describe(workspaceIdDescription),
        },
        outputSchema: resultOutputSchema({ data: z.unknown() }),
        ...toolWidgetDescriptorMeta(config, "workspace"),
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async ({ workspaceId }) => {
        const startedAt = performance.now();
        const data = await activeWorkspaceLifecycle.status(workspaceId);
        logToolCall(config, {
          tool: toolNames.workspaceStatus,
          workspaceId,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });
        return jsonToolResponse(data);
      },
    );

    registerAppTool(
      server,
      toolNames.workspaceClose,
      {
        title: "Close workspace",
        description:
          "Close one persisted workspace. Managed worktrees are removed by default only when no process references them, the tree is clean, and HEAD is reachable from a persistent ref. force must be explicit to override dirty or unpublished-commit protection; it never overrides a running-process boundary.",
        inputSchema: {
          workspaceId: z.string().describe(workspaceIdDescription),
          remove: z
            .boolean()
            .optional()
            .describe("Defaults to true for managed worktrees and false for checkouts."),
          force: z
            .boolean()
            .optional()
            .describe("Explicitly permit removal of dirty or unpublished managed-worktree state."),
        },
        outputSchema: resultOutputSchema({ data: z.unknown() }),
        ...toolWidgetDescriptorMeta(config, "workspace"),
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      async (input) => {
        const startedAt = performance.now();
        const data = await activeWorkspaceLifecycle.close(input);
        logToolCall(config, {
          tool: toolNames.workspaceClose,
          workspaceId: input.workspaceId,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });
        return jsonToolResponse(data);
      },
    );

    registerAppTool(
      server,
      toolNames.workspaceGcPreview,
      {
        title: "Preview workspace garbage collection",
        description:
          "Build a read-only, digest-bound garbage-collection plan for managed and orphan worktree directories. The plan protects loaded or recent workspaces, running processes, dirty trees, unpublished commits, unreadable Git state, and recent or active recovery capsules.",
        inputSchema: gcInputSchema,
        outputSchema: resultOutputSchema({ data: z.unknown() }),
        ...toolWidgetDescriptorMeta(config, "workspace"),
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async (input) => {
        const startedAt = performance.now();
        const data = await activeWorkspaceLifecycle.preview(input);
        logToolCall(config, {
          tool: toolNames.workspaceGcPreview,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });
        return jsonToolResponse(data);
      },
    );

    registerAppTool(
      server,
      toolNames.workspaceGcExecute,
      {
        title: "Execute workspace garbage collection",
        description:
          "Recompute and execute an exact workspace_gc_preview plan. The request fails when the plan digest changed; each candidate is revalidated again immediately before removal.",
        inputSchema: {
          ...gcInputSchema,
          planIdSha256: z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .describe("Exact planIdSha256 returned by workspace_gc_preview with the same options."),
        },
        outputSchema: resultOutputSchema({ data: z.unknown() }),
        ...toolWidgetDescriptorMeta(config, "workspace"),
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      async (input) => {
        const startedAt = performance.now();
        const data = await activeWorkspaceLifecycle.execute(input);
        logToolCall(config, {
          tool: toolNames.workspaceGcExecute,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });
        return jsonToolResponse(data);
      },
    );
  }

  if (config.skillsEnabled) {
    registerAppTool(
      server,
      toolNames.skillSearch,
      {
        title: "Find workspace skills",
        description:
          "Search the metadata-only skill catalog for one open workspace when a specialized project or host procedure is needed but was not listed by open_workspace. Project-local and context-matched skills are advertised automatically; host-global niche skills remain on demand. A result authorizes reading that exact SKILL.md but does not load or execute it.",
        inputSchema: {
          workspaceId: z
            .string()
            .describe(workspaceIdDescription),
          query: z
            .string()
            .min(2)
            .max(500)
            .describe(
              "Capability or procedure to find, such as 'Codex thread relay' or 'AOQ execution accelerator'.",
            ),
          limit: z
            .number()
            .int()
            .min(1)
            .max(20)
            .optional()
            .describe("Maximum matches. Defaults to 10."),
        },
        outputSchema: resultOutputSchema({
          workspaceId: z.string(),
          skills: z.array(workspaceSkillOutputSchema),
          instruction: z.string(),
        }),
        ...toolWidgetDescriptorMeta(config, "read"),
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async ({ workspaceId, query, limit }) => {
        const startedAt = performance.now();
        const matches = workspaces.searchSkills(workspaceId, query, limit ?? 10);
        const skills = matches.map((skill) => ({
          name: skill.name,
          description: skill.description,
          path: formatPathForPrompt(skill.filePath),
        }));
        const instruction = skills.length > 0
          ? "Read a returned SKILL.md only when it matches the current task. Reading it activates access to referenced files under that skill directory."
          : "No matching skill was found. Continue with normal workspace tools or refine the capability query; do not load unrelated skills.";
        const result = skills.length > 0
          ? `Matching skills: ${skills.map((skill) => skill.name).join(", ")}`
          : "No matching skills found.";

        logToolCall(config, {
          tool: toolNames.skillSearch,
          workspaceId,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });

        return {
          content: [{ type: "text" as const, text: `${result}\n${instruction}` }],
          structuredContent: {
            result,
            workspaceId,
            skills,
            instruction,
          },
        };
      },
    );
  }

  registerAppTool(
    server,
    toolNames.read,
    {
      title: "Read file",
      description:
        [
          "Read a file in a workspace. Use this for file inspection instead of shell commands like cat or sed.",
          "Use this tool to inspect relevant AGENTS.md or CLAUDE.md files listed by open_workspace before working in nested directories.",
          config.skillsEnabled
            ? "If a skill returned by open_workspace or skill_search matches the task, read that skill's path before proceeding. Skill paths may be outside the workspace; only those advertised SKILL.md files and files under already-loaded skill directories are readable."
            : "",
        ]
          .filter(Boolean)
          .join(" "),
      inputSchema: {
        workspaceId: z
          .string()
          .describe(workspaceIdDescription),
        path: z
          .string()
          .describe(
            config.skillsEnabled
              ? "File path to read, relative to the workspace root. May also be a skill path advertised by open_workspace or skill_search."
              : "File path to read, relative to the workspace root.",
          ),
        offset: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("1-indexed line number to start reading from."),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Maximum number of lines to read."),
      },
      outputSchema: resultOutputSchema(),
      ...toolWidgetDescriptorMeta(config, "read"),
      annotations: { readOnlyHint: true },
    },
    async ({ workspaceId, ...input }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      const readPath = workspaces.resolveReadPath(workspace, input.path);
      const response = await readFileTool(
        { ...input, path: readPath.absolutePath },
        {
          cwd: workspace.root,
          root: workspace.root,
          readRoots: readPath.readRoots,
        },
      );

      if (response.isError) {
        logFailedToolResponse(config, {
          tool: toolNames.read,
          workspaceId,
          path: input.path,
        }, response.content, startedAt);
        return response;
      }
      workspaces.markReadPathLoaded(workspace, readPath);

      const summary = {
        ...textSummary(response.content),
        offset: input.offset ?? 1,
        limited: input.limit !== undefined,
      };
      logToolCall(config, {
        tool: toolNames.read,
        workspaceId,
        path: input.path,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return {
        ...response,
        _meta: {
          tool: toolNames.read,
          card: {
            workspaceId,
            path: input.path,
            summary,
            payload: { content: response.content },
          },
        },
        structuredContent: {
          result: contentText(response.content),
        },
      };
    },
  );

  if (config.toolMode !== "codex") {
  registerAppTool(
    server,
    toolNames.write,
    {
      title: "Write file",
      description:
        `Create or completely overwrite a file in a workspace. Prefer ${toolNames.edit} for targeted changes to existing files.`,
      inputSchema: {
        workspaceId: z
          .string()
          .describe(workspaceIdDescription),
        path: z
          .string()
          .describe("File path to write, relative to the workspace root."),
        content: z.string().describe("Complete new file content."),
      },
      outputSchema: resultOutputSchema(),
      ...toolWidgetDescriptorMeta(config, "write"),
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, ...input }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      const researchTarget = {
        workspaceId: workspace.id,
        root: workspace.root,
      };
      const guard = await activeResearchCycle.guardPaths(
        researchTarget,
        [input.path],
      );
      if (!guard.allowed) return researchGuardFailure(guard);
      workspaces.resolvePath(workspace, input.path);
      const response = await writeFileTool(input, {
        cwd: workspace.root,
        root: workspace.root,
      });

      if (response.isError) {
        logFailedToolResponse(config, {
          tool: toolNames.write,
          workspaceId,
          path: input.path,
        }, response.content, startedAt);
        return response;
      }

      const patch = newFilePatch(input.path, input.content);
      const researchNotice = await researchObservationNotice(
        config,
        toolNames.write,
        () => activeResearchCycle.observePaths(researchTarget, [input.path]),
      );
      const stats = countDiffStats(patch);
      const summary = {
        ...stats,
        lines: contentLineCount(input.content),
        characters: input.content.length,
      };
      logToolCall(config, {
        tool: toolNames.write,
        workspaceId,
        path: input.path,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return appendToolNotice({
        ...response,
        _meta: {
          tool: toolNames.write,
          card: {
            workspaceId,
            path: input.path,
            summary,
            payload: {
              content: response.content,
              patch,
            },
          },
        },
        structuredContent: {
          result: contentText(response.content),
        },
      }, researchNotice, "zesResearchCycleNotice");
    },
  );

  registerAppTool(
    server,
    toolNames.edit,
    {
      title: "Edit file",
      description:
        `Edit one file in a workspace by replacing exact text blocks. Prefer this over ${toolNames.write} for targeted changes. Each oldText must match a unique, non-overlapping region of the original file; merge nearby changes into one edit and keep oldText as small as possible while still unique.`,
      inputSchema: {
        workspaceId: z
          .string()
          .describe(workspaceIdDescription),
        path: z
          .string()
          .describe("File path to edit, relative to the workspace root."),
        edits: z
          .array(
            z.object({
              oldText: z
                .string()
                .describe(
                  "Exact text to replace. Must match uniquely in the original file.",
                ),
              newText: z.string().describe("Replacement text."),
            }),
          )
          .min(1),
      },
      outputSchema: resultOutputSchema({
        status: z.literal("applied"),
      }),
      ...toolWidgetDescriptorMeta(config, "edit"),
      annotations: EDIT_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, ...input }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      const researchTarget = {
        workspaceId: workspace.id,
        root: workspace.root,
      };
      const guard = await activeResearchCycle.guardPaths(
        researchTarget,
        [input.path],
      );
      if (!guard.allowed) return researchGuardFailure(guard);
      workspaces.resolvePath(workspace, input.path);
      const response = await editFileTool(input, {
        cwd: workspace.root,
        root: workspace.root,
      });

      if (response.isError) {
        logFailedToolResponse(config, {
          tool: toolNames.edit,
          workspaceId,
          path: input.path,
        }, response.content, startedAt);
        return response;
      }

      const stats = countDiffStats(
        response.details?.patch ?? response.details?.diff,
      );
      const summary = {
        ...stats,
        editCount: input.edits.length,
      };
      const editResultText = `Edited ${input.path} (+${stats.additions} -${stats.removals}).`;
      const editContent = [textBlock(editResultText)];
      const researchNotice = await researchObservationNotice(
        config,
        toolNames.edit,
        () => activeResearchCycle.observePaths(researchTarget, [input.path]),
      );
      logToolCall(config, {
        tool: toolNames.edit,
        workspaceId,
        path: input.path,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return appendToolNotice({
        content: editContent,
        _meta: {
          tool: toolNames.edit,
          card: {
            workspaceId,
            path: input.path,
            summary,
            payload: {
              diff: response.details?.diff,
              patch: response.details?.patch,
            },
          },
        },
        structuredContent: {
          status: "applied",
          result: contentText(editContent),
        },
      }, researchNotice, "zesResearchCycleNotice");
    },
  );
  }

  if (config.toolMode === "codex") {
    registerAppTool(
      server,
      "apply_patch",
      {
        title: "Apply patch",
        description:
          "Apply one Codex-style patch in a workspace. Supports adding, overwriting, updating, deleting, and moving files. Use this for all file modifications. Paths must be relative to the workspace.",
        inputSchema: {
          workspaceId: z
            .string()
            .describe(workspaceIdDescription),
          patch: z
            .string()
            .describe("Patch text enclosed by *** Begin Patch and *** End Patch markers."),
        },
        outputSchema: resultOutputSchema({
          additions: z.number(),
          removals: z.number(),
          files: z.array(
            z.object({
              path: z.string(),
              previousPath: z.string().optional(),
              operation: z.enum(["add", "update", "delete", "move"]),
            }),
          ),
        }),
        ...toolWidgetDescriptorMeta(config, "edit"),
        annotations: EDIT_TOOL_ANNOTATIONS,
      },
      async ({ workspaceId, patch }) => {
        const startedAt = performance.now();
        const workspace = workspaces.getWorkspace(workspaceId);
        const researchTarget = {
          workspaceId: workspace.id,
          root: workspace.root,
        };
        const guard = await activeResearchCycle.guardPatch(
          researchTarget,
          patch,
        );
        if (!guard.allowed) return researchGuardFailure(guard);
        const applied = await applyPatch(workspace.root, patch);
        const researchNotice = await researchObservationNotice(
          config,
          "apply_patch",
          () => activeResearchCycle.observePaths(
            researchTarget,
            applied.files.flatMap((file) => [
              ...(file.previousPath ? [file.previousPath] : []),
              file.path,
            ]),
          ),
        );
        const paths = applied.files.map((file) => file.path).join(", ");
        const result = `Applied patch to ${applied.files.length} file(s): ${paths}`;
        const content = [textBlock(result)];
        const displayPath = applied.files.length === 1
          ? applied.files[0]?.path
          : `${applied.files.length} files`;

        logToolCall(config, {
          tool: "apply_patch",
          workspaceId,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });

        return appendToolNotice({
          content,
          _meta: {
            tool: "apply_patch",
            card: {
              workspaceId,
              path: displayPath,
              summary: {
                files: applied.files.length,
                additions: applied.additions,
                removals: applied.removals,
              },
              files: applied.files,
              payload: { patch: applied.patch },
            },
          },
          structuredContent: {
            result,
            additions: applied.additions,
            removals: applied.removals,
            files: applied.files,
          },
        }, researchNotice, "zesResearchCycleNotice");
      },
    );
  }

  if (config.widgets === "changes") {
    registerAppTool(
      server,
      "show_changes",
      {
        title: "Show changes",
        description:
          "Show the changes made in this turn for an open workspace. Call this once after the final related file change and before your final response so the user can review the combined diff. Do not call it after each individual file change.",
        inputSchema: {
          workspaceId: z
            .string()
            .describe(workspaceIdDescription),
        },
        outputSchema: resultOutputSchema(),
        ...toolWidgetDescriptorMeta(config, "show_changes"),
        annotations: { readOnlyHint: true },
      },
      async ({ workspaceId }) => {
        const startedAt = performance.now();
        const workspace = workspaces.getWorkspace(workspaceId);
        const review = await reviewCheckpoints.reviewChanges({
          workspaceId,
          root: workspace.root,
          markReviewed: true,
        });

        const content = [textBlock(review.result)];
        logToolCall(config, {
          tool: "show_changes",
          workspaceId,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });

        return {
          content,
          _meta: {
            tool: "show_changes",
            card: {
              workspaceId,
              summary: review.summary,
              files: review.files,
              payload: {
                patch: review.patch,
              },
            },
          },
          structuredContent: {
            result: contentText(content),
          },
        };
      },
    );
  }

  if (
    config.toolMode === "full"
    || (config.toolMode === "codex" && config.codexNavigationTools)
  ) {
    registerAppTool(
      server,
      toolNames.grep,
      {
        title: "Grep",
        description:
          "Search file contents in a workspace. Use this before broad reads when looking for symbols, text, or usage sites. Respects project ignore rules.",
        inputSchema: {
          workspaceId: z
            .string()
            .describe(workspaceIdDescription),
          pattern: z.string().describe("Search pattern."),
          path: z
            .string()
            .optional()
            .describe(
              "Optional path or glob scope relative to the workspace root.",
            ),
          include: z.string().optional().describe("Optional include glob."),
        },
        outputSchema: resultOutputSchema(),
        ...toolWidgetDescriptorMeta(config, "search"),
        annotations: { readOnlyHint: true },
      },
      async ({ workspaceId, ...input }) => {
        const startedAt = performance.now();
        const workspace = workspaces.getWorkspace(workspaceId);
        if (input.path) workspaces.resolvePath(workspace, input.path);
        const response = await grepFilesTool(input, {
          cwd: workspace.root,
          root: workspace.root,
        });

        if (response.isError) {
          logFailedToolResponse(config, {
            tool: toolNames.grep,
            workspaceId,
            path: input.path,
          }, response.content, startedAt);
          return response;
        }

        const summary = {
          pattern: input.pattern,
          scope: input.path ?? ".",
          ...textSummary(response.content),
        };
        logToolCall(config, {
          tool: toolNames.grep,
          workspaceId,
          path: input.path,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });

        return {
          ...response,
          _meta: {
            tool: toolNames.grep,
            card: {
              workspaceId,
              path: input.path,
              summary,
              payload: { content: response.content },
            },
          },
          structuredContent: {
            result: contentText(response.content),
          },
        };
      },
    );

    registerAppTool(
      server,
      toolNames.glob,
      {
        title: "Glob",
        description:
          "Find files by glob pattern in a workspace. Use this to discover filenames or narrow file sets before reading. Respects project ignore rules.",
        inputSchema: {
          workspaceId: z
            .string()
            .describe(workspaceIdDescription),
          pattern: z.string().describe("File glob pattern."),
          path: z
            .string()
            .optional()
            .describe("Optional path scope relative to the workspace root."),
        },
        outputSchema: resultOutputSchema(),
        ...toolWidgetDescriptorMeta(config, "search"),
        annotations: { readOnlyHint: true },
      },
      async ({ workspaceId, ...input }) => {
        const startedAt = performance.now();
        const workspace = workspaces.getWorkspace(workspaceId);
        if (input.path) workspaces.resolvePath(workspace, input.path);
        const response = await findFilesTool(input, {
          cwd: workspace.root,
          root: workspace.root,
        });

        if (response.isError) {
          logFailedToolResponse(config, {
            tool: toolNames.glob,
            workspaceId,
            path: input.path,
          }, response.content, startedAt);
          return response;
        }

        const summary = {
          pattern: input.pattern,
          scope: input.path ?? ".",
          ...textSummary(response.content),
        };
        logToolCall(config, {
          tool: toolNames.glob,
          workspaceId,
          path: input.path,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });

        return {
          ...response,
          _meta: {
            tool: toolNames.glob,
            card: {
              workspaceId,
              path: input.path,
              summary,
              payload: { content: response.content },
            },
          },
          structuredContent: {
            result: contentText(response.content),
          },
        };
      },
    );

    registerAppTool(
      server,
      toolNames.ls,
      {
        title: "Ls",
        description:
          "List a directory in a workspace. Use this for directory inspection before reading files.",
        inputSchema: {
          workspaceId: z
            .string()
            .describe(workspaceIdDescription),
          path: z
            .string()
            .describe(
              "Directory path to list, relative to the workspace root.",
            ),
        },
        outputSchema: resultOutputSchema(),
        ...toolWidgetDescriptorMeta(config, "directory"),
        annotations: { readOnlyHint: true },
      },
      async ({ workspaceId, ...input }) => {
        const startedAt = performance.now();
        const workspace = workspaces.getWorkspace(workspaceId);
        workspaces.resolvePath(workspace, input.path);
        const response = await listDirectoryTool(input, {
          cwd: workspace.root,
          root: workspace.root,
        });

        if (response.isError) {
          logFailedToolResponse(config, {
            tool: toolNames.ls,
            workspaceId,
            path: input.path,
          }, response.content, startedAt);
          return response;
        }

        const summary = textSummary(response.content);
        logToolCall(config, {
          tool: toolNames.ls,
          workspaceId,
          path: input.path,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });

        return {
          ...response,
          _meta: {
            tool: toolNames.ls,
            card: {
              workspaceId,
              path: input.path,
              summary,
              payload: { content: response.content },
            },
          },
          structuredContent: {
            result: contentText(response.content),
          },
        };
      },
    );
  }

  if (config.toolMode !== "codex") {
  registerAppTool(
    server,
    toolNames.shell,
    {
      title: "Bash",
      description: config.toolMode !== "full"
        ? `Run a shell command in a workspace. Use only for tests, builds, git inspection, package scripts, search, file discovery, and directory inspection. In minimal tool mode, ${toolNames.grep}, ${toolNames.glob}, and ${toolNames.ls} are disabled; use command-line tools such as grep, rg, find, ls, and tree for those read-only inspection actions. Do not use ${toolNames.shell} to create or modify files. Do not use shell redirection, heredocs, tee, sed -i, perl -i, node/python/ruby scripts, or generated scripts to write project files; use ${toolNames.edit} for targeted changes and ${toolNames.write} for new files or full rewrites. Prefer ${toolNames.read} for direct file reads. This is powerful execution and should only be exposed behind strong authentication.`
        : `Run a shell command in a workspace. Use only for tests, builds, git inspection, package scripts, and commands that are better executed by the shell. Do not use ${toolNames.shell} to create or modify files. Do not use shell redirection, heredocs, tee, sed -i, perl -i, node/python/ruby scripts, or generated scripts to write project files; use ${toolNames.edit} for targeted changes and ${toolNames.write} for new files or full rewrites. Prefer ${toolNames.read}, ${toolNames.grep}, ${toolNames.glob}, and ${toolNames.ls} for file inspection. This is powerful execution and should only be exposed behind strong authentication.`,
      inputSchema: {
        workspaceId: z
          .string()
          .describe(workspaceIdDescription),
        command: z
          .string()
          .describe(
            `Shell command to run. Must not create or modify project files; use ${toolNames.edit} or ${toolNames.write} for file changes.`,
          ),
        workingDirectory: z
          .string()
          .optional()
          .describe(
            "Optional working directory relative to the workspace root. Defaults to the workspace root.",
          ),
        timeout: z
          .number()
          .positive()
          .max(300)
          .optional()
          .describe("Timeout in seconds. Defaults to 30, max 300."),
      },
      outputSchema: resultOutputSchema(),
      ...toolWidgetDescriptorMeta(config, "shell"),
      annotations: SHELL_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, workingDirectory, ...input }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      const researchTarget = {
        workspaceId: workspace.id,
        root: workspace.root,
      };
      const guard = await activeResearchCycle.guardCommand(
        researchTarget,
        input.command,
      );
      if (!guard.allowed) return researchGuardFailure(guard);
      const cwd = workspaces.resolveWorkingDirectory(
        workspace,
        workingDirectory,
      );
      const response = await runShellTool(input, {
        cwd,
        root: workspace.root,
      });
      const researchNotice = await researchObservationNotice(
        config,
        toolNames.shell,
        () => activeResearchCycle.observeCommandSnapshot(
          researchTarget,
          input.command,
          {
            running: false,
            exitCode: response.isError ? 1 : 0,
          },
        ),
      );

      if (response.isError) {
        logFailedToolResponse(config, {
          tool: toolNames.shell,
          workspaceId,
          workingDirectory: workingDirectory ?? ".",
          command: input.command,
          commandLength: input.command.length,
        }, response.content, startedAt);
        return appendToolNotice(
          response,
          researchNotice,
          "zesResearchCycleNotice",
        );
      }

      const summary = {
        command: input.command,
        workingDirectory: workingDirectory ?? ".",
        ...textSummary(response.content),
      };
      logToolCall(config, {
        tool: toolNames.shell,
        workspaceId,
        workingDirectory: workingDirectory ?? ".",
        command: input.command,
        commandLength: input.command.length,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return appendToolNotice({
        ...response,
        _meta: {
          tool: toolNames.shell,
          card: {
            workspaceId,
            path: workingDirectory,
            summary,
            payload: { content: response.content },
          },
        },
        structuredContent: {
          result: contentText(response.content),
        },
      }, researchNotice, "zesResearchCycleNotice");
    },
  );
  }

  if (config.toolMode === "codex") {
    registerCodexProcessTools(
      server,
      config,
      workspaces,
      processSessions,
      activeExecutionMailbox,
      activeResearchCycle,
    );
  }

  if (config.artifactsEnabled && isArtifactDownloadSupportedPlatform()) {
    registerArtifactTools(server, {
      config,
      workspaces,
      incomingArtifactAdapters,
      registerTool: registerAppTool,
    });
  }

  if (
    ownsExecutionScopes
    || ownsExecutionMailbox
    || ownsLocalAgentCoordinator
    || ownsTurnContinuity
  ) {
    const close = server.close.bind(server);
    let closing: Promise<void> | undefined;
    server.close = () => {
      closing ??= (async () => {
        try {
          await close();
        } finally {
          if (ownsExecutionScopes) activeExecutionScopes.close();
          if (ownsExecutionMailbox) activeExecutionMailbox.close();
          if (ownsTurnContinuity) activeTurnContinuity.close();
          if (ownsLocalAgentCoordinator) activeLocalAgentCoordinator?.close();
        }
      })();
      return closing;
    };
  }

  return server;
}

export interface CreateServerOptions {
  incomingArtifactAdapters?: readonly IncomingArtifactAdapter[];
}

export function createServer(
  config = loadConfig(),
  options: CreateServerOptions = {},
): RunningServer {
  const incomingArtifactAdapters = options.incomingArtifactAdapters
    ?? [createOpenAIIncomingArtifactAdapter()];
  const allowedHosts = config.allowedHosts.includes("*")
    ? undefined
    : Array.from(new Set([config.host, ...config.allowedHosts]));
  const app = createMcpExpressApp({
    host: config.host,
    ...(allowedHosts ? { allowedHosts } : {}),
  });
  const transports = new McpSessionRegistry<Transport>();
  const mcpUrl = new URL("/mcp", config.publicBaseUrl);
  const resourceServerUrl = resourceUrlFromServerUrl(mcpUrl);
  const oauthProvider = new SingleUserOAuthProvider(config.oauth, mcpUrl, config.stateDir);
  const bearerAuth = requireBearerAuth({
    verifier: oauthProvider,
    requiredScopes: [config.oauth.scopes[0] ?? "devspace"],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceServerUrl),
  });
  const workspaceStore = createWorkspaceStore(config.stateDir);
  const workspaces = new WorkspaceRegistry(config, workspaceStore);
  const reviewCheckpoints = createReviewCheckpointManager();
  const processSessions = new ProcessSessionManager();
  const runtimeCapabilities = new RuntimeCapabilityRegistry(config);
  const researchCycle = new ZesResearchCycleManager(config.zesResearchCycle);
  const continuationPreflightProjector =
    new ZesContinuationPreflightProjector();
  void continuationPreflightProjector.warm();
  const scopePublicationPreflight =
    new ZesScopePublicationPreflightAssessor();
  const executionScopes = new ExecutionScopeManager(
    config.executionObservability,
    config.stateDir,
    processSessions,
  );
  const executionMailbox = new ExecutionMailboxManager(
    config.executionMailbox,
    config.stateDir,
  );
  const turnContinuity = new TurnContinuityManager(
    config.turnContinuity,
    config.stateDir,
  );
  const localAgentCoordinator = config.subagents
    ? new LocalAgentCoordinator(config, {
        launchWorker: (agentId, workerId) => launchDetachedLocalAgentWorker(
          localAgentWorkerEntrypoint(),
          agentId,
          workerId,
        ),
      })
    : undefined;
  const localAgentProviders = config.subagents
    ? getLocalAgentProviderAvailabilitySnapshot(
        process.env,
        config.localAgentBilling.mode,
      )
    : [];

  // Materialize the exact registered descriptor set before the first HTTP
  // request. This keeps /healthz and response headers from presenting an empty
  // process surface during the interval before the first tools/list call.
  const catalogBootstrapServer = createMcpServer(
    config,
    workspaces,
    reviewCheckpoints,
    processSessions,
    localAgentProviders,
    incomingArtifactAdapters,
    executionScopes,
    executionMailbox,
    localAgentCoordinator,
    turnContinuity,
    runtimeCapabilities,
    researchCycle,
    continuationPreflightProjector,
    scopePublicationPreflight,
  );

  const logSessionCloseResults = (
    reason: "idle_timeout" | "server_shutdown",
    results: McpSessionCloseResult[],
  ) => {
    for (const result of results) {
      if (result.error) {
        logEvent(config.logging, "warn", "mcp_session_close_failed", {
          reason,
          sessionIdPrefix: sessionIdPrefix(result.sessionId),
          error:
            result.error instanceof Error
              ? result.error.message
              : String(result.error),
        });
        continue;
      }

      logEvent(config.logging, "info", "mcp_session_closed", {
        reason,
        sessionIdPrefix: sessionIdPrefix(result.sessionId),
      });
    }
  };

  const sessionCleanupTimer = setInterval(() => {
    void transports
      .closeIdle(MCP_SESSION_IDLE_TIMEOUT_MS)
      .then((results) => logSessionCloseResults("idle_timeout", results));
  }, MCP_SESSION_CLEANUP_INTERVAL_MS);
  sessionCleanupTimer.unref();

  if (config.logging.trustProxy) {
    app.set("trust proxy", true);
  }

  app.use((req, res, next) => {
    const requestId = randomUUID();
    const startedAt = performance.now();
    res.locals.requestId = requestId;

    res.on("finish", () => {
      const path = requestPath(req);
      if (!config.logging.requests) return;
      if (!config.logging.assets && path.startsWith("/mcp-app-assets")) return;

      logEvent(config.logging, "info", "http_request", {
        requestId,
        method: req.method,
        path,
        status: res.statusCode,
        durationMs: Math.round(performance.now() - startedAt),
        ...requestLogFields(req, config),
      });
    });

    next();
  });

  app.use(
    mcpAuthRouter({
      provider: oauthProvider,
      issuerUrl: new URL(config.publicBaseUrl),
      baseUrl: new URL(config.publicBaseUrl),
      resourceServerUrl,
      scopesSupported: config.oauth.scopes,
      resourceName: "DevSpace",
    }),
  );

  app.options("/mcp-app-assets/{*asset}", (_req, res) => {
    setAssetHeaders(res);
    res.sendStatus(204);
  });

  app.use(
    "/mcp-app-assets",
    express.static(uiBuildDirectory(), {
      immutable: true,
      maxAge: "1y",
      fallthrough: false,
      setHeaders: setAssetHeaders,
    }),
  );

  app.get("/healthz", (req, res) => {
    const clientAttestation = requestClientCatalogAttestation(req);
    setRuntimeCapabilityHeaders(res, runtimeCapabilities, clientAttestation);
    const runtime = runtimeCapabilities.snapshot({ clientAttestation });
    const backend = isRecord(runtime.backend) ? runtime.backend : {};
    const toolSurface = isRecord(runtime.toolSurface) ? runtime.toolSurface : {};
    res.json({
      ok: true,
      name: "devspace",
      packageVersion: backend.packageVersion,
      mcpServerVersion: backend.mcpServerVersion,
      backendInstanceRef: backend.instanceRef,
      backendStartedAt: backend.startedAt,
      toolSurface: {
        initialized: toolSurface.initialized,
        fingerprintSha256: toolSurface.fingerprintSha256,
        surfaceEpoch: toolSurface.surfaceEpoch,
        toolCount: toolSurface.toolCount,
        requiredClientTools: toolSurface.requiredClientTools,
      },
      clientCatalogObservation: runtime.clientCatalogObservation,
      toolSurfaceFreshness: runtime.toolSurfaceFreshness,
      deploymentManifestObservation: runtime.deploymentManifestObservation,
      runtimeBindingObservation: runtime.runtimeBindingObservation,
    });
  });

  app.all("/mcp", async (req, res) => {
    const clientAttestation = requestClientCatalogAttestation(req);
    setRuntimeCapabilityHeaders(res, runtimeCapabilities, clientAttestation);
    const requestId = res.locals.requestId as string | undefined;
    const sessionId = req.header("mcp-session-id");
    const initializeRequest = req.method === "POST" && isInitializeRequest(req.body);
    const openAiStatelessRequest = req.method === "POST"
      && /^openai-mcp\//i.test(req.header("user-agent") ?? "");

    await new Promise<void>((resolve, reject) => {
      bearerAuth(req, res, (error?: unknown) => {
        if (error) reject(error);
        else resolve();
      });
    });
    if (res.headersSent) return;

    if (!req.auth?.resource || !checkResourceAllowed({ requestedResource: req.auth.resource, configuredResource: resourceServerUrl })) {
      logEvent(config.logging, "warn", "auth_denied", {
        requestId,
        method: req.method,
        path: requestPath(req),
        reason: "invalid_oauth_resource",
        ...requestLogFields(req, config),
      });
      sendJsonRpcError(res, 401, -32001, "Unauthorized");
      return;
    }

    logEvent(config.logging, "debug", "mcp_request", {
      requestId,
      method: req.method,
      sessionIdPresent: Boolean(sessionId),
      sessionIdPrefix: sessionIdPrefix(sessionId),
      isInitialize: initializeRequest,
      transportMode: openAiStatelessRequest ? "stateless_openai" : "stateful",
    });

    try {
      let transport: Transport | undefined;

      if (openAiStatelessRequest) {
        // ChatGPT separates tool discovery from execution and its execution
        // workers may not preserve an MCP session. Keep each OpenAI POST
        // self-contained while sharing process-level workspace, process, and
        // execution-scope and mailbox registries.
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });
        const server = createMcpServer(
          config,
          workspaces,
          reviewCheckpoints,
          processSessions,
          localAgentProviders,
          incomingArtifactAdapters,
          executionScopes,
          executionMailbox,
          localAgentCoordinator,
          turnContinuity,
          runtimeCapabilities,
          researchCycle,
          continuationPreflightProjector,
          scopePublicationPreflight,
        );
        await server.connect(transport);
        res.on("close", () => {
          void transport?.close().catch(() => undefined);
          void server.close().catch(() => undefined);
        });
      } else if (sessionId) {
        transport = transports.get(sessionId);
        if (!transport) {
          sendJsonRpcError(res, 404, -32000, "Unknown MCP session");
          return;
        }
      } else if (initializeRequest) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId) => {
            if (transport) transports.register(newSessionId, transport);
            logEvent(config.logging, "info", "mcp_session_created", {
              requestId,
              sessionIdPrefix: sessionIdPrefix(newSessionId),
              ...requestLogFields(req, config),
            });
          },
        });

        transport.onclose = () => {
          const closedSessionId = transport?.sessionId;
          if (closedSessionId && transports.remove(closedSessionId)) {
            logEvent(config.logging, "info", "mcp_session_closed", {
              reason: "transport_close",
              sessionIdPrefix: sessionIdPrefix(closedSessionId),
            });
          }
        };

        const server = createMcpServer(
          config,
          workspaces,
          reviewCheckpoints,
          processSessions,
          localAgentProviders,
          incomingArtifactAdapters,
          executionScopes,
          executionMailbox,
          localAgentCoordinator,
          turnContinuity,
          runtimeCapabilities,
          researchCycle,
          continuationPreflightProjector,
          scopePublicationPreflight,
        );
        await server.connect(transport);
      } else if (req.method === "POST") {
        // Preserve the SDK-supported one-transport-per-request fallback for
        // other stateless MCP clients.
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });
        const server = createMcpServer(
          config,
          workspaces,
          reviewCheckpoints,
          processSessions,
          localAgentProviders,
          incomingArtifactAdapters,
          executionScopes,
          executionMailbox,
          localAgentCoordinator,
          turnContinuity,
          runtimeCapabilities,
          researchCycle,
          continuationPreflightProjector,
          scopePublicationPreflight,
        );
        await server.connect(transport);
        res.on("close", () => {
          void transport?.close().catch(() => undefined);
          void server.close().catch(() => undefined);
        });
      } else {
        sendJsonRpcError(res, 405, -32000, "Method not allowed");
        return;
      }

      // createMcpServer registers the exact surface before the request is
      // handled. Re-apply headers so tool discovery and execution responses
      // carry the complete backend fingerprint rather than the pre-registration
      // process-only identity.
      setRuntimeCapabilityHeaders(res, runtimeCapabilities, clientAttestation);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      logEvent(config.logging, "error", "mcp_request_error", {
        requestId,
        error: error instanceof Error ? error.message : String(error),
      });
      if (!res.headersSent) {
        sendJsonRpcError(res, 500, -32603, "Internal server error");
      }
    }
  });

  let closePromise: Promise<void> | undefined;
  return {
    app,
    config,
    localAgentProviders,
    close: () => {
      closePromise ??= (async () => {
        clearInterval(sessionCleanupTimer);
        const results = await transports.closeAll();
        logSessionCloseResults("server_shutdown", results);
        processSessions.shutdown();
        localAgentCoordinator?.close();
        turnContinuity.close();
        executionMailbox.close();
        executionScopes.close();
        await catalogBootstrapServer.close();
        oauthProvider.close();
        workspaceStore.close?.();
      })();
      return closePromise;
    },
  };
}

async function isMainModule(): Promise<boolean> {
  if (!process.argv[1]) return false;

  const modulePath = await realpath(fileURLToPath(import.meta.url));
  const entrypointPath = await realpath(process.argv[1]);
  return modulePath === entrypointPath;
}

if (await isMainModule()) {
  const { app, config, close, localAgentProviders } = createServer();
  const httpServer = app.listen(config.port, config.host, () => {
    console.log(
      `devspace listening on http://${config.host}:${config.port}/mcp`,
    );
    console.log(`allowed roots: ${config.allowedRoots.join(", ")}`);
    console.log("auth: oauth owner-token flow required");
    console.log(`logging: ${config.logging.level} ${config.logging.format}`);
    console.log(`request logging: ${config.logging.requests ? "enabled" : "disabled"}`);
    console.log(`asset logging: ${config.logging.assets ? "enabled" : "disabled"}`);
    console.log(`trust proxy: ${config.logging.trustProxy ? "enabled" : "disabled"}`);
    const artifactDownloadStatus = !config.artifactsEnabled
      ? "disabled"
      : isArtifactDownloadSupportedPlatform()
        ? "enabled"
        : `unsupported on ${process.platform}`;
    console.log(`native artifact download: ${artifactDownloadStatus}`);
    if (config.subagents) {
      console.log(`subagent providers: ${formatLocalAgentProviderAvailabilitySummary(localAgentProviders)}`);
      console.log(`local-agent billing: ${config.localAgentBilling.mode}`);
      console.log(
        `local-agent queue: max pending ${config.localAgentQueue.maxPendingPerAgent}, lease ${Math.round(config.localAgentQueue.leaseMs / 1_000)}s, heartbeat ${Math.round(config.localAgentQueue.heartbeatMs / 1_000)}s`,
      );
    }
  });

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    const result = await shutdownHttpServer(httpServer, close);
    if (result.forced) {
      console.warn("devspace forced remaining HTTP connections closed after shutdown grace elapsed");
    }
    process.exit(0);
  };
  const handleShutdown = () => {
    void shutdown().catch((error) => {
      console.error("devspace shutdown failed", error);
      process.exit(1);
    });
  };
  process.once("SIGINT", handleShutdown);
  process.once("SIGTERM", handleShutdown);
}
