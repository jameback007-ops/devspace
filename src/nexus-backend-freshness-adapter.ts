import {
  assessToolSurfaceFreshness,
  type ClientCatalogAttestation,
  type FileIdentity,
  type RuntimeNativeMcpIdentity,
  type RuntimeToolSurfaceSnapshot,
  type ToolSurfaceDeploymentManifest,
  type ToolSurfaceFreshnessAssessment,
} from "./tool-surface-freshness.js";

export interface NexusBackendRuntimeObservation extends Record<string, unknown> {
  backend: {
    packageVersion: string;
    mcpServerVersion: string;
    instanceRef: string;
    startedAt: string;
    [key: string]: unknown;
  };
  toolSurface: {
    fingerprintSha256: string;
    toolCount: number;
    toolNames: string[];
    [key: string]: unknown;
  };
  clientCatalogObservation?: unknown;
  toolSurfaceFreshness?: unknown;
}

export interface NexusRuntimeBindingObservation {
  sourceCommit?: string;
  sourceTree?: string;
  buildArtifactDigestSha256?: string;
  surfaceEpoch?: string;
  acceleratorProfile?: FileIdentity;
  nativeMcps?: RuntimeNativeMcpIdentity[];
  observationErrors?: Array<Record<string, unknown>>;
}

export interface ExistingStatusToolClientInput {
  clientObservedSurfaceEpoch?: string;
  clientObservedFingerprintSha256?: string;
  clientObservedToolNames?: string[];
}

export function clientAttestationFromStatusToolInput(
  input: ExistingStatusToolClientInput | undefined,
): ClientCatalogAttestation | undefined {
  if (!input) return undefined;
  if (
    input.clientObservedSurfaceEpoch === undefined
    && input.clientObservedFingerprintSha256 === undefined
    && input.clientObservedToolNames === undefined
  ) return undefined;
  return {
    source: "status_tool_input",
    observedAt: new Date().toISOString(),
    surfaceEpoch: input.clientObservedSurfaceEpoch,
    fingerprintSha256: input.clientObservedFingerprintSha256,
    toolNames: input.clientObservedToolNames,
  };
}

export function runtimeSnapshotFromNexusBackend(
  backendRuntime: NexusBackendRuntimeObservation,
  bindings: NexusRuntimeBindingObservation,
): RuntimeToolSurfaceSnapshot {
  return {
    instanceRef: backendRuntime.backend.instanceRef,
    startedAt: backendRuntime.backend.startedAt,
    surfaceEpoch: bindings.surfaceEpoch,
    build: {
      sourceCommit: bindings.sourceCommit,
      sourceTree: bindings.sourceTree,
      buildArtifactDigestSha256: bindings.buildArtifactDigestSha256,
      packageVersion: backendRuntime.backend.packageVersion,
      mcpServerVersion: backendRuntime.backend.mcpServerVersion,
    },
    toolSurface: {
      fingerprintSha256: backendRuntime.toolSurface.fingerprintSha256,
      toolCount: backendRuntime.toolSurface.toolCount,
      toolNames: backendRuntime.toolSurface.toolNames,
    },
    acceleratorProfile: bindings.acceleratorProfile,
    nativeMcps: bindings.nativeMcps ?? [],
    observationErrors: bindings.observationErrors,
  };
}

export function assessNexusBackendFreshness(input: {
  backendRuntime: NexusBackendRuntimeObservation;
  bindings: NexusRuntimeBindingObservation;
  expected?: ToolSurfaceDeploymentManifest;
  clientInput?: ExistingStatusToolClientInput;
  clientAttestation?: ClientCatalogAttestation;
  assessedAt?: string;
}): {
  runtime: RuntimeToolSurfaceSnapshot;
  assessment: ToolSurfaceFreshnessAssessment;
} {
  const runtime = runtimeSnapshotFromNexusBackend(input.backendRuntime, input.bindings);
  const assessment = assessToolSurfaceFreshness({
    expected: input.expected,
    runtime,
    client:
      input.clientAttestation
      ?? clientAttestationFromStatusToolInput(input.clientInput),
    assessedAt: input.assessedAt,
  });
  return { runtime, assessment };
}

/** Preserve all older backendRuntime fields while adding the stronger result. */
export function enrichNexusBackendRuntime(
  backendRuntime: NexusBackendRuntimeObservation,
  assessment: ToolSurfaceFreshnessAssessment,
): NexusBackendRuntimeObservation {
  return {
    ...backendRuntime,
    backend: { ...backendRuntime.backend },
    toolSurface: {
      ...backendRuntime.toolSurface,
      toolNames: [...backendRuntime.toolSurface.toolNames],
    },
    clientCatalogObservation: assessment.clientCatalogObservation,
    toolSurfaceFreshness: assessment,
  };
}
