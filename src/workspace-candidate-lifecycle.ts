import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { promisify } from "node:util";
import type {
  WorkspaceActivityObservation,
  WorkspaceSession,
} from "./workspace-store.js";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 30_000;
const MAX_GIT_OUTPUT_BYTES = 10 * 1024 * 1024;

export type WorkspaceCandidateDisposition =
  | "dirty_recoverable"
  | "unanchored_candidate"
  | "awaiting_validation"
  | "ready_to_publish"
  | "needs_reconcile"
  | "integrated"
  | "baseline_only"
  | "unknown";

export type WorkspaceOperationalState = "active" | "quiescent" | "unobserved";

export interface WorkspaceCandidateGitObservation {
  readable: boolean;
  candidateSource: "worktree_head" | "preservation_ref" | "unavailable";
  dirty?: boolean;
  dirtyPathCount?: number;
  head?: string;
  branch?: string;
  preservationRef?: string;
  containingRefs: string[];
  primaryWorktree?: string;
  sourceRoot?: string;
  authorityRef?: string;
  authoritySha?: string;
  authorityRefSource?:
    | "workspace_base_ref"
    | "primary_worktree_branch"
    | "remote_default_branch"
    | "conventional_main_ref";
  authorityFreshness: "local_only" | "unresolved";
  aheadCount?: number;
  behindCount?: number;
  mergeCommitCount?: number;
  headInAuthorityHistory?: boolean;
  authorityInHeadHistory?: boolean;
  unintegratedPatchCount?: number;
  patchEquivalentCommitCount?: number;
  error?: string;
}

export interface WorkspaceCandidateValidationObservation {
  state: "current_passed" | "stale" | "missing";
  declaredState?: string;
  fingerprintHead?: string;
  fingerprintDirty?: boolean;
  boundToCurrentHead: boolean;
  evidenceRefs: string[];
}

export interface WorkspaceCandidateSemanticHint {
  source: "latest_explicit_recovery_capsule_for_workspace";
  recordedAt: string;
  missionRef?: string;
  currentFrontier?: string;
  exactNextAction?: string;
  unresolved: string[];
  checkpointRefs: string[];
  validationState?: string;
  worktreeState?: string;
  writerState?: string;
  effectState?: string;
  retryPolicy?: string;
  safeToPublish?: boolean;
}

export interface WorkspaceCandidateLifecycleAssessment {
  schemaVersion: 1;
  capabilityRef: "devspace.workspace-candidate-lifecycle.v1";
  assessedAt: string;
  lifecycleDigestSha256: string;
  workspaceId?: string;
  path: string;
  registered: boolean;
  workspaceStatus?: string;
  rootExists: boolean;
  branchOnly: boolean;
  sourceRoot?: string;
  baseRef?: string;
  baseSha?: string;
  preservationRef?: string;
  displayLabel?: string;
  displayLabelSource?: "recovery_capsule_mission_ref" | "recovery_capsule_frontier";
  semanticHint?: WorkspaceCandidateSemanticHint;
  disposition: WorkspaceCandidateDisposition;
  operationalState: WorkspaceOperationalState;
  publicationDebt: boolean;
  technicallyReadyToPublish: boolean;
  publicationPreflightRequired: true;
  safeToDelete: boolean;
  finalizers: string[];
  recommendedAction: string;
  git: WorkspaceCandidateGitObservation;
  validation: WorkspaceCandidateValidationObservation;
  activity: {
    activeWithinHours: number;
    scopeLastActivityAt?: string;
    latestScopeRef?: string;
    scopeRefs: string[];
    bindingLastUsedAt?: string;
    recoveryRecordedAt?: string;
    loadedInCurrentRuntime: boolean;
    runningProcessCount: number;
    externalProcessReferences: string[];
  };
  policy: {
    authority: "executor_local_git_and_recovery_observation_only";
    localAuthorityRefIsCanonicalRemoteAuthority: false;
    recoveryCapsuleIsPublicationAuthority: false;
    publicationEffectPerformed: false;
    canonicalTaskOrDecisionAuthority: false;
    deletionRequiresTerminalGitStateAndClearedFinalizers: true;
  };
}

export interface WorkspaceCandidateAssessmentInput {
  path: string;
  rootExists: boolean;
  registered: boolean;
  session?: WorkspaceSession;
  activity?: WorkspaceActivityObservation;
  loadedInCurrentRuntime: boolean;
  runningProcessCount: number;
  externalProcessReferences: string[];
  activeWithinHours: number;
  nowMs?: number;
}

interface AuthorityCandidate {
  ref: string;
  source: NonNullable<WorkspaceCandidateGitObservation["authorityRefSource"]>;
}

interface GitTarget {
  cwd: string;
  candidateRef: string;
  candidateSource: WorkspaceCandidateGitObservation["candidateSource"];
  branch?: string;
  preservationRef?: string;
}

const POLICY = {
  authority: "executor_local_git_and_recovery_observation_only",
  localAuthorityRefIsCanonicalRemoteAuthority: false,
  recoveryCapsuleIsPublicationAuthority: false,
  publicationEffectPerformed: false,
  canonicalTaskOrDecisionAuthority: false,
  deletionRequiresTerminalGitStateAndClearedFinalizers: true,
} as const;

export async function assessWorkspaceCandidateLifecycle(
  input: WorkspaceCandidateAssessmentInput,
): Promise<WorkspaceCandidateLifecycleAssessment> {
  const nowMs = input.nowMs ?? Date.now();
  const git = await observeCandidateGit(input);
  const validation = validationObservation(input.activity, git);
  const semanticHint = candidateSemanticHint(input.activity);
  const display = candidateDisplayLabel(semanticHint);
  const recentScopeActivity = isRecent(
    input.activity?.scopeLastActivityAtMs,
    nowMs,
    input.activeWithinHours,
  );
  const activeRecoveryAuthority = capsuleDeclaresActiveAuthority(
    input.activity?.recovery?.semantic,
  );
  const operationalState: WorkspaceOperationalState =
    input.runningProcessCount > 0
      || input.externalProcessReferences.length > 0
      || recentScopeActivity
      || activeRecoveryAuthority
      ? "active"
      : input.session || git.readable
        ? "quiescent"
        : "unobserved";
  const disposition = candidateDisposition(git, validation);
  const publicationDebt = !["integrated", "baseline_only"].includes(disposition);
  const finalizers = candidateFinalizers({
    input,
    git,
    validation,
    disposition,
    recentScopeActivity,
    activeRecoveryAuthority,
    publicationDebt,
  });
  const safeToDelete =
    (disposition === "integrated" || disposition === "baseline_only")
    && finalizers.length === 0;
  const technicallyReadyToPublish = disposition === "ready_to_publish";
  const branchOnly = !input.rootExists
    && git.candidateSource === "preservation_ref"
    && git.readable;
  const activity = {
    activeWithinHours: input.activeWithinHours,
    scopeLastActivityAt: iso(input.activity?.scopeLastActivityAtMs),
    bindingLastUsedAt: input.activity?.bindingLastUsedAt,
    latestScopeRef: input.activity?.latestScopeRef,
    scopeRefs: [...(input.activity?.scopeRefs ?? [])].sort(),
    recoveryRecordedAt: iso(input.activity?.recovery?.recordedAtMs),
    loadedInCurrentRuntime: input.loadedInCurrentRuntime,
    runningProcessCount: input.runningProcessCount,
    externalProcessReferences: [...input.externalProcessReferences].sort(),
  };
  const digestBody = {
    workspaceId: input.session?.id,
    path: resolve(input.path),
    registered: input.registered,
    workspaceStatus: input.session?.status,
    rootExists: input.rootExists,
    branchOnly,
    sourceRoot: input.session?.sourceRoot,
    baseRef: input.session?.baseRef,
    baseSha: input.session?.baseSha,
    preservationRef: input.session?.preservationRef,
    displayLabel: display.label,
    displayLabelSource: display.source,
    semanticHint,
    disposition,
    operationalState,
    publicationDebt,
    technicallyReadyToPublish,
    safeToDelete,
    finalizers,
    git,
    validation,
    activity,
  };

  return {
    schemaVersion: 1,
    capabilityRef: "devspace.workspace-candidate-lifecycle.v1",
    assessedAt: new Date(nowMs).toISOString(),
    lifecycleDigestSha256: sha256(stableJson(digestBody)),
    workspaceId: input.session?.id,
    path: resolve(input.path),
    registered: input.registered,
    workspaceStatus: input.session?.status,
    rootExists: input.rootExists,
    branchOnly,
    sourceRoot: input.session?.sourceRoot,
    baseRef: input.session?.baseRef,
    baseSha: input.session?.baseSha,
    preservationRef: input.session?.preservationRef,
    displayLabel: display.label,
    displayLabelSource: display.source,
    semanticHint,
    disposition,
    operationalState,
    publicationDebt,
    technicallyReadyToPublish,
    publicationPreflightRequired: true,
    safeToDelete,
    finalizers,
    recommendedAction: recommendedAction(disposition, operationalState),
    git,
    validation,
    activity,
    policy: POLICY,
  };
}

function candidateSemanticHint(
  activity: WorkspaceActivityObservation | undefined,
): WorkspaceCandidateSemanticHint | undefined {
  const recovery = activity?.recovery;
  const semantic = recovery?.semantic;
  if (!recovery || !semantic) return undefined;
  return {
    source: "latest_explicit_recovery_capsule_for_workspace",
    recordedAt: new Date(recovery.recordedAtMs).toISOString(),
    missionRef: boundedString(semantic.missionRef, 500),
    currentFrontier: boundedString(semantic.currentFrontier, 1_200),
    exactNextAction: boundedString(semantic.exactNextAction, 1_200),
    unresolved: boundedStringArray(semantic.unresolved, 12, 500),
    checkpointRefs: boundedStringArray(semantic.checkpointRefs, 20, 500),
    validationState: boundedString(semantic.validationState, 100),
    worktreeState: boundedString(semantic.worktreeState, 100),
    writerState: boundedString(semantic.writerState, 100),
    effectState: boundedString(semantic.effectState, 100),
    retryPolicy: boundedString(semantic.retryPolicy, 100),
    safeToPublish:
      typeof semantic.safeToPublish === "boolean"
        ? semantic.safeToPublish
        : undefined,
  };
}

function candidateDisplayLabel(
  hint: WorkspaceCandidateSemanticHint | undefined,
): {
  label?: string;
  source?: WorkspaceCandidateLifecycleAssessment["displayLabelSource"];
} {
  if (hint?.missionRef) {
    return {
      label: truncate(hint.missionRef, 180),
      source: "recovery_capsule_mission_ref",
    };
  }
  if (hint?.currentFrontier) {
    return {
      label: truncate(hint.currentFrontier, 180),
      source: "recovery_capsule_frontier",
    };
  }
  return {};
}

async function observeCandidateGit(
  input: WorkspaceCandidateAssessmentInput,
): Promise<WorkspaceCandidateGitObservation> {
  const target = await gitTarget(input);
  if (!target) {
    return {
      readable: false,
      candidateSource: "unavailable",
      containingRefs: [],
      authorityFreshness: "unresolved",
      error: "workspace_and_preservation_ref_unavailable",
    };
  }

  try {
    const head = (await git(target.cwd, [
      "rev-parse",
      "--verify",
      `${target.candidateRef}^{commit}`,
    ])).trim();
    const status = target.candidateSource === "worktree_head"
      ? await git(target.cwd, ["status", "--porcelain=v1", "--untracked-files=all"])
      : "";
    const branch = target.branch
      ?? (target.candidateSource === "worktree_head"
        ? (await git(target.cwd, ["branch", "--show-current"])).trim() || undefined
        : undefined);
    const containingRefs = (await git(target.cwd, [
      "for-each-ref",
      "--format=%(refname)",
      "--contains",
      head,
      "refs/heads",
      "refs/tags",
      "refs/remotes",
    ])).split(/\r?\n/).filter(Boolean).sort();
    const worktreeList = await git(target.cwd, ["worktree", "list", "--porcelain"]);
    const primaryWorktree = worktreeList.split(/\r?\n/)
      .find((line) => line.startsWith("worktree "))
      ?.slice("worktree ".length);
    const sourceRoot = input.session?.sourceRoot ?? primaryWorktree;
    const authority = await resolveAuthority({
      cwd: sourceRoot ?? target.cwd,
      session: input.session,
      candidateBranch: branch,
      preservationRef: target.preservationRef,
    });
    const observation: WorkspaceCandidateGitObservation = {
      readable: true,
      candidateSource: target.candidateSource,
      dirty: status.trim().length > 0,
      dirtyPathCount: status.trim().length === 0
        ? 0
        : status.trimEnd().split(/\r?\n/).length,
      head,
      branch,
      preservationRef: target.preservationRef,
      containingRefs,
      primaryWorktree,
      sourceRoot,
      authorityRef: authority?.ref,
      authoritySha: authority?.sha,
      authorityRefSource: authority?.source,
      authorityFreshness: authority ? "local_only" : "unresolved",
    };

    if (!authority) return observation;

    const counts = (await git(target.cwd, [
      "rev-list",
      "--left-right",
      "--count",
      `${authority.sha}...${head}`,
    ])).trim().split(/\s+/).map((value) => Number.parseInt(value, 10));
    const behindCount = Number.isInteger(counts[0]) ? counts[0] : undefined;
    const aheadCount = Number.isInteger(counts[1]) ? counts[1] : undefined;
    const headInAuthorityHistory = await isAncestor(target.cwd, head, authority.sha);
    const authorityInHeadHistory = await isAncestor(target.cwd, authority.sha, head);
    const mergeCommitCount = numberOutput(await git(target.cwd, [
      "rev-list",
      "--count",
      "--merges",
      `${authority.sha}..${head}`,
    ]));
    const cherry = await gitResult(target.cwd, ["cherry", authority.sha, head]);
    const cherryLines = cherry.exitCode === 0
      ? cherry.stdout.split(/\r?\n/).filter(Boolean)
      : [];
    return {
      ...observation,
      aheadCount,
      behindCount,
      mergeCommitCount,
      headInAuthorityHistory,
      authorityInHeadHistory,
      unintegratedPatchCount: cherry.exitCode === 0
        ? cherryLines.filter((line) => line.startsWith("+")).length
        : undefined,
      patchEquivalentCommitCount: cherry.exitCode === 0
        ? cherryLines.filter((line) => line.startsWith("-")).length
        : undefined,
    };
  } catch (error) {
    return {
      readable: false,
      candidateSource: target.candidateSource,
      preservationRef: target.preservationRef,
      containingRefs: [],
      authorityFreshness: "unresolved",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function gitTarget(
  input: WorkspaceCandidateAssessmentInput,
): Promise<GitTarget | undefined> {
  if (input.rootExists) {
    return {
      cwd: input.path,
      candidateRef: "HEAD",
      candidateSource: "worktree_head",
      preservationRef: input.session?.preservationRef,
    };
  }
  const preservationRef = input.session?.preservationRef;
  const sourceRoot = input.session?.sourceRoot;
  if (!preservationRef || !sourceRoot) return undefined;
  const exists = await gitResult(sourceRoot, [
    "show-ref",
    "--verify",
    "--quiet",
    `refs/heads/${preservationRef}`,
  ]);
  if (exists.exitCode !== 0) return undefined;
  return {
    cwd: sourceRoot,
    candidateRef: `refs/heads/${preservationRef}`,
    candidateSource: "preservation_ref",
    branch: preservationRef,
    preservationRef,
  };
}

async function resolveAuthority(input: {
  cwd: string;
  session?: WorkspaceSession;
  candidateBranch?: string;
  preservationRef?: string;
}): Promise<(AuthorityCandidate & { sha: string }) | undefined> {
  const candidates: AuthorityCandidate[] = [];
  let deferredConventionalBaseRef: AuthorityCandidate | undefined;
  let deferredPrimaryBranch: AuthorityCandidate | undefined;
  const baseRef = input.session?.baseRef?.trim();
  if (
    baseRef
    && baseRef !== "HEAD"
    && !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(baseRef)
  ) {
    const candidate = { ref: baseRef, source: "workspace_base_ref" } as const;
    if (isConventionalMainBranch(baseRef)) {
      deferredConventionalBaseRef = candidate;
    } else {
      candidates.push(candidate);
    }
  }

  const primaryBranch = (await gitResult(input.cwd, ["branch", "--show-current"])).stdout.trim();
  if (isConventionalMainBranch(primaryBranch)) {
    deferredPrimaryBranch = {
      ref: primaryBranch,
      source: "primary_worktree_branch",
    };
  }

  for (const remote of ["origin", "owner", "upstream"]) {
    const symbolic = await gitResult(input.cwd, [
      "symbolic-ref",
      "--quiet",
      "--short",
      `refs/remotes/${remote}/HEAD`,
    ]);
    const ref = symbolic.stdout.trim();
    if (symbolic.exitCode === 0 && ref) {
      candidates.push({ ref, source: "remote_default_branch" });
    }
  }

  for (const ref of [
    "owner/main",
    "origin/main",
    "upstream/main",
    "owner/master",
    "origin/master",
  ]) {
    candidates.push({ ref, source: "conventional_main_ref" });
  }
  if (deferredPrimaryBranch) candidates.push(deferredPrimaryBranch);
  if (deferredConventionalBaseRef) candidates.push(deferredConventionalBaseRef);
  for (const ref of ["main", "master", "trunk"]) {
    candidates.push({ ref, source: "conventional_main_ref" });
  }

  const excluded = new Set([
    input.candidateBranch,
    input.preservationRef,
  ].filter((value): value is string => Boolean(value)));
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (excluded.has(candidate.ref) || seen.has(candidate.ref)) continue;
    seen.add(candidate.ref);
    const result = await gitResult(input.cwd, [
      "rev-parse",
      "--verify",
      `${candidate.ref}^{commit}`,
    ]);
    const sha = result.stdout.trim();
    if (result.exitCode === 0 && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(sha)) {
      return { ...candidate, sha };
    }
  }
  return undefined;
}

function validationObservation(
  activity: WorkspaceActivityObservation | undefined,
  gitObservation: WorkspaceCandidateGitObservation,
): WorkspaceCandidateValidationObservation {
  const semantic = activity?.recovery?.semantic;
  const fingerprint = activity?.recovery?.fingerprint;
  const declaredState = typeof semantic?.validationState === "string"
    ? semantic.validationState
    : undefined;
  const fingerprintHead = typeof fingerprint?.head === "string"
    ? fingerprint.head
    : undefined;
  const fingerprintDirty = typeof fingerprint?.dirty === "boolean"
    ? fingerprint.dirty
    : undefined;
  const evidenceRefs = Array.isArray(semantic?.validationRefs)
    ? semantic.validationRefs.filter((value): value is string => typeof value === "string").slice(0, 50)
    : [];
  const boundToCurrentHead = Boolean(
    declaredState === "passed"
    && evidenceRefs.length > 0
    && gitObservation.readable
    && gitObservation.head
    && fingerprintHead === gitObservation.head
    && fingerprintDirty === gitObservation.dirty,
  );
  return {
    state: boundToCurrentHead
      ? "current_passed"
      : declaredState === undefined
        ? "missing"
        : "stale",
    declaredState,
    fingerprintHead,
    fingerprintDirty,
    boundToCurrentHead,
    evidenceRefs,
  };
}

function candidateDisposition(
  gitObservation: WorkspaceCandidateGitObservation,
  validation: WorkspaceCandidateValidationObservation,
): WorkspaceCandidateDisposition {
  if (!gitObservation.readable || !gitObservation.head) return "unknown";
  if (gitObservation.dirty) return "dirty_recoverable";
  if (gitObservation.containingRefs.length === 0) return "unanchored_candidate";
  if (!gitObservation.authoritySha) return "unknown";
  if (gitObservation.head === gitObservation.authoritySha) return "baseline_only";
  if (gitObservation.headInAuthorityHistory) return "integrated";
  const patchEquivalentIntegrated =
    (gitObservation.aheadCount ?? 0) > 0
    && gitObservation.unintegratedPatchCount === 0
    && (gitObservation.patchEquivalentCommitCount ?? 0) > 0
    && gitObservation.mergeCommitCount === 0;
  if (patchEquivalentIntegrated) return "integrated";
  if ((gitObservation.behindCount ?? 0) > 0 && (gitObservation.aheadCount ?? 0) > 0) {
    return "needs_reconcile";
  }
  if ((gitObservation.aheadCount ?? 0) > 0) {
    return validation.boundToCurrentHead ? "ready_to_publish" : "awaiting_validation";
  }
  return "unknown";
}

function candidateFinalizers(input: {
  input: WorkspaceCandidateAssessmentInput;
  git: WorkspaceCandidateGitObservation;
  validation: WorkspaceCandidateValidationObservation;
  disposition: WorkspaceCandidateDisposition;
  recentScopeActivity: boolean;
  activeRecoveryAuthority: boolean;
  publicationDebt: boolean;
}): string[] {
  const finalizers: string[] = [];
  if (input.input.loadedInCurrentRuntime) finalizers.push("loaded_in_current_runtime");
  if (input.input.runningProcessCount > 0) {
    finalizers.push("running_devspace_process_session");
  }
  if (input.input.externalProcessReferences.length > 0) {
    finalizers.push("live_operating_system_process_reference");
  }
  if (input.recentScopeActivity) finalizers.push("recent_scope_activity");
  if (input.activeRecoveryAuthority) {
    finalizers.push("recovery_capsule_declares_active_authority");
  }
  if (!input.git.readable) finalizers.push("git_state_unreadable");
  if (input.git.dirty) finalizers.push("dirty_worktree");
  if (input.git.readable && input.git.containingRefs.length === 0) {
    finalizers.push("head_not_reachable_from_persistent_ref");
  }
  if (input.git.readable && !input.git.authoritySha) {
    finalizers.push("authority_ref_unresolved");
  }
  if (input.disposition === "needs_reconcile") {
    finalizers.push("candidate_needs_reconciliation");
  }
  if (
    input.disposition === "awaiting_validation"
    || (input.disposition === "ready_to_publish" && !input.validation.boundToCurrentHead)
  ) {
    finalizers.push("candidate_validation_missing_or_stale");
  }
  if (input.publicationDebt) finalizers.push("publication_debt");
  return [...new Set(finalizers)].sort();
}

function recommendedAction(
  disposition: WorkspaceCandidateDisposition,
  operationalState: WorkspaceOperationalState,
): string {
  if (operationalState === "active") {
    return "Leave the candidate attached to its current execution scope; inspect again after activity and writer/effect state become quiescent.";
  }
  switch (disposition) {
    case "dirty_recoverable":
      return "Resume or hand off the owning session, inspect the diff, validate it, and commit a coherent candidate before publication or cleanup.";
    case "unanchored_candidate":
      return "Create a persistent preservation branch immediately before any close or GC action, then validate and reconcile the candidate.";
    case "awaiting_validation":
      return "Run candidate-bound validation and record a fresh Git-bound recovery capsule; publication remains blocked until the evidence matches this HEAD.";
    case "ready_to_publish":
      return "Run the repository-specific publication preflight, revalidate authority and candidate state, then publish with compare-and-swap and remote readback.";
    case "needs_reconcile":
      return "Reconcile the candidate with the current local authority ref, resolve conflicts or obsolete changes, rerun validation, and reassess before publication.";
    case "integrated":
      return "The candidate is already integrated by ancestry or patch equivalence; after activity/recovery finalizers clear, close the workspace and remove only executor-owned preservation refs.";
    case "baseline_only":
      return "No candidate changes exist relative to the local authority ref; after operational finalizers clear, the managed worktree may be closed or garbage-collected.";
    default:
      return "Inspect repository identity, authority-ref resolution, Git reachability, and recovery evidence before publication or deletion.";
  }
}

function capsuleDeclaresActiveAuthority(
  semantic: Record<string, unknown> | undefined,
): boolean {
  return semantic?.writerState === "held" || semantic?.effectState === "in_flight";
}

function isRecent(
  value: number | undefined,
  nowMs: number,
  activeWithinHours: number,
): boolean {
  return value !== undefined
    && Number.isFinite(value)
    && nowMs - value < activeWithinHours * 60 * 60 * 1_000;
}

function isConventionalMainBranch(value: string): boolean {
  return value === "main" || value === "master" || value === "trunk";
}

async function isAncestor(cwd: string, ancestor: string, descendant: string): Promise<boolean> {
  return (await gitResult(cwd, ["merge-base", "--is-ancestor", ancestor, descendant])).exitCode === 0;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await gitResult(cwd, args);
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${result.stderr || "unknown Git error"}`);
  }
  return result.stdout;
}

async function gitResult(
  cwd: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd,
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
      timeout: GIT_TIMEOUT_MS,
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

function numberOutput(value: string): number | undefined {
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isInteger(parsed) ? parsed : undefined;
}

function iso(value: number | undefined): string | undefined {
  return value === undefined ? undefined : new Date(value).toISOString();
}

function boundedString(value: unknown, maxCharacters: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : truncate(trimmed, maxCharacters);
}

function boundedStringArray(
  value: unknown,
  maxItems: number,
  maxCharacters: number,
): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .slice(0, maxItems)
    .map((entry) => truncate(entry, maxCharacters));
}

function truncate(value: string, maxCharacters: number): string {
  return value.length <= maxCharacters
    ? value
    : `${value.slice(0, Math.max(0, maxCharacters - 1))}…`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
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
