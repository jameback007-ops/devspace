import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { opendir, readlink, rmdir, stat } from "node:fs/promises";
import { platform } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import type { ServerConfig } from "./config.js";
import type {
  ProcessSessionInspection,
  ProcessSessionManager,
} from "./process-sessions.js";
import { isPathInsideRoot } from "./roots.js";
import type {
  WorkspaceActivityObservation,
  WorkspaceSession,
  WorkspaceStore,
} from "./workspace-store.js";
import type { WorkspaceRegistry } from "./workspaces.js";

const execFileAsync = promisify(execFile);
const DEFAULT_GC_OLDER_THAN_HOURS = 24;
const DEFAULT_CAPSULE_PROTECTION_HOURS = 72;
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

export interface WorkspaceGitObservation {
  readable: boolean;
  dirty?: boolean;
  head?: string;
  branch?: string;
  containingRefs: string[];
  primaryWorktree?: string;
  error?: string;
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
  git: WorkspaceGitObservation;
  runningProcessCount: number;
  externalProcessReferences: string[];
  loadedInCurrentRuntime: boolean;
  protectedReasons: string[];
  eligible: boolean;
  removalMode?: "git_worktree" | "empty_orphan_directory";
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

  async status(workspaceId: string): Promise<Record<string, unknown>> {
    const session = this.requireSession(workspaceId);
    const activity = this.store.workspaceActivity(workspaceId);
    const exists = await directoryExists(session.root);
    const git = exists && session.mode === "worktree"
      ? await observeGitWorktree(session.root)
      : undefined;
    const processes = this.processSessions.inspect([workspaceId]);
    const externalProcessReferences = exists
      ? await linuxProcessCwdReferences(session.root)
      : [];
    return {
      schemaVersion: 1,
      workspace: session,
      exists,
      loadedInCurrentRuntime: this.registry.loadedWorkspaceIds().includes(workspaceId),
      activity: formatActivity(activity),
      git,
      processes,
      externalProcessReferences,
      safeToCloseWithoutForce:
        processes.every((process) => !process.running)
        && externalProcessReferences.length === 0
        && (git === undefined || (git.readable && git.dirty === false && git.containingRefs.length > 0)),
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

    let git: WorkspaceGitObservation | undefined;
    let removed = false;
    if (remove) {
      if (session.mode !== "worktree" || !session.managed) {
        throw new Error("Only a managed worktree workspace can be removed by workspace_close.");
      }
      if (await directoryExists(session.root)) {
        git = await observeGitWorktree(session.root);
        if (!git.readable) {
          throw new Error(`Cannot remove workspace ${session.id}: ${git.error ?? "Git state is unreadable"}`);
        }
        if (git.dirty && !force) {
          throw new Error(`Workspace ${session.id} is dirty; inspect or preserve its changes before closing it.`);
        }
        if (git.containingRefs.length === 0 && !force) {
          throw new Error(
            `Workspace ${session.id} HEAD is not reachable from a persistent Git ref; preserve or publish the commit before closing it.`,
          );
        }
        const primaryWorktree = git.primaryWorktree;
        if (!primaryWorktree || !await directoryExists(primaryWorktree)) {
          throw new Error(`Cannot resolve the primary Git worktree for ${session.id}.`);
        }
        await removeGitWorktree(primaryWorktree, session.root, force);
        removed = true;
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
      registryError,
      retryPolicy: registryError ? "reconcile_before_retry" : "not_required",
      policy: lifecyclePolicy(),
    };
  }

  async preview(input: WorkspaceGcInput = {}): Promise<WorkspaceGcPlan> {
    const options = normalizedGcOptions(input);
    const root = resolve(this.config.worktreeRoot);
    const entries = await listImmediateDirectories(root);
    const sessionByRoot = new Map(
      this.store.listSessions()
        .filter((session) => session.mode === "worktree" && session.managed)
        .map((session) => [resolve(session.root), session]),
    );
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
      try {
        if (item.removalMode === "empty_orphan_directory") {
          const currentEntries = await listDirectoryNames(item.path);
          if (currentEntries.length > 0) {
            throw new Error("orphan directory is no longer empty");
          }
          await rmdir(item.path);
          filesystemRemoved = true;
        } else {
          const currentGit = await observeGitWorktree(item.path);
          if (
            !currentGit.readable
            || currentGit.dirty
            || currentGit.head !== item.git.head
            || currentGit.containingRefs.length === 0
          ) {
            throw new Error("Git state changed after preview");
          }
          const externalReferences = await linuxProcessCwdReferences(item.path);
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
    const git = await observeGitWorktree(path);
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
    gcRequiresPreviewDigest: true,
    dirtyWorktreesProtectedByDefault: true,
    unpublishedCommitsProtectedByDefault: true,
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
    runningProcessCount: item.runningProcessCount,
    externalProcessReferences: item.externalProcessReferences,
    loadedInCurrentRuntime: item.loadedInCurrentRuntime,
    protectedReasons: item.protectedReasons,
    eligible: item.eligible,
    removalMode: item.removalMode,
  };
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

async function observeGitWorktree(path: string): Promise<WorkspaceGitObservation> {
  try {
    const statusResult = await git(path, ["status", "--porcelain=v1", "--untracked-files=all"]);
    const head = (await git(path, ["rev-parse", "HEAD"])).trim();
    const branch = (await git(path, ["branch", "--show-current"])).trim() || undefined;
    const refs = (await git(path, [
      "for-each-ref",
      "--format=%(refname)",
      "--contains",
      "HEAD",
      "refs/heads",
      "refs/tags",
      "refs/remotes",
    ])).split(/\r?\n/).filter(Boolean).sort();
    const worktreeList = await git(path, ["worktree", "list", "--porcelain"]);
    const primaryWorktree = worktreeList.split(/\r?\n/)
      .find((line) => line.startsWith("worktree "))
      ?.slice("worktree ".length);
    return {
      readable: true,
      dirty: statusResult.trim().length > 0,
      head,
      branch,
      containingRefs: refs,
      primaryWorktree,
    };
  } catch (error) {
    return {
      readable: false,
      containingRefs: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
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
