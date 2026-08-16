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

/**
 * Resolve a provider-neutral executor-window scope at the MCP adapter edge.
 * Hosts may supply the generic key directly; ChatGPT currently maps its
 * conversation scope into the same runtime contract.
 */
export function executorWindowScopeId(
  meta: unknown,
): string | undefined {
  return metadataString(meta, "devspace/executor-window-scope")
    ?? openAiConversationScopeId(meta);
}
