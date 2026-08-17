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

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};

type AppToolRegistrar = typeof registerAppToolType;

export type ZesContinuationIntent =
  | "inspect"
  | "prepare_isolated_candidate"
  | "mutate_governed_checkout"
  | "publish_repository"
  | "runtime_takeover_or_effect_retry";

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
  const repositoryRoot = fixedPath(
    "DEVSPACE_ZES_REPOSITORY_ROOT",
    DEFAULT_ZES_REPOSITORY_ROOT,
  );
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
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    throw new Error("ZES continuation snapshot is stale or has no valid expiry");
  }
  return value;
}

export async function invokeZesContinuationPreflight(
  intent: ZesContinuationIntent,
) {
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
  const decision = continuationIntentDecision(intent, preflight);
  const data = {
    schemaVersion: 1,
    scope: "fixed-live-zes-continuation-preflight",
    intent,
    decision,
    preflight,
    route: control?.route,
    refresh: {
      status: receipt.status,
      receiptDigestSha256: receipt.receipt_digest_sha256,
      snapshotSha256: receipt.snapshot_sha256,
      sourceControlPreflight: receipt.source_control_preflight,
    },
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

