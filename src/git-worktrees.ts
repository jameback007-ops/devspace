import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, realpath, rm, stat } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import type { ServerConfig } from "./config.js";
import { assertAllowedPath, isPathInsideRoot } from "./roots.js";

const execFileAsync = promisify(execFile);

export class GitWorktreeError extends Error {
  constructor(
    readonly code:
      | "GIT_NOT_AVAILABLE"
      | "GIT_REPOSITORY_NOT_FOUND"
      | "GIT_REPOSITORY_HAS_NO_COMMITS"
      | "GIT_INVALID_BASE_REF"
      | "GIT_WORKTREE_CREATE_FAILED",
    message: string,
  ) {
    super(message);
    this.name = "GitWorktreeError";
  }
}

export interface ManagedWorktree {
  sourceRoot: string;
  path: string;
  baseRef: string;
  baseSha: string;
  preservationRef: string;
  dirtySource: boolean;
  detached: boolean;
  managed: boolean;
}

export async function createManagedWorktree(input: {
  sourcePath: string;
  workspaceId: string;
  baseRef?: string;
  config: ServerConfig;
}): Promise<ManagedWorktree> {
  const sourcePath = assertAllowedPath(input.sourcePath, input.config.allowedRoots);

  try {
    const sourceStats = await stat(sourcePath);
    if (!sourceStats.isDirectory()) {
      throw new GitWorktreeError(
        "GIT_REPOSITORY_NOT_FOUND",
        `Cannot open workspace in worktree mode because the source path is not a directory: ${input.sourcePath}`,
      );
    }
  } catch (error) {
    if (error instanceof GitWorktreeError) throw error;
    throw new GitWorktreeError(
      "GIT_REPOSITORY_NOT_FOUND",
      `Cannot open workspace in worktree mode because the source path does not exist: ${input.sourcePath}`,
    );
  }

  const sourceRoot = await resolveGitRoot(sourcePath, input.config.allowedRoots);
  const baseRef = input.baseRef ?? "HEAD";
  const baseSha = await resolveBaseCommit(sourceRoot, baseRef);
  const dirtySource = (await git(["status", "--porcelain=v1"], sourceRoot)).trim().length > 0;
  const preservationRef = managedWorkspacePreservationRef(input.workspaceId);
  const worktreePath = managedWorktreePath({
    worktreeRoot: input.config.worktreeRoot,
    repoRoot: sourceRoot,
  });

  await mkdir(input.config.worktreeRoot, { recursive: true });
  assertAllowedPath(worktreePath, [input.config.worktreeRoot]);

  try {
    await git([
      "worktree",
      "add",
      "--no-track",
      "-b",
      preservationRef,
      worktreePath,
      baseSha,
    ], sourceRoot);
  } catch (error) {
    await rm(worktreePath, { recursive: true, force: true });
    await removeFailedPreservationRef(sourceRoot, preservationRef, baseSha);
    const message = error instanceof Error ? error.message : String(error);
    throw new GitWorktreeError(
      "GIT_WORKTREE_CREATE_FAILED",
      `Git failed to create the managed worktree. ${message}`,
    );
  }

  return {
    sourceRoot,
    path: worktreePath,
    baseRef,
    baseSha,
    preservationRef,
    dirtySource,
    detached: false,
    managed: true,
  };
}

export function managedWorkspacePreservationRef(workspaceId: string): string {
  if (!/^ws_[a-f0-9]{10}$/.test(workspaceId)) {
    throw new Error(`Invalid DevSpace workspace ID for a preservation ref: ${workspaceId}`);
  }
  return `devspace/workspaces/${workspaceId}`;
}

export async function ensureManagedWorkspacePreservationRef(input: {
  sourceRoot: string;
  workspaceId: string;
  expectedHeadSha: string;
}): Promise<{
  preservationRef: string;
  head: string;
  created: boolean;
}> {
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(input.expectedHeadSha)) {
    throw new Error("expected_head_is_not_a_git_object_id");
  }
  const preservationRef = managedWorkspacePreservationRef(input.workspaceId);
  const fullRef = `refs/heads/${preservationRef}`;
  try {
    const observed = (await git([
      "rev-parse",
      "--verify",
      `${fullRef}^{commit}`,
    ], input.sourceRoot)).trim();
    if (observed !== input.expectedHeadSha) {
      throw new Error("workspace_preservation_ref_points_to_another_candidate");
    }
    return {
      preservationRef,
      head: observed,
      created: false,
    };
  } catch (error) {
    if (
      error instanceof Error
      && error.message === "workspace_preservation_ref_points_to_another_candidate"
    ) {
      throw error;
    }
  }

  await git([
    "update-ref",
    fullRef,
    input.expectedHeadSha,
    "0".repeat(input.expectedHeadSha.length),
  ], input.sourceRoot);
  return {
    preservationRef,
    head: input.expectedHeadSha,
    created: true,
  };
}

export async function deleteManagedWorkspacePreservationRef(input: {
  sourceRoot: string;
  preservationRef: string;
  expectedHeadSha: string;
}): Promise<{
  existed: boolean;
  deleted: boolean;
  head?: string;
  error?: string;
}> {
  if (!isManagedWorkspacePreservationRef(input.preservationRef)) {
    return {
      existed: false,
      deleted: false,
      error: "ref_is_not_an_executor_owned_workspace_preservation_ref",
    };
  }

  const fullRef = `refs/heads/${input.preservationRef}`;
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(input.expectedHeadSha)) {
    return {
      existed: false,
      deleted: false,
      error: "expected_head_is_not_a_git_object_id",
    };
  }
  let head: string;
  try {
    head = (await git(["rev-parse", "--verify", `${fullRef}^{commit}`], input.sourceRoot)).trim();
  } catch {
    return { existed: false, deleted: false };
  }
  if (head !== input.expectedHeadSha) {
    return {
      existed: true,
      deleted: false,
      head,
      error: "preservation_ref_head_changed_before_delete",
    };
  }

  try {
    await git(["update-ref", "-d", fullRef, input.expectedHeadSha], input.sourceRoot);
    return { existed: true, deleted: true, head };
  } catch (error) {
    return {
      existed: true,
      deleted: false,
      head,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function isManagedWorkspacePreservationRef(value: string): boolean {
  return /^devspace\/workspaces\/ws_[a-f0-9]{10}$/.test(value);
}

async function resolveGitRoot(path: string, allowedRoots: string[]): Promise<string> {
  try {
    const output = await git(["rev-parse", "--show-toplevel"], path);
    return await assertGitRootAllowed(output.trim(), allowedRoots);
  } catch (error) {
    if (isGitUnavailable(error)) {
      throw new GitWorktreeError(
        "GIT_NOT_AVAILABLE",
        "Cannot open workspace in worktree mode because Git is not available on this machine.",
      );
    }

    throw new GitWorktreeError(
      "GIT_REPOSITORY_NOT_FOUND",
      `Cannot open workspace in worktree mode because this path is not inside a Git repository: ${path}. Use mode=\"checkout\" to work directly in this directory, or initialize Git and create an initial commit first.`,
    );
  }
}

async function assertGitRootAllowed(gitRoot: string, allowedRoots: string[]): Promise<string> {
  try {
    return assertAllowedPath(gitRoot, allowedRoots);
  } catch {
    const canonicalGitRoot = await realpath(gitRoot);
    for (const allowedRoot of allowedRoots) {
      const canonicalAllowedRoot = await realpath(allowedRoot).catch(() => undefined);
      if (!canonicalAllowedRoot || !isPathInsideRoot(canonicalGitRoot, canonicalAllowedRoot)) {
        continue;
      }

      const logicalGitRoot = resolve(allowedRoot, relative(canonicalAllowedRoot, canonicalGitRoot));
      return assertAllowedPath(logicalGitRoot, allowedRoots);
    }

    return assertAllowedPath(canonicalGitRoot, allowedRoots);
  }
}

async function resolveBaseCommit(sourceRoot: string, baseRef: string): Promise<string> {
  try {
    return (await git(["rev-parse", "--verify", `${baseRef}^{commit}`], sourceRoot)).trim();
  } catch (error) {
    if (baseRef === "HEAD") {
      throw new GitWorktreeError(
        "GIT_REPOSITORY_HAS_NO_COMMITS",
        "Cannot open workspace in worktree mode because the repository has no commits yet. Create an initial commit first, or use mode=\"checkout\".",
      );
    }

    throw new GitWorktreeError(
      "GIT_INVALID_BASE_REF",
      `Cannot open workspace in worktree mode because baseRef ${JSON.stringify(baseRef)} does not resolve to a commit.`,
    );
  }
}

function managedWorktreePath(input: { worktreeRoot: string; repoRoot: string }): string {
  const repoName = sanitizePathSegment(basename(input.repoRoot)) || "repo";
  const worktreeId = randomBytes(4).toString("hex");
  return join(input.worktreeRoot, `${repoName}-${worktreeId}`);
}

function sanitizePathSegment(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

async function removeFailedPreservationRef(
  sourceRoot: string,
  preservationRef: string,
  expectedHead: string,
): Promise<void> {
  try {
    await git(["worktree", "prune", "--expire", "now"], sourceRoot);
    const observed = (await git([
      "rev-parse",
      "--verify",
      `refs/heads/${preservationRef}^{commit}`,
    ], sourceRoot)).trim();
    if (observed !== expectedHead) return;
    await git(["branch", "-D", preservationRef], sourceRoot);
  } catch {
    // Preserve the original worktree-creation failure. A ref that cannot be
    // proven to be the newly-created base ref is deliberately retained.
  }
}

async function git(args: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    if (isGitUnavailable(error)) throw error;

    const stderr = typeof error === "object" && error && "stderr" in error
      ? String((error as { stderr?: unknown }).stderr ?? "").trim()
      : "";
    const stdout = typeof error === "object" && error && "stdout" in error
      ? String((error as { stdout?: unknown }).stdout ?? "").trim()
      : "";
    const details = stderr || stdout || (error instanceof Error ? error.message : String(error));
    throw new Error(details);
  }
}

function isGitUnavailable(error: unknown): boolean {
  return Boolean(
    typeof error === "object" &&
      error &&
      "code" in error &&
      (error as { code?: unknown }).code === "ENOENT",
  );
}
