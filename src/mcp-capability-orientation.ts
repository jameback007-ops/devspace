export const MCP_CAPABILITY_ORIENTATION_SCHEMA =
  "devspace.mcp-capability-orientation.v1" as const;
export const MCP_CAPABILITY_ORIENTATION_CAPABILITY_REF =
  "devspace.mcp-capability-orientation.v1" as const;

export const MCP_CAPABILITY_GROUP_METADATA = {
  workspaceExecution: {
    title: "Workspace execution",
    purpose:
      "Open an exact checkout or isolated worktree, inspect it, apply bounded source changes, and continue long-running commands.",
    intentRefs: [
      "start_or_resume_coding",
      "inspect_or_change_files",
      "run_or_continue_tests",
    ],
    recommendedEntryTools: ["open_workspace", "read", "apply_patch", "exec_command"],
    effectClass: "workspace_local_mutation",
  },
  nativeNavigation: {
    title: "Native workspace navigation",
    purpose:
      "Search file contents, discover paths, and list directories without using broad shell inspection.",
    intentRefs: ["search_code", "find_files", "list_directory"],
    recommendedEntryTools: ["grep", "glob", "ls"],
    effectClass: "read_only",
  },
  skillDiscovery: {
    title: "Skill discovery",
    purpose:
      "Find a specialized project or host procedure that was not advertised automatically by open_workspace.",
    intentRefs: ["find_specialized_procedure", "discover_host_capability"],
    recommendedEntryTools: ["skill_search"],
    effectClass: "read_only",
  },
  executionObservability: {
    title: "Execution-scope observability",
    purpose:
      "Inspect recent DevSpace scopes, linked workspaces, processes, bounded lifecycle evidence, and stable control-plane state.",
    intentRefs: [
      "inspect_other_session",
      "check_progress_or_activity",
      "diagnose_executor_state",
      "discover_capabilities",
    ],
    recommendedEntryTools: ["execution_scope_list", "execution_scope_status"],
    effectClass: "read_only",
  },
  executionMessaging: {
    title: "Execution-scope messaging",
    purpose:
      "Leave an idempotent target-bound instruction, correction, question, notice, or handoff for another known DevSpace scope.",
    intentRefs: ["message_peer_session", "coordinate_handoff", "request_status"],
    recommendedEntryTools: ["execution_scope_message_send", "execution_scope_message_inbox"],
    effectClass: "executor_local_coordination",
  },
  turnContinuity: {
    title: "Turn continuity",
    purpose:
      "Observe bounded turn timing and instability so long work can land and resume without forcing premature completion.",
    intentRefs: ["manage_long_turn", "find_safe_landing", "resume_same_mission"],
    recommendedEntryTools: ["turn_horizon_status"],
    effectClass: "executor_local_state",
  },
  continuationControl: {
    title: "ZES continuation control",
    purpose:
      "Read the fixed product-owned eligibility classification before governed integration, publication, runtime takeover, or effect retry without creating new authority.",
    intentRefs: [
      "check_mutation_or_publication_eligibility",
      "reconcile_runtime_takeover_or_effect_retry",
      "inspect_fixed_continuation_policy",
    ],
    recommendedEntryTools: ["zes_continuation_preflight"],
    effectClass: "read_only_external_authority_readback",
  },
  recoveryCapsules: {
    title: "Semantic recovery capsules",
    purpose:
      "Persist or read a Git-bound causal frontier for executor recovery without creating task, writer, effect, publication, or memory authority.",
    intentRefs: ["checkpoint_work", "resume_after_turn_or_failure", "preserve_frontier"],
    recommendedEntryTools: ["recovery_capsule_status", "recovery_capsule_record"],
    effectClass: "executor_local_state",
  },
  workspaceLifecycle: {
    title: "Workspace lifecycle and candidate hygiene",
    purpose:
      "Inspect, classify, preserve, close, or safely garbage-collect managed worktrees and publication candidates.",
    intentRefs: [
      "inspect_workspace_state",
      "find_unpublished_candidates",
      "close_or_clean_worktrees",
    ],
    recommendedEntryTools: ["workspace_status", "workspace_candidate_inventory"],
    effectClass: "mixed_local_lifecycle",
  },
  selfRepositoryPublication: {
    title: "DevSpace self-repository publication",
    purpose:
      "Preflight and publish one exact validated DevSpace candidate through fixed repository identity, compare-and-swap, and authoritative remote readback.",
    intentRefs: ["publish_devspace_candidate", "verify_devspace_publication_safety"],
    recommendedEntryTools: ["self_repository_publication_preflight"],
    effectClass: "repository_effect",
  },
  localAgentContinuation: {
    title: "Bounded local-agent continuation",
    purpose:
      "Inspect and coordinate durable executor-local provider sessions and turns with leases, cancellation, resumption, and unknown-outcome reconciliation.",
    intentRefs: ["delegate_to_subagent", "inspect_agent_turn", "resume_or_cancel_agent"],
    recommendedEntryTools: ["local_agent_session_list", "local_agent_session_status"],
    effectClass: "provider_effect_mixed",
  },
  zesResearchCycle: {
    title: "ZES Research Reflex",
    purpose:
      "Run the evidence-bound research lifecycle for an enabled ZES workspace, including current external acquisition and pre-commit verification.",
    intentRefs: [
      "research_external_patterns",
      "check_upstream_currentness",
      "bind_research_before_material_change",
    ],
    recommendedEntryTools: ["zes_research_cycle_open", "zes_research_provider_invoke"],
    effectClass: "workspace_local_state_and_external_read",
  },
  zesResearchInstrumentExecution: {
    title: "Shared research instrument execution",
    purpose:
      "Execute and record one exact planned empirical experiment through the shared Research Lab.",
    intentRefs: ["run_experiment", "compare_treatment_and_control", "collect_live_canary_evidence"],
    recommendedEntryTools: ["zes_research_instrument_status", "zes_research_instrument_execute"],
    effectClass: "bounded_external_experiment",
  },
  conversationTransport: {
    title: "Conversation transport and wake recovery",
    purpose:
      "Inspect, bind, assess, deliver, or reconcile bounded cross-conversation wake attempts through an independently verified transport.",
    intentRefs: ["wake_session", "recover_conversation", "inspect_prompt_delivery"],
    recommendedEntryTools: ["conversation_transport_status", "execution_wake_assess"],
    effectClass: "conversation_effect_mixed",
  },
  codexIntegration: {
    title: "Native Codex integration gateway",
    purpose:
      "Inspect and use native Codex App Server sessions, turns, approvals, usage, models, events, and lifecycle through opaque typed references.",
    intentRefs: ["inspect_codex", "work_with_codex", "control_codex_turn", "answer_codex_approval"],
    recommendedEntryTools: ["codex_gateway_status", "codex_session_list"],
    effectClass: "native_codex_effect_mixed",
  },
  codexWorkspaceInspection: {
    title: "Codex live-workspace inspection",
    purpose:
      "Read the allowlisted live Codex workspace tree, Git state, files, searches, and diffs without mutating the Codex harness or inventing a mirror authority.",
    intentRefs: [
      "inspect_codex_workspace",
      "compare_codex_changes",
      "locate_codex_source_or_evidence",
    ],
    recommendedEntryTools: [
      "codex_workspace_git_status",
      "codex_workspace_search",
      "codex_workspace_read",
    ],
    effectClass: "read_only",
  },
  crossExecutorCoordination: {
    title: "Cross-executor source coordination",
    purpose:
      "Assess potential source overlap with active Codex work and send one bounded coordination notice without creating a global writer lock.",
    intentRefs: ["avoid_codex_collision", "notify_codex_about_affected_paths"],
    recommendedEntryTools: ["cross_executor_coordination_assess"],
    effectClass: "coordination_effect_mixed",
  },
  artifactDownload: {
    title: "Artifact transfer",
    purpose:
      "Materialize one MCP-host-provided native file into an exact non-existing workspace-relative destination.",
    intentRefs: ["download_attached_file", "materialize_host_artifact"],
    recommendedEntryTools: ["download_artifact"],
    effectClass: "workspace_local_mutation",
  },
} as const;

export type McpCapabilityGroupName = keyof typeof MCP_CAPABILITY_GROUP_METADATA;

type CapabilityGroupRegistrationState = "absent" | "partial" | "complete";
type CapabilityGroupServerState = "available" | "degraded" | "disabled";
type CapabilityGroupClientState =
  | "unobserved"
  | "observed_complete"
  | "observed_partial"
  | "disabled";

interface CapabilityOrientationClientCatalogObservation {
  observable: boolean;
  freshness: "current" | "stale" | "unavailable";
  reason: string;
}

interface RuntimeCapabilityGroupObservation {
  configured: boolean;
  expectedTools: string[];
  registeredTools: string[];
  registrationState: CapabilityGroupRegistrationState;
  available: boolean;
}

export interface McpCapabilityOrientationInput {
  criticalToolGroups: Record<string, unknown>;
  registeredToolNames?: readonly string[];
  clientObservedToolNames?: readonly string[];
  clientCatalogObservation?: CapabilityOrientationClientCatalogObservation;
}

export interface McpCapabilityOrientationGroup {
  name: McpCapabilityGroupName;
  title: string;
  purpose: string;
  intentRefs: string[];
  recommendedEntryTools: string[];
  effectClass: string;
  configured: boolean;
  expectedTools: string[];
  registeredTools: string[];
  missingServerTools: string[];
  serverState: CapabilityGroupServerState;
  clientState: CapabilityGroupClientState;
  clientCatalogFreshness: "current" | "stale" | "unavailable";
  clientVisibleTools: string[];
  missingClientTools: string[];
}

export interface McpCapabilityOrientationFinding {
  code:
    | "SERVER_CAPABILITY_GROUP_INCOMPLETE"
    | "REGISTERED_TOOL_UNCLASSIFIED"
    | "CLIENT_CATALOG_UNOBSERVED"
    | "CLIENT_CATALOG_UNVERIFIED"
    | "CLIENT_CATALOG_MISSING_SERVER_CAPABILITY";
  severity: "info" | "warning" | "error";
  layer: "primary_server" | "capability_directory" | "host_catalog";
  groupName?: McpCapabilityGroupName;
  missingTools?: string[];
  repairClass:
    | "repair_primary_registration_or_configuration"
    | "update_capability_directory_metadata"
    | "attest_or_refresh_host_catalog";
  doesNotMeanCapabilityAbsent: boolean;
  message: string;
}

export interface McpCapabilityOrientation {
  schemaVersion: typeof MCP_CAPABILITY_ORIENTATION_SCHEMA;
  capabilityRef: typeof MCP_CAPABILITY_ORIENTATION_CAPABILITY_REF;
  state:
    | "SERVER_READY_CLIENT_CURRENT"
    | "SERVER_READY_CLIENT_PARTIAL"
    | "SERVER_READY_CLIENT_UNVERIFIED"
    | "SERVER_READY_CLIENT_UNOBSERVED"
    | "SERVER_READY_DIRECTORY_DRIFT"
    | "SERVER_CAPABILITY_DEGRADED";
  exactNextAction: string;
  summary: {
    configuredGroupCount: number;
    availableGroupCount: number;
    degradedGroupCount: number;
    disabledGroupCount: number;
    clientToolNamesObserved: boolean;
    clientCatalogAttested: boolean;
    clientCatalogFreshness: "current" | "stale" | "unavailable";
    clientCatalogReason: string;
    clientCompleteGroupCount: number;
    clientPartialGroupCount: number;
  };
  directory: {
    state: "unobserved" | "current" | "incomplete";
    registeredSurfaceObserved: boolean;
    registeredToolCount: number;
    classifiedRegisteredToolCount: number;
    unclassifiedRegisteredTools: string[];
  };
  groups: McpCapabilityOrientationGroup[];
  findings: McpCapabilityOrientationFinding[];
  selfEvolution: {
    loop: [
      "observe_registered_and_client_surfaces",
      "compare_desired_and_current_capabilities",
      "classify_failure_layer",
      "select_bounded_repair_or_host_action",
      "execute_through_separate_effect_gate",
      "verify_postconditions_and_surface_identity",
      "retain_evidence_and_reopen_on_new_gap",
    ];
    automaticSourceMutationAuthorized: false;
    hiddenModelIntentInferred: false;
    desiredStateSource: "compiled_capability_groups_and_stable_tool_abi";
    currentStateSources: [
      "registered_backend_tool_descriptors",
      "safe_runtime_configuration",
      "optional_complete_client_catalog_attestation",
    ];
    candidates: Array<{
      kind:
        | "repair_primary_capability_group"
        | "update_capability_directory"
        | "refresh_or_attest_host_catalog";
      layer: "primary_server" | "capability_directory" | "host_catalog";
      automaticEffectAllowed: false;
      exactNextAction: string;
    }>;
  };
  policy: {
    stableBootstrapTool: "execution_scope_status";
    useDirectoryBeforeInferringCapabilityAbsence: true;
    clientCatalogUnknownDoesNotMeanToolUnavailable: true;
    serverRegistrationAndHostVisibilityAreSeparate: true;
    directToolDiscoveryNotRequiredForReadback: true;
    capabilityDirectoryIsNotExecutionAuthority: true;
    canonicalTaskDecisionWriterEffectPublicationOrMemoryAuthorityGranted: false;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? uniqueSorted(value.filter((entry): entry is string => typeof entry === "string"))
    : [];
}

function normalizedGroup(
  name: McpCapabilityGroupName,
  value: unknown,
): RuntimeCapabilityGroupObservation {
  const record = isRecord(value) ? value : {};
  const configured = record.configured === true;
  const expectedTools = stringArray(record.expectedTools);
  const registeredTools = stringArray(record.registeredTools);
  const registrationState = ["absent", "partial", "complete"].includes(
    String(record.registrationState),
  )
    ? record.registrationState as CapabilityGroupRegistrationState
    : registeredTools.length === 0
      ? "absent"
      : registeredTools.length === expectedTools.length
        ? "complete"
        : "partial";
  return {
    configured,
    expectedTools,
    registeredTools,
    registrationState,
    available: record.available === true,
  };
}

export function buildMcpCapabilityOrientation(
  input: McpCapabilityOrientationInput,
): McpCapabilityOrientation {
  const clientToolNamesObserved = input.clientObservedToolNames !== undefined;
  const clientCatalogFreshness = input.clientCatalogObservation?.freshness
    ?? "unavailable";
  const clientCatalogReason = input.clientCatalogObservation?.reason
    ?? "client_catalog_observation_not_supplied";
  const clientCatalogAttested = clientCatalogFreshness === "current";
  const clientTools = new Set(input.clientObservedToolNames ?? []);
  const groups = (Object.keys(MCP_CAPABILITY_GROUP_METADATA) as McpCapabilityGroupName[])
    .map((name): McpCapabilityOrientationGroup => {
      const metadata = MCP_CAPABILITY_GROUP_METADATA[name];
      const observed = normalizedGroup(name, input.criticalToolGroups[name]);
      const missingServerTools = observed.expectedTools.filter(
        (tool) => !observed.registeredTools.includes(tool),
      );
      const serverState: CapabilityGroupServerState = !observed.configured
        ? "disabled"
        : observed.available && missingServerTools.length === 0
          ? "available"
          : "degraded";
      const clientVisibleTools = clientToolNamesObserved
        ? observed.expectedTools.filter((tool) => clientTools.has(tool))
        : [];
      const missingClientTools = clientToolNamesObserved && observed.configured
        ? observed.expectedTools.filter((tool) => !clientTools.has(tool))
        : [];
      const clientState: CapabilityGroupClientState = !observed.configured
        ? "disabled"
        : !clientToolNamesObserved
          ? "unobserved"
          : missingClientTools.length === 0
            ? "observed_complete"
            : "observed_partial";
      return {
        name,
        title: metadata.title,
        purpose: metadata.purpose,
        intentRefs: [...metadata.intentRefs],
        recommendedEntryTools: [...metadata.recommendedEntryTools],
        effectClass: metadata.effectClass,
        configured: observed.configured,
        expectedTools: observed.expectedTools,
        registeredTools: observed.registeredTools,
        missingServerTools,
        serverState,
        clientState,
        clientCatalogFreshness,
        clientVisibleTools,
        missingClientTools,
      };
    });

  const configuredGroups = groups.filter((group) => group.configured);
  const availableGroups = configuredGroups.filter(
    (group) => group.serverState === "available",
  );
  const degradedGroups = configuredGroups.filter(
    (group) => group.serverState === "degraded",
  );
  const clientCompleteGroups = configuredGroups.filter(
    (group) => group.clientState === "observed_complete",
  );
  const clientPartialGroups = configuredGroups.filter(
    (group) => group.clientState === "observed_partial",
  );
  const registeredSurfaceObserved = input.registeredToolNames !== undefined;
  const registeredTools = new Set(input.registeredToolNames ?? []);
  const classifiedTools = new Set(
    groups.flatMap((group) => group.expectedTools),
  );
  const unclassifiedRegisteredTools = registeredSurfaceObserved
    ? uniqueSorted(
      [...registeredTools].filter((tool) => !classifiedTools.has(tool)),
    )
    : [];
  const classifiedRegisteredToolCount = registeredSurfaceObserved
    ? [...registeredTools].filter((tool) => classifiedTools.has(tool)).length
    : 0;

  const findings: McpCapabilityOrientationFinding[] = [];
  for (const group of degradedGroups) {
    findings.push({
      code: "SERVER_CAPABILITY_GROUP_INCOMPLETE",
      severity: "error",
      layer: "primary_server",
      groupName: group.name,
      missingTools: group.missingServerTools,
      repairClass: "repair_primary_registration_or_configuration",
      doesNotMeanCapabilityAbsent: false,
      message:
        `Configured capability group ${group.name} is incomplete on the primary server.`,
    });
  }
  if (unclassifiedRegisteredTools.length > 0) {
    findings.push({
      code: "REGISTERED_TOOL_UNCLASSIFIED",
      severity: "warning",
      layer: "capability_directory",
      missingTools: unclassifiedRegisteredTools,
      repairClass: "update_capability_directory_metadata",
      doesNotMeanCapabilityAbsent: true,
      message:
        "The primary server registered tools that are not classified in the model-oriented capability directory; the tools exist, but new sessions may not know their intent or entry path.",
    });
  }
  if (!clientToolNamesObserved) {
    findings.push({
      code: "CLIENT_CATALOG_UNOBSERVED",
      severity: "info",
      layer: "host_catalog",
      repairClass: "attest_or_refresh_host_catalog",
      doesNotMeanCapabilityAbsent: true,
      message:
        "The primary server cannot observe the host's cached MCP catalog; unobserved client visibility is not evidence that a registered capability is unavailable.",
    });
  } else {
    for (const group of clientPartialGroups.filter(
      (candidate) => candidate.serverState === "available",
    )) {
      findings.push({
        code: "CLIENT_CATALOG_MISSING_SERVER_CAPABILITY",
        severity: "warning",
        layer: "host_catalog",
        groupName: group.name,
        missingTools: group.missingClientTools,
        repairClass: "attest_or_refresh_host_catalog",
        doesNotMeanCapabilityAbsent: true,
        message:
          `The primary server has capability group ${group.name}, but the caller-observed host tool-name set is missing part of its surface. This is diagnostic coverage, not proof of a current complete catalog.`,
      });
    }
    if (!clientCatalogAttested) {
      findings.push({
        code: "CLIENT_CATALOG_UNVERIFIED",
        severity: "warning",
        layer: "host_catalog",
        repairClass: "attest_or_refresh_host_catalog",
        doesNotMeanCapabilityAbsent: true,
        message:
          `Client tool names were observed, but the complete catalog is not current (${clientCatalogReason}); name coverage is diagnostic evidence, not a complete catalog attestation.`,
      });
    }
  }

  const state: McpCapabilityOrientation["state"] = degradedGroups.length > 0
    ? "SERVER_CAPABILITY_DEGRADED"
    : unclassifiedRegisteredTools.length > 0
      ? "SERVER_READY_DIRECTORY_DRIFT"
    : !clientToolNamesObserved
      ? "SERVER_READY_CLIENT_UNOBSERVED"
      : clientPartialGroups.length > 0
        ? "SERVER_READY_CLIENT_PARTIAL"
        : !clientCatalogAttested
          ? "SERVER_READY_CLIENT_UNVERIFIED"
          : "SERVER_READY_CLIENT_CURRENT";
  const exactNextAction = state === "SERVER_CAPABILITY_DEGRADED"
    ? "Repair the exact incomplete primary capability groups, then recompute the registered tool-surface fingerprint before relying on the affected functions."
    : state === "SERVER_READY_DIRECTORY_DRIFT"
      ? "Classify every unclassified registered tool into an intent-oriented capability group with a purpose and recommended entry tool, validate the directory against the exact registered surface, and publish through the ordinary DevSpace source lifecycle."
    : state === "SERVER_READY_CLIENT_PARTIAL"
      ? "Refresh or reconnect the host MCP connector and attest the complete tools/list surface; do not reinterpret host catalog lag as missing server capability."
      : state === "SERVER_READY_CLIENT_UNVERIFIED"
        ? "Observed tool names cover the configured groups, but the complete descriptor fingerprint is not current. Attest the canonical complete tools/list fingerprint before treating the catalog as authoritative."
      : state === "SERVER_READY_CLIENT_UNOBSERVED"
        ? "Use this directory to select the intended capability. Attest the complete host catalog only before declaring a direct tool missing or beginning capability-critical work."
        : "Select the smallest sufficient capability group for the task and continue through its recommended entry tool.";

  return {
    schemaVersion: MCP_CAPABILITY_ORIENTATION_SCHEMA,
    capabilityRef: MCP_CAPABILITY_ORIENTATION_CAPABILITY_REF,
    state,
    exactNextAction,
    summary: {
      configuredGroupCount: configuredGroups.length,
      availableGroupCount: availableGroups.length,
      degradedGroupCount: degradedGroups.length,
      disabledGroupCount: groups.length - configuredGroups.length,
      clientToolNamesObserved,
      clientCatalogAttested,
      clientCatalogFreshness,
      clientCatalogReason,
      clientCompleteGroupCount: clientCompleteGroups.length,
      clientPartialGroupCount: clientPartialGroups.length,
    },
    directory: {
      state: !registeredSurfaceObserved
        ? "unobserved"
        : unclassifiedRegisteredTools.length > 0
          ? "incomplete"
          : "current",
      registeredSurfaceObserved,
      registeredToolCount: registeredTools.size,
      classifiedRegisteredToolCount,
      unclassifiedRegisteredTools,
    },
    groups,
    findings,
    selfEvolution: {
      loop: [
        "observe_registered_and_client_surfaces",
        "compare_desired_and_current_capabilities",
        "classify_failure_layer",
        "select_bounded_repair_or_host_action",
        "execute_through_separate_effect_gate",
        "verify_postconditions_and_surface_identity",
        "retain_evidence_and_reopen_on_new_gap",
      ],
      automaticSourceMutationAuthorized: false,
      hiddenModelIntentInferred: false,
      desiredStateSource: "compiled_capability_groups_and_stable_tool_abi",
      currentStateSources: [
        "registered_backend_tool_descriptors",
        "safe_runtime_configuration",
        "optional_complete_client_catalog_attestation",
      ],
      candidates: [
        ...degradedGroups.map((group) => ({
          kind: "repair_primary_capability_group" as const,
          layer: "primary_server" as const,
          automaticEffectAllowed: false as const,
          exactNextAction:
            `Repair registered/configured drift for ${group.name}; missing server tools: ${group.missingServerTools.join(", ") || "unknown"}.`,
        })),
        ...(unclassifiedRegisteredTools.length === 0
          ? []
          : [{
            kind: "update_capability_directory" as const,
            layer: "capability_directory" as const,
            automaticEffectAllowed: false as const,
            exactNextAction:
              `Classify registered tools: ${unclassifiedRegisteredTools.join(", ")}.`,
          }]),
        ...(!clientCatalogAttested || clientPartialGroups.length > 0
          ? [{
            kind: "refresh_or_attest_host_catalog" as const,
            layer: "host_catalog" as const,
            automaticEffectAllowed: false as const,
            exactNextAction: clientToolNamesObserved
              ? "Refresh or reconnect the host MCP connector, then attest the canonical complete tools/list fingerprint; observed names alone are not a current catalog attestation."
              : "Submit one complete host tools/list attestation before declaring any direct capability unavailable.",
          }]
          : []),
      ],
    },
    policy: {
      stableBootstrapTool: "execution_scope_status",
      useDirectoryBeforeInferringCapabilityAbsence: true,
      clientCatalogUnknownDoesNotMeanToolUnavailable: true,
      serverRegistrationAndHostVisibilityAreSeparate: true,
      directToolDiscoveryNotRequiredForReadback: true,
      capabilityDirectoryIsNotExecutionAuthority: true,
      canonicalTaskDecisionWriterEffectPublicationOrMemoryAuthorityGranted: false,
    },
  };
}
