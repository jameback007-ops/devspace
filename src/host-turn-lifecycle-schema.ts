export const HOST_TURN_LIFECYCLE_SCHEMA_VERSION = 1;

export const HOST_TURN_LIFECYCLE_SCHEMA_SQL = `
  create table if not exists host_turn_lifecycle_schema_versions (
    version integer primary key,
    installed_at_ms integer not null
  );

  create table if not exists host_turn_sessions (
    session_ref text primary key,
    logical_session_ref text not null,
    target_execution_scope_ref text not null,
    mission_ref text not null,
    current_turn_ref text,
    current_generation integer not null,
    revision integer not null,
    conversation_binding_ref text not null,
    conversation_binding_generation integer not null,
    payload_json text not null,
    payload_digest_sha256 text not null,
    created_at_ms integer not null,
    updated_at_ms integer not null,
    unique(target_execution_scope_ref, mission_ref)
  );
  create index if not exists host_turn_sessions_binding_idx
    on host_turn_sessions(
      conversation_binding_ref,
      conversation_binding_generation,
      updated_at_ms desc
    );

  create table if not exists host_turn_records (
    host_turn_ref text primary key,
    session_ref text not null
      references host_turn_sessions(session_ref) on delete restrict,
    generation integer not null,
    state text not null,
    revision integer not null,
    conversation_binding_ref text not null,
    conversation_binding_generation integer not null,
    generation_boundary_ref text not null,
    provider_turn_ref text,
    wake_permit_ref text,
    payload_json text not null,
    payload_digest_sha256 text not null,
    latest_evidence_at_ms integer not null,
    latest_evidence_expires_at_ms integer not null,
    created_at_ms integer not null,
    updated_at_ms integer not null,
    ended_at_ms integer,
    unique(session_ref, generation)
  );
  create index if not exists host_turn_records_session_idx
    on host_turn_records(session_ref, generation desc, updated_at_ms desc);
  create index if not exists host_turn_records_state_idx
    on host_turn_records(state, latest_evidence_expires_at_ms, updated_at_ms desc);
  create index if not exists host_turn_records_permit_idx
    on host_turn_records(wake_permit_ref)
    where wake_permit_ref is not null;

  create table if not exists host_turn_events (
    event_ref text primary key,
    host_turn_ref text not null
      references host_turn_records(host_turn_ref) on delete cascade,
    session_ref text not null
      references host_turn_sessions(session_ref) on delete cascade,
    sequence integer not null,
    kind text not null,
    source text not null,
    to_state text not null,
    payload_json text not null,
    payload_digest_sha256 text not null,
    observed_at_ms integer not null,
    evidence_expires_at_ms integer not null,
    recorded_at_ms integer not null,
    unique(host_turn_ref, sequence)
  );
  create index if not exists host_turn_events_turn_idx
    on host_turn_events(host_turn_ref, sequence desc);
  create index if not exists host_turn_events_session_idx
    on host_turn_events(session_ref, recorded_at_ms desc);

  create table if not exists host_turn_commands (
    actor_scope_ref text not null,
    idempotency_key text not null,
    command_kind text not null,
    payload_digest_sha256 text not null,
    result_json text not null,
    created_at_ms integer not null,
    primary key(actor_scope_ref, idempotency_key)
  );
  create index if not exists host_turn_commands_time_idx
    on host_turn_commands(created_at_ms);
`;
