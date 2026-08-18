import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import type { SelfRepositoryPublicationConfig } from "./config.js";
import {
  buildPublicationRiskProfile,
  type PublicationRiskProfile,
} from "./publication-risk-profile.js";
import { assessWorkspaceCandidateLifecycle } from "./workspace-candidate-lifecycle.js";
import type { WorkspaceStore } from "./workspace-store.js";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 60_000;
const SCOPE_PROJECTION_REMOTE_TIMEOUT_MS = 5_000;
const MAX_GIT_OUTPUT_BYTES = 10 * 1024 * 1024;
const SHA_PATTERN = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;

type PublicationStore = Pick<WorkspaceStore, "getSession" | "workspaceActivity">;

export interface SelfRepositoryPublicationPreflightInput {
  workspaceId: string;
}

export interface SelfRepositoryPublicationExecuteInput
  extends SelfRepositoryPublicationPreflightInput {
  planIdSha256: string;
}

export interface SelfRepositoryPublicationCandidate {
  schemaVersion: 1;
  capabilityRef: "devspace.self-repository-publication.preflight.v1";
  assessedAt: string;
  planIdSha256: string;
  workspaceId: string;
  status: "eligible" | "blocked" | "not_required" | "unavailable";
  safeToPublish: boolean;
  publicationRequired: boolean;
  candidateHeadSha?: string;
  candidateBranch?: string;
  candidateLifecycleDigestSha256?: string;
  validationEvidenceDigestSha256?: string;
  validationBoundToCandidate: boolean;
  validationEvidenceCount?: number;
  declaredWriterState?: string;
  declaredEffectState?: string;
  declaredSafeToPublish?: boolean;
  publicationProfile?: PublicationRiskProfile;
  receiptReuse?: {
    validationReceipt: "reused_exact_head_bound" | "missing_or_stale";
    fullValidationRerunRequired: false;
    effectGateMustVerifyReceiptBinding: true;
  };
  publicationFreeze?: {
    mode: "publication_only_terminal";
    candidateMutationInvalidatesPlan: true;
    newResearchOrFeatureExpansionAllowed: false;
    exception: "reproducible_publication_blocking_defect_only";
  };
  stageTimingsMs?: {
    lifecycle: number;
    remoteAuthority: number;
    comparisonAndProfile: number;
    total: number;
  };
  remoteName: string;
  remoteBranch: string;
  remoteUrlIdentityMatches: boolean;
  remoteUrlDigestSha256?: string;
  repositoryIdentityDigestSha256?: string;
  authoritativeRemoteMainSha?: string;
  remoteAuthorityObjectAvailableLocally?: boolean;
  behindCount?: number;
  aheadCount?: number;
  mergeCommitCount?: number;
  candidateDescendsFromRemoteAuthority?: boolean;
  blockingFactors: string[];
  expectedPublication?: {
    remoteName: string;
    remoteRef: string;
    refspec: string;
    expectedOldSha: string;
    forceWithLeaseArg: string;
    compareAndSwapRequired: true;
    freshRemoteReadbackRequiredBeforeEffect: true;
    remoteReadbackRequiredAfterEffect: true;
  };
  policy: {
    repositoryAuthorityKind: "fixed_devspace_self_repository";
    repositoryRootConfigured: true;
    remoteIdentityConfigured: true;
    arbitraryRepositoryPathAccepted: false;
    arbitraryRemoteAccepted: false;
    arbitraryBranchAccepted: false;
    remoteAuthoritySource: "fresh_git_ls_remote";
    localTrackingRefIsRemoteAuthority: false;
    exactHeadBoundValidationRequired: true;
    explicitWriterReleaseRequired: false;
    explicitEffectTerminalityRequired: false;
    explicitPublicationSafetyAttestationRequired: false;
    exactDeclaredMaterialEffectReconciliationRequired: true;
    repositoryLocalPublicationLeaseRequired: true;
    remoteCompareAndSwapIsFinalConcurrencyGuard: true;
    unchangedHeadBoundValidationReceiptMayBeReused: true;
    zeroBehindRequired: true;
    mergeCommitsAllowed: false;
    publicationEffectPerformed: false;
    publicationAuthorityGranted: false;
    effectsEnabled: boolean;
    unrelatedZesRuntimeOrWriterStateCanBlockPublication: false;
  };
}

export interface SelfRepositoryScopePublicationProjection {
  schemaVersion: 1;
  capabilityRef: "devspace.self-repository-publication.scope-preflight.v1";
  status: "available";
  assessedAt: string;
  candidateCount: number;
  eligibleCount: number;
  blockedCount: number;
  notRequiredCount: number;
  unavailableCount: number;
  candidates: SelfRepositoryPublicationCandidate[];
  policy: {
    authority: "fixed_server_owned_self_repository_publication_contract";
    inputWorkspaceSource: "execution_scope_registry_only";
    arbitraryWorkspacePathAccepted: false;
    publicationEffectPerformed: false;
    publicationAuthorityGranted: false;
    remoteAuthorityReadMode: "fresh_ls_remote_without_object_import";
    remoteObjectFetchPerformed: false;
  };
}

interface RemoteAuthority {
  sha: string;
  remoteUrl: string;
  remoteUrlDigestSha256: string;
  repositoryIdentityDigestSha256: string;
}

class ConfiguredRemoteIdentityMismatchError extends Error {
  constructor(
    readonly remoteUrlDigestSha256: string,
    readonly repositoryIdentityDigestSha256: string,
  ) {
    super("configured_remote_identity_mismatch");
    this.name = "ConfiguredRemoteIdentityMismatchError";
  }
}

const SCOPE_POLICY = {
  authority: "fixed_server_owned_self_repository_publication_contract",
  inputWorkspaceSource: "execution_scope_registry_only",
  arbitraryWorkspacePathAccepted: false,
  publicationEffectPerformed: false,
  publicationAuthorityGranted: false,
  remoteAuthorityReadMode: "fresh_ls_remote_without_object_import",
  remoteObjectFetchPerformed: false,
} as const;

export class SelfRepositoryPublicationManager {
  private readonly completedEffects = new Map<string, Record<string, unknown>>();
  private readonly inFlightPlans = new Set<string>();
  private publicationLease?: {
    workspaceId: string;
    planIdSha256: string;
  };

  constructor(
    private readonly config: SelfRepositoryPublicationConfig,
    private readonly store: PublicationStore,
    private readonly now: () => number = Date.now,
  ) {
    if (
      !config.enabled
      || !config.repositoryRoot
      || !config.expectedRemoteUrl
    ) {
      throw new Error(
        "SelfRepositoryPublicationManager requires an enabled, fully configured fixed repository contract.",
      );
    }
  }

  async preflight(
    input: SelfRepositoryPublicationPreflightInput,
  ): Promise<SelfRepositoryPublicationCandidate> {
    return this.preflightWithRemote(input);
  }

  private async preflightWithRemote(
    input: SelfRepositoryPublicationPreflightInput,
    sharedRemoteAuthority?: Promise<RemoteAuthority>,
  ): Promise<SelfRepositoryPublicationCandidate> {
    const totalStartedAt = performance.now();
    const assessedAt = new Date(this.now()).toISOString();
    const session = this.store.getSession(input.workspaceId);
    const base = this.baseCandidate(input.workspaceId, assessedAt);
    if (!session) {
      return finalizeCandidate(base, {
        status: "unavailable",
        blockingFactors: ["workspace_session_not_found"],
      });
    }
    if (session.mode !== "worktree" || !session.managed || !session.sourceRoot) {
      return finalizeCandidate(base, {
        status: "unavailable",
        blockingFactors: ["workspace_is_not_a_managed_worktree"],
      });
    }

    let repositoryRoot: string;
    let sourceRoot: string;
    try {
      repositoryRoot = await realpath(this.config.repositoryRoot!);
      sourceRoot = await realpath(session.sourceRoot);
    } catch (error) {
      return finalizeCandidate(base, {
        status: "unavailable",
        blockingFactors: ["repository_root_unavailable"],
        diagnostic: error,
      });
    }
    if (repositoryRoot !== sourceRoot) {
      return finalizeCandidate(base, {
        status: "unavailable",
        blockingFactors: ["workspace_repository_identity_mismatch"],
      });
    }

    const lifecycleStartedAt = performance.now();
    const rootExists = await directoryExists(session.root);
    const activity = this.store.workspaceActivity(session.id);
    const lifecycle = await assessWorkspaceCandidateLifecycle({
      path: session.root,
      rootExists,
      registered: true,
      session,
      activity,
      loadedInCurrentRuntime: false,
      runningProcessCount: 0,
      externalProcessReferences: [],
      activeWithinHours: 0.01,
      nowMs: this.now(),
    });
    const lifecycleMs = elapsedMs(lifecycleStartedAt);
    const validationEvidenceDigestSha256 = sha256(
      stableJson(lifecycle.validation),
    );
    const candidateHead = lifecycle.git.head;
    const candidateCwd = rootExists ? session.root : repositoryRoot;
    const semantic = activity.recovery?.semantic;
    const declaredWriterState = typeof semantic?.writerState === "string"
      ? semantic.writerState
      : undefined;
    const declaredEffectState = typeof semantic?.effectState === "string"
      ? semantic.effectState
      : undefined;
    const declaredSafeToPublish = typeof semantic?.safeToPublish === "boolean"
      ? semantic.safeToPublish
      : undefined;
    if (!lifecycle.git.readable || !candidateHead) {
      return finalizeCandidate({
        ...base,
        candidateLifecycleDigestSha256: lifecycle.lifecycleDigestSha256,
        validationEvidenceDigestSha256,
        validationBoundToCandidate: lifecycle.validation.boundToCurrentHead,
        validationEvidenceCount: lifecycle.validation.evidenceRefs.length,
        declaredWriterState,
        declaredEffectState,
        declaredSafeToPublish,
      }, {
        status: "unavailable",
        blockingFactors: ["candidate_git_state_unavailable"],
      });
    }

    const remoteAuthorityStartedAt = performance.now();
    let remote: RemoteAuthority;
    try {
      remote = sharedRemoteAuthority
        ? await sharedRemoteAuthority
        : await this.readAndPrepareRemoteAuthority(repositoryRoot);
    } catch (error) {
      if (error instanceof ConfiguredRemoteIdentityMismatchError) {
        return finalizeCandidate({
          ...base,
          candidateHeadSha: candidateHead,
          candidateBranch: lifecycle.git.branch,
          candidateLifecycleDigestSha256: lifecycle.lifecycleDigestSha256,
          validationEvidenceDigestSha256,
          validationBoundToCandidate: lifecycle.validation.boundToCurrentHead,
          validationEvidenceCount: lifecycle.validation.evidenceRefs.length,
          declaredWriterState,
          declaredEffectState,
          declaredSafeToPublish,
          remoteUrlIdentityMatches: false,
          remoteUrlDigestSha256: error.remoteUrlDigestSha256,
          repositoryIdentityDigestSha256:
            error.repositoryIdentityDigestSha256,
        }, {
          status: "blocked",
          blockingFactors: ["configured_remote_identity_mismatch"],
        });
      }
      return finalizeCandidate({
        ...base,
        candidateHeadSha: candidateHead,
        candidateBranch: lifecycle.git.branch,
        candidateLifecycleDigestSha256: lifecycle.lifecycleDigestSha256,
        validationEvidenceDigestSha256,
        validationBoundToCandidate: lifecycle.validation.boundToCurrentHead,
        validationEvidenceCount: lifecycle.validation.evidenceRefs.length,
        declaredWriterState,
        declaredEffectState,
        declaredSafeToPublish,
      }, {
        status: "unavailable",
        blockingFactors: ["fresh_remote_authority_unavailable"],
        diagnostic: error,
      });
    }
    const remoteAuthorityMs = elapsedMs(remoteAuthorityStartedAt);

    const remoteAuthorityObjectAvailableLocally = await commitAvailableLocally(
      repositoryRoot,
      remote.sha,
    );
    if (!remoteAuthorityObjectAvailableLocally) {
      return finalizeCandidate({
        ...base,
        candidateHeadSha: candidateHead,
        candidateBranch: lifecycle.git.branch,
        candidateLifecycleDigestSha256: lifecycle.lifecycleDigestSha256,
        validationEvidenceDigestSha256,
        validationBoundToCandidate: lifecycle.validation.boundToCurrentHead,
        validationEvidenceCount: lifecycle.validation.evidenceRefs.length,
        declaredWriterState,
        declaredEffectState,
        declaredSafeToPublish,
        remoteUrlIdentityMatches: true,
        remoteUrlDigestSha256: remote.remoteUrlDigestSha256,
        repositoryIdentityDigestSha256: remote.repositoryIdentityDigestSha256,
        authoritativeRemoteMainSha: remote.sha,
        remoteAuthorityObjectAvailableLocally: false,
      }, {
        status: "unavailable",
        blockingFactors: [
          "remote_authority_object_not_available_locally_use_direct_preflight",
        ],
      });
    }

    const comparisonStartedAt = performance.now();
    const remoteUrlIdentityMatches = remote.remoteUrl === this.config.expectedRemoteUrl;
    let counts: Awaited<ReturnType<typeof leftRightCounts>>;
    let candidateDescendsFromRemoteAuthority: boolean;
    let mergeCommitCount: number | undefined;
    let changedPaths: string[];
    try {
      counts = await leftRightCounts(candidateCwd, remote.sha, candidateHead);
      candidateDescendsFromRemoteAuthority = await isAncestor(
        candidateCwd,
        remote.sha,
        candidateHead,
      );
      mergeCommitCount = await integerGitOutput(candidateCwd, [
        "rev-list",
        "--count",
        "--merges",
        `${remote.sha}..${candidateHead}`,
      ]);
      changedPaths = await changedPathsBetween(
        candidateCwd,
        remote.sha,
        candidateHead,
      );
    } catch (error) {
      return finalizeCandidate({
        ...base,
        candidateHeadSha: candidateHead,
        candidateBranch: lifecycle.git.branch,
        candidateLifecycleDigestSha256: lifecycle.lifecycleDigestSha256,
        validationEvidenceDigestSha256,
        validationBoundToCandidate: lifecycle.validation.boundToCurrentHead,
        validationEvidenceCount: lifecycle.validation.evidenceRefs.length,
        declaredWriterState,
        declaredEffectState,
        declaredSafeToPublish,
        remoteUrlIdentityMatches,
        remoteUrlDigestSha256: remote.remoteUrlDigestSha256,
        repositoryIdentityDigestSha256: remote.repositoryIdentityDigestSha256,
        authoritativeRemoteMainSha: remote.sha,
        remoteAuthorityObjectAvailableLocally: true,
      }, {
        status: "unavailable",
        blockingFactors: ["candidate_remote_comparison_unavailable"],
        diagnostic: error,
      });
    }
    const publicationProfile = buildPublicationRiskProfile({
      changedPaths,
      semantic,
    });
    const publicationRequired = candidateHead !== remote.sha;
    const blockers: string[] = [];
    if (!remoteUrlIdentityMatches) blockers.push("configured_remote_identity_mismatch");
    if (lifecycle.git.dirty) blockers.push("candidate_worktree_dirty");
    if (!lifecycle.validation.boundToCurrentHead) {
      blockers.push("candidate_validation_missing_or_stale");
    }
    if (publicationProfile.materialEffectReconciliationRequired) {
      blockers.push("declared_material_effect_requires_reconciliation");
    }
    if (!candidateDescendsFromRemoteAuthority) {
      blockers.push("candidate_does_not_descend_from_remote_authority");
    }
    if ((counts.behindCount ?? 0) !== 0) blockers.push("candidate_behind_remote_authority");
    if ((mergeCommitCount ?? 0) !== 0) blockers.push("candidate_contains_merge_commits");
    if (publicationRequired && (counts.aheadCount ?? 0) === 0) {
      blockers.push("candidate_has_no_publishable_commits");
    }
    const uniqueBlockers = [...new Set(blockers)].sort();
    const safeToPublish = publicationRequired && uniqueBlockers.length === 0;
    const status: SelfRepositoryPublicationCandidate["status"] = uniqueBlockers.length > 0
      ? "blocked"
      : !publicationRequired
        ? "not_required"
        : "eligible";
    const comparisonAndProfileMs = elapsedMs(comparisonStartedAt);
    const data = {
      ...base,
      status,
      safeToPublish,
      publicationRequired,
      candidateHeadSha: candidateHead,
      candidateBranch: lifecycle.git.branch,
      candidateLifecycleDigestSha256: lifecycle.lifecycleDigestSha256,
      validationEvidenceDigestSha256,
      validationBoundToCandidate: lifecycle.validation.boundToCurrentHead,
      validationEvidenceCount: lifecycle.validation.evidenceRefs.length,
      declaredWriterState,
      declaredEffectState,
      declaredSafeToPublish,
      publicationProfile,
      receiptReuse: {
        validationReceipt: lifecycle.validation.boundToCurrentHead
          ? "reused_exact_head_bound" as const
          : "missing_or_stale" as const,
        fullValidationRerunRequired: false as const,
        effectGateMustVerifyReceiptBinding: true as const,
      },
      remoteUrlIdentityMatches,
      remoteUrlDigestSha256: remote.remoteUrlDigestSha256,
      repositoryIdentityDigestSha256: remote.repositoryIdentityDigestSha256,
      authoritativeRemoteMainSha: remote.sha,
      remoteAuthorityObjectAvailableLocally: true,
      behindCount: counts.behindCount,
      aheadCount: counts.aheadCount,
      mergeCommitCount,
      candidateDescendsFromRemoteAuthority,
      blockingFactors: uniqueBlockers,
      stageTimingsMs: {
        lifecycle: lifecycleMs,
        remoteAuthority: remoteAuthorityMs,
        comparisonAndProfile: comparisonAndProfileMs,
        total: elapsedMs(totalStartedAt),
      },
      ...(safeToPublish
        ? {
            publicationFreeze: {
              mode: "publication_only_terminal" as const,
              candidateMutationInvalidatesPlan: true as const,
              newResearchOrFeatureExpansionAllowed: false as const,
              exception: "reproducible_publication_blocking_defect_only" as const,
            },
            expectedPublication: {
              remoteName: this.config.remoteName,
              remoteRef: `refs/heads/${this.config.branchName}`,
              refspec: `${candidateHead}:refs/heads/${this.config.branchName}`,
              expectedOldSha: remote.sha,
              forceWithLeaseArg:
                `--force-with-lease=refs/heads/${this.config.branchName}:${remote.sha}`,
              compareAndSwapRequired: true as const,
              freshRemoteReadbackRequiredBeforeEffect: true as const,
              remoteReadbackRequiredAfterEffect: true as const,
            },
          }
        : {}),
    };
    return {
      ...data,
      planIdSha256: planDigest(data),
    };
  }

  async scopeProjection(workspaces: unknown): Promise<SelfRepositoryScopePublicationProjection> {
    const assessedAt = new Date(this.now()).toISOString();
    const workspaceIds = linkedWorkspaceIds(workspaces);
    const targetWorkspaceIds: string[] = [];
    for (const workspaceId of workspaceIds) {
      const session = this.store.getSession(workspaceId);
      if (!session?.sourceRoot) continue;
      if (!await sameRealPath(session.sourceRoot, this.config.repositoryRoot!)) continue;
      targetWorkspaceIds.push(workspaceId);
    }
    const sharedRemoteAuthority = targetWorkspaceIds.length > 0
      ? this.readRemoteAuthority(
          this.config.repositoryRoot!,
          SCOPE_PROJECTION_REMOTE_TIMEOUT_MS,
        )
      : undefined;
    const candidates: SelfRepositoryPublicationCandidate[] = [];
    for (const workspaceId of targetWorkspaceIds) {
      candidates.push(await this.preflightWithRemote(
        { workspaceId },
        sharedRemoteAuthority,
      ));
    }
    return {
      schemaVersion: 1,
      capabilityRef: "devspace.self-repository-publication.scope-preflight.v1",
      status: "available",
      assessedAt,
      candidateCount: candidates.length,
      eligibleCount: candidates.filter((candidate) => candidate.status === "eligible").length,
      blockedCount: candidates.filter((candidate) => candidate.status === "blocked").length,
      notRequiredCount:
        candidates.filter((candidate) => candidate.status === "not_required").length,
      unavailableCount:
        candidates.filter((candidate) => candidate.status === "unavailable").length,
      candidates,
      policy: SCOPE_POLICY,
    };
  }

  async execute(
    input: SelfRepositoryPublicationExecuteInput,
  ): Promise<Record<string, unknown>> {
    if (!this.config.effectsEnabled) {
      throw new Error("self_repository_publication_effects_disabled");
    }
    if (!/^[a-f0-9]{64}$/.test(input.planIdSha256)) {
      throw new Error("planIdSha256_must_be_a_lowercase_sha256_digest");
    }
    const completed = this.completedEffects.get(input.planIdSha256);
    if (completed) {
      return {
        ...structuredClone(completed),
        idempotentReplay: true,
      };
    }
    if (this.inFlightPlans.has(input.planIdSha256)) {
      throw new Error("self_repository_publication_plan_effect_in_flight");
    }
    if (this.publicationLease) {
      throw new Error("self_repository_publication_lease_held");
    }

    this.inFlightPlans.add(input.planIdSha256);
    this.publicationLease = {
      workspaceId: input.workspaceId,
      planIdSha256: input.planIdSha256,
    };
    const effectStartedAt = performance.now();
    try {
      const preflight = await this.preflight({ workspaceId: input.workspaceId });
      if (preflight.planIdSha256 !== input.planIdSha256) {
        if (
          preflight.status === "not_required"
          && preflight.candidateHeadSha
          && preflight.authoritativeRemoteMainSha === preflight.candidateHeadSha
        ) {
          const reconciled = this.alreadyPublishedResult({
            input,
            preflight,
            totalMs: elapsedMs(effectStartedAt),
          });
          this.completedEffects.set(
            input.planIdSha256,
            structuredClone(reconciled),
          );
          return reconciled;
        }
        throw new Error(
          "self_repository_publication_plan_changed_reassess_before_retry",
        );
      }
      if (
        !preflight.safeToPublish
        || !preflight.expectedPublication
        || !preflight.candidateHeadSha
      ) {
        throw new Error("self_repository_candidate_not_eligible_for_publication");
      }
      const session = this.store.getSession(input.workspaceId);
      if (!session) throw new Error("workspace_session_not_found");
      const cwd = await directoryExists(session.root)
        ? session.root
        : this.config.repositoryRoot!;

      const beforeStartedAt = performance.now();
      const immediatelyBefore = await this.readRemoteAuthority(
        this.config.repositoryRoot!,
      );
      const beforeReadbackMs = elapsedMs(beforeStartedAt);
      if (immediatelyBefore.sha === preflight.candidateHeadSha) {
        const reconciled = this.alreadyPublishedResult({
          input,
          preflight,
          totalMs: elapsedMs(effectStartedAt),
          remote: immediatelyBefore,
          beforeReadbackMs,
        });
        this.completedEffects.set(
          input.planIdSha256,
          structuredClone(reconciled),
        );
        return reconciled;
      }
      if (immediatelyBefore.sha !== preflight.expectedPublication.expectedOldSha) {
        throw new Error("remote_authority_changed_before_publication");
      }

      const pushStartedAt = performance.now();
      const push = await gitResult(cwd, [
        "push",
        preflight.expectedPublication.forceWithLeaseArg,
        this.config.expectedRemoteUrl!,
        preflight.expectedPublication.refspec,
      ]);
      const pushMs = elapsedMs(pushStartedAt);
      const afterStartedAt = performance.now();
      const after = await this.readRemoteAuthority(this.config.repositoryRoot!);
      const afterReadbackMs = elapsedMs(afterStartedAt);
      const published = after.sha === preflight.candidateHeadSha;
      if (!published) {
        throw new Error(
          push.exitCode === 0
            ? "remote_readback_did_not_match_published_candidate"
            : "publication_failed_and_remote_state_did_not_advance",
        );
      }

      const mirrorStartedAt = performance.now();
      const localAuthorityMirror = await mirrorRemoteAuthorityLocally({
        cwd: this.config.repositoryRoot!,
        remoteName: this.config.remoteName,
        branchName: this.config.branchName,
        remoteSha: after.sha,
      });
      const localMirrorMs = elapsedMs(mirrorStartedAt);
      const baseOutcome = push.exitCode === 0
        ? "published"
        : "published_after_indeterminate_push_transport";
      const residuals = localAuthorityMirror.synced
        ? []
        : [{
            code: "local_authority_mirror_reconciliation_required",
            retryPolicy:
              "reconcile_local_authority_ref_without_repeating_publication",
          }];
      const result = {
        schemaVersion: 1,
        capabilityRef: "devspace.self-repository-publication.effect.v1",
        outcome: baseOutcome,
        publicationEffectTerminal: true,
        idempotentReplay: false,
        workspaceId: input.workspaceId,
        candidateHeadSha: preflight.candidateHeadSha,
        expectedOldSha: preflight.expectedPublication.expectedOldSha,
        observedRemoteSha: after.sha,
        planIdSha256: input.planIdSha256,
        publicationLeaseRef: sha256([
          input.workspaceId,
          input.planIdSha256,
          preflight.candidateHeadSha,
        ].join("\0")),
        remoteName: this.config.remoteName,
        remoteBranch: this.config.branchName,
        remoteUrlDigestSha256: after.remoteUrlDigestSha256,
        repositoryIdentityDigestSha256: after.repositoryIdentityDigestSha256,
        publicationProfile: preflight.publicationProfile,
        deploymentFollowUpRequired:
          preflight.publicationProfile?.runtimeDeploymentRequired ?? false,
        pushExitCode: push.exitCode,
        pushDiagnosticDigestSha256: sha256(`${push.stdout}\n${push.stderr}`),
        localAuthorityMirror,
        residuals,
        retryPolicy: residuals.length === 0
          ? "not_required"
          : "reconcile_local_residual_without_repeating_publication",
        stageTimingsMs: {
          beforeRemoteReadback: beforeReadbackMs,
          push: pushMs,
          afterRemoteReadback: afterReadbackMs,
          localMirrorResidual: localMirrorMs,
          total: elapsedMs(effectStartedAt),
        },
        policy: {
          authority: "fixed_self_repository_effect_gate",
          arbitraryRepositoryPathAccepted: false,
          arbitraryRemoteAccepted: false,
          arbitraryBranchAccepted: false,
          processLocalPublicationLeaseUsed: true,
          remoteCompareAndSwapIsFinalConcurrencyGuard: true,
          compareAndSwapUsed: true,
          freshRemoteReadbackBeforeAndAfterEffect: true,
          effectOutcomeDerivedFromRemoteReadback: true,
          remotePublicationIsTerminalEffect: true,
          localAuthorityMirrorIsResidualOnly: true,
        },
      } satisfies Record<string, unknown>;
      this.completedEffects.set(
        input.planIdSha256,
        structuredClone(result),
      );
      return result;
    } finally {
      this.inFlightPlans.delete(input.planIdSha256);
      if (
        this.publicationLease?.workspaceId === input.workspaceId
        && this.publicationLease.planIdSha256 === input.planIdSha256
      ) {
        this.publicationLease = undefined;
      }
    }
  }

  private alreadyPublishedResult(input: {
    input: SelfRepositoryPublicationExecuteInput;
    preflight: SelfRepositoryPublicationCandidate;
    totalMs: number;
    remote?: RemoteAuthority;
    beforeReadbackMs?: number;
  }): Record<string, unknown> {
    return {
      schemaVersion: 1,
      capabilityRef: "devspace.self-repository-publication.effect.v1",
      outcome: "already_published_after_remote_reconciliation",
      publicationEffectTerminal: true,
      idempotentReplay: true,
      workspaceId: input.input.workspaceId,
      candidateHeadSha: input.preflight.candidateHeadSha,
      observedRemoteSha:
        input.remote?.sha ?? input.preflight.authoritativeRemoteMainSha,
      planIdSha256: input.input.planIdSha256,
      publicationProfile: input.preflight.publicationProfile,
      deploymentFollowUpRequired:
        input.preflight.publicationProfile?.runtimeDeploymentRequired ?? false,
      residuals: [],
      retryPolicy: "not_required",
      stageTimingsMs: {
        beforeRemoteReadback: input.beforeReadbackMs ?? 0,
        push: 0,
        afterRemoteReadback: 0,
        localMirrorResidual: 0,
        total: input.totalMs,
      },
      policy: {
        authority: "fixed_self_repository_effect_gate",
        pushRepeated: false,
        effectOutcomeDerivedFromRemoteReadback: true,
        remotePublicationIsTerminalEffect: true,
      },
    };
  }

  private baseCandidate(
    workspaceId: string,
    assessedAt: string,
  ): SelfRepositoryPublicationCandidate {
    const base = {
      schemaVersion: 1 as const,
      capabilityRef: "devspace.self-repository-publication.preflight.v1" as const,
      assessedAt,
      planIdSha256: "",
      workspaceId,
      status: "unavailable" as const,
      safeToPublish: false,
      publicationRequired: false,
      validationBoundToCandidate: false,
      remoteName: this.config.remoteName,
      remoteBranch: this.config.branchName,
      remoteUrlIdentityMatches: false,
      blockingFactors: [] as string[],
      policy: {
        repositoryAuthorityKind: "fixed_devspace_self_repository" as const,
        repositoryRootConfigured: true as const,
        remoteIdentityConfigured: true as const,
        arbitraryRepositoryPathAccepted: false as const,
        arbitraryRemoteAccepted: false as const,
        arbitraryBranchAccepted: false as const,
        remoteAuthoritySource: "fresh_git_ls_remote" as const,
        localTrackingRefIsRemoteAuthority: false as const,
        exactHeadBoundValidationRequired: true as const,
        explicitWriterReleaseRequired: false as const,
        explicitEffectTerminalityRequired: false as const,
        explicitPublicationSafetyAttestationRequired: false as const,
        exactDeclaredMaterialEffectReconciliationRequired: true as const,
        repositoryLocalPublicationLeaseRequired: true as const,
        remoteCompareAndSwapIsFinalConcurrencyGuard: true as const,
        unchangedHeadBoundValidationReceiptMayBeReused: true as const,
        zeroBehindRequired: true as const,
        mergeCommitsAllowed: false as const,
        publicationEffectPerformed: false as const,
        publicationAuthorityGranted: false as const,
        effectsEnabled: this.config.effectsEnabled,
        unrelatedZesRuntimeOrWriterStateCanBlockPublication: false as const,
      },
    };
    return base;
  }

  private async readRemoteAuthority(
    cwd: string,
    timeoutMs = GIT_TIMEOUT_MS,
  ): Promise<RemoteAuthority> {
    const remoteUrl = (await git(cwd, [
      "remote",
      "get-url",
      this.config.remoteName,
    ], timeoutMs)).trim();
    const remoteUrlDigestSha256 = sha256(remoteUrl);
    const repositoryIdentityDigestSha256 = sha256([
      resolve(this.config.repositoryRoot!),
      this.config.remoteName,
      remoteUrl,
      this.config.branchName,
    ].join("\0"));
    if (remoteUrl !== this.config.expectedRemoteUrl) {
      throw new ConfiguredRemoteIdentityMismatchError(
        remoteUrlDigestSha256,
        repositoryIdentityDigestSha256,
      );
    }
    const remoteRef = `refs/heads/${this.config.branchName}`;
    const listed = await git(cwd, [
      "ls-remote",
      "--exit-code",
      this.config.expectedRemoteUrl!,
      remoteRef,
    ], timeoutMs);
    const line = listed.split(/\r?\n/).find((entry) => entry.endsWith(`\t${remoteRef}`));
    const sha = line?.split(/\s+/)[0]?.toLowerCase();
    if (!sha || !SHA_PATTERN.test(sha)) {
      throw new Error("configured_remote_branch_did_not_return_one_commit");
    }
    return {
      sha,
      remoteUrl,
      remoteUrlDigestSha256,
      repositoryIdentityDigestSha256,
    };
  }

  private async readAndPrepareRemoteAuthority(cwd: string): Promise<RemoteAuthority> {
    const remote = await this.readRemoteAuthority(cwd);
    await ensureCommitAvailableLocally({
      cwd,
      remoteLocator: this.config.expectedRemoteUrl!,
      branchName: this.config.branchName,
      sha: remote.sha,
    });
    return remote;
  }
}

async function mirrorRemoteAuthorityLocally(input: {
  cwd: string;
  remoteName: string;
  branchName: string;
  remoteSha: string;
}): Promise<{
  ref: string;
  expectedOldSha?: string;
  observedSha?: string;
  synced: boolean;
  diagnosticDigestSha256?: string;
}> {
  const ref = `refs/remotes/${input.remoteName}/${input.branchName}`;
  const before = await gitResult(input.cwd, ["rev-parse", "--verify", `${ref}^{commit}`]);
  const expectedOldSha = SHA_PATTERN.test(before.stdout.trim())
    ? before.stdout.trim()
    : undefined;
  const update = await gitResult(input.cwd, [
    "update-ref",
    ref,
    input.remoteSha,
    expectedOldSha ?? "0".repeat(input.remoteSha.length),
  ]);
  const observed = await gitResult(input.cwd, ["rev-parse", "--verify", `${ref}^{commit}`]);
  const observedSha = SHA_PATTERN.test(observed.stdout.trim())
    ? observed.stdout.trim()
    : undefined;
  return {
    ref,
    expectedOldSha,
    observedSha,
    synced: observedSha === input.remoteSha,
    ...(
      update.exitCode === 0 && observedSha === input.remoteSha
        ? {}
        : {
            diagnosticDigestSha256: sha256([
              update.stdout,
              update.stderr,
              observed.stdout,
              observed.stderr,
            ].join("\n")),
          }
    ),
  };
}

function finalizeCandidate(
  base: SelfRepositoryPublicationCandidate,
  input: {
    status: SelfRepositoryPublicationCandidate["status"];
    blockingFactors: string[];
    diagnostic?: unknown;
  },
): SelfRepositoryPublicationCandidate {
  const data = {
    ...base,
    status: input.status,
    safeToPublish: false,
    publicationRequired: false,
    blockingFactors: [...new Set(input.blockingFactors)].sort(),
    ...(input.diagnostic === undefined
      ? {}
      : {
          diagnosticDigestSha256: sha256(
            input.diagnostic instanceof Error
              ? input.diagnostic.message
              : String(input.diagnostic),
          ),
        }),
  };
  return {
    ...data,
    planIdSha256: planDigest(data),
  };
}

function planDigest(value: Record<string, unknown>): string {
  const {
    assessedAt: _assessedAt,
    candidateLifecycleDigestSha256: _candidateLifecycleDigestSha256,
    planIdSha256: _planIdSha256,
    stageTimingsMs: _stageTimingsMs,
    ...stable
  } = value;
  return sha256(stableJson(stable));
}

function linkedWorkspaceIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids = value
    .map((item) => (
      typeof item === "object"
      && item !== null
      && !Array.isArray(item)
      && typeof (item as Record<string, unknown>).workspaceId === "string"
        ? String((item as Record<string, unknown>).workspaceId)
        : undefined
    ))
    .filter((item): item is string => Boolean(item));
  return [...new Set(ids)].slice(0, 100);
}

async function ensureCommitAvailableLocally(input: {
  cwd: string;
  remoteLocator: string;
  branchName: string;
  sha: string;
}): Promise<void> {
  if (await commitAvailableLocally(input.cwd, input.sha)) {
    return;
  }
  const fetched = await gitResult(input.cwd, [
    "fetch",
    "--no-tags",
    "--no-write-fetch-head",
    input.remoteLocator,
    `refs/heads/${input.branchName}`,
  ]);
  if (fetched.exitCode !== 0) {
    throw new Error("remote_authority_fetch_failed");
  }
  if (!await commitAvailableLocally(input.cwd, input.sha)) {
    throw new Error("remote_authority_commit_missing_after_fetch");
  }
}

async function commitAvailableLocally(cwd: string, sha: string): Promise<boolean> {
  return (await gitResult(cwd, ["cat-file", "-e", `${sha}^{commit}`])).exitCode === 0;
}

async function leftRightCounts(
  cwd: string,
  authoritySha: string,
  candidateSha: string,
): Promise<{ behindCount?: number; aheadCount?: number }> {
  const output = await git(cwd, [
    "rev-list",
    "--left-right",
    "--count",
    `${authoritySha}...${candidateSha}`,
  ]);
  const [behind, ahead] = output.trim().split(/\s+/).map((value) => Number.parseInt(value, 10));
  return {
    behindCount: Number.isInteger(behind) ? behind : undefined,
    aheadCount: Number.isInteger(ahead) ? ahead : undefined,
  };
}

async function changedPathsBetween(
  cwd: string,
  authoritySha: string,
  candidateSha: string,
): Promise<string[]> {
  const output = await git(cwd, [
    "diff",
    "--name-only",
    "-z",
    authoritySha,
    candidateSha,
  ]);
  return output
    .split("\0")
    .map((value) => value.trim())
    .filter(Boolean)
    .slice(0, 10_000);
}

async function integerGitOutput(cwd: string, args: string[]): Promise<number | undefined> {
  const parsed = Number.parseInt((await git(cwd, args)).trim(), 10);
  return Number.isInteger(parsed) ? parsed : undefined;
}

async function isAncestor(cwd: string, ancestor: string, descendant: string): Promise<boolean> {
  return (await gitResult(cwd, ["merge-base", "--is-ancestor", ancestor, descendant])).exitCode === 0;
}

async function sameRealPath(left: string, right: string): Promise<boolean> {
  try {
    return await realpath(left) === await realpath(right);
  } catch {
    return false;
  }
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function git(
  cwd: string,
  args: string[],
  timeoutMs = GIT_TIMEOUT_MS,
): Promise<string> {
  const result = await gitResult(cwd, args, timeoutMs);
  if (result.exitCode !== 0) {
    throw new Error(`git_${args[0] ?? "command"}_failed:${sha256(result.stderr || result.stdout)}`);
  }
  return result.stdout;
}

async function gitResult(
  cwd: string,
  args: string[],
  timeoutMs = GIT_TIMEOUT_MS,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd,
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
      timeout: timeoutMs,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (error) {
    const stdout = typeof error === "object" && error && "stdout" in error
      ? String((error as { stdout?: unknown }).stdout ?? "")
      : "";
    const stderr = typeof error === "object" && error && "stderr" in error
      ? String((error as { stderr?: unknown }).stderr ?? "")
      : error instanceof Error ? error.message : String(error);
    const exitCode = typeof error === "object" && error && "code" in error
      && typeof (error as { code?: unknown }).code === "number"
      ? (error as { code: number }).code
      : 1;
    return { stdout, stderr: stderr.trim(), exitCode };
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function elapsedMs(startedAt: number): number {
  return Math.max(0, Math.round((performance.now() - startedAt) * 10) / 10);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
