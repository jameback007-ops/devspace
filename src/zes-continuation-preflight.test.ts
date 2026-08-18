import assert from "node:assert/strict";
import {
  continuationIntentDecision,
  isVerifiedDeepSubset,
  ZesContinuationPreflightProjector,
  type ZesContinuationSnapshotReadback,
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

function snapshot(observedAt: string): ZesContinuationSnapshotReadback {
  return {
    schemaVersion: 1,
    observedAt,
    sourceExpiresAt: new Date(Date.parse(observedAt) + 60_000).toISOString(),
    preflight: structuredClone(basePreflight),
    route: {
      route_ref: "zes-continuation-control:v2:test",
    },
    refresh: {
      status: "refreshed",
      receiptDigestSha256: "a".repeat(64),
      snapshotSha256: "b".repeat(64),
      sourceControlPreflight: {
        publication_disposition: "eligible",
      },
    },
  };
}

let nowMs = Date.parse("2026-08-18T07:00:00.000Z");
let refreshCalls = 0;
const projector = new ZesContinuationPreflightProjector({
  now: () => nowMs,
  cacheTtlMs: 5_000,
  failureCacheTtlMs: 2_000,
  refresh: async () => {
    refreshCalls += 1;
    await Promise.resolve();
    return snapshot(new Date(nowMs).toISOString());
  },
});

const concurrent = await Promise.all([
  projector.project(),
  projector.project(),
  projector.project(),
]);
assert.equal(refreshCalls, 1, "concurrent projections must share one fixed refresh");
assert.deepEqual(concurrent[0], concurrent[1]);
assert.deepEqual(concurrent[1], concurrent[2]);
assert.equal(concurrent[0].status, "refreshing");
await projector.warm();
const available = await projector.project();
assert.equal(available.status, "available");
if (available.status === "available") {
  assert.equal(available.route, "execution_scope_status_embedded_control_plane");
  assert.equal(available.directToolName, "zes_continuation_preflight");
  assert.equal(available.policy.directToolDiscoveryRequired, false);
  assert.equal(available.policy.clientCatalogFreshnessRequiredForReadback, false);
  assert.equal(available.policy.catalogStalenessDoesNotEstablishWriterUncertainty, true);
  assert.equal(available.decisions.publish_repository.disposition, "allowed");
  assert.equal(available.decisions.publish_repository.actionAllowed, true);
  assert.deepEqual(
    Object.keys(available.decisions).sort(),
    [
      "inspect",
      "mutate_governed_checkout",
      "prepare_isolated_candidate",
      "publish_repository",
      "runtime_takeover_or_effect_retry",
    ],
  );
}

await projector.project();
assert.equal(refreshCalls, 1, "projection must reuse the bounded success cache");
nowMs += 5_000;
await projector.project();
assert.equal(refreshCalls, 2, "projection must refresh at the cache boundary");

let failureCalls = 0;
const failingProjector = new ZesContinuationPreflightProjector({
  now: () => nowMs,
  failureCacheTtlMs: 2_000,
  refresh: async () => {
    failureCalls += 1;
    throw new Error("PRIVATE-RUNTIME-DETAIL-MUST-NOT-LEAK");
  },
});
const refreshingFailure = await failingProjector.project();
assert.equal(refreshingFailure.status, "refreshing");
await failingProjector.warm();
const unavailable = await failingProjector.project();
assert.equal(unavailable.status, "unavailable");
assert.equal(
  JSON.stringify(unavailable).includes("PRIVATE-RUNTIME-DETAIL-MUST-NOT-LEAK"),
  false,
);
assert.match(unavailable.error.diagnosticDigestSha256, /^[a-f0-9]{64}$/);
await failingProjector.project();
assert.equal(failureCalls, 1, "projection must damp repeated failed refreshes");
nowMs += 2_000;
assert.equal((await failingProjector.project()).status, "refreshing");
await failingProjector.warm();
assert.equal(failureCalls, 2, "failed refresh must become retryable after its hold");

console.log("zes continuation preflight tests passed");
