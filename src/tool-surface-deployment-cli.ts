import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "./config.js";
import { SupervisedMcpClient } from "./mcp-transport-supervisor-client.js";
import { McpTransportSupervisor } from "./mcp-transport-supervisor.js";
import { createReviewCheckpointManager } from "./review-checkpoints.js";
import { ProcessSessionManager } from "./process-sessions.js";
import { RuntimeCapabilityRegistry } from "./runtime-capabilities.js";
import { createMcpServer } from "./server.js";
import {
  DEPLOYMENT_MANIFEST_SCHEMA,
  canonicalJson,
  createToolSurfaceIdentity,
  observeFileIdentity,
  observePathIdentity,
  validateDeploymentManifest,
  type ExpectedNativeMcpIdentity,
  type McpToolDescriptor,
} from "./tool-surface-freshness.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";
import { WorkspaceRegistry } from "./workspaces.js";

const FRESHNESS_ENV_KEYS = [
  "DEVSPACE_TOOL_SURFACE_MANIFEST",
  "DEVSPACE_TOOL_SURFACE_MANIFEST_SHA256",
  "DEVSPACE_TOOL_SURFACE_SOURCE_COMMIT",
  "DEVSPACE_TOOL_SURFACE_SOURCE_TREE",
  "DEVSPACE_TOOL_SURFACE_BUILD_ARTIFACT",
  "DEVSPACE_TOOL_SURFACE_EPOCH",
  "DEVSPACE_ACCELERATOR_PROFILE",
  "DEVSPACE_ACCELERATOR_PROFILE_REF",
  "DEVSPACE_NATIVE_MCP_RUNTIME_IDENTITIES",
  "DEVSPACE_WORKSPACE_SYSTEM_INDEX_PATHS",
] as const;

const DEFAULT_REQUIRED_CLIENT_TOOLS = [
  "execution_scope_list",
  "execution_scope_status",
  "open_workspace",
  "read",
  "exec_command",
  "skill_search",
];

interface ManifestOptions {
  probe: string;
  output: string;
  sourceCommit: string;
  sourceTree: string;
  buildArtifact: string;
  surfaceEpoch: string;
  acceleratorProfile?: string;
  acceleratorProfileRef?: string;
  nativeMcps?: string;
  requiredClientTools: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, content, { encoding: "utf8", mode: 0o640 });
  await rename(temporary, path);
}

function parseProbeOutputPath(argv: string[]): string {
  const outputIndex = argv.indexOf("--output");
  if (outputIndex < 0 || outputIndex + 1 >= argv.length) {
    throw new Error("Usage: npm run tool-surface:probe -- --output <probe.json>");
  }
  return resolve(argv[outputIndex + 1]);
}

function parseManifestArgs(argv: string[]): ManifestOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error("Every argument must be a --name value pair");
    }
    values.set(key.slice(2), value);
  }
  const required = (name: string): string => {
    const value = values.get(name)?.trim();
    if (!value) throw new Error(`Missing required --${name}`);
    return value;
  };
  const requiredClientTools = (values.get("required-client-tools")
    ?.split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)) ?? DEFAULT_REQUIRED_CLIENT_TOOLS;
  return {
    probe: resolve(required("probe")),
    output: resolve(required("output")),
    sourceCommit: required("source-commit"),
    sourceTree: required("source-tree"),
    buildArtifact: resolve(required("build-artifact")),
    surfaceEpoch: required("surface-epoch"),
    acceleratorProfile: values.get("accelerator-profile")
      ? resolve(values.get("accelerator-profile")!)
      : undefined,
    acceleratorProfileRef: values.get("accelerator-profile-ref"),
    nativeMcps: values.get("native-mcps")
      ? resolve(values.get("native-mcps")!)
      : undefined,
    requiredClientTools,
  };
}

async function readNativeMcps(
  path: string | undefined,
): Promise<ExpectedNativeMcpIdentity[]> {
  if (!path) return [];
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!Array.isArray(parsed)) {
    throw new Error("--native-mcps must contain a JSON array");
  }
  return parsed as ExpectedNativeMcpIdentity[];
}

export async function probeToolSurface(argv: string[]): Promise<void> {
  const outputPath = parseProbeOutputPath(argv);
  const root = await mkdtemp(join(tmpdir(), "devspace-tool-surface-probe-"));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DEVSPACE_CONFIG_DIR: join(root, "config"),
    DEVSPACE_STATE_DIR: join(root, "state"),
    DEVSPACE_WORKTREE_ROOT: join(root, "worktrees"),
    DEVSPACE_ALLOWED_ROOTS:
      process.env.DEVSPACE_ALLOWED_ROOTS ?? process.cwd(),
    DEVSPACE_OAUTH_OWNER_TOKEN:
      process.env.DEVSPACE_OAUTH_OWNER_TOKEN
      ?? "tool-surface-probe-owner-token-not-used-for-network-access",
    PORT: "1",
  };
  for (const key of FRESHNESS_ENV_KEYS) delete env[key];

  const config = loadConfig(env);
  const store = new SqliteWorkspaceStore(config.stateDir);
  const workspaces = new WorkspaceRegistry(config, store);
  const processes = new ProcessSessionManager();
  const runtimeCapabilities = new RuntimeCapabilityRegistry(config, {
    instanceRef: "tool-surface-probe",
  });
  const server = createMcpServer(
    config,
    workspaces,
    createReviewCheckpointManager(),
    processes,
    [],
    [],
    undefined,
    undefined,
    undefined,
    undefined,
    runtimeCapabilities,
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "zes-tool-surface-probe", version: "1" });
  const transportSupervisor = new McpTransportSupervisor({
    retryPolicy: {
      maxAttempts: 2,
      perAttemptTimeoutMs: 10_000,
      initialDelayMs: 100,
      maxDelayMs: 500,
      growFactor: 2,
      jitterRatio: 0.2,
      reconnectMaxAttempts: 1,
      reconciliationMaxAttempts: 1,
      recoveryActionTimeoutMs: 5_000,
    },
  });
  const supervisedClient = new SupervisedMcpClient(
    client,
    transportSupervisor,
    {
      backendRef: "tool-surface-probe",
      transportIdentity: {
        endpointRef: "in-memory://tool-surface-probe",
        protocolEra: "modern",
        backendGenerationRef: "tool-surface-probe",
      },
      operationPrefix: "tool-surface-probe",
      defaultTimeoutMs: 10_000,
    },
  );

  try {
    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport),
    ]);
    const listedResult = await supervisedClient.listTools(undefined, {
      operationKey: "complete-tools-list",
    });
    if (!listedResult.ok || !listedResult.value) {
      throw new Error(
        `Supervised MCP tools/list failed in state ${listedResult.state}: ${listedResult.action}`,
      );
    }
    const listed = listedResult.value;
    assert.equal(
      canonicalJson(runtimeCapabilities.descriptors()),
      canonicalJson(listed.tools),
      "Runtime registry descriptors differ from the SDK tools/list response",
    );
    const toolSurface = createToolSurfaceIdentity(listed.tools);
    const runtime = runtimeCapabilities.snapshot();
    const backend = runtime.backend as Record<string, unknown>;
    const registeredSurface = runtime.toolSurface as Record<string, unknown>;
    assert.equal(registeredSurface.fingerprintSha256, toolSurface.fingerprintSha256);

    const envelope = {
      schemaVersion: "zes.tool-surface-probe.v1",
      generatedAt: new Date().toISOString(),
      serverInfo: client.getServerVersion(),
      backend: {
        implementation: backend.implementation,
        packageVersion: backend.packageVersion,
        mcpServerVersion: backend.mcpServerVersion,
      },
      configuration: registeredSurface.configuration,
      continuityProfile: runtime.continuityProfile,
      transportReliability: {
        state: listedResult.state,
        attemptCount: listedResult.attemptCount,
        retryCount: listedResult.retryCount,
        recoveryReceipt: listedResult.recoveryReceipt,
        metrics: transportSupervisor.metrics(),
      },
      toolSurface,
      tools: listed.tools,
    };
    await atomicWrite(outputPath, `${JSON.stringify(envelope, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify({
      outputPath,
      mcpServerVersion: envelope.backend.mcpServerVersion,
      toolCount: toolSurface.toolCount,
      fingerprintSha256: toolSurface.fingerprintSha256,
    })}\n`);
  } finally {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
    processes.shutdown();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
}

export async function generateDeploymentManifest(argv: string[]): Promise<void> {
  const options = parseManifestArgs(argv);
  const probe: unknown = JSON.parse(await readFile(options.probe, "utf8"));
  if (!isRecord(probe) || probe.schemaVersion !== "zes.tool-surface-probe.v1") {
    throw new Error("Unsupported or invalid tool-surface probe envelope");
  }
  if (!Array.isArray(probe.tools)) {
    throw new Error("Probe envelope has no tools array");
  }
  const toolSurface = createToolSurfaceIdentity(
    probe.tools as McpToolDescriptor[],
  );
  const probedIdentity = isRecord(probe.toolSurface)
    ? probe.toolSurface
    : undefined;
  if (probedIdentity?.fingerprintSha256 !== toolSurface.fingerprintSha256) {
    throw new Error("Probe fingerprint does not match its complete tools/list descriptors");
  }
  const backend = isRecord(probe.backend) ? probe.backend : {};
  const packageVersion = backend.packageVersion;
  const mcpServerVersion = backend.mcpServerVersion;
  if (typeof packageVersion !== "string" || typeof mcpServerVersion !== "string") {
    throw new Error("Probe envelope lacks package or MCP server version");
  }

  const buildArtifact = await observePathIdentity(
    options.buildArtifact,
    `build-artifact:${options.buildArtifact}`,
  );
  const acceleratorProfile = options.acceleratorProfile
    ? await observeFileIdentity(
        options.acceleratorProfile,
        options.acceleratorProfileRef ?? options.acceleratorProfile,
      )
    : undefined;
  const manifest = validateDeploymentManifest({
    schemaVersion: DEPLOYMENT_MANIFEST_SCHEMA,
    generatedAt: new Date().toISOString(),
    surfaceEpoch: options.surfaceEpoch,
    build: {
      sourceCommit: options.sourceCommit,
      sourceTree: options.sourceTree,
      buildArtifactDigestSha256: buildArtifact.digestSha256,
      packageVersion,
      mcpServerVersion,
    },
    toolSurface,
    acceleratorProfile,
    nativeMcps: await readNativeMcps(options.nativeMcps),
    requiredClientTools: options.requiredClientTools,
  });
  const bytes = `${JSON.stringify(manifest, null, 2)}\n`;
  const digestSha256 = createHash("sha256").update(bytes).digest("hex");
  await atomicWrite(options.output, bytes);
  await atomicWrite(
    `${options.output}.sha256`,
    `${digestSha256}  ${basename(options.output)}\n`,
  );
  process.stdout.write(`${JSON.stringify({
    outputPath: options.output,
    digestSha256,
    sourceCommit: options.sourceCommit,
    sourceTree: options.sourceTree,
    buildArtifactDigestSha256: buildArtifact.digestSha256,
    toolCount: toolSurface.toolCount,
    fingerprintSha256: toolSurface.fingerprintSha256,
    surfaceEpoch: options.surfaceEpoch,
  })}\n`);
}
