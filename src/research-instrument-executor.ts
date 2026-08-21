import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type { ZesResearchInstrumentExecutionConfig } from "./config.js";
import {
  canonicalDigest,
  ResearchCycleError,
  type ResearchInstrumentCycleContext,
  type ResearchWorkspace,
  ZesResearchCycleManager,
} from "./research-cycle.js";
import {
  type ResearchInstrumentExecutionTarget,
  ZesResearchInstrumentManager,
} from "./research-instruments.js";

const EXECUTION_STATE_SCHEMA =
  "devspace.zes-research-instrument-execution-state.v1";
const EXECUTION_RECORD_SCHEMA =
  "devspace.zes-research-instrument-execution.v1";
const EXECUTION_MANIFEST_SCHEMA =
  "devspace.zes-research-instrument-execution-manifest.v1";
const MAX_EXECUTIONS = 500;
const MAX_RUNNER_RECEIPT_BYTES = 4 * 1024 * 1024;
const MAX_LAB_ARTIFACT_BYTES = 64 * 1024 * 1024;
const LOCK_WAIT_MS = 25;
const LOCK_WAIT_ATTEMPTS = 240;
const STALE_LOCK_MS = 10 * 60 * 1_000;
const INSPECT_TASK_PATTERN =
  /^experiments\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.py@[A-Za-z_][A-Za-z0-9_]*$/u;
const PROFILE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/u;
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u;
const EXECUTION_REF_PATTERN = /^research-instrument-execution:[a-f0-9]{64}$/u;
const EXECUTABLE_INSTRUMENT_KINDS = new Set([
  "agent_behavior_eval",
  "bounded_counterfactual",
]);
const EXECUTOR_RUNTIME_REF = `devspace-process:${canonicalDigest({
  pid: process.pid,
  timeOrigin: performance.timeOrigin,
})}`;
const execFileAsync = promisify(execFile);

export interface ResearchInstrumentExecuteInput {
  idempotencyKey: string;
  planRef: string;
  stepRef: string;
  adapter: "inspect_ai";
  task: string;
  profile?: string;
  limit?: number;
  allowRestrictedProfile?: boolean;
  basisExecutionRefs?: string[];
}

type ResearchInstrumentExecutionStatus =
  | "dispatching"
  | "running"
  | "succeeded"
  | "failed"
  | "indeterminate";

interface ResearchInstrumentExecutionArtifact {
  path: string;
  role: "trace" | "log" | "result" | "receipt";
  mediaType: string;
  byteCount: number;
  sha256: string;
}

interface ResearchInstrumentExecutionRecord {
  schemaVersion: typeof EXECUTION_RECORD_SCHEMA;
  executionRef: string;
  idempotencyKeyDigestSha256: string;
  inputDigestSha256: string;
  cycleRef: string;
  generation: number;
  planRef: string;
  stepRef: string;
  instrumentKind: ResearchInstrumentExecutionTarget["instrumentKind"];
  evidenceNeedKind: ResearchInstrumentExecutionTarget["evidenceNeedKind"];
  capabilityRef: string;
  claimCeiling: string;
  adapter: "inspect_ai";
  task: string;
  requestedProfile: string;
  budgetClass: "routine" | "adjudication" | "frontier";
  basisExecutionRefs: string[];
  limit: number;
  allowRestrictedProfile: boolean;
  status: ResearchInstrumentExecutionStatus;
  executorRuntimeRef: string;
  pid?: number;
  artifactDirectory: string;
  runnerReceiptPath: string;
  runnerStderrPath: string;
  manifestPath: string;
  artifacts: ResearchInstrumentExecutionArtifact[];
  runnerStatus?: string;
  runnerReturncode?: number;
  runnerSchemaVersion?: string;
  effectiveProfile?: Record<string, unknown>;
  sharedPolicyDigestSha256?: string;
  runnerPolicyDigestSha256?: string;
  runnerProfileName?: string;
  remoteInferenceAttempted?: boolean;
  terminalReason?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  updatedAt: string;
}

interface ResearchInstrumentExecutionState {
  schemaVersion: typeof EXECUTION_STATE_SCHEMA;
  cycleRef: string;
  workspaceRootDigestSha256: string;
  executions: ResearchInstrumentExecutionRecord[];
  updatedAt: string;
}

interface LaunchProcessInput {
  executable: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdoutPath: string;
  stderrPath: string;
}

interface ReadLabStatusInput {
  executable: string;
  runnerPath: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

interface SharedLabProfilePolicy {
  name: string;
  budgetClass: "routine" | "adjudication" | "frontier";
  explicitOnly: boolean;
}

interface SharedLabPolicySnapshot {
  digestSha256: string;
  defaultEvalProfile: string;
  adjudicationFractionCeiling: number;
  frontierFractionCeiling: number;
  frontierMinimumNonFrontierSamples: number;
  frontierRequiresAdjudicationBasis: boolean;
  profiles: Map<string, SharedLabProfilePolicy>;
  rawStatus: Record<string, unknown>;
}

interface ResearchInstrumentExecutorOptions {
  now?: () => Date;
  runtimeRef?: string;
  launchProcess?: (input: LaunchProcessInput) => Promise<{ pid: number }>;
  processAlive?: (pid: number) => boolean;
  readLabStatus?: (
    input: ReadLabStatusInput,
  ) => Promise<Record<string, unknown>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new ResearchCycleError(
      "RESEARCH_INSTRUMENT_EXECUTION_IDENTITY_REQUIRED",
      `${label} is required`,
    );
  }
  return normalized;
}

function keyDigest(value: string): string {
  const normalized = requiredString(value, "idempotencyKey");
  if (!IDEMPOTENCY_PATTERN.test(normalized)) {
    throw new ResearchCycleError(
      "RESEARCH_INSTRUMENT_EXECUTION_IDEMPOTENCY_INVALID",
      "idempotencyKey must use the bounded portable identity syntax",
    );
  }
  return createHash("sha256").update(normalized).digest("hex");
}

function normalizeInspectTask(value: string): string {
  const normalized = requiredString(value, "task").replaceAll("\\", "/");
  if (
    !INSPECT_TASK_PATTERN.test(normalized)
    || normalized.includes("/../")
    || normalized.includes("/./")
  ) {
    throw new ResearchCycleError(
      "RESEARCH_INSTRUMENT_EXECUTION_TASK_INVALID",
      "Inspect tasks must be named experiments/*.py@task_name entries inside the fixed shared Lab",
    );
  }
  return normalized;
}

function normalizeProfile(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = requiredString(value, "profile");
  if (!PROFILE_PATTERN.test(normalized)) {
    throw new ResearchCycleError(
      "RESEARCH_INSTRUMENT_EXECUTION_PROFILE_INVALID",
      "profile must be a bounded shared-Lab profile identity",
    );
  }
  return normalized;
}

function normalizeLimit(value: number | undefined): number {
  const normalized = value ?? 1;
  if (!Number.isInteger(normalized) || normalized < 1 || normalized > 16) {
    throw new ResearchCycleError(
      "RESEARCH_INSTRUMENT_EXECUTION_LIMIT_INVALID",
      "Inspect execution limit must be an integer between 1 and 16",
    );
  }
  return normalized;
}

function normalizeBasisExecutionRefs(values: string[] | undefined): string[] {
  if (values === undefined) return [];
  if (values.length > 50) {
    throw new ResearchCycleError(
      "RESEARCH_INSTRUMENT_EXECUTION_BASIS_LIMIT_INVALID",
      "basisExecutionRefs may contain at most 50 execution identities",
    );
  }
  const normalized = values.map((value) => requiredString(
    value,
    "basisExecutionRef",
  ));
  if (normalized.some((value) => !EXECUTION_REF_PATTERN.test(value))) {
    throw new ResearchCycleError(
      "RESEARCH_INSTRUMENT_EXECUTION_BASIS_INVALID",
      "basisExecutionRefs must contain exact research-instrument-execution identities",
    );
  }
  return [...new Set(normalized)].sort();
}

function pathInside(path: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function relativeEvidencePath(path: string, evidenceDirectory: string): string {
  const normalized = relative(resolve(evidenceDirectory), resolve(path))
    .replaceAll("\\", "/");
  if (!normalized || normalized.startsWith("../") || isAbsolute(normalized)) {
    throw new ResearchCycleError(
      "RESEARCH_INSTRUMENT_EXECUTION_ARTIFACT_PATH_INVALID",
      "execution artifact escaped the current cycle evidence directory",
    );
  }
  return normalized;
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, path);
}

async function inspectRegularFile(
  path: string,
  allowedRoot: string,
  maxBytes: number,
): Promise<{ bytes: Buffer; byteCount: number; sha256: string }> {
  const allowedRootReal = await realpath(allowedRoot);
  const metadata = await lstat(path).catch((error: unknown) => {
    throw new ResearchCycleError(
      "RESEARCH_INSTRUMENT_EXECUTION_ARTIFACT_MISSING",
      "a research Lab execution artifact is missing",
      { errorType: error instanceof Error ? error.name : "unknown" },
    );
  });
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink !== 1) {
    throw new ResearchCycleError(
      "RESEARCH_INSTRUMENT_EXECUTION_ARTIFACT_UNSAFE",
      "research Lab execution artifacts must be regular single-link files",
    );
  }
  if (metadata.size > maxBytes) {
    throw new ResearchCycleError(
      "RESEARCH_INSTRUMENT_EXECUTION_ARTIFACT_TOO_LARGE",
      `research Lab execution artifacts may not exceed ${maxBytes} bytes`,
      { byteCount: metadata.size },
    );
  }
  const actual = await realpath(path);
  if (!pathInside(actual, allowedRootReal)) {
    throw new ResearchCycleError(
      "RESEARCH_INSTRUMENT_EXECUTION_ARTIFACT_UNSAFE",
      "research Lab execution artifact resolved outside its fixed trust root",
    );
  }
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const handle = await open(path, fsConstants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile()
      || opened.nlink !== 1
      || opened.dev !== metadata.dev
      || opened.ino !== metadata.ino
      || opened.size !== metadata.size
    ) {
      throw new ResearchCycleError(
        "RESEARCH_INSTRUMENT_EXECUTION_ARTIFACT_IDENTITY_CHANGED",
        "research Lab execution artifact identity changed during inspection",
      );
    }
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const chunk = await handle.read(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (chunk.bytesRead === 0) break;
      offset += chunk.bytesRead;
    }
    if (offset !== bytes.length) {
      throw new ResearchCycleError(
        "RESEARCH_INSTRUMENT_EXECUTION_ARTIFACT_SHORT_READ",
        "research Lab execution artifact ended before its validated byte count",
      );
    }
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const stable = await handle.stat();
    if (
      stable.dev !== opened.dev
      || stable.ino !== opened.ino
      || stable.size !== opened.size
      || stable.mtimeMs !== opened.mtimeMs
    ) {
      throw new ResearchCycleError(
        "RESEARCH_INSTRUMENT_EXECUTION_ARTIFACT_CHANGED_DURING_READ",
        "research Lab execution artifact changed during inspection",
      );
    }
    return { bytes, byteCount: stable.size, sha256 };
  } finally {
    await handle.close();
  }
}

async function writeExactFile(path: string, bytes: Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") {
      throw error;
    }
    const current = await readFile(path);
    if (!current.equals(bytes)) {
      throw new ResearchCycleError(
        "RESEARCH_INSTRUMENT_EXECUTION_ARTIFACT_CONFLICT",
        "an existing execution artifact differs from the exact terminal Lab artifact",
      );
    }
  }
}

async function defaultLaunchProcess(
  input: LaunchProcessInput,
): Promise<{ pid: number }> {
  const stdout = await open(input.stdoutPath, "wx", 0o600);
  let stderr: FileHandle | undefined;
  try {
    stderr = await open(input.stderrPath, "wx", 0o600);
    const child = spawn(input.executable, input.args, {
      cwd: input.cwd,
      env: input.env,
      detached: true,
      stdio: ["ignore", stdout.fd, stderr.fd],
    });
    await new Promise<void>((resolveSpawn, rejectSpawn) => {
      child.once("spawn", resolveSpawn);
      child.once("error", rejectSpawn);
    });
    if (child.pid === undefined) {
      throw new Error("spawned process did not expose a PID");
    }
    child.unref();
    return { pid: child.pid };
  } finally {
    await stdout.close();
    await stderr?.close();
  }
}

async function defaultReadLabStatus(
  input: ReadLabStatusInput,
): Promise<Record<string, unknown>> {
  const completed = await execFileAsync(
    input.executable,
    [input.runnerPath, "status"],
    {
      cwd: input.cwd,
      env: input.env,
      encoding: "utf8",
      timeout: 15_000,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  const raw = JSON.parse(String(completed.stdout)) as unknown;
  if (!isRecord(raw)) {
    throw new Error("shared Lab status did not return a JSON object");
  }
  return raw;
}

function defaultProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error
      && "code" in error
      && error.code === "EPERM";
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

interface NormalizedExecuteInput {
  planRef: string;
  stepRef: string;
  adapter: "inspect_ai";
  task: string;
  profile?: string;
  limit: number;
  allowRestrictedProfile: boolean;
  basisExecutionRefs: string[];
}

function normalizeExecuteInput(
  input: ResearchInstrumentExecuteInput,
): NormalizedExecuteInput {
  return {
    planRef: requiredString(input.planRef, "planRef"),
    stepRef: requiredString(input.stepRef, "stepRef"),
    adapter: input.adapter,
    task: normalizeInspectTask(input.task),
    profile: normalizeProfile(input.profile),
    limit: normalizeLimit(input.limit),
    allowRestrictedProfile: input.allowRestrictedProfile === true,
    basisExecutionRefs: normalizeBasisExecutionRefs(input.basisExecutionRefs),
  };
}

function executionPublicPolicy(
  config: ZesResearchInstrumentExecutionConfig,
): Record<string, unknown> {
  return {
    authority: "executor_local_shared_research_lab_execution_only",
    configured: config.enabled,
    fixedSharedLabRoot: true,
    arbitraryCommandAccepted: false,
    arbitraryExecutableAccepted: false,
    arbitraryLabRootAccepted: false,
    arbitraryCredentialAccepted: false,
    automaticProfileEscalation: false,
    automaticProtocolFallback: false,
    codexHarnessOrLifecycleAuthority: false,
    researchSufficiencyAuthority: false,
    semanticJudgmentAuthority: false,
    taskOrDecisionAuthority: false,
    writerPublicationReleaseActivationAuthority: false,
    liveEffectAuthority: false,
    exactPlanAndStepRequired: true,
    sameIdempotencyNeverRedispatches: true,
    indeterminateRequiresTerminalReceiptBeforeClosure: true,
    maxConcurrentExecutions: config.maxConcurrent,
  };
}

export class ZesResearchInstrumentExecutor {
  private readonly now: () => Date;
  private readonly runtimeRef: string;
  private readonly launchProcess: (
    input: LaunchProcessInput,
  ) => Promise<{ pid: number }>;
  private readonly processAlive: (pid: number) => boolean;
  private readonly readLabStatus: (
    input: ReadLabStatusInput,
  ) => Promise<Record<string, unknown>>;

  constructor(
    private readonly cycleManager: ZesResearchCycleManager,
    private readonly instrumentManager: ZesResearchInstrumentManager,
    private readonly config: ZesResearchInstrumentExecutionConfig,
    options: ResearchInstrumentExecutorOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.runtimeRef = options.runtimeRef ?? EXECUTOR_RUNTIME_REF;
    this.launchProcess = options.launchProcess ?? defaultLaunchProcess;
    this.processAlive = options.processAlive ?? defaultProcessAlive;
    this.readLabStatus = options.readLabStatus ?? defaultReadLabStatus;
  }

  private statePath(context: ResearchInstrumentCycleContext): string {
    return resolve(
      context.evidenceDirectory,
      "instruments",
      "execution-state.json",
    );
  }

  private lockPath(context: ResearchInstrumentCycleContext): string {
    return resolve(
      context.evidenceDirectory,
      "instruments",
      ".execution-state.lock",
    );
  }

  private async withStateLock<T>(
    context: ResearchInstrumentCycleContext,
    operation: () => Promise<T>,
  ): Promise<T> {
    const lockPath = this.lockPath(context);
    await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
    let acquired = false;
    for (let attempt = 0; attempt < LOCK_WAIT_ATTEMPTS; attempt += 1) {
      try {
        await mkdir(lockPath, { mode: 0o700 });
        acquired = true;
        break;
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") {
          throw error;
        }
        const metadata = await stat(lockPath).catch(() => undefined);
        if (
          metadata
          && this.now().getTime() - metadata.mtimeMs > STALE_LOCK_MS
        ) {
          await rm(lockPath, { recursive: true, force: true });
          continue;
        }
        await sleep(LOCK_WAIT_MS);
      }
    }
    if (!acquired) {
      throw new ResearchCycleError(
        "RESEARCH_INSTRUMENT_EXECUTION_STATE_BUSY",
        "research instrument execution state remained busy beyond the bounded lock wait",
      );
    }
    try {
      return await operation();
    } finally {
      await rm(lockPath, { recursive: true, force: true });
    }
  }

  private async readState(
    workspace: ResearchWorkspace,
    context: ResearchInstrumentCycleContext,
  ): Promise<ResearchInstrumentExecutionState> {
    const path = this.statePath(context);
    try {
      const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
      if (
        !isRecord(raw)
        || raw.schemaVersion !== EXECUTION_STATE_SCHEMA
        || raw.cycleRef !== context.cycleRef
        || raw.workspaceRootDigestSha256
          !== canonicalDigest(resolve(workspace.root))
        || !Array.isArray(raw.executions)
      ) {
        throw new ResearchCycleError(
          "RESEARCH_INSTRUMENT_EXECUTION_STATE_INVALID",
          "persisted research instrument execution state does not match this cycle and workspace",
        );
      }
      return raw as unknown as ResearchInstrumentExecutionState;
    } catch (error) {
      if (
        error instanceof Error
        && "code" in error
        && error.code === "ENOENT"
      ) {
        return {
          schemaVersion: EXECUTION_STATE_SCHEMA,
          cycleRef: context.cycleRef,
          workspaceRootDigestSha256: canonicalDigest(resolve(workspace.root)),
          executions: [],
          updatedAt: this.now().toISOString(),
        };
      }
      if (error instanceof SyntaxError) {
        throw new ResearchCycleError(
          "RESEARCH_INSTRUMENT_EXECUTION_STATE_INVALID",
          "persisted research instrument execution state is not valid JSON",
        );
      }
      throw error;
    }
  }

  private async writeState(
    context: ResearchInstrumentCycleContext,
    state: ResearchInstrumentExecutionState,
  ): Promise<void> {
    state.updatedAt = this.now().toISOString();
    await atomicWriteJson(this.statePath(context), state);
  }

  private assertTargetExecutable(target: ResearchInstrumentExecutionTarget): void {
    if (!EXECUTABLE_INSTRUMENT_KINDS.has(target.instrumentKind)) {
      throw new ResearchCycleError(
        "RESEARCH_INSTRUMENT_EXECUTION_KIND_UNSUPPORTED",
        "the fixed Inspect executor supports only planned agent-behavior and bounded-counterfactual steps",
        { instrumentKind: target.instrumentKind },
      );
    }
    if (!target.modelBacked || target.executionConstraints.modelUse === "forbidden") {
      throw new ResearchCycleError(
        "RESEARCH_INSTRUMENT_EXECUTION_MODEL_NOT_AUTHORIZED",
        "the planned step does not authorize model-backed execution",
      );
    }
    if (target.liveEffect) {
      throw new ResearchCycleError(
        "RESEARCH_INSTRUMENT_EXECUTION_LIVE_EFFECT_FORBIDDEN",
        "the shared Lab executor cannot perform a planned live effect",
      );
    }
    if (target.executionConstraints.executionBoundary !== "isolated_sandbox") {
      throw new ResearchCycleError(
        "RESEARCH_INSTRUMENT_EXECUTION_BOUNDARY_UNSUPPORTED",
        "the fixed Inspect executor requires the planned isolated_sandbox boundary",
        {
          executionBoundary: target.executionConstraints.executionBoundary,
        },
      );
    }
    if (!target.candidateAdapters.some((adapter) => /inspect ai/iu.test(adapter))) {
      throw new ResearchCycleError(
        "RESEARCH_INSTRUMENT_EXECUTION_ADAPTER_NOT_PLANNED",
        "Inspect AI was not a candidate adapter for the exact planned step",
      );
    }
  }

  private executionPaths(
    context: ResearchInstrumentCycleContext,
    executionRef: string,
  ): {
    artifactDirectory: string;
    absoluteDirectory: string;
    runnerReceiptPath: string;
    runnerStderrPath: string;
    manifestPath: string;
  } {
    const identity = executionRef.split(":").at(-1);
    if (!identity || !/^[a-f0-9]{64}$/u.test(identity)) {
      throw new ResearchCycleError(
        "RESEARCH_INSTRUMENT_EXECUTION_IDENTITY_INVALID",
        "executionRef did not contain the expected digest identity",
      );
    }
    const absoluteDirectory = resolve(
      context.evidenceDirectory,
      "lab-executions",
      identity,
    );
    return {
      artifactDirectory: relativeEvidencePath(
        absoluteDirectory,
        context.evidenceDirectory,
      ),
      absoluteDirectory,
      runnerReceiptPath: relativeEvidencePath(
        resolve(absoluteDirectory, "runner-receipt.json"),
        context.evidenceDirectory,
      ),
      runnerStderrPath: relativeEvidencePath(
        resolve(absoluteDirectory, "runner-stderr.log"),
        context.evidenceDirectory,
      ),
      manifestPath: relativeEvidencePath(
        resolve(absoluteDirectory, "execution-manifest.json"),
        context.evidenceDirectory,
      ),
    };
  }

  private fixedLabPaths(): {
    labRoot: string;
    pythonExecutable: string;
    runnerPath: string;
    artifactRoot: string;
  } {
    const labRoot = resolve(this.config.labRoot);
    return {
      labRoot,
      pythonExecutable: resolve(labRoot, ".venv", "bin", "python"),
      runnerPath: resolve(labRoot, "runners", "inspect_9router.py"),
      artifactRoot: resolve(labRoot, "artifacts", "inspect-9router"),
    };
  }

  private async assertFixedLabReady(): Promise<ReturnType<
    ZesResearchInstrumentExecutor["fixedLabPaths"]
  >> {
    const paths = this.fixedLabPaths();
    const labRootReal = await realpath(paths.labRoot).catch((error: unknown) => {
      throw new ResearchCycleError(
        "RESEARCH_INSTRUMENT_EXECUTION_LAB_UNAVAILABLE",
        "the fixed shared Research Lab root is unavailable",
        { errorType: error instanceof Error ? error.name : "unknown" },
      );
    });
    const runnerReal = await realpath(paths.runnerPath).catch((error: unknown) => {
      throw new ResearchCycleError(
        "RESEARCH_INSTRUMENT_EXECUTION_RUNNER_UNAVAILABLE",
        "the fixed Inspect runner is unavailable",
        { errorType: error instanceof Error ? error.name : "unknown" },
      );
    });
    if (!pathInside(runnerReal, labRootReal)) {
      throw new ResearchCycleError(
        "RESEARCH_INSTRUMENT_EXECUTION_RUNNER_UNSAFE",
        "the fixed Inspect runner resolved outside the shared Lab root",
      );
    }
    const runnerStat = await lstat(paths.runnerPath);
    if (runnerStat.isSymbolicLink() || !runnerStat.isFile()) {
      throw new ResearchCycleError(
        "RESEARCH_INSTRUMENT_EXECUTION_RUNNER_UNSAFE",
        "the fixed Inspect runner must be a regular non-symlink file",
      );
    }
    await realpath(paths.pythonExecutable).catch((error: unknown) => {
      throw new ResearchCycleError(
        "RESEARCH_INSTRUMENT_EXECUTION_PYTHON_UNAVAILABLE",
        "the fixed shared Lab Python environment is unavailable",
        { errorType: error instanceof Error ? error.name : "unknown" },
      );
    });
    return paths;
  }

  private async sharedLabPolicy(
    paths: ReturnType<ZesResearchInstrumentExecutor["fixedLabPaths"]>,
  ): Promise<SharedLabPolicySnapshot> {
    let status: Record<string, unknown>;
    try {
      status = await this.readLabStatus({
        executable: paths.pythonExecutable,
        runnerPath: paths.runnerPath,
        cwd: paths.labRoot,
        env: this.childEnvironment(),
      });
    } catch (error) {
      throw new ResearchCycleError(
        "RESEARCH_INSTRUMENT_EXECUTION_LAB_STATUS_UNAVAILABLE",
        "the fixed shared Lab status route was not usable",
        { errorType: error instanceof Error ? error.name : "unknown" },
      );
    }
    if (status.ready !== true) {
      throw new ResearchCycleError(
        "RESEARCH_INSTRUMENT_EXECUTION_LAB_NOT_READY",
        "the fixed shared Lab did not attest readiness for bounded profiled evaluation",
        {
          status: typeof status.status === "string" ? status.status : "unknown",
          checks: isRecord(status.checks) ? status.checks : undefined,
        },
      );
    }
    const policy = isRecord(status.shared_evaluator_policy)
      ? status.shared_evaluator_policy
      : undefined;
    const budgets = policy && isRecord(policy.budgets)
      ? policy.budgets
      : undefined;
    const profileRows = policy && isRecord(policy.profiles)
      ? policy.profiles
      : undefined;
    if (
      !policy
      || typeof policy.digest_sha256 !== "string"
      || !/^[a-f0-9]{64}$/u.test(policy.digest_sha256)
      || typeof policy.default_eval_profile !== "string"
      || !profileRows
      || !budgets
      || typeof budgets.adjudication_fraction_ceiling !== "number"
      || typeof budgets.frontier_fraction_ceiling !== "number"
      || !Number.isInteger(budgets.frontier_minimum_non_frontier_samples)
      || Number(budgets.frontier_minimum_non_frontier_samples) < 1
      || typeof budgets.frontier_requires_adjudication_basis !== "boolean"
    ) {
      throw new ResearchCycleError(
        "RESEARCH_INSTRUMENT_EXECUTION_LAB_POLICY_INVALID",
        "the shared Lab status did not expose the required evaluator-policy contract",
      );
    }
    if (
      policy.automatic_profile_escalation !== false
      || policy.automatic_protocol_fallback !== false
      || budgets.frontier_auto_escalation !== false
    ) {
      throw new ResearchCycleError(
        "RESEARCH_INSTRUMENT_EXECUTION_LAB_POLICY_UNSAFE",
        "the shared Lab policy enabled automatic escalation or fallback",
      );
    }
    const adjudicationFractionCeiling =
      budgets.adjudication_fraction_ceiling;
    const frontierFractionCeiling = budgets.frontier_fraction_ceiling;
    if (
      adjudicationFractionCeiling < 0
      || adjudicationFractionCeiling > 1
      || frontierFractionCeiling < 0
      || frontierFractionCeiling > 1
    ) {
      throw new ResearchCycleError(
        "RESEARCH_INSTRUMENT_EXECUTION_LAB_POLICY_INVALID",
        "the shared Lab evaluator budget ceilings must be fractions between zero and one",
      );
    }
    const profiles = new Map<string, SharedLabProfilePolicy>();
    for (const [name, raw] of Object.entries(profileRows)) {
      if (!PROFILE_PATTERN.test(name) || !isRecord(raw)) continue;
      const budgetClass = raw.budget_class;
      if (
        budgetClass !== "routine"
        && budgetClass !== "adjudication"
        && budgetClass !== "frontier"
      ) continue;
      if (typeof raw.explicit_only !== "boolean") continue;
      profiles.set(name, {
        name,
        budgetClass,
        explicitOnly: raw.explicit_only,
      });
    }
    if (!profiles.has(policy.default_eval_profile)) {
      throw new ResearchCycleError(
        "RESEARCH_INSTRUMENT_EXECUTION_LAB_POLICY_INVALID",
        "the shared Lab default evaluator profile was not present in its profile directory",
      );
    }
    return {
      digestSha256: policy.digest_sha256,
      defaultEvalProfile: policy.default_eval_profile,
      adjudicationFractionCeiling,
      frontierFractionCeiling,
      frontierMinimumNonFrontierSamples:
        Number(budgets.frontier_minimum_non_frontier_samples),
      frontierRequiresAdjudicationBasis:
        budgets.frontier_requires_adjudication_basis,
      profiles,
      rawStatus: status,
    };
  }

  private resolveProfileAndBudget(
    context: ResearchInstrumentCycleContext,
    state: ResearchInstrumentExecutionState,
    input: NormalizedExecuteInput,
    policy: SharedLabPolicySnapshot,
  ): {
    input: NormalizedExecuteInput & { profile: string };
    profile: SharedLabProfilePolicy;
  } {
    const profileName = input.profile ?? policy.defaultEvalProfile;
    const profile = policy.profiles.get(profileName);
    if (!profile) {
      throw new ResearchCycleError(
        "RESEARCH_INSTRUMENT_EXECUTION_PROFILE_UNAVAILABLE",
        "the requested evaluator profile is not present in the current shared Lab policy",
        { profile: profileName, policyDigestSha256: policy.digestSha256 },
      );
    }
    const availability = isRecord(policy.rawStatus.profile_availability)
      ? policy.rawStatus.profile_availability[profileName]
      : undefined;
    if (availability !== true) {
      throw new ResearchCycleError(
        "RESEARCH_INSTRUMENT_EXECUTION_PROFILE_MODEL_UNAVAILABLE",
        "the model bound to the requested shared Lab profile is not currently advertised",
        { profile: profileName },
      );
    }
    if (profile.explicitOnly && !input.allowRestrictedProfile) {
      throw new ResearchCycleError(
        "RESEARCH_INSTRUMENT_EXECUTION_RESTRICTED_PROFILE_ACK_REQUIRED",
        "the requested shared Lab profile requires explicit restricted-profile acknowledgement",
        { profile: profileName },
      );
    }
    const basis = input.basisExecutionRefs.map((executionRef) => {
      const execution = state.executions.find((candidate) =>
        candidate.executionRef === executionRef
      );
      if (!execution) {
        throw new ResearchCycleError(
          "RESEARCH_INSTRUMENT_EXECUTION_BASIS_NOT_FOUND",
          "an evaluator escalation basis execution was not found in this cycle",
          { executionRef },
        );
      }
      if (
        execution.generation !== context.generation
        || execution.planRef !== input.planRef
        || execution.stepRef !== input.stepRef
      ) {
        throw new ResearchCycleError(
          "RESEARCH_INSTRUMENT_EXECUTION_BASIS_MISMATCH",
          "evaluator escalation basis must belong to the exact current plan step",
          { executionRef },
        );
      }
      if (execution.status !== "succeeded") {
        throw new ResearchCycleError(
          "RESEARCH_INSTRUMENT_EXECUTION_BASIS_NOT_TERMINAL_SUCCESS",
          "evaluator escalation basis must be a succeeded terminal Lab execution",
          { executionRef, status: execution.status },
        );
      }
      return execution;
    });
    if (profile.budgetClass !== "routine" && basis.length === 0) {
      throw new ResearchCycleError(
        "RESEARCH_INSTRUMENT_EXECUTION_ESCALATION_BASIS_REQUIRED",
        "adjudication and frontier profiles require exact succeeded basis execution refs",
        { profile: profileName },
      );
    }
    if (
      profile.budgetClass === "adjudication"
      && !basis.some((execution) => execution.budgetClass === "routine")
    ) {
      throw new ResearchCycleError(
        "RESEARCH_INSTRUMENT_EXECUTION_ROUTINE_BASIS_REQUIRED",
        "adjudication requires at least one exact succeeded routine evaluator basis",
      );
    }
    if (
      profile.budgetClass === "frontier"
      && policy.frontierRequiresAdjudicationBasis
      && !basis.some((execution) => execution.budgetClass === "adjudication")
    ) {
      throw new ResearchCycleError(
        "RESEARCH_INSTRUMENT_EXECUTION_ADJUDICATION_BASIS_REQUIRED",
        "frontier calibration requires an exact succeeded adjudication basis under the shared Lab policy",
      );
    }
    const countable = state.executions.filter((execution) =>
      execution.generation === context.generation
      && execution.remoteInferenceAttempted !== false
    );
    const samples = (budgetClass: ResearchInstrumentExecutionRecord["budgetClass"]) =>
      countable
        .filter((execution) => execution.budgetClass === budgetClass)
        .reduce((total, execution) => total + execution.limit, 0);
    const routineSamples = samples("routine");
    const adjudicationSamples = samples("adjudication");
    const frontierSamples = samples("frontier");
    if (profile.budgetClass === "adjudication") {
      const ceiling = policy.adjudicationFractionCeiling === 0
        ? 0
        : Math.max(
          1,
          Math.floor(routineSamples * policy.adjudicationFractionCeiling),
        );
      if (adjudicationSamples + input.limit > ceiling) {
        throw new ResearchCycleError(
          "RESEARCH_INSTRUMENT_EXECUTION_ADJUDICATION_BUDGET_HELD",
          "the shared Lab adjudication sample ceiling would be exceeded",
          {
            routineSamples,
            adjudicationSamples,
            requestedSamples: input.limit,
            ceiling,
            fraction: policy.adjudicationFractionCeiling,
          },
        );
      }
    }
    if (profile.budgetClass === "frontier") {
      const nonFrontierSamples = routineSamples + adjudicationSamples;
      if (nonFrontierSamples < policy.frontierMinimumNonFrontierSamples) {
        throw new ResearchCycleError(
          "RESEARCH_INSTRUMENT_EXECUTION_FRONTIER_MINIMUM_HELD",
          "frontier calibration requires more non-frontier evidence before spending frontier quota",
          {
            nonFrontierSamples,
            requiredNonFrontierSamples:
              policy.frontierMinimumNonFrontierSamples,
          },
        );
      }
      const ceiling = policy.frontierFractionCeiling === 0
        ? 0
        : Math.max(
          1,
          Math.floor(nonFrontierSamples * policy.frontierFractionCeiling),
        );
      if (frontierSamples + input.limit > ceiling) {
        throw new ResearchCycleError(
          "RESEARCH_INSTRUMENT_EXECUTION_FRONTIER_BUDGET_HELD",
          "the shared Lab frontier-calibration sample ceiling would be exceeded",
          {
            nonFrontierSamples,
            frontierSamples,
            requestedSamples: input.limit,
            ceiling,
            fraction: policy.frontierFractionCeiling,
          },
        );
      }
    }
    return {
      input: { ...input, profile: profileName },
      profile,
    };
  }

  private childEnvironment(): NodeJS.ProcessEnv {
    const environment: NodeJS.ProcessEnv = {
      HOME: process.env.HOME,
      PATH: process.env.PATH,
      LANG: process.env.LANG,
      LC_ALL: process.env.LC_ALL,
      TMPDIR: process.env.TMPDIR,
      PYTHONUNBUFFERED: "1",
    };
    return Object.fromEntries(
      Object.entries(environment).filter(([, value]) => value !== undefined),
    );
  }

  private buildRunnerArguments(
    runnerPath: string,
    input: NormalizedExecuteInput,
  ): string[] {
    const args = [
      runnerPath,
      "eval",
      input.task,
      "--limit",
      String(input.limit),
    ];
    if (input.profile) args.push("--profile", input.profile);
    if (input.allowRestrictedProfile) {
      args.push("--allow-restricted-profile");
    }
    return args;
  }

  private async runnerReceipt(
    context: ResearchInstrumentCycleContext,
    record: ResearchInstrumentExecutionRecord,
  ): Promise<
    | { state: "absent" }
    | { state: "invalid"; reason: string }
    | { state: "valid"; value: Record<string, unknown> }
  > {
    const path = resolve(context.evidenceDirectory, record.runnerReceiptPath);
    if (!pathInside(path, context.evidenceDirectory)) {
      return { state: "invalid", reason: "runner_receipt_path_escaped" };
    }
    let metadata;
    try {
      metadata = await lstat(path);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return { state: "absent" };
      }
      return { state: "invalid", reason: "runner_receipt_unreadable" };
    }
    if (metadata.size === 0) return { state: "absent" };
    if (
      metadata.isSymbolicLink()
      || !metadata.isFile()
      || metadata.nlink !== 1
      || metadata.size > MAX_RUNNER_RECEIPT_BYTES
    ) {
      return { state: "invalid", reason: "runner_receipt_unsafe" };
    }
    try {
      const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
      if (
        !isRecord(raw)
        || typeof raw.schema_version !== "string"
        || !raw.schema_version.startsWith("zes.inspect-9router-run.v")
        || typeof raw.status !== "string"
        || typeof raw.returncode !== "number"
      ) {
        return { state: "invalid", reason: "runner_receipt_contract_invalid" };
      }
      return { state: "valid", value: raw };
    } catch (error) {
      return {
        state: "invalid",
        reason: error instanceof SyntaxError
          ? "runner_receipt_json_incomplete_or_invalid"
          : "runner_receipt_unreadable",
      };
    }
  }

  private async evidenceArtifact(
    context: ResearchInstrumentCycleContext,
    path: string,
    role: ResearchInstrumentExecutionArtifact["role"],
    mediaType: string,
  ): Promise<ResearchInstrumentExecutionArtifact> {
    const inspected = await inspectRegularFile(
      path,
      context.evidenceDirectory,
      MAX_LAB_ARTIFACT_BYTES,
    );
    return {
      path: relativeEvidencePath(path, context.evidenceDirectory),
      role,
      mediaType,
      byteCount: inspected.byteCount,
      sha256: inspected.sha256,
    };
  }

  private async copyInspectLogs(
    context: ResearchInstrumentCycleContext,
    record: ResearchInstrumentExecutionRecord,
    runnerReceipt: Record<string, unknown>,
  ): Promise<ResearchInstrumentExecutionArtifact[]> {
    const paths = this.fixedLabPaths();
    const logs = Array.isArray(runnerReceipt.logs) ? runnerReceipt.logs : [];
    if (logs.length > 20) {
      throw new ResearchCycleError(
        "RESEARCH_INSTRUMENT_EXECUTION_TRACE_LIMIT_EXCEEDED",
        "one shared Lab execution may materialize at most 20 Inspect log artifacts",
        { logCount: logs.length },
      );
    }
    const copied: ResearchInstrumentExecutionArtifact[] = [];
    for (let index = 0; index < logs.length; index += 1) {
      const row = logs[index];
      if (!isRecord(row) || typeof row.location !== "string") continue;
      const source = resolve(row.location);
      if (!pathInside(source, paths.artifactRoot)) {
        throw new ResearchCycleError(
          "RESEARCH_INSTRUMENT_EXECUTION_TRACE_OUTSIDE_LAB",
          "Inspect returned a trace location outside the fixed shared Lab artifact root",
        );
      }
      const inspected = await inspectRegularFile(
        source,
        paths.artifactRoot,
        MAX_LAB_ARTIFACT_BYTES,
      );
      const destination = resolve(
        context.evidenceDirectory,
        record.artifactDirectory,
        `inspect-log-${String(index + 1).padStart(3, "0")}.json`,
      );
      await writeExactFile(destination, inspected.bytes);
      copied.push(await this.evidenceArtifact(
        context,
        destination,
        "trace",
        "application/json",
      ));
    }
    return copied;
  }

  private runnerSummary(
    runnerReceipt: Record<string, unknown>,
  ): {
    runnerStatus: string;
    runnerReturncode: number;
    runnerSchemaVersion: string;
    effectiveProfile?: Record<string, unknown>;
    sharedPolicyDigestSha256?: string;
    remoteInferenceAttempted?: boolean;
  } {
    const policy = isRecord(runnerReceipt.shared_evaluator_policy)
      ? runnerReceipt.shared_evaluator_policy
      : undefined;
    return {
      runnerStatus: String(runnerReceipt.status),
      runnerReturncode: Number(runnerReceipt.returncode),
      runnerSchemaVersion: String(runnerReceipt.schema_version),
      effectiveProfile: isRecord(runnerReceipt.evaluator_profile)
        ? runnerReceipt.evaluator_profile
        : undefined,
      sharedPolicyDigestSha256:
        typeof policy?.digest_sha256 === "string"
          ? policy.digest_sha256
          : undefined,
      remoteInferenceAttempted:
        typeof runnerReceipt.remote_inference_attempted === "boolean"
          ? runnerReceipt.remote_inference_attempted
          : undefined,
    };
  }

  private async finalizeFromRunnerReceipt(
    context: ResearchInstrumentCycleContext,
    record: ResearchInstrumentExecutionRecord,
    runnerReceipt: Record<string, unknown>,
  ): Promise<void> {
    const absoluteReceiptPath = resolve(
      context.evidenceDirectory,
      record.runnerReceiptPath,
    );
    const artifacts = [
      await this.evidenceArtifact(
        context,
        absoluteReceiptPath,
        "result",
        "application/json",
      ),
      ...(await this.copyInspectLogs(context, record, runnerReceipt)),
    ];
    const stderrPath = resolve(
      context.evidenceDirectory,
      record.runnerStderrPath,
    );
    const stderrMetadata = await lstat(stderrPath).catch(() => undefined);
    if (stderrMetadata?.isFile() && stderrMetadata.size > 0) {
      artifacts.push(await this.evidenceArtifact(
        context,
        stderrPath,
        "log",
        "text/plain",
      ));
    }
    const summary = this.runnerSummary(runnerReceipt);
    const runnerProfileName =
      typeof summary.effectiveProfile?.base_profile_name === "string"
        ? summary.effectiveProfile.base_profile_name
        : undefined;
    const profileIdentityMatched =
      runnerProfileName === record.requestedProfile;
    const policyIdentityMatched =
      summary.sharedPolicyDigestSha256 === record.sharedPolicyDigestSha256;
    const runnerSucceeded =
      summary.runnerStatus === "completed" && summary.runnerReturncode === 0;
    const terminalStatus =
      runnerSucceeded && profileIdentityMatched && policyIdentityMatched
        ? "succeeded"
        : "failed";
    const completedAt = this.now().toISOString();
    const manifestPath = resolve(
      context.evidenceDirectory,
      record.manifestPath,
    );
    await atomicWriteJson(manifestPath, {
      schemaVersion: EXECUTION_MANIFEST_SCHEMA,
      executionRef: record.executionRef,
      cycleRef: record.cycleRef,
      generation: record.generation,
      planRef: record.planRef,
      stepRef: record.stepRef,
      status: terminalStatus,
      adapter: record.adapter,
      task: record.task,
      requestedProfile: record.requestedProfile,
      limit: record.limit,
      runner: summary,
      profileIdentityMatched,
      policyIdentityMatched,
      artifacts,
      claimCeiling:
        "terminal_shared_lab_execution_observation_only_not_research_sufficiency_or_semantic_acceptance",
      completedAt,
    });
    artifacts.push(await this.evidenceArtifact(
      context,
      manifestPath,
      "receipt",
      "application/json",
    ));
    record.status = terminalStatus;
    record.artifacts = artifacts;
    record.runnerStatus = summary.runnerStatus;
    record.runnerReturncode = summary.runnerReturncode;
    record.runnerSchemaVersion = summary.runnerSchemaVersion;
    record.effectiveProfile = summary.effectiveProfile;
    record.runnerPolicyDigestSha256 = summary.sharedPolicyDigestSha256;
    record.runnerProfileName = runnerProfileName;
    record.remoteInferenceAttempted = summary.remoteInferenceAttempted;
    record.terminalReason = !profileIdentityMatched
      ? "runner_profile_identity_mismatch"
      : !policyIdentityMatched
      ? "runner_policy_identity_mismatch"
      : `runner_status:${summary.runnerStatus}`;
    record.completedAt = completedAt;
    record.updatedAt = completedAt;
  }

  private async reconcileExecution(
    context: ResearchInstrumentCycleContext,
    record: ResearchInstrumentExecutionRecord,
  ): Promise<boolean> {
    if (record.status === "succeeded" || record.status === "failed") {
      return false;
    }
    const runnerReceipt = await this.runnerReceipt(context, record);
    if (runnerReceipt.state === "valid") {
      await this.finalizeFromRunnerReceipt(
        context,
        record,
        runnerReceipt.value,
      );
      return true;
    }
    if (record.status === "indeterminate") return false;
    if (record.status === "dispatching") {
      record.status = "indeterminate";
      record.terminalReason = runnerReceipt.state === "invalid"
        ? runnerReceipt.reason
        : "dispatch_outcome_unknown_before_pid_persistence";
      record.updatedAt = this.now().toISOString();
      return true;
    }
    const sameRuntime = record.executorRuntimeRef === this.runtimeRef;
    const running = sameRuntime
      && record.pid !== undefined
      && this.processAlive(record.pid);
    if (running) return false;
    record.status = "indeterminate";
    record.terminalReason = runnerReceipt.state === "invalid"
      ? runnerReceipt.reason
      : sameRuntime
      ? "runner_process_ended_without_terminal_receipt"
      : "executor_runtime_changed_without_terminal_receipt";
    record.updatedAt = this.now().toISOString();
    return true;
  }

  private async reconcileState(
    context: ResearchInstrumentCycleContext,
    state: ResearchInstrumentExecutionState,
  ): Promise<boolean> {
    let changed = false;
    for (const execution of state.executions) {
      changed = (await this.reconcileExecution(context, execution)) || changed;
    }
    return changed;
  }

  private publicExecution(
    record: ResearchInstrumentExecutionRecord,
    currentGeneration: number,
  ): Record<string, unknown> {
    const retryPolicy = record.status === "running"
      || record.status === "dispatching"
      ? "reconcile_before_retry"
      : record.status === "indeterminate"
      ? "forbidden_until_terminal_receipt"
      : "same_identity_returns_terminal_receipt_new_identity_required_for_new_attempt";
    return {
      executionRef: record.executionRef,
      cycleRef: record.cycleRef,
      generation: record.generation,
      generationRelation:
        record.generation === currentGeneration ? "current" : "stale",
      planRef: record.planRef,
      stepRef: record.stepRef,
      instrumentKind: record.instrumentKind,
      evidenceNeedKind: record.evidenceNeedKind,
      capabilityRef: record.capabilityRef,
      claimCeiling: record.claimCeiling,
      adapter: record.adapter,
      task: record.task,
      requestedProfile: record.requestedProfile,
      budgetClass: record.budgetClass,
      basisExecutionRefs: record.basisExecutionRefs,
      limit: record.limit,
      allowRestrictedProfile: record.allowRestrictedProfile,
      status: record.status,
      processObservedInCurrentRuntime:
        record.status === "running"
        && record.executorRuntimeRef === this.runtimeRef
        && record.pid !== undefined
        && this.processAlive(record.pid),
      runnerStatus: record.runnerStatus,
      runnerReturncode: record.runnerReturncode,
      runnerSchemaVersion: record.runnerSchemaVersion,
      effectiveProfile: record.effectiveProfile,
      sharedPolicyDigestSha256: record.sharedPolicyDigestSha256,
      runnerPolicyDigestSha256: record.runnerPolicyDigestSha256,
      runnerProfileName: record.runnerProfileName,
      remoteInferenceAttempted: record.remoteInferenceAttempted,
      artifacts: record.artifacts,
      suggestedRecordArtifacts: record.artifacts.map((artifact) => ({
        location: "cycle_evidence",
        path: artifact.path,
        role: artifact.role,
        mediaType: artifact.mediaType,
      })),
      terminalReason: record.terminalReason,
      retryPolicy,
      createdAt: record.createdAt,
      startedAt: record.startedAt,
      completedAt: record.completedAt,
      updatedAt: record.updatedAt,
    };
  }

  async execute(
    workspace: ResearchWorkspace,
    input: ResearchInstrumentExecuteInput,
  ): Promise<Record<string, unknown>> {
    if (!this.config.enabled) {
      throw new ResearchCycleError(
        "RESEARCH_INSTRUMENT_EXECUTION_NOT_CONFIGURED",
        "the fixed shared Research Lab executor is not enabled for this DevSpace runtime",
      );
    }
    const normalized = normalizeExecuteInput(input);
    const idempotencyKeyDigestSha256 = keyDigest(input.idempotencyKey);
    const inputDigestSha256 = canonicalDigest(normalized);
    const context = await this.cycleManager.instrumentContext(workspace);
    return await this.withStateLock(context, async () => {
      const state = await this.readState(workspace, context);
      if (await this.reconcileState(context, state)) {
        await this.writeState(context, state);
      }
      const existing = state.executions.find((execution) =>
        execution.idempotencyKeyDigestSha256 === idempotencyKeyDigestSha256
      );
      if (existing) {
        if (existing.inputDigestSha256 !== inputDigestSha256) {
          throw new ResearchCycleError(
            "RESEARCH_INSTRUMENT_EXECUTION_IDEMPOTENCY_CONFLICT",
            "the execution idempotency key was already used for different input",
          );
        }
        return {
          status: existing.status,
          execution: this.publicExecution(existing, context.generation),
          idempotentReplay: true,
          policy: executionPublicPolicy(this.config),
        };
      }
      const unresolvedExecution = state.executions.find((execution) =>
        execution.generation === context.generation
        && execution.planRef === normalized.planRef
        && execution.stepRef === normalized.stepRef
        && execution.status === "indeterminate"
      );
      if (unresolvedExecution) {
        throw new ResearchCycleError(
          "RESEARCH_INSTRUMENT_EXECUTION_RECONCILIATION_REQUIRED",
          "an indeterminate execution for this exact plan step must reach an exact terminal receipt before any new dispatch",
          { executionRef: unresolvedExecution.executionRef },
        );
      }
      if (state.executions.length >= MAX_EXECUTIONS) {
        throw new ResearchCycleError(
          "RESEARCH_INSTRUMENT_EXECUTION_LIMIT_REACHED",
          `one research cycle may retain at most ${MAX_EXECUTIONS} Lab executions`,
        );
      }
      const activeCount = state.executions.filter((execution) =>
        execution.status === "dispatching" || execution.status === "running"
      ).length;
      if (activeCount >= this.config.maxConcurrent) {
        throw new ResearchCycleError(
          "RESEARCH_INSTRUMENT_EXECUTION_CAPACITY_HELD",
          "the configured shared Lab execution concurrency is already occupied",
          {
            activeCount,
            maxConcurrent: this.config.maxConcurrent,
          },
        );
      }
      const lab = await this.assertFixedLabReady();
      const sharedPolicy = await this.sharedLabPolicy(lab);
      const resolved = this.resolveProfileAndBudget(
        context,
        state,
        normalized,
        sharedPolicy,
      );
      const target = await this.instrumentManager.executionTarget(
        workspace,
        resolved.input.planRef,
        resolved.input.stepRef,
      );
      this.assertTargetExecutable(target);
      if (
        target.cycleRef !== context.cycleRef
        || target.generation !== context.generation
      ) {
        throw new ResearchCycleError(
          "RESEARCH_INSTRUMENT_EXECUTION_CONTEXT_CHANGED",
          "the research cycle generation changed before Lab dispatch",
        );
      }
      const executionRef = `research-instrument-execution:${canonicalDigest({
        cycleRef: target.cycleRef,
        generation: target.generation,
        planRef: target.planRef,
        stepRef: target.stepRef,
        idempotencyKeyDigestSha256,
        inputDigestSha256,
        sharedPolicyDigestSha256: sharedPolicy.digestSha256,
      })}`;
      const paths = this.executionPaths(context, executionRef);
      await mkdir(dirname(paths.absoluteDirectory), {
        recursive: true,
        mode: 0o700,
      });
      try {
        await mkdir(paths.absoluteDirectory, { mode: 0o700 });
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "EEXIST") {
          throw new ResearchCycleError(
            "RESEARCH_INSTRUMENT_EXECUTION_ARTIFACT_DIRECTORY_CONFLICT",
            "the deterministic Lab execution directory already exists without matching durable state",
          );
        }
        throw error;
      }
      const timestamp = this.now().toISOString();
      const record: ResearchInstrumentExecutionRecord = {
        schemaVersion: EXECUTION_RECORD_SCHEMA,
        executionRef,
        idempotencyKeyDigestSha256,
        inputDigestSha256,
        cycleRef: target.cycleRef,
        generation: target.generation,
        planRef: target.planRef,
        stepRef: target.stepRef,
        instrumentKind: target.instrumentKind,
        evidenceNeedKind: target.evidenceNeedKind,
        capabilityRef: target.capabilityRef,
        claimCeiling: target.claimCeiling,
        adapter: resolved.input.adapter,
        task: resolved.input.task,
        requestedProfile: resolved.input.profile,
        budgetClass: resolved.profile.budgetClass,
        basisExecutionRefs: resolved.input.basisExecutionRefs,
        limit: resolved.input.limit,
        allowRestrictedProfile: resolved.input.allowRestrictedProfile,
        status: "dispatching",
        executorRuntimeRef: this.runtimeRef,
        artifactDirectory: paths.artifactDirectory,
        runnerReceiptPath: paths.runnerReceiptPath,
        runnerStderrPath: paths.runnerStderrPath,
        manifestPath: paths.manifestPath,
        artifacts: [],
        sharedPolicyDigestSha256: sharedPolicy.digestSha256,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      state.executions.push(record);
      await this.writeState(context, state);
      try {
        const launched = await this.launchProcess({
          executable: lab.pythonExecutable,
          args: this.buildRunnerArguments(lab.runnerPath, resolved.input),
          cwd: lab.labRoot,
          env: this.childEnvironment(),
          stdoutPath: resolve(
            context.evidenceDirectory,
            record.runnerReceiptPath,
          ),
          stderrPath: resolve(
            context.evidenceDirectory,
            record.runnerStderrPath,
          ),
        });
        record.pid = launched.pid;
        record.status = "running";
        record.startedAt = this.now().toISOString();
        record.updatedAt = record.startedAt;
      } catch (error) {
        record.status = "failed";
        record.remoteInferenceAttempted = false;
        record.terminalReason = `local_dispatch_failed:${
          error instanceof Error ? error.name : "unknown"
        }`;
        record.completedAt = this.now().toISOString();
        record.updatedAt = record.completedAt;
      }
      await this.writeState(context, state);
      return {
        status: record.status,
        execution: this.publicExecution(record, context.generation),
        idempotentReplay: false,
        policy: executionPublicPolicy(this.config),
      };
    });
  }

  async status(
    workspace: ResearchWorkspace,
  ): Promise<Record<string, unknown>> {
    const context = await this.cycleManager.instrumentContext(workspace);
    return await this.withStateLock(context, async () => {
      const state = await this.readState(workspace, context);
      if (await this.reconcileState(context, state)) {
        await this.writeState(context, state);
      }
      let readiness: Record<string, unknown>;
      if (!this.config.enabled) {
        readiness = {
          status: "not_configured",
          available: false,
        };
      } else {
        try {
          const lab = await this.assertFixedLabReady();
          const policy = await this.sharedLabPolicy(lab);
          readiness = {
            status: "ready",
            available: true,
            policyDigestSha256: policy.digestSha256,
            defaultEvalProfile: policy.defaultEvalProfile,
            profiles: [...policy.profiles.values()]
              .map((profile) => ({
                name: profile.name,
                budgetClass: profile.budgetClass,
                explicitOnly: profile.explicitOnly,
              }))
              .sort((left, right) => left.name.localeCompare(right.name)),
            budgets: {
              adjudicationFractionCeiling:
                policy.adjudicationFractionCeiling,
              frontierFractionCeiling: policy.frontierFractionCeiling,
              frontierMinimumNonFrontierSamples:
                policy.frontierMinimumNonFrontierSamples,
              frontierRequiresAdjudicationBasis:
                policy.frontierRequiresAdjudicationBasis,
            },
          };
        } catch (error) {
          readiness = {
            status: "unavailable",
            available: false,
            code: error instanceof ResearchCycleError
              ? error.code
              : "RESEARCH_INSTRUMENT_EXECUTION_READINESS_FAILED",
          };
        }
      }
      const current = state.executions.filter((execution) =>
        execution.generation === context.generation
      );
      const counts = Object.fromEntries(
        ["dispatching", "running", "succeeded", "failed", "indeterminate"]
          .map((status) => [
            status,
            current.filter((execution) => execution.status === status).length,
          ]),
      );
      return {
        configured: this.config.enabled,
        readiness,
        cycleRef: context.cycleRef,
        generation: context.generation,
        currentExecutionCount: current.length,
        staleGenerationExecutionCount:
          state.executions.length - current.length,
        counts,
        executions: current.map((execution) =>
          this.publicExecution(execution, context.generation)
        ),
        updatedAt: state.updatedAt,
        policy: executionPublicPolicy(this.config),
      };
    });
  }
}
