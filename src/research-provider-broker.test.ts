import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import type { ZesResearchCycleConfig } from "./config.js";
import {
  type ResearchProviderProcessInvocation,
  type ResearchProviderProcessResult,
  ZesResearchProviderBroker,
} from "./research-provider-broker.js";
import {
  ResearchCycleError,
  type ResearchWorkspace,
  ZesResearchCycleManager,
} from "./research-cycle.js";

const execFileAsync = promisify(execFile);

interface Fixture {
  root: string;
  workspace: ResearchWorkspace;
  config: ZesResearchCycleConfig;
  manager: ZesResearchCycleManager;
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

async function fixture(t: TestContext): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "devspace-research-provider-"));
  const project = join(root, "project");
  await mkdir(join(project, "packages", "zes-control-kernel"), {
    recursive: true,
  });
  await mkdir(join(project, "src"), { recursive: true });
  await writeFile(
    join(project, "packages", "zes-control-kernel", "pyproject.toml"),
    "[project]\nname = \"zes-control-kernel\"\nversion = \"0.0.0\"\n",
  );
  await writeFile(join(project, "README.md"), "fixture\n");
  await git(project, ["init"]);
  await git(project, ["config", "user.email", "devspace@example.com"]);
  await git(project, ["config", "user.name", "DevSpace Test"]);
  await git(project, ["add", "."]);
  await git(project, ["commit", "-m", "Initial fixture"]);

  const config: ZesResearchCycleConfig = {
    mode: "enforce",
    repositoryRoot: project,
    stateRoot: join(root, "state"),
    timeoutMs: 10_000,
    trustedTraceRoots: [],
  };
  const workspace = { workspaceId: "ws_provider_fixture", root: project };
  const manager = new ZesResearchCycleManager(config);
  await manager.open(workspace, {
    taskRef: "task:provider-broker",
    materialDecisionRef: "decision:provider-broker",
    decisionBoundaryRef: "devspace.provider.evidence",
    decisionQuestion: "Which current external evidence changes this boundary?",
    candidatePathPrefixes: ["src"],
    researchEnvelopeHypothesis: "focused_research",
    researchQuestions: ["Which exact provider evidence is current?"],
    knownLocalEvidenceRefs: ["git:HEAD"],
    uncertainties: ["external currentness"],
    falsifier: "the provider route or exact source identity changes",
    reopenTrigger: "provider, source, scope, or HEAD changes",
    actorRef: "principal:devspace-test",
    ownerSeededFraming: false,
  });
  await manager.prepare(workspace, {
    pathPrefixes: ["src"],
    operationClasses: ["source_mutation"],
    evidenceRegimeRefs: ["evidence-regime:external-current"],
    sourceIdentityRefs: ["git:HEAD"],
  });
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, workspace, config, manager };
}

function argument(args: string[], name: string): string {
  const index = args.indexOf(name);
  assert.notEqual(index, -1, `missing ${name}`);
  const value = args[index + 1];
  assert.ok(value, `missing value for ${name}`);
  return value;
}

function fakeRunner(
  invocations: ResearchProviderProcessInvocation[],
): (invocation: ResearchProviderProcessInvocation) => Promise<
  ResearchProviderProcessResult
> {
  return async (invocation) => {
    invocations.push(invocation);
    if (invocation.args.includes("zes-accelerate")) {
      const receiptPath = argument(invocation.args, "--receipt");
      const provider = argument(invocation.args, "--provider");
      const operation = argument(invocation.args, "--operation");
      const routeKind = provider === "exa"
        ? "exa_open_world_research"
        : provider === "context7"
        ? "context7_upstream_documentation"
        : "targeted_web_search";
      const receipt = {
        schema_version: "zes.repository-execution-accelerator-receipt.v1",
        receipt_kind: "provider_invocation",
        passed: true,
        provider_exit_code: 0,
        provider_stderr_present: false,
        provider_semantic_or_effect_authority: false,
        research_admission_or_provider_selection_performed: false,
        state_effect_classification: "external_read_only_research_evidence",
        receipt_digest_sha256: "a".repeat(64),
        result: {
          schema_version: "zes.provider-invocation-result.v1",
          passed: true,
          provider,
          operation,
          provider_state: "available",
          failure_classification: null,
          no_retry_performed: true,
          research_evidence_route_kind: routeKind,
          secret_value_or_secret_digest_emitted: false,
        },
      };
      await writeFile(receiptPath, `${JSON.stringify(receipt)}\n`);
      await chmod(receiptPath, 0o600);
      return { exitCode: 0, stdout: JSON.stringify(receipt), stderr: "" };
    }

    const evidencePath = argument(invocation.args, "--evidence-output");
    const evidenceRef = argument(invocation.args, "--evidence-ref");
    const receiptPath = argument(invocation.args, "--provider-receipt");
    const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as {
      receipt_digest_sha256: string;
      result: { research_evidence_route_kind: string };
    };
    const evidence = {
      schema_version: "zes.research-provider-execution-evidence.v1",
      evidence_ref: evidenceRef,
      route_kind: receipt.result.research_evidence_route_kind,
      trace_source_ref:
        `trace:provider-invocation:${receipt.receipt_digest_sha256}`,
      owner_seeded_framing:
        argument(invocation.args, "--owner-seeded-framing") === "true",
    };
    await writeFile(evidencePath, `${JSON.stringify(evidence)}\n`);
    await chmod(evidencePath, 0o600);
    return { exitCode: 0, stdout: JSON.stringify(evidence), stderr: "" };
  };
}

test("Exa uses only the fixed service credential broker", async (t) => {
  const current = await fixture(t);
  const invocations: ResearchProviderProcessInvocation[] = [];
  const secret = "exa-test-secret-that-must-not-be-returned";
  const broker = new ZesResearchProviderBroker(
    current.config,
    current.manager,
    {
      processRunner: fakeRunner(invocations),
      parentEnvironment: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        EXA_API_KEY: secret,
      },
      uuid: () => "00000000-0000-4000-8000-000000000001",
    },
  );

  const result = await broker.invoke(
    current.workspace,
    "fresh_acquisition",
    {
      provider: "exa",
      operation: "search",
      query: "Find open-world competing recovery patterns",
      maxResults: 4,
    },
  );

  assert.equal(invocations.length, 2);
  assert.equal(invocations[0]?.env.EXA_API_KEY, secret);
  assert.equal(invocations[1]?.env.EXA_API_KEY, undefined);
  assert.equal(invocations[0]?.command, "uv");
  assert.equal(invocations[0]?.args.includes("--provider"), true);
  assert.equal(invocations[0]?.args.includes("exa"), true);
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.deepEqual(result.credentialHandle, {
    kind: "service_environment_handle",
    name: "EXA_API_KEY",
    present: true,
    secretValueOrDigestExposed: false,
  });
  const trace = result.providerTrace as { path: string; traceRef: string };
  const evidenceFile = result.evidenceFile as { path: string };
  assert.equal((await stat(trace.path)).mode & 0o777, 0o600);
  assert.equal((await stat(evidenceFile.path)).mode & 0o777, 0o600);
  assert.match(trace.traceRef, /^trace:provider-invocation:/u);
  assert.equal(
    (result.policy as Record<string, unknown>)
      .targetedWebSubstitutesForOpenWorldDiscovery,
    false,
  );
});

test("missing Exa service credential fails before process execution", async (t) => {
  const current = await fixture(t);
  const invocations: ResearchProviderProcessInvocation[] = [];
  const broker = new ZesResearchProviderBroker(
    current.config,
    current.manager,
    {
      processRunner: fakeRunner(invocations),
      parentEnvironment: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
      },
      uuid: () => "00000000-0000-4000-8000-000000000002",
    },
  );

  await assert.rejects(
    () => broker.invoke(
      current.workspace,
      "fresh_acquisition",
      {
        provider: "exa",
        operation: "search",
        query: "Find open-world candidates",
      },
    ),
    (error: unknown) => error instanceof ResearchCycleError
      && error.code === "RESEARCH_PROVIDER_CREDENTIAL_UNAVAILABLE",
  );
  assert.equal(invocations.length, 0);
});

test("targeted Web remains credentialless and explicitly non-open-world", async (t) => {
  const current = await fixture(t);
  const invocations: ResearchProviderProcessInvocation[] = [];
  const broker = new ZesResearchProviderBroker(
    current.config,
    current.manager,
    {
      processRunner: fakeRunner(invocations),
      parentEnvironment: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        EXA_API_KEY: "must-not-enter-targeted-web",
      },
      uuid: () => "00000000-0000-4000-8000-000000000003",
    },
  );

  const result = await broker.invoke(
    current.workspace,
    "currentness_or_delta_check",
    {
      provider: "web",
      operation: "fetch",
      query: "Read the already-named official release note",
      urls: ["https://example.test/releases/current"],
      targetKind: "official_source",
      knownSourceReason:
        "the exact publisher and official release document are already known",
    },
  );

  assert.equal(invocations[0]?.env.EXA_API_KEY, undefined);
  assert.equal(
    invocations[0]?.args.includes("--known-source-reason"),
    true,
  );
  assert.deepEqual(result.credentialHandle, {
    kind: "none",
    present: false,
    secretValueOrDigestExposed: false,
  });
  assert.equal(
    (result.policy as Record<string, unknown>)
      .targetedWebSubstitutesForOpenWorldDiscovery,
    false,
  );
});
