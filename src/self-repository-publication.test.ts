import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import test, { type TestContext } from "node:test";
import type { SelfRepositoryPublicationConfig } from "./config.js";
import { SelfRepositoryPublicationManager } from "./self-repository-publication.js";
import type {
  WorkspaceActivityObservation,
  WorkspaceSession,
  WorkspaceStore,
} from "./workspace-store.js";

const execFileAsync = promisify(execFile);

test("fixed self-repository preflight and effect publish one validated zero-behind candidate", async (t) => {
  const fixture = await publicationFixture(t, { effectsEnabled: true });
  const preflight = await fixture.manager.preflight({ workspaceId: fixture.session.id });

  assert.equal(preflight.status, "eligible");
  assert.equal(preflight.safeToPublish, true);
  assert.equal(preflight.validationBoundToCandidate, true);
  assert.equal(preflight.behindCount, 0);
  assert.equal(preflight.aheadCount, 1);
  assert.equal(preflight.mergeCommitCount, 0);
  assert.equal(preflight.remoteUrlIdentityMatches, true);
  assert.equal(preflight.expectedPublication?.expectedOldSha, fixture.remoteBaseSha);

  const result = await fixture.manager.execute({
    workspaceId: fixture.session.id,
    planIdSha256: preflight.planIdSha256,
  });
  assert.equal(result.outcome, "published");
  assert.equal(await remoteHead(fixture.remote), fixture.candidateHeadSha);
  assert.equal(
    await gitOutput(fixture.repository, ["rev-parse", "refs/remotes/owner/main"]),
    fixture.candidateHeadSha,
  );

  const after = await fixture.manager.preflight({ workspaceId: fixture.session.id });
  assert.equal(after.status, "not_required");
  assert.equal(after.publicationRequired, false);
});

test("remote authority movement invalidates an older self-publication plan", async (t) => {
  const fixture = await publicationFixture(t, { effectsEnabled: true });
  const preflight = await fixture.manager.preflight({ workspaceId: fixture.session.id });
  assert.equal(preflight.status, "eligible");

  await writeFile(join(fixture.repository, "remote-drift.txt"), "drift\n");
  await git(fixture.repository, ["add", "."]);
  await git(fixture.repository, ["commit", "-m", "Remote drift"]);
  await git(fixture.repository, ["push", "owner", "HEAD:refs/heads/main"]);

  await assert.rejects(
    () => fixture.manager.execute({
      workspaceId: fixture.session.id,
      planIdSha256: preflight.planIdSha256,
    }),
    /publication_plan_changed/,
  );
  const reassessed = await fixture.manager.preflight({ workspaceId: fixture.session.id });
  assert.equal(reassessed.status, "blocked");
  assert.ok(
    reassessed.blockingFactors.includes(
      "candidate_does_not_descend_from_remote_authority",
    ),
  );
  assert.ok(reassessed.blockingFactors.includes("candidate_behind_remote_authority"));
});

test("fixed remote identity mismatch blocks self-publication", async (t) => {
  const fixture = await publicationFixture(t, {
    effectsEnabled: false,
    expectedRemoteUrl: "/not/the/configured/owner.git",
  });
  const preflight = await fixture.manager.preflight({ workspaceId: fixture.session.id });

  assert.equal(preflight.status, "blocked");
  assert.equal(preflight.remoteUrlIdentityMatches, false);
  assert.ok(preflight.blockingFactors.includes("configured_remote_identity_mismatch"));
  assert.equal(preflight.safeToPublish, false);
});

test("self-publication fails closed without explicit writer, effect, and safety attestations", async (t) => {
  const fixture = await publicationFixture(t, {
    effectsEnabled: false,
    includePublicationAttestations: false,
  });
  const preflight = await fixture.manager.preflight({ workspaceId: fixture.session.id });

  assert.equal(preflight.status, "blocked");
  assert.ok(preflight.blockingFactors.includes("candidate_writer_state_missing"));
  assert.ok(preflight.blockingFactors.includes("candidate_effect_state_missing"));
  assert.ok(
    preflight.blockingFactors.includes(
      "candidate_publication_safety_not_attested",
    ),
  );
});

test("branch-only retained candidate publishes the exact candidate object instead of checkout HEAD", async (t) => {
  const fixture = await publicationFixture(t, { effectsEnabled: true });
  fixture.session.preservationRef = "candidate";
  await git(fixture.repository, ["worktree", "remove", fixture.worktree]);

  const preflight = await fixture.manager.preflight({ workspaceId: fixture.session.id });
  assert.equal(preflight.status, "eligible");
  assert.equal(
    preflight.expectedPublication?.refspec,
    `${fixture.candidateHeadSha}:refs/heads/main`,
  );

  const result = await fixture.manager.execute({
    workspaceId: fixture.session.id,
    planIdSha256: preflight.planIdSha256,
  });
  assert.equal(result.outcome, "published");
  assert.equal(await remoteHead(fixture.remote), fixture.candidateHeadSha);
  assert.equal(
    await gitOutput(fixture.repository, ["rev-parse", "refs/remotes/owner/main"]),
    fixture.candidateHeadSha,
  );
});

test("scope projection never imports a missing remote authority object", async (t) => {
  const fixture = await publicationFixture(t, { effectsEnabled: false });
  const remoteWriter = join(dirname(fixture.repository), "remote-writer");
  await git(dirname(fixture.repository), [
    "clone",
    "--branch",
    "main",
    fixture.remote,
    remoteWriter,
  ]);
  await git(remoteWriter, ["config", "user.email", "remote@example.test"]);
  await git(remoteWriter, ["config", "user.name", "Remote Writer"]);
  await writeFile(join(remoteWriter, "remote-only.txt"), "remote authority\n");
  await git(remoteWriter, ["add", "."]);
  await git(remoteWriter, ["commit", "-m", "Remote-only authority"]);
  await git(remoteWriter, ["push", "origin", "HEAD:refs/heads/main"]);
  const remoteAuthoritySha = await gitOutput(remoteWriter, ["rev-parse", "HEAD"]);

  await assert.rejects(
    () => git(fixture.repository, ["cat-file", "-e", `${remoteAuthoritySha}^{commit}`]),
  );
  const projection = await fixture.manager.scopeProjection([
    { workspaceId: fixture.session.id },
  ]);
  assert.equal(projection.candidateCount, 1);
  assert.equal(projection.unavailableCount, 1);
  assert.deepEqual(
    projection.candidates[0]?.blockingFactors,
    ["remote_authority_object_not_available_locally_use_direct_preflight"],
  );
  assert.equal(
    projection.candidates[0]?.remoteAuthorityObjectAvailableLocally,
    false,
  );
  assert.equal(projection.policy.remoteObjectFetchPerformed, false);
  await assert.rejects(
    () => git(fixture.repository, ["cat-file", "-e", `${remoteAuthoritySha}^{commit}`]),
  );

  const direct = await fixture.manager.preflight({ workspaceId: fixture.session.id });
  assert.equal(direct.status, "blocked");
  assert.equal(direct.remoteAuthorityObjectAvailableLocally, true);
  assert.ok(direct.blockingFactors.includes("candidate_behind_remote_authority"));
  await git(fixture.repository, ["cat-file", "-e", `${remoteAuthoritySha}^{commit}`]);
});

async function publicationFixture(
  t: TestContext,
  options: {
    effectsEnabled: boolean;
    expectedRemoteUrl?: string;
    includePublicationAttestations?: boolean;
  },
): Promise<{
  repository: string;
  remote: string;
  worktree: string;
  remoteBaseSha: string;
  candidateHeadSha: string;
  session: WorkspaceSession;
  manager: SelfRepositoryPublicationManager;
}> {
  const root = await mkdtemp(join(tmpdir(), "devspace-self-publication-test-"));
  const repository = join(root, "repository");
  const remote = join(root, "owner.git");
  const worktree = join(root, "candidate");
  await mkdir(repository, { recursive: true });
  t.after(async () => rm(root, { recursive: true, force: true }));

  await git(root, ["init", "--bare", remote]);
  await git(repository, ["init", "-b", "main"]);
  await git(repository, ["config", "user.email", "devspace@example.test"]);
  await git(repository, ["config", "user.name", "DevSpace Test"]);
  await writeFile(join(repository, "README.md"), "base\n");
  await git(repository, ["add", "."]);
  await git(repository, ["commit", "-m", "Base"]);
  await git(repository, ["remote", "add", "owner", remote]);
  await git(repository, ["push", "-u", "owner", "main"]);
  const remoteBaseSha = await gitOutput(repository, ["rev-parse", "HEAD"]);

  await git(repository, ["worktree", "add", "-b", "candidate", worktree, "main"]);
  await writeFile(join(worktree, "candidate.txt"), "candidate\n");
  await git(worktree, ["add", "."]);
  await git(worktree, ["commit", "-m", "Candidate"]);
  const candidateHeadSha = await gitOutput(worktree, ["rev-parse", "HEAD"]);
  const session: WorkspaceSession = {
    id: "ws_1234567890",
    root: worktree,
    status: "active",
    mode: "worktree",
    sourceRoot: repository,
    baseRef: "main",
    baseSha: remoteBaseSha,
    managed: true,
    createdAt: new Date(0).toISOString(),
    lastUsedAt: new Date(0).toISOString(),
  };
  const activity: WorkspaceActivityObservation = {
    workspaceId: session.id,
    recovery: {
      recordedAtMs: Date.now(),
      semantic: {
        validationState: "passed",
        validationRefs: ["test:self-repository-publication"],
        ...(options.includePublicationAttestations === false
          ? {}
          : {
              writerState: "released",
              effectState: "none",
              safeToPublish: true,
            }),
      },
      fingerprint: {
        head: candidateHeadSha,
        dirty: false,
        complete: true,
      },
    },
  };
  const store: Pick<WorkspaceStore, "getSession" | "workspaceActivity"> = {
    getSession: (id) => id === session.id ? session : undefined,
    workspaceActivity: (id) => id === session.id
      ? activity
      : { workspaceId: id },
  };
  const config: SelfRepositoryPublicationConfig = {
    enabled: true,
    effectsEnabled: options.effectsEnabled,
    repositoryRoot: repository,
    remoteName: "owner",
    branchName: "main",
    expectedRemoteUrl: options.expectedRemoteUrl ?? remote,
  };
  return {
    repository,
    remote,
    worktree,
    remoteBaseSha,
    candidateHeadSha,
    session,
    manager: new SelfRepositoryPublicationManager(config, store),
  };
}

async function remoteHead(remote: string): Promise<string> {
  const output = await gitOutput(tmpdir(), [
    "ls-remote",
    remote,
    "refs/heads/main",
  ]);
  return output.split(/\s+/)[0] ?? "";
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

async function gitOutput(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}
