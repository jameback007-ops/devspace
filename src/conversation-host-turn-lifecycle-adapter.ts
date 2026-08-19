import type { ConversationBridgeTargetStatus } from "./conversation-transport-bridge-protocol.js";
import type { ConversationTargetBinding } from "./conversation-target-binding-store.js";
import type { ConversationTransportObservation } from "./conversation-transport-routing.js";
import {
  canonicalJson,
  sha256,
} from "./execution-wake-coordination-model.js";
import {
  type HostTurnLifecycleManager,
  type HostTurnObservationInput,
} from "./host-turn-lifecycle.js";
import type {
  HostTurnEventKind,
  HostTurnState,
  HostTurnWakeGateAssessment,
} from "./host-turn-lifecycle-model.js";

export interface ConversationHostTurnClassification {
  lifecycle: string;
  normalizedLifecycle: string;
  eventKind: HostTurnEventKind;
  state: HostTurnState;
  terminationCauseCode?: string;
}

export interface ConversationHostTurnObservationResult {
  observed: boolean;
  classification?: ConversationHostTurnClassification;
  wakeGate: HostTurnWakeGateAssessment;
  generationBoundaryRef?: string;
  reasonCodes: string[];
}

export function classifyConversationHostTurnLifecycle(
  lifecycle: string,
): ConversationHostTurnClassification | undefined {
  const normalizedLifecycle = lifecycle.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (["idle", "responsiveidle", "awaitinginput", "ready"].includes(normalizedLifecycle)) {
    return {
      lifecycle,
      normalizedLifecycle,
      eventKind: "awaiting_input_observed",
      state: "awaiting_input",
      terminationCauseCode: `transport_explicit_${normalizedLifecycle}`,
    };
  }
  if ([
    "active",
    "running",
    "generating",
    "inprogress",
    "busy",
    "streaming",
    "thinking",
    "started",
  ].includes(normalizedLifecycle)) {
    return {
      lifecycle,
      normalizedLifecycle,
      eventKind: "turn_running",
      state: "running",
    };
  }
  if (["completed", "succeeded", "success", "done", "taskcomplete"].includes(
    normalizedLifecycle,
  )) {
    return {
      lifecycle,
      normalizedLifecycle,
      eventKind: "turn_completed",
      state: "completed",
      terminationCauseCode: `transport_explicit_${normalizedLifecycle}`,
    };
  }
  if (["failed", "error", "systemerror", "terminalerror"].includes(
    normalizedLifecycle,
  )) {
    return {
      lifecycle,
      normalizedLifecycle,
      eventKind: "turn_failed",
      state: "failed",
      terminationCauseCode: `transport_explicit_${normalizedLifecycle}`,
    };
  }
  if (["cancelled", "canceled", "interrupted", "aborted"].includes(
    normalizedLifecycle,
  )) {
    return {
      lifecycle,
      normalizedLifecycle,
      eventKind: "turn_cancelled",
      state: "cancelled",
      terminationCauseCode: `transport_explicit_${normalizedLifecycle}`,
    };
  }
  if ([
    "disconnected",
    "notloaded",
    "pagefrozen",
    "pagediscarded",
    "browserunavailable",
  ].includes(normalizedLifecycle)) {
    return {
      lifecycle,
      normalizedLifecycle,
      eventKind: "transport_disconnected",
      state: "disconnected",
    };
  }
  return undefined;
}

export function conversationHostTurnGenerationBoundary(input: {
  binding: ConversationTargetBinding;
  status: ConversationBridgeTargetStatus;
  selected: ConversationTransportObservation;
}): string {
  return `htb_${sha256(canonicalJson({
    bindingRef: input.binding.bindingRef,
    bindingGeneration: input.binding.bindingGeneration,
    targetKind: input.binding.targetKind,
    targetRefDigestSha256: input.status.targetRefDigestSha256,
    transportId: input.selected.transportId,
    transportKind: input.selected.kind,
    sessionLifecycle: input.selected.sessionLifecycle,
    evidenceDigestSha256: input.status.evidenceDigestSha256,
  })).slice(0, 48)}`;
}

export function observeConversationHostTurn(input: {
  manager: HostTurnLifecycleManager;
  observerExecutionScopeRef: string;
  targetExecutionScopeRef: string;
  missionRef: string;
  binding: ConversationTargetBinding;
  status: ConversationBridgeTargetStatus;
  selected: ConversationTransportObservation;
  routeDigestSha256: string;
  correlationRef?: string;
  pendingWorkRef?: string;
  idempotencyKey: string;
}): ConversationHostTurnObservationResult {
  const classification = classifyConversationHostTurnLifecycle(
    input.selected.sessionLifecycle,
  );
  if (!classification) {
    return {
      observed: false,
      wakeGate: input.manager.wakeGate(
        input.targetExecutionScopeRef,
        input.missionRef,
        input.binding.bindingRef,
        input.binding.bindingGeneration,
      ),
      reasonCodes: [
        `HOST_TURN_LIFECYCLE_UNRECOGNIZED:${normalizeReasonCode(
          input.selected.sessionLifecycle,
        )}`,
      ],
    };
  }
  const generationBoundaryRef = conversationHostTurnGenerationBoundary(input);
  const evidenceRefs = [...new Set([
    ...input.binding.evidenceRefs,
    ...input.status.evidenceRefs,
    ...input.selected.evidenceRefs,
    `route-sha256:${input.routeDigestSha256}`,
    `host-turn-lifecycle:${classification.normalizedLifecycle}`,
  ])].sort();
  const authorityReadbackRefs = [
    `conversation-binding-sha256:${input.binding.evidenceDigestSha256}`,
    `conversation-bridge-authority:${input.status.authority.authority}`,
    `conversation-status-sha256:${input.status.evidenceDigestSha256}`,
    `route-sha256:${input.routeDigestSha256}`,
  ];
  const observation: HostTurnObservationInput = {
    idempotencyKey: input.idempotencyKey,
    observerExecutionScopeRef: input.observerExecutionScopeRef,
    targetExecutionScopeRef: input.targetExecutionScopeRef,
    missionRef: input.missionRef,
    conversationBindingRef: input.binding.bindingRef,
    conversationBindingGeneration: input.binding.bindingGeneration,
    targetKind: input.binding.targetKind,
    targetRefDigestSha256: input.status.targetRefDigestSha256,
    eventKind: classification.eventKind,
    state: classification.state,
    source: "conversation_transport",
    confidence: "verified",
    providerAdapterId: input.selected.transportId,
    providerSessionRef: input.status.bindingRef,
    generationBoundaryRef,
    correlationRef: input.correlationRef,
    pendingWorkRef: input.pendingWorkRef,
    evidenceRefs,
    authorityReadbackRefs,
    effectReadbackRefs: [],
    reasonCodes: [],
    observedAt: input.status.observedAt,
    evidenceExpiresAt: boundedHostTurnEvidenceExpiry(
      input.status.observedAt,
      input.status.expiresAt,
    ),
    terminationCauseCode: classification.terminationCauseCode,
  };
  input.manager.observe(observation);
  return {
    observed: true,
    classification,
    generationBoundaryRef,
    wakeGate: input.manager.wakeGate(
      input.targetExecutionScopeRef,
      input.missionRef,
      input.binding.bindingRef,
      input.binding.bindingGeneration,
    ),
    reasonCodes: [],
  };
}

function normalizeReasonCode(value: string): string {
  const normalized = value.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  return normalized || "EMPTY";
}

function boundedHostTurnEvidenceExpiry(
  observedAt: string,
  upstreamExpiresAt: string,
): string {
  const observedAtMs = Date.parse(observedAt);
  const upstreamExpiresAtMs = Date.parse(upstreamExpiresAt);
  if (!Number.isFinite(observedAtMs) || !Number.isFinite(upstreamExpiresAtMs)) {
    throw new Error("Conversation host-turn evidence timestamps are invalid.");
  }
  return new Date(Math.min(upstreamExpiresAtMs, observedAtMs + 60_000)).toISOString();
}
