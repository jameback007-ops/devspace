import { randomUUID } from "node:crypto";
import {
  openDatabase,
  type DatabaseHandle,
} from "./db/client.js";
import {
  HOST_TURN_LIFECYCLE_AUTHORITY,
  assertHostTurnTransition,
  canonicalHostTurnJson,
  hostTurnEvidenceDigest,
  hostTurnSha256,
  hostTurnStateDigest,
  isHostTurnActive,
  isHostTurnWakeEligible,
  uniqueHostTurnRefs,
  type HostTurnEventKind,
  type HostTurnEventRecord,
  type HostTurnEvidenceConfidence,
  type HostTurnEvidenceSource,
  type HostTurnLifecycleStatus,
  type HostTurnObservation,
  type HostTurnRecord,
  type HostTurnSessionRecord,
  type HostTurnState,
  type HostTurnTerminationEvidence,
  type HostTurnWakeGateAssessment,
  type HostTurnWakeGateBinding,
} from "./host-turn-lifecycle-model.js";
import {
  SqliteHostTurnLifecycleStore,
  assertHostTurnLifecycleSchema,
  installHostTurnLifecycleSchema,
  type HostTurnLifecycleRetention,
} from "./host-turn-lifecycle-store.js";

export interface HostTurnLifecycleConfig {
  enabled: boolean;
  maximumObservationTtlMs: number;
  terminalTurnRetentionMs: number;
  eventRetentionMs: number;
  commandRetentionMs: number;
  cleanupIntervalMs: number;
  maxReferenceCharacters: number;
  maxReferencesPerField: number;
}

export const DEFAULT_HOST_TURN_LIFECYCLE_CONFIG: HostTurnLifecycleConfig = {
  enabled: true,
  maximumObservationTtlMs: 10 * 60 * 1_000,
  terminalTurnRetentionMs: 30 * 24 * 60 * 60 * 1_000,
  eventRetentionMs: 30 * 24 * 60 * 60 * 1_000,
  commandRetentionMs: 30 * 24 * 60 * 60 * 1_000,
  cleanupIntervalMs: 60 * 1_000,
  maxReferenceCharacters: 2_000,
  maxReferencesPerField: 100,
};

type HostTurnIdPrefix = "hts" | "htr" | "hte";

export interface HostTurnLifecycleManagerOptions {
  now?: () => number;
  database?: DatabaseHandle;
  installSchema?: boolean;
  idFactory?: (prefix: HostTurnIdPrefix) => string;
}

export interface HostTurnBindingInput {
  targetExecutionScopeRef: string;
  missionRef: string;
  conversationBindingRef: string;
  conversationBindingGeneration: number;
  targetKind: string;
  targetRefDigestSha256: string;
  authorityReadbackRefs?: string[];
}

export interface HostTurnObservationInput
  extends Omit<HostTurnObservation, "observerExecutionScopeRef"> {
  idempotencyKey: string;
  observerExecutionScopeRef: string;
}

export interface HostTurnMutationResult<T> {
  value: T;
  idempotentReplay: boolean;
}

export interface HostTurnWakeDispatchInput {
  idempotencyKey: string;
  observerExecutionScopeRef: string;
  gate: HostTurnWakeGateBinding;
  targetExecutionScopeRef: string;
  missionRef: string;
  conversationBindingRef: string;
  conversationBindingGeneration: number;
  targetKind: string;
  targetRefDigestSha256: string;
  providerAdapterId: string;
  providerSessionRef?: string;
  providerTurnRef?: string;
  generationBoundaryRef: string;
  workCycleRef?: string;
  correlationRef?: string;
  pendingWorkRef?: string;
  wakePermitRef: string;
  evidenceRefs: string[];
  authorityReadbackRefs: string[];
  effectReadbackRefs?: string[];
  observedAt: string;
  evidenceExpiresAt: string;
  indeterminateReasonCodes?: string[];
}

export interface HostTurnWakeReconciliationInput {
  idempotencyKey: string;
  observerExecutionScopeRef: string;
  targetExecutionScopeRef: string;
  missionRef: string;
  wakePermitRef: string;
  resolution: "effect_absent" | "effect_verified";
  generationBoundaryRef: string;
  providerTurnRef?: string;
  evidenceRefs: string[];
  authorityReadbackRefs: string[];
  effectReadbackRefs: string[];
  reasonCodes?: string[];
  observedAt: string;
  evidenceExpiresAt: string;
}

const SCOPE_REF_PATTERN = /^[a-f0-9]{16}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const IDEMPOTENCY_KEY_MAX = 200;

export class HostTurnLifecycleManager {
  private readonly now: () => number;
  private readonly database: DatabaseHandle;
  private readonly store: SqliteHostTurnLifecycleStore;
  private readonly ownsDatabase: boolean;
  private readonly idFactory: (prefix: HostTurnIdPrefix) => string;
  private lastCleanupAtMs = 0;
  private closed = false;

  constructor(
    readonly config: HostTurnLifecycleConfig,
    stateDir: string,
    options: HostTurnLifecycleManagerOptions = {},
  ) {
    validateConfig(config);
    this.now = options.now ?? Date.now;
    this.database = options.database ?? openDatabase(stateDir);
    this.ownsDatabase = options.database === undefined;
    try {
      if (options.installSchema === true) {
        installHostTurnLifecycleSchema(this.database.sqlite, this.now());
      }
      assertHostTurnLifecycleSchema(this.database.sqlite);
    } catch (error) {
      if (this.ownsDatabase) this.database.close();
      throw error;
    }
    this.store = new SqliteHostTurnLifecycleStore(this.database.sqlite);
    this.idFactory = options.idFactory ?? ((prefix) =>
      `${prefix}_${randomUUID().replaceAll("-", "")}`);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.ownsDatabase) this.database.close();
  }

  ensureBinding(input: HostTurnBindingInput): HostTurnSessionRecord {
    this.assertEnabled();
    const normalized = this.normalizeBinding(input);
    const nowMs = this.now();
    this.maybeCleanup(nowMs);
    const transaction = this.database.sqlite.transaction(() =>
      this.ensureBindingInternal(normalized, nowMs));
    return transaction.immediate();
  }

  observe(
    input: HostTurnObservationInput,
  ): HostTurnMutationResult<HostTurnRecord> {
    this.assertEnabled();
    const normalized = this.normalizeObservation(input);
    return this.mutate(
      normalized.observerExecutionScopeRef,
      input.idempotencyKey,
      "observe_host_turn",
      normalized,
      (nowMs) => {
        const session = this.ensureBindingInternal(normalized, nowMs);
        return this.observeInternal(session, normalized, nowMs);
      },
    );
  }

  wakeGate(
    targetExecutionScopeRef: string,
    missionRef: string,
    conversationBindingRef: string,
    conversationBindingGeneration: number,
  ): HostTurnWakeGateAssessment {
    this.assertEnabled();
    const target = requireScopeRef(targetExecutionScopeRef);
    const mission = this.reference(missionRef, "missionRef");
    const bindingRef = this.reference(conversationBindingRef, "conversationBindingRef");
    const bindingGeneration = positiveInteger(
      conversationBindingGeneration,
      "conversationBindingGeneration",
    );
    const nowMs = this.now();
    this.maybeCleanup(nowMs);
    return this.wakeGateInternal(
      target,
      mission,
      bindingRef,
      bindingGeneration,
      nowMs,
    );
  }

  assertGateCurrent(
    expected: HostTurnWakeGateBinding,
    input: HostTurnBindingInput,
  ): HostTurnWakeGateBinding {
    this.assertEnabled();
    const normalized = this.normalizeBinding(input);
    const gate = this.wakeGateInternal(
      normalized.targetExecutionScopeRef,
      normalized.missionRef,
      normalized.conversationBindingRef,
      normalized.conversationBindingGeneration,
      this.now(),
    );
    if (!gate.wakeAllowed || !gate.binding) {
      throw new Error(
        `Host-turn wake gate is no longer eligible: ${gate.reasonCodes.join(",") || gate.decision}.`,
      );
    }
    const current = gate.binding;
    const fields: Array<keyof HostTurnWakeGateBinding> = [
      "sessionRef",
      "sessionRevision",
      "targetExecutionScopeRef",
      "missionRef",
      "conversationBindingRef",
      "conversationBindingGeneration",
      "hostTurnRef",
      "hostTurnGeneration",
      "hostTurnRevision",
      "state",
      "stateDigestSha256",
      "generationBoundaryRef",
      "evidenceDigestSha256",
      "expiresAt",
    ];
    for (const field of fields) {
      if (current[field] !== expected[field]) {
        throw new Error(`Host-turn wake gate changed before dispatch: ${String(field)}.`);
      }
    }
    return current;
  }

  recordWakeDispatchStarted(
    input: HostTurnWakeDispatchInput,
  ): HostTurnMutationResult<HostTurnRecord> {
    return this.recordWakeDispatch(input, "started");
  }

  recordWakeDispatchIndeterminate(
    input: HostTurnWakeDispatchInput,
  ): HostTurnMutationResult<HostTurnRecord> {
    return this.recordWakeDispatch(input, "indeterminate");
  }

  reconcileWakeDispatch(
    input: HostTurnWakeReconciliationInput,
  ): HostTurnMutationResult<HostTurnRecord> {
    this.assertEnabled();
    const normalized = {
      idempotencyKey: requireIdempotencyKey(input.idempotencyKey),
      observerExecutionScopeRef: requireScopeRef(input.observerExecutionScopeRef),
      targetExecutionScopeRef: requireScopeRef(input.targetExecutionScopeRef),
      missionRef: this.reference(input.missionRef, "missionRef"),
      wakePermitRef: this.reference(input.wakePermitRef, "wakePermitRef"),
      resolution: input.resolution,
      generationBoundaryRef: this.reference(
        input.generationBoundaryRef,
        "generationBoundaryRef",
      ),
      providerTurnRef: this.optionalReference(input.providerTurnRef, "providerTurnRef"),
      evidenceRefs: this.references(input.evidenceRefs, "evidenceRefs"),
      authorityReadbackRefs: this.references(
        input.authorityReadbackRefs,
        "authorityReadbackRefs",
      ),
      effectReadbackRefs: this.references(
        input.effectReadbackRefs,
        "effectReadbackRefs",
      ),
      reasonCodes: this.references(input.reasonCodes ?? [], "reasonCodes"),
      observedAt: requireIso(input.observedAt, "observedAt"),
      evidenceExpiresAt: this.evidenceExpiry(
        input.observedAt,
        input.evidenceExpiresAt,
      ),
    };
    if (normalized.evidenceRefs.length === 0
      || normalized.authorityReadbackRefs.length === 0
      || normalized.effectReadbackRefs.length === 0) {
      throw new Error(
        "Host-turn wake reconciliation requires evidence, authority readback, and effect readback references.",
      );
    }
    if (!["effect_absent", "effect_verified"].includes(normalized.resolution)) {
      throw new Error("Invalid host-turn wake reconciliation resolution.");
    }
    return this.mutate(
      normalized.observerExecutionScopeRef,
      normalized.idempotencyKey,
      "reconcile_host_turn_wake",
      normalized,
      (nowMs) => {
        const turn = this.store.turnForPermit(normalized.wakePermitRef);
        if (!turn
          || turn.targetExecutionScopeRef !== normalized.targetExecutionScopeRef
          || turn.missionRef !== normalized.missionRef) {
          throw new Error("No host turn is bound to the reconciled wake permit.");
        }
        if (turn.state !== "indeterminate") {
          throw new Error("Only an indeterminate host turn may be reconciled.");
        }
        const session = this.requireSession(turn.sessionRef);
        const eventKind: HostTurnEventKind = normalized.resolution === "effect_verified"
          ? "reconciled_running"
          : "reconciled_cancelled";
        const state: HostTurnState = normalized.resolution === "effect_verified"
          ? "running"
          : "cancelled";
        return this.updateTurn(
          session,
          turn,
          {
            observerExecutionScopeRef: normalized.observerExecutionScopeRef,
            targetExecutionScopeRef: turn.targetExecutionScopeRef,
            missionRef: turn.missionRef,
            conversationBindingRef: turn.conversationBindingRef,
            conversationBindingGeneration: turn.conversationBindingGeneration,
            targetKind: turn.targetKind,
            targetRefDigestSha256: session.targetRefDigestSha256,
            eventKind,
            state,
            source: "human_reconciliation",
            confidence: "verified",
            providerAdapterId: turn.providerAdapterId,
            providerSessionRef: turn.providerSessionRef,
            providerTurnRef: normalized.providerTurnRef ?? turn.providerTurnRef,
            parentProviderTurnRef: turn.parentProviderTurnRef,
            generationBoundaryRef: normalized.generationBoundaryRef,
            workCycleRef: turn.workCycleRef,
            correlationRef: turn.correlationRef,
            pendingWorkRef: turn.pendingWorkRef,
            wakePermitRef: turn.wakePermitRef,
            evidenceRefs: normalized.evidenceRefs,
            authorityReadbackRefs: normalized.authorityReadbackRefs,
            effectReadbackRefs: normalized.effectReadbackRefs,
            reasonCodes: normalized.reasonCodes,
            observedAt: normalized.observedAt,
            evidenceExpiresAt: normalized.evidenceExpiresAt,
            terminationCauseCode: normalized.resolution === "effect_absent"
              ? "wake_effect_absent"
              : undefined,
          },
          nowMs,
        );
      },
    );
  }

  status(
    targetExecutionScopeRef: string,
    missionRef: string,
    conversationBindingRef?: string,
    conversationBindingGeneration?: number,
  ): HostTurnLifecycleStatus {
    this.assertEnabled();
    const target = requireScopeRef(targetExecutionScopeRef);
    const mission = this.reference(missionRef, "missionRef");
    const session = this.store.sessionForTarget(target, mission);
    const currentTurn = session?.currentHostTurnRef
      ? this.store.turn(session.currentHostTurnRef)
      : undefined;
    const bindingRef = conversationBindingRef
      ?? session?.conversationBindingRef
      ?? "missing-binding";
    const bindingGeneration = conversationBindingGeneration
      ?? session?.conversationBindingGeneration
      ?? 1;
    const wakeGate = this.wakeGateInternal(
      target,
      mission,
      bindingRef,
      bindingGeneration,
      this.now(),
    );
    return {
      schemaVersion: 1,
      generatedAt: iso(this.now()),
      targetExecutionScopeRef: target,
      missionRef: mission,
      session,
      currentTurn,
      recentEvents: currentTurn ? this.store.events(currentTurn.hostTurnRef, 50) : [],
      wakeGate,
      authority: HOST_TURN_LIFECYCLE_AUTHORITY,
    };
  }

  private recordWakeDispatch(
    input: HostTurnWakeDispatchInput,
    state: "started" | "indeterminate",
  ): HostTurnMutationResult<HostTurnRecord> {
    this.assertEnabled();
    const normalized = {
      idempotencyKey: requireIdempotencyKey(input.idempotencyKey),
      observerExecutionScopeRef: requireScopeRef(input.observerExecutionScopeRef),
      gate: input.gate,
      targetExecutionScopeRef: requireScopeRef(input.targetExecutionScopeRef),
      missionRef: this.reference(input.missionRef, "missionRef"),
      conversationBindingRef: this.reference(
        input.conversationBindingRef,
        "conversationBindingRef",
      ),
      conversationBindingGeneration: positiveInteger(
        input.conversationBindingGeneration,
        "conversationBindingGeneration",
      ),
      targetKind: this.reference(input.targetKind, "targetKind"),
      targetRefDigestSha256: requireSha256(
        input.targetRefDigestSha256,
        "targetRefDigestSha256",
      ),
      providerAdapterId: this.reference(input.providerAdapterId, "providerAdapterId"),
      providerSessionRef: this.optionalReference(input.providerSessionRef, "providerSessionRef"),
      providerTurnRef: this.optionalReference(input.providerTurnRef, "providerTurnRef"),
      generationBoundaryRef: this.reference(
        input.generationBoundaryRef,
        "generationBoundaryRef",
      ),
      workCycleRef: this.optionalReference(input.workCycleRef, "workCycleRef"),
      correlationRef: this.optionalReference(input.correlationRef, "correlationRef"),
      pendingWorkRef: this.optionalReference(input.pendingWorkRef, "pendingWorkRef"),
      wakePermitRef: this.reference(input.wakePermitRef, "wakePermitRef"),
      evidenceRefs: this.references(input.evidenceRefs, "evidenceRefs"),
      authorityReadbackRefs: this.references(
        input.authorityReadbackRefs,
        "authorityReadbackRefs",
      ),
      effectReadbackRefs: this.references(
        input.effectReadbackRefs ?? [],
        "effectReadbackRefs",
      ),
      observedAt: requireIso(input.observedAt, "observedAt"),
      evidenceExpiresAt: this.evidenceExpiry(
        input.observedAt,
        input.evidenceExpiresAt,
      ),
      reasonCodes: this.references(
        input.indeterminateReasonCodes ?? [],
        "indeterminateReasonCodes",
      ),
      state,
    };
    if (normalized.evidenceRefs.length === 0
      || normalized.authorityReadbackRefs.length === 0) {
      throw new Error("Wake dispatch host-turn records require evidence and authority refs.");
    }
    return this.mutate(
      normalized.observerExecutionScopeRef,
      normalized.idempotencyKey,
      `record_wake_dispatch_${state}`,
      normalized,
      (nowMs) => {
        const session = this.ensureBindingInternal(normalized, nowMs);
        if (state === "started") {
          this.assertGateCurrent(normalized.gate, normalized);
        }
        return this.observeInternal(
          session,
          {
            observerExecutionScopeRef: normalized.observerExecutionScopeRef,
            targetExecutionScopeRef: normalized.targetExecutionScopeRef,
            missionRef: normalized.missionRef,
            conversationBindingRef: normalized.conversationBindingRef,
            conversationBindingGeneration: normalized.conversationBindingGeneration,
            targetKind: normalized.targetKind,
            targetRefDigestSha256: normalized.targetRefDigestSha256,
            eventKind: state === "started" ? "turn_started" : "state_indeterminate",
            state,
            source: "conversation_transport",
            confidence: state === "started" ? "verified" : "attested",
            providerAdapterId: normalized.providerAdapterId,
            providerSessionRef: normalized.providerSessionRef,
            providerTurnRef: normalized.providerTurnRef,
            generationBoundaryRef: normalized.generationBoundaryRef,
            workCycleRef: normalized.workCycleRef,
            correlationRef: normalized.correlationRef,
            pendingWorkRef: normalized.pendingWorkRef,
            wakePermitRef: normalized.wakePermitRef,
            evidenceRefs: normalized.evidenceRefs,
            authorityReadbackRefs: normalized.authorityReadbackRefs,
            effectReadbackRefs: normalized.effectReadbackRefs,
            reasonCodes: normalized.reasonCodes,
            observedAt: normalized.observedAt,
            evidenceExpiresAt: normalized.evidenceExpiresAt,
          },
          nowMs,
        );
      },
    );
  }

  private observeInternal(
    sessionInput: HostTurnSessionRecord,
    observation: HostTurnObservation,
    nowMs: number,
  ): HostTurnRecord {
    let session = this.requireSession(sessionInput.sessionRef);
    const current = session.currentHostTurnRef
      ? this.store.turn(session.currentHostTurnRef)
      : undefined;
    const startsNew = this.startsNewTurn(current, observation);
    if (startsNew) {
      if (current && !isHostTurnWakeEligible(current.state)) {
        throw new Error(
          `A new host turn cannot replace active state ${current.state} without reconciliation.`,
        );
      }
      assertHostTurnTransition({
        current: undefined,
        eventKind: observation.eventKind,
        source: observation.source,
        confidence: observation.confidence,
        toState: observation.state,
        evidenceRefs: observation.evidenceRefs,
        authorityReadbackRefs: observation.authorityReadbackRefs,
        effectReadbackRefs: observation.effectReadbackRefs,
        terminationCauseCode: observation.terminationCauseCode,
      });
      const turn = this.createTurn(session, observation, nowMs);
      this.store.insertTurn(turn, hostTurnSha256(canonicalHostTurnJson(turn)));
      this.appendEvent(undefined, turn, observation, nowMs);
      const nextSession: HostTurnSessionRecord = {
        ...session,
        currentHostTurnRef: turn.hostTurnRef,
        currentHostTurnGeneration: turn.generation,
        revision: session.revision + 1,
        updatedAt: iso(nowMs),
      };
      const sessionSave = this.store.compareAndSwapSession(
        nextSession,
        session.revision,
        hostTurnSha256(canonicalHostTurnJson(nextSession)),
      );
      if (!sessionSave.saved) throw revisionConflict("host-turn session", sessionSave.current);
      return turn;
    }
    if (!current) throw new Error("Host-turn session has no current turn.");
    return this.updateTurn(session, current, observation, nowMs);
  }

  private updateTurn(
    session: HostTurnSessionRecord,
    current: HostTurnRecord,
    observationInput: HostTurnObservation,
    nowMs: number,
  ): HostTurnRecord {
    let observation = observationInput;
    if (isHostTurnWakeEligible(current.state)
      && isHostTurnWakeEligible(observation.state)) {
      observation = {
        ...observation,
        eventKind: "corroborating_evidence",
        state: current.state,
        terminationCauseCode: current.termination?.causeCode
          ?? observation.terminationCauseCode,
      };
    }
    if (current.providerTurnRef
      && observation.providerTurnRef
      && current.providerTurnRef !== observation.providerTurnRef
      && !isHostTurnWakeEligible(current.state)) {
      throw new Error(
        "An active host turn cannot change providerTurnRef without reconciliation.",
      );
    }
    assertHostTurnTransition({
      current,
      eventKind: observation.eventKind,
      source: observation.source,
      confidence: observation.confidence,
      toState: observation.state,
      evidenceRefs: observation.evidenceRefs,
      authorityReadbackRefs: observation.authorityReadbackRefs,
      effectReadbackRefs: observation.effectReadbackRefs,
      terminationCauseCode: observation.terminationCauseCode,
    });
    const sequence = current.latestEventSequence + 1;
    const eventRef = this.idFactory("hte");
    const evidenceRefs = uniqueHostTurnRefs([
      ...current.evidenceRefs,
      ...observation.evidenceRefs,
    ]);
    const authorityReadbackRefs = uniqueHostTurnRefs([
      ...current.authorityReadbackRefs,
      ...observation.authorityReadbackRefs,
    ]);
    const effectReadbackRefs = uniqueHostTurnRefs([
      ...current.effectReadbackRefs,
      ...observation.effectReadbackRefs,
    ]);
    const reasonCodes = uniqueHostTurnRefs([
      ...current.reasonCodes,
      ...observation.reasonCodes,
    ]);
    const wakeEligible = isHostTurnWakeEligible(observation.state);
    const next: HostTurnRecord = {
      ...current,
      state: observation.state,
      revision: current.revision + 1,
      latestEventSequence: sequence,
      latestEventRef: eventRef,
      latestEvidenceAt: observation.observedAt,
      latestEvidenceExpiresAt: observation.evidenceExpiresAt,
      evidenceRefs,
      authorityReadbackRefs,
      effectReadbackRefs,
      reasonCodes,
      providerSessionRef: observation.providerSessionRef ?? current.providerSessionRef,
      providerTurnRef: observation.providerTurnRef ?? current.providerTurnRef,
      generationBoundaryRef: observation.generationBoundaryRef,
      workCycleRef: observation.workCycleRef ?? current.workCycleRef,
      correlationRef: observation.correlationRef ?? current.correlationRef,
      pendingWorkRef: observation.pendingWorkRef ?? current.pendingWorkRef,
      wakePermitRef: observation.wakePermitRef ?? current.wakePermitRef,
      termination: terminationEvidence(observation),
      updatedAt: iso(nowMs),
      endedAt: wakeEligible ? observation.observedAt : undefined,
    };
    const save = this.store.compareAndSwapTurn(
      next,
      current.revision,
      hostTurnSha256(canonicalHostTurnJson(next)),
    );
    if (!save.saved) throw revisionConflict("host turn", save.current);
    this.appendEvent(current, next, observation, nowMs, eventRef);
    return next;
  }

  private createTurn(
    session: HostTurnSessionRecord,
    observation: HostTurnObservation,
    nowMs: number,
  ): HostTurnRecord {
    const hostTurnRef = this.idFactory("htr");
    const eventRef = this.idFactory("hte");
    const wakeEligible = isHostTurnWakeEligible(observation.state);
    return {
      schemaVersion: 1,
      hostTurnRef,
      sessionRef: session.sessionRef,
      generation: session.currentHostTurnGeneration + 1,
      targetExecutionScopeRef: observation.targetExecutionScopeRef,
      missionRef: observation.missionRef,
      workCycleRef: observation.workCycleRef,
      correlationRef: observation.correlationRef,
      pendingWorkRef: observation.pendingWorkRef,
      wakePermitRef: observation.wakePermitRef,
      conversationBindingRef: observation.conversationBindingRef,
      conversationBindingGeneration: observation.conversationBindingGeneration,
      targetKind: observation.targetKind,
      providerAdapterId: observation.providerAdapterId,
      providerSessionRef: observation.providerSessionRef,
      providerTurnRef: observation.providerTurnRef,
      parentProviderTurnRef: observation.parentProviderTurnRef,
      generationBoundaryRef: observation.generationBoundaryRef,
      state: observation.state,
      revision: 1,
      latestEventSequence: 1,
      latestEventRef: eventRef,
      latestEvidenceAt: observation.observedAt,
      latestEvidenceExpiresAt: observation.evidenceExpiresAt,
      evidenceRefs: uniqueHostTurnRefs(observation.evidenceRefs),
      authorityReadbackRefs: uniqueHostTurnRefs(observation.authorityReadbackRefs),
      effectReadbackRefs: uniqueHostTurnRefs(observation.effectReadbackRefs),
      reasonCodes: uniqueHostTurnRefs(observation.reasonCodes),
      termination: terminationEvidence(observation),
      createdAt: iso(nowMs),
      startedAt: isHostTurnActive(observation.state)
        || observation.state === "disconnected"
        || observation.state === "indeterminate"
        ? observation.observedAt
        : undefined,
      updatedAt: iso(nowMs),
      endedAt: wakeEligible ? observation.observedAt : undefined,
      authority: HOST_TURN_LIFECYCLE_AUTHORITY,
    };
  }

  private appendEvent(
    previous: HostTurnRecord | undefined,
    turn: HostTurnRecord,
    observation: HostTurnObservation,
    nowMs: number,
    explicitEventRef?: string,
  ): void {
    const sequence = previous ? previous.latestEventSequence + 1 : 1;
    const eventRef = explicitEventRef ?? turn.latestEventRef;
    const evidenceDigestSha256 = hostTurnEvidenceDigest({
      hostTurnRef: turn.hostTurnRef,
      sequence,
      kind: observation.eventKind,
      source: observation.source,
      confidence: observation.confidence,
      fromState: previous?.state,
      toState: turn.state,
      evidenceRefs: observation.evidenceRefs,
      authorityReadbackRefs: observation.authorityReadbackRefs,
      effectReadbackRefs: observation.effectReadbackRefs,
      reasonCodes: observation.reasonCodes,
      observedAt: observation.observedAt,
      evidenceExpiresAt: observation.evidenceExpiresAt,
    });
    const event: HostTurnEventRecord = {
      schemaVersion: 1,
      eventRef,
      hostTurnRef: turn.hostTurnRef,
      sessionRef: turn.sessionRef,
      sequence,
      observerExecutionScopeRef: observation.observerExecutionScopeRef,
      kind: observation.eventKind,
      source: observation.source,
      confidence: observation.confidence,
      fromState: previous?.state,
      toState: turn.state,
      evidenceRefs: uniqueHostTurnRefs(observation.evidenceRefs),
      evidenceDigestSha256,
      authorityReadbackRefs: uniqueHostTurnRefs(observation.authorityReadbackRefs),
      effectReadbackRefs: uniqueHostTurnRefs(observation.effectReadbackRefs),
      reasonCodes: uniqueHostTurnRefs(observation.reasonCodes),
      observedAt: observation.observedAt,
      evidenceExpiresAt: observation.evidenceExpiresAt,
      recordedAt: iso(nowMs),
      authority: HOST_TURN_LIFECYCLE_AUTHORITY,
    };
    this.store.appendEvent(event);
  }

  private startsNewTurn(
    current: HostTurnRecord | undefined,
    observation: HostTurnObservation,
  ): boolean {
    if (!current) return true;
    if (current.conversationBindingRef !== observation.conversationBindingRef
      || current.conversationBindingGeneration
        !== observation.conversationBindingGeneration) {
      return true;
    }
    if (isHostTurnWakeEligible(current.state)) {
      return !isHostTurnWakeEligible(observation.state);
    }
    return false;
  }

  private wakeGateInternal(
    targetExecutionScopeRef: string,
    missionRef: string,
    conversationBindingRef: string,
    conversationBindingGeneration: number,
    nowMs: number,
  ): HostTurnWakeGateAssessment {
    const assessedAt = iso(nowMs);
    const session = this.store.sessionForTarget(targetExecutionScopeRef, missionRef);
    if (!session) {
      return gateAssessment(
        "HOLD_NO_SESSION",
        targetExecutionScopeRef,
        missionRef,
        assessedAt,
        ["HOST_TURN_SESSION_NOT_RECORDED"],
      );
    }
    if (session.conversationBindingRef !== conversationBindingRef
      || session.conversationBindingGeneration !== conversationBindingGeneration) {
      return gateAssessment(
        "HOLD_BINDING_MISMATCH",
        targetExecutionScopeRef,
        missionRef,
        assessedAt,
        ["HOST_TURN_SESSION_BINDING_MISMATCH"],
        session,
      );
    }
    const turn = session.currentHostTurnRef
      ? this.store.turn(session.currentHostTurnRef)
      : undefined;
    if (!turn) {
      return gateAssessment(
        "HOLD_NO_EXPLICIT_TURN_STATE",
        targetExecutionScopeRef,
        missionRef,
        assessedAt,
        ["HOST_TURN_EXPLICIT_STATE_NOT_RECORDED"],
        session,
      );
    }
    if (turn.conversationBindingRef !== conversationBindingRef
      || turn.conversationBindingGeneration !== conversationBindingGeneration) {
      return gateAssessment(
        "HOLD_BINDING_MISMATCH",
        targetExecutionScopeRef,
        missionRef,
        assessedAt,
        ["HOST_TURN_RECORD_BINDING_MISMATCH"],
        session,
        turn,
      );
    }
    if (isHostTurnActive(turn.state)) {
      return gateAssessment(
        "HOLD_ACTIVE_TURN",
        targetExecutionScopeRef,
        missionRef,
        assessedAt,
        [`HOST_TURN_${turn.state.toUpperCase()}`],
        session,
        turn,
      );
    }
    if (turn.state === "disconnected") {
      return gateAssessment(
        "HOLD_DISCONNECTED_TURN",
        targetExecutionScopeRef,
        missionRef,
        assessedAt,
        ["HOST_TURN_DISCONNECTED_REQUIRES_RECONCILIATION"],
        session,
        turn,
      );
    }
    if (turn.state === "indeterminate") {
      return gateAssessment(
        "HOLD_INDETERMINATE_TURN",
        targetExecutionScopeRef,
        missionRef,
        assessedAt,
        ["HOST_TURN_INDETERMINATE_REQUIRES_RECONCILIATION"],
        session,
        turn,
      );
    }
    if (Date.parse(turn.latestEvidenceExpiresAt) <= nowMs) {
      return gateAssessment(
        "HOLD_STALE_EVIDENCE",
        targetExecutionScopeRef,
        missionRef,
        assessedAt,
        ["HOST_TURN_WAKE_ELIGIBILITY_EVIDENCE_EXPIRED"],
        session,
        turn,
      );
    }
    if (!isHostTurnWakeEligible(turn.state)) {
      return gateAssessment(
        "HOLD_NO_EXPLICIT_TURN_STATE",
        targetExecutionScopeRef,
        missionRef,
        assessedAt,
        [`HOST_TURN_STATE_NOT_WAKE_ELIGIBLE:${turn.state}`],
        session,
        turn,
      );
    }
    const evidenceDigestSha256 = hostTurnSha256(canonicalHostTurnJson({
      evidenceRefs: turn.evidenceRefs,
      authorityReadbackRefs: turn.authorityReadbackRefs,
      latestEvidenceAt: turn.latestEvidenceAt,
      latestEvidenceExpiresAt: turn.latestEvidenceExpiresAt,
    }));
    const binding: HostTurnWakeGateBinding = {
      schemaVersion: 1,
      sessionRef: session.sessionRef,
      sessionRevision: session.revision,
      targetExecutionScopeRef,
      missionRef,
      conversationBindingRef,
      conversationBindingGeneration,
      hostTurnRef: turn.hostTurnRef,
      hostTurnGeneration: turn.generation,
      hostTurnRevision: turn.revision,
      state: turn.state,
      stateDigestSha256: hostTurnStateDigest({ session, turn }),
      generationBoundaryRef: turn.generationBoundaryRef,
      evidenceDigestSha256,
      evidenceRefs: turn.evidenceRefs,
      authorityReadbackRefs: turn.authorityReadbackRefs,
      assessedAt,
      expiresAt: turn.latestEvidenceExpiresAt,
      authority: HOST_TURN_LIFECYCLE_AUTHORITY,
    };
    return {
      schemaVersion: 1,
      decision: turn.state === "awaiting_input"
        ? "ALLOW_AWAITING_INPUT"
        : "ALLOW_TERMINAL_TURN",
      wakeAllowed: true,
      targetExecutionScopeRef,
      missionRef,
      session,
      hostTurn: turn,
      binding,
      evidenceRefs: turn.evidenceRefs,
      authorityReadbackRefs: turn.authorityReadbackRefs,
      reasonCodes: [],
      assessedAt,
      authority: HOST_TURN_LIFECYCLE_AUTHORITY,
    };
  }

  private ensureBindingInternal(
    input: ReturnType<HostTurnLifecycleManager["normalizeBinding"]>,
    nowMs: number,
  ): HostTurnSessionRecord {
    const current = this.store.sessionForTarget(
      input.targetExecutionScopeRef,
      input.missionRef,
    );
    if (!current) {
      const sessionRef = `hts_${hostTurnSha256(canonicalHostTurnJson({
        targetExecutionScopeRef: input.targetExecutionScopeRef,
        missionRef: input.missionRef,
      })).slice(0, 32)}`;
      const logicalSessionRef = `logical_${hostTurnSha256(canonicalHostTurnJson({
        targetExecutionScopeRef: input.targetExecutionScopeRef,
        missionRef: input.missionRef,
      })).slice(0, 32)}`;
      const now = iso(nowMs);
      const record: HostTurnSessionRecord = {
        schemaVersion: 1,
        sessionRef,
        logicalSessionRef,
        targetExecutionScopeRef: input.targetExecutionScopeRef,
        missionRef: input.missionRef,
        currentExecutionScopeRef: input.targetExecutionScopeRef,
        executionScopeLineage: [{
          executionScopeRef: input.targetExecutionScopeRef,
          enteredAt: now,
          mode: "initial",
          authorityReadbackRefs: input.authorityReadbackRefs,
        }],
        conversationBindingRef: input.conversationBindingRef,
        conversationBindingGeneration: input.conversationBindingGeneration,
        targetKind: input.targetKind,
        targetRefDigestSha256: input.targetRefDigestSha256,
        currentHostTurnGeneration: 0,
        revision: 1,
        createdAt: now,
        updatedAt: now,
        authority: HOST_TURN_LIFECYCLE_AUTHORITY,
      };
      this.store.insertSession(record, hostTurnSha256(canonicalHostTurnJson(record)));
      return record;
    }
    if (current.conversationBindingRef === input.conversationBindingRef
      && current.conversationBindingGeneration === input.conversationBindingGeneration
      && current.targetKind === input.targetKind
      && current.targetRefDigestSha256 === input.targetRefDigestSha256) {
      return current;
    }
    const currentTurn = current.currentHostTurnRef
      ? this.store.turn(current.currentHostTurnRef)
      : undefined;
    if (currentTurn && !isHostTurnWakeEligible(currentTurn.state)) {
      throw new Error(
        `Conversation binding cannot change while host turn ${currentTurn.hostTurnRef} is ${currentTurn.state}; reconcile the existing turn first.`,
      );
    }
    const next: HostTurnSessionRecord = {
      ...current,
      conversationBindingRef: input.conversationBindingRef,
      conversationBindingGeneration: input.conversationBindingGeneration,
      targetKind: input.targetKind,
      targetRefDigestSha256: input.targetRefDigestSha256,
      revision: current.revision + 1,
      updatedAt: iso(nowMs),
    };
    const save = this.store.compareAndSwapSession(
      next,
      current.revision,
      hostTurnSha256(canonicalHostTurnJson(next)),
    );
    if (!save.saved) throw revisionConflict("host-turn session", save.current);
    return next;
  }

  private normalizeBinding(input: HostTurnBindingInput) {
    return {
      targetExecutionScopeRef: requireScopeRef(input.targetExecutionScopeRef),
      missionRef: this.reference(input.missionRef, "missionRef"),
      conversationBindingRef: this.reference(
        input.conversationBindingRef,
        "conversationBindingRef",
      ),
      conversationBindingGeneration: positiveInteger(
        input.conversationBindingGeneration,
        "conversationBindingGeneration",
      ),
      targetKind: this.reference(input.targetKind, "targetKind"),
      targetRefDigestSha256: requireSha256(
        input.targetRefDigestSha256,
        "targetRefDigestSha256",
      ),
      authorityReadbackRefs: this.references(
        input.authorityReadbackRefs ?? [],
        "authorityReadbackRefs",
      ),
    };
  }

  private normalizeObservation(input: HostTurnObservationInput): HostTurnObservation {
    const binding = this.normalizeBinding(input);
    const observation: HostTurnObservation = {
      ...binding,
      observerExecutionScopeRef: requireScopeRef(input.observerExecutionScopeRef),
      eventKind: hostTurnEventKind(input.eventKind),
      state: hostTurnState(input.state),
      source: hostTurnEvidenceSource(input.source),
      confidence: hostTurnEvidenceConfidence(input.confidence),
      providerAdapterId: this.reference(input.providerAdapterId, "providerAdapterId"),
      providerSessionRef: this.optionalReference(input.providerSessionRef, "providerSessionRef"),
      providerTurnRef: this.optionalReference(input.providerTurnRef, "providerTurnRef"),
      parentProviderTurnRef: this.optionalReference(
        input.parentProviderTurnRef,
        "parentProviderTurnRef",
      ),
      generationBoundaryRef: this.reference(
        input.generationBoundaryRef,
        "generationBoundaryRef",
      ),
      workCycleRef: this.optionalReference(input.workCycleRef, "workCycleRef"),
      correlationRef: this.optionalReference(input.correlationRef, "correlationRef"),
      pendingWorkRef: this.optionalReference(input.pendingWorkRef, "pendingWorkRef"),
      wakePermitRef: this.optionalReference(input.wakePermitRef, "wakePermitRef"),
      evidenceRefs: this.references(input.evidenceRefs, "evidenceRefs"),
      authorityReadbackRefs: this.references(
        input.authorityReadbackRefs,
        "authorityReadbackRefs",
      ),
      effectReadbackRefs: this.references(
        input.effectReadbackRefs,
        "effectReadbackRefs",
      ),
      reasonCodes: this.references(input.reasonCodes, "reasonCodes"),
      observedAt: requireIso(input.observedAt, "observedAt"),
      evidenceExpiresAt: this.evidenceExpiry(
        input.observedAt,
        input.evidenceExpiresAt,
      ),
      terminationCauseCode: this.optionalReference(
        input.terminationCauseCode,
        "terminationCauseCode",
      ),
    };
    return observation;
  }

  private mutate<T>(
    actorScopeRef: string,
    idempotencyKeyValue: string,
    commandKind: string,
    normalizedPayload: unknown,
    operation: (nowMs: number) => T,
  ): HostTurnMutationResult<T> {
    const idempotencyKey = requireIdempotencyKey(idempotencyKeyValue);
    const nowMs = this.now();
    this.maybeCleanup(nowMs);
    const payloadDigestSha256 = hostTurnSha256(canonicalHostTurnJson({
      commandKind,
      normalizedPayload,
    }));
    const transaction = this.database.sqlite.transaction(() => {
      const existing = this.store.command(actorScopeRef, idempotencyKey);
      if (existing) {
        if (existing.commandKind !== commandKind
          || existing.payloadDigestSha256 !== payloadDigestSha256) {
          throw new Error(
            "The host-turn idempotencyKey was already used with a different command.",
          );
        }
        return {
          value: JSON.parse(existing.resultJson) as T,
          idempotentReplay: true,
        };
      }
      const rawValue = operation(nowMs);
      const resultJson = JSON.stringify(rawValue);
      const value = JSON.parse(resultJson) as T;
      this.store.insertCommand({
        actorScopeRef,
        idempotencyKey,
        commandKind,
        payloadDigestSha256,
        resultJson,
        createdAtMs: nowMs,
      });
      return { value, idempotentReplay: false };
    });
    return transaction.immediate();
  }

  private evidenceExpiry(observedAt: string, expiresAt: string): string {
    const observedMs = Date.parse(requireIso(observedAt, "observedAt"));
    const expires = requireIso(expiresAt, "evidenceExpiresAt");
    const expiresMs = Date.parse(expires);
    if (expiresMs <= observedMs) {
      throw new Error("Host-turn evidence expiry must be after observedAt.");
    }
    if (expiresMs - observedMs > this.config.maximumObservationTtlMs) {
      throw new Error("Host-turn evidence expiry exceeds the configured maximum TTL.");
    }
    return expires;
  }

  private reference(value: string, name: string): string {
    const normalized = value.trim();
    if (!normalized) throw new Error(`${name} must not be empty.`);
    if (normalized.length > this.config.maxReferenceCharacters) {
      throw new Error(
        `${name} exceeds the ${this.config.maxReferenceCharacters}-character limit.`,
      );
    }
    return normalized;
  }

  private optionalReference(value: string | undefined, name: string) {
    return value === undefined ? undefined : this.reference(value, name);
  }

  private references(values: string[], name: string): string[] {
    if (values.length > this.config.maxReferencesPerField) {
      throw new Error(
        `${name} exceeds the ${this.config.maxReferencesPerField}-item limit.`,
      );
    }
    return uniqueHostTurnRefs(values.map((value, index) =>
      this.reference(value, `${name}[${index}]`)));
  }

  private requireSession(sessionRef: string): HostTurnSessionRecord {
    const session = this.store.session(sessionRef);
    if (!session) throw new Error(`Unknown host-turn session: ${sessionRef}`);
    return session;
  }

  private maybeCleanup(nowMs: number): void {
    if (nowMs - this.lastCleanupAtMs < this.config.cleanupIntervalMs) return;
    const retention: HostTurnLifecycleRetention = {
      terminalTurnRetentionMs: this.config.terminalTurnRetentionMs,
      eventRetentionMs: this.config.eventRetentionMs,
      commandRetentionMs: this.config.commandRetentionMs,
    };
    this.store.cleanup(nowMs, retention);
    this.lastCleanupAtMs = nowMs;
  }

  private assertEnabled(): void {
    if (!this.config.enabled) throw new Error("Host-turn lifecycle is disabled.");
    if (this.closed) throw new Error("Host-turn lifecycle manager is closed.");
  }
}

function gateAssessment(
  decision: HostTurnWakeGateAssessment["decision"],
  targetExecutionScopeRef: string,
  missionRef: string,
  assessedAt: string,
  reasonCodes: string[],
  session?: HostTurnSessionRecord,
  hostTurn?: HostTurnRecord,
): HostTurnWakeGateAssessment {
  return {
    schemaVersion: 1,
    decision,
    wakeAllowed: false,
    targetExecutionScopeRef,
    missionRef,
    session,
    hostTurn,
    evidenceRefs: hostTurn?.evidenceRefs ?? [],
    authorityReadbackRefs: hostTurn?.authorityReadbackRefs ?? [],
    reasonCodes: uniqueHostTurnRefs(reasonCodes),
    assessedAt,
    authority: HOST_TURN_LIFECYCLE_AUTHORITY,
  };
}

function validateConfig(config: HostTurnLifecycleConfig): void {
  for (const [name, value] of Object.entries(config)) {
    if (name === "enabled") continue;
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`Invalid host-turn lifecycle config: ${name}.`);
    }
  }
}

function requireScopeRef(value: string): string {
  if (!SCOPE_REF_PATTERN.test(value)) {
    throw new Error("Execution scope references must be 16 lowercase hexadecimal characters.");
  }
  return value;
}

function requireSha256(value: string, name: string): string {
  if (!SHA256_PATTERN.test(value)) throw new Error(`${name} must be lowercase SHA-256.`);
  return value;
}

function requireIso(value: string, name: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a valid ISO timestamp.`);
  return new Date(parsed).toISOString();
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function requireIdempotencyKey(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > IDEMPOTENCY_KEY_MAX) {
    throw new Error(`idempotencyKey must be 1-${IDEMPOTENCY_KEY_MAX} characters.`);
  }
  return normalized;
}

function hostTurnState(value: HostTurnState): HostTurnState {
  const values: HostTurnState[] = [
    "awaiting_input",
    "started",
    "running",
    "completed",
    "failed",
    "cancelled",
    "disconnected",
    "indeterminate",
  ];
  if (!values.includes(value)) throw new Error(`Invalid host-turn state: ${String(value)}.`);
  return value;
}

function hostTurnEventKind(value: HostTurnEventKind): HostTurnEventKind {
  const values: HostTurnEventKind[] = [
    "awaiting_input_observed",
    "turn_started",
    "turn_running",
    "turn_completed",
    "turn_failed",
    "turn_cancelled",
    "transport_disconnected",
    "state_indeterminate",
    "reconciled_running",
    "reconciled_cancelled",
    "reconciled_completed",
    "corroborating_evidence",
  ];
  if (!values.includes(value)) {
    throw new Error(`Invalid host-turn event kind: ${String(value)}.`);
  }
  return value;
}

function hostTurnEvidenceSource(
  value: HostTurnEvidenceSource,
): HostTurnEvidenceSource {
  const values: HostTurnEvidenceSource[] = [
    "conversation_transport",
    "provider_adapter",
    "browser_supervisor",
    "interaction_broker",
    "human_reconciliation",
  ];
  if (!values.includes(value)) {
    throw new Error(`Invalid host-turn evidence source: ${String(value)}.`);
  }
  return value;
}

function hostTurnEvidenceConfidence(
  value: HostTurnEvidenceConfidence,
): HostTurnEvidenceConfidence {
  const values: HostTurnEvidenceConfidence[] = [
    "attested",
    "verified",
    "corroborated",
    "advisory",
  ];
  if (!values.includes(value)) {
    throw new Error(`Invalid host-turn evidence confidence: ${String(value)}.`);
  }
  return value;
}

function revisionConflict(name: string, current: unknown): Error {
  return new Error(
    `${name} revision conflict.${current ? " Current state is available for reconciliation." : ""}`,
  );
}

function iso(value: number): string {
  return new Date(value).toISOString();
}

function terminationEvidence(
  observation: HostTurnObservation,
): HostTurnTerminationEvidence | undefined {
  if (!isHostTurnWakeEligible(observation.state)) return undefined;
  return {
    state: observation.state,
    causeCode: observation.terminationCauseCode!,
    confidence: observation.confidence as Exclude<
      HostTurnEvidenceConfidence,
      "advisory"
    >,
    evidenceRef: observation.evidenceRefs[0]!,
    observedAt: observation.observedAt,
  };
}
