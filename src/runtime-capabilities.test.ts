import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
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

const recoveryGroup = (
  firstSurface.criticalToolGroups as Record<string, Record<string, unknown>>
).recoveryCapsules;
assert.equal(recoveryGroup.configured, true);
assert.equal(recoveryGroup.registrationState, "complete");
assert.equal(recoveryGroup.available, true);

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
assert.equal(
  clientCatalog.missingRegisteredToolDoesNotImplyBackendCapabilityAbsent,
  true,
);

rmSync(root, { recursive: true, force: true });
