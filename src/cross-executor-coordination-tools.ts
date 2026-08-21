import { createHash } from "node:crypto";
import { posix } from "node:path";
import type { registerAppTool as registerAppToolType } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import type { ServerConfig } from "./config.js";
import {
  CodexIntegrationRuntime,
} from "./codex-integration-tools.js";
import { getGitEligibility, git } from "./git.js";
import type { Workspace } from "./workspaces.js";

type AppToolRegistrar = typeof registerAppToolType;
type JsonRecord = Record<string, unknown>;

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const GIT_SHA_PATTERN = /^[a-f0-9]{40,64}$/;
const SESSION_REF_PATTERN = /^cdx_ses_[a-f0-9]{32}$/;
const SERVER_REF_PATTERN = /^cdx_srv_[a-f0-9]{32}$/;
const WORKSPACE_REF_PATTERN = /^cdx_ws_[a-f0-9]{32}$/;
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const MAX_AFFECTED_PATHS = 20;
const MAX_AFFECTED_PATH_CHARACTERS = 512;
const MAX_ACTIVITY_TEXT_CHARACTERS = 240_000;
const MAX_SESSION_PAGES = 3;
const MAX_MATCHING_SESSIONS = 20;

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

const COORDINATION_EFFECT_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

export const crossExecutorCoordinationToolNames = {
  assess: "cross_executor_coordination_assess",
  send: "cross_executor_coordination_send",
} as const;

export interface CrossExecutorWorkspacePort {
  getWorkspace(workspaceId: string): Workspace | undefined;
}

export interface CrossExecutorGitObservation {
  headSha: string;
  branch: string | null;
  originDigestSha256: string | null;
}

export interface CrossExecutorGitPort {
  observe(root: string): Promise<CrossExecutorGitObservation>;
}

export interface CrossExecutorCoordinationRuntimeOptions {
  git?: CrossExecutorGitPort;
  now?: () => Date;
}

export interface CrossExecutorCoordinationInput {
  workspaceId: string;
  affectedPaths: string[];
  expectedHeadSha?: string;
  expectedSessionRef?: string;
}

export interface CrossExecutorCoordinationSendInput
  extends CrossExecutorCoordinationInput {
  idempotencyKey: string;
}

interface CodexSessionCandidate {
  sessionRef: string;
  serverRef: string;
  workspaceRef: string | null;
  workspaceAlias: string | null;
  name: string | null;
  lifecycle: string;
  loaded: boolean;
  directInput: string | null;
  recencyAt: number | string | null;
  gitSha: string | null;
  branch: string | null;
  originDigestSha256: string;
  matchedPaths: string[];
  pathEvidence: "observed_in_bounded_activity" | "not_observed_in_bounded_activity" | "not_checked";
}

interface SelectedCodexSession extends CodexSessionCandidate {
  activeTurnRef: string | null;
}

interface GatewayEffectAvailability {
  coordinationEffectsEnabled: boolean;
  coordinationEffectsAvailable: boolean;
  transportHealth: string | null;
}

interface SessionDiscoveryResult {
  sessions: CodexSessionCandidate[];
  scanComplete: boolean;
}

export class CrossExecutorCoordinationRuntime {
  private readonly git: CrossExecutorGitPort;
  private readonly now: () => Date;

  constructor(
    private readonly workspaces: CrossExecutorWorkspacePort,
    private readonly codex: CodexIntegrationRuntime,
    options: CrossExecutorCoordinationRuntimeOptions = {},
  ) {
    this.git = options.git ?? new NativeCrossExecutorGitPort();
    this.now = options.now ?? (() => new Date());
  }

  async assess(input: CrossExecutorCoordinationInput): Promise<JsonRecord> {
    const paths = normalizeAffectedPaths(input.affectedPaths);
    const workspace = this.requireWorkspace(input.workspaceId);
    const observedAt = this.now().toISOString();
    let repository: CrossExecutorGitObservation;
    try {
      repository = await this.git.observe(workspace.root);
    } catch (error) {
      return assessmentEnvelope({
        disposition: "repository_identity_unavailable",
        observedAt,
        workspace,
        paths,
        repository: null,
        candidates: [],
        selected: null,
        safeToSend: false,
        reasonCodes: [coordinationErrorCode(error, "WORKSPACE_GIT_UNAVAILABLE")],
        action:
          "Repair or select the exact Git workspace before attempting cross-executor coordination.",
      });
    }

    if (
      input.expectedHeadSha !== undefined
      && input.expectedHeadSha !== repository.headSha
    ) {
      return assessmentEnvelope({
        disposition: "workspace_head_changed",
        observedAt,
        workspace,
        paths,
        repository,
        candidates: [],
        selected: null,
        safeToSend: false,
        reasonCodes: ["EXPECTED_HEAD_MISMATCH"],
        action:
          "Re-read the workspace and affected paths, then assess again against the current HEAD.",
      });
    }

    if (!repository.originDigestSha256) {
      return assessmentEnvelope({
        disposition: "repository_identity_unavailable",
        observedAt,
        workspace,
        paths,
        repository,
        candidates: [],
        selected: null,
        safeToSend: false,
        reasonCodes: ["GIT_ORIGIN_UNAVAILABLE"],
        action:
          "Configure or identify the repository origin before matching native Codex sessions.",
      });
    }

    let discovery: SessionDiscoveryResult;
    let gatewayStatus: unknown;
    try {
      [discovery, gatewayStatus] = await Promise.all([
        this.listMatchingSessions(
          repository.originDigestSha256,
          input.expectedSessionRef,
        ),
        this.codex.request("codex_gateway_status"),
      ]);
    } catch (error) {
      return assessmentEnvelope({
        disposition: "codex_gateway_unavailable",
        observedAt,
        workspace,
        paths,
        repository,
        candidates: [],
        selected: null,
        safeToSend: false,
        reasonCodes: [coordinationErrorCode(error, "CODEX_GATEWAY_UNAVAILABLE")],
        action:
          "Continue unrelated work and retry discovery after the native Codex gateway is healthy.",
      });
    }

    const sessions = discovery.sessions;
    if (!discovery.scanComplete && !input.expectedSessionRef) {
      return assessmentEnvelope({
        disposition: "codex_session_scan_incomplete",
        observedAt,
        workspace,
        paths,
        repository,
        candidates: sessions,
        selected: null,
        safeToSend: false,
        reasonCodes: ["MATCHING_SESSION_SCAN_LIMIT_REACHED"],
        action:
          "Provide an exact opaque expectedSessionRef or reduce the gateway session inventory before coordinating; uniqueness is not proven.",
        sessionScanComplete: false,
      });
    }

    const active = sessions.filter((session) => isActiveLifecycle(session.lifecycle));
    if (active.length > 0 && active.length <= 5) {
      await Promise.all(active.map(async (session) => {
        const evidence = await this.observePathEvidence(session.sessionRef, paths);
        session.matchedPaths = evidence.matchedPaths;
        session.pathEvidence = evidence.pathEvidence;
      }));
    }

    const selectedCandidate = input.expectedSessionRef
      ? active.find((session) => session.sessionRef === input.expectedSessionRef) ?? null
      : selectCandidate(active);
    if (input.expectedSessionRef && !selectedCandidate) {
      return assessmentEnvelope({
        disposition: discovery.scanComplete
          ? "expected_codex_session_not_active"
          : "expected_codex_session_not_observed_in_bounded_scan",
        observedAt,
        workspace,
        paths,
        repository,
        candidates: active,
        selected: null,
        safeToSend: false,
        reasonCodes: [
          discovery.scanComplete
            ? "EXPECTED_SESSION_NOT_ACTIVE_OR_REPOSITORY_MISMATCH"
            : "EXPECTED_SESSION_NOT_OBSERVED_BEFORE_SCAN_LIMIT",
        ],
        action:
          "Reassess the current same-repository Codex candidates before selecting another target.",
        sessionScanComplete: discovery.scanComplete,
      });
    }
    if (!selectedCandidate && active.length > 0) {
      return assessmentEnvelope({
        disposition: "ambiguous_active_codex_sessions",
        observedAt,
        workspace,
        paths,
        repository,
        candidates: active,
        selected: null,
        safeToSend: false,
        reasonCodes: ["MULTIPLE_ACTIVE_MATCHING_CODEX_SESSIONS"],
        action:
          "Inspect the bounded candidate list or narrow the affected paths; do not broadcast or guess a target.",
      });
    }

    if (!selectedCandidate) {
      const idle = sessions.filter((session) => isIdleLifecycle(session.lifecycle));
      return assessmentEnvelope({
        disposition: idle.length > 0
          ? "matching_codex_session_idle"
          : "no_matching_codex_session",
        observedAt,
        workspace,
        paths,
        repository,
        candidates: idle,
        selected: null,
        safeToSend: false,
        reasonCodes: [
          idle.length > 0
            ? "NO_ACTIVE_MATCHING_CODEX_SESSION"
            : "NO_MATCHING_CODEX_SESSION",
        ],
        action:
          "Continue unrelated work; reassess only when an exact source collision becomes plausible or a Codex session becomes active.",
      });
    }

    let selected: SelectedCodexSession;
    try {
      selected = await this.readSelectedSession(selectedCandidate);
    } catch (error) {
      return assessmentEnvelope({
        disposition: "codex_session_read_unavailable",
        observedAt,
        workspace,
        paths,
        repository,
        candidates: active,
        selected: null,
        safeToSend: false,
        reasonCodes: [coordinationErrorCode(error, "CODEX_SESSION_READ_UNAVAILABLE")],
        action:
          "Do not send until the exact selected Codex session can be freshly read.",
      });
    }

    const availability = gatewayEffectAvailability(
      gatewayStatus,
      selected.serverRef,
    );
    const directInputAvailable = selected.directInput === "available";
    const safeToSend = availability.coordinationEffectsAvailable
      && directInputAvailable;
    const reasonCodes = [
      selected.pathEvidence === "observed_in_bounded_activity"
        ? "AFFECTED_PATH_REFERENCE_OBSERVED"
        : "REPOSITORY_MATCH_WITHOUT_EXACT_PATH_OWNERSHIP_PROOF",
      ...(directInputAvailable ? [] : ["CODEX_DIRECT_INPUT_UNAVAILABLE"]),
      ...(availability.coordinationEffectsAvailable
        ? []
        : ["CODEX_COORDINATION_EFFECT_UNAVAILABLE"]),
    ];

    return assessmentEnvelope({
      disposition: "selected_active_codex_session",
      observedAt,
      workspace,
      paths,
      repository,
      candidates: active,
      selected,
      safeToSend,
      reasonCodes,
      action: safeToSend
        ? "Send one idempotent bounded coordination notice; wait only on the exact overlapping paths or hunks."
        : "The target is identified, but delivery remains disabled or unavailable; continue unrelated work and enable only the bounded coordination effect before sending.",
      effectAvailability: availability,
      sessionScanComplete: discovery.scanComplete,
    });
  }

  async send(input: CrossExecutorCoordinationSendInput): Promise<JsonRecord> {
    const assessment = await this.assess(input);
    const selected = asRecord(assessment.selected);
    const sessionRef = stringValue(selected?.sessionRef);
    if (
      input.expectedSessionRef !== undefined
      && sessionRef !== input.expectedSessionRef
    ) {
      return {
        schemaVersion: 1,
        dispatched: false,
        disposition: "selected_session_changed",
        assessment,
        reasonCodes: ["EXPECTED_SESSION_MISMATCH"],
        action:
          "Reassess the active Codex session and do not reuse this effect identity for a different target.",
        authority: coordinationAuthority(),
      };
    }
    if (assessment.safeToSend !== true || !sessionRef) {
      return {
        schemaVersion: 1,
        dispatched: false,
        disposition: "coordination_not_dispatchable",
        assessment,
        reasonCodes: Array.isArray(assessment.reasonCodes)
          ? assessment.reasonCodes
          : ["ASSESSMENT_NOT_SENDABLE"],
        action: assessment.action,
        authority: coordinationAuthority(),
      };
    }

    const paths = normalizeAffectedPaths(input.affectedPaths);
    const workspace = this.requireWorkspace(input.workspaceId);
    const repository = asRecord(assessment.repository);
    let currentRepository: CrossExecutorGitObservation;
    try {
      currentRepository = await this.git.observe(workspace.root);
    } catch (error) {
      return {
        schemaVersion: 1,
        dispatched: false,
        disposition: "repository_recheck_unavailable",
        assessment,
        reasonCodes: [coordinationErrorCode(error, "WORKSPACE_GIT_RECHECK_UNAVAILABLE")],
        action:
          "Do not dispatch until the exact workspace repository identity can be re-read.",
        authority: coordinationAuthority(),
      };
    }
    const currentOriginDigestSha256 = currentRepository.originDigestSha256;
    if (
      currentRepository.headSha !== stringValue(repository?.headSha)
      || !currentOriginDigestSha256
      || currentOriginDigestSha256
        !== stringValue(repository?.originDigestSha256)
    ) {
      return {
        schemaVersion: 1,
        dispatched: false,
        disposition: "workspace_changed_before_dispatch",
        assessment,
        reasonCodes: ["WORKSPACE_GIT_IDENTITY_CHANGED_AFTER_ASSESSMENT"],
        action:
          "Reassess the current HEAD and repository identity before creating a new coordination effect.",
        authority: coordinationAuthority(),
      };
    }
    const pathEvidence = selected
      ? stringValue(selected.pathEvidence) ?? "not_checked"
      : "not_checked";

    try {
      const delivery = await this.codex.request("codex_coordination_send", {
        idempotencyKey: input.idempotencyKey,
        sessionRef,
        repositoryOriginDigestSha256:
          currentOriginDigestSha256,
        senderWorkspaceId: workspace.id,
        ...(workspace.worktree?.baseSha
          ? { senderBaseSha: workspace.worktree.baseSha }
          : {}),
        senderHeadSha: currentRepository.headSha,
        pathEvidence,
        affectedPaths: paths,
      });
      return {
        schemaVersion: 1,
        dispatched: true,
        disposition: "coordination_dispatched",
        assessment,
        delivery,
        authority: coordinationAuthority(),
      };
    } catch (error) {
      return {
        schemaVersion: 1,
        dispatched: false,
        disposition: "coordination_delivery_unavailable",
        assessment,
        delivery: coordinationErrorProjection(error),
        action:
          "Do not replay with a new idempotency key when the effect outcome is unknown; reconcile the exact delivery first.",
        authority: coordinationAuthority(),
      };
    }
  }

  private requireWorkspace(workspaceId: string): Workspace {
    const workspace = this.workspaces.getWorkspace(workspaceId);
    if (!workspace) {
      throw new Error(`Unknown workspaceId: ${workspaceId}`);
    }
    return workspace;
  }

  private async listMatchingSessions(
    originDigestSha256: string,
    expectedSessionRef?: string,
  ): Promise<SessionDiscoveryResult> {
    const matching = new Map<string, CodexSessionCandidate>();
    let scanComplete = true;
    const collect = (response: JsonRecord | undefined): void => {
      const sessions = Array.isArray(response?.sessions)
        ? response.sessions
        : [];
      for (const value of sessions) {
        const candidate = parseSessionCandidate(value);
        if (
          candidate
          && candidate.originDigestSha256 === originDigestSha256
          && candidate.loaded
          && !isTerminalErrorLifecycle(candidate.lifecycle)
        ) {
          matching.set(candidate.sessionRef, candidate);
        }
      }
    };

    const first = asRecord(await this.codex.request("codex_session_list", {
      sortKey: "recency_at",
      sortDirection: "desc",
      limit: 100,
    }));
    collect(first);
    const initialPages = sessionPageCursors(first);
    await Promise.all(initialPages.map(async ({ serverRef, cursorRef }) => {
      let nextCursor: string | undefined = cursorRef;
      for (let page = 1; page < MAX_SESSION_PAGES && nextCursor; page += 1) {
        const response = asRecord(await this.codex.request("codex_session_list", {
          serverRef,
          sortKey: "recency_at",
          sortDirection: "desc",
          limit: 100,
          cursorRef: nextCursor,
        }));
        collect(response);
        nextCursor = sessionPageCursors(response)
          .find((entry) => entry.serverRef === serverRef)
          ?.cursorRef;
      }
      if (nextCursor) scanComplete = false;
    }));

    const ordered = [...matching.values()]
      .sort((left, right) => recencyScore(right.recencyAt) - recencyScore(left.recencyAt));
    if (expectedSessionRef && matching.has(expectedSessionRef)) {
      const expected = matching.get(expectedSessionRef)!;
      const index = ordered.findIndex(
        (session) => session.sessionRef === expectedSessionRef,
      );
      if (index > 0) {
        ordered.splice(index, 1);
        ordered.unshift(expected);
      }
    }
    return { sessions: ordered, scanComplete };
  }

  private async observePathEvidence(
    sessionRef: string,
    paths: string[],
  ): Promise<Pick<CodexSessionCandidate, "matchedPaths" | "pathEvidence">> {
    try {
      const response = asRecord(await this.codex.request(
        "codex_session_activity",
        { sessionRef, view: "audit", limit: 100 },
      ));
      const items = Array.isArray(response?.items) ? response.items : [];
      const text = pathEvidenceText(items).slice(0, MAX_ACTIVITY_TEXT_CHARACTERS);
      const matchedPaths = paths.filter((path) => pathMentioned(text, path));
      return {
        matchedPaths,
        pathEvidence: matchedPaths.length > 0
          ? "observed_in_bounded_activity"
          : "not_observed_in_bounded_activity",
      };
    } catch {
      return { matchedPaths: [], pathEvidence: "not_checked" };
    }
  }

  private async readSelectedSession(
    candidate: CodexSessionCandidate,
  ): Promise<SelectedCodexSession> {
    const response = asRecord(await this.codex.request("codex_session_read", {
      sessionRef: candidate.sessionRef,
      includeTurns: true,
      includeGoal: true,
      includeUsage: false,
      turnLimit: 20,
    }));
    const session = asRecord(response?.session);
    if (stringValue(session?.sessionRef) !== candidate.sessionRef) {
      throw new Error("Codex session readback did not match the selected session");
    }
    const turns = Array.isArray(session?.turns) ? session.turns : [];
    let activeTurnRef: string | null = null;
    for (let index = turns.length - 1; index >= 0; index -= 1) {
      const turn = asRecord(turns[index]);
      const status = stringValue(turn?.status)?.toLowerCase();
      const turnRef = stringValue(turn?.turnRef);
      if (
        turnRef
        && (status === "inprogress" || status === "active" || status === "running")
      ) {
        activeTurnRef = turnRef;
        break;
      }
    }
    return {
      ...candidate,
      lifecycle:
        stringValue(asRecord(session?.status)?.type) ?? candidate.lifecycle,
      directInput: stringValue(session?.directInput) ?? candidate.directInput,
      activeTurnRef,
    };
  }
}

export class NativeCrossExecutorGitPort implements CrossExecutorGitPort {
  async observe(root: string): Promise<CrossExecutorGitObservation> {
    const eligibility = await getGitEligibility(root);
    if (!eligibility.ok || !eligibility.gitRoot) {
      throw new Error(eligibility.message ?? "workspace is not a Git repository");
    }
    const gitRoot = eligibility.gitRoot;
    const headSha = (await git(gitRoot, ["rev-parse", "HEAD"])).stdout.trim();
    let branch: string | null = null;
    try {
      branch = (await git(gitRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]))
        .stdout.trim() || null;
    } catch {
      branch = null;
    }
    let originDigestSha256: string | null = null;
    try {
      const origin = (await git(gitRoot, ["remote", "get-url", "origin"]))
        .stdout.trim();
      if (origin) originDigestSha256 = sha256(origin);
    } catch {
      originDigestSha256 = null;
    }
    return { headSha, branch, originDigestSha256 };
  }
}

export function registerCrossExecutorCoordinationTools(
  server: McpServer,
  config: ServerConfig,
  runtime: CrossExecutorCoordinationRuntime,
  registerTool: AppToolRegistrar,
): void {
  if (!config.codexIntegration.enabled) return;

  registerTool(
    server,
    crossExecutorCoordinationToolNames.assess,
    {
      title: "Assess a WebChat-to-Codex source collision",
      description:
        "Match one registered DevSpace workspace to active native Codex sessions by exact Git-origin digest, then use bounded activity evidence to narrow affected-path overlap. This read-only assessment returns opaque session refs only, never raw thread IDs, socket paths, rollout paths, repository URLs, prompts, or credentials. It proves at most a potential source collision; path references are not writer ownership.",
      inputSchema: {
        workspaceId: z.string().regex(/^ws_[a-f0-9]{10}$/),
        affectedPaths: z.array(z.string().min(1).max(MAX_AFFECTED_PATH_CHARACTERS))
          .min(1)
          .max(MAX_AFFECTED_PATHS),
        expectedHeadSha: z.string().regex(GIT_SHA_PATTERN).optional(),
        expectedSessionRef: z.string().regex(SESSION_REF_PATTERN).optional(),
      },
      outputSchema: resultOutputSchema(),
      _meta: {},
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input) => jsonResponse(await runtime.assess(input)),
  );

  registerTool(
    server,
    crossExecutorCoordinationToolNames.send,
    {
      title: "Send bounded source coordination to native Codex",
      description:
        "Freshly reassess one exact DevSpace workspace and affected-path set, select exactly one active same-repository Codex session, then send one fixed idempotent coordination notice through the separately gated Codex coordination effect. Ambiguous targets, stale HEAD, repository drift, disabled delivery, and unknown outcomes fail closed. This creates no global writer lock and never blocks unrelated paths.",
      inputSchema: {
        workspaceId: z.string().regex(/^ws_[a-f0-9]{10}$/),
        affectedPaths: z.array(z.string().min(1).max(MAX_AFFECTED_PATH_CHARACTERS))
          .min(1)
          .max(MAX_AFFECTED_PATHS),
        expectedHeadSha: z.string().regex(GIT_SHA_PATTERN).optional(),
        expectedSessionRef: z.string().regex(SESSION_REF_PATTERN).optional(),
        idempotencyKey: z.string().regex(IDEMPOTENCY_PATTERN),
      },
      outputSchema: resultOutputSchema(),
      _meta: {},
      annotations: COORDINATION_EFFECT_ANNOTATIONS,
    },
    async (input) => jsonResponse(await runtime.send(input)),
  );
}

function normalizeAffectedPaths(values: string[]): string[] {
  if (!Array.isArray(values) || values.length < 1 || values.length > MAX_AFFECTED_PATHS) {
    throw new Error(`affectedPaths must contain 1-${MAX_AFFECTED_PATHS} paths`);
  }
  const unique = new Set<string>();
  for (const raw of values) {
    if (
      typeof raw !== "string"
      || raw.includes("\\")
      || /[\u0000-\u001f\u007f]/.test(raw)
    ) {
      throw new Error("affectedPaths must use bounded POSIX repository-relative paths");
    }
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("/")) {
      throw new Error("affectedPaths must be repository-relative");
    }
    const normalized = posix.normalize(trimmed.replace(/^\.\//, ""));
    if (
      !normalized
      || normalized === "."
      || normalized === ".."
      || normalized.startsWith("../")
      || normalized.length > MAX_AFFECTED_PATH_CHARACTERS
    ) {
      throw new Error("affectedPaths contains traversal or an invalid path");
    }
    unique.add(normalized);
  }
  return [...unique].sort();
}

function parseSessionCandidate(value: unknown): CodexSessionCandidate | null {
  const session = asRecord(value);
  const sessionRef = stringValue(session?.sessionRef);
  const serverRef = stringValue(session?.serverRef);
  const workspace = asRecord(session?.workspace);
  const gitObservation = asRecord(session?.git);
  const status = asRecord(session?.status);
  const originDigestSha256 = stringValue(gitObservation?.originDigestSha256);
  if (
    !sessionRef
    || !SESSION_REF_PATTERN.test(sessionRef)
    || !serverRef
    || !SERVER_REF_PATTERN.test(serverRef)
    || !originDigestSha256
    || !SHA256_PATTERN.test(originDigestSha256)
  ) {
    return null;
  }
  const workspaceRef = stringValue(workspace?.workspaceRef);
  return {
    sessionRef,
    serverRef,
    workspaceRef:
      workspaceRef && WORKSPACE_REF_PATTERN.test(workspaceRef)
        ? workspaceRef
        : null,
    workspaceAlias: stringValue(workspace?.workspaceAlias),
    name: stringValue(session?.name),
    lifecycle: stringValue(status?.type) ?? "unknown",
    loaded: session?.loaded === true,
    directInput: stringValue(session?.directInput),
    recencyAt:
      typeof session?.recencyAt === "number" || typeof session?.recencyAt === "string"
        ? session.recencyAt
        : null,
    gitSha: stringValue(gitObservation?.sha),
    branch: stringValue(gitObservation?.branch),
    originDigestSha256,
    matchedPaths: [],
    pathEvidence: "not_checked",
  };
}

function selectCandidate(active: CodexSessionCandidate[]): CodexSessionCandidate | null {
  if (active.length === 1) return active[0] ?? null;
  const withPathEvidence = active.filter((candidate) => candidate.matchedPaths.length > 0);
  return withPathEvidence.length === 1 ? withPathEvidence[0] ?? null : null;
}

function sessionPageCursors(
  response: JsonRecord | undefined,
): Array<{ serverRef: string; cursorRef: string }> {
  const pages = Array.isArray(response?.serverPages) ? response.serverPages : [];
  const cursors: Array<{ serverRef: string; cursorRef: string }> = [];
  for (const value of pages) {
    const page = asRecord(value);
    const serverRef = stringValue(page?.serverRef);
    const cursorRef = stringValue(page?.nextCursorRef);
    if (
      serverRef
      && SERVER_REF_PATTERN.test(serverRef)
      && cursorRef
      && /^cdx_cur_[a-f0-9]{32}$/.test(cursorRef)
    ) {
      cursors.push({ serverRef, cursorRef });
    }
  }
  return cursors;
}

function recencyScore(value: number | string | null): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function pathMentioned(text: string, path: string): boolean {
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `(^|[^A-Za-z0-9._/-])${escaped}(?=$|[^A-Za-z0-9._/-])`,
    "m",
  ).test(text);
}

function gatewayEffectAvailability(
  value: unknown,
  serverRef: string,
): GatewayEffectAvailability {
  const status = asRecord(value);
  const servers = Array.isArray(status?.servers) ? status.servers : [];
  const server = servers
    .map(asRecord)
    .find((candidate) => stringValue(candidate?.serverRef) === serverRef);
  return {
    coordinationEffectsEnabled:
      status?.coordinationEffectsEnabled === true
      && server?.coordinationEffectsEnabled === true,
    coordinationEffectsAvailable:
      server?.coordinationEffectsAvailable === true,
    transportHealth: stringValue(server?.transportHealth),
  };
}

function assessmentEnvelope(input: {
  disposition: string;
  observedAt: string;
  workspace: Workspace;
  paths: string[];
  repository: CrossExecutorGitObservation | null;
  candidates: CodexSessionCandidate[];
  selected: SelectedCodexSession | null;
  safeToSend: boolean;
  reasonCodes: string[];
  action: string;
  effectAvailability?: GatewayEffectAvailability;
  sessionScanComplete?: boolean;
}): JsonRecord {
  const projectedCandidates = input.candidates.slice(0, MAX_MATCHING_SESSIONS);
  return {
    schemaVersion: 1,
    disposition: input.disposition,
    observedAt: input.observedAt,
    workspace: {
      workspaceId: input.workspace.id,
      mode: input.workspace.mode,
      baseSha: input.workspace.worktree?.baseSha,
    },
    repository: input.repository,
    affectedPaths: input.paths,
    candidateCount: input.candidates.length,
    candidates: projectedCandidates.map(projectCandidate),
    candidatesTruncated: projectedCandidates.length < input.candidates.length,
    selected: input.selected ? projectCandidate(input.selected) : null,
    safeToSend: input.safeToSend,
    reasonCodes: input.reasonCodes,
    action: input.action,
    ...(input.effectAvailability
      ? { effectAvailability: input.effectAvailability }
      : {}),
    sessionScanComplete: input.sessionScanComplete ?? true,
    overlapClaimCeiling:
      "potential_repository_or_path_reference_overlap_only_not_writer_ownership_or_exact_hunk_collision",
    authority: coordinationAuthority(),
  };
}

function projectCandidate(candidate: CodexSessionCandidate): JsonRecord {
  return {
    sessionRef: candidate.sessionRef,
    serverRef: candidate.serverRef,
    workspaceRef: candidate.workspaceRef,
    workspaceAlias: candidate.workspaceAlias,
    name: candidate.name,
    lifecycle: candidate.lifecycle,
    loaded: candidate.loaded,
    directInput: candidate.directInput,
    recencyAt: candidate.recencyAt,
    git: {
      sha: candidate.gitSha,
      branch: candidate.branch,
      originDigestSha256: candidate.originDigestSha256,
    },
    matchedPaths: candidate.matchedPaths,
    pathEvidence: candidate.pathEvidence,
    ...(candidateHasActiveTurn(candidate)
      ? { activeTurnRef: candidate.activeTurnRef }
      : {}),
  };
}

function candidateHasActiveTurn(
  candidate: CodexSessionCandidate,
): candidate is SelectedCodexSession {
  return "activeTurnRef" in candidate;
}

function pathEvidenceText(items: unknown[]): string {
  const fragments: string[] = [];
  for (const value of items) {
    const item = asRecord(value);
    const kind = stringValue(item?.kind);
    if (kind === "tool_call" || kind === "mcp_tool_call") {
      if (typeof item?.arguments === "string") {
        fragments.push(item.arguments);
      } else if (item?.arguments !== undefined) {
        fragments.push(JSON.stringify(item.arguments));
      }
      continue;
    }
    if (kind === "file_change" && Array.isArray(item?.paths)) {
      fragments.push(JSON.stringify(item.paths));
    }
  }
  return fragments.join("\n");
}

function coordinationAuthority(): JsonRecord {
  return {
    authority: "executor_local_cross_executor_coordination",
    canonicalTaskOrDecisionAuthority: false,
    writerLeaseAuthority: false,
    publicationAuthority: false,
    runtimeActivationAuthority: false,
    globalLockCreated: false,
    rawThreadIdAccepted: false,
    rawSocketPathAccepted: false,
    repositoryUrlExposed: false,
    exactOverlapInferredFromSilence: false,
    unknownEffectRequiresReconciliation: true,
  };
}

function coordinationErrorProjection(error: unknown): JsonRecord {
  const record = asRecord(error);
  return {
    errorCode: stringValue(record?.code) ?? "CODEX_COORDINATION_DELIVERY_FAILED",
    retryDisposition:
      stringValue(record?.retryDisposition) ?? "reconcile_first",
    errorDigestSha256:
      stringValue(record?.errorDigestSha256) ?? sha256(String(error)),
  };
}

function coordinationErrorCode(error: unknown, fallback: string): string {
  return stringValue(asRecord(error)?.code) ?? fallback;
}

function isActiveLifecycle(value: string): boolean {
  const normalized = value.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
  return normalized === "active" || normalized === "running" || normalized === "inprogress";
}

function isIdleLifecycle(value: string): boolean {
  const normalized = value.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
  return ["idle", "ready", "completed", "succeeded", "done"].includes(normalized);
}

function isTerminalErrorLifecycle(value: string): boolean {
  const normalized = value.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
  return ["notloaded", "systemerror", "terminalerror", "deleted"].includes(normalized);
}

function asRecord(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : undefined;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function resultOutputSchema() {
  return {
    result: z.string(),
  };
}

function jsonResponse(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    structuredContent: {
      result: JSON.stringify(data),
    },
  };
}
