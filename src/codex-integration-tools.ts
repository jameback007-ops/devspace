import type { registerAppTool as registerAppToolType } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import type { CodexIntegrationConfig, ServerConfig } from "./config.js";
import {
  CodexIntegrationClient,
} from "./codex-integration-client.js";
import type {
  CodexGatewayRequest,
  CodexIntegrationPort,
} from "./codex-integration-protocol.js";

type AppToolRegistrar = typeof registerAppToolType;

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

const LOCAL_RECONCILIATION_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

const EFFECT_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: true,
};

const NON_DESTRUCTIVE_EFFECT_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

const serverRef = z.string().regex(/^cdx_srv_[a-f0-9]{32}$/);
const workspaceRef = z.string().regex(/^cdx_ws_[a-f0-9]{32}$/);
const sessionRef = z.string().regex(/^cdx_ses_[a-f0-9]{32}$/);
const turnRef = z.string().regex(/^cdx_turn_[a-f0-9]{32}$/);
const cursorRef = z.string().regex(/^cdx_cur_[a-f0-9]{32}$/);
const effectRef = z.string().regex(/^cdx_eff_[a-f0-9]{32}$/);
const approvalRef = z.string().regex(/^cdx_apr_[a-f0-9]{32}$/);
const idempotencyKey = z.string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/);

const sessionOpenCommonShape = {
  idempotencyKey,
  serverRef: serverRef.optional(),
  workspaceRef: workspaceRef.optional(),
  model: z.string().min(1).max(300).optional(),
  modelProvider: z.string().min(1).max(300).optional(),
  approvalPolicy: z.enum(["untrusted", "on-request", "never"]).optional(),
  sandbox: z.enum([
    "read-only",
    "workspace-write",
    "danger-full-access",
  ]).optional(),
  personality: z.enum(["none", "friendly", "pragmatic"]).optional(),
  serviceTier: z.string().min(1).max(200).optional(),
  baseInstructions: z.string().min(1).max(48_000).optional(),
  developerInstructions: z.string().min(1).max(48_000).optional(),
};

const sessionOpenInputSchema = z.discriminatedUnion("mode", [
  z.object({
    ...sessionOpenCommonShape,
    mode: z.literal("start"),
    workspaceRef,
    ephemeral: z.boolean().optional(),
  }).strict(),
  z.object({
    ...sessionOpenCommonShape,
    mode: z.literal("resume"),
    sessionRef,
  }).strict(),
  z.object({
    ...sessionOpenCommonShape,
    mode: z.literal("fork"),
    sessionRef,
    lastTurnRef: turnRef.optional(),
    ephemeral: z.boolean().optional(),
  }).strict(),
]);

const turnControlInputSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("submit"),
    idempotencyKey,
    sessionRef,
    message: z.string().min(1).max(24_000),
    workspaceRef: workspaceRef.optional(),
    model: z.string().min(1).max(300).optional(),
    reasoningEffort: z.string().min(1).max(100).optional(),
    reasoningSummary: z.enum(["auto", "concise", "detailed", "none"]).optional(),
    approvalPolicy: z.enum(["untrusted", "on-request", "never"]).optional(),
    personality: z.enum(["none", "friendly", "pragmatic"]).optional(),
    serviceTier: z.string().min(1).max(200).optional(),
    outputSchema: z.record(z.string(), z.unknown()).optional(),
  }).strict(),
  z.object({
    action: z.literal("steer"),
    idempotencyKey,
    sessionRef,
    turnRef,
    message: z.string().min(1).max(24_000),
  }).strict(),
  z.object({
    action: z.literal("interrupt"),
    idempotencyKey,
    sessionRef,
    turnRef,
  }).strict(),
]);

const sessionControlInputSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("name_set"),
    idempotencyKey,
    sessionRef,
    name: z.string().min(1).max(500),
  }).strict(),
  z.object({
    action: z.literal("goal_set"),
    idempotencyKey,
    sessionRef,
    objective: z.string().min(1).max(4_000).optional(),
    status: z.enum([
      "active",
      "paused",
      "blocked",
      "usageLimited",
      "budgetLimited",
      "complete",
    ]).optional(),
    tokenBudget: z.number().int().min(1).max(10_000_000_000).optional(),
  }).strict().refine(
    (value) => value.objective !== undefined
      || value.status !== undefined
      || value.tokenBudget !== undefined,
    { message: "goal_set requires objective, status, or tokenBudget" },
  ),
  z.object({
    action: z.literal("goal_clear"),
    idempotencyKey,
    sessionRef,
  }).strict(),
  z.object({
    action: z.literal("compact"),
    idempotencyKey,
    sessionRef,
  }).strict(),
  z.object({
    action: z.literal("rollback"),
    idempotencyKey,
    sessionRef,
    numTurns: z.number().int().min(1).max(10_000).optional(),
    acknowledgeFilesNotReverted: z.literal(true),
  }).strict(),
  z.object({
    action: z.literal("archive"),
    idempotencyKey,
    sessionRef,
  }).strict(),
  z.object({
    action: z.literal("unarchive"),
    idempotencyKey,
    sessionRef,
  }).strict(),
  z.object({
    action: z.literal("unsubscribe"),
    idempotencyKey,
    sessionRef,
  }).strict(),
  z.object({
    action: z.literal("delete"),
    idempotencyKey,
    sessionRef,
    acknowledgePermanentDelete: z.literal(true),
  }).strict(),
]);

const effectStatusInputSchema = z.union([
  z.object({
    effectRef,
    reconcile: z.boolean().optional(),
  }).strict(),
  z.object({
    idempotencyKey,
    reconcile: z.boolean().optional(),
  }).strict(),
]);

export const codexIntegrationToolNames = {
  gatewayStatus: "codex_gateway_status",
  sessionList: "codex_session_list",
  sessionRead: "codex_session_read",
  sessionActivity: "codex_session_activity",
  sessionMetrics: "codex_session_metrics",
  accountUsage: "codex_account_usage",
  modelList: "codex_model_list",
  liveEvents: "codex_live_events",
  approvalList: "codex_approval_list",
  sessionOpen: "codex_session_open",
  turnControl: "codex_turn_control",
  sessionControl: "codex_session_control",
  approvalRespond: "codex_approval_respond",
  effectStatus: "codex_effect_status",
} as const;

export interface CodexIntegrationRuntimeOptions {
  port?: CodexIntegrationPort;
}

export class CodexIntegrationRuntime {
  readonly port: CodexIntegrationPort;

  constructor(
    readonly config: CodexIntegrationConfig,
    options: CodexIntegrationRuntimeOptions = {},
  ) {
    this.port = options.port ?? new CodexIntegrationClient(config);
  }

  async request(
    command: CodexGatewayRequest["command"],
    input: Record<string, unknown> = {},
  ): Promise<unknown> {
    return await this.port.request({
      ...input,
      schemaVersion: 1,
      command,
    });
  }
}

export function registerCodexIntegrationTools(
  server: McpServer,
  config: ServerConfig,
  runtime: CodexIntegrationRuntime,
  registerTool: AppToolRegistrar,
): void {
  registerTool(
    server,
    codexIntegrationToolNames.gatewayStatus,
    {
      title: "Inspect the native Codex integration gateway",
      description:
        "Read the server-owned Codex App Server registry, live transport health, workspace aliases, native capability projection, and effect availability. This gateway gives DevSpace full typed access to Codex without wrapping or narrowing Codex's own native execution lane. It accepts no raw socket path, thread ID, turn ID, filesystem path, or arbitrary RPC method.",
      inputSchema: {},
      outputSchema: resultOutputSchema(),
      _meta: {},
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async () => jsonResponse(await runtime.request("codex_gateway_status")),
  );

  registerTool(
    server,
    codexIntegrationToolNames.sessionList,
    {
      title: "List native Codex sessions",
      description:
        "Enumerate persisted and loaded Codex sessions across one or all configured App Servers. Results use opaque server/session/workspace refs and distinguish persisted state, loaded state, lifecycle, direct-input evidence, Git metadata, and activity/metrics capability. A session list is executor observation, not canonical task or writer authority.",
      inputSchema: {
        serverRef: serverRef.optional(),
        workspaceRef: workspaceRef.optional(),
        archived: z.boolean().optional(),
        searchTerm: z.string().min(1).max(1_000).optional(),
        sortKey: z.enum([
          "created_at",
          "updated_at",
          "recency_at",
          "section_position",
        ]).optional(),
        sortDirection: z.enum(["asc", "desc"]).optional(),
        limit: z.number().int().min(1).max(100).optional(),
        cursorRef: cursorRef.optional(),
      },
      outputSchema: resultOutputSchema(),
      _meta: {},
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input) => jsonResponse(
      await runtime.request("codex_session_list", input),
    ),
  );

  registerTool(
    server,
    codexIntegrationToolNames.sessionRead,
    {
      title: "Read one native Codex session",
      description:
        "Read one opaque Codex session with fresh App Server lifecycle, loaded/direct-input state, bounded recent turns, safe goal telemetry, workspace/Git projection, and the correct thread-metrics route. Raw native IDs, rollout paths, private reasoning, credentials, and unrestricted filesystem paths remain excluded.",
      inputSchema: {
        sessionRef,
        includeTurns: z.boolean().optional(),
        includeGoal: z.boolean().optional(),
        includeUsage: z.boolean().optional(),
        turnLimit: z.number().int().min(1).max(100).optional(),
      },
      outputSchema: resultOutputSchema(),
      _meta: {},
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input) => jsonResponse(
      await runtime.request("codex_session_read", input),
    ),
  );

  registerTool(
    server,
    codexIntegrationToolNames.sessionActivity,
    {
      title: "Read bounded Codex session activity",
      description:
        "Read a newest-first, paginated view of visible Codex messages, lifecycle events, tool activity, file changes, MCP calls, and web results from one opaque session. view=messages excludes tools; combined omits tool arguments/results; audit includes bounded redacted observable arguments/results. Private reasoning and detected secrets are always excluded.",
      inputSchema: {
        sessionRef,
        view: z.enum(["messages", "combined", "audit"]).optional(),
        limit: z.number().int().min(1).max(100).optional(),
        cursorRef: cursorRef.optional(),
      },
      outputSchema: resultOutputSchema(),
      _meta: {},
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input) => jsonResponse(
      await runtime.request("codex_session_activity", input),
    ),
  );

  registerTool(
    server,
    codexIntegrationToolNames.sessionMetrics,
    {
      title: "Measure Codex session performance",
      description:
        "Build or incrementally refresh aggregate session and per-turn metrics from the protected Codex rollout: duration, lifecycle, token/cache usage, tool/MCP/web activity, compaction, repeated target digests, file-change counts, and efficiency ratios. Only aggregate state is persisted; private reasoning and raw transcript content are not.",
      inputSchema: {
        sessionRef,
        turnLimit: z.number().int().min(1).max(500).optional(),
        forceReindex: z.boolean().optional(),
      },
      outputSchema: resultOutputSchema(),
      _meta: {},
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input) => jsonResponse(
      await runtime.request("codex_session_metrics", input),
    ),
  );

  registerTool(
    server,
    codexIntegrationToolNames.accountUsage,
    {
      title: "Read Codex account usage and rate limits",
      description:
        "Read Codex usage history and current rate-limit windows from one configured App Server. Validated 0.149 profiles return native thread-scoped usage when sessionRef is supplied; validated 0.147 profiles remain account-scoped and use codex_session_metrics for exact per-session evidence. Native thread IDs are never returned.",
      inputSchema: {
        serverRef: serverRef.optional(),
        sessionRef: sessionRef.optional(),
      },
      outputSchema: resultOutputSchema(),
      _meta: {},
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input) => jsonResponse(
      await runtime.request("codex_account_usage", input),
    ),
  );

  registerTool(
    server,
    codexIntegrationToolNames.modelList,
    {
      title: "List models native to one Codex App Server",
      description:
        "List the models, reasoning efforts, modalities, service tiers, and defaults advertised by one configured Codex App Server. This is the source for validating model selections before session or turn effects.",
      inputSchema: {
        serverRef: serverRef.optional(),
        includeHidden: z.boolean().optional(),
        limit: z.number().int().min(1).max(100).optional(),
        cursorRef: cursorRef.optional(),
      },
      outputSchema: resultOutputSchema(),
      _meta: {},
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input) => jsonResponse(
      await runtime.request("codex_model_list", input),
    ),
  );

  registerTool(
    server,
    codexIntegrationToolNames.liveEvents,
    {
      title: "Read live native Codex App Server events",
      description:
        "Read a bounded sequence-numbered window from the persistent native App Server connection. This is the real-time complement to codex_session_activity: visible assistant/plan deltas and lifecycle/status/token notifications are projected, while private reasoning, raw command/tool output, audio, SDP, native IDs, and unrestricted paths are excluded or reduced to digests. A sequence gap is reported explicitly after buffer rollover.",
      inputSchema: {
        serverRef: serverRef.optional(),
        sessionRef: sessionRef.optional(),
        afterSequence: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
        limit: z.number().int().min(1).max(500).optional(),
      },
      outputSchema: resultOutputSchema(),
      _meta: {},
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input) => jsonResponse(
      await runtime.request("codex_live_events", input),
    ),
  );

  registerTool(
    server,
    codexIntegrationToolNames.approvalList,
    {
      title: "List pending native Codex approvals and input requests",
      description:
        "List bounded server-initiated requests received on persistent native App Server channels: command/file/permission approval, non-secret user input, MCP elicitation, and compatible legacy approvals. The gateway never auto-approves. Results use opaque approval/session/turn/item refs and safe projections; native request IDs and raw payloads remain process-local.",
      inputSchema: {
        serverRef: serverRef.optional(),
        sessionRef: sessionRef.optional(),
        includeTerminal: z.boolean().optional(),
      },
      outputSchema: resultOutputSchema(),
      _meta: {},
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input) => jsonResponse(
      await runtime.request("codex_approval_list", input),
    ),
  );

  registerTool(
    server,
    codexIntegrationToolNames.sessionOpen,
    {
      title: "Start, resume, or fork a native Codex session",
      description:
        "Execute one idempotent typed Codex thread lifecycle effect. mode=start requires an allowlisted workspaceRef; resume/fork require an opaque sessionRef. Native model, sandbox, approval, instructions, and service-tier capabilities remain available without exposing raw native IDs or paths. Acceptance is executor-local transport evidence, not product writer or publication authority.",
      inputSchema: sessionOpenInputSchema,
      outputSchema: resultOutputSchema(),
      _meta: {},
      annotations: NON_DESTRUCTIVE_EFFECT_ANNOTATIONS,
    },
    async (input) => jsonResponse(
      await runtime.request("codex_session_open", input),
    ),
  );

  registerTool(
    server,
    codexIntegrationToolNames.turnControl,
    {
      title: "Submit, steer, or interrupt a native Codex turn",
      description:
        "Execute one idempotent typed turn effect against an opaque Codex session. submit dynamically starts when idle or steers the exact active turn under race reconciliation; steer and interrupt require an opaque turnRef. Prompt text is never persisted by the gateway. Unknown transport outcomes become indeterminate and must be reconciled rather than replayed.",
      inputSchema: turnControlInputSchema,
      outputSchema: resultOutputSchema(),
      _meta: {},
      annotations: EFFECT_ANNOTATIONS,
    },
    async (input) => jsonResponse(
      await runtime.request("codex_turn_control", input),
    ),
  );

  registerTool(
    server,
    codexIntegrationToolNames.sessionControl,
    {
      title: "Control a native Codex session lifecycle",
      description:
        "Execute one idempotent typed session effect: set name or goal, clear goal, compact, roll back Codex conversation history, archive, unarchive, unsubscribe this bridge connection, or permanently delete. Rollback explicitly does not revert filesystem changes; rollback and delete require dedicated acknowledgements. Effects remain executor-local and do not grant product authority.",
      inputSchema: sessionControlInputSchema,
      outputSchema: resultOutputSchema(),
      _meta: {},
      annotations: EFFECT_ANNOTATIONS,
    },
    async (input) => jsonResponse(
      await runtime.request("codex_session_control", input),
    ),
  );

  registerTool(
    server,
    codexIntegrationToolNames.approvalRespond,
    {
      title: "Respond to one native Codex approval or input request",
      description:
        "Respond on the exact persistent App Server connection and generation bound to an opaque approvalRef. Supports typed command/file/permission decisions, non-secret request_user_input answers, MCP form elicitation, and explicit policy amendments. Session-wide approvals and policy amendments require dedicated acknowledgements. Secret questions and URL-mode elicitation acceptance are forbidden. Every response is idempotent and remains indeterminate until native serverRequest/resolved confirmation or later reconciliation.",
      inputSchema: {
        approvalRef,
        idempotencyKey,
        decision: z.enum([
          "accept",
          "acceptForSession",
          "decline",
          "cancel",
          "answer",
          "acceptWithExecpolicyAmendment",
          "applyNetworkPolicyAmendment",
        ]),
        answers: z.record(
          z.string().min(1).max(500),
          z.array(z.string().min(1).max(4_000)).min(1).max(20),
        ).optional(),
        content: z.record(z.string(), z.unknown()).optional(),
        rejectionReason: z.string().min(1).max(2_000).optional(),
        execpolicyAmendment: z.array(
          z.string().min(1).max(2_000),
        ).min(1).max(100).optional(),
        networkPolicyAmendment: z.object({
          host: z.string().min(1).max(1_000),
          action: z.enum(["allow", "deny"]),
        }).optional(),
        acknowledgeSessionWideApproval: z.boolean().optional(),
        acknowledgePolicyAmendment: z.boolean().optional(),
      },
      outputSchema: resultOutputSchema(),
      _meta: {},
      annotations: EFFECT_ANNOTATIONS,
    },
    async (input) => jsonResponse(
      await runtime.request("codex_approval_respond", input),
    ),
  );

  registerTool(
    server,
    codexIntegrationToolNames.effectStatus,
    {
      title: "Read or reconcile one Codex gateway effect",
      description:
        "Read one effect receipt by opaque effectRef or exact idempotencyKey. For in-flight or indeterminate effects, reconcile=true performs bounded native readback where an exact observation is possible; it never blindly retries. The receipt remains executor-local evidence rather than canonical task, writer, runtime, or business-effect state.",
      inputSchema: effectStatusInputSchema,
      outputSchema: resultOutputSchema(),
      _meta: {},
      annotations: LOCAL_RECONCILIATION_ANNOTATIONS,
    },
    async (input) => jsonResponse(
      await runtime.request("codex_effect_status", input),
    ),
  );
}

function resultOutputSchema(): z.ZodRawShape {
  return {
    result: z.string(),
    data: z.unknown(),
  };
}

function jsonResponse(data: unknown) {
  const result = JSON.stringify(data, null, 2);
  return {
    content: [{ type: "text" as const, text: result }],
    structuredContent: { result, data },
  };
}
