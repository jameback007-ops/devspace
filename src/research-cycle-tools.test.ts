import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadConfig } from "./config.js";
import { ZesResearchCycleManager } from "./research-cycle.js";
import {
  registerZesResearchCycleTools,
  ZES_RESEARCH_CYCLE_TOOL_NAMES,
} from "./research-cycle-tools.js";

type ToolHandler = (
  input: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

const root = mkdtempSync(join(tmpdir(), "devspace-research-cycle-tools-"));
try {
  const config = loadConfig({
    DEVSPACE_CONFIG_DIR: join(root, ".config"),
    DEVSPACE_ALLOWED_ROOTS: root,
    DEVSPACE_STATE_DIR: join(root, ".state"),
    DEVSPACE_WORKTREE_ROOT: join(root, ".worktrees"),
    DEVSPACE_ZES_RESEARCH_CYCLE_MODE: "observe",
    DEVSPACE_ZES_RESEARCH_REPOSITORY_ROOT: root,
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
  });
  const manager = new ZesResearchCycleManager(config.zesResearchCycle);
  const handlers = new Map<string, ToolHandler>();
  const definitions = new Map<string, Record<string, unknown>>();
  const registerTool = (
    _server: McpServer,
    name: string,
    definition: Record<string, unknown>,
    handler: ToolHandler,
  ) => {
    definitions.set(name, definition);
    handlers.set(name, handler);
    return {};
  };

  registerZesResearchCycleTools(
    {} as McpServer,
    config,
    manager,
    (workspaceId) => ({ workspaceId, root }),
    registerTool as never,
  );

  assert.deepEqual(
    [...handlers.keys()].sort(),
    [...ZES_RESEARCH_CYCLE_TOOL_NAMES].sort(),
  );
  for (const name of ZES_RESEARCH_CYCLE_TOOL_NAMES) {
    assert.ok(definitions.get(name)?.inputSchema);
    assert.ok(definitions.get(name)?.outputSchema);
  }

  const statusHandler = handlers.get("zes_research_cycle_status");
  assert.ok(statusHandler);
  const response = await statusHandler({ workspaceId: "ws_fixture" });
  const structured = response.structuredContent as {
    data?: Record<string, unknown>;
  };
  assert.equal(structured.data?.managed, false);
  assert.equal(structured.data?.mode, "observe");

  const disabledConfig = loadConfig({
    DEVSPACE_CONFIG_DIR: join(root, ".disabled-config"),
    DEVSPACE_ALLOWED_ROOTS: root,
    DEVSPACE_STATE_DIR: join(root, ".disabled-state"),
    DEVSPACE_WORKTREE_ROOT: join(root, ".disabled-worktrees"),
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
  });
  const disabledHandlers = new Map<string, ToolHandler>();
  registerZesResearchCycleTools(
    {} as McpServer,
    disabledConfig,
    new ZesResearchCycleManager(disabledConfig.zesResearchCycle),
    (workspaceId) => ({ workspaceId, root }),
    ((_server: McpServer, name: string, _definition: unknown, handler: ToolHandler) => {
      disabledHandlers.set(name, handler);
      return {};
    }) as never,
  );
  assert.equal(disabledHandlers.size, 0);

  console.log("research cycle tool registration tests passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
