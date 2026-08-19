import { createHash } from "node:crypto";

export const HOST_TURN_LIFECYCLE_AUTHORITY = {
  authority: "executor_local_host_turn_observation_only",
  canonicalTaskAuthority: false,
  canonicalDecisionAuthority: false,
  writerLeaseAuthority: false,
  canonicalEffectOutcomeAuthority: false,
  publicationAuthority: false,
  providerControlAuthority: false,
  browserControlAuthority: false,
  interactionOwnershipAuthority: false,
  terminalStateRequiresExplicitEdgeEvidence: true,
  completionInferredFromSilence: false,
  hungInferredFromSilence: false,
  mcpInactivityIsHostTurnEvidence: false,
  rawPromptCaptured: false,
  transcriptCaptured: false,
  privateReasoningCaptured: false,
} as const;

export const HOST_TURN_STATES = [
  "awaiting_input",
  "started",
  "running",
  "completed",
  "failed",
  "cancelled",
  "disconnected",
  "indeterminate",
] as const;

export type HostTurnState = typeof HOST_TURN_STATES[number];

export const HOST_TURN_WAKE_ELIGIBLE_STATES = [
  "awaiting_input",
  "completed",
  "failed",
  "cancelled",
] as const;

export type HostTurnWakeEligibleState =
  typeof HOST_TURN_WAKE_ELIGIBLE_STATES[number];

export type HostTurnEvidenceSource =
  | "conversation_transport"
  | "provider_adapter"
  | "browser_supervisor"
  | "interaction_broker"
  | "human_reconciliation";

export type HostTurnEvidenceConfidence =
  | "attested"
  | "verified"
  | "corroborated"
  | "advisory";

export type HostTurnEventKind =
  | "awaiting_input_observed"
  | "turn_started"
  | "turn_running"
  | "turn_completed"
  | "turn_failed"
  | "turn_cancelled"
  | "transport_disconnected"
  | "state_indeterminate"
  | "reconciled_running"
  | "reconciled_cancelled"
  | "reconciled_completed"
  | "corroborating_evidence";

export interface HostTurnExecutionScopeLineageEntry {
  executionScopeRef: string;
  enteredAt: string;
  mode: "initial" | "handoff";
  handoffRef?: string;
  authorityReadbackRefs: string[];
}

export interface HostTurnSessionRecord {
  schemaVersion: 1;
  sessionRef: string;
  logicalSessionRef: string;
  targetExecutionScopeRef: string;
  missionRef: string;
  currentExecutionScopeRef: string;
  executionScopeLineage: HostTurnExecutionScopeLineageEntry[];
  conversationBindingRef: string;
  conversationBindingGeneration: number;
  targetKind: string;
  targetRefDigestSha256: string;
  currentHostTurnRef?: string;
  currentHostTurnGeneration: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
  authority: typeof HOST_TURN_LIFECYCLE_AUTHORITY;
}

export interface HostTurnTerminationEvidence {
  state: HostTurnWakeEligibleState;
  causeCode: string;
  confidence: Exclude<HostTurnEvidenceConfidence, "advisory">;
  evidenceRef: string;
  observedAt: string;
}

export interface HostTurnRecord {
  schemaVersion: 1;
  hostTurnRef: string;
  sessionRef: string;
  generation: number;
  targetExecutionScopeRef: string;
  missionRef: string;
  workCycleRef?: string;
  correlationRef?: string;
  pendingWorkRef?: string;
  wakePermitRef?: string;
  conversationBindingRef: string;
  conversationBindingGeneration: number;
  targetKind: string;
  providerAdapterId: string;
  providerSessionRef?: string;
  providerTurnRef?: string;
  parentProviderTurnRef?: string;
  generationBoundaryRef: string;
  state: HostTurnState;
  revision: number;
  latestEventSequence: number;
  latestEventRef: string;
  latestEvidenceAt: string;
  latestEvidenceExpiresAt: string;
  evidenceRefs: string[];
  authorityReadbackRefs: string[];
  effectReadbackRefs: string[];
  reasonCodes: string[];
  termination?: HostTurnTerminationEvidence;
  createdAt: string;
  startedAt?: string;
  updatedAt: string;
  endedAt?: string;
  authority: typeof HOST_TURN_LIFECYCLE_AUTHORITY;
}

export interface HostTurnEventRecord {
  schemaVersion: 1;
  eventRef: string;
  hostTurnRef: string;
  sessionRef: string;
  sequence: number;
  observerExecutionScopeRef: string;
  kind: HostTurnEventKind;
  source: HostTurnEvidenceSource;
  confidence: HostTurnEvidenceConfidence;
  fromState?: HostTurnState;
  toState: HostTurnState;
  evidenceRefs: string[];
  evidenceDigestSha256: string;
  authorityReadbackRefs: string[];
  effectReadbackRefs: string[];
  reasonCodes: string[];
  observedAt: string;
  evidenceExpiresAt: string;
  recordedAt: string;
  authority: typeof HOST_TURN_LIFECYCLE_AUTHORITY;
}

export type HostTurnWakeGateDecision =
  | "ALLOW_AWAITING_INPUT"
  | "ALLOW_TERMINAL_TURN"
  | "HOLD_NO_SESSION"
  | "HOLD_NO_EXPLICIT_TURN_STATE"
  | "HOLD_ACTIVE_TURN"
  | "HOLD_DISCONNECTED_TURN"
  | "HOLD_INDETERMINATE_TURN"
  | "HOLD_BINDING_MISMATCH"
  | "HOLD_STALE_EVIDENCE";

/**
 * Immutable permit snapshot produced by the host-turn observation plane.
 * The upper scheduler persists this object and the lower transport must
 * compare it with a fresh read before dispatch.
 */
export interface HostTurnWakeGateBinding {
  schemaVersion: 1;
  sessionRef: string;
  sessionRevision: number;
  targetExecutionScopeRef: string;
  missionRef: string;
  conversationBindingRef: string;
  conversationBindingGeneration: number;
  hostTurnRef: string;
  hostTurnGeneration: number;
  hostTurnRevision: number;
  state: HostTurnWakeEligibleState;
  stateDigestSha256: string;
  generationBoundaryRef: string;
  evidenceDigestSha256: string;
  evidenceRefs: string[];
  authorityReadbackRefs: string[];
  assessedAt: string;
  expiresAt: string;
  authority: typeof HOST_TURN_LIFECYCLE_AUTHORITY;
}

export interface HostTurnWakeGateAssessment {
  schemaVersion: 1;
  decision: HostTurnWakeGateDecision;
  wakeAllowed: boolean;
  targetExecutionScopeRef: string;
  missionRef: string;
  session?: HostTurnSessionRecord;
  hostTurn?: HostTurnRecord;
  binding?: HostTurnWakeGateBinding;
  evidenceRefs: string[];
  authorityReadbackRefs: string[];
  reasonCodes: string[];
  assessedAt: string;
  authority: typeof HOST_TURN_LIFECYCLE_AUTHORITY;
}

export interface HostTurnLifecycleStatus {
  schemaVersion: 1;
  generatedAt: string;
  targetExecutionScopeRef: string;
  missionRef: string;
  session?: HostTurnSessionRecord;
  currentTurn?: HostTurnRecord;
  recentEvents: HostTurnEventRecord[];
  wakeGate: HostTurnWakeGateAssessment;
  authority: typeof HOST_TURN_LIFECYCLE_AUTHORITY;
}

export interface HostTurnObservation {
  observerExecutionScopeRef: string;
  targetExecutionScopeRef: string;
  missionRef: string;
  conversationBindingRef: string;
  conversationBindingGeneration: number;
  targetKind: string;
  targetRefDigestSha256: string;
  eventKind: HostTurnEventKind;
  state: HostTurnState;
  source: HostTurnEvidenceSource;
  confidence: HostTurnEvidenceConfidence;
  providerAdapterId: string;
  providerSessionRef?: string;
  providerTurnRef?: string;
  parentProviderTurnRef?: string;
  generationBoundaryRef: string;
  workCycleRef?: string;
  correlationRef?: string;
  pendingWorkRef?: string;
  wakePermitRef?: string;
  evidenceRefs: string[];
  authorityReadbackRefs: string[];
  effectReadbackRefs: string[];
  reasonCodes: string[];
  observedAt: string;
  evidenceExpiresAt: string;
  terminationCauseCode?: string;
}

const ACTIVE_TRANSITIONS: Record<HostTurnState, ReadonlySet<HostTurnState>> = {
  awaiting_input: new Set(["awaiting_input"]),
  started: new Set([
    "started",
    "running",
    "awaiting_input",
    "completed",
    "failed",
    "cancelled",
    "disconnected",
    "indeterminate",
  ]),
  running: new Set([
    "running",
    "awaiting_input",
    "completed",
    "failed",
    "cancelled",
    "disconnected",
    "indeterminate",
  ]),
  disconnected: new Set([
    "disconnected",
    "running",
    "awaiting_input",
    "completed",
    "failed",
    "cancelled",
    "indeterminate",
  ]),
  indeterminate: new Set([
    "indeterminate",
    "running",
    "completed",
    "cancelled",
  ]),
  completed: new Set(["completed"]),
  failed: new Set(["failed"]),
  cancelled: new Set(["cancelled"]),
};

export function isHostTurnWakeEligible(
  state: HostTurnState,
): state is HostTurnWakeEligibleState {
  return (HOST_TURN_WAKE_ELIGIBLE_STATES as readonly string[]).includes(state);
}

export function isHostTurnActive(state: HostTurnState): boolean {
  return state === "started" || state === "running";
}

export function assertHostTurnTransition(input: {
  current?: HostTurnRecord;
  eventKind: HostTurnEventKind;
  source: HostTurnEvidenceSource;
  confidence: HostTurnEvidenceConfidence;
  toState: HostTurnState;
  evidenceRefs: string[];
  authorityReadbackRefs: string[];
  effectReadbackRefs: string[];
  terminationCauseCode?: string;
}): void {
  if (input.evidenceRefs.length === 0) {
    throw new Error("Host-turn observations require explicit evidence references.");
  }
  if (input.authorityReadbackRefs.length === 0) {
    throw new Error("Host-turn observations require authority readback references.");
  }
  if (input.confidence === "advisory" && isHostTurnWakeEligible(input.toState)) {
    throw new Error("Advisory evidence cannot create a wake-eligible host-turn state.");
  }

  const expected = stateForEvent(input.eventKind);
  if (expected !== undefined && expected !== input.toState) {
    throw new Error(
      `Host-turn event ${input.eventKind} requires ${expected}, received ${input.toState}.`,
    );
  }
  if (input.eventKind === "corroborating_evidence") {
    if (!input.current || input.current.state !== input.toState) {
      throw new Error("Corroborating evidence must preserve the current host-turn state.");
    }
  }

  if (input.current) {
    if (!ACTIVE_TRANSITIONS[input.current.state].has(input.toState)) {
      throw new Error(
        `Invalid host-turn transition: ${input.current.state} -> ${input.toState}.`,
      );
    }
    if (input.current.state === "indeterminate"
      && input.toState !== "indeterminate") {
      const reconciliation = input.eventKind.startsWith("reconciled_");
      if (!reconciliation || input.source !== "human_reconciliation") {
        throw new Error(
          "Leaving an indeterminate host turn requires explicit human reconciliation.",
        );
      }
      if (input.effectReadbackRefs.length === 0) {
        throw new Error(
          "Indeterminate host-turn reconciliation requires effect readback references.",
        );
      }
    }
  }

  if (input.toState === "indeterminate"
    && input.eventKind !== "state_indeterminate") {
    throw new Error("An indeterminate host turn requires state_indeterminate evidence.");
  }
  if (input.toState === "disconnected"
    && input.eventKind !== "transport_disconnected") {
    throw new Error("A disconnected host turn requires transport_disconnected evidence.");
  }
  if (isHostTurnWakeEligible(input.toState)) {
    if (!input.terminationCauseCode?.trim()) {
      throw new Error("Wake-eligible host-turn states require a termination cause code.");
    }
    if (input.source === "human_reconciliation"
      && !input.eventKind.startsWith("reconciled_")) {
      throw new Error("Human reconciliation must use a reconciled_* host-turn event.");
    }
  }
}

export function hostTurnStateDigest(input: {
  session: HostTurnSessionRecord;
  turn: HostTurnRecord;
}): string {
  return sha256(canonicalJson({
    sessionRef: input.session.sessionRef,
    sessionRevision: input.session.revision,
    targetExecutionScopeRef: input.session.targetExecutionScopeRef,
    missionRef: input.session.missionRef,
    conversationBindingRef: input.session.conversationBindingRef,
    conversationBindingGeneration: input.session.conversationBindingGeneration,
    hostTurnRef: input.turn.hostTurnRef,
    hostTurnGeneration: input.turn.generation,
    hostTurnRevision: input.turn.revision,
    state: input.turn.state,
    generationBoundaryRef: input.turn.generationBoundaryRef,
    latestEvidenceAt: input.turn.latestEvidenceAt,
    latestEvidenceExpiresAt: input.turn.latestEvidenceExpiresAt,
    evidenceRefs: uniqueSorted(input.turn.evidenceRefs),
    authorityReadbackRefs: uniqueSorted(input.turn.authorityReadbackRefs),
  }));
}

export function hostTurnEvidenceDigest(input: {
  hostTurnRef: string;
  sequence: number;
  kind: HostTurnEventKind;
  source: HostTurnEvidenceSource;
  confidence: HostTurnEvidenceConfidence;
  fromState?: HostTurnState;
  toState: HostTurnState;
  evidenceRefs: string[];
  authorityReadbackRefs: string[];
  effectReadbackRefs: string[];
  reasonCodes: string[];
  observedAt: string;
  evidenceExpiresAt: string;
}): string {
  return sha256(canonicalJson({
    ...input,
    evidenceRefs: uniqueSorted(input.evidenceRefs),
    authorityReadbackRefs: uniqueSorted(input.authorityReadbackRefs),
    effectReadbackRefs: uniqueSorted(input.effectReadbackRefs),
    reasonCodes: uniqueSorted(input.reasonCodes),
  }));
}

export function canonicalHostTurnJson(value: unknown): string {
  return canonicalJson(value);
}

export function hostTurnSha256(value: string): string {
  return sha256(value);
}

export function uniqueHostTurnRefs(values: string[]): string[] {
  return uniqueSorted(values);
}

function stateForEvent(eventKind: HostTurnEventKind): HostTurnState | undefined {
  const mapping: Partial<Record<HostTurnEventKind, HostTurnState>> = {
    awaiting_input_observed: "awaiting_input",
    turn_started: "started",
    turn_running: "running",
    turn_completed: "completed",
    turn_failed: "failed",
    turn_cancelled: "cancelled",
    transport_disconnected: "disconnected",
    state_indeterminate: "indeterminate",
    reconciled_running: "running",
    reconciled_cancelled: "cancelled",
    reconciled_completed: "completed",
  };
  return mapping[eventKind];
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}
