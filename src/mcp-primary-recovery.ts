import type { OverallFreshnessStatus } from "./tool-surface-freshness.js";

export const MCP_PRIMARY_RECOVERY_ASSESSMENT_SCHEMA =
  "zes.mcp-primary-recovery-assessment.v1" as const;
export const MCP_PRIMARY_RECOVERY_CAPABILITY_REF =
  "zes.mcp-primary-recovery.v1" as const;
export const MCP_PRIMARY_READINESS_SCHEMA =
  "zes.mcp-primary-readiness.v1" as const;

export const MCP_WORK_CAPABILITY_REFS = [
  "bootstrap",
  "workspace_read",
  "workspace_mutation",
  "process_continuation",
  "research_freshness",
  "continuation_readback",
  "cross_session_coordination",
  "repository_publication_preflight",
  "repository_publication_effect",
  "recovery_checkpoint",
  "conversation_recovery",
  "artifact_transfer",
] as const;

export type McpWorkCapabilityRef = typeof MCP_WORK_CAPABILITY_REFS[number];

export type McpPrimaryFunctionalState =
  | "healthy"
  | "degraded"
  | "unavailable"
  | "unknown";

export type McpRecoveryRouteAvailability =
  | "available"
  | "manual_only"
  | "unavailable"
  | "unknown";

export type McpRecoveryLeaseState =
  | "held_by_current"
  | "available"
  | "held_elsewhere"
  | "unknown";

export type McpRestartSafety =
  | "safe"
  | "defer_active_work"
  | "blocked_unknown_effect"
  | "unknown";

export type McpPrimaryRecoveryState =
  | "CONTINUE_PRIMARY"
  | "FAILBACK_PRIMARY"
  | "ATTEST_CLIENT_CATALOG"
  | "USE_STABLE_CONTROL_PLANE"
  | "REFRESH_CLIENT_CATALOG"
  | "RECONNECT_PRIMARY"
  | "REPAIR_PRIMARY"
  | "DIAGNOSE_PRIMARY"
  | "WAIT_FOR_RECOVERY_OWNER"
  | "USE_QUALITY_EQUIVALENT_FALLBACK"
  | "SAFE_TURN_LANDING"
  | "HARD_EXTERNAL_BLOCKER";

interface McpWorkCapabilityDefinition {
  requiredTools: readonly string[];
  stableCapabilityRefs?: readonly string[];
  qualityCritical: boolean;
  effectful: boolean;
  fallbackEligible: boolean;
}

const CAPABILITIES: Record<
  McpWorkCapabilityRef,
  McpWorkCapabilityDefinition
> = {
  bootstrap: {
    requiredTools: ["execution_scope_status"],
    qualityCritical: false,
    effectful: false,
    fallbackEligible: false,
  },
  workspace_read: {
    requiredTools: ["open_workspace", "read"],
    qualityCritical: false,
    effectful: false,
    fallbackEligible: true,
  },
  workspace_mutation: {
    requiredTools: ["open_workspace", "read", "apply_patch", "exec_command"],
    qualityCritical: true,
    effectful: false,
    fallbackEligible: true,
  },
  process_continuation: {
    requiredTools: ["exec_command", "write_stdin"],
    qualityCritical: true,
    effectful: false,
    fallbackEligible: true,
  },
  research_freshness: {
    requiredTools: [
      "zes_research_cycle_open",
      "zes_research_cycle_prepare",
      "zes_research_provider_invoke",
      "zes_research_cycle_assess",
      "zes_research_cycle_status",
    ],
    qualityCritical: true,
    effectful: false,
    fallbackEligible: false,
  },
  continuation_readback: {
    requiredTools: ["execution_scope_status"],
    stableCapabilityRefs: ["zes.continuation.preflight.v2"],
    qualityCritical: true,
    effectful: false,
    fallbackEligible: false,
  },
  cross_session_coordination: {
    requiredTools: [
      "execution_scope_list",
      "execution_scope_status",
      "execution_scope_message_send",
      "execution_scope_message_inbox",
      "execution_scope_message_status",
    ],
    qualityCritical: true,
    effectful: false,
    fallbackEligible: false,
  },
  repository_publication_preflight: {
    requiredTools: ["execution_scope_status"],
    stableCapabilityRefs: [
      "zes.scope-publication.preflight.v1",
      "devspace.self-repository-publication.scope-preflight.v1",
    ],
    qualityCritical: true,
    effectful: false,
    fallbackEligible: false,
  },
  repository_publication_effect: {
    requiredTools: [
      "self_repository_publication_preflight",
      "self_repository_publish",
    ],
    qualityCritical: true,
    effectful: true,
    fallbackEligible: false,
  },
  recovery_checkpoint: {
    requiredTools: [
      "recovery_capsule_record",
      "recovery_capsule_status",
      "turn_horizon_status",
    ],
    qualityCritical: true,
    effectful: false,
    fallbackEligible: false,
  },
  conversation_recovery: {
    requiredTools: [
      "conversation_transport_status",
      "execution_wake_status",
      "execution_wake_assess",
      "execution_wake_reconcile",
    ],
    qualityCritical: true,
    effectful: true,
    fallbackEligible: false,
  },
  artifact_transfer: {
    requiredTools: ["download_artifact"],
    qualityCritical: false,
    effectful: false,
    fallbackEligible: true,
  },
};

export interface McpPrimaryRecoveryRoutes {
  transportReconnect?: McpRecoveryRouteAvailability;
  hostCatalogRefresh?: McpRecoveryRouteAvailability;
  functionalRepair?: McpRecoveryRouteAvailability;
  diagnosticAgent?: McpRecoveryRouteAvailability;
  recoveryLease?: McpRecoveryLeaseState;
  restartSafety?: McpRestartSafety;
  reconnectAttempts?: number;
  maxReconnectAttempts?: number;
  catalogRefreshAttempts?: number;
  maxCatalogRefreshAttempts?: number;
  functionalRepairAttempts?: number;
  maxFunctionalRepairAttempts?: number;
  diagnosticAttempts?: number;
  maxDiagnosticAttempts?: number;
}

export interface McpFallbackObservation {
  available: boolean;
  observedToolNames?: readonly string[];
  observedFingerprintSha256?: string;
  stableCapabilityRefs?: readonly string[];
  qualityEquivalentAttested?: boolean;
  qualityEvidenceRefs?: readonly string[];
  policyRef?: string;
}

export interface McpPrimaryRecoveryAssessmentInput {
  primaryFunctionalState: McpPrimaryFunctionalState;
  activeRoute?: "primary" | "fallback";
  catalogStatus: OverallFreshnessStatus;
  primaryRegisteredToolNames: readonly string[];
  clientObservedToolNames?: readonly string[];
  knownCallableToolNames?: readonly string[];
  stableCapabilityRefs?: readonly string[];
  requiredCapabilityRefs?: readonly McpWorkCapabilityRef[];
  recovery?: McpPrimaryRecoveryRoutes;
  fallback?: McpFallbackObservation;
  safeTurnLandingAvailable?: boolean;
}

export interface McpCapabilityRecoveryView {
  capabilityRef: McpWorkCapabilityRef;
  requiredTools: string[];
  missingServerTools: string[];
  missingPrimaryTools: string[];
  stableProjectionSatisfied: boolean;
  qualityCritical: boolean;
  effectful: boolean;
  fallbackEligible: boolean;
  missingFallbackTools: string[];
}

export interface McpPrimaryRecoveryAssessment {
  schemaVersion: typeof MCP_PRIMARY_RECOVERY_ASSESSMENT_SCHEMA;
  capabilityRef: typeof MCP_PRIMARY_RECOVERY_CAPABILITY_REF;
  state: McpPrimaryRecoveryState;
  route: "primary" | "stable_control_plane" | "fallback" | "none";
  workMayContinue: boolean;
  primaryRepairRequired: boolean;
  clientCatalogRepairRequired: boolean;
  exactNextAction: string;
  reasonCodes: string[];
  requiredCapabilityRefs: McpWorkCapabilityRef[];
  capabilities: McpCapabilityRecoveryView[];
  primary: {
    functionalState: McpPrimaryFunctionalState;
    catalogStatus: OverallFreshnessStatus;
    clientCatalogAttested: boolean;
    missingRegisteredTools: string[];
    missingRequiredTools: string[];
    stableSatisfiedCapabilityRefs: McpWorkCapabilityRef[];
  };
  recovery: {
    leaseState: McpRecoveryLeaseState;
    restartSafety: McpRestartSafety;
    transportReconnect: McpRecoveryRouteAvailability;
    hostCatalogRefresh: McpRecoveryRouteAvailability;
    functionalRepair: McpRecoveryRouteAvailability;
    diagnosticAgent: McpRecoveryRouteAvailability;
  };
  fallback: {
    available: boolean;
    admitted: boolean;
    qualityEquivalentAttested: boolean;
    observedFingerprintSha256?: string;
    qualityEvidenceRefs: string[];
    policyRef?: string;
    missingRequiredTools: string[];
    blockingFactors: string[];
  };
  policy: {
    primaryRepairBeforeFallback: true;
    fallbackIsLastResort: true;
    fallbackRequiresTypedQualityEquivalence: true;
    fallbackRequiresSurfaceFingerprintAndEvidence: true;
    effectfulFallbackImplicitlyDenied: true;
    safeTurnLandingPreferredToQualityReduction: true;
    oneRecoveryOwnerRequired: true;
    qualityReductionAuthorized: false;
    canonicalTaskDecisionWriterEffectOrPublicationAuthorityGranted: false;
  };
}

export interface McpPrimaryReadinessInput {
  databaseState: "ready" | "failed";
  latestMigrationVersion?: number;
  executionScopeCount?: number;
  toolSurfaceInitialized: boolean;
  toolCount: number;
  activeToolCount: number;
  runningProcessCount: number;
  serviceChildProcessObservationState?: "observed" | "unavailable";
  activeServiceChildProcessCount?: number;
  databaseErrorKind?: string;
  databaseErrorDigestSha256?: string;
}

export interface McpPrimaryReadiness {
  schemaVersion: typeof MCP_PRIMARY_READINESS_SCHEMA;
  ok: boolean;
  state: "READY" | "NOT_READY";
  reasonCodes: string[];
  database: {
    state: "ready" | "failed";
    latestMigrationVersion?: number;
    executionScopeCount?: number;
    errorKind?: string;
    errorDigestSha256?: string;
  };
  toolSurface: {
    initialized: boolean;
    toolCount: number;
  };
  activity: {
    activeToolCount: number;
    runningProcessCount: number;
    serviceChildProcessObservationState: "observed" | "unavailable";
    activeServiceChildProcessCount: number;
  };
  restartSafety: {
    state: "safe" | "defer";
    reasonCodes: string[];
  };
  policy: {
    livenessIsNotReadiness: true;
    sameProcessDatabaseSentinel: true;
    restartRequiresNoActiveToolProcessOrServiceChild: true;
    readinessGrantsNoDeploymentOrEffectAuthority: true;
  };
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

function boundedCount(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 0) return fallback;
  return value;
}

function routeAvailable(
  value: McpRecoveryRouteAvailability | undefined,
): McpRecoveryRouteAvailability {
  return value ?? "unknown";
}

function attemptAvailable(
  attempts: number | undefined,
  maximum: number | undefined,
  defaultMaximum: number,
): boolean {
  return boundedCount(attempts, 0)
    < boundedCount(maximum, defaultMaximum);
}

function capabilityRefs(
  values: readonly McpWorkCapabilityRef[] | undefined,
): McpWorkCapabilityRef[] {
  const selected = values && values.length > 0 ? values : ["bootstrap"];
  return uniqueSorted(selected) as McpWorkCapabilityRef[];
}

function stableProjectionSatisfied(
  definition: McpWorkCapabilityDefinition,
  stableRefs: Set<string>,
  callableTools: Set<string>,
): boolean {
  return Boolean(
    definition.stableCapabilityRefs?.some((ref) => stableRefs.has(ref))
    && callableTools.has("execution_scope_status"),
  );
}

function fallbackDecision(
  input: McpPrimaryRecoveryAssessmentInput,
  capabilityViews: McpCapabilityRecoveryView[],
): {
  state: McpPrimaryRecoveryState;
  route: McpPrimaryRecoveryAssessment["route"];
  workMayContinue: boolean;
  exactNextAction: string;
  reasonCodes: string[];
  admitted: boolean;
  blockingFactors: string[];
  missingRequiredTools: string[];
} {
  const fallback = input.fallback;
  const missingRequiredTools = uniqueSorted(
    capabilityViews.flatMap((view) => view.missingFallbackTools),
  );
  const blockingFactors: string[] = [];
  if (!fallback?.available) blockingFactors.push("fallback_unavailable");
  if (!fallback?.qualityEquivalentAttested) {
    blockingFactors.push("fallback_quality_equivalence_unattested");
  }
  if (!/^[a-f0-9]{64}$/.test(fallback?.observedFingerprintSha256 ?? "")) {
    blockingFactors.push("fallback_surface_fingerprint_missing_or_invalid");
  }
  if (!fallback?.qualityEvidenceRefs?.some((ref) => ref.trim().length > 0)) {
    blockingFactors.push("fallback_quality_evidence_missing");
  }
  if (!fallback?.policyRef?.trim()) {
    blockingFactors.push("fallback_policy_ref_missing");
  }
  if (missingRequiredTools.length > 0) {
    blockingFactors.push("fallback_required_capabilities_missing");
  }
  if (capabilityViews.some((view) => !view.fallbackEligible)) {
    blockingFactors.push("capability_disallows_fallback");
  }
  if (capabilityViews.some((view) => view.effectful)) {
    blockingFactors.push("effectful_fallback_implicitly_denied");
  }
  const admitted = blockingFactors.length === 0;
  if (admitted) {
    return {
      state: "USE_QUALITY_EQUIVALENT_FALLBACK",
      route: "fallback",
      workMayContinue: true,
      exactNextAction:
        "Use the exact typed quality-equivalent fallback policy for this causal slice, keep primary recovery pending, and fail back after verified primary readiness.",
      reasonCodes: ["primary_recovery_exhausted", "quality_equivalent_fallback_attested"],
      admitted: true,
      blockingFactors,
      missingRequiredTools,
    };
  }
  if (input.safeTurnLandingAvailable !== false) {
    return {
      state: "SAFE_TURN_LANDING",
      route: "none",
      workMayContinue: false,
      exactNextAction:
        "Record a recoverable semantic frontier and end the turn before quality-critical work; resume in a fresh turn after the primary route or exact required capability is restored.",
      reasonCodes: ["fallback_not_quality_equivalent", "quality_reduction_forbidden"],
      admitted: false,
      blockingFactors,
      missingRequiredTools,
    };
  }
  return {
    state: "HARD_EXTERNAL_BLOCKER",
    route: "none",
    workMayContinue: false,
    exactNextAction:
      "Stop the dependent lane and preserve the current causal frontier; no safe primary repair, quality-equivalent fallback, or safe turn-landing route is available.",
    reasonCodes: ["primary_recovery_exhausted", "no_safe_continuation_route"],
    admitted: false,
    blockingFactors,
    missingRequiredTools,
  };
}

export function assessMcpPrimaryRecovery(
  input: McpPrimaryRecoveryAssessmentInput,
): McpPrimaryRecoveryAssessment {
  const requiredCapabilityRefs = capabilityRefs(input.requiredCapabilityRefs);
  const stableRefs = new Set(input.stableCapabilityRefs ?? []);
  const registeredTools = new Set(input.primaryRegisteredToolNames);
  const clientCatalogAttested = input.clientObservedToolNames !== undefined;
  const callableTools = new Set([
    ...(input.knownCallableToolNames ?? []),
    ...(input.clientObservedToolNames ?? []),
  ]);
  const fallbackTools = new Set(input.fallback?.observedToolNames ?? []);
  const fallbackStableRefs = new Set(
    input.fallback?.stableCapabilityRefs ?? [],
  );
  const capabilities = requiredCapabilityRefs.map((capabilityRef) => {
    const definition = CAPABILITIES[capabilityRef];
    const stableSatisfied = stableProjectionSatisfied(
      definition,
      stableRefs,
      callableTools,
    );
    const missingServerTools = stableSatisfied
      ? []
      : definition.requiredTools.filter((tool) => !registeredTools.has(tool));
    const missingPrimaryTools = stableSatisfied
      ? []
      : definition.requiredTools.filter((tool) => !callableTools.has(tool));
    const fallbackStableSatisfied = stableProjectionSatisfied(
      definition,
      fallbackStableRefs,
      fallbackTools,
    );
    const missingFallbackTools = fallbackStableSatisfied
      ? []
      : definition.requiredTools.filter((tool) => !fallbackTools.has(tool));
    return {
      capabilityRef,
      requiredTools: [...definition.requiredTools],
      missingServerTools,
      missingPrimaryTools,
      stableProjectionSatisfied: stableSatisfied,
      qualityCritical: definition.qualityCritical,
      effectful: definition.effectful,
      fallbackEligible: definition.fallbackEligible,
      missingFallbackTools,
    } satisfies McpCapabilityRecoveryView;
  });
  const stableSatisfiedCapabilityRefs = capabilities
    .filter((view) => view.stableProjectionSatisfied)
    .map((view) => view.capabilityRef);
  const missingPrimaryTools = uniqueSorted(
    capabilities.flatMap((view) => view.missingPrimaryTools),
  );
  const missingRegisteredTools = uniqueSorted(
    capabilities.flatMap((view) => view.missingServerTools),
  );
  const recovery = input.recovery ?? {};
  const leaseState = recovery.recoveryLease ?? "unknown";
  const restartSafety = recovery.restartSafety ?? "unknown";
  const transportReconnect = routeAvailable(recovery.transportReconnect);
  const hostCatalogRefresh = routeAvailable(recovery.hostCatalogRefresh);
  const functionalRepair = routeAvailable(recovery.functionalRepair);
  const diagnosticAgent = routeAvailable(recovery.diagnosticAgent);

  let decision: {
    state: McpPrimaryRecoveryState;
    route: McpPrimaryRecoveryAssessment["route"];
    workMayContinue: boolean;
    exactNextAction: string;
    reasonCodes: string[];
    admitted: boolean;
    blockingFactors: string[];
    missingRequiredTools: string[];
  };

  if (
    input.primaryFunctionalState === "healthy"
    && input.activeRoute === "fallback"
    && input.catalogStatus === "CURRENT"
    && missingPrimaryTools.length === 0
  ) {
    decision = {
      state: "FAILBACK_PRIMARY",
      route: "primary",
      workMayContinue: true,
      exactNextAction:
        "Return this mission to the verified primary route and retain the fallback only as an independently healthy standby.",
      reasonCodes: ["primary_readiness_verified", "primary_catalog_current"],
      admitted: false,
      blockingFactors: [],
      missingRequiredTools: [],
    };
  } else if (
    input.catalogStatus === "STALE_SERVER"
    || missingRegisteredTools.length > 0
  ) {
    if (leaseState === "held_elsewhere") {
      decision = {
        state: "WAIT_FOR_RECOVERY_OWNER",
        route: "none",
        workMayContinue: false,
        exactNextAction:
          "Observe the single primary-recovery owner and do not dispatch a competing deployment, restart, rollback, or diagnostic effect.",
        reasonCodes: ["recovery_lease_held_elsewhere"],
        admitted: false,
        blockingFactors: ["primary_recovery_in_progress_elsewhere"],
        missingRequiredTools: [],
      };
    } else if (
      restartSafety === "safe"
      && functionalRepair !== "unavailable"
      && ["available", "held_by_current"].includes(leaseState)
      && attemptAvailable(
        recovery.functionalRepairAttempts,
        recovery.maxFunctionalRepairAttempts,
        1,
      )
    ) {
      decision = {
        state: "REPAIR_PRIMARY",
        route: "none",
        workMayContinue: false,
        exactNextAction:
          "Acquire or retain the single recovery lease, restore the exact verified primary build or registration state, then repeat functional and complete tool-surface attestations before work resumes.",
        reasonCodes: ["primary_server_surface_stale", "bounded_repair_safe"],
        admitted: false,
        blockingFactors: [],
        missingRequiredTools: [],
      };
    } else if (
      diagnosticAgent !== "unavailable"
      && attemptAvailable(
        recovery.diagnosticAttempts,
        recovery.maxDiagnosticAttempts,
        1,
      )
    ) {
      decision = {
        state: "DIAGNOSE_PRIMARY",
        route: "none",
        workMayContinue: false,
        exactNextAction:
          "Diagnose the stale server build or registration surface through the bounded recovery plane; catalog refresh cannot repair a capability absent from the primary server.",
        reasonCodes: ["primary_server_surface_stale", "server_repair_diagnosis_required"],
        admitted: false,
        blockingFactors: [],
        missingRequiredTools: [],
      };
    } else {
      decision = fallbackDecision(input, capabilities);
    }
  } else if (
    input.primaryFunctionalState !== "healthy"
  ) {
    if (leaseState === "held_elsewhere") {
      decision = {
        state: "WAIT_FOR_RECOVERY_OWNER",
        route: "none",
        workMayContinue: false,
        exactNextAction:
          "Observe the single primary-recovery owner and do not dispatch a competing reconnect, restart, rollback, or diagnostic effect.",
        reasonCodes: ["recovery_lease_held_elsewhere"],
        admitted: false,
        blockingFactors: ["primary_recovery_in_progress_elsewhere"],
        missingRequiredTools: [],
      };
    } else if (
      input.primaryFunctionalState === "degraded"
      && transportReconnect !== "unavailable"
      && attemptAvailable(
        recovery.reconnectAttempts,
        recovery.maxReconnectAttempts,
        2,
      )
    ) {
      decision = {
        state: "RECONNECT_PRIMARY",
        route: "none",
        workMayContinue: false,
        exactNextAction:
          "Run one bounded primary reconnect through the transport supervisor, then repeat the functional and catalog attestations before considering fallback.",
        reasonCodes: ["primary_transport_degraded", "bounded_reconnect_available"],
        admitted: false,
        blockingFactors: [],
        missingRequiredTools: [],
      };
    } else if (
      restartSafety === "safe"
      && functionalRepair !== "unavailable"
      && ["available", "held_by_current"].includes(leaseState)
      && attemptAvailable(
        recovery.functionalRepairAttempts,
        recovery.maxFunctionalRepairAttempts,
        1,
      )
    ) {
      decision = {
        state: "REPAIR_PRIMARY",
        route: "none",
        workMayContinue: false,
        exactNextAction:
          "Acquire or retain the single recovery lease, execute the bounded out-of-band primary repair, and require functional readiness plus stable post-repair probes before failback.",
        reasonCodes: ["primary_not_functional", "bounded_repair_safe"],
        admitted: false,
        blockingFactors: [],
        missingRequiredTools: [],
      };
    } else if (
      diagnosticAgent !== "unavailable"
      && attemptAvailable(
        recovery.diagnosticAttempts,
        recovery.maxDiagnosticAttempts,
        1,
      )
    ) {
      decision = {
        state: "DIAGNOSE_PRIMARY",
        route: "none",
        workMayContinue: false,
        exactNextAction:
          "Escalate the typed incident evidence to one bounded diagnostic recovery agent; it may propose or perform only repair classes admitted by the recovery envelope.",
        reasonCodes: [
          "deterministic_primary_repair_unavailable_or_unsafe",
          "agentic_diagnosis_available",
        ],
        admitted: false,
        blockingFactors: [],
        missingRequiredTools: [],
      };
    } else {
      decision = fallbackDecision(input, capabilities);
    }
  } else if (
    input.catalogStatus === "STALE_CLIENT"
    || missingPrimaryTools.length > 0
  ) {
    const allSatisfiedByStableProjection = capabilities.every(
      (view) => view.stableProjectionSatisfied,
    );
    if (allSatisfiedByStableProjection) {
      decision = {
        state: "USE_STABLE_CONTROL_PLANE",
        route: "stable_control_plane",
        workMayContinue: true,
        exactNextAction:
          "Use only the exact read-only stable control-plane projection for the required capability while catalog repair proceeds; do not infer availability of missing direct tools.",
        reasonCodes: ["required_capabilities_satisfied_by_stable_projection"],
        admitted: false,
        blockingFactors: [],
        missingRequiredTools: [],
      };
    } else if (
      hostCatalogRefresh !== "unavailable"
      && attemptAvailable(
        recovery.catalogRefreshAttempts,
        recovery.maxCatalogRefreshAttempts,
        1,
      )
    ) {
      decision = {
        state: "REFRESH_CLIENT_CATALOG",
        route: "none",
        workMayContinue: false,
        exactNextAction:
          "Refresh or reconnect the host MCP connector, attest the complete tools/list fingerprint and names, then reassess the exact mission capabilities before material work.",
        reasonCodes: ["client_catalog_stale_or_required_tools_missing"],
        admitted: false,
        blockingFactors: [],
        missingRequiredTools: [],
      };
    } else if (
      diagnosticAgent !== "unavailable"
      && attemptAvailable(
        recovery.diagnosticAttempts,
        recovery.maxDiagnosticAttempts,
        1,
      )
    ) {
      decision = {
        state: "DIAGNOSE_PRIMARY",
        route: "none",
        workMayContinue: false,
        exactNextAction:
          "Use the bounded host-recovery adapter to diagnose why catalog refresh is unavailable; do not substitute fallback work until the repair path is exhausted.",
        reasonCodes: ["catalog_refresh_unavailable", "host_diagnosis_required"],
        admitted: false,
        blockingFactors: [],
        missingRequiredTools: [],
      };
    } else {
      decision = fallbackDecision(input, capabilities);
    }
  } else if (
    input.activeRoute === "fallback"
    && input.catalogStatus !== "CURRENT"
  ) {
    if (!clientCatalogAttested) {
      decision = {
        state: "ATTEST_CLIENT_CATALOG",
        route: "none",
        workMayContinue: false,
        exactNextAction:
          "Attest the complete client-visible primary catalog before failback; functional readiness alone does not prove that the mission capability subset is callable.",
        reasonCodes: ["primary_failback_catalog_unattested"],
        admitted: false,
        blockingFactors: [],
        missingRequiredTools: [],
      };
    } else if (
      hostCatalogRefresh !== "unavailable"
      && attemptAvailable(
        recovery.catalogRefreshAttempts,
        recovery.maxCatalogRefreshAttempts,
        1,
      )
    ) {
      decision = {
        state: "REFRESH_CLIENT_CATALOG",
        route: "none",
        workMayContinue: false,
        exactNextAction:
          "Refresh or reconnect the host catalog and obtain a current complete attestation before failback from the fallback route.",
        reasonCodes: ["primary_failback_catalog_indeterminate"],
        admitted: false,
        blockingFactors: [],
        missingRequiredTools: [],
      };
    } else if (
      diagnosticAgent !== "unavailable"
      && attemptAvailable(
        recovery.diagnosticAttempts,
        recovery.maxDiagnosticAttempts,
        1,
      )
    ) {
      decision = {
        state: "DIAGNOSE_PRIMARY",
        route: "none",
        workMayContinue: false,
        exactNextAction:
          "Diagnose why the primary catalog remains indeterminate after functional recovery; do not fail back or continue fallback work implicitly.",
        reasonCodes: ["primary_failback_catalog_recovery_exhausted"],
        admitted: false,
        blockingFactors: [],
        missingRequiredTools: [],
      };
    } else {
      decision = fallbackDecision(input, capabilities);
    }
  } else if (
    !clientCatalogAttested
    && requiredCapabilityRefs.some((ref) => ref !== "bootstrap")
  ) {
    decision = {
      state: "ATTEST_CLIENT_CATALOG",
      route: "none",
      workMayContinue: false,
      exactNextAction:
        "Attest the client-observed complete tools/list fingerprint and tool names through the stable bootstrap before capability-critical work.",
      reasonCodes: ["client_catalog_unobserved_for_capability_critical_work"],
      admitted: false,
      blockingFactors: [],
      missingRequiredTools: [],
    };
  } else {
    decision = {
      state: "CONTINUE_PRIMARY",
      route: "primary",
      workMayContinue: true,
      exactNextAction:
        "Continue through the primary route; retain bounded transport supervision and reassess after any catalog, backend-generation, or functional-readiness change.",
      reasonCodes: clientCatalogAttested
        ? ["primary_functional", "required_capabilities_available"]
        : ["primary_functional", "bootstrap_callable_catalog_unattested"],
      admitted: false,
      blockingFactors: [],
      missingRequiredTools: [],
    };
  }

  const fallback = input.fallback;
  const fallbackMissingRequiredTools = decision.missingRequiredTools.length > 0
    ? decision.missingRequiredTools
    : uniqueSorted(capabilities.flatMap((view) => view.missingFallbackTools));
  const primaryRepairRequired = [
    "RECONNECT_PRIMARY",
    "REPAIR_PRIMARY",
    "DIAGNOSE_PRIMARY",
    "WAIT_FOR_RECOVERY_OWNER",
  ].includes(decision.state);
  const clientCatalogRepairRequired = [
    "ATTEST_CLIENT_CATALOG",
    "REFRESH_CLIENT_CATALOG",
  ].includes(decision.state)
    || input.catalogStatus === "STALE_CLIENT";

  return {
    schemaVersion: MCP_PRIMARY_RECOVERY_ASSESSMENT_SCHEMA,
    capabilityRef: MCP_PRIMARY_RECOVERY_CAPABILITY_REF,
    state: decision.state,
    route: decision.route,
    workMayContinue: decision.workMayContinue,
    primaryRepairRequired,
    clientCatalogRepairRequired,
    exactNextAction: decision.exactNextAction,
    reasonCodes: uniqueSorted(decision.reasonCodes),
    requiredCapabilityRefs,
    capabilities,
    primary: {
      functionalState: input.primaryFunctionalState,
      catalogStatus: input.catalogStatus,
      clientCatalogAttested,
      missingRegisteredTools,
      missingRequiredTools: missingPrimaryTools,
      stableSatisfiedCapabilityRefs,
    },
    recovery: {
      leaseState,
      restartSafety,
      transportReconnect,
      hostCatalogRefresh,
      functionalRepair,
      diagnosticAgent,
    },
    fallback: {
      available: fallback?.available ?? false,
      admitted: decision.admitted,
      qualityEquivalentAttested:
        fallback?.qualityEquivalentAttested ?? false,
      ...(/^[a-f0-9]{64}$/.test(fallback?.observedFingerprintSha256 ?? "")
        ? { observedFingerprintSha256: fallback?.observedFingerprintSha256 }
        : {}),
      qualityEvidenceRefs: uniqueSorted(
        (fallback?.qualityEvidenceRefs ?? [])
          .map((ref) => ref.trim())
          .filter(Boolean),
      ),
      ...(fallback?.policyRef ? { policyRef: fallback.policyRef } : {}),
      missingRequiredTools: fallbackMissingRequiredTools,
      blockingFactors: decision.blockingFactors,
    },
    policy: {
      primaryRepairBeforeFallback: true,
      fallbackIsLastResort: true,
      fallbackRequiresTypedQualityEquivalence: true,
      fallbackRequiresSurfaceFingerprintAndEvidence: true,
      effectfulFallbackImplicitlyDenied: true,
      safeTurnLandingPreferredToQualityReduction: true,
      oneRecoveryOwnerRequired: true,
      qualityReductionAuthorized: false,
      canonicalTaskDecisionWriterEffectOrPublicationAuthorityGranted: false,
    },
  };
}

export function assessMcpPrimaryReadiness(
  input: McpPrimaryReadinessInput,
): McpPrimaryReadiness {
  const reasonCodes: string[] = [];
  if (input.databaseState !== "ready") reasonCodes.push("database_sentinel_failed");
  if (!input.toolSurfaceInitialized || input.toolCount < 1) {
    reasonCodes.push("tool_surface_uninitialized");
  }
  const restartReasonCodes: string[] = [];
  if (input.activeToolCount > 0) restartReasonCodes.push("active_mcp_tools");
  if (input.runningProcessCount > 0) restartReasonCodes.push("running_workspace_processes");
  if ((input.serviceChildProcessObservationState ?? "unavailable") !== "observed") {
    restartReasonCodes.push("service_child_process_state_unobserved");
  } else if ((input.activeServiceChildProcessCount ?? 0) > 0) {
    restartReasonCodes.push("active_service_child_processes");
  }
  const ok = reasonCodes.length === 0;
  return {
    schemaVersion: MCP_PRIMARY_READINESS_SCHEMA,
    ok,
    state: ok ? "READY" : "NOT_READY",
    reasonCodes,
    database: {
      state: input.databaseState,
      ...(input.latestMigrationVersion === undefined
        ? {}
        : { latestMigrationVersion: input.latestMigrationVersion }),
      ...(input.executionScopeCount === undefined
        ? {}
        : { executionScopeCount: input.executionScopeCount }),
      ...(input.databaseErrorKind
        ? { errorKind: input.databaseErrorKind }
        : {}),
      ...(input.databaseErrorDigestSha256
        ? { errorDigestSha256: input.databaseErrorDigestSha256 }
        : {}),
    },
    toolSurface: {
      initialized: input.toolSurfaceInitialized,
      toolCount: input.toolCount,
    },
    activity: {
      activeToolCount: input.activeToolCount,
      runningProcessCount: input.runningProcessCount,
      serviceChildProcessObservationState:
        input.serviceChildProcessObservationState ?? "unavailable",
      activeServiceChildProcessCount:
        input.activeServiceChildProcessCount ?? 0,
    },
    restartSafety: {
      state: restartReasonCodes.length === 0 ? "safe" : "defer",
      reasonCodes: restartReasonCodes,
    },
    policy: {
      livenessIsNotReadiness: true,
      sameProcessDatabaseSentinel: true,
      restartRequiresNoActiveToolProcessOrServiceChild: true,
      readinessGrantsNoDeploymentOrEffectAuthority: true,
    },
  };
}
