import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import type { ZesResearchCycleConfig } from "./config.js";
import {
  canonicalDigest,
  classifyResearchCommand,
  extractPatchPaths,
  ResearchCycleError,
  researchCommandDigest,
  type ResearchCycleOpenInput,
  type ResearchCyclePrepareInput,
  type ResearchDiscoveryPlanInput,
  type ResearchNativeInvocation,
  type ResearchNativeResult,
  type ResearchProviderAcquisitionRunner,
  type ResearchProviderAcquisitionResult,
  type ResearchWorkspace,
  ZesResearchCycleManager,
} from "./research-cycle.js";

const execFileAsync = promisify(execFile);
const NOW = new Date("2026-08-18T08:00:00.000Z");

interface Fixture {
  root: string;
  workspace: ResearchWorkspace;
  manager: ZesResearchCycleManager;
  setNow: (value: Date) => void;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd });
  return result.stdout.trim();
}

async function findNamedFile(root: string, name: string): Promise<string> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      try {
        return await findNamedFile(path, name);
      } catch {
        // Continue with sibling directories.
      }
    } else if (entry.isFile() && entry.name === name) {
      return path;
    }
  }
  throw new Error(`missing fixture file: ${name}`);
}

function argument(args: string[], name: string): string {
  const index = args.indexOf(name);
  assert.notEqual(index, -1, `missing ${name}`);
  const value = args[index + 1];
  assert.ok(value, `missing value for ${name}`);
  return value;
}

async function nativeRunner(
  invocation: ResearchNativeInvocation,
): Promise<ResearchNativeResult> {
  if (invocation.operation === "assess") {
    const requestPath = argument(invocation.args, "--request");
    const outputPath = argument(invocation.args, "--output");
    const request = JSON.parse(await readFile(requestPath, "utf8")) as Record<
      string,
      unknown
    >;
    const requestDigest = canonicalDigest(request);
    const receiptDigest = "b".repeat(64);
    const admissionState = Array.isArray(request.provider_execution_evidence)
      && request.provider_execution_evidence.length > 0
      ? "admitted_fresh_research"
      : "admitted_no_search";
    const receipt = {
      schema_version: "zes.research-decision-admission-receipt.v3",
      request,
      admission_state: admissionState,
      commit_admitted: true,
      causal_reason: admissionState === "admitted_no_search"
        ? "exact local mechanical evidence is sufficient"
        : "current provider evidence and typed discovery coverage are sufficient",
      admission_lease: {
        valid_until: "2026-08-18T10:00:00.000Z",
      },
    };
    await writeFile(outputPath, `${JSON.stringify(receipt)}\n`, "utf8");
    return {
      exitCode: 0,
      stdout: JSON.stringify({
        admission_state: admissionState,
        commit_admitted: true,
        request_digest_sha256: requestDigest,
        receipt_ref: `research-decision-admission:${receiptDigest}`,
        receipt_digest_sha256: receiptDigest,
      }),
      stderr: "",
    };
  }

  if (invocation.operation === "verify-admission") {
    const receiptPath = argument(invocation.args, "--receipt");
    const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as {
      request: Record<string, unknown>;
      commit_admitted: boolean;
      admission_state: string;
    };
    return {
      exitCode: 0,
      stdout: JSON.stringify({
        admission_state: receipt.admission_state,
        commit_admitted: receipt.commit_admitted,
        request_digest_sha256: canonicalDigest(receipt.request),
        receipt_digest_sha256: "b".repeat(64),
      }),
      stderr: "",
    };
  }

  const outputPath = argument(invocation.args, "--output");
  const episodeDigest = "c".repeat(64);
  await writeFile(
    outputPath,
    `${JSON.stringify({
      schema_version: "zes.research-episode-receipt.v1",
      episode_ref: `research-episode:${episodeDigest}`,
      episode_digest_sha256: episodeDigest,
    })}\n`,
    "utf8",
  );
  return {
    exitCode: 0,
    stdout: JSON.stringify({
      episode_ref: `research-episode:${episodeDigest}`,
      episode_digest_sha256: episodeDigest,
    }),
    stderr: "",
  };
}

async function fixture(
  t: TestContext,
  mode: ZesResearchCycleConfig["mode"] = "enforce",
): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "devspace-research-cycle-"));
  const project = join(root, "project");
  await mkdir(join(project, "packages", "zes-control-kernel"), {
    recursive: true,
  });
  await mkdir(join(project, "src"), { recursive: true });
  await writeFile(
    join(project, "packages", "zes-control-kernel", "pyproject.toml"),
    "[project]\nname = \"zes-control-kernel\"\nversion = \"0.0.0\"\n",
    "utf8",
  );
  await writeFile(join(project, "README.md"), "fixture\n", "utf8");
  await git(project, ["init"]);
  await git(project, ["config", "user.email", "devspace@example.com"]);
  await git(project, ["config", "user.name", "DevSpace Test"]);
  await git(project, ["add", "."]);
  await git(project, ["commit", "-m", "Initial fixture"]);

  const config: ZesResearchCycleConfig = {
    mode,
    repositoryRoot: project,
    stateRoot: join(root, "state"),
    timeoutMs: 10_000,
    trustedTraceRoots: [],
    instrumentExecution: {
      enabled: false,
      labRoot: join(root, "lab"),
      maxConcurrent: 1,
    },
  };
  const workspace = { workspaceId: "ws_research_fixture", root: project };
  let currentNow = new Date(NOW);
  const manager = new ZesResearchCycleManager(config, {
    now: () => new Date(currentNow),
    nativeRunner,
  });
  t.after(() => rm(root, { recursive: true, force: true }));
  return {
    root,
    workspace,
    manager,
    setNow: (value) => {
      currentNow = new Date(value);
    },
  };
}

function openInput(): ResearchCycleOpenInput {
  return {
    taskRef: "task:research-cycle",
    materialDecisionRef: "decision:research-cycle",
    decisionBoundaryRef: "devspace.source.mutation",
    decisionQuestion: "Which current implementation boundary is justified?",
    candidatePathPrefixes: ["src"],
    researchEnvelopeHypothesis: "no_search",
    researchQuestions: ["Does the exact local fixture require external evidence?"],
    knownLocalEvidenceRefs: ["git:HEAD"],
    uncertainties: [],
    falsifier: "the local repository identity or action scope changes",
    reopenTrigger: "HEAD, scope, dependency, or evidence changes",
    actorRef: "principal:devspace-test",
    ownerSeededFraming: false,
  };
}

function prepareInput(): ResearchCyclePrepareInput {
  return {
    pathPrefixes: ["src"],
    operationClasses: [
      "source_mutation",
      "repository_commit",
      "repository_publish",
    ],
    evidenceRegimeRefs: ["evidence-regime:exact-local"],
    sourceIdentityRefs: ["git:HEAD"],
  };
}

async function openAndPrepare(current: Fixture): Promise<{
  input: ResearchCycleOpenInput;
  bindings: Record<string, unknown>;
}> {
  const input = openInput();
  await current.manager.open(current.workspace, input);
  const prepared = await current.manager.prepare(
    current.workspace,
    prepareInput(),
  );
  return {
    input,
    bindings: prepared.requestBindings as Record<string, unknown>,
  };
}

const OFFICIAL_DELTA_NOT_APPLICABLE: NonNullable<
  ResearchDiscoveryPlanInput["explicitCoverageLanes"]
> = [
  "open_source_or_independent_implementation",
  "failure_reproduction_or_maintainer_discussion",
  "competing_alternative_or_successor",
  "practitioner_or_production_experience",
  "counterevidence_or_falsifier",
].map((lane) => ({
  lane: lane as NonNullable<
    ResearchDiscoveryPlanInput["explicitCoverageLanes"]
  >[number]["lane"],
  disposition: "not_applicable" as const,
  reason: "the test isolates the official-delta lane",
}));

const FAILURE_FRONTIER_NOT_APPLICABLE: NonNullable<
  ResearchDiscoveryPlanInput["explicitCoverageLanes"]
> = [
  "official_or_release_delta",
  "open_source_or_independent_implementation",
  "competing_alternative_or_successor",
  "practitioner_or_production_experience",
].map((lane) => ({
  lane: lane as NonNullable<
    ResearchDiscoveryPlanInput["explicitCoverageLanes"]
  >[number]["lane"],
  disposition: "not_applicable" as const,
  reason: "the test isolates failure and falsifier signals",
}));

function officialDiscoveryPlanInput(
  overrides: Partial<ResearchDiscoveryPlanInput> = {},
): ResearchDiscoveryPlanInput {
  return {
    subjectRef: "component:research-freshness",
    subjectQuestion: "What changed in the current research freshness contract?",
    temporalRegime: "rapidly_volatile",
    asOf: NOW.toISOString(),
    knownCandidateRefs: ["candidate:current"],
    incumbentRef: "candidate:current",
    discoveryProfile: "official_delta",
    explicitCoverageLanes: OFFICIAL_DELTA_NOT_APPLICABLE,
    ...overrides,
  };
}

function failureDiscoveryPlanInput(): ResearchDiscoveryPlanInput {
  return {
    subjectRef: "component:research-freshness",
    subjectQuestion: "Which failures, reproductions, and falsifiers changed?",
    temporalRegime: "evolving_practice",
    asOf: NOW.toISOString(),
    knownCandidateRefs: ["candidate:current"],
    incumbentRef: "candidate:current",
    discoveryProfile: "failure_reproduction",
    explicitCoverageLanes: FAILURE_FRONTIER_NOT_APPLICABLE,
  };
}

interface DiscoveryRunnerFixture {
  runner: ResearchProviderAcquisitionRunner;
  calls: Array<{
    purpose: "fresh_acquisition" | "counterevidence_or_blind_challenge";
    query: string;
  }>;
  evidenceByRef: Map<string, Record<string, unknown>>;
  evidencePathByRef: Map<string, string>;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function discoveryAdmissionRequest(
  input: ResearchCycleOpenInput,
  bindings: Record<string, unknown>,
  providerEvidence: Record<string, unknown>[],
): Record<string, unknown> {
  return {
    schema_version: "zes.research-decision-admission-request.v3",
    task_ref: input.taskRef,
    material_decision_ref: input.materialDecisionRef,
    decision_boundary_ref: input.decisionBoundaryRef,
    decision_question: input.decisionQuestion,
    owner_seeded_framing: input.ownerSeededFraming,
    assessing_actor_ref: input.actorRef,
    provider_execution_evidence: providerEvidence,
    ...bindings,
  };
}

async function writePrivateFixtureFile(
  path: string,
  content: string,
): Promise<void> {
  await writeFile(path, content, "utf8");
  await chmod(path, 0o600);
}

function discoveryRunnerFixture(
  current: Fixture,
  options: {
    failAtCall?: number;
    beforeReturn?: (
      call: number,
      workspace: ResearchWorkspace,
    ) => Promise<void>;
  } = {},
): DiscoveryRunnerFixture {
  const calls: DiscoveryRunnerFixture["calls"] = [];
  const evidenceByRef = new Map<string, Record<string, unknown>>();
  const evidencePathByRef = new Map<string, string>();

  const runner: ResearchProviderAcquisitionRunner = async (
    workspace,
    purpose,
    request,
  ): Promise<ResearchProviderAcquisitionResult> => {
    calls.push({ purpose, query: request.query });
    const call = calls.length;
    if (options.failAtCall === call) {
      throw new ResearchCycleError(
        "TEST_DISCOVERY_PROVIDER_FAILURE",
        `synthetic provider failure at call ${call}`,
      );
    }
    const statePath = await findNamedFile(
      join(current.root, "state"),
      "state.json",
    );
    const state = JSON.parse(await readFile(statePath, "utf8")) as {
      open: { evidenceDirectory: string; ownerSeededFraming: boolean };
    };
    const identity = canonicalDigest({
      call,
      purpose,
      query: request.query,
      maxResults: request.maxResults,
    }).slice(0, 32);
    const providerEvidenceRef = `research-provider-evidence:exa:${identity}`;
    const providerTraceRef = `research-provider-trace:exa:${identity}`;
    const providerEvidence = {
      schema_version: "zes.research-provider-execution-evidence.v2",
      evidence_ref: providerEvidenceRef,
      provider_operation: "search",
      provider_route_ref: "provider-route:exa-search:v1",
      route_kind: "exa_open_world_research",
      purpose,
      owner_seeded_framing: state.open.ownerSeededFraming,
      trace_source_ref: providerTraceRef,
      verified_capability_refs: [
        "capability:open-world-candidate-discovery:v1",
      ],
      open_world_candidate_discovery_performed: true,
      result_source_refs: [`source:exa:${identity}`],
    } satisfies Record<string, unknown>;
    const evidenceText = `${JSON.stringify(providerEvidence, null, 2)}\n`;
    const traceText = `${JSON.stringify({
      traceRef: providerTraceRef,
      evidenceRef: providerEvidenceRef,
      provider: "exa",
      operation: "search",
      query: request.query,
      purpose,
    })}\n`;
    const providerEvidencePath = join(
      state.open.evidenceDirectory,
      `discovery-evidence-${identity}.json`,
    );
    const providerTracePath = join(
      state.open.evidenceDirectory,
      `discovery-trace-${identity}.jsonl`,
    );
    await writePrivateFixtureFile(providerEvidencePath, evidenceText);
    await writePrivateFixtureFile(providerTracePath, traceText);
    evidenceByRef.set(providerEvidenceRef, providerEvidence);
    evidencePathByRef.set(providerEvidenceRef, providerEvidencePath);
    if (options.beforeReturn) {
      await options.beforeReturn(call, workspace);
    }
    return {
      status: "acquired",
      providerEvidenceRef,
      providerEvidencePath,
      providerEvidenceFileSha256: sha256(evidenceText),
      providerTraceRef,
      providerTracePath,
      providerTraceFileSha256: sha256(traceText),
      providerEvidence,
      providerReceiptFileSha256: sha256(traceText),
    };
  };

  return { runner, calls, evidenceByRef, evidencePathByRef };
}

async function admit(
  current: Fixture,
  preparedInput: ResearchCyclePrepareInput = prepareInput(),
): Promise<void> {
  const input = openInput();
  await current.manager.open(current.workspace, input);
  const prepared = await current.manager.prepare(
    current.workspace,
    preparedInput,
  );
  const bindings = prepared.requestBindings as Record<string, unknown>;
  await current.manager.assess(current.workspace, {
    schema_version: "zes.research-decision-admission-request.v3",
    task_ref: input.taskRef,
    material_decision_ref: input.materialDecisionRef,
    decision_boundary_ref: input.decisionBoundaryRef,
    decision_question: input.decisionQuestion,
    owner_seeded_framing: input.ownerSeededFraming,
    assessing_actor_ref: input.actorRef,
    ...bindings,
  });
}

test("command and patch classification is conservative", () => {
  assert.equal(
    classifyResearchCommand("git push owner HEAD:main"),
    "repository_publish",
  );
  assert.equal(classifyResearchCommand("git commit -m test"), "repository_commit");
  assert.equal(classifyResearchCommand("npm run typecheck"), "validation");
  assert.equal(classifyResearchCommand("custom-generator --write"), "unknown");
  assert.deepEqual(
    extractPatchPaths([
      "*** Begin Patch",
      "*** Update File: src/a.ts",
      "*** Move to: src/b.ts",
      "*** End Patch",
    ].join("\n")),
    ["src/a.ts", "src/b.ts"],
  );
});

test("new assessment rejects legacy v2 admission requests", async (t) => {
  const current = await fixture(t);
  const input = openInput();
  await current.manager.open(current.workspace, input);
  const prepared = await current.manager.prepare(
    current.workspace,
    prepareInput(),
  );
  const bindings = prepared.requestBindings as Record<string, unknown>;
  await assert.rejects(
    () => current.manager.assess(current.workspace, {
      schema_version: "zes.research-decision-admission-request.v2",
      task_ref: input.taskRef,
      material_decision_ref: input.materialDecisionRef,
      decision_boundary_ref: input.decisionBoundaryRef,
      decision_question: input.decisionQuestion,
      owner_seeded_framing: input.ownerSeededFraming,
      assessing_actor_ref: input.actorRef,
      ...bindings,
    }),
    (error: unknown) => error instanceof ResearchCycleError
      && error.code === "RESEARCH_CYCLE_V3_ADMISSION_REQUIRED",
  );
});

test("enforce mode binds admission through closure and publication", async (t) => {
  const current = await fixture(t);
  const before = await current.manager.guardPaths(current.workspace, ["src/new.ts"]);
  assert.equal(before.allowed, false);
  assert.deepEqual(before.reasons, [
    "research_cycle_not_opened",
    "source_mutation_not_in_action_scope",
  ]);

  await admit(current);
  const allowed = await current.manager.guardPaths(current.workspace, ["src/new.ts"]);
  assert.equal(allowed.allowed, true);
  const outside = await current.manager.guardPaths(current.workspace, ["README.md"]);
  assert.equal(outside.allowed, false);
  assert.match(outside.reasons.join("\n"), /path_outside_research_action_scope/);

  await writeFile(join(current.workspace.root, "src", "new.ts"), "export const value = 1;\n");
  await current.manager.observePaths(current.workspace, ["src/new.ts"]);
  await git(current.workspace.root, ["add", "src/new.ts"]);
  await current.manager.verifyPreCommit(
    current.workspace,
    ["validation:npm-run-typecheck:passed"],
    {
      localAuthorityRechecked: true,
      externalCurrentnessRechecked: false,
      dependencyCurrentnessRechecked: true,
      assumptionsRechecked: ["the exact local Git baseline remains current"],
      counterevidenceOrLimitations: [],
      unresolved: [],
      stoppingReason: "the exact local mechanical question is resolved",
    },
  );

  const commitCommand = "git commit -m 'Add research fixture'";
  const commitGuard = await current.manager.guardCommand(
    current.workspace,
    commitCommand,
  );
  assert.equal(commitGuard.allowed, true);
  await git(current.workspace.root, ["commit", "-m", "Add research fixture"]);
  await current.manager.observeCommandSnapshot(
    current.workspace,
    commitCommand,
    { running: false, exitCode: 0 },
  );
  const committed = await current.manager.status(current.workspace);
  assert.equal(committed.phase, "committed");

  await current.manager.close(current.workspace, {
    outcome: "committed",
    reason: "the exact admitted change was committed",
    decisionDelta: "bound DevSpace mutation to the native Research Reflex lease",
    reusableFindings: ["exact action-scope binding prevents receipt replay"],
    reversalConditions: ["native Research Reflex contract changes"],
  });
  const publish = await current.manager.guardCommand(
    current.workspace,
    "git push owner HEAD:main",
  );
  assert.equal(publish.allowed, true);
  assert.equal(publish.phase, "closed");
});

test("observe mode permits effects but records scope drift", async (t) => {
  const current = await fixture(t, "observe");
  await admit(current);
  const advisory = await current.manager.guardPaths(current.workspace, ["README.md"]);
  assert.equal(advisory.allowed, true);
  assert.equal(advisory.advisoryOnly, true);
  assert.match(advisory.reasons.join("\n"), /path_outside_research_action_scope/);
  await current.manager.observePaths(current.workspace, ["README.md"]);
  const status = await current.manager.status(current.workspace);
  assert.equal(status.phase, "reassessment_required");
  assert.match(JSON.stringify(status.invalidations), /scope_drift/);
});

test("two distinct failed commands invalidate an admitted action", async (t) => {
  const current = await fixture(t);
  await admit(current);
  await current.manager.observeCommandSnapshot(
    current.workspace,
    "npm test -- first",
    { running: false, exitCode: 1 },
  );
  await current.manager.observeCommandSnapshot(
    current.workspace,
    "npm test -- second",
    { running: false, exitCode: 1 },
  );
  const status = await current.manager.status(current.workspace);
  assert.equal(status.phase, "reassessment_required");
  assert.equal(status.distinctFailureCount, 2);
  assert.match(JSON.stringify(status.invalidations), /repeated_distinct_failure/);
});

test("interactive input remains bound to the already-guarded process command", async (t) => {
  const current = await fixture(t);
  await current.manager.observeCommandSnapshot(
    current.workspace,
    "npm run typecheck",
    { sessionId: 41, running: true },
  );
  const validationInput = await current.manager.guardProcessInput(
    current.workspace,
    41,
  );
  assert.equal(validationInput.allowed, true);
  assert.equal(validationInput.classification, "validation");

  const unknownProcess = await current.manager.guardProcessInput(
    current.workspace,
    99,
  );
  assert.equal(unknownProcess.allowed, false);
  assert.deepEqual(unknownProcess.reasons, ["research_process_binding_missing"]);
});

test("changed native receipt and expired lease both fail closed", async (t) => {
  const changed = await fixture(t);
  await admit(changed);
  const receiptPath = await findNamedFile(
    join(changed.root, "state"),
    "admission-receipt-g1.json",
  );
  await writeFile(receiptPath, "{}\n", "utf8");
  const changedGuard = await changed.manager.guardPaths(
    changed.workspace,
    ["src/new.ts"],
  );
  assert.equal(changedGuard.allowed, false);
  assert.match(
    changedGuard.reasons.join("\n"),
    /research_admission_receipt_file_changed/,
  );

  const expired = await fixture(t);
  await admit(expired);
  expired.setNow(new Date("2026-08-18T10:00:00.000Z"));
  const expiredGuard = await expired.manager.guardPaths(
    expired.workspace,
    ["src/new.ts"],
  );
  assert.equal(expiredGuard.allowed, false);
  assert.match(
    expiredGuard.reasons.join("\n"),
    /research_admission_lease_expired/,
  );
});

test("shell mutation requires an exact admitted command digest", async (t) => {
  const command = "custom-generator --write";
  const unbound = await fixture(t);
  await admit(unbound);
  const blocked = await unbound.manager.guardCommand(unbound.workspace, command);
  assert.equal(blocked.allowed, false);
  assert.match(
    blocked.reasons.join("\n"),
    /shell_mutation_command_not_in_action_scope/,
  );

  const bound = await fixture(t);
  await admit(bound, {
    ...prepareInput(),
    shellMutationCommandDigests: [researchCommandDigest(command)],
  });
  const allowed = await bound.manager.guardCommand(bound.workspace, command);
  assert.equal(allowed.allowed, true);
  const boundStatePath = await findNamedFile(
    join(bound.root, "state"),
    "state.json",
  );
  const boundState = await readFile(boundStatePath, "utf8");
  assert.equal(boundState.includes(command), false);
  assert.match(boundState, new RegExp(researchCommandDigest(command)));

  const dependencyCommand = "npm install left-pad";
  const dependency = await fixture(t);
  await admit(dependency, {
    ...prepareInput(),
    shellMutationCommandDigests: [researchCommandDigest(dependencyCommand)],
  });
  const dependencyBlocked = await dependency.manager.guardCommand(
    dependency.workspace,
    dependencyCommand,
  );
  assert.equal(dependencyBlocked.allowed, false);
  assert.match(
    dependencyBlocked.reasons.join("\n"),
    /dependency_change_not_in_action_scope/,
  );

  const dependencyBound = await fixture(t);
  await admit(dependencyBound, {
    ...prepareInput(),
    operationClasses: [
      ...prepareInput().operationClasses,
      "dependency_change",
    ],
    shellMutationCommandDigests: [researchCommandDigest(dependencyCommand)],
  });
  const dependencyAllowed = await dependencyBound.manager.guardCommand(
    dependencyBound.workspace,
    dependencyCommand,
  );
  assert.equal(dependencyAllowed.allowed, true);
});

test("persisted receipt paths are revalidated before use", async (t) => {
  const current = await fixture(t);
  await admit(current);
  const statePath = await findNamedFile(
    join(current.root, "state"),
    "state.json",
  );
  const state = JSON.parse(await readFile(statePath, "utf8")) as {
    admission: { receiptPath: string };
  };
  state.admission.receiptPath = "/etc/passwd";
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await assert.rejects(
    () => current.manager.status(current.workspace),
    /admission receipt path is outside its private cycle directory/,
  );
});

test("discovery planning freezes an idempotent source-neutral portfolio", async (t) => {
  const current = await fixture(t);
  await openAndPrepare(current);
  const first = await current.manager.discoveryPlan(
    current.workspace,
    officialDiscoveryPlanInput(),
  );
  const second = await current.manager.discoveryPlan(
    current.workspace,
    officialDiscoveryPlanInput(),
  );

  assert.equal(second.planRef, first.planRef);
  assert.equal(second.portfolioDigestSha256, first.portfolioDigestSha256);
  assert.equal(second.generatedAt, first.generatedAt);
  assert.equal(first.queries.length, 2);
  assert.ok(first.queries.every((query) => query.provider === "exa"));
  assert.ok(first.queries.every((query) => query.operation === "search"));
  assert.ok(first.queries.every((query) =>
    query.temporalConstraint.mode === "query_text_only"
    && query.temporalConstraint.providerNativeDateFilterApplied === false
    && query.temporalConstraint.providerNativeDomainFilterApplied === false));
  assert.equal(
    first.coverage.find((entry) => entry.lane === "official_or_release_delta")
      ?.disposition,
    "required",
  );

  await assert.rejects(
    () => current.manager.discoveryPlan(current.workspace, {
      ...officialDiscoveryPlanInput(),
      discoveryProfile: "balanced_frontier",
      explicitCoverageLanes: [{
        lane: "open_source_or_independent_implementation",
        disposition: "not_applicable",
        reason: "attempt to erase a required broad-frontier lane",
      }],
    }),
    (error: unknown) => error instanceof ResearchCycleError
      && error.code === "RESEARCH_DISCOVERY_COVERAGE_INVALID",
  );
});

test("official-only acquisition cannot close a broad discovery profile", async (t) => {
  const current = await fixture(t);
  await openAndPrepare(current);
  const plan = await current.manager.discoveryPlan(current.workspace, {
    ...officialDiscoveryPlanInput(),
    discoveryProfile: "balanced_frontier",
    explicitCoverageLanes: undefined,
  });
  const officialQueryRefs = plan.queries
    .filter((query) => query.lane === "official_or_release_delta")
    .map((query) => query.queryRef);
  const acquisition = discoveryRunnerFixture(current);
  const result = await current.manager.discoveryAcquire(
    current.workspace,
    { planRef: plan.planRef, queryRefs: officialQueryRefs },
    acquisition.runner,
  );

  assert.equal(result.status, "partial");
  assert.equal(result.requiredCovered, false);
  assert.equal(result.coveredQueries, officialQueryRefs.length);
  assert.ok(result.unresolvedQueries > 0);
  await assert.rejects(
    () => current.manager.horizonRecord(current.workspace, {
      planRef: plan.planRef,
      asOf: NOW.toISOString(),
    }),
    (error: unknown) => error instanceof ResearchCycleError
      && error.code === "RESEARCH_DISCOVERY_COVERAGE_INCOMPLETE",
  );
});

test("discovery acquisition preserves success and never retries a terminal failure", async (t) => {
  const current = await fixture(t);
  await openAndPrepare(current);
  const plan = await current.manager.discoveryPlan(
    current.workspace,
    officialDiscoveryPlanInput(),
  );
  const acquisition = discoveryRunnerFixture(current, { failAtCall: 2 });
  const first = await current.manager.discoveryAcquire(
    current.workspace,
    { planRef: plan.planRef },
    acquisition.runner,
  );

  assert.equal(first.status, "held");
  assert.deepEqual(
    first.acquisitions.map((entry) => entry.status),
    ["acquired", "failed"],
  );
  assert.equal(acquisition.calls.length, 2);
  const second = await current.manager.discoveryAcquire(
    current.workspace,
    { planRef: plan.planRef },
    acquisition.runner,
  );
  assert.equal(second.status, "held");
  assert.equal(acquisition.calls.length, 2);
  assert.equal(second.acquisitions[0]?.providerEvidenceRef,
    first.acquisitions[0]?.providerEvidenceRef);
  assert.equal(second.acquisitions[1]?.attemptOrdinal, 1);
  assert.equal(second.acquisitions[1]?.noRetryPerformed, true);
});

test("discovery acquisition releases the lifecycle lock around provider execution", async (t) => {
  const current = await fixture(t);
  await openAndPrepare(current);
  const plan = await current.manager.discoveryPlan(
    current.workspace,
    officialDiscoveryPlanInput(),
  );
  const acquisition = discoveryRunnerFixture(current, {
    beforeReturn: async (call, workspace) => {
      if (call !== 1) return;
      await current.manager.invalidate(
        workspace,
        "manual",
        "synthetic context change while the external provider call is in flight",
        ["evidence:test:context-change"],
      );
    },
  });
  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error("discovery acquisition deadlocked")), 1_000);
  });

  await assert.rejects(
    () => Promise.race([
      current.manager.discoveryAcquire(
        current.workspace,
        { planRef: plan.planRef },
        acquisition.runner,
      ),
      timeout,
    ]),
    (error: unknown) => error instanceof ResearchCycleError
      && error.code === "RESEARCH_DISCOVERY_CONTEXT_CHANGED",
  );
  assert.equal(acquisition.calls.length, 1);
  const status = await current.manager.status(current.workspace);
  assert.equal(status.phase, "reassessment_required");
});

test("horizon records only typed evidence-bound event classes and is idempotent", async (t) => {
  const current = await fixture(t);
  await openAndPrepare(current);
  const plan = await current.manager.discoveryPlan(
    current.workspace,
    failureDiscoveryPlanInput(),
  );
  const acquisition = discoveryRunnerFixture(current);
  const acquired = await current.manager.discoveryAcquire(
    current.workspace,
    { planRef: plan.planRef },
    acquisition.runner,
  );
  assert.equal(acquired.status, "acquired");
  const failure = acquired.acquisitions.find((entry) =>
    entry.lane === "failure_reproduction_or_maintainer_discussion");
  const counter = acquired.acquisitions.find((entry) =>
    entry.lane === "counterevidence_or_falsifier");
  assert.ok(failure?.providerEvidenceRef);
  assert.ok(counter?.providerEvidenceRef);
  const failureRef = failure.providerEvidenceRef;
  const counterRef = counter.providerEvidenceRef;

  await assert.rejects(
    () => current.manager.horizonRecord(current.workspace, {
      planRef: plan.planRef,
      asOf: NOW.toISOString(),
      observations: [{
        kind: "community_failure_cluster_detected",
        evidenceRefs: [counterRef],
        subjectRefs: [],
        rationale: "a counterevidence lane cannot fabricate a failure cluster",
      }],
    }),
    (error: unknown) => error instanceof ResearchCycleError
      && error.code === "RESEARCH_DISCOVERY_HORIZON_SIGNAL_INVALID",
  );

  const input = {
    planRef: plan.planRef,
    expectedGeneration: plan.generation,
    asOf: NOW.toISOString(),
    priorSnapshot: {
      snapshotRef: "research-discovery-snapshot:prior",
      portfolioDigestSha256: "d".repeat(64),
      candidateRefs: ["candidate:current"],
      incumbentRef: "candidate:current",
    },
    observations: [
      {
        kind: "community_failure_cluster_detected" as const,
        evidenceRefs: [failureRef],
        subjectRefs: ["component:research-freshness"],
        rationale: "a reproduced failure cluster changed the operating envelope",
      },
      {
        kind: "new_reproduction_or_counterevidence" as const,
        evidenceRefs: [counterRef],
        subjectRefs: ["assumption:prior-selection"],
        rationale: "new counterevidence challenges the previous selection",
      },
      {
        kind: "new_candidate_detected" as const,
        evidenceRefs: [failureRef],
        subjectRefs: ["candidate:new-successor"],
        rationale: "a candidate absent from the planning baseline was observed",
      },
      {
        kind: "upstream_semantics_changed" as const,
        evidenceRefs: [failureRef],
        subjectRefs: ["upstream:research-contract:v2"],
        rationale: "the exact upstream contract identity changed",
      },
      {
        kind: "prior_selection_superseded_candidate" as const,
        evidenceRefs: [failureRef],
        subjectRefs: ["candidate:new-successor"],
        rationale: "the typed prior snapshot now has a supported successor",
      },
    ],
  };
  const first = await current.manager.horizonRecord(current.workspace, input);
  const second = await current.manager.horizonRecord(current.workspace, input);
  assert.equal(second.horizonRef, first.horizonRef);
  assert.equal(second.recordedAt, first.recordedAt);
  assert.equal(first.requiresResearchReflexRefresh, true);
  assert.deepEqual(
    first.events.map((event) => event.kind).sort(),
    [
      "community_failure_cluster_detected",
      "new_candidate_detected",
      "new_reproduction_or_counterevidence",
      "prior_selection_superseded_candidate",
      "upstream_semantics_changed",
    ],
  );
});

test("discovery evidence identity changes fail closed before horizon use", async (t) => {
  const current = await fixture(t);
  await openAndPrepare(current);
  const plan = await current.manager.discoveryPlan(
    current.workspace,
    officialDiscoveryPlanInput(),
  );
  const acquisition = discoveryRunnerFixture(current);
  const acquired = await current.manager.discoveryAcquire(
    current.workspace,
    { planRef: plan.planRef },
    acquisition.runner,
  );
  assert.equal(acquired.status, "acquired");
  const evidenceRef = acquired.acquisitions[0]?.providerEvidenceRef;
  assert.ok(evidenceRef);
  const evidencePath = acquisition.evidencePathByRef.get(evidenceRef);
  assert.ok(evidencePath);
  await writeFile(
    evidencePath,
    `${await readFile(evidencePath, "utf8")}tampered\n`,
    "utf8",
  );
  await chmod(evidencePath, 0o600);

  await assert.rejects(
    () => current.manager.horizonRecord(current.workspace, {
      planRef: plan.planRef,
      asOf: NOW.toISOString(),
    }),
    (error: unknown) => error instanceof ResearchCycleError
      && error.code === "RESEARCH_DISCOVERY_EVIDENCE_CHANGED",
  );
  await assert.rejects(
    () => current.manager.status(current.workspace),
    (error: unknown) => error instanceof ResearchCycleError
      && error.code === "RESEARCH_DISCOVERY_EVIDENCE_CHANGED",
  );
});

test("persisted discovery query and horizon identities are recomputed", async (t) => {
  const acquisitionFixture = await fixture(t);
  await openAndPrepare(acquisitionFixture);
  const acquisitionPlan = await acquisitionFixture.manager.discoveryPlan(
    acquisitionFixture.workspace,
    officialDiscoveryPlanInput(),
  );
  const acquisition = discoveryRunnerFixture(acquisitionFixture);
  await acquisitionFixture.manager.discoveryAcquire(
    acquisitionFixture.workspace,
    { planRef: acquisitionPlan.planRef },
    acquisition.runner,
  );
  const acquisitionStatePath = await findNamedFile(
    join(acquisitionFixture.root, "state"),
    "state.json",
  );
  const acquisitionState = JSON.parse(
    await readFile(acquisitionStatePath, "utf8"),
  ) as {
    discovery: { acquisitions: Array<{ query: string }> };
  };
  acquisitionState.discovery.acquisitions[0]!.query += " tampered";
  await writeFile(
    acquisitionStatePath,
    `${JSON.stringify(acquisitionState, null, 2)}\n`,
    "utf8",
  );
  await assert.rejects(
    () => acquisitionFixture.manager.status(acquisitionFixture.workspace),
    (error: unknown) => error instanceof ResearchCycleError
      && error.code === "RESEARCH_DISCOVERY_STATE_INVALID",
  );

  const horizonFixture = await fixture(t);
  await openAndPrepare(horizonFixture);
  const horizonPlan = await horizonFixture.manager.discoveryPlan(
    horizonFixture.workspace,
    officialDiscoveryPlanInput(),
  );
  const horizonAcquisition = discoveryRunnerFixture(horizonFixture);
  await horizonFixture.manager.discoveryAcquire(
    horizonFixture.workspace,
    { planRef: horizonPlan.planRef },
    horizonAcquisition.runner,
  );
  await horizonFixture.manager.horizonRecord(horizonFixture.workspace, {
    planRef: horizonPlan.planRef,
    asOf: NOW.toISOString(),
  });
  const horizonStatePath = await findNamedFile(
    join(horizonFixture.root, "state"),
    "state.json",
  );
  const horizonState = JSON.parse(
    await readFile(horizonStatePath, "utf8"),
  ) as {
    discovery: { horizon: { staleReasons: string[] } };
  };
  horizonState.discovery.horizon.staleReasons.push("tampered_reason");
  await writeFile(
    horizonStatePath,
    `${JSON.stringify(horizonState, null, 2)}\n`,
    "utf8",
  );
  await assert.rejects(
    () => horizonFixture.manager.status(horizonFixture.workspace),
    (error: unknown) => error instanceof ResearchCycleError
      && error.code === "RESEARCH_DISCOVERY_STATE_INVALID",
  );
});

test("temporal expiry is a revalidation signal rather than a falsehood claim", async (t) => {
  const current = await fixture(t);
  await openAndPrepare(current);
  const plan = await current.manager.discoveryPlan(
    current.workspace,
    officialDiscoveryPlanInput(),
  );
  const acquisition = discoveryRunnerFixture(current);
  const acquired = await current.manager.discoveryAcquire(
    current.workspace,
    { planRef: plan.planRef },
    acquisition.runner,
  );
  assert.equal(acquired.status, "acquired");
  const expiredAt = new Date("2026-08-20T08:00:00.000Z");
  current.setNow(expiredAt);
  const horizon = await current.manager.horizonRecord(current.workspace, {
    planRef: plan.planRef,
    asOf: expiredAt.toISOString(),
  });
  const expiry = horizon.events.find((event) =>
    event.kind === "current_source_expired");
  assert.ok(expiry);
  assert.match(expiry.rationale, /revalidation/i);
  assert.match(expiry.rationale, /not declared false/i);
  const status = await current.manager.horizonStatus(current.workspace);
  assert.equal(status.status, "stale");
  assert.deepEqual(status.staleReasons, ["current_source_expired"]);
  assert.equal(status.requiresResearchReflexRefresh, true);
});

test("assessment and pre-commit bind the exact current discovery evidence set", async (t) => {
  const current = await fixture(t);
  const prepared = await openAndPrepare(current);
  const plan = await current.manager.discoveryPlan(
    current.workspace,
    officialDiscoveryPlanInput(),
  );
  const acquisition = discoveryRunnerFixture(current);
  const acquired = await current.manager.discoveryAcquire(
    current.workspace,
    { planRef: plan.planRef },
    acquisition.runner,
  );
  assert.equal(acquired.status, "acquired");
  const evidenceRefs = acquired.acquisitions.map((entry) => {
    assert.ok(entry.providerEvidenceRef);
    return entry.providerEvidenceRef;
  });
  const providerEvidence = evidenceRefs.map((ref) => {
    const evidence = acquisition.evidenceByRef.get(ref);
    assert.ok(evidence);
    return evidence;
  });
  const fullRequest = discoveryAdmissionRequest(
    prepared.input,
    prepared.bindings,
    providerEvidence,
  );

  await assert.rejects(
    () => current.manager.assess(
      current.workspace,
      fullRequest,
      [],
      evidenceRefs,
    ),
    (error: unknown) => error instanceof ResearchCycleError
      && error.code === "RESEARCH_DISCOVERY_HORIZON_REQUIRED",
  );
  await current.manager.horizonRecord(current.workspace, {
    planRef: plan.planRef,
    asOf: NOW.toISOString(),
  });
  await assert.rejects(
    () => current.manager.assess(
      current.workspace,
      discoveryAdmissionRequest(
        prepared.input,
        prepared.bindings,
        providerEvidence.slice(0, 1),
      ),
      [],
      evidenceRefs,
    ),
    (error: unknown) => error instanceof ResearchCycleError
      && error.code === "RESEARCH_DISCOVERY_EVIDENCE_NOT_REFERENCED",
  );
  const assessment = await current.manager.assess(
    current.workspace,
    fullRequest,
    [],
    evidenceRefs,
  );
  const assessmentVerification = assessment.discoveryEvidenceVerification as {
    planRef: string;
    evidenceRefs: string[];
  };
  assert.equal(assessmentVerification.planRef, plan.planRef);
  assert.deepEqual(assessmentVerification.evidenceRefs, [...evidenceRefs].sort());

  await writeFile(
    join(current.workspace.root, "src", "discovery.ts"),
    "export const discoveryBound = true;\n",
    "utf8",
  );
  await current.manager.observePaths(current.workspace, ["src/discovery.ts"]);
  await git(current.workspace.root, ["add", "src/discovery.ts"]);
  const preCommit = await current.manager.verifyPreCommit(
    current.workspace,
    ["validation:research-discovery:passed"],
    {
      localAuthorityRechecked: true,
      externalCurrentnessRechecked: true,
      dependencyCurrentnessRechecked: true,
      assumptionsRechecked: [
        "the frozen plan, evidence identities, and horizon remain current",
      ],
      counterevidenceOrLimitations: [
        "the horizon is a signal boundary rather than semantic authority",
      ],
      unresolved: [],
      stoppingReason:
        "required discovery coverage and the native admission are current",
    },
  );
  const preCommitVerification = preCommit.discoveryEvidenceVerification as {
    planRef: string;
    horizonRef: string;
  };
  assert.equal(preCommitVerification.planRef, plan.planRef);
  assert.match(preCommitVerification.horizonRef, /^research-discovery:horizon:/u);
});
