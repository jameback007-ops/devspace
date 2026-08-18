import assert from "node:assert/strict";
import test from "node:test";
import { buildPublicationRiskProfile } from "./publication-risk-profile.js";

test("skill and documentation candidates use the source-only fast path", () => {
  const profile = buildPublicationRiskProfile({
    changedPaths: [
      ".agents/skills/zes-solution-discipline/SKILL.md",
      "docs/publication.md",
    ],
    semantic: {
      writerState: "unknown",
      effectState: "none",
    },
  });

  assert.equal(profile.riskClass, "source_only_fast_path");
  assert.equal(profile.runtimeDeploymentRequired, false);
  assert.equal(profile.materialEffectReconciliationRequired, false);
  assert.ok(profile.skippedEvidence.some(
    (entry) => entry.reasonCode
      === "repository_publication_uses_repository_local_cas_authority",
  ));
});

test("runtime source changes require a separate deployment follow-up without blocking Git publication", () => {
  const profile = buildPublicationRiskProfile({
    changedPaths: ["src/server.ts", "src/server.test.ts"],
    semantic: { effectState: "none" },
  });

  assert.equal(profile.riskClass, "runtime_deploy_follow_up");
  assert.equal(profile.runtimeDeploymentRequired, true);
  assert.equal(profile.runtimeDeploymentBlocksRepositoryPublication, false);
});

test("a declared unresolved material effect requires reconciliation", () => {
  const profile = buildPublicationRiskProfile({
    changedPaths: ["docs/publication.md"],
    semantic: {
      effectState: "in_flight",
      effectKeys: ["deploy:nexus:release-1"],
    },
  });

  assert.equal(profile.riskClass, "material_effect_reconciliation");
  assert.equal(profile.materialEffectDeclared, true);
  assert.equal(profile.materialEffectReconciliationRequired, true);
  assert.equal(profile.materialEffectKeyCount, 1);
});

test("a terminal declared material effect no longer blocks repository publication", () => {
  const profile = buildPublicationRiskProfile({
    changedPaths: ["docs/publication.md"],
    semantic: {
      effectState: "terminal",
      effectKeys: ["deploy:nexus:release-1"],
    },
  });

  assert.equal(profile.materialEffectDeclared, true);
  assert.equal(profile.materialEffectReconciliationRequired, false);
  assert.equal(profile.riskClass, "source_only_fast_path");
});
