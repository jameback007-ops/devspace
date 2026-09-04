import assert from "node:assert/strict";
import test from "node:test";
import {
  projectMissionFinalization,
  type MissionFinalizationDeclaration,
  type MissionFinalizationProjectionInput,
} from "./mission-finalization.js";

const candidateRef = "git:1111111111111111111111111111111111111111";

function completeDeclaration(): MissionFinalizationDeclaration {
  return {
    contract: {
      contractRef: "gate:mission-finalization:v1",
      candidateRef,
      requiredFactors: [
        "validation_receipt_bound_to_candidate",
        "publication_or_effect_terminal_receipt",
        "authoritative_post_effect_readback",
      ],
      claimCeiling: "Exact candidate and declared mission closure only.",
    },
    decision: {
      disposition: "COMPLETE_VERIFIED",
      decisionRef: "decision:mission-closed:1",
      authorityRef: "authority:mission-owner:1",
      candidateRef,
      factorEvidence: [
        {
          factor: "accepted_landing_state",
          evidenceState: "observed",
          candidateRef,
          authorityRef: "authority:mission-owner:1",
          evidenceRefs: ["decision:landing-accepted:1"],
        },
        {
          factor: "declared_obligations",
          evidenceState: "observed",
          candidateRef,
          authorityRef: "authority:mission-owner:1",
          evidenceRefs: ["receipt:deliverables:1", "receipt:obligations:1"],
        },
        {
          factor: "validation_receipt_bound_to_candidate",
          evidenceState: "observed",
          candidateRef,
          authorityRef: "authority:validation-owner:1",
          evidenceRefs: ["receipt:validation:1"],
        },
        {
          factor: "publication_or_effect_terminal_receipt",
          evidenceState: "terminal",
          candidateRef,
          authorityRef: "authority:publication-owner:1",
          effectKeys: ["effect:publication:1"],
          evidenceRefs: ["receipt:publication:terminal:1"],
        },
      ],
    },
  };
}

function completeInput(): MissionFinalizationProjectionInput {
  return {
    declaration: completeDeclaration(),
    assessedAt: "2026-09-04T15:00:00.000Z",
    semanticRecovery: {
      available: true,
      missionRef: "MISSION-1",
      capsule: {
        capsuleId: "rcp_1",
        recordedAt: "2026-09-04T14:59:59.000Z",
      },
      validation: {
        state: "passed",
        refs: ["receipt:validation:1", candidateRef],
      },
      worktree: {
        declaredState: "clean",
        workspaceFreshness: "fresh",
      },
      effect: {
        state: "terminal",
        keys: ["effect:publication:1"],
        retryPolicy: "forbidden",
      },
      activitySinceCapsule: {
        potentialMutationAfterCapsule: false,
      },
    },
    turnLanding: {
      semanticCapsuleState: "current_for_observed_mutation",
      processOrEffectReconciliationRequired: false,
      policy: {
        taskCompletionRequired: false,
      },
    },
    directiveSummary: {
      unactedDirectiveCount: 0,
      unactedInstructionCount: 0,
      unactedCorrectionCount: 0,
      evidenceRefs: [],
    },
    authoritativeObservations: [
      {
        factor: "authoritative_post_effect_readback",
        candidateRef,
        authorityRef: "authority:remote-main:1",
        evidenceRefs: ["readback:remote-main:1"],
        observedAt: "2026-09-04T15:00:00.000Z",
        state: "satisfied",
      },
    ],
  };
}

test("R5-like dirty planned candidate cannot satisfy mission finalization", () => {
  const projection = projectMissionFinalization({
    assessedAt: "2026-09-04T15:00:00.000Z",
    semanticRecovery: {
      available: true,
      missionRef: "P2-CP02-R5",
      currentFrontier: "rich planned deliverables and acceptance text",
      established: [
        "candidate files formed",
        "validator planned",
        "publication planned",
      ],
      capsule: {
        capsuleId: "rcp_r5_dirty",
        recordedAt: "2026-09-04T14:59:59.000Z",
      },
      validation: { state: "partial", refs: [] },
      worktree: {
        declaredState: "intentional_dirty",
        workspaceFreshness: "fresh",
      },
      effect: { state: "none", keys: [] },
      activitySinceCapsule: { potentialMutationAfterCapsule: false },
    },
    turnLanding: {
      semanticCapsuleState: "current_for_observed_mutation",
      processOrEffectReconciliationRequired: false,
    },
    directiveSummary: {
      unactedDirectiveCount: 0,
      unactedInstructionCount: 0,
      unactedCorrectionCount: 0,
      evidenceRefs: [],
    },
  });

  assert.equal(projection.disposition, "PARTIAL_CONTINUE");
  assert.equal(projection.completionClaimAllowed, false);
  assert.ok(
    projection.blockingFactors.includes("explicit_closure_contract_missing"),
  );
  assert.match(
    projection.recommendedResponsePosture,
    /Do not use unqualified completion, publication, validation/i,
  );
  assert.equal(projection.policy.plannedTextCountsAsEvidence, false);
});

test("an exact fresh terminal closure may allow COMPLETE_VERIFIED", () => {
  const projection = projectMissionFinalization(completeInput());
  assert.equal(projection.disposition, "COMPLETE_VERIFIED");
  assert.equal(projection.completionClaimAllowed, true);
  assert.equal(projection.evidenceFreshness, "fresh");
  assert.deepEqual(projection.blockingFactors, []);
  assert.equal(
    projection.satisfiedFactors.length,
    projection.requiredFactors.length,
  );
});

test("a capsule made stale by later mutation denies completion", () => {
  const input = completeInput();
  input.semanticRecovery = {
    ...(input.semanticRecovery as Record<string, unknown>),
    activitySinceCapsule: {
      potentialMutationAfterCapsule: true,
      latestPotentialMutationAt: "2026-09-04T15:00:01.000Z",
    },
  };
  input.turnLanding = {
    semanticCapsuleState: "changed_since_capsule",
    processOrEffectReconciliationRequired: false,
  };
  const projection = projectMissionFinalization(input);
  assert.equal(projection.disposition, "PARTIAL_CONTINUE");
  assert.equal(projection.completionClaimAllowed, false);
  assert.equal(projection.evidenceFreshness, "stale");
  assert.ok(
    projection.blockingFactors.includes("recovery_capsule_stale_after_mutation"),
  );
});

test("an unknown publication or effect outcome returns BLOCKED", () => {
  const input = completeInput();
  input.semanticRecovery = {
    ...(input.semanticRecovery as Record<string, unknown>),
    effect: {
      state: "unknown",
      keys: ["effect:publication:1"],
      retryPolicy: "reconcile_before_retry",
    },
  };
  input.turnLanding = {
    semanticCapsuleState: "current_for_observed_mutation",
    processOrEffectReconciliationRequired: true,
  };
  const projection = projectMissionFinalization(input);
  assert.equal(projection.disposition, "BLOCKED");
  assert.equal(projection.completionClaimAllowed, false);
  assert.ok(
    projection.blockingFactors.includes(
      "unknown_or_in_flight_effect_requires_reconciliation",
    ),
  );
});

test("a clean candidate without explicit semantic closure remains partial", () => {
  const input = completeInput();
  delete input.declaration;
  const projection = projectMissionFinalization(input);
  assert.equal(projection.disposition, "PARTIAL_CONTINUE");
  assert.equal(projection.completionClaimAllowed, false);
  assert.ok(
    projection.blockingFactors.includes(
      "explicit_semantic_closure_decision_missing",
    ),
  );
});

test("a terminal receipt with no fresh authoritative readback remains partial", () => {
  const input = completeInput();
  input.authoritativeObservations = [
    {
      factor: "authoritative_post_effect_readback",
      candidateRef,
      authorityRef: "authority:remote-main:stale",
      evidenceRefs: ["readback:remote-main:stale"],
      observedAt: "2026-09-04T14:00:00.000Z",
      state: "blocked",
    },
  ];
  const projection = projectMissionFinalization(input);
  assert.equal(projection.disposition, "PARTIAL_CONTINUE");
  assert.equal(projection.completionClaimAllowed, false);
  assert.ok(
    projection.blockingFactors.includes(
      "required_factor_unsatisfied:authoritative_post_effect_readback",
    ),
  );
});

test("a natural landing near the turn horizon never requires mission completion", () => {
  const projection = projectMissionFinalization({
    assessedAt: "2026-09-04T15:00:00.000Z",
    turnLanding: {
      classification: "automatic_envelope_with_stale_or_missing_semantic_capsule",
      semanticCapsuleState: "missing",
      processOrEffectReconciliationRequired: false,
      policy: {
        taskCompletionRequired: false,
        commitRequired: false,
      },
    },
  });
  assert.equal(projection.disposition, "PARTIAL_CONTINUE");
  assert.equal(projection.completionClaimAllowed, false);
  assert.equal(projection.policy.taskCompletionRequired, false);
  assert.equal(projection.policy.forcedCommitOrCompletionRequired, false);
});

test("planned factor evidence cannot satisfy a COMPLETE_VERIFIED declaration", () => {
  const input = completeInput();
  const declaration = completeDeclaration();
  declaration.decision!.factorEvidence = declaration.decision!.factorEvidence.map(
    (entry) => ({ ...entry, evidenceState: "planned" as const }),
  );
  input.declaration = declaration;
  const projection = projectMissionFinalization(input);
  assert.equal(projection.disposition, "PARTIAL_CONTINUE");
  assert.equal(projection.completionClaimAllowed, false);
  assert.ok(
    projection.blockingFactors.includes(
      "declared_obligations_evidence_missing",
    ),
  );
  assert.ok(
    projection.blockingFactors.includes(
      "required_factor_unsatisfied:publication_or_effect_terminal_receipt",
    ),
  );
});

test("a claimed current landing without capsule identity and time fails closed", () => {
  const input = completeInput();
  input.semanticRecovery = {
    ...(input.semanticRecovery as Record<string, unknown>),
    capsule: {},
  };
  const projection = projectMissionFinalization(input);
  assert.equal(projection.disposition, "PARTIAL_CONTINUE");
  assert.equal(projection.completionClaimAllowed, false);
  assert.ok(
    projection.blockingFactors.includes(
      "recovery_capsule_not_current_for_observed_mutation",
    ),
  );
  assert.ok(
    projection.blockingFactors.includes("landing_state_not_explicitly_accepted"),
  );
});

test("missing owner-directive readback cannot be treated as no correction", () => {
  const input = completeInput();
  delete input.directiveSummary;
  const projection = projectMissionFinalization(input);
  assert.equal(projection.disposition, "PARTIAL_CONTINUE");
  assert.equal(projection.completionClaimAllowed, false);
  assert.ok(
    projection.blockingFactors.includes("owner_directive_readback_unavailable"),
  );
});

test("candidate identity mismatch is contradictory and denies completion", () => {
  const input = completeInput();
  input.declaration = completeDeclaration();
  input.declaration.decision!.candidateRef =
    "git:2222222222222222222222222222222222222222";
  const projection = projectMissionFinalization(input);
  assert.equal(projection.disposition, "PARTIAL_CONTINUE");
  assert.equal(projection.completionClaimAllowed, false);
  assert.equal(projection.evidenceFreshness, "contradictory");
  assert.ok(
    projection.blockingFactors.includes(
      "candidate_identity_mismatch_between_contract_and_decision",
    ),
  );
});

test("credential-bearing and whitespace-normalized evidence references are rejected", () => {
  const credentialInput = completeDeclaration();
  credentialInput.decision!.factorEvidence[0]!.evidenceRefs = [
    "https://user:secret@example.test/receipt",
  ];
  assert.throws(
    () => projectMissionFinalization({ declaration: credentialInput }),
    /credential-bearing URI material/,
  );

  const whitespaceInput = completeDeclaration();
  whitespaceInput.contract.contractRef = " gate:trimmed-by-accident ";
  assert.throws(
    () => projectMissionFinalization({ declaration: whitespaceInput }),
    /bounded opaque reference/,
  );
});
