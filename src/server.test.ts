import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig, type ServerConfig } from "./config.js";
import { ExecutionScopeManager } from "./execution-observability.js";
import {
  LocalAgentCoordinator,
  type LocalAgentCoordinatorOptions,
} from "./local-agent-coordinator.js";
import { createReviewCheckpointManager } from "./review-checkpoints.js";
import { ProcessSessionManager } from "./process-sessions.js";
import { createMcpServer } from "./server.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";
import { WorkspaceRegistry } from "./workspaces.js";

const execFileAsync = promisify(execFile);

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
      worktreeState: "clean",
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

test("one host scope can inspect another through bounded execution-scope tools", async (t) => {
  const context = await fixture(t, { toolMode: "codex" });
  const workerSession = "worker-private-session-id";
  const supervisorSession = "supervisor-private-session-id";
  const opened = await callOpen(context.client, context.project, workerSession);
  const workspaceId = String(structuredContent(opened).workspaceId);
  await context.client.callTool({
    name: "read",
    arguments: { workspaceId, path: "AGENTS.md" },
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
  assert.equal(scopes.length, 1);
  const scopeRef = String(scopes[0]?.scopeRef);
  assert.match(scopeRef, /^[a-f0-9]{16}$/);
  assert.equal(scopes[0]?.isCurrent, false);
  assert.equal(JSON.stringify(listData).includes(workerSession), false);
  assert.equal(JSON.stringify(listData).includes(supervisorSession), false);

  const status = await context.client.callTool({
    name: "execution_scope_status",
    arguments: { scopeRef },
    _meta: { "openai/session": supervisorSession },
  } as Parameters<Client["callTool"]>[0]);
  const statusData = structuredData(status);
  const workspaces = statusData.workspaces as Array<Record<string, unknown>>;
  assert.equal(workspaces[0]?.workspaceId, workspaceId);
  assert.equal(workspaces[0]?.root, context.project);
  assert.equal((statusData.policy as Record<string, unknown>).transcriptCaptured, false);

  const audit = await context.client.callTool({
    name: "execution_scope_audit",
    arguments: { scopeRef, limit: 10 },
    _meta: { "openai/session": supervisorSession },
  } as Parameters<Client["callTool"]>[0]);
  const auditData = structuredData(audit);
  const events = auditData.events as Array<Record<string, unknown>>;
  assert.deepEqual(
    events.map((event) => event.tool),
    ["read", "open_workspace"],
  );
  const serializedAudit = JSON.stringify(auditData);
  assert.equal(serializedAudit.includes(workerSession), false);
  assert.equal(serializedAudit.includes("project instructions"), false);
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

interface ServerFixture {
  client: Client;
  project: string;
  config: ServerConfig;
  stateDir: string;
  hostSkillPath?: string;
  localAgentCoordinator?: LocalAgentCoordinator;
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
    localAgentCoordinatorOptions?: LocalAgentCoordinatorOptions;
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

  if (options.git) {
    await writeFile(join(project, "README.md"), "hello\n");
    await git(project, ["init"]);
    await git(project, ["config", "user.email", "devspace@example.com"]);
    await git(project, ["config", "user.name", "DevSpace Test"]);
    await git(project, ["add", "."]);
    await git(project, ["commit", "-m", "Initial commit"]);
  }

  const config = loadConfig({
    DEVSPACE_CONFIG_DIR: join(root, ".config"),
    DEVSPACE_ALLOWED_ROOTS: root,
    DEVSPACE_WORKTREE_ROOT: join(root, ".worktrees"),
    DEVSPACE_STATE_DIR: stateDir,
    DEVSPACE_AGENT_DIR: agentDir,
    DEVSPACE_WIDGETS: "full",
    DEVSPACE_TOOL_MODE: options.toolMode ?? "full",
    DEVSPACE_SKILLS: options.skillsEnabled === false ? "0" : "1",
    DEVSPACE_SUBAGENTS: options.subagents ? "1" : "0",
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    PORT: "1",
  });
  const store = new SqliteWorkspaceStore(stateDir);
  const workspaces = new WorkspaceRegistry(config, store);
  const processSessions = new ProcessSessionManager();
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
