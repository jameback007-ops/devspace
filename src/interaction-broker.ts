import { randomUUID } from "node:crypto";
import {
  InteractionSession,
  type InteractionActionOutcome,
  type InteractionActionRequest,
  type InteractionAdapter,
  type InteractionApprovalVerifier,
  type InteractionBinding,
  type InteractionCheckpoint,
  type InteractionIntent,
  type InteractionObservation,
  type InteractionReconciliationVerifier,
  type InteractionVerificationResult,
} from "./interaction-harness.js";

export interface InteractionBrokerLease {
  resourceRef: string;
  leaseId: string;
  holderScopeRef: string;
  generation: number;
  acquiredAt: string;
  expiresAt: string;
}

export interface InteractionBrokerLeaseClaim {
  acquired: boolean;
  lease?: InteractionBrokerLease;
  current?: InteractionBrokerLease;
}

export interface InteractionScopeLineageEntry {
  scopeRef: string;
  enteredAt: string;
  handoffRef?: string;
  authorityReadbackRef?: string;
  adoptionVerificationRef?: string;
}

export interface InteractionBrokerRecord {
  schemaVersion: 1;
  sessionRef: string;
  version: number;
  adapterResourceRef: string;
  adapterId: string;
  currentExecutionScopeRef: string;
  scopeLineage: InteractionScopeLineageEntry[];
  checkpoint: InteractionCheckpoint;
  updatedAt: string;
  policy: ReturnType<typeof interactionBrokerPolicy>;
}

export interface InteractionBrokerStore {
  claimLease(input: {
    resourceRef: string;
    leaseId: string;
    holderScopeRef: string;
    nowMs: number;
    ttlMs: number;
  }): Promise<InteractionBrokerLeaseClaim>;
  renewLease(input: {
    resourceRef: string;
    leaseId: string;
    holderScopeRef: string;
    nowMs: number;
    ttlMs: number;
  }): Promise<InteractionBrokerLease | undefined>;
  releaseLease(input: {
    resourceRef: string;
    leaseId: string;
    holderScopeRef: string;
    nowMs: number;
  }): Promise<boolean>;
  loadSession(sessionRef: string): Promise<InteractionBrokerRecord | undefined>;
  compareAndSwapSession(input: {
    record: Omit<InteractionBrokerRecord, "version">;
    expectedVersion: number;
    resourceRef: string;
    leaseId: string;
    holderScopeRef: string;
    nowMs: number;
  }): Promise<{
    saved: boolean;
    record?: InteractionBrokerRecord;
    current?: InteractionBrokerRecord;
    reason?: "lease_missing" | "lease_mismatch" | "version_conflict";
  }>;
}

export interface InteractionBrokerIdentity {
  executionScopeRef: string;
  workspaceId?: string;
  missionRef?: string;
}

export interface InteractionBrokerAdoption {
  priorExecutionScopeRef: string;
  handoffRef: string;
  authorityReadbackRef: string;
}

export interface InteractionBrokerAdoptionVerificationInput {
  sessionRef: string;
  priorExecutionScopeRef: string;
  targetExecutionScopeRef: string;
  handoffRef: string;
  authorityReadbackRef: string;
}

export interface InteractionBrokerAdoptionVerification {
  verified: boolean;
  verificationRef?: string;
}

export type InteractionBrokerAdoptionVerifier = (
  input: InteractionBrokerAdoptionVerificationInput,
) => InteractionBrokerAdoptionVerification;

export interface InteractionBrokerOpenInput {
  store: InteractionBrokerStore;
  adapter: InteractionAdapter;
  identity: InteractionBrokerIdentity;
  sessionRef?: string;
  adoption?: InteractionBrokerAdoption;
  adoptionVerifier?: InteractionBrokerAdoptionVerifier;
  leaseTtlMs?: number;
  now?: () => number;
  idFactory?: (prefix: "ixs" | "obs" | "act") => string;
  approvalVerifier?: InteractionApprovalVerifier;
  reconciliationVerifier?: InteractionReconciliationVerifier;
  leaseIdFactory?: () => string;
}

export interface InteractionBrokerObserveResult {
  observation: InteractionObservation;
  record: InteractionBrokerRecord;
}

export interface InteractionBrokerActionResult {
  started: boolean;
  idempotentReplay: boolean;
  outcome?: InteractionActionOutcome;
  verification?: InteractionVerificationResult;
  record: InteractionBrokerRecord;
}

export interface InteractionBrokerStatus {
  schemaVersion: 1;
  lease: InteractionBrokerLease;
  record: InteractionBrokerRecord;
  adapter: {
    id: string;
    surface: string;
    sessionRef?: string;
    concurrency: string;
  };
  nextAction: string;
  policy: ReturnType<typeof interactionBrokerPolicy>;
}

export class InteractionBrokerError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: {
      checkpoint?: InteractionCheckpoint;
      currentLease?: InteractionBrokerLease;
      currentRecord?: InteractionBrokerRecord;
    } = {},
  ) {
    super(message);
    this.name = "InteractionBrokerError";
  }
}

const DEFAULT_LEASE_TTL_MS = 30_000;
const MIN_LEASE_TTL_MS = 5_000;
const MAX_LEASE_TTL_MS = 10 * 60 * 1_000;
const OPERATION_LEASE_GRACE_MS = 15_000;
const DEFAULT_OBSERVATION_TIMEOUT_MS = 30_000;

export function interactionBrokerPolicy() {
  return {
    authority: "executor_local_interaction_broker_only",
    canonicalTaskAuthority: false,
    canonicalDecisionAuthority: false,
    writerLeaseAuthority: false,
    canonicalEffectOutcomeAuthority: false,
    publicationAuthority: false,
    singleAdapterLeaseRequired: true,
    persistBeforeDispatch: true,
    persistAfterOutcome: true,
    persistAfterVerification: true,
    adapterMustEnforceDeclaredTimeout: true,
    operationLeaseExtendsPastDeclaredTimeout: true,
    scopeAdoptionRequiresExplicitHandoff: true,
    pendingActionRecoveryDisposition: "indeterminate",
    blindReplayAllowed: false,
  } as const;
}

export class InteractionBroker {
  private readonly store: InteractionBrokerStore;
  private readonly adapter: InteractionAdapter;
  private readonly now: () => number;
  private readonly idFactory: InteractionBrokerOpenInput["idFactory"];
  private readonly approvalVerifier: InteractionApprovalVerifier | undefined;
  private readonly reconciliationVerifier:
    | InteractionReconciliationVerifier
    | undefined;
  private readonly leaseTtlMs: number;
  private lease: InteractionBrokerLease;
  private record: InteractionBrokerRecord;
  private session: InteractionSession;
  private closed = false;
  private fenced = false;
  private leaseReleased = false;
  private serializedTail: Promise<void> = Promise.resolve();

  private constructor(input: {
    store: InteractionBrokerStore;
    adapter: InteractionAdapter;
    now: () => number;
    idFactory?: InteractionBrokerOpenInput["idFactory"];
    approvalVerifier?: InteractionApprovalVerifier;
    reconciliationVerifier?: InteractionReconciliationVerifier;
    leaseTtlMs: number;
    lease: InteractionBrokerLease;
    record: InteractionBrokerRecord;
    session: InteractionSession;
  }) {
    this.store = input.store;
    this.adapter = input.adapter;
    this.now = input.now;
    this.idFactory = input.idFactory;
    this.approvalVerifier = input.approvalVerifier;
    this.reconciliationVerifier = input.reconciliationVerifier;
    this.leaseTtlMs = input.leaseTtlMs;
    this.lease = input.lease;
    this.record = input.record;
    this.session = input.session;
  }

  static async open(input: InteractionBrokerOpenInput): Promise<InteractionBroker> {
    validateDescriptorForBroker(input.adapter);
    const now = input.now ?? Date.now;
    const leaseTtlMs = boundedLeaseTtl(input.leaseTtlMs);
    const executionScopeRef = normalizedScopeRef(input.identity.executionScopeRef);
    const resourceRef = interactionAdapterResourceRef(input.adapter);
    const leaseId = input.leaseIdFactory?.()
      ?? `il_${randomUUID().replaceAll("-", "")}`;
    const claim = await input.store.claimLease({
      resourceRef,
      leaseId,
      holderScopeRef: executionScopeRef,
      nowMs: now(),
      ttlMs: leaseTtlMs,
    });
    if (!claim.acquired || !claim.lease) {
      throw new InteractionBrokerError(
        "interaction_adapter_lease_busy",
        "The interaction adapter is already leased by another execution scope.",
        { currentLease: claim.current },
      );
    }

    try {
      const opened = await openOrRestoreSession({
        store: input.store,
        adapter: input.adapter,
        identity: {
          executionScopeRef,
          ...(input.identity.workspaceId
            ? { workspaceId: boundedText(input.identity.workspaceId, "workspaceId", 200) }
            : {}),
          ...(input.identity.missionRef
            ? { missionRef: boundedText(input.identity.missionRef, "missionRef", 1_000) }
            : {}),
        },
        sessionRef: input.sessionRef,
        adoption: input.adoption,
        adoptionVerifier: input.adoptionVerifier,
        resourceRef,
        lease: claim.lease,
        now,
        idFactory: input.idFactory,
        approvalVerifier: input.approvalVerifier,
        reconciliationVerifier: input.reconciliationVerifier,
      });
      return new InteractionBroker({
        store: input.store,
        adapter: input.adapter,
        now,
        idFactory: input.idFactory,
        approvalVerifier: input.approvalVerifier,
        reconciliationVerifier: input.reconciliationVerifier,
        leaseTtlMs,
        lease: claim.lease,
        record: opened.record,
        session: opened.session,
      });
    } catch (error) {
      await input.store.releaseLease({
        resourceRef,
        leaseId,
        holderScopeRef: executionScopeRef,
        nowMs: now(),
      });
      throw error;
    }
  }

  status(): InteractionBrokerStatus {
    this.assertOpen();
    return structuredClone({
      schemaVersion: 1,
      lease: this.lease,
      record: this.record,
      adapter: {
        id: this.adapter.descriptor.id,
        surface: this.adapter.descriptor.surface,
        ...(this.adapter.descriptor.sessionRef
          ? { sessionRef: this.adapter.descriptor.sessionRef }
          : {}),
        concurrency: this.adapter.descriptor.concurrency,
      },
      nextAction: this.record.checkpoint.nextAction,
      policy: interactionBrokerPolicy(),
    });
  }

  async observe(intent: InteractionIntent): Promise<InteractionBrokerObserveResult> {
    return this.serialize(async () => {
      await this.renewLease();
      assertIntentMatchesAdapter(intent, this.adapter);
      await this.renewLeaseForOperation(DEFAULT_OBSERVATION_TIMEOUT_MS);
      const observationInput = await this.adapter.observe({
        identity: this.record.checkpoint.identity,
        intent,
        timeoutMs: DEFAULT_OBSERVATION_TIMEOUT_MS,
      });
      this.session.recordObservation(observationInput);
      await this.persist("observation", false);
      const observation = this.record.checkpoint.observation;
      if (!observation) {
        throw new InteractionBrokerError(
          "interaction_observation_missing_after_persist",
          "The interaction adapter did not establish an observation.",
          { checkpoint: this.record.checkpoint },
        );
      }
      return {
        observation: structuredClone(observation),
        record: structuredClone(this.record),
      };
    });
  }

  async act(
    request: InteractionActionRequest,
  ): Promise<InteractionBrokerActionResult> {
    return this.serialize(async () => {
      await this.renewLease();
      const start = this.session.beginAction(request, this.adapter.descriptor);
      if (!start.started) {
        return {
          started: false,
          idempotentReplay: true,
          record: structuredClone(this.record),
        };
      }

      try {
        await this.renewLeaseForOperation(start.action.timeoutMs);
      } catch (error) {
        this.session = InteractionSession.restore(this.record.checkpoint, {
          now: this.now,
          idFactory: this.idFactory,
          approvalVerifier: this.approvalVerifier,
          reconciliationVerifier: this.reconciliationVerifier,
        });
        throw error;
      }

      // Persist the exact pending action before any external dispatch. A failed
      // pre-dispatch write means no effect was attempted.
      await this.persist("before_dispatch", false);

      let outcome: InteractionActionOutcome;
      try {
        outcome = await this.adapter.act(start.action);
      } catch {
        outcome = {
          actionId: start.action.actionId,
          status: "unknown",
          detailCode: "adapter_transport_lost_after_dispatch",
        };
      }
      this.session.recordActionOutcome(outcome);
      await this.persist("after_outcome", true);

      if (outcome.status !== "succeeded") {
        return {
          started: true,
          idempotentReplay: false,
          outcome: structuredClone(outcome),
          record: structuredClone(this.record),
        };
      }


      try {
        await this.renewLeaseForOperation(start.action.timeoutMs);
      } catch (error) {
        const currentBinding = this.session.checkpoint().binding;
        if (currentBinding) this.session.recover(currentBinding);
        this.fenced = true;
        throw new InteractionBrokerError(
          "interaction_adapter_lease_lost_before_verification",
          "The external action returned, but the broker lost its adapter lease before verification. The effect must be reconciled by the next lease holder.",
          { checkpoint: this.session.checkpoint() },
        );
      }

      let verification: InteractionVerificationResult;
      try {
        verification = await this.adapter.verify(start.action, outcome);
      } catch {
        verification = {
          actionId: start.action.actionId,
          verified: false,
          binding: start.action.binding,
          detailCode: "verification_transport_lost",
          evidence: [],
        };
      }
      this.session.recordVerification(verification);
      await this.persist("after_verification", true);
      return {
        started: true,
        idempotentReplay: false,
        outcome: structuredClone(outcome),
        verification: structuredClone(verification),
        record: structuredClone(this.record),
      };
    });
  }

  async reconcile(input: {
    actionId: string;
    resolution: "effect_absent" | "effect_verified";
    binding: InteractionBinding;
    postStateDigestSha256: string;
    evidence: Parameters<InteractionSession["resolveIndeterminate"]>[0]["evidence"];
    frontier?: Parameters<InteractionSession["resolveIndeterminate"]>[0]["frontier"];
    viewport?: Parameters<InteractionSession["resolveIndeterminate"]>[0]["viewport"];
  }): Promise<InteractionBrokerRecord> {
    return this.serialize(async () => {
      await this.renewLease();
      this.session.resolveIndeterminate(input);
      await this.persist("after_reconciliation", false);
      return structuredClone(this.record);
    });
  }

  async refreshRecovery(
    currentBinding?: InteractionBinding,
  ): Promise<InteractionBrokerRecord> {
    return this.serialize(async () => {
      await this.renewLease();
      this.session.recover(currentBinding);
      await this.persist("recovery_refresh", false);
      return structuredClone(this.record);
    });
  }

  async renewLease(): Promise<InteractionBrokerLease> {
    return this.renewLeaseWithTtl(this.leaseTtlMs);
  }

  private async renewLeaseForOperation(
    declaredTimeoutMs: number,
  ): Promise<InteractionBrokerLease> {
    const remainingLeaseMs = Math.max(
      0,
      Date.parse(this.lease.expiresAt) - this.now(),
    );
    const operationTtlMs = Math.min(
      MAX_LEASE_TTL_MS,
      Math.max(
        this.leaseTtlMs,
        remainingLeaseMs,
        Math.floor(declaredTimeoutMs) + OPERATION_LEASE_GRACE_MS,
      ),
    );
    return this.renewLeaseWithTtl(operationTtlMs);
  }

  private async renewLeaseWithTtl(ttlMs: number): Promise<InteractionBrokerLease> {
    this.assertOpen();
    const renewed = await this.store.renewLease({
      resourceRef: this.lease.resourceRef,
      leaseId: this.lease.leaseId,
      holderScopeRef: this.lease.holderScopeRef,
      nowMs: this.now(),
      ttlMs,
    });
    if (!renewed) {
      throw new InteractionBrokerError(
        "interaction_adapter_lease_lost",
        "The interaction broker lost its adapter lease. No further dispatch is allowed.",
        { checkpoint: this.record.checkpoint },
      );
    }
    this.lease = renewed;
    return structuredClone(renewed);
  }

  async close(): Promise<boolean> {
    if (this.closed) return true;
    await this.serializedTail.catch(() => undefined);
    const released = this.leaseReleased
      ? true
      : await this.store.releaseLease({
          resourceRef: this.lease.resourceRef,
          leaseId: this.lease.leaseId,
          holderScopeRef: this.lease.holderScopeRef,
          nowMs: this.now(),
        });
    this.leaseReleased = this.leaseReleased || released;
    this.closed = true;
    return released;
  }

  private async persist(
    stage: string,
    externalDispatchOccurred: boolean,
  ): Promise<void> {
    const checkpoint = this.session.checkpoint();
    const candidate: Omit<InteractionBrokerRecord, "version"> = {
      schemaVersion: 1,
      sessionRef: checkpoint.identity.sessionRef,
      adapterResourceRef: this.record.adapterResourceRef,
      adapterId: this.record.adapterId,
      currentExecutionScopeRef: checkpoint.identity.executionScopeRef,
      scopeLineage: this.record.scopeLineage,
      checkpoint,
      updatedAt: new Date(this.now()).toISOString(),
      policy: interactionBrokerPolicy(),
    };
    const save = await this.store.compareAndSwapSession({
      record: candidate,
      expectedVersion: this.record.version,
      resourceRef: this.lease.resourceRef,
      leaseId: this.lease.leaseId,
      holderScopeRef: this.lease.holderScopeRef,
      nowMs: this.now(),
    });
    if (!save.saved || !save.record) {
      if (externalDispatchOccurred) {
        this.session = InteractionSession.restore(this.record.checkpoint, {
          now: this.now,
          idFactory: this.idFactory,
          approvalVerifier: this.approvalVerifier,
          reconciliationVerifier: this.reconciliationVerifier,
        });
        const binding = this.record.checkpoint.binding;
        if (binding) this.session.recover(binding);
        this.fenced = true;
        const released = await this.store.releaseLease({
          resourceRef: this.lease.resourceRef,
          leaseId: this.lease.leaseId,
          holderScopeRef: this.lease.holderScopeRef,
          nowMs: this.now(),
        });
        this.leaseReleased = this.leaseReleased || released;
      } else {
        if (save.current) {
          this.record = save.current;
        }
        this.session = InteractionSession.restore(this.record.checkpoint, {
          now: this.now,
          idFactory: this.idFactory,
          approvalVerifier: this.approvalVerifier,
          reconciliationVerifier: this.reconciliationVerifier,
        });
        this.fenced = true;
        const released = await this.store.releaseLease({
          resourceRef: this.lease.resourceRef,
          leaseId: this.lease.leaseId,
          holderScopeRef: this.lease.holderScopeRef,
          nowMs: this.now(),
        });
        this.leaseReleased = this.leaseReleased || released;
      }
      throw new InteractionBrokerError(
        externalDispatchOccurred
          ? "post_dispatch_checkpoint_persistence_failed"
          : "checkpoint_persistence_failed_before_dispatch",
        externalDispatchOccurred
          ? `Interaction checkpoint persistence failed at ${stage} after external dispatch. Treat the effect as indeterminate and reconcile before retrying.`
          : `Interaction checkpoint persistence failed at ${stage}; no external action was dispatched.`,
        {
          checkpoint: this.session.checkpoint(),
          currentRecord: save.current,
        },
      );
    }
    this.record = save.record;
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    this.assertOpen();
    const run = this.serializedTail.then(operation, operation);
    this.serializedTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private assertOpen(): void {
    if (this.fenced) {
      throw new InteractionBrokerError(
        "interaction_broker_fenced",
        "The interaction broker is fenced after an unresolved post-dispatch persistence failure.",
        { checkpoint: this.session.checkpoint() },
      );
    }
    if (this.closed) {
      throw new InteractionBrokerError(
        "interaction_broker_closed",
        "The interaction broker is closed.",
      );
    }
  }
}

async function openOrRestoreSession(input: {
  store: InteractionBrokerStore;
  adapter: InteractionAdapter;
  identity: InteractionBrokerIdentity;
  sessionRef?: string;
  adoption?: InteractionBrokerAdoption;
  adoptionVerifier?: InteractionBrokerAdoptionVerifier;
  resourceRef: string;
  lease: InteractionBrokerLease;
  now: () => number;
  idFactory?: InteractionBrokerOpenInput["idFactory"];
  approvalVerifier?: InteractionApprovalVerifier;
  reconciliationVerifier?: InteractionReconciliationVerifier;
}): Promise<{ record: InteractionBrokerRecord; session: InteractionSession }> {
  const requestedSessionRef = input.sessionRef
    ? boundedText(input.sessionRef, "sessionRef", 200)
    : undefined;
  const existing = requestedSessionRef
    ? await input.store.loadSession(requestedSessionRef)
    : undefined;

  let session: InteractionSession;
  let scopeLineage: InteractionScopeLineageEntry[];
  let expectedVersion: number;

  if (!existing) {
    if (input.adoption) {
      throw new InteractionBrokerError(
        "interaction_adoption_source_missing",
        "An interaction scope adoption requires an existing broker session.",
      );
    }
    session = new InteractionSession(
      {
        ...(requestedSessionRef ? { sessionRef: requestedSessionRef } : {}),
        executionScopeRef: input.identity.executionScopeRef,
        ...(input.identity.workspaceId
          ? { workspaceId: input.identity.workspaceId }
          : {}),
        ...(input.identity.missionRef ? { missionRef: input.identity.missionRef } : {}),
      },
      {
        now: input.now,
        idFactory: input.idFactory,
        approvalVerifier: input.approvalVerifier,
        reconciliationVerifier: input.reconciliationVerifier,
      },
    );
    scopeLineage = [
      {
        scopeRef: input.identity.executionScopeRef,
        enteredAt: new Date(input.now()).toISOString(),
      },
    ];
    expectedVersion = 0;
  } else {
    validateBrokerRecord(existing, input.resourceRef, input.adapter.descriptor.id);
    session = InteractionSession.restore(existing.checkpoint, {
      now: input.now,
      idFactory: input.idFactory,
      approvalVerifier: input.approvalVerifier,
      reconciliationVerifier: input.reconciliationVerifier,
    });
    session.recover(existing.checkpoint.binding);
    scopeLineage = structuredClone(existing.scopeLineage);
    expectedVersion = existing.version;

    if (existing.currentExecutionScopeRef !== input.identity.executionScopeRef) {
      const adoptionVerification = validateAdoption(
        input.adoption,
        input.adoptionVerifier,
        existing,
        input.identity.executionScopeRef,
      );
      const recovered = session.checkpoint();
      session = InteractionSession.restore(
        {
          ...recovered,
          identity: {
            ...recovered.identity,
            executionScopeRef: input.identity.executionScopeRef,
            ...(input.identity.workspaceId
              ? { workspaceId: input.identity.workspaceId }
              : {}),
            ...(input.identity.missionRef
              ? { missionRef: input.identity.missionRef }
              : {}),
          },
        },
        {
          now: input.now,
          idFactory: input.idFactory,
          approvalVerifier: input.approvalVerifier,
          reconciliationVerifier: input.reconciliationVerifier,
        },
      );
      scopeLineage.push({
        scopeRef: input.identity.executionScopeRef,
        enteredAt: new Date(input.now()).toISOString(),
        handoffRef: boundedOpaqueRef(
          input.adoption?.handoffRef ?? "",
          "handoffRef",
          1_000,
        ),
        authorityReadbackRef: boundedOpaqueRef(
          input.adoption?.authorityReadbackRef ?? "",
          "authorityReadbackRef",
          2_000,
        ),
        adoptionVerificationRef: boundedOpaqueRef(
          adoptionVerification.verificationRef ?? "",
          "adoptionVerificationRef",
          2_000,
        ),
      });
    } else if (input.adoption) {
      throw new InteractionBrokerError(
        "interaction_adoption_not_required",
        "Scope adoption metadata was supplied, but the broker session already belongs to this execution scope.",
      );
    }
  }

  const checkpoint = session.checkpoint();
  const candidate: Omit<InteractionBrokerRecord, "version"> = {
    schemaVersion: 1,
    sessionRef: checkpoint.identity.sessionRef,
    adapterResourceRef: input.resourceRef,
    adapterId: input.adapter.descriptor.id,
    currentExecutionScopeRef: checkpoint.identity.executionScopeRef,
    scopeLineage,
    checkpoint,
    updatedAt: new Date(input.now()).toISOString(),
    policy: interactionBrokerPolicy(),
  };
  const save = await input.store.compareAndSwapSession({
    record: candidate,
    expectedVersion,
    resourceRef: input.lease.resourceRef,
    leaseId: input.lease.leaseId,
    holderScopeRef: input.lease.holderScopeRef,
    nowMs: input.now(),
  });
  if (!save.saved || !save.record) {
    throw new InteractionBrokerError(
      "interaction_broker_open_checkpoint_conflict",
      "The broker could not create or restore the interaction checkpoint under the acquired lease.",
      { currentRecord: save.current, checkpoint },
    );
  }
  return { record: save.record, session };
}

function validateDescriptorForBroker(adapter: InteractionAdapter): void {
  const descriptor = adapter.descriptor;
  if (!descriptor.available) {
    throw new InteractionBrokerError(
      "interaction_adapter_unavailable",
      descriptor.unavailableReason ?? "The interaction adapter is unavailable.",
    );
  }
  if (descriptor.busy) {
    throw new InteractionBrokerError(
      "interaction_adapter_externally_busy",
      "The adapter reports an existing active client. A DevSpace broker may not start a competing controller.",
    );
  }
  if (!descriptor.capabilities.observe || !descriptor.capabilities.verify) {
    throw new InteractionBrokerError(
      "interaction_adapter_loop_incomplete",
      "The broker requires adapters with both observation and verification capability.",
    );
  }
  if (!descriptor.capabilities.boundedTimeout) {
    throw new InteractionBrokerError(
      "interaction_adapter_timeout_contract_missing",
      "The broker requires an adapter that enforces declared observation, action, and verification timeouts.",
    );
  }
}

function validateBrokerRecord(
  record: InteractionBrokerRecord,
  resourceRef: string,
  adapterId: string,
): void {
  if (record.schemaVersion !== 1) {
    throw new InteractionBrokerError(
      "unsupported_interaction_broker_record",
      "The interaction broker record schema is unsupported.",
    );
  }
  if (record.adapterResourceRef !== resourceRef || record.adapterId !== adapterId) {
    throw new InteractionBrokerError(
      "interaction_broker_adapter_binding_mismatch",
      "The stored interaction session belongs to another adapter resource.",
      { currentRecord: record },
    );
  }
  if (record.currentExecutionScopeRef !== record.checkpoint.identity.executionScopeRef) {
    throw new InteractionBrokerError(
      "interaction_broker_scope_identity_mismatch",
      "The broker record and interaction checkpoint disagree on the current execution scope.",
      { currentRecord: record },
    );
  }
}

function validateAdoption(
  adoption: InteractionBrokerAdoption | undefined,
  adoptionVerifier: InteractionBrokerAdoptionVerifier | undefined,
  existing: InteractionBrokerRecord,
  targetScopeRef: string,
): InteractionBrokerAdoptionVerification {
  if (!adoption) {
    throw new InteractionBrokerError(
      "interaction_scope_adoption_required",
      "Opening an interaction session from another execution scope requires an explicit handoff and current authority readback reference.",
      { currentRecord: existing },
    );
  }
  if (normalizedScopeRef(adoption.priorExecutionScopeRef) !== existing.currentExecutionScopeRef) {
    throw new InteractionBrokerError(
      "interaction_adoption_prior_scope_mismatch",
      "The adoption does not name the interaction session's exact prior execution scope.",
      { currentRecord: existing },
    );
  }
  if (targetScopeRef === existing.currentExecutionScopeRef) {
    throw new InteractionBrokerError(
      "interaction_adoption_target_unchanged",
      "The adoption target must be a different execution scope.",
    );
  }
  boundedOpaqueRef(adoption.handoffRef, "handoffRef", 1_000);
  boundedOpaqueRef(
    adoption.authorityReadbackRef,
    "authorityReadbackRef",
    2_000,
  );
  if (!adoptionVerifier) {
    throw new InteractionBrokerError(
      "interaction_scope_adoption_unverified",
      "Cross-scope interaction adoption requires an external verifier for the handoff and authority readback.",
      { currentRecord: existing },
    );
  }
  let verification: InteractionBrokerAdoptionVerification;
  try {
    verification = adoptionVerifier({
      sessionRef: existing.sessionRef,
      priorExecutionScopeRef: adoption.priorExecutionScopeRef,
      targetExecutionScopeRef: targetScopeRef,
      handoffRef: adoption.handoffRef,
      authorityReadbackRef: adoption.authorityReadbackRef,
    });
  } catch {
    throw new InteractionBrokerError(
      "interaction_scope_adoption_verifier_failed",
      "The external interaction adoption verifier failed closed.",
      { currentRecord: existing },
    );
  }
  if (!verification.verified || !verification.verificationRef) {
    throw new InteractionBrokerError(
      "interaction_scope_adoption_not_verified",
      "The external verifier did not validate the cross-scope interaction handoff.",
      { currentRecord: existing },
    );
  }
  return verification;
}

function assertIntentMatchesAdapter(
  intent: InteractionIntent,
  adapter: InteractionAdapter,
): void {
  if (!adapter.descriptor.targetKinds.includes(intent.targetKind)) {
    throw new InteractionBrokerError(
      "interaction_intent_target_unsupported",
      "The broker adapter does not support the requested target kind.",
    );
  }
  for (const capability of intent.requiredCapabilities ?? []) {
    if (!adapter.descriptor.capabilities[capability]) {
      throw new InteractionBrokerError(
        "interaction_intent_capability_missing",
        `The broker adapter lacks required capability: ${capability}.`,
      );
    }
  }
  if (intent.visibleUiRequired && !adapter.descriptor.capabilities.visibleUi) {
    throw new InteractionBrokerError(
      "interaction_visible_ui_unavailable",
      "The requested interaction requires a visible UI session.",
    );
  }
  if (
    intent.existingSessionRequired
    && !adapter.descriptor.capabilities.persistentSession
    && !adapter.descriptor.sessionRef
  ) {
    throw new InteractionBrokerError(
      "interaction_existing_session_unavailable",
      "The requested interaction requires an existing persistent session.",
    );
  }
  if (
    adapter.descriptor.surface === "vision_pointer"
    && intent.allowCoordinateFallback !== true
  ) {
    throw new InteractionBrokerError(
      "interaction_coordinate_fallback_not_authorized",
      "Vision/pointer adapters require explicit coordinate fallback authorization.",
    );
  }
}

function interactionAdapterResourceRef(adapter: InteractionAdapter): string {
  const descriptor = adapter.descriptor;
  return [
    "interaction-adapter",
    boundedText(descriptor.id, "adapter.id", 200),
    descriptor.sessionRef
      ? boundedText(descriptor.sessionRef, "adapter.sessionRef", 1_000)
      : "default",
  ].join(":");
}

function boundedLeaseTtl(value: number | undefined): number {
  if (value === undefined) return DEFAULT_LEASE_TTL_MS;
  if (!Number.isSafeInteger(value) || value < MIN_LEASE_TTL_MS || value > MAX_LEASE_TTL_MS) {
    throw new InteractionBrokerError(
      "interaction_lease_ttl_invalid",
      `Interaction broker lease TTL must be an integer between ${MIN_LEASE_TTL_MS} and ${MAX_LEASE_TTL_MS} milliseconds.`,
    );
  }
  return value;
}

function normalizedScopeRef(value: string): string {
  if (!/^[a-f0-9]{16}$/.test(value)) {
    throw new InteractionBrokerError(
      "interaction_scope_ref_invalid",
      "Execution scope reference must be a 16-character lowercase hexadecimal value.",
    );
  }
  return value;
}

function boundedText(value: string, label: string, maximum: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum) {
    throw new InteractionBrokerError(
      "interaction_broker_text_invalid",
      `${label} must contain between 1 and ${maximum} characters.`,
    );
  }
  return value;
}

function boundedOpaqueRef(
  value: string,
  label: string,
  maximum: number,
): string {
  const normalized = boundedText(value, label, maximum);
  if (
    /[\u0000-\u001f\u007f\s]/.test(normalized)
    || !/^[a-z][a-z0-9+.-]*:[^\s]+$/i.test(normalized)
  ) {
    throw new InteractionBrokerError(
      "interaction_broker_reference_invalid",
      `${label} must be an opaque URI-like reference without whitespace or control characters.`,
    );
  }
  if (
    /(?:token|secret|password|passwd|api[_-]?key)=/i.test(normalized)
    || /^[a-z][a-z0-9+.-]*:\/\/[^/]*@/i.test(normalized)
  ) {
    throw new InteractionBrokerError(
      "interaction_broker_credential_reference_rejected",
      `${label} may not embed credentials or credential-like query fields.`,
    );
  }
  return normalized;
}
