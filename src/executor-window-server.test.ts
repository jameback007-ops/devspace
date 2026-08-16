import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "./config.js";
import { ExecutorWindowRegistry } from "./executor-window.js";
import { ProcessSessionManager } from "./process-sessions.js";
import { createReviewCheckpointManager } from "./review-checkpoints.js";
import { createMcpServer } from "./server.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";
import { WorkspaceRegistry } from "./workspaces.js";

const minute = 60 * 1000;

test("MCP tools auto-begin, enforce drain landing, yield, and later-turn resume", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-executor-window-server-"));
  const project = join(root, "project");
  const stateDir = join(root, ".state");
  await mkdir(project, { recursive: true });
  await writeFile(join(project, "README.md"), "hello\n");

  const config = loadConfig({
    DEVSPACE_CONFIG_DIR: join(root, ".config"),
    DEVSPACE_ALLOWED_ROOTS: root,
    DEVSPACE_AGENT_DIR: join(root, ".agent"),
    DEVSPACE_WIDGETS: "off",
    DEVSPACE_TOOL_MODE: "codex",
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    DEVSPACE_EXECUTOR_WINDOW: "1",
    DEVSPACE_EXECUTOR_WINDOW_DRAIN_MINUTES: "90",
    DEVSPACE_EXECUTOR_WINDOW_YIELD_MINUTES: "100",
    PORT: "1",
  });
  let now = Date.parse("2026-08-16T00:00:00Z");
  const executorWindows = new ExecutorWindowRegistry(config.executorWindow, {
    now: () => now,
  });
  const store = new SqliteWorkspaceStore(stateDir);
  const server = createMcpServer(
    config,
    new WorkspaceRegistry(config, store),
    createReviewCheckpointManager(),
    new ProcessSessionManager(),
    [],
    [],
    executorWindows,
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "executor-window-test-client", version: "1.0.0" });
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  t.after(async () => {
    await client.close();
    await server.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  });

  const tools = await client.listTools();
  assert.ok(tools.tools.some((tool) => tool.name === "executor_window_begin"));
  assert.ok(tools.tools.some((tool) => tool.name === "executor_window_status"));
  assert.ok(tools.tools.some((tool) => tool.name === "executor_window_yield"));
  assert.ok(tools.tools.some((tool) => tool.name === "codex_workspace_git_status"));

  const opened = await callTool(client, "open_workspace", { path: project });
  assert.match(responseText(opened), /\[executor-window\] ACTIVE/);
  const workspaceId = String(
    (opened.structuredContent as Record<string, unknown>).workspaceId,
  );

  now += 100 * minute;
  const blockedPatch = await callTool(client, "apply_patch", {
    workspaceId,
    patch: "*** Begin Patch\n*** End Patch",
  });
  assert.equal(blockedPatch.isError, true);
  assert.match(responseText(blockedPatch), /YIELD_REQUIRED/);

  const read = await callTool(client, "read", {
    workspaceId,
    path: "README.md",
  });
  assert.equal(read.isError, undefined);
  assert.match(responseText(read), /YIELD_REQUIRED/);
  assert.match(
    String((read.structuredContent as Record<string, unknown>).result),
    /YIELD_REQUIRED/,
  );

  const yielded = await callTool(client, "executor_window_yield", {
    summary: "Readback complete; no mutation was started after the landing boundary.",
    nextAction: "Begin a new turn and continue from the existing workspace state.",
    worktreeState: "clean",
    effectState: "none",
    checkpointRefs: ["git:fixture"],
  });
  assert.equal(structuredData(yielded).phase, "yielded");

  const resumedRead = await callTool(client, "read", {
    workspaceId,
    path: "README.md",
  });
  assert.equal(resumedRead.isError, undefined);
  assert.match(responseText(resumedRead), /\[executor-window\] ACTIVE/);

  const resumed = await callTool(client, "executor_window_begin", {
    reason: "new_turn",
  });
  const resumedData = structuredData(resumed);
  assert.equal(resumedData.started, false);
  assert.equal(resumedData.status.phase, "active");
  assert.equal(resumedData.status.generation, 2);
  assert.equal(
    resumedData.previousHandoff.nextAction,
    "Begin a new turn and continue from the existing workspace state.",
  );
});

async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown>,
) {
  return client.callTool({
    name,
    arguments: args,
    _meta: { "openai/session": "conversation-1" },
  } as Parameters<Client["callTool"]>[0]);
}

function responseText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = result.content;
  assert.ok(Array.isArray(content));
  return content
    .filter((item): item is { type: "text"; text: string } => (
      typeof item === "object"
      && item !== null
      && item.type === "text"
      && typeof item.text === "string"
    ))
    .map((item) => item.text)
    .join("\n");
}

function structuredData(
  result: Awaited<ReturnType<Client["callTool"]>>,
): Record<string, any> {
  assert.ok(result.structuredContent);
  const data = (result.structuredContent as Record<string, unknown>).data;
  assert.ok(data && typeof data === "object");
  return data as Record<string, any>;
}
