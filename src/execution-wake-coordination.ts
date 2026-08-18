import { randomUUID } from "node:crypto";
import {
  openDatabase,
  type DatabaseHandle,
} from "./db/client.js";
import {
  EXECUTION_WAKE_COORDINATION_AUTHORITY,
  buildWakeContinuationEnvelope,
  canonicalJson,
  isWakeAttemptTerminal,
  pendingWorkSemanticDigest,
  sha256,
  uniqueSorted,
  validateLowerPlaneReadiness,
  validateVerifiedDispatchResult,
  wakeKey,
  type ExecutionWakeLowerPlanePort,
  type LowerPlaneWakeReadiness,
  type WakeAttempt,
  type WakeAttemptState,
  type WakeExecutionResult,
  type WakeLease,
  type WakeLowerPlaneDispatchResult,
  type WakePendingWorkRecord,
  type WakePriority,
  type WakeReconciliationInput,
  type WakeScheduleAssessment,
  type WakeTargetThrottle,
} from "./execution-wake-coordination-model.js";
import {
  SqliteExecutionWakeCoordinationStore,
  assertExecutionWakeCoordinationSchema,
  installExecutionWakeCoordinationSchema,
  type ExecutionWakeCoordinationRetention,
} from "./execution-wake-coordination-store.js";
import type { ExecutionScopeIdentity } from "./request-meta.js";

export interface ExecutionWakeCoordinationConfig {
  enabled: boolean;
  pendingWorkDefaultTtlMs: number;
  pendingWorkMaxTtlMs: number;
  wakePermitTtlMs: number;
  wakeLeaseTtlMs: number;
  executionCommandReservationTtlMs: number;
  minimumCooldownMs: number;
  maximumCooldownMs: number;
  automaticAttemptWindowMs: number;
  maximumAutomaticAttemptsPerWindow: number;
  maximumAutomaticAttemptsPerPendingWork: number;
  loopGuardHoldMs: number;
  indeterminateHumanHoldMs: number;
  pendingWorkRetentionMs: number;
  attemptRetentionMs: number;
  commandRetentionMs: number;
  auditRetentionMs: number;
  cleanupIntervalMs: number;
  maxReferenceCharacters: number;
  maxReferencesPerField: number;
  maxContinuationBodyCharacters: number;
}

export const DEFAULT_EXECUTION_WAKE_COORDINATION_CONFIG: ExecutionWakeCoordinationConfig = {
  enabled: true,
  pendingWorkDefaultTtlMs: 24 * 60 * 60 * 1_000,
  pendingWorkMaxTtlMs: 30 * 24 * 60 * 60 * 1_000,
  wakePermitTtlMs: 2 * 60 * 1_000,
  wakeLeaseTtlMs: 3 * 60 * 1_000,
  executionCommandReservationTtlMs: 5 * 60 * 1_000,
  minimumCooldownMs: 5 * 60 * 1_000,
  maximumCooldownMs: 2 * 60 * 60 * 1_000,
  automaticAttemptWindowMs: 60 * 60 * 1_000,
  maximumAutomaticAttemptsPerWindow: 3,
  maximumAutomaticAttemptsPerPendingWork: 2,
  loopGuardHoldMs: 2 * 60 * 60 * 1_000,
  indeterminateHumanHoldMs: 24 * 60 * 60 * 1_000,
  pendingWorkRetentionMs: 30 * 24 * 60 * 60 * 1_000,
  attemptRetentionMs: 30 * 24 * 60 * 60 * 1_000,
  commandRetentionMs: 30 * 24 * 60 * 60 * 1_000,
  auditRetentionMs: 30 * 24 * 60 * 60 * 1_000,
  cleanupIntervalMs: 60 * 1_000,
  maxReferenceCharacters: 2_000,
  maxReferencesPerField: 100,
  maxContinuationBodyCharacters: 12_000,
};

type WakeIdPrefix = "wpw" | "wat" | "wpr" | "wen" | "wls";

export interface ExecutionWakeCoordinationManagerOptions {
  now?: () => number;
  database?: DatabaseHandle;
  installSchema?: boolean;
  idFactory?: (prefix: WakeIdPrefix) => string;
}

export interface RecordWakePendingWorkInput {
  idempotencyKey: string;
  targetExecutionScopeRef: string;
  missionRef: string;
  sourceGeneration: number;
  workCycleRef: string;
  correlationRef: string;
  taskRefs?: string[];
  messageRefs?: string[];
  workItemRefs?: string[];
  sourceAuthorityRefs: string[];
  actionableCount: number;
  highestPriority?: WakePriority;
  expiresInHours?: number;
}

export interface ConsumeWakePendingWorkInput {
  idempotencyKey: string;
  pendingWorkId: string;
  expectedRevision: number;
  consumptionRefs: string[];
}

export interface ReleaseWakeHoldInput {
  idempotencyKey: string;
  targetExecutionScopeRef: string;
  missionRef: string;
  releaseRef: string;
}

export interface ExecuteWakeInput {
  idempotencyKey: string;
  targetExecutionScopeRef: string;
  missionRef: string;
}

export interface ReconcileWakeAttemptInput extends WakeReconciliationInput {
  idempotencyKey: string;
}

export interface WakeCoordinationStatus {
  schemaVersion: 1;
  generatedAt: string;
  currentScopeRef: string;
  currentPendingWork?: WakePendingWorkRecord;
  attempts: WakeAttempt[];
  throttle: WakeTargetThrottle;
  lease?: WakeLease;
  policy: typeof EXECUTION_WAKE_COORDINATION_AUTHORITY;
}

export interface WakeMutationResult<T> {
  value: T;
  idempotentReplay: boolean;
}

interface StoredExecutionCommandPointer {
  schemaVersion: 1;
  kind: "reservation" | "attempt" | "result";
  reservationRef?: string;
  reservedAt?: string;
  targetExecutionScopeRef?: string;
  missionRef?: string;
  attemptId?: string;
  result?: WakeExecutionResult;
}

const SCOPE_REF_PATTERN = /^[a-f0-9]{16}$/;
const PENDING_WORK_ID_PATTERN = /^wpw_[a-f0-9]{32}$/;
const ATTEMPT_ID_PATTERN = /^wat_[a-f0-9]{32}$/;
const PERMIT_REF_PATTERN = /^wpr_[a-f0-9]{32}$/;
const ENVELOPE_REF_PATTERN = /^wen_[a-f0-9]{32}$/;
const LEASE_ID_PATTERN = /^wls_[a-f0-9]{32}$/;
const IDEMPOTENCY_KEY_MAX = 200;

export class ExecutionWakeCoordinationManager {
  private readonly now: () => number;
  private readonly database: DatabaseHandle;
  private readonly store: SqliteExecutionWakeCoordinationStore;
  private readonly ownsDatabase: boolean;
  private readonly idFactory: (prefix: WakeIdPrefix) => string;
  private lastCleanupAtMs = 0;
  private closed = false;

  constructor(
    readonly config: ExecutionWakeCoordinationConfig,
    stateDir: string,
    private readonly lowerPlane: ExecutionWakeLowerPlanePort,
    options: ExecutionWakeCoordinationManagerOptions = {},
  ) {
    validateConfig(config);
    this.now = options.now ?? Date.now;
    this.database = options.database ?? openDatabase(stateDir);
    this.ownsDatabase = options.database === undefined;
    try {
      if (options.installSchema === true) {
        installExecutionWakeCoordinationSchema(this.database.sqlite, this.now());
      }
      assertExecutionWakeCoordinationSchema(this.database.sqlite);
    } catch (error) {
      if (this.ownsDatabase) this.database.close();
      throw error;
    }
    this.store = new SqliteExecutionWakeCoordinationStore(this.database.sqlite);
    this.idFactory = options.idFactory ?? ((prefix) =>
      `${prefix}_${randomUUID().replaceAll("-", "")}`);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.ownsDatabase) this.database.close();
  }

  recordPendingWork(
    identity: ExecutionScopeIdentity | undefined,
    input: RecordWakePendingWorkInput,
  ): WakeMutationResult<WakePendingWorkRecord> {
    this.assertEnabled();
    const actor = requireIdentity(identity);
    const normalized = this.normalizePendingWorkInput(input);
    return this.mutate(actor, input.idempotencyKey, "record_pending_work", normalized, (nowMs) => {
      const semanticDigestSha256 = pendingWorkSemanticDigest(normalized);
      const current = this.store.currentPendingWork(
        normalized.targetExecutionScopeRef,
        normalized.missionRef,
      );
      const expiresAt = iso(nowMs + normalized.ttlMs);

      if (current) {
        if (normalized.sourceGeneration < current.sourceGeneration) {
          throw new Error(
            `Pending-work source generation regressed: current ${current.sourceGeneration}, received ${normalized.sourceGeneration}.`,
          );
        }
        if (normalized.sourceGeneration === current.sourceGeneration
          && semanticDigestSha256 !== current.semanticDigestSha256) {
          throw new Error(
            "A pending-work source generation cannot be reused with different semantic content.",
          );
        }
        if (normalized.sourceGeneration > current.sourceGeneration
          && normalized.workCycleRef === current.workCycleRef) {
          throw new Error(
            "A new pending-work source generation requires a new workCycleRef.",
          );
        }
        if (semanticDigestSha256 === current.semanticDigestSha256) {
          const refreshedState = current.state === "expired" ? "pending" : current.state;
          const refreshed: WakePendingWorkRecord = {
            ...current,
            state: refreshedState,
            revision: current.revision + 1,
            updatedAt: iso(nowMs),
            expiresAt,
          };
          const digest = sha256(canonicalJson(refreshed));
          const save = this.store.compareAndSwapPendingWork(
            refreshed,
            current.revision,
            digest,
          );
          if (!save.saved) throw revisionConflict("pending work", save.current);
          this.auditPending(actor.scopeRef, refreshed, "pending_work_refreshed", current.state, nowMs);
          return refreshed;
        }
      }

      const pendingWorkId = this.idFactory("wpw");
      requireId(pendingWorkId, PENDING_WORK_ID_PATTERN, "generated pendingWorkId");
      const generation = (current?.generation ?? 0) + 1;
      const nowIso = iso(nowMs);
      const record: WakePendingWorkRecord = {
        schemaVersion: 1,
        pendingWorkId,
        targetExecutionScopeRef: normalized.targetExecutionScopeRef,
        missionRef: normalized.missionRef,
        generation,
        sourceGeneration: normalized.sourceGeneration,
        workCycleRef: normalized.workCycleRef,
        correlationRef: normalized.correlationRef,
        taskRefs: normalized.taskRefs,
        messageRefs: normalized.messageRefs,
        workItemRefs: normalized.workItemRefs,
        sourceAuthorityRefs: normalized.sourceAuthorityRefs,
        actionableCount: normalized.actionableCount,
        highestPriority: normalized.highestPriority,
        semanticDigestSha256,
        state: "pending",
        revision: 1,
        latestAttemptSequence: 0,
        createdAt: nowIso,
        updatedAt: nowIso,
        expiresAt,
        consumptionRefs: [],
        holdReasonCodes: [],
        authority: EXECUTION_WAKE_COORDINATION_AUTHORITY,
      };
      if (current) {
        const superseded: WakePendingWorkRecord = {
          ...current,
          state: "superseded",
          revision: current.revision + 1,
          updatedAt: nowIso,
          supersededAt: nowIso,
          supersededByPendingWorkId: pendingWorkId,
        };
        const supersededDigest = sha256(canonicalJson(superseded));
        const save = this.store.compareAndSwapPendingWork(
          superseded,
          current.revision,
          supersededDigest,
          false,
        );
        if (!save.saved) throw revisionConflict("pending work", save.current);
        this.auditPending(
          actor.scopeRef,
          superseded,
          "pending_work_superseded",
          current.state,
          nowMs,
        );
      }
      const digest = sha256(canonicalJson(record));
      this.store.insertPendingWork(record, digest, true);
      this.auditPending(actor.scopeRef, record, "pending_work_recorded", undefined, nowMs);
      return record;
    });
  }

  consumePendingWork(
    identity: ExecutionScopeIdentity | undefined,
    input: ConsumeWakePendingWorkInput,
  ): WakeMutationResult<WakePendingWorkRecord> {
    this.assertEnabled();
    const actor = requireIdentity(identity);
    const normalized = {
      pendingWorkId: requireId(
        input.pendingWorkId,
        PENDING_WORK_ID_PATTERN,
        "pendingWorkId",
      ),
      expectedRevision: positiveInteger(input.expectedRevision, "expectedRevision"),
      consumptionRefs: this.references(input.consumptionRefs, "consumptionRefs"),
    };
    if (normalized.consumptionRefs.length === 0) {
      throw new Error("consumePendingWork requires at least one consumption reference.");
    }
    return this.mutate(actor, input.idempotencyKey, "consume_pending_work", normalized, (nowMs) => {
      const current = this.requirePendingWork(normalized.pendingWorkId);
      if (current.targetExecutionScopeRef !== actor.scopeRef) {
        throw new Error("Only the target execution scope may record pending-work consumption.");
      }
      requireRevision(current.revision, normalized.expectedRevision, "pending work");
      if (["superseded", "expired"].includes(current.state)) {
        throw new Error(`Cannot consume pending work in state ${current.state}.`);
      }
      const next: WakePendingWorkRecord = {
        ...current,
        state: "consumed",
        revision: current.revision + 1,
        updatedAt: iso(nowMs),
        consumedAt: iso(nowMs),
        consumptionRefs: uniqueSorted([
          ...current.consumptionRefs,
          ...normalized.consumptionRefs,
        ]),
        holdReasonCodes: [],
      };
      const digest = sha256(canonicalJson(next));
      const save = this.store.compareAndSwapPendingWork(
        next,
        current.revision,
        digest,
      );
      if (!save.saved) throw revisionConflict("pending work", save.current);
      this.auditPending(actor.scopeRef, next, "pending_work_consumed", current.state, nowMs);
      return next;
    });
  }

  releaseHold(
    identity: ExecutionScopeIdentity | undefined,
    input: ReleaseWakeHoldInput,
  ): WakeMutationResult<{
    pendingWork?: WakePendingWorkRecord;
    throttle: WakeTargetThrottle;
  }> {
    this.assertEnabled();
    const actor = requireIdentity(identity);
    const normalized = {
      targetExecutionScopeRef: requireScopeRef(input.targetExecutionScopeRef),
      missionRef: this.reference(input.missionRef, "missionRef"),
      releaseRef: this.reference(input.releaseRef, "releaseRef"),
    };
    return this.mutate(actor, input.idempotencyKey, "release_wake_hold", normalized, (nowMs) => {
      const currentThrottle = this.currentThrottle(
        normalized.targetExecutionScopeRef,
        normalized.missionRef,
        nowMs,
      );
      const nextThrottle: WakeTargetThrottle = {
        ...currentThrottle,
        revision: currentThrottle.revision + 1,
        state: "ready",
        automaticAttemptWindowStartedAt: undefined,
        automaticAttemptCount: 0,
        consecutiveNoEffectCount: 0,
        cooldownUntil: iso(nowMs),
        holdUntil: undefined,
        holdReasonCodes: [],
        updatedAt: iso(nowMs),
      };
      this.saveThrottle(actor.scopeRef, currentThrottle, nextThrottle, "wake_hold_released", nowMs, {
        releaseRef: normalized.releaseRef,
      });

      const pending = this.store.currentPendingWork(
        normalized.targetExecutionScopeRef,
        normalized.missionRef,
      );
      let nextPending = pending;
      if (pending?.state === "held") {
        const unresolvedIndeterminate = this.store.attempts(
          normalized.targetExecutionScopeRef,
          normalized.missionRef,
        ).some((attempt) => attempt.state === "indeterminate");
        if (unresolvedIndeterminate) {
          throw new Error(
            "A wake hold cannot be released while an indeterminate attempt remains unreconciled.",
          );
        }
        nextPending = {
          ...pending,
          state: Date.parse(pending.expiresAt) <= nowMs ? "expired" : "pending",
          revision: pending.revision + 1,
          updatedAt: iso(nowMs),
          holdReasonCodes: [],
        };
        const digest = sha256(canonicalJson(nextPending));
        const save = this.store.compareAndSwapPendingWork(
          nextPending,
          pending.revision,
          digest,
        );
        if (!save.saved) throw revisionConflict("pending work", save.current);
        this.auditPending(
          actor.scopeRef,
          nextPending,
          "pending_work_hold_released",
          pending.state,
          nowMs,
        );
      }
      return { pendingWork: nextPending, throttle: nextThrottle };
    });
  }

  async assessWake(
    identity: ExecutionScopeIdentity | undefined,
    targetExecutionScopeRef: string,
    missionRef: string,
  ): Promise<WakeScheduleAssessment> {
    this.assertEnabled();
    const actor = requireIdentity(identity);
    const target = requireScopeRef(targetExecutionScopeRef);
    const mission = this.reference(missionRef, "missionRef");
    const nowMs = this.now();
    this.maybeCleanup(nowMs);
    this.recoverStalledAttemptsInternal(target, mission, nowMs, actor.scopeRef);
    return this.assessWakeInternal(target, mission, nowMs);
  }

  async executeWake(
    identity: ExecutionScopeIdentity | undefined,
    input: ExecuteWakeInput,
  ): Promise<WakeExecutionResult> {
    this.assertEnabled();
    const actor = requireIdentity(identity);
    const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
    const normalized = {
      targetExecutionScopeRef: requireScopeRef(input.targetExecutionScopeRef),
      missionRef: this.reference(input.missionRef, "missionRef"),
    };
    const commandKind = "execute_wake";
    const commandDigest = sha256(canonicalJson({ commandKind, normalized }));
    const reservation = this.reserveExecutionCommand(
      actor.scopeRef,
      idempotencyKey,
      commandKind,
      commandDigest,
      normalized,
      this.now(),
    );
    if (!reservation.owned) {
      if (reservation.pointer.kind === "reservation") {
        return this.reservationInFlightResult(
          normalized.targetExecutionScopeRef,
          normalized.missionRef,
          true,
        );
      }
      return this.resumeStoredExecution(actor, reservation.resultJson);
    }

    const nowMs = this.now();
    this.maybeCleanup(nowMs);
    this.recoverStalledAttemptsInternal(
      normalized.targetExecutionScopeRef,
      normalized.missionRef,
      nowMs,
      actor.scopeRef,
    );
    const assessment = await this.assessWakeInternal(
      normalized.targetExecutionScopeRef,
      normalized.missionRef,
      this.now(),
    );
    if (assessment.decision !== "READY") {
      const result: WakeExecutionResult = {
        schemaVersion: 1,
        assessment,
        idempotentReplay: false,
        authority: EXECUTION_WAKE_COORDINATION_AUTHORITY,
      };
      const stored = this.storeExecutionCommandResult(
        actor.scopeRef,
        idempotencyKey,
        commandKind,
        commandDigest,
        { schemaVersion: 1, kind: "result", result },
        this.now(),
        reservation.resultJson,
      );
      if (!stored) {
        return this.resumeCurrentExecutionCommand(
          actor,
          idempotencyKey,
          commandKind,
          commandDigest,
          normalized.targetExecutionScopeRef,
          normalized.missionRef,
        );
      }
      return result;
    }

    const pending = assessment.pendingWork;
    const readiness = assessment.readiness;
    const attemptSequence = assessment.nextAttemptSequence;
    if (!pending || !readiness || attemptSequence === undefined) {
      throw new Error("READY wake assessment is missing pending work, readiness, or sequence.");
    }
    const resourceRef = wakeResourceRef(
      pending.targetExecutionScopeRef,
      pending.missionRef,
    );
    const leaseId = this.idFactory("wls");
    requireId(leaseId, LEASE_ID_PATTERN, "generated wake lease ID");
    const leaseClaim = this.store.claimLease({
      resourceRef,
      leaseId,
      holderScopeRef: actor.scopeRef,
      targetExecutionScopeRef: pending.targetExecutionScopeRef,
      missionRef: pending.missionRef,
      pendingWorkId: pending.pendingWorkId,
      nowMs: this.now(),
      ttlMs: this.config.wakeLeaseTtlMs,
    });
    if (!leaseClaim.acquired || !leaseClaim.lease) {
      const heldAssessment: WakeScheduleAssessment = {
        ...assessment,
        decision: "IN_FLIGHT",
        reasonCodes: uniqueSorted([
          ...assessment.reasonCodes,
          "WAKE_LEASE_BUSY",
        ]),
      };
      const result: WakeExecutionResult = {
        schemaVersion: 1,
        assessment: heldAssessment,
        idempotentReplay: false,
        authority: EXECUTION_WAKE_COORDINATION_AUTHORITY,
      };
      const stored = this.storeExecutionCommandResult(
        actor.scopeRef,
        idempotencyKey,
        commandKind,
        commandDigest,
        { schemaVersion: 1, kind: "result", result },
        this.now(),
        reservation.resultJson,
      );
      if (!stored) {
        return this.resumeCurrentExecutionCommand(
          actor,
          idempotencyKey,
          commandKind,
          commandDigest,
          normalized.targetExecutionScopeRef,
          normalized.missionRef,
        );
      }
      return result;
    }

    try {
      const freshAssessment = await this.assessWakeInternal(
        normalized.targetExecutionScopeRef,
        normalized.missionRef,
        this.now(),
        true,
      );
      if (freshAssessment.decision !== "READY"
        || freshAssessment.pendingWork?.pendingWorkId !== pending.pendingWorkId
        || freshAssessment.pendingWork?.revision !== pending.revision
        || freshAssessment.nextAttemptSequence !== attemptSequence) {
        const result: WakeExecutionResult = {
          schemaVersion: 1,
          assessment: {
            ...freshAssessment,
            decision: freshAssessment.decision === "READY" ? "HOLD" : freshAssessment.decision,
            reasonCodes: uniqueSorted([
              ...freshAssessment.reasonCodes,
              "WAKE_STATE_CHANGED_AFTER_LEASE",
            ]),
          },
          idempotentReplay: false,
          authority: EXECUTION_WAKE_COORDINATION_AUTHORITY,
        };
        const stored = this.storeExecutionCommandResult(
          actor.scopeRef,
          idempotencyKey,
          commandKind,
          commandDigest,
          { schemaVersion: 1, kind: "result", result },
          this.now(),
          reservation.resultJson,
        );
        if (!stored) {
          return this.resumeCurrentExecutionCommand(
            actor,
            idempotencyKey,
            commandKind,
            commandDigest,
            normalized.targetExecutionScopeRef,
            normalized.missionRef,
          );
        }
        return result;
      }

      const prepared = this.prepareAttempt(
        actor,
        idempotencyKey,
        commandKind,
        commandDigest,
        freshAssessment,
        reservation.resultJson,
      );
      return await this.dispatchPreparedAttempt(actor, prepared, leaseClaim.lease);
    } finally {
      this.store.releaseLease({
        resourceRef,
        leaseId,
        holderScopeRef: actor.scopeRef,
      });
    }
  }

  reconcileAttempt(
    identity: ExecutionScopeIdentity | undefined,
    input: ReconcileWakeAttemptInput,
  ): WakeMutationResult<WakeAttempt> {
    this.assertEnabled();
    const actor = requireIdentity(identity);
    const normalized = {
      attemptId: requireId(input.attemptId, ATTEMPT_ID_PATTERN, "attemptId"),
      expectedRevision: positiveInteger(input.expectedRevision, "expectedRevision"),
      resolution: input.resolution,
      interactionReconciliationRef: this.reference(
        input.interactionReconciliationRef,
        "interactionReconciliationRef",
      ),
      authorityReadbackRef: this.reference(
        input.authorityReadbackRef,
        "authorityReadbackRef",
      ),
      effectReadbackRef: this.reference(input.effectReadbackRef, "effectReadbackRef"),
      promptAdmissionRef: input.promptAdmissionRef
        ? this.reference(input.promptAdmissionRef, "promptAdmissionRef")
        : undefined,
      generationBoundaryRefAfter: input.generationBoundaryRefAfter
        ? this.reference(input.generationBoundaryRefAfter, "generationBoundaryRefAfter")
        : undefined,
      verificationRefs: this.references(input.verificationRefs, "verificationRefs"),
    };
    if (!["effect_absent", "effect_verified"].includes(normalized.resolution)) {
      throw new Error("Wake reconciliation resolution must be effect_absent or effect_verified.");
    }
    if (normalized.verificationRefs.length === 0) {
      throw new Error("Wake reconciliation requires verification references.");
    }
    return this.mutate(actor, input.idempotencyKey, "reconcile_wake_attempt", normalized, (nowMs) => {
      const current = this.requireAttempt(normalized.attemptId);
      requireRevision(current.revision, normalized.expectedRevision, "wake attempt");
      if (current.state !== "indeterminate") {
        throw new Error("Only an indeterminate wake attempt may be reconciled.");
      }
      if (normalized.resolution === "effect_verified") {
        if (!normalized.promptAdmissionRef || !normalized.generationBoundaryRefAfter) {
          throw new Error(
            "effect_verified reconciliation requires prompt admission and a new generation boundary.",
          );
        }
        if (current.permit.generationBoundaryRefBefore
          && current.permit.generationBoundaryRefBefore
            === normalized.generationBoundaryRefAfter) {
          throw new Error("Wake reconciliation generation boundary did not advance.");
        }
      }

      const nextState: WakeAttemptState = normalized.resolution === "effect_verified"
        ? "reconciled_effect_verified"
        : "reconciled_effect_absent";
      const next: WakeAttempt = {
        ...current,
        state: nextState,
        revision: current.revision + 1,
        interactionReconciliationRef: normalized.interactionReconciliationRef,
        authorityReadbackRef: normalized.authorityReadbackRef,
        effectReadbackRef: normalized.effectReadbackRef,
        reconciliationResolution: normalized.resolution,
        lowerPlaneResult: normalized.resolution === "effect_verified"
          ? {
              schemaVersion: 1,
              permitRef: current.permit.permitRef,
              disposition: "verified",
              interactionSessionRef: current.lowerPlaneResult?.interactionSessionRef
                ?? current.permit.sessionUiBindingRef,
              interactionActionId: current.lowerPlaneResult?.interactionActionId,
              interactionReceiptRef: current.lowerPlaneResult?.interactionReceiptRef,
              promptAdmissionRef: normalized.promptAdmissionRef,
              generationBoundaryRefAfter: normalized.generationBoundaryRefAfter,
              verificationRefs: uniqueSorted([
                ...(current.lowerPlaneResult?.verificationRefs ?? []),
                ...normalized.verificationRefs,
              ]),
              completedAt: iso(nowMs),
            }
          : {
              schemaVersion: 1,
              permitRef: current.permit.permitRef,
              disposition: "failed_no_effect",
              interactionSessionRef: current.lowerPlaneResult?.interactionSessionRef
                ?? current.permit.sessionUiBindingRef,
              noEffectProofRef: normalized.effectReadbackRef,
              verificationRefs: normalized.verificationRefs,
              completedAt: iso(nowMs),
            },
        updatedAt: iso(nowMs),
        terminalAt: iso(nowMs),
        cooldownUntil: iso(nowMs + this.config.minimumCooldownMs),
      };
      const digest = sha256(canonicalJson(next));
      const save = this.store.compareAndSwapAttempt(next, current.revision, digest);
      if (!save.saved) throw revisionConflict("wake attempt", save.current);
      this.auditAttempt(
        actor.scopeRef,
        next,
        `wake_attempt_${nextState}`,
        current.state,
        nowMs,
      );
      this.reconcilePendingAndThrottle(actor.scopeRef, current, next, nowMs);
      return next;
    });
  }

  recoverStalledAttempts(
    identity: ExecutionScopeIdentity | undefined,
    targetExecutionScopeRef: string,
    missionRef: string,
  ): WakeAttempt[] {
    this.assertEnabled();
    const actor = requireIdentity(identity);
    return this.recoverStalledAttemptsInternal(
      requireScopeRef(targetExecutionScopeRef),
      this.reference(missionRef, "missionRef"),
      this.now(),
      actor.scopeRef,
    );
  }

  status(
    identity: ExecutionScopeIdentity | undefined,
    targetExecutionScopeRef: string,
    missionRef: string,
  ): WakeCoordinationStatus {
    this.assertEnabled();
    const actor = requireIdentity(identity);
    const target = requireScopeRef(targetExecutionScopeRef);
    const mission = this.reference(missionRef, "missionRef");
    const nowMs = this.now();
    this.maybeCleanup(nowMs);
    const currentPending = this.store.currentPendingWork(target, mission);
    const pending = currentPending ? materializePendingWork(currentPending, nowMs) : undefined;
    const throttle = this.currentThrottle(target, mission, nowMs);
    return {
      schemaVersion: 1,
      generatedAt: iso(nowMs),
      currentScopeRef: actor.scopeRef,
      currentPendingWork: pending,
      attempts: this.store.attempts(target, mission),
      throttle,
      lease: this.store.lease(wakeResourceRef(target, mission)),
      policy: EXECUTION_WAKE_COORDINATION_AUTHORITY,
    };
  }

  private normalizePendingWorkInput(input: RecordWakePendingWorkInput) {
    const taskRefs = this.references(input.taskRefs ?? [], "taskRefs");
    const messageRefs = this.references(input.messageRefs ?? [], "messageRefs");
    const workItemRefs = this.references(input.workItemRefs ?? [], "workItemRefs");
    const sourceAuthorityRefs = this.references(
      input.sourceAuthorityRefs,
      "sourceAuthorityRefs",
    );
    if (sourceAuthorityRefs.length === 0) {
      throw new Error("Pending work requires source authority references.");
    }
    const actionableCount = positiveInteger(input.actionableCount, "actionableCount");
    if (taskRefs.length + messageRefs.length + workItemRefs.length === 0) {
      throw new Error("Pending work requires at least one task, message, or work-item reference.");
    }
    if (actionableCount > taskRefs.length + messageRefs.length + workItemRefs.length) {
      throw new Error("actionableCount cannot exceed the number of durable work references.");
    }
    return {
      targetExecutionScopeRef: requireScopeRef(input.targetExecutionScopeRef),
      missionRef: this.reference(input.missionRef, "missionRef"),
      sourceGeneration: positiveInteger(input.sourceGeneration, "sourceGeneration"),
      workCycleRef: this.reference(input.workCycleRef, "workCycleRef"),
      correlationRef: this.reference(input.correlationRef, "correlationRef"),
      taskRefs,
      messageRefs,
      workItemRefs,
      sourceAuthorityRefs,
      actionableCount,
      highestPriority: wakePriority(input.highestPriority ?? "normal"),
      ttlMs: ttlMs(
        input.expiresInHours,
        this.config.pendingWorkDefaultTtlMs,
        this.config.pendingWorkMaxTtlMs,
        "expiresInHours",
      ),
    };
  }

  private async assessWakeInternal(
    targetExecutionScopeRef: string,
    missionRef: string,
    nowMs: number,
    leaseAlreadyHeld = false,
  ): Promise<WakeScheduleAssessment> {
    const reasons = new Set<string>();
    const current = this.store.currentPendingWork(targetExecutionScopeRef, missionRef);
    if (!current) {
      return scheduleAssessment(
        "NO_PENDING_WORK",
        targetExecutionScopeRef,
        missionRef,
        nowMs,
        reasons,
      );
    }
    const pending = materializePendingWork(current, nowMs);
    if (["consumed", "superseded", "expired"].includes(pending.state)) {
      reasons.add(`PENDING_WORK_${pending.state.toUpperCase()}`);
      return scheduleAssessment(
        "NO_PENDING_WORK",
        targetExecutionScopeRef,
        missionRef,
        nowMs,
        reasons,
        pending,
      );
    }
    if (pending.state === "wake_verified") {
      reasons.add("PENDING_WORK_ALREADY_WAKE_VERIFIED");
      return scheduleAssessment(
        "ALREADY_VERIFIED",
        targetExecutionScopeRef,
        missionRef,
        nowMs,
        reasons,
        pending,
      );
    }
    if (pending.state === "held") {
      for (const reason of pending.holdReasonCodes) reasons.add(reason);
      reasons.add("PENDING_WORK_HELD");
      return scheduleAssessment(
        "HOLD",
        targetExecutionScopeRef,
        missionRef,
        nowMs,
        reasons,
        pending,
      );
    }
    if (pending.state === "wake_inflight") {
      const inflight = this.store.latestAttemptForPendingWork(pending.pendingWorkId);
      if (!inflight || !["prepared", "dispatching", "indeterminate"].includes(inflight.state)) {
        reasons.add("PENDING_WORK_INFLIGHT_WITHOUT_LIVE_ATTEMPT");
        return scheduleAssessment(
          "HOLD",
          targetExecutionScopeRef,
          missionRef,
          nowMs,
          reasons,
          pending,
        );
      }
    }

    const attempts = this.store.attempts(targetExecutionScopeRef, missionRef);
    const unreconciled = attempts.find((attempt) => attempt.state === "indeterminate");
    if (unreconciled) {
      reasons.add(`UNRECONCILED_INDETERMINATE_ATTEMPT:${unreconciled.attemptId}`);
      return scheduleAssessment(
        "HOLD",
        targetExecutionScopeRef,
        missionRef,
        nowMs,
        reasons,
        pending,
      );
    }
    const latest = this.store.latestAttemptForPendingWork(pending.pendingWorkId);
    if (latest) {
      if (["prepared", "dispatching"].includes(latest.state)) {
        reasons.add(`WAKE_ATTEMPT_${latest.state.toUpperCase()}`);
        return scheduleAssessment(
          "IN_FLIGHT",
          targetExecutionScopeRef,
          missionRef,
          nowMs,
          reasons,
          pending,
        );
      }
      if (["verified", "reconciled_effect_verified"].includes(latest.state)) {
        reasons.add("WAKE_ALREADY_VERIFIED_FOR_PENDING_WORK");
        return scheduleAssessment(
          "ALREADY_VERIFIED",
          targetExecutionScopeRef,
          missionRef,
          nowMs,
          reasons,
          pending,
        );
      }
      if (latest.attemptSequence >= this.config.maximumAutomaticAttemptsPerPendingWork) {
        reasons.add("MAXIMUM_AUTOMATIC_ATTEMPTS_PER_PENDING_WORK_REACHED");
        return scheduleAssessment(
          "LOOP_GUARD",
          targetExecutionScopeRef,
          missionRef,
          nowMs,
          reasons,
          pending,
        );
      }
    }

    const throttle = this.currentThrottle(targetExecutionScopeRef, missionRef, nowMs);
    if (throttle.state === "human_hold") {
      reasons.add("TARGET_HUMAN_HOLD_ACTIVE");
      return scheduleAssessment(
        "HOLD",
        targetExecutionScopeRef,
        missionRef,
        nowMs,
        reasons,
        pending,
        undefined,
        throttle,
      );
    }
    if (throttle.state === "loop_guard") {
      reasons.add("TARGET_WAKE_LOOP_GUARD_ACTIVE");
      return scheduleAssessment(
        "LOOP_GUARD",
        targetExecutionScopeRef,
        missionRef,
        nowMs,
        reasons,
        pending,
        undefined,
        throttle,
      );
    }
    if (throttle.state === "cooldown") {
      reasons.add("TARGET_WAKE_COOLDOWN_ACTIVE");
      return scheduleAssessment(
        "COOLDOWN",
        targetExecutionScopeRef,
        missionRef,
        nowMs,
        reasons,
        pending,
        undefined,
        throttle,
      );
    }
    if (throttle.automaticAttemptCount
      >= this.config.maximumAutomaticAttemptsPerWindow) {
      reasons.add("MAXIMUM_AUTOMATIC_ATTEMPTS_PER_WINDOW_REACHED");
      return scheduleAssessment(
        "LOOP_GUARD",
        targetExecutionScopeRef,
        missionRef,
        nowMs,
        reasons,
        pending,
        undefined,
        throttle,
      );
    }

    if (!leaseAlreadyHeld) {
      const lease = this.store.lease(wakeResourceRef(targetExecutionScopeRef, missionRef));
      if (lease && Date.parse(lease.expiresAt) > nowMs) {
        reasons.add("WAKE_LEASE_ACTIVE");
        return scheduleAssessment(
          "IN_FLIGHT",
          targetExecutionScopeRef,
          missionRef,
          nowMs,
          reasons,
          pending,
          undefined,
          throttle,
        );
      }
    }

    let readiness: LowerPlaneWakeReadiness;
    try {
      readiness = await this.lowerPlane.assessReadiness({
        targetExecutionScopeRef,
        missionRef,
        pendingWorkId: pending.pendingWorkId,
        pendingWorkGeneration: pending.generation,
        pendingWorkSemanticDigestSha256: pending.semanticDigestSha256,
        correlationRef: pending.correlationRef,
      });
    } catch {
      reasons.add("LOWER_PLANE_READINESS_ASSESSMENT_FAILED");
      return scheduleAssessment(
        "HOLD",
        targetExecutionScopeRef,
        missionRef,
        nowMs,
        reasons,
        pending,
        undefined,
        throttle,
      );
    }
    for (const reason of validateLowerPlaneReadiness(readiness, pending, nowMs)) {
      reasons.add(reason);
    }
    if (reasons.size > 0) {
      return scheduleAssessment(
        "HOLD",
        targetExecutionScopeRef,
        missionRef,
        nowMs,
        reasons,
        pending,
        readiness,
        throttle,
      );
    }
    return scheduleAssessment(
      "READY",
      targetExecutionScopeRef,
      missionRef,
      nowMs,
      reasons,
      pending,
      readiness,
      throttle,
      (latest?.attemptSequence ?? 0) + 1,
    );
  }

  private prepareAttempt(
    actor: ExecutionScopeIdentity,
    idempotencyKey: string,
    commandKind: string,
    commandDigest: string,
    assessment: WakeScheduleAssessment,
    reservationResultJson: string,
  ): WakeAttempt {
    const pending = assessment.pendingWork;
    const readiness = assessment.readiness;
    const attemptSequence = assessment.nextAttemptSequence;
    if (!pending || !readiness || attemptSequence === undefined) {
      throw new Error("Cannot prepare a wake attempt from an incomplete assessment.");
    }
    const nowMs = this.now();
    const transaction = this.database.sqlite.transaction(() => {
      const existingCommand = this.store.command(actor.scopeRef, idempotencyKey);
      if (!existingCommand
        || existingCommand.commandKind !== commandKind
        || existingCommand.payloadDigestSha256 !== commandDigest) {
        throw new Error("Wake execution command reservation disappeared or changed.");
      }
      const pointer = JSON.parse(existingCommand.resultJson) as StoredExecutionCommandPointer;
      if (pointer.kind === "attempt" && pointer.attemptId) {
        return this.requireAttempt(pointer.attemptId);
      }
      if (pointer.kind !== "reservation"
        || existingCommand.resultJson !== reservationResultJson) {
        throw new Error("Wake execution command reservation was replaced before preparation.");
      }
      const currentPending = this.requirePendingWork(pending.pendingWorkId);
      requireRevision(currentPending.revision, pending.revision, "pending work");
      if (currentPending.state !== "pending") {
        throw new Error(`Pending work changed to ${currentPending.state} before wake preparation.`);
      }
      const currentLatest = this.store.latestAttemptForPendingWork(pending.pendingWorkId);
      if ((currentLatest?.attemptSequence ?? 0) + 1 !== attemptSequence) {
        throw new Error("Wake attempt sequence changed before preparation.");
      }
      const currentThrottle = this.currentThrottle(
        pending.targetExecutionScopeRef,
        pending.missionRef,
        nowMs,
      );
      if (currentThrottle.state !== "ready") {
        throw new Error(`Wake throttle changed to ${currentThrottle.state} before preparation.`);
      }
      if (currentThrottle.automaticAttemptCount
        >= this.config.maximumAutomaticAttemptsPerWindow) {
        throw new Error("Wake attempt window limit was reached before preparation.");
      }

      const attemptId = this.idFactory("wat");
      const permitRef = this.idFactory("wpr");
      const envelopeRef = this.idFactory("wen");
      requireId(attemptId, ATTEMPT_ID_PATTERN, "generated attemptId");
      requireId(permitRef, PERMIT_REF_PATTERN, "generated permitRef");
      requireId(envelopeRef, ENVELOPE_REF_PATTERN, "generated envelopeRef");
      const nowIso = iso(nowMs);
      const envelope = buildWakeContinuationEnvelope({
        envelopeRef,
        pendingWork: currentPending,
        createdAt: nowIso,
      });
      if (envelope.body.length > this.config.maxContinuationBodyCharacters) {
        throw new Error("Wake continuation envelope exceeds the configured body limit.");
      }
      const computedWakeKey = wakeKey({
        targetExecutionScopeRef: pending.targetExecutionScopeRef,
        missionRef: pending.missionRef,
        pendingWorkId: pending.pendingWorkId,
        pendingWorkGeneration: pending.generation,
        pendingWorkSemanticDigestSha256: pending.semanticDigestSha256,
        sessionUiBindingRef: readiness.sessionUiBindingRef,
        bindingGeneration: readiness.bindingGeneration,
        attemptSequence,
      });
      const permit = {
        schemaVersion: 1 as const,
        permitRef,
        wakeKey: computedWakeKey,
        actorScopeRef: actor.scopeRef,
        targetExecutionScopeRef: pending.targetExecutionScopeRef,
        missionRef: pending.missionRef,
        pendingWorkId: pending.pendingWorkId,
        pendingWorkGeneration: pending.generation,
        pendingWorkSemanticDigestSha256: pending.semanticDigestSha256,
        attemptSequence,
        readinessAssessmentRef: readiness.assessmentRef,
        sessionUiBindingRef: readiness.sessionUiBindingRef,
        bindingGeneration: readiness.bindingGeneration,
        observationRef: readiness.observationRef,
        evidenceDigestSha256: readiness.evidenceDigestSha256,
        generationBoundaryRefBefore: readiness.generationBoundaryRefBefore,
        recoveryTier: "minimal_continuation" as const,
        allowedEffect: "submit_correlated_continuation" as const,
        forbiddenEffects: [
          "stop_generation",
          "regenerate_response",
          "reload_page",
          "open_duplicate_conversation",
          "navigate_away",
          "publish",
          "repeat_external_effect",
        ] as const,
        envelope,
        issuedAt: nowIso,
        expiresAt: iso(nowMs + this.config.wakePermitTtlMs),
        authority: EXECUTION_WAKE_COORDINATION_AUTHORITY,
      };
      const cooldownUntil = iso(nowMs + this.config.minimumCooldownMs);
      const attempt: WakeAttempt = {
        schemaVersion: 1,
        attemptId,
        wakeKey: computedWakeKey,
        idempotencyKeyDigestSha256: sha256(idempotencyKey),
        actorScopeRef: actor.scopeRef,
        targetExecutionScopeRef: pending.targetExecutionScopeRef,
        missionRef: pending.missionRef,
        pendingWorkId: pending.pendingWorkId,
        pendingWorkGeneration: pending.generation,
        pendingWorkSemanticDigestSha256: pending.semanticDigestSha256,
        attemptSequence,
        state: "prepared",
        revision: 1,
        permit,
        readiness,
        createdAt: nowIso,
        updatedAt: nowIso,
        cooldownUntil,
        authority: EXECUTION_WAKE_COORDINATION_AUTHORITY,
      };
      const attemptDigest = sha256(canonicalJson(attempt));
      this.store.insertAttempt(attempt, attemptDigest);
      this.auditAttempt(actor.scopeRef, attempt, "wake_attempt_prepared", undefined, nowMs);

      const pendingNext: WakePendingWorkRecord = {
        ...currentPending,
        state: "wake_inflight",
        revision: currentPending.revision + 1,
        latestAttemptId: attempt.attemptId,
        latestAttemptSequence: attemptSequence,
        updatedAt: nowIso,
        holdReasonCodes: [],
      };
      const pendingDigest = sha256(canonicalJson(pendingNext));
      const pendingSave = this.store.compareAndSwapPendingWork(
        pendingNext,
        currentPending.revision,
        pendingDigest,
      );
      if (!pendingSave.saved) throw revisionConflict("pending work", pendingSave.current);
      this.auditPending(
        actor.scopeRef,
        pendingNext,
        "pending_work_wake_inflight",
        currentPending.state,
        nowMs,
      );

      const preparedThrottle = prepareThrottle(
        currentThrottle,
        attempt,
        nowMs,
        this.config,
      );
      this.saveThrottle(
        actor.scopeRef,
        currentThrottle,
        preparedThrottle,
        "wake_attempt_counted",
        nowMs,
      );
      const nextCommandResultJson = JSON.stringify({
        schemaVersion: 1,
        kind: "attempt",
        attemptId: attempt.attemptId,
      } satisfies StoredExecutionCommandPointer);
      const commandSaved = this.store.compareAndSwapCommandResult({
        actorScopeRef: actor.scopeRef,
        idempotencyKey,
        commandKind,
        payloadDigestSha256: commandDigest,
        expectedResultJson: reservationResultJson,
        nextResultJson: nextCommandResultJson,
      });
      if (!commandSaved) {
        throw new Error("Wake execution command reservation CAS failed before dispatch.");
      }
      return attempt;
    });
    return transaction.immediate();
  }

  private async dispatchPreparedAttempt(
    actor: ExecutionScopeIdentity,
    preparedInput: WakeAttempt,
    leaseInput?: WakeLease,
  ): Promise<WakeExecutionResult> {
    let prepared = this.requireAttempt(preparedInput.attemptId);
    if (prepared.state !== "prepared") return this.executionResultForAttempt(prepared, true);
    const nowMs = this.now();
    if (Date.parse(prepared.permit.expiresAt) <= nowMs) {
      const held = this.finalizePreparedWithoutDispatch(
        actor.scopeRef,
        prepared,
        "WAKE_PERMIT_EXPIRED_BEFORE_DISPATCH",
        nowMs,
      );
      return this.executionResultForAttempt(held, true);
    }

    const resourceRef = wakeResourceRef(
      prepared.targetExecutionScopeRef,
      prepared.missionRef,
    );
    let lease = leaseInput;
    let leaseOwnedHere = false;
    if (!lease) {
      const leaseId = this.idFactory("wls");
      requireId(leaseId, LEASE_ID_PATTERN, "generated wake lease ID");
      const claim = this.store.claimLease({
        resourceRef,
        leaseId,
        holderScopeRef: actor.scopeRef,
        targetExecutionScopeRef: prepared.targetExecutionScopeRef,
        missionRef: prepared.missionRef,
        pendingWorkId: prepared.pendingWorkId,
        nowMs,
        ttlMs: this.config.wakeLeaseTtlMs,
      });
      if (!claim.acquired || !claim.lease) {
        return this.executionResultForAttempt(prepared, true, ["WAKE_LEASE_BUSY"]);
      }
      lease = claim.lease;
      leaseOwnedHere = true;
    }

    try {
      const dispatching: WakeAttempt = {
        ...prepared,
        state: "dispatching",
        revision: prepared.revision + 1,
        updatedAt: iso(this.now()),
        dispatchStartedAt: iso(this.now()),
      };
      const dispatchingDigest = sha256(canonicalJson(dispatching));
      const save = this.store.compareAndSwapAttempt(
        dispatching,
        prepared.revision,
        dispatchingDigest,
      );
      if (!save.saved) {
        const current = save.current;
        if (!current) throw new Error("Wake attempt disappeared before dispatch.");
        return this.executionResultForAttempt(current, true);
      }
      prepared = dispatching;
      this.auditAttempt(
        actor.scopeRef,
        dispatching,
        "wake_attempt_dispatching",
        "prepared",
        this.now(),
      );

      let lowerResult: WakeLowerPlaneDispatchResult;
      try {
        lowerResult = await this.lowerPlane.consumeWakePermit(dispatching.permit);
      } catch {
        lowerResult = {
          schemaVersion: 1,
          permitRef: dispatching.permit.permitRef,
          disposition: "indeterminate",
          interactionSessionRef: dispatching.permit.sessionUiBindingRef,
          verificationRefs: [],
          failureCode: "LOWER_PLANE_TRANSPORT_LOST_AFTER_DISPATCH_BOUNDARY",
          completedAt: iso(this.now()),
        };
      }
      return this.finalizeDispatch(actor.scopeRef, dispatching, lowerResult, this.now());
    } finally {
      if (leaseOwnedHere && lease) {
        this.store.releaseLease({
          resourceRef,
          leaseId: lease.leaseId,
          holderScopeRef: actor.scopeRef,
        });
      }
    }
  }

  private finalizeDispatch(
    actorScopeRef: string,
    dispatching: WakeAttempt,
    lowerResult: WakeLowerPlaneDispatchResult,
    nowMs: number,
  ): WakeExecutionResult {
    const validationReasons = validateVerifiedDispatchResult(
      dispatching.permit,
      lowerResult,
    );
    let state: WakeAttemptState;
    let failureCode = lowerResult.failureCode;
    if (lowerResult.disposition === "verified" && validationReasons.length === 0) {
      state = "verified";
    } else if (lowerResult.disposition === "failed_no_effect"
      && validationReasons.length === 0) {
      state = "failed_no_effect";
    } else {
      state = "indeterminate";
      failureCode = failureCode
        ?? (validationReasons.length > 0
          ? `LOWER_PLANE_RESULT_INVALID:${validationReasons.join(",")}`
          : "LOWER_PLANE_REPORTED_INDETERMINATE");
    }
    const terminal = state !== "indeterminate";
    const cooldownMs = state === "failed_no_effect"
      ? noEffectCooldownMs(
          this.currentThrottle(
            dispatching.targetExecutionScopeRef,
            dispatching.missionRef,
            nowMs,
          ).consecutiveNoEffectCount + 1,
          this.config,
        )
      : this.config.minimumCooldownMs;
    const next: WakeAttempt = {
      ...dispatching,
      state,
      revision: dispatching.revision + 1,
      lowerPlaneResult: lowerResult,
      failureCode,
      updatedAt: iso(nowMs),
      terminalAt: terminal ? iso(nowMs) : undefined,
      cooldownUntil: iso(nowMs + cooldownMs),
    };
    const transaction = this.database.sqlite.transaction(() => {
      const current = this.requireAttempt(dispatching.attemptId);
      requireRevision(current.revision, dispatching.revision, "wake attempt");
      const digest = sha256(canonicalJson(next));
      const save = this.store.compareAndSwapAttempt(next, current.revision, digest);
      if (!save.saved) throw revisionConflict("wake attempt", save.current);
      this.auditAttempt(
        actorScopeRef,
        next,
        `wake_attempt_${state}`,
        current.state,
        nowMs,
      );
      this.reconcilePendingAndThrottle(actorScopeRef, current, next, nowMs);
    });
    transaction.immediate();
    return this.executionResultForAttempt(next, false, validationReasons);
  }

  private reconcilePendingAndThrottle(
    actorScopeRef: string,
    previousAttempt: WakeAttempt,
    attempt: WakeAttempt,
    nowMs: number,
  ): void {
    const pending = this.store.pendingWork(attempt.pendingWorkId);
    if (pending
      && pending.generation === attempt.pendingWorkGeneration
      && !["consumed", "superseded"].includes(pending.state)) {
      let pendingState: WakePendingWorkRecord["state"] = pending.state;
      let holdReasonCodes = pending.holdReasonCodes;
      let wakeVerifiedAt = pending.wakeVerifiedAt;
      if (["verified", "reconciled_effect_verified"].includes(attempt.state)) {
        pendingState = "wake_verified";
        wakeVerifiedAt = iso(nowMs);
        holdReasonCodes = [];
      } else if (["failed_no_effect", "reconciled_effect_absent", "held"].includes(attempt.state)) {
        pendingState = Date.parse(pending.expiresAt) <= nowMs ? "expired" : "pending";
        holdReasonCodes = attempt.state === "held"
          ? uniqueSorted([...holdReasonCodes, attempt.failureCode ?? "WAKE_ATTEMPT_HELD"])
          : [];
      } else if (attempt.state === "indeterminate") {
        pendingState = "held";
        holdReasonCodes = uniqueSorted([
          ...holdReasonCodes,
          `UNRECONCILED_INDETERMINATE_ATTEMPT:${attempt.attemptId}`,
        ]);
      }
      const pendingNext: WakePendingWorkRecord = {
        ...pending,
        state: pendingState,
        revision: pending.revision + 1,
        latestAttemptId: attempt.attemptId,
        latestAttemptSequence: attempt.attemptSequence,
        updatedAt: iso(nowMs),
        wakeVerifiedAt,
        heldAt: pendingState === "held" ? iso(nowMs) : pending.heldAt,
        holdReasonCodes,
      };
      const pendingDigest = sha256(canonicalJson(pendingNext));
      const save = this.store.compareAndSwapPendingWork(
        pendingNext,
        pending.revision,
        pendingDigest,
      );
      if (!save.saved) throw revisionConflict("pending work", save.current);
      this.auditPending(
        actorScopeRef,
        pendingNext,
        `pending_work_after_${attempt.state}`,
        pending.state,
        nowMs,
      );
    }

    const currentThrottle = this.currentThrottle(
      attempt.targetExecutionScopeRef,
      attempt.missionRef,
      nowMs,
    );
    const nextThrottle = finalizeThrottle(
      currentThrottle,
      previousAttempt,
      attempt,
      nowMs,
      this.config,
    );
    this.saveThrottle(
      actorScopeRef,
      currentThrottle,
      nextThrottle,
      `wake_throttle_after_${attempt.state}`,
      nowMs,
    );
  }

  private finalizePreparedWithoutDispatch(
    actorScopeRef: string,
    prepared: WakeAttempt,
    failureCode: string,
    nowMs: number,
  ): WakeAttempt {
    const next: WakeAttempt = {
      ...prepared,
      state: "held",
      revision: prepared.revision + 1,
      failureCode,
      updatedAt: iso(nowMs),
      terminalAt: iso(nowMs),
      cooldownUntil: iso(nowMs + this.config.minimumCooldownMs),
    };
    const transaction = this.database.sqlite.transaction(() => {
      const current = this.requireAttempt(prepared.attemptId);
      requireRevision(current.revision, prepared.revision, "wake attempt");
      const digest = sha256(canonicalJson(next));
      const save = this.store.compareAndSwapAttempt(next, current.revision, digest);
      if (!save.saved) throw revisionConflict("wake attempt", save.current);
      this.auditAttempt(
        actorScopeRef,
        next,
        "wake_attempt_held_before_dispatch",
        current.state,
        nowMs,
      );
      this.reconcilePendingAndThrottle(actorScopeRef, current, next, nowMs);
    });
    transaction.immediate();
    return next;
  }

  private async resumeStoredExecution(
    actor: ExecutionScopeIdentity,
    storedJson: string,
  ): Promise<WakeExecutionResult> {
    const pointer = JSON.parse(storedJson) as StoredExecutionCommandPointer;
    if (pointer.kind === "result" && pointer.result) {
      return { ...pointer.result, idempotentReplay: true };
    }
    if (pointer.kind !== "attempt" || !pointer.attemptId) {
      throw new Error("Invalid stored wake execution command pointer.");
    }
    const attempt = this.requireAttempt(pointer.attemptId);
    if (attempt.actorScopeRef !== actor.scopeRef) {
      throw new Error("Stored wake attempt actor does not match the current scope.");
    }
    if (attempt.state === "prepared") {
      return this.dispatchPreparedAttempt(actor, attempt);
    }
    if (attempt.state === "dispatching") {
      const lease = this.store.lease(
        wakeResourceRef(attempt.targetExecutionScopeRef, attempt.missionRef),
      );
      if (!lease || Date.parse(lease.expiresAt) <= this.now()) {
        const recovered = this.markDispatchingIndeterminate(
          actor.scopeRef,
          attempt,
          this.now(),
          "DISPATCHING_ATTEMPT_LOST_WAKE_LEASE",
        );
        return this.executionResultForAttempt(recovered, true);
      }
    }
    return this.executionResultForAttempt(attempt, true);
  }

  private recoverStalledAttemptsInternal(
    targetExecutionScopeRef: string,
    missionRef: string,
    nowMs: number,
    actorScopeRef: string,
  ): WakeAttempt[] {
    const recovered: WakeAttempt[] = [];
    for (const attempt of this.store.attempts(targetExecutionScopeRef, missionRef)) {
      if (attempt.state === "prepared" && Date.parse(attempt.permit.expiresAt) <= nowMs) {
        recovered.push(this.finalizePreparedWithoutDispatch(
          actorScopeRef,
          attempt,
          "WAKE_PERMIT_EXPIRED_DURING_RECOVERY",
          nowMs,
        ));
      } else if (attempt.state === "dispatching") {
        const lease = this.store.lease(
          wakeResourceRef(targetExecutionScopeRef, missionRef),
        );
        if (!lease || Date.parse(lease.expiresAt) <= nowMs) {
          recovered.push(this.markDispatchingIndeterminate(
            actorScopeRef,
            attempt,
            nowMs,
            "DISPATCHING_ATTEMPT_HAS_NO_ACTIVE_WAKE_LEASE",
          ));
        }
      }
    }
    return recovered;
  }

  private markDispatchingIndeterminate(
    actorScopeRef: string,
    dispatching: WakeAttempt,
    nowMs: number,
    failureCode: string,
  ): WakeAttempt {
    const next: WakeAttempt = {
      ...dispatching,
      state: "indeterminate",
      revision: dispatching.revision + 1,
      failureCode,
      updatedAt: iso(nowMs),
      terminalAt: undefined,
      cooldownUntil: iso(nowMs + this.config.indeterminateHumanHoldMs),
    };
    const transaction = this.database.sqlite.transaction(() => {
      const current = this.requireAttempt(dispatching.attemptId);
      if (current.state !== "dispatching") return current;
      requireRevision(current.revision, dispatching.revision, "wake attempt");
      const digest = sha256(canonicalJson(next));
      const save = this.store.compareAndSwapAttempt(next, current.revision, digest);
      if (!save.saved) throw revisionConflict("wake attempt", save.current);
      this.auditAttempt(
        actorScopeRef,
        next,
        "wake_attempt_recovered_indeterminate",
        current.state,
        nowMs,
      );
      this.reconcilePendingAndThrottle(actorScopeRef, current, next, nowMs);
      return next;
    });
    return transaction.immediate();
  }

  private executionResultForAttempt(
    attempt: WakeAttempt,
    idempotentReplay: boolean,
    additionalReasons: string[] = [],
  ): WakeExecutionResult {
    let decision: WakeScheduleAssessment["decision"] = "HOLD";
    if (["prepared", "dispatching"].includes(attempt.state)) decision = "IN_FLIGHT";
    if (["verified", "reconciled_effect_verified"].includes(attempt.state)) {
      decision = "ALREADY_VERIFIED";
    }
    if (attempt.state === "failed_no_effect"
      || attempt.state === "reconciled_effect_absent"
      || attempt.state === "held") {
      decision = "COOLDOWN";
    }
    const pending = this.store.pendingWork(attempt.pendingWorkId);
    return {
      schemaVersion: 1,
      assessment: {
        schemaVersion: 1,
        decision,
        targetExecutionScopeRef: attempt.targetExecutionScopeRef,
        missionRef: attempt.missionRef,
        pendingWork: pending,
        readiness: attempt.readiness,
        throttle: this.currentThrottle(
          attempt.targetExecutionScopeRef,
          attempt.missionRef,
          this.now(),
        ),
        reasonCodes: uniqueSorted([
          `WAKE_ATTEMPT_STATE:${attempt.state}`,
          ...(attempt.failureCode ? [attempt.failureCode] : []),
          ...additionalReasons,
        ]),
        assessedAt: iso(this.now()),
        authority: EXECUTION_WAKE_COORDINATION_AUTHORITY,
      },
      attempt,
      idempotentReplay,
      authority: EXECUTION_WAKE_COORDINATION_AUTHORITY,
    };
  }

  private currentThrottle(
    targetExecutionScopeRef: string,
    missionRef: string,
    nowMs: number,
  ): WakeTargetThrottle {
    const stored = this.store.throttle(targetExecutionScopeRef, missionRef);
    if (!stored) return initialThrottle(targetExecutionScopeRef, missionRef, nowMs);
    return materializeThrottle(stored, nowMs, this.config);
  }

  private saveThrottle(
    actorScopeRef: string,
    current: WakeTargetThrottle,
    next: WakeTargetThrottle,
    action: string,
    nowMs: number,
    detail?: Record<string, unknown>,
  ): void {
    const digest = sha256(canonicalJson(next));
    const persisted = this.store.throttle(
      current.targetExecutionScopeRef,
      current.missionRef,
    );
    if (!persisted) {
      if (current.revision !== 0) {
        throw new Error("Wake throttle disappeared before persistence.");
      }
      this.store.putThrottle(next, digest);
    } else {
      const save = this.store.compareAndSwapThrottle(next, persisted.revision, digest);
      if (!save.saved) throw revisionConflict("wake throttle", save.current);
    }
    this.store.appendAudit({
      entityType: "throttle",
      entityId: wakeResourceRef(next.targetExecutionScopeRef, next.missionRef),
      actorScopeRef,
      action,
      fromState: current.state,
      toState: next.state,
      revision: next.revision,
      payloadDigestSha256: digest,
      detailJson: detail ? JSON.stringify(detail) : undefined,
      recordedAtMs: nowMs,
    });
  }

  private requirePendingWork(pendingWorkId: string): WakePendingWorkRecord {
    const record = this.store.pendingWork(pendingWorkId);
    if (!record) throw new Error(`Unknown wake pending work: ${pendingWorkId}`);
    return record;
  }

  private requireAttempt(attemptId: string): WakeAttempt {
    const attempt = this.store.attempt(attemptId);
    if (!attempt) throw new Error(`Unknown wake attempt: ${attemptId}`);
    return attempt;
  }

  private mutate<T>(
    actor: ExecutionScopeIdentity,
    idempotencyKeyValue: string,
    commandKind: string,
    normalizedPayload: unknown,
    operation: (nowMs: number) => T,
  ): WakeMutationResult<T> {
    const idempotencyKey = requireIdempotencyKey(idempotencyKeyValue);
    const nowMs = this.now();
    this.maybeCleanup(nowMs);
    const payloadDigestSha256 = sha256(canonicalJson({ commandKind, normalizedPayload }));
    const transaction = this.database.sqlite.transaction(() => {
      const existing = this.store.command(actor.scopeRef, idempotencyKey);
      if (existing) {
        if (existing.commandKind !== commandKind
          || existing.payloadDigestSha256 !== payloadDigestSha256) {
          throw new Error("The idempotencyKey was already used with a different wake command.");
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
        actorScopeRef: actor.scopeRef,
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

  private storeExecutionCommandResult(
    actorScopeRef: string,
    idempotencyKey: string,
    commandKind: string,
    commandDigest: string,
    pointer: StoredExecutionCommandPointer,
    nowMs: number,
    expectedReservationResultJson?: string,
  ): boolean {
    const existing = this.store.command(actorScopeRef, idempotencyKey);
    if (existing) {
      if (existing.commandKind !== commandKind
        || existing.payloadDigestSha256 !== commandDigest) {
        throw new Error("The idempotencyKey was already used with a different wake command.");
      }
      if (!expectedReservationResultJson) return true;
      const saved = this.store.compareAndSwapCommandResult({
        actorScopeRef,
        idempotencyKey,
        commandKind,
        payloadDigestSha256: commandDigest,
        expectedResultJson: expectedReservationResultJson,
        nextResultJson: JSON.stringify(pointer),
      });
      return saved;
    }
    if (expectedReservationResultJson) {
      return false;
    }
    this.store.insertCommand({
      actorScopeRef,
      idempotencyKey,
      commandKind,
      payloadDigestSha256: commandDigest,
      resultJson: JSON.stringify(pointer),
      createdAtMs: nowMs,
    });
    return true;
  }

  private async resumeCurrentExecutionCommand(
    actor: ExecutionScopeIdentity,
    idempotencyKey: string,
    commandKind: string,
    commandDigest: string,
    targetExecutionScopeRef: string,
    missionRef: string,
  ): Promise<WakeExecutionResult> {
    const current = this.store.command(actor.scopeRef, idempotencyKey);
    if (!current) {
      return this.reservationInFlightResult(
        targetExecutionScopeRef,
        missionRef,
        true,
      );
    }
    if (current.commandKind !== commandKind
      || current.payloadDigestSha256 !== commandDigest) {
      throw new Error("The idempotencyKey was replaced by a different wake command.");
    }
    const pointer = JSON.parse(current.resultJson) as StoredExecutionCommandPointer;
    if (pointer.kind === "reservation") {
      return this.reservationInFlightResult(
        targetExecutionScopeRef,
        missionRef,
        true,
      );
    }
    return this.resumeStoredExecution(actor, current.resultJson);
  }

  private reserveExecutionCommand(
    actorScopeRef: string,
    idempotencyKey: string,
    commandKind: string,
    commandDigest: string,
    normalized: {
      targetExecutionScopeRef: string;
      missionRef: string;
    },
    nowMs: number,
  ): {
    owned: boolean;
    pointer: StoredExecutionCommandPointer;
    resultJson: string;
  } {
    const transaction = this.database.sqlite.transaction(() => {
      const current = this.store.command(actorScopeRef, idempotencyKey);
      if (current) {
        if (current.commandKind !== commandKind
          || current.payloadDigestSha256 !== commandDigest) {
          throw new Error("The idempotencyKey was already used with a different wake command.");
        }
        const pointer = JSON.parse(current.resultJson) as StoredExecutionCommandPointer;
        if (pointer.kind !== "reservation") {
          return { owned: false, pointer, resultJson: current.resultJson };
        }
        const reservedAtMs = pointer.reservedAt ? Date.parse(pointer.reservedAt) : Number.NaN;
        if (Number.isFinite(reservedAtMs)
          && nowMs - reservedAtMs < this.config.executionCommandReservationTtlMs) {
          return { owned: false, pointer, resultJson: current.resultJson };
        }
        const replacement: StoredExecutionCommandPointer = {
          schemaVersion: 1,
          kind: "reservation",
          reservationRef: `reservation:${randomUUID()}`,
          reservedAt: iso(nowMs),
          targetExecutionScopeRef: normalized.targetExecutionScopeRef,
          missionRef: normalized.missionRef,
        };
        const replacementJson = JSON.stringify(replacement);
        const saved = this.store.compareAndSwapCommandResult({
          actorScopeRef,
          idempotencyKey,
          commandKind,
          payloadDigestSha256: commandDigest,
          expectedResultJson: current.resultJson,
          nextResultJson: replacementJson,
        });
        if (!saved) {
          const latest = this.store.command(actorScopeRef, idempotencyKey);
          if (!latest) throw new Error("Wake command reservation disappeared during takeover.");
          const latestPointer = JSON.parse(latest.resultJson) as StoredExecutionCommandPointer;
          return { owned: false, pointer: latestPointer, resultJson: latest.resultJson };
        }
        return { owned: true, pointer: replacement, resultJson: replacementJson };
      }
      const pointer: StoredExecutionCommandPointer = {
        schemaVersion: 1,
        kind: "reservation",
        reservationRef: `reservation:${randomUUID()}`,
        reservedAt: iso(nowMs),
        targetExecutionScopeRef: normalized.targetExecutionScopeRef,
        missionRef: normalized.missionRef,
      };
      const resultJson = JSON.stringify(pointer);
      this.store.insertCommand({
        actorScopeRef,
        idempotencyKey,
        commandKind,
        payloadDigestSha256: commandDigest,
        resultJson,
        createdAtMs: nowMs,
      });
      return { owned: true, pointer, resultJson };
    });
    return transaction.immediate();
  }

  private reservationInFlightResult(
    targetExecutionScopeRef: string,
    missionRef: string,
    idempotentReplay: boolean,
  ): WakeExecutionResult {
    return {
      schemaVersion: 1,
      assessment: {
        schemaVersion: 1,
        decision: "IN_FLIGHT",
        targetExecutionScopeRef,
        missionRef,
        pendingWork: this.store.currentPendingWork(targetExecutionScopeRef, missionRef),
        throttle: this.currentThrottle(targetExecutionScopeRef, missionRef, this.now()),
        reasonCodes: ["IDEMPOTENT_WAKE_COMMAND_RESERVATION_ACTIVE"],
        assessedAt: iso(this.now()),
        authority: EXECUTION_WAKE_COORDINATION_AUTHORITY,
      },
      idempotentReplay,
      authority: EXECUTION_WAKE_COORDINATION_AUTHORITY,
    };
  }

  private auditPending(
    actorScopeRef: string,
    record: WakePendingWorkRecord,
    action: string,
    fromState: string | undefined,
    nowMs: number,
  ): void {
    this.store.appendAudit({
      entityType: "pending_work",
      entityId: record.pendingWorkId,
      actorScopeRef,
      action,
      fromState,
      toState: record.state,
      revision: record.revision,
      payloadDigestSha256: sha256(canonicalJson(record)),
      recordedAtMs: nowMs,
    });
  }

  private auditAttempt(
    actorScopeRef: string,
    attempt: WakeAttempt,
    action: string,
    fromState: string | undefined,
    nowMs: number,
  ): void {
    this.store.appendAudit({
      entityType: "attempt",
      entityId: attempt.attemptId,
      actorScopeRef,
      action,
      fromState,
      toState: attempt.state,
      revision: attempt.revision,
      payloadDigestSha256: sha256(canonicalJson(attempt)),
      recordedAtMs: nowMs,
    });
  }

  private maybeCleanup(nowMs: number): void {
    if (nowMs - this.lastCleanupAtMs < this.config.cleanupIntervalMs) return;
    const retention: ExecutionWakeCoordinationRetention = {
      pendingWorkRetentionMs: this.config.pendingWorkRetentionMs,
      attemptRetentionMs: this.config.attemptRetentionMs,
      commandRetentionMs: this.config.commandRetentionMs,
      auditRetentionMs: this.config.auditRetentionMs,
    };
    this.store.cleanup(nowMs, retention);
    this.lastCleanupAtMs = nowMs;
  }

  private reference(value: string, name: string): string {
    const normalized = value.trim();
    if (!normalized) throw new Error(`${name} must not be empty.`);
    if (normalized.length > this.config.maxReferenceCharacters) {
      throw new Error(`${name} exceeds the ${this.config.maxReferenceCharacters}-character limit.`);
    }
    return normalized;
  }

  private references(values: string[], name: string): string[] {
    if (values.length > this.config.maxReferencesPerField) {
      throw new Error(`${name} exceeds the ${this.config.maxReferencesPerField}-item limit.`);
    }
    return uniqueSorted(values.map((value, index) =>
      this.reference(value, `${name}[${index}]`)));
  }

  private assertEnabled(): void {
    if (!this.config.enabled) throw new Error("Execution wake coordination is disabled.");
    if (this.closed) throw new Error("Execution wake coordination manager is closed.");
  }
}

function scheduleAssessment(
  decision: WakeScheduleAssessment["decision"],
  targetExecutionScopeRef: string,
  missionRef: string,
  nowMs: number,
  reasons: Set<string>,
  pendingWork?: WakePendingWorkRecord,
  readiness?: LowerPlaneWakeReadiness,
  throttle?: WakeTargetThrottle,
  nextAttemptSequence?: number,
): WakeScheduleAssessment {
  return {
    schemaVersion: 1,
    decision,
    targetExecutionScopeRef,
    missionRef,
    pendingWork,
    readiness,
    throttle,
    nextAttemptSequence,
    reasonCodes: [...reasons].sort(),
    assessedAt: iso(nowMs),
    authority: EXECUTION_WAKE_COORDINATION_AUTHORITY,
  };
}

function materializePendingWork(
  record: WakePendingWorkRecord,
  nowMs: number,
): WakePendingWorkRecord {
  if (["pending", "wake_inflight"].includes(record.state)
    && Date.parse(record.expiresAt) <= nowMs) {
    return { ...record, state: "expired" };
  }
  return record;
}

function initialThrottle(
  targetExecutionScopeRef: string,
  missionRef: string,
  nowMs: number,
): WakeTargetThrottle {
  return {
    schemaVersion: 1,
    targetExecutionScopeRef,
    missionRef,
    revision: 0,
    state: "ready",
    automaticAttemptCount: 0,
    consecutiveNoEffectCount: 0,
    cooldownUntil: iso(nowMs),
    holdReasonCodes: [],
    updatedAt: iso(nowMs),
    authority: EXECUTION_WAKE_COORDINATION_AUTHORITY,
  };
}

function materializeThrottle(
  throttle: WakeTargetThrottle,
  nowMs: number,
  config: ExecutionWakeCoordinationConfig,
): WakeTargetThrottle {
  if (throttle.state === "cooldown" && Date.parse(throttle.cooldownUntil) <= nowMs) {
    return {
      ...throttle,
      state: "ready",
      cooldownUntil: iso(nowMs),
      holdReasonCodes: [],
    };
  }
  if (throttle.state === "loop_guard"
    && throttle.holdUntil
    && Date.parse(throttle.holdUntil) <= nowMs) {
    return {
      ...throttle,
      state: "ready",
      automaticAttemptWindowStartedAt: iso(nowMs),
      automaticAttemptCount: 0,
      consecutiveNoEffectCount: 0,
      cooldownUntil: iso(nowMs),
      holdUntil: undefined,
      holdReasonCodes: [],
    };
  }
  if (throttle.automaticAttemptWindowStartedAt
    && nowMs - Date.parse(throttle.automaticAttemptWindowStartedAt)
      >= config.automaticAttemptWindowMs
    && throttle.state === "ready") {
    return {
      ...throttle,
      automaticAttemptWindowStartedAt: iso(nowMs),
      automaticAttemptCount: 0,
      consecutiveNoEffectCount: 0,
    };
  }
  return throttle;
}

function prepareThrottle(
  current: WakeTargetThrottle,
  attempt: WakeAttempt,
  nowMs: number,
  config: ExecutionWakeCoordinationConfig,
): WakeTargetThrottle {
  const windowExpired = !current.automaticAttemptWindowStartedAt
    || nowMs - Date.parse(current.automaticAttemptWindowStartedAt)
      >= config.automaticAttemptWindowMs;
  const automaticAttemptCount = (windowExpired ? 0 : current.automaticAttemptCount) + 1;
  return {
    ...current,
    revision: current.revision + 1,
    state: "cooldown",
    automaticAttemptWindowStartedAt: windowExpired
      ? iso(nowMs)
      : current.automaticAttemptWindowStartedAt,
    automaticAttemptCount,
    lastAttemptId: attempt.attemptId,
    lastAttemptState: attempt.state,
    lastPendingWorkId: attempt.pendingWorkId,
    lastPendingWorkGeneration: attempt.pendingWorkGeneration,
    cooldownUntil: iso(nowMs + config.minimumCooldownMs),
    holdUntil: undefined,
    holdReasonCodes: [],
    updatedAt: iso(nowMs),
  };
}

function finalizeThrottle(
  current: WakeTargetThrottle,
  previousAttempt: WakeAttempt,
  attempt: WakeAttempt,
  nowMs: number,
  config: ExecutionWakeCoordinationConfig,
): WakeTargetThrottle {
  let state: WakeTargetThrottle["state"] = "cooldown";
  let cooldownMs = config.minimumCooldownMs;
  let holdUntil: string | undefined;
  let holdReasonCodes: string[] = [];
  let consecutiveNoEffectCount = current.consecutiveNoEffectCount;
  if (["verified", "reconciled_effect_verified"].includes(attempt.state)) {
    consecutiveNoEffectCount = 0;
  } else if (["failed_no_effect", "reconciled_effect_absent", "held"].includes(attempt.state)) {
    consecutiveNoEffectCount += 1;
    cooldownMs = noEffectCooldownMs(consecutiveNoEffectCount, config);
    if (attempt.attemptSequence >= config.maximumAutomaticAttemptsPerPendingWork
      || current.automaticAttemptCount >= config.maximumAutomaticAttemptsPerWindow) {
      state = "loop_guard";
      holdUntil = iso(nowMs + config.loopGuardHoldMs);
      holdReasonCodes = ["AUTOMATIC_WAKE_LOOP_GUARD"];
    }
  } else if (attempt.state === "indeterminate") {
    state = "human_hold";
    holdUntil = iso(nowMs + config.indeterminateHumanHoldMs);
    holdReasonCodes = [
      `UNRECONCILED_INDETERMINATE_ATTEMPT:${attempt.attemptId}`,
    ];
  }
  return {
    ...current,
    revision: current.revision + 1,
    state,
    consecutiveNoEffectCount,
    lastAttemptId: attempt.attemptId,
    lastAttemptState: attempt.state,
    lastPendingWorkId: attempt.pendingWorkId,
    lastPendingWorkGeneration: attempt.pendingWorkGeneration,
    lastVerifiedGenerationBoundaryRef: [
      "verified",
      "reconciled_effect_verified",
    ].includes(attempt.state)
      ? attempt.lowerPlaneResult?.generationBoundaryRefAfter
      : current.lastVerifiedGenerationBoundaryRef,
    cooldownUntil: iso(nowMs + cooldownMs),
    holdUntil,
    holdReasonCodes,
    updatedAt: iso(nowMs),
  };
}

function noEffectCooldownMs(
  consecutiveNoEffectCount: number,
  config: ExecutionWakeCoordinationConfig,
): number {
  const multiplier = 2 ** Math.max(0, consecutiveNoEffectCount - 1);
  return Math.min(
    config.maximumCooldownMs,
    config.minimumCooldownMs * multiplier,
  );
}

function wakeResourceRef(targetExecutionScopeRef: string, missionRef: string): string {
  return `wake:${targetExecutionScopeRef}:${sha256(missionRef).slice(0, 16)}`;
}

function requireIdentity(
  identity: ExecutionScopeIdentity | undefined,
): ExecutionScopeIdentity {
  if (!identity) throw new Error("A stable execution scope is required for wake coordination.");
  requireScopeRef(identity.scopeRef);
  return identity;
}

function requireScopeRef(value: string): string {
  if (!SCOPE_REF_PATTERN.test(value)) {
    throw new Error("Execution scope references must be 16 lowercase hexadecimal characters.");
  }
  return value;
}

function requireId(value: string, pattern: RegExp, name: string): string {
  if (!pattern.test(value)) throw new Error(`Invalid ${name}: ${value}`);
  return value;
}

function requireIdempotencyKey(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > IDEMPOTENCY_KEY_MAX) {
    throw new Error(`idempotencyKey must contain 1-${IDEMPOTENCY_KEY_MAX} characters.`);
  }
  return normalized;
}

function requireRevision(current: number, expected: number, name: string): void {
  positiveInteger(expected, "expectedRevision");
  if (current !== expected) {
    throw new Error(`${name} revision mismatch: expected ${expected}, current ${current}.`);
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function wakePriority(value: string): WakePriority {
  if (!["low", "normal", "high", "urgent"].includes(value)) {
    throw new Error(`Invalid wake priority: ${value}`);
  }
  return value as WakePriority;
}

function ttlMs(
  hours: number | undefined,
  defaultMs: number,
  maximumMs: number,
  name: string,
): number {
  if (hours === undefined) return defaultMs;
  if (!Number.isFinite(hours) || hours <= 0) throw new Error(`${name} must be positive.`);
  const value = Math.floor(hours * 60 * 60 * 1_000);
  if (value < 1 || value > maximumMs) {
    throw new Error(`${name} exceeds the allowed lifetime.`);
  }
  return value;
}

function revisionConflict(name: string, current: unknown): Error {
  return new Error(`${name} revision conflict. Current persisted value: ${JSON.stringify(current)}`);
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function validateConfig(config: ExecutionWakeCoordinationConfig): void {
  const positive = [
    "pendingWorkDefaultTtlMs",
    "pendingWorkMaxTtlMs",
    "wakePermitTtlMs",
    "wakeLeaseTtlMs",
    "executionCommandReservationTtlMs",
    "minimumCooldownMs",
    "maximumCooldownMs",
    "automaticAttemptWindowMs",
    "maximumAutomaticAttemptsPerWindow",
    "maximumAutomaticAttemptsPerPendingWork",
    "loopGuardHoldMs",
    "indeterminateHumanHoldMs",
    "pendingWorkRetentionMs",
    "attemptRetentionMs",
    "commandRetentionMs",
    "auditRetentionMs",
    "cleanupIntervalMs",
    "maxReferenceCharacters",
    "maxReferencesPerField",
    "maxContinuationBodyCharacters",
  ] as const;
  for (const key of positive) {
    if (!Number.isInteger(config[key]) || config[key] <= 0) {
      throw new Error(`Execution wake coordination ${key} must be a positive integer.`);
    }
  }
  if (config.pendingWorkDefaultTtlMs > config.pendingWorkMaxTtlMs) {
    throw new Error("pendingWorkDefaultTtlMs cannot exceed pendingWorkMaxTtlMs.");
  }
  if (config.minimumCooldownMs > config.maximumCooldownMs) {
    throw new Error("minimumCooldownMs cannot exceed maximumCooldownMs.");
  }
}
