import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  executionScopeIdentity,
  executorTurnMetadata,
} from "./request-meta.js";
import {
  TurnContinuityManager,
  type RecoveryCapsuleInput,
  type TurnContinuityConfig,
} from "./turn-continuity.js";

const execFileAsync = promisify(execFile);

const config: TurnContinuityConfig = {
  enabled: true,
  estimatedTurnMs: 1_000,
  awarenessAfterMs: 500,
  landingAfterMs: 800,
  capsuleRetentionMs: 30 * 24 * 60 * 60 * 1_000,
  maxCapsulesPerWorkspace: 10,
  maxCapsuleCharacters: 64_000,
};

test("turn horizon is advisory-only, emits each threshold once, and explicit begin is idempotent", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-turn-horizon-test-"));
  let now = 10_000;
  const manager = new TurnContinuityManager(config, stateDir, { now: () => now });
  const identity = executionScopeIdentity({ "openai/session": "scope-one" });
  assert.ok(identity);
  t.after(async () => {
    manager.close();
    await rm(stateDir, { recursive: true, force: true });
  });

  const first = manager.begin(identity, {}, {
    idempotencyKey: "turn-one",
    reason: "new_turn",
  });
  assert.equal(first.started, true);
  const firstStatus = first.status as Record<string, unknown>;
  assert.equal(firstStatus.advisory, "normal");
  assert.equal(firstStatus.toolsBlocked, false);
  assert.equal(firstStatus.taskCompletionRequired, false);
  const semanticUnavailable = await manager.semanticProjectionForScope(
    identity.scopeRef,
  );
  assert.equal(semanticUnavailable.available, false);
  assert.equal(
    semanticUnavailable.reason,
    "no_explicit_recovery_capsule_for_scope",
  );

  now += 600;
  const awareness = manager.advisoryNotice(identity, {}, "read");
  assert.match(awareness ?? "", /checkpoint|recovery capsule/i);
  assert.equal(manager.advisoryNotice(identity, {}, "read"), undefined);

  now += 300;
  const landing = manager.advisoryNotice(identity, {}, "read");
  assert.match(landing ?? "", /landing opportunity/i);
  assert.match(landing ?? "", /Tools remain fully available/i);
  assert.equal(manager.advisoryNotice(identity, {}, "read"), undefined);

  manager.observeToolFinish(identity, {}, "apply_patch", {}, true);
  const staleNotice = manager.advisoryNotice(identity, {}, "read");
  assert.match(staleNotice ?? "", /Potentially mutating work occurred/i);
  assert.equal(manager.advisoryNotice(identity, {}, "read"), undefined);

  const replay = manager.begin(identity, {}, {
    idempotencyKey: "turn-one",
    reason: "new_turn",
  });
  assert.equal(replay.started, false);
  assert.equal(replay.idempotentReplay, true);
  assert.equal(
    (replay.status as Record<string, unknown>).startedAt,
    firstStatus.startedAt,
  );

  const next = manager.begin(identity, {}, {
    idempotencyKey: "turn-two",
    reason: "new_turn",
  });
  assert.equal(next.started, true);
  assert.equal((next.status as Record<string, unknown>).advisory, "normal");
});

test("host turn identity automatically resets advisory timing without using conversation age", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-host-turn-test-"));
  let now = 50_000;
  const manager = new TurnContinuityManager(config, stateDir, { now: () => now });
  const identity = executionScopeIdentity({ "openai/session": "conversation" });
  assert.ok(identity);
  t.after(async () => {
    manager.close();
    await rm(stateDir, { recursive: true, force: true });
  });

  const firstMeta = executorTurnMetadata({
    "devspace/executor-turn": "host-turn-one",
  });
  const first = manager.status(identity, firstMeta);
  const firstStatus = first.status as Record<string, unknown>;
  assert.equal(firstStatus.source, "host_turn");
  assert.equal(firstStatus.advisory, "normal");

  now += 900;
  assert.equal(
    ((manager.status(identity, firstMeta).status) as Record<string, unknown>).advisory,
    "landing_opportunity",
  );

  const secondMeta = executorTurnMetadata({
    "devspace/executor-turn": "host-turn-two",
  });
  const secondStatus = manager.status(identity, secondMeta).status as Record<string, unknown>;
  assert.equal(secondStatus.advisory, "normal");
  assert.notEqual(secondStatus.epochId, firstStatus.epochId);
});

test("an exact host deadline uses lead-window advisories without enforcing the deadline", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-host-deadline-test-"));
  let now = 1_000_000;
  const manager = new TurnContinuityManager(config, stateDir, { now: () => now });
  const identity = executionScopeIdentity({ "openai/session": "deadline-scope" });
  assert.ok(identity);
  t.after(async () => {
    manager.close();
    await rm(stateDir, { recursive: true, force: true });
  });

  const metadata = executorTurnMetadata({
    "devspace/executor-turn": "deadline-turn",
    "devspace/executor-deadline-ms": now + 2_000,
  });
  const initial = manager.status(identity, metadata).status as Record<string, unknown>;
  assert.equal(initial.deadlineKind, "host_exact");
  assert.equal(initial.advisory, "normal");
  assert.equal(initial.toolsBlocked, false);

  now += 1_600;
  const awareness = manager.status(identity, metadata).status as Record<string, unknown>;
  assert.equal(awareness.advisory, "checkpoint_awareness");

  now += 250;
  const landing = manager.status(identity, metadata).status as Record<string, unknown>;
  assert.equal(landing.advisory, "landing_opportunity");
  assert.equal(landing.taskCompletionRequired, false);

  now += 500;
  const overrun = manager.status(identity, metadata).status as Record<string, unknown>;
  assert.equal(overrun.advisory, "landing_opportunity");
  assert.equal(overrun.toolsBlocked, false);
  assert.ok(Number(overrun.overrunMs) > 0);
});

test("recovery capsule is Git-bound, detects stale tracked and untracked state, and survives another scope", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-recovery-capsule-test-"));
  const stateDir = join(root, ".state");
  const project = join(root, "project");
  await execFileAsync("mkdir", ["-p", project]);
  await writeFile(join(project, "README.md"), "initial\n");
  await git(project, ["init"]);
  await git(project, ["config", "user.email", "devspace@example.com"]);
  await git(project, ["config", "user.name", "DevSpace Test"]);
  await git(project, ["add", "."]);
  await git(project, ["commit", "-m", "initial"]);

  let now = 100_000;
  let manager = new TurnContinuityManager(config, stateDir, { now: () => now });
  const firstIdentity = executionScopeIdentity({ "openai/session": "first-scope" });
  assert.ok(firstIdentity);
  const workspace = { id: "ws_first", root: project };
  const semantic: RecoveryCapsuleInput = {
    idempotencyKey: "capsule-clean-1",
    intent: "rolling",
    missionRef: "AOQ-R136",
    authorityOwnerRefs: ["owner:git-main", "owner:material-work"],
    authorityStateRefs: ["git-main:A", "material-work:g1"],
    currentFrontier: "prepare source checkpoint",
    currentCausalSlice: "bind source projection without self-reference",
    established: ["focused tests passed"],
    validationState: "passed",
    validationRefs: ["receipt:test"],
    worktreeState: "clean",
    effectState: "terminal",
    effectKeys: ["effect:one"],
    writerState: "released",
    retryPolicy: "forbidden",
    safeToMutate: true,
    safeToPublish: false,
    exactNextAction: "stage the source projection",
    doNotRepeat: ["do not retry effect:one"],
    unresolved: ["publication not performed"],
  };

  t.after(async () => {
    manager.close();
    await rm(root, { recursive: true, force: true });
  });

  const recorded = await manager.recordCapsule(firstIdentity, workspace, semantic);
  assert.equal(recorded.recorded, true);
  const replay = await manager.recordCapsule(firstIdentity, workspace, semantic);
  assert.equal(replay.recorded, false);
  assert.equal(replay.idempotentReplay, true);
  await assert.rejects(
    manager.recordCapsule(firstIdentity, workspace, {
      ...semantic,
      exactNextAction: "a different action under the same key",
    }),
    /idempotency key was already used for a different payload/i,
  );
  assert.equal(
    ((recorded.capsule as Record<string, unknown>).fingerprint as Record<string, unknown>).kind,
    "git",
  );
  const localOnly = await manager.capsuleStatus(firstIdentity, workspace);
  assert.equal(localOnly.workspaceFreshness, "fresh");
  assert.equal(localOnly.authorityFreshness, "unverified");
  assert.equal(localOnly.exactActionCandidateAvailable, false);
  assert.match(String(localOnly.recommendedAction), /Rehydrate and reconcile/i);

  const fresh = await manager.capsuleStatus(firstIdentity, workspace, {
    currentAuthorityStateRefs: ["material-work:g1", "git-main:A"],
  });
  assert.equal(fresh.workspaceFreshness, "fresh");
  assert.equal(fresh.authorityFreshness, "matched_supplied_refs");
  assert.equal(fresh.exactActionCandidateAvailable, true);
  assert.equal(
    fresh.exactActionReliance,
    "candidate_available_after_supplied_authority_match",
  );
  assert.match(String(fresh.recommendedAction), /stage the source projection/i);

  const canonicalStale = await manager.capsuleStatus(firstIdentity, workspace, {
    currentAuthorityStateRefs: ["material-work:g2", "git-main:B"],
  });
  assert.equal(canonicalStale.workspaceFreshness, "fresh");
  assert.equal(canonicalStale.authorityFreshness, "changed_from_recorded_refs");
  assert.equal(canonicalStale.exactActionCandidateAvailable, false);
  assert.match(String(canonicalStale.recommendedAction), /authoritative state changed elsewhere/i);

  now += 14 * 24 * 60 * 60 * 1_000;
  const timeAloneDoesNotStale = await manager.capsuleStatus(firstIdentity, workspace, {
    currentAuthorityStateRefs: ["git-main:A", "material-work:g1"],
  });
  assert.equal(timeAloneDoesNotStale.workspaceFreshness, "fresh");
  assert.equal(
    timeAloneDoesNotStale.authorityFreshness,
    "matched_supplied_refs",
  );

  await writeFile(join(project, "README.md"), "tracked change\n");
  const trackedStale = await manager.capsuleStatus(firstIdentity, workspace);
  assert.equal(trackedStale.workspaceFreshness, "stale");
  assert.equal(trackedStale.exactActionCandidateAvailable, false);
  assert.ok(
    (trackedStale.workspaceStaleReasons as string[]).includes("tracked_content_changed"),
  );

  now += 1_000;
  await manager.recordCapsule(firstIdentity, workspace, {
    ...semantic,
    idempotencyKey: "capsule-dirty-tracked-1",
    worktreeState: "intentional_dirty",
    exactNextAction: "run the focused test",
  });
  assert.equal(
    (await manager.capsuleStatus(firstIdentity, workspace)).workspaceFreshness,
    "fresh",
  );

  await writeFile(join(project, "scratch.txt"), "one\n");
  now += 1_000;
  await manager.recordCapsule(firstIdentity, workspace, {
    ...semantic,
    idempotencyKey: "capsule-dirty-untracked-1",
    worktreeState: "intentional_dirty",
    exactNextAction: "inspect the untracked scratch artifact",
  });
  await writeFile(join(project, "scratch.txt"), "two\n");
  const untrackedStale = await manager.capsuleStatus(firstIdentity, workspace);
  assert.equal(untrackedStale.workspaceFreshness, "stale");
  assert.ok(
    (untrackedStale.workspaceStaleReasons as string[]).includes("untracked_content_changed"),
  );

  await writeFile(join(project, "scratch.txt"), "one\n");
  const restoredFresh = await manager.capsuleStatus(firstIdentity, workspace);
  assert.equal(restoredFresh.workspaceFreshness, "fresh");
  manager.close();

  manager = new TurnContinuityManager(config, stateDir, { now: () => now + 1_000 });
  const secondIdentity = executionScopeIdentity({ "openai/session": "second-scope" });
  assert.ok(secondIdentity);
  const crossScope = await manager.capsuleStatus(
    secondIdentity,
    { id: "ws_second", root: project },
  );
  assert.equal(crossScope.available, true);
  assert.equal(crossScope.workspaceFreshness, "fresh");
  assert.equal(crossScope.authorityFreshness, "unverified");
  assert.equal(crossScope.exactActionCandidateAvailable, false);
  assert.equal(
    (crossScope.capsule as Record<string, unknown>).sameExecutionScope,
    false,
  );
  assert.match(String(crossScope.recommendedAction), /Rehydrate and reconcile/i);
});

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}
