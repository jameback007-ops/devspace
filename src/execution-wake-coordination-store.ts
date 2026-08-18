import type { SqliteDatabase } from "./db/client.js";
import type {
  WakeAttempt,
  WakeLease,
  WakePendingWorkRecord,
  WakeTargetThrottle,
} from "./execution-wake-coordination-model.js";

export const EXECUTION_WAKE_COORDINATION_SCHEMA_VERSION = 1;

export interface ExecutionWakeCoordinationRetention {
  pendingWorkRetentionMs: number;
  attemptRetentionMs: number;
  commandRetentionMs: number;
  auditRetentionMs: number;
}

export interface WakeCoordinationCommandRecord {
  actorScopeRef: string;
  idempotencyKey: string;
  commandKind: string;
  payloadDigestSha256: string;
  resultJson: string;
  createdAtMs: number;
}

export interface WakeCoordinationAuditRecord {
  entityType: "pending_work" | "attempt" | "throttle" | "lease";
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

interface PendingWorkRow {
  pending_work_id: string;
  target_execution_scope_ref: string;
  mission_ref: string;
  generation: number;
  source_generation: number;
  semantic_digest_sha256: string;
  state: string;
  revision: number;
  is_current: number;
  payload_json: string;
  payload_digest_sha256: string;
  created_at_ms: number;
  updated_at_ms: number;
  expires_at_ms: number;
}

interface AttemptRow {
  attempt_id: string;
  wake_key: string;
  actor_scope_ref: string;
  target_execution_scope_ref: string;
  mission_ref: string;
  pending_work_id: string;
  pending_work_generation: number;
  attempt_sequence: number;
  state: string;
  revision: number;
  payload_json: string;
  payload_digest_sha256: string;
  created_at_ms: number;
  updated_at_ms: number;
  cooldown_until_ms: number;
  terminal_at_ms: number | null;
}

interface ThrottleRow {
  target_execution_scope_ref: string;
  mission_ref: string;
  revision: number;
  state: string;
  payload_json: string;
  payload_digest_sha256: string;
  cooldown_until_ms: number;
  hold_until_ms: number | null;
  updated_at_ms: number;
}

interface LeaseRow {
  resource_ref: string;
  lease_id: string;
  holder_scope_ref: string;
  target_execution_scope_ref: string;
  mission_ref: string;
  pending_work_id: string;
  acquired_at_ms: number;
  renewed_at_ms: number;
  expires_at_ms: number;
}

export function installExecutionWakeCoordinationSchema(
  sqlite: SqliteDatabase,
  installedAtMs = Date.now(),
): void {
  const transaction = sqlite.transaction(() => {
    sqlite.exec(`
      create table if not exists execution_wake_coordination_schema_versions (
        version integer primary key,
        installed_at_ms integer not null
      );

      create table if not exists execution_wake_pending_work (
        pending_work_id text primary key,
        target_execution_scope_ref text not null,
        mission_ref text not null,
        generation integer not null,
        source_generation integer not null,
        semantic_digest_sha256 text not null,
        state text not null,
        revision integer not null,
        is_current integer not null check(is_current in (0, 1)),
        payload_json text not null,
        payload_digest_sha256 text not null,
        created_at_ms integer not null,
        updated_at_ms integer not null,
        expires_at_ms integer not null,
        unique(target_execution_scope_ref, mission_ref, generation)
      );
      create unique index if not exists execution_wake_pending_work_current_idx
        on execution_wake_pending_work(target_execution_scope_ref, mission_ref)
        where is_current = 1;
      create index if not exists execution_wake_pending_work_state_idx
        on execution_wake_pending_work(state, expires_at_ms, updated_at_ms);
      create index if not exists execution_wake_pending_work_semantic_idx
        on execution_wake_pending_work(
          target_execution_scope_ref, mission_ref, semantic_digest_sha256
        );

      create table if not exists execution_wake_attempts (
        attempt_id text primary key,
        wake_key text not null unique,
        actor_scope_ref text not null,
        target_execution_scope_ref text not null,
        mission_ref text not null,
        pending_work_id text not null
          references execution_wake_pending_work(pending_work_id) on delete restrict,
        pending_work_generation integer not null,
        attempt_sequence integer not null,
        state text not null,
        revision integer not null,
        payload_json text not null,
        payload_digest_sha256 text not null,
        created_at_ms integer not null,
        updated_at_ms integer not null,
        cooldown_until_ms integer not null,
        terminal_at_ms integer,
        unique(pending_work_id, attempt_sequence)
      );
      create index if not exists execution_wake_attempts_target_idx
        on execution_wake_attempts(target_execution_scope_ref, mission_ref, updated_at_ms desc);
      create index if not exists execution_wake_attempts_pending_idx
        on execution_wake_attempts(pending_work_id, attempt_sequence desc);
      create index if not exists execution_wake_attempts_state_idx
        on execution_wake_attempts(state, updated_at_ms);

      create table if not exists execution_wake_target_throttles (
        target_execution_scope_ref text not null,
        mission_ref text not null,
        revision integer not null,
        state text not null,
        payload_json text not null,
        payload_digest_sha256 text not null,
        cooldown_until_ms integer not null,
        hold_until_ms integer,
        updated_at_ms integer not null,
        primary key(target_execution_scope_ref, mission_ref)
      );
      create index if not exists execution_wake_target_throttles_time_idx
        on execution_wake_target_throttles(state, cooldown_until_ms, hold_until_ms);

      create table if not exists execution_wake_leases (
        resource_ref text primary key,
        lease_id text not null unique,
        holder_scope_ref text not null,
        target_execution_scope_ref text not null,
        mission_ref text not null,
        pending_work_id text not null,
        acquired_at_ms integer not null,
        renewed_at_ms integer not null,
        expires_at_ms integer not null
      );
      create index if not exists execution_wake_leases_expiry_idx
        on execution_wake_leases(expires_at_ms);

      create table if not exists execution_wake_commands (
        actor_scope_ref text not null,
        idempotency_key text not null,
        command_kind text not null,
        payload_digest_sha256 text not null,
        result_json text not null,
        created_at_ms integer not null,
        primary key(actor_scope_ref, idempotency_key)
      );
      create index if not exists execution_wake_commands_time_idx
        on execution_wake_commands(created_at_ms);

      create table if not exists execution_wake_audit (
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
      create index if not exists execution_wake_audit_entity_idx
        on execution_wake_audit(entity_type, entity_id, sequence);
      create index if not exists execution_wake_audit_time_idx
        on execution_wake_audit(recorded_at_ms);
    `);
    sqlite.prepare(`
      insert into execution_wake_coordination_schema_versions(version, installed_at_ms)
      values (?, ?)
      on conflict(version) do nothing
    `).run(EXECUTION_WAKE_COORDINATION_SCHEMA_VERSION, installedAtMs);
  });
  transaction.immediate();
}

export function assertExecutionWakeCoordinationSchema(sqlite: SqliteDatabase): void {
  try {
    const row = sqlite.prepare(`
      select version from execution_wake_coordination_schema_versions
       where version = ?
    `).get(EXECUTION_WAKE_COORDINATION_SCHEMA_VERSION) as { version: number } | undefined;
    if (!row) throw new Error("missing schema version");
  } catch (error) {
    throw new Error(
      "Execution wake coordination persistence is not installed. Apply the wake coordination schema migration before enabling the scheduler.",
      { cause: error },
    );
  }
}

export class SqliteExecutionWakeCoordinationStore {
  constructor(readonly sqlite: SqliteDatabase) {}

  pendingWork(pendingWorkId: string): WakePendingWorkRecord | undefined {
    const row = this.sqlite.prepare(
      "select * from execution_wake_pending_work where pending_work_id = ?",
    ).get(pendingWorkId) as PendingWorkRow | undefined;
    return row ? parseJson<WakePendingWorkRecord>(row.payload_json) : undefined;
  }

  currentPendingWork(
    targetExecutionScopeRef: string,
    missionRef: string,
  ): WakePendingWorkRecord | undefined {
    const row = this.sqlite.prepare(`
      select * from execution_wake_pending_work
       where target_execution_scope_ref = ? and mission_ref = ? and is_current = 1
       limit 1
    `).get(targetExecutionScopeRef, missionRef) as PendingWorkRow | undefined;
    return row ? parseJson<WakePendingWorkRecord>(row.payload_json) : undefined;
  }

  pendingWorkRecords(
    targetExecutionScopeRef?: string,
    missionRef?: string,
  ): WakePendingWorkRecord[] {
    const clauses: string[] = [];
    const values: string[] = [];
    if (targetExecutionScopeRef) {
      clauses.push("target_execution_scope_ref = ?");
      values.push(targetExecutionScopeRef);
    }
    if (missionRef) {
      clauses.push("mission_ref = ?");
      values.push(missionRef);
    }
    const where = clauses.length > 0 ? `where ${clauses.join(" and ")}` : "";
    return (this.sqlite.prepare(`
      select * from execution_wake_pending_work ${where}
       order by generation desc, updated_at_ms desc, pending_work_id asc
    `).all(...values) as PendingWorkRow[])
      .map((row) => parseJson<WakePendingWorkRecord>(row.payload_json));
  }

  insertPendingWork(record: WakePendingWorkRecord, digest: string, current = true): void {
    this.sqlite.prepare(`
      insert into execution_wake_pending_work (
        pending_work_id, target_execution_scope_ref, mission_ref, generation,
        source_generation, semantic_digest_sha256, state, revision, is_current,
        payload_json, payload_digest_sha256, created_at_ms, updated_at_ms, expires_at_ms
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.pendingWorkId,
      record.targetExecutionScopeRef,
      record.missionRef,
      record.generation,
      record.sourceGeneration,
      record.semanticDigestSha256,
      record.state,
      record.revision,
      current ? 1 : 0,
      JSON.stringify(record),
      digest,
      Date.parse(record.createdAt),
      Date.parse(record.updatedAt),
      Date.parse(record.expiresAt),
    );
  }

  compareAndSwapPendingWork(
    record: WakePendingWorkRecord,
    expectedRevision: number,
    digest: string,
    isCurrent?: boolean,
  ): { saved: boolean; record?: WakePendingWorkRecord; current?: WakePendingWorkRecord } {
    const result = this.sqlite.prepare(`
      update execution_wake_pending_work
         set state = ?, revision = ?, payload_json = ?, payload_digest_sha256 = ?,
             updated_at_ms = ?, expires_at_ms = ?,
             is_current = case when ? is null then is_current else ? end
       where pending_work_id = ? and revision = ?
    `).run(
      record.state,
      record.revision,
      JSON.stringify(record),
      digest,
      Date.parse(record.updatedAt),
      Date.parse(record.expiresAt),
      isCurrent === undefined ? null : isCurrent ? 1 : 0,
      isCurrent === undefined ? null : isCurrent ? 1 : 0,
      record.pendingWorkId,
      expectedRevision,
    );
    if (result.changes === 1) return { saved: true, record };
    return { saved: false, current: this.pendingWork(record.pendingWorkId) };
  }

  setPendingWorkCurrent(pendingWorkId: string, current: boolean): boolean {
    const result = this.sqlite.prepare(`
      update execution_wake_pending_work set is_current = ? where pending_work_id = ?
    `).run(current ? 1 : 0, pendingWorkId);
    return result.changes === 1;
  }

  attempt(attemptId: string): WakeAttempt | undefined {
    const row = this.sqlite.prepare(
      "select * from execution_wake_attempts where attempt_id = ?",
    ).get(attemptId) as AttemptRow | undefined;
    return row ? parseJson<WakeAttempt>(row.payload_json) : undefined;
  }

  attemptByWakeKey(wakeKey: string): WakeAttempt | undefined {
    const row = this.sqlite.prepare(
      "select * from execution_wake_attempts where wake_key = ?",
    ).get(wakeKey) as AttemptRow | undefined;
    return row ? parseJson<WakeAttempt>(row.payload_json) : undefined;
  }

  latestAttemptForPendingWork(pendingWorkId: string): WakeAttempt | undefined {
    const row = this.sqlite.prepare(`
      select * from execution_wake_attempts
       where pending_work_id = ?
       order by attempt_sequence desc, updated_at_ms desc
       limit 1
    `).get(pendingWorkId) as AttemptRow | undefined;
    return row ? parseJson<WakeAttempt>(row.payload_json) : undefined;
  }

  attempts(
    targetExecutionScopeRef?: string,
    missionRef?: string,
  ): WakeAttempt[] {
    const clauses: string[] = [];
    const values: string[] = [];
    if (targetExecutionScopeRef) {
      clauses.push("target_execution_scope_ref = ?");
      values.push(targetExecutionScopeRef);
    }
    if (missionRef) {
      clauses.push("mission_ref = ?");
      values.push(missionRef);
    }
    const where = clauses.length > 0 ? `where ${clauses.join(" and ")}` : "";
    return (this.sqlite.prepare(`
      select * from execution_wake_attempts ${where}
       order by updated_at_ms desc, attempt_id asc
    `).all(...values) as AttemptRow[])
      .map((row) => parseJson<WakeAttempt>(row.payload_json));
  }

  insertAttempt(attempt: WakeAttempt, digest: string): void {
    this.sqlite.prepare(`
      insert into execution_wake_attempts (
        attempt_id, wake_key, actor_scope_ref, target_execution_scope_ref,
        mission_ref, pending_work_id, pending_work_generation, attempt_sequence,
        state, revision, payload_json, payload_digest_sha256,
        created_at_ms, updated_at_ms, cooldown_until_ms, terminal_at_ms
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      attempt.attemptId,
      attempt.wakeKey,
      attempt.actorScopeRef,
      attempt.targetExecutionScopeRef,
      attempt.missionRef,
      attempt.pendingWorkId,
      attempt.pendingWorkGeneration,
      attempt.attemptSequence,
      attempt.state,
      attempt.revision,
      JSON.stringify(attempt),
      digest,
      Date.parse(attempt.createdAt),
      Date.parse(attempt.updatedAt),
      Date.parse(attempt.cooldownUntil),
      attempt.terminalAt ? Date.parse(attempt.terminalAt) : null,
    );
  }

  compareAndSwapAttempt(
    attempt: WakeAttempt,
    expectedRevision: number,
    digest: string,
  ): { saved: boolean; attempt?: WakeAttempt; current?: WakeAttempt } {
    const result = this.sqlite.prepare(`
      update execution_wake_attempts
         set state = ?, revision = ?, payload_json = ?, payload_digest_sha256 = ?,
             updated_at_ms = ?, cooldown_until_ms = ?, terminal_at_ms = ?
       where attempt_id = ? and revision = ?
    `).run(
      attempt.state,
      attempt.revision,
      JSON.stringify(attempt),
      digest,
      Date.parse(attempt.updatedAt),
      Date.parse(attempt.cooldownUntil),
      attempt.terminalAt ? Date.parse(attempt.terminalAt) : null,
      attempt.attemptId,
      expectedRevision,
    );
    if (result.changes === 1) return { saved: true, attempt };
    return { saved: false, current: this.attempt(attempt.attemptId) };
  }

  throttle(
    targetExecutionScopeRef: string,
    missionRef: string,
  ): WakeTargetThrottle | undefined {
    const row = this.sqlite.prepare(`
      select * from execution_wake_target_throttles
       where target_execution_scope_ref = ? and mission_ref = ?
    `).get(targetExecutionScopeRef, missionRef) as ThrottleRow | undefined;
    return row ? parseJson<WakeTargetThrottle>(row.payload_json) : undefined;
  }

  putThrottle(throttle: WakeTargetThrottle, digest: string): void {
    this.sqlite.prepare(`
      insert into execution_wake_target_throttles (
        target_execution_scope_ref, mission_ref, revision, state,
        payload_json, payload_digest_sha256, cooldown_until_ms, hold_until_ms, updated_at_ms
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(target_execution_scope_ref, mission_ref) do update set
        revision = excluded.revision,
        state = excluded.state,
        payload_json = excluded.payload_json,
        payload_digest_sha256 = excluded.payload_digest_sha256,
        cooldown_until_ms = excluded.cooldown_until_ms,
        hold_until_ms = excluded.hold_until_ms,
        updated_at_ms = excluded.updated_at_ms
    `).run(
      throttle.targetExecutionScopeRef,
      throttle.missionRef,
      throttle.revision,
      throttle.state,
      JSON.stringify(throttle),
      digest,
      Date.parse(throttle.cooldownUntil),
      throttle.holdUntil ? Date.parse(throttle.holdUntil) : null,
      Date.parse(throttle.updatedAt),
    );
  }

  compareAndSwapThrottle(
    throttle: WakeTargetThrottle,
    expectedRevision: number,
    digest: string,
  ): { saved: boolean; throttle?: WakeTargetThrottle; current?: WakeTargetThrottle } {
    const result = this.sqlite.prepare(`
      update execution_wake_target_throttles
         set revision = ?, state = ?, payload_json = ?, payload_digest_sha256 = ?,
             cooldown_until_ms = ?, hold_until_ms = ?, updated_at_ms = ?
       where target_execution_scope_ref = ? and mission_ref = ? and revision = ?
    `).run(
      throttle.revision,
      throttle.state,
      JSON.stringify(throttle),
      digest,
      Date.parse(throttle.cooldownUntil),
      throttle.holdUntil ? Date.parse(throttle.holdUntil) : null,
      Date.parse(throttle.updatedAt),
      throttle.targetExecutionScopeRef,
      throttle.missionRef,
      expectedRevision,
    );
    if (result.changes === 1) return { saved: true, throttle };
    return {
      saved: false,
      current: this.throttle(throttle.targetExecutionScopeRef, throttle.missionRef),
    };
  }

  lease(resourceRef: string): WakeLease | undefined {
    const row = this.sqlite.prepare(
      "select * from execution_wake_leases where resource_ref = ?",
    ).get(resourceRef) as LeaseRow | undefined;
    return row ? leaseFromRow(row) : undefined;
  }

  claimLease(input: {
    resourceRef: string;
    leaseId: string;
    holderScopeRef: string;
    targetExecutionScopeRef: string;
    missionRef: string;
    pendingWorkId: string;
    nowMs: number;
    ttlMs: number;
  }): { acquired: boolean; lease?: WakeLease; current?: WakeLease } {
    const transaction = this.sqlite.transaction(() => {
      const currentRow = this.sqlite.prepare(
        "select * from execution_wake_leases where resource_ref = ?",
      ).get(input.resourceRef) as LeaseRow | undefined;
      if (currentRow && currentRow.expires_at_ms > input.nowMs) {
        return { acquired: false, current: leaseFromRow(currentRow) };
      }
      const expiresAtMs = input.nowMs + input.ttlMs;
      this.sqlite.prepare(`
        insert into execution_wake_leases (
          resource_ref, lease_id, holder_scope_ref, target_execution_scope_ref,
          mission_ref, pending_work_id, acquired_at_ms, renewed_at_ms, expires_at_ms
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
        on conflict(resource_ref) do update set
          lease_id = excluded.lease_id,
          holder_scope_ref = excluded.holder_scope_ref,
          target_execution_scope_ref = excluded.target_execution_scope_ref,
          mission_ref = excluded.mission_ref,
          pending_work_id = excluded.pending_work_id,
          acquired_at_ms = excluded.acquired_at_ms,
          renewed_at_ms = excluded.renewed_at_ms,
          expires_at_ms = excluded.expires_at_ms
      `).run(
        input.resourceRef,
        input.leaseId,
        input.holderScopeRef,
        input.targetExecutionScopeRef,
        input.missionRef,
        input.pendingWorkId,
        input.nowMs,
        input.nowMs,
        expiresAtMs,
      );
      return {
        acquired: true,
        lease: leaseFromRow({
          resource_ref: input.resourceRef,
          lease_id: input.leaseId,
          holder_scope_ref: input.holderScopeRef,
          target_execution_scope_ref: input.targetExecutionScopeRef,
          mission_ref: input.missionRef,
          pending_work_id: input.pendingWorkId,
          acquired_at_ms: input.nowMs,
          renewed_at_ms: input.nowMs,
          expires_at_ms: expiresAtMs,
        }),
      };
    });
    return transaction.immediate();
  }

  renewLease(input: {
    resourceRef: string;
    leaseId: string;
    holderScopeRef: string;
    pendingWorkId: string;
    nowMs: number;
    ttlMs: number;
  }): WakeLease | undefined {
    const expiresAtMs = input.nowMs + input.ttlMs;
    const result = this.sqlite.prepare(`
      update execution_wake_leases
         set renewed_at_ms = ?, expires_at_ms = ?
       where resource_ref = ? and lease_id = ? and holder_scope_ref = ?
         and pending_work_id = ? and expires_at_ms > ?
    `).run(
      input.nowMs,
      expiresAtMs,
      input.resourceRef,
      input.leaseId,
      input.holderScopeRef,
      input.pendingWorkId,
      input.nowMs,
    );
    if (result.changes !== 1) return undefined;
    return this.lease(input.resourceRef);
  }

  releaseLease(input: {
    resourceRef: string;
    leaseId: string;
    holderScopeRef: string;
  }): boolean {
    const result = this.sqlite.prepare(`
      delete from execution_wake_leases
       where resource_ref = ? and lease_id = ? and holder_scope_ref = ?
    `).run(input.resourceRef, input.leaseId, input.holderScopeRef);
    return result.changes === 1;
  }

  command(
    actorScopeRef: string,
    idempotencyKey: string,
  ): WakeCoordinationCommandRecord | undefined {
    return this.sqlite.prepare(`
      select actor_scope_ref as actorScopeRef,
             idempotency_key as idempotencyKey,
             command_kind as commandKind,
             payload_digest_sha256 as payloadDigestSha256,
             result_json as resultJson,
             created_at_ms as createdAtMs
        from execution_wake_commands
       where actor_scope_ref = ? and idempotency_key = ?
    `).get(actorScopeRef, idempotencyKey) as WakeCoordinationCommandRecord | undefined;
  }

  insertCommand(record: WakeCoordinationCommandRecord): void {
    this.sqlite.prepare(`
      insert into execution_wake_commands (
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

  compareAndSwapCommandResult(input: {
    actorScopeRef: string;
    idempotencyKey: string;
    commandKind: string;
    payloadDigestSha256: string;
    expectedResultJson: string;
    nextResultJson: string;
  }): boolean {
    const result = this.sqlite.prepare(`
      update execution_wake_commands
         set result_json = ?
       where actor_scope_ref = ? and idempotency_key = ? and command_kind = ?
         and payload_digest_sha256 = ? and result_json = ?
    `).run(
      input.nextResultJson,
      input.actorScopeRef,
      input.idempotencyKey,
      input.commandKind,
      input.payloadDigestSha256,
      input.expectedResultJson,
    );
    return result.changes === 1;
  }

  appendAudit(record: WakeCoordinationAuditRecord): void {
    this.sqlite.prepare(`
      insert into execution_wake_audit (
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

  cleanup(nowMs: number, retention: ExecutionWakeCoordinationRetention): void {
    const pendingCutoff = nowMs - retention.pendingWorkRetentionMs;
    const attemptCutoff = nowMs - retention.attemptRetentionMs;
    const commandCutoff = nowMs - retention.commandRetentionMs;
    const auditCutoff = nowMs - retention.auditRetentionMs;
    const transaction = this.sqlite.transaction(() => {
      this.sqlite.prepare(
        "delete from execution_wake_leases where expires_at_ms <= ?",
      ).run(nowMs);
      this.sqlite.prepare(`
        delete from execution_wake_attempts
         where updated_at_ms < ?
           and state in (
             'verified', 'failed_no_effect', 'reconciled_effect_absent',
             'reconciled_effect_verified', 'held', 'cancelled'
           )
      `).run(attemptCutoff);
      this.sqlite.prepare(`
        delete from execution_wake_pending_work
         where is_current = 0
           and updated_at_ms < ?
           and state in ('consumed', 'superseded', 'expired', 'held')
           and not exists (
             select 1 from execution_wake_attempts a
              where a.pending_work_id = execution_wake_pending_work.pending_work_id
                and a.state in ('prepared', 'dispatching', 'indeterminate')
           )
      `).run(pendingCutoff);
      this.sqlite.prepare(
        "delete from execution_wake_commands where created_at_ms < ?",
      ).run(commandCutoff);
      this.sqlite.prepare(
        "delete from execution_wake_audit where recorded_at_ms < ?",
      ).run(auditCutoff);
    });
    transaction.immediate();
  }
}

function leaseFromRow(row: LeaseRow): WakeLease {
  return {
    schemaVersion: 1,
    resourceRef: row.resource_ref,
    leaseId: row.lease_id,
    holderScopeRef: row.holder_scope_ref,
    targetExecutionScopeRef: row.target_execution_scope_ref,
    missionRef: row.mission_ref,
    pendingWorkId: row.pending_work_id,
    acquiredAt: new Date(row.acquired_at_ms).toISOString(),
    renewedAt: new Date(row.renewed_at_ms).toISOString(),
    expiresAt: new Date(row.expires_at_ms).toISOString(),
  };
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}
