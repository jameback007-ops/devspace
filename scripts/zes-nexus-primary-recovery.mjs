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
const DEFAULT_LEASE_ROOT = "/run/devspace-zesnexus-primary-recovery";
const DEFAULT_RECEIPT_ROOT =
  "/var/lib/devspace-zesnexus/incident-snapshots/primary-recovery";
const DEFAULT_CONFLICTING_RESTART_UNITS = [
  "devspace-zesnexus-health.timer",
];
const LEGACY_RECOVERY_REQUIRED_TOOLS = [
  "open_workspace",
  "read",
  "apply_patch",
  "exec_command",
  "write_stdin",
];
const RECOVERY_STATE_SCHEMA = "zes.nexus-primary-recovery-state.v1";
const RECOVERY_RECEIPT_SCHEMA = "zes.nexus-primary-recovery-receipt.v1";
const RECOVERY_PLAN_SCHEMA = "zes.nexus-primary-recovery-plan.v1";
const HOST_OBSERVATION_VALUES = new Set([
  "unobserved",
  "connector_disabled",
  "catalog_stale",
  "authentication_required",
]);

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

function systemdUnitNames(value) {
  const selected = value?.trim()
    ? value.split(/[\s,]+/)
    : DEFAULT_CONFLICTING_RESTART_UNITS;
  const units = [...new Set(selected.filter(Boolean))];
  for (const unit of units) {
    if (!/^[A-Za-z0-9_.@:-]{1,256}\.(?:service|timer)$/.test(unit)) {
      throw new Error(`Conflicting recovery unit name is invalid: ${unit}`);
    }
    if (unit === SERVICE_NAME) {
      throw new Error(
        "The primary service cannot be its own conflicting recovery owner.",
      );
    }
  }
  return units;
}

export function loadRecoveryPolicy(environment = process.env) {
  const stateRoot = absolutePath(
    environment.ZES_NEXUS_PRIMARY_RECOVERY_STATE_ROOT,
    DEFAULT_STATE_ROOT,
  );
  const leaseRoot = absolutePath(
    environment.ZES_NEXUS_PRIMARY_RECOVERY_LEASE_ROOT,
    DEFAULT_LEASE_ROOT,
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
    leaseRoot,
    leasePath: join(leaseRoot, "owner.lock"),
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
    conflictingRestartUnits: systemdUnitNames(
      environment.ZES_NEXUS_PRIMARY_RECOVERY_CONFLICTING_RESTART_UNITS,
    ),
  };
}

export function normalizeHostObservation(value) {
  const selected = value?.trim() || "unobserved";
  if (!HOST_OBSERVATION_VALUES.has(selected)) {
    throw new Error(
      `Unsupported Nexus host observation: ${selected}`,
    );
  }
  return selected;
}

export function applyHostObservationToRecoveryPlan({
  plan,
  probe,
  hostObservation = "unobserved",
}) {
  const observation = normalizeHostObservation(hostObservation);
  if (observation === "unobserved" || plan.state !== "HEALTHY") {
    return plan;
  }
  if (!isPrimaryRecoveryControlHealthy(probe)) {
    return plan;
  }

  const reasonCode = observation === "connector_disabled"
    ? "host_connector_disabled_while_primary_healthy"
    : observation === "catalog_stale"
      ? "host_catalog_stale_while_primary_healthy"
      : "host_authentication_required_while_primary_healthy";
  return {
    ...plan,
    state: "HOST_CONNECTOR_RECOVERY_REQUIRED",
    action: observation === "authentication_required"
      ? "reauthenticate_or_reconnect_host_connector"
      : "refresh_or_reconnect_host_connector",
    effectAllowed: false,
    diagnosticAgentRequired: false,
    primaryRepairRequired: false,
    primaryRestartAllowed: false,
    hostObservation: observation,
    recoveryPlane: "host_connector",
    missionFallbackAuthorized: false,
    exactNextAction:
      "Keep the healthy Nexus service running. Refresh, reconnect, or reauthenticate the host connector as indicated by the host; then call the stable Nexus bootstrap and attest the refreshed client catalog before normal mission work resumes.",
    reasonCodes: [...new Set([
      ...(Array.isArray(plan.reasonCodes) ? plan.reasonCodes : []),
      "primary_functional_and_exact_surface_verified",
      reasonCode,
      "server_restart_would_target_the_wrong_failure_plane",
    ])],
    policy: {
      ...(plan.policy && typeof plan.policy === "object" ? plan.policy : {}),
      hostObservationIsCallerEvidenceOnly: true,
      hostObservationDoesNotAuthorizeServerRepair: true,
      healthyPrimaryMustNotRestartForHostConnectorFailure: true,
      hostConnectorActuatorOwnedByController: false,
      fallbackMissionAuthorityGranted: false,
    },
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
    ...(safeDigest(record.toolSurfaceFingerprintSha256)
      ? {
          toolSurfaceFingerprintSha256:
            record.toolSurfaceFingerprintSha256,
        }
      : {}),
    serverSurfaceCurrent:
      record.serverSurfaceCurrent === true
        ? true
        : record.serverSurfaceCurrent === false
          ? false
          : null,
    ...(typeof record.toolSurfaceFreshnessStatus === "string"
      ? {
          toolSurfaceFreshnessStatus:
            record.toolSurfaceFreshnessStatus.slice(0, 128),
        }
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

function hostMediatedRecoveryEscalation(reasonCodes = []) {
  return {
    schemaVersion: "devspace.host-mediated-primary-recovery.v1",
    state: "required",
    dispatchState: "external_host_action_required",
    routeClass: "recovery_only",
    routeKind: "legacy_or_independent_continuity",
    operationClass: "inspect_repair_verify_primary",
    requiredTools: [...LEGACY_RECOVERY_REQUIRED_TOOLS],
    requiredCapabilities: [
      "continuity.primary.inspect",
      "continuity.primary.repair",
      "continuity.primary.verify",
    ],
    nexusBootstrapToolRequired: false,
    hostMediatedDispatchRequired: true,
    primaryCanInvokeSiblingConnector: false,
    selectionRequired: true,
    routeSelectionAuthorizesRepairEffect: false,
    recoveryEffectRequiresSeparateAuthorityAndEffectGate: true,
    callerEvidenceVerifiedByController: false,
    executableRepairOwnerClass:
      "host_or_executor_bound_to_independently_attested_recovery_route",
    missionAuthorityGranted: false,
    effectReplayAuthorized: false,
    qualityReductionAuthorized: false,
    failbackPostconditions: [
      "primary_readyz_ready",
      "primary_exact_tool_surface_verified",
      "primary_required_capabilities_verified",
      "host_catalog_refreshed_or_currently_attested_when_host_supports_it",
      "primary_route_reselected_before_mission_work",
    ],
    externalBoundary:
      "This controller cannot invoke a sibling MCP connector owned by the host. A host or executor must dispatch the independently attested recovery-only route and return bounded repair evidence.",
    remainingExternalLimitations: [
      "sibling_host_connector_invocation_unavailable_to_controller",
      "host_catalog_refresh_actuator_not_owned_by_controller",
      "independent_route_evidence_requires_host_or_executor_verification",
    ],
    reasonCodes: safeStrings(reasonCodes),
  };
}

export function planPrimaryRecovery({
  probe,
  serviceState,
  state,
  policy,
  competingRestartOwners = [],
}) {
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
  const controlFailureReasonCodes = primaryRecoveryControlFailureReasonCodes(
    probe,
  );
  if (controlFailureReasonCodes.length === 0) {
    return {
      schemaVersion: RECOVERY_PLAN_SCHEMA,
      state: "HEALTHY",
      action: "clear_incident_state",
      consecutiveFailures: 0,
      repairAttempts: 0,
      effectAllowed: false,
      diagnosticAgentRequired: false,
      reasonCodes: [
        "primary_functional_readiness_verified",
        "primary_exact_surface_identity_verified",
        "primary_server_surface_current",
      ],
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
      reasonCodes: [
        "primary_readiness_failure_below_threshold",
        ...controlFailureReasonCodes,
      ],
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
        ...controlFailureReasonCodes,
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
      reasonCodes: [
        "automatic_repair_budget_exhausted",
        ...controlFailureReasonCodes,
      ],
      recoveryEscalation: hostMediatedRecoveryEscalation([
        "automatic_repair_budget_exhausted",
        ...controlFailureReasonCodes,
      ]),
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
      reasonCodes: [
        "restart_safety_unverified",
        ...controlFailureReasonCodes,
      ],
      recoveryEscalation: hostMediatedRecoveryEscalation([
        "restart_safety_unverified",
        ...controlFailureReasonCodes,
      ]),
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
      reasonCodes: [
        "primary_recovery_effects_disabled",
        ...controlFailureReasonCodes,
      ],
    };
  }

  if (competingRestartOwners.length > 0) {
    return {
      schemaVersion: RECOVERY_PLAN_SCHEMA,
      state: "COMPETING_RECOVERY_OWNER",
      action:
        "disable_or_supersede_competing_restart_owner_then_reassess_before_effects",
      consecutiveFailures,
      repairAttempts: previousRepairAttempts,
      effectAllowed: false,
      diagnosticAgentRequired: false,
      competingRestartOwners: safeStrings(competingRestartOwners),
      reasonCodes: [
        "competing_recovery_owner_active",
        ...controlFailureReasonCodes,
        ...safeStrings(competingRestartOwners).map(
          (unit) => `competing_unit:${unit}`,
        ),
      ],
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
      ? [
          "primary_service_not_running",
          ...controlFailureReasonCodes,
          "restart_safety_verified",
        ]
      : [
          ...controlFailureReasonCodes,
          "restart_safety_verified",
        ],
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
  await mkdir(policy.leaseRoot, { recursive: true, mode: 0o700 });
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

async function activeSystemdUnits(units) {
  const active = [];
  for (const unit of units) {
    try {
      const result = await execFileAsync(
        "/usr/bin/systemctl",
        ["is-active", unit],
        { timeout: 5_000, maxBuffer: 16_384 },
      );
      if (result.stdout.trim() === "active") active.push(unit);
    } catch (error) {
      const stdout = typeof error?.stdout === "string"
        ? error.stdout.trim()
        : "";
      if (stdout === "active") active.push(unit);
    }
  }
  return active;
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function verifyStablePrimary(policy, previousInstanceRef) {
  const probes = [];
  for (let index = 0; index < policy.stableProbeMaximum; index += 1) {
    await delay(policy.stableProbeDelayMs);
    const probe = await probePrimary(policy);
    probes.push(probe);
    const assessment = evaluateStablePrimaryProbes(
      probes,
      previousInstanceRef,
      policy.stableProbeCount,
    );
    if (assessment.verified) {
      return { ...assessment, probes };
    }
  }
  return {
    ...evaluateStablePrimaryProbes(
      probes,
      previousInstanceRef,
      policy.stableProbeCount,
    ),
    probes,
  };
}

function stablePrimaryIdentity(probe, previousInstanceRef) {
  if (!probe?.healthy) return undefined;
  if (
    typeof probe.backendInstanceRef !== "string"
    || probe.backendInstanceRef.length === 0
    || probe.backendInstanceRef === previousInstanceRef
  ) return undefined;
  if (
    typeof probe.surfaceEpoch !== "string"
    || probe.surfaceEpoch.length === 0
    || !safeDigest(probe.toolSurfaceFingerprintSha256)
    || probe.serverSurfaceCurrent !== true
  ) return undefined;
  return {
    backendInstanceRef: probe.backendInstanceRef,
    surfaceEpoch: probe.surfaceEpoch,
    toolSurfaceFingerprintSha256: probe.toolSurfaceFingerprintSha256,
  };
}

function primaryRecoveryControlFailureReasonCodes(probe) {
  if (!probe?.healthy) return ["primary_functional_readiness_failed"];
  const reasons = [];
  if (
    typeof probe.backendInstanceRef !== "string"
    || probe.backendInstanceRef.length === 0
  ) reasons.push("primary_backend_instance_unattested");
  if (
    typeof probe.surfaceEpoch !== "string"
    || probe.surfaceEpoch.length === 0
  ) reasons.push("primary_surface_epoch_unattested");
  if (!safeDigest(probe.toolSurfaceFingerprintSha256)) {
    reasons.push("primary_tool_surface_fingerprint_unattested");
  }
  if (probe.serverSurfaceCurrent !== true) {
    reasons.push(
      probe.serverSurfaceCurrent === false
        ? "primary_server_surface_stale"
        : "primary_server_surface_currentness_unattested",
    );
  }
  return safeStrings(reasons);
}

export function isPrimaryRecoveryControlHealthy(probe) {
  return primaryRecoveryControlFailureReasonCodes(probe).length === 0;
}

export function evaluateStablePrimaryProbes(
  probes,
  previousInstanceRef,
  requiredConsecutive,
) {
  const required = integer(requiredConsecutive, 1, 1, 20);
  let consecutive = 0;
  let currentIdentity;
  for (const probe of probes ?? []) {
    const identity = stablePrimaryIdentity(probe, previousInstanceRef);
    const identityKey = identity
      ? `${identity.backendInstanceRef}\u0000${identity.surfaceEpoch}\u0000${identity.toolSurfaceFingerprintSha256}`
      : undefined;
    const currentKey = currentIdentity
      ? `${currentIdentity.backendInstanceRef}\u0000${currentIdentity.surfaceEpoch}\u0000${currentIdentity.toolSurfaceFingerprintSha256}`
      : undefined;
    if (!identity) {
      consecutive = 0;
      currentIdentity = undefined;
      continue;
    }
    if (identityKey === currentKey) consecutive += 1;
    else {
      currentIdentity = identity;
      consecutive = 1;
    }
    if (consecutive >= required) {
      return {
        verified: true,
        consecutiveStableProbeCount: consecutive,
        verifiedIdentity: currentIdentity,
      };
    }
  }
  return {
    verified: false,
    consecutiveStableProbeCount: consecutive,
    ...(currentIdentity ? { lastCandidateIdentity: currentIdentity } : {}),
  };
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

export function primaryRecoveredResult({
  incidentId,
  receiptPath,
  recoveryOwnerObservation,
  verification,
}) {
  if (!verification?.verified || !verification.verifiedIdentity) {
    throw new Error(
      "Primary recovery result requires verified runtime and exact surface identity.",
    );
  }
  return {
    schemaVersion: RECOVERY_PLAN_SCHEMA,
    state: "PRIMARY_RECOVERED",
    action: "attest_host_catalog_then_request_failback_primary",
    effectAllowed: false,
    diagnosticAgentRequired: false,
    runtimeRecovered: true,
    hostCatalogAttestationRequired: true,
    missionFailbackAuthorized: false,
    incidentId,
    receiptPath,
    recoveryOwnerObservation,
    verifiedIdentity: verification.verifiedIdentity,
    exactNextAction:
      "Refresh or reconnect the host MCP catalog where supported, attest the canonical complete client tools/list fingerprint, and require the stable primary-recovery projection to return FAILBACK_PRIMARY before normal mission work resumes.",
    reasonCodes: [
      "stable_post_restart_readiness_verified",
      "stable_post_restart_exact_surface_identity_verified",
      "host_catalog_and_mission_failback_not_yet_attested",
    ],
  };
}

async function main() {
  const policy = loadRecoveryPolicy();
  const hostObservation = normalizeHostObservation(
    process.env.ZES_NEXUS_PRIMARY_HOST_OBSERVATION,
  );
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
    const [probe, observedServiceState, competingRestartOwners] =
      await Promise.all([
      probePrimary(policy),
      serviceState(),
      activeSystemdUnits(policy.conflictingRestartUnits),
    ]);
    const basePlan = planPrimaryRecovery({
      probe,
      serviceState: observedServiceState,
      state: previous,
      policy,
      competingRestartOwners,
    });
    const plan = applyHostObservationToRecoveryPlan({
      plan: basePlan,
      probe,
      hostObservation,
    });
    const recoveryOwnerObservation = {
      configuredCompetingUnits: policy.conflictingRestartUnits,
      activeCompetingUnits: competingRestartOwners,
      effectsEnabled: policy.effectsEnabled,
    };

    if (
      plan.state === "HEALTHY"
      || plan.state === "HOST_CONNECTOR_RECOVERY_REQUIRED"
    ) {
      await rm(policy.statePath, { force: true });
      console.log(JSON.stringify({
        ...plan,
        probe,
        recoveryOwnerObservation,
      }));
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
          recoveryOwnerObservation,
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
        recoveryOwnerObservation,
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
          hostCatalogAttestationPerformed: false,
          missionFailbackAuthorized: false,
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
      console.log(JSON.stringify({
        ...plan,
        incidentId,
        receiptPath,
        recoveryOwnerObservation,
      }));
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
      recoveryOwnerObservation,
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
        hostCatalogAttestationPerformed: false,
        missionFailbackAuthorized: false,
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
        consecutiveStableProbeCount:
          verification.consecutiveStableProbeCount ?? 0,
        ...(verification.verifiedIdentity
          ? { verifiedIdentity: verification.verifiedIdentity }
          : {}),
        ...(verification.lastCandidateIdentity
          ? { lastCandidateIdentity: verification.lastCandidateIdentity }
          : {}),
        probes: verification.probes,
      },
      recoveryEscalation:
        verification.verified && !restartError
          ? undefined
          : hostMediatedRecoveryEscalation(
              restartError
                ? ["primary_restart_failed"]
                : ["primary_restart_postcondition_failed"],
            ),
    };
    await atomicWriteJson(receiptPath, terminalReceipt);

    if (verification.verified && !restartError) {
      await rm(policy.statePath, { force: true });
      console.log(JSON.stringify(primaryRecoveredResult({
        incidentId,
        receiptPath,
        recoveryOwnerObservation,
        verification,
      })));
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
      recoveryOwnerObservation,
      recoveryEscalation: terminalReceipt.recoveryEscalation,
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
