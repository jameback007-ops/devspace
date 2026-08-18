import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import type { registerAppTool as registerAppToolType } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import type { ServerConfig } from "./config.js";
import { logEvent } from "./logger.js";

const DEFAULT_ZES_REPOSITORY_ROOT = "/srv/zes-codex/ZES-SYSTEM-BLUEPRINT";
const DEFAULT_ZES_CONTINUATION_PYTHON =
  `${DEFAULT_ZES_REPOSITORY_ROOT}/.venv/bin/python`;
const DEFAULT_ZES_CONTINUATION_LOCATOR =
  `${DEFAULT_ZES_REPOSITORY_ROOT}/release/continuation-read-model-locator.json`;
const DEFAULT_ZES_CONTINUATION_STATE_ROOT =
  "/srv/zes-aoq/aoq01-e77671a/state/continuation-read-model";
const MAX_PROCESS_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 1024 * 1024;
const PROCESS_TIMEOUT_MS = 60_000;
// The embedded projection is advisory and every material effect must revalidate
// through the direct route. A longer bounded cache avoids repeatedly paying a
// multi-owner refresh cost for ordinary execution-scope inspection.
const DEFAULT_PROJECTION_CACHE_TTL_MS = 60_000;
const DEFAULT_PROJECTION_FAILURE_CACHE_TTL_MS = 30_000;

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};

type AppToolRegistrar = typeof registerAppToolType;

export const ZES_CONTINUATION_INTENTS = [
  "inspect",
  "prepare_isolated_candidate",
  "mutate_governed_checkout",
  "publish_repository",
  "runtime_takeover_or_effect_retry",
] as const;

export type ZesContinuationIntent = typeof ZES_CONTINUATION_INTENTS[number];

export interface ZesContinuationSnapshotReadback {
  schemaVersion: 1;
  observedAt: string;
  sourceExpiresAt: string;
  preflight: Record<string, unknown>;
  route?: unknown;
  refresh: {
    status: unknown;
    receiptDigestSha256: unknown;
    snapshotSha256: unknown;
    sourceControlPreflight: unknown;
  };
}

interface ZesContinuationProjectionPolicy {
  authority:
    "fixed_live_ZES_continuation_readback_without_new_tool_discovery";
  readOnly: true;
  fixedRoute: true;
  arbitraryCredentialPathAccepted: false;
  arbitraryRepositoryPathAccepted: false;
  directToolDiscoveryRequired: false;
  clientCatalogFreshnessRequiredForReadback: false;
  catalogStalenessDoesNotEstablishWriterUncertainty: true;
  cacheIsReadOptimizationOnly: true;
  cacheDoesNotGrantAuthority: true;
  downstreamEffectGateMustRevalidate: true;
  repositoryFastPathMayDeferAutomaticRefresh: true;
  canonicalOrProviderStateMutated: false;
  newWriterPublicationTakeoverOrEffectAuthorityGranted: false;
}

export interface ZesContinuationPreflightAvailableProjection {
  schemaVersion: 1;
  capabilityRef: "zes.continuation.preflight.v2";
  status: "available";
  projectionRef: string;
  route: "execution_scope_status_embedded_control_plane";
  directToolName: "zes_continuation_preflight";
  observedAt: string;
  freshUntil: string;
  sourceExpiresAt: string;
  preflight: Record<string, unknown>;
  productRoute?: unknown;
  decisions: Record<ZesContinuationIntent, Record<string, unknown>>;
  refresh: ZesContinuationSnapshotReadback["refresh"];
  policy: ZesContinuationProjectionPolicy;
}

export interface ZesContinuationPreflightRefreshingProjection {
  schemaVersion: 1;
  capabilityRef: "zes.continuation.preflight.v2";
  status: "refreshing";
  projectionRef: string;
  route: "execution_scope_status_embedded_control_plane";
  directToolName: "zes_continuation_preflight";
  refreshStartedAt: string;
  retryAfter: string;
  previousProjectionRef?: string;
  policy: ZesContinuationProjectionPolicy;
}

export interface ZesContinuationPreflightUnavailableProjection {
  schemaVersion: 1;
  capabilityRef: "zes.continuation.preflight.v2";
  status: "unavailable";
  projectionRef: string;
  route: "execution_scope_status_embedded_control_plane";
  directToolName: "zes_continuation_preflight";
  observedAt: string;
  retryAfter: string;
  error: {
    code: "fixed_continuation_preflight_unavailable";
    diagnosticDigestSha256: string;
  };
  policy: ZesContinuationProjectionPolicy;
}

export interface ZesContinuationPreflightDeferredProjection {
  schemaVersion: 1;
  capabilityRef: "zes.continuation.preflight.v2";
  status: "deferred";
  projectionRef: string;
  route: "execution_scope_status_embedded_control_plane";
  directToolName: "zes_continuation_preflight";
  reason:
    | "repository_publication_fast_path_does_not_require_global_runtime_refresh"
    | "automatic_refresh_not_requested";
  previousProjectionRef?: string;
  nextAction:
    "invoke_direct_tool_only_for_governed_checkout_runtime_or_effect_intent";
  policy: ZesContinuationProjectionPolicy;
}

export type ZesContinuationPreflightProjection =
  | ZesContinuationPreflightAvailableProjection
  | ZesContinuationPreflightRefreshingProjection
  | ZesContinuationPreflightUnavailableProjection
  | ZesContinuationPreflightDeferredProjection;

export interface ZesContinuationProjectionRequest {
  refresh?: boolean;
  deferReason?: ZesContinuationPreflightDeferredProjection["reason"];
}

export interface ZesContinuationPreflightProjectionSource {
  project(
    request?: ZesContinuationProjectionRequest,
  ): Promise<ZesContinuationPreflightProjection>;
  warm?(): Promise<void>;
}

export interface ZesContinuationPreflightProjectorOptions {
  now?: () => number;
  cacheTtlMs?: number;
  failureCacheTtlMs?: number;
  refresh?: () => Promise<ZesContinuationSnapshotReadback>;
}

interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface ContinuationRefreshReceipt {
  status?: unknown;
  snapshot_path?: unknown;
  snapshot_sha256?: unknown;
  source_control_preflight?: unknown;
  receipt_digest_sha256?: unknown;
}

interface CachedProjection {
  expiresAtMs: number;
  value: ZesContinuationPreflightProjection;
}

const PROJECTION_POLICY: ZesContinuationProjectionPolicy = {
  authority: "fixed_live_ZES_continuation_readback_without_new_tool_discovery",
  readOnly: true,
  fixedRoute: true,
  arbitraryCredentialPathAccepted: false,
  arbitraryRepositoryPathAccepted: false,
  directToolDiscoveryRequired: false,
  clientCatalogFreshnessRequiredForReadback: false,
  catalogStalenessDoesNotEstablishWriterUncertainty: true,
  cacheIsReadOptimizationOnly: true,
  cacheDoesNotGrantAuthority: true,
  downstreamEffectGateMustRevalidate: true,
  repositoryFastPathMayDeferAutomaticRefresh: true,
  canonicalOrProviderStateMutated: false,
  newWriterPublicationTakeoverOrEffectAuthorityGranted: false,
};

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function canonicalJson(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize);
    const object = record(item);
    if (!object) return item;
    return Object.fromEntries(
      Object.keys(object)
        .sort()
        .map((key) => [key, normalize(object[key])]),
    );
  };
  return JSON.stringify(normalize(value));
}

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function positiveBoundedMilliseconds(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved <= 0 || resolved > 60_000) {
    throw new Error(`${name} must be between 1 and 60000 milliseconds`);
  }
  return Math.trunc(resolved);
}

function continuationDecisions(
  preflight: Record<string, unknown>,
): Record<ZesContinuationIntent, Record<string, unknown>> {
  return Object.fromEntries(
    ZES_CONTINUATION_INTENTS.map((intent) => [
      intent,
      continuationIntentDecision(intent, preflight),
    ]),
  ) as Record<ZesContinuationIntent, Record<string, unknown>>;
}

export function isVerifiedDeepSubset(
  subsetValue: unknown,
  completeValue: unknown,
): boolean {
  if (Array.isArray(subsetValue)) {
    return Array.isArray(completeValue)
      && canonicalJson(subsetValue) === canonicalJson(completeValue);
  }
  const subset = record(subsetValue);
  if (subset) {
    const complete = record(completeValue);
    if (!complete) return false;
    return Object.entries(subset).every(
      ([key, value]) => key in complete
        && isVerifiedDeepSubset(value, complete[key]),
    );
  }
  return Object.is(subsetValue, completeValue);
}

function fixedPath(
  environmentName: string,
  fallback: string,
): string {
  const configured = process.env[environmentName]?.trim();
  return resolve(configured || fallback);
}

export function fixedZesRepositoryRoot(): string {
  return fixedPath(
    "DEVSPACE_ZES_REPOSITORY_ROOT",
    DEFAULT_ZES_REPOSITORY_ROOT,
  );
}

function isInside(path: string, root: string): boolean {
  const resolvedPath = resolve(path);
  const resolvedRoot = resolve(root);
  return resolvedPath === resolvedRoot
    || resolvedPath.startsWith(`${resolvedRoot}/`);
}

async function sha256File(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function runFixedContinuationRefresh(): Promise<ProcessResult> {
  const repositoryRoot = fixedZesRepositoryRoot();
  const python = fixedPath(
    "DEVSPACE_ZES_CONTINUATION_PYTHON",
    DEFAULT_ZES_CONTINUATION_PYTHON,
  );
  const locator = fixedPath(
    "DEVSPACE_ZES_CONTINUATION_LOCATOR",
    DEFAULT_ZES_CONTINUATION_LOCATOR,
  );

  return await new Promise((resolveResult, reject) => {
    const child = spawn(
      python,
      [
        "-m",
        "zes_build_runner.continuation_read_model",
        "--locator",
        locator,
      ],
      {
        cwd: repositoryRoot,
        env: process.env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error("ZES continuation preflight timed out"));
    }, PROCESS_TIMEOUT_MS);

    const append = (target: Buffer[], chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_PROCESS_OUTPUT_BYTES) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.kill("SIGKILL");
        reject(new Error("ZES continuation preflight output exceeded 2 MiB"));
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
        stdout: Buffer.concat(stdout).toString("utf8").trim(),
        stderr: Buffer.concat(stderr).toString("utf8").trim(),
        exitCode: code ?? -1,
      });
    });
  });
}

export function continuationIntentDecision(
  intent: ZesContinuationIntent,
  preflightValue: unknown,
): Record<string, unknown> {
  const preflight = record(preflightValue);
  if (!preflight) {
    throw new Error("ZES continuation preflight payload is missing");
  }
  if (preflight.schema_version !== "zes.continuation-control-preflight.v2") {
    throw new Error(
      `Unsupported ZES continuation preflight contract: ${String(
        preflight.schema_version ?? "missing",
      )}`,
    );
  }

  if (intent === "inspect") {
    const allowed = preflight.safe_to_inspect === true;
    return {
      intent,
      disposition: allowed ? "allowed" : "blocked",
      actionAllowed: allowed,
      blockingFactors: [],
      newAuthorityGranted: false,
    };
  }
  if (intent === "prepare_isolated_candidate") {
    const allowed = preflight.safe_to_prepare_isolated_candidate === true;
    return {
      intent,
      disposition: allowed ? "allowed" : "blocked",
      actionAllowed: allowed,
      blockingFactors: stringArray(
        preflight.isolated_candidate_blocking_factors,
      ),
      newAuthorityGranted: false,
    };
  }
  if (intent === "mutate_governed_checkout") {
    const allowed = preflight.safe_to_mutate_live === true;
    return {
      intent,
      disposition: allowed ? "allowed" : "blocked",
      actionAllowed: allowed,
      blockingFactors: stringArray(
        preflight.repository_mutation_blocking_factors,
      ),
      newAuthorityGranted: false,
    };
  }
  if (intent === "publish_repository") {
    const disposition = preflight.publication_disposition;
    const normalizedDisposition = disposition === "not_required"
      ? "not_required"
      : preflight.safe_to_publish === true
        ? "allowed"
        : "blocked";
    return {
      intent,
      disposition: normalizedDisposition,
      actionAllowed: preflight.safe_to_publish === true,
      publicationRequired: preflight.publication_required === true,
      blockingFactors: stringArray(preflight.publication_blocking_factors),
      newAuthorityGranted: false,
    };
  }

  const reconciliationRequired =
    preflight.must_reconcile_runtime_or_unknown_outcome_first === true;
  return {
    intent,
    disposition: reconciliationRequired
      ? "reconciliation_required"
      : "reconciliation_clear",
    actionAllowed: false,
    reconciliationRequired,
    reconciliationScope: preflight.runtime_reconciliation_scope,
    blockingFactors: reconciliationRequired
      ? ["runtime_or_unknown_outcome_reconciliation_required"]
      : [],
    newAuthorityGranted: false,
    interpretation:
      "A clear reconciliation state does not grant takeover or effect-retry authority.",
  };
}

async function loadFreshContinuationEnvelope(
  receipt: ContinuationRefreshReceipt,
  nowMs = Date.now(),
): Promise<Record<string, unknown>> {
  const snapshotPath = typeof receipt.snapshot_path === "string"
    ? resolve(receipt.snapshot_path)
    : undefined;
  const stateRoot = fixedPath(
    "DEVSPACE_ZES_CONTINUATION_STATE_ROOT",
    DEFAULT_ZES_CONTINUATION_STATE_ROOT,
  );
  if (!snapshotPath || !isInside(snapshotPath, stateRoot)) {
    throw new Error("ZES continuation snapshot path is outside the fixed state root");
  }
  const metadata = await stat(snapshotPath);
  if (!metadata.isFile() || metadata.size > MAX_SNAPSHOT_BYTES) {
    throw new Error("ZES continuation snapshot is missing or exceeds 1 MiB");
  }
  if (
    typeof receipt.snapshot_sha256 !== "string"
    || await sha256File(snapshotPath) !== receipt.snapshot_sha256
  ) {
    throw new Error("ZES continuation snapshot digest mismatch");
  }
  const envelope = JSON.parse(
    await readFile(snapshotPath, "utf8"),
  ) as unknown;
  const value = record(envelope);
  if (!value) throw new Error("ZES continuation snapshot is not an object");
  if (value.schema_version !== "zes.continuation-read-model-envelope.v1") {
    throw new Error("Unsupported ZES continuation read-model envelope");
  }
  const expiresAt = typeof value.expires_at_UTC === "string"
    ? Date.parse(value.expires_at_UTC)
    : Number.NaN;
  if (!Number.isFinite(expiresAt) || expiresAt <= nowMs) {
    throw new Error("ZES continuation snapshot is stale or has no valid expiry");
  }
  return value;
}

export async function refreshZesContinuationSnapshot(): Promise<
  ZesContinuationSnapshotReadback
> {
  const processResult = await runFixedContinuationRefresh();
  if (processResult.exitCode !== 0) {
    const detail = processResult.stderr || processResult.stdout || "no output";
    throw new Error(
      `ZES continuation refresh failed (${processResult.exitCode}): ${detail.slice(0, 1000)}`,
    );
  }
  let receipt: ContinuationRefreshReceipt;
  try {
    receipt = JSON.parse(processResult.stdout) as ContinuationRefreshReceipt;
  } catch (error) {
    throw new Error(
      `ZES continuation refresh returned invalid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (receipt.status !== "refreshed") {
    const detail = processResult.stderr || processResult.stdout;
    throw new Error(
      `ZES continuation refresh returned non-refreshed status: ${detail.slice(0, 1000)}`,
    );
  }
  const envelope = await loadFreshContinuationEnvelope(receipt);
  const sourceExpiresAt = typeof envelope.expires_at_UTC === "string"
    ? envelope.expires_at_UTC
    : undefined;
  if (!sourceExpiresAt) {
    throw new Error("ZES continuation snapshot has no source expiry");
  }
  const payload = record(envelope.payload);
  const control = record(payload?.product_control_plane_preflight);
  const preflight = record(control?.preflight);
  if (!preflight) {
    throw new Error("ZES continuation snapshot lacks the product preflight");
  }
  const receiptPreflight = record(receipt.source_control_preflight);
  if (
    !receiptPreflight
    || !isVerifiedDeepSubset(receiptPreflight, preflight)
  ) {
    throw new Error(
      "ZES continuation refresh receipt is not an exact subset of the snapshot preflight",
    );
  }
  return {
    schemaVersion: 1,
    observedAt: new Date().toISOString(),
    sourceExpiresAt,
    preflight: structuredClone(preflight),
    route: control?.route,
    refresh: {
      status: receipt.status,
      receiptDigestSha256: receipt.receipt_digest_sha256,
      snapshotSha256: receipt.snapshot_sha256,
      sourceControlPreflight: receipt.source_control_preflight,
    },
  };
}

export class ZesContinuationPreflightProjector
implements ZesContinuationPreflightProjectionSource {
  private readonly now: () => number;
  private readonly cacheTtlMs: number;
  private readonly failureCacheTtlMs: number;
  private readonly refresh: () => Promise<ZesContinuationSnapshotReadback>;
  private cached?: CachedProjection;
  private inFlight?: Promise<CachedProjection>;
  private refreshStartedAtMs?: number;

  constructor(options: ZesContinuationPreflightProjectorOptions = {}) {
    this.now = options.now ?? Date.now;
    this.cacheTtlMs = positiveBoundedMilliseconds(
      options.cacheTtlMs,
      DEFAULT_PROJECTION_CACHE_TTL_MS,
      "cacheTtlMs",
    );
    this.failureCacheTtlMs = positiveBoundedMilliseconds(
      options.failureCacheTtlMs,
      DEFAULT_PROJECTION_FAILURE_CACHE_TTL_MS,
      "failureCacheTtlMs",
    );
    this.refresh = options.refresh ?? refreshZesContinuationSnapshot;
  }

  async project(
    request: ZesContinuationProjectionRequest = {},
  ): Promise<ZesContinuationPreflightProjection> {
    const nowMs = this.now();
    if (this.cached && nowMs < this.cached.expiresAtMs) {
      return structuredClone(this.cached.value);
    }
    if (request.refresh === false) {
      const reason = request.deferReason
        ?? "automatic_refresh_not_requested";
      const value: ZesContinuationPreflightDeferredProjection = {
        schemaVersion: 1,
        capabilityRef: "zes.continuation.preflight.v2",
        status: "deferred",
        projectionRef:
          `zes-control-plane://continuation/deferred/${sha256({
            reason,
            previousProjectionRef: this.cached?.value.projectionRef,
          })}`,
        route: "execution_scope_status_embedded_control_plane",
        directToolName: "zes_continuation_preflight",
        reason,
        ...(this.cached
          ? { previousProjectionRef: this.cached.value.projectionRef }
          : {}),
        nextAction:
          "invoke_direct_tool_only_for_governed_checkout_runtime_or_effect_intent",
        policy: PROJECTION_POLICY,
      };
      return structuredClone(value);
    }
    void this.warm();
    const refreshStartedAtMs = this.refreshStartedAtMs ?? nowMs;
    const value: ZesContinuationPreflightRefreshingProjection = {
      schemaVersion: 1,
      capabilityRef: "zes.continuation.preflight.v2",
      status: "refreshing",
      projectionRef:
        `zes-control-plane://continuation/refreshing/${sha256({
          refreshStartedAtMs,
          previousProjectionRef: this.cached?.value.projectionRef,
        })}`,
      route: "execution_scope_status_embedded_control_plane",
      directToolName: "zes_continuation_preflight",
      refreshStartedAt: new Date(refreshStartedAtMs).toISOString(),
      retryAfter: new Date(nowMs + 1_000).toISOString(),
      ...(this.cached
        ? { previousProjectionRef: this.cached.value.projectionRef }
        : {}),
      policy: PROJECTION_POLICY,
    };
    return structuredClone(value);
  }

  async warm(): Promise<void> {
    const nowMs = this.now();
    if (this.cached && nowMs < this.cached.expiresAtMs) return;
    if (this.inFlight) {
      await this.inFlight;
      return;
    }

    this.refreshStartedAtMs = nowMs;
    const refresh = this.refreshProjection();
    this.inFlight = refresh;
    try {
      this.cached = await refresh;
    } finally {
      if (this.inFlight === refresh) {
        this.inFlight = undefined;
        this.refreshStartedAtMs = undefined;
      }
    }
  }

  private async refreshProjection(): Promise<CachedProjection> {
    try {
      const snapshot = await this.refresh();
      if (snapshot.schemaVersion !== 1) {
        throw new Error("unsupported_continuation_snapshot_readback_schema");
      }
      const observedAtMs = Date.parse(snapshot.observedAt);
      if (!Number.isFinite(observedAtMs)) {
        throw new Error("invalid_continuation_snapshot_observed_at");
      }
      const completedAtMs = this.now();
      const sourceExpiresAtMs = Date.parse(snapshot.sourceExpiresAt);
      if (!Number.isFinite(sourceExpiresAtMs) || sourceExpiresAtMs <= completedAtMs) {
        throw new Error("invalid_or_expired_continuation_snapshot_source_expiry");
      }
      const freshUntilMs = Math.min(
        completedAtMs + this.cacheTtlMs,
        sourceExpiresAtMs,
      );
      const decisions = continuationDecisions(snapshot.preflight);
      const projectionBasis = {
        capabilityRef: "zes.continuation.preflight.v2",
        observedAt: snapshot.observedAt,
        preflight: snapshot.preflight,
        decisions,
        refresh: snapshot.refresh,
      };
      const value: ZesContinuationPreflightAvailableProjection = {
        schemaVersion: 1,
        capabilityRef: "zes.continuation.preflight.v2",
        status: "available",
        projectionRef:
          `zes-control-plane://continuation/${sha256(projectionBasis)}`,
        route: "execution_scope_status_embedded_control_plane",
        directToolName: "zes_continuation_preflight",
        observedAt: snapshot.observedAt,
        freshUntil: new Date(freshUntilMs).toISOString(),
        sourceExpiresAt: snapshot.sourceExpiresAt,
        preflight: structuredClone(snapshot.preflight),
        ...(snapshot.route === undefined
          ? {}
          : { productRoute: structuredClone(snapshot.route) }),
        decisions,
        refresh: structuredClone(snapshot.refresh),
        policy: PROJECTION_POLICY,
      };
      return { expiresAtMs: freshUntilMs, value };
    } catch (error) {
      const observedAtMs = this.now();
      const retryAtMs = observedAtMs + this.failureCacheTtlMs;
      const diagnostic = error instanceof Error
        ? `${error.name}:${error.message}`
        : String(error);
      const diagnosticDigestSha256 = createHash("sha256")
        .update(diagnostic)
        .digest("hex");
      const value: ZesContinuationPreflightUnavailableProjection = {
        schemaVersion: 1,
        capabilityRef: "zes.continuation.preflight.v2",
        status: "unavailable",
        projectionRef:
          `zes-control-plane://continuation/unavailable/${diagnosticDigestSha256}`,
        route: "execution_scope_status_embedded_control_plane",
        directToolName: "zes_continuation_preflight",
        observedAt: new Date(observedAtMs).toISOString(),
        retryAfter: new Date(retryAtMs).toISOString(),
        error: {
          code: "fixed_continuation_preflight_unavailable",
          diagnosticDigestSha256,
        },
        policy: PROJECTION_POLICY,
      };
      return { expiresAtMs: retryAtMs, value };
    }
  }
}

export async function invokeZesContinuationPreflight(
  intent: ZesContinuationIntent,
) {
  const snapshot = await refreshZesContinuationSnapshot();
  const decision = continuationIntentDecision(intent, snapshot.preflight);
  const data = {
    schemaVersion: 1,
    scope: "fixed-live-zes-continuation-preflight",
    intent,
    decision,
    preflight: snapshot.preflight,
    route: snapshot.route,
    refresh: snapshot.refresh,
    policy: {
      authority:
        "invokes_the_fixed_ZES_product_preflight_and_returns_its_receipt_without_computing_new_authority",
      arbitraryCredentialPathAccepted: false,
      arbitraryRepositoryPathAccepted: false,
      canonicalOrProviderStateMutated: false,
      newWriterPublicationTakeoverOrEffectAuthorityGranted: false,
      snapshotProjectionRefreshed: true,
    },
  };
  const result = JSON.stringify(data, null, 2);
  return {
    content: [{ type: "text" as const, text: result }],
    structuredContent: { result, data },
  };
}

function resultOutputSchema(): z.ZodRawShape {
  return {
    result: z.string(),
    data: z.unknown(),
  };
}

function toolMeta(config: ServerConfig): { _meta: Record<string, unknown> } {
  if (config.widgets === "off") return { _meta: {} };
  return {
    _meta: {
      ui: {
        resourceUri: "ui://devspace/workspace-app.html",
        visibility: ["model"],
      },
    },
  };
}

export function registerZesContinuationPreflightTool(
  server: McpServer,
  config: ServerConfig,
  registerTool: AppToolRegistrar,
): void {
  registerTool(
    server,
    "zes_continuation_preflight",
    {
      title: "Refresh ZES continuation preflight",
      description:
        "Invoke the fixed host-owned live ZES continuation route and return its product-computed action disposition. Use this before governed-main integration, repository publication, runtime takeover, or effect retry. It accepts no repository, credential, thread, DSN, command, or filesystem path. A positive classification revalidates supplied authority but never creates a writer lease, publication authorization, takeover authority, or effect-retry authority.",
      inputSchema: {
        intent: z.enum([
          "inspect",
          "prepare_isolated_candidate",
          "mutate_governed_checkout",
          "publish_repository",
          "runtime_takeover_or_effect_retry",
        ]),
      },
      outputSchema: resultOutputSchema(),
      ...toolMeta(config),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ intent }) => {
      const startedAt = performance.now();
      try {
        const response = await invokeZesContinuationPreflight(intent);
        if (config.logging.toolCalls) {
          logEvent(config.logging, "info", "tool_call", {
            tool: "zes_continuation_preflight",
            success: true,
            durationMs: Math.round(performance.now() - startedAt),
            intent,
          });
        }
        return response;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (config.logging.toolCalls) {
          logEvent(config.logging, "warn", "tool_call", {
            tool: "zes_continuation_preflight",
            success: false,
            durationMs: Math.round(performance.now() - startedAt),
            intent,
            error: message.slice(0, 500),
          });
        }
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `ZES continuation preflight failed: ${message.slice(0, 1000)}`,
            },
          ],
        };
      }
    },
  );
}

