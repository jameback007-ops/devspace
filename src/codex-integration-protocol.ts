export type CodexGatewayCommand =
  | "codex_gateway_status"
  | "codex_session_list"
  | "codex_session_read"
  | "codex_session_activity"
  | "codex_session_metrics"
  | "codex_account_usage"
  | "codex_model_list"
  | "codex_live_events"
  | "codex_approval_list"
  | "codex_session_open"
  | "codex_turn_control"
  | "codex_session_control"
  | "codex_approval_respond"
  | "codex_effect_status";

interface CodexGatewayRequestBase {
  schemaVersion: 1;
  command: CodexGatewayCommand;
}

export type CodexGatewayRequest = CodexGatewayRequestBase & Record<string, unknown>;

export type CodexGatewayResponse =
  | {
    schemaVersion: 1;
    ok: true;
    command: CodexGatewayCommand;
    data: unknown;
  }
  | {
    schemaVersion: 1;
    ok: false;
    errorCode: string;
    errorDigestSha256: string;
    retryDisposition:
      | "safe_after_correction"
      | "reconcile_first"
      | "forbidden"
      | string;
  };

export interface CodexIntegrationPort {
  request(request: CodexGatewayRequest): Promise<unknown>;
}
