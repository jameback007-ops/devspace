import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { opendir, readlink, rmdir, stat } from "node:fs/promises";
import { platform } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import type { ServerConfig } from "./config.js";
import {
  deleteManagedWorkspacePreservationRef,
  ensureManagedWorkspacePreservationRef,
} from "./git-worktrees.js";
import type {
  ProcessSessionInspection,
  ProcessSessionManager,
} from "./process-sessions.js";
import { isPathInsideRoot } from "./roots.js";
import {
  assessWorkspaceCandidateLifecycle,
  type WorkspaceCandidateGitObservation,
  type WorkspaceCandidateLifecycleAssessment,
} from "./workspace-candidate-lifecycle.js";
import type {
  WorkspaceActivityObservation,
  WorkspaceSession,
  WorkspaceStore,
} from "./workspace-store.js";
import type { WorkspaceRegistry } from "./workspaces.js";

const execFileAsync = promisify(execFile);
const DEFAULT_GC_OLDER_THAN_HOURS = 24;
const DEFAULT_CAPSULE_PROTECTION_HOURS = 72;
const DEFAULT_CANDIDATE_ACTIVE_WITHIN_HOURS = 0.25;
const CANDIDATE_INVENTORY_CONCURRENCY = 4;
const MAX_GC_AGE_HOURS = 365 * 24;
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

export interface WorkspaceListInput {
  status?: "active" | "closed";
  mode?: "checkout" | "worktree";
  managed?: boolean;
  limit?: number;
}

export interface WorkspaceCloseInput {
  workspaceId: string;
  remove?: boolean;
  force?: boolean;
}

export interface WorkspaceGcInput {
  olderThanHours?: number;
  capsuleProtectionHours?: number;
  includeSizes?: boolean;
}

export interface WorkspaceGcExecuteInput extends WorkspaceGcInput {
  planIdSha256: string;
}

export interface WorkspaceCandidateInventoryInput {
  activeWithinHours?: number;
  includeSizes?: boolean;
  includeClosed?: boolean;
  limit?: number;
}

export interface WorkspaceGcItem {
  workspaceId?: string;
  path: string;
  registered: boolean;
  status?: string;
  sourceRoot?: string;
  createdAt?: string;
  lastUsedAt?: string;
  scopeLastActivityAt?: string;
  bindingLastUsedAt?: string;
  recoveryRecordedAt?: string;
  filesystemMtime: string;
  effectiveAgeHours: number;
  sizeBytes?: number;
  git: WorkspaceCandidateGitObservation;
  candidateLifecycle: WorkspaceCandidateLifecycleAssessment;
  runningProcessCount: number;
  externalProcessReferences: string[];
  loadedInCurrentRuntime: boolean;
  protectedReasons: string[];
  eligible: boolean;
  removalMode?: "git_worktree" | "empty_orphan_directory";
}

export interface WorkspaceCandidateInventoryItem extends WorkspaceCandidateLifecycleAssessment {
  sizeBytes?: number;
}

export interface WorkspaceCandidateInventory {
  schemaVersion: 1;
  capabilityRef: "devspace.workspace-candidate-inventory.v1";
  generatedAt: string;
  options: Required<WorkspaceCandidateInventoryInput>;
  truncated: boolean;
  summary: {
    candidateCount: number;
    returnedCount: number;
    publicationDebtCount: number;
    technicallyReadyToPublishCount: number;
    safeToDeleteCount: number;
    activeCount: number;
    branchOnlyCount: number;
    byDisposition: Record<string, number>;
    totalBytes?: number;
  };
  candidates: WorkspaceCandidateInventoryItem[];
  policy: ReturnType<typeof lifecyclePolicy>;
}

export interface WorkspaceGcPlan {
  schemaVersion: 1;
  generatedAt: string;
  planIdSha256: string;
  options: Required<WorkspaceGcInput>;
  summary: {
    directoryCount: number;
    eligibleCount: number;
    protectedCount: number;
    publicationDebtCount: number;
    eligibleBytes?: number;
    protectedBytes?: number;
  };
  items: WorkspaceGcItem[];
}

export class WorkspaceLifecycleManager {
  constructor(
    private readonly config: ServerConfig,
    private readonly store: WorkspaceStore,
    private readonly registry: WorkspaceRegistry,
    private readonly processSessions: ProcessSessionManager,
    private readonly now: () => number = Date.now,
  ) {}

  list(input: WorkspaceListInput = {}): Record<string, unknown> {
    const limit = boundedInteger(input.limit, 100, 1, 500, "limit");
    const loaded = new Set(this.registry.loadedWorkspaceIds());
    const filtered = this.store.listSessions()
      .filter((session) => input.status === undefined || session.status === input.status)
      .filter((session) => input.mode === undefined || session.mode === input.mode)
      .filter((session) => input.managed === undefined || session.managed === input.managed);
    const sessions = filtered
      .slice(0, limit)
      .map((session) => ({
        ...session,
        exists: pathExists(session.root),
        loadedInCurrentRuntime: loaded.has(session.id),
        runningProcessCount:
          this.runningProcesses(session.id).filter((process) => process.running).length,
      }));
    return {
      schemaVersion: 1,
      count: sessions.length,
      truncated: filtered.length > limit,
      workspaces: sessions,
      policy: lifecyclePolicy(),
    };
  }

  async inventory(
    input: WorkspaceCandidateInventoryInput = {},
  ): Promise<WorkspaceCandidateInventory> {
    const options = normalizedCandidateInventoryOptions(input);
    const root = resolve(this.config.worktreeRoot);
    const directoryPaths = await listImmediateDirectories(root);
    const sessions = this.store.listSessions()
      .filter((session) => session.mode === "worktree" && session.managed)
      .filter((session) => options.includeClosed || session.status === "active");
    const sessionByRoot = new Map<string, WorkspaceSession>();
    for (const session of sessions) {
      const path = resolve(session.root);
      if (!sessionByRoot.has(path)) sessionByRoot.set(path, session);
    }
    const targetPaths = [...new Set([
      ...directoryPaths.map((path) => resolve(path)),
      ...sessions.map((session) => resolve(session.root)),
    ])].sort();
    const loaded = new Set(this.registry.loadedWorkspaceIds());
    const externalReferences = await linuxProcessCwdReferenceMap(targetPaths);
    const assessedAtMs = this.now();
    const candidates = await mapWithConcurrency(
      targetPaths,
      CANDIDATE_INVENTORY_CONCURRENCY,
      async (path): Promise<WorkspaceCandidateInventoryItem> => {
      const session = sessionByRoot.get(path);
      const activity = session
        ? this.store.workspaceActivity(session.id)
        : undefined;
      const rootExists = await directoryExists(path);
      const runningProcessCount = session
        ? this.runningProcesses(session.id).filter((process) => process.running).length
        : 0;
      const candidate = await assessWorkspaceCandidateLifecycle({
        path,
        rootExists,
        registered: session !== undefined,
        session,
        activity,
        loadedInCurrentRuntime: session ? loaded.has(session.id) : false,
        runningProcessCount,
        externalProcessReferences: externalReferences.get(path) ?? [],
        activeWithinHours: options.activeWithinHours,
        nowMs: assessedAtMs,
      });
      return {
        ...candidate,
        ...(options.includeSizes && rootExists
          ? { sizeBytes: await directorySizeBytes(path) }
          : {}),
      };
      },
    );

    candidates.sort(compareCandidateInventoryItems);
    const returned = candidates.slice(0, options.limit);
    const byDisposition = candidates.reduce<Record<string, number>>((counts, candidate) => {
      counts[candidate.disposition] = (counts[candidate.disposition] ?? 0) + 1;
      return counts;
    }, {});
    return {
      schemaVersion: 1,
      capabilityRef: "devspace.workspace-candidate-inventory.v1",
      generatedAt: new Date(assessedAtMs).toISOString(),
      options,
      truncated: candidates.length > returned.length,
      summary: {
        candidateCount: candidates.length,
        returnedCount: returned.length,
        publicationDebtCount: candidates.filter((candidate) => candidate.publicationDebt).length,
        technicallyReadyToPublishCount:
          candidates.filter((candidate) => candidate.technicallyReadyToPublish).length,
        safeToDeleteCount: candidates.filter((candidate) => candidate.safeToDelete).length,
        activeCount:
          candidates.filter((candidate) => candidate.operationalState === "active").length,
        branchOnlyCount: candidates.filter((candidate) => candidate.branchOnly).length,
        byDisposition,
        ...(options.includeSizes
          ? { totalBytes: sumDefined(candidates.map((candidate) => candidate.sizeBytes)) }
          : {}),
      },
      candidates: returned,
      policy: lifecyclePolicy(),
    };
  }

  async status(workspaceId: string): Promise<Record<string, unknown>> {
    const session = this.requireSession(workspaceId);
    const activity = this.store.workspaceActivity(workspaceId);
    const exists = await directoryExists(session.root);
    const processes = this.processSessions.inspect([workspaceId]);
    const externalProcessReferences = exists
      ? await linuxProcessCwdReferences(session.root)
      : [];
    const loadedInCurrentRuntime = this.registry.loadedWorkspaceIds().includes(workspaceId);
    const candidateLifecycle = session.mode === "worktree"
      ? await assessWorkspaceCandidateLifecycle({
          path: session.root,
          rootExists: exists,
          registered: true,
          session,
          activity,
          loadedInCurrentRuntime,
          runningProcessCount: processes.filter((process) => process.running).length,
          externalProcessReferences,
          activeWithinHours: DEFAULT_CANDIDATE_ACTIVE_WITHIN_HOURS,
          nowMs: this.now(),
        })
      : undefined;
    const git = candidateLifecycle?.git;
    return {
      schemaVersion: 1,
      workspace: session,
      exists,
      loadedInCurrentRuntime,
      activity: formatActivity(activity),
      git,
      candidateLifecycle,
      processes,
      externalProcessReferences,
      safeToCloseWithoutForce:
        processes.every((process) => !process.running)
        && externalProcessReferences.length === 0
        && (
          candidateLifecycle === undefined
          || (
            candidateLifecycle.git.readable
            && candidateLifecycle.git.dirty === false
            && candidateLifecycle.git.containingRefs.length > 0
            && !candidateLifecycle.publicationDebt
          )
        ),
      policy: lifecyclePolicy(),
    };
  }

  async close(input: WorkspaceCloseInput): Promise<Record<string, unknown>> {
    const session = this.requireSession(input.workspaceId);
    const remove = input.remove ?? session.mode === "worktree";
    const force = input.force === true;
    const running = this.runningProcesses(session.id).filter((process) => process.running);
    if (running.length > 0) {
      throw new Error(
        `Workspace ${session.id} has ${running.length} running process session(s); terminate them before closing the workspace.`,
      );
    }
    const externalReferences = await linuxProcessCwdReferences(session.root);
    if (externalReferences.length > 0) {
      throw new Error(
        `Workspace ${session.id} is referenced by a live operating-system process; close that process before removing the worktree.`,
      );
    }

    const activity = this.store.workspaceActivity(session.id);
    const rootExists = await directoryExists(session.root);
    const candidateLifecycle = session.mode === "worktree"
      ? await assessWorkspaceCandidateLifecycle({
          path: session.root,
          rootExists,
          registered: true,
          session,
          activity,
          loadedInCurrentRuntime: this.registry.loadedWorkspaceIds().includes(session.id),
          runningProcessCount: 0,
          externalProcessReferences: externalReferences,
          activeWithinHours: DEFAULT_CANDIDATE_ACTIVE_WITHIN_HOURS,
          nowMs: this.now(),
        })
      : undefined;
    let git: WorkspaceCandidateGitObservation | undefined = candidateLifecycle?.git;
    let preservationRefCleanup: Record<string, unknown> | undefined;
    let preservationRefAdoption: Record<string, unknown> | undefined;
    let preservationRef = session.preservationRef;
    let removed = false;
    if (remove) {
      if (session.mode !== "worktree" || !session.managed) {
        throw new Error("Only a managed worktree workspace can be removed by workspace_close.");
      }
      if (candidateLifecycle?.publicationDebt && !force) {
        throw new Error(
          `Workspace ${session.id} has unresolved candidate lifecycle state ${candidateLifecycle.disposition}; reconcile, validate, publish, or explicitly retain it before closing the managed worktree.`,
        );
      }
      if (rootExists) {
        const observedGit = candidateLifecycle?.git;
        if (!observedGit) {
          throw new Error(`Cannot assess candidate lifecycle for workspace ${session.id}.`);
        }
        git = observedGit;
        if (!observedGit.readable) {
          throw new Error(
            `Cannot remove workspace ${session.id}: ${observedGit.error ?? "Git state is unreadable"}`,
          );
        }
        if (observedGit.dirty) {
          throw new Error(
            `Workspace ${session.id} is dirty; force does not authorize discarding uncommitted changes. Resume or hand off the workspace and preserve its diff first.`,
          );
        }
        const primaryWorktree = observedGit.primaryWorktree;
        if (!primaryWorktree || !await directoryExists(primaryWorktree)) {
          throw new Error(`Cannot resolve the primary Git worktree for ${session.id}.`);
        }
        if (!preservationRef || observedGit.containingRefs.length === 0) {
          if (!session.sourceRoot || !observedGit.head) {
            throw new Error(
              `Workspace ${session.id} has no durable preservation ref and its source repository or exact HEAD is unavailable.`,
            );
          }
          const adopted = await ensureManagedWorkspacePreservationRef({
            sourceRoot: session.sourceRoot,
            workspaceId: session.id,
            expectedHeadSha: observedGit.head,
          });
          preservationRef = adopted.preservationRef;
          this.store.setPreservationRef(session.id, preservationRef);
          preservationRefAdoption = adopted;
        }
        await removeGitWorktree(primaryWorktree, session.root, force);
        removed = true;
      }
      if (
        session.sourceRoot
        && preservationRef
        && candidateLifecycle
        && !candidateLifecycle.publicationDebt
      ) {
        preservationRefCleanup = await deleteManagedWorkspacePreservationRef({
          sourceRoot: session.sourceRoot,
          preservationRef,
          expectedHeadSha: candidateLifecycle.git.head!,
        });
      } else if (preservationRef) {
        preservationRefCleanup = {
          existed: true,
          deleted: false,
          retained: true,
          reason: candidateLifecycle?.publicationDebt
            ? "publication_debt_retained"
            : "source_root_unavailable",
        };
      }
    }

    let closed: WorkspaceSession | undefined;
    let registryError: string | undefined;
    try {
      closed = this.store.closeSession(session.id);
    } catch (error) {
      if (!removed) throw error;
      registryError = error instanceof Error ? error.message : String(error);
    }
    this.registry.forgetWorkspace(session.id);
    return {
      schemaVersion: 1,
      closed: registryError === undefined,
      removed,
      removalTerminal: removed,
      forced: force,
      workspace: closed ?? { ...session, status: "closed" },
      git,
      candidateLifecycle,
      preservationRefAdoption,
      preservationRefCleanup,
      registryError,
      retryPolicy: registryError ? "reconcile_before_retry" : "not_required",
      policy: lifecyclePolicy(),
    };
  }

  async preview(input: WorkspaceGcInput = {}): Promise<WorkspaceGcPlan> {
    const options = normalizedGcOptions(input);
    const root = resolve(this.config.worktreeRoot);
    const entries = await listImmediateDirectories(root);
    const sessionByRoot = new Map<string, WorkspaceSession>();
    for (const session of this.store.listSessions()) {
      if (session.mode !== "worktree" || !session.managed) continue;
      const path = resolve(session.root);
      if (!sessionByRoot.has(path)) sessionByRoot.set(path, session);
    }
    const loaded = new Set(this.registry.loadedWorkspaceIds());
    const externalReferences = await linuxProcessCwdReferenceMap(entries);
    const items: WorkspaceGcItem[] = [];

    for (const path of entries.sort()) {
      const session = sessionByRoot.get(path);
      const activity = session
        ? this.store.workspaceActivity(session.id)
        : undefined;
      const item = await this.assessGcItem(
        path,
        session,
        activity,
        loaded,
        externalReferences.get(path) ?? [],
        options,
      );
      items.push(item);
    }

    const digestInput = {
      schemaVersion: 1,
      options,
      items: items.map(planDigestItem),
    };
    const planIdSha256 = sha256(stableJson(digestInput));
    const eligible = items.filter((item) => item.eligible);
    const protectedItems = items.filter((item) => !item.eligible);
    const includeSizes = options.includeSizes;
    return {
      schemaVersion: 1,
      generatedAt: new Date(this.now()).toISOString(),
      planIdSha256,
      options,
      summary: {
        directoryCount: items.length,
        eligibleCount: eligible.length,
        protectedCount: protectedItems.length,
        publicationDebtCount:
          items.filter((item) => item.candidateLifecycle.publicationDebt).length,
        ...(includeSizes
          ? {
              eligibleBytes: sumDefined(eligible.map((item) => item.sizeBytes)),
              protectedBytes: sumDefined(protectedItems.map((item) => item.sizeBytes)),
            }
          : {}),
      },
      items,
    };
  }

  async execute(input: WorkspaceGcExecuteInput): Promise<Record<string, unknown>> {
    if (!/^[a-f0-9]{64}$/.test(input.planIdSha256)) {
      throw new Error("planIdSha256 must be a lowercase SHA-256 digest returned by workspace_gc_preview.");
    }
    const preview = await this.preview(input);
    if (preview.planIdSha256 !== input.planIdSha256) {
      throw new Error(
        `Workspace GC plan changed: expected ${input.planIdSha256}, observed ${preview.planIdSha256}. Run workspace_gc_preview again and inspect the new plan.`,
      );
    }

    const results: Array<Record<string, unknown>> = [];
    for (const item of preview.items.filter((candidate) => candidate.eligible)) {
      let filesystemRemoved = false;
      let preservationRefCleanup: Record<string, unknown> | undefined;
      try {
        if (item.removalMode === "empty_orphan_directory") {
          const currentEntries = await listDirectoryNames(item.path);
          if (currentEntries.length > 0) {
            throw new Error("orphan directory is no longer empty");
          }
          await rmdir(item.path);
          filesystemRemoved = true;
        } else {
          const session = item.workspaceId
            ? this.store.getSession(item.workspaceId)
            : undefined;
          const externalReferences = await linuxProcessCwdReferences(item.path);
          const currentCandidate = await assessWorkspaceCandidateLifecycle({
            path: item.path,
            rootExists: await directoryExists(item.path),
            registered: session !== undefined,
            session,
            activity: session ? this.store.workspaceActivity(session.id) : undefined,
            loadedInCurrentRuntime:
              session ? this.registry.loadedWorkspaceIds().includes(session.id) : false,
            runningProcessCount:
              session
                ? this.runningProcesses(session.id).filter((process) => process.running).length
                : 0,
            externalProcessReferences: externalReferences,
            activeWithinHours: preview.options.olderThanHours,
            nowMs: this.now(),
          });
          const currentGit = currentCandidate.git;
          if (
            !currentGit.readable
            || currentGit.dirty
            || currentGit.head !== item.git.head
            || currentGit.containingRefs.length === 0
            || currentCandidate.lifecycleDigestSha256
              !== item.candidateLifecycle.lifecycleDigestSha256
            || !currentCandidate.safeToDelete
          ) {
            throw new Error("Git or candidate lifecycle state changed after preview");
          }
          if (externalReferences.length > 0) {
            throw new Error("a live operating-system process now references the worktree");
          }
          if (item.workspaceId && this.runningProcesses(item.workspaceId).some((process) => process.running)) {
            throw new Error("a DevSpace process session now references the worktree");
          }
          const primary = currentGit.primaryWorktree;
          if (!primary || !await directoryExists(primary)) {
            throw new Error("primary Git worktree is unavailable");
          }
          await removeGitWorktree(primary, item.path, false);
          filesystemRemoved = true;
          if (session?.sourceRoot && session.preservationRef) {
            preservationRefCleanup = await deleteManagedWorkspacePreservationRef({
              sourceRoot: session.sourceRoot,
              preservationRef: session.preservationRef,
              expectedHeadSha: currentCandidate.git.head!,
            });
          }
        }
        if (item.workspaceId) {
          this.store.closeSession(item.workspaceId);
          this.registry.forgetWorkspace(item.workspaceId);
        }
        results.push({
          path: item.path,
          workspaceId: item.workspaceId,
          outcome: "removed",
          sizeBytes: item.sizeBytes,
          candidateDisposition: item.candidateLifecycle.disposition,
          preservationRefCleanup,
        });
      } catch (error) {
        results.push({
          path: item.path,
          workspaceId: item.workspaceId,
          outcome: filesystemRemoved
            ? "removed_with_registry_error"
            : "protected_on_revalidation",
          error: error instanceof Error ? error.message : String(error),
          retryPolicy: filesystemRemoved ? "reconcile_before_retry" : "preview_again",
        });
      }
    }
    return {
      schemaVersion: 1,
      planIdSha256: preview.planIdSha256,
      removedCount:
        results.filter((result) => (
          result.outcome === "removed" || result.outcome === "removed_with_registry_error"
        )).length,
      registryErrorCount:
        results.filter((result) => result.outcome === "removed_with_registry_error").length,
      protectedOnRevalidationCount:
        results.filter((result) => result.outcome === "protected_on_revalidation").length,
      removedBytes: sumDefined(
        results
          .filter((result) => (
            result.outcome === "removed" || result.outcome === "removed_with_registry_error"
          ))
          .map((result) => typeof result.sizeBytes === "number" ? result.sizeBytes : undefined),
      ),
      results,
      policy: lifecyclePolicy(),
    };
  }

  private async assessGcItem(
    path: string,
    session: WorkspaceSession | undefined,
    activity: WorkspaceActivityObservation | undefined,
    loaded: Set<string>,
    externalProcessReferences: string[],
    options: Required<WorkspaceGcInput>,
  ): Promise<WorkspaceGcItem> {
    const now = this.now();
    const metadata = await stat(path);
    const filesystemMtimeMs = metadata.mtimeMs;
    const sessionLastUsedMs = parseTimestamp(session?.lastUsedAt);
    const bindingLastUsedMs = parseTimestamp(activity?.bindingLastUsedAt);
    const scopeLastActivityAtMs = activity?.scopeLastActivityAtMs;
    const recoveryRecordedAtMs = activity?.recovery?.recordedAtMs;
    const relevantTimes = [
      filesystemMtimeMs,
      sessionLastUsedMs,
      bindingLastUsedMs,
      scopeLastActivityAtMs,
      recoveryRecordedAtMs,
    ].filter((value): value is number => value !== undefined && Number.isFinite(value));
    const latestActivityMs = Math.max(...relevantTimes);
    const effectiveAgeHours = Math.max(0, now - latestActivityMs) / (60 * 60 * 1_000);
    const runningProcesses = session ? this.runningProcesses(session.id) : [];
    const loadedInCurrentRuntime = session ? loaded.has(session.id) : false;
    const candidateLifecycle = await assessWorkspaceCandidateLifecycle({
      path,
      rootExists: true,
      registered: session !== undefined,
      session,
      activity,
      loadedInCurrentRuntime,
      runningProcessCount: runningProcesses.filter((process) => process.running).length,
      externalProcessReferences,
      activeWithinHours: options.olderThanHours,
      nowMs: now,
    });
    const git = candidateLifecycle.git;
    const protectedReasons: string[] = [];
    let removalMode: WorkspaceGcItem["removalMode"];

    if (loadedInCurrentRuntime) protectedReasons.push("loaded_in_current_runtime");
    if (runningProcesses.some((process) => process.running)) {
      protectedReasons.push("running_devspace_process_session");
    }
    if (externalProcessReferences.length > 0) {
      protectedReasons.push("live_operating_system_process_reference");
    }
    if (effectiveAgeHours < options.olderThanHours) {
      protectedReasons.push("younger_than_gc_threshold");
    }
    const recentRecoveryCapsule =
      recoveryRecordedAtMs !== undefined
      && now - recoveryRecordedAtMs < options.capsuleProtectionHours * 60 * 60 * 1_000;
    if (recentRecoveryCapsule) {
      protectedReasons.push("recent_recovery_capsule");
    }
    if (
      recentRecoveryCapsule
      && capsuleDeclaresActiveAuthority(activity?.recovery?.semantic)
    ) {
      protectedReasons.push("recovery_capsule_declares_active_authority");
    }

    if (!git.readable) {
      const empty = (await listDirectoryNames(path)).length === 0;
      if (!session && empty) {
        removalMode = "empty_orphan_directory";
      } else {
        protectedReasons.push("git_state_unreadable");
      }
    } else {
      removalMode = "git_worktree";
      if (git.dirty) protectedReasons.push("dirty_worktree");
      if (git.containingRefs.length === 0) {
        protectedReasons.push("head_not_reachable_from_persistent_ref");
      }
      if (!git.primaryWorktree) protectedReasons.push("primary_worktree_unresolved");
      if (candidateLifecycle.publicationDebt) {
        protectedReasons.push("publication_debt");
      }
    }

    const sizeBytes = options.includeSizes ? await directorySizeBytes(path) : undefined;
    return {
      workspaceId: session?.id,
      path,
      registered: session !== undefined,
      status: session?.status,
      sourceRoot: session?.sourceRoot,
      createdAt: session?.createdAt,
      lastUsedAt: session?.lastUsedAt,
      scopeLastActivityAt: iso(scopeLastActivityAtMs),
      bindingLastUsedAt: activity?.bindingLastUsedAt,
      recoveryRecordedAt: iso(recoveryRecordedAtMs),
      filesystemMtime: new Date(filesystemMtimeMs).toISOString(),
      effectiveAgeHours: round(effectiveAgeHours, 3),
      sizeBytes,
      git,
      candidateLifecycle,
      runningProcessCount: runningProcesses.filter((process) => process.running).length,
      externalProcessReferences,
      loadedInCurrentRuntime,
      protectedReasons: [...new Set(protectedReasons)].sort(),
      eligible: protectedReasons.length === 0,
      removalMode,
    };
  }

  private runningProcesses(workspaceId: string): ProcessSessionInspection[] {
    return this.processSessions.inspect([workspaceId]);
  }

  private requireSession(workspaceId: string): WorkspaceSession {
    const session = this.store.getSession(workspaceId);
    if (!session) throw new Error(`Unknown workspaceId: ${workspaceId}`);
    return session;
  }
}

function normalizedGcOptions(input: WorkspaceGcInput): Required<WorkspaceGcInput> {
  return {
    olderThanHours: boundedNumber(
      input.olderThanHours,
      DEFAULT_GC_OLDER_THAN_HOURS,
      1,
      MAX_GC_AGE_HOURS,
      "olderThanHours",
    ),
    capsuleProtectionHours: boundedNumber(
      input.capsuleProtectionHours,
      DEFAULT_CAPSULE_PROTECTION_HOURS,
      1,
      MAX_GC_AGE_HOURS,
      "capsuleProtectionHours",
    ),
    includeSizes: input.includeSizes === true,
  };
}

function normalizedCandidateInventoryOptions(
  input: WorkspaceCandidateInventoryInput,
): Required<WorkspaceCandidateInventoryInput> {
  return {
    activeWithinHours: boundedNumber(
      input.activeWithinHours,
      DEFAULT_CANDIDATE_ACTIVE_WITHIN_HOURS,
      0.01,
      MAX_GC_AGE_HOURS,
      "activeWithinHours",
    ),
    includeSizes: input.includeSizes === true,
    includeClosed: input.includeClosed !== false,
    limit: boundedInteger(input.limit, 500, 1, 2_000, "limit"),
  };
}

function boundedNumber(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  const selected = value ?? fallback;
  if (!Number.isFinite(selected) || selected < minimum || selected > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}.`);
  }
  return selected;
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  const selected = boundedNumber(value, fallback, minimum, maximum, name);
  if (!Number.isInteger(selected)) throw new Error(`${name} must be an integer.`);
  return selected;
}

function lifecyclePolicy(): Record<string, unknown> {
  return {
    authority: "executor_local_workspace_lifecycle_only",
    canonicalTaskOrDecisionAuthority: false,
    writerOrEffectAuthority: false,
    publicationAuthority: false,
    localAuthorityRefsAreNotRemoteAuthority: true,
    gcRequiresPreviewDigest: true,
    candidateLifecycleFinalizersRequired: true,
    dirtyWorktreesProtectedByDefault: true,
    unpublishedCommitsProtectedByDefault: true,
    branchOnlyPreservationRefsRemainDiscoverable: true,
    executorOwnedPreservationRefsDeletedOnlyAfterTerminalIntegration: true,
    runningProcessesProtected: true,
    recoveryCapsulesDoNotGrantDeletionAuthority: true,
  };
}

function planDigestItem(item: WorkspaceGcItem): Record<string, unknown> {
  return {
    workspaceId: item.workspaceId,
    path: item.path,
    registered: item.registered,
    status: item.status,
    sourceRoot: item.sourceRoot,
    createdAt: item.createdAt,
    lastUsedAt: item.lastUsedAt,
    scopeLastActivityAt: item.scopeLastActivityAt,
    bindingLastUsedAt: item.bindingLastUsedAt,
    recoveryRecordedAt: item.recoveryRecordedAt,
    filesystemMtime: item.filesystemMtime,
    git: item.git,
    candidateLifecycle: {
      lifecycleDigestSha256: item.candidateLifecycle.lifecycleDigestSha256,
      disposition: item.candidateLifecycle.disposition,
      publicationDebt: item.candidateLifecycle.publicationDebt,
      safeToDelete: item.candidateLifecycle.safeToDelete,
      finalizers: item.candidateLifecycle.finalizers,
    },
    runningProcessCount: item.runningProcessCount,
    externalProcessReferences: item.externalProcessReferences,
    loadedInCurrentRuntime: item.loadedInCurrentRuntime,
    protectedReasons: item.protectedReasons,
    eligible: item.eligible,
    removalMode: item.removalMode,
  };
}

function compareCandidateInventoryItems(
  left: WorkspaceCandidateInventoryItem,
  right: WorkspaceCandidateInventoryItem,
): number {
  const operational = Number(right.operationalState === "active")
    - Number(left.operationalState === "active");
  if (operational !== 0) return operational;
  const debt = Number(right.publicationDebt) - Number(left.publicationDebt);
  if (debt !== 0) return debt;
  const priority: Record<string, number> = {
    dirty_recoverable: 0,
    ready_to_publish: 1,
    needs_reconcile: 2,
    awaiting_validation: 3,
    unanchored_candidate: 4,
    unknown: 5,
    integrated: 6,
    baseline_only: 7,
  };
  const disposition = (priority[left.disposition] ?? 99) - (priority[right.disposition] ?? 99);
  if (disposition !== 0) return disposition;
  return left.path.localeCompare(right.path);
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), Math.max(1, items.length));
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await mapper(items[index]!, index);
    }
  }));
  return results;
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

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function removeGitWorktree(primaryWorktree: string, target: string, force: boolean): Promise<void> {
  const args = ["worktree", "remove"];
  if (force) args.push("--force");
  args.push(target);
  await git(primaryWorktree, args);
  await git(primaryWorktree, ["worktree", "prune", "--expire", "now"]);
}

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      maxBuffer: MAX_OUTPUT_BYTES,
      timeout: 60_000,
    });
    return stdout;
  } catch (error) {
    const stderr = typeof error === "object" && error && "stderr" in error
      ? String((error as { stderr?: unknown }).stderr ?? "").trim()
      : "";
    const message = stderr || (error instanceof Error ? error.message : String(error));
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${message}`);
  }
}

async function listImmediateDirectories(root: string): Promise<string[]> {
  const directories: string[] = [];
  let handle;
  try {
    handle = await opendir(root);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return [];
    throw error;
  }
  for await (const entry of handle) {
    if (!entry.isDirectory()) continue;
    const path = resolve(root, entry.name);
    if (!isPathInsideRoot(path, root)) continue;
    directories.push(path);
  }
  return directories;
}

async function listDirectoryNames(path: string): Promise<string[]> {
  const names: string[] = [];
  let handle;
  try {
    handle = await opendir(path);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return [];
    throw error;
  }
  for await (const entry of handle) names.push(entry.name);
  return names;
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if (isErrno(error, "ENOENT") || isErrno(error, "ENOTDIR")) return false;
    throw error;
  }
}

function pathExists(path: string): boolean {
  return existsSync(path);
}

async function directorySizeBytes(path: string): Promise<number | undefined> {
  if (platform() !== "win32") {
    try {
      const { stdout } = await execFileAsync("du", ["-sk", "--", path], {
        maxBuffer: 1024 * 1024,
        timeout: 120_000,
      });
      const kibibytes = Number.parseInt(stdout.trim().split(/\s+/)[0] ?? "", 10);
      if (Number.isFinite(kibibytes)) return kibibytes * 1024;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

async function linuxProcessCwdReferenceMap(paths: string[]): Promise<Map<string, string[]>> {
  const map = new Map(paths.map((path) => [path, [] as string[]]));
  if (platform() !== "linux") return map;
  let processes;
  try {
    processes = await opendir("/proc");
  } catch {
    return map;
  }
  for await (const entry of processes) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    let cwd: string;
    try {
      cwd = resolve(await readlink(`/proc/${entry.name}/cwd`));
    } catch {
      continue;
    }
    for (const path of paths) {
      if (cwd === path || isPathInsideRoot(cwd, path)) {
        map.get(path)?.push(`pid:${entry.name}:cwd`);
      }
    }
  }
  return map;
}

async function linuxProcessCwdReferences(path: string): Promise<string[]> {
  return (await linuxProcessCwdReferenceMap([resolve(path)])).get(resolve(path)) ?? [];
}

function capsuleDeclaresActiveAuthority(semantic: Record<string, unknown> | undefined): boolean {
  if (!semantic) return false;
  return semantic.writerState === "held" || semantic.effectState === "in_flight";
}

function formatActivity(activity: WorkspaceActivityObservation): Record<string, unknown> {
  const semantic = activity.recovery?.semantic;
  return {
    scopeLastActivityAt: iso(activity.scopeLastActivityAtMs),
    latestScopeRef: activity.latestScopeRef,
    scopeRefs: activity.scopeRefs ?? [],
    bindingLastUsedAt: activity.bindingLastUsedAt,
    recoveryRecordedAt: iso(activity.recovery?.recordedAtMs),
    recoveryState: semantic
      ? {
          writerState: semantic.writerState,
          effectState: semantic.effectState,
          retryPolicy: semantic.retryPolicy,
          validationState: semantic.validationState,
        }
      : undefined,
  };
}

function parseTimestamp(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function iso(value: number | undefined): string | undefined {
  return value === undefined ? undefined : new Date(value).toISOString();
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function sumDefined(values: Array<number | undefined>): number {
  return values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
}

function isErrno(error: unknown, code: string): boolean {
  return Boolean(
    typeof error === "object"
    && error
    && "code" in error
    && (error as { code?: unknown }).code === code,
  );
}
