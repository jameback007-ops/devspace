import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import {
  lstat,
  mkdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import type { ZesResearchCycleConfig } from "./config.js";
import { processEnvironment } from "./process-sessions.js";

const RESEARCH_MARKER = "packages/zes-control-kernel/pyproject.toml";
const MAX_PROCESS_OUTPUT_BYTES = 2 * 1024 * 1024;
const STATE_SCHEMA = "devspace.zes-research-cycle-state.v1";
const OPEN_SCHEMA = "devspace.zes-research-cycle-open.v1";
const PREPARED_SCHEMA = "devspace.zes-research-cycle-prepared-scope.v1";
const ADMISSION_REQUEST_SCHEMA = "zes.research-decision-admission-request.v3";
const ADMISSION_RECEIPT_SCHEMA = "zes.research-decision-admission-receipt.v3";
const EPISODE_PACKET_SCHEMAS = new Set([
  "zes.research-episode-packet.v1",
  "zes.research-episode-packet.v2",
]);
const SHA256 = /^[0-9a-f]{64}$/u;
const RESEARCH_PHASES = new Set<ResearchCyclePhase>([
  "opened",
  "prepared",
  "admitted",
  "held",
  "reassessment_required",
  "pre_commit_verified",
  "committed",
  "closed",
]);

export type ResearchCyclePhase =
  | "opened"
  | "prepared"
  | "admitted"
  | "held"
  | "reassessment_required"
  | "pre_commit_verified"
  | "committed"
  | "closed";

export type ResearchOperationClass =
  | "source_mutation"
  | "repository_commit"
  | "repository_publish"
  | "dependency_change"
  | "runtime_effect";

export type ResearchCommandClass =
  | "inspection"
  | "research_control"
  | "validation"
  | "source_mutation"
  | "commit_prepare"
  | "repository_commit"
  | "repository_publish"
  | "runtime_effect"
  | "unknown";

export type ResearchInvalidationKind =
  | "architecture_or_semantic_fork"
  | "contradictory_evidence"
  | "dependency_or_upstream_change"
  | "owner_direction_changed"
  | "repeated_distinct_failure"
  | "scope_drift"
  | "source_currentness_expired"
  | "manual";

export interface ResearchWorkspace {
  workspaceId: string;
  root: string;
}

export interface ResearchCycleOpenInput {
  taskRef: string;
  materialDecisionRef: string;
  decisionBoundaryRef: string;
  decisionQuestion: string;
  candidatePathPrefixes: string[];
  researchEnvelopeHypothesis:
    | "no_search"
    | "quick_lookup"
    | "focused_research"
    | "deep_research";
  researchQuestions: string[];
  knownLocalEvidenceRefs: string[];
  uncertainties: string[];
  falsifier: string;
  reopenTrigger: string;
  actorRef: string;
  ownerSeededFraming: boolean;
  replaceExisting?: boolean;
  replacementReason?: string;
}

export interface ResearchCyclePrepareInput {
  pathPrefixes: string[];
  operationClasses: ResearchOperationClass[];
  evidenceRegimeRefs: string[];
  sourceIdentityRefs: string[];
  shellMutationCommandDigests?: string[];
  repositoryWideScopeReason?: string;
}

export interface ResearchProviderTraceInput {
  traceRef: string;
  path: string;
}

export interface ResearchProviderEvidenceContext {
  cycleRef: string;
  generation: number;
  phase: "prepared";
  evidenceDirectory: string;
  ownerSeededFraming: boolean;
  taskRef: string;
  materialDecisionRef: string;
  decisionBoundaryRef: string;
}

export interface ResearchPreCommitChallenge {
  localAuthorityRechecked: boolean;
  externalCurrentnessRechecked: boolean;
  dependencyCurrentnessRechecked: boolean;
  assumptionsRechecked: string[];
  counterevidenceOrLimitations: string[];
  unresolved: string[];
  stoppingReason: string;
}

export interface ResearchGuardDecision {
  managed: boolean;
  mode: ZesResearchCycleConfig["mode"];
  allowed: boolean;
  classification?: ResearchCommandClass | "apply_patch";
  reasons: string[];
  cycleRef?: string;
  phase?: ResearchCyclePhase;
  advisoryOnly: boolean;
}

export interface ResearchNativeInvocation {
  operation: "assess" | "verify-admission" | "compile";
  args: string[];
  cwd: string;
  timeoutMs: number;
}

export interface ResearchNativeResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type ResearchNativeRunner = (
  invocation: ResearchNativeInvocation,
) => Promise<ResearchNativeResult>;

interface GitSnapshot {
  head: string;
  sourceTree: string;
  branch: string;
  repositoryIdentityDigestSha256: string;
  workingContentDigestSha256: string;
  dirty: boolean;
}

interface ResearchOpenRecord extends ResearchCycleOpenInput {
  schemaVersion: typeof OPEN_SCHEMA;
  cycleRef: string;
  openedAt: string;
  baseline: GitSnapshot;
  evidenceDirectory: string;
}

interface PreparedScopeRecord extends ResearchCyclePrepareInput {
  schemaVersion: typeof PREPARED_SCHEMA;
  generation: number;
  preparedAt: string;
  snapshot: GitSnapshot;
  decisionScopeDigestSha256: string;
  evidenceRegimeDigestSha256: string;
  sourceIdentityDigestSha256: string;
  implementationBoundaryDigestSha256: string;
  actionScopeDigestSha256: string;
}

interface ProviderTraceRecord {
  traceRef: string;
  path: string;
}

interface AdmissionRecord {
  state: string;
  admitted: boolean;
  requestDigestSha256: string;
  receiptRef?: string;
  receiptDigestSha256?: string;
  receiptFileSha256: string;
  receiptPath: string;
  validUntil?: string;
  providerTraces: ProviderTraceRecord[];
  evaluatedAt: string;
  causalReason?: string;
}

interface ResearchInvalidationRecord {
  kind: ResearchInvalidationKind;
  reason: string;
  evidenceRefs: string[];
  recordedAt: string;
}

interface PreCommitRecord {
  verifiedAt: string;
  workingContentDigestSha256: string;
  validationRefs: string[];
  challenge: ResearchPreCommitChallenge;
}

interface CommitRecord {
  committedAt: string;
  headBefore: string;
  headAfter: string;
  sourceTreeAfter: string;
  commandDigestSha256: string;
}

interface ClosureRecord {
  outcome: "committed" | "no_change" | "deferred" | "abandoned";
  reason: string;
  decisionDelta: string;
  reusableFindings: string[];
  reversalConditions: string[];
  closedAt: string;
  closedHead: string;
  episodeReceiptRef?: string;
  episodeReceiptDigestSha256?: string;
  episodeReceiptFileSha256?: string;
  episodeReceiptPath?: string;
}

interface ResearchCycleState {
  schemaVersion: typeof STATE_SCHEMA;
  workspaceId: string;
  workspaceRootDigestSha256: string;
  cycleRef: string;
  phase: ResearchCyclePhase;
  generation: number;
  open: ResearchOpenRecord;
  prepared?: PreparedScopeRecord;
  admission?: AdmissionRecord;
  invalidations: ResearchInvalidationRecord[];
  observedPaths: string[];
  dependencySensitivePaths: string[];
  distinctFailureDigests: string[];
  validationCommandDigests: string[];
  preCommit?: PreCommitRecord;
  commit?: CommitRecord;
  closure?: ClosureRecord;
  updatedAt: string;
}

interface PendingCommand {
  workspace: ResearchWorkspace;
  command: string;
  classification: ResearchCommandClass;
}

interface ResearchCycleManagerOptions {
  now?: () => Date;
  nativeRunner?: ResearchNativeRunner;
}

export class ResearchCycleError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ResearchCycleError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalValue(value[key])]),
  );
}

export function canonicalDigest(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalValue(value)))
    .digest("hex");
}

export function researchCommandDigest(command: string): string {
  return createHash("sha256").update(command.trim(), "utf8").digest("hex");
}

function uniqueStrings(values: readonly string[], label: string): string[] {
  const normalized = values.map((value) => value.trim()).filter(Boolean);
  if (normalized.length !== values.length) {
    throw new ResearchCycleError(
      "RESEARCH_CYCLE_EMPTY_IDENTITY",
      `${label} cannot contain empty values`,
    );
  }
  return [...new Set(normalized)].sort();
}

function requiredString(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new ResearchCycleError(
      "RESEARCH_CYCLE_IDENTITY_REQUIRED",
      `${label} is required`,
    );
  }
  return normalized;
}

function normalizeRelativePath(value: string, label: string): string {
  const normalized = value.trim().replaceAll("\\", "/").replace(/^\.\//u, "");
  if (
    !normalized
    || normalized.startsWith("/")
    || normalized === ".."
    || normalized.startsWith("../")
    || normalized.includes("/../")
  ) {
    throw new ResearchCycleError(
      "RESEARCH_CYCLE_PATH_INVALID",
      `${label} must be a workspace-relative path`,
      { path: value },
    );
  }
  return normalized.replace(/\/+$/u, "") || ".";
}

function normalizePathPrefixes(values: readonly string[]): string[] {
  const normalized = values.map((value) =>
    normalizeRelativePath(value, "path prefix")
  );
  return [...new Set(normalized)].sort();
}

function pathWithinPrefix(path: string, prefix: string): boolean {
  return prefix === "." || path === prefix || path.startsWith(`${prefix}/`);
}

function pathInside(path: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function realpathOrResolved(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

function workspaceKey(root: string): string {
  return createHash("sha256").update(resolve(root)).digest("hex").slice(0, 32);
}

function parseJsonObject(text: string, label: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new ResearchCycleError(
      "RESEARCH_CYCLE_JSON_INVALID",
      `${label} is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!isRecord(value)) {
    throw new ResearchCycleError(
      "RESEARCH_CYCLE_JSON_OBJECT_REQUIRED",
      `${label} must be a JSON object`,
    );
  }
  return value;
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, path);
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function runProcess(
  command: string,
  args: string[],
  options: { cwd?: string; timeoutMs: number },
): Promise<ResearchNativeResult> {
  return await new Promise((resolveResult, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      // Reuse DevSpace's bounded command environment so the fixed native ZES
      // port receives ordinary toolchain paths and explicit passthrough values,
      // but never inherits unrelated service credentials by default.
      env: processEnvironment(),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`process timed out after ${options.timeoutMs}ms`));
    }, options.timeoutMs);
    timer.unref();
    const append = (target: Buffer[], chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_PROCESS_OUTPUT_BYTES) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.kill("SIGKILL");
        reject(new Error("process output exceeded 2 MiB"));
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => append(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => append(stderr, chunk));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveResult({
        exitCode: code ?? -1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

function processFailureEvidence(
  result: ResearchNativeResult,
): Record<string, unknown> {
  const output = `${result.stderr}\n${result.stdout}`;
  return {
    exitCode: result.exitCode,
    stdoutPresent: result.stdout.length > 0,
    stderrPresent: result.stderr.length > 0,
    outputBytes: Buffer.byteLength(output),
    outputDigestSha256: createHash("sha256").update(output).digest("hex"),
  };
}

async function defaultNativeRunner(
  config: ZesResearchCycleConfig,
  invocation: ResearchNativeInvocation,
): Promise<ResearchNativeResult> {
  return await runProcess(
    "uv",
    [
      "run",
      "--frozen",
      "--directory",
      config.repositoryRoot,
      "--package",
      "zes-control-kernel",
      "zes-research-reflex",
      invocation.operation,
      ...invocation.args,
    ],
    { cwd: invocation.cwd, timeoutMs: invocation.timeoutMs },
  );
}

async function git(root: string, args: string[]): Promise<string> {
  const result = await runProcess(
    "git",
    ["-C", root, ...args],
    { timeoutMs: 30_000 },
  );
  if (result.exitCode !== 0) {
    throw new ResearchCycleError(
      "RESEARCH_CYCLE_GIT_FAILED",
      `git ${args[0] ?? "command"} failed with exit ${result.exitCode}`,
      processFailureEvidence(result),
    );
  }
  return result.stdout.trim();
}

async function workingContentDigest(root: string, head: string): Promise<{
  digest: string;
  dirty: boolean;
}> {
  const diffResult = await runProcess(
    "git",
    ["-C", root, "diff", "--binary", "--no-ext-diff", head, "--"],
    { timeoutMs: 30_000 },
  );
  if (diffResult.exitCode !== 0) {
    throw new ResearchCycleError(
      "RESEARCH_CYCLE_GIT_FAILED",
      `git diff failed with exit ${diffResult.exitCode}`,
      processFailureEvidence(diffResult),
    );
  }
  const untrackedResult = await runProcess(
    "git",
    [
      "-C",
      root,
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
    ],
    { timeoutMs: 30_000 },
  );
  if (untrackedResult.exitCode !== 0) {
    throw new ResearchCycleError(
      "RESEARCH_CYCLE_GIT_FAILED",
      `git ls-files failed with exit ${untrackedResult.exitCode}`,
      processFailureEvidence(untrackedResult),
    );
  }
  const diff = diffResult.stdout;
  const rawUntracked = untrackedResult.stdout;
  const untracked = rawUntracked.split("\0").filter(Boolean).sort();
  const hash = createHash("sha256");
  hash.update("devspace.zes-working-content.v1\0");
  hash.update(head);
  hash.update("\0diff\0");
  hash.update(diff);
  for (const rawPath of untracked) {
    const path = normalizeRelativePath(rawPath, "untracked Git path");
    const absolute = resolve(root, path);
    if (!pathInside(absolute, root)) {
      throw new ResearchCycleError(
        "RESEARCH_CYCLE_UNTRACKED_PATH_ESCAPE",
        "untracked Git path escaped the workspace",
      );
    }
    const metadata = await lstat(absolute);
    hash.update("\0untracked\0");
    hash.update(path);
    hash.update("\0");
    if (metadata.isSymbolicLink()) {
      hash.update("symlink\0");
      hash.update(await readlink(absolute));
    } else if (metadata.isFile()) {
      hash.update("file\0");
      hash.update(String(metadata.size));
      hash.update("\0");
      hash.update(await sha256File(absolute));
    } else {
      hash.update(`other:${metadata.mode}`);
    }
  }
  return {
    digest: hash.digest("hex"),
    dirty: diff.length > 0 || untracked.length > 0,
  };
}

async function gitSnapshot(root: string): Promise<GitSnapshot> {
  const head = await git(root, ["rev-parse", "HEAD"]);
  const sourceTree = await git(root, ["rev-parse", `${head}^{tree}`]);
  const branchResult = await runProcess(
    "git",
    ["-C", root, "symbolic-ref", "--quiet", "--short", "HEAD"],
    { timeoutMs: 30_000 },
  );
  const branch = branchResult.exitCode === 0 && branchResult.stdout.trim()
    ? branchResult.stdout.trim()
    : "(detached)";
  const commonDir = await git(root, ["rev-parse", "--git-common-dir"]);
  const remoteResult = await runProcess(
    "git",
    ["-C", root, "remote", "-v"],
    { timeoutMs: 30_000 },
  );
  const content = await workingContentDigest(root, head);
  return {
    head,
    sourceTree,
    branch,
    repositoryIdentityDigestSha256: canonicalDigest({
      commonDir: resolve(root, commonDir),
      remotes: remoteResult.exitCode === 0 ? remoteResult.stdout.trim() : "",
    }),
    workingContentDigestSha256: content.digest,
    dirty: content.dirty,
  };
}

async function currentChangedPaths(root: string): Promise<string[]> {
  const tracked = await runProcess(
    "git",
    ["-C", root, "diff", "--name-only", "-z", "HEAD", "--"],
    { timeoutMs: 30_000 },
  );
  const untracked = await runProcess(
    "git",
    [
      "-C",
      root,
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
    ],
    { timeoutMs: 30_000 },
  );
  if (tracked.exitCode !== 0 || untracked.exitCode !== 0) {
    throw new ResearchCycleError(
      "RESEARCH_CYCLE_GIT_FAILED",
      `cannot reconcile changed paths (tracked exit ${tracked.exitCode}, untracked exit ${untracked.exitCode})`,
      {
        tracked: processFailureEvidence(tracked),
        untracked: processFailureEvidence(untracked),
      },
    );
  }
  return uniqueStrings(
    [...tracked.stdout.split("\0"), ...untracked.stdout.split("\0")]
      .filter(Boolean)
      .map((path) => normalizeRelativePath(path, "changed Git path")),
    "changedPaths",
  );
}

export function extractPatchPaths(patch: string): string[] {
  const paths: string[] = [];
  for (const line of patch.split(/\r?\n/u)) {
    const file = line.match(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/u)?.[1];
    const move = line.match(/^\*\*\* Move to: (.+)$/u)?.[1];
    if (file) paths.push(normalizeRelativePath(file, "patch path"));
    if (move) paths.push(normalizeRelativePath(move, "patch move path"));
  }
  if (paths.length === 0) {
    throw new ResearchCycleError(
      "RESEARCH_CYCLE_PATCH_PATHS_MISSING",
      "the patch contains no recognized file path",
    );
  }
  return [...new Set(paths)].sort();
}

function commandHas(command: string, expression: RegExp): boolean {
  return expression.test(command.toLowerCase());
}

export function classifyResearchCommand(command: string): ResearchCommandClass {
  const value = command.trim();
  if (!value) return "unknown";
  if (
    commandHas(value, /\bgit\b[^\n;&|]*\bpush\b/u)
    || commandHas(value, /\bgh\s+(?:pr\s+(?:create|merge)|release\s+create)\b/u)
    || commandHas(value, /\b(?:npm\s+publish|twine\s+upload)\b/u)
  ) return "repository_publish";
  if (
    commandHas(value, /\bsystemctl\s+(?:start|stop|restart|reload|enable|disable)\b/u)
    || commandHas(value, /\bdocker(?:\s+compose)?\s+(?:up|down|run|rm|rmi|build|push|pull)\b/u)
    || commandHas(value, /\bkubectl\s+(?:apply|create|delete|edit|patch|replace|rollout|scale|set)\b/u)
    || commandHas(value, /\bhelm\s+(?:install|upgrade|rollback|uninstall)\b/u)
    || commandHas(value, /\bterraform\s+(?:apply|destroy|import)\b/u)
  ) return "runtime_effect";
  if (commandHas(value, /\bgit\b[^\n;&|]*\bcommit\b/u)) {
    return "repository_commit";
  }
  if (commandHas(value, /\bgit\b[^\n;&|]*\badd\b/u)) return "commit_prepare";
  if (
    commandHas(value, /\bzes-research-reflex\b/u)
    || commandHas(value, /\bzes-accelerate\b[^\n;&|]*\bprovider\b/u)
  ) return "research_control";
  if (
    commandHas(value, /\bgit\b[^\n;&|]*\b(?:am|checkout|cherry-pick|clean|merge|mv|rebase|reset|restore|rm|switch|tag)\b/u)
    || commandHas(value, /\b(?:npm|pnpm|yarn)\s+(?:add|install|remove|uninstall|update|upgrade)\b/u)
    || commandHas(value, /\buv\s+(?:add|remove|lock|sync)\b/u)
    || commandHas(value, /\bpip\s+install\b/u)
    || commandHas(value, /(?:^|[;&|]\s*)(?:tee|sed\s+-i|perl\s+-i)\b/u)
    || /(?:^|[^>])>{1,2}(?!>)/u.test(value)
  ) return "source_mutation";
  if (
    commandHas(value, /\b(?:npm|pnpm|yarn)\s+(?:test|run\s+(?:build|check|lint|test|typecheck))\b/u)
    || commandHas(value, /\b(?:pytest|ruff|mypy|pyright|vitest|jest|eslint|tsc)\b/u)
    || commandHas(value, /\b(?:pants|bake)\b/u)
    || commandHas(value, /\bgit\s+diff\s+--check\b/u)
  ) return "validation";
  if (
    commandHas(value, /^(?:\s*(?:rg|grep|find|fd|ls|tree|cat|head|tail|wc|stat|du|df|jq|yq|echo|printf)\b)/u)
    || commandHas(value, /\bgit\s+(?:status|diff|log|show|rev-parse|branch|remote|ls-files|ls-tree|merge-base)\b/u)
    || commandHas(value, /\bsystemctl\s+(?:status|show|cat|is-active|is-enabled)\b/u)
    || commandHas(value, /\bdocker\s+(?:ps|images|inspect|logs|version|info)\b/u)
    || commandHas(value, /\bdocker\s+buildx\s+bake\b[^\n;&|]*--print\b/u)
    || commandHas(value, /\bkubectl\s+(?:get|describe|logs|diff|version)\b/u)
  ) return "inspection";
  return "unknown";
}

function dependencySensitive(path: string): boolean {
  const name = path.split("/").at(-1) ?? path;
  return name === "package.json"
    || name === "package-lock.json"
    || name === "pnpm-lock.yaml"
    || name === "yarn.lock"
    || name === "pyproject.toml"
    || name === "uv.lock"
    || name === "pants.toml"
    || name === "Dockerfile"
    || name === "docker-compose.yml"
    || name === "docker-compose.yaml"
    || name === "BUILD"
    || name.startsWith("BUILD.")
    || path.startsWith(".github/workflows/")
    || path.startsWith("release/");
}

function commandChangesDependencies(command: string): boolean {
  return commandHas(
    command,
    /\b(?:npm|pnpm|yarn)\s+(?:add|install|remove|uninstall|update|upgrade)\b/u,
  )
    || commandHas(command, /\buv\s+(?:add|remove|lock|sync)\b/u)
    || commandHas(command, /\bpip\s+install\b/u);
}

export class ZesResearchCycleManager {
  private readonly now: () => Date;
  private readonly nativeRunner: ResearchNativeRunner;
  private readonly pendingCommands = new Map<number, PendingCommand>();
  private readonly locks = new Map<string, Promise<void>>();

  constructor(
    readonly config: ZesResearchCycleConfig,
    options: ResearchCycleManagerOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.nativeRunner = options.nativeRunner
      ?? ((invocation) => defaultNativeRunner(config, invocation));
  }

  get enabled(): boolean {
    return this.config.mode !== "off";
  }

  manages(workspace: ResearchWorkspace): boolean {
    return this.enabled
      && existsSync(resolve(workspace.root, RESEARCH_MARKER));
  }

  private cycleDirectory(workspace: ResearchWorkspace): string {
    return resolve(this.config.stateRoot, workspaceKey(workspace.root));
  }

  private statePath(workspace: ResearchWorkspace): string {
    return resolve(this.cycleDirectory(workspace), "state.json");
  }

  private async withLock<T>(
    workspace: ResearchWorkspace,
    operation: () => Promise<T>,
  ): Promise<T> {
    const key = workspaceKey(workspace.root);
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const current = new Promise<void>((resolveLock) => {
      release = resolveLock;
    });
    const queued = previous.then(() => current);
    this.locks.set(key, queued);
    await previous;
    try {
      return await operation();
    } finally {
      release?.();
      if (this.locks.get(key) === queued) this.locks.delete(key);
    }
  }

  private assertManaged(workspace: ResearchWorkspace): void {
    if (!this.manages(workspace)) {
      throw new ResearchCycleError(
        "RESEARCH_CYCLE_WORKSPACE_NOT_MANAGED",
        "the workspace is not an enabled ZES Research Reflex workspace",
      );
    }
  }

  private async readState(
    workspace: ResearchWorkspace,
  ): Promise<ResearchCycleState | undefined> {
    try {
      const value = parseJsonObject(
        await readFile(this.statePath(workspace), "utf8"),
        "research cycle state",
      );
      if (value.schemaVersion !== STATE_SCHEMA) {
        throw new ResearchCycleError(
          "RESEARCH_CYCLE_STATE_SCHEMA_UNSUPPORTED",
          `unsupported research cycle state: ${String(value.schemaVersion)}`,
        );
      }
      return await this.validatePersistedState(workspace, value);
    } catch (error) {
      if (
        error instanceof Error
        && "code" in error
        && error.code === "ENOENT"
      ) return undefined;
      throw error;
    }
  }

  private async validatePersistedState(
    workspace: ResearchWorkspace,
    value: Record<string, unknown>,
  ): Promise<ResearchCycleState> {
    if (
      value.workspaceId !== workspace.workspaceId
      || value.workspaceRootDigestSha256
        !== canonicalDigest(resolve(workspace.root))
    ) {
      throw new ResearchCycleError(
        "RESEARCH_CYCLE_STATE_IDENTITY_MISMATCH",
        "persisted research-cycle state does not belong to this workspace",
      );
    }
    if (
      typeof value.cycleRef !== "string"
      || !value.cycleRef.startsWith("zes-research-cycle:")
      || typeof value.phase !== "string"
      || !RESEARCH_PHASES.has(value.phase as ResearchCyclePhase)
      || !Number.isInteger(value.generation)
      || Number(value.generation) < 0
      || !isRecord(value.open)
      || typeof value.open.evidenceDirectory !== "string"
    ) {
      throw new ResearchCycleError(
        "RESEARCH_CYCLE_STATE_SHAPE_INVALID",
        "persisted research-cycle state lacks a valid lifecycle identity",
      );
    }

    const cycleRoot = await realpathOrResolved(this.cycleDirectory(workspace));
    const evidenceDirectory = await realpathOrResolved(
      value.open.evidenceDirectory,
    );
    if (!pathInside(evidenceDirectory, cycleRoot)) {
      throw new ResearchCycleError(
        "RESEARCH_CYCLE_STATE_PATH_UNSAFE",
        "persisted research-cycle evidence path is outside its private cycle directory",
      );
    }

    const admission = isRecord(value.admission) ? value.admission : undefined;
    if (admission) {
      if (
        typeof admission.receiptPath !== "string"
        || !pathInside(await realpathOrResolved(admission.receiptPath), cycleRoot)
      ) {
        throw new ResearchCycleError(
          "RESEARCH_CYCLE_STATE_PATH_UNSAFE",
          "persisted admission receipt path is outside its private cycle directory",
        );
      }
      if (!Array.isArray(admission.providerTraces)) {
        throw new ResearchCycleError(
          "RESEARCH_CYCLE_STATE_SHAPE_INVALID",
          "persisted admission provider traces are invalid",
        );
      }
      const trustedRoots = await Promise.all(
        [
          workspace.root,
          evidenceDirectory,
          ...this.config.trustedTraceRoots,
        ].map(realpathOrResolved),
      );
      for (const trace of admission.providerTraces) {
        if (
          !isRecord(trace)
          || typeof trace.traceRef !== "string"
          || !trace.traceRef.trim()
          || typeof trace.path !== "string"
        ) {
          throw new ResearchCycleError(
            "RESEARCH_CYCLE_STATE_SHAPE_INVALID",
            "persisted provider trace identity is invalid",
          );
        }
        const actual = await realpathOrResolved(trace.path);
        if (!trustedRoots.some((root) => pathInside(actual, root))) {
          throw new ResearchCycleError(
            "RESEARCH_CYCLE_STATE_PATH_UNSAFE",
            "persisted provider trace path is outside configured trust roots",
            { traceRef: trace.traceRef },
          );
        }
      }
    }

    const closure = isRecord(value.closure) ? value.closure : undefined;
    if (
      closure
      && closure.episodeReceiptPath !== undefined
      && (
        typeof closure.episodeReceiptPath !== "string"
        || !pathInside(
          await realpathOrResolved(closure.episodeReceiptPath),
          cycleRoot,
        )
      )
    ) {
      throw new ResearchCycleError(
        "RESEARCH_CYCLE_STATE_PATH_UNSAFE",
        "persisted episode receipt path is outside its private cycle directory",
      );
    }
    return value as unknown as ResearchCycleState;
  }

  private async writeState(
    workspace: ResearchWorkspace,
    state: ResearchCycleState,
  ): Promise<void> {
    state.updatedAt = this.now().toISOString();
    await atomicWriteJson(this.statePath(workspace), state);
  }

  async open(
    workspace: ResearchWorkspace,
    input: ResearchCycleOpenInput,
  ): Promise<Record<string, unknown>> {
    this.assertManaged(workspace);
    return await this.withLock(workspace, async () => {
      const existing = await this.readState(workspace);
      if (
        existing
        && existing.phase !== "closed"
        && input.replaceExisting !== true
      ) {
        throw new ResearchCycleError(
          "RESEARCH_CYCLE_ALREADY_ACTIVE",
          "an unfinished research cycle already exists for this workspace",
          { cycleRef: existing.cycleRef, phase: existing.phase },
        );
      }
      if (input.replaceExisting && !input.replacementReason?.trim()) {
        throw new ResearchCycleError(
          "RESEARCH_CYCLE_REPLACEMENT_REASON_REQUIRED",
          "replacing an existing cycle requires an explicit reason",
        );
      }
      if (existing && input.replaceExisting === true) {
        await atomicWriteJson(
          resolve(
            this.cycleDirectory(workspace),
            "history",
            `${canonicalDigest(existing)}.json`,
          ),
          existing,
        );
      }
      const snapshot = await gitSnapshot(workspace.root);
      if (this.config.mode === "enforce" && snapshot.dirty) {
        throw new ResearchCycleError(
          "RESEARCH_CYCLE_OPEN_REQUIRES_CLEAN_BASELINE",
          "enforced research cycles must open before source mutation on a clean baseline",
        );
      }
      const candidatePathPrefixes = normalizePathPrefixes(
        input.candidatePathPrefixes,
      );
      if (candidatePathPrefixes.length === 0) {
        throw new ResearchCycleError(
          "RESEARCH_CYCLE_SCOPE_REQUIRED",
          "at least one candidate path prefix is required",
        );
      }
      const cycleRef = `zes-research-cycle:${canonicalDigest({
        workspace: resolve(workspace.root),
        taskRef: input.taskRef,
        materialDecisionRef: input.materialDecisionRef,
        openedAt: this.now().toISOString(),
        nonce: randomUUID(),
      })}`;
      const directory = this.cycleDirectory(workspace);
      const evidenceDirectory = resolve(directory, "evidence", cycleRef.split(":").at(-1)!);
      await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 });
      const open: ResearchOpenRecord = {
        ...input,
        taskRef: requiredString(input.taskRef, "taskRef"),
        materialDecisionRef: requiredString(
          input.materialDecisionRef,
          "materialDecisionRef",
        ),
        decisionBoundaryRef: requiredString(
          input.decisionBoundaryRef,
          "decisionBoundaryRef",
        ),
        decisionQuestion: requiredString(
          input.decisionQuestion,
          "decisionQuestion",
        ),
        candidatePathPrefixes,
        researchQuestions: uniqueStrings(
          input.researchQuestions,
          "researchQuestions",
        ),
        knownLocalEvidenceRefs: uniqueStrings(
          input.knownLocalEvidenceRefs,
          "knownLocalEvidenceRefs",
        ),
        uncertainties: uniqueStrings(input.uncertainties, "uncertainties"),
        falsifier: requiredString(input.falsifier, "falsifier"),
        reopenTrigger: requiredString(input.reopenTrigger, "reopenTrigger"),
        actorRef: requiredString(input.actorRef, "actorRef"),
        replacementReason: input.replacementReason?.trim(),
        schemaVersion: OPEN_SCHEMA,
        cycleRef,
        openedAt: this.now().toISOString(),
        baseline: snapshot,
        evidenceDirectory,
      };
      const state: ResearchCycleState = {
        schemaVersion: STATE_SCHEMA,
        workspaceId: workspace.workspaceId,
        workspaceRootDigestSha256: canonicalDigest(resolve(workspace.root)),
        cycleRef,
        phase: "opened",
        generation: 0,
        open,
        invalidations: [],
        observedPaths: [],
        dependencySensitivePaths: [],
        distinctFailureDigests: [],
        validationCommandDigests: [],
        updatedAt: this.now().toISOString(),
      };
      await this.writeState(workspace, state);
      return {
        cycleRef,
        phase: state.phase,
        baseline: publicSnapshot(snapshot),
        evidenceDirectory,
        policy: researchPolicy(this.config.mode),
      };
    });
  }

  async prepare(
    workspace: ResearchWorkspace,
    input: ResearchCyclePrepareInput,
  ): Promise<Record<string, unknown>> {
    this.assertManaged(workspace);
    return await this.withLock(workspace, async () => {
      const state = await this.requireState(workspace);
      if (
        !["opened", "held", "reassessment_required", "admitted"].includes(
          state.phase,
        )
      ) {
        throw new ResearchCycleError(
          "RESEARCH_CYCLE_PREPARE_PHASE_INVALID",
          `cannot prepare research scope from phase ${state.phase}`,
        );
      }
      const snapshot = await gitSnapshot(workspace.root);
      if (snapshot.head !== state.open.baseline.head) {
        throw new ResearchCycleError(
          "RESEARCH_CYCLE_HEAD_CHANGED",
          "Git HEAD changed after the cycle opened; reopen against current authority",
        );
      }
      const pathPrefixes = normalizePathPrefixes(input.pathPrefixes);
      if (pathPrefixes.length === 0) {
        throw new ResearchCycleError(
          "RESEARCH_CYCLE_SCOPE_REQUIRED",
          "at least one path prefix is required",
        );
      }
      if (
        pathPrefixes.includes(".")
        && !input.repositoryWideScopeReason?.trim()
      ) {
        throw new ResearchCycleError(
          "RESEARCH_CYCLE_REPOSITORY_WIDE_REASON_REQUIRED",
          "repository-wide research scope requires an explicit reason",
        );
      }
      const uncovered = state.observedPaths.filter(
        (path) => !pathPrefixes.some((prefix) => pathWithinPrefix(path, prefix)),
      );
      if (uncovered.length > 0) {
        throw new ResearchCycleError(
          "RESEARCH_CYCLE_EXISTING_PATH_OUTSIDE_SCOPE",
          "the reassessed scope does not cover already observed source changes",
          { uncovered },
        );
      }
      const operationClasses = uniqueStrings(
        input.operationClasses,
        "operationClasses",
      ) as ResearchOperationClass[];
      if (operationClasses.length === 0) {
        throw new ResearchCycleError(
          "RESEARCH_CYCLE_OPERATION_CLASS_REQUIRED",
          "at least one operation class is required",
        );
      }
      const evidenceRegimeRefs = uniqueStrings(
        input.evidenceRegimeRefs,
        "evidenceRegimeRefs",
      );
      const sourceIdentityRefs = uniqueStrings(
        input.sourceIdentityRefs,
        "sourceIdentityRefs",
      );
      const shellMutationCommandDigests = uniqueStrings(
        input.shellMutationCommandDigests ?? [],
        "shellMutationCommandDigests",
      );
      const invalidCommandDigests = shellMutationCommandDigests.filter(
        (digest) => !SHA256.test(digest),
      );
      if (invalidCommandDigests.length > 0) {
        throw new ResearchCycleError(
          "RESEARCH_CYCLE_COMMAND_DIGEST_INVALID",
          "shell mutation command digests must be lowercase SHA-256 values",
          { invalidCommandDigests },
        );
      }
      if (evidenceRegimeRefs.length === 0 || sourceIdentityRefs.length === 0) {
        throw new ResearchCycleError(
          "RESEARCH_CYCLE_EVIDENCE_IDENTITY_REQUIRED",
          "evidence regime and source identity refs are required",
        );
      }
      const decisionScopeDigestSha256 = canonicalDigest({
        schemaVersion: "devspace.zes-research-decision-scope.v1",
        taskRef: state.open.taskRef,
        materialDecisionRef: state.open.materialDecisionRef,
        decisionBoundaryRef: state.open.decisionBoundaryRef,
        decisionQuestion: state.open.decisionQuestion,
      });
      const evidenceRegimeDigestSha256 = canonicalDigest({
        schemaVersion: "devspace.zes-research-evidence-regime.v1",
        refs: evidenceRegimeRefs,
      });
      const sourceIdentityDigestSha256 = canonicalDigest({
        schemaVersion: "devspace.zes-research-source-identity.v1",
        refs: sourceIdentityRefs,
      });
      const implementationBoundaryDigestSha256 = canonicalDigest({
        schemaVersion: "devspace.zes-research-implementation-boundary.v1",
        repositoryIdentityDigestSha256:
          snapshot.repositoryIdentityDigestSha256,
        head: snapshot.head,
        sourceTree: snapshot.sourceTree,
        existingWorkingContentDigestSha256:
          snapshot.workingContentDigestSha256,
        pathPrefixes,
      });
      const actionScopeDigestSha256 = canonicalDigest({
        schemaVersion: "devspace.zes-research-action-scope.v1",
        taskRef: state.open.taskRef,
        materialDecisionRef: state.open.materialDecisionRef,
        decisionBoundaryRef: state.open.decisionBoundaryRef,
        implementationBoundaryDigestSha256,
        operationClasses,
        pathPrefixes,
        shellMutationCommandDigests,
      });
      const prepared: PreparedScopeRecord = {
        ...input,
        pathPrefixes,
        operationClasses,
        evidenceRegimeRefs,
        sourceIdentityRefs,
        shellMutationCommandDigests,
        repositoryWideScopeReason: input.repositoryWideScopeReason?.trim(),
        schemaVersion: PREPARED_SCHEMA,
        generation: state.generation + 1,
        preparedAt: this.now().toISOString(),
        snapshot,
        decisionScopeDigestSha256,
        evidenceRegimeDigestSha256,
        sourceIdentityDigestSha256,
        implementationBoundaryDigestSha256,
        actionScopeDigestSha256,
      };
      state.generation = prepared.generation;
      state.prepared = prepared;
      state.admission = undefined;
      state.preCommit = undefined;
      state.commit = undefined;
      state.closure = undefined;
      state.phase = "prepared";
      await this.writeState(workspace, state);
      return {
        cycleRef: state.cycleRef,
        phase: state.phase,
        generation: state.generation,
        requestBindings: {
          task_ref: state.open.taskRef,
          material_decision_ref: state.open.materialDecisionRef,
          decision_boundary_ref: state.open.decisionBoundaryRef,
          decision_question: state.open.decisionQuestion,
          decision_scope_digest_sha256: decisionScopeDigestSha256,
          evidence_regime_digest_sha256: evidenceRegimeDigestSha256,
          source_identity_digest_sha256: sourceIdentityDigestSha256,
          implementation_boundary_digest_sha256:
            implementationBoundaryDigestSha256,
          action_scope_digest_sha256: actionScopeDigestSha256,
          owner_seeded_framing: state.open.ownerSeededFraming,
          assessing_actor_ref: state.open.actorRef,
        },
        evidenceDirectory: state.open.evidenceDirectory,
        policy: researchPolicy(this.config.mode),
      };
    });
  }

  async assess(
    workspace: ResearchWorkspace,
    request: Record<string, unknown>,
    providerTraces: ResearchProviderTraceInput[] = [],
  ): Promise<Record<string, unknown>> {
    this.assertManaged(workspace);
    return await this.withLock(workspace, async () => {
      const state = await this.requireState(workspace);
      const prepared = state.prepared;
      if (!prepared || state.phase !== "prepared") {
        throw new ResearchCycleError(
          "RESEARCH_CYCLE_SCOPE_NOT_PREPARED",
          "prepare the exact research scope before native assessment",
        );
      }
      this.assertRequestBindings(state, request);
      const traceRecords = await this.resolveProviderTraces(
        workspace,
        state,
        providerTraces,
      );
      const directory = this.cycleDirectory(workspace);
      const requestPath = resolve(
        directory,
        `admission-request-g${state.generation}.json`,
      );
      const receiptPath = resolve(
        directory,
        `admission-receipt-g${state.generation}.json`,
      );
      await atomicWriteJson(requestPath, request);
      const evaluatedAt = this.now().toISOString();
      const result = await this.invokeNative(
        "assess",
        [
          "--request",
          requestPath,
          "--output",
          receiptPath,
          "--evaluated-at",
          evaluatedAt,
          ...this.traceArgs(workspace, state, traceRecords),
        ],
      );
      if (result.exitCode !== 0) {
        state.phase = "held";
        state.admission = undefined;
        await this.writeState(workspace, state);
        throw new ResearchCycleError(
          "RESEARCH_CYCLE_NATIVE_ASSESS_FAILED",
          `ZES Research Reflex assessment failed with exit ${result.exitCode}`,
          processFailureEvidence(result),
        );
      }
      const summary = parseJsonObject(result.stdout, "Research Reflex summary");
      const receiptBytes = await readFile(receiptPath);
      const receipt = parseJsonObject(
        receiptBytes.toString("utf8"),
        "Research Reflex admission receipt",
      );
      this.assertAdmissionReceipt(state, receipt, summary);
      const admitted = summary.commit_admitted === true;
      const lease = isRecord(receipt.admission_lease)
        ? receipt.admission_lease
        : undefined;
      const admission: AdmissionRecord = {
        state: String(summary.admission_state ?? "unknown"),
        admitted,
        requestDigestSha256: String(summary.request_digest_sha256 ?? ""),
        receiptRef:
          typeof summary.receipt_ref === "string"
            ? summary.receipt_ref
            : undefined,
        receiptDigestSha256:
          typeof summary.receipt_digest_sha256 === "string"
            ? summary.receipt_digest_sha256
            : undefined,
        receiptFileSha256: createHash("sha256").update(receiptBytes).digest("hex"),
        receiptPath,
        validUntil:
          typeof lease?.valid_until === "string"
            ? lease.valid_until
            : undefined,
        providerTraces: traceRecords,
        evaluatedAt,
        causalReason:
          typeof receipt.causal_reason === "string"
            ? receipt.causal_reason
            : undefined,
      };
      state.admission = admission;
      state.phase = admitted ? "admitted" : "held";
      state.invalidations = [];
      state.distinctFailureDigests = [];
      await this.writeState(workspace, state);
      return {
        cycleRef: state.cycleRef,
        phase: state.phase,
        generation: state.generation,
        admission: publicAdmission(admission),
        nativeSummary: summary,
        policy: researchPolicy(this.config.mode),
      };
    });
  }

  async invalidate(
    workspace: ResearchWorkspace,
    kind: ResearchInvalidationKind,
    reason: string,
    evidenceRefs: string[] = [],
  ): Promise<Record<string, unknown>> {
    this.assertManaged(workspace);
    return await this.withLock(workspace, async () => {
      const state = await this.requireState(workspace);
      if (state.phase === "closed") {
        throw new ResearchCycleError(
          "RESEARCH_CYCLE_ALREADY_CLOSED",
          "a closed research cycle cannot be invalidated",
        );
      }
      state.invalidations.push({
        kind,
        reason: requiredString(reason, "invalidation reason"),
        evidenceRefs: uniqueStrings(evidenceRefs, "evidenceRefs"),
        recordedAt: this.now().toISOString(),
      });
      state.phase = "reassessment_required";
      state.preCommit = undefined;
      state.commit = undefined;
      await this.writeState(workspace, state);
      return this.publicStatus(state, true);
    });
  }

  async verifyPreCommit(
    workspace: ResearchWorkspace,
    validationRefs: string[],
    challenge: ResearchPreCommitChallenge,
  ): Promise<Record<string, unknown>> {
    this.assertManaged(workspace);
    return await this.withLock(workspace, async () => {
      const state = await this.requireState(workspace);
      if (state.phase !== "admitted") {
        throw new ResearchCycleError(
          "RESEARCH_CYCLE_NOT_ADMITTED",
          `pre-commit verification requires admitted phase, found ${state.phase}`,
        );
      }
      await this.verifyNativeAdmission(workspace, state);
      if (!challenge.localAuthorityRechecked) {
        throw new ResearchCycleError(
          "RESEARCH_CYCLE_LOCAL_AUTHORITY_NOT_RECHECKED",
          "pre-commit challenge must re-read current local authority",
        );
      }
      if (
        state.admission?.state !== "admitted_no_search"
        && !challenge.externalCurrentnessRechecked
      ) {
        throw new ResearchCycleError(
          "RESEARCH_CYCLE_EXTERNAL_CURRENTNESS_NOT_RECHECKED",
          "fresh or reused external research must be rechecked before commit",
        );
      }
      if (
        state.dependencySensitivePaths.length > 0
        && !challenge.dependencyCurrentnessRechecked
      ) {
        throw new ResearchCycleError(
          "RESEARCH_CYCLE_DEPENDENCY_CURRENTNESS_NOT_RECHECKED",
          "dependency-sensitive changes require a currentness recheck",
          { paths: state.dependencySensitivePaths },
        );
      }
      requiredString(challenge.stoppingReason, "stoppingReason");
      const normalizedValidationRefs = uniqueStrings(
        validationRefs,
        "validationRefs",
      );
      if (normalizedValidationRefs.length === 0) {
        throw new ResearchCycleError(
          "RESEARCH_CYCLE_VALIDATION_REQUIRED",
          "pre-commit verification requires exact validation refs",
        );
      }
      const snapshot = await gitSnapshot(workspace.root);
      if (snapshot.head !== state.prepared?.snapshot.head) {
        throw new ResearchCycleError(
          "RESEARCH_CYCLE_HEAD_CHANGED",
          "Git HEAD changed before pre-commit verification",
        );
      }
      const preCommit: PreCommitRecord = {
        verifiedAt: this.now().toISOString(),
        workingContentDigestSha256: snapshot.workingContentDigestSha256,
        validationRefs: normalizedValidationRefs,
        challenge: {
          ...challenge,
          assumptionsRechecked: uniqueStrings(
            challenge.assumptionsRechecked,
            "assumptionsRechecked",
          ),
          counterevidenceOrLimitations: uniqueStrings(
            challenge.counterevidenceOrLimitations,
            "counterevidenceOrLimitations",
          ),
          unresolved: uniqueStrings(challenge.unresolved, "unresolved"),
          stoppingReason: challenge.stoppingReason.trim(),
        },
      };
      state.preCommit = preCommit;
      state.phase = "pre_commit_verified";
      await this.writeState(workspace, state);
      return {
        cycleRef: state.cycleRef,
        phase: state.phase,
        workingContentDigestSha256: preCommit.workingContentDigestSha256,
        admission: publicAdmission(state.admission!),
        policy: researchPolicy(this.config.mode),
      };
    });
  }

  async close(
    workspace: ResearchWorkspace,
    input: {
      outcome: ClosureRecord["outcome"];
      reason: string;
      decisionDelta: string;
      reusableFindings: string[];
      reversalConditions: string[];
      episodePacket?: Record<string, unknown>;
    },
  ): Promise<Record<string, unknown>> {
    this.assertManaged(workspace);
    return await this.withLock(workspace, async () => {
      const state = await this.requireState(workspace);
      if (state.phase === "closed") return this.publicStatus(state, true);
      const snapshot = await gitSnapshot(workspace.root);
      if (input.outcome === "committed" && state.phase !== "committed") {
        throw new ResearchCycleError(
          "RESEARCH_CYCLE_COMMIT_NOT_OBSERVED",
          "committed closure requires an observed successful exact commit",
        );
      }
      if (
        input.outcome === "no_change"
        && snapshot.workingContentDigestSha256
          !== state.open.baseline.workingContentDigestSha256
      ) {
        throw new ResearchCycleError(
          "RESEARCH_CYCLE_NO_CHANGE_DIRTY",
          "no_change closure cannot retain uncommitted source differences",
        );
      }
      const requiresEpisode = state.admission?.state !== "admitted_no_search"
        && state.admission?.admitted === true;
      if (requiresEpisode && !input.episodePacket) {
        throw new ResearchCycleError(
          "RESEARCH_CYCLE_EPISODE_REQUIRED",
          "fresh or reused research must close with a native Research Reflex episode packet",
        );
      }
      let episodeSummary: Record<string, unknown> | undefined;
      let episodeReceiptPath: string | undefined;
      let episodeReceiptFileSha256: string | undefined;
      if (input.episodePacket) {
        this.assertEpisodePacket(state, input.episodePacket);
        const directory = this.cycleDirectory(workspace);
        const packetPath = resolve(
          directory,
          `episode-packet-g${state.generation}.json`,
        );
        episodeReceiptPath = resolve(
          directory,
          `episode-receipt-g${state.generation}.json`,
        );
        await atomicWriteJson(packetPath, input.episodePacket);
        const result = await this.invokeNative(
          "compile",
          [
            "--request",
            packetPath,
            "--output",
            episodeReceiptPath,
            "--compiled-at",
            this.now().toISOString(),
          ],
        );
        if (result.exitCode !== 0) {
          throw new ResearchCycleError(
            "RESEARCH_CYCLE_EPISODE_COMPILE_FAILED",
            `Research Reflex episode compile failed with exit ${result.exitCode}`,
            processFailureEvidence(result),
          );
        }
        episodeSummary = parseJsonObject(
          result.stdout,
          "Research Reflex episode summary",
        );
        episodeReceiptFileSha256 = await sha256File(episodeReceiptPath);
      }
      const closure: ClosureRecord = {
        outcome: input.outcome,
        reason: requiredString(input.reason, "closure reason"),
        decisionDelta: requiredString(input.decisionDelta, "decisionDelta"),
        reusableFindings: uniqueStrings(
          input.reusableFindings,
          "reusableFindings",
        ),
        reversalConditions: uniqueStrings(
          input.reversalConditions,
          "reversalConditions",
        ),
        closedAt: this.now().toISOString(),
        closedHead: snapshot.head,
        episodeReceiptRef:
          typeof episodeSummary?.episode_ref === "string"
            ? episodeSummary.episode_ref
            : undefined,
        episodeReceiptDigestSha256:
          typeof episodeSummary?.episode_digest_sha256 === "string"
            ? episodeSummary.episode_digest_sha256
            : undefined,
        episodeReceiptFileSha256,
        episodeReceiptPath,
      };
      state.closure = closure;
      state.phase = "closed";
      await this.writeState(workspace, state);
      return {
        ...this.publicStatus(state, true),
        episodeSummary,
      };
    });
  }

  async status(workspace: ResearchWorkspace): Promise<Record<string, unknown>> {
    if (!this.manages(workspace)) {
      return {
        managed: false,
        mode: this.config.mode,
        reason: this.enabled
          ? "workspace_missing_ZES_research_marker"
          : "research_cycle_disabled",
        policy: researchPolicy(this.config.mode),
      };
    }
    const state = await this.readState(workspace);
    return state
      ? this.publicStatus(state, true)
      : {
          managed: true,
          mode: this.config.mode,
          stateExists: false,
          policy: researchPolicy(this.config.mode),
        };
  }

  async providerEvidenceContext(
    workspace: ResearchWorkspace,
  ): Promise<ResearchProviderEvidenceContext> {
    this.assertManaged(workspace);
    return await this.withLock(workspace, async () => {
      const state = await this.requireState(workspace);
      if (state.phase !== "prepared" || !state.prepared) {
        throw new ResearchCycleError(
          "RESEARCH_CYCLE_PROVIDER_SCOPE_NOT_PREPARED",
          `provider acquisition requires prepared phase, found ${state.phase}`,
        );
      }
      return {
        cycleRef: state.cycleRef,
        generation: state.generation,
        phase: "prepared",
        evidenceDirectory: state.open.evidenceDirectory,
        ownerSeededFraming: state.open.ownerSeededFraming,
        taskRef: state.open.taskRef,
        materialDecisionRef: state.open.materialDecisionRef,
        decisionBoundaryRef: state.open.decisionBoundaryRef,
      };
    });
  }

  async guardPatch(
    workspace: ResearchWorkspace,
    patch: string,
  ): Promise<ResearchGuardDecision> {
    return await this.guardPaths(workspace, extractPatchPaths(patch));
  }

  async guardPaths(
    workspace: ResearchWorkspace,
    rawPaths: string[],
  ): Promise<ResearchGuardDecision> {
    if (!this.manages(workspace)) return unmanagedDecision(this.config.mode);
    const paths = uniqueStrings(
      rawPaths.map((path) => normalizeRelativePath(path, "mutation path")),
      "mutationPaths",
    );
    if (paths.length === 0) {
      throw new ResearchCycleError(
        "RESEARCH_CYCLE_MUTATION_PATHS_REQUIRED",
        "at least one exact mutation path is required",
      );
    }
    const state = await this.readState(workspace);
    const reasons = await this.activeMutationReasons(workspace, state, paths);
    if (!state?.prepared?.operationClasses.includes("source_mutation")) {
      reasons.push("source_mutation_not_in_action_scope");
    }
    if (
      paths.some(dependencySensitive)
      && !state?.prepared?.operationClasses.includes("dependency_change")
    ) {
      reasons.push("dependency_change_not_in_action_scope");
    }
    return this.guardDecision(
      state,
      "apply_patch",
      uniqueStrings(reasons, "reasons"),
    );
  }

  async observePatch(
    workspace: ResearchWorkspace,
    patch: string,
  ): Promise<void> {
    await this.observePaths(workspace, extractPatchPaths(patch));
  }

  async observePaths(
    workspace: ResearchWorkspace,
    rawPaths: string[],
  ): Promise<void> {
    if (!this.manages(workspace)) return;
    await this.withLock(workspace, async () => {
      const state = await this.readState(workspace);
      if (!state) return;
      const paths = uniqueStrings(
        rawPaths.map((path) => normalizeRelativePath(path, "mutation path")),
        "mutationPaths",
      );
      if (paths.length === 0) return;
      state.observedPaths = uniqueStrings(
        [...state.observedPaths, ...paths],
        "observedPaths",
      );
      state.dependencySensitivePaths = uniqueStrings(
        [
          ...state.dependencySensitivePaths,
          ...paths.filter(dependencySensitive),
        ],
        "dependencySensitivePaths",
      );
      const prefixes = state.prepared?.pathPrefixes ?? [];
      const uncovered = paths.filter(
        (path) => !prefixes.some((prefix) => pathWithinPrefix(path, prefix)),
      );
      const dependencyOutsideClass = paths.filter(
        (path) => dependencySensitive(path)
          && !state.prepared?.operationClasses.includes("dependency_change"),
      );
      if (
        state.phase !== "closed"
        && state.prepared
        && (uncovered.length > 0 || dependencyOutsideClass.length > 0)
      ) {
        state.phase = "reassessment_required";
        state.preCommit = undefined;
        state.commit = undefined;
        state.invalidations.push({
          kind: dependencyOutsideClass.length > 0
            ? "dependency_or_upstream_change"
            : "scope_drift",
          reason: dependencyOutsideClass.length > 0
            ? "a direct file mutation changed a dependency-sensitive path outside the admitted operation classes"
            : "a direct file mutation changed a path outside the admitted implementation boundary",
          evidenceRefs: uniqueStrings(
            [...uncovered, ...dependencyOutsideClass],
            "scopeDriftPaths",
          ),
          recordedAt: this.now().toISOString(),
        });
      }
      await this.writeState(workspace, state);
    });
  }

  async guardCommand(
    workspace: ResearchWorkspace,
    command: string,
  ): Promise<ResearchGuardDecision> {
    if (!this.manages(workspace)) return unmanagedDecision(this.config.mode);
    const classification = classifyResearchCommand(command);
    const state = await this.readState(workspace);
    let reasons: string[] = [];
    if (
      classification === "inspection"
      || classification === "research_control"
      || classification === "validation"
    ) {
      reasons = [];
    } else if (classification === "runtime_effect") {
      reasons = ["research_admission_never_grants_runtime_or_effect_authority"];
    } else if (classification === "repository_commit") {
      reasons = await this.commitReasons(workspace, state);
    } else if (classification === "repository_publish") {
      reasons = await this.publishReasons(workspace, state);
    } else if (classification === "commit_prepare") {
      reasons = await this.activeMutationReasons(workspace, state, []);
      if (!state?.prepared?.operationClasses.includes("repository_commit")) {
        reasons.push("repository_commit_not_in_action_scope");
      }
    } else {
      reasons = await this.activeMutationReasons(workspace, state, []);
      if (!state?.prepared?.operationClasses.includes("source_mutation")) {
        reasons.push("source_mutation_not_in_action_scope");
      }
      const digest = researchCommandDigest(command);
      if (!state?.prepared?.shellMutationCommandDigests?.includes(digest)) {
        reasons.push(`shell_mutation_command_not_in_action_scope:${digest}`);
      }
      if (
        commandChangesDependencies(command)
        && !state?.prepared?.operationClasses.includes("dependency_change")
      ) {
        reasons.push("dependency_change_not_in_action_scope");
      }
    }
    return this.guardDecision(state, classification, uniqueStrings(reasons, "reasons"));
  }

  async observeCommandSnapshot(
    workspace: ResearchWorkspace,
    command: string,
    snapshot: { sessionId?: number; running: boolean; exitCode?: number },
  ): Promise<void> {
    if (!this.manages(workspace)) return;
    const classification = classifyResearchCommand(command);
    if (snapshot.running && snapshot.sessionId !== undefined) {
      this.pendingCommands.set(snapshot.sessionId, {
        workspace,
        command,
        classification,
      });
      return;
    }
    await this.observeTerminalCommand(
      workspace,
      command,
      classification,
      snapshot.exitCode,
    );
  }

  async guardProcessInput(
    workspace: ResearchWorkspace,
    sessionId: number,
  ): Promise<ResearchGuardDecision> {
    if (!this.manages(workspace)) return unmanagedDecision(this.config.mode);
    const pending = this.pendingCommands.get(sessionId);
    if (
      !pending
      || pending.workspace.workspaceId !== workspace.workspaceId
      || resolve(pending.workspace.root) !== resolve(workspace.root)
    ) {
      const state = await this.readState(workspace);
      return this.guardDecision(
        state,
        "unknown",
        ["research_process_binding_missing"],
      );
    }
    return await this.guardCommand(workspace, pending.command);
  }

  async observeProcessSnapshot(
    workspace: ResearchWorkspace,
    sessionId: number,
    snapshot: { running: boolean; exitCode?: number },
  ): Promise<void> {
    if (snapshot.running) return;
    const pending = this.pendingCommands.get(sessionId);
    if (!pending) return;
    this.pendingCommands.delete(sessionId);
    await this.observeTerminalCommand(
      workspace,
      pending.command,
      pending.classification,
      snapshot.exitCode,
    );
  }

  private async observeTerminalCommand(
    workspace: ResearchWorkspace,
    command: string,
    classification: ResearchCommandClass,
    exitCode: number | undefined,
  ): Promise<void> {
    await this.withLock(workspace, async () => {
      const state = await this.readState(workspace);
      if (!state || state.phase === "closed") return;
      const commandDigest = canonicalDigest({ classification, command });
      if (exitCode !== 0 && exitCode !== undefined) {
        state.distinctFailureDigests = uniqueStrings(
          [...state.distinctFailureDigests, commandDigest],
          "distinctFailureDigests",
        );
        if (state.distinctFailureDigests.length >= 2) {
          state.invalidations.push({
            kind: "repeated_distinct_failure",
            reason:
              "two distinct command failures were observed after the last admission",
            evidenceRefs: state.distinctFailureDigests,
            recordedAt: this.now().toISOString(),
          });
          state.phase = "reassessment_required";
          state.preCommit = undefined;
        }
      } else if (classification === "validation") {
        state.validationCommandDigests = uniqueStrings(
          [...state.validationCommandDigests, commandDigest],
          "validationCommandDigests",
        );
      }
      if (
        exitCode === 0
        && (classification === "source_mutation"
          || classification === "commit_prepare"
          || classification === "unknown")
      ) {
        const changedPaths = await currentChangedPaths(workspace.root);
        state.observedPaths = uniqueStrings(
          [...state.observedPaths, ...changedPaths],
          "observedPaths",
        );
        state.dependencySensitivePaths = uniqueStrings(
          [
            ...state.dependencySensitivePaths,
            ...changedPaths.filter(dependencySensitive),
          ],
          "dependencySensitivePaths",
        );
        const prefixes = state.prepared?.pathPrefixes ?? [];
        const uncovered = changedPaths.filter(
          (path) => !prefixes.some((prefix) => pathWithinPrefix(path, prefix)),
        );
        const dependencyOutsideClass = changedPaths.filter(
          (path) => dependencySensitive(path)
            && !state.prepared?.operationClasses.includes("dependency_change"),
        );
        if (uncovered.length > 0 || dependencyOutsideClass.length > 0) {
          state.phase = "reassessment_required";
          state.preCommit = undefined;
          state.invalidations.push({
            kind: dependencyOutsideClass.length > 0
              ? "dependency_or_upstream_change"
              : "scope_drift",
            reason: dependencyOutsideClass.length > 0
              ? "a dependency-sensitive path changed outside the admitted operation classes"
              : "a shell mutation changed paths outside the admitted implementation boundary",
            evidenceRefs: uniqueStrings(
              [...uncovered, ...dependencyOutsideClass],
              "scopeDriftPaths",
            ),
            recordedAt: this.now().toISOString(),
          });
        }
      }
      if (exitCode === 0 && classification === "repository_commit") {
        const snapshot = await gitSnapshot(workspace.root);
        const preCommit = state.preCommit;
        if (!preCommit || state.phase !== "pre_commit_verified") {
          state.phase = "reassessment_required";
          state.invalidations.push({
            kind: "scope_drift",
            reason: "a commit completed without the current pre-commit checkpoint",
            evidenceRefs: [commandDigest],
            recordedAt: this.now().toISOString(),
          });
        } else if (snapshot.dirty) {
          state.phase = "reassessment_required";
          state.invalidations.push({
            kind: "scope_drift",
            reason: "the successful commit did not contain the complete verified change set",
            evidenceRefs: [snapshot.workingContentDigestSha256],
            recordedAt: this.now().toISOString(),
          });
        } else {
          state.commit = {
            committedAt: this.now().toISOString(),
            headBefore: state.prepared!.snapshot.head,
            headAfter: snapshot.head,
            sourceTreeAfter: snapshot.sourceTree,
            commandDigestSha256: commandDigest,
          };
          state.phase = "committed";
        }
      }
      await this.writeState(workspace, state);
    });
  }

  private async activeMutationReasons(
    workspace: ResearchWorkspace,
    state: ResearchCycleState | undefined,
    paths: string[],
  ): Promise<string[]> {
    if (!state) return ["research_cycle_not_opened"];
    if (state.phase !== "admitted") {
      return [`research_cycle_phase_${state.phase}`];
    }
    const reasons = await this.admissionReasons(workspace, state);
    const prefixes = state.prepared?.pathPrefixes ?? [];
    for (const path of paths) {
      if (!prefixes.some((prefix) => pathWithinPrefix(path, prefix))) {
        reasons.push(`path_outside_research_action_scope:${path}`);
      }
    }
    return reasons;
  }

  private async admissionReasons(
    workspace: ResearchWorkspace,
    state: ResearchCycleState,
  ): Promise<string[]> {
    const admission = state.admission;
    const prepared = state.prepared;
    if (!admission?.admitted || !prepared) return ["research_admission_missing_or_held"];
    const reasons: string[] = [];
    if (!admission.validUntil || Date.parse(admission.validUntil) <= this.now().getTime()) {
      reasons.push("research_admission_lease_expired");
    }
    try {
      if (await sha256File(admission.receiptPath) !== admission.receiptFileSha256) {
        reasons.push("research_admission_receipt_file_changed");
      }
    } catch {
      reasons.push("research_admission_receipt_missing");
    }
    const snapshot = await gitSnapshot(workspace.root);
    if (snapshot.head !== prepared.snapshot.head) {
      reasons.push("research_action_head_mismatch");
    }
    return reasons;
  }

  private async commitReasons(
    workspace: ResearchWorkspace,
    state: ResearchCycleState | undefined,
  ): Promise<string[]> {
    if (!state) return ["research_cycle_not_opened"];
    const reasons = await this.admissionReasons(workspace, state);
    if (state.phase !== "pre_commit_verified" || !state.preCommit) {
      reasons.push(`research_cycle_phase_${state.phase}`);
      return reasons;
    }
    if (!state.prepared?.operationClasses.includes("repository_commit")) {
      reasons.push("repository_commit_not_in_action_scope");
    }
    const snapshot = await gitSnapshot(workspace.root);
    if (
      snapshot.workingContentDigestSha256
      !== state.preCommit.workingContentDigestSha256
    ) reasons.push("working_content_changed_after_pre_commit_verification");
    return reasons;
  }

  private async publishReasons(
    workspace: ResearchWorkspace,
    state: ResearchCycleState | undefined,
  ): Promise<string[]> {
    if (!state) return ["research_cycle_not_opened"];
    const reasons: string[] = [];
    if (state.phase !== "closed" || state.closure?.outcome !== "committed") {
      reasons.push(`research_cycle_phase_${state.phase}`);
    }
    if (!state.prepared?.operationClasses.includes("repository_publish")) {
      reasons.push("repository_publish_not_in_action_scope");
    }
    const snapshot = await gitSnapshot(workspace.root);
    if (!state.commit || snapshot.head !== state.commit.headAfter) {
      reasons.push("publish_head_does_not_match_closed_commit");
    }
    if (snapshot.dirty) reasons.push("publish_workspace_not_clean");
    return reasons;
  }

  private guardDecision(
    state: ResearchCycleState | undefined,
    classification: ResearchGuardDecision["classification"],
    reasons: string[],
  ): ResearchGuardDecision {
    const advisoryOnly = this.config.mode === "observe";
    return {
      managed: true,
      mode: this.config.mode,
      allowed: advisoryOnly || reasons.length === 0,
      classification,
      reasons,
      cycleRef: state?.cycleRef,
      phase: state?.phase,
      advisoryOnly,
    };
  }

  private async requireState(
    workspace: ResearchWorkspace,
  ): Promise<ResearchCycleState> {
    const state = await this.readState(workspace);
    if (!state) {
      throw new ResearchCycleError(
        "RESEARCH_CYCLE_NOT_OPENED",
        "open a research cycle before this operation",
      );
    }
    return state;
  }

  private assertRequestBindings(
    state: ResearchCycleState,
    request: Record<string, unknown>,
  ): void {
    const prepared = state.prepared!;
    if (request.schema_version !== ADMISSION_REQUEST_SCHEMA) {
      throw new ResearchCycleError(
        "RESEARCH_CYCLE_V3_ADMISSION_REQUIRED",
        "the DevSpace action gate requires a capability-bound Research Reflex v3 request",
      );
    }
    const comparisons: Array<[string, unknown, unknown]> = [
      ["task_ref", request.task_ref, state.open.taskRef],
      ["material_decision_ref", request.material_decision_ref, state.open.materialDecisionRef],
      ["decision_boundary_ref", request.decision_boundary_ref, state.open.decisionBoundaryRef],
      ["decision_question", request.decision_question, state.open.decisionQuestion],
      ["decision_scope_digest_sha256", request.decision_scope_digest_sha256, prepared.decisionScopeDigestSha256],
      ["evidence_regime_digest_sha256", request.evidence_regime_digest_sha256, prepared.evidenceRegimeDigestSha256],
      ["source_identity_digest_sha256", request.source_identity_digest_sha256, prepared.sourceIdentityDigestSha256],
      ["implementation_boundary_digest_sha256", request.implementation_boundary_digest_sha256, prepared.implementationBoundaryDigestSha256],
      ["action_scope_digest_sha256", request.action_scope_digest_sha256, prepared.actionScopeDigestSha256],
      ["owner_seeded_framing", request.owner_seeded_framing, state.open.ownerSeededFraming],
      ["assessing_actor_ref", request.assessing_actor_ref, state.open.actorRef],
    ];
    const mismatches = comparisons
      .filter(([, observed, expected]) => observed !== expected)
      .map(([label]) => label);
    if (mismatches.length > 0) {
      throw new ResearchCycleError(
        "RESEARCH_CYCLE_REQUEST_BINDING_MISMATCH",
        "the Research Reflex request does not match the prepared workspace action scope",
        { mismatches },
      );
    }
  }

  private assertAdmissionReceipt(
    state: ResearchCycleState,
    receipt: Record<string, unknown>,
    summary: Record<string, unknown>,
  ): void {
    if (receipt.schema_version !== ADMISSION_RECEIPT_SCHEMA) {
      throw new ResearchCycleError(
        "RESEARCH_CYCLE_RECEIPT_SCHEMA_UNSUPPORTED",
        `unsupported admission receipt schema: ${String(receipt.schema_version)}`,
      );
    }
    if (!isRecord(receipt.request)) {
      throw new ResearchCycleError(
        "RESEARCH_CYCLE_RECEIPT_REQUEST_MISSING",
        "the admission receipt contains no request",
      );
    }
    this.assertRequestBindings(state, receipt.request);
    if (summary.commit_admitted !== receipt.commit_admitted) {
      throw new ResearchCycleError(
        "RESEARCH_CYCLE_RECEIPT_SUMMARY_MISMATCH",
        "the native summary and admission receipt disagree",
      );
    }
    for (const field of ["request_digest_sha256", "receipt_digest_sha256"] as const) {
      const value = summary[field];
      if (typeof value !== "string" || !SHA256.test(value)) {
        throw new ResearchCycleError(
          "RESEARCH_CYCLE_NATIVE_DIGEST_MISSING",
          `the native summary lacks ${field}`,
        );
      }
    }
  }

  private assertEpisodePacket(
    state: ResearchCycleState,
    packet: Record<string, unknown>,
  ): void {
    if (!EPISODE_PACKET_SCHEMAS.has(String(packet.schema_version))) {
      throw new ResearchCycleError(
        "RESEARCH_CYCLE_EPISODE_SCHEMA_UNSUPPORTED",
        `unsupported episode packet schema: ${String(packet.schema_version)}`,
      );
    }
    const assessment = isRecord(packet.need_assessment)
      ? packet.need_assessment
      : undefined;
    if (
      assessment?.task_ref !== state.open.taskRef
      || assessment.material_decision_ref !== state.open.materialDecisionRef
    ) {
      throw new ResearchCycleError(
        "RESEARCH_CYCLE_EPISODE_SCOPE_MISMATCH",
        "the episode packet does not match this task and material decision",
      );
    }
  }

  private async resolveProviderTraces(
    workspace: ResearchWorkspace,
    state: ResearchCycleState,
    traces: ResearchProviderTraceInput[],
  ): Promise<ProviderTraceRecord[]> {
    const trustedRoots = [
      workspace.root,
      state.open.evidenceDirectory,
      ...this.config.trustedTraceRoots,
    ];
    const resolvedTrustedRoots = await Promise.all(
      trustedRoots.map(async (root) => {
        try {
          return await realpath(root);
        } catch {
          return resolve(root);
        }
      }),
    );
    const records: ProviderTraceRecord[] = [];
    for (const trace of traces) {
      const traceRef = requiredString(trace.traceRef, "traceRef");
      const candidate = isAbsolute(trace.path)
        ? resolve(trace.path)
        : resolve(workspace.root, trace.path);
      let actual: string;
      try {
        actual = await realpath(candidate);
      } catch {
        throw new ResearchCycleError(
          "RESEARCH_CYCLE_PROVIDER_TRACE_MISSING",
          `provider trace is missing: ${traceRef}`,
        );
      }
      if (!resolvedTrustedRoots.some((root) => pathInside(actual, root))) {
        throw new ResearchCycleError(
          "RESEARCH_CYCLE_PROVIDER_TRACE_OUTSIDE_TRUST_ROOT",
          `provider trace is outside configured trust roots: ${traceRef}`,
        );
      }
      records.push({ traceRef, path: actual });
    }
    const refs = records.map((record) => record.traceRef);
    if (new Set(refs).size !== refs.length) {
      throw new ResearchCycleError(
        "RESEARCH_CYCLE_PROVIDER_TRACE_DUPLICATE",
        "provider trace refs must be unique",
      );
    }
    return records.sort((left, right) => left.traceRef.localeCompare(right.traceRef));
  }

  private traceArgs(
    workspace: ResearchWorkspace,
    state: ResearchCycleState,
    traces: ProviderTraceRecord[],
  ): string[] {
    const roots = uniqueStrings(
      [
        resolve(workspace.root),
        resolve(state.open.evidenceDirectory),
        ...this.config.trustedTraceRoots.map((root) => resolve(root)),
      ],
      "trustedTraceRoots",
    );
    return [
      ...traces.flatMap((trace) => [
        "--provider-trace",
        `${trace.traceRef}=${trace.path}`,
      ]),
      ...roots.flatMap((root) => ["--trusted-trace-root", root]),
    ];
  }

  private async verifyNativeAdmission(
    workspace: ResearchWorkspace,
    state: ResearchCycleState,
  ): Promise<Record<string, unknown>> {
    const admission = state.admission;
    if (!admission) {
      throw new ResearchCycleError(
        "RESEARCH_CYCLE_ADMISSION_MISSING",
        "no native admission receipt exists",
      );
    }
    if (await sha256File(admission.receiptPath) !== admission.receiptFileSha256) {
      throw new ResearchCycleError(
        "RESEARCH_CYCLE_ADMISSION_RECEIPT_CHANGED",
        "the stored admission receipt changed after assessment",
      );
    }
    const result = await this.invokeNative(
      "verify-admission",
      [
        "--receipt",
        admission.receiptPath,
        ...this.traceArgs(workspace, state, admission.providerTraces),
      ],
    );
    if (result.exitCode !== 0) {
      throw new ResearchCycleError(
        "RESEARCH_CYCLE_NATIVE_VERIFY_FAILED",
        `Research Reflex admission verification failed with exit ${result.exitCode}`,
        processFailureEvidence(result),
      );
    }
    const summary = parseJsonObject(
      result.stdout,
      "Research Reflex verification summary",
    );
    if (
      summary.request_digest_sha256 !== admission.requestDigestSha256
      || summary.receipt_digest_sha256 !== admission.receiptDigestSha256
      || summary.commit_admitted !== admission.admitted
    ) {
      throw new ResearchCycleError(
        "RESEARCH_CYCLE_NATIVE_VERIFY_IDENTITY_MISMATCH",
        "the current native verification does not match the stored admission",
      );
    }
    return summary;
  }

  private async invokeNative(
    operation: ResearchNativeInvocation["operation"],
    args: string[],
  ): Promise<ResearchNativeResult> {
    return await this.nativeRunner({
      operation,
      args,
      cwd: this.config.repositoryRoot,
      timeoutMs: this.config.timeoutMs,
    });
  }

  private publicStatus(
    state: ResearchCycleState,
    stateExists: boolean,
  ): Record<string, unknown> {
    return {
      managed: true,
      mode: this.config.mode,
      stateExists,
      cycleRef: state.cycleRef,
      phase: state.phase,
      generation: state.generation,
      taskRef: state.open.taskRef,
      materialDecisionRef: state.open.materialDecisionRef,
      decisionBoundaryRef: state.open.decisionBoundaryRef,
      candidatePathPrefixes: state.open.candidatePathPrefixes,
      prepared: state.prepared
        ? {
            pathPrefixes: state.prepared.pathPrefixes,
            operationClasses: state.prepared.operationClasses,
            shellMutationCommandDigests:
              state.prepared.shellMutationCommandDigests ?? [],
            requestBindings: {
              decision_scope_digest_sha256:
                state.prepared.decisionScopeDigestSha256,
              evidence_regime_digest_sha256:
                state.prepared.evidenceRegimeDigestSha256,
              source_identity_digest_sha256:
                state.prepared.sourceIdentityDigestSha256,
              implementation_boundary_digest_sha256:
                state.prepared.implementationBoundaryDigestSha256,
              action_scope_digest_sha256:
                state.prepared.actionScopeDigestSha256,
            },
          }
        : undefined,
      admission: state.admission ? publicAdmission(state.admission) : undefined,
      invalidations: state.invalidations,
      observedPaths: state.observedPaths,
      dependencySensitivePaths: state.dependencySensitivePaths,
      distinctFailureCount: state.distinctFailureDigests.length,
      preCommit: state.preCommit
        ? {
            verifiedAt: state.preCommit.verifiedAt,
            workingContentDigestSha256:
              state.preCommit.workingContentDigestSha256,
            validationRefs: state.preCommit.validationRefs,
          }
        : undefined,
      commit: state.commit,
      closure: state.closure
        ? {
            outcome: state.closure.outcome,
            reason: state.closure.reason,
            decisionDelta: state.closure.decisionDelta,
            reusableFindings: state.closure.reusableFindings,
            reversalConditions: state.closure.reversalConditions,
            closedAt: state.closure.closedAt,
            closedHead: state.closure.closedHead,
            episodeReceiptRef: state.closure.episodeReceiptRef,
            episodeReceiptDigestSha256:
              state.closure.episodeReceiptDigestSha256,
          }
        : undefined,
      updatedAt: state.updatedAt,
      policy: researchPolicy(this.config.mode),
    };
  }
}

function publicSnapshot(snapshot: GitSnapshot): Record<string, unknown> {
  return {
    head: snapshot.head,
    sourceTree: snapshot.sourceTree,
    branch: snapshot.branch,
    repositoryIdentityDigestSha256:
      snapshot.repositoryIdentityDigestSha256,
    workingContentDigestSha256: snapshot.workingContentDigestSha256,
    dirty: snapshot.dirty,
  };
}

function publicAdmission(admission: AdmissionRecord): Record<string, unknown> {
  return {
    state: admission.state,
    admitted: admission.admitted,
    requestDigestSha256: admission.requestDigestSha256,
    receiptRef: admission.receiptRef,
    receiptDigestSha256: admission.receiptDigestSha256,
    validUntil: admission.validUntil,
    evaluatedAt: admission.evaluatedAt,
    causalReason: admission.causalReason,
    providerTraceRefs: admission.providerTraces.map((trace) => trace.traceRef),
  };
}

function researchPolicy(
  mode: ZesResearchCycleConfig["mode"],
): Record<string, unknown> {
  return {
    authority:
      "executor_local_lifecycle_and_native_receipt_verification_only",
    mode,
    semanticJudgmentAuthority: false,
    researchSufficiencyAuthority: false,
    sourceTruthAuthority: false,
    writerAuthority: false,
    publicationAuthority: false,
    runtimeOrEffectAuthority: false,
    nativeApplicationPort: "port.zes-research-reflex",
    providerOutputTreatedAsUntrustedEvidence: true,
    localJudgmentRemainsRequired: true,
  };
}

function unmanagedDecision(
  mode: ZesResearchCycleConfig["mode"],
): ResearchGuardDecision {
  return {
    managed: false,
    mode,
    allowed: true,
    reasons: [],
    advisoryOnly: mode !== "enforce",
  };
}
