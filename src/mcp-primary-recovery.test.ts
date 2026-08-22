import assert from "node:assert/strict";
import test from "node:test";
import {
  assessMcpPrimaryReadiness,
  assessMcpPrimaryRecovery,
} from "./mcp-primary-recovery.js";

const primaryTools = [
  "execution_scope_status",
  "execution_scope_list",
  "execution_scope_message_send",
  "execution_scope_message_inbox",
  "execution_scope_message_status",
  "open_workspace",
  "read",
  "apply_patch",
  "exec_command",
  "write_stdin",
  "recovery_capsule_record",
  "recovery_capsule_status",
  "turn_horizon_status",
  "zes_research_cycle_open",
  "zes_research_cycle_prepare",
  "zes_research_provider_invoke",
  "zes_research_cycle_assess",
  "zes_research_cycle_status",
  "self_repository_publication_preflight",
  "self_repository_publish",
];

test("stale partial client catalog repairs before fallback", () => {
  const assessment = assessMcpPrimaryRecovery({
    primaryFunctionalState: "healthy",
    catalogStatus: "STALE_CLIENT",
    primaryRegisteredToolNames: primaryTools,
    clientObservedToolNames: primaryTools.slice(0, 8),
    knownCallableToolNames: ["execution_scope_status"],
    requiredCapabilityRefs: ["workspace_mutation"],
    recovery: {
      hostCatalogRefresh: "manual_only",
      catalogRefreshAttempts: 0,
      maxCatalogRefreshAttempts: 1,
    },
    fallback: {
      available: true,
      observedToolNames: ["open_workspace", "read", "apply_patch", "exec_command"],
      observedFingerprintSha256: "b".repeat(64),
      qualityEquivalentAttested: true,
      qualityEvidenceRefs: ["receipt:fallback-parity-v1"],
      policyRef: "fallback-policy:legacy-survival-v1",
    },
  });
  assert.equal(assessment.state, "REFRESH_CLIENT_CATALOG");
  assert.equal(assessment.workMayContinue, false);
  assert.equal(assessment.fallback.admitted, false);
  assert.equal(assessment.policy.primaryRepairBeforeFallback, true);
});

test("stable bootstrap projection avoids direct-tool discovery dead end", () => {
  const assessment = assessMcpPrimaryRecovery({
    primaryFunctionalState: "healthy",
    catalogStatus: "STALE_CLIENT",
    primaryRegisteredToolNames: primaryTools,
    clientObservedToolNames: ["execution_scope_status"],
    knownCallableToolNames: ["execution_scope_status"],
    stableCapabilityRefs: ["zes.continuation.preflight.v2"],
    requiredCapabilityRefs: ["continuation_readback"],
  });
  assert.equal(assessment.state, "USE_STABLE_CONTROL_PLANE");
  assert.equal(assessment.route, "stable_control_plane");
  assert.equal(assessment.workMayContinue, true);
  assert.deepEqual(
    assessment.primary.stableSatisfiedCapabilityRefs,
    ["continuation_readback"],
  );
});

test("functional degradation reconnects then repairs before fallback", () => {
  const reconnect = assessMcpPrimaryRecovery({
    primaryFunctionalState: "degraded",
    catalogStatus: "CURRENT",
    primaryRegisteredToolNames: primaryTools,
    clientObservedToolNames: primaryTools,
    requiredCapabilityRefs: ["workspace_read"],
    recovery: {
      transportReconnect: "available",
      recoveryLease: "available",
      restartSafety: "safe",
      functionalRepair: "available",
    },
  });
  assert.equal(reconnect.state, "RECONNECT_PRIMARY");

  const repair = assessMcpPrimaryRecovery({
    primaryFunctionalState: "unavailable",
    catalogStatus: "INDETERMINATE",
    primaryRegisteredToolNames: primaryTools,
    requiredCapabilityRefs: ["workspace_read"],
    recovery: {
      transportReconnect: "unavailable",
      recoveryLease: "available",
      restartSafety: "safe",
      functionalRepair: "available",
    },
  });
  assert.equal(repair.state, "REPAIR_PRIMARY");
  assert.equal(repair.primaryRepairRequired, true);
});

test("only one recovery owner may repair the primary", () => {
  const assessment = assessMcpPrimaryRecovery({
    primaryFunctionalState: "unavailable",
    catalogStatus: "INDETERMINATE",
    primaryRegisteredToolNames: primaryTools,
    requiredCapabilityRefs: ["workspace_read"],
    recovery: {
      recoveryLease: "held_elsewhere",
      restartSafety: "safe",
      functionalRepair: "available",
    },
  });
  assert.equal(assessment.state, "WAIT_FOR_RECOVERY_OWNER");
  assert.equal(assessment.workMayContinue, false);
});

test("quality-equivalent fallback is admitted only after primary recovery is exhausted", () => {
  const assessment = assessMcpPrimaryRecovery({
    primaryFunctionalState: "unavailable",
    catalogStatus: "INDETERMINATE",
    primaryRegisteredToolNames: primaryTools,
    requiredCapabilityRefs: ["workspace_mutation", "process_continuation"],
    recovery: {
      transportReconnect: "unavailable",
      recoveryLease: "available",
      restartSafety: "safe",
      functionalRepair: "unavailable",
      diagnosticAgent: "unavailable",
    },
    fallback: {
      available: true,
      observedToolNames: [
        "open_workspace",
        "read",
        "apply_patch",
        "exec_command",
        "write_stdin",
      ],
      observedFingerprintSha256: "b".repeat(64),
      qualityEquivalentAttested: true,
      qualityEvidenceRefs: ["receipt:fallback-parity-v1"],
      policyRef: "fallback-policy:legacy-survival-v1",
    },
  });
  assert.equal(assessment.state, "USE_QUALITY_EQUIVALENT_FALLBACK");
  assert.equal(assessment.route, "fallback");
  assert.equal(assessment.workMayContinue, false);
  assert.equal(assessment.fallback.admitted, true);
  assert.equal(
    assessment.fallback.routeAttestationState,
    "caller_attested",
  );
  assert.equal(assessment.fallback.callerEvidenceVerifiedByServer, false);
  assert.equal(assessment.fallback.operationScopedSelectionRequired, true);
  assert.equal(assessment.fallback.invocationAuthorized, false);
  assert.equal(
    assessment.policy.fallbackAdmissionDoesNotAuthorizeInvocation,
    true,
  );
  assert.ok(
    assessment.reasonCodes.includes(
      "operation_scoped_fallback_selection_required",
    ),
  );
  assert.match(assessment.exactNextAction, /operation-scoped/);
  assert.equal(
    assessment.fallback.observedFingerprintSha256,
    "b".repeat(64),
  );
});

test("fallback tool names without a complete surface fingerprint are insufficient", () => {
  const assessment = assessMcpPrimaryRecovery({
    primaryFunctionalState: "unavailable",
    catalogStatus: "INDETERMINATE",
    primaryRegisteredToolNames: primaryTools,
    requiredCapabilityRefs: ["workspace_read"],
    recovery: {
      transportReconnect: "unavailable",
      functionalRepair: "unavailable",
      diagnosticAgent: "unavailable",
    },
    fallback: {
      available: true,
      observedToolNames: ["open_workspace", "read"],
      qualityEquivalentAttested: true,
      qualityEvidenceRefs: ["receipt:fallback-parity-v1"],
      policyRef: "fallback-policy:legacy-survival-v1",
    },
  });
  assert.equal(assessment.state, "SAFE_TURN_LANDING");
  assert.ok(
    assessment.fallback.blockingFactors.includes(
      "fallback_surface_fingerprint_missing_or_invalid",
    ),
  );
});

test("missing fallback observation is explicitly unobservable rather than unreachable", () => {
  const assessment = assessMcpPrimaryRecovery({
    primaryFunctionalState: "unavailable",
    catalogStatus: "INDETERMINATE",
    primaryRegisteredToolNames: primaryTools,
    requiredCapabilityRefs: ["workspace_read"],
    recovery: {
      transportReconnect: "unavailable",
      functionalRepair: "unavailable",
      diagnosticAgent: "unavailable",
    },
  });
  assert.equal(assessment.fallback.available, false);
  assert.equal(
    assessment.fallback.routeReachability.state,
    "unobservable_by_primary",
  );
  assert.equal(
    assessment.fallback.routeReachability.primaryCanObserveSiblingHostConnectors,
    false,
  );
  assert.equal(
    assessment.fallback.routeReachability.doesNotMeanHostConnectorUnavailable,
    true,
  );
  assert.equal(assessment.fallback.routeAttestationState, "missing");
  assert.ok(
    assessment.fallback.blockingFactors.includes(
      "fallback_route_observation_missing",
    ),
  );
  assert.match(
    assessment.fallback.exactAttestationNextAction,
    /do not infer connector failure/,
  );
});

test("reachable host fallback remains distinct from planner admission", () => {
  const assessment = assessMcpPrimaryRecovery({
    primaryFunctionalState: "unavailable",
    catalogStatus: "INDETERMINATE",
    primaryRegisteredToolNames: primaryTools,
    requiredCapabilityRefs: ["workspace_read"],
    recovery: {
      transportReconnect: "unavailable",
      functionalRepair: "unavailable",
      diagnosticAgent: "unavailable",
    },
    fallback: {
      routeReachable: true,
      observedToolNames: ["open_workspace", "read"],
      observedFingerprintSha256: "d".repeat(64),
    },
  });
  assert.equal(
    assessment.fallback.routeReachability.state,
    "caller_observed_reachable",
  );
  assert.equal(
    assessment.fallback.routeAttestationState,
    "surface_observed",
  );
  assert.equal(assessment.fallback.plannerAdmissionState, "not_admitted");
  assert.equal(assessment.fallback.admitted, false);
  assert.ok(
    assessment.fallback.blockingFactors.includes(
      "fallback_quality_equivalence_unattested",
    ),
  );
  assert.match(
    assessment.fallback.exactAttestationNextAction,
    /surface is observed but not qualified/,
  );
});

test("conflicting fallback reachability aliases fail closed", () => {
  const assessment = assessMcpPrimaryRecovery({
    primaryFunctionalState: "unavailable",
    catalogStatus: "INDETERMINATE",
    primaryRegisteredToolNames: primaryTools,
    requiredCapabilityRefs: ["workspace_read"],
    recovery: {
      transportReconnect: "unavailable",
      functionalRepair: "unavailable",
      diagnosticAgent: "unavailable",
    },
    fallback: {
      available: false,
      routeReachable: true,
      observedToolNames: ["open_workspace", "read"],
      observedFingerprintSha256: "e".repeat(64),
      qualityEquivalentAttested: true,
      qualityEvidenceRefs: ["receipt:quality"],
      policyRef: "policy:fallback",
    },
  });
  assert.equal(
    assessment.fallback.routeReachability.state,
    "conflicting_caller_observation",
  );
  assert.equal(assessment.fallback.admitted, false);
  assert.ok(
    assessment.fallback.blockingFactors.includes(
      "fallback_route_observation_conflicting",
    ),
  );
});

test("critical capability deficit lands the turn instead of reducing quality", () => {
  const assessment = assessMcpPrimaryRecovery({
    primaryFunctionalState: "unavailable",
    catalogStatus: "INDETERMINATE",
    primaryRegisteredToolNames: primaryTools,
    requiredCapabilityRefs: ["research_freshness"],
    recovery: {
      transportReconnect: "unavailable",
      recoveryLease: "available",
      restartSafety: "unknown",
      functionalRepair: "unavailable",
      diagnosticAgent: "unavailable",
    },
    fallback: {
      available: true,
      observedToolNames: ["open_workspace", "read", "exec_command"],
      qualityEquivalentAttested: false,
    },
    safeTurnLandingAvailable: true,
  });
  assert.equal(assessment.state, "SAFE_TURN_LANDING");
  assert.equal(assessment.workMayContinue, false);
  assert.ok(
    assessment.fallback.blockingFactors.includes(
      "capability_disallows_fallback",
    ),
  );
  assert.equal(assessment.policy.qualityReductionAuthorized, false);
});

test("effectful work never implicitly moves to fallback", () => {
  const assessment = assessMcpPrimaryRecovery({
    primaryFunctionalState: "unavailable",
    catalogStatus: "INDETERMINATE",
    primaryRegisteredToolNames: primaryTools,
    requiredCapabilityRefs: ["repository_publication_effect"],
    recovery: {
      transportReconnect: "unavailable",
      functionalRepair: "unavailable",
      diagnosticAgent: "unavailable",
    },
    fallback: {
      available: true,
      observedToolNames: [
        "self_repository_publication_preflight",
        "self_repository_publish",
      ],
      observedFingerprintSha256: "c".repeat(64),
      qualityEquivalentAttested: true,
      qualityEvidenceRefs: ["receipt:effectful-fallback-parity-v1"],
      policyRef: "fallback-policy:effectful-not-allowed",
    },
  });
  assert.equal(assessment.state, "SAFE_TURN_LANDING");
  assert.ok(
    assessment.fallback.blockingFactors.includes(
      "effectful_fallback_implicitly_denied",
    ),
  );
});

test("verified primary recovery fails back from standby", () => {
  const assessment = assessMcpPrimaryRecovery({
    primaryFunctionalState: "healthy",
    activeRoute: "fallback",
    catalogStatus: "CURRENT",
    primaryRegisteredToolNames: primaryTools,
    clientObservedToolNames: primaryTools,
    requiredCapabilityRefs: ["workspace_read"],
  });
  assert.equal(assessment.state, "FAILBACK_PRIMARY");
  assert.equal(assessment.route, "primary");
});

test("failback waits for a current primary catalog even for bootstrap-only work", () => {
  const assessment = assessMcpPrimaryRecovery({
    primaryFunctionalState: "healthy",
    activeRoute: "fallback",
    catalogStatus: "SERVER_CURRENT_CLIENT_UNKNOWN",
    primaryRegisteredToolNames: primaryTools,
    knownCallableToolNames: ["execution_scope_status"],
  });
  assert.equal(assessment.state, "ATTEST_CLIENT_CATALOG");
  assert.equal(assessment.route, "none");
  assert.equal(assessment.workMayContinue, false);
});

test("observed client tool names without a current descriptor fingerprint do not attest the catalog", () => {
  const assessment = assessMcpPrimaryRecovery({
    primaryFunctionalState: "healthy",
    catalogStatus: "SERVER_CURRENT_CLIENT_UNKNOWN",
    primaryRegisteredToolNames: primaryTools,
    clientObservedToolNames: primaryTools,
    knownCallableToolNames: primaryTools,
    requiredCapabilityRefs: ["workspace_mutation"],
  });
  assert.equal(assessment.primary.clientCatalogAttested, false);
  assert.equal(assessment.state, "ATTEST_CLIENT_CATALOG");
  assert.equal(assessment.workMayContinue, false);
  assert.ok(
    assessment.exactNextAction.includes("complete tools/list fingerprint"),
  );
});

test("functional readiness distinguishes liveness from safe restart", () => {
  const brokenIdle = assessMcpPrimaryReadiness({
    databaseState: "failed",
    databaseErrorKind: "SQLITE_IOERR",
    databaseErrorDigestSha256: "a".repeat(64),
    toolSurfaceInitialized: true,
    toolCount: 63,
    activeToolCount: 0,
    runningProcessCount: 0,
    serviceChildProcessObservationState: "observed",
    activeServiceChildProcessCount: 0,
  });
  assert.equal(brokenIdle.ok, false);
  assert.equal(brokenIdle.restartSafety.state, "safe");

  const brokenBusy = assessMcpPrimaryReadiness({
    databaseState: "failed",
    toolSurfaceInitialized: true,
    toolCount: 63,
    activeToolCount: 1,
    runningProcessCount: 2,
    serviceChildProcessObservationState: "observed",
    activeServiceChildProcessCount: 1,
  });
  assert.equal(brokenBusy.restartSafety.state, "defer");
  assert.deepEqual(
    brokenBusy.restartSafety.reasonCodes,
    [
      "active_mcp_tools",
      "running_workspace_processes",
      "active_service_child_processes",
    ],
  );

  const brokenUnobserved = assessMcpPrimaryReadiness({
    databaseState: "failed",
    toolSurfaceInitialized: true,
    toolCount: 63,
    activeToolCount: 0,
    runningProcessCount: 0,
    serviceChildProcessObservationState: "unavailable",
  });
  assert.equal(brokenUnobserved.restartSafety.state, "defer");
  assert.deepEqual(
    brokenUnobserved.restartSafety.reasonCodes,
    ["service_child_process_state_unobserved"],
  );
});
