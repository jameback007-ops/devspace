import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig, type ServerConfig } from "./config.js";
import type { ConversationTransportBridgePort } from "./conversation-transport-bridge-client.js";
import {
  CONVERSATION_TRANSPORT_BRIDGE_AUTHORITY,
  type ConversationBridgeTargetStatus,
} from "./conversation-transport-bridge-protocol.js";
import { ConversationTransportRuntime } from "./conversation-transport-tools.js";
import { ExecutionScopeManager } from "./execution-observability.js";
import {
  LocalAgentCoordinator,
  type LocalAgentCoordinatorOptions,
} from "./local-agent-coordinator.js";
import { createReviewCheckpointManager } from "./review-checkpoints.js";
import { ProcessSessionManager } from "./process-sessions.js";
import { RuntimeCapabilityRegistry } from "./runtime-capabilities.js";
import { createMcpServer } from "./server.js";
import { createToolSurfaceIdentity } from "./tool-surface-freshness.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";
import { WorkspaceRegistry } from "./workspaces.js";
import type {
  ZesContinuationPreflightProjectionSource,
} from "./zes-continuation-preflight.js";
import type {
  ScopePublicationPreflightSource,
} from "./scope-publication-preflight.js";

const execFileAsync = promisify(execFile);

test("runtime fingerprint exactly matches the SDK tools/list descriptors", async (t) => {
  const context = await fixture(t, {
    toolMode: "codex",
    codexNavigationTools: true,
    subagents: true,
    runtimeCapabilities: true,
  });
  const listed = await context.client.listTools();
  const expected = createToolSurfaceIdentity(listed.tools);
  assert.deepEqual(
    context.runtimeCapabilities!.descriptors(),
    listed.tools,
    "registry descriptors must be the exact SDK tools/list descriptors",
  );
  const snapshot = context.runtimeCapabilities!.snapshot();
  const toolSurface = snapshot.toolSurface as Record<string, unknown>;

  assert.equal(toolSurface.fingerprintSha256, expected.fingerprintSha256);
  assert.equal(toolSurface.toolCount, expected.toolCount);
  assert.deepEqual(toolSurface.toolNames, expected.toolNames);
  assert.equal(
    toolSurface.fingerprintBasis,
    "canonical_complete_mcp_tools_list_descriptors",
  );
  assert.ok(
    listed.tools.every((tool) => tool.execution?.taskSupport === "forbidden"),
    "the attested descriptors must include the SDK execution contract",
  );
  assert.equal(
    context.client.getServerVersion()?.version,
    context.config.mcpServerVersion,
  );
});

test("conversation transport tools expose fixed aliases and direct-first status without raw targets", async (t) => {
  const context = await fixture(t, {
    runtimeCapabilities: true,
    conversationTransport: {
      bridge: fixedConversationBridge(),
    },
  });
  const listed = await context.client.listTools();
  const names = new Set(listed.tools.map((tool) => tool.name));
  for (const name of [
    "conversation_transport_bind",
    "conversation_transport_status",
    "execution_wake_pending_record",
    "execution_wake_status",
    "execution_wake_assess",
    "execution_wake_execute",
    "execution_wake_reconcile",
  ]) {
    assert.ok(names.has(name), `missing ${name}`);
  }
  const bindTool = listed.tools.find((tool) => tool.name === "conversation_transport_bind");
  const bindSchema = JSON.stringify(bindTool?.inputSchema ?? {});
  assert.equal(bindSchema.includes("threadId"), false);
  assert.equal(bindSchema.includes("conversationUrl"), false);
  assert.equal(bindSchema.includes("prompt"), false);

  const bound = await context.client.callTool({
    name: "conversation_transport_bind",
    arguments: {
      targetExecutionScopeRef: "1234567890abcdef",
      missionRef: "mission:server-transport-test",
      targetAlias: "codex-canary",
    },
    _meta: { "devspace/execution-scope": "server-transport-test" },
  } as Parameters<Client["callTool"]>[0]);
  assert.equal(structuredData(bound).binding.targetAlias, "codex-canary");
  assert.equal("threadId" in structuredData(bound).binding, false);

  const status = await context.client.callTool({
    name: "conversation_transport_status",
    arguments: {
      targetExecutionScopeRef: "1234567890abcdef",
      missionRef: "mission:server-transport-test",
    },
    _meta: { "devspace/execution-scope": "server-transport-test" },
  } as Parameters<Client["callTool"]>[0]);
  assert.equal(structuredData(status).route.state, "selected");
  assert.equal(structuredData(status).route.selected.kind, "native_rpc");

  const snapshot = context.runtimeCapabilities!.snapshot();
  const surface = snapshot.toolSurface as Record<string, any>;
  assert.equal(
    surface.criticalToolGroups.conversationTransport.registrationState,
    "complete",
  );
  assert.equal(surface.configuration.conversationTransportEnabled, true);
  assert.equal(surface.configuration.conversationTransportEffectsEnabled, false);
});

test("open_workspace keeps lifecycle flags out of model output and preserves complete card metadata", async (t) => {
  const context = await fixture(t);
  const first = await callOpen(context.client, context.project, "chat-1");
  const repeated = await callOpen(context.client, context.project, "chat-1");

  const tools = await context.client.listTools();
  const openTool = tools.tools.find((tool) => tool.name === "open_workspace");
  const outputProperties = (openTool?.outputSchema as { properties?: Record<string, unknown> } | undefined)?.properties;
  assert.equal(outputProperties && "workspaceReused" in outputProperties, false);
  assert.equal(outputProperties && "includeBootstrapContext" in outputProperties, false);

  const firstStructured = structuredContent(first);
  assert.equal(firstStructured.workspaceId, structuredContent(repeated).workspaceId);
  assert.ok(Array.isArray(firstStructured.agentsFiles));
  assert.ok(Array.isArray(firstStructured.availableAgentsFiles));
  assert.ok(Array.isArray(firstStructured.skills));
  assert.ok(Array.isArray(firstStructured.agentProviders));
  assert.ok(Array.isArray(firstStructured.agents));
  assert.ok(Array.isArray(firstStructured.skillDiagnostics));
  assert.equal("workspaceReused" in firstStructured, false);
  assert.equal("includeBootstrapContext" in firstStructured, false);

  const repeatedStructured = structuredContent(repeated);
  assert.equal(repeatedStructured.agentsFiles, undefined);
  assert.equal(repeatedStructured.availableAgentsFiles, undefined);
  assert.equal(repeatedStructured.skills, undefined);
  assert.equal(repeatedStructured.agentProviders, undefined);
  assert.equal(repeatedStructured.agents, undefined);
  assert.equal(repeatedStructured.skillDiagnostics, undefined);
  assert.equal("workspaceReused" in repeatedStructured, false);
  assert.equal("includeBootstrapContext" in repeatedStructured, false);

  const card = responseCard(repeated);
  assert.equal(card.workspaceReused, true);
  assert.equal(card.includeBootstrapContext, false);
  assert.ok(Array.isArray(card.agentsFiles));
  assert.ok(Array.isArray(card.availableAgentsFiles));
  assert.ok(Array.isArray(card.skills));
  assert.ok(Array.isArray(card.agentProviders));
  assert.ok(Array.isArray(card.agents));
});

test("open_workspace returns only root context when the nested instruction inventory is too large", async (t) => {
  const context = await fixture(t);
  for (let index = 0; index < 101; index += 1) {
    const directory = join(context.project, `nested-${index}`);
    await mkdir(directory);
    await writeFile(join(directory, "AGENTS.md"), "nested instructions\n");
  }

  const result = await callOpen(context.client, context.project, "chat-1");
  const structured = structuredContent(result);
  const card = responseCard(result);

  assert.ok(Array.isArray(structured.agentsFiles));
  assert.equal(structured.availableAgentsFiles, undefined);
  assert.deepEqual(structured.instructionDiscovery, {
    status: "incomplete",
    reason: "result_limit_exceeded",
  });
  assert.equal(card.availableAgentsFiles, undefined);
  assert.deepEqual(card.instructionDiscovery, structured.instructionDiscovery);
  assert.match(responseText(result), /Only global and root-level instructions are loaded/);
  assert.match(responseText(result), /Open the specific project directory/);
});

test("codex write_stdin exposes the output-aware long-poll contract", async (t) => {
  const context = await fixture(t, { toolMode: "codex" });
  const tools = await context.client.listTools();
  assert.deepEqual(
    tools.tools
      .map((tool) => tool.name)
      .filter((name) => name.startsWith("executor_window_")),
    [],
  );
  const writeTool = tools.tools.find((tool) => tool.name === "write_stdin");
  assert.ok(writeTool);
  assert.match(writeTool.description ?? "", /new output arrives or the process exits/i);

  const properties = (writeTool.inputSchema as {
    properties?: Record<string, Record<string, unknown>>;
  }).properties;
  const yieldTimeMs = properties?.yieldTimeMs;
  assert.equal(yieldTimeMs?.maximum, 110_000);
  assert.match(String(yieldTimeMs?.description), /defaults to 90000/i);
  assert.match(String(yieldTimeMs?.description), /bounded to 30000/i);
});

test("codex mode can opt into the upstream native navigation tools", async (t) => {
  const disabled = await fixture(t, { toolMode: "codex", git: true });
  const disabledTools = await disabled.client.listTools();
  for (const name of ["grep", "glob", "ls"]) {
    assert.equal(
      disabledTools.tools.some((tool) => tool.name === name),
      false,
      `${name} should remain opt-in in codex mode`,
    );
  }

  const enabled = await fixture(t, {
    toolMode: "codex",
    git: true,
    codexNavigationTools: true,
  });
  const enabledTools = await enabled.client.listTools();
  for (const name of ["grep", "glob", "ls"]) {
    const tool = enabledTools.tools.find((candidate) => candidate.name === name);
    assert.ok(tool, `${name} should be registered`);
    assert.equal(tool.annotations?.readOnlyHint, true);
  }

  const opened = await callOpen(enabled.client, enabled.project, "codex-navigation");
  const workspaceId = String(structuredContent(opened).workspaceId);
  const grep = await enabled.client.callTool({
    name: "grep",
    arguments: { workspaceId, pattern: "hello", path: "README.md" },
  });
  assert.match(responseText(grep), /README\.md/);

  const glob = await enabled.client.callTool({
    name: "glob",
    arguments: { workspaceId, pattern: "*.md" },
  });
  assert.match(responseText(glob), /README\.md/);

  const ls = await enabled.client.callTool({
    name: "ls",
    arguments: { workspaceId, path: "." },
  });
  assert.match(responseText(ls), /README\.md/);
});

test("enforced ZES research cycle is registered and holds mutation before admission", async (t) => {
  const context = await fixture(t, {
    toolMode: "codex",
    git: true,
    zesResearchCycleMode: "enforce",
    runtimeCapabilities: true,
  });
  const tools = await context.client.listTools();
  const researchTools = tools.tools
    .map((tool) => tool.name)
    .filter((name) => name.startsWith("zes_research_cycle_"))
    .sort();
  assert.deepEqual(researchTools, [
    "zes_research_cycle_assess",
    "zes_research_cycle_close",
    "zes_research_cycle_invalidate",
    "zes_research_cycle_open",
    "zes_research_cycle_prepare",
    "zes_research_cycle_status",
    "zes_research_cycle_verify_pre_commit",
  ]);

  const runtime = context.runtimeCapabilities!.snapshot();
  const surface = runtime.toolSurface as Record<string, unknown>;
  const groups = surface.criticalToolGroups as Record<
    string,
    Record<string, unknown>
  >;
  assert.equal(groups.zesResearchCycle?.configured, true);
  assert.equal(groups.zesResearchCycle?.registeredComplete, true);
  assert.equal(groups.zesResearchCycle?.available, true);

  const opened = await callOpen(
    context.client,
    context.project,
    "research-cycle-enforce",
  );
  const workspaceId = String(structuredContent(opened).workspaceId);
  const blocked = await context.client.callTool({
    name: "apply_patch",
    arguments: {
      workspaceId,
      patch: [
        "*** Begin Patch",
        "*** Update File: README.md",
        "@@",
        "-hello",
        "+mutated",
        "*** End Patch",
      ].join("\n"),
    },
  });
  assert.equal(blocked.isError, true);
  assert.match(responseText(blocked), /ZES_RESEARCH_CYCLE_GUARD_HELD/);
  assert.match(responseText(blocked), /research_cycle_not_opened/);
  assert.equal(await readFile(join(context.project, "README.md"), "utf8"), "hello\n");

  const status = await context.client.callTool({
    name: "zes_research_cycle_status",
    arguments: { workspaceId },
  });
  assert.equal(structuredData(status).managed, true);
  assert.equal(structuredData(status).stateExists, false);
});

test("turn continuity is advisory-only and recovery capsules detect later workspace changes", async (t) => {
  const context = await fixture(t, { toolMode: "codex", git: true });
  const session = "turn-continuity-session";
  const opened = await callOpen(context.client, context.project, session);
  const workspaceId = String(structuredContent(opened).workspaceId);
  const tools = await context.client.listTools();

  for (const name of [
    "turn_horizon_begin",
    "turn_horizon_status",
    "recovery_capsule_record",
    "recovery_capsule_status",
  ]) {
    assert.ok(tools.tools.find((tool) => tool.name === name), `${name} should be registered`);
  }
  assert.equal(
    tools.tools.some((tool) => tool.name.startsWith("executor_window_")),
    false,
  );
  assert.match(
    tools.tools.find((tool) => tool.name === "turn_horizon_begin")?.description ?? "",
    /never blocks tools/i,
  );
  assert.equal(
    tools.tools.find((tool) => tool.name === "turn_horizon_status")
      ?.annotations?.readOnlyHint,
    false,
  );

  const begun = await context.client.callTool({
    name: "turn_horizon_begin",
    arguments: {
      idempotencyKey: "server-turn-1",
      reason: "new_turn",
    },
    _meta: { "openai/session": session },
  } as Parameters<Client["callTool"]>[0]);
  const begunStatus = structuredData(begun).status as Record<string, unknown>;
  assert.equal(begunStatus.toolsBlocked, false);
  assert.equal(begunStatus.taskCompletionRequired, false);

  const adoptionProbe = await context.client.callTool({
    name: "apply_patch",
    arguments: {
      workspaceId,
      patch: [
        "*** Begin Patch",
        "*** Add File: adoption.txt",
        "+semantic recovery adoption probe",
        "*** End Patch",
      ].join("\n"),
    },
    _meta: { "openai/session": session },
  } as Parameters<Client["callTool"]>[0]);
  assert.match(responseAllText(adoptionProbe), /recovery capsule available/i);
  assert.match(
    responseAllText(adoptionProbe),
    /Continue the current causal chain normally/i,
  );

  const noRepeatedNudge = await context.client.callTool({
    name: "read",
    arguments: { workspaceId, path: "README.md" },
    _meta: { "openai/session": session },
  } as Parameters<Client["callTool"]>[0]);
  assert.equal(
    /recovery capsule available/i.test(responseAllText(noRepeatedNudge)),
    false,
  );

  const recorded = await context.client.callTool({
    name: "recovery_capsule_record",
    arguments: {
      workspaceId,
      idempotencyKey: "server-capsule-1",
      intent: "rolling",
      missionRef: "TEST-MISSION",
      authorityOwnerRefs: ["owner:git-main"],
      authorityStateRefs: ["git-main:initial"],
      currentFrontier: "preserve current work",
      currentCausalSlice: "record the clean initial checkpoint",
      established: ["initial commit exists"],
      validationState: "passed",
      validationRefs: ["git:HEAD"],
      worktreeState: "intentional_dirty",
      effectState: "none",
      writerState: "none",
      retryPolicy: "normal",
      safeToMutate: true,
      safeToPublish: false,
      exactNextAction: "edit README.md",
      doNotRepeat: [],
      unresolved: [],
      checkpointRefs: ["git:HEAD"],
    },
    _meta: { "openai/session": session },
  } as Parameters<Client["callTool"]>[0]);
  assert.equal(structuredData(recorded).recorded, true);

  const fresh = await context.client.callTool({
    name: "recovery_capsule_status",
    arguments: {
      workspaceId,
      currentAuthorityStateRefs: ["git-main:initial"],
    },
    _meta: { "openai/session": session },
  } as Parameters<Client["callTool"]>[0]);
  assert.equal(structuredData(fresh).workspaceFreshness, "fresh");
  assert.equal(
    structuredData(fresh).authorityFreshness,
    "matched_supplied_refs",
  );
  assert.equal(structuredData(fresh).exactActionCandidateAvailable, true);

  await context.client.callTool({
    name: "apply_patch",
    arguments: {
      workspaceId,
      patch: [
        "*** Begin Patch",
        "*** Update File: README.md",
        "@@",
        "-hello",
        "+hello changed",
        "*** End Patch",
      ].join("\n"),
    },
    _meta: { "openai/session": session },
  } as Parameters<Client["callTool"]>[0]);

  const stale = await context.client.callTool({
    name: "recovery_capsule_status",
    arguments: { workspaceId },
    _meta: { "openai/session": session },
  } as Parameters<Client["callTool"]>[0]);
  const staleData = structuredData(stale);
  assert.equal(staleData.workspaceFreshness, "stale");
  assert.equal(staleData.exactActionCandidateAvailable, false);
  assert.ok(
    (staleData.workspaceStaleReasons as string[]).includes("tracked_content_changed"),
  );

  const boundary = await context.client.callTool({
    name: "recovery_capsule_record",
    arguments: {
      workspaceId,
      idempotencyKey: "server-capsule-turn-boundary",
      intent: "turn_boundary",
      missionRef: "TEST-MISSION",
      authorityOwnerRefs: ["owner:git-main"],
      authorityStateRefs: ["git-main:initial"],
      currentFrontier: "continue the same test mission next turn",
      currentCausalSlice: "preserve the intentional dirty state",
      established: ["workspace change is intentional"],
      validationState: "partial",
      validationRefs: ["validation:focused:partial"],
      worktreeState: "intentional_dirty",
      effectState: "none",
      writerState: "none",
      retryPolicy: "normal",
      safeToMutate: true,
      safeToPublish: false,
      exactNextAction: "continue the same source slice",
      doNotRepeat: [],
      unresolved: ["complete focused validation"],
      checkpointRefs: ["git:HEAD"],
    },
    _meta: { "openai/session": session },
  } as Parameters<Client["callTool"]>[0]);
  assert.equal(structuredData(boundary).recorded, true);
  const boundaryLanding = structuredData(boundary).landing as Record<string, unknown>;
  assert.equal(boundaryLanding.sameMissionContinuationExpected, true);
  assert.equal(
    boundaryLanding.classification,
    "automatic_envelope_with_fresh_semantic_capsule",
  );

  const horizonStatus = await context.client.callTool({
    name: "turn_horizon_status",
    arguments: {},
    _meta: { "openai/session": session },
  } as Parameters<Client["callTool"]>[0]);
  const horizonData = structuredData(horizonStatus).status as Record<string, unknown>;
  assert.equal(horizonData.sealed, true);
  assert.equal(horizonData.toolsBlocked, false);
  assert.ok(horizonData.instability);
  assert.ok(horizonData.landing);

  const scopeStatus = await context.client.callTool({
    name: "execution_scope_status",
    arguments: {},
    _meta: { "openai/session": session },
  } as Parameters<Client["callTool"]>[0]);
  const scopeTurnLanding = structuredData(scopeStatus).turnLanding as Record<string, unknown>;
  assert.equal(scopeTurnLanding.sameMissionContinuationExpected, true);
  assert.equal(
    scopeTurnLanding.classification,
    "automatic_envelope_with_fresh_semantic_capsule",
  );
  assert.equal(
    (scopeTurnLanding.policy as Record<string, unknown>)
      .writerEffectOrPublicationAuthorityGranted,
    false,
  );
});

test("workspace skills are contextual by default and host skills stay searchable", async (t) => {
  const context = await fixture(t, {
    toolMode: "codex",
    skillFixtures: true,
  });
  const opened = await callOpen(context.client, context.project, "skill-scope");
  const workspaceId = String(structuredContent(opened).workspaceId);
  const initialSkills = structuredContent(opened).skills as
    | Array<Record<string, unknown>>
    | undefined;
  assert.equal(
    initialSkills?.some((skill) => skill.name === "project-helper"),
    true,
  );
  assert.equal(
    initialSkills?.some((skill) => skill.name === "host-specialist"),
    false,
  );
  assert.ok(context.hostSkillPath);

  const blockedRead = await context.client.callTool({
    name: "read",
    arguments: { workspaceId, path: context.hostSkillPath },
    _meta: { "openai/session": "skill-scope" },
  } as Parameters<Client["callTool"]>[0]);
  assert.equal(blockedRead.isError, true);

  const tools = await context.client.listTools();
  const searchTool = tools.tools.find((tool) => tool.name === "skill_search");
  assert.ok(searchTool);
  assert.equal(searchTool.annotations?.readOnlyHint, true);

  const searched = await context.client.callTool({
    name: "skill_search",
    arguments: {
      workspaceId,
      query: "host specialist procedure",
    },
    _meta: { "openai/session": "skill-scope" },
  } as Parameters<Client["callTool"]>[0]);
  const searchData = structuredContent(searched);
  const searchedSkills = searchData.skills as Array<Record<string, unknown>>;
  assert.deepEqual(
    searchedSkills.map((skill) => skill.name),
    ["host-specialist"],
  );

  const loaded = await context.client.callTool({
    name: "read",
    arguments: {
      workspaceId,
      path: String(searchedSkills[0]?.path),
    },
    _meta: { "openai/session": "skill-scope" },
  } as Parameters<Client["callTool"]>[0]);
  assert.equal(loaded.isError, undefined);
  assert.match(responseText(loaded), /Host Specialist/);
});

test("skill search is absent when skills are disabled", async (t) => {
  const context = await fixture(t, {
    toolMode: "codex",
    skillsEnabled: false,
  });
  const tools = await context.client.listTools();
  assert.equal(
    tools.tools.some((tool) => tool.name === "skill_search"),
    false,
  );
});

test("a fresh current host scope can inspect status before any audited executor tool", async (t) => {
  const context = await fixture(t, { toolMode: "codex" });
  const freshSession = "fresh-status-only-session";

  const status = await context.client.callTool({
    name: "execution_scope_status",
    arguments: {},
    _meta: { "openai/session": freshSession },
  } as Parameters<Client["callTool"]>[0]);
  assert.equal(status.isError, undefined);
  const statusData = structuredData(status);
  const statusScope = statusData.scope as Record<string, unknown>;
  assert.equal(statusScope.isCurrent, true);
  assert.equal(statusScope.materialized, false);
  assert.equal(statusScope.activityState, "unobserved");
  assert.equal(statusScope.totalEventCount, 0);
  assert.deepEqual(statusData.workspaces, []);
  assert.deepEqual(statusData.processes, []);

  const listed = await context.client.callTool({
    name: "execution_scope_list",
    arguments: { limit: 10 },
    _meta: { "openai/session": freshSession },
  } as Parameters<Client["callTool"]>[0]);
  const listedScopes = structuredData(listed).scopes as Array<Record<string, unknown>>;
  const current = listedScopes.find((scope) => scope.isCurrent === true);
  assert.ok(current);
  assert.equal(current.materialized, false);

  const audit = await context.client.callTool({
    name: "execution_scope_audit",
    arguments: { limit: 10 },
    _meta: { "openai/session": freshSession },
  } as Parameters<Client["callTool"]>[0]);
  const auditData = structuredData(audit);
  assert.equal(auditData.currentScopeMaterialized, false);
  assert.deepEqual(auditData.events, []);
});

test("execution-scope status carries the stable continuation control plane without new tool discovery", async (t) => {
  let projectionCalls = 0;
  const projectionRequests: unknown[] = [];
  let scopePublicationCalls = 0;
  const continuationPreflightProjector: ZesContinuationPreflightProjectionSource = {
    project: async (request) => {
      projectionCalls += 1;
      projectionRequests.push(structuredClone(request));
      return {
        schemaVersion: 1,
        capabilityRef: "zes.continuation.preflight.v2",
        status: "available",
        projectionRef: "zes-control-plane://continuation/test",
        route: "execution_scope_status_embedded_control_plane",
        directToolName: "zes_continuation_preflight",
        observedAt: "2026-08-18T07:00:00.000Z",
        freshUntil: "2026-08-18T07:00:05.000Z",
        sourceExpiresAt: "2026-08-18T07:01:00.000Z",
        preflight: {
          schema_version: "zes.continuation-control-preflight.v2",
          publication_disposition: "eligible",
          safe_to_publish: true,
        },
        decisions: {
          inspect: {
            intent: "inspect",
            disposition: "allowed",
            actionAllowed: true,
          },
          prepare_isolated_candidate: {
            intent: "prepare_isolated_candidate",
            disposition: "allowed",
            actionAllowed: true,
          },
          mutate_governed_checkout: {
            intent: "mutate_governed_checkout",
            disposition: "allowed",
            actionAllowed: true,
          },
          publish_repository: {
            intent: "publish_repository",
            disposition: "allowed",
            actionAllowed: true,
          },
          runtime_takeover_or_effect_retry: {
            intent: "runtime_takeover_or_effect_retry",
            disposition: "reconciliation_clear",
            actionAllowed: false,
          },
        },
        refresh: {
          status: "refreshed",
          receiptDigestSha256: "a".repeat(64),
          snapshotSha256: "b".repeat(64),
          sourceControlPreflight: {
            publication_disposition: "eligible",
          },
        },
        policy: {
          authority:
            "fixed_live_ZES_continuation_readback_without_new_tool_discovery",
          readOnly: true,
          fixedRoute: true,
          arbitraryCredentialPathAccepted: false,
          arbitraryRepositoryPathAccepted: false,
          directToolDiscoveryRequired: false,
          clientCatalogFreshnessRequiredForReadback: false,
          catalogStalenessDoesNotEstablishWriterUncertainty: true,
          cacheIsReadOptimizationOnly: true,
          cacheDoesNotGrantAuthority: true,
          downstreamEffectGateMustRevalidate: true,
          repositoryFastPathMayDeferAutomaticRefresh: true,
          canonicalOrProviderStateMutated: false,
          newWriterPublicationTakeoverOrEffectAuthorityGranted: false,
        },
      };
    },
  };
  const scopePublicationPreflight: ScopePublicationPreflightSource = {
    assess: async ({ continuationPreflight }) => {
      scopePublicationCalls += 1;
      return {
        schemaVersion: 1,
        capabilityRef: "zes.scope-publication.preflight.v1",
        status: "available",
        assessedAt: "2026-08-18T07:00:00.500Z",
        continuationProjectionRef: continuationPreflight.projectionRef,
        authoritativeRemoteMainSha: "1".repeat(40),
        candidateCount: 1,
        ignoredWorkspaceCount: 0,
        inspectionFailureCount: 0,
        candidates: [
          {
            schemaVersion: 1,
            workspaceId: "ws_candidate",
            disposition: "eligible",
            safeToPublish: true,
            publicationRequired: true,
            candidateHeadSha: "2".repeat(40),
            authoritativeRemoteMainSha: "1".repeat(40),
            localOriginMainSha: "1".repeat(40),
            branchName: "agent/candidate",
            aheadCount: 1,
            behindCount: 0,
            dirtyPathCount: 0,
            publicationControlsFailClosed: true,
            validationBoundToCandidate: true,
            validationEvidenceAuthority:
              "executor_local_git_bound_recovery_capsule",
            validationEvidenceRevalidationRequired: true,
            fullValidationRerunRequired: false,
            evidenceProfile: {
              requiredEvidence: ["test:required"],
              skippedEvidence: [
                {
                  evidence: "test:runtime",
                  reasonCode: "test:unrelated",
                },
              ],
            },
            blockingFactors: [],
            evidenceRefs: ["test:scope-publication"],
            expectedPublication: {
              remoteName: "origin",
              remoteRef: "refs/heads/main",
              refspec: `${"2".repeat(40)}:refs/heads/main`,
              expectedOldSha: "1".repeat(40),
              compareAndSwapRequired: true,
              remoteReadbackRequired: true,
              effectGateMustRevalidateCandidateAndAuthority: true,
              validationMustBeRevalidatedBeforeEffect: true,
              validationReceiptMayBeReusedWhenHeadUnchanged: true,
              fullValidationRerunRequired: false,
              localPrePushHookRequired: false,
            },
          },
        ],
        policy: {
          authority:
            "scope_linked_git_readback_with_fixed_remote_authority",
          inputWorkspaceSource: "execution_scope_registry_only",
          arbitraryWorkspacePathAccepted: false,
          remoteMainAuthoritySource:
            "fresh_fixed_repository_git_ls_remote",
          localOriginTrackingIsRemoteAuthority: false,
          runtimeReconciliationBlocksUnrelatedSourcePublication: false,
          candidateValidationCheckpointRequired: true,
          capsuleValidationIsPublicationAuthority: false,
          effectGateMustRevalidateValidationAndGit: true,
          unrelatedRuntimeWriterStateIsAdvisoryOnly: true,
          branchTrackingAndLocalHookAreNotPublicationAuthority: true,
          exactHeadBoundValidationReceiptMayBeReused: true,
          publicationEffectPerformed: false,
          publicationAuthorityGranted: false,
          compareAndSwapAndRemoteReadbackRequired: true,
        },
      };
    },
  };
  const context = await fixture(t, {
    toolMode: "codex",
    zesResearchCycleMode: "enforce",
    runtimeCapabilities: true,
    continuationPreflightProjector,
    scopePublicationPreflight,
  });

  const tools = await context.client.listTools();
  assert.ok(
    tools.tools.some((tool) => tool.name === "execution_scope_status"),
    "the stable bootstrap tool must remain registered",
  );
  assert.ok(
    tools.tools.some((tool) => tool.name === "zes_continuation_preflight"),
    "the ergonomic direct tool remains available to fresh catalogs",
  );
  assert.ok(
    tools.tools.some((tool) => tool.name === "zes_research_cycle_status"),
    "research enforcement must coexist with the frozen-catalog control plane",
  );
  const runtime = context.runtimeCapabilities;
  assert.ok(runtime);
  const surface = runtime.snapshot().toolSurface as Record<string, any>;
  assert.equal(
    surface.criticalToolGroups.zesResearchCycle.registeredComplete,
    true,
  );

  const status = await context.client.callTool({
    name: "execution_scope_status",
    arguments: {},
    _meta: { "openai/session": "frozen-catalog-compatible-session" },
  } as Parameters<Client["callTool"]>[0]);
  assert.equal(status.isError, undefined, responseText(status));
  assert.equal(projectionCalls, 1);
  assert.deepEqual(projectionRequests, [{
    refresh: false,
    deferReason:
      "repository_publication_fast_path_does_not_require_global_runtime_refresh",
  }]);
  assert.equal(scopePublicationCalls, 1);
  const stable = structuredData(status).stableControlPlane as Record<string, any>;
  assert.equal(stable.route, "execution_scope_status");
  assert.equal(stable.policy.stableBootstrapTool, "execution_scope_status");
  assert.equal(stable.policy.frozenClientCatalogCompatible, true);
  assert.equal(stable.policy.newTopLevelToolDiscoveryRequired, false);
  assert.equal(
    stable.capabilities.continuationPreflight.status,
    "available",
  );
  assert.equal(
    stable.capabilities.continuationPreflight
      .policy.clientCatalogFreshnessRequiredForReadback,
    false,
  );
  assert.equal(
    stable.capabilities.continuationPreflight
      .decisions.publish_repository.disposition,
    "allowed",
  );
  assert.equal(
    stable.capabilities.scopePublicationPreflight
      .candidates[0].disposition,
    "eligible",
  );
  assert.equal(
    stable.capabilities.scopePublicationPreflight
      .policy.arbitraryWorkspacePathAccepted,
    false,
  );
});

test("one host scope can inspect another through bounded execution-scope tools", async (t) => {
  const context = await fixture(t, { toolMode: "codex", git: true });
  const workerSession = "worker-private-session-id";
  const supervisorSession = "supervisor-private-session-id";
  const opened = await callOpen(context.client, context.project, workerSession);
  const workspaceId = String(structuredContent(opened).workspaceId);
  await context.client.callTool({
    name: "read",
    arguments: { workspaceId, path: "AGENTS.md" },
    _meta: { "openai/session": workerSession },
  } as Parameters<Client["callTool"]>[0]);
  await context.client.callTool({
    name: "recovery_capsule_record",
    arguments: {
      workspaceId,
      idempotencyKey: "semantic-observability-capsule-1",
      intent: "rolling",
      missionRef: "DEVSPACE-SEMANTIC-OBSERVABILITY",
      authorityOwnerRefs: ["owner:git-main", "owner:runtime"],
      authorityStateRefs: ["git-main:test-head", "runtime:g1"],
      currentFrontier: "Expose safe semantic session status",
      currentCausalSlice: "Join the latest explicit recovery capsule to live execution metadata",
      established: ["Operational scope status already exposes workspaces and processes"],
      validationState: "partial",
      validationRefs: ["test:execution-scope-status"],
      worktreeState: "clean",
      effectState: "none",
      writerState: "held",
      writerRefs: ["writer:isolated-test-worktree"],
      retryPolicy: "normal",
      safeToMutate: true,
      safeToPublish: false,
      exactNextAction: "Run the focused semantic observability test",
      doNotRepeat: ["Do not infer private reasoning from tool events"],
      unresolved: ["Full regression remains"],
      checkpointRefs: ["capsule:test"],
      notes: "PRIVATE-NOTE-SHOULD-NOT-PROJECT",
    },
    _meta: { "openai/session": workerSession },
  } as Parameters<Client["callTool"]>[0]);

  const tools = await context.client.listTools();
  for (const name of [
    "execution_scope_list",
    "execution_scope_status",
    "execution_scope_audit",
  ]) {
    const tool = tools.tools.find((candidate) => candidate.name === name);
    assert.ok(tool, `${name} should be registered`);
    assert.equal(tool.annotations?.readOnlyHint, true);
  }

  const listed = await context.client.callTool({
    name: "execution_scope_list",
    arguments: { limit: 10 },
    _meta: { "openai/session": supervisorSession },
  } as Parameters<Client["callTool"]>[0]);
  const listData = structuredData(listed);
  const scopes = listData.scopes as Array<Record<string, unknown>>;
  const backendRuntime = listData.backendRuntime as Record<string, unknown>;
  const backend = backendRuntime.backend as Record<string, unknown>;
  const toolSurface = backendRuntime.toolSurface as Record<string, unknown>;
  const criticalToolGroups = toolSurface.criticalToolGroups as Record<
    string,
    Record<string, unknown>
  >;
  const clientCatalogObservation = backendRuntime.clientCatalogObservation as Record<
    string,
    unknown
  >;
  assert.match(String(backend.instanceRef), /^[a-f0-9]{16}$/);
  assert.match(String(toolSurface.fingerprintSha256), /^[a-f0-9]{64}$/);
  assert.equal(toolSurface.initialized, true);
  assert.equal(
    toolSurface.surfaceEpoch,
    `nexus:${String(toolSurface.fingerprintSha256).slice(0, 16)}`,
  );
  assert.deepEqual(toolSurface.requiredClientTools, [
    "execution_scope_list",
    "execution_scope_status",
    "open_workspace",
    "read",
    "exec_command",
    "skill_search",
  ]);
  assert.deepEqual(
    toolSurface.toolNames,
    tools.tools.map((tool) => tool.name).sort(),
  );
  assert.equal(toolSurface.toolCount, tools.tools.length);
  assert.equal(criticalToolGroups.recoveryCapsules?.configured, true);
  assert.equal(criticalToolGroups.recoveryCapsules?.registeredComplete, true);
  assert.equal(criticalToolGroups.recoveryCapsules?.available, true);
  assert.deepEqual(
    criticalToolGroups.recoveryCapsules?.registeredTools,
    ["recovery_capsule_record", "recovery_capsule_status"],
  );
  assert.equal(clientCatalogObservation.observable, false);
  assert.equal(clientCatalogObservation.freshness, "unavailable");
  assert.equal(clientCatalogObservation.status, "INDETERMINATE");
  assert.equal(
    clientCatalogObservation.reason,
    "deployment_manifest_unavailable",
  );
  assert.equal(clientCatalogObservation.expectedSurfaceEpoch, undefined);
  assert.equal(
    clientCatalogObservation.missingRegisteredToolDoesNotImplyBackendCapabilityAbsent,
    true,
  );
  assert.equal(scopes.length, 2);
  const currentScope = scopes.find((scope) => scope.isCurrent === true);
  assert.ok(currentScope);
  assert.equal(currentScope.materialized, false);
  const workerScope = scopes.find((scope) => scope.isCurrent === false);
  assert.ok(workerScope);
  const scopeRef = String(workerScope.scopeRef);
  assert.match(scopeRef, /^[a-f0-9]{16}$/);
  assert.equal(workerScope.isCurrent, false);
  assert.equal(workerScope.materialized, true);
  assert.equal(workerScope.displayLabel, "DEVSPACE-SEMANTIC-OBSERVABILITY");
  assert.equal(
    workerScope.displayLabelSource,
    "recovery_capsule_mission_ref",
  );
  assert.equal(workerScope.displayLabelIsHostChatTitle, false);
  const semanticHint = workerScope.semanticHint as Record<string, unknown>;
  assert.equal(semanticHint.available, true);
  assert.equal(semanticHint.displayLabel, "DEVSPACE-SEMANTIC-OBSERVABILITY");
  assert.equal(
    semanticHint.displayLabelSource,
    "recovery_capsule_mission_ref",
  );
  assert.equal(semanticHint.labelIsHostChatTitle, false);
  assert.equal(
    semanticHint.currentFrontier,
    "Expose safe semantic session status",
  );
  assert.equal(semanticHint.authorityFreshness, "unverified");
  assert.equal(
    semanticHint.exactActionReliance,
    "requires_current_authority_reconciliation",
  );
  const listedObservation = workerScope.observation as Record<string, unknown>;
  assert.equal(listedObservation.modelProgressObservable, false);
  assert.equal(listedObservation.providerGenerationObservable, false);
  assert.equal(listedObservation.hungDetermination, "unavailable");
  const listedRuntimeRelation = workerScope.runtimeRelation as Record<string, unknown>;
  assert.equal(listedRuntimeRelation.currentBackendInstanceRef, backend.instanceRef);
  assert.equal(
    listedRuntimeRelation.currentBackendToolSurfaceFingerprintSha256,
    toolSurface.fingerprintSha256,
  );
  assert.equal(
    listedRuntimeRelation.currentBackendToolSurfaceEpoch,
    toolSurface.surfaceEpoch,
  );
  assert.deepEqual(
    listedRuntimeRelation.requiredClientTools,
    toolSurface.requiredClientTools,
  );
  assert.equal(listedRuntimeRelation.clientToolCatalogObservable, false);
  assert.equal(listedRuntimeRelation.catalogFreshnessDetermination, "unavailable");
  assert.equal(JSON.stringify(listData).includes(workerSession), false);
  assert.equal(JSON.stringify(listData).includes(supervisorSession), false);

  const status = await context.client.callTool({
    name: "execution_scope_status",
    arguments: { scopeRef },
    _meta: { "openai/session": supervisorSession },
  } as Parameters<Client["callTool"]>[0]);
  const statusData = structuredData(status);
  const statusRuntime = statusData.backendRuntime as Record<string, unknown>;
  assert.equal(
    (statusRuntime.backend as Record<string, unknown>).instanceRef,
    backend.instanceRef,
  );
  assert.equal(
    (statusRuntime.toolSurface as Record<string, unknown>).fingerprintSha256,
    toolSurface.fingerprintSha256,
  );
  const statusRuntimeRelation = statusData.runtimeRelation as Record<string, unknown>;
  assert.equal(statusRuntimeRelation.currentBackendInstanceRef, backend.instanceRef);
  assert.equal(statusRuntimeRelation.exactBackendInstanceForHistoricalActivityPersisted, false);
  const workspaces = statusData.workspaces as Array<Record<string, unknown>>;
  assert.equal(workspaces[0]?.workspaceId, workspaceId);
  assert.equal(workspaces[0]?.root, context.project);
  assert.equal((statusData.policy as Record<string, unknown>).transcriptCaptured, false);
  const semanticRecovery = statusData.semanticRecovery as Record<string, unknown>;
  assert.equal(semanticRecovery.available, true);
  assert.equal(semanticRecovery.missionRef, "DEVSPACE-SEMANTIC-OBSERVABILITY");
  assert.equal(
    semanticRecovery.currentFrontier,
    "Expose safe semantic session status",
  );
  assert.equal(
    semanticRecovery.currentCausalSlice,
    "Join the latest explicit recovery capsule to live execution metadata",
  );
  assert.equal(
    (semanticRecovery.worktree as Record<string, unknown>).workspaceFreshness,
    "fresh",
  );
  assert.equal(
    (semanticRecovery.authority as Record<string, unknown>).freshness,
    "unverified",
  );
  assert.equal(semanticRecovery.exactActionCandidateAvailable, false);
  assert.equal(
    (semanticRecovery.activitySinceCapsule as Record<string, unknown>)
      .observedActivityAfterCapsule,
    false,
  );
  const initialEvidence = semanticRecovery.evidenceSinceCapsule as Record<
    string,
    unknown
  >;
  assert.equal(initialEvidence.source, "sanitized_execution_scope_event_receipts");
  assert.equal(initialEvidence.capsuleEventRetained, true);
  assert.equal(
    initialEvidence.receiptWindowCompleteness,
    "complete_while_capsule_event_is_retained",
  );
  assert.equal(initialEvidence.retainedEventCount, 0);
  assert.deepEqual(initialEvidence.events, []);
  const semanticPolicy = semanticRecovery.policy as Record<string, unknown>;
  assert.equal(semanticPolicy.privateReasoningCaptured, false);
  assert.equal(semanticPolicy.inferredFromToolEventsOrFilenames, false);
  assert.equal(semanticPolicy.executionEvidenceCanModifySemanticState, false);
  assert.equal(JSON.stringify(semanticRecovery).includes("PRIVATE-NOTE-SHOULD-NOT-PROJECT"), false);

  await context.client.callTool({
    name: "read",
    arguments: { workspaceId, path: "AGENTS.md" },
    _meta: { "openai/session": workerSession },
  } as Parameters<Client["callTool"]>[0]);
  const laterStatus = await context.client.callTool({
    name: "execution_scope_status",
    arguments: { scopeRef },
    _meta: { "openai/session": supervisorSession },
  } as Parameters<Client["callTool"]>[0]);
  const laterSemantic = structuredData(laterStatus).semanticRecovery as Record<
    string,
    unknown
  >;
  assert.equal(
    (laterSemantic.activitySinceCapsule as Record<string, unknown>)
      .observedActivityAfterCapsule,
    true,
  );
  assert.equal(
    (laterSemantic.worktree as Record<string, unknown>).workspaceFreshness,
    "fresh",
  );
  const laterEvidence = laterSemantic.evidenceSinceCapsule as Record<string, unknown>;
  assert.equal(laterEvidence.retainedEventCount, 1);
  assert.equal(laterEvidence.returnedEventCount, 1);
  assert.equal(laterEvidence.truncated, false);
  assert.equal(
    ((laterEvidence.byTool as Record<string, Record<string, unknown>>).read).calls,
    1,
  );
  const laterEvidenceEvents = laterEvidence.events as Array<Record<string, unknown>>;
  assert.equal(laterEvidenceEvents[0]?.tool, "read");
  assert.equal(
    (laterEvidenceEvents[0]?.detail as Record<string, unknown>).path,
    "AGENTS.md",
  );
  assert.equal(JSON.stringify(laterEvidence).includes("project instructions"), false);

  const audit = await context.client.callTool({
    name: "execution_scope_audit",
    arguments: { scopeRef, limit: 10 },
    _meta: { "openai/session": supervisorSession },
  } as Parameters<Client["callTool"]>[0]);
  const auditData = structuredData(audit);
  assert.equal(
    ((auditData.backendRuntime as Record<string, unknown>).toolSurface as Record<string, unknown>)
      .fingerprintSha256,
    toolSurface.fingerprintSha256,
  );
  const events = auditData.events as Array<Record<string, unknown>>;
  assert.deepEqual(
    events.map((event) => event.tool),
    ["read", "recovery_capsule_record", "read", "open_workspace"],
  );
  const serializedAudit = JSON.stringify(auditData);
  assert.equal(serializedAudit.includes(workerSession), false);
  assert.equal(serializedAudit.includes("project instructions"), false);
  assert.equal(serializedAudit.includes("Expose safe semantic session status"), false);
  assert.equal(serializedAudit.includes("Run the focused semantic observability test"), false);
  assert.equal(serializedAudit.includes("PRIVATE-NOTE-SHOULD-NOT-PROJECT"), false);
});

test("execution-scope mailbox delivers at the target's next MCP boundary with receipts", async (t) => {
  const context = await fixture(t, { toolMode: "codex" });
  const workerSession = "mailbox-worker-session";
  const supervisorSession = "mailbox-supervisor-session";
  const workerOpen = await callOpen(context.client, context.project, workerSession);
  const workspaceId = String(structuredContent(workerOpen).workspaceId);

  const listed = await context.client.callTool({
    name: "execution_scope_list",
    arguments: { limit: 10 },
    _meta: { "openai/session": supervisorSession },
  } as Parameters<Client["callTool"]>[0]);
  const workerScope = (structuredData(listed).scopes as Array<Record<string, unknown>>)
    .find((scope) => scope.isCurrent === false);
  assert.ok(workerScope);
  const targetScopeRef = String(workerScope.scopeRef);

  const tools = await context.client.listTools();
  for (const name of [
    "execution_scope_message_send",
    "execution_scope_message_inbox",
    "execution_scope_message_status",
    "execution_scope_message_receipt",
  ]) {
    assert.ok(tools.tools.some((tool) => tool.name === name), `${name} should be registered`);
  }

  const sent = await context.client.callTool({
    name: "execution_scope_message_send",
    arguments: {
      targetScopeRef,
      idempotencyKey: "server-mailbox-1",
      kind: "correction",
      priority: "urgent",
      body: "Reconcile the current effect state before starting another frontier.",
      correlationRef: "work:server-test",
    },
    _meta: { "openai/session": supervisorSession },
  } as Parameters<Client["callTool"]>[0]);
  assert.equal(sent.isError, undefined, responseText(sent));
  const sentData = structuredData(sent);
  const message = sentData.message as Record<string, unknown>;
  const messageId = String(message.messageId);
  assert.equal(message.state, "accepted");
  assert.equal(sentData.idempotentReplay, false);

  const replay = await context.client.callTool({
    name: "execution_scope_message_send",
    arguments: {
      targetScopeRef,
      idempotencyKey: "server-mailbox-1",
      kind: "correction",
      priority: "urgent",
      body: "Reconcile the current effect state before starting another frontier.",
      correlationRef: "work:server-test",
    },
    _meta: { "openai/session": supervisorSession },
  } as Parameters<Client["callTool"]>[0]);
  assert.equal(structuredData(replay).idempotentReplay, true);

  const supervisorAudit = await context.client.callTool({
    name: "execution_scope_audit",
    arguments: { limit: 20 },
    _meta: { "openai/session": supervisorSession },
  } as Parameters<Client["callTool"]>[0]);
  const auditData = structuredData(supervisorAudit);
  const auditSerialized = JSON.stringify(auditData);
  assert.equal(
    auditSerialized.includes(
      "Reconcile the current effect state before starting another frontier.",
    ),
    false,
  );
  const sendEvent = (auditData.events as Array<Record<string, unknown>>)
    .find((event) => event.tool === "execution_scope_message_send");
  assert.ok(sendEvent);
  const sendDetail = sendEvent.detail as Record<string, unknown>;
  assert.equal(
    sendDetail.bodyLength,
    "Reconcile the current effect state before starting another frontier.".length,
  );
  assert.match(String(sendDetail.bodyDigestSha256), /^[a-f0-9]{64}$/);
  assert.equal(sendDetail.targetScopeRef, targetScopeRef);

  const structuredOutputCall = await context.client.callTool({
    name: "exec_command",
    arguments: {
      workspaceId,
      cmd: `${JSON.stringify(process.execPath)} -e "process.stdout.write('structured-output\\n')"`,
      yieldTimeMs: 2_000,
    },
    _meta: { "openai/session": workerSession },
  } as Parameters<Client["callTool"]>[0]);
  const structuredOutput = structuredOutputCall.structuredContent as Record<string, unknown>;
  assert.equal(structuredOutput.output, "structured-output\n");
  assert.equal(structuredOutput.outputDeltaBytes, Buffer.byteLength("structured-output\n"));
  assert.match(String(structuredOutput.outputDeltaDigestSha256), /^[a-f0-9]{64}$/);
  assert.equal(structuredOutput.outputTotalBytes, Buffer.byteLength("structured-output\n"));
  assert.equal(structuredOutput.outputComplete, true);

  const processStart = await context.client.callTool({
    name: "exec_command",
    arguments: {
      workspaceId,
      cmd: `${JSON.stringify(process.execPath)} -e "setTimeout(() => {}, 5000)"`,
      yieldTimeMs: 1,
    },
    _meta: { "openai/session": workerSession },
  } as Parameters<Client["callTool"]>[0]);
  const processSessionId = Number(
    (processStart.structuredContent as Record<string, unknown>).sessionId,
  );
  assert.ok(Number.isInteger(processSessionId));
  const mailboxPoll = await context.client.callTool({
    name: "write_stdin",
    arguments: {
      workspaceId,
      sessionId: processSessionId,
      yieldTimeMs: 5_000,
    },
    _meta: { "openai/session": workerSession },
  } as Parameters<Client["callTool"]>[0]);
  assert.equal(
    (mailboxPoll.structuredContent as Record<string, unknown>).wakeReason,
    "mailbox",
  );
  assert.match(responseAllText(mailboxPoll), /poll woke for pending execution-scope mail/i);
  await context.client.callTool({
    name: "write_stdin",
    arguments: {
      workspaceId,
      sessionId: processSessionId,
      chars: "\u0003",
      yieldTimeMs: 2_000,
    },
    _meta: { "openai/session": workerSession },
  } as Parameters<Client["callTool"]>[0]);

  const workerRead = await context.client.callTool({
    name: "read",
    arguments: { workspaceId, path: "AGENTS.md" },
    _meta: { "openai/session": workerSession },
  } as Parameters<Client["callTool"]>[0]);
  assert.match(responseAllText(workerRead), /\[execution-mailbox\] 1 pending message/i);
  assert.match(responseAllText(workerRead), /highest priority urgent/i);

  const inbox = await context.client.callTool({
    name: "execution_scope_message_inbox",
    arguments: {},
    _meta: { "openai/session": workerSession },
  } as Parameters<Client["callTool"]>[0]);
  const inboxMessages = structuredData(inbox).messages as Array<Record<string, unknown>>;
  assert.equal(inboxMessages.length, 1);
  assert.equal(inboxMessages[0]?.messageId, messageId);
  assert.equal(inboxMessages[0]?.state, "observed");
  assert.doesNotMatch(responseAllText(inbox), /\[execution-mailbox\]/);

  const acknowledged = await context.client.callTool({
    name: "execution_scope_message_receipt",
    arguments: {
      messageId,
      state: "acknowledged",
      note: "Correction received.",
    },
    _meta: { "openai/session": workerSession },
  } as Parameters<Client["callTool"]>[0]);
  assert.equal(structuredData(acknowledged).state, "acknowledged");

  const acted = await context.client.callTool({
    name: "execution_scope_message_receipt",
    arguments: {
      messageId,
      state: "acted",
      note: "Effect state reconciled.",
    },
    _meta: { "openai/session": workerSession },
  } as Parameters<Client["callTool"]>[0]);
  assert.equal(structuredData(acted).state, "acted");

  const status = await context.client.callTool({
    name: "execution_scope_message_status",
    arguments: { messageId },
    _meta: { "openai/session": supervisorSession },
  } as Parameters<Client["callTool"]>[0]);
  assert.equal(structuredData(status).state, "acted");
  assert.equal(structuredData(status).actedNote, "Effect state reconciled.");

  const cleanRead = await context.client.callTool({
    name: "read",
    arguments: { workspaceId, path: "AGENTS.md" },
    _meta: { "openai/session": workerSession },
  } as Parameters<Client["callTool"]>[0]);
  assert.doesNotMatch(responseAllText(cleanRead), /\[execution-mailbox\]/);
});

test("MCP local-agent tools enqueue serialized provider-session continuation", async (t) => {
  const launched: Array<{ agentId: string; workerId: string }> = [];
  const providerInputs: Array<Record<string, unknown>> = [];
  const context = await fixture(t, {
    toolMode: "codex",
    subagents: true,
    localAgentCoordinatorOptions: {
      launchWorker: (agentId, workerId) => launched.push({ agentId, workerId }),
      assertProviderAvailable: () => undefined,
      loadProfiles: async () => [],
      runProvider: async (provider, input) => {
        providerInputs.push({ provider, ...input });
        return {
          provider,
          providerSessionId: input.providerSessionId ?? "thread-server-1",
          finalResponse: `server-response-${providerInputs.length}`,
          items: [],
        };
      },
    },
  });
  const coordinator = context.localAgentCoordinator;
  assert.ok(coordinator);
  const agent = coordinator.store.update(
    coordinator.store.create({
      workspaceId: "ws_agent",
      workspaceRoot: context.project,
      profileName: "codex",
      provider: "codex",
    }).id,
    { status: "idle" },
  );
  const supervisorSession = "local-agent-supervisor-session";

  const tools = await context.client.listTools();
  for (const name of [
    "local_agent_session_list",
    "local_agent_session_status",
    "local_agent_session_resume",
    "local_agent_message_send",
    "local_agent_turn_status",
    "local_agent_turn_cancel",
    "local_agent_turn_resolve",
  ]) {
    assert.ok(tools.tools.some((tool) => tool.name === name), `${name} should be registered`);
  }

  const listed = await context.client.callTool({
    name: "local_agent_session_list",
    arguments: {},
    _meta: { "openai/session": supervisorSession },
  } as Parameters<Client["callTool"]>[0]);
  const sessions = structuredData(listed).sessions as Array<Record<string, unknown>>;
  assert.equal(sessions[0]?.id, agent.id);
  assert.equal(sessions[0]?.continuationSupported, true);

  const firstSent = await context.client.callTool({
    name: "local_agent_message_send",
    arguments: {
      agentId: agent.id,
      idempotencyKey: "server-agent-1",
      kind: "correction",
      priority: "urgent",
      body: "Reconcile the provider session before continuing.",
      correlationRef: "work:agent-server-test",
    },
    _meta: { "openai/session": supervisorSession },
  } as Parameters<Client["callTool"]>[0]);
  assert.equal(firstSent.isError, undefined, responseText(firstSent));
  const firstData = structuredData(firstSent);
  const firstTurn = firstData.turn as Record<string, unknown>;
  const firstTurnId = String(firstTurn.turnId);
  assert.equal(firstTurn.status, "queued");
  assert.equal(firstData.workerRequested, true);
  assert.equal(launched.length, 1);
  const firstWorkerId = launched[0]?.workerId;
  assert.ok(firstWorkerId);

  const audit = await context.client.callTool({
    name: "execution_scope_audit",
    arguments: { limit: 20 },
    _meta: { "openai/session": supervisorSession },
  } as Parameters<Client["callTool"]>[0]);
  const auditData = structuredData(audit);
  const auditSerialized = JSON.stringify(auditData);
  assert.equal(
    auditSerialized.includes("Reconcile the provider session before continuing."),
    false,
  );
  const sendEvent = (auditData.events as Array<Record<string, unknown>>)
    .find((event) => event.tool === "local_agent_message_send");
  assert.ok(sendEvent);
  const sendDetail = sendEvent.detail as Record<string, unknown>;
  assert.equal(sendDetail.agentId, agent.id);
  assert.match(String(sendDetail.bodyDigestSha256), /^[a-f0-9]{64}$/);

  const firstWorker = await coordinator.runWorker(
    agent.id,
    firstWorkerId,
  );
  assert.deepEqual(firstWorker.processedTurnIds, [firstTurnId]);
  const firstStatus = await context.client.callTool({
    name: "local_agent_turn_status",
    arguments: { turnId: firstTurnId },
    _meta: { "openai/session": supervisorSession },
  } as Parameters<Client["callTool"]>[0]);
  assert.equal(structuredData(firstStatus).status, "succeeded");

  const secondSent = await context.client.callTool({
    name: "local_agent_message_send",
    arguments: {
      agentId: agent.id,
      idempotencyKey: "server-agent-2",
      kind: "instruction",
      body: "Continue in the same provider session.",
    },
    _meta: { "openai/session": supervisorSession },
  } as Parameters<Client["callTool"]>[0]);
  const secondTurnId = String(
    (structuredData(secondSent).turn as Record<string, unknown>).turnId,
  );
  assert.equal(launched.length, 2);
  const secondWorkerId = launched[1]?.workerId;
  assert.ok(secondWorkerId);
  await coordinator.runWorker(agent.id, secondWorkerId);
  assert.equal(providerInputs.length, 2);
  assert.equal(providerInputs[0]?.providerSessionId, undefined);
  assert.equal(providerInputs[1]?.providerSessionId, "thread-server-1");
  assert.equal(coordinator.turnStatus(secondTurnId).status, "succeeded");

  const cancellable = await context.client.callTool({
    name: "local_agent_message_send",
    arguments: {
      agentId: agent.id,
      idempotencyKey: "server-agent-3",
      kind: "notice",
      body: "This queued turn will be cancelled.",
    },
    _meta: { "openai/session": supervisorSession },
  } as Parameters<Client["callTool"]>[0]);
  const cancellableTurnId = String(
    (structuredData(cancellable).turn as Record<string, unknown>).turnId,
  );
  const cancelled = await context.client.callTool({
    name: "local_agent_turn_cancel",
    arguments: {
      turnId: cancellableTurnId,
      note: "No longer needed.",
    },
    _meta: { "openai/session": supervisorSession },
  } as Parameters<Client["callTool"]>[0]);
  assert.equal(structuredData(cancelled).status, "cancelled");

  const sessionStatus = await context.client.callTool({
    name: "local_agent_session_status",
    arguments: { agentId: agent.id, turnLimit: 10 },
    _meta: { "openai/session": supervisorSession },
  } as Parameters<Client["callTool"]>[0]);
  const sessionData = structuredData(sessionStatus);
  assert.equal(sessionData.providerSessionId, "thread-server-1");
  assert.equal(sessionData.queue.running, 0);
});

test("MCP local-agent session resume restarts queued work after an ordinary failure", async (t) => {
  const launched: Array<{ agentId: string; workerId: string }> = [];
  let providerCall = 0;
  const context = await fixture(t, {
    toolMode: "codex",
    subagents: true,
    localAgentCoordinatorOptions: {
      launchWorker: (agentId, workerId) => launched.push({ agentId, workerId }),
      assertProviderAvailable: () => undefined,
      loadProfiles: async () => [],
      runProvider: async (provider, input) => {
        providerCall += 1;
        if (providerCall === 1) throw new Error("provider temporarily unavailable");
        return {
          provider,
          providerSessionId: input.providerSessionId ?? "thread-resumed-1",
          finalResponse: "resumed response",
          items: [],
        };
      },
    },
  });
  const coordinator = context.localAgentCoordinator;
  assert.ok(coordinator);
  const agent = coordinator.store.update(
    coordinator.store.create({
      workspaceId: "ws_resume",
      workspaceRoot: context.project,
      profileName: "codex",
      provider: "codex",
    }).id,
    { status: "idle" },
  );
  const session = "local-agent-resume-supervisor";
  const send = async (key: string, body: string) => context.client.callTool({
    name: "local_agent_message_send",
    arguments: {
      agentId: agent.id,
      idempotencyKey: key,
      kind: "instruction",
      body,
    },
    _meta: { "openai/session": session },
  } as Parameters<Client["callTool"]>[0]);

  const first = await send("resume-first", "first turn fails");
  const second = await send("resume-second", "second turn remains queued");
  const firstTurnId = String(
    (structuredData(first).turn as Record<string, unknown>).turnId,
  );
  const secondTurnId = String(
    (structuredData(second).turn as Record<string, unknown>).turnId,
  );
  assert.equal(launched.length, 1);
  const firstWorkerId = launched[0]?.workerId;
  assert.ok(firstWorkerId);
  const failedWorker = await coordinator.runWorker(agent.id, firstWorkerId);
  assert.equal(failedWorker.stoppedAfterFailure, true);
  assert.equal(coordinator.turnStatus(firstTurnId).status, "failed");
  assert.equal(coordinator.turnStatus(secondTurnId).status, "queued");

  const paused = await context.client.callTool({
    name: "local_agent_session_status",
    arguments: { agentId: agent.id },
    _meta: { "openai/session": session },
  } as Parameters<Client["callTool"]>[0]);
  assert.equal(structuredData(paused).status, "error");

  const resumed = await context.client.callTool({
    name: "local_agent_session_resume",
    arguments: {
      agentId: agent.id,
      note: "Provider availability was restored.",
    },
    _meta: { "openai/session": session },
  } as Parameters<Client["callTool"]>[0]);
  const resumedData = structuredData(resumed);
  assert.equal(resumedData.workerRequested, true);
  assert.equal(resumedData.session.status, "queued");
  assert.equal(launched.length, 2);
  const secondWorkerId = launched[1]?.workerId;
  assert.ok(secondWorkerId);
  await coordinator.runWorker(agent.id, secondWorkerId);
  assert.equal(coordinator.turnStatus(secondTurnId).status, "succeeded");
  assert.equal(coordinator.sessionStatus(agent.id).status, "idle");
});

test("createMcpServer keeps its prior public call shape and owns the default observer", async (t) => {
  const context = await fixture(t, {
    toolMode: "codex",
    useDefaultExecutionScopes: true,
  });
  const tools = await context.client.listTools();
  assert.ok(tools.tools.some((tool) => tool.name === "execution_scope_list"));
  await callOpen(context.client, context.project, "backward-compatible-session");
  const listed = await context.client.callTool({
    name: "execution_scope_list",
    arguments: {},
    _meta: { "openai/session": "backward-compatible-session" },
  } as Parameters<Client["callTool"]>[0]);
  const data = structuredData(listed);
  assert.equal((data.scopes as unknown[]).length, 1);
});

test("generic execution-scope metadata reuses checkout context without OpenAI coupling", async (t) => {
  const context = await fixture(t, { toolMode: "codex" });
  const params = {
    name: "open_workspace",
    arguments: { path: context.project },
    _meta: { "devspace/execution-scope": "provider-neutral-scope" },
  } as Parameters<Client["callTool"]>[0];
  const first = await context.client.callTool(params);
  const second = await context.client.callTool(params);
  assert.equal(
    structuredContent(first).workspaceId,
    structuredContent(second).workspaceId,
  );
  assert.match(responseText(second), /already open/i);
});

test("concurrent checkout opens return one full context and one reuse instruction", async (t) => {
  const context = await fixture(t);
  const [first, second] = await Promise.all([
    callOpen(context.client, context.project, "chat-1"),
    callOpen(context.client, context.project, "chat-1"),
  ]);

  assert.equal(structuredContent(first).workspaceId, structuredContent(second).workspaceId);
  assert.equal(
    [first, second].filter((result) => Array.isArray(structuredContent(result).agentsFiles)).length,
    1,
  );
  assert.equal(
    [first, second].filter((result) => responseText(result).includes("Workspace already open as")).length,
    1,
  );
});

test("new worktrees always receive a fresh workspace and complete worktree context", async (t) => {
  const context = await fixture(t, { git: true });
  const checkout = await callOpen(context.client, context.project, "chat-1");
  const firstWorktree = await callOpen(context.client, context.project, "chat-1", "worktree");
  const secondWorktree = await callOpen(context.client, context.project, "chat-1", "worktree");
  const checkoutAgain = await callOpen(context.client, context.project, "chat-1");

  assert.notEqual(structuredContent(firstWorktree).workspaceId, structuredContent(secondWorktree).workspaceId);
  assert.equal(structuredContent(checkoutAgain).workspaceId, structuredContent(checkout).workspaceId);
  for (const result of [firstWorktree, secondWorktree]) {
    const structured = structuredContent(result);
    assert.equal(structured.mode, "worktree");
    assert.ok(Array.isArray(structured.agentsFiles));
    assert.ok(Array.isArray(structured.availableAgentsFiles));
    assert.ok(Array.isArray(structured.skills));
    assert.ok(Array.isArray(structured.agentProviders));
    assert.ok(Array.isArray(structured.agents));
    assert.ok(Array.isArray(structured.skillDiagnostics));
    assert.match(responseText(result), /Opened isolated worktree workspace/);
  }
  assert.equal(structuredContent(checkoutAgain).agentsFiles, undefined);
});

test("workspace lifecycle tools close managed worktrees and expose digest-bound GC", async (t) => {
  const context = await fixture(t, { git: true, toolMode: "codex" });
  const tools = await context.client.listTools();
  for (const name of [
    "workspace_list",
    "workspace_status",
    "workspace_close",
    "workspace_candidate_inventory",
    "workspace_gc_preview",
    "workspace_gc_execute",
  ]) {
    assert.ok(tools.tools.some((tool) => tool.name === name), `${name} must be registered`);
  }

  const opened = await callOpen(context.client, context.project, "workspace-lifecycle", "worktree");
  const workspaceId = String(structuredContent(opened).workspaceId);

  const status = await context.client.callTool({
    name: "workspace_status",
    arguments: { workspaceId },
    _meta: { "openai/session": "workspace-lifecycle" },
  } as Parameters<Client["callTool"]>[0]);
  const statusData = structuredData(status);
  assert.equal(statusData.exists, true);
  assert.equal(statusData.workspace.id, workspaceId);
  assert.equal(statusData.git.readable, true);
  assert.equal(statusData.git.dirty, false);
  assert.equal(statusData.candidateLifecycle.disposition, "baseline_only");

  const inventory = await context.client.callTool({
    name: "workspace_candidate_inventory",
    arguments: { activeWithinHours: 0.01 },
    _meta: { "openai/session": "workspace-lifecycle" },
  } as Parameters<Client["callTool"]>[0]);
  const inventoryData = structuredData(inventory);
  assert.equal(inventoryData.capabilityRef, "devspace.workspace-candidate-inventory.v1");
  assert.ok(
    inventoryData.candidates.some((candidate: Record<string, unknown>) => (
      candidate.workspaceId === workspaceId
    )),
  );

  const closed = await context.client.callTool({
    name: "workspace_close",
    arguments: { workspaceId },
    _meta: { "openai/session": "workspace-lifecycle" },
  } as Parameters<Client["callTool"]>[0]);
  const closedData = structuredData(closed);
  assert.equal(closedData.closed, true);
  assert.equal(closedData.removed, true);
  assert.equal(closedData.workspace.status, "closed");

  const closedStatus = await context.client.callTool({
    name: "workspace_status",
    arguments: { workspaceId },
    _meta: { "openai/session": "workspace-lifecycle" },
  } as Parameters<Client["callTool"]>[0]);
  assert.equal(structuredData(closedStatus).exists, false);

  const preview = await context.client.callTool({
    name: "workspace_gc_preview",
    arguments: { olderThanHours: 1, capsuleProtectionHours: 1 },
    _meta: { "openai/session": "workspace-lifecycle" },
  } as Parameters<Client["callTool"]>[0]);
  const previewData = structuredData(preview);
  assert.match(String(previewData.planIdSha256), /^[a-f0-9]{64}$/);
  assert.equal(previewData.summary.directoryCount, 0);
});

test("fixed self-repository publication preflight is available directly and through the stable scope route", async (t) => {
  const context = await fixture(t, {
    git: true,
    toolMode: "codex",
    selfRepositoryPublication: {},
  });
  const tools = await context.client.listTools();
  assert.ok(tools.tools.some((tool) => tool.name === "self_repository_publication_preflight"));
  assert.ok(!tools.tools.some((tool) => tool.name === "self_repository_publish"));

  const opened = await callOpen(
    context.client,
    context.project,
    "self-repository-publication",
    "worktree",
  );
  const workspaceId = String(structuredContent(opened).workspaceId);
  const worktreeRoot = String(structuredContent(opened).root);
  await writeFile(join(worktreeRoot, "candidate.txt"), "candidate\n");
  await git(worktreeRoot, ["add", "."]);
  await git(worktreeRoot, ["commit", "-m", "Candidate"]);

  const direct = await context.client.callTool({
    name: "self_repository_publication_preflight",
    arguments: { workspaceId },
    _meta: { "openai/session": "self-repository-publication" },
  } as Parameters<Client["callTool"]>[0]);
  const directData = structuredData(direct);
  assert.equal(directData.status, "blocked");
  assert.ok(
    directData.blockingFactors.includes("candidate_validation_missing_or_stale"),
  );
  assert.equal(directData.policy.unrelatedZesRuntimeOrWriterStateCanBlockPublication, false);

  const scopeStatus = await context.client.callTool({
    name: "execution_scope_status",
    arguments: {},
    _meta: { "openai/session": "self-repository-publication" },
  } as Parameters<Client["callTool"]>[0]);
  const scopeData = structuredData(scopeStatus);
  const capability = scopeData.stableControlPlane.capabilities
    .selfRepositoryPublicationPreflight;
  assert.equal(capability.candidateCount, 1);
  assert.equal(capability.blockedCount, 1);
  assert.equal(capability.candidates[0].workspaceId, workspaceId);
});

test("checkout opened after a worktree receives its own complete context", async (t) => {
  const context = await fixture(t, { git: true });
  const worktree = await callOpen(context.client, context.project, "chat-1", "worktree");
  const checkout = await callOpen(context.client, context.project, "chat-1");
  const checkoutAgain = await callOpen(context.client, context.project, "chat-1");

  assert.equal(structuredContent(worktree).mode, "worktree");
  assert.ok(Array.isArray(structuredContent(worktree).agentsFiles));
  assert.equal(structuredContent(checkout).mode, "checkout");
  assert.ok(Array.isArray(structuredContent(checkout).agentsFiles));
  assert.equal(structuredContent(checkoutAgain).workspaceId, structuredContent(checkout).workspaceId);
  assert.equal(structuredContent(checkoutAgain).agentsFiles, undefined);
});

test("a host without conversation metadata receives normal explicit-workspace behavior", async (t) => {
  const context = await fixture(t);
  const first = await callOpen(context.client, context.project);
  const second = await callOpen(context.client, context.project);

  assert.notEqual(structuredContent(first).workspaceId, structuredContent(second).workspaceId);
  assert.ok(Array.isArray(structuredContent(first).agentsFiles));
  assert.ok(Array.isArray(structuredContent(second).agentsFiles));
  assert.doesNotMatch(responseText(first), /conversation metadata/i);
  assert.doesNotMatch(responseText(second), /conversation metadata/i);
});

test("checkout reuse and context suppression survive a registry restart", async (t) => {
  const context = await fixture(t);
  const first = await callOpen(context.client, context.project, "chat-1");
  const firstWorkspaceId = structuredContent(first).workspaceId;

  await context.close();

  const restoredStore = new SqliteWorkspaceStore(context.stateDir);
  const restoredProcessSessions = new ProcessSessionManager();
  const restoredExecutionScopes = new ExecutionScopeManager(
    context.config.executionObservability,
    context.stateDir,
    restoredProcessSessions,
  );
  const restoredServer = createMcpServer(
    context.config,
    new WorkspaceRegistry(context.config, restoredStore),
    createReviewCheckpointManager(),
    restoredProcessSessions,
    [],
    [],
    restoredExecutionScopes,
  );
  const [restoredClientTransport, restoredServerTransport] = InMemoryTransport.createLinkedPair();
  const restoredClient = new Client({ name: "devspace-restored-test-client", version: "1.0.0" });
  let restoredClosed = false;
  const closeRestored = async () => {
    if (restoredClosed) return;
    restoredClosed = true;
    await restoredClient.close();
    await restoredServer.close();
    restoredProcessSessions.shutdown();
    restoredExecutionScopes.close();
    restoredStore.close();
  };
  t.after(closeRestored);

  try {
    await Promise.all([
      restoredClient.connect(restoredClientTransport),
      restoredServer.connect(restoredServerTransport),
    ]);

    const restored = await callOpen(restoredClient, context.project, "chat-1");
    assert.equal(structuredContent(restored).workspaceId, firstWorkspaceId);
    assert.equal(structuredContent(restored).agentsFiles, undefined);
  } finally {
    await closeRestored();
  }
});

function fixedConversationBridge(): ConversationTransportBridgePort {
  const status: ConversationBridgeTargetStatus = {
    schemaVersion: 1,
    targetAlias: "codex-canary",
    targetKind: "codex_thread",
    targetRefDigestSha256: "a".repeat(64),
    bindingRef: "bridge-target:codex-canary",
    bindingGeneration: 1,
    candidates: [{
      transportId: "codex-app-server:codex-canary",
      targetKind: "codex_thread",
      kind: "native_rpc",
      availability: "available",
      transportHealth: "healthy",
      directInput: "available",
      binding: "exact",
      reconciliation: "available",
      surfaceTrust: "official",
      sessionLifecycle: "idle",
      evidenceRefs: ["codex-app-server:thread-read"],
    }],
    observedAt: "2026-08-18T00:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
    evidenceDigestSha256: "b".repeat(64),
    evidenceRefs: ["bridge-protocol:v1"],
    limitationCodes: [],
    authority: CONVERSATION_TRANSPORT_BRIDGE_AUTHORITY,
  };
  return {
    status: async (targetAlias) => {
      assert.equal(targetAlias, "codex-canary");
      return status;
    },
    deliver: async () => {
      throw new Error("not used by this test");
    },
    reconcile: async () => {
      throw new Error("not used by this test");
    },
  };
}

interface ServerFixture {
  client: Client;
  project: string;
  config: ServerConfig;
  stateDir: string;
  hostSkillPath?: string;
  localAgentCoordinator?: LocalAgentCoordinator;
  conversationTransportRuntime?: ConversationTransportRuntime;
  runtimeCapabilities?: RuntimeCapabilityRegistry;
  ownerRemote?: string;
  close: () => Promise<void>;
}

async function fixture(
  t: TestContext,
  options: {
    git?: boolean;
    toolMode?: ServerConfig["toolMode"];
    useDefaultExecutionScopes?: boolean;
    subagents?: boolean;
    skillFixtures?: boolean;
    skillsEnabled?: boolean;
    codexNavigationTools?: boolean;
    localAgentCoordinatorOptions?: LocalAgentCoordinatorOptions;
    runtimeCapabilities?: boolean;
    zesResearchCycleMode?: ServerConfig["zesResearchCycle"]["mode"];
    continuationPreflightProjector?: ZesContinuationPreflightProjectionSource;
    scopePublicationPreflight?: ScopePublicationPreflightSource;
    selfRepositoryPublication?: {
      effectsEnabled?: boolean;
    };
    conversationTransport?: {
      effectsEnabled?: boolean;
      bridge: ConversationTransportBridgePort;
    };
  } = {},
): Promise<ServerFixture> {
  const root = await mkdtemp(join(tmpdir(), "devspace-server-test-"));
  const project = join(root, "project");
  const agentDir = join(root, "agent");
  const stateDir = join(root, ".state");

  await mkdir(join(project, ".devspace", "agents"), { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "AGENTS.md"), "global instructions\n");
  await writeFile(join(project, "AGENTS.md"), "project instructions\n");
  await writeFile(join(project, ".devspace", "agents", "reviewer.md"), [
    "---",
    "name: reviewer",
    "description: Reviews project changes.",
    "provider: codex",
    "---",
    "Review changes.",
  ].join("\n"));
  if (options.zesResearchCycleMode && options.zesResearchCycleMode !== "off") {
    const controlKernel = join(project, "packages", "zes-control-kernel");
    await mkdir(controlKernel, { recursive: true });
    await writeFile(
      join(controlKernel, "pyproject.toml"),
      "[project]\nname = \"zes-control-kernel\"\nversion = \"0.0.0\"\n",
    );
  }
  let hostSkillPath: string | undefined;
  if (options.skillFixtures) {
    const projectSkillDir = join(project, ".agents", "skills", "project-helper");
    const hostSkillDir = join(agentDir, "skills", "host-specialist");
    await mkdir(projectSkillDir, { recursive: true });
    await mkdir(hostSkillDir, { recursive: true });
    await writeFile(
      join(projectSkillDir, "SKILL.md"),
      [
        "---",
        "name: project-helper",
        "description: Project-local helper procedure.",
        "---",
        "",
        "# Project Helper",
      ].join("\n"),
    );
    hostSkillPath = join(hostSkillDir, "SKILL.md");
    await writeFile(
      hostSkillPath,
      [
        "---",
        "name: host-specialist",
        "description: Host specialist procedure for a rare capability.",
        "---",
        "",
        "# Host Specialist",
      ].join("\n"),
    );
  }

  let ownerRemote: string | undefined;
  if (options.git) {
    await writeFile(join(project, "README.md"), "hello\n");
    await git(project, ["init"]);
    await git(project, ["config", "user.email", "devspace@example.com"]);
    await git(project, ["config", "user.name", "DevSpace Test"]);
    await git(project, ["add", "."]);
    await git(project, ["commit", "-m", "Initial commit"]);
    if (options.selfRepositoryPublication) {
      ownerRemote = join(root, "owner.git");
      await git(root, ["init", "--bare", ownerRemote]);
      await git(project, ["remote", "add", "owner", ownerRemote]);
      await git(project, ["push", "owner", "HEAD:refs/heads/main"]);
    }
  }

  const config = loadConfig({
    DEVSPACE_CONFIG_DIR: join(root, ".config"),
    DEVSPACE_ALLOWED_ROOTS: root,
    DEVSPACE_WORKTREE_ROOT: join(root, ".worktrees"),
    DEVSPACE_STATE_DIR: stateDir,
    DEVSPACE_AGENT_DIR: agentDir,
    DEVSPACE_WIDGETS: "full",
    DEVSPACE_TOOL_MODE: options.toolMode ?? "full",
    DEVSPACE_CODEX_NAVIGATION_TOOLS: options.codexNavigationTools ? "1" : "0",
    DEVSPACE_SKILLS: options.skillsEnabled === false ? "0" : "1",
    DEVSPACE_SUBAGENTS: options.subagents ? "1" : "0",
    ...(options.zesResearchCycleMode
      ? {
          DEVSPACE_ZES_RESEARCH_CYCLE_MODE: options.zesResearchCycleMode,
          DEVSPACE_ZES_RESEARCH_REPOSITORY_ROOT: project,
          DEVSPACE_ZES_RESEARCH_STATE_ROOT: join(
            stateDir,
            "zes-research-cycles",
          ),
        }
      : {}),
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    ...(ownerRemote
      ? {
          DEVSPACE_SELF_REPOSITORY_PUBLICATION: "1",
          DEVSPACE_SELF_REPOSITORY_PUBLICATION_EFFECTS:
            options.selfRepositoryPublication?.effectsEnabled ? "1" : "0",
          DEVSPACE_SELF_REPOSITORY_ROOT: project,
          DEVSPACE_SELF_REPOSITORY_REMOTE: "owner",
          DEVSPACE_SELF_REPOSITORY_BRANCH: "main",
          DEVSPACE_SELF_REPOSITORY_EXPECTED_REMOTE_URL: ownerRemote,
        }
      : {}),
    ...(options.conversationTransport
      ? {
          DEVSPACE_CONVERSATION_TRANSPORT: "1",
          DEVSPACE_CONVERSATION_TRANSPORT_EFFECTS:
            options.conversationTransport.effectsEnabled ? "1" : "0",
          DEVSPACE_CONVERSATION_TRANSPORT_BRIDGE_SOCKET: join(
            root,
            "conversation-transport-bridge.sock",
          ),
        }
      : {}),
    PORT: "1",
  });
  const store = new SqliteWorkspaceStore(stateDir);
  const workspaces = new WorkspaceRegistry(config, store);
  const processSessions = new ProcessSessionManager();
  const conversationTransportRuntime = options.conversationTransport
    ? new ConversationTransportRuntime(
        config.conversationTransport,
        stateDir,
        { bridge: options.conversationTransport.bridge },
      )
    : undefined;
  const executionScopes = options.useDefaultExecutionScopes
    ? undefined
    : new ExecutionScopeManager(
        config.executionObservability,
        stateDir,
        processSessions,
      );
  const localAgentCoordinator = options.subagents
    ? new LocalAgentCoordinator(config, options.localAgentCoordinatorOptions)
    : undefined;
  const runtimeCapabilities = options.runtimeCapabilities
    ? new RuntimeCapabilityRegistry(config, {
        now: () => 1_000,
        instanceRef: "1111111111111111",
      })
    : undefined;
  const server = executionScopes
    ? createMcpServer(
        config,
        workspaces,
        createReviewCheckpointManager(),
        processSessions,
        [],
        [],
        executionScopes,
        undefined,
        localAgentCoordinator,
        undefined,
        runtimeCapabilities,
        undefined,
        options.continuationPreflightProjector,
        options.scopePublicationPreflight,
        conversationTransportRuntime,
      )
    : createMcpServer(
        config,
        workspaces,
        createReviewCheckpointManager(),
        processSessions,
        [],
        [],
        undefined,
        undefined,
        localAgentCoordinator,
        undefined,
        runtimeCapabilities,
        undefined,
        options.continuationPreflightProjector,
        options.scopePublicationPreflight,
        conversationTransportRuntime,
      );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "devspace-test-client", version: "1.0.0" });
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await client.close();
    await server.close();
    processSessions.shutdown();
    localAgentCoordinator?.close();
    conversationTransportRuntime?.close();
    executionScopes?.close();
    store.close();
  };

  t.after(async () => {
    await close();
    await rm(root, { recursive: true, force: true });
  });

  return {
    client,
    project,
    config,
    stateDir,
    hostSkillPath,
    localAgentCoordinator,
    conversationTransportRuntime,
    runtimeCapabilities,
    ownerRemote,
    close,
  };
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

async function callOpen(
  client: Client,
  path: string,
  conversationScopeId?: string,
  mode?: "checkout" | "worktree",
): Promise<Awaited<ReturnType<Client["callTool"]>>> {
  const params = {
    name: "open_workspace",
    arguments: {
      path,
      ...(mode ? { mode } : {}),
    },
    ...(conversationScopeId
      ? { _meta: { "openai/session": conversationScopeId } }
      : {}),
  } as Parameters<Client["callTool"]>[0];
  return client.callTool(params);
}

function structuredContent(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  assert.ok(result.structuredContent);
  return result.structuredContent as Record<string, unknown>;
}

function structuredData(
  result: Awaited<ReturnType<Client["callTool"]>>,
): Record<string, any> {
  const structured = structuredContent(result);
  const data = structured.data;
  assert.ok(data && typeof data === "object");
  return data as Record<string, any>;
}

function responseText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = (result as { content?: unknown }).content;
  assert.ok(Array.isArray(content));
  const first = content[0] as { type?: unknown; text?: unknown } | undefined;
  assert.equal(first?.type, "text");
  assert.equal(typeof first?.text, "string");
  return first?.text as string;
}

function responseAllText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = (result as { content?: unknown }).content;
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

function responseCard(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  const metadata = result._meta;
  assert.ok(metadata && typeof metadata === "object");
  const card = (metadata as Record<string, unknown>).card;
  assert.ok(card && typeof card === "object");
  return card as Record<string, unknown>;
}
