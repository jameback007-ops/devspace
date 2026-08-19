import type { SqliteDatabase } from "./db/client.js";
import type {
  HostTurnEventRecord,
  HostTurnRecord,
  HostTurnSessionRecord,
} from "./host-turn-lifecycle-model.js";
import {
  HOST_TURN_LIFECYCLE_SCHEMA_SQL,
  HOST_TURN_LIFECYCLE_SCHEMA_VERSION,
} from "./host-turn-lifecycle-schema.js";

export { HOST_TURN_LIFECYCLE_SCHEMA_VERSION };

export interface HostTurnLifecycleCommandRecord {
  actorScopeRef: string;
  idempotencyKey: string;
  commandKind: string;
  payloadDigestSha256: string;
  resultJson: string;
  createdAtMs: number;
}

export interface HostTurnLifecycleRetention {
  terminalTurnRetentionMs: number;
  eventRetentionMs: number;
  commandRetentionMs: number;
}

interface SessionRow {
  payload_json: string;
}

interface TurnRow {
  payload_json: string;
}

interface EventRow {
  payload_json: string;
}

export function installHostTurnLifecycleSchema(
  sqlite: SqliteDatabase,
  installedAtMs = Date.now(),
): void {
  const transaction = sqlite.transaction(() => {
    sqlite.exec(HOST_TURN_LIFECYCLE_SCHEMA_SQL);
    sqlite.prepare(`
      insert into host_turn_lifecycle_schema_versions(version, installed_at_ms)
      values (?, ?)
      on conflict(version) do nothing
    `).run(HOST_TURN_LIFECYCLE_SCHEMA_VERSION, installedAtMs);
  });
  transaction.immediate();
}

export function assertHostTurnLifecycleSchema(sqlite: SqliteDatabase): void {
  try {
    const row = sqlite.prepare(`
      select version from host_turn_lifecycle_schema_versions where version = ?
    `).get(HOST_TURN_LIFECYCLE_SCHEMA_VERSION) as { version: number } | undefined;
    if (!row) throw new Error("missing schema version");
  } catch (error) {
    throw new Error(
      "Host-turn lifecycle persistence is not installed. Apply the host-turn lifecycle migration before enabling conversation wake effects.",
      { cause: error },
    );
  }
}

export class SqliteHostTurnLifecycleStore {
  constructor(readonly sqlite: SqliteDatabase) {}

  session(sessionRef: string): HostTurnSessionRecord | undefined {
    const row = this.sqlite.prepare(
      "select payload_json from host_turn_sessions where session_ref = ?",
    ).get(sessionRef) as SessionRow | undefined;
    return row ? parseJson<HostTurnSessionRecord>(row.payload_json) : undefined;
  }

  sessionForTarget(
    targetExecutionScopeRef: string,
    missionRef: string,
  ): HostTurnSessionRecord | undefined {
    const row = this.sqlite.prepare(`
      select payload_json from host_turn_sessions
       where target_execution_scope_ref = ? and mission_ref = ?
       limit 1
    `).get(targetExecutionScopeRef, missionRef) as SessionRow | undefined;
    return row ? parseJson<HostTurnSessionRecord>(row.payload_json) : undefined;
  }

  insertSession(record: HostTurnSessionRecord, digest: string): void {
    this.sqlite.prepare(`
      insert into host_turn_sessions (
        session_ref, logical_session_ref, target_execution_scope_ref, mission_ref,
        current_turn_ref, current_generation, revision,
        conversation_binding_ref, conversation_binding_generation,
        payload_json, payload_digest_sha256, created_at_ms, updated_at_ms
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.sessionRef,
      record.logicalSessionRef,
      record.targetExecutionScopeRef,
      record.missionRef,
      record.currentHostTurnRef ?? null,
      record.currentHostTurnGeneration,
      record.revision,
      record.conversationBindingRef,
      record.conversationBindingGeneration,
      JSON.stringify(record),
      digest,
      Date.parse(record.createdAt),
      Date.parse(record.updatedAt),
    );
  }

  compareAndSwapSession(
    record: HostTurnSessionRecord,
    expectedRevision: number,
    digest: string,
  ): {
    saved: boolean;
    record?: HostTurnSessionRecord;
    current?: HostTurnSessionRecord;
  } {
    const result = this.sqlite.prepare(`
      update host_turn_sessions
         set current_turn_ref = ?, current_generation = ?, revision = ?,
             conversation_binding_ref = ?, conversation_binding_generation = ?,
             payload_json = ?, payload_digest_sha256 = ?, updated_at_ms = ?
       where session_ref = ? and revision = ?
    `).run(
      record.currentHostTurnRef ?? null,
      record.currentHostTurnGeneration,
      record.revision,
      record.conversationBindingRef,
      record.conversationBindingGeneration,
      JSON.stringify(record),
      digest,
      Date.parse(record.updatedAt),
      record.sessionRef,
      expectedRevision,
    );
    if (result.changes === 1) return { saved: true, record };
    return { saved: false, current: this.session(record.sessionRef) };
  }

  turn(hostTurnRef: string): HostTurnRecord | undefined {
    const row = this.sqlite.prepare(
      "select payload_json from host_turn_records where host_turn_ref = ?",
    ).get(hostTurnRef) as TurnRow | undefined;
    return row ? parseJson<HostTurnRecord>(row.payload_json) : undefined;
  }

  turnForPermit(wakePermitRef: string): HostTurnRecord | undefined {
    const row = this.sqlite.prepare(`
      select payload_json from host_turn_records
       where wake_permit_ref = ?
       order by generation desc limit 1
    `).get(wakePermitRef) as TurnRow | undefined;
    return row ? parseJson<HostTurnRecord>(row.payload_json) : undefined;
  }

  latestTurn(sessionRef: string): HostTurnRecord | undefined {
    const row = this.sqlite.prepare(`
      select payload_json from host_turn_records
       where session_ref = ? order by generation desc limit 1
    `).get(sessionRef) as TurnRow | undefined;
    return row ? parseJson<HostTurnRecord>(row.payload_json) : undefined;
  }

  turns(sessionRef: string, limit = 50): HostTurnRecord[] {
    return (this.sqlite.prepare(`
      select payload_json from host_turn_records
       where session_ref = ? order by generation desc limit ?
    `).all(sessionRef, limit) as TurnRow[])
      .map((row) => parseJson<HostTurnRecord>(row.payload_json));
  }

  insertTurn(record: HostTurnRecord, digest: string): void {
    this.sqlite.prepare(`
      insert into host_turn_records (
        host_turn_ref, session_ref, generation, state, revision,
        conversation_binding_ref, conversation_binding_generation,
        generation_boundary_ref, provider_turn_ref, wake_permit_ref,
        payload_json, payload_digest_sha256,
        latest_evidence_at_ms, latest_evidence_expires_at_ms,
        created_at_ms, updated_at_ms, ended_at_ms
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.hostTurnRef,
      record.sessionRef,
      record.generation,
      record.state,
      record.revision,
      record.conversationBindingRef,
      record.conversationBindingGeneration,
      record.generationBoundaryRef,
      record.providerTurnRef ?? null,
      record.wakePermitRef ?? null,
      JSON.stringify(record),
      digest,
      Date.parse(record.latestEvidenceAt),
      Date.parse(record.latestEvidenceExpiresAt),
      Date.parse(record.createdAt),
      Date.parse(record.updatedAt),
      record.endedAt ? Date.parse(record.endedAt) : null,
    );
  }

  compareAndSwapTurn(
    record: HostTurnRecord,
    expectedRevision: number,
    digest: string,
  ): { saved: boolean; record?: HostTurnRecord; current?: HostTurnRecord } {
    const result = this.sqlite.prepare(`
      update host_turn_records
         set state = ?, revision = ?, generation_boundary_ref = ?,
             provider_turn_ref = ?, wake_permit_ref = ?,
             payload_json = ?, payload_digest_sha256 = ?,
             latest_evidence_at_ms = ?, latest_evidence_expires_at_ms = ?,
             updated_at_ms = ?, ended_at_ms = ?
       where host_turn_ref = ? and revision = ?
    `).run(
      record.state,
      record.revision,
      record.generationBoundaryRef,
      record.providerTurnRef ?? null,
      record.wakePermitRef ?? null,
      JSON.stringify(record),
      digest,
      Date.parse(record.latestEvidenceAt),
      Date.parse(record.latestEvidenceExpiresAt),
      Date.parse(record.updatedAt),
      record.endedAt ? Date.parse(record.endedAt) : null,
      record.hostTurnRef,
      expectedRevision,
    );
    if (result.changes === 1) return { saved: true, record };
    return { saved: false, current: this.turn(record.hostTurnRef) };
  }

  appendEvent(record: HostTurnEventRecord): void {
    this.sqlite.prepare(`
      insert into host_turn_events (
        event_ref, host_turn_ref, session_ref, sequence, kind, source, to_state,
        payload_json, payload_digest_sha256, observed_at_ms,
        evidence_expires_at_ms, recorded_at_ms
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.eventRef,
      record.hostTurnRef,
      record.sessionRef,
      record.sequence,
      record.kind,
      record.source,
      record.toState,
      JSON.stringify(record),
      record.evidenceDigestSha256,
      Date.parse(record.observedAt),
      Date.parse(record.evidenceExpiresAt),
      Date.parse(record.recordedAt),
    );
  }

  events(hostTurnRef: string, limit = 50): HostTurnEventRecord[] {
    return (this.sqlite.prepare(`
      select payload_json from host_turn_events
       where host_turn_ref = ? order by sequence desc limit ?
    `).all(hostTurnRef, limit) as EventRow[])
      .map((row) => parseJson<HostTurnEventRecord>(row.payload_json));
  }

  command(
    actorScopeRef: string,
    idempotencyKey: string,
  ): HostTurnLifecycleCommandRecord | undefined {
    return this.sqlite.prepare(`
      select actor_scope_ref as actorScopeRef,
             idempotency_key as idempotencyKey,
             command_kind as commandKind,
             payload_digest_sha256 as payloadDigestSha256,
             result_json as resultJson,
             created_at_ms as createdAtMs
        from host_turn_commands
       where actor_scope_ref = ? and idempotency_key = ?
    `).get(actorScopeRef, idempotencyKey) as HostTurnLifecycleCommandRecord | undefined;
  }

  insertCommand(record: HostTurnLifecycleCommandRecord): void {
    this.sqlite.prepare(`
      insert into host_turn_commands (
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

  cleanup(nowMs: number, retention: HostTurnLifecycleRetention): void {
    const terminalCutoff = nowMs - retention.terminalTurnRetentionMs;
    const eventCutoff = nowMs - retention.eventRetentionMs;
    const commandCutoff = nowMs - retention.commandRetentionMs;
    const transaction = this.sqlite.transaction(() => {
      this.sqlite.prepare(`
        delete from host_turn_events
         where recorded_at_ms < ?
           and host_turn_ref in (
             select host_turn_ref from host_turn_records
              where updated_at_ms < ?
                and state in ('awaiting_input', 'completed', 'failed', 'cancelled')
           )
      `).run(eventCutoff, terminalCutoff);
      this.sqlite.prepare(`
        delete from host_turn_records
         where updated_at_ms < ?
           and state in ('awaiting_input', 'completed', 'failed', 'cancelled')
           and host_turn_ref not in (
             select current_turn_ref from host_turn_sessions
              where current_turn_ref is not null
           )
      `).run(terminalCutoff);
      this.sqlite.prepare(
        "delete from host_turn_commands where created_at_ms < ?",
      ).run(commandCutoff);
    });
    transaction.immediate();
  }
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}
