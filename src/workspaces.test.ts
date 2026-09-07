import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { homedir, platform, tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { loadConfig, type ServerConfig } from "./config.js";
import { GitWorktreeError } from "./git-worktrees.js";
import { formatPathForPrompt } from "./skills.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";
import {
  ensureCheckoutWorkspaceRoot,
  WorkspaceRegistry,
  WorkspaceRootError,
} from "./workspaces.js";

const execFileAsync = promisify(execFile);

test("a checkout exposes initial and nested instruction context while filtering outside symlinks", async (t) => {
  const context = await fixture(t);
  const opened = await context.registry.openWorkspace(context.root);

  assert.match(opened.workspace.id, /^ws_[a-f0-9]{10}$/);
  assert.equal(opened.workspace.mode, "checkout");
  assert.deepEqual(
    opened.agentsFiles.map((file) => file.content),
    ["global instructions\n", "root instructions\n"],
  );
  assert.deepEqual(
    opened.availableAgentsFiles.map((file) => file.path),
    [join(context.root, "nested", "AGENTS.md")],
  );
  assert.deepEqual(
    opened.workspace.agentProfiles.map((profile) => ({
      name: profile.name,
      description: profile.description,
      provider: profile.provider,
      body: profile.body,
    })),
    [{
      name: "reviewer",
      description: "Read-only project reviewer.",
      provider: "codex",
      body: "Review only.",
    }],
  );

  if (platform() !== "win32") {
    const unsafeAgentDir = join(context.root, ".pi", "unsafe-agent");
    await mkdir(unsafeAgentDir, { recursive: true });
    await writeFile(join(context.outsideRoot, "secret.txt"), "outside secret\n");
    await symlink(join(context.outsideRoot, "secret.txt"), join(unsafeAgentDir, "AGENTS.md"));

    const unsafeConfig = loadConfig({
      DEVSPACE_CONFIG_DIR: join(context.root, ".devspace-unsafe-home"),
      DEVSPACE_ALLOWED_ROOTS: context.root,
      DEVSPACE_WORKTREE_ROOT: join(context.root, ".devspace", "unsafe-worktrees"),
      DEVSPACE_AGENT_DIR: unsafeAgentDir,
      DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
      PORT: "1",
    });
    const unsafeWorkspace = await new WorkspaceRegistry(unsafeConfig).openWorkspace(context.root);

    assert.deepEqual(
      unsafeWorkspace.agentsFiles.map((file) => file.content),
      ["root instructions\n"],
    );
  }
});

test("opening a missing checkout creates its workspace root", async (t) => {
  const context = await fixture(t);
  const missingRoot = join(context.root, "missing", "workspace");

  const opened = await context.registry.openWorkspace(missingRoot);
  assert.equal(opened.workspace.root, missingRoot);
  assert.equal((await stat(missingRoot)).isDirectory(), true);
});

test(
  "missing checkout roots on Linux kernel filesystems are rejected before mkdir",
  { skip: platform() !== "linux" },
  async (t) => {
    const context = await fixture(t);
    const missingRoot = join(context.root, "missing-kernel-root", "workspace");
    let mkdirCalled = false;

    await assert.rejects(
      () => ensureCheckoutWorkspaceRoot(missingRoot, {
        stat,
        mkdir: async () => {
          mkdirCalled = true;
        },
        filesystemType: async (path) => {
          assert.equal(path, context.root);
          return 0x9fa0n;
        },
      }),
      (error: unknown) =>
        error instanceof WorkspaceRootError
        && error.code === "WORKSPACE_ROOT_UNSAFE_FILESYSTEM"
        && /procfs/.test(error.message),
    );
    assert.equal(mkdirCalled, false);
    await assert.rejects(() => stat(missingRoot), { code: "ENOENT" });
  },
);

test("advertised home-relative skill paths resolve before workspace-relative files", async (t) => {
  const context = await fixture(t);
  const opened = await context.registry.openWorkspace(context.root);
  const baseDir = join(homedir(), ".devspace-skill-path-test");
  const filePath = join(baseDir, "SKILL.md");
  opened.workspace.skills.push({
    name: "home-relative-skill",
    description: "Test home-relative skill path resolution.",
    filePath,
    baseDir,
    sourceInfo: {} as never,
    disableModelInvocation: false,
    exposure: "on-demand",
    workspaceMarkers: [],
    autoAdvertised: false,
  });

  const promptPath = formatPathForPrompt(filePath);
  assert.match(promptPath, /^~\//);
  const resolved = context.registry.resolveReadPath(opened.workspace, promptPath);
  assert.equal(resolved.absolutePath, filePath);
  assert.equal(resolved.skillRead?.isSkillFile, true);
});

test("worktree opens require Git and create an isolated managed workspace", async (t) => {
  const context = await fixture(t);

  await assert.rejects(
    () => context.registry.openWorkspace({ path: context.root, mode: "worktree" }),
    (error: unknown) =>
      error instanceof GitWorktreeError && error.code === "GIT_REPOSITORY_NOT_FOUND",
  );

  const gitRoot = await createGitProject(context.root);
  await writeFile(join(gitRoot, "dirty.txt"), "not copied\n");

  const opened = await context.registry.openWorkspace({ path: gitRoot, mode: "worktree" });

  assert.equal(opened.workspace.mode, "worktree");
  assert.notEqual(opened.workspace.root, gitRoot);
  assert.equal(opened.workspace.sourceRoot, gitRoot);
  assert.equal(opened.workspace.worktree?.baseRef, "HEAD");
  assert.equal(opened.workspace.worktree?.dirtySource, true);
  assert.equal(opened.workspace.worktree?.managed, true);
  assert.equal((await stat(opened.workspace.root)).isDirectory(), true);
  assert.match(opened.agentsFiles.map((file) => file.content).join("\n"), /global instructions/);
  assert.match(opened.agentsFiles.map((file) => file.content).join("\n"), /git root instructions/);

  const resolvedReadme = context.registry.resolvePath(opened.workspace, "README.md");
  assert.equal(resolvedReadme.startsWith(opened.workspace.root), true);
});

test("skill search discovers source added after opening the same workspace", async (t) => {
  const context = await fixture(t);
  const opened = await context.registry.openWorkspace(context.root);
  const skillRoot = join(context.root, ".agents", "skills", "fresh-discovery-probe");
  await writeSearchSkill(skillRoot, "fresh-discovery-probe", "Find the late-added discovery procedure.");

  const found = context.registry.searchSkills(opened.workspace.id, "fresh-discovery-probe");
  assert.deepEqual(found.map((skill) => skill.name), ["fresh-discovery-probe"]);
  assert.equal(context.registry.getWorkspace(opened.workspace.id), opened.workspace);
  assert.equal(opened.workspace.activatedSkillDirs.has(skillRoot), false);
});

test("skill search refreshes descriptions and retains native invalid-source diagnostics", async (t) => {
  const context = await fixture(t);
  const skillRoot = join(context.root, ".agents", "skills", "fresh-description-probe");
  await writeSearchSkill(skillRoot, "fresh-description-probe", "Obsoletezebra procedure.");
  const opened = await context.registry.openWorkspace(context.root);
  assert.equal(context.registry.searchSkills(opened.workspace.id, "obsoletezebra").length, 1);

  await writeSearchSkill(skillRoot, "fresh-description-probe", "Currentotter procedure.");
  assert.equal(context.registry.searchSkills(opened.workspace.id, "obsoletezebra").length, 0);
  assert.equal(context.registry.searchSkills(opened.workspace.id, "currentotter").length, 1);

  await writeFile(join(skillRoot, "SKILL.md"), "---\nname: fresh-description-probe\n---\nMissing description.\n");
  assert.equal(context.registry.searchSkills(opened.workspace.id, "currentotter").length, 0);
  assert.equal(opened.workspace.skillDiagnostics.some((item) => item.path === join(skillRoot, "SKILL.md")), true);
});

test("skill refresh preserves an unchanged external activation and revokes a changed body", async (t) => {
  const context = await fixture(t);
  const hostRoot = join(context.outsideRoot, "skills");
  const skillRoot = join(hostRoot, "fresh-external-probe");
  await writeSearchSkill(skillRoot, "fresh-external-probe", "Externally selected procedure.");
  await writeFile(join(skillRoot, "reference.md"), "Local test reference.\n");
  const registry = new WorkspaceRegistry({ ...context.config, devspaceSkillsDir: hostRoot });
  const opened = await registry.openWorkspace(context.root);
  assert.equal(opened.workspace.skills.some((skill) => skill.name === "fresh-external-probe"), false);
  registry.searchSkills(opened.workspace.id, "fresh-external-probe");
  const skillRead = registry.resolveReadPath(opened.workspace, join(skillRoot, "SKILL.md"));
  registry.markReadPathLoaded(opened.workspace, skillRead);
  registry.searchSkills(opened.workspace.id, "unrelatednomatch");
  assert.equal(registry.resolveReadPath(opened.workspace, join(skillRoot, "reference.md")).skillRead?.isSkillFile, false);

  await writeSearchSkill(skillRoot, "fresh-external-probe", "Externally selected procedure.", "Revised body only.");
  registry.searchSkills(opened.workspace.id, "fresh-external-probe");
  assert.equal(opened.workspace.activatedSkillDirs.has(skillRoot), false);
  assert.throws(() => registry.resolveReadPath(opened.workspace, join(skillRoot, "reference.md")), /outside/);
  registry.markReadPathLoaded(opened.workspace, registry.resolveReadPath(opened.workspace, join(skillRoot, "SKILL.md")));
  assert.equal(registry.resolveReadPath(opened.workspace, join(skillRoot, "reference.md")).skillRead?.isSkillFile, false);
});

test("skill refresh removes disabled and deleted external skill read grants", async (t) => {
  const context = await fixture(t);
  const hostRoot = join(context.outsideRoot, "skills");
  const skillRoot = join(hostRoot, "fresh-removal-probe");
  await writeSearchSkill(skillRoot, "fresh-removal-probe", "Removal probe procedure.");
  await writeFile(join(skillRoot, "reference.md"), "Local test reference.\n");
  const registry = new WorkspaceRegistry({ ...context.config, devspaceSkillsDir: hostRoot });
  const opened = await registry.openWorkspace(context.root);
  registry.searchSkills(opened.workspace.id, "fresh-removal-probe");
  registry.markReadPathLoaded(opened.workspace, registry.resolveReadPath(opened.workspace, join(skillRoot, "SKILL.md")));

  await writeFile(join(skillRoot, "SKILL.md"), "---\nname: fresh-removal-probe\ndescription: Removal probe procedure.\ndisable-model-invocation: true\n---\nDisabled.\n");
  assert.equal(registry.searchSkills(opened.workspace.id, "fresh-removal-probe").length, 0);
  assert.equal(opened.workspace.activatedSkillDirs.has(skillRoot), false);
  assert.throws(() => registry.resolveReadPath(opened.workspace, join(skillRoot, "SKILL.md")), /outside/);
  assert.throws(() => registry.resolveReadPath(opened.workspace, join(skillRoot, "reference.md")), /outside/);

  await writeSearchSkill(skillRoot, "fresh-removal-probe", "Removal probe procedure.");
  registry.searchSkills(opened.workspace.id, "fresh-removal-probe");
  registry.markReadPathLoaded(opened.workspace, registry.resolveReadPath(opened.workspace, join(skillRoot, "SKILL.md")));
  await rm(join(skillRoot, "SKILL.md"));
  assert.equal(registry.searchSkills(opened.workspace.id, "fresh-removal-probe").length, 0);
  assert.throws(() => registry.resolveReadPath(opened.workspace, join(skillRoot, "reference.md")), /outside/);
});

test("skill refresh remains scoped to the queried workspace", async (t) => {
  const context = await fixture(t);
  const secondRoot = join(context.root, "second-project");
  await mkdir(secondRoot);
  const first = await context.registry.openWorkspace(context.root);
  const second = await context.registry.openWorkspace(secondRoot);
  await writeSearchSkill(join(secondRoot, ".agents", "skills", "fresh-scope-probe"), "fresh-scope-probe", "Second workspace only.");
  assert.equal(context.registry.searchSkills(second.workspace.id, "fresh-scope-probe").length, 1);
  assert.equal(context.registry.searchSkills(first.workspace.id, "fresh-scope-probe").length, 0);
  assert.equal(first.workspace.activatedSkillDirs.size, 0);
});

async function writeSearchSkill(baseDir: string, name: string, description: string, body = "Initial body."): Promise<void> {
  await mkdir(baseDir, { recursive: true });
  await writeFile(join(baseDir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`);
}

test("persisted checkout and worktree sessions restore after recreating the registry", async (t) => {
  const context = await fixture(t);
  const gitRoot = await createGitProject(context.root);
  const stateDir = join(context.root, ".state");
  const firstStore = new SqliteWorkspaceStore(stateDir);
  const firstRegistry = new WorkspaceRegistry(context.config, firstStore);

  const checkout = await firstRegistry.openWorkspace(context.root);
  const worktree = await firstRegistry.openWorkspace({ path: gitRoot, mode: "worktree" });
  firstStore.close();

  const secondStore = new SqliteWorkspaceStore(stateDir);
  try {
    const restoredRegistry = new WorkspaceRegistry(context.config, secondStore);
    const restoredCheckout = restoredRegistry.getWorkspace(checkout.workspace.id);
    const restoredWorktree = restoredRegistry.getWorkspace(worktree.workspace.id);

    assert.equal(restoredCheckout.root, context.root);
    assert.equal(restoredCheckout.mode, "checkout");
    assert.equal(restoredWorktree.root, worktree.workspace.root);
    assert.equal(restoredWorktree.mode, "worktree");
    assert.equal(restoredWorktree.sourceRoot, gitRoot);
    assert.equal(restoredWorktree.worktree?.managed, true);
  } finally {
    secondStore.close();
  }
});

test("workspace paths outside the allowed roots are rejected", async (t) => {
  const context = await fixture(t);

  await assert.rejects(
    () => context.registry.openWorkspace(context.outsideRoot),
    /outside allowed roots/,
  );
});

test("a symlinked allowed root preserves checkout and worktree path behavior", { skip: platform() === "win32" }, async (t) => {
  const context = await fixture(t);
  const aliasRoot = join(context.root, "alias-root");
  await symlink(context.root, aliasRoot, "dir");
  await createGitProject(context.root);

  const aliasConfig = loadConfig({
    DEVSPACE_ALLOWED_ROOTS: aliasRoot,
    DEVSPACE_WORKTREE_ROOT: join(aliasRoot, ".devspace", "alias-worktrees"),
    DEVSPACE_AGENT_DIR: context.agentDir,
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    PORT: "1",
  });
  const aliasRegistry = new WorkspaceRegistry(aliasConfig);

  const worktree = await aliasRegistry.openWorkspace({
    path: join(aliasRoot, "git-project"),
    mode: "worktree",
  });
  const checkout = await aliasRegistry.openWorkspace(aliasRoot);

  assert.equal(worktree.workspace.sourceRoot, join(aliasRoot, "git-project"));
  assert.deepEqual(
    checkout.agentsFiles.map((file) => file.content),
    ["global instructions\n", "root instructions\n"],
  );
});

interface WorkspaceFixture {
  root: string;
  outsideRoot: string;
  agentDir: string;
  config: ServerConfig;
  registry: WorkspaceRegistry;
}

async function fixture(t: TestContext): Promise<WorkspaceFixture> {
  const root = await mkdtemp(join(tmpdir(), "devspace-workspace-test-"));
  const outsideRoot = await mkdtemp(join(tmpdir(), "devspace-workspace-outside-test-"));
  const agentDir = join(root, ".pi", "agent");

  if (platform() === "win32") {
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, "AGENTS.md"), "global instructions\n");
  } else {
    await mkdir(join(agentDir, "skills"), { recursive: true });
    await writeFile(join(agentDir, "skills", "AGENTS.md"), "global instructions\n");
    await symlink("skills/AGENTS.md", join(agentDir, "AGENTS.md"));
  }

  await writeFile(join(root, "AGENTS.md"), "root instructions\n");
  await mkdir(join(root, ".devspace", "agents"), { recursive: true });
  await writeFile(
    join(root, ".devspace", "agents", "reviewer.md"),
    [
      "---",
      "name: reviewer",
      "description: Read-only project reviewer.",
      "provider: codex",
      "---",
      "",
      "Review only.",
      "",
    ].join("\n"),
  );
  await mkdir(join(root, "nested"));
  await writeFile(join(root, "nested", "AGENTS.md"), "nested instructions\n");
  await writeFile(join(root, "nested", "file.txt"), "hello\n");

  const config = loadConfig({
    DEVSPACE_CONFIG_DIR: join(root, ".devspace-home"),
    DEVSPACE_ALLOWED_ROOTS: root,
    DEVSPACE_WORKTREE_ROOT: join(root, ".devspace", "worktrees"),
    DEVSPACE_AGENT_DIR: agentDir,
    DEVSPACE_SUBAGENTS: "1",
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    PORT: "1",
  });

  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  });

  return {
    root,
    outsideRoot,
    agentDir,
    config,
    registry: new WorkspaceRegistry(config),
  };
}

async function createGitProject(parent: string): Promise<string> {
  const gitRoot = join(parent, "git-project");
  await mkdir(gitRoot);
  await writeFile(join(gitRoot, "AGENTS.md"), "git root instructions\n");
  await writeFile(join(gitRoot, "README.md"), "hello\n");
  await git(gitRoot, ["init"]);
  await git(gitRoot, ["config", "user.email", "devspace@example.com"]);
  await git(gitRoot, ["config", "user.name", "DevSpace Test"]);
  await git(gitRoot, ["add", "."]);
  await git(gitRoot, ["commit", "-m", "Initial commit"]);
  return gitRoot;
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}
