import {
  InteractionBroker,
  InteractionBrokerError,
} from "./interaction-broker.js";
import type {
  InteractionActionOutcome,
  InteractionActionRequest,
  InteractionAdapter,
  InteractionBinding,
  InteractionEvidenceRef,
  InteractionObservationInput,
  InteractionPreparedAction,
  InteractionVerificationResult,
} from "./interaction-harness.js";
import type { ConversationTransportBridgePort } from "./conversation-transport-bridge-client.js";
import {
  conversationRouteDigest,
  type ConversationBridgeDeliveryReceipt,
  type ConversationBridgeRequest,
} from "./conversation-transport-bridge-protocol.js";
import type { ConversationTargetBinding } from "./conversation-target-binding-store.js";
import { routeConversationTransport } from "./conversation-transport-routing.js";
import {
  canonicalJson,
  sha256,
  type WakeLowerPlaneReconciliationInput,
  type WakePermit,
} from "./execution-wake-coordination-model.js";
import type { DurableInteractionBrokerStore } from "./interaction-broker-store.js";

const ADAPTER_ID = "conversation-transport-web-ui-broker";
const ADAPTER_SESSION_REF = "zes-conversation-transport-playwright";

export interface ConversationWebUiBrokerDeliveryInput {
  permit: WakePermit;
  binding: ConversationTargetBinding;
  prompt: string;
  messageId: string;
}

export interface ConversationWebUiBrokerDeliveryResult {
  state: "delivered" | "no_effect" | "indeterminate";
  interactionSessionRef: string;
  interactionActionId?: string;
  receipt?: ConversationBridgeDeliveryReceipt;
  verificationRefs: string[];
  failureCode?: string;
}

export interface ConversationWebUiInteractionBrokerPort {
  deliver(
    input: ConversationWebUiBrokerDeliveryInput,
  ): Promise<ConversationWebUiBrokerDeliveryResult>;
  recordReconciliation(
    input: WakeLowerPlaneReconciliationInput,
  ): string[];
}

/**
 * Durable outer broker for the Conversation Transport Web UI actuator.
 *
 * Conversation Transport remains responsible for status, exact browser target
 * evidence, compose/submit, and admission readback. InteractionBroker owns the
 * one-client lease and persist-before-dispatch checkpoint around that actuator.
 * Native RPC never enters this adapter.
 */
export class ConversationWebUiInteractionBroker
implements ConversationWebUiInteractionBrokerPort {
  constructor(
    private readonly store: DurableInteractionBrokerStore,
    private readonly bridge: ConversationTransportBridgePort,
    private readonly now: () => number = Date.now,
  ) {}

  recordReconciliation(
    input: WakeLowerPlaneReconciliationInput,
  ): string[] {
    if (input.permit.transportKind !== "web_ui") return [];
    const sessionRef = interactionSessionRef(input.permit.permitRef);
    const evidence = interactionEvidence([
      input.interactionReconciliationRef,
      input.authorityReadbackRef,
      input.effectReadbackRef,
      ...input.verificationRefs,
      ...(input.promptAdmissionRef
        ? [`prompt-admission:${input.promptAdmissionRef}`]
        : []),
      ...(input.generationBoundaryRefAfter
        ? [`generation-boundary:${input.generationBoundaryRefAfter}`]
        : []),
      ...(input.permit.conversationUrlDigestSha256
        ? [
            `conversation-url-sha256:${input.permit.conversationUrlDigestSha256}`,
          ]
        : []),
    ]);
    const postStateDigestSha256 = sha256(canonicalJson({
      permitRef: input.permit.permitRef,
      resolution: input.resolution,
      interactionReconciliationRef: input.interactionReconciliationRef,
      authorityReadbackRef: input.authorityReadbackRef,
      effectReadbackRef: input.effectReadbackRef,
      promptAdmissionRef: input.promptAdmissionRef,
      generationBoundaryRefAfter: input.generationBoundaryRefAfter,
      verificationRefs: uniqueSorted(input.verificationRefs),
      promptDigestSha256: input.permit.envelope.bodyDigestSha256,
      conversationUrlDigestSha256:
        input.permit.conversationUrlDigestSha256,
    }));
    const record = this.store.reconcileIndeterminateSession({
      sessionRef,
      expectedExecutionScopeRef: input.permit.actorScopeRef,
      expectedPayloadDigestSha256: input.permit.envelope.bodyDigestSha256,
      expectedApprovalRef: approvalRef(input.permit.permitRef),
      expectedContextRef: webUiContextRef(
        input.permit.conversationUrlDigestSha256 ?? "",
      ),
      resolution: input.resolution,
      postStateDigestSha256,
      evidence,
      verificationRef: input.interactionReconciliationRef,
      authorityReadbackRef: input.authorityReadbackRef,
      observedAt: input.observedAt,
    });
    return interactionBrokerRefs(
      record.sessionRef,
      record.version,
      record.checkpoint.state,
    );
  }

  async deliver(
    input: ConversationWebUiBrokerDeliveryInput,
  ): Promise<ConversationWebUiBrokerDeliveryResult> {
    validateInput(input);
    const sessionRef = interactionSessionRef(input.permit.permitRef);
    const adapter = new ConversationBridgeWebUiAdapter(
      this.bridge,
      input,
      this.now,
    );
    let broker: InteractionBroker | undefined;
    try {
      broker = await InteractionBroker.open({
        store: this.store,
        adapter,
        identity: {
          executionScopeRef: input.permit.actorScopeRef,
          missionRef: input.permit.missionRef,
        },
        sessionRef,
        now: this.now,
        approvalVerifier: (verification) => {
          const exact = verification.identity.executionScopeRef
              === input.permit.actorScopeRef
            && verification.binding.adapterId === ADAPTER_ID
            && verification.binding.surface === "playwright"
            && verification.binding.backendSessionRef === ADAPTER_SESSION_REF
            && verification.binding.contextRef
              === webUiContextRef(input.permit.conversationUrlDigestSha256 ?? "")
            && verification.actionKind === "click"
            && verification.effectClass === "irreversible"
            && verification.approval.state === "approved"
            && verification.approval.ref === approvalRef(input.permit.permitRef)
            && verification.approval.actorRef === input.permit.actorScopeRef
            && verification.payloadDigestSha256
              === input.permit.envelope.bodyDigestSha256;
          return exact
            ? {
                verified: true,
                verificationRef: `interaction-approval-sha256:${sha256(canonicalJson({
                  permitRef: input.permit.permitRef,
                  wakeKey: input.permit.wakeKey,
                  hostTurnGate: input.permit.hostTurnGate.stateDigestSha256,
                  payloadDigestSha256: input.permit.envelope.bodyDigestSha256,
                }))}`,
                authorityReadbackRef:
                  `interaction-authority-readback-sha256:${sha256(canonicalJson(
                    input.permit.hostTurnGate.authorityReadbackRefs,
                  ))}`,
              }
            : { verified: false };
        },
      });
    } catch (error) {
      return brokerOpenFailure(sessionRef, error);
    }

    try {
      const observation = await broker.observe({
        targetKind: "browser",
        effectClass: "irreversible",
        requiredCapabilities: [
          "semanticTargeting",
          "persistentSession",
          "visibleUi",
        ],
        visibleUiRequired: true,
        existingSessionRequired: true,
      });
      const actionRequest: InteractionActionRequest = {
        idempotencyKey: `conversation-wake:${input.permit.permitRef}`,
        kind: "click",
        effectClass: "irreversible",
        target: {
          strategy: "semantic",
          targetRef: `conversation-wake-submit:${input.permit.permitRef}`,
        },
        expectedObservationId: observation.observation.observationId,
        expectedPreStateDigestSha256:
          observation.observation.stateDigestSha256,
        payloadDigestSha256: input.permit.envelope.bodyDigestSha256,
        declaredIdempotent: false,
        approval: {
          state: "approved",
          ref: approvalRef(input.permit.permitRef),
          actorRef: input.permit.actorScopeRef,
        },
        postconditions: [
          {
            kind: "custom",
            expected:
              `prompt_admitted_sha256:${input.permit.envelope.bodyDigestSha256}`,
            targetRef: `conversation-message-list:${input.binding.bindingRef}`,
          },
          {
            kind: "custom",
            expected: "new_generation_boundary",
            targetRef: `conversation-message-list:${input.binding.bindingRef}`,
          },
        ],
        timeoutMs: 60_000,
      };
      const result = await broker.act(actionRequest);
      const actionId = result.outcome?.actionId
        ?? result.record.checkpoint.verification?.actionId;
      const receipt = adapter.receipt ?? await this.reconcile(input);
      const brokerRefs = interactionBrokerRefs(
        result.record.sessionRef,
        result.record.version,
        result.record.checkpoint.state,
      );

      if (
        result.record.checkpoint.state === "verified"
        && receipt?.state === "delivered"
      ) {
        return {
          state: "delivered",
          interactionSessionRef: result.record.sessionRef,
          ...(actionId ? { interactionActionId: actionId } : {}),
          receipt,
          verificationRefs: uniqueSorted([
            ...brokerRefs,
            ...receipt.verificationRefs,
          ]),
        };
      }
      if (
        result.outcome?.status === "failed"
        && result.outcome.noEffectProven === true
        && receipt?.state === "no_effect"
      ) {
        return {
          state: "no_effect",
          interactionSessionRef: result.record.sessionRef,
          ...(actionId ? { interactionActionId: actionId } : {}),
          receipt,
          verificationRefs: uniqueSorted([
            ...brokerRefs,
            ...receipt.verificationRefs,
            ...(receipt.noEffectProofRef ? [receipt.noEffectProofRef] : []),
          ]),
          failureCode: receipt.failureCode ?? "WEB_UI_DELIVERY_NO_EFFECT",
        };
      }
      return {
        state: "indeterminate",
        interactionSessionRef: result.record.sessionRef,
        ...(actionId ? { interactionActionId: actionId } : {}),
        ...(receipt ? { receipt } : {}),
        verificationRefs: uniqueSorted([
          ...brokerRefs,
          ...(receipt?.verificationRefs ?? []),
        ]),
        failureCode:
          receipt?.failureCode ?? "INTERACTION_BROKER_EFFECT_INDETERMINATE",
      };
    } catch (error) {
      let status: ReturnType<InteractionBroker["status"]> | undefined;
      try {
        status = broker.status();
      } catch {
        status = undefined;
      }
      const checkpoint = status?.record.checkpoint
        ?? (error instanceof InteractionBrokerError
          ? error.details.checkpoint
            ?? error.details.currentRecord?.checkpoint
          : undefined);
      const checkpointProvesNoEffect = Boolean(
        checkpoint
        && checkpoint.pendingAction === undefined
        && [
          "needs_observation",
          "ready",
          "verified",
          "held",
          "failed",
          "cancelled",
        ].includes(checkpoint.state),
      );
      const preDispatchNoEffect = checkpointProvesNoEffect
        || (error instanceof InteractionBrokerError
          && [
            "checkpoint_persistence_failed_before_dispatch",
            "interaction_adapter_lease_lost",
            "interaction_broker_open_checkpoint_conflict",
          ].includes(error.code));
      const durableSessionRef = status?.record.sessionRef
        ?? checkpoint?.identity.sessionRef
        ?? sessionRef;
      const durableVersion = status?.record.version
        ?? (error instanceof InteractionBrokerError
          ? error.details.currentRecord?.version
          : undefined);
      return {
        state: preDispatchNoEffect ? "no_effect" : "indeterminate",
        interactionSessionRef: durableSessionRef,
        verificationRefs: uniqueSorted([
          ...(checkpoint
            ? interactionBrokerRefs(
                durableSessionRef,
                durableVersion ?? 0,
                checkpoint.state,
              )
            : [`interaction-session:${durableSessionRef}`]),
          `interaction-error-sha256:${sha256(
            error instanceof Error ? error.message : String(error),
          )}`,
        ]),
        failureCode: typedErrorCode(error)
          ?? (preDispatchNoEffect
            ? "INTERACTION_BROKER_PRE_DISPATCH_FAILED"
            : "INTERACTION_BROKER_DELIVERY_UNKNOWN"),
      };
    } finally {
      await broker.close().catch(() => false);
    }
  }

  private async reconcile(
    input: ConversationWebUiBrokerDeliveryInput,
  ): Promise<ConversationBridgeDeliveryReceipt | undefined> {
    try {
      return await this.bridge.reconcile({
        schemaVersion: 1,
        command: "reconcile",
        targetAlias: input.binding.targetAlias,
        targetRefDigestSha256: input.binding.bridgeTargetRefDigestSha256,
        bindingRef: input.binding.bindingRef,
        bindingGeneration: input.binding.bindingGeneration,
        permitRef: input.permit.permitRef,
        transportId: input.permit.transportId ?? "",
        transportKind: "web_ui",
        routeDigestSha256: input.permit.transportRouteDigestSha256 ?? "",
        messageId: input.messageId,
        promptDigestSha256: input.permit.envelope.bodyDigestSha256,
        conversationUrlDigestSha256:
          input.permit.conversationUrlDigestSha256,
      });
    } catch {
      return undefined;
    }
  }
}

class ConversationBridgeWebUiAdapter implements InteractionAdapter {
  readonly descriptor = {
    id: ADAPTER_ID,
    surface: "playwright" as const,
    available: true,
    targetKinds: ["browser" as const],
    supportedActionKinds: ["click" as const],
    minimumEffectClassByAction: {
      click: "irreversible" as const,
    },
    capabilities: {
      observe: true,
      semanticTargeting: true,
      coordinateTargeting: false,
      verify: true,
      boundedTimeout: true,
      screenshotEvidence: false,
      traceEvidence: false,
      persistentSession: true,
      isolatedSession: false,
      visibleUi: true,
      fileTransfer: false,
    },
    concurrency: "exclusive" as const,
    busy: false,
    sessionRef: ADAPTER_SESSION_REF,
  };

  receipt?: ConversationBridgeDeliveryReceipt;
  private observationBinding?: InteractionBinding;

  constructor(
    private readonly bridge: ConversationTransportBridgePort,
    private readonly input: ConversationWebUiBrokerDeliveryInput,
    private readonly now: () => number,
  ) {}

  async observe(): Promise<InteractionObservationInput> {
    const status = await this.bridge.status(this.input.binding.targetAlias);
    if (
      status.targetRefDigestSha256
        !== this.input.binding.bridgeTargetRefDigestSha256
      || status.targetKind !== this.input.binding.targetKind
    ) {
      throw new Error("Interaction broker target binding changed before observation.");
    }
    const route = routeConversationTransport({
      targetKind: this.input.binding.targetKind,
      transports: status.candidates,
    });
    if (route.state !== "selected" || route.selected.kind !== "web_ui") {
      throw new Error("Interaction broker Web UI route is no longer eligible.");
    }
    const selected = route.selected;
    const routeDigestSha256 = conversationRouteDigest({
      targetAlias: this.input.binding.targetAlias,
      targetKind: this.input.binding.targetKind,
      targetRefDigestSha256: status.targetRefDigestSha256,
      bindingRef: this.input.binding.bindingRef,
      bindingGeneration: this.input.binding.bindingGeneration,
      transportId: selected.transportId,
      transportKind: selected.kind,
      conversationUrlDigestSha256: selected.conversationUrlDigestSha256,
      evidenceDigestSha256: status.evidenceDigestSha256,
    });
    if (
      selected.transportId !== this.input.permit.transportId
      || routeDigestSha256 !== this.input.permit.transportRouteDigestSha256
      || selected.conversationUrlDigestSha256
        !== this.input.permit.conversationUrlDigestSha256
    ) {
      throw new Error("Interaction broker route or conversation binding changed.");
    }
    const binding: InteractionBinding = {
      adapterId: ADAPTER_ID,
      surface: "playwright",
      backendSessionRef: ADAPTER_SESSION_REF,
      contextRef: webUiContextRef(
        this.input.permit.conversationUrlDigestSha256 ?? "",
      ),
      targetKind: "browser",
    };
    this.observationBinding = binding;
    return {
      binding,
      stateDigestSha256: sha256(canonicalJson({
        targetRefDigestSha256: status.targetRefDigestSha256,
        bindingRef: this.input.binding.bindingRef,
        bindingGeneration: this.input.binding.bindingGeneration,
        transportId: selected.transportId,
        transportRouteDigestSha256: routeDigestSha256,
        conversationUrlDigestSha256: selected.conversationUrlDigestSha256,
        hostTurnStateDigestSha256:
          this.input.permit.hostTurnGate.stateDigestSha256,
        evidenceDigestSha256: status.evidenceDigestSha256,
      })),
      observedAt: status.observedAt,
      evidence: interactionEvidence([
        ...status.evidenceRefs,
        ...selected.evidenceRefs,
        `host-turn-state-sha256:${this.input.permit.hostTurnGate.stateDigestSha256}`,
      ]),
    };
  }

  async act(action: InteractionPreparedAction): Promise<InteractionActionOutcome> {
    if (
      action.kind !== "click"
      || action.effectClass !== "irreversible"
      || action.payloadDigestSha256
        !== this.input.permit.envelope.bodyDigestSha256
      || action.binding.contextRef
        !== webUiContextRef(this.input.permit.conversationUrlDigestSha256 ?? "")
    ) {
      return {
        actionId: action.actionId,
        status: "failed",
        noEffectProven: true,
        detailCode: "interaction_action_permit_binding_mismatch",
      };
    }
    try {
      this.receipt = await this.bridge.deliver(this.deliveryRequest());
    } catch (error) {
      const disposition = bridgeRetryDisposition(error);
      if (disposition === "forbidden" || disposition === "safe_after_correction") {
        return {
          actionId: action.actionId,
          status: "failed",
          noEffectProven: true,
          detailCode: "bridge_rejected_before_web_ui_dispatch",
          evidence: interactionEvidence([
            `bridge-rejection-sha256:${sha256(
              error instanceof Error ? error.message : String(error),
            )}`,
          ]),
        };
      }
      throw error;
    }
    const receipt = this.receipt;
    const evidence = receiptEvidence(receipt);
    if (receipt.state === "delivered") {
      return {
        actionId: action.actionId,
        status: "succeeded",
        backendReceiptRef: receipt.deliveryRef,
        evidence,
      };
    }
    if (receipt.state === "no_effect") {
      return {
        actionId: action.actionId,
        status: "failed",
        noEffectProven: true,
        backendReceiptRef: receipt.deliveryRef,
        detailCode: receipt.failureCode ?? "bridge_web_ui_no_effect",
        evidence,
      };
    }
    return {
      actionId: action.actionId,
      status: "unknown",
      backendReceiptRef: receipt.deliveryRef,
      detailCode: receipt.failureCode ?? "bridge_web_ui_delivery_indeterminate",
      evidence,
    };
  }

  async verify(
    action: InteractionPreparedAction,
    outcome: InteractionActionOutcome,
  ): Promise<InteractionVerificationResult> {
    const receipt = this.receipt;
    const binding = this.observationBinding ?? action.binding;
    const verified = outcome.status === "succeeded"
      && receipt?.state === "delivered"
      && receipt.permitRef === this.input.permit.permitRef
      && receipt.transportId === this.input.permit.transportId
      && receipt.routeDigestSha256
        === this.input.permit.transportRouteDigestSha256
      && receipt.promptDigestSha256
        === this.input.permit.envelope.bodyDigestSha256
      && receipt.conversationUrlDigestSha256
        === this.input.permit.conversationUrlDigestSha256
      && Boolean(receipt.itemRef)
      && Boolean(receipt.generationBoundaryRefAfter)
      && receipt.verificationRefs.length > 0;
    return {
      actionId: action.actionId,
      verified,
      binding,
      ...(verified && receipt
        ? {
            postStateDigestSha256: sha256(canonicalJson({
              deliveryRef: receipt.deliveryRef,
              itemRef: receipt.itemRef,
              generationBoundaryRefAfter: receipt.generationBoundaryRefAfter,
              promptDigestSha256: receipt.promptDigestSha256,
              conversationUrlDigestSha256:
                receipt.conversationUrlDigestSha256,
            })),
            verifiedAt: receipt.recordedAt,
          }
        : {}),
      detailCode: verified ? "bridge_web_ui_delivery_verified" : "bridge_web_ui_delivery_unverified",
      evidence: receipt ? receiptEvidence(receipt) : [],
    };
  }

  private deliveryRequest(): Extract<
    ConversationBridgeRequest,
    { command: "deliver" }
  > {
    return {
      schemaVersion: 1,
      command: "deliver",
      targetAlias: this.input.binding.targetAlias,
      targetRefDigestSha256:
        this.input.binding.bridgeTargetRefDigestSha256,
      bindingRef: this.input.binding.bindingRef,
      bindingGeneration: this.input.binding.bindingGeneration,
      permitRef: this.input.permit.permitRef,
      transportId: this.input.permit.transportId ?? "",
      transportKind: "web_ui",
      routeDigestSha256:
        this.input.permit.transportRouteDigestSha256 ?? "",
      messageId: this.input.messageId,
      prompt: this.input.prompt,
      promptDigestSha256: this.input.permit.envelope.bodyDigestSha256,
      conversationUrlDigestSha256:
        this.input.permit.conversationUrlDigestSha256,
    };
  }
}

function validateInput(input: ConversationWebUiBrokerDeliveryInput): void {
  if (input.permit.transportKind !== "web_ui") {
    throw new Error("Conversation Web UI broker accepts only Web UI permits.");
  }
  if (!/^[a-f0-9]{64}$/.test(input.permit.conversationUrlDigestSha256 ?? "")) {
    throw new Error("Conversation Web UI broker requires an exact URL digest.");
  }
  if (sha256(input.prompt) !== input.permit.envelope.bodyDigestSha256) {
    throw new Error("Conversation Web UI broker prompt digest mismatch.");
  }
}

function brokerOpenFailure(
  sessionRef: string,
  error: unknown,
): ConversationWebUiBrokerDeliveryResult {
  return {
    // Broker opening can claim/read/CAS executor-local state but cannot invoke
    // the adapter. Any failure here is therefore an explicit no-effect path.
    state: "no_effect",
    interactionSessionRef: sessionRef,
    verificationRefs: [
      `interaction-open-error-sha256:${sha256(
        error instanceof Error ? error.message : String(error),
      )}`,
    ],
    failureCode: typedErrorCode(error) ?? "INTERACTION_BROKER_OPEN_FAILED",
  };
}

function interactionSessionRef(permitRef: string): string {
  return `ixs_wake_${sha256(permitRef).slice(0, 32)}`;
}

function approvalRef(permitRef: string): string {
  return `wake-permit:${permitRef}`;
}

function webUiContextRef(digestSha256: string): string {
  return `conversation-url-sha256:${digestSha256}`;
}

function interactionBrokerRefs(
  sessionRef: string,
  version: number,
  state: string,
): string[] {
  return [
    `interaction-session:${sessionRef}`,
    `interaction-checkpoint-version:${String(version)}`,
    `interaction-checkpoint-state:${state}`,
  ];
}

function interactionEvidence(refs: string[]): InteractionEvidenceRef[] {
  return uniqueSorted(refs).map((ref) => ({
    kind: "api_response" as const,
    ref,
  }));
}

function receiptEvidence(
  receipt: ConversationBridgeDeliveryReceipt,
): InteractionEvidenceRef[] {
  return interactionEvidence([
    `conversation-delivery:${receipt.deliveryRef}`,
    ...receipt.verificationRefs,
    ...(receipt.noEffectProofRef ? [receipt.noEffectProofRef] : []),
    ...(receipt.itemRef ? [`prompt-admission:${receipt.itemRef}`] : []),
    ...(receipt.generationBoundaryRefAfter
      ? [`generation-boundary:${receipt.generationBoundaryRefAfter}`]
      : []),
  ]);
}

function bridgeRetryDisposition(
  error: unknown,
): "forbidden" | "reconcile_first" | "safe_after_correction" | undefined {
  const candidate = error as { retryDisposition?: unknown };
  return candidate.retryDisposition === "forbidden"
    || candidate.retryDisposition === "reconcile_first"
    || candidate.retryDisposition === "safe_after_correction"
    ? candidate.retryDisposition
    : undefined;
}

function typedErrorCode(error: unknown): string | undefined {
  if (error instanceof InteractionBrokerError) return error.code;
  const candidate = error as { code?: unknown };
  return typeof candidate.code === "string" && candidate.code.length > 0
    ? candidate.code
    : undefined;
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}
