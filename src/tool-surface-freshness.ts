import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

export const DEPLOYMENT_MANIFEST_SCHEMA = "zes.tool-surface-deployment-manifest.v1" as const;
export const FRESHNESS_ASSESSMENT_SCHEMA = "zes.tool-surface-freshness-assessment.v1" as const;

export type OverallFreshnessStatus =
  | "CURRENT"
  | "SERVER_CURRENT_CLIENT_UNKNOWN"
  | "STALE_SERVER"
  | "STALE_CLIENT"
  | "INDETERMINATE";

export type FindingSeverity = "info" | "warning" | "error";
export type FindingScope =
  | "deployment_manifest"
  | "server_build"
  | "server_tool_surface"
  | "accelerator_profile"
  | "native_mcp"
  | "client_catalog";

export interface McpToolDescriptor extends Record<string, unknown> {
  name: string;
}

export interface ToolSurfaceIdentity {
  fingerprintSha256: string;
  toolCount: number;
  toolNames: string[];
}

export interface BuildIdentity {
  sourceCommit?: string;
  sourceTree?: string;
  buildArtifactDigestSha256?: string;
  packageVersion: string;
  mcpServerVersion: string;
}

export interface FileIdentity {
  ref: string;
  digestSha256: string;
  byteCount?: number;
}

export interface NativeMcpIdentity {
  id: string;
  activationDigestSha256?: string;
  configDigestSha256?: string;
  sourceRevision?: string;
  workspaceRef?: string;
  toolSurfaceFingerprintSha256?: string;
}

export interface ExpectedNativeMcpIdentity extends NativeMcpIdentity {
  required: boolean;
}

export interface RuntimeNativeMcpIdentity extends NativeMcpIdentity {
  available: boolean;
  processInstanceRef?: string;
  observedAt?: string;
}

export interface ToolSurfaceDeploymentManifest {
  schemaVersion: typeof DEPLOYMENT_MANIFEST_SCHEMA;
  generatedAt: string;
  surfaceEpoch: string;
  build: BuildIdentity;
  toolSurface: ToolSurfaceIdentity;
  acceleratorProfile?: FileIdentity;
  nativeMcps: ExpectedNativeMcpIdentity[];
  requiredClientTools: string[];
}

export interface LoadedDeploymentManifest {
  manifest: ToolSurfaceDeploymentManifest;
  identity: FileIdentity;
}

export interface RuntimeToolSurfaceSnapshot {
  instanceRef: string;
  startedAt: string;
  surfaceEpoch?: string;
  build: BuildIdentity;
  toolSurface: ToolSurfaceIdentity;
  acceleratorProfile?: FileIdentity;
  nativeMcps: RuntimeNativeMcpIdentity[];
  observationErrors?: Array<Record<string, unknown>>;
}

export interface ClientCatalogAttestation {
  source: "request_header" | "status_tool_input" | "operator_probe" | "other";
  observedAt?: string;
  surfaceEpoch?: string;
  fingerprintSha256?: string;
  toolNames?: string[];
}

export interface FreshnessFinding {
  code: string;
  severity: FindingSeverity;
  scope: FindingScope;
  message: string;
  expected?: unknown;
  observed?: unknown;
  action: string;
}

export interface ClientCatalogObservation {
  observable: boolean;
  freshness: "current" | "stale" | "unavailable";
  reason: string;
  expectedSurfaceEpoch?: string;
  observedSurfaceEpoch?: string;
  expectedFingerprintSha256?: string;
  observedFingerprintSha256?: string;
  requiredClientTools: string[];
  missingRequiredClientTools: string[];
  action: string;
}

export interface ToolSurfaceFreshnessAssessment {
  schemaVersion: typeof FRESHNESS_ASSESSMENT_SCHEMA;
  assessedAt: string;
  status: OverallFreshnessStatus;
  claimCeiling: "executor_local_freshness_observation_only_no_task_release_writer_effect_or_activation_authority";
  runtimeInstanceRef?: string;
  runtimeStartedAt?: string;
  expectedSurfaceEpoch?: string;
  runtimeSurfaceEpoch?: string;
  serverCurrent: boolean | null;
  clientCatalogObservation: ClientCatalogObservation;
  findings: FreshnessFinding[];
  recommendedActions: string[];
}

const SHA256_RE = /^[a-f0-9]{64}$/;
const MAX_TOOL_COUNT = 10_000;
const MAX_REF_LENGTH = 1_024;
const MAX_VERSION_LENGTH = 256;
const MAX_EPOCH_LENGTH = 256;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeStringSet(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))].sort(compareCodeUnits);
}

function assertNonEmptyString(
  value: unknown,
  label: string,
  maxLength: number,
): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maxLength) {
    throw new Error(`${label} must be a non-empty string no longer than ${maxLength} characters`);
  }
}

function assertDigest(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !SHA256_RE.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
}

function assertOptionalDigest(value: unknown, label: string): void {
  if (value !== undefined) assertDigest(value, label);
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const allowedSet = new Set(allowed);
  const unexpected = Object.keys(value)
    .filter((key) => !allowedSet.has(key))
    .sort(compareCodeUnits);
  if (unexpected.length > 0) {
    throw new Error(`${label} contains unsupported fields: ${unexpected.join(", ")}`);
  }
}

function assertStringArray(
  value: unknown,
  label: string,
  maxItems = MAX_TOOL_COUNT,
): asserts value is string[] {
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new Error(`${label} must be an array with at most ${maxItems} entries`);
  }
  for (let index = 0; index < value.length; index += 1) {
    assertNonEmptyString(value[index], `${label}[${index}]`, MAX_REF_LENGTH);
  }
}

/**
 * Stable JSON for client-visible MCP descriptors. Object keys are sorted
 * recursively while array order is retained because JSON Schema arrays may be
 * semantic. Undefined object members are omitted.
 */
export function canonicalJson(value: unknown): string {
  const seen = new WeakSet<object>();
  const normalize = (candidate: unknown): unknown => {
    if (
      candidate === null
      || typeof candidate === "string"
      || typeof candidate === "boolean"
    ) return candidate;
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate)) throw new Error("Non-finite numbers cannot be canonicalized");
      return candidate;
    }
    if (candidate === undefined) return undefined;
    if (typeof candidate === "bigint") throw new Error("BigInt values cannot be canonicalized");
    if (Array.isArray(candidate)) {
      if (seen.has(candidate)) throw new Error("Cyclic values cannot be canonicalized");
      seen.add(candidate);
      const output = candidate.map((entry) => normalize(entry) ?? null);
      seen.delete(candidate);
      return output;
    }
    if (typeof candidate === "object") {
      if (seen.has(candidate)) throw new Error("Cyclic values cannot be canonicalized");
      seen.add(candidate);
      const output: Record<string, unknown> = {};
      for (const key of Object.keys(candidate as Record<string, unknown>).sort(compareCodeUnits)) {
        const normalized = normalize((candidate as Record<string, unknown>)[key]);
        if (normalized !== undefined) output[key] = normalized;
      }
      seen.delete(candidate);
      return output;
    }
    throw new Error(`Unsupported value type in canonical JSON: ${typeof candidate}`);
  };

  const normalized = normalize(value);
  if (normalized === undefined) throw new Error("Top-level undefined cannot be canonicalized");
  return JSON.stringify(normalized);
}

export function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function fileIdentity(bytes: Buffer, ref: string): FileIdentity {
  return {
    ref,
    digestSha256: createHash("sha256").update(bytes).digest("hex"),
    byteCount: bytes.byteLength,
  };
}

interface PathTreeEntry {
  path: string;
  mode: number;
  byteCount: number;
  digestSha256: string;
}

function pathTreeIdentity(entries: PathTreeEntry[], ref: string): FileIdentity {
  return {
    ref,
    digestSha256: sha256Text(canonicalJson({
      schemaVersion: "zes.path-tree-identity.v1",
      entries,
    })),
    byteCount: entries.reduce((total, entry) => total + entry.byteCount, 0),
  };
}

async function collectPathTreeEntries(
  root: string,
  relativePath = "",
): Promise<PathTreeEntry[]> {
  const directory = relativePath ? join(root, relativePath) : root;
  const children = await readdir(directory, { withFileTypes: true });
  children.sort((left, right) => compareCodeUnits(left.name, right.name));
  const entries: PathTreeEntry[] = [];
  for (const child of children) {
    const childRelativePath = relativePath
      ? `${relativePath}/${child.name}`
      : child.name;
    const childPath = join(root, childRelativePath);
    if (child.isDirectory()) {
      entries.push(...await collectPathTreeEntries(root, childRelativePath));
      continue;
    }
    if (!child.isFile()) {
      throw new Error(`Unsupported non-regular build artifact entry: ${childRelativePath}`);
    }
    const [metadata, bytes] = await Promise.all([lstat(childPath), readFile(childPath)]);
    entries.push({
      path: childRelativePath,
      mode: metadata.mode & 0o777,
      byteCount: bytes.byteLength,
      digestSha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  return entries;
}

function collectPathTreeEntriesSync(
  root: string,
  relativePath = "",
): PathTreeEntry[] {
  const directory = relativePath ? join(root, relativePath) : root;
  const children = readdirSync(directory, { withFileTypes: true });
  children.sort((left, right) => compareCodeUnits(left.name, right.name));
  const entries: PathTreeEntry[] = [];
  for (const child of children) {
    const childRelativePath = relativePath
      ? `${relativePath}/${child.name}`
      : child.name;
    const childPath = join(root, childRelativePath);
    if (child.isDirectory()) {
      entries.push(...collectPathTreeEntriesSync(root, childRelativePath));
      continue;
    }
    if (!child.isFile()) {
      throw new Error(`Unsupported non-regular build artifact entry: ${childRelativePath}`);
    }
    const metadata = lstatSync(childPath);
    const bytes = readFileSync(childPath);
    entries.push({
      path: childRelativePath,
      mode: metadata.mode & 0o777,
      byteCount: bytes.byteLength,
      digestSha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  return entries;
}

export async function observeFileIdentity(path: string, ref = path): Promise<FileIdentity> {
  assertNonEmptyString(path, "path", 4_096);
  assertNonEmptyString(ref, "ref", MAX_REF_LENGTH);
  return fileIdentity(await readFile(path), ref);
}

export function observeFileIdentitySync(path: string, ref = path): FileIdentity {
  assertNonEmptyString(path, "path", 4_096);
  assertNonEmptyString(ref, "ref", MAX_REF_LENGTH);
  return fileIdentity(readFileSync(path), ref);
}

export async function observePathIdentity(path: string, ref = path): Promise<FileIdentity> {
  assertNonEmptyString(path, "path", 4_096);
  assertNonEmptyString(ref, "ref", MAX_REF_LENGTH);
  const metadata = await lstat(path);
  if (metadata.isFile()) return fileIdentity(await readFile(path), ref);
  if (metadata.isDirectory()) {
    return pathTreeIdentity(await collectPathTreeEntries(path), ref);
  }
  throw new Error(`Unsupported build artifact path type: ${path}`);
}

export function observePathIdentitySync(path: string, ref = path): FileIdentity {
  assertNonEmptyString(path, "path", 4_096);
  assertNonEmptyString(ref, "ref", MAX_REF_LENGTH);
  const metadata = lstatSync(path);
  if (metadata.isFile()) return fileIdentity(readFileSync(path), ref);
  if (metadata.isDirectory()) {
    return pathTreeIdentity(collectPathTreeEntriesSync(path), ref);
  }
  throw new Error(`Unsupported build artifact path type: ${path}`);
}

export function createToolSurfaceIdentity(
  tools: readonly McpToolDescriptor[],
): ToolSurfaceIdentity {
  if (!Array.isArray(tools) || tools.length > MAX_TOOL_COUNT) {
    throw new Error(`tools must contain at most ${MAX_TOOL_COUNT} descriptors`);
  }
  const names = new Set<string>();
  const normalized = tools.map((tool, index) => {
    if (!isRecord(tool)) throw new Error(`tools[${index}] must be an object`);
    const name = tool.name;
    assertNonEmptyString(name, `tools[${index}].name`, MAX_REF_LENGTH);
    if (names.has(name)) throw new Error(`Duplicate MCP tool name: ${name}`);
    names.add(name);
    return { ...tool, name };
  });
  normalized.sort((left, right) => compareCodeUnits(left.name, right.name));
  return {
    fingerprintSha256: sha256Text(canonicalJson(normalized)),
    toolCount: normalized.length,
    toolNames: normalizeStringSet([...names]),
  };
}

function validateBuildIdentity(value: unknown, label: string): asserts value is BuildIdentity {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  assertOnlyKeys(
    value,
    ["sourceCommit", "sourceTree", "buildArtifactDigestSha256", "packageVersion", "mcpServerVersion"],
    label,
  );
  assertNonEmptyString(value.packageVersion, `${label}.packageVersion`, MAX_VERSION_LENGTH);
  assertNonEmptyString(value.mcpServerVersion, `${label}.mcpServerVersion`, MAX_VERSION_LENGTH);
  if (value.sourceCommit !== undefined) {
    assertNonEmptyString(value.sourceCommit, `${label}.sourceCommit`, MAX_REF_LENGTH);
  }
  if (value.sourceTree !== undefined) {
    assertNonEmptyString(value.sourceTree, `${label}.sourceTree`, MAX_REF_LENGTH);
  }
  assertOptionalDigest(value.buildArtifactDigestSha256, `${label}.buildArtifactDigestSha256`);
}

function validateFileIdentity(value: unknown, label: string): asserts value is FileIdentity {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  assertOnlyKeys(value, ["ref", "digestSha256", "byteCount"], label);
  assertNonEmptyString(value.ref, `${label}.ref`, MAX_REF_LENGTH);
  assertDigest(value.digestSha256, `${label}.digestSha256`);
  if (
    value.byteCount !== undefined
    && (!Number.isSafeInteger(value.byteCount) || (value.byteCount as number) < 0)
  ) {
    throw new Error(`${label}.byteCount must be a non-negative safe integer`);
  }
}

function validateToolSurfaceIdentity(
  value: unknown,
  label: string,
): asserts value is ToolSurfaceIdentity {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  assertOnlyKeys(value, ["fingerprintSha256", "toolCount", "toolNames"], label);
  assertDigest(value.fingerprintSha256, `${label}.fingerprintSha256`);
  if (
    !Number.isSafeInteger(value.toolCount)
    || (value.toolCount as number) < 0
    || (value.toolCount as number) > MAX_TOOL_COUNT
  ) {
    throw new Error(`${label}.toolCount must be between 0 and ${MAX_TOOL_COUNT}`);
  }
  assertStringArray(value.toolNames, `${label}.toolNames`);
  if (normalizeStringSet(value.toolNames).length !== value.toolCount) {
    throw new Error(`${label}.toolCount must equal the number of unique toolNames`);
  }
}

function validateExpectedNativeMcp(
  value: unknown,
  label: string,
): asserts value is ExpectedNativeMcpIdentity {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  assertOnlyKeys(
    value,
    [
      "id",
      "required",
      "activationDigestSha256",
      "configDigestSha256",
      "sourceRevision",
      "workspaceRef",
      "toolSurfaceFingerprintSha256",
    ],
    label,
  );
  assertNonEmptyString(value.id, `${label}.id`, MAX_REF_LENGTH);
  if (typeof value.required !== "boolean") throw new Error(`${label}.required must be a boolean`);
  assertOptionalDigest(value.activationDigestSha256, `${label}.activationDigestSha256`);
  assertOptionalDigest(value.configDigestSha256, `${label}.configDigestSha256`);
  assertOptionalDigest(value.toolSurfaceFingerprintSha256, `${label}.toolSurfaceFingerprintSha256`);
  if (value.sourceRevision !== undefined) {
    assertNonEmptyString(value.sourceRevision, `${label}.sourceRevision`, MAX_REF_LENGTH);
  }
  if (value.workspaceRef !== undefined) {
    assertNonEmptyString(value.workspaceRef, `${label}.workspaceRef`, MAX_REF_LENGTH);
  }
}

export function validateRuntimeNativeMcpIdentities(
  value: unknown,
): RuntimeNativeMcpIdentity[] {
  if (!Array.isArray(value) || value.length > 1_000) {
    throw new Error("runtime native MCP identities must be an array with at most 1000 entries");
  }
  const ids = new Set<string>();
  return value.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`runtime native MCP identities[${index}] must be an object`);
    assertOnlyKeys(
      entry,
      [
        "id",
        "available",
        "activationDigestSha256",
        "configDigestSha256",
        "sourceRevision",
        "workspaceRef",
        "toolSurfaceFingerprintSha256",
        "processInstanceRef",
        "observedAt",
      ],
      `runtime native MCP identities[${index}]`,
    );
    assertNonEmptyString(entry.id, `runtime native MCP identities[${index}].id`, MAX_REF_LENGTH);
    if (ids.has(entry.id)) throw new Error(`Duplicate runtime native MCP id: ${entry.id}`);
    ids.add(entry.id);
    if (typeof entry.available !== "boolean") {
      throw new Error(`runtime native MCP identities[${index}].available must be a boolean`);
    }
    assertOptionalDigest(entry.activationDigestSha256, `runtime native MCP identities[${index}].activationDigestSha256`);
    assertOptionalDigest(entry.configDigestSha256, `runtime native MCP identities[${index}].configDigestSha256`);
    assertOptionalDigest(entry.toolSurfaceFingerprintSha256, `runtime native MCP identities[${index}].toolSurfaceFingerprintSha256`);
    return entry as unknown as RuntimeNativeMcpIdentity;
  }).sort((left, right) => compareCodeUnits(left.id, right.id));
}

export function validateDeploymentManifest(value: unknown): ToolSurfaceDeploymentManifest {
  if (!isRecord(value)) throw new Error("deployment manifest must be an object");
  assertOnlyKeys(
    value,
    [
      "schemaVersion",
      "generatedAt",
      "surfaceEpoch",
      "build",
      "toolSurface",
      "acceleratorProfile",
      "nativeMcps",
      "requiredClientTools",
    ],
    "deployment manifest",
  );
  if (value.schemaVersion !== DEPLOYMENT_MANIFEST_SCHEMA) {
    throw new Error(`deployment manifest schemaVersion must be ${DEPLOYMENT_MANIFEST_SCHEMA}`);
  }
  assertNonEmptyString(value.generatedAt, "generatedAt", 128);
  if (Number.isNaN(Date.parse(value.generatedAt))) {
    throw new Error("generatedAt must be an ISO-compatible timestamp");
  }
  assertNonEmptyString(value.surfaceEpoch, "surfaceEpoch", MAX_EPOCH_LENGTH);
  validateBuildIdentity(value.build, "build");
  if (value.build.sourceCommit === undefined) {
    throw new Error("build.sourceCommit is required by deployment manifest v1");
  }
  if (value.build.sourceTree === undefined) {
    throw new Error("build.sourceTree is required by deployment manifest v1");
  }
  if (value.build.buildArtifactDigestSha256 === undefined) {
    throw new Error(
      "build.buildArtifactDigestSha256 is required by deployment manifest v1",
    );
  }
  validateToolSurfaceIdentity(value.toolSurface, "toolSurface");
  if (value.acceleratorProfile !== undefined) {
    validateFileIdentity(value.acceleratorProfile, "acceleratorProfile");
  }
  if (!Array.isArray(value.nativeMcps) || value.nativeMcps.length > 1_000) {
    throw new Error("nativeMcps must be an array with at most 1000 entries");
  }
  const nativeIds = new Set<string>();
  value.nativeMcps.forEach((entry, index) => {
    validateExpectedNativeMcp(entry, `nativeMcps[${index}]`);
    if (nativeIds.has(entry.id)) throw new Error(`Duplicate native MCP id: ${entry.id}`);
    nativeIds.add(entry.id);
  });
  assertStringArray(value.requiredClientTools, "requiredClientTools");
  const requiredClientTools = normalizeStringSet(value.requiredClientTools);
  const knownTools = new Set(value.toolSurface.toolNames);
  for (const tool of requiredClientTools) {
    if (!knownTools.has(tool)) throw new Error(`requiredClientTools contains unknown tool: ${tool}`);
  }
  return {
    ...(value as unknown as ToolSurfaceDeploymentManifest),
    toolSurface: {
      ...value.toolSurface,
      toolNames: normalizeStringSet(value.toolSurface.toolNames),
    },
    nativeMcps: [...value.nativeMcps].sort((left, right) => compareCodeUnits(left.id, right.id)),
    requiredClientTools,
  };
}

function parseManifestBytes(
  bytes: Buffer,
  ref: string,
  expectedDigestSha256?: string,
): LoadedDeploymentManifest {
  if (expectedDigestSha256 !== undefined) assertDigest(expectedDigestSha256, "expectedDigestSha256");
  const identity = fileIdentity(bytes, ref);
  if (
    expectedDigestSha256 !== undefined
    && identity.digestSha256 !== expectedDigestSha256
  ) {
    throw new Error(
      `Deployment manifest digest mismatch: expected ${expectedDigestSha256}, observed ${identity.digestSha256}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw new Error(`Invalid deployment manifest JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { manifest: validateDeploymentManifest(parsed), identity };
}

export async function loadDeploymentManifestEnvelope(
  path: string,
  ref = path,
  expectedDigestSha256?: string,
): Promise<LoadedDeploymentManifest> {
  return parseManifestBytes(await readFile(path), ref, expectedDigestSha256);
}

export function loadDeploymentManifestEnvelopeSync(
  path: string,
  ref = path,
  expectedDigestSha256?: string,
): LoadedDeploymentManifest {
  return parseManifestBytes(readFileSync(path), ref, expectedDigestSha256);
}

function finding(
  code: string,
  severity: FindingSeverity,
  scope: FindingScope,
  message: string,
  action: string,
  expected?: unknown,
  observed?: unknown,
): FreshnessFinding {
  return { code, severity, scope, message, action, expected, observed };
}

function compareOptionalString(
  findings: FreshnessFinding[],
  scope: FindingScope,
  code: string,
  label: string,
  expected: string | undefined,
  observed: string | undefined,
  action: string,
): void {
  if (expected === undefined) return;
  if (observed === undefined) {
    findings.push(finding(
      `${code}_UNOBSERVED`,
      "warning",
      scope,
      `${label} is required by the deployment manifest but was not observed at runtime.`,
      action,
      expected,
      undefined,
    ));
  } else if (expected !== observed) {
    findings.push(finding(
      code,
      "error",
      scope,
      `${label} differs from the deployment manifest.`,
      action,
      expected,
      observed,
    ));
  }
}

function compareNativeMcp(
  findings: FreshnessFinding[],
  expected: ExpectedNativeMcpIdentity,
  observed: RuntimeNativeMcpIdentity | undefined,
): void {
  if (!observed || !observed.available) {
    findings.push(finding(
      expected.required ? "REQUIRED_NATIVE_MCP_UNAVAILABLE" : "OPTIONAL_NATIVE_MCP_UNAVAILABLE",
      expected.required ? "error" : "info",
      "native_mcp",
      `${expected.required ? "Required" : "Optional"} native MCP ${expected.id} was not observed as available.`,
      expected.required
        ? "restore_the_exact_activation_receipt_or_remove_the_requirement_through_a_new_qualified_deployment"
        : "none",
      expected,
      observed,
    ));
    return;
  }
  for (const [key, label] of [
    ["activationDigestSha256", "activation digest"],
    ["configDigestSha256", "configuration digest"],
    ["sourceRevision", "source revision"],
    ["workspaceRef", "workspace reference"],
    ["toolSurfaceFingerprintSha256", "tool-surface fingerprint"],
  ] as const) {
    compareOptionalString(
      findings,
      "native_mcp",
      `STALE_NATIVE_MCP_${key.replace(/([A-Z])/g, "_$1").toUpperCase()}`,
      `${expected.id} ${label}`,
      expected[key],
      observed[key],
      "restore_the_exact_native_mcp_activation_or_qualify_a_new_deployment_manifest",
    );
  }
}

function clientObservation(
  expected: ToolSurfaceDeploymentManifest | undefined,
  client: ClientCatalogAttestation | undefined,
  findings: FreshnessFinding[],
): ClientCatalogObservation {
  const requiredClientTools = expected?.requiredClientTools ?? [];
  if (!expected) {
    return {
      observable: Boolean(client),
      freshness: "unavailable",
      reason: "deployment_manifest_unavailable",
      requiredClientTools,
      missingRequiredClientTools: [],
      action: "load_a_digest_pinned_deployment_manifest_before_claiming_catalog_freshness",
    };
  }
  if (!client) {
    findings.push(finding(
      "CLIENT_CATALOG_UNOBSERVED",
      "info",
      "client_catalog",
      "The server cannot observe the host's cached tools/list result from an ordinary MCP call.",
      "refresh_or_reconnect_the_mcp_connector_when_required_tools_are_missing",
    ));
    return {
      observable: false,
      freshness: "unavailable",
      reason: "server_current_client_catalog_not_attested",
      expectedSurfaceEpoch: expected.surfaceEpoch,
      expectedFingerprintSha256: expected.toolSurface.fingerprintSha256,
      requiredClientTools,
      missingRequiredClientTools: [],
      action: "refresh_or_reconnect_the_mcp_connector_when_required_tools_are_missing",
    };
  }

  const observedNames = new Set(client.toolNames ?? []);
  const missingRequiredClientTools = client.toolNames
    ? requiredClientTools.filter((name) => !observedNames.has(name))
    : [];
  if (missingRequiredClientTools.length > 0) {
    findings.push(finding(
      "STALE_CLIENT_REQUIRED_TOOLS_MISSING",
      "error",
      "client_catalog",
      "The attested client catalog lacks required Nexus tools.",
      "refresh_or_reconnect_the_mcp_connector_then_attest_the_new_tools_list",
      requiredClientTools,
      client.toolNames,
    ));
  }
  if (
    client.surfaceEpoch !== undefined
    && client.surfaceEpoch !== expected.surfaceEpoch
  ) {
    findings.push(finding(
      "STALE_CLIENT_SURFACE_EPOCH",
      "error",
      "client_catalog",
      "The client-observed surface epoch differs from the deployment manifest.",
      "refresh_or_reconnect_the_mcp_connector_then_attest_the_new_tools_list",
      expected.surfaceEpoch,
      client.surfaceEpoch,
    ));
  }
  if (
    client.fingerprintSha256 !== undefined
    && client.fingerprintSha256 !== expected.toolSurface.fingerprintSha256
  ) {
    findings.push(finding(
      "STALE_CLIENT_TOOL_SURFACE",
      "error",
      "client_catalog",
      "The client-observed complete tools/list fingerprint differs from the deployment manifest.",
      "refresh_or_reconnect_the_mcp_connector_then_attest_the_new_tools_list",
      expected.toolSurface.fingerprintSha256,
      client.fingerprintSha256,
    ));
  }
  const stale = findings.some(
    (entry) => entry.scope === "client_catalog" && entry.severity === "error",
  );
  if (stale) {
    return {
      observable: true,
      freshness: "stale",
      reason: "client_attestation_differs_from_deployment_manifest",
      expectedSurfaceEpoch: expected.surfaceEpoch,
      observedSurfaceEpoch: client.surfaceEpoch,
      expectedFingerprintSha256: expected.toolSurface.fingerprintSha256,
      observedFingerprintSha256: client.fingerprintSha256,
      requiredClientTools,
      missingRequiredClientTools,
      action: "refresh_or_reconnect_the_mcp_connector_then_attest_the_new_tools_list",
    };
  }
  if (client.fingerprintSha256 === undefined) {
    return {
      observable: true,
      freshness: "unavailable",
      reason: "client_complete_descriptor_fingerprint_not_attested",
      expectedSurfaceEpoch: expected.surfaceEpoch,
      observedSurfaceEpoch: client.surfaceEpoch,
      expectedFingerprintSha256: expected.toolSurface.fingerprintSha256,
      requiredClientTools,
      missingRequiredClientTools,
      action: "attest_the_canonical_complete_tools_list_fingerprint_before_claiming_current",
    };
  }
  return {
    observable: true,
    freshness: "current",
    reason: "client_complete_tools_list_fingerprint_matches",
    expectedSurfaceEpoch: expected.surfaceEpoch,
    observedSurfaceEpoch: client.surfaceEpoch,
    expectedFingerprintSha256: expected.toolSurface.fingerprintSha256,
    observedFingerprintSha256: client.fingerprintSha256,
    requiredClientTools,
    missingRequiredClientTools,
    action: "none",
  };
}

export function assessToolSurfaceFreshness(input: {
  expected?: ToolSurfaceDeploymentManifest;
  runtime: RuntimeToolSurfaceSnapshot;
  client?: ClientCatalogAttestation;
  assessedAt?: string;
}): ToolSurfaceFreshnessAssessment {
  const { expected, runtime, client } = input;
  const findings: FreshnessFinding[] = [];
  if ((runtime.observationErrors?.length ?? 0) > 0) {
    findings.push(finding(
      "RUNTIME_BINDING_OBSERVATION_FAILED",
      "warning",
      "deployment_manifest",
      "One or more configured runtime identity observations failed.",
      "restore_the_configured_evidence_path_or_remove_it_through_a_new_qualified_deployment",
      undefined,
      runtime.observationErrors,
    ));
  }
  if (!expected) {
    findings.push(finding(
      "DEPLOYMENT_MANIFEST_UNAVAILABLE",
      "warning",
      "deployment_manifest",
      "No digest-pinned deployment manifest was loaded by the running Nexus process.",
      "generate_validate_and_digest_pin_the_manifest_before_activation",
    ));
  } else {
    const redeploy = "deploy_the_verified_build_then_restart_nexus_through_an_independently_proven_recovery_path";
    compareOptionalString(findings, "server_build", "STALE_SERVER_SOURCE_COMMIT", "server source commit", expected.build.sourceCommit, runtime.build.sourceCommit, redeploy);
    compareOptionalString(findings, "server_build", "STALE_SERVER_SOURCE_TREE", "server source tree", expected.build.sourceTree, runtime.build.sourceTree, redeploy);
    compareOptionalString(findings, "server_build", "STALE_SERVER_BUILD_ARTIFACT", "server build artifact digest", expected.build.buildArtifactDigestSha256, runtime.build.buildArtifactDigestSha256, redeploy);
    compareOptionalString(findings, "server_build", "STALE_SERVER_PACKAGE_VERSION", "DevSpace package version", expected.build.packageVersion, runtime.build.packageVersion, redeploy);
    compareOptionalString(findings, "server_build", "STALE_SERVER_MCP_VERSION", "ZES Nexus MCP server version", expected.build.mcpServerVersion, runtime.build.mcpServerVersion, redeploy);
    compareOptionalString(findings, "server_tool_surface", "STALE_SERVER_SURFACE_EPOCH", "tool-surface epoch", expected.surfaceEpoch, runtime.surfaceEpoch, redeploy);
    compareOptionalString(findings, "server_tool_surface", "STALE_SERVER_TOOL_SURFACE", "complete tools/list fingerprint", expected.toolSurface.fingerprintSha256, runtime.toolSurface.fingerprintSha256, redeploy);

    const expectedNames = normalizeStringSet(expected.toolSurface.toolNames);
    const runtimeNames = normalizeStringSet(runtime.toolSurface.toolNames);
    if (
      expected.toolSurface.toolCount !== runtime.toolSurface.toolCount
      || canonicalJson(expectedNames) !== canonicalJson(runtimeNames)
    ) {
      findings.push(finding(
        "STALE_SERVER_TOOL_INVENTORY",
        "error",
        "server_tool_surface",
        "Runtime tool count or names differ from the deployment manifest.",
        redeploy,
        { toolCount: expected.toolSurface.toolCount, toolNames: expectedNames },
        { toolCount: runtime.toolSurface.toolCount, toolNames: runtimeNames },
      ));
    }

    if (expected.acceleratorProfile) {
      if (!runtime.acceleratorProfile) {
        findings.push(finding(
          "ACCELERATOR_PROFILE_UNOBSERVED",
          "warning",
          "accelerator_profile",
          "The expected accelerator profile identity was not observed by the running Nexus process.",
          "observe_the_exact_governed_accelerator_profile_binding_without_touching_graphify_runtime_state",
          expected.acceleratorProfile,
          undefined,
        ));
      } else {
        compareOptionalString(findings, "accelerator_profile", "STALE_ACCELERATOR_PROFILE_REF", "accelerator profile reference", expected.acceleratorProfile.ref, runtime.acceleratorProfile.ref, "reload_or_redeploy_the_exact_accelerator_profile_binding");
        compareOptionalString(findings, "accelerator_profile", "STALE_ACCELERATOR_PROFILE_DIGEST", "accelerator profile digest", expected.acceleratorProfile.digestSha256, runtime.acceleratorProfile.digestSha256, "reload_or_redeploy_the_exact_accelerator_profile_binding");
      }
    }

    const runtimeNativeById = new Map(runtime.nativeMcps.map((entry) => [entry.id, entry]));
    for (const expectedNative of expected.nativeMcps) {
      compareNativeMcp(findings, expectedNative, runtimeNativeById.get(expectedNative.id));
    }
  }

  const clientCatalogObservation = clientObservation(expected, client, findings);
  const serverScopes = new Set<FindingScope>([
    "deployment_manifest",
    "server_build",
    "server_tool_surface",
    "accelerator_profile",
    "native_mcp",
  ]);
  const serverErrors = findings.some(
    (entry) => entry.severity === "error" && serverScopes.has(entry.scope),
  );
  const serverWarnings = findings.some(
    (entry) => entry.severity === "warning" && serverScopes.has(entry.scope),
  );
  const clientErrors = findings.some(
    (entry) => entry.severity === "error" && entry.scope === "client_catalog",
  );

  let status: OverallFreshnessStatus;
  let serverCurrent: boolean | null;
  if (serverErrors) {
    status = "STALE_SERVER";
    serverCurrent = false;
  } else if (serverWarnings || !expected) {
    status = "INDETERMINATE";
    serverCurrent = null;
  } else if (clientErrors) {
    status = "STALE_CLIENT";
    serverCurrent = true;
  } else if (clientCatalogObservation.freshness === "unavailable") {
    status = "SERVER_CURRENT_CLIENT_UNKNOWN";
    serverCurrent = true;
  } else {
    status = "CURRENT";
    serverCurrent = true;
  }

  const severityRank: Record<FindingSeverity, number> = { error: 0, warning: 1, info: 2 };
  findings.sort((left, right) => (
    severityRank[left.severity] - severityRank[right.severity]
    || compareCodeUnits(left.scope, right.scope)
    || compareCodeUnits(left.code, right.code)
  ));

  return {
    schemaVersion: FRESHNESS_ASSESSMENT_SCHEMA,
    assessedAt: input.assessedAt ?? new Date().toISOString(),
    status,
    claimCeiling: "executor_local_freshness_observation_only_no_task_release_writer_effect_or_activation_authority",
    runtimeInstanceRef: runtime.instanceRef,
    runtimeStartedAt: runtime.startedAt,
    expectedSurfaceEpoch: expected?.surfaceEpoch,
    runtimeSurfaceEpoch: runtime.surfaceEpoch,
    serverCurrent,
    clientCatalogObservation,
    findings,
    recommendedActions: normalizeStringSet(
      findings.filter((entry) => entry.action !== "none").map((entry) => entry.action),
    ),
  };
}

function safeHeaderValue(value: string): string {
  const sanitized = value.replace(/[^\x21-\x7E]/g, "").slice(0, 512);
  if (!sanitized) throw new Error("Header value is empty after sanitization");
  return sanitized;
}

export function freshnessHeaders(
  assessment: ToolSurfaceFreshnessAssessment,
  runtime: RuntimeToolSurfaceSnapshot,
): Record<string, string> {
  const headers: Record<string, string> = {
    "Cache-Control": "no-store",
    "X-ZES-Nexus-Instance-Ref": safeHeaderValue(runtime.instanceRef),
    "X-ZES-Tool-Surface-Fingerprint": safeHeaderValue(runtime.toolSurface.fingerprintSha256),
    "X-ZES-Tool-Surface-Freshness": assessment.status,
  };
  if (runtime.surfaceEpoch) {
    headers["X-ZES-Tool-Surface-Epoch"] = safeHeaderValue(runtime.surfaceEpoch);
  }
  return headers;
}

function firstHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
  const value = entry?.[1];
  return Array.isArray(value) ? value[0] : value;
}

export function clientAttestationFromHeaders(
  headers: Record<string, string | string[] | undefined>,
): ClientCatalogAttestation | undefined {
  const fingerprintSha256 = firstHeader(headers, "x-zes-client-tool-surface-fingerprint");
  const surfaceEpoch = firstHeader(headers, "x-zes-client-tool-surface-epoch");
  if (fingerprintSha256 === undefined && surfaceEpoch === undefined) return undefined;
  if (fingerprintSha256 !== undefined) {
    assertDigest(fingerprintSha256, "x-zes-client-tool-surface-fingerprint");
  }
  if (surfaceEpoch !== undefined) {
    assertNonEmptyString(surfaceEpoch, "x-zes-client-tool-surface-epoch", MAX_EPOCH_LENGTH);
  }
  return {
    source: "request_header",
    observedAt: new Date().toISOString(),
    fingerprintSha256,
    surfaceEpoch,
  };
}

export interface ToolSurfaceChangeResult {
  changed: boolean;
  previousFingerprintSha256?: string;
  currentFingerprintSha256: string;
  notificationSent: boolean;
}

/**
 * Serializes tools/list_changed emission for a real authorized in-process
 * registration change. It never watches files, restarts services, or mutates
 * activation state by itself.
 */
export class ToolSurfaceChangeBroadcaster {
  private lastFingerprintSha256?: string;
  private queue: Promise<void> = Promise.resolve();

  constructor(initialFingerprintSha256?: string) {
    if (initialFingerprintSha256 !== undefined) {
      assertDigest(initialFingerprintSha256, "initialFingerprintSha256");
    }
    this.lastFingerprintSha256 = initialFingerprintSha256;
  }

  observe(
    current: ToolSurfaceIdentity,
    notifyToolsListChanged: () => Promise<void>,
  ): Promise<ToolSurfaceChangeResult> {
    return new Promise<ToolSurfaceChangeResult>((resolve, reject) => {
      this.queue = this.queue
        .then(async () => {
          const previous = this.lastFingerprintSha256;
          if (previous === undefined || previous === current.fingerprintSha256) {
            this.lastFingerprintSha256 = current.fingerprintSha256;
            resolve({
              changed: false,
              previousFingerprintSha256: previous,
              currentFingerprintSha256: current.fingerprintSha256,
              notificationSent: false,
            });
            return;
          }
          await notifyToolsListChanged();
          this.lastFingerprintSha256 = current.fingerprintSha256;
          resolve({
            changed: true,
            previousFingerprintSha256: previous,
            currentFingerprintSha256: current.fingerprintSha256,
            notificationSent: true,
          });
        })
        .catch(reject);
    });
  }
}
