import assert from "node:assert/strict";
import test from "node:test";
import {
  assessFallbackContinuity,
  assessFallbackContinuityFromPrimaryRecovery,
  createFallbackOperationContractDigest,
  DEFAULT_PRIMARY_REPAIR_AUTHORITIES,
  DEFAULT_PRIMARY_REPAIR_CAPABILITIES,
  DEFAULT_SAFE_LANDING_AUTHORITIES,
  DEFAULT_SAFE_LANDING_CAPABILITIES,
  FALLBACK_ROUTE_ATTESTATION_SCHEMA,
  FALLBACK_SELECTION_SCHEMA,
  mcpWorkCapabilityToken,
  type FallbackContinuityRequest,
  type FallbackRouteAttestation,
  type ExplicitFallbackSelection,
  type PrimaryRouteObservation,
} from "./fallback-continuity-plane.js";
import { assessMcpPrimaryRecovery } from "./mcp-primary-recovery.js";

const OBSERVED_AT = "2026-08-19T14:00:00.000Z";
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);
const SHA_D = "d".repeat(64);

function unavailablePrimary(
  overrides: Partial<PrimaryRouteObservation> = {},
): PrimaryRouteObservation {
  return {
    routeRef: "route:nexus:primary",
    state: "unavailable",
    recoveryState: "exhausted",
    attestationState: "verified",
    catalogFreshness: "unknown",
    capabilities: [],
    authorityClasses: [],
    attestationRef: "attestation:nexus:primary:v1",
    ...overrides,
  };
}

function qualityEquivalentRoute(
  overrides: Partial<FallbackRouteAttestation> = {},
): FallbackRouteAttestation {
  return {
    schemaVersion: FALLBACK_ROUTE_ATTESTATION_SCHEMA,
    routeRef: "route:continuity:equivalent",
    routeKind: "continuity",
    functionalState: "healthy",
    attestationState: "verified",
    qualityClass: "quality_equivalent",
    catalogFreshness: "fresh",
    fingerprintBasis: "canonical_complete_route_descriptor",
    fingerprintSha256: SHA_B,
    capabilities: ["workspace.read"],
    authorityClasses: ["workspace.read.authority"],
    attestationRef: "attestation:continuity:equivalent:v1",
    policyRef: "policy:continuity:equivalent:v1",
    qualityEquivalenceEvidenceRef: "evidence:quality:equivalent:v1",
    stateIsolationEvidenceRef: "evidence:state:isolation:equivalent:v1",
    authorityIsolationEvidenceRef:
      "evidence:authority:isolation:equivalent:v1",
    failureDomainEvidenceRef: "evidence:failure-domain:equivalent:v1",
    failbackProbeEvidenceRef: "evidence:failback-probe:equivalent:v1",
    ...overrides,
  } as FallbackRouteAttestation;
}

function degradedReadRoute(
  overrides: Partial<FallbackRouteAttestation> = {},
): FallbackRouteAttestation {
  return {
    schemaVersion: FALLBACK_ROUTE_ATTESTATION_SCHEMA,
    routeRef: "route:continuity:degraded-read",
    routeKind: "continuity",
    functionalState: "healthy",
    attestationState: "verified",
    qualityClass: "degraded_read_only",
    catalogFreshness: "fresh",
    fingerprintBasis: "canonical_complete_route_descriptor",
    fingerprintSha256: SHA_C,
    capabilities: ["workspace.read"],
    authorityClasses: ["workspace.read.authority"],
    attestationRef: "attestation:continuity:degraded-read:v1",
    policyRef: "policy:continuity:degraded-read:v1",
    stateIsolationEvidenceRef: "evidence:state:isolation:degraded-read:v1",
    authorityIsolationEvidenceRef:
      "evidence:authority:isolation:degraded-read:v1",
    failureDomainEvidenceRef: "evidence:failure-domain:degraded-read:v1",
    failbackProbeEvidenceRef: "evidence:failback-probe:degraded-read:v1",
    ...overrides,
  } as FallbackRouteAttestation;
}

function recoveryRoute(
  overrides: Partial<FallbackRouteAttestation> = {},
): FallbackRouteAttestation {
  return {
    schemaVersion: FALLBACK_ROUTE_ATTESTATION_SCHEMA,
    routeRef: "route:continuity:recovery",
    routeKind: "continuity",
    functionalState: "healthy",
    attestationState: "verified",
    qualityClass: "recovery_only",
    catalogFreshness: "fresh",
    fingerprintBasis: "canonical_complete_route_descriptor",
    fingerprintSha256: SHA_D,
    capabilities: [...DEFAULT_PRIMARY_REPAIR_CAPABILITIES],
    authorityClasses: [...DEFAULT_PRIMARY_REPAIR_AUTHORITIES],
    attestationRef: "attestation:continuity:recovery:v1",
    policyRef: "policy:continuity:recovery:v1",
    stateIsolationEvidenceRef: "evidence:state:isolation:recovery:v1",
    authorityIsolationEvidenceRef: "evidence:authority:isolation:recovery:v1",
    failureDomainEvidenceRef: "evidence:failure-domain:recovery:v1",
    supportsPrimaryRepair: true,
    failbackProbeEvidenceRef: "evidence:failback-probe:recovery:v1",
    ...overrides,
  } as FallbackRouteAttestation;
}

function survivalRoute(
  overrides: Partial<FallbackRouteAttestation> = {},
): FallbackRouteAttestation {
  return {
    schemaVersion: FALLBACK_ROUTE_ATTESTATION_SCHEMA,
    routeRef: "route:continuity:survival",
    routeKind: "continuity",
    functionalState: "healthy",
    attestationState: "verified",
    qualityClass: "survival_only",
    catalogFreshness: "unknown",
    fingerprintBasis: "canonical_complete_route_descriptor",
    fingerprintSha256: SHA_A,
    capabilities: [...DEFAULT_SAFE_LANDING_CAPABILITIES],
    authorityClasses: [...DEFAULT_SAFE_LANDING_AUTHORITIES],
    attestationRef: "attestation:continuity:survival:v1",
    policyRef: "policy:continuity:survival:v1",
    stateIsolationEvidenceRef: "evidence:state:isolation:survival:v1",
    authorityIsolationEvidenceRef: "evidence:authority:isolation:survival:v1",
    failureDomainEvidenceRef: "evidence:failure-domain:survival:v1",
    supportsStatePreservation: true,
    supportsCheckpoint: true,
    supportsSafeLanding: true,
    ...overrides,
  } as FallbackRouteAttestation;
}

function ordinaryReadRequest(
  overrides: Partial<FallbackContinuityRequest> = {},
): FallbackContinuityRequest {
  return {
    operationRef: "operation:workspace-read:1",
    observedAt: OBSERVED_AT,
    intent: "ordinary_read",
    safety: "read_only",
    requiredCapabilities: ["workspace.read"],
    requiredAuthorityClasses: ["workspace.read.authority"],
    primary: unavailablePrimary(),
    fallbackRoutes: [],
    ...overrides,
  };
}

function selectionFor(
  request: FallbackContinuityRequest,
  route: FallbackRouteAttestation,
  selectionRef: string,
  overrides: Partial<ExplicitFallbackSelection> = {},
): ExplicitFallbackSelection {
  return {
    schemaVersion: FALLBACK_SELECTION_SCHEMA,
    operationRef: request.operationRef,
    operationContractDigestSha256:
      createFallbackOperationContractDigest(request),
    routeRef: route.routeRef,
    policyRef: route.policyRef!,
    fingerprintBasis: route.fingerprintBasis,
    fingerprintSha256: route.fingerprintSha256,
    attestationState: "verified",
    selectionRef,
    ...overrides,
  };
}

function withSelection(
  request: FallbackContinuityRequest,
  route: FallbackRouteAttestation,
  selectionRef: string,
  overrides: Partial<ExplicitFallbackSelection> = {},
): FallbackContinuityRequest {
  return {
    ...request,
    selectedFallback: selectionFor(
      request,
      route,
      selectionRef,
      overrides,
    ),
  };
}

test("uses a healthy primary instead of considering fallback", () => {
  const result = assessFallbackContinuity(ordinaryReadRequest({
    primary: unavailablePrimary({
      state: "healthy",
      recoveryState: "not_needed",
      catalogFreshness: "fresh",
      capabilities: ["workspace.read"],
      authorityClasses: ["workspace.read.authority"],
      surfaceEpoch: "nexus:current:1",
      fingerprintSha256: SHA_A,
    }),
    fallbackRoutes: [qualityEquivalentRoute()],
  }));

  assert.equal(result.disposition, "use_primary");
  assert.equal(result.selectedRouteRef, "route:nexus:primary");
  assert.equal(result.policy.primaryPreferred, true);
  assert.equal(result.policy.qualityReductionAuthorized, false);
  assert.equal(result.policy.evidenceReferencesVerifiedByPlanner, false);
  assert.equal(result.policy.routeInvocationPerformed, false);
});

test("fails back only after verified primary recovery evidence", () => {
  const result = assessFallbackContinuity(ordinaryReadRequest({
    primary: unavailablePrimary({
      state: "healthy",
      recoveryState: "verified_recovered",
      recoveryEvidenceRef: "evidence:primary:recovered:v1",
      catalogFreshness: "fresh",
      capabilities: ["workspace.read"],
      authorityClasses: ["workspace.read.authority"],
      fingerprintSha256: SHA_A,
    }),
  }));

  assert.equal(result.disposition, "failback_to_primary");
  assert.ok(result.evidenceRefs.includes("evidence:primary:recovered:v1"));
});

test("does not trust an unverified primary attestation", () => {
  const result = assessFallbackContinuity(ordinaryReadRequest({
    primary: unavailablePrimary({
      state: "healthy",
      recoveryState: "not_needed",
      attestationState: "unverified",
      catalogFreshness: "fresh",
      capabilities: ["workspace.read"],
      authorityClasses: ["workspace.read.authority"],
      fingerprintSha256: SHA_A,
    }),
    fallbackRoutes: [survivalRoute()],
  }));

  assert.equal(result.disposition, "safe_land");
  assert.ok(result.primary.reasonCodes.includes(
    "primary_attestation_state_unverified",
  ));
});

test("requires primary fresh-evidence proof for research work", () => {
  const primary = unavailablePrimary({
    state: "healthy",
    recoveryState: "not_needed",
    catalogFreshness: "fresh",
    capabilities: ["workspace.read"],
    authorityClasses: ["workspace.read.authority"],
    fingerprintSha256: SHA_A,
  });
  const blocked = assessFallbackContinuity(ordinaryReadRequest({
    intent: "research",
    primary,
  }));
  assert.equal(blocked.disposition, "hard_block");
  assert.ok(blocked.primary.reasonCodes.includes(
    "primary_fresh_evidence_unproven",
  ));

  const admitted = assessFallbackContinuity(ordinaryReadRequest({
    intent: "research",
    primary: {
      ...primary,
      freshnessEvidenceRefs: ["evidence:primary:fresh-research:v1"],
    },
  }));
  assert.equal(admitted.disposition, "use_primary");
});

test("quality-critical intent floors cannot be disabled by caller booleans", () => {
  const primary = unavailablePrimary({
    state: "healthy",
    recoveryState: "not_needed",
    catalogFreshness: "fresh",
    capabilities: ["workspace.read"],
    authorityClasses: ["workspace.read.authority"],
    fingerprintSha256: SHA_A,
  });
  const research = assessFallbackContinuity(ordinaryReadRequest({
    intent: "research",
    quality: { freshEvidenceRequired: false },
    primary,
  }));
  assert.ok(research.primary.reasonCodes.includes(
    "primary_fresh_evidence_unproven",
  ));

  const validation = assessFallbackContinuity(ordinaryReadRequest({
    intent: "validation",
    quality: { validationReadbackRequired: false },
    primary,
  }));
  assert.ok(validation.primary.reasonCodes.includes(
    "primary_validation_readback_unproven",
  ));

  const mutation = assessFallbackContinuity({
    ...ordinaryReadRequest(),
    operationRef: "operation:source-mutation:floor",
    intent: "source_mutation",
    safety: "idempotent_effect",
    quality: {
      canonicalStateRequired: false,
      effectTransportRequired: false,
    },
    primary,
    effect: {
      effectKey: "effect:source-mutation:floor",
      outcome: "not_started",
    },
  });
  assert.ok(mutation.primary.reasonCodes.includes(
    "primary_canonical_state_unproven",
  ));
  assert.ok(mutation.primary.reasonCodes.includes(
    "primary_effect_authority_unproven",
  ));
});

test("requires primary validation and canonical-state evidence when declared", () => {
  const primary = unavailablePrimary({
    state: "healthy",
    recoveryState: "not_needed",
    catalogFreshness: "fresh",
    capabilities: ["workspace.read"],
    authorityClasses: ["workspace.read.authority"],
    fingerprintSha256: SHA_A,
  });
  const validation = assessFallbackContinuity(ordinaryReadRequest({
    intent: "validation",
    primary,
  }));
  assert.ok(validation.primary.reasonCodes.includes(
    "primary_validation_readback_unproven",
  ));

  const mutation = assessFallbackContinuity({
    ...ordinaryReadRequest(),
    operationRef: "operation:source-mutation:primary",
    intent: "source_mutation",
    safety: "idempotent_effect",
    primary,
    effect: {
      effectKey: "effect:source-mutation:primary",
      outcome: "not_started",
    },
  });
  assert.ok(mutation.primary.reasonCodes.includes(
    "primary_canonical_state_unproven",
  ));
  assert.ok(mutation.primary.reasonCodes.includes(
    "primary_effect_authority_unproven",
  ));
  assert.ok(mutation.primary.reasonCodes.includes(
    "primary_effect_reconciliation_unproven",
  ));
});

test("keeps one in-progress primary recovery owner ahead of fallback", () => {
  const result = assessFallbackContinuity(ordinaryReadRequest({
    primary: unavailablePrimary({ recoveryState: "in_progress" }),
    fallbackRoutes: [qualityEquivalentRoute(), recoveryRoute()],
  }));

  assert.equal(result.disposition, "repair_primary");
  assert.ok(result.reasonCodes.includes("primary_recovery_in_progress"));
  assert.equal(result.selectedRouteRef, undefined);
  assert.equal(result.selectedPolicyRef, undefined);
});

test("selects an independent recovery route before mission fallback", () => {
  const result = assessFallbackContinuity(ordinaryReadRequest({
    primary: unavailablePrimary({ recoveryState: "not_attempted" }),
    fallbackRoutes: [qualityEquivalentRoute(), recoveryRoute()],
  }));

  assert.equal(result.disposition, "repair_primary");
  assert.equal(result.selectedRouteRef, "route:continuity:recovery");
  assert.equal(result.selectedQualityClass, "recovery_only");
});

test("never auto-selects an eligible quality-equivalent fallback", () => {
  const result = assessFallbackContinuity(ordinaryReadRequest({
    fallbackRoutes: [qualityEquivalentRoute()],
  }));

  assert.equal(result.disposition, "fallback_selection_required");
  assert.deepEqual(
    result.selectionRequiredRouteRefs,
    ["route:continuity:equivalent"],
  );
  assert.equal(result.selectedRouteRef, undefined);
});

test("admits an explicitly selected quality-equivalent fallback for one operation", () => {
  const route = qualityEquivalentRoute();
  const request = ordinaryReadRequest({ fallbackRoutes: [route] });
  const result = assessFallbackContinuity(withSelection(
    request,
    route,
    "selection:continuity:equivalent:operation-1",
  ));

  assert.equal(result.disposition, "use_quality_equivalent_fallback");
  assert.equal(result.selectedRouteRef, "route:continuity:equivalent");
  assert.ok(result.evidenceRefs.includes(
    "selection:continuity:equivalent:operation-1",
  ));
  assert.equal(result.policy.canonicalAuthorityTransferred, false);
  assert.equal(result.policy.primaryAndFallbackStateMayBeShared, false);
});

test("rejects a selection bound to an older fallback fingerprint", () => {
  const route = qualityEquivalentRoute();
  const request = ordinaryReadRequest({
    fallbackRoutes: [route, survivalRoute()],
  });
  const result = assessFallbackContinuity(withSelection(
    request,
    route,
    "selection:stale-fingerprint:1",
    { fingerprintSha256: SHA_D },
  ));

  assert.equal(result.disposition, "safe_land");
  assert.ok(result.reasonCodes.includes(
    "selected_fallback_fingerprint_mismatch",
  ));
});

test("rejects a selection that hashes a different descriptor basis", () => {
  const route = qualityEquivalentRoute();
  const request = ordinaryReadRequest({
    fallbackRoutes: [route, survivalRoute()],
  });
  const result = assessFallbackContinuity(withSelection(
    request,
    route,
    "selection:wrong-fingerprint-basis:1",
    { fingerprintBasis: "tool_names_only" },
  ));

  assert.equal(result.disposition, "safe_land");
  assert.ok(result.reasonCodes.includes(
    "selected_fallback_fingerprint_basis_mismatch",
  ));
});

test("rejects a fallback selection issued for another logical operation", () => {
  const route = qualityEquivalentRoute();
  const request = ordinaryReadRequest({
    fallbackRoutes: [route, survivalRoute()],
  });
  const result = assessFallbackContinuity(withSelection(
    request,
    route,
    "selection:wrong-operation:1",
    { operationRef: "operation:workspace-read:other" },
  ));

  assert.equal(result.disposition, "safe_land");
  assert.ok(result.reasonCodes.includes(
    "selected_fallback_operation_mismatch",
  ));
});

test("rejects an unverified or expired fallback selection attestation", () => {
  const route = qualityEquivalentRoute();
  const request = ordinaryReadRequest({
    fallbackRoutes: [route, survivalRoute()],
  });
  for (const attestationState of ["unverified", "expired"] as const) {
    const result = assessFallbackContinuity(withSelection(
      request,
      route,
      `selection:${attestationState}:1`,
      { attestationState },
    ));
    assert.equal(result.disposition, "safe_land");
    assert.ok(result.reasonCodes.includes(
      `selected_fallback_attestation_state_${attestationState}`,
    ));
  }
});

test("rejects a selection when the operation contract changed under the same reference", () => {
  const route = qualityEquivalentRoute();
  const request = ordinaryReadRequest({
    fallbackRoutes: [route, survivalRoute()],
  });
  const changedContractDigest = createFallbackOperationContractDigest({
    ...request,
    requiredCapabilities: ["workspace.read", "workspace.metadata"],
  });
  const result = assessFallbackContinuity(withSelection(
    request,
    route,
    "selection:changed-contract:1",
    { operationContractDigestSha256: changedContractDigest },
  ));

  assert.equal(result.disposition, "safe_land");
  assert.ok(result.reasonCodes.includes(
    "selected_fallback_operation_contract_mismatch",
  ));
});

test("requires a healthy verified fallback attestation", () => {
  const degradedRoute = qualityEquivalentRoute({ functionalState: "degraded" });
  const degradedRequest = ordinaryReadRequest({
    fallbackRoutes: [degradedRoute, survivalRoute()],
  });
  const degraded = assessFallbackContinuity(withSelection(
    degradedRequest,
    degradedRoute,
    "selection:degraded-route:1",
  ));
  assert.equal(degraded.disposition, "safe_land");
  assert.ok(degraded.consideredRoutes[0]?.reasonCodes.includes(
    "route_functional_state_degraded",
  ));

  const unverifiedRoute = qualityEquivalentRoute({
    attestationState: "unverified",
  });
  const unverifiedRequest = ordinaryReadRequest({
    fallbackRoutes: [unverifiedRoute, survivalRoute()],
  });
  const unverified = assessFallbackContinuity(withSelection(
    unverifiedRequest,
    unverifiedRoute,
    "selection:unverified-route:1",
  ));
  assert.equal(unverified.disposition, "safe_land");
  assert.ok(unverified.consideredRoutes[0]?.reasonCodes.includes(
    "route_attestation_state_unverified",
  ));
});

test("requires evidence that fallback is in an independent failure domain", () => {
  const route = qualityEquivalentRoute({ failureDomainEvidenceRef: undefined });
  const request = ordinaryReadRequest({
    fallbackRoutes: [route, survivalRoute()],
  });
  const result = assessFallbackContinuity(withSelection(
    request,
    route,
    "selection:shared-failure-domain:1",
  ));

  assert.equal(result.disposition, "safe_land");
  const candidate = result.consideredRoutes.find(
    (route) => route.routeRef === "route:continuity:equivalent",
  );
  assert.ok(candidate?.reasonCodes.includes(
    "independent_failure_domain_unproven",
  ));
});

test("requires evidence for the deterministic primary failback probe", () => {
  const route = qualityEquivalentRoute({ failbackProbeEvidenceRef: undefined });
  const request = ordinaryReadRequest({
    fallbackRoutes: [route, survivalRoute()],
  });
  const result = assessFallbackContinuity(withSelection(
    request,
    route,
    "selection:no-failback-probe:1",
  ));

  assert.equal(result.disposition, "safe_land");
  const candidate = result.consideredRoutes.find(
    (entry) => entry.routeRef === route.routeRef,
  );
  assert.ok(candidate?.reasonCodes.includes("failback_probe_unproven"));
});

test("rejects unproven quality equivalence and uses survival continuity", () => {
  const route = qualityEquivalentRoute({
    qualityEquivalenceEvidenceRef: undefined,
  });
  const request = ordinaryReadRequest({
    fallbackRoutes: [route, survivalRoute()],
  });
  const result = assessFallbackContinuity(withSelection(
    request,
    route,
    "selection:unproven:1",
  ));

  assert.equal(result.disposition, "safe_land");
  assert.equal(result.selectedRouteRef, "route:continuity:survival");
  assert.ok(result.reasonCodes.includes("selected_fallback_not_eligible"));
});

test("allows degraded fallback only for a bounded ordinary read", () => {
  const route = degradedReadRoute();
  const request = ordinaryReadRequest({ fallbackRoutes: [route] });
  const result = assessFallbackContinuity(withSelection(
    request,
    route,
    "selection:degraded-read:1",
  ));

  assert.equal(result.disposition, "use_degraded_read_only_fallback");
  assert.match(result.claimCeiling, /non-quality-critical read/i);
});

test("does not use degraded read fallback for fresh research", () => {
  const route = degradedReadRoute({
    freshnessEvidenceRefs: ["evidence:freshness:degraded:1"],
  });
  const request = ordinaryReadRequest({
    intent: "research",
    quality: { freshEvidenceRequired: true },
    fallbackRoutes: [route, survivalRoute()],
  });
  const result = assessFallbackContinuity(withSelection(
    request,
    route,
    "selection:degraded-research:1",
  ));

  assert.equal(result.disposition, "safe_land");
  const degraded = result.consideredRoutes.find(
    (route) => route.routeRef === "route:continuity:degraded-read",
  );
  assert.ok(degraded?.reasonCodes.includes(
    "degraded_route_not_admissible_for_operation",
  ));
});

test("uses a survival route when no mission fallback preserves quality", () => {
  const result = assessFallbackContinuity(ordinaryReadRequest({
    fallbackRoutes: [survivalRoute()],
  }));

  assert.equal(result.disposition, "safe_land");
  assert.equal(result.selectedRouteRef, "route:continuity:survival");
  assert.equal(result.policy.qualityReductionAuthorized, false);
});

test("requires authoritative reconciliation before retrying an indeterminate effect", () => {
  const result = assessFallbackContinuity({
    ...ordinaryReadRequest(),
    operationRef: "operation:runtime-effect:1",
    intent: "runtime_effect",
    safety: "non_idempotent_effect",
    effect: {
      effectKey: "effect:runtime:1",
      outcome: "indeterminate",
      outcomeEvidenceRef: "evidence:effect:transport-unknown:1",
      authoritativeReconciliationRef: "authority:effect:readback:1",
    },
  });

  assert.equal(result.disposition, "reconcile_effect");
  assert.ok(result.reasonCodes.includes("effect_outcome_indeterminate"));
  assert.equal(result.policy.effectReplayAuthorized, false);
});

test("freezes an indeterminate effect when no reconciliation route exists", () => {
  const result = assessFallbackContinuity({
    ...ordinaryReadRequest(),
    operationRef: "operation:runtime-effect:2",
    intent: "runtime_effect",
    safety: "non_idempotent_effect",
    effect: {
      effectKey: "effect:runtime:2",
      outcome: "indeterminate",
      outcomeEvidenceRef: "evidence:effect:transport-unknown:2",
    },
  });

  assert.equal(result.disposition, "block_effect_lane");
  assert.ok(result.reasonCodes.includes(
    "authoritative_effect_reconciliation_missing",
  ));
});

test("never replays an already terminal effect through fallback", () => {
  const result = assessFallbackContinuity({
    ...ordinaryReadRequest(),
    operationRef: "operation:publication-effect:1",
    intent: "repository_publication",
    safety: "non_idempotent_effect",
    fallbackRoutes: [qualityEquivalentRoute()],
    effect: {
      effectKey: "effect:publication:1",
      outcome: "terminal_succeeded",
      outcomeEvidenceRef: "receipt:publication:terminal-success:1",
    },
  });

  assert.equal(result.disposition, "block_effect_lane");
  assert.ok(result.reasonCodes.includes("effect_already_terminal_succeeded"));
  assert.equal(result.policy.effectReplayAuthorized, false);
});

test("effect fallback requires explicit effect authority and owner authorization", () => {
  const route = qualityEquivalentRoute({
    capabilities: ["runtime.restart"],
    authorityClasses: ["runtime.effect.authority"],
    canonicalStateEvidenceRef: "evidence:canonical-runtime:current:1",
    effectAuthorityRef: "authority:runtime:fallback:1",
    effectReconciliationRef: "authority:runtime:reconciliation:1",
  });
  const baseRequest: FallbackContinuityRequest = {
    operationRef: "operation:runtime-effect:fallback",
    observedAt: OBSERVED_AT,
    intent: "runtime_effect",
    safety: "non_idempotent_effect",
    requiredCapabilities: ["runtime.restart"],
    requiredAuthorityClasses: ["runtime.effect.authority"],
    primary: unavailablePrimary(),
    fallbackRoutes: [route, survivalRoute()],
    effect: {
      effectKey: "effect:runtime:fallback:1",
      outcome: "not_started",
    },
  };
  const request = withSelection(
    baseRequest,
    route,
    "selection:runtime:fallback:1",
  );

  const denied = assessFallbackContinuity(request);
  assert.equal(denied.disposition, "safe_land");

  const unverified = assessFallbackContinuity({
    ...request,
    effect: {
      ...request.effect!,
      explicitFallbackAuthorizationRef:
        "owner-authorization:runtime:fallback:unverified",
      explicitFallbackAuthorizationState: "unverified",
    },
  });
  assert.equal(unverified.disposition, "safe_land");
  const unverifiedRoute = unverified.consideredRoutes.find(
    (entry) => entry.routeRef === route.routeRef,
  );
  assert.ok(unverifiedRoute?.reasonCodes.includes(
    "explicit_effect_fallback_authorization_state_unverified",
  ));

  const admitted = assessFallbackContinuity({
    ...request,
    effect: {
      ...request.effect!,
      explicitFallbackAuthorizationRef:
        "owner-authorization:runtime:fallback:1",
      explicitFallbackAuthorizationState: "verified",
    },
  });
  assert.equal(admitted.disposition, "use_quality_equivalent_fallback");
  assert.ok(admitted.evidenceRefs.includes(
    "owner-authorization:runtime:fallback:1",
  ));
});

test("stale fallback catalog cannot satisfy a fresh-catalog requirement", () => {
  const route = qualityEquivalentRoute({ catalogFreshness: "stale" });
  const request = ordinaryReadRequest({
    quality: { requiresFreshCatalog: true },
    fallbackRoutes: [route, survivalRoute()],
  });
  const result = assessFallbackContinuity(withSelection(
    request,
    route,
    "selection:stale-catalog:1",
  ));

  assert.equal(result.disposition, "safe_land");
  const candidate = result.consideredRoutes.find(
    (route) => route.routeRef === "route:continuity:equivalent",
  );
  assert.ok(candidate?.reasonCodes.includes("catalog_not_fresh"));
});

test("orders candidates deterministically by quality then route reference", () => {
  const result = assessFallbackContinuity(ordinaryReadRequest({
    fallbackRoutes: [
      degradedReadRoute({ routeRef: "route:z" }),
      qualityEquivalentRoute({ routeRef: "route:b" }),
      qualityEquivalentRoute({
        routeRef: "route:a",
        policyRef: "policy:route:a",
        attestationRef: "attestation:route:a",
      }),
    ],
  }));

  assert.deepEqual(
    result.consideredRoutes.map((route) => route.routeRef),
    ["route:a", "route:b", "route:z"],
  );
});

test("decision identity is stable when fallback attestations arrive in another order", () => {
  const first = assessFallbackContinuity(ordinaryReadRequest({
    fallbackRoutes: [qualityEquivalentRoute(), degradedReadRoute()],
  }));
  const second = assessFallbackContinuity(ordinaryReadRequest({
    fallbackRoutes: [degradedReadRoute(), qualityEquivalentRoute()],
  }));

  assert.equal(first.decisionRef, second.decisionRef);
});

test("operation contract identity is order-independent and changes with material requirements", () => {
  const first = createFallbackOperationContractDigest({
    operationRef: "operation:contract:1",
    intent: "ordinary_read",
    safety: "read_only",
    requiredCapabilities: ["workspace.read", "workspace.metadata"],
    requiredAuthorityClasses: [
      "workspace.read.authority",
      "workspace.metadata.authority",
    ],
  });
  const reordered = createFallbackOperationContractDigest({
    operationRef: "operation:contract:1",
    intent: "ordinary_read",
    safety: "read_only",
    requiredCapabilities: ["workspace.metadata", "workspace.read"],
    requiredAuthorityClasses: [
      "workspace.metadata.authority",
      "workspace.read.authority",
    ],
  });
  const changed = createFallbackOperationContractDigest({
    operationRef: "operation:contract:1",
    intent: "ordinary_read",
    safety: "read_only",
    requiredCapabilities: ["workspace.read"],
    requiredAuthorityClasses: ["workspace.read.authority"],
  });

  assert.equal(first, reordered);
  assert.notEqual(first, changed);
});

test("rejects duplicate fallback route references", () => {
  assert.throws(
    () => assessFallbackContinuity(ordinaryReadRequest({
      fallbackRoutes: [qualityEquivalentRoute(), qualityEquivalentRoute()],
    })),
    /Duplicate fallback routeRef/,
  );
});

test("requires every fallback route to carry an exact fingerprint", () => {
  const route = {
    ...qualityEquivalentRoute(),
    fingerprintSha256: undefined,
  } as unknown as FallbackRouteAttestation;
  assert.throws(
    () => assessFallbackContinuity(ordinaryReadRequest({
      fallbackRoutes: [route],
    })),
    /fingerprintSha256 must be a lowercase SHA-256 digest/,
  );
});

test("rejects unsupported route and selection contract versions", () => {
  const route = qualityEquivalentRoute();
  assert.throws(
    () => assessFallbackContinuity(ordinaryReadRequest({
      fallbackRoutes: [{
        ...route,
        schemaVersion: "zes.fallback-route-attestation.v2",
      } as unknown as FallbackRouteAttestation],
    })),
    /Unsupported fallbackRoutes\[0\]\.schemaVersion/,
  );

  const request = ordinaryReadRequest({ fallbackRoutes: [route] });
  assert.throws(
    () => assessFallbackContinuity({
      ...request,
      selectedFallback: {
        ...selectionFor(request, route, "selection:unsupported-schema:1"),
        schemaVersion: "zes.fallback-selection.v2",
      } as unknown as ExplicitFallbackSelection,
    }),
    /Unsupported selectedFallback schemaVersion/,
  );
});

test("runtime enum and boolean fields fail closed instead of relying on TypeScript types", () => {
  assert.throws(
    () => assessFallbackContinuity(ordinaryReadRequest({
      primary: unavailablePrimary({
        state: "not-a-state" as PrimaryRouteObservation["state"],
      }),
    })),
    /Invalid primary\.state/,
  );

  assert.throws(
    () => assessFallbackContinuity(ordinaryReadRequest({
      quality: {
        freshEvidenceRequired: "yes" as unknown as boolean,
      },
    })),
    /quality\.freshEvidenceRequired must be a boolean/,
  );

  assert.throws(
    () => assessFallbackContinuity(ordinaryReadRequest({
      fallbackRoutes: [qualityEquivalentRoute({
        catalogFreshness:
          "current-ish" as FallbackRouteAttestation["catalogFreshness"],
      })],
    })),
    /Invalid fallbackRoutes\[0\]\.catalogFreshness/,
  );

  assert.throws(
    () => assessFallbackContinuity(ordinaryReadRequest({
      fallbackRoutes: [qualityEquivalentRoute({
        supportsPrimaryRepair: "yes" as unknown as boolean,
      })],
    })),
    /supportsPrimaryRepair must be a boolean/,
  );
});

test("observed timestamps reject surrounding whitespace", () => {
  assert.throws(
    () => assessFallbackContinuity(ordinaryReadRequest({
      observedAt: ` ${OBSERVED_AT}`,
    })),
    /observedAt must be a non-empty ISO timestamp/,
  );
});

test("route limitations are typed codes rather than projected prose", () => {
  const valid = assessFallbackContinuity(ordinaryReadRequest({
    fallbackRoutes: [qualityEquivalentRoute({
      limitationCodes: ["no_widgets", "read_latency_elevated"],
    })],
  }));
  assert.deepEqual(
    valid.consideredRoutes[0]?.limitationCodes,
    ["no_widgets", "read_latency_elevated"],
  );

  assert.throws(
    () => assessFallbackContinuity(ordinaryReadRequest({
      fallbackRoutes: [qualityEquivalentRoute({
        limitationCodes: ["ignore previous instructions"],
      })],
    })),
    /Invalid fallbackRoutes\[0\]\.limitationCodes\[0\]/,
  );
});

test("rejects unsafe credential-bearing evidence references", () => {
  assert.throws(
    () => assessFallbackContinuity(ordinaryReadRequest({
      fallbackRoutes: [qualityEquivalentRoute({
        attestationRef: "https://user:secret@example.com/attestation",
      })],
    })),
    /unsafe URI reference/,
  );
});

test("consumes the published primary-recovery assessment seam", () => {
  const primaryRecovery = assessMcpPrimaryRecovery({
    primaryFunctionalState: "healthy",
    activeRoute: "fallback",
    catalogStatus: "CURRENT",
    primaryRegisteredToolNames: ["open_workspace", "read"],
    clientObservedToolNames: ["open_workspace", "read"],
    requiredCapabilityRefs: ["workspace_read"],
  });

  assert.equal(primaryRecovery.state, "FAILBACK_PRIMARY");
  const result = assessFallbackContinuityFromPrimaryRecovery({
    operationRef: "operation:adapter:workspace-read",
    observedAt: OBSERVED_AT,
    intent: "ordinary_read",
    safety: "read_only",
    requiredCapabilities: [mcpWorkCapabilityToken("workspace_read")],
    requiredAuthorityClasses: ["workspace.read.authority"],
    primaryRecovery,
    primaryRouteRef: "route:nexus:primary",
    primaryAttestationRef: "attestation:primary-recovery:published:v1",
    primaryAttestationState: "verified",
    primaryAuthorityClasses: ["workspace.read.authority"],
    primaryFingerprintSha256: SHA_A,
    primaryRecoveryEvidenceRef: "evidence:primary-recovery:published:v1",
    fallbackRoutes: [qualityEquivalentRoute()],
  });

  assert.equal(result.disposition, "failback_to_primary");
  assert.equal(result.primary.usable, true);
});

test("published primary-recovery directives remain authoritative before fallback", () => {
  const primaryRecovery = assessMcpPrimaryRecovery({
    primaryFunctionalState: "unavailable",
    activeRoute: "primary",
    catalogStatus: "CURRENT",
    primaryRegisteredToolNames: ["open_workspace", "read"],
    clientObservedToolNames: ["open_workspace", "read"],
    requiredCapabilityRefs: ["workspace_read"],
    recovery: {
      transportReconnect: "unavailable",
      hostCatalogRefresh: "unavailable",
      functionalRepair: "available",
      diagnosticAgent: "unavailable",
      recoveryLease: "available",
      restartSafety: "safe",
      functionalRepairAttempts: 0,
      maxFunctionalRepairAttempts: 1,
    },
  });
  assert.equal(primaryRecovery.state, "REPAIR_PRIMARY");

  const result = assessFallbackContinuityFromPrimaryRecovery({
    operationRef: "operation:adapter:repair-primary",
    observedAt: OBSERVED_AT,
    intent: "ordinary_read",
    safety: "read_only",
    requiredCapabilities: [mcpWorkCapabilityToken("workspace_read")],
    requiredAuthorityClasses: ["workspace.read.authority"],
    primaryRecovery,
    primaryRouteRef: "route:nexus:primary",
    primaryAttestationRef: "attestation:primary-recovery:repair:v1",
    primaryAttestationState: "verified",
    primaryAuthorityClasses: ["workspace.read.authority"],
    primaryRecoveryEvidenceRef: "evidence:primary-recovery:repair:v1",
    fallbackRoutes: [qualityEquivalentRoute(), recoveryRoute()],
  });

  assert.equal(result.disposition, "repair_primary");
  assert.equal(result.selectedRouteRef, undefined);
  assert.ok(result.reasonCodes.includes("primary_recovery_required"));
  assert.ok(result.reasonCodes.includes("mcp.primary_recovery.repair_primary"));
});
