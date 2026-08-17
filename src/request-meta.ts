import { createHash } from "node:crypto";

function metadataString(
  meta: unknown,
  key: string,
): string | undefined {
  if (typeof meta !== "object" || meta === null) return undefined;
  const value = (meta as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function metadataNumber(
  meta: unknown,
  key: string,
): number | undefined {
  if (typeof meta !== "object" || meta === null) return undefined;
  const value = (meta as Record<string, unknown>)[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function openAiConversationScopeId(
  meta: unknown,
): string | undefined {
  return metadataString(meta, "openai/session");
}

export type ExecutionScopeAdapter = "devspace" | "openai";

export interface ExecutorTurnIdentity {
  /** Raw opaque host turn identity. DevSpace must not persist this value. */
  turnId: string;
  /** Stable non-reversible reference safe for owner-visible runtime state. */
  turnRef: string;
}

export interface ExecutorTurnMetadata {
  identity?: ExecutorTurnIdentity;
  /** Optional exact host-supplied absolute deadline, expressed as Unix milliseconds. */
  deadlineAtMs?: number;
}

export interface ExecutionScopeIdentity {
  /** Raw opaque host scope. Execution observability must not persist this value. */
  scopeId: string;
  /** Full non-reversible digest retained locally for collision detection. */
  scopeDigestSha256: string;
  /** Stable non-reversible reference safe to expose to the authenticated owner. */
  scopeRef: string;
  adapter: ExecutionScopeAdapter;
}

export function executionScopeDigestSha256(scopeId: string): string {
  return createHash("sha256").update(scopeId).digest("hex");
}

export function executionScopeRef(scopeId: string): string {
  return executionScopeDigestSha256(scopeId).slice(0, 16);
}

export function executorTurnRef(turnId: string): string {
  return createHash("sha256").update(turnId).digest("hex").slice(0, 16);
}

/**
 * Optional provider-neutral assistant-turn identity. A host that can expose one
 * stable value for every tool call in an assistant turn should send this key.
 * Conversation identity must never be substituted for turn identity.
 */
export function executorTurnIdentity(
  meta: unknown,
): ExecutorTurnIdentity | undefined {
  const turnId = metadataString(meta, "devspace/executor-turn");
  return turnId
    ? { turnId, turnRef: executorTurnRef(turnId) }
    : undefined;
}

/**
 * Optional exact host deadline. This is deliberately provider-neutral and is
 * advisory only; it never authorizes DevSpace to block tools or end a task.
 */
export function executorDeadlineAtMs(meta: unknown): number | undefined {
  const epochMs = metadataNumber(meta, "devspace/executor-deadline-ms");
  if (epochMs !== undefined && Number.isSafeInteger(epochMs) && epochMs > 0) {
    return epochMs;
  }

  const iso = metadataString(meta, "devspace/executor-deadline-at");
  if (!iso) return undefined;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function executorTurnMetadata(meta: unknown): ExecutorTurnMetadata {
  return {
    identity: executorTurnIdentity(meta),
    deadlineAtMs: executorDeadlineAtMs(meta),
  };
}

/**
 * Normalize provider-specific conversation metadata at the MCP adapter edge.
 * The core execution-observability model only consumes this identity and does
 * not depend on OpenAI or another host's private session representation.
 */
export function executionScopeIdentity(
  meta: unknown,
): ExecutionScopeIdentity | undefined {
  const genericScope = metadataString(meta, "devspace/execution-scope")
    ?? metadataString(meta, "devspace/executor-window-scope");
  if (genericScope) {
    const scopeDigestSha256 = executionScopeDigestSha256(genericScope);
    return {
      scopeId: genericScope,
      scopeDigestSha256,
      scopeRef: scopeDigestSha256.slice(0, 16),
      adapter: "devspace",
    };
  }

  const openAiScope = openAiConversationScopeId(meta);
  if (!openAiScope) return undefined;
  const scopeDigestSha256 = executionScopeDigestSha256(openAiScope);
  return {
    scopeId: openAiScope,
    scopeDigestSha256,
    scopeRef: scopeDigestSha256.slice(0, 16),
    adapter: "openai",
  };
}
