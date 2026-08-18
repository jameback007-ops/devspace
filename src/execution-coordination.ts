import { createHash, randomUUID } from "node:crypto";
import {
  openDatabase,
  type DatabaseHandle,
} from "./db/client.js";
import {
  COORDINATION_BATON_KINDS,
  COORDINATION_EVENT_KINDS,
  COORDINATION_INTENT_KINDS,
  COORDINATION_PEER_PHASES,
  COORDINATION_SURFACE_DOMAINS,
  COORDINATION_TASK_STATES,
  EXECUTION_COORDINATION_AUTHORITY,
  assertCoordinationTaskTransition,
  assessCoordinationConflicts,
  buildCoordinationPublicationPlan,
  isTerminalCoordinationTaskState,
  type CoordinationAdoptionMode,
  type CoordinationBaton,
  type CoordinationBatonKind,
  type CoordinationCandidate,
  type CoordinationConflict,
  type CoordinationEvent,
  type CoordinationEventKind,
  type CoordinationIntent,
  type CoordinationIntentKind,
  type CoordinationOrphanAssessment,
  type CoordinationPeerCard,
  type CoordinationPeerPhase,
  type CoordinationPublicationAttempt,
  type CoordinationPublicationMode,
  type CoordinationPublicationPlan,
  type CoordinationPublicationPolicy,
  type CoordinationSurface,
  type CoordinationTask,
  type CoordinationTaskState,
  type CoordinationVisibility,
} from "./execution-coordination-model.js";
import {
  SqliteExecutionCoordinationStore,
  assertExecutionCoordinationSchema,
  installExecutionCoordinationSchema,
  type ExecutionCoordinationRetention,
} from "./execution-coordination-store.js";
import type { ExecutionScopeIdentity } from "./request-meta.js";

export interface ExecutionCoordinationConfig {
  enabled: boolean;
  peerDefaultTtlMs: number;
  peerMaxTtlMs: number;
  taskOwnerDefaultLeaseMs: number;
  taskOwnerMaxLeaseMs: number;
  intentDefaultTtlMs: number;
  intentMaxTtlMs: number;
  batonDefaultTtlMs: number;
  batonMaxTtlMs: number;
  peerRetentionMs: number;
  eventRetentionMs: number;
  terminalRetentionMs: number;
  commandRetentionMs: number;
  cleanupIntervalMs: number;
  maxBodyCharacters: number;
  maxFrontierCharacters: number;
  maxReferenceCharacters: number;
  maxReferencesPerField: number;
  maxSurfacesPerIntent: number;
  maxCapabilitiesPerPeer: number;
}

export const DEFAULT_EXECUTION_COORDINATION_CONFIG: ExecutionCoordinationConfig = {
  enabled: true,
  peerDefaultTtlMs: 15 * 60 * 1_000,
  peerMaxTtlMs: 24 * 60 * 60 * 1_000,
  taskOwnerDefaultLeaseMs: 30 * 60 * 1_000,
  taskOwnerMaxLeaseMs: 24 * 60 * 60 * 1_000,
  intentDefaultTtlMs: 30 * 60 * 1_000,
  intentMaxTtlMs: 24 * 60 * 60 * 1_000,
  batonDefaultTtlMs: 24 * 60 * 60 * 1_000,
  batonMaxTtlMs: 7 * 24 * 60 * 60 * 1_000,
  peerRetentionMs: 7 * 24 * 60 * 60 * 1_000,
  eventRetentionMs: 30 * 24 * 60 * 60 * 1_000,
  terminalRetentionMs: 14 * 24 * 60 * 60 * 1_000,
  commandRetentionMs: 30 * 24 * 60 * 60 * 1_000,
  cleanupIntervalMs: 60 * 1_000,
  maxBodyCharacters: 12_000,
  maxFrontierCharacters: 4_000,
  maxReferenceCharacters: 2_000,
  maxReferencesPerField: 100,
  maxSurfacesPerIntent: 100,
  maxCapabilitiesPerPeer: 100,
};

export interface ExecutionCoordinationManagerOptions {
  now?: () => number;
  database?: DatabaseHandle;
  installSchema?: boolean;
  idFactory?: (prefix: CoordinationIdPrefix) => string;
}

type CoordinationIdPrefix = "ctx" | "ctk" | "thr" | "cev" | "cin" | "cbt";

export interface CoordinationMutationResult<T> {
  value: T;
  idempotentReplay: boolean;
}

export interface PublishCoordinationPeerInput {
  idempotencyKey: string;
  expectedGeneration?: number;
  missionRef: string;
  displayLabel?: string;
  phase: CoordinationPeerPhase;
  frontier: string;
  capabilities?: string[];
  taskIds?: string[];
  subjectRefs?: string[];
  surfaceRefs?: string[];
  recoveryRef?: string;
  expiresInHours?: number;
}

export interface OpenCoordinationTaskInput {
  idempotencyKey: string;
  contextId?: string;
  parentTaskId?: string;
  supersedesTaskId?: string;
  missionRef: string;
  title?: string;
  participantScopeRefs?: string[];
  dependencyTaskIds?: string[];
  externalAuthorityRefs?: string[];
  subjectRefs?: string[];
  recoveryRef?: string;
  initialState?: "proposed" | "submitted" | "working";
  adoptionMode?: CoordinationAdoptionMode;
  visibility?: CoordinationVisibility;
  publicationMode?: CoordinationPublicationMode;
  eligiblePublisherCapabilities?: string[];
  ownerLeaseHours?: number;
}

export interface CoordinationOwnershipProofInput {
  handoffRef?: string;
  authorityReadbackRefs?: string[];
  adoptionVerificationRefs?: string[];
  effectReadbackRefs?: string[];
}

export interface TransitionCoordinationTaskInput {
  idempotencyKey: string;
  taskId: string;
  expectedRevision: number;
  toState: CoordinationTaskState;
  candidate?: Omit<CoordinationCandidate, "artifactRefs" | "affectedSurfaces" | "producedAt"> & {
    artifactRefs?: string[];
    affectedSurfaces?: CoordinationSurface[];
    producedAt?: string;
  };
  validationRefs?: string[];
  unresolvedRefs?: string[];
  blockerRefs?: string[];
  recoveryRef?: string;
  participantScopeRefs?: string[];
  dependencyTaskIds?: string[];
  externalAuthorityRefs?: string[];
  ownershipProof?: CoordinationOwnershipProofInput;
  publicationMode?: CoordinationPublicationMode;
  eligiblePublisherCapabilities?: string[];
  publicationAttempt?: Omit<CoordinationPublicationAttempt, "publisherScopeRef" | "startedAt"> & {
    publisherScopeRef?: string;
    startedAt?: string;
  };
  publicationReceiptRefs?: string[];
  remoteReadbackRef?: string;
  ownerLeaseHours?: number;
  note?: string;
}

export interface SendCoordinationEventInput {
  idempotencyKey: string;
  taskId?: string;
  contextId?: string;
  threadId?: string;
  replyToEventId?: string;
  targetScopeRefs?: string[];
  kind: CoordinationEventKind;
  body: string;
  subjectRefs?: string[];
  evidenceRefs?: string[];
  artifactRefs?: string[];
}

export interface DeclareCoordinationIntentInput {
  idempotencyKey: string;
  taskId: string;
  kind: CoordinationIntentKind;
  surfaces: CoordinationSurface[];
  expiresInHours?: number;
}

export interface RenewCoordinationIntentInput {
  idempotencyKey: string;
  intentId: string;
  expectedRevision: number;
  expiresInHours?: number;
}

export interface ReleaseCoordinationIntentInput {
  idempotencyKey: string;
  intentId: string;
  expectedRevision: number;
}

export interface AdoptCoordinationTaskInput {
  idempotencyKey: string;
  taskId: string;
  expectedRevision: number;
  recoveryRef?: string;
  ownershipProof: CoordinationOwnershipProofInput;
  ownerLeaseHours?: number;
  note?: string;
}

export interface OfferCoordinationBatonInput {
  idempotencyKey: string;
  taskId: string;
  expectedTaskRevision: number;
  kind: CoordinationBatonKind;
  toScopeRef: string;
  note?: string;
  evidenceRefs?: string[];
  expiresInHours?: number;
}

export interface RespondCoordinationBatonInput {
  idempotencyKey: string;
  batonId: string;
  expectedRevision: number;
  response: "accepted" | "rejected";
  note?: string;
}

export interface ConsumeCoordinationBatonInput {
  idempotencyKey: string;
  batonId: string;
  expectedRevision: number;
  ownershipProof?: CoordinationOwnershipProofInput;
  ownerLeaseHours?: number;
  note?: string;
}

export interface RevokeCoordinationBatonInput {
  idempotencyKey: string;
  batonId: string;
  expectedRevision: number;
  note?: string;
}

export interface ExecutionCoordinationStatus {
  schemaVersion: 1;
  generatedAt: string;
  currentScopeRef: string;
  peers: CoordinationPeerCard[];
  tasks: CoordinationTask[];
  intents: CoordinationIntent[];
  conflicts: CoordinationConflict[];
  orphanAssessments: CoordinationOrphanAssessment[];
  inboundBatons: CoordinationBaton[];
  outboundBatons: CoordinationBaton[];
  policy: typeof EXECUTION_COORDINATION_AUTHORITY;
}

const SCOPE_REF_PATTERN = /^[a-f0-9]{16}$/;
const CONTEXT_ID_PATTERN = /^ctx_[a-f0-9]{32}$/;
const TASK_ID_PATTERN = /^ctk_[a-f0-9]{32}$/;
const THREAD_ID_PATTERN = /^thr_[a-f0-9]{32}$/;
const EVENT_ID_PATTERN = /^cev_[a-f0-9]{32}$/;
const INTENT_ID_PATTERN = /^cin_[a-f0-9]{32}$/;
const BATON_ID_PATTERN = /^cbt_[a-f0-9]{32}$/;
const IDEMPOTENCY_KEY_MAX = 200;

export class ExecutionCoordinationManager {
  private readonly now: () => number;
  private readonly database: DatabaseHandle;
  private readonly store: SqliteExecutionCoordinationStore;
  private readonly ownsDatabase: boolean;
  private readonly idFactory: (prefix: CoordinationIdPrefix) => string;
  private lastCleanupAtMs = 0;
  private closed = false;

  constructor(
    readonly config: ExecutionCoordinationConfig,
    stateDir: string,
    options: ExecutionCoordinationManagerOptions = {},
  ) {
    validateConfig(config);
    this.now = options.now ?? Date.now;
    this.database = options.database ?? openDatabase(stateDir);
    this.ownsDatabase = options.database === undefined;
    try {
      if (options.installSchema === true) {
        installExecutionCoordinationSchema(this.database.sqlite, this.now());
      }
      assertExecutionCoordinationSchema(this.database.sqlite);
    } catch (error) {
      if (this.ownsDatabase) this.database.close();
      throw error;
    }
    this.store = new SqliteExecutionCoordinationStore(this.database.sqlite);
    this.idFactory = options.idFactory ?? ((prefix) =>
      `${prefix}_${randomUUID().replaceAll("-", "")}`);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.ownsDatabase) this.database.close();
  }

  publishPeer(
    identity: ExecutionScopeIdentity | undefined,
    input: PublishCoordinationPeerInput,
  ): CoordinationMutationResult<CoordinationPeerCard> {
    this.assertEnabled();
    const actor = requireIdentity(identity);
    const normalized = {
      expectedGeneration: input.expectedGeneration,
      missionRef: this.reference(input.missionRef, "missionRef"),
      displayLabel: this.optionalText(input.displayLabel, "displayLabel", 500),
      phase: oneOf(input.phase, COORDINATION_PEER_PHASES, "phase"),
      frontier: this.text(input.frontier, "frontier", this.config.maxFrontierCharacters),
      capabilities: this.references(
        input.capabilities ?? [],
        "capabilities",
        this.config.maxCapabilitiesPerPeer,
      ),
      taskIds: this.ids(input.taskIds ?? [], TASK_ID_PATTERN, "taskIds"),
      subjectRefs: this.references(input.subjectRefs ?? [], "subjectRefs"),
      surfaceRefs: this.references(input.surfaceRefs ?? [], "surfaceRefs"),
      recoveryRef: this.optionalReference(input.recoveryRef, "recoveryRef"),
      ttlMs: ttlMs(
        input.expiresInHours,
        this.config.peerDefaultTtlMs,
        this.config.peerMaxTtlMs,
        "expiresInHours",
      ),
    };
    return this.mutate(actor, input.idempotencyKey, "publish_peer", normalized, (nowMs) => {
      const previous = this.store.peer(actor.scopeRef);
      if (normalized.expectedGeneration !== undefined
        && normalized.expectedGeneration !== (previous?.generation ?? 0)) {
        throw new Error(
          `Peer generation mismatch: expected ${normalized.expectedGeneration}, current ${previous?.generation ?? 0}.`,
        );
      }
      const nowIso = iso(nowMs);
      const peer: CoordinationPeerCard = {
        schemaVersion: 1,
        scopeRef: actor.scopeRef,
        generation: (previous?.generation ?? 0) + 1,
        missionRef: normalized.missionRef,
        displayLabel: normalized.displayLabel,
        phase: normalized.phase,
        frontier: normalized.frontier,
        capabilities: normalized.capabilities,
        taskIds: normalized.taskIds,
        subjectRefs: normalized.subjectRefs,
        surfaceRefs: normalized.surfaceRefs,
        recoveryRef: normalized.recoveryRef,
        publishedAt: previous?.publishedAt ?? nowIso,
        heartbeatAt: nowIso,
        expiresAt: iso(nowMs + normalized.ttlMs),
        freshness: "active",
        authority: EXECUTION_COORDINATION_AUTHORITY,
      };
      const digest = sha256(canonicalJson(peer));
      this.store.putPeer(peer, digest, nowMs);
      this.store.appendAudit({
        entityType: "peer",
        entityId: peer.scopeRef,
        actorScopeRef: actor.scopeRef,
        action: previous ? "peer_renewed" : "peer_published",
        fromState: previous?.phase,
        toState: peer.phase,
        revision: peer.generation,
        payloadDigestSha256: digest,
        recordedAtMs: nowMs,
      });
      return peer;
    });
  }

  peers(identity: ExecutionScopeIdentity | undefined, includeStale = true): CoordinationPeerCard[] {
    this.assertEnabled();
    requireIdentity(identity);
    const nowMs = this.now();
    this.maybeCleanup(nowMs);
    return this.store.peers()
      .map((peer) => materializePeer(peer, nowMs))
      .filter((peer) => includeStale || peer.freshness === "active");
  }

  openTask(
    identity: ExecutionScopeIdentity | undefined,
    input: OpenCoordinationTaskInput,
  ): CoordinationMutationResult<CoordinationTask> {
    this.assertEnabled();
    const actor = requireIdentity(identity);
    const normalized = {
      contextId: input.contextId
        ? requireId(input.contextId, CONTEXT_ID_PATTERN, "contextId")
        : undefined,
      parentTaskId: input.parentTaskId
        ? requireId(input.parentTaskId, TASK_ID_PATTERN, "parentTaskId")
        : undefined,
      supersedesTaskId: input.supersedesTaskId
        ? requireId(input.supersedesTaskId, TASK_ID_PATTERN, "supersedesTaskId")
        : undefined,
      missionRef: this.reference(input.missionRef, "missionRef"),
      title: this.optionalText(input.title, "title", 500),
      participantScopeRefs: this.scopeRefs(input.participantScopeRefs ?? []),
      dependencyTaskIds: this.ids(input.dependencyTaskIds ?? [], TASK_ID_PATTERN, "dependencyTaskIds"),
      externalAuthorityRefs: this.references(
        input.externalAuthorityRefs ?? [],
        "externalAuthorityRefs",
      ),
      subjectRefs: this.references(input.subjectRefs ?? [], "subjectRefs"),
      recoveryRef: this.optionalReference(input.recoveryRef, "recoveryRef"),
      initialState: input.initialState ?? "submitted",
      adoptionMode: input.adoptionMode ?? "participants",
      visibility: input.visibility ?? "peers",
      publicationPolicy: this.publicationPolicy(
        input.publicationMode ?? "owner_only",
        input.eligiblePublisherCapabilities ?? [],
      ),
      ownerLeaseMs: ttlMs(
        input.ownerLeaseHours,
        this.config.taskOwnerDefaultLeaseMs,
        this.config.taskOwnerMaxLeaseMs,
        "ownerLeaseHours",
      ),
    };
    if (!["proposed", "submitted", "working"].includes(normalized.initialState)) {
      throw new Error("initialState must be proposed, submitted, or working.");
    }
    if (!["owner_only", "participants", "any_eligible", "prohibited"].includes(normalized.adoptionMode)) {
      throw new Error("Invalid adoptionMode.");
    }
    if (!["participants", "peers"].includes(normalized.visibility)) {
      throw new Error("Invalid visibility.");
    }
    return this.mutate(actor, input.idempotencyKey, "open_task", normalized, (nowMs) => {
      const taskId = this.idFactory("ctk");
      const contextId = normalized.contextId ?? this.idFactory("ctx");
      requireId(taskId, TASK_ID_PATTERN, "generated taskId");
      requireId(contextId, CONTEXT_ID_PATTERN, "generated contextId");
      const participantScopeRefs = uniqueSorted([
        actor.scopeRef,
        ...normalized.participantScopeRefs,
      ]);
      for (const dependencyTaskId of normalized.dependencyTaskIds) {
        if (!this.store.task(dependencyTaskId)) {
          throw new Error(`Unknown dependency coordination task: ${dependencyTaskId}`);
        }
      }
      if (normalized.parentTaskId && !this.store.task(normalized.parentTaskId)) {
        throw new Error(`Unknown parent coordination task: ${normalized.parentTaskId}`);
      }
      if (normalized.supersedesTaskId && !this.store.task(normalized.supersedesTaskId)) {
        throw new Error(`Unknown superseded coordination task: ${normalized.supersedesTaskId}`);
      }
      const nowIso = iso(nowMs);
      const task: CoordinationTask = {
        schemaVersion: 1,
        taskId,
        contextId,
        parentTaskId: normalized.parentTaskId,
        supersedesTaskId: normalized.supersedesTaskId,
        ownerScopeRef: actor.scopeRef,
        participantScopeRefs,
        dependencyTaskIds: normalized.dependencyTaskIds,
        externalAuthorityRefs: normalized.externalAuthorityRefs,
        ownershipLineage: [
          {
            scopeRef: actor.scopeRef,
            enteredAt: nowIso,
            mode: "initial",
            recoveryRef: normalized.recoveryRef,
            authorityReadbackRefs: [],
            adoptionVerificationRefs: [],
            effectReadbackRefs: [],
          },
        ],
        missionRef: normalized.missionRef,
        title: normalized.title,
        subjectRefs: normalized.subjectRefs,
        state: normalized.initialState,
        revision: 1,
        adoptionGeneration: 0,
        adoptionMode: normalized.adoptionMode,
        visibility: normalized.visibility,
        publicationPolicy: normalized.publicationPolicy,
        validationRefs: [],
        unresolvedRefs: [],
        blockerRefs: [],
        recoveryRef: normalized.recoveryRef,
        publicationReceiptRefs: [],
        createdAt: nowIso,
        updatedAt: nowIso,
        ownerLeaseExpiresAt: iso(nowMs + normalized.ownerLeaseMs),
        authority: EXECUTION_COORDINATION_AUTHORITY,
      };
      const digest = sha256(canonicalJson(task));
      this.store.putTask(task, digest);
      this.store.appendAudit({
        entityType: "task",
        entityId: task.taskId,
        actorScopeRef: actor.scopeRef,
        action: "task_opened",
        toState: task.state,
        revision: task.revision,
        payloadDigestSha256: digest,
        recordedAtMs: nowMs,
      });
      return task;
    });
  }

  task(
    identity: ExecutionScopeIdentity | undefined,
    taskId: string,
  ): CoordinationTask {
    this.assertEnabled();
    const actor = requireIdentity(identity);
    const task = this.requireTask(requireId(taskId, TASK_ID_PATTERN, "taskId"));
    this.requireTaskRead(actor, task);
    return task;
  }

  tasks(
    identity: ExecutionScopeIdentity | undefined,
    options: { contextId?: string; includeTerminal?: boolean } = {},
  ): CoordinationTask[] {
    this.assertEnabled();
    const actor = requireIdentity(identity);
    const contextId = options.contextId
      ? requireId(options.contextId, CONTEXT_ID_PATTERN, "contextId")
      : undefined;
    return this.store.tasks()
      .filter((task) => !contextId || task.contextId === contextId)
      .filter((task) => options.includeTerminal || !isTerminalCoordinationTaskState(task.state))
      .filter((task) => this.canReadTask(actor, task));
  }

  transitionTask(
    identity: ExecutionScopeIdentity | undefined,
    input: TransitionCoordinationTaskInput,
  ): CoordinationMutationResult<CoordinationTask> {
    this.assertEnabled();
    const actor = requireIdentity(identity);
    const normalized = this.normalizeTaskTransition(input, actor.scopeRef);
    return this.mutate(actor, input.idempotencyKey, "transition_task", normalized, (nowMs) => {
      const current = this.requireTask(normalized.taskId);
      this.requireTaskMutationActor(actor, current);
      requireRevision(current.revision, normalized.expectedRevision, "task");
      if ((normalized.externalAuthorityRefs || normalized.ownershipProof)
        && current.ownerScopeRef !== actor.scopeRef) {
        throw new Error(
          "Only the coordination task owner may update external-authority references or ownership proof.",
        );
      }
      const patched: CoordinationTask = {
        ...current,
        candidate: normalized.candidate
          ? {
              ...normalized.candidate,
              producedAt: normalized.candidate.producedAt ?? iso(nowMs),
            }
          : current.candidate,
        validationRefs: normalized.validationRefs ?? current.validationRefs,
        unresolvedRefs: normalized.unresolvedRefs ?? current.unresolvedRefs,
        blockerRefs: normalized.blockerRefs ?? current.blockerRefs,
        recoveryRef: normalized.recoveryRef ?? current.recoveryRef,
        participantScopeRefs: normalized.participantScopeRefs
          ? uniqueSorted([current.ownerScopeRef, ...normalized.participantScopeRefs])
          : current.participantScopeRefs,
        dependencyTaskIds: normalized.dependencyTaskIds ?? current.dependencyTaskIds,
        externalAuthorityRefs: normalized.externalAuthorityRefs
          ?? current.externalAuthorityRefs,
        ownershipLineage: normalized.ownershipProof
          ? mergeCurrentOwnershipProof(
              current.ownershipLineage,
              actor.scopeRef,
              normalized.ownershipProof,
              normalized.recoveryRef ?? current.recoveryRef,
            )
          : current.ownershipLineage,
        publicationPolicy: normalized.publicationPolicy ?? current.publicationPolicy,
        publicationAttempt: normalized.publicationAttempt
          ? {
              ...normalized.publicationAttempt,
              startedAt: normalized.publicationAttempt.startedAt ?? iso(nowMs),
            }
          : current.publicationAttempt,
        publicationReceiptRefs: normalized.publicationReceiptRefs
          ?? current.publicationReceiptRefs,
        remoteReadbackRef: normalized.remoteReadbackRef ?? current.remoteReadbackRef,
        publisherScopeRef: current.publisherScopeRef
          ?? (normalized.toState === "ready_for_publication"
            && (normalized.publicationPolicy ?? current.publicationPolicy).mode === "owner_only"
            ? current.ownerScopeRef
            : undefined),
        ownerLeaseExpiresAt: normalized.ownerLeaseMs
          ? iso(nowMs + normalized.ownerLeaseMs)
          : current.ownerLeaseExpiresAt,
      };
      this.requireTransitionRole(actor, patched, normalized.toState);
      const ownership = patched.ownershipLineage.at(-1);
      const leavingInputRequired = current.state === "input_required"
        && normalized.toState !== "input_required";
      const activeEffectBoundary = this.activeIntents(nowMs).some((intent) =>
        intent.taskId === current.taskId
        && ["effect_intent", "publication_intent"].includes(intent.kind));
      if (leavingInputRequired
        && activeEffectBoundary
        && ownership?.mode !== "initial"
        && ownership?.effectReadbackRefs.length === 0) {
        throw new Error(
          "Leaving input_required after ownership transfer requires exact external effect-readback evidence while an effect or publication intent remains active.",
        );
      }
      assertCoordinationTaskTransition(patched, normalized.toState);
      for (const dependencyTaskId of patched.dependencyTaskIds) {
        if (dependencyTaskId === patched.taskId) {
          throw new Error("A coordination task cannot depend on itself.");
        }
        if (!this.store.task(dependencyTaskId)) {
          throw new Error(`Unknown dependency coordination task: ${dependencyTaskId}`);
        }
      }
      const next: CoordinationTask = {
        ...patched,
        state: normalized.toState,
        revision: current.revision + 1,
        updatedAt: iso(nowMs),
        terminalAt: isTerminalCoordinationTaskState(normalized.toState) ? iso(nowMs) : undefined,
      };
      const digest = sha256(canonicalJson(next));
      this.store.putTask(next, digest);
      this.store.appendAudit({
        entityType: "task",
        entityId: next.taskId,
        actorScopeRef: actor.scopeRef,
        action: "task_transitioned",
        fromState: current.state,
        toState: next.state,
        revision: next.revision,
        payloadDigestSha256: digest,
        detailJson: normalized.note ? JSON.stringify({ note: normalized.note }) : undefined,
        recordedAtMs: nowMs,
      });
      return next;
    });
  }

  sendEvent(
    identity: ExecutionScopeIdentity | undefined,
    input: SendCoordinationEventInput,
  ): CoordinationMutationResult<CoordinationEvent> {
    this.assertEnabled();
    const actor = requireIdentity(identity);
    const normalized = {
      taskId: input.taskId ? requireId(input.taskId, TASK_ID_PATTERN, "taskId") : undefined,
      contextId: input.contextId
        ? requireId(input.contextId, CONTEXT_ID_PATTERN, "contextId")
        : undefined,
      threadId: input.threadId
        ? requireId(input.threadId, THREAD_ID_PATTERN, "threadId")
        : undefined,
      replyToEventId: input.replyToEventId
        ? requireId(input.replyToEventId, EVENT_ID_PATTERN, "replyToEventId")
        : undefined,
      targetScopeRefs: this.scopeRefs(input.targetScopeRefs ?? []),
      kind: oneOf(input.kind, COORDINATION_EVENT_KINDS, "kind"),
      body: this.text(input.body, "body", this.config.maxBodyCharacters),
      subjectRefs: this.references(input.subjectRefs ?? [], "subjectRefs"),
      evidenceRefs: this.references(input.evidenceRefs ?? [], "evidenceRefs"),
      artifactRefs: this.references(input.artifactRefs ?? [], "artifactRefs"),
    };
    return this.mutate(actor, input.idempotencyKey, "send_event", normalized, (nowMs) => {
      const task = normalized.taskId ? this.requireTask(normalized.taskId) : undefined;
      if (task) this.requireTaskMutationActor(actor, task, true);
      const reply = normalized.replyToEventId
        ? this.store.event(normalized.replyToEventId)
        : undefined;
      if (normalized.replyToEventId && !reply) {
        throw new Error(`Unknown coordination event: ${normalized.replyToEventId}`);
      }
      const contextId = task?.contextId ?? normalized.contextId ?? reply?.contextId;
      if (!contextId) throw new Error("A coordination event requires taskId or contextId.");
      if (normalized.contextId && normalized.contextId !== contextId) {
        throw new Error("Event contextId does not match the task or reply context.");
      }
      const threadId = normalized.threadId ?? reply?.threadId ?? this.idFactory("thr");
      requireId(threadId, THREAD_ID_PATTERN, "threadId");
      if (reply && (reply.contextId !== contextId || reply.threadId !== threadId)) {
        throw new Error("Reply event must remain in the original context and thread.");
      }
      const allowedTargets = task
        ? new Set(taskParticipants(task))
        : undefined;
      for (const target of normalized.targetScopeRefs) {
        if (target === actor.scopeRef) throw new Error("A coordination event cannot target only itself.");
        if (allowedTargets && !allowedTargets.has(target)) {
          throw new Error(`Target scope is not a participant in task ${task?.taskId}: ${target}`);
        }
      }
      const eventId = this.idFactory("cev");
      requireId(eventId, EVENT_ID_PATTERN, "generated eventId");
      const event: CoordinationEvent = {
        schemaVersion: 1,
        eventId,
        contextId,
        threadId,
        taskId: task?.taskId,
        replyToEventId: reply?.eventId,
        senderScopeRef: actor.scopeRef,
        targetScopeRefs: normalized.targetScopeRefs,
        kind: normalized.kind,
        body: normalized.body,
        subjectRefs: normalized.subjectRefs,
        evidenceRefs: normalized.evidenceRefs,
        artifactRefs: normalized.artifactRefs,
        createdAt: iso(nowMs),
        authority: EXECUTION_COORDINATION_AUTHORITY,
      };
      const digest = sha256(canonicalJson(event));
      this.store.insertEvent(event, digest);
      this.store.appendAudit({
        entityType: "event",
        entityId: event.eventId,
        actorScopeRef: actor.scopeRef,
        action: `event_${event.kind}`,
        payloadDigestSha256: digest,
        recordedAtMs: nowMs,
      });
      return event;
    });
  }

  thread(
    identity: ExecutionScopeIdentity | undefined,
    threadId: string,
  ): CoordinationEvent[] {
    this.assertEnabled();
    const actor = requireIdentity(identity);
    const events = this.store.events({
      threadId: requireId(threadId, THREAD_ID_PATTERN, "threadId"),
    });
    if (events.length === 0) return [];
    const accessible = events.some((event) => event.senderScopeRef === actor.scopeRef
      || event.targetScopeRefs.includes(actor.scopeRef)
      || (event.taskId && this.canReadTask(actor, this.requireTask(event.taskId))));
    if (!accessible) throw new Error("The current execution scope cannot read this coordination thread.");
    return events;
  }

  declareIntent(
    identity: ExecutionScopeIdentity | undefined,
    input: DeclareCoordinationIntentInput,
  ): CoordinationMutationResult<CoordinationIntent> {
    this.assertEnabled();
    const actor = requireIdentity(identity);
    const normalized = {
      taskId: requireId(input.taskId, TASK_ID_PATTERN, "taskId"),
      kind: oneOf(input.kind, COORDINATION_INTENT_KINDS, "kind"),
      surfaces: this.surfaces(input.surfaces),
      ttlMs: ttlMs(
        input.expiresInHours,
        this.config.intentDefaultTtlMs,
        this.config.intentMaxTtlMs,
        "expiresInHours",
      ),
    };
    return this.mutate(actor, input.idempotencyKey, "declare_intent", normalized, (nowMs) => {
      const task = this.requireTask(normalized.taskId);
      this.requireTaskMutationActor(actor, task, true);
      if (isTerminalCoordinationTaskState(task.state)) {
        throw new Error("Cannot declare an intent for a terminal coordination task.");
      }
      const intentId = this.idFactory("cin");
      requireId(intentId, INTENT_ID_PATTERN, "generated intentId");
      const nowIso = iso(nowMs);
      const intent: CoordinationIntent = {
        schemaVersion: 1,
        intentId,
        contextId: task.contextId,
        taskId: task.taskId,
        ownerScopeRef: actor.scopeRef,
        kind: normalized.kind,
        surfaces: normalized.surfaces,
        state: "active",
        revision: 1,
        createdAt: nowIso,
        renewedAt: nowIso,
        expiresAt: iso(nowMs + normalized.ttlMs),
        authority: EXECUTION_COORDINATION_AUTHORITY,
      };
      const digest = sha256(canonicalJson(intent));
      this.store.putIntent(intent, digest);
      this.store.appendAudit({
        entityType: "intent",
        entityId: intent.intentId,
        actorScopeRef: actor.scopeRef,
        action: "intent_declared",
        toState: intent.state,
        revision: intent.revision,
        payloadDigestSha256: digest,
        recordedAtMs: nowMs,
      });
      return intent;
    });
  }

  renewIntent(
    identity: ExecutionScopeIdentity | undefined,
    input: RenewCoordinationIntentInput,
  ): CoordinationMutationResult<CoordinationIntent> {
    this.assertEnabled();
    const actor = requireIdentity(identity);
    const normalized = {
      intentId: requireId(input.intentId, INTENT_ID_PATTERN, "intentId"),
      expectedRevision: input.expectedRevision,
      ttlMs: ttlMs(
        input.expiresInHours,
        this.config.intentDefaultTtlMs,
        this.config.intentMaxTtlMs,
        "expiresInHours",
      ),
    };
    return this.mutate(actor, input.idempotencyKey, "renew_intent", normalized, (nowMs) => {
      const current = this.requireIntent(normalized.intentId, nowMs);
      if (current.ownerScopeRef !== actor.scopeRef) {
        throw new Error("Only the intent owner may renew it.");
      }
      requireRevision(current.revision, normalized.expectedRevision, "intent");
      if (current.state !== "active") throw new Error("Only an active intent may be renewed.");
      const next: CoordinationIntent = {
        ...current,
        revision: current.revision + 1,
        renewedAt: iso(nowMs),
        expiresAt: iso(nowMs + normalized.ttlMs),
      };
      const digest = sha256(canonicalJson(next));
      this.store.putIntent(next, digest);
      this.store.appendAudit({
        entityType: "intent",
        entityId: next.intentId,
        actorScopeRef: actor.scopeRef,
        action: "intent_renewed",
        fromState: current.state,
        toState: next.state,
        revision: next.revision,
        payloadDigestSha256: digest,
        recordedAtMs: nowMs,
      });
      return next;
    });
  }

  releaseIntent(
    identity: ExecutionScopeIdentity | undefined,
    input: ReleaseCoordinationIntentInput,
  ): CoordinationMutationResult<CoordinationIntent> {
    this.assertEnabled();
    const actor = requireIdentity(identity);
    const normalized = {
      intentId: requireId(input.intentId, INTENT_ID_PATTERN, "intentId"),
      expectedRevision: input.expectedRevision,
    };
    return this.mutate(actor, input.idempotencyKey, "release_intent", normalized, (nowMs) => {
      const current = this.requireIntent(normalized.intentId, nowMs);
      if (current.ownerScopeRef !== actor.scopeRef) {
        throw new Error("Only the intent owner may release it.");
      }
      requireRevision(current.revision, normalized.expectedRevision, "intent");
      if (current.state !== "active") throw new Error("Only an active intent may be released.");
      const next: CoordinationIntent = {
        ...current,
        state: "released",
        revision: current.revision + 1,
        renewedAt: iso(nowMs),
        releasedAt: iso(nowMs),
      };
      const digest = sha256(canonicalJson(next));
      this.store.putIntent(next, digest);
      this.store.appendAudit({
        entityType: "intent",
        entityId: next.intentId,
        actorScopeRef: actor.scopeRef,
        action: "intent_released",
        fromState: current.state,
        toState: next.state,
        revision: next.revision,
        payloadDigestSha256: digest,
        recordedAtMs: nowMs,
      });
      return next;
    });
  }

  intents(
    identity: ExecutionScopeIdentity | undefined,
    options: { taskId?: string; includeTerminal?: boolean } = {},
  ): CoordinationIntent[] {
    this.assertEnabled();
    const actor = requireIdentity(identity);
    const nowMs = this.now();
    const taskId = options.taskId
      ? requireId(options.taskId, TASK_ID_PATTERN, "taskId")
      : undefined;
    return this.store.intents()
      .map((intent) => materializeIntent(intent, nowMs))
      .filter((intent) => !taskId || intent.taskId === taskId)
      .filter((intent) => options.includeTerminal || intent.state === "active")
      .filter((intent) => this.canReadTask(actor, this.requireTask(intent.taskId)));
  }

  conflicts(
    identity: ExecutionScopeIdentity | undefined,
    taskId?: string,
  ): CoordinationConflict[] {
    this.assertEnabled();
    const actor = requireIdentity(identity);
    const exactTaskId = taskId ? requireId(taskId, TASK_ID_PATTERN, "taskId") : undefined;
    if (exactTaskId) this.requireTaskRead(actor, this.requireTask(exactTaskId));
    const conflicts = assessCoordinationConflicts(this.activeIntents(this.now()));
    return conflicts.filter((conflict) => !exactTaskId
      || conflict.leftTaskId === exactTaskId
      || conflict.rightTaskId === exactTaskId)
      .filter((conflict) => {
        const left = this.requireTask(conflict.leftTaskId);
        const right = this.requireTask(conflict.rightTaskId);
        return this.canReadTask(actor, left) || this.canReadTask(actor, right);
      });
  }

  orphanAssessments(
    identity: ExecutionScopeIdentity | undefined,
  ): CoordinationOrphanAssessment[] {
    this.assertEnabled();
    const actor = requireIdentity(identity);
    const nowMs = this.now();
    const peers = new Map(this.store.peers()
      .map((peer) => materializePeer(peer, nowMs))
      .map((peer) => [peer.scopeRef, peer]));
    const activeIntents = this.activeIntents(nowMs);
    return this.store.tasks()
      .filter((task) => !isTerminalCoordinationTaskState(task.state))
      .filter((task) => this.canReadTask(actor, task))
      .map((task) => assessOrphan(task, peers.get(task.ownerScopeRef), activeIntents, nowMs));
  }

  adoptTask(
    identity: ExecutionScopeIdentity | undefined,
    input: AdoptCoordinationTaskInput,
  ): CoordinationMutationResult<CoordinationTask> {
    this.assertEnabled();
    const actor = requireIdentity(identity);
    const normalized = {
      taskId: requireId(input.taskId, TASK_ID_PATTERN, "taskId"),
      expectedRevision: input.expectedRevision,
      recoveryRef: this.optionalReference(input.recoveryRef, "recoveryRef"),
      ownershipProof: this.ownershipProof(input.ownershipProof, "ownershipProof"),
      ownerLeaseMs: ttlMs(
        input.ownerLeaseHours,
        this.config.taskOwnerDefaultLeaseMs,
        this.config.taskOwnerMaxLeaseMs,
        "ownerLeaseHours",
      ),
      note: this.optionalText(input.note, "note", 4_000),
    };
    return this.mutate(actor, input.idempotencyKey, "adopt_task", normalized, (nowMs) => {
      const current = this.requireTask(normalized.taskId);
      this.requireTaskRead(actor, current);
      requireRevision(current.revision, normalized.expectedRevision, "task");
      const actorPeer = materializePeer(
        this.store.peer(actor.scopeRef)
          ?? (() => { throw new Error("Task adoption requires an active peer card."); })(),
        nowMs,
      );
      if (actorPeer.freshness !== "active") {
        throw new Error("Task adoption requires an active peer card.");
      }
      const ownerPeer = this.store.peer(current.ownerScopeRef);
      const activeIntents = this.activeIntents(nowMs);
      const assessment = assessOrphan(
        current,
        ownerPeer ? materializePeer(ownerPeer, nowMs) : undefined,
        activeIntents,
        nowMs,
      );
      if (assessment.disposition === "not_orphaned") {
        throw new Error("Task owner is not yet orphaned; explicit handoff is required.");
      }
      if (assessment.disposition === "prohibited") {
        throw new Error("This coordination task prohibits orphan adoption.");
      }
      if (current.adoptionMode === "participants"
        && !taskParticipants(current).includes(actor.scopeRef)) {
        throw new Error("Task adoption is restricted to existing participants.");
      }
      if (current.adoptionMode === "owner_only") {
        throw new Error("Task adoption is restricted to the current owner.");
      }
      if (normalized.ownershipProof.authorityReadbackRefs.length === 0) {
        throw new Error(
          "Orphan adoption requires at least one current external authority-readback reference.",
        );
      }
      const recoveryRef = normalized.recoveryRef ?? current.recoveryRef;
      const externalAuthorityVerified = current.externalAuthorityRefs.length === 0
        || (normalized.ownershipProof.handoffRef !== undefined
          && normalized.ownershipProof.adoptionVerificationRefs.length > 0);
      const effectReadbackRequired = activeIntents.some((intent) =>
        intent.taskId === current.taskId
        && ["effect_intent", "publication_intent"].includes(intent.kind));
      const effectReconciled = !effectReadbackRequired
        || normalized.ownershipProof.effectReadbackRefs.length > 0;
      const indeterminateExecutionState = ["integrating", "publishing"].includes(current.state);
      const reconcileOnly = indeterminateExecutionState
        || !recoveryRef
        || !externalAuthorityVerified
        || !effectReconciled;
      const enteredAt = iso(nowMs);
      const next: CoordinationTask = {
        ...current,
        ownerScopeRef: actor.scopeRef,
        integrationOwnerScopeRef: undefined,
        publisherScopeRef: undefined,
        participantScopeRefs: uniqueSorted([
          ...current.participantScopeRefs,
          current.ownerScopeRef,
          actor.scopeRef,
        ]),
        state: reconcileOnly ? "input_required" : "working",
        revision: current.revision + 1,
        adoptionGeneration: current.adoptionGeneration + 1,
        recoveryRef,
        ownershipLineage: [
          ...current.ownershipLineage,
          {
            scopeRef: actor.scopeRef,
            enteredAt,
            mode: reconcileOnly ? "orphan_reconciliation" : "orphan_adoption",
            handoffRef: normalized.ownershipProof.handoffRef,
            recoveryRef,
            authorityReadbackRefs: normalized.ownershipProof.authorityReadbackRefs,
            adoptionVerificationRefs: normalized.ownershipProof.adoptionVerificationRefs,
            effectReadbackRefs: normalized.ownershipProof.effectReadbackRefs,
          },
        ],
        publicationAttempt: undefined,
        updatedAt: enteredAt,
        ownerLeaseExpiresAt: iso(nowMs + normalized.ownerLeaseMs),
        terminalAt: undefined,
      };
      const digest = sha256(canonicalJson(next));
      this.store.putTask(next, digest);
      this.store.appendAudit({
        entityType: "task",
        entityId: next.taskId,
        actorScopeRef: actor.scopeRef,
        action: reconcileOnly ? "task_adopted_reconcile_only" : "task_adopted",
        fromState: current.state,
        toState: next.state,
        revision: next.revision,
        payloadDigestSha256: digest,
        detailJson: JSON.stringify({
          priorOwnerScopeRef: current.ownerScopeRef,
          orphanReasonCodes: assessment.reasonCodes,
          externalAuthorityVerified,
          effectReadbackRequired,
          effectReconciled,
          indeterminateExecutionState,
          note: normalized.note,
        }),
        recordedAtMs: nowMs,
      });
      return next;
    });
  }

  offerBaton(
    identity: ExecutionScopeIdentity | undefined,
    input: OfferCoordinationBatonInput,
  ): CoordinationMutationResult<CoordinationBaton> {
    this.assertEnabled();
    const actor = requireIdentity(identity);
    const normalized = {
      taskId: requireId(input.taskId, TASK_ID_PATTERN, "taskId"),
      expectedTaskRevision: input.expectedTaskRevision,
      kind: oneOf(input.kind, COORDINATION_BATON_KINDS, "kind"),
      toScopeRef: requireScopeRef(input.toScopeRef),
      note: this.optionalText(input.note, "note", 4_000),
      evidenceRefs: this.references(input.evidenceRefs ?? [], "evidenceRefs"),
      ttlMs: ttlMs(
        input.expiresInHours,
        this.config.batonDefaultTtlMs,
        this.config.batonMaxTtlMs,
        "expiresInHours",
      ),
    };
    if (normalized.toScopeRef === actor.scopeRef) {
      throw new Error("A coordination baton must target another execution scope.");
    }
    return this.mutate(actor, input.idempotencyKey, "offer_baton", normalized, (nowMs) => {
      const task = this.requireTask(normalized.taskId);
      requireRevision(task.revision, normalized.expectedTaskRevision, "task");
      this.requireBatonOfferRole(actor, task, normalized.kind);
      const targetPeer = this.store.peer(normalized.toScopeRef);
      if (!targetPeer || materializePeer(targetPeer, nowMs).freshness !== "active") {
        throw new Error("A coordination baton requires an active target peer card.");
      }
      const active = this.store.batons()
        .map((baton) => materializeBaton(baton, nowMs))
        .find((baton) => baton.taskId === task.taskId
          && baton.kind === normalized.kind
          && ["offered", "accepted"].includes(baton.state));
      if (active) {
        throw new Error(`Task already has an active ${normalized.kind} baton: ${active.batonId}`);
      }
      const batonId = this.idFactory("cbt");
      requireId(batonId, BATON_ID_PATTERN, "generated batonId");
      const nowIso = iso(nowMs);
      const baton: CoordinationBaton = {
        schemaVersion: 1,
        batonId,
        taskId: task.taskId,
        contextId: task.contextId,
        kind: normalized.kind,
        state: "offered",
        revision: 1,
        fromScopeRef: actor.scopeRef,
        toScopeRef: normalized.toScopeRef,
        expectedTaskRevision: task.revision,
        candidateSha: task.candidate?.candidateSha,
        note: normalized.note,
        evidenceRefs: normalized.evidenceRefs,
        createdAt: nowIso,
        updatedAt: nowIso,
        expiresAt: iso(nowMs + normalized.ttlMs),
        authority: EXECUTION_COORDINATION_AUTHORITY,
      };
      const digest = sha256(canonicalJson(baton));
      this.store.putBaton(baton, digest);
      this.store.appendAudit({
        entityType: "baton",
        entityId: baton.batonId,
        actorScopeRef: actor.scopeRef,
        action: "baton_offered",
        toState: baton.state,
        revision: baton.revision,
        payloadDigestSha256: digest,
        recordedAtMs: nowMs,
      });
      return baton;
    });
  }

  respondBaton(
    identity: ExecutionScopeIdentity | undefined,
    input: RespondCoordinationBatonInput,
  ): CoordinationMutationResult<CoordinationBaton> {
    this.assertEnabled();
    const actor = requireIdentity(identity);
    const normalized = {
      batonId: requireId(input.batonId, BATON_ID_PATTERN, "batonId"),
      expectedRevision: input.expectedRevision,
      response: input.response,
      note: this.optionalText(input.note, "note", 4_000),
    };
    if (!["accepted", "rejected"].includes(normalized.response)) {
      throw new Error("Baton response must be accepted or rejected.");
    }
    return this.mutate(actor, input.idempotencyKey, "respond_baton", normalized, (nowMs) => {
      const current = this.requireBaton(normalized.batonId, nowMs);
      if (current.toScopeRef !== actor.scopeRef) {
        throw new Error("Only the target execution scope may respond to a baton.");
      }
      requireRevision(current.revision, normalized.expectedRevision, "baton");
      if (current.state !== "offered") throw new Error("Only an offered baton may be answered.");
      const next: CoordinationBaton = {
        ...current,
        state: normalized.response,
        revision: current.revision + 1,
        note: normalized.note ?? current.note,
        updatedAt: iso(nowMs),
        respondedAt: iso(nowMs),
      };
      const digest = sha256(canonicalJson(next));
      this.store.putBaton(next, digest);
      this.store.appendAudit({
        entityType: "baton",
        entityId: next.batonId,
        actorScopeRef: actor.scopeRef,
        action: `baton_${next.state}`,
        fromState: current.state,
        toState: next.state,
        revision: next.revision,
        payloadDigestSha256: digest,
        recordedAtMs: nowMs,
      });
      return next;
    });
  }

  consumeBaton(
    identity: ExecutionScopeIdentity | undefined,
    input: ConsumeCoordinationBatonInput,
  ): CoordinationMutationResult<{ baton: CoordinationBaton; task: CoordinationTask }> {
    this.assertEnabled();
    const actor = requireIdentity(identity);
    const normalized = {
      batonId: requireId(input.batonId, BATON_ID_PATTERN, "batonId"),
      expectedRevision: input.expectedRevision,
      ownershipProof: this.ownershipProof(
        input.ownershipProof ?? {},
        "ownershipProof",
      ),
      ownerLeaseMs: ttlMs(
        input.ownerLeaseHours,
        this.config.taskOwnerDefaultLeaseMs,
        this.config.taskOwnerMaxLeaseMs,
        "ownerLeaseHours",
      ),
      note: this.optionalText(input.note, "note", 4_000),
    };
    return this.mutate(actor, input.idempotencyKey, "consume_baton", normalized, (nowMs) => {
      const currentBaton = this.requireBaton(normalized.batonId, nowMs);
      if (currentBaton.toScopeRef !== actor.scopeRef) {
        throw new Error("Only the accepted target may consume a baton.");
      }
      requireRevision(currentBaton.revision, normalized.expectedRevision, "baton");
      if (currentBaton.state !== "accepted") throw new Error("Only an accepted baton may be consumed.");
      const currentTask = this.requireTask(currentBaton.taskId);
      requireRevision(currentTask.revision, currentBaton.expectedTaskRevision, "task frozen by baton");
      if (currentBaton.candidateSha
        && currentTask.candidate?.candidateSha !== currentBaton.candidateSha) {
        throw new Error("The task candidate changed after the baton was offered.");
      }
      let nextTask: CoordinationTask;
      if (currentBaton.kind === "work") {
        const handoffRef = normalized.ownershipProof.handoffRef
          ?? `coordination-baton:${currentBaton.batonId}`;
        const externalAuthorityVerified = currentTask.externalAuthorityRefs.length === 0
          || (normalized.ownershipProof.authorityReadbackRefs.length > 0
            && normalized.ownershipProof.adoptionVerificationRefs.length > 0);
        const effectReadbackRequired = this.activeIntents(nowMs).some((intent) =>
          intent.taskId === currentTask.taskId
          && ["effect_intent", "publication_intent"].includes(intent.kind));
        const effectReconciled = !effectReadbackRequired
          || normalized.ownershipProof.effectReadbackRefs.length > 0;
        const transferReady = Boolean(currentTask.recoveryRef)
          && externalAuthorityVerified
          && effectReconciled
          && !["integrating", "publishing"].includes(currentTask.state);
        const enteredAt = iso(nowMs);
        nextTask = {
          ...currentTask,
          ownerScopeRef: actor.scopeRef,
          integrationOwnerScopeRef: undefined,
          publisherScopeRef: undefined,
          participantScopeRefs: uniqueSorted([
            ...currentTask.participantScopeRefs,
            currentTask.ownerScopeRef,
            actor.scopeRef,
          ]),
          state: transferReady
            ? (["proposed", "submitted", "input_required"].includes(currentTask.state)
                ? "working"
                : currentTask.state)
            : "input_required",
          revision: currentTask.revision + 1,
          adoptionGeneration: currentTask.adoptionGeneration + 1,
          ownershipLineage: [
            ...currentTask.ownershipLineage,
            {
              scopeRef: actor.scopeRef,
              enteredAt,
              mode: "baton",
              handoffRef,
              recoveryRef: currentTask.recoveryRef,
              authorityReadbackRefs: normalized.ownershipProof.authorityReadbackRefs,
              adoptionVerificationRefs: normalized.ownershipProof.adoptionVerificationRefs,
              effectReadbackRefs: normalized.ownershipProof.effectReadbackRefs,
            },
          ],
          ownerLeaseExpiresAt: iso(nowMs + normalized.ownerLeaseMs),
          updatedAt: enteredAt,
        };
      } else if (currentBaton.kind === "integration") {
        if (currentTask.state !== "ready_for_integration") {
          throw new Error("An integration baton requires a ready_for_integration task.");
        }
        const prepared = {
          ...currentTask,
          integrationOwnerScopeRef: actor.scopeRef,
        };
        assertCoordinationTaskTransition(prepared, "integrating");
        nextTask = {
          ...prepared,
          participantScopeRefs: uniqueSorted([...prepared.participantScopeRefs, actor.scopeRef]),
          state: "integrating",
          revision: currentTask.revision + 1,
          updatedAt: iso(nowMs),
        };
      } else {
        if (currentTask.state !== "ready_for_publication") {
          throw new Error("A publication baton requires a ready_for_publication task.");
        }
        nextTask = {
          ...currentTask,
          publisherScopeRef: actor.scopeRef,
          participantScopeRefs: uniqueSorted([...currentTask.participantScopeRefs, actor.scopeRef]),
          revision: currentTask.revision + 1,
          updatedAt: iso(nowMs),
        };
      }
      const nextBaton: CoordinationBaton = {
        ...currentBaton,
        state: "consumed",
        revision: currentBaton.revision + 1,
        note: normalized.note ?? currentBaton.note,
        updatedAt: iso(nowMs),
        consumedAt: iso(nowMs),
      };
      const taskDigest = sha256(canonicalJson(nextTask));
      const batonDigest = sha256(canonicalJson(nextBaton));
      this.store.putTask(nextTask, taskDigest);
      this.store.putBaton(nextBaton, batonDigest);
      this.store.appendAudit({
        entityType: "task",
        entityId: nextTask.taskId,
        actorScopeRef: actor.scopeRef,
        action: `${currentBaton.kind}_baton_consumed`,
        fromState: currentTask.state,
        toState: nextTask.state,
        revision: nextTask.revision,
        payloadDigestSha256: taskDigest,
        recordedAtMs: nowMs,
      });
      this.store.appendAudit({
        entityType: "baton",
        entityId: nextBaton.batonId,
        actorScopeRef: actor.scopeRef,
        action: "baton_consumed",
        fromState: currentBaton.state,
        toState: nextBaton.state,
        revision: nextBaton.revision,
        payloadDigestSha256: batonDigest,
        recordedAtMs: nowMs,
      });
      return { baton: nextBaton, task: nextTask };
    });
  }

  revokeBaton(
    identity: ExecutionScopeIdentity | undefined,
    input: RevokeCoordinationBatonInput,
  ): CoordinationMutationResult<CoordinationBaton> {
    this.assertEnabled();
    const actor = requireIdentity(identity);
    const normalized = {
      batonId: requireId(input.batonId, BATON_ID_PATTERN, "batonId"),
      expectedRevision: input.expectedRevision,
      note: this.optionalText(input.note, "note", 4_000),
    };
    return this.mutate(actor, input.idempotencyKey, "revoke_baton", normalized, (nowMs) => {
      const current = this.requireBaton(normalized.batonId, nowMs);
      if (current.fromScopeRef !== actor.scopeRef) {
        throw new Error("Only the baton sender may revoke it.");
      }
      requireRevision(current.revision, normalized.expectedRevision, "baton");
      if (!["offered", "accepted"].includes(current.state)) {
        throw new Error("Only an offered or accepted baton may be revoked.");
      }
      const next: CoordinationBaton = {
        ...current,
        state: "revoked",
        revision: current.revision + 1,
        note: normalized.note ?? current.note,
        updatedAt: iso(nowMs),
      };
      const digest = sha256(canonicalJson(next));
      this.store.putBaton(next, digest);
      this.store.appendAudit({
        entityType: "baton",
        entityId: next.batonId,
        actorScopeRef: actor.scopeRef,
        action: "baton_revoked",
        fromState: current.state,
        toState: next.state,
        revision: next.revision,
        payloadDigestSha256: digest,
        recordedAtMs: nowMs,
      });
      return next;
    });
  }

  batons(
    identity: ExecutionScopeIdentity | undefined,
    options: { direction?: "inbound" | "outbound" | "all"; includeTerminal?: boolean } = {},
  ): CoordinationBaton[] {
    this.assertEnabled();
    const actor = requireIdentity(identity);
    const nowMs = this.now();
    const direction = options.direction ?? "all";
    return this.store.batons()
      .map((baton) => materializeBaton(baton, nowMs))
      .filter((baton) => options.includeTerminal
        || ["offered", "accepted"].includes(baton.state))
      .filter((baton) => direction === "all"
        ? baton.fromScopeRef === actor.scopeRef || baton.toScopeRef === actor.scopeRef
        : direction === "inbound"
          ? baton.toScopeRef === actor.scopeRef
          : baton.fromScopeRef === actor.scopeRef);
  }

  publicationPlan(
    identity: ExecutionScopeIdentity | undefined,
    input: Omit<Parameters<typeof buildCoordinationPublicationPlan>[0], "publisherScopeRef"> & {
      publisherScopeRef?: string;
    },
  ): CoordinationPublicationPlan {
    this.assertEnabled();
    const actor = requireIdentity(identity);
    const publisherScopeRef = input.publisherScopeRef
      ? requireScopeRef(input.publisherScopeRef)
      : actor.scopeRef;
    if (publisherScopeRef !== actor.scopeRef) {
      throw new Error("A scope may only compute an executable publication plan for itself.");
    }
    const taskIds = this.ids(input.taskIds, TASK_ID_PATTERN, "taskIds");
    if (taskIds.length === 0) throw new Error("publicationPlan requires at least one taskId.");
    const tasks = taskIds.map((taskId) => {
      const task = this.requireTask(taskId);
      this.requireTaskRead(actor, task);
      return task;
    });
    const nowMs = this.now();
    const peer = this.store.peer(publisherScopeRef);
    const conflicts = assessCoordinationConflicts(this.activeIntents(nowMs));
    return buildCoordinationPublicationPlan(
      {
        publisherScopeRef,
        taskIds,
        currentRepositoryRef: input.currentRepositoryRef
          ? this.reference(input.currentRepositoryRef, "currentRepositoryRef")
          : undefined,
        currentMainSha: input.currentMainSha
          ? this.reference(input.currentMainSha, "currentMainSha")
          : undefined,
        publicationLeaseRef: input.publicationLeaseRef
          ? this.reference(input.publicationLeaseRef, "publicationLeaseRef")
          : undefined,
      },
      tasks,
      conflicts,
      peer ? materializePeer(peer, nowMs) : undefined,
    );
  }

  status(identity: ExecutionScopeIdentity | undefined): ExecutionCoordinationStatus {
    this.assertEnabled();
    const actor = requireIdentity(identity);
    const nowMs = this.now();
    this.maybeCleanup(nowMs);
    const peers = this.store.peers().map((peer) => materializePeer(peer, nowMs));
    const tasks = this.store.tasks().filter((task) => this.canReadTask(actor, task));
    const intents = this.store.intents()
      .map((intent) => materializeIntent(intent, nowMs))
      .filter((intent) => this.canReadTask(actor, this.requireTask(intent.taskId)));
    const activeIntents = intents.filter((intent) => intent.state === "active");
    const conflicts = assessCoordinationConflicts(activeIntents);
    const peerMap = new Map(peers.map((peer) => [peer.scopeRef, peer]));
    const orphanAssessments = tasks
      .filter((task) => !isTerminalCoordinationTaskState(task.state))
      .map((task) => assessOrphan(task, peerMap.get(task.ownerScopeRef), activeIntents, nowMs));
    const batons = this.store.batons().map((baton) => materializeBaton(baton, nowMs));
    return {
      schemaVersion: 1,
      generatedAt: iso(nowMs),
      currentScopeRef: actor.scopeRef,
      peers,
      tasks,
      intents,
      conflicts,
      orphanAssessments,
      inboundBatons: batons.filter((baton) => baton.toScopeRef === actor.scopeRef),
      outboundBatons: batons.filter((baton) => baton.fromScopeRef === actor.scopeRef),
      policy: EXECUTION_COORDINATION_AUTHORITY,
    };
  }

  private normalizeTaskTransition(
    input: TransitionCoordinationTaskInput,
    actorScopeRef: string,
  ) {
    const candidate = input.candidate
      ? this.candidate(input.candidate)
      : undefined;
    const publicationAttempt = input.publicationAttempt
      ? {
          publisherScopeRef: input.publicationAttempt.publisherScopeRef
            ? requireScopeRef(input.publicationAttempt.publisherScopeRef)
            : actorScopeRef,
          expectedMainSha: this.reference(
            input.publicationAttempt.expectedMainSha,
            "publicationAttempt.expectedMainSha",
          ),
          publicationLeaseRef: this.reference(
            input.publicationAttempt.publicationLeaseRef,
            "publicationAttempt.publicationLeaseRef",
          ),
          effectKey: this.reference(
            input.publicationAttempt.effectKey,
            "publicationAttempt.effectKey",
          ),
          currentAuthorityStateRefs: this.references(
            input.publicationAttempt.currentAuthorityStateRefs,
            "publicationAttempt.currentAuthorityStateRefs",
          ),
          startedAt: input.publicationAttempt.startedAt
            ? requireIso(input.publicationAttempt.startedAt, "publicationAttempt.startedAt")
            : undefined,
        }
      : undefined;
    return {
      taskId: requireId(input.taskId, TASK_ID_PATTERN, "taskId"),
      expectedRevision: input.expectedRevision,
      toState: oneOf(input.toState, COORDINATION_TASK_STATES, "toState"),
      candidate,
      validationRefs: input.validationRefs
        ? this.references(input.validationRefs, "validationRefs")
        : undefined,
      unresolvedRefs: input.unresolvedRefs
        ? this.references(input.unresolvedRefs, "unresolvedRefs")
        : undefined,
      blockerRefs: input.blockerRefs
        ? this.references(input.blockerRefs, "blockerRefs")
        : undefined,
      recoveryRef: this.optionalReference(input.recoveryRef, "recoveryRef"),
      participantScopeRefs: input.participantScopeRefs
        ? this.scopeRefs(input.participantScopeRefs)
        : undefined,
      dependencyTaskIds: input.dependencyTaskIds
        ? this.ids(input.dependencyTaskIds, TASK_ID_PATTERN, "dependencyTaskIds")
        : undefined,
      externalAuthorityRefs: input.externalAuthorityRefs
        ? this.references(input.externalAuthorityRefs, "externalAuthorityRefs")
        : undefined,
      ownershipProof: input.ownershipProof
        ? this.ownershipProof(input.ownershipProof, "ownershipProof")
        : undefined,
      publicationPolicy: input.publicationMode
        ? this.publicationPolicy(
            input.publicationMode,
            input.eligiblePublisherCapabilities ?? [],
          )
        : undefined,
      publicationAttempt,
      publicationReceiptRefs: input.publicationReceiptRefs
        ? this.references(input.publicationReceiptRefs, "publicationReceiptRefs")
        : undefined,
      remoteReadbackRef: this.optionalReference(input.remoteReadbackRef, "remoteReadbackRef"),
      ownerLeaseMs: input.ownerLeaseHours === undefined
        ? undefined
        : ttlMs(
            input.ownerLeaseHours,
            this.config.taskOwnerDefaultLeaseMs,
            this.config.taskOwnerMaxLeaseMs,
            "ownerLeaseHours",
          ),
      note: this.optionalText(input.note, "note", 4_000),
    };
  }

  private candidate(
    input: TransitionCoordinationTaskInput["candidate"] & {},
  ): Omit<CoordinationCandidate, "producedAt"> & { producedAt?: string } {
    return {
      repositoryRef: this.reference(input.repositoryRef, "candidate.repositoryRef"),
      baseSha: this.reference(input.baseSha, "candidate.baseSha"),
      candidateSha: this.reference(input.candidateSha, "candidate.candidateSha"),
      treeSha: this.optionalReference(input.treeSha, "candidate.treeSha"),
      artifactRefs: this.references(input.artifactRefs ?? [], "candidate.artifactRefs"),
      affectedSurfaces: this.surfaces(input.affectedSurfaces ?? []),
      producedAt: input.producedAt
        ? requireIso(input.producedAt, "candidate.producedAt")
        : undefined,
    };
  }

  private ownershipProof(
    input: CoordinationOwnershipProofInput,
    name: string,
  ): Required<Omit<CoordinationOwnershipProofInput, "handoffRef">> & {
    handoffRef?: string;
  } {
    return {
      handoffRef: this.optionalReference(input.handoffRef, `${name}.handoffRef`),
      authorityReadbackRefs: this.references(
        input.authorityReadbackRefs ?? [],
        `${name}.authorityReadbackRefs`,
      ),
      adoptionVerificationRefs: this.references(
        input.adoptionVerificationRefs ?? [],
        `${name}.adoptionVerificationRefs`,
      ),
      effectReadbackRefs: this.references(
        input.effectReadbackRefs ?? [],
        `${name}.effectReadbackRefs`,
      ),
    };
  }

  private publicationPolicy(
    mode: CoordinationPublicationMode,
    eligibleCapabilities: string[],
  ): CoordinationPublicationPolicy {
    if (!["owner_only", "delegated", "any_eligible", "prohibited"].includes(mode)) {
      throw new Error("Invalid publicationMode.");
    }
    return {
      mode,
      eligibleCapabilities: this.references(
        eligibleCapabilities,
        "eligiblePublisherCapabilities",
        this.config.maxCapabilitiesPerPeer,
      ),
    };
  }

  private surfaces(values: CoordinationSurface[]): CoordinationSurface[] {
    if (values.length === 0) throw new Error("At least one coordination surface is required.");
    if (values.length > this.config.maxSurfacesPerIntent) {
      throw new Error(`Coordination surfaces exceed the ${this.config.maxSurfacesPerIntent}-item limit.`);
    }
    return dedupeBy(values.map((surface, index) => {
      const domain = oneOf(surface.domain, COORDINATION_SURFACE_DOMAINS, `surfaces[${index}].domain`);
      const ref = this.reference(surface.ref, `surfaces[${index}].ref`);
      if (domain === "path" && (ref.startsWith("/") || ref.split("/").includes(".."))) {
        throw new Error("Coordination path surfaces must be relative and cannot traverse parents.");
      }
      const match = surface.match ?? (domain === "path" || domain === "module" ? "prefix" : "exact");
      if (!["exact", "prefix", "semantic"].includes(match)) {
        throw new Error(`Invalid surfaces[${index}].match.`);
      }
      return {
        domain,
        ref,
        repositoryRef: this.optionalReference(
          surface.repositoryRef,
          `surfaces[${index}].repositoryRef`,
        ),
        semanticKey: this.optionalReference(
          surface.semanticKey,
          `surfaces[${index}].semanticKey`,
        ),
        match,
      } satisfies CoordinationSurface;
    }), (surface) => canonicalJson(surface));
  }

  private activeIntents(nowMs: number): CoordinationIntent[] {
    return this.store.intents()
      .map((intent) => materializeIntent(intent, nowMs))
      .filter((intent) => intent.state === "active");
  }

  private requireTask(taskId: string): CoordinationTask {
    const task = this.store.task(taskId);
    if (!task) throw new Error(`Unknown coordination task: ${taskId}`);
    return task;
  }

  private requireIntent(intentId: string, nowMs: number): CoordinationIntent {
    const intent = this.store.intent(intentId);
    if (!intent) throw new Error(`Unknown coordination intent: ${intentId}`);
    return materializeIntent(intent, nowMs);
  }

  private requireBaton(batonId: string, nowMs: number): CoordinationBaton {
    const baton = this.store.baton(batonId);
    if (!baton) throw new Error(`Unknown coordination baton: ${batonId}`);
    return materializeBaton(baton, nowMs);
  }

  private canReadTask(identity: ExecutionScopeIdentity, task: CoordinationTask): boolean {
    return task.visibility === "peers" || taskParticipants(task).includes(identity.scopeRef);
  }

  private requireTaskRead(identity: ExecutionScopeIdentity, task: CoordinationTask): void {
    if (!this.canReadTask(identity, task)) {
      throw new Error(`The current execution scope cannot read coordination task ${task.taskId}.`);
    }
  }

  private requireTaskMutationActor(
    identity: ExecutionScopeIdentity,
    task: CoordinationTask,
    allowParticipant = false,
  ): void {
    const privileged = [
      task.ownerScopeRef,
      task.integrationOwnerScopeRef,
      task.publisherScopeRef,
    ].filter(Boolean).includes(identity.scopeRef);
    if (!privileged && !(allowParticipant && task.participantScopeRefs.includes(identity.scopeRef))) {
      throw new Error(`The current execution scope cannot mutate coordination task ${task.taskId}.`);
    }
  }

  private requireTransitionRole(
    identity: ExecutionScopeIdentity,
    task: CoordinationTask,
    nextState: CoordinationTaskState,
  ): void {
    if (["publishing", "published"].includes(nextState)) {
      if (task.publisherScopeRef !== identity.scopeRef) {
        throw new Error("Only the explicitly authorized publisher may enter publishing or published.");
      }
      return;
    }
    if (["integrating", "ready_for_publication"].includes(nextState)
      && task.integrationOwnerScopeRef
      && task.integrationOwnerScopeRef !== identity.scopeRef
      && task.ownerScopeRef !== identity.scopeRef) {
      throw new Error("Only the integration owner or task owner may advance integration state.");
    }
  }

  private requireBatonOfferRole(
    identity: ExecutionScopeIdentity,
    task: CoordinationTask,
    kind: CoordinationBatonKind,
  ): void {
    if (kind === "work") {
      if (task.ownerScopeRef !== identity.scopeRef) {
        throw new Error("Only the task owner may offer a work baton.");
      }
      return;
    }
    if (![task.ownerScopeRef, task.integrationOwnerScopeRef].includes(identity.scopeRef)) {
      throw new Error("Only the task or integration owner may offer this baton.");
    }
    if (kind === "integration" && task.state !== "ready_for_integration") {
      throw new Error("An integration baton requires ready_for_integration state.");
    }
    if (kind === "publication") {
      if (task.state !== "ready_for_publication") {
        throw new Error("A publication baton requires ready_for_publication state.");
      }
      if (!task.candidate || task.validationRefs.length === 0) {
        throw new Error("A publication baton requires candidate and validation evidence.");
      }
    }
  }

  private mutate<T>(
    actor: ExecutionScopeIdentity,
    idempotencyKeyValue: string,
    commandKind: string,
    normalizedPayload: unknown,
    operation: (nowMs: number) => T,
  ): CoordinationMutationResult<T> {
    const idempotencyKey = idempotencyKeyValue.trim();
    if (!idempotencyKey || idempotencyKey.length > IDEMPOTENCY_KEY_MAX) {
      throw new Error(`idempotencyKey must contain 1-${IDEMPOTENCY_KEY_MAX} characters.`);
    }
    const nowMs = this.now();
    this.maybeCleanup(nowMs);
    const payloadDigestSha256 = sha256(canonicalJson({ commandKind, normalizedPayload }));
    const transaction = this.database.sqlite.transaction(() => {
      const existing = this.store.command(actor.scopeRef, idempotencyKey);
      if (existing) {
        if (existing.commandKind !== commandKind
          || existing.payloadDigestSha256 !== payloadDigestSha256) {
          throw new Error("The idempotencyKey was already used with a different coordination command.");
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

  private maybeCleanup(nowMs: number): void {
    if (nowMs - this.lastCleanupAtMs < this.config.cleanupIntervalMs) return;
    const retention: ExecutionCoordinationRetention = {
      peerRetentionMs: this.config.peerRetentionMs,
      eventRetentionMs: this.config.eventRetentionMs,
      terminalRetentionMs: this.config.terminalRetentionMs,
      commandRetentionMs: this.config.commandRetentionMs,
    };
    this.store.cleanup(nowMs, retention);
    this.lastCleanupAtMs = nowMs;
  }

  private assertEnabled(): void {
    if (!this.config.enabled) throw new Error("Execution coordination is disabled.");
    if (this.closed) throw new Error("Execution coordination manager is closed.");
  }

  private text(value: string, name: string, maximum: number): string {
    const normalized = value.trim();
    if (!normalized) throw new Error(`${name} must not be empty.`);
    if (normalized.length > maximum) {
      throw new Error(`${name} exceeds the ${maximum}-character limit.`);
    }
    return normalized;
  }

  private optionalText(
    value: string | undefined,
    name: string,
    maximum: number,
  ): string | undefined {
    return value === undefined ? undefined : this.text(value, name, maximum);
  }

  private reference(value: string, name: string): string {
    return this.text(value, name, this.config.maxReferenceCharacters);
  }

  private optionalReference(value: string | undefined, name: string): string | undefined {
    return value === undefined ? undefined : this.reference(value, name);
  }

  private references(values: string[], name: string, maximum = this.config.maxReferencesPerField): string[] {
    if (values.length > maximum) throw new Error(`${name} exceeds the ${maximum}-item limit.`);
    return uniqueSorted(values.map((value, index) => this.reference(value, `${name}[${index}]`)));
  }

  private ids(values: string[], pattern: RegExp, name: string): string[] {
    if (values.length > this.config.maxReferencesPerField) {
      throw new Error(`${name} exceeds the ${this.config.maxReferencesPerField}-item limit.`);
    }
    return uniqueSorted(values.map((value, index) => requireId(value, pattern, `${name}[${index}]`)));
  }

  private scopeRefs(values: string[]): string[] {
    if (values.length > this.config.maxReferencesPerField) {
      throw new Error(`scopeRefs exceed the ${this.config.maxReferencesPerField}-item limit.`);
    }
    return uniqueSorted(values.map(requireScopeRef));
  }
}

function assessOrphan(
  task: CoordinationTask,
  ownerPeer: CoordinationPeerCard | undefined,
  activeIntents: CoordinationIntent[],
  nowMs: number,
): CoordinationOrphanAssessment {
  const ownerFreshness: CoordinationOrphanAssessment["ownerFreshness"] = ownerPeer
    ? ownerPeer.freshness
    : "missing";
  const ownerLeaseExpired = Date.parse(task.ownerLeaseExpiresAt) <= nowMs;
  const externalAuthorityReconciliationRequired = task.externalAuthorityRefs.length > 0;
  const reasonCodes: string[] = [];
  if (ownerFreshness === "active") reasonCodes.push("OWNER_PEER_ACTIVE");
  if (!ownerLeaseExpired) reasonCodes.push("OWNER_LEASE_ACTIVE");
  if (ownerFreshness !== "active") reasonCodes.push(`OWNER_PEER_${ownerFreshness.toUpperCase()}`);
  if (ownerLeaseExpired) reasonCodes.push("OWNER_LEASE_EXPIRED");

  let disposition: CoordinationOrphanAssessment["disposition"] = "not_orphaned";
  if (ownerFreshness !== "active" && ownerLeaseExpired) {
    if (["prohibited", "owner_only"].includes(task.adoptionMode)) {
      disposition = "prohibited";
      reasonCodes.push("ADOPTION_POLICY_PROHIBITS_CLAIM");
    } else {
      const hasEffectBoundary = activeIntents.some((intent) => intent.taskId === task.taskId
        && ["effect_intent", "publication_intent"].includes(intent.kind));
      const indeterminateState = ["integrating", "publishing"].includes(task.state);
      const recoveryMissing = !task.recoveryRef;
      if (hasEffectBoundary) reasonCodes.push("ACTIVE_EFFECT_OR_PUBLICATION_INTENT");
      if (indeterminateState) reasonCodes.push("INDETERMINATE_EXECUTION_STATE");
      if (recoveryMissing) reasonCodes.push("RECOVERY_REFERENCE_MISSING");
      if (externalAuthorityReconciliationRequired) {
        reasonCodes.push("EXTERNAL_AUTHORITY_RECONCILIATION_REQUIRED");
      }
      disposition = hasEffectBoundary
        || indeterminateState
        || recoveryMissing
        || externalAuthorityReconciliationRequired
        ? "reconcile_only"
        : "adoptable";
    }
  }
  return {
    taskId: task.taskId,
    ownerScopeRef: task.ownerScopeRef,
    ownerFreshness,
    ownerLeaseExpired,
    externalAuthorityReconciliationRequired,
    disposition,
    reasonCodes: uniqueSorted(reasonCodes),
    authority: EXECUTION_COORDINATION_AUTHORITY,
  };
}

function materializePeer(peer: CoordinationPeerCard, nowMs: number): CoordinationPeerCard {
  return {
    ...peer,
    freshness: Date.parse(peer.expiresAt) <= nowMs ? "stale" : "active",
  };
}

function materializeIntent(intent: CoordinationIntent, nowMs: number): CoordinationIntent {
  if (intent.state === "active" && Date.parse(intent.expiresAt) <= nowMs) {
    return { ...intent, state: "expired" };
  }
  return intent;
}

function materializeBaton(baton: CoordinationBaton, nowMs: number): CoordinationBaton {
  if (["offered", "accepted"].includes(baton.state) && Date.parse(baton.expiresAt) <= nowMs) {
    return { ...baton, state: "expired" };
  }
  return baton;
}

function taskParticipants(task: CoordinationTask): string[] {
  return uniqueSorted([
    task.ownerScopeRef,
    ...task.participantScopeRefs,
    ...(task.integrationOwnerScopeRef ? [task.integrationOwnerScopeRef] : []),
    ...(task.publisherScopeRef ? [task.publisherScopeRef] : []),
  ]);
}

function mergeCurrentOwnershipProof(
  lineage: CoordinationTask["ownershipLineage"],
  ownerScopeRef: string,
  proof: {
    handoffRef?: string;
    authorityReadbackRefs: string[];
    adoptionVerificationRefs: string[];
    effectReadbackRefs: string[];
  },
  recoveryRef: string | undefined,
): CoordinationTask["ownershipLineage"] {
  const current = lineage.at(-1);
  if (!current || current.scopeRef !== ownerScopeRef) {
    throw new Error(
      "Cannot attach ownership proof because the task lineage does not match the current owner.",
    );
  }
  return [
    ...lineage.slice(0, -1),
    {
      ...current,
      handoffRef: proof.handoffRef ?? current.handoffRef,
      recoveryRef: recoveryRef ?? current.recoveryRef,
      authorityReadbackRefs: uniqueSorted([
        ...current.authorityReadbackRefs,
        ...proof.authorityReadbackRefs,
      ]),
      adoptionVerificationRefs: uniqueSorted([
        ...current.adoptionVerificationRefs,
        ...proof.adoptionVerificationRefs,
      ]),
      effectReadbackRefs: uniqueSorted([
        ...current.effectReadbackRefs,
        ...proof.effectReadbackRefs,
      ]),
    },
  ];
}

function requireIdentity(
  identity: ExecutionScopeIdentity | undefined,
): ExecutionScopeIdentity {
  if (!identity) {
    throw new Error("A stable execution scope is required for A2A coordination.");
  }
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

function requireRevision(current: number, expected: number, name: string): void {
  if (!Number.isInteger(expected) || expected < 1) {
    throw new Error(`expectedRevision for ${name} must be a positive integer.`);
  }
  if (current !== expected) {
    throw new Error(`${name} revision mismatch: expected ${expected}, current ${current}.`);
  }
}

function oneOf<const T extends readonly string[]>(
  value: string,
  values: T,
  name: string,
): T[number] {
  if (!values.includes(value)) throw new Error(`Invalid ${name}: ${value}`);
  return value as T[number];
}

function ttlMs(
  hours: number | undefined,
  defaultMs: number,
  maxMs: number,
  name: string,
): number {
  if (hours === undefined) return defaultMs;
  if (!Number.isFinite(hours) || hours <= 0) throw new Error(`${name} must be positive.`);
  const value = Math.floor(hours * 60 * 60 * 1_000);
  if (value < 1 || value > maxMs) {
    throw new Error(`${name} exceeds the allowed lifetime.`);
  }
  return value;
}

function requireIso(value: string, name: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be an ISO-8601 timestamp.`);
  return iso(parsed);
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
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

function dedupeBy<T>(values: T[], key: (value: T) => string): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const entry = key(value);
    if (seen.has(entry)) return false;
    seen.add(entry);
    return true;
  });
}

function validateConfig(config: ExecutionCoordinationConfig): void {
  const positive = [
    "peerDefaultTtlMs",
    "peerMaxTtlMs",
    "taskOwnerDefaultLeaseMs",
    "taskOwnerMaxLeaseMs",
    "intentDefaultTtlMs",
    "intentMaxTtlMs",
    "batonDefaultTtlMs",
    "batonMaxTtlMs",
    "peerRetentionMs",
    "eventRetentionMs",
    "terminalRetentionMs",
    "commandRetentionMs",
    "cleanupIntervalMs",
    "maxBodyCharacters",
    "maxFrontierCharacters",
    "maxReferenceCharacters",
    "maxReferencesPerField",
    "maxSurfacesPerIntent",
    "maxCapabilitiesPerPeer",
  ] as const;
  for (const key of positive) {
    if (!Number.isInteger(config[key]) || config[key] <= 0) {
      throw new Error(`Execution coordination ${key} must be a positive integer.`);
    }
  }
  if (config.peerDefaultTtlMs > config.peerMaxTtlMs
    || config.taskOwnerDefaultLeaseMs > config.taskOwnerMaxLeaseMs
    || config.intentDefaultTtlMs > config.intentMaxTtlMs
    || config.batonDefaultTtlMs > config.batonMaxTtlMs) {
    throw new Error("Execution coordination default TTLs cannot exceed their maxima.");
  }
}
