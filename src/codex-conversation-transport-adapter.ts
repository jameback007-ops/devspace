import type {
  ConversationBindingState,
  ConversationReconciliationCapability,
  ConversationTransportObservation,
} from "./conversation-transport-routing.js";

export interface CodexConversationTransportStatus {
  observationKind: string;
  appServerTransport: "healthy" | "unavailable" | "unknown" | "not_observed";
  threadLifecycle: string;
  directInput: "available" | "unavailable" | "unknown" | "not_observed";
}

export interface CodexConversationTransportAdapterInput {
  status: CodexConversationTransportStatus;
  binding: ConversationBindingState;
  reconciliation: ConversationReconciliationCapability;
  transportId?: string;
  evidenceRefs?: readonly string[];
}

function uniqueEvidenceRefs(refs: readonly string[]): string[] {
  return [...new Set(refs.filter((ref) => ref.trim().length > 0))];
}

export function observeCodexConversationTransport(
  input: CodexConversationTransportAdapterInput,
): ConversationTransportObservation {
  const availability = input.status.appServerTransport === "healthy"
    ? "available"
    : input.status.appServerTransport === "unavailable"
    ? "unavailable"
    : "unknown";
  const transportHealth = input.status.appServerTransport === "healthy"
    ? "healthy"
    : input.status.appServerTransport === "unavailable"
    ? "unavailable"
    : "unknown";
  const directInput = input.status.directInput === "available"
    ? "available"
    : input.status.directInput === "unavailable"
    ? "unavailable"
    : "unknown";

  return {
    transportId: input.transportId ?? "codex-app-server",
    targetKind: "codex_thread",
    kind: "native_rpc",
    availability,
    transportHealth,
    directInput,
    binding: input.binding,
    reconciliation: input.reconciliation,
    surfaceTrust: "official",
    sessionLifecycle: input.status.threadLifecycle,
    evidenceRefs: uniqueEvidenceRefs([
      `codex_gateway_observation:${input.status.observationKind}`,
      `codex_app_server_transport:${input.status.appServerTransport}`,
      `codex_direct_input:${input.status.directInput}`,
      ...(input.evidenceRefs ?? []),
    ]),
  };
}
