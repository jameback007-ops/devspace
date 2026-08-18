import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import {
  canonicalDigest,
  ResearchCycleError,
  type ResearchInstrumentCycleContext,
  type ResearchWorkspace,
  ZesResearchCycleManager,
} from "./research-cycle.js";

const STATE_SCHEMA = "devspace.zes-research-instrument-state.v1";
const PLAN_SCHEMA = "devspace.zes-research-instrument-plan.v1";
const RECEIPT_SCHEMA = "devspace.zes-research-instrument-receipt.v1";
const MAX_PLANS = 100;
const MAX_RECEIPTS = 500;
const MAX_ARTIFACTS_PER_RECEIPT = 20;
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
const MAX_STATUS_INTEGRITY_RECEIPTS = 100;

export const RESEARCH_INSTRUMENT_CLAIM_CLASSES = [
  "architecture_tradeoff",
  "protocol_invariant",
  "dependency_interoperability",
  "performance_or_capacity",
  "agent_behavior_or_utility",
  "causal_reliance",
  "operational_resilience",
  "local_mechanical",
] as const;

export type ResearchInstrumentClaimClass =
  typeof RESEARCH_INSTRUMENT_CLAIM_CLASSES[number];

export const RESEARCH_EVIDENCE_NEED_KINDS = [
  "computational_modeling",
  "state_space_falsification",
  "real_dependency_behavior",
  "agent_behavioral_effect",
  "trace_attribution",
  "causal_effect",
  "live_operational_behavior",
] as const;

export type ResearchEvidenceNeedKind =
  typeof RESEARCH_EVIDENCE_NEED_KINDS[number];

export const RESEARCH_INSTRUMENT_KINDS = [
  "notebook_experiment",
  "property_falsification",
  "real_dependency_integration",
  "agent_behavior_eval",
  "trace_analysis",
  "bounded_counterfactual",
  "live_canary",
] as const;

export type ResearchInstrumentKind =
  typeof RESEARCH_INSTRUMENT_KINDS[number];

export const RESEARCH_INSTRUMENT_EXECUTION_BOUNDARIES = [
  "local_only",
  "isolated_sandbox",
  "bounded_live",
] as const;

export type ResearchInstrumentExecutionBoundary =
  typeof RESEARCH_INSTRUMENT_EXECUTION_BOUNDARIES[number];

export const RESEARCH_INSTRUMENT_MODEL_USE = [
  "forbidden",
  "allowed",
  "required",
] as const;

export type ResearchInstrumentModelUse =
  typeof RESEARCH_INSTRUMENT_MODEL_USE[number];

export const RESEARCH_INSTRUMENT_OUTCOMES = [
  "passed",
  "failed",
  "inconclusive",
  "indeterminate",
] as const;

export type ResearchInstrumentOutcome =
  typeof RESEARCH_INSTRUMENT_OUTCOMES[number];

export const RESEARCH_INSTRUMENT_ARTIFACT_LOCATIONS = [
  "workspace",
  "cycle_evidence",
] as const;

export type ResearchInstrumentArtifactLocation =
  typeof RESEARCH_INSTRUMENT_ARTIFACT_LOCATIONS[number];

export const RESEARCH_INSTRUMENT_ARTIFACT_ROLES = [
  "dataset",
  "configuration",
  "notebook",
  "trace",
  "log",
  "result",
  "report",
  "counterexample",
  "receipt",
] as const;

export type ResearchInstrumentArtifactRole =
  typeof RESEARCH_INSTRUMENT_ARTIFACT_ROLES[number];

export interface ResearchInstrumentExecutionConstraints {
  executionBoundary: ResearchInstrumentExecutionBoundary;
  modelUse: ResearchInstrumentModelUse;
}

export interface ResearchInstrumentPlanInput {
  idempotencyKey: string;
  claimClass: ResearchInstrumentClaimClass;
  claimRefs: string[];
  question: string;
  hypothesis: string;
  falsifier: string;
  explicitEvidenceNeeds?: ResearchEvidenceNeedKind[];
  executionConstraints: ResearchInstrumentExecutionConstraints;
}

export interface ResearchInstrumentArtifactInput {
  location: ResearchInstrumentArtifactLocation;
  path: string;
  role: ResearchInstrumentArtifactRole;
  mediaType: string;
}

export interface NotebookExperimentResult {
  kind: "notebook_experiment";
  parameterSetRefs: string[];
  datasetRefs: string[];
  replicateCount: number;
  deterministic: boolean;
  metricRefs: string[];
}

export interface PropertyFalsificationResult {
  kind: "property_falsification";
  invariantRefs: string[];
  generatedCaseCount: number;
  stateTransitionCount: number;
  counterexampleFound: boolean;
  minimalCounterexampleRef?: string;
  seedRefs: string[];
}

export interface RealDependencyIntegrationResult {
  kind: "real_dependency_integration";
  dependencyIdentityRefs: string[];
  isolationRef: string;
  scenarioCount: number;
  passedScenarioCount: number;
  failedScenarioRefs: string[];
}

export interface AgentBehaviorEvalResult {
  kind: "agent_behavior_eval";
  agentTargetRefs: string[];
  modelRefs: string[];
  datasetRef: string;
  treatmentRef: string;
  controlRef: string;
  scorerRefs: string[];
  traceRefs: string[];
  sampleCount: number;
  replicateCount: number;
  seedRefs: string[];
  humanBaselineRef?: string;
}

export interface TraceAnalysisResult {
  kind: "trace_analysis";
  traceRefs: string[];
  instrumentationRefs: string[];
  evaluatorRefs: string[];
  attributionMethodRef: string;
  spanCount: number;
}

export interface BoundedCounterfactualResult {
  kind: "bounded_counterfactual";
  assignmentRef: string;
  treatmentRef: string;
  controlRef: string;
  interventionRef: string;
  analysisRef: string;
  treatmentOutcomeRefs: string[];
  controlOutcomeRefs: string[];
  behaviorDeltaRefs: string[];
  modelRefs: string[];
  necessitySupported: boolean;
  sufficiencySupported: boolean;
}

export interface LiveCanaryResult {
  kind: "live_canary";
  runtimeIdentityRefs: string[];
  effectKeys: string[];
  cleanupRefs: string[];
  sampleCount: number;
  terminalOutcomeObserved: boolean;
  rollbackAvailable: boolean;
}

export type ResearchInstrumentResult =
  | NotebookExperimentResult
  | PropertyFalsificationResult
  | RealDependencyIntegrationResult
  | AgentBehaviorEvalResult
  | TraceAnalysisResult
  | BoundedCounterfactualResult
  | LiveCanaryResult;

export interface ResearchInstrumentRecordInput {
  idempotencyKey: string;
  planRef: string;
  stepRef: string;
  outcome: ResearchInstrumentOutcome;
  startedAt: string;
  completedAt: string;
  toolName: string;
  toolVersion?: string;
  adapterRef?: string;
  environmentRefs: string[];
  artifacts: ResearchInstrumentArtifactInput[];
  result: ResearchInstrumentResult;
  limitations: string[];
  unresolved: string[];
}

interface InstrumentPolicy {
  evidenceNeedKind: ResearchEvidenceNeedKind;
  instrumentKind: ResearchInstrumentKind;
  capabilityRef: string;
  candidateAdapters: string[];
  objective: string;
  requiredArtifactRoles: ResearchInstrumentArtifactRole[];
  claimCeiling: string;
  modelBacked: boolean;
  liveEffect: boolean;
}

interface ResearchInstrumentStep {
  stepRef: string;
  ordinal: number;
  evidenceNeedKind: ResearchEvidenceNeedKind;
  instrumentKind: ResearchInstrumentKind;
  capabilityRef: string;
  candidateAdapters: string[];
  objective: string;
  falsifier: string;
  requiredArtifactRoles: ResearchInstrumentArtifactRole[];
  claimCeiling: string;
  modelBacked: boolean;
  liveEffect: boolean;
  blocked: boolean;
  blockingFactors: string[];
}

interface ResearchInstrumentPlanRecord {
  schemaVersion: typeof PLAN_SCHEMA;
  planRef: string;
  idempotencyKeyDigestSha256: string;
  inputDigestSha256: string;
  cycleRef: string;
  generation: number;
  phaseAtPlan: ResearchInstrumentCycleContext["phase"];
  taskRef: string;
  materialDecisionRef: string;
  decisionBoundaryRef: string;
  claimClass: ResearchInstrumentClaimClass;
  claimRefs: string[];
  question: string;
  hypothesis: string;
  falsifier: string;
  explicitEvidenceNeeds: ResearchEvidenceNeedKind[];
  derivedEvidenceNeeds: ResearchEvidenceNeedKind[];
  executionConstraints: ResearchInstrumentExecutionConstraints;
  status:
    | "planned"
    | "partially_blocked"
    | "held"
    | "no_instrument_required";
  steps: ResearchInstrumentStep[];
  workspaceSnapshot: ResearchInstrumentCycleContext["workspaceSnapshot"];
  createdAt: string;
}

interface ResearchInstrumentArtifactRecord {
  artifactRef: string;
  location: ResearchInstrumentArtifactLocation;
  path: string;
  role: ResearchInstrumentArtifactRole;
  mediaType: string;
  byteCount: number;
  sha256: string;
}

interface ResearchInstrumentReceiptRecord {
  schemaVersion: typeof RECEIPT_SCHEMA;
  receiptRef: string;
  evidenceRef: string;
  idempotencyKeyDigestSha256: string;
  inputDigestSha256: string;
  cycleRef: string;
  generation: number;
  planRef: string;
  stepRef: string;
  instrumentKind: ResearchInstrumentKind;
  evidenceNeedKind: ResearchEvidenceNeedKind;
  outcome: ResearchInstrumentOutcome;
  startedAt: string;
  completedAt: string;
  toolName: string;
  toolVersion?: string;
  adapterRef?: string;
  environmentRefs: string[];
  artifacts: ResearchInstrumentArtifactRecord[];
  result: ResearchInstrumentResult;
  limitations: string[];
  unresolved: string[];
  claimCeiling: string;
  workspaceSnapshot: ResearchInstrumentCycleContext["workspaceSnapshot"];
  phaseAtRecord: ResearchInstrumentCycleContext["phase"];
  recordedAt: string;
}

interface ResearchInstrumentState {
  schemaVersion: typeof STATE_SCHEMA;
  cycleRef: string;
  workspaceRootDigestSha256: string;
  plans: ResearchInstrumentPlanRecord[];
  receipts: ResearchInstrumentReceiptRecord[];
  updatedAt: string;
}

interface ResearchInstrumentManagerOptions {
  now?: () => Date;
}

const CLAIM_DEFAULT_NEEDS: Record<
  ResearchInstrumentClaimClass,
  ResearchEvidenceNeedKind[]
> = {
  architecture_tradeoff: [],
  protocol_invariant: ["state_space_falsification"],
  dependency_interoperability: ["real_dependency_behavior"],
  performance_or_capacity: [
    "computational_modeling",
    "real_dependency_behavior",
  ],
  agent_behavior_or_utility: [
    "agent_behavioral_effect",
    "trace_attribution",
  ],
  causal_reliance: ["causal_effect", "trace_attribution"],
  operational_resilience: [
    "state_space_falsification",
    "live_operational_behavior",
  ],
  local_mechanical: [],
};

const INSTRUMENT_POLICIES: Record<ResearchEvidenceNeedKind, InstrumentPolicy> = {
  computational_modeling: {
    evidenceNeedKind: "computational_modeling",
    instrumentKind: "notebook_experiment",
    capabilityRef: "capability:parameterized-computational-experiment:v1",
    candidateAdapters: ["Jupyter", "Papermill", "nbclient"],
    objective:
      "Execute a parameter-bound computational model or analysis and retain the executable notebook plus exact results.",
    requiredArtifactRoles: ["notebook", "result"],
    claimCeiling: "bounded_computational_observation_only",
    modelBacked: false,
    liveEffect: false,
  },
  state_space_falsification: {
    evidenceNeedKind: "state_space_falsification",
    instrumentKind: "property_falsification",
    capabilityRef: "capability:property-stateful-falsification:v1",
    candidateAdapters: ["Hypothesis", "QuickCheck-compatible property runner"],
    objective:
      "Generate data and action sequences that attempt to falsify explicit invariants and retain any minimized counterexample.",
    requiredArtifactRoles: ["result"],
    claimCeiling: "bounded_search_no_counterexample_or_minimized_counterexample",
    modelBacked: false,
    liveEffect: false,
  },
  real_dependency_behavior: {
    evidenceNeedKind: "real_dependency_behavior",
    instrumentKind: "real_dependency_integration",
    capabilityRef: "capability:ephemeral-real-dependency-test:v1",
    candidateAdapters: ["Testcontainers", "Docker Compose test environment"],
    objective:
      "Exercise the implementation against exact disposable dependency versions rather than mocks.",
    requiredArtifactRoles: ["result"],
    claimCeiling: "tested_dependency_versions_and_scenarios_only",
    modelBacked: false,
    liveEffect: false,
  },
  agent_behavioral_effect: {
    evidenceNeedKind: "agent_behavioral_effect",
    instrumentKind: "agent_behavior_eval",
    capabilityRef: "capability:treatment-control-agent-evaluation:v1",
    candidateAdapters: ["Inspect AI", "provider-neutral agent evaluation harness"],
    objective:
      "Run the same representative dataset under explicit treatment and control conditions and score trajectories and outcomes.",
    requiredArtifactRoles: ["trace", "result"],
    claimCeiling: "sampled_treatment_control_agent_behavior_only",
    modelBacked: true,
    liveEffect: false,
  },
  trace_attribution: {
    evidenceNeedKind: "trace_attribution",
    instrumentKind: "trace_analysis",
    capabilityRef: "capability:trace-attribution-and-experiment-analysis:v1",
    candidateAdapters: ["OpenTelemetry", "Phoenix", "Inspect eval logs"],
    objective:
      "Bind claims to exact traces, spans, evaluator annotations, and attribution methods rather than self-report alone.",
    requiredArtifactRoles: ["trace", "result"],
    claimCeiling: "observed_trajectory_and_attribution_only",
    modelBacked: false,
    liveEffect: false,
  },
  causal_effect: {
    evidenceNeedKind: "causal_effect",
    instrumentKind: "bounded_counterfactual",
    capabilityRef: "capability:bounded-treatment-control-counterfactual:v1",
    candidateAdapters: [
      "Inspect AI treatment/control tasks",
      "custom randomized or matched counterfactual harness",
      "Jupyter statistical analysis",
    ],
    objective:
      "Compare an explicit intervention with a control under bound assignment and outcome lineage before claiming causal support.",
    requiredArtifactRoles: ["result", "report"],
    claimCeiling: "bounded_counterfactual_support_only",
    modelBacked: true,
    liveEffect: false,
  },
  live_operational_behavior: {
    evidenceNeedKind: "live_operational_behavior",
    instrumentKind: "live_canary",
    capabilityRef: "capability:bounded-live-operational-canary:v1",
    candidateAdapters: ["bounded deployment canary", "fault-injection canary"],
    objective:
      "Observe exact runtime behavior under a separately authorized bounded canary with terminal cleanup or rollback evidence.",
    requiredArtifactRoles: ["receipt", "report"],
    claimCeiling: "bounded_live_runtime_observation_only",
    modelBacked: false,
    liveEffect: true,
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new ResearchCycleError(
      "RESEARCH_INSTRUMENT_IDENTITY_REQUIRED",
      `${label} is required`,
    );
  }
  return normalized;
}

function uniqueStrings(values: readonly string[], label: string): string[] {
  const normalized = values.map((value) => value.trim()).filter(Boolean);
  if (normalized.length !== values.length) {
    throw new ResearchCycleError(
      "RESEARCH_INSTRUMENT_EMPTY_IDENTITY",
      `${label} cannot contain empty values`,
    );
  }
  return [...new Set(normalized)].sort();
}

function assertNoCredentialMaterial(value: unknown, label: string): void {
  if (typeof value === "string") {
    if (
      /(?:^|[?&;\s])(?:access[_-]?token|refresh[_-]?token|token|secret|password|passwd|api[_-]?key)\s*[:=]\s*\S+/iu.test(
        value,
      )
      || /\bbearer\s+[a-z0-9._~+/-]{8,}/iu.test(value)
      || /^[a-z][a-z0-9+.-]*:\/\/[^/\s]*@/iu.test(value)
      || /\bsk-[a-z0-9_-]{16,}\b/iu.test(value)
    ) {
      throw new ResearchCycleError(
        "RESEARCH_INSTRUMENT_CREDENTIAL_MATERIAL_REJECTED",
        `${label} may not contain credential values or credential-bearing references`,
      );
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) assertNoCredentialMaterial(entry, label);
    return;
  }
  if (isRecord(value)) {
    for (const entry of Object.values(value)) {
      assertNoCredentialMaterial(entry, label);
    }
  }
}

function uniqueEvidenceNeeds(
  values: readonly ResearchEvidenceNeedKind[],
): ResearchEvidenceNeedKind[] {
  const selected = new Set(values);
  return RESEARCH_EVIDENCE_NEED_KINDS.filter((value) => selected.has(value));
}

function normalizeRelativePath(value: string, label: string): string {
  const normalized = value.trim().replaceAll("\\", "/").replace(/^\.\//u, "");
  if (
    !normalized
    || normalized.startsWith("/")
    || normalized === ".."
    || normalized.startsWith("../")
    || normalized.includes("/../")
  ) {
    throw new ResearchCycleError(
      "RESEARCH_INSTRUMENT_PATH_INVALID",
      `${label} must be a workspace-relative path`,
      { path: value },
    );
  }
  return normalized;
}

function pathInside(path: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function keyDigest(value: string): string {
  return createHash("sha256").update(requiredString(value, "idempotencyKey"))
    .digest("hex");
}

async function sha256FileHandle(handle: FileHandle): Promise<string> {
  const hash = createHash("sha256");
  for await (
    const chunk of handle.createReadStream({ autoClose: false, start: 0 })
  ) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, path);
}

function parseTimestamp(value: string, label: string): number {
  const milliseconds = Date.parse(requiredString(value, label));
  if (!Number.isFinite(milliseconds)) {
    throw new ResearchCycleError(
      "RESEARCH_INSTRUMENT_TIMESTAMP_INVALID",
      `${label} must be an ISO-8601 timestamp`,
      { value },
    );
  }
  return milliseconds;
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new ResearchCycleError(
      "RESEARCH_INSTRUMENT_RESULT_INVALID",
      `${label} must be a positive integer`,
      { value },
    );
  }
}

function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new ResearchCycleError(
      "RESEARCH_INSTRUMENT_RESULT_INVALID",
      `${label} must be a non-negative integer`,
      { value },
    );
  }
}

function blockingFactors(
  policy: InstrumentPolicy,
  claimClass: ResearchInstrumentClaimClass,
  constraints: ResearchInstrumentExecutionConstraints,
): string[] {
  const factors: string[] = [];
  if (
    ["real_dependency_integration", "agent_behavior_eval"].includes(
      policy.instrumentKind,
    )
    && constraints.executionBoundary === "local_only"
  ) {
    factors.push("isolated_or_live_execution_boundary_required");
  }
  if (
    policy.instrumentKind === "agent_behavior_eval"
    && constraints.modelUse === "forbidden"
  ) {
    factors.push("model_execution_forbidden");
  }
  if (
    policy.instrumentKind === "bounded_counterfactual"
    && claimClass === "causal_reliance"
  ) {
    if (constraints.modelUse === "forbidden") {
      factors.push("model_execution_forbidden_for_agent_causal_claim");
    }
    if (constraints.executionBoundary === "local_only") {
      factors.push("isolated_or_live_execution_boundary_required");
    }
  }
  if (
    policy.instrumentKind === "live_canary"
    && constraints.executionBoundary !== "bounded_live"
  ) {
    factors.push("bounded_live_execution_boundary_required");
  }
  return [...new Set(factors)].sort();
}

function publicPolicy(): Record<string, unknown> {
  return {
    authority: "executor_local_experimental_evidence_only",
    executesExternalInstrument: false,
    instrumentAdaptersOptional: true,
    researchSufficiencyAuthority: false,
    semanticJudgmentAuthority: false,
    sourceTruthAuthority: false,
    writerAuthority: false,
    publicationAuthority: false,
    releaseOrActivationAuthority: false,
    runtimeOrEffectAuthority: false,
    liveCanaryRequiresSeparateEffectAuthority: true,
    successfulReceiptDoesNotImplyResearchSufficiency: true,
    modelSelfReportIsNotIndependentEvidence: true,
  };
}

function assertPlanningPhase(context: ResearchInstrumentCycleContext): void {
  if (!new Set(["prepared", "admitted"]).has(context.phase)) {
    throw new ResearchCycleError(
      "RESEARCH_INSTRUMENT_PHASE_NOT_READY",
      `instrument planning and recording require prepared or admitted phase, found ${context.phase}`,
      { phase: context.phase, cycleRef: context.cycleRef },
    );
  }
}

function normalizePlanInput(input: ResearchInstrumentPlanInput) {
  const explicitEvidenceNeeds = uniqueEvidenceNeeds(
    input.explicitEvidenceNeeds ?? [],
  );
  const normalized = {
    claimClass: input.claimClass,
    claimRefs: uniqueStrings(input.claimRefs, "claimRefs"),
    question: requiredString(input.question, "question"),
    hypothesis: requiredString(input.hypothesis, "hypothesis"),
    falsifier: requiredString(input.falsifier, "falsifier"),
    explicitEvidenceNeeds,
    executionConstraints: input.executionConstraints,
  };
  assertNoCredentialMaterial(normalized, "research instrument plan");
  return normalized;
}

function normalizeRecordInput(input: ResearchInstrumentRecordInput) {
  const startedAt = requiredString(input.startedAt, "startedAt");
  const completedAt = requiredString(input.completedAt, "completedAt");
  if (parseTimestamp(completedAt, "completedAt") < parseTimestamp(startedAt, "startedAt")) {
    throw new ResearchCycleError(
      "RESEARCH_INSTRUMENT_TIME_ORDER_INVALID",
      "completedAt cannot precede startedAt",
    );
  }
  if (
    input.artifacts.length < 1
    || input.artifacts.length > MAX_ARTIFACTS_PER_RECEIPT
  ) {
    throw new ResearchCycleError(
      "RESEARCH_INSTRUMENT_ARTIFACT_COUNT_INVALID",
      `each receipt requires 1-${MAX_ARTIFACTS_PER_RECEIPT} artifacts`,
      { count: input.artifacts.length },
    );
  }
  const artifacts = input.artifacts.map((artifact) => ({
    location: artifact.location,
    path: normalizeRelativePath(artifact.path, "artifact path"),
    role: artifact.role,
    mediaType: requiredString(artifact.mediaType, "artifact mediaType"),
  })).sort((left, right) =>
    `${left.location}:${left.path}:${left.role}`.localeCompare(
      `${right.location}:${right.path}:${right.role}`,
    )
  );
  const artifactKeys = artifacts.map((artifact) =>
    `${artifact.location}:${artifact.path}:${artifact.role}`
  );
  if (new Set(artifactKeys).size !== artifactKeys.length) {
    throw new ResearchCycleError(
      "RESEARCH_INSTRUMENT_ARTIFACT_DUPLICATE",
      "artifact location, path, and role identities must be unique",
    );
  }
  const normalized = {
    planRef: requiredString(input.planRef, "planRef"),
    stepRef: requiredString(input.stepRef, "stepRef"),
    outcome: input.outcome,
    startedAt,
    completedAt,
    toolName: requiredString(input.toolName, "toolName"),
    toolVersion: input.toolVersion?.trim() || undefined,
    adapterRef: input.adapterRef?.trim() || undefined,
    environmentRefs: uniqueStrings(input.environmentRefs, "environmentRefs"),
    artifacts,
    result: input.result,
    limitations: uniqueStrings(input.limitations, "limitations"),
    unresolved: uniqueStrings(input.unresolved, "unresolved"),
  };
  assertNoCredentialMaterial(normalized, "research instrument receipt");
  return normalized;
}

function validateResult(
  step: ResearchInstrumentStep,
  outcome: ResearchInstrumentOutcome,
  result: ResearchInstrumentResult,
  artifacts: ResearchInstrumentArtifactRecord[],
): void {
  if (result.kind !== step.instrumentKind) {
    throw new ResearchCycleError(
      "RESEARCH_INSTRUMENT_RESULT_KIND_MISMATCH",
      "result kind does not match the planned instrument",
      { expected: step.instrumentKind, observed: result.kind },
    );
  }
  const roles = new Set(artifacts.map((artifact) => artifact.role));
  for (const role of step.requiredArtifactRoles) {
    if (!roles.has(role)) {
      throw new ResearchCycleError(
        "RESEARCH_INSTRUMENT_REQUIRED_ARTIFACT_MISSING",
        `instrument ${step.instrumentKind} requires artifact role ${role}`,
        { role, stepRef: step.stepRef },
      );
    }
  }
  switch (result.kind) {
    case "notebook_experiment":
      assertPositiveInteger(result.replicateCount, "replicateCount");
      if (uniqueStrings(result.parameterSetRefs, "parameterSetRefs").length === 0) {
        throw new ResearchCycleError(
          "RESEARCH_INSTRUMENT_RESULT_INVALID",
          "notebook experiments require at least one parameter-set ref",
        );
      }
      uniqueStrings(result.datasetRefs, "datasetRefs");
      if (uniqueStrings(result.metricRefs, "metricRefs").length === 0) {
        throw new ResearchCycleError(
          "RESEARCH_INSTRUMENT_RESULT_INVALID",
          "notebook experiments require at least one metric ref",
        );
      }
      break;
    case "property_falsification":
      if (uniqueStrings(result.invariantRefs, "invariantRefs").length === 0) {
        throw new ResearchCycleError(
          "RESEARCH_INSTRUMENT_RESULT_INVALID",
          "property falsification requires at least one invariantRef",
        );
      }
      assertPositiveInteger(result.generatedCaseCount, "generatedCaseCount");
      assertNonNegativeInteger(result.stateTransitionCount, "stateTransitionCount");
      if (uniqueStrings(result.seedRefs, "seedRefs").length === 0) {
        throw new ResearchCycleError(
          "RESEARCH_INSTRUMENT_RESULT_INVALID",
          "property falsification requires an exact seed or replay ref",
        );
      }
      if (result.counterexampleFound) {
        requiredString(
          result.minimalCounterexampleRef ?? "",
          "minimalCounterexampleRef",
        );
        if (!roles.has("counterexample")) {
          throw new ResearchCycleError(
            "RESEARCH_INSTRUMENT_COUNTEREXAMPLE_ARTIFACT_MISSING",
            "a discovered counterexample requires a counterexample artifact",
          );
        }
        if (outcome === "passed") {
          throw new ResearchCycleError(
            "RESEARCH_INSTRUMENT_OUTCOME_INCONSISTENT",
            "a property run with a counterexample cannot be recorded as passed",
          );
        }
      } else if (outcome === "failed") {
        throw new ResearchCycleError(
          "RESEARCH_INSTRUMENT_OUTCOME_INCONSISTENT",
          "a failed property result must identify the counterexample; use indeterminate for infrastructure failure",
        );
      }
      break;
    case "real_dependency_integration":
      if (
        uniqueStrings(
          result.dependencyIdentityRefs,
          "dependencyIdentityRefs",
        ).length === 0
      ) {
        throw new ResearchCycleError(
          "RESEARCH_INSTRUMENT_RESULT_INVALID",
          "real dependency integration requires exact dependency identities",
        );
      }
      requiredString(result.isolationRef, "isolationRef");
      assertPositiveInteger(result.scenarioCount, "scenarioCount");
      assertNonNegativeInteger(result.passedScenarioCount, "passedScenarioCount");
      if (result.passedScenarioCount > result.scenarioCount) {
        throw new ResearchCycleError(
          "RESEARCH_INSTRUMENT_RESULT_INVALID",
          "passedScenarioCount cannot exceed scenarioCount",
        );
      }
      uniqueStrings(result.failedScenarioRefs, "failedScenarioRefs");
      if (
        result.passedScenarioCount < result.scenarioCount
        && result.failedScenarioRefs.length === 0
      ) {
        throw new ResearchCycleError(
          "RESEARCH_INSTRUMENT_RESULT_INVALID",
          "every incomplete real-dependency result requires failed scenario refs",
        );
      }
      if (
        outcome === "passed"
        && result.passedScenarioCount !== result.scenarioCount
      ) {
        throw new ResearchCycleError(
          "RESEARCH_INSTRUMENT_OUTCOME_INCONSISTENT",
          "a passed integration receipt requires every scenario to pass",
        );
      }
      if (
        outcome === "failed"
        && result.passedScenarioCount === result.scenarioCount
      ) {
        throw new ResearchCycleError(
          "RESEARCH_INSTRUMENT_OUTCOME_INCONSISTENT",
          "a failed integration receipt requires at least one failed scenario",
        );
      }
      break;
    case "agent_behavior_eval":
      if (uniqueStrings(result.agentTargetRefs, "agentTargetRefs").length === 0) {
        throw new ResearchCycleError(
          "RESEARCH_INSTRUMENT_RESULT_INVALID",
          "agent evaluation requires at least one agent target",
        );
      }
      if (uniqueStrings(result.modelRefs, "modelRefs").length === 0) {
        throw new ResearchCycleError(
          "RESEARCH_INSTRUMENT_RESULT_INVALID",
          "agent evaluation requires exact model refs",
        );
      }
      requiredString(result.datasetRef, "datasetRef");
      const treatmentRef = requiredString(result.treatmentRef, "treatmentRef");
      const controlRef = requiredString(result.controlRef, "controlRef");
      if (treatmentRef === controlRef) {
        throw new ResearchCycleError(
          "RESEARCH_INSTRUMENT_TREATMENT_CONTROL_COLLAPSED",
          "agent treatment and control refs must differ",
        );
      }
      if (uniqueStrings(result.scorerRefs, "scorerRefs").length === 0) {
        throw new ResearchCycleError(
          "RESEARCH_INSTRUMENT_RESULT_INVALID",
          "agent evaluation requires at least one scorerRef",
        );
      }
      if (uniqueStrings(result.traceRefs, "traceRefs").length === 0) {
        throw new ResearchCycleError(
          "RESEARCH_INSTRUMENT_RESULT_INVALID",
          "agent evaluation requires exact trace refs",
        );
      }
      assertPositiveInteger(result.sampleCount, "sampleCount");
      assertPositiveInteger(result.replicateCount, "replicateCount");
      if (uniqueStrings(result.seedRefs, "seedRefs").length === 0) {
        throw new ResearchCycleError(
          "RESEARCH_INSTRUMENT_RESULT_INVALID",
          "agent evaluation requires exact seed or replay refs",
        );
      }
      if (result.humanBaselineRef !== undefined) {
        requiredString(result.humanBaselineRef, "humanBaselineRef");
      }
      break;
    case "trace_analysis":
      if (uniqueStrings(result.traceRefs, "traceRefs").length === 0) {
        throw new ResearchCycleError(
          "RESEARCH_INSTRUMENT_RESULT_INVALID",
          "trace analysis requires trace refs",
        );
      }
      if (
        uniqueStrings(result.instrumentationRefs, "instrumentationRefs").length
        === 0
      ) {
        throw new ResearchCycleError(
          "RESEARCH_INSTRUMENT_RESULT_INVALID",
          "trace analysis requires instrumentation refs",
        );
      }
      uniqueStrings(result.evaluatorRefs, "evaluatorRefs");
      requiredString(result.attributionMethodRef, "attributionMethodRef");
      assertPositiveInteger(result.spanCount, "spanCount");
      break;
    case "bounded_counterfactual": {
      requiredString(result.assignmentRef, "assignmentRef");
      const treatmentRef = requiredString(result.treatmentRef, "treatmentRef");
      const controlRef = requiredString(result.controlRef, "controlRef");
      if (treatmentRef === controlRef) {
        throw new ResearchCycleError(
          "RESEARCH_INSTRUMENT_TREATMENT_CONTROL_COLLAPSED",
          "counterfactual treatment and control refs must differ",
        );
      }
      requiredString(result.interventionRef, "interventionRef");
      requiredString(result.analysisRef, "analysisRef");
      if (
        uniqueStrings(result.treatmentOutcomeRefs, "treatmentOutcomeRefs").length
        === 0
        || uniqueStrings(result.controlOutcomeRefs, "controlOutcomeRefs").length
          === 0
      ) {
        throw new ResearchCycleError(
          "RESEARCH_INSTRUMENT_RESULT_INVALID",
          "bounded counterfactual evidence requires treatment and control outcomes",
        );
      }
      if (uniqueStrings(result.behaviorDeltaRefs, "behaviorDeltaRefs").length === 0) {
        throw new ResearchCycleError(
          "RESEARCH_INSTRUMENT_RESULT_INVALID",
          "bounded counterfactual evidence requires behavior delta refs",
        );
      }
      uniqueStrings(result.modelRefs, "modelRefs");
      if (outcome === "passed" && !result.necessitySupported) {
        throw new ResearchCycleError(
          "RESEARCH_INSTRUMENT_OUTCOME_INCONSISTENT",
          "a passed bounded counterfactual requires necessity support",
        );
      }
      break;
    }
    case "live_canary":
      if (
        uniqueStrings(result.runtimeIdentityRefs, "runtimeIdentityRefs").length
        === 0
        || uniqueStrings(result.effectKeys, "effectKeys").length === 0
        || uniqueStrings(result.cleanupRefs, "cleanupRefs").length === 0
      ) {
        throw new ResearchCycleError(
          "RESEARCH_INSTRUMENT_RESULT_INVALID",
          "live canary evidence requires runtime, effect, and cleanup refs",
        );
      }
      assertPositiveInteger(result.sampleCount, "sampleCount");
      if (outcome === "passed" && !result.terminalOutcomeObserved) {
        throw new ResearchCycleError(
          "RESEARCH_INSTRUMENT_OUTCOME_INCONSISTENT",
          "a passed live canary requires terminal outcome observation",
        );
      }
      break;
  }
}

export class ZesResearchInstrumentManager {
  private readonly now: () => Date;
  private readonly locks = new Map<string, Promise<void>>();

  constructor(
    private readonly cycleManager: ZesResearchCycleManager,
    options: ResearchInstrumentManagerOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  private statePath(context: ResearchInstrumentCycleContext): string {
    return resolve(context.evidenceDirectory, "instruments", "state.json");
  }

  private async withLock<T>(
    workspace: ResearchWorkspace,
    operation: () => Promise<T>,
  ): Promise<T> {
    const key = canonicalDigest(resolve(workspace.root));
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const current = new Promise<void>((resolveLock) => {
      release = resolveLock;
    });
    const queued = previous.then(() => current);
    this.locks.set(key, queued);
    await previous;
    try {
      return await operation();
    } finally {
      release?.();
      if (this.locks.get(key) === queued) this.locks.delete(key);
    }
  }

  private async readState(
    workspace: ResearchWorkspace,
    context: ResearchInstrumentCycleContext,
  ): Promise<ResearchInstrumentState> {
    const path = this.statePath(context);
    try {
      const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
      if (
        !isRecord(raw)
        || raw.schemaVersion !== STATE_SCHEMA
        || raw.cycleRef !== context.cycleRef
        || raw.workspaceRootDigestSha256
          !== canonicalDigest(resolve(workspace.root))
        || !Array.isArray(raw.plans)
        || !Array.isArray(raw.receipts)
      ) {
        throw new ResearchCycleError(
          "RESEARCH_INSTRUMENT_STATE_INVALID",
          "persisted research-instrument state does not match this cycle and workspace",
        );
      }
      return raw as unknown as ResearchInstrumentState;
    } catch (error) {
      if (
        error instanceof Error
        && "code" in error
        && error.code === "ENOENT"
      ) {
        return {
          schemaVersion: STATE_SCHEMA,
          cycleRef: context.cycleRef,
          workspaceRootDigestSha256: canonicalDigest(resolve(workspace.root)),
          plans: [],
          receipts: [],
          updatedAt: this.now().toISOString(),
        };
      }
      if (error instanceof SyntaxError) {
        throw new ResearchCycleError(
          "RESEARCH_INSTRUMENT_STATE_INVALID",
          "persisted research-instrument state is not valid JSON",
        );
      }
      throw error;
    }
  }

  private async writeState(
    context: ResearchInstrumentCycleContext,
    state: ResearchInstrumentState,
  ): Promise<void> {
    state.updatedAt = this.now().toISOString();
    await atomicWriteJson(this.statePath(context), state);
  }

  async plan(
    workspace: ResearchWorkspace,
    input: ResearchInstrumentPlanInput,
  ): Promise<Record<string, unknown>> {
    const context = await this.cycleManager.instrumentContext(workspace);
    assertPlanningPhase(context);
    return await this.withLock(workspace, async () => {
      const normalized = normalizePlanInput(input);
      const inputDigestSha256 = canonicalDigest(normalized);
      const idempotencyKeyDigestSha256 = keyDigest(input.idempotencyKey);
      const state = await this.readState(workspace, context);
      const existing = state.plans.find(
        (plan) =>
          plan.idempotencyKeyDigestSha256 === idempotencyKeyDigestSha256,
      );
      if (existing) {
        if (
          existing.inputDigestSha256 !== inputDigestSha256
          || existing.cycleRef !== context.cycleRef
          || existing.generation !== context.generation
        ) {
          throw new ResearchCycleError(
            "RESEARCH_INSTRUMENT_IDEMPOTENCY_CONFLICT",
            "the plan idempotency key was already used for different input or generation",
          );
        }
        return {
          status: existing.status,
          plan: existing,
          idempotentReplay: true,
          policy: publicPolicy(),
        };
      }
      if (state.plans.length >= MAX_PLANS) {
        throw new ResearchCycleError(
          "RESEARCH_INSTRUMENT_PLAN_LIMIT_REACHED",
          `one research cycle may retain at most ${MAX_PLANS} instrument plans`,
        );
      }
      const derivedEvidenceNeeds = uniqueEvidenceNeeds(
        CLAIM_DEFAULT_NEEDS[normalized.claimClass],
      );
      const allEvidenceNeeds = uniqueEvidenceNeeds([
        ...derivedEvidenceNeeds,
        ...normalized.explicitEvidenceNeeds,
      ]);
      const planRef = `research-instrument-plan:${canonicalDigest({
        cycleRef: context.cycleRef,
        generation: context.generation,
        inputDigestSha256,
      })}`;
      const steps = allEvidenceNeeds.map((need, ordinal) => {
        const policy = INSTRUMENT_POLICIES[need];
        const factors = blockingFactors(
          policy,
          normalized.claimClass,
          normalized.executionConstraints,
        );
        return {
          stepRef: `research-instrument-step:${canonicalDigest({
            planRef,
            ordinal,
            evidenceNeedKind: need,
          })}`,
          ordinal,
          evidenceNeedKind: need,
          instrumentKind: policy.instrumentKind,
          capabilityRef: policy.capabilityRef,
          candidateAdapters: policy.candidateAdapters,
          objective: policy.objective,
          falsifier: normalized.falsifier,
          requiredArtifactRoles: policy.requiredArtifactRoles,
          claimCeiling: policy.claimCeiling,
          modelBacked: policy.modelBacked,
          liveEffect: policy.liveEffect,
          blocked: factors.length > 0,
          blockingFactors: factors,
        } satisfies ResearchInstrumentStep;
      });
      const blockedCount = steps.filter((step) => step.blocked).length;
      const status = steps.length === 0
        ? "no_instrument_required"
        : blockedCount === 0
        ? "planned"
        : blockedCount === steps.length
        ? "held"
        : "partially_blocked";
      const plan: ResearchInstrumentPlanRecord = {
        schemaVersion: PLAN_SCHEMA,
        planRef,
        idempotencyKeyDigestSha256,
        inputDigestSha256,
        cycleRef: context.cycleRef,
        generation: context.generation,
        phaseAtPlan: context.phase,
        taskRef: context.taskRef,
        materialDecisionRef: context.materialDecisionRef,
        decisionBoundaryRef: context.decisionBoundaryRef,
        claimClass: normalized.claimClass,
        claimRefs: normalized.claimRefs,
        question: normalized.question,
        hypothesis: normalized.hypothesis,
        falsifier: normalized.falsifier,
        explicitEvidenceNeeds: normalized.explicitEvidenceNeeds,
        derivedEvidenceNeeds,
        executionConstraints: normalized.executionConstraints,
        status,
        steps,
        workspaceSnapshot: context.workspaceSnapshot,
        createdAt: this.now().toISOString(),
      };
      state.plans.push(plan);
      await this.writeState(context, state);
      return {
        status,
        plan,
        idempotentReplay: false,
        policy: publicPolicy(),
      };
    });
  }

  async record(
    workspace: ResearchWorkspace,
    input: ResearchInstrumentRecordInput,
  ): Promise<Record<string, unknown>> {
    const context = await this.cycleManager.instrumentContext(workspace);
    assertPlanningPhase(context);
    return await this.withLock(workspace, async () => {
      const normalized = normalizeRecordInput(input);
      const inputDigestSha256 = canonicalDigest(normalized);
      const idempotencyKeyDigestSha256 = keyDigest(input.idempotencyKey);
      const state = await this.readState(workspace, context);
      const existing = state.receipts.find(
        (receipt) =>
          receipt.idempotencyKeyDigestSha256 === idempotencyKeyDigestSha256,
      );
      if (existing) {
        if (
          existing.inputDigestSha256 !== inputDigestSha256
          || existing.cycleRef !== context.cycleRef
          || existing.generation !== context.generation
        ) {
          throw new ResearchCycleError(
            "RESEARCH_INSTRUMENT_IDEMPOTENCY_CONFLICT",
            "the receipt idempotency key was already used for different input or generation",
          );
        }
        const integrity = await this.receiptIntegrity(
          workspace,
          context,
          existing,
        );
        if (integrity.status !== "current") {
          throw new ResearchCycleError(
            "RESEARCH_INSTRUMENT_ARTIFACT_CHANGED",
            "an artifact changed or disappeared after the receipt was recorded",
            integrity,
          );
        }
        return {
          status: "recorded",
          receipt: existing,
          artifactIntegrity: integrity,
          idempotentReplay: true,
          policy: publicPolicy(),
        };
      }
      if (state.receipts.length >= MAX_RECEIPTS) {
        throw new ResearchCycleError(
          "RESEARCH_INSTRUMENT_RECEIPT_LIMIT_REACHED",
          `one research cycle may retain at most ${MAX_RECEIPTS} instrument receipts`,
        );
      }
      const plan = state.plans.find((candidate) =>
        candidate.planRef === normalized.planRef
      );
      if (!plan) {
        throw new ResearchCycleError(
          "RESEARCH_INSTRUMENT_PLAN_NOT_FOUND",
          "the requested instrument plan does not exist in this research cycle",
        );
      }
      if (plan.generation !== context.generation) {
        throw new ResearchCycleError(
          "RESEARCH_INSTRUMENT_PLAN_STALE",
          "the instrument plan belongs to an earlier research generation",
          {
            planGeneration: plan.generation,
            currentGeneration: context.generation,
          },
        );
      }
      const step = plan.steps.find((candidate) =>
        candidate.stepRef === normalized.stepRef
      );
      if (!step) {
        throw new ResearchCycleError(
          "RESEARCH_INSTRUMENT_STEP_NOT_FOUND",
          "the requested instrument step does not exist in the plan",
        );
      }
      if (step.blocked) {
        throw new ResearchCycleError(
          "RESEARCH_INSTRUMENT_STEP_BLOCKED",
          "the instrument step cannot be recorded until its execution-boundary blockers are resolved",
          { blockingFactors: step.blockingFactors },
        );
      }
      const artifacts = await Promise.all(
        normalized.artifacts.map((artifact) =>
          this.inspectArtifact(workspace, context, artifact)
        ),
      );
      if (
        normalized.outcome === "indeterminate"
        && normalized.unresolved.length === 0
      ) {
        throw new ResearchCycleError(
          "RESEARCH_INSTRUMENT_RESULT_INVALID",
          "an indeterminate experiment requires at least one unresolved condition",
        );
      }
      validateResult(step, normalized.outcome, normalized.result, artifacts);
      const currentContext = await this.cycleManager.instrumentContext(workspace);
      if (
        currentContext.cycleRef !== context.cycleRef
        || currentContext.generation !== context.generation
        || currentContext.workspaceSnapshot.head
          !== context.workspaceSnapshot.head
        || currentContext.workspaceSnapshot.workingContentDigestSha256
          !== context.workspaceSnapshot.workingContentDigestSha256
      ) {
        throw new ResearchCycleError(
          "RESEARCH_INSTRUMENT_CONTEXT_CHANGED_DURING_RECORD",
          "the research generation or workspace changed while artifacts were being bound",
        );
      }
      const receiptDigest = canonicalDigest({
        cycleRef: context.cycleRef,
        generation: context.generation,
        planRef: plan.planRef,
        stepRef: step.stepRef,
        inputDigestSha256,
        artifactDigests: artifacts.map((artifact) => artifact.sha256),
      });
      const receipt: ResearchInstrumentReceiptRecord = {
        schemaVersion: RECEIPT_SCHEMA,
        receiptRef: `research-instrument-receipt:${receiptDigest}`,
        evidenceRef: `research-instrument-evidence:${receiptDigest}`,
        idempotencyKeyDigestSha256,
        inputDigestSha256,
        cycleRef: context.cycleRef,
        generation: context.generation,
        planRef: plan.planRef,
        stepRef: step.stepRef,
        instrumentKind: step.instrumentKind,
        evidenceNeedKind: step.evidenceNeedKind,
        outcome: normalized.outcome,
        startedAt: normalized.startedAt,
        completedAt: normalized.completedAt,
        toolName: normalized.toolName,
        toolVersion: normalized.toolVersion,
        adapterRef: normalized.adapterRef,
        environmentRefs: normalized.environmentRefs,
        artifacts,
        result: normalized.result,
        limitations: normalized.limitations,
        unresolved: normalized.unresolved,
        claimCeiling: step.claimCeiling,
        workspaceSnapshot: context.workspaceSnapshot,
        phaseAtRecord: context.phase,
        recordedAt: this.now().toISOString(),
      };
      state.receipts.push(receipt);
      await this.writeState(context, state);
      return {
        status: "recorded",
        receipt,
        artifactIntegrity: { status: "current", findings: [] },
        idempotentReplay: false,
        policy: publicPolicy(),
      };
    });
  }

  async status(
    workspace: ResearchWorkspace,
  ): Promise<Record<string, unknown>> {
    const context = await this.cycleManager.instrumentContext(workspace);
    return await this.withLock(workspace, async () => {
      const state = await this.readState(workspace, context);
      const currentPlans = state.plans.filter((plan) =>
        plan.generation === context.generation
      );
      const currentReceipts = state.receipts.filter((receipt) =>
        receipt.generation === context.generation
      );
      const inspectReceipts = currentReceipts.slice(
        -MAX_STATUS_INTEGRITY_RECEIPTS,
      );
      const receiptIntegrity = await Promise.all(
        inspectReceipts.map(async (receipt) => ({
          receiptRef: receipt.receiptRef,
          ...(await this.receiptIntegrity(workspace, context, receipt)),
        })),
      );
      const stepStatus = currentPlans.flatMap((plan) =>
        plan.steps.map((step) => {
          const receipts = currentReceipts.filter((receipt) =>
            receipt.stepRef === step.stepRef
          );
          return {
            planRef: plan.planRef,
            stepRef: step.stepRef,
            instrumentKind: step.instrumentKind,
            evidenceNeedKind: step.evidenceNeedKind,
            blocked: step.blocked,
            blockingFactors: step.blockingFactors,
            receiptCount: receipts.length,
            latestOutcome: receipts.at(-1)?.outcome,
            evidenceRefs: receipts.map((receipt) => receipt.evidenceRef),
          };
        })
      );
      return {
        managed: true,
        cycleRef: context.cycleRef,
        phase: context.phase,
        generation: context.generation,
        taskRef: context.taskRef,
        materialDecisionRef: context.materialDecisionRef,
        currentPlanCount: currentPlans.length,
        staleGenerationPlanCount: state.plans.length - currentPlans.length,
        currentReceiptCount: currentReceipts.length,
        staleGenerationReceiptCount:
          state.receipts.length - currentReceipts.length,
        plans: currentPlans,
        stepStatus,
        receiptIntegrity,
        integrityInspectionTruncated:
          currentReceipts.length > inspectReceipts.length,
        updatedAt: state.updatedAt,
        policy: publicPolicy(),
      };
    });
  }

  async verifyEvidenceRefs(
    workspace: ResearchWorkspace,
    rawEvidenceRefs: string[],
  ): Promise<Record<string, unknown>> {
    const context = await this.cycleManager.instrumentContext(workspace);
    const evidenceRefs = uniqueStrings(rawEvidenceRefs, "instrumentEvidenceRefs");
    if (evidenceRefs.length === 0) {
      throw new ResearchCycleError(
        "RESEARCH_INSTRUMENT_EVIDENCE_REFS_REQUIRED",
        "at least one research-instrument evidence ref is required",
      );
    }
    return await this.withLock(workspace, async () => {
      const state = await this.readState(workspace, context);
      const verified: Array<Record<string, unknown>> = [];
      for (const evidenceRef of evidenceRefs) {
        const receipt = state.receipts.find((candidate) =>
          candidate.evidenceRef === evidenceRef
        );
        if (!receipt) {
          throw new ResearchCycleError(
            "RESEARCH_INSTRUMENT_EVIDENCE_NOT_FOUND",
            "a supplied research-instrument evidence ref is not present in this cycle",
            { evidenceRef },
          );
        }
        if (receipt.generation !== context.generation) {
          throw new ResearchCycleError(
            "RESEARCH_INSTRUMENT_EVIDENCE_STALE",
            "research-instrument evidence from an earlier generation cannot be reused without a new plan and receipt",
            {
              evidenceRef,
              receiptGeneration: receipt.generation,
              currentGeneration: context.generation,
            },
          );
        }
        const integrity = await this.receiptIntegrity(
          workspace,
          context,
          receipt,
        );
        if (integrity.status !== "current") {
          throw new ResearchCycleError(
            "RESEARCH_INSTRUMENT_ARTIFACT_CHANGED",
            "a research-instrument evidence artifact changed or disappeared",
            { evidenceRef, integrity },
          );
        }
        verified.push({
          evidenceRef,
          receiptRef: receipt.receiptRef,
          planRef: receipt.planRef,
          stepRef: receipt.stepRef,
          instrumentKind: receipt.instrumentKind,
          outcome: receipt.outcome,
          claimCeiling: receipt.claimCeiling,
          artifactRefs: receipt.artifacts.map((artifact) => artifact.artifactRef),
        });
      }
      return {
        status: "verified_current_generation",
        cycleRef: context.cycleRef,
        generation: context.generation,
        evidenceRefs,
        verified,
        policy: publicPolicy(),
      };
    });
  }

  private async inspectArtifact(
    workspace: ResearchWorkspace,
    context: ResearchInstrumentCycleContext,
    input: ResearchInstrumentArtifactInput,
  ): Promise<ResearchInstrumentArtifactRecord> {
    const base = input.location === "workspace"
      ? workspace.root
      : context.evidenceDirectory;
    const normalized = normalizeRelativePath(input.path, "artifact path");
    if (
      input.location === "cycle_evidence"
      && (normalized === "instruments" || normalized.startsWith("instruments/"))
    ) {
      throw new ResearchCycleError(
        "RESEARCH_INSTRUMENT_ARTIFACT_SELF_REFERENCE",
        "instrument state and receipts cannot be used as their own evidence artifacts",
      );
    }
    const path = resolve(base, normalized);
    if (!pathInside(path, base)) {
      throw new ResearchCycleError(
        "RESEARCH_INSTRUMENT_PATH_INVALID",
        "artifact path escapes its selected evidence root",
      );
    }
    const stat = await lstat(path).catch((error: unknown) => {
      throw new ResearchCycleError(
        "RESEARCH_INSTRUMENT_ARTIFACT_MISSING",
        "instrument artifact does not exist",
        {
          location: input.location,
          path: normalized,
          errorType: error instanceof Error ? error.name : "unknown",
        },
      );
    });
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
      throw new ResearchCycleError(
        "RESEARCH_INSTRUMENT_ARTIFACT_UNSAFE",
        "instrument artifacts must be regular single-link files",
        { location: input.location, path: normalized },
      );
    }
    if (stat.size > MAX_ARTIFACT_BYTES) {
      throw new ResearchCycleError(
        "RESEARCH_INSTRUMENT_ARTIFACT_TOO_LARGE",
        `instrument artifacts may not exceed ${MAX_ARTIFACT_BYTES} bytes`,
        { byteCount: stat.size },
      );
    }
    const actual = await realpath(path);
    if (!pathInside(actual, await realpath(base))) {
      throw new ResearchCycleError(
        "RESEARCH_INSTRUMENT_ARTIFACT_UNSAFE",
        "instrument artifact resolves outside its selected evidence root",
      );
    }
    const noFollow = fsConstants.O_NOFOLLOW ?? 0;
    const handle = await open(path, fsConstants.O_RDONLY | noFollow).catch(
      (error: unknown) => {
        throw new ResearchCycleError(
          "RESEARCH_INSTRUMENT_ARTIFACT_UNSAFE",
          "instrument artifact could not be opened without following its final path component",
          {
            location: input.location,
            path: normalized,
            errorType: error instanceof Error ? error.name : "unknown",
          },
        );
      },
    );
    let sha256: string;
    let byteCount: number;
    try {
      const openedStat = await handle.stat();
      if (
        !openedStat.isFile()
        || openedStat.nlink !== 1
        || openedStat.dev !== stat.dev
        || openedStat.ino !== stat.ino
        || openedStat.size !== stat.size
      ) {
        throw new ResearchCycleError(
          "RESEARCH_INSTRUMENT_ARTIFACT_IDENTITY_CHANGED",
          "instrument artifact identity changed between path validation and open",
          { location: input.location, path: normalized },
        );
      }
      sha256 = await sha256FileHandle(handle);
      const stableStat = await handle.stat();
      if (
        stableStat.dev !== openedStat.dev
        || stableStat.ino !== openedStat.ino
        || stableStat.size !== openedStat.size
        || stableStat.mtimeMs !== openedStat.mtimeMs
      ) {
        throw new ResearchCycleError(
          "RESEARCH_INSTRUMENT_ARTIFACT_CHANGED_DURING_HASH",
          "instrument artifact changed while its digest was being computed",
          { location: input.location, path: normalized },
        );
      }
      byteCount = stableStat.size;
    } finally {
      await handle.close();
    }
    return {
      artifactRef: `research-instrument-artifact:${canonicalDigest({
        location: input.location,
        path: normalized,
        role: input.role,
        byteCount,
        sha256,
      })}`,
      location: input.location,
      path: normalized,
      role: input.role,
      mediaType: requiredString(input.mediaType, "artifact mediaType"),
      byteCount,
      sha256,
    };
  }

  private async receiptIntegrity(
    workspace: ResearchWorkspace,
    context: ResearchInstrumentCycleContext,
    receipt: ResearchInstrumentReceiptRecord,
  ): Promise<Record<string, unknown>> {
    const findings: Record<string, unknown>[] = [];
    for (const artifact of receipt.artifacts) {
      try {
        const current = await this.inspectArtifact(workspace, context, artifact);
        if (
          current.sha256 !== artifact.sha256
          || current.byteCount !== artifact.byteCount
        ) {
          findings.push({
            artifactRef: artifact.artifactRef,
            code: "artifact_changed",
            expectedSha256: artifact.sha256,
            observedSha256: current.sha256,
            expectedByteCount: artifact.byteCount,
            observedByteCount: current.byteCount,
          });
        }
      } catch (error) {
        findings.push({
          artifactRef: artifact.artifactRef,
          code: "artifact_missing_or_unsafe",
          errorCode:
            error instanceof ResearchCycleError
              ? error.code
              : "RESEARCH_INSTRUMENT_ARTIFACT_CHECK_FAILED",
        });
      }
    }
    return {
      status: findings.length === 0 ? "current" : "changed_or_missing",
      findings,
    };
  }
}
