import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  interactionBrokerPolicy,
  type InteractionBrokerRecord,
} from "./interaction-broker.js";
import { SqliteInteractionBrokerStore } from "./interaction-broker-store.js";
import { InteractionSession } from "./interaction-harness.js";
import { openDatabase } from "./db/client.js";

test("SQLite interaction broker store enforces cross-handle lease and session CAS", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-interaction-broker-store-"));
  const firstDatabase = openDatabase(root);
  const secondDatabase = openDatabase(root);
  const first = new SqliteInteractionBrokerStore(firstDatabase);
  const second = new SqliteInteractionBrokerStore(secondDatabase);
  t.after(async () => {
    firstDatabase.close();
    secondDatabase.close();
    await rm(root, { recursive: true, force: true });
  });

  const resourceRef = "interaction-adapter:test-playwright:shared-session";
  const firstScope = "1111111111111111";
  const secondScope = "2222222222222222";
  const nowMs = Date.parse("2026-08-19T06:00:00.000Z");
  const claimed = await first.claimLease({
    resourceRef,
    leaseId: "lease-one",
    holderScopeRef: firstScope,
    nowMs,
    ttlMs: 10_000,
  });
  assert.equal(claimed.acquired, true);
  assert.equal(claimed.lease?.generation, 1);

  const blocked = await second.claimLease({
    resourceRef,
    leaseId: "lease-two",
    holderScopeRef: secondScope,
    nowMs: nowMs + 1,
    ttlMs: 10_000,
  });
  assert.equal(blocked.acquired, false);
  assert.equal(blocked.current?.leaseId, "lease-one");
  assert.equal(blocked.current?.holderScopeRef, firstScope);

  assert.equal(await second.renewLease({
    resourceRef,
    leaseId: "lease-one",
    holderScopeRef: secondScope,
    nowMs: nowMs + 2,
    ttlMs: 20_000,
  }), undefined);
  const renewed = await first.renewLease({
    resourceRef,
    leaseId: "lease-one",
    holderScopeRef: firstScope,
    nowMs: nowMs + 2,
    ttlMs: 20_000,
  });
  assert.equal(renewed?.expiresAt, new Date(nowMs + 20_002).toISOString());

  const sessionRef = "ixs_store_contract";
  const checkpoint = new InteractionSession({
    sessionRef,
    executionScopeRef: firstScope,
    missionRef: "interaction-store-contract",
  }).checkpoint();
  const baseRecord: Omit<InteractionBrokerRecord, "version"> = {
    schemaVersion: 1,
    sessionRef,
    adapterResourceRef: resourceRef,
    adapterId: "test-playwright",
    currentExecutionScopeRef: firstScope,
    scopeLineage: [{
      scopeRef: firstScope,
      enteredAt: new Date(nowMs).toISOString(),
    }],
    checkpoint,
    updatedAt: new Date(nowMs).toISOString(),
    policy: interactionBrokerPolicy(),
  };
  const saved = await first.compareAndSwapSession({
    record: baseRecord,
    expectedVersion: 0,
    resourceRef,
    leaseId: "lease-one",
    holderScopeRef: firstScope,
    nowMs: nowMs + 3,
  });
  assert.equal(saved.saved, true);
  assert.equal(saved.record?.version, 1);
  assert.deepEqual(await second.loadSession(sessionRef), saved.record);

  const stale = await second.compareAndSwapSession({
    record: {
      ...baseRecord,
      updatedAt: new Date(nowMs + 4).toISOString(),
    },
    expectedVersion: 0,
    resourceRef,
    leaseId: "lease-one",
    holderScopeRef: firstScope,
    nowMs: nowMs + 4,
  });
  assert.equal(stale.saved, false);
  assert.equal(stale.reason, "version_conflict");
  assert.equal(stale.current?.version, 1);

  const advanced = await second.compareAndSwapSession({
    record: {
      ...baseRecord,
      scopeLineage: [
        ...baseRecord.scopeLineage,
        {
          scopeRef: firstScope,
          enteredAt: new Date(nowMs + 5).toISOString(),
          handoffRef: "handoff:store-contract",
        },
      ],
      updatedAt: new Date(nowMs + 5).toISOString(),
    },
    expectedVersion: 1,
    resourceRef,
    leaseId: "lease-one",
    holderScopeRef: firstScope,
    nowMs: nowMs + 5,
  });
  assert.equal(advanced.saved, true);
  assert.equal(advanced.record?.version, 2);

  assert.equal(await second.releaseLease({
    resourceRef,
    leaseId: "lease-one",
    holderScopeRef: secondScope,
    nowMs: nowMs + 6,
  }), false);
  assert.equal(await first.releaseLease({
    resourceRef,
    leaseId: "lease-one",
    holderScopeRef: firstScope,
    nowMs: nowMs + 6,
  }), true);

  const takeover = await second.claimLease({
    resourceRef,
    leaseId: "lease-two",
    holderScopeRef: secondScope,
    nowMs: nowMs + 7,
    ttlMs: 10_000,
  });
  assert.equal(takeover.acquired, true);
  assert.equal(takeover.lease?.generation, 2);
  const oldLeaseWrite = await first.compareAndSwapSession({
    record: baseRecord,
    expectedVersion: 2,
    resourceRef,
    leaseId: "lease-one",
    holderScopeRef: firstScope,
    nowMs: nowMs + 8,
  });
  assert.equal(oldLeaseWrite.saved, false);
  assert.equal(oldLeaseWrite.reason, "lease_mismatch");
});

test("expired SQLite broker lease advances the fencing generation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-interaction-broker-expiry-"));
  const database = openDatabase(root);
  const store = new SqliteInteractionBrokerStore(database);
  t.after(async () => {
    database.close();
    await rm(root, { recursive: true, force: true });
  });
  const nowMs = Date.parse("2026-08-19T06:10:00.000Z");
  const first = await store.claimLease({
    resourceRef: "interaction-adapter:test:expiry",
    leaseId: "lease-expired",
    holderScopeRef: "1111111111111111",
    nowMs,
    ttlMs: 5_000,
  });
  assert.equal(first.lease?.generation, 1);
  const second = await store.claimLease({
    resourceRef: "interaction-adapter:test:expiry",
    leaseId: "lease-successor",
    holderScopeRef: "2222222222222222",
    nowMs: nowMs + 5_001,
    ttlMs: 5_000,
  });
  assert.equal(second.acquired, true);
  assert.equal(second.lease?.generation, 2);
});
