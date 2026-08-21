import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { ZesResearchInstrumentExecutionConfig } from "./config.js";
import {
  ResearchCycleError,
  type ResearchInstrumentCycleContext,
  type ResearchWorkspace,
  ZesResearchCycleManager,
} from "./research-cycle.js";
import {
  ZesResearchInstrumentExecutor,
} from "./research-instrument-executor.js";
import {
  ZesResearchInstrumentManager,
} from "./research-instruments.js";

const NOW = new Date("2026-08-21T10:00:00.000Z");

interface Fixture {
  root: string;
  labRoot: string;
  evidenceDirectory: string;
  workspace: ResearchWorkspace;
  cycleManager: ZesResearchCycleManager;
  instrumentManager: ZesResearchInstrumentManager;
  config: ZesResearchInstrumentExecutionConfig;
  planAgentBehavior: () => Promise<{
    planRef: string;
    agentStepRef: string;
    traceStepRef: string;
  }>;
}

async function fixture(t: TestContext): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "devspace-instrument-executor-"));
  const evidenceDirectory = join(root, ".cycle-evidence");
  const labRoot = join(root, "research-lab");
  await mkdir(join(labRoot, ".venv", "bin"), { recursive: true });
  await mkdir(join(labRoot, "runners"), { recursive: true });
  await mkdir(join(labRoot, "artifacts", "inspect-9router"), {
    recursive: true,
  });
  await writeFile(join(labRoot, ".venv", "bin", "python"), "fixture\n");
  await writeFile(
    join(labRoot, "runners", "inspect_9router.py"),
    "# fixture\n",
  );
  await mkdir(evidenceDirectory, { recursive: true });
  const workspace = {
    workspaceId: "ws_research_instrument_executor_fixture",
    root,
  };
  const cycleManager = {
    instrumentContext: async (): Promise<ResearchInstrumentCycleContext> => ({
      cycleRef: "zes-research-cycle:instrument-executor-fixture",
      generation: 1,
      phase: "prepared",
      evidenceDirectory,
      ownerSeededFraming: true,
      taskRef: "task:instrument-executor",
      materialDecisionRef: "decision:instrument-executor",
      decisionBoundaryRef: "devspace.research.instrument-executor",
      workspaceSnapshot: {
        head: "a".repeat(40),
        sourceTree: "b".repeat(40),
        branch: "agent/instrument-executor-test",
        repositoryIdentityDigestSha256: "c".repeat(64),
        workingContentDigestSha256: "d".repeat(64),
        dirty: false,
      },
    }),
  } as unknown as ZesResearchCycleManager;
  const instrumentManager = new ZesResearchInstrumentManager(cycleManager, {
    now: () => new Date(NOW),
  });
  const config = {
    enabled: true,
    labRoot,
    maxConcurrent: 1,
  } satisfies ZesResearchInstrumentExecutionConfig;
  t.after(() => rm(root, { recursive: true, force: true }));
  return {
    root,
    labRoot,
    evidenceDirectory,
    workspace,
    cycleManager,
    instrumentManager,
    config,
    planAgentBehavior: async () => {
      const planned = await instrumentManager.plan(workspace, {
        idempotencyKey: "instrument-plan:executor-agent:v1",
        claimClass: "agent_behavior_or_utility",
        claimRefs: ["claim:lab-executor-improves-evidence"],
        question: "Does the bounded candidate improve representative behavior?",
        hypothesis: "Treatment improves preregistered behavior scores.",
        falsifier: "Treatment does not outperform control.",
        executionConstraints: {
          executionBoundary: "isolated_sandbox",
          modelUse: "required",
        },
      });
      const plan = planned.plan as {
        planRef: string;
        steps: Array<{ stepRef: string; instrumentKind: string }>;
      };
      const agent = plan.steps.find((step) =>
        step.instrumentKind === "agent_behavior_eval"
      );
      const trace = plan.steps.find((step) =>
        step.instrumentKind === "trace_analysis"
      );
      assert.ok(agent);
      assert.ok(trace);
      return {
        planRef: plan.planRef,
        agentStepRef: agent.stepRef,
        traceStepRef: trace.stepRef,
      };
    },
  };
}

function executeInput(planRef: string, stepRef: string, key = "run:agent:v1") {
  return {
    idempotencyKey: key,
    planRef,
    stepRef,
    adapter: "inspect_ai" as const,
    task: "experiments/agent_eval.py@agent_eval",
    profile: "routine",
    limit: 1,
  };
}

function sharedLabStatus() {
  const profiles = {
    transport_canary: {
      budget_class: "routine",
      explicit_only: false,
    },
    routine: {
      budget_class: "routine",
      explicit_only: false,
    },
    adjudication: {
      budget_class: "adjudication",
      explicit_only: false,
    },
    hard_adjudication: {
      budget_class: "adjudication",
      explicit_only: true,
    },
    exceptional_adjudication: {
      budget_class: "adjudication",
      explicit_only: true,
    },
    frontier_calibration: {
      budget_class: "frontier",
      explicit_only: true,
    },
  };
  return {
    ready: true,
    status: "ready_for_bounded_profiled_eval",
    profile_availability: Object.fromEntries(
      Object.keys(profiles).map((name) => [name, true]),
    ),
    shared_evaluator_policy: {
      digest_sha256: "e".repeat(64),
      default_eval_profile: "routine",
      automatic_profile_escalation: false,
      automatic_protocol_fallback: false,
      budgets: {
        adjudication_fraction_ceiling: 0.10,
        frontier_fraction_ceiling: 0.02,
        frontier_auto_escalation: false,
        frontier_minimum_non_frontier_samples: 50,
        frontier_requires_adjudication_basis: true,
      },
      profiles,
    },
  };
}

test("Inspect execution becomes terminal evidence and never redispatches the same identity", async (t) => {
  const current = await fixture(t);
  const plan = await current.planAgentBehavior();
  let launches = 0;
  const tracePath = join(
    current.labRoot,
    "artifacts",
    "inspect-9router",
    "eval",
    "routine",
    "trace.json",
  );
  await mkdir(join(tracePath, ".."), { recursive: true });
  const executor = new ZesResearchInstrumentExecutor(
    current.cycleManager,
    current.instrumentManager,
    current.config,
    {
      now: () => new Date(NOW),
      runtimeRef: "runtime:test:one",
      processAlive: () => false,
      readLabStatus: async () => sharedLabStatus(),
      launchProcess: async (launch) => {
        launches += 1;
        await writeFile(tracePath, "{\"trace\":\"exact\"}\n");
        await writeFile(launch.stderrPath, "");
        await writeFile(
          launch.stdoutPath,
          `${JSON.stringify({
            schema_version: "zes.inspect-9router-run.v2",
            status: "completed",
            returncode: 0,
            route_model: "cx/gpt-5.6-luna",
            evaluator_profile: {
              base_profile_name: "routine",
              effective: {
                model: "cx/gpt-5.6-luna",
                reasoning_effort: "max",
                protocol: "chat_completions",
              },
            },
            shared_evaluator_policy: {
              digest_sha256: "e".repeat(64),
            },
            remote_inference_attempted: true,
            logs: [{ status: "success", location: tracePath }],
          })}\n`,
        );
        return { pid: 4_242 };
      },
    },
  );

  const started = await executor.execute(
    current.workspace,
    executeInput(plan.planRef, plan.agentStepRef),
  );
  assert.equal(started.status, "running");
  const status = await executor.status(current.workspace);
  assert.deepEqual(status.counts, {
    dispatching: 0,
    running: 0,
    succeeded: 1,
    failed: 0,
    indeterminate: 0,
  });
  const execution = (status.executions as Array<Record<string, unknown>>)[0];
  assert.equal(execution?.status, "succeeded");
  assert.equal(execution?.sharedPolicyDigestSha256, "e".repeat(64));
  const artifacts = execution?.suggestedRecordArtifacts as Array<{
    location: "cycle_evidence";
    path: string;
    role: "trace" | "log" | "result" | "receipt";
    mediaType: string;
  }>;
  assert.ok(artifacts.some((artifact) => artifact.role === "trace"));
  assert.ok(artifacts.some((artifact) => artifact.role === "result"));
  assert.ok(artifacts.some((artifact) => artifact.role === "receipt"));
  for (const artifact of artifacts) {
    assert.ok((await readFile(
      join(current.evidenceDirectory, artifact.path),
    )).length > 0);
  }

  const recorded = await current.instrumentManager.record(current.workspace, {
    idempotencyKey: "instrument-receipt:executor-agent:v1",
    planRef: plan.planRef,
    stepRef: plan.agentStepRef,
    outcome: "passed",
    startedAt: "2026-08-21T09:58:00.000Z",
    completedAt: "2026-08-21T10:00:00.000Z",
    toolName: "Inspect AI",
    toolVersion: "0.3.259",
    adapterRef: "adapter:shared-lab-inspect:v1",
    environmentRefs: [
      "model:cx/gpt-5.6-luna",
      "reasoning:max",
      "protocol:chat_completions",
    ],
    artifacts,
    result: {
      kind: "agent_behavior_eval",
      agentTargetRefs: ["agent:candidate"],
      modelRefs: ["model:cx/gpt-5.6-luna"],
      datasetRef: "dataset:representative-v1",
      treatmentRef: "condition:treatment",
      controlRef: "condition:control",
      scorerRefs: ["scorer:exact-success"],
      traceRefs: ["trace:inspect-executor-v1"],
      sampleCount: 1,
      replicateCount: 1,
      seedRefs: ["seed:inspect-executor-v1"],
    },
    limitations: ["single bounded fixture"],
    unresolved: [],
  });
  assert.equal(recorded.status, "recorded");

  const replay = await executor.execute(
    current.workspace,
    executeInput(plan.planRef, plan.agentStepRef),
  );
  assert.equal(replay.status, "succeeded");
  assert.equal(replay.idempotentReplay, true);
  assert.equal(launches, 1);
});

test("an unknown runner outcome blocks every new dispatch for the exact plan step", async (t) => {
  const current = await fixture(t);
  const plan = await current.planAgentBehavior();
  let launches = 0;
  const executor = new ZesResearchInstrumentExecutor(
    current.cycleManager,
    current.instrumentManager,
    current.config,
    {
      now: () => new Date(NOW),
      runtimeRef: "runtime:test:unknown",
      processAlive: () => false,
      readLabStatus: async () => sharedLabStatus(),
      launchProcess: async () => {
        launches += 1;
        return { pid: 5_151 };
      },
    },
  );
  await executor.execute(
    current.workspace,
    executeInput(plan.planRef, plan.agentStepRef, "run:unknown:v1"),
  );
  const status = await executor.status(current.workspace);
  assert.equal(
    (status.executions as Array<{ status: string }>)[0]?.status,
    "indeterminate",
  );
  const replay = await executor.execute(
    current.workspace,
    executeInput(plan.planRef, plan.agentStepRef, "run:unknown:v1"),
  );
  assert.equal(replay.status, "indeterminate");
  assert.equal(replay.idempotentReplay, true);
  await assert.rejects(
    () => executor.execute(
      current.workspace,
      executeInput(plan.planRef, plan.agentStepRef, "run:unknown:v2"),
    ),
    (error: unknown) => error instanceof ResearchCycleError
      && error.code === "RESEARCH_INSTRUMENT_EXECUTION_RECONCILIATION_REQUIRED",
  );
  assert.equal(launches, 1);
});

test("a terminal runner receipt with a different shared policy digest fails closed", async (t) => {
  const current = await fixture(t);
  const plan = await current.planAgentBehavior();
  const executor = new ZesResearchInstrumentExecutor(
    current.cycleManager,
    current.instrumentManager,
    current.config,
    {
      now: () => new Date(NOW),
      runtimeRef: "runtime:test:policy-mismatch",
      processAlive: () => false,
      readLabStatus: async () => sharedLabStatus(),
      launchProcess: async (launch) => {
        await writeFile(launch.stderrPath, "");
        await writeFile(
          launch.stdoutPath,
          `${JSON.stringify({
            schema_version: "zes.inspect-9router-run.v2",
            status: "completed",
            returncode: 0,
            evaluator_profile: {
              base_profile_name: "routine",
              effective: { profile: "routine" },
            },
            shared_evaluator_policy: {
              digest_sha256: "f".repeat(64),
            },
            remote_inference_attempted: true,
            logs: [],
          })}\n`,
        );
        return { pid: 5_252 };
      },
    },
  );

  await executor.execute(
    current.workspace,
    executeInput(plan.planRef, plan.agentStepRef, "run:policy-mismatch:v1"),
  );
  const status = await executor.status(current.workspace);
  const execution = (status.executions as Array<{
    status: string;
    terminalReason: string;
    sharedPolicyDigestSha256: string;
    runnerPolicyDigestSha256: string;
  }>)[0];
  assert.equal(execution?.status, "failed");
  assert.equal(execution?.terminalReason, "runner_policy_identity_mismatch");
  assert.equal(execution?.sharedPolicyDigestSha256, "e".repeat(64));
  assert.equal(execution?.runnerPolicyDigestSha256, "f".repeat(64));
});

test("the fixed executor rejects an unplanned non-model trace step", async (t) => {
  const current = await fixture(t);
  const plan = await current.planAgentBehavior();
  let launches = 0;
  const executor = new ZesResearchInstrumentExecutor(
    current.cycleManager,
    current.instrumentManager,
    current.config,
    {
      readLabStatus: async () => sharedLabStatus(),
      launchProcess: async () => {
        launches += 1;
        return { pid: 6_161 };
      },
    },
  );
  await assert.rejects(
    () => executor.execute(
      current.workspace,
      executeInput(plan.planRef, plan.traceStepRef, "run:trace:v1"),
    ),
    (error: unknown) => error instanceof ResearchCycleError
      && error.code === "RESEARCH_INSTRUMENT_EXECUTION_KIND_UNSUPPORTED",
  );
  assert.equal(launches, 0);
});

test("shared Lab policy digest governs adjudication and frontier sample budgets", async (t) => {
  const current = await fixture(t);
  const plan = await current.planAgentBehavior();
  let launches = 0;
  const executor = new ZesResearchInstrumentExecutor(
    current.cycleManager,
    current.instrumentManager,
    current.config,
    {
      now: () => new Date(NOW),
      runtimeRef: "runtime:test:budgets",
      processAlive: () => false,
      readLabStatus: async () => sharedLabStatus(),
      launchProcess: async (launch) => {
        launches += 1;
        const profileIndex = launch.args.indexOf("--profile");
        const profile = profileIndex >= 0
          ? launch.args[profileIndex + 1]
          : "routine";
        assert.ok(profile);
        const tracePath = join(
          current.labRoot,
          "artifacts",
          "inspect-9router",
          `budget-trace-${launches}.json`,
        );
        await writeFile(tracePath, `${JSON.stringify({ profile })}\n`);
        await writeFile(launch.stderrPath, "");
        await writeFile(
          launch.stdoutPath,
          `${JSON.stringify({
            schema_version: "zes.inspect-9router-run.v2",
            status: "completed",
            returncode: 0,
            evaluator_profile: {
              base_profile_name: profile,
              effective: { profile },
            },
            shared_evaluator_policy: {
              digest_sha256: "e".repeat(64),
            },
            remote_inference_attempted: true,
            logs: [{ status: "success", location: tracePath }],
          })}\n`,
        );
        return { pid: 7_000 + launches };
      },
    },
  );

  let status: Record<string, unknown> = {};
  const routineRefs: string[] = [];
  for (let index = 1; index <= 4; index += 1) {
    await executor.execute(current.workspace, {
      ...executeInput(
        plan.planRef,
        plan.agentStepRef,
        `run:budget:routine:${index}`,
      ),
      limit: 16,
    });
    status = await executor.status(current.workspace);
    const latestRoutine = (status.executions as Array<{
      executionRef: string;
      requestedProfile: string;
    }>).filter((execution) => execution.requestedProfile === "routine").at(-1);
    assert.ok(latestRoutine);
    routineRefs.push(latestRoutine.executionRef);
  }

  await executor.execute(current.workspace, {
    ...executeInput(plan.planRef, plan.agentStepRef, "run:budget:adjudication:1"),
    profile: "adjudication",
    limit: 6,
    basisExecutionRefs: [routineRefs[0]!],
  });
  status = await executor.status(current.workspace);
  const adjudication = (status.executions as Array<{
    executionRef: string;
    requestedProfile: string;
  }>).find((execution) => execution.requestedProfile === "adjudication");
  assert.ok(adjudication);
  await assert.rejects(
    () => executor.execute(current.workspace, {
      ...executeInput(plan.planRef, plan.agentStepRef, "run:budget:adjudication:2"),
      profile: "adjudication",
      limit: 1,
      basisExecutionRefs: [routineRefs[0]!],
    }),
    (error: unknown) => error instanceof ResearchCycleError
      && error.code === "RESEARCH_INSTRUMENT_EXECUTION_ADJUDICATION_BUDGET_HELD",
  );

  await assert.rejects(
    () => executor.execute(current.workspace, {
      ...executeInput(plan.planRef, plan.agentStepRef, "run:budget:frontier:no-ack"),
      profile: "frontier_calibration",
      limit: 1,
      basisExecutionRefs: [adjudication.executionRef],
    }),
    (error: unknown) => error instanceof ResearchCycleError
      && error.code
        === "RESEARCH_INSTRUMENT_EXECUTION_RESTRICTED_PROFILE_ACK_REQUIRED",
  );
  await executor.execute(current.workspace, {
    ...executeInput(plan.planRef, plan.agentStepRef, "run:budget:frontier:1"),
    profile: "frontier_calibration",
    limit: 1,
    allowRestrictedProfile: true,
    basisExecutionRefs: [adjudication.executionRef],
  });
  await executor.status(current.workspace);
  await assert.rejects(
    () => executor.execute(current.workspace, {
      ...executeInput(plan.planRef, plan.agentStepRef, "run:budget:frontier:2"),
      profile: "frontier_calibration",
      limit: 1,
      allowRestrictedProfile: true,
      basisExecutionRefs: [adjudication.executionRef],
    }),
    (error: unknown) => error instanceof ResearchCycleError
      && error.code === "RESEARCH_INSTRUMENT_EXECUTION_FRONTIER_BUDGET_HELD",
  );
  assert.equal(launches, 6);
});

test("disabled execution remains unavailable without affecting instrument planning", async (t) => {
  const current = await fixture(t);
  const plan = await current.planAgentBehavior();
  const executor = new ZesResearchInstrumentExecutor(
    current.cycleManager,
    current.instrumentManager,
    { ...current.config, enabled: false },
  );
  await assert.rejects(
    () => executor.execute(
      current.workspace,
      executeInput(plan.planRef, plan.agentStepRef, "run:disabled:v1"),
    ),
    (error: unknown) => error instanceof ResearchCycleError
      && error.code === "RESEARCH_INSTRUMENT_EXECUTION_NOT_CONFIGURED",
  );
  const status = await executor.status(current.workspace);
  assert.equal(status.configured, false);
  assert.deepEqual(status.readiness, {
    status: "not_configured",
    available: false,
  });
});
