import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  DEFAULT_EXECUTION_COORDINATION_CONFIG,
  ExecutionCoordinationManager,
  type ExecutionCoordinationConfig,
} from "./execution-coordination.js";
import { executionScopeIdentity, type ExecutionScopeIdentity } from "./request-meta.js";

interface Fixture {
  stateDir: string;
  owner: ExecutionScopeIdentity;
  worker: ExecutionScopeIdentity;
  reviewer: ExecutionScopeIdentity;
  outsider: ExecutionScopeIdentity;
  manager: ExecutionCoordinationManager;
  advance(ms: number): void;
  now(): number;
  restart(): ExecutionCoordinationManager;
}

async function fixture(
  t: TestContext,
  overrides: Partial<ExecutionCoordinationConfig> = {},
): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "devspace-execution-coordination-"));
  const stateDir = join(root, ".state");
  let nowMs = Date.parse("2026-08-18T06:00:00Z");
  const counters = new Map<string, number>();
  const managers: ExecutionCoordinationManager[] = [];
  const idFactory = (prefix: string) => {
    const next = (counters.get(prefix) ?? 0) + 1;
    counters.set(prefix, next);
    return `${prefix}_${next.toString(16).padStart(32, "0")}`;
  };
  const config: ExecutionCoordinationConfig = {
    ...DEFAULT_EXECUTION_COORDINATION_CONFIG,
    cleanupIntervalMs: 1,
    ...overrides,
  };
  const create = (installSchema: boolean) => {
    const manager = new ExecutionCoordinationManager(config, stateDir, {
      now: () => nowMs,
      idFactory,
      installSchema,
    });
    managers.push(manager);
    return manager;
  };
  const owner = identity("coordination-owner");
  const worker = identity("coordination-worker");
  const reviewer = identity("coordination-reviewer");
  const outsider = identity("coordination-outsider");
  const manager = create(true);

  t.after(async () => {
    for (const instance of managers) instance.close();
    await rm(root, { recursive: true, force: true });
  });

  return {
    stateDir,
    owner,
    worker,
    reviewer,
    outsider,
    manager,
    advance(ms: number) {
      nowMs += ms;
    },
    now: () => nowMs,
    restart: () => create(false),
  };
}

function identity(value: string): ExecutionScopeIdentity {
  const result = executionScopeIdentity({
    "devspace/execution-scope": value,
  });
  assert.ok(result);
  return result;
}

function publishPeer(
  context: Fixture,
  scope: ExecutionScopeIdentity,
  id: string,
  capabilities: string[] = [],
  expiresInHours?: number,
) {
  return context.manager.publishPeer(scope, {
    idempotencyKey: id,
    missionRef: `mission:${id}`,
    phase: "working",
    frontier: `frontier:${id}`,
    capabilities,
    ...(expiresInHours === undefined ? {} : { expiresInHours }),
  }).value;
}

function openTask(
  context: Fixture,
  scope: ExecutionScopeIdentity,
  id: string,
  overrides: Partial<Parameters<ExecutionCoordinationManager["openTask"]>[1]> = {},
) {
  return context.manager.openTask(scope, {
    ...overrides,
    idempotencyKey: overrides.idempotencyKey ?? id,
    missionRef: overrides.missionRef ?? `mission:${id}`,
    initialState: overrides.initialState ?? "working",
    recoveryRef: overrides.recoveryRef ?? `recovery:${id}`,
  }).value;
}

function candidate(id: string, baseSha = "main-001") {
  return {
    repositoryRef: "git:devspace-zesnexus",
    baseSha,
    candidateSha: `candidate-${id}`,
    treeSha: `tree-${id}`,
    affectedSurfaces: [
      {
        domain: "module" as const,
        ref: `src/${id}`,
        repositoryRef: "git:devspace-zesnexus",
      },
    ],
    artifactRefs: [`artifact:${id}`],
  };
}

test("peer cards are idempotent and expiry never implies task completion", async (t) => {
  const context = await fixture(t, {
    peerDefaultTtlMs: 1_000,
    peerMaxTtlMs: 60_000,
    taskOwnerDefaultLeaseMs: 1_000,
    taskOwnerMaxLeaseMs: 60_000,
  });
  const first = context.manager.publishPeer(context.owner, {
    idempotencyKey: "peer-owner",
    missionRef: "mission:owner",
    phase: "working",
    frontier: "Implementing the coordination plane.",
  });
  const replay = context.manager.publishPeer(context.owner, {
    idempotencyKey: "peer-owner",
    missionRef: "mission:owner",
    phase: "working",
    frontier: "Implementing the coordination plane.",
  });
  assert.equal(replay.idempotentReplay, true);
  assert.deepEqual(replay.value, first.value);
  assert.equal(first.value.generation, 1);
  assert.equal(first.value.authority.publicationAuthority, false);
  assert.equal(first.value.authority.completionInferredFromSilence, false);

  const task = openTask(context, context.owner, "task-silence", {
    idempotencyKey: "task-silence",
    missionRef: "mission:silence",
    initialState: "working",
    recoveryRef: "recovery:silence",
    adoptionMode: "any_eligible",
    ownerLeaseHours: 0.0003,
  });
  context.advance(2_000);

  const peers = context.manager.peers(context.worker);
  assert.equal(peers.find((peer) => peer.scopeRef === context.owner.scopeRef)?.freshness, "stale");
  assert.equal(context.manager.task(context.owner, task.taskId).state, "working");
  const assessment = context.manager.orphanAssessments(context.worker)
    .find((entry) => entry.taskId === task.taskId);
  assert.equal(assessment?.ownerLeaseExpired, true);
  assert.notEqual(assessment?.disposition, "not_orphaned");

  assert.throws(
    () => context.manager.publishPeer(context.owner, {
      idempotencyKey: "peer-owner-generation-mismatch",
      expectedGeneration: 0,
      missionRef: "mission:owner",
      phase: "working",
      frontier: "Stale update.",
    }),
    /generation mismatch/i,
  );
});

test("task state machine requires exact candidate, validation, leases, receipts, and readback", async (t) => {
  const context = await fixture(t);
  publishPeer(context, context.owner, "peer-owner", ["publisher"]);
  const task = openTask(context, context.owner, "task-lifecycle");

  const validating = context.manager.transitionTask(context.owner, {
    idempotencyKey: "task-validating",
    taskId: task.taskId,
    expectedRevision: 1,
    toState: "validating",
  }).value;
  assert.equal(validating.revision, 2);

  assert.throws(
    () => context.manager.transitionTask(context.owner, {
      idempotencyKey: "task-ready-missing-candidate",
      taskId: task.taskId,
      expectedRevision: 2,
      toState: "ready_for_integration",
      validationRefs: ["test:focused-pass"],
    }),
    /exact candidate identity/i,
  );

  const readyIntegration = context.manager.transitionTask(context.owner, {
    idempotencyKey: "task-ready-integration",
    taskId: task.taskId,
    expectedRevision: 2,
    toState: "ready_for_integration",
    candidate: candidate("lifecycle"),
    validationRefs: ["test:focused-pass", "typecheck:pass"],
  }).value;
  assert.equal(readyIntegration.state, "ready_for_integration");

  assert.throws(
    () => context.manager.transitionTask(context.owner, {
      idempotencyKey: "task-stale-revision",
      taskId: task.taskId,
      expectedRevision: 2,
      toState: "ready_for_publication",
    }),
    /revision mismatch/i,
  );

  const readyPublication = context.manager.transitionTask(context.owner, {
    idempotencyKey: "task-ready-publication",
    taskId: task.taskId,
    expectedRevision: 3,
    toState: "ready_for_publication",
  }).value;
  assert.equal(readyPublication.publisherScopeRef, context.owner.scopeRef);

  const hold = context.manager.publicationPlan(context.owner, {
    taskIds: [task.taskId],
    currentRepositoryRef: "git:devspace-zesnexus",
  });
  assert.equal(hold.decision, "HOLD");
  assert.ok(hold.reasonCodes.includes("CURRENT_MAIN_UNVERIFIED"));
  assert.ok(hold.reasonCodes.includes("EXTERNAL_PUBLICATION_LEASE_REQUIRED"));

  const readyPlan = context.manager.publicationPlan(context.owner, {
    taskIds: [task.taskId],
    currentRepositoryRef: "git:devspace-zesnexus",
    currentMainSha: "main-001",
    publicationLeaseRef: "lease:publication:1",
  });
  assert.equal(readyPlan.decision, "READY_TO_PUBLISH");
  assert.equal(readyPlan.requiresCompareAndSwapPush, true);
  assert.equal(readyPlan.requiresRemoteReadback, true);

  const publishing = context.manager.transitionTask(context.owner, {
    idempotencyKey: "task-publishing",
    taskId: task.taskId,
    expectedRevision: 4,
    toState: "publishing",
    publicationAttempt: {
      expectedMainSha: "main-001",
      publicationLeaseRef: "lease:publication:1",
      effectKey: "effect:push:task-lifecycle",
      currentAuthorityStateRefs: ["owner-main:main-001"],
    },
  }).value;
  assert.equal(publishing.state, "publishing");

  assert.throws(
    () => context.manager.transitionTask(context.owner, {
      idempotencyKey: "task-published-missing-readback",
      taskId: task.taskId,
      expectedRevision: 5,
      toState: "published",
    }),
    /publication receipts and exact remote readback/i,
  );

  const published = context.manager.transitionTask(context.owner, {
    idempotencyKey: "task-published",
    taskId: task.taskId,
    expectedRevision: 5,
    toState: "published",
    publicationReceiptRefs: ["git-push:receipt:1"],
    remoteReadbackRef: "owner-main:remote:main-002",
  }).value;
  assert.equal(published.state, "published");
  assert.ok(published.terminalAt);
});

test("typed threads remain task-bound and participant-scoped", async (t) => {
  const context = await fixture(t);
  const task = openTask(context, context.owner, "task-thread", {
    idempotencyKey: "task-thread",
    missionRef: "mission:thread",
    participantScopeRefs: [context.worker.scopeRef],
    visibility: "participants",
    recoveryRef: "recovery:thread",
    initialState: "working",
  });
  const opening = context.manager.sendEvent(context.owner, {
    idempotencyKey: "thread-opening",
    taskId: task.taskId,
    targetScopeRefs: [context.worker.scopeRef],
    kind: "proposal",
    body: "I will own the data model; please independently challenge the publication protocol.",
    subjectRefs: ["subject:a2a-publication"],
    evidenceRefs: ["evidence:a2a-spec"],
  }).value;
  const reply = context.manager.sendEvent(context.worker, {
    idempotencyKey: "thread-reply",
    taskId: task.taskId,
    replyToEventId: opening.eventId,
    targetScopeRefs: [context.owner.scopeRef],
    kind: "counterproposal",
    body: "Accepted, with an added external lease and remote-readback gate.",
  }).value;
  assert.equal(reply.threadId, opening.threadId);
  assert.equal(reply.contextId, opening.contextId);
  assert.deepEqual(
    context.manager.thread(context.worker, opening.threadId).map((event) => event.kind),
    ["proposal", "counterproposal"],
  );
  assert.throws(
    () => context.manager.thread(context.outsider, opening.threadId),
    /cannot read this coordination thread/i,
  );
  assert.throws(
    () => context.manager.sendEvent(context.worker, {
      idempotencyKey: "thread-outsider-target",
      taskId: task.taskId,
      targetScopeRefs: [context.outsider.scopeRef],
      kind: "announce",
      body: "This target is outside the task.",
    }),
    /not a participant/i,
  );
});

test("intent conflicts distinguish advisory cognition from blocking effects", async (t) => {
  const context = await fixture(t);
  const ownerTask = openTask(context, context.owner, "task-owner-intent", {
    idempotencyKey: "task-owner-intent",
    missionRef: "mission:owner-intent",
    participantScopeRefs: [context.worker.scopeRef],
    recoveryRef: "recovery:owner-intent",
    initialState: "working",
  });
  const workerTask = openTask(context, context.worker, "task-worker-intent", {
    idempotencyKey: "task-worker-intent",
    missionRef: "mission:worker-intent",
    participantScopeRefs: [context.owner.scopeRef],
    recoveryRef: "recovery:worker-intent",
    initialState: "working",
  });
  context.manager.declareIntent(context.owner, {
    idempotencyKey: "owner-read",
    taskId: ownerTask.taskId,
    kind: "read_interest",
    surfaces: [{
      domain: "path",
      ref: "src/execution-coordination.ts",
      repositoryRef: "git:devspace-zesnexus",
    }],
  });
  const workerWrite = context.manager.declareIntent(context.worker, {
    idempotencyKey: "worker-write",
    taskId: workerTask.taskId,
    kind: "write_intent",
    surfaces: [{
      domain: "path",
      ref: "src/execution-coordination.ts",
      repositoryRef: "git:devspace-zesnexus",
    }],
  }).value;
  let conflicts = context.manager.conflicts(context.owner);
  assert.ok(conflicts.some((conflict) =>
    conflict.classification === "read_write_visibility"
    && conflict.severity === "informational"
    && !conflict.blocksPublication));

  context.manager.declareIntent(context.owner, {
    idempotencyKey: "owner-write",
    taskId: ownerTask.taskId,
    kind: "write_intent",
    surfaces: [{
      domain: "path",
      ref: "src/execution-coordination-model.ts",
      repositoryRef: "git:devspace-zesnexus",
      semanticKey: "execution-coordination-protocol",
    }],
  });
  context.manager.declareIntent(context.worker, {
    idempotencyKey: "worker-semantic-write",
    taskId: workerTask.taskId,
    kind: "write_intent",
    surfaces: [{
      domain: "api",
      ref: "coordination-task-api",
      repositoryRef: "git:devspace-zesnexus",
      semanticKey: "execution-coordination-protocol",
    }],
  });
  conflicts = context.manager.conflicts(context.owner);
  assert.ok(conflicts.some((conflict) =>
    conflict.classification === "semantic_overlap"
    && conflict.severity === "advisory"
    && conflict.requiredAction === "negotiate"));

  context.manager.declareIntent(context.owner, {
    idempotencyKey: "owner-publication",
    taskId: ownerTask.taskId,
    kind: "publication_intent",
    surfaces: [{
      domain: "publication",
      ref: "owner/main",
      repositoryRef: "git:devspace-zesnexus",
    }],
  });
  context.manager.declareIntent(context.worker, {
    idempotencyKey: "worker-publication",
    taskId: workerTask.taskId,
    kind: "publication_intent",
    surfaces: [{
      domain: "publication",
      ref: "owner/main",
      repositoryRef: "git:devspace-zesnexus",
    }],
  });
  conflicts = context.manager.conflicts(context.owner);
  assert.ok(conflicts.some((conflict) =>
    conflict.classification === "publication_conflict"
    && conflict.severity === "blocking"
    && conflict.requiredAction === "serialize"
    && conflict.blocksPublication));

  const released = context.manager.releaseIntent(context.worker, {
    idempotencyKey: "worker-write-release",
    intentId: workerWrite.intentId,
    expectedRevision: 1,
  }).value;
  assert.equal(released.state, "released");
});

test("work batons transfer coordination ownership but external interaction proof remains mandatory", async (t) => {
  const context = await fixture(t);
  publishPeer(context, context.owner, "peer-owner");
  publishPeer(context, context.worker, "peer-worker");
  const task = openTask(context, context.owner, "task-work-baton", {
    idempotencyKey: "task-work-baton",
    missionRef: "mission:work-baton",
    participantScopeRefs: [context.worker.scopeRef],
    externalAuthorityRefs: ["interaction-broker:session-1"],
    recoveryRef: "recovery:work-baton",
    initialState: "working",
  });
  const offered = context.manager.offerBaton(context.owner, {
    idempotencyKey: "work-baton-offer",
    taskId: task.taskId,
    expectedTaskRevision: 1,
    kind: "work",
    toScopeRef: context.worker.scopeRef,
  }).value;
  const accepted = context.manager.respondBaton(context.worker, {
    idempotencyKey: "work-baton-accept",
    batonId: offered.batonId,
    expectedRevision: 1,
    response: "accepted",
  }).value;
  const consumed = context.manager.consumeBaton(context.worker, {
    idempotencyKey: "work-baton-consume-unverified",
    batonId: offered.batonId,
    expectedRevision: accepted.revision,
  }).value;
  assert.equal(consumed.task.ownerScopeRef, context.worker.scopeRef);
  assert.equal(consumed.task.state, "input_required");
  assert.equal(consumed.task.ownershipLineage.at(-1)?.mode, "baton");
  assert.match(consumed.task.ownershipLineage.at(-1)?.handoffRef ?? "", /coordination-baton/);

  assert.throws(
    () => context.manager.transitionTask(context.worker, {
      idempotencyKey: "work-baton-blind-resume",
      taskId: task.taskId,
      expectedRevision: 2,
      toState: "working",
    }),
    /externally verified authority readback and adoption evidence/i,
  );

  const resumed = context.manager.transitionTask(context.worker, {
    idempotencyKey: "work-baton-verified-resume",
    taskId: task.taskId,
    expectedRevision: 2,
    toState: "working",
    ownershipProof: {
      authorityReadbackRefs: ["interaction-broker:readback:scope-worker"],
      adoptionVerificationRefs: ["interaction-broker:adoption:verified"],
    },
  }).value;
  assert.equal(resumed.state, "working");
  assert.deepEqual(
    resumed.ownershipLineage.at(-1)?.adoptionVerificationRefs,
    ["interaction-broker:adoption:verified"],
  );
});

test("batons freeze task revisions and separate integration from publication ownership", async (t) => {
  const context = await fixture(t);
  publishPeer(context, context.owner, "peer-owner");
  publishPeer(context, context.worker, "peer-worker", ["integrator"]);
  publishPeer(context, context.reviewer, "peer-reviewer", ["publisher"]);
  const task = openTask(context, context.owner, "task-batons");
  const validating = context.manager.transitionTask(context.owner, {
    idempotencyKey: "baton-validating",
    taskId: task.taskId,
    expectedRevision: 1,
    toState: "validating",
  }).value;
  const ready = context.manager.transitionTask(context.owner, {
    idempotencyKey: "baton-ready-integration",
    taskId: task.taskId,
    expectedRevision: validating.revision,
    toState: "ready_for_integration",
    candidate: candidate("batons"),
    validationRefs: ["test:pass"],
    publicationMode: "delegated",
  }).value;
  const integrationOffer = context.manager.offerBaton(context.owner, {
    idempotencyKey: "integration-offer",
    taskId: task.taskId,
    expectedTaskRevision: ready.revision,
    kind: "integration",
    toScopeRef: context.worker.scopeRef,
  }).value;
  const integrationAccept = context.manager.respondBaton(context.worker, {
    idempotencyKey: "integration-accept",
    batonId: integrationOffer.batonId,
    expectedRevision: 1,
    response: "accepted",
  }).value;
  const integrated = context.manager.consumeBaton(context.worker, {
    idempotencyKey: "integration-consume",
    batonId: integrationOffer.batonId,
    expectedRevision: integrationAccept.revision,
  }).value.task;
  assert.equal(integrated.integrationOwnerScopeRef, context.worker.scopeRef);
  assert.equal(integrated.ownerScopeRef, context.owner.scopeRef);
  assert.equal(integrated.state, "integrating");

  const readyPublication = context.manager.transitionTask(context.worker, {
    idempotencyKey: "integration-ready-publication",
    taskId: task.taskId,
    expectedRevision: integrated.revision,
    toState: "ready_for_publication",
  }).value;
  const publicationOffer = context.manager.offerBaton(context.worker, {
    idempotencyKey: "publication-offer",
    taskId: task.taskId,
    expectedTaskRevision: readyPublication.revision,
    kind: "publication",
    toScopeRef: context.reviewer.scopeRef,
  }).value;
  const publicationAccept = context.manager.respondBaton(context.reviewer, {
    idempotencyKey: "publication-accept",
    batonId: publicationOffer.batonId,
    expectedRevision: 1,
    response: "accepted",
  }).value;
  const publicationConsumed = context.manager.consumeBaton(context.reviewer, {
    idempotencyKey: "publication-consume",
    batonId: publicationOffer.batonId,
    expectedRevision: publicationAccept.revision,
  }).value.task;
  assert.equal(publicationConsumed.publisherScopeRef, context.reviewer.scopeRef);
  assert.equal(publicationConsumed.state, "ready_for_publication");

  const freezeTask = openTask(context, context.owner, "task-freeze", {
    idempotencyKey: "task-freeze",
    missionRef: "mission:freeze",
    participantScopeRefs: [context.worker.scopeRef],
    recoveryRef: "recovery:freeze",
    initialState: "working",
  });
  const freezeOffer = context.manager.offerBaton(context.owner, {
    idempotencyKey: "freeze-offer",
    taskId: freezeTask.taskId,
    expectedTaskRevision: 1,
    kind: "work",
    toScopeRef: context.worker.scopeRef,
  }).value;
  context.manager.respondBaton(context.worker, {
    idempotencyKey: "freeze-accept",
    batonId: freezeOffer.batonId,
    expectedRevision: 1,
    response: "accepted",
  });
  context.manager.transitionTask(context.owner, {
    idempotencyKey: "freeze-task-mutated",
    taskId: freezeTask.taskId,
    expectedRevision: 1,
    toState: "validating",
  });
  assert.throws(
    () => context.manager.consumeBaton(context.worker, {
      idempotencyKey: "freeze-consume",
      batonId: freezeOffer.batonId,
      expectedRevision: 2,
    }),
    /task frozen by baton.*revision mismatch/i,
  );
});

test("orphan adoption requires stale peer plus expired lease and remains reconciliation-first", async (t) => {
  const context = await fixture(t, {
    peerDefaultTtlMs: 1_000,
    peerMaxTtlMs: 60_000,
    taskOwnerDefaultLeaseMs: 1_000,
    taskOwnerMaxLeaseMs: 60_000,
    intentDefaultTtlMs: 60_000,
  });
  publishPeer(context, context.owner, "orphan-owner");
  publishPeer(context, context.worker, "orphan-worker", ["recovery"]);
  const externalTask = openTask(context, context.owner, "orphan-external", {
    idempotencyKey: "orphan-external",
    missionRef: "mission:orphan-external",
    participantScopeRefs: [context.worker.scopeRef],
    recoveryRef: "recovery:orphan-external",
    externalAuthorityRefs: ["interaction-broker:orphan-session"],
    adoptionMode: "participants",
    initialState: "working",
    ownerLeaseHours: 0.0003,
  });
  context.manager.declareIntent(context.owner, {
    idempotencyKey: "orphan-effect-intent",
    taskId: externalTask.taskId,
    kind: "effect_intent",
    surfaces: [{
      domain: "effect",
      ref: "interaction:click:submit",
      semanticKey: "submit-effect",
    }],
    expiresInHours: 0.01,
  });

  assert.equal(
    context.manager.orphanAssessments(context.worker)
      .find((entry) => entry.taskId === externalTask.taskId)?.disposition,
    "not_orphaned",
  );
  context.advance(2_000);
  context.manager.publishPeer(context.worker, {
    idempotencyKey: "orphan-worker-renew-1",
    expectedGeneration: 1,
    missionRef: "mission:orphan-worker",
    phase: "working",
    frontier: "Ready to reconcile orphaned coordination work.",
  });
  const assessment = context.manager.orphanAssessments(context.worker)
    .find((entry) => entry.taskId === externalTask.taskId);
  assert.equal(assessment?.disposition, "reconcile_only");
  assert.equal(assessment?.externalAuthorityReconciliationRequired, true);
  assert.ok(assessment?.reasonCodes.includes("ACTIVE_EFFECT_OR_PUBLICATION_INTENT"));

  const adopted = context.manager.adoptTask(context.worker, {
    idempotencyKey: "orphan-adopt-reconcile",
    taskId: externalTask.taskId,
    expectedRevision: 1,
    ownershipProof: {
      authorityReadbackRefs: ["interaction-broker:readback:stale-owner"],
    },
  }).value;
  assert.equal(adopted.ownerScopeRef, context.worker.scopeRef);
  assert.equal(adopted.state, "input_required");
  assert.equal(adopted.ownershipLineage.at(-1)?.mode, "orphan_reconciliation");

  assert.throws(
    () => context.manager.transitionTask(context.worker, {
      idempotencyKey: "orphan-blind-resume",
      taskId: externalTask.taskId,
      expectedRevision: 2,
      toState: "working",
      ownershipProof: {
        handoffRef: "handoff:orphan",
        authorityReadbackRefs: ["interaction-broker:readback:worker"],
        adoptionVerificationRefs: ["interaction-broker:adoption:worker"],
      },
    }),
    /effect-readback evidence/i,
  );
  const reconciled = context.manager.transitionTask(context.worker, {
    idempotencyKey: "orphan-reconciled-resume",
    taskId: externalTask.taskId,
    expectedRevision: 2,
    toState: "working",
    ownershipProof: {
      handoffRef: "handoff:orphan",
      authorityReadbackRefs: ["interaction-broker:readback:worker"],
      adoptionVerificationRefs: ["interaction-broker:adoption:worker"],
      effectReadbackRefs: ["interaction-broker:effect:absent"],
    },
  }).value;
  assert.equal(reconciled.state, "working");

  publishPeer(context, context.reviewer, "orphan-reviewer");
  const simpleTask = openTask(context, context.reviewer, "orphan-simple", {
    idempotencyKey: "orphan-simple",
    missionRef: "mission:orphan-simple",
    participantScopeRefs: [context.worker.scopeRef],
    recoveryRef: "recovery:orphan-simple",
    adoptionMode: "participants",
    initialState: "working",
    ownerLeaseHours: 0.0003,
  });
  context.advance(2_000);
  context.manager.publishPeer(context.worker, {
    idempotencyKey: "orphan-worker-renew-2",
    expectedGeneration: 2,
    missionRef: "mission:orphan-worker",
    phase: "working",
    frontier: "Ready to adopt verified work.",
  });
  const simpleAssessment = context.manager.orphanAssessments(context.worker)
    .find((entry) => entry.taskId === simpleTask.taskId);
  assert.equal(simpleAssessment?.disposition, "adoptable");
  const simpleAdopted = context.manager.adoptTask(context.worker, {
    idempotencyKey: "orphan-simple-adopt",
    taskId: simpleTask.taskId,
    expectedRevision: 1,
    ownershipProof: {
      authorityReadbackRefs: ["git-main:current:readback"],
    },
  }).value;
  assert.equal(simpleAdopted.state, "working");
  assert.equal(simpleAdopted.ownershipLineage.at(-1)?.mode, "orphan_adoption");
});

test("multiple candidates require an integration candidate and blocking publication conflicts hold", async (t) => {
  const context = await fixture(t);
  publishPeer(context, context.owner, "multi-owner", ["publisher"]);
  publishPeer(context, context.worker, "multi-worker", ["publisher"]);
  const first = openTask(context, context.owner, "multi-first");
  const second = openTask(context, context.worker, "multi-second");
  for (const [scope, task, id] of [
    [context.owner, first, "multi-first"] as const,
    [context.worker, second, "multi-second"] as const,
  ]) {
    const validating = context.manager.transitionTask(scope, {
      idempotencyKey: `${id}-validating`,
      taskId: task.taskId,
      expectedRevision: 1,
      toState: "validating",
    }).value;
    context.manager.transitionTask(scope, {
      idempotencyKey: `${id}-ready`,
      taskId: task.taskId,
      expectedRevision: validating.revision,
      toState: "ready_for_publication",
      candidate: candidate(id),
      validationRefs: [`test:${id}:pass`],
      publicationMode: "any_eligible",
      eligiblePublisherCapabilities: ["publisher"],
    });
  }
  const integration = context.manager.publicationPlan(context.owner, {
    taskIds: [first.taskId, second.taskId],
    currentRepositoryRef: "git:devspace-zesnexus",
    currentMainSha: "main-001",
    publicationLeaseRef: "lease:multi",
  });
  assert.equal(integration.decision, "INTEGRATE");
  assert.equal(integration.requiresIntegrationCandidate, true);
  assert.ok(integration.reasonCodes.includes("MULTIPLE_CANDIDATES_REQUIRE_INTEGRATION"));

  context.manager.declareIntent(context.owner, {
    idempotencyKey: "multi-owner-publication",
    taskId: first.taskId,
    kind: "publication_intent",
    surfaces: [{
      domain: "publication",
      ref: "owner/main",
      repositoryRef: "git:devspace-zesnexus",
    }],
  });
  context.manager.declareIntent(context.worker, {
    idempotencyKey: "multi-worker-publication",
    taskId: second.taskId,
    kind: "publication_intent",
    surfaces: [{
      domain: "publication",
      ref: "owner/main",
      repositoryRef: "git:devspace-zesnexus",
    }],
  });
  const held = context.manager.publicationPlan(context.owner, {
    taskIds: [first.taskId],
    currentRepositoryRef: "git:devspace-zesnexus",
    currentMainSha: "main-001",
    publicationLeaseRef: "lease:multi",
  });
  assert.equal(held.decision, "HOLD");
  assert.ok(held.blockingConflictIds.length > 0);
});

test("persistence survives restart and command idempotency prevents duplicate work", async (t) => {
  const context = await fixture(t);
  const peer = publishPeer(context, context.owner, "restart-peer", ["publisher"]);
  const opened = context.manager.openTask(context.owner, {
    idempotencyKey: "restart-task",
    missionRef: "mission:restart",
    recoveryRef: "recovery:restart",
    initialState: "working",
  });
  const task = opened.value;
  context.manager.close();

  const restarted = context.restart();
  assert.equal(restarted.task(context.owner, task.taskId).missionRef, "mission:restart");
  assert.equal(
    restarted.peers(context.owner).find((entry) => entry.scopeRef === peer.scopeRef)?.generation,
    1,
  );
  const replay = restarted.openTask(context.owner, {
    idempotencyKey: "restart-task",
    missionRef: "mission:restart",
    recoveryRef: "recovery:restart",
    initialState: "working",
  });
  assert.equal(replay.idempotentReplay, true);
  assert.equal(replay.value.taskId, task.taskId);
  assert.throws(
    () => restarted.openTask(context.owner, {
      idempotencyKey: "restart-task",
      missionRef: "mission:different",
      recoveryRef: "recovery:restart",
      initialState: "working",
    }),
    /different coordination command/i,
  );
});

test("coordination fails closed when disabled or persistence is not installed", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-coordination-missing-schema-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.throws(
    () => new ExecutionCoordinationManager(
      DEFAULT_EXECUTION_COORDINATION_CONFIG,
      join(root, "missing"),
    ),
    /persistence is not installed/i,
  );

  const context = await fixture(t, { enabled: false });
  assert.throws(
    () => context.manager.status(context.owner),
    /coordination is disabled/i,
  );
});
