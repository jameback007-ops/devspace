import assert from "node:assert/strict";
import {
  assessNexusBackendFreshness,
  enrichNexusBackendRuntime,
  runtimeSnapshotFromNexusBackend,
  type NexusBackendRuntimeObservation,
} from "./nexus-backend-freshness-adapter.js";
import {
  DEPLOYMENT_MANIFEST_SCHEMA,
  createToolSurfaceIdentity,
  sha256Text,
  validateDeploymentManifest,
} from "./tool-surface-freshness.js";

const tools = [
  { name: "execution_scope_list", inputSchema: { type: "object" } },
  { name: "execution_scope_status", inputSchema: { type: "object" } },
  { name: "open_workspace", inputSchema: { type: "object" } },
  { name: "skill_search", inputSchema: { type: "object" } },
];
const surface = createToolSurfaceIdentity(tools);
const digestA = sha256Text("adapter-a");
const digestB = sha256Text("adapter-b");

const backendRuntime: NexusBackendRuntimeObservation = {
  schemaVersion: 1,
  backend: {
    name: "devspace",
    implementation: "zes-nexus",
    packageVersion: "1.0.7",
    mcpServerVersion: "1.0.7-zes.2",
    instanceRef: "instance-1",
    startedAt: "2026-08-17T12:00:00.000Z",
    uptimeMs: 1000,
  },
  toolSurface: {
    fingerprintSha256: surface.fingerprintSha256,
    toolCount: surface.toolCount,
    toolNames: surface.toolNames,
    configuration: { toolMode: "codex" },
  },
  clientCatalogObservation: {
    observable: false,
    freshness: "unavailable",
  },
  policy: { authority: "executor_local_runtime_observation_only" },
};

const expected = validateDeploymentManifest({
  schemaVersion: DEPLOYMENT_MANIFEST_SCHEMA,
  generatedAt: "2026-08-17T12:00:00.000Z",
  surfaceEpoch: "epoch-1",
  build: {
    sourceCommit: "commit-1",
    sourceTree: "tree-1",
    buildArtifactDigestSha256: digestA,
    packageVersion: "1.0.7",
    mcpServerVersion: "1.0.7-zes.2",
  },
  toolSurface: surface,
  acceleratorProfile: {
    ref: "release/repository-execution-accelerator-profile.yaml",
    digestSha256: digestB,
  },
  nativeMcps: [],
  requiredClientTools: [
    "execution_scope_list",
    "execution_scope_status",
    "open_workspace",
    "skill_search",
  ],
});

const bindings = {
  sourceCommit: "commit-1",
  sourceTree: "tree-1",
  buildArtifactDigestSha256: digestA,
  surfaceEpoch: "epoch-1",
  acceleratorProfile: {
    ref: "release/repository-execution-accelerator-profile.yaml",
    digestSha256: digestB,
  },
  nativeMcps: [],
};

const runtime = runtimeSnapshotFromNexusBackend(backendRuntime, bindings);
assert.equal(runtime.instanceRef, "instance-1");
assert.equal(runtime.build.packageVersion, "1.0.7");
assert.equal(runtime.toolSurface.fingerprintSha256, surface.fingerprintSha256);

const unknownClient = assessNexusBackendFreshness({
  backendRuntime,
  bindings,
  expected,
  assessedAt: "2026-08-17T12:01:00.000Z",
});
assert.equal(unknownClient.assessment.status, "SERVER_CURRENT_CLIENT_UNKNOWN");

const current = assessNexusBackendFreshness({
  backendRuntime,
  bindings,
  expected,
  clientInput: {
    clientObservedSurfaceEpoch: "epoch-1",
    clientObservedFingerprintSha256: surface.fingerprintSha256,
    clientObservedToolNames: surface.toolNames,
  },
});
assert.equal(current.assessment.status, "CURRENT");

const enriched = enrichNexusBackendRuntime(backendRuntime, current.assessment);
assert.equal((enriched.toolSurfaceFreshness as { status: string }).status, "CURRENT");
assert.equal(
  (enriched.clientCatalogObservation as { freshness: string }).freshness,
  "current",
);
assert.deepEqual(enriched.policy, backendRuntime.policy);
assert.notEqual(enriched, backendRuntime);

const stale = assessNexusBackendFreshness({
  backendRuntime,
  bindings: { ...bindings, surfaceEpoch: "old-epoch" },
  expected,
});
assert.equal(stale.assessment.status, "STALE_SERVER");
assert.ok(stale.assessment.findings.some((entry) => entry.code === "STALE_SERVER_SURFACE_EPOCH"));
