import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ZesContinuationPreflightProjector,
  type ZesContinuationPreflightProjection,
} from "./zes-continuation-preflight.js";
import {
  NativeScopePublicationGitPort,
  ZesScopePublicationPreflightAssessor,
  type ScopeLinkedWorkspace,
  type ScopePublicationGitObservation,
  type ScopePublicationGitPort,
} from "./scope-publication-preflight.js";

const REMOTE_MAIN = "1".repeat(40);
const CANDIDATE_HEAD = "2".repeat(40);
const BASE_MS = Date.parse("2026-08-18T07:00:00.000Z");

function exec(
  cwd: string,
  command: string,
  args: string[],
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { cwd, encoding: "utf8", maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr.trim() || stdout.trim() || error.message));
          return;
        }
        resolve(stdout.trim());
      },
    );
  });
}

async function continuationProjection(
  overrides: Record<string, unknown> = {},
): Promise<ZesContinuationPreflightProjection> {
  const projector = new ZesContinuationPreflightProjector({
    now: () => BASE_MS,
    refresh: async () => ({
      schemaVersion: 1,
      observedAt: new Date(BASE_MS).toISOString(),
      sourceExpiresAt: new Date(BASE_MS + 180_000).toISOString(),
      preflight: {
        schema_version: "zes.continuation-control-preflight.v2",
        active_writer_detected: false,
        writer_state_uncertain: false,
        publication_authority_valid: true,
        publication_controls_fail_closed: true,
        safe_to_mutate_live: true,
        safe_to_inspect: true,
        safe_to_prepare_isolated_candidate: true,
        safe_to_publish: false,
        publication_required: false,
        publication_disposition: "not_required",
        safe_checkpoint: {
          commit_ref: `git:commit:${REMOTE_MAIN}`,
        },
        ...overrides,
      },
      refresh: {
        status: "refreshed",
        receiptDigestSha256: "a".repeat(64),
        snapshotSha256: "b".repeat(64),
        sourceControlPreflight: {},
      },
    }),
  });
  await projector.warm();
  return await projector.project();
}

class FakeGitPort implements ScopePublicationGitPort {
  calls = 0;
  remoteCalls = 0;

  constructor(
    private readonly observations: Record<string, ScopePublicationGitObservation>,
    private readonly failure?: Error,
  ) {}

  async authoritativeRemoteMain() {
    this.remoteCalls += 1;
    return {
      sha: REMOTE_MAIN,
      repositoryIdentityDigestSha256: "f".repeat(64),
      evidenceRefs: [`git:authoritative-remote-main:${REMOTE_MAIN}`],
    };
  }

  async inspect(
    workspace: ScopeLinkedWorkspace,
    authoritativeRemoteMainSha: string,
  ): Promise<ScopePublicationGitObservation> {
    this.calls += 1;
    assert.equal(authoritativeRemoteMainSha, REMOTE_MAIN);
    if (this.failure) throw this.failure;
    const observation = this.observations[workspace.workspaceId];
    if (!observation) throw new Error(`missing fake ${workspace.workspaceId}`);
    return structuredClone(observation);
  }
}

function candidateObservation(
  overrides: Partial<ScopePublicationGitObservation> = {},
): ScopePublicationGitObservation {
  return {
    workspaceId: "ws_candidate",
    repositoryIdentityDigestSha256: "c".repeat(64),
    repositoryIdentityMatches: true,
    workspaceRootVerified: true,
    branchName: "agent/candidate",
    branchRemote: "origin",
    branchMergeRef: "refs/heads/main",
    headSha: CANDIDATE_HEAD,
    originMainSha: REMOTE_MAIN,
    authoritativeRemoteMainPresentLocally: true,
    remoteTrackingMatchesAuthority: true,
    candidateDescendsFromAuthority: true,
    aheadCount: 1,
    behindCount: 0,
    mergeCommitCount: 0,
    dirtyPathCount: 0,
    worktreeClean: true,
    pushDefault: "nothing",
    hooksPathConfigured: true,
    prePushHookExecutable: true,
    prePushHookDigestSha256: "d".repeat(64),
    expectedPrePushHookDigestSha256: "d".repeat(64),
    prePushHookIdentityMatches: true,
    publicationControlsFailClosed: true,
    evidenceRefs: ["git:test-candidate"],
    ...overrides,
  };
}

const workspaces = [
  {
    workspaceId: "ws_candidate",
    root: "/internal/candidate",
    mode: "worktree",
    sourceRoot: "/internal/source",
    baseRef: "origin/main",
    baseSha: REMOTE_MAIN,
    managed: true,
  },
  {
    workspaceId: "ws_unmanaged_noise",
    root: "/usr/local/bin",
    mode: "checkout",
    managed: false,
  },
];

function recovery(overrides: Record<string, unknown> = {}) {
  return {
    capsule: {
      sourceWorkspaceId: "ws_candidate",
    },
    validation: {
      state: "passed",
      refs: ["validation:all-passed"],
    },
    worktree: {
      workspaceFreshness: "fresh",
    },
    checkpointRefs: [`git:commit:${CANDIDATE_HEAD}`],
    authority: {
      recordedStateRefs: [`git:candidate@${CANDIDATE_HEAD}`],
    },
    ...overrides,
  };
}

const eligiblePort = new FakeGitPort({
  ws_candidate: candidateObservation(),
});
const assessor = new ZesScopePublicationPreflightAssessor(
  eligiblePort,
  () => BASE_MS,
);
const eligible = await assessor.assess({
  workspaces,
  semanticRecovery: recovery(),
  continuationPreflight: await continuationProjection(),
});
assert.equal(eligible.status, "available");
assert.equal(eligible.candidateCount, 1);
assert.equal(eligible.ignoredWorkspaceCount, 1);
assert.equal(eligible.inspectionFailureCount, 0);
assert.equal(eligiblePort.calls, 1, "unmanaged noise must not be inspected");
assert.ok((eligible.stageTimingsMs?.total ?? -1) >= 0);
assert.ok((eligible.stageTimingsMs?.remoteAuthority ?? -1) >= 0);
assert.ok((eligible.stageTimingsMs?.candidateInspection ?? -1) >= 0);
assert.equal(eligible.candidates[0]?.disposition, "eligible");
assert.equal(eligible.candidates[0]?.safeToPublish, true);
assert.equal(eligible.candidates[0]?.validationBoundToCandidate, true);
assert.equal(
  eligible.candidates[0]?.validationEvidenceAuthority,
  "executor_local_git_bound_recovery_capsule",
);
assert.equal(
  eligible.candidates[0]?.validationEvidenceRevalidationRequired,
  true,
);
assert.equal(eligible.candidates[0]?.fullValidationRerunRequired, false);
assert.deepEqual(eligible.candidates[0]?.blockingFactors, []);
assert.equal(
  eligible.candidates[0]?.expectedPublication?.expectedOldSha,
  REMOTE_MAIN,
);
assert.equal(
  eligible.candidates[0]?.expectedPublication?.compareAndSwapRequired,
  true,
);
assert.equal(
  eligible.candidates[0]?.expectedPublication?.refspec,
  `${CANDIDATE_HEAD}:refs/heads/main`,
  "the publication effect must push the exact validated object, never checkout HEAD",
);
assert.equal(
  eligible.candidates[0]?.expectedPublication?.localPrePushHookRequired,
  false,
);
assert.equal(
  eligible.candidates[0]?.expectedPublication
    ?.effectGateMustRevalidateCandidateAndAuthority,
  true,
);
assert.equal(
  eligible.candidates[0]?.expectedPublication
    ?.validationMustBeRevalidatedBeforeEffect,
  true,
);
assert.equal(
  eligible.candidates[0]?.expectedPublication?.fullValidationRerunRequired,
  false,
);
assert.equal(eligible.policy.capsuleValidationIsPublicationAuthority, false);
assert.equal(eligible.policy.effectGateMustRevalidateValidationAndGit, true);

const noCapsulePort = new FakeGitPort({
  ws_candidate: candidateObservation(),
});
const noCapsule = await new ZesScopePublicationPreflightAssessor(
  noCapsulePort,
  () => BASE_MS,
).assess({
  workspaces,
  continuationPreflight: await continuationProjection(),
});
assert.equal(noCapsule.status, "available");
assert.equal(noCapsule.candidateCount, 0);
assert.equal(noCapsule.ignoredWorkspaceCount, 2);
assert.equal(
  noCapsulePort.calls,
  0,
  "publication Git inspection requires an exact recovery-capsule workspace",
);
assert.equal(
  noCapsulePort.remoteCalls,
  0,
  "a scope without a candidate must not perform remote publication readback",
);
assert.equal(noCapsule.stageTimingsMs?.remoteAuthority, 0);

const uncertain = await assessor.assess({
  workspaces,
  semanticRecovery: recovery(),
  continuationPreflight: await continuationProjection({
    writer_state_uncertain: true,
  }),
});
assert.equal(uncertain.candidates[0]?.disposition, "eligible");
assert.equal(uncertain.candidates[0]?.safeToPublish, true);
assert.ok(
  uncertain.candidates[0]?.evidenceProfile.skippedEvidence.some(
    (entry) => entry.reasonCode
      === "unrelated_runtime_state_is_not_repository_writer_authority",
  ),
);

const staleValidation = await assessor.assess({
  workspaces,
  semanticRecovery: recovery({
    validation: { state: "failed", refs: ["validation:failed"] },
  }),
  continuationPreflight: await continuationProjection(),
});
assert.equal(staleValidation.candidates[0]?.disposition, "blocked");
assert.ok(
  staleValidation.candidates[0]?.blockingFactors.includes(
    "candidate_validation_checkpoint_not_fresh_or_head_bound",
  ),
);

const staleTrackingPort = new FakeGitPort({
  ws_candidate: candidateObservation({
    originMainSha: "3".repeat(40),
    remoteTrackingMatchesAuthority: false,
  }),
});
const staleTracking = await new ZesScopePublicationPreflightAssessor(
  staleTrackingPort,
  () => BASE_MS,
).assess({
  workspaces,
  semanticRecovery: recovery(),
  continuationPreflight: await continuationProjection(),
});
assert.equal(staleTracking.candidates[0]?.disposition, "eligible");
assert.equal(staleTracking.candidates[0]?.safeToPublish, true);

const unsafeHookPort = new FakeGitPort({
  ws_candidate: candidateObservation({
    prePushHookDigestSha256: "e".repeat(64),
    expectedPrePushHookDigestSha256: "d".repeat(64),
    prePushHookIdentityMatches: false,
    publicationControlsFailClosed: false,
  }),
});
const unsafeHook = await new ZesScopePublicationPreflightAssessor(
  unsafeHookPort,
  () => BASE_MS,
).assess({
  workspaces,
  semanticRecovery: recovery(),
  continuationPreflight: await continuationProjection(),
});
assert.equal(unsafeHook.candidates[0]?.disposition, "eligible");
assert.equal(unsafeHook.candidates[0]?.safeToPublish, true);
assert.equal(
  unsafeHook.candidates[0]?.expectedPublication?.localPrePushHookRequired,
  false,
);

const mergeCommitPort = new FakeGitPort({
  ws_candidate: candidateObservation({ mergeCommitCount: 1 }),
});
const mergeCommit = await new ZesScopePublicationPreflightAssessor(
  mergeCommitPort,
  () => BASE_MS,
).assess({
  workspaces,
  semanticRecovery: recovery(),
  continuationPreflight: await continuationProjection(),
});
assert.equal(mergeCommit.candidates[0]?.disposition, "blocked");
assert.ok(
  mergeCommit.candidates[0]?.blockingFactors.includes(
    "candidate_range_contains_merge_commits",
  ),
);

const refreshingProjector = new ZesContinuationPreflightProjector({
  now: () => BASE_MS,
  refresh: async () => await new Promise(() => undefined),
});
const awaiting = await assessor.assess({
  workspaces,
  semanticRecovery: recovery(),
  continuationPreflight: await refreshingProjector.project(),
});
assert.equal(awaiting.status, "available");
assert.equal(awaiting.candidateCount, 1);
assert.equal(awaiting.candidates[0]?.disposition, "eligible");

const failing = await new ZesScopePublicationPreflightAssessor(
  new FakeGitPort({}, new Error("PRIVATE-GIT-DETAIL-MUST-NOT-LEAK")),
  () => BASE_MS,
).assess({
  workspaces,
  semanticRecovery: recovery(),
  continuationPreflight: await continuationProjection(),
});
assert.equal(failing.status, "unavailable");
assert.equal(failing.inspectionFailureCount, 1);
assert.equal(
  JSON.stringify(failing).includes("PRIVATE-GIT-DETAIL-MUST-NOT-LEAK"),
  false,
);
assert.match(failing.error?.diagnosticDigestSha256 ?? "", /^[a-f0-9]{64}$/);

const integrationRoot = await mkdtemp(
  join(tmpdir(), "scope-publication-preflight-"),
);
try {
  const bare = join(integrationRoot, "origin.git");
  const fixed = join(integrationRoot, "fixed");
  const candidate = join(integrationRoot, "candidate");
  await exec(integrationRoot, "git", ["init", "--bare", bare]);
  await exec(integrationRoot, "git", ["clone", bare, fixed]);
  await exec(fixed, "git", ["config", "user.name", "Test User"]);
  await exec(fixed, "git", ["config", "user.email", "test@example.com"]);
  await writeFile(join(fixed, "README.md"), "base\n", "utf8");
  await exec(fixed, "git", ["add", "README.md"]);
  await exec(fixed, "git", ["commit", "-m", "base"]);
  await exec(fixed, "git", ["branch", "-M", "main"]);
  await exec(fixed, "git", ["push", "-u", "origin", "main"]);
  const integrationRemoteMain = await exec(fixed, "git", ["rev-parse", "HEAD"]);

  await exec(integrationRoot, "git", ["clone", bare, candidate]);
  await exec(candidate, "git", ["checkout", "-b", "agent/candidate", "origin/main"]);
  await exec(candidate, "git", ["config", "user.name", "Test User"]);
  await exec(candidate, "git", ["config", "user.email", "test@example.com"]);
  await writeFile(join(candidate, "candidate.txt"), "candidate\n", "utf8");
  await exec(candidate, "git", ["add", "candidate.txt"]);
  await exec(candidate, "git", ["commit", "-m", "candidate"]);

  const nativePort = new NativeScopePublicationGitPort(fixed);
  const nativeAuthority = await nativePort.authoritativeRemoteMain();
  assert.equal(nativeAuthority.sha, integrationRemoteMain);
  const nativeClean = await nativePort.inspect(
    {
      workspaceId: "ws_native",
      root: candidate,
      mode: "worktree",
      sourceRoot: fixed,
      baseRef: "origin/main",
      baseSha: integrationRemoteMain,
      managed: true,
    },
    integrationRemoteMain,
  );
  assert.equal(nativeClean.repositoryIdentityMatches, true);
  assert.equal(nativeClean.workspaceRootVerified, true);
  assert.equal(nativeClean.originMainSha, undefined);
  assert.equal(nativeClean.remoteTrackingMatchesAuthority, undefined);
  assert.equal(nativeClean.candidateDescendsFromAuthority, true);
  assert.equal(nativeClean.aheadCount, 1);
  assert.equal(nativeClean.behindCount, 0);
  assert.equal(nativeClean.mergeCommitCount, 0);
  assert.equal(nativeClean.worktreeClean, true);
  assert.equal(nativeClean.prePushHookIdentityMatches, undefined);
  assert.equal(nativeClean.publicationControlsFailClosed, undefined);

  await writeFile(join(candidate, "README.md"), "base\ndirty\n", "utf8");
  const nativeDirty = await nativePort.inspect(
    {
      workspaceId: "ws_native",
      root: candidate,
      mode: "worktree",
      sourceRoot: fixed,
      managed: true,
    },
    integrationRemoteMain,
  );
  assert.equal(nativeDirty.worktreeClean, false);
  assert.equal(nativeDirty.dirtyPathCount, 1);
} finally {
  await rm(integrationRoot, { recursive: true, force: true });
}

console.log("scope publication preflight tests passed");
