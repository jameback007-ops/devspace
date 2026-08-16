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
export type LocalAgentSessionRow = typeof localAgentSessions.$inferSelect;
export type NewLocalAgentSessionRow = typeof localAgentSessions.$inferInsert;
