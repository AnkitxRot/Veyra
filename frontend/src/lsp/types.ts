export type LspSessionState =
  | "starting"
  | "ready"
  | "restarting"
  | "failed"
  | "unavailable"
  | "busy"
  | "stopped";

export interface LspStatus {
  state: LspSessionState;
  language: string;
  message?: string;
}

export interface LspDiagnostic {
  uri: string;
  severity: number;
  message: string;
  source?: string;
  code?: string | number;
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
}

export interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

export const LSP_STATUS_EVENT = "ide-lsp-status";
export const LSP_DIAGNOSTICS_EVENT = "ide-lsp-diagnostics";
export const LSP_OPEN_REVEAL_EVENT = "ide-open-and-reveal";
