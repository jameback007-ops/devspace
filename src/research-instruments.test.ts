import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  ResearchCycleError,
  type ResearchInstrumentCycleContext,
  type ResearchWorkspace,
  ZesResearchCycleManager,
} from "./research-cycle.js";
import {
  ZesResearchInstrumentManager,
} from "./research-instruments.js";

const NOW = new Date("2026-08-19T01:00:00.000Z");

interface InstrumentFixture {
  root: string;
  evidenceDirectory: string;
  workspace: ResearchWorkspace;
  manager: ZesResearchInstrumentManager;
  setGeneration: (generation: number) => void;
  setWorkingDigest: (digest: string) => void;
}

interface PublicPlan {
  planRef: string;
  status: string;
  generation: number;
  steps: Array<{
    stepRef: string;
    evidenceNeedKind: string;
    instrumentKind: string;
    blocked: boolean;
    blockingFactors: string[];
  }>;
}

function resultPlan(value: Record<string, unknown>): PublicPlan {
  return value.plan as PublicPlan;
}

async function fixture(t: TestContext): Promise<InstrumentFixture> {
  const root = await mkdtemp(join(tmpdir(), "devspace-research-instruments-"));
  const evidenceDirectory = join(root, ".cycle-evidence");
  await mkdir(evidenceDirectory, { recursive: true });
  let generation = 1;
  let workingContentDigestSha256 = "a".repeat(64);
  const workspace = {
    workspaceId: "ws_research_instruments_fixture",
    root,
  };
  const cycleManager = {
    instrumentContext: async (): Promise<ResearchInstrumentCycleContext> => ({
      cycleRef: "zes-research-cycle:instrument-fixture",
      generation,
      phase: "prepared",
      evidenceDirectory,
      ownerSeededFraming: false,
      taskRef: "task:research-instruments",
      materialDecisionRef: "decision:research-instruments",
      decisionBoundaryRef: "devspace.research.instrumentation",
      workspaceSnapshot: {
        head: "b".repeat(40),
        sourceTree: "c".repeat(40),
        branch: "agent/research-instruments-test",
        repositoryIdentityDigestSha256: "d".repeat(64),
        workingContentDigestSha256,
        dirty: false,
      },
    }),
  } as unknown as ZesResearchCycleManager;
  const manager = new ZesResearchInstrumentManager(cycleManager, {
    now: () => new Date(NOW),
  });
  t.after(() => rm(root, { recursive: true, force: true }));
  return {
    root,
    evidenceDirectory,
    workspace,
    manager,
    setGeneration: (value) => {
      generation = value;
    },
    setWorkingDigest: (value) => {
      workingContentDigestSha256 = value;
    },
  };
}

test("instrument planner derives falsification without forcing an adapter dependency", async (t) => {
  const current = await fixture(t);
  const planned = await current.manager.plan(current.workspace, {
    idempotencyKey: "instrument-plan:protocol-invariant:v1",
    claimClass: "protocol_invariant",
    claimRefs: ["claim:duplicate-effect-at-most-once"],
    question: "Can retry, crash, and delayed acknowledgement violate at-most-once effects?",
    hypothesis: "The coordination protocol never produces two terminal effects.",
    falsifier: "Any generated state sequence produces more than one terminal effect.",
    executionConstraints: {
      executionBoundary: "local_only",
      modelUse: "forbidden",
    },
  });
  const plan = resultPlan(planned);
  assert.equal(plan.status, "planned");
  assert.equal(plan.steps.length, 1);
  assert.equal(plan.steps[0]?.evidenceNeedKind, "state_space_falsification");
  assert.equal(plan.steps[0]?.instrumentKind, "property_falsification");
  assert.equal(plan.steps[0]?.blocked, false);
  assert.deepEqual(plan.steps[0]?.blockingFactors, []);
  assert.equal(
    (planned.policy as Record<string, unknown>).executesExternalInstrument,
    false,
  );
});
test("agent behavioral evidence is held when model and sandbox execution are forbidden", async (t) => {
  const current = await fixture(t);
  const planned = await current.manager.plan(current.workspace, {
    idempotencyKey: "instrument-plan:agent-behavior:held:v1",
    claimClass: "agent_behavior_or_utility",
    claimRefs: ["claim:memory-improves-tool-use"],
    question: "Does admitted memory improve representative tool-use behavior?",
    hypothesis: "Memory treatment improves success without negative transfer.",
    falsifier: "Treatment fails to outperform control or increases negative transfer.",
    executionConstraints: {
      executionBoundary: "local_only",
      modelUse: "forbidden",
    },
  });
  const plan = resultPlan(planned);
  assert.equal(plan.status, "partially_blocked");
  const agent = plan.steps.find((step) =>
    step.instrumentKind === "agent_behavior_eval"
  );
  assert.equal(agent?.blocked, true);
  assert.deepEqual(agent?.blockingFactors, [
    "isolated_or_live_execution_boundary_required",
    "model_execution_forbidden",
  ]);
  const trace = plan.steps.find((step) =>
    step.instrumentKind === "trace_analysis"
  );
  assert.equal(trace?.blocked, false);
});
test("property receipt binds exact artifact bytes and detects later mutation", async (t) => {
  const current = await fixture(t);
  const planned = await current.manager.plan(current.workspace, {
    idempotencyKey: "instrument-plan:property-receipt:v1",
    claimClass: "protocol_invariant",
    claimRefs: ["claim:scope-isolation"],
    question: "Can generated identities cross an authorization boundary?",
    hypothesis: "No generated sequence leaks a foreign scope.",
    falsifier: "A minimized generated sequence returns foreign-scope data.",
    executionConstraints: {
      executionBoundary: "local_only",
      modelUse: "forbidden",
    },
  });
  const plan = resultPlan(planned);
  const step = plan.steps[0];
  assert.ok(step);
  await writeFile(
    join(current.root, "property-result.json"),
    `${JSON.stringify({ examples: 2_000, counterexample: null })}\n`,
    "utf8",
  );
  const input = {
    idempotencyKey: "instrument-receipt:property:v1",
    planRef: plan.planRef,
    stepRef: step.stepRef,
    outcome: "passed" as const,
    startedAt: "2026-08-19T00:55:00.000Z",
    completedAt: "2026-08-19T00:56:00.000Z",
    toolName: "Hypothesis",
    toolVersion: "6.x",
    environmentRefs: ["python:3.12", "seed-set:fixed-v1"],
    artifacts: [{
      location: "workspace" as const,
      path: "property-result.json",
      role: "result" as const,
      mediaType: "application/json",
    }],
    result: {
      kind: "property_falsification" as const,
      invariantRefs: ["invariant:no-foreign-scope"],
      generatedCaseCount: 2_000,
      stateTransitionCount: 18_000,
      counterexampleFound: false,
      seedRefs: ["seed-set:fixed-v1"],
    },
    limitations: ["bounded generated state space"],
    unresolved: [],
  };
  const recorded = await current.manager.record(current.workspace, input);
  assert.equal(recorded.status, "recorded");
  assert.equal(recorded.idempotentReplay, false);
  const evidenceRef = (
    recorded.receipt as { evidenceRef: string }
  ).evidenceRef;
  const verified = await current.manager.verifyEvidenceRefs(
    current.workspace,
    [evidenceRef],
  );
  assert.equal(verified.status, "verified_current_generation");
  const replay = await current.manager.record(current.workspace, input);
  assert.equal(replay.idempotentReplay, true);

  await writeFile(
    join(current.root, "property-result.json"),
    `${JSON.stringify({ examples: 2_001, counterexample: null })}\n`,
    "utf8",
  );
  await assert.rejects(
    () => current.manager.record(current.workspace, input),
    (error: unknown) => error instanceof ResearchCycleError
      && error.code === "RESEARCH_INSTRUMENT_ARTIFACT_CHANGED",
  );
  await assert.rejects(
    () => current.manager.verifyEvidenceRefs(
      current.workspace,
      [evidenceRef],
    ),
    (error: unknown) => error instanceof ResearchCycleError
      && error.code === "RESEARCH_INSTRUMENT_ARTIFACT_CHANGED",
  );
  const status = await current.manager.status(current.workspace);
  const integrity = status.receiptIntegrity as Array<Record<string, unknown>>;
  assert.equal(integrity[0]?.status, "changed_or_missing");
});

test("a found property counterexample requires minimized counterexample evidence", async (t) => {
  const current = await fixture(t);
  const planned = await current.manager.plan(current.workspace, {
    idempotencyKey: "instrument-plan:counterexample:v1",
    claimClass: "protocol_invariant",
    claimRefs: ["claim:no-duplicate-effect"],
    question: "Can duplicate delivery create duplicate effects?",
    hypothesis: "At-most-once effect identity survives all generated retries.",
    falsifier: "A generated retry sequence creates two effects.",
    executionConstraints: {
      executionBoundary: "local_only",
      modelUse: "forbidden",
    },
  });
  const plan = resultPlan(planned);
  const step = plan.steps[0];
  assert.ok(step);
  await writeFile(join(current.root, "property-failure.json"), "{}\n", "utf8");
  const base = {
    idempotencyKey: "instrument-receipt:counterexample:v1",
    planRef: plan.planRef,
    stepRef: step.stepRef,
    outcome: "failed" as const,
    startedAt: "2026-08-19T00:40:00.000Z",
    completedAt: "2026-08-19T00:41:00.000Z",
    toolName: "Hypothesis",
    environmentRefs: ["python:3.12"],
    result: {
      kind: "property_falsification" as const,
      invariantRefs: ["invariant:at-most-once-effect"],
      generatedCaseCount: 73,
      stateTransitionCount: 411,
      counterexampleFound: true,
      minimalCounterexampleRef: "counterexample:duplicate-after-crash",
      seedRefs: ["seed:counterexample-73"],
    },
    limitations: [],
    unresolved: ["repair protocol before admission"],
  };
  await assert.rejects(
    () => current.manager.record(current.workspace, {
      ...base,
      artifacts: [{
        location: "workspace",
        path: "property-failure.json",
        role: "result",
        mediaType: "application/json",
      }],
    }),
    (error: unknown) => error instanceof ResearchCycleError
      && error.code === "RESEARCH_INSTRUMENT_COUNTEREXAMPLE_ARTIFACT_MISSING",
  );
  await writeFile(
    join(current.root, "minimal-counterexample.json"),
    "{\"sequence\":[\"send\",\"crash\",\"retry\"]}\n",
    "utf8",
  );
  const recorded = await current.manager.record(current.workspace, {
    ...base,
    artifacts: [
      {
        location: "workspace",
        path: "property-failure.json",
        role: "result",
        mediaType: "application/json",
      },
      {
        location: "workspace",
        path: "minimal-counterexample.json",
        role: "counterexample",
        mediaType: "application/json",
      },
    ],
  });
  assert.equal(recorded.status, "recorded");
});

test("agent evaluation refuses collapsed treatment and control identities", async (t) => {
  const current = await fixture(t);
  const planned = await current.manager.plan(current.workspace, {
    idempotencyKey: "instrument-plan:agent-treatment-control:v1",
    claimClass: "agent_behavior_or_utility",
    claimRefs: ["claim:research-first-improves-design"],
    question: "Does research-first behavior improve architecture outcomes?",
    hypothesis: "Research-first treatment reduces duplicated upstream mechanisms.",
    falsifier: "Treatment does not improve the preregistered outcome scorers.",
    executionConstraints: {
      executionBoundary: "isolated_sandbox",
      modelUse: "required",
    },
  });
  const plan = resultPlan(planned);
  const step = plan.steps.find((candidate) =>
    candidate.instrumentKind === "agent_behavior_eval"
  );
  assert.ok(step);
  await writeFile(join(current.root, "agent-trace.jsonl"), "{}\n", "utf8");
  await writeFile(join(current.root, "agent-result.json"), "{}\n", "utf8");
  await assert.rejects(
    () => current.manager.record(current.workspace, {
      idempotencyKey: "instrument-receipt:agent-collapsed:v1",
      planRef: plan.planRef,
      stepRef: step.stepRef,
      outcome: "inconclusive",
      startedAt: "2026-08-19T00:20:00.000Z",
      completedAt: "2026-08-19T00:30:00.000Z",
      toolName: "Inspect AI",
      environmentRefs: ["sandbox:docker", "dataset:aoq-architecture-v1"],
      artifacts: [
        {
          location: "workspace",
          path: "agent-trace.jsonl",
          role: "trace",
          mediaType: "application/x-ndjson",
        },
        {
          location: "workspace",
          path: "agent-result.json",
          role: "result",
          mediaType: "application/json",
        },
      ],
      result: {
        kind: "agent_behavior_eval",
        agentTargetRefs: ["agent:solpro-test-subject"],
        modelRefs: ["model:test-exact-snapshot"],
        datasetRef: "dataset:aoq-architecture-v1",
        treatmentRef: "condition:research-first",
        controlRef: "condition:research-first",
        scorerRefs: ["scorer:upstream-duplication"],
        traceRefs: ["trace:agent-eval-01"],
        sampleCount: 20,
        replicateCount: 3,
        seedRefs: ["seed-set:aoq-agent-eval-v1"],
      },
      limitations: ["single model snapshot"],
      unresolved: [],
    }),
    (error: unknown) => error instanceof ResearchCycleError
      && error.code === "RESEARCH_INSTRUMENT_TREATMENT_CONTROL_COLLAPSED",
  );
});

test("a research generation change makes an earlier instrument plan stale", async (t) => {
  const current = await fixture(t);
  const planned = await current.manager.plan(current.workspace, {
    idempotencyKey: "instrument-plan:stale-generation:v1",
    claimClass: "protocol_invariant",
    claimRefs: ["claim:generation-bound"],
    question: "Does this plan remain valid after research reassessment?",
    hypothesis: "A prior-generation plan cannot authorize new evidence binding.",
    falsifier: "The old plan accepts a receipt after generation changes.",
    executionConstraints: {
      executionBoundary: "local_only",
      modelUse: "forbidden",
    },
  });
  const plan = resultPlan(planned);
  const step = plan.steps[0];
  assert.ok(step);
  await writeFile(join(current.root, "stale-result.json"), "{}\n", "utf8");
  current.setGeneration(2);
  current.setWorkingDigest("e".repeat(64));
  await assert.rejects(
    () => current.manager.record(current.workspace, {
      idempotencyKey: "instrument-receipt:stale-generation:v1",
      planRef: plan.planRef,
      stepRef: step.stepRef,
      outcome: "passed",
      startedAt: "2026-08-19T00:10:00.000Z",
      completedAt: "2026-08-19T00:11:00.000Z",
      toolName: "Hypothesis",
      environmentRefs: [],
      artifacts: [{
        location: "workspace",
        path: "stale-result.json",
        role: "result",
        mediaType: "application/json",
      }],
      result: {
        kind: "property_falsification",
        invariantRefs: ["invariant:generation-bound"],
        generatedCaseCount: 10,
        stateTransitionCount: 10,
        counterexampleFound: false,
        seedRefs: ["seed:stale-generation"],
      },
      limitations: [],
      unresolved: [],
    }),
    (error: unknown) => error instanceof ResearchCycleError
      && error.code === "RESEARCH_INSTRUMENT_PLAN_STALE",
  );
});

test("instrument metadata rejects credential material before persistence", async (t) => {
  const current = await fixture(t);
  await assert.rejects(
    () => current.manager.plan(current.workspace, {
      idempotencyKey: "instrument-plan:credential-rejected:v1",
      claimClass: "local_mechanical",
      claimRefs: ["claim:credential-boundary"],
      question: "Confirm access_token=super-secret-value in an experiment plan.",
      hypothesis: "Credential material must never enter instrument state.",
      falsifier: "Persisted state contains the supplied credential value.",
      executionConstraints: {
        executionBoundary: "local_only",
        modelUse: "forbidden",
      },
    }),
    (error: unknown) => error instanceof ResearchCycleError
      && error.code === "RESEARCH_INSTRUMENT_CREDENTIAL_MATERIAL_REJECTED",
  );
});
