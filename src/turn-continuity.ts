import { createHash, randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { openDatabase, type DatabaseHandle } from "./db/client.js";
import { getGitEligibility, git } from "./git.js";
import type {
  ExecutionScopeIdentity,
  ExecutorTurnMetadata,
} from "./request-meta.js";
import type { Workspace } from "./workspaces.js";

export interface TurnContinuityConfig {
  enabled: boolean;
  estimatedTurnMs: number;
  awarenessAfterMs: number;
  landingAfterMs: number;
  capsuleRetentionMs: number;
  maxCapsulesPerWorkspace: number;
  maxCapsuleCharacters: number;
}

export type TurnHorizonBeginReason =
  | "new_turn"
  | "recovery_after_cutoff"
  | "manual_test";

export type RecoveryCapsuleIntent =
  | "rolling"
  | "turn_boundary"
  | "before_effect"
  | "after_effect";

export type RecoveryWorktreeState =
  | "clean"
  | "intentional_dirty"
  | "unknown";

export type RecoveryValidationState =
  | "unknown"
  | "not_run"
  | "partial"
  | "failed"
  | "passed";

export type RecoveryEffectState =
  | "none"
  | "in_flight"
  | "terminal"
  | "unknown";

export type RecoveryWriterState =
  | "none"
  | "held"
  | "released"
  | "unknown";

export type RecoveryRetryPolicy =
  | "normal"
  | "forbidden"
  | "reconcile_before_retry"
  | "owner_authorization_required";

export interface RecoveryCapsuleInput {
  idempotencyKey: string;
  intent: RecoveryCapsuleIntent;
  missionRef?: string;
  authorityOwnerRefs?: string[];
  authorityStateRefs?: string[];
  currentFrontier: string;
  currentCausalSlice: string;
  established?: string[];
  validationState: RecoveryValidationState;
  validationRefs?: string[];
  worktreeState: RecoveryWorktreeState;
  effectState: RecoveryEffectState;
  effectKeys?: string[];
  writerState?: RecoveryWriterState;
  writerRefs?: string[];
  retryPolicy: RecoveryRetryPolicy;
  safeToMutate?: boolean;
  safeToPublish?: boolean;
  exactNextAction: string;
  doNotRepeat?: string[];
  unresolved?: string[];
  checkpointRefs?: string[];
  notes?: string;
}

export interface TurnContinuityManagerOptions {
  now?: () => number;
}

type HorizonSource = "host_turn" | "host_deadline" | "explicit";
type HorizonAdvisory =
  | "not_started"
  | "normal"
  | "checkpoint_awareness"
  | "landing_opportunity";

interface HorizonRow {
  scope_ref: string;
  epoch_id: string;
  source: HorizonSource;
  turn_ref: string | null;
  explicit_key_digest_sha256: string | null;
  started_at_ms: number;
  deadline_at_ms: number | null;
  last_activity_at_ms: number;
  last_mutation_at_ms: number | null;
  last_checkpoint_at_ms: number | null;
  last_checkpoint_id: string | null;
  awareness_emitted_at_ms: number | null;
  landing_emitted_at_ms: number | null;
  stale_checkpoint_notice_emitted_at_ms: number | null;
  capsule_nudge_emitted_at_ms: number | null;
}

interface CapsuleRow {
  id: string;
  scope_ref: string;
  workspace_session_id: string;
  workspace_root_digest_sha256: string;
  generation: number;
  idempotency_key_digest_sha256: string;
  intent: RecoveryCapsuleIntent;
  semantic_json: string;
  semantic_digest_sha256: string;
  fingerprint_json: string;
  state_digest_sha256: string;
  recorded_event_sequence: number | null;
  recorded_at_ms: number;
}

interface RecoveryEvidenceEventRow {
  sequence: number;
  tool_name: string;
  outcome: string;
  started_at_ms: number;
  completed_at_ms: number | null;
  duration_ms: number | null;
  workspace_id: string | null;
  process_session_id: number | null;
  detail_json: string | null;
  error_kind: string | null;
  error_summary: string | null;
  error_digest_sha256: string | null;
}

interface RecoverySemanticState {
  missionRef?: string;
  authorityOwnerRefs: string[];
  authorityStateRefs: string[];
  currentFrontier: string;
  currentCausalSlice: string;
  established: string[];
  validationState: RecoveryValidationState;
  validationRefs: string[];
  worktreeState: RecoveryWorktreeState;
  effectState: RecoveryEffectState;
  effectKeys: string[];
  writerState: RecoveryWriterState;
  writerRefs: string[];
  retryPolicy: RecoveryRetryPolicy;
  safeToMutate?: boolean;
  safeToPublish?: boolean;
  exactNextAction: string;
  doNotRepeat: string[];
  unresolved: string[];
  checkpointRefs: string[];
  notes?: string;
}

interface WorkspaceFingerprint {
  schemaVersion: 1;
  kind: "git" | "non_git";
  workspaceRootDigestSha256: string;
  gitRootDigestSha256?: string;
  head?: string;
  headTree?: string;
  branch?: string;
  statusDigestSha256?: string;
  trackedDiffDigestSha256?: string;
  untrackedDigestSha256?: string;
  stagedPathCount?: number;
  unstagedPathCount?: number;
  untrackedPathCount?: number;
  dirty?: boolean;
  complete: boolean;
  limitation?: string;
  stateDigestSha256: string;
}

const MAX_TEXT_CHARACTERS = 4_000;
const MAX_ARRAY_ITEMS = 50;
const MAX_ARRAY_TEXT_CHARACTERS = 2_000;
const MAX_UNTRACKED_HASH_PATHS = 200;
const MAX_GIT_OUTPUT_BYTES = 50 * 1024 * 1024;
const EXPLICIT_KEY_MAX_CHARACTERS = 200;
const MAX_RECOVERY_EVIDENCE_EVENTS = 20;
const CONTROL_TOOL_NAMES = new Set([
  "turn_horizon_begin",
  "turn_horizon_status",
  "recovery_capsule_record",
  "recovery_capsule_status",
]);
const POTENTIALLY_MUTATING_TOOLS = new Set([
  "apply_patch",
  "write",
  "write_file",
  "edit",
  "edit_file",
  "bash",
  "shell",
  "exec_command",
  "download_artifact",
]);
const CAPSULE_ADOPTION_NUDGE_TOOLS = new Set([
  "apply_patch",
  "write",
  "write_file",
  "edit",
  "edit_file",
  "download_artifact",
]);

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function iso(ms: number | null | undefined): string | undefined {
  return ms === null || ms === undefined ? undefined : new Date(ms).toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseOptionalRecordJson(value: string | null): Record<string, unknown> | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
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

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function requireIdentity(
  identity: ExecutionScopeIdentity | undefined,
): ExecutionScopeIdentity {
  if (!identity) {
    throw new Error(
      "A stable execution scope is required for turn continuity and recovery capsules.",
    );
  }
  return identity;
}

function boundedText(
  value: string | undefined,
  name: string,
  required = false,
  maximum = MAX_TEXT_CHARACTERS,
): string | undefined {
  const normalized = value?.trim();
  if (!normalized) {
    if (required) throw new Error(`${name} must not be empty.`);
    return undefined;
  }
  if (normalized.length > maximum) {
    throw new Error(`${name} exceeds the ${maximum}-character limit.`);
  }
  return normalized;
}

function boundedList(
  values: string[] | undefined,
  name: string,
): string[] {
  if (!values) return [];
  if (values.length > MAX_ARRAY_ITEMS) {
    throw new Error(`${name} exceeds the ${MAX_ARRAY_ITEMS}-item limit.`);
  }
  const normalized = values.map((value, index) =>
    boundedText(
      value,
      `${name}[${index}]`,
      true,
      MAX_ARRAY_TEXT_CHARACTERS,
    ) as string
  );
  return Array.from(new Set(normalized));
}

function compactHintText(value: string | undefined, maximum: number): string | undefined {
  if (!value) return undefined;
  return value.length <= maximum
    ? value
    : `${value.slice(0, Math.max(0, maximum - 3))}...`;
}

function splitNul(value: string): string[] {
  return value.split("\0").filter((entry) => entry.length > 0);
}

function potentiallyMutatingTool(toolName: string, input: unknown): boolean {
  if (POTENTIALLY_MUTATING_TOOLS.has(toolName)) return true;
  if (toolName !== "write_stdin" || !isRecord(input)) return false;
  const chars = input.chars;
  return typeof chars === "string" && chars.length > 0 && chars !== "\u0003";
}

function horizonInstruction(advisory: HorizonAdvisory): string {
  switch (advisory) {
    case "not_started":
      return "Call turn_horizon_begin once near the first tool call of this assistant turn when the host supplies no exact turn identity. This starts advisory timing only and never creates or limits a task.";
    case "normal":
      return "Continue the mission normally. Preserve judgment, dynamic replanning, and full validation quality.";
    case "checkpoint_awareness":
      return "Continue the current causal work normally, but keep a recent recovery capsule. Do not change frontier merely because the estimated host horizon is approaching.";
    case "landing_opportunity":
      return "At the nearest recoverable causal cut, record or refresh a recovery capsule and end only the assistant turn. Do not rush task completion, weaken validation, force a commit, retry an effect, or abandon the current mission.";
  }
}

function horizonNotice(advisory: Exclude<HorizonAdvisory, "not_started" | "normal">): string {
  if (advisory === "checkpoint_awareness") {
    return [
      "[turn-horizon advisory]",
      "The estimated host turn horizon is approaching. Continue the current causal work normally and keep a recent recovery capsule. Do not change frontier, rush the task, reduce validation, or force a commit because of this notice. Tools remain fully available.",
    ].join("\n");
  }
  return [
    "[turn-horizon landing opportunity]",
    "Use the nearest recoverable causal cut to refresh a recovery capsule and end only this assistant turn. Do not rush task completion, weaken validation, force a commit, retry an effect, or abandon the mission. Tools remain fully available and this notice grants no task, writer, effect, or publication authority.",
  ].join("\n");
}

function staleCheckpointNotice(): string {
  return [
    "[recovery capsule changed]",
    "Potentially mutating work occurred after the latest capsule during the landing window. Refresh the capsule at the next recoverable causal cut; continue normal work until that cut and do not manufacture task completion.",
  ].join("\n");
}

function capsuleAdoptionNotice(): string {
  return [
    "[recovery capsule available]",
    "This assistant turn has completed potentially mutating executor work without an explicit semantic recovery capsule for the current turn. Continue the current causal chain normally. At the next natural material transition, record a rolling capsule with the mission, frontier, current causal slice, validation/effect safety, exact next action, and do-not-repeat constraints. Do not interrupt the work, force a commit, reduce validation, or treat the capsule as canonical authority.",
  ].join("\n");
}

export class TurnContinuityManager {
  private readonly database: DatabaseHandle;
  private readonly now: () => number;
  private nextPruneAtMs = 0;

  constructor(
    readonly config: TurnContinuityConfig,
    stateDir: string,
    options: TurnContinuityManagerOptions = {},
  ) {
    this.database = openDatabase(stateDir);
    this.now = options.now ?? Date.now;
    if (config.enabled) this.prune(this.now());
  }

  begin(
    identity: ExecutionScopeIdentity | undefined,
    metadata: ExecutorTurnMetadata,
    input: { idempotencyKey: string; reason: TurnHorizonBeginReason },
  ): Record<string, unknown> {
    if (!this.config.enabled) return this.disabledResult();
    const scope = requireIdentity(identity);
    const nowMs = this.now();
    const host = this.ensureHostEpoch(scope, metadata, nowMs);
    if (host) {
      return {
        schemaVersion: 1,
        started: false,
        reason: input.reason,
        hostBoundaryPreferred: true,
        status: this.horizonView(host, nowMs),
        policy: this.policy(),
      };
    }

    const idempotencyKey = boundedText(
      input.idempotencyKey,
      "idempotencyKey",
      true,
      EXPLICIT_KEY_MAX_CHARACTERS,
    ) as string;
    const keyDigest = sha256(idempotencyKey);
    const current = this.getHorizon(scope.scopeRef);
    if (
      current?.source === "explicit"
      && current.explicit_key_digest_sha256 === keyDigest
    ) {
      return {
        schemaVersion: 1,
        started: false,
        idempotentReplay: true,
        reason: input.reason,
        status: this.horizonView(current, nowMs),
        policy: this.policy(),
      };
    }

    const row = this.startEpoch(scope.scopeRef, {
      source: "explicit",
      explicitKeyDigestSha256: keyDigest,
      startedAtMs: nowMs,
      deadlineAtMs: undefined,
    });
    return {
      schemaVersion: 1,
      started: true,
      reason: input.reason,
      status: this.horizonView(row, nowMs),
      policy: this.policy(),
    };
  }

  status(
    identity: ExecutionScopeIdentity | undefined,
    metadata: ExecutorTurnMetadata,
  ): Record<string, unknown> {
    if (!this.config.enabled) return this.disabledResult();
    const scope = requireIdentity(identity);
    const nowMs = this.now();
    const row = this.ensureHostEpoch(scope, metadata, nowMs)
      ?? this.getHorizon(scope.scopeRef);
    return {
      schemaVersion: 1,
      enabled: true,
      status: row
        ? this.horizonView(row, nowMs)
        : {
            scopeRef: scope.scopeRef,
            advisory: "not_started",
            instruction: horizonInstruction("not_started"),
            toolsBlocked: false,
            taskCompletionRequired: false,
          },
      policy: this.policy(),
    };
  }

  observeToolStart(
    identity: ExecutionScopeIdentity | undefined,
    metadata: ExecutorTurnMetadata,
    toolName: string,
  ): void {
    if (!this.config.enabled || !identity || CONTROL_TOOL_NAMES.has(toolName)) return;
    const nowMs = this.now();
    const row = this.ensureHostEpoch(identity, metadata, nowMs)
      ?? this.getHorizon(identity.scopeRef);
    if (!row) return;
    this.database.sqlite
      .prepare(
        "update execution_turn_horizons set last_activity_at_ms = ? where scope_ref = ?",
      )
      .run(nowMs, identity.scopeRef);
  }

  observeToolFinish(
    identity: ExecutionScopeIdentity | undefined,
    metadata: ExecutorTurnMetadata,
    toolName: string,
    input: unknown,
    succeeded: boolean,
  ): void {
    if (!this.config.enabled || !identity || CONTROL_TOOL_NAMES.has(toolName)) return;
    const nowMs = this.now();
    const row = this.ensureHostEpoch(identity, metadata, nowMs)
      ?? this.getHorizon(identity.scopeRef);
    if (!row) return;
    const mutationAt = succeeded && potentiallyMutatingTool(toolName, input)
      ? nowMs
      : undefined;
    this.database.sqlite
      .prepare(`
        update execution_turn_horizons
           set last_activity_at_ms = ?,
               last_mutation_at_ms = coalesce(?, last_mutation_at_ms)
         where scope_ref = ?
      `)
      .run(nowMs, mutationAt ?? null, identity.scopeRef);
    this.maybePrune(nowMs);
  }

  advisoryNotice(
    identity: ExecutionScopeIdentity | undefined,
    metadata: ExecutorTurnMetadata,
    toolName: string,
  ): string | undefined {
    if (!this.config.enabled || !identity || CONTROL_TOOL_NAMES.has(toolName)) {
      return undefined;
    }
    const nowMs = this.now();
    const row = this.ensureHostEpoch(identity, metadata, nowMs)
      ?? this.getHorizon(identity.scopeRef);
    if (!row) return undefined;
    const view = this.horizonView(row, nowMs);
    const advisory = view.advisory as HorizonAdvisory;
    const latestCapsule = this.latestCapsuleForScope(identity.scopeRef);
    const currentTurnHasCapsule = latestCapsule !== undefined
      && latestCapsule.recorded_at_ms >= row.started_at_ms;

    if (
      CAPSULE_ADOPTION_NUDGE_TOOLS.has(toolName)
      && row.last_mutation_at_ms !== null
      && !currentTurnHasCapsule
      && row.capsule_nudge_emitted_at_ms === null
    ) {
      this.database.sqlite
        .prepare(`
          update execution_turn_horizons
             set capsule_nudge_emitted_at_ms = ?
           where scope_ref = ?
        `)
        .run(nowMs, identity.scopeRef);
      return capsuleAdoptionNotice();
    }

    if (advisory === "landing_opportunity" && row.landing_emitted_at_ms === null) {
      this.database.sqlite
        .prepare(`
          update execution_turn_horizons
             set awareness_emitted_at_ms = coalesce(awareness_emitted_at_ms, ?),
                 landing_emitted_at_ms = ?
           where scope_ref = ?
        `)
        .run(nowMs, nowMs, identity.scopeRef);
      return horizonNotice("landing_opportunity");
    }

    if (
      advisory === "checkpoint_awareness"
      && row.awareness_emitted_at_ms === null
    ) {
      this.database.sqlite
        .prepare(`
          update execution_turn_horizons
             set awareness_emitted_at_ms = ?
           where scope_ref = ?
        `)
        .run(nowMs, identity.scopeRef);
      return horizonNotice("checkpoint_awareness");
    }

    if (
      advisory === "landing_opportunity"
      && row.landing_emitted_at_ms !== null
      && currentTurnHasCapsule
      && row.last_mutation_at_ms !== null
      && (
        row.last_checkpoint_at_ms === null
        || row.last_mutation_at_ms > row.last_checkpoint_at_ms
      )
      && row.stale_checkpoint_notice_emitted_at_ms === null
    ) {
      this.database.sqlite
        .prepare(`
          update execution_turn_horizons
             set stale_checkpoint_notice_emitted_at_ms = ?
           where scope_ref = ?
        `)
        .run(nowMs, identity.scopeRef);
      return staleCheckpointNotice();
    }

    return undefined;
  }

  async recordCapsule(
    identity: ExecutionScopeIdentity | undefined,
    workspace: Pick<Workspace, "id" | "root">,
    input: RecoveryCapsuleInput,
  ): Promise<Record<string, unknown>> {
    if (!this.config.enabled) return this.disabledResult();
    const scope = requireIdentity(identity);
    const nowMs = this.now();
    const semantic = this.normalizeSemantic(input);
    const semanticJson = canonicalJson(semantic);
    if (semanticJson.length > this.config.maxCapsuleCharacters) {
      throw new Error(
        `Recovery capsule exceeds the ${this.config.maxCapsuleCharacters}-character limit.`,
      );
    }
    const fingerprint = await workspaceFingerprint(workspace);
    const fingerprintJson = canonicalJson(fingerprint);
    const idempotencyKey = boundedText(
      input.idempotencyKey,
      "idempotencyKey",
      true,
      EXPLICIT_KEY_MAX_CHARACTERS,
    ) as string;
    const idempotencyKeyDigestSha256 = sha256(idempotencyKey);
    const existing = this.database.sqlite
      .prepare(`
        select * from execution_recovery_capsules
         where scope_ref = ? and idempotency_key_digest_sha256 = ?
      `)
      .get(scope.scopeRef, idempotencyKeyDigestSha256) as CapsuleRow | undefined;
    if (existing) {
      if (
        existing.intent !== input.intent
        || existing.semantic_digest_sha256 !== sha256(semanticJson)
        || existing.state_digest_sha256 !== fingerprint.stateDigestSha256
      ) {
        throw new Error(
          "Recovery capsule idempotency key was already used for a different payload or workspace state.",
        );
      }
      return {
        schemaVersion: 1,
        recorded: false,
        idempotentReplay: true,
        capsule: {
          capsuleId: existing.id,
          generation: existing.generation,
          sourceScopeRef: existing.scope_ref,
          workspaceId: existing.workspace_session_id,
          intent: existing.intent,
          recordedAt: iso(existing.recorded_at_ms),
          semantic,
          semanticDigestSha256: existing.semantic_digest_sha256,
          fingerprint,
          freshness: fingerprint.complete ? "fresh" : "unknown",
        },
        policy: this.capsulePolicy(),
      };
    }
    const id = `rcp_${randomUUID().replaceAll("-", "")}`;

    const transaction = this.database.sqlite.transaction(() => {
      const eventRow = this.database.sqlite
        .prepare(`
          select max(sequence) as sequence
            from execution_scope_events
           where scope_ref = ? and tool_name = 'recovery_capsule_record'
             and outcome = 'running'
        `)
        .get(scope.scopeRef) as { sequence: number | null };
      const generationRow = this.database.sqlite
        .prepare(`
          select coalesce(max(generation), 0) + 1 as generation
            from execution_recovery_capsules
           where workspace_root_digest_sha256 = ?
        `)
        .get(fingerprint.workspaceRootDigestSha256) as { generation: number };
      this.database.sqlite
        .prepare(`
          insert into execution_recovery_capsules (
            id, scope_ref, workspace_session_id, workspace_root_digest_sha256,
            generation, idempotency_key_digest_sha256, intent,
            semantic_json, semantic_digest_sha256,
            fingerprint_json, state_digest_sha256, recorded_event_sequence,
            recorded_at_ms
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          id,
          scope.scopeRef,
          workspace.id,
          fingerprint.workspaceRootDigestSha256,
          generationRow.generation,
          idempotencyKeyDigestSha256,
          input.intent,
          semanticJson,
          sha256(semanticJson),
          fingerprintJson,
          fingerprint.stateDigestSha256,
          eventRow.sequence,
          nowMs,
        );
      this.pruneWorkspaceCapsules(fingerprint.workspaceRootDigestSha256, nowMs);
      return generationRow.generation;
    });
    const generation = transaction.immediate();
    this.noteCheckpoint(scope.scopeRef, id, nowMs);
    return {
      schemaVersion: 1,
      recorded: true,
      capsule: {
        capsuleId: id,
        generation,
        sourceScopeRef: scope.scopeRef,
        workspaceId: workspace.id,
        intent: input.intent,
        recordedAt: iso(nowMs),
        semantic,
        semanticDigestSha256: sha256(semanticJson),
        fingerprint,
        freshness: fingerprint.complete ? "fresh" : "unknown",
      },
      policy: this.capsulePolicy(),
    };
  }

  async capsuleStatus(
    identity: ExecutionScopeIdentity | undefined,
    workspace: Pick<Workspace, "id" | "root">,
    options: { currentAuthorityStateRefs?: string[] } = {},
  ): Promise<Record<string, unknown>> {
    if (!this.config.enabled) return this.disabledResult();
    const scope = requireIdentity(identity);
    const current = await workspaceFingerprint(workspace);
    const row = this.latestCapsule(current.workspaceRootDigestSha256);
    if (!row) {
      return {
        schemaVersion: 1,
        available: false,
        workspaceId: workspace.id,
        currentFingerprint: current,
        instruction:
          "No recovery capsule exists for this exact opened workspace root. Record one at the next material transition or recoverable causal cut.",
        policy: this.capsulePolicy(),
      };
    }
    const recordedFingerprint = parseFingerprint(row.fingerprint_json);
    let semantic: RecoverySemanticState;
    try {
      semantic = parseSemantic(row.semantic_json);
    } catch {
      return {
        schemaVersion: 1,
        available: false,
        workspaceId: workspace.id,
        currentFingerprint: current,
        reason: "stored_recovery_capsule_invalid",
        policy: this.capsulePolicy(),
      };
    }
    const workspaceComparison = compareFingerprint(recordedFingerprint, current);
    const authorityComparison = compareAuthorityStateRefs(
      semantic.authorityStateRefs,
      boundedList(
        options.currentAuthorityStateRefs,
        "currentAuthorityStateRefs",
      ),
    );
    const exactActionReliance = exactActionRelianceDisposition(
      workspaceComparison.freshness,
      authorityComparison.freshness,
    );
    return {
      schemaVersion: 1,
      available: true,
      capsule: {
        capsuleId: row.id,
        generation: row.generation,
        sourceScopeRef: row.scope_ref,
        sourceWorkspaceId: row.workspace_session_id,
        sameExecutionScope: row.scope_ref === scope.scopeRef,
        intent: row.intent,
        recordedAt: iso(row.recorded_at_ms),
        semantic,
        semanticDigestSha256: row.semantic_digest_sha256,
        recordedFingerprint,
      },
      currentWorkspaceId: workspace.id,
      currentFingerprint: current,
      workspaceFreshness: workspaceComparison.freshness,
      workspaceStaleReasons: workspaceComparison.reasons,
      authorityFreshness: authorityComparison.freshness,
      authorityComparison: {
        recordedStateRefCount: semantic.authorityStateRefs.length,
        currentStateRefCount: authorityComparison.currentRefs.length,
        recordedStateRefsDigestSha256: sha256(canonicalJson(semantic.authorityStateRefs)),
        currentStateRefsDigestSha256: sha256(canonicalJson(authorityComparison.currentRefs)),
        mismatchReason: authorityComparison.reason,
      },
      exactNextActionCandidate: semantic.exactNextAction,
      exactActionReliance,
      exactActionCandidateAvailable:
        exactActionReliance === "candidate_available_after_supplied_authority_match",
      recommendedAction: recommendedRecoveryAction(
        workspaceComparison.freshness,
        authorityComparison.freshness,
        semantic.exactNextAction,
      ),
      policy: this.capsulePolicy(),
    };
  }

  semanticListHintForScope(
    scopeRef: string,
    options: { observedScopeTotalEventCount?: number } = {},
  ): Record<string, unknown> {
    if (!this.config.enabled) {
      return {
        available: false,
        reason: "turn_continuity_disabled",
      };
    }
    if (!/^[a-f0-9]{16}$/.test(scopeRef)) {
      throw new Error(`Invalid execution scope reference: ${scopeRef}`);
    }
    const row = this.latestCapsuleForScope(scopeRef);
    if (!row) {
      return {
        available: false,
        reason: "no_explicit_recovery_capsule_for_scope",
      };
    }
    let semantic: RecoverySemanticState;
    try {
      semantic = parseSemantic(row.semantic_json);
    } catch {
      return {
        available: false,
        reason: "stored_recovery_capsule_invalid",
      };
    }
    const displayLabelSource = semantic.missionRef
      ? "recovery_capsule_mission_ref"
      : "recovery_capsule_current_frontier";
    const observedActivityAfterCapsule = row.recorded_event_sequence !== null
      && options.observedScopeTotalEventCount !== undefined
      ? options.observedScopeTotalEventCount > row.recorded_event_sequence
      : undefined;
    return {
      available: true,
      source: "latest_explicit_recovery_capsule_for_scope",
      displayLabel: compactHintText(
        semantic.missionRef ?? semantic.currentFrontier,
        160,
      ),
      displayLabelSource,
      labelIsHostChatTitle: false,
      missionRef: compactHintText(semantic.missionRef, 240),
      currentFrontier: compactHintText(semantic.currentFrontier, 360),
      currentCausalSlice: compactHintText(semantic.currentCausalSlice, 360),
      capsuleId: row.id,
      generation: row.generation,
      recordedAt: iso(row.recorded_at_ms),
      observedActivityAfterCapsule,
      authorityFreshness: "unverified",
      exactActionReliance: "requires_current_authority_reconciliation",
    };
  }

  async semanticProjectionForScope(
    scopeRef: string,
    options: {
      observedScopeLastActivityAtMs?: number;
      observedScopeTotalEventCount?: number;
    } = {},
  ): Promise<Record<string, unknown>> {
    if (!this.config.enabled) {
      return {
        available: false,
        reason: "turn_continuity_disabled",
        policy: this.semanticProjectionPolicy(),
      };
    }
    if (!/^[a-f0-9]{16}$/.test(scopeRef)) {
      throw new Error(`Invalid execution scope reference: ${scopeRef}`);
    }
    const row = this.latestCapsuleForScope(scopeRef);
    if (!row) {
      return {
        available: false,
        reason: "no_explicit_recovery_capsule_for_scope",
        instruction:
          "Operational activity is available, but this scope has not explicitly recorded a bounded semantic recovery capsule. Do not infer mission or next action from filenames or tool events alone.",
        policy: this.semanticProjectionPolicy(),
      };
    }

    const semantic = parseSemantic(row.semantic_json);
    const recordedFingerprint = parseFingerprint(row.fingerprint_json);
    const workspace = this.database.sqlite
      .prepare("select id, root from workspace_sessions where id = ?")
      .get(row.workspace_session_id) as { id: string; root: string } | undefined;
    let currentFingerprint: WorkspaceFingerprint | undefined;
    let workspaceComparison: ReturnType<typeof compareFingerprint> = {
      freshness: "unknown",
      reasons: ["recorded_workspace_session_unavailable"],
    };
    if (workspace) {
      try {
        currentFingerprint = await workspaceFingerprint({
          id: workspace.id,
          root: workspace.root,
        });
        workspaceComparison = compareFingerprint(
          recordedFingerprint,
          currentFingerprint,
        );
      } catch {
        workspaceComparison = {
          freshness: "unknown",
          reasons: ["current_workspace_fingerprint_unavailable"],
        };
      }
    }

    const horizon = this.getHorizon(scopeRef);
    const observedActivityAtMs = options.observedScopeLastActivityAtMs
      ?? horizon?.last_activity_at_ms;
    const activityAfterCapsule = row.recorded_event_sequence !== null
      && options.observedScopeTotalEventCount !== undefined
      ? options.observedScopeTotalEventCount > row.recorded_event_sequence
      : observedActivityAtMs !== undefined
        && observedActivityAtMs > row.recorded_at_ms;
    const potentialMutationAfterCapsule = horizon?.last_mutation_at_ms !== null
      && horizon?.last_mutation_at_ms !== undefined
      && horizon.last_mutation_at_ms > row.recorded_at_ms;
    const authorityComparison = compareAuthorityStateRefs(
      semantic.authorityStateRefs,
      [],
    );
    const exactActionReliance = exactActionRelianceDisposition(
      workspaceComparison.freshness,
      authorityComparison.freshness,
    );
    const evidenceSinceCapsule = this.recoveryEvidenceSinceCapsule(
      row,
      options.observedScopeTotalEventCount,
    );
    const nowMs = this.now();

    return {
      available: true,
      source: "latest_explicit_recovery_capsule_for_scope",
      capsule: {
        capsuleId: row.id,
        generation: row.generation,
        intent: row.intent,
        sourceWorkspaceId: row.workspace_session_id,
        recordedAt: iso(row.recorded_at_ms),
        ageMs: Math.max(0, nowMs - row.recorded_at_ms),
        semanticDigestSha256: row.semantic_digest_sha256,
        recordedWorkspaceStateDigestSha256: row.state_digest_sha256,
        recordedEventSequence: row.recorded_event_sequence ?? undefined,
      },
      missionRef: semantic.missionRef,
      currentFrontier: semantic.currentFrontier,
      currentCausalSlice: semantic.currentCausalSlice,
      established: semantic.established,
      validation: {
        state: semantic.validationState,
        refs: semantic.validationRefs,
      },
      worktree: {
        declaredState: semantic.worktreeState,
        workspaceFreshness: workspaceComparison.freshness,
        staleReasons: workspaceComparison.reasons,
        currentWorkspaceStateDigestSha256:
          currentFingerprint?.stateDigestSha256,
      },
      authority: {
        ownerRefs: semantic.authorityOwnerRefs,
        recordedStateRefs: semantic.authorityStateRefs,
        freshness: authorityComparison.freshness,
        reason: authorityComparison.reason,
        currentReadbackSupplied: false,
      },
      writer: {
        state: semantic.writerState,
        refs: semantic.writerRefs,
      },
      effect: {
        state: semantic.effectState,
        keys: semantic.effectKeys,
        retryPolicy: semantic.retryPolicy,
      },
      safety: {
        safeToMutate: semantic.safeToMutate,
        safeToPublish: semantic.safeToPublish,
      },
      exactNextActionCandidate: semantic.exactNextAction,
      exactActionReliance,
      exactActionCandidateAvailable:
        exactActionReliance === "candidate_available_after_supplied_authority_match",
      doNotRepeat: semantic.doNotRepeat,
      unresolved: semantic.unresolved,
      checkpointRefs: semantic.checkpointRefs,
      activitySinceCapsule: {
        observedActivityAfterCapsule: activityAfterCapsule,
        latestObservedActivityAt: iso(observedActivityAtMs),
        potentialMutationAfterCapsule,
        latestPotentialMutationAt: iso(horizon?.last_mutation_at_ms),
      },
      evidenceSinceCapsule,
      classification: semanticProjectionClassification(
        workspaceComparison.freshness,
        activityAfterCapsule,
      ),
      instruction:
        "This is explicit executor-local semantic recovery state joined to current workspace and execution observations. Authority freshness is unverified in cross-scope status; rehydrate rightful owners before relying on the exact action.",
      policy: this.semanticProjectionPolicy(),
    };
  }

  private recoveryEvidenceSinceCapsule(
    capsule: CapsuleRow,
    observedScopeTotalEventCount: number | undefined,
  ): Record<string, unknown> {
    const sequenceAnchored = capsule.recorded_event_sequence !== null;
    const predicate = sequenceAnchored ? "sequence > ?" : "started_at_ms > ?";
    const anchor = sequenceAnchored
      ? capsule.recorded_event_sequence as number
      : capsule.recorded_at_ms;
    const aggregate = this.database.sqlite
      .prepare(`
        select count(*) as retained_count,
               max(sequence) as newest_sequence,
               sum(case when outcome = 'running' then 1 else 0 end) as running_count,
               sum(case when outcome = 'succeeded' then 1 else 0 end) as succeeded_count,
               sum(case when outcome = 'error' then 1 else 0 end) as error_count,
               sum(case when outcome = 'blocked' then 1 else 0 end) as blocked_count,
               sum(case when outcome = 'interrupted' then 1 else 0 end) as interrupted_count
          from execution_scope_events
         where scope_ref = ? and ${predicate}
      `)
      .get(capsule.scope_ref, anchor) as Record<string, unknown>;
    const rows = this.database.sqlite
      .prepare(`
        select sequence, tool_name, outcome, started_at_ms, completed_at_ms,
               duration_ms, workspace_id, process_session_id, detail_json,
               error_kind, error_summary, error_digest_sha256
          from execution_scope_events
         where scope_ref = ? and ${predicate}
         order by sequence desc
         limit ?
      `)
      .all(
        capsule.scope_ref,
        anchor,
        MAX_RECOVERY_EVIDENCE_EVENTS,
      ) as RecoveryEvidenceEventRow[];
    const byToolRows = this.database.sqlite
      .prepare(`
        select tool_name,
               count(*) as calls,
               sum(case when outcome = 'succeeded' then 1 else 0 end) as succeeded,
               sum(case when outcome = 'error' then 1 else 0 end) as failed,
               sum(case when outcome = 'blocked' then 1 else 0 end) as blocked,
               sum(case when outcome = 'interrupted' then 1 else 0 end) as interrupted,
               sum(case when outcome = 'running' then 1 else 0 end) as running
          from execution_scope_events
         where scope_ref = ? and ${predicate}
         group by tool_name
         order by calls desc, tool_name asc
      `)
      .all(capsule.scope_ref, anchor) as Array<Record<string, unknown>>;
    const retainedEventCount = Number(aggregate.retained_count ?? 0);
    const capsuleEventRetained = sequenceAnchored
      ? this.database.sqlite
          .prepare(`
            select 1
              from execution_scope_events
             where scope_ref = ? and sequence = ?
          `)
          .get(capsule.scope_ref, capsule.recorded_event_sequence) !== undefined
      : undefined;
    const activityCounterIndicatesLaterEvents = sequenceAnchored
      && observedScopeTotalEventCount !== undefined
      ? observedScopeTotalEventCount > (capsule.recorded_event_sequence as number)
      : undefined;
    const receiptWindowCompleteness = sequenceAnchored
      ? capsuleEventRetained
        ? "complete_while_capsule_event_is_retained"
        : retainedEventCount > 0
          ? "retained_events_only_capsule_anchor_pruned"
          : activityCounterIndicatesLaterEvents
            ? "event_receipts_pruned_or_unavailable"
            : "unknown_capsule_anchor_not_retained"
      : "time_anchored_retained_window";
    const events = [...rows].reverse().map((event) => ({
      sequence: event.sequence,
      tool: event.tool_name,
      outcome: event.outcome,
      startedAt: iso(event.started_at_ms),
      completedAt: iso(event.completed_at_ms),
      durationMs: event.duration_ms ?? undefined,
      workspaceId: event.workspace_id ?? undefined,
      processSessionId: event.process_session_id ?? undefined,
      detail: parseOptionalRecordJson(event.detail_json),
      errorKind: event.error_kind ?? undefined,
      errorSummary: event.error_summary ?? undefined,
      errorDigestSha256: event.error_digest_sha256 ?? undefined,
    }));
    const byTool = Object.fromEntries(
      byToolRows.map((row) => [
        String(row.tool_name),
        {
          calls: Number(row.calls ?? 0),
          succeeded: Number(row.succeeded ?? 0),
          failed: Number(row.failed ?? 0),
          blocked: Number(row.blocked ?? 0),
          interrupted: Number(row.interrupted ?? 0),
          running: Number(row.running ?? 0),
        },
      ]),
    );

    return {
      source: "sanitized_execution_scope_event_receipts",
      basis: sequenceAnchored
        ? "events_after_recorded_capsule_sequence"
        : "events_started_after_capsule_timestamp",
      recordedEventSequence: capsule.recorded_event_sequence ?? undefined,
      observedScopeTotalEventCount,
      activityCounterIndicatesLaterEvents,
      capsuleEventRetained,
      receiptWindowCompleteness,
      retainedEventCount,
      returnedEventCount: events.length,
      newestRetainedEventSequence:
        aggregate.newest_sequence === null || aggregate.newest_sequence === undefined
          ? undefined
          : Number(aggregate.newest_sequence),
      order: "oldest_first_within_latest_window",
      maxReturnedEvents: MAX_RECOVERY_EVIDENCE_EVENTS,
      truncated: retainedEventCount > events.length,
      outcomes: {
        running: Number(aggregate.running_count ?? 0),
        succeeded: Number(aggregate.succeeded_count ?? 0),
        failed: Number(aggregate.error_count ?? 0),
        blocked: Number(aggregate.blocked_count ?? 0),
        interrupted: Number(aggregate.interrupted_count ?? 0),
      },
      byTool,
      events,
      instruction:
        "These are bounded sanitized executor-event receipts after the explicit capsule. They establish local tool/process activity, not semantic intent, canonical task state, writer authority, effect outcome, or publication safety.",
    };
  }

  close(): void {
    this.database.close();
  }

  private ensureHostEpoch(
    identity: ExecutionScopeIdentity,
    metadata: ExecutorTurnMetadata,
    nowMs: number,
  ): HorizonRow | undefined {
    const turnRef = metadata.identity?.turnRef;
    const deadlineAtMs = metadata.deadlineAtMs;
    if (!turnRef && deadlineAtMs === undefined) return undefined;
    const current = this.getHorizon(identity.scopeRef);

    if (turnRef) {
      if (current?.source === "host_turn" && current.turn_ref === turnRef) {
        if (deadlineAtMs !== undefined && current.deadline_at_ms !== deadlineAtMs) {
          this.database.sqlite
            .prepare(
              "update execution_turn_horizons set deadline_at_ms = ? where scope_ref = ?",
            )
            .run(deadlineAtMs, identity.scopeRef);
          return this.getHorizon(identity.scopeRef);
        }
        return current;
      }
      return this.startEpoch(identity.scopeRef, {
        source: "host_turn",
        turnRef,
        startedAtMs: nowMs,
        deadlineAtMs,
      });
    }

    if (
      current?.source === "host_deadline"
      && current.deadline_at_ms === deadlineAtMs
    ) {
      return current;
    }
    return this.startEpoch(identity.scopeRef, {
      source: "host_deadline",
      startedAtMs: nowMs,
      deadlineAtMs,
    });
  }

  private startEpoch(
    scopeRef: string,
    input: {
      source: HorizonSource;
      turnRef?: string;
      explicitKeyDigestSha256?: string;
      startedAtMs: number;
      deadlineAtMs?: number;
    },
  ): HorizonRow {
    const latest = this.latestCapsuleForScope(scopeRef);
    const epochId = randomUUID();
    this.database.sqlite
      .prepare(`
        insert into execution_turn_horizons (
          scope_ref, epoch_id, source, turn_ref, explicit_key_digest_sha256,
          started_at_ms, deadline_at_ms, last_activity_at_ms,
          last_checkpoint_at_ms, last_checkpoint_id
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        on conflict(scope_ref) do update set
          epoch_id = excluded.epoch_id,
          source = excluded.source,
          turn_ref = excluded.turn_ref,
          explicit_key_digest_sha256 = excluded.explicit_key_digest_sha256,
          started_at_ms = excluded.started_at_ms,
          deadline_at_ms = excluded.deadline_at_ms,
          last_activity_at_ms = excluded.last_activity_at_ms,
          last_mutation_at_ms = null,
          last_checkpoint_at_ms = excluded.last_checkpoint_at_ms,
          last_checkpoint_id = excluded.last_checkpoint_id,
          awareness_emitted_at_ms = null,
          landing_emitted_at_ms = null,
          stale_checkpoint_notice_emitted_at_ms = null,
          capsule_nudge_emitted_at_ms = null
      `)
      .run(
        scopeRef,
        epochId,
        input.source,
        input.turnRef ?? null,
        input.explicitKeyDigestSha256 ?? null,
        input.startedAtMs,
        input.deadlineAtMs ?? null,
        input.startedAtMs,
        latest?.recorded_at_ms ?? null,
        latest?.id ?? null,
      );
    return this.getHorizon(scopeRef) as HorizonRow;
  }

  private horizonView(row: HorizonRow, nowMs: number): Record<string, unknown> {
    const elapsedMs = Math.max(0, nowMs - row.started_at_ms);
    const exactDeadline = row.deadline_at_ms ?? undefined;
    const effectiveDeadline = exactDeadline ?? row.started_at_ms + this.config.estimatedTurnMs;
    const remainingMs = Math.max(0, effectiveDeadline - nowMs);
    const overrunMs = Math.max(0, nowMs - effectiveDeadline);
    const awarenessLeadMs = this.config.estimatedTurnMs - this.config.awarenessAfterMs;
    const landingLeadMs = this.config.estimatedTurnMs - this.config.landingAfterMs;
    let advisory: HorizonAdvisory = "normal";
    if (exactDeadline !== undefined) {
      if (remainingMs <= landingLeadMs) advisory = "landing_opportunity";
      else if (remainingMs <= awarenessLeadMs) advisory = "checkpoint_awareness";
    } else if (elapsedMs >= this.config.landingAfterMs) {
      advisory = "landing_opportunity";
    } else if (elapsedMs >= this.config.awarenessAfterMs) {
      advisory = "checkpoint_awareness";
    }
    const checkpointState = row.last_checkpoint_at_ms === null
      ? "absent"
      : row.last_mutation_at_ms !== null
          && row.last_mutation_at_ms > row.last_checkpoint_at_ms
        ? "changed_since_checkpoint"
        : "current_for_observed_tool_activity";
    return {
      scopeRef: row.scope_ref,
      epochId: row.epoch_id,
      source: row.source,
      turnRef: row.turn_ref ?? undefined,
      deadlineKind: exactDeadline === undefined ? "estimated" : "host_exact",
      startedAt: iso(row.started_at_ms),
      deadlineAt: iso(effectiveDeadline),
      lastActivityAt: iso(row.last_activity_at_ms),
      elapsedMs,
      estimatedRemainingMs: remainingMs,
      overrunMs,
      advisory,
      checkpointState,
      lastCheckpointAt: iso(row.last_checkpoint_at_ms),
      lastCheckpointId: row.last_checkpoint_id ?? undefined,
      lastMutationAt: iso(row.last_mutation_at_ms),
      instruction: horizonInstruction(advisory),
      toolsBlocked: false,
      taskCompletionRequired: false,
      commitRequired: false,
      qualityReductionAuthorized: false,
    };
  }

  private getHorizon(scopeRef: string): HorizonRow | undefined {
    return this.database.sqlite
      .prepare("select * from execution_turn_horizons where scope_ref = ?")
      .get(scopeRef) as HorizonRow | undefined;
  }

  private noteCheckpoint(scopeRef: string, capsuleId: string, nowMs: number): void {
    this.database.sqlite
      .prepare(`
        update execution_turn_horizons
           set last_checkpoint_at_ms = ?, last_checkpoint_id = ?,
               stale_checkpoint_notice_emitted_at_ms = null
         where scope_ref = ?
      `)
      .run(nowMs, capsuleId, scopeRef);
  }

  private normalizeSemantic(input: RecoveryCapsuleInput): RecoverySemanticState {
    return {
      missionRef: boundedText(input.missionRef, "missionRef", false, 1_000),
      authorityOwnerRefs: boundedList(
        input.authorityOwnerRefs,
        "authorityOwnerRefs",
      ),
      authorityStateRefs: boundedList(
        input.authorityStateRefs,
        "authorityStateRefs",
      ).sort(),
      currentFrontier: boundedText(
        input.currentFrontier,
        "currentFrontier",
        true,
      ) as string,
      currentCausalSlice: boundedText(
        input.currentCausalSlice,
        "currentCausalSlice",
        true,
      ) as string,
      established: boundedList(input.established, "established"),
      validationState: input.validationState,
      validationRefs: boundedList(input.validationRefs, "validationRefs"),
      worktreeState: input.worktreeState,
      effectState: input.effectState,
      effectKeys: boundedList(input.effectKeys, "effectKeys"),
      writerState: input.writerState ?? "unknown",
      writerRefs: boundedList(input.writerRefs, "writerRefs"),
      retryPolicy: input.retryPolicy,
      safeToMutate: input.safeToMutate,
      safeToPublish: input.safeToPublish,
      exactNextAction: boundedText(
        input.exactNextAction,
        "exactNextAction",
        true,
      ) as string,
      doNotRepeat: boundedList(input.doNotRepeat, "doNotRepeat"),
      unresolved: boundedList(input.unresolved, "unresolved"),
      checkpointRefs: boundedList(input.checkpointRefs, "checkpointRefs"),
      notes: boundedText(input.notes, "notes"),
    };
  }

  private latestCapsule(rootDigest: string): CapsuleRow | undefined {
    return this.database.sqlite
      .prepare(`
        select * from execution_recovery_capsules
         where workspace_root_digest_sha256 = ?
         order by generation desc
         limit 1
      `)
      .get(rootDigest) as CapsuleRow | undefined;
  }

  private latestCapsuleForScope(scopeRef: string): CapsuleRow | undefined {
    return this.database.sqlite
      .prepare(`
        select * from execution_recovery_capsules
         where scope_ref = ?
         order by recorded_at_ms desc
         limit 1
      `)
      .get(scopeRef) as CapsuleRow | undefined;
  }

  private maybePrune(nowMs: number): void {
    if (nowMs < this.nextPruneAtMs) return;
    this.prune(nowMs);
  }

  private prune(nowMs: number): void {
    const cutoff = nowMs - this.config.capsuleRetentionMs;
    const transaction = this.database.sqlite.transaction(() => {
      this.database.sqlite
        .prepare("delete from execution_recovery_capsules where recorded_at_ms < ?")
        .run(cutoff);
      this.database.sqlite
        .prepare("delete from execution_turn_horizons where last_activity_at_ms < ?")
        .run(cutoff);
    });
    transaction.immediate();
    this.nextPruneAtMs = nowMs + Math.max(
      60_000,
      Math.min(60 * 60 * 1_000, Math.floor(this.config.capsuleRetentionMs / 8)),
    );
  }

  private pruneWorkspaceCapsules(rootDigest: string, nowMs: number): void {
    const cutoff = nowMs - this.config.capsuleRetentionMs;
    this.database.sqlite
      .prepare(`
        delete from execution_recovery_capsules
         where workspace_root_digest_sha256 = ? and recorded_at_ms < ?
      `)
      .run(rootDigest, cutoff);
    const stale = this.database.sqlite
      .prepare(`
        select id from execution_recovery_capsules
         where workspace_root_digest_sha256 = ?
         order by generation desc
         limit -1 offset ?
      `)
      .all(rootDigest, this.config.maxCapsulesPerWorkspace) as Array<{ id: string }>;
    const remove = this.database.sqlite.prepare(
      "delete from execution_recovery_capsules where id = ?",
    );
    for (const row of stale) remove.run(row.id);
  }

  private disabledResult(): Record<string, unknown> {
    return {
      schemaVersion: 1,
      enabled: false,
      policy: this.policy(),
    };
  }

  private policy(): Record<string, unknown> {
    return {
      advisoryOnly: true,
      toolsBlocked: false,
      taskCompletionRequired: false,
      taskOrDecisionAuthority: false,
      writerOrEffectAuthority: false,
      syntheticDeadlineEnforced: false,
      estimatedTurnMs: this.config.estimatedTurnMs,
      awarenessAfterMs: this.config.awarenessAfterMs,
      landingAfterMs: this.config.landingAfterMs,
      capsuleAdoptionNoticeOncePerTurn: true,
    };
  }

  private capsulePolicy(): Record<string, unknown> {
    return {
      authority: "executor_local_recovery_projection_only",
      canonicalTaskOrDecisionAuthority: false,
      writerLeaseAuthority: false,
      effectOutcomeAuthority: false,
      publicationAuthority: false,
      taskCompletionClaimed: false,
      credentialsOrPrivateReasoningPermitted: false,
      currentGitRuntimeAndEffectReadbackRequiredBeforeReliance: true,
      localWorkspaceFreshnessDoesNotImplyCanonicalFreshness: true,
      exactActionRequiresCurrentAuthorityReconciliation: true,
      suppliedAuthorityRefProvenanceAttestedByDevSpace: false,
      timeOrTtlAloneDeterminesValidity: false,
      retentionMs: this.config.capsuleRetentionMs,
      maxCapsulesPerWorkspace: this.config.maxCapsulesPerWorkspace,
    };
  }

  private semanticProjectionPolicy(): Record<string, unknown> {
    return {
      authority: "executor_local_semantic_observation_only",
      sourceOfSemanticState: "explicit_recovery_capsule",
      inferredFromToolEventsOrFilenames: false,
      executionEvidenceSource: "sanitized_execution_scope_event_receipts",
      executionEvidenceCanModifySemanticState: false,
      executionEvidenceMaxReturnedEvents: MAX_RECOVERY_EVIDENCE_EVENTS,
      executionEvidenceRetentionMayLimitCompleteness: true,
      transcriptCaptured: false,
      promptsCaptured: false,
      privateReasoningCaptured: false,
      toolOutputsCaptured: false,
      rawCommandsCaptured: false,
      patchesCaptured: false,
      credentialsPermitted: false,
      canonicalTaskOrDecisionAuthority: false,
      writerLeaseAuthority: false,
      effectOutcomeAuthority: false,
      publicationAuthority: false,
      localWorkspaceFreshnessDoesNotImplyCanonicalFreshness: true,
      currentAuthorityReadbackRequiredBeforeExactActionReliance: true,
      capsuleAgeIsNotValidityEvidence: true,
    };
  }
}

async function workspaceFingerprint(
  workspace: Pick<Workspace, "id" | "root">,
): Promise<WorkspaceFingerprint> {
  const canonicalRoot = await realpath(workspace.root).catch(() => resolve(workspace.root));
  const workspaceRootDigestSha256 = sha256(canonicalRoot);
  const eligibility = await getGitEligibility(canonicalRoot);
  if (!eligibility.ok || !eligibility.gitRoot) {
    const stateDigestSha256 = sha256(canonicalJson({
      kind: "non_git",
      workspaceRootDigestSha256,
      reason: eligibility.reason ?? "not_git",
    }));
    return {
      schemaVersion: 1,
      kind: "non_git",
      workspaceRootDigestSha256,
      complete: false,
      limitation: eligibility.message ?? "Workspace is not a Git worktree.",
      stateDigestSha256,
    };
  }

  const gitRoot = await realpath(eligibility.gitRoot).catch(() => resolve(eligibility.gitRoot as string));
  const [head, headTree, branch, status, stagedNames, unstagedNames, untrackedNames] =
    await Promise.all([
      git(gitRoot, ["rev-parse", "HEAD"]),
      git(gitRoot, ["rev-parse", "HEAD^{tree}"]),
      git(gitRoot, ["branch", "--show-current"]),
      git(gitRoot, ["status", "--porcelain=v2", "-z", "--untracked-files=all"], {
        maxBuffer: MAX_GIT_OUTPUT_BYTES,
      }),
      git(gitRoot, ["diff", "--cached", "--name-only", "-z"], {
        maxBuffer: MAX_GIT_OUTPUT_BYTES,
      }),
      git(gitRoot, ["diff", "--name-only", "-z"], {
        maxBuffer: MAX_GIT_OUTPUT_BYTES,
      }),
      git(gitRoot, ["ls-files", "--others", "--exclude-standard", "-z"], {
        maxBuffer: MAX_GIT_OUTPUT_BYTES,
      }),
    ]);

  let trackedDiffDigestSha256: string;
  let complete = true;
  let limitation: string | undefined;
  try {
    const diff = await git(gitRoot, ["diff", "--binary", "HEAD", "--"], {
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
    });
    trackedDiffDigestSha256 = sha256(diff.stdout);
  } catch {
    trackedDiffDigestSha256 = sha256(status.stdout);
    complete = false;
    limitation = "Tracked diff exceeded the bounded fingerprint reader; status digest was used.";
  }

  const untrackedPaths = splitNul(untrackedNames.stdout).sort();
  const untrackedEntries: Array<{ pathDigestSha256: string; objectSha?: string }> = [];
  for (const path of untrackedPaths.slice(0, MAX_UNTRACKED_HASH_PATHS)) {
    let objectSha: string | undefined;
    try {
      objectSha = (await git(gitRoot, ["hash-object", "--no-filters", "--", path])).stdout.trim();
    } catch {
      complete = false;
      limitation ??= "At least one untracked path could not be content-hashed.";
    }
    untrackedEntries.push({
      pathDigestSha256: sha256(path),
      objectSha,
    });
  }
  if (untrackedPaths.length > MAX_UNTRACKED_HASH_PATHS) {
    complete = false;
    limitation ??= `Only the first ${MAX_UNTRACKED_HASH_PATHS} untracked paths were content-hashed.`;
  }

  const base = {
    kind: "git" as const,
    workspaceRootDigestSha256,
    gitRootDigestSha256: sha256(gitRoot),
    head: head.stdout.trim(),
    headTree: headTree.stdout.trim(),
    branch: branch.stdout.trim() || "DETACHED",
    statusDigestSha256: sha256(status.stdout),
    trackedDiffDigestSha256,
    untrackedDigestSha256: sha256(canonicalJson({
      total: untrackedPaths.length,
      truncated: untrackedPaths.length > MAX_UNTRACKED_HASH_PATHS,
      entries: untrackedEntries,
    })),
    stagedPathCount: splitNul(stagedNames.stdout).length,
    unstagedPathCount: splitNul(unstagedNames.stdout).length,
    untrackedPathCount: untrackedPaths.length,
    dirty: status.stdout.length > 0,
    complete,
    limitation,
  };
  return {
    schemaVersion: 1,
    ...base,
    stateDigestSha256: sha256(canonicalJson(base)),
  };
}

function parseFingerprint(value: string): WorkspaceFingerprint {
  const parsed = JSON.parse(value) as unknown;
  if (!isRecord(parsed) || parsed.schemaVersion !== 1) {
    throw new Error("Stored recovery capsule fingerprint is invalid.");
  }
  return parsed as unknown as WorkspaceFingerprint;
}

function parseSemantic(value: string): RecoverySemanticState {
  const parsed = JSON.parse(value) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("Stored recovery capsule semantic state is invalid.");
  }
  return parsed as unknown as RecoverySemanticState;
}

function compareFingerprint(
  recorded: WorkspaceFingerprint,
  current: WorkspaceFingerprint,
): { freshness: "fresh" | "stale" | "unknown"; reasons: string[] } {
  if (recorded.kind !== "git" || current.kind !== "git") {
    return {
      freshness: "unknown",
      reasons: ["non_git_workspace_has_no_content_complete_freshness_proof"],
    };
  }
  if (recorded.stateDigestSha256 === current.stateDigestSha256) {
    if (!recorded.complete || !current.complete) {
      return {
        freshness: "unknown",
        reasons: ["bounded_workspace_fingerprint_is_not_content_complete"],
      };
    }
    return { freshness: "fresh", reasons: [] };
  }
  const reasons: string[] = [];
  if (recorded.workspaceRootDigestSha256 !== current.workspaceRootDigestSha256) {
    reasons.push("workspace_root_changed");
  }
  if (recorded.gitRootDigestSha256 !== current.gitRootDigestSha256) {
    reasons.push("git_root_changed");
  }
  if (recorded.head !== current.head) reasons.push("head_changed");
  if (recorded.headTree !== current.headTree) reasons.push("head_tree_changed");
  if (recorded.branch !== current.branch) reasons.push("branch_changed");
  if (recorded.statusDigestSha256 !== current.statusDigestSha256) {
    reasons.push("worktree_status_changed");
  }
  if (recorded.trackedDiffDigestSha256 !== current.trackedDiffDigestSha256) {
    reasons.push("tracked_content_changed");
  }
  if (recorded.untrackedDigestSha256 !== current.untrackedDigestSha256) {
    reasons.push("untracked_content_changed");
  }
  if (reasons.length === 0) reasons.push("workspace_fingerprint_changed");
  return { freshness: "stale", reasons };
}

type AuthorityFreshness =
  | "matched_supplied_refs"
  | "changed_from_recorded_refs"
  | "unverified";

function compareAuthorityStateRefs(
  recordedRefs: string[],
  currentRefs: string[],
): {
  freshness: AuthorityFreshness;
  currentRefs: string[];
  reason?: string;
} {
  const normalizedCurrent = [...currentRefs].sort();
  if (recordedRefs.length === 0) {
    return {
      freshness: "unverified",
      currentRefs: normalizedCurrent,
      reason: "recorded_authority_baseline_absent",
    };
  }
  if (normalizedCurrent.length === 0) {
    return {
      freshness: "unverified",
      currentRefs: normalizedCurrent,
      reason: "current_authority_readback_not_supplied",
    };
  }
  if (canonicalJson(recordedRefs) === canonicalJson(normalizedCurrent)) {
    return {
      freshness: "matched_supplied_refs",
      currentRefs: normalizedCurrent,
    };
  }
  return {
    freshness: "changed_from_recorded_refs",
    currentRefs: normalizedCurrent,
    reason: "authority_state_refs_changed",
  };
}

type ExactActionReliance =
  | "blocked_workspace_stale"
  | "blocked_workspace_unknown"
  | "blocked_authority_changed"
  | "requires_current_authority_reconciliation"
  | "candidate_available_after_supplied_authority_match";

function exactActionRelianceDisposition(
  workspaceFreshness: "fresh" | "stale" | "unknown",
  authorityFreshness: AuthorityFreshness,
): ExactActionReliance {
  if (workspaceFreshness === "stale") return "blocked_workspace_stale";
  if (workspaceFreshness === "unknown") return "blocked_workspace_unknown";
  if (authorityFreshness === "changed_from_recorded_refs") {
    return "blocked_authority_changed";
  }
  if (authorityFreshness === "unverified") {
    return "requires_current_authority_reconciliation";
  }
  return "candidate_available_after_supplied_authority_match";
}

function recommendedRecoveryAction(
  workspaceFreshness: "fresh" | "stale" | "unknown",
  authorityFreshness: AuthorityFreshness,
  exactNextAction: string,
): string {
  if (workspaceFreshness === "stale") {
    return "Reconcile the current Git/workspace delta before using the capsule. Then rehydrate current task, decision, writer, runtime, and effect owners; do not retry effects or publish from the capsule alone.";
  }
  if (workspaceFreshness === "unknown") {
    return "Establish a content-complete workspace baseline, then rehydrate current authoritative task, decision, writer, runtime, and effect state before relying on the recorded action.";
  }
  if (authorityFreshness === "changed_from_recorded_refs") {
    return "The local workspace still matches the capsule, but authoritative state changed elsewhere. Replan from current canonical and runtime owners; treat the recorded exact action as historical only.";
  }
  if (authorityFreshness === "unverified") {
    return "The local workspace matches the capsule. Rehydrate and reconcile current canonical Git/main, task, decision, writer, runtime, and effect state, then call recovery_capsule_status with exact currentAuthorityStateRefs before relying on the recorded action.";
  }
  return `${exactNextAction} This remains a conditional executor action candidate; perform any required live writer/effect/control preflight before mutation or publication.`;
}

function semanticProjectionClassification(
  workspaceFreshness: "fresh" | "stale" | "unknown",
  activityAfterCapsule: boolean,
): string {
  if (workspaceFreshness === "stale") {
    return "historical_capsule_workspace_changed_reconciliation_required";
  }
  if (workspaceFreshness === "unknown") {
    return "historical_capsule_workspace_freshness_unknown";
  }
  if (activityAfterCapsule) {
    return "workspace_matches_capsule_but_later_scope_activity_observed_authority_unverified";
  }
  return "workspace_matches_latest_capsule_authority_unverified";
}
