import { createHash, randomUUID } from "node:crypto";
import { openDatabase, type DatabaseHandle } from "./db/client.js";
import type { ExecutionScopeIdentity } from "./request-meta.js";

export type ExecutionMessageKind =
  | "instruction"
  | "correction"
  | "question"
  | "notice"
  | "handoff";

export type ExecutionMessagePriority =
  | "low"
  | "normal"
  | "high"
  | "urgent";

export type ExecutionMessageState =
  | "accepted"
  | "observed"
  | "acknowledged"
  | "acted"
  | "expired";

export type ExecutionMessageReceiptState = "acknowledged" | "acted";

export interface ExecutionMailboxConfig {
  enabled: boolean;
  defaultTtlMs: number;
  maxTtlMs: number;
  terminalRetentionMs: number;
  maxPendingPerScope: number;
  maxBodyCharacters: number;
}

export interface ExecutionMessageSendInput {
  targetScopeRef: string;
  idempotencyKey: string;
  kind: ExecutionMessageKind;
  priority?: ExecutionMessagePriority;
  body: string;
  correlationRef?: string;
  expiresInHours?: number;
}

export interface ExecutionMessageInboxOptions {
  limit?: number;
  cursor?: string;
  includeTerminal?: boolean;
}

export interface ExecutionMessageReceiptInput {
  messageId: string;
  state: ExecutionMessageReceiptState;
  note?: string;
}

export interface ExecutionMessageView {
  schemaVersion: 1;
  messageId: string;
  senderScopeRef: string;
  targetScopeRef: string;
  kind: ExecutionMessageKind;
  priority: ExecutionMessagePriority;
  body: string;
  correlationRef?: string;
  state: ExecutionMessageState;
  acceptedAt: string;
  expiresAt: string;
  observedAt?: string;
  acknowledgedAt?: string;
  actedAt?: string;
  acknowledgementNote?: string;
  actedNote?: string;
}

export interface ExecutionMailboxPendingSummary {
  pendingCount: number;
  unobservedCount: number;
  highestPriority?: ExecutionMessagePriority;
}

export interface ExecutionMailboxWaiter {
  promise: Promise<void>;
  cancel(): void;
}

interface ExecutionMailboxManagerOptions {
  now?: () => number;
}

interface MessageRow {
  id: string;
  sender_scope_ref: string;
  target_scope_ref: string;
  idempotency_key: string;
  payload_digest_sha256: string;
  kind: string;
  priority: string;
  body: string;
  correlation_ref: string | null;
  created_at_ms: number;
  expires_at_ms: number;
  observed_at_ms: number | null;
  acknowledged_at_ms: number | null;
  acted_at_ms: number | null;
  acknowledgement_note: string | null;
  acted_note: string | null;
}

interface InboxCursor {
  priorityRank: number;
  createdAtMs: number;
  messageId: string;
}

const SCOPE_REF_PATTERN = /^[a-f0-9]{16}$/;
const MESSAGE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_IDEMPOTENCY_KEY_CHARACTERS = 200;
const MAX_CORRELATION_REF_CHARACTERS = 1_000;
const MAX_RECEIPT_NOTE_CHARACTERS = 4_000;
const MAX_INBOX_LIMIT = 50;
const PRIORITY_RANK: Record<ExecutionMessagePriority, number> = {
  urgent: 0,
  high: 1,
  normal: 2,
  low: 3,
};

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function iso(ms: number | null | undefined): string | undefined {
  return ms === null || ms === undefined ? undefined : new Date(ms).toISOString();
}

function requireScopeIdentity(
  identity: ExecutionScopeIdentity | undefined,
): ExecutionScopeIdentity {
  if (!identity) {
    throw new Error(
      "A stable execution scope is required for cross-session messaging.",
    );
  }
  return identity;
}

function requireScopeRef(value: string): string {
  if (!SCOPE_REF_PATTERN.test(value)) {
    throw new Error("Execution scope references must be 16 lowercase hexadecimal characters.");
  }
  return value;
}

function requireMessageId(value: string): string {
  if (!MESSAGE_ID_PATTERN.test(value)) {
    throw new Error("Invalid execution message identifier.");
  }
  return value;
}

function boundedText(
  value: string | undefined,
  name: string,
  maximum: number,
  required = false,
): string | undefined {
  const normalized = value?.trim();
  if (!normalized) {
    if (required) throw new Error(`${name} must not be empty.`);
    return undefined;
  }
  if (normalized.length > maximum) {
    throw new Error(`${name} exceeds the ${maximum}-character limit.`);
  }
  return normalized;
}

function messageKind(value: string): ExecutionMessageKind {
  if (["instruction", "correction", "question", "notice", "handoff"].includes(value)) {
    return value as ExecutionMessageKind;
  }
  throw new Error(`Invalid execution message kind: ${value}`);
}

function messagePriority(value: string | undefined): ExecutionMessagePriority {
  const priority = value ?? "normal";
  if (["low", "normal", "high", "urgent"].includes(priority)) {
    return priority as ExecutionMessagePriority;
  }
  throw new Error(`Invalid execution message priority: ${priority}`);
}

function stateFor(row: MessageRow, nowMs: number): ExecutionMessageState {
  if (row.acted_at_ms !== null) return "acted";
  if (row.expires_at_ms <= nowMs) return "expired";
  if (row.acknowledged_at_ms !== null) return "acknowledged";
  if (row.observed_at_ms !== null) return "observed";
  return "accepted";
}

function messageView(row: MessageRow, nowMs: number): ExecutionMessageView {
  return {
    schemaVersion: 1,
    messageId: row.id,
    senderScopeRef: row.sender_scope_ref,
    targetScopeRef: row.target_scope_ref,
    kind: messageKind(row.kind),
    priority: messagePriority(row.priority),
    body: row.body,
    correlationRef: row.correlation_ref ?? undefined,
    state: stateFor(row, nowMs),
    acceptedAt: new Date(row.created_at_ms).toISOString(),
    expiresAt: new Date(row.expires_at_ms).toISOString(),
    observedAt: iso(row.observed_at_ms),
    acknowledgedAt: iso(row.acknowledged_at_ms),
    actedAt: iso(row.acted_at_ms),
    acknowledgementNote: row.acknowledgement_note ?? undefined,
    actedNote: row.acted_note ?? undefined,
  };
}

function encodeCursor(cursor: InboxCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: string | undefined): InboxCursor | undefined {
  if (!value) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new Error("Invalid execution mailbox cursor.");
  }
  if (
    typeof parsed !== "object"
    || parsed === null
    || Array.isArray(parsed)
  ) {
    throw new Error("Invalid execution mailbox cursor.");
  }
  const record = parsed as Record<string, unknown>;
  const priorityRank = record.priorityRank;
  const createdAtMs = record.createdAtMs;
  const messageId = record.messageId;
  if (
    !Number.isInteger(priorityRank)
    || typeof priorityRank !== "number"
    || priorityRank < 0
    || priorityRank > 3
    || !Number.isInteger(createdAtMs)
    || typeof createdAtMs !== "number"
    || typeof messageId !== "string"
    || !MESSAGE_ID_PATTERN.test(messageId)
  ) {
    throw new Error("Invalid execution mailbox cursor.");
  }
  return { priorityRank, createdAtMs, messageId };
}

function priorityCaseSql(): string {
  return `case priority
    when 'urgent' then 0
    when 'high' then 1
    when 'normal' then 2
    else 3
  end`;
}

export class ExecutionMailboxManager {
  private readonly database: DatabaseHandle;
  private readonly now: () => number;
  private readonly waiters = new Map<string, Set<() => void>>();
  private nextCleanupAtMs = 0;
  private closed = false;

  constructor(
    readonly config: ExecutionMailboxConfig,
    stateDir: string,
    options: ExecutionMailboxManagerOptions = {},
  ) {
    if (!Number.isInteger(config.defaultTtlMs) || config.defaultTtlMs < 1) {
      throw new Error("Execution mailbox defaultTtlMs must be a positive integer.");
    }
    if (!Number.isInteger(config.maxTtlMs) || config.maxTtlMs < config.defaultTtlMs) {
      throw new Error("Execution mailbox maxTtlMs must be at least defaultTtlMs.");
    }
    if (!Number.isInteger(config.terminalRetentionMs) || config.terminalRetentionMs < 1) {
      throw new Error("Execution mailbox terminalRetentionMs must be a positive integer.");
    }
    if (!Number.isInteger(config.maxPendingPerScope) || config.maxPendingPerScope < 1) {
      throw new Error("Execution mailbox maxPendingPerScope must be a positive integer.");
    }
    if (!Number.isInteger(config.maxBodyCharacters) || config.maxBodyCharacters < 1) {
      throw new Error("Execution mailbox maxBodyCharacters must be a positive integer.");
    }
    this.database = openDatabase(stateDir);
    this.now = options.now ?? Date.now;
    if (config.enabled) {
      this.cleanup(this.now());
      this.scheduleCleanup(this.now());
    }
  }

  send(
    senderIdentity: ExecutionScopeIdentity | undefined,
    input: ExecutionMessageSendInput,
  ): { message: ExecutionMessageView; idempotentReplay: boolean } {
    this.assertEnabled();
    const sender = requireScopeIdentity(senderIdentity);
    const targetScopeRef = requireScopeRef(input.targetScopeRef);
    if (targetScopeRef === sender.scopeRef) {
      throw new Error("Cross-session messages must target a different execution scope.");
    }

    const idempotencyKey = boundedText(
      input.idempotencyKey,
      "idempotencyKey",
      MAX_IDEMPOTENCY_KEY_CHARACTERS,
      true,
    ) as string;
    const kind = messageKind(input.kind);
    const priority = messagePriority(input.priority);
    const body = boundedText(
      input.body,
      "body",
      this.config.maxBodyCharacters,
      true,
    ) as string;
    const correlationRef = boundedText(
      input.correlationRef,
      "correlationRef",
      MAX_CORRELATION_REF_CHARACTERS,
    );
    const ttlMs = input.expiresInHours === undefined
      ? this.config.defaultTtlMs
      : this.ttlMs(input.expiresInHours);
    const payloadDigestSha256 = sha256(JSON.stringify({
      targetScopeRef,
      kind,
      priority,
      body,
      correlationRef: correlationRef ?? null,
      expiresInHours: input.expiresInHours ?? null,
    }));
    const nowMs = this.now();
    this.maybeCleanup(nowMs);

    const transaction = this.database.sqlite.transaction(() => {
      this.ensureScope(sender, nowMs);
      this.assertKnownTarget(targetScopeRef);

      const existing = this.database.sqlite
        .prepare(`
          select * from execution_scope_messages
           where sender_scope_ref = ? and idempotency_key = ?
        `)
        .get(sender.scopeRef, idempotencyKey) as MessageRow | undefined;
      if (existing) {
        if (existing.payload_digest_sha256 !== payloadDigestSha256) {
          throw new Error(
            "The idempotencyKey was already used with a different message payload.",
          );
        }
        return { row: existing, idempotentReplay: true };
      }

      const pending = this.database.sqlite
        .prepare(`
          select count(*) as count
            from execution_scope_messages
           where target_scope_ref = ?
             and acted_at_ms is null
             and expires_at_ms > ?
        `)
        .get(targetScopeRef, nowMs) as { count: number };
      if (pending.count >= this.config.maxPendingPerScope) {
        throw new Error(
          `Target execution scope has reached its ${this.config.maxPendingPerScope}-message pending limit.`,
        );
      }

      const row: MessageRow = {
        id: randomUUID(),
        sender_scope_ref: sender.scopeRef,
        target_scope_ref: targetScopeRef,
        idempotency_key: idempotencyKey,
        payload_digest_sha256: payloadDigestSha256,
        kind,
        priority,
        body,
        correlation_ref: correlationRef ?? null,
        created_at_ms: nowMs,
        expires_at_ms: nowMs + ttlMs,
        observed_at_ms: null,
        acknowledged_at_ms: null,
        acted_at_ms: null,
        acknowledgement_note: null,
        acted_note: null,
      };
      this.database.sqlite
        .prepare(`
          insert into execution_scope_messages (
            id, sender_scope_ref, target_scope_ref, idempotency_key,
            payload_digest_sha256, kind, priority, body, correlation_ref,
            created_at_ms, expires_at_ms, observed_at_ms,
            acknowledged_at_ms, acted_at_ms, acknowledgement_note, acted_note
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, null, null, null, null, null)
        `)
        .run(
          row.id,
          row.sender_scope_ref,
          row.target_scope_ref,
          row.idempotency_key,
          row.payload_digest_sha256,
          row.kind,
          row.priority,
          row.body,
          row.correlation_ref,
          row.created_at_ms,
          row.expires_at_ms,
        );
      return { row, idempotentReplay: false };
    });

    const result = transaction.immediate();
    if (!result.idempotentReplay) this.notify(targetScopeRef);
    return {
      message: messageView(result.row, nowMs),
      idempotentReplay: result.idempotentReplay,
    };
  }

  inbox(
    targetIdentity: ExecutionScopeIdentity | undefined,
    options: ExecutionMessageInboxOptions = {},
  ): {
    messages: ExecutionMessageView[];
    nextCursor?: string;
  } {
    this.assertEnabled();
    const target = requireScopeIdentity(targetIdentity);
    const nowMs = this.now();
    this.maybeCleanup(nowMs);
    this.ensureScope(target, nowMs);
    const limit = Math.max(1, Math.min(MAX_INBOX_LIMIT, Math.floor(options.limit ?? 20)));
    const cursor = decodeCursor(options.cursor);
    const includeTerminal = options.includeTerminal === true;
    const rankSql = priorityCaseSql();
    const terminalClause = includeTerminal
      ? ""
      : "and acted_at_ms is null and expires_at_ms > @nowMs";
    const cursorClause = cursor
      ? `and (
          ${rankSql} > @priorityRank
          or (${rankSql} = @priorityRank and created_at_ms > @createdAtMs)
          or (${rankSql} = @priorityRank and created_at_ms = @createdAtMs and id > @messageId)
        )`
      : "";
    const parameters: Record<string, unknown> = {
      targetScopeRef: target.scopeRef,
      limit: limit + 1,
    };
    if (!includeTerminal) parameters.nowMs = nowMs;
    if (cursor) {
      parameters.priorityRank = cursor.priorityRank;
      parameters.createdAtMs = cursor.createdAtMs;
      parameters.messageId = cursor.messageId;
    }
    const rows = this.database.sqlite
      .prepare(`
        select * from execution_scope_messages
         where target_scope_ref = @targetScopeRef
           ${terminalClause}
           ${cursorClause}
         order by ${rankSql} asc, created_at_ms asc, id asc
         limit @limit
      `)
      .all(parameters) as MessageRow[];
    const hasMore = rows.length > limit;
    const selected = rows.slice(0, limit);

    const markObserved = this.database.sqlite.transaction(() => {
      const update = this.database.sqlite.prepare(`
        update execution_scope_messages
           set observed_at_ms = coalesce(observed_at_ms, ?)
         where id = ? and target_scope_ref = ?
      `);
      const receipt = this.database.sqlite.prepare(`
        insert into execution_scope_message_receipts (
          message_id, target_scope_ref, state, recorded_at_ms, note
        ) values (?, ?, 'observed', ?, null)
        on conflict(message_id, state) do nothing
      `);
      for (const row of selected) {
        if (row.observed_at_ms === null) {
          update.run(nowMs, row.id, target.scopeRef);
          receipt.run(row.id, target.scopeRef, nowMs);
          row.observed_at_ms = nowMs;
        }
      }
    });
    markObserved.immediate();

    const last = selected.at(-1);
    return {
      messages: selected.map((row) => messageView(row, nowMs)),
      nextCursor:
        hasMore && last
          ? encodeCursor({
              priorityRank: PRIORITY_RANK[messagePriority(last.priority)],
              createdAtMs: last.created_at_ms,
              messageId: last.id,
            })
          : undefined,
    };
  }

  status(
    identity: ExecutionScopeIdentity | undefined,
    messageId: string,
  ): ExecutionMessageView {
    this.assertEnabled();
    const current = requireScopeIdentity(identity);
    const id = requireMessageId(messageId);
    const nowMs = this.now();
    const row = this.database.sqlite
      .prepare(`
        select * from execution_scope_messages
         where id = ?
           and (sender_scope_ref = ? or target_scope_ref = ?)
      `)
      .get(id, current.scopeRef, current.scopeRef) as MessageRow | undefined;
    if (!row) throw new Error(`Unknown execution message: ${id}`);
    return messageView(row, nowMs);
  }

  receipt(
    targetIdentity: ExecutionScopeIdentity | undefined,
    input: ExecutionMessageReceiptInput,
  ): ExecutionMessageView {
    this.assertEnabled();
    const target = requireScopeIdentity(targetIdentity);
    const messageId = requireMessageId(input.messageId);
    const note = boundedText(
      input.note,
      "note",
      MAX_RECEIPT_NOTE_CHARACTERS,
    );
    const nowMs = this.now();
    this.maybeCleanup(nowMs);
    this.ensureScope(target, nowMs);

    const transaction = this.database.sqlite.transaction(() => {
      const row = this.database.sqlite
        .prepare(`
          select * from execution_scope_messages
           where id = ? and target_scope_ref = ?
        `)
        .get(messageId, target.scopeRef) as MessageRow | undefined;
      if (!row) throw new Error(`Unknown target-bound execution message: ${messageId}`);
      if (row.expires_at_ms <= nowMs && row.acted_at_ms === null) {
        throw new Error("Expired execution messages cannot receive new receipts.");
      }

      const states: Array<"observed" | "acknowledged" | "acted"> = ["observed"];
      if (input.state === "acknowledged" || input.state === "acted") {
        states.push("acknowledged");
      }
      if (input.state === "acted") states.push("acted");

      this.database.sqlite
        .prepare(`
          update execution_scope_messages
             set observed_at_ms = coalesce(observed_at_ms, ?),
                 acknowledged_at_ms = case
                   when ? in ('acknowledged', 'acted')
                   then coalesce(acknowledged_at_ms, ?)
                   else acknowledged_at_ms
                 end,
                 acted_at_ms = case
                   when ? = 'acted' then coalesce(acted_at_ms, ?)
                   else acted_at_ms
                 end,
                 acknowledgement_note = case
                   when ? = 'acknowledged' and ? is not null
                   then coalesce(acknowledgement_note, ?)
                   else acknowledgement_note
                 end,
                 acted_note = case
                   when ? = 'acted' and ? is not null
                   then coalesce(acted_note, ?)
                   else acted_note
                 end
           where id = ? and target_scope_ref = ?
        `)
        .run(
          nowMs,
          input.state,
          nowMs,
          input.state,
          nowMs,
          input.state,
          note ?? null,
          note ?? null,
          input.state,
          note ?? null,
          note ?? null,
          messageId,
          target.scopeRef,
        );

      const insertReceipt = this.database.sqlite.prepare(`
        insert into execution_scope_message_receipts (
          message_id, target_scope_ref, state, recorded_at_ms, note
        ) values (?, ?, ?, ?, ?)
        on conflict(message_id, state) do nothing
      `);
      for (const state of states) {
        insertReceipt.run(
          messageId,
          target.scopeRef,
          state,
          nowMs,
          state === input.state ? note ?? null : null,
        );
      }

      return this.database.sqlite
        .prepare("select * from execution_scope_messages where id = ?")
        .get(messageId) as MessageRow;
    });

    return messageView(transaction.immediate(), nowMs);
  }

  pendingSummary(
    targetIdentity: ExecutionScopeIdentity | undefined,
  ): ExecutionMailboxPendingSummary {
    if (!this.config.enabled || !targetIdentity) {
      return { pendingCount: 0, unobservedCount: 0 };
    }
    const nowMs = this.now();
    this.maybeCleanup(nowMs);
    const row = this.database.sqlite
      .prepare(`
        select
          count(*) as pending_count,
          sum(case when observed_at_ms is null then 1 else 0 end) as unobserved_count,
          min(${priorityCaseSql()}) as highest_rank
        from execution_scope_messages
        where target_scope_ref = ?
          and acted_at_ms is null
          and expires_at_ms > ?
      `)
      .get(targetIdentity.scopeRef, nowMs) as {
        pending_count: number;
        unobserved_count: number | null;
        highest_rank: number | null;
      };
    const highestEntry = row.highest_rank === null
      ? undefined
      : Object.entries(PRIORITY_RANK).find(([, rank]) => rank === row.highest_rank);
    const highestPriority = highestEntry?.[0] as ExecutionMessagePriority | undefined;
    return {
      pendingCount: row.pending_count,
      unobservedCount: row.unobserved_count ?? 0,
      highestPriority,
    };
  }

  pendingNotice(
    targetIdentity: ExecutionScopeIdentity | undefined,
  ): string | undefined {
    const summary = this.pendingSummary(targetIdentity);
    if (summary.pendingCount === 0) return undefined;
    const priority = summary.highestPriority
      ? `; highest priority ${summary.highestPriority}`
      : "";
    return `[execution-mailbox] ${summary.pendingCount} pending message(s), ${summary.unobservedCount} unobserved${priority}. Call execution_scope_message_inbox before opening a new major frontier.`;
  }

  createWaiter(scopeRef: string): ExecutionMailboxWaiter {
    this.assertEnabled();
    const targetScopeRef = requireScopeRef(scopeRef);
    let resolvePromise = (): void => undefined;
    let active = true;
    const promise = new Promise<void>((resolve) => {
      resolvePromise = resolve;
    });
    const resolve = () => {
      if (!active) return;
      active = false;
      this.removeWaiter(targetScopeRef, resolve);
      resolvePromise();
    };
    const waiters = this.waiters.get(targetScopeRef) ?? new Set<() => void>();
    waiters.add(resolve);
    this.waiters.set(targetScopeRef, waiters);

    const pending = this.database.sqlite
      .prepare(`
        select 1 from execution_scope_messages
         where target_scope_ref = ?
           and acted_at_ms is null
           and observed_at_ms is null
           and expires_at_ms > ?
         limit 1
      `)
      .get(targetScopeRef, this.now());
    if (pending) queueMicrotask(resolve);

    return {
      promise,
      cancel: () => {
        if (!active) return;
        active = false;
        this.removeWaiter(targetScopeRef, resolve);
      },
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiters of this.waiters.values()) {
      for (const resolve of waiters) resolve();
    }
    this.waiters.clear();
    this.database.close();
  }

  private assertEnabled(): void {
    if (!this.config.enabled) {
      throw new Error("Execution-scope mailbox is disabled.");
    }
  }

  private ttlMs(expiresInHours: number): number {
    if (!Number.isFinite(expiresInHours) || expiresInHours <= 0) {
      throw new Error("expiresInHours must be a positive number.");
    }
    const ttlMs = Math.floor(expiresInHours * 60 * 60 * 1_000);
    if (ttlMs < 1) {
      throw new Error("expiresInHours is too small to produce a positive lifetime.");
    }
    if (ttlMs > this.config.maxTtlMs) {
      throw new Error(
        `expiresInHours exceeds the configured ${this.config.maxTtlMs / 3_600_000}-hour maximum.`,
      );
    }
    return ttlMs;
  }

  private ensureScope(identity: ExecutionScopeIdentity, nowMs: number): void {
    const existing = this.database.sqlite
      .prepare("select scope_digest_sha256 from execution_scopes where scope_ref = ?")
      .get(identity.scopeRef) as { scope_digest_sha256: string } | undefined;
    if (existing && existing.scope_digest_sha256 !== identity.scopeDigestSha256) {
      throw new Error(`Execution scope reference collision: ${identity.scopeRef}`);
    }
    this.database.sqlite
      .prepare(`
        insert into execution_scopes (
          scope_ref, scope_digest_sha256, adapter, created_at_ms,
          last_activity_at_ms, total_event_count
        ) values (?, ?, ?, ?, ?, 0)
        on conflict(scope_ref) do update set
          adapter = excluded.adapter,
          last_activity_at_ms = excluded.last_activity_at_ms
      `)
      .run(
        identity.scopeRef,
        identity.scopeDigestSha256,
        identity.adapter,
        nowMs,
        nowMs,
      );
  }

  private assertKnownTarget(scopeRef: string): void {
    const target = this.database.sqlite
      .prepare("select 1 from execution_scopes where scope_ref = ?")
      .get(scopeRef);
    if (!target) {
      throw new Error(
        `Unknown target execution scope: ${scopeRef}. Discover an active or retained scope with execution_scope_list first.`,
      );
    }
  }

  private notify(scopeRef: string): void {
    const waiters = this.waiters.get(scopeRef);
    if (!waiters) return;
    for (const resolve of [...waiters]) resolve();
  }

  private removeWaiter(scopeRef: string, resolve: () => void): void {
    const waiters = this.waiters.get(scopeRef);
    if (!waiters) return;
    waiters.delete(resolve);
    if (waiters.size === 0) this.waiters.delete(scopeRef);
  }

  private maybeCleanup(nowMs: number): void {
    if (nowMs < this.nextCleanupAtMs) return;
    this.cleanup(nowMs);
    this.scheduleCleanup(nowMs);
  }

  private cleanup(nowMs: number): void {
    const terminalCutoff = nowMs - this.config.terminalRetentionMs;
    this.database.sqlite
      .prepare(`
        delete from execution_scope_messages
         where (acted_at_ms is not null and acted_at_ms < ?)
            or (expires_at_ms < ?)
      `)
      .run(terminalCutoff, terminalCutoff);
  }

  private scheduleCleanup(nowMs: number): void {
    this.nextCleanupAtMs = nowMs + Math.max(
      1_000,
      Math.min(60 * 60 * 1_000, Math.floor(this.config.terminalRetentionMs / 4)),
    );
  }
}
