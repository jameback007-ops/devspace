import { createHash } from "node:crypto";

export const EXECUTION_COORDINATION_AUTHORITY = {
  authority: "executor_local_coordination_only",
  canonicalTaskAuthority: false,
  canonicalDecisionAuthority: false,
  writerLeaseAuthority: false,
  effectAuthority: false,
  publicationAuthority: false,
  memoryAuthority: false,
  transcriptCaptured: false,
  privateReasoningCaptured: false,
  completionInferredFromSilence: false,
} as const;

export const COORDINATION_PEER_PHASES = [
  "discovering",
  "working",
  "validating",
  "ready_for_integration",
  "integrating",
  "ready_for_publication",
  "publishing",
  "input_required",
  "paused",
  "terminal",
] as const;

export type CoordinationPeerPhase = typeof COORDINATION_PEER_PHASES[number];

export const COORDINATION_TASK_STATES = [
  "proposed",
  "submitted",
  "working",
  "input_required",
  "validating",
  "ready_for_integration",
  "integrating",
  "ready_for_publication",
  "publishing",
  "published",
  "completed",
  "failed",
  "cancelled",
  "rejected",
  "withdrawn",
  "superseded",
] as const;

export type CoordinationTaskState = typeof COORDINATION_TASK_STATES[number];

export const COORDINATION_EVENT_KINDS = [
  "announce",
  "finding",
  "question",
  "answer",
  "proposal",
  "counterproposal",
  "accept",
  "reject",
  "conflict",
  "task_offer",
  "handoff",
  "result",
  "status",
  "publication_handoff",
  "publication_accept",
  "publication_reject",
  "close",
] as const;

export type CoordinationEventKind = typeof COORDINATION_EVENT_KINDS[number];

export const COORDINATION_INTENT_KINDS = [
  "read_interest",
  "write_intent",
  "effect_intent",
  "publication_intent",
] as const;

export type CoordinationIntentKind = typeof COORDINATION_INTENT_KINDS[number];

export const COORDINATION_SURFACE_DOMAINS = [
  "repository",
  "module",
  "path",
  "api",
  "runtime",
  "effect",
  "publication",
  "canonical_state",
] as const;

export type CoordinationSurfaceDomain = typeof COORDINATION_SURFACE_DOMAINS[number];
export type CoordinationSurfaceMatch = "exact" | "prefix" | "semantic";

export const COORDINATION_BATON_KINDS = [
  "work",
  "integration",
  "publication",
] as const;

export type CoordinationBatonKind = typeof COORDINATION_BATON_KINDS[number];
export type CoordinationBatonState =
  | "offered"
  | "accepted"
  | "rejected"
  | "revoked"
  | "consumed"
  | "expired";

export type CoordinationPublicationMode =
  | "owner_only"
  | "delegated"
  | "any_eligible"
  | "prohibited";

export type CoordinationAdoptionMode =
  | "owner_only"
  | "participants"
  | "any_eligible"
  | "prohibited";

export type CoordinationVisibility = "participants" | "peers";

export interface CoordinationSurface {
  domain: CoordinationSurfaceDomain;
  ref: string;
  repositoryRef?: string;
  semanticKey?: string;
  match?: CoordinationSurfaceMatch;
}

export interface CoordinationCandidate {
  repositoryRef: string;
  baseSha: string;
  candidateSha: string;
  treeSha?: string;
  artifactRefs: string[];
  affectedSurfaces: CoordinationSurface[];
  producedAt: string;
}

export interface CoordinationPublicationPolicy {
  mode: CoordinationPublicationMode;
  eligibleCapabilities: string[];
}

export interface CoordinationOwnershipLineageEntry {
  scopeRef: string;
  enteredAt: string;
  mode: "initial" | "baton" | "orphan_reconciliation" | "orphan_adoption";
  handoffRef?: string;
  recoveryRef?: string;
  authorityReadbackRefs: string[];
  adoptionVerificationRefs: string[];
  effectReadbackRefs: string[];
}

export interface CoordinationPublicationAttempt {
  publisherScopeRef: string;
  expectedMainSha: string;
  publicationLeaseRef: string;
  effectKey: string;
  currentAuthorityStateRefs: string[];
  startedAt: string;
}

export interface CoordinationPeerCard {
  schemaVersion: 1;
  scopeRef: string;
  generation: number;
  missionRef: string;
  displayLabel?: string;
  phase: CoordinationPeerPhase;
  frontier: string;
  capabilities: string[];
  taskIds: string[];
  subjectRefs: string[];
  surfaceRefs: string[];
  recoveryRef?: string;
  publishedAt: string;
  heartbeatAt: string;
  expiresAt: string;
  freshness: "active" | "stale";
  authority: typeof EXECUTION_COORDINATION_AUTHORITY;
}

export interface CoordinationTask {
  schemaVersion: 1;
  taskId: string;
  contextId: string;
  parentTaskId?: string;
  supersedesTaskId?: string;
  ownerScopeRef: string;
  integrationOwnerScopeRef?: string;
  publisherScopeRef?: string;
  participantScopeRefs: string[];
  dependencyTaskIds: string[];
  externalAuthorityRefs: string[];
  ownershipLineage: CoordinationOwnershipLineageEntry[];
  missionRef: string;
  title?: string;
  subjectRefs: string[];
  state: CoordinationTaskState;
  revision: number;
  adoptionGeneration: number;
  adoptionMode: CoordinationAdoptionMode;
  visibility: CoordinationVisibility;
  publicationPolicy: CoordinationPublicationPolicy;
  candidate?: CoordinationCandidate;
  validationRefs: string[];
  unresolvedRefs: string[];
  blockerRefs: string[];
  recoveryRef?: string;
  publicationAttempt?: CoordinationPublicationAttempt;
  publicationReceiptRefs: string[];
  remoteReadbackRef?: string;
  createdAt: string;
  updatedAt: string;
  ownerLeaseExpiresAt: string;
  terminalAt?: string;
  authority: typeof EXECUTION_COORDINATION_AUTHORITY;
}

export interface CoordinationEvent {
  schemaVersion: 1;
  eventId: string;
  contextId: string;
  threadId: string;
  taskId?: string;
  replyToEventId?: string;
  senderScopeRef: string;
  targetScopeRefs: string[];
  kind: CoordinationEventKind;
  body: string;
  subjectRefs: string[];
  evidenceRefs: string[];
  artifactRefs: string[];
  createdAt: string;
  authority: typeof EXECUTION_COORDINATION_AUTHORITY;
}

export interface CoordinationIntent {
  schemaVersion: 1;
  intentId: string;
  contextId: string;
  taskId: string;
  ownerScopeRef: string;
  kind: CoordinationIntentKind;
  surfaces: CoordinationSurface[];
  state: "active" | "released" | "expired";
  revision: number;
  createdAt: string;
  renewedAt: string;
  expiresAt: string;
  releasedAt?: string;
  authority: typeof EXECUTION_COORDINATION_AUTHORITY;
}

export interface CoordinationBaton {
  schemaVersion: 1;
  batonId: string;
  taskId: string;
  contextId: string;
  kind: CoordinationBatonKind;
  state: CoordinationBatonState;
  revision: number;
  fromScopeRef: string;
  toScopeRef: string;
  expectedTaskRevision: number;
  candidateSha?: string;
  note?: string;
  evidenceRefs: string[];
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  respondedAt?: string;
  consumedAt?: string;
  authority: typeof EXECUTION_COORDINATION_AUTHORITY;
}

export type CoordinationConflictSeverity = "informational" | "advisory" | "blocking";
export type CoordinationConflictClass =
  | "read_write_visibility"
  | "write_overlap"
  | "semantic_overlap"
  | "effect_conflict"
  | "publication_conflict"
  | "effect_publication_conflict"
  | "publication_with_active_write";

export interface CoordinationConflict {
  schemaVersion: 1;
  conflictId: string;
  leftIntentId: string;
  rightIntentId: string;
  leftTaskId: string;
  rightTaskId: string;
  leftOwnerScopeRef: string;
  rightOwnerScopeRef: string;
  classification: CoordinationConflictClass;
  severity: CoordinationConflictSeverity;
  overlap: "exact" | "prefix" | "semantic" | "repository";
  leftSurface: CoordinationSurface;
  rightSurface: CoordinationSurface;
  requiredAction: "notify" | "negotiate" | "reconcile" | "serialize";
  blocksPublication: boolean;
  authority: typeof EXECUTION_COORDINATION_AUTHORITY;
}

export interface CoordinationOrphanAssessment {
  taskId: string;
  ownerScopeRef: string;
  ownerFreshness: "active" | "stale" | "missing";
  ownerLeaseExpired: boolean;
  externalAuthorityReconciliationRequired: boolean;
  disposition: "not_orphaned" | "adoptable" | "reconcile_only" | "prohibited";
  reasonCodes: string[];
  authority: typeof EXECUTION_COORDINATION_AUTHORITY;
}

export interface CoordinationPublicationPlanInput {
  publisherScopeRef: string;
  taskIds: string[];
  currentRepositoryRef?: string;
  currentMainSha?: string;
  publicationLeaseRef?: string;
}

export interface CoordinationPublicationPlan {
  schemaVersion: 1;
  decision: "HOLD" | "INTEGRATE" | "READY_TO_PUBLISH";
  publisherScopeRef: string;
  taskIds: string[];
  candidateShas: string[];
  reasonCodes: string[];
  blockingConflictIds: string[];
  requiresIntegrationCandidate: boolean;
  requiresCurrentMainReadback: boolean;
  requiresExternalPublicationLease: boolean;
  requiresCompareAndSwapPush: true;
  requiresRemoteReadback: true;
  authority: typeof EXECUTION_COORDINATION_AUTHORITY;
}

const TASK_TRANSITIONS: Record<CoordinationTaskState, ReadonlySet<CoordinationTaskState>> = {
  proposed: new Set(["submitted", "rejected", "withdrawn", "cancelled"]),
  submitted: new Set(["working", "rejected", "withdrawn", "cancelled"]),
  working: new Set([
    "input_required",
    "validating",
    "completed",
    "failed",
    "cancelled",
    "withdrawn",
    "superseded",
  ]),
  input_required: new Set(["working", "validating", "failed", "cancelled", "withdrawn"]),
  validating: new Set([
    "working",
    "ready_for_integration",
    "ready_for_publication",
    "completed",
    "failed",
    "cancelled",
  ]),
  ready_for_integration: new Set([
    "integrating",
    "ready_for_publication",
    "working",
    "cancelled",
    "superseded",
  ]),
  integrating: new Set([
    "input_required",
    "validating",
    "ready_for_publication",
    "failed",
    "cancelled",
  ]),
  ready_for_publication: new Set(["publishing", "working", "cancelled", "superseded"]),
  publishing: new Set(["published", "input_required", "failed"]),
  published: new Set(),
  completed: new Set(),
  failed: new Set(),
  cancelled: new Set(),
  rejected: new Set(),
  withdrawn: new Set(),
  superseded: new Set(),
};

export function isTerminalCoordinationTaskState(state: CoordinationTaskState): boolean {
  return TASK_TRANSITIONS[state].size === 0;
}

export function assertCoordinationTaskTransition(
  current: CoordinationTask,
  nextState: CoordinationTaskState,
): void {
  if (!TASK_TRANSITIONS[current.state].has(nextState)) {
    throw new Error(`Invalid coordination task transition: ${current.state} -> ${nextState}.`);
  }

  const currentOwnership = current.ownershipLineage.at(-1);
  if (!currentOwnership || currentOwnership.scopeRef !== current.ownerScopeRef) {
    throw new Error(
      "The coordination task ownership lineage does not match the current owner scope.",
    );
  }
  const transferredOwnership = currentOwnership.mode !== "initial";
  if (transferredOwnership
    && current.externalAuthorityRefs.length > 0
    && [
      "working",
      "validating",
      "ready_for_integration",
      "integrating",
      "ready_for_publication",
      "publishing",
      "published",
      "completed",
    ].includes(nextState)
    && (currentOwnership.authorityReadbackRefs.length === 0
      || currentOwnership.adoptionVerificationRefs.length === 0)) {
    throw new Error(
      `${nextState} requires externally verified authority readback and adoption evidence after ownership transfer.`,
    );
  }

  if (["ready_for_integration", "ready_for_publication", "publishing", "published"].includes(nextState)) {
    if (!current.candidate) {
      throw new Error(`${nextState} requires an exact candidate identity.`);
    }
    if (current.validationRefs.length === 0) {
      throw new Error(`${nextState} requires at least one validation reference.`);
    }
    if (current.blockerRefs.length > 0) {
      throw new Error(`${nextState} is blocked while blocker references remain.`);
    }
  }

  if (["ready_for_publication", "publishing", "published"].includes(nextState)
    && current.unresolvedRefs.length > 0) {
    throw new Error(`${nextState} requires all unresolved references to be reconciled.`);
  }

  if (nextState === "publishing") {
    if (!current.publisherScopeRef) {
      throw new Error("publishing requires an explicitly authorized publisher scope.");
    }
    const attempt = current.publicationAttempt;
    if (!attempt
      || attempt.publisherScopeRef !== current.publisherScopeRef
      || !attempt.expectedMainSha
      || !attempt.publicationLeaseRef
      || !attempt.effectKey
      || attempt.currentAuthorityStateRefs.length === 0) {
      throw new Error(
        "publishing requires exact current-main readback, an external publication lease, an effect key, and authority-state references.",
      );
    }
  }

  if (nextState === "published") {
    if (current.publicationReceiptRefs.length === 0 || !current.remoteReadbackRef) {
      throw new Error("published requires publication receipts and exact remote readback evidence.");
    }
  }

  if (nextState === "completed" && (current.blockerRefs.length > 0 || current.unresolvedRefs.length > 0)) {
    throw new Error("completed requires blockers and unresolved references to be empty.");
  }
}

interface SurfaceOverlap {
  overlap: CoordinationConflict["overlap"];
  semantic: boolean;
}

export function assessCoordinationConflicts(
  intents: CoordinationIntent[],
): CoordinationConflict[] {
  const active = intents.filter((intent) => intent.state === "active");
  const conflicts: CoordinationConflict[] = [];
  for (let leftIndex = 0; leftIndex < active.length; leftIndex += 1) {
    const left = active[leftIndex];
    if (!left) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < active.length; rightIndex += 1) {
      const right = active[rightIndex];
      if (!right || left.ownerScopeRef === right.ownerScopeRef) continue;
      for (const leftSurface of left.surfaces) {
        for (const rightSurface of right.surfaces) {
          const overlap = surfaceOverlap(leftSurface, rightSurface);
          if (!overlap) continue;
          const classification = classifyIntentConflict(left.kind, right.kind, overlap.semantic);
          if (!classification) continue;
          const [leftIntentId, rightIntentId] = [left.intentId, right.intentId].sort();
          const conflictId = `ccf_${sha256([
            leftIntentId,
            rightIntentId,
            canonicalJson(leftSurface),
            canonicalJson(rightSurface),
            classification.classification,
          ].join("\n")).slice(0, 32)}`;
          conflicts.push({
            schemaVersion: 1,
            conflictId,
            leftIntentId: left.intentId,
            rightIntentId: right.intentId,
            leftTaskId: left.taskId,
            rightTaskId: right.taskId,
            leftOwnerScopeRef: left.ownerScopeRef,
            rightOwnerScopeRef: right.ownerScopeRef,
            classification: classification.classification,
            severity: classification.severity,
            overlap: overlap.overlap,
            leftSurface,
            rightSurface,
            requiredAction: classification.requiredAction,
            blocksPublication: classification.blocksPublication,
            authority: EXECUTION_COORDINATION_AUTHORITY,
          });
        }
      }
    }
  }
  return dedupeBy(conflicts, (conflict) => conflict.conflictId)
    .sort((left, right) => left.conflictId.localeCompare(right.conflictId));
}

export function buildCoordinationPublicationPlan(
  input: CoordinationPublicationPlanInput,
  tasks: CoordinationTask[],
  conflicts: CoordinationConflict[],
  publisherCard: CoordinationPeerCard | undefined,
): CoordinationPublicationPlan {
  const reasonCodes = new Set<string>();
  const taskIds = [...new Set(input.taskIds)].sort();
  const selected = taskIds
    .map((taskId) => tasks.find((task) => task.taskId === taskId))
    .filter((task): task is CoordinationTask => task !== undefined);
  if (selected.length !== taskIds.length) reasonCodes.add("TASK_NOT_FOUND");
  if (!publisherCard || publisherCard.freshness !== "active") {
    reasonCodes.add("PUBLISHER_PEER_CARD_NOT_ACTIVE");
  }

  for (const task of selected) {
    if (task.state !== "ready_for_publication") {
      reasonCodes.add(`TASK_NOT_READY_FOR_PUBLICATION:${task.taskId}`);
    }
    if (!task.candidate) {
      reasonCodes.add(`TASK_CANDIDATE_MISSING:${task.taskId}`);
      continue;
    }
    if (task.validationRefs.length === 0) {
      reasonCodes.add(`TASK_VALIDATION_MISSING:${task.taskId}`);
    }
    if (task.blockerRefs.length > 0 || task.unresolvedRefs.length > 0) {
      reasonCodes.add(`TASK_UNRESOLVED:${task.taskId}`);
    }
    if (!publisherAuthorized(task, input.publisherScopeRef, publisherCard)) {
      reasonCodes.add(`PUBLISHER_NOT_AUTHORIZED:${task.taskId}`);
    }
    if (input.currentRepositoryRef
      && task.candidate.repositoryRef !== input.currentRepositoryRef) {
      reasonCodes.add(`REPOSITORY_MISMATCH:${task.taskId}`);
    }
  }

  const selectedTaskIds = new Set(selected.map((task) => task.taskId));
  const blockingConflicts = conflicts.filter((conflict) => conflict.blocksPublication
    && (selectedTaskIds.has(conflict.leftTaskId) || selectedTaskIds.has(conflict.rightTaskId)));
  for (const conflict of blockingConflicts) {
    reasonCodes.add(`BLOCKING_CONFLICT:${conflict.conflictId}`);
  }

  const candidates = selected
    .map((task) => task.candidate)
    .filter((candidate): candidate is CoordinationCandidate => candidate !== undefined);
  const requiresIntegrationCandidate = candidates.length > 1;
  if (requiresIntegrationCandidate) reasonCodes.add("MULTIPLE_CANDIDATES_REQUIRE_INTEGRATION");

  if (!input.currentMainSha) {
    reasonCodes.add("CURRENT_MAIN_UNVERIFIED");
  } else if (candidates.length === 1 && candidates[0]?.baseSha !== input.currentMainSha) {
    reasonCodes.add("CANDIDATE_BASE_DOES_NOT_MATCH_CURRENT_MAIN");
  }
  if (!input.publicationLeaseRef) reasonCodes.add("EXTERNAL_PUBLICATION_LEASE_REQUIRED");

  const blockingReasonCodes = [...reasonCodes].filter((reason) =>
    reason !== "MULTIPLE_CANDIDATES_REQUIRE_INTEGRATION");
  let decision: CoordinationPublicationPlan["decision"] = "HOLD";
  if (requiresIntegrationCandidate
    && blockingReasonCodes.every((reason) => reason === "CURRENT_MAIN_UNVERIFIED"
      || reason === "EXTERNAL_PUBLICATION_LEASE_REQUIRED")) {
    decision = "INTEGRATE";
  } else if (!requiresIntegrationCandidate && reasonCodes.size === 0) {
    decision = "READY_TO_PUBLISH";
  }

  return {
    schemaVersion: 1,
    decision,
    publisherScopeRef: input.publisherScopeRef,
    taskIds,
    candidateShas: candidates.map((candidate) => candidate.candidateSha).sort(),
    reasonCodes: [...reasonCodes].sort(),
    blockingConflictIds: blockingConflicts.map((conflict) => conflict.conflictId).sort(),
    requiresIntegrationCandidate,
    requiresCurrentMainReadback: !input.currentMainSha,
    requiresExternalPublicationLease: !input.publicationLeaseRef,
    requiresCompareAndSwapPush: true,
    requiresRemoteReadback: true,
    authority: EXECUTION_COORDINATION_AUTHORITY,
  };
}

export function publisherAuthorized(
  task: CoordinationTask,
  publisherScopeRef: string,
  publisherCard: CoordinationPeerCard | undefined,
): boolean {
  if (task.publicationPolicy.mode === "prohibited") return false;
  if (task.publisherScopeRef) return task.publisherScopeRef === publisherScopeRef;
  if (task.publicationPolicy.mode === "owner_only") {
    return task.ownerScopeRef === publisherScopeRef;
  }
  if (task.publicationPolicy.mode === "delegated") return false;
  if (!publisherCard || publisherCard.scopeRef !== publisherScopeRef) return false;
  return task.publicationPolicy.eligibleCapabilities.every((capability) =>
    publisherCard.capabilities.includes(capability));
}

function surfaceOverlap(
  left: CoordinationSurface,
  right: CoordinationSurface,
): SurfaceOverlap | undefined {
  if (left.semanticKey && right.semanticKey && left.semanticKey === right.semanticKey) {
    return { overlap: "semantic", semantic: true };
  }

  const leftRepository = left.domain === "repository" ? left.ref : left.repositoryRef;
  const rightRepository = right.domain === "repository" ? right.ref : right.repositoryRef;
  if (leftRepository && rightRepository && leftRepository !== rightRepository) return undefined;

  if (left.domain === "repository" && rightRepository === left.ref) {
    return { overlap: "repository", semantic: false };
  }
  if (right.domain === "repository" && leftRepository === right.ref) {
    return { overlap: "repository", semantic: false };
  }
  if (left.domain !== right.domain) return undefined;
  if (left.ref === right.ref) {
    return {
      overlap: left.match === "semantic" || right.match === "semantic" ? "semantic" : "exact",
      semantic: left.match === "semantic" || right.match === "semantic",
    };
  }
  if (left.domain === "path" || left.domain === "module") {
    if (isSegmentPrefix(left.ref, right.ref) || isSegmentPrefix(right.ref, left.ref)) {
      return { overlap: "prefix", semantic: false };
    }
  }
  return undefined;
}

function classifyIntentConflict(
  left: CoordinationIntentKind,
  right: CoordinationIntentKind,
  semantic: boolean,
): Omit<CoordinationConflict, keyof {
  schemaVersion: never;
  conflictId: never;
  leftIntentId: never;
  rightIntentId: never;
  leftTaskId: never;
  rightTaskId: never;
  leftOwnerScopeRef: never;
  rightOwnerScopeRef: never;
  overlap: never;
  leftSurface: never;
  rightSurface: never;
  authority: never;
}> | undefined {
  const kinds = new Set([left, right]);
  if (kinds.size === 1 && kinds.has("read_interest")) return undefined;
  if (kinds.has("read_interest") && kinds.has("write_intent")) {
    return {
      classification: semantic ? "semantic_overlap" : "read_write_visibility",
      severity: "informational",
      requiredAction: "notify",
      blocksPublication: false,
    };
  }
  if (kinds.size === 1 && kinds.has("write_intent")) {
    return {
      classification: semantic ? "semantic_overlap" : "write_overlap",
      severity: "advisory",
      requiredAction: "negotiate",
      blocksPublication: false,
    };
  }
  if (kinds.has("publication_intent") && kinds.has("write_intent")) {
    return {
      classification: "publication_with_active_write",
      severity: "blocking",
      requiredAction: "reconcile",
      blocksPublication: true,
    };
  }
  if (kinds.size === 1 && kinds.has("publication_intent")) {
    return {
      classification: "publication_conflict",
      severity: "blocking",
      requiredAction: "serialize",
      blocksPublication: true,
    };
  }
  if (kinds.has("effect_intent") && kinds.has("publication_intent")) {
    return {
      classification: "effect_publication_conflict",
      severity: "blocking",
      requiredAction: "serialize",
      blocksPublication: true,
    };
  }
  if (kinds.has("effect_intent")) {
    return {
      classification: "effect_conflict",
      severity: "blocking",
      requiredAction: "serialize",
      blocksPublication: true,
    };
  }
  if (kinds.has("read_interest") && kinds.has("publication_intent")) {
    return {
      classification: "read_write_visibility",
      severity: "informational",
      requiredAction: "notify",
      blocksPublication: false,
    };
  }
  return undefined;
}

function isSegmentPrefix(prefix: string, candidate: string): boolean {
  const normalizedPrefix = prefix.replace(/\/+$/, "");
  return candidate.startsWith(`${normalizedPrefix}/`);
}

function canonicalJson(value: unknown): string {
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

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function dedupeBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const value = key(item);
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}
