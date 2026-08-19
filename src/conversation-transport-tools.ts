import type { registerAppTool as registerAppToolType } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import type { ConversationTransportConfig, ServerConfig } from "./config.js";
import {
  openDatabase,
  type DatabaseHandle,
} from "./db/client.js";
import {
  ConversationTransportBridgeClient,
  type ConversationTransportBridgePort,
} from "./conversation-transport-bridge-client.js";
import { ConversationTargetBindingStore } from "./conversation-target-binding-store.js";
import {
  ConversationWebUiInteractionBroker,
  type ConversationWebUiInteractionBrokerPort,
} from "./conversation-web-ui-interaction-broker.js";
import { ConversationWakeLowerPlane } from "./conversation-wake-lower-plane.js";
import {
  DEFAULT_EXECUTION_WAKE_COORDINATION_CONFIG,
  ExecutionWakeCoordinationManager,
  type ExecutionWakeCoordinationConfig,
} from "./execution-wake-coordination.js";
import {
  DEFAULT_HOST_TURN_LIFECYCLE_CONFIG,
  HostTurnLifecycleManager,
  type HostTurnLifecycleConfig,
} from "./host-turn-lifecycle.js";
import type { ExecutionScopeIdentity } from "./request-meta.js";
import {
  SqliteInteractionBrokerStore,
  type DurableInteractionBrokerStore,
} from "./interaction-broker-store.js";

type AppToolRegistrar = typeof registerAppToolType;

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

const LOCAL_MUTATION_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

const EFFECT_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};

export const conversationTransportToolNames = {
  bind: "conversation_transport_bind",
  status: "conversation_transport_status",
  pendingRecord: "execution_wake_pending_record",
  wakeStatus: "execution_wake_status",
  wakeAssess: "execution_wake_assess",
  wakeExecute: "execution_wake_execute",
  wakeReconcile: "execution_wake_reconcile",
} as const;

export interface ConversationTransportRuntimeOptions {
  database?: DatabaseHandle;
  bridge?: ConversationTransportBridgePort;
  bindings?: ConversationTargetBindingStore;
  hostTurnConfig?: HostTurnLifecycleConfig;
  hostTurnManager?: HostTurnLifecycleManager;
  interactionBrokerStore?: DurableInteractionBrokerStore;
  webUiInteractions?: ConversationWebUiInteractionBrokerPort;
  wakeConfig?: ExecutionWakeCoordinationConfig;
  wakeManager?: ExecutionWakeCoordinationManager;
}

export class ConversationTransportRuntime {
  readonly database: DatabaseHandle;
  readonly bridge: ConversationTransportBridgePort;
  readonly bindings: ConversationTargetBindingStore;
  readonly hostTurns: HostTurnLifecycleManager;
  readonly interactionBrokerStore: DurableInteractionBrokerStore;
  readonly webUiInteractions: ConversationWebUiInteractionBrokerPort;
  readonly lowerPlane: ConversationWakeLowerPlane;
  readonly wakeManager: ExecutionWakeCoordinationManager;
  private readonly ownsDatabase: boolean;
  private readonly ownsBindings: boolean;
  private readonly ownsHostTurns: boolean;
  private readonly ownsWakeManager: boolean;
  private closed = false;

  constructor(
    readonly config: ConversationTransportConfig,
    stateDir: string,
    options: ConversationTransportRuntimeOptions = {},
  ) {
    this.database = options.database ?? openDatabase(stateDir);
    this.ownsDatabase = options.database === undefined;
    this.bridge = options.bridge ?? new ConversationTransportBridgeClient(config);
    this.bindings = options.bindings
      ?? new ConversationTargetBindingStore(stateDir, this.database);
    this.ownsBindings = options.bindings === undefined;
    this.hostTurns = options.hostTurnManager ?? new HostTurnLifecycleManager(
      options.hostTurnConfig ?? DEFAULT_HOST_TURN_LIFECYCLE_CONFIG,
      stateDir,
      { database: this.database },
    );
    this.ownsHostTurns = options.hostTurnManager === undefined;
    this.interactionBrokerStore = options.interactionBrokerStore
      ?? new SqliteInteractionBrokerStore(this.database);
    this.webUiInteractions = options.webUiInteractions
      ?? new ConversationWebUiInteractionBroker(
        this.interactionBrokerStore,
        this.bridge,
      );
    this.lowerPlane = new ConversationWakeLowerPlane(
      config,
      this.bindings,
      this.bridge,
      this.hostTurns,
      this.webUiInteractions,
    );
    this.wakeManager = options.wakeManager ?? new ExecutionWakeCoordinationManager(
      options.wakeConfig ?? DEFAULT_EXECUTION_WAKE_COORDINATION_CONFIG,
      stateDir,
      this.lowerPlane,
      { database: this.database },
    );
    this.ownsWakeManager = options.wakeManager === undefined;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.ownsWakeManager) this.wakeManager.close();
    if (this.ownsHostTurns) this.hostTurns.close();
    if (this.ownsBindings) this.bindings.close();
    if (this.ownsDatabase) this.database.close();
  }

  async bind(input: {
    targetExecutionScopeRef: string;
    missionRef: string;
    targetAlias: string;
  }) {
    const status = await this.bridge.status(input.targetAlias);
    const binding = this.bindings.bind({
      targetExecutionScopeRef: input.targetExecutionScopeRef,
      missionRef: input.missionRef,
      targetAlias: status.targetAlias,
      targetKind: status.targetKind,
      bridgeTargetRefDigestSha256: status.targetRefDigestSha256,
      evidenceRefs: [
        ...status.evidenceRefs,
        `bridge-binding-ref:${status.bindingRef}`,
        `bridge-binding-generation:${status.bindingGeneration}`,
      ],
    });
    return { binding, status };
  }

  async status(input: {
    targetExecutionScopeRef: string;
    missionRef: string;
  }) {
    const assessment = await this.lowerPlane.inspect(input);
    const binding = this.bindings.get(
      input.targetExecutionScopeRef,
      input.missionRef,
    );
    return {
      ...assessment,
      hostTurnLifecycle: this.hostTurns.status(
        input.targetExecutionScopeRef,
        input.missionRef,
        binding?.bindingRef,
        binding?.bindingGeneration,
      ),
    };
  }

  wakeStatus(
    identity: ExecutionScopeIdentity | undefined,
    input: {
      targetExecutionScopeRef: string;
      missionRef: string;
    },
  ) {
    const coordination = this.wakeManager.status(
      identity,
      input.targetExecutionScopeRef,
      input.missionRef,
    );
    const binding = this.bindings.get(
      input.targetExecutionScopeRef,
      input.missionRef,
    );
    return {
      ...coordination,
      hostTurnLifecycle: this.hostTurns.status(
        input.targetExecutionScopeRef,
        input.missionRef,
        binding?.bindingRef,
        binding?.bindingGeneration,
      ),
    };
  }
}

export function registerConversationTransportTools(
  server: McpServer,
  config: ServerConfig,
  runtime: ConversationTransportRuntime,
  registerTool: AppToolRegistrar,
  identityFromMeta: (meta: unknown) => ExecutionScopeIdentity | undefined,
): void {
  registerTool(
    server,
    conversationTransportToolNames.bind,
    {
      title: "Bind an execution scope to an allowlisted conversation target",
      description:
        "Persist an executor-local binding from one execution scope and mission to a fixed bridge target alias. The bridge validates the alias and returns only digests and transport observations; this tool accepts no raw thread ID, browser URL, socket path, prompt, cookie, or credential.",
      inputSchema: {
        targetExecutionScopeRef: z.string().regex(/^[a-f0-9]{16}$/),
        missionRef: z.string().min(1).max(2_000),
        targetAlias: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/),
      },
      outputSchema: resultOutputSchema(),
      _meta: {},
      annotations: LOCAL_MUTATION_ANNOTATIONS,
    },
    async (input) => jsonResponse(await runtime.bind(input)),
  );

  registerTool(
    server,
    conversationTransportToolNames.status,
    {
      title: "Inspect direct-first conversation transport routing",
      description:
        "Read the current fixed conversation binding, bridge-attested transport candidates, deterministic route selection, upstream limitation codes, and durable provider-neutral host-turn lifecycle evidence. This is read-only and does not deliver a prompt.",
      inputSchema: {
        targetExecutionScopeRef: z.string().regex(/^[a-f0-9]{16}$/),
        missionRef: z.string().min(1).max(2_000),
      },
      outputSchema: resultOutputSchema(),
      _meta: {},
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input) => jsonResponse(await runtime.status(input)),
  );

  registerTool(
    server,
    conversationTransportToolNames.pendingRecord,
    {
      title: "Record bounded pending work for a wake target",
      description:
        "Persist exact durable work references for one execution scope and mission. This records executor-local scheduling state only and does not send a prompt.",
      inputSchema: {
        idempotencyKey: z.string().min(1).max(200),
        targetExecutionScopeRef: z.string().regex(/^[a-f0-9]{16}$/),
        missionRef: z.string().min(1).max(2_000),
        sourceGeneration: z.number().int().min(1),
        workCycleRef: z.string().min(1).max(2_000),
        correlationRef: z.string().min(1).max(2_000),
        taskRefs: z.array(z.string().min(1).max(2_000)).max(100).optional(),
        messageRefs: z.array(z.string().min(1).max(2_000)).max(100).optional(),
        workItemRefs: z.array(z.string().min(1).max(2_000)).max(100).optional(),
        sourceAuthorityRefs: z.array(z.string().min(1).max(2_000)).min(1).max(100),
        actionableCount: z.number().int().min(1),
        highestPriority: z.enum(["low", "normal", "high", "urgent"]).optional(),
        expiresInHours: z.number().positive().max(720).optional(),
      },
      outputSchema: resultOutputSchema(),
      _meta: {},
      annotations: LOCAL_MUTATION_ANNOTATIONS,
    },
    async (input, context) => jsonResponse(runtime.wakeManager.recordPendingWork(
      identityFromMeta(context._meta),
      input,
    )),
  );

  registerTool(
    server,
    conversationTransportToolNames.wakeStatus,
    {
      title: "Inspect wake coordination status",
      description:
        "Read pending work, attempts, throttle, lease state, and the bound host-turn lifecycle for one exact scope and mission. This is executor-local observation only.",
      inputSchema: {
        targetExecutionScopeRef: z.string().regex(/^[a-f0-9]{16}$/),
        missionRef: z.string().min(1).max(2_000),
      },
      outputSchema: resultOutputSchema(),
      _meta: {},
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input, context) => jsonResponse(runtime.wakeStatus(
      identityFromMeta(context._meta),
      input,
    )),
  );

  registerTool(
    server,
    conversationTransportToolNames.wakeAssess,
    {
      title: "Assess whether a conversation wake is ready",
      description:
        "Assess pending work, transport routing, binding freshness, throttles, and lower-plane readiness without delivering a prompt. This records bounded executor-local host-turn evidence and may reconcile stale local attempts, but does not perform an external conversation effect.",
      inputSchema: {
        targetExecutionScopeRef: z.string().regex(/^[a-f0-9]{16}$/),
        missionRef: z.string().min(1).max(2_000),
      },
      outputSchema: resultOutputSchema(),
      _meta: {},
      annotations: LOCAL_MUTATION_ANNOTATIONS,
    },
    async (input, context) => jsonResponse(await runtime.wakeManager.assessWake(
      identityFromMeta(context._meta),
      input.targetExecutionScopeRef,
      input.missionRef,
    )),
  );

  registerTool(
    server,
    conversationTransportToolNames.wakeExecute,
    {
      title: "Execute one permit-bound conversation wake",
      description:
        "Select an attested direct-first route, bind its transport ID and route digest into a short-lived wake permit, and persist the attempt before dispatch. Native RPC delivers through the bounded bridge directly. Web UI delivery additionally requires the durable single-client InteractionBroker lease and checkpoint before the bridge may compose or submit the prompt. This may send one prompt and is disabled unless conversation transport effects are explicitly enabled.",
      inputSchema: {
        idempotencyKey: z.string().min(1).max(200),
        targetExecutionScopeRef: z.string().regex(/^[a-f0-9]{16}$/),
        missionRef: z.string().min(1).max(2_000),
      },
      outputSchema: resultOutputSchema(),
      _meta: {},
      annotations: EFFECT_ANNOTATIONS,
    },
    async (input, context) => {
      if (!config.conversationTransport.effectsEnabled) {
        throw new Error("Conversation transport effects are disabled.");
      }
      return jsonResponse(await runtime.wakeManager.executeWake(
        identityFromMeta(context._meta),
        input,
      ));
    },
  );

  registerTool(
    server,
    conversationTransportToolNames.wakeReconcile,
    {
      title: "Reconcile an indeterminate wake attempt",
      description:
        "Apply explicit effect evidence to one indeterminate wake attempt before any retry or cross-transport fallback. This never infers delivery from silence.",
      inputSchema: {
        idempotencyKey: z.string().min(1).max(200),
        attemptId: z.string().regex(/^wat_[a-f0-9]{32}$/),
        expectedRevision: z.number().int().min(1),
        resolution: z.enum(["effect_absent", "effect_verified"]),
        interactionReconciliationRef: z.string().min(1).max(2_000),
        authorityReadbackRef: z.string().min(1).max(2_000),
        effectReadbackRef: z.string().min(1).max(2_000),
        promptAdmissionRef: z.string().min(1).max(2_000).optional(),
        generationBoundaryRefAfter: z.string().min(1).max(2_000).optional(),
        verificationRefs: z.array(z.string().min(1).max(2_000)).min(1).max(100),
      },
      outputSchema: resultOutputSchema(),
      _meta: {},
      annotations: LOCAL_MUTATION_ANNOTATIONS,
    },
    async (input, context) => jsonResponse(runtime.wakeManager.reconcileAttempt(
      identityFromMeta(context._meta),
      input,
    )),
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
