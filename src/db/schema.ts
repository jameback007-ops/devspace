import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const workspaceSessions = sqliteTable(
  "workspace_sessions",
  {
    id: text("id").primaryKey(),
    root: text("root").notNull(),
    status: text("status").notNull().default("active"),
    mode: text("mode").notNull().default("checkout"),
    sourceRoot: text("source_root"),
    baseRef: text("base_ref"),
    baseSha: text("base_sha"),
    managed: text("managed").notNull().default("false"),
    createdAt: text("created_at").notNull(),
    lastUsedAt: text("last_used_at").notNull(),
  },
  (table) => [
    index("workspace_sessions_root_idx").on(table.root, table.lastUsedAt),
    index("workspace_sessions_status_idx").on(table.status, table.lastUsedAt),
  ],
);

export const loadedAgentFiles = sqliteTable(
  "loaded_agent_files",
  {
    workspaceSessionId: text("workspace_session_id")
      .notNull()
      .references(() => workspaceSessions.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    contentHash: text("content_hash").notNull(),
    content: text("content").notNull(),
    loadedAt: text("loaded_at").notNull(),
    lastSeenAt: text("last_seen_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceSessionId, table.path] }),
    index("loaded_agent_files_path_idx").on(table.path),
  ],
);

export const workspaceConversationBindings = sqliteTable(
  "workspace_conversation_bindings",
  {
    conversationScopeId: text("conversation_scope_id").notNull(),
    targetKey: text("target_key").notNull(),
    workspaceSessionId: text("workspace_session_id")
      .notNull()
      .references(() => workspaceSessions.id, { onDelete: "cascade" }),
    createdAt: text("created_at").notNull(),
    lastUsedAt: text("last_used_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.conversationScopeId, table.targetKey] }),
    index("workspace_conversation_bindings_workspace_idx").on(table.workspaceSessionId),
  ],
);

export const executionScopes = sqliteTable(
  "execution_scopes",
  {
    scopeRef: text("scope_ref").primaryKey(),
    scopeDigestSha256: text("scope_digest_sha256").notNull().unique(),
    adapter: text("adapter").notNull(),
    createdAtMs: integer("created_at_ms").notNull(),
    lastActivityAtMs: integer("last_activity_at_ms").notNull(),
    lastToolName: text("last_tool_name"),
    lastToolOutcome: text("last_tool_outcome"),
    totalEventCount: integer("total_event_count").notNull().default(0),
  },
  (table) => [
    index("execution_scopes_activity_idx").on(table.lastActivityAtMs),
  ],
);

export const executionScopeEvents = sqliteTable(
  "execution_scope_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    scopeRef: text("scope_ref")
      .notNull()
      .references(() => executionScopes.scopeRef, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    toolName: text("tool_name").notNull(),
    outcome: text("outcome").notNull(),
    startedAtMs: integer("started_at_ms").notNull(),
    completedAtMs: integer("completed_at_ms"),
    durationMs: integer("duration_ms"),
    workspaceId: text("workspace_id"),
    processSessionId: integer("process_session_id"),
    detailJson: text("detail_json"),
    errorKind: text("error_kind"),
    errorSummary: text("error_summary"),
    errorDigestSha256: text("error_digest_sha256"),
  },
  (table) => [
    index("execution_scope_events_scope_sequence_idx").on(table.scopeRef, table.sequence),
    index("execution_scope_events_started_idx").on(table.startedAtMs),
  ],
);

export const executionScopeWorkspaces = sqliteTable(
  "execution_scope_workspaces",
  {
    scopeRef: text("scope_ref")
      .notNull()
      .references(() => executionScopes.scopeRef, { onDelete: "cascade" }),
    workspaceSessionId: text("workspace_session_id")
      .notNull()
      .references(() => workspaceSessions.id, { onDelete: "cascade" }),
    firstSeenAtMs: integer("first_seen_at_ms").notNull(),
    lastSeenAtMs: integer("last_seen_at_ms").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.scopeRef, table.workspaceSessionId] }),
    index("execution_scope_workspaces_workspace_idx").on(table.workspaceSessionId),
  ],
);

export const executionScopeMessages = sqliteTable(
  "execution_scope_messages",
  {
    id: text("id").primaryKey(),
    senderScopeRef: text("sender_scope_ref").notNull(),
    targetScopeRef: text("target_scope_ref").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    payloadDigestSha256: text("payload_digest_sha256").notNull(),
    kind: text("kind").notNull(),
    priority: text("priority").notNull(),
    body: text("body").notNull(),
    correlationRef: text("correlation_ref"),
    createdAtMs: integer("created_at_ms").notNull(),
    expiresAtMs: integer("expires_at_ms").notNull(),
    observedAtMs: integer("observed_at_ms"),
    acknowledgedAtMs: integer("acknowledged_at_ms"),
    actedAtMs: integer("acted_at_ms"),
    acknowledgementNote: text("acknowledgement_note"),
    actedNote: text("acted_note"),
  },
  (table) => [
    index("execution_scope_messages_target_pending_idx").on(
      table.targetScopeRef,
      table.actedAtMs,
      table.expiresAtMs,
      table.priority,
      table.createdAtMs,
    ),
    index("execution_scope_messages_sender_idx").on(
      table.senderScopeRef,
      table.createdAtMs,
    ),
    uniqueIndex("execution_scope_messages_idempotency_idx").on(
      table.senderScopeRef,
      table.idempotencyKey,
    ),
  ],
);

export const executionScopeMessageReceipts = sqliteTable(
  "execution_scope_message_receipts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    messageId: text("message_id")
      .notNull()
      .references(() => executionScopeMessages.id, { onDelete: "cascade" }),
    targetScopeRef: text("target_scope_ref").notNull(),
    state: text("state").notNull(),
    recordedAtMs: integer("recorded_at_ms").notNull(),
    note: text("note"),
  },
  (table) => [
    index("execution_scope_message_receipts_message_idx").on(
      table.messageId,
      table.recordedAtMs,
    ),
    uniqueIndex("execution_scope_message_receipts_state_idx").on(
      table.messageId,
      table.state,
    ),
  ],
);

export const executionTurnHorizons = sqliteTable(
  "execution_turn_horizons",
  {
    scopeRef: text("scope_ref").primaryKey(),
    epochId: text("epoch_id").notNull(),
    source: text("source").notNull(),
    turnRef: text("turn_ref"),
    explicitKeyDigestSha256: text("explicit_key_digest_sha256"),
    startedAtMs: integer("started_at_ms").notNull(),
    deadlineAtMs: integer("deadline_at_ms"),
    lastActivityAtMs: integer("last_activity_at_ms").notNull(),
    lastMutationAtMs: integer("last_mutation_at_ms"),
    lastCheckpointAtMs: integer("last_checkpoint_at_ms"),
    lastCheckpointId: text("last_checkpoint_id"),
    awarenessEmittedAtMs: integer("awareness_emitted_at_ms"),
    landingEmittedAtMs: integer("landing_emitted_at_ms"),
    staleCheckpointNoticeEmittedAtMs: integer("stale_checkpoint_notice_emitted_at_ms"),
  },
  (table) => [
    index("execution_turn_horizons_activity_idx").on(table.lastActivityAtMs),
    uniqueIndex("execution_turn_horizons_epoch_idx").on(table.epochId),
  ],
);

export const executionRecoveryCapsules = sqliteTable(
  "execution_recovery_capsules",
  {
    id: text("id").primaryKey(),
    scopeRef: text("scope_ref").notNull(),
    workspaceSessionId: text("workspace_session_id").notNull(),
    workspaceRootDigestSha256: text("workspace_root_digest_sha256").notNull(),
    generation: integer("generation").notNull(),
    idempotencyKeyDigestSha256: text("idempotency_key_digest_sha256").notNull(),
    intent: text("intent").notNull(),
    semanticJson: text("semantic_json").notNull(),
    semanticDigestSha256: text("semantic_digest_sha256").notNull(),
    fingerprintJson: text("fingerprint_json").notNull(),
    stateDigestSha256: text("state_digest_sha256").notNull(),
    recordedAtMs: integer("recorded_at_ms").notNull(),
  },
  (table) => [
    uniqueIndex("execution_recovery_capsules_generation_idx").on(
      table.workspaceRootDigestSha256,
      table.generation,
    ),
    uniqueIndex("execution_recovery_capsules_idempotency_idx").on(
      table.scopeRef,
      table.idempotencyKeyDigestSha256,
    ),
    index("execution_recovery_capsules_root_time_idx").on(
      table.workspaceRootDigestSha256,
      table.recordedAtMs,
    ),
    index("execution_recovery_capsules_scope_time_idx").on(
      table.scopeRef,
      table.recordedAtMs,
    ),
  ],
);

export const oauthClients = sqliteTable(
  "oauth_clients",
  {
    clientId: text("client_id").primaryKey(),
    clientJson: text("client_json").notNull(),
    issuedAt: integer("issued_at").notNull(),
  },
);

export const oauthAccessTokens = sqliteTable(
  "oauth_access_tokens",
  {
    tokenHash: text("token_hash").primaryKey(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: "cascade" }),
    scopesJson: text("scopes_json").notNull(),
    expiresAt: integer("expires_at").notNull(),
    resource: text("resource"),
  },
);

export const oauthRefreshTokens = sqliteTable(
  "oauth_refresh_tokens",
  {
    tokenHash: text("token_hash").primaryKey(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: "cascade" }),
    scopesJson: text("scopes_json").notNull(),
    expiresAt: integer("expires_at").notNull(),
    resource: text("resource"),
  },
);

export const localAgentSessions = sqliteTable(
  "local_agent_sessions",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id"),
    workspaceRoot: text("workspace_root").notNull(),
    profileName: text("profile_name").notNull(),
    provider: text("provider").notNull(),
    model: text("model"),
    thinking: text("thinking"),
    providerSessionId: text("provider_session_id"),
    status: text("status").notNull(),
    latestResponse: text("latest_response"),
    error: text("error"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("local_agent_sessions_workspace_id_idx").on(table.workspaceId, table.updatedAt),
    index("local_agent_sessions_workspace_root_idx").on(table.workspaceRoot, table.updatedAt),
    index("local_agent_sessions_provider_session_id_idx").on(table.providerSessionId),
  ],
);

export const localAgentTurns = sqliteTable(
  "local_agent_turns",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => localAgentSessions.id, { onDelete: "cascade" }),
    sourceKind: text("source_kind").notNull(),
    senderScopeRef: text("sender_scope_ref"),
    idempotencyNamespace: text("idempotency_namespace").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    payloadDigestSha256: text("payload_digest_sha256").notNull(),
    kind: text("kind").notNull(),
    priority: text("priority").notNull(),
    body: text("body").notNull(),
    correlationRef: text("correlation_ref"),
    model: text("model"),
    thinking: text("thinking"),
    status: text("status").notNull(),
    sequence: integer("sequence").notNull(),
    createdAtMs: integer("created_at_ms").notNull(),
    claimedAtMs: integer("claimed_at_ms"),
    startedAtMs: integer("started_at_ms"),
    completedAtMs: integer("completed_at_ms"),
    workerId: text("worker_id"),
    providerSessionIdBefore: text("provider_session_id_before"),
    providerSessionIdAfter: text("provider_session_id_after"),
    finalResponse: text("final_response"),
    resultCharacters: integer("result_characters"),
    resultDigestSha256: text("result_digest_sha256"),
    errorKind: text("error_kind"),
    errorSummary: text("error_summary"),
    errorDigestSha256: text("error_digest_sha256"),
    cancelRequestedAtMs: integer("cancel_requested_at_ms"),
    cancelNote: text("cancel_note"),
    resolution: text("resolution"),
    resolutionNote: text("resolution_note"),
    supersededByTurnId: text("superseded_by_turn_id"),
  },
  (table) => [
    uniqueIndex("local_agent_turns_sequence_idx").on(
      table.agentId,
      table.sequence,
    ),
    uniqueIndex("local_agent_turns_idempotency_idx").on(
      table.agentId,
      table.idempotencyNamespace,
      table.idempotencyKey,
    ),
    index("local_agent_turns_queue_idx").on(
      table.agentId,
      table.status,
      table.priority,
      table.sequence,
    ),
    index("local_agent_turns_sender_idx").on(
      table.senderScopeRef,
      table.createdAtMs,
    ),
  ],
);

export const localAgentWorkerLeases = sqliteTable(
  "local_agent_worker_leases",
  {
    agentId: text("agent_id")
      .primaryKey()
      .references(() => localAgentSessions.id, { onDelete: "cascade" }),
    workerId: text("worker_id").notNull(),
    acquiredAtMs: integer("acquired_at_ms").notNull(),
    heartbeatAtMs: integer("heartbeat_at_ms").notNull(),
    expiresAtMs: integer("expires_at_ms").notNull(),
  },
  (table) => [
    index("local_agent_worker_leases_expiry_idx").on(table.expiresAtMs),
  ],
);

export type WorkspaceSessionRow = typeof workspaceSessions.$inferSelect;
export type NewWorkspaceSessionRow = typeof workspaceSessions.$inferInsert;
export type LoadedAgentFileRow = typeof loadedAgentFiles.$inferSelect;
export type NewLoadedAgentFileRow = typeof loadedAgentFiles.$inferInsert;
export type WorkspaceConversationBindingRow = typeof workspaceConversationBindings.$inferSelect;
export type NewWorkspaceConversationBindingRow = typeof workspaceConversationBindings.$inferInsert;
export type ExecutionScopeRow = typeof executionScopes.$inferSelect;
export type NewExecutionScopeRow = typeof executionScopes.$inferInsert;
export type ExecutionScopeEventRow = typeof executionScopeEvents.$inferSelect;
export type NewExecutionScopeEventRow = typeof executionScopeEvents.$inferInsert;
export type ExecutionScopeWorkspaceRow = typeof executionScopeWorkspaces.$inferSelect;
export type NewExecutionScopeWorkspaceRow = typeof executionScopeWorkspaces.$inferInsert;
export type ExecutionScopeMessageRow = typeof executionScopeMessages.$inferSelect;
export type NewExecutionScopeMessageRow = typeof executionScopeMessages.$inferInsert;
export type ExecutionScopeMessageReceiptRow = typeof executionScopeMessageReceipts.$inferSelect;
export type NewExecutionScopeMessageReceiptRow = typeof executionScopeMessageReceipts.$inferInsert;
export type ExecutionTurnHorizonRow = typeof executionTurnHorizons.$inferSelect;
export type NewExecutionTurnHorizonRow = typeof executionTurnHorizons.$inferInsert;
export type ExecutionRecoveryCapsuleRow = typeof executionRecoveryCapsules.$inferSelect;
export type NewExecutionRecoveryCapsuleRow = typeof executionRecoveryCapsules.$inferInsert;
export type LocalAgentSessionRow = typeof localAgentSessions.$inferSelect;
export type NewLocalAgentSessionRow = typeof localAgentSessions.$inferInsert;
export type LocalAgentTurnRow = typeof localAgentTurns.$inferSelect;
export type NewLocalAgentTurnRow = typeof localAgentTurns.$inferInsert;
export type LocalAgentWorkerLeaseRow = typeof localAgentWorkerLeases.$inferSelect;
export type NewLocalAgentWorkerLeaseRow = typeof localAgentWorkerLeases.$inferInsert;
