import { describe, it, expect } from "vitest";
import {
  clientMethodAllowed,
  isAllowedClientRequest,
  isAllowedClientNotification,
} from "../src/lsp/protocol.js";

describe("lsp method allowlist", () => {
  it("allows intelligence methods", () => {
    expect(isAllowedClientRequest("textDocument/completion")).toBe(true);
    expect(isAllowedClientRequest("textDocument/hover")).toBe(true);
    expect(isAllowedClientRequest("textDocument/definition")).toBe(true);
    expect(isAllowedClientRequest("textDocument/references")).toBe(true);
    expect(isAllowedClientRequest("textDocument/signatureHelp")).toBe(true);
    expect(isAllowedClientRequest("workspace/symbol")).toBe(true);
    expect(isAllowedClientNotification("textDocument/didOpen")).toBe(true);
    expect(isAllowedClientNotification("textDocument/didChange")).toBe(true);
    expect(isAllowedClientNotification("textDocument/didClose")).toBe(true);
  });

  it("blocks command execution and process control", () => {
    expect(clientMethodAllowed("workspace/executeCommand")).toBe(false);
    expect(clientMethodAllowed("initialize")).toBe(false);
    expect(clientMethodAllowed("shutdown")).toBe(false);
    expect(clientMethodAllowed("exit")).toBe(false);
    expect(clientMethodAllowed("workspace/applyEdit")).toBe(false);
    expect(clientMethodAllowed("window/showMessageRequest")).toBe(false);
  });
});
