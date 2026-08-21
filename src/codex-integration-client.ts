import { createConnection } from "node:net";
import type { CodexIntegrationConfig } from "./config.js";
import type {
  CodexGatewayRequest,
  CodexGatewayResponse,
  CodexIntegrationPort,
} from "./codex-integration-protocol.js";

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export class CodexIntegrationClient implements CodexIntegrationPort {
  constructor(readonly config: CodexIntegrationConfig) {}

  async request(request: CodexGatewayRequest): Promise<unknown> {
    const response = await this.exchange(request);
    if (response.ok && response.command === request.command) {
      return response.data;
    }
    throw gatewayError(response, request.command);
  }

  private async exchange(
    request: CodexGatewayRequest,
  ): Promise<CodexGatewayResponse> {
    return await new Promise((resolve, reject) => {
      const socket = createConnection({ path: this.config.bridgeSocketPath });
      const chunks: Buffer[] = [];
      let size = 0;
      let settled = false;
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        callback();
      };

      socket.setTimeout(this.config.bridgeTimeoutMs);
      socket.on("connect", () => {
        socket.end(`${JSON.stringify(request)}\n`);
      });
      socket.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) {
          socket.destroy(new Error("Codex integration gateway response exceeded 8 MiB"));
          return;
        }
        chunks.push(chunk);
      });
      socket.on("timeout", () => {
        socket.destroy(new Error("Codex integration gateway timed out"));
      });
      socket.on("error", (error) => finish(() => reject(error)));
      socket.on("end", () => finish(() => {
        try {
          const raw = Buffer.concat(chunks).toString("utf8").trim();
          if (!raw) throw new Error("Codex integration gateway returned an empty response");
          resolve(JSON.parse(raw) as CodexGatewayResponse);
        } catch (error) {
          reject(error);
        }
      }));
    });
  }
}

function gatewayError(
  response: CodexGatewayResponse,
  command: string,
): Error {
  if (!response.ok) {
    const error = new Error(
      `Codex integration gateway rejected ${command}: ${response.errorCode}`,
    );
    Object.assign(error, {
      code: response.errorCode,
      retryDisposition: response.retryDisposition,
      errorDigestSha256: response.errorDigestSha256,
    });
    return error;
  }
  return new Error(
    `Unexpected Codex integration gateway response: ${response.command}`,
  );
}
