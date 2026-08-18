export const CONVERSATION_TRANSPORT_SCHEMA_SQL = `
  create table if not exists conversation_transport_bindings (
    binding_ref text primary key,
    target_execution_scope_ref text not null,
    mission_ref text not null,
    target_alias text not null,
    target_kind text not null,
    bridge_target_ref_digest_sha256 text not null,
    binding_generation integer not null,
    evidence_digest_sha256 text not null,
    state text not null,
    payload_json text not null,
    created_at_ms integer not null,
    updated_at_ms integer not null,
    unique(target_execution_scope_ref, mission_ref, binding_generation)
  );
  create unique index if not exists conversation_transport_bindings_active_idx
    on conversation_transport_bindings(target_execution_scope_ref, mission_ref)
    where state = 'active';
  create index if not exists conversation_transport_bindings_alias_idx
    on conversation_transport_bindings(target_alias, state, updated_at_ms desc);

  create table if not exists conversation_transport_delivery_receipts (
    delivery_ref text primary key,
    permit_ref text not null,
    target_alias text not null,
    transport_id text not null,
    route_digest_sha256 text not null,
    message_id text not null,
    prompt_digest_sha256 text not null,
    state text not null,
    payload_json text not null,
    created_at_ms integer not null,
    updated_at_ms integer not null,
    unique(message_id),
    unique(permit_ref, transport_id)
  );
  create index if not exists conversation_transport_delivery_state_idx
    on conversation_transport_delivery_receipts(state, updated_at_ms desc);
`;
