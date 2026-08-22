import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  evaluateStablePrimaryProbes,
  isPrimaryRecoveryControlHealthy,
  loadRecoveryPolicy,
  normalizeReadinessProbe,
  planPrimaryRecovery,
  primaryRecoveredResult,
  shouldPersistRecoveryTransition,
} from "./zes-nexus-primary-recovery.mjs";

const policy = {
  failureThreshold: 3,
  maxRepairAttempts: 1,
  effectsEnabled: true,
};

function failedProbe(restartSafety = "safe") {
  return normalizeReadinessProbe({
    httpStatus: 503,
    body: {
      ok: false,
      state: "NOT_READY",
      reasonCodes: ["database_sentinel_failed"],
      database: {
        state: "failed",
        errorKind: "Error:SQLITE_IOERR",
        errorDigestSha256: "a".repeat(64),
      },
      activity: {
        activeToolCount: restartSafety === "safe" ? 0 : 1,
        runningProcessCount: 0,
        serviceChildProcessObservationState: "observed",
        activeServiceChildProcessCount: 0,
      },
      restartSafety: {
        state: restartSafety,
        reasonCodes: restartSafety === "safe" ? [] : ["active_mcp_tools"],
      },
      backendInstanceRef: "old-instance",
    },
  });
}

test("readiness normalization excludes raw error bodies", () => {
  const probe = normalizeReadinessProbe({
    errorCode: "ECONNREFUSED",
    errorMessage: "secret connection details",
  });
  assert.equal(probe.state, "unreachable");
  assert.equal("errorMessage" in probe, false);
  assert.match(probe.errorDigestSha256, /^[a-f0-9]{64}$/);
});

test("readiness normalization rejects inconsistent safe claims", () => {
  const probe = normalizeReadinessProbe({
    httpStatus: 503,
    body: {
      ok: false,
      state: "NOT_READY",
      database: { state: "failed" },
      activity: {
        activeToolCount: 0,
        runningProcessCount: 0,
        serviceChildProcessObservationState: "observed",
        activeServiceChildProcessCount: 2,
      },
      restartSafety: { state: "safe", reasonCodes: [] },
      backendInstanceRef: "healthy-instance",
      surfaceEpoch: "nexus:healthy-surface",
      toolSurfaceFingerprintSha256: "c".repeat(64),
      serverSurfaceCurrent: true,
      toolSurfaceFreshnessStatus: "CURRENT",
    },
  });
  assert.equal(probe.restartSafety.state, "defer");
  assert.ok(
    probe.restartSafety.reasonCodes.includes("active_service_child_processes"),
  );
  assert.equal(
    probe.policy.restartSafetyRecomputedFromNormalizedActivity,
    true,
  );
});

test("stable recovery requires one changed instance with a stable exact surface identity", () => {
  const fingerprint = "f".repeat(64);
  const stableProbe = {
    healthy: true,
    backendInstanceRef: "new-instance",
    surfaceEpoch: "nexus:new-surface",
    toolSurfaceFingerprintSha256: fingerprint,
    serverSurfaceCurrent: true,
  };
  const verified = evaluateStablePrimaryProbes(
    [stableProbe, stableProbe, stableProbe],
    "old-instance",
    3,
  );
  assert.equal(verified.verified, true);
  assert.deepEqual(verified.verifiedIdentity, {
    backendInstanceRef: "new-instance",
    surfaceEpoch: "nexus:new-surface",
    toolSurfaceFingerprintSha256: fingerprint,
  });

  const drifted = evaluateStablePrimaryProbes(
    [
      stableProbe,
      {
        ...stableProbe,
        toolSurfaceFingerprintSha256: "e".repeat(64),
      },
      stableProbe,
    ],
    "old-instance",
    3,
  );
  assert.equal(drifted.verified, false);

  const missingIdentity = evaluateStablePrimaryProbes(
    [
      {
        healthy: true,
        backendInstanceRef: "new-instance",
        surfaceEpoch: "nexus:new-surface",
      },
    ],
    "old-instance",
    1,
  );
  assert.equal(missingIdentity.verified, false);

  const staleServer = evaluateStablePrimaryProbes(
    [{ ...stableProbe, serverSurfaceCurrent: false }],
    "old-instance",
    1,
  );
  assert.equal(staleServer.verified, false);
});

test("runtime recovery does not claim host catalog or mission failback authority", () => {
  const result = primaryRecoveredResult({
    incidentId: "incident:test",
    receiptPath: "/receipts/test.json",
    recoveryOwnerObservation: { effectsEnabled: true },
    verification: {
      verified: true,
      verifiedIdentity: {
        backendInstanceRef: "new-instance",
        surfaceEpoch: "nexus:new-surface",
        toolSurfaceFingerprintSha256: "f".repeat(64),
      },
    },
  });
  assert.equal(result.state, "PRIMARY_RECOVERED");
  assert.equal(
    result.action,
    "attest_host_catalog_then_request_failback_primary",
  );
  assert.equal(result.runtimeRecovered, true);
  assert.equal(result.hostCatalogAttestationRequired, true);
  assert.equal(result.missionFailbackAuthorized, false);
  assert.ok(result.exactNextAction.includes("FAILBACK_PRIMARY"));
  assert.throws(
    () => primaryRecoveredResult({
      incidentId: "incident:test",
      receiptPath: "/receipts/test.json",
      recoveryOwnerObservation: {},
      verification: { verified: false },
    }),
    /requires verified runtime and exact surface identity/,
  );
});

test("readiness normalization preserves only a valid exact surface fingerprint", () => {
  const fingerprint = "d".repeat(64);
  const probe = normalizeReadinessProbe({
    httpStatus: 200,
    body: {
      ok: true,
      state: "READY",
      database: { state: "ready" },
      activity: {
        activeToolCount: 0,
        runningProcessCount: 0,
        serviceChildProcessObservationState: "observed",
        activeServiceChildProcessCount: 0,
      },
      restartSafety: { state: "safe", reasonCodes: [] },
      backendInstanceRef: "new-instance",
      surfaceEpoch: "nexus:new-surface",
      toolSurfaceFingerprintSha256: fingerprint,
      serverSurfaceCurrent: true,
      toolSurfaceFreshnessStatus: "CURRENT",
    },
  });
  assert.equal(probe.toolSurfaceFingerprintSha256, fingerprint);
  assert.equal(probe.serverSurfaceCurrent, true);
  assert.equal(probe.toolSurfaceFreshnessStatus, "CURRENT");
});

test("healthy primary clears incident state", () => {
  const probe = normalizeReadinessProbe({
    httpStatus: 200,
    body: {
      ok: true,
      state: "READY",
      database: { state: "ready" },
      activity: {
        activeToolCount: 0,
        runningProcessCount: 0,
        serviceChildProcessObservationState: "observed",
        activeServiceChildProcessCount: 0,
      },
      restartSafety: { state: "safe", reasonCodes: [] },
      backendInstanceRef: "healthy-instance",
      surfaceEpoch: "nexus:healthy-surface",
      toolSurfaceFingerprintSha256: "c".repeat(64),
      serverSurfaceCurrent: true,
      toolSurfaceFreshnessStatus: "CURRENT",
    },
  });
  const plan = planPrimaryRecovery({
    probe,
    serviceState: "active",
    state: { consecutiveFailures: 7, repairAttempts: 1 },
    policy,
  });
  assert.equal(plan.state, "HEALTHY");
  assert.equal(plan.consecutiveFailures, 0);
});

test("functional readiness alone cannot clear a stale or unattested primary surface", () => {
  const exactProbe = normalizeReadinessProbe({
    httpStatus: 200,
    body: {
      ok: true,
      state: "READY",
      database: { state: "ready" },
      activity: {
        activeToolCount: 0,
        runningProcessCount: 0,
        serviceChildProcessObservationState: "observed",
        activeServiceChildProcessCount: 0,
      },
      restartSafety: { state: "safe", reasonCodes: [] },
      backendInstanceRef: "healthy-instance",
      surfaceEpoch: "nexus:healthy-surface",
      toolSurfaceFingerprintSha256: "c".repeat(64),
      serverSurfaceCurrent: true,
      toolSurfaceFreshnessStatus: "CURRENT",
    },
  });
  assert.equal(isPrimaryRecoveryControlHealthy(exactProbe), true);

  const staleProbe = {
    ...exactProbe,
    serverSurfaceCurrent: false,
    toolSurfaceFreshnessStatus: "STALE_SERVER",
  };
  assert.equal(isPrimaryRecoveryControlHealthy(staleProbe), false);
  const stalePlan = planPrimaryRecovery({
    probe: staleProbe,
    serviceState: "active",
    state: { consecutiveFailures: 0, repairAttempts: 0 },
    policy,
  });
  assert.equal(stalePlan.state, "OBSERVE_DEGRADED");
  assert.ok(stalePlan.reasonCodes.includes("primary_server_surface_stale"));

  const unattestedProbe = {
    ...exactProbe,
    surfaceEpoch: undefined,
    toolSurfaceFingerprintSha256: undefined,
    serverSurfaceCurrent: null,
  };
  assert.equal(isPrimaryRecoveryControlHealthy(unattestedProbe), false);
  const unattestedPlan = planPrimaryRecovery({
    probe: unattestedProbe,
    serviceState: "active",
    state: { consecutiveFailures: 2, repairAttempts: 0 },
    policy,
  });
  assert.equal(unattestedPlan.state, "RESTART_PRIMARY");
  assert.ok(
    unattestedPlan.reasonCodes.includes("primary_surface_epoch_unattested"),
  );
  assert.ok(
    unattestedPlan.reasonCodes.includes(
      "primary_tool_surface_fingerprint_unattested",
    ),
  );
});

test("failure threshold suppresses premature repair", () => {
  const plan = planPrimaryRecovery({
    probe: failedProbe(),
    serviceState: "active",
    state: { consecutiveFailures: 1, repairAttempts: 0 },
    policy,
  });
  assert.equal(plan.state, "OBSERVE_DEGRADED");
  assert.equal(plan.effectAllowed, false);
});

test("active work defers restart even after threshold", () => {
  const plan = planPrimaryRecovery({
    probe: failedProbe("defer"),
    serviceState: "active",
    state: { consecutiveFailures: 2, repairAttempts: 0 },
    policy,
  });
  assert.equal(plan.state, "DEFER_ACTIVE_WORK");
  assert.equal(plan.effectAllowed, false);
});

test("safe functional failure restarts the fixed primary once", () => {
  const plan = planPrimaryRecovery({
    probe: failedProbe(),
    serviceState: "active",
    state: { consecutiveFailures: 2, repairAttempts: 0 },
    policy,
  });
  assert.equal(plan.state, "RESTART_PRIMARY");
  assert.equal(plan.repairAttempts, 1);
  assert.equal(plan.effectAllowed, true);
});

test("effects-enabled recovery refuses to race an active legacy watchdog", () => {
  const plan = planPrimaryRecovery({
    probe: failedProbe(),
    serviceState: "active",
    state: { consecutiveFailures: 2, repairAttempts: 0 },
    policy,
    competingRestartOwners: ["devspace-zesnexus-health.timer"],
  });
  assert.equal(plan.state, "COMPETING_RECOVERY_OWNER");
  assert.equal(plan.effectAllowed, false);
  assert.deepEqual(plan.competingRestartOwners, [
    "devspace-zesnexus-health.timer",
  ]);
  assert.ok(plan.reasonCodes.includes("competing_recovery_owner_active"));
});

test("automatic repair budget escalates instead of restart looping", () => {
  const plan = planPrimaryRecovery({
    probe: failedProbe(),
    serviceState: "active",
    state: { consecutiveFailures: 5, repairAttempts: 1 },
    policy,
  });
  assert.equal(plan.state, "DIAGNOSTIC_REQUIRED");
  assert.equal(plan.diagnosticAgentRequired, true);
  assert.equal(
    plan.recoveryEscalation.dispatchState,
    "external_host_action_required",
  );
  assert.equal(plan.recoveryEscalation.routeClass, "recovery_only");
  assert.equal(plan.recoveryEscalation.nexusBootstrapToolRequired, false);
  assert.equal(plan.recoveryEscalation.hostMediatedDispatchRequired, true);
  assert.equal(plan.recoveryEscalation.primaryCanInvokeSiblingConnector, false);
  assert.equal(
    plan.recoveryEscalation.routeSelectionAuthorizesRepairEffect,
    false,
  );
  assert.equal(
    plan.recoveryEscalation.callerEvidenceVerifiedByController,
    false,
  );
  assert.equal(
    plan.recoveryEscalation.executableRepairOwnerClass,
    "host_or_executor_bound_to_independently_attested_recovery_route",
  );
  assert.ok(
    plan.recoveryEscalation.remainingExternalLimitations.includes(
      "sibling_host_connector_invocation_unavailable_to_controller",
    ),
  );
  assert.equal(plan.recoveryEscalation.missionAuthorityGranted, false);
  assert.equal(plan.recoveryEscalation.effectReplayAuthorized, false);
  assert.deepEqual(plan.recoveryEscalation.requiredTools, [
    "open_workspace",
    "read",
    "apply_patch",
    "exec_command",
    "write_stdin",
  ]);
  assert.ok(
    plan.recoveryEscalation.failbackPostconditions.includes(
      "primary_route_reselected_before_mission_work",
    ),
  );
});

test("corrupt persisted counters are bounded instead of changing repair policy", () => {
  const plan = planPrimaryRecovery({
    probe: failedProbe(),
    serviceState: "active",
    state: {
      consecutiveFailures: "not-a-number",
      repairAttempts: { forged: true },
    },
    policy: { ...policy, failureThreshold: 1 },
  });
  assert.equal(plan.state, "RESTART_PRIMARY");
  assert.equal(plan.consecutiveFailures, 1);
  assert.equal(plan.repairAttempts, 1);
});

test("unchanged recovery states suppress duplicate durable receipts", () => {
  assert.equal(
    shouldPersistRecoveryTransition(
      { lastPlanState: "EFFECTS_DISABLED" },
      { state: "EFFECTS_DISABLED" },
    ),
    false,
  );
  assert.equal(
    shouldPersistRecoveryTransition(
      { lastPlanState: "OBSERVE_DEGRADED" },
      { state: "EFFECTS_DISABLED" },
    ),
    true,
  );
});

test("effects-disabled policy never restarts the service", () => {
  const plan = planPrimaryRecovery({
    probe: failedProbe(),
    serviceState: "active",
    state: { consecutiveFailures: 2, repairAttempts: 0 },
    policy: { ...policy, effectsEnabled: false },
    competingRestartOwners: ["devspace-zesnexus-health.timer"],
  });
  assert.equal(plan.state, "EFFECTS_DISABLED");
  assert.equal(plan.effectAllowed, false);
});

test("policy rejects non-loopback readiness endpoints", () => {
  assert.throws(
    () => loadRecoveryPolicy({
      ZES_NEXUS_PRIMARY_READY_URL: "https://example.com/readyz",
    }),
    /loopback HTTP/,
  );
});

test("policy rejects unsafe competing recovery unit names", () => {
  assert.throws(
    () => loadRecoveryPolicy({
      ZES_NEXUS_PRIMARY_RECOVERY_CONFLICTING_RESTART_UNITS:
        "../../danger.service",
    }),
    /unit name is invalid/,
  );
});

test("policy defaults to the currently deployed legacy watchdog as a conflict", () => {
  const loaded = loadRecoveryPolicy({});
  assert.deepEqual(loaded.conflictingRestartUnits, [
    "devspace-zesnexus-health.timer",
  ]);
});

test("policy separates durable incident state from the volatile recovery lease", () => {
  const loaded = loadRecoveryPolicy({
    ZES_NEXUS_PRIMARY_RECOVERY_STATE_ROOT:
      "/var/lib/devspace-zesnexus-primary-recovery/state",
    ZES_NEXUS_PRIMARY_RECOVERY_LEASE_ROOT:
      "/run/devspace-zesnexus-primary-recovery",
  });
  assert.equal(
    loaded.statePath,
    "/var/lib/devspace-zesnexus-primary-recovery/state/state.json",
  );
  assert.equal(
    loaded.leasePath,
    "/run/devspace-zesnexus-primary-recovery/owner.lock",
  );
  assert.notEqual(loaded.stateRoot, loaded.leaseRoot);
});

test("systemd timer example persists threshold state across oneshot invocations", () => {
  const unit = readFileSync(
    new URL(
      "../examples/systemd/zes-nexus-primary-recovery.service",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(unit, /StateDirectory=devspace-zesnexus-primary-recovery/);
  assert.match(unit, /RuntimeDirectory=devspace-zesnexus-primary-recovery/);
  assert.match(
    unit,
    /ZES_NEXUS_PRIMARY_RECOVERY_STATE_ROOT=\/var\/lib\/devspace-zesnexus-primary-recovery\/state/,
  );
  assert.match(
    unit,
    /ZES_NEXUS_PRIMARY_RECOVERY_LEASE_ROOT=\/run\/devspace-zesnexus-primary-recovery/,
  );
});
