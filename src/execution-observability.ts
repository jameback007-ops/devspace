import { createHash } from "node:crypto";
import { openDatabase, type DatabaseHandle } from "./db/client.js";
import type {
  ProcessSessionInspection,
  ProcessSessionManager,
} from "./process-sessions.js";
import type { ExecutionScopeIdentity } from "./request-meta.js";

export interface ExecutionObservabilityConfig {
  enabled: boolean;
  retentionMs: number;
  maxEventsPerScope: number;
  idleAfterMs: number;
}

export type ExecutionToolOutcome =
  | "running"
  | "succeeded"
  | "error"
  | "blocked"
  | "interrupted";

export interface ExecutionObservationHandle {
  scopeRef: string;
  sequence: number;
  startedAtMs: number;
  toolName: string;
}

export interface ExecutionScopeManagerOptions {
  now?: () => number;
}

interface StoredExecutionScope {
  scopeRef: string;
  scopeDigestSha256: string;
  adapter: string;
  createdAtMs: number;
  lastActivityAtMs: number;
  lastToolName?: string;
  lastToolOutcome?: ExecutionToolOutcome;
  totalEventCount: number;
  runningToolCount: number;
  workspaceCount: number;
}

interface StoredExecutionEvent {
  sequence: number;
  toolName: string;
  outcome: ExecutionToolOutcome;
  startedAtMs: number;
  completedAtMs?: number;
  durationMs?: number;
  workspaceId?: string;
  processSessionId?: number;
  detail?: Record<string, unknown>;
  errorKind?: string;
  errorSummary?: string;
  errorDigestSha256?: string;
}

interface StoredWorkspace {
  workspaceId: string;
  root: string;
  status: string;
  mode: "checkout" | "worktree";
  sourceRoot?: string;
  baseRef?: string;
  baseSha?: string;
  managed: boolean;
  createdAt: string;
  lastUsedAt: string;
  firstSeenAt: string;
  lastSeenAt: string;
}

interface FinishObservationInput {
  response?: unknown;
  error?: unknown;
}

const NON_AUDITED_TOOL_NAMES = new Set([
  "execution_scope_list",
  "execution_scope_status",
  "execution_scope_audit",
]);
const MAX_DETAIL_JSON_BYTES = 16_000;
const MAX_SAFE_TEXT = 4_096;
const MAX_SAFE_FILE_RECEIPTS = 50;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, maximum = MAX_SAFE_TEXT): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  return value.length <= maximum ? value : `${value.slice(0, maximum - 3)}...`;
}

function finiteInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && Number.isFinite(value)
    ? value
    : undefined;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function iso(ms: number | undefined): string | undefined {
  return ms === undefined ? undefined : new Date(ms).toISOString();
}

function parseJsonRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function boundedDetailJson(detail: Record<string, unknown>): string | undefined {
  const serialized = JSON.stringify(detail);
  if (serialized === "{}") return undefined;
  if (Buffer.byteLength(serialized, "utf8") <= MAX_DETAIL_JSON_BYTES) return serialized;
  return JSON.stringify({
    detailTruncated: true,
    originalByteCount: Buffer.byteLength(serialized, "utf8"),
    digestSha256: sha256(serialized),
  });
}

function addString(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  key: string,
): void {
  const value = boundedString(source[key]);
  if (value !== undefined) target[key] = value;
}

function addInteger(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  key: string,
): void {
  const value = finiteInteger(source[key]);
  if (value !== undefined) target[key] = value;
}

function addBoolean(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  key: string,
): void {
  if (typeof source[key] === "boolean") target[key] = source[key];
}

function addSensitiveStringDigest(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  key: string,
): void {
  const value = source[key];
  if (typeof value !== "string") return;
  target[`${key}Length`] = value.length;
  target[`${key}DigestSha256`] = sha256(value);
}

function patchPaths(patch: string): string[] {
  const paths: string[] = [];
  for (const line of patch.split(/\r?\n/)) {
    const match = line.match(/^\*\*\* (?:Add|Update|Delete|Move to) File: (.+)$/);
    if (!match?.[1]) continue;
    const path = boundedString(match[1], 1_000);
    if (path && !paths.includes(path)) paths.push(path);
    if (paths.length >= 30) break;
  }
  return paths;
}

/**
 * Keep audit details operationally useful while excluding prompts, full shell
 * commands, patches, tool output, native file handles, and arbitrary payloads.
 */
export function summarizeExecutionToolInput(
  toolName: string,
  input: unknown,
): Record<string, unknown> {
  if (!isRecord(input)) return {};
  const detail: Record<string, unknown> = {};

  for (const key of [
    "workspaceId",
    "path",
    "workingDirectory",
    "mode",
    "baseRef",
    "scopeRef",
    "targetScopeRef",
    "messageId",
    "agentId",
    "turnId",
    "kind",
    "priority",
    "state",
    "resolution",
    "correlationRef",
  ]) {
    addString(detail, input, key);
  }
  for (const key of [
    "sessionId",
    "columns",
    "rows",
    "yieldTimeMs",
    "maxOutputTokens",
    "lineOffset",
    "lineLimit",
    "depth",
    "maxEntries",
    "limit",
  ]) {
    addInteger(detail, input, key);
  }
  for (const key of ["tty", "includeHidden", "fixedStrings", "caseSensitive"]) {
    addBoolean(detail, input, key);
  }

  for (const key of [
    "cmd",
    "command",
    "query",
    "pattern",
    "prompt",
    "text",
    "oldText",
    "newText",
    "summary",
    "nextAction",
    "body",
    "note",
    "idempotencyKey",
    "finalResponse",
    "providerSessionIdAfter",
  ]) {
    addSensitiveStringDigest(detail, input, key);
  }

  if (typeof input.patch === "string") {
    addSensitiveStringDigest(detail, input, "patch");
    const paths = patchPaths(input.patch);
    if (paths.length > 0) detail.patchPaths = paths;
  }

  if (typeof input.chars === "string") {
    detail.charactersWritten = input.chars.length;
    detail.pollOnly = input.chars.length === 0;
    detail.interruptRequested = input.chars.includes("\u0003");
  }

  if (toolName === "download_artifact") {
    // The native file value may contain signed URLs or host-private handles.
    delete detail.file;
  }

  return detail;
}

function summarizeExecutionToolResponse(response: unknown): Record<string, unknown> {
  if (!isRecord(response)) return {};
  const structured = isRecord(response.structuredContent)
    ? response.structuredContent
    : undefined;
  if (!structured) return {};

  const detail: Record<string, unknown> = {};
  for (const key of [
    "workspaceId",
    "mode",
    "sourceRoot",
    "root",
    "signal",
    "status",
    "wakeReason",
    "outputDeltaDigestSha256",
    "outputDigestSha256",
  ]) {
    addString(detail, structured, key);
  }
  for (const key of [
    "sessionId",
    "exitCode",
    "wallTimeMs",
    "outputDeltaBytes",
    "outputTotalBytes",
    "outputEventCount",
    "outputSequenceStart",
    "outputSequenceEnd",
    "additions",
    "removals",
  ]) {
    addInteger(detail, structured, key);
  }
  for (const key of ["running", "outputTruncated", "outputComplete"]) {
    addBoolean(detail, structured, key);
  }
  if (Array.isArray(structured.files)) {
    detail.fileReceiptCount = structured.files.length;
    const files = structured.files
      .slice(0, MAX_SAFE_FILE_RECEIPTS)
      .flatMap((value) => {
        if (!isRecord(value)) return [];
        const path = boundedString(value.path, 1_000);
        const previousPath = boundedString(value.previousPath, 1_000);
        const operation = boundedString(value.operation, 32);
        if (!path || !operation) return [];
        return [{
          path,
          ...(previousPath ? { previousPath } : {}),
          operation,
        }];
      });
    if (files.length > 0) detail.files = files;
    if (structured.files.length > MAX_SAFE_FILE_RECEIPTS) {
      detail.fileReceiptsTruncated = true;
    }
  }
  return detail;
}

function errorObservation(error: unknown): {
  errorKind: string;
  errorSummary: string;
  errorDigestSha256: string;
} {
  const baseKind = error instanceof Error ? error.name || "Error" : typeof error;
  const code = isRecord(error) && typeof error.code === "string"
    ? error.code.slice(0, 64).replace(/[^A-Za-z0-9_.-]/g, "_")
    : undefined;
  const kind = code ? `${baseKind}:${code}` : baseKind;
  const raw = error instanceof Error ? error.message : String(error);
  return {
    errorKind: kind,
    errorSummary: code
      ? `Tool failed with ${code}. Inspect the originating scope for details.`
      : `Tool failed with ${baseKind}. Inspect the originating scope for details.`,
    errorDigestSha256: sha256(raw),
  };
}

function responseIsError(response: unknown): boolean {
  return isRecord(response) && response.isError === true;
}

function encodeCursor(sequence: number): string {
  return Buffer.from(String(sequence), "utf8").toString("base64url");
}

function decodeCursor(cursor: string | undefined): number | undefined {
  if (!cursor) return undefined;
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    throw new Error("Invalid execution-scope audit cursor.");
  }
  const sequence = Number(decoded);
  if (!Number.isInteger(sequence) || sequence < 1) {
    throw new Error("Invalid execution-scope audit cursor.");
  }
  return sequence;
}

export class ExecutionScopeManager {
  private readonly database: DatabaseHandle;
  private readonly now: () => number;
  private nextGlobalPruneAtMs = 0;

  constructor(
    readonly config: ExecutionObservabilityConfig,
    stateDir: string,
    private readonly processSessions: ProcessSessionManager,
    options: ExecutionScopeManagerOptions = {},
  ) {
    this.database = openDatabase(stateDir);
    this.now = options.now ?? Date.now;
    if (!config.enabled) return;
    this.recoverInterruptedObservations();
    this.pruneExpired();
    this.scheduleNextGlobalPrune(this.now());
  }

  beginTool(
    identity: ExecutionScopeIdentity | undefined,
    toolName: string,
    input: unknown,
  ): ExecutionObservationHandle | undefined {
    if (!this.config.enabled || !identity || NON_AUDITED_TOOL_NAMES.has(toolName)) {
      return undefined;
    }

    const startedAtMs = this.now();
    this.maybePruneExpired(startedAtMs);
    const detail = summarizeExecutionToolInput(toolName, input);
    const workspaceId = boundedString(detail.workspaceId);
    const processSessionId = finiteInteger(detail.sessionId);
    const detailJson = boundedDetailJson(detail);

    const transaction = this.database.sqlite.transaction(() => {
      this.upsertScope(identity, startedAtMs, toolName, "running");
      const row = this.database.sqlite
        .prepare(
          "select coalesce(max(sequence), 0) + 1 as sequence from execution_scope_events where scope_ref = ?",
        )
        .get(identity.scopeRef) as { sequence: number };

      this.database.sqlite
        .prepare(`
          insert into execution_scope_events (
            scope_ref, sequence, tool_name, outcome, started_at_ms,
            workspace_id, process_session_id, detail_json
          ) values (?, ?, ?, 'running', ?, ?, ?, ?)
        `)
        .run(
          identity.scopeRef,
          row.sequence,
          toolName,
          startedAtMs,
          workspaceId ?? null,
          processSessionId ?? null,
          detailJson ?? null,
        );
      this.database.sqlite
        .prepare(
          "update execution_scopes set total_event_count = total_event_count + 1 where scope_ref = ?",
        )
        .run(identity.scopeRef);
      if (workspaceId) this.linkWorkspace(identity.scopeRef, workspaceId, startedAtMs);
      this.pruneScope(identity.scopeRef, startedAtMs);
      return row.sequence;
    });

    return {
      scopeRef: identity.scopeRef,
      sequence: transaction.immediate(),
      startedAtMs,
      toolName,
    };
  }

  finishTool(
    handle: ExecutionObservationHandle | undefined,
    outcome: Exclude<ExecutionToolOutcome, "running">,
    input: FinishObservationInput = {},
  ): void {
    if (!handle || !this.config.enabled) return;
    const completedAtMs = this.now();
    const responseDetail = summarizeExecutionToolResponse(input.response);
    const workspaceId = boundedString(responseDetail.workspaceId);
    const processSessionId = finiteInteger(responseDetail.sessionId);
    const detailJson = boundedDetailJson(responseDetail);
    const observedError = input.error === undefined ? undefined : errorObservation(input.error);

    const transaction = this.database.sqlite.transaction(() => {
      this.database.sqlite
        .prepare(`
          update execution_scope_events
             set outcome = ?, completed_at_ms = ?, duration_ms = ?,
                 workspace_id = coalesce(?, workspace_id),
                 process_session_id = coalesce(?, process_session_id),
                 detail_json = case
                   when ? is null then detail_json
                   when detail_json is null then ?
                   else json_patch(detail_json, ?)
                 end,
                 error_kind = ?, error_summary = ?, error_digest_sha256 = ?
           where scope_ref = ? and sequence = ?
        `)
        .run(
          outcome,
          completedAtMs,
          Math.max(0, completedAtMs - handle.startedAtMs),
          workspaceId ?? null,
          processSessionId ?? null,
          detailJson ?? null,
          detailJson ?? null,
          detailJson ?? null,
          observedError?.errorKind ?? (outcome === "error" ? "tool_error_response" : null),
          observedError?.errorSummary ?? null,
          observedError?.errorDigestSha256 ?? null,
          handle.scopeRef,
          handle.sequence,
        );
      this.database.sqlite
        .prepare(`
          update execution_scopes
             set last_activity_at_ms = ?, last_tool_name = ?, last_tool_outcome = ?
           where scope_ref = ?
        `)
        .run(completedAtMs, handle.toolName, outcome, handle.scopeRef);
      if (workspaceId) this.linkWorkspace(handle.scopeRef, workspaceId, completedAtMs);
      this.pruneScope(handle.scopeRef, completedAtMs);
    });
    transaction.immediate();
  }

  outcomeForResponse(response: unknown): "succeeded" | "error" {
    return responseIsError(response) ? "error" : "succeeded";
  }

  list(
    currentIdentity: ExecutionScopeIdentity | undefined,
    limit = 20,
  ): Record<string, unknown> {
    if (!this.config.enabled) return this.disabledResult();
    this.maybePruneExpired(this.now());
    const boundedLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    const storedScopes = this.listStoredScopes(boundedLimit);
    const scopes = storedScopes.map((scope) =>
      this.scopeSummary(scope, currentIdentity?.scopeRef)
    );
    if (
      currentIdentity
      && !storedScopes.some((scope) => scope.scopeRef === currentIdentity.scopeRef)
    ) {
      scopes.unshift(this.unmaterializedCurrentScopeSummary(currentIdentity));
      if (scopes.length > boundedLimit) scopes.length = boundedLimit;
    }
    return {
      schemaVersion: 1,
      enabled: true,
      order: "most_recent_first",
      currentScopeRef: currentIdentity?.scopeRef,
      scopes,
      policy: this.policy(),
    };
  }

  status(
    scopeRef: string | undefined,
    currentIdentity: ExecutionScopeIdentity | undefined,
  ): Record<string, unknown> {
    if (!this.config.enabled) return this.disabledResult();
    this.maybePruneExpired(this.now());
    const targetRef = scopeRef ?? currentIdentity?.scopeRef;
    if (!targetRef) {
      throw new Error("scopeRef is required when the current host supplies no stable execution scope.");
    }
    const scope = this.getStoredScope(targetRef);
    if (!scope) {
      if (currentIdentity?.scopeRef !== targetRef) {
        throw new Error(`Unknown execution scope: ${targetRef}`);
      }
      return {
        schemaVersion: 1,
        enabled: true,
        scope: this.unmaterializedCurrentScopeSummary(currentIdentity),
        workspaces: [],
        processes: [],
        otherOrUnattributedRunningProcessCount: 0,
        policy: this.policy(),
      };
    }
    const workspaces = this.listStoredWorkspaces(targetRef);
    const processProjection = this.processProjection(targetRef, workspaces);

    return {
      schemaVersion: 1,
      enabled: true,
      scope: this.scopeSummary(
        scope,
        currentIdentity?.scopeRef,
        workspaces,
        processProjection.processes,
        processProjection.otherOrUnattributedRunningProcessCount,
      ),
      workspaces,
      processes: processProjection.processes,
      otherOrUnattributedRunningProcessCount:
        processProjection.otherOrUnattributedRunningProcessCount,
      policy: this.policy(),
    };
  }

  audit(
    scopeRef: string | undefined,
    currentIdentity: ExecutionScopeIdentity | undefined,
    options: { limit?: number; cursor?: string } = {},
  ): Record<string, unknown> {
    if (!this.config.enabled) return this.disabledResult();
    this.maybePruneExpired(this.now());
    const targetRef = scopeRef ?? currentIdentity?.scopeRef;
    if (!targetRef) {
      throw new Error("scopeRef is required when the current host supplies no stable execution scope.");
    }
    if (!this.getStoredScope(targetRef)) {
      if (currentIdentity?.scopeRef !== targetRef) {
        throw new Error(`Unknown execution scope: ${targetRef}`);
      }
      return {
        schemaVersion: 1,
        enabled: true,
        scopeRef: targetRef,
        currentScopeMaterialized: false,
        order: "newest_first",
        events: [],
        nextCursor: undefined,
        policy: this.policy(),
      };
    }
    const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 30)));
    const beforeSequence = decodeCursor(options.cursor);
    const rows = this.listStoredEvents(targetRef, limit + 1, beforeSequence);
    const hasMore = rows.length > limit;
    const events = rows.slice(0, limit).map((event) => ({
      sequence: event.sequence,
      tool: event.toolName,
      outcome: event.outcome,
      startedAt: iso(event.startedAtMs),
      completedAt: iso(event.completedAtMs),
      durationMs: event.durationMs,
      workspaceId: event.workspaceId,
      processSessionId: event.processSessionId,
      detail: event.detail,
      errorKind: event.errorKind,
      errorSummary: event.errorSummary,
      errorDigestSha256: event.errorDigestSha256,
    }));
    const lastSequence = events.at(-1)?.sequence;
    const summary = this.auditSummary(targetRef);

    return {
      schemaVersion: 1,
      enabled: true,
      scopeRef: targetRef,
      order: "newest_first",
      events,
      summary,
      nextCursor: hasMore && lastSequence ? encodeCursor(lastSequence) : undefined,
      policy: this.policy(),
    };
  }

  close(): void {
    this.database.close();
  }

  private upsertScope(
    identity: ExecutionScopeIdentity,
    nowMs: number,
    toolName: string,
    outcome: ExecutionToolOutcome,
  ): void {
    const existing = this.database.sqlite
      .prepare("select scope_digest_sha256 from execution_scopes where scope_ref = ?")
      .get(identity.scopeRef) as { scope_digest_sha256: string } | undefined;
    if (existing && existing.scope_digest_sha256 !== identity.scopeDigestSha256) {
      throw new Error(`Execution scope reference collision: ${identity.scopeRef}`);
    }

    this.database.sqlite
      .prepare(`
        insert into execution_scopes (
          scope_ref, scope_digest_sha256, adapter, created_at_ms, last_activity_at_ms,
          last_tool_name, last_tool_outcome, total_event_count
        ) values (?, ?, ?, ?, ?, ?, ?, 0)
        on conflict(scope_ref) do update set
          adapter = excluded.adapter,
          last_activity_at_ms = excluded.last_activity_at_ms,
          last_tool_name = excluded.last_tool_name,
          last_tool_outcome = excluded.last_tool_outcome
      `)
      .run(
        identity.scopeRef,
        identity.scopeDigestSha256,
        identity.adapter,
        nowMs,
        nowMs,
        toolName,
        outcome,
      );
  }

  private linkWorkspace(scopeRef: string, workspaceId: string, nowMs: number): void {
    const exists = this.database.sqlite
      .prepare("select 1 from workspace_sessions where id = ?")
      .get(workspaceId);
    if (!exists) return;
    this.database.sqlite
      .prepare(`
        insert into execution_scope_workspaces (
          scope_ref, workspace_session_id, first_seen_at_ms, last_seen_at_ms
        ) values (?, ?, ?, ?)
        on conflict(scope_ref, workspace_session_id) do update set
          last_seen_at_ms = excluded.last_seen_at_ms
      `)
      .run(scopeRef, workspaceId, nowMs, nowMs);
  }

  private recoverInterruptedObservations(): void {
    const recoveredAtMs = this.now();
    const transaction = this.database.sqlite.transaction(() => {
      const scopeRefs = this.database.sqlite
        .prepare("select distinct scope_ref from execution_scope_events where outcome = 'running'")
        .all() as Array<{ scope_ref: string }>;
      this.database.sqlite
        .prepare(`
          update execution_scope_events
             set outcome = 'interrupted', completed_at_ms = ?,
                 duration_ms = max(0, ? - started_at_ms),
                 error_kind = 'server_restart',
                 error_summary = 'Observation interrupted by DevSpace server restart.'
           where outcome = 'running'
        `)
        .run(recoveredAtMs, recoveredAtMs);
      const updateScope = this.database.sqlite.prepare(`
        update execution_scopes
           set last_activity_at_ms = ?, last_tool_outcome = 'interrupted'
         where scope_ref = ?
      `);
      for (const row of scopeRefs) updateScope.run(recoveredAtMs, row.scope_ref);
    });
    transaction.immediate();
  }

  private pruneExpired(): void {
    const cutoff = this.now() - this.config.retentionMs;
    const transaction = this.database.sqlite.transaction(() => {
      this.database.sqlite
        .prepare(
          "delete from execution_scope_events where started_at_ms < ? and outcome != 'running'",
        )
        .run(cutoff);
      this.database.sqlite
        .prepare(`
          delete from execution_scopes
           where last_activity_at_ms < ?
             and not exists (
               select 1 from execution_scope_events e where e.scope_ref = execution_scopes.scope_ref
             )
             and not exists (
               select 1 from execution_scope_messages m
                where m.sender_scope_ref = execution_scopes.scope_ref
                   or m.target_scope_ref = execution_scopes.scope_ref
             )
        `)
        .run(cutoff);
    });
    transaction.immediate();
  }

  private maybePruneExpired(nowMs: number): void {
    if (nowMs < this.nextGlobalPruneAtMs) return;
    this.pruneExpired();
    this.scheduleNextGlobalPrune(nowMs);
  }

  private scheduleNextGlobalPrune(nowMs: number): void {
    const intervalMs = Math.max(
      1_000,
      Math.min(60 * 60 * 1_000, Math.floor(this.config.retentionMs / 4)),
    );
    this.nextGlobalPruneAtMs = nowMs + intervalMs;
  }

  private pruneScope(scopeRef: string, nowMs: number): void {
    const cutoff = nowMs - this.config.retentionMs;
    this.database.sqlite
      .prepare(
        "delete from execution_scope_events where scope_ref = ? and started_at_ms < ? and outcome != 'running'",
      )
      .run(scopeRef, cutoff);
    const stale = this.database.sqlite
      .prepare(`
        select id from execution_scope_events
         where scope_ref = ? and outcome != 'running'
         order by sequence desc
         limit -1 offset ?
      `)
      .all(scopeRef, this.config.maxEventsPerScope) as Array<{ id: number }>;
    const deleteEvent = this.database.sqlite.prepare(
      "delete from execution_scope_events where id = ?",
    );
    for (const row of stale) deleteEvent.run(row.id);
  }

  private listStoredScopes(limit: number): StoredExecutionScope[] {
    const rows = this.database.sqlite
      .prepare(`
        select s.scope_ref, s.scope_digest_sha256, s.adapter, s.created_at_ms,
               s.last_activity_at_ms, s.last_tool_name, s.last_tool_outcome,
               s.total_event_count,
               (select count(*) from execution_scope_events e
                 where e.scope_ref = s.scope_ref and e.outcome = 'running') as running_tool_count,
               (select count(*) from execution_scope_workspaces w
                 where w.scope_ref = s.scope_ref) as workspace_count
          from execution_scopes s
         order by s.last_activity_at_ms desc
         limit ?
      `)
      .all(limit) as Array<Record<string, unknown>>;
    return rows.map(rowToStoredScope);
  }

  private getStoredScope(scopeRef: string): StoredExecutionScope | undefined {
    const row = this.database.sqlite
      .prepare(`
        select s.scope_ref, s.scope_digest_sha256, s.adapter, s.created_at_ms,
               s.last_activity_at_ms, s.last_tool_name, s.last_tool_outcome,
               s.total_event_count,
               (select count(*) from execution_scope_events e
                 where e.scope_ref = s.scope_ref and e.outcome = 'running') as running_tool_count,
               (select count(*) from execution_scope_workspaces w
                 where w.scope_ref = s.scope_ref) as workspace_count
          from execution_scopes s
         where s.scope_ref = ?
      `)
      .get(scopeRef) as Record<string, unknown> | undefined;
    return row ? rowToStoredScope(row) : undefined;
  }

  private listStoredEvents(
    scopeRef: string,
    limit: number,
    beforeSequence: number | undefined,
  ): StoredExecutionEvent[] {
    const rows = this.database.sqlite
      .prepare(`
        select sequence, tool_name, outcome, started_at_ms, completed_at_ms,
               duration_ms, workspace_id, process_session_id, detail_json,
               error_kind, error_summary, error_digest_sha256
          from execution_scope_events
         where scope_ref = ?
           and (? is null or sequence < ?)
         order by sequence desc
         limit ?
      `)
      .all(scopeRef, beforeSequence ?? null, beforeSequence ?? null, limit) as Array<
        Record<string, unknown>
      >;
    return rows.map((row) => ({
      sequence: Number(row.sequence),
      toolName: String(row.tool_name),
      outcome: String(row.outcome) as ExecutionToolOutcome,
      startedAtMs: Number(row.started_at_ms),
      completedAtMs: row.completed_at_ms === null ? undefined : Number(row.completed_at_ms),
      durationMs: row.duration_ms === null ? undefined : Number(row.duration_ms),
      workspaceId: row.workspace_id === null ? undefined : String(row.workspace_id),
      processSessionId:
        row.process_session_id === null ? undefined : Number(row.process_session_id),
      detail: parseJsonRecord(row.detail_json),
      errorKind: row.error_kind === null ? undefined : String(row.error_kind),
      errorSummary: row.error_summary === null ? undefined : String(row.error_summary),
      errorDigestSha256:
        row.error_digest_sha256 === null ? undefined : String(row.error_digest_sha256),
    }));
  }

  private listStoredWorkspaces(scopeRef: string): StoredWorkspace[] {
    const rows = this.database.sqlite
      .prepare(`
        select ws.id, ws.root, ws.status, ws.mode, ws.source_root, ws.base_ref,
               ws.base_sha, ws.managed, ws.created_at, ws.last_used_at,
               link.first_seen_at_ms, link.last_seen_at_ms
          from execution_scope_workspaces link
          join workspace_sessions ws on ws.id = link.workspace_session_id
         where link.scope_ref = ?
         order by link.last_seen_at_ms desc
      `)
      .all(scopeRef) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      workspaceId: String(row.id),
      root: String(row.root),
      status: String(row.status),
      mode: row.mode === "worktree" ? "worktree" : "checkout",
      sourceRoot: row.source_root === null ? undefined : String(row.source_root),
      baseRef: row.base_ref === null ? undefined : String(row.base_ref),
      baseSha: row.base_sha === null ? undefined : String(row.base_sha),
      managed: row.managed === "true",
      createdAt: String(row.created_at),
      lastUsedAt: String(row.last_used_at),
      firstSeenAt: new Date(Number(row.first_seen_at_ms)).toISOString(),
      lastSeenAt: new Date(Number(row.last_seen_at_ms)).toISOString(),
    }));
  }

  private auditSummary(scopeRef: string): Record<string, unknown> {
    const totals = this.database.sqlite
      .prepare(`
        select count(*) as events,
               sum(case when outcome = 'succeeded' then 1 else 0 end) as succeeded,
               sum(case when outcome = 'failed' then 1 else 0 end) as failed,
               coalesce(sum(duration_ms), 0) as total_ms,
               avg(duration_ms) as average_ms,
               max(duration_ms) as max_ms,
               min(started_at_ms) as first_event_at_ms,
               max(coalesce(completed_at_ms, started_at_ms)) as last_event_at_ms
          from execution_scope_events
         where scope_ref = ?
      `)
      .get(scopeRef) as Record<string, unknown> | undefined;
    const byToolRows = this.database.sqlite
      .prepare(`
        select tool_name,
               count(*) as calls,
               sum(case when outcome = 'succeeded' then 1 else 0 end) as succeeded,
               sum(case when outcome = 'failed' then 1 else 0 end) as failed,
               coalesce(sum(duration_ms), 0) as total_ms,
               avg(duration_ms) as average_ms,
               max(duration_ms) as max_ms
          from execution_scope_events
         where scope_ref = ?
         group by tool_name
         order by tool_name
      `)
      .all(scopeRef) as Array<Record<string, unknown>>;

    const events = Number(totals?.events ?? 0);
    return {
      events,
      succeeded: Number(totals?.succeeded ?? 0),
      failed: Number(totals?.failed ?? 0),
      totalMs: Number(totals?.total_ms ?? 0),
      averageMs:
        totals?.average_ms === null || totals?.average_ms === undefined
          ? 0
          : Number(totals.average_ms),
      maxMs:
        totals?.max_ms === null || totals?.max_ms === undefined
          ? 0
          : Number(totals.max_ms),
      firstEventAt:
        totals?.first_event_at_ms === null || totals?.first_event_at_ms === undefined
          ? undefined
          : iso(Number(totals.first_event_at_ms)),
      lastEventAt:
        totals?.last_event_at_ms === null || totals?.last_event_at_ms === undefined
          ? undefined
          : iso(Number(totals.last_event_at_ms)),
      byTool: Object.fromEntries(byToolRows.map((row) => [
        String(row.tool_name),
        {
          calls: Number(row.calls ?? 0),
          succeeded: Number(row.succeeded ?? 0),
          failed: Number(row.failed ?? 0),
          totalMs: Number(row.total_ms ?? 0),
          averageMs:
            row.average_ms === null || row.average_ms === undefined
              ? 0
              : Number(row.average_ms),
          maxMs:
            row.max_ms === null || row.max_ms === undefined
              ? 0
              : Number(row.max_ms),
        },
      ])),
    };
  }

  private scopeSummary(
    scope: StoredExecutionScope,
    currentScopeRef: string | undefined,
    suppliedWorkspaces?: StoredWorkspace[],
    suppliedProcesses?: ProcessSessionInspection[],
    suppliedOtherOrUnattributedRunningProcessCount?: number,
  ): Record<string, unknown> {
    const workspaces = suppliedWorkspaces ?? this.listStoredWorkspaces(scope.scopeRef);
    const processProjection = suppliedProcesses
      ? {
          processes: suppliedProcesses,
          otherOrUnattributedRunningProcessCount:
            suppliedOtherOrUnattributedRunningProcessCount ?? 0,
        }
      : this.processProjection(scope.scopeRef, workspaces);
    const processes = processProjection.processes;
    const runningProcessCount = processes.filter((process) => process.running).length;
    const idleForMs = Math.max(0, this.now() - scope.lastActivityAtMs);
    const activityState = scope.runningToolCount > 0 || runningProcessCount > 0
      ? "running"
      : idleForMs <= this.config.idleAfterMs
        ? "recent"
        : "idle";
    const observableExecutorState = scope.runningToolCount > 0
      ? "tool_running"
      : runningProcessCount > 0
        ? "process_running"
        : "no_running_tool_or_process";
    const blindIntervalActive = observableExecutorState === "no_running_tool_or_process";

    return {
      scopeRef: scope.scopeRef,
      isCurrent: scope.scopeRef === currentScopeRef,
      adapter: scope.adapter,
      materialized: true,
      activityState,
      createdAt: iso(scope.createdAtMs),
      lastActivityAt: iso(scope.lastActivityAtMs),
      idleForMs,
      lastTool: scope.lastToolName,
      lastOutcome: scope.lastToolOutcome,
      runningToolCount: scope.runningToolCount,
      runningProcessCount,
      otherOrUnattributedRunningProcessCount:
        processProjection.otherOrUnattributedRunningProcessCount,
      workspaceCount: scope.workspaceCount,
      totalEventCount: scope.totalEventCount,
      observation: {
        boundary: "mcp_tool_and_process_observation_only",
        observableExecutorState,
        lastObservedMcpActivityAt: iso(scope.lastActivityAtMs),
        observationGapMs: idleForMs,
        blindIntervalActive,
        blindIntervalMs: blindIntervalActive ? idleForMs : 0,
        modelProgressObservable: false,
        providerGenerationObservable: false,
        modelState: "not_observed",
        hungDetermination: "unavailable",
      },
    };
  }

  private unmaterializedCurrentScopeSummary(
    identity: ExecutionScopeIdentity,
  ): Record<string, unknown> {
    return {
      scopeRef: identity.scopeRef,
      isCurrent: true,
      adapter: identity.adapter,
      materialized: false,
      activityState: "unobserved",
      runningToolCount: 0,
      runningProcessCount: 0,
      otherOrUnattributedRunningProcessCount: 0,
      workspaceCount: 0,
      totalEventCount: 0,
      observation: {
        boundary: "mcp_tool_and_process_observation_only",
        observableExecutorState: "no_observed_tool_or_process_yet",
        blindIntervalActive: false,
        modelProgressObservable: false,
        providerGenerationObservable: false,
        modelState: "not_observed",
        hungDetermination: "unavailable",
        reason:
          "The host supplied a stable current scope identity, but no audited executor event has materialized this scope yet.",
      },
    };
  }

  private processProjection(
    scopeRef: string,
    workspaces: StoredWorkspace[],
  ): {
    processes: ProcessSessionInspection[];
    otherOrUnattributedRunningProcessCount: number;
  } {
    const workspaceIds = workspaces.map((workspace) => workspace.workspaceId);
    const allProcesses = this.processSessions.inspect(workspaceIds);
    const processes = this.processSessions.inspect(workspaceIds, [scopeRef]);
    const ownedIds = new Set(processes.map((process) => process.sessionId));
    return {
      processes,
      otherOrUnattributedRunningProcessCount: allProcesses.filter(
        (process) => process.running && !ownedIds.has(process.sessionId),
      ).length,
    };
  }

  private policy(): Record<string, unknown> {
    return {
      authority: "executor_local_observation_only",
      canonicalTaskOrDecisionAuthority: false,
      transcriptCaptured: false,
      promptsCaptured: false,
      privateReasoningCaptured: false,
      toolOutputsCaptured: false,
      rawCommandsCaptured: false,
      activityStateRepresents: "executor_tool_process_observation_only",
      modelStateObservableBetweenMcpCalls: false,
      providerGenerationObservableBetweenMcpCalls: false,
      hungDeterminationAvailable: false,
      retentionMs: this.config.retentionMs,
      maxEventsPerScope: this.config.maxEventsPerScope,
    };
  }

  private disabledResult(): Record<string, unknown> {
    return {
      schemaVersion: 1,
      enabled: false,
      policy: this.policy(),
    };
  }
}

function rowToStoredScope(row: Record<string, unknown>): StoredExecutionScope {
    return {
      scopeRef: String(row.scope_ref),
    scopeDigestSha256: String(row.scope_digest_sha256),
    adapter: String(row.adapter),
    createdAtMs: Number(row.created_at_ms),
    lastActivityAtMs: Number(row.last_activity_at_ms),
    lastToolName: row.last_tool_name === null ? undefined : String(row.last_tool_name),
    lastToolOutcome:
      row.last_tool_outcome === null
        ? undefined
        : String(row.last_tool_outcome) as ExecutionToolOutcome,
    totalEventCount: Number(row.total_event_count),
    runningToolCount: Number(row.running_tool_count),
    workspaceCount: Number(row.workspace_count),
  };
}
