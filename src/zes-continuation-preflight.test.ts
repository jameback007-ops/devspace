import assert from "node:assert/strict";
import {
  continuationIntentDecision,
  isVerifiedDeepSubset,
} from "./zes-continuation-preflight.js";

const basePreflight = {
  schema_version: "zes.continuation-control-preflight.v2",
  safe_to_inspect: true,
  safe_to_prepare_isolated_candidate: true,
  safe_to_mutate_live: true,
  safe_to_publish: true,
  publication_required: true,
  publication_disposition: "eligible",
  isolated_candidate_blocking_factors: [],
  repository_mutation_blocking_factors: [],
  publication_blocking_factors: [],
  must_reconcile_runtime_or_unknown_outcome_first: false,
  runtime_reconciliation_scope:
    "runtime_takeover_effect_retry_or_runtime_state_reliance_only",
};

assert.deepEqual(
  continuationIntentDecision("inspect", basePreflight),
  {
    intent: "inspect",
    disposition: "allowed",
    actionAllowed: true,
    blockingFactors: [],
    newAuthorityGranted: false,
  },
);

assert.deepEqual(
  continuationIntentDecision("prepare_isolated_candidate", {
    ...basePreflight,
    safe_to_prepare_isolated_candidate: false,
    isolated_candidate_blocking_factors: ["dirty_worktree"],
  }),
  {
    intent: "prepare_isolated_candidate",
    disposition: "blocked",
    actionAllowed: false,
    blockingFactors: ["dirty_worktree"],
    newAuthorityGranted: false,
  },
);

assert.deepEqual(
  continuationIntentDecision("mutate_governed_checkout", {
    ...basePreflight,
    must_reconcile_runtime_or_unknown_outcome_first: true,
  }),
  {
    intent: "mutate_governed_checkout",
    disposition: "allowed",
    actionAllowed: true,
    blockingFactors: [],
    newAuthorityGranted: false,
  },
);

assert.deepEqual(
  continuationIntentDecision("publish_repository", {
    ...basePreflight,
    safe_to_publish: false,
    publication_required: false,
    publication_disposition: "not_required",
  }),
  {
    intent: "publish_repository",
    disposition: "not_required",
    actionAllowed: false,
    publicationRequired: false,
    blockingFactors: [],
    newAuthorityGranted: false,
  },
);

assert.deepEqual(
  continuationIntentDecision("publish_repository", {
    ...basePreflight,
    safe_to_publish: false,
    publication_disposition: "blocked",
    publication_blocking_factors: ["publication_authority_invalid"],
  }),
  {
    intent: "publish_repository",
    disposition: "blocked",
    actionAllowed: false,
    publicationRequired: true,
    blockingFactors: ["publication_authority_invalid"],
    newAuthorityGranted: false,
  },
);

assert.deepEqual(
  continuationIntentDecision("runtime_takeover_or_effect_retry", {
    ...basePreflight,
    must_reconcile_runtime_or_unknown_outcome_first: false,
  }),
  {
    intent: "runtime_takeover_or_effect_retry",
    disposition: "reconciliation_clear",
    actionAllowed: false,
    reconciliationRequired: false,
    reconciliationScope:
      "runtime_takeover_effect_retry_or_runtime_state_reliance_only",
    blockingFactors: [],
    newAuthorityGranted: false,
    interpretation:
      "A clear reconciliation state does not grant takeover or effect-retry authority.",
  },
);

assert.deepEqual(
  continuationIntentDecision("runtime_takeover_or_effect_retry", {
    ...basePreflight,
    must_reconcile_runtime_or_unknown_outcome_first: true,
  }),
  {
    intent: "runtime_takeover_or_effect_retry",
    disposition: "reconciliation_required",
    actionAllowed: false,
    reconciliationRequired: true,
    reconciliationScope:
      "runtime_takeover_effect_retry_or_runtime_state_reliance_only",
    blockingFactors: ["runtime_or_unknown_outcome_reconciliation_required"],
    newAuthorityGranted: false,
    interpretation:
      "A clear reconciliation state does not grant takeover or effect-retry authority.",
  },
);

assert.throws(
  () => continuationIntentDecision("inspect", null),
  /preflight payload is missing/,
);

assert.equal(
  isVerifiedDeepSubset(
    {
      publication_disposition: "not_required",
      repository_mutation_blocking_factors: ["dirty_worktree"],
      nested: { current: true },
    },
    {
      schema_version: "zes.continuation-control-preflight.v2",
      publication_disposition: "not_required",
      repository_mutation_blocking_factors: ["dirty_worktree"],
      nested: { current: true, extra: "allowed" },
      extra: "allowed",
    },
  ),
  true,
);

assert.equal(
  isVerifiedDeepSubset(
    {
      publication_disposition: "eligible",
      nested: { current: true },
    },
    {
      publication_disposition: "not_required",
      nested: { current: true },
    },
  ),
  false,
);

assert.throws(
  () => continuationIntentDecision("inspect", {
    ...basePreflight,
    schema_version: "zes.continuation-control-preflight.v1",
  }),
  /Unsupported ZES continuation preflight contract/,
);

console.log("zes continuation preflight tests passed");
