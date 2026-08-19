import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import {
  lstat,
  mkdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import type { ZesResearchCycleConfig } from "./config.js";
import { processEnvironment } from "./process-sessions.js";

const RESEARCH_MARKER = "packages/zes-control-kernel/pyproject.toml";
const MAX_PROCESS_OUTPUT_BYTES = 2 * 1024 * 1024;
const STATE_SCHEMA = "devspace.zes-research-cycle-state.v1";
const OPEN_SCHEMA = "devspace.zes-research-cycle-open.v1";
const PREPARED_SCHEMA = "devspace.zes-research-cycle-prepared-scope.v1";
const DISCOVERY_PLAN_SCHEMA = "devspace.zes-research-discovery-plan.v1";
const DISCOVERY_ACQUISITION_SCHEMA = "devspace.zes-research-discovery-acquisition.v1";
const HORIZON_SCHEMA = "devspace.zes-research-horizon-status.v1";
const ADMISSION_REQUEST_SCHEMA = "zes.research-decision-admission-request.v3";
const ADMISSION_RECEIPT_SCHEMA = "zes.research-decision-admission-receipt.v3";
const EPISODE_PACKET_SCHEMAS = new Set([
  "zes.research-episode-packet.v1",
  "zes.research-episode-packet.v2",
]);
const SHA256 = /^[0-9a-f]{64}$/u;
const MAX_DISCOVERY_PORTFOLIO_QUERIES = 18;
const MAX_DISCOVERY_QUERIES_PER_LANE = 2;
const MAX_DISCOVERY_RESULTS_PER_QUERY = 8;
const MAX_DISCOVERY_OBSERVATIONS = 32;
const MAX_DISCOVERY_EVIDENCE_REFS_PER_OBSERVATION = 20;
const MAX_DISCOVERY_SUBJECT_REFS_PER_OBSERVATION = 20;
const MAX_DISCOVERY_TEXT_CHARACTERS = 20_000;
const MAX_DISCOVERY_EVIDENCE_BYTES = 2 * 1024 * 1024;
const DISCOVERY_PLAN_VERSION = "devspace.research-discovery-plan.v1";
const DISCOVERY_PORTFOLIO_PREFIX = "research-discovery";
const DISCOVERY_QUERY_TEMPLATE_VERSION = "discovery-query-template-v1";
const DISCOVERY_QUERY_CONSTRAINT_MODE = "query_text_only";
const DISCOVERY_OPEN_WORLD_CAPABILITY_REF =
  "capability:open-world-candidate-discovery:v1";
const RESEARCH_PHASES = new Set<ResearchCyclePhase>([
  "opened",
  "prepared",
  "admitted",
  "held",
  "reassessment_required",
  "pre_commit_verified",
  "committed",
  "closed",
]);

export type ResearchCyclePhase =
  | "opened"
  | "prepared"
  | "admitted"
  | "held"
  | "reassessment_required"
  | "pre_commit_verified"
  | "committed"
  | "closed";

export type ResearchOperationClass =
  | "source_mutation"
  | "repository_commit"
  | "repository_publish"
  | "dependency_change"
  | "runtime_effect";

export type ResearchCommandClass =
  | "inspection"
  | "research_control"
  | "validation"
  | "source_mutation"
  | "commit_prepare"
  | "repository_commit"
  | "repository_publish"
  | "runtime_effect"
  | "unknown";

export type ResearchInvalidationKind =
  | "architecture_or_semantic_fork"
  | "contradictory_evidence"
  | "dependency_or_upstream_change"
  | "owner_direction_changed"
  | "repeated_distinct_failure"
  | "scope_drift"
  | "source_currentness_expired"
  | "manual";

export interface ResearchWorkspace {
  workspaceId: string;
  root: string;
}

export interface ResearchCycleOpenInput {
  taskRef: string;
  materialDecisionRef: string;
  decisionBoundaryRef: string;
  decisionQuestion: string;
  candidatePathPrefixes: string[];
  researchEnvelopeHypothesis:
    | "no_search"
    | "quick_lookup"
    | "focused_research"
    | "deep_research";
  researchQuestions: string[];
  knownLocalEvidenceRefs: string[];
  uncertainties: string[];
  falsifier: string;
  reopenTrigger: string;
  actorRef: string;
  ownerSeededFraming: boolean;
  replaceExisting?: boolean;
  replacementReason?: string;
}

export interface ResearchCyclePrepareInput {
  pathPrefixes: string[];
  operationClasses: ResearchOperationClass[];
  evidenceRegimeRefs: string[];
  sourceIdentityRefs: string[];
  shellMutationCommandDigests?: string[];
  repositoryWideScopeReason?: string;
}

export interface ResearchProviderTraceInput {
  traceRef: string;
  path: string;
}

export interface ResearchProviderAcquisitionInvocation {
  purpose: "fresh_acquisition" | "counterevidence_or_blind_challenge";
  request: {
    provider: "exa";
    operation: "search";
    query: string;
    maxResults: number;
  };
}

export interface ResearchProviderAcquisitionResult {
  status: string;
  providerEvidenceRef: string;
  providerEvidencePath: string;
  providerEvidenceFileSha256: string;
  providerTraceRef: string;
  providerTracePath: string;
  providerTraceFileSha256: string;
  providerEvidence: Record<string, unknown>;
  providerReceiptFileSha256: string;
}

export type ResearchProviderAcquisitionRunner = (
  workspace: ResearchWorkspace,
  purpose: "fresh_acquisition" | "counterevidence_or_blind_challenge",
  request: {
    provider: "exa";
    operation: "search";
    query: string;
    maxResults: number;
  },
) => Promise<ResearchProviderAcquisitionResult>;

export type ResearchTemporalRegime =
  | "rapidly_volatile"
  | "evolving_practice"
  | "version_bound_fact"
  | "durable_principle_or_invariant"
  | "historical_lineage";

export type ResearchDiscoveryProfile =
  | "balanced_frontier"
  | "community_frontier"
  | "failure_reproduction"
  | "successor_or_alternative"
  | "official_delta";

export type ResearchDiscoveryLane =
  | "official_or_release_delta"
  | "open_source_or_independent_implementation"
  | "failure_reproduction_or_maintainer_discussion"
  | "competing_alternative_or_successor"
  | "practitioner_or_production_experience"
  | "counterevidence_or_falsifier";

export type ResearchLaneDisposition = "required" | "conditional" | "not_applicable";

export interface ResearchDiscoveryPlanInput {
  subjectRef: string;
  subjectQuestion: string;
  temporalRegime: ResearchTemporalRegime;
  asOf: string;
  knownCandidateRefs?: string[];
  incumbentRef?: string;
  priorSnapshotRef?: string;
  discoveryProfile?: ResearchDiscoveryProfile;
  explicitCoverageLanes?: Array<{
    lane: ResearchDiscoveryLane;
    disposition: ResearchLaneDisposition;
    reason: string;
  }>;
}

export interface ResearchDiscoveryAcquireInput {
  planRef: string;
  queryRefs?: string[];
  expectedGeneration?: number;
}

export type ResearchHorizonEventKind =
  | "new_candidate_detected"
  | "upstream_semantics_changed"
  | "community_failure_cluster_detected"
  | "prior_selection_superseded_candidate"
  | "new_reproduction_or_counterevidence"
  | "current_source_expired";

export interface ResearchHorizonObservationInput {
  kind: Exclude<ResearchHorizonEventKind, "current_source_expired">;
  evidenceRefs: string[];
  subjectRefs: string[];
  rationale: string;
}

export interface ResearchPriorDiscoverySnapshotInput {
  snapshotRef: string;
  portfolioDigestSha256: string;
  candidateRefs?: string[];
  incumbentRef?: string;
  evidenceIdentities?: Array<{
    evidenceRef: string;
    fileDigestSha256: string;
  }>;
}

export interface ResearchHorizonInput {
  planRef: string;
  expectedGeneration?: number;
  asOf: string;
  priorSnapshot?: ResearchPriorDiscoverySnapshotInput;
  observations?: ResearchHorizonObservationInput[];
}

export interface ResearchProviderEvidenceContext {
  cycleRef: string;
  generation: number;
  phase: "prepared";
  evidenceDirectory: string;
  ownerSeededFraming: boolean;
  taskRef: string;
  materialDecisionRef: string;
  decisionBoundaryRef: string;
}

export interface ResearchInstrumentCycleContext {
  cycleRef: string;
  generation: number;
  phase: ResearchCyclePhase;
  evidenceDirectory: string;
  ownerSeededFraming: boolean;
  taskRef: string;
  materialDecisionRef: string;
  decisionBoundaryRef: string;
  workspaceSnapshot: {
    head: string;
    sourceTree: string;
    branch: string;
    repositoryIdentityDigestSha256: string;
    workingContentDigestSha256: string;
    dirty: boolean;
  };
}

export interface ResearchPreCommitChallenge {
  localAuthorityRechecked: boolean;
  externalCurrentnessRechecked: boolean;
  dependencyCurrentnessRechecked: boolean;
  assumptionsRechecked: string[];
  counterevidenceOrLimitations: string[];
  unresolved: string[];
  stoppingReason: string;
}

export interface ResearchGuardDecision {
  managed: boolean;
  mode: ZesResearchCycleConfig["mode"];
  allowed: boolean;
  classification?: ResearchCommandClass | "apply_patch";
  reasons: string[];
  cycleRef?: string;
  phase?: ResearchCyclePhase;
  advisoryOnly: boolean;
}

export interface ResearchNativeInvocation {
  operation: "assess" | "verify-admission" | "compile";
  args: string[];
  cwd: string;
  timeoutMs: number;
}

export interface ResearchNativeResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type ResearchNativeRunner = (
  invocation: ResearchNativeInvocation,
) => Promise<ResearchNativeResult>;

interface GitSnapshot {
  head: string;
  sourceTree: string;
  branch: string;
  repositoryIdentityDigestSha256: string;
  workingContentDigestSha256: string;
  dirty: boolean;
}

interface ResearchOpenRecord extends ResearchCycleOpenInput {
  schemaVersion: typeof OPEN_SCHEMA;
  cycleRef: string;
  openedAt: string;
  baseline: GitSnapshot;
  evidenceDirectory: string;
}

interface PreparedScopeRecord extends ResearchCyclePrepareInput {
  schemaVersion: typeof PREPARED_SCHEMA;
  generation: number;
  preparedAt: string;
  snapshot: GitSnapshot;
  decisionScopeDigestSha256: string;
  evidenceRegimeDigestSha256: string;
  sourceIdentityDigestSha256: string;
  implementationBoundaryDigestSha256: string;
  actionScopeDigestSha256: string;
}

interface DiscoveryCoverageLaneBinding {
  lane: ResearchDiscoveryLane;
  disposition: ResearchLaneDisposition;
  reason: string;
}

interface DiscoveryPlanQueryBinding {
  queryRef: string;
  lane: ResearchDiscoveryLane;
  query: string;
  providerPurpose: "fresh_acquisition" | "counterevidence_or_blind_challenge";
  provider: "exa";
  operation: "search";
  maxResults: number;
  queryTemplateVersion: typeof DISCOVERY_QUERY_TEMPLATE_VERSION;
  temporalConstraint: {
    mode: typeof DISCOVERY_QUERY_CONSTRAINT_MODE;
    derivedSince: string;
    providerNativeDateFilterApplied: false;
    providerNativeDomainFilterApplied: false;
  };
}

interface DiscoveryPlanRecord {
  schemaVersion: typeof DISCOVERY_PLAN_SCHEMA;
  planRef: string;
  planDigestSha256: string;
  policyDigestSha256: string;
  subjectRef: string;
  subjectQuestion: string;
  discoveryProfile: ResearchDiscoveryProfile;
  temporalRegime: ResearchTemporalRegime;
  asOf: string;
  derivedSince: string;
  revalidateBy: string;
  lookbackDays: number;
  revalidateByDays: number;
  knownCandidateRefs: string[];
  incumbentRef?: string;
  priorSnapshotRef?: string;
  generation: number;
  coverageLanes: DiscoveryCoverageLaneBinding[];
  queries: DiscoveryPlanQueryBinding[];
  requestedAt: string;
  requestedBy: string;
  portfolioDigestSha256: string;
  sourceOriginNeutral: true;
  queryConstraintMode: typeof DISCOVERY_QUERY_CONSTRAINT_MODE;
}

interface DiscoveryAcquisitionRecord {
  schemaVersion: typeof DISCOVERY_ACQUISITION_SCHEMA;
  queryRef: string;
  planRef: string;
  lane: ResearchDiscoveryLane;
  status: "pending" | "acquired" | "failed";
  attemptRef: string;
  attemptOrdinal: 1;
  purpose: "fresh_acquisition" | "counterevidence_or_blind_challenge";
  provider: "exa";
  operation: "search";
  query: string;
  maxResults: number;
  asOf: string;
  revalidateBy: string;
  startedAt: string;
  completedAt?: string;
  acquiredAt?: string;
  providerEvidenceRef?: string;
  providerTraceRef?: string;
  providerTracePath?: string;
  providerTraceFileSha256?: string;
  providerEvidencePath?: string;
  providerEvidenceFileSha256?: string;
  failureCode?: string;
  failureReason?: string;
  noRetryPerformed: true;
}

interface HorizonEventRecord {
  eventRef: string;
  kind: ResearchHorizonEventKind;
  rationale: string;
  evidenceRefs: string[];
  subjectRefs: string[];
  detectedAt: string;
}

interface PriorDiscoverySnapshotRecord {
  snapshotRef: string;
  portfolioDigestSha256: string;
  candidateRefs: string[];
  incumbentRef?: string;
  evidenceIdentities: Array<{
    evidenceRef: string;
    fileDigestSha256: string;
  }>;
}

interface HorizonRecord {
  schemaVersion: typeof HORIZON_SCHEMA;
  horizonRef: string;
  planRef: string;
  asOf: string;
  policyDigestSha256: string;
  planDigestSha256: string;
  portfolioDigestSha256: string;
  priorSnapshot?: PriorDiscoverySnapshotRecord;
  evidenceIdentities: Array<{
    evidenceRef: string;
    fileDigestSha256: string;
    traceRef: string;
    traceDigestSha256: string;
  }>;
  recordedAt: string;
  generation: number;
  events: HorizonEventRecord[];
  staleReasons: string[];
  requiresResearchReflexRefresh: boolean;
  inputDigestSha256: string;
}

interface DiscoveryInvalidationRecord {
  planRef: string;
  replacementPlanRef?: string;
  reasons: string[];
  invalidatedAt: string;
}

interface DiscoveryState {
  plan?: DiscoveryPlanRecord;
  acquisitions: DiscoveryAcquisitionRecord[];
  horizon?: HorizonRecord;
  requestedBy?: string;
  invalidations: DiscoveryInvalidationRecord[];
}

interface DiscoveryCoverageStatus {
  lane: ResearchDiscoveryLane;
  disposition: ResearchLaneDisposition;
  reason: string;
  queryRefs: string[];
  evidenceRefs: string[];
  status: "covered" | "partial" | "unresolved";
  residuals: string[];
}

interface DiscoveryPlanResult {
  planRef: string;
  schemaVersion: string;
  asOf: string;
  generatedAt: string;
  generation: number;
  policyDigest: string;
  lookbackDays: number;
  revalidateByDays: number;
  derivedSince: string;
  revalidateBy: string;
  coverageLanes: DiscoveryCoverageLaneBinding[];
  queries: DiscoveryPlanQueryBinding[];
  portfolioDigestSha256: string;
  coverage: DiscoveryCoverageStatus[];
}

interface DiscoveryAcquireResult {
  planRef: string;
  generation: number;
  asOf: string;
  portfolioDigestSha256: string;
  status:
    | "acquired"
    | "partial"
    | "partial_with_failures"
    | "held";
  requiredCovered: boolean;
  coveredQueries: number;
  partialQueries: number;
  unresolvedQueries: number;
  acquisitions: DiscoveryAcquisitionRecord[];
  coverage: DiscoveryCoverageStatus[];
  policyDigest: string;
}

interface DiscoveryHorizonResult {
  horizonRef: string;
  planRef: string;
  generation: number;
  asOf: string;
  policyDigest: string;
  portfolioDigestSha256: string;
  events: HorizonEventRecord[];
  priorSnapshot?: PriorDiscoverySnapshotRecord;
  recordedAt: string;
  staleReasons: string[];
  requiresResearchReflexRefresh: boolean;
}

interface DiscoveryRegimePolicy {
  lookbackDays: number;
  revalidateByDays: number;
}

interface DiscoveryAttemptContext {
  cycleRef: string;
  generation: number;
  planRef: string;
  planDigestSha256: string;
  query: DiscoveryPlanQueryBinding;
  attemptRef: string;
  evidenceDirectory: string;
  ownerSeededFraming: boolean;
}

type DiscoveryAttemptReservation =
  | { kind: "reserved"; context: DiscoveryAttemptContext }
  | { kind: "existing"; acquisition: DiscoveryAcquisitionRecord };

const DISCOVERY_LANE_QUERIES: Record<ResearchDiscoveryLane, string[]> = {
  official_or_release_delta: [
    "{{subject}} official release notes, changelog entries, RFCs, and upstream release artifacts changed or updated since {{derivedSince}}",
    "{{subjectRef}} API compatibility statements, deprecation notices, and tagged releases changed or announced since {{derivedSince}}",
  ],
  open_source_or_independent_implementation: [
    "{{subject}} independent implementations, community forks, and downstream rewrites released or updated since {{derivedSince}}",
    "{{subjectRef}} production-ready community operators, operator ecosystems, and implementation variants since {{derivedSince}}",
  ],
  failure_reproduction_or_maintainer_discussion: [
    "{{subject}} GitHub issues, PRs, maintainer discussions, and release comments about failures, regressions, or reproductions since {{derivedSince}}",
    "{{subject}} incident reports, maintainer reproductions, rollback notes, and reliability regressions since {{derivedSince}}",
  ],
  competing_alternative_or_successor: [
    "{{subject}} competing alternatives, successor projects, and replacement proposals discussed since {{derivedSince}}",
    "{{subjectRef}} migration tooling, deprecation pathways, and successor adoption plans since {{derivedSince}}",
  ],
  practitioner_or_production_experience: [
    "{{subject}} practitioner reports, migration notes, and production deployment guidance published since {{derivedSince}}",
    "{{subjectRef}} operator runbooks, rollout constraints, and field incident notes since {{derivedSince}}",
  ],
  counterevidence_or_falsifier: [
    "{{subject}} counterevidence, explicit limitations, and falsifiers reported since {{derivedSince}}",
    "{{subject}} explicit reproduction failures, disproved assumptions, or falsification attempts with evidence since {{derivedSince}}",
  ],
};

const DISCOVERY_PROFILE_LANES: Record<ResearchDiscoveryProfile, Array<{
  lane: ResearchDiscoveryLane;
  disposition: ResearchLaneDisposition;
}>> = {
  balanced_frontier: [
    { lane: "official_or_release_delta", disposition: "required" },
    { lane: "open_source_or_independent_implementation", disposition: "required" },
    { lane: "failure_reproduction_or_maintainer_discussion", disposition: "required" },
    { lane: "competing_alternative_or_successor", disposition: "required" },
    { lane: "practitioner_or_production_experience", disposition: "required" },
    { lane: "counterevidence_or_falsifier", disposition: "required" },
  ],
  community_frontier: [
    { lane: "official_or_release_delta", disposition: "conditional" },
    { lane: "open_source_or_independent_implementation", disposition: "conditional" },
    { lane: "failure_reproduction_or_maintainer_discussion", disposition: "required" },
    { lane: "competing_alternative_or_successor", disposition: "required" },
    { lane: "practitioner_or_production_experience", disposition: "required" },
    { lane: "counterevidence_or_falsifier", disposition: "required" },
  ],
  failure_reproduction: [
    { lane: "official_or_release_delta", disposition: "conditional" },
    { lane: "open_source_or_independent_implementation", disposition: "conditional" },
    { lane: "failure_reproduction_or_maintainer_discussion", disposition: "required" },
    { lane: "competing_alternative_or_successor", disposition: "conditional" },
    { lane: "practitioner_or_production_experience", disposition: "conditional" },
    { lane: "counterevidence_or_falsifier", disposition: "required" },
  ],
  successor_or_alternative: [
    { lane: "official_or_release_delta", disposition: "conditional" },
    { lane: "open_source_or_independent_implementation", disposition: "conditional" },
    { lane: "failure_reproduction_or_maintainer_discussion", disposition: "conditional" },
    { lane: "competing_alternative_or_successor", disposition: "required" },
    { lane: "practitioner_or_production_experience", disposition: "conditional" },
    { lane: "counterevidence_or_falsifier", disposition: "required" },
  ],
  official_delta: [
    { lane: "official_or_release_delta", disposition: "required" },
    { lane: "open_source_or_independent_implementation", disposition: "conditional" },
    { lane: "failure_reproduction_or_maintainer_discussion", disposition: "conditional" },
    { lane: "competing_alternative_or_successor", disposition: "conditional" },
    { lane: "practitioner_or_production_experience", disposition: "conditional" },
    { lane: "counterevidence_or_falsifier", disposition: "conditional" },
  ],
};

const DISCOVERY_REGIME_POLICY: Record<ResearchTemporalRegime, DiscoveryRegimePolicy> = {
  rapidly_volatile: { lookbackDays: 14, revalidateByDays: 1 },
  evolving_practice: { lookbackDays: 30, revalidateByDays: 7 },
  version_bound_fact: { lookbackDays: 180, revalidateByDays: 60 },
  durable_principle_or_invariant: { lookbackDays: 365, revalidateByDays: 180 },
  historical_lineage: { lookbackDays: 730, revalidateByDays: 365 },
};

interface ProviderTraceRecord {
  traceRef: string;
  path: string;
}

interface AdmissionRecord {
  state: string;
  admitted: boolean;
  requestDigestSha256: string;
  receiptRef?: string;
  receiptDigestSha256?: string;
  receiptFileSha256: string;
  receiptPath: string;
  validUntil?: string;
  providerTraces: ProviderTraceRecord[];
  evaluatedAt: string;
  causalReason?: string;
}

interface ResearchInvalidationRecord {
  kind: ResearchInvalidationKind;
  reason: string;
  evidenceRefs: string[];
  recordedAt: string;
}

interface PreCommitRecord {
  verifiedAt: string;
  workingContentDigestSha256: string;
  validationRefs: string[];
  challenge: ResearchPreCommitChallenge;
}

interface CommitRecord {
  committedAt: string;
  headBefore: string;
  headAfter: string;
  sourceTreeAfter: string;
  commandDigestSha256: string;
}

interface ClosureRecord {
  outcome: "committed" | "no_change" | "deferred" | "abandoned";
  reason: string;
  decisionDelta: string;
  reusableFindings: string[];
  reversalConditions: string[];
  closedAt: string;
  closedHead: string;
  episodeReceiptRef?: string;
  episodeReceiptDigestSha256?: string;
  episodeReceiptFileSha256?: string;
  episodeReceiptPath?: string;
}

interface ResearchCycleState {
  schemaVersion: typeof STATE_SCHEMA;
  workspaceId: string;
  workspaceRootDigestSha256: string;
  cycleRef: string;
  phase: ResearchCyclePhase;
  generation: number;
  open: ResearchOpenRecord;
  prepared?: PreparedScopeRecord;
  admission?: AdmissionRecord;
  discovery?: DiscoveryState;
  invalidations: ResearchInvalidationRecord[];
  observedPaths: string[];
  dependencySensitivePaths: string[];
  distinctFailureDigests: string[];
  validationCommandDigests: string[];
  preCommit?: PreCommitRecord;
  commit?: CommitRecord;
  closure?: ClosureRecord;
  updatedAt: string;
}

interface PendingCommand {
  workspace: ResearchWorkspace;
  command: string;
  classification: ResearchCommandClass;
}

interface ResearchCycleManagerOptions {
  now?: () => Date;
  nativeRunner?: ResearchNativeRunner;
}

export class ResearchCycleError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ResearchCycleError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalValue(value[key])]),
  );
}

export function canonicalDigest(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalValue(value)))
    .digest("hex");
}

export function researchCommandDigest(command: string): string {
  return createHash("sha256").update(command.trim(), "utf8").digest("hex");
}

function uniqueStrings(values: readonly string[], label: string): string[] {
  const normalized = values.map((value) => value.trim()).filter(Boolean);
  if (normalized.length !== values.length) {
    throw new ResearchCycleError(
      "RESEARCH_CYCLE_EMPTY_IDENTITY",
      `${label} cannot contain empty values`,
    );
  }
  return [...new Set(normalized)].sort();
}

function requiredString(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new ResearchCycleError(
      "RESEARCH_CYCLE_IDENTITY_REQUIRED",
      `${label} is required`,
    );
  }
  return normalized;
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
      "RESEARCH_CYCLE_PATH_INVALID",
      `${label} must be a workspace-relative path`,
      { path: value },
    );
  }
  return normalized.replace(/\/+$/u, "") || ".";
}

function normalizePathPrefixes(values: readonly string[]): string[] {
  const normalized = values.map((value) =>
    normalizeRelativePath(value, "path prefix")
  );
  return [...new Set(normalized)].sort();
}

function pathWithinPrefix(path: string, prefix: string): boolean {
  return prefix === "." || path === prefix || path.startsWith(`${prefix}/`);
}

function pathInside(path: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function realpathOrResolved(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

function workspaceKey(root: string): string {
  return createHash("sha256").update(resolve(root)).digest("hex").slice(0, 32);
}

function parseJsonObject(text: string, label: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new ResearchCycleError(
      "RESEARCH_CYCLE_JSON_INVALID",
      `${label} is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!isRecord(value)) {
    throw new ResearchCycleError(
      "RESEARCH_CYCLE_JSON_OBJECT_REQUIRED",
      `${label} must be a JSON object`,
    );
  }
  return value;
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

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function runProcess(
  command: string,
  args: string[],
  options: { cwd?: string; timeoutMs: number },
): Promise<ResearchNativeResult> {
  return await new Promise((resolveResult, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: processEnvironment(),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`process timed out after ${options.timeoutMs}ms`));
    }, options.timeoutMs);
    timer.unref();
    const append = (target: Buffer[], chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_PROCESS_OUTPUT_BYTES) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.kill("SIGKILL");
        reject(new Error("process output exceeded 2 MiB"));
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => append(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => append(stderr, chunk));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveResult({
        exitCode: code ?? -1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

function processFailureEvidence(
  result: ResearchNativeResult,
): Record<string, unknown> {
  const output = `${result.stderr}\n${result.stdout}`;
  return {
    exitCode: result.exitCode,
    stdoutPresent: result.stdout.length > 0,
    stderrPresent: result.stderr.length > 0,
    outputBytes: Buffer.byteLength(output),
    outputDigestSha256: createHash("sha256").update(output).digest("hex"),
  };
}

async function defaultNativeRunner(
  config: ZesResearchCycleConfig,
  invocation: ResearchNativeInvocation,
): Promise<ResearchNativeResult> {
  return await runProcess(
    "uv",
    [
      "run",
      "--frozen",
      "--directory",
      config.repositoryRoot,
      "--package",
      "zes-control-kernel",
      "zes-research-reflex",
      invocation.operation,
      ...invocation.args,
    ],
    { cwd: invocation.cwd, timeoutMs: invocation.timeoutMs },
  );
}

async function git(root: string, args: string[]): Promise<string> {
  const result = await runProcess(
    "git",
    ["-C", root, ...args],
    { timeoutMs: 30_000 },
  );
  if (result.exitCode !== 0) {
    throw new ResearchCycleError(
      "RESEARCH_CYCLE_GIT_FAILED",
      `git ${args[0] ?? "command"} failed with exit ${result.exitCode}`,
      processFailureEvidence(result),
    );
  }
  return result.stdout.trim();
}

async function workingContentDigest(root: string, head: string): Promise<{
  digest: string;
  dirty: boolean;
}> {
  const diffResult = await runProcess(
    "git",
    ["-C", root, "diff", "--binary", "--no-ext-diff", head, "--"],
    { timeoutMs: 30_000 },
  );
  if (diffResult.exitCode !== 0) {
    throw new ResearchCycleError(
      "RESEARCH_CYCLE_GIT_FAILED",
      `git diff failed with exit ${diffResult.exitCode}`,
      processFailureEvidence(diffResult),
    );
  }
  const untrackedResult = await runProcess(
    "git",
    [
      "-C",
      root,
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
    ],
    { timeoutMs: 30_000 },
  );
  if (untrackedResult.exitCode !== 0) {
    throw new ResearchCycleError(
      "RESEARCH_CYCLE_GIT_FAILED",
      `git ls-files failed with exit ${untrackedResult.exitCode}`,
      processFailureEvidence(untrackedResult),
    );
  }
  const diff = diffResult.stdout;
  const rawUntracked = untrackedResult.stdout;
  const untracked = rawUntracked.split("\0").filter(Boolean).sort();
  const hash = createHash("sha256");
  hash.update("devspace.zes-working-content.v1\0");
  hash.update(head);
  hash.update("\0diff\0");
  hash.update(diff);
  for (const rawPath of untracked) {
    const path = normalizeRelativePath(rawPath, "untracked Git path");
    const absolute = resolve(root, path);
    if (!pathInside(absolute, root)) {
      throw new ResearchCycleError(
        "RESEARCH_CYCLE_UNTRACKED_PATH_ESCAPE",
        "untracked Git path escaped the workspace",
      );
    }
    const metadata = await lstat(absolute);
    hash.update("\0untracked\0");
    hash.update(path);
    hash.update("\0");
    if (metadata.isSymbolicLink()) {
      hash.update("symlink\0");
      hash.update(await readlink(absolute));
    } else if (metadata.isFile()) {
      hash.update("file\0");
      hash.update(String(metadata.size));
      hash.update("\0");
      hash.update(await sha256File(absolute));
    } else {
      hash.update(`other:${metadata.mode}`);
    }
  }
  return {
    digest: hash.digest("hex"),
    dirty: diff.length > 0 || untracked.length > 0,
  };
}

async function gitSnapshot(root: string): Promise<GitSnapshot> {
  const head = await git(root, ["rev-parse", "HEAD"]);
  const sourceTree = await git(root, ["rev-parse", `${head}^{tree}`]);
  const branchResult = await runProcess(
    "git",
    ["-C", root, "symbolic-ref", "--quiet", "--short", "HEAD"],
    { timeoutMs: 30_000 },
  );
  const branch = branchResult.exitCode === 0 && branchResult.stdout.trim()
    ? branchResult.stdout.trim()
    : "(detached)";
  const commonDir = await git(root, ["rev-parse", "--git-common-dir"]);
  const remoteResult = await runProcess(
    "git",
    ["-C", root, "remote", "-v"],
    { timeoutMs: 30_000 },
  );
  const content = await workingContentDigest(root, head);
  return {
    head,
    sourceTree,
    branch,
    repositoryIdentityDigestSha256: canonicalDigest({
      commonDir: resolve(root, commonDir),
      remotes: remoteResult.exitCode === 0 ? remoteResult.stdout.trim() : "",
    }),
    workingContentDigestSha256: content.digest,
    dirty: content.dirty,
  };
}

async function currentChangedPaths(root: string): Promise<string[]> {
  const tracked = await runProcess(
    "git",
    ["-C", root, "diff", "--name-only", "-z", "HEAD", "--"],
    { timeoutMs: 30_000 },
  );
  const untracked = await runProcess(
    "git",
    [
      "-C",
      root,
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
    ],
    { timeoutMs: 30_000 },
  );
  if (tracked.exitCode !== 0 || untracked.exitCode !== 0) {
    throw new ResearchCycleError(
      "RESEARCH_CYCLE_GIT_FAILED",
      `cannot reconcile changed paths (tracked exit ${tracked.exitCode}, untracked exit ${untracked.exitCode})`,
      {
        tracked: processFailureEvidence(tracked),
        untracked: processFailureEvidence(untracked),
      },
    );
  }
  return uniqueStrings(
    [...tracked.stdout.split("\0"), ...untracked.stdout.split("\0")]
      .filter(Boolean)
      .map((path) => normalizeRelativePath(path, "changed Git path")),
    "changedPaths",
  );
}

export function extractPatchPaths(patch: string): string[] {
  const paths: string[] = [];
  for (const line of patch.split(/\r?\n/u)) {
    const file = line.match(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/u)?.[1];
    const move = line.match(/^\*\*\* Move to: (.+)$/u)?.[1];
    if (file) paths.push(normalizeRelativePath(file, "patch path"));
    if (move) paths.push(normalizeRelativePath(move, "patch move path"));
  }
  if (paths.length === 0) {
    throw new ResearchCycleError(
      "RESEARCH_CYCLE_PATCH_PATHS_MISSING",
      "the patch contains no recognized file path",
    );
  }
  return [...new Set(paths)].sort();
}

function commandHas(command: string, expression: RegExp): boolean {
  return expression.test(command.toLowerCase());
}

export function classifyResearchCommand(command: string): ResearchCommandClass {
  const value = command.trim();
  if (!value) return "unknown";
  if (
    commandHas(value, /\bgit\b[^\n;&|]*\bpush\b/u)
    || commandHas(value, /\bgh\s+(?:pr\s+(?:create|merge)|release\s+create)\b/u)
    || commandHas(value, /\b(?:npm\s+publish|twine\s+upload)\b/u)
  ) return "repository_publish";
  if (
    commandHas(value, /\bsystemctl\s+(?:start|stop|restart|reload|enable|disable)\b/u)
    || commandHas(value, /\bdocker(?:\s+compose)?\s+(?:up|down|run|rm|rmi|build|push|pull)\b/u)
    || commandHas(value, /\bkubectl\s+(?:apply|create|delete|edit|patch|replace|rollout|scale|set)\b/u)
    || commandHas(value, /\bhelm\s+(?:install|upgrade|rollback|uninstall)\b/u)
    || commandHas(value, /\bterraform\s+(?:apply|destroy|import)\b/u)
  ) return "runtime_effect";
  if (commandHas(value, /\bgit\b[^\n;&|]*\bcommit\b/u)) {
    return "repository_commit";
  }
  if (commandHas(value, /\bgit\b[^\n;&|]*\badd\b/u)) return "commit_prepare";
  if (
    commandHas(value, /\bzes-research-reflex\b/u)
    || commandHas(value, /\bzes-accelerate\b[^\n;&|]*\bprovider\b/u)
  ) return "research_control";
  if (
    commandHas(value, /\bgit\b[^\n;&|]*\b(?:am|checkout|cherry-pick|clean|merge|mv|rebase|reset|restore|rm|switch|tag)\b/u)
    || commandHas(value, /\b(?:npm|pnpm|yarn)\s+(?:add|install|remove|uninstall|update|upgrade)\b/u)
    || commandHas(value, /\buv\s+(?:add|remove|lock|sync)\b/u)
    || commandHas(value, /\bpip\s+install\b/u)
    || commandHas(value, /(?:^|[;&|]\s*)(?:tee|sed\s+-i|perl\s+-i)\b/u)
    || /(?:^|[^>])>{1,2}(?!>)/u.test(value)
  ) return "source_mutation";
  if (
    commandHas(value, /\b(?:npm|pnpm|yarn)\s+(?:test|run\s+(?:build|check|lint|test|typecheck))\b/u)
    || commandHas(value, /\b(?:pytest|ruff|mypy|pyright|vitest|jest|eslint|tsc)\b/u)
    || commandHas(value, /\b(?:pants|bake)\b/u)
    || commandHas(value, /\bgit\s+diff\s+--check\b/u)
  ) return "validation";
  if (
    commandHas(value, /^(?:\s*(?:rg|grep|find|fd|ls|tree|cat|head|tail|wc|stat|du|df|jq|yq|echo|printf)\b)/u)
    || commandHas(value, /\bgit\s+(?:status|diff|log|show|rev-parse|branch|remote|ls-files|ls-tree|merge-base)\b/u)
    || commandHas(value, /\bsystemctl\s+(?:status|show|cat|is-active|is-enabled)\b/u)
    || commandHas(value, /\bdocker\s+(?:ps|images|inspect|logs|version|info)\b/u)
    || commandHas(value, /\bdocker\s+buildx\s+bake\b[^\n;&|]*--print\b/u)
    || commandHas(value, /\bkubectl\s+(?:get|describe|logs|diff|version)\b/u)
  ) return "inspection";
  return "unknown";
}

function dependencySensitive(path: string): boolean {
  const name = path.split("/").at(-1) ?? path;
  return name === "package.json"
    || name === "package-lock.json"
    || name === "pnpm-lock.yaml"
    || name === "yarn.lock"
    || name === "pyproject.toml"
    || name === "uv.lock"
    || name === "pants.toml"
    || name === "Dockerfile"
    || name === "docker-compose.yml"
    || name === "docker-compose.yaml"
    || name === "BUILD"
    || name.startsWith("BUILD.")
    || path.startsWith(".github/workflows/")
    || path.startsWith("release/");
}

function commandChangesDependencies(command: string): boolean {
  return commandHas(
    command,
    /\b(?:npm|pnpm|yarn)\s+(?:add|install|remove|uninstall|update|upgrade)\b/u,
  )
    || commandHas(command, /\buv\s+(?:add|remove|lock|sync)\b/u)
    || commandHas(command, /\bpip\s+install\b/u);
}

function boundedDiscoveryText(value: string, label: string): string {
  const normalized = requiredString(value, label);
  if (
    normalized.includes("\0")
    || normalized.length > MAX_DISCOVERY_TEXT_CHARACTERS
  ) {
    throw new ResearchCycleError(
      "RESEARCH_DISCOVERY_INPUT_INVALID",
      `${label} exceeds the bounded discovery text contract`,
      { maxCharacters: MAX_DISCOVERY_TEXT_CHARACTERS },
    );
  }
  return normalized;
}

function parseRegimePolicy(regime: ResearchTemporalRegime): DiscoveryRegimePolicy {
  const policy = DISCOVERY_REGIME_POLICY[regime];
  if (!policy) {
    throw new ResearchCycleError(
      "RESEARCH_DISCOVERY_INPUT_INVALID",
      "unknown temporal regime",
      { temporalRegime: regime },
    );
  }
  return policy;
}

function normalizedTimestamp(value: string, label: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) {
    throw new ResearchCycleError(
      "RESEARCH_DISCOVERY_INPUT_INVALID",
      `${label} is not a valid ISO timestamp`,
      { value },
    );
  }
  return parsed.toISOString();
}

function shiftedTimestamp(value: string, days: number): string {
  const shifted = new Date(value);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString();
}

function discoveryQueryRef(
  cycleRef: string,
  generation: number,
  lane: ResearchDiscoveryLane,
  query: string,
): string {
  return `${DISCOVERY_PORTFOLIO_PREFIX}:query:${cycleRef.split(":").at(-1)}:${generation}:${lane}:${canonicalDigest({ lane, query }).slice(0, 18)}`;
}

function resolveQueryTemplate(
  template: string,
  subjectQuestion: string,
  subjectRef: string,
  derivedSince: string,
): string {
  return template
    .replaceAll("{{subject}}", subjectQuestion)
    .replaceAll("{{subjectRef}}", subjectRef)
    .replaceAll("{{derivedSince}}", derivedSince)
    .trim();
}

function dispositionRank(disposition: ResearchLaneDisposition): number {
  if (disposition === "required") return 2;
  if (disposition === "conditional") return 1;
  return 0;
}

function validateDiscoveryLaneRef(
  binding: {
    lane: ResearchDiscoveryLane;
    disposition: ResearchLaneDisposition;
    reason?: string;
  },
): void {
  if (!Object.hasOwn(DISCOVERY_LANE_QUERIES, binding.lane)) {
    throw new ResearchCycleError(
      "RESEARCH_DISCOVERY_COVERAGE_INVALID",
      "unknown coverage lane in discovery request",
      { lane: binding.lane },
    );
  }
  if (
    binding.disposition !== "required"
    && binding.disposition !== "conditional"
    && binding.disposition !== "not_applicable"
  ) {
    throw new ResearchCycleError(
      "RESEARCH_DISCOVERY_COVERAGE_INVALID",
      "discovery lane disposition must be required, conditional, or not_applicable",
      { lane: binding.lane, disposition: binding.disposition },
    );
  }
  if (binding.reason !== undefined) boundedDiscoveryText(binding.reason, "coverage reason");
}

function mergeCoverageDispositions(
  profile: ResearchDiscoveryProfile,
  explicit?: ResearchDiscoveryPlanInput["explicitCoverageLanes"],
): DiscoveryCoverageLaneBinding[] {
  const profileBindings = DISCOVERY_PROFILE_LANES[profile];
  if (!profileBindings) {
    throw new ResearchCycleError(
      "RESEARCH_DISCOVERY_INPUT_INVALID",
      "unknown discovery profile",
      { discoveryProfile: profile },
    );
  }
  const merged = new Map<ResearchDiscoveryLane, DiscoveryCoverageLaneBinding>(
    profileBindings.map((entry) => [entry.lane, {
      ...entry,
      reason: `profile:${profile}:${entry.disposition}`,
    }]),
  );
  const seen = new Set<ResearchDiscoveryLane>();
  for (const raw of explicit ?? []) {
    validateDiscoveryLaneRef(raw);
    if (seen.has(raw.lane)) {
      throw new ResearchCycleError(
        "RESEARCH_DISCOVERY_COVERAGE_INVALID",
        "explicit coverage lanes must be unique",
        { lane: raw.lane },
      );
    }
    seen.add(raw.lane);
    const existing = merged.get(raw.lane);
    if (
      existing?.disposition === "required"
      && dispositionRank(raw.disposition) < dispositionRank("required")
    ) {
      throw new ResearchCycleError(
        "RESEARCH_DISCOVERY_COVERAGE_INVALID",
        "caller-provided labels cannot weaken a profile-required discovery lane",
        { lane: raw.lane },
      );
    }
    merged.set(raw.lane, {
      lane: raw.lane,
      disposition: raw.disposition,
      reason: boundedDiscoveryText(raw.reason, "coverage reason"),
    });
  }
  return [...merged.values()].sort((left, right) =>
    left.lane.localeCompare(right.lane));
}

function discoveryLanePurpose(
  lane: ResearchDiscoveryLane,
): "fresh_acquisition" | "counterevidence_or_blind_challenge" {
  return lane === "counterevidence_or_falsifier"
    ? "counterevidence_or_blind_challenge"
    : "fresh_acquisition";
}

function discoveryPolicyDigest(
  temporalRegime: ResearchTemporalRegime,
): string {
  return canonicalDigest({
    schemaVersion: "devspace.zes-research-discovery-policy.v1",
    planVersion: DISCOVERY_PLAN_VERSION,
    queryTemplateVersion: DISCOVERY_QUERY_TEMPLATE_VERSION,
    queryConstraintMode: DISCOVERY_QUERY_CONSTRAINT_MODE,
    temporalRegime,
    regimePolicy: parseRegimePolicy(temporalRegime),
    profiles: DISCOVERY_PROFILE_LANES,
    laneQueries: DISCOVERY_LANE_QUERIES,
    maxPortfolioQueries: MAX_DISCOVERY_PORTFOLIO_QUERIES,
    maxQueriesPerLane: MAX_DISCOVERY_QUERIES_PER_LANE,
    maxResultsPerQuery: MAX_DISCOVERY_RESULTS_PER_QUERY,
    provider: "exa",
    operation: "search",
    capabilityRef: DISCOVERY_OPEN_WORLD_CAPABILITY_REF,
    sourceOriginNeutral: true,
  });
}

function buildDiscoveryQueries(
  cycleRef: string,
  generation: number,
  coverageLanes: DiscoveryCoverageLaneBinding[],
  subjectQuestion: string,
  subjectRef: string,
  derivedSince: string,
  knownCandidateRefs: string[],
  incumbentRef: string | undefined,
  priorSnapshotRef: string | undefined,
): DiscoveryPlanQueryBinding[] {
  const context = [
    knownCandidateRefs.length > 0
      ? `known candidates: ${knownCandidateRefs.join(", ")}`
      : undefined,
    incumbentRef ? `incumbent: ${incumbentRef}` : undefined,
    priorSnapshotRef ? `prior snapshot: ${priorSnapshotRef}` : undefined,
  ].filter((value): value is string => Boolean(value)).join("; ");
  const queries: DiscoveryPlanQueryBinding[] = [];
  for (const coverage of coverageLanes) {
    if (coverage.disposition === "not_applicable") continue;
    const laneQueries = DISCOVERY_LANE_QUERIES[coverage.lane]
      .slice(0, MAX_DISCOVERY_QUERIES_PER_LANE)
      .map((template, index) => {
        const base = resolveQueryTemplate(
          template,
          subjectQuestion,
          subjectRef,
          derivedSince,
        );
        return boundedDiscoveryText(
          index === 1 && context ? `${base}; ${context}` : base,
          "discovery query",
        );
      });
    for (const query of [...new Set(laneQueries)].sort()) {
      queries.push({
        queryRef: discoveryQueryRef(cycleRef, generation, coverage.lane, query),
        lane: coverage.lane,
        query,
        providerPurpose: discoveryLanePurpose(coverage.lane),
        provider: "exa",
        operation: "search",
        maxResults: MAX_DISCOVERY_RESULTS_PER_QUERY,
        queryTemplateVersion: DISCOVERY_QUERY_TEMPLATE_VERSION,
        temporalConstraint: {
          mode: DISCOVERY_QUERY_CONSTRAINT_MODE,
          derivedSince,
          providerNativeDateFilterApplied: false,
          providerNativeDomainFilterApplied: false,
        },
      });
    }
  }
  if (queries.length < 1 || queries.length > MAX_DISCOVERY_PORTFOLIO_QUERIES) {
    throw new ResearchCycleError(
      "RESEARCH_DISCOVERY_PORTFOLIO_INVALID",
      "discovery plan must contain a bounded non-empty query portfolio",
      { queryCount: queries.length, max: MAX_DISCOVERY_PORTFOLIO_QUERIES },
    );
  }
  const refs = queries.map((entry) => entry.queryRef);
  if (new Set(refs).size !== refs.length) {
    throw new ResearchCycleError(
      "RESEARCH_DISCOVERY_PORTFOLIO_INVALID",
      "discovery query identities must be unique",
    );
  }
  return queries.sort((left, right) => left.queryRef.localeCompare(right.queryRef));
}

function discoveryPortfolioDigest(input: {
  policyDigestSha256: string;
  temporalRegime: ResearchTemporalRegime;
  asOf: string;
  derivedSince: string;
  revalidateBy: string;
  coverageLanes: DiscoveryCoverageLaneBinding[];
  queries: DiscoveryPlanQueryBinding[];
}): string {
  return canonicalDigest({
    schemaVersion: "devspace.zes-research-discovery-portfolio.v1",
    ...input,
  });
}

function discoveryPlanIdentity(
  plan: Omit<DiscoveryPlanRecord, "planDigestSha256" | "requestedAt">,
): Record<string, unknown> {
  return {
    schemaVersion: plan.schemaVersion,
    planRef: plan.planRef,
    policyDigestSha256: plan.policyDigestSha256,
    portfolioDigestSha256: plan.portfolioDigestSha256,
    subjectRef: plan.subjectRef,
    subjectQuestion: plan.subjectQuestion,
    discoveryProfile: plan.discoveryProfile,
    temporalRegime: plan.temporalRegime,
    asOf: plan.asOf,
    derivedSince: plan.derivedSince,
    revalidateBy: plan.revalidateBy,
    lookbackDays: plan.lookbackDays,
    revalidateByDays: plan.revalidateByDays,
    knownCandidateRefs: plan.knownCandidateRefs,
    incumbentRef: plan.incumbentRef,
    priorSnapshotRef: plan.priorSnapshotRef,
    generation: plan.generation,
    coverageLanes: plan.coverageLanes,
    queries: plan.queries,
    requestedBy: plan.requestedBy,
    sourceOriginNeutral: plan.sourceOriginNeutral,
    queryConstraintMode: plan.queryConstraintMode,
  };
}

function generateDiscoveryPlanRef(
  cycleRef: string,
  generation: number,
  portfolioDigestSha256: string,
): string {
  return `${DISCOVERY_PORTFOLIO_PREFIX}:plan:${cycleRef.split(":").at(-1)}:${generation}:${portfolioDigestSha256.slice(0, 16)}`;
}

function discoveryAttemptRef(planRef: string, queryRef: string): string {
  return `${DISCOVERY_PORTFOLIO_PREFIX}:attempt:${canonicalDigest({
    planRef,
    queryRef,
    ordinal: 1,
  }).slice(0, 24)}`;
}

function discoveryHorizonDigest(input: {
  planRef: string;
  asOf: string;
  policyDigestSha256: string;
  planDigestSha256: string;
  portfolioDigestSha256: string;
  priorSnapshot?: PriorDiscoverySnapshotRecord;
  evidenceIdentities: HorizonRecord["evidenceIdentities"];
  generation: number;
  events: HorizonEventRecord[];
  staleReasons: string[];
  requiresResearchReflexRefresh: boolean;
}): string {
  return canonicalDigest({
    schemaVersion: HORIZON_SCHEMA,
    planRef: input.planRef,
    asOf: input.asOf,
    policyDigestSha256: input.policyDigestSha256,
    planDigestSha256: input.planDigestSha256,
    portfolioDigestSha256: input.portfolioDigestSha256,
    priorSnapshot: input.priorSnapshot,
    evidenceIdentities: input.evidenceIdentities,
    generation: input.generation,
    events: input.events,
    staleReasons: input.staleReasons,
    requiresResearchReflexRefresh: input.requiresResearchReflexRefresh,
  });
}

function discoveryHorizonRef(
  cycleRef: string,
  generation: number,
  digestSha256: string,
): string {
  return `${DISCOVERY_PORTFOLIO_PREFIX}:horizon:${cycleRef.split(":").at(-1)}:${generation}:${digestSha256.slice(0, 16)}`;
}

function assertDiscoveryPlanIntegrity(
  plan: DiscoveryPlanRecord,
  cycleRef: string,
): void {
  if (plan.schemaVersion !== DISCOVERY_PLAN_SCHEMA) {
    throw new ResearchCycleError(
      "RESEARCH_DISCOVERY_STATE_INVALID",
      "persisted discovery plan schema is unsupported",
    );
  }
  const currentPolicy = discoveryPolicyDigest(plan.temporalRegime);
  if (plan.policyDigestSha256 !== currentPolicy) {
    throw new ResearchCycleError(
      "RESEARCH_DISCOVERY_POLICY_CHANGED",
      "persisted discovery plan policy no longer matches the running implementation",
      { planRef: plan.planRef },
    );
  }
  const portfolioDigestSha256 = discoveryPortfolioDigest({
    policyDigestSha256: plan.policyDigestSha256,
    temporalRegime: plan.temporalRegime,
    asOf: plan.asOf,
    derivedSince: plan.derivedSince,
    revalidateBy: plan.revalidateBy,
    coverageLanes: plan.coverageLanes,
    queries: plan.queries,
  });
  if (portfolioDigestSha256 !== plan.portfolioDigestSha256) {
    throw new ResearchCycleError(
      "RESEARCH_DISCOVERY_PORTFOLIO_CHANGED",
      "persisted discovery portfolio identity changed",
      { planRef: plan.planRef },
    );
  }
  const expectedPlanRef = generateDiscoveryPlanRef(
    cycleRef,
    plan.generation,
    plan.portfolioDigestSha256,
  );
  if (plan.planRef !== expectedPlanRef) {
    throw new ResearchCycleError(
      "RESEARCH_DISCOVERY_PLAN_IDENTITY_CHANGED",
      "persisted discovery plan reference does not match its cycle and portfolio identity",
      { planRef: plan.planRef, expectedPlanRef },
    );
  }
  const planDigestSha256 = canonicalDigest(
    discoveryPlanIdentity(plan),
  );
  if (planDigestSha256 !== plan.planDigestSha256) {
    throw new ResearchCycleError(
      "RESEARCH_DISCOVERY_PLAN_CHANGED",
      "persisted discovery plan digest changed",
      { planRef: plan.planRef },
    );
  }
  if (
    plan.queries.length < 1
    || plan.queries.length > MAX_DISCOVERY_PORTFOLIO_QUERIES
    || new Set(plan.queries.map((entry) => entry.queryRef)).size
      !== plan.queries.length
  ) {
    throw new ResearchCycleError(
      "RESEARCH_DISCOVERY_STATE_INVALID",
      "persisted discovery query portfolio is not bounded and unique",
    );
  }
}

function mergeDiscoveryCoverage(
  plan: DiscoveryPlanRecord,
  acquisitions: DiscoveryAcquisitionRecord[],
): DiscoveryCoverageStatus[] {
  const byQuery = new Map(
    acquisitions
      .filter((entry) => entry.planRef === plan.planRef)
      .map((entry) => [entry.queryRef, entry]),
  );
  return plan.coverageLanes.map((coverage) => {
    const queryRefs = plan.queries
      .filter((entry) => entry.lane === coverage.lane)
      .map((entry) => entry.queryRef)
      .sort();
    if (coverage.disposition === "not_applicable") {
      return {
        ...coverage,
        queryRefs: [],
        evidenceRefs: [],
        status: "covered" as const,
        residuals: ["not_applicable"],
      };
    }
    const records = queryRefs
      .map((queryRef) => byQuery.get(queryRef))
      .filter((entry): entry is DiscoveryAcquisitionRecord => Boolean(entry));
    const acquired = records.filter((entry) => entry.status === "acquired");
    const evidenceRefs = acquired
      .map((entry) => entry.providerEvidenceRef)
      .filter((entry): entry is string => Boolean(entry))
      .sort();
    const missing = queryRefs.filter((queryRef) => !byQuery.has(queryRef));
    const failed = records.filter((entry) => entry.status === "failed");
    const pending = records.filter((entry) => entry.status === "pending");
    const status: DiscoveryCoverageStatus["status"] =
      queryRefs.length > 0 && acquired.length === queryRefs.length
        ? "covered"
        : records.length > 0
          ? "partial"
          : "unresolved";
    return {
      ...coverage,
      queryRefs,
      evidenceRefs,
      status,
      residuals: uniqueStrings([
        ...missing.map((entry) => `not_acquired:${entry}`),
        ...failed.map((entry) =>
          `failed:${entry.queryRef}:${entry.failureCode ?? "unknown"}`),
        ...pending.map((entry) => `pending:${entry.queryRef}:${entry.attemptRef}`),
        ...(queryRefs.length === 0 ? ["no_query_for_applicable_lane"] : []),
      ], "discoveryCoverageResiduals"),
    };
  });
}

function discoveryRequiredCovered(coverage: DiscoveryCoverageStatus[]): boolean {
  return coverage.every((entry) =>
    entry.disposition !== "required" || entry.status === "covered");
}

function isDiscoveryPlanCurrent(plan: DiscoveryPlanRecord, at: string): boolean {
  const current = Date.parse(at);
  return Number.isFinite(current)
    && Date.parse(plan.asOf) <= current
    && current <= Date.parse(plan.revalidateBy);
}

function discoveryAcquiredEvidenceRefs(
  acquisitions: DiscoveryAcquisitionRecord[],
  planRef: string,
): string[] {
  return acquisitions
    .filter((entry) => entry.planRef === planRef && entry.status === "acquired")
    .map((entry) => entry.providerEvidenceRef)
    .filter((entry): entry is string => Boolean(entry))
    .sort();
}

async function validatePrivateDiscoveryFile(
  path: string,
  evidenceDirectory: string,
  expectedSha256: string,
  label: string,
): Promise<void> {
  if (!SHA256.test(expectedSha256)) {
    throw new ResearchCycleError(
      "RESEARCH_DISCOVERY_EVIDENCE_TRACE_INVALID",
      `${label} lacks a valid SHA-256 identity`,
    );
  }
  const requested = resolve(path);
  const root = await realpathOrResolved(evidenceDirectory);
  let metadata;
  try {
    metadata = await lstat(requested);
  } catch {
    throw new ResearchCycleError(
      "RESEARCH_DISCOVERY_EVIDENCE_MISSING",
      `${label} is missing`,
      { path: requested },
    );
  }
  if (
    metadata.isSymbolicLink()
    || !metadata.isFile()
    || metadata.nlink !== 1
    || metadata.size > MAX_DISCOVERY_EVIDENCE_BYTES
    || (metadata.mode & 0o077) !== 0
  ) {
    throw new ResearchCycleError(
      "RESEARCH_DISCOVERY_EVIDENCE_TRACE_INVALID",
      `${label} is not a bounded owner-private single-link regular file`,
      { path: requested },
    );
  }
  const actual = await realpath(requested);
  if (!pathInside(actual, root)) {
    throw new ResearchCycleError(
      "RESEARCH_DISCOVERY_EVIDENCE_PATH_UNSAFE",
      `${label} escaped the cycle evidence directory`,
      { path: actual },
    );
  }
  if (await sha256File(actual) !== expectedSha256) {
    throw new ResearchCycleError(
      "RESEARCH_DISCOVERY_EVIDENCE_CHANGED",
      `${label} changed after acquisition`,
      { path: actual },
    );
  }
}

async function verifyDiscoveryAcquisition(
  acquisition: DiscoveryAcquisitionRecord,
  evidenceDirectory: string,
): Promise<void> {
  if (acquisition.status !== "acquired") return;
  if (
    !acquisition.providerEvidenceRef
    || !acquisition.providerTraceRef
    || !acquisition.providerEvidencePath
    || !acquisition.providerTracePath
    || !acquisition.providerEvidenceFileSha256
    || !acquisition.providerTraceFileSha256
  ) {
    throw new ResearchCycleError(
      "RESEARCH_DISCOVERY_EVIDENCE_TRACE_INVALID",
      "acquired discovery record lacks immutable evidence identities",
      { queryRef: acquisition.queryRef },
    );
  }
  await validatePrivateDiscoveryFile(
    acquisition.providerEvidencePath,
    evidenceDirectory,
    acquisition.providerEvidenceFileSha256,
    "discovery provider evidence",
  );
  await validatePrivateDiscoveryFile(
    acquisition.providerTracePath,
    evidenceDirectory,
    acquisition.providerTraceFileSha256,
    "discovery provider trace",
  );
}

async function validateDiscoveryRunnerResult(
  result: ResearchProviderAcquisitionResult,
  query: DiscoveryPlanQueryBinding,
  ownerSeededFraming: boolean,
  evidenceDirectory: string,
): Promise<void> {
  await validatePrivateDiscoveryFile(
    result.providerEvidencePath,
    evidenceDirectory,
    result.providerEvidenceFileSha256,
    "discovery provider evidence",
  );
  await validatePrivateDiscoveryFile(
    result.providerTracePath,
    evidenceDirectory,
    result.providerTraceFileSha256,
    "discovery provider trace",
  );
  const evidence = result.providerEvidence;
  const capabilities = Array.isArray(evidence.verified_capability_refs)
    ? evidence.verified_capability_refs
    : [];
  if (
    result.status !== "acquired"
    || evidence.schema_version !== "zes.research-provider-execution-evidence.v2"
    || evidence.evidence_ref !== result.providerEvidenceRef
    || evidence.provider_operation !== query.operation
    || evidence.purpose !== query.providerPurpose
    || evidence.open_world_candidate_discovery_performed !== true
    || evidence.owner_seeded_framing !== ownerSeededFraming
    || evidence.trace_source_ref !== result.providerTraceRef
    || !capabilities.includes(DISCOVERY_OPEN_WORLD_CAPABILITY_REF)
  ) {
    throw new ResearchCycleError(
      "RESEARCH_DISCOVERY_ACQUISITION_BINDING_MISMATCH",
      "provider result does not prove the frozen discovery query route and capability",
      { queryRef: query.queryRef },
    );
  }
}

async function verifyDiscoveryState(
  state: ResearchCycleState,
  at: string,
  evidenceRefs: string[] | undefined,
): Promise<{
  plan: DiscoveryPlanRecord;
  coverage: DiscoveryCoverageStatus[];
  evidenceRefs: string[];
  providerTraces: ResearchProviderTraceInput[];
}> {
  const plan = state.discovery?.plan;
  if (!plan) {
    if ((evidenceRefs ?? []).length > 0) {
      throw new ResearchCycleError(
        "RESEARCH_DISCOVERY_EVIDENCE_NOT_CURRENT",
        "discovery evidence refs were supplied without an active plan",
      );
    }
    throw new ResearchCycleError(
      "RESEARCH_DISCOVERY_PLAN_MISSING",
      "an active discovery plan is required for this verification",
    );
  }
  assertDiscoveryPlanIntegrity(plan, state.cycleRef);
  if (plan.generation !== state.generation) {
    throw new ResearchCycleError(
      "RESEARCH_DISCOVERY_PLAN_GENERATION_MISMATCH",
      "discovery plan belongs to a different research generation",
      { planGeneration: plan.generation, currentGeneration: state.generation },
    );
  }
  if (!isDiscoveryPlanCurrent(plan, at)) {
    throw new ResearchCycleError(
      "RESEARCH_DISCOVERY_PLAN_STALE",
      "discovery plan is outside its regime-aware currentness interval",
      { planRef: plan.planRef, asOf: plan.asOf, revalidateBy: plan.revalidateBy, at },
    );
  }
  const acquisitions = state.discovery?.acquisitions ?? [];
  const coverage = mergeDiscoveryCoverage(plan, acquisitions);
  if (!discoveryRequiredCovered(coverage)) {
    throw new ResearchCycleError(
      "RESEARCH_DISCOVERY_COVERAGE_INCOMPLETE",
      "required discovery lanes are not fully covered",
      { coverage },
    );
  }
  for (const acquisition of acquisitions) {
    if (acquisition.planRef === plan.planRef) {
      await verifyDiscoveryAcquisition(acquisition, state.open.evidenceDirectory);
    }
  }
  const acquiredRefs = discoveryAcquiredEvidenceRefs(acquisitions, plan.planRef);
  const requestedRefs = uniqueStrings(evidenceRefs ?? acquiredRefs, "discoveryEvidenceRefs");
  const missing = requestedRefs.filter((entry) => !acquiredRefs.includes(entry));
  const omitted = acquiredRefs.filter((entry) => !requestedRefs.includes(entry));
  if (missing.length > 0 || omitted.length > 0) {
    throw new ResearchCycleError(
      "RESEARCH_DISCOVERY_EVIDENCE_NOT_CURRENT",
      "discovery evidence refs must exactly match the acquired evidence set for the active plan",
      { missing, omitted },
    );
  }
  const horizon = state.discovery?.horizon;
  if (
    !horizon
    || horizon.planRef !== plan.planRef
    || horizon.generation !== plan.generation
    || horizon.planDigestSha256 !== plan.planDigestSha256
    || horizon.portfolioDigestSha256 !== plan.portfolioDigestSha256
  ) {
    throw new ResearchCycleError(
      "RESEARCH_DISCOVERY_HORIZON_REQUIRED",
      "record a horizon checkpoint for the exact current discovery plan before assessment",
      { planRef: plan.planRef },
    );
  }
  const selected = acquisitions
    .filter((entry) =>
      entry.planRef === plan.planRef
      && entry.status === "acquired"
      && Boolean(entry.providerEvidenceRef)
      && requestedRefs.includes(entry.providerEvidenceRef!));
  return {
    plan,
    coverage,
    evidenceRefs: requestedRefs,
    providerTraces: selected.map((entry) => ({
      traceRef: entry.providerTraceRef!,
      path: entry.providerTracePath!,
    })),
  };
}

function requestProviderEvidenceRefs(
  request: Record<string, unknown>,
): string[] {
  const raw = request.provider_execution_evidence;
  if (!Array.isArray(raw)) return [];
  const refs = raw.map((entry, index) => {
    if (!isRecord(entry) || typeof entry.evidence_ref !== "string") {
      throw new ResearchCycleError(
        "RESEARCH_DISCOVERY_REQUEST_EVIDENCE_INVALID",
        "provider_execution_evidence contains an entry without a canonical evidence ref",
        { index },
      );
    }
    return requiredString(entry.evidence_ref, "provider evidence ref");
  });
  if (new Set(refs).size !== refs.length) {
    throw new ResearchCycleError(
      "RESEARCH_DISCOVERY_REQUEST_EVIDENCE_INVALID",
      "provider_execution_evidence refs must be unique",
    );
  }
  return refs.sort();
}

function mergeProviderTraceInputs(
  explicit: ResearchProviderTraceInput[],
  discovery: ResearchProviderTraceInput[],
): ResearchProviderTraceInput[] {
  const merged = new Map<string, ResearchProviderTraceInput>();
  for (const entry of [...explicit, ...discovery]) {
    const traceRef = requiredString(entry.traceRef, "traceRef");
    const path = requiredString(entry.path, "provider trace path");
    const existing = merged.get(traceRef);
    if (existing && resolve(existing.path) !== resolve(path)) {
      throw new ResearchCycleError(
        "RESEARCH_CYCLE_PROVIDER_TRACE_IDENTITY_CONFLICT",
        "one provider trace ref resolved to multiple paths",
        { traceRef },
      );
    }
    merged.set(traceRef, { traceRef, path });
  }
  return [...merged.values()].sort((left, right) =>
    left.traceRef.localeCompare(right.traceRef));
}

function normalizePriorDiscoverySnapshot(
  input: ResearchPriorDiscoverySnapshotInput | undefined,
): PriorDiscoverySnapshotRecord | undefined {
  if (!input) return undefined;
  const snapshotRef = boundedDiscoveryText(input.snapshotRef, "prior snapshot ref");
  if (!SHA256.test(input.portfolioDigestSha256)) {
    throw new ResearchCycleError(
      "RESEARCH_DISCOVERY_INPUT_INVALID",
      "prior snapshot portfolio digest must be lowercase SHA-256",
    );
  }
  const evidenceIdentities = (input.evidenceIdentities ?? []).map((entry) => {
    const evidenceRef = boundedDiscoveryText(entry.evidenceRef, "prior evidence ref");
    if (!SHA256.test(entry.fileDigestSha256)) {
      throw new ResearchCycleError(
        "RESEARCH_DISCOVERY_INPUT_INVALID",
        "prior evidence file digest must be lowercase SHA-256",
        { evidenceRef },
      );
    }
    return { evidenceRef, fileDigestSha256: entry.fileDigestSha256 };
  }).sort((left, right) => left.evidenceRef.localeCompare(right.evidenceRef));
  if (new Set(evidenceIdentities.map((entry) => entry.evidenceRef)).size
    !== evidenceIdentities.length) {
    throw new ResearchCycleError(
      "RESEARCH_DISCOVERY_INPUT_INVALID",
      "prior evidence identities must be unique",
    );
  }
  return {
    snapshotRef,
    portfolioDigestSha256: input.portfolioDigestSha256,
    candidateRefs: uniqueStrings(input.candidateRefs ?? [], "priorCandidateRefs"),
    incumbentRef: input.incumbentRef
      ? boundedDiscoveryText(input.incumbentRef, "prior incumbent ref")
      : undefined,
    evidenceIdentities,
  };
}

function normalizeHorizonObservations(
  observations: ResearchHorizonObservationInput[] | undefined,
): ResearchHorizonObservationInput[] {
  const normalized = (observations ?? []).map((entry) => ({
    kind: entry.kind,
    evidenceRefs: uniqueStrings(entry.evidenceRefs, "horizonEvidenceRefs"),
    subjectRefs: uniqueStrings(entry.subjectRefs, "horizonSubjectRefs"),
    rationale: boundedDiscoveryText(entry.rationale, "horizon observation rationale"),
  }));
  if (normalized.length > MAX_DISCOVERY_OBSERVATIONS) {
    throw new ResearchCycleError(
      "RESEARCH_DISCOVERY_INPUT_INVALID",
      "horizon observation count exceeds its bounded contract",
      { max: MAX_DISCOVERY_OBSERVATIONS },
    );
  }
  for (const entry of normalized) {
    if (
      entry.evidenceRefs.length < 1
      || entry.evidenceRefs.length > MAX_DISCOVERY_EVIDENCE_REFS_PER_OBSERVATION
      || entry.subjectRefs.length > MAX_DISCOVERY_SUBJECT_REFS_PER_OBSERVATION
    ) {
      throw new ResearchCycleError(
        "RESEARCH_DISCOVERY_INPUT_INVALID",
        "horizon observation refs exceed their bounded contract",
        { kind: entry.kind },
      );
    }
  }
  const identities = normalized.map((entry) => canonicalDigest(entry));
  if (new Set(identities).size !== identities.length) {
    throw new ResearchCycleError(
      "RESEARCH_DISCOVERY_INPUT_INVALID",
      "horizon observations must be unique",
    );
  }
  return normalized.sort((left, right) =>
    canonicalDigest(left).localeCompare(canonicalDigest(right)));
}

function publicDiscoveryPlan(
  plan: DiscoveryPlanRecord,
  acquisitions: DiscoveryAcquisitionRecord[],
): DiscoveryPlanResult {
  return {
    planRef: plan.planRef,
    schemaVersion: plan.schemaVersion,
    asOf: plan.asOf,
    generatedAt: plan.requestedAt,
    generation: plan.generation,
    policyDigest: plan.policyDigestSha256,
    lookbackDays: plan.lookbackDays,
    revalidateByDays: plan.revalidateByDays,
    derivedSince: plan.derivedSince,
    revalidateBy: plan.revalidateBy,
    coverageLanes: structuredClone(plan.coverageLanes),
    queries: structuredClone(plan.queries),
    portfolioDigestSha256: plan.portfolioDigestSha256,
    coverage: mergeDiscoveryCoverage(plan, acquisitions),
  };
}

function discoveryInvalidationReasons(
  existing: DiscoveryPlanRecord,
  replacement: DiscoveryPlanRecord,
): string[] {
  const reasons: string[] = [];
  if (existing.generation !== replacement.generation) reasons.push("generation_changed");
  if (existing.asOf !== replacement.asOf) reasons.push("as_of_changed");
  if (existing.policyDigestSha256 !== replacement.policyDigestSha256) {
    reasons.push("policy_digest_changed");
  }
  if (existing.portfolioDigestSha256 !== replacement.portfolioDigestSha256) {
    reasons.push("portfolio_digest_changed");
  }
  if (existing.subjectRef !== replacement.subjectRef) reasons.push("subject_changed");
  if (existing.discoveryProfile !== replacement.discoveryProfile) {
    reasons.push("discovery_profile_changed");
  }
  if (existing.priorSnapshotRef !== replacement.priorSnapshotRef) {
    reasons.push("prior_snapshot_changed");
  }
  return reasons.length > 0 ? reasons : ["plan_identity_changed"];
}

export class ZesResearchCycleManager {
  private readonly now: () => Date;
  private readonly nativeRunner: ResearchNativeRunner;
  private readonly pendingCommands = new Map<number, PendingCommand>();
  private readonly locks = new Map<string, Promise<void>>();

  constructor(
    readonly config: ZesResearchCycleConfig,
    options: ResearchCycleManagerOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.nativeRunner = options.nativeRunner
      ?? ((invocation) => defaultNativeRunner(config, invocation));
  }

  get enabled(): boolean {
    return this.config.mode !== "off";
  }

  manages(workspace: ResearchWorkspace): boolean {
    return this.enabled
      && existsSync(resolve(workspace.root, RESEARCH_MARKER));
  }

  private cycleDirectory(workspace: ResearchWorkspace): string {
    return resolve(this.config.stateRoot, workspaceKey(workspace.root));
  }

  private statePath(workspace: ResearchWorkspace): string {
    return resolve(this.cycleDirectory(workspace), "state.json");
  }

  private async withLock<T>(
    workspace: ResearchWorkspace,
    operation: () => Promise<T>,
  ): Promise<T> {
    const key = workspaceKey(workspace.root);
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

  private assertManaged(workspace: ResearchWorkspace): void {
    if (!this.manages(workspace)) {
      throw new ResearchCycleError(
        "RESEARCH_CYCLE_WORKSPACE_NOT_MANAGED",
        "the workspace is not an enabled ZES Research Reflex workspace",
      );
    }
  }

  private async readState(
    workspace: ResearchWorkspace,
  ): Promise<ResearchCycleState | undefined> {
    try {
      const value = parseJsonObject(
        await readFile(this.statePath(workspace), "utf8"),
        "research cycle state",
      );
      if (value.schemaVersion !== STATE_SCHEMA) {
        throw new ResearchCycleError(
          "RESEARCH_CYCLE_STATE_SCHEMA_UNSUPPORTED",
          `unsupported research cycle state: ${String(value.schemaVersion)}`,
        );
      }
      return await this.validatePersistedState(workspace, value);
    } catch (error) {
      if (
        error instanceof Error
        && "code" in error
        && error.code === "ENOENT"
      ) return undefined;
      throw error;
    }
  }

  private async validatePersistedState(
    workspace: ResearchWorkspace,
    value: Record<string, unknown>,
  ): Promise<ResearchCycleState> {
    if (
      value.workspaceId !== workspace.workspaceId
      || value.workspaceRootDigestSha256
        !== canonicalDigest(resolve(workspace.root))
    ) {
      throw new ResearchCycleError(
        "RESEARCH_CYCLE_STATE_IDENTITY_MISMATCH",
        "persisted research-cycle state does not belong to this workspace",
      );
    }
    if (
      typeof value.cycleRef !== "string"
      || !value.cycleRef.startsWith("zes-research-cycle:")
      || typeof value.phase !== "string"
      || !RESEARCH_PHASES.has(value.phase as ResearchCyclePhase)
      || !Number.isInteger(value.generation)
      || Number(value.generation) < 0
      || !isRecord(value.open)
      || typeof value.open.evidenceDirectory !== "string"
    ) {
      throw new ResearchCycleError(
        "RESEARCH_CYCLE_STATE_SHAPE_INVALID",
        "persisted research-cycle state lacks a valid lifecycle identity",
      );
    }

    const cycleRoot = await realpathOrResolved(this.cycleDirectory(workspace));
    const evidenceDirectory = await realpathOrResolved(
      value.open.evidenceDirectory,
    );
    if (!pathInside(evidenceDirectory, cycleRoot)) {
      throw new ResearchCycleError(
        "RESEARCH_CYCLE_STATE_PATH_UNSAFE",
        "persisted research-cycle evidence path is outside its private cycle directory",
      );
    }

    const admission = isRecord(value.admission) ? value.admission : undefined;
    if (admission) {
      if (
        typeof admission.receiptPath !== "string"
        || !pathInside(await realpathOrResolved(admission.receiptPath), cycleRoot)
      ) {
        throw new ResearchCycleError(
          "RESEARCH_CYCLE_STATE_PATH_UNSAFE",
          "persisted admission receipt path is outside its private cycle directory",
        );
      }
      if (!Array.isArray(admission.providerTraces)) {
        throw new ResearchCycleError(
          "RESEARCH_CYCLE_STATE_SHAPE_INVALID",
          "persisted admission provider traces are invalid",
        );
      }
      const trustedRoots = await Promise.all(
        [
          workspace.root,
          evidenceDirectory,
          ...this.config.trustedTraceRoots,
        ].map(realpathOrResolved),
      );
      for (const trace of admission.providerTraces) {
        if (
          !isRecord(trace)
          || typeof trace.traceRef !== "string"
          || !trace.traceRef.trim()
          || typeof trace.path !== "string"
        ) {
          throw new ResearchCycleError(
            "RESEARCH_CYCLE_STATE_SHAPE_INVALID",
            "persisted provider trace identity is invalid",
          );
        }
        const actual = await realpathOrResolved(trace.path);
        if (!trustedRoots.some((root) => pathInside(actual, root))) {
          throw new ResearchCycleError(
            "RESEARCH_CYCLE_STATE_PATH_UNSAFE",
            "persisted provider trace path is outside configured trust roots",
            { traceRef: trace.traceRef },
          );
        }
      }
    }

    const discovery = isRecord(value.discovery) ? value.discovery : undefined;
    if (discovery) {
      if (!Array.isArray(discovery.acquisitions)) {
        throw new ResearchCycleError(
          "RESEARCH_DISCOVERY_STATE_INVALID",
          "persisted discovery acquisitions are invalid",
        );
      }
      if (!Array.isArray(discovery.invalidations)) discovery.invalidations = [];
      const discoveryInvalidations = discovery.invalidations as unknown[];
      if (discoveryInvalidations.length > 32) {
        throw new ResearchCycleError(
          "RESEARCH_DISCOVERY_STATE_INVALID",
          "persisted discovery invalidation history exceeds its bounded contract",
        );
      }
      const plan = isRecord(discovery.plan)
        ? discovery.plan as unknown as DiscoveryPlanRecord
        : undefined;
      if (plan) {
        if (
          !Array.isArray(plan.coverageLanes)
          || !Array.isArray(plan.queries)
          || typeof plan.planRef !== "string"
          || typeof plan.planDigestSha256 !== "string"
          || typeof plan.policyDigestSha256 !== "string"
          || typeof plan.portfolioDigestSha256 !== "string"
          || !Number.isInteger(plan.generation)
        ) {
          throw new ResearchCycleError(
            "RESEARCH_DISCOVERY_STATE_INVALID",
            "persisted discovery plan lacks a valid typed identity",
          );
        }
        assertDiscoveryPlanIntegrity(plan, String(value.cycleRef));
        if (plan.generation !== Number(value.generation)) {
          throw new ResearchCycleError(
            "RESEARCH_DISCOVERY_PLAN_GENERATION_MISMATCH",
            "persisted discovery plan is detached from the active research generation",
            { planGeneration: plan.generation, stateGeneration: value.generation },
          );
        }
      } else if (discovery.acquisitions.length > 0 || discovery.horizon !== undefined) {
        throw new ResearchCycleError(
          "RESEARCH_DISCOVERY_STATE_INVALID",
          "persisted discovery effects exist without a plan",
        );
      }
      if (plan) {
        const queryRefs = new Set(plan.queries.map((entry) => entry.queryRef));
        const observedQueryRefs = new Set<string>();
        if (discovery.acquisitions.length > plan.queries.length) {
          throw new ResearchCycleError(
            "RESEARCH_DISCOVERY_STATE_INVALID",
            "persisted discovery acquisition count exceeds the frozen portfolio",
          );
        }
        for (const raw of discovery.acquisitions) {
          if (!isRecord(raw)) {
            throw new ResearchCycleError(
              "RESEARCH_DISCOVERY_STATE_INVALID",
              "persisted discovery acquisition is not an object",
            );
          }
          const acquisition = raw as unknown as DiscoveryAcquisitionRecord;
          const frozenQuery = plan.queries.find(
            (entry) => entry.queryRef === acquisition.queryRef,
          );
          const startedAt = Date.parse(acquisition.startedAt);
          const completedAt = acquisition.completedAt === undefined
            ? undefined
            : Date.parse(acquisition.completedAt);
          const acquiredAt = acquisition.acquiredAt === undefined
            ? undefined
            : Date.parse(acquisition.acquiredAt);
          const frozenBindingInvalid = !frozenQuery
            || acquisition.lane !== frozenQuery.lane
            || acquisition.purpose !== frozenQuery.providerPurpose
            || acquisition.provider !== frozenQuery.provider
            || acquisition.operation !== frozenQuery.operation
            || acquisition.query !== frozenQuery.query
            || acquisition.maxResults !== frozenQuery.maxResults
            || acquisition.asOf !== plan.asOf
            || acquisition.revalidateBy !== plan.revalidateBy;
          const pendingShapeInvalid = acquisition.status === "pending"
            && (
              acquisition.completedAt !== undefined
              || acquisition.acquiredAt !== undefined
              || acquisition.providerEvidenceRef !== undefined
              || acquisition.providerTraceRef !== undefined
              || acquisition.providerTracePath !== undefined
              || acquisition.providerTraceFileSha256 !== undefined
              || acquisition.providerEvidencePath !== undefined
              || acquisition.providerEvidenceFileSha256 !== undefined
              || acquisition.failureCode !== undefined
              || acquisition.failureReason !== undefined
            );
          const acquiredShapeInvalid = acquisition.status === "acquired"
            && (
              completedAt === undefined
              || acquiredAt === undefined
              || !Number.isFinite(completedAt)
              || !Number.isFinite(acquiredAt)
              || completedAt !== acquiredAt
              || acquisition.failureCode !== undefined
              || acquisition.failureReason !== undefined
            );
          const failedShapeInvalid = acquisition.status === "failed"
            && (
              completedAt === undefined
              || !Number.isFinite(completedAt)
              || acquisition.acquiredAt !== undefined
              || acquisition.providerEvidenceRef !== undefined
              || acquisition.providerTraceRef !== undefined
              || acquisition.providerTracePath !== undefined
              || acquisition.providerTraceFileSha256 !== undefined
              || acquisition.providerEvidencePath !== undefined
              || acquisition.providerEvidenceFileSha256 !== undefined
              || typeof acquisition.failureCode !== "string"
              || acquisition.failureCode.trim() === ""
              || typeof acquisition.failureReason !== "string"
              || acquisition.failureReason.trim() === ""
            );
          if (
            acquisition.schemaVersion !== DISCOVERY_ACQUISITION_SCHEMA
            || acquisition.planRef !== plan.planRef
            || typeof acquisition.queryRef !== "string"
            || !queryRefs.has(acquisition.queryRef)
            || observedQueryRefs.has(acquisition.queryRef)
            || !["pending", "acquired", "failed"].includes(acquisition.status)
            || acquisition.attemptRef
              !== discoveryAttemptRef(plan.planRef, acquisition.queryRef)
            || acquisition.attemptOrdinal !== 1
            || acquisition.noRetryPerformed !== true
            || !Number.isFinite(startedAt)
            || (completedAt !== undefined && completedAt < startedAt)
            || frozenBindingInvalid
            || pendingShapeInvalid
            || acquiredShapeInvalid
            || failedShapeInvalid
          ) {
            throw new ResearchCycleError(
              "RESEARCH_DISCOVERY_STATE_INVALID",
              "persisted discovery acquisition is not bound to one frozen query attempt",
              { queryRef: acquisition.queryRef },
            );
          }
          observedQueryRefs.add(acquisition.queryRef);
          await verifyDiscoveryAcquisition(
            acquisition,
            String(value.open.evidenceDirectory),
          );
        }
        if (discovery.horizon !== undefined) {
          if (!isRecord(discovery.horizon)) {
            throw new ResearchCycleError(
              "RESEARCH_DISCOVERY_STATE_INVALID",
              "persisted horizon record is not an object",
            );
          }
          const horizon = discovery.horizon as unknown as HorizonRecord;
          if (
            horizon.schemaVersion !== HORIZON_SCHEMA
            || horizon.planRef !== plan.planRef
            || horizon.generation !== plan.generation
            || horizon.planDigestSha256 !== plan.planDigestSha256
            || horizon.policyDigestSha256 !== plan.policyDigestSha256
            || horizon.portfolioDigestSha256 !== plan.portfolioDigestSha256
            || !SHA256.test(horizon.inputDigestSha256)
            || !Array.isArray(horizon.events)
            || !Array.isArray(horizon.staleReasons)
            || !Array.isArray(horizon.evidenceIdentities)
            || horizon.events.length > MAX_DISCOVERY_OBSERVATIONS + 1
          ) {
            throw new ResearchCycleError(
              "RESEARCH_DISCOVERY_STATE_INVALID",
              "persisted horizon record does not match the active discovery plan",
            );
          }
          const expectedHorizonDigest = discoveryHorizonDigest(horizon);
          const expectedHorizonRef = discoveryHorizonRef(
            String(value.cycleRef),
            plan.generation,
            expectedHorizonDigest,
          );
          const eventRefs = horizon.events.map((entry) => entry.eventRef);
          const evidenceIdentityRefs = horizon.evidenceIdentities.map(
            (entry) => entry.evidenceRef,
          );
          const expectedRefresh =
            horizon.events.length > 0 || horizon.staleReasons.length > 0;
          if (
            horizon.inputDigestSha256 !== expectedHorizonDigest
            || horizon.horizonRef !== expectedHorizonRef
            || horizon.requiresResearchReflexRefresh !== expectedRefresh
            || !Number.isFinite(Date.parse(horizon.asOf))
            || !Number.isFinite(Date.parse(horizon.recordedAt))
            || Date.parse(horizon.asOf) < Date.parse(plan.asOf)
            || eventRefs.join("\0")
              !== [...new Set(eventRefs)].sort().join("\0")
            || evidenceIdentityRefs.join("\0")
              !== [...new Set(evidenceIdentityRefs)].sort().join("\0")
            || horizon.staleReasons.join("\0")
              !== [...new Set(horizon.staleReasons)].sort().join("\0")
          ) {
            throw new ResearchCycleError(
              "RESEARCH_DISCOVERY_STATE_INVALID",
              "persisted horizon digest, ordering, or derived refresh identity changed",
              { horizonRef: horizon.horizonRef },
            );
          }
          const acquisitionsByRef = new Map(
            (discovery.acquisitions as DiscoveryAcquisitionRecord[])
              .filter((entry) =>
                entry.status === "acquired"
                && typeof entry.providerEvidenceRef === "string")
              .map((entry) => [entry.providerEvidenceRef!, entry]),
          );
          const acquiredEvidenceRefs = [...acquisitionsByRef.keys()].sort();
          if (evidenceIdentityRefs.join("\0") !== acquiredEvidenceRefs.join("\0")) {
            throw new ResearchCycleError(
              "RESEARCH_DISCOVERY_STATE_INVALID",
              "persisted horizon does not bind the exact acquired evidence set",
              {
                horizonEvidenceRefs: evidenceIdentityRefs,
                acquiredEvidenceRefs,
              },
            );
          }
          for (const identity of horizon.evidenceIdentities) {
            const acquisition = acquisitionsByRef.get(identity.evidenceRef);
            if (
              !acquisition
              || acquisition.providerEvidenceFileSha256 !== identity.fileDigestSha256
              || acquisition.providerTraceRef !== identity.traceRef
              || acquisition.providerTraceFileSha256 !== identity.traceDigestSha256
            ) {
              throw new ResearchCycleError(
                "RESEARCH_DISCOVERY_STATE_INVALID",
                "persisted horizon evidence identity is detached from current acquisition state",
                { evidenceRef: identity.evidenceRef },
              );
            }
          }
          for (const event of horizon.events) {
            if (
              !isRecord(event)
              || typeof event.eventRef !== "string"
              || typeof event.kind !== "string"
              || typeof event.rationale !== "string"
              || event.rationale.trim() === ""
              || event.rationale.length > MAX_DISCOVERY_TEXT_CHARACTERS
              || !Array.isArray(event.evidenceRefs)
              || !Array.isArray(event.subjectRefs)
              || event.evidenceRefs.length > MAX_DISCOVERY_EVIDENCE_REFS_PER_OBSERVATION
              || event.subjectRefs.length > MAX_DISCOVERY_SUBJECT_REFS_PER_OBSERVATION
              || event.detectedAt !== horizon.asOf
              || event.evidenceRefs.some((ref) =>
                typeof ref !== "string" || !acquisitionsByRef.has(ref))
              || event.evidenceRefs.join("\0")
                !== [...new Set(event.evidenceRefs)].sort().join("\0")
              || event.subjectRefs.some((ref) =>
                typeof ref !== "string" || ref.trim() === "")
              || event.subjectRefs.join("\0")
                !== [...new Set(event.subjectRefs)].sort().join("\0")
            ) {
              throw new ResearchCycleError(
                "RESEARCH_DISCOVERY_STATE_INVALID",
                "persisted horizon event shape or evidence lineage is invalid",
                { eventRef: isRecord(event) ? event.eventRef : undefined },
              );
            }
            const expectedEventRef = event.kind === "current_source_expired"
              ? `${DISCOVERY_PORTFOLIO_PREFIX}:event:${canonicalDigest({
                  planRef: plan.planRef,
                  kind: "current_source_expired",
                  asOf: horizon.asOf,
                  revalidateBy: plan.revalidateBy,
                }).slice(0, 24)}`
              : `${DISCOVERY_PORTFOLIO_PREFIX}:event:${canonicalDigest({
                  planRef: plan.planRef,
                  asOf: horizon.asOf,
                  kind: event.kind,
                  evidenceRefs: event.evidenceRefs,
                  subjectRefs: event.subjectRefs,
                  rationale: event.rationale,
                }).slice(0, 24)}`;
            if (event.eventRef !== expectedEventRef) {
              throw new ResearchCycleError(
                "RESEARCH_DISCOVERY_STATE_INVALID",
                "persisted horizon event identity changed",
                { eventRef: event.eventRef, expectedEventRef },
              );
            }
          }
        }
      }
    }

    const closure = isRecord(value.closure) ? value.closure : undefined;
    if (
      closure
      && closure.episodeReceiptPath !== undefined
      && (
        typeof closure.episodeReceiptPath !== "string"
        || !pathInside(
          await realpathOrResolved(closure.episodeReceiptPath),
          cycleRoot,
        )
      )
    ) {
      throw new ResearchCycleError(
        "RESEARCH_CYCLE_STATE_PATH_UNSAFE",
        "persisted episode receipt path is outside its private cycle directory",
      );
    }
    return value as unknown as ResearchCycleState;
  }

  private async writeState(
    workspace: ResearchWorkspace,
    state: ResearchCycleState,
  ): Promise<void> {
    state.updatedAt = this.now().toISOString();
    await atomicWriteJson(this.statePath(workspace), state);
  }

  async open(
    workspace: ResearchWorkspace,
    input: ResearchCycleOpenInput,
  ): Promise<Record<string, unknown>> {
    this.assertManaged(workspace);
    return await this.withLock(workspace, async () => {
      const existing = await this.readState(workspace);
      if (
        existing
        && existing.phase !== "closed"
        && input.replaceExisting !== true
      ) {
        throw new ResearchCycleError(
          "RESEARCH_CYCLE_ALREADY_ACTIVE",
          "an unfinished research cycle already exists for this workspace",
          { cycleRef: existing.cycleRef, phase: existing.phase },
        );
      }
      if (input.replaceExisting && !input.replacementReason?.trim()) {
        throw new ResearchCycleError(
          "RESEARCH_CYCLE_REPLACEMENT_REASON_REQUIRED",
          "replacing an existing cycle requires an explicit reason",
        );
      }
      if (existing && input.replaceExisting === true) {
        await atomicWriteJson(
          resolve(
            this.cycleDirectory(workspace),
            "history",
            `${canonicalDigest(existing)}.json`,
          ),
          existing,
        );
      }
      const snapshot = await gitSnapshot(workspace.root);
      if (this.config.mode === "enforce" && snapshot.dirty) {
        throw new ResearchCycleError(
          "RESEARCH_CYCLE_OPEN_REQUIRES_CLEAN_BASELINE",
          "enforced research cycles must open before source mutation on a clean baseline",
        );
      }
      const candidatePathPrefixes = normalizePathPrefixes(
        input.candidatePathPrefixes,
      );
      if (candidatePathPrefixes.length === 0) {
        throw new ResearchCycleError(
          "RESEARCH_CYCLE_SCOPE_REQUIRED",
          "at least one candidate path prefix is required",
        );
      }
      const cycleRef = `zes-research-cycle:${canonicalDigest({
        workspace: resolve(workspace.root),
        taskRef: input.taskRef,
        materialDecisionRef: input.materialDecisionRef,
        openedAt: this.now().toISOString(),
        nonce: randomUUID(),
      })}`;
      const directory = this.cycleDirectory(workspace);
      const evidenceDirectory = resolve(directory, "evidence", cycleRef.split(":").at(-1)!);
      await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 });
      const open: ResearchOpenRecord = {
        ...input,
        taskRef: requiredString(input.taskRef, "taskRef"),
        materialDecisionRef: requiredString(
          input.materialDecisionRef,
          "materialDecisionRef",
        ),
        decisionBoundaryRef: requiredString(
          input.decisionBoundaryRef,
          "decisionBoundaryRef",
        ),
        decisionQuestion: requiredString(
          input.decisionQuestion,
          "decisionQuestion",
        ),
        candidatePathPrefixes,
        researchQuestions: uniqueStrings(
          input.researchQuestions,
          "researchQuestions",
        ),
        knownLocalEvidenceRefs: uniqueStrings(
          input.knownLocalEvidenceRefs,
          "knownLocalEvidenceRefs",
        ),
        uncertainties: uniqueStrings(input.uncertainties, "uncertainties"),
        falsifier: requiredString(input.falsifier, "falsifier"),
        reopenTrigger: requiredString(input.reopenTrigger, "reopenTrigger"),
        actorRef: requiredString(input.actorRef, "actorRef"),
        replacementReason: input.replacementReason?.trim(),
        schemaVersion: OPEN_SCHEMA,
        cycleRef,
        openedAt: this.now().toISOString(),
        baseline: snapshot,
        evidenceDirectory,
      };
      const state: ResearchCycleState = {
        schemaVersion: STATE_SCHEMA,
        workspaceId: workspace.workspaceId,
        workspaceRootDigestSha256: canonicalDigest(resolve(workspace.root)),
        cycleRef,
        phase: "opened",
        generation: 0,
        open,
        invalidations: [],
        observedPaths: [],
        dependencySensitivePaths: [],
        distinctFailureDigests: [],
        validationCommandDigests: [],
        updatedAt: this.now().toISOString(),
      };
      await this.writeState(workspace, state);
      return {
        cycleRef,
        phase: state.phase,
        baseline: publicSnapshot(snapshot),
        evidenceDirectory,
        policy: researchPolicy(this.config.mode),
      };
    });
  }

  async prepare(
    workspace: ResearchWorkspace,
    input: ResearchCyclePrepareInput,
  ): Promise<Record<string, unknown>> {
    this.assertManaged(workspace);
    return await this.withLock(workspace, async () => {
      const state = await this.requireState(workspace);
      if (
        !["opened", "held", "reassessment_required", "admitted"].includes(
          state.phase,
        )
      ) {
        throw new ResearchCycleError(
          "RESEARCH_CYCLE_PREPARE_PHASE_INVALID",
          `cannot prepare research scope from phase ${state.phase}`,
        );
      }
      const snapshot = await gitSnapshot(workspace.root);
      if (snapshot.head !== state.open.baseline.head) {
        throw new ResearchCycleError(
          "RESEARCH_CYCLE_HEAD_CHANGED",
          "Git HEAD changed after the cycle opened; reopen against current authority",
        );
      }
      const pathPrefixes = normalizePathPrefixes(input.pathPrefixes);
      if (pathPrefixes.length === 0) {
        throw new ResearchCycleError(
          "RESEARCH_CYCLE_SCOPE_REQUIRED",
          "at least one path prefix is required",
        );
      }
      if (
        pathPrefixes.includes(".")
        && !input.repositoryWideScopeReason?.trim()
      ) {
        throw new ResearchCycleError(
          "RESEARCH_CYCLE_REPOSITORY_WIDE_REASON_REQUIRED",
          "repository-wide research scope requires an explicit reason",
        );
      }
      const uncovered = state.observedPaths.filter(
        (path) => !pathPrefixes.some((prefix) => pathWithinPrefix(path, prefix)),
      );
      if (uncovered.length > 0) {
        throw new ResearchCycleError(
          "RESEARCH_CYCLE_EXISTING_PATH_OUTSIDE_SCOPE",
          "the reassessed scope does not cover already observed source changes",
          { uncovered },
        );
      }
      const operationClasses = uniqueStrings(
        input.operationClasses,
        "operationClasses",
      ) as ResearchOperationClass[];
      if (operationClasses.length === 0) {
        throw new ResearchCycleError(
          "RESEARCH_CYCLE_OPERATION_CLASS_REQUIRED",
          "at least one operation class is required",
        );
      }
      const evidenceRegimeRefs = uniqueStrings(
        input.evidenceRegimeRefs,
        "evidenceRegimeRefs",
      );
      const sourceIdentityRefs = uniqueStrings(
        input.sourceIdentityRefs,
        "sourceIdentityRefs",
      );
      const shellMutationCommandDigests = uniqueStrings(
        input.shellMutationCommandDigests ?? [],
        "shellMutationCommandDigests",
      );
      const invalidCommandDigests = shellMutationCommandDigests.filter(
        (digest) => !SHA256.test(digest),
      );
      if (invalidCommandDigests.length > 0) {
        throw new ResearchCycleError(
          "RESEARCH_CYCLE_COMMAND_DIGEST_INVALID",
          "shell mutation command digests must be lowercase SHA-256 values",
          { invalidCommandDigests },
        );
      }
      if (evidenceRegimeRefs.length === 0 || sourceIdentityRefs.length === 0) {
        throw new ResearchCycleError(
          "RESEARCH_CYCLE_EVIDENCE_IDENTITY_REQUIRED",
          "evidence regime and source identity refs are required",
        );
      }
      const decisionScopeDigestSha256 = canonicalDigest({
        schemaVersion: "devspace.zes-research-decision-scope.v1",
        taskRef: state.open.taskRef,
        materialDecisionRef: state.open.materialDecisionRef,
        decisionBoundaryRef: state.open.decisionBoundaryRef,
        decisionQuestion: state.open.decisionQuestion,
      });
      const evidenceRegimeDigestSha256 = canonicalDigest({
        schemaVersion: "devspace.zes-research-evidence-regime.v1",
        refs: evidenceRegimeRefs,
      });
      const sourceIdentityDigestSha256 = canonicalDigest({
        schemaVersion: "devspace.zes-research-source-identity.v1",
        refs: sourceIdentityRefs,
      });
      const implementationBoundaryDigestSha256 = canonicalDigest({
        schemaVersion: "devspace.zes-research-implementation-boundary.v1",
        repositoryIdentityDigestSha256:
          snapshot.repositoryIdentityDigestSha256,
        head: snapshot.head,
        sourceTree: snapshot.sourceTree,
        existingWorkingContentDigestSha256:
          snapshot.workingContentDigestSha256,
        pathPrefixes,
      });
      const actionScopeDigestSha256 = canonicalDigest({
        schemaVersion: "devspace.zes-research-action-scope.v1",
        taskRef: state.open.taskRef,
        materialDecisionRef: state.open.materialDecisionRef,
        decisionBoundaryRef: state.open.decisionBoundaryRef,
        implementationBoundaryDigestSha256,
        operationClasses,
        pathPrefixes,
        shellMutationCommandDigests,
      });
      const prepared: PreparedScopeRecord = {
        ...input,
        pathPrefixes,
        operationClasses,
        evidenceRegimeRefs,
        sourceIdentityRefs,
        shellMutationCommandDigests,
        repositoryWideScopeReason: input.repositoryWideScopeReason?.trim(),
        schemaVersion: PREPARED_SCHEMA,
        generation: state.generation + 1,
        preparedAt: this.now().toISOString(),
        snapshot,
        decisionScopeDigestSha256,
        evidenceRegimeDigestSha256,
        sourceIdentityDigestSha256,
        implementationBoundaryDigestSha256,
        actionScopeDigestSha256,
      };
      state.generation = prepared.generation;
      state.prepared = prepared;
      state.admission = undefined;
      state.discovery = undefined;
      state.preCommit = undefined;
      state.commit = undefined;
      state.closure = undefined;
      state.phase = "prepared";
      await this.writeState(workspace, state);
      return {
        cycleRef: state.cycleRef,
        phase: state.phase,
        generation: state.generation,
        requestBindings: {
          task_ref: state.open.taskRef,
          material_decision_ref: state.open.materialDecisionRef,
          decision_boundary_ref: state.open.decisionBoundaryRef,
          decision_question: state.open.decisionQuestion,
          decision_scope_digest_sha256: decisionScopeDigestSha256,
          evidence_regime_digest_sha256: evidenceRegimeDigestSha256,
          source_identity_digest_sha256: sourceIdentityDigestSha256,
          implementation_boundary_digest_sha256:
            implementationBoundaryDigestSha256,
          action_scope_digest_sha256: actionScopeDigestSha256,
          owner_seeded_framing: state.open.ownerSeededFraming,
          assessing_actor_ref: state.open.actorRef,
        },
        evidenceDirectory: state.open.evidenceDirectory,
        policy: researchPolicy(this.config.mode),
      };
    });
  }

  async discoveryPlan(
    workspace: ResearchWorkspace,
    input: ResearchDiscoveryPlanInput,
  ): Promise<DiscoveryPlanResult> {
    this.assertManaged(workspace);
    return await this.withLock(workspace, async () => {
      const state = await this.requireState(workspace);
      if (!state.prepared || state.phase !== "prepared") {
        throw new ResearchCycleError(
          "RESEARCH_DISCOVERY_PLAN_PHASE_INVALID",
          "discovery planning requires the active prepared research generation",
          { phase: state.phase },
        );
      }
      const subjectRef = boundedDiscoveryText(input.subjectRef, "subjectRef");
      const subjectQuestion = boundedDiscoveryText(
        input.subjectQuestion,
        "subjectQuestion",
      );
      const asOf = normalizedTimestamp(input.asOf, "discovery asOf");
      if (Date.parse(asOf) > this.now().getTime()) {
        throw new ResearchCycleError(
          "RESEARCH_DISCOVERY_INPUT_INVALID",
          "discovery asOf cannot be in the future",
          { asOf },
        );
      }
      const profile = input.discoveryProfile ?? "balanced_frontier";
      const coverageLanes = mergeCoverageDispositions(
        profile,
        input.explicitCoverageLanes,
      );
      const regime = parseRegimePolicy(input.temporalRegime);
      const derivedSince = shiftedTimestamp(asOf, -regime.lookbackDays);
      const revalidateBy = shiftedTimestamp(asOf, regime.revalidateByDays);
      const knownCandidateRefs = uniqueStrings(
        input.knownCandidateRefs ?? [],
        "knownCandidateRefs",
      ).map((entry) => boundedDiscoveryText(entry, "knownCandidateRef"));
      const incumbentRef = input.incumbentRef
        ? boundedDiscoveryText(input.incumbentRef, "incumbentRef")
        : undefined;
      const priorSnapshotRef = input.priorSnapshotRef
        ? boundedDiscoveryText(input.priorSnapshotRef, "priorSnapshotRef")
        : undefined;
      const policyDigestSha256 = discoveryPolicyDigest(input.temporalRegime);
      const queries = buildDiscoveryQueries(
        state.cycleRef,
        state.generation,
        coverageLanes,
        subjectQuestion,
        subjectRef,
        derivedSince,
        knownCandidateRefs,
        incumbentRef,
        priorSnapshotRef,
      );
      const portfolioDigestSha256 = discoveryPortfolioDigest({
        policyDigestSha256,
        temporalRegime: input.temporalRegime,
        asOf,
        derivedSince,
        revalidateBy,
        coverageLanes,
        queries,
      });
      const planRef = generateDiscoveryPlanRef(
        state.cycleRef,
        state.generation,
        portfolioDigestSha256,
      );
      const planWithoutDigestAndTime: Omit<
        DiscoveryPlanRecord,
        "planDigestSha256" | "requestedAt"
      > = {
        schemaVersion: DISCOVERY_PLAN_SCHEMA,
        planRef,
        policyDigestSha256,
        portfolioDigestSha256,
        subjectRef,
        subjectQuestion,
        discoveryProfile: profile,
        temporalRegime: input.temporalRegime,
        asOf,
        derivedSince,
        revalidateBy,
        lookbackDays: regime.lookbackDays,
        revalidateByDays: regime.revalidateByDays,
        knownCandidateRefs,
        incumbentRef,
        priorSnapshotRef,
        generation: state.generation,
        coverageLanes,
        queries,
        requestedBy: state.open.actorRef,
        sourceOriginNeutral: true,
        queryConstraintMode: DISCOVERY_QUERY_CONSTRAINT_MODE,
      };
      const plan: DiscoveryPlanRecord = {
        ...planWithoutDigestAndTime,
        planDigestSha256: canonicalDigest(
          discoveryPlanIdentity(planWithoutDigestAndTime),
        ),
        requestedAt: this.now().toISOString(),
      };
      const existingPlan = state.discovery?.plan;
      if (existingPlan?.planRef === plan.planRef) {
        assertDiscoveryPlanIntegrity(existingPlan, state.cycleRef);
        if (existingPlan.planDigestSha256 !== plan.planDigestSha256) {
          throw new ResearchCycleError(
            "RESEARCH_DISCOVERY_PLAN_IDENTITY_COLLISION",
            "identical discovery plan ref resolved to different typed inputs",
            { planRef },
          );
        }
        return publicDiscoveryPlan(
          existingPlan,
          state.discovery?.acquisitions ?? [],
        );
      }
      const invalidations = [...(state.discovery?.invalidations ?? [])];
      if (existingPlan) {
        invalidations.push({
          planRef: existingPlan.planRef,
          replacementPlanRef: plan.planRef,
          reasons: discoveryInvalidationReasons(existingPlan, plan),
          invalidatedAt: this.now().toISOString(),
        });
      }
      state.discovery = {
        invalidations: invalidations.slice(-32),
        requestedBy: state.open.actorRef,
        plan,
        acquisitions: [],
        horizon: undefined,
      };
      await this.writeState(workspace, state);
      return publicDiscoveryPlan(plan, []);
    });
  }

  async discoveryAcquire(
    workspace: ResearchWorkspace,
    input: ResearchDiscoveryAcquireInput,
    runner: ResearchProviderAcquisitionRunner,
  ): Promise<DiscoveryAcquireResult> {
    this.assertManaged(workspace);
    const selectedQueryRefs = await this.withLock(workspace, async () => {
      const state = await this.requireState(workspace);
      const plan = state.discovery?.plan;
      if (!plan || plan.planRef !== input.planRef) {
        throw new ResearchCycleError(
          "RESEARCH_DISCOVERY_PLAN_MISSING",
          "a matching discovery plan is required before acquisition",
          { planRef: input.planRef },
        );
      }
      if (state.phase !== "prepared") {
        throw new ResearchCycleError(
          "RESEARCH_DISCOVERY_ACQUIRE_PHASE_INVALID",
          "discovery acquisition requires prepared phase",
          { phase: state.phase },
        );
      }
      assertDiscoveryPlanIntegrity(plan, state.cycleRef);
      if (input.expectedGeneration !== undefined && input.expectedGeneration !== state.generation) {
        throw new ResearchCycleError(
          "RESEARCH_DISCOVERY_GENERATION_MISMATCH",
          "discovery acquisition was invoked against a different generation",
          {
            requestedGeneration: input.expectedGeneration,
            currentGeneration: state.generation,
          },
        );
      }
      if (!isDiscoveryPlanCurrent(plan, this.now().toISOString())) {
        throw new ResearchCycleError(
          "RESEARCH_DISCOVERY_PLAN_STALE",
          "discovery acquisition cannot use an expired or future plan",
          { planRef: plan.planRef },
        );
      }
      const requestedRefs = uniqueStrings(input.queryRefs ?? [], "discoveryQueryRefs");
      const selected = requestedRefs.length > 0
        ? requestedRefs
        : plan.queries
          .map((entry) => entry.queryRef);
      const unknown = selected.filter(
        (queryRef) => !plan.queries.some((query) => query.queryRef === queryRef),
      );
      if (unknown.length > 0) {
        throw new ResearchCycleError(
          "RESEARCH_DISCOVERY_QUERY_REF_UNKNOWN",
          "acquisition request referenced unknown discovery query refs",
          { unknown },
        );
      }
      return selected.sort();
    });

    for (const queryRef of selectedQueryRefs) {
      const reservation: DiscoveryAttemptReservation = await this.withLock(
        workspace,
        async () => {
          const state = await this.requireState(workspace);
          const plan = state.discovery?.plan;
          if (
            state.phase !== "prepared"
            || !plan
            || plan.planRef !== input.planRef
            || plan.generation !== state.generation
          ) {
            throw new ResearchCycleError(
              "RESEARCH_DISCOVERY_CONTEXT_CHANGED",
              "research cycle context changed before provider acquisition",
              { planRef: input.planRef },
            );
          }
          const query = plan.queries.find((entry) => entry.queryRef === queryRef);
          if (!query) {
            throw new ResearchCycleError(
              "RESEARCH_DISCOVERY_QUERY_REF_UNKNOWN",
              "frozen discovery query disappeared before acquisition",
              { queryRef },
            );
          }
          const existing = state.discovery!.acquisitions.find(
            (entry) => entry.queryRef === queryRef,
          );
          if (existing) return { kind: "existing", acquisition: existing };
          const startedAt = this.now().toISOString();
          const attemptRef = discoveryAttemptRef(plan.planRef, queryRef);
          const pending: DiscoveryAcquisitionRecord = {
            schemaVersion: DISCOVERY_ACQUISITION_SCHEMA,
            queryRef,
            planRef: plan.planRef,
            lane: query.lane,
            status: "pending",
            attemptRef,
            attemptOrdinal: 1,
            purpose: query.providerPurpose,
            provider: query.provider,
            operation: query.operation,
            query: query.query,
            maxResults: query.maxResults,
            asOf: plan.asOf,
            revalidateBy: plan.revalidateBy,
            startedAt,
            noRetryPerformed: true,
          };
          state.discovery!.acquisitions.push(pending);
          state.discovery!.horizon = undefined;
          await this.writeState(workspace, state);
          return {
            kind: "reserved",
            context: {
              cycleRef: state.cycleRef,
              generation: state.generation,
              planRef: plan.planRef,
              planDigestSha256: plan.planDigestSha256,
              query: structuredClone(query),
              attemptRef,
              evidenceDirectory: state.open.evidenceDirectory,
              ownerSeededFraming: state.open.ownerSeededFraming,
            },
          };
        },
      );

      if (reservation.kind === "existing") {
        if (reservation.acquisition.status !== "acquired") break;
        continue;
      }

      let acquired: ResearchProviderAcquisitionResult | undefined;
      let failure: unknown;
      try {
        acquired = await runner(
          workspace,
          reservation.context.query.providerPurpose,
          {
            provider: "exa",
            operation: "search",
            query: reservation.context.query.query,
            maxResults: reservation.context.query.maxResults,
          },
        );
        await validateDiscoveryRunnerResult(
          acquired,
          reservation.context.query,
          reservation.context.ownerSeededFraming,
          reservation.context.evidenceDirectory,
        );
      } catch (error) {
        failure = error;
      }

      await this.withLock(workspace, async () => {
        const state = await this.requireState(workspace);
        const plan = state.discovery?.plan;
        if (
          state.phase !== "prepared"
          || !plan
          || plan.planRef !== reservation.context.planRef
          || plan.planDigestSha256 !== reservation.context.planDigestSha256
          || state.generation !== reservation.context.generation
        ) {
          throw new ResearchCycleError(
            "RESEARCH_DISCOVERY_CONTEXT_CHANGED",
            "research cycle context changed during provider acquisition",
            { planRef: reservation.context.planRef },
          );
        }
        const index = state.discovery!.acquisitions.findIndex((entry) =>
          entry.queryRef === reservation.context.query.queryRef
          && entry.attemptRef === reservation.context.attemptRef
          && entry.status === "pending");
        if (index < 0) {
          throw new ResearchCycleError(
            "RESEARCH_DISCOVERY_ATTEMPT_IDENTITY_CHANGED",
            "pending discovery attempt identity changed before completion",
            { attemptRef: reservation.context.attemptRef },
          );
        }
        const pending = state.discovery!.acquisitions[index]!;
        const completedAt = this.now().toISOString();
        state.discovery!.acquisitions[index] = failure || !acquired
          ? {
              ...pending,
              status: "failed",
              completedAt,
              failureCode: failure instanceof ResearchCycleError
                ? failure.code
                : "RESEARCH_DISCOVERY_ACQUISITION_FAILED",
              failureReason: (failure instanceof Error
                ? failure.message
                : String(failure ?? "provider acquisition produced no result"))
                .slice(0, 4_000),
            }
          : {
              ...pending,
              status: "acquired",
              completedAt,
              acquiredAt: completedAt,
              providerEvidenceRef: acquired.providerEvidenceRef,
              providerTraceRef: acquired.providerTraceRef,
              providerTracePath: resolve(acquired.providerTracePath),
              providerTraceFileSha256: acquired.providerTraceFileSha256,
              providerEvidencePath: resolve(acquired.providerEvidencePath),
              providerEvidenceFileSha256: acquired.providerEvidenceFileSha256,
            };
        await this.writeState(workspace, state);
      });
      if (failure || !acquired) break;
    }

    return await this.withLock(workspace, async () => {
      const state = await this.requireState(workspace);
      const plan = state.discovery?.plan;
      if (!plan || plan.planRef !== input.planRef) {
        throw new ResearchCycleError(
          "RESEARCH_DISCOVERY_CONTEXT_CHANGED",
          "discovery plan changed before acquisition summary",
          { planRef: input.planRef },
        );
      }
      const order = new Map(plan.queries.map((entry, index) => [entry.queryRef, index]));
      const acquisitions = [...state.discovery!.acquisitions]
        .filter((entry) => entry.planRef === plan.planRef)
        .sort((left, right) =>
          (order.get(left.queryRef) ?? 0) - (order.get(right.queryRef) ?? 0));
      const coverage = mergeDiscoveryCoverage(plan, acquisitions);
      const acquiredCount = acquisitions.filter((entry) => entry.status === "acquired").length;
      const failedCount = acquisitions.filter((entry) => entry.status === "failed").length;
      const pendingCount = acquisitions.filter((entry) => entry.status === "pending").length;
      const unresolvedCount = plan.queries.length - acquisitions.length;
      const allCovered = acquiredCount === plan.queries.length;
      const status: DiscoveryAcquireResult["status"] = allCovered
        ? "acquired"
        : failedCount > 0 || pendingCount > 0
          ? "held"
          : "partial";
      return {
        planRef: plan.planRef,
        generation: state.generation,
        asOf: plan.asOf,
        portfolioDigestSha256: plan.portfolioDigestSha256,
        status,
        requiredCovered: discoveryRequiredCovered(coverage),
        coveredQueries: acquiredCount,
        partialQueries: failedCount + pendingCount,
        unresolvedQueries: unresolvedCount,
        acquisitions,
        coverage,
        policyDigest: plan.policyDigestSha256,
      };
    });
  }

  async horizonRecord(
    workspace: ResearchWorkspace,
    input: ResearchHorizonInput,
  ): Promise<DiscoveryHorizonResult> {
    this.assertManaged(workspace);
    return await this.withLock(workspace, async () => {
      const state = await this.requireState(workspace);
      const plan = state.discovery?.plan;
      if (!state.prepared || state.phase !== "prepared" || !plan) {
        throw new ResearchCycleError(
          "RESEARCH_DISCOVERY_HORIZON_CONTEXT_INVALID",
          "horizon record requires the active prepared discovery generation",
          { statePhase: state.phase },
        );
      }
      if (input.planRef !== plan.planRef) {
        throw new ResearchCycleError(
          "RESEARCH_DISCOVERY_PLAN_MISSING",
          "horizon input does not match the active discovery plan",
          { requestedPlanRef: input.planRef, activePlanRef: plan.planRef },
        );
      }
      if (
        input.expectedGeneration !== undefined
        && input.expectedGeneration !== state.generation
      ) {
        throw new ResearchCycleError(
          "RESEARCH_DISCOVERY_GENERATION_MISMATCH",
          "horizon input targets a different research generation",
          { requestedGeneration: input.expectedGeneration, currentGeneration: state.generation },
        );
      }
      assertDiscoveryPlanIntegrity(plan, state.cycleRef);
      const asOf = normalizedTimestamp(input.asOf, "horizon asOf");
      if (Date.parse(asOf) > this.now().getTime()) {
        throw new ResearchCycleError(
          "RESEARCH_DISCOVERY_INPUT_INVALID",
          "horizon asOf cannot be in the future",
          { asOf },
        );
      }
      if (Date.parse(asOf) < Date.parse(plan.asOf)) {
        throw new ResearchCycleError(
          "RESEARCH_DISCOVERY_INPUT_INVALID",
          "horizon asOf cannot precede the discovery plan asOf",
          { asOf, planAsOf: plan.asOf },
        );
      }
      const acquisitions = state.discovery!.acquisitions
        .filter((entry) => entry.planRef === plan.planRef);
      const coverage = mergeDiscoveryCoverage(plan, acquisitions);
      if (!discoveryRequiredCovered(coverage)) {
        throw new ResearchCycleError(
          "RESEARCH_DISCOVERY_COVERAGE_INCOMPLETE",
          "horizon recording requires complete required-lane coverage",
          { coverage },
        );
      }
      for (const acquisition of acquisitions) {
        await verifyDiscoveryAcquisition(acquisition, state.open.evidenceDirectory);
      }
      const acquiredByRef = new Map(
        acquisitions
          .filter((entry) => entry.status === "acquired" && entry.providerEvidenceRef)
          .map((entry) => [entry.providerEvidenceRef!, entry]),
      );
      const priorSnapshot = normalizePriorDiscoverySnapshot(input.priorSnapshot);
      const observations = normalizeHorizonObservations(input.observations);
      const events: HorizonEventRecord[] = [];
      for (const observation of observations) {
        const missing = observation.evidenceRefs.filter((ref) => !acquiredByRef.has(ref));
        if (missing.length > 0) {
          throw new ResearchCycleError(
            "RESEARCH_DISCOVERY_EVIDENCE_NOT_CURRENT",
            "horizon observation references evidence outside the active plan",
            { kind: observation.kind, missing },
          );
        }
        const lanes = new Set(
          observation.evidenceRefs.map((ref) => acquiredByRef.get(ref)!.lane),
        );
        if (
          observation.kind === "community_failure_cluster_detected"
          && !lanes.has("failure_reproduction_or_maintainer_discussion")
        ) {
          throw new ResearchCycleError(
            "RESEARCH_DISCOVERY_HORIZON_SIGNAL_INVALID",
            "community failure signal requires evidence from the frozen failure/maintainer lane",
          );
        }
        if (
          observation.kind === "new_reproduction_or_counterevidence"
          && !lanes.has("failure_reproduction_or_maintainer_discussion")
          && !lanes.has("counterevidence_or_falsifier")
        ) {
          throw new ResearchCycleError(
            "RESEARCH_DISCOVERY_HORIZON_SIGNAL_INVALID",
            "reproduction/counterevidence signal requires evidence from a matching frozen lane",
          );
        }
        if (
          observation.kind === "new_candidate_detected"
          && (
            observation.subjectRefs.length < 1
            || observation.subjectRefs.every((ref) => plan.knownCandidateRefs.includes(ref))
          )
        ) {
          throw new ResearchCycleError(
            "RESEARCH_DISCOVERY_HORIZON_SIGNAL_INVALID",
            "new-candidate signal requires at least one candidate ref absent from the planning baseline",
          );
        }
        if (
          observation.kind === "prior_selection_superseded_candidate"
          && (!priorSnapshot || observation.subjectRefs.length < 1)
        ) {
          throw new ResearchCycleError(
            "RESEARCH_DISCOVERY_HORIZON_SIGNAL_INVALID",
            "superseded-selection signal requires a typed prior snapshot and successor refs",
          );
        }
        if (
          observation.kind === "upstream_semantics_changed"
          && observation.subjectRefs.length < 1
        ) {
          throw new ResearchCycleError(
            "RESEARCH_DISCOVERY_HORIZON_SIGNAL_INVALID",
            "upstream-semantic change requires exact changed subject refs",
          );
        }
        const eventIdentity = {
          planRef: plan.planRef,
          asOf,
          ...observation,
        };
        events.push({
          eventRef: `${DISCOVERY_PORTFOLIO_PREFIX}:event:${canonicalDigest(eventIdentity).slice(0, 24)}`,
          kind: observation.kind,
          rationale: observation.rationale,
          evidenceRefs: observation.evidenceRefs,
          subjectRefs: observation.subjectRefs,
          detectedAt: asOf,
        });
      }
      const staleReasons: string[] = [];
      const currentEvidenceRefs = [...acquiredByRef.keys()].sort();
      if (Date.parse(asOf) > Date.parse(plan.revalidateBy)) {
        staleReasons.push("current_source_expired");
        events.push({
          eventRef: `${DISCOVERY_PORTFOLIO_PREFIX}:event:${canonicalDigest({
            planRef: plan.planRef,
            kind: "current_source_expired",
            asOf,
            revalidateBy: plan.revalidateBy,
          }).slice(0, 24)}`,
          kind: "current_source_expired",
          rationale:
            "the regime-aware currentness interval ended; evidence requires revalidation but is not declared false",
          evidenceRefs: currentEvidenceRefs,
          subjectRefs: [plan.subjectRef],
          detectedAt: asOf,
        });
      }
      if (
        priorSnapshot
        && priorSnapshot.portfolioDigestSha256 !== plan.portfolioDigestSha256
      ) staleReasons.push("prior_portfolio_digest_differs");
      if (priorSnapshot?.evidenceIdentities.length) {
        const currentDigests = new Map(
          acquisitions
            .filter((entry) => entry.status === "acquired" && entry.providerEvidenceRef)
            .map((entry) => [entry.providerEvidenceRef!, entry.providerEvidenceFileSha256]),
        );
        if (priorSnapshot.evidenceIdentities.some((entry) =>
          currentDigests.get(entry.evidenceRef) !== entry.fileDigestSha256)) {
          staleReasons.push("prior_evidence_identity_differs");
        }
      }
      const evidenceIdentities = acquisitions
        .filter((entry) => entry.status === "acquired")
        .map((entry) => ({
          evidenceRef: entry.providerEvidenceRef!,
          fileDigestSha256: entry.providerEvidenceFileSha256!,
          traceRef: entry.providerTraceRef!,
          traceDigestSha256: entry.providerTraceFileSha256!,
        }))
        .sort((left, right) => left.evidenceRef.localeCompare(right.evidenceRef));
      events.sort((left, right) => left.eventRef.localeCompare(right.eventRef));
      const normalizedStaleReasons = [...new Set(staleReasons)].sort();
      const requiresResearchReflexRefresh =
        events.length > 0 || normalizedStaleReasons.length > 0;
      const inputDigestSha256 = discoveryHorizonDigest({
        planRef: plan.planRef,
        asOf,
        policyDigestSha256: plan.policyDigestSha256,
        planDigestSha256: plan.planDigestSha256,
        portfolioDigestSha256: plan.portfolioDigestSha256,
        priorSnapshot,
        evidenceIdentities,
        generation: state.generation,
        events,
        staleReasons: normalizedStaleReasons,
        requiresResearchReflexRefresh,
      });
      const existing = state.discovery!.horizon;
      if (existing?.inputDigestSha256 === inputDigestSha256) {
        return {
          horizonRef: existing.horizonRef,
          planRef: existing.planRef,
          generation: existing.generation,
          asOf: existing.asOf,
          policyDigest: existing.policyDigestSha256,
          portfolioDigestSha256: existing.portfolioDigestSha256,
          events: existing.events,
          priorSnapshot: existing.priorSnapshot,
          recordedAt: existing.recordedAt,
          staleReasons: existing.staleReasons,
          requiresResearchReflexRefresh: existing.requiresResearchReflexRefresh,
        };
      }
      const recordedAt = this.now().toISOString();
      const horizonRef = discoveryHorizonRef(
        state.cycleRef,
        state.generation,
        inputDigestSha256,
      );
      const horizon: HorizonRecord = {
        schemaVersion: HORIZON_SCHEMA,
        horizonRef,
        planRef: plan.planRef,
        asOf,
        policyDigestSha256: plan.policyDigestSha256,
        planDigestSha256: plan.planDigestSha256,
        portfolioDigestSha256: plan.portfolioDigestSha256,
        priorSnapshot,
        evidenceIdentities,
        recordedAt,
        generation: state.generation,
        events,
        staleReasons: normalizedStaleReasons,
        requiresResearchReflexRefresh,
        inputDigestSha256,
      };
      state.discovery!.horizon = horizon;
      await this.writeState(workspace, state);
      return {
        horizonRef,
        planRef: plan.planRef,
        generation: state.generation,
        asOf,
        policyDigest: horizon.policyDigestSha256,
        portfolioDigestSha256: horizon.portfolioDigestSha256,
        events,
        priorSnapshot,
        recordedAt,
        staleReasons: horizon.staleReasons,
        requiresResearchReflexRefresh: horizon.requiresResearchReflexRefresh,
      };
    });
  }

  async horizonStatus(
    workspace: ResearchWorkspace,
  ): Promise<Record<string, unknown>> {
    this.assertManaged(workspace);
    return await this.withLock(workspace, async () => {
      const state = await this.requireState(workspace);
      const horizon = state.discovery?.horizon;
      if (!horizon) {
        return {
          cycleRef: state.cycleRef,
          phase: state.phase,
          generation: state.generation,
          status: "missing",
          policy: researchPolicy(this.config.mode),
        };
      }
      const dynamicStaleReasons = [...horizon.staleReasons];
      if (
        state.discovery?.plan
        && this.now().getTime() > Date.parse(state.discovery.plan.revalidateBy)
        && !dynamicStaleReasons.includes("current_source_expired")
      ) dynamicStaleReasons.push("current_source_expired");
      return {
        cycleRef: state.cycleRef,
        phase: state.phase,
        generation: state.generation,
        status: dynamicStaleReasons.length > 0 ? "stale" : "complete",
        asOf: horizon.asOf,
        planRef: horizon.planRef,
        horizonRef: horizon.horizonRef,
        portfolioDigestSha256: horizon.portfolioDigestSha256,
        events: horizon.events,
        staleReasons: dynamicStaleReasons.sort(),
        requiresResearchReflexRefresh:
          horizon.requiresResearchReflexRefresh || dynamicStaleReasons.length > 0,
        policyDigest: horizon.policyDigestSha256,
        recordedAt: horizon.recordedAt,
        policy: researchPolicy(this.config.mode),
      };
    });
  }

  async assess(
    workspace: ResearchWorkspace,
    request: Record<string, unknown>,
    providerTraces: ResearchProviderTraceInput[] = [],
    discoveryEvidenceRefs: string[] = [],
  ): Promise<Record<string, unknown>> {
    this.assertManaged(workspace);
    return await this.withLock(workspace, async () => {
      const state = await this.requireState(workspace);
      const prepared = state.prepared;
      if (!prepared || state.phase !== "prepared") {
        throw new ResearchCycleError(
          "RESEARCH_CYCLE_SCOPE_NOT_PREPARED",
          "prepare the exact research scope before native assessment",
        );
      }
      this.assertRequestBindings(state, request);
      const evaluatedAt = this.now().toISOString();
      const discoveryVerification = state.discovery?.plan
        ? await verifyDiscoveryState(
            state,
            evaluatedAt,
            discoveryEvidenceRefs.length > 0
              ? discoveryEvidenceRefs
              : undefined,
          )
        : undefined;
      if (discoveryVerification) {
        const requestEvidenceRefs = requestProviderEvidenceRefs(request);
        const missingFromRequest = discoveryVerification.evidenceRefs.filter(
          (entry) => !requestEvidenceRefs.includes(entry),
        );
        if (missingFromRequest.length > 0) {
          throw new ResearchCycleError(
            "RESEARCH_DISCOVERY_EVIDENCE_NOT_REFERENCED",
            "the native Research Reflex request does not reference every frozen-plan discovery evidence record",
            { missingFromRequest },
          );
        }
      } else if (discoveryEvidenceRefs.length > 0) {
        throw new ResearchCycleError(
          "RESEARCH_DISCOVERY_EVIDENCE_NOT_CURRENT",
          "discovery evidence refs were supplied without an active discovery plan",
          { discoveryEvidenceRefs },
        );
      }
      const traceRecords = await this.resolveProviderTraces(
        workspace,
        state,
        mergeProviderTraceInputs(
          providerTraces,
          discoveryVerification?.providerTraces ?? [],
        ),
      );
      const directory = this.cycleDirectory(workspace);
      const requestPath = resolve(
        directory,
        `admission-request-g${state.generation}.json`,
      );
      const receiptPath = resolve(
        directory,
        `admission-receipt-g${state.generation}.json`,
      );
      await atomicWriteJson(requestPath, request);
      const result = await this.invokeNative(
        "assess",
        [
          "--request",
          requestPath,
          "--output",
          receiptPath,
          "--evaluated-at",
          evaluatedAt,
          ...this.traceArgs(workspace, state, traceRecords),
        ],
      );
      if (result.exitCode !== 0) {
        state.phase = "held";
        state.admission = undefined;
        await this.writeState(workspace, state);
        throw new ResearchCycleError(
          "RESEARCH_CYCLE_NATIVE_ASSESS_FAILED",
          `ZES Research Reflex assessment failed with exit ${result.exitCode}`,
          processFailureEvidence(result),
        );
      }
      const summary = parseJsonObject(result.stdout, "Research Reflex summary");
      const receiptBytes = await readFile(receiptPath);
      const receipt = parseJsonObject(
        receiptBytes.toString("utf8"),
        "Research Reflex admission receipt",
      );
      this.assertAdmissionReceipt(state, receipt, summary);
      const admitted = summary.commit_admitted === true;
      const lease = isRecord(receipt.admission_lease)
        ? receipt.admission_lease
        : undefined;
      const admission: AdmissionRecord = {
        state: String(summary.admission_state ?? "unknown"),
        admitted,
        requestDigestSha256: String(summary.request_digest_sha256 ?? ""),
        receiptRef:
          typeof summary.receipt_ref === "string"
            ? summary.receipt_ref
            : undefined,
        receiptDigestSha256:
          typeof summary.receipt_digest_sha256 === "string"
            ? summary.receipt_digest_sha256
            : undefined,
        receiptFileSha256: createHash("sha256").update(receiptBytes).digest("hex"),
        receiptPath,
        validUntil:
          typeof lease?.valid_until === "string"
            ? lease.valid_until
            : undefined,
        providerTraces: traceRecords,
        evaluatedAt,
        causalReason:
          typeof receipt.causal_reason === "string"
            ? receipt.causal_reason
            : undefined,
      };
      state.admission = admission;
      state.phase = admitted ? "admitted" : "held";
      state.invalidations = [];
      state.distinctFailureDigests = [];
      await this.writeState(workspace, state);
      return {
        cycleRef: state.cycleRef,
        phase: state.phase,
        generation: state.generation,
        admission: publicAdmission(admission),
        nativeSummary: summary,
        discoveryEvidenceVerification: discoveryVerification
          ? {
              planRef: discoveryVerification.plan.planRef,
              planDigestSha256:
                discoveryVerification.plan.planDigestSha256,
              portfolioDigestSha256:
                discoveryVerification.plan.portfolioDigestSha256,
              policyDigestSha256:
                discoveryVerification.plan.policyDigestSha256,
              evidenceRefs: discoveryVerification.evidenceRefs,
              coverage: discoveryVerification.coverage,
              horizonRef: state.discovery?.horizon?.horizonRef,
            }
          : undefined,
        policy: researchPolicy(this.config.mode),
      };
    });
  }

  async invalidate(
    workspace: ResearchWorkspace,
    kind: ResearchInvalidationKind,
    reason: string,
    evidenceRefs: string[] = [],
  ): Promise<Record<string, unknown>> {
    this.assertManaged(workspace);
    return await this.withLock(workspace, async () => {
      const state = await this.requireState(workspace);
      if (state.phase === "closed") {
        throw new ResearchCycleError(
          "RESEARCH_CYCLE_ALREADY_CLOSED",
          "a closed research cycle cannot be invalidated",
        );
      }
      state.invalidations.push({
        kind,
        reason: requiredString(reason, "invalidation reason"),
        evidenceRefs: uniqueStrings(evidenceRefs, "evidenceRefs"),
        recordedAt: this.now().toISOString(),
      });
      state.phase = "reassessment_required";
      state.preCommit = undefined;
      state.commit = undefined;
      await this.writeState(workspace, state);
      return this.publicStatus(state, true);
    });
  }

  async verifyPreCommit(
    workspace: ResearchWorkspace,
    validationRefs: string[],
    challenge: ResearchPreCommitChallenge,
  ): Promise<Record<string, unknown>> {
    this.assertManaged(workspace);
    return await this.withLock(workspace, async () => {
      const state = await this.requireState(workspace);
      if (state.phase !== "admitted") {
        throw new ResearchCycleError(
          "RESEARCH_CYCLE_NOT_ADMITTED",
          `pre-commit verification requires admitted phase, found ${state.phase}`,
        );
      }
      await this.verifyNativeAdmission(workspace, state);
      const discoveryVerification = state.discovery?.plan
        ? await verifyDiscoveryState(
            state,
            this.now().toISOString(),
            undefined,
          )
        : undefined;
      const horizon = state.discovery?.horizon;
      if (
        discoveryVerification
        && horizon?.requiresResearchReflexRefresh
        && Date.parse(state.admission!.evaluatedAt) < Date.parse(horizon.recordedAt)
      ) {
        throw new ResearchCycleError(
          "RESEARCH_DISCOVERY_REASSESSMENT_REQUIRED",
          "the current horizon signal was recorded after the native Research Reflex admission",
          {
            admissionEvaluatedAt: state.admission!.evaluatedAt,
            horizonRecordedAt: horizon.recordedAt,
          },
        );
      }
      if (!challenge.localAuthorityRechecked) {
        throw new ResearchCycleError(
          "RESEARCH_CYCLE_LOCAL_AUTHORITY_NOT_RECHECKED",
          "pre-commit challenge must re-read current local authority",
        );
      }
      if (
        state.admission?.state !== "admitted_no_search"
        && !challenge.externalCurrentnessRechecked
      ) {
        throw new ResearchCycleError(
          "RESEARCH_CYCLE_EXTERNAL_CURRENTNESS_NOT_RECHECKED",
          "fresh or reused external research must be rechecked before commit",
        );
      }
      if (
        state.dependencySensitivePaths.length > 0
        && !challenge.dependencyCurrentnessRechecked
      ) {
        throw new ResearchCycleError(
          "RESEARCH_CYCLE_DEPENDENCY_CURRENTNESS_NOT_RECHECKED",
          "dependency-sensitive changes require a currentness recheck",
          { paths: state.dependencySensitivePaths },
        );
      }
      requiredString(challenge.stoppingReason, "stoppingReason");
      const normalizedValidationRefs = uniqueStrings(
        validationRefs,
        "validationRefs",
      );
      if (normalizedValidationRefs.length === 0) {
        throw new ResearchCycleError(
          "RESEARCH_CYCLE_VALIDATION_REQUIRED",
          "pre-commit verification requires exact validation refs",
        );
      }
      const snapshot = await gitSnapshot(workspace.root);
      if (snapshot.head !== state.prepared?.snapshot.head) {
        throw new ResearchCycleError(
          "RESEARCH_CYCLE_HEAD_CHANGED",
          "Git HEAD changed before pre-commit verification",
        );
      }
      const preCommit: PreCommitRecord = {
        verifiedAt: this.now().toISOString(),
        workingContentDigestSha256: snapshot.workingContentDigestSha256,
        validationRefs: normalizedValidationRefs,
        challenge: {
          ...challenge,
          assumptionsRechecked: uniqueStrings(
            challenge.assumptionsRechecked,
            "assumptionsRechecked",
          ),
          counterevidenceOrLimitations: uniqueStrings(
            challenge.counterevidenceOrLimitations,
            "counterevidenceOrLimitations",
          ),
          unresolved: uniqueStrings(challenge.unresolved, "unresolved"),
          stoppingReason: challenge.stoppingReason.trim(),
        },
      };
      state.preCommit = preCommit;
      state.phase = "pre_commit_verified";
      await this.writeState(workspace, state);
      return {
        cycleRef: state.cycleRef,
        phase: state.phase,
        workingContentDigestSha256: preCommit.workingContentDigestSha256,
        admission: publicAdmission(state.admission!),
        discoveryEvidenceVerification: discoveryVerification
          ? {
              planRef: discoveryVerification.plan.planRef,
              planDigestSha256:
                discoveryVerification.plan.planDigestSha256,
              portfolioDigestSha256:
                discoveryVerification.plan.portfolioDigestSha256,
              policyDigestSha256:
                discoveryVerification.plan.policyDigestSha256,
              evidenceRefs: discoveryVerification.evidenceRefs,
              coverage: discoveryVerification.coverage,
              horizonRef: horizon?.horizonRef,
            }
          : undefined,
        policy: researchPolicy(this.config.mode),
      };
    });
  }

  async close(
    workspace: ResearchWorkspace,
    input: {
      outcome: ClosureRecord["outcome"];
      reason: string;
      decisionDelta: string;
      reusableFindings: string[];
      reversalConditions: string[];
      episodePacket?: Record<string, unknown>;
    },
  ): Promise<Record<string, unknown>> {
    this.assertManaged(workspace);
    return await this.withLock(workspace, async () => {
      const state = await this.requireState(workspace);
      if (state.phase === "closed") return this.publicStatus(state, true);
      const snapshot = await gitSnapshot(workspace.root);
      if (input.outcome === "committed" && state.phase !== "committed") {
        throw new ResearchCycleError(
          "RESEARCH_CYCLE_COMMIT_NOT_OBSERVED",
          "committed closure requires an observed successful exact commit",
        );
      }
      if (
        input.outcome === "no_change"
        && snapshot.workingContentDigestSha256
          !== state.open.baseline.workingContentDigestSha256
      ) {
        throw new ResearchCycleError(
          "RESEARCH_CYCLE_NO_CHANGE_DIRTY",
          "no_change closure cannot retain uncommitted source differences",
        );
      }
      const requiresEpisode = state.admission?.state !== "admitted_no_search"
        && state.admission?.admitted === true;
      if (requiresEpisode && !input.episodePacket) {
        throw new ResearchCycleError(
          "RESEARCH_CYCLE_EPISODE_REQUIRED",
          "fresh or reused research must close with a native Research Reflex episode packet",
        );
      }
      let episodeSummary: Record<string, unknown> | undefined;
      let episodeReceiptPath: string | undefined;
      let episodeReceiptFileSha256: string | undefined;
      if (input.episodePacket) {
        this.assertEpisodePacket(state, input.episodePacket);
        const directory = this.cycleDirectory(workspace);
        const packetPath = resolve(
          directory,
          `episode-packet-g${state.generation}.json`,
        );
        episodeReceiptPath = resolve(
          directory,
          `episode-receipt-g${state.generation}.json`,
        );
        await atomicWriteJson(packetPath, input.episodePacket);
        const result = await this.invokeNative(
          "compile",
          [
            "--request",
            packetPath,
            "--output",
            episodeReceiptPath,
            "--compiled-at",
            this.now().toISOString(),
          ],
        );
        if (result.exitCode !== 0) {
          throw new ResearchCycleError(
            "RESEARCH_CYCLE_EPISODE_COMPILE_FAILED",
            `Research Reflex episode compile failed with exit ${result.exitCode}`,
            processFailureEvidence(result),
          );
        }
        episodeSummary = parseJsonObject(
          result.stdout,
          "Research Reflex episode summary",
        );
        episodeReceiptFileSha256 = await sha256File(episodeReceiptPath);
      }
      const closure: ClosureRecord = {
        outcome: input.outcome,
        reason: requiredString(input.reason, "closure reason"),
        decisionDelta: requiredString(input.decisionDelta, "decisionDelta"),
        reusableFindings: uniqueStrings(
          input.reusableFindings,
          "reusableFindings",
        ),
        reversalConditions: uniqueStrings(
          input.reversalConditions,
          "reversalConditions",
        ),
        closedAt: this.now().toISOString(),
        closedHead: snapshot.head,
        episodeReceiptRef:
          typeof episodeSummary?.episode_ref === "string"
            ? episodeSummary.episode_ref
            : undefined,
        episodeReceiptDigestSha256:
          typeof episodeSummary?.episode_digest_sha256 === "string"
            ? episodeSummary.episode_digest_sha256
            : undefined,
        episodeReceiptFileSha256,
        episodeReceiptPath,
      };
      state.closure = closure;
      state.phase = "closed";
      await this.writeState(workspace, state);
      return {
        ...this.publicStatus(state, true),
        episodeSummary,
      };
    });
  }

  async status(workspace: ResearchWorkspace): Promise<Record<string, unknown>> {
    if (!this.manages(workspace)) {
      return {
        managed: false,
        mode: this.config.mode,
        reason: this.enabled
          ? "workspace_missing_ZES_research_marker"
          : "research_cycle_disabled",
        policy: researchPolicy(this.config.mode),
      };
    }
    const state = await this.readState(workspace);
    return state
      ? this.publicStatus(state, true)
      : {
          managed: true,
          mode: this.config.mode,
          stateExists: false,
          policy: researchPolicy(this.config.mode),
        };
  }

  async providerEvidenceContext(
    workspace: ResearchWorkspace,
  ): Promise<ResearchProviderEvidenceContext> {
    this.assertManaged(workspace);
    return await this.withLock(workspace, async () => {
      const state = await this.requireState(workspace);
      if (state.phase !== "prepared" || !state.prepared) {
        throw new ResearchCycleError(
          "RESEARCH_CYCLE_PROVIDER_SCOPE_NOT_PREPARED",
          `provider acquisition requires prepared phase, found ${state.phase}`,
        );
      }
      return {
        cycleRef: state.cycleRef,
        generation: state.generation,
        phase: "prepared",
        evidenceDirectory: state.open.evidenceDirectory,
        ownerSeededFraming: state.open.ownerSeededFraming,
        taskRef: state.open.taskRef,
        materialDecisionRef: state.open.materialDecisionRef,
        decisionBoundaryRef: state.open.decisionBoundaryRef,
      };
    });
  }

  async instrumentContext(
    workspace: ResearchWorkspace,
  ): Promise<ResearchInstrumentCycleContext> {
    this.assertManaged(workspace);
    return await this.withLock(workspace, async () => {
      const state = await this.requireState(workspace);
      const snapshot = await gitSnapshot(workspace.root);
      return {
        cycleRef: state.cycleRef,
        generation: state.generation,
        phase: state.phase,
        evidenceDirectory: state.open.evidenceDirectory,
        ownerSeededFraming: state.open.ownerSeededFraming,
        taskRef: state.open.taskRef,
        materialDecisionRef: state.open.materialDecisionRef,
        decisionBoundaryRef: state.open.decisionBoundaryRef,
        workspaceSnapshot: {
          head: snapshot.head,
          sourceTree: snapshot.sourceTree,
          branch: snapshot.branch,
          repositoryIdentityDigestSha256:
            snapshot.repositoryIdentityDigestSha256,
          workingContentDigestSha256: snapshot.workingContentDigestSha256,
          dirty: snapshot.dirty,
        },
      };
    });
  }

  async guardPatch(
    workspace: ResearchWorkspace,
    patch: string,
  ): Promise<ResearchGuardDecision> {
    return await this.guardPaths(workspace, extractPatchPaths(patch));
  }

  async guardPaths(
    workspace: ResearchWorkspace,
    rawPaths: string[],
  ): Promise<ResearchGuardDecision> {
    if (!this.manages(workspace)) return unmanagedDecision(this.config.mode);
    const paths = uniqueStrings(
      rawPaths.map((path) => normalizeRelativePath(path, "mutation path")),
      "mutationPaths",
    );
    if (paths.length === 0) {
      throw new ResearchCycleError(
        "RESEARCH_CYCLE_MUTATION_PATHS_REQUIRED",
        "at least one exact mutation path is required",
      );
    }
    const state = await this.readState(workspace);
    const reasons = await this.activeMutationReasons(workspace, state, paths);
    if (!state?.prepared?.operationClasses.includes("source_mutation")) {
      reasons.push("source_mutation_not_in_action_scope");
    }
    if (
      paths.some(dependencySensitive)
      && !state?.prepared?.operationClasses.includes("dependency_change")
    ) {
      reasons.push("dependency_change_not_in_action_scope");
    }
    return this.guardDecision(
      state,
      "apply_patch",
      uniqueStrings(reasons, "reasons"),
    );
  }

  async observePatch(
    workspace: ResearchWorkspace,
    patch: string,
  ): Promise<void> {
    await this.observePaths(workspace, extractPatchPaths(patch));
  }

  async observePaths(
    workspace: ResearchWorkspace,
    rawPaths: string[],
  ): Promise<void> {
    if (!this.manages(workspace)) return;
    await this.withLock(workspace, async () => {
      const state = await this.readState(workspace);
      if (!state) return;
      const paths = uniqueStrings(
        rawPaths.map((path) => normalizeRelativePath(path, "mutation path")),
        "mutationPaths",
      );
      if (paths.length === 0) return;
      state.observedPaths = uniqueStrings(
        [...state.observedPaths, ...paths],
        "observedPaths",
      );
      state.dependencySensitivePaths = uniqueStrings(
        [
          ...state.dependencySensitivePaths,
          ...paths.filter(dependencySensitive),
        ],
        "dependencySensitivePaths",
      );
      const prefixes = state.prepared?.pathPrefixes ?? [];
      const uncovered = paths.filter(
        (path) => !prefixes.some((prefix) => pathWithinPrefix(path, prefix)),
      );
      const dependencyOutsideClass = paths.filter(
        (path) => dependencySensitive(path)
          && !state.prepared?.operationClasses.includes("dependency_change"),
      );
      if (
        state.phase !== "closed"
        && state.prepared
        && (uncovered.length > 0 || dependencyOutsideClass.length > 0)
      ) {
        state.phase = "reassessment_required";
        state.preCommit = undefined;
        state.commit = undefined;
        state.invalidations.push({
          kind: dependencyOutsideClass.length > 0
            ? "dependency_or_upstream_change"
            : "scope_drift",
          reason: dependencyOutsideClass.length > 0
            ? "a direct file mutation changed a dependency-sensitive path outside the admitted operation classes"
            : "a direct file mutation changed a path outside the admitted implementation boundary",
          evidenceRefs: uniqueStrings(
            [...uncovered, ...dependencyOutsideClass],
            "scopeDriftPaths",
          ),
          recordedAt: this.now().toISOString(),
        });
      }
      await this.writeState(workspace, state);
    });
  }

  async guardCommand(
    workspace: ResearchWorkspace,
    command: string,
  ): Promise<ResearchGuardDecision> {
    if (!this.manages(workspace)) return unmanagedDecision(this.config.mode);
    const classification = classifyResearchCommand(command);
    const state = await this.readState(workspace);
    let reasons: string[] = [];
    if (
      classification === "inspection"
      || classification === "research_control"
      || classification === "validation"
    ) {
      reasons = [];
    } else if (classification === "runtime_effect") {
      reasons = ["research_admission_never_grants_runtime_or_effect_authority"];
    } else if (classification === "repository_commit") {
      reasons = await this.commitReasons(workspace, state);
    } else if (classification === "repository_publish") {
      reasons = await this.publishReasons(workspace, state);
    } else if (classification === "commit_prepare") {
      reasons = await this.activeMutationReasons(workspace, state, []);
      if (!state?.prepared?.operationClasses.includes("repository_commit")) {
        reasons.push("repository_commit_not_in_action_scope");
      }
    } else {
      reasons = await this.activeMutationReasons(workspace, state, []);
      if (!state?.prepared?.operationClasses.includes("source_mutation")) {
        reasons.push("source_mutation_not_in_action_scope");
      }
      const digest = researchCommandDigest(command);
      if (!state?.prepared?.shellMutationCommandDigests?.includes(digest)) {
        reasons.push(`shell_mutation_command_not_in_action_scope:${digest}`);
      }
      if (
        commandChangesDependencies(command)
        && !state?.prepared?.operationClasses.includes("dependency_change")
      ) {
        reasons.push("dependency_change_not_in_action_scope");
      }
    }
    return this.guardDecision(state, classification, uniqueStrings(reasons, "reasons"));
  }

  async observeCommandSnapshot(
    workspace: ResearchWorkspace,
    command: string,
    snapshot: { sessionId?: number; running: boolean; exitCode?: number },
  ): Promise<void> {
    if (!this.manages(workspace)) return;
    const classification = classifyResearchCommand(command);
    if (snapshot.running && snapshot.sessionId !== undefined) {
      this.pendingCommands.set(snapshot.sessionId, {
        workspace,
        command,
        classification,
      });
      return;
    }
    await this.observeTerminalCommand(
      workspace,
      command,
      classification,
      snapshot.exitCode,
    );
  }

  async guardProcessInput(
    workspace: ResearchWorkspace,
    sessionId: number,
  ): Promise<ResearchGuardDecision> {
    if (!this.manages(workspace)) return unmanagedDecision(this.config.mode);
    const pending = this.pendingCommands.get(sessionId);
    if (
      !pending
      || pending.workspace.workspaceId !== workspace.workspaceId
      || resolve(pending.workspace.root) !== resolve(workspace.root)
    ) {
      const state = await this.readState(workspace);
      return this.guardDecision(
        state,
        "unknown",
        ["research_process_binding_missing"],
      );
    }
    return await this.guardCommand(workspace, pending.command);
  }

  async observeProcessSnapshot(
    workspace: ResearchWorkspace,
    sessionId: number,
    snapshot: { running: boolean; exitCode?: number },
  ): Promise<void> {
    if (snapshot.running) return;
    const pending = this.pendingCommands.get(sessionId);
    if (!pending) return;
    this.pendingCommands.delete(sessionId);
    await this.observeTerminalCommand(
      workspace,
      pending.command,
      pending.classification,
      snapshot.exitCode,
    );
  }

  private async observeTerminalCommand(
    workspace: ResearchWorkspace,
    command: string,
    classification: ResearchCommandClass,
    exitCode: number | undefined,
  ): Promise<void> {
    await this.withLock(workspace, async () => {
      const state = await this.readState(workspace);
      if (!state || state.phase === "closed") return;
      const commandDigest = canonicalDigest({ classification, command });
      if (exitCode !== 0 && exitCode !== undefined) {
        state.distinctFailureDigests = uniqueStrings(
          [...state.distinctFailureDigests, commandDigest],
          "distinctFailureDigests",
        );
        if (state.distinctFailureDigests.length >= 2) {
          state.invalidations.push({
            kind: "repeated_distinct_failure",
            reason:
              "two distinct command failures were observed after the last admission",
            evidenceRefs: state.distinctFailureDigests,
            recordedAt: this.now().toISOString(),
          });
          state.phase = "reassessment_required";
          state.preCommit = undefined;
        }
      } else if (classification === "validation") {
        state.validationCommandDigests = uniqueStrings(
          [...state.validationCommandDigests, commandDigest],
          "validationCommandDigests",
        );
      }
      if (
        exitCode === 0
        && (classification === "source_mutation"
          || classification === "commit_prepare"
          || classification === "unknown")
      ) {
        const changedPaths = await currentChangedPaths(workspace.root);
        state.observedPaths = uniqueStrings(
          [...state.observedPaths, ...changedPaths],
          "observedPaths",
        );
        state.dependencySensitivePaths = uniqueStrings(
          [
            ...state.dependencySensitivePaths,
            ...changedPaths.filter(dependencySensitive),
          ],
          "dependencySensitivePaths",
        );
        const prefixes = state.prepared?.pathPrefixes ?? [];
        const uncovered = changedPaths.filter(
          (path) => !prefixes.some((prefix) => pathWithinPrefix(path, prefix)),
        );
        const dependencyOutsideClass = changedPaths.filter(
          (path) => dependencySensitive(path)
            && !state.prepared?.operationClasses.includes("dependency_change"),
        );
        if (uncovered.length > 0 || dependencyOutsideClass.length > 0) {
          state.phase = "reassessment_required";
          state.preCommit = undefined;
          state.invalidations.push({
            kind: dependencyOutsideClass.length > 0
              ? "dependency_or_upstream_change"
              : "scope_drift",
            reason: dependencyOutsideClass.length > 0
              ? "a dependency-sensitive path changed outside the admitted operation classes"
              : "a shell mutation changed paths outside the admitted implementation boundary",
            evidenceRefs: uniqueStrings(
              [...uncovered, ...dependencyOutsideClass],
              "scopeDriftPaths",
            ),
            recordedAt: this.now().toISOString(),
          });
        }
      }
      if (exitCode === 0 && classification === "repository_commit") {
        const snapshot = await gitSnapshot(workspace.root);
        const preCommit = state.preCommit;
        if (!preCommit || state.phase !== "pre_commit_verified") {
          state.phase = "reassessment_required";
          state.invalidations.push({
            kind: "scope_drift",
            reason: "a commit completed without the current pre-commit checkpoint",
            evidenceRefs: [commandDigest],
            recordedAt: this.now().toISOString(),
          });
        } else if (snapshot.dirty) {
          state.phase = "reassessment_required";
          state.invalidations.push({
            kind: "scope_drift",
            reason: "the successful commit did not contain the complete verified change set",
            evidenceRefs: [snapshot.workingContentDigestSha256],
            recordedAt: this.now().toISOString(),
          });
        } else {
          state.commit = {
            committedAt: this.now().toISOString(),
            headBefore: state.prepared!.snapshot.head,
            headAfter: snapshot.head,
            sourceTreeAfter: snapshot.sourceTree,
            commandDigestSha256: commandDigest,
          };
          state.phase = "committed";
        }
      }
      await this.writeState(workspace, state);
    });
  }

  private async activeMutationReasons(
    workspace: ResearchWorkspace,
    state: ResearchCycleState | undefined,
    paths: string[],
  ): Promise<string[]> {
    if (!state) return ["research_cycle_not_opened"];
    if (state.phase !== "admitted") {
      return [`research_cycle_phase_${state.phase}`];
    }
    const reasons = await this.admissionReasons(workspace, state);
    const prefixes = state.prepared?.pathPrefixes ?? [];
    for (const path of paths) {
      if (!prefixes.some((prefix) => pathWithinPrefix(path, prefix))) {
        reasons.push(`path_outside_research_action_scope:${path}`);
      }
    }
    return reasons;
  }

  private async admissionReasons(
    workspace: ResearchWorkspace,
    state: ResearchCycleState,
  ): Promise<string[]> {
    const admission = state.admission;
    const prepared = state.prepared;
    if (!admission?.admitted || !prepared) return ["research_admission_missing_or_held"];
    const reasons: string[] = [];
    if (!admission.validUntil || Date.parse(admission.validUntil) <= this.now().getTime()) {
      reasons.push("research_admission_lease_expired");
    }
    try {
      if (await sha256File(admission.receiptPath) !== admission.receiptFileSha256) {
        reasons.push("research_admission_receipt_file_changed");
      }
    } catch {
      reasons.push("research_admission_receipt_missing");
    }
    const snapshot = await gitSnapshot(workspace.root);
    if (snapshot.head !== prepared.snapshot.head) {
      reasons.push("research_action_head_mismatch");
    }
    return reasons;
  }

  private async commitReasons(
    workspace: ResearchWorkspace,
    state: ResearchCycleState | undefined,
  ): Promise<string[]> {
    if (!state) return ["research_cycle_not_opened"];
    const reasons = await this.admissionReasons(workspace, state);
    if (state.phase !== "pre_commit_verified" || !state.preCommit) {
      reasons.push(`research_cycle_phase_${state.phase}`);
      return reasons;
    }
    if (!state.prepared?.operationClasses.includes("repository_commit")) {
      reasons.push("repository_commit_not_in_action_scope");
    }
    const snapshot = await gitSnapshot(workspace.root);
    if (
      snapshot.workingContentDigestSha256
      !== state.preCommit.workingContentDigestSha256
    ) reasons.push("working_content_changed_after_pre_commit_verification");
    return reasons;
  }

  private async publishReasons(
    workspace: ResearchWorkspace,
    state: ResearchCycleState | undefined,
  ): Promise<string[]> {
    if (!state) return ["research_cycle_not_opened"];
    const reasons: string[] = [];
    if (state.phase !== "closed" || state.closure?.outcome !== "committed") {
      reasons.push(`research_cycle_phase_${state.phase}`);
    }
    if (!state.prepared?.operationClasses.includes("repository_publish")) {
      reasons.push("repository_publish_not_in_action_scope");
    }
    const snapshot = await gitSnapshot(workspace.root);
    if (!state.commit || snapshot.head !== state.commit.headAfter) {
      reasons.push("publish_head_does_not_match_closed_commit");
    }
    if (snapshot.dirty) reasons.push("publish_workspace_not_clean");
    return reasons;
  }

  private guardDecision(
    state: ResearchCycleState | undefined,
    classification: ResearchGuardDecision["classification"],
    reasons: string[],
  ): ResearchGuardDecision {
    const advisoryOnly = this.config.mode === "observe";
    return {
      managed: true,
      mode: this.config.mode,
      allowed: advisoryOnly || reasons.length === 0,
      classification,
      reasons,
      cycleRef: state?.cycleRef,
      phase: state?.phase,
      advisoryOnly,
    };
  }

  private async requireState(
    workspace: ResearchWorkspace,
  ): Promise<ResearchCycleState> {
    const state = await this.readState(workspace);
    if (!state) {
      throw new ResearchCycleError(
        "RESEARCH_CYCLE_NOT_OPENED",
        "open a research cycle before this operation",
      );
    }
    return state;
  }

  private assertRequestBindings(
    state: ResearchCycleState,
    request: Record<string, unknown>,
  ): void {
    const prepared = state.prepared!;
    if (request.schema_version !== ADMISSION_REQUEST_SCHEMA) {
      throw new ResearchCycleError(
        "RESEARCH_CYCLE_V3_ADMISSION_REQUIRED",
        "the DevSpace action gate requires a capability-bound Research Reflex v3 request",
      );
    }
    const comparisons: Array<[string, unknown, unknown]> = [
      ["task_ref", request.task_ref, state.open.taskRef],
      ["material_decision_ref", request.material_decision_ref, state.open.materialDecisionRef],
      ["decision_boundary_ref", request.decision_boundary_ref, state.open.decisionBoundaryRef],
      ["decision_question", request.decision_question, state.open.decisionQuestion],
      ["decision_scope_digest_sha256", request.decision_scope_digest_sha256, prepared.decisionScopeDigestSha256],
      ["evidence_regime_digest_sha256", request.evidence_regime_digest_sha256, prepared.evidenceRegimeDigestSha256],
      ["source_identity_digest_sha256", request.source_identity_digest_sha256, prepared.sourceIdentityDigestSha256],
      ["implementation_boundary_digest_sha256", request.implementation_boundary_digest_sha256, prepared.implementationBoundaryDigestSha256],
      ["action_scope_digest_sha256", request.action_scope_digest_sha256, prepared.actionScopeDigestSha256],
      ["owner_seeded_framing", request.owner_seeded_framing, state.open.ownerSeededFraming],
      ["assessing_actor_ref", request.assessing_actor_ref, state.open.actorRef],
    ];
    const mismatches = comparisons
      .filter(([, observed, expected]) => observed !== expected)
      .map(([label]) => label);
    if (mismatches.length > 0) {
      throw new ResearchCycleError(
        "RESEARCH_CYCLE_REQUEST_BINDING_MISMATCH",
        "the Research Reflex request does not match the prepared workspace action scope",
        { mismatches },
      );
    }
  }

  private assertAdmissionReceipt(
    state: ResearchCycleState,
    receipt: Record<string, unknown>,
    summary: Record<string, unknown>,
  ): void {
    if (receipt.schema_version !== ADMISSION_RECEIPT_SCHEMA) {
      throw new ResearchCycleError(
        "RESEARCH_CYCLE_RECEIPT_SCHEMA_UNSUPPORTED",
        `unsupported admission receipt schema: ${String(receipt.schema_version)}`,
      );
    }
    if (!isRecord(receipt.request)) {
      throw new ResearchCycleError(
        "RESEARCH_CYCLE_RECEIPT_REQUEST_MISSING",
        "the admission receipt contains no request",
      );
    }
    this.assertRequestBindings(state, receipt.request);
    if (summary.commit_admitted !== receipt.commit_admitted) {
      throw new ResearchCycleError(
        "RESEARCH_CYCLE_RECEIPT_SUMMARY_MISMATCH",
        "the native summary and admission receipt disagree",
      );
    }
    for (const field of ["request_digest_sha256", "receipt_digest_sha256"] as const) {
      const value = summary[field];
      if (typeof value !== "string" || !SHA256.test(value)) {
        throw new ResearchCycleError(
          "RESEARCH_CYCLE_NATIVE_DIGEST_MISSING",
          `the native summary lacks ${field}`,
        );
      }
    }
  }

  private assertEpisodePacket(
    state: ResearchCycleState,
    packet: Record<string, unknown>,
  ): void {
    if (!EPISODE_PACKET_SCHEMAS.has(String(packet.schema_version))) {
      throw new ResearchCycleError(
        "RESEARCH_CYCLE_EPISODE_SCHEMA_UNSUPPORTED",
        `unsupported episode packet schema: ${String(packet.schema_version)}`,
      );
    }
    const assessment = isRecord(packet.need_assessment)
      ? packet.need_assessment
      : undefined;
    if (
      assessment?.task_ref !== state.open.taskRef
      || assessment.material_decision_ref !== state.open.materialDecisionRef
    ) {
      throw new ResearchCycleError(
        "RESEARCH_CYCLE_EPISODE_SCOPE_MISMATCH",
        "the episode packet does not match this task and material decision",
      );
    }
  }

  private async resolveProviderTraces(
    workspace: ResearchWorkspace,
    state: ResearchCycleState,
    traces: ResearchProviderTraceInput[],
  ): Promise<ProviderTraceRecord[]> {
    const trustedRoots = [
      workspace.root,
      state.open.evidenceDirectory,
      ...this.config.trustedTraceRoots,
    ];
    const resolvedTrustedRoots = await Promise.all(
      trustedRoots.map(async (root) => {
        try {
          return await realpath(root);
        } catch {
          return resolve(root);
        }
      }),
    );
    const records: ProviderTraceRecord[] = [];
    for (const trace of traces) {
      const traceRef = requiredString(trace.traceRef, "traceRef");
      const candidate = isAbsolute(trace.path)
        ? resolve(trace.path)
        : resolve(workspace.root, trace.path);
      let actual: string;
      try {
        actual = await realpath(candidate);
      } catch {
        throw new ResearchCycleError(
          "RESEARCH_CYCLE_PROVIDER_TRACE_MISSING",
          `provider trace is missing: ${traceRef}`,
        );
      }
      if (!resolvedTrustedRoots.some((root) => pathInside(actual, root))) {
        throw new ResearchCycleError(
          "RESEARCH_CYCLE_PROVIDER_TRACE_OUTSIDE_TRUST_ROOT",
          `provider trace is outside configured trust roots: ${traceRef}`,
        );
      }
      records.push({ traceRef, path: actual });
    }
    const refs = records.map((record) => record.traceRef);
    if (new Set(refs).size !== refs.length) {
      throw new ResearchCycleError(
        "RESEARCH_CYCLE_PROVIDER_TRACE_DUPLICATE",
        "provider trace refs must be unique",
      );
    }
    return records.sort((left, right) => left.traceRef.localeCompare(right.traceRef));
  }

  private traceArgs(
    workspace: ResearchWorkspace,
    state: ResearchCycleState,
    traces: ProviderTraceRecord[],
  ): string[] {
    const roots = uniqueStrings(
      [
        resolve(workspace.root),
        resolve(state.open.evidenceDirectory),
        ...this.config.trustedTraceRoots.map((root) => resolve(root)),
      ],
      "trustedTraceRoots",
    );
    return [
      ...traces.flatMap((trace) => [
        "--provider-trace",
        `${trace.traceRef}=${trace.path}`,
      ]),
      ...roots.flatMap((root) => ["--trusted-trace-root", root]),
    ];
  }

  private async verifyNativeAdmission(
    workspace: ResearchWorkspace,
    state: ResearchCycleState,
  ): Promise<Record<string, unknown>> {
    const admission = state.admission;
    if (!admission) {
      throw new ResearchCycleError(
        "RESEARCH_CYCLE_ADMISSION_MISSING",
        "no native admission receipt exists",
      );
    }
    if (await sha256File(admission.receiptPath) !== admission.receiptFileSha256) {
      throw new ResearchCycleError(
        "RESEARCH_CYCLE_ADMISSION_RECEIPT_CHANGED",
        "the stored admission receipt changed after assessment",
      );
    }
    const result = await this.invokeNative(
      "verify-admission",
      [
        "--receipt",
        admission.receiptPath,
        ...this.traceArgs(workspace, state, admission.providerTraces),
      ],
    );
    if (result.exitCode !== 0) {
      throw new ResearchCycleError(
        "RESEARCH_CYCLE_NATIVE_VERIFY_FAILED",
        `Research Reflex admission verification failed with exit ${result.exitCode}`,
        processFailureEvidence(result),
      );
    }
    const summary = parseJsonObject(
      result.stdout,
      "Research Reflex verification summary",
    );
    if (
      summary.request_digest_sha256 !== admission.requestDigestSha256
      || summary.receipt_digest_sha256 !== admission.receiptDigestSha256
      || summary.commit_admitted !== admission.admitted
    ) {
      throw new ResearchCycleError(
        "RESEARCH_CYCLE_NATIVE_VERIFY_IDENTITY_MISMATCH",
        "the current native verification does not match the stored admission",
      );
    }
    return summary;
  }

  private async invokeNative(
    operation: ResearchNativeInvocation["operation"],
    args: string[],
  ): Promise<ResearchNativeResult> {
    return await this.nativeRunner({
      operation,
      args,
      cwd: this.config.repositoryRoot,
      timeoutMs: this.config.timeoutMs,
    });
  }

  private publicStatus(
    state: ResearchCycleState,
    stateExists: boolean,
  ): Record<string, unknown> {
    return {
      managed: true,
      mode: this.config.mode,
      stateExists,
      cycleRef: state.cycleRef,
      phase: state.phase,
      generation: state.generation,
      taskRef: state.open.taskRef,
      materialDecisionRef: state.open.materialDecisionRef,
      decisionBoundaryRef: state.open.decisionBoundaryRef,
      candidatePathPrefixes: state.open.candidatePathPrefixes,
      prepared: state.prepared
        ? {
            pathPrefixes: state.prepared.pathPrefixes,
            operationClasses: state.prepared.operationClasses,
            shellMutationCommandDigests:
              state.prepared.shellMutationCommandDigests ?? [],
            requestBindings: {
              decision_scope_digest_sha256:
                state.prepared.decisionScopeDigestSha256,
              evidence_regime_digest_sha256:
                state.prepared.evidenceRegimeDigestSha256,
              source_identity_digest_sha256:
                state.prepared.sourceIdentityDigestSha256,
              implementation_boundary_digest_sha256:
                state.prepared.implementationBoundaryDigestSha256,
              action_scope_digest_sha256:
                state.prepared.actionScopeDigestSha256,
            },
          }
        : undefined,
      admission: state.admission ? publicAdmission(state.admission) : undefined,
      discovery: state.discovery?.plan
        ? {
            planRef: state.discovery.plan.planRef,
            planDigestSha256: state.discovery.plan.planDigestSha256,
            portfolioDigestSha256:
              state.discovery.plan.portfolioDigestSha256,
            policyDigestSha256: state.discovery.plan.policyDigestSha256,
            profile: state.discovery.plan.discoveryProfile,
            temporalRegime: state.discovery.plan.temporalRegime,
            asOf: state.discovery.plan.asOf,
            derivedSince: state.discovery.plan.derivedSince,
            revalidateBy: state.discovery.plan.revalidateBy,
            coverage: mergeDiscoveryCoverage(
              state.discovery.plan,
              state.discovery.acquisitions,
            ),
            acquisitionCount: state.discovery.acquisitions.length,
            horizon: state.discovery.horizon
              ? {
                  horizonRef: state.discovery.horizon.horizonRef,
                  recordedAt: state.discovery.horizon.recordedAt,
                  asOf: state.discovery.horizon.asOf,
                  eventCount: state.discovery.horizon.events.length,
                  staleReasons: state.discovery.horizon.staleReasons,
                  requiresResearchReflexRefresh:
                    state.discovery.horizon.requiresResearchReflexRefresh,
                }
              : undefined,
            invalidations: state.discovery.invalidations,
          }
        : undefined,
      invalidations: state.invalidations,
      observedPaths: state.observedPaths,
      dependencySensitivePaths: state.dependencySensitivePaths,
      distinctFailureCount: state.distinctFailureDigests.length,
      preCommit: state.preCommit
        ? {
            verifiedAt: state.preCommit.verifiedAt,
            workingContentDigestSha256:
              state.preCommit.workingContentDigestSha256,
            validationRefs: state.preCommit.validationRefs,
          }
        : undefined,
      commit: state.commit,
      closure: state.closure
        ? {
            outcome: state.closure.outcome,
            reason: state.closure.reason,
            decisionDelta: state.closure.decisionDelta,
            reusableFindings: state.closure.reusableFindings,
            reversalConditions: state.closure.reversalConditions,
            closedAt: state.closure.closedAt,
            closedHead: state.closure.closedHead,
            episodeReceiptRef: state.closure.episodeReceiptRef,
            episodeReceiptDigestSha256:
              state.closure.episodeReceiptDigestSha256,
          }
        : undefined,
      updatedAt: state.updatedAt,
      policy: researchPolicy(this.config.mode),
    };
  }
}

function publicSnapshot(snapshot: GitSnapshot): Record<string, unknown> {
  return {
    head: snapshot.head,
    sourceTree: snapshot.sourceTree,
    branch: snapshot.branch,
    repositoryIdentityDigestSha256:
      snapshot.repositoryIdentityDigestSha256,
    workingContentDigestSha256: snapshot.workingContentDigestSha256,
    dirty: snapshot.dirty,
  };
}

function publicAdmission(admission: AdmissionRecord): Record<string, unknown> {
  return {
    state: admission.state,
    admitted: admission.admitted,
    requestDigestSha256: admission.requestDigestSha256,
    receiptRef: admission.receiptRef,
    receiptDigestSha256: admission.receiptDigestSha256,
    validUntil: admission.validUntil,
    evaluatedAt: admission.evaluatedAt,
    causalReason: admission.causalReason,
    providerTraceRefs: admission.providerTraces.map((trace) => trace.traceRef),
  };
}

function researchPolicy(
  mode: ZesResearchCycleConfig["mode"],
): Record<string, unknown> {
  return {
    authority:
      "executor_local_lifecycle_and_native_receipt_verification_only",
    mode,
    semanticJudgmentAuthority: false,
    researchSufficiencyAuthority: false,
    sourceTruthAuthority: false,
    writerAuthority: false,
    publicationAuthority: false,
    runtimeOrEffectAuthority: false,
    nativeApplicationPort: "port.zes-research-reflex",
    providerOutputTreatedAsUntrustedEvidence: true,
    localJudgmentRemainsRequired: true,
  };
}

function unmanagedDecision(
  mode: ZesResearchCycleConfig["mode"],
): ResearchGuardDecision {
  return {
    managed: false,
    mode,
    allowed: true,
    reasons: [],
    advisoryOnly: mode !== "enforce",
  };
}
