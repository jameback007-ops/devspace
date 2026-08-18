import type { SqliteDatabase } from "./db/client.js";
import type {
  CoordinationBaton,
  CoordinationEvent,
  CoordinationIntent,
  CoordinationPeerCard,
  CoordinationTask,
} from "./execution-coordination-model.js";

export const EXECUTION_COORDINATION_SCHEMA_VERSION = 1;

export interface ExecutionCoordinationRetention {
  peerRetentionMs: number;
  eventRetentionMs: number;
  terminalRetentionMs: number;
  commandRetentionMs: number;
}

export interface CoordinationCommandRecord {
  actorScopeRef: string;
  idempotencyKey: string;
  commandKind: string;
  payloadDigestSha256: string;
  resultJson: string;
  createdAtMs: number;
}

export interface CoordinationAuditRecord {
  entityType: "peer" | "task" | "event" | "intent" | "baton";
  entityId: string;
  actorScopeRef: string;
  action: string;
  fromState?: string;
  toState?: string;
  revision?: number;
  payloadDigestSha256: string;
  detailJson?: string;
  recordedAtMs: number;
}

interface PeerRow {
  scope_ref: string;
  generation: number;
  payload_json: string;
  payload_digest_sha256: string;
  published_at_ms: number;
  heartbeat_at_ms: number;
  expires_at_ms: number;
  updated_at_ms: number;
}

interface TaskRow {
  task_id: string;
  context_id: string;
  owner_scope_ref: string;
  state: string;
  revision: number;
  payload_json: string;
  payload_digest_sha256: string;
  created_at_ms: number;
  updated_at_ms: number;
  owner_lease_expires_at_ms: number;
  terminal_at_ms: number | null;
}

interface EventRow {
  event_id: string;
  task_id: string | null;
  context_id: string;
  thread_id: string;
  sender_scope_ref: string;
  kind: string;
  payload_json: string;
  payload_digest_sha256: string;
  created_at_ms: number;
}

interface IntentRow {
  intent_id: string;
  task_id: string;
  context_id: string;
  owner_scope_ref: string;
  kind: string;
  state: string;
  revision: number;
  payload_json: string;
  payload_digest_sha256: string;
  created_at_ms: number;
  renewed_at_ms: number;
  expires_at_ms: number;
  released_at_ms: number | null;
}

interface BatonRow {
  baton_id: string;
  task_id: string;
  context_id: string;
  kind: string;
  state: string;
  revision: number;
  from_scope_ref: string;
  to_scope_ref: string;
  payload_json: string;
  payload_digest_sha256: string;
  created_at_ms: number;
  updated_at_ms: number;
  expires_at_ms: number;
  responded_at_ms: number | null;
  consumed_at_ms: number | null;
}

export function installExecutionCoordinationSchema(
  sqlite: SqliteDatabase,
  installedAtMs = Date.now(),
): void {
  const transaction = sqlite.transaction(() => {
    sqlite.exec(`
      create table if not exists execution_coordination_schema_versions (
        version integer primary key,
        installed_at_ms integer not null
      );

      create table if not exists execution_coordination_peers (
        scope_ref text primary key,
        generation integer not null,
        payload_json text not null,
        payload_digest_sha256 text not null,
        published_at_ms integer not null,
        heartbeat_at_ms integer not null,
        expires_at_ms integer not null,
        updated_at_ms integer not null
      );
      create index if not exists execution_coordination_peers_freshness_idx
        on execution_coordination_peers(expires_at_ms, updated_at_ms);

      create table if not exists execution_coordination_tasks (
        task_id text primary key,
        context_id text not null,
        owner_scope_ref text not null,
        state text not null,
        revision integer not null,
        payload_json text not null,
        payload_digest_sha256 text not null,
        created_at_ms integer not null,
        updated_at_ms integer not null,
        owner_lease_expires_at_ms integer not null,
        terminal_at_ms integer
      );
      create index if not exists execution_coordination_tasks_context_idx
        on execution_coordination_tasks(context_id, updated_at_ms);
      create index if not exists execution_coordination_tasks_owner_idx
        on execution_coordination_tasks(owner_scope_ref, state, owner_lease_expires_at_ms);
      create index if not exists execution_coordination_tasks_state_idx
        on execution_coordination_tasks(state, updated_at_ms);

      create table if not exists execution_coordination_events (
        event_id text primary key,
        task_id text references execution_coordination_tasks(task_id) on delete set null,
        context_id text not null,
        thread_id text not null,
        sender_scope_ref text not null,
        kind text not null,
        payload_json text not null,
        payload_digest_sha256 text not null,
        created_at_ms integer not null
      );
      create index if not exists execution_coordination_events_thread_idx
        on execution_coordination_events(thread_id, created_at_ms, event_id);
      create index if not exists execution_coordination_events_task_idx
        on execution_coordination_events(task_id, created_at_ms);
      create index if not exists execution_coordination_events_context_idx
        on execution_coordination_events(context_id, created_at_ms);

      create table if not exists execution_coordination_intents (
        intent_id text primary key,
        task_id text not null references execution_coordination_tasks(task_id) on delete cascade,
        context_id text not null,
        owner_scope_ref text not null,
        kind text not null,
        state text not null,
        revision integer not null,
        payload_json text not null,
        payload_digest_sha256 text not null,
        created_at_ms integer not null,
        renewed_at_ms integer not null,
        expires_at_ms integer not null,
        released_at_ms integer
      );
      create index if not exists execution_coordination_intents_active_idx
        on execution_coordination_intents(state, expires_at_ms, owner_scope_ref);
      create index if not exists execution_coordination_intents_task_idx
        on execution_coordination_intents(task_id, state, expires_at_ms);

      create table if not exists execution_coordination_batons (
        baton_id text primary key,
        task_id text not null references execution_coordination_tasks(task_id) on delete cascade,
        context_id text not null,
        kind text not null,
        state text not null,
        revision integer not null,
        from_scope_ref text not null,
        to_scope_ref text not null,
        payload_json text not null,
        payload_digest_sha256 text not null,
        created_at_ms integer not null,
        updated_at_ms integer not null,
        expires_at_ms integer not null,
        responded_at_ms integer,
        consumed_at_ms integer
      );
      create index if not exists execution_coordination_batons_target_idx
        on execution_coordination_batons(to_scope_ref, state, expires_at_ms);
      create index if not exists execution_coordination_batons_task_idx
        on execution_coordination_batons(task_id, kind, state);

      create table if not exists execution_coordination_commands (
        actor_scope_ref text not null,
        idempotency_key text not null,
        command_kind text not null,
        payload_digest_sha256 text not null,
        result_json text not null,
        created_at_ms integer not null,
        primary key(actor_scope_ref, idempotency_key)
      );
      create index if not exists execution_coordination_commands_time_idx
        on execution_coordination_commands(created_at_ms);

      create table if not exists execution_coordination_audit (
        sequence integer primary key autoincrement,
        entity_type text not null,
        entity_id text not null,
        actor_scope_ref text not null,
        action text not null,
        from_state text,
        to_state text,
        revision integer,
        payload_digest_sha256 text not null,
        detail_json text,
        recorded_at_ms integer not null
      );
      create index if not exists execution_coordination_audit_entity_idx
        on execution_coordination_audit(entity_type, entity_id, sequence);
      create index if not exists execution_coordination_audit_time_idx
        on execution_coordination_audit(recorded_at_ms);
    `);
    sqlite.prepare(`
      insert into execution_coordination_schema_versions(version, installed_at_ms)
      values (?, ?)
      on conflict(version) do nothing
    `).run(EXECUTION_COORDINATION_SCHEMA_VERSION, installedAtMs);
  });
  transaction.immediate();
}

export function assertExecutionCoordinationSchema(sqlite: SqliteDatabase): void {
  try {
    const row = sqlite.prepare(`
      select version from execution_coordination_schema_versions
       where version = ?
    `).get(EXECUTION_COORDINATION_SCHEMA_VERSION) as { version: number } | undefined;
    if (!row) throw new Error("missing schema version");
  } catch (error) {
    throw new Error(
      "Execution coordination persistence is not installed. Apply the coordination schema migration before enabling the manager.",
      { cause: error },
    );
  }
}

export class SqliteExecutionCoordinationStore {
  constructor(readonly sqlite: SqliteDatabase) {}

  peer(scopeRef: string): CoordinationPeerCard | undefined {
    const row = this.sqlite.prepare(
      "select * from execution_coordination_peers where scope_ref = ?",
    ).get(scopeRef) as PeerRow | undefined;
    return row ? parseJson<CoordinationPeerCard>(row.payload_json) : undefined;
  }

  peers(): CoordinationPeerCard[] {
    return (this.sqlite.prepare(`
      select * from execution_coordination_peers
       order by updated_at_ms desc, scope_ref asc
    `).all() as PeerRow[]).map((row) => parseJson<CoordinationPeerCard>(row.payload_json));
  }

  putPeer(peer: CoordinationPeerCard, digest: string, nowMs: number): void {
    this.sqlite.prepare(`
      insert into execution_coordination_peers (
        scope_ref, generation, payload_json, payload_digest_sha256,
        published_at_ms, heartbeat_at_ms, expires_at_ms, updated_at_ms
      ) values (?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(scope_ref) do update set
        generation = excluded.generation,
        payload_json = excluded.payload_json,
        payload_digest_sha256 = excluded.payload_digest_sha256,
        published_at_ms = excluded.published_at_ms,
        heartbeat_at_ms = excluded.heartbeat_at_ms,
        expires_at_ms = excluded.expires_at_ms,
        updated_at_ms = excluded.updated_at_ms
    `).run(
      peer.scopeRef,
      peer.generation,
      JSON.stringify(peer),
      digest,
      Date.parse(peer.publishedAt),
      Date.parse(peer.heartbeatAt),
      Date.parse(peer.expiresAt),
      nowMs,
    );
  }

  task(taskId: string): CoordinationTask | undefined {
    const row = this.sqlite.prepare(
      "select * from execution_coordination_tasks where task_id = ?",
    ).get(taskId) as TaskRow | undefined;
    return row ? parseJson<CoordinationTask>(row.payload_json) : undefined;
  }

  tasks(): CoordinationTask[] {
    return (this.sqlite.prepare(`
      select * from execution_coordination_tasks
       order by updated_at_ms desc, task_id asc
    `).all() as TaskRow[]).map((row) => parseJson<CoordinationTask>(row.payload_json));
  }

  putTask(task: CoordinationTask, digest: string): void {
    this.sqlite.prepare(`
      insert into execution_coordination_tasks (
        task_id, context_id, owner_scope_ref, state, revision,
        payload_json, payload_digest_sha256, created_at_ms, updated_at_ms,
        owner_lease_expires_at_ms, terminal_at_ms
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(task_id) do update set
        context_id = excluded.context_id,
        owner_scope_ref = excluded.owner_scope_ref,
        state = excluded.state,
        revision = excluded.revision,
        payload_json = excluded.payload_json,
        payload_digest_sha256 = excluded.payload_digest_sha256,
        updated_at_ms = excluded.updated_at_ms,
        owner_lease_expires_at_ms = excluded.owner_lease_expires_at_ms,
        terminal_at_ms = excluded.terminal_at_ms
    `).run(
      task.taskId,
      task.contextId,
      task.ownerScopeRef,
      task.state,
      task.revision,
      JSON.stringify(task),
      digest,
      Date.parse(task.createdAt),
      Date.parse(task.updatedAt),
      Date.parse(task.ownerLeaseExpiresAt),
      task.terminalAt ? Date.parse(task.terminalAt) : null,
    );
  }

  event(eventId: string): CoordinationEvent | undefined {
    const row = this.sqlite.prepare(
      "select * from execution_coordination_events where event_id = ?",
    ).get(eventId) as EventRow | undefined;
    return row ? parseJson<CoordinationEvent>(row.payload_json) : undefined;
  }

  events(options: { threadId?: string; taskId?: string; contextId?: string } = {}): CoordinationEvent[] {
    const clauses: string[] = [];
    const values: string[] = [];
    if (options.threadId) {
      clauses.push("thread_id = ?");
      values.push(options.threadId);
    }
    if (options.taskId) {
      clauses.push("task_id = ?");
      values.push(options.taskId);
    }
    if (options.contextId) {
      clauses.push("context_id = ?");
      values.push(options.contextId);
    }
    const where = clauses.length > 0 ? `where ${clauses.join(" and ")}` : "";
    return (this.sqlite.prepare(`
      select * from execution_coordination_events ${where}
       order by created_at_ms asc, event_id asc
    `).all(...values) as EventRow[]).map((row) => parseJson<CoordinationEvent>(row.payload_json));
  }

  insertEvent(event: CoordinationEvent, digest: string): void {
    this.sqlite.prepare(`
      insert into execution_coordination_events (
        event_id, task_id, context_id, thread_id, sender_scope_ref,
        kind, payload_json, payload_digest_sha256, created_at_ms
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.eventId,
      event.taskId ?? null,
      event.contextId,
      event.threadId,
      event.senderScopeRef,
      event.kind,
      JSON.stringify(event),
      digest,
      Date.parse(event.createdAt),
    );
  }

  intent(intentId: string): CoordinationIntent | undefined {
    const row = this.sqlite.prepare(
      "select * from execution_coordination_intents where intent_id = ?",
    ).get(intentId) as IntentRow | undefined;
    return row ? parseJson<CoordinationIntent>(row.payload_json) : undefined;
  }

  intents(): CoordinationIntent[] {
    return (this.sqlite.prepare(`
      select * from execution_coordination_intents
       order by renewed_at_ms desc, intent_id asc
    `).all() as IntentRow[]).map((row) => parseJson<CoordinationIntent>(row.payload_json));
  }

  putIntent(intent: CoordinationIntent, digest: string): void {
    this.sqlite.prepare(`
      insert into execution_coordination_intents (
        intent_id, task_id, context_id, owner_scope_ref, kind, state, revision,
        payload_json, payload_digest_sha256, created_at_ms, renewed_at_ms,
        expires_at_ms, released_at_ms
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(intent_id) do update set
        state = excluded.state,
        revision = excluded.revision,
        payload_json = excluded.payload_json,
        payload_digest_sha256 = excluded.payload_digest_sha256,
        renewed_at_ms = excluded.renewed_at_ms,
        expires_at_ms = excluded.expires_at_ms,
        released_at_ms = excluded.released_at_ms
    `).run(
      intent.intentId,
      intent.taskId,
      intent.contextId,
      intent.ownerScopeRef,
      intent.kind,
      intent.state,
      intent.revision,
      JSON.stringify(intent),
      digest,
      Date.parse(intent.createdAt),
      Date.parse(intent.renewedAt),
      Date.parse(intent.expiresAt),
      intent.releasedAt ? Date.parse(intent.releasedAt) : null,
    );
  }

  baton(batonId: string): CoordinationBaton | undefined {
    const row = this.sqlite.prepare(
      "select * from execution_coordination_batons where baton_id = ?",
    ).get(batonId) as BatonRow | undefined;
    return row ? parseJson<CoordinationBaton>(row.payload_json) : undefined;
  }

  batons(): CoordinationBaton[] {
    return (this.sqlite.prepare(`
      select * from execution_coordination_batons
       order by updated_at_ms desc, baton_id asc
    `).all() as BatonRow[]).map((row) => parseJson<CoordinationBaton>(row.payload_json));
  }

  putBaton(baton: CoordinationBaton, digest: string): void {
    this.sqlite.prepare(`
      insert into execution_coordination_batons (
        baton_id, task_id, context_id, kind, state, revision,
        from_scope_ref, to_scope_ref, payload_json, payload_digest_sha256,
        created_at_ms, updated_at_ms, expires_at_ms, responded_at_ms, consumed_at_ms
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(baton_id) do update set
        state = excluded.state,
        revision = excluded.revision,
        payload_json = excluded.payload_json,
        payload_digest_sha256 = excluded.payload_digest_sha256,
        updated_at_ms = excluded.updated_at_ms,
        expires_at_ms = excluded.expires_at_ms,
        responded_at_ms = excluded.responded_at_ms,
        consumed_at_ms = excluded.consumed_at_ms
    `).run(
      baton.batonId,
      baton.taskId,
      baton.contextId,
      baton.kind,
      baton.state,
      baton.revision,
      baton.fromScopeRef,
      baton.toScopeRef,
      JSON.stringify(baton),
      digest,
      Date.parse(baton.createdAt),
      Date.parse(baton.updatedAt),
      Date.parse(baton.expiresAt),
      baton.respondedAt ? Date.parse(baton.respondedAt) : null,
      baton.consumedAt ? Date.parse(baton.consumedAt) : null,
    );
  }

  command(actorScopeRef: string, idempotencyKey: string): CoordinationCommandRecord | undefined {
    return this.sqlite.prepare(`
      select actor_scope_ref as actorScopeRef,
             idempotency_key as idempotencyKey,
             command_kind as commandKind,
             payload_digest_sha256 as payloadDigestSha256,
             result_json as resultJson,
             created_at_ms as createdAtMs
        from execution_coordination_commands
       where actor_scope_ref = ? and idempotency_key = ?
    `).get(actorScopeRef, idempotencyKey) as CoordinationCommandRecord | undefined;
  }

  insertCommand(record: CoordinationCommandRecord): void {
    this.sqlite.prepare(`
      insert into execution_coordination_commands (
        actor_scope_ref, idempotency_key, command_kind,
        payload_digest_sha256, result_json, created_at_ms
      ) values (?, ?, ?, ?, ?, ?)
    `).run(
      record.actorScopeRef,
      record.idempotencyKey,
      record.commandKind,
      record.payloadDigestSha256,
      record.resultJson,
      record.createdAtMs,
    );
  }

  appendAudit(record: CoordinationAuditRecord): void {
    this.sqlite.prepare(`
      insert into execution_coordination_audit (
        entity_type, entity_id, actor_scope_ref, action,
        from_state, to_state, revision, payload_digest_sha256,
        detail_json, recorded_at_ms
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.entityType,
      record.entityId,
      record.actorScopeRef,
      record.action,
      record.fromState ?? null,
      record.toState ?? null,
      record.revision ?? null,
      record.payloadDigestSha256,
      record.detailJson ?? null,
      record.recordedAtMs,
    );
  }

  cleanup(nowMs: number, retention: ExecutionCoordinationRetention): void {
    const eventCutoff = nowMs - retention.eventRetentionMs;
    const terminalCutoff = nowMs - retention.terminalRetentionMs;
    const peerCutoff = nowMs - retention.peerRetentionMs;
    const commandCutoff = nowMs - retention.commandRetentionMs;
    const transaction = this.sqlite.transaction(() => {
      this.sqlite.prepare(
        "delete from execution_coordination_events where created_at_ms < ?",
      ).run(eventCutoff);
      this.sqlite.prepare(`
        delete from execution_coordination_intents
         where state in ('released', 'expired') and renewed_at_ms < ?
      `).run(terminalCutoff);
      this.sqlite.prepare(`
        delete from execution_coordination_batons
         where state in ('rejected', 'revoked', 'consumed', 'expired') and updated_at_ms < ?
      `).run(terminalCutoff);
      this.sqlite.prepare(`
        delete from execution_coordination_tasks
         where terminal_at_ms is not null and terminal_at_ms < ?
      `).run(terminalCutoff);
      this.sqlite.prepare(`
        delete from execution_coordination_peers
         where expires_at_ms < ?
      `).run(peerCutoff);
      this.sqlite.prepare(
        "delete from execution_coordination_commands where created_at_ms < ?",
      ).run(commandCutoff);
      this.sqlite.prepare(
        "delete from execution_coordination_audit where recorded_at_ms < ?",
      ).run(eventCutoff);
    });
    transaction.immediate();
  }
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}
