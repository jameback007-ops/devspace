import { spawn } from "node:child_process";
import { createHash, randomUUID, type Hash } from "node:crypto";
import { resolveShellCommand, terminateProcessTree } from "./process-platform.js";
import { ProcessOutputError, ProcessOutputLog } from "./process-output-log.js";

export const DEFAULT_EXEC_YIELD_MS = 10_000;
export const DEFAULT_INTERACTIVE_YIELD_MS = 250;
export const DEFAULT_POLL_YIELD_MS = 90_000;
export const MAX_COMMAND_YIELD_MS = 30_000;
export const MAX_POLL_YIELD_MS = 110_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 10_000;
const DEFAULT_BUFFER_CHARACTERS = 1_000_000;
const COMPLETED_SESSION_TTL_MS = 5 * 60 * 1_000;
const DEFAULT_MAX_CONCURRENT_SESSIONS = 32;
const OUTPUT_EXIT_GRACE_MS = 25;
const DEFAULT_COLUMNS = 80;
const DEFAULT_ROWS = 24;
export const COMMAND_ENV_PASSTHROUGH_VARIABLE = "DEVSPACE_COMMAND_ENV_PASSTHROUGH";

// These credentials belong to fixed, typed DevSpace service routes. Allowing
// them through the generic command passthrough would collapse the broker
// boundary and make them visible to arbitrary exec_command payloads.
const FIXED_SERVICE_CREDENTIAL_KEYS = new Set([
  "CONTEXT7_API_KEY",
  "EXA_API_KEY",
]);

const SAFE_PARENT_ENVIRONMENT_KEYS = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "TMPDIR",
  "TEMP",
  "TMP",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "WSLENV",
] as const;

export interface StartCommandInput {
  workspaceId: string;
  executionScopeRef?: string;
  command: string;
  cwd: string;
  workspaceRoot?: string;
  tty?: boolean;
  columns?: number;
  rows?: number;
  yieldTimeMs?: number;
  maxOutputTokens?: number;
}

export interface WriteStdinInput {
  workspaceId: string;
  sessionId: number;
  chars?: string;
  columns?: number;
  rows?: number;
  yieldTimeMs?: number;
  maxOutputTokens?: number;
  externalWake?: Promise<void>;
}

export interface ProcessSnapshot {
  sessionId?: number;
  // Additive observation identity, available even for a fast terminal command.
  outputSessionId?: number;
  processRef?: string;
  output: string;
  outputTruncated: boolean;
  outputDeltaBytes: number;
  outputDeltaDigestSha256: string;
  outputTotalBytes: number;
  outputDigestSha256: string;
  outputEventCount: number;
  outputSequenceStart?: number;
  outputSequenceEnd?: number;
  outputComplete: boolean;
  running: boolean;
  exitCode?: number;
  signal?: string;
  wakeReason?: "mailbox";
  wallTimeMs: number;
}

export interface ReadProcessOutputInput {
  workspaceId: string;
  sessionId: number;
  processRef: string;
  afterSequence?: number;
  waitTimeMs?: number;
  maxOutputTokens?: number;
  signal?: AbortSignal;
  externalWake?: Promise<void>;
}

export interface ProcessOutputSnapshot {
  sessionId: number;
  processRef: string;
  output: string;
  afterSequence: number;
  nextSequence: number;
  oldestSequence: number;
  latestSequence: number;
  sequenceStart?: number;
  gap: boolean;
  droppedThroughSequence: number;
  hasMore: boolean;
  retainedCharacters: number;
  retainedChunks: number;
  running: boolean;
  exitCode?: number;
  signal?: string;
  expiresAt?: string;
  wallTimeMs: number;
  outputComplete: boolean;
  completeFromRequestedCursor: boolean;
  outputDeltaBytes: number;
  outputDeltaDigestSha256: string;
  outputTotalBytes: number;
  outputDigestSha256: string;
  wakeReason?: "output" | "exit" | "timeout" | "mailbox";
}

export interface ProcessSessionInspection {
  sessionId: number;
  processRef?: string;
  workspaceId: string;
  running: boolean;
  startedAt: string;
  lastOutputAt?: string;
  wallTimeMs: number;
  exitCode?: number;
  signal?: string;
  tty: boolean;
  workingDirectory: string;
  commandLength: number;
  commandDigestSha256: string;
  outputEventCount: number;
  outputTotalBytes: number;
  outputDigestSha256: string;
  bufferedOutputAvailable: boolean;
}

interface ManagedProcess {
  write(data: string): void;
  kill(signal?: NodeJS.Signals): void;
  resize?(columns: number, rows: number): void;
}

interface ProcessSession {
  id: number;
  processRef: string;
  workspaceId: string;
  executionScopeRef?: string;
  process?: ManagedProcess;
  startedAt: number;
  lastOutputAt?: number;
  outputEventCount: number;
  outputTotalBytes: number;
  outputHash: Hash;
  deliveredThroughSequence: number;
  tty: boolean;
  workingDirectory: string;
  commandLength: number;
  commandDigestSha256: string;
  columns: number;
  rows: number;
  buffer: HeadTailBuffer;
  outputLog: ProcessOutputLog;
  outputWaiters: Set<(reason: "output" | "exit" | "expired") => void>;
  observationExpired: boolean;
  completedAt?: number;
  running: boolean;
  exitCode?: number;
  signal?: string;
  exitPromise: Promise<void>;
  resolveExit: () => void;
  outputPromise: Promise<void>;
  resolveOutput: () => void;
  cleanupTimer?: NodeJS.Timeout;
}

export interface ProcessSessionManagerOptions {
  maxBufferCharacters?: number;
  completedSessionTtlMs?: number;
  maxConcurrentSessions?: number;
  maxOutputChunks?: number;
  maxCompletedOutputSessions?: number;
  maxOutputWaiters?: number;
}

function deferredSignal(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function boundedInteger(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("Duration and output limits must be non-negative.");
  }
  return Math.min(Math.floor(value), maximum);
}

function terminalSize(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > 1_000) {
    throw new Error("Terminal dimensions must be integers between 1 and 1000.");
  }
  return value;
}

function validatedExecutionScopeRef(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!/^[a-f0-9]{16}$/.test(value)) {
    throw new Error("Execution scope references must be 16 lowercase hexadecimal characters.");
  }
  return value;
}

function validatedEnvironmentKey(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(`${COMMAND_ENV_PASSTHROUGH_VARIABLE} contains an invalid environment variable name: ${value}`);
  }
  if (value === COMMAND_ENV_PASSTHROUGH_VARIABLE) {
    throw new Error(`${COMMAND_ENV_PASSTHROUGH_VARIABLE} cannot pass itself to command processes.`);
  }
  if (FIXED_SERVICE_CREDENTIAL_KEYS.has(value)) {
    throw new Error(
      `${COMMAND_ENV_PASSTHROUGH_VARIABLE} cannot expose fixed service credential ${value} to command processes.`,
    );
  }
  return value;
}

export function commandEnvironmentPassthroughKeys(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  const seen = new Set<string>();
  const keys: string[] = [];
  for (const item of raw.replaceAll(",", " ").split(/\s+/).filter(Boolean)) {
    const key = validatedEnvironmentKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }
  return keys;
}

export function processEnvironment(input?: {
  workspaceId?: string;
  workspaceRoot?: string;
  executionScopeRef?: string;
}, parentEnvironment: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const inherited: Record<string, string> = {};
  for (const key of SAFE_PARENT_ENVIRONMENT_KEYS) {
    const value = parentEnvironment[key];
    if (value !== undefined) inherited[key] = value;
  }
  for (const key of commandEnvironmentPassthroughKeys(
    parentEnvironment[COMMAND_ENV_PASSTHROUGH_VARIABLE],
  )) {
    const value = parentEnvironment[key];
    if (value !== undefined) inherited[key] = value;
  }

  return {
    ...inherited,
    NO_COLOR: "1",
    TERM: "dumb",
    PAGER: "cat",
    GIT_PAGER: "cat",
    GH_PAGER: "cat",
    CODEX_CI: "1",
    LANG: parentEnvironment.LANG ?? "C.UTF-8",
    LC_ALL: parentEnvironment.LC_ALL ?? "C.UTF-8",
    ...(input?.workspaceId ? { DEVSPACE_WORKSPACE_ID: input.workspaceId } : {}),
    ...(input?.workspaceRoot ? { DEVSPACE_WORKSPACE_ROOT: input.workspaceRoot } : {}),
    ...(input?.executionScopeRef
      ? { DEVSPACE_EXECUTION_SCOPE_REF: input.executionScopeRef }
      : {}),
  };
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function sliceCodePoints(value: string, start: number, end?: number): string {
  return Array.from(value).slice(start, end).join("");
}

function takeHead(value: string, count: number): string {
  if (count <= 0) return "";
  return sliceCodePoints(value, 0, count);
}

function takeTail(value: string, count: number): string {
  if (count <= 0) return "";
  const characters = Array.from(value);
  return characters.slice(Math.max(0, characters.length - count)).join("");
}

function splitBudget(maxCharacters: number): { head: number; tail: number } {
  return {
    head: Math.ceil(maxCharacters / 2),
    tail: Math.floor(maxCharacters / 2),
  };
}

function formatHeadTail(head: string, tail: string, omittedCharacters: number): string {
  if (omittedCharacters <= 0) return head + tail;
  return `${head}\n... output truncated (${omittedCharacters} characters omitted) ...\n${tail}`;
}

export class HeadTailBuffer {
  private head = "";
  private tail = "";
  private totalCharacters = 0;

  constructor(private readonly maxCharacters: number) {
    if (!Number.isInteger(maxCharacters) || maxCharacters < 1) {
      throw new Error("Head/tail buffer limit must be a positive integer.");
    }
  }

  append(output: string): void {
    if (!output) return;

    const previousTotal = this.totalCharacters;
    this.totalCharacters += codePointLength(output);

    if (this.totalCharacters <= this.maxCharacters) {
      this.head += output;
      return;
    }

    const budget = splitBudget(this.maxCharacters);
    if (previousTotal <= this.maxCharacters) {
      const fullOutput = this.head + output;
      this.head = takeHead(fullOutput, budget.head);
      this.tail = takeTail(fullOutput, budget.tail);
      return;
    }

    this.tail = takeTail(this.tail + output, budget.tail);
  }

  hasOutput(): boolean {
    return this.totalCharacters > 0;
  }

  drain(maxCharacters: number): { output: string; truncated: boolean } {
    if (!Number.isInteger(maxCharacters) || maxCharacters < 1) {
      throw new Error("Output limit must be a positive integer.");
    }

    const omittedByBuffer = Math.max(
      0,
      this.totalCharacters - codePointLength(this.head) - codePointLength(this.tail),
    );
    const retained = formatHeadTail(this.head, this.tail, omittedByBuffer);
    const output = truncateOutput(retained, maxCharacters);
    const truncated = omittedByBuffer > 0 || output.truncated;

    this.head = "";
    this.tail = "";
    this.totalCharacters = 0;

    return { output: output.output, truncated };
  }
}

function truncateOutput(output: string, maxCharacters: number): { output: string; truncated: boolean } {
  const outputCharacters = codePointLength(output);
  if (outputCharacters <= maxCharacters) return { output, truncated: false };

  const marker = "\n... output truncated ...\n";
  const markerCharacters = codePointLength(marker);
  const available = Math.max(0, maxCharacters - markerCharacters);
  const budget = splitBudget(available);
  return {
    output: takeHead(output, budget.head) + marker + takeTail(output, budget.tail),
    truncated: true,
  };
}

export class ProcessSessionManager {
  private readonly sessions = new Map<number, ProcessSession>();
  private readonly outputSessions = new Map<number, ProcessSession>();
  private readonly maxBufferCharacters: number;
  private readonly completedSessionTtlMs: number;
  private readonly maxConcurrentSessions: number;
  private nextSessionId = 1;
  private readonly maxOutputChunks: number;
  private readonly maxCompletedOutputSessions: number;
  private readonly maxOutputWaiters: number;
  private outputWaiterCount = 0;

  constructor(options: ProcessSessionManagerOptions = {}) {
    this.maxBufferCharacters = options.maxBufferCharacters ?? DEFAULT_BUFFER_CHARACTERS;
    this.completedSessionTtlMs = options.completedSessionTtlMs ?? COMPLETED_SESSION_TTL_MS;
    this.maxConcurrentSessions = options.maxConcurrentSessions ?? DEFAULT_MAX_CONCURRENT_SESSIONS;
    this.maxOutputChunks = options.maxOutputChunks ?? 8192;
    this.maxCompletedOutputSessions = options.maxCompletedOutputSessions ?? 64;
    this.maxOutputWaiters = options.maxOutputWaiters ?? 256;
    for (const bound of [this.maxBufferCharacters, this.maxOutputChunks,
      this.maxCompletedOutputSessions, this.maxOutputWaiters]) {
      if (!Number.isSafeInteger(bound) || bound < 1) {
        throw new Error("Process output retention and waiter bounds must be positive safe integers.");
      }
    }
    if (!Number.isSafeInteger(this.completedSessionTtlMs) || this.completedSessionTtlMs < 0) {
      throw new Error("completedSessionTtlMs must be a non-negative safe integer.");
    }
    if (!Number.isInteger(this.maxConcurrentSessions) || this.maxConcurrentSessions < 1) {
      throw new Error("maxConcurrentSessions must be a positive integer.");
    }
  }

  async start(input: StartCommandInput): Promise<ProcessSnapshot> {
    const runningSessions = Array.from(this.sessions.values()).filter((session) => session.running).length;
    if (runningSessions >= this.maxConcurrentSessions) {
      throw new Error(`Process session limit reached (${this.maxConcurrentSessions}).`);
    }
    const session = this.createSession(input);
    this.sessions.set(session.id, session);
    this.outputSessions.set(session.id, session);

    try {
      if (input.tty && process.platform !== "win32") await this.startPty(session, input);
      else this.startPipe(session, input);
    } catch (error) {
      this.sessions.delete(session.id);
      this.expireOutput(session);
      throw error;
    }

    const yieldTimeMs = boundedInteger(input.yieldTimeMs, DEFAULT_EXEC_YIELD_MS, MAX_COMMAND_YIELD_MS);
    await this.waitForExit(session, yieldTimeMs);

    const snapshot = this.consume(session, input.maxOutputTokens);
    if (!session.running) this.removeSession(session.id);
    return snapshot;
  }

  async write(input: WriteStdinInput): Promise<ProcessSnapshot> {
    const session = this.getOwnedSession(input.workspaceId, input.sessionId);
    const chars = input.chars ?? "";
    const interactionRequested =
      chars.length > 0 || input.columns !== undefined || input.rows !== undefined;

    if (input.columns !== undefined || input.rows !== undefined) {
      session.columns = terminalSize(input.columns, session.columns);
      session.rows = terminalSize(input.rows, session.rows);
      if (!session.process?.resize) {
        throw new Error(`Process session ${session.id} is not a PTY and cannot be resized.`);
      }
      session.process.resize(session.columns, session.rows);
    }

    const interruptRequested = chars.includes("\u0003") && session.running;
    if (interruptRequested) {
      session.process?.kill("SIGINT");
    }
    const writableChars = chars.replaceAll("\u0003", "");
    if (writableChars && session.running) session.process?.write(writableChars);

    let wakeReason: ProcessSnapshot["wakeReason"];
    if ((interactionRequested || !session.buffer.hasOutput()) && session.running) {
      const fallback = interactionRequested ? DEFAULT_INTERACTIVE_YIELD_MS : DEFAULT_POLL_YIELD_MS;
      const maximum = interactionRequested ? MAX_COMMAND_YIELD_MS : MAX_POLL_YIELD_MS;
      const yieldTimeMs = boundedInteger(input.yieldTimeMs, fallback, maximum);
      if (interactionRequested) await this.waitForExit(session, yieldTimeMs);
      else if (
        await this.waitForOutputOrExit(session, yieldTimeMs, input.externalWake)
        === "external"
      ) {
        wakeReason = "mailbox";
      }
    }

    const snapshot = this.consume(session, input.maxOutputTokens, wakeReason);
    if (!session.running) this.removeSession(session.id);
    return snapshot;
  }

  terminate(workspaceId: string, sessionId: number): void {
    const session = this.getOwnedSession(workspaceId, sessionId);
    if (session.running) session.process?.kill("SIGTERM");
  }

  async readOutput(input: ReadProcessOutputInput): Promise<ProcessOutputSnapshot> {
    const session = this.outputSessions.get(input.sessionId);
    if (!session || session.workspaceId !== input.workspaceId) {
      throw new ProcessOutputError("PROCESS_OUTPUT_UNAVAILABLE", "No retained output session in this workspace (unknown, expired, evicted or another backend).");
    }
    if (session.processRef !== input.processRef) {
      throw new ProcessOutputError("PROCESS_OUTPUT_IDENTITY_MISMATCH", "processRef does not match this process incarnation.");
    }
    const afterSequence = input.afterSequence ?? 0;
    const limit = boundedInteger(input.maxOutputTokens, DEFAULT_MAX_OUTPUT_TOKENS, 100_000);
    const maxCharacters = Math.max(256, limit * 4);
    const waitTimeMs = boundedInteger(input.waitTimeMs, DEFAULT_POLL_YIELD_MS, MAX_POLL_YIELD_MS);
    // Validate before installing a waiter; invalid/future cursors never wait.
    let page = session.outputLog.read(afterSequence, maxCharacters);
    if (input.signal?.aborted) {
      throw new ProcessOutputError("PROCESS_OUTPUT_ABORTED", "Output observation was cancelled; the process was not signalled.");
    }
    let wakeReason: ProcessOutputSnapshot["wakeReason"];
    if (session.running && afterSequence === session.outputLog.latestSequence && waitTimeMs > 0) {
      wakeReason = await this.waitForRetainedOutput(session, waitTimeMs, input);
      page = session.outputLog.read(afterSequence, maxCharacters);
    }
    if (session.observationExpired) {
      throw new ProcessOutputError("PROCESS_OUTPUT_UNAVAILABLE", "Output retention expired; the process was not restarted.");
    }
    return {
      ...page,
      sessionId: session.id,
      processRef: session.processRef,
      running: session.running,
      exitCode: session.exitCode,
      signal: session.signal,
      expiresAt: session.completedAt === undefined ? undefined
        : new Date(session.completedAt + this.completedSessionTtlMs).toISOString(),
      wallTimeMs: (session.completedAt ?? Date.now()) - session.startedAt,
      outputComplete: !session.running && !page.hasMore,
      completeFromRequestedCursor: !session.running && !page.hasMore && !page.gap,
      outputDeltaBytes: Buffer.byteLength(page.output),
      outputDeltaDigestSha256: createHash("sha256").update(page.output).digest("hex"),
      outputTotalBytes: session.outputTotalBytes,
      outputDigestSha256: session.outputHash.copy().digest("hex"),
      wakeReason,
    };
  }

  private waitForRetainedOutput(
    session: ProcessSession,
    waitTimeMs: number,
    input: ReadProcessOutputInput,
  ): Promise<ProcessOutputSnapshot["wakeReason"]> {
    if (this.outputWaiterCount >= this.maxOutputWaiters) {
      throw new ProcessOutputError("PROCESS_OUTPUT_BUSY", "Concurrent output observation limit reached; no process action was taken.");
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (reason: "output" | "exit" | "expired" | "timeout" | "mailbox" | "abort") => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        session.outputWaiters.delete(onChange);
        input.signal?.removeEventListener("abort", onAbort);
        this.outputWaiterCount--;
        if (reason === "abort") {
          reject(new ProcessOutputError("PROCESS_OUTPUT_ABORTED", "Output observation was cancelled; the process was not signalled."));
        } else if (reason === "expired") {
          reject(new ProcessOutputError("PROCESS_OUTPUT_UNAVAILABLE", "Output observation is no longer retained."));
        } else resolve(reason);
      };
      const onChange = (reason: "output" | "exit" | "expired") => done(reason);
      const onAbort = () => done("abort");
      const timer = setTimeout(() => done("timeout"), waitTimeMs);
      this.outputWaiterCount++;
      session.outputWaiters.add(onChange);
      input.signal?.addEventListener("abort", onAbort, { once: true });
      if (input.signal?.aborted) onAbort();
      // The caller disposes its mailbox waiter. No per-reader cursor is stored.
      input.externalWake?.then(() => done("mailbox"), () => done("mailbox"));
    });
  }

  private expireOutput(session: ProcessSession): void {
    session.observationExpired = true;
    session.outputLog.clear();
    this.outputSessions.delete(session.id);
    if (!this.sessions.has(session.id) && session.cleanupTimer) clearTimeout(session.cleanupTimer);
    for (const notify of session.outputWaiters) notify("expired");
  }

  inspect(
    workspaceIds?: Iterable<string>,
    executionScopeRefs?: Iterable<string>,
  ): ProcessSessionInspection[] {
    const allowedWorkspaceIds = workspaceIds ? new Set(workspaceIds) : undefined;
    const allowedScopeRefs = executionScopeRefs ? new Set(executionScopeRefs) : undefined;
    const now = Date.now();
    return Array.from(this.sessions.values())
      .filter((session) => !allowedWorkspaceIds || allowedWorkspaceIds.has(session.workspaceId))
      .filter(
        (session) =>
          !allowedScopeRefs ||
          (session.executionScopeRef !== undefined && allowedScopeRefs.has(session.executionScopeRef)),
      )
      .sort((left, right) => right.startedAt - left.startedAt)
      .map((session) => ({
        sessionId: session.id,
        processRef: session.processRef,
        workspaceId: session.workspaceId,
        running: session.running,
        startedAt: new Date(session.startedAt).toISOString(),
        lastOutputAt:
          session.lastOutputAt === undefined
            ? undefined
            : new Date(session.lastOutputAt).toISOString(),
        wallTimeMs: Math.max(0, now - session.startedAt),
        exitCode: session.exitCode,
        signal: session.signal,
        tty: session.tty,
        workingDirectory: session.workingDirectory,
        commandLength: session.commandLength,
        commandDigestSha256: session.commandDigestSha256,
        outputEventCount: session.outputEventCount,
        outputTotalBytes: session.outputTotalBytes,
        outputDigestSha256: session.outputHash.copy().digest("hex"),
        bufferedOutputAvailable: session.buffer.hasOutput(),
      }));
  }

  shutdown(): void {
    for (const session of new Set([...this.sessions.values(), ...this.outputSessions.values()])) {
      if (session.cleanupTimer) clearTimeout(session.cleanupTimer);
      if (session.running) session.process?.kill("SIGTERM");
      this.expireOutput(session);
    }
    this.sessions.clear();
  }

  private async waitForExit(session: ProcessSession, yieldTimeMs: number): Promise<void> {
    await this.waitForSignals([session.exitPromise], yieldTimeMs);
  }

  private async waitForOutputOrExit(
    session: ProcessSession,
    yieldTimeMs: number,
    externalWake?: Promise<void>,
  ): Promise<"output" | "exit" | "external" | "timeout"> {
    let timer: NodeJS.Timeout | undefined;
    try {
      const signals: Array<Promise<"output" | "exit" | "external" | "timeout">> = [
        session.outputPromise.then(() => "output" as const),
        session.exitPromise.then(() => "exit" as const),
        new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => resolve("timeout"), yieldTimeMs);
        }),
      ];
      if (externalWake) {
        signals.push(externalWake.then(() => "external" as const));
      }
      const outcome = await Promise.race(signals);
      if (outcome === "output" && session.running) {
        await this.waitForSignals([session.exitPromise], OUTPUT_EXIT_GRACE_MS);
      }
      return outcome;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async waitForSignals(signals: Promise<void>[], yieldTimeMs: number): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        ...signals,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, yieldTimeMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private createSession(input: StartCommandInput): ProcessSession {
    const exit = deferredSignal();
    const output = deferredSignal();

    return {
      id: this.nextSessionId++,
      processRef: `prc_${randomUUID().replaceAll("-", "")}`,
      workspaceId: input.workspaceId,
      executionScopeRef: validatedExecutionScopeRef(input.executionScopeRef),
      startedAt: Date.now(),
      outputEventCount: 0,
      outputTotalBytes: 0,
      outputHash: createHash("sha256"),
      deliveredThroughSequence: 0,
      tty: input.tty === true,
      workingDirectory: input.cwd,
      commandLength: input.command.length,
      commandDigestSha256: createHash("sha256").update(input.command).digest("hex"),
      columns: terminalSize(input.columns, DEFAULT_COLUMNS),
      rows: terminalSize(input.rows, DEFAULT_ROWS),
      buffer: new HeadTailBuffer(this.maxBufferCharacters),
      outputLog: new ProcessOutputLog(this.maxBufferCharacters, this.maxOutputChunks),
      outputWaiters: new Set(),
      observationExpired: false,
      running: true,
      exitPromise: exit.promise,
      resolveExit: exit.resolve,
      outputPromise: output.promise,
      resolveOutput: output.resolve,
    };
  }

  private startPipe(session: ProcessSession, input: StartCommandInput): void {
    const shell = resolveShellCommand(input.command);
    const detached = process.platform !== "win32";
    const child = spawn(input.command, {
      cwd: input.cwd,
      env: processEnvironment({
        workspaceId: input.workspaceId,
        workspaceRoot: input.workspaceRoot,
        executionScopeRef: session.executionScopeRef,
      }),
      stdio: "pipe",
      windowsHide: true,
      detached,
      shell: shell.executable,
    });

    session.process = {
      write: (data) => child.stdin.write(data),
      kill: (signal = "SIGTERM") => terminateProcessTree(child, signal, detached),
      resize: input.tty ? () => undefined : undefined,
    };
    // Native stream decoding preserves multibyte characters split across reads.
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (data: string) => this.append(session, data));
    child.stderr.on("data", (data: string) => this.append(session, data));
    child.on("error", (error) => this.append(session, `${error.message}\n`));
    child.on("close", (code, signal) => this.finish(session, code ?? undefined, signal ?? undefined));
  }

  private async startPty(session: ProcessSession, input: StartCommandInput): Promise<void> {
    let nodePty: typeof import("node-pty");
    try {
      nodePty = await import("node-pty");
    } catch {
      throw new Error("PTY support requires the optional node-pty dependency.");
    }

    const shell = resolveShellCommand(input.command);
    let pty: import("node-pty").IPty;
    try {
      pty = nodePty.spawn(shell.executable, shell.args, {
        cwd: input.cwd,
        env: processEnvironment({
          workspaceId: input.workspaceId,
          workspaceRoot: input.workspaceRoot,
          executionScopeRef: session.executionScopeRef,
        }),
        name: "xterm-256color",
        cols: session.columns,
        rows: session.rows,
      });
    } catch (error) {
      throw error;
    }

    session.process = {
      write: (data) => pty.write(data),
      kill: (signal) => pty.kill(signal),
      resize: (columns, rows) => pty.resize(columns, rows),
    };
    pty.onData((data) => this.append(session, data));
    pty.onExit(({ exitCode, signal }) => {
      this.finish(session, exitCode, signal === 0 ? undefined : String(signal));
    });
  }

  private finish(session: ProcessSession, exitCode?: number, signal?: string): void {
    if (!session.running) return;
    session.running = false;
    session.exitCode = exitCode;
    session.signal = signal;
    session.completedAt = Date.now();
    session.resolveExit();
    for (const notify of session.outputWaiters) notify("exit");
    // A close callback arriving after shutdown must not retain disposed output
    // through a new timer. Ordinary completion still owns the replay TTL.
    if (session.observationExpired) return;
    session.cleanupTimer = setTimeout(
      () => { this.sessions.delete(session.id); this.expireOutput(session); },
      this.completedSessionTtlMs,
    );
    session.cleanupTimer.unref();
    const completed = [...this.outputSessions.values()]
      .filter((entry) => !entry.running)
      .sort((a, b) => a.completedAt! - b.completedAt!);
    for (const entry of completed.slice(0, Math.max(0, completed.length - this.maxCompletedOutputSessions))) {
      this.expireOutput(entry);
    }
  }

  private append(session: ProcessSession, output: string): void {
    if (!output) return;
    session.buffer.append(output);
    session.outputTotalBytes += Buffer.byteLength(output);
    session.outputHash.update(output);
    session.lastOutputAt = Date.now();
    session.outputEventCount += 1;
    session.resolveOutput();
    if (!session.observationExpired) {
      session.outputLog.append(output);
      for (const notify of session.outputWaiters) notify("output");
    }
  }

  private consume(
    session: ProcessSession,
    maxOutputTokens?: number,
    wakeReason?: ProcessSnapshot["wakeReason"],
  ): ProcessSnapshot {
    const limit = boundedInteger(maxOutputTokens, DEFAULT_MAX_OUTPUT_TOKENS, 100_000);
    const maxCharacters = Math.max(256, limit * 4);
    const hadBufferedOutput = session.buffer.hasOutput();
    const outputSequenceStart = hadBufferedOutput
      ? session.deliveredThroughSequence + 1
      : undefined;
    const outputSequenceEnd = hadBufferedOutput
      ? session.outputEventCount
      : undefined;
    const buffered = session.buffer.drain(maxCharacters);
    if (hadBufferedOutput) session.deliveredThroughSequence = session.outputEventCount;
    if (session.running) {
      const output = deferredSignal();
      session.outputPromise = output.promise;
      session.resolveOutput = output.resolve;
    }

    return {
      sessionId: session.running ? session.id : undefined,
      outputSessionId: session.id,
      processRef: session.processRef,
      output: buffered.output,
      outputTruncated: buffered.truncated,
      outputDeltaBytes: Buffer.byteLength(buffered.output),
      outputDeltaDigestSha256: createHash("sha256").update(buffered.output).digest("hex"),
      outputTotalBytes: session.outputTotalBytes,
      outputDigestSha256: session.outputHash.copy().digest("hex"),
      outputEventCount: session.outputEventCount,
      outputSequenceStart,
      outputSequenceEnd,
      outputComplete: !session.running,
      running: session.running,
      exitCode: session.exitCode,
      signal: session.signal,
      wakeReason,
      wallTimeMs: Date.now() - session.startedAt,
    };
  }

  private getOwnedSession(workspaceId: string, sessionId: number): ProcessSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown process session: ${sessionId}`);
    if (session.workspaceId !== workspaceId) {
      throw new Error(`Process session ${sessionId} does not belong to workspace ${workspaceId}.`);
    }
    return session;
  }

  private removeSession(sessionId: number): void {
    // Legacy consumption still removes the control session. The independent
    // producer-owned TTL retains replay; observers never prolong that TTL.
    const session = this.sessions.get(sessionId);
    this.sessions.delete(sessionId);
    if (session?.observationExpired && session.cleanupTimer) clearTimeout(session.cleanupTimer);
  }
}
