import { randomUUID } from "node:crypto";
import { executionScopeRef } from "./request-meta.js";

export type ExecutorWindowPhase =
  | "not_started"
  | "active"
  | "drain"
  | "yield_required"
  | "yielded"
  | "unscoped"
  | "disabled";

export type ExecutorWindowBeginReason =
  | "new_turn"
  | "recovery_after_cutoff"
  | "manual_test";

export type ExecutorWindowWorktreeState =
  | "clean"
  | "intentional_dirty"
  | "not_applicable"
  | "unknown";

export type ExecutorWindowEffectState =
  | "none"
  | "terminal"
  | "unknown";

export interface ExecutorWindowConfig {
  enabled: boolean;
  drainAfterMs: number;
  yieldAfterMs: number;
  retentionMs: number;
}

export interface ExecutorWindowHandoff {
  summary: string;
  nextAction: string;
  worktreeState: ExecutorWindowWorktreeState;
  effectState: ExecutorWindowEffectState;
  checkpointRefs: string[];
  unresolved: string[];
}

export interface ExecutorWindowStatus {
  schemaVersion: 1;
  enabled: boolean;
  scoped: boolean;
  scopeRef?: string;
  windowId?: string;
  generation?: number;
  phase: ExecutorWindowPhase;
  startedAt?: string;
  lastActivityAt?: string;
  elapsedMs?: number;
  drainAfterMs: number;
  yieldAfterMs: number;
  drainInMs?: number;
  yieldInMs?: number;
  yieldedAt?: string;
  handoff?: ExecutorWindowHandoff;
  previousHandoff?: ExecutorWindowHandoff;
  instruction: string;
}

export interface ExecutorWindowBeginResult {
  started: boolean;
  reason: ExecutorWindowBeginReason;
  previousWindowId?: string;
  previousHandoff?: ExecutorWindowHandoff;
  status: ExecutorWindowStatus;
}

export interface ExecutorWindowGateDecision {
  allowed: boolean;
  status: ExecutorWindowStatus;
  reason?: "window_not_started" | "yield_required" | "window_yielded";
  transition?: "auto_begin" | "auto_resume_after_yield";
}

interface ExecutorWindowEntry {
  windowId: string;
  generation: number;
  startedAtMs: number;
  lastActivityAtMs: number;
  yieldedAtMs?: number;
  handoff?: ExecutorWindowHandoff;
  previousHandoff?: ExecutorWindowHandoff;
}

interface ExecutorWindowRegistryOptions {
  now?: () => number;
}

const WINDOW_TOOL_NAMES = new Set([
  "executor_window_begin",
  "executor_window_status",
  "executor_window_yield",
]);

const YIELD_SAFE_READ_TOOLS = new Set([
  "read",
  "grep",
  "glob",
  "ls",
  "show_changes",
  "execution_scope_list",
  "execution_scope_status",
  "execution_scope_audit",
  "codex_session_status",
  "codex_session_tail",
  "codex_session_audit",
  "codex_workspace_git_status",
  "codex_workspace_tree",
  "codex_workspace_read",
  "codex_workspace_search",
  "codex_workspace_diff",
]);

function iso(ms: number | undefined): string | undefined {
  return ms === undefined ? undefined : new Date(ms).toISOString();
}

function boundedRemaining(target: number, elapsed: number): number {
  return Math.max(0, target - elapsed);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeWriteStdin(input: unknown): boolean {
  if (!isRecord(input)) return false;
  const chars = input.chars;
  return chars === undefined || chars === "" || chars === "\u0003";
}

function statusInstruction(phase: ExecutorWindowPhase): string {
  switch (phase) {
    case "disabled":
      return "Executor-window enforcement is disabled.";
    case "unscoped":
      return "No stable executor scope was supplied by this MCP host; the window is advisory-only for this call.";
    case "not_started":
      return "The first scoped tool call will automatically begin the executor window. executor_window_begin is an optional explicit control when visible.";
    case "active":
      return "Continue the current task normally. The task may span arbitrarily many turns.";
    case "drain":
      return "Finish the current local causal chain, persist a recoverable checkpoint or handoff, and do not open a new major frontier.";
    case "yield_required":
      return "New mutation and new command execution are closed. Read or reconcile state, poll or interrupt an existing process, persist a recoverable handoff, then end this assistant turn. Call executor_window_yield when that tool is visible.";
    case "yielded":
      return "This assistant turn has yielded. The next scoped tool call will begin a new executor window; executor_window_begin may do so explicitly when visible.";
  }
}

export class ExecutorWindowRegistry {
  readonly config: ExecutorWindowConfig;
  private readonly now: () => number;
  private readonly entries = new Map<string, ExecutorWindowEntry>();

  constructor(
    config: ExecutorWindowConfig,
    options: ExecutorWindowRegistryOptions = {},
  ) {
    if (config.drainAfterMs < 1) {
      throw new Error("Executor window drainAfterMs must be positive.");
    }
    if (config.yieldAfterMs <= config.drainAfterMs) {
      throw new Error("Executor window yieldAfterMs must be greater than drainAfterMs.");
    }
    if (config.retentionMs < config.yieldAfterMs) {
      throw new Error("Executor window retentionMs must be at least yieldAfterMs.");
    }
    this.config = config;
    this.now = options.now ?? Date.now;
  }

  begin(
    scopeId: string | undefined,
    reason: ExecutorWindowBeginReason,
  ): ExecutorWindowBeginResult {
    if (!this.config.enabled || !scopeId) {
      return {
        started: false,
        reason,
        status: this.status(scopeId),
      };
    }

    this.cleanup();
    const key = executionScopeRef(scopeId);
    const previous = this.entries.get(key);
    if (previous) {
      const current = this.status(scopeId);
      const recoveryAllowed = current.phase === "yielded"
        || (
          reason === "recovery_after_cutoff"
          && current.phase === "yield_required"
        );
      if (!recoveryAllowed) {
        return {
          started: false,
          reason,
          previousWindowId: previous.windowId,
          previousHandoff: previous.handoff ?? previous.previousHandoff,
          status: current,
        };
      }
    }
    const now = this.now();
    const entry: ExecutorWindowEntry = {
      windowId: randomUUID(),
      generation: (previous?.generation ?? 0) + 1,
      startedAtMs: now,
      lastActivityAtMs: now,
      previousHandoff: previous?.handoff ?? previous?.previousHandoff,
    };
    this.entries.set(key, entry);

    return {
      started: true,
      reason,
      previousWindowId: previous?.windowId,
      previousHandoff: entry.previousHandoff,
      status: this.status(scopeId),
    };
  }

  yield(
    scopeId: string | undefined,
    handoff: ExecutorWindowHandoff,
  ): ExecutorWindowStatus {
    if (!this.config.enabled || !scopeId) return this.status(scopeId);

    const key = executionScopeRef(scopeId);
    const entry = this.entries.get(key);
    if (!entry) return this.status(scopeId);

    const now = this.now();
    entry.lastActivityAtMs = now;
    entry.yieldedAtMs = now;
    entry.handoff = handoff;
    return this.status(scopeId);
  }

  status(scopeId: string | undefined): ExecutorWindowStatus {
    if (!this.config.enabled) {
      return {
        schemaVersion: 1,
        enabled: false,
        scoped: Boolean(scopeId),
        phase: "disabled",
        drainAfterMs: this.config.drainAfterMs,
        yieldAfterMs: this.config.yieldAfterMs,
        instruction: statusInstruction("disabled"),
      };
    }
    if (!scopeId) {
      return {
        schemaVersion: 1,
        enabled: true,
        scoped: false,
        phase: "unscoped",
        drainAfterMs: this.config.drainAfterMs,
        yieldAfterMs: this.config.yieldAfterMs,
        instruction: statusInstruction("unscoped"),
      };
    }

    return this.statusByScopeRef(executionScopeRef(scopeId));
  }

  statusByScopeRef(scopeRef: string): ExecutorWindowStatus {
    if (!/^[a-f0-9]{16}$/.test(scopeRef)) {
      throw new Error(`Invalid execution scope reference: ${scopeRef}`);
    }
    if (!this.config.enabled) {
      return {
        schemaVersion: 1,
        enabled: false,
        scoped: true,
        scopeRef,
        phase: "disabled",
        drainAfterMs: this.config.drainAfterMs,
        yieldAfterMs: this.config.yieldAfterMs,
        instruction: statusInstruction("disabled"),
      };
    }

    this.cleanup();
    const key = scopeRef;
    const entry = this.entries.get(key);
    if (!entry) {
      return {
        schemaVersion: 1,
        enabled: true,
        scoped: true,
        scopeRef: key,
        phase: "not_started",
        drainAfterMs: this.config.drainAfterMs,
        yieldAfterMs: this.config.yieldAfterMs,
        instruction: statusInstruction("not_started"),
      };
    }

    const now = this.now();
    const elapsed = Math.max(0, now - entry.startedAtMs);
    const phase: ExecutorWindowPhase = entry.yieldedAtMs !== undefined
      ? "yielded"
      : elapsed >= this.config.yieldAfterMs
        ? "yield_required"
        : elapsed >= this.config.drainAfterMs
          ? "drain"
          : "active";

    return {
      schemaVersion: 1,
      enabled: true,
      scoped: true,
      scopeRef: key,
      windowId: entry.windowId,
      generation: entry.generation,
      phase,
      startedAt: iso(entry.startedAtMs),
      lastActivityAt: iso(entry.lastActivityAtMs),
      elapsedMs: elapsed,
      drainAfterMs: this.config.drainAfterMs,
      yieldAfterMs: this.config.yieldAfterMs,
      drainInMs: boundedRemaining(this.config.drainAfterMs, elapsed),
      yieldInMs: boundedRemaining(this.config.yieldAfterMs, elapsed),
      yieldedAt: iso(entry.yieldedAtMs),
      handoff: entry.handoff,
      previousHandoff: entry.previousHandoff,
      instruction: statusInstruction(phase),
    };
  }

  beforeTool(
    scopeId: string | undefined,
    toolName: string,
    input: unknown,
    readOnlyHint: boolean,
  ): ExecutorWindowGateDecision {
    const status = this.status(scopeId);
    if (!this.config.enabled || !scopeId || WINDOW_TOOL_NAMES.has(toolName)) {
      return { allowed: true, status };
    }

    if (status.phase === "not_started") {
      this.begin(scopeId, "new_turn");
      return {
        allowed: true,
        status: this.status(scopeId),
        transition: "auto_begin",
      };
    }
    if (status.phase === "yielded") {
      this.begin(scopeId, "new_turn");
      return {
        allowed: true,
        status: this.status(scopeId),
        transition: "auto_resume_after_yield",
      };
    }
    if (status.phase !== "yield_required") {
      this.touch(scopeId);
      return { allowed: true, status: this.status(scopeId) };
    }

    const safe = YIELD_SAFE_READ_TOOLS.has(toolName)
      || (readOnlyHint && toolName !== "open_workspace")
      || (toolName === "write_stdin" && safeWriteStdin(input));
    if (!safe) {
      return { allowed: false, status, reason: "yield_required" };
    }

    this.touch(scopeId);
    return { allowed: true, status: this.status(scopeId) };
  }

  touch(scopeId: string | undefined): void {
    if (!scopeId) return;
    const entry = this.entries.get(executionScopeRef(scopeId));
    if (entry) entry.lastActivityAtMs = this.now();
  }

  private cleanup(): void {
    const cutoff = this.now() - this.config.retentionMs;
    for (const [key, entry] of this.entries) {
      if (entry.lastActivityAtMs < cutoff) this.entries.delete(key);
    }
  }
}

function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return "unknown";
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds]
    .map((value) => String(value).padStart(2, "0"))
    .join(":");
}

export function executorWindowFooter(status: ExecutorWindowStatus): string {
  if (!status.enabled || status.phase === "disabled") return "";
  if (status.phase === "unscoped") {
    return "[executor-window] UNSCOPED — host supplied no stable executor scope; no turn guard was enforced.";
  }
  if (status.phase === "not_started") {
    return "[executor-window] NOT_STARTED — the first scoped tool call will begin the window automatically.";
  }
  if (status.phase === "yielded") {
    return "[executor-window] YIELDED — end this assistant turn. The next scoped tool call will begin a new window.";
  }

  const timing = `elapsed ${formatDuration(status.elapsedMs)} · drain in ${formatDuration(status.drainInMs)} · yield in ${formatDuration(status.yieldInMs)}`;
  if (status.phase === "active") {
    return `[executor-window] ACTIVE · ${timing}`;
  }
  if (status.phase === "drain") {
    return `[executor-window] DRAIN · ${timing}\nFinish the current local causal chain, persist a recoverable handoff/checkpoint, and do not open a new major frontier or long-running command.`;
  }
  return `[executor-window] YIELD_REQUIRED · ${timing}\nNew mutation and new commands are closed. Read/reconcile, poll or interrupt an existing process, persist a recoverable handoff/checkpoint, then end this assistant turn. Call executor_window_yield when available.`;
}

export function executorWindowBlockedText(
  decision: ExecutorWindowGateDecision,
): string {
  const footer = executorWindowFooter(decision.status);
  switch (decision.reason) {
    case "window_not_started":
      return `${footer}\nThe task remains open; begin a bounded executor window before continuing.`;
    case "window_yielded":
      return `${footer}\nDo not resume work in the yielded assistant turn.`;
    case "yield_required":
      return `${footer}\nThis tool was blocked because it would start new mutation or execution after the controlled landing boundary.`;
    default:
      return footer;
  }
}
