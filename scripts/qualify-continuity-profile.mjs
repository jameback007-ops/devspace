import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const FORBIDDEN_TOOLS = [
  "bash",
  "write",
  "edit",
  "workspace_close",
  "workspace_gc_execute",
  "self_repository_publication_preflight",
  "self_repository_publish",
  "local_agent_message_send",
  "execution_wake_execute",
  "codex_session_open",
  "codex_turn_control",
  "codex_session_control",
  "codex_approval_respond",
  "cross_executor_coordination_send",
  "zes_research_cycle_open",
  "zes_research_provider_invoke",
  "zes_research_instrument_execute",
];

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error(
        "Usage: node scripts/qualify-continuity-profile.mjs --probe <probe.json> --output <receipt.json>",
      );
    }
    values.set(key.slice(2), value);
  }
  const required = (name) => {
    const value = values.get(name)?.trim();
    if (!value) throw new Error(`Missing required --${name}`);
    return resolve(value);
  };
  return {
    probe: required("probe"),
    output: required("output"),
  };
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function atomicWrite(path, content) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, content, { encoding: "utf8", mode: 0o640 });
  await rename(temporary, path);
}

function assertBoolean(record, key, expected) {
  assert.equal(
    record[key],
    expected,
    `continuity operating contract ${key} must be ${expected}`,
  );
}

export function qualifyContinuityProbe(probe, probeBytes) {
  assert.ok(isRecord(probe), "probe must be an object");
  assert.equal(probe.schemaVersion, "zes.tool-surface-probe.v1");
  assert.ok(isRecord(probe.backend), "probe backend is missing");
  assert.equal(probe.backend.implementation, "devspace-continuity");
  assert.ok(isRecord(probe.configuration), "probe configuration is missing");
  assert.equal(probe.configuration.toolMode, "continuity");
  assert.ok(isRecord(probe.toolSurface), "probe tool surface is missing");
  assert.ok(Array.isArray(probe.toolSurface.toolNames));
  assert.match(String(probe.toolSurface.fingerprintSha256), /^[a-f0-9]{64}$/);
  assert.ok(isRecord(probe.continuityProfile), "continuity profile is missing");

  const profile = probe.continuityProfile;
  assert.equal(profile.schemaVersion, "devspace.continuity-profile.v1");
  assert.equal(profile.profileRef, "devspace.continuity-profile.v1");
  assert.equal(
    profile.policyRef,
    "policy:devspace:degraded-operational-continuity:v1",
  );
  assert.equal(profile.state, "ready");
  assert.ok(isRecord(profile.surface));
  assert.match(String(profile.surface.surfaceEpoch), /^continuity:/);
  assert.equal(
    profile.surface.fingerprintSha256,
    probe.toolSurface.fingerprintSha256,
  );
  assert.ok(Array.isArray(profile.surface.requiredTools));
  assert.deepEqual(profile.surface.missingRequiredTools, []);

  const names = new Set(probe.toolSurface.toolNames);
  for (const name of profile.surface.requiredTools) {
    assert.ok(names.has(name), `required continuity tool missing: ${name}`);
  }
  for (const name of FORBIDDEN_TOOLS) {
    assert.equal(names.has(name), false, `forbidden continuity tool present: ${name}`);
  }

  assert.ok(isRecord(profile.operatingContract));
  for (const key of [
    "primaryRepairFirst",
    "repairExhaustionRequiredBeforeMissionFallback",
    "operationScopedSelectionRequired",
    "exactSurfaceAttestationRequired",
    "deterministicFailbackRequired",
    "isolatedWorkspaceMutationPermitted",
    "processContinuationPermitted",
    "executorLocalCheckpointPermitted",
    "continuityLocalPeerHandoffPermitted",
  ]) {
    assertBoolean(profile.operatingContract, key, true);
  }
  for (const key of [
    "destructiveWorkspaceLifecyclePermitted",
    "freshResearchClaimPermitted",
    "repositoryPublicationPermitted",
    "runtimeDeploymentPermitted",
    "conversationEffectPermitted",
    "effectReplayPermitted",
  ]) {
    assertBoolean(profile.operatingContract, key, false);
  }

  assert.ok(isRecord(profile.authority));
  for (const key of [
    "canonicalTaskOrDecisionAuthority",
    "writerLeaseAuthority",
    "publicationAuthority",
    "runtimeActivationAuthority",
    "effectReplayAuthority",
  ]) {
    assertBoolean(profile.authority, key, false);
  }

  return {
    schemaVersion: "devspace.continuity-qualification.v1",
    generatedAt: new Date().toISOString(),
    outcome: "passed",
    probeDigestSha256: sha256(probeBytes),
    profileRef: profile.profileRef,
    policyRef: profile.policyRef,
    surfaceEpoch: profile.surface.surfaceEpoch,
    fingerprintSha256: profile.surface.fingerprintSha256,
    toolCount: probe.toolSurface.toolCount,
    requiredToolCount: profile.surface.requiredTools.length,
    forbiddenToolCount: FORBIDDEN_TOOLS.length,
    forbiddenToolsVerifiedAbsent: [...FORBIDDEN_TOOLS],
    authorityCeilingVerified: true,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const bytes = await readFile(options.probe);
  const probe = JSON.parse(bytes.toString("utf8"));
  const receipt = qualifyContinuityProbe(probe, bytes);
  await atomicWrite(options.output, `${JSON.stringify(receipt, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({
    outputPath: options.output,
    outcome: receipt.outcome,
    toolCount: receipt.toolCount,
    fingerprintSha256: receipt.fingerprintSha256,
    surfaceEpoch: receipt.surfaceEpoch,
  })}\n`);
}

if (process.argv[1]?.endsWith("qualify-continuity-profile.mjs")) {
  await main();
}
