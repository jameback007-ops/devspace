import type {
  ConversationBindingState,
  ConversationDirectInputCapability,
  ConversationReconciliationCapability,
  ConversationSurfaceTrust,
  ConversationTargetKind,
  ConversationTransportAvailability,
  ConversationTransportHealth,
  ConversationTransportObservation,
} from "./conversation-transport-routing.js";

export type ChatGptDesktopConversationTarget = Extract<
  ConversationTargetKind,
  "chatgpt_chat" | "chatgpt_work"
>;

export interface ChatGptDesktopNativeProbeEvidence {
  desktopShellPresent: boolean;
  codexAppServerChildPresent: boolean;
  codexIpcSocketPresent: boolean;
  chatWorkControlProtocolAttested: boolean;
  evidenceRefs?: readonly string[];
}

export interface ChatGptDesktopNativeControlAttestation {
  adapterId: string;
  targetKind: ChatGptDesktopConversationTarget;
  availability: ConversationTransportAvailability;
  transportHealth: ConversationTransportHealth;
  directInput: ConversationDirectInputCapability;
  binding: ConversationBindingState;
  reconciliation: ConversationReconciliationCapability;
  surfaceTrust: Extract<
    ConversationSurfaceTrust,
    "official" | "registered_extension"
  >;
  sessionLifecycle?: string;
  evidenceRefs: readonly string[];
}

function present(value: boolean): "present" | "absent" {
  return value ? "present" : "absent";
}

function uniqueEvidenceRefs(refs: readonly string[]): string[] {
  return [...new Set(refs.filter((ref) => ref.trim().length > 0))];
}

function probeEvidenceRefs(
  probe: ChatGptDesktopNativeProbeEvidence,
): string[] {
  return uniqueEvidenceRefs([
    `desktop_shell:${present(probe.desktopShellPresent)}`,
    `codex_app_server_child:${present(probe.codexAppServerChildPresent)}`,
    `codex_ipc_socket:${present(probe.codexIpcSocketPresent)}`,
    `chat_work_control_protocol_attested:${present(
      probe.chatWorkControlProtocolAttested,
    )}`,
    ...(probe.evidenceRefs ?? []),
  ]);
}

function unavailableObservation(
  targetKind: ChatGptDesktopConversationTarget,
  probe: ChatGptDesktopNativeProbeEvidence,
  reason: string,
): ConversationTransportObservation {
  return {
    transportId: `chatgpt-desktop-native-unattested:${targetKind}`,
    targetKind,
    kind: "native_rpc",
    availability: "unavailable",
    transportHealth: "unknown",
    directInput: "unknown",
    binding: "unknown",
    reconciliation: "unavailable",
    surfaceTrust: "none",
    sessionLifecycle: "not_observed",
    evidenceRefs: uniqueEvidenceRefs([
      ...probeEvidenceRefs(probe),
      reason,
    ]),
  };
}

export function observeChatGptDesktopNativeTransport(
  targetKind: ChatGptDesktopConversationTarget,
  probe: ChatGptDesktopNativeProbeEvidence,
  attestation?: ChatGptDesktopNativeControlAttestation,
): ConversationTransportObservation {
  if (!probe.chatWorkControlProtocolAttested) {
    return unavailableObservation(
      targetKind,
      probe,
      "desktop_shell_does_not_attest_chat_work_control",
    );
  }

  if (attestation == null) {
    return unavailableObservation(
      targetKind,
      probe,
      "chat_work_control_attestation_missing",
    );
  }

  if (attestation.targetKind !== targetKind) {
    return unavailableObservation(
      targetKind,
      probe,
      "chat_work_control_attestation_target_mismatch",
    );
  }

  return {
    transportId: attestation.adapterId,
    targetKind,
    kind: "native_rpc",
    availability: attestation.availability,
    transportHealth: attestation.transportHealth,
    directInput: attestation.directInput,
    binding: attestation.binding,
    reconciliation: attestation.reconciliation,
    surfaceTrust: attestation.surfaceTrust,
    sessionLifecycle: attestation.sessionLifecycle ?? "not_observed",
    evidenceRefs: uniqueEvidenceRefs([
      ...probeEvidenceRefs(probe),
      ...attestation.evidenceRefs,
    ]),
  };
}
