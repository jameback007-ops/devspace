import assert from "node:assert/strict";
import type { CodexIntegrationConfig } from "./config.js";
import type {
  CodexGatewayRequest,
  CodexIntegrationPort,
} from "./codex-integration-protocol.js";
import {
  CodexIntegrationRuntime,
  codexIntegrationToolNames,
} from "./codex-integration-tools.js";

class FakePort implements CodexIntegrationPort {
  readonly requests: CodexGatewayRequest[] = [];

  async request(request: CodexGatewayRequest): Promise<unknown> {
    this.requests.push(request);
    return {
      echoedCommand: request.command,
      received: request,
    };
  }
}

const config: CodexIntegrationConfig = {
  enabled: true,
  bridgeSocketPath: "/tmp/not-used-codex-gateway.sock",
  bridgeTimeoutMs: 30_000,
};

{
  const port = new FakePort();
  const runtime = new CodexIntegrationRuntime(config, { port });
  const result = await runtime.request("codex_session_read", {
    sessionRef: "cdx_ses_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    turnLimit: 25,
  }) as {
    echoedCommand: string;
    received: CodexGatewayRequest;
  };
  assert.equal(result.echoedCommand, "codex_session_read");
  assert.deepEqual(result.received, {
    schemaVersion: 1,
    command: "codex_session_read",
    sessionRef: "cdx_ses_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    turnLimit: 25,
  });
  assert.equal(port.requests.length, 1);
}

{
  const names = Object.values(codexIntegrationToolNames);
  assert.equal(new Set(names).size, names.length);
  assert.deepEqual(names, [
    "codex_gateway_status",
    "codex_session_list",
    "codex_session_read",
    "codex_session_activity",
    "codex_session_metrics",
    "codex_account_usage",
    "codex_model_list",
    "codex_live_events",
    "codex_approval_list",
    "codex_session_open",
    "codex_turn_control",
    "codex_session_control",
    "codex_approval_respond",
    "codex_effect_status",
  ]);
  assert.equal(names.some((name) => name.includes("rpc")), false);
}

{
  const port = new FakePort();
  const runtime = new CodexIntegrationRuntime(config, { port });
  await runtime.request("codex_turn_control", {
    action: "submit",
    sessionRef: "cdx_ses_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    message: "coordinate the exact active mission",
    idempotencyKey: "codex-turn-submit-test",
  });
  const request = port.requests[0];
  assert.equal(request.schemaVersion, 1);
  assert.equal(request.command, "codex_turn_control");
  assert.equal(request.idempotencyKey, "codex-turn-submit-test");
  assert.equal("threadId" in request, false);
  assert.equal("socketPath" in request, false);
  assert.equal("method" in request, false);
}

{
  const port = new FakePort();
  const runtime = new CodexIntegrationRuntime(config, { port });
  await runtime.request("codex_gateway_status", {
    command: "codex_turn_control",
    schemaVersion: 999,
  });
  assert.equal(port.requests[0]?.command, "codex_gateway_status");
  assert.equal(port.requests[0]?.schemaVersion, 1);
}
