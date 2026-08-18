import { createHash, randomUUID } from "node:crypto";

export type InteractionSurface =
  | "api"
  | "shell"
  | "playwright"
  | "desktop_accessibility"
  | "vision_pointer";

export type InteractionTargetKind =
  | "service"
  | "terminal"
  | "browser"
  | "native_desktop"
  | "remote_desktop";

export type InteractionEffectClass =
  | "read_only"
  | "reversible"
  | "irreversible";

export type InteractionActionKind =
  | "inspect"
  | "navigate"
  | "click"
  | "type"
  | "select"
  | "upload"
  | "download"
  | "execute"
  | "window_control"
  | "custom";

export type InteractionLifecycleState =
  | "needs_observation"
  | "ready"
  | "acting"
  | "needs_verification"
  | "verified"
  | "held"
  | "indeterminate"
  | "failed"
  | "cancelled";

export type InteractionEvidenceKind =
  | "accessibility_snapshot"
  | "dom_snapshot"
  | "window_tree"
  | "screenshot"
  | "trace"
  | "video"
  | "network"
  | "terminal"
  | "api_response"
  | "other";

export interface InteractionAdapterCapabilities {
  observe: boolean;
  semanticTargeting: boolean;
  coordinateTargeting: boolean;
  verify: boolean;
  boundedTimeout: boolean;
  screenshotEvidence: boolean;
  traceEvidence: boolean;
  persistentSession: boolean;
  isolatedSession: boolean;
  visibleUi: boolean;
  fileTransfer: boolean;
}

export interface InteractionAdapterDescriptor {
  id: string;
  surface: InteractionSurface;
  available: boolean;
  targetKinds: InteractionTargetKind[];
  supportedActionKinds: InteractionActionKind[];
  minimumEffectClassByAction: Partial<
    Record<InteractionActionKind, InteractionEffectClass>
  >;
  capabilities: InteractionAdapterCapabilities;
  concurrency: "shared" | "isolated" | "exclusive";
  busy?: boolean;
  sessionRef?: string;
  unavailableReason?: string;
}

export interface InteractionIntent {
  targetKind: InteractionTargetKind;
  effectClass: InteractionEffectClass;
  requiredCapabilities?: Array<keyof InteractionAdapterCapabilities>;
  visibleUiRequired?: boolean;
  existingSessionRequired?: boolean;
  allowCoordinateFallback?: boolean;
}

export interface InteractionRouteCandidate {
  adapterId: string;
  surface: InteractionSurface;
  eligible: boolean;
  rank: number;
  reasons: string[];
}

export interface InteractionRoute {
  selected?: InteractionAdapterDescriptor;
  candidates: InteractionRouteCandidate[];
  heldReason?: string;
  policy: ReturnType<typeof interactionPolicy>;
}

export interface InteractionSessionIdentity {
  sessionRef?: string;
  executionScopeRef: string;
  workspaceId?: string;
  missionRef?: string;
}

export interface InteractionBinding {
  adapterId: string;
  surface: InteractionSurface;
  backendSessionRef: string;
  contextRef: string;
  targetKind: InteractionTargetKind;
}

export interface InteractionEvidenceRef {
  kind: InteractionEvidenceKind;
  ref: string;
  sha256?: string;
  capturedAt?: string;
  sensitive?: boolean;
}

export interface InteractionSensitiveStateRef {
  kind: "browser_profile" | "storage_state" | "cookie_jar" | "credential_session";
  ref: string;
  sha256?: string;
}

export interface InteractionViewport {
  width: number;
  height: number;
  deviceScaleFactor?: number;
}

export interface InteractionFrontier {
  url?: string;
  title?: string;
  windowRef?: string;
  focusedTargetRef?: string;
  modalRef?: string;
  navigationRef?: string;
}

export interface InteractionObservationInput {
  binding: InteractionBinding;
  stateDigestSha256: string;
  observedAt?: string;
  evidence: InteractionEvidenceRef[];
  frontier?: InteractionFrontier;
  viewport?: InteractionViewport;
  sensitiveStateRefs?: InteractionSensitiveStateRef[];
}

export interface InteractionObservation extends InteractionObservationInput {
  observationId: string;
  observedAt: string;
}

export interface InteractionSemanticTarget {
  strategy: "semantic";
  targetRef?: string;
  role?: string;
  accessibleName?: string;
  testId?: string;
  selector?: string;
}

export interface InteractionCoordinateTarget {
  strategy: "coordinate";
  x: number;
  y: number;
  viewportWidth: number;
  viewportHeight: number;
  semanticFallbackExhausted: true;
  sourceObservationId: string;
}

export type InteractionTarget =
  | InteractionSemanticTarget
  | InteractionCoordinateTarget;

export interface InteractionPostcondition {
  kind:
    | "element_visible"
    | "text_visible"
    | "url_matches"
    | "value_equals"
    | "window_present"
    | "process_state"
    | "custom";
  expected: string;
  targetRef?: string;
}

export interface InteractionApproval {
  state: "not_required" | "approved" | "denied";
  ref?: string;
  actorRef?: string;
}

export interface InteractionApprovalVerificationInput {
  identity: InteractionCheckpoint["identity"];
  binding: InteractionBinding;
  actionKind: InteractionActionKind;
  effectClass: InteractionEffectClass;
  approval: InteractionApproval;
  payloadDigestSha256?: string;
}

export interface InteractionApprovalVerification {
  verified: boolean;
  verificationRef?: string;
  authorityReadbackRef?: string;
}

export type InteractionApprovalVerifier = (
  input: InteractionApprovalVerificationInput,
) => InteractionApprovalVerification;

export interface InteractionReconciliationVerificationInput {
  identity: InteractionCheckpoint["identity"];
  action: InteractionPreparedAction;
  resolution: "effect_absent" | "effect_verified";
  binding: InteractionBinding;
  postStateDigestSha256: string;
  evidence: InteractionEvidenceRef[];
}

export interface InteractionReconciliationVerification {
  verified: boolean;
  verificationRef?: string;
  authorityReadbackRef?: string;
}

export type InteractionReconciliationVerifier = (
  input: InteractionReconciliationVerificationInput,
) => InteractionReconciliationVerification;

export interface InteractionActionRequest {
  idempotencyKey: string;
  kind: InteractionActionKind;
  effectClass: InteractionEffectClass;
  target: InteractionTarget;
  expectedObservationId: string;
  expectedPreStateDigestSha256: string;
  payloadDigestSha256?: string;
  declaredIdempotent?: boolean;
  approval: InteractionApproval;
  postconditions?: InteractionPostcondition[];
  timeoutMs?: number;
}

export interface InteractionPreparedAction {
  actionId: string;
  attempt: number;
  kind: InteractionActionRequest["kind"];
  effectClass: InteractionEffectClass;
  target: InteractionTarget;
  observationId: string;
  expectedPreStateDigestSha256: string;
  requestDigestSha256: string;
  idempotencyKeyDigestSha256: string;
  payloadDigestSha256?: string;
  declaredIdempotent: boolean;
  approvalRef?: string;
  approvalActorRef?: string;
  approvalVerificationRef?: string;
  approvalAuthorityReadbackRef?: string;
  postconditions: InteractionPostcondition[];
  timeoutMs: number;
  binding: InteractionBinding;
  startedAt: string;
}

export interface InteractionActionOutcome {
  actionId: string;
  status: "succeeded" | "failed" | "unknown";
  noEffectProven?: boolean;
  backendReceiptRef?: string;
  detailCode?: string;
  evidence?: InteractionEvidenceRef[];
}

export interface InteractionVerificationResult {
  actionId: string;
  verified: boolean;
  binding: InteractionBinding;
  postStateDigestSha256?: string;
  verifiedAt?: string;
  detailCode?: string;
  evidence: InteractionEvidenceRef[];
  frontier?: InteractionFrontier;
  viewport?: InteractionViewport;
}

export interface InteractionHold {
  code: string;
  message: string;
  recoverable: boolean;
  recordedAt: string;
}

export interface InteractionVerificationReceipt {
  actionId: string;
  verifiedAt: string;
  postStateDigestSha256: string;
  evidence: InteractionEvidenceRef[];
}

export interface InteractionReconciliationReceipt {
  actionId: string;
  resolution: "effect_absent" | "effect_verified";
  reconciledAt: string;
  postStateDigestSha256: string;
  evidence: InteractionEvidenceRef[];
  verificationRef: string;
  authorityReadbackRef: string;
}

interface InteractionIdempotencyEntry {
  keyDigestSha256: string;
  requestDigestSha256: string;
  action: InteractionPreparedAction;
  status:
    | "acting"
    | "needs_verification"
    | "verified"
    | "failed_no_effect"
    | "indeterminate";
}

export interface InteractionCheckpoint {
  schemaVersion: 1;
  identity: Required<Pick<InteractionSessionIdentity, "sessionRef" | "executionScopeRef">>
    & Pick<InteractionSessionIdentity, "workspaceId" | "missionRef">;
  state: InteractionLifecycleState;
  binding?: InteractionBinding;
  observation?: InteractionObservation;
  pendingAction?: InteractionPreparedAction;
  verification?: InteractionVerificationReceipt;
  reconciliation?: InteractionReconciliationReceipt;
  hold?: InteractionHold;
  idempotencyEntries: InteractionIdempotencyEntry[];
  updatedAt: string;
  nextAction: string;
  policy: ReturnType<typeof interactionPolicy>;
}

export interface InteractionSessionOptions {
  now?: () => number;
  idFactory?: (prefix: "ixs" | "obs" | "act") => string;
  approvalVerifier?: InteractionApprovalVerifier;
  reconciliationVerifier?: InteractionReconciliationVerifier;
}

export interface InteractionActionStartResult {
  started: boolean;
  idempotentReplay: boolean;
  action: InteractionPreparedAction;
  checkpoint: InteractionCheckpoint;
}

export interface InteractionRecoveryAssessment {
  state: InteractionLifecycleState;
  disposition:
    | "continue"
    | "reobserve"
    | "observe_and_reconcile"
    | "resolve_indeterminate";
  reason: string;
  replayAllowed: boolean;
  checkpoint: InteractionCheckpoint;
}

export interface InteractionAdapter {
  descriptor: InteractionAdapterDescriptor;
  observe(input: {
    identity: InteractionCheckpoint["identity"];
    intent: InteractionIntent;
    timeoutMs: number;
  }): Promise<InteractionObservationInput>;
  act(action: InteractionPreparedAction): Promise<InteractionActionOutcome>;
  verify(
    action: InteractionPreparedAction,
    outcome: InteractionActionOutcome,
  ): Promise<InteractionVerificationResult>;
}

export interface InteractionExecutionResult {
  route: InteractionRoute;
  checkpoint: InteractionCheckpoint;
  action?: InteractionPreparedAction;
  outcome?: InteractionActionOutcome;
  idempotentReplay?: boolean;
}

const SURFACE_RANK: Record<InteractionSurface, number> = {
  api: 0,
  shell: 1,
  playwright: 2,
  desktop_accessibility: 3,
  vision_pointer: 4,
};

const EFFECT_CLASS_RANK: Record<InteractionEffectClass, number> = {
  read_only: 0,
  reversible: 1,
  irreversible: 2,
};

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 5 * 60 * 1_000;

export class InteractionPolicyError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "InteractionPolicyError";
  }
}

export function interactionPolicy() {
  return {
    authority: "executor_local_interaction_control_only",
    canonicalTaskAuthority: false,
    canonicalDecisionAuthority: false,
    writerLeaseAuthority: false,
    effectOutcomeAuthority: false,
    publicationAuthority: false,
    rawCredentialCaptureAllowed: false,
    semanticTargetingPreferred: true,
    coordinateTargetingFallbackOnly: true,
    actionRequiresCurrentObservation: true,
    mutatingActionRequiresApproval: true,
    successfulActionRequiresVerification: true,
    unknownOutcomeReplayAllowed: false,
  } as const;
}

export function selectInteractionRoute(
  intent: InteractionIntent,
  adapters: InteractionAdapterDescriptor[],
): InteractionRoute {
  const requiredCapabilities = intent.requiredCapabilities ?? [];
  const candidates = adapters.map((adapter): InteractionRouteCandidate => {
    const reasons: string[] = [];
    if (!adapter.available) {
      reasons.push(adapter.unavailableReason ?? "adapter_unavailable");
    }
    if (!adapter.targetKinds.includes(intent.targetKind)) {
      reasons.push("target_kind_unsupported");
    }
    if (!adapter.capabilities.observe || !adapter.capabilities.verify) {
      reasons.push("observe_verify_loop_incomplete");
    }
    if (!adapter.capabilities.boundedTimeout) {
      reasons.push("bounded_timeout_contract_missing");
    }
    if (
      adapter.supportedActionKinds.length === 0
      || adapter.supportedActionKinds.some(
        (kind) => !adapter.minimumEffectClassByAction[kind],
      )
    ) {
      reasons.push("adapter_action_policy_incomplete");
    }
    for (const capability of requiredCapabilities) {
      if (!adapter.capabilities[capability]) {
        reasons.push(`required_capability_missing:${capability}`);
      }
    }
    if (intent.visibleUiRequired && !adapter.capabilities.visibleUi) {
      reasons.push("visible_ui_required");
    }
    if (
      intent.existingSessionRequired
      && !adapter.capabilities.persistentSession
      && !adapter.sessionRef
    ) {
      reasons.push("existing_session_required");
    }
    if (
      adapter.surface === "vision_pointer"
      && intent.allowCoordinateFallback !== true
    ) {
      reasons.push("coordinate_fallback_not_authorized");
    }
    if (adapter.concurrency === "exclusive" && adapter.busy) {
      reasons.push("exclusive_adapter_busy");
    }
    return {
      adapterId: adapter.id,
      surface: adapter.surface,
      eligible: reasons.length === 0,
      rank: SURFACE_RANK[adapter.surface],
      reasons,
    };
  });

  const selectedCandidate = [...candidates]
    .filter((candidate) => candidate.eligible)
    .sort((left, right) => left.rank - right.rank
      || left.adapterId.localeCompare(right.adapterId))[0];
  const selected = selectedCandidate
    ? adapters.find((adapter) => adapter.id === selectedCandidate.adapterId)
    : undefined;

  return {
    selected: selected ? structuredClone(selected) : undefined,
    candidates,
    heldReason: selected ? undefined : "no_eligible_interaction_adapter",
    policy: interactionPolicy(),
  };
}

export class InteractionSession {
  private readonly now: () => number;
  private readonly idFactory: NonNullable<InteractionSessionOptions["idFactory"]>;
  private readonly approvalVerifier: InteractionApprovalVerifier | undefined;
  private readonly reconciliationVerifier:
    | InteractionReconciliationVerifier
    | undefined;
  private readonly identity: InteractionCheckpoint["identity"];
  private state: InteractionLifecycleState = "needs_observation";
  private binding: InteractionBinding | undefined;
  private observation: InteractionObservation | undefined;
  private pendingAction: InteractionPreparedAction | undefined;
  private verification: InteractionVerificationReceipt | undefined;
  private reconciliation: InteractionReconciliationReceipt | undefined;
  private hold: InteractionHold | undefined;
  private readonly idempotency = new Map<string, InteractionIdempotencyEntry>();
  private updatedAtMs: number;

  constructor(
    identity: InteractionSessionIdentity,
    options: InteractionSessionOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.idFactory = options.idFactory ?? ((prefix) => `${prefix}_${randomUUID().replaceAll("-", "")}`);
    this.approvalVerifier = options.approvalVerifier;
    this.reconciliationVerifier = options.reconciliationVerifier;
    this.identity = {
      sessionRef: identity.sessionRef ?? this.idFactory("ixs"),
      executionScopeRef: boundedPattern(
        identity.executionScopeRef,
        "executionScopeRef",
        /^[a-f0-9]{16}$/,
      ),
      ...(identity.workspaceId
        ? { workspaceId: boundedText(identity.workspaceId, "workspaceId", 200) }
        : {}),
      ...(identity.missionRef
        ? { missionRef: boundedText(identity.missionRef, "missionRef", 1_000) }
        : {}),
    };
    this.updatedAtMs = this.now();
  }

  static restore(
    checkpoint: InteractionCheckpoint,
    options: InteractionSessionOptions = {},
  ): InteractionSession {
    if (checkpoint.schemaVersion !== 1) {
      throw new InteractionPolicyError(
        "unsupported_checkpoint_schema",
        `Unsupported interaction checkpoint schema: ${String(checkpoint.schemaVersion)}`,
      );
    }
    const session = new InteractionSession(checkpoint.identity, options);
    session.state = checkpoint.state;
    session.binding = checkpoint.binding
      ? validatedBinding(checkpoint.binding)
      : undefined;
    session.observation = checkpoint.observation
      ? validatedObservation(checkpoint.observation)
      : undefined;
    session.pendingAction = checkpoint.pendingAction
      ? validatedPreparedAction(checkpoint.pendingAction)
      : undefined;
    session.verification = checkpoint.verification
      ? validatedVerificationReceipt(checkpoint.verification)
      : undefined;
    session.reconciliation = checkpoint.reconciliation
      ? validatedReconciliationReceipt(checkpoint.reconciliation)
      : undefined;
    session.hold = checkpoint.hold
      ? validatedHold(checkpoint.hold)
      : undefined;
    for (const entry of checkpoint.idempotencyEntries) {
      const validated = validatedIdempotencyEntry(entry);
      if (session.idempotency.has(validated.keyDigestSha256)) {
        throw new InteractionPolicyError(
          "duplicate_idempotency_entry",
          "Interaction checkpoint contains duplicate idempotency entries.",
        );
      }
      session.idempotency.set(validated.keyDigestSha256, validated);
    }
    session.updatedAtMs = Date.parse(checkpoint.updatedAt);
    if (!Number.isFinite(session.updatedAtMs)) session.updatedAtMs = session.now();
    session.assertCoherent();
    return session;
  }

  recordObservation(input: InteractionObservationInput): InteractionCheckpoint {
    if (this.state === "acting" || this.state === "needs_verification") {
      throw new InteractionPolicyError(
        "pending_action_requires_resolution",
        "A pending action must be verified or reconciled before a new ordinary observation can advance the loop.",
      );
    }
    const observation = validatedObservation({
      ...input,
      observationId: this.idFactory("obs"),
      observedAt: input.observedAt ?? this.timestamp(),
    });
    this.binding = observation.binding;
    this.observation = observation;
    this.verification = undefined;
    this.touch();
    if (this.state !== "indeterminate") {
      this.state = "ready";
      this.hold = undefined;
    }
    return this.checkpoint();
  }

  beginAction(
    request: InteractionActionRequest,
    adapter: InteractionAdapterDescriptor,
  ): InteractionActionStartResult {
    if (this.state === "indeterminate") {
      throw new InteractionPolicyError(
        "indeterminate_effect_requires_reconciliation",
        "The previous interaction effect is indeterminate. Reconcile it before any replay or new action.",
      );
    }
    const observation = this.requireObservation();
    const binding = this.requireBinding();
    validateAdapterForBinding(adapter, binding);

    const idempotencyKey = boundedText(
      request.idempotencyKey,
      "idempotencyKey",
      200,
    );
    const keyDigestSha256 = digest(idempotencyKey);
    const requestDigestSha256 = digest(actionDigestInput(request, binding));
    const existing = this.idempotency.get(keyDigestSha256);
    if (existing && existing.requestDigestSha256 !== requestDigestSha256) {
      throw new InteractionPolicyError(
        "idempotency_payload_mismatch",
        "The idempotency key was already used for a different interaction payload.",
      );
    }
    if (existing?.status === "verified") {
      return {
        started: false,
        idempotentReplay: true,
        action: structuredClone(existing.action),
        checkpoint: this.checkpoint(),
      };
    }
    if (
      existing
      && existing.status !== "failed_no_effect"
    ) {
      throw new InteractionPolicyError(
        "idempotency_attempt_not_replayable",
        `The prior idempotent attempt is ${existing.status}; blind replay is not allowed.`,
      );
    }
    if (
      existing?.status === "failed_no_effect"
      && request.effectClass !== "read_only"
      && request.declaredIdempotent !== true
    ) {
      throw new InteractionPolicyError(
        "retry_requires_idempotent_action",
        "A mutating action may be retried only after no-effect proof and an explicit idempotent declaration.",
      );
    }
    if (this.state !== "ready" && this.state !== "verified") {
      throw new InteractionPolicyError(
        "interaction_not_ready",
        `Interaction session is ${this.state}; a current observation is required before acting.`,
      );
    }
    const approvalVerification = validateActionRequest(
      request,
      observation,
      adapter,
      this.identity,
      binding,
      this.approvalVerifier,
    );

    const action: InteractionPreparedAction = {
      actionId: this.idFactory("act"),
      attempt: existing ? existing.action.attempt + 1 : 1,
      kind: request.kind,
      effectClass: request.effectClass,
      target: structuredClone(request.target),
      observationId: observation.observationId,
      expectedPreStateDigestSha256: observation.stateDigestSha256,
      requestDigestSha256,
      idempotencyKeyDigestSha256: keyDigestSha256,
      ...(request.payloadDigestSha256
        ? { payloadDigestSha256: normalizedSha256(request.payloadDigestSha256, "payloadDigestSha256") }
        : {}),
      declaredIdempotent: request.declaredIdempotent === true,
      ...(request.approval.ref
        ? { approvalRef: boundedOpaqueRef(request.approval.ref, "approval.ref", 1_000) }
        : {}),
      ...(request.approval.actorRef
        ? { approvalActorRef: boundedText(request.approval.actorRef, "approval.actorRef", 1_000) }
        : {}),
      ...(approvalVerification?.verificationRef
        ? {
            approvalVerificationRef: boundedOpaqueRef(
              approvalVerification.verificationRef,
              "approval.verificationRef",
              2_000,
            ),
          }
        : {}),
      ...(approvalVerification?.authorityReadbackRef
        ? {
            approvalAuthorityReadbackRef: boundedOpaqueRef(
              approvalVerification.authorityReadbackRef,
              "approval.authorityReadbackRef",
              2_000,
            ),
          }
        : {}),
      postconditions: structuredClone(request.postconditions ?? []),
      timeoutMs: boundedTimeout(request.timeoutMs),
      binding: structuredClone(binding),
      startedAt: this.timestamp(),
    };

    this.pendingAction = action;
    this.verification = undefined;
    this.hold = undefined;
    this.state = "acting";
    this.idempotency.set(keyDigestSha256, {
      keyDigestSha256,
      requestDigestSha256,
      action,
      status: "acting",
    });
    this.touch();
    return {
      started: true,
      idempotentReplay: false,
      action: structuredClone(action),
      checkpoint: this.checkpoint(),
    };
  }

  recordActionOutcome(outcome: InteractionActionOutcome): InteractionCheckpoint {
    const action = this.requirePendingAction("acting");
    if (outcome.actionId !== action.actionId) {
      throw new InteractionPolicyError(
        "action_identity_mismatch",
        "The adapter outcome does not belong to the pending interaction action.",
      );
    }
    const evidence = validatedEvidence(outcome.evidence ?? []);
    const entry = this.requireIdempotencyEntry(action.idempotencyKeyDigestSha256);

    if (outcome.status === "unknown") {
      entry.status = "indeterminate";
      this.state = "indeterminate";
      this.hold = this.createHold(
        outcome.detailCode ?? "action_outcome_unknown",
        "The adapter lost a definitive action result. Observe and reconcile the real target before any retry.",
        true,
      );
    } else if (outcome.status === "failed") {
      if (outcome.noEffectProven === true) {
        entry.status = "failed_no_effect";
        this.pendingAction = undefined;
        this.state = "ready";
        this.hold = this.createHold(
          outcome.detailCode ?? "action_failed_no_effect",
          "The action failed with explicit no-effect proof. A policy-qualified retry may be prepared from the current observation.",
          true,
        );
      } else {
        entry.status = "indeterminate";
        this.state = "indeterminate";
        this.hold = this.createHold(
          outcome.detailCode ?? "failed_effect_not_disproved",
          "The action failed without no-effect proof, so its real-world effect is indeterminate.",
          true,
        );
      }
    } else {
      entry.status = "needs_verification";
      this.state = "needs_verification";
      this.hold = evidence.length === 0
        ? this.createHold(
            "action_evidence_absent",
            "The adapter reported success without action evidence. Verification is still mandatory.",
            true,
          )
        : undefined;
    }
    this.touch();
    return this.checkpoint();
  }

  recordVerification(
    result: InteractionVerificationResult,
  ): InteractionCheckpoint {
    const action = this.requirePendingAction("needs_verification");
    if (result.actionId !== action.actionId) {
      throw new InteractionPolicyError(
        "verification_action_mismatch",
        "The verification result does not belong to the pending interaction action.",
      );
    }
    if (!bindingEquals(result.binding, action.binding)) {
      this.markIndeterminate(
        "verification_binding_changed",
        "The adapter session or target context changed before verification completed.",
      );
      return this.checkpoint();
    }
    const evidence = validatedEvidence(result.evidence);
    const entry = this.requireIdempotencyEntry(action.idempotencyKeyDigestSha256);
    if (
      !result.verified
      || !result.postStateDigestSha256
      || evidence.length === 0
    ) {
      entry.status = "indeterminate";
      this.markIndeterminate(
        result.detailCode ?? "postcondition_not_verified",
        "The adapter reported an action but could not prove the required postconditions. Reconcile the target before retrying.",
      );
      return this.checkpoint();
    }

    const verifiedAt = result.verifiedAt ?? this.timestamp();
    const postStateDigestSha256 = normalizedSha256(
      result.postStateDigestSha256,
      "postStateDigestSha256",
    );
    this.verification = {
      actionId: action.actionId,
      verifiedAt: normalizedTimestamp(verifiedAt, "verifiedAt"),
      postStateDigestSha256,
      evidence,
    };
    this.observation = validatedObservation({
      observationId: this.idFactory("obs"),
      binding: action.binding,
      stateDigestSha256: postStateDigestSha256,
      observedAt: verifiedAt,
      evidence,
      ...(result.frontier ? { frontier: result.frontier } : {}),
      ...(result.viewport ? { viewport: result.viewport } : {}),
    });
    this.binding = action.binding;
    this.pendingAction = undefined;
    this.hold = undefined;
    this.state = "verified";
    entry.status = "verified";
    this.touch();
    return this.checkpoint();
  }

  resolveIndeterminate(input: {
    actionId: string;
    resolution: "effect_absent" | "effect_verified";
    binding: InteractionBinding;
    postStateDigestSha256: string;
    evidence: InteractionEvidenceRef[];
    frontier?: InteractionFrontier;
    viewport?: InteractionViewport;
  }): InteractionCheckpoint {
    if (this.state !== "indeterminate") {
      throw new InteractionPolicyError(
        "session_not_indeterminate",
        "Indeterminate resolution is only valid while the interaction session is indeterminate.",
      );
    }
    const action = this.requirePendingAction();
    if (input.actionId !== action.actionId) {
      throw new InteractionPolicyError(
        "resolution_action_mismatch",
        "The reconciliation evidence does not belong to the pending action.",
      );
    }
    if (!bindingEquals(input.binding, action.binding)) {
      throw new InteractionPolicyError(
        "resolution_binding_mismatch",
        "Reconciliation must read back the exact adapter session and target context of the pending action.",
      );
    }
    const evidence = validatedEvidence(input.evidence);
    if (evidence.length === 0) {
      throw new InteractionPolicyError(
        "resolution_evidence_required",
        "Indeterminate interaction effects require explicit readback evidence.",
      );
    }
    const postStateDigestSha256 = normalizedSha256(
      input.postStateDigestSha256,
      "postStateDigestSha256",
    );
    if (!this.reconciliationVerifier) {
      throw new InteractionPolicyError(
        "indeterminate_reconciliation_unverified",
        "Indeterminate effect reconciliation requires an external readback verifier.",
      );
    }
    let reconciliationVerification: InteractionReconciliationVerification;
    try {
      reconciliationVerification = this.reconciliationVerifier({
        identity: structuredClone(this.identity),
        action: structuredClone(action),
        resolution: input.resolution,
        binding: structuredClone(action.binding),
        postStateDigestSha256,
        evidence: structuredClone(evidence),
      });
    } catch {
      throw new InteractionPolicyError(
        "indeterminate_reconciliation_verifier_failed",
        "The external reconciliation verifier failed closed.",
      );
    }
    if (
      !reconciliationVerification.verified
      || !reconciliationVerification.verificationRef
      || !reconciliationVerification.authorityReadbackRef
    ) {
      throw new InteractionPolicyError(
        "indeterminate_reconciliation_not_verified",
        "The external readback verifier did not establish the requested effect resolution.",
      );
    }
    const observedAt = this.timestamp();
    this.observation = validatedObservation({
      observationId: this.idFactory("obs"),
      binding: action.binding,
      stateDigestSha256: postStateDigestSha256,
      observedAt,
      evidence,
      ...(input.frontier ? { frontier: input.frontier } : {}),
      ...(input.viewport ? { viewport: input.viewport } : {}),
    });
    this.binding = action.binding;
    this.reconciliation = {
      actionId: action.actionId,
      resolution: input.resolution,
      reconciledAt: observedAt,
      postStateDigestSha256,
      evidence,
      verificationRef: boundedOpaqueRef(
        reconciliationVerification.verificationRef,
        "reconciliation.verificationRef",
        2_000,
      ),
      authorityReadbackRef: boundedOpaqueRef(
        reconciliationVerification.authorityReadbackRef,
        "reconciliation.authorityReadbackRef",
        2_000,
      ),
    };
    const entry = this.requireIdempotencyEntry(action.idempotencyKeyDigestSha256);
    if (input.resolution === "effect_absent") {
      entry.status = "failed_no_effect";
      this.verification = undefined;
      this.state = "ready";
    } else {
      entry.status = "verified";
      this.verification = {
        actionId: action.actionId,
        verifiedAt: observedAt,
        postStateDigestSha256,
        evidence,
      };
      this.state = "verified";
    }
    this.pendingAction = undefined;
    this.hold = undefined;
    this.touch();
    return this.checkpoint();
  }

  recover(currentBinding?: InteractionBinding): InteractionRecoveryAssessment {
    if (currentBinding) validatedBinding(currentBinding);
    if (
      this.pendingAction
      && (this.state === "acting" || this.state === "needs_verification")
    ) {
      this.markIndeterminate(
        "recovered_with_unsettled_action",
        "The process or model boundary was crossed while an action was unsettled. Observe and reconcile before replay.",
      );
      return this.recoveryAssessment(
        "resolve_indeterminate",
        "unsettled_action_crossed_recovery_boundary",
        false,
      );
    }
    if (this.state === "indeterminate") {
      return this.recoveryAssessment(
        "resolve_indeterminate",
        "effect_outcome_indeterminate",
        false,
      );
    }
    if (
      currentBinding
      && this.binding
      && !bindingEquals(currentBinding, this.binding)
    ) {
      this.state = "needs_observation";
      this.hold = this.createHold(
        "interaction_binding_changed",
        "The adapter session or target context changed. Capture a fresh observation before acting.",
        true,
      );
      this.touch();
      return this.recoveryAssessment(
        "reobserve",
        "adapter_or_target_context_changed",
        false,
      );
    }
    if (!this.observation) {
      this.state = "needs_observation";
      this.touch();
      return this.recoveryAssessment(
        "reobserve",
        "no_current_observation",
        false,
      );
    }
    return this.recoveryAssessment(
      "continue",
      "checkpoint_coherent_with_current_binding",
      true,
    );
  }

  cancel(reason = "cancelled_by_owner_or_controller"): InteractionCheckpoint {
    if (this.state === "indeterminate") {
      throw new InteractionPolicyError(
        "indeterminate_effect_cannot_be_cancelled_away",
        "Cancelling local work cannot resolve an indeterminate external effect.",
      );
    }
    this.state = "cancelled";
    this.pendingAction = undefined;
    this.hold = this.createHold(reason, "The local interaction session was cancelled.", false);
    this.touch();
    return this.checkpoint();
  }

  checkpoint(): InteractionCheckpoint {
    this.assertCoherent();
    return structuredClone({
      schemaVersion: 1,
      identity: this.identity,
      state: this.state,
      ...(this.binding ? { binding: this.binding } : {}),
      ...(this.observation ? { observation: this.observation } : {}),
      ...(this.pendingAction ? { pendingAction: this.pendingAction } : {}),
      ...(this.verification ? { verification: this.verification } : {}),
      ...(this.reconciliation ? { reconciliation: this.reconciliation } : {}),
      ...(this.hold ? { hold: this.hold } : {}),
      idempotencyEntries: [...this.idempotency.values()],
      updatedAt: new Date(this.updatedAtMs).toISOString(),
      nextAction: nextActionForState(this.state),
      policy: interactionPolicy(),
    });
  }

  private timestamp(): string {
    return new Date(this.now()).toISOString();
  }

  private touch(): void {
    this.updatedAtMs = this.now();
  }

  private createHold(
    code: string,
    message: string,
    recoverable: boolean,
  ): InteractionHold {
    return {
      code: boundedText(code, "hold.code", 200),
      message: boundedText(message, "hold.message", 4_000),
      recoverable,
      recordedAt: this.timestamp(),
    };
  }

  private markIndeterminate(code: string, message: string): void {
    this.state = "indeterminate";
    this.hold = this.createHold(code, message, true);
    if (this.pendingAction) {
      const entry = this.idempotency.get(
        this.pendingAction.idempotencyKeyDigestSha256,
      );
      if (entry) entry.status = "indeterminate";
    }
    this.touch();
  }

  private recoveryAssessment(
    disposition: InteractionRecoveryAssessment["disposition"],
    reason: string,
    replayAllowed: boolean,
  ): InteractionRecoveryAssessment {
    return {
      state: this.state,
      disposition,
      reason,
      replayAllowed,
      checkpoint: this.checkpoint(),
    };
  }

  private requireObservation(): InteractionObservation {
    if (!this.observation) {
      throw new InteractionPolicyError(
        "current_observation_required",
        "A current interaction observation is required.",
      );
    }
    return this.observation;
  }

  private requireBinding(): InteractionBinding {
    if (!this.binding) {
      throw new InteractionPolicyError(
        "interaction_binding_required",
        "The interaction session is not bound to an adapter target.",
      );
    }
    return this.binding;
  }

  private requirePendingAction(
    expectedState?: InteractionLifecycleState,
  ): InteractionPreparedAction {
    if (expectedState && this.state !== expectedState) {
      throw new InteractionPolicyError(
        "unexpected_interaction_state",
        `Expected interaction state ${expectedState}, observed ${this.state}.`,
      );
    }
    if (!this.pendingAction) {
      throw new InteractionPolicyError(
        "pending_action_required",
        "No pending interaction action exists.",
      );
    }
    return this.pendingAction;
  }

  private requireIdempotencyEntry(keyDigest: string): InteractionIdempotencyEntry {
    const entry = this.idempotency.get(keyDigest);
    if (!entry) {
      throw new InteractionPolicyError(
        "idempotency_entry_missing",
        "The pending action has no idempotency ledger entry.",
      );
    }
    return entry;
  }

  private assertCoherent(): void {
    if (
      (this.state === "acting"
        || this.state === "needs_verification"
        || this.state === "indeterminate")
      && !this.pendingAction
    ) {
      throw new InteractionPolicyError(
        "interaction_checkpoint_incoherent",
        `${this.state} interaction state requires a pending action.`,
      );
    }
    if (this.observation && !this.binding) {
      throw new InteractionPolicyError(
        "observation_without_binding",
        "An interaction observation cannot exist without a binding.",
      );
    }
    if (
      this.observation
      && this.binding
      && !bindingEquals(this.observation.binding, this.binding)
    ) {
      throw new InteractionPolicyError(
        "observation_binding_mismatch",
        "The latest observation does not match the interaction binding.",
      );
    }
  }
}

export class InteractionController {
  private readonly adapters = new Map<string, InteractionAdapter>();

  constructor(
    readonly session: InteractionSession,
    adapters: InteractionAdapter[],
  ) {
    for (const adapter of adapters) {
      if (this.adapters.has(adapter.descriptor.id)) {
        throw new InteractionPolicyError(
          "duplicate_interaction_adapter",
          `Duplicate interaction adapter: ${adapter.descriptor.id}`,
        );
      }
      this.adapters.set(adapter.descriptor.id, adapter);
    }
  }

  route(intent: InteractionIntent): InteractionRoute {
    return selectInteractionRoute(
      intent,
      [...this.adapters.values()].map((adapter) => adapter.descriptor),
    );
  }

  async execute(
    intent: InteractionIntent,
    buildAction: (
      observation: InteractionObservation,
      adapter: InteractionAdapterDescriptor,
    ) => InteractionActionRequest,
  ): Promise<InteractionExecutionResult> {
    if (intent.effectClass !== "read_only") {
      throw new InteractionPolicyError(
        "durable_interaction_broker_required",
        "Mutating browser or desktop interaction must use the durable broker so the pending action is persisted before dispatch.",
      );
    }
    const route = this.route(intent);
    if (!route.selected) {
      return { route, checkpoint: this.session.checkpoint() };
    }
    const adapter = this.adapters.get(route.selected.id);
    if (!adapter) {
      throw new InteractionPolicyError(
        "selected_adapter_missing",
        "The selected interaction adapter is not registered in the controller.",
      );
    }
    const identity = this.session.checkpoint().identity;
    const observationInput = await adapter.observe({
      identity,
      intent,
      timeoutMs: DEFAULT_TIMEOUT_MS,
    });
    this.session.recordObservation(observationInput);
    const observation = this.session.checkpoint().observation;
    if (!observation) {
      throw new InteractionPolicyError(
        "adapter_observation_missing",
        "The adapter did not establish a current interaction observation.",
      );
    }
    const request = buildAction(observation, route.selected);
    if (request.effectClass !== intent.effectClass) {
      throw new InteractionPolicyError(
        "interaction_intent_action_effect_mismatch",
        "The action request effect class must exactly match the routed interaction intent.",
      );
    }
    const start = this.session.beginAction(
      request,
      route.selected,
    );
    if (!start.started) {
      return {
        route,
        checkpoint: start.checkpoint,
        action: start.action,
        idempotentReplay: true,
      };
    }

    let outcome: InteractionActionOutcome;
    try {
      outcome = await adapter.act(start.action);
    } catch {
      outcome = {
        actionId: start.action.actionId,
        status: "unknown",
        detailCode: "adapter_transport_lost",
      };
    }
    this.session.recordActionOutcome(outcome);
    if (outcome.status !== "succeeded") {
      return {
        route,
        checkpoint: this.session.checkpoint(),
        action: start.action,
        outcome,
      };
    }

    let verification: InteractionVerificationResult;
    try {
      verification = await adapter.verify(start.action, outcome);
    } catch {
      verification = {
        actionId: start.action.actionId,
        verified: false,
        binding: start.action.binding,
        detailCode: "verification_transport_lost",
        evidence: [],
      };
    }
    this.session.recordVerification(verification);
    return {
      route,
      checkpoint: this.session.checkpoint(),
      action: start.action,
      outcome,
    };
  }
}

function validateActionRequest(
  request: InteractionActionRequest,
  observation: InteractionObservation,
  adapter: InteractionAdapterDescriptor,
  identity: InteractionCheckpoint["identity"],
  binding: InteractionBinding,
  approvalVerifier: InteractionApprovalVerifier | undefined,
): InteractionApprovalVerification | undefined {
  if (!adapter.supportedActionKinds.includes(request.kind)) {
    throw new InteractionPolicyError(
      "interaction_action_kind_unsupported",
      `The selected adapter does not support interaction action kind: ${request.kind}.`,
    );
  }
  const minimumEffectClass = adapter.minimumEffectClassByAction[request.kind];
  if (!minimumEffectClass) {
    throw new InteractionPolicyError(
      "interaction_action_effect_policy_missing",
      `The selected adapter has no minimum effect policy for action kind: ${request.kind}.`,
    );
  }
  if (
    EFFECT_CLASS_RANK[request.effectClass]
    < EFFECT_CLASS_RANK[minimumEffectClass]
  ) {
    throw new InteractionPolicyError(
      "interaction_effect_class_underclassified",
      `Action kind ${request.kind} requires at least ${minimumEffectClass}; ${request.effectClass} is not sufficient.`,
    );
  }
  if (request.expectedObservationId !== observation.observationId) {
    throw new InteractionPolicyError(
      "stale_observation",
      "The action was prepared from a different observation. Re-observe the target.",
    );
  }
  if (
    normalizedSha256(
      request.expectedPreStateDigestSha256,
      "expectedPreStateDigestSha256",
    ) !== observation.stateDigestSha256
  ) {
    throw new InteractionPolicyError(
      "stale_pre_state_digest",
      "The target state changed after the action was planned. Re-observe before acting.",
    );
  }
  let approvalVerification: InteractionApprovalVerification | undefined;
  if (request.effectClass === "read_only") {
    if (request.approval.state === "denied") {
      throw new InteractionPolicyError(
        "action_denied",
        "The interaction action was explicitly denied.",
      );
    }
  } else {
    if (
      request.approval.state !== "approved"
      || !request.approval.ref
    ) {
      throw new InteractionPolicyError(
        "mutating_action_requires_approval",
        "Reversible and irreversible interaction effects require an explicit approval reference.",
      );
    }
    if (!approvalVerifier) {
      throw new InteractionPolicyError(
        "mutating_action_approval_unverified",
        "Mutating interaction approval must be verified against a rightful external authority before dispatch.",
      );
    }
    try {
      approvalVerification = approvalVerifier({
        identity,
        binding,
        actionKind: request.kind,
        effectClass: request.effectClass,
        approval: structuredClone(request.approval),
        ...(request.payloadDigestSha256
          ? {
              payloadDigestSha256: normalizedSha256(
                request.payloadDigestSha256,
                "payloadDigestSha256",
              ),
            }
          : {}),
      });
    } catch {
      throw new InteractionPolicyError(
        "mutating_action_approval_verification_failed",
        "The external approval verifier failed closed.",
      );
    }
    if (
      !approvalVerification.verified
      || !approvalVerification.verificationRef
      || !approvalVerification.authorityReadbackRef
    ) {
      throw new InteractionPolicyError(
        "mutating_action_approval_not_verified",
        "The supplied approval was not verified by the rightful external authority.",
      );
    }
  }
  if (
    request.effectClass !== "read_only"
    && (request.postconditions?.length ?? 0) === 0
  ) {
    throw new InteractionPolicyError(
      "mutating_action_requires_postcondition",
      "Mutating interaction actions require at least one explicit postcondition.",
    );
  }
  if (request.target.strategy === "semantic") {
    if (!adapter.capabilities.semanticTargeting) {
      throw new InteractionPolicyError(
        "semantic_targeting_unsupported",
        "The selected adapter cannot resolve semantic targets.",
      );
    }
    if (
      !request.target.targetRef
      && !request.target.role
      && !request.target.accessibleName
      && !request.target.testId
      && !request.target.selector
    ) {
      throw new InteractionPolicyError(
        "semantic_target_empty",
        "A semantic target must provide an exact snapshot ref or stable semantic selector.",
      );
    }
  } else {
    validateCoordinateTarget(request.target, observation, adapter);
  }
  if (request.payloadDigestSha256) {
    normalizedSha256(request.payloadDigestSha256, "payloadDigestSha256");
  }
  for (const postcondition of request.postconditions ?? []) {
    boundedText(postcondition.kind, "postcondition.kind", 100);
    boundedText(postcondition.expected, "postcondition.expected", 4_000);
    if (postcondition.targetRef) {
      boundedText(postcondition.targetRef, "postcondition.targetRef", 2_000);
    }
  }
  return approvalVerification;
}

function validateCoordinateTarget(
  target: InteractionCoordinateTarget,
  observation: InteractionObservation,
  adapter: InteractionAdapterDescriptor,
): void {
  if (!adapter.capabilities.coordinateTargeting) {
    throw new InteractionPolicyError(
      "coordinate_targeting_unsupported",
      "The selected adapter does not support coordinate interaction.",
    );
  }
  if (!target.semanticFallbackExhausted) {
    throw new InteractionPolicyError(
      "semantic_targeting_not_exhausted",
      "Coordinate input is a fallback and requires explicit proof that semantic targeting was exhausted.",
    );
  }
  if (target.sourceObservationId !== observation.observationId) {
    throw new InteractionPolicyError(
      "coordinate_observation_mismatch",
      "Coordinate input must be bound to the current observation.",
    );
  }
  const viewport = observation.viewport;
  if (
    !viewport
    || viewport.width !== target.viewportWidth
    || viewport.height !== target.viewportHeight
  ) {
    throw new InteractionPolicyError(
      "coordinate_viewport_mismatch",
      "Coordinate input requires exact current viewport dimensions.",
    );
  }
  if (
    !Number.isFinite(target.x)
    || !Number.isFinite(target.y)
    || target.x < 0
    || target.y < 0
    || target.x >= viewport.width
    || target.y >= viewport.height
  ) {
    throw new InteractionPolicyError(
      "coordinate_out_of_bounds",
      "Coordinate input is outside the observed viewport.",
    );
  }
  if (!observation.evidence.some((entry) => entry.kind === "screenshot")) {
    throw new InteractionPolicyError(
      "coordinate_screenshot_evidence_required",
      "Coordinate input requires a screenshot evidence reference from the current observation.",
    );
  }
}

function validateAdapterForBinding(
  adapter: InteractionAdapterDescriptor,
  binding: InteractionBinding,
): void {
  if (!adapter.available) {
    throw new InteractionPolicyError(
      "adapter_unavailable",
      adapter.unavailableReason ?? "The interaction adapter is unavailable.",
    );
  }
  if (adapter.id !== binding.adapterId || adapter.surface !== binding.surface) {
    throw new InteractionPolicyError(
      "adapter_binding_mismatch",
      "The selected adapter does not own the current interaction binding.",
    );
  }
  if (!adapter.targetKinds.includes(binding.targetKind)) {
    throw new InteractionPolicyError(
      "adapter_target_mismatch",
      "The selected adapter does not support the bound target kind.",
    );
  }
  if (!adapter.capabilities.observe || !adapter.capabilities.verify) {
    throw new InteractionPolicyError(
      "adapter_loop_incomplete",
      "An interaction adapter must support both observation and verification.",
    );
  }
  if (!adapter.capabilities.boundedTimeout) {
    throw new InteractionPolicyError(
      "adapter_timeout_contract_missing",
      "An interaction adapter must enforce the prepared action timeout.",
    );
  }
  if (adapter.concurrency === "exclusive" && adapter.busy) {
    throw new InteractionPolicyError(
      "exclusive_adapter_busy",
      "The exclusive interaction adapter is already bound to another active controller.",
    );
  }
}

function actionDigestInput(
  request: InteractionActionRequest,
  binding: InteractionBinding,
): Record<string, unknown> {
  return {
    kind: request.kind,
    effectClass: request.effectClass,
    target: request.target,
    expectedObservationId: request.expectedObservationId,
    expectedPreStateDigestSha256: request.expectedPreStateDigestSha256,
    payloadDigestSha256: request.payloadDigestSha256,
    declaredIdempotent: request.declaredIdempotent === true,
    approval: {
      state: request.approval.state,
      ref: request.approval.ref,
      actorRef: request.approval.actorRef,
    },
    postconditions: request.postconditions ?? [],
    timeoutMs: boundedTimeout(request.timeoutMs),
    binding,
  };
}

function validatedBinding(binding: InteractionBinding): InteractionBinding {
  return {
    adapterId: boundedText(binding.adapterId, "binding.adapterId", 200),
    surface: binding.surface,
    backendSessionRef: boundedText(
      binding.backendSessionRef,
      "binding.backendSessionRef",
      1_000,
    ),
    contextRef: boundedText(binding.contextRef, "binding.contextRef", 1_000),
    targetKind: binding.targetKind,
  };
}

function validatedObservation(
  observation: InteractionObservation,
): InteractionObservation {
  return {
    observationId: boundedText(
      observation.observationId,
      "observationId",
      200,
    ),
    binding: validatedBinding(observation.binding),
    stateDigestSha256: normalizedSha256(
      observation.stateDigestSha256,
      "stateDigestSha256",
    ),
    observedAt: normalizedTimestamp(observation.observedAt, "observedAt"),
    evidence: validatedEvidence(observation.evidence),
    ...(observation.frontier
      ? { frontier: validatedFrontier(observation.frontier) }
      : {}),
    ...(observation.viewport
      ? { viewport: validatedViewport(observation.viewport) }
      : {}),
    ...(observation.sensitiveStateRefs
      ? {
          sensitiveStateRefs: observation.sensitiveStateRefs.map((entry) => ({
            kind: entry.kind,
            ref: boundedOpaqueRef(entry.ref, "sensitiveStateRef.ref", 2_000),
            ...(entry.sha256
              ? { sha256: normalizedSha256(entry.sha256, "sensitiveStateRef.sha256") }
              : {}),
          })),
        }
      : {}),
  };
}

function validatedPreparedAction(
  action: InteractionPreparedAction,
): InteractionPreparedAction {
  return {
    ...structuredClone(action),
    actionId: boundedText(action.actionId, "actionId", 200),
    attempt: boundedPositiveInteger(action.attempt, "attempt"),
    expectedPreStateDigestSha256: normalizedSha256(
      action.expectedPreStateDigestSha256,
      "expectedPreStateDigestSha256",
    ),
    requestDigestSha256: normalizedSha256(
      action.requestDigestSha256,
      "requestDigestSha256",
    ),
    idempotencyKeyDigestSha256: normalizedSha256(
      action.idempotencyKeyDigestSha256,
      "idempotencyKeyDigestSha256",
    ),
    ...(action.payloadDigestSha256
      ? { payloadDigestSha256: normalizedSha256(action.payloadDigestSha256, "payloadDigestSha256") }
      : {}),
    ...(action.approvalVerificationRef
      ? {
          approvalVerificationRef: boundedOpaqueRef(
            action.approvalVerificationRef,
            "approvalVerificationRef",
            2_000,
          ),
        }
      : {}),
    ...(action.approvalAuthorityReadbackRef
      ? {
          approvalAuthorityReadbackRef: boundedOpaqueRef(
            action.approvalAuthorityReadbackRef,
            "approvalAuthorityReadbackRef",
            2_000,
          ),
        }
      : {}),
    timeoutMs: boundedTimeout(action.timeoutMs),
    binding: validatedBinding(action.binding),
    startedAt: normalizedTimestamp(action.startedAt, "startedAt"),
  };
}

function validatedVerificationReceipt(
  receipt: InteractionVerificationReceipt,
): InteractionVerificationReceipt {
  return {
    actionId: boundedText(receipt.actionId, "verification.actionId", 200),
    verifiedAt: normalizedTimestamp(receipt.verifiedAt, "verification.verifiedAt"),
    postStateDigestSha256: normalizedSha256(
      receipt.postStateDigestSha256,
      "verification.postStateDigestSha256",
    ),
    evidence: validatedEvidence(receipt.evidence),
  };
}

function validatedReconciliationReceipt(
  receipt: InteractionReconciliationReceipt,
): InteractionReconciliationReceipt {
  return {
    actionId: boundedText(receipt.actionId, "reconciliation.actionId", 200),
    resolution: receipt.resolution,
    reconciledAt: normalizedTimestamp(
      receipt.reconciledAt,
      "reconciliation.reconciledAt",
    ),
    postStateDigestSha256: normalizedSha256(
      receipt.postStateDigestSha256,
      "reconciliation.postStateDigestSha256",
    ),
    evidence: validatedEvidence(receipt.evidence),
    verificationRef: boundedOpaqueRef(
      receipt.verificationRef,
      "reconciliation.verificationRef",
      2_000,
    ),
    authorityReadbackRef: boundedOpaqueRef(
      receipt.authorityReadbackRef,
      "reconciliation.authorityReadbackRef",
      2_000,
    ),
  };
}

function validatedHold(hold: InteractionHold): InteractionHold {
  return {
    code: boundedText(hold.code, "hold.code", 200),
    message: boundedText(hold.message, "hold.message", 4_000),
    recoverable: hold.recoverable,
    recordedAt: normalizedTimestamp(hold.recordedAt, "hold.recordedAt"),
  };
}

function validatedIdempotencyEntry(
  entry: InteractionIdempotencyEntry,
): InteractionIdempotencyEntry {
  return {
    keyDigestSha256: normalizedSha256(
      entry.keyDigestSha256,
      "idempotency.keyDigestSha256",
    ),
    requestDigestSha256: normalizedSha256(
      entry.requestDigestSha256,
      "idempotency.requestDigestSha256",
    ),
    action: validatedPreparedAction(entry.action),
    status: entry.status,
  };
}

function validatedEvidence(
  evidence: InteractionEvidenceRef[],
): InteractionEvidenceRef[] {
  return evidence.map((entry) => ({
    kind: entry.kind,
    ref: boundedOpaqueRef(entry.ref, "evidence.ref", 4_000),
    ...(entry.sha256
      ? { sha256: normalizedSha256(entry.sha256, "evidence.sha256") }
      : {}),
    ...(entry.capturedAt
      ? { capturedAt: normalizedTimestamp(entry.capturedAt, "evidence.capturedAt") }
      : {}),
    ...(entry.sensitive === undefined ? {} : { sensitive: entry.sensitive }),
  }));
}

function validatedFrontier(frontier: InteractionFrontier): InteractionFrontier {
  return {
    ...(frontier.url
      ? { url: normalizedCheckpointUrl(frontier.url) }
      : {}),
    ...(frontier.title
      ? { title: boundedText(frontier.title, "frontier.title", 4_000) }
      : {}),
    ...(frontier.windowRef
      ? { windowRef: boundedText(frontier.windowRef, "frontier.windowRef", 2_000) }
      : {}),
    ...(frontier.focusedTargetRef
      ? {
          focusedTargetRef: boundedText(
            frontier.focusedTargetRef,
            "frontier.focusedTargetRef",
            2_000,
          ),
        }
      : {}),
    ...(frontier.modalRef
      ? { modalRef: boundedText(frontier.modalRef, "frontier.modalRef", 2_000) }
      : {}),
    ...(frontier.navigationRef
      ? {
          navigationRef: boundedText(
            frontier.navigationRef,
            "frontier.navigationRef",
            2_000,
          ),
        }
      : {}),
  };
}

function validatedViewport(viewport: InteractionViewport): InteractionViewport {
  const width = boundedPositiveInteger(viewport.width, "viewport.width");
  const height = boundedPositiveInteger(viewport.height, "viewport.height");
  if (width > 100_000 || height > 100_000) {
    throw new InteractionPolicyError(
      "viewport_out_of_range",
      "Viewport dimensions exceed the supported range.",
    );
  }
  if (
    viewport.deviceScaleFactor !== undefined
    && (!Number.isFinite(viewport.deviceScaleFactor)
      || viewport.deviceScaleFactor <= 0
      || viewport.deviceScaleFactor > 16)
  ) {
    throw new InteractionPolicyError(
      "device_scale_factor_invalid",
      "Device scale factor must be greater than zero and no more than 16.",
    );
  }
  return {
    width,
    height,
    ...(viewport.deviceScaleFactor === undefined
      ? {}
      : { deviceScaleFactor: viewport.deviceScaleFactor }),
  };
}

function bindingEquals(
  left: InteractionBinding,
  right: InteractionBinding,
): boolean {
  return left.adapterId === right.adapterId
    && left.surface === right.surface
    && left.backendSessionRef === right.backendSessionRef
    && left.contextRef === right.contextRef
    && left.targetKind === right.targetKind;
}

function nextActionForState(state: InteractionLifecycleState): string {
  switch (state) {
    case "needs_observation":
      return "Observe and bind the exact adapter session and target context.";
    case "ready":
    case "verified":
      return "Prepare one action from the current observation and explicit postconditions.";
    case "acting":
      return "Await the exact adapter outcome; do not replay the action.";
    case "needs_verification":
      return "Verify postconditions and capture post-action evidence.";
    case "indeterminate":
      return "Read back and reconcile the real target effect before any retry.";
    case "held":
      return "Resolve the interaction hold and capture a fresh observation.";
    case "failed":
      return "Inspect failure evidence and replan from a fresh observation.";
    case "cancelled":
      return "Open a new interaction session if further work is required.";
  }
}

function boundedTimeout(value: number | undefined): number {
  if (value === undefined) return DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(value) || value < 1) {
    throw new InteractionPolicyError(
      "timeout_invalid",
      "Interaction timeout must be a positive finite number.",
    );
  }
  return Math.min(Math.floor(value), MAX_TIMEOUT_MS);
}

function boundedPositiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new InteractionPolicyError(
      "positive_integer_required",
      `${label} must be a positive safe integer.`,
    );
  }
  return value;
}

function boundedText(value: string, label: string, maximum: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    throw new InteractionPolicyError(
      "bounded_text_invalid",
      `${label} must contain between 1 and ${maximum} characters.`,
    );
  }
  return value;
}

function boundedPattern(
  value: string,
  label: string,
  pattern: RegExp,
): string {
  if (!pattern.test(value)) {
    throw new InteractionPolicyError(
      "pattern_mismatch",
      `${label} has an invalid format.`,
    );
  }
  return value;
}

function boundedOpaqueRef(
  value: string,
  label: string,
  maximum: number,
): string {
  const normalized = boundedText(value, label, maximum);
  if (
    /[\u0000-\u001f\u007f\s]/.test(normalized)
    || !/^[a-z][a-z0-9+.-]*:[^\s]+$/i.test(normalized)
  ) {
    throw new InteractionPolicyError(
      "opaque_reference_invalid",
      `${label} must be an opaque URI-like reference without whitespace or control characters.`,
    );
  }
  if (
    /(?:token|secret|password|passwd|api[_-]?key)=/i.test(normalized)
    || /^[a-z][a-z0-9+.-]*:\/\/[^/]*@/i.test(normalized)
  ) {
    throw new InteractionPolicyError(
      "credential_bearing_reference_rejected",
      `${label} may not embed credentials or credential-like query fields.`,
    );
  }
  return normalized;
}

function normalizedCheckpointUrl(value: string): string {
  const bounded = boundedText(value, "frontier.url", 8_000);
  let parsed: URL;
  try {
    parsed = new URL(bounded);
  } catch {
    throw new InteractionPolicyError(
      "frontier_url_invalid",
      "The observed frontier URL is invalid.",
    );
  }
  if (parsed.username || parsed.password) {
    throw new InteractionPolicyError(
      "credential_bearing_frontier_url_rejected",
      "Checkpoint URLs may not contain userinfo credentials.",
    );
  }
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

function normalizedSha256(value: string, label: string): string {
  return boundedPattern(value, label, /^[a-f0-9]{64}$/);
}

function normalizedTimestamp(value: string, label: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new InteractionPolicyError(
      "timestamp_invalid",
      `${label} must be an ISO-compatible timestamp.`,
    );
  }
  return new Date(parsed).toISOString();
}

function digest(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalValue(value)))
    .digest("hex");
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => canonicalValue(entry));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalValue(entry)]),
    );
  }
  return value;
}
