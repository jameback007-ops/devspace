import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  realpath,
  rm,
} from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import type { ZesResearchCycleConfig } from "./config.js";
import { terminateProcessTree } from "./process-platform.js";
import { processEnvironment } from "./process-sessions.js";
import {
  ResearchCycleError,
  type ResearchProviderEvidenceContext,
  type ResearchWorkspace,
  type ZesResearchCycleManager,
} from "./research-cycle.js";

const MAX_PROCESS_OUTPUT_BYTES = 2 * 1024 * 1024;
const PROVIDER_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_MAX_RESULTS = 8;
const DEFAULT_MAX_CHARACTERS = 12_000;
const MAX_QUERY_CHARACTERS = 20_000;
const MAX_PROVIDER_IDENTIFIER_CHARACTERS = 2_000;
const MAX_KNOWN_SOURCE_REASON_CHARACTERS = 4_000;
const MAX_URL_CHARACTERS = 8_192;
const MAX_EXA_FETCH_CHARACTERS = 20_000;
const MAX_TARGETED_WEB_CHARACTERS = 200_000;
const PROCESS_TERMINATION_GRACE_MS = 1_000;
const PROVIDER_CREDENTIALS = {
  context7: "CONTEXT7_API_KEY",
  exa: "EXA_API_KEY",
} as const;
const CAPABILITY_UPSTREAM_VERSIONED_DOCUMENTATION =
  "capability:upstream-versioned-documentation:v1";
const CAPABILITY_TARGETED_KNOWN_SOURCE_ACQUISITION =
  "capability:targeted-known-source-acquisition:v1";
const CAPABILITY_OPEN_WORLD_CANDIDATE_DISCOVERY =
  "capability:open-world-candidate-discovery:v1";

interface ResearchProviderOperationContract {
  routeKind:
    | "context7_upstream_documentation"
    | "targeted_web_search"
    | "exa_open_world_research";
  routeRef: string;
  transport: "pinned_cli" | "pinned_https_fetch" | "streamable_http_mcp";
  capabilityRefs: readonly string[];
  openWorldCandidateDiscoveryPerformed: boolean;
}

const RESEARCH_PROVIDER_OPERATION_CONTRACTS = {
  "context7:resolve-library": {
    routeKind: "context7_upstream_documentation",
    routeRef: "cli.context7",
    transport: "pinned_cli",
    capabilityRefs: [CAPABILITY_UPSTREAM_VERSIONED_DOCUMENTATION],
    openWorldCandidateDiscoveryPerformed: false,
  },
  "context7:docs": {
    routeKind: "context7_upstream_documentation",
    routeRef: "cli.context7",
    transport: "pinned_cli",
    capabilityRefs: [CAPABILITY_UPSTREAM_VERSIONED_DOCUMENTATION],
    openWorldCandidateDiscoveryPerformed: false,
  },
  "exa:search": {
    routeKind: "exa_open_world_research",
    routeRef: "plugin.hermes-web-exa:outer_Codex_supporting_controller_route",
    transport: "streamable_http_mcp",
    capabilityRefs: [CAPABILITY_OPEN_WORLD_CANDIDATE_DISCOVERY],
    openWorldCandidateDiscoveryPerformed: true,
  },
  "exa:fetch": {
    routeKind: "targeted_web_search",
    routeRef: "plugin.hermes-web-exa:outer_Codex_supporting_controller_route",
    transport: "streamable_http_mcp",
    capabilityRefs: [CAPABILITY_TARGETED_KNOWN_SOURCE_ACQUISITION],
    openWorldCandidateDiscoveryPerformed: false,
  },
  "web:fetch": {
    routeKind: "targeted_web_search",
    routeRef: "direct.targeted-web",
    transport: "pinned_https_fetch",
    capabilityRefs: [CAPABILITY_TARGETED_KNOWN_SOURCE_ACQUISITION],
    openWorldCandidateDiscoveryPerformed: false,
  },
} as const satisfies Record<string, ResearchProviderOperationContract>;

export const RESEARCH_PROVIDER_PURPOSES = [
  "fresh_acquisition",
  "currentness_or_delta_check",
  "counterevidence_or_blind_challenge",
] as const;

export type ResearchProviderPurpose =
  typeof RESEARCH_PROVIDER_PURPOSES[number];

export type ResearchProviderRequest =
  | {
      provider: "context7";
      operation: "resolve-library";
      query: string;
      libraryName: string;
    }
  | {
      provider: "context7";
      operation: "docs";
      query: string;
      libraryId: string;
    }
  | {
      provider: "exa";
      operation: "search";
      query: string;
      maxResults?: number;
    }
  | {
      provider: "exa";
      operation: "fetch";
      query: string;
      urls: string[];
      maxCharacters?: number;
    }
  | {
      provider: "web";
      operation: "fetch";
      query: string;
      urls: string[];
      targetKind: "exact_fact" | "named_document" | "official_source";
      knownSourceReason: string;
      maxCharacters?: number;
    };

export interface ResearchProviderProcessInvocation {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
}

export interface ResearchProviderProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type ResearchProviderProcessRunner = (
  invocation: ResearchProviderProcessInvocation,
) => Promise<ResearchProviderProcessResult>;

export interface ResearchProviderBrokerOptions {
  processRunner?: ResearchProviderProcessRunner;
  parentEnvironment?: NodeJS.ProcessEnv;
  uuid?: () => string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pathInside(path: string, root: string): boolean {
  const candidate = relative(resolve(root), resolve(path));
  return candidate === ""
    || (!candidate.startsWith("..") && !candidate.includes(`${sep}..${sep}`));
}

function boundedPositiveInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
  label: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > maximum) {
    throw new ResearchCycleError(
      "RESEARCH_PROVIDER_INPUT_INVALID",
      `${label} must be an integer between 1 and ${maximum}`,
    );
  }
  return resolved;
}

function requiredText(
  value: string,
  label: string,
  maxCharacters: number,
): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new ResearchCycleError(
      "RESEARCH_PROVIDER_INPUT_INVALID",
      `${label} is required`,
    );
  }
  if (normalized.includes("\0") || normalized.length > maxCharacters) {
    throw new ResearchCycleError(
      "RESEARCH_PROVIDER_INPUT_INVALID",
      `${label} exceeds its bounded text contract`,
      { maxCharacters },
    );
  }
  return normalized;
}

function parseJsonObject(value: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new ResearchCycleError(
      "RESEARCH_PROVIDER_OUTPUT_INVALID",
      `${label} is not valid JSON`,
    );
  }
  if (!isRecord(parsed)) {
    throw new ResearchCycleError(
      "RESEARCH_PROVIDER_OUTPUT_INVALID",
      `${label} is not an object`,
    );
  }
  return parsed;
}

async function readPrivateJsonFile(
  path: string,
  evidenceDirectory: string,
  label: string,
): Promise<{
  value: Record<string, unknown>;
  sha256: string;
  bytes: Buffer;
}> {
  const directory = await realpath(evidenceDirectory);
  const requestedPath = resolve(path);
  if (!pathInside(requestedPath, directory)) {
    throw new ResearchCycleError(
      "RESEARCH_PROVIDER_FILE_OUTSIDE_EVIDENCE_DIRECTORY",
      `${label} escaped the cycle evidence directory`,
    );
  }
  const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
  let handle;
  try {
    handle = await open(requestedPath, constants.O_RDONLY | noFollow);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new ResearchCycleError(
      code === "ENOENT"
        ? "RESEARCH_PROVIDER_FILE_UNAVAILABLE"
        : "RESEARCH_PROVIDER_FILE_INVALID",
      code === "ENOENT"
        ? `${label} was not produced`
        : `${label} could not be opened as a no-follow private file`,
      { errorCode: code },
    );
  }
  try {
    let metadata = await handle.stat();
    if (!metadata.isFile() || metadata.nlink !== 1) {
      throw new ResearchCycleError(
        "RESEARCH_PROVIDER_FILE_INVALID",
        `${label} must be one regular, unlinked file`,
      );
    }
    if (
      typeof process.getuid === "function"
      && metadata.uid !== process.getuid()
    ) {
      throw new ResearchCycleError(
        "RESEARCH_PROVIDER_FILE_INVALID",
        `${label} is not owned by the DevSpace service user`,
      );
    }
    if (metadata.size < 2 || metadata.size > MAX_PROCESS_OUTPUT_BYTES) {
      throw new ResearchCycleError(
        "RESEARCH_PROVIDER_FILE_INVALID",
        `${label} has an invalid bounded size`,
        { byteCount: metadata.size },
      );
    }
    if ((metadata.mode & 0o077) !== 0) {
      await handle.chmod(0o600);
      metadata = await handle.stat();
    }
    const bytes = await handle.readFile();
    const afterRead = await handle.stat();
    const pathMetadata = await lstat(requestedPath);
    const canonicalPath = await realpath(requestedPath);
    if (
      !pathInside(canonicalPath, directory)
      || pathMetadata.isSymbolicLink()
      || pathMetadata.dev !== afterRead.dev
      || pathMetadata.ino !== afterRead.ino
      || metadata.dev !== afterRead.dev
      || metadata.ino !== afterRead.ino
      || metadata.size !== afterRead.size
      || metadata.mtimeMs !== afterRead.mtimeMs
      || metadata.ctimeMs !== afterRead.ctimeMs
      || bytes.length !== afterRead.size
    ) {
      throw new ResearchCycleError(
        "RESEARCH_PROVIDER_FILE_CHANGED_DURING_READ",
        `${label} changed identity or content while being verified`,
      );
    }
    return {
      value: parseJsonObject(bytes.toString("utf8"), label),
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes,
    };
  } finally {
    await handle.close();
  }
}

async function providerReceiptStagingDirectory(
  repositoryRoot: string,
): Promise<string> {
  const canonicalRepositoryRoot = await realpath(repositoryRoot);
  const gitDirectory = resolve(canonicalRepositoryRoot, ".git");
  let gitMetadata;
  try {
    gitMetadata = await lstat(gitDirectory);
  } catch (error) {
    throw new ResearchCycleError(
      "RESEARCH_PROVIDER_STAGING_ROOT_UNAVAILABLE",
      "the fixed ZES repository has no private Git metadata directory for provider receipt staging",
      { errorCode: (error as NodeJS.ErrnoException).code },
    );
  }
  if (!gitMetadata.isDirectory() || gitMetadata.isSymbolicLink()) {
    throw new ResearchCycleError(
      "RESEARCH_PROVIDER_STAGING_ROOT_INVALID",
      "the fixed ZES repository Git metadata path is not one local directory",
    );
  }
  const stagingDirectory = resolve(
    gitDirectory,
    "devspace-research-provider-receipts",
  );
  try {
    await mkdir(stagingDirectory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw new ResearchCycleError(
        "RESEARCH_PROVIDER_STAGING_ROOT_UNAVAILABLE",
        "the private provider receipt staging directory could not be created",
        { errorCode: (error as NodeJS.ErrnoException).code },
      );
    }
  }
  let stagingMetadata = await lstat(stagingDirectory);
  if (!stagingMetadata.isDirectory() || stagingMetadata.isSymbolicLink()) {
    throw new ResearchCycleError(
      "RESEARCH_PROVIDER_STAGING_ROOT_INVALID",
      "the provider receipt staging path is not one local directory",
    );
  }
  const canonicalStagingDirectory = await realpath(stagingDirectory);
  if (!pathInside(canonicalStagingDirectory, canonicalRepositoryRoot)) {
    throw new ResearchCycleError(
      "RESEARCH_PROVIDER_STAGING_ROOT_INVALID",
      "the provider receipt staging directory escaped the fixed ZES repository",
    );
  }
  if (
    (
      typeof process.getuid === "function"
      && stagingMetadata.uid !== process.getuid()
    )
  ) {
    throw new ResearchCycleError(
      "RESEARCH_PROVIDER_STAGING_ROOT_INVALID",
      "the provider receipt staging directory is not service-owned",
    );
  }
  await chmod(canonicalStagingDirectory, 0o700);
  stagingMetadata = await lstat(canonicalStagingDirectory);
  if (
    !stagingMetadata.isDirectory()
    || stagingMetadata.isSymbolicLink()
    || (stagingMetadata.mode & 0o077) !== 0
  ) {
    throw new ResearchCycleError(
      "RESEARCH_PROVIDER_STAGING_ROOT_INVALID",
      "the provider receipt staging directory is not one private local directory",
    );
  }
  return canonicalStagingDirectory;
}

async function writePrivateJsonBytes(
  path: string,
  evidenceDirectory: string,
  bytes: Buffer,
  label: string,
): Promise<Awaited<ReturnType<typeof readPrivateJsonFile>>> {
  const directory = await realpath(evidenceDirectory);
  const requestedPath = resolve(path);
  if (!pathInside(requestedPath, directory)) {
    throw new ResearchCycleError(
      "RESEARCH_PROVIDER_FILE_OUTSIDE_EVIDENCE_DIRECTORY",
      `${label} escaped the cycle evidence directory`,
    );
  }
  const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
  let handle;
  let importError: unknown;
  try {
    handle = await open(
      requestedPath,
      constants.O_WRONLY
        | constants.O_CREAT
        | constants.O_EXCL
        | noFollow,
      0o600,
    );
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.chmod(0o600);
  } catch (error) {
    importError = error;
  } finally {
    await handle?.close();
  }
  if (importError !== undefined) {
    await rm(requestedPath, { force: true });
    throw new ResearchCycleError(
      "RESEARCH_PROVIDER_FILE_IMPORT_FAILED",
      `${label} could not be imported as one exclusive private file`,
      { errorCode: (importError as NodeJS.ErrnoException).code },
    );
  }
  try {
    return await readPrivateJsonFile(
      requestedPath,
      directory,
      label,
    );
  } catch (error) {
    await rm(requestedPath, { force: true });
    throw error;
  }
}

async function assertPathAbsent(path: string, label: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new ResearchCycleError(
    "RESEARCH_PROVIDER_FILE_COLLISION",
    `${label} already exists before provider execution`,
  );
}

function appendOutput(
  chunks: Buffer[],
  chunk: Buffer,
  byteState: { value: number },
): void {
  byteState.value += chunk.length;
  if (byteState.value > MAX_PROCESS_OUTPUT_BYTES) {
    throw new ResearchCycleError(
      "RESEARCH_PROVIDER_PROCESS_OUTPUT_LIMIT",
      "fixed provider process exceeded the bounded output limit",
    );
  }
  chunks.push(chunk);
}

export async function runFixedResearchProviderProcess(
  invocation: ResearchProviderProcessInvocation,
): Promise<ResearchProviderProcessResult> {
  return await new Promise((resolveResult, reject) => {
    const detached = process.platform !== "win32";
    const child = spawn(invocation.command, invocation.args, {
      cwd: invocation.cwd,
      env: invocation.env,
      detached,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const outputBytes = { value: 0 };
    let settled = false;
    let terminalError: unknown;
    let timer: NodeJS.Timeout | undefined;
    let forceTimer: NodeJS.Timeout | undefined;

    const terminate = (error: unknown) => {
      if (settled || terminalError !== undefined) return;
      terminalError = error;
      if (timer) clearTimeout(timer);
      try {
        terminateProcessTree(child, "SIGTERM", detached);
      } catch {
        // The close/error event below remains the terminal signal.
      }
      forceTimer = setTimeout(() => {
        try {
          terminateProcessTree(child, "SIGKILL", detached);
        } catch {
          // The process may already be gone.
        }
      }, PROCESS_TERMINATION_GRACE_MS);
    };
    timer = setTimeout(() => {
      terminate(new ResearchCycleError(
        "RESEARCH_PROVIDER_PROCESS_TIMEOUT",
        "fixed provider process timed out",
      ));
    }, invocation.timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      if (terminalError !== undefined) return;
      try {
        appendOutput(stdout, chunk, outputBytes);
      } catch (error) {
        terminate(error);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (terminalError !== undefined) return;
      try {
        appendOutput(stderr, chunk, outputBytes);
      } catch (error) {
        terminate(error);
      }
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      reject(new ResearchCycleError(
        "RESEARCH_PROVIDER_PROCESS_START_FAILED",
        "fixed provider process could not start",
        { errorName: error.name },
      ));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      if (terminalError !== undefined) {
        reject(terminalError);
        return;
      }
      resolveResult({
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

function sameEvidenceContext(
  left: ResearchProviderEvidenceContext,
  right: ResearchProviderEvidenceContext,
): boolean {
  return left.cycleRef === right.cycleRef
    && left.generation === right.generation
    && resolve(left.evidenceDirectory) === resolve(right.evidenceDirectory);
}

function providerCredentialEnvironment(
  request: ResearchProviderRequest,
  parentEnvironment: NodeJS.ProcessEnv,
): {
  env: Record<string, string>;
  credentialHandle: Record<string, unknown>;
} {
  const env = processEnvironment(undefined, parentEnvironment);
  if (request.provider === "web") {
    return {
      env,
      credentialHandle: {
        kind: "none",
        present: false,
        secretValueOrDigestExposed: false,
      },
    };
  }
  const name = PROVIDER_CREDENTIALS[request.provider];
  const value = parentEnvironment[name]?.trim();
  if (request.provider === "exa" && !value) {
    throw new ResearchCycleError(
      "RESEARCH_PROVIDER_CREDENTIAL_UNAVAILABLE",
      "the fixed Exa credential handle is unavailable to the DevSpace service",
      {
        provider: request.provider,
        credentialHandle: name,
        secretValueOrDigestExposed: false,
      },
    );
  }
  if (value) env[name] = value;
  return {
    env,
    credentialHandle: {
      kind: "service_environment_handle",
      name,
      present: Boolean(value),
      secretValueOrDigestExposed: false,
    },
  };
}

function providerArguments(
  request: ResearchProviderRequest,
): string[] {
  const query = requiredText(
    request.query,
    "query",
    MAX_QUERY_CHARACTERS,
  );
  const args = [
    "provider",
    "invoke",
    "--provider",
    request.provider,
    "--operation",
    request.operation,
    "--query",
    query,
    "--max-output-bytes",
    String(PROVIDER_OUTPUT_BYTES),
  ];
  if (request.provider === "context7") {
    if (request.operation === "resolve-library") {
      args.push(
        "--library-name",
        requiredText(
          request.libraryName,
          "libraryName",
          MAX_PROVIDER_IDENTIFIER_CHARACTERS,
        ),
      );
    } else {
      args.push(
        "--library-id",
        requiredText(
          request.libraryId,
          "libraryId",
          MAX_PROVIDER_IDENTIFIER_CHARACTERS,
        ),
      );
    }
  } else if (request.provider === "exa") {
    if (request.operation === "search") {
      args.push(
        "--max-results",
        String(boundedPositiveInteger(
          request.maxResults,
          DEFAULT_MAX_RESULTS,
          20,
          "maxResults",
        )),
      );
    } else {
      const urls = request.urls.map((url) => requiredText(
        url,
        "url",
        MAX_URL_CHARACTERS,
      ));
      if (urls.length < 1 || urls.length > 20) {
        throw new ResearchCycleError(
          "RESEARCH_PROVIDER_INPUT_INVALID",
          "Exa fetch requires between 1 and 20 URLs",
        );
      }
      for (const url of urls) args.push("--url", url);
      args.push(
        "--max-characters",
        String(boundedPositiveInteger(
          request.maxCharacters,
          DEFAULT_MAX_CHARACTERS,
          MAX_EXA_FETCH_CHARACTERS,
          "maxCharacters",
        )),
      );
    }
  } else {
    const urls = request.urls.map((url) => requiredText(
      url,
      "url",
      MAX_URL_CHARACTERS,
    ));
    if (urls.length < 1 || urls.length > 5) {
      throw new ResearchCycleError(
        "RESEARCH_PROVIDER_INPUT_INVALID",
        "targeted Web fetch requires between 1 and 5 URLs",
      );
    }
    for (const url of urls) args.push("--url", url);
    args.push(
      "--target-kind",
      request.targetKind,
      "--known-source-reason",
      requiredText(
        request.knownSourceReason,
        "knownSourceReason",
        MAX_KNOWN_SOURCE_REASON_CHARACTERS,
      ),
      "--max-characters",
      String(boundedPositiveInteger(
        request.maxCharacters,
        DEFAULT_MAX_CHARACTERS,
        MAX_TARGETED_WEB_CHARACTERS,
        "maxCharacters",
      )),
    );
  }
  return args;
}

function providerOperationContract(
  request: ResearchProviderRequest,
): ResearchProviderOperationContract {
  const key = `${request.provider}:${request.operation}`;
  const contract = RESEARCH_PROVIDER_OPERATION_CONTRACTS[
    key as keyof typeof RESEARCH_PROVIDER_OPERATION_CONTRACTS
  ];
  if (!contract) {
    throw new ResearchCycleError(
      "RESEARCH_PROVIDER_OPERATION_UNREGISTERED",
      "the requested provider operation has no fixed evidence contract",
      { provider: request.provider, operation: request.operation },
    );
  }
  return contract;
}

function exactStringArray(
  value: unknown,
  expected: readonly string[],
): boolean {
  return Array.isArray(value)
    && value.length === expected.length
    && value.every((item, index) => item === expected[index]);
}

function assertProviderReceiptIdentity(
  receipt: Record<string, unknown>,
  request: ResearchProviderRequest,
): Record<string, unknown> {
  const result = receipt.result;
  const expected = providerOperationContract(request);
  if (
    receipt.schema_version
      !== "zes.repository-execution-accelerator-receipt.v1"
    || receipt.receipt_kind !== "provider_invocation"
    || !isRecord(result)
    || result.schema_version !== "zes.provider-invocation-result.v1"
    || result.provider !== request.provider
    || result.operation !== request.operation
    || result.research_evidence_route_kind !== expected.routeKind
    || result.route_ref !== expected.routeRef
    || result.transport !== expected.transport
    || !exactStringArray(
      result.verified_capability_refs,
      expected.capabilityRefs,
    )
    || result.open_world_candidate_discovery_performed
      !== expected.openWorldCandidateDiscoveryPerformed
    || result.no_retry_performed !== true
    || result.secret_value_or_secret_digest_emitted !== false
  ) {
    throw new ResearchCycleError(
      "RESEARCH_PROVIDER_RECEIPT_IDENTITY_MISMATCH",
      "provider receipt does not match the fixed requested provider route",
      {
        requestedProvider: request.provider,
        requestedOperation: request.operation,
        expectedRoute: expected.routeKind,
        expectedRouteRef: expected.routeRef,
        expectedTransport: expected.transport,
        expectedCapabilityRefs: expected.capabilityRefs,
        expectedOpenWorldCandidateDiscoveryPerformed:
          expected.openWorldCandidateDiscoveryPerformed,
        secretValueOrDigestExposed: false,
      },
    );
  }
  return result;
}

export class ZesResearchProviderBroker {
  private readonly processRunner: ResearchProviderProcessRunner;
  private readonly parentEnvironment: NodeJS.ProcessEnv;
  private readonly uuid: () => string;

  constructor(
    private readonly config: ZesResearchCycleConfig,
    private readonly manager: ZesResearchCycleManager,
    options: ResearchProviderBrokerOptions = {},
  ) {
    this.processRunner = options.processRunner ?? runFixedResearchProviderProcess;
    this.parentEnvironment = options.parentEnvironment ?? process.env;
    this.uuid = options.uuid ?? randomUUID;
  }

  async invoke(
    workspace: ResearchWorkspace,
    purpose: ResearchProviderPurpose,
    request: ResearchProviderRequest,
  ): Promise<Record<string, unknown>> {
    if (!RESEARCH_PROVIDER_PURPOSES.includes(purpose)) {
      throw new ResearchCycleError(
        "RESEARCH_PROVIDER_PURPOSE_INVALID",
        "unsupported provider evidence purpose",
      );
    }
    const context = await this.manager.providerEvidenceContext(workspace);
    const evidenceDirectory = await realpath(context.evidenceDirectory);
    const identity = this.uuid().replaceAll("-", "").toLowerCase();
    if (!/^[0-9a-f]{32}$/u.test(identity)) {
      throw new ResearchCycleError(
        "RESEARCH_PROVIDER_IDENTITY_INVALID",
        "provider evidence identity generator returned an invalid value",
      );
    }
    const receiptPath = resolve(
      evidenceDirectory,
      `provider-receipt-${identity}.json`,
    );
    const stagingDirectory = await providerReceiptStagingDirectory(
      this.config.repositoryRoot,
    );
    const stagingReceiptPath = resolve(
      stagingDirectory,
      `provider-receipt-${identity}.json`,
    );
    const evidencePath = resolve(
      evidenceDirectory,
      `provider-evidence-${identity}.json`,
    );
    const evidenceRef = `provider-evidence:${request.provider}:${identity}`;
    await Promise.all([
      assertPathAbsent(receiptPath, "provider receipt path"),
      assertPathAbsent(stagingReceiptPath, "provider staging receipt path"),
      assertPathAbsent(evidencePath, "provider evidence path"),
    ]);
    const timeoutSeconds = Math.max(
      1,
      Math.min(180, Math.floor(this.config.timeoutMs / 1_000)),
    );
    const credential = providerCredentialEnvironment(
      request,
      this.parentEnvironment,
    );
    const acceleratorArgs = [
      "run",
      "--frozen",
      "--directory",
      this.config.repositoryRoot,
      "--package",
      "zes-build-runner",
      "zes-accelerate",
      "--receipt",
      stagingReceiptPath,
      ...providerArguments(request),
      "--timeout-seconds",
      String(timeoutSeconds),
    ];

    const providerResult = await this.processRunner({
      command: "uv",
      args: acceleratorArgs,
      cwd: this.config.repositoryRoot,
      env: credential.env,
      timeoutMs: this.config.timeoutMs,
    });
    let providerReceipt: Awaited<ReturnType<typeof readPrivateJsonFile>>;
    try {
      const stagedProviderReceipt = await readPrivateJsonFile(
        stagingReceiptPath,
        stagingDirectory,
        "provider staging receipt",
      );
      providerReceipt = await writePrivateJsonBytes(
        receiptPath,
        evidenceDirectory,
        stagedProviderReceipt.bytes,
        "provider receipt",
      );
      if (providerReceipt.sha256 !== stagedProviderReceipt.sha256) {
        await rm(receiptPath, { force: true });
        throw new ResearchCycleError(
          "RESEARCH_PROVIDER_FILE_IMPORT_MISMATCH",
          "the cycle-private provider receipt does not match the fixed accelerator receipt bytes",
        );
      }
    } catch (error) {
      if (
        error instanceof ResearchCycleError
        && error.code === "RESEARCH_PROVIDER_FILE_UNAVAILABLE"
      ) {
        throw new ResearchCycleError(
          "RESEARCH_PROVIDER_RECEIPT_UNAVAILABLE",
          "the fixed provider route terminated without a verifiable receipt",
          {
            provider: request.provider,
            operation: request.operation,
            providerExitCode: providerResult.exitCode,
            stdoutPresent: providerResult.stdout.length > 0,
            stderrPresent: providerResult.stderr.length > 0,
            capturedOutputByteCount: Buffer.byteLength(
              providerResult.stdout + providerResult.stderr,
            ),
            credentialHandle: credential.credentialHandle,
            secretValueOrDigestExposed: false,
          },
        );
      }
      throw error;
    } finally {
      await rm(stagingReceiptPath, { force: true });
    }
    const providerPayload = assertProviderReceiptIdentity(
      providerReceipt.value,
      request,
    );
    if (
      providerResult.exitCode !== 0
      || providerReceipt.value.passed !== true
      || providerPayload.passed !== true
    ) {
      throw new ResearchCycleError(
        "RESEARCH_PROVIDER_INVOCATION_HELD",
        "the fixed provider route did not produce admissible evidence",
        {
          provider: request.provider,
          operation: request.operation,
          providerState: providerPayload.provider_state,
          failureClassification: providerPayload.failure_classification,
          noRetryPerformed: providerPayload.no_retry_performed,
          receiptDigestSha256: providerReceipt.value.receipt_digest_sha256,
          receiptFileSha256: providerReceipt.sha256,
          credentialHandle: credential.credentialHandle,
          secretValueOrDigestExposed: false,
        },
      );
    }

    const bindResult = await this.processRunner({
      command: "uv",
      args: [
        "run",
        "--frozen",
        "--directory",
        this.config.repositoryRoot,
        "--package",
        "zes-control-kernel",
        "zes-research-reflex",
        "bind-provider-evidence",
        "--provider-receipt",
        receiptPath,
        "--evidence-output",
        evidencePath,
        "--evidence-ref",
        evidenceRef,
        "--purpose",
        purpose,
        "--owner-seeded-framing",
        String(context.ownerSeededFraming),
      ],
      cwd: this.config.repositoryRoot,
      env: processEnvironment(undefined, this.parentEnvironment),
      timeoutMs: this.config.timeoutMs,
    });
    if (bindResult.exitCode !== 0) {
      await rm(evidencePath, { force: true });
      throw new ResearchCycleError(
        "RESEARCH_PROVIDER_BINDING_FAILED",
        "native Research Reflex provider evidence binding failed",
        {
          provider: request.provider,
          operation: request.operation,
          exitCode: bindResult.exitCode,
          providerReceiptFileSha256: providerReceipt.sha256,
        },
      );
    }
    const providerEvidence = await readPrivateJsonFile(
      evidencePath,
      evidenceDirectory,
      "provider evidence",
    );
    const traceRef = providerEvidence.value.trace_source_ref;
    const expected = providerOperationContract(request);
    if (
      providerEvidence.value.schema_version
        !== "zes.research-provider-execution-evidence.v2"
      || providerEvidence.value.evidence_ref !== evidenceRef
      || providerEvidence.value.route_kind !== expected.routeKind
      || providerEvidence.value.provider_route_ref !== expected.routeRef
      || providerEvidence.value.provider_operation !== request.operation
      || !exactStringArray(
        providerEvidence.value.verified_capability_refs,
        expected.capabilityRefs,
      )
      || providerEvidence.value.open_world_candidate_discovery_performed
        !== expected.openWorldCandidateDiscoveryPerformed
      || providerEvidence.value.purpose !== purpose
      || providerEvidence.value.owner_seeded_framing
        !== context.ownerSeededFraming
      || typeof traceRef !== "string"
      || !traceRef
    ) {
      await Promise.all([
        rm(receiptPath, { force: true }),
        rm(evidencePath, { force: true }),
      ]);
      throw new ResearchCycleError(
        "RESEARCH_PROVIDER_BINDING_IDENTITY_MISMATCH",
        "bound provider evidence does not match the active research cycle",
      );
    }
    const currentContext = await this.manager.providerEvidenceContext(workspace);
    if (!sameEvidenceContext(context, currentContext)) {
      await Promise.all([
        rm(receiptPath, { force: true }),
        rm(evidencePath, { force: true }),
      ]);
      throw new ResearchCycleError(
        "RESEARCH_PROVIDER_CONTEXT_CHANGED",
        "the prepared research generation changed during provider acquisition",
      );
    }

    return {
      status: "acquired",
      cycleRef: context.cycleRef,
      generation: context.generation,
      taskRef: context.taskRef,
      materialDecisionRef: context.materialDecisionRef,
      decisionBoundaryRef: context.decisionBoundaryRef,
      provider: request.provider,
      operation: request.operation,
      purpose,
      credentialHandle: credential.credentialHandle,
      providerReceipt: providerReceipt.value,
      providerReceiptFileSha256: providerReceipt.sha256,
      providerEvidence: providerEvidence.value,
      providerEvidenceFileSha256: providerEvidence.sha256,
      providerTrace: {
        traceRef,
        path: receiptPath,
      },
      evidenceFile: {
        path: evidencePath,
        sha256: providerEvidence.sha256,
      },
      policy: {
        fixedProviderFacade: true,
        arbitraryCommandAccepted: false,
        arbitraryProviderEndpointAccepted: false,
        arbitraryCredentialAccepted: false,
        serviceCredentialValueOrDigestExposed: false,
        providerSelectionOrResearchSufficiencyPerformed: false,
        targetedWebSubstitutesForOpenWorldDiscovery: false,
        exaFetchSubstitutesForOpenWorldDiscovery: false,
        providerOperationRouteAndCapabilityReceiptBound: true,
        openWorldCandidateDiscoveryProofRequired: true,
        acceleratorReceiptStagedUnderFixedRepositoryMetadata: true,
        cyclePrivateReceiptImportedByteExact: true,
        acceleratorStagingReceiptRetained: false,
        automaticRetryPerformed: false,
        semanticMutationPublicationRuntimeOrEffectAuthorityGranted: false,
      },
    };
  }
}
