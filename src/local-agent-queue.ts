import { createHash, randomUUID } from "node:crypto";
import { openDatabase, type DatabaseHandle } from "./db/client.js";
import type {
  ExecutionMessageKind,
  ExecutionMessagePriority,
} from "./execution-mailbox.js";

export type LocalAgentTurnSourceKind = "cli" | "execution_scope";

export type LocalAgentTurnStatus =
  | "queued"
  | "claimed"
  | "running"
  | "cancel_requested"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "indeterminate";

export type LocalAgentIndeterminateResolution =
  | "retry"
  | "cancelled"
  | "succeeded";

export interface LocalAgentQueueConfig {
  maxPendingPerAgent: number;
  maxBodyCharacters: number;
  maxResponseCharacters: number;
  leaseMs: number;
  heartbeatMs: number;
  terminalRetentionMs: number;
}

export interface LocalAgentTurnEnvelope {
  idempotencyKey: string;
  kind: ExecutionMessageKind;
  priority?: ExecutionMessagePriority;
  body: string;
  correlationRef?: string;
}

export interface LocalAgentTurnEnqueueInput extends LocalAgentTurnEnvelope {
  agentId: string;
  sourceKind: LocalAgentTurnSourceKind;
  senderScopeRef?: string;
  supersedePending?: boolean;
  /** Effective provider configuration snapshotted onto the durable turn. */
  model?: string;
  thinking?: string;
  /** Explicit caller overrides used only for exact idempotency comparison. */
  requestedModel?: string;
  requestedThinking?: string;
}

export interface LocalAgentTurnView {
  schemaVersion: 1;
  turnId: string;
  agentId: string;
  sourceKind: LocalAgentTurnSourceKind;
  senderScopeRef?: string;
  kind: ExecutionMessageKind;
  priority: ExecutionMessagePriority;
  body: string;
  correlationRef?: string;
  model?: string;
  thinking?: string;
  status: LocalAgentTurnStatus;
  sequence: number;
  createdAt: string;
  claimedAt?: string;
  startedAt?: string;
  completedAt?: string;
  workerRef?: string;
  providerSessionIdBefore?: string;
  providerSessionIdAfter?: string;
  finalResponse?: string;
  resultCharacters?: number;
  resultDigestSha256?: string;
  errorKind?: string;
  errorSummary?: string;
  errorDigestSha256?: string;
  cancelRequestedAt?: string;
  cancelNote?: string;
  resolution?: string;
  resolutionNote?: string;
  supersededByTurnId?: string;
}

export interface LocalAgentQueueSummary {
  queued: number;
  running: number;
  cancelRequested: number;
  indeterminate: number;
  failed: number;
  workerLeaseActive: boolean;
  workerLeaseExpiresAt?: string;
}

export interface LocalAgentLeaseResult {
  acquired: boolean;
  recoveredClaimedCount: number;
  indeterminateTurnIds: string[];
}

export interface LocalAgentClaimResult {
  state: "claimed" | "empty" | "blocked" | "lease_lost";
  turn?: LocalAgentTurnView;
  blockingTurnIds?: string[];
}

export type LocalAgentIdleLeaseRelease =
  | "released"
  | "work_available"
  | "lease_lost";

export interface LocalAgentTurnResolutionInput {
  turnId: string;
  resolution: LocalAgentIndeterminateResolution;
  note: string;
  providerSessionIdAfter?: string;
  finalResponse?: string;
}

export interface LocalAgentProviderResultEvidence {
  providerSessionIdAfter?: string | null;
  finalResponse?: string;
}

export interface LocalAgentQueueOptions {
  now?: () => number;
}

interface AgentRow {
  id: string;
  provider_session_id: string | null;
  status: string;
}

interface TurnRow {
  id: string;
  agent_id: string;
  source_kind: string;
  sender_scope_ref: string | null;
  idempotency_namespace: string;
  idempotency_key: string;
  payload_digest_sha256: string;
  kind: string;
  priority: string;
  body: string;
  correlation_ref: string | null;
  model: string | null;
  thinking: string | null;
  status: string;
  sequence: number;
  created_at_ms: number;
  claimed_at_ms: number | null;
  started_at_ms: number | null;
  completed_at_ms: number | null;
  worker_id: string | null;
  provider_session_id_before: string | null;
  provider_session_id_after: string | null;
  final_response: string | null;
  result_characters: number | null;
  result_digest_sha256: string | null;
  error_kind: string | null;
  error_summary: string | null;
  error_digest_sha256: string | null;
  cancel_requested_at_ms: number | null;
  cancel_note: string | null;
  resolution: string | null;
  resolution_note: string | null;
  superseded_by_turn_id: string | null;
}

interface LeaseRow {
  agent_id: string;
  worker_id: string;
  acquired_at_ms: number;
  heartbeat_at_ms: number;
  expires_at_ms: number;
}

const AGENT_ID_PATTERN = /^agt_[a-f0-9]{8}$/;
const TURN_ID_PATTERN = /^atn_[a-f0-9]{32}$/;
const SCOPE_REF_PATTERN = /^[a-f0-9]{16}$/;
const MAX_IDEMPOTENCY_KEY_CHARACTERS = 200;
const MAX_CORRELATION_REF_CHARACTERS = 1_000;
const MAX_NOTE_CHARACTERS = 4_000;
const PRIORITY_RANK: Record<ExecutionMessagePriority, number> = {
  urgent: 0,
  high: 1,
  normal: 2,
  low: 3,
};

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function iso(value: number | null | undefined): string | undefined {
  return value === null || value === undefined
    ? undefined
    : new Date(value).toISOString();
}

function boundedText(
  value: string | undefined,
  label: string,
  maximum: number,
  required = false,
): string | undefined {
  const normalized = value?.trim();
  if (!normalized) {
    if (required) throw new Error(`${label} must not be empty.`);
    return undefined;
  }
  if (normalized.length > maximum) {
    throw new Error(`${label} exceeds the ${maximum}-character limit.`);
  }
  return normalized;
}

function boundedPayloadText(
  value: string,
  label: string,
  maximum: number,
): string {
  if (value.length > maximum) {
    throw new Error(`${label} exceeds the ${maximum}-character limit.`);
  }
  return value;
}

function providerResultEvidence(
  input: LocalAgentProviderResultEvidence | undefined,
  maxResponseCharacters: number,
): {
  providerSessionIdAfter?: string;
  finalResponse?: string;
  hasFinalResponse: boolean;
  resultCharacters?: number;
  resultDigestSha256?: string;
} {
  if (!input) return { hasFinalResponse: false };
  const rawProviderSessionId = input.providerSessionIdAfter?.trim();
  const providerSessionIdAfter =
    rawProviderSessionId && rawProviderSessionId.length <= 2_000
      ? rawProviderSessionId
      : undefined;
  if (input.finalResponse === undefined) {
    return { providerSessionIdAfter, hasFinalResponse: false };
  }
  return {
    providerSessionIdAfter,
    finalResponse:
      input.finalResponse.length <= maxResponseCharacters
        ? input.finalResponse
        : undefined,
    hasFinalResponse: true,
    resultCharacters: input.finalResponse.length,
    resultDigestSha256: sha256(input.finalResponse),
  };
}

function requireAgentId(value: string): string {
  if (!AGENT_ID_PATTERN.test(value)) {
    throw new Error("Invalid local agent session identifier.");
  }
  return value;
}

function requireTurnId(value: string): string {
  if (!TURN_ID_PATTERN.test(value)) {
    throw new Error("Invalid local agent turn identifier.");
  }
  return value;
}

function requireScopeRef(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!SCOPE_REF_PATTERN.test(value)) {
    throw new Error("Execution scope references must be 16 lowercase hexadecimal characters.");
  }
  return value;
}

function messageKind(value: string): ExecutionMessageKind {
  if (["instruction", "correction", "question", "notice", "handoff"].includes(value)) {
    return value as ExecutionMessageKind;
  }
  throw new Error(`Invalid local agent message kind: ${value}`);
}

function messagePriority(value: string | undefined): ExecutionMessagePriority {
  const selected = value ?? "normal";
  if (["low", "normal", "high", "urgent"].includes(selected)) {
    return selected as ExecutionMessagePriority;
  }
  throw new Error(`Invalid local agent message priority: ${selected}`);
}

function turnSourceKind(value: string): LocalAgentTurnSourceKind {
  if (value === "cli" || value === "execution_scope") return value;
  throw new Error(`Invalid local agent turn source: ${value}`);
}

function turnStatus(value: string): LocalAgentTurnStatus {
  if (
    value === "queued"
    || value === "claimed"
    || value === "running"
    || value === "cancel_requested"
    || value === "succeeded"
    || value === "failed"
    || value === "cancelled"
    || value === "indeterminate"
  ) {
    return value;
  }
  return "indeterminate";
}

function workerRef(workerId: string | null): string | undefined {
  return workerId ? sha256(workerId).slice(0, 16) : undefined;
}

function turnView(row: TurnRow): LocalAgentTurnView {
  return {
    schemaVersion: 1,
    turnId: row.id,
    agentId: row.agent_id,
    sourceKind: turnSourceKind(row.source_kind),
    senderScopeRef: row.sender_scope_ref ?? undefined,
    kind: messageKind(row.kind),
    priority: messagePriority(row.priority),
    body: row.body,
    correlationRef: row.correlation_ref ?? undefined,
    model: row.model ?? undefined,
    thinking: row.thinking ?? undefined,
    status: turnStatus(row.status),
    sequence: row.sequence,
    createdAt: new Date(row.created_at_ms).toISOString(),
    claimedAt: iso(row.claimed_at_ms),
    startedAt: iso(row.started_at_ms),
    completedAt: iso(row.completed_at_ms),
    workerRef: workerRef(row.worker_id),
    providerSessionIdBefore: row.provider_session_id_before ?? undefined,
    providerSessionIdAfter: row.provider_session_id_after ?? undefined,
    finalResponse: row.final_response ?? undefined,
    resultCharacters: row.result_characters ?? undefined,
    resultDigestSha256: row.result_digest_sha256 ?? undefined,
    errorKind: row.error_kind ?? undefined,
    errorSummary: row.error_summary ?? undefined,
    errorDigestSha256: row.error_digest_sha256 ?? undefined,
    cancelRequestedAt: iso(row.cancel_requested_at_ms),
    cancelNote: row.cancel_note ?? undefined,
    resolution: row.resolution ?? undefined,
    resolutionNote: row.resolution_note ?? undefined,
    supersededByTurnId: row.superseded_by_turn_id ?? undefined,
  };
}

function priorityCaseSql(): string {
  return `case priority
    when 'urgent' then 0
    when 'high' then 1
    when 'normal' then 2
    else 3
  end`;
}

function genericErrorSummary(kind: string): string {
  return `Local agent turn ended with ${kind}. Inspect the originating agent session for details.`;
}

export class LocalAgentTurnQueue {
  private readonly database: DatabaseHandle;
  private readonly now: () => number;
  private nextCleanupAtMs = 0;
  private closed = false;

  constructor(
    readonly config: LocalAgentQueueConfig,
    stateDir: string,
    options: LocalAgentQueueOptions = {},
  ) {
    if (!Number.isInteger(config.maxPendingPerAgent) || config.maxPendingPerAgent < 1) {
      throw new Error("Local agent maxPendingPerAgent must be a positive integer.");
    }
    if (!Number.isInteger(config.maxBodyCharacters) || config.maxBodyCharacters < 1) {
      throw new Error("Local agent maxBodyCharacters must be a positive integer.");
    }
    if (!Number.isInteger(config.maxResponseCharacters) || config.maxResponseCharacters < 1) {
      throw new Error("Local agent maxResponseCharacters must be a positive integer.");
    }
    if (!Number.isInteger(config.leaseMs) || config.leaseMs < 1_000) {
      throw new Error("Local agent leaseMs must be at least 1000 milliseconds.");
    }
    if (
      !Number.isInteger(config.heartbeatMs)
      || config.heartbeatMs < 100
      || config.heartbeatMs >= config.leaseMs
    ) {
      throw new Error("Local agent heartbeatMs must be positive and less than leaseMs.");
    }
    if (!Number.isInteger(config.terminalRetentionMs) || config.terminalRetentionMs < 1) {
      throw new Error("Local agent terminalRetentionMs must be a positive integer.");
    }
    this.database = openDatabase(stateDir);
    this.now = options.now ?? Date.now;
    this.cleanup(this.now());
    this.scheduleCleanup(this.now());
  }

  enqueue(
    input: LocalAgentTurnEnqueueInput,
  ): { turn: LocalAgentTurnView; idempotentReplay: boolean; supersededTurnIds: string[] } {
    this.assertOpen();
    const agentId = requireAgentId(input.agentId);
    const sourceKind = turnSourceKind(input.sourceKind);
    const senderScopeRef = requireScopeRef(input.senderScopeRef);
    if (sourceKind === "execution_scope" && !senderScopeRef) {
      throw new Error("senderScopeRef is required for execution-scope agent messages.");
    }
    const idempotencyKey = boundedText(
      input.idempotencyKey,
      "idempotencyKey",
      MAX_IDEMPOTENCY_KEY_CHARACTERS,
      true,
    ) as string;
    const idempotencyNamespace = sourceKind === "execution_scope"
      ? `scope:${senderScopeRef}`
      : "cli";
    const kind = messageKind(input.kind);
    const priority = messagePriority(input.priority);
    const body = boundedText(
      input.body,
      "body",
      this.config.maxBodyCharacters,
      true,
    ) as string;
    const correlationRef = boundedText(
      input.correlationRef,
      "correlationRef",
      MAX_CORRELATION_REF_CHARACTERS,
    );
    const model = boundedText(input.model, "model", 1_000);
    const thinking = boundedText(input.thinking, "thinking", 1_000);
    const requestedModel = boundedText(
      input.requestedModel,
      "requestedModel",
      1_000,
    );
    const requestedThinking = boundedText(
      input.requestedThinking,
      "requestedThinking",
      1_000,
    );
    const payloadDigestSha256 = sha256(JSON.stringify({
      agentId,
      sourceKind,
      senderScopeRef: senderScopeRef ?? null,
      kind,
      priority,
      body,
      correlationRef: correlationRef ?? null,
      requestedModel: requestedModel ?? null,
      requestedThinking: requestedThinking ?? null,
      supersedePending: input.supersedePending === true,
    }));
    const nowMs = this.now();
    this.maybeCleanup(nowMs);

    const transaction = this.database.sqlite.transaction(() => {
      const agent = this.requireAgent(agentId);
      const existing = this.database.sqlite
        .prepare(`
          select * from local_agent_turns
           where agent_id = ? and idempotency_namespace = ? and idempotency_key = ?
        `)
        .get(agentId, idempotencyNamespace, idempotencyKey) as TurnRow | undefined;
      if (existing) {
        if (existing.payload_digest_sha256 !== payloadDigestSha256) {
          throw new Error(
            "The local-agent idempotencyKey was already used with a different payload.",
          );
        }
        return {
          row: existing,
          idempotentReplay: true,
          supersededTurnIds: [] as string[],
        };
      }

      const sequenceRow = this.database.sqlite
        .prepare(
          "select coalesce(max(sequence), 0) + 1 as sequence from local_agent_turns where agent_id = ?",
        )
        .get(agentId) as { sequence: number };
      const turnId = `atn_${randomUUID().replaceAll("-", "")}`;
      const supersededTurnIds: string[] = [];
      if (input.supersedePending === true) {
        const rows = this.database.sqlite
          .prepare(`
            select id from local_agent_turns
             where agent_id = ? and status = 'queued'
             order by sequence asc
          `)
          .all(agentId) as Array<{ id: string }>;
        const supersede = this.database.sqlite.prepare(`
          update local_agent_turns
             set status = 'cancelled', completed_at_ms = ?,
                 resolution = 'superseded', superseded_by_turn_id = ?
           where id = ? and agent_id = ? and status = 'queued'
        `);
        for (const row of rows) {
          if (supersede.run(nowMs, turnId, row.id, agentId).changes > 0) {
            supersededTurnIds.push(row.id);
          }
        }
      }

      const pending = this.database.sqlite
        .prepare(`
          select count(*) as count from local_agent_turns
           where agent_id = ?
             and status in ('queued', 'claimed', 'running', 'cancel_requested', 'indeterminate')
        `)
        .get(agentId) as { count: number };
      if (pending.count >= this.config.maxPendingPerAgent) {
        throw new Error(
          `Local agent ${agentId} reached its ${this.config.maxPendingPerAgent}-turn pending limit.`,
        );
      }

      const row: TurnRow = {
        id: turnId,
        agent_id: agentId,
        source_kind: sourceKind,
        sender_scope_ref: senderScopeRef ?? null,
        idempotency_namespace: idempotencyNamespace,
        idempotency_key: idempotencyKey,
        payload_digest_sha256: payloadDigestSha256,
        kind,
        priority,
        body,
        correlation_ref: correlationRef ?? null,
        model: model ?? null,
        thinking: thinking ?? null,
        status: "queued",
        sequence: sequenceRow.sequence,
        created_at_ms: nowMs,
        claimed_at_ms: null,
        started_at_ms: null,
        completed_at_ms: null,
        worker_id: null,
        provider_session_id_before: null,
        provider_session_id_after: null,
        final_response: null,
        result_characters: null,
        result_digest_sha256: null,
        error_kind: null,
        error_summary: null,
        error_digest_sha256: null,
        cancel_requested_at_ms: null,
        cancel_note: null,
        resolution: null,
        resolution_note: null,
        superseded_by_turn_id: null,
      };
      this.database.sqlite
        .prepare(`
          insert into local_agent_turns (
            id, agent_id, source_kind, sender_scope_ref,
            idempotency_namespace, idempotency_key,
            payload_digest_sha256, kind, priority, body, correlation_ref,
            model, thinking, status, sequence, created_at_ms
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)
        `)
        .run(
          row.id,
          row.agent_id,
          row.source_kind,
          row.sender_scope_ref,
          row.idempotency_namespace,
          row.idempotency_key,
          row.payload_digest_sha256,
          row.kind,
          row.priority,
          row.body,
          row.correlation_ref,
          row.model,
          row.thinking,
          row.sequence,
          row.created_at_ms,
        );
      if (
        agent.status !== "running"
        && agent.status !== "blocked"
        && agent.status !== "error"
      ) {
        this.updateAgentStatus(agentId, "queued", undefined);
      }
      return { row, idempotentReplay: false, supersededTurnIds };
    });

    const result = transaction.immediate();
    return {
      turn: turnView(result.row),
      idempotentReplay: result.idempotentReplay,
      supersededTurnIds: result.supersededTurnIds,
    };
  }

  acquireLease(agentIdInput: string, workerIdInput: string): LocalAgentLeaseResult {
    this.assertOpen();
    const agentId = requireAgentId(agentIdInput);
    const workerId = boundedText(workerIdInput, "workerId", 200, true) as string;
    const nowMs = this.now();
    const expiresAtMs = nowMs + this.config.leaseMs;
    const transaction = this.database.sqlite.transaction(() => {
      this.requireAgent(agentId);
      const existing = this.database.sqlite
        .prepare("select * from local_agent_worker_leases where agent_id = ?")
        .get(agentId) as LeaseRow | undefined;
      if (existing && existing.expires_at_ms > nowMs) {
        if (existing.worker_id === workerId) {
          this.database.sqlite
            .prepare(`
              update local_agent_worker_leases
                 set heartbeat_at_ms = ?, expires_at_ms = ?
               where agent_id = ? and worker_id = ?
            `)
            .run(nowMs, expiresAtMs, agentId, workerId);
          return {
            acquired: true,
            recoveredClaimedCount: 0,
            indeterminateTurnIds: [] as string[],
          };
        }
        return {
          acquired: false,
          recoveredClaimedCount: 0,
          indeterminateTurnIds: [] as string[],
        };
      }

      let recoveredClaimedCount = 0;
      const indeterminateTurnIds: string[] = [];
      recoveredClaimedCount = this.database.sqlite
        .prepare(`
          update local_agent_turns
             set status = 'queued', worker_id = null, claimed_at_ms = null
           where agent_id = ? and status = 'claimed'
        `)
        .run(agentId).changes;
      const uncertain = this.database.sqlite
        .prepare(`
          select id, worker_id from local_agent_turns
           where agent_id = ? and status in ('running', 'cancel_requested')
        `)
        .all(agentId) as Array<{ id: string; worker_id: string | null }>;
      const markIndeterminate = this.database.sqlite.prepare(`
        update local_agent_turns
           set status = 'indeterminate', completed_at_ms = ?,
               error_kind = 'worker_lease_expired',
               error_summary = ?,
               error_digest_sha256 = ?
         where id = ? and agent_id = ?
           and status in ('running', 'cancel_requested')
      `);
      for (const turn of uncertain) {
        const diagnostic = [
          `No live worker lease remained while local agent turn ${turn.id} was active.`,
          turn.worker_id ? `Prior worker: ${turn.worker_id}.` : "Prior worker was unknown.",
        ].join(" ");
        if (
          markIndeterminate.run(
            nowMs,
            genericErrorSummary("worker_lease_expired"),
            sha256(diagnostic),
            turn.id,
            agentId,
          ).changes > 0
        ) {
          indeterminateTurnIds.push(turn.id);
        }
      }
      if (existing) {
        this.database.sqlite
          .prepare("delete from local_agent_worker_leases where agent_id = ?")
          .run(agentId);
      }

      this.database.sqlite
        .prepare(`
          insert into local_agent_worker_leases (
            agent_id, worker_id, acquired_at_ms, heartbeat_at_ms, expires_at_ms
          ) values (?, ?, ?, ?, ?)
        `)
        .run(agentId, workerId, nowMs, nowMs, expiresAtMs);
      if (indeterminateTurnIds.length > 0) {
        this.updateAgentStatus(
          agentId,
          "blocked",
          "A prior worker lease expired during provider execution; reconcile the indeterminate turn before continuing.",
        );
      }
      return { acquired: true, recoveredClaimedCount, indeterminateTurnIds };
    });
    return transaction.immediate();
  }

  heartbeat(agentIdInput: string, workerIdInput: string): boolean {
    this.assertOpen();
    const agentId = requireAgentId(agentIdInput);
    const workerId = boundedText(workerIdInput, "workerId", 200, true) as string;
    const nowMs = this.now();
    return this.database.sqlite
      .prepare(`
        update local_agent_worker_leases
           set heartbeat_at_ms = ?, expires_at_ms = ?
         where agent_id = ? and worker_id = ? and expires_at_ms > ?
      `)
      .run(nowMs, nowMs + this.config.leaseMs, agentId, workerId, nowMs).changes > 0;
  }

  claimNext(agentIdInput: string, workerIdInput: string): LocalAgentClaimResult {
    this.assertOpen();
    const agentId = requireAgentId(agentIdInput);
    const workerId = boundedText(workerIdInput, "workerId", 200, true) as string;
    const nowMs = this.now();
    const transaction = this.database.sqlite.transaction(() => {
      const lease = this.database.sqlite
        .prepare(`
          select * from local_agent_worker_leases
           where agent_id = ? and worker_id = ? and expires_at_ms > ?
        `)
        .get(agentId, workerId, nowMs) as LeaseRow | undefined;
      if (!lease) return { state: "lease_lost" as const };

      const agent = this.requireAgent(agentId);
      if (agent.status === "error") {
        const latestFailure = this.database.sqlite
          .prepare(`
            select id from local_agent_turns
             where agent_id = ? and status = 'failed'
             order by completed_at_ms desc, sequence desc
             limit 1
          `)
          .get(agentId) as { id: string } | undefined;
        return {
          state: "blocked" as const,
          blockingTurnIds: latestFailure ? [latestFailure.id] : [],
        };
      }

      const blocking = this.database.sqlite
        .prepare(`
          select id from local_agent_turns
           where agent_id = ? and status = 'indeterminate'
           order by sequence asc
        `)
        .all(agentId) as Array<{ id: string }>;
      if (blocking.length > 0) {
        this.updateAgentStatus(
          agentId,
          "blocked",
          "An indeterminate local-agent turn requires explicit reconciliation.",
        );
        return {
          state: "blocked" as const,
          blockingTurnIds: blocking.map((row) => row.id),
        };
      }

      const row = this.database.sqlite
        .prepare(`
          select * from local_agent_turns
           where agent_id = ? and status = 'queued'
           order by ${priorityCaseSql()} asc, sequence asc
           limit 1
        `)
        .get(agentId) as TurnRow | undefined;
      if (!row) {
        this.refreshAgentStatus(agentId);
        return { state: "empty" as const };
      }

      const claimed = this.database.sqlite
        .prepare(`
          update local_agent_turns
             set status = 'claimed', claimed_at_ms = ?, worker_id = ?,
                 provider_session_id_before = ?
           where id = ? and agent_id = ? and status = 'queued'
        `)
        .run(nowMs, workerId, agent.provider_session_id, row.id, agentId);
      if (claimed.changes === 0) return { state: "empty" as const };
      const selected = this.getTurnRow(row.id);
      this.updateAgentStatus(agentId, "starting", undefined);
      return { state: "claimed" as const, turn: turnView(selected) };
    });
    return transaction.immediate();
  }

  markRunning(turnIdInput: string, workerIdInput: string): LocalAgentTurnView {
    this.assertOpen();
    const turnId = requireTurnId(turnIdInput);
    const workerId = boundedText(workerIdInput, "workerId", 200, true) as string;
    const nowMs = this.now();
    const row = this.getTurnRow(turnId);
    const status = row.cancel_requested_at_ms === null ? "running" : "cancel_requested";
    const changed = this.database.sqlite
      .prepare(`
        update local_agent_turns
           set status = ?, started_at_ms = coalesce(started_at_ms, ?)
         where id = ? and worker_id = ? and status = 'claimed'
      `)
      .run(status, nowMs, turnId, workerId);
    if (changed.changes === 0) {
      throw new Error(`Local agent turn ${turnId} is not claimable by this worker.`);
    }
    this.updateAgentStatus(row.agent_id, "running", undefined);
    return turnView(this.getTurnRow(turnId));
  }

  completeSuccess(
    turnIdInput: string,
    workerIdInput: string,
    result: {
      providerSessionId: string | null;
      finalResponse: string;
    },
  ): LocalAgentTurnView {
    this.assertOpen();
    const turnId = requireTurnId(turnIdInput);
    const workerId = boundedText(workerIdInput, "workerId", 200, true) as string;
    const providerSessionId = boundedText(
      result.providerSessionId ?? undefined,
      "providerSessionId",
      2_000,
    ) ?? null;
    const finalResponse = boundedPayloadText(
      result.finalResponse,
      "finalResponse",
      this.config.maxResponseCharacters,
    );
    const resultCharacters = finalResponse.length;
    const resultDigestSha256 = sha256(finalResponse);
    const nowMs = this.now();
    const transaction = this.database.sqlite.transaction(() => {
      const row = this.getTurnRow(turnId);
      if (row.status === "indeterminate") {
        if (row.worker_id === workerId) {
          this.persistIndeterminateEvidence(row.id, {
            providerSessionIdAfter: providerSessionId ?? undefined,
            finalResponse,
            hasFinalResponse: true,
            resultCharacters,
            resultDigestSha256,
          });
        }
        return this.getTurnRow(turnId);
      }
      if (row.worker_id !== workerId || !["running", "cancel_requested"].includes(row.status)) {
        throw new Error(`Local agent turn ${turnId} is not active for this worker.`);
      }
      if (!this.workerLeaseActive(row.agent_id, workerId, nowMs)) {
        this.database.sqlite
          .prepare(`
            update local_agent_turns
               set status = 'indeterminate', completed_at_ms = ?,
                   provider_session_id_after = ?, final_response = ?,
                   result_characters = ?, result_digest_sha256 = ?,
                   error_kind = 'worker_lease_lost', error_summary = ?,
                   error_digest_sha256 = ?
             where id = ? and worker_id = ?
               and status in ('running', 'cancel_requested')
          `)
          .run(
            nowMs,
            providerSessionId,
            finalResponse,
            resultCharacters,
            resultDigestSha256,
            genericErrorSummary("worker_lease_lost"),
            sha256(`Lease expired before successful provider result admission for ${turnId}.`),
            turnId,
            workerId,
          );
        this.updateAgentStatus(
          row.agent_id,
          "blocked",
          "A local-agent worker lost authority before provider result admission.",
        );
        return this.getTurnRow(turnId);
      }
      this.database.sqlite
        .prepare(`
          update local_agent_turns
             set status = 'succeeded', completed_at_ms = ?,
                 provider_session_id_after = ?, final_response = ?,
                 result_characters = ?, result_digest_sha256 = ?,
                 error_kind = null, error_summary = null,
                 error_digest_sha256 = null
           where id = ? and worker_id = ?
        `)
        .run(
          nowMs,
          providerSessionId,
          finalResponse,
          resultCharacters,
          resultDigestSha256,
          turnId,
          workerId,
        );
      this.database.sqlite
        .prepare(`
          update local_agent_sessions
             set provider_session_id = coalesce(?, provider_session_id),
                 status = 'idle', latest_response = ?, error = null,
                 updated_at = ?
           where id = ?
        `)
        .run(
          providerSessionId,
          finalResponse,
          new Date(nowMs).toISOString(),
          row.agent_id,
        );
      this.refreshAgentStatus(row.agent_id);
      return this.getTurnRow(turnId);
    });
    return turnView(transaction.immediate());
  }

  completeFailure(
    turnIdInput: string,
    workerIdInput: string,
    error: unknown,
  ): LocalAgentTurnView {
    this.assertOpen();
    const turnId = requireTurnId(turnIdInput);
    const workerId = boundedText(workerIdInput, "workerId", 200, true) as string;
    const nowMs = this.now();
    const transaction = this.database.sqlite.transaction(() => {
      const row = this.getTurnRow(turnId);
      if (row.status === "indeterminate") return row;
      if (row.worker_id !== workerId || !["running", "cancel_requested"].includes(row.status)) {
        throw new Error(`Local agent turn ${turnId} is not active for this worker.`);
      }
      const raw = error instanceof Error ? error.message : String(error);
      if (!this.workerLeaseActive(row.agent_id, workerId, nowMs)) {
        this.database.sqlite
          .prepare(`
            update local_agent_turns
               set status = 'indeterminate', completed_at_ms = ?,
                   error_kind = 'worker_lease_lost', error_summary = ?,
                   error_digest_sha256 = ?
             where id = ? and worker_id = ?
               and status in ('running', 'cancel_requested')
          `)
          .run(
            nowMs,
            genericErrorSummary("worker_lease_lost"),
            sha256(raw),
            turnId,
            workerId,
          );
        this.updateAgentStatus(
          row.agent_id,
          "blocked",
          "A local-agent worker lost authority while provider execution was active.",
        );
        return this.getTurnRow(turnId);
      }
      const kind = row.cancel_requested_at_ms !== null && isCancellationEvidence(error)
        ? "cancelled"
        : error instanceof Error
          ? error.name || "Error"
          : typeof error;
      const terminalStatus: LocalAgentTurnStatus = kind === "cancelled"
        ? "cancelled"
        : "failed";
      this.database.sqlite
        .prepare(`
          update local_agent_turns
             set status = ?, completed_at_ms = ?, error_kind = ?,
                 error_summary = ?, error_digest_sha256 = ?
           where id = ? and worker_id = ?
        `)
        .run(
          terminalStatus,
          nowMs,
          kind,
          genericErrorSummary(kind),
          sha256(raw),
          turnId,
          workerId,
        );
      this.updateAgentStatus(
        row.agent_id,
        terminalStatus === "cancelled" ? "idle" : "error",
        terminalStatus === "cancelled" ? undefined : genericErrorSummary(kind),
      );
      if (terminalStatus === "cancelled") {
        this.refreshAgentStatus(row.agent_id);
      }
      return this.getTurnRow(turnId);
    });
    return turnView(transaction.immediate());
  }

  markIndeterminate(
    turnIdInput: string,
    workerIdInput: string,
    errorKindInput: string,
    diagnosticInput: string,
    evidenceInput?: LocalAgentProviderResultEvidence,
  ): LocalAgentTurnView {
    this.assertOpen();
    const turnId = requireTurnId(turnIdInput);
    const workerId = boundedText(workerIdInput, "workerId", 200, true) as string;
    const errorKind = boundedText(errorKindInput, "errorKind", 200, true) as string;
    const diagnostic = boundedText(
      diagnosticInput,
      "diagnostic",
      MAX_NOTE_CHARACTERS,
      true,
    ) as string;
    const evidence = providerResultEvidence(
      evidenceInput,
      this.config.maxResponseCharacters,
    );
    const nowMs = this.now();
    const transaction = this.database.sqlite.transaction(() => {
      const row = this.getTurnRow(turnId);
      if (row.status === "indeterminate") {
        if (row.worker_id === workerId) {
          this.persistIndeterminateEvidence(row.id, evidence);
        }
        return this.getTurnRow(turnId);
      }
      if (
        row.worker_id !== workerId
        || !["claimed", "running", "cancel_requested"].includes(row.status)
      ) {
        throw new Error(
          `Local agent turn ${turnId} cannot be marked indeterminate by this worker.`,
        );
      }
      this.database.sqlite
        .prepare(`
          update local_agent_turns
             set status = 'indeterminate', completed_at_ms = ?,
                 provider_session_id_after = coalesce(?, provider_session_id_after),
                 final_response = case when ? = 1 then ? else final_response end,
                 result_characters = coalesce(?, result_characters),
                 result_digest_sha256 = coalesce(?, result_digest_sha256),
                 error_kind = ?, error_summary = ?, error_digest_sha256 = ?
           where id = ? and worker_id = ?
             and status in ('claimed', 'running', 'cancel_requested')
        `)
        .run(
          nowMs,
          evidence.providerSessionIdAfter ?? null,
          evidence.finalResponse !== undefined ? 1 : 0,
          evidence.finalResponse ?? null,
          evidence.resultCharacters ?? null,
          evidence.resultDigestSha256 ?? null,
          errorKind,
          genericErrorSummary(errorKind),
          sha256(diagnostic),
          turnId,
          workerId,
        );
      this.updateAgentStatus(
        row.agent_id,
        "blocked",
        "A local-agent worker lost authority during provider execution; reconcile the indeterminate turn before continuing.",
      );
      return this.getTurnRow(turnId);
    });
    return turnView(transaction.immediate());
  }

  requestCancel(turnIdInput: string, noteInput?: string): LocalAgentTurnView {
    this.assertOpen();
    const turnId = requireTurnId(turnIdInput);
    const note = boundedText(noteInput, "note", MAX_NOTE_CHARACTERS);
    const nowMs = this.now();
    const transaction = this.database.sqlite.transaction(() => {
      const row = this.getTurnRow(turnId);
      if (["succeeded", "failed", "cancelled"].includes(row.status)) {
        return row;
      }
      if (row.status === "indeterminate") {
        throw new Error(
          "Indeterminate local-agent turns require explicit reconciliation rather than cancellation.",
        );
      }
      if (row.status === "queued" || row.status === "claimed") {
        this.database.sqlite
          .prepare(`
            update local_agent_turns
               set status = 'cancelled', cancel_requested_at_ms = ?,
                   cancel_note = ?, completed_at_ms = ?
             where id = ? and status in ('queued', 'claimed')
          `)
          .run(nowMs, note ?? null, nowMs, turnId);
      } else {
        this.database.sqlite
          .prepare(`
            update local_agent_turns
               set status = 'cancel_requested',
                   cancel_requested_at_ms = coalesce(cancel_requested_at_ms, ?),
                   cancel_note = coalesce(cancel_note, ?)
             where id = ? and status in ('running', 'cancel_requested')
          `)
          .run(nowMs, note ?? null, turnId);
      }
      this.refreshAgentStatus(row.agent_id);
      return this.getTurnRow(turnId);
    });
    return turnView(transaction.immediate());
  }

  cancellationRequested(turnIdInput: string, workerIdInput: string): boolean {
    this.assertOpen();
    const turnId = requireTurnId(turnIdInput);
    const workerId = boundedText(workerIdInput, "workerId", 200, true) as string;
    const row = this.database.sqlite
      .prepare(`
        select cancel_requested_at_ms from local_agent_turns
         where id = ? and worker_id = ?
      `)
      .get(turnId, workerId) as { cancel_requested_at_ms: number | null } | undefined;
    return row?.cancel_requested_at_ms !== null && row?.cancel_requested_at_ms !== undefined;
  }

  resolveIndeterminate(input: LocalAgentTurnResolutionInput): LocalAgentTurnView {
    this.assertOpen();
    const turnId = requireTurnId(input.turnId);
    const note = boundedText(input.note, "note", MAX_NOTE_CHARACTERS, true) as string;
    const providerSessionIdAfter = boundedText(
      input.providerSessionIdAfter,
      "providerSessionIdAfter",
      2_000,
    );
    const hasProvidedFinalResponse = input.finalResponse !== undefined;
    const finalResponse = hasProvidedFinalResponse
      ? boundedPayloadText(
          input.finalResponse as string,
          "finalResponse",
          this.config.maxResponseCharacters,
        )
      : undefined;
    const nowMs = this.now();
    const transaction = this.database.sqlite.transaction(() => {
      const row = this.getTurnRow(turnId);
      if (row.status !== "indeterminate") {
        throw new Error(`Local agent turn ${turnId} is not indeterminate.`);
      }
      const effectiveProviderSessionId =
        providerSessionIdAfter ?? row.provider_session_id_after;
      const effectiveFinalResponse = hasProvidedFinalResponse
        ? finalResponse as string
        : row.final_response;
      const effectiveResultCharacters = hasProvidedFinalResponse
        ? (finalResponse as string).length
        : row.result_characters
          ?? (effectiveFinalResponse === null ? null : effectiveFinalResponse.length);
      const effectiveResultDigestSha256 = hasProvidedFinalResponse
        ? sha256(finalResponse as string)
        : row.result_digest_sha256
          ?? (effectiveFinalResponse === null ? null : sha256(effectiveFinalResponse));
      if (input.resolution === "retry") {
        this.database.sqlite
          .prepare(`
            update local_agent_turns
               set status = 'queued', claimed_at_ms = null, started_at_ms = null,
                   completed_at_ms = null, worker_id = null,
                   provider_session_id_after = null, final_response = null,
                   result_characters = null, result_digest_sha256 = null,
                   error_kind = null, error_summary = null,
                   error_digest_sha256 = null, cancel_requested_at_ms = null,
                   cancel_note = null, resolution = 'retry_authorized',
                   resolution_note = ?
             where id = ? and status = 'indeterminate'
          `)
          .run(note, turnId);
      } else if (input.resolution === "cancelled") {
        this.database.sqlite
          .prepare(`
            update local_agent_turns
               set status = 'cancelled', completed_at_ms = ?,
                   resolution = 'cancelled', resolution_note = ?
             where id = ? and status = 'indeterminate'
          `)
          .run(nowMs, note, turnId);
      } else {
        this.database.sqlite
          .prepare(`
            update local_agent_turns
             set status = 'succeeded', completed_at_ms = ?,
                   provider_session_id_after = ?, final_response = ?,
                   result_characters = ?, result_digest_sha256 = ?,
                   resolution = 'succeeded', resolution_note = ?,
                   error_kind = null, error_summary = null,
                   error_digest_sha256 = null
             where id = ? and status = 'indeterminate'
          `)
          .run(
            nowMs,
            effectiveProviderSessionId,
            effectiveFinalResponse,
            effectiveResultCharacters,
            effectiveResultDigestSha256,
            note,
            turnId,
          );
        if (effectiveProviderSessionId !== null || effectiveFinalResponse !== null) {
          this.database.sqlite
            .prepare(`
              update local_agent_sessions
                 set provider_session_id = coalesce(?, provider_session_id),
                     latest_response = case when ? = 1 then ? else latest_response end,
                     error = null, updated_at = ?
               where id = ?
            `)
            .run(
              effectiveProviderSessionId,
              effectiveFinalResponse !== null ? 1 : 0,
              effectiveFinalResponse,
              new Date(nowMs).toISOString(),
              row.agent_id,
            );
        }
      }
      this.refreshAgentStatus(row.agent_id);
      return this.getTurnRow(turnId);
    });
    return turnView(transaction.immediate());
  }

  getTurn(turnIdInput: string): LocalAgentTurnView {
    this.assertOpen();
    this.maybeCleanup(this.now());
    return turnView(this.getTurnRow(requireTurnId(turnIdInput)));
  }

  listTurns(
    agentIdInput: string,
    options: { limit?: number; includeTerminal?: boolean } = {},
  ): LocalAgentTurnView[] {
    this.assertOpen();
    const agentId = requireAgentId(agentIdInput);
    this.maybeCleanup(this.now());
    this.requireAgent(agentId);
    const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 20)));
    const terminalClause = options.includeTerminal === true
      ? ""
      : "and status in ('queued', 'claimed', 'running', 'cancel_requested', 'indeterminate')";
    const rows = this.database.sqlite
      .prepare(`
        select * from local_agent_turns
         where agent_id = ? ${terminalClause}
         order by sequence desc
         limit ?
      `)
      .all(agentId, limit) as TurnRow[];
    return rows.map(turnView);
  }

  summary(agentIdInput: string): LocalAgentQueueSummary {
    this.assertOpen();
    const agentId = requireAgentId(agentIdInput);
    this.maybeCleanup(this.now());
    this.requireAgent(agentId);
    const counts = this.database.sqlite
      .prepare(`
        select
          sum(case when status in ('queued', 'claimed') then 1 else 0 end) as queued,
          sum(case when status = 'running' then 1 else 0 end) as running,
          sum(case when status = 'cancel_requested' then 1 else 0 end) as cancel_requested,
          sum(case when status = 'indeterminate' then 1 else 0 end) as indeterminate,
          sum(case when status = 'failed' then 1 else 0 end) as failed
        from local_agent_turns where agent_id = ?
      `)
      .get(agentId) as Record<string, number | null>;
    const lease = this.database.sqlite
      .prepare("select * from local_agent_worker_leases where agent_id = ?")
      .get(agentId) as LeaseRow | undefined;
    const nowMs = this.now();
    return {
      queued: counts.queued ?? 0,
      running: counts.running ?? 0,
      cancelRequested: counts.cancel_requested ?? 0,
      indeterminate: counts.indeterminate ?? 0,
      failed: counts.failed ?? 0,
      workerLeaseActive: Boolean(lease && lease.expires_at_ms > nowMs),
      workerLeaseExpiresAt:
        lease && lease.expires_at_ms > nowMs
          ? new Date(lease.expires_at_ms).toISOString()
          : undefined,
    };
  }

  releaseLease(agentIdInput: string, workerIdInput: string): boolean {
    this.assertOpen();
    const agentId = requireAgentId(agentIdInput);
    const workerId = boundedText(workerIdInput, "workerId", 200, true) as string;
    const changes = this.database.sqlite
      .prepare(
        "delete from local_agent_worker_leases where agent_id = ? and worker_id = ?",
      )
      .run(agentId, workerId).changes;
    this.refreshAgentStatus(agentId);
    return changes > 0;
  }

  releaseLeaseIfIdle(
    agentIdInput: string,
    workerIdInput: string,
  ): LocalAgentIdleLeaseRelease {
    this.assertOpen();
    const agentId = requireAgentId(agentIdInput);
    const workerId = boundedText(workerIdInput, "workerId", 200, true) as string;
    const nowMs = this.now();
    const transaction = this.database.sqlite.transaction(() => {
      const lease = this.database.sqlite
        .prepare(`
          select 1 from local_agent_worker_leases
           where agent_id = ? and worker_id = ? and expires_at_ms > ?
        `)
        .get(agentId, workerId, nowMs);
      if (!lease) return "lease_lost" as const;
      const queued = this.database.sqlite
        .prepare(`
          select 1 from local_agent_turns
           where agent_id = ? and status = 'queued'
           limit 1
        `)
        .get(agentId);
      if (queued) return "work_available" as const;
      this.database.sqlite
        .prepare(
          "delete from local_agent_worker_leases where agent_id = ? and worker_id = ?",
        )
        .run(agentId, workerId);
      this.refreshAgentStatus(agentId);
      return "released" as const;
    });
    return transaction.immediate();
  }

  resumeAfterFailure(
    agentIdInput: string,
    noteInput?: string,
  ): LocalAgentQueueSummary {
    this.assertOpen();
    const agentId = requireAgentId(agentIdInput);
    const note = boundedText(noteInput, "note", MAX_NOTE_CHARACTERS);
    const nowMs = this.now();
    const transaction = this.database.sqlite.transaction(() => {
      const agent = this.requireAgent(agentId);
      const indeterminate = this.database.sqlite
        .prepare(`
          select count(*) as count from local_agent_turns
           where agent_id = ? and status = 'indeterminate'
        `)
        .get(agentId) as { count: number };
      if (indeterminate.count > 0) {
        throw new Error(
          "An indeterminate local-agent turn must be reconciled before the session can resume.",
        );
      }
      if (agent.status === "error") {
        this.database.sqlite
          .prepare(`
            update local_agent_turns
               set resolution = coalesce(resolution, 'resume_authorized'),
                   resolution_note = coalesce(resolution_note, ?)
             where id = (
               select id from local_agent_turns
                where agent_id = ? and status = 'failed'
                order by completed_at_ms desc, sequence desc
                limit 1
             )
          `)
          .run(note ?? null, agentId);
        // The failed provider turn is already terminal. Revoke the finishing
        // worker's lease before clearing the pause so a concurrent resume can
        // atomically reserve a replacement; the old worker's later release is
        // fenced by worker ID and cannot delete the new lease.
        this.database.sqlite
          .prepare("delete from local_agent_worker_leases where agent_id = ?")
          .run(agentId);
      }
      const queued = this.database.sqlite
        .prepare(`
          select count(*) as count from local_agent_turns
           where agent_id = ? and status = 'queued'
        `)
        .get(agentId) as { count: number };
      this.database.sqlite
        .prepare(`
          update local_agent_sessions
             set status = ?, error = null, updated_at = ?
           where id = ?
        `)
        .run(
          queued.count > 0 ? "queued" : "idle",
          new Date(nowMs).toISOString(),
          agentId,
        );
    });
    transaction.immediate();
    return this.summary(agentId);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
  }

  private requireAgent(agentId: string): AgentRow {
    const row = this.database.sqlite
      .prepare("select id, provider_session_id, status from local_agent_sessions where id = ?")
      .get(agentId) as AgentRow | undefined;
    if (!row) throw new Error(`Unknown local agent session: ${agentId}`);
    return row;
  }

  private getTurnRow(turnId: string): TurnRow {
    const row = this.database.sqlite
      .prepare("select * from local_agent_turns where id = ?")
      .get(turnId) as TurnRow | undefined;
    if (!row) throw new Error(`Unknown local agent turn: ${turnId}`);
    return row;
  }

  private updateAgentStatus(agentId: string, status: string, error: string | undefined): void {
    this.database.sqlite
      .prepare(`
        update local_agent_sessions
           set status = ?, error = ?, updated_at = ?
         where id = ?
      `)
      .run(status, error ?? null, new Date(this.now()).toISOString(), agentId);
  }

  private workerLeaseActive(agentId: string, workerId: string, nowMs: number): boolean {
    return Boolean(this.database.sqlite
      .prepare(`
        select 1 from local_agent_worker_leases
         where agent_id = ? and worker_id = ? and expires_at_ms > ?
      `)
      .get(agentId, workerId, nowMs));
  }

  private persistIndeterminateEvidence(
    turnId: string,
    evidence: {
      providerSessionIdAfter?: string;
      finalResponse?: string;
      hasFinalResponse: boolean;
      resultCharacters?: number;
      resultDigestSha256?: string;
    },
  ): void {
    this.database.sqlite
      .prepare(`
        update local_agent_turns
           set provider_session_id_after = coalesce(?, provider_session_id_after),
               final_response = case when ? = 1 then ? else final_response end,
               result_characters = coalesce(?, result_characters),
               result_digest_sha256 = coalesce(?, result_digest_sha256)
         where id = ? and status = 'indeterminate'
      `)
      .run(
        evidence.providerSessionIdAfter ?? null,
        evidence.finalResponse !== undefined ? 1 : 0,
        evidence.finalResponse ?? null,
        evidence.resultCharacters ?? null,
        evidence.resultDigestSha256 ?? null,
        turnId,
      );
  }

  private refreshAgentStatus(agentId: string): void {
    const summary = this.database.sqlite
      .prepare(`
        select
          sum(case when status = 'indeterminate' then 1 else 0 end) as indeterminate,
          sum(case when status in ('running', 'cancel_requested') then 1 else 0 end) as running,
          sum(case when status in ('queued', 'claimed') then 1 else 0 end) as queued
        from local_agent_turns where agent_id = ?
      `)
      .get(agentId) as Record<string, number | null>;
    const currentAgent = this.requireAgent(agentId);
    if ((summary.indeterminate ?? 0) > 0) {
      this.updateAgentStatus(
        agentId,
        "blocked",
        "An indeterminate local-agent turn requires explicit reconciliation.",
      );
    } else if ((summary.running ?? 0) > 0) {
      this.updateAgentStatus(agentId, "running", undefined);
    } else if (currentAgent.status === "error") {
      // completeFailure writes the terminal error before releasing its lease.
      // Preserve that exact result until a later successful/queued action
      // deliberately changes the session state; queue sequence is not
      // completion order because priority may reorder turns.
      return;
    } else if ((summary.queued ?? 0) > 0) {
      this.updateAgentStatus(agentId, "queued", undefined);
    } else {
      this.updateAgentStatus(agentId, "idle", undefined);
    }
  }

  private maybeCleanup(nowMs: number): void {
    if (nowMs < this.nextCleanupAtMs) return;
    this.cleanup(nowMs);
    this.scheduleCleanup(nowMs);
  }

  private cleanup(nowMs: number): void {
    const cutoff = nowMs - this.config.terminalRetentionMs;
    this.database.sqlite
      .prepare(`
        delete from local_agent_turns
         where status in ('succeeded', 'failed', 'cancelled')
           and completed_at_ms is not null and completed_at_ms < ?
           and not (
             status = 'failed'
             and exists (
               select 1 from local_agent_sessions session
                where session.id = local_agent_turns.agent_id
                  and session.status = 'error'
             )
           )
      `)
      .run(cutoff);
    // Keep expired lease rows until the next worker acquisition. The stale
    // worker ID is required to distinguish a safely recoverable claimed turn
    // from provider execution whose effects are indeterminate. There is at
    // most one lease row per agent and agent deletion cascades it away.
  }

  private scheduleCleanup(nowMs: number): void {
    this.nextCleanupAtMs = nowMs + Math.max(
      1_000,
      Math.min(60 * 60 * 1_000, Math.floor(this.config.terminalRetentionMs / 4)),
    );
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Local agent turn queue is closed.");
  }
}

export function localAgentPriorityRank(priority: ExecutionMessagePriority): number {
  return PRIORITY_RANK[priority];
}

function isCancellationEvidence(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "AbortError"
    || /\b(cancelled|canceled|aborted|sigint|interrupt(?:ed)?|terminated by signal)\b/i
      .test(error.message);
}
