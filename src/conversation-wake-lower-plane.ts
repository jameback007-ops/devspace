import { randomUUID } from "node:crypto";
import type { ConversationTransportConfig } from "./config.js";
import {
  classifyConversationHostTurnLifecycle,
  conversationHostTurnGenerationBoundary,
  observeConversationHostTurn,
} from "./conversation-host-turn-lifecycle-adapter.js";
import type { ConversationTransportBridgePort } from "./conversation-transport-bridge-client.js";
import type { ConversationWebUiInteractionBrokerPort } from "./conversation-web-ui-interaction-broker.js";
import {
  conversationRouteDigest,
  deterministicConversationMessageId,
  type ConversationBridgeDeliveryReceipt,
} from "./conversation-transport-bridge-protocol.js";
import type {
  ConversationTargetBinding,
  ConversationTargetBindingStore,
} from "./conversation-target-binding-store.js";
import {
  routeConversationTransport,
  type ConversationDeliveryState,
  type ConversationTransportRoute,
} from "./conversation-transport-routing.js";
import {
  canonicalJson,
  materializeWakeContinuationBody,
  sha256,
  type ExecutionWakeLowerPlanePort,
  type LowerPlaneWakeReadiness,
  type WakeLowerPlaneDispatchResult,
  type WakeLowerPlaneReconciliationInput,
  type WakePermit,
} from "./execution-wake-coordination-model.js";
import type { HostTurnLifecycleManager } from "./host-turn-lifecycle.js";

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
  webUiInteractionBrokerRequired: true,
  nativeRpcBypassesUiBroker: true,
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
    readonly hostTurns: HostTurnLifecycleManager,
    readonly webUiInteractions?: ConversationWebUiInteractionBrokerPort,
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

  async inspect(input: {
    targetExecutionScopeRef: string;
    missionRef: string;
    previousDeliveryState?: ConversationDeliveryState;
    assessmentTimeCeiling?: string;
  }): Promise<ConversationTransportAssessment> {
    return this.assessInternal(input, false);
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
    return this.assessInternal(input, true);
  }

  private async assessInternal(input: {
    targetExecutionScopeRef: string;
    missionRef: string;
    pendingWorkId?: string;
    pendingWorkGeneration?: number;
    pendingWorkSemanticDigestSha256?: string;
    correlationRef?: string;
    previousDeliveryState?: ConversationDeliveryState;
    assessmentTimeCeiling?: string;
  }, persistHostTurnObservation: boolean): Promise<ConversationTransportAssessment> {
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
      conversationUrlDigestSha256: selected.conversationUrlDigestSha256,
      evidenceDigestSha256: status.evidenceDigestSha256,
    });
    const evidenceRefs = [...new Set([
      ...binding.evidenceRefs,
      ...status.evidenceRefs,
      ...selected.evidenceRefs,
      `route-sha256:${routeDigestSha256}`,
    ])].sort();
    let hostTurnObservation;
    if (persistHostTurnObservation) {
      try {
        hostTurnObservation = observeConversationHostTurn({
          manager: this.hostTurns,
          observerExecutionScopeRef: input.targetExecutionScopeRef,
          targetExecutionScopeRef: input.targetExecutionScopeRef,
          missionRef: input.missionRef,
          binding,
          status,
          selected,
          routeDigestSha256,
          correlationRef: input.correlationRef,
          pendingWorkRef: input.pendingWorkId,
          idempotencyKey: `host-turn-assess:${sha256(canonicalJson({
            targetExecutionScopeRef: input.targetExecutionScopeRef,
            missionRef: input.missionRef,
            bindingRef: binding.bindingRef,
            bindingGeneration: binding.bindingGeneration,
            transportId: selected.transportId,
            sessionLifecycle: selected.sessionLifecycle,
            evidenceDigestSha256: status.evidenceDigestSha256,
            observedAt: status.observedAt,
            expiresAt: status.expiresAt,
            routeDigestSha256,
            correlationRef: input.correlationRef,
            pendingWorkRef: input.pendingWorkId,
          }))}`,
        });
      } catch (error) {
        return {
          bindingRef: binding.bindingRef,
          route,
          readiness: blockedReadiness(input, now, [
            "HOST_TURN_OBSERVATION_REJECTED",
            `host-turn-error:${sha256(error instanceof Error ? error.message : String(error))}`,
          ], binding, status),
        };
      }
    } else {
      const classification = classifyConversationHostTurnLifecycle(
        selected.sessionLifecycle,
      );
      const wakeGate = this.hostTurns.wakeGate(
        input.targetExecutionScopeRef,
        input.missionRef,
        binding.bindingRef,
        binding.bindingGeneration,
      );
      const currentBoundary = conversationHostTurnGenerationBoundary({
        binding,
        status,
        selected,
      });
      const exactGate = Boolean(classification
        && wakeGate.wakeAllowed
        && wakeGate.binding
        && wakeGate.binding.state === classification.state
        && wakeGate.binding.generationBoundaryRef === currentBoundary);
      hostTurnObservation = {
        observed: exactGate,
        classification,
        generationBoundaryRef: currentBoundary,
        wakeGate: exactGate
          ? wakeGate
          : {
              ...wakeGate,
              wakeAllowed: false,
              binding: undefined,
              reasonCodes: [...new Set([
                ...wakeGate.reasonCodes,
                classification
                  ? "HOST_TURN_READ_ONLY_OBSERVATION_NOT_DURABLY_BOUND"
                  : "HOST_TURN_LIFECYCLE_UNRECOGNIZED",
              ])].sort(),
            },
        reasonCodes: exactGate
          ? []
          : ["HOST_TURN_READ_ONLY_INSPECTION_ONLY"],
      };
    }
    if (!hostTurnObservation.observed
      || !hostTurnObservation.wakeGate.wakeAllowed
      || !hostTurnObservation.wakeGate.binding) {
      return {
        bindingRef: binding.bindingRef,
        route,
        readiness: blockedReadiness(input, now, [
          ...hostTurnObservation.reasonCodes,
          ...hostTurnObservation.wakeGate.reasonCodes,
          `HOST_TURN_GATE_${hostTurnObservation.wakeGate.decision}`,
        ], binding, status),
      };
    }
    const hostTurnGate = hostTurnObservation.wakeGate.binding;
    const combinedEvidenceRefs = [...new Set([
      ...evidenceRefs,
      ...hostTurnGate.evidenceRefs,
      ...hostTurnGate.authorityReadbackRefs,
      `host-turn-state-sha256:${hostTurnGate.stateDigestSha256}`,
      ...(selected.conversationUrlDigestSha256
        ? [`conversation-url-sha256:${selected.conversationUrlDigestSha256}`]
        : []),
    ])].sort();
    const evidenceDigestSha256 = sha256(canonicalJson(combinedEvidenceRefs));
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
        conversationUrlDigestSha256: selected.conversationUrlDigestSha256,
        operationalState:
          `transport_selected:${selected.kind};host_turn:${hostTurnGate.state}`,
        exactTargetVerified: selected.binding === "exact",
        selectorContractVerified:
          selected.kind !== "web_ui" || selected.surfaceTrust === "ui_contract",
        accountAutomationWarningAbsent: true,
        wakePermitted:
          this.config.enabled
          && this.config.effectsEnabled
          && hostTurnObservation.wakeGate.wakeAllowed,
        maximumAutomaticRecoveryTier:
          this.config.enabled && this.config.effectsEnabled
            ? "minimal_continuation"
            : "observe_only",
        observationRef: `bridge:${status.evidenceDigestSha256}`,
        generationBoundaryRefBefore: hostTurnGate.generationBoundaryRef,
        hostTurnGate,
        evidenceDigestSha256,
        evidenceRefs: combinedEvidenceRefs,
        reasonCodes: this.config.effectsEnabled
          ? []
          : ["CONVERSATION_TRANSPORT_EFFECTS_DISABLED"],
        assessedAt: now,
        expiresAt: new Date(
          Math.min(
            Date.parse(status.expiresAt),
            Date.parse(hostTurnGate.expiresAt),
            nowMs + 60_000,
          ),
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
    const preflightFailure = await this.preflightPermit(permit, binding);
    if (preflightFailure) {
      return failedNoEffect(permit, completedAt, preflightFailure);
    }
    let prompt: string;
    try {
      prompt = materializeWakeContinuationBody(permit.envelope);
    } catch {
      return failedNoEffect(
        permit,
        completedAt,
        "PERMIT_CONTINUATION_ENVELOPE_INVALID",
      );
    }
    const promptDigestSha256 = permit.envelope.bodyDigestSha256;
    const messageId = deterministicConversationMessageId({
      permitRef: permit.permitRef,
      targetAlias: binding.targetAlias,
      transportId: permit.transportId,
      promptDigestSha256,
    });
    try {
      let receipt: ConversationBridgeDeliveryReceipt;
      let interactionSessionRef = binding.bindingRef;
      let interactionActionId: string | undefined;
      let interactionVerificationRefs: string[] = [];
      if (permit.transportKind === "web_ui") {
        if (!this.webUiInteractions) {
          return failedNoEffect(
            permit,
            completedAt,
            "WEB_UI_INTERACTION_BROKER_UNAVAILABLE",
          );
        }
        const interaction = await this.webUiInteractions.deliver({
          permit,
          binding,
          prompt,
          messageId,
        });
        interactionSessionRef = interaction.interactionSessionRef;
        interactionActionId = interaction.interactionActionId;
        interactionVerificationRefs = interaction.verificationRefs;
        if (interaction.state === "no_effect") {
          return {
            schemaVersion: 1,
            permitRef: permit.permitRef,
            disposition: "failed_no_effect",
            interactionSessionRef,
            ...(interactionActionId ? { interactionActionId } : {}),
            ...(interaction.receipt
              ? { interactionReceiptRef: interaction.receipt.deliveryRef }
              : {}),
            noEffectProofRef:
              interaction.receipt?.noEffectProofRef
                ?? `interaction-no-effect:${sha256(canonicalJson({
                  permitRef: permit.permitRef,
                  interactionSessionRef,
                  failureCode: interaction.failureCode,
                }))}`,
            verificationRefs: interactionVerificationRefs,
            failureCode:
              interaction.failureCode ?? "WEB_UI_INTERACTION_NO_EFFECT",
            conversationUrlDigestSha256:
              interaction.receipt?.conversationUrlDigestSha256
                ?? permit.conversationUrlDigestSha256,
            completedAt: interaction.receipt?.recordedAt ?? completedAt,
          };
        }
        if (interaction.state === "indeterminate" || !interaction.receipt) {
          const lifecycleEvidence = this.recordIndeterminateHostTurn(
            permit,
            binding,
            interaction.receipt,
            interaction.failureCode ?? "WEB_UI_INTERACTION_INDETERMINATE",
          );
          return {
            schemaVersion: 1,
            permitRef: permit.permitRef,
            disposition: "indeterminate",
            interactionSessionRef,
            ...(interactionActionId ? { interactionActionId } : {}),
            ...(interaction.receipt
              ? { interactionReceiptRef: interaction.receipt.deliveryRef }
              : {}),
            verificationRefs: [...new Set([
              ...interactionVerificationRefs,
              ...lifecycleEvidence,
            ])].sort(),
            failureCode:
              interaction.failureCode ?? "WEB_UI_INTERACTION_INDETERMINATE",
            conversationUrlDigestSha256:
              interaction.receipt?.conversationUrlDigestSha256
                ?? permit.conversationUrlDigestSha256,
            completedAt: interaction.receipt?.recordedAt ?? completedAt,
          };
        }
        receipt = interaction.receipt;
      } else {
        receipt = await this.bridge.deliver({
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
          prompt,
          promptDigestSha256,
          conversationUrlDigestSha256: permit.conversationUrlDigestSha256,
        });
      }
      if (receipt.state === "no_effect") {
        return {
          schemaVersion: 1,
          permitRef: permit.permitRef,
          disposition: "failed_no_effect",
          interactionSessionRef,
          ...(interactionActionId ? { interactionActionId } : {}),
          interactionReceiptRef: receipt.deliveryRef,
          noEffectProofRef:
            receipt.noEffectProofRef ?? `no-effect:${receipt.deliveryRef}`,
          verificationRefs: [...new Set([
            ...interactionVerificationRefs,
            ...receipt.verificationRefs,
          ])].sort(),
          failureCode: receipt.failureCode,
          conversationUrlDigestSha256: receipt.conversationUrlDigestSha256,
          completedAt: receipt.recordedAt,
        };
      }
      if (receipt.state !== "delivered" || !receipt.itemRef || !receipt.turnRef) {
        const lifecycleEvidence = this.recordIndeterminateHostTurn(
          permit,
          binding,
          receipt,
          receipt.failureCode ?? "DELIVERY_NOT_FULLY_RECONCILED",
        );
        return {
          schemaVersion: 1,
          permitRef: permit.permitRef,
          disposition: "indeterminate",
          interactionSessionRef,
          interactionActionId: interactionActionId ?? receipt.deliveryRef,
          interactionReceiptRef: receipt.deliveryRef,
          verificationRefs: [...new Set([
            ...receipt.verificationRefs,
            ...interactionVerificationRefs,
            ...lifecycleEvidence,
          ])].sort(),
          failureCode: receipt.failureCode ?? "DELIVERY_NOT_FULLY_RECONCILED",
          conversationUrlDigestSha256: receipt.conversationUrlDigestSha256,
          completedAt: receipt.recordedAt,
        };
      }
      const generationBoundaryRefAfter =
        receipt.generationBoundaryRefAfter ?? receipt.turnRef;
      try {
        this.hostTurns.recordWakeDispatchStarted({
          idempotencyKey: `host-turn-delivered:${permit.permitRef}`,
          observerExecutionScopeRef: permit.actorScopeRef,
          gate: permit.hostTurnGate,
          targetExecutionScopeRef: permit.targetExecutionScopeRef,
          missionRef: permit.missionRef,
          conversationBindingRef: binding.bindingRef,
          conversationBindingGeneration: binding.bindingGeneration,
          targetKind: binding.targetKind,
          targetRefDigestSha256: binding.bridgeTargetRefDigestSha256,
          providerAdapterId: permit.transportId,
          providerSessionRef: binding.targetAlias,
          providerTurnRef: receipt.turnRef,
          generationBoundaryRef: generationBoundaryRefAfter,
          workCycleRef: permit.envelope.workCycleRef,
          correlationRef: permit.envelope.correlationRef,
          pendingWorkRef: permit.pendingWorkId,
          wakePermitRef: permit.permitRef,
          evidenceRefs: [...new Set([
            ...receipt.verificationRefs,
            `conversation-delivery:${receipt.deliveryRef}`,
            `prompt-admission:${receipt.itemRef}`,
            `provider-turn:${receipt.turnRef}`,
          ])].sort(),
          authorityReadbackRefs: [...new Set([
            ...permit.hostTurnGate.authorityReadbackRefs,
            `conversation-bridge-authority:${receipt.authority.authority}`,
            `conversation-delivery-readback:${receipt.deliveryRef}`,
          ])].sort(),
          effectReadbackRefs: [`conversation-delivery-effect:${receipt.deliveryRef}`],
          observedAt: receipt.recordedAt,
          evidenceExpiresAt: boundedEvidenceExpiry(receipt.recordedAt),
        });
      } catch (error) {
        const lifecycleEvidence = this.recordIndeterminateHostTurn(
          permit,
          binding,
          receipt,
          "HOST_TURN_DURABILITY_FAILED_AFTER_DELIVERY",
          error,
        );
        return {
          schemaVersion: 1,
          permitRef: permit.permitRef,
          disposition: "indeterminate",
          interactionSessionRef,
          interactionActionId: interactionActionId ?? receipt.deliveryRef,
          interactionReceiptRef: receipt.deliveryRef,
          verificationRefs: [...new Set([
            ...receipt.verificationRefs,
            ...interactionVerificationRefs,
            ...lifecycleEvidence,
          ])].sort(),
          failureCode: "HOST_TURN_DURABILITY_FAILED_AFTER_DELIVERY",
          conversationUrlDigestSha256: receipt.conversationUrlDigestSha256,
          completedAt: receipt.recordedAt,
        };
      }
      return {
        schemaVersion: 1,
        permitRef: permit.permitRef,
        disposition: "verified",
        interactionSessionRef,
        interactionActionId: interactionActionId ?? receipt.deliveryRef,
        interactionReceiptRef: receipt.deliveryRef,
        promptAdmissionRef: receipt.itemRef,
        generationBoundaryRefAfter,
        conversationUrlDigestSha256: receipt.conversationUrlDigestSha256,
        verificationRefs: [...new Set([
          ...interactionVerificationRefs,
          ...receipt.verificationRefs,
        ])].sort(),
        completedAt: receipt.recordedAt,
      };
    } catch (error) {
      const lifecycleEvidence = this.recordIndeterminateHostTurn(
        permit,
        binding,
        undefined,
        "BRIDGE_DELIVERY_OUTCOME_UNKNOWN",
        error,
      );
      return {
        schemaVersion: 1,
        permitRef: permit.permitRef,
        disposition: "indeterminate",
        interactionSessionRef: binding.bindingRef,
        verificationRefs: [...new Set([
          `bridge-error-sha256:${sha256(error instanceof Error ? error.message : String(error))}`,
          ...lifecycleEvidence,
        ])].sort(),
        failureCode: "BRIDGE_DELIVERY_OUTCOME_UNKNOWN",
        conversationUrlDigestSha256: permit.conversationUrlDigestSha256,
        completedAt,
      };
    }
  }

  recordWakeReconciliation(input: WakeLowerPlaneReconciliationInput): string[] {
    const interactionRefs = input.permit.transportKind === "web_ui"
      ? this.webUiInteractions?.recordReconciliation(input)
      : [];
    if (input.permit.transportKind === "web_ui" && !interactionRefs) {
      throw new Error(
        "Web UI wake reconciliation requires the durable InteractionBroker.",
      );
    }
    const generationBoundaryRef = input.resolution === "effect_verified"
      ? input.generationBoundaryRefAfter
      : `reconciled-absent:${sha256(canonicalJson({
          permitRef: input.permit.permitRef,
          interactionReconciliationRef: input.interactionReconciliationRef,
          effectReadbackRef: input.effectReadbackRef,
        }))}`;
    if (!generationBoundaryRef) {
      throw new Error(
        "Verified wake reconciliation requires a generation boundary after delivery.",
      );
    }
    const hostTurn = this.hostTurns.reconcileWakeDispatch({
      idempotencyKey:
        `host-turn-reconcile:${input.permit.permitRef}:${input.resolution}`,
      observerExecutionScopeRef: input.permit.actorScopeRef,
      targetExecutionScopeRef: input.permit.targetExecutionScopeRef,
      missionRef: input.permit.missionRef,
      wakePermitRef: input.permit.permitRef,
      resolution: input.resolution,
      generationBoundaryRef,
      evidenceRefs: [...new Set([
        input.interactionReconciliationRef,
        ...input.verificationRefs,
        ...(input.promptAdmissionRef
          ? [`prompt-admission:${input.promptAdmissionRef}`]
          : []),
      ])].sort(),
      authorityReadbackRefs: [...new Set([
        ...input.permit.hostTurnGate.authorityReadbackRefs,
        input.authorityReadbackRef,
      ])].sort(),
      effectReadbackRefs: [input.effectReadbackRef],
      observedAt: input.observedAt,
      evidenceExpiresAt: boundedEvidenceExpiry(input.observedAt),
    });
    return [...new Set([
      ...(interactionRefs ?? []),
      `host-turn:${hostTurn.value.hostTurnRef}`,
      `host-turn-state:${hostTurn.value.state}`,
      `host-turn-revision:${String(hostTurn.value.revision)}`,
    ])].sort();
  }

  private async preflightPermit(
    permit: WakePermit,
    binding: ConversationTargetBinding,
  ): Promise<string | undefined> {
    try {
      const status = await this.bridge.status(binding.targetAlias);
      if (status.targetRefDigestSha256 !== binding.bridgeTargetRefDigestSha256
        || status.targetKind !== binding.targetKind) {
        return "PREFLIGHT_TARGET_BINDING_CHANGED";
      }
      const route = routeConversationTransport({
        targetKind: binding.targetKind,
        transports: status.candidates,
      });
      if (route.state !== "selected") return "PREFLIGHT_TRANSPORT_NOT_ELIGIBLE";
      const selected = route.selected;
      if (selected.transportId !== permit.transportId
        || selected.kind !== permit.transportKind) {
        return "PREFLIGHT_TRANSPORT_CHANGED";
      }
      const routeDigestSha256 = conversationRouteDigest({
        targetAlias: binding.targetAlias,
        targetKind: binding.targetKind,
        targetRefDigestSha256: status.targetRefDigestSha256,
        bindingRef: binding.bindingRef,
        bindingGeneration: binding.bindingGeneration,
        transportId: selected.transportId,
        transportKind: selected.kind,
        conversationUrlDigestSha256: selected.conversationUrlDigestSha256,
        evidenceDigestSha256: status.evidenceDigestSha256,
      });
      if (selected.conversationUrlDigestSha256
        !== permit.conversationUrlDigestSha256) {
        return "PREFLIGHT_CONVERSATION_URL_BINDING_CHANGED";
      }
      const classification = classifyConversationHostTurnLifecycle(
        selected.sessionLifecycle,
      );
      if (!classification
        || !["awaiting_input", "completed", "failed", "cancelled"].includes(
          classification.state,
        )) {
        if (classification) {
          try {
            observeConversationHostTurn({
              manager: this.hostTurns,
              observerExecutionScopeRef: permit.actorScopeRef,
              targetExecutionScopeRef: permit.targetExecutionScopeRef,
              missionRef: permit.missionRef,
              binding,
              status,
              selected,
              routeDigestSha256,
              correlationRef: permit.envelope.correlationRef,
              pendingWorkRef: permit.pendingWorkId,
              idempotencyKey: `host-turn-preflight-hold:${sha256(canonicalJson({
                permitRef: permit.permitRef,
                sessionLifecycle: selected.sessionLifecycle,
                evidenceDigestSha256: status.evidenceDigestSha256,
                observedAt: status.observedAt,
                expiresAt: status.expiresAt,
                routeDigestSha256,
              }))}`,
            });
          } catch {
            return "PREFLIGHT_HOST_TURN_OBSERVATION_FAILED";
          }
        }
        return "PREFLIGHT_HOST_TURN_NOT_WAKE_ELIGIBLE";
      }
      if (routeDigestSha256 !== permit.transportRouteDigestSha256) {
        return "PREFLIGHT_TRANSPORT_ROUTE_CHANGED";
      }
      this.hostTurns.assertGateCurrent(permit.hostTurnGate, {
        targetExecutionScopeRef: permit.targetExecutionScopeRef,
        missionRef: permit.missionRef,
        conversationBindingRef: binding.bindingRef,
        conversationBindingGeneration: binding.bindingGeneration,
        targetKind: binding.targetKind,
        targetRefDigestSha256: binding.bridgeTargetRefDigestSha256,
        authorityReadbackRefs: permit.hostTurnGate.authorityReadbackRefs,
      });
      return undefined;
    } catch (error) {
      return `PREFLIGHT_HOST_TURN_GATE_REJECTED:${sha256(
        error instanceof Error ? error.message : String(error),
      )}`;
    }
  }

  private recordIndeterminateHostTurn(
    permit: WakePermit,
    binding: ConversationTargetBinding,
    receipt: ConversationBridgeDeliveryReceipt | undefined,
    failureCode: string,
    error?: unknown,
  ): string[] {
    const errorRef = error === undefined
      ? undefined
      : `host-turn-error-sha256:${sha256(
          error instanceof Error ? error.message : String(error),
        )}`;
    const evidenceRefs = [...new Set([
      ...(receipt?.verificationRefs ?? []),
      ...(receipt ? [`conversation-delivery:${receipt.deliveryRef}`] : []),
      `failure:${failureCode}`,
      ...(errorRef ? [errorRef] : []),
    ])].sort();
    try {
      this.hostTurns.recordWakeDispatchIndeterminate({
        idempotencyKey: `host-turn-indeterminate:${permit.permitRef}`,
        observerExecutionScopeRef: permit.actorScopeRef,
        gate: permit.hostTurnGate,
        targetExecutionScopeRef: permit.targetExecutionScopeRef,
        missionRef: permit.missionRef,
        conversationBindingRef: binding.bindingRef,
        conversationBindingGeneration: binding.bindingGeneration,
        targetKind: binding.targetKind,
        targetRefDigestSha256: binding.bridgeTargetRefDigestSha256,
        providerAdapterId: permit.transportId ?? "conversation-transport:unknown",
        providerSessionRef: binding.targetAlias,
        providerTurnRef: receipt?.turnRef,
        generationBoundaryRef:
          receipt?.generationBoundaryRefAfter
          ?? receipt?.turnRef
          ?? `indeterminate:${sha256(canonicalJson({
            permitRef: permit.permitRef,
            failureCode,
          }))}`,
        workCycleRef: permit.envelope.workCycleRef,
        correlationRef: permit.envelope.correlationRef,
        pendingWorkRef: permit.pendingWorkId,
        wakePermitRef: permit.permitRef,
        evidenceRefs,
        authorityReadbackRefs: [...new Set([
          ...permit.hostTurnGate.authorityReadbackRefs,
          ...(receipt
            ? [`conversation-bridge-authority:${receipt.authority.authority}`]
            : []),
        ])].sort(),
        effectReadbackRefs: receipt
          ? [`conversation-delivery-outcome:${receipt.deliveryRef}`]
          : [`conversation-delivery-outcome-unknown:${permit.permitRef}`],
        observedAt: receipt?.recordedAt ?? new Date().toISOString(),
        evidenceExpiresAt: boundedEvidenceExpiry(
          receipt?.recordedAt ?? new Date().toISOString(),
        ),
        indeterminateReasonCodes: [failureCode],
      });
      return [...evidenceRefs, `host-turn-indeterminate:${permit.permitRef}`];
    } catch (recordError) {
      return [...evidenceRefs, `host-turn-record-error-sha256:${sha256(
        recordError instanceof Error ? recordError.message : String(recordError),
      )}`];
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

function boundedEvidenceExpiry(observedAt: string): string {
  const observedAtMs = Date.parse(observedAt);
  const base = Number.isFinite(observedAtMs) ? observedAtMs : Date.now();
  return new Date(base + 60_000).toISOString();
}
