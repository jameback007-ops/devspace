import assert from "node:assert/strict";
import test from "node:test";
import {
  ResearchPlane,
  ResearchPlaneError,
  researchPlaneConfigFromEnvironment,
  type ResearchMcpClient,
  type ResearchPlaneConfig,
  type ResearchProviderRoute,
  type ResearchProviderToolResult,
  type ResearchProviderToolSurface,
} from "./research-plane.js";

function config(): ResearchPlaneConfig {
  return researchPlaneConfigFromEnvironment({
    CONTEXT7_API_KEY: "context7-secret",
    EXA_API_KEY: "exa-secret",
    DEVSPACE_RESEARCH_TIMEOUT_SECONDS: "7",
    DEVSPACE_RESEARCH_MAX_OUTPUT_CHARACTERS: "5000",
  });
}

class FakeClient implements ResearchMcpClient {
  calls: Array<{
    providerRef: string;
    toolName: string;
    arguments_: Record<string, unknown>;
    timeoutMs: number;
    maxOutputCharacters: number;
  }> = [];

  surfaces = new Map<string, ResearchProviderToolSurface>([
    [
      "context7",
      {
        providerRef: "context7",
        routeRef: "provider.context7.official-hosted-mcp",
        transport: "official_mcp_streamable_http",
        protocolVersion: "2025-11-25",
        tools: [
          { name: "resolve-library-id" },
          { name: "query-docs" },
        ],
      },
    ],
    [
      "exa",
      {
        providerRef: "exa",
        routeRef: "provider.exa.official-hosted-mcp",
        transport: "official_mcp_streamable_http",
        protocolVersion: "2025-11-25",
        tools: [
          { name: "web_search_exa" },
          { name: "web_fetch_exa" },
        ],
      },
    ],
  ]);

  result: ResearchProviderToolResult = {
    text: "provider result",
    structuredContent: { rows: 2 },
    contentTypes: ["text"],
    textTruncated: false,
    structuredContentTruncated: false,
    isError: false,
  };

  async listTools(
    route: ResearchProviderRoute,
    _timeoutMs: number,
  ): Promise<ResearchProviderToolSurface> {
    const surface = this.surfaces.get(route.providerRef);
    if (!surface) throw new Error("surface unavailable");
    return surface;
  }

  async callTool(
    route: ResearchProviderRoute,
    toolName: string,
    arguments_: Record<string, unknown>,
    timeoutMs: number,
    maxOutputCharacters: number,
  ): Promise<ResearchProviderToolResult> {
    this.calls.push({
      providerRef: route.providerRef,
      toolName,
      arguments_,
      timeoutMs,
      maxOutputCharacters,
    });
    return this.result;
  }
}

test("native research manifest exposes capability routes without secret material", () => {
  const plane = new ResearchPlane(config(), new FakeClient());
  const manifest = plane.manifest();
  const serialized = JSON.stringify(manifest);
  assert.equal(manifest.schemaVersion, "devspace.native-research-plane.v1");
  assert.equal(manifest.state, "available");
  assert.match(serialized, /open_world_search/);
  assert.match(serialized, /known_source_fetch/);
  assert.equal(serialized.includes("context7-secret"), false);
  assert.equal(serialized.includes("exa-secret"), false);
  assert.match(serialized, /secretValueOrDigestExposed/);
});

test("probe reports exact native provider tool availability", async () => {
  const plane = new ResearchPlane(config(), new FakeClient());
  const result = await plane.operate({ action: "probe" });
  const providers = result.providers as Array<Record<string, unknown>>;
  assert.equal(providers.length, 2);
  assert.deepEqual(
    providers.map((provider) => provider.state),
    ["available", "available"],
  );
  assert.deepEqual(providers[0]?.missingExpectedTools, []);
  assert.deepEqual(providers[1]?.missingExpectedTools, []);
});

test("open-world search maps to Exa without caller-controlled endpoint or credentials", async () => {
  const client = new FakeClient();
  const plane = new ResearchPlane(config(), client);
  const result = await plane.operate({
    action: "open_world_search",
    query: "primary sources about evaluator succession",
    maxResults: 11,
  });
  assert.deepEqual(client.calls, [
    {
      providerRef: "exa",
      toolName: "web_search_exa",
      arguments_: {
        query: "primary sources about evaluator succession",
        numResults: 11,
      },
      timeoutMs: 7000,
      maxOutputCharacters: 5000,
    },
  ]);
  assert.equal(result.openWorldCandidateDiscoveryPerformed, true);
  assert.equal(result.nativeTool, "web_search_exa");
  assert.equal(
    JSON.stringify(result).includes("exa-secret"),
    false,
  );
});

test("Context7 resolve and query remain distinct operations", async () => {
  const client = new FakeClient();
  const plane = new ResearchPlane(config(), client);
  await plane.operate({
    action: "upstream_docs_resolve",
    libraryName: "Temporal",
    query: "workflow versioning documentation",
  });
  await plane.operate({
    action: "upstream_docs_query",
    libraryId: "/temporalio/documentation",
    query: "workflow versioning documentation",
  });
  assert.deepEqual(
    client.calls.map((call) => [call.providerRef, call.toolName]),
    [
      ["context7", "resolve-library-id"],
      ["context7", "query-docs"],
    ],
  );
});

test("known-source fetch accepts bounded HTTPS targets and rejects userinfo", async () => {
  const client = new FakeClient();
  const plane = new ResearchPlane(config(), client);
  await plane.operate({
    action: "known_source_fetch",
    urls: ["https://example.test/report"],
    maxCharacters: 9000,
  });
  assert.deepEqual(client.calls[0]?.arguments_, {
    urls: ["https://example.test/report"],
    maxCharacters: 9000,
  });
  await assert.rejects(
    plane.operate({
      action: "known_source_fetch",
      urls: ["https://user:secret@example.test/report"],
    }),
    (error: unknown) =>
      error instanceof ResearchPlaneError
      && error.code === "RESEARCH_INPUT_INVALID",
  );
});

test("provider tool errors remain bounded external failures", async () => {
  const client = new FakeClient();
  client.result = {
    ...client.result,
    text: "provider refused the request\nwithout exposing credentials",
    isError: true,
  };
  const plane = new ResearchPlane(config(), client);
  await assert.rejects(
    plane.operate({
      action: "open_world_search",
      query: "test",
    }),
    (error: unknown) =>
      error instanceof ResearchPlaneError
      && error.code === "RESEARCH_PROVIDER_TOOL_ERROR"
      && !error.message.includes("exa-secret"),
  );
});

test("invalid provider endpoints and limits fail before provider execution", () => {
  assert.throws(
    () => researchPlaneConfigFromEnvironment({
      DEVSPACE_RESEARCH_EXA_ENDPOINT:
        "https://user:secret@example.test/mcp",
    }),
    /without userinfo/,
  );
  assert.throws(
    () => researchPlaneConfigFromEnvironment({
      DEVSPACE_RESEARCH_TIMEOUT_SECONDS: "0",
    }),
    /integer between 1 and 180/,
  );
});

test("a degraded probe names missing expected tools without throwing", async () => {
  const client = new FakeClient();
  client.surfaces.set("exa", {
    providerRef: "exa",
    routeRef: "provider.exa.official-hosted-mcp",
    transport: "official_mcp_streamable_http",
    tools: [{ name: "web_search_exa" }],
  });
  const plane = new ResearchPlane(config(), client);
  const result = await plane.operate({ action: "probe" });
  const exa = (result.providers as Array<Record<string, unknown>>)[1];
  assert.equal(exa?.state, "degraded");
  assert.deepEqual(exa?.missingExpectedTools, ["web_fetch_exa"]);
});
