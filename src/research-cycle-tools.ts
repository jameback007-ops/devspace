import type { registerAppTool as registerAppToolType } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import type { ServerConfig } from "./config.js";
import { logEvent } from "./logger.js";
import {
  RESEARCH_PROVIDER_PURPOSES,
  type ResearchProviderPurpose,
  type ResearchProviderRequest,
  ZesResearchProviderBroker,
} from "./research-provider-broker.js";
import {
  ResearchCycleError,
  researchCommandDigest,
  type ResearchCycleOpenInput,
  type ResearchCyclePrepareInput,
  type ResearchInvalidationKind,
  type ResearchPreCommitChallenge,
  type ResearchProviderTraceInput,
  type ResearchWorkspace,
  ZesResearchCycleManager,
} from "./research-cycle.js";

type AppToolRegistrar = typeof registerAppToolType;
type JsonObject = Record<string, unknown>;
export type ResearchWorkspaceResolver = (
  workspaceId: string,
) => ResearchWorkspace;

const outputSchema: z.ZodRawShape = {
  result: z.string(),
  data: z.unknown(),
};

const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const localStateAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};

const externalEvidenceAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};

const workspaceIdSchema = z.string().min(1).describe(
  "Workspace ID returned by open_workspace for the exact ZES checkout or worktree.",
);
const nonEmptyStrings = z.array(z.string().min(1));
const jsonObjectSchema = z.record(z.string(), z.unknown());

const operationClassSchema = z.enum([
  "source_mutation",
  "repository_commit",
  "repository_publish",
  "dependency_change",
  "runtime_effect",
]);

const invalidationKindSchema = z.enum([
  "architecture_or_semantic_fork",
  "contradictory_evidence",
  "dependency_or_upstream_change",
  "owner_direction_changed",
  "repeated_distinct_failure",
  "scope_drift",
  "source_currentness_expired",
  "manual",
]);

const providerTraceSchema = z.object({
  traceRef: z.string().min(1),
  path: z.string().min(1),
});

const providerPurposeSchema = z.enum(RESEARCH_PROVIDER_PURPOSES);
const providerRequestSchema = z.union([
  z.object({
    provider: z.literal("context7"),
    operation: z.literal("resolve-library"),
    query: z.string().min(1),
    libraryName: z.string().min(1),
  }),
  z.object({
    provider: z.literal("context7"),
    operation: z.literal("docs"),
    query: z.string().min(1),
    libraryId: z.string().min(1),
  }),
  z.object({
    provider: z.literal("exa"),
    operation: z.literal("search"),
    query: z.string().min(1),
    maxResults: z.number().int().min(1).max(20).optional(),
  }),
  z.object({
    provider: z.literal("exa"),
    operation: z.literal("fetch"),
    query: z.string().min(1),
    urls: z.array(z.string().url()).min(1).max(20),
    maxCharacters: z.number().int().min(1).max(200_000).optional(),
  }),
  z.object({
    provider: z.literal("web"),
    operation: z.literal("fetch"),
    query: z.string().min(1),
    urls: z.array(z.string().url()).min(1).max(5),
    targetKind: z.enum(["exact_fact", "named_document", "official_source"]),
    knownSourceReason: z.string().min(12),
    maxCharacters: z.number().int().min(1).max(200_000).optional(),
  }),
]);

function toolMeta(config: ServerConfig): { _meta: Record<string, unknown> } {
  if (config.widgets === "off") return { _meta: {} };
  return {
    _meta: {
      ui: {
        resourceUri: "ui://devspace/workspace-app.html",
        visibility: ["model"],
      },
    },
  };
}

function toolResult(data: Record<string, unknown>) {
  const result = JSON.stringify(data, null, 2);
  return {
    content: [{ type: "text" as const, text: result }],
    structuredContent: { result, data },
  };
}

function toolError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const data = error instanceof ResearchCycleError
    ? {
        status: "held",
        code: error.code,
        message,
        details: error.details,
        policy: {
          authority:
            "executor_local_lifecycle_and_native_receipt_verification_only",
          researchSufficiencyAuthority: false,
          writerAuthority: false,
          publicationAuthority: false,
          runtimeOrEffectAuthority: false,
        },
      }
    : {
        status: "failed",
        code: "RESEARCH_CYCLE_UNEXPECTED_FAILURE",
        message,
      };
  return {
    isError: true,
    ...toolResult(data),
  };
}

function registerLifecycleTool<Input extends object>(
  server: McpServer,
  config: ServerConfig,
  registerTool: AppToolRegistrar,
  name: string,
  definition: Parameters<AppToolRegistrar>[2],
  handler: (input: Input) => Promise<Record<string, unknown>>,
): void {
  registerTool(
    server,
    name,
    definition,
    async (input: Input) => {
      const startedAt = performance.now();
      try {
        const data = await handler(input);
        if (config.logging.toolCalls) {
          logEvent(config.logging, "info", "tool_call", {
            tool: name,
            success: true,
            durationMs: Math.round(performance.now() - startedAt),
          });
        }
        return toolResult(data);
      } catch (error) {
        if (config.logging.toolCalls) {
          logEvent(config.logging, "warn", "tool_call", {
            tool: name,
            success: false,
            durationMs: Math.round(performance.now() - startedAt),
            error: error instanceof Error
              ? error.message.slice(0, 500)
              : String(error).slice(0, 500),
          });
        }
        return toolError(error);
      }
    },
  );
}

export const ZES_RESEARCH_CYCLE_TOOL_NAMES = [
  "zes_research_cycle_open",
  "zes_research_cycle_prepare",
  "zes_research_provider_invoke",
  "zes_research_cycle_assess",
  "zes_research_cycle_invalidate",
  "zes_research_cycle_verify_pre_commit",
  "zes_research_cycle_status",
  "zes_research_cycle_close",
] as const;

export function registerZesResearchCycleTools(
  server: McpServer,
  config: ServerConfig,
  manager: ZesResearchCycleManager,
  resolveWorkspace: ResearchWorkspaceResolver,
  registerTool: AppToolRegistrar,
  providerBroker = new ZesResearchProviderBroker(
    config.zesResearchCycle,
    manager,
  ),
): void {
  if (!manager.enabled) return;

  registerLifecycleTool(
    server,
    config,
    registerTool,
    "zes_research_provider_invoke",
    {
      title: "Invoke a fixed Research Reflex evidence provider",
      description:
        "Acquire provider-verifiable evidence inside the active prepared Research Reflex generation through one fixed broker. Context7 is for exact upstream documentation. Exa is for open-world candidate discovery, competing patterns, and field failures. Targeted Web fetch is only for an already-known exact fact, named document, or official source and cannot substitute for Exa. The DevSpace service may attach its fixed provider credential handle to the child process, but the model and arbitrary exec_command never receive the credential value or digest. The result includes providerEvidence plus the exact providerTrace to pass to zes_research_cycle_assess.",
      inputSchema: {
        workspaceId: workspaceIdSchema,
        purpose: providerPurposeSchema,
        request: providerRequestSchema,
      },
      outputSchema,
      ...toolMeta(config),
      annotations: externalEvidenceAnnotations,
    },
    async (input: {
      workspaceId: string;
      purpose: ResearchProviderPurpose;
      request: ResearchProviderRequest;
    }) => await providerBroker.invoke(
      resolveWorkspace(input.workspaceId),
      input.purpose,
      input.request,
    ),
  );

  registerLifecycleTool(
    server,
    config,
    registerTool,
    "zes_research_cycle_open",
    {
      title: "Open a ZES research lifecycle",
      description:
        "Open one durable executor-local research lifecycle before material ZES design or mutation. Record the decision question, candidate boundary, known local evidence, uncertainties, falsifier, reopen trigger, actor, and an initial dynamic research-depth hypothesis. This grants no semantic, writer, publication, release, activation, or effect authority. In enforce mode the exact workspace must still be clean when opened.",
      inputSchema: {
        workspaceId: workspaceIdSchema,
        taskRef: z.string().min(1),
        materialDecisionRef: z.string().min(1),
        decisionBoundaryRef: z.string().min(1),
        decisionQuestion: z.string().min(1),
        candidatePathPrefixes: nonEmptyStrings.min(1),
        researchEnvelopeHypothesis: z.enum([
          "no_search",
          "quick_lookup",
          "focused_research",
          "deep_research",
        ]),
        researchQuestions: nonEmptyStrings,
        knownLocalEvidenceRefs: nonEmptyStrings,
        uncertainties: nonEmptyStrings,
        falsifier: z.string().min(1),
        reopenTrigger: z.string().min(1),
        actorRef: z.string().min(1),
        ownerSeededFraming: z.boolean(),
        replaceExisting: z.boolean().optional(),
        replacementReason: z.string().min(1).optional(),
      },
      outputSchema,
      ...toolMeta(config),
      annotations: localStateAnnotations,
    },
    async (input: ResearchCycleOpenInput & { workspaceId: string }) => {
      const { workspaceId, ...cycleInput } = input;
      return await manager.open(resolveWorkspace(workspaceId), cycleInput);
    },
  );

  registerLifecycleTool(
    server,
    config,
    registerTool,
    "zes_research_cycle_prepare",
    {
      title: "Prepare exact Research Reflex bindings",
      description:
        "Prepare the exact task, decision, evidence-regime, source-identity, implementation-boundary, and action-scope digests required by the native ZES Research Reflex v2 admission request. Supply every exact shell command that may mutate source or dependencies; DevSpace persists only their SHA-256 digests and holds unbound shell mutation in enforce mode. Direct apply_patch/write/edit effects remain path-bound. This operation does not assess research sufficiency.",
      inputSchema: {
        workspaceId: workspaceIdSchema,
        pathPrefixes: nonEmptyStrings.min(1),
        operationClasses: z.array(operationClassSchema).min(1),
        evidenceRegimeRefs: nonEmptyStrings.min(1),
        sourceIdentityRefs: nonEmptyStrings.min(1),
        shellMutationCommands: nonEmptyStrings.optional().describe(
          "Exact shell commands expected to mutate source or dependency files. Raw commands are used only to compute action-scope digests and are not persisted in cycle state.",
        ),
        repositoryWideScopeReason: z.string().min(1).optional(),
      },
      outputSchema,
      ...toolMeta(config),
      annotations: localStateAnnotations,
    },
    async (input: Omit<
      ResearchCyclePrepareInput,
      "shellMutationCommandDigests"
    > & {
      workspaceId: string;
      shellMutationCommands?: string[];
    }) => {
      const { workspaceId, shellMutationCommands, ...prepareInput } = input;
      return await manager.prepare(
        resolveWorkspace(workspaceId),
        {
          ...prepareInput,
          shellMutationCommandDigests: (shellMutationCommands ?? []).map(
            researchCommandDigest,
          ),
        },
      );
    },
  );

  registerLifecycleTool(
    server,
    config,
    registerTool,
    "zes_research_cycle_assess",
    {
      title: "Assess through native ZES Research Reflex",
      description:
        "Invoke the fixed native `zes-research-reflex assess` application port with a provider-verifiable v2 request matching the prepared workspace bindings. Optional Context7 or Exa provider receipts must be supplied as exact trace refs and files under configured trust roots. The native verdict and lease are stored durably; DevSpace does not substitute its own research judgment.",
      inputSchema: {
        workspaceId: workspaceIdSchema,
        request: jsonObjectSchema,
        providerTraces: z.array(providerTraceSchema).optional(),
      },
      outputSchema,
      ...toolMeta(config),
      annotations: localStateAnnotations,
    },
    async (input: {
      workspaceId: string;
      request: JsonObject;
      providerTraces?: ResearchProviderTraceInput[];
    }) => await manager.assess(
      resolveWorkspace(input.workspaceId),
      input.request,
      input.providerTraces ?? [],
    ),
  );

  registerLifecycleTool(
    server,
    config,
    registerTool,
    "zes_research_cycle_invalidate",
    {
      title: "Invalidate and reopen research judgment",
      description:
        "Invalidate the current action admission when architecture or semantics fork, counterevidence appears, an upstream/dependency assumption changes, the owner changes direction, failures reveal a new causal layer, scope drifts, or source currentness expires. This records a typed cause and requires a newly prepared and assessed generation before further material mutation.",
      inputSchema: {
        workspaceId: workspaceIdSchema,
        kind: invalidationKindSchema,
        reason: z.string().min(1),
        evidenceRefs: nonEmptyStrings.optional(),
      },
      outputSchema,
      ...toolMeta(config),
      annotations: localStateAnnotations,
    },
    async (input: {
      workspaceId: string;
      kind: ResearchInvalidationKind;
      reason: string;
      evidenceRefs?: string[];
    }) => await manager.invalidate(
      resolveWorkspace(input.workspaceId),
      input.kind,
      input.reason,
      input.evidenceRefs ?? [],
    ),
  );

  registerLifecycleTool(
    server,
    config,
    registerTool,
    "zes_research_cycle_verify_pre_commit",
    {
      title: "Challenge research assumptions before commit",
      description:
        "Reverify the exact native admission lease and bind the current complete working-content digest before commit. The caller must record fresh local-authority, external-currentness, dependency-currentness, assumption, counterevidence, unresolved-risk, validation, and dynamic stopping judgments. This checkpoint does not grant Git publication authority.",
      inputSchema: {
        workspaceId: workspaceIdSchema,
        validationRefs: nonEmptyStrings.min(1),
        challenge: z.object({
          localAuthorityRechecked: z.boolean(),
          externalCurrentnessRechecked: z.boolean(),
          dependencyCurrentnessRechecked: z.boolean(),
          assumptionsRechecked: nonEmptyStrings,
          counterevidenceOrLimitations: nonEmptyStrings,
          unresolved: nonEmptyStrings,
          stoppingReason: z.string().min(1),
        }),
      },
      outputSchema,
      ...toolMeta(config),
      annotations: localStateAnnotations,
    },
    async (input: {
      workspaceId: string;
      validationRefs: string[];
      challenge: ResearchPreCommitChallenge;
    }) => await manager.verifyPreCommit(
      resolveWorkspace(input.workspaceId),
      input.validationRefs,
      input.challenge,
    ),
  );

  registerLifecycleTool(
    server,
    config,
    registerTool,
    "zes_research_cycle_status",
    {
      title: "Read ZES research lifecycle status",
      description:
        "Read the bounded executor-local lifecycle, prepared bindings, current native admission identity, invalidations, observed source paths, pre-commit checkpoint, commit observation, and closure. This status is not canonical task, semantic, writer, publication, release, activation, or effect authority.",
      inputSchema: { workspaceId: workspaceIdSchema },
      outputSchema,
      ...toolMeta(config),
      annotations: readOnlyAnnotations,
    },
    async (input: { workspaceId: string }) =>
      await manager.status(resolveWorkspace(input.workspaceId)),
  );

  registerLifecycleTool(
    server,
    config,
    registerTool,
    "zes_research_cycle_close",
    {
      title: "Close and retain a research episode",
      description:
        "Close the lifecycle as committed, no-change, deferred, or abandoned. Fresh or reused external research must include the matching native ZES Research Reflex episode packet so decision delta, reusable findings, reversal conditions, counterevidence, and source identity can feed Task N→N+k learning. Closure still grants no publication or runtime authority.",
      inputSchema: {
        workspaceId: workspaceIdSchema,
        outcome: z.enum([
          "committed",
          "no_change",
          "deferred",
          "abandoned",
        ]),
        reason: z.string().min(1),
        decisionDelta: z.string().min(1),
        reusableFindings: nonEmptyStrings,
        reversalConditions: nonEmptyStrings,
        episodePacket: jsonObjectSchema.optional(),
      },
      outputSchema,
      ...toolMeta(config),
      annotations: localStateAnnotations,
    },
    async (input: {
      workspaceId: string;
      outcome: "committed" | "no_change" | "deferred" | "abandoned";
      reason: string;
      decisionDelta: string;
      reusableFindings: string[];
      reversalConditions: string[];
      episodePacket?: JsonObject;
    }) => {
      const { workspaceId, ...closeInput } = input;
      return await manager.close(resolveWorkspace(workspaceId), closeInput);
    },
  );
}
