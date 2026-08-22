import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as z from "zod/v4";
import { loadConfig } from "./config.js";
import { RuntimeCapabilityRegistry } from "./runtime-capabilities.js";

const root = mkdtempSync(join(tmpdir(), "devspace-runtime-capabilities-test-"));
const config = loadConfig({
  DEVSPACE_CONFIG_DIR: join(root, ".config"),
  DEVSPACE_ALLOWED_ROOTS: root,
  DEVSPACE_STATE_DIR: join(root, ".state"),
  DEVSPACE_WORKTREE_ROOT: join(root, ".worktrees"),
  DEVSPACE_TOOL_MODE: "codex",
  DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
});

const first = new RuntimeCapabilityRegistry(config, {
  now: () => 1_000,
  instanceRef: "1111111111111111",
});
first.registerTool("beta", {
  title: "Beta",
  description: "Second tool",
  inputSchema: { count: z.number().int() },
  outputSchema: { ok: z.boolean() },
  annotations: { readOnlyHint: true },
});
first.registerTool("alpha", {
  title: "Alpha",
  description: "First tool",
  inputSchema: { value: z.string() },
  outputSchema: { result: z.string() },
  annotations: { readOnlyHint: true },
});
first.registerTool("recovery_capsule_record", {
  inputSchema: { workspaceId: z.string() },
});
first.registerTool("recovery_capsule_status", {
  inputSchema: { workspaceId: z.string() },
});

const second = new RuntimeCapabilityRegistry(config, {
  now: () => 1_000,
  instanceRef: "2222222222222222",
});
second.registerTool("recovery_capsule_status", {
  inputSchema: { workspaceId: z.string() },
});
second.registerTool("alpha", {
  title: "Alpha",
  description: "First tool",
  inputSchema: { value: z.string() },
  outputSchema: { result: z.string() },
  annotations: { readOnlyHint: true },
});
second.registerTool("recovery_capsule_record", {
  inputSchema: { workspaceId: z.string() },
});
second.registerTool("beta", {
  title: "Beta",
  description: "Second tool",
  inputSchema: { count: z.number().int() },
  outputSchema: { ok: z.boolean() },
  annotations: { readOnlyHint: true },
});

const firstSnapshot = first.snapshot();
const secondSnapshot = second.snapshot();
const firstSurface = firstSnapshot.toolSurface as Record<string, unknown>;
const secondSurface = secondSnapshot.toolSurface as Record<string, unknown>;
assert.equal(
  firstSurface.fingerprintSha256,
  secondSurface.fingerprintSha256,
  "registration order and process instance must not change the tool-surface fingerprint",
);
assert.deepEqual(firstSurface.toolNames, [
  "alpha",
  "beta",
  "recovery_capsule_record",
  "recovery_capsule_status",
]);
assert.equal(firstSurface.initialized, true);
assert.equal(
  firstSurface.surfaceEpoch,
  `nexus:${String(firstSurface.fingerprintSha256).slice(0, 16)}`,
);
assert.deepEqual(firstSurface.requiredClientTools, [
  "execution_scope_list",
  "execution_scope_status",
  "open_workspace",
  "read",
  "exec_command",
  "skill_search",
]);
assert.equal(
  (firstSurface.configuration as Record<string, unknown>)
    .workspaceSystemIndexConfiguredCount,
  0,
);

const recoveryGroup = (
  firstSurface.criticalToolGroups as Record<string, Record<string, unknown>>
).recoveryCapsules;
assert.equal(recoveryGroup.configured, true);
assert.equal(recoveryGroup.registrationState, "complete");
assert.equal(recoveryGroup.available, true);
const orientation = firstSnapshot.capabilityOrientation as Record<string, any>;
assert.equal(orientation.capabilityRef, "devspace.mcp-capability-orientation.v1");
assert.equal(orientation.state, "SERVER_CAPABILITY_DEGRADED");
assert.equal(orientation.summary.clientCatalogAttested, false);
assert.equal(
  orientation.policy.clientCatalogUnknownDoesNotMeanToolUnavailable,
  true,
);
assert.ok(
  orientation.groups.some(
    (group: Record<string, unknown>) => group.name === "workspaceExecution",
  ),
);
assert.equal(orientation.directory.registeredSurfaceObserved, true);
assert.deepEqual(orientation.directory.unclassifiedRegisteredTools, [
  "alpha",
  "beta",
]);
assert.ok(
  orientation.selfEvolution.candidates.some(
    (candidate: Record<string, unknown>) =>
      candidate.kind === "update_capability_directory",
  ),
);

const changed = new RuntimeCapabilityRegistry(config, {
  now: () => 1_000,
  instanceRef: "3333333333333333",
});
changed.registerTool("alpha", {
  title: "Alpha",
  description: "First tool",
  inputSchema: { value: z.string().min(2) },
  outputSchema: { result: z.string() },
  annotations: { readOnlyHint: true },
});
changed.registerTool("beta", {
  title: "Beta",
  description: "Second tool",
  inputSchema: { count: z.number().int() },
  outputSchema: { ok: z.boolean() },
  annotations: { readOnlyHint: true },
});
changed.registerTool("recovery_capsule_record", {
  inputSchema: { workspaceId: z.string() },
});
changed.registerTool("recovery_capsule_status", {
  inputSchema: { workspaceId: z.string() },
});

assert.notEqual(
  (changed.snapshot().toolSurface as Record<string, unknown>).fingerprintSha256,
  firstSurface.fingerprintSha256,
  "a model-facing schema change must change the tool-surface fingerprint",
);

const clientCatalog = firstSnapshot.clientCatalogObservation as Record<string, unknown>;
assert.equal(clientCatalog.observable, false);
assert.equal(clientCatalog.freshness, "unavailable");
assert.equal(clientCatalog.status, "INDETERMINATE");
assert.equal(clientCatalog.reason, "deployment_manifest_unavailable");
assert.equal(
  clientCatalog.missingRegisteredToolDoesNotImplyBackendCapabilityAbsent,
  true,
);

const empty = new RuntimeCapabilityRegistry(config, {
  now: () => 1_000,
  instanceRef: "4444444444444444",
});
assert.deepEqual(empty.responseHeaders(), {
  "Cache-Control": "no-store",
  "X-ZES-Nexus-Instance-Ref": "4444444444444444",
});
assert.deepEqual(first.responseHeaders(), {
  "Cache-Control": "no-store",
  "X-ZES-Nexus-Instance-Ref": "1111111111111111",
  "X-ZES-Tool-Surface-Fingerprint": String(firstSurface.fingerprintSha256),
  "X-ZES-Tool-Surface-Epoch": String(firstSurface.surfaceEpoch),
  "X-ZES-Tool-Surface-Freshness": "INDETERMINATE",
});

const unpinnedManifestPath = join(root, "unpinned-deployment.json");
writeFileSync(unpinnedManifestPath, "{}\n");
const unpinned = new RuntimeCapabilityRegistry(loadConfig({
  DEVSPACE_CONFIG_DIR: join(root, ".unpinned-config"),
  DEVSPACE_ALLOWED_ROOTS: root,
  DEVSPACE_STATE_DIR: join(root, ".unpinned-state"),
  DEVSPACE_WORKTREE_ROOT: join(root, ".unpinned-worktrees"),
  DEVSPACE_TOOL_MODE: "codex",
  DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
  DEVSPACE_TOOL_SURFACE_MANIFEST: unpinnedManifestPath,
}));
const unpinnedSnapshot = unpinned.snapshot();
const unpinnedManifest = unpinnedSnapshot.deploymentManifestObservation as Record<string, unknown>;
assert.equal(unpinnedManifest.configured, true);
assert.equal(unpinnedManifest.digestPinned, false);
assert.equal(unpinnedManifest.loaded, false);
assert.match(
  JSON.stringify(unpinnedManifest.errors),
  /requires DEVSPACE_TOOL_SURFACE_MANIFEST_SHA256/,
);
assert.equal(
  (unpinnedSnapshot.toolSurfaceFreshness as Record<string, unknown>).status,
  "INDETERMINATE",
);

rmSync(root, { recursive: true, force: true });
