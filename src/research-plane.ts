import { ResearchCaptureStore, type CaptureManifest } from "./research-captures.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { DEVSPACE_PACKAGE_VERSION } from "./version.js";

const CONTEXT7_ENDPOINT = "https://mcp.context7.com/mcp";
const EXA_ENDPOINT = "https://mcp.exa.ai/mcp";
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_OUTPUT_CHARACTERS = 120_000;
const DEFAULT_MAX_RESULTS = 8;
const DEFAULT_MAX_FETCH_CHARACTERS = 12_000;
const MAX_QUERY_CHARACTERS = 20_000;
const MAX_LIBRARY_IDENTIFIER_CHARACTERS = 2_000;
const MAX_PROVIDER_URL_CHARACTERS = 2_000;
const MAX_TARGET_URL_CHARACTERS = 8_192;
const MAX_TARGET_URLS = 20;
const MAX_RESULTS = 20;
const MAX_FETCH_CHARACTERS = 100_000;

export const RESEARCH_ACTIONS = [
  "manifest",
  "probe",
  "upstream_docs_resolve",
  "upstream_docs_query",
  "open_world_search",
  "known_source_fetch",
  "capture_read",
] as const;

export type ResearchAction = typeof RESEARCH_ACTIONS[number];

export interface ResearchProviderRoute {
  providerRef: "context7" | "exa";
  routeRef: string;
  endpoint: string;
  credentialEnvironment: "CONTEXT7_API_KEY" | "EXA_API_KEY";
  expectedTools: readonly string[];
  apiKey: string;
}

export interface ResearchPlaneConfig {
  context7: ResearchProviderRoute;
  exa: ResearchProviderRoute;
  timeoutMs: number;
  maxOutputCharacters: number;
}

export interface ResearchOperateInput {
  action: ResearchAction;
  query?: string;
  libraryName?: string;
  libraryId?: string;
  urls?: string[];
  maxResults?: number;
  maxCharacters?: number;
  responseMode?: "inline" | "reference";
  previewCharacters?: number;
  captureRef?: string;
  section?: "manifest" | "text" | "structured" | "raw";
  offset?: number;
  length?: number;
  find?: string;
}

export interface ResearchProviderTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: unknown;
}

export interface ResearchProviderToolSurface {
  providerRef: string;
  routeRef: string;
  transport: "official_mcp_streamable_http";
  protocolVersion?: string;
  serverInfo?: unknown;
  tools: ResearchProviderTool[];
}

export interface ResearchProviderToolResult {
  text: string;
  structuredContent: unknown;
  contentTypes: string[];
  textTruncated: boolean;
  structuredContentTruncated: boolean;
  isError: boolean;
  capture?: CaptureManifest;
  preview?: unknown;
  nextRead?: unknown;
}

export interface ResearchMcpClient {
  listTools(
    route: ResearchProviderRoute,
    timeoutMs: number,
  ): Promise<ResearchProviderToolSurface>;
  callTool(
    route: ResearchProviderRoute,
    toolName: string,
    arguments_: Record<string, unknown>,
    timeoutMs: number,
    maxOutputCharacters: number,
    delivery?: { reference: true; previewCharacters: number },
  ): Promise<ResearchProviderToolResult>;
}

export class ResearchPlaneError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ResearchPlaneError";
  }
}

function boundedIntegerEnvironment(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function validatedProviderEndpoint(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_PROVIDER_URL_CHARACTERS) {
    throw new Error(`${name} is not a valid bounded HTTPS provider endpoint`);
  }
  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    throw new Error(`${name} is not a valid URL`);
  }
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || url.search
    || url.hash
  ) {
    throw new Error(
      `${name} must be an HTTPS URL without userinfo, query, or fragment`,
    );
  }
  return url.toString();
}

export function researchPlaneConfigFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): ResearchPlaneConfig {
  return {
    context7: {
      providerRef: "context7",
      routeRef: "provider.context7.official-hosted-mcp",
      endpoint: validatedProviderEndpoint(
        env.DEVSPACE_RESEARCH_CONTEXT7_ENDPOINT ?? CONTEXT7_ENDPOINT,
        "DEVSPACE_RESEARCH_CONTEXT7_ENDPOINT",
      ),
      credentialEnvironment: "CONTEXT7_API_KEY",
      expectedTools: ["resolve-library-id", "query-docs"],
      apiKey: env.CONTEXT7_API_KEY?.trim() ?? "",
    },
    exa: {
      providerRef: "exa",
      routeRef: "provider.exa.official-hosted-mcp",
      endpoint: validatedProviderEndpoint(
        env.DEVSPACE_RESEARCH_EXA_ENDPOINT ?? EXA_ENDPOINT,
        "DEVSPACE_RESEARCH_EXA_ENDPOINT",
      ),
      credentialEnvironment: "EXA_API_KEY",
      expectedTools: ["web_search_exa", "web_fetch_exa"],
      apiKey: env.EXA_API_KEY?.trim() ?? "",
    },
    timeoutMs: boundedIntegerEnvironment(
      env,
      "DEVSPACE_RESEARCH_TIMEOUT_SECONDS",
      DEFAULT_TIMEOUT_MS / 1_000,
      1,
      180,
    ) * 1_000,
    maxOutputCharacters: boundedIntegerEnvironment(
      env,
      "DEVSPACE_RESEARCH_MAX_OUTPUT_CHARACTERS",
      DEFAULT_MAX_OUTPUT_CHARACTERS,
      1_000,
      500_000,
    ),
  };
}

function safeErrorClass(error: unknown): string {
  if (error instanceof Error && error.constructor?.name) {
    return error.constructor.name.slice(0, 120);
  }
  return typeof error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeToolResult(
  result: unknown,
  maxOutputCharacters: number,
): ResearchProviderToolResult {
  const resultRecord = isRecord(result) ? result : {};
  const textParts: string[] = [];
  const contentTypes: string[] = [];
  let remaining = maxOutputCharacters;
  let textTruncated = false;
  if (Array.isArray(resultRecord.content)) {
    for (const block of resultRecord.content) {
      if (!isRecord(block)) continue;
      const type = typeof block.type === "string" ? block.type : "unknown";
      contentTypes.push(type);
      const text = block.text;
      if (typeof text !== "string") continue;
      const piece = (textParts.length ? "\n\n" : "") + text;
      if (remaining <= 0) {
        if (piece.length > 0) textTruncated = true;
        continue;
      }
      if (piece.length > remaining) {
        textParts.push(piece.slice(0, remaining));
        remaining = 0;
        textTruncated = true;
      } else {
        textParts.push(piece);
        remaining -= piece.length;
      }
    }
  }

  let structuredContent: unknown = resultRecord.structuredContent ?? null;
  let structuredContentTruncated = false;
  if (structuredContent !== null && structuredContent !== undefined) {
    try {
      if (JSON.stringify(structuredContent).length > maxOutputCharacters) {
        structuredContent = null;
        structuredContentTruncated = true;
      }
    } catch {
      structuredContent = null;
      structuredContentTruncated = true;
    }
  }

  return {
    text: textParts.join(""),
    structuredContent,
    contentTypes,
    textTruncated,
    structuredContentTruncated,
    isError: resultRecord.isError === true,
  };
}

export class NativeResearchMcpClient implements ResearchMcpClient {
  constructor(private readonly captures?: ResearchCaptureStore) {}
  private async withClient<T>(
    route: ResearchProviderRoute,
    timeoutMs: number,
    operation: (
      client: Client,
      transport: StreamableHTTPClientTransport,
    ) => Promise<T>,
  ): Promise<T> {
    const headers: Record<string, string> = {};
    if (route.apiKey) headers.Authorization = `Bearer ${route.apiKey}`;
    const transport = new StreamableHTTPClientTransport(
      new URL(route.endpoint),
      {
        requestInit: Object.keys(headers).length > 0 ? { headers } : undefined,
        reconnectionOptions: {
          maxReconnectionDelay: 1_000,
          initialReconnectionDelay: 100,
          reconnectionDelayGrowFactor: 1,
          maxRetries: 0,
        },
      },
    );
    const client = new Client(
      { name: "devspace-native-research", version: DEVSPACE_PACKAGE_VERSION },
      { capabilities: {} },
    );
    try {
      await client.connect(transport, {
        timeout: timeoutMs,
        maxTotalTimeout: timeoutMs,
      });
      return await operation(client, transport);
    } finally {
      try {
        await client.close();
      } catch {
        // Closing an already-failed ephemeral read-only provider connection is
        // best-effort and must not replace the original provider outcome.
      }
    }
  }

  async listTools(
    route: ResearchProviderRoute,
    timeoutMs: number,
  ): Promise<ResearchProviderToolSurface> {
    try {
      return await this.withClient(route, timeoutMs, async (client, transport) => {
        const listed = await client.listTools(undefined, {
          timeout: timeoutMs,
          maxTotalTimeout: timeoutMs,
        });
        return {
          providerRef: route.providerRef,
          routeRef: route.routeRef,
          transport: "official_mcp_streamable_http",
          protocolVersion: transport.protocolVersion,
          serverInfo: client.getServerVersion(),
          tools: listed.tools.map((tool) => ({
            name: tool.name,
            title: tool.title,
            description: tool.description,
            inputSchema: tool.inputSchema,
          })),
        };
      });
    } catch (error) {
      throw new ResearchPlaneError(
        "RESEARCH_PROVIDER_PROBE_FAILED",
        `research provider ${route.providerRef} probe failed (${safeErrorClass(error)})`,
      );
    }
  }

  async callTool(
    route: ResearchProviderRoute,
    toolName: string,
    arguments_: Record<string, unknown>,
    timeoutMs: number,
    maxOutputCharacters: number,
    delivery?: { reference: true; previewCharacters: number },
  ): Promise<ResearchProviderToolResult> {
    try {
      return await this.withClient(route, timeoutMs, async (client) => {
        const listed = await client.listTools(undefined, {
          timeout: timeoutMs,
          maxTotalTimeout: timeoutMs,
        });
        if (!listed.tools.some((tool) => tool.name === toolName)) {
          throw new ResearchPlaneError(
            "RESEARCH_PROVIDER_TOOL_MISSING",
            `research provider ${route.providerRef} does not expose expected native tool ${toolName}`,
          );
        }
        const result = await client.callTool(
          { name: toolName, arguments: arguments_ },
          undefined,
          { timeout: timeoutMs, maxTotalTimeout: timeoutMs },
        );
        if (delivery?.reference) {
          if (!this.captures) throw new ResearchPlaneError("RESEARCH_CAPTURE_UNAVAILABLE", "No admitted capture store");
          return await this.captures.capture(result, {
            providerRef: route.providerRef, nativeTool: toolName, arguments: arguments_,
          }, delivery.previewCharacters);
        }
        return normalizeToolResult(result, maxOutputCharacters);
      });
    } catch (error) {
      if (error instanceof ResearchPlaneError) throw error;
      throw new ResearchPlaneError(
        "RESEARCH_PROVIDER_CALL_FAILED",
        `research provider ${route.providerRef} call failed (${safeErrorClass(error)})`,
      );
    }
  }
}

function requiredText(value: string | undefined, label: string, max: number): string {
  const normalized = value?.trim() ?? "";
  if (!normalized) {
    throw new ResearchPlaneError("RESEARCH_INPUT_INVALID", `${label} is required`);
  }
  if (normalized.includes("\0") || normalized.length > max) {
    throw new ResearchPlaneError(
      "RESEARCH_INPUT_INVALID",
      `${label} exceeds its bounded text contract`,
    );
  }
  return normalized;
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  label: string,
  minimum: number,
  maximum: number,
): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new ResearchPlaneError(
      "RESEARCH_INPUT_INVALID",
      `${label} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return resolved;
}

function validatedTargetUrls(urls: string[]): string[] {
  if (urls.length < 1 || urls.length > MAX_TARGET_URLS) {
    throw new ResearchPlaneError(
      "RESEARCH_INPUT_INVALID",
      `urls must contain between 1 and ${MAX_TARGET_URLS} HTTPS URLs`,
    );
  }
  return urls.map((value) => {
    const normalized = value.trim();
    if (!normalized || normalized.length > MAX_TARGET_URL_CHARACTERS) {
      throw new ResearchPlaneError(
        "RESEARCH_INPUT_INVALID",
        "target URL exceeds its bounded contract",
      );
    }
    let url: URL;
    try {
      url = new URL(normalized);
    } catch {
      throw new ResearchPlaneError(
        "RESEARCH_INPUT_INVALID",
        "target URL is invalid",
      );
    }
    if (url.protocol !== "https:" || url.username || url.password) {
      throw new ResearchPlaneError(
        "RESEARCH_INPUT_INVALID",
        "target URLs must be HTTPS and contain no userinfo",
      );
    }
    return url.toString();
  });
}

function routePublicView(route: ResearchProviderRoute): Record<string, unknown> {
  return {
    providerRef: route.providerRef,
    routeRef: route.routeRef,
    transport: "official_mcp_streamable_http",
    endpoint: route.endpoint,
    toolNames: [...route.expectedTools],
    credential: {
      kind: "service_environment_handle",
      environmentName: route.credentialEnvironment,
      present: Boolean(route.apiKey),
      optional: true,
      secretValueOrDigestExposed: false,
    },
  };
}

export class ResearchPlane {
  readonly config: ResearchPlaneConfig;

  private readonly client: ResearchMcpClient;
  constructor(
    config: ResearchPlaneConfig = researchPlaneConfigFromEnvironment(),
    client?: ResearchMcpClient,
    private readonly captures?: ResearchCaptureStore,
  ) {
    this.config = config;
    this.client = client ?? new NativeResearchMcpClient(captures);
  }

  async captureResource(uri: string): Promise<unknown> {
    if (!this.captures) throw new ResearchPlaneError("RESEARCH_CAPTURE_UNAVAILABLE", "No admitted capture store");
    return this.captures.resource(uri);
  }

  manifest(): Record<string, unknown> {
    return {
      schemaVersion: "devspace.native-research-plane.v1",
      state: "available",
      nativeComponent: "@modelcontextprotocol/sdk Client",
      transport: "Streamable HTTP",
      capabilityRoutes: {
        upstream_docs_resolve: {
          providerRef: "context7",
          nativeTool: "resolve-library-id",
          openWorldCandidateDiscoveryPerformed: false,
        },
        upstream_docs_query: {
          providerRef: "context7",
          nativeTool: "query-docs",
          openWorldCandidateDiscoveryPerformed: false,
        },
        open_world_search: {
          providerRef: "exa",
          nativeTool: "web_search_exa",
          openWorldCandidateDiscoveryPerformed: true,
        },
        known_source_fetch: {
          providerRef: "exa",
          nativeTool: "web_fetch_exa",
          openWorldCandidateDiscoveryPerformed: false,
        },
      },
      providers: [
        routePublicView(this.config.context7),
        routePublicView(this.config.exa),
      ],
      limits: {
        timeoutMs: this.config.timeoutMs,
        maxOutputCharacters: this.config.maxOutputCharacters,
        maxResults: MAX_RESULTS,
        maxTargetUrls: MAX_TARGET_URLS,
        maxFetchCharacters: MAX_FETCH_CHARACTERS,
      },
      compositionPolicy: {
        providerEndpointsAreServerConfigured: true,
        callerCanSupplyProviderEndpoint: false,
        callerCanSupplyCredentials: false,
        customSearchOrDocumentationEngineCreated: false,
        customRankingOrCacheCreated: false,
        providerOutputIsExternalUntrustedEvidence: true,
        researchCallGrantsSemanticOrMaterialAuthority: false,
        researchLifecycleOrMutationGateCreated: false,
        automaticProviderRetryPerformed: false,
      },
    };
  }

  async operate(input: ResearchOperateInput): Promise<Record<string, unknown>> {
    if (input.action === "capture_read") {
      if (!this.captures) throw new ResearchPlaneError("RESEARCH_CAPTURE_UNAVAILABLE", "No admitted capture store");
      return this.captures.read({ captureRef: input.captureRef ?? "", section: input.section,
        offset: input.offset, length: input.length, find: input.find });
    }
    if (input.responseMode !== undefined && !["inline", "reference"].includes(input.responseMode)) {
      throw new ResearchPlaneError("RESEARCH_INPUT_INVALID", "Unknown response mode");
    }
    if (input.responseMode === "reference" && !this.captures) {
      throw new ResearchPlaneError("RESEARCH_CAPTURE_UNAVAILABLE", "No admitted capture store; provider not called");
    }
    const previewCharacters = boundedInteger(input.previewCharacters, 4000, "previewCharacters", 1, 100000);
    if (input.action === "manifest") return {
      ...this.manifest(),
      delivery: { captureAvailable: Boolean(this.captures), defaultMode: "inline",
        referenceMode: "retain_native_parsed_response_before_normalization",
        captureRead: "manifest_text_structured_or_raw_unicode_window_without_provider_call" },
    };
    if (input.action === "probe") {
      return {
        schemaVersion: "devspace.native-research-probe.v1",
        providers: [
          await this.probe(this.config.context7),
          await this.probe(this.config.exa),
        ],
      };
    }

    let route: ResearchProviderRoute;
    let nativeTool: string;
    let arguments_: Record<string, unknown>;
    let openWorldCandidateDiscoveryPerformed: boolean;
    switch (input.action) {
      case "upstream_docs_resolve":
        route = this.config.context7;
        nativeTool = "resolve-library-id";
        arguments_ = {
          libraryName: requiredText(
            input.libraryName,
            "libraryName",
            MAX_LIBRARY_IDENTIFIER_CHARACTERS,
          ),
          query: requiredText(input.query, "query", MAX_QUERY_CHARACTERS),
        };
        openWorldCandidateDiscoveryPerformed = false;
        break;
      case "upstream_docs_query":
        route = this.config.context7;
        nativeTool = "query-docs";
        arguments_ = {
          libraryId: requiredText(
            input.libraryId,
            "libraryId",
            MAX_LIBRARY_IDENTIFIER_CHARACTERS,
          ),
          query: requiredText(input.query, "query", MAX_QUERY_CHARACTERS),
        };
        openWorldCandidateDiscoveryPerformed = false;
        break;
      case "open_world_search":
        route = this.config.exa;
        nativeTool = "web_search_exa";
        arguments_ = {
          query: requiredText(input.query, "query", MAX_QUERY_CHARACTERS),
          numResults: boundedInteger(
            input.maxResults,
            DEFAULT_MAX_RESULTS,
            "maxResults",
            1,
            MAX_RESULTS,
          ),
        };
        openWorldCandidateDiscoveryPerformed = true;
        break;
      case "known_source_fetch":
        route = this.config.exa;
        nativeTool = "web_fetch_exa";
        arguments_ = {
          urls: validatedTargetUrls(input.urls ?? []),
          maxCharacters: boundedInteger(
            input.maxCharacters,
            DEFAULT_MAX_FETCH_CHARACTERS,
            "maxCharacters",
            1,
            MAX_FETCH_CHARACTERS,
          ),
        };
        openWorldCandidateDiscoveryPerformed = false;
        break;
      default:
        throw new ResearchPlaneError(
          "RESEARCH_ACTION_UNSUPPORTED",
          `unsupported research action: ${String(input.action)}`,
        );
    }

    const result = await this.client.callTool(
      route,
      nativeTool,
      arguments_,
      this.config.timeoutMs,
      this.config.maxOutputCharacters,
      input.responseMode === "reference" ? { reference: true, previewCharacters } : undefined,
    );
    if (input.responseMode === "reference" && !result.capture) {
      throw new ResearchPlaneError("RESEARCH_CAPTURE_UNAVAILABLE", "Provider client returned no capture; no silent inline fallback");
    }
    if (result.isError && !result.capture) {
      const safeError = result.text.replaceAll("\n", " ").slice(0, 500);
      throw new ResearchPlaneError(
        "RESEARCH_PROVIDER_TOOL_ERROR",
        `research provider ${route.providerRef} returned a tool error: ${safeError || "unspecified provider error"}`,
      );
    }
    return {
      schemaVersion: "devspace.native-research-result.v1",
      action: input.action,
      providerRef: route.providerRef,
      routeRef: route.routeRef,
      transport: "official_mcp_streamable_http",
      nativeTool,
      openWorldCandidateDiscoveryPerformed,
      credential: {
        kind: "service_environment_handle",
        environmentName: route.credentialEnvironment,
        present: Boolean(route.apiKey),
        secretValueOrDigestExposed: false,
      },
      result: {
        text: result.text,
        structuredContent: result.structuredContent,
        contentTypes: result.contentTypes,
        textTruncated: result.textTruncated,
        structuredContentTruncated: result.structuredContentTruncated,
        isError: result.isError,
        ...(result.capture ? { capture: result.capture, preview: result.preview, nextRead: result.nextRead } : {}),
      },
      authority: {
        externalEvidenceOnly: true,
        semanticOrMaterialAuthorityGranted: false,
      },
    };
  }

  private async probe(route: ResearchProviderRoute): Promise<Record<string, unknown>> {
    try {
      const result = await this.client.listTools(route, this.config.timeoutMs);
      const discovered = new Set(result.tools.map((tool) => tool.name));
      const missingExpectedTools = route.expectedTools.filter(
        (tool) => !discovered.has(tool),
      );
      return {
        ...result,
        state: missingExpectedTools.length === 0 ? "available" : "degraded",
        expectedTools: [...route.expectedTools],
        missingExpectedTools,
        credentialPresent: Boolean(route.apiKey),
        secretValueOrDigestExposed: false,
      };
    } catch (error) {
      return {
        providerRef: route.providerRef,
        routeRef: route.routeRef,
        transport: "official_mcp_streamable_http",
        state: "unavailable",
        errorCode:
          error instanceof ResearchPlaneError
            ? error.code
            : "RESEARCH_PROVIDER_PROBE_FAILED",
        errorClass: safeErrorClass(error),
        credentialPresent: Boolean(route.apiKey),
        secretValueOrDigestExposed: false,
      };
    }
  }
}
