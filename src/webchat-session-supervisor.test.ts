import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type {
  InteractionObservation,
  InteractionPreparedAction,
} from "./interaction-harness.js";
import {
  WEBCHAT_SUPERVISOR_AUTHORITY,
  WebChatSupervisorPolicyError,
  assessWebChatWakeVerification,
  authorizeWebChatWakePermit,
  buildWebChatWakeDraft,
  buildWebChatWakeEnvelope,
  buildWebChatWakeSubmitRequest,
  classifyWebChatSession,
  createWebChatEphemeralWakePayload,
  createWebChatWakeApprovalVerifier,
  resolveWebChatEphemeralWakePayload,
  validateWebChatSessionClassification,
  validateWebChatSessionUiBinding,
  validateWebChatWakeDraft,
  validateWebChatWakeSubmitDraft,
  webChatWakeInteractionIntent,
  type WebChatBrowserEvidence,
  type WebChatExecutorEvidence,
  type WebChatNetworkEvidence,
  type WebChatObservationSample,
  type WebChatSessionClassification,
  type WebChatSessionUiBinding,
  type WebChatUiEvidence,
  type WebChatWakePermit,
  type WebChatWakePermitVerifier,
  type WebChatWakeSubmitDraft,
} from "./webchat-session-supervisor.js";

const BASE_MS = Date.parse("2026-08-18T06:30:00.000Z");

function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function iso(offsetMs = 0): string {
  return new Date(BASE_MS + offsetMs).toISOString();
}

const permitVerifier: WebChatWakePermitVerifier = ({ permit }) => ({
  verified: true,
  verificationRef: `wake-permit-verification://${sha(permit.permitRef)}`,
  authorityReadbackRef:
    `wake-permit-authority-readback://${sha(permit.pendingWorkReadbackRef)}`,
});

function binding(
  overrides: Partial<WebChatSessionUiBinding> = {},
): WebChatSessionUiBinding {
  const browserContextRef = "browser-context://profile/main";
  const pageRef = "page://chatgpt/conversation-1";
  return {
    schemaVersion: 1,
    bindingRef: "binding://webchat/scope-1/epoch-1",
    bindingEpoch: 1,
    executionScopeRef: "1111111111111111",
    missionRef: "wake-supervision-test",
    provider: "chatgpt_web",
    interactionBinding: {
      adapterId: "zes-playwright-extension",
      surface: "playwright",
      backendSessionRef: browserContextRef,
      contextRef: pageRef,
      targetKind: "browser",
    },
    browserContextRef,
    targetRef: "target://chromium/tab-1",
    pageRef,
    conversationLocatorRef: "secret-ref://webchat/conversation/1",
    conversationUrlDigestSha256: sha("https://chatgpt.com/c/conversation-1"),
    conversationRefDigestSha256: sha("conversation-1"),
    accountRefDigestSha256: sha("account-main"),
    projectRefDigestSha256: sha("project-zes"),
    selectorContractRef: "selector-contract://chatgpt-web/v1",
    selectorContractDigestSha256: sha("chatgpt-web-contract-v1"),
    proofRefs: ["binding-proof://scope-tab-handshake/1"],
    establishedAt: iso(-60_000),
    verifiedAt: iso(-1_000),
    authority: WEBCHAT_SUPERVISOR_AUTHORITY,
    ...overrides,
  };
}

interface SampleOverrides {
  bindingRef?: string;
  bindingEpoch?: number;
  stateDigestSha256?: string;
  executor?: Partial<WebChatExecutorEvidence>;
  browser?: Partial<WebChatBrowserEvidence>;
  ui?: Omit<Partial<WebChatUiEvidence>, "selectorContract"> & {
    selectorContract?: Partial<WebChatUiEvidence["selectorContract"]>;
  };
  network?: Partial<WebChatNetworkEvidence>;
  evidenceRefs?: string[];
}

function sample(
  bound: WebChatSessionUiBinding,
  offsetMs: number,
  overrides: SampleOverrides = {},
): WebChatObservationSample {
  const sampledAt = iso(offsetMs);
  const selectorContract: WebChatUiEvidence["selectorContract"] = {
    contractRef: bound.selectorContractRef,
    contractDigestSha256: bound.selectorContractDigestSha256,
    matched: true,
    ambiguous: false,
    requiredTargetCount: 3,
    matchedRequiredTargetCount: 3,
    composerTargetRef: "semantic://chatgpt/composer",
    composerReplaceTargetRef: "semantic://chatgpt/composer-replace",
    sendTargetRef: "semantic://chatgpt/send",
    stopTargetRef: "semantic://chatgpt/stop",
    retryTargetRef: "semantic://chatgpt/retry",
    messageListTargetRef: "semantic://chatgpt/messages",
    driftReasonRefs: [],
    ...overrides.ui?.selectorContract,
  };
  const executor: WebChatExecutorEvidence = {
    observedAt: sampledAt,
    scopeMaterialized: true,
    runningToolCount: 0,
    runningProcessCount: 0,
    lastMcpActivityAt: iso(offsetMs - 90_000),
    observationGapMs: 90_000,
    interactionState: "ready",
    pendingInteractionAction: false,
    ...overrides.executor,
  };
  const browser: WebChatBrowserEvidence = {
    observedAt: sampledAt,
    browserProcessAlive: true,
    browserConnected: true,
    browserContextPresent: true,
    targetPresent: true,
    targetCrashed: false,
    pageClosed: false,
    browserContextRef: bound.browserContextRef,
    targetRef: bound.targetRef,
    pageRef: bound.pageRef,
    bindingEpoch: bound.bindingEpoch,
    targetUrlDigestSha256: bound.conversationUrlDigestSha256,
    lifecycleState: "active",
    documentWasDiscarded: false,
    heartbeatStatus: "responsive",
    heartbeatRoundTripMs: 12,
    lastLifecycleEventAt: iso(offsetMs - 2_000),
    networkOnline: true,
    ...overrides.browser,
  };
  const ui: WebChatUiEvidence = {
    observedAt: sampledAt,
    conversationLoaded: true,
    conversationRefDigestSha256: bound.conversationRefDigestSha256,
    composerPresent: true,
    composerEnabled: true,
    composerEmpty: true,
    sendControlVisible: true,
    sendControlEnabled: false,
    stopControlVisible: false,
    generationMarkerVisible: false,
    assistantPlaceholderVisible: false,
    retryControlVisible: false,
    explicitErrorVisible: false,
    accountAutomationWarningVisible: false,
    loginRequired: false,
    userTurnCount: 3,
    assistantTurnCount: 3,
    lastUserMessageDigestSha256: sha("prior-user-message"),
    lastAssistantMessageDigestSha256: sha("prior-assistant-message"),
    lastAssistantMessageLength: 100,
    domMutationSequence: 10,
    ...overrides.ui,
    selectorContract,
  };
  const network: WebChatNetworkEvidence = {
    observedAt: sampledAt,
    observationAvailable: true,
    serviceWorkerMayHideEvents: false,
    browserOnline: true,
    generationTransport: "none",
    generationRequestOpen: false,
    ...overrides.network,
  };
  return {
    schemaVersion: 1,
    sampledAt,
    bindingRef: overrides.bindingRef ?? bound.bindingRef,
    bindingEpoch: overrides.bindingEpoch ?? bound.bindingEpoch,
    stateDigestSha256: overrides.stateDigestSha256
      ?? sha(`${sampledAt}:${ui.userTurnCount}:${ui.assistantTurnCount}`),
    executor,
    browser,
    ui,
    network,
    evidenceRefs: overrides.evidenceRefs ?? [
      `evidence://webchat/sample/${String(offsetMs)}`,
    ],
    authority: WEBCHAT_SUPERVISOR_AUTHORITY,
  };
}

function classify(
  bound: WebChatSessionUiBinding,
  current: WebChatObservationSample,
  previous: WebChatObservationSample[] = [],
  nowMs = Date.parse(current.sampledAt) + 100,
): WebChatSessionClassification {
  return classifyWebChatSession(bound, { current, previous }, { nowMs });
}

function idleClassification(bound = binding()): {
  classification: WebChatSessionClassification;
  current: WebChatObservationSample;
  previous: WebChatObservationSample;
} {
  const previous = sample(bound, 0);
  const current = sample(bound, 1_000);
  return {
    classification: classify(bound, current, [previous]),
    current,
    previous,
  };
}

function permit(
  bound: WebChatSessionUiBinding,
  classification: WebChatSessionClassification,
  overrides: Partial<WebChatWakePermit> = {},
): WebChatWakePermit {
  return {
    schemaVersion: 1,
    permitRef: "wake-permit://coordination/message-1/attempt-1",
    issuerExecutionScopeRef: "2222222222222222",
    targetExecutionScopeRef: bound.executionScopeRef,
    pendingMessageRef: "execution-message://message-1",
    pendingWorkReadbackRef: "coordination-readback://message-1/pending",
    threadRef: "coordination-thread://thread-1",
    taskRef: "coordination-task://task-1",
    correlationRef: "wake-test-1",
    bindingRef: bound.bindingRef,
    bindingEpoch: bound.bindingEpoch,
    conversationUrlDigestSha256: bound.conversationUrlDigestSha256,
    expectedClassificationDigestSha256:
      classification.classificationDigestSha256,
    wakeLeaseRef: "wake-lease://scope-1/message-1",
    idempotencyKey: "wake-scope-1-message-1-attempt-1",
    attempt: 1,
    maxAttempts: 3,
    issuedAt: iso(1_500),
    expiresAt: iso(60_000),
    authorityReadbackRefs: [
      "authority-readback://coordination/message-1/current",
    ],
    ...overrides,
    expectedObservationStateDigestSha256:
      overrides.expectedObservationStateDigestSha256
      ?? classification.observationStateDigestSha256,
  };
}

function interactionObservation(
  bound: WebChatSessionUiBinding,
  offsetMs = 1_000,
  id = "obs_wake_1",
): InteractionObservation {
  return {
    observationId: id,
    binding: bound.interactionBinding,
    stateDigestSha256: sha(`interaction:${id}`),
    observedAt: iso(offsetMs),
    evidence: [
      {
        kind: "accessibility_snapshot",
        ref: `artifact://webchat/${id}`,
        sha256: sha(`artifact:${id}`),
      },
    ],
  };
}

function preparedComposeAction(
  bound: WebChatSessionUiBinding,
  draft: ReturnType<typeof buildWebChatWakeDraft>,
): InteractionPreparedAction {
  return {
    actionId: "act_wake_compose_1",
    attempt: 1,
    kind: "type",
    effectClass: "reversible",
    target: draft.composeRequest.target,
    observationId: draft.composeRequest.expectedObservationId,
    expectedPreStateDigestSha256:
      draft.composeRequest.expectedPreStateDigestSha256,
    requestDigestSha256: sha("compose-request"),
    idempotencyKeyDigestSha256: sha(draft.composeRequest.idempotencyKey),
    payloadDigestSha256: draft.envelope.textDigestSha256,
    declaredIdempotent: true,
    approvalRef: draft.permitRef,
    approvalActorRef: "2222222222222222",
    approvalVerificationRef: "approval-verification://wake/1",
    approvalAuthorityReadbackRef: "approval-readback://wake/1",
    postconditions: draft.composeRequest.postconditions ?? [],
    timeoutMs: draft.composeRequest.timeoutMs ?? 30_000,
    binding: bound.interactionBinding,
    startedAt: draft.preparedAt,
  };
}

test("binding stores only digests and opaque refs and rejects credential material", () => {
  const validated = validateWebChatSessionUiBinding(binding());
  assert.equal(validated.provider, "chatgpt_web");
  assert.equal(validated.conversationUrlDigestSha256.length, 64);
  assert.equal(validated.authority.rawConversationUrlCaptured, false);

  assert.throws(
    () => validateWebChatSessionUiBinding(binding({
      conversationLocatorRef:
        "https://chatgpt.com/c/1?access_token=super-secret-value",
    })),
    (error: unknown) => error instanceof WebChatSupervisorPolicyError
      && error.code === "credential_bearing_reference_rejected",
  );
});

test("binding requires both the exact browser context and exact page reference", () => {
  const base = binding();
  assert.throws(
    () => validateWebChatSessionUiBinding(binding({
      interactionBinding: {
        ...base.interactionBinding,
        contextRef: "page://chatgpt/another-page",
      },
    })),
    (error: unknown) => error instanceof WebChatSupervisorPolicyError
      && error.code === "interaction_binding_not_linked",
  );
  assert.throws(
    () => validateWebChatSessionUiBinding(binding({
      interactionBinding: {
        ...base.interactionBinding,
        backendSessionRef: "browser-context://profile/another",
      },
    })),
    (error: unknown) => error instanceof WebChatSupervisorPolicyError
      && error.code === "interaction_binding_not_linked",
  );
});

test("opaque WebChat refs reject whitespace and prompt-shaped injection", () => {
  assert.throws(
    () => validateWebChatSessionUiBinding(binding({
      conversationLocatorRef:
        "conversation-ref://one\nmessage_ref:execution-message://other",
    })),
    (error: unknown) => error instanceof WebChatSupervisorPolicyError
      && error.code === "credential_bearing_reference_rejected",
  );
});

test("MCP silence alone cannot classify idle, reasoning, or hang", () => {
  const bound = binding();
  const current = sample(bound, 1_000, {
    executor: { observationGapMs: 60 * 60_000 },
  });
  const result = classify(bound, current);
  assert.equal(result.state, "unknown");
  assert.equal(result.wakeDisposition, "hold");
  assert.equal(result.policy.mcpSilenceIsAdvisoryOnly, true);
  assert.equal(result.authority.hiddenModelStateObservable, false);
});

test("classification digest validation rejects post-classification mutation", () => {
  const bound = binding();
  const { classification } = idleClassification(bound);
  assert.throws(
    () => validateWebChatSessionClassification({
      ...classification,
      reasonCodes: [...classification.reasonCodes, "forged_reason"],
    }),
    (error: unknown) => error instanceof WebChatSupervisorPolicyError
      && error.code === "classification_digest_mismatch",
  );
});

test("executor activity wins over an apparently idle browser", () => {
  const bound = binding();
  const current = sample(bound, 1_000, {
    executor: { runningToolCount: 1 },
  });
  const result = classify(bound, current, [sample(bound, 0)]);
  assert.equal(result.state, "executor_active");
  assert.equal(result.confidence, "proven");
  assert.equal(result.wakeDisposition, "hold");
});

test("assistant growth with generation UI is classified as streaming", () => {
  const bound = binding();
  const previous = sample(bound, 0, {
    ui: {
      generationMarkerVisible: true,
      stopControlVisible: true,
      lastAssistantMessageLength: 100,
      lastAssistantMessageDigestSha256: sha("stream-1"),
    },
  });
  const current = sample(bound, 1_000, {
    ui: {
      generationMarkerVisible: true,
      stopControlVisible: true,
      lastAssistantMessageLength: 130,
      lastAssistantMessageDigestSha256: sha("stream-2"),
      domMutationSequence: 11,
    },
  });
  const result = classify(bound, current, [previous]);
  assert.equal(result.state, "ui_streaming");
  assert.equal(result.wakeDisposition, "hold");
});

test("an open generation request with quiet UI remains provider pending", () => {
  const bound = binding();
  const previous = sample(bound, 0, {
    ui: { generationMarkerVisible: true },
    network: {
      generationTransport: "http_stream",
      generationRequestOpen: true,
      generationRequestStartedAt: iso(-5_000),
    },
  });
  const current = sample(bound, 1_000, {
    ui: { generationMarkerVisible: true },
    network: {
      generationTransport: "http_stream",
      generationRequestOpen: true,
      generationRequestStartedAt: iso(-5_000),
    },
  });
  const result = classify(bound, current, [previous]);
  assert.equal(result.state, "provider_pending");
  assert.equal(result.nextAction, "continue_observing");
});

test("a repeated responsive generation shell without request or progress is only a suspected stall", () => {
  const bound = binding();
  const first = sample(bound, 0, {
    ui: { generationMarkerVisible: true },
  });
  const second = sample(bound, 150_000, {
    ui: { generationMarkerVisible: true },
  });
  const current = sample(bound, 300_000, {
    ui: { generationMarkerVisible: true },
  });
  const result = classify(bound, current, [second, first]);
  assert.equal(result.state, "generation_stalled_suspected");
  assert.equal(result.wakeDisposition, "hold");
  assert.match(result.reasonCodes.join(" "), /advisory/);
});

test("service-worker-obscured network evidence cannot establish a suspected stall", () => {
  const bound = binding();
  const generation = (offsetMs: number) => sample(bound, offsetMs, {
    ui: { generationMarkerVisible: true },
    network: {
      observationAvailable: true,
      serviceWorkerMayHideEvents: true,
    },
  });
  const result = classify(
    bound,
    generation(300_000),
    [generation(150_000), generation(0)],
  );
  assert.equal(result.state, "provider_pending");
  assert.equal(result.wakeDisposition, "hold");
});

test("simultaneous terminal-error and generation signals remain unknown", () => {
  const bound = binding();
  const result = classify(bound, sample(bound, 1_000, {
    ui: {
      explicitErrorVisible: true,
      generationMarkerVisible: true,
    },
  }));
  assert.equal(result.state, "unknown");
  assert.match(result.reasonCodes.join(" "), /conflicting_generation/);
});

test("responsive idle requires two coherent samples and then becomes tier-1 eligible", () => {
  const bound = binding();
  const first = classify(bound, sample(bound, 1_000));
  assert.equal(first.state, "unknown");

  const previous = sample(bound, 0);
  const current = sample(bound, 1_000);
  const result = classify(bound, current, [previous]);
  assert.equal(result.state, "responsive_idle");
  assert.equal(result.wakeDisposition, "eligible_tier1_continuation");
  assert.equal(result.nextAction, "tier1_wake_permit_may_be_consumed");
});

test("an idle sample from a different binding epoch cannot confirm the current page", () => {
  const bound = binding();
  const previous = sample(bound, 0, {
    bindingEpoch: 2,
    browser: { bindingEpoch: 2 },
  });
  const result = classify(bound, sample(bound, 1_000), [previous]);
  assert.equal(result.state, "unknown");
  assert.match(result.reasonCodes.join(" "), /second_coherent_sample/);
});

test("selector drift and ambiguous contracts fail closed", () => {
  const bound = binding();
  const previous = sample(bound, 0);
  const current = sample(bound, 1_000, {
    ui: {
      selectorContract: {
        matched: false,
        ambiguous: true,
        matchedRequiredTargetCount: 1,
        driftReasonRefs: ["drift://composer-multiple-matches"],
      },
    },
  });
  const result = classify(bound, current, [previous]);
  assert.equal(result.state, "unknown");
  assert.equal(result.nextAction, "rebind_required");
  assert.match(result.reasonCodes.join(" "), /selector_contract/);
});

test("browser lifecycle and transport failures are classified independently from provider state", () => {
  const bound = binding();
  assert.equal(
    classify(bound, sample(bound, 1_000, {
      browser: { lifecycleState: "frozen" },
    })).state,
    "page_frozen",
  );
  assert.equal(
    classify(bound, sample(bound, 1_000, {
      browser: {
        lifecycleState: "restored_after_discard",
        documentWasDiscarded: true,
      },
    })).state,
    "page_discarded",
  );
  assert.equal(
    classify(bound, sample(bound, 1_000, {
      browser: { browserConnected: false },
    })).state,
    "browser_or_network_failed",
  );
  assert.equal(
    classify(bound, sample(bound, 1_000, {
      browser: { heartbeatStatus: "timeout" },
    })).state,
    "ui_unresponsive",
  );
});

test("explicit errors are tier-2 review while account warnings require manual intervention", () => {
  const bound = binding();
  const error = classify(bound, sample(bound, 1_000, {
    ui: {
      explicitErrorVisible: true,
      retryControlVisible: true,
      errorCodeRef: "ui-error://generation-failed",
    },
  }));
  assert.equal(error.state, "terminal_error");
  assert.equal(error.wakeDisposition, "eligible_tier2_recovery_review");

  const warning = classify(bound, sample(bound, 1_000, {
    ui: { accountAutomationWarningVisible: true },
  }));
  assert.equal(warning.state, "terminal_error");
  assert.equal(warning.wakeDisposition, "hold");
  assert.equal(warning.nextAction, "manual_account_intervention_required");
});

test("binding mismatch, stale samples, and incoherent planes fail closed", () => {
  const bound = binding();
  const mismatched = classify(bound, sample(bound, 1_000, {
    browser: { targetRef: "target://chromium/another-tab" },
  }));
  assert.equal(mismatched.state, "unknown");
  assert.equal(mismatched.nextAction, "rebind_required");

  const stale = classifyWebChatSession(
    bound,
    { current: sample(bound, 0), previous: [] },
    { nowMs: BASE_MS + 60_000 },
  );
  assert.equal(stale.state, "unknown");
  assert.match(stale.reasonCodes.join(" "), /stale/);

  const skewed = classify(bound, sample(bound, 1_000, {
    network: { observedAt: iso(20_000) },
  }));
  assert.equal(skewed.state, "unknown");
  assert.match(skewed.reasonCodes.join(" "), /planes_not_coherent/);
});

test("classification requires current conversation URL and conversation identity digests", () => {
  const bound = binding();
  const missingUrl = classify(bound, sample(bound, 1_000, {
    browser: { targetUrlDigestSha256: undefined },
  }));
  assert.equal(missingUrl.state, "unknown");
  assert.match(missingUrl.reasonCodes.join(" "), /url_digest_missing/);

  const missingConversation = classify(bound, sample(bound, 1_000, {
    ui: { conversationRefDigestSha256: undefined },
  }));
  assert.equal(missingConversation.state, "unknown");
  assert.match(missingConversation.reasonCodes.join(" "), /ref_digest_missing/);
});

test("an exact current wake permit authorizes only responsive idle", () => {
  const bound = binding();
  const { classification } = idleClassification(bound);
  const currentPermit = permit(bound, classification);
  const authorized = authorizeWebChatWakePermit({
    binding: bound,
    classification,
    permit: currentPermit,
    permitVerifier,
    nowMs: BASE_MS + 2_000,
  });
  assert.equal(authorized.allowed, true);
  assert.equal(authorized.tier, 1);

  const mismatch = authorizeWebChatWakePermit({
    binding: bound,
    classification,
    permit: permit(bound, classification, { bindingEpoch: 2 }),
    permitVerifier,
    nowMs: BASE_MS + 2_000,
  });
  assert.equal(mismatch.allowed, false);
  assert.match(mismatch.reasonCodes.join(" "), /binding_mismatch/);
});

test("caller-supplied permit refs cannot authorize a wake without an external verifier", () => {
  const bound = binding();
  const { classification } = idleClassification(bound);
  const currentPermit = permit(bound, classification);
  const missingVerifier = authorizeWebChatWakePermit({
    binding: bound,
    classification,
    permit: currentPermit,
    nowMs: BASE_MS + 2_000,
  });
  assert.equal(missingVerifier.allowed, false);
  assert.match(missingVerifier.reasonCodes.join(" "), /external_wake_permit_verifier/);

  const denied = authorizeWebChatWakePermit({
    binding: bound,
    classification,
    permit: currentPermit,
    permitVerifier: () => ({ verified: false }),
    nowMs: BASE_MS + 2_000,
  });
  assert.equal(denied.allowed, false);
  assert.match(denied.reasonCodes.join(" "), /not_externally_verified/);

  const invalidVerifierRef = authorizeWebChatWakePermit({
    binding: bound,
    classification,
    permit: currentPermit,
    permitVerifier: () => ({
      verified: true,
      verificationRef: "verification://ok?access_token=secret",
      authorityReadbackRef: "authority-readback://ok",
    }),
    nowMs: BASE_MS + 2_000,
  });
  assert.equal(invalidVerifierRef.allowed, false);
  assert.match(
    invalidVerifierRef.reasonCodes.join(" "),
    /verification_reference_invalid/,
  );
});

test("wake permits are bound to the exact classified observation state", () => {
  const bound = binding();
  const { classification } = idleClassification(bound);
  const authorization = authorizeWebChatWakePermit({
    binding: bound,
    classification,
    permit: permit(bound, classification, {
      expectedObservationStateDigestSha256: sha("another-observation"),
    }),
    permitVerifier,
    nowMs: BASE_MS + 2_000,
  });
  assert.equal(authorization.allowed, false);
  assert.match(authorization.reasonCodes.join(" "), /classification_mismatch/);
});

test("wake permits must be issued after a fresh classification", () => {
  const bound = binding();
  const { classification } = idleClassification(bound);
  const authorization = authorizeWebChatWakePermit({
    binding: bound,
    classification,
    permit: permit(bound, classification, { issuedAt: iso(500) }),
    permitVerifier,
    nowMs: BASE_MS + 2_000,
  });
  assert.equal(authorization.allowed, false);
  assert.match(authorization.reasonCodes.join(" "), /classification_time_invalid/);
});

test("wake permits reject impossible expiry windows", () => {
  const bound = binding();
  const { classification } = idleClassification(bound);
  assert.throws(
    () => buildWebChatWakeEnvelope(permit(bound, classification, {
      issuedAt: iso(10_000),
      expiresAt: iso(5_000),
    })),
    (error: unknown) => error instanceof WebChatSupervisorPolicyError
      && error.code === "wake_permit_expiry_invalid",
  );
  assert.throws(
    () => buildWebChatWakeEnvelope(permit(bound, classification, {
      issuedAt: iso(1_500),
      expiresAt: iso(1_500 + 5 * 60_000 + 1),
    })),
    (error: unknown) => error instanceof WebChatSupervisorPolicyError
      && error.code === "wake_permit_ttl_exceeded",
  );
  assert.throws(
    () => buildWebChatWakeEnvelope(permit(bound, classification, {
      maxAttempts: 6,
    })),
    (error: unknown) => error instanceof WebChatSupervisorPolicyError
      && error.code === "wake_attempt_ceiling_exceeded",
  );
});

test("future network events are rejected instead of being counted as progress", () => {
  const bound = binding();
  assert.throws(
    () => classify(bound, sample(bound, 1_000, {
      ui: { generationMarkerVisible: true },
      network: { lastGenerationByteAt: iso(2_000) },
    })),
    (error: unknown) => error instanceof WebChatSupervisorPolicyError
      && error.code === "network_event_after_observation",
  );
});

test("terminal error permit cannot directly authorize a UI wake effect", () => {
  const bound = binding();
  const classification = classify(bound, sample(bound, 1_000, {
    ui: { explicitErrorVisible: true, retryControlVisible: true },
  }));
  const authorization = authorizeWebChatWakePermit({
    binding: bound,
    classification,
    permit: permit(bound, classification),
    permitVerifier,
    nowMs: BASE_MS + 2_000,
  });
  assert.equal(authorization.allowed, false);
  assert.equal(authorization.tier, 2);
});

test("wake envelope carries only correlated references and mailbox-first instruction", () => {
  const bound = binding();
  const { classification } = idleClassification(bound);
  const envelope = buildWebChatWakeEnvelope(permit(bound, classification));
  assert.match(envelope.text, /\[ZES A2A WAKE v1\]/);
  assert.match(envelope.text, /execution_scope_message_inbox first/);
  assert.equal(envelope.textDigestSha256.length, 64);
  assert.doesNotMatch(envelope.text, /access_token|cookie|password/i);
});

test("wake draft creates a replace-style reversible compose action bound to the exact observation", () => {
  const bound = binding();
  const { classification, current } = idleClassification(bound);
  const currentPermit = permit(bound, classification);
  const observation = interactionObservation(bound);
  const draft = buildWebChatWakeDraft({
    binding: bound,
    classification,
    permit: currentPermit,
    sample: current,
    interactionObservation: observation,
    permitVerifier,
    nowMs: BASE_MS + 2_000,
  });
  assert.equal(draft.composeRequest.kind, "type");
  assert.equal(draft.composeRequest.effectClass, "reversible");
  assert.equal(draft.composeRequest.declaredIdempotent, true);
  assert.equal(draft.composeRequest.expectedObservationId, observation.observationId);
  assert.equal(draft.composeRequest.approval.actorRef, "2222222222222222");
  assert.equal(
    draft.composeRequest.payloadDigestSha256,
    draft.envelope.textDigestSha256,
  );
});

test("wake drafts and envelopes are revalidated at the next boundary", () => {
  const bound = binding();
  const { classification, current } = idleClassification(bound);
  const currentPermit = permit(bound, classification);
  const draft = buildWebChatWakeDraft({
    binding: bound,
    classification,
    permit: currentPermit,
    sample: current,
    interactionObservation: interactionObservation(bound),
    permitVerifier,
    nowMs: BASE_MS + 2_000,
  });
  assert.equal(
    validateWebChatWakeDraft({ draft, permit: currentPermit, binding: bound })
      .persistence,
    "ephemeral_only",
  );
  assert.throws(
    () => validateWebChatWakeDraft({
      draft: {
        ...draft,
        envelope: {
          ...draft.envelope,
          text: `${draft.envelope.text}\nforged: true`,
        },
      },
      permit: currentPermit,
      binding: bound,
    }),
    (error: unknown) => error instanceof WebChatSupervisorPolicyError
      && error.code === "wake_envelope_digest_mismatch",
  );
  assert.throws(
    () => validateWebChatWakeDraft({
      draft: {
        ...draft,
        classificationDigestSha256: sha("forged-classification"),
      },
      permit: currentPermit,
      binding: bound,
    }),
    (error: unknown) => error instanceof WebChatSupervisorPolicyError
      && error.code === "wake_draft_binding_or_classification_mismatch",
  );
});

test("wake text is delivered through an expiring ephemeral payload bound to the prepared action", () => {
  const bound = binding();
  const { classification, current } = idleClassification(bound);
  const currentPermit = permit(bound, classification);
  const draft = buildWebChatWakeDraft({
    binding: bound,
    classification,
    permit: currentPermit,
    sample: current,
    interactionObservation: interactionObservation(bound),
    permitVerifier,
    nowMs: BASE_MS + 2_000,
  });
  const payload = createWebChatEphemeralWakePayload({
    draft,
    permit: currentPermit,
    binding: bound,
    payloadRef: "ephemeral-payload://wake/message-1",
    nowMs: BASE_MS + 2_000,
    ttlMs: 10_000,
  });
  const action = preparedComposeAction(bound, draft);
  assert.equal(
    resolveWebChatEphemeralWakePayload({
      binding: bound,
      action,
      payload,
      nowMs: BASE_MS + 3_000,
    }),
    draft.envelope.text,
  );
  assert.throws(
    () => resolveWebChatEphemeralWakePayload({
      binding: bound,
      action,
      payload: { ...payload, text: `${payload.text} forged` },
      nowMs: BASE_MS + 3_000,
    }),
    (error: unknown) => error instanceof WebChatSupervisorPolicyError
      && error.code === "wake_payload_digest_mismatch",
  );
  assert.throws(
    () => resolveWebChatEphemeralWakePayload({
      binding: bound,
      action,
      payload,
      nowMs: BASE_MS + 20_000,
    }),
    (error: unknown) => error instanceof WebChatSupervisorPolicyError
      && error.code === "wake_payload_expired_or_not_yet_valid",
  );
});

test("InteractionBroker approval verification remains permit-bound and time-bound", () => {
  const bound = binding();
  const { classification } = idleClassification(bound);
  const currentPermit = permit(bound, classification);
  let nowMs = BASE_MS + 2_000;
  const approvalVerifier = createWebChatWakeApprovalVerifier({
    binding: bound,
    classification,
    permit: currentPermit,
    permitVerifier,
    now: () => nowMs,
  });
  const approved = approvalVerifier({
    identity: {
      sessionRef: "ixs_wake",
      executionScopeRef: currentPermit.issuerExecutionScopeRef,
    },
    binding: bound.interactionBinding,
    actionKind: "type",
    effectClass: "reversible",
    approval: {
      state: "approved",
      ref: currentPermit.permitRef,
      actorRef: currentPermit.issuerExecutionScopeRef,
    },
    payloadDigestSha256: buildWebChatWakeEnvelope(currentPermit).textDigestSha256,
  });
  assert.equal(approved.verified, true);
  assert.match(approved.verificationRef ?? "", /wake-approval-verification/);
  assert.match(approved.authorityReadbackRef ?? "", /wake-permit-authority-readback/);

  const wrongController = approvalVerifier({
    identity: {
      sessionRef: "ixs_wake",
      executionScopeRef: "3333333333333333",
    },
    binding: bound.interactionBinding,
    actionKind: "type",
    effectClass: "reversible",
    approval: {
      state: "approved",
      ref: currentPermit.permitRef,
      actorRef: currentPermit.issuerExecutionScopeRef,
    },
    payloadDigestSha256: buildWebChatWakeEnvelope(currentPermit).textDigestSha256,
  });
  assert.equal(wrongController.verified, false);

  nowMs = BASE_MS + 70_000;
  const expired = approvalVerifier({
    identity: {
      sessionRef: "ixs_wake",
      executionScopeRef: currentPermit.issuerExecutionScopeRef,
    },
    binding: bound.interactionBinding,
    actionKind: "click",
    effectClass: "irreversible",
    approval: {
      state: "approved",
      ref: currentPermit.permitRef,
      actorRef: currentPermit.issuerExecutionScopeRef,
    },
    payloadDigestSha256: buildWebChatWakeEnvelope(currentPermit).textDigestSha256,
  });
  assert.equal(expired.verified, false);
});

test("wake draft refuses to overwrite a non-empty composer", () => {
  const bound = binding();
  const previous = sample(bound, 0, { ui: { composerEmpty: false } });
  const current = sample(bound, 1_000, { ui: { composerEmpty: false } });
  const classification = classify(bound, current, [previous]);
  assert.equal(classification.state, "responsive_idle");
  assert.equal(classification.wakeDisposition, "hold");
  assert.throws(
    () => buildWebChatWakeDraft({
      binding: bound,
      classification,
      permit: permit(bound, classification),
      sample: current,
      interactionObservation: interactionObservation(bound),
      permitVerifier,
      nowMs: BASE_MS + 2_000,
    }),
    (error: unknown) => error instanceof WebChatSupervisorPolicyError
      && error.code === "wake_permit_not_authorized",
  );
});

test("submit action is irreversible and requires the exact staged envelope digest", () => {
  const bound = binding();
  const { classification, current } = idleClassification(bound);
  const currentPermit = permit(bound, classification);
  const draft = buildWebChatWakeDraft({
    binding: bound,
    classification,
    permit: currentPermit,
    sample: current,
    interactionObservation: interactionObservation(bound),
    permitVerifier,
    nowMs: BASE_MS + 2_000,
  });
  const staged = sample(bound, 2_000, {
    ui: {
      composerEmpty: false,
      composerValueDigestSha256: draft.envelope.textDigestSha256,
      sendControlEnabled: true,
    },
  });
  const submit = buildWebChatWakeSubmitRequest({
    binding: bound,
    permit: currentPermit,
    draft,
    sample: staged,
    interactionObservation: interactionObservation(bound, 2_000, "obs_staged"),
    nowMs: BASE_MS + 2_000,
  });
  assert.equal(submit.request.kind, "click");
  assert.equal(submit.request.effectClass, "irreversible");
  assert.equal(submit.request.declaredIdempotent, false);
  assert.equal(submit.request.postconditions?.length, 2);
  assert.deepEqual(
    validateWebChatWakeSubmitDraft({
      submit,
      draft,
      permit: currentPermit,
      binding: bound,
    }),
    submit,
  );

  assert.throws(
    () => validateWebChatWakeSubmitDraft({
      submit: {
        ...submit,
        request: {
          ...submit.request,
          target: { strategy: "semantic", targetRef: "semantic://wrong-send" },
        },
      },
      draft,
      permit: currentPermit,
      binding: bound,
    }),
    (error: unknown) => error instanceof WebChatSupervisorPolicyError
      && error.code === "wake_submit_request_mismatch",
  );

  assert.throws(
    () => validateWebChatWakeSubmitDraft({
      submit: { ...submit, preparedAt: iso(1_000) },
      draft,
      permit: currentPermit,
      binding: bound,
    }),
    (error: unknown) => error instanceof WebChatSupervisorPolicyError
      && error.code === "wake_submit_precedes_compose_draft",
  );

  assert.throws(
    () => buildWebChatWakeSubmitRequest({
      binding: bound,
      permit: currentPermit,
      draft,
      sample: sample(bound, 2_000, {
        ui: {
          composerEmpty: false,
          composerValueDigestSha256: sha("different-text"),
          sendControlEnabled: true,
        },
      }),
      interactionObservation: interactionObservation(bound, 2_000, "obs_bad"),
      nowMs: BASE_MS + 2_000,
    }),
    (error: unknown) => error instanceof WebChatSupervisorPolicyError
      && error.code === "wake_submit_preconditions_not_met",
  );
});

test("wake verification requires both message admission and a new generation boundary", () => {
  const bound = binding();
  const { classification, current } = idleClassification(bound);
  const currentPermit = permit(bound, classification);
  const draft = buildWebChatWakeDraft({
    binding: bound,
    classification,
    permit: currentPermit,
    sample: current,
    interactionObservation: interactionObservation(bound),
    permitVerifier,
    nowMs: BASE_MS + 2_000,
  });
  const staged = sample(bound, 2_000, {
    ui: {
      composerEmpty: false,
      composerValueDigestSha256: draft.envelope.textDigestSha256,
      sendControlEnabled: true,
    },
  });
  const submit = buildWebChatWakeSubmitRequest({
    binding: bound,
    permit: currentPermit,
    draft,
    sample: staged,
    interactionObservation: interactionObservation(bound, 2_000, "obs_verify"),
    nowMs: BASE_MS + 2_000,
  });
  const verified = assessWebChatWakeVerification({
    binding: bound,
    permit: currentPermit,
    draft,
    submit,
    after: sample(bound, 3_000, {
      ui: {
        composerEmpty: true,
        userTurnCount: draft.beforeUserTurnCount + 1,
        lastUserMessageDigestSha256: draft.envelope.textDigestSha256,
        generationMarkerVisible: true,
        assistantPlaceholderVisible: true,
      },
      network: {
        generationTransport: "http_stream",
        generationRequestOpen: true,
        generationRequestStartedAt: iso(2_500),
      },
    }),
  });
  assert.equal(verified.status, "verified");
  assert.equal(verified.interactionVerified, true);

  const admittedOnly = assessWebChatWakeVerification({
    binding: bound,
    permit: currentPermit,
    draft,
    submit,
    after: sample(bound, 3_000, {
      ui: {
        composerEmpty: true,
        userTurnCount: draft.beforeUserTurnCount + 1,
        lastUserMessageDigestSha256: draft.envelope.textDigestSha256,
      },
    }),
  });
  assert.equal(
    admittedOnly.status,
    "message_admitted_generation_not_started",
  );
  assert.equal(admittedOnly.interactionVerified, false);
});

test("generation transport evidence must begin after submit preparation", () => {
  const bound = binding();
  const { classification, current } = idleClassification(bound);
  const currentPermit = permit(bound, classification);
  const draft = buildWebChatWakeDraft({
    binding: bound,
    classification,
    permit: currentPermit,
    sample: current,
    interactionObservation: interactionObservation(bound),
    permitVerifier,
    nowMs: BASE_MS + 2_000,
  });
  const submit = buildWebChatWakeSubmitRequest({
    binding: bound,
    permit: currentPermit,
    draft,
    sample: sample(bound, 3_000, {
      ui: {
        composerEmpty: false,
        composerValueDigestSha256: draft.envelope.textDigestSha256,
        sendControlEnabled: true,
      },
    }),
    interactionObservation: interactionObservation(bound, 3_000, "obs_timing"),
    nowMs: BASE_MS + 3_000,
  });
  const result = assessWebChatWakeVerification({
    binding: bound,
    permit: currentPermit,
    draft,
    submit,
    after: sample(bound, 4_000, {
      ui: {
        userTurnCount: draft.beforeUserTurnCount + 1,
        lastUserMessageDigestSha256: draft.envelope.textDigestSha256,
      },
      network: {
        generationTransport: "http_stream",
        generationRequestOpen: true,
        generationRequestStartedAt: iso(2_500),
      },
    }),
  });
  assert.equal(result.status, "message_admitted_generation_not_started");
});

test("post-submit selector drift and unavailable page readback cannot verify a wake", () => {
  const bound = binding();
  const { classification, current } = idleClassification(bound);
  const currentPermit = permit(bound, classification);
  const draft = buildWebChatWakeDraft({
    binding: bound,
    classification,
    permit: currentPermit,
    sample: current,
    interactionObservation: interactionObservation(bound),
    permitVerifier,
    nowMs: BASE_MS + 2_000,
  });
  const submit = buildWebChatWakeSubmitRequest({
    binding: bound,
    permit: currentPermit,
    draft,
    sample: sample(bound, 3_000, {
      ui: {
        composerEmpty: false,
        composerValueDigestSha256: draft.envelope.textDigestSha256,
        sendControlEnabled: true,
      },
    }),
    interactionObservation: interactionObservation(bound, 3_000, "obs_drift"),
    nowMs: BASE_MS + 3_000,
  });
  const drifted = assessWebChatWakeVerification({
    binding: bound,
    permit: currentPermit,
    draft,
    submit,
    after: sample(bound, 4_000, {
      ui: {
        selectorContract: {
          matched: false,
          matchedRequiredTargetCount: 1,
          driftReasonRefs: ["drift://post-submit-contract"],
        },
      },
    }),
  });
  assert.equal(drifted.status, "binding_mismatch");

  const unreadable = assessWebChatWakeVerification({
    binding: bound,
    permit: currentPermit,
    draft,
    submit,
    after: sample(bound, 4_000, {
      browser: { heartbeatStatus: "timeout" },
    }),
  });
  assert.equal(unreadable.status, "indeterminate");
  assert.match(unreadable.reasonCodes.join(" "), /readback_unavailable/);
});

test("wake verification separates proven no-admission from indeterminate submit outcome", () => {
  const bound = binding();
  const { classification, current } = idleClassification(bound);
  const currentPermit = permit(bound, classification);
  const draft = buildWebChatWakeDraft({
    binding: bound,
    classification,
    permit: currentPermit,
    sample: current,
    interactionObservation: interactionObservation(bound),
    permitVerifier,
    nowMs: BASE_MS + 2_000,
  });
  const staged = sample(bound, 2_000, {
    ui: {
      composerEmpty: false,
      composerValueDigestSha256: draft.envelope.textDigestSha256,
      sendControlEnabled: true,
    },
  });
  const submit = buildWebChatWakeSubmitRequest({
    binding: bound,
    permit: currentPermit,
    draft,
    sample: staged,
    interactionObservation: interactionObservation(bound, 2_000, "obs_outcome"),
    nowMs: BASE_MS + 2_000,
  });
  const notAdmitted = assessWebChatWakeVerification({
    binding: bound,
    permit: currentPermit,
    draft,
    submit,
    after: sample(bound, 3_000, {
      ui: {
        composerEmpty: false,
        composerValueDigestSha256: draft.envelope.textDigestSha256,
        userTurnCount: draft.beforeUserTurnCount,
      },
    }),
  });
  assert.equal(notAdmitted.status, "not_admitted");

  const indeterminate = assessWebChatWakeVerification({
    binding: bound,
    permit: currentPermit,
    draft,
    submit,
    after: sample(bound, 3_000, {
      ui: {
        composerEmpty: true,
        userTurnCount: draft.beforeUserTurnCount,
        lastUserMessageDigestSha256: sha("some-other-message"),
      },
    }),
  });
  assert.equal(indeterminate.status, "indeterminate");
});

test("interaction observation must belong to the exact browser binding", () => {
  const bound = binding();
  const { classification, current } = idleClassification(bound);
  const observation = interactionObservation(bound);
  observation.binding = {
    ...observation.binding,
    contextRef: "page://chatgpt/another-conversation",
  };
  assert.throws(
    () => buildWebChatWakeDraft({
      binding: bound,
      classification,
      permit: permit(bound, classification),
      sample: current,
      interactionObservation: observation,
      permitVerifier,
      nowMs: BASE_MS + 2_000,
    }),
    (error: unknown) => error instanceof WebChatSupervisorPolicyError
      && error.code === "interaction_observation_binding_mismatch",
  );
});

test("wake intent requires semantic visible persistent Playwright without coordinate fallback", () => {
  const intent = webChatWakeInteractionIntent();
  assert.equal(intent.targetKind, "browser");
  assert.equal(intent.effectClass, "irreversible");
  assert.equal(intent.allowCoordinateFallback, false);
  assert.equal(intent.existingSessionRequired, true);
  assert.ok(intent.requiredCapabilities?.includes("semanticTargeting"));
  assert.ok(intent.requiredCapabilities?.includes("boundedTimeout"));
});
