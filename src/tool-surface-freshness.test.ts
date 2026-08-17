import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEPLOYMENT_MANIFEST_SCHEMA,
  ToolSurfaceChangeBroadcaster,
  assessToolSurfaceFreshness,
  canonicalJson,
  clientAttestationFromHeaders,
  createToolSurfaceIdentity,
  freshnessHeaders,
  loadDeploymentManifestEnvelope,
  observePathIdentity,
  sha256Text,
  validateDeploymentManifest,
  validateRuntimeNativeMcpIdentities,
  type RuntimeToolSurfaceSnapshot,
  type ToolSurfaceDeploymentManifest,
} from "./tool-surface-freshness.js";

const tools = [
  {
    name: "execution_scope_list",
    description: "List scopes",
    inputSchema: { type: "object", properties: { limit: { type: "integer" } } },
    execution: { taskSupport: "forbidden" },
    _meta: {},
  },
  {
    name: "open_workspace",
    description: "Open workspace",
    inputSchema: {
      type: "object",
      required: ["path"],
      properties: { path: { type: "string" } },
    },
    execution: { taskSupport: "forbidden" },
    _meta: {},
  },
  {
    name: "skill_search",
    description: "Search skills",
    inputSchema: { type: "object", required: ["workspaceId", "query"] },
    execution: { taskSupport: "forbidden" },
    _meta: {},
  },
];

const toolSurface = createToolSurfaceIdentity(tools);
const digestA = sha256Text("a");
const digestB = sha256Text("b");

function manifest(): ToolSurfaceDeploymentManifest {
  return validateDeploymentManifest({
    schemaVersion: DEPLOYMENT_MANIFEST_SCHEMA,
    generatedAt: "2026-08-17T12:00:00.000Z",
    surfaceEpoch: "nexus:deployment-1",
    build: {
      sourceCommit: "commit-1",
      sourceTree: "tree-1",
      buildArtifactDigestSha256: digestA,
      packageVersion: "1.0.7",
      mcpServerVersion: "1.0.7-zes.2",
    },
    toolSurface,
    acceleratorProfile: {
      ref: "git:zes-main:release/repository-execution-accelerator-profile.yaml",
      digestSha256: digestB,
      byteCount: 45032,
    },
    nativeMcps: [
      {
        id: "serena-zes",
        required: true,
        activationDigestSha256: digestA,
        configDigestSha256: digestB,
        workspaceRef: "git:zes-main",
      },
    ],
    requiredClientTools: ["execution_scope_list", "open_workspace", "skill_search"],
  });
}

function runtime(): RuntimeToolSurfaceSnapshot {
  return {
    instanceRef: "2060ae185e8268bf",
    startedAt: "2026-08-17T11:59:18.803Z",
    surfaceEpoch: "nexus:deployment-1",
    build: {
      sourceCommit: "commit-1",
      sourceTree: "tree-1",
      buildArtifactDigestSha256: digestA,
      packageVersion: "1.0.7",
      mcpServerVersion: "1.0.7-zes.2",
    },
    toolSurface,
    acceleratorProfile: {
      ref: "git:zes-main:release/repository-execution-accelerator-profile.yaml",
      digestSha256: digestB,
      byteCount: 45032,
    },
    nativeMcps: [
      {
        id: "serena-zes",
        available: true,
        activationDigestSha256: digestA,
        configDigestSha256: digestB,
        workspaceRef: "git:zes-main",
      },
    ],
  };
}

async function main(): Promise<void> {
  assert.equal(canonicalJson({ z: 1, a: { y: 2, x: 1 } }), '{"a":{"x":1,"y":2},"z":1}');

  const reordered = createToolSurfaceIdentity([
    tools[2],
    tools[0],
    tools[1],
  ]);
  assert.equal(reordered.fingerprintSha256, toolSurface.fingerprintSha256);

  const schemaChanged = createToolSurfaceIdentity([
    ...tools.slice(0, 2),
    {
      ...tools[2],
      inputSchema: { type: "object", required: ["workspaceId", "query", "limit"] },
    },
  ]);
  assert.notEqual(schemaChanged.fingerprintSha256, toolSurface.fingerprintSha256);

  const metaChanged = createToolSurfaceIdentity([
    ...tools.slice(0, 2),
    { ...tools[2], _meta: { "openai/toolInvocation/invoking": "Searching" } },
  ]);
  assert.notEqual(
    metaChanged.fingerprintSha256,
    toolSurface.fingerprintSha256,
    "full descriptor fingerprint must include _meta",
  );

  const unknownClient = assessToolSurfaceFreshness({ expected: manifest(), runtime: runtime() });
  assert.equal(unknownClient.status, "SERVER_CURRENT_CLIENT_UNKNOWN");
  assert.equal(unknownClient.serverCurrent, true);

  const current = assessToolSurfaceFreshness({
    expected: manifest(),
    runtime: runtime(),
    client: {
      source: "operator_probe",
      surfaceEpoch: manifest().surfaceEpoch,
      fingerprintSha256: toolSurface.fingerprintSha256,
      toolNames: toolSurface.toolNames,
    },
  });
  assert.equal(current.status, "CURRENT");

  const partialClient = assessToolSurfaceFreshness({
    expected: manifest(),
    runtime: runtime(),
    client: {
      source: "status_tool_input",
      surfaceEpoch: manifest().surfaceEpoch,
      toolNames: toolSurface.toolNames,
    },
  });
  assert.equal(partialClient.status, "SERVER_CURRENT_CLIENT_UNKNOWN");
  assert.equal(
    partialClient.clientCatalogObservation.reason,
    "client_complete_descriptor_fingerprint_not_attested",
  );

  const staleBuildRuntime = runtime();
  staleBuildRuntime.build.sourceCommit = "different";
  const staleBuild = assessToolSurfaceFreshness({ expected: manifest(), runtime: staleBuildRuntime });
  assert.equal(staleBuild.status, "STALE_SERVER");
  assert.ok(staleBuild.findings.some((entry) => entry.code === "STALE_SERVER_SOURCE_COMMIT"));

  const staleProfileRuntime = runtime();
  staleProfileRuntime.acceleratorProfile = {
    ...staleProfileRuntime.acceleratorProfile!,
    digestSha256: digestA,
  };
  const staleProfile = assessToolSurfaceFreshness({ expected: manifest(), runtime: staleProfileRuntime });
  assert.equal(staleProfile.status, "STALE_SERVER");

  const staleNativeRuntime = runtime();
  staleNativeRuntime.nativeMcps[0] = {
    ...staleNativeRuntime.nativeMcps[0],
    configDigestSha256: digestA,
  };
  const staleNative = assessToolSurfaceFreshness({ expected: manifest(), runtime: staleNativeRuntime });
  assert.equal(staleNative.status, "STALE_SERVER");
  assert.ok(staleNative.findings.some((entry) => entry.code.includes("CONFIG_DIGEST")));

  const staleClient = assessToolSurfaceFreshness({
    expected: manifest(),
    runtime: runtime(),
    client: {
      source: "status_tool_input",
      surfaceEpoch: "old-epoch",
      fingerprintSha256: digestA,
      toolNames: ["open_workspace"],
    },
  });
  assert.equal(staleClient.status, "STALE_CLIENT");
  assert.deepEqual(
    staleClient.clientCatalogObservation.missingRequiredClientTools,
    ["execution_scope_list", "skill_search"],
  );

  const unobservedProfileRuntime = runtime();
  delete unobservedProfileRuntime.acceleratorProfile;
  assert.equal(
    assessToolSurfaceFreshness({ expected: manifest(), runtime: unobservedProfileRuntime }).status,
    "INDETERMINATE",
  );
  assert.equal(assessToolSurfaceFreshness({ runtime: runtime() }).status, "INDETERMINATE");

  const observationFailureRuntime = runtime();
  observationFailureRuntime.observationErrors = [
    { scope: "native_mcp", error: "receipt unreadable" },
  ];
  const observationFailure = assessToolSurfaceFreshness({
    expected: manifest(),
    runtime: observationFailureRuntime,
  });
  assert.equal(observationFailure.status, "INDETERMINATE");
  assert.ok(
    observationFailure.findings.some(
      (entry) => entry.code === "RUNTIME_BINDING_OBSERVATION_FAILED",
    ),
  );

  const headers = freshnessHeaders(unknownClient, runtime());
  assert.equal(headers["Cache-Control"], "no-store");
  assert.equal(headers["X-ZES-Tool-Surface-Fingerprint"], toolSurface.fingerprintSha256);
  assert.equal(headers["X-ZES-Tool-Surface-Freshness"], "SERVER_CURRENT_CLIENT_UNKNOWN");

  const root = await mkdtemp(join(tmpdir(), "tool-surface-manifest-test-"));
  const manifestPath = join(root, "manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest(), null, 2)}\n`);
  const loaded = await loadDeploymentManifestEnvelope(manifestPath, "deployment-manifest.json");
  assert.equal(loaded.identity.ref, "deployment-manifest.json");
  await assert.rejects(
    loadDeploymentManifestEnvelope(manifestPath, "deployment-manifest.json", digestA),
    /digest mismatch/,
  );
  await rm(root, { recursive: true, force: true });

  const treeRoot = await mkdtemp(join(tmpdir(), "tool-surface-tree-test-"));
  await mkdir(join(treeRoot, "nested"));
  await writeFile(join(treeRoot, "a.txt"), "a\n");
  await writeFile(join(treeRoot, "nested", "b.txt"), "b\n");
  const treeIdentity = await observePathIdentity(treeRoot, "dist-tree");
  const repeatedTreeIdentity = await observePathIdentity(treeRoot, "dist-tree");
  assert.deepEqual(repeatedTreeIdentity, treeIdentity);
  await writeFile(join(treeRoot, "nested", "b.txt"), "changed\n");
  assert.notEqual(
    (await observePathIdentity(treeRoot, "dist-tree")).digestSha256,
    treeIdentity.digestSha256,
  );
  await chmod(join(treeRoot, "a.txt"), 0o600);
  const modeChangedIdentity = await observePathIdentity(treeRoot, "dist-tree");
  await chmod(join(treeRoot, "a.txt"), 0o640);
  assert.notEqual(
    (await observePathIdentity(treeRoot, "dist-tree")).digestSha256,
    modeChangedIdentity.digestSha256,
  );
  await rm(treeRoot, { recursive: true, force: true });

  const parsedHeaders = clientAttestationFromHeaders({
    "X-ZES-Client-Tool-Surface-Fingerprint": toolSurface.fingerprintSha256,
    "x-zes-client-tool-surface-epoch": manifest().surfaceEpoch,
  });
  assert.equal(parsedHeaders?.source, "request_header");

  assert.deepEqual(validateRuntimeNativeMcpIdentities([]), []);
  assert.throws(
    () => validateRuntimeNativeMcpIdentities([{ id: "x", available: true }, { id: "x", available: true }]),
    /Duplicate/,
  );

  const broadcaster = new ToolSurfaceChangeBroadcaster();
  let notifications = 0;
  assert.equal(
    (await broadcaster.observe(toolSurface, async () => { notifications += 1; })).notificationSent,
    false,
  );
  assert.equal(
    (await broadcaster.observe(schemaChanged, async () => { notifications += 1; })).notificationSent,
    true,
  );
  assert.equal(notifications, 1);

  const retryable = new ToolSurfaceChangeBroadcaster(toolSurface.fingerprintSha256);
  await assert.rejects(
    retryable.observe(schemaChanged, async () => { throw new Error("transport unavailable"); }),
    /transport unavailable/,
  );
  assert.equal(
    (await retryable.observe(schemaChanged, async () => undefined)).notificationSent,
    true,
  );

  assert.throws(
    () => validateDeploymentManifest({ ...manifest(), requiredClientTools: ["not_registered"] }),
    /unknown tool/,
  );
  assert.throws(
    () => validateDeploymentManifest({
      ...manifest(),
      build: { ...manifest().build, sourceCommit: undefined },
    }),
    /build.sourceCommit is required/,
  );
}

await main();
