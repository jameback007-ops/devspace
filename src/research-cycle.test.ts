import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
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
  researchCommandDigest,
  type ResearchCycleOpenInput,
  type ResearchCyclePrepareInput,
  type ResearchNativeInvocation,
  type ResearchNativeResult,
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
    const receipt = {
      schema_version: "zes.research-decision-admission-receipt.v2",
      request,
      admission_state: "admitted_no_search",
      commit_admitted: true,
      causal_reason: "exact local mechanical evidence is sufficient",
      admission_lease: {
        valid_until: "2026-08-18T10:00:00.000Z",
      },
    };
    await writeFile(outputPath, `${JSON.stringify(receipt)}\n`, "utf8");
    return {
      exitCode: 0,
      stdout: JSON.stringify({
        admission_state: "admitted_no_search",
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
    schema_version: "zes.research-decision-admission-request.v2",
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
