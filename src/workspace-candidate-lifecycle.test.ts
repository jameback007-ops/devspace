import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test, { type TestContext } from "node:test";
import { assessWorkspaceCandidateLifecycle } from "./workspace-candidate-lifecycle.js";
import type {
  WorkspaceActivityObservation,
  WorkspaceSession,
} from "./workspace-store.js";

const execFileAsync = promisify(execFile);

test("candidate lifecycle exposes exact semantic ownership and validation-bound publication readiness", async (t) => {
  const fixture = await candidateFixture(t);
  const activity: WorkspaceActivityObservation = {
    workspaceId: fixture.session.id,
    scopeLastActivityAtMs: 100_000,
    latestScopeRef: "0123456789abcdef",
    scopeRefs: ["fedcba9876543210", "0123456789abcdef"],
    recovery: {
      recordedAtMs: 90_000,
      semantic: {
        missionRef: "DEVSPACE-CANDIDATE-LIFECYCLE-TEST",
        currentFrontier: "Validated candidate is waiting for publication preflight.",
        exactNextAction: "Run the fixed publication preflight.",
        unresolved: ["publication not performed"],
        checkpointRefs: [`git:commit:${fixture.candidateHead}`],
        validationState: "passed",
        validationRefs: ["test:focused"],
        worktreeState: "clean",
        writerState: "released",
        effectState: "none",
        retryPolicy: "normal",
        safeToPublish: true,
      },
      fingerprint: {
        head: fixture.candidateHead,
        dirty: false,
      },
    },
  };

  const ready = await assessWorkspaceCandidateLifecycle({
    path: fixture.worktree,
    rootExists: true,
    registered: true,
    session: fixture.session,
    activity,
    loadedInCurrentRuntime: false,
    runningProcessCount: 0,
    externalProcessReferences: [],
    activeWithinHours: 0.01,
    nowMs: 200_000,
  });

  assert.equal(ready.disposition, "ready_to_publish");
  assert.equal(ready.technicallyReadyToPublish, true);
  assert.equal(ready.validation.state, "current_passed");
  assert.equal(ready.displayLabel, "DEVSPACE-CANDIDATE-LIFECYCLE-TEST");
  assert.equal(ready.displayLabelSource, "recovery_capsule_mission_ref");
  assert.equal(ready.semanticHint?.exactNextAction, "Run the fixed publication preflight.");
  assert.equal(ready.activity.latestScopeRef, "0123456789abcdef");
  assert.deepEqual(ready.activity.scopeRefs, ["0123456789abcdef", "fedcba9876543210"]);
  assert.equal(ready.safeToDelete, false);

  await git(fixture.repository, [
    "update-ref",
    "refs/remotes/owner/main",
    fixture.candidateHead,
  ]);
  const integrated = await assessWorkspaceCandidateLifecycle({
    path: fixture.worktree,
    rootExists: true,
    registered: true,
    session: fixture.session,
    activity,
    loadedInCurrentRuntime: false,
    runningProcessCount: 0,
    externalProcessReferences: [],
    activeWithinHours: 0.01,
    nowMs: 200_000,
  });
  assert.equal(integrated.git.authorityRef, "owner/main");
  assert.equal(integrated.disposition, "baseline_only");
  assert.equal(integrated.publicationDebt, false);
  assert.equal(integrated.safeToDelete, true);

  await writeFile(join(fixture.worktree, "dirty.txt"), "dirty\n");
  const dirty = await assessWorkspaceCandidateLifecycle({
    path: fixture.worktree,
    rootExists: true,
    registered: true,
    session: fixture.session,
    activity,
    loadedInCurrentRuntime: false,
    runningProcessCount: 0,
    externalProcessReferences: [],
    activeWithinHours: 0.01,
    nowMs: 200_000,
  });
  assert.equal(dirty.disposition, "dirty_recoverable");
  assert.equal(dirty.validation.state, "stale");
  assert.ok(dirty.finalizers.includes("dirty_worktree"));
});

test("passed validation without durable evidence refs never becomes publish-ready", async (t) => {
  const fixture = await candidateFixture(t);
  const assessment = await assessWorkspaceCandidateLifecycle({
    path: fixture.worktree,
    rootExists: true,
    registered: true,
    session: fixture.session,
    activity: {
      workspaceId: fixture.session.id,
      recovery: {
        recordedAtMs: 1,
        semantic: { validationState: "passed" },
        fingerprint: { head: fixture.candidateHead, dirty: false },
      },
    },
    loadedInCurrentRuntime: false,
    runningProcessCount: 0,
    externalProcessReferences: [],
    activeWithinHours: 0.01,
    nowMs: 1_000_000,
  });

  assert.equal(assessment.validation.boundToCurrentHead, false);
  assert.equal(assessment.disposition, "awaiting_validation");
});

async function candidateFixture(t: TestContext): Promise<{
  repository: string;
  worktree: string;
  candidateHead: string;
  session: WorkspaceSession;
}> {
  const root = await mkdtemp(join(tmpdir(), "devspace-candidate-lifecycle-test-"));
  const repository = join(root, "repository");
  const worktree = join(root, "candidate");
  await mkdir(repository, { recursive: true });
  t.after(async () => rm(root, { recursive: true, force: true }));

  await git(repository, ["init", "-b", "main"]);
  await git(repository, ["config", "user.email", "devspace@example.test"]);
  await git(repository, ["config", "user.name", "DevSpace Test"]);
  await writeFile(join(repository, "README.md"), "base\n");
  await git(repository, ["add", "."]);
  await git(repository, ["commit", "-m", "Base"]);
  const baseSha = await gitOutput(repository, ["rev-parse", "HEAD"]);
  await git(repository, [
    "worktree",
    "add",
    "-b",
    "devspace/workspaces/ws_0123456789",
    worktree,
    baseSha,
  ]);
  await writeFile(join(worktree, "candidate.txt"), "candidate\n");
  await git(worktree, ["add", "."]);
  await git(worktree, ["commit", "-m", "Candidate"]);
  const candidateHead = await gitOutput(worktree, ["rev-parse", "HEAD"]);
  return {
    repository,
    worktree,
    candidateHead,
    session: {
      id: "ws_0123456789",
      root: worktree,
      status: "active",
      mode: "worktree",
      sourceRoot: repository,
      baseRef: "main",
      baseSha,
      preservationRef: "devspace/workspaces/ws_0123456789",
      managed: true,
      createdAt: new Date(0).toISOString(),
      lastUsedAt: new Date(0).toISOString(),
    },
  };
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

async function gitOutput(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}
