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

  const seamHandlers = new Map<string, ToolHandler>();
  const assessedRequests: Record<string, unknown>[] = [];
  const verifiedEvidenceRefs: string[][] = [];
  const seamManager = {
    enabled: true,
    assess: async (
      _workspace: unknown,
      request: Record<string, unknown>,
    ) => {
      assessedRequests.push(request);
      return { admission: "verified" };
    },
    verifyPreCommit: async () => ({ checkpoint: "verified" }),
  } as unknown as ZesResearchCycleManager;
  const seamInstrumentManager = {
    plan: async () => ({}),
    record: async () => ({}),
    status: async () => ({}),
    verifyEvidenceRefs: async (_workspace: unknown, refs: string[]) => {
      verifiedEvidenceRefs.push(refs);
      return {
        status: "verified_current_generation",
        evidenceRefs: refs,
      };
    },
  };
  registerZesResearchCycleTools(
    {} as McpServer,
    config,
    seamManager,
    (workspaceId) => ({ workspaceId, root }),
    ((_server: McpServer, name: string, _definition: unknown, handler: ToolHandler) => {
      seamHandlers.set(name, handler);
      return {};
    }) as never,
    {} as never,
    seamInstrumentManager as never,
  );
  const evidenceRef = "research-instrument-evidence:fixture";
  const assessHandler = seamHandlers.get("zes_research_cycle_assess");
  assert.ok(assessHandler);
  const detached = await assessHandler({
    workspaceId: "ws_fixture",
    request: { evidence_refs: [] },
    instrumentEvidenceRefs: [evidenceRef],
  });
  assert.equal(detached.isError, true);
  assert.equal(
    (detached.structuredContent as { data: { code: string } }).data.code,
    "RESEARCH_INSTRUMENT_EVIDENCE_NOT_REFERENCED",
  );
  assert.equal(verifiedEvidenceRefs.length, 0);
  const bound = await assessHandler({
    workspaceId: "ws_fixture",
    request: { evidence_refs: [evidenceRef] },
    instrumentEvidenceRefs: [evidenceRef],
  });
  const boundData = (
    bound.structuredContent as { data: Record<string, unknown> }
  ).data;
  assert.equal(boundData.admission, "verified");
  assert.equal(
    (boundData.instrumentEvidenceVerification as { status: string }).status,
    "verified_current_generation",
  );
  assert.equal(assessedRequests.length, 1);
  assert.deepEqual(verifiedEvidenceRefs, [[evidenceRef]]);
  const autoBound = await assessHandler({
    workspaceId: "ws_fixture",
    request: { evidence_refs: [evidenceRef] },
  });
  assert.equal(autoBound.isError, undefined);
  assert.equal(assessedRequests.length, 2);
  assert.deepEqual(verifiedEvidenceRefs, [[evidenceRef], [evidenceRef]]);

  const preCommitHandler = seamHandlers.get(
    "zes_research_cycle_verify_pre_commit",
  );
  assert.ok(preCommitHandler);
  const missingValidationBinding = await preCommitHandler({
    workspaceId: "ws_fixture",
    validationRefs: ["validation:other"],
    instrumentEvidenceRefs: [evidenceRef],
    challenge: {
      localAuthorityRechecked: true,
      externalCurrentnessRechecked: true,
      dependencyCurrentnessRechecked: true,
      assumptionsRechecked: [],
      counterevidenceOrLimitations: [],
      unresolved: [],
      stoppingReason: "bounded evidence is sufficient",
    },
  });
  assert.equal(missingValidationBinding.isError, true);
  assert.equal(
    (
      missingValidationBinding.structuredContent as {
        data: { code: string };
      }
    ).data.code,
    "RESEARCH_INSTRUMENT_EVIDENCE_NOT_IN_VALIDATION_REFS",
  );
  const autoPreCommit = await preCommitHandler({
    workspaceId: "ws_fixture",
    validationRefs: [evidenceRef],
    challenge: {
      localAuthorityRechecked: true,
      externalCurrentnessRechecked: true,
      dependencyCurrentnessRechecked: true,
      assumptionsRechecked: [],
      counterevidenceOrLimitations: [],
      unresolved: [],
      stoppingReason: "bounded evidence is sufficient",
    },
  });
  const autoPreCommitData = (
    autoPreCommit.structuredContent as { data: Record<string, unknown> }
  ).data;
  assert.equal(autoPreCommitData.checkpoint, "verified");
  assert.equal(
    (
      autoPreCommitData.instrumentEvidenceVerification as {
        status: string;
      }
    ).status,
    "verified_current_generation",
  );

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
