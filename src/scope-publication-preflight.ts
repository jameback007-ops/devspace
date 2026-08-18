import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { execFile } from "node:child_process";
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
  remoteTrackingMatchesAuthority?: boolean;
  candidateDescendsFromAuthority: boolean;
  aheadCount?: number;
  behindCount?: number;
  mergeCommitCount?: number;
  dirtyPathCount: number;
  worktreeClean: boolean;
  pushDefault?: string;
  hooksPathConfigured?: boolean;
  prePushHookExecutable?: boolean;
  prePushHookDigestSha256?: string;
  expectedPrePushHookDigestSha256?: string;
  prePushHookIdentityMatches?: boolean;
  publicationControlsFailClosed?: boolean;
  evidenceRefs: string[];
}

export interface ScopePublicationGitPort {
  authoritativeRemoteMain(): Promise<{
    sha: string;
    repositoryIdentityDigestSha256: string;
    evidenceRefs: string[];
  }>;
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
  fullValidationRerunRequired: false;
  evidenceProfile: {
    requiredEvidence: string[];
    skippedEvidence: Array<{
      evidence: string;
      reasonCode: string;
    }>;
  };
  blockingFactors: string[];
  evidenceRefs: string[];
  expectedPublication?: {
    remoteName: "origin";
    remoteRef: "refs/heads/main";
    refspec: `${string}:refs/heads/main`;
    expectedOldSha: string;
    compareAndSwapRequired: true;
    remoteReadbackRequired: true;
    effectGateMustRevalidateCandidateAndAuthority: true;
    validationMustBeRevalidatedBeforeEffect: true;
    validationReceiptMayBeReusedWhenHeadUnchanged: true;
    fullValidationRerunRequired: false;
    localPrePushHookRequired: false;
    optionalLocalDefense?: {
      prePushHookDigestSha256?: string;
      pushDefault?: string;
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
  stageTimingsMs?: {
    remoteAuthority: number;
    candidateInspection: number;
    candidateAssessment: number;
    total: number;
  };
  error?: {
    code: "scope_publication_preflight_unavailable";
    diagnosticDigestSha256: string;
  };
  policy: {
    authority:
      "scope_linked_git_readback_with_fixed_remote_authority";
    inputWorkspaceSource: "execution_scope_registry_only";
    arbitraryWorkspacePathAccepted: false;
    remoteMainAuthoritySource:
      "fresh_fixed_repository_git_ls_remote";
    localOriginTrackingIsRemoteAuthority: false;
    runtimeReconciliationBlocksUnrelatedSourcePublication: false;
    candidateValidationCheckpointRequired: true;
    capsuleValidationIsPublicationAuthority: false;
    effectGateMustRevalidateValidationAndGit: true;
    unrelatedRuntimeWriterStateIsAdvisoryOnly: true;
    branchTrackingAndLocalHookAreNotPublicationAuthority: true;
    exactHeadBoundValidationReceiptMayBeReused: true;
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
  root: string;
  originUrl: string;
  originDigestSha256: string;
  repositoryIdentityDigestSha256: string;
}

const POLICY = {
  authority: "scope_linked_git_readback_with_fixed_remote_authority",
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
} as const;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function elapsedMs(startedAt: number): number {
  return Math.max(0, Math.round((performance.now() - startedAt) * 10) / 10);
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function normalizedSha(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return GIT_SHA_PATTERN.test(normalized) ? normalized : undefined;
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

function globalPublicationBlockers(
  _projection: ZesContinuationPreflightProjection,
): string[] {
  // The global ZES continuation projection describes the governed checkout
  // and runtime. It remains useful advisory evidence, but it cannot prove that
  // a separate clean candidate worktree has an active repository writer or an
  // unresolved effect. Repository publication is instead guarded by exact
  // candidate validation, fixed remote identity, fresh remote authority, a
  // compare-and-swap effect, and authoritative post-effect readback.
  return [];
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

export class NativeScopePublicationGitPort implements ScopePublicationGitPort {
  private fixedIdentity?: Promise<FixedRepositoryIdentity>;

  constructor(
    private readonly fixedRepositoryRoot = fixedZesRepositoryRoot(),
  ) {}

  async authoritativeRemoteMain(): Promise<{
    sha: string;
    repositoryIdentityDigestSha256: string;
    evidenceRefs: string[];
  }> {
    const fixed = await this.fixedRepositoryIdentity();
    const remoteRef = "refs/heads/main";
    const listed = await gitCommand(fixed.root, [
      "ls-remote",
      "--exit-code",
      fixed.originUrl,
      remoteRef,
    ]);
    const line = listed.stdout
      .split(/\r?\n/)
      .find((entry) => entry.endsWith(`\t${remoteRef}`));
    const sha = normalizedSha(line?.split(/\s+/)[0]);
    if (!sha) {
      throw new Error("fixed_ZES_remote_main_readback_invalid");
    }
    const available = await gitCommand(
      fixed.root,
      ["cat-file", "-e", `${sha}^{commit}`],
      [0, 1, 128],
    );
    if (available.exitCode !== 0) {
      const fetched = await gitCommand(
        fixed.root,
        [
          "fetch",
          "--no-tags",
          "--no-write-fetch-head",
          fixed.originUrl,
          remoteRef,
        ],
        [0, 1, 128],
      );
      if (fetched.exitCode !== 0) {
        throw new Error("fixed_ZES_remote_main_fetch_failed");
      }
    }
    const verified = await gitCommand(
      fixed.root,
      ["cat-file", "-e", `${sha}^{commit}`],
      [0, 1, 128],
    );
    if (verified.exitCode !== 0) {
      throw new Error("fixed_ZES_remote_main_object_unavailable");
    }
    return {
      sha,
      repositoryIdentityDigestSha256:
        fixed.repositoryIdentityDigestSha256,
      evidenceRefs: [
        `git:authoritative-remote-main:${sha}`,
        `git-fixed-repository-identity-sha256:${fixed.repositoryIdentityDigestSha256}`,
        `git-origin-identity-sha256:${fixed.originDigestSha256}`,
      ],
    };
  }

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
        candidateDescendsFromAuthority: false,
        dirtyPathCount: 0,
        worktreeClean: false,
        evidenceRefs: [
          `git-workspace-root-sha256:${sha256(root)}`,
          `git-origin-identity-sha256:${repositoryIdentityDigestSha256}`,
        ],
      };
    }

    const [
      head,
      status,
      remoteMainPresent,
      ancestor,
      aheadBehind,
      mergeCommits,
    ] = await Promise.all([
      gitCommand(root, ["rev-parse", "HEAD"]),
      gitCommand(root, ["status", "--porcelain=v1", "-z"]),
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
    const statusEntries = status.stdout.length === 0
      ? []
      : status.stdout.split("\0").filter(Boolean);
    const dirtyPathCount = statusEntries.length;
    const counts = aheadBehind.exitCode === 0
      ? aheadBehind.stdout.split(/\s+/).map((item) => Number.parseInt(item, 10))
      : [];
    const behindCount = Number.isInteger(counts[0]) ? counts[0] : undefined;
    const aheadCount = Number.isInteger(counts[1]) ? counts[1] : undefined;
    const mergeCommitCount = mergeCommits.exitCode === 0
      ? mergeCommits.stdout.split("\n").filter(Boolean).length
      : undefined;

    return {
      workspaceId: workspace.workspaceId,
      repositoryIdentityDigestSha256,
      repositoryIdentityMatches: true,
      workspaceRootVerified: true,
      ...(headSha ? { headSha } : {}),
      authoritativeRemoteMainPresentLocally: remoteMainPresent.exitCode === 0,
      candidateDescendsFromAuthority: ancestor.exitCode === 0,
      ...(aheadCount === undefined ? {} : { aheadCount }),
      ...(behindCount === undefined ? {} : { behindCount }),
      ...(mergeCommitCount === undefined ? {} : { mergeCommitCount }),
      dirtyPathCount,
      worktreeClean: dirtyPathCount === 0,
      evidenceRefs: [
        `git-workspace-root-sha256:${sha256(root)}`,
        `git-origin-identity-sha256:${repositoryIdentityDigestSha256}`,
        ...(headSha ? [`git:commit:${headSha}`] : []),
      ],
    };
  }

  private async fixedRepositoryIdentity(): Promise<FixedRepositoryIdentity> {
    if (this.fixedIdentity) return await this.fixedIdentity;
    const pending = (async () => {
      const root = await realpath(this.fixedRepositoryRoot);
      const origin = await gitCommand(root, ["remote", "get-url", "origin"]);
      const originUrl = origin.stdout;
      return {
        root,
        originUrl,
        originDigestSha256: sha256(originUrl),
        repositoryIdentityDigestSha256: sha256([
          root,
          originUrl,
          "refs/heads/main",
        ].join("\0")),
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
    const totalStartedAt = performance.now();
    const assessedAt = new Date(this.now()).toISOString();
    const continuation = input.continuationPreflight;
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
    if (inspectableWorkspaces.length === 0) {
      return {
        schemaVersion: 1,
        capabilityRef: "zes.scope-publication.preflight.v1",
        status: "available",
        assessedAt,
        continuationProjectionRef: continuation.projectionRef,
        candidateCount: 0,
        ignoredWorkspaceCount: workspaces.length,
        inspectionFailureCount: 0,
        candidates: [],
        stageTimingsMs: {
          remoteAuthority: 0,
          candidateInspection: 0,
          candidateAssessment: 0,
          total: elapsedMs(totalStartedAt),
        },
        policy: POLICY,
      };
    }

    let remoteAuthority: Awaited<
      ReturnType<ScopePublicationGitPort["authoritativeRemoteMain"]>
    >;
    const remoteAuthorityStartedAt = performance.now();
    try {
      remoteAuthority = await this.gitPort.authoritativeRemoteMain();
    } catch (error) {
      return this.unavailable(
        assessedAt,
        continuation.projectionRef,
        error,
      );
    }
    const remoteAuthorityMs = elapsedMs(remoteAuthorityStartedAt);
    const remoteMainSha = remoteAuthority.sha;
    const globalBlockers = globalPublicationBlockers(continuation);
    try {
      const candidateInspectionStartedAt = performance.now();
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
      const candidateInspectionMs = elapsedMs(candidateInspectionStartedAt);
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
      const candidateAssessmentStartedAt = performance.now();
      const candidates = matching.map(({ workspace, observation }) =>
        this.assessCandidate(
          workspace,
          observation,
          remoteMainSha,
          globalBlockers,
          recovery,
          remoteAuthority.evidenceRefs,
        ));
      const candidateAssessmentMs = elapsedMs(candidateAssessmentStartedAt);
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
        stageTimingsMs: {
          remoteAuthority: remoteAuthorityMs,
          candidateInspection: candidateInspectionMs,
          candidateAssessment: candidateAssessmentMs,
          total: elapsedMs(totalStartedAt),
        },
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
    remoteAuthorityEvidenceRefs: string[],
  ): ScopePublicationCandidateAssessment {
    const blockers = [...globalBlockers];
    if (!observation.workspaceRootVerified) {
      blockers.push("workspace_root_not_verified");
    }
    if (!observation.headSha) blockers.push("candidate_head_missing");
    if (!observation.authoritativeRemoteMainPresentLocally) {
      blockers.push("authoritative_remote_main_commit_missing_locally");
    }
    if (!observation.candidateDescendsFromAuthority) {
      blockers.push("candidate_not_descended_from_authoritative_remote_main");
    }
    if (!observation.worktreeClean) blockers.push("dirty_candidate_worktree");
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
      ...remoteAuthorityEvidenceRefs,
      `git:authoritative-remote-main:${remoteMainSha}`,
    ]).slice(0, 100);
    const evidenceProfile = {
      requiredEvidence: [
        "fixed_repository_identity",
        "fresh_remote_main_readback",
        "exact_candidate_sha_and_cleanliness",
        "candidate_descends_from_remote_main_and_is_zero_behind",
        "no_merge_commit_candidate_range",
        "validation_receipt_bound_to_exact_candidate",
        "compare_and_swap_effect_and_post_push_readback",
      ],
      skippedEvidence: [
        {
          evidence: "global_Codex_or_AOQ_runtime_writer_state",
          reasonCode: "unrelated_runtime_state_is_not_repository_writer_authority",
        },
        {
          evidence: "candidate_branch_tracking_configuration",
          reasonCode: "effect_uses_fixed_remote_branch_and_exact_sha_refspec",
        },
        {
          evidence: "candidate_local_pre_push_hook_identity",
          reasonCode: "fixed_effect_gate_revalidates_CAS_and_remote_readback",
        },
        {
          evidence: "full_validation_rerun",
          reasonCode: "immutable_validation_receipt_is_bound_to_unchanged_HEAD",
        },
      ],
    };
    let expectedPublication:
      | ScopePublicationCandidateAssessment["expectedPublication"]
      | undefined;
    if (safeToPublish) {
      if (!observation.headSha) {
        throw new Error("eligible_scope_publication_missing_checkpoint");
      }
      expectedPublication = {
        remoteName: "origin",
        remoteRef: "refs/heads/main",
        refspec: `${observation.headSha}:refs/heads/main`,
        expectedOldSha: remoteMainSha,
        compareAndSwapRequired: true,
        remoteReadbackRequired: true,
        effectGateMustRevalidateCandidateAndAuthority: true,
        validationMustBeRevalidatedBeforeEffect: true,
        validationReceiptMayBeReusedWhenHeadUnchanged: true,
        fullValidationRerunRequired: false,
        localPrePushHookRequired: false,
        ...(observation.prePushHookDigestSha256 || observation.pushDefault
          ? {
              optionalLocalDefense: {
                ...(observation.prePushHookDigestSha256
                  ? {
                      prePushHookDigestSha256:
                        observation.prePushHookDigestSha256,
                    }
                  : {}),
                ...(observation.pushDefault
                  ? { pushDefault: observation.pushDefault }
                  : {}),
              },
            }
          : {}),
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
      ...(observation.publicationControlsFailClosed === undefined
        ? {}
        : {
            publicationControlsFailClosed:
              observation.publicationControlsFailClosed,
          }),
      validationBoundToCandidate,
      validationEvidenceAuthority:
        "executor_local_git_bound_recovery_capsule",
      validationEvidenceRevalidationRequired: true,
      fullValidationRerunRequired: false,
      evidenceProfile,
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
