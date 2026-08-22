import assert from "node:assert/strict";
import test from "node:test";
import {
  buildMcpCapabilityOrientation,
  MCP_CAPABILITY_GROUP_METADATA,
} from "./mcp-capability-orientation.js";

function completeGroups() {
  return Object.fromEntries(
    Object.keys(MCP_CAPABILITY_GROUP_METADATA).map((name) => [name, {
      configured: true,
      expectedTools: [`${name}_tool`],
      registeredTools: [`${name}_tool`],
      registrationState: "complete",
      registeredComplete: true,
      available: true,
    }]),
  );
}

const currentClientCatalog = {
  observable: true,
  freshness: "current" as const,
  reason: "client_complete_tools_list_fingerprint_matches",
};

test("unobserved host catalog never means registered capabilities are absent", () => {
  const registeredToolNames = Object.keys(MCP_CAPABILITY_GROUP_METADATA).map(
    (name) => `${name}_tool`,
  );
  const orientation = buildMcpCapabilityOrientation({
    criticalToolGroups: completeGroups(),
    registeredToolNames,
  });
  assert.equal(orientation.state, "SERVER_READY_CLIENT_UNOBSERVED");
  assert.equal(orientation.summary.clientToolNamesObserved, false);
  assert.equal(orientation.summary.clientCatalogAttested, false);
  assert.equal(orientation.summary.clientCatalogFreshness, "unavailable");
  assert.equal(
    orientation.policy.clientCatalogUnknownDoesNotMeanToolUnavailable,
    true,
  );
  assert.ok(
    orientation.findings.some(
      (finding) => finding.code === "CLIENT_CATALOG_UNOBSERVED"
        && finding.doesNotMeanCapabilityAbsent,
    ),
  );
  assert.ok(
    orientation.groups.every((group) => group.clientState === "unobserved"),
  );
  assert.equal(orientation.directory.state, "current");
});

test("server-complete client-partial state routes to host catalog repair", () => {
  const groups = completeGroups();
  const orientation = buildMcpCapabilityOrientation({
    criticalToolGroups: groups,
    registeredToolNames: Object.keys(MCP_CAPABILITY_GROUP_METADATA).map(
      (name) => `${name}_tool`,
    ),
    clientObservedToolNames: ["workspaceExecution_tool"],
    clientCatalogObservation: {
      observable: true,
      freshness: "unavailable",
      reason: "client_complete_descriptor_fingerprint_not_attested",
    },
  });
  assert.equal(orientation.state, "SERVER_READY_CLIENT_PARTIAL");
  const research = orientation.groups.find(
    (group) => group.name === "zesResearchCycle",
  );
  assert.equal(research?.serverState, "available");
  assert.equal(research?.clientState, "observed_partial");
  assert.equal(research?.clientCatalogFreshness, "unavailable");
  assert.ok(
    orientation.findings.some(
      (finding) => finding.code === "CLIENT_CATALOG_MISSING_SERVER_CAPABILITY"
        && finding.groupName === "zesResearchCycle"
        && finding.doesNotMeanCapabilityAbsent,
    ),
  );
  assert.match(orientation.exactNextAction, /Refresh or reconnect/);
});

test("complete observed names without a current fingerprint remain unverified", () => {
  const observedTools = Object.keys(MCP_CAPABILITY_GROUP_METADATA).map(
    (name) => `${name}_tool`,
  );
  const orientation = buildMcpCapabilityOrientation({
    criticalToolGroups: completeGroups(),
    registeredToolNames: observedTools,
    clientObservedToolNames: observedTools,
    clientCatalogObservation: {
      observable: true,
      freshness: "unavailable",
      reason: "client_complete_descriptor_fingerprint_not_attested",
    },
  });
  assert.equal(orientation.state, "SERVER_READY_CLIENT_UNVERIFIED");
  assert.equal(orientation.summary.clientToolNamesObserved, true);
  assert.equal(orientation.summary.clientCatalogAttested, false);
  assert.ok(
    orientation.groups.every(
      (group) => group.clientState === "observed_complete",
    ),
  );
  assert.ok(
    orientation.findings.some(
      (finding) => finding.code === "CLIENT_CATALOG_UNVERIFIED",
    ),
  );
  assert.match(orientation.exactNextAction, /complete descriptor fingerprint/);
});

test("configured server capability drift is classified separately from host visibility", () => {
  const groups = completeGroups();
  groups.workspaceExecution = {
    configured: true,
    expectedTools: ["open_workspace", "read", "apply_patch"],
    registeredTools: ["open_workspace", "read"],
    registrationState: "partial",
    registeredComplete: false,
    available: false,
  };
  const orientation = buildMcpCapabilityOrientation({
    criticalToolGroups: groups,
    registeredToolNames: Object.keys(MCP_CAPABILITY_GROUP_METADATA).map(
      (name) => `${name}_tool`,
    ),
    clientObservedToolNames: ["open_workspace", "read"],
    clientCatalogObservation: {
      observable: true,
      freshness: "stale",
      reason: "client_attestation_differs_from_deployment_manifest",
    },
  });
  assert.equal(orientation.state, "SERVER_CAPABILITY_DEGRADED");
  const finding = orientation.findings.find(
    (candidate) => candidate.code === "SERVER_CAPABILITY_GROUP_INCOMPLETE",
  );
  assert.equal(finding?.layer, "primary_server");
  assert.deepEqual(finding?.missingTools, ["apply_patch"]);
  assert.equal(finding?.doesNotMeanCapabilityAbsent, false);
});

test("orientation exposes intent-first entry points without granting authority", () => {
  const orientation = buildMcpCapabilityOrientation({
    criticalToolGroups: completeGroups(),
    registeredToolNames: Object.keys(MCP_CAPABILITY_GROUP_METADATA).map(
      (name) => `${name}_tool`,
    ),
    clientObservedToolNames: Object.keys(MCP_CAPABILITY_GROUP_METADATA).map(
      (name) => `${name}_tool`,
    ),
    clientCatalogObservation: currentClientCatalog,
  });
  assert.equal(orientation.state, "SERVER_READY_CLIENT_CURRENT");
  assert.equal(orientation.summary.clientCatalogAttested, true);
  assert.ok(
    orientation.groups.find((group) => group.name === "codexIntegration")
      ?.intentRefs.includes("work_with_codex"),
  );
  assert.equal(orientation.selfEvolution.automaticSourceMutationAuthorized, false);
  assert.equal(
    orientation.policy
      .canonicalTaskDecisionWriterEffectPublicationOrMemoryAuthorityGranted,
    false,
  );
});

test("registered tool without a capability classification becomes an evolution candidate", () => {
  const classified = Object.keys(MCP_CAPABILITY_GROUP_METADATA).map(
    (name) => `${name}_tool`,
  );
  const orientation = buildMcpCapabilityOrientation({
    criticalToolGroups: completeGroups(),
    registeredToolNames: [...classified, "new_native_capability"],
  });
  assert.equal(orientation.state, "SERVER_READY_DIRECTORY_DRIFT");
  assert.deepEqual(
    orientation.directory.unclassifiedRegisteredTools,
    ["new_native_capability"],
  );
  assert.ok(
    orientation.selfEvolution.candidates.some(
      (candidate) => candidate.kind === "update_capability_directory",
    ),
  );
  assert.equal(
    orientation.findings.find(
      (finding) => finding.code === "REGISTERED_TOOL_UNCLASSIFIED",
    )?.doesNotMeanCapabilityAbsent,
    true,
  );
});
