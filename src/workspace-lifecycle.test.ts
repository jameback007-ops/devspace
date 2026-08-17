import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { loadConfig, type ServerConfig } from "./config.js";
import { ProcessSessionManager } from "./process-sessions.js";
import { WorkspaceLifecycleManager } from "./workspace-lifecycle.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";
import { WorkspaceRegistry } from "./workspaces.js";

const execFileAsync = promisify(execFile);

test("digest-bound workspace GC removes only clean old published worktrees", async (t) => {
  const context = await fixture(t);
  const firstStore = new SqliteWorkspaceStore(context.config.stateDir);
  const firstRegistry = new WorkspaceRegistry(context.config, firstStore);
  const opened = await firstRegistry.openWorkspace({
    path: context.repository,
    mode: "worktree",
  });
  firstStore.close();

  const store = new SqliteWorkspaceStore(context.config.stateDir);
  const registry = new WorkspaceRegistry(context.config, store);
  const processes = new ProcessSessionManager();
  const future = Date.now() + 48 * 60 * 60 * 1_000;
  const lifecycle = new WorkspaceLifecycleManager(
    context.config,
    store,
    registry,
    processes,
    () => future,
  );
  t.after(() => {
    processes.shutdown();
    store.close();
  });

  const preview = await lifecycle.preview({
    olderThanHours: 24,
    capsuleProtectionHours: 1,
  });
  assert.equal(preview.summary.eligibleCount, 1);
  assert.equal(preview.items[0]?.workspaceId, opened.workspace.id);
  assert.equal(preview.items[0]?.eligible, true);

  const result = await lifecycle.execute({
    olderThanHours: 24,
    capsuleProtectionHours: 1,
    planIdSha256: preview.planIdSha256,
  });
  assert.equal(result.removedCount, 1);
  assert.equal(await exists(opened.workspace.root), false);
  assert.equal(store.getSession(opened.workspace.id)?.status, "closed");
  assert.throws(() => registry.getWorkspace(opened.workspace.id), /is closed/);
});

test("workspace GC protects dirty trees, unpublished commits, loaded workspaces, and running commands", async (t) => {
  const context = await fixture(t);
  const firstStore = new SqliteWorkspaceStore(context.config.stateDir);
  const firstRegistry = new WorkspaceRegistry(context.config, firstStore);
  const dirty = await firstRegistry.openWorkspace({ path: context.repository, mode: "worktree" });
  const unpublished = await firstRegistry.openWorkspace({ path: context.repository, mode: "worktree" });
  const loaded = await firstRegistry.openWorkspace({ path: context.repository, mode: "worktree" });
  const running = await firstRegistry.openWorkspace({ path: context.repository, mode: "worktree" });
  await writeFile(join(dirty.workspace.root, "dirty.txt"), "dirty\n");
  await writeFile(join(unpublished.workspace.root, "unpublished.txt"), "unpublished\n");
  await git(unpublished.workspace.root, ["add", "."]);
  await git(unpublished.workspace.root, ["commit", "-m", "Unpublished detached commit"]);
  firstStore.close();

  const store = new SqliteWorkspaceStore(context.config.stateDir);
  const registry = new WorkspaceRegistry(context.config, store);
  registry.getWorkspace(loaded.workspace.id);
  const processes = new ProcessSessionManager();
  const node = JSON.stringify(process.execPath);
  const runningCommand = await processes.start({
    workspaceId: running.workspace.id,
    workspaceRoot: running.workspace.root,
    cwd: running.workspace.root,
    command: `${node} -e "setTimeout(() => {}, 5000)"`,
    yieldTimeMs: 5,
  });
  assert.equal(runningCommand.running, true);
  assert.ok(runningCommand.sessionId);

  const lifecycle = new WorkspaceLifecycleManager(
    context.config,
    store,
    registry,
    processes,
    () => Date.now() + 48 * 60 * 60 * 1_000,
  );
  t.after(async () => {
    if (runningCommand.sessionId) {
      try {
        processes.terminate(running.workspace.id, runningCommand.sessionId);
        await processes.write({
          workspaceId: running.workspace.id,
          sessionId: runningCommand.sessionId,
          yieldTimeMs: 2_000,
        });
      } catch {
        // The process may already be terminal during test cleanup.
      }
    }
    processes.shutdown();
    store.close();
  });

  const preview = await lifecycle.preview({ olderThanHours: 24, capsuleProtectionHours: 1 });
  const byId = new Map(preview.items.map((item) => [item.workspaceId, item]));
  assert.ok(byId.get(dirty.workspace.id)?.protectedReasons.includes("dirty_worktree"));
  assert.ok(
    byId.get(unpublished.workspace.id)?.protectedReasons.includes(
      "head_not_reachable_from_persistent_ref",
    ),
  );
  assert.ok(byId.get(loaded.workspace.id)?.protectedReasons.includes("loaded_in_current_runtime"));
  assert.ok(
    byId.get(running.workspace.id)?.protectedReasons.includes(
      "running_devspace_process_session",
    ),
  );
  assert.equal(preview.summary.eligibleCount, 0);
});

test("workspace GC rejects a stale plan after Git state changes", async (t) => {
  const context = await fixture(t);
  const firstStore = new SqliteWorkspaceStore(context.config.stateDir);
  const firstRegistry = new WorkspaceRegistry(context.config, firstStore);
  const opened = await firstRegistry.openWorkspace({ path: context.repository, mode: "worktree" });
  firstStore.close();

  const store = new SqliteWorkspaceStore(context.config.stateDir);
  const registry = new WorkspaceRegistry(context.config, store);
  const processes = new ProcessSessionManager();
  const lifecycle = new WorkspaceLifecycleManager(
    context.config,
    store,
    registry,
    processes,
    () => Date.now() + 48 * 60 * 60 * 1_000,
  );
  t.after(() => {
    processes.shutdown();
    store.close();
  });

  const preview = await lifecycle.preview({ olderThanHours: 24, capsuleProtectionHours: 1 });
  assert.equal(preview.summary.eligibleCount, 1);
  await writeFile(join(opened.workspace.root, "changed-after-preview.txt"), "changed\n");
  await assert.rejects(
    () => lifecycle.execute({
      olderThanHours: 24,
      capsuleProtectionHours: 1,
      planIdSha256: preview.planIdSha256,
    }),
    /Workspace GC plan changed/,
  );
});

interface Fixture {
  root: string;
  repository: string;
  config: ServerConfig;
}

async function fixture(t: TestContext): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "devspace-workspace-lifecycle-test-"));
  const repository = join(root, "repository");
  await mkdir(repository, { recursive: true });
  await writeFile(join(repository, "README.md"), "initial\n");
  await git(repository, ["init"]);
  await git(repository, ["config", "user.email", "devspace@example.com"]);
  await git(repository, ["config", "user.name", "DevSpace Test"]);
  await git(repository, ["add", "."]);
  await git(repository, ["commit", "-m", "Initial commit"]);

  const config = loadConfig({
    DEVSPACE_CONFIG_DIR: join(root, ".config"),
    DEVSPACE_STATE_DIR: join(root, ".state"),
    DEVSPACE_ALLOWED_ROOTS: root,
    DEVSPACE_WORKTREE_ROOT: join(root, ".worktrees"),
    DEVSPACE_AGENT_DIR: join(root, ".agent"),
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    PORT: "1",
  });
  t.after(async () => rm(root, { recursive: true, force: true }));
  return { root, repository, config };
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

async function exists(path: string): Promise<boolean> {
  try {
    await execFileAsync(process.platform === "win32" ? "cmd" : "test", process.platform === "win32"
      ? ["/c", "if", "exist", path, "(exit", "0)", "else", "(exit", "1)"]
      : ["-e", path]);
    return true;
  } catch {
    return false;
  }
}
