import { createHash } from "node:crypto";

function metadataString(
  meta: unknown,
  key: string,
): string | undefined {
  if (typeof meta !== "object" || meta === null) return undefined;
  const value = (meta as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function openAiConversationScopeId(
  meta: unknown,
): string | undefined {
  return metadataString(meta, "openai/session");
}

export type ExecutionScopeAdapter = "devspace" | "openai";

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

/**
 * Normalize provider-specific conversation metadata at the MCP adapter edge.
 * The core execution-observability model only consumes this identity and does
 * not depend on OpenAI or another host's private session representation.
 */
export function executionScopeIdentity(
  meta: unknown,
): ExecutionScopeIdentity | undefined {
  const genericScope = metadataString(meta, "devspace/executor-window-scope");
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

/**
 * Resolve a provider-neutral executor-window scope at the MCP adapter edge.
 * Hosts may supply the generic key directly; ChatGPT currently maps its
 * conversation scope into the same runtime contract.
 */
export function executorWindowScopeId(
  meta: unknown,
): string | undefined {
  return executionScopeIdentity(meta)?.scopeId;
}
