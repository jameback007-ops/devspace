import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import type { ExecutionScopeIdentity } from "./request-meta.js";
import type { ServerConfig } from "./config.js";
import {
  assertLocalAgentProviderAvailable,
} from "./local-agent-availability.js";
import {
  isLocalAgentProvider,
  loadLocalAgentProfiles,
  type LocalAgentProfile,
  type LocalAgentProvider,
} from "./local-agent-profiles.js";
import {
  LocalAgentTurnQueue,
  type LocalAgentIndeterminateResolution,
  type LocalAgentQueueSummary,
  type LocalAgentTurnEnvelope,
  type LocalAgentTurnView,
} from "./local-agent-queue.js";
import {
  createLocalAgentStore,
  type LocalAgentListScope,
  type LocalAgentRecord,
  type LocalAgentStore,
} from "./local-agent-store.js";
import {
  runLocalAgentProvider,
} from "./local-agent-adapters.js";
import type { LocalAgentRunInput, LocalAgentRunResult } from "./local-agent-runtime.js";

export interface LocalAgentCoordinatorOptions {
  launchWorker?: (agentId: string, workerId: string) => void;
  runProvider?: (
    provider: LocalAgentProvider,
    input: LocalAgentRunInput,
  ) => Promise<LocalAgentRunResult>;
  loadProfiles?: (
    config: ServerConfig,
    workspaceRoot: string,
  ) => Promise<LocalAgentProfile[]>;
  assertProviderAvailable?: (provider: LocalAgentProvider) => void;
  now?: () => number;
}

export interface LocalAgentSessionView extends LocalAgentRecord {
  schemaVersion: 1;
  continuationSupported: boolean;
  queue: LocalAgentQueueSummary;
  recentTurns?: LocalAgentTurnView[];
}

export interface LocalAgentMessageSendInput extends LocalAgentTurnEnvelope {
  agentId: string;
  supersedePending?: boolean;
}

export interface LocalAgentWorkerResult {
  acquired: boolean;
  processedTurnIds: string[];
  blockedTurnIds: string[];
  stoppedAfterFailure: boolean;
}

const DIRECT_CONTINUATION_PROVIDERS = new Set<LocalAgentProvider>([
  "codex",
  "claude",
  "opencode",
  "pi",
]);

export function localAgentProviderSupportsContinuation(
  provider: string,
): boolean {
  return isLocalAgentProvider(provider) && DIRECT_CONTINUATION_PROVIDERS.has(provider);
}

export function launchDetachedLocalAgentWorker(
  cliEntrypoint: string,
  agentId: string,
  workerId: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const child = spawn(process.execPath, [
    ...process.execArgv,
    cliEntrypoint,
    "agents",
    "__worker",
    agentId,
    "--worker-id",
    workerId,
  ], {
    detached: true,
    stdio: "ignore",
    env,
  });
  child.unref();
}

export class LocalAgentCoordinator {
  readonly queue: LocalAgentTurnQueue;
  readonly store: LocalAgentStore;
  private readonly launchWorker?: (agentId: string, workerId: string) => void;
  private readonly runProvider: NonNullable<LocalAgentCoordinatorOptions["runProvider"]>;
  private readonly loadProfiles: NonNullable<LocalAgentCoordinatorOptions["loadProfiles"]>;
  private readonly assertProviderAvailable: NonNullable<
    LocalAgentCoordinatorOptions["assertProviderAvailable"]
  >;
  private closed = false;

  constructor(
    readonly config: ServerConfig,
    options: LocalAgentCoordinatorOptions = {},
  ) {
    this.queue = new LocalAgentTurnQueue(
      config.localAgentQueue,
      config.stateDir,
      { now: options.now },
    );
    this.store = createLocalAgentStore(config);
    this.launchWorker = options.launchWorker;
    this.runProvider = options.runProvider ?? runLocalAgentProvider;
    this.loadProfiles = options.loadProfiles ?? loadLocalAgentProfiles;
    this.assertProviderAvailable = options.assertProviderAvailable
      ?? ((provider) => assertLocalAgentProviderAvailable(
        provider,
        process.env,
        config.localAgentBilling.mode,
      ));
  }

  listSessions(
    scope: LocalAgentListScope = {},
    options: { includeRecentTurns?: boolean; turnLimit?: number } = {},
  ): LocalAgentSessionView[] {
    this.assertOpen();
    return this.store.list(scope).map((record) =>
      this.sessionView(record, options.includeRecentTurns, options.turnLimit)
    );
  }

  sessionStatus(
    agentIdOrPrefix: string,
    options: { includeRecentTurns?: boolean; turnLimit?: number } = {},
  ): LocalAgentSessionView {
    this.assertOpen();
    const record = this.store.get(agentIdOrPrefix);
    if (!record) throw new Error(`Unknown local agent session: ${agentIdOrPrefix}`);
    return this.sessionView(record, options.includeRecentTurns ?? true, options.turnLimit);
  }

  enqueueExecutionMessage(
    senderIdentity: ExecutionScopeIdentity | undefined,
    input: LocalAgentMessageSendInput,
  ): {
    turn: LocalAgentTurnView;
    idempotentReplay: boolean;
    supersededTurnIds: string[];
    workerRequested: boolean;
    session: LocalAgentSessionView;
  } {
    this.assertOpen();
    if (!senderIdentity) {
      throw new Error("A stable execution scope is required to message a local agent session.");
    }
    const agent = this.requireContinuableAgent(input.agentId);
    const result = this.queue.enqueue({
      ...input,
      agentId: agent.id,
      sourceKind: "execution_scope",
      senderScopeRef: senderIdentity.scopeRef,
      model: agent.model,
      thinking: agent.thinking,
    });
    const workerRequested = this.requestWorkerIfNeeded(result.turn, result.idempotentReplay);
    return {
      ...result,
      workerRequested,
      session: this.sessionStatus(agent.id, { includeRecentTurns: false }),
    };
  }

  enqueueCliPrompt(
    agentIdOrPrefix: string,
    prompt: string,
    options: {
      idempotencyKey?: string;
      supersedePending?: boolean;
      model?: string;
      thinking?: string;
    } = {},
  ): {
    turn: LocalAgentTurnView;
    idempotentReplay: boolean;
    supersededTurnIds: string[];
    workerRequested: boolean;
    session: LocalAgentSessionView;
  } {
    this.assertOpen();
    const agent = this.store.get(agentIdOrPrefix);
    if (!agent) throw new Error(`Unknown local agent session: ${agentIdOrPrefix}`);
    this.providerType(agent.provider);
    if (!localAgentProviderSupportsContinuation(agent.provider)) {
      const summary = this.queue.summary(agent.id);
      const activeTurns = summary.queued
        + summary.running
        + summary.cancelRequested
        + summary.indeterminate;
      if (agent.providerSessionId || activeTurns > 0) {
        throw new Error(
          `Local agent provider ${agent.provider} does not expose a qualified resume path in this DevSpace version; only one initial turn may be pending.`,
        );
      }
    }
    const effectiveModel = options.model ?? agent.model;
    const effectiveThinking = options.thinking ?? agent.thinking;
    const idempotencyKey = options.idempotencyKey
      ?? `cli-${randomUUID()}`;
    const result = this.queue.enqueue({
      agentId: agent.id,
      sourceKind: "cli",
      idempotencyKey,
      kind: "instruction",
      priority: "normal",
      body: prompt,
      supersedePending: options.supersedePending,
      model: effectiveModel,
      thinking: effectiveThinking,
      requestedModel: options.model,
      requestedThinking: options.thinking,
    });
    if (options.model !== undefined || options.thinking !== undefined) {
      this.store.update(agent.id, {
        model: effectiveModel,
        thinking: effectiveThinking,
      });
    }
    const workerRequested = this.requestWorkerIfNeeded(result.turn, result.idempotentReplay);
    return {
      ...result,
      workerRequested,
      session: this.sessionStatus(agent.id, { includeRecentTurns: false }),
    };
  }

  turnStatus(turnId: string): LocalAgentTurnView {
    this.assertOpen();
    return this.queue.getTurn(turnId);
  }

  cancelTurn(turnId: string, note?: string): LocalAgentTurnView {
    this.assertOpen();
    return this.queue.requestCancel(turnId, note);
  }

  resolveTurn(
    turnId: string,
    resolution: LocalAgentIndeterminateResolution,
    note: string,
    options: { providerSessionIdAfter?: string; finalResponse?: string } = {},
  ): { turn: LocalAgentTurnView; workerRequested: boolean } {
    this.assertOpen();
    const turn = this.queue.resolveIndeterminate({
      turnId,
      resolution,
      note,
      providerSessionIdAfter: options.providerSessionIdAfter,
      finalResponse: options.finalResponse,
    });
    const summary = this.queue.summary(turn.agentId);
    return {
      turn,
      workerRequested:
        summary.queued > 0 ? this.requestWorker(turn.agentId) : false,
    };
  }

  resumeSession(
    agentIdOrPrefix: string,
    note?: string,
  ): {
    queue: LocalAgentQueueSummary;
    workerRequested: boolean;
    session: LocalAgentSessionView;
  } {
    this.assertOpen();
    const agent = this.store.get(agentIdOrPrefix);
    if (!agent) throw new Error(`Unknown local agent session: ${agentIdOrPrefix}`);
    const resumedQueue = this.queue.resumeAfterFailure(agent.id, note);
    const recoverableWithoutWorker = !resumedQueue.workerLeaseActive
      && (
        resumedQueue.queued
        + resumedQueue.running
        + resumedQueue.cancelRequested
      ) > 0;
    const workerRequested = recoverableWithoutWorker
      ? this.requestWorker(agent.id)
      : false;
    const session = this.sessionStatus(agent.id, { includeRecentTurns: false });
    return {
      queue: session.queue,
      workerRequested,
      session,
    };
  }

  async runWorker(agentIdOrPrefix: string, workerIdInput?: string): Promise<LocalAgentWorkerResult> {
    this.assertOpen();
    const agent = this.store.get(agentIdOrPrefix);
    if (!agent) throw new Error(`Unknown local agent session: ${agentIdOrPrefix}`);
    const workerId = workerIdInput?.trim() || `wrk_${randomUUID()}`;
    const lease = this.queue.acquireLease(agent.id, workerId);
    if (!lease.acquired) {
      return {
        acquired: false,
        processedTurnIds: [],
        blockedTurnIds: [],
        stoppedAfterFailure: false,
      };
    }

    const processedTurnIds: string[] = [];
    const blockedTurnIds = [...lease.indeterminateTurnIds];
    let stoppedAfterFailure = false;
    let currentTurnId: string | undefined;
    let currentAbortController: AbortController | undefined;
    let leaseLost = false;
    let leaseReleased = false;
    const heartbeat = setInterval(() => {
      try {
        if (!this.queue.heartbeat(agent.id, workerId)) {
          leaseLost = true;
          currentAbortController?.abort(
            new Error("Local agent worker lease was lost during provider execution."),
          );
          return;
        }
        if (
          currentTurnId
          && this.queue.cancellationRequested(currentTurnId, workerId)
        ) {
          currentAbortController?.abort(
            new Error("Local agent turn cancellation was requested."),
          );
        }
      } catch {
        leaseLost = true;
        currentAbortController?.abort(
          new Error("Local agent worker heartbeat failed."),
        );
      }
    }, this.config.localAgentQueue.heartbeatMs);

    try {
      for (;;) {
        if (leaseLost) break;
        const claim = this.queue.claimNext(agent.id, workerId);
        if (claim.state === "empty") {
          const release = this.queue.releaseLeaseIfIdle(agent.id, workerId);
          if (release === "work_available") continue;
          leaseReleased = release === "released";
          break;
        }
        if (claim.state === "lease_lost") break;
        if (claim.state === "blocked") {
          blockedTurnIds.push(...(claim.blockingTurnIds ?? []));
          break;
        }
        if (!claim.turn) break;

        currentTurnId = claim.turn.turnId;
        currentAbortController = new AbortController();
        let providerResult: LocalAgentRunResult | undefined;
        try {
          const running = this.queue.markRunning(currentTurnId, workerId);
          const currentAgent = this.store.get(agent.id);
          if (!currentAgent) throw new Error(`Unknown local agent session: ${agent.id}`);
          if (
            currentAgent.providerSessionId
            && !localAgentProviderSupportsContinuation(currentAgent.provider)
          ) {
            throw new Error(
              `Local agent provider ${currentAgent.provider} cannot resume the existing provider session.`,
            );
          }
          const provider = this.assertProvider(currentAgent.provider);
          const prompt = await this.composePrompt(currentAgent, running);
          providerResult = await this.runProvider(provider, {
            prompt,
            workspace: currentAgent.workspaceRoot,
            providerSessionId: currentAgent.providerSessionId,
            writeMode: "allowed",
            model: running.model,
            thinking: running.thinking,
            signal: currentAbortController.signal,
            billingMode: this.config.localAgentBilling.mode,
          });
          if (leaseLost) {
            const indeterminate = this.queue.markIndeterminate(
              currentTurnId,
              workerId,
              "worker_lease_lost",
              `Worker ${workerId} lost its lease before provider result admission for ${currentTurnId}.`,
              {
                providerSessionIdAfter: providerResult.providerSessionId,
                finalResponse: providerResult.finalResponse,
              },
            );
            blockedTurnIds.push(indeterminate.turnId);
            break;
          }
          const completed = this.queue.completeSuccess(
            currentTurnId,
            workerId,
            providerResult,
          );
          if (completed.status === "indeterminate") {
            blockedTurnIds.push(completed.turnId);
            break;
          }
          processedTurnIds.push(currentTurnId);
        } catch (error) {
          const durableTurn = this.queue.getTurn(currentTurnId);
          if (durableTurn.status === "cancelled") {
            processedTurnIds.push(currentTurnId);
            continue;
          }
          if (durableTurn.status === "indeterminate") {
            blockedTurnIds.push(currentTurnId);
            break;
          }
          if (leaseLost) {
            const indeterminate = this.queue.markIndeterminate(
              currentTurnId,
              workerId,
              "worker_lease_lost",
              error instanceof Error ? error.message : String(error),
            );
            blockedTurnIds.push(indeterminate.turnId);
            break;
          }
          if (providerResult) {
            const indeterminate = this.queue.markIndeterminate(
              currentTurnId,
              workerId,
              "provider_result_admission_failed",
              error instanceof Error ? error.message : String(error),
              {
                providerSessionIdAfter: providerResult.providerSessionId,
                finalResponse: providerResult.finalResponse,
              },
            );
            blockedTurnIds.push(indeterminate.turnId);
            break;
          }
          const cancellationRequested = this.queue.cancellationRequested(
            currentTurnId,
            workerId,
          );
          const terminalError =
            cancellationRequested && currentAbortController.signal.aborted
              ? localAgentCancellationError()
              : error;
          const failed = this.queue.completeFailure(
            currentTurnId,
            workerId,
            terminalError,
          );
          if (failed.status === "indeterminate") {
            blockedTurnIds.push(failed.turnId);
            break;
          }
          processedTurnIds.push(currentTurnId);
          if (failed.status !== "cancelled") {
            stoppedAfterFailure = true;
            break;
          }
        } finally {
          currentTurnId = undefined;
          currentAbortController = undefined;
        }
      }
    } finally {
      clearInterval(heartbeat);
      if (!leaseReleased) this.queue.releaseLease(agent.id, workerId);
    }

    return {
      acquired: true,
      processedTurnIds,
      blockedTurnIds: Array.from(new Set(blockedTurnIds)),
      stoppedAfterFailure,
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.queue.close();
    this.store.close();
  }

  private sessionView(
    record: LocalAgentRecord,
    includeRecentTurns = false,
    turnLimit = 10,
  ): LocalAgentSessionView {
    return {
      schemaVersion: 1,
      ...record,
      continuationSupported: localAgentProviderSupportsContinuation(record.provider),
      queue: this.queue.summary(record.id),
      recentTurns: includeRecentTurns
        ? this.queue.listTurns(record.id, {
            limit: turnLimit,
            includeTerminal: true,
          })
        : undefined,
    };
  }

  private requireContinuableAgent(agentIdOrPrefix: string): LocalAgentRecord {
    const agent = this.store.get(agentIdOrPrefix);
    if (!agent) throw new Error(`Unknown local agent session: ${agentIdOrPrefix}`);
    if (!localAgentProviderSupportsContinuation(agent.provider)) {
      throw new Error(
        `Local agent provider ${agent.provider} does not expose a qualified provider-session continuation adapter.`,
      );
    }
    return agent;
  }

  private assertProvider(provider: string): LocalAgentProvider {
    const selected = this.providerType(provider);
    this.assertProviderAvailable(selected);
    return selected;
  }

  private providerType(provider: string): LocalAgentProvider {
    if (!isLocalAgentProvider(provider)) {
      throw new Error(`Unknown local agent provider: ${provider}`);
    }
    return provider;
  }

  private requestWorkerIfNeeded(
    turn: LocalAgentTurnView,
    idempotentReplay: boolean,
  ): boolean {
    if (idempotentReplay && turn.status !== "queued") return false;
    return this.requestWorker(turn.agentId);
  }

  private requestWorker(agentId: string): boolean {
    if (!this.launchWorker) return false;
    const agent = this.store.get(agentId);
    if (!agent || agent.status === "error" || agent.status === "blocked") return false;
    if (this.queue.summary(agentId).indeterminate > 0) return false;
    const workerId = `wrk_${randomUUID()}`;
    const lease = this.queue.acquireLease(agentId, workerId);
    if (!lease.acquired) return false;
    if (lease.indeterminateTurnIds.length > 0) {
      this.queue.releaseLease(agentId, workerId);
      return false;
    }
    try {
      this.launchWorker(agentId, workerId);
      return true;
    } catch (error) {
      this.queue.releaseLease(agentId, workerId);
      throw error;
    }
  }

  private async composePrompt(
    agent: LocalAgentRecord,
    turn: LocalAgentTurnView,
  ): Promise<string> {
    const profiles = await this.loadProfiles(this.config, agent.workspaceRoot);
    const profile = profiles.find((candidate) => candidate.name === agent.profileName);
    if (!profile && agent.profileName !== agent.provider) {
      throw new Error(`Subagent profile not found: ${agent.profileName}`);
    }
    const envelope = formatLocalAgentTurnEnvelope(turn);
    const profileBody = profile?.body.trim();
    return profileBody
      ? `${profileBody}\n\nTask:\n${envelope}`
      : envelope;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Local agent coordinator is closed.");
  }
}

export function formatLocalAgentTurnEnvelope(turn: LocalAgentTurnView): string {
  if (turn.sourceKind === "cli") return turn.body;
  const lines = [
    "DevSpace execution coordination message",
    `Kind: ${turn.kind}`,
    `Priority: ${turn.priority}`,
    `Sender scope: ${turn.senderScopeRef ?? "unknown"}`,
    ...(turn.correlationRef ? [`Correlation: ${turn.correlationRef}`] : []),
    "",
    turn.body,
  ];
  return lines.join("\n");
}

function localAgentCancellationError(): Error {
  const error = new Error("Local agent provider turn was cancelled.");
  error.name = "AbortError";
  return error;
}
