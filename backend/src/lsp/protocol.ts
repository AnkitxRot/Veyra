/**
 * Allowlisted JSON-RPC methods the browser may send to a language server.
 * Anything else — especially `workspace/executeCommand` — is dropped.
 *
 * `initialize` / `initialized` / `shutdown` / `exit` are backend-owned.
 */

export const CLIENT_NOTIFICATIONS = new Set<string>([
  "textDocument/didOpen",
  "textDocument/didChange",
  "textDocument/didClose",
  "$/cancelRequest",
]);

export const CLIENT_REQUESTS = new Set<string>([
  "textDocument/completion",
  "textDocument/hover",
  "textDocument/definition",
  "textDocument/references",
  "textDocument/documentSymbol",
  "textDocument/signatureHelp",
  "workspace/symbol",
  "completionItem/resolve",
]);

export const SERVER_REQUESTS_HANDLED = new Set<string>([
  "window/workDoneProgress/create",
  "workspace/configuration",
  "workspace/workspaceFolders",
  "client/registerCapability",
  "client/unregisterCapability",
]);

export const SERVER_NOTIFICATIONS_FORWARDED = new Set<string>([
  "textDocument/publishDiagnostics",
]);

export function isAllowedClientNotification(method: string): boolean {
  return CLIENT_NOTIFICATIONS.has(method);
}

export function isAllowedClientRequest(method: string): boolean {
  return CLIENT_REQUESTS.has(method);
}

export function clientMethodAllowed(method: string): boolean {
  return (
    isAllowedClientNotification(method) || isAllowedClientRequest(method)
  );
}
