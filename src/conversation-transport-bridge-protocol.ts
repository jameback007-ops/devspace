import {
  canonicalJson,
  sha256,
} from "./execution-wake-coordination-model.js";
import type {
  ConversationTargetKind,
  ConversationTransportObservation,
} from "./conversation-transport-routing.js";

export const CONVERSATION_TRANSPORT_BRIDGE_AUTHORITY = {
  authority: "bounded_privileged_conversation_transport_bridge",
  canonicalTaskAuthority: false,
  canonicalDecisionAuthority: false,
  writerLeaseAuthority: false,
  publicationAuthority: false,
  arbitraryThreadIdAccepted: false,
  arbitrarySocketPathAccepted: false,
  rawConversationUrlPersisted: false,
  rawPromptPersisted: false,
  reconcileBeforeRetry: true,
  unknownFailsClosed: true,
} as const;

export type ConversationBridgeDeliveryState =
  | "no_effect"
  | "accepted"
  | "delivered"
  | "indeterminate";

export interface ConversationBridgeTargetStatus {
  schemaVersion: 1;
  targetAlias: string;
  targetKind: ConversationTargetKind;
  targetRefDigestSha256: string;
  bindingRef: string;
  bindingGeneration: number;
  candidates: ConversationTransportObservation[];
  observedAt: string;
  expiresAt: string;
  evidenceDigestSha256: string;
  evidenceRefs: string[];
  limitationCodes: string[];
  authority: typeof CONVERSATION_TRANSPORT_BRIDGE_AUTHORITY;
}

export interface ConversationBridgeDeliveryReceipt {
  schemaVersion: 1;
  targetAlias: string;
  targetKind: ConversationTargetKind;
  permitRef: string;
  transportId: string;
  transportKind: "native_rpc" | "web_ui";
  routeDigestSha256: string;
  messageId: string;
  promptDigestSha256: string;
  conversationUrlDigestSha256?: string;
  state: ConversationBridgeDeliveryState;
  deliveryRef: string;
  turnRef?: string;
  itemRef?: string;
  generationBoundaryRefAfter?: string;
  noEffectProofRef?: string;
  verificationRefs: string[];
  failureCode?: string;
  recordedAt: string;
  authority: typeof CONVERSATION_TRANSPORT_BRIDGE_AUTHORITY;
}

export type ConversationBridgeRequest =
  | {
      schemaVersion: 1;
      command: "status";
      targetAlias: string;
    }
  | {
      schemaVersion: 1;
      command: "deliver";
      targetAlias: string;
      targetRefDigestSha256: string;
      bindingRef: string;
      bindingGeneration: number;
      permitRef: string;
      transportId: string;
      transportKind: "native_rpc" | "web_ui";
      routeDigestSha256: string;
      messageId: string;
      prompt: string;
      promptDigestSha256: string;
      conversationUrlDigestSha256?: string;
    }
  | {
      schemaVersion: 1;
      command: "reconcile";
      targetAlias: string;
      targetRefDigestSha256: string;
      bindingRef: string;
      bindingGeneration: number;
      permitRef: string;
      transportId: string;
      transportKind: "native_rpc" | "web_ui";
      routeDigestSha256: string;
      messageId: string;
      promptDigestSha256: string;
      conversationUrlDigestSha256?: string;
    };

export type ConversationBridgeResponse =
  | {
      schemaVersion: 1;
      ok: true;
      command: "status";
      status: ConversationBridgeTargetStatus;
    }
  | {
      schemaVersion: 1;
      ok: true;
      command: "deliver" | "reconcile";
      receipt: ConversationBridgeDeliveryReceipt;
    }
  | {
      schemaVersion: 1;
      ok: false;
      command?: string;
      errorCode: string;
      errorDigestSha256: string;
      retryDisposition: "forbidden" | "reconcile_first" | "safe_after_correction";
    };

export function conversationRouteDigest(input: {
  targetAlias: string;
  targetKind: ConversationTargetKind;
  targetRefDigestSha256: string;
  bindingRef: string;
  bindingGeneration: number;
  transportId: string;
  transportKind: string;
  conversationUrlDigestSha256?: string;
  evidenceDigestSha256: string;
}): string {
  return sha256(canonicalJson(input));
}

export function deterministicConversationMessageId(input: {
  permitRef: string;
  targetAlias: string;
  transportId: string;
  promptDigestSha256: string;
}): string {
  return `zes_${sha256(canonicalJson(input)).slice(0, 48)}`;
}
