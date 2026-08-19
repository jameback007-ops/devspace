import assert from "node:assert/strict";
import {
  assessStableToolAbi,
  STABLE_TOOL_ABI_REF,
} from "./stable-tool-abi.js";
import type { McpToolDescriptor } from "./tool-surface-freshness.js";

function descriptor(
  name: string,
  properties: Record<string, unknown>,
  required: string[] = [],
): McpToolDescriptor {
  return {
    name,
    description: `description for ${name}`,
    inputSchema: {
      type: "object",
      properties,
      required,
    },
  };
}

function baseline(extraOptional = false): McpToolDescriptor[] {
  return [
    descriptor("execution_scope_status", {
      scopeRef: { type: "string", pattern: "^[a-f0-9]{16}$" },
      ...(extraOptional ? { futureProjection: { type: "string" } } : {}),
    }),
    descriptor("execution_scope_list", { limit: { type: "integer" } }),
    descriptor("open_workspace", {
      path: { type: "string" },
      mode: { type: "string", enum: ["checkout", "worktree"] },
      baseRef: { type: "string" },
    }, ["path"]),
    descriptor("read", {
      workspaceId: { type: "string" },
      path: { type: "string" },
      offset: { type: "integer" },
      limit: { type: "integer" },
    }, ["workspaceId", "path"]),
    descriptor("exec_command", {
      workspaceId: { type: "string" },
      cmd: { type: "string" },
      tty: { type: "boolean" },
      columns: { type: "integer" },
      rows: { type: "integer" },
      workingDirectory: { type: "string" },
      yieldTimeMs: { type: "integer" },
      maxOutputTokens: { type: "integer" },
    }, ["workspaceId", "cmd"]),
    descriptor("skill_search", {
      workspaceId: { type: "string" },
      query: { type: "string" },
      limit: { type: "integer" },
    }, ["workspaceId", "query"]),
    descriptor("zes_continuation_preflight", {
      intent: {
        type: "string",
        enum: [
          "inspect",
          "prepare_isolated_candidate",
          "mutate_governed_checkout",
          "publish_repository",
          "runtime_takeover_or_effect_retry",
        ],
      },
    }, ["intent"]),
    descriptor("self_repository_publication_preflight", {
      workspaceId: { type: "string", pattern: "^ws_[a-f0-9]{10}$" },
    }, ["workspaceId"]),
    descriptor("self_repository_publish", {
      workspaceId: { type: "string", pattern: "^ws_[a-f0-9]{10}$" },
      planIdSha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
    }, ["workspaceId", "planIdSha256"]),
  ];
}

const compatible = assessStableToolAbi([
  ...baseline(true),
  descriptor("future_direct_tool", { value: { type: "string" } }),
], {
  selfRepositoryPublicationConfigured: true,
  selfRepositoryPublicationEffectsEnabled: true,
});
assert.equal(compatible.abiRef, STABLE_TOOL_ABI_REF);
assert.equal(compatible.status, "compatible");
assert.deepEqual(compatible.findings, []);
assert.equal(compatible.policy.additionalOptionalInputsCompatible, true);
assert.equal(compatible.policy.newTopLevelToolsDoNotExtendStableAbi, true);
assert.equal(
  compatible.policy.clientCatalogFreshnessRequiresExplicitAttestation,
  true,
);
assert.equal(compatible.policy.descriptorOrderingAndFingerprintCanonical, true);
assert.equal(compatible.policy.listChangedDoesNotAttestHostRefresh, true);
assert.equal(
  compatible.policy.stableEffectReplayIdentityAndTerminalReceiptRequired,
  true,
);
assert.equal(compatible.policy.semanticUsabilityDistinctFromProtocolSuccess, true);
assert.equal(compatible.policy.genericArbitraryRpcForbidden, true);
assert.deepEqual(compatible.effectReplayContracts, [{
  toolName: "self_repository_publish",
  identityInput: "planIdSha256",
  terminalReceiptRequired: true,
  repeatedIdentityReturnsOriginalReceipt: true,
}]);

const plain = assessStableToolAbi(baseline(), {
  selfRepositoryPublicationConfigured: true,
  selfRepositoryPublicationEffectsEnabled: true,
});
assert.equal(
  compatible.fingerprintSha256,
  plain.fingerprintSha256,
  "optional inputs, descriptions, and new direct tools must not change ABI v1 identity",
);
assert.equal(
  assessStableToolAbi([...baseline()].reverse(), {
    selfRepositoryPublicationConfigured: true,
    selfRepositoryPublicationEffectsEnabled: true,
  }).fingerprintSha256,
  plain.fingerprintSha256,
  "descriptor arrival order must not change the stable ABI identity",
);

const newRequired = baseline(true);
(newRequired[0].inputSchema as Record<string, unknown>).required = ["futureProjection"];
const requiredAssessment = assessStableToolAbi(newRequired, {
  selfRepositoryPublicationConfigured: true,
  selfRepositoryPublicationEffectsEnabled: true,
});
assert.equal(requiredAssessment.status, "incompatible");
assert.ok(requiredAssessment.findings.some(
  (finding) => finding.code === "STABLE_TOOL_NEW_REQUIRED_INPUT",
));

const missing = baseline().filter((tool) => tool.name !== "execution_scope_status");
assert.equal(assessStableToolAbi(missing).status, "incompatible");

const noPublicationFeature = baseline().filter((tool) =>
  !tool.name.startsWith("self_repository_")
);
assert.equal(
  assessStableToolAbi(noPublicationFeature).status,
  "compatible",
  "feature-bound ABI tools are required only when that fixed effect family is configured",
);
assert.equal(
  assessStableToolAbi(noPublicationFeature, {
    selfRepositoryPublicationConfigured: true,
    selfRepositoryPublicationEffectsEnabled: true,
  }).status,
  "incompatible",
);

const narrowed = baseline();
const open = narrowed.find((tool) => tool.name === "open_workspace")!;
const openProperties = (open.inputSchema as Record<string, any>).properties;
openProperties.mode.enum = ["checkout"];
const narrowedAssessment = assessStableToolAbi(narrowed, {
  selfRepositoryPublicationConfigured: true,
  selfRepositoryPublicationEffectsEnabled: true,
});
assert.equal(narrowedAssessment.status, "incompatible");
assert.ok(narrowedAssessment.findings.some(
  (finding) => finding.code === "STABLE_TOOL_INPUT_NARROWED"
    && finding.toolName === "open_workspace"
    && finding.inputName === "mode",
));

const typeNarrowed = baseline();
const readTool = typeNarrowed.find((tool) => tool.name === "read")!;
const readProperties = (readTool.inputSchema as Record<string, any>).properties;
readProperties.path = { type: "number" };
const typeNarrowedAssessment = assessStableToolAbi(typeNarrowed, {
  selfRepositoryPublicationConfigured: true,
  selfRepositoryPublicationEffectsEnabled: true,
});
assert.equal(typeNarrowedAssessment.status, "incompatible");
assert.ok(typeNarrowedAssessment.findings.some(
  (finding) => finding.code === "STABLE_TOOL_INPUT_NARROWED"
    && finding.toolName === "read"
    && finding.inputName === "path",
));

console.log("stable tool ABI tests passed");
