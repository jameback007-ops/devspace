import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  continuationIntentDecision,
  fixedContinuationProfile,
  invokeZesContinuationPreflight,
  isVerifiedDeepSubset,
  readFixedRepositoryContinuation,
  repositoryContinuationDecision,
  ZES_CONTINUATION_INTENTS,
  ZesContinuationPreflightProjector,
  type ZesContinuationSnapshotReadback,
} from "./zes-continuation-preflight.js";

const basePreflight = {
  schema_version: "zes.continuation-control-preflight.v3",
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

await test("explicit repository profile uses the native reader without inventing runtime authority", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "zes-repository-preflight-"));
  const oldProfile = process.env.DEVSPACE_ZES_CONTINUATION_BACKEND;
  const oldRoot = process.env.DEVSPACE_ZES_REPOSITORY_ROOT;
  const restore = (name: string, value: string | undefined) => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };
  const source = "current: source\n";
  const digest = createHash("sha256").update(source).digest("hex");
  const native = () => ({
    schema_version: "zes.cleanroom.repository-continuation.v1",
    mode: "repository_only", read_only: true,
    observed_at: new Date().toISOString(),
    workspace: { path: directory, head: "a".repeat(40), dirty: true },
    activeResearchMethod: { mode: "repository_source_bound",
      runtimeMethodCapsuleClaimed: false,
      sourceBindings: [{ path: "control.yaml", sha256: digest }] },
  });
  const reader = async (payload: unknown, exit = 0) => {
    // Controlled fixture transport only: no model, provider or shared service.
    const text = JSON.stringify(payload).replaceAll("'", "'\\''");
    await writeFile(join(directory, "zes-continuation"),
      `#!/bin/sh\n[ "$#" = 1 ] && [ "$1" = --summary ] || exit 64\nprintf '%s\\n' '${text}'\nexit ${exit}\n`,
      { mode: 0o700 });
  };
  try {
    process.env.DEVSPACE_ZES_CONTINUATION_BACKEND = "repository_only";
    process.env.DEVSPACE_ZES_REPOSITORY_ROOT = directory;
    await writeFile(join(directory, "control.yaml"), source);
    await t.test("profile selection is explicit and invalid values do not fall back", async () => {
      assert.equal(fixedContinuationProfile(), "repository_only");
      delete process.env.DEVSPACE_ZES_REPOSITORY_ROOT;
      assert.throws(() => fixedContinuationProfile(), /explicit_host_repository_root/);
      process.env.DEVSPACE_ZES_REPOSITORY_ROOT = directory;
      process.env.DEVSPACE_ZES_CONTINUATION_BACKEND = "unknown";
      assert.throws(() => fixedContinuationProfile(), /unsupported_fixed_continuation_profile/);
      process.env.DEVSPACE_ZES_CONTINUATION_BACKEND = "repository_only";
    });
    await t.test("all five intents preserve read-only, candidate and runtime distinctions", async () => {
      await reader(native());
      for (const intent of ZES_CONTINUATION_INTENTS) {
        const response = await invokeZesContinuationPreflight(intent);
        const data = response.structuredContent.data;
        assert.equal(data.scope, "fixed-repository-continuation-readback");
        assert.equal(data.decision.actionAllowed, intent === "inspect");
        assert.equal(data.decision.newAuthorityGranted, false);
        assert.equal(data.decision.policyDenialObserved, false);
      }
      assert.match(String(repositoryContinuationDecision("publish_repository").nextAction), /scopePublicationPreflight/);
      assert.equal(repositoryContinuationDecision("runtime_takeover_or_effect_retry").disposition, "not_assessed");
    });
    await t.test("stable projection exposes repository state, not a fabricated legacy preflight", async () => {
      await reader(native());
      const projector = new ZesContinuationPreflightProjector();
      await projector.warm();
      const projected = await projector.project();
      assert.equal(projected.status, "repository_readback");
      assert.equal("preflight" in projected, false);
      assert.equal("sourceExpiresAt" in projected, false);
      if (projected.status === "repository_readback") {
        assert.equal(projected.policy.runtimeStateObserved, false);
        assert.equal(projected.policy.cacheUntilIsNotSourceOrAuthorityExpiry, true);
      }
    });
    await t.test("nonzero reader exit is not successful source observation", async () => {
      await reader(native(), 7);
      await assert.rejects(readFixedRepositoryContinuation, /repository_continuation_failed:7/);
    });
    await t.test("wrong contract and workspace are rejected", async () => {
      await reader({ ...native(), mode: "runtime" });
      await assert.rejects(readFixedRepositoryContinuation, /invalid_repository_continuation_contract/);
      await reader({ ...native(), workspace: { path: tmpdir(), head: "a".repeat(40) } });
      await assert.rejects(readFixedRepositoryContinuation, /workspace_mismatch/);
    });
    await t.test("old or future observations are not fresh source readbacks", async () => {
      for (const observed_at of ["2000-01-01T00:00:00Z", "2100-01-01T00:00:00Z"]) {
        await reader({ ...native(), observed_at });
        await assert.rejects(readFixedRepositoryContinuation, /stale_or_future/);
      }
    });
    await t.test("missing and stale source bindings are rejected", async () => {
      const payload = native();
      payload.activeResearchMethod.sourceBindings = [];
      await reader(payload);
      await assert.rejects(readFixedRepositoryContinuation, /source_bindings_missing/);
      await reader(native());
      await writeFile(join(directory, "control.yaml"), "changed: source\n");
      await assert.rejects(readFixedRepositoryContinuation, /source_binding_mismatch/);
      await writeFile(join(directory, "control.yaml"), source);
    });
    await t.test("symlink escape cannot become a validated source binding", async () => {
      const outside = `${directory}-outside.yaml`;
      try {
        await writeFile(outside, source);
        await symlink(outside, join(directory, "escape.yaml"));
        const payload = native();
        payload.activeResearchMethod.sourceBindings[0].path = "escape.yaml";
        await reader(payload);
        await assert.rejects(readFixedRepositoryContinuation, /source_binding_mismatch/);
      } finally { await rm(outside, { force: true }); }
    });
  } finally {
    restore("DEVSPACE_ZES_CONTINUATION_BACKEND", oldProfile);
    restore("DEVSPACE_ZES_REPOSITORY_ROOT", oldRoot);
    await rm(directory, { recursive: true, force: true });
  }
});

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
    writer_state_uncertain: true,
    provider_writer_state_is_repository_authority: false,
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
  continuationIntentDecision("mutate_governed_checkout", {
    ...basePreflight,
    schema_version: "zes.continuation-control-preflight.v2",
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
      schema_version: "zes.continuation-control-preflight.v3",
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

const deferred = await projector.project({
  refresh: false,
  deferReason:
    "repository_publication_fast_path_does_not_require_global_runtime_refresh",
});
assert.equal(deferred.status, "deferred");
assert.equal(refreshCalls, 0, "repository fast path must not start a global refresh");
if (deferred.status === "deferred") {
  assert.equal(
    deferred.nextAction,
    "invoke_direct_tool_only_for_governed_checkout_runtime_or_effect_intent",
  );
  assert.equal(deferred.policy.repositoryFastPathMayDeferAutomaticRefresh, true);
}

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
