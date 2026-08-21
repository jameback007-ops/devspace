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
  type ResearchDiscoveryAcquireInput,
  type ResearchDiscoveryPlanInput,
  type ResearchCycleOpenInput,
  type ResearchCyclePrepareInput,
  type ResearchHorizonInput,
  type ResearchInvalidationKind,
  type ResearchPreCommitChallenge,
  type ResearchProviderAcquisitionResult,
  type ResearchProviderTraceInput,
  type ResearchWorkspace,
  ZesResearchCycleManager,
} from "./research-cycle.js";
import {
  RESEARCH_EVIDENCE_NEED_KINDS,
  RESEARCH_INSTRUMENT_ARTIFACT_LOCATIONS,
  RESEARCH_INSTRUMENT_ARTIFACT_ROLES,
  RESEARCH_INSTRUMENT_CLAIM_CLASSES,
  RESEARCH_INSTRUMENT_EXECUTION_BOUNDARIES,
  RESEARCH_INSTRUMENT_MODEL_USE,
  RESEARCH_INSTRUMENT_OUTCOMES,
  type ResearchInstrumentPlanInput,
  type ResearchInstrumentRecordInput,
  ZesResearchInstrumentManager,
} from "./research-instruments.js";
import {
  type ResearchInstrumentExecuteInput,
  ZesResearchInstrumentExecutor,
} from "./research-instrument-executor.js";

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
  // Provider acquisition is externally read-only but it writes bounded
  // executor-local receipt/evidence files, so it must not advertise a fully
  // read-only environment contract to the host.
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};

const boundedExternalExecutionAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

const localReconciliationAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
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

const discoveryTemporalRegimeSchema = z.enum([
  "rapidly_volatile",
  "evolving_practice",
  "version_bound_fact",
  "durable_principle_or_invariant",
  "historical_lineage",
]);

const discoveryProfileSchema = z.enum([
  "balanced_frontier",
  "community_frontier",
  "failure_reproduction",
  "successor_or_alternative",
  "official_delta",
]);

const discoveryLaneSchema = z.enum([
  "official_or_release_delta",
  "open_source_or_independent_implementation",
  "failure_reproduction_or_maintainer_discussion",
  "competing_alternative_or_successor",
  "practitioner_or_production_experience",
  "counterevidence_or_falsifier",
]);

const discoveryLaneDispositionSchema = z.enum([
  "required",
  "conditional",
  "not_applicable",
]);

const horizonEventKindSchema = z.enum([
  "new_candidate_detected",
  "upstream_semantics_changed",
  "community_failure_cluster_detected",
  "prior_selection_superseded_candidate",
  "new_reproduction_or_counterevidence",
]);

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);

const providerTraceSchema = z.object({
  traceRef: z.string().min(1),
  path: z.string().min(1),
});

const providerPurposeSchema = z.enum(RESEARCH_PROVIDER_PURPOSES);
const providerQuerySchema = z.string().min(1).max(20_000);
const providerIdentifierSchema = z.string().min(1).max(2_000);
const providerUrlSchema = z.string().url().max(8_192);
const targetedWebUrlSchema = providerUrlSchema.refine(
  (value) => new URL(value).protocol === "https:",
  "Targeted Web requires an HTTPS URL.",
);
const providerRequestSchema = z.union([
  z.object({
    provider: z.literal("context7"),
    operation: z.literal("resolve-library"),
    query: providerQuerySchema,
    libraryName: providerIdentifierSchema,
  }),
  z.object({
    provider: z.literal("context7"),
    operation: z.literal("docs"),
    query: providerQuerySchema,
    libraryId: providerIdentifierSchema,
  }),
  z.object({
    provider: z.literal("exa"),
    operation: z.literal("search"),
    query: providerQuerySchema,
    maxResults: z.number().int().min(1).max(20).optional(),
  }),
  z.object({
    provider: z.literal("exa"),
    operation: z.literal("fetch"),
    query: providerQuerySchema,
    urls: z.array(providerUrlSchema).min(1).max(20),
    maxCharacters: z.number().int().min(1).max(20_000).optional(),
  }),
  z.object({
    provider: z.literal("web"),
    operation: z.literal("fetch"),
    query: providerQuerySchema,
    urls: z.array(targetedWebUrlSchema).min(1).max(5),
    targetKind: z.enum(["exact_fact", "named_document", "official_source"]),
    knownSourceReason: z.string().min(12).max(4_000),
    maxCharacters: z.number().int().min(1).max(200_000).optional(),
  }),
]);

const researchInstrumentResultSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("notebook_experiment"),
    parameterSetRefs: nonEmptyStrings.min(1),
    datasetRefs: nonEmptyStrings,
    replicateCount: z.number().int().min(1),
    deterministic: z.boolean(),
    metricRefs: nonEmptyStrings.min(1),
  }),
  z.object({
    kind: z.literal("property_falsification"),
    invariantRefs: nonEmptyStrings.min(1),
    generatedCaseCount: z.number().int().min(1),
    stateTransitionCount: z.number().int().min(0),
    counterexampleFound: z.boolean(),
    minimalCounterexampleRef: z.string().min(1).optional(),
    seedRefs: nonEmptyStrings.min(1),
  }),
  z.object({
    kind: z.literal("real_dependency_integration"),
    dependencyIdentityRefs: nonEmptyStrings.min(1),
    isolationRef: z.string().min(1),
    scenarioCount: z.number().int().min(1),
    passedScenarioCount: z.number().int().min(0),
    failedScenarioRefs: nonEmptyStrings,
  }),
  z.object({
    kind: z.literal("agent_behavior_eval"),
    agentTargetRefs: nonEmptyStrings.min(1),
    modelRefs: nonEmptyStrings.min(1),
    datasetRef: z.string().min(1),
    treatmentRef: z.string().min(1),
    controlRef: z.string().min(1),
    scorerRefs: nonEmptyStrings.min(1),
    traceRefs: nonEmptyStrings.min(1),
    sampleCount: z.number().int().min(1),
    replicateCount: z.number().int().min(1),
    seedRefs: nonEmptyStrings.min(1),
    humanBaselineRef: z.string().min(1).optional(),
  }),
  z.object({
    kind: z.literal("trace_analysis"),
    traceRefs: nonEmptyStrings.min(1),
    instrumentationRefs: nonEmptyStrings.min(1),
    evaluatorRefs: nonEmptyStrings,
    attributionMethodRef: z.string().min(1),
    spanCount: z.number().int().min(1),
  }),
  z.object({
    kind: z.literal("bounded_counterfactual"),
    assignmentRef: z.string().min(1),
    treatmentRef: z.string().min(1),
    controlRef: z.string().min(1),
    interventionRef: z.string().min(1),
    analysisRef: z.string().min(1),
    treatmentOutcomeRefs: nonEmptyStrings.min(1),
    controlOutcomeRefs: nonEmptyStrings.min(1),
    behaviorDeltaRefs: nonEmptyStrings.min(1),
    modelRefs: nonEmptyStrings,
    necessitySupported: z.boolean(),
    sufficiencySupported: z.boolean(),
  }),
  z.object({
    kind: z.literal("live_canary"),
    runtimeIdentityRefs: nonEmptyStrings.min(1),
    effectKeys: nonEmptyStrings.min(1),
    cleanupRefs: nonEmptyStrings.min(1),
    sampleCount: z.number().int().min(1),
    terminalOutcomeObserved: z.boolean(),
    rollbackAvailable: z.boolean(),
  }),
]);

const researchInstrumentArtifactSchema = z.object({
  location: z.enum(RESEARCH_INSTRUMENT_ARTIFACT_LOCATIONS),
  path: z.string().min(1).max(4_096),
  role: z.enum(RESEARCH_INSTRUMENT_ARTIFACT_ROLES),
  mediaType: z.string().min(1).max(256),
});

function collectJsonStrings(value: unknown, output = new Set<string>()): Set<string> {
  if (typeof value === "string") {
    output.add(value);
  } else if (Array.isArray(value)) {
    for (const entry of value) collectJsonStrings(entry, output);
  } else if (typeof value === "object" && value !== null) {
    for (const entry of Object.values(value)) collectJsonStrings(entry, output);
  }
  return output;
}

function requireInstrumentEvidenceReferenced(
  request: JsonObject,
  evidenceRefs: string[],
): void {
  const requestStrings = collectJsonStrings(request);
  const missing = evidenceRefs.filter((ref) => !requestStrings.has(ref));
  if (missing.length > 0) {
    throw new ResearchCycleError(
      "RESEARCH_INSTRUMENT_EVIDENCE_NOT_REFERENCED",
      "every verified research-instrument evidence ref must be referenced by the native Research Reflex request",
      { missingEvidenceRefs: missing },
    );
  }
}

function referencedInstrumentEvidenceRefs(value: unknown): string[] {
  return [...collectJsonStrings(value)]
    .filter((entry) => entry.startsWith("research-instrument-evidence:"))
    .sort();
}

function combinedInstrumentEvidenceRefs(
  referenced: string[],
  supplied: string[] | undefined,
): string[] {
  return [...new Set([...referenced, ...(supplied ?? [])])].sort();
}

async function acquireFrozenDiscoveryEvidence(
  providerBroker: ZesResearchProviderBroker,
  workspace: ResearchWorkspace,
  purpose: "fresh_acquisition" | "counterevidence_or_blind_challenge",
  request: {
    provider: "exa";
    operation: "search";
    query: string;
    maxResults: number;
  },
): Promise<ResearchProviderAcquisitionResult> {
  const result = await providerBroker.invoke(workspace, purpose, request);
  const providerEvidence = result.providerEvidence as JsonObject;
  const providerTrace = result.providerTrace as JsonObject;
  const evidenceFile = result.evidenceFile as JsonObject;
  return {
    status: "acquired",
    providerEvidenceRef: String(providerEvidence.evidence_ref ?? ""),
    providerEvidencePath: String(evidenceFile.path ?? ""),
    providerEvidenceFileSha256: String(
      result.providerEvidenceFileSha256 ?? "",
    ),
    providerTraceRef: String(providerTrace.traceRef ?? ""),
    providerTracePath: String(providerTrace.path ?? ""),
    providerTraceFileSha256: String(
      result.providerReceiptFileSha256 ?? "",
    ),
    providerEvidence,
    providerReceiptFileSha256: String(
      result.providerReceiptFileSha256 ?? "",
    ),
  };
}

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
  "zes_research_discovery_plan",
  "zes_research_discovery_acquire",
  "zes_research_horizon_record",
  "zes_research_horizon_status",
  "zes_research_instrument_plan",
  "zes_research_instrument_execute",
  "zes_research_instrument_record",
  "zes_research_instrument_status",
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
  instrumentManager = new ZesResearchInstrumentManager(manager),
  instrumentExecutor = new ZesResearchInstrumentExecutor(
    manager,
    instrumentManager,
    config.zesResearchCycle.instrumentExecution,
  ),
): void {
  if (!manager.enabled) return;

  registerLifecycleTool(
    server,
    config,
    registerTool,
    "zes_research_instrument_execute",
    {
      title: "Execute one planned shared-Lab instrument step",
      description:
        "Start one idempotent Inspect AI execution for an exact unblocked current-generation Research Reflex planRef and stepRef through the fixed server-owned shared ZES Research Lab. Before dispatch, DevSpace reads the Lab's no-inference status contract and binds the exact evaluator-policy digest, current profile directory, model availability, explicit-only rules, and adjudication/frontier sample ceilings. The action accepts only a named experiments/*.py@task entry, a shared evaluator profile, a bounded sample limit, exact succeeded basis execution refs for escalation, and an explicit restricted-profile acknowledgement. It accepts no command, executable, absolute path, Lab root, endpoint, credential, model override, reasoning override, protocol override, fallback, or live effect. The execution is durable and asynchronous: the same idempotency key never dispatches twice, terminal artifacts are copied into cycle evidence, and running or unknown outcomes are reconciled through zes_research_instrument_status. This is a ChatGPT/Sol-Pro MCP execution edge only; it does not alter or govern the Codex native harness or skill lifecycle, and a successful run is not research sufficiency or semantic acceptance.",
      inputSchema: {
        workspaceId: workspaceIdSchema,
        idempotencyKey: z.string()
          .min(1)
          .max(200)
          .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u),
        planRef: z.string().min(1),
        stepRef: z.string().min(1),
        adapter: z.literal("inspect_ai"),
        task: z.string()
          .min(1)
          .max(1_000)
          .regex(
            /^experiments\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.py@[A-Za-z_][A-Za-z0-9_]*$/u,
          ),
        profile: z.string()
          .regex(/^[a-z][a-z0-9_]{0,63}$/u)
          .optional(),
        limit: z.number().int().min(1).max(16).optional(),
        allowRestrictedProfile: z.boolean().optional(),
        basisExecutionRefs: z.array(
          z.string().regex(/^research-instrument-execution:[a-f0-9]{64}$/u),
        ).max(50).optional(),
      },
      outputSchema,
      ...toolMeta(config),
      annotations: boundedExternalExecutionAnnotations,
    },
    async (input: ResearchInstrumentExecuteInput & { workspaceId: string }) => {
      const { workspaceId, ...executionInput } = input;
      return await instrumentExecutor.execute(
        resolveWorkspace(workspaceId),
        executionInput,
      );
    },
  );

  registerLifecycleTool(
    server,
    config,
    registerTool,
    "zes_research_instrument_plan",
    {
      title: "Plan evidence-producing research instruments",
      description:
        "Select a bounded experimental evidence route for the current prepared or admitted Research Reflex generation. The planner derives property/stateful falsification, disposable real-dependency integration, parameterized computational notebooks, treatment/control agent evaluation, trace attribution, bounded counterfactual, or live-canary steps from the claim class and explicit evidence needs. It records only an executor-local plan and never invokes Jupyter, Hypothesis, Testcontainers, Inspect, Phoenix, a model, a container, or a live effect. Blocked steps identify missing sandbox, model, or live-effect boundaries. A plan never establishes truth or research sufficiency.",
      inputSchema: {
        workspaceId: workspaceIdSchema,
        idempotencyKey: z.string().min(1).max(200),
        claimClass: z.enum(RESEARCH_INSTRUMENT_CLAIM_CLASSES),
        claimRefs: nonEmptyStrings.min(1),
        question: z.string().min(1).max(20_000),
        hypothesis: z.string().min(1).max(20_000),
        falsifier: z.string().min(1).max(20_000),
        explicitEvidenceNeeds: z.array(
          z.enum(RESEARCH_EVIDENCE_NEED_KINDS),
        ).optional(),
        executionConstraints: z.object({
          executionBoundary: z.enum(
            RESEARCH_INSTRUMENT_EXECUTION_BOUNDARIES,
          ),
          modelUse: z.enum(RESEARCH_INSTRUMENT_MODEL_USE),
        }),
      },
      outputSchema,
      ...toolMeta(config),
      annotations: localStateAnnotations,
    },
    async (input: ResearchInstrumentPlanInput & { workspaceId: string }) => {
      const { workspaceId, ...planInput } = input;
      return await instrumentManager.plan(
        resolveWorkspace(workspaceId),
        planInput,
      );
    },
  );

  registerLifecycleTool(
    server,
    config,
    registerTool,
    "zes_research_instrument_record",
    {
      title: "Bind one research experiment receipt",
      description:
        "Bind one completed planned experiment to the current Research Reflex generation. The caller supplies typed treatment/control, model, dependency, trace, invariant, counterfactual, or live-canary fields plus 1-20 existing workspace or cycle-evidence artifacts. DevSpace reads only those bounded files, rejects traversal, symlinks, hard links, oversized files and self-referential instrument state, then records exact SHA-256 and byte identities. This tool does not execute the instrument. A passed receipt remains evidence under the planned claim ceiling and does not decide research sufficiency, semantic truth, publication, release, activation, runtime, or effect authority.",
      inputSchema: {
        workspaceId: workspaceIdSchema,
        idempotencyKey: z.string().min(1).max(200),
        planRef: z.string().min(1),
        stepRef: z.string().min(1),
        outcome: z.enum(RESEARCH_INSTRUMENT_OUTCOMES),
        startedAt: z.string().min(1),
        completedAt: z.string().min(1),
        toolName: z.string().min(1).max(1_000),
        toolVersion: z.string().min(1).max(1_000).optional(),
        adapterRef: z.string().min(1).max(2_000).optional(),
        environmentRefs: nonEmptyStrings,
        artifacts: z.array(researchInstrumentArtifactSchema).min(1).max(20),
        result: researchInstrumentResultSchema,
        limitations: nonEmptyStrings,
        unresolved: nonEmptyStrings,
      },
      outputSchema,
      ...toolMeta(config),
      annotations: localStateAnnotations,
    },
    async (input: ResearchInstrumentRecordInput & { workspaceId: string }) => {
      const { workspaceId, ...recordInput } = input;
      return await instrumentManager.record(
        resolveWorkspace(workspaceId),
        recordInput,
      );
    },
  );

  registerLifecycleTool(
    server,
    config,
    registerTool,
    "zes_research_instrument_status",
    {
      title: "Read research instrument plans and receipts",
      description:
        "Read current-generation experimental plans, blocked evidence steps, durable shared-Lab execution states, terminal artifact paths, receipt refs, claim ceilings, and bounded artifact-integrity checks. The call may reconcile a terminal Inspect runner receipt into executor-local cycle evidence but never redispatches a running or indeterminate execution. Earlier generations remain counted as stale rather than silently reused. This is executor-local experimental evidence state, not canonical task, semantic, research-sufficiency, writer, publication, release, activation, runtime, Codex-harness, or live-effect authority.",
      inputSchema: { workspaceId: workspaceIdSchema },
      outputSchema,
      ...toolMeta(config),
      annotations: localReconciliationAnnotations,
    },
    async (input: { workspaceId: string }) => {
      const workspace = resolveWorkspace(input.workspaceId);
      const status = await instrumentManager.status(workspace);
      return {
        ...status,
        execution: await instrumentExecutor.status(workspace),
      };
    },
  );

  registerLifecycleTool(
    server,
    config,
    registerTool,
    "zes_research_provider_invoke",
    {
      title: "Invoke a fixed Research Reflex evidence provider",
      description:
        "Acquire provider-verifiable evidence v2 inside the active prepared Research Reflex generation through one fixed broker. Context7 is for exact upstream documentation. Exa search is the registered open-world candidate-discovery operation. Exa fetch and targeted Web fetch are known-source acquisition operations and cannot satisfy open-world discovery. Every successful result binds provider, operation, route, transport, capability refs, and whether open-world candidate discovery actually occurred. The DevSpace service may attach its fixed provider credential handle to the exact provider child, but the model and arbitrary exec_command never receive the credential value or digest. The result includes providerEvidence plus the exact providerTrace to pass to zes_research_cycle_assess.",
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
        "Prepare the exact task, decision, evidence-regime, source-identity, implementation-boundary, and action-scope digests required by the native capability-bound ZES Research Reflex v3 admission request. Supply every exact shell command that may mutate source or dependencies; DevSpace persists only their SHA-256 digests and holds unbound shell mutation in enforce mode. Direct apply_patch/write/edit effects remain path-bound. This operation does not assess research sufficiency.",
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
    "zes_research_discovery_plan",
    {
      title: "Freeze a source-neutral research discovery portfolio",
      description:
        "Create or idempotently reread a bounded, deterministic query portfolio for the active prepared Research Reflex generation. The plan uses an explicit temporal regime, a profile plus typed required/conditional/not-applicable coverage lanes, and exact subject/incumbent/prior-snapshot refs. It freezes Exa search query text, query identities, result bounds, policy/portfolio/plan digests, lookback and revalidation dates without calling a provider. Source origin is neutral: official, open-source, failure/maintainer, successor, practitioner, and counterevidence lanes are coverage labels rather than truth claims. Replanning with changed inputs invalidates prior local acquisitions and horizon state; it grants no semantic, writer, publication, runtime, or effect authority.",
      inputSchema: {
        workspaceId: workspaceIdSchema,
        subjectRef: z.string().min(1).max(2_000),
        subjectQuestion: z.string().min(1).max(20_000),
        temporalRegime: discoveryTemporalRegimeSchema,
        asOf: z.string().min(1).max(200),
        knownCandidateRefs: nonEmptyStrings.max(100).optional(),
        incumbentRef: z.string().min(1).max(2_000).optional(),
        priorSnapshotRef: z.string().min(1).max(2_000).optional(),
        discoveryProfile: discoveryProfileSchema.optional(),
        explicitCoverageLanes: z.array(z.object({
          lane: discoveryLaneSchema,
          disposition: discoveryLaneDispositionSchema,
          reason: z.string().min(1).max(4_000),
        })).max(6).optional(),
      },
      outputSchema,
      ...toolMeta(config),
      annotations: localStateAnnotations,
    },
    async (input: ResearchDiscoveryPlanInput & { workspaceId: string }) => {
      const { workspaceId, ...planInput } = input;
      return { ...await manager.discoveryPlan(
        resolveWorkspace(workspaceId),
        planInput,
      ) };
    },
  );

  registerLifecycleTool(
    server,
    config,
    registerTool,
    "zes_research_discovery_acquire",
    {
      title: "Acquire a frozen open-world discovery portfolio",
      description:
        "Execute all or an exact subset of the frozen discovery queries through the fixed Research Reflex Exa-search broker. Each query receives one durable attempt reservation before the external call; DevSpace releases its lifecycle lock during provider execution, performs no automatic retry, and preserves terminal failure rather than replaying it. Successful evidence must prove the registered open-world candidate-discovery capability and is bound to owner-seeded origin, exact receipt/trace/evidence paths, SHA-256 identities, and the current plan generation. Required-lane coverage remains held until every frozen query in that lane is acquired. This operation cannot select a winner, claim sufficiency, mutate source, publish, deploy, or execute runtime effects.",
      inputSchema: {
        workspaceId: workspaceIdSchema,
        planRef: z.string().min(1).max(2_000),
        queryRefs: nonEmptyStrings.min(1).max(18).optional(),
        expectedGeneration: z.number().int().min(0).optional(),
      },
      outputSchema,
      ...toolMeta(config),
      annotations: externalEvidenceAnnotations,
    },
    async (input: ResearchDiscoveryAcquireInput & { workspaceId: string }) => {
      const { workspaceId, ...acquireInput } = input;
      return { ...await manager.discoveryAcquire(
        resolveWorkspace(workspaceId),
        acquireInput,
        async (workspace, purpose, request) =>
          await acquireFrozenDiscoveryEvidence(
            providerBroker,
            workspace,
            purpose,
            request,
          ),
      ) };
    },
  );

  registerLifecycleTool(
    server,
    config,
    registerTool,
    "zes_research_horizon_record",
    {
      title: "Record a typed research horizon checkpoint",
      description:
        "Record the current prepared generation's post-acquisition freshness horizon before native assessment. The caller supplies only typed event observations with exact current-plan evidence refs, exact subject refs and rationale; DevSpace validates event-to-lane constraints but does not parse provider prose or infer semantic change. Expiry is derived from the temporal regime and means revalidation is required, not that prior evidence became false. Prior portfolio/evidence identity deltas remain typed stale signals. The deterministic checkpoint binds the plan, policy, portfolio, generation and immutable evidence/trace digests and grants no research-sufficiency, writer, publication, runtime, or effect authority.",
      inputSchema: {
        workspaceId: workspaceIdSchema,
        planRef: z.string().min(1).max(2_000),
        expectedGeneration: z.number().int().min(0).optional(),
        asOf: z.string().min(1).max(200),
        priorSnapshot: z.object({
          snapshotRef: z.string().min(1).max(2_000),
          portfolioDigestSha256: sha256Schema,
          candidateRefs: nonEmptyStrings.max(100).optional(),
          incumbentRef: z.string().min(1).max(2_000).optional(),
          evidenceIdentities: z.array(z.object({
            evidenceRef: z.string().min(1).max(2_000),
            fileDigestSha256: sha256Schema,
          })).max(100).optional(),
        }).optional(),
        observations: z.array(z.object({
          kind: horizonEventKindSchema,
          evidenceRefs: nonEmptyStrings.min(1).max(20),
          subjectRefs: nonEmptyStrings.max(20),
          rationale: z.string().min(1).max(20_000),
        })).max(32).optional(),
      },
      outputSchema,
      ...toolMeta(config),
      annotations: localStateAnnotations,
    },
    async (input: ResearchHorizonInput & { workspaceId: string }) => {
      const { workspaceId, ...horizonInput } = input;
      return { ...await manager.horizonRecord(
        resolveWorkspace(workspaceId),
        horizonInput,
      ) };
    },
  );

  registerLifecycleTool(
    server,
    config,
    registerTool,
    "zes_research_horizon_status",
    {
      title: "Read the current research horizon checkpoint",
      description:
        "Read the active discovery horizon, typed signals, regime-aware dynamic expiry, plan/portfolio/policy identities and whether the next native Research Reflex assessment must refresh the decision. This is executor-local evidence lifecycle state, not canonical semantic, writer, publication, runtime, or effect authority.",
      inputSchema: { workspaceId: workspaceIdSchema },
      outputSchema,
      ...toolMeta(config),
      annotations: readOnlyAnnotations,
    },
    async (input: { workspaceId: string }) =>
      await manager.horizonStatus(resolveWorkspace(input.workspaceId)),
  );

  registerLifecycleTool(
    server,
    config,
    registerTool,
    "zes_research_cycle_assess",
    {
      title: "Assess through native ZES Research Reflex",
      description:
        "Invoke the fixed native `zes-research-reflex assess` application port with a capability-bound v3 request matching the prepared workspace bindings. Provider evidence v2 and its exact Context7, Exa, or targeted-source receipt must be supplied through trace refs and files under configured trust roots. The native verifier checks operation, route, transport, capability, and open-world-performed identity before issuing the v3 verdict and lease. Historical v1/v2 receipts remain decodeable but cannot create a new admission through this action gate. DevSpace does not substitute its own research judgment.",
      inputSchema: {
        workspaceId: workspaceIdSchema,
        request: jsonObjectSchema,
        providerTraces: z.array(providerTraceSchema).optional(),
        instrumentEvidenceRefs: nonEmptyStrings.min(1).optional(),
        discoveryEvidenceRefs: nonEmptyStrings.min(1).max(18).optional(),
      },
      outputSchema,
      ...toolMeta(config),
      annotations: localStateAnnotations,
    },
    async (input: {
      workspaceId: string;
      request: JsonObject;
      providerTraces?: ResearchProviderTraceInput[];
      instrumentEvidenceRefs?: string[];
      discoveryEvidenceRefs?: string[];
    }) => {
      const workspace = resolveWorkspace(input.workspaceId);
      let instrumentEvidenceVerification: Record<string, unknown> | undefined;
      const referencedEvidenceRefs = referencedInstrumentEvidenceRefs(
        input.request,
      );
      const evidenceRefs = combinedInstrumentEvidenceRefs(
        referencedEvidenceRefs,
        input.instrumentEvidenceRefs,
      );
      if (input.instrumentEvidenceRefs?.length) {
        requireInstrumentEvidenceReferenced(
          input.request,
          input.instrumentEvidenceRefs,
        );
      }
      if (evidenceRefs.length > 0) {
        instrumentEvidenceVerification =
          await instrumentManager.verifyEvidenceRefs(
            workspace,
            evidenceRefs,
          );
      }
      const result = await manager.assess(
        workspace,
        input.request,
        input.providerTraces ?? [],
        input.discoveryEvidenceRefs ?? [],
      );
      return instrumentEvidenceVerification
        ? { ...result, instrumentEvidenceVerification }
        : result;
    },
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
        instrumentEvidenceRefs: nonEmptyStrings.min(1).optional(),
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
      instrumentEvidenceRefs?: string[];
      challenge: ResearchPreCommitChallenge;
    }) => {
      const workspace = resolveWorkspace(input.workspaceId);
      let instrumentEvidenceVerification: Record<string, unknown> | undefined;
      const validationInstrumentRefs = input.validationRefs
        .filter((ref) => ref.startsWith("research-instrument-evidence:"));
      const evidenceRefs = combinedInstrumentEvidenceRefs(
        validationInstrumentRefs,
        input.instrumentEvidenceRefs,
      );
      if (input.instrumentEvidenceRefs?.length) {
        const validationRefs = new Set(input.validationRefs);
        const missing = input.instrumentEvidenceRefs.filter(
          (ref) => !validationRefs.has(ref),
        );
        if (missing.length > 0) {
          throw new ResearchCycleError(
            "RESEARCH_INSTRUMENT_EVIDENCE_NOT_IN_VALIDATION_REFS",
            "pre-commit research-instrument evidence refs must also be present in validationRefs",
            { missingEvidenceRefs: missing },
          );
        }
      }
      if (evidenceRefs.length > 0) {
        instrumentEvidenceVerification =
          await instrumentManager.verifyEvidenceRefs(
            workspace,
            evidenceRefs,
          );
      }
      const result = await manager.verifyPreCommit(
        workspace,
        input.validationRefs,
        input.challenge,
      );
      return instrumentEvidenceVerification
        ? { ...result, instrumentEvidenceVerification }
        : result;
    },
  );

  registerLifecycleTool(
    server,
    config,
    registerTool,
    "zes_research_cycle_status",
    {
      title: "Read ZES research lifecycle status",
      description:
        "Read the bounded executor-local lifecycle, prepared bindings, current native admission identity, causal invalidations, typed failure-plane observations and recovery dispositions, observed source paths, pre-commit checkpoint, commit observation, and closure. Failed command count is diagnostic evidence only; it does not itself invalidate semantic research. Scope, dependency, source-currentness, explicit semantic, validation, publication, and effect boundaries remain independently enforced. This status is not canonical task, semantic, writer, publication, release, activation, or effect authority.",
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
