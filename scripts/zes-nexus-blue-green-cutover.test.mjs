import assert from "node:assert/strict";
import test from "node:test";
import {
  assessCutover,
  assessOAuthMetadata,
  renderUpstream,
} from "./zes-nexus-blue-green-cutover.mjs";

const ready = {
  ok: true,
  state: "READY",
  backendInstanceRef: "backend-a",
  restartSafety: { state: "safe", reasonCodes: [] },
  database: { latestMigrationVersion: 17 },
  toolSurface: { toolCount: 81 },
  toolSurfaceFingerprintSha256: "a".repeat(64),
};

test("cutover requires a safe active backend and non-regressing candidate", () => {
  assert.deepEqual(
    assessCutover(ready, { ...ready, backendInstanceRef: "backend-b" }),
    { ok: true, reasons: [] },
  );
  const unsafe = assessCutover(
    { ...ready, restartSafety: { state: "defer" } },
    {
      ...ready,
      backendInstanceRef: "backend-b",
      database: { latestMigrationVersion: 16 },
      toolSurface: { toolCount: 80 },
    },
  );
  assert.equal(unsafe.ok, false);
  assert.deepEqual(unsafe.reasons, [
    "active_restart_safety_not_safe",
    "candidate_tool_surface_regressed",
    "candidate_database_migration_regressed",
  ]);
});

test("OAuth cutover gate requires offline access on both metadata documents", () => {
  assert.deepEqual(
    assessOAuthMetadata(
      { scopes_supported: ["devspace", "offline_access"] },
      {
        resource: "https://mcp.zesnexus.com/mcp",
        scopes_supported: ["devspace", "offline_access"],
      },
    ),
    { ok: true, reasons: [] },
  );
  assert.equal(
    assessOAuthMetadata(
      { scopes_supported: ["devspace"] },
      { resource: "bad", scopes_supported: ["devspace"] },
    ).ok,
    false,
  );
});

test("upstream rendering is loopback-only and validates ports", () => {
  assert.equal(renderUpstream(7679), "reverse_proxy 127.0.0.1:7679\n");
  assert.throws(() => renderUpstream(0), /Invalid upstream port/);
  assert.throws(() => renderUpstream(65536), /Invalid upstream port/);
});
