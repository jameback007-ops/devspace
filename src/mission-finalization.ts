export const MISSION_FINALIZATION_FACTORS = [
  "explicit_closure_contract",
  "explicit_semantic_closure_decision",
  "declared_obligations",
  "exact_candidate_identity",
  "accepted_landing_state",
  "validation_receipt_bound_to_candidate",
  "publication_or_effect_terminal_receipt",
  "authoritative_post_effect_readback",
  "no_unknown_effect",
  "no_unacted_owner_correction",
  "recovery_refreshed_after_last_material_change",
] as const;

export type MissionFinalizationFactor =
  (typeof MISSION_FINALIZATION_FACTORS)[number];

export type MissionFinalizationDisposition =
  | "PARTIAL_CONTINUE"
  | "BLOCKED"
  | "COMPLETE_VERIFIED";

export interface MissionFinalizationContract {
  contractRef: string;
  candidateRef: string;
  requiredFactors: MissionFinalizationFactor[];
  claimCeiling: string;
}

export interface MissionFinalizationFactorEvidence {
  factor: MissionFinalizationFactor;
  evidenceState: "observed" | "terminal" | "planned" | "unknown";
  evidenceRefs: string[];
  candidateRef?: string;
  authorityRef?: string;
  effectKeys?: string[];
}

export interface MissionFinalizationDecision {
  disposition: MissionFinalizationDisposition;
  decisionRef: string;
  authorityRef: string;
  candidateRef: string;
  factorEvidence: MissionFinalizationFactorEvidence[];
  blockingFactors?: string[];
}

export interface MissionFinalizationDeclaration {
  contract: MissionFinalizationContract;
  decision?: MissionFinalizationDecision;
}

export interface MissionFinalizationDirectiveSummary {
  unactedDirectiveCount: number;
  unactedInstructionCount: number;
  unactedCorrectionCount: number;
  highestPriority?: "low" | "normal" | "high" | "urgent";
  evidenceRefs: string[];
}

export interface MissionFinalizationAuthoritativeObservation {
  factor:
    | "validation_receipt_bound_to_candidate"
    | "publication_or_effect_terminal_receipt"
    | "authoritative_post_effect_readback";
  candidateRef: string;
  authorityRef: string;
  evidenceRefs: string[];
  effectKeys?: string[];
  observedAt: string;
  state: "satisfied" | "blocked" | "unknown";
}

export interface MissionFinalizationProjectionInput {
  declaration?: MissionFinalizationDeclaration;
  semanticRecovery?: unknown;
  turnLanding?: unknown;
  scopePublicationPreflight?: unknown;
  directiveSummary?: MissionFinalizationDirectiveSummary;
  authoritativeObservations?: MissionFinalizationAuthoritativeObservation[];
  assessedAt?: string;
}

export interface MissionFinalizationSatisfiedFactor {
  factor: MissionFinalizationFactor;
  evidenceRefs: string[];
  sources: string[];
}

export interface MissionFinalizationProjection {
  schemaVersion: "devspace.mission-finalization.v1";
  capabilityRef: "devspace.mission-finalization.v1";
  disposition: MissionFinalizationDisposition;
  completionClaimAllowed: boolean;
  evidenceFreshness: "fresh" | "stale" | "unknown" | "contradictory";
  missionRef?: string;
  contractRef?: string;
  decisionRef?: string;
  candidateRef?: string;
  requiredFactors: MissionFinalizationFactor[];
  blockingFactors: string[];
  satisfiedFactors: MissionFinalizationSatisfiedFactor[];
  evidenceRefs: string[];
  claimCeiling: string;
  lastMaterialMutationEffectCheckpointRelation: {
    semanticCapsuleState: string;
    capsuleRecordedAt?: string;
    potentialMutationAfterCapsule?: boolean;
    latestPotentialMutationAt?: string;
    processOrEffectReconciliationRequired: boolean;
    effectState: string;
    effectKeys: string[];
  };
  recommendedResponsePosture: string;
  assessedAt: string;
  policy: {
    authority: "completion_claim_barrier_from_explicit_closure_and_native_evidence";
    turnEndIsMissionComplete: false;
    defaultDisposition: "PARTIAL_CONTINUE";
    plannedTextCountsAsEvidence: false;
    semanticClosureInferredFromFilesTestsCountsOrToolEvents: false;
    missingOrStaleFactorFailsClosed: true;
    taskCompletionRequired: false;
    forcedCommitOrCompletionRequired: false;
    partialDirtyLandingAllowedWithExactFrontier: true;
    canonicalTaskDecisionWriterEffectOrPublicationAuthorityGranted: false;
  };
}

const ALWAYS_REQUIRED_FACTORS: MissionFinalizationFactor[] = [
  "explicit_closure_contract",
  "explicit_semantic_closure_decision",
  "declared_obligations",
  "exact_candidate_identity",
  "accepted_landing_state",
  "no_unknown_effect",
  "no_unacted_owner_correction",
  "recovery_refreshed_after_last_material_change",
];

const MAX_TEXT_CHARACTERS = 4_000;
const MAX_REFS = 50;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter(Boolean)
    : [];
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

function boundedString(value: unknown, name: string): string {
  const text = stringValue(value);
  if (!text) throw new Error(`${name} must not be empty.`);
  if (text.length > MAX_TEXT_CHARACTERS) {
    throw new Error(`${name} exceeds the ${MAX_TEXT_CHARACTERS}-character limit.`);
  }
  return text;
}

function boundedReference(value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw new Error(`${name} must be a string reference.`);
  }
  if (
    value.length === 0
    || value !== value.trim()
    || value.length > MAX_TEXT_CHARACTERS
    || /[\u0000-\u001f\u007f\s]/.test(value)
    || value.includes("?")
    || value.includes("\\")
  ) {
    throw new Error(`${name} must be a bounded opaque reference.`);
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new Error(`${name} must be a valid safe URI reference.`);
    }
    if (parsed.username || parsed.password || parsed.search) {
      throw new Error(`${name} may not embed credential-bearing URI material.`);
    }
  }
  return value;
}

function boundedRefs(value: unknown, name: string): string[] {
  const refs = uniqueSorted(stringList(value));
  if (refs.length > MAX_REFS) {
    throw new Error(`${name} exceeds the ${MAX_REFS}-reference limit.`);
  }
  for (const ref of refs) boundedReference(ref, name);
  return refs;
}

function factorValue(value: unknown): MissionFinalizationFactor {
  if (
    typeof value === "string"
    && (MISSION_FINALIZATION_FACTORS as readonly string[]).includes(value)
  ) {
    return value as MissionFinalizationFactor;
  }
  throw new Error(`Unknown mission-finalization factor: ${String(value)}`);
}

function dispositionValue(value: unknown): MissionFinalizationDisposition {
  if (
    value === "PARTIAL_CONTINUE"
    || value === "BLOCKED"
    || value === "COMPLETE_VERIFIED"
  ) {
    return value;
  }
  throw new Error(`Unknown mission-finalization disposition: ${String(value)}`);
}

export function normalizeMissionFinalizationDeclaration(
  value: MissionFinalizationDeclaration | undefined,
): MissionFinalizationDeclaration | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || !isRecord(value.contract)) {
    throw new Error("missionFinalization.contract is required.");
  }
  const requiredFactors = uniqueSorted([
    ...ALWAYS_REQUIRED_FACTORS,
    ...(Array.isArray(value.contract.requiredFactors)
      ? value.contract.requiredFactors.map(factorValue)
      : []),
  ]) as MissionFinalizationFactor[];
  const contract: MissionFinalizationContract = {
    contractRef: boundedReference(
      value.contract.contractRef,
      "missionFinalization.contract.contractRef",
    ),
    candidateRef: boundedReference(
      value.contract.candidateRef,
      "missionFinalization.contract.candidateRef",
    ),
    requiredFactors,
    claimCeiling: boundedString(
      value.contract.claimCeiling,
      "missionFinalization.contract.claimCeiling",
    ),
  };
  if (value.decision === undefined) return { contract };
  if (!isRecord(value.decision)) {
    throw new Error("missionFinalization.decision must be an object.");
  }
  const evidenceInput = Array.isArray(value.decision.factorEvidence)
    ? value.decision.factorEvidence
    : [];
  if (evidenceInput.length > MAX_REFS) {
    throw new Error(
      `missionFinalization.decision.factorEvidence exceeds the ${MAX_REFS}-entry limit.`,
    );
  }
  const factorEvidence = evidenceInput.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new Error(
        `missionFinalization.decision.factorEvidence[${index}] must be an object.`,
      );
    }
    const candidateRef = stringValue(entry.candidateRef);
    const authorityRef = stringValue(entry.authorityRef);
    const evidenceState = entry.evidenceState;
    if (
      evidenceState !== "observed"
      && evidenceState !== "terminal"
      && evidenceState !== "planned"
      && evidenceState !== "unknown"
    ) {
      throw new Error(
        `missionFinalization.decision.factorEvidence[${index}].evidenceState is invalid.`,
      );
    }
    return {
      factor: factorValue(entry.factor),
      evidenceState,
      evidenceRefs: boundedRefs(
        entry.evidenceRefs,
        `missionFinalization.decision.factorEvidence[${index}].evidenceRefs`,
      ),
      ...(candidateRef
        ? {
            candidateRef: boundedReference(
              candidateRef,
              `missionFinalization.decision.factorEvidence[${index}].candidateRef`,
            ),
          }
        : {}),
      ...(authorityRef
        ? {
            authorityRef: boundedReference(
              authorityRef,
              `missionFinalization.decision.factorEvidence[${index}].authorityRef`,
            ),
          }
        : {}),
      effectKeys: boundedRefs(
        entry.effectKeys,
        `missionFinalization.decision.factorEvidence[${index}].effectKeys`,
      ),
    } satisfies MissionFinalizationFactorEvidence;
  });
  const decision: MissionFinalizationDecision = {
    disposition: dispositionValue(value.decision.disposition),
    decisionRef: boundedReference(
      value.decision.decisionRef,
      "missionFinalization.decision.decisionRef",
    ),
    authorityRef: boundedReference(
      value.decision.authorityRef,
      "missionFinalization.decision.authorityRef",
    ),
    candidateRef: boundedReference(
      value.decision.candidateRef,
      "missionFinalization.decision.candidateRef",
    ),
    factorEvidence,
    blockingFactors: boundedRefs(
      value.decision.blockingFactors,
      "missionFinalization.decision.blockingFactors",
    ),
  };
  return { contract, decision };
}

function recordAt(value: unknown, key: string): Record<string, unknown> | undefined {
  return isRecord(value) && isRecord(value[key])
    ? value[key] as Record<string, unknown>
    : undefined;
}

function factorEvidenceMap(
  decision: MissionFinalizationDecision | undefined,
): Map<MissionFinalizationFactor, MissionFinalizationFactorEvidence[]> {
  const result = new Map<
    MissionFinalizationFactor,
    MissionFinalizationFactorEvidence[]
  >();
  for (const evidence of decision?.factorEvidence ?? []) {
    const entries = result.get(evidence.factor) ?? [];
    entries.push(evidence);
    result.set(evidence.factor, entries);
  }
  return result;
}

function matchingEvidence(
  evidence: Map<MissionFinalizationFactor, MissionFinalizationFactorEvidence[]>,
  factor: MissionFinalizationFactor,
  candidateRef: string | undefined,
): MissionFinalizationFactorEvidence[] {
  return (evidence.get(factor) ?? []).filter((entry) =>
    entry.evidenceRefs.length > 0
    && entry.candidateRef === candidateRef
    && entry.authorityRef !== undefined
    && entry.authorityRef.length > 0
    && (
      factor === "publication_or_effect_terminal_receipt"
        ? entry.evidenceState === "terminal"
        : entry.evidenceState === "observed"
          || entry.evidenceState === "terminal"
    )
  );
}

function publicationObservations(
  preflight: unknown,
  candidateRef: string | undefined,
): MissionFinalizationAuthoritativeObservation[] {
  if (!candidateRef || !isRecord(preflight)) return [];
  const candidates = Array.isArray(preflight.candidates)
    ? preflight.candidates.filter(isRecord)
    : [];
  const observations: MissionFinalizationAuthoritativeObservation[] = [];
  for (const candidate of candidates) {
    const head = stringValue(candidate.candidateHeadSha);
    const remote = stringValue(candidate.authoritativeRemoteMainSha);
    if (!head || !remote) continue;
    const normalizedCandidate = candidateRef.startsWith("git:")
      ? candidateRef.slice(4)
      : candidateRef;
    if (head !== normalizedCandidate) continue;
    const authorityRef = `git:authoritative-remote-main:${remote}`;
    const evidenceRefs = uniqueSorted([
      ...stringList(candidate.evidenceRefs),
      authorityRef,
      `git:candidate-head:${head}`,
    ]);
    const observedAt = stringValue(preflight.assessedAt);
    if (!observedAt) continue;
    const currentOnAuthority = head === remote
      && candidate.publicationRequired === false
      && candidate.disposition === "not_required";
    observations.push({
      factor: "authoritative_post_effect_readback",
      candidateRef,
      authorityRef,
      evidenceRefs,
      observedAt,
      state: currentOnAuthority ? "satisfied" : "blocked",
    });
    if (candidate.validationBoundToCandidate === true) {
      observations.push({
        factor: "validation_receipt_bound_to_candidate",
        candidateRef,
        authorityRef: "scope-publication-preflight:native-validation-binding",
        evidenceRefs: uniqueSorted([
          ...evidenceRefs,
          `scope-publication-preflight:validation-bound:${head}`,
        ]),
        observedAt,
        state: "satisfied",
      });
    }
  }
  return observations;
}

function freshnessFromBlockers(blockers: string[]): MissionFinalizationProjection["evidenceFreshness"] {
  if (
    blockers.some((factor) =>
      factor.includes("candidate_identity_mismatch")
      || factor.includes("decision_contract_mismatch")
      || factor.includes("contradictory")
    )
  ) {
    return "contradictory";
  }
  if (
    blockers.some((factor) =>
      factor.includes("stale")
      || factor.includes("changed_since_capsule")
      || factor.includes("mutation_after_capsule")
    )
  ) {
    return "stale";
  }
  return blockers.length === 0 ? "fresh" : "unknown";
}

export function projectMissionFinalization(
  input: MissionFinalizationProjectionInput,
): MissionFinalizationProjection {
  const declaration = input.declaration
    ? normalizeMissionFinalizationDeclaration(input.declaration)
    : undefined;
  const contract = declaration?.contract;
  const decision = declaration?.decision;
  const semantic = isRecord(input.semanticRecovery)
    ? input.semanticRecovery
    : {};
  const landing = isRecord(input.turnLanding) ? input.turnLanding : {};
  const validation = recordAt(semantic, "validation") ?? {};
  const worktree = recordAt(semantic, "worktree") ?? {};
  const effect = recordAt(semantic, "effect") ?? {};
  const capsule = recordAt(semantic, "capsule") ?? {};
  const activity = recordAt(semantic, "activitySinceCapsule") ?? {};
  const missionRef = stringValue(semantic.missionRef);
  const capsuleId = stringValue(capsule.capsuleId);
  const capsuleRecordedAt = stringValue(capsule.recordedAt);
  const candidateRef = contract?.candidateRef;
  const requiredFactors = contract?.requiredFactors ?? ALWAYS_REQUIRED_FACTORS;
  const evidenceMap = factorEvidenceMap(decision);
  const observations = [
    ...(input.authoritativeObservations ?? []),
    ...publicationObservations(input.scopePublicationPreflight, candidateRef),
  ];
  const blockers = new Set<string>();
  const satisfied = new Map<
    MissionFinalizationFactor,
    { evidenceRefs: Set<string>; sources: Set<string> }
  >();

  const satisfy = (
    factor: MissionFinalizationFactor,
    refs: Iterable<string>,
    source: string,
  ) => {
    const current = satisfied.get(factor) ?? {
      evidenceRefs: new Set<string>(),
      sources: new Set<string>(),
    };
    for (const ref of refs) current.evidenceRefs.add(ref);
    current.sources.add(source);
    satisfied.set(factor, current);
  };

  if (contract) {
    satisfy("explicit_closure_contract", [contract.contractRef], "explicit_contract");
  } else {
    blockers.add("explicit_closure_contract_missing");
  }

  if (!decision) {
    blockers.add("explicit_semantic_closure_decision_missing");
  } else if (decision.disposition !== "COMPLETE_VERIFIED") {
    blockers.add(
      decision.disposition === "BLOCKED"
        ? "semantic_closure_decision_declares_blocked"
        : "semantic_closure_decision_not_complete",
    );
  } else if (!decision.authorityRef || !decision.decisionRef) {
    blockers.add("semantic_closure_decision_authority_missing");
  } else {
    satisfy(
      "explicit_semantic_closure_decision",
      [decision.decisionRef, decision.authorityRef],
      "explicit_closure_decision",
    );
  }

  if (contract && decision && contract.candidateRef === decision.candidateRef) {
    satisfy(
      "exact_candidate_identity",
      [contract.candidateRef, decision.candidateRef],
      "contract_decision_binding",
    );
  } else if (contract && decision) {
    blockers.add("candidate_identity_mismatch_between_contract_and_decision");
  } else {
    blockers.add("exact_candidate_identity_missing");
  }

  const obligationEvidence = matchingEvidence(
    evidenceMap,
    "declared_obligations",
    candidateRef,
  );
  if (obligationEvidence.length > 0) {
    satisfy(
      "declared_obligations",
      obligationEvidence.flatMap((entry) => entry.evidenceRefs),
      "explicit_factor_evidence",
    );
  } else {
    blockers.add("declared_obligations_evidence_missing");
  }

  const capsuleState = stringValue(landing.semanticCapsuleState) ?? "missing";
  const processOrEffectReconciliationRequired =
    landing.processOrEffectReconciliationRequired === true;
  const workspaceFresh = worktree.workspaceFreshness === "fresh";
  const declaredWorktreeState = stringValue(worktree.declaredState) ?? "unknown";
  const explicitLandingEvidence = matchingEvidence(
    evidenceMap,
    "accepted_landing_state",
    candidateRef,
  );
  const landingCurrent = capsuleState === "current_for_observed_mutation";
  const landingAccepted = landingCurrent
    && capsuleId !== undefined
    && capsuleRecordedAt !== undefined
    && workspaceFresh
    && !processOrEffectReconciliationRequired
    && (
      declaredWorktreeState === "clean"
      || declaredWorktreeState === "intentional_dirty"
    )
    && explicitLandingEvidence.length > 0;
  if (landingAccepted) {
    const envelopeDigest = stringValue(
      (recordAt(landing, "operationalEnvelope") ?? {}).digestSha256,
    );
    satisfy(
      "accepted_landing_state",
      [
        ...explicitLandingEvidence.flatMap((entry) => entry.evidenceRefs),
        ...(envelopeDigest ? [envelopeDigest] : []),
        capsuleId!,
        capsuleRecordedAt!,
      ],
      declaredWorktreeState === "clean"
        ? "explicitly_accepted_fresh_clean_landing"
        : "explicitly_accepted_fresh_dirty_landing",
    );
  } else {
    blockers.add(
      processOrEffectReconciliationRequired
        ? "landing_requires_process_or_effect_reconciliation"
        : capsuleState.includes("changed_since_capsule")
          ? "landing_state_changed_since_capsule"
          : !workspaceFresh
            ? "landing_workspace_freshness_unavailable_or_stale"
            : "landing_state_not_explicitly_accepted",
    );
  }

  const potentialMutationAfterCapsule =
    activity.potentialMutationAfterCapsule === true;
  if (
    landingCurrent
    && !potentialMutationAfterCapsule
    && capsuleId !== undefined
    && capsuleRecordedAt !== undefined
  ) {
    satisfy(
      "recovery_refreshed_after_last_material_change",
      [capsuleId, capsuleRecordedAt],
      "fresh_semantic_capsule",
    );
  } else {
    blockers.add(
      potentialMutationAfterCapsule
        ? "recovery_capsule_stale_after_mutation"
        : "recovery_capsule_not_current_for_observed_mutation",
    );
  }

  const effectState = stringValue(effect.state) ?? "unobserved";
  const effectKeys = stringList(effect.keys);
  if (
    !processOrEffectReconciliationRequired
    && (effectState === "none" || effectState === "terminal")
  ) {
    satisfy(
      "no_unknown_effect",
      effectKeys.length > 0 ? effectKeys : ["effect:none"],
      "semantic_effect_and_landing_readback",
    );
  } else if (
    effectState === "unknown"
    || effectState === "in_flight"
    || processOrEffectReconciliationRequired
  ) {
    blockers.add("unknown_or_in_flight_effect_requires_reconciliation");
  }

  const directiveSummary = input.directiveSummary;
  if (!directiveSummary) {
    blockers.add("owner_directive_readback_unavailable");
  } else if (directiveSummary.unactedDirectiveCount === 0) {
    satisfy(
      "no_unacted_owner_correction",
      ["execution-mailbox:no-unacted-directive-like-message"],
      "execution_mailbox",
    );
  } else {
    blockers.add(
      `unacted_owner_correction_or_instruction:${directiveSummary.unactedDirectiveCount}`,
    );
  }

  const validationEvidence = matchingEvidence(
    evidenceMap,
    "validation_receipt_bound_to_candidate",
    candidateRef,
  );
  const nativeValidation = observations.filter((entry) =>
    entry.factor === "validation_receipt_bound_to_candidate"
    && entry.state === "satisfied"
    && entry.candidateRef === candidateRef
    && entry.evidenceRefs.length > 0
    && entry.authorityRef.length > 0
  );
  if (
    validation.state === "passed"
    && stringList(validation.refs).length > 0
    && workspaceFresh
    && !potentialMutationAfterCapsule
    && (validationEvidence.length > 0 || nativeValidation.length > 0)
  ) {
    satisfy(
      "validation_receipt_bound_to_candidate",
      [
        ...stringList(validation.refs),
        ...validationEvidence.flatMap((entry) => entry.evidenceRefs),
        ...nativeValidation.flatMap((entry) => entry.evidenceRefs),
      ],
      nativeValidation.length > 0
        ? "native_validation_readback"
        : "fresh_capsule_and_explicit_validation_binding",
    );
  }

  const terminalEvidence = matchingEvidence(
    evidenceMap,
    "publication_or_effect_terminal_receipt",
    candidateRef,
  );
  const nativeTerminal = observations.filter((entry) =>
    entry.factor === "publication_or_effect_terminal_receipt"
    && entry.state === "satisfied"
    && entry.candidateRef === candidateRef
    && entry.evidenceRefs.length > 0
    && entry.authorityRef.length > 0
  );
  const terminalKeysMatch = terminalEvidence.some((entry) =>
    entry.effectKeys === undefined
    || entry.effectKeys.length === 0
    || entry.effectKeys.every((key) => effectKeys.includes(key))
  );
  if (
    effectState === "terminal"
    && effectKeys.length > 0
    && (terminalKeysMatch || nativeTerminal.length > 0)
  ) {
    satisfy(
      "publication_or_effect_terminal_receipt",
      [
        ...effectKeys,
        ...terminalEvidence.flatMap((entry) => entry.evidenceRefs),
        ...nativeTerminal.flatMap((entry) => entry.evidenceRefs),
      ],
      nativeTerminal.length > 0
        ? "native_terminal_effect_receipt"
        : "explicit_terminal_effect_binding",
    );
  }

  const authoritativeReadbacks = observations.filter((entry) =>
    entry.factor === "authoritative_post_effect_readback"
    && entry.state === "satisfied"
    && entry.candidateRef === candidateRef
    && entry.evidenceRefs.length > 0
    && entry.authorityRef.length > 0
    && stringValue(entry.observedAt) !== undefined
  );
  if (authoritativeReadbacks.length > 0) {
    satisfy(
      "authoritative_post_effect_readback",
      authoritativeReadbacks.flatMap((entry) => [
        ...entry.evidenceRefs,
        entry.authorityRef,
        entry.observedAt,
      ]),
      "native_authoritative_readback",
    );
  } else if (
    observations.some((entry) =>
      entry.factor === "authoritative_post_effect_readback"
      && entry.candidateRef === candidateRef
      && entry.state === "blocked"
    )
  ) {
    blockers.add("authoritative_post_effect_readback_stale_or_contradictory");
  }

  for (const factor of requiredFactors) {
    if (!satisfied.has(factor)) {
      blockers.add(`required_factor_unsatisfied:${factor}`);
    }
  }
  for (const declaredBlocker of decision?.blockingFactors ?? []) {
    blockers.add(`declared_blocker:${declaredBlocker}`);
  }

  const blockingFactors = uniqueSorted(blockers);
  const unsafeEffect = blockingFactors.some((entry) =>
    entry === "unknown_or_in_flight_effect_requires_reconciliation"
    || entry === "landing_requires_process_or_effect_reconciliation"
  );
  const explicitlyBlocked = decision?.disposition === "BLOCKED";
  const completionClaimAllowed = blockingFactors.length === 0
    && decision?.disposition === "COMPLETE_VERIFIED";
  const disposition: MissionFinalizationDisposition = completionClaimAllowed
    ? "COMPLETE_VERIFIED"
    : unsafeEffect || explicitlyBlocked
      ? "BLOCKED"
      : "PARTIAL_CONTINUE";
  const satisfiedFactors = [...satisfied.entries()]
    .map(([factor, evidence]) => ({
      factor,
      evidenceRefs: uniqueSorted(evidence.evidenceRefs),
      sources: uniqueSorted(evidence.sources),
    }))
    .sort((left, right) => left.factor.localeCompare(right.factor));
  const evidenceRefs = uniqueSorted([
    ...(contract ? [contract.contractRef] : []),
    ...(decision ? [decision.decisionRef, decision.authorityRef] : []),
    ...satisfiedFactors.flatMap((entry) => entry.evidenceRefs),
    ...(directiveSummary?.evidenceRefs ?? []),
  ]);
  const recommendedResponsePosture = completionClaimAllowed
    ? "Report COMPLETE_VERIFIED only with the exact closure decision, candidate identity, evidence refs, claim ceiling, and authoritative post-effect readback."
    : disposition === "BLOCKED"
      ? "Report BLOCKED, name the exact reconciliation or authority blocker, preserve the current mission and evidence, and do not retry an unknown effect or claim completion."
      : "Report PARTIAL_CONTINUE: state what was completed this turn, what is not completed or not verified, the exact current frontier, and the next continuation action. Do not use unqualified completion, publication, validation, closure, sealing, terminality, or next-frontier claims.";

  return {
    schemaVersion: "devspace.mission-finalization.v1",
    capabilityRef: "devspace.mission-finalization.v1",
    disposition,
    completionClaimAllowed,
    evidenceFreshness: freshnessFromBlockers(blockingFactors),
    missionRef,
    contractRef: contract?.contractRef,
    decisionRef: decision?.decisionRef,
    candidateRef,
    requiredFactors,
    blockingFactors,
    satisfiedFactors,
    evidenceRefs,
    claimCeiling: contract?.claimCeiling
      ?? "No explicit mission closure contract is available. Executor observations may deny a completion claim but cannot establish semantic or task completion.",
    lastMaterialMutationEffectCheckpointRelation: {
      semanticCapsuleState: capsuleState,
      capsuleRecordedAt,
      potentialMutationAfterCapsule:
        typeof activity.potentialMutationAfterCapsule === "boolean"
          ? activity.potentialMutationAfterCapsule
          : undefined,
      latestPotentialMutationAt: stringValue(activity.latestPotentialMutationAt),
      processOrEffectReconciliationRequired,
      effectState,
      effectKeys,
    },
    recommendedResponsePosture,
    assessedAt: input.assessedAt ?? new Date().toISOString(),
    policy: {
      authority: "completion_claim_barrier_from_explicit_closure_and_native_evidence",
      turnEndIsMissionComplete: false,
      defaultDisposition: "PARTIAL_CONTINUE",
      plannedTextCountsAsEvidence: false,
      semanticClosureInferredFromFilesTestsCountsOrToolEvents: false,
      missingOrStaleFactorFailsClosed: true,
      taskCompletionRequired: false,
      forcedCommitOrCompletionRequired: false,
      partialDirtyLandingAllowedWithExactFrontier: true,
      canonicalTaskDecisionWriterEffectOrPublicationAuthorityGranted: false,
    },
  };
}
