import { createHash } from "node:crypto";
import type {
  McpPrimaryRecoveryAssessment,
  McpPrimaryRecoveryState,
  McpWorkCapabilityRef,
} from "./mcp-primary-recovery.js";

export const FALLBACK_CONTINUITY_ASSESSMENT_SCHEMA =
  "zes.fallback-continuity-assessment.v1" as const;
export const FALLBACK_OPERATION_CONTRACT_SCHEMA =
  "zes.fallback-operation-contract.v1" as const;
export const FALLBACK_ROUTE_ATTESTATION_SCHEMA =
  "zes.fallback-route-attestation.v1" as const;
export const FALLBACK_SELECTION_SCHEMA =
  "zes.fallback-selection.v1" as const;

export const FALLBACK_QUALITY_CLASSES = [
  "quality_equivalent",
  "degraded_read_only",
  "recovery_only",
  "survival_only",
  "insufficient",
] as const;

export type FallbackQualityClass =
  (typeof FALLBACK_QUALITY_CLASSES)[number];

export const FALLBACK_CONTINUITY_INTENTS = [
  "ordinary_read",
  "research",
  "validation",
  "source_mutation",
  "repository_publication",
  "runtime_effect",
  "conversation_effect",
  "recovery",
  "safe_landing",
] as const;

export type FallbackContinuityIntent =
  (typeof FALLBACK_CONTINUITY_INTENTS)[number];

export type FallbackOperationSafety =
  | "read_only"
  | "idempotent_effect"
  | "non_idempotent_effect";

export type PrimaryRouteState =
  | "healthy"
  | "degraded"
  | "unavailable"
  | "unknown"
  | "outcome_indeterminate";

export type PrimaryRecoveryState =
  | "not_needed"
  | "not_attempted"
  | "required"
  | "in_progress"
  | "verified_recovered"
  | "exhausted"
  | "blocked";

export type ContinuityCatalogFreshness = "fresh" | "stale" | "unknown";

export type ContinuityAttestationState =
  | "verified"
  | "unverified"
  | "expired";

export type ContinuityEffectOutcome =
  | "not_started"
  | "terminal_succeeded"
  | "terminal_failed"
  | "indeterminate";

export const DEFAULT_PRIMARY_REPAIR_CAPABILITIES = [
  "continuity.primary.inspect",
  "continuity.primary.repair",
  "continuity.primary.verify",
] as const;

export const DEFAULT_PRIMARY_REPAIR_AUTHORITIES = [
  "continuity.recovery.execute",
] as const;

export const DEFAULT_SAFE_LANDING_CAPABILITIES = [
  "continuity.state.preserve",
  "continuity.checkpoint.record",
  "continuity.turn.safe_land",
] as const;

export const DEFAULT_SAFE_LANDING_AUTHORITIES = [
  "continuity.executor_local.preserve",
] as const;

export interface FallbackQualityRequirements {
  requiresFreshCatalog?: boolean;
  freshEvidenceRequired?: boolean;
  validationReadbackRequired?: boolean;
  canonicalStateRequired?: boolean;
  effectTransportRequired?: boolean;
}

export interface PrimaryRouteObservation {
  routeRef: string;
  state: PrimaryRouteState;
  recoveryState: PrimaryRecoveryState;
  recoveryDirectiveCode?: string;
  attestationState: ContinuityAttestationState;
  catalogFreshness: ContinuityCatalogFreshness;
  capabilities: readonly string[];
  authorityClasses: readonly string[];
  attestationRef: string;
  surfaceEpoch?: string;
  fingerprintSha256?: string;
  freshnessEvidenceRefs?: readonly string[];
  validationEvidenceRefs?: readonly string[];
  canonicalStateEvidenceRef?: string;
  effectAuthorityRef?: string;
  effectReconciliationRef?: string;
  recoveryEvidenceRef?: string;
  repairRequiredCapabilities?: readonly string[];
  repairRequiredAuthorityClasses?: readonly string[];
}

export interface FallbackRouteAttestation {
  schemaVersion: typeof FALLBACK_ROUTE_ATTESTATION_SCHEMA;
  routeRef: string;
  routeKind: "legacy" | "continuity" | "other";
  functionalState: "healthy" | "degraded" | "unavailable" | "unknown";
  attestationState: ContinuityAttestationState;
  qualityClass: FallbackQualityClass;
  catalogFreshness: ContinuityCatalogFreshness;
  capabilities: readonly string[];
  authorityClasses: readonly string[];
  attestationRef?: string;
  policyRef?: string;
  surfaceEpoch?: string;
  fingerprintBasis: string;
  fingerprintSha256: string;
  qualityEquivalenceEvidenceRef?: string;
  freshnessEvidenceRefs?: readonly string[];
  validationEvidenceRefs?: readonly string[];
  canonicalStateEvidenceRef?: string;
  stateIsolationEvidenceRef?: string;
  authorityIsolationEvidenceRef?: string;
  failureDomainEvidenceRef?: string;
  effectAuthorityRef?: string;
  effectReconciliationRef?: string;
  supportsPrimaryRepair?: boolean;
  supportsStatePreservation?: boolean;
  supportsCheckpoint?: boolean;
  supportsSafeLanding?: boolean;
  failbackProbeEvidenceRef?: string;
  limitationCodes?: readonly string[];
}

export interface ExplicitFallbackSelection {
  schemaVersion: typeof FALLBACK_SELECTION_SCHEMA;
  operationRef: string;
  operationContractDigestSha256: string;
  routeRef: string;
  policyRef: string;
  fingerprintBasis: string;
  fingerprintSha256: string;
  attestationState: ContinuityAttestationState;
  selectionRef: string;
}

export interface ContinuityEffectObservation {
  effectKey: string;
  outcome: ContinuityEffectOutcome;
  outcomeEvidenceRef?: string;
  authoritativeReconciliationRef?: string;
  explicitFallbackAuthorizationRef?: string;
  explicitFallbackAuthorizationState?: ContinuityAttestationState;
}

export interface FallbackContinuityRequest {
  operationRef: string;
  observedAt: string;
  intent: FallbackContinuityIntent;
  safety: FallbackOperationSafety;
  requiredCapabilities: readonly string[];
  requiredAuthorityClasses: readonly string[];
  quality?: FallbackQualityRequirements;
  primary: PrimaryRouteObservation;
  fallbackRoutes: readonly FallbackRouteAttestation[];
  selectedFallback?: ExplicitFallbackSelection;
  safeLandingRequiredCapabilities?: readonly string[];
  safeLandingRequiredAuthorityClasses?: readonly string[];
  effect?: ContinuityEffectObservation;
}

export interface FallbackOperationContractInput {
  operationRef: string;
  intent: FallbackContinuityIntent;
  safety: FallbackOperationSafety;
  requiredCapabilities: readonly string[];
  requiredAuthorityClasses: readonly string[];
  quality?: FallbackQualityRequirements;
  effect?: Pick<ContinuityEffectObservation, "effectKey">;
}

export interface FallbackContinuityFromPrimaryRecoveryInput
  extends Omit<FallbackContinuityRequest, "primary"> {
  primaryRecovery: McpPrimaryRecoveryAssessment;
  primaryRouteRef: string;
  primaryAttestationRef: string;
  primaryAttestationState: ContinuityAttestationState;
  primaryAuthorityClasses: readonly string[];
  primarySurfaceEpoch?: string;
  primaryFingerprintSha256?: string;
  primaryFreshnessEvidenceRefs?: readonly string[];
  primaryValidationEvidenceRefs?: readonly string[];
  primaryCanonicalStateEvidenceRef?: string;
  primaryEffectAuthorityRef?: string;
  primaryEffectReconciliationRef?: string;
  primaryRecoveryEvidenceRef?: string;
}

export type FallbackContinuityDisposition =
  | "use_primary"
  | "failback_to_primary"
  | "repair_primary"
  | "fallback_selection_required"
  | "use_quality_equivalent_fallback"
  | "use_degraded_read_only_fallback"
  | "use_recovery_only_fallback"
  | "safe_land"
  | "reconcile_effect"
  | "block_effect_lane"
  | "hard_block";

export interface FallbackRouteAssessment {
  routeRef: string;
  routeKind: FallbackRouteAttestation["routeKind"];
  functionalState: FallbackRouteAttestation["functionalState"];
  attestationState: ContinuityAttestationState;
  catalogFreshness: ContinuityCatalogFreshness;
  qualityClass: FallbackQualityClass;
  fingerprintBasis: string;
  fingerprintSha256: string;
  policyRef?: string;
  selected: boolean;
  missionEligible: boolean;
  repairEligible: boolean;
  survivalEligible: boolean;
  missingCapabilities: string[];
  missingAuthorityClasses: string[];
  limitationCodes: string[];
  reasonCodes: string[];
  evidenceRefs: string[];
}

export interface FallbackContinuityDecision {
  schemaVersion: typeof FALLBACK_CONTINUITY_ASSESSMENT_SCHEMA;
  decisionRef: string;
  operationRef: string;
  operationContractDigestSha256: string;
  assessedAt: string;
  disposition: FallbackContinuityDisposition;
  selectedRouteRef?: string;
  selectedPolicyRef?: string;
  selectedQualityClass?: FallbackQualityClass;
  selectionRequiredRouteRefs: string[];
  reasonCodes: string[];
  exactNextAction: string;
  claimCeiling: string;
  primary: {
    routeRef: string;
    state: PrimaryRouteState;
    recoveryState: PrimaryRecoveryState;
    recoveryDirectiveCode?: string;
    attestationState: ContinuityAttestationState;
    catalogFreshness: ContinuityCatalogFreshness;
    fingerprintSha256?: string;
    usable: boolean;
    missingCapabilities: string[];
    missingAuthorityClasses: string[];
    reasonCodes: string[];
  };
  consideredRoutes: FallbackRouteAssessment[];
  evidenceRefs: string[];
  policy: {
    primaryPreferred: true;
    repairBeforeFallback: true;
    missionFallbackRequiresExplicitSelection: true;
    qualityReductionAuthorized: false;
    canonicalAuthorityTransferred: false;
    primaryAndFallbackStateMayBeShared: false;
    effectReplayAuthorized: false;
    failbackRequiredWhenPrimaryRecovered: true;
    evidenceReferencesVerifiedByPlanner: false;
    routeInvocationPerformed: false;
    fallbackSelectionIsOperationScoped: true;
  };
}

interface NormalizedQualityRequirements {
  requiresFreshCatalog: boolean;
  freshEvidenceRequired: boolean;
  validationReadbackRequired: boolean;
  canonicalStateRequired: boolean;
  effectTransportRequired: boolean;
}

interface NormalizedPrimaryRouteObservation
  extends Omit<
    PrimaryRouteObservation,
    | "capabilities"
    | "authorityClasses"
    | "freshnessEvidenceRefs"
    | "validationEvidenceRefs"
    | "repairRequiredCapabilities"
    | "repairRequiredAuthorityClasses"
  > {
  capabilities: string[];
  authorityClasses: string[];
  freshnessEvidenceRefs: string[];
  validationEvidenceRefs: string[];
  repairRequiredCapabilities: string[];
  repairRequiredAuthorityClasses: string[];
}

interface NormalizedFallbackRouteAttestation
  extends Omit<
    FallbackRouteAttestation,
    | "capabilities"
    | "authorityClasses"
    | "freshnessEvidenceRefs"
    | "validationEvidenceRefs"
    | "limitationCodes"
  > {
  capabilities: string[];
  authorityClasses: string[];
  freshnessEvidenceRefs: string[];
  validationEvidenceRefs: string[];
  limitationCodes: string[];
}

interface NormalizedFallbackContinuityRequest
  extends Omit<
    FallbackContinuityRequest,
    | "requiredCapabilities"
    | "requiredAuthorityClasses"
    | "quality"
    | "primary"
    | "fallbackRoutes"
    | "safeLandingRequiredCapabilities"
    | "safeLandingRequiredAuthorityClasses"
  > {
  requiredCapabilities: string[];
  requiredAuthorityClasses: string[];
  quality: NormalizedQualityRequirements;
  primary: NormalizedPrimaryRouteObservation;
  fallbackRoutes: NormalizedFallbackRouteAttestation[];
  safeLandingRequiredCapabilities: string[];
  safeLandingRequiredAuthorityClasses: string[];
  operationContractDigestSha256: string;
}

interface PrimaryAssessment {
  usable: boolean;
  missingCapabilities: string[];
  missingAuthorityClasses: string[];
  reasonCodes: string[];
}

interface DecisionContext {
  input: NormalizedFallbackContinuityRequest;
  primary: PrimaryAssessment;
  consideredRoutes: FallbackRouteAssessment[];
  decisionRef: string;
}

interface DecisionOptions {
  disposition: FallbackContinuityDisposition;
  selectedRouteRef?: string;
  selectedPolicyRef?: string;
  selectedQualityClass?: FallbackQualityClass;
  selectionRequiredRouteRefs?: string[];
  reasonCodes: string[];
  exactNextAction: string;
  claimCeiling: string;
  evidenceRefs?: string[];
}

const QUALITY_RANK: Record<FallbackQualityClass, number> = {
  quality_equivalent: 0,
  degraded_read_only: 1,
  recovery_only: 2,
  survival_only: 3,
  insufficient: 4,
};

const QUALITY_CRITICAL_INTENTS = new Set<FallbackContinuityIntent>([
  "research",
  "validation",
  "source_mutation",
  "repository_publication",
  "runtime_effect",
  "conversation_effect",
]);

const EFFECT_INTENTS = new Set<FallbackContinuityIntent>([
  "source_mutation",
  "repository_publication",
  "runtime_effect",
  "conversation_effect",
]);

const POLICY = {
  primaryPreferred: true,
  repairBeforeFallback: true,
  missionFallbackRequiresExplicitSelection: true,
  qualityReductionAuthorized: false,
  canonicalAuthorityTransferred: false,
  primaryAndFallbackStateMayBeShared: false,
  effectReplayAuthorized: false,
  failbackRequiredWhenPrimaryRecovered: true,
  evidenceReferencesVerifiedByPlanner: false,
  routeInvocationPerformed: false,
  fallbackSelectionIsOperationScoped: true,
} as const;

export function mcpWorkCapabilityToken(
  capabilityRef: McpWorkCapabilityRef,
): string {
  return `mcp.work.${capabilityRef}`;
}

export function createFallbackOperationContractDigest(
  input: FallbackOperationContractInput,
): string {
  assertSafeReference(input.operationRef, "operationRef", 1_024);
  validateIntentAndSafety(input.intent, input.safety);
  if (input.safety !== "read_only" && !input.effect?.effectKey) {
    throw new Error("Effectful operation contract requires an exact effect key");
  }
  if (input.safety === "read_only" && input.effect) {
    throw new Error("Read-only operation contract must not include an effect key");
  }
  if (input.effect?.effectKey) {
    assertSafeReference(input.effect.effectKey, "effect.effectKey", 4_000);
  }
  return sha256(canonicalJson({
    schemaVersion: FALLBACK_OPERATION_CONTRACT_SCHEMA,
    operationRef: input.operationRef,
    intent: input.intent,
    safety: input.safety,
    requiredCapabilities: normalizeTokens(
      input.requiredCapabilities,
      "requiredCapabilities",
    ),
    requiredAuthorityClasses: normalizeTokens(
      input.requiredAuthorityClasses,
      "requiredAuthorityClasses",
    ),
    quality: normalizeQuality(input.intent, input.quality),
    effectKey: input.effect?.effectKey,
  }));
}

export function assessFallbackContinuityFromPrimaryRecovery(
  input: FallbackContinuityFromPrimaryRecoveryInput,
): FallbackContinuityDecision {
  const assessment = input.primaryRecovery;
  if (assessment.schemaVersion !== "zes.mcp-primary-recovery-assessment.v1") {
    throw new Error("Unsupported primary recovery assessment schema");
  }
  if (assessment.capabilityRef !== "zes.mcp-primary-recovery.v1") {
    throw new Error("Unsupported primary recovery capability reference");
  }
  const capabilities = assessment.capabilities
    .filter((view) => (
      view.missingPrimaryTools.length === 0
      || view.stableProjectionSatisfied
    ))
    .map((view) => mcpWorkCapabilityToken(view.capabilityRef));
  const {
    primaryRecovery: _primaryRecovery,
    primaryRouteRef,
    primaryAttestationRef,
    primaryAttestationState,
    primaryAuthorityClasses,
    primarySurfaceEpoch,
    primaryFingerprintSha256,
    primaryFreshnessEvidenceRefs,
    primaryValidationEvidenceRefs,
    primaryCanonicalStateEvidenceRef,
    primaryEffectAuthorityRef,
    primaryEffectReconciliationRef,
    primaryRecoveryEvidenceRef,
    ...request
  } = input;
  return assessFallbackContinuity({
    ...request,
    primary: {
      routeRef: primaryRouteRef,
      state: mapPrimaryFunctionalState(assessment),
      recoveryState: mapPrimaryRecoveryState(assessment.state),
      recoveryDirectiveCode:
        `mcp.primary_recovery.${assessment.state.toLowerCase()}`,
      attestationState: primaryAttestationState,
      catalogFreshness: mapCatalogFreshness(
        assessment.primary.catalogStatus,
      ),
      capabilities,
      authorityClasses: primaryAuthorityClasses,
      attestationRef: primaryAttestationRef,
      surfaceEpoch: primarySurfaceEpoch,
      fingerprintSha256: primaryFingerprintSha256,
      freshnessEvidenceRefs: primaryFreshnessEvidenceRefs,
      validationEvidenceRefs: primaryValidationEvidenceRefs,
      canonicalStateEvidenceRef: primaryCanonicalStateEvidenceRef,
      effectAuthorityRef: primaryEffectAuthorityRef,
      effectReconciliationRef: primaryEffectReconciliationRef,
      recoveryEvidenceRef: primaryRecoveryEvidenceRef,
    },
  });
}

export function assessFallbackContinuity(
  request: FallbackContinuityRequest,
): FallbackContinuityDecision {
  const input = normalizeRequest(request);
  const primary = assessPrimary(input);
  const consideredRoutes = input.fallbackRoutes
    .map((route) => assessRoute(input, route))
    .sort(compareRouteAssessments);
  const context: DecisionContext = {
    input,
    primary,
    consideredRoutes,
    decisionRef: `fallback-continuity:${sha256(canonicalJson({
      schemaVersion: FALLBACK_CONTINUITY_ASSESSMENT_SCHEMA,
      input,
    }))}`,
  };

  if (input.effect?.outcome === "indeterminate") {
    if (input.effect.authoritativeReconciliationRef) {
      return decision(context, {
        disposition: "reconcile_effect",
        reasonCodes: ["effect_outcome_indeterminate"],
        exactNextAction:
          "Read the authoritative reconciliation route for the exact effect key. Do not retry through the primary or any fallback until terminality or proven non-application is established.",
        claimCeiling:
          "Only the need for owner reconciliation is established; no effect outcome or retry authority is inferred.",
        evidenceRefs: [input.effect.authoritativeReconciliationRef],
      });
    }
    return decision(context, {
      disposition: "block_effect_lane",
      reasonCodes: [
        "effect_outcome_indeterminate",
        "authoritative_effect_reconciliation_missing",
      ],
      exactNextAction:
        "Freeze the exact effect lane and restore an authoritative reconciliation route. Preserve independent work, but do not retry or use a cross-route fallback for this effect.",
      claimCeiling:
        "Safe effect continuation is unavailable; success, failure, non-application, and retry authority remain unknown.",
    });
  }

  if (
    input.effect?.outcome === "terminal_succeeded"
    || input.effect?.outcome === "terminal_failed"
  ) {
    const succeeded = input.effect.outcome === "terminal_succeeded";
    return decision(context, {
      disposition: "block_effect_lane",
      reasonCodes: [
        succeeded
          ? "effect_already_terminal_succeeded"
          : "effect_already_terminal_failed",
      ],
      exactNextAction: succeeded
        ? "Use the terminal success receipt and continue from its resulting state. Do not replay the effect on another route."
        : "Preserve the terminal failure receipt. Any later attempt requires an owner-authorized distinct successor effect, not fallback replay.",
      claimCeiling:
        "The recorded terminal disposition is preserved and replay is forbidden; no successor effect is authorized.",
      evidenceRefs: input.effect.outcomeEvidenceRef
        ? [input.effect.outcomeEvidenceRef]
        : [],
    });
  }

  if (primary.usable) {
    const recovered = input.primary.recoveryState === "verified_recovered";
    return decision(context, {
      disposition: recovered ? "failback_to_primary" : "use_primary",
      selectedRouteRef: input.primary.routeRef,
      reasonCodes: [
        recovered ? "primary_recovery_verified" : "primary_route_healthy",
      ],
      exactNextAction: recovered
        ? "Route the next operation to the verified primary Nexus surface and retire the temporary fallback selection for this operation."
        : "Invoke the required operation on the primary Nexus route.",
      claimCeiling: recovered
        ? "Current primary and recovery attestations support deterministic failback for this operation only."
        : "The current primary attestation supports this exact operation; no fallback is selected.",
      evidenceRefs: primaryEvidenceRefs(input.primary),
    });
  }

  const repairCandidates = consideredRoutes.filter((route) => route.repairEligible);
  if (input.primary.recoveryState === "required") {
    return decision(context, {
      disposition: "repair_primary",
      reasonCodes: [
        "primary_recovery_required",
        ...(input.primary.recoveryDirectiveCode
          ? [input.primary.recoveryDirectiveCode]
          : []),
      ],
      exactNextAction:
        "Follow the authoritative primary-recovery directive and repeat primary readiness, catalog, capability, and authority attestations before considering mission fallback.",
      claimCeiling:
        "The upstream primary-recovery control plane still owns the next recovery step; no alternate repair or mission fallback route is selected.",
      evidenceRefs: input.primary.recoveryEvidenceRef
        ? [input.primary.recoveryEvidenceRef]
        : [],
    });
  }
  if (input.primary.recoveryState === "in_progress") {
    return decision(context, {
      disposition: "repair_primary",
      reasonCodes: ["primary_recovery_in_progress"],
      exactNextAction:
        "Allow the current bounded recovery owner to reach a terminal verified probe. Do not select or dispatch a second recovery route while that owner is active.",
      claimCeiling:
        "The plane preserves single-owner recovery and admits no competing repair or fallback effect.",
      evidenceRefs: input.primary.recoveryEvidenceRef
        ? [input.primary.recoveryEvidenceRef]
        : [],
    });
  }
  if (
    input.primary.recoveryState === "not_attempted"
    && repairCandidates.length > 0
  ) {
    const repairRoute = repairCandidates[0];
    const route = repairRoute === undefined
      ? undefined
      : routeByRef(input, repairRoute.routeRef);
    return decision(context, {
      disposition: "repair_primary",
      selectedRouteRef: repairRoute?.routeRef,
      selectedPolicyRef: route?.policyRef,
      selectedQualityClass: repairRoute?.qualityClass,
      reasonCodes: ["primary_repair_available"],
      exactNextAction:
        "Use the independently attested route only for bounded primary inspection, repair, and verification. Reassess and fail back before mission work.",
      claimCeiling:
        "The selected route is admitted only as a recovery plane; it cannot perform the original mission or acquire canonical authority.",
      evidenceRefs: repairRoute?.evidenceRefs ?? [],
    });
  }

  const survivalRoute = consideredRoutes.find((route) => route.survivalEligible);
  const selected = input.selectedFallback === undefined
    ? undefined
    : consideredRoutes.find(
        (route) => route.routeRef === input.selectedFallback?.routeRef,
      );

  if (input.selectedFallback) {
    if (!selected) {
      return safeLandOrHardBlock(context, survivalRoute, {
        reasonCodes: ["selected_fallback_route_not_attested"],
        exactNextAction:
          "Reject the unrecognized selection and refresh the bounded route attestations.",
      });
    }
    if (input.selectedFallback.operationRef !== input.operationRef) {
      return safeLandOrHardBlock(context, survivalRoute, {
        reasonCodes: ["selected_fallback_operation_mismatch"],
        exactNextAction:
          "Reject the selection because it was issued for a different logical operation. Record a new operation-scoped selection before invocation.",
      });
    }
    if (input.selectedFallback.attestationState !== "verified") {
      return safeLandOrHardBlock(context, survivalRoute, {
        reasonCodes: [
          `selected_fallback_attestation_state_${input.selectedFallback.attestationState}`,
        ],
        exactNextAction:
          "Reject the fallback selection until its operation-scoped authorization has a verified attestation state.",
      });
    }
    if (
      input.selectedFallback.operationContractDigestSha256
      !== input.operationContractDigestSha256
    ) {
      return safeLandOrHardBlock(context, survivalRoute, {
        reasonCodes: ["selected_fallback_operation_contract_mismatch"],
        exactNextAction:
          "Reject the selection because the operation capability, authority, quality, safety, or effect contract changed. Record a new selection bound to the current operation contract digest.",
      });
    }
    const route = routeByRef(input, selected.routeRef)!;
    if (route.policyRef !== input.selectedFallback.policyRef) {
      return safeLandOrHardBlock(context, survivalRoute, {
        reasonCodes: ["selected_fallback_policy_mismatch"],
        exactNextAction:
          "Reject the mismatched selection and bind the route to its exact attested policy reference.",
      });
    }
    if (route.fingerprintBasis !== input.selectedFallback.fingerprintBasis) {
      return safeLandOrHardBlock(context, survivalRoute, {
        reasonCodes: ["selected_fallback_fingerprint_basis_mismatch"],
        exactNextAction:
          "Reject the selection because its fingerprint basis differs from the current route attestation. Record a new selection from the exact canonical descriptor basis.",
      });
    }
    if (route.fingerprintSha256 !== input.selectedFallback.fingerprintSha256) {
      return safeLandOrHardBlock(context, survivalRoute, {
        reasonCodes: ["selected_fallback_fingerprint_mismatch"],
        exactNextAction:
          "Reject the stale selection and bind a new selection to the exact current route fingerprint before invocation.",
      });
    }
    if (!selected.missionEligible) {
      return safeLandOrHardBlock(context, survivalRoute, {
        reasonCodes: [
          "selected_fallback_not_eligible",
          ...selected.reasonCodes,
        ],
        exactNextAction:
          "Do not invoke the selected route. Obtain exact capability, authority, freshness, and quality evidence or preserve the frontier.",
      });
    }
    return selectedRouteDecision(context, selected, route);
  }

  const missionCandidates = consideredRoutes.filter(
    (route) => route.missionEligible,
  );
  if (missionCandidates.length > 0) {
    return decision(context, {
      disposition: "fallback_selection_required",
      selectionRequiredRouteRefs: missionCandidates.map((route) => route.routeRef),
      reasonCodes: ["explicit_fallback_selection_required"],
      exactNextAction:
        "Explicitly bind one eligible route to its exact policy and record a selection reference, then reassess. Availability alone does not authorize rerouting.",
      claimCeiling:
        "Eligible candidates are identified only; no route has been selected, invoked, or granted authority.",
      evidenceRefs: missionCandidates.flatMap((route) => route.evidenceRefs),
    });
  }

  return safeLandOrHardBlock(context, survivalRoute, {
    reasonCodes: ["no_mission_fallback_satisfies_requirements"],
    exactNextAction:
      "Preserve the exact causal frontier and do not continue through an unqualified route.",
  });
}

function selectedRouteDecision(
  context: DecisionContext,
  selected: FallbackRouteAssessment,
  route: NormalizedFallbackRouteAttestation,
): FallbackContinuityDecision {
  const evidenceRefs = selectedEvidenceRefs(context, selected);
  switch (selected.qualityClass) {
    case "quality_equivalent":
      return decision(context, {
        disposition: "use_quality_equivalent_fallback",
        selectedRouteRef: route.routeRef,
        selectedPolicyRef: route.policyRef,
        selectedQualityClass: route.qualityClass,
        reasonCodes: ["quality_equivalent_fallback_explicitly_selected"],
        exactNextAction:
          "Invoke only this exact operation through the selected quality-equivalent route under its attested policy. Probe and fail back to the primary after verified recovery.",
        claimCeiling:
          "Quality equivalence is admitted for this exact operation only. Canonical authority, writer ownership, and persistent state are not transferred.",
        evidenceRefs,
      });
    case "degraded_read_only":
      return decision(context, {
        disposition: "use_degraded_read_only_fallback",
        selectedRouteRef: route.routeRef,
        selectedPolicyRef: route.policyRef,
        selectedQualityClass: route.qualityClass,
        reasonCodes: ["degraded_read_only_fallback_explicitly_selected"],
        exactNextAction:
          "Use the selected route for this bounded read only. Do not convert its output into fresh research, validation, canonical mutation readiness, publication, or effect terminality.",
        claimCeiling:
          "Only the exact non-quality-critical read is supported; no research, validation, canonical-state, or effect claim is permitted.",
        evidenceRefs,
      });
    case "recovery_only":
      return decision(context, {
        disposition: "use_recovery_only_fallback",
        selectedRouteRef: route.routeRef,
        selectedPolicyRef: route.policyRef,
        selectedQualityClass: route.qualityClass,
        reasonCodes: ["recovery_only_fallback_explicitly_selected"],
        exactNextAction:
          "Use the selected route only for bounded inspection, repair, verification, or preservation. Reassess the primary before resuming mission work.",
        claimCeiling:
          "The route is a recovery plane only; it cannot perform normal mission work or acquire canonical authority.",
        evidenceRefs,
      });
    case "survival_only":
      return safeLandOrHardBlock(
        context,
        selected.survivalEligible ? selected : undefined,
        {
          reasonCodes: ["survival_only_route_selected"],
          exactNextAction:
            "Use the selected route to preserve state, record a checkpoint, and end the turn cleanly.",
        },
      );
    case "insufficient":
      return safeLandOrHardBlock(context, undefined, {
        reasonCodes: ["insufficient_route_selected"],
        exactNextAction:
          "Reject the insufficient route and preserve the current causal frontier.",
      });
  }
}

function selectedEvidenceRefs(
  context: DecisionContext,
  selected: FallbackRouteAssessment,
): string[] {
  return uniqueSorted([
    ...selected.evidenceRefs,
    context.input.selectedFallback?.selectionRef,
    context.input.effect?.explicitFallbackAuthorizationRef,
  ].filter((entry): entry is string => Boolean(entry)));
}

function decision(
  context: DecisionContext,
  options: DecisionOptions,
): FallbackContinuityDecision {
  return {
    schemaVersion: FALLBACK_CONTINUITY_ASSESSMENT_SCHEMA,
    decisionRef: context.decisionRef,
    operationRef: context.input.operationRef,
    operationContractDigestSha256:
      context.input.operationContractDigestSha256,
    assessedAt: context.input.observedAt,
    disposition: options.disposition,
    selectedRouteRef: options.selectedRouteRef,
    selectedPolicyRef: options.selectedPolicyRef,
    selectedQualityClass: options.selectedQualityClass,
    selectionRequiredRouteRefs: options.selectionRequiredRouteRefs ?? [],
    reasonCodes: uniqueSorted(options.reasonCodes),
    exactNextAction: options.exactNextAction,
    claimCeiling: options.claimCeiling,
    primary: {
      routeRef: context.input.primary.routeRef,
      state: context.input.primary.state,
      recoveryState: context.input.primary.recoveryState,
      recoveryDirectiveCode: context.input.primary.recoveryDirectiveCode,
      attestationState: context.input.primary.attestationState,
      catalogFreshness: context.input.primary.catalogFreshness,
      fingerprintSha256: context.input.primary.fingerprintSha256,
      usable: context.primary.usable,
      missingCapabilities: context.primary.missingCapabilities,
      missingAuthorityClasses: context.primary.missingAuthorityClasses,
      reasonCodes: context.primary.reasonCodes,
    },
    consideredRoutes: context.consideredRoutes,
    evidenceRefs: uniqueSorted(options.evidenceRefs ?? []),
    policy: POLICY,
  };
}

function safeLandOrHardBlock(
  context: DecisionContext,
  survivalRoute: FallbackRouteAssessment | undefined,
  options: {
    reasonCodes: string[];
    exactNextAction: string;
  },
): FallbackContinuityDecision {
  if (survivalRoute) {
    const route = routeByRef(context.input, survivalRoute.routeRef)!;
    return decision(context, {
      disposition: "safe_land",
      selectedRouteRef: route.routeRef,
      selectedPolicyRef: route.policyRef,
      selectedQualityClass: route.qualityClass,
      reasonCodes: [...options.reasonCodes, "survival_route_available"],
      exactNextAction:
        "Use the attested survival route only to preserve exact state, record a checkpoint, and end the turn. Do not continue the blocked mission lane.",
      claimCeiling:
        "Continuity preservation only is supported; mission completion, quality equivalence, validation, canonical authority, and effect terminality remain unclaimed.",
      evidenceRefs: survivalRoute.evidenceRefs,
    });
  }
  return decision(context, {
    disposition: "hard_block",
    reasonCodes: [...options.reasonCodes, "safe_landing_route_unavailable"],
    exactNextAction: options.exactNextAction,
    claimCeiling:
      "No attested route can safely continue or preserve this operation without lowering quality or authority guarantees.",
  });
}

function assessPrimary(
  input: NormalizedFallbackContinuityRequest,
): PrimaryAssessment {
  const missingCapabilities = difference(
    input.requiredCapabilities,
    input.primary.capabilities,
  );
  const missingAuthorityClasses = difference(
    input.requiredAuthorityClasses,
    input.primary.authorityClasses,
  );
  const reasonCodes: string[] = [];
  if (input.primary.state !== "healthy") {
    reasonCodes.push(`primary_state_${input.primary.state}`);
  }
  if (!input.primary.attestationRef) {
    reasonCodes.push("primary_attestation_missing");
  }
  if (input.primary.attestationState !== "verified") {
    reasonCodes.push(
      `primary_attestation_state_${input.primary.attestationState}`,
    );
  }
  if (
    input.primary.state === "healthy"
    && !input.primary.fingerprintSha256
  ) {
    reasonCodes.push("primary_fingerprint_missing");
  }
  if (
    input.quality.requiresFreshCatalog
    && input.primary.catalogFreshness !== "fresh"
  ) {
    reasonCodes.push("primary_catalog_not_fresh");
  }
  if (
    input.quality.freshEvidenceRequired
    && input.primary.freshnessEvidenceRefs.length === 0
  ) {
    reasonCodes.push("primary_fresh_evidence_unproven");
  }
  if (
    input.quality.validationReadbackRequired
    && input.primary.validationEvidenceRefs.length === 0
  ) {
    reasonCodes.push("primary_validation_readback_unproven");
  }
  if (
    input.quality.canonicalStateRequired
    && !input.primary.canonicalStateEvidenceRef
  ) {
    reasonCodes.push("primary_canonical_state_unproven");
  }
  if (input.safety !== "read_only") {
    if (!input.primary.effectAuthorityRef) {
      reasonCodes.push("primary_effect_authority_unproven");
    }
    if (!input.primary.effectReconciliationRef) {
      reasonCodes.push("primary_effect_reconciliation_unproven");
    }
  }
  if (missingCapabilities.length > 0) {
    reasonCodes.push("primary_capabilities_missing");
  }
  if (missingAuthorityClasses.length > 0) {
    reasonCodes.push("primary_authorities_missing");
  }
  if (
    input.primary.recoveryState === "verified_recovered"
    && !input.primary.recoveryEvidenceRef
  ) {
    reasonCodes.push("primary_recovery_evidence_missing");
  }
  if (!["not_needed", "verified_recovered"].includes(
    input.primary.recoveryState,
  )) {
    reasonCodes.push(`primary_recovery_state_${input.primary.recoveryState}`);
  }
  return {
    usable: reasonCodes.length === 0,
    missingCapabilities,
    missingAuthorityClasses,
    reasonCodes: uniqueSorted(reasonCodes),
  };
}

function assessRoute(
  input: NormalizedFallbackContinuityRequest,
  route: NormalizedFallbackRouteAttestation,
): FallbackRouteAssessment {
  const missingCapabilities = difference(
    input.requiredCapabilities,
    route.capabilities,
  );
  const missingAuthorityClasses = difference(
    input.requiredAuthorityClasses,
    route.authorityClasses,
  );
  const commonReasons = commonRouteReasons(route);
  const missionReasons = [...commonReasons];

  if (missingCapabilities.length > 0) {
    missionReasons.push("mission_capabilities_missing");
  }
  if (missingAuthorityClasses.length > 0) {
    missionReasons.push("mission_authorities_missing");
  }
  if (
    input.quality.requiresFreshCatalog
    && route.catalogFreshness !== "fresh"
  ) {
    missionReasons.push("catalog_not_fresh");
  }
  if (
    input.quality.freshEvidenceRequired
    && route.freshnessEvidenceRefs.length === 0
  ) {
    missionReasons.push("fresh_evidence_unproven");
  }
  if (
    input.quality.validationReadbackRequired
    && route.validationEvidenceRefs.length === 0
  ) {
    missionReasons.push("validation_readback_unproven");
  }
  if (
    input.quality.canonicalStateRequired
    && !route.canonicalStateEvidenceRef
  ) {
    missionReasons.push("canonical_state_unproven");
  }
  if (
    route.qualityClass === "quality_equivalent"
    && !route.qualityEquivalenceEvidenceRef
  ) {
    missionReasons.push("quality_equivalence_unproven");
  }
  if (
    !["survival_only", "insufficient"].includes(route.qualityClass)
    && !route.failbackProbeEvidenceRef
  ) {
    missionReasons.push("failback_probe_unproven");
  }

  const qualityCritical = isQualityCritical(input);
  switch (route.qualityClass) {
    case "quality_equivalent":
      break;
    case "degraded_read_only":
      if (
        input.intent !== "ordinary_read"
        || input.safety !== "read_only"
        || qualityCritical
      ) {
        missionReasons.push("degraded_route_not_admissible_for_operation");
      }
      break;
    case "recovery_only":
      if (input.intent !== "recovery") {
        missionReasons.push("recovery_route_not_admissible_for_mission_work");
      }
      break;
    case "survival_only":
      if (input.intent !== "safe_landing") {
        missionReasons.push("survival_route_not_admissible_for_mission_work");
      }
      break;
    case "insufficient":
      missionReasons.push("route_class_insufficient");
      break;
  }

  if (input.safety !== "read_only") {
    if (route.qualityClass !== "quality_equivalent") {
      missionReasons.push("effect_requires_quality_equivalent_route");
    }
    if (!route.effectAuthorityRef) {
      missionReasons.push("effect_authority_unproven");
    }
    if (!route.effectReconciliationRef) {
      missionReasons.push("effect_reconciliation_unproven");
    }
    if (!input.effect?.explicitFallbackAuthorizationRef) {
      missionReasons.push("explicit_effect_fallback_authorization_missing");
    } else if (
      input.effect.explicitFallbackAuthorizationState !== "verified"
    ) {
      missionReasons.push(
        `explicit_effect_fallback_authorization_state_${
          input.effect.explicitFallbackAuthorizationState ?? "missing"
        }`,
      );
    }
  }

  const repairMissingCapabilities = difference(
    input.primary.repairRequiredCapabilities,
    route.capabilities,
  );
  const repairMissingAuthorities = difference(
    input.primary.repairRequiredAuthorityClasses,
    route.authorityClasses,
  );
  const repairReasons = [...commonReasons];
  if (!route.supportsPrimaryRepair) {
    repairReasons.push("primary_repair_not_supported");
  }
  if (!route.failureDomainEvidenceRef) {
    repairReasons.push("independent_failure_domain_unproven");
  }
  if (!route.failbackProbeEvidenceRef) {
    repairReasons.push("failback_probe_unproven");
  }
  if (repairMissingCapabilities.length > 0) {
    repairReasons.push("repair_capabilities_missing");
  }
  if (repairMissingAuthorities.length > 0) {
    repairReasons.push("repair_authorities_missing");
  }
  if (![
    "quality_equivalent",
    "recovery_only",
  ].includes(route.qualityClass)) {
    repairReasons.push("route_class_not_admissible_for_primary_repair");
  }

  const survivalMissingCapabilities = difference(
    input.safeLandingRequiredCapabilities,
    route.capabilities,
  );
  const survivalMissingAuthorities = difference(
    input.safeLandingRequiredAuthorityClasses,
    route.authorityClasses,
  );
  const survivalReasons = [...commonReasons];
  if (!route.supportsStatePreservation) {
    survivalReasons.push("state_preservation_not_supported");
  }
  if (!route.supportsCheckpoint) {
    survivalReasons.push("checkpoint_not_supported");
  }
  if (!route.supportsSafeLanding) {
    survivalReasons.push("safe_landing_not_supported");
  }
  if (survivalMissingCapabilities.length > 0) {
    survivalReasons.push("safe_landing_capabilities_missing");
  }
  if (survivalMissingAuthorities.length > 0) {
    survivalReasons.push("safe_landing_authorities_missing");
  }
  if (![
    "quality_equivalent",
    "recovery_only",
    "survival_only",
  ].includes(route.qualityClass)) {
    survivalReasons.push("route_class_not_admissible_for_safe_landing");
  }

  return {
    routeRef: route.routeRef,
    routeKind: route.routeKind,
    functionalState: route.functionalState,
    attestationState: route.attestationState,
    catalogFreshness: route.catalogFreshness,
    qualityClass: route.qualityClass,
    fingerprintBasis: route.fingerprintBasis,
    fingerprintSha256: route.fingerprintSha256,
    policyRef: route.policyRef,
    selected: input.selectedFallback?.routeRef === route.routeRef,
    missionEligible: missionReasons.length === 0,
    repairEligible: repairReasons.length === 0,
    survivalEligible: survivalReasons.length === 0,
    missingCapabilities,
    missingAuthorityClasses,
    limitationCodes: route.limitationCodes,
    reasonCodes: uniqueSorted([
      ...missionReasons,
      ...repairReasons.map((reason) => `repair:${reason}`),
      ...survivalReasons.map((reason) => `survival:${reason}`),
    ]),
    evidenceRefs: routeEvidenceRefs(route),
  };
}

function commonRouteReasons(
  route: NormalizedFallbackRouteAttestation,
): string[] {
  const reasons: string[] = [];
  if (route.functionalState !== "healthy") {
    reasons.push(`route_functional_state_${route.functionalState}`);
  }
  if (route.attestationState !== "verified") {
    reasons.push(`route_attestation_state_${route.attestationState}`);
  }
  if (!route.attestationRef) reasons.push("route_attestation_missing");
  if (!route.policyRef) reasons.push("route_policy_missing");
  if (!route.failureDomainEvidenceRef) {
    reasons.push("independent_failure_domain_unproven");
  }
  if (!route.stateIsolationEvidenceRef) {
    reasons.push("state_isolation_unproven");
  }
  if (!route.authorityIsolationEvidenceRef) {
    reasons.push("authority_isolation_unproven");
  }
  return reasons;
}

function isQualityCritical(
  input: NormalizedFallbackContinuityRequest,
): boolean {
  return QUALITY_CRITICAL_INTENTS.has(input.intent)
    || input.quality.freshEvidenceRequired
    || input.quality.validationReadbackRequired
    || input.quality.canonicalStateRequired
    || input.quality.effectTransportRequired
    || input.safety !== "read_only";
}

function compareRouteAssessments(
  left: FallbackRouteAssessment,
  right: FallbackRouteAssessment,
): number {
  return QUALITY_RANK[left.qualityClass] - QUALITY_RANK[right.qualityClass]
    || left.routeRef.localeCompare(right.routeRef);
}

function routeByRef(
  input: NormalizedFallbackContinuityRequest,
  routeRef: string,
): NormalizedFallbackRouteAttestation | undefined {
  return input.fallbackRoutes.find((route) => route.routeRef === routeRef);
}

function primaryEvidenceRefs(
  primary: NormalizedPrimaryRouteObservation,
): string[] {
  return uniqueSorted([
    primary.attestationRef,
    primary.recoveryEvidenceRef,
    ...primary.freshnessEvidenceRefs,
    ...primary.validationEvidenceRefs,
    primary.canonicalStateEvidenceRef,
    primary.effectAuthorityRef,
    primary.effectReconciliationRef,
    primary.surfaceEpoch,
    primary.fingerprintSha256 === undefined
      ? undefined
      : `sha256:${primary.fingerprintSha256}`,
  ].filter((entry): entry is string => Boolean(entry)));
}

function routeEvidenceRefs(
  route: NormalizedFallbackRouteAttestation,
): string[] {
  return uniqueSorted([
    route.attestationRef,
    route.policyRef,
    route.qualityEquivalenceEvidenceRef,
    ...route.freshnessEvidenceRefs,
    ...route.validationEvidenceRefs,
    route.canonicalStateEvidenceRef,
    route.stateIsolationEvidenceRef,
    route.authorityIsolationEvidenceRef,
    route.failureDomainEvidenceRef,
    route.failbackProbeEvidenceRef,
    route.effectAuthorityRef,
    route.effectReconciliationRef,
    route.surfaceEpoch,
    route.fingerprintSha256 === undefined
      ? undefined
      : `sha256:${route.fingerprintSha256}`,
  ].filter((entry): entry is string => Boolean(entry)));
}

function normalizeRequest(
  request: FallbackContinuityRequest,
): NormalizedFallbackContinuityRequest {
  assertSafeReference(request.operationRef, "operationRef", 1_024);
  assertIsoTimestamp(request.observedAt, "observedAt");
  validateIntentAndSafety(request.intent, request.safety);
  if (request.safety !== "read_only" && !request.effect) {
    throw new Error("Effectful assessment requires an effect observation");
  }
  if (request.safety === "read_only" && request.effect) {
    throw new Error("Read-only assessment must not include an effect observation");
  }

  const requiredCapabilities = normalizeTokens(
    request.requiredCapabilities,
    "requiredCapabilities",
  );
  const requiredAuthorityClasses = normalizeTokens(
    request.requiredAuthorityClasses,
    "requiredAuthorityClasses",
  );
  const quality = normalizeQuality(request.intent, request.quality);
  const primary = normalizePrimary(request.primary);
  if (!Array.isArray(request.fallbackRoutes)) {
    throw new Error("fallbackRoutes must be an array");
  }
  if (request.fallbackRoutes.length > 100) {
    throw new Error("fallbackRoutes must not contain more than 100 routes");
  }
  const fallbackRoutes = request.fallbackRoutes
    .map(normalizeRoute)
    .sort((left, right) => left.routeRef.localeCompare(right.routeRef));
  const routeRefs = new Set<string>();
  for (const route of fallbackRoutes) {
    if (route.routeRef === primary.routeRef) {
      throw new Error("The primary route must not also be a fallback route");
    }
    if (routeRefs.has(route.routeRef)) {
      throw new Error(`Duplicate fallback routeRef: ${route.routeRef}`);
    }
    routeRefs.add(route.routeRef);
  }

  let selectedFallback: ExplicitFallbackSelection | undefined;
  if (request.selectedFallback) {
    if (request.selectedFallback.schemaVersion !== FALLBACK_SELECTION_SCHEMA) {
      throw new Error("Unsupported selectedFallback schemaVersion");
    }
    assertSafeReference(
      request.selectedFallback.operationRef,
      "selectedFallback.operationRef",
      1_024,
    );
    assertSha256(
      request.selectedFallback.operationContractDigestSha256,
      "selectedFallback.operationContractDigestSha256",
    );
    assertSafeReference(
      request.selectedFallback.routeRef,
      "selectedFallback.routeRef",
      1_024,
    );
    assertEvidenceRef(
      request.selectedFallback.policyRef,
      "selectedFallback.policyRef",
    );
    normalizeTokens(
      [request.selectedFallback.fingerprintBasis],
      "selectedFallback.fingerprintBasis",
    );
    assertSha256(
      request.selectedFallback.fingerprintSha256,
      "selectedFallback.fingerprintSha256",
    );
    assertOneOf(
      request.selectedFallback.attestationState,
      ["verified", "unverified", "expired"],
      "selectedFallback.attestationState",
    );
    assertEvidenceRef(
      request.selectedFallback.selectionRef,
      "selectedFallback.selectionRef",
    );
    selectedFallback = { ...request.selectedFallback };
  }

  let effect: ContinuityEffectObservation | undefined;
  if (request.effect) {
    assertSafeReference(request.effect.effectKey, "effect.effectKey", 4_000);
    if (![
      "not_started",
      "terminal_succeeded",
      "terminal_failed",
      "indeterminate",
    ].includes(request.effect.outcome)) {
      throw new Error(`Invalid effect outcome: ${String(request.effect.outcome)}`);
    }
    if (
      request.effect.outcome !== "not_started"
      && !request.effect.outcomeEvidenceRef
    ) {
      throw new Error(
        `${request.effect.outcome} requires effect.outcomeEvidenceRef`,
      );
    }
    assertOptionalEvidenceRef(
      request.effect.outcomeEvidenceRef,
      "effect.outcomeEvidenceRef",
    );
    assertOptionalEvidenceRef(
      request.effect.authoritativeReconciliationRef,
      "effect.authoritativeReconciliationRef",
    );
    assertOptionalEvidenceRef(
      request.effect.explicitFallbackAuthorizationRef,
      "effect.explicitFallbackAuthorizationRef",
    );
    if (request.effect.explicitFallbackAuthorizationState !== undefined) {
      assertOneOf(
        request.effect.explicitFallbackAuthorizationState,
        ["verified", "unverified", "expired"],
        "effect.explicitFallbackAuthorizationState",
      );
    }
    effect = { ...request.effect };
  }

  return {
    operationRef: request.operationRef,
    observedAt: request.observedAt,
    intent: request.intent,
    safety: request.safety,
    requiredCapabilities,
    requiredAuthorityClasses,
    quality,
    primary,
    fallbackRoutes,
    selectedFallback,
    safeLandingRequiredCapabilities: normalizeTokens(
      request.safeLandingRequiredCapabilities
        ?? DEFAULT_SAFE_LANDING_CAPABILITIES,
      "safeLandingRequiredCapabilities",
    ),
    safeLandingRequiredAuthorityClasses: normalizeTokens(
      request.safeLandingRequiredAuthorityClasses
        ?? DEFAULT_SAFE_LANDING_AUTHORITIES,
      "safeLandingRequiredAuthorityClasses",
    ),
    effect,
    operationContractDigestSha256: createFallbackOperationContractDigest({
      operationRef: request.operationRef,
      intent: request.intent,
      safety: request.safety,
      requiredCapabilities,
      requiredAuthorityClasses,
      quality,
      effect: effect === undefined ? undefined : { effectKey: effect.effectKey },
    }),
  };
}

function normalizeQuality(
  intent: FallbackContinuityIntent,
  quality: FallbackQualityRequirements | undefined,
): NormalizedQualityRequirements {
  if (
    quality !== undefined
    && (typeof quality !== "object" || quality === null || Array.isArray(quality))
  ) {
    throw new Error("quality must be an object");
  }
  return {
    requiresFreshCatalog: optionalBoolean(
      quality?.requiresFreshCatalog,
      false,
      "quality.requiresFreshCatalog",
    ),
    freshEvidenceRequired: intent === "research"
      || optionalBoolean(
        quality?.freshEvidenceRequired,
        false,
        "quality.freshEvidenceRequired",
      ),
    validationReadbackRequired: intent === "validation"
      || optionalBoolean(
        quality?.validationReadbackRequired,
        false,
        "quality.validationReadbackRequired",
      ),
    canonicalStateRequired: [
      "source_mutation",
      "repository_publication",
      "runtime_effect",
      "conversation_effect",
    ].includes(intent)
      || optionalBoolean(
        quality?.canonicalStateRequired,
        false,
        "quality.canonicalStateRequired",
      ),
    effectTransportRequired: EFFECT_INTENTS.has(intent)
      || optionalBoolean(
        quality?.effectTransportRequired,
        false,
        "quality.effectTransportRequired",
      ),
  };
}

function validateIntentAndSafety(
  intent: FallbackContinuityIntent,
  safety: FallbackOperationSafety,
): void {
  if (!FALLBACK_CONTINUITY_INTENTS.includes(intent)) {
    throw new Error(`Invalid intent: ${String(intent)}`);
  }
  if (![
    "read_only",
    "idempotent_effect",
    "non_idempotent_effect",
  ].includes(safety)) {
    throw new Error(`Invalid safety: ${String(safety)}`);
  }
  if (EFFECT_INTENTS.has(intent) && safety === "read_only") {
    throw new Error(`${intent} requires an effect safety class`);
  }
}

function normalizePrimary(
  primary: PrimaryRouteObservation,
): NormalizedPrimaryRouteObservation {
  assertSafeReference(primary.routeRef, "primary.routeRef", 1_024);
  assertOneOf(
    primary.state,
    ["healthy", "degraded", "unavailable", "unknown", "outcome_indeterminate"],
    "primary.state",
  );
  assertOneOf(
    primary.recoveryState,
    [
      "not_needed",
      "not_attempted",
      "required",
      "in_progress",
      "verified_recovered",
      "exhausted",
      "blocked",
    ],
    "primary.recoveryState",
  );
  if (primary.recoveryDirectiveCode !== undefined) {
    normalizeTokens(
      [primary.recoveryDirectiveCode],
      "primary.recoveryDirectiveCode",
    );
  }
  if (!["verified", "unverified", "expired"].includes(
    primary.attestationState,
  )) {
    throw new Error(
      `Invalid primary.attestationState: ${String(primary.attestationState)}`,
    );
  }
  assertOneOf(
    primary.catalogFreshness,
    ["fresh", "stale", "unknown"],
    "primary.catalogFreshness",
  );
  assertEvidenceRef(primary.attestationRef, "primary.attestationRef");
  assertOptionalEvidenceRef(
    primary.recoveryEvidenceRef,
    "primary.recoveryEvidenceRef",
  );
  assertOptionalEvidenceRef(
    primary.canonicalStateEvidenceRef,
    "primary.canonicalStateEvidenceRef",
  );
  assertOptionalEvidenceRef(
    primary.effectAuthorityRef,
    "primary.effectAuthorityRef",
  );
  assertOptionalEvidenceRef(
    primary.effectReconciliationRef,
    "primary.effectReconciliationRef",
  );
  assertOptionalSafeReference(
    primary.surfaceEpoch,
    "primary.surfaceEpoch",
    256,
  );
  assertOptionalSha256(primary.fingerprintSha256, "primary.fingerprintSha256");
  return {
    ...primary,
    capabilities: normalizeTokens(primary.capabilities, "primary.capabilities"),
    authorityClasses: normalizeTokens(
      primary.authorityClasses,
      "primary.authorityClasses",
    ),
    freshnessEvidenceRefs: normalizeEvidenceRefs(
      primary.freshnessEvidenceRefs ?? [],
      "primary.freshnessEvidenceRefs",
    ),
    validationEvidenceRefs: normalizeEvidenceRefs(
      primary.validationEvidenceRefs ?? [],
      "primary.validationEvidenceRefs",
    ),
    repairRequiredCapabilities: normalizeTokens(
      primary.repairRequiredCapabilities
        ?? DEFAULT_PRIMARY_REPAIR_CAPABILITIES,
      "primary.repairRequiredCapabilities",
    ),
    repairRequiredAuthorityClasses: normalizeTokens(
      primary.repairRequiredAuthorityClasses
        ?? DEFAULT_PRIMARY_REPAIR_AUTHORITIES,
      "primary.repairRequiredAuthorityClasses",
    ),
  };
}

function normalizeRoute(
  route: FallbackRouteAttestation,
  index: number,
): NormalizedFallbackRouteAttestation {
  const prefix = `fallbackRoutes[${index}]`;
  if (route.schemaVersion !== FALLBACK_ROUTE_ATTESTATION_SCHEMA) {
    throw new Error(`Unsupported ${prefix}.schemaVersion`);
  }
  assertSafeReference(route.routeRef, `${prefix}.routeRef`, 1_024);
  if (!FALLBACK_QUALITY_CLASSES.includes(route.qualityClass)) {
    throw new Error(
      `Invalid ${prefix}.qualityClass: ${String(route.qualityClass)}`,
    );
  }
  if (!["legacy", "continuity", "other"].includes(route.routeKind)) {
    throw new Error(`Invalid ${prefix}.routeKind: ${String(route.routeKind)}`);
  }
  if (!["healthy", "degraded", "unavailable", "unknown"].includes(
    route.functionalState,
  )) {
    throw new Error(
      `Invalid ${prefix}.functionalState: ${String(route.functionalState)}`,
    );
  }
  if (!["verified", "unverified", "expired"].includes(route.attestationState)) {
    throw new Error(
      `Invalid ${prefix}.attestationState: ${String(route.attestationState)}`,
    );
  }
  assertOneOf(
    route.catalogFreshness,
    ["fresh", "stale", "unknown"],
    `${prefix}.catalogFreshness`,
  );
  assertOptionalBoolean(
    route.supportsPrimaryRepair,
    `${prefix}.supportsPrimaryRepair`,
  );
  assertOptionalBoolean(
    route.supportsStatePreservation,
    `${prefix}.supportsStatePreservation`,
  );
  assertOptionalBoolean(
    route.supportsCheckpoint,
    `${prefix}.supportsCheckpoint`,
  );
  assertOptionalBoolean(
    route.supportsSafeLanding,
    `${prefix}.supportsSafeLanding`,
  );
  assertOptionalEvidenceRef(route.attestationRef, `${prefix}.attestationRef`);
  assertOptionalEvidenceRef(route.policyRef, `${prefix}.policyRef`);
  assertOptionalSafeReference(route.surfaceEpoch, `${prefix}.surfaceEpoch`, 256);
  normalizeTokens([route.fingerprintBasis], `${prefix}.fingerprintBasis`);
  assertSha256(route.fingerprintSha256, `${prefix}.fingerprintSha256`);
  assertOptionalEvidenceRef(
    route.qualityEquivalenceEvidenceRef,
    `${prefix}.qualityEquivalenceEvidenceRef`,
  );
  assertOptionalEvidenceRef(
    route.canonicalStateEvidenceRef,
    `${prefix}.canonicalStateEvidenceRef`,
  );
  assertOptionalEvidenceRef(
    route.stateIsolationEvidenceRef,
    `${prefix}.stateIsolationEvidenceRef`,
  );
  assertOptionalEvidenceRef(
    route.authorityIsolationEvidenceRef,
    `${prefix}.authorityIsolationEvidenceRef`,
  );
  assertOptionalEvidenceRef(
    route.failureDomainEvidenceRef,
    `${prefix}.failureDomainEvidenceRef`,
  );
  assertOptionalEvidenceRef(
    route.failbackProbeEvidenceRef,
    `${prefix}.failbackProbeEvidenceRef`,
  );
  assertOptionalEvidenceRef(
    route.effectAuthorityRef,
    `${prefix}.effectAuthorityRef`,
  );
  assertOptionalEvidenceRef(
    route.effectReconciliationRef,
    `${prefix}.effectReconciliationRef`,
  );
  return {
    ...route,
    capabilities: normalizeTokens(route.capabilities, `${prefix}.capabilities`),
    authorityClasses: normalizeTokens(
      route.authorityClasses,
      `${prefix}.authorityClasses`,
    ),
    freshnessEvidenceRefs: normalizeEvidenceRefs(
      route.freshnessEvidenceRefs ?? [],
      `${prefix}.freshnessEvidenceRefs`,
    ),
    validationEvidenceRefs: normalizeEvidenceRefs(
      route.validationEvidenceRefs ?? [],
      `${prefix}.validationEvidenceRefs`,
    ),
    limitationCodes: normalizeTokens(
      route.limitationCodes ?? [],
      `${prefix}.limitationCodes`,
    ),
  };
}

function mapPrimaryFunctionalState(
  assessment: McpPrimaryRecoveryAssessment,
): PrimaryRouteState {
  switch (assessment.primary.functionalState) {
    case "healthy":
      return "healthy";
    case "degraded":
      return "degraded";
    case "unavailable":
      return "unavailable";
    case "unknown":
      return "unknown";
  }
}

function mapPrimaryRecoveryState(
  state: McpPrimaryRecoveryState,
): PrimaryRecoveryState {
  switch (state) {
    case "FAILBACK_PRIMARY":
      return "verified_recovered";
    case "CONTINUE_PRIMARY":
    case "USE_STABLE_CONTROL_PLANE":
      return "not_needed";
    case "WAIT_FOR_RECOVERY_OWNER":
      return "in_progress";
    case "ATTEST_CLIENT_CATALOG":
    case "REFRESH_CLIENT_CATALOG":
    case "RECONNECT_PRIMARY":
    case "REPAIR_PRIMARY":
    case "DIAGNOSE_PRIMARY":
      return "required";
    case "USE_QUALITY_EQUIVALENT_FALLBACK":
    case "SAFE_TURN_LANDING":
      return "exhausted";
    case "HARD_EXTERNAL_BLOCKER":
      return "blocked";
  }
}

function mapCatalogFreshness(
  status: McpPrimaryRecoveryAssessment["primary"]["catalogStatus"],
): ContinuityCatalogFreshness {
  switch (status) {
    case "CURRENT":
      return "fresh";
    case "STALE_CLIENT":
    case "STALE_SERVER":
      return "stale";
    case "SERVER_CURRENT_CLIENT_UNKNOWN":
    case "INDETERMINATE":
      return "unknown";
  }
}

function normalizeTokens(values: readonly string[], name: string): string[] {
  if (!Array.isArray(values)) throw new Error(`${name} must be an array`);
  if (values.length > 200) {
    throw new Error(`${name} must not contain more than 200 entries`);
  }
  const normalized = values.map((value, index) => {
    if (typeof value !== "string") {
      throw new Error(`${name}[${index}] must be a string`);
    }
    const trimmed = value.trim();
    if (!/^[a-z0-9][a-z0-9._:/-]{0,255}$/.test(trimmed)) {
      throw new Error(`Invalid ${name}[${index}]: ${value}`);
    }
    return trimmed;
  });
  return uniqueSorted(normalized);
}

function normalizeEvidenceRefs(
  values: readonly string[],
  name: string,
): string[] {
  if (!Array.isArray(values)) throw new Error(`${name} must be an array`);
  if (values.length > 100) {
    throw new Error(`${name} must not contain more than 100 entries`);
  }
  values.forEach((value, index) => {
    assertEvidenceRef(value, `${name}[${index}]`);
  });
  return uniqueSorted([...values]);
}

function difference(
  required: readonly string[],
  available: readonly string[],
): string[] {
  const availableSet = new Set(available);
  return required.filter((entry) => !availableSet.has(entry));
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function optionalBoolean(
  value: boolean | undefined,
  fallback: boolean,
  name: string,
): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") {
    throw new Error(`${name} must be a boolean`);
  }
  return value;
}

function assertOptionalBoolean(
  value: boolean | undefined,
  name: string,
): void {
  if (value !== undefined && typeof value !== "boolean") {
    throw new Error(`${name} must be a boolean`);
  }
}

function assertOneOf(
  value: unknown,
  allowed: readonly string[],
  name: string,
): void {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new Error(`Invalid ${name}: ${String(value)}`);
  }
}

function assertIsoTimestamp(value: string, name: string): void {
  if (
    typeof value !== "string"
    || !value
    || value !== value.trim()
  ) {
    throw new Error(`${name} must be a non-empty ISO timestamp`);
  }
  if (!Number.isFinite(Date.parse(value))) {
    throw new Error(`${name} must be a valid ISO timestamp`);
  }
}

function assertOptionalSha256(value: string | undefined, name: string): void {
  if (value === undefined) return;
  assertSha256(value, name);
}

function assertSha256(value: string, name: string): void {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${name} must be a lowercase SHA-256 digest`);
  }
}

function assertEvidenceRef(value: string, name: string): void {
  assertSafeReference(value, name, 2_048);
}

function assertOptionalEvidenceRef(
  value: string | undefined,
  name: string,
): void {
  if (value === undefined) return;
  assertEvidenceRef(value, name);
}

function assertOptionalSafeReference(
  value: string | undefined,
  name: string,
  maxLength: number,
): void {
  if (value === undefined) return;
  assertSafeReference(value, name, maxLength);
}

function assertSafeReference(
  value: string,
  name: string,
  maxLength: number,
): void {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  if (
    !value
    || value !== value.trim()
    || value.length > maxLength
    || /[\u0000-\u001f\u007f\s]/.test(value)
    || value.includes("?")
    || value.includes("\\")
  ) {
    throw new Error(`Invalid ${name}`);
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error(`Invalid ${name}`);
    }
    if (url.username || url.password || url.search) {
      throw new Error(`Invalid ${name}: unsafe URI reference`);
    }
  }
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
