import { and, desc, eq } from "drizzle-orm";
import { openDatabase, type DatabaseHandle } from "./db/client.js";
import {
  loadedAgentFiles,
  workspaceConversationBindings,
  workspaceSessions,
  type WorkspaceConversationBindingRow,
  type WorkspaceSessionRow,
} from "./db/schema.js";

export type WorkspaceMode = "checkout" | "worktree";

export interface WorkspaceSession {
  id: string;
  root: string;
  status: string;
  mode: WorkspaceMode;
  sourceRoot?: string;
  baseRef?: string;
  baseSha?: string;
  managed: boolean;
  createdAt: string;
  lastUsedAt: string;
}

export interface WorkspaceConversationBinding {
  conversationScopeId: string;
  targetKey: string;
  workspaceSessionId: string;
  createdAt: string;
  lastUsedAt: string;
}

export interface WorkspaceRecoveryObservation {
  recordedAtMs: number;
  semantic?: Record<string, unknown>;
}

export interface WorkspaceActivityObservation {
  workspaceId: string;
  scopeLastActivityAtMs?: number;
  bindingLastUsedAt?: string;
  recovery?: WorkspaceRecoveryObservation;
}

export interface WorkspaceStore {
  createSession(input: {
    id: string;
    root: string;
    mode?: WorkspaceMode;
    sourceRoot?: string;
    baseRef?: string;
    baseSha?: string;
    managed?: boolean;
  }): WorkspaceSession;
  getSession(id: string): WorkspaceSession | undefined;
  listSessions(): WorkspaceSession[];
  getSessionByRoot(root: string): WorkspaceSession | undefined;
  workspaceActivity(id: string): WorkspaceActivityObservation;
  touchSession(id: string): void;
  closeSession(id: string, closedAt?: string): WorkspaceSession | undefined;
  getConversationBinding(
    conversationScopeId: string,
    targetKey: string,
  ): WorkspaceConversationBinding | undefined;
  setConversationBinding(input: {
    conversationScopeId: string;
    targetKey: string;
    workspaceSessionId: string;
  }): WorkspaceConversationBinding;
  touchConversationBinding(conversationScopeId: string, targetKey: string): void;
  deleteConversationBinding(conversationScopeId: string, targetKey: string): void;
  close?(): void;
}

export class SqliteWorkspaceStore implements WorkspaceStore {
  private readonly database: DatabaseHandle;

  constructor(stateDir: string) {
    this.database = openDatabase(stateDir);
  }

  createSession(input: {
    id: string;
    root: string;
    mode?: WorkspaceMode;
    sourceRoot?: string;
    baseRef?: string;
    baseSha?: string;
    managed?: boolean;
  }): WorkspaceSession {
    const now = new Date().toISOString();
    const session: WorkspaceSession = {
      id: input.id,
      root: input.root,
      status: "active",
      mode: input.mode ?? "checkout",
      sourceRoot: input.sourceRoot,
      baseRef: input.baseRef,
      baseSha: input.baseSha,
      managed: input.managed ?? false,
      createdAt: now,
      lastUsedAt: now,
    };

    this.database.db
      .insert(workspaceSessions)
      .values({
        id: session.id,
        root: session.root,
        status: session.status,
        mode: session.mode,
        sourceRoot: session.sourceRoot ?? null,
        baseRef: session.baseRef ?? null,
        baseSha: session.baseSha ?? null,
        managed: String(session.managed),
        createdAt: session.createdAt,
        lastUsedAt: session.lastUsedAt,
      })
      .run();

    return session;
  }

  getSession(id: string): WorkspaceSession | undefined {
    const row = this.database.db
      .select()
      .from(workspaceSessions)
      .where(eq(workspaceSessions.id, id))
      .get();

    return row ? rowToWorkspaceSession(row) : undefined;
  }

  listSessions(): WorkspaceSession[] {
    return this.database.db
      .select()
      .from(workspaceSessions)
      .orderBy(desc(workspaceSessions.lastUsedAt))
      .all()
      .map(rowToWorkspaceSession);
  }

  getSessionByRoot(root: string): WorkspaceSession | undefined {
    const row = this.database.db
      .select()
      .from(workspaceSessions)
      .where(eq(workspaceSessions.root, root))
      .orderBy(desc(workspaceSessions.lastUsedAt))
      .get();
    return row ? rowToWorkspaceSession(row) : undefined;
  }

  workspaceActivity(id: string): WorkspaceActivityObservation {
    const scopeRow = this.database.sqlite
      .prepare(`
        select max(scope.last_activity_at_ms) as last_activity_at_ms
          from execution_scope_workspaces link
          join execution_scopes scope on scope.scope_ref = link.scope_ref
         where link.workspace_session_id = ?
      `)
      .get(id) as { last_activity_at_ms?: number | null } | undefined;
    const bindingRow = this.database.sqlite
      .prepare(`
        select max(last_used_at) as last_used_at
          from workspace_conversation_bindings
         where workspace_session_id = ?
      `)
      .get(id) as { last_used_at?: string | null } | undefined;
    const recoveryRow = this.database.sqlite
      .prepare(`
        select recorded_at_ms, semantic_json
          from execution_recovery_capsules
         where workspace_session_id = ?
         order by recorded_at_ms desc
         limit 1
      `)
      .get(id) as { recorded_at_ms: number; semantic_json: string } | undefined;

    let semantic: Record<string, unknown> | undefined;
    if (recoveryRow) {
      try {
        const decoded = JSON.parse(recoveryRow.semantic_json) as unknown;
        if (typeof decoded === "object" && decoded !== null && !Array.isArray(decoded)) {
          semantic = decoded as Record<string, unknown>;
        }
      } catch {
        semantic = undefined;
      }
    }

    return {
      workspaceId: id,
      scopeLastActivityAtMs:
        scopeRow?.last_activity_at_ms === null || scopeRow?.last_activity_at_ms === undefined
          ? undefined
          : Number(scopeRow.last_activity_at_ms),
      bindingLastUsedAt: bindingRow?.last_used_at ?? undefined,
      recovery: recoveryRow
        ? {
            recordedAtMs: Number(recoveryRow.recorded_at_ms),
            semantic,
          }
        : undefined,
    };
  }

  touchSession(id: string): void {
    this.database.db
      .update(workspaceSessions)
      .set({ lastUsedAt: new Date().toISOString() })
      .where(eq(workspaceSessions.id, id))
      .run();
  }

  closeSession(id: string, closedAt = new Date().toISOString()): WorkspaceSession | undefined {
    const existing = this.getSession(id);
    if (!existing) return undefined;
    const close = this.database.sqlite.transaction(() => {
      this.database.db
        .delete(workspaceConversationBindings)
        .where(eq(workspaceConversationBindings.workspaceSessionId, id))
        .run();
      this.database.db
        .delete(loadedAgentFiles)
        .where(eq(loadedAgentFiles.workspaceSessionId, id))
        .run();
      this.database.db
        .update(workspaceSessions)
        .set({ status: "closed", lastUsedAt: closedAt })
        .where(eq(workspaceSessions.id, id))
        .run();
    });
    close();
    return { ...existing, status: "closed", lastUsedAt: closedAt };
  }

  getConversationBinding(
    conversationScopeId: string,
    targetKey: string,
  ): WorkspaceConversationBinding | undefined {
    const row = this.database.db
      .select()
      .from(workspaceConversationBindings)
      .where(
        and(
          eq(workspaceConversationBindings.conversationScopeId, conversationScopeId),
          eq(workspaceConversationBindings.targetKey, targetKey),
        ),
      )
      .get();

    return row ? rowToWorkspaceConversationBinding(row) : undefined;
  }

  setConversationBinding(input: {
    conversationScopeId: string;
    targetKey: string;
    workspaceSessionId: string;
  }): WorkspaceConversationBinding {
    const now = new Date().toISOString();
    const row = this.database.db
      .insert(workspaceConversationBindings)
      .values({
        conversationScopeId: input.conversationScopeId,
        targetKey: input.targetKey,
        workspaceSessionId: input.workspaceSessionId,
        createdAt: now,
        lastUsedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          workspaceConversationBindings.conversationScopeId,
          workspaceConversationBindings.targetKey,
        ],
        set: {
          workspaceSessionId: input.workspaceSessionId,
          lastUsedAt: now,
        },
      })
      .returning()
      .get();

    if (!row) {
      throw new Error("Conversation workspace binding upsert returned no row.");
    }

    return rowToWorkspaceConversationBinding(row);
  }

  touchConversationBinding(conversationScopeId: string, targetKey: string): void {
    this.database.db
      .update(workspaceConversationBindings)
      .set({ lastUsedAt: new Date().toISOString() })
      .where(
        and(
          eq(workspaceConversationBindings.conversationScopeId, conversationScopeId),
          eq(workspaceConversationBindings.targetKey, targetKey),
        ),
      )
      .run();
  }

  deleteConversationBinding(conversationScopeId: string, targetKey: string): void {
    this.database.db
      .delete(workspaceConversationBindings)
      .where(
        and(
          eq(workspaceConversationBindings.conversationScopeId, conversationScopeId),
          eq(workspaceConversationBindings.targetKey, targetKey),
        ),
      )
      .run();
  }

  close(): void {
    this.database.close();
  }

}

export function createWorkspaceStore(stateDir: string): WorkspaceStore {
  return new SqliteWorkspaceStore(stateDir);
}

function rowToWorkspaceSession(row: WorkspaceSessionRow): WorkspaceSession {
  return {
    id: row.id,
    root: row.root,
    status: row.status,
    mode: row.mode === "worktree" ? "worktree" : "checkout",
    sourceRoot: row.sourceRoot ?? undefined,
    baseRef: row.baseRef ?? undefined,
    baseSha: row.baseSha ?? undefined,
    managed: row.managed === "true",
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
  };
}

function rowToWorkspaceConversationBinding(
  row: WorkspaceConversationBindingRow,
): WorkspaceConversationBinding {
  return {
    conversationScopeId: row.conversationScopeId,
    targetKey: row.targetKey,
    workspaceSessionId: row.workspaceSessionId,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
  };
}
