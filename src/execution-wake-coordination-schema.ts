export const EXECUTION_WAKE_COORDINATION_SCHEMA_VERSION = 1;

export const EXECUTION_WAKE_COORDINATION_SCHEMA_SQL = `
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
`;
