import { randomUUID } from "node:crypto";
import type { ConversationTransportConfig } from "./config.js";
import type { ConversationTransportBridgePort } from "./conversation-transport-bridge-client.js";
import {
  conversationRouteDigest,
  deterministicConversationMessageId,
} from "./conversation-transport-bridge-protocol.js";
import type { ConversationTargetBindingStore } from "./conversation-target-binding-store.js";
import {
  routeConversationTransport,
  type ConversationDeliveryState,
  type ConversationTransportRoute,
} from "./conversation-transport-routing.js";
import {
  canonicalJson,
  sha256,
  type ExecutionWakeLowerPlanePort,
  type LowerPlaneWakeReadiness,
  type WakeLowerPlaneDispatchResult,
  type WakePermit,
} from "./execution-wake-coordination-model.js";

export const CONVERSATION_WAKE_LOWER_PLANE_AUTHORITY = {
  authority: "executor_local_conversation_transport_lower_plane",
  canonicalTaskAuthority: false,
  canonicalDecisionAuthority: false,
  writerLeaseAuthority: false,
  publicationAuthority: false,
  hiddenModelStateObserved: false,
  providerGenerationInferredFromSilence: false,
  routeSelectedBeforePermit: true,
  selectedTransportBoundToPermit: true,
  fallbackRequiresPriorDeliveryReconciliation: true,
  unknownFailsClosed: true,
} as const;

export interface ConversationTransportAssessment {
  bindingRef?: string;
  route: ConversationTransportRoute;
  readiness: LowerPlaneWakeReadiness;
}

export class ConversationWakeLowerPlane implements ExecutionWakeLowerPlanePort {
  constructor(
    readonly config: ConversationTransportConfig,
    readonly bindings: ConversationTargetBindingStore,
    readonly bridge: ConversationTransportBridgePort,
  ) {}

  async assessReadiness(input: {
    targetExecutionScopeRef: string;
    missionRef: string;
    pendingWorkId: string;
    pendingWorkGeneration: number;
    pendingWorkSemanticDigestSha256: string;
    correlationRef: string;
    assessmentTimeCeiling?: string;
  }): Promise<LowerPlaneWakeReadiness> {
    return (await this.assess(input)).readiness;
  }

  async assess(input: {
    targetExecutionScopeRef: string;
    missionRef: string;
    pendingWorkId?: string;
    pendingWorkGeneration?: number;
    pendingWorkSemanticDigestSha256?: string;
    correlationRef?: string;
    previousDeliveryState?: ConversationDeliveryState;
    assessmentTimeCeiling?: string;
  }): Promise<ConversationTransportAssessment> {
    const ceilingMs = input.assessmentTimeCeiling === undefined
      ? Date.now()
      : Date.parse(input.assessmentTimeCeiling);
    const nowMs = Number.isFinite(ceilingMs) ? ceilingMs : Date.now();
    const now = new Date(nowMs).toISOString();
    const binding = this.bindings.get(
      input.targetExecutionScopeRef,
      input.missionRef,
    );
    if (!binding) {
      const route: ConversationTransportRoute = {
        state: "blocked",
        code: "no_eligible_transport",
        previousDeliveryState: input.previousDeliveryState ?? "not_attempted",
        considered: [],
      };
      return {
        route,
        readiness: blockedReadiness(input, now, ["CONVERSATION_TARGET_BINDING_MISSING"]),
      };
    }

    let status;
    try {
      status = await this.bridge.status(binding.targetAlias);
    } catch (error) {
      return {
        bindingRef: binding.bindingRef,
        route: {
          state: "blocked",
          code: "no_eligible_transport",
          previousDeliveryState: input.previousDeliveryState ?? "not_attempted",
          considered: [],
        },
        readiness: blockedReadiness(input, now, [
          "CONVERSATION_TRANSPORT_BRIDGE_UNAVAILABLE",
          `bridge-error:${sha256(error instanceof Error ? error.message : String(error))}`,
        ], binding),
      };
    }

    if (status.targetRefDigestSha256 !== binding.bridgeTargetRefDigestSha256
      || status.targetKind !== binding.targetKind) {
      return {
        bindingRef: binding.bindingRef,
        route: {
          state: "blocked",
          code: "no_eligible_transport",
          previousDeliveryState: input.previousDeliveryState ?? "not_attempted",
          considered: [],
        },
        readiness: blockedReadiness(input, now, [
          "BRIDGE_TARGET_BINDING_CHANGED",
        ], binding),
      };
    }

    const route = routeConversationTransport({
      targetKind: binding.targetKind,
      transports: status.candidates,
      previousDeliveryState: input.previousDeliveryState,
    });
    if (route.state !== "selected") {
      return {
        bindingRef: binding.bindingRef,
        route,
        readiness: blockedReadiness(input, now, [
          `ROUTE_${route.code.toUpperCase()}`,
          ...route.considered.flatMap((candidate) =>
            candidate.reasons.map((reason) =>
              `${candidate.observation.transportId}:${reason}`)),
          ...status.limitationCodes,
        ], binding, status),
      };
    }

    const selected = route.selected;
    const routeDigestSha256 = conversationRouteDigest({
      targetAlias: binding.targetAlias,
      targetKind: binding.targetKind,
      targetRefDigestSha256: status.targetRefDigestSha256,
      bindingRef: binding.bindingRef,
      bindingGeneration: binding.bindingGeneration,
      transportId: selected.transportId,
      transportKind: selected.kind,
      evidenceDigestSha256: status.evidenceDigestSha256,
    });
    const evidenceRefs = [...new Set([
      ...binding.evidenceRefs,
      ...status.evidenceRefs,
      ...selected.evidenceRefs,
      `route-sha256:${routeDigestSha256}`,
    ])].sort();
    const evidenceDigestSha256 = sha256(canonicalJson(evidenceRefs));
    return {
      bindingRef: binding.bindingRef,
      route,
      readiness: {
        schemaVersion: 1,
        assessmentRef: `cta_${randomUUID().replaceAll("-", "")}`,
        targetExecutionScopeRef: input.targetExecutionScopeRef,
        missionRef: input.missionRef,
        sessionUiBindingRef: binding.bindingRef,
        bindingGeneration: binding.bindingGeneration,
        targetKind: binding.targetKind,
        transportId: selected.transportId,
        transportKind: selected.kind,
        transportRouteDigestSha256: routeDigestSha256,
        operationalState: `transport_selected:${selected.kind}`,
        exactTargetVerified: selected.binding === "exact",
        selectorContractVerified:
          selected.kind !== "web_ui" || selected.surfaceTrust === "ui_contract",
        accountAutomationWarningAbsent: true,
        wakePermitted: this.config.enabled && this.config.effectsEnabled,
        maximumAutomaticRecoveryTier:
          this.config.enabled && this.config.effectsEnabled
            ? "minimal_continuation"
            : "observe_only",
        observationRef: `bridge:${status.evidenceDigestSha256}`,
        generationBoundaryRefBefore: undefined,
        evidenceDigestSha256,
        evidenceRefs,
        reasonCodes: this.config.effectsEnabled
          ? []
          : ["CONVERSATION_TRANSPORT_EFFECTS_DISABLED"],
        assessedAt: now,
        expiresAt: new Date(
          Math.min(Date.parse(status.expiresAt), nowMs + 60_000),
        ).toISOString(),
        lowerPlaneAuthorityRef: "conversation-transport-lower-plane:v1",
      },
    };
  }

  async consumeWakePermit(
    permit: WakePermit,
  ): Promise<WakeLowerPlaneDispatchResult> {
    const completedAt = new Date().toISOString();
    if (!this.config.enabled || !this.config.effectsEnabled) {
      return failedNoEffect(
        permit,
        completedAt,
        "CONVERSATION_TRANSPORT_EFFECTS_DISABLED",
      );
    }
    if (!permit.transportId
      || !permit.transportKind
      || !permit.transportRouteDigestSha256
      || permit.transportKind === "local_agent") {
      return failedNoEffect(
        permit,
        completedAt,
        "PERMIT_TRANSPORT_BINDING_MISSING_OR_UNSUPPORTED",
      );
    }
    const binding = this.bindings.get(
      permit.targetExecutionScopeRef,
      permit.missionRef,
    );
    if (!binding
      || binding.bindingRef !== permit.sessionUiBindingRef
      || binding.bindingGeneration !== permit.bindingGeneration) {
      return failedNoEffect(permit, completedAt, "PERMIT_BINDING_STALE");
    }
    const promptDigestSha256 = permit.envelope.bodyDigestSha256;
    const messageId = deterministicConversationMessageId({
      permitRef: permit.permitRef,
      targetAlias: binding.targetAlias,
      transportId: permit.transportId,
      promptDigestSha256,
    });
    try {
      const receipt = await this.bridge.deliver({
        schemaVersion: 1,
        command: "deliver",
        targetAlias: binding.targetAlias,
        targetRefDigestSha256: binding.bridgeTargetRefDigestSha256,
        bindingRef: binding.bindingRef,
        bindingGeneration: binding.bindingGeneration,
        permitRef: permit.permitRef,
        transportId: permit.transportId,
        transportKind: permit.transportKind,
        routeDigestSha256: permit.transportRouteDigestSha256,
        messageId,
        prompt: permit.envelope.body,
        promptDigestSha256,
      });
      if (receipt.state === "no_effect") {
        return {
          schemaVersion: 1,
          permitRef: permit.permitRef,
          disposition: "failed_no_effect",
          interactionSessionRef: receipt.deliveryRef,
          noEffectProofRef:
            receipt.noEffectProofRef ?? `no-effect:${receipt.deliveryRef}`,
          verificationRefs: receipt.verificationRefs,
          failureCode: receipt.failureCode,
          completedAt: receipt.recordedAt,
        };
      }
      if (receipt.state !== "delivered" || !receipt.itemRef || !receipt.turnRef) {
        return {
          schemaVersion: 1,
          permitRef: permit.permitRef,
          disposition: "indeterminate",
          interactionSessionRef: receipt.deliveryRef,
          interactionActionId: receipt.deliveryRef,
          interactionReceiptRef: receipt.deliveryRef,
          verificationRefs: receipt.verificationRefs,
          failureCode: receipt.failureCode ?? "DELIVERY_NOT_FULLY_RECONCILED",
          completedAt: receipt.recordedAt,
        };
      }
      return {
        schemaVersion: 1,
        permitRef: permit.permitRef,
        disposition: "verified",
        interactionSessionRef: receipt.deliveryRef,
        interactionActionId: receipt.deliveryRef,
        interactionReceiptRef: receipt.deliveryRef,
        promptAdmissionRef: receipt.itemRef,
        generationBoundaryRefAfter:
          receipt.generationBoundaryRefAfter ?? receipt.turnRef,
        verificationRefs: receipt.verificationRefs,
        completedAt: receipt.recordedAt,
      };
    } catch (error) {
      return {
        schemaVersion: 1,
        permitRef: permit.permitRef,
        disposition: "indeterminate",
        interactionSessionRef: binding.bindingRef,
        verificationRefs: [
          `bridge-error-sha256:${sha256(error instanceof Error ? error.message : String(error))}`,
        ],
        failureCode: "BRIDGE_DELIVERY_OUTCOME_UNKNOWN",
        completedAt,
      };
    }
  }
}

function blockedReadiness(
  input: { targetExecutionScopeRef: string; missionRef: string },
  now: string,
  reasonCodes: string[],
  binding?: {
    bindingRef: string;
    bindingGeneration: number;
    targetKind: "codex_thread" | "chatgpt_chat" | "chatgpt_work" | "generic";
    evidenceRefs: string[];
  },
  status?: { evidenceRefs: string[]; evidenceDigestSha256: string },
): LowerPlaneWakeReadiness {
  const evidenceRefs = [...new Set([
    ...(binding?.evidenceRefs ?? []),
    ...(status?.evidenceRefs ?? []),
    ...reasonCodes.map((reason) => `reason:${reason}`),
  ])].sort();
  return {
    schemaVersion: 1,
    assessmentRef: `cta_${randomUUID().replaceAll("-", "")}`,
    targetExecutionScopeRef: input.targetExecutionScopeRef,
    missionRef: input.missionRef,
    sessionUiBindingRef: binding?.bindingRef ?? "unbound",
    bindingGeneration: binding?.bindingGeneration ?? 1,
    targetKind: binding?.targetKind,
    operationalState: "transport_blocked",
    exactTargetVerified: false,
    selectorContractVerified: false,
    accountAutomationWarningAbsent: false,
    wakePermitted: false,
    maximumAutomaticRecoveryTier: "observe_only",
    observationRef: status
      ? `bridge:${status.evidenceDigestSha256}`
      : "bridge:unavailable",
    evidenceDigestSha256: sha256(canonicalJson(evidenceRefs)),
    evidenceRefs: evidenceRefs.length > 0 ? evidenceRefs : ["transport:unavailable"],
    reasonCodes: [...new Set(reasonCodes)].sort(),
    assessedAt: now,
    expiresAt: new Date(Date.parse(now) + 30_000).toISOString(),
    lowerPlaneAuthorityRef: "conversation-transport-lower-plane:v1",
  };
}

function failedNoEffect(
  permit: WakePermit,
  completedAt: string,
  failureCode: string,
): WakeLowerPlaneDispatchResult {
  return {
    schemaVersion: 1,
    permitRef: permit.permitRef,
    disposition: "failed_no_effect",
    interactionSessionRef: permit.sessionUiBindingRef,
    noEffectProofRef: `no-effect:${sha256(`${permit.permitRef}:${failureCode}`)}`,
    verificationRefs: [`failure:${failureCode}`],
    failureCode,
    completedAt,
  };
}
