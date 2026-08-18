import { createHash } from "node:crypto";

export type PublicationRiskClass =
  | "source_only_fast_path"
  | "runtime_deploy_follow_up"
  | "material_effect_reconciliation";

export interface PublicationRiskProfile {
  schemaVersion: 1;
  riskClass: PublicationRiskClass;
  changedPathCount: number;
  changedPathDigestSha256: string;
  changedPathPreview: string[];
  runtimeDeploymentRequired: boolean;
  runtimeDeploymentBlocksRepositoryPublication: false;
  materialEffectDeclared: boolean;
  materialEffectReconciliationRequired: boolean;
  materialEffectState?: string;
  materialEffectKeyCount: number;
  requiredEvidence: string[];
  skippedEvidence: Array<{
    evidence: string;
    reasonCode: string;
  }>;
  policy: {
    repositoryPublicationAndDeploymentAreSeparateEffects: true;
    unrelatedRuntimeStateCanBlockSourceOnlyPublication: false;
    materialEffectStateBlocksOnlyWhenDeclaredAndUnresolved: true;
    changedPathsAreAdvisoryImpactClassificationNotAuthority: true;
  };
}

export function buildPublicationRiskProfile(input: {
  changedPaths: string[];
  semantic?: Record<string, unknown>;
}): PublicationRiskProfile {
  const changedPaths = [...new Set(input.changedPaths.map(normalizePath).filter(Boolean))]
    .sort();
  const runtimeDeploymentRequired = changedPaths.some(
    (path) => !isNonRuntimePath(path),
  );
  const materialEffectState = typeof input.semantic?.effectState === "string"
    ? input.semantic.effectState
    : undefined;
  const effectKeys = boundedStringArray(input.semantic?.effectKeys, 100);
  const materialEffectDeclared = effectKeys.length > 0
    || materialEffectState === "in_flight"
    || materialEffectState === "terminal"
    || materialEffectState === "unknown";
  const materialEffectReconciliationRequired = materialEffectDeclared
    && materialEffectState !== "terminal";

  const riskClass: PublicationRiskClass = materialEffectReconciliationRequired
    ? "material_effect_reconciliation"
    : runtimeDeploymentRequired
      ? "runtime_deploy_follow_up"
      : "source_only_fast_path";
  const requiredEvidence = [
    "exact_candidate_sha_and_tree",
    "clean_candidate_or_preserved_exact_ref",
    "validation_receipt_bound_to_exact_candidate",
    "fixed_repository_remote_and_branch_identity",
    "fresh_remote_main_readback",
    "zero_behind_and_no_merge_candidate_history",
    "compare_and_swap_push",
    "authoritative_post_push_remote_readback",
  ];
  const skippedEvidence: PublicationRiskProfile["skippedEvidence"] = [];
  if (!runtimeDeploymentRequired) {
    skippedEvidence.push({
      evidence: "runtime_service_health_and_deployment_readiness",
      reasonCode: "candidate_has_no_runtime_or_release_surface_changes",
    });
  }
  if (!materialEffectDeclared) {
    skippedEvidence.push({
      evidence: "material_effect_reconciliation",
      reasonCode: "candidate_declares_no_material_effect",
    });
  }
  skippedEvidence.push({
    evidence: "unrelated_provider_thread_or_global_runtime_writer_state",
    reasonCode: "repository_publication_uses_repository_local_cas_authority",
  });

  return {
    schemaVersion: 1,
    riskClass,
    changedPathCount: changedPaths.length,
    changedPathDigestSha256: sha256(changedPaths.join("\0")),
    changedPathPreview: changedPaths.slice(0, 50),
    runtimeDeploymentRequired,
    runtimeDeploymentBlocksRepositoryPublication: false,
    materialEffectDeclared,
    materialEffectReconciliationRequired,
    ...(materialEffectState === undefined
      ? {}
      : { materialEffectState }),
    materialEffectKeyCount: effectKeys.length,
    requiredEvidence,
    skippedEvidence,
    policy: {
      repositoryPublicationAndDeploymentAreSeparateEffects: true,
      unrelatedRuntimeStateCanBlockSourceOnlyPublication: false,
      materialEffectStateBlocksOnlyWhenDeclaredAndUnresolved: true,
      changedPathsAreAdvisoryImpactClassificationNotAuthority: true,
    },
  };
}

function isNonRuntimePath(path: string): boolean {
  return path.startsWith("docs/")
    || path.startsWith(".agents/")
    || path.startsWith("test/")
    || path.startsWith("tests/")
    || path.endsWith(".md")
    || path.endsWith(".test.ts")
    || path.endsWith(".test.tsx")
    || path.endsWith(".spec.ts")
    || path.endsWith(".spec.tsx")
    || path.endsWith(".snap");
}

function normalizePath(value: string): string {
  return value.trim().replaceAll("\\", "/").replace(/^\.\//, "");
}

function boundedStringArray(value: unknown, maxItems: number): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean))]
    .sort()
    .slice(0, maxItems);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
