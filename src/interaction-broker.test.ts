import assert from "node:assert/strict";
import test from "node:test";
import {
  InteractionBroker,
  InteractionBrokerError,
  interactionBrokerPolicy,
  type InteractionBrokerLease,
  type InteractionBrokerRecord,
  type InteractionBrokerStore,
} from "./interaction-broker.js";
import {
  InteractionSession,
  type InteractionActionRequest,
  type InteractionAdapter,
  type InteractionAdapterDescriptor,
  type InteractionBinding,
  type InteractionCheckpoint,
  type InteractionObservation,
  type InteractionObservationInput,
} from "./interaction-harness.js";

const sha = (character: string): string => character.repeat(64);

function clone<T>(value: T): T {
  return structuredClone(value);
}

class TestClock {
  private current = Date.parse("2026-08-18T06:00:00.000Z");

  now = (): number => this.current;

  advance(milliseconds: number): void {
    this.current += milliseconds;
  }

  iso(): string {
    return new Date(this.current).toISOString();
  }
}

class InMemoryBrokerStore implements InteractionBrokerStore {
  private readonly leases = new Map<string, InteractionBrokerLease>();
  private readonly sessions = new Map<string, InteractionBrokerRecord>();
  private failNextCompareAndSwap = false;
  compareAndSwapCalls = 0;

  async claimLease(input: {
    resourceRef: string;
    leaseId: string;
    holderScopeRef: string;
    nowMs: number;
    ttlMs: number;
  }) {
    const current = this.leases.get(input.resourceRef);
    if (current && Date.parse(current.expiresAt) > input.nowMs) {
      return { acquired: false, current: clone(current) };
    }
    const lease: InteractionBrokerLease = {
      resourceRef: input.resourceRef,
      leaseId: input.leaseId,
      holderScopeRef: input.holderScopeRef,
      generation: (current?.generation ?? 0) + 1,
      acquiredAt: new Date(input.nowMs).toISOString(),
      expiresAt: new Date(input.nowMs + input.ttlMs).toISOString(),
    };
    this.leases.set(input.resourceRef, lease);
    return { acquired: true, lease: clone(lease) };
  }

  async renewLease(input: {
    resourceRef: string;
    leaseId: string;
    holderScopeRef: string;
    nowMs: number;
    ttlMs: number;
  }) {
    const current = this.leases.get(input.resourceRef);
    if (
      !current
      || current.leaseId !== input.leaseId
      || current.holderScopeRef !== input.holderScopeRef
      || Date.parse(current.expiresAt) <= input.nowMs
    ) {
      return undefined;
    }
    const renewed: InteractionBrokerLease = {
      ...current,
      expiresAt: new Date(input.nowMs + input.ttlMs).toISOString(),
    };
    this.leases.set(input.resourceRef, renewed);
    return clone(renewed);
  }

  async releaseLease(input: {
    resourceRef: string;
    leaseId: string;
    holderScopeRef: string;
    nowMs: number;
  }) {
    void input.nowMs;
    const current = this.leases.get(input.resourceRef);
    if (
      !current
      || current.leaseId !== input.leaseId
      || current.holderScopeRef !== input.holderScopeRef
    ) {
      return false;
    }
    this.leases.delete(input.resourceRef);
    return true;
  }

  async loadSession(sessionRef: string) {
    const record = this.sessions.get(sessionRef);
    return record ? clone(record) : undefined;
  }

  async compareAndSwapSession(input: {
    record: Omit<InteractionBrokerRecord, "version">;
    expectedVersion: number;
    resourceRef: string;
    leaseId: string;
    holderScopeRef: string;
    nowMs: number;
  }) {
    this.compareAndSwapCalls += 1;
    if (this.failNextCompareAndSwap) {
      this.failNextCompareAndSwap = false;
      const current = this.sessions.get(input.record.sessionRef);
      return {
        saved: false,
        current: current ? clone(current) : undefined,
        reason: "version_conflict" as const,
      };
    }
    const lease = this.leases.get(input.resourceRef);
    if (!lease || Date.parse(lease.expiresAt) <= input.nowMs) {
      return { saved: false, reason: "lease_missing" as const };
    }
    if (
      lease.leaseId !== input.leaseId
      || lease.holderScopeRef !== input.holderScopeRef
    ) {
      return { saved: false, reason: "lease_mismatch" as const };
    }
    const current = this.sessions.get(input.record.sessionRef);
    const currentVersion = current?.version ?? 0;
    if (currentVersion !== input.expectedVersion) {
      return {
        saved: false,
        current: current ? clone(current) : undefined,
        reason: "version_conflict" as const,
      };
    }
    const saved: InteractionBrokerRecord = {
      ...clone(input.record),
      version: currentVersion + 1,
    };
    this.sessions.set(saved.sessionRef, saved);
    return { saved: true, record: clone(saved) };
  }

  failNextCas(): void {
    this.failNextCompareAndSwap = true;
  }

  getRecord(sessionRef: string): InteractionBrokerRecord | undefined {
    const record = this.sessions.get(sessionRef);
    return record ? clone(record) : undefined;
  }

  seed(record: InteractionBrokerRecord): void {
    this.sessions.set(record.sessionRef, clone(record));
  }
}

function ids() {
  let sequence = 0;
  return (prefix: "ixs" | "obs" | "act"): string => {
    sequence += 1;
    return `${prefix}_${String(sequence).padStart(4, "0")}`;
  };
}

const descriptor: InteractionAdapterDescriptor = {
  id: "playwright-broker-test",
  surface: "playwright",
  available: true,
  targetKinds: ["browser"],
  supportedActionKinds: [
    "inspect",
    "navigate",
    "click",
    "type",
    "select",
    "upload",
    "download",
    "window_control",
  ],
  minimumEffectClassByAction: {
    inspect: "read_only",
    navigate: "reversible",
    click: "reversible",
    type: "reversible",
    select: "reversible",
    upload: "irreversible",
    download: "reversible",
    window_control: "reversible",
  },
  capabilities: {
    observe: true,
    semanticTargeting: true,
    coordinateTargeting: false,
    verify: true,
    boundedTimeout: true,
    screenshotEvidence: true,
    traceEvidence: true,
    persistentSession: true,
    isolatedSession: false,
    visibleUi: true,
    fileTransfer: true,
  },
  concurrency: "exclusive",
  busy: false,
  sessionRef: "extension-display-10",
};

const binding: InteractionBinding = {
  adapterId: descriptor.id,
  surface: descriptor.surface,
  backendSessionRef: "extension-display-10",
  contextRef: "tab-settings",
  targetKind: "browser",
};

function observationInput(
  clock: TestClock,
  overrides: Partial<InteractionObservationInput> = {},
): InteractionObservationInput {
  return {
    binding,
    stateDigestSha256: sha("a"),
    observedAt: clock.iso(),
    evidence: [
      {
        kind: "accessibility_snapshot",
        ref: "artifact://broker/tab-settings/before",
        sha256: sha("b"),
      },
    ],
    frontier: {
      url: "https://example.test/settings",
      title: "Settings",
    },
    ...overrides,
  };
}

function actionRequest(
  observation: InteractionObservation,
  overrides: Partial<InteractionActionRequest> = {},
): InteractionActionRequest {
  return {
    idempotencyKey: "save-settings-v1",
    kind: "click",
    effectClass: "reversible",
    target: {
      strategy: "semantic",
      role: "button",
      accessibleName: "Save",
    },
    expectedObservationId: observation.observationId,
    expectedPreStateDigestSha256: observation.stateDigestSha256,
    payloadDigestSha256: sha("c"),
    declaredIdempotent: true,
    approval: {
      state: "approved",
      ref: "owner-approval://settings-save/1",
      actorRef: "owner",
    },
    postconditions: [
      {
        kind: "text_visible",
        expected: "Settings saved",
      },
    ],
    ...overrides,
  };
}

function successfulAdapter(
  clock: TestClock,
  overrides: Partial<InteractionAdapter> = {},
): InteractionAdapter {
  return {
    descriptor,
    async observe() {
      return observationInput(clock);
    },
    async act(action) {
      return {
        actionId: action.actionId,
        status: "succeeded",
        backendReceiptRef: "adapter-receipt://action/1",
        evidence: [
          {
            kind: "trace",
            ref: "artifact://broker/action-trace/1",
            sha256: sha("d"),
          },
        ],
      };
    },
    async verify(action) {
      return {
        actionId: action.actionId,
        verified: true,
        binding,
        postStateDigestSha256: sha("e"),
        verifiedAt: clock.iso(),
        evidence: [
          {
            kind: "accessibility_snapshot",
            ref: "artifact://broker/tab-settings/after",
            sha256: sha("f"),
          },
        ],
        frontier: {
          url: "https://example.test/settings",
          title: "Settings saved",
        },
      };
    },
    ...overrides,
  };
}

async function openBroker(input: {
  store: InMemoryBrokerStore;
  clock: TestClock;
  adapter?: InteractionAdapter;
  scopeRef?: string;
  sessionRef?: string;
  adoption?: {
    priorExecutionScopeRef: string;
    handoffRef: string;
    authorityReadbackRef: string;
  };
  adoptionVerifier?: boolean;
  leaseId?: string;
}) {
  return InteractionBroker.open({
    store: input.store,
    adapter: input.adapter ?? successfulAdapter(input.clock),
    identity: {
      executionScopeRef: input.scopeRef ?? "1111111111111111",
      workspaceId: "ws_broker",
      missionRef: "interaction-broker-test",
    },
    ...(input.sessionRef ? { sessionRef: input.sessionRef } : {}),
    ...(input.adoption ? { adoption: input.adoption } : {}),
    ...(input.adoptionVerifier === false
      ? {}
      : {
          adoptionVerifier: ({ handoffRef, authorityReadbackRef }) => ({
            verified: handoffRef.startsWith("handoff://")
              && authorityReadbackRef.startsWith("owner-readback://"),
            verificationRef: "adoption-verification://interaction-broker-test/1",
          }),
        }),
    now: input.clock.now,
    idFactory: ids(),
    approvalVerifier: ({ approval }) => ({
      verified: approval.state === "approved",
      verificationRef: "approval-verification://interaction-broker-test/1",
      authorityReadbackRef: "owner-readback://interaction-broker-test/1",
    }),
    reconciliationVerifier: ({ resolution }) => ({
      verified: resolution === "effect_absent" || resolution === "effect_verified",
      verificationRef: "reconciliation-verification://interaction-broker-test/1",
      authorityReadbackRef: "owner-readback://interaction-broker-test/reconciliation/1",
    }),
    leaseIdFactory: () => input.leaseId ?? "lease-test",
    leaseTtlMs: 10_000,
  });
}

test("broker persists acting before dispatch and verified state after postcondition proof", async () => {
  const clock = new TestClock();
  const store = new InMemoryBrokerStore();
  let sessionRef = "";
  let observedStateDuringDispatch = "";
  const adapter = successfulAdapter(clock, {
    async act(action) {
      const persisted = store.getRecord(sessionRef);
      observedStateDuringDispatch = persisted?.checkpoint.state ?? "missing";
      assert.equal(persisted?.checkpoint.pendingAction?.actionId, action.actionId);
      return {
        actionId: action.actionId,
        status: "succeeded",
        evidence: [{ kind: "trace", ref: "artifact://trace/dispatch", sha256: sha("1") }],
      };
    },
  });
  const broker = await openBroker({ store, clock, adapter });
  sessionRef = broker.status().record.sessionRef;
  const observed = await broker.observe({
    targetKind: "browser",
    effectClass: "reversible",
    visibleUiRequired: true,
    existingSessionRequired: true,
  });
  const result = await broker.act(actionRequest(observed.observation));

  assert.equal(observedStateDuringDispatch, "acting");
  assert.equal(result.record.checkpoint.state, "verified");
  assert.equal(result.record.checkpoint.pendingAction, undefined);
  assert.equal(result.record.checkpoint.verification?.postStateDigestSha256, sha("e"));
  assert.ok(result.record.version >= 5);
  await broker.close();
});

test("one adapter lease serializes brokers across execution scopes", async () => {
  const clock = new TestClock();
  const store = new InMemoryBrokerStore();
  const first = await openBroker({
    store,
    clock,
    scopeRef: "1111111111111111",
    leaseId: "lease-first",
  });
  await assert.rejects(
    () => openBroker({
      store,
      clock,
      scopeRef: "2222222222222222",
      leaseId: "lease-second",
    }),
    (error: unknown) => error instanceof InteractionBrokerError
      && error.code === "interaction_adapter_lease_busy",
  );
  assert.equal(await first.close(), true);
});

test("declared operation timeout extends the adapter lease past the base TTL", async () => {
  const clock = new TestClock();
  const store = new InMemoryBrokerStore();
  const adapter = successfulAdapter(clock, {
    async act(action) {
      clock.advance(12_000);
      return {
        actionId: action.actionId,
        status: "succeeded",
        evidence: [
          {
            kind: "trace",
            ref: "artifact://trace/long-action",
            sha256: sha("a"),
          },
        ],
      };
    },
  });
  const broker = await openBroker({ store, clock, adapter });
  const observed = await broker.observe({
    targetKind: "browser",
    effectClass: "reversible",
  });
  const result = await broker.act(actionRequest(observed.observation, {
    timeoutMs: 20_000,
  }));
  assert.equal(result.record.checkpoint.state, "verified");
  assert.equal(result.record.policy.operationLeaseExtendsPastDeclaredTimeout, true);
  await broker.close();
});

test("an externally busy Playwright client blocks broker activation", async () => {
  const clock = new TestClock();
  const store = new InMemoryBrokerStore();
  const adapter = successfulAdapter(clock, {
    descriptor: { ...descriptor, busy: true },
  });
  await assert.rejects(
    () => openBroker({ store, clock, adapter }),
    (error: unknown) => error instanceof InteractionBrokerError
      && error.code === "interaction_adapter_externally_busy",
  );
});

test("adapter transport loss after dispatch persists an indeterminate checkpoint", async () => {
  const clock = new TestClock();
  const store = new InMemoryBrokerStore();
  const adapter = successfulAdapter(clock, {
    async act() {
      throw new Error("stdio closed after dispatch");
    },
  });
  const broker = await openBroker({ store, clock, adapter });
  const observed = await broker.observe({
    targetKind: "browser",
    effectClass: "reversible",
  });
  const result = await broker.act(actionRequest(observed.observation));
  assert.equal(result.outcome?.status, "unknown");
  assert.equal(result.record.checkpoint.state, "indeterminate");
  assert.equal(result.record.policy.blindReplayAllowed, false);
  assert.equal(
    store.getRecord(result.record.sessionRef)?.checkpoint.state,
    "indeterminate",
  );
  await broker.close();
});

test("a crash boundary with a durable acting checkpoint recovers as indeterminate", async () => {
  const clock = new TestClock();
  const store = new InMemoryBrokerStore();
  const session = new InteractionSession(
    {
      sessionRef: "ixs_crash",
      executionScopeRef: "1111111111111111",
      workspaceId: "ws_broker",
    },
    {
      now: clock.now,
      idFactory: ids(),
      approvalVerifier: ({ approval }) => ({
        verified: approval.state === "approved",
        verificationRef: "approval-verification://interaction-broker-test/crash",
        authorityReadbackRef: "owner-readback://interaction-broker-test/crash",
      }),
      reconciliationVerifier: ({ resolution }) => ({
        verified: resolution === "effect_absent" || resolution === "effect_verified",
        verificationRef: "reconciliation-verification://interaction-broker-test/crash",
        authorityReadbackRef: "owner-readback://interaction-broker-test/crash/reconciliation",
      }),
    },
  );
  session.recordObservation(observationInput(clock));
  const observation = session.checkpoint().observation;
  assert.ok(observation);
  session.beginAction(actionRequest(observation), descriptor);
  const checkpoint = session.checkpoint();
  assert.equal(checkpoint.state, "acting");
  const record: InteractionBrokerRecord = {
    schemaVersion: 1,
    sessionRef: checkpoint.identity.sessionRef,
    version: 4,
    adapterResourceRef: "interaction-adapter:playwright-broker-test:extension-display-10",
    adapterId: descriptor.id,
    currentExecutionScopeRef: "1111111111111111",
    scopeLineage: [
      { scopeRef: "1111111111111111", enteredAt: clock.iso() },
    ],
    checkpoint,
    updatedAt: clock.iso(),
    policy: interactionBrokerPolicy(),
  };
  store.seed(record);

  const broker = await openBroker({
    store,
    clock,
    sessionRef: "ixs_crash",
    leaseId: "lease-recovery",
  });
  assert.equal(broker.status().record.checkpoint.state, "indeterminate");
  assert.equal(
    broker.status().record.checkpoint.hold?.code,
    "recovered_with_unsettled_action",
  );
  await broker.close();
});

test("cross-scope continuation requires an exact handoff and records scope lineage", async () => {
  const clock = new TestClock();
  const store = new InMemoryBrokerStore();
  const first = await openBroker({
    store,
    clock,
    scopeRef: "1111111111111111",
    leaseId: "lease-first",
  });
  const sessionRef = first.status().record.sessionRef;
  await first.observe({ targetKind: "browser", effectClass: "read_only" });
  await first.close();

  await assert.rejects(
    () => openBroker({
      store,
      clock,
      sessionRef,
      scopeRef: "2222222222222222",
      leaseId: "lease-no-handoff",
    }),
    (error: unknown) => error instanceof InteractionBrokerError
      && error.code === "interaction_scope_adoption_required",
  );

  await assert.rejects(
    () => openBroker({
      store,
      clock,
      sessionRef,
      scopeRef: "2222222222222222",
      leaseId: "lease-unverified-handoff",
      adoptionVerifier: false,
      adoption: {
        priorExecutionScopeRef: "1111111111111111",
        handoffRef: "handoff://interaction/session/1",
        authorityReadbackRef: "owner-readback://interaction/session/1",
      },
    }),
    (error: unknown) => error instanceof InteractionBrokerError
      && error.code === "interaction_scope_adoption_unverified",
  );

  await assert.rejects(
    () => openBroker({
      store,
      clock,
      sessionRef,
      scopeRef: "2222222222222222",
      leaseId: "lease-credential-bearing-handoff",
      adoption: {
        priorExecutionScopeRef: "1111111111111111",
        handoffRef: "handoff://interaction/session/1?token=embedded-secret",
        authorityReadbackRef: "owner-readback://interaction/session/1",
      },
    }),
    (error: unknown) => error instanceof InteractionBrokerError
      && error.code === "interaction_broker_credential_reference_rejected",
  );

  const adopted = await openBroker({
    store,
    clock,
    sessionRef,
    scopeRef: "2222222222222222",
    leaseId: "lease-handoff",
    adoption: {
      priorExecutionScopeRef: "1111111111111111",
      handoffRef: "handoff://interaction/session/1",
      authorityReadbackRef: "owner-readback://interaction/session/1",
    },
  });
  const status = adopted.status();
  assert.equal(status.record.currentExecutionScopeRef, "2222222222222222");
  assert.equal(status.record.checkpoint.identity.executionScopeRef, "2222222222222222");
  assert.deepEqual(
    status.record.scopeLineage.map((entry) => entry.scopeRef),
    ["1111111111111111", "2222222222222222"],
  );
  assert.equal(status.record.scopeLineage[1]?.handoffRef, "handoff://interaction/session/1");
  assert.equal(
    status.record.scopeLineage[1]?.adoptionVerificationRef,
    "adoption-verification://interaction-broker-test/1",
  );
  await adopted.close();
});

test("checkpoint failure before dispatch blocks the adapter call", async () => {
  const clock = new TestClock();
  const store = new InMemoryBrokerStore();
  let dispatchCount = 0;
  const adapter = successfulAdapter(clock, {
    async act(action) {
      dispatchCount += 1;
      return { actionId: action.actionId, status: "succeeded" };
    },
  });
  const broker = await openBroker({ store, clock, adapter });
  const observed = await broker.observe({ targetKind: "browser", effectClass: "reversible" });
  store.failNextCas();
  await assert.rejects(
    () => broker.act(actionRequest(observed.observation)),
    (error: unknown) => error instanceof InteractionBrokerError
      && error.code === "checkpoint_persistence_failed_before_dispatch",
  );
  assert.equal(dispatchCount, 0);
  assert.throws(
    () => broker.status(),
    (error: unknown) => error instanceof InteractionBrokerError
      && error.code === "interaction_broker_fenced",
  );
  await broker.close();
});

test("checkpoint conflict after dispatch reports an indeterminate local checkpoint", async () => {
  const clock = new TestClock();
  const store = new InMemoryBrokerStore();
  let dispatchCount = 0;
  const adapter = successfulAdapter(clock, {
    async act(action) {
      dispatchCount += 1;
      store.failNextCas();
      return {
        actionId: action.actionId,
        status: "succeeded",
        evidence: [{ kind: "trace", ref: "artifact://trace/dispatched", sha256: sha("8") }],
      };
    },
  });
  const broker = await openBroker({ store, clock, adapter });
  const observed = await broker.observe({ targetKind: "browser", effectClass: "reversible" });
  await assert.rejects(
    () => broker.act(actionRequest(observed.observation)),
    (error: unknown) => error instanceof InteractionBrokerError
      && error.code === "post_dispatch_checkpoint_persistence_failed"
      && error.details.checkpoint?.state === "indeterminate",
  );
  assert.equal(dispatchCount, 1);
  assert.throws(
    () => broker.status(),
    (error: unknown) => error instanceof InteractionBrokerError
      && error.code === "interaction_broker_fenced",
  );
  await assert.rejects(
    () => broker.renewLease(),
    (error: unknown) => error instanceof InteractionBrokerError
      && error.code === "interaction_broker_fenced",
  );
  await broker.close();
});

test("verified idempotent retries return the prior receipt without another dispatch", async () => {
  const clock = new TestClock();
  const store = new InMemoryBrokerStore();
  let dispatchCount = 0;
  const adapter = successfulAdapter(clock, {
    async act(action) {
      dispatchCount += 1;
      return {
        actionId: action.actionId,
        status: "succeeded",
        evidence: [{ kind: "trace", ref: "artifact://trace/idempotent", sha256: sha("9") }],
      };
    },
  });
  const broker = await openBroker({ store, clock, adapter });
  const observed = await broker.observe({ targetKind: "browser", effectClass: "reversible" });
  const request = actionRequest(observed.observation);
  const first = await broker.act(request);
  const replay = await broker.act(request);
  assert.equal(first.record.checkpoint.state, "verified");
  assert.equal(replay.started, false);
  assert.equal(replay.idempotentReplay, true);
  assert.equal(dispatchCount, 1);
  await broker.close();
});

test("an expired lease can be taken over and the former broker cannot resume dispatch", async () => {
  const clock = new TestClock();
  const store = new InMemoryBrokerStore();
  const first = await openBroker({
    store,
    clock,
    scopeRef: "1111111111111111",
    leaseId: "lease-expiring",
  });
  const sessionRef = first.status().record.sessionRef;
  clock.advance(10_001);
  const second = await openBroker({
    store,
    clock,
    scopeRef: "1111111111111111",
    sessionRef,
    leaseId: "lease-takeover",
  });
  assert.equal(second.status().lease.generation, 2);
  await assert.rejects(
    () => first.renewLease(),
    (error: unknown) => error instanceof InteractionBrokerError
      && error.code === "interaction_adapter_lease_lost",
  );
  await second.close();
});

test("indeterminate checkpoints can be reconciled only through exact-binding readback", async () => {
  const clock = new TestClock();
  const store = new InMemoryBrokerStore();
  const adapter = successfulAdapter(clock, {
    async act() {
      throw new Error("transport lost");
    },
  });
  const broker = await openBroker({ store, clock, adapter });
  const observed = await broker.observe({ targetKind: "browser", effectClass: "reversible" });
  const acted = await broker.act(actionRequest(observed.observation));
  const actionId = acted.record.checkpoint.pendingAction?.actionId;
  assert.ok(actionId);

  await assert.rejects(
    () => broker.reconcile({
      actionId,
      resolution: "effect_absent",
      binding: { ...binding, contextRef: "another-tab" },
      postStateDigestSha256: sha("a"),
      evidence: [{ kind: "accessibility_snapshot", ref: "artifact://wrong-context" }],
    }),
    /exact adapter session|exact.*context|binding/i,
  );

  const reconciled = await broker.reconcile({
    actionId,
    resolution: "effect_absent",
    binding,
    postStateDigestSha256: sha("a"),
    evidence: [
      {
        kind: "accessibility_snapshot",
        ref: "artifact://broker/tab-settings/reconciled",
        sha256: sha("0"),
      },
    ],
  });
  assert.equal(reconciled.checkpoint.state, "ready");
  assert.equal(reconciled.checkpoint.pendingAction, undefined);
  await broker.close();
});

test("broker records its narrow executor-local authority ceiling", async () => {
  const clock = new TestClock();
  const store = new InMemoryBrokerStore();
  const broker = await openBroker({ store, clock });
  const policy = broker.status().policy;
  assert.equal(policy.singleAdapterLeaseRequired, true);
  assert.equal(policy.persistBeforeDispatch, true);
  assert.equal(policy.canonicalTaskAuthority, false);
  assert.equal(policy.canonicalDecisionAuthority, false);
  assert.equal(policy.canonicalEffectOutcomeAuthority, false);
  assert.equal(policy.publicationAuthority, false);
  await broker.close();
});

function seedRecordFromCheckpoint(
  checkpoint: InteractionCheckpoint,
  clock: TestClock,
): InteractionBrokerRecord {
  return {
    schemaVersion: 1,
    sessionRef: checkpoint.identity.sessionRef,
    version: 1,
    adapterResourceRef: "interaction-adapter:playwright-broker-test:extension-display-10",
    adapterId: descriptor.id,
    currentExecutionScopeRef: checkpoint.identity.executionScopeRef,
    scopeLineage: [
      { scopeRef: checkpoint.identity.executionScopeRef, enteredAt: clock.iso() },
    ],
    checkpoint,
    updatedAt: clock.iso(),
    policy: interactionBrokerPolicy(),
  };
}

void seedRecordFromCheckpoint;
