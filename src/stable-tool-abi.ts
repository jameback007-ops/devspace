import { createHash } from "node:crypto";
import {
  canonicalJson,
  type McpToolDescriptor,
} from "./tool-surface-freshness.js";

export const STABLE_TOOL_ABI_SCHEMA = "devspace.stable-tool-abi.v1" as const;
export const STABLE_TOOL_ABI_REF = "devspace.stable-tool-abi.v1" as const;

type InputKind = "string" | "boolean" | "numeric";

interface StableInputContract {
  kind: InputKind;
  enumValues?: readonly string[];
  pattern?: string;
}

interface StableEffectReplayContract {
  identityInput: string;
  terminalReceiptRequired: true;
  repeatedIdentityReturnsOriginalReceipt: true;
}

interface StableToolContract {
  name: string;
  availability:
    | "always"
    | "self_repository_configured"
    | "self_repository_effects_enabled";
  role:
    | "control_plane_bootstrap"
    | "scope_discovery"
    | "workspace_bootstrap"
    | "workspace_read"
    | "workspace_execution"
    | "skill_discovery"
    | "continuation_preflight"
    | "repository_publication_preflight"
    | "repository_publication_effect";
  requiredInputs: readonly string[];
  inputs: Readonly<Record<string, StableInputContract>>;
  effectReplay?: StableEffectReplayContract;
}

const STABLE_TOOL_CONTRACTS: readonly StableToolContract[] = [
  {
    name: "execution_scope_status",
    availability: "always",
    role: "control_plane_bootstrap",
    requiredInputs: [],
    inputs: {
      scopeRef: { kind: "string", pattern: "^[a-f0-9]{16}$" },
    },
  },
  {
    name: "execution_scope_list",
    availability: "always",
    role: "scope_discovery",
    requiredInputs: [],
    inputs: { limit: { kind: "numeric" } },
  },
  {
    name: "open_workspace",
    availability: "always",
    role: "workspace_bootstrap",
    requiredInputs: ["path"],
    inputs: {
      path: { kind: "string" },
      mode: { kind: "string", enumValues: ["checkout", "worktree"] },
      baseRef: { kind: "string" },
    },
  },
  {
    name: "read",
    availability: "always",
    role: "workspace_read",
    requiredInputs: ["workspaceId", "path"],
    inputs: {
      workspaceId: { kind: "string" },
      path: { kind: "string" },
      offset: { kind: "numeric" },
      limit: { kind: "numeric" },
    },
  },
  {
    name: "exec_command",
    availability: "always",
    role: "workspace_execution",
    requiredInputs: ["workspaceId", "cmd"],
    inputs: {
      workspaceId: { kind: "string" },
      cmd: { kind: "string" },
      tty: { kind: "boolean" },
      columns: { kind: "numeric" },
      rows: { kind: "numeric" },
      workingDirectory: { kind: "string" },
      yieldTimeMs: { kind: "numeric" },
      maxOutputTokens: { kind: "numeric" },
    },
  },
  {
    name: "skill_search",
    availability: "always",
    role: "skill_discovery",
    requiredInputs: ["workspaceId", "query"],
    inputs: {
      workspaceId: { kind: "string" },
      query: { kind: "string" },
      limit: { kind: "numeric" },
    },
  },
  {
    name: "zes_continuation_preflight",
    availability: "always",
    role: "continuation_preflight",
    requiredInputs: ["intent"],
    inputs: {
      intent: {
        kind: "string",
        enumValues: [
          "inspect",
          "prepare_isolated_candidate",
          "mutate_governed_checkout",
          "publish_repository",
          "runtime_takeover_or_effect_retry",
        ],
      },
    },
  },
  {
    name: "self_repository_publication_preflight",
    availability: "self_repository_configured",
    role: "repository_publication_preflight",
    requiredInputs: ["workspaceId"],
    inputs: {
      workspaceId: { kind: "string", pattern: "^ws_[a-f0-9]{10}$" },
    },
  },
  {
    name: "self_repository_publish",
    availability: "self_repository_effects_enabled",
    role: "repository_publication_effect",
    requiredInputs: ["workspaceId", "planIdSha256"],
    inputs: {
      workspaceId: { kind: "string", pattern: "^ws_[a-f0-9]{10}$" },
      planIdSha256: { kind: "string", pattern: "^[a-f0-9]{64}$" },
    },
    effectReplay: {
      identityInput: "planIdSha256",
      terminalReceiptRequired: true,
      repeatedIdentityReturnsOriginalReceipt: true,
    },
  },
] as const;

export interface StableToolAbiFinding {
  code:
    | "STABLE_TOOL_MISSING"
    | "STABLE_TOOL_INPUT_SCHEMA_MISSING"
    | "STABLE_TOOL_NEW_REQUIRED_INPUT"
    | "STABLE_TOOL_BASELINE_INPUT_MISSING"
    | "STABLE_TOOL_INPUT_NARROWED";
  toolName: string;
  inputName?: string;
  message: string;
}

export interface StableToolAbiAssessment {
  schemaVersion: typeof STABLE_TOOL_ABI_SCHEMA;
  abiRef: typeof STABLE_TOOL_ABI_REF;
  abiMajor: 1;
  fingerprintSha256: string;
  status: "compatible" | "incompatible";
  stableBootstrapTools: Array<{
    name: string;
    role: StableToolContract["role"];
    availability: StableToolContract["availability"];
    requiredInCurrentRuntime: boolean;
  }>;
  effectReplayContracts: Array<{
    toolName: string;
    identityInput: string;
    terminalReceiptRequired: true;
    repeatedIdentityReturnsOriginalReceipt: true;
  }>;
  findings: StableToolAbiFinding[];
  policy: {
    topLevelBootstrapNamesFrozen: true;
    existingInputsMayNotBeNarrowed: true;
    newRequiredInputsForbidden: true;
    additionalOptionalInputsCompatible: true;
    descriptionsAndAdditiveOutputsOutsideCallAbi: true;
    newTopLevelToolsDoNotExtendStableAbi: true;
    dynamicControlStateUsesAdditiveStatusProjection: true;
    highRiskEffectsRemainExplicitAndFreshlyRevalidated: true;
    listChangedNotificationIsDefenseInDepthOnly: true;
    listChangedDoesNotAttestHostRefresh: true;
    refreshRequiredForAbiMajorOrNewPrivilegedAction: true;
    clientCatalogFreshnessRequiresExplicitAttestation: true;
    descriptorOrderingAndFingerprintCanonical: true;
    stableEffectReplayIdentityAndTerminalReceiptRequired: true;
    semanticUsabilityDistinctFromProtocolSuccess: true;
    genericArbitraryRpcForbidden: true;
  };
}

export interface StableToolAbiAssessmentOptions {
  selfRepositoryPublicationConfigured?: boolean;
  selfRepositoryPublicationEffectsEnabled?: boolean;
}

function requiredInCurrentRuntime(
  contract: StableToolContract,
  options: StableToolAbiAssessmentOptions,
): boolean {
  switch (contract.availability) {
    case "always":
      return true;
    case "self_repository_configured":
      return options.selfRepositoryPublicationConfigured === true;
    case "self_repository_effects_enabled":
      return options.selfRepositoryPublicationConfigured === true
        && options.selfRepositoryPublicationEffectsEnabled === true;
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function schemaAcceptsKind(schemaValue: unknown, kind: InputKind): boolean {
  const schema = record(schemaValue);
  if (!schema) return false;
  const alternatives = [
    ...((Array.isArray(schema.anyOf) ? schema.anyOf : [])),
    ...((Array.isArray(schema.oneOf) ? schema.oneOf : [])),
  ];
  if (alternatives.some((entry) => schemaAcceptsKind(entry, kind))) return true;
  const types = typeof schema.type === "string"
    ? [schema.type]
    : strings(schema.type);
  if (kind === "numeric") {
    return types.includes("number") || types.includes("integer");
  }
  return types.includes(kind);
}

function schemaAcceptsEnum(
  schemaValue: unknown,
  baselineValues: readonly string[] | undefined,
): boolean {
  if (!baselineValues || baselineValues.length === 0) return true;
  const schema = record(schemaValue);
  if (!schema) return false;
  const alternatives = [
    ...((Array.isArray(schema.anyOf) ? schema.anyOf : [])),
    ...((Array.isArray(schema.oneOf) ? schema.oneOf : [])),
  ];
  if (alternatives.length > 0) {
    const accepted = new Set<string>();
    for (const alternative of alternatives) {
      const alternativeRecord = record(alternative);
      for (const value of strings(alternativeRecord?.enum)) accepted.add(value);
      if (typeof alternativeRecord?.const === "string") {
        accepted.add(alternativeRecord.const);
      }
    }
    return baselineValues.every((value) => accepted.has(value));
  }
  const current = strings(schema.enum);
  if (current.length === 0) return true;
  const accepted = new Set(current);
  return baselineValues.every((value) => accepted.has(value));
}

function schemaAcceptsPattern(
  schemaValue: unknown,
  baselinePattern: string | undefined,
): boolean {
  if (!baselinePattern) return true;
  const schema = record(schemaValue);
  if (!schema) return false;
  return schema.pattern === undefined || schema.pattern === baselinePattern;
}

function abiFingerprint(): string {
  return createHash("sha256")
    .update(canonicalJson(STABLE_TOOL_CONTRACTS))
    .digest("hex");
}

export function assessStableToolAbi(
  descriptors: readonly McpToolDescriptor[],
  options: StableToolAbiAssessmentOptions = {},
): StableToolAbiAssessment {
  const descriptorByName = new Map(
    descriptors.map((descriptor) => [descriptor.name, descriptor]),
  );
  const findings: StableToolAbiFinding[] = [];

  for (const contract of STABLE_TOOL_CONTRACTS) {
    const descriptor = descriptorByName.get(contract.name);
    if (!descriptor) {
      if (requiredInCurrentRuntime(contract, options)) {
        findings.push({
          code: "STABLE_TOOL_MISSING",
          toolName: contract.name,
          message: `Stable ABI tool ${contract.name} is not registered`,
        });
      }
      continue;
    }
    const inputSchema = record(descriptor.inputSchema);
    const properties = record(inputSchema?.properties);
    if (!inputSchema || !properties) {
      findings.push({
        code: "STABLE_TOOL_INPUT_SCHEMA_MISSING",
        toolName: contract.name,
        message: `Stable ABI tool ${contract.name} has no inspectable object input schema`,
      });
      continue;
    }
    const baselineRequired = new Set(contract.requiredInputs);
    for (const inputName of strings(inputSchema.required)) {
      if (!baselineRequired.has(inputName)) {
        findings.push({
          code: "STABLE_TOOL_NEW_REQUIRED_INPUT",
          toolName: contract.name,
          inputName,
          message: `${contract.name}.${inputName} became required after ABI v1`,
        });
      }
    }
    for (const [inputName, inputContract] of Object.entries(contract.inputs)) {
      const property = properties[inputName];
      if (property === undefined) {
        findings.push({
          code: "STABLE_TOOL_BASELINE_INPUT_MISSING",
          toolName: contract.name,
          inputName,
          message: `${contract.name}.${inputName} no longer exists`,
        });
        continue;
      }
      if (
        !schemaAcceptsKind(property, inputContract.kind)
        || !schemaAcceptsEnum(property, inputContract.enumValues)
        || !schemaAcceptsPattern(property, inputContract.pattern)
      ) {
        findings.push({
          code: "STABLE_TOOL_INPUT_NARROWED",
          toolName: contract.name,
          inputName,
          message: `${contract.name}.${inputName} no longer accepts the ABI v1 input domain`,
        });
      }
    }
  }

  findings.sort((left, right) => (
    left.toolName.localeCompare(right.toolName)
    || String(left.inputName ?? "").localeCompare(String(right.inputName ?? ""))
    || left.code.localeCompare(right.code)
  ));

  return {
    schemaVersion: STABLE_TOOL_ABI_SCHEMA,
    abiRef: STABLE_TOOL_ABI_REF,
    abiMajor: 1,
    fingerprintSha256: abiFingerprint(),
    status: findings.length === 0 ? "compatible" : "incompatible",
    stableBootstrapTools: STABLE_TOOL_CONTRACTS.map((contract) => ({
      name: contract.name,
      role: contract.role,
      availability: contract.availability,
      requiredInCurrentRuntime: requiredInCurrentRuntime(contract, options),
    })),
    effectReplayContracts: STABLE_TOOL_CONTRACTS.flatMap((contract) => (
      contract.effectReplay
        ? [{
          toolName: contract.name,
          identityInput: contract.effectReplay.identityInput,
          terminalReceiptRequired: contract.effectReplay.terminalReceiptRequired,
          repeatedIdentityReturnsOriginalReceipt:
            contract.effectReplay.repeatedIdentityReturnsOriginalReceipt,
        }]
        : []
    )),
    findings,
    policy: {
      topLevelBootstrapNamesFrozen: true,
      existingInputsMayNotBeNarrowed: true,
      newRequiredInputsForbidden: true,
      additionalOptionalInputsCompatible: true,
      descriptionsAndAdditiveOutputsOutsideCallAbi: true,
      newTopLevelToolsDoNotExtendStableAbi: true,
      dynamicControlStateUsesAdditiveStatusProjection: true,
      highRiskEffectsRemainExplicitAndFreshlyRevalidated: true,
      listChangedNotificationIsDefenseInDepthOnly: true,
      listChangedDoesNotAttestHostRefresh: true,
      refreshRequiredForAbiMajorOrNewPrivilegedAction: true,
      clientCatalogFreshnessRequiresExplicitAttestation: true,
      descriptorOrderingAndFingerprintCanonical: true,
      stableEffectReplayIdentityAndTerminalReceiptRequired: true,
      semanticUsabilityDistinctFromProtocolSuccess: true,
      genericArbitraryRpcForbidden: true,
    },
  };
}
