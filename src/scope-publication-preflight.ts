import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, readFile, realpath } from "node:fs/promises";
import { execFile } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import {
  fixedZesRepositoryRoot,
  type ZesContinuationPreflightProjection,
} from "./zes-continuation-preflight.js";

const GIT_TIMEOUT_MS = 3_000;
const GIT_MAX_BUFFER_BYTES = 1024 * 1024;
const MAX_LINKED_WORKSPACES = 20;
const GIT_SHA_PATTERN = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;

export interface ScopeLinkedWorkspace {
  workspaceId: string;
  root: string;
  mode?: "checkout" | "worktree";
  sourceRoot?: string;
  baseRef?: string;
  baseSha?: string;
  managed?: boolean;
}

export interface ScopePublicationGitObservation {
  workspaceId: string;
  repositoryIdentityDigestSha256: string;
  repositoryIdentityMatches: boolean;
  workspaceRootVerified: boolean;
  branchName?: string;
  branchRemote?: string;
  branchMergeRef?: string;
  headSha?: string;
  originMainSha?: string;
  authoritativeRemoteMainPresentLocally: boolean;
  remoteTrackingMatchesAuthority: boolean;
  candidateDescendsFromAuthority: boolean;
  aheadCount?: number;
  behindCount?: number;
  mergeCommitCount?: number;
  dirtyPathCount: number;
  worktreeClean: boolean;
  pushDefault?: string;
  hooksPathConfigured: boolean;
  prePushHookExecutable: boolean;
  prePushHookDigestSha256?: string;
  expectedPrePushHookDigestSha256?: string;
  prePushHookIdentityMatches: boolean;
  publicationControlsFailClosed: boolean;
  evidenceRefs: string[];
}

export interface ScopePublicationGitPort {
  inspect(
    workspace: ScopeLinkedWorkspace,
    authoritativeRemoteMainSha: string,
  ): Promise<ScopePublicationGitObservation>;
}

export interface ScopePublicationCandidateAssessment {
  schemaVersion: 1;
  workspaceId: string;
  disposition: "eligible" | "blocked" | "not_required" | "unavailable";
  safeToPublish: boolean;
  publicationRequired: boolean;
  candidateHeadSha?: string;
  authoritativeRemoteMainSha: string;
  localOriginMainSha?: string;
  branchName?: string;
  aheadCount?: number;
  behindCount?: number;
  mergeCommitCount?: number;
  dirtyPathCount?: number;
  publicationControlsFailClosed?: boolean;
  validationBoundToCandidate: boolean;
  validationEvidenceAuthority:
    "executor_local_git_bound_recovery_capsule";
  validationEvidenceRevalidationRequired: true;
  blockingFactors: string[];
  evidenceRefs: string[];
  expectedPublication?: {
    remoteName: "origin";
    remoteRef: "refs/heads/main";
    refspec: "HEAD:refs/heads/main";
    expectedOldSha: string;
    compareAndSwapRequired: true;
    remoteReadbackRequired: true;
    effectGateMustRevalidateCandidateAndAuthority: true;
    validationMustBeRevalidatedBeforeEffect: true;
    prePushGuard: {
      hookDigestSha256: string;
      environment: {
        ZES_CHECKPOINT_PUBLICATION_GUARD: "1";
        ZES_CHECKPOINT_PUBLICATION_COMMIT: string;
        ZES_CHECKPOINT_PUBLICATION_EXPECTED_OLD: string;
      };
    };
  };
}

export interface ScopePublicationPreflight {
  schemaVersion: 1;
  capabilityRef: "zes.scope-publication.preflight.v1";
  status:
    | "available"
    | "awaiting_continuation_control_plane"
    | "unavailable";
  assessedAt: string;
  continuationProjectionRef: string;
  authoritativeRemoteMainSha?: string;
  candidateCount: number;
  ignoredWorkspaceCount: number;
  inspectionFailureCount: number;
  candidates: ScopePublicationCandidateAssessment[];
  error?: {
    code: "scope_publication_preflight_unavailable";
    diagnosticDigestSha256: string;
  };
  policy: {
    authority:
      "scope_linked_git_readback_combined_with_fixed_ZES_product_preflight";
    inputWorkspaceSource: "execution_scope_registry_only";
    arbitraryWorkspacePathAccepted: false;
    remoteMainAuthoritySource:
      "fixed_product_preflight_safe_checkpoint_commit_ref";
    localOriginTrackingIsRemoteAuthority: false;
    runtimeReconciliationBlocksUnrelatedSourcePublication: false;
    candidateValidationCheckpointRequired: true;
    capsuleValidationIsPublicationAuthority: false;
    effectGateMustRevalidateValidationAndGit: true;
    publicationEffectPerformed: false;
    publicationAuthorityGranted: false;
    compareAndSwapAndRemoteReadbackRequired: true;
  };
}

export interface ScopePublicationPreflightSource {
  assess(input: {
    workspaces: unknown;
    semanticRecovery?: unknown;
    continuationPreflight: ZesContinuationPreflightProjection;
  }): Promise<ScopePublicationPreflight>;
}

interface GitCommandResult {
  stdout: string;
  exitCode: number;
}

interface FixedRepositoryIdentity {
  originDigestSha256: string;
  prePushHookDigestSha256: string;
}

const POLICY = {
  authority: "scope_linked_git_readback_combined_with_fixed_ZES_product_preflight",
  inputWorkspaceSource: "execution_scope_registry_only",
  arbitraryWorkspacePathAccepted: false,
  remoteMainAuthoritySource:
    "fixed_product_preflight_safe_checkpoint_commit_ref",
  localOriginTrackingIsRemoteAuthority: false,
  runtimeReconciliationBlocksUnrelatedSourcePublication: false,
  candidateValidationCheckpointRequired: true,
  capsuleValidationIsPublicationAuthority: false,
  effectGateMustRevalidateValidationAndGit: true,
  publicationEffectPerformed: false,
  publicationAuthorityGranted: false,
  compareAndSwapAndRemoteReadbackRequired: true,
} as const;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function normalizedSha(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return GIT_SHA_PATTERN.test(normalized) ? normalized : undefined;
}

function commitRefSha(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const matched = /^git:commit:([a-f0-9]{40}(?:[a-f0-9]{24})?)$/.exec(
    value.trim().toLowerCase(),
  );
  return matched?.[1];
}

function linkedWorkspaces(value: unknown): ScopeLinkedWorkspace[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const workspaces: ScopeLinkedWorkspace[] = [];
  for (const raw of value.slice(0, MAX_LINKED_WORKSPACES)) {
    const item = record(raw);
    const workspaceId = typeof item?.workspaceId === "string"
      ? item.workspaceId
      : undefined;
    const root = typeof item?.root === "string" ? item.root : undefined;
    if (!workspaceId || !root || seen.has(root)) continue;
    seen.add(root);
    workspaces.push({
      workspaceId,
      root,
      ...(item?.mode === "checkout" || item?.mode === "worktree"
        ? { mode: item.mode }
        : {}),
      ...(typeof item?.sourceRoot === "string"
        ? { sourceRoot: item.sourceRoot }
        : {}),
      ...(typeof item?.baseRef === "string" ? { baseRef: item.baseRef } : {}),
      ...(typeof item?.baseSha === "string" ? { baseSha: item.baseSha } : {}),
      ...(typeof item?.managed === "boolean" ? { managed: item.managed } : {}),
    });
  }
  return workspaces;
}

function recoveryBinding(value: unknown): {
  sourceWorkspaceId?: string;
  validationPassed: boolean;
  workspaceFresh: boolean;
  boundCommitShas: Set<string>;
  evidenceRefs: string[];
} {
  const recovery = record(value);
  const capsule = record(recovery?.capsule);
  const validation = record(recovery?.validation);
  const worktree = record(recovery?.worktree);
  const authority = record(recovery?.authority);
  const rawRefs = [
    ...(Array.isArray(recovery?.checkpointRefs) ? recovery.checkpointRefs : []),
    ...(Array.isArray(validation?.refs) ? validation.refs : []),
    ...(Array.isArray(authority?.recordedStateRefs)
      ? authority.recordedStateRefs
      : []),
  ].filter((item): item is string => typeof item === "string");
  const boundCommitShas = new Set<string>();
  for (const ref of rawRefs) {
    const matches = ref.toLowerCase().match(/[a-f0-9]{40}(?:[a-f0-9]{24})?/g);
    for (const candidate of matches ?? []) boundCommitShas.add(candidate);
  }
  return {
    ...(typeof capsule?.sourceWorkspaceId === "string"
      ? { sourceWorkspaceId: capsule.sourceWorkspaceId }
      : {}),
    validationPassed: validation?.state === "passed",
    workspaceFresh: worktree?.workspaceFreshness === "fresh",
    boundCommitShas,
    evidenceRefs: rawRefs.slice(0, 100),
  };
}

function authoritativeRemoteMainSha(
  projection: ZesContinuationPreflightProjection,
): string | undefined {
  if (projection.status !== "available") return undefined;
  const safeCheckpoint = record(projection.preflight.safe_checkpoint);
  return commitRefSha(safeCheckpoint?.commit_ref);
}

function globalPublicationBlockers(
  projection: ZesContinuationPreflightProjection,
): string[] {
  if (projection.status !== "available") {
    return ["continuation_control_plane_not_available"];
  }
  const preflight = projection.preflight;
  const blockers: string[] = [];
  if (preflight.active_writer_detected === true) {
    blockers.push("active_writer_detected");
  } else if (preflight.active_writer_detected !== false) {
    blockers.push("active_writer_state_unobserved");
  }
  if (preflight.writer_state_uncertain === true) {
    blockers.push("writer_state_uncertain");
  } else if (preflight.writer_state_uncertain !== false) {
    blockers.push("writer_uncertainty_state_unobserved");
  }
  if (preflight.publication_authority_valid !== true) {
    blockers.push("publication_authority_invalid_or_unobserved");
  }
  if (preflight.publication_controls_fail_closed !== true) {
    blockers.push("governed_publication_controls_not_fail_closed");
  }
  if (preflight.safe_to_mutate_live !== true) {
    blockers.push("governed_checkout_mutation_not_eligible");
  }
  return blockers;
}

function gitCommand(
  root: string,
  args: string[],
  allowedExitCodes: readonly number[] = [0],
): Promise<GitCommandResult> {
  return new Promise((resolveResult, reject) => {
    execFile(
      "git",
      ["-C", root, ...args],
      {
        encoding: "utf8",
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER_BYTES,
        windowsHide: true,
      },
      (error, stdout) => {
        const exitCode = typeof (error as { code?: unknown } | null)?.code === "number"
          ? (error as { code: number }).code
          : error
            ? -1
            : 0;
        if (!allowedExitCodes.includes(exitCode)) {
          reject(error ?? new Error(`git exited with ${String(exitCode)}`));
          return;
        }
        // Preserve leading porcelain status bytes (for example " M path")
        // while removing only the command's trailing line terminator.
        resolveResult({ stdout: stdout.trimEnd(), exitCode });
      },
    );
  });
}

async function executable(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export class NativeScopePublicationGitPort implements ScopePublicationGitPort {
  private fixedIdentity?: Promise<FixedRepositoryIdentity>;

  constructor(
    private readonly fixedRepositoryRoot = fixedZesRepositoryRoot(),
  ) {}

  async inspect(
    workspace: ScopeLinkedWorkspace,
    authoritativeRemoteMainSha: string,
  ): Promise<ScopePublicationGitObservation> {
    const fixed = await this.fixedRepositoryIdentity();
    const root = await realpath(workspace.root);
    const topLevel = await gitCommand(root, ["rev-parse", "--show-toplevel"]);
    const verifiedTopLevel = await realpath(topLevel.stdout);
    const workspaceRootVerified = verifiedTopLevel === root;
    const origin = await gitCommand(root, ["remote", "get-url", "origin"]);
    const repositoryIdentityDigestSha256 = sha256(origin.stdout);
    const repositoryIdentityMatches =
      repositoryIdentityDigestSha256 === fixed.originDigestSha256;
    if (!repositoryIdentityMatches || !workspaceRootVerified) {
      return {
        workspaceId: workspace.workspaceId,
        repositoryIdentityDigestSha256,
        repositoryIdentityMatches,
        workspaceRootVerified,
        authoritativeRemoteMainPresentLocally: false,
        remoteTrackingMatchesAuthority: false,
        candidateDescendsFromAuthority: false,
        dirtyPathCount: 0,
        worktreeClean: false,
        hooksPathConfigured: false,
        prePushHookExecutable: false,
        expectedPrePushHookDigestSha256: fixed.prePushHookDigestSha256,
        prePushHookIdentityMatches: false,
        publicationControlsFailClosed: false,
        evidenceRefs: [
          `git-workspace-root-sha256:${sha256(root)}`,
          `git-origin-identity-sha256:${repositoryIdentityDigestSha256}`,
        ],
      };
    }

    const branch = await gitCommand(
      root,
      ["symbolic-ref", "--short", "-q", "HEAD"],
      [0, 1],
    );
    const branchName = branch.exitCode === 0 && branch.stdout
      ? branch.stdout
      : undefined;
    const [
      head,
      originMain,
      status,
      pushDefault,
      hooksPath,
      remoteMainPresent,
      ancestor,
      aheadBehind,
      branchRemote,
      branchMerge,
      mergeCommits,
    ] = await Promise.all([
      gitCommand(root, ["rev-parse", "HEAD"]),
      gitCommand(root, ["rev-parse", "refs/remotes/origin/main"], [0, 128]),
      gitCommand(root, ["status", "--porcelain=v1", "-z"]),
      gitCommand(root, ["config", "--get", "push.default"], [0, 1]),
      gitCommand(root, ["config", "--path", "--get", "core.hooksPath"], [0, 1]),
      gitCommand(
        root,
        ["cat-file", "-e", `${authoritativeRemoteMainSha}^{commit}`],
        [0, 1, 128],
      ),
      gitCommand(
        root,
        ["merge-base", "--is-ancestor", authoritativeRemoteMainSha, "HEAD"],
        [0, 1, 128],
      ),
      gitCommand(
        root,
        ["rev-list", "--left-right", "--count", `${authoritativeRemoteMainSha}...HEAD`],
        [0, 128],
      ),
      branchName
        ? gitCommand(root, ["config", "--get", `branch.${branchName}.remote`], [0, 1])
        : Promise.resolve({ stdout: "", exitCode: 1 }),
      branchName
        ? gitCommand(root, ["config", "--get", `branch.${branchName}.merge`], [0, 1])
        : Promise.resolve({ stdout: "", exitCode: 1 }),
      gitCommand(
        root,
        [
          "rev-list",
          "--min-parents=2",
          `${authoritativeRemoteMainSha}..HEAD`,
        ],
        [0, 128],
      ),
    ]);
    const headSha = normalizedSha(head.stdout);
    const originMainSha = normalizedSha(originMain.stdout);
    const statusEntries = status.stdout.length === 0
      ? []
      : status.stdout.split("\0").filter(Boolean);
    const dirtyPathCount = statusEntries.length;
    const configuredHooksPath = hooksPath.exitCode === 0 && hooksPath.stdout
      ? hooksPath.stdout
      : undefined;
    const prePushHookPath = configuredHooksPath
      ? resolve(
          isAbsolute(configuredHooksPath) ? "/" : root,
          configuredHooksPath,
          "pre-push",
        )
      : undefined;
    const prePushHookExecutable = prePushHookPath
      ? await executable(prePushHookPath)
      : false;
    const prePushHookDigestSha256 = prePushHookExecutable && prePushHookPath
      ? sha256(await readFile(prePushHookPath, "utf8"))
      : undefined;
    const prePushHookIdentityMatches =
      prePushHookDigestSha256 === fixed.prePushHookDigestSha256;
    const counts = aheadBehind.exitCode === 0
      ? aheadBehind.stdout.split(/\s+/).map((item) => Number.parseInt(item, 10))
      : [];
    const behindCount = Number.isInteger(counts[0]) ? counts[0] : undefined;
    const aheadCount = Number.isInteger(counts[1]) ? counts[1] : undefined;
    const publicationControlsFailClosed =
      pushDefault.stdout === "nothing"
      && prePushHookExecutable
      && prePushHookIdentityMatches;
    const mergeCommitCount = mergeCommits.exitCode === 0
      ? mergeCommits.stdout.split("\n").filter(Boolean).length
      : undefined;

    return {
      workspaceId: workspace.workspaceId,
      repositoryIdentityDigestSha256,
      repositoryIdentityMatches: true,
      workspaceRootVerified: true,
      ...(branchName ? { branchName } : {}),
      ...(branchRemote.stdout ? { branchRemote: branchRemote.stdout } : {}),
      ...(branchMerge.stdout ? { branchMergeRef: branchMerge.stdout } : {}),
      ...(headSha ? { headSha } : {}),
      ...(originMainSha ? { originMainSha } : {}),
      authoritativeRemoteMainPresentLocally: remoteMainPresent.exitCode === 0,
      remoteTrackingMatchesAuthority: originMainSha === authoritativeRemoteMainSha,
      candidateDescendsFromAuthority: ancestor.exitCode === 0,
      ...(aheadCount === undefined ? {} : { aheadCount }),
      ...(behindCount === undefined ? {} : { behindCount }),
      ...(mergeCommitCount === undefined ? {} : { mergeCommitCount }),
      dirtyPathCount,
      worktreeClean: dirtyPathCount === 0,
      ...(pushDefault.stdout ? { pushDefault: pushDefault.stdout } : {}),
      hooksPathConfigured: Boolean(configuredHooksPath),
      prePushHookExecutable,
      ...(prePushHookDigestSha256
        ? { prePushHookDigestSha256 }
        : {}),
      expectedPrePushHookDigestSha256: fixed.prePushHookDigestSha256,
      prePushHookIdentityMatches,
      publicationControlsFailClosed,
      evidenceRefs: [
        `git-workspace-root-sha256:${sha256(root)}`,
        `git-origin-identity-sha256:${repositoryIdentityDigestSha256}`,
        ...(headSha ? [`git:commit:${headSha}`] : []),
        ...(originMainSha ? [`git:origin-main:${originMainSha}`] : []),
        ...(prePushHookPath
          ? [`git-pre-push-hook-path-sha256:${sha256(prePushHookPath)}`]
          : []),
        ...(prePushHookDigestSha256
          ? [`git-pre-push-hook-sha256:${prePushHookDigestSha256}`]
          : []),
      ],
    };
  }

  private async fixedRepositoryIdentity(): Promise<FixedRepositoryIdentity> {
    if (this.fixedIdentity) return await this.fixedIdentity;
    const pending = (async () => {
      const root = await realpath(this.fixedRepositoryRoot);
      const origin = await gitCommand(root, ["remote", "get-url", "origin"]);
      const hooksPath = await gitCommand(
        root,
        ["config", "--path", "--get", "core.hooksPath"],
      );
      const prePushHookPath = resolve(
        isAbsolute(hooksPath.stdout) ? "/" : root,
        hooksPath.stdout,
        "pre-push",
      );
      if (!await executable(prePushHookPath)) {
        throw new Error("fixed_ZES_pre_push_hook_missing_or_not_executable");
      }
      return {
        originDigestSha256: sha256(origin.stdout),
        prePushHookDigestSha256: sha256(
          await readFile(prePushHookPath, "utf8"),
        ),
      };
    })();
    this.fixedIdentity = pending;
    try {
      return await pending;
    } catch (error) {
      if (this.fixedIdentity === pending) this.fixedIdentity = undefined;
      throw error;
    }
  }
}

export class ZesScopePublicationPreflightAssessor
implements ScopePublicationPreflightSource {
  constructor(
    private readonly gitPort: ScopePublicationGitPort =
      new NativeScopePublicationGitPort(),
    private readonly now: () => number = Date.now,
  ) {}

  async assess(input: {
    workspaces: unknown;
    semanticRecovery?: unknown;
    continuationPreflight: ZesContinuationPreflightProjection;
  }): Promise<ScopePublicationPreflight> {
    const assessedAt = new Date(this.now()).toISOString();
    const continuation = input.continuationPreflight;
    if (continuation.status !== "available") {
      return {
        schemaVersion: 1,
        capabilityRef: "zes.scope-publication.preflight.v1",
        status: "awaiting_continuation_control_plane",
        assessedAt,
        continuationProjectionRef: continuation.projectionRef,
        candidateCount: 0,
        ignoredWorkspaceCount: linkedWorkspaces(input.workspaces).length,
        inspectionFailureCount: 0,
        candidates: [],
        policy: POLICY,
      };
    }
    const remoteMainSha = authoritativeRemoteMainSha(continuation);
    if (!remoteMainSha) {
      return this.unavailable(
        assessedAt,
        continuation.projectionRef,
        new Error("fixed_product_preflight_remote_main_missing"),
      );
    }

    const workspaces = linkedWorkspaces(input.workspaces);
    const generallyInspectableWorkspaces = workspaces.filter((workspace) =>
      workspace.managed === true
      || Boolean(workspace.sourceRoot)
      || Boolean(workspace.baseRef));
    const recovery = recoveryBinding(input.semanticRecovery);
    const inspectableWorkspaces = recovery.sourceWorkspaceId
      ? generallyInspectableWorkspaces.filter(
          (workspace) => workspace.workspaceId === recovery.sourceWorkspaceId,
        )
      : [];
    const globalBlockers = globalPublicationBlockers(continuation);
    try {
      const results = await Promise.all(
        inspectableWorkspaces.map(async (workspace) => {
          try {
            return {
              workspace,
              observation: await this.gitPort.inspect(workspace, remoteMainSha),
            } as const;
          } catch (error) {
            const diagnostic = error instanceof Error
              ? `${error.name}:${error.message}`
              : String(error);
            return {
              workspace,
              diagnosticDigestSha256: sha256(diagnostic),
            } as const;
          }
        }),
      );
      const observations = results.filter(
        (result): result is Extract<typeof result, { observation: ScopePublicationGitObservation }> =>
          "observation" in result,
      );
      const inspectionFailureCount = results.length - observations.length;
      if (observations.length === 0 && inspectionFailureCount > 0) {
        return this.unavailable(
          assessedAt,
          continuation.projectionRef,
          new Error(
            `all_scope_publication_git_observations_failed:${results
              .filter((result) => "diagnosticDigestSha256" in result)
              .map((result) => result.diagnosticDigestSha256)
              .sort()
              .join(",")}`,
          ),
          inspectionFailureCount,
        );
      }
      const matching = observations.filter(
        ({ observation }) => observation.repositoryIdentityMatches,
      );
      const candidates = matching.map(({ workspace, observation }) =>
        this.assessCandidate(
          workspace,
          observation,
          remoteMainSha,
          globalBlockers,
          recovery,
        ));
      return {
        schemaVersion: 1,
        capabilityRef: "zes.scope-publication.preflight.v1",
        status: "available",
        assessedAt,
        continuationProjectionRef: continuation.projectionRef,
        authoritativeRemoteMainSha: remoteMainSha,
        candidateCount: candidates.length,
        ignoredWorkspaceCount: workspaces.length - candidates.length,
        inspectionFailureCount,
        candidates,
        policy: POLICY,
      };
    } catch (error) {
      return this.unavailable(
        assessedAt,
        continuation.projectionRef,
        error,
      );
    }
  }

  private assessCandidate(
    workspace: ScopeLinkedWorkspace,
    observation: ScopePublicationGitObservation,
    remoteMainSha: string,
    globalBlockers: string[],
    recovery: ReturnType<typeof recoveryBinding>,
  ): ScopePublicationCandidateAssessment {
    const blockers = [...globalBlockers];
    if (!observation.workspaceRootVerified) {
      blockers.push("workspace_root_not_verified");
    }
    if (!observation.headSha) blockers.push("candidate_head_missing");
    if (!observation.originMainSha) blockers.push("origin_main_tracking_ref_missing");
    if (!observation.authoritativeRemoteMainPresentLocally) {
      blockers.push("authoritative_remote_main_commit_missing_locally");
    }
    if (!observation.remoteTrackingMatchesAuthority) {
      blockers.push("local_origin_main_differs_from_authoritative_remote_main");
    }
    if (!observation.candidateDescendsFromAuthority) {
      blockers.push("candidate_not_descended_from_authoritative_remote_main");
    }
    if (!observation.worktreeClean) blockers.push("dirty_candidate_worktree");
    if (observation.branchRemote !== "origin") {
      blockers.push("candidate_branch_remote_not_origin");
    }
    if (observation.branchMergeRef !== "refs/heads/main") {
      blockers.push("candidate_branch_merge_target_not_main");
    }
    if (!observation.publicationControlsFailClosed) {
      blockers.push("candidate_publication_controls_not_fail_closed");
    }
    if (!observation.prePushHookIdentityMatches) {
      blockers.push("candidate_pre_push_hook_identity_mismatch");
    }
    if (observation.mergeCommitCount === undefined) {
      blockers.push("candidate_merge_commit_count_unobserved");
    } else if (observation.mergeCommitCount > 0) {
      blockers.push("candidate_range_contains_merge_commits");
    }
    const validationBoundToCandidate = Boolean(
      recovery.sourceWorkspaceId === workspace.workspaceId
      && recovery.validationPassed
      && recovery.workspaceFresh
      && observation.headSha
      && recovery.boundCommitShas.has(observation.headSha),
    );
    if (!validationBoundToCandidate) {
      blockers.push("candidate_validation_checkpoint_not_fresh_or_head_bound");
    }

    const publicationRequired = Boolean(
      observation.headSha && observation.headSha !== remoteMainSha,
    );
    const uniqueBlockers = sortedUnique(blockers);
    const safeToPublish = publicationRequired && uniqueBlockers.length === 0;
    const disposition = !publicationRequired
      ? "not_required"
      : safeToPublish
        ? "eligible"
        : "blocked";
    const evidenceRefs = sortedUnique([
      ...observation.evidenceRefs,
      ...recovery.evidenceRefs,
      `git:authoritative-remote-main:${remoteMainSha}`,
    ]).slice(0, 100);
    let expectedPublication:
      | ScopePublicationCandidateAssessment["expectedPublication"]
      | undefined;
    if (safeToPublish) {
      if (!observation.headSha || !observation.prePushHookDigestSha256) {
        throw new Error(
          "eligible_scope_publication_missing_checkpoint_or_hook_identity",
        );
      }
      expectedPublication = {
        remoteName: "origin",
        remoteRef: "refs/heads/main",
        refspec: "HEAD:refs/heads/main",
        expectedOldSha: remoteMainSha,
        compareAndSwapRequired: true,
        remoteReadbackRequired: true,
        effectGateMustRevalidateCandidateAndAuthority: true,
        validationMustBeRevalidatedBeforeEffect: true,
        prePushGuard: {
          hookDigestSha256: observation.prePushHookDigestSha256,
          environment: {
            ZES_CHECKPOINT_PUBLICATION_GUARD: "1",
            ZES_CHECKPOINT_PUBLICATION_COMMIT: observation.headSha,
            ZES_CHECKPOINT_PUBLICATION_EXPECTED_OLD: remoteMainSha,
          },
        },
      };
    }
    return {
      schemaVersion: 1,
      workspaceId: workspace.workspaceId,
      disposition,
      safeToPublish,
      publicationRequired,
      ...(observation.headSha
        ? { candidateHeadSha: observation.headSha }
        : {}),
      authoritativeRemoteMainSha: remoteMainSha,
      ...(observation.originMainSha
        ? { localOriginMainSha: observation.originMainSha }
        : {}),
      ...(observation.branchName ? { branchName: observation.branchName } : {}),
      ...(observation.aheadCount === undefined
        ? {}
        : { aheadCount: observation.aheadCount }),
      ...(observation.behindCount === undefined
        ? {}
        : { behindCount: observation.behindCount }),
      ...(observation.mergeCommitCount === undefined
        ? {}
        : { mergeCommitCount: observation.mergeCommitCount }),
      dirtyPathCount: observation.dirtyPathCount,
      publicationControlsFailClosed:
        observation.publicationControlsFailClosed,
      validationBoundToCandidate,
      validationEvidenceAuthority:
        "executor_local_git_bound_recovery_capsule",
      validationEvidenceRevalidationRequired: true,
      blockingFactors: uniqueBlockers,
      evidenceRefs,
      ...(expectedPublication ? { expectedPublication } : {}),
    };
  }

  private unavailable(
    assessedAt: string,
    continuationProjectionRef: string,
    error: unknown,
    inspectionFailureCount = 0,
  ): ScopePublicationPreflight {
    const diagnostic = error instanceof Error
      ? `${error.name}:${error.message}`
      : String(error);
    return {
      schemaVersion: 1,
      capabilityRef: "zes.scope-publication.preflight.v1",
      status: "unavailable",
      assessedAt,
      continuationProjectionRef,
      candidateCount: 0,
      ignoredWorkspaceCount: 0,
      inspectionFailureCount,
      candidates: [],
      error: {
        code: "scope_publication_preflight_unavailable",
        diagnosticDigestSha256: sha256(diagnostic),
      },
      policy: POLICY,
    };
  }
}
