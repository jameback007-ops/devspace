import { createConnection } from "node:net";
import type { registerAppTool as registerAppToolType } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import type { ServerConfig } from "./config.js";
import { logEvent } from "./logger.js";

const CODEX_WORKSPACE_READER_SOCKET = "/run/zes-codex-session-reader/session.sock";
const MAX_RESPONSE_BYTES = 1024 * 1024;
const SOCKET_TIMEOUT_MS = 12_000;

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

type AppToolRegistrar = typeof registerAppToolType;

interface WorkspaceReaderEnvelope {
  ok?: boolean;
  error?: string;
  data?: unknown;
}

function resultOutputSchema(): z.ZodRawShape {
  return {
    result: z.string(),
    data: z.unknown(),
  };
}

function toolMeta(config: ServerConfig): { _meta: Record<string, unknown> } {
  if (config.widgets === "off") return { _meta: {} };
  return {
    _meta: {
      ui: {
        resourceUri: "ui://devspace/workspace-app.html",
        visibility: ["model"],
      },
    },
  };
}

async function requestCodexWorkspaceReader(
  request: Record<string, unknown>,
): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    const socket = createConnection({ path: CODEX_WORKSPACE_READER_SOCKET });
    const chunks: Buffer[] = [];
    let size = 0;

    socket.setTimeout(SOCKET_TIMEOUT_MS);
    socket.on("connect", () => socket.end(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_RESPONSE_BYTES) {
        socket.destroy(new Error("Codex workspace reader response exceeded 1 MiB"));
        return;
      }
      chunks.push(chunk);
    });
    socket.on("timeout", () => socket.destroy(new Error("Codex workspace reader timed out")));
    socket.on("error", reject);
    socket.on("end", () => {
      try {
        const envelope = JSON.parse(
          Buffer.concat(chunks).toString("utf8"),
        ) as WorkspaceReaderEnvelope;
        if (!envelope.ok) {
          throw new Error(
            envelope.error || "Codex workspace reader rejected the request",
          );
        }
        resolve(envelope.data);
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function invokeCodexWorkspaceReader(
  request: Record<string, unknown>,
) {
  try {
    const data = await requestCodexWorkspaceReader(request);
    const result = JSON.stringify(data, null, 2);
    return {
      content: [{ type: "text" as const, text: result }],
      structuredContent: { result, data },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: `Codex workspace reader failed: ${message.slice(0, 500)}`,
        },
      ],
    };
  }
}

function logInspection(
  config: ServerConfig,
  tool: string,
  success: boolean,
  startedAt: number,
): void {
  if (!config.logging.toolCalls) return;
  logEvent(config.logging, success ? "info" : "warn", "tool_call", {
    tool,
    success,
    durationMs: Math.round(performance.now() - startedAt),
  });
}

export function registerZesCodexWorkspaceInspectionTools(
  server: McpServer,
  config: ServerConfig,
  registerTool: AppToolRegistrar,
): void {
  registerTool(
    server,
    "codex_workspace_git_status",
    {
      title: "Inspect live AOQ Git status",
      description:
        "Read the branch, exact HEAD, latest commit, porcelain Git status, and diff summary of the exact live AOQ Codex worktree. This reads the active worktree rather than a mirror and cannot mutate it.",
      inputSchema: {},
      outputSchema: resultOutputSchema(),
      ...toolMeta(config),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async () => {
      const startedAt = performance.now();
      const response = await invokeCodexWorkspaceReader({ command: "workspace_status" });
      logInspection(config, "codex_workspace_git_status", !response.isError, startedAt);
      return response;
    },
  );

  registerTool(
    server,
    "codex_workspace_tree",
    {
      title: "List live AOQ worktree",
      description:
        "List files and directories under any relative directory in the exact live AOQ worktree. Hidden worktree assets may be included. Symlinks are listed but never followed, and outside-root paths are rejected.",
      inputSchema: {
        path: z.string().max(4096).optional(),
        depth: z.number().int().min(1).max(6).optional(),
        maxEntries: z.number().int().min(1).max(2000).optional(),
        includeHidden: z.boolean().optional(),
      },
      outputSchema: resultOutputSchema(),
      ...toolMeta(config),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ path, depth, maxEntries, includeHidden }) => {
      const startedAt = performance.now();
      const response = await invokeCodexWorkspaceReader({
        command: "workspace_tree",
        path: path ?? ".",
        depth: depth ?? 2,
        maxEntries: maxEntries ?? 500,
        includeHidden: includeHidden ?? true,
      });
      logInspection(config, "codex_workspace_tree", !response.isError, startedAt);
      return response;
    },
  );

  registerTool(
    server,
    "codex_workspace_read",
    {
      title: "Read a live AOQ worktree file",
      description:
        "Read any text file inside the exact live AOQ Codex worktree with line pagination. Outside-root and symlink-escape paths are rejected, and detected secrets are redacted.",
      inputSchema: {
        path: z.string().min(1).max(4096),
        lineOffset: z.number().int().min(1).optional(),
        lineLimit: z.number().int().min(1).max(5000).optional(),
      },
      outputSchema: resultOutputSchema(),
      ...toolMeta(config),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ path, lineOffset, lineLimit }) => {
      const startedAt = performance.now();
      const response = await invokeCodexWorkspaceReader({
        command: "workspace_read",
        path,
        lineOffset: lineOffset ?? 1,
        lineLimit: lineLimit ?? 500,
      });
      logInspection(config, "codex_workspace_read", !response.isError, startedAt);
      return response;
    },
  );

  registerTool(
    server,
    "codex_workspace_search",
    {
      title: "Search the live AOQ worktree",
      description:
        "Search source, configuration, generated assets, and evidence across the exact live AOQ worktree using ripgrep. Supports regex or fixed strings, path and glob narrowing, hidden files, and optional ignored-file inclusion. Results are redacted and bounded.",
      inputSchema: {
        query: z.string().min(1).max(2000),
        path: z.string().max(4096).optional(),
        glob: z.string().max(500).optional(),
        fixedStrings: z.boolean().optional(),
        caseSensitive: z.boolean().optional(),
        includeIgnored: z.boolean().optional(),
        maxResults: z.number().int().min(1).max(500).optional(),
      },
      outputSchema: resultOutputSchema(),
      ...toolMeta(config),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({
      query,
      path,
      glob,
      fixedStrings,
      caseSensitive,
      includeIgnored,
      maxResults,
    }) => {
      const startedAt = performance.now();
      const response = await invokeCodexWorkspaceReader({
        command: "workspace_search",
        query,
        path: path ?? ".",
        ...(glob ? { glob } : {}),
        fixedStrings: fixedStrings ?? false,
        caseSensitive: caseSensitive ?? true,
        includeIgnored: includeIgnored ?? false,
        maxResults: maxResults ?? 100,
      });
      logInspection(config, "codex_workspace_search", !response.isError, startedAt);
      return response;
    },
  );

  registerTool(
    server,
    "codex_workspace_diff",
    {
      title: "Read the live AOQ Git diff",
      description:
        "Read a paginated Git diff from the exact live AOQ Codex worktree. Select all changes against HEAD, unstaged changes, or staged changes, optionally narrowed to one relative path. This action cannot mutate files.",
      inputSchema: {
        scope: z.enum(["head", "unstaged", "staged"]).optional(),
        path: z.string().max(4096).optional(),
        lineOffset: z.number().int().min(1).optional(),
        lineLimit: z.number().int().min(1).max(5000).optional(),
      },
      outputSchema: resultOutputSchema(),
      ...toolMeta(config),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ scope, path, lineOffset, lineLimit }) => {
      const startedAt = performance.now();
      const response = await invokeCodexWorkspaceReader({
        command: "workspace_diff",
        scope: scope ?? "head",
        ...(path ? { path } : {}),
        lineOffset: lineOffset ?? 1,
        lineLimit: lineLimit ?? 1000,
      });
      logInspection(config, "codex_workspace_diff", !response.isError, startedAt);
      return response;
    },
  );
}
