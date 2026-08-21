import assert from "node:assert/strict";
import {
  routeConversationTransport,
  STRICT_CONVERSATION_TRANSPORT_POLICY,
  type ConversationTransportObservation,
} from "./conversation-transport-routing.js";
import {
  observeCodexConversationTransport,
  type CodexConversationTransportStatus,
} from "./codex-conversation-transport-adapter.js";
import { observeChatGptDesktopNativeTransport } from "./chatgpt-desktop-conversation-adapter.js";

function transport(
  overrides: Partial<ConversationTransportObservation> = {},
): ConversationTransportObservation {
  return {
    transportId: "transport-a",
    targetKind: "chatgpt_chat",
    kind: "native_rpc",
    availability: "available",
    transportHealth: "healthy",
    directInput: "available",
    binding: "exact",
    reconciliation: "available",
    surfaceTrust: "official",
    sessionLifecycle: "idle",
    evidenceRefs: ["test:evidence"],
    ...overrides,
  };
}

const recoverableSystemError: CodexConversationTransportStatus = {
  observationKind: "codex_session_read",
  appServerTransport: "healthy",
  threadLifecycle: "systemError",
  directInput: "available",
};

const codex = observeCodexConversationTransport({
  status: recoverableSystemError,
  binding: "exact",
  reconciliation: "available",
});
const codexRoute = routeConversationTransport({
  targetKind: "codex_thread",
  transports: [codex],
});
assert.equal(codexRoute.state, "selected");
assert.equal(codexRoute.state === "selected" && codexRoute.selected.transportId,
  "codex-app-server");
assert.equal(codex.sessionLifecycle, "systemError");
assert.equal(codex.transportHealth, "healthy");

const unavailableCodex = observeCodexConversationTransport({
  status: {
    ...recoverableSystemError,
    appServerTransport: "unavailable",
    threadLifecycle: "idle",
  },
  binding: "exact",
  reconciliation: "available",
});
const unavailableCodexRoute = routeConversationTransport({
  targetKind: "codex_thread",
  transports: [unavailableCodex],
});
assert.equal(unavailableCodexRoute.state, "blocked");
assert.equal(
  unavailableCodexRoute.considered[0]?.reasons.includes("transport_unavailable"),
  true,
);

const desktopProbe = {
  desktopShellPresent: true,
  codexAppServerChildPresent: true,
  codexIpcSocketPresent: true,
  chatWorkControlProtocolAttested: false,
  evidenceRefs: ["host_probe:read_only"],
} as const;
const unattestedChat = observeChatGptDesktopNativeTransport(
  "chatgpt_chat",
  desktopProbe,
);
assert.equal(unattestedChat.availability, "unavailable");
assert.equal(unattestedChat.surfaceTrust, "none");
assert.equal(
  unattestedChat.evidenceRefs.includes(
    "desktop_shell_does_not_attest_chat_work_control",
  ),
  true,
);

const undocumentedNative = transport({
  transportId: "private-endpoint-replay",
  surfaceTrust: "undocumented",
});
const undocumentedRoute = routeConversationTransport({
  targetKind: "chatgpt_chat",
  transports: [undocumentedNative],
});
assert.equal(undocumentedRoute.state, "blocked");
assert.equal(
  undocumentedRoute.considered[0]?.reasons.includes("untrusted_native_surface"),
  true,
);

const ui = transport({
  transportId: "web-ui-contract",
  kind: "web_ui",
  surfaceTrust: "ui_contract",
});
const localAgent = transport({
  transportId: "local-agent",
  kind: "local_agent",
  surfaceTrust: "registered_extension",
});
const localBeforeUi = routeConversationTransport({
  targetKind: "chatgpt_chat",
  transports: [ui, localAgent],
});
assert.equal(localBeforeUi.state, "selected");
assert.equal(
  localBeforeUi.state === "selected" && localBeforeUi.selected.transportId,
  "local-agent",
);

const uiOnly = routeConversationTransport({
  targetKind: "chatgpt_chat",
  transports: [ui],
});
assert.equal(uiOnly.state, "selected");
const uiDisallowed = routeConversationTransport({
  targetKind: "chatgpt_chat",
  transports: [ui],
  policy: {
    ...STRICT_CONVERSATION_TRANSPORT_POLICY,
    allowUiFallback: false,
  },
});
assert.equal(uiDisallowed.state, "blocked");
assert.equal(
  uiDisallowed.considered[0]?.reasons.includes("ui_fallback_disallowed"),
  true,
);

const undocumentedUi = routeConversationTransport({
  targetKind: "chatgpt_chat",
  transports: [ui, transport({
    transportId: "undocumented-ui",
    kind: "web_ui",
    surfaceTrust: "undocumented",
  })],
  policy: {
    ...STRICT_CONVERSATION_TRANSPORT_POLICY,
    requireTrustedNativeSurface: false,
  },
});
assert.equal(undocumentedUi.state, "selected");
assert.equal(
  undocumentedUi.considered.find((candidate) =>
    candidate.observation.transportId === "undocumented-ui"
  )?.reasons.includes("untrusted_ui_surface"),
  true,
);

for (const deliveryState of ["staged", "accepted", "indeterminate"] as const) {
  const blockedFallback = routeConversationTransport({
    targetKind: "chatgpt_chat",
    transports: [ui],
    previousDeliveryState: deliveryState,
  });
  assert.equal(blockedFallback.state, "blocked");
  assert.equal(
    blockedFallback.state === "blocked" && blockedFallback.code,
    "unreconciled_previous_delivery",
  );
}

const mismatchedBinding = routeConversationTransport({
  targetKind: "chatgpt_chat",
  transports: [transport({ binding: "mismatch" })],
});
assert.equal(mismatchedBinding.state, "blocked");
assert.equal(
  mismatchedBinding.considered[0]?.reasons.includes("binding_mismatch"),
  true,
);

const deterministicNative = routeConversationTransport({
  targetKind: "chatgpt_chat",
  transports: [
    transport({ transportId: "native-z" }),
    transport({ transportId: "native-a" }),
  ],
});
assert.equal(deterministicNative.state, "selected");
assert.equal(
  deterministicNative.state === "selected"
    && deterministicNative.selected.transportId,
  "native-a",
);

const duplicateIdentity = routeConversationTransport({
  targetKind: "chatgpt_chat",
  transports: [
    transport({ transportId: "duplicate" }),
    transport({ transportId: "duplicate", kind: "local_agent" }),
  ],
});
assert.equal(duplicateIdentity.state, "blocked");
assert.equal(
  duplicateIdentity.considered.every((candidate) =>
    candidate.reasons.includes("duplicate_transport_id")
  ),
  true,
);

const attestedProbe = {
  ...desktopProbe,
  chatWorkControlProtocolAttested: true,
} as const;
const attestedWork = observeChatGptDesktopNativeTransport(
  "chatgpt_work",
  attestedProbe,
  {
    adapterId: "future-supported-chat-work-adapter",
    targetKind: "chatgpt_work",
    availability: "available",
    transportHealth: "healthy",
    directInput: "available",
    binding: "exact",
    reconciliation: "available",
    surfaceTrust: "official",
    evidenceRefs: ["attestation:current"],
  },
);
const attestedWorkRoute = routeConversationTransport({
  targetKind: "chatgpt_work",
  transports: [attestedWork, transport({
    transportId: "work-ui",
    targetKind: "chatgpt_work",
    kind: "web_ui",
    surfaceTrust: "ui_contract",
  })],
});
assert.equal(attestedWorkRoute.state, "selected");
assert.equal(
  attestedWorkRoute.state === "selected"
    && attestedWorkRoute.selected.transportId,
  "future-supported-chat-work-adapter",
);

console.log("conversation transport routing tests passed");
