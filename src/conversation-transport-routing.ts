export type ConversationTargetKind =
  | "codex_thread"
  | "chatgpt_chat"
  | "chatgpt_work"
  | "generic";

export type ConversationTransportKind =
  | "native_rpc"
  | "local_agent"
  | "web_ui";

export type ConversationTransportAvailability =
  | "available"
  | "unavailable"
  | "unknown";

export type ConversationTransportHealth =
  | "healthy"
  | "degraded"
  | "unavailable"
  | "unknown";

export type ConversationDirectInputCapability =
  | "available"
  | "unavailable"
  | "unknown";

export type ConversationBindingState = "exact" | "mismatch" | "unknown";

export type ConversationReconciliationCapability =
  | "available"
  | "unavailable"
  | "unknown";

export type ConversationSurfaceTrust =
  | "official"
  | "registered_extension"
  | "ui_contract"
  | "undocumented"
  | "none";

export type ConversationDeliveryState =
  | "not_attempted"
  | "staged"
  | "accepted"
  | "reconciled"
  | "rejected"
  | "indeterminate";

export interface ConversationTransportObservation {
  transportId: string;
  targetKind: ConversationTargetKind;
  kind: ConversationTransportKind;
  availability: ConversationTransportAvailability;
  transportHealth: ConversationTransportHealth;
  directInput: ConversationDirectInputCapability;
  binding: ConversationBindingState;
  reconciliation: ConversationReconciliationCapability;
  surfaceTrust: ConversationSurfaceTrust;
  sessionLifecycle: string;
  evidenceRefs: readonly string[];
}

export interface ConversationTransportRoutingPolicy {
  allowLocalAgent: boolean;
  allowUiFallback: boolean;
  requireTrustedNativeSurface: boolean;
  requireExactBinding: boolean;
  requireReconciliation: boolean;
}

export const STRICT_CONVERSATION_TRANSPORT_POLICY:
  ConversationTransportRoutingPolicy = {
    allowLocalAgent: true,
    allowUiFallback: true,
    requireTrustedNativeSurface: true,
    requireExactBinding: true,
    requireReconciliation: true,
  };

export type ConversationTransportRejectionReason =
  | "invalid_transport_id"
  | "duplicate_transport_id"
  | "target_mismatch"
  | "local_agent_disallowed"
  | "ui_fallback_disallowed"
  | "transport_unavailable"
  | "transport_availability_unknown"
  | "transport_degraded"
  | "transport_health_unavailable"
  | "transport_health_unknown"
  | "direct_input_unavailable"
  | "direct_input_unknown"
  | "binding_mismatch"
  | "binding_unknown"
  | "reconciliation_unavailable"
  | "reconciliation_unknown"
  | "untrusted_native_surface"
  | "untrusted_ui_surface";

export interface ConsideredConversationTransport {
  observation: ConversationTransportObservation;
  eligible: boolean;
  reasons: readonly ConversationTransportRejectionReason[];
}

export interface SelectedConversationTransportRoute {
  state: "selected";
  selected: ConversationTransportObservation;
  considered: readonly ConsideredConversationTransport[];
}

export interface BlockedConversationTransportRoute {
  state: "blocked";
  code: "unreconciled_previous_delivery" | "no_eligible_transport";
  previousDeliveryState: ConversationDeliveryState;
  considered: readonly ConsideredConversationTransport[];
}

export type ConversationTransportRoute =
  | SelectedConversationTransportRoute
  | BlockedConversationTransportRoute;

export interface RouteConversationTransportInput {
  targetKind: ConversationTargetKind;
  transports: readonly ConversationTransportObservation[];
  previousDeliveryState?: ConversationDeliveryState;
  policy?: ConversationTransportRoutingPolicy;
}

const TRANSPORT_PREFERENCE: Readonly<Record<ConversationTransportKind, number>> = {
  native_rpc: 0,
  local_agent: 1,
  web_ui: 2,
};

const DELIVERY_STATES_REQUIRING_RECONCILIATION = new Set<ConversationDeliveryState>([
  "staged",
  "accepted",
  "indeterminate",
]);

function trustedSurface(
  observation: ConversationTransportObservation,
): boolean {
  if (observation.kind === "web_ui") {
    return observation.surfaceTrust === "ui_contract";
  }

  return observation.surfaceTrust === "official"
    || observation.surfaceTrust === "registered_extension";
}

function rejectionReasons(
  targetKind: ConversationTargetKind,
  observation: ConversationTransportObservation,
  policy: ConversationTransportRoutingPolicy,
  duplicateTransportId: boolean,
): ConversationTransportRejectionReason[] {
  const reasons: ConversationTransportRejectionReason[] = [];

  if (observation.transportId.trim().length === 0) {
    reasons.push("invalid_transport_id");
  }
  if (duplicateTransportId) reasons.push("duplicate_transport_id");
  if (observation.targetKind !== targetKind) reasons.push("target_mismatch");

  if (observation.kind === "local_agent" && !policy.allowLocalAgent) {
    reasons.push("local_agent_disallowed");
  }
  if (observation.kind === "web_ui" && !policy.allowUiFallback) {
    reasons.push("ui_fallback_disallowed");
  }

  switch (observation.availability) {
    case "unavailable":
      reasons.push("transport_unavailable");
      break;
    case "unknown":
      reasons.push("transport_availability_unknown");
      break;
    case "available":
      break;
  }

  switch (observation.transportHealth) {
    case "degraded":
      reasons.push("transport_degraded");
      break;
    case "unavailable":
      reasons.push("transport_health_unavailable");
      break;
    case "unknown":
      reasons.push("transport_health_unknown");
      break;
    case "healthy":
      break;
  }

  switch (observation.directInput) {
    case "unavailable":
      reasons.push("direct_input_unavailable");
      break;
    case "unknown":
      reasons.push("direct_input_unknown");
      break;
    case "available":
      break;
  }

  if (policy.requireExactBinding) {
    if (observation.binding === "mismatch") reasons.push("binding_mismatch");
    if (observation.binding === "unknown") reasons.push("binding_unknown");
  }

  if (policy.requireReconciliation) {
    if (observation.reconciliation === "unavailable") {
      reasons.push("reconciliation_unavailable");
    }
    if (observation.reconciliation === "unknown") {
      reasons.push("reconciliation_unknown");
    }
  }

  if (observation.kind === "web_ui" && !trustedSurface(observation)) {
    reasons.push("untrusted_ui_surface");
  } else if (
    observation.kind !== "web_ui"
    && policy.requireTrustedNativeSurface
    && !trustedSurface(observation)
  ) {
    reasons.push("untrusted_native_surface");
  }

  return reasons;
}

function compareTransports(
  left: ConversationTransportObservation,
  right: ConversationTransportObservation,
): number {
  const preference = TRANSPORT_PREFERENCE[left.kind]
    - TRANSPORT_PREFERENCE[right.kind];
  return preference !== 0
    ? preference
    : left.transportId.localeCompare(right.transportId);
}

export function routeConversationTransport(
  input: RouteConversationTransportInput,
): ConversationTransportRoute {
  const policy = input.policy ?? STRICT_CONVERSATION_TRANSPORT_POLICY;
  const previousDeliveryState = input.previousDeliveryState ?? "not_attempted";
  const transportIdCounts = new Map<string, number>();
  for (const observation of input.transports) {
    transportIdCounts.set(
      observation.transportId,
      (transportIdCounts.get(observation.transportId) ?? 0) + 1,
    );
  }
  const considered = [...input.transports]
    .sort(compareTransports)
    .map((observation): ConsideredConversationTransport => {
      const reasons = rejectionReasons(
        input.targetKind,
        observation,
        policy,
        (transportIdCounts.get(observation.transportId) ?? 0) > 1,
      );
      return {
        observation,
        eligible: reasons.length === 0,
        reasons,
      };
    });

  if (DELIVERY_STATES_REQUIRING_RECONCILIATION.has(previousDeliveryState)) {
    return {
      state: "blocked",
      code: "unreconciled_previous_delivery",
      previousDeliveryState,
      considered,
    };
  }

  const selected = considered.find((candidate) => candidate.eligible)?.observation;
  if (selected == null) {
    return {
      state: "blocked",
      code: "no_eligible_transport",
      previousDeliveryState,
      considered,
    };
  }

  return {
    state: "selected",
    selected,
    considered,
  };
}
