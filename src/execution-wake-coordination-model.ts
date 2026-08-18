import { createHash } from "node:crypto";

export const EXECUTION_WAKE_COORDINATION_AUTHORITY = {
  authority: "executor_local_wake_coordination_only",
  canonicalTaskAuthority: false,
  canonicalDecisionAuthority: false,
  writerLeaseAuthority: false,
  canonicalEffectOutcomeAuthority: false,
  publicationAuthority: false,
  browserOwnershipAuthority: false,
  interactionOwnershipAuthority: false,
  readinessClassifierAuthority: false,
  completionInferredFromSilence: false,
  hungInferredFromSilence: false,
  unknownFailsClosed: true,
  tierOneMayStopGeneration: false,
  tierOneMayRegenerate: false,
  tierOneMayReload: false,
  tierOneMayOpenDuplicateConversation: false,
} as const;

export type WakePriority = "low" | "normal" | "high" | "urgent";

export type WakePendingWorkState =
  | "pending"
  | "wake_inflight"
  | "wake_verified"
  | "consumed"
  | "superseded"
  | "expired"
  | "held";

export type WakeAttemptState =
  | "prepared"
  | "dispatching"
  | "verified"
  | "failed_no_effect"
  | "indeterminate"
  | "reconciled_effect_absent"
  | "reconciled_effect_verified"
  | "held"
  | "cancelled";

export type WakeThrottleState =
  | "ready"
  | "cooldown"
  | "loop_guard"
  | "human_hold";

export type WakeAutomaticRecoveryTier =
  | "observe_only"
  | "minimal_continuation"
  | "binding_or_page_recovery"
  | "human_required";

export type WakeScheduleDecision =
  | "NO_PENDING_WORK"
  | "HOLD"
  | "COOLDOWN"
  | "LOOP_GUARD"
  | "IN_FLIGHT"
  | "ALREADY_VERIFIED"
  | "READY";

export interface WakePendingWorkRecord {
  schemaVersion: 1;
  pendingWorkId: string;
  targetExecutionScopeRef: string;
  missionRef: string;
  generation: number;
  sourceGeneration: number;
  workCycleRef: string;
  correlationRef: string;
  taskRefs: string[];
  messageRefs: string[];
  workItemRefs: string[];
  sourceAuthorityRefs: string[];
  actionableCount: number;
  highestPriority: WakePriority;
  semanticDigestSha256: string;
  state: WakePendingWorkState;
  revision: number;
  latestAttemptId?: string;
  latestAttemptSequence: number;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  wakeVerifiedAt?: string;
  consumedAt?: string;
  consumptionRefs: string[];
  supersededAt?: string;
  supersededByPendingWorkId?: string;
  heldAt?: string;
  holdReasonCodes: string[];
  authority: typeof EXECUTION_WAKE_COORDINATION_AUTHORITY;
}

/**
 * Adapter view of the lower interaction plane's exact target binding and
 * deterministic operational-state assessment. The scheduler consumes this
 * view; it never recreates browser, DOM, network, lifecycle, or selector logic.
 */
export interface LowerPlaneWakeReadiness {
  schemaVersion: 1;
  assessmentRef: string;
  targetExecutionScopeRef: string;
  missionRef: string;
  sessionUiBindingRef: string;
  bindingGeneration: number;
  targetKind?: "codex_thread" | "chatgpt_chat" | "chatgpt_work" | "generic";
  transportId?: string;
  transportKind?: "native_rpc" | "local_agent" | "web_ui";
  transportRouteDigestSha256?: string;
  operationalState: string;
  exactTargetVerified: boolean;
  selectorContractVerified: boolean;
  accountAutomationWarningAbsent: boolean;
  wakePermitted: boolean;
  maximumAutomaticRecoveryTier: WakeAutomaticRecoveryTier;
  observationRef: string;
  generationBoundaryRefBefore?: string;
  evidenceDigestSha256: string;
  evidenceRefs: string[];
  reasonCodes: string[];
  assessedAt: string;
  expiresAt: string;
  lowerPlaneAuthorityRef: string;
}

export interface WakeContinuationEnvelope {
  schemaVersion: 1;
  envelopeRef: string;
  targetExecutionScopeRef: string;
  missionRef: string;
  pendingWorkId: string;
  pendingWorkGeneration: number;
  pendingWorkSemanticDigestSha256: string;
  workCycleRef: string;
  correlationRef: string;
  taskRefs: string[];
  messageRefs: string[];
  workItemRefs: string[];
  body: string;
  bodyDigestSha256: string;
  createdAt: string;
  authority: typeof EXECUTION_WAKE_COORDINATION_AUTHORITY;
}

export interface WakePermit {
  schemaVersion: 1;
  permitRef: string;
  wakeKey: string;
  actorScopeRef: string;
  targetExecutionScopeRef: string;
  missionRef: string;
  pendingWorkId: string;
  pendingWorkGeneration: number;
  pendingWorkSemanticDigestSha256: string;
  attemptSequence: number;
  readinessAssessmentRef: string;
  sessionUiBindingRef: string;
  bindingGeneration: number;
  targetKind?: "codex_thread" | "chatgpt_chat" | "chatgpt_work" | "generic";
  transportId?: string;
  transportKind?: "native_rpc" | "local_agent" | "web_ui";
  transportRouteDigestSha256?: string;
  observationRef: string;
  evidenceDigestSha256: string;
  generationBoundaryRefBefore?: string;
  recoveryTier: "minimal_continuation";
  allowedEffect: "submit_correlated_continuation";
  forbiddenEffects: readonly [
    "stop_generation",
    "regenerate_response",
    "reload_page",
    "open_duplicate_conversation",
    "navigate_away",
    "publish",
    "repeat_external_effect",
  ];
  envelope: WakeContinuationEnvelope;
  issuedAt: string;
  expiresAt: string;
  authority: typeof EXECUTION_WAKE_COORDINATION_AUTHORITY;
}

export interface WakeLowerPlaneDispatchResult {
  schemaVersion: 1;
  permitRef: string;
  disposition: "verified" | "failed_no_effect" | "indeterminate";
  interactionSessionRef: string;
  interactionActionId?: string;
  interactionReceiptRef?: string;
  promptAdmissionRef?: string;
  generationBoundaryRefAfter?: string;
  noEffectProofRef?: string;
  verificationRefs: string[];
  failureCode?: string;
  completedAt: string;
}

export interface WakeAttempt {
  schemaVersion: 1;
  attemptId: string;
  wakeKey: string;
  idempotencyKeyDigestSha256: string;
  actorScopeRef: string;
  targetExecutionScopeRef: string;
  missionRef: string;
  pendingWorkId: string;
  pendingWorkGeneration: number;
  pendingWorkSemanticDigestSha256: string;
  attemptSequence: number;
  state: WakeAttemptState;
  revision: number;
  permit: WakePermit;
  readiness: LowerPlaneWakeReadiness;
  lowerPlaneResult?: WakeLowerPlaneDispatchResult;
  interactionReconciliationRef?: string;
  authorityReadbackRef?: string;
  effectReadbackRef?: string;
  reconciliationResolution?: "effect_absent" | "effect_verified";
  failureCode?: string;
  createdAt: string;
  updatedAt: string;
  dispatchStartedAt?: string;
  terminalAt?: string;
  cooldownUntil: string;
  authority: typeof EXECUTION_WAKE_COORDINATION_AUTHORITY;
}

export interface WakeTargetThrottle {
  schemaVersion: 1;
  targetExecutionScopeRef: string;
  missionRef: string;
  revision: number;
  state: WakeThrottleState;
  automaticAttemptWindowStartedAt?: string;
  automaticAttemptCount: number;
  consecutiveNoEffectCount: number;
  lastAttemptId?: string;
  lastAttemptState?: WakeAttemptState;
  lastPendingWorkId?: string;
  lastPendingWorkGeneration?: number;
  lastVerifiedGenerationBoundaryRef?: string;
  cooldownUntil: string;
  holdUntil?: string;
  holdReasonCodes: string[];
  updatedAt: string;
  authority: typeof EXECUTION_WAKE_COORDINATION_AUTHORITY;
}

export interface WakeLease {
  schemaVersion: 1;
  resourceRef: string;
  leaseId: string;
  holderScopeRef: string;
  targetExecutionScopeRef: string;
  missionRef: string;
  pendingWorkId: string;
  acquiredAt: string;
  renewedAt: string;
  expiresAt: string;
}

export interface WakeScheduleAssessment {
  schemaVersion: 1;
  decision: WakeScheduleDecision;
  targetExecutionScopeRef: string;
  missionRef: string;
  pendingWork?: WakePendingWorkRecord;
  readiness?: LowerPlaneWakeReadiness;
  throttle?: WakeTargetThrottle;
  nextAttemptSequence?: number;
  reasonCodes: string[];
  assessedAt: string;
  authority: typeof EXECUTION_WAKE_COORDINATION_AUTHORITY;
}

export interface WakeExecutionResult {
  schemaVersion: 1;
  assessment: WakeScheduleAssessment;
  attempt?: WakeAttempt;
  idempotentReplay: boolean;
  authority: typeof EXECUTION_WAKE_COORDINATION_AUTHORITY;
}

export interface WakeReconciliationInput {
  attemptId: string;
  expectedRevision: number;
  resolution: "effect_absent" | "effect_verified";
  interactionReconciliationRef: string;
  authorityReadbackRef: string;
  effectReadbackRef: string;
  promptAdmissionRef?: string;
  generationBoundaryRefAfter?: string;
  verificationRefs: string[];
}

export interface ExecutionWakeLowerPlanePort {
  assessReadiness(input: {
    targetExecutionScopeRef: string;
    missionRef: string;
    pendingWorkId: string;
    pendingWorkGeneration: number;
    pendingWorkSemanticDigestSha256: string;
    correlationRef: string;
    assessmentTimeCeiling?: string;
  }): Promise<LowerPlaneWakeReadiness>;

  consumeWakePermit(permit: WakePermit): Promise<WakeLowerPlaneDispatchResult>;
}

export function pendingWorkSemanticDigest(input: {
  targetExecutionScopeRef: string;
  missionRef: string;
  sourceGeneration: number;
  workCycleRef: string;
  correlationRef: string;
  taskRefs: string[];
  messageRefs: string[];
  workItemRefs: string[];
  sourceAuthorityRefs: string[];
  actionableCount: number;
  highestPriority: WakePriority;
}): string {
  return sha256(canonicalJson({
    targetExecutionScopeRef: input.targetExecutionScopeRef,
    missionRef: input.missionRef,
    sourceGeneration: input.sourceGeneration,
    workCycleRef: input.workCycleRef,
    correlationRef: input.correlationRef,
    taskRefs: uniqueSorted(input.taskRefs),
    messageRefs: uniqueSorted(input.messageRefs),
    workItemRefs: uniqueSorted(input.workItemRefs),
    sourceAuthorityRefs: uniqueSorted(input.sourceAuthorityRefs),
    actionableCount: input.actionableCount,
    highestPriority: input.highestPriority,
  }));
}

export function buildWakeContinuationEnvelope(input: {
  envelopeRef: string;
  pendingWork: WakePendingWorkRecord;
  createdAt: string;
  maximumListedReferences?: number;
}): WakeContinuationEnvelope {
  const taskRefs = uniqueSorted(input.pendingWork.taskRefs);
  const messageRefs = uniqueSorted(input.pendingWork.messageRefs);
  const workItemRefs = uniqueSorted(input.pendingWork.workItemRefs);
  const maximumListedReferences = Math.max(
    1,
    Math.min(100, Math.floor(input.maximumListedReferences ?? 20)),
  );
  const listedReferences = [
    ...taskRefs,
    ...messageRefs,
    ...workItemRefs,
  ].slice(0, maximumListedReferences);
  const body = [
    `[ZES-A2A continuation ${input.pendingWork.correlationRef}]`,
    `Durable coordination work generation ${input.pendingWork.generation} is pending for mission ${input.pendingWork.missionRef}.`,
    "Read the current execution-coordination status and inbox, reconcile the exact workspace/runtime/authority state, then continue only the rightful pending work.",
    "Do not infer completion from silence. Do not repeat an external effect or publish without current authority readback, effect reconciliation, and the existing publication gate.",
    listedReferences.length > 0
      ? `Pending references: ${listedReferences.join(", ")}`
      : undefined,
  ].filter((line): line is string => line !== undefined).join("\n");
  return {
    schemaVersion: 1,
    envelopeRef: input.envelopeRef,
    targetExecutionScopeRef: input.pendingWork.targetExecutionScopeRef,
    missionRef: input.pendingWork.missionRef,
    pendingWorkId: input.pendingWork.pendingWorkId,
    pendingWorkGeneration: input.pendingWork.generation,
    pendingWorkSemanticDigestSha256: input.pendingWork.semanticDigestSha256,
    workCycleRef: input.pendingWork.workCycleRef,
    correlationRef: input.pendingWork.correlationRef,
    taskRefs,
    messageRefs,
    workItemRefs,
    body,
    bodyDigestSha256: sha256(body),
    createdAt: normalizeIso(input.createdAt, "createdAt"),
    authority: EXECUTION_WAKE_COORDINATION_AUTHORITY,
  };
}

export function wakeKey(input: {
  targetExecutionScopeRef: string;
  missionRef: string;
  pendingWorkId: string;
  pendingWorkGeneration: number;
  pendingWorkSemanticDigestSha256: string;
  sessionUiBindingRef: string;
  bindingGeneration: number;
  transportId?: string;
  transportKind?: string;
  transportRouteDigestSha256?: string;
  attemptSequence: number;
}): string {
  return `wky_${sha256(canonicalJson(input)).slice(0, 32)}`;
}

export function validateLowerPlaneReadiness(
  readiness: LowerPlaneWakeReadiness,
  pendingWork: WakePendingWorkRecord,
  nowMs: number,
): string[] {
  const reasons = new Set<string>();
  if (!readiness.assessmentRef) reasons.add("READINESS_ASSESSMENT_REF_MISSING");
  if (!readiness.operationalState) reasons.add("READINESS_OPERATIONAL_STATE_MISSING");
  if (readiness.targetExecutionScopeRef !== pendingWork.targetExecutionScopeRef) {
    reasons.add("READINESS_TARGET_SCOPE_MISMATCH");
  }
  if (readiness.missionRef !== pendingWork.missionRef) {
    reasons.add("READINESS_MISSION_MISMATCH");
  }
  if (!readiness.exactTargetVerified) reasons.add("EXACT_TARGET_NOT_VERIFIED");
  if (!readiness.selectorContractVerified) reasons.add("SELECTOR_CONTRACT_NOT_VERIFIED");
  if (!readiness.accountAutomationWarningAbsent) {
    reasons.add("ACCOUNT_AUTOMATION_WARNING_PRESENT_OR_UNKNOWN");
  }
  if (!readiness.wakePermitted) reasons.add("LOWER_PLANE_WAKE_NOT_PERMITTED");
  if (readiness.maximumAutomaticRecoveryTier !== "minimal_continuation") {
    reasons.add("MINIMAL_CONTINUATION_NOT_AUTHORIZED");
  }
  if (!readiness.sessionUiBindingRef) reasons.add("SESSION_UI_BINDING_REF_MISSING");
  if (!Number.isInteger(readiness.bindingGeneration) || readiness.bindingGeneration < 1) {
    reasons.add("BINDING_GENERATION_INVALID");
  }
  if (!readiness.observationRef) reasons.add("OBSERVATION_REF_MISSING");
  if (!/^[a-f0-9]{64}$/.test(readiness.evidenceDigestSha256)) {
    reasons.add("READINESS_EVIDENCE_DIGEST_INVALID");
  }
  if (!readiness.lowerPlaneAuthorityRef) reasons.add("LOWER_PLANE_AUTHORITY_REF_MISSING");
  const transportFields = [
    readiness.transportId,
    readiness.transportKind,
    readiness.transportRouteDigestSha256,
  ];
  if (transportFields.some((value) => value !== undefined)) {
    if (!readiness.transportId) reasons.add("TRANSPORT_ID_MISSING");
    if (!readiness.transportKind) reasons.add("TRANSPORT_KIND_MISSING");
    if (!/^[a-f0-9]{64}$/.test(readiness.transportRouteDigestSha256 ?? "")) {
      reasons.add("TRANSPORT_ROUTE_DIGEST_INVALID");
    }
  }
  if (readiness.evidenceRefs.length === 0) {
    reasons.add("LOWER_PLANE_EVIDENCE_REFS_MISSING");
  }
  const assessedAt = Date.parse(readiness.assessedAt);
  const expiresAt = Date.parse(readiness.expiresAt);
  if (!Number.isFinite(assessedAt) || assessedAt > nowMs) {
    reasons.add("READINESS_ASSESSED_AT_INVALID");
  }
  if (!Number.isFinite(expiresAt) || expiresAt <= nowMs) {
    reasons.add("READINESS_EXPIRED_OR_INVALID");
  }
  return [...reasons].sort();
}

export function validateVerifiedDispatchResult(
  permit: WakePermit,
  result: WakeLowerPlaneDispatchResult,
): string[] {
  const reasons = new Set<string>();
  if (result.permitRef !== permit.permitRef) reasons.add("DISPATCH_PERMIT_REF_MISMATCH");
  if (!result.interactionSessionRef) reasons.add("INTERACTION_SESSION_REF_MISSING");
  if (result.disposition === "verified") {
    if (!result.interactionActionId) reasons.add("INTERACTION_ACTION_ID_MISSING");
    if (!result.interactionReceiptRef) reasons.add("INTERACTION_RECEIPT_REF_MISSING");
    if (!result.promptAdmissionRef) reasons.add("PROMPT_ADMISSION_REF_MISSING");
    if (!result.generationBoundaryRefAfter) {
      reasons.add("GENERATION_BOUNDARY_AFTER_MISSING");
    }
    if (permit.generationBoundaryRefBefore
      && result.generationBoundaryRefAfter === permit.generationBoundaryRefBefore) {
      reasons.add("GENERATION_BOUNDARY_DID_NOT_ADVANCE");
    }
  } else if (result.disposition === "failed_no_effect") {
    if (!result.noEffectProofRef) reasons.add("NO_EFFECT_PROOF_REF_MISSING");
  }
  if (result.verificationRefs.length === 0) {
    reasons.add("LOWER_PLANE_VERIFICATION_REFS_MISSING");
  }
  if (!Number.isFinite(Date.parse(result.completedAt))) {
    reasons.add("DISPATCH_COMPLETED_AT_INVALID");
  }
  return [...reasons].sort();
}

export function isWakeAttemptTerminal(state: WakeAttemptState): boolean {
  return [
    "verified",
    "failed_no_effect",
    "reconciled_effect_absent",
    "reconciled_effect_verified",
    "held",
    "cancelled",
  ].includes(state);
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function normalizeIso(value: string, name: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be an ISO-8601 timestamp.`);
  return new Date(parsed).toISOString();
}
