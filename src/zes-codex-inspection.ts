import { createConnection } from "node:net";
import type { registerAppTool as registerAppToolType } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import type { ServerConfig } from "./config.js";
import { logEvent } from "./logger.js";

const CODEX_SESSION_SOCKET = "/run/zes-codex-session-reader/session.sock";
const MAX_RESPONSE_BYTES = 1024 * 1024;
const SOCKET_TIMEOUT_MS = 12_000;

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

type AppToolRegistrar = typeof registerAppToolType;

interface SessionReaderEnvelope {
  ok?: boolean;
  error?: string;
  data?: unknown;
}

type CodexSessionObservationKind = "status" | "tail" | "audit";
type ObservationHealth = "healthy" | "degraded" | "unavailable";
type CapabilityState = "available" | "unavailable" | "unknown" | "not_observed";

export interface CodexSessionAdapterStatus {
  adapterKind: "codex_app_server";
  observationKind: CodexSessionObservationKind;
  overallHealth: ObservationHealth;
  readerTransport: "healthy" | "unavailable";
  appServerTransport: "healthy" | "unavailable" | "not_observed";
  threadLifecycle: string | "unknown" | "not_observed";
  directInput: CapabilityState;
  persistence: "fresh" | "stale" | "unknown";
  devspaceExecutorPlaneImpact: "none";
  interpretation: string;
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

async function requestCodexSessionReader(
  request: Record<string, unknown>,
): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    const socket = createConnection({ path: CODEX_SESSION_SOCKET });
    const chunks: Buffer[] = [];
    let size = 0;

    socket.setTimeout(SOCKET_TIMEOUT_MS);
    socket.on("connect", () => socket.end(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_RESPONSE_BYTES) {
        socket.destroy(new Error("Codex session reader response exceeded 1 MiB"));
        return;
      }
      chunks.push(chunk);
    });
    socket.on("timeout", () => socket.destroy(new Error("Codex session reader timed out")));
    socket.on("error", reject);
    socket.on("end", () => {
      try {
        const envelope = JSON.parse(
          Buffer.concat(chunks).toString("utf8"),
        ) as SessionReaderEnvelope;
        if (!envelope.ok) {
          throw new Error(
            envelope.error || "Codex session reader rejected the request",
          );
        }
        resolve(envelope.data);
      } catch (error) {
        reject(error);
      }
    });
  });
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function sessionFromObservation(data: unknown): Record<string, unknown> | undefined {
  return record(record(data)?.session);
}

export function codexSessionAdapterStatus(
  data: unknown,
  observationKind: CodexSessionObservationKind,
): CodexSessionAdapterStatus {
  if (observationKind !== "status") {
    return {
      adapterKind: "codex_app_server",
      observationKind,
      overallHealth: "healthy",
      readerTransport: "healthy",
      appServerTransport: "not_observed",
      threadLifecycle: "not_observed",
      directInput: "not_observed",
      persistence: "unknown",
      devspaceExecutorPlaneImpact: "none",
      interpretation:
        "The persisted Codex activity reader succeeded. This observation does not test the live App Server or the DevSpace executor plane.",
    };
  }

  const session = sessionFromObservation(data);
  const statusSource = session?.statusSource;
  const appServerTransport = statusSource === "app-server"
    ? "healthy"
    : "unavailable";
  const status = record(session?.status);
  const lifecycle = typeof status?.type === "string" ? status.type : "unknown";
  const directInput = session?.canAcceptDirectInput === true
    ? "available"
    : session?.canAcceptDirectInput === false
      ? "unavailable"
      : "unknown";
  const persistence = session?.recentlyPersisting === true
    ? "fresh"
    : session?.recentlyPersisting === false
      ? "stale"
      : "unknown";
  const overallHealth: ObservationHealth = appServerTransport === "unavailable"
    ? "degraded"
    : lifecycle === "systemError" || lifecycle === "failed"
      ? "degraded"
      : "healthy";

  return {
    adapterKind: "codex_app_server",
    observationKind,
    overallHealth,
    readerTransport: "healthy",
    appServerTransport,
    threadLifecycle: lifecycle,
    directInput,
    persistence,
    devspaceExecutorPlaneImpact: "none",
    interpretation: appServerTransport === "unavailable"
      ? "The read-only session reader is healthy, but it could not observe the live Codex App Server. DevSpace workspace and VPS execution remain independent."
      : lifecycle === "systemError" && directInput === "available"
        ? "The Codex App Server transport is healthy. The observed thread lifecycle reports systemError, while the same thread still accepts direct input; this is a thread state, not a DevSpace or VPS outage."
        : "The Codex App Server transport and read-only adapter are healthy. Thread lifecycle and persistence are reported independently.",
  };
}

export function unavailableCodexSessionAdapterObservation(
  observationKind: CodexSessionObservationKind,
  message: string,
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    scope: "optional-codex-executor-adapter",
    adapterStatus: {
      adapterKind: "codex_app_server",
      observationKind,
      overallHealth: "unavailable",
      readerTransport: "unavailable",
      appServerTransport: "not_observed",
      threadLifecycle: "not_observed",
      directInput: "not_observed",
      persistence: "unknown",
      devspaceExecutorPlaneImpact: "none",
      interpretation:
        "The optional Codex session adapter could not be observed. DevSpace workspace and VPS execution remain independent.",
    } satisfies CodexSessionAdapterStatus,
    adapterError: {
      kind: "codex_session_adapter_unavailable",
      summary: message.slice(0, 500),
    },
  };
}

function attachCodexSessionAdapterStatus(
  data: unknown,
  observationKind: CodexSessionObservationKind,
): Record<string, unknown> {
  const status = codexSessionAdapterStatus(data, observationKind);
  const source = record(data);
  return source
    ? { ...source, adapterStatus: status }
    : {
        schemaVersion: 1,
        scope: "optional-codex-executor-adapter",
        observation: data,
        adapterStatus: status,
      };
}

async function invokeCodexSessionAdapter(
  request: Record<string, unknown>,
  observationKind: CodexSessionObservationKind,
) {
  try {
    const data = attachCodexSessionAdapterStatus(
      await requestCodexSessionReader(request),
      observationKind,
    );
    const result = JSON.stringify(data, null, 2);
    return {
      content: [{ type: "text" as const, text: result }],
      structuredContent: { result, data },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const data = unavailableCodexSessionAdapterObservation(
      observationKind,
      message,
    );
    const result = JSON.stringify(data, null, 2);
    return {
      content: [{ type: "text" as const, text: result }],
      structuredContent: { result, data },
    };
  }
}

async function invokeCodexSessionReader(
  request: Record<string, unknown>,
) {
  try {
    const data = await requestCodexSessionReader(request);
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
          text: `Codex session reader failed: ${message.slice(0, 500)}`,
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

export function registerZesCodexInspectionTools(
  server: McpServer,
  config: ServerConfig,
  registerTool: AppToolRegistrar,
): void {
  registerTool(
    server,
    "codex_session_status",
    {
      title: "Codex AOQ session status",
      description:
        "Read the optional Codex AOQ executor adapter. The result separates reader transport, live App Server transport, thread lifecycle, direct-input capability, and persistence freshness. A degraded Codex thread or adapter does not imply that DevSpace, the VPS, or workspace execution is degraded. This is read-only and accepts no arbitrary thread ID or filesystem path.",
      inputSchema: {},
      outputSchema: resultOutputSchema(),
      ...toolMeta(config),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async () => {
      const startedAt = performance.now();
      const response = await invokeCodexSessionAdapter(
        { command: "status" },
        "status",
      );
      logInspection(config, "codex_session_status", true, startedAt);
      return response;
    },
  );

  registerTool(
    server,
    "codex_session_tail",
    {
      title: "Read recent Codex AOQ session activity",
      description:
        "Read a bounded, newest-first view from the persisted allowlisted Codex AOQ rollout. This path does not test or control the live App Server and has no effect on DevSpace workspace execution. Use view=messages for transcript text, combined for transcript plus lifecycle/tool metadata, or audit for redacted observable tool inputs/results. Internal reasoning and detected secrets remain excluded.",
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional(),
        cursor: z.string().max(24).optional(),
        view: z.enum(["messages", "combined", "audit"]).optional(),
      },
      outputSchema: resultOutputSchema(),
      ...toolMeta(config),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ limit, cursor, view }) => {
      const startedAt = performance.now();
      const response = await invokeCodexSessionAdapter(
        {
          command: "tail",
          limit: limit ?? 20,
          view: view ?? "combined",
          ...(cursor ? { cursor } : {}),
        },
        "tail",
      );
      logInspection(config, "codex_session_tail", true, startedAt);
      return response;
    },
  );

  registerTool(
    server,
    "codex_session_audit",
    {
      title: "Audit the live Codex AOQ session",
      description:
        "Read a deep, paginated, newest-first audit view from the persisted allowlisted Codex AOQ rollout, including visible transcript, redacted commands/tool results, file-change events, web/MCP results, lifecycle events, and errors. This path does not test or control the live App Server and cannot affect DevSpace workspace execution. Internal reasoning and detected secrets remain excluded.",
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional(),
        cursor: z.string().max(24).optional(),
      },
      outputSchema: resultOutputSchema(),
      ...toolMeta(config),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ limit, cursor }) => {
      const startedAt = performance.now();
      const response = await invokeCodexSessionAdapter(
        {
          command: "tail",
          limit: limit ?? 20,
          view: "audit",
          ...(cursor ? { cursor } : {}),
        },
        "audit",
      );
      logInspection(config, "codex_session_audit", true, startedAt);
      return response;
    },
  );

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
      const response = await invokeCodexSessionReader({ command: "workspace_status" });
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
      const response = await invokeCodexSessionReader({
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
      const response = await invokeCodexSessionReader({
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
      const response = await invokeCodexSessionReader({
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
      const response = await invokeCodexSessionReader({
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
