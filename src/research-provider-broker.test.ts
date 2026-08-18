import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import type { ZesResearchCycleConfig } from "./config.js";
import {
  type ResearchProviderProcessInvocation,
  type ResearchProviderProcessResult,
  runFixedResearchProviderProcess,
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
      const routeKind = provider === "context7"
        ? "context7_upstream_documentation"
        : provider === "exa" && operation === "search"
        ? "exa_open_world_research"
        : "targeted_web_search";
      const routeRef = provider === "context7"
        ? "cli.context7"
        : provider === "exa"
        ? "plugin.hermes-web-exa:outer_Codex_supporting_controller_route"
        : "direct.targeted-web";
      const transport = provider === "context7"
        ? "pinned_cli"
        : provider === "exa"
        ? "streamable_http_mcp"
        : "pinned_https_fetch";
      const capabilityRefs = provider === "context7"
        ? ["capability:upstream-versioned-documentation:v1"]
        : provider === "exa" && operation === "search"
        ? ["capability:open-world-candidate-discovery:v1"]
        : ["capability:targeted-known-source-acquisition:v1"];
      const openWorldCandidateDiscoveryPerformed =
        provider === "exa" && operation === "search";
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
          route_ref: routeRef,
          transport,
          verified_capability_refs: capabilityRefs,
          open_world_candidate_discovery_performed:
            openWorldCandidateDiscoveryPerformed,
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
      result: {
        operation: string;
        research_evidence_route_kind: string;
        route_ref: string;
        verified_capability_refs: string[];
        open_world_candidate_discovery_performed: boolean;
      };
    };
    const evidence = {
      schema_version: "zes.research-provider-execution-evidence.v2",
      evidence_ref: evidenceRef,
      route_kind: receipt.result.research_evidence_route_kind,
      provider_route_ref: receipt.result.route_ref,
      provider_operation: receipt.result.operation,
      verified_capability_refs: receipt.result.verified_capability_refs,
      open_world_candidate_discovery_performed:
        receipt.result.open_world_candidate_discovery_performed,
      purpose: argument(invocation.args, "--purpose"),
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
  const providerReceipt = result.providerReceipt as {
    result: Record<string, unknown>;
  };
  const providerEvidence = result.providerEvidence as Record<string, unknown>;
  assert.equal(
    providerReceipt.result.research_evidence_route_kind,
    "exa_open_world_research",
  );
  assert.deepEqual(providerReceipt.result.verified_capability_refs, [
    "capability:open-world-candidate-discovery:v1",
  ]);
  assert.equal(
    providerReceipt.result.open_world_candidate_discovery_performed,
    true,
  );
  assert.equal(
    providerEvidence.schema_version,
    "zes.research-provider-execution-evidence.v2",
  );
  assert.equal(providerEvidence.provider_operation, "search");
  assert.deepEqual(providerEvidence.verified_capability_refs, [
    "capability:open-world-candidate-discovery:v1",
  ]);
  assert.equal(
    providerEvidence.open_world_candidate_discovery_performed,
    true,
  );
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

test("Exa fetch remains a known-source lane and cannot claim open-world discovery", async (t) => {
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
        EXA_API_KEY: "service-held",
      },
      uuid: () => "00000000-0000-4000-8000-00000000000a",
    },
  );

  const result = await broker.invoke(
    current.workspace,
    "currentness_or_delta_check",
    {
      provider: "exa",
      operation: "fetch",
      query: "Read the already-known candidate source",
      urls: ["https://example.test/known-candidate"],
    },
  );
  const receipt = result.providerReceipt as { result: Record<string, unknown> };
  const evidence = result.providerEvidence as Record<string, unknown>;
  assert.equal(receipt.result.research_evidence_route_kind, "targeted_web_search");
  assert.deepEqual(receipt.result.verified_capability_refs, [
    "capability:targeted-known-source-acquisition:v1",
  ]);
  assert.equal(receipt.result.open_world_candidate_discovery_performed, false);
  assert.equal(evidence.route_kind, "targeted_web_search");
  assert.equal(evidence.provider_operation, "fetch");
  assert.equal(evidence.open_world_candidate_discovery_performed, false);
  assert.equal(
    (result.policy as Record<string, unknown>)
      .exaFetchSubstitutesForOpenWorldDiscovery,
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
  const webReceipt = result.providerReceipt as {
    result: Record<string, unknown>;
  };
  const webEvidence = result.providerEvidence as Record<string, unknown>;
  assert.equal(
    webReceipt.result.research_evidence_route_kind,
    "targeted_web_search",
  );
  assert.deepEqual(webReceipt.result.verified_capability_refs, [
    "capability:targeted-known-source-acquisition:v1",
  ]);
  assert.equal(
    webReceipt.result.open_world_candidate_discovery_performed,
    false,
  );
  assert.equal(webEvidence.provider_operation, "fetch");
  assert.deepEqual(webEvidence.verified_capability_refs, [
    "capability:targeted-known-source-acquisition:v1",
  ]);
  assert.equal(
    webEvidence.open_world_candidate_discovery_performed,
    false,
  );
});

test("Context7 credential remains optional and broker-confined", async (t) => {
  const current = await fixture(t);
  const invocations: ResearchProviderProcessInvocation[] = [];
  const secret = "context7-test-secret-that-must-not-be-returned";
  const broker = new ZesResearchProviderBroker(
    current.config,
    current.manager,
    {
      processRunner: fakeRunner(invocations),
      parentEnvironment: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        CONTEXT7_API_KEY: secret,
      },
      uuid: () => "00000000-0000-4000-8000-000000000004",
    },
  );

  const result = await broker.invoke(
    current.workspace,
    "currentness_or_delta_check",
    {
      provider: "context7",
      operation: "resolve-library",
      query: "Resolve the exact upstream package identity",
      libraryName: "model-context-protocol",
    },
  );

  assert.equal(invocations[0]?.env.CONTEXT7_API_KEY, secret);
  assert.equal(invocations[1]?.env.CONTEXT7_API_KEY, undefined);
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.deepEqual(result.credentialHandle, {
    kind: "service_environment_handle",
    name: "CONTEXT7_API_KEY",
    present: true,
    secretValueOrDigestExposed: false,
  });
});

test("provider receipt identity cannot be substituted across routes", async (t) => {
  const current = await fixture(t);
  const invocations: ResearchProviderProcessInvocation[] = [];
  const baseRunner = fakeRunner(invocations);
  const runner = async (invocation: ResearchProviderProcessInvocation) => {
    const result = await baseRunner(invocation);
    if (invocation.args.includes("zes-accelerate")) {
      const receiptPath = argument(invocation.args, "--receipt");
      const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as {
        result: Record<string, unknown>;
      };
      receipt.result.provider = "web";
      receipt.result.research_evidence_route_kind = "targeted_web_search";
      await writeFile(receiptPath, `${JSON.stringify(receipt)}\n`);
      await chmod(receiptPath, 0o600);
    }
    return result;
  };
  const broker = new ZesResearchProviderBroker(
    current.config,
    current.manager,
    {
      processRunner: runner,
      parentEnvironment: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        EXA_API_KEY: "service-held",
      },
      uuid: () => "00000000-0000-4000-8000-000000000005",
    },
  );

  await assert.rejects(
    () => broker.invoke(
      current.workspace,
      "fresh_acquisition",
      {
        provider: "exa",
        operation: "search",
        query: "Find competing open-world evidence",
      },
    ),
    (error: unknown) => error instanceof ResearchCycleError
      && error.code === "RESEARCH_PROVIDER_RECEIPT_IDENTITY_MISMATCH",
  );
  assert.equal(invocations.length, 1);
});

test("provider receipt capability and operation proof cannot be laundered", async (t) => {
  const current = await fixture(t);
  for (const mutation of [
    (result: Record<string, unknown>) => {
      result.verified_capability_refs = [
        "capability:targeted-known-source-acquisition:v1",
      ];
    },
    (result: Record<string, unknown>) => {
      result.open_world_candidate_discovery_performed = false;
    },
  ]) {
    const invocations: ResearchProviderProcessInvocation[] = [];
    const baseRunner = fakeRunner(invocations);
    const runner = async (invocation: ResearchProviderProcessInvocation) => {
      const value = await baseRunner(invocation);
      if (invocation.args.includes("zes-accelerate")) {
        const receiptPath = argument(invocation.args, "--receipt");
        const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as {
          result: Record<string, unknown>;
        };
        mutation(receipt.result);
        await writeFile(receiptPath, `${JSON.stringify(receipt)}\n`);
        await chmod(receiptPath, 0o600);
      }
      return value;
    };
    const broker = new ZesResearchProviderBroker(
      current.config,
      current.manager,
      {
        processRunner: runner,
        parentEnvironment: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          EXA_API_KEY: "service-held",
        },
      },
    );
    await assert.rejects(
      () => broker.invoke(
        current.workspace,
        "fresh_acquisition",
        {
          provider: "exa",
          operation: "search",
          query: "Find competing open-world evidence",
        },
      ),
      (error: unknown) => error instanceof ResearchCycleError
        && error.code === "RESEARCH_PROVIDER_RECEIPT_IDENTITY_MISMATCH",
    );
  }
});

test("bound provider evidence must preserve the receipt operation capability and proof", async (t) => {
  const current = await fixture(t);
  const invocations: ResearchProviderProcessInvocation[] = [];
  const baseRunner = fakeRunner(invocations);
  const runner = async (invocation: ResearchProviderProcessInvocation) => {
    const value = await baseRunner(invocation);
    if (!invocation.args.includes("zes-accelerate")) {
      const evidencePath = argument(invocation.args, "--evidence-output");
      const evidence = JSON.parse(await readFile(evidencePath, "utf8")) as Record<
        string,
        unknown
      >;
      evidence.provider_operation = "fetch";
      evidence.verified_capability_refs = [
        "capability:targeted-known-source-acquisition:v1",
      ];
      evidence.open_world_candidate_discovery_performed = false;
      await writeFile(evidencePath, `${JSON.stringify(evidence)}\n`);
      await chmod(evidencePath, 0o600);
    }
    return value;
  };
  const broker = new ZesResearchProviderBroker(
    current.config,
    current.manager,
    {
      processRunner: runner,
      parentEnvironment: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        EXA_API_KEY: "service-held",
      },
      uuid: () => "00000000-0000-4000-8000-00000000000b",
    },
  );

  await assert.rejects(
    () => broker.invoke(
      current.workspace,
      "fresh_acquisition",
      {
        provider: "exa",
        operation: "search",
        query: "Find competing open-world evidence",
      },
    ),
    (error: unknown) => error instanceof ResearchCycleError
      && error.code === "RESEARCH_PROVIDER_BINDING_IDENTITY_MISMATCH",
  );
});

test("provider evidence paths must be fresh before process execution", async (t) => {
  const current = await fixture(t);
  const invocations: ResearchProviderProcessInvocation[] = [];
  const identity = "00000000000040008000000000000006";
  const context = await current.manager.providerEvidenceContext(current.workspace);
  const occupied = join(
    context.evidenceDirectory,
    `provider-receipt-${identity}.json`,
  );
  await writeFile(occupied, "{}\n", { mode: 0o600 });
  const broker = new ZesResearchProviderBroker(
    current.config,
    current.manager,
    {
      processRunner: fakeRunner(invocations),
      parentEnvironment: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        EXA_API_KEY: "service-held",
      },
      uuid: () => "00000000-0000-4000-8000-000000000006",
    },
  );

  await assert.rejects(
    () => broker.invoke(
      current.workspace,
      "fresh_acquisition",
      {
        provider: "exa",
        operation: "search",
        query: "Find open-world evidence",
      },
    ),
    (error: unknown) => error instanceof ResearchCycleError
      && error.code === "RESEARCH_PROVIDER_FILE_COLLISION",
  );
  assert.equal(invocations.length, 0);
});

test("provider receipt symlink substitution is rejected", async (t) => {
  const current = await fixture(t);
  const invocations: ResearchProviderProcessInvocation[] = [];
  const runner = async (invocation: ResearchProviderProcessInvocation) => {
    invocations.push(invocation);
    const receiptPath = argument(invocation.args, "--receipt");
    const backingPath = join(dirname(receiptPath), "receipt-backing.json");
    await writeFile(backingPath, "{}\n", { mode: 0o600 });
    await symlink(backingPath, receiptPath);
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  const broker = new ZesResearchProviderBroker(
    current.config,
    current.manager,
    {
      processRunner: runner,
      parentEnvironment: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        EXA_API_KEY: "service-held",
      },
      uuid: () => "00000000-0000-4000-8000-000000000007",
    },
  );

  await assert.rejects(
    () => broker.invoke(
      current.workspace,
      "fresh_acquisition",
      {
        provider: "exa",
        operation: "search",
        query: "Find open-world evidence",
      },
    ),
    (error: unknown) => error instanceof ResearchCycleError
      && error.code === "RESEARCH_PROVIDER_FILE_INVALID",
  );
});

test("missing receipt is typed and never returns captured secret output", async (t) => {
  const current = await fixture(t);
  const secret = "exa-secret-only-in-child-output";
  const broker = new ZesResearchProviderBroker(
    current.config,
    current.manager,
    {
      processRunner: async () => ({
        exitCode: 2,
        stdout: `provider output ${secret}`,
        stderr: `provider error ${secret}`,
      }),
      parentEnvironment: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        EXA_API_KEY: secret,
      },
      uuid: () => "00000000-0000-4000-8000-000000000008",
    },
  );

  await assert.rejects(
    () => broker.invoke(
      current.workspace,
      "fresh_acquisition",
      {
        provider: "exa",
        operation: "search",
        query: "Find open-world evidence",
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof ResearchCycleError);
      assert.equal(error.code, "RESEARCH_PROVIDER_RECEIPT_UNAVAILABLE");
      assert.equal(JSON.stringify(error.details).includes(secret), false);
      return true;
    },
  );
});

test("broker input bounds reject oversized provider requests before execution", async (t) => {
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
        EXA_API_KEY: "service-held",
      },
      uuid: () => "00000000-0000-4000-8000-000000000009",
    },
  );

  await assert.rejects(
    () => broker.invoke(
      current.workspace,
      "fresh_acquisition",
      {
        provider: "exa",
        operation: "search",
        query: "x".repeat(20_001),
      },
    ),
    (error: unknown) => error instanceof ResearchCycleError
      && error.code === "RESEARCH_PROVIDER_INPUT_INVALID",
  );
  await assert.rejects(
    () => broker.invoke(
      current.workspace,
      "fresh_acquisition",
      {
        provider: "exa",
        operation: "fetch",
        query: "Fetch exact open-world candidate evidence",
        urls: ["https://example.test/evidence"],
        maxCharacters: 20_001,
      },
    ),
    (error: unknown) => error instanceof ResearchCycleError
      && error.code === "RESEARCH_PROVIDER_INPUT_INVALID",
  );
  assert.equal(invocations.length, 0);
});

test("fixed provider timeout terminates its descendant process group", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX process-group assertion");
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "devspace-provider-timeout-"));
  const pidPath = join(root, "descendant.pid");
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = [
    "const { spawn } = require('node:child_process');",
    "const { writeFileSync } = require('node:fs');",
    "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
    "writeFileSync(process.argv[1], String(child.pid));",
    "setInterval(() => {}, 1000);",
  ].join(" ");

  await assert.rejects(
    () => runFixedResearchProviderProcess({
      command: process.execPath,
      args: ["-e", script, pidPath],
      cwd: root,
      env: { PATH: process.env.PATH ?? "" },
      timeoutMs: 150,
    }),
    (error: unknown) => error instanceof ResearchCycleError
      && error.code === "RESEARCH_PROVIDER_PROCESS_TIMEOUT",
  );

  const descendantPid = Number((await readFile(pidPath, "utf8")).trim());
  assert.ok(Number.isInteger(descendantPid) && descendantPid > 1);
  let alive = true;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      process.kill(descendantPid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") {
        alive = false;
        break;
      }
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(alive, false, "descendant process survived provider timeout");
});
