import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openDatabase } from "./db/client.js";
import {
  ExecutionScopeManager,
  summarizeExecutionToolInput,
  type ExecutionObservabilityConfig,
} from "./execution-observability.js";
import { ProcessSessionManager } from "./process-sessions.js";
import { executionScopeIdentity } from "./request-meta.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";

const config: ExecutionObservabilityConfig = {
  enabled: true,
  retentionMs: 7 * 24 * 60 * 60 * 1_000,
  maxEventsPerScope: 100,
  idleAfterMs: 5 * 60 * 1_000,
};

test("execution scope inspection joins durable audit with live workspace and process state", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-execution-observability-"));
  const stateDir = join(root, ".state");
  const project = join(root, "project");
  await mkdir(project, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));

  let now = Date.parse("2026-08-17T00:00:00Z");
  const workspaceStore = new SqliteWorkspaceStore(stateDir);
  workspaceStore.createSession({ id: "ws_test", root: project });
  const processes = new ProcessSessionManager();
  const manager = new ExecutionScopeManager(
    config,
    stateDir,
    processes,
    { now: () => now },
  );
  t.after(() => {
    processes.shutdown();
    manager.close();
    workspaceStore.close();
  });

  const identity = executionScopeIdentity({ "openai/session": "private-chat-session" });
  assert.ok(identity);

  const command = "printf secret-value-from-command && sleep 10";
  const process = await processes.start({
    workspaceId: "ws_test",
    executionScopeRef: identity.scopeRef,
    workspaceRoot: project,
    cwd: project,
    command,
    yieldTimeMs: 1,
  });
  assert.equal(process.running, true);
  assert.ok(process.sessionId);
  const foreignProcess = await processes.start({
    workspaceId: "ws_test",
    executionScopeRef: "ffffffffffffffff",
    workspaceRoot: project,
    cwd: project,
    command: "sleep 10",
    yieldTimeMs: 1,
  });
  assert.equal(foreignProcess.running, true);
  assert.ok(foreignProcess.sessionId);

  const handle = manager.beginTool(identity, "exec_command", {
    workspaceId: "ws_test",
    cmd: command,
    workingDirectory: ".",
  });
  assert.ok(handle);
  now += 250;
  manager.finishTool(handle, "succeeded", {
    response: {
      structuredContent: {
        workspaceId: "ws_test",
        sessionId: process.sessionId,
        running: true,
        wallTimeMs: 1,
        outputTruncated: false,
      },
    },
  });

  const inspectionDatabase = openDatabase(stateDir);
  try {
    const storedScope = inspectionDatabase.sqlite
      .prepare(
        "select scope_ref, scope_digest_sha256 from execution_scopes where scope_ref = ?",
      )
      .get(identity.scopeRef) as Record<string, unknown> | undefined;
    assert.deepEqual(storedScope, {
      scope_ref: identity.scopeRef,
      scope_digest_sha256: identity.scopeDigestSha256,
    });
    assert.equal(JSON.stringify(storedScope).includes(identity.scopeId), false);
    const columns = inspectionDatabase.sqlite
      .prepare("pragma table_info(execution_scopes)")
      .all() as Array<{ name: string }>;
    assert.equal(columns.some((column) => column.name === "scope_id"), false);
  } finally {
    inspectionDatabase.close();
  }

  const listed = manager.list(identity, 10);
  const serializedList = JSON.stringify(listed);
  assert.equal(serializedList.includes("private-chat-session"), false);
  assert.equal(serializedList.includes("secret-value-from-command"), false);
  const scopes = listed.scopes as Array<Record<string, unknown>>;
  assert.equal(scopes.length, 1);
  assert.equal(scopes[0]?.scopeRef, identity.scopeRef);
  assert.equal(scopes[0]?.isCurrent, true);
  assert.equal(scopes[0]?.activityState, "running");
  assert.equal(scopes[0]?.workspaceCount, 1);
  assert.equal(scopes[0]?.runningProcessCount, 1);
  assert.equal(scopes[0]?.otherOrUnattributedRunningProcessCount, 1);
  const listedObservation = scopes[0]?.observation as Record<string, unknown>;
  assert.equal(listedObservation.observableExecutorState, "process_running");
  assert.equal(listedObservation.blindIntervalActive, false);
  assert.equal(listedObservation.modelProgressObservable, false);
  assert.equal(listedObservation.providerGenerationObservable, false);
  assert.equal(listedObservation.modelState, "not_observed");
  assert.equal(listedObservation.hungDetermination, "unavailable");

  const status = manager.status(identity.scopeRef, undefined);
  const workspaces = status.workspaces as Array<Record<string, unknown>>;
  const liveProcesses = status.processes as Array<Record<string, unknown>>;
  assert.equal(workspaces[0]?.workspaceId, "ws_test");
  assert.equal(workspaces[0]?.root, project);
  assert.equal(liveProcesses[0]?.sessionId, process.sessionId);
  assert.equal(liveProcesses.length, 1);
  assert.equal(liveProcesses[0]?.running, true);
  assert.equal(status.otherOrUnattributedRunningProcessCount, 1);
  assert.equal("command" in (liveProcesses[0] ?? {}), false);
  assert.equal(JSON.stringify(status).includes(command), false);

  const audit = manager.audit(identity.scopeRef, undefined, { limit: 10 });
  const events = audit.events as Array<Record<string, unknown>>;
  assert.equal(events.length, 1);
  assert.equal(events[0]?.tool, "exec_command");
  assert.equal(events[0]?.outcome, "succeeded");
  const detail = events[0]?.detail as Record<string, unknown>;
  assert.equal(detail.cmdLength, command.length);
  assert.match(String(detail.cmdDigestSha256), /^[a-f0-9]{64}$/);
  assert.equal("cmd" in detail, false);
  assert.equal(JSON.stringify(audit).includes("secret-value-from-command"), false);
  const summary = audit.summary as Record<string, unknown>;
  assert.equal(summary.events, 1);
  assert.equal(summary.succeeded, 1);
  assert.equal(summary.failed, 0);
  const byTool = summary.byTool as Record<string, Record<string, unknown>>;
  assert.equal(byTool.exec_command?.calls, 1);
  assert.equal(byTool.exec_command?.succeeded, 1);
  assert.equal(byTool.exec_command?.failed, 0);

  processes.terminate("ws_test", process.sessionId);
  await processes.write({
    workspaceId: "ws_test",
    sessionId: process.sessionId,
    yieldTimeMs: 2_000,
  });
  processes.terminate("ws_test", foreignProcess.sessionId);
  await processes.write({
    workspaceId: "ws_test",
    sessionId: foreignProcess.sessionId,
    yieldTimeMs: 2_000,
  });
});

test("current scope inspection is available before the first audited executor event", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-execution-unmaterialized-current-"));
  const stateDir = join(root, ".state");
  t.after(() => rm(root, { recursive: true, force: true }));
  const processes = new ProcessSessionManager();
  const manager = new ExecutionScopeManager(config, stateDir, processes);
  t.after(() => {
    processes.shutdown();
    manager.close();
  });

  const identity = executionScopeIdentity({ "openai/session": "fresh-current-scope" });
  assert.ok(identity);

  const listed = manager.list(identity, 10);
  const listedScopes = listed.scopes as Array<Record<string, unknown>>;
  assert.equal(listedScopes.length, 1);
  assert.equal(listedScopes[0]?.scopeRef, identity.scopeRef);
  assert.equal(listedScopes[0]?.isCurrent, true);
  assert.equal(listedScopes[0]?.materialized, false);
  assert.equal(listedScopes[0]?.activityState, "unobserved");
  assert.equal(listedScopes[0]?.totalEventCount, 0);
  const listedObservation = listedScopes[0]?.observation as Record<string, unknown>;
  assert.equal(
    listedObservation.observableExecutorState,
    "no_observed_tool_or_process_yet",
  );
  assert.equal(listedObservation.hungDetermination, "unavailable");

  const status = manager.status(undefined, identity);
  const statusScope = status.scope as Record<string, unknown>;
  assert.equal(statusScope.scopeRef, identity.scopeRef);
  assert.equal(statusScope.materialized, false);
  assert.deepEqual(status.workspaces, []);
  assert.deepEqual(status.processes, []);

  const audit = manager.audit(undefined, identity, { limit: 10 });
  assert.equal(audit.scopeRef, identity.scopeRef);
  assert.equal(audit.currentScopeMaterialized, false);
  assert.deepEqual(audit.events, []);

  const inspectionDatabase = openDatabase(stateDir);
  try {
    const stored = inspectionDatabase.sqlite
      .prepare("select count(*) as count from execution_scopes where scope_ref = ?")
      .get(identity.scopeRef) as { count: number };
    assert.equal(stored.count, 0, "inspection-only calls must not create audit state");
  } finally {
    inspectionDatabase.close();
  }

  const handle = manager.beginTool(identity, "read", { path: "AGENTS.md" });
  manager.finishTool(handle, "succeeded");
  const afterActivity = manager.list(identity, 10);
  const materialized = (afterActivity.scopes as Array<Record<string, unknown>>)[0];
  assert.equal(materialized?.scopeRef, identity.scopeRef);
  assert.equal(materialized?.materialized, true);
  assert.equal(materialized?.totalEventCount, 1);
});

test("unfinished observations recover as interrupted after a server restart", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-execution-recovery-"));
  const stateDir = join(root, ".state");
  t.after(() => rm(root, { recursive: true, force: true }));
  let now = Date.parse("2026-08-17T01:00:00Z");

  const firstProcesses = new ProcessSessionManager();
  const first = new ExecutionScopeManager(
    config,
    stateDir,
    firstProcesses,
    { now: () => now },
  );
  const identity = executionScopeIdentity({
    "devspace/execution-scope": "generic-private-scope",
  });
  assert.ok(identity);
  first.beginTool(identity, "apply_patch", {
    workspaceId: "ws_missing",
    patch: "*** Begin Patch\n*** Update File: src/example.ts\n@@\n-secret\n+replacement\n*** End Patch",
  });
  first.close();
  firstProcesses.shutdown();

  now += 5_000;
  const secondProcesses = new ProcessSessionManager();
  const second = new ExecutionScopeManager(
    config,
    stateDir,
    secondProcesses,
    { now: () => now },
  );
  t.after(() => {
    secondProcesses.shutdown();
    second.close();
  });

  const audit = second.audit(identity.scopeRef, undefined, { limit: 10 });
  const events = audit.events as Array<Record<string, unknown>>;
  assert.equal(events[0]?.outcome, "interrupted");
  assert.equal(events[0]?.errorKind, "server_restart");
  assert.equal(JSON.stringify(audit).includes("generic-private-scope"), false);
  assert.equal(JSON.stringify(audit).includes("replacement"), false);
  const detail = events[0]?.detail as Record<string, unknown>;
  assert.deepEqual(detail.patchPaths, ["src/example.ts"]);
  const status = second.status(identity.scopeRef, undefined);
  const statusScope = status.scope as Record<string, unknown>;
  assert.equal(statusScope.activityState, "recent");
  const observation = statusScope.observation as Record<string, unknown>;
  assert.equal(observation.observableExecutorState, "no_running_tool_or_process");
  assert.equal(observation.blindIntervalActive, true);
  assert.equal(observation.modelProgressObservable, false);
  assert.equal(observation.hungDetermination, "unavailable");
});

test("audit retention is bounded per scope and paginated with opaque cursors", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-execution-retention-"));
  const stateDir = join(root, ".state");
  t.after(() => rm(root, { recursive: true, force: true }));
  let now = Date.parse("2026-08-17T02:00:00Z");
  const processes = new ProcessSessionManager();
  const manager = new ExecutionScopeManager(
    { ...config, maxEventsPerScope: 3 },
    stateDir,
    processes,
    { now: () => now },
  );
  t.after(() => {
    processes.shutdown();
    manager.close();
  });
  const identity = executionScopeIdentity({ "openai/session": "retention-scope" });
  assert.ok(identity);

  for (let index = 0; index < 5; index += 1) {
    const handle = manager.beginTool(identity, "read", {
      workspaceId: "ws_missing",
      path: `src/${index}.ts`,
    });
    now += 1;
    manager.finishTool(handle, "succeeded");
  }

  const firstPage = manager.audit(identity.scopeRef, undefined, { limit: 2 });
  const firstEvents = firstPage.events as Array<Record<string, unknown>>;
  assert.deepEqual(firstEvents.map((event) => event.sequence), [5, 4]);
  assert.equal(typeof firstPage.nextCursor, "string");
  assert.equal(String(firstPage.nextCursor).includes("4"), false);
  const secondPage = manager.audit(identity.scopeRef, undefined, {
    limit: 2,
    cursor: String(firstPage.nextCursor),
  });
  const secondEvents = secondPage.events as Array<Record<string, unknown>>;
  assert.deepEqual(secondEvents.map((event) => event.sequence), [3]);
  assert.equal(secondPage.nextCursor, undefined);

  const listed = manager.list(identity, 10);
  const scopes = listed.scopes as Array<Record<string, unknown>>;
  assert.equal(scopes[0]?.totalEventCount, 5);
});

test("sensitive tool fields are represented only by bounded metadata", () => {
  const detail = summarizeExecutionToolInput("write_stdin", {
    workspaceId: "ws_1",
    sessionId: 7,
    chars: "secret-input\n",
    prompt: "private model prompt",
  });
  assert.equal(detail.charactersWritten, 13);
  assert.equal(detail.pollOnly, false);
  assert.equal(detail.promptLength, "private model prompt".length);
  assert.match(String(detail.promptDigestSha256), /^[a-f0-9]{64}$/);
  const serialized = JSON.stringify(detail);
  assert.equal(serialized.includes("secret-input"), false);
  assert.equal(serialized.includes("private model prompt"), false);
});

test("global retention prunes inactive scopes during later activity", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-execution-global-retention-"));
  const stateDir = join(root, ".state");
  t.after(() => rm(root, { recursive: true, force: true }));
  let now = Date.parse("2026-08-17T03:00:00Z");
  const processes = new ProcessSessionManager();
  const manager = new ExecutionScopeManager(
    { ...config, retentionMs: 1_000 },
    stateDir,
    processes,
    { now: () => now },
  );
  t.after(() => {
    processes.shutdown();
    manager.close();
  });
  const first = executionScopeIdentity({ "openai/session": "expired-scope" });
  const second = executionScopeIdentity({ "openai/session": "current-scope" });
  const running = executionScopeIdentity({ "openai/session": "running-scope" });
  assert.ok(first);
  assert.ok(second);
  assert.ok(running);
  const firstHandle = manager.beginTool(first, "read", { path: "first" });
  manager.finishTool(firstHandle, "succeeded");
  const runningHandle = manager.beginTool(running, "exec_command", {
    cmd: "long-running command",
  });

  now += 2_000;
  const secondHandle = manager.beginTool(second, "read", { path: "second" });
  manager.finishTool(secondHandle, "succeeded");

  const listed = manager.list(second, 10);
  const refs = (listed.scopes as Array<Record<string, unknown>>).map(
    (scope) => scope.scopeRef,
  );
  assert.deepEqual(refs, [second.scopeRef, running.scopeRef]);
  const runningAudit = manager.audit(running.scopeRef, undefined);
  assert.equal(
    (runningAudit.events as Array<Record<string, unknown>>)[0]?.outcome,
    "running",
  );
  assert.throws(
    () => manager.audit(first.scopeRef, undefined),
    /Unknown execution scope/,
  );
  manager.finishTool(runningHandle, "interrupted");
});

test("arbitrary exception messages never enter cross-scope audit", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-execution-error-redaction-"));
  const stateDir = join(root, ".state");
  t.after(() => rm(root, { recursive: true, force: true }));
  const processes = new ProcessSessionManager();
  const manager = new ExecutionScopeManager(config, stateDir, processes);
  t.after(() => {
    processes.shutdown();
    manager.close();
  });
  const identity = executionScopeIdentity({ "openai/session": "error-scope" });
  assert.ok(identity);
  const handle = manager.beginTool(identity, "exec_command", {
    cmd: "secret command",
  });
  const error = Object.assign(
    new Error("token=short-secret and secret command appeared here"),
    { code: "EFAIL" },
  );
  manager.finishTool(handle, "error", { error });

  const audit = manager.audit(identity.scopeRef, undefined, { limit: 10 });
  const serialized = JSON.stringify(audit);
  assert.equal(serialized.includes("short-secret"), false);
  assert.equal(serialized.includes("secret command appeared here"), false);
  const event = (audit.events as Array<Record<string, unknown>>)[0];
  assert.equal(event?.errorKind, "Error:EFAIL");
  assert.equal(
    event?.errorSummary,
    "Tool failed with EFAIL. Inspect the originating scope for details.",
  );
  assert.match(String(event?.errorDigestSha256), /^[a-f0-9]{64}$/);
});
