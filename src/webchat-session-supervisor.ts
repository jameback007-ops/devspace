import { createHash } from "node:crypto";
import type {
  InteractionActionRequest,
  InteractionApprovalVerifier,
  InteractionBinding,
  InteractionIntent,
  InteractionLifecycleState,
  InteractionObservation,
  InteractionPreparedAction,
} from "./interaction-harness.js";

export const WEBCHAT_SUPERVISOR_AUTHORITY = {
  authority: "executor_local_webchat_supervision_only",
  canonicalTaskAuthority: false,
  canonicalDecisionAuthority: false,
  writerLeaseAuthority: false,
  effectAuthority: false,
  publicationAuthority: false,
  memoryAuthority: false,
  hiddenModelStateObservable: false,
  mcpSilenceCanEstablishHang: false,
  callerClaimsCanAuthorizeWake: false,
  rawConversationUrlCaptured: false,
  rawCredentialCaptureAllowed: false,
} as const;

export const WEBCHAT_OPERATIONAL_STATES = [
  "executor_active",
  "ui_streaming",
  "provider_pending",
  "generation_stalled_suspected",
  "responsive_idle",
  "terminal_error",
  "page_frozen",
  "page_discarded",
  "ui_unresponsive",
  "browser_or_network_failed",
  "unknown",
] as const;

export type WebChatOperationalState = typeof WEBCHAT_OPERATIONAL_STATES[number];

export type WebChatLifecycleState =
  | "active"
  | "passive"
  | "hidden"
  | "frozen"
  | "restored_after_discard"
  | "terminated"
  | "unknown";

export type WebChatHeartbeatStatus =
  | "responsive"
  | "timeout"
  | "failed"
  | "not_attempted";

export type WebChatGenerationTransport =
  | "http_stream"
  | "websocket"
  | "event_source"
  | "unknown"
  | "none";

export type WebChatWakeDisposition =
  | "eligible_tier1_continuation"
  | "eligible_tier2_recovery_review"
  | "hold";

export interface WebChatSessionUiBinding {
  schemaVersion: 1;
  bindingRef: string;
  bindingEpoch: number;
  executionScopeRef: string;
  missionRef?: string;
  provider: "chatgpt_web";
  interactionBinding: InteractionBinding;
  browserContextRef: string;
  targetRef: string;
  pageRef: string;
  conversationLocatorRef: string;
  conversationUrlDigestSha256: string;
  conversationRefDigestSha256: string;
  accountRefDigestSha256?: string;
  projectRefDigestSha256?: string;
  selectorContractRef: string;
  selectorContractDigestSha256: string;
  proofRefs: string[];
  establishedAt: string;
  verifiedAt: string;
  authority: typeof WEBCHAT_SUPERVISOR_AUTHORITY;
}

export interface WebChatSelectorContractEvidence {
  contractRef: string;
  contractDigestSha256: string;
  matched: boolean;
  ambiguous: boolean;
  requiredTargetCount: number;
  matchedRequiredTargetCount: number;
  composerTargetRef?: string;
  composerReplaceTargetRef?: string;
  sendTargetRef?: string;
  stopTargetRef?: string;
  retryTargetRef?: string;
  messageListTargetRef?: string;
  driftReasonRefs: string[];
}

export interface WebChatExecutorEvidence {
  observedAt: string;
  scopeMaterialized: boolean;
  runningToolCount: number;
  runningProcessCount: number;
  lastMcpActivityAt?: string;
  observationGapMs?: number;
  interactionState?: InteractionLifecycleState;
  pendingInteractionAction: boolean;
}

export interface WebChatBrowserEvidence {
  observedAt: string;
  browserProcessAlive: boolean;
  browserConnected: boolean;
  browserContextPresent: boolean;
  targetPresent: boolean;
  targetCrashed: boolean;
  pageClosed: boolean;
  browserContextRef: string;
  targetRef: string;
  pageRef: string;
  bindingEpoch: number;
  targetUrlDigestSha256?: string;
  lifecycleState: WebChatLifecycleState;
  documentWasDiscarded: boolean;
  heartbeatStatus: WebChatHeartbeatStatus;
  heartbeatRoundTripMs?: number;
  lastLifecycleEventAt?: string;
  networkOnline?: boolean;
}

export interface WebChatUiEvidence {
  observedAt: string;
  conversationLoaded: boolean;
  conversationRefDigestSha256?: string;
  selectorContract: WebChatSelectorContractEvidence;
  composerPresent: boolean;
  composerEnabled: boolean;
  composerEmpty: boolean;
  composerValueDigestSha256?: string;
  sendControlVisible: boolean;
  sendControlEnabled: boolean;
  stopControlVisible: boolean;
  generationMarkerVisible: boolean;
  assistantPlaceholderVisible: boolean;
  retryControlVisible: boolean;
  explicitErrorVisible: boolean;
  errorCodeRef?: string;
  accountAutomationWarningVisible: boolean;
  loginRequired: boolean;
  userTurnCount: number;
  assistantTurnCount: number;
  lastUserMessageDigestSha256?: string;
  lastAssistantMessageDigestSha256?: string;
  lastAssistantMessageLength: number;
  lastDomMutationAt?: string;
  domMutationSequence?: number;
}

export interface WebChatNetworkEvidence {
  observedAt: string;
  observationAvailable: boolean;
  serviceWorkerMayHideEvents: boolean;
  browserOnline: boolean;
  generationTransport: WebChatGenerationTransport;
  generationRequestOpen: boolean;
  generationRequestStartedAt?: string;
  lastGenerationByteAt?: string;
  lastWebSocketFrameAt?: string;
  lastEventSourceMessageAt?: string;
  lastRequestFinishedAt?: string;
  latestRequestFailedAt?: string;
  requestFailureCodeRef?: string;
}

export interface WebChatObservationSample {
  schemaVersion: 1;
  sampledAt: string;
  bindingRef: string;
  bindingEpoch: number;
  stateDigestSha256: string;
  executor: WebChatExecutorEvidence;
  browser: WebChatBrowserEvidence;
  ui: WebChatUiEvidence;
  network: WebChatNetworkEvidence;
  evidenceRefs: string[];
  authority: typeof WEBCHAT_SUPERVISOR_AUTHORITY;
}

export interface WebChatObservationWindow {
  current: WebChatObservationSample;
  previous: WebChatObservationSample[];
}

export interface WebChatClassifierPolicy {
  maxSampleAgeMs: number;
  maxPlaneSkewMs: number;
  recentProgressMs: number;
  idleConfirmationSpanMs: number;
  minimumStallObservationSpanMs: number;
  minimumStallSamples: number;
  maximumHistorySamples: number;
}

export interface WebChatSessionClassification {
  schemaVersion: 1;
  state: WebChatOperationalState;
  confidence: "proven" | "supported" | "insufficient";
  observedAt: string;
  bindingRef: string;
  bindingEpoch: number;
  observationStateDigestSha256: string;
  classificationDigestSha256: string;
  reasonCodes: string[];
  evidenceRefs: string[];
  wakeDisposition: WebChatWakeDisposition;
  nextAction:
    | "hold"
    | "continue_observing"
    | "tier1_wake_permit_may_be_consumed"
    | "tier2_recovery_policy_required"
    | "rebind_required"
    | "repair_browser_transport"
    | "manual_account_intervention_required";
  policy: ReturnType<typeof webChatSupervisorPolicy>;
  authority: typeof WEBCHAT_SUPERVISOR_AUTHORITY;
}

export interface WebChatWakePermit {
  schemaVersion: 1;
  permitRef: string;
  issuerExecutionScopeRef: string;
  targetExecutionScopeRef: string;
  pendingMessageRef: string;
  pendingWorkReadbackRef: string;
  threadRef?: string;
  taskRef?: string;
  correlationRef?: string;
  bindingRef: string;
  bindingEpoch: number;
  conversationUrlDigestSha256: string;
  expectedObservationStateDigestSha256: string;
  expectedClassificationDigestSha256: string;
  wakeLeaseRef: string;
  idempotencyKey: string;
  attempt: number;
  maxAttempts: number;
  issuedAt: string;
  expiresAt: string;
  authorityReadbackRefs: string[];
}

export interface WebChatWakePermitVerificationInput {
  binding: WebChatSessionUiBinding;
  classification: WebChatSessionClassification;
  permit: WebChatWakePermit;
}

export interface WebChatWakePermitVerification {
  verified: boolean;
  verificationRef?: string;
  authorityReadbackRef?: string;
}

export type WebChatWakePermitVerifier = (
  input: WebChatWakePermitVerificationInput,
) => WebChatWakePermitVerification;

export interface WebChatWakeAuthorization {
  allowed: boolean;
  tier: 1 | 2 | 0;
  reasonCodes: string[];
  permitDigestSha256: string;
  verificationRef?: string;
  authorityReadbackRef?: string;
  authority: typeof WEBCHAT_SUPERVISOR_AUTHORITY;
}

export interface WebChatWakeEnvelope {
  schemaVersion: 1;
  text: string;
  textDigestSha256: string;
  pendingMessageRef: string;
  correlationRef?: string;
}

export interface WebChatWakeDraft {
  schemaVersion: 1;
  persistence: "ephemeral_only";
  permitRef: string;
  bindingRef: string;
  bindingEpoch: number;
  preparedAt: string;
  classificationDigestSha256: string;
  envelope: WebChatWakeEnvelope;
  beforeUserTurnCount: number;
  beforeAssistantTurnCount: number;
  beforeLastUserMessageDigestSha256?: string;
  beforeLastAssistantMessageDigestSha256?: string;
  composerTargetRef: string;
  sendTargetRef: string;
  messageListTargetRef: string;
  composeRequest: InteractionActionRequest;
}

export interface WebChatWakeSubmitDraft {
  schemaVersion: 1;
  permitRef: string;
  bindingRef: string;
  bindingEpoch: number;
  preparedAt: string;
  request: InteractionActionRequest;
}

export interface WebChatEphemeralWakePayload {
  schemaVersion: 1;
  persistence: "ephemeral_only";
  payloadRef: string;
  permitRef: string;
  bindingRef: string;
  bindingEpoch: number;
  text: string;
  textDigestSha256: string;
  issuedAt: string;
  expiresAt: string;
}

export interface WebChatWakeVerification {
  schemaVersion: 1;
  status:
    | "verified"
    | "message_admitted_generation_not_started"
    | "not_admitted"
    | "binding_mismatch"
    | "indeterminate";
  interactionVerified: boolean;
  messageAdmitted: boolean;
  generationBoundaryObserved: boolean;
  reasonCodes: string[];
  evidenceRefs: string[];
  authority: typeof WEBCHAT_SUPERVISOR_AUTHORITY;
}

const DEFAULT_POLICY: WebChatClassifierPolicy = {
  maxSampleAgeMs: 30_000,
  maxPlaneSkewMs: 5_000,
  recentProgressMs: 45_000,
  idleConfirmationSpanMs: 750,
  minimumStallObservationSpanMs: 5 * 60_000,
  minimumStallSamples: 3,
  maximumHistorySamples: 20,
};

const MAX_WAKE_PERMIT_TTL_MS = 5 * 60_000;
const MAX_WAKE_ATTEMPTS = 5;

const UNSETTLED_INTERACTION_STATES = new Set<InteractionLifecycleState>([
  "acting",
  "needs_verification",
  "indeterminate",
]);

export class WebChatSupervisorPolicyError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "WebChatSupervisorPolicyError";
  }
}

export function webChatSupervisorPolicy() {
  return {
    ...WEBCHAT_SUPERVISOR_AUTHORITY,
    semanticTargetingRequired: true,
    exactBindingRequired: true,
    twoSampleIdleConfirmationRequired: true,
    mcpSilenceIsAdvisoryOnly: true,
    networkSilenceAloneIsNotIdleOrHangEvidence: true,
    generationStallIsAdvisoryOnly: true,
    unknownFailsClosed: true,
    tier1MayOnlySubmitCorrelatedContinuation: true,
    tier1StopRegenerateReloadOrDuplicateChatAllowed: false,
    successfulWakeRequiresPromptAdmissionAndGenerationBoundary: true,
  } as const;
}

export function validateWebChatSessionUiBinding(
  binding: WebChatSessionUiBinding,
): WebChatSessionUiBinding {
  if (binding.schemaVersion !== 1) {
    throw new WebChatSupervisorPolicyError(
      "unsupported_binding_schema",
      `Unsupported WebChat binding schema: ${String(binding.schemaVersion)}.`,
    );
  }
  if (binding.provider !== "chatgpt_web") {
    throw new WebChatSupervisorPolicyError(
      "unsupported_webchat_provider",
      `Unsupported WebChat provider: ${String(binding.provider)}.`,
    );
  }
  const validated: WebChatSessionUiBinding = {
    schemaVersion: 1,
    bindingRef: boundedOpaqueRef(binding.bindingRef, "bindingRef", 1_000),
    bindingEpoch: positiveInteger(binding.bindingEpoch, "bindingEpoch"),
    executionScopeRef: boundedPattern(
      binding.executionScopeRef,
      "executionScopeRef",
      /^[a-f0-9]{16}$/,
    ),
    ...(binding.missionRef
      ? { missionRef: boundedText(binding.missionRef, "missionRef", 1_000) }
      : {}),
    provider: "chatgpt_web",
    interactionBinding: validatedInteractionBinding(binding.interactionBinding),
    browserContextRef: boundedOpaqueRef(
      binding.browserContextRef,
      "browserContextRef",
      1_000,
    ),
    targetRef: boundedOpaqueRef(binding.targetRef, "targetRef", 1_000),
    pageRef: boundedOpaqueRef(binding.pageRef, "pageRef", 1_000),
    conversationLocatorRef: boundedOpaqueRef(
      binding.conversationLocatorRef,
      "conversationLocatorRef",
      2_000,
    ),
    conversationUrlDigestSha256: normalizedSha256(
      binding.conversationUrlDigestSha256,
      "conversationUrlDigestSha256",
    ),
    conversationRefDigestSha256: normalizedSha256(
      binding.conversationRefDigestSha256,
      "conversationRefDigestSha256",
    ),
    ...(binding.accountRefDigestSha256
      ? {
          accountRefDigestSha256: normalizedSha256(
            binding.accountRefDigestSha256,
            "accountRefDigestSha256",
          ),
        }
      : {}),
    ...(binding.projectRefDigestSha256
      ? {
          projectRefDigestSha256: normalizedSha256(
            binding.projectRefDigestSha256,
            "projectRefDigestSha256",
          ),
        }
      : {}),
    selectorContractRef: boundedOpaqueRef(
      binding.selectorContractRef,
      "selectorContractRef",
      1_000,
    ),
    selectorContractDigestSha256: normalizedSha256(
      binding.selectorContractDigestSha256,
      "selectorContractDigestSha256",
    ),
    proofRefs: boundedRefs(binding.proofRefs, "proofRefs", 50),
    establishedAt: normalizedTimestamp(binding.establishedAt, "establishedAt"),
    verifiedAt: normalizedTimestamp(binding.verifiedAt, "verifiedAt"),
    authority: WEBCHAT_SUPERVISOR_AUTHORITY,
  };
  if (validated.proofRefs.length === 0) {
    throw new WebChatSupervisorPolicyError(
      "binding_proof_required",
      "A WebChat session binding requires at least one external proof reference.",
    );
  }
  if (
    validated.interactionBinding.backendSessionRef !== validated.browserContextRef
    || validated.interactionBinding.contextRef !== validated.pageRef
  ) {
    throw new WebChatSupervisorPolicyError(
      "interaction_binding_not_linked",
      "The interaction binding must match both the exact browser context and page reference.",
    );
  }
  return validated;
}

export function validateWebChatSessionClassification(
  classification: WebChatSessionClassification,
): WebChatSessionClassification {
  if (classification.schemaVersion !== 1) {
    throw new WebChatSupervisorPolicyError(
      "unsupported_classification_schema",
      `Unsupported WebChat classification schema: ${String(classification.schemaVersion)}.`,
    );
  }
  if (!WEBCHAT_OPERATIONAL_STATES.includes(classification.state)) {
    throw new WebChatSupervisorPolicyError(
      "invalid_operational_state",
      `Unsupported WebChat operational state: ${String(classification.state)}.`,
    );
  }
  if (!["proven", "supported", "insufficient"].includes(classification.confidence)) {
    throw new WebChatSupervisorPolicyError(
      "invalid_classification_confidence",
      `Unsupported classification confidence: ${String(classification.confidence)}.`,
    );
  }
  const reasonCodes = boundedCodes(classification.reasonCodes, "reasonCodes", 100);
  const evidenceRefs = boundedRefs(classification.evidenceRefs, "evidenceRefs", 100);
  if (evidenceRefs.length === 0) {
    throw new WebChatSupervisorPolicyError(
      "classification_evidence_required",
      "A WebChat operational classification requires bounded evidence references.",
    );
  }
  if (![
    "eligible_tier1_continuation",
    "eligible_tier2_recovery_review",
    "hold",
  ].includes(classification.wakeDisposition)) {
    throw new WebChatSupervisorPolicyError(
      "invalid_wake_disposition",
      `Unsupported wake disposition: ${String(classification.wakeDisposition)}.`,
    );
  }
  if (![
    "hold",
    "continue_observing",
    "tier1_wake_permit_may_be_consumed",
    "tier2_recovery_policy_required",
    "rebind_required",
    "repair_browser_transport",
    "manual_account_intervention_required",
  ].includes(classification.nextAction)) {
    throw new WebChatSupervisorPolicyError(
      "invalid_classification_next_action",
      `Unsupported classification next action: ${String(classification.nextAction)}.`,
    );
  }
  const basis = {
    state: classification.state,
    confidence: classification.confidence,
    observedAt: normalizedTimestamp(classification.observedAt, "observedAt"),
    bindingRef: boundedOpaqueRef(classification.bindingRef, "bindingRef", 1_000),
    bindingEpoch: positiveInteger(classification.bindingEpoch, "bindingEpoch"),
    observationStateDigestSha256: normalizedSha256(
      classification.observationStateDigestSha256,
      "observationStateDigestSha256",
    ),
    reasonCodes,
    evidenceRefs,
    wakeDisposition: classification.wakeDisposition,
    nextAction: classification.nextAction,
  };
  const expectedDigest = digest(basis);
  if (
    normalizedSha256(
      classification.classificationDigestSha256,
      "classificationDigestSha256",
    ) !== expectedDigest
  ) {
    throw new WebChatSupervisorPolicyError(
      "classification_digest_mismatch",
      "The WebChat classification was modified after it was produced.",
    );
  }
  if (
    classification.wakeDisposition === "eligible_tier1_continuation"
    && (classification.state !== "responsive_idle"
      || classification.nextAction !== "tier1_wake_permit_may_be_consumed")
  ) {
    throw new WebChatSupervisorPolicyError(
      "invalid_tier1_classification",
      "Tier-1 wake eligibility requires a responsive-idle classification and matching next action.",
    );
  }
  if (
    classification.nextAction === "tier1_wake_permit_may_be_consumed"
    && classification.wakeDisposition !== "eligible_tier1_continuation"
  ) {
    throw new WebChatSupervisorPolicyError(
      "invalid_tier1_next_action",
      "A Tier-1 next action requires Tier-1 wake eligibility.",
    );
  }
  if (
    classification.wakeDisposition === "eligible_tier2_recovery_review"
    && (classification.state !== "terminal_error"
      || classification.nextAction !== "tier2_recovery_policy_required")
  ) {
    throw new WebChatSupervisorPolicyError(
      "invalid_tier2_classification",
      "Tier-2 recovery review requires a terminal-error classification.",
    );
  }
  if (
    classification.state !== "responsive_idle"
    && classification.state !== "terminal_error"
    && classification.wakeDisposition !== "hold"
  ) {
    throw new WebChatSupervisorPolicyError(
      "invalid_non_terminal_wake_disposition",
      "Active, pending, degraded, and unknown states must hold rather than authorize a wake.",
    );
  }
  return {
    schemaVersion: 1,
    ...basis,
    classificationDigestSha256: expectedDigest,
    policy: webChatSupervisorPolicy(),
    authority: WEBCHAT_SUPERVISOR_AUTHORITY,
  };
}

export function classifyWebChatSession(
  rawBinding: WebChatSessionUiBinding,
  rawWindow: WebChatObservationWindow,
  options: Partial<WebChatClassifierPolicy> & { nowMs?: number } = {},
): WebChatSessionClassification {
  const binding = validateWebChatSessionUiBinding(rawBinding);
  const { nowMs: suppliedNowMs, ...policyOptions } = options;
  const policy = validatedClassifierPolicy(policyOptions);
  const nowMs = suppliedNowMs ?? Date.now();
  const current = validateObservationSample(rawWindow.current);
  const previous = rawWindow.previous
    .slice(0, policy.maximumHistorySamples)
    .map(validateObservationSample)
    .filter((sample) =>
      sample.bindingRef === current.bindingRef
      && sample.bindingEpoch === current.bindingEpoch
      && sample.browser.bindingEpoch === current.browser.bindingEpoch
      && sample.browser.browserContextRef === current.browser.browserContextRef
      && sample.browser.targetRef === current.browser.targetRef
      && sample.browser.pageRef === current.browser.pageRef)
    .sort((left, right) => Date.parse(right.sampledAt) - Date.parse(left.sampledAt));
  current.evidenceRefs = [...new Set([
    ...current.evidenceRefs,
    ...previous.flatMap((sample) => sample.evidenceRefs),
  ])].slice(0, 100);
  const reasons: string[] = [];

  const bindingReasons = bindingMismatchReasons(binding, current);
  if (bindingReasons.length > 0) {
    return classification(
      binding,
      current,
      "unknown",
      "insufficient",
      bindingReasons,
      "hold",
      "rebind_required",
    );
  }

  const sampleAgeMs = nowMs - Date.parse(current.sampledAt);
  if (sampleAgeMs < 0 || sampleAgeMs > policy.maxSampleAgeMs) {
    return classification(
      binding,
      current,
      "unknown",
      "insufficient",
      ["observation_stale"],
      "hold",
      "continue_observing",
    );
  }

  const planeTimes = [
    current.sampledAt,
    current.executor.observedAt,
    current.browser.observedAt,
    current.ui.observedAt,
    current.network.observedAt,
  ].map((value) => Date.parse(value));
  const planeSkewMs = Math.max(...planeTimes) - Math.min(...planeTimes);
  if (planeSkewMs > policy.maxPlaneSkewMs) {
    return classification(
      binding,
      current,
      "unknown",
      "insufficient",
      ["observation_planes_not_coherent"],
      "hold",
      "continue_observing",
    );
  }

  if (
    current.executor.runningToolCount > 0
    || current.executor.runningProcessCount > 0
    || current.executor.pendingInteractionAction
    || (current.executor.interactionState
      ? UNSETTLED_INTERACTION_STATES.has(current.executor.interactionState)
      : false)
  ) {
    if ((current.executor.observationGapMs ?? 0) > 0) {
      reasons.push("mcp_observation_gap_ignored_while_executor_active");
    }
    return classification(
      binding,
      current,
      "executor_active",
      "proven",
      ["executor_tool_process_or_interaction_active", ...reasons],
      "hold",
      "continue_observing",
    );
  }

  if (
    !current.browser.browserProcessAlive
    || !current.browser.browserConnected
    || !current.browser.browserContextPresent
    || !current.browser.targetPresent
    || current.browser.targetCrashed
    || current.browser.pageClosed
    || current.browser.lifecycleState === "terminated"
    || current.browser.networkOnline === false
    || !current.network.browserOnline
  ) {
    return classification(
      binding,
      current,
      "browser_or_network_failed",
      "proven",
      ["browser_context_target_or_network_unavailable"],
      "hold",
      "repair_browser_transport",
    );
  }

  if (
    current.browser.lifecycleState === "restored_after_discard"
    || current.browser.documentWasDiscarded
  ) {
    return classification(
      binding,
      current,
      "page_discarded",
      "proven",
      ["page_was_discarded_and_requires_rebinding"],
      "hold",
      "rebind_required",
    );
  }

  if (current.browser.lifecycleState === "frozen") {
    return classification(
      binding,
      current,
      "page_frozen",
      "proven",
      ["page_lifecycle_frozen"],
      "hold",
      "continue_observing",
    );
  }

  if (
    current.browser.heartbeatStatus === "timeout"
    || current.browser.heartbeatStatus === "failed"
  ) {
    return classification(
      binding,
      current,
      "ui_unresponsive",
      "supported",
      ["browser_target_alive_but_page_probe_unresponsive"],
      "hold",
      "tier2_recovery_policy_required",
    );
  }

  const selectorReasons = selectorContractMismatchReasons(binding, current.ui);
  if (selectorReasons.length > 0) {
    return classification(
      binding,
      current,
      "unknown",
      "insufficient",
      selectorReasons,
      "hold",
      "rebind_required",
    );
  }

  if (current.ui.loginRequired || current.ui.accountAutomationWarningVisible) {
    return classification(
      binding,
      current,
      "terminal_error",
      "proven",
      [
        current.ui.loginRequired
          ? "webchat_login_required"
          : "account_automation_warning_visible",
      ],
      "hold",
      "manual_account_intervention_required",
    );
  }

  const generationSignal = hasGenerationSignal(current);
  const progress = progressEvidence(current, previous, policy, nowMs);

  if (current.ui.explicitErrorVisible && generationSignal) {
    return classification(
      binding,
      current,
      "unknown",
      "insufficient",
      [
        "conflicting_generation_and_terminal_error_signals",
        "ui_reobservation_required_before_recovery",
      ],
      "hold",
      "continue_observing",
    );
  }

  if (current.ui.explicitErrorVisible && !generationSignal) {
    return classification(
      binding,
      current,
      "terminal_error",
      "proven",
      [
        "explicit_ui_generation_error",
        ...(current.ui.retryControlVisible ? ["explicit_retry_control_visible"] : []),
      ],
      "eligible_tier2_recovery_review",
      "tier2_recovery_policy_required",
    );
  }

  if (generationSignal && progress.active) {
    return classification(
      binding,
      current,
      "ui_streaming",
      "proven",
      ["generation_signal_with_recent_output_or_transport_progress", ...progress.reasons],
      "hold",
      "continue_observing",
    );
  }

  if (generationSignal && current.network.generationRequestOpen) {
    return classification(
      binding,
      current,
      "provider_pending",
      "supported",
      ["generation_request_open_without_recent_output_progress"],
      "hold",
      "continue_observing",
    );
  }

  if (generationSignal) {
    const stall = sustainedGenerationStall(current, previous, policy);
    if (stall.suspected) {
      return classification(
        binding,
        current,
        "generation_stalled_suspected",
        "supported",
        [
          "generation_ui_stable_without_observed_transport_or_output_progress",
          ...stall.reasons,
          "stall_is_advisory_not_hidden_model_state",
        ],
        "hold",
        "tier2_recovery_policy_required",
      );
    }
    return classification(
      binding,
      current,
      "provider_pending",
      "insufficient",
      [
        "generation_ui_visible_but_transport_state_not_conclusive",
        "mcp_silence_not_used_as_hang_evidence",
      ],
      "hold",
      "continue_observing",
    );
  }

  if (isIdleSample(current)) {
    const idleConfirmation = confirmedIdleSample(current, previous, policy);
    if (idleConfirmation.confirmed) {
      const composerEmpty = current.ui.composerEmpty;
      return classification(
        binding,
        current,
        "responsive_idle",
        "proven",
        ["two_coherent_responsive_idle_samples", ...idleConfirmation.reasons],
        composerEmpty ? "eligible_tier1_continuation" : "hold",
        composerEmpty ? "tier1_wake_permit_may_be_consumed" : "hold",
      );
    }
    return classification(
      binding,
      current,
      "unknown",
      "insufficient",
      ["responsive_idle_requires_second_coherent_sample"],
      "hold",
      "continue_observing",
    );
  }

  return classification(
    binding,
    current,
    "unknown",
    "insufficient",
    [
      "insufficient_or_conflicting_operational_evidence",
      ...(current.executor.observationGapMs !== undefined
        ? ["mcp_observation_gap_is_not_state_evidence"]
        : []),
    ],
    "hold",
    "continue_observing",
  );
}

export function authorizeWebChatWakePermit(input: {
  binding: WebChatSessionUiBinding;
  classification: WebChatSessionClassification;
  permit: WebChatWakePermit;
  permitVerifier?: WebChatWakePermitVerifier;
  nowMs?: number;
}): WebChatWakeAuthorization {
  const binding = validateWebChatSessionUiBinding(input.binding);
  const classification = validateWebChatSessionClassification(input.classification);
  const permit = validateWakePermit(input.permit);
  const nowMs = input.nowMs ?? Date.now();
  const reasons: string[] = [];

  if (
    permit.targetExecutionScopeRef !== binding.executionScopeRef
    || permit.bindingRef !== binding.bindingRef
    || permit.bindingEpoch !== binding.bindingEpoch
    || permit.conversationUrlDigestSha256 !== binding.conversationUrlDigestSha256
  ) {
    reasons.push("wake_permit_binding_mismatch");
  }
  if (
    classification.bindingRef !== binding.bindingRef
    || classification.bindingEpoch !== binding.bindingEpoch
    || classification.observationStateDigestSha256
      !== permit.expectedObservationStateDigestSha256
    || classification.classificationDigestSha256
      !== permit.expectedClassificationDigestSha256
  ) {
    reasons.push("wake_permit_classification_mismatch");
  }
  const classificationObservedAtMs = Date.parse(classification.observedAt);
  if (
    Date.parse(permit.issuedAt) < classificationObservedAtMs
    || classificationObservedAtMs > nowMs
    || nowMs - classificationObservedAtMs > DEFAULT_POLICY.maxSampleAgeMs
  ) {
    reasons.push("wake_permit_classification_time_invalid_or_stale");
  }
  if (Date.parse(permit.issuedAt) > nowMs || Date.parse(permit.expiresAt) <= nowMs) {
    reasons.push("wake_permit_expired_or_not_yet_valid");
  }
  if (permit.attempt > permit.maxAttempts) {
    reasons.push("wake_attempt_limit_exceeded");
  }
  if (permit.authorityReadbackRefs.length === 0 || !permit.pendingWorkReadbackRef) {
    reasons.push("wake_permit_authority_or_pending_work_readback_missing");
  }
  let permitVerification: WebChatWakePermitVerification | undefined;
  if (!input.permitVerifier) {
    reasons.push("external_wake_permit_verifier_required");
  } else if (reasons.length === 0) {
    try {
      permitVerification = input.permitVerifier({
        binding: structuredClone(binding),
        classification: structuredClone(classification),
        permit: structuredClone(permit),
      });
    } catch {
      reasons.push("external_wake_permit_verifier_failed");
    }
    if (
      !permitVerification?.verified
      || !permitVerification.verificationRef
      || !permitVerification.authorityReadbackRef
    ) {
      reasons.push("wake_permit_not_externally_verified");
    }
  }
  let verifiedRefs: Pick<
    WebChatWakeAuthorization,
    "verificationRef" | "authorityReadbackRef"
  > = {};
  if (
    permitVerification?.verified
    && permitVerification.verificationRef
    && permitVerification.authorityReadbackRef
  ) {
    try {
      verifiedRefs = {
        verificationRef: boundedOpaqueRef(
          permitVerification.verificationRef,
          "permitVerification.verificationRef",
          2_000,
        ),
        authorityReadbackRef: boundedOpaqueRef(
          permitVerification.authorityReadbackRef,
          "permitVerification.authorityReadbackRef",
          2_000,
        ),
      };
    } catch {
      reasons.push("wake_permit_verification_reference_invalid");
      verifiedRefs = {};
    }
  }
  if (classification.state === "responsive_idle") {
    if (classification.wakeDisposition !== "eligible_tier1_continuation") {
      reasons.push("classification_not_tier1_eligible");
    }
    return {
      allowed: reasons.length === 0,
      tier: reasons.length === 0 ? 1 : 0,
      reasonCodes: reasons.length === 0 ? ["tier1_wake_permit_verified"] : reasons,
      permitDigestSha256: digest(permit),
      ...verifiedRefs,
      authority: WEBCHAT_SUPERVISOR_AUTHORITY,
    };
  }
  if (classification.state === "terminal_error") {
    if (classification.wakeDisposition !== "eligible_tier2_recovery_review") {
      reasons.push("terminal_error_requires_manual_or_non_wake_recovery");
    }
    return {
      allowed: false,
      tier: reasons.length === 0 ? 2 : 0,
      reasonCodes: reasons.length === 0
        ? ["tier2_recovery_review_required_before_any_ui_effect"]
        : reasons,
      permitDigestSha256: digest(permit),
      ...verifiedRefs,
      authority: WEBCHAT_SUPERVISOR_AUTHORITY,
    };
  }
  reasons.push("operational_state_not_wake_eligible");
  return {
    allowed: false,
    tier: 0,
    reasonCodes: reasons,
    permitDigestSha256: digest(permit),
    ...verifiedRefs,
    authority: WEBCHAT_SUPERVISOR_AUTHORITY,
  };
}

export function buildWebChatWakeEnvelope(
  rawPermit: WebChatWakePermit,
): WebChatWakeEnvelope {
  const permit = validateWakePermit(rawPermit);
  const lines = [
    "[ZES A2A WAKE v1]",
    `message_ref: ${permit.pendingMessageRef}`,
    ...(permit.threadRef ? [`thread_ref: ${permit.threadRef}`] : []),
    ...(permit.taskRef ? [`task_ref: ${permit.taskRef}`] : []),
    ...(permit.correlationRef ? [`correlation_ref: ${permit.correlationRef}`] : []),
    "action: Call execution_scope_message_inbox first. Reconcile current workspace, authority, effect, and recovery state. Continue only if the pending instruction remains applicable.",
  ];
  const text = lines.join("\n");
  if (text.length > 4_000) {
    throw new WebChatSupervisorPolicyError(
      "wake_envelope_too_large",
      "The correlated WebChat wake envelope exceeds the bounded prompt limit.",
    );
  }
  return {
    schemaVersion: 1,
    text,
    textDigestSha256: digest(text),
    pendingMessageRef: permit.pendingMessageRef,
    ...(permit.correlationRef ? { correlationRef: permit.correlationRef } : {}),
  };
}

export function validateWebChatWakeEnvelope(
  envelope: WebChatWakeEnvelope,
): WebChatWakeEnvelope {
  if (envelope.schemaVersion !== 1) {
    throw new WebChatSupervisorPolicyError(
      "unsupported_wake_envelope_schema",
      `Unsupported wake envelope schema: ${String(envelope.schemaVersion)}.`,
    );
  }
  const text = boundedText(envelope.text, "wakeEnvelope.text", 4_000);
  const textDigestSha256 = normalizedSha256(
    envelope.textDigestSha256,
    "wakeEnvelope.textDigestSha256",
  );
  if (digest(text) !== textDigestSha256) {
    throw new WebChatSupervisorPolicyError(
      "wake_envelope_digest_mismatch",
      "The wake envelope text was modified after its digest was established.",
    );
  }
  return {
    schemaVersion: 1,
    text,
    textDigestSha256,
    pendingMessageRef: boundedOpaqueRef(
      envelope.pendingMessageRef,
      "wakeEnvelope.pendingMessageRef",
      1_000,
    ),
    ...(envelope.correlationRef
      ? {
          correlationRef: boundedOpaqueRef(
            envelope.correlationRef,
            "wakeEnvelope.correlationRef",
            1_000,
          ),
        }
      : {}),
  };
}

export function validateWebChatWakeDraft(input: {
  draft: WebChatWakeDraft;
  permit: WebChatWakePermit;
  binding: WebChatSessionUiBinding;
}): WebChatWakeDraft {
  const binding = validateWebChatSessionUiBinding(input.binding);
  const permit = validateWakePermit(input.permit);
  const draft = input.draft;
  if (draft.schemaVersion !== 1 || draft.persistence !== "ephemeral_only") {
    throw new WebChatSupervisorPolicyError(
      "unsupported_wake_draft_schema",
      "The wake draft must use the ephemeral-only schema.",
    );
  }
  const envelope = validateWebChatWakeEnvelope(draft.envelope);
  const expectedEnvelope = buildWebChatWakeEnvelope(permit);
  if (
    envelope.text !== expectedEnvelope.text
    || envelope.textDigestSha256 !== expectedEnvelope.textDigestSha256
    || envelope.pendingMessageRef !== permit.pendingMessageRef
  ) {
    throw new WebChatSupervisorPolicyError(
      "wake_draft_envelope_permit_mismatch",
      "The wake draft envelope does not match the exact authorized permit.",
    );
  }
  const composerTargetRef = boundedOpaqueRef(
    draft.composerTargetRef,
    "wakeDraft.composerTargetRef",
    2_000,
  );
  const sendTargetRef = boundedOpaqueRef(
    draft.sendTargetRef,
    "wakeDraft.sendTargetRef",
    2_000,
  );
  const messageListTargetRef = boundedOpaqueRef(
    draft.messageListTargetRef,
    "wakeDraft.messageListTargetRef",
    2_000,
  );
  const composeRequest = structuredClone(draft.composeRequest);
  if (
    composeRequest.kind !== "type"
    || composeRequest.effectClass !== "reversible"
    || composeRequest.target.strategy !== "semantic"
    || composeRequest.target.targetRef !== composerTargetRef
    || composeRequest.payloadDigestSha256 !== envelope.textDigestSha256
    || composeRequest.declaredIdempotent !== true
    || composeRequest.approval.state !== "approved"
    || composeRequest.approval.ref !== permit.permitRef
    || composeRequest.approval.actorRef !== permit.issuerExecutionScopeRef
    || composeRequest.idempotencyKey !== `${permit.idempotencyKey}:compose`
    || !composeRequest.postconditions?.some((condition) =>
      condition.kind === "value_equals"
      && condition.expected === `sha256:${envelope.textDigestSha256}`
      && condition.targetRef === composerTargetRef)
  ) {
    throw new WebChatSupervisorPolicyError(
      "wake_draft_compose_request_mismatch",
      "The compose request does not match the exact envelope, permit, and semantic composer target.",
    );
  }
  normalizedSha256(
    composeRequest.expectedPreStateDigestSha256,
    "wakeDraft.composeRequest.expectedPreStateDigestSha256",
  );
  boundedText(
    composeRequest.expectedObservationId,
    "wakeDraft.composeRequest.expectedObservationId",
    200,
  );
  const permitRef = boundedOpaqueRef(
    draft.permitRef,
    "wakeDraft.permitRef",
    1_000,
  );
  const bindingRef = boundedOpaqueRef(
    draft.bindingRef,
    "wakeDraft.bindingRef",
    1_000,
  );
  const bindingEpoch = positiveInteger(
    draft.bindingEpoch,
    "wakeDraft.bindingEpoch",
  );
  const classificationDigestSha256 = normalizedSha256(
    draft.classificationDigestSha256,
    "wakeDraft.classificationDigestSha256",
  );
  if (
    permitRef !== permit.permitRef
    || bindingRef !== binding.bindingRef
    || bindingEpoch !== binding.bindingEpoch
    || classificationDigestSha256 !== permit.expectedClassificationDigestSha256
  ) {
    throw new WebChatSupervisorPolicyError(
      "wake_draft_binding_or_classification_mismatch",
      "The wake draft no longer matches the exact permit, binding epoch, and classified observation.",
    );
  }
  return {
    schemaVersion: 1,
    persistence: "ephemeral_only",
    permitRef,
    bindingRef,
    bindingEpoch,
    preparedAt: normalizedTimestamp(draft.preparedAt, "wakeDraft.preparedAt"),
    classificationDigestSha256,
    envelope,
    beforeUserTurnCount: nonNegativeInteger(
      draft.beforeUserTurnCount,
      "wakeDraft.beforeUserTurnCount",
    ),
    beforeAssistantTurnCount: nonNegativeInteger(
      draft.beforeAssistantTurnCount,
      "wakeDraft.beforeAssistantTurnCount",
    ),
    ...(draft.beforeLastUserMessageDigestSha256
      ? {
          beforeLastUserMessageDigestSha256: normalizedSha256(
            draft.beforeLastUserMessageDigestSha256,
            "wakeDraft.beforeLastUserMessageDigestSha256",
          ),
        }
      : {}),
    ...(draft.beforeLastAssistantMessageDigestSha256
      ? {
          beforeLastAssistantMessageDigestSha256: normalizedSha256(
            draft.beforeLastAssistantMessageDigestSha256,
            "wakeDraft.beforeLastAssistantMessageDigestSha256",
          ),
        }
      : {}),
    composerTargetRef,
    sendTargetRef,
    messageListTargetRef,
    composeRequest,
  };
}

export function validateWebChatWakeSubmitDraft(input: {
  submit: WebChatWakeSubmitDraft;
  draft: WebChatWakeDraft;
  permit: WebChatWakePermit;
  binding: WebChatSessionUiBinding;
}): WebChatWakeSubmitDraft {
  const binding = validateWebChatSessionUiBinding(input.binding);
  const permit = validateWakePermit(input.permit);
  const draft = validateWebChatWakeDraft({
    draft: input.draft,
    permit,
    binding,
  });
  const submit = input.submit;
  if (submit.schemaVersion !== 1) {
    throw new WebChatSupervisorPolicyError(
      "unsupported_wake_submit_schema",
      `Unsupported wake submit schema: ${String(submit.schemaVersion)}.`,
    );
  }
  const request = structuredClone(submit.request);
  if (
    request.kind !== "click"
    || request.effectClass !== "irreversible"
    || request.target.strategy !== "semantic"
    || request.target.targetRef !== draft.sendTargetRef
    || request.payloadDigestSha256 !== draft.envelope.textDigestSha256
    || request.declaredIdempotent !== false
    || request.approval.state !== "approved"
    || request.approval.ref !== permit.permitRef
    || request.approval.actorRef !== permit.issuerExecutionScopeRef
    || request.idempotencyKey !== `${permit.idempotencyKey}:submit`
    || !request.postconditions?.some((condition) =>
      condition.kind === "custom"
      && condition.expected
        === `last_user_message_sha256:${draft.envelope.textDigestSha256}`
      && condition.targetRef === draft.messageListTargetRef)
    || !request.postconditions?.some((condition) =>
      condition.kind === "custom"
      && condition.expected
        === `generation_boundary_after_user_turn:${String(draft.beforeUserTurnCount)}`
      && condition.targetRef === draft.messageListTargetRef)
  ) {
    throw new WebChatSupervisorPolicyError(
      "wake_submit_request_mismatch",
      "The submit request does not match the exact permit, envelope, and semantic send target.",
    );
  }
  normalizedSha256(
    request.expectedPreStateDigestSha256,
    "wakeSubmit.request.expectedPreStateDigestSha256",
  );
  boundedText(
    request.expectedObservationId,
    "wakeSubmit.request.expectedObservationId",
    200,
  );
  const validated: WebChatWakeSubmitDraft = {
    schemaVersion: 1,
    permitRef: boundedOpaqueRef(submit.permitRef, "wakeSubmit.permitRef", 1_000),
    bindingRef: boundedOpaqueRef(submit.bindingRef, "wakeSubmit.bindingRef", 1_000),
    bindingEpoch: positiveInteger(submit.bindingEpoch, "wakeSubmit.bindingEpoch"),
    preparedAt: normalizedTimestamp(submit.preparedAt, "wakeSubmit.preparedAt"),
    request,
  };
  if (Date.parse(validated.preparedAt) < Date.parse(draft.preparedAt)) {
    throw new WebChatSupervisorPolicyError(
      "wake_submit_precedes_compose_draft",
      "The submit draft cannot precede the compose draft it consumes.",
    );
  }
  if (
    validated.permitRef !== permit.permitRef
    || validated.bindingRef !== binding.bindingRef
    || validated.bindingEpoch !== binding.bindingEpoch
  ) {
    throw new WebChatSupervisorPolicyError(
      "wake_submit_draft_binding_mismatch",
      "The submit draft does not match the exact permit and WebChat binding.",
    );
  }
  return validated;
}

export function buildWebChatWakeDraft(input: {
  binding: WebChatSessionUiBinding;
  classification: WebChatSessionClassification;
  permit: WebChatWakePermit;
  sample: WebChatObservationSample;
  interactionObservation: InteractionObservation;
  permitVerifier?: WebChatWakePermitVerifier;
  nowMs?: number;
}): WebChatWakeDraft {
  const binding = validateWebChatSessionUiBinding(input.binding);
  const classification = validateWebChatSessionClassification(input.classification);
  const permit = validateWakePermit(input.permit);
  const sample = validateObservationSample(input.sample);
  const authorization = authorizeWebChatWakePermit({
    binding,
    classification,
    permit,
    permitVerifier: input.permitVerifier,
    nowMs: input.nowMs,
  });
  if (!authorization.allowed || authorization.tier !== 1) {
    throw new WebChatSupervisorPolicyError(
      "wake_permit_not_authorized",
      `The wake permit is not authorized: ${authorization.reasonCodes.join(", ")}.`,
    );
  }
  if (!isIdleSample(sample) || !sample.ui.composerEmpty) {
    throw new WebChatSupervisorPolicyError(
      "wake_draft_requires_empty_responsive_composer",
      "Tier-1 wake composition requires an empty, enabled, responsive composer.",
    );
  }
  const bindingReasons = bindingMismatchReasons(binding, sample);
  const selectorReasons = selectorContractMismatchReasons(binding, sample.ui);
  if (bindingReasons.length > 0 || selectorReasons.length > 0) {
    throw new WebChatSupervisorPolicyError(
      "wake_draft_binding_or_selector_mismatch",
      "The current WebChat sample no longer matches the exact binding and selector contract.",
    );
  }
  if (
    sample.stateDigestSha256 !== classification.observationStateDigestSha256
    || sample.stateDigestSha256
      !== permit.expectedObservationStateDigestSha256
  ) {
    throw new WebChatSupervisorPolicyError(
      "wake_draft_observation_state_mismatch",
      "The wake permit and classification are not bound to the current observation state.",
    );
  }
  assertInteractionObservationMatchesBinding(input.interactionObservation, binding);
  const composerTargetRef = sample.ui.selectorContract.composerReplaceTargetRef
    ?? sample.ui.selectorContract.composerTargetRef;
  const sendTargetRef = sample.ui.selectorContract.sendTargetRef;
  const messageListTargetRef = sample.ui.selectorContract.messageListTargetRef;
  if (!composerTargetRef || !sendTargetRef || !messageListTargetRef) {
    throw new WebChatSupervisorPolicyError(
      "wake_semantic_targets_missing",
      "The current selector contract does not expose exact composer, send, and message-list targets.",
    );
  }
  const envelope = buildWebChatWakeEnvelope(permit);
  const preparedAt = new Date(input.nowMs ?? Date.now()).toISOString();
  const composeRequest: InteractionActionRequest = {
    idempotencyKey: `${permit.idempotencyKey}:compose`,
    kind: "type",
    effectClass: "reversible",
    target: {
      strategy: "semantic",
      targetRef: composerTargetRef,
    },
    expectedObservationId: input.interactionObservation.observationId,
    expectedPreStateDigestSha256: input.interactionObservation.stateDigestSha256,
    payloadDigestSha256: envelope.textDigestSha256,
    declaredIdempotent: true,
    approval: {
      state: "approved",
      ref: permit.permitRef,
      actorRef: permit.issuerExecutionScopeRef,
    },
    postconditions: [
      {
        kind: "value_equals",
        expected: `sha256:${envelope.textDigestSha256}`,
        targetRef: composerTargetRef,
      },
    ],
    timeoutMs: 30_000,
  };
  return {
    schemaVersion: 1,
    persistence: "ephemeral_only",
    permitRef: permit.permitRef,
    bindingRef: binding.bindingRef,
    bindingEpoch: binding.bindingEpoch,
    preparedAt,
    classificationDigestSha256: classification.classificationDigestSha256,
    envelope,
    beforeUserTurnCount: sample.ui.userTurnCount,
    beforeAssistantTurnCount: sample.ui.assistantTurnCount,
    ...(sample.ui.lastUserMessageDigestSha256
      ? { beforeLastUserMessageDigestSha256: sample.ui.lastUserMessageDigestSha256 }
      : {}),
    ...(sample.ui.lastAssistantMessageDigestSha256
      ? {
          beforeLastAssistantMessageDigestSha256:
            sample.ui.lastAssistantMessageDigestSha256,
        }
      : {}),
    composerTargetRef,
    sendTargetRef,
    messageListTargetRef,
    composeRequest,
  };
}

export function createWebChatEphemeralWakePayload(input: {
  draft: WebChatWakeDraft;
  permit: WebChatWakePermit;
  binding: WebChatSessionUiBinding;
  payloadRef: string;
  nowMs?: number;
  ttlMs?: number;
}): WebChatEphemeralWakePayload {
  const draft = validateWebChatWakeDraft({
    draft: input.draft,
    permit: input.permit,
    binding: input.binding,
  });
  const nowMs = input.nowMs ?? Date.now();
  const ttlMs = input.ttlMs ?? 60_000;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > 5 * 60_000) {
    throw new WebChatSupervisorPolicyError(
      "wake_payload_ttl_invalid",
      "The ephemeral wake payload TTL must be positive and no longer than five minutes.",
    );
  }
  return {
    schemaVersion: 1,
    persistence: "ephemeral_only",
    payloadRef: boundedOpaqueRef(input.payloadRef, "payloadRef", 1_000),
    permitRef: boundedOpaqueRef(draft.permitRef, "permitRef", 1_000),
    bindingRef: boundedOpaqueRef(draft.bindingRef, "bindingRef", 1_000),
    bindingEpoch: positiveInteger(draft.bindingEpoch, "bindingEpoch"),
    text: boundedText(draft.envelope.text, "wakePayload.text", 4_000),
    textDigestSha256: normalizedSha256(
      draft.envelope.textDigestSha256,
      "wakePayload.textDigestSha256",
    ),
    issuedAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + ttlMs).toISOString(),
  };
}

export function resolveWebChatEphemeralWakePayload(input: {
  binding: WebChatSessionUiBinding;
  action: InteractionPreparedAction;
  payload: WebChatEphemeralWakePayload;
  nowMs?: number;
}): string {
  const binding = validateWebChatSessionUiBinding(input.binding);
  const payload = validateEphemeralWakePayload(input.payload);
  const nowMs = input.nowMs ?? Date.now();
  if (Date.parse(payload.issuedAt) > nowMs || Date.parse(payload.expiresAt) <= nowMs) {
    throw new WebChatSupervisorPolicyError(
      "wake_payload_expired_or_not_yet_valid",
      "The ephemeral wake payload is outside its validity window.",
    );
  }
  if (
    payload.bindingRef !== binding.bindingRef
    || payload.bindingEpoch !== binding.bindingEpoch
    || payload.permitRef !== input.action.approvalRef
    || input.action.kind !== "type"
    || input.action.effectClass !== "reversible"
    || input.action.payloadDigestSha256 !== payload.textDigestSha256
  ) {
    throw new WebChatSupervisorPolicyError(
      "wake_payload_action_mismatch",
      "The ephemeral wake payload does not match the exact prepared compose action.",
    );
  }
  assertPreparedActionMatchesBinding(input.action, binding);
  if (digest(payload.text) !== payload.textDigestSha256) {
    throw new WebChatSupervisorPolicyError(
      "wake_payload_digest_mismatch",
      "The ephemeral wake payload text does not match its bound digest.",
    );
  }
  return payload.text;
}

export function createWebChatWakeApprovalVerifier(input: {
  binding: WebChatSessionUiBinding;
  classification: WebChatSessionClassification;
  permit: WebChatWakePermit;
  permitVerifier: WebChatWakePermitVerifier;
  now?: () => number;
}): InteractionApprovalVerifier {
  const binding = validateWebChatSessionUiBinding(input.binding);
  const classification = validateWebChatSessionClassification(input.classification);
  const permit = validateWakePermit(input.permit);
  const now = input.now ?? Date.now;
  const authorization = authorizeWebChatWakePermit({
    binding,
    classification,
    permit,
    permitVerifier: input.permitVerifier,
    nowMs: now(),
  });
  if (!authorization.allowed || authorization.tier !== 1) {
    throw new WebChatSupervisorPolicyError(
      "wake_approval_verifier_requires_authorized_permit",
      `Cannot build an interaction approval verifier: ${authorization.reasonCodes.join(", ")}.`,
    );
  }
  const envelope = buildWebChatWakeEnvelope(permit);
  return (approvalInput) => {
    const currentAuthorization = authorizeWebChatWakePermit({
      binding,
      classification,
      permit,
      permitVerifier: input.permitVerifier,
      nowMs: now(),
    });
    const exactBinding = interactionBindingEquals(
      approvalInput.binding,
      binding.interactionBinding,
    );
    const allowedShape = (
      approvalInput.actionKind === "type"
      && approvalInput.effectClass === "reversible"
    ) || (
      approvalInput.actionKind === "click"
      && approvalInput.effectClass === "irreversible"
    );
    const verified = currentAuthorization.allowed
      && currentAuthorization.tier === 1
      && approvalInput.identity.executionScopeRef
        === permit.issuerExecutionScopeRef
      && exactBinding
      && approvalInput.approval.state === "approved"
      && approvalInput.approval.ref === permit.permitRef
      && approvalInput.approval.actorRef === permit.issuerExecutionScopeRef
      && approvalInput.payloadDigestSha256 === envelope.textDigestSha256
      && allowedShape;
    return verified
      ? {
          verified: true,
          verificationRef:
            `wake-approval-verification://${digest({
              permitRef: permit.permitRef,
              actionKind: approvalInput.actionKind,
              effectClass: approvalInput.effectClass,
              payloadDigestSha256: approvalInput.payloadDigestSha256,
            })}`,
          authorityReadbackRef: currentAuthorization.authorityReadbackRef,
        }
      : { verified: false };
  };
}

export function buildWebChatWakeSubmitRequest(input: {
  binding: WebChatSessionUiBinding;
  permit: WebChatWakePermit;
  draft: WebChatWakeDraft;
  sample: WebChatObservationSample;
  interactionObservation: InteractionObservation;
  nowMs?: number;
}): WebChatWakeSubmitDraft {
  const binding = validateWebChatSessionUiBinding(input.binding);
  const permit = validateWakePermit(input.permit);
  const draft = validateWebChatWakeDraft({
    draft: input.draft,
    permit,
    binding,
  });
  const sample = validateObservationSample(input.sample);
  if (
    draft.permitRef !== permit.permitRef
    || draft.bindingRef !== binding.bindingRef
    || draft.bindingEpoch !== binding.bindingEpoch
  ) {
    throw new WebChatSupervisorPolicyError(
      "wake_submit_binding_or_permit_mismatch",
      "The wake draft no longer matches the current binding and permit.",
    );
  }
  const bindingReasons = bindingMismatchReasons(binding, sample);
  const selectorReasons = selectorContractMismatchReasons(binding, sample.ui);
  if (bindingReasons.length > 0 || selectorReasons.length > 0) {
    throw new WebChatSupervisorPolicyError(
      "wake_submit_current_binding_or_selector_mismatch",
      "The staged composer sample no longer matches the exact binding and selector contract.",
    );
  }
  assertInteractionObservationMatchesBinding(input.interactionObservation, binding);
  if (
    sample.ui.composerValueDigestSha256 !== draft.envelope.textDigestSha256
    || !sample.ui.sendControlVisible
    || !sample.ui.sendControlEnabled
    || hasGenerationSignal(sample)
    || sample.ui.explicitErrorVisible
    || sample.browser.heartbeatStatus !== "responsive"
    || !sample.ui.conversationLoaded
  ) {
    throw new WebChatSupervisorPolicyError(
      "wake_submit_preconditions_not_met",
      "The correlated envelope is not exactly staged in an idle composer with an enabled send control.",
    );
  }
  const request: InteractionActionRequest = {
    idempotencyKey: `${permit.idempotencyKey}:submit`,
    kind: "click",
    effectClass: "irreversible",
    target: {
      strategy: "semantic",
      targetRef: draft.sendTargetRef,
    },
    expectedObservationId: input.interactionObservation.observationId,
    expectedPreStateDigestSha256: input.interactionObservation.stateDigestSha256,
    payloadDigestSha256: draft.envelope.textDigestSha256,
    declaredIdempotent: false,
    approval: {
      state: "approved",
      ref: permit.permitRef,
      actorRef: permit.issuerExecutionScopeRef,
    },
    postconditions: [
      {
        kind: "custom",
        expected: `last_user_message_sha256:${draft.envelope.textDigestSha256}`,
        targetRef: draft.messageListTargetRef,
      },
      {
        kind: "custom",
        expected: `generation_boundary_after_user_turn:${String(draft.beforeUserTurnCount)}`,
        targetRef: draft.messageListTargetRef,
      },
    ],
    timeoutMs: 45_000,
  };
  const preparedAtMs = input.nowMs ?? Date.now();
  if (preparedAtMs < Date.parse(draft.preparedAt)) {
    throw new WebChatSupervisorPolicyError(
      "wake_submit_precedes_compose_draft",
      "The submit action cannot be prepared before the compose draft.",
    );
  }
  return {
    schemaVersion: 1,
    permitRef: permit.permitRef,
    bindingRef: binding.bindingRef,
    bindingEpoch: binding.bindingEpoch,
    preparedAt: new Date(preparedAtMs).toISOString(),
    request,
  };
}

export function assessWebChatWakeVerification(input: {
  binding: WebChatSessionUiBinding;
  permit: WebChatWakePermit;
  draft: WebChatWakeDraft;
  submit: WebChatWakeSubmitDraft;
  after: WebChatObservationSample;
}): WebChatWakeVerification {
  const binding = validateWebChatSessionUiBinding(input.binding);
  const permit = validateWakePermit(input.permit);
  const draft = validateWebChatWakeDraft({
    draft: input.draft,
    permit,
    binding,
  });
  const submit = validateWebChatWakeSubmitDraft({
    submit: input.submit,
    draft,
    permit,
    binding,
  });
  const after = validateObservationSample(input.after);
  if (
    submit.permitRef !== draft.permitRef
    || submit.bindingRef !== binding.bindingRef
    || submit.bindingEpoch !== binding.bindingEpoch
  ) {
    return {
      schemaVersion: 1,
      status: "binding_mismatch",
      interactionVerified: false,
      messageAdmitted: false,
      generationBoundaryObserved: false,
      reasonCodes: ["submit_draft_binding_mismatch"],
      evidenceRefs: after.evidenceRefs,
      authority: WEBCHAT_SUPERVISOR_AUTHORITY,
    };
  }
  if (
    bindingMismatchReasons(binding, after).length > 0
    || selectorContractMismatchReasons(binding, after.ui).length > 0
  ) {
    return {
      schemaVersion: 1,
      status: "binding_mismatch",
      interactionVerified: false,
      messageAdmitted: false,
      generationBoundaryObserved: false,
      reasonCodes: ["post_submit_binding_mismatch"],
      evidenceRefs: after.evidenceRefs,
      authority: WEBCHAT_SUPERVISOR_AUTHORITY,
    };
  }
  if (
    !after.browser.browserProcessAlive
    || !after.browser.browserConnected
    || !after.browser.targetPresent
    || after.browser.targetCrashed
    || after.browser.pageClosed
    || after.browser.heartbeatStatus !== "responsive"
  ) {
    return {
      schemaVersion: 1,
      status: "indeterminate",
      interactionVerified: false,
      messageAdmitted: false,
      generationBoundaryObserved: false,
      reasonCodes: ["post_submit_browser_or_page_readback_unavailable"],
      evidenceRefs: after.evidenceRefs,
      authority: WEBCHAT_SUPERVISOR_AUTHORITY,
    };
  }
  const messageAdmitted = after.ui.userTurnCount > draft.beforeUserTurnCount
    && after.ui.lastUserMessageDigestSha256
      === draft.envelope.textDigestSha256;
  const generationBoundaryObserved = messageAdmitted && (
    after.ui.assistantTurnCount > draft.beforeAssistantTurnCount
    || after.ui.assistantPlaceholderVisible
    || after.ui.stopControlVisible
    || after.ui.generationMarkerVisible
    || (after.network.generationRequestOpen
      && timestampAfter(after.network.generationRequestStartedAt, submit.preparedAt))
  );
  if (messageAdmitted && generationBoundaryObserved) {
    return {
      schemaVersion: 1,
      status: "verified",
      interactionVerified: true,
      messageAdmitted: true,
      generationBoundaryObserved: true,
      reasonCodes: ["wake_message_admitted_and_new_generation_boundary_observed"],
      evidenceRefs: after.evidenceRefs,
      authority: WEBCHAT_SUPERVISOR_AUTHORITY,
    };
  }
  if (messageAdmitted) {
    return {
      schemaVersion: 1,
      status: "message_admitted_generation_not_started",
      interactionVerified: false,
      messageAdmitted: true,
      generationBoundaryObserved: false,
      reasonCodes: ["wake_message_admitted_but_generation_boundary_not_proven"],
      evidenceRefs: after.evidenceRefs,
      authority: WEBCHAT_SUPERVISOR_AUTHORITY,
    };
  }
  if (
    after.ui.composerValueDigestSha256 === draft.envelope.textDigestSha256
    && after.ui.userTurnCount === draft.beforeUserTurnCount
  ) {
    return {
      schemaVersion: 1,
      status: "not_admitted",
      interactionVerified: false,
      messageAdmitted: false,
      generationBoundaryObserved: false,
      reasonCodes: ["wake_envelope_remains_in_composer_no_user_turn_admitted"],
      evidenceRefs: after.evidenceRefs,
      authority: WEBCHAT_SUPERVISOR_AUTHORITY,
    };
  }
  return {
    schemaVersion: 1,
    status: "indeterminate",
    interactionVerified: false,
    messageAdmitted: false,
    generationBoundaryObserved: false,
    reasonCodes: ["post_submit_state_does_not_prove_admission_or_no_effect"],
    evidenceRefs: after.evidenceRefs,
    authority: WEBCHAT_SUPERVISOR_AUTHORITY,
  };
}

export function webChatWakeInteractionIntent(): InteractionIntent {
  return {
    targetKind: "browser",
    effectClass: "irreversible",
    requiredCapabilities: [
      "observe",
      "verify",
      "semanticTargeting",
      "persistentSession",
      "visibleUi",
      "boundedTimeout",
    ],
    visibleUiRequired: true,
    existingSessionRequired: true,
    allowCoordinateFallback: false,
  };
}

function classification(
  binding: WebChatSessionUiBinding,
  current: WebChatObservationSample,
  state: WebChatOperationalState,
  confidence: WebChatSessionClassification["confidence"],
  reasonCodes: string[],
  wakeDisposition: WebChatWakeDisposition,
  nextAction: WebChatSessionClassification["nextAction"],
): WebChatSessionClassification {
  const basis = {
    state,
    confidence,
    observedAt: current.sampledAt,
    bindingRef: binding.bindingRef,
    bindingEpoch: binding.bindingEpoch,
    observationStateDigestSha256: current.stateDigestSha256,
    reasonCodes: [...new Set(reasonCodes)],
    evidenceRefs: current.evidenceRefs,
    wakeDisposition,
    nextAction,
  };
  return {
    schemaVersion: 1,
    ...basis,
    classificationDigestSha256: digest(basis),
    policy: webChatSupervisorPolicy(),
    authority: WEBCHAT_SUPERVISOR_AUTHORITY,
  };
}

function bindingMismatchReasons(
  binding: WebChatSessionUiBinding,
  sample: WebChatObservationSample,
): string[] {
  const reasons: string[] = [];
  if (sample.bindingRef !== binding.bindingRef) reasons.push("binding_ref_mismatch");
  if (sample.bindingEpoch !== binding.bindingEpoch) reasons.push("binding_epoch_mismatch");
  if (sample.browser.bindingEpoch !== binding.bindingEpoch) {
    reasons.push("browser_binding_epoch_mismatch");
  }
  if (sample.browser.browserContextRef !== binding.browserContextRef) {
    reasons.push("browser_context_ref_mismatch");
  }
  if (sample.browser.targetRef !== binding.targetRef) reasons.push("target_ref_mismatch");
  if (sample.browser.pageRef !== binding.pageRef) reasons.push("page_ref_mismatch");
  if (!sample.browser.targetUrlDigestSha256) {
    reasons.push("conversation_url_digest_missing");
  }
  if (
    sample.browser.targetUrlDigestSha256
    && sample.browser.targetUrlDigestSha256 !== binding.conversationUrlDigestSha256
  ) {
    reasons.push("conversation_url_digest_mismatch");
  }
  if (!sample.ui.conversationRefDigestSha256) {
    reasons.push("conversation_ref_digest_missing");
  }
  if (
    sample.ui.conversationRefDigestSha256
    && sample.ui.conversationRefDigestSha256 !== binding.conversationRefDigestSha256
  ) {
    reasons.push("conversation_ref_digest_mismatch");
  }
  return reasons;
}

function selectorContractMismatchReasons(
  binding: WebChatSessionUiBinding,
  ui: WebChatUiEvidence,
): string[] {
  const contract = ui.selectorContract;
  const reasons: string[] = [];
  if (contract.contractRef !== binding.selectorContractRef) {
    reasons.push("selector_contract_ref_mismatch");
  }
  if (contract.contractDigestSha256 !== binding.selectorContractDigestSha256) {
    reasons.push("selector_contract_digest_mismatch");
  }
  if (!contract.matched) reasons.push("selector_contract_not_matched");
  if (contract.ambiguous) reasons.push("selector_contract_ambiguous");
  if (contract.matchedRequiredTargetCount !== contract.requiredTargetCount) {
    reasons.push("selector_contract_required_targets_incomplete");
  }
  if (contract.driftReasonRefs.length > 0) reasons.push("selector_contract_drift_detected");
  return reasons;
}

function hasGenerationSignal(sample: WebChatObservationSample): boolean {
  return sample.ui.stopControlVisible
    || sample.ui.generationMarkerVisible
    || sample.ui.assistantPlaceholderVisible
    || sample.network.generationRequestOpen;
}

function progressEvidence(
  current: WebChatObservationSample,
  previous: WebChatObservationSample[],
  policy: WebChatClassifierPolicy,
  nowMs: number,
): { active: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const prior = previous.find((sample) =>
    sample.bindingEpoch === current.bindingEpoch
    && sample.ui.conversationRefDigestSha256
      === current.ui.conversationRefDigestSha256);
  if (prior) {
    if (
      current.ui.lastAssistantMessageLength > prior.ui.lastAssistantMessageLength
      || (current.ui.lastAssistantMessageDigestSha256
        && current.ui.lastAssistantMessageDigestSha256
          !== prior.ui.lastAssistantMessageDigestSha256)
      || (current.ui.domMutationSequence !== undefined
        && prior.ui.domMutationSequence !== undefined
        && current.ui.domMutationSequence > prior.ui.domMutationSequence)
    ) {
      reasons.push("assistant_dom_or_output_advanced");
    }
  }
  for (const [code, timestamp] of [
    ["recent_dom_mutation", current.ui.lastDomMutationAt],
    ["recent_generation_byte", current.network.lastGenerationByteAt],
    ["recent_websocket_frame", current.network.lastWebSocketFrameAt],
    ["recent_event_source_message", current.network.lastEventSourceMessageAt],
  ] as const) {
    const ageMs = timestamp ? nowMs - Date.parse(timestamp) : undefined;
    if (ageMs !== undefined && ageMs >= 0 && ageMs <= policy.recentProgressMs) {
      reasons.push(code);
    }
  }
  return { active: reasons.length > 0, reasons };
}

function sustainedGenerationStall(
  current: WebChatObservationSample,
  previous: WebChatObservationSample[],
  policy: WebChatClassifierPolicy,
): { suspected: boolean; reasons: string[] } {
  const coherent = [current, ...previous]
    .filter((sample) => sample.bindingEpoch === current.bindingEpoch)
    .filter(hasGenerationSignal)
    .sort((left, right) => Date.parse(left.sampledAt) - Date.parse(right.sampledAt));
  if (coherent.length < policy.minimumStallSamples) {
    return { suspected: false, reasons: ["stall_sample_count_insufficient"] };
  }
  const bounded = coherent.slice(-policy.minimumStallSamples);
  const spanMs = Date.parse(bounded.at(-1)?.sampledAt ?? current.sampledAt)
    - Date.parse(bounded[0]?.sampledAt ?? current.sampledAt);
  if (spanMs < policy.minimumStallObservationSpanMs) {
    return { suspected: false, reasons: ["stall_observation_span_insufficient"] };
  }
  if (bounded.some((sample) => sample.network.generationRequestOpen)) {
    return { suspected: false, reasons: ["generation_request_still_open"] };
  }
  if (bounded.some((sample) => sample.browser.heartbeatStatus !== "responsive")) {
    return { suspected: false, reasons: ["page_responsiveness_not_consistent"] };
  }
  if (bounded.some((sample) =>
    !sample.network.observationAvailable
    || sample.network.serviceWorkerMayHideEvents)) {
    return {
      suspected: false,
      reasons: ["network_observation_incomplete_or_service_worker_obscured"],
    };
  }
  const first = bounded[0];
  const last = bounded.at(-1);
  if (!first || !last) return { suspected: false, reasons: ["stall_window_missing"] };
  const unchanged = first.ui.lastAssistantMessageLength
      === last.ui.lastAssistantMessageLength
    && first.ui.lastAssistantMessageDigestSha256
      === last.ui.lastAssistantMessageDigestSha256
    && first.ui.domMutationSequence === last.ui.domMutationSequence;
  if (!unchanged) {
    return { suspected: false, reasons: ["assistant_output_changed_in_stall_window"] };
  }
  const windowStartedAtMs = Date.parse(first.sampledAt);
  if (bounded.some((sample) => [
    sample.network.lastGenerationByteAt,
    sample.network.lastWebSocketFrameAt,
    sample.network.lastEventSourceMessageAt,
  ].some((timestamp) => timestamp && Date.parse(timestamp) >= windowStartedAtMs))) {
    return { suspected: false, reasons: ["transport_progress_present_in_stall_window"] };
  }
  return {
    suspected: true,
    reasons: [
      `stall_samples:${String(bounded.length)}`,
      `stall_span_ms:${String(spanMs)}`,
      "network_observation_available_for_entire_stall_window",
    ],
  };
}

function isIdleSample(sample: WebChatObservationSample): boolean {
  return sample.browser.heartbeatStatus === "responsive"
    && sample.ui.conversationLoaded
    && sample.ui.composerPresent
    && sample.ui.composerEnabled
    && !sample.ui.stopControlVisible
    && !sample.ui.generationMarkerVisible
    && !sample.ui.assistantPlaceholderVisible
    && !sample.ui.explicitErrorVisible
    && !sample.ui.loginRequired
    && !sample.ui.accountAutomationWarningVisible
    && !sample.network.generationRequestOpen
    && sample.browser.lifecycleState !== "frozen"
    && sample.browser.lifecycleState !== "terminated"
    && sample.browser.lifecycleState !== "restored_after_discard";
}

function confirmedIdleSample(
  current: WebChatObservationSample,
  previous: WebChatObservationSample[],
  policy: WebChatClassifierPolicy,
): { confirmed: boolean; reasons: string[] } {
  const prior = previous.find((sample) =>
    sample.bindingEpoch === current.bindingEpoch
    && isIdleSample(sample)
    && sample.ui.conversationRefDigestSha256
      === current.ui.conversationRefDigestSha256);
  if (!prior) return { confirmed: false, reasons: ["prior_idle_sample_missing"] };
  const spanMs = Date.parse(current.sampledAt) - Date.parse(prior.sampledAt);
  if (spanMs < policy.idleConfirmationSpanMs) {
    return { confirmed: false, reasons: ["idle_confirmation_span_too_short"] };
  }
  return {
    confirmed: true,
    reasons: [
      `idle_confirmation_span_ms:${String(spanMs)}`,
      ...(current.ui.composerEmpty ? ["composer_empty"] : ["composer_contains_staged_text"]),
    ],
  };
}

function validateObservationSample(
  sample: WebChatObservationSample,
): WebChatObservationSample {
  if (sample.schemaVersion !== 1) {
    throw new WebChatSupervisorPolicyError(
      "unsupported_observation_schema",
      `Unsupported WebChat observation schema: ${String(sample.schemaVersion)}.`,
    );
  }
  const validated: WebChatObservationSample = structuredClone(sample);
  validated.sampledAt = normalizedTimestamp(sample.sampledAt, "sampledAt");
  validated.bindingRef = boundedOpaqueRef(sample.bindingRef, "bindingRef", 1_000);
  validated.bindingEpoch = positiveInteger(sample.bindingEpoch, "bindingEpoch");
  validated.stateDigestSha256 = normalizedSha256(
    sample.stateDigestSha256,
    "stateDigestSha256",
  );
  validated.executor = validateExecutorEvidence(sample.executor);
  validated.browser = validateBrowserEvidence(sample.browser);
  validated.ui = validateUiEvidence(sample.ui);
  validated.network = validateNetworkEvidence(sample.network);
  validated.evidenceRefs = boundedRefs(sample.evidenceRefs, "evidenceRefs", 100);
  validated.authority = WEBCHAT_SUPERVISOR_AUTHORITY;
  if (validated.evidenceRefs.length === 0) {
    throw new WebChatSupervisorPolicyError(
      "observation_evidence_required",
      "A WebChat operational observation requires bounded evidence references.",
    );
  }
  return validated;
}

function validateExecutorEvidence(
  evidence: WebChatExecutorEvidence,
): WebChatExecutorEvidence {
  return {
    observedAt: normalizedTimestamp(evidence.observedAt, "executor.observedAt"),
    scopeMaterialized: Boolean(evidence.scopeMaterialized),
    runningToolCount: nonNegativeInteger(
      evidence.runningToolCount,
      "executor.runningToolCount",
    ),
    runningProcessCount: nonNegativeInteger(
      evidence.runningProcessCount,
      "executor.runningProcessCount",
    ),
    ...(evidence.lastMcpActivityAt
      ? {
          lastMcpActivityAt: normalizedTimestamp(
            evidence.lastMcpActivityAt,
            "executor.lastMcpActivityAt",
          ),
        }
      : {}),
    ...(evidence.observationGapMs === undefined
      ? {}
      : {
          observationGapMs: nonNegativeFinite(
            evidence.observationGapMs,
            "executor.observationGapMs",
          ),
        }),
    ...(evidence.interactionState
      ? { interactionState: evidence.interactionState }
      : {}),
    pendingInteractionAction: Boolean(evidence.pendingInteractionAction),
  };
}

function validateBrowserEvidence(
  evidence: WebChatBrowserEvidence,
): WebChatBrowserEvidence {
  return {
    observedAt: normalizedTimestamp(evidence.observedAt, "browser.observedAt"),
    browserProcessAlive: Boolean(evidence.browserProcessAlive),
    browserConnected: Boolean(evidence.browserConnected),
    browserContextPresent: Boolean(evidence.browserContextPresent),
    targetPresent: Boolean(evidence.targetPresent),
    targetCrashed: Boolean(evidence.targetCrashed),
    pageClosed: Boolean(evidence.pageClosed),
    browserContextRef: boundedOpaqueRef(
      evidence.browserContextRef,
      "browser.browserContextRef",
      1_000,
    ),
    targetRef: boundedOpaqueRef(evidence.targetRef, "browser.targetRef", 1_000),
    pageRef: boundedOpaqueRef(evidence.pageRef, "browser.pageRef", 1_000),
    bindingEpoch: positiveInteger(evidence.bindingEpoch, "browser.bindingEpoch"),
    ...(evidence.targetUrlDigestSha256
      ? {
          targetUrlDigestSha256: normalizedSha256(
            evidence.targetUrlDigestSha256,
            "browser.targetUrlDigestSha256",
          ),
        }
      : {}),
    lifecycleState: evidence.lifecycleState,
    documentWasDiscarded: Boolean(evidence.documentWasDiscarded),
    heartbeatStatus: evidence.heartbeatStatus,
    ...(evidence.heartbeatRoundTripMs === undefined
      ? {}
      : {
          heartbeatRoundTripMs: nonNegativeFinite(
            evidence.heartbeatRoundTripMs,
            "browser.heartbeatRoundTripMs",
          ),
        }),
    ...(evidence.lastLifecycleEventAt
      ? {
          lastLifecycleEventAt: normalizedTimestamp(
            evidence.lastLifecycleEventAt,
            "browser.lastLifecycleEventAt",
          ),
        }
      : {}),
    ...(evidence.networkOnline === undefined
      ? {}
      : { networkOnline: Boolean(evidence.networkOnline) }),
  };
}

function validateUiEvidence(evidence: WebChatUiEvidence): WebChatUiEvidence {
  const contract = evidence.selectorContract;
  return {
    observedAt: normalizedTimestamp(evidence.observedAt, "ui.observedAt"),
    conversationLoaded: Boolean(evidence.conversationLoaded),
    ...(evidence.conversationRefDigestSha256
      ? {
          conversationRefDigestSha256: normalizedSha256(
            evidence.conversationRefDigestSha256,
            "ui.conversationRefDigestSha256",
          ),
        }
      : {}),
    selectorContract: {
      contractRef: boundedOpaqueRef(
        contract.contractRef,
        "selectorContract.contractRef",
        1_000,
      ),
      contractDigestSha256: normalizedSha256(
        contract.contractDigestSha256,
        "selectorContract.contractDigestSha256",
      ),
      matched: Boolean(contract.matched),
      ambiguous: Boolean(contract.ambiguous),
      requiredTargetCount: nonNegativeInteger(
        contract.requiredTargetCount,
        "selectorContract.requiredTargetCount",
      ),
      matchedRequiredTargetCount: nonNegativeInteger(
        contract.matchedRequiredTargetCount,
        "selectorContract.matchedRequiredTargetCount",
      ),
      ...(contract.composerTargetRef
        ? {
            composerTargetRef: boundedOpaqueRef(
              contract.composerTargetRef,
              "selectorContract.composerTargetRef",
              2_000,
            ),
          }
        : {}),
      ...(contract.composerReplaceTargetRef
        ? {
            composerReplaceTargetRef: boundedOpaqueRef(
              contract.composerReplaceTargetRef,
              "selectorContract.composerReplaceTargetRef",
              2_000,
            ),
          }
        : {}),
      ...(contract.sendTargetRef
        ? {
            sendTargetRef: boundedOpaqueRef(
              contract.sendTargetRef,
              "selectorContract.sendTargetRef",
              2_000,
            ),
          }
        : {}),
      ...(contract.stopTargetRef
        ? {
            stopTargetRef: boundedOpaqueRef(
              contract.stopTargetRef,
              "selectorContract.stopTargetRef",
              2_000,
            ),
          }
        : {}),
      ...(contract.retryTargetRef
        ? {
            retryTargetRef: boundedOpaqueRef(
              contract.retryTargetRef,
              "selectorContract.retryTargetRef",
              2_000,
            ),
          }
        : {}),
      ...(contract.messageListTargetRef
        ? {
            messageListTargetRef: boundedOpaqueRef(
              contract.messageListTargetRef,
              "selectorContract.messageListTargetRef",
              2_000,
            ),
          }
        : {}),
      driftReasonRefs: boundedRefs(
        contract.driftReasonRefs,
        "selectorContract.driftReasonRefs",
        50,
      ),
    },
    composerPresent: Boolean(evidence.composerPresent),
    composerEnabled: Boolean(evidence.composerEnabled),
    composerEmpty: Boolean(evidence.composerEmpty),
    ...(evidence.composerValueDigestSha256
      ? {
          composerValueDigestSha256: normalizedSha256(
            evidence.composerValueDigestSha256,
            "ui.composerValueDigestSha256",
          ),
        }
      : {}),
    sendControlVisible: Boolean(evidence.sendControlVisible),
    sendControlEnabled: Boolean(evidence.sendControlEnabled),
    stopControlVisible: Boolean(evidence.stopControlVisible),
    generationMarkerVisible: Boolean(evidence.generationMarkerVisible),
    assistantPlaceholderVisible: Boolean(evidence.assistantPlaceholderVisible),
    retryControlVisible: Boolean(evidence.retryControlVisible),
    explicitErrorVisible: Boolean(evidence.explicitErrorVisible),
    ...(evidence.errorCodeRef
      ? { errorCodeRef: boundedOpaqueRef(evidence.errorCodeRef, "ui.errorCodeRef", 1_000) }
      : {}),
    accountAutomationWarningVisible: Boolean(evidence.accountAutomationWarningVisible),
    loginRequired: Boolean(evidence.loginRequired),
    userTurnCount: nonNegativeInteger(evidence.userTurnCount, "ui.userTurnCount"),
    assistantTurnCount: nonNegativeInteger(
      evidence.assistantTurnCount,
      "ui.assistantTurnCount",
    ),
    ...(evidence.lastUserMessageDigestSha256
      ? {
          lastUserMessageDigestSha256: normalizedSha256(
            evidence.lastUserMessageDigestSha256,
            "ui.lastUserMessageDigestSha256",
          ),
        }
      : {}),
    ...(evidence.lastAssistantMessageDigestSha256
      ? {
          lastAssistantMessageDigestSha256: normalizedSha256(
            evidence.lastAssistantMessageDigestSha256,
            "ui.lastAssistantMessageDigestSha256",
          ),
        }
      : {}),
    lastAssistantMessageLength: nonNegativeInteger(
      evidence.lastAssistantMessageLength,
      "ui.lastAssistantMessageLength",
    ),
    ...(evidence.lastDomMutationAt
      ? {
          lastDomMutationAt: normalizedTimestamp(
            evidence.lastDomMutationAt,
            "ui.lastDomMutationAt",
          ),
        }
      : {}),
    ...(evidence.domMutationSequence === undefined
      ? {}
      : {
          domMutationSequence: nonNegativeInteger(
            evidence.domMutationSequence,
            "ui.domMutationSequence",
          ),
        }),
  };
}

function validateNetworkEvidence(
  evidence: WebChatNetworkEvidence,
): WebChatNetworkEvidence {
  const timestamp = (value: string | undefined, field: string) => value
    ? { [field]: normalizedTimestamp(value, `network.${field}`) }
    : {};
  const validated = {
    observedAt: normalizedTimestamp(evidence.observedAt, "network.observedAt"),
    observationAvailable: Boolean(evidence.observationAvailable),
    serviceWorkerMayHideEvents: Boolean(evidence.serviceWorkerMayHideEvents),
    browserOnline: Boolean(evidence.browserOnline),
    generationTransport: evidence.generationTransport,
    generationRequestOpen: Boolean(evidence.generationRequestOpen),
    ...timestamp(evidence.generationRequestStartedAt, "generationRequestStartedAt"),
    ...timestamp(evidence.lastGenerationByteAt, "lastGenerationByteAt"),
    ...timestamp(evidence.lastWebSocketFrameAt, "lastWebSocketFrameAt"),
    ...timestamp(evidence.lastEventSourceMessageAt, "lastEventSourceMessageAt"),
    ...timestamp(evidence.lastRequestFinishedAt, "lastRequestFinishedAt"),
    ...timestamp(evidence.latestRequestFailedAt, "latestRequestFailedAt"),
    ...(evidence.requestFailureCodeRef
      ? {
          requestFailureCodeRef: boundedOpaqueRef(
            evidence.requestFailureCodeRef,
            "network.requestFailureCodeRef",
            1_000,
          ),
        }
      : {}),
  } as WebChatNetworkEvidence;
  for (const [field, value] of [
    ["generationRequestStartedAt", validated.generationRequestStartedAt],
    ["lastGenerationByteAt", validated.lastGenerationByteAt],
    ["lastWebSocketFrameAt", validated.lastWebSocketFrameAt],
    ["lastEventSourceMessageAt", validated.lastEventSourceMessageAt],
    ["lastRequestFinishedAt", validated.lastRequestFinishedAt],
    ["latestRequestFailedAt", validated.latestRequestFailedAt],
  ] as const) {
    if (value && Date.parse(value) > Date.parse(validated.observedAt)) {
      throw new WebChatSupervisorPolicyError(
        "network_event_after_observation",
        `network.${field} cannot occur after network.observedAt.`,
      );
    }
  }
  return validated;
}

function validateWakePermit(permit: WebChatWakePermit): WebChatWakePermit {
  if (permit.schemaVersion !== 1) {
    throw new WebChatSupervisorPolicyError(
      "unsupported_wake_permit_schema",
      `Unsupported wake permit schema: ${String(permit.schemaVersion)}.`,
    );
  }
  const validated: WebChatWakePermit = {
    schemaVersion: 1,
    permitRef: boundedOpaqueRef(permit.permitRef, "permitRef", 1_000),
    issuerExecutionScopeRef: boundedPattern(
      permit.issuerExecutionScopeRef,
      "issuerExecutionScopeRef",
      /^[a-f0-9]{16}$/,
    ),
    targetExecutionScopeRef: boundedPattern(
      permit.targetExecutionScopeRef,
      "targetExecutionScopeRef",
      /^[a-f0-9]{16}$/,
    ),
    pendingMessageRef: boundedOpaqueRef(
      permit.pendingMessageRef,
      "pendingMessageRef",
      1_000,
    ),
    pendingWorkReadbackRef: boundedOpaqueRef(
      permit.pendingWorkReadbackRef,
      "pendingWorkReadbackRef",
      2_000,
    ),
    ...(permit.threadRef
      ? { threadRef: boundedOpaqueRef(permit.threadRef, "threadRef", 1_000) }
      : {}),
    ...(permit.taskRef
      ? { taskRef: boundedOpaqueRef(permit.taskRef, "taskRef", 1_000) }
      : {}),
    ...(permit.correlationRef
      ? {
          correlationRef: boundedOpaqueRef(
            permit.correlationRef,
            "correlationRef",
            1_000,
          ),
        }
      : {}),
    bindingRef: boundedOpaqueRef(permit.bindingRef, "bindingRef", 1_000),
    bindingEpoch: positiveInteger(permit.bindingEpoch, "bindingEpoch"),
    conversationUrlDigestSha256: normalizedSha256(
      permit.conversationUrlDigestSha256,
      "conversationUrlDigestSha256",
    ),
    expectedObservationStateDigestSha256: normalizedSha256(
      permit.expectedObservationStateDigestSha256,
      "expectedObservationStateDigestSha256",
    ),
    expectedClassificationDigestSha256: normalizedSha256(
      permit.expectedClassificationDigestSha256,
      "expectedClassificationDigestSha256",
    ),
    wakeLeaseRef: boundedOpaqueRef(permit.wakeLeaseRef, "wakeLeaseRef", 2_000),
    idempotencyKey: boundedText(permit.idempotencyKey, "idempotencyKey", 200),
    attempt: positiveInteger(permit.attempt, "attempt"),
    maxAttempts: positiveInteger(permit.maxAttempts, "maxAttempts"),
    issuedAt: normalizedTimestamp(permit.issuedAt, "issuedAt"),
    expiresAt: normalizedTimestamp(permit.expiresAt, "expiresAt"),
    authorityReadbackRefs: boundedRefs(
      permit.authorityReadbackRefs,
      "authorityReadbackRefs",
      50,
    ),
  };
  if (validated.authorityReadbackRefs.length === 0) {
    throw new WebChatSupervisorPolicyError(
      "wake_authority_readback_required",
      "A wake permit requires external authority-state readback references.",
    );
  }
  if (Date.parse(validated.expiresAt) <= Date.parse(validated.issuedAt)) {
    throw new WebChatSupervisorPolicyError(
      "wake_permit_expiry_invalid",
      "A wake permit must expire after its issuance time.",
    );
  }
  if (
    Date.parse(validated.expiresAt) - Date.parse(validated.issuedAt)
      > MAX_WAKE_PERMIT_TTL_MS
  ) {
    throw new WebChatSupervisorPolicyError(
      "wake_permit_ttl_exceeded",
      "A wake permit validity window cannot exceed five minutes.",
    );
  }
  if (validated.maxAttempts > MAX_WAKE_ATTEMPTS) {
    throw new WebChatSupervisorPolicyError(
      "wake_attempt_ceiling_exceeded",
      `A wake permit series cannot exceed ${String(MAX_WAKE_ATTEMPTS)} attempts.`,
    );
  }
  return validated;
}

function validateEphemeralWakePayload(
  payload: WebChatEphemeralWakePayload,
): WebChatEphemeralWakePayload {
  if (payload.schemaVersion !== 1 || payload.persistence !== "ephemeral_only") {
    throw new WebChatSupervisorPolicyError(
      "unsupported_wake_payload_schema",
      "The wake payload must use the ephemeral-only schema.",
    );
  }
  const validated: WebChatEphemeralWakePayload = {
    schemaVersion: 1,
    persistence: "ephemeral_only",
    payloadRef: boundedOpaqueRef(payload.payloadRef, "payloadRef", 1_000),
    permitRef: boundedOpaqueRef(payload.permitRef, "permitRef", 1_000),
    bindingRef: boundedOpaqueRef(payload.bindingRef, "bindingRef", 1_000),
    bindingEpoch: positiveInteger(payload.bindingEpoch, "bindingEpoch"),
    text: boundedText(payload.text, "wakePayload.text", 4_000),
    textDigestSha256: normalizedSha256(
      payload.textDigestSha256,
      "wakePayload.textDigestSha256",
    ),
    issuedAt: normalizedTimestamp(payload.issuedAt, "wakePayload.issuedAt"),
    expiresAt: normalizedTimestamp(payload.expiresAt, "wakePayload.expiresAt"),
  };
  if (Date.parse(validated.expiresAt) <= Date.parse(validated.issuedAt)) {
    throw new WebChatSupervisorPolicyError(
      "wake_payload_expiry_invalid",
      "The ephemeral wake payload must expire after issuance.",
    );
  }
  return validated;
}

function validatedClassifierPolicy(
  options: Partial<WebChatClassifierPolicy>,
): WebChatClassifierPolicy {
  const policy = { ...DEFAULT_POLICY, ...options };
  for (const [field, value] of Object.entries(policy)) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new WebChatSupervisorPolicyError(
        "invalid_classifier_policy",
        `${field} must be a positive finite number.`,
      );
    }
  }
  return policy;
}

function assertInteractionObservationMatchesBinding(
  observation: InteractionObservation,
  binding: WebChatSessionUiBinding,
): void {
  const expected = binding.interactionBinding;
  const actual = observation.binding;
  if (
    expected.adapterId !== actual.adapterId
    || expected.surface !== actual.surface
    || expected.backendSessionRef !== actual.backendSessionRef
    || expected.contextRef !== actual.contextRef
    || expected.targetKind !== actual.targetKind
  ) {
    throw new WebChatSupervisorPolicyError(
      "interaction_observation_binding_mismatch",
      "The interaction observation does not belong to the exact WebChat UI binding.",
    );
  }
}

function assertPreparedActionMatchesBinding(
  action: InteractionPreparedAction,
  binding: WebChatSessionUiBinding,
): void {
  if (!interactionBindingEquals(action.binding, binding.interactionBinding)) {
    throw new WebChatSupervisorPolicyError(
      "prepared_action_binding_mismatch",
      "The prepared interaction action does not belong to the exact WebChat binding.",
    );
  }
}

function interactionBindingEquals(
  left: InteractionBinding,
  right: InteractionBinding,
): boolean {
  return left.adapterId === right.adapterId
    && left.surface === right.surface
    && left.backendSessionRef === right.backendSessionRef
    && left.contextRef === right.contextRef
    && left.targetKind === right.targetKind;
}

function validatedInteractionBinding(binding: InteractionBinding): InteractionBinding {
  if (binding.surface !== "playwright" || binding.targetKind !== "browser") {
    throw new WebChatSupervisorPolicyError(
      "webchat_requires_playwright_browser_binding",
      "The WebChat supervisor requires an existing Playwright browser binding.",
    );
  }
  return {
    adapterId: boundedText(binding.adapterId, "interactionBinding.adapterId", 200),
    surface: "playwright",
    backendSessionRef: boundedOpaqueRef(
      binding.backendSessionRef,
      "interactionBinding.backendSessionRef",
      1_000,
    ),
    contextRef: boundedOpaqueRef(
      binding.contextRef,
      "interactionBinding.contextRef",
      1_000,
    ),
    targetKind: "browser",
  };
}

function timestampAfter(value: string | undefined, boundary: string): boolean {
  return Boolean(value) && Date.parse(value ?? "") >= Date.parse(boundary);
}

function normalizedTimestamp(value: string, field: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) {
    throw new WebChatSupervisorPolicyError(
      "invalid_timestamp",
      `${field} must be an ISO-8601 timestamp.`,
    );
  }
  return new Date(time).toISOString();
}

function normalizedSha256(value: string, field: string): string {
  const normalized = value.toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new WebChatSupervisorPolicyError(
      "invalid_sha256",
      `${field} must be a lowercase SHA-256 digest.`,
    );
  }
  return normalized;
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new WebChatSupervisorPolicyError(
      "invalid_positive_integer",
      `${field} must be a positive safe integer.`,
    );
  }
  return value;
}

function nonNegativeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new WebChatSupervisorPolicyError(
      "invalid_non_negative_integer",
      `${field} must be a non-negative safe integer.`,
    );
  }
  return value;
}

function nonNegativeFinite(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new WebChatSupervisorPolicyError(
      "invalid_non_negative_number",
      `${field} must be a non-negative finite number.`,
    );
  }
  return value;
}

function boundedPattern(
  value: string,
  field: string,
  pattern: RegExp,
): string {
  const text = boundedText(value, field, 2_000);
  if (!pattern.test(text)) {
    throw new WebChatSupervisorPolicyError(
      "invalid_pattern",
      `${field} has an invalid format.`,
    );
  }
  return text;
}

function boundedText(value: string, field: string, maxLength: number): string {
  if (typeof value !== "string") {
    throw new WebChatSupervisorPolicyError("invalid_text", `${field} must be text.`);
  }
  const text = value.trim();
  if (text.length === 0 || text.length > maxLength || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) {
    throw new WebChatSupervisorPolicyError(
      "invalid_text",
      `${field} must be non-empty bounded text without control characters.`,
    );
  }
  return text;
}

function boundedOpaqueRef(value: string, field: string, maxLength: number): string {
  const ref = boundedText(value, field, maxLength);
  if (
    /\s/.test(ref)
    ||
    /(?:^|[?&#;\s])(token|access_token|refresh_token|api[_-]?key|authorization|password|passwd|cookie|session|signature|sig|code)=/i.test(ref)
    || /\bbearer\s+[a-z0-9._~+\/-]+=*/i.test(ref)
    || /https?:\/\/[^\s/@:]+:[^\s/@]+@/i.test(ref)
    || /\beyJ[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}/.test(ref)
  ) {
    throw new WebChatSupervisorPolicyError(
      "credential_bearing_reference_rejected",
      `${field} must be an opaque whitespace-free reference without credential-bearing material.`,
    );
  }
  return ref;
}

function boundedRefs(values: string[], field: string, maxItems: number): string[] {
  if (!Array.isArray(values) || values.length > maxItems) {
    throw new WebChatSupervisorPolicyError(
      "invalid_reference_list",
      `${field} must contain at most ${String(maxItems)} references.`,
    );
  }
  return values.map((value, index) =>
    boundedOpaqueRef(value, `${field}[${String(index)}]`, 2_000));
}

function boundedCodes(values: string[], field: string, maxItems: number): string[] {
  if (!Array.isArray(values) || values.length === 0 || values.length > maxItems) {
    throw new WebChatSupervisorPolicyError(
      "invalid_code_list",
      `${field} must contain between one and ${String(maxItems)} bounded codes.`,
    );
  }
  return values.map((value, index) => {
    const code = boundedText(value, `${field}[${String(index)}]`, 500);
    if (!/^[a-z0-9][a-z0-9_:.-]*$/.test(code)) {
      throw new WebChatSupervisorPolicyError(
        "invalid_code",
        `${field}[${String(index)}] must be a normalized machine-readable code.`,
      );
    }
    return code;
  });
}

function digest(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function stableJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}
