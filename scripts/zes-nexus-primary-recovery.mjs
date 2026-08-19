#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SERVICE_NAME = "devspace-zesnexus.service";
const DEFAULT_READY_URL = "http://127.0.0.1:7677/readyz";
const DEFAULT_HOST_HEADER = "mcp.zesnexus.com";
const DEFAULT_STATE_ROOT = "/run/devspace-zesnexus-primary-recovery";
const DEFAULT_RECEIPT_ROOT =
  "/var/lib/devspace-zesnexus/incident-snapshots/primary-recovery";
const RECOVERY_STATE_SCHEMA = "zes.nexus-primary-recovery-state.v1";
const RECOVERY_RECEIPT_SCHEMA = "zes.nexus-primary-recovery-receipt.v1";
const RECOVERY_PLAN_SCHEMA = "zes.nexus-primary-recovery-plan.v1";

function integer(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    return fallback;
  }
  return parsed;
}

function absolutePath(value, fallback) {
  const selected = value?.trim() || fallback;
  if (!isAbsolute(selected)) {
    throw new Error(`Recovery path must be absolute: ${selected}`);
  }
  return resolve(selected);
}

function readyUrl(value) {
  const url = new URL(value?.trim() || DEFAULT_READY_URL);
  if (url.protocol !== "http:") {
    throw new Error("Primary readiness URL must use loopback HTTP.");
  }
  if (!["127.0.0.1", "::1", "localhost"].includes(url.hostname)) {
    throw new Error("Primary readiness URL must target loopback.");
  }
  if (url.pathname !== "/readyz") {
    throw new Error("Primary readiness URL must target the fixed /readyz route.");
  }
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return url;
}

function safeHostHeader(value) {
  const selected = value?.trim() || DEFAULT_HOST_HEADER;
  if (!/^[A-Za-z0-9.-]{1,253}$/.test(selected)) {
    throw new Error("Primary readiness Host header is invalid.");
  }
  return selected;
}

export function loadRecoveryPolicy(environment = process.env) {
  const stateRoot = absolutePath(
    environment.ZES_NEXUS_PRIMARY_RECOVERY_STATE_ROOT,
    DEFAULT_STATE_ROOT,
  );
  const stableProbeCount = integer(
    environment.ZES_NEXUS_PRIMARY_RECOVERY_STABLE_PROBE_COUNT,
    3,
    1,
    10,
  );
  const configuredStableProbeMaximum = integer(
    environment.ZES_NEXUS_PRIMARY_RECOVERY_STABLE_PROBE_MAXIMUM,
    6,
    1,
    20,
  );
  return {
    schemaVersion: "zes.nexus-primary-recovery-policy.v1",
    serviceName: SERVICE_NAME,
    readyUrl: readyUrl(environment.ZES_NEXUS_PRIMARY_READY_URL),
    hostHeader: safeHostHeader(
      environment.ZES_NEXUS_PRIMARY_HOST_HEADER,
    ),
    stateRoot,
    statePath: join(stateRoot, "state.json"),
    leasePath: join(stateRoot, "owner.lock"),
    receiptRoot: absolutePath(
      environment.ZES_NEXUS_PRIMARY_RECOVERY_RECEIPT_ROOT,
      DEFAULT_RECEIPT_ROOT,
    ),
    effectsEnabled:
      environment.ZES_NEXUS_PRIMARY_RECOVERY_EFFECTS === "1",
    failureThreshold: integer(
      environment.ZES_NEXUS_PRIMARY_RECOVERY_FAILURE_THRESHOLD,
      3,
      1,
      20,
    ),
    maxRepairAttempts: integer(
      environment.ZES_NEXUS_PRIMARY_RECOVERY_MAX_REPAIR_ATTEMPTS,
      1,
      0,
      5,
    ),
    probeTimeoutMs: integer(
      environment.ZES_NEXUS_PRIMARY_RECOVERY_PROBE_TIMEOUT_MS,
      5_000,
      250,
      30_000,
    ),
    stableProbeCount,
    stableProbeMaximum: Math.max(
      stableProbeCount,
      configuredStableProbeMaximum,
    ),
    stableProbeDelayMs: integer(
      environment.ZES_NEXUS_PRIMARY_RECOVERY_STABLE_PROBE_DELAY_MS,
      2_000,
      100,
      30_000,
    ),
    leaseStaleAfterMs: integer(
      environment.ZES_NEXUS_PRIMARY_RECOVERY_LEASE_STALE_AFTER_MS,
      5 * 60_000,
      30_000,
      60 * 60_000,
    ),
  };
}

function safeStrings(value, limit = 50) {
  return Array.isArray(value)
    ? value
        .filter((entry) => typeof entry === "string")
        .slice(0, limit)
        .map((entry) => entry.slice(0, 256))
    : [];
}

function safeDigest(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value)
    ? value
    : undefined;
}

function safeCount(value) {
  return Number.isInteger(value) && value >= 0 ? value : undefined;
}

export function normalizeReadinessProbe({
  httpStatus,
  body,
  errorCode,
  errorMessage,
}) {
  const record = body && typeof body === "object" && !Array.isArray(body)
    ? body
    : {};
  const database = record.database
    && typeof record.database === "object"
    && !Array.isArray(record.database)
    ? record.database
    : {};
  const activity = record.activity
    && typeof record.activity === "object"
    && !Array.isArray(record.activity)
    ? record.activity
    : {};
  const restartSafety = record.restartSafety
    && typeof record.restartSafety === "object"
    && !Array.isArray(record.restartSafety)
    ? record.restartSafety
    : {};
  const errorDigestSha256 = errorMessage
    ? createHash("sha256").update(String(errorMessage), "utf8").digest("hex")
    : undefined;
  const healthy = httpStatus === 200
    && record.ok === true
    && record.state === "READY";
  const normalizedActivity = {
    activeToolCount: safeCount(activity.activeToolCount) ?? 0,
    runningProcessCount: safeCount(activity.runningProcessCount) ?? 0,
    serviceChildProcessObservationState:
      activity.serviceChildProcessObservationState === "observed"
        ? "observed"
        : "unavailable",
    activeServiceChildProcessCount:
      safeCount(activity.activeServiceChildProcessCount) ?? 0,
  };
  const restartReasonCodes = safeStrings(restartSafety.reasonCodes);
  if (
    normalizedActivity.activeToolCount > 0
    && !restartReasonCodes.includes("active_mcp_tools")
  ) {
    restartReasonCodes.push("active_mcp_tools");
  }
  if (
    normalizedActivity.runningProcessCount > 0
    && !restartReasonCodes.includes("running_workspace_processes")
  ) {
    restartReasonCodes.push("running_workspace_processes");
  }
  if (
    normalizedActivity.serviceChildProcessObservationState !== "observed"
    && !restartReasonCodes.includes("service_child_process_state_unobserved")
  ) {
    restartReasonCodes.push("service_child_process_state_unobserved");
  }
  if (
    normalizedActivity.activeServiceChildProcessCount > 0
    && !restartReasonCodes.includes("active_service_child_processes")
  ) {
    restartReasonCodes.push("active_service_child_processes");
  }
  const activeRecoveryWork = normalizedActivity.activeToolCount > 0
    || normalizedActivity.runningProcessCount > 0
    || normalizedActivity.activeServiceChildProcessCount > 0;
  const restartSafetyState = activeRecoveryWork
    ? "defer"
    : normalizedActivity.serviceChildProcessObservationState !== "observed"
      ? "unknown"
      : restartSafety.state === "safe"
        ? "safe"
        : restartSafety.state === "defer"
          ? "defer"
          : "unknown";
  return {
    schemaVersion: "zes.nexus-primary-functional-probe.v1",
    healthy,
    state: healthy
      ? "ready"
      : httpStatus === undefined
        ? "unreachable"
        : "not_ready",
    ...(httpStatus === undefined ? {} : { httpStatus }),
    ...(typeof record.backendInstanceRef === "string"
      ? { backendInstanceRef: record.backendInstanceRef.slice(0, 128) }
      : {}),
    ...(typeof record.surfaceEpoch === "string"
      ? { surfaceEpoch: record.surfaceEpoch.slice(0, 256) }
      : {}),
    reasonCodes: safeStrings(record.reasonCodes),
    database: {
      state: database.state === "ready" ? "ready" : "failed",
      ...(safeCount(database.latestMigrationVersion) === undefined
        ? {}
        : { latestMigrationVersion: database.latestMigrationVersion }),
      ...(safeDigest(database.errorDigestSha256)
        ? { errorDigestSha256: database.errorDigestSha256 }
        : {}),
      ...(typeof database.errorKind === "string"
        ? { errorKind: database.errorKind.slice(0, 128) }
        : {}),
    },
    activity: normalizedActivity,
    restartSafety: {
      state: restartSafetyState,
      reasonCodes: [...new Set(restartReasonCodes)].sort(),
    },
    ...(typeof errorCode === "string"
      ? { errorCode: errorCode.slice(0, 64) }
      : {}),
    ...(errorDigestSha256 ? { errorDigestSha256 } : {}),
    policy: {
      rawBodyExcluded: true,
      rawErrorExcluded: true,
      readinessIsNotLiveness: true,
      restartSafetyRecomputedFromNormalizedActivity: true,
    },
  };
}

function defaultState() {
  return {
    schemaVersion: RECOVERY_STATE_SCHEMA,
    consecutiveFailures: 0,
    repairAttempts: 0,
  };
}

export function planPrimaryRecovery({ probe, serviceState, state, policy }) {
  const current = {
    ...defaultState(),
    ...(state && typeof state === "object" ? state : {}),
  };
  const previousFailures = integer(
    current.consecutiveFailures,
    0,
    0,
    1_000_000,
  );
  const previousRepairAttempts = integer(
    current.repairAttempts,
    0,
    0,
    1_000_000,
  );
  if (probe.healthy) {
    return {
      schemaVersion: RECOVERY_PLAN_SCHEMA,
      state: "HEALTHY",
      action: "clear_incident_state",
      consecutiveFailures: 0,
      repairAttempts: 0,
      effectAllowed: false,
      diagnosticAgentRequired: false,
      reasonCodes: ["primary_functional_readiness_verified"],
    };
  }

  const consecutiveFailures = Math.min(previousFailures + 1, 1_000_000);
  if (consecutiveFailures < policy.failureThreshold) {
    return {
      schemaVersion: RECOVERY_PLAN_SCHEMA,
      state: "OBSERVE_DEGRADED",
      action: "probe_again_within_bounded_threshold",
      consecutiveFailures,
      repairAttempts: previousRepairAttempts,
      effectAllowed: false,
      diagnosticAgentRequired: false,
      reasonCodes: ["primary_readiness_failure_below_threshold"],
    };
  }

  if (probe.restartSafety.state === "defer") {
    return {
      schemaVersion: RECOVERY_PLAN_SCHEMA,
      state: "DEFER_ACTIVE_WORK",
      action: "preserve_active_tools_and_processes_then_probe_again",
      consecutiveFailures,
      repairAttempts: previousRepairAttempts,
      effectAllowed: false,
      diagnosticAgentRequired: false,
      reasonCodes: [
        "restart_safety_deferred",
        ...probe.restartSafety.reasonCodes,
      ],
    };
  }

  if (previousRepairAttempts >= policy.maxRepairAttempts) {
    return {
      schemaVersion: RECOVERY_PLAN_SCHEMA,
      state: "DIAGNOSTIC_REQUIRED",
      action: "dispatch_single_bounded_diagnostic_recovery_owner",
      consecutiveFailures,
      repairAttempts: previousRepairAttempts,
      effectAllowed: false,
      diagnosticAgentRequired: true,
      reasonCodes: ["automatic_repair_budget_exhausted"],
    };
  }

  const serviceStopped = ["inactive", "failed"].includes(serviceState);
  const restartSafe = probe.restartSafety.state === "safe" || serviceStopped;
  if (!restartSafe) {
    return {
      schemaVersion: RECOVERY_PLAN_SCHEMA,
      state: "DIAGNOSTIC_REQUIRED",
      action: "dispatch_single_bounded_diagnostic_recovery_owner",
      consecutiveFailures,
      repairAttempts: previousRepairAttempts,
      effectAllowed: false,
      diagnosticAgentRequired: true,
      reasonCodes: ["restart_safety_unverified"],
    };
  }

  if (!policy.effectsEnabled) {
    return {
      schemaVersion: RECOVERY_PLAN_SCHEMA,
      state: "EFFECTS_DISABLED",
      action: "retain_incident_and_request_authorized_repair_activation",
      consecutiveFailures,
      repairAttempts: previousRepairAttempts,
      effectAllowed: false,
      diagnosticAgentRequired: false,
      reasonCodes: ["primary_recovery_effects_disabled"],
    };
  }

  return {
    schemaVersion: RECOVERY_PLAN_SCHEMA,
    state: "RESTART_PRIMARY",
    action: "restart_fixed_primary_service_then_verify_stable_readiness",
    consecutiveFailures,
    repairAttempts: previousRepairAttempts + 1,
    effectAllowed: true,
    diagnosticAgentRequired: false,
    reasonCodes: serviceStopped
      ? ["primary_service_not_running", "restart_safety_verified"]
      : ["primary_functional_readiness_failed", "restart_safety_verified"],
  };
}

export function shouldPersistRecoveryTransition(previous, plan) {
  return previous?.lastPlanState !== plan.state;
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

async function atomicWriteJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(temporary, path);
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

async function acquireLease(policy) {
  await mkdir(policy.stateRoot, { recursive: true, mode: 0o700 });
  const attempt = async () => {
    const handle = await open(policy.leasePath, "wx", 0o600);
    const lease = {
      schemaVersion: "zes.nexus-primary-recovery-lease.v1",
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
    };
    await handle.writeFile(`${JSON.stringify(lease)}\n`);
    return {
      lease,
      release: async () => {
        await handle.close().catch(() => undefined);
        await unlink(policy.leasePath).catch(() => undefined);
      },
    };
  };
  try {
    return await attempt();
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }

  const existing = await readJson(policy.leasePath, {});
  const acquiredAtMs = Date.parse(existing.acquiredAt ?? "");
  const stale = Number.isFinite(acquiredAtMs)
    && Date.now() - acquiredAtMs >= policy.leaseStaleAfterMs
    && !processAlive(existing.pid);
  if (stale) {
    await unlink(policy.leasePath).catch(() => undefined);
    try {
      return await attempt();
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
  return undefined;
}

async function probePrimary(policy) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), policy.probeTimeoutMs);
  try {
    const response = await fetch(policy.readyUrl, {
      method: "GET",
      headers: {
        Host: policy.hostHeader,
        Accept: "application/json",
      },
      signal: controller.signal,
      cache: "no-store",
    });
    let body;
    try {
      body = await response.json();
    } catch (error) {
      return normalizeReadinessProbe({
        httpStatus: response.status,
        errorCode: "INVALID_READINESS_JSON",
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
    return normalizeReadinessProbe({
      httpStatus: response.status,
      body,
    });
  } catch (error) {
    return normalizeReadinessProbe({
      errorCode:
        typeof error?.code === "string"
          ? error.code
          : error?.name === "AbortError"
            ? "PROBE_TIMEOUT"
            : "PROBE_FAILED",
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  } finally {
    clearTimeout(timer);
  }
}

async function serviceState() {
  try {
    const result = await execFileAsync(
      "/usr/bin/systemctl",
      ["is-active", SERVICE_NAME],
      { timeout: 5_000, maxBuffer: 16_384 },
    );
    return result.stdout.trim() || "unknown";
  } catch (error) {
    const stdout = typeof error?.stdout === "string" ? error.stdout.trim() : "";
    return stdout || "unknown";
  }
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function verifyStablePrimary(policy, previousInstanceRef) {
  const probes = [];
  let consecutive = 0;
  for (let index = 0; index < policy.stableProbeMaximum; index += 1) {
    await delay(policy.stableProbeDelayMs);
    const probe = await probePrimary(policy);
    probes.push(probe);
    const instanceChanged = previousInstanceRef === undefined
      || (probe.backendInstanceRef !== undefined
        && probe.backendInstanceRef !== previousInstanceRef);
    if (probe.healthy && instanceChanged) consecutive += 1;
    else consecutive = 0;
    if (consecutive >= policy.stableProbeCount) {
      return { verified: true, probes };
    }
  }
  return { verified: false, probes };
}

function incidentState(previous, plan, probe, observedServiceState, incidentId) {
  return {
    schemaVersion: RECOVERY_STATE_SCHEMA,
    incidentId,
    consecutiveFailures: plan.consecutiveFailures,
    repairAttempts: plan.repairAttempts,
    lastPlanState: plan.state,
    lastProbe: probe,
    serviceState: observedServiceState,
    firstFailureAt:
      previous.firstFailureAt ?? new Date().toISOString(),
    lastObservedAt: new Date().toISOString(),
  };
}

async function writeReceipt(policy, incidentId, receipt) {
  const directory = join(policy.receiptRoot, incidentId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${receipt.attemptRef}.json`);
  await atomicWriteJson(path, receipt);
  return path;
}

async function main() {
  const policy = loadRecoveryPolicy();
  const owner = await acquireLease(policy);
  if (!owner) {
    console.log(JSON.stringify({
      schemaVersion: RECOVERY_PLAN_SCHEMA,
      state: "RECOVERY_OWNER_HELD",
      action: "observe_existing_recovery_owner",
      effectAllowed: false,
      diagnosticAgentRequired: false,
      reasonCodes: ["single_recovery_owner_already_active"],
    }));
    return;
  }

  try {
    const previous = await readJson(policy.statePath, defaultState());
    const [probe, observedServiceState] = await Promise.all([
      probePrimary(policy),
      serviceState(),
    ]);
    const plan = planPrimaryRecovery({
      probe,
      serviceState: observedServiceState,
      state: previous,
      policy,
    });

    if (plan.state === "HEALTHY") {
      await rm(policy.statePath, { force: true });
      console.log(JSON.stringify({ ...plan, probe }));
      return;
    }

    const incidentId = previous.incidentId
      ?? `nexus-primary-${new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`;
    const nextState = incidentState(
      previous,
      plan,
      probe,
      observedServiceState,
      incidentId,
    );

    if (plan.state !== "RESTART_PRIMARY") {
      if (!shouldPersistRecoveryTransition(previous, plan)) {
        const repeatedState = {
          ...nextState,
          ...(typeof previous.lastReceiptPath === "string"
            ? { lastReceiptPath: previous.lastReceiptPath }
            : {}),
        };
        await atomicWriteJson(policy.statePath, repeatedState);
        console.log(JSON.stringify({
          ...plan,
          incidentId,
          ...(repeatedState.lastReceiptPath
            ? { receiptPath: repeatedState.lastReceiptPath }
            : {}),
          receiptSuppressed: true,
          reasonCodes: [
            ...plan.reasonCodes,
            "unchanged_recovery_state_receipt_suppressed",
          ],
        }));
        return;
      }
      const attemptRef = `observation-${Date.now()}`;
      const receipt = {
        schemaVersion: RECOVERY_RECEIPT_SCHEMA,
        incidentId,
        attemptRef,
        observedAt: new Date().toISOString(),
        plan,
        probe,
        serviceState: observedServiceState,
        effect: { state: "none" },
        diagnosticRequest: plan.diagnosticAgentRequired
          ? {
              state: "pending",
              claimCeiling:
                "diagnose_and_propose_or_execute_only_repair_classes_admitted_by_current_recovery_policy",
              evidenceRefs: [
                `incident:${incidentId}`,
                `probe-error-sha256:${probe.errorDigestSha256 ?? "none"}`,
                `database-error-sha256:${probe.database.errorDigestSha256 ?? "none"}`,
              ],
            }
          : undefined,
        policy: {
          primaryRepairBeforeFallback: true,
          fallbackEffectPerformed: false,
          rawErrorsCaptured: false,
          legacyMutated: false,
        },
      };
      const receiptPath = await writeReceipt(
        policy,
        incidentId,
        receipt,
      );
      await atomicWriteJson(policy.statePath, {
        ...nextState,
        lastReceiptPath: receiptPath,
      });
      console.log(JSON.stringify({ ...plan, incidentId, receiptPath }));
      return;
    }

    const attemptRef = `restart-${plan.repairAttempts}-${Date.now()}`;
    const beforeEffectReceipt = {
      schemaVersion: RECOVERY_RECEIPT_SCHEMA,
      incidentId,
      attemptRef,
      observedAt: new Date().toISOString(),
      plan,
      probe,
      serviceState: observedServiceState,
      effect: {
        state: "prepared",
        serviceName: SERVICE_NAME,
        operation: "restart",
      },
      policy: {
        primaryRepairBeforeFallback: true,
        fallbackEffectPerformed: false,
        rawErrorsCaptured: false,
        legacyMutated: false,
      },
    };
    const receiptPath = await writeReceipt(
      policy,
      incidentId,
      beforeEffectReceipt,
    );
    await atomicWriteJson(policy.statePath, {
      ...nextState,
      lastReceiptPath: receiptPath,
    });
    let restartError;
    try {
      await execFileAsync(
        "/usr/bin/systemctl",
        ["restart", SERVICE_NAME],
        { timeout: 60_000, maxBuffer: 64 * 1_024 },
      );
    } catch (error) {
      restartError = error;
    }
    const verification = restartError
      ? { verified: false, probes: [] }
      : await verifyStablePrimary(policy, probe.backendInstanceRef);
    const terminalReceipt = {
      ...beforeEffectReceipt,
      completedAt: new Date().toISOString(),
      effect: restartError
        ? {
            state: "failed",
            serviceName: SERVICE_NAME,
            operation: "restart",
            errorDigestSha256: createHash("sha256")
              .update(
                restartError instanceof Error
                  ? restartError.message
                  : String(restartError),
                "utf8",
              )
              .digest("hex"),
          }
        : verification.verified
          ? {
              state: "terminal_succeeded",
              serviceName: SERVICE_NAME,
              operation: "restart",
            }
          : {
              state: "postcondition_failed",
              serviceName: SERVICE_NAME,
              operation: "restart",
            },
      verification: {
        stableProbeCountRequired: policy.stableProbeCount,
        stable: verification.verified,
        probes: verification.probes,
      },
    };
    await atomicWriteJson(receiptPath, terminalReceipt);

    if (verification.verified && !restartError) {
      await rm(policy.statePath, { force: true });
      console.log(JSON.stringify({
        schemaVersion: RECOVERY_PLAN_SCHEMA,
        state: "PRIMARY_RECOVERED",
        action: "fail_back_to_verified_primary",
        effectAllowed: false,
        diagnosticAgentRequired: false,
        incidentId,
        receiptPath,
        reasonCodes: ["stable_post_restart_readiness_verified"],
      }));
      return;
    }

    await atomicWriteJson(policy.statePath, {
      ...nextState,
      lastPlanState: "DIAGNOSTIC_REQUIRED",
      lastObservedAt: new Date().toISOString(),
      terminalReceiptPath: receiptPath,
    });
    console.log(JSON.stringify({
      schemaVersion: RECOVERY_PLAN_SCHEMA,
      state: "DIAGNOSTIC_REQUIRED",
      action: "dispatch_single_bounded_diagnostic_recovery_owner",
      effectAllowed: false,
      diagnosticAgentRequired: true,
      incidentId,
      receiptPath,
      reasonCodes: restartError
        ? ["primary_restart_failed"]
        : ["primary_restart_postcondition_failed"],
    }));
  } finally {
    await owner.release();
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(JSON.stringify({
      schemaVersion: RECOVERY_PLAN_SCHEMA,
      state: "CONTROLLER_FAILED",
      action: "preserve_primary_and_request_operator_diagnosis",
      effectAllowed: false,
      diagnosticAgentRequired: true,
      errorDigestSha256: createHash("sha256")
        .update(error instanceof Error ? error.message : String(error), "utf8")
        .digest("hex"),
      reasonCodes: ["recovery_controller_internal_failure"],
    }));
    process.exitCode = 1;
  });
}
