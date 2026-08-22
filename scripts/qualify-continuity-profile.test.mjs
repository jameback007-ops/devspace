import assert from "node:assert/strict";
import test from "node:test";
import { qualifyContinuityProbe } from "./qualify-continuity-profile.mjs";

function fixture() {
  const fingerprint = "a".repeat(64);
  return {
    schemaVersion: "zes.tool-surface-probe.v1",
    backend: {
      implementation: "devspace-continuity",
      packageVersion: "1.0.7",
      mcpServerVersion: "1.0.7-continuity.1",
    },
    configuration: { toolMode: "continuity" },
    toolSurface: {
      fingerprintSha256: fingerprint,
      toolCount: 2,
      toolNames: ["open_workspace", "read"],
    },
    continuityProfile: {
      schemaVersion: "devspace.continuity-profile.v1",
      profileRef: "devspace.continuity-profile.v1",
      policyRef: "policy:devspace:degraded-operational-continuity:v1",
      state: "ready",
      surface: {
        surfaceEpoch: "continuity:test",
        fingerprintSha256: fingerprint,
        requiredTools: ["open_workspace", "read"],
        missingRequiredTools: [],
      },
      operatingContract: {
        primaryRepairFirst: true,
        repairExhaustionRequiredBeforeMissionFallback: true,
        operationScopedSelectionRequired: true,
        exactSurfaceAttestationRequired: true,
        deterministicFailbackRequired: true,
        isolatedWorkspaceMutationPermitted: true,
        processContinuationPermitted: true,
        executorLocalCheckpointPermitted: true,
        continuityLocalPeerHandoffPermitted: true,
        destructiveWorkspaceLifecyclePermitted: false,
        freshResearchClaimPermitted: false,
        repositoryPublicationPermitted: false,
        runtimeDeploymentPermitted: false,
        conversationEffectPermitted: false,
        effectReplayPermitted: false,
      },
      authority: {
        canonicalTaskOrDecisionAuthority: false,
        writerLeaseAuthority: false,
        publicationAuthority: false,
        runtimeActivationAuthority: false,
        effectReplayAuthority: false,
      },
    },
  };
}

test("qualifies an exact continuity profile", () => {
  const probe = fixture();
  const result = qualifyContinuityProbe(
    probe,
    Buffer.from(JSON.stringify(probe)),
  );
  assert.equal(result.outcome, "passed");
  assert.equal(result.toolCount, 2);
  assert.equal(result.requiredToolCount, 2);
  assert.match(result.probeDigestSha256, /^[a-f0-9]{64}$/);
});

test("rejects an authority-bearing tool in continuity mode", () => {
  const probe = fixture();
  probe.toolSurface.toolNames.push("self_repository_publish");
  probe.toolSurface.toolCount += 1;
  assert.throws(
    () => qualifyContinuityProbe(
      probe,
      Buffer.from(JSON.stringify(probe)),
    ),
    /forbidden continuity tool present: self_repository_publish/,
  );
});
