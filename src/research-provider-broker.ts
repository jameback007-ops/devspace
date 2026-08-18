import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  chmod,
  lstat,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import type { ZesResearchCycleConfig } from "./config.js";
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
const PROVIDER_CREDENTIALS = {
  context7: "CONTEXT7_API_KEY",
  exa: "EXA_API_KEY",
} as const;

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

function requiredText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new ResearchCycleError(
      "RESEARCH_PROVIDER_INPUT_INVALID",
      `${label} is required`,
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

async function sha256File(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function readPrivateJsonFile(
  path: string,
  evidenceDirectory: string,
  label: string,
): Promise<{ value: Record<string, unknown>; sha256: string }> {
  const originalMetadata = await lstat(path);
  if (originalMetadata.isSymbolicLink()) {
    throw new ResearchCycleError(
      "RESEARCH_PROVIDER_FILE_INVALID",
      `${label} cannot be a symbolic link`,
    );
  }
  const directory = await realpath(evidenceDirectory);
  const file = await realpath(path);
  if (!pathInside(file, directory)) {
    throw new ResearchCycleError(
      "RESEARCH_PROVIDER_FILE_OUTSIDE_EVIDENCE_DIRECTORY",
      `${label} escaped the cycle evidence directory`,
    );
  }
  const metadata = await lstat(file);
  if (!metadata.isFile()) {
    throw new ResearchCycleError(
      "RESEARCH_PROVIDER_FILE_INVALID",
      `${label} is not a regular file`,
    );
  }
  if (metadata.size < 2 || metadata.size > MAX_PROCESS_OUTPUT_BYTES) {
    throw new ResearchCycleError(
      "RESEARCH_PROVIDER_FILE_INVALID",
      `${label} has an invalid bounded size`,
      { byteCount: metadata.size },
    );
  }
  await chmod(file, 0o600);
  const bytes = await readFile(file);
  return {
    value: parseJsonObject(bytes.toString("utf8"), label),
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
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

async function runFixedProcess(
  invocation: ResearchProviderProcessInvocation,
): Promise<ResearchProviderProcessResult> {
  return await new Promise((resolveResult, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd: invocation.cwd,
      env: invocation.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const outputBytes = { value: 0 };
    let settled = false;
    const settleError = (error: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGTERM");
      reject(error);
    };
    const timer = setTimeout(() => {
      settleError(new ResearchCycleError(
        "RESEARCH_PROVIDER_PROCESS_TIMEOUT",
        "fixed provider process timed out",
      ));
    }, invocation.timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      try {
        appendOutput(stdout, chunk, outputBytes);
      } catch (error) {
        settleError(error);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      try {
        appendOutput(stderr, chunk, outputBytes);
      } catch (error) {
        settleError(error);
      }
    });
    child.on("error", (error) => {
      settleError(new ResearchCycleError(
        "RESEARCH_PROVIDER_PROCESS_START_FAILED",
        "fixed provider process could not start",
        { errorName: error.name },
      ));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
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
  const query = requiredText(request.query, "query");
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
        requiredText(request.libraryName, "libraryName"),
      );
    } else {
      args.push(
        "--library-id",
        requiredText(request.libraryId, "libraryId"),
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
      const urls = request.urls.map((url) => requiredText(url, "url"));
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
          200_000,
          "maxCharacters",
        )),
      );
    }
  } else {
    const urls = request.urls.map((url) => requiredText(url, "url"));
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
      requiredText(request.knownSourceReason, "knownSourceReason"),
      "--max-characters",
      String(boundedPositiveInteger(
        request.maxCharacters,
        DEFAULT_MAX_CHARACTERS,
        200_000,
        "maxCharacters",
      )),
    );
  }
  return args;
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
    this.processRunner = options.processRunner ?? runFixedProcess;
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
    const evidencePath = resolve(
      evidenceDirectory,
      `provider-evidence-${identity}.json`,
    );
    const evidenceRef = `provider-evidence:${request.provider}:${identity}`;
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
      receiptPath,
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
    const providerReceipt = await readPrivateJsonFile(
      receiptPath,
      evidenceDirectory,
      "provider receipt",
    );
    const providerPayload = isRecord(providerReceipt.value.result)
      ? providerReceipt.value.result
      : {};
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
    if (
      providerEvidence.value.schema_version
        !== "zes.research-provider-execution-evidence.v1"
      || providerEvidence.value.evidence_ref !== evidenceRef
      || providerEvidence.value.owner_seeded_framing
        !== context.ownerSeededFraming
      || typeof traceRef !== "string"
      || !traceRef
    ) {
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
        sha256: await sha256File(evidencePath),
      },
      policy: {
        fixedProviderFacade: true,
        arbitraryCommandAccepted: false,
        arbitraryProviderEndpointAccepted: false,
        arbitraryCredentialAccepted: false,
        serviceCredentialValueOrDigestExposed: false,
        providerSelectionOrResearchSufficiencyPerformed: false,
        targetedWebSubstitutesForOpenWorldDiscovery: false,
        automaticRetryPerformed: false,
        semanticMutationPublicationRuntimeOrEffectAuthorityGranted: false,
      },
    };
  }
}
