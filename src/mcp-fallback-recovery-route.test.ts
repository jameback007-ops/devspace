import assert from "node:assert/strict";
import test from "node:test";
import { assessMcpPrimaryRecovery } from "./mcp-primary-recovery.js";
import { projectMcpFallbackRecovery } from "./mcp-fallback-recovery-route.js";

const OBSERVED_AT = "2026-08-22T00:00:00.000Z";
const PRIMARY_TOOLS = ["execution_scope_status", "open_workspace", "read"];

function legacyRecoveryObservation(selectionRef?: string) {
  return {
    routeRef: "route:legacy:host",
    routeKind: "legacy" as const,
    routeReachable: true,
    observedToolNames: [
      "open_workspace",
      "read",
      "apply_patch",
      "exec_command",
      "write_stdin",
      "download_artifact",
    ],
    observedFingerprintSha256: "a".repeat(64),
    fingerprintBasis: "canonical_complete_mcp_tools_list_descriptors",
    attestationState: "verified" as const,
    attestationRef: "attestation:legacy:live:v1",
    policyRef: "policy:legacy:recovery-only:v1",
    stateIsolationEvidenceRef: "evidence:legacy:nexus-state-isolated:v1",
    authorityIsolationEvidenceRef: "evidence:legacy:no-mission-authority:v1",
    failureDomainEvidenceRef: "evidence:legacy:independent-service:v1",
    recoveryAuthorityRef: "authority:owner:primary-repair:v1",
    failbackProbeEvidenceRef: "probe:nexus:ready-surface:v1",
    selectionRef,
  };
}

test("Legacy repair plane does not require the Nexus bootstrap ABI", () => {
  const primaryRecovery = assessMcpPrimaryRecovery({
    primaryFunctionalState: "unavailable",
    catalogStatus: "INDETERMINATE",
    primaryRegisteredToolNames: PRIMARY_TOOLS,
    requiredCapabilityRefs: ["workspace_read"],
    recovery: {
      transportReconnect: "unavailable",
      hostCatalogRefresh: "unavailable",
      functionalRepair: "unavailable",
      diagnosticAgent: "unavailable",
    },
  });
  assert.equal(primaryRecovery.state, "SAFE_TURN_LANDING");
  const projection = projectMcpFallbackRecovery({
    assessedAt: OBSERVED_AT,
    primaryRecovery,
    primaryRouteRef: "route:nexus:primary",
    primaryAttestationRef: "attestation:nexus:outage:v1",
    primaryAttestationState: "verified",
    primaryRecoveryEvidenceRef: "evidence:nexus:recovery-exhausted:v1",
    fallback: legacyRecoveryObservation(),
  });
  assert.equal(
    projection.routeObservation.nexusBootstrapToolPresent,
    false,
  );
  assert.equal(
    projection.routeObservation.nexusBootstrapToolRequiredForRepair,
    false,
  );
  assert.deepEqual(projection.routeObservation.missingRepairTools, []);
  assert.ok(
    projection.routeObservation.requiredRepairTools.includes("apply_patch"),
  );
  assert.equal(projection.state, "RECOVERY_ROUTE_SELECTION_REQUIRED");
  assert.equal(
    projection.decision.disposition,
    "fallback_selection_required",
  );
});

test("operation-scoped selection admits only recovery work", () => {
  const primaryRecovery = assessMcpPrimaryRecovery({
    primaryFunctionalState: "unavailable",
    catalogStatus: "INDETERMINATE",
    primaryRegisteredToolNames: PRIMARY_TOOLS,
    requiredCapabilityRefs: ["workspace_read"],
    recovery: {
      transportReconnect: "unavailable",
      hostCatalogRefresh: "unavailable",
      functionalRepair: "unavailable",
      diagnosticAgent: "unavailable",
    },
  });
  const projection = projectMcpFallbackRecovery({
    assessedAt: OBSERVED_AT,
    primaryRecovery,
    primaryRouteRef: "route:nexus:primary",
    primaryAttestationRef: "attestation:nexus:outage:v1",
    primaryAttestationState: "verified",
    primaryRecoveryEvidenceRef: "evidence:nexus:recovery-exhausted:v1",
    fallback: legacyRecoveryObservation("selection:legacy:repair:v1"),
  });
  assert.equal(projection.state, "RECOVERY_ROUTE_SELECTED");
  assert.equal(
    projection.decision.disposition,
    "use_recovery_only_fallback",
  );
  assert.equal(
    projection.policy.recoveryOnlyRouteGrantsNoMissionAuthority,
    true,
  );
  assert.equal(projection.selection.state, "selected");
  assert.equal(projection.selection.repairInvocationAuthorized, false);
  assert.equal(
    projection.selection.repairEffectGateRequiredBeforeMutation,
    true,
  );
  assert.equal(projection.selection.callerEvidenceVerifiedByServer, false);
  assert.equal(
    projection.policy.recoveryRouteSelectionAuthorizesRepairEffect,
    false,
  );
  assert.equal(projection.policy.sourceRepairRequiresApplyPatch, true);
  assert.match(projection.exactNextAction, /no repair invocation is authorized/);
  assert.equal(projection.policy.routeInvocationPerformed, false);
});

test("verified primary recovery forces failback before mission work", () => {
  const primaryRecovery = assessMcpPrimaryRecovery({
    primaryFunctionalState: "healthy",
    activeRoute: "fallback",
    catalogStatus: "CURRENT",
    primaryRegisteredToolNames: PRIMARY_TOOLS,
    clientObservedToolNames: PRIMARY_TOOLS,
    requiredCapabilityRefs: ["workspace_read"],
  });
  assert.equal(primaryRecovery.state, "FAILBACK_PRIMARY");
  const projection = projectMcpFallbackRecovery({
    assessedAt: OBSERVED_AT,
    primaryRecovery,
    primaryRouteRef: "route:nexus:primary",
    primaryAttestationRef: "attestation:nexus:recovered:v1",
    primaryAttestationState: "verified",
    primaryFingerprintSha256: "b".repeat(64),
    primaryRecoveryEvidenceRef: "evidence:nexus:recovered:v1",
    fallback: legacyRecoveryObservation("selection:legacy:repair:v1"),
  });
  assert.equal(projection.state, "FAILBACK_PRIMARY");
  assert.equal(projection.decision.disposition, "failback_to_primary");
  assert.match(projection.exactNextAction, /back to the verified primary/);
});

test("reachable but incompletely attested Legacy route is not repair eligible", () => {
  const primaryRecovery = assessMcpPrimaryRecovery({
    primaryFunctionalState: "unavailable",
    catalogStatus: "INDETERMINATE",
    primaryRegisteredToolNames: PRIMARY_TOOLS,
    recovery: {
      transportReconnect: "unavailable",
      functionalRepair: "unavailable",
      diagnosticAgent: "unavailable",
    },
  });
  const projection = projectMcpFallbackRecovery({
    assessedAt: OBSERVED_AT,
    primaryRecovery,
    primaryRouteRef: "route:nexus:primary",
    primaryAttestationRef: "attestation:nexus:outage:v1",
    primaryAttestationState: "verified",
    fallback: {
      routeReachable: true,
      observedToolNames: [
        "open_workspace",
        "read",
        "exec_command",
        "write_stdin",
      ],
    },
  });
  assert.equal(
    projection.routeObservation.state,
    "observed_reachable_incomplete",
  );
  assert.deepEqual(projection.routeObservation.missingRepairTools, [
    "apply_patch",
  ]);
  assert.equal(projection.selection.state, "route_incomplete");
  assert.notEqual(projection.state, "RECOVERY_ROUTE_SELECTED");
});
