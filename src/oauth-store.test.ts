import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InvalidGrantError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { databasePath, openDatabase } from "./db/client.js";
import {
  EXECUTION_WAKE_COORDINATION_AUTHORITY,
  materializeWakeContinuationBody,
  sha256 as wakeSha256,
} from "./execution-wake-coordination-model.js";
import { SingleUserOAuthProvider } from "./oauth-provider.js";
import { SqliteOAuthClientsStore, SqliteOAuthStore } from "./oauth-store.js";

const root = await mkdtemp(join(tmpdir(), "devspace-oauth-test-"));
const oauthConfig = {
  ownerToken: "test-owner-token-that-is-long-enough",
  accessTokenTtlSeconds: 3600,
  refreshTokenTtlSeconds: 2592000,
  scopes: ["devspace"],
  allowedRedirectHosts: ["chatgpt.com"],
};
const mcpUrl = new URL("https://agent.example.com/mcp");
const redirectUri = "https://chatgpt.com/connector_platform_oauth_redirect";

try {
  await testDatabaseConfiguration(join(root, "database-configuration"));
  testLegacyWakeContinuationSanitization(join(root, "legacy-wake-sanitization"));
  testPersistenceAndTokenHashing(join(root, "persistence"));
  testExpiredTokenCleanup(join(root, "expiration"));
  testTransactionalTokenRotation(join(root, "rotation"));
  await testProviderRestartRotationAndRevocation(join(root, "provider"));
} finally {
  await rm(root, { recursive: true, force: true });
}

async function testDatabaseConfiguration(stateDir: string): Promise<void> {
  const database = openDatabase(stateDir);
  try {
    assert.equal(database.sqlite.pragma("journal_mode", { simple: true }), "wal");
    assert.equal(database.sqlite.pragma("synchronous", { simple: true }), 1);
    assert.equal(database.sqlite.pragma("busy_timeout", { simple: true }), 5000);
    assert.equal(database.sqlite.pragma("foreign_keys", { simple: true }), 1);

    const migrations = database.sqlite
      .prepare("select version, name from devspace_schema_migrations order by version")
      .all();
    assert.deepEqual(migrations, [
      { version: 1, name: "workspace-state" },
      { version: 2, name: "oauth-state" },
      { version: 3, name: "local-agent-sessions" },
      { version: 4, name: "workspace-conversation-bindings" },
      { version: 5, name: "execution-scope-observability" },
      { version: 6, name: "execution-scope-mailbox" },
      { version: 7, name: "local-agent-turn-queue" },
      { version: 8, name: "turn-continuity-and-recovery-capsules" },
      { version: 9, name: "semantic-execution-observability" },
      { version: 10, name: "recovery-capsule-adoption-nudge" },
      { version: 11, name: "workspace-preservation-refs" },
      { version: 12, name: "conversation-transport-and-wake-coordination" },
      { version: 13, name: "instability-aware-turn-safe-landing" },
      { version: 14, name: "host-turn-lifecycle-observability" },
      { version: 15, name: "durable-interaction-broker" },
      { version: 16, name: "sanitize-wake-continuation-envelopes" },
    ]);
    assert.deepEqual(
      database.sqlite
        .prepare(`
          select name from sqlite_master
           where type = 'table' and name like 'host_turn_%'
           order by name
        `)
        .pluck()
        .all(),
      [
        "host_turn_commands",
        "host_turn_events",
        "host_turn_lifecycle_schema_versions",
        "host_turn_records",
        "host_turn_sessions",
      ],
    );
    assert.deepEqual(
      database.sqlite
        .prepare(`
          select name from sqlite_master
           where type = 'table' and name like 'interaction_broker_%'
           order by name
        `)
        .pluck()
        .all(),
      [
        "interaction_broker_leases",
        "interaction_broker_sessions",
      ],
    );
  } finally {
    database.close();
  }

  if (process.platform !== "win32") {
    assert.equal((await stat(stateDir)).mode & 0o777, 0o700);
    assert.equal((await stat(databasePath(stateDir))).mode & 0o777, 0o600);
  }
}

function testLegacyWakeContinuationSanitization(stateDir: string): void {
  const database = openDatabase(stateDir);
  const nowMs = Date.parse("2026-08-19T07:00:00.000Z");
  const body = [
    "[ZES-A2A continuation correlation:legacy]",
    "Durable coordination work generation 1 is pending for mission mission:legacy.",
    "Read the current execution-coordination status and inbox, reconcile the exact workspace/runtime/authority state, then continue only the rightful pending work.",
    "Do not infer completion from silence. Do not repeat an external effect or publish without current authority readback, effect reconciliation, and the existing publication gate.",
    "Pending references: task:legacy, message:legacy",
  ].join("\n");
  const legacyEnvelope = {
    schemaVersion: 1 as const,
    envelopeRef: "envelope:legacy",
    targetExecutionScopeRef: "1111111111111111",
    missionRef: "mission:legacy",
    pendingWorkId: "wpw_11111111111111111111111111111111",
    pendingWorkGeneration: 1,
    pendingWorkSemanticDigestSha256: "a".repeat(64),
    workCycleRef: "work-cycle:legacy",
    correlationRef: "correlation:legacy",
    taskRefs: ["task:legacy"],
    messageRefs: ["message:legacy"],
    workItemRefs: [],
    body,
    bodyDigestSha256: wakeSha256(body),
    createdAt: new Date(nowMs).toISOString(),
    authority: EXECUTION_WAKE_COORDINATION_AUTHORITY,
  };
  const attemptPayload = {
    schemaVersion: 1,
    attemptId: "wat_11111111111111111111111111111111",
    permit: {
      schemaVersion: 1,
      envelope: legacyEnvelope,
    },
  };
  try {
    database.sqlite.prepare(`
      insert into execution_wake_pending_work (
        pending_work_id, target_execution_scope_ref, mission_ref, generation,
        source_generation, semantic_digest_sha256, state, revision, is_current,
        payload_json, payload_digest_sha256, created_at_ms, updated_at_ms,
        expires_at_ms
      ) values (?, ?, ?, 1, 1, ?, 'pending', 1, 1, '{}', ?, ?, ?, ?)
    `).run(
      legacyEnvelope.pendingWorkId,
      legacyEnvelope.targetExecutionScopeRef,
      legacyEnvelope.missionRef,
      legacyEnvelope.pendingWorkSemanticDigestSha256,
      "b".repeat(64),
      nowMs,
      nowMs,
      nowMs + 60_000,
    );
    database.sqlite.prepare(`
      insert into execution_wake_attempts (
        attempt_id, wake_key, actor_scope_ref, target_execution_scope_ref,
        mission_ref, pending_work_id, pending_work_generation,
        attempt_sequence, state, revision, payload_json,
        payload_digest_sha256, created_at_ms, updated_at_ms, cooldown_until_ms
      ) values (?, ?, ?, ?, ?, ?, 1, 1, 'prepared', 1, ?, ?, ?, ?, ?)
    `).run(
      attemptPayload.attemptId,
      "wky_11111111111111111111111111111111",
      "2222222222222222",
      legacyEnvelope.targetExecutionScopeRef,
      legacyEnvelope.missionRef,
      legacyEnvelope.pendingWorkId,
      JSON.stringify(attemptPayload),
      "c".repeat(64),
      nowMs,
      nowMs,
      nowMs,
    );
    database.sqlite.prepare(`
      insert into execution_wake_commands (
        actor_scope_ref, idempotency_key, command_kind,
        payload_digest_sha256, result_json, created_at_ms
      ) values (?, ?, 'legacy_test', ?, ?, ?)
    `).run(
      "2222222222222222",
      "legacy-wake-command",
      "d".repeat(64),
      JSON.stringify({ value: attemptPayload }),
      nowMs,
    );
    database.sqlite.prepare(
      "delete from devspace_schema_migrations where version = 16",
    ).run();
  } finally {
    database.close();
  }

  const migrated = openDatabase(stateDir);
  try {
    const attempt = JSON.parse(
      migrated.sqlite.prepare(`
        select payload_json from execution_wake_attempts where attempt_id = ?
      `).pluck().get(attemptPayload.attemptId) as string,
    ) as typeof attemptPayload & {
      permit: { envelope: Record<string, unknown> };
    };
    const command = JSON.parse(
      migrated.sqlite.prepare(`
        select result_json from execution_wake_commands
        where actor_scope_ref = ? and idempotency_key = ?
      `).pluck().get("2222222222222222", "legacy-wake-command") as string,
    ) as { value: { permit: { envelope: Record<string, unknown> } } };
    assert.equal(attempt.permit.envelope.schemaVersion, 2);
    assert.equal("body" in attempt.permit.envelope, false);
    assert.equal("body" in command.value.permit.envelope, false);
    assert.equal(
      materializeWakeContinuationBody(
        attempt.permit.envelope as Parameters<
          typeof materializeWakeContinuationBody
        >[0],
      ),
      body,
    );
  } finally {
    migrated.close();
  }
}

function testPersistenceAndTokenHashing(stateDir: string): void {
  const accessToken = "access-token-example";
  const refreshToken = "refresh-token-example";
  const firstStore = new SqliteOAuthStore(stateDir);
  const firstClients = new SqliteOAuthClientsStore(firstStore, oauthConfig.allowedRedirectHosts);
  const client = firstClients.registerClient({
    redirect_uris: [redirectUri],
    client_name: "ChatGPT",
  });

  firstStore.saveTokenPair({
    accessTokenHash: hashToken(accessToken),
    accessToken: {
      clientId: client.client_id,
      scopes: ["devspace"],
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      resource: mcpUrl.href,
    },
    refreshTokenHash: hashToken(refreshToken),
    refreshToken: {
      clientId: client.client_id,
      scopes: ["devspace"],
      expiresAt: Math.floor(Date.now() / 1000) + 2592000,
      resource: mcpUrl.href,
    },
  });
  firstStore.close();

  const database = openDatabase(stateDir);
  try {
    const accessHashes = database.sqlite
      .prepare("select token_hash from oauth_access_tokens")
      .pluck()
      .all() as string[];
    const refreshHashes = database.sqlite
      .prepare("select token_hash from oauth_refresh_tokens")
      .pluck()
      .all() as string[];
    assert.deepEqual(accessHashes, [hashToken(accessToken)]);
    assert.deepEqual(refreshHashes, [hashToken(refreshToken)]);
    assert.equal(accessHashes.includes(accessToken), false);
    assert.equal(refreshHashes.includes(refreshToken), false);
  } finally {
    database.close();
  }

  const restoredStore = new SqliteOAuthStore(stateDir);
  try {
    const restoredClient = restoredStore.getClient(client.client_id);
    assert.equal(restoredClient?.client_id, client.client_id);
    assert.equal(restoredStore.getAccessToken(hashToken(accessToken))?.resource, mcpUrl.href);
    assert.equal(restoredStore.getRefreshToken(hashToken(refreshToken))?.clientId, client.client_id);
  } finally {
    restoredStore.close();
  }
}

function testExpiredTokenCleanup(stateDir: string): void {
  const store = new SqliteOAuthStore(stateDir);
  const client = new SqliteOAuthClientsStore(store, oauthConfig.allowedRedirectHosts).registerClient({
    redirect_uris: [redirectUri],
  });
  const expiredAt = Math.floor(Date.now() / 1000) - 1;
  store.saveTokenPair({
    accessTokenHash: "expired-access-hash",
    accessToken: { clientId: client.client_id, scopes: ["devspace"], expiresAt: expiredAt },
    refreshTokenHash: "expired-refresh-hash",
    refreshToken: { clientId: client.client_id, scopes: ["devspace"], expiresAt: expiredAt },
  });
  store.close();

  const reopened = new SqliteOAuthStore(stateDir);
  try {
    assert.equal(reopened.getAccessToken("expired-access-hash"), undefined);
    assert.equal(reopened.getRefreshToken("expired-refresh-hash"), undefined);
  } finally {
    reopened.close();
  }
}

function testTransactionalTokenRotation(stateDir: string): void {
  const store = new SqliteOAuthStore(stateDir);
  try {
    const client = new SqliteOAuthClientsStore(store, oauthConfig.allowedRedirectHosts).registerClient({
      redirect_uris: [redirectUri],
    });
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    store.saveRefreshToken("old-refresh-hash", {
      clientId: client.client_id,
      scopes: ["devspace"],
      expiresAt,
    });

    assert.equal(
      store.saveTokenPair(
        {
          accessTokenHash: "new-access-hash",
          accessToken: { clientId: client.client_id, scopes: ["devspace"], expiresAt },
          refreshTokenHash: "new-refresh-hash",
          refreshToken: { clientId: client.client_id, scopes: ["devspace"], expiresAt },
        },
        "old-refresh-hash",
      ),
      true,
    );
    assert.equal(store.getRefreshToken("old-refresh-hash"), undefined);
    assert.ok(store.getAccessToken("new-access-hash"));
    assert.ok(store.getRefreshToken("new-refresh-hash"));

    assert.equal(
      store.saveTokenPair(
        {
          accessTokenHash: "losing-access-hash",
          accessToken: { clientId: client.client_id, scopes: ["devspace"], expiresAt },
          refreshTokenHash: "losing-refresh-hash",
          refreshToken: { clientId: client.client_id, scopes: ["devspace"], expiresAt },
        },
        "old-refresh-hash",
      ),
      false,
    );
    assert.equal(store.getAccessToken("losing-access-hash"), undefined);
    assert.equal(store.getRefreshToken("losing-refresh-hash"), undefined);
  } finally {
    store.close();
  }
}

async function testProviderRestartRotationAndRevocation(stateDir: string): Promise<void> {
  const firstProvider = new SingleUserOAuthProvider(oauthConfig, mcpUrl, stateDir);
  const client = await firstProvider.clientsStore.registerClient?.({
    redirect_uris: [redirectUri],
    client_name: "ChatGPT",
  });
  assert.ok(client);

  const code = "code-test-123";
  firstProvider["codes"].set(code, {
    clientId: client.client_id,
    params: {
      redirectUri,
      codeChallenge: "challenge",
      scopes: ["devspace"],
      resource: mcpUrl,
    },
    expiresAtMs: Date.now() + 60_000,
  });
  const issued = await firstProvider.exchangeAuthorizationCode(
    client,
    code,
    undefined,
    redirectUri,
    mcpUrl,
  );
  assert.ok(issued.refresh_token);
  firstProvider.close();

  const secondProvider = new SingleUserOAuthProvider(oauthConfig, mcpUrl, stateDir);
  try {
    const verified = await secondProvider.verifyAccessToken(issued.access_token);
    assert.equal(verified.clientId, client.client_id);

    const refreshed = await secondProvider.exchangeRefreshToken(
      client,
      issued.refresh_token,
      ["devspace"],
      mcpUrl,
    );
    assert.ok(refreshed.refresh_token);
    assert.notEqual(refreshed.access_token, issued.access_token);

    await assert.rejects(
      secondProvider.exchangeRefreshToken(client, issued.refresh_token, ["devspace"], mcpUrl),
      InvalidGrantError,
    );

    await secondProvider.revokeToken(client, { token: refreshed.access_token });
    await assert.rejects(secondProvider.verifyAccessToken(refreshed.access_token), InvalidTokenError);

    await secondProvider.revokeToken(client, { token: refreshed.refresh_token });
    await assert.rejects(
      secondProvider.exchangeRefreshToken(client, refreshed.refresh_token, ["devspace"], mcpUrl),
      InvalidGrantError,
    );
  } finally {
    secondProvider.close();
  }
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}
