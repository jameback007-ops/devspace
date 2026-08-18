import { createConnection } from "node:net";
import type { ConversationTransportConfig } from "./config.js";
import type {
  ConversationBridgeRequest,
  ConversationBridgeResponse,
  ConversationBridgeTargetStatus,
  ConversationBridgeDeliveryReceipt,
} from "./conversation-transport-bridge-protocol.js";

const MAX_RESPONSE_BYTES = 1024 * 1024;

export interface ConversationTransportBridgePort {
  status(targetAlias: string): Promise<ConversationBridgeTargetStatus>;
  deliver(
    request: Extract<ConversationBridgeRequest, { command: "deliver" }>,
  ): Promise<ConversationBridgeDeliveryReceipt>;
  reconcile(
    request: Extract<ConversationBridgeRequest, { command: "reconcile" }>,
  ): Promise<ConversationBridgeDeliveryReceipt>;
}

export class ConversationTransportBridgeClient
  implements ConversationTransportBridgePort {
  constructor(readonly config: ConversationTransportConfig) {}

  async status(targetAlias: string): Promise<ConversationBridgeTargetStatus> {
    const response = await this.request({
      schemaVersion: 1,
      command: "status",
      targetAlias,
    });
    if (response.ok && response.command === "status") return response.status;
    throw bridgeError(response);
  }

  async deliver(
    request: Extract<ConversationBridgeRequest, { command: "deliver" }>,
  ): Promise<ConversationBridgeDeliveryReceipt> {
    const response = await this.request(request);
    if (response.ok && response.command === "deliver") return response.receipt;
    throw bridgeError(response);
  }

  async reconcile(
    request: Extract<ConversationBridgeRequest, { command: "reconcile" }>,
  ): Promise<ConversationBridgeDeliveryReceipt> {
    const response = await this.request(request);
    if (response.ok && response.command === "reconcile") return response.receipt;
    throw bridgeError(response);
  }

  private async request(
    request: ConversationBridgeRequest,
  ): Promise<ConversationBridgeResponse> {
    return await new Promise((resolve, reject) => {
      const socket = createConnection({ path: this.config.bridgeSocketPath });
      const chunks: Buffer[] = [];
      let size = 0;
      let settled = false;
      const finish = (
        callback: () => void,
      ): void => {
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
          socket.destroy(new Error("Conversation transport bridge response exceeded 1 MiB"));
          return;
        }
        chunks.push(chunk);
      });
      socket.on("timeout", () => {
        socket.destroy(new Error("Conversation transport bridge timed out"));
      });
      socket.on("error", (error) => finish(() => reject(error)));
      socket.on("end", () => finish(() => {
        try {
          const raw = Buffer.concat(chunks).toString("utf8").trim();
          if (!raw) throw new Error("Conversation transport bridge returned an empty response");
          resolve(JSON.parse(raw) as ConversationBridgeResponse);
        } catch (error) {
          reject(error);
        }
      }));
    });
  }
}

function bridgeError(response: ConversationBridgeResponse): Error {
  if (!response.ok) {
    const error = new Error(
      `Conversation transport bridge rejected the request: ${response.errorCode}`,
    );
    Object.assign(error, {
      code: response.errorCode,
      retryDisposition: response.retryDisposition,
      errorDigestSha256: response.errorDigestSha256,
    });
    return error;
  }
  return new Error(`Unexpected conversation transport bridge response: ${response.command}`);
}
