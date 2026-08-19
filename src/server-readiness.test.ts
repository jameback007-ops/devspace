import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";

function listen(app: ReturnType<typeof createServer>["app"]): Promise<Server> {
  return new Promise((resolveListen, rejectListen) => {
    const server = app.listen(0, "127.0.0.1", () => resolveListen(server));
    server.once("error", rejectListen);
  });
}

function closeHttp(server: Server): Promise<void> {
  return new Promise((resolveClose, rejectClose) => {
    server.close((error) => {
      if (error) rejectClose(error);
      else resolveClose();
    });
  });
}

test("readyz exercises functional database and tool-surface readiness", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-server-readyz-"));
  const stateDir = join(root, ".state");
  const config = loadConfig({
    DEVSPACE_CONFIG_DIR: join(root, ".config"),
    DEVSPACE_ALLOWED_ROOTS: root,
    DEVSPACE_ALLOWED_HOSTS: "127.0.0.1,localhost",
    DEVSPACE_PUBLIC_BASE_URL: "http://127.0.0.1:1",
    DEVSPACE_STATE_DIR: stateDir,
    DEVSPACE_WORKTREE_ROOT: join(root, ".worktrees"),
    DEVSPACE_TOOL_MODE: "codex",
    DEVSPACE_WIDGETS: "off",
    DEVSPACE_SUBAGENTS: "0",
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    HOST: "127.0.0.1",
    PORT: "1",
  });
  const running = createServer(config, {
    incomingArtifactAdapters: [],
    serviceProcessObserver: () => ({
      schemaVersion: "zes.service-process-observation.v1",
      state: "observed",
      childProcessCount: 0,
      cgroupIdentityDigestSha256: "a".repeat(64),
      policy: {
        currentProcessCgroupOnly: true,
        mainProcessExcluded: true,
        rawCgroupPathExcluded: true,
        rawErrorExcluded: true,
      },
    }),
  });
  const http = await listen(running.app);
  t.after(async () => {
    await closeHttp(http).catch(() => undefined);
    await running.close();
    await rm(root, { recursive: true, force: true });
  });
  const address = http.address();
  assert.ok(address && typeof address === "object");
  const response = await fetch(
    `http://127.0.0.1:${address.port}/readyz`,
    { headers: { Host: "127.0.0.1" } },
  );
  assert.equal(response.status, 200);
  const body = await response.json() as Record<string, any>;
  assert.equal(body.schemaVersion, "zes.mcp-primary-readiness.v1");
  assert.equal(body.ok, true);
  assert.equal(body.state, "READY");
  assert.equal(body.database.state, "ready");
  assert.ok(Number(body.database.latestMigrationVersion) >= 1);
  assert.equal(body.toolSurface.initialized, true);
  assert.ok(Number(body.toolSurface.toolCount) > 0);
  assert.equal(body.restartSafety.state, "safe");
  assert.equal(body.serviceProcessObservation.state, "observed");
  assert.equal(body.serviceProcessObservation.childProcessCount, 0);
  assert.equal(body.policy.livenessIsNotReadiness, true);
  assert.equal(body.policy.sameProcessDatabaseSentinel, true);
  assert.equal(body.policy.deploymentOrEffectAuthorityGranted, false);
  assert.equal("rawError" in body.database, false);
});
