import type Database from "better-sqlite3";

interface Migration {
  version: number;
  name: string;
  up(sqlite: Database.Database): void;
}

const migrations: Migration[] = [
  {
    version: 1,
    name: "workspace-state",
    up: migrateWorkspaceState,
  },
  {
    version: 2,
    name: "oauth-state",
    up: migrateOAuthState,
  },
  {
    version: 3,
    name: "local-agent-sessions",
    up: migrateLocalAgentSessions,
  },
  {
    version: 4,
    name: "workspace-conversation-bindings",
    up: migrateWorkspaceConversationBindings,
  },
  {
    version: 5,
    name: "execution-scope-observability",
    up: migrateExecutionScopeObservability,
  },
  {
    version: 6,
    name: "execution-scope-mailbox",
    up: migrateExecutionScopeMailbox,
  },
  {
    version: 7,
    name: "local-agent-turn-queue",
    up: migrateLocalAgentTurnQueue,
  },
  {
    version: 8,
    name: "turn-continuity-and-recovery-capsules",
    up: migrateTurnContinuityAndRecoveryCapsules,
  },
];

export function migrateDatabase(sqlite: Database.Database): void {
  const migrate = sqlite.transaction(() => {
    sqlite.exec(`
      create table if not exists devspace_schema_migrations (
        version integer primary key,
        name text not null,
        applied_at text not null
      );
    `);

    const applied = new Set(
      (
        sqlite.prepare("select version from devspace_schema_migrations").all() as Array<{
          version: number;
        }>
      ).map((row) => row.version),
    );
    const recordMigration = sqlite.prepare(
      "insert into devspace_schema_migrations (version, name, applied_at) values (?, ?, ?)",
    );

    for (const migration of migrations) {
      if (applied.has(migration.version)) continue;
      migration.up(sqlite);
      recordMigration.run(migration.version, migration.name, new Date().toISOString());
    }
  });

  migrate.immediate();
}

function migrateWorkspaceState(sqlite: Database.Database): void {
  sqlite.exec(`
    create table if not exists workspace_sessions (
      id text primary key,
      root text not null,
      status text not null default 'active',
      mode text not null default 'checkout',
      source_root text,
      base_ref text,
      base_sha text,
      managed text not null default 'false',
      created_at text not null,
      last_used_at text not null
    );

    create index if not exists workspace_sessions_root_idx
      on workspace_sessions(root, last_used_at desc);

    create index if not exists workspace_sessions_status_idx
      on workspace_sessions(status, last_used_at desc);

    create table if not exists loaded_agent_files (
      workspace_session_id text not null,
      path text not null,
      content_hash text not null,
      content text not null,
      loaded_at text not null,
      last_seen_at text not null,
      primary key (workspace_session_id, path),
      foreign key (workspace_session_id)
        references workspace_sessions(id)
        on delete cascade
    );

    create index if not exists loaded_agent_files_path_idx
      on loaded_agent_files(path);
  `);

  addColumnIfMissing(sqlite, "workspace_sessions", "mode", "text not null default 'checkout'");
  addColumnIfMissing(sqlite, "workspace_sessions", "source_root", "text");
  addColumnIfMissing(sqlite, "workspace_sessions", "base_ref", "text");
  addColumnIfMissing(sqlite, "workspace_sessions", "base_sha", "text");
  addColumnIfMissing(sqlite, "workspace_sessions", "managed", "text not null default 'false'");
}

function migrateOAuthState(sqlite: Database.Database): void {
  sqlite.exec(`
    create table if not exists oauth_clients (
      client_id text primary key,
      client_json text not null,
      issued_at integer not null
    );

    create index if not exists oauth_clients_issued_at_idx
      on oauth_clients(issued_at desc);

    create table if not exists oauth_access_tokens (
      token_hash text primary key,
      client_id text not null,
      scopes_json text not null,
      expires_at integer not null,
      resource text,
      foreign key (client_id) references oauth_clients(client_id) on delete cascade
    );

    create index if not exists oauth_access_tokens_client_id_idx
      on oauth_access_tokens(client_id);

    create index if not exists oauth_access_tokens_expires_at_idx
      on oauth_access_tokens(expires_at);

    create table if not exists oauth_refresh_tokens (
      token_hash text primary key,
      client_id text not null,
      scopes_json text not null,
      expires_at integer not null,
      resource text,
      foreign key (client_id) references oauth_clients(client_id) on delete cascade
    );

    create index if not exists oauth_refresh_tokens_client_id_idx
      on oauth_refresh_tokens(client_id);

    create index if not exists oauth_refresh_tokens_expires_at_idx
      on oauth_refresh_tokens(expires_at);
  `);
}

function migrateLocalAgentSessions(sqlite: Database.Database): void {
  sqlite.exec(`
    create table if not exists local_agent_sessions (
      id text primary key,
      workspace_id text,
      workspace_root text not null,
      profile_name text not null,
      provider text not null,
      model text,
      thinking text,
      provider_session_id text,
      status text not null,
      latest_response text,
      error text,
      created_at text not null,
      updated_at text not null
    );

    create index if not exists local_agent_sessions_workspace_id_idx
      on local_agent_sessions(workspace_id, updated_at desc);

    create index if not exists local_agent_sessions_workspace_root_idx
      on local_agent_sessions(workspace_root, updated_at desc);

    create index if not exists local_agent_sessions_provider_session_id_idx
      on local_agent_sessions(provider_session_id);
  `);

  addColumnIfMissing(sqlite, "local_agent_sessions", "thinking", "text");
}

function migrateWorkspaceConversationBindings(sqlite: Database.Database): void {
  sqlite.exec(`
    create table if not exists workspace_conversation_bindings (
      conversation_scope_id text not null,
      target_key text not null,
      workspace_session_id text not null,
      created_at text not null,
      last_used_at text not null,
      primary key (conversation_scope_id, target_key),
      foreign key (workspace_session_id)
        references workspace_sessions(id)
        on delete cascade
    );

    create index if not exists workspace_conversation_bindings_workspace_idx
      on workspace_conversation_bindings(workspace_session_id);
  `);
}

function migrateExecutionScopeObservability(sqlite: Database.Database): void {
  sqlite.exec(`
    create table if not exists execution_scopes (
      scope_ref text primary key,
      scope_digest_sha256 text not null unique,
      adapter text not null,
      created_at_ms integer not null,
      last_activity_at_ms integer not null,
      last_tool_name text,
      last_tool_outcome text,
      total_event_count integer not null default 0
    );

    create index if not exists execution_scopes_activity_idx
      on execution_scopes(last_activity_at_ms desc);

    create table if not exists execution_scope_events (
      id integer primary key autoincrement,
      scope_ref text not null,
      sequence integer not null,
      tool_name text not null,
      outcome text not null,
      started_at_ms integer not null,
      completed_at_ms integer,
      duration_ms integer,
      workspace_id text,
      process_session_id integer,
      detail_json text,
      error_kind text,
      error_summary text,
      error_digest_sha256 text,
      unique (scope_ref, sequence),
      foreign key (scope_ref)
        references execution_scopes(scope_ref)
        on delete cascade
    );

    create index if not exists execution_scope_events_scope_sequence_idx
      on execution_scope_events(scope_ref, sequence desc);

    create index if not exists execution_scope_events_started_idx
      on execution_scope_events(started_at_ms);

    create table if not exists execution_scope_workspaces (
      scope_ref text not null,
      workspace_session_id text not null,
      first_seen_at_ms integer not null,
      last_seen_at_ms integer not null,
      primary key (scope_ref, workspace_session_id),
      foreign key (scope_ref)
        references execution_scopes(scope_ref)
        on delete cascade,
      foreign key (workspace_session_id)
        references workspace_sessions(id)
        on delete cascade
    );

    create index if not exists execution_scope_workspaces_workspace_idx
      on execution_scope_workspaces(workspace_session_id);
  `);
}

function migrateExecutionScopeMailbox(sqlite: Database.Database): void {
  sqlite.exec(`
    create table if not exists execution_scope_messages (
      id text primary key,
      sender_scope_ref text not null,
      target_scope_ref text not null,
      idempotency_key text not null,
      payload_digest_sha256 text not null,
      kind text not null,
      priority text not null,
      body text not null,
      correlation_ref text,
      created_at_ms integer not null,
      expires_at_ms integer not null,
      observed_at_ms integer,
      acknowledged_at_ms integer,
      acted_at_ms integer,
      acknowledgement_note text,
      acted_note text,
      unique (sender_scope_ref, idempotency_key)
    );

    create index if not exists execution_scope_messages_target_pending_idx
      on execution_scope_messages(
        target_scope_ref,
        acted_at_ms,
        expires_at_ms,
        priority,
        created_at_ms
      );

    create index if not exists execution_scope_messages_sender_idx
      on execution_scope_messages(sender_scope_ref, created_at_ms desc);

    create table if not exists execution_scope_message_receipts (
      id integer primary key autoincrement,
      message_id text not null,
      target_scope_ref text not null,
      state text not null,
      recorded_at_ms integer not null,
      note text,
      unique (message_id, state),
      foreign key (message_id)
        references execution_scope_messages(id)
        on delete cascade
    );

    create index if not exists execution_scope_message_receipts_message_idx
      on execution_scope_message_receipts(message_id, recorded_at_ms);
  `);
}

function migrateLocalAgentTurnQueue(sqlite: Database.Database): void {
  sqlite.exec(`
    create table if not exists local_agent_turns (
      id text primary key,
      agent_id text not null,
      source_kind text not null,
      sender_scope_ref text,
      idempotency_namespace text not null,
      idempotency_key text not null,
      payload_digest_sha256 text not null,
      kind text not null,
      priority text not null,
      body text not null,
      correlation_ref text,
      model text,
      thinking text,
      status text not null,
      sequence integer not null,
      created_at_ms integer not null,
      claimed_at_ms integer,
      started_at_ms integer,
      completed_at_ms integer,
      worker_id text,
      provider_session_id_before text,
      provider_session_id_after text,
      final_response text,
      result_characters integer,
      result_digest_sha256 text,
      error_kind text,
      error_summary text,
      error_digest_sha256 text,
      cancel_requested_at_ms integer,
      cancel_note text,
      resolution text,
      resolution_note text,
      superseded_by_turn_id text,
      unique (agent_id, sequence),
      unique (agent_id, idempotency_namespace, idempotency_key),
      foreign key (agent_id)
        references local_agent_sessions(id)
        on delete cascade
    );

    create index if not exists local_agent_turns_queue_idx
      on local_agent_turns(agent_id, status, priority, sequence);

    create index if not exists local_agent_turns_sender_idx
      on local_agent_turns(sender_scope_ref, created_at_ms desc);

    create table if not exists local_agent_worker_leases (
      agent_id text primary key,
      worker_id text not null,
      acquired_at_ms integer not null,
      heartbeat_at_ms integer not null,
      expires_at_ms integer not null,
      foreign key (agent_id)
        references local_agent_sessions(id)
        on delete cascade
    );

    create index if not exists local_agent_worker_leases_expiry_idx
      on local_agent_worker_leases(expires_at_ms);
  `);
}

function migrateTurnContinuityAndRecoveryCapsules(
  sqlite: Database.Database,
): void {
  sqlite.exec(`
    create table if not exists execution_turn_horizons (
      scope_ref text primary key,
      epoch_id text not null unique,
      source text not null,
      turn_ref text,
      explicit_key_digest_sha256 text,
      started_at_ms integer not null,
      deadline_at_ms integer,
      last_activity_at_ms integer not null,
      last_mutation_at_ms integer,
      last_checkpoint_at_ms integer,
      last_checkpoint_id text,
      awareness_emitted_at_ms integer,
      landing_emitted_at_ms integer,
      stale_checkpoint_notice_emitted_at_ms integer
    );

    create index if not exists execution_turn_horizons_activity_idx
      on execution_turn_horizons(last_activity_at_ms desc);

    create table if not exists execution_recovery_capsules (
      id text primary key,
      scope_ref text not null,
      workspace_session_id text not null,
      workspace_root_digest_sha256 text not null,
      generation integer not null,
      idempotency_key_digest_sha256 text not null,
      intent text not null,
      semantic_json text not null,
      semantic_digest_sha256 text not null,
      fingerprint_json text not null,
      state_digest_sha256 text not null,
      recorded_at_ms integer not null,
      unique (workspace_root_digest_sha256, generation),
      unique (scope_ref, idempotency_key_digest_sha256)
    );

    create index if not exists execution_recovery_capsules_root_time_idx
      on execution_recovery_capsules(
        workspace_root_digest_sha256,
        recorded_at_ms desc
      );

    create index if not exists execution_recovery_capsules_scope_time_idx
      on execution_recovery_capsules(scope_ref, recorded_at_ms desc);
  `);
}

function addColumnIfMissing(
  sqlite: Database.Database,
  table: "workspace_sessions" | "local_agent_sessions",
  column: string,
  definition: string,
): void {
  const columns = sqlite.prepare(`pragma table_info(${table})`).all() as Array<{ name: string }>;
  if (columns.some((existingColumn) => existingColumn.name === column)) return;

  sqlite.exec(`alter table ${table} add column ${column} ${definition}`);
}
