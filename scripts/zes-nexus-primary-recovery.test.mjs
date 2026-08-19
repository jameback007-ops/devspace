import assert from "node:assert/strict";
import test from "node:test";
import {
  loadRecoveryPolicy,
  normalizeReadinessProbe,
  planPrimaryRecovery,
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

test("healthy primary clears incident state", () => {
  const probe = normalizeReadinessProbe({
    httpStatus: 200,
    body: {
      ok: true,
      state: "READY",
      database: { state: "ready" },
      activity: { activeToolCount: 0, runningProcessCount: 0 },
      restartSafety: { state: "safe", reasonCodes: [] },
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

test("automatic repair budget escalates instead of restart looping", () => {
  const plan = planPrimaryRecovery({
    probe: failedProbe(),
    serviceState: "active",
    state: { consecutiveFailures: 5, repairAttempts: 1 },
    policy,
  });
  assert.equal(plan.state, "DIAGNOSTIC_REQUIRED");
  assert.equal(plan.diagnosticAgentRequired, true);
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
