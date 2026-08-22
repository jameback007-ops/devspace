import {
  assessFallbackContinuityFromPrimaryRecovery,
  createFallbackOperationContractDigest,
  DEFAULT_PRIMARY_REPAIR_AUTHORITIES,
  DEFAULT_PRIMARY_REPAIR_CAPABILITIES,
  FALLBACK_ROUTE_ATTESTATION_SCHEMA,
  FALLBACK_SELECTION_SCHEMA,
  type ContinuityAttestationState,
  type ExplicitFallbackSelection,
  type FallbackContinuityDecision,
  type FallbackRouteAttestation,
} from "./fallback-continuity-plane.js";
import type { McpPrimaryRecoveryAssessment } from "./mcp-primary-recovery.js";

export const MCP_FALLBACK_RECOVERY_PROJECTION_SCHEMA =
  "devspace.mcp-fallback-recovery-projection.v1" as const;
export const MCP_FALLBACK_RECOVERY_PROJECTION_CAPABILITY_REF =
  "devspace.mcp-fallback-recovery-projection.v1" as const;

export const LEGACY_PRIMARY_REPAIR_REQUIRED_TOOLS = [
  "open_workspace",
  "read",
  "apply_patch",
  "exec_command",
  "write_stdin",
] as const;

export const LEGACY_PRIMARY_REPAIR_OPTIONAL_TOOLS = [
  "download_artifact",
] as const;

export interface HostFallbackRecoveryObservation {
  routeRef?: string;
  routeKind?: "legacy" | "continuity" | "other";
  routeReachable?: boolean;
  observedToolNames?: readonly string[];
  observedFingerprintSha256?: string;
  fingerprintBasis?: string;
  attestationState?: ContinuityAttestationState;
  attestationRef?: string;
  policyRef?: string;
  stateIsolationEvidenceRef?: string;
  authorityIsolationEvidenceRef?: string;
  failureDomainEvidenceRef?: string;
  recoveryAuthorityRef?: string;
  failbackProbeEvidenceRef?: string;
  selectionRef?: string;
}

export interface McpFallbackRecoveryProjectionInput {
  assessedAt: string;
  primaryRecovery: McpPrimaryRecoveryAssessment;
  primaryRouteRef: string;
  primaryAttestationRef: string;
  primaryAttestationState: ContinuityAttestationState;
  primarySurfaceEpoch?: string;
  primaryFingerprintSha256?: string;
  primaryRecoveryEvidenceRef?: string;
  fallback?: HostFallbackRecoveryObservation;
}

export interface McpFallbackRecoveryProjection {
  schemaVersion: typeof MCP_FALLBACK_RECOVERY_PROJECTION_SCHEMA;
  capabilityRef: typeof MCP_FALLBACK_RECOVERY_PROJECTION_CAPABILITY_REF;
  state:
    | "PRIMARY_ROUTE"
    | "FAILBACK_PRIMARY"
    | "PRIMARY_RECOVERY_OWNS_NEXT_STEP"
    | "RECOVERY_ROUTE_SELECTION_REQUIRED"
    | "RECOVERY_ROUTE_SELECTED"
    | "RECOVERY_ROUTE_INCOMPLETE"
    | "NO_RECOVERY_ROUTE_OBSERVED"
    | "EXTERNAL_PLATFORM_BOUNDARY";
  routeObservation: {
    state:
      | "unobserved"
      | "observed_unreachable"
      | "observed_reachable_incomplete"
      | "observed_recovery_ready";
    routeRef: string;
    routeKind: "legacy" | "continuity" | "other";
    observedToolNames: string[];
    requiredRepairTools: string[];
    optionalRepairTools: string[];
    missingRepairTools: string[];
    nexusBootstrapToolPresent: boolean;
    nexusBootstrapToolRequiredForRepair: false;
    recoveryCapabilities: string[];
    recoveryAuthorities: string[];
    hostMediatedDispatchRequired: true;
    primaryCanInvokeSiblingConnector: false;
    callerEvidenceVerifiedByServer: false;
    repairInvocationAuthorized: false;
  };
  selection: {
    operationClass: "recovery_route_selection";
    operationRef: string;
    state:
      | "primary_route"
      | "failback_primary"
      | "not_observed"
      | "route_incomplete"
      | "selection_required"
      | "selected";
    selectedRouteRef?: string;
    repairInvocationAuthorized: false;
    repairEffectGateRequiredBeforeMutation: true;
    callerEvidenceVerifiedByServer: false;
  };
  decision: FallbackContinuityDecision;
  exactNextAction: string;
  remainingExternalLimitations: string[];
  policy: {
    primaryRepairBeforeMissionFallback: true;
    legacyMayBeRecoveryEligibleWithoutFullNexusAbi: true;
    recoveryOnlyRouteRequiresNoMissionQualityEquivalence: true;
    recoveryOnlyRouteGrantsNoMissionAuthority: true;
    recoveryEffectsRequireSeparateEffectGate: true;
    recoveryRouteSelectionAuthorizesRepairEffect: false;
    sourceRepairRequiresApplyPatch: true;
    callerEvidenceRefsVerifiedByServer: false;
    primaryFailbackRequiredBeforeMissionWork: true;
    siblingConnectorInvocationIsHostBound: true;
    routeInvocationPerformed: false;
    canonicalTaskDecisionWriterEffectPublicationOrMemoryAuthorityGranted: false;
  };
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

function recoveryCapabilities(tools: Set<string>): string[] {
  const capabilities: string[] = [];
  if (tools.has("open_workspace") && tools.has("read")) {
    capabilities.push("continuity.primary.inspect");
  }
  if (
    tools.has("apply_patch")
    && tools.has("exec_command")
    && tools.has("write_stdin")
  ) {
    capabilities.push("continuity.primary.repair");
  }
  if (tools.has("read") && tools.has("exec_command")) {
    capabilities.push("continuity.primary.verify");
  }
  return uniqueSorted(capabilities);
}

function validSha256(value: string | undefined): value is string {
  return /^[a-f0-9]{64}$/.test(value ?? "");
}

function routeReady(
  fallback: HostFallbackRecoveryObservation | undefined,
  missingRepairTools: string[],
  capabilities: string[],
  authorities: string[],
): boolean {
  return fallback?.routeReachable === true
    && missingRepairTools.length === 0
    && DEFAULT_PRIMARY_REPAIR_CAPABILITIES.every(
      (capability) => capabilities.includes(capability),
    )
    && DEFAULT_PRIMARY_REPAIR_AUTHORITIES.every(
      (authority) => authorities.includes(authority),
    )
    && fallback.attestationState === "verified"
    && Boolean(fallback.attestationRef)
    && Boolean(fallback.policyRef)
    && validSha256(fallback.observedFingerprintSha256)
    && Boolean(fallback.stateIsolationEvidenceRef)
    && Boolean(fallback.authorityIsolationEvidenceRef)
    && Boolean(fallback.failureDomainEvidenceRef)
    && Boolean(fallback.failbackProbeEvidenceRef);
}

function buildRoute(
  fallback: HostFallbackRecoveryObservation | undefined,
  routeRef: string,
  routeKind: "legacy" | "continuity" | "other",
  tools: string[],
  capabilities: string[],
  authorities: string[],
  ready: boolean,
): FallbackRouteAttestation {
  return {
    schemaVersion: FALLBACK_ROUTE_ATTESTATION_SCHEMA,
    routeRef,
    routeKind,
    functionalState: fallback?.routeReachable === true
      ? "healthy"
      : fallback?.routeReachable === false
        ? "unavailable"
        : "unknown",
    attestationState: fallback?.attestationState ?? "unverified",
    qualityClass: ready ? "recovery_only" : "insufficient",
    catalogFreshness: tools.length > 0 ? "fresh" : "unknown",
    capabilities,
    authorityClasses: authorities,
    attestationRef: fallback?.attestationRef,
    policyRef: fallback?.policyRef,
    fingerprintBasis:
      fallback?.fingerprintBasis
      ?? "canonical_complete_mcp_tools_list_descriptors",
    fingerprintSha256:
      fallback?.observedFingerprintSha256
      ?? "0".repeat(64),
    stateIsolationEvidenceRef: fallback?.stateIsolationEvidenceRef,
    authorityIsolationEvidenceRef: fallback?.authorityIsolationEvidenceRef,
    failureDomainEvidenceRef: fallback?.failureDomainEvidenceRef,
    failbackProbeEvidenceRef: fallback?.failbackProbeEvidenceRef,
    supportsPrimaryRepair: ready,
    supportsStatePreservation: false,
    supportsCheckpoint: false,
    supportsSafeLanding: false,
    limitationCodes: uniqueSorted([
      "host_mediated_dispatch_only",
      "no_mission_authority",
      "no_effect_replay_authority",
      ...(!tools.includes("execution_scope_status")
        ? ["no_nexus_execution_scope_status"]
        : []),
      ...(!tools.includes("download_artifact")
        ? ["artifact_transfer_unavailable"]
        : []),
    ]),
  };
}

function buildSelection(
  fallback: HostFallbackRecoveryObservation | undefined,
  route: FallbackRouteAttestation,
  operationRef: string,
): ExplicitFallbackSelection | undefined {
  if (!fallback?.selectionRef || !route.policyRef) return undefined;
  return {
    schemaVersion: FALLBACK_SELECTION_SCHEMA,
    operationRef,
    operationContractDigestSha256: createFallbackOperationContractDigest({
      operationRef,
      intent: "recovery",
      safety: "read_only",
      requiredCapabilities: [],
      requiredAuthorityClasses: [],
    }),
    routeRef: route.routeRef,
    policyRef: route.policyRef,
    fingerprintBasis: route.fingerprintBasis,
    fingerprintSha256: route.fingerprintSha256,
    attestationState: route.attestationState,
    selectionRef: fallback.selectionRef,
  };
}

function projectionState(
  decision: FallbackContinuityDecision,
  routeState: McpFallbackRecoveryProjection["routeObservation"]["state"],
): McpFallbackRecoveryProjection["state"] {
  switch (decision.disposition) {
    case "use_primary":
      return "PRIMARY_ROUTE";
    case "failback_to_primary":
      return "FAILBACK_PRIMARY";
    case "repair_primary":
      return decision.selectedRouteRef
        ? "RECOVERY_ROUTE_SELECTED"
        : "PRIMARY_RECOVERY_OWNS_NEXT_STEP";
    case "fallback_selection_required":
      return "RECOVERY_ROUTE_SELECTION_REQUIRED";
    case "use_recovery_only_fallback":
      return "RECOVERY_ROUTE_SELECTED";
    case "hard_block":
      return routeState === "unobserved"
        ? "NO_RECOVERY_ROUTE_OBSERVED"
        : routeState === "observed_reachable_incomplete"
          ? "RECOVERY_ROUTE_INCOMPLETE"
          : "EXTERNAL_PLATFORM_BOUNDARY";
    default:
      return routeState === "observed_recovery_ready"
        ? "RECOVERY_ROUTE_SELECTION_REQUIRED"
        : "RECOVERY_ROUTE_INCOMPLETE";
  }
}

export function projectMcpFallbackRecovery(
  input: McpFallbackRecoveryProjectionInput,
): McpFallbackRecoveryProjection {
  const fallback = input.fallback;
  const routeRef = fallback?.routeRef ?? "route:host:fallback";
  const routeKind = fallback?.routeKind ?? "legacy";
  const tools = uniqueSorted(fallback?.observedToolNames ?? []);
  const toolSet = new Set(tools);
  const missingRepairTools = LEGACY_PRIMARY_REPAIR_REQUIRED_TOOLS.filter(
    (tool) => !toolSet.has(tool),
  );
  const capabilities = recoveryCapabilities(toolSet);
  const authorities = fallback?.recoveryAuthorityRef
    ? [...DEFAULT_PRIMARY_REPAIR_AUTHORITIES]
    : [];
  const ready = routeReady(
    fallback,
    missingRepairTools,
    capabilities,
    authorities,
  );
  const routeState: McpFallbackRecoveryProjection["routeObservation"]["state"] =
    fallback?.routeReachable === undefined
      ? "unobserved"
      : fallback.routeReachable === false
        ? "observed_unreachable"
        : ready
          ? "observed_recovery_ready"
          : "observed_reachable_incomplete";
  const route = buildRoute(
    fallback,
    routeRef,
    routeKind,
    tools,
    capabilities,
    authorities,
    ready,
  );
  // This assessment selects a host route; it does not execute or authorize a
  // repair effect. Keeping the operation class explicit prevents the
  // read-only selection projection from being mistaken for mutation authority.
  const operationRef = "operation:devspace:primary-recovery-route-selection";
  const selectedFallback = buildSelection(
    fallback,
    route,
    operationRef,
  );
  const decision = assessFallbackContinuityFromPrimaryRecovery({
    operationRef,
    observedAt: input.assessedAt,
    intent: "recovery",
    safety: "read_only",
    requiredCapabilities: [],
    requiredAuthorityClasses: [],
    primaryRecovery: input.primaryRecovery,
    primaryRouteRef: input.primaryRouteRef,
    primaryAttestationRef: input.primaryAttestationRef,
    primaryAttestationState: input.primaryAttestationState,
    primaryAuthorityClasses: [],
    primarySurfaceEpoch: input.primarySurfaceEpoch,
    primaryFingerprintSha256: input.primaryFingerprintSha256,
    primaryRecoveryEvidenceRef: input.primaryRecoveryEvidenceRef,
    fallbackRoutes: fallback === undefined ? [] : [route],
    selectedFallback,
  });
  const state = projectionState(decision, routeState);
  const selectionState: McpFallbackRecoveryProjection["selection"]["state"] =
    state === "PRIMARY_ROUTE"
      ? "primary_route"
      : state === "FAILBACK_PRIMARY"
        ? "failback_primary"
        : routeState === "unobserved"
          ? "not_observed"
          : routeState !== "observed_recovery_ready"
            ? "route_incomplete"
            : state === "RECOVERY_ROUTE_SELECTED"
              ? "selected"
              : "selection_required";
  const remainingExternalLimitations = uniqueSorted([
    "primary_mcp_cannot_invoke_a_sibling_host_connector",
    "chatgpt_host_catalog_refresh_cannot_be_forced_by_the_server",
    ...(routeState === "observed_recovery_ready"
      ? []
      : ["independent_recovery_route_attestation_incomplete"]),
  ]);
  const exactNextAction = state === "RECOVERY_ROUTE_SELECTED"
    ? "The recovery-only host route is selected as a candidate, but no repair invocation is authorized by this projection. Before any source or runtime mutation, acquire a separate recovery effect gate bound to the exact repair plan and effect identity; then verify Nexus functional readiness and exact surface, repair or attest the host catalog where the host permits it, and obtain FAILBACK_PRIMARY before normal mission work."
    : state === "RECOVERY_ROUTE_SELECTION_REQUIRED"
      ? "Record one operation-scoped recovery-route selection bound to the exact route policy and fingerprint; no mission fallback or effect replay is authorized."
      : state === "FAILBACK_PRIMARY"
        ? "Route subsequent work back to the verified primary Nexus surface and retire the temporary recovery-only selection."
        : decision.exactNextAction;
  return {
    schemaVersion: MCP_FALLBACK_RECOVERY_PROJECTION_SCHEMA,
    capabilityRef: MCP_FALLBACK_RECOVERY_PROJECTION_CAPABILITY_REF,
    state,
    routeObservation: {
      state: routeState,
      routeRef,
      routeKind,
      observedToolNames: tools,
      requiredRepairTools: [...LEGACY_PRIMARY_REPAIR_REQUIRED_TOOLS],
      optionalRepairTools: [...LEGACY_PRIMARY_REPAIR_OPTIONAL_TOOLS],
      missingRepairTools,
      nexusBootstrapToolPresent: toolSet.has("execution_scope_status"),
      nexusBootstrapToolRequiredForRepair: false,
      recoveryCapabilities: capabilities,
      recoveryAuthorities: authorities,
      hostMediatedDispatchRequired: true,
      primaryCanInvokeSiblingConnector: false,
      callerEvidenceVerifiedByServer: false,
      repairInvocationAuthorized: false,
    },
    selection: {
      operationClass: "recovery_route_selection",
      operationRef,
      state: selectionState,
      selectedRouteRef: decision.selectedRouteRef,
      repairInvocationAuthorized: false,
      repairEffectGateRequiredBeforeMutation: true,
      callerEvidenceVerifiedByServer: false,
    },
    decision,
    exactNextAction,
    remainingExternalLimitations,
    policy: {
      primaryRepairBeforeMissionFallback: true,
      legacyMayBeRecoveryEligibleWithoutFullNexusAbi: true,
      recoveryOnlyRouteRequiresNoMissionQualityEquivalence: true,
      recoveryOnlyRouteGrantsNoMissionAuthority: true,
      recoveryEffectsRequireSeparateEffectGate: true,
      recoveryRouteSelectionAuthorizesRepairEffect: false,
      sourceRepairRequiresApplyPatch: true,
      callerEvidenceRefsVerifiedByServer: false,
      primaryFailbackRequiredBeforeMissionWork: true,
      siblingConnectorInvocationIsHostBound: true,
      routeInvocationPerformed: false,
      canonicalTaskDecisionWriterEffectPublicationOrMemoryAuthorityGranted: false,
    },
  };
}
