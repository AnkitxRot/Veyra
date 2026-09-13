import { describe, it, expect } from "vitest";
import {
  encodeLspFrame,
  LspFrameParser,
  isJsonRpcRequest,
  isJsonRpcNotification,
  isJsonRpcResponse,
} from "../src/lsp/jsonrpc.js";

describe("lsp jsonrpc framing", () => {
  it("round-trips a request", () => {
    const parser = new LspFrameParser();
    const msg = { jsonrpc: "2.0", id: 1, method: "initialize", params: {} };
    const frames = parser.push(encodeLspFrame(msg));
    expect(frames).toEqual([msg]);
    expect(isJsonRpcRequest(frames[0])).toBe(true);
  });

  it("assembles a message split across chunks", () => {
    const parser = new LspFrameParser();
    const buf = encodeLspFrame({ jsonrpc: "2.0", method: "exit" });
    expect(parser.push(buf.subarray(0, 8))).toEqual([]);
    const rest = parser.push(buf.subarray(8));
    expect(rest).toHaveLength(1);
    expect(isJsonRpcNotification(rest[0])).toBe(true);
  });

  it("rejects an oversized content-length", () => {
    const parser = new LspFrameParser(64);
    expect(() =>
      parser.push(Buffer.from("Content-Length: 99999\r\n\r\n", "ascii")),
    ).toThrow(/lsp_message_too_large/);
  });

  it("rejects a buffer that grows past maxBytes", () => {
    const parser = new LspFrameParser(32);
    expect(() => parser.push(Buffer.alloc(40, 97))).toThrow(/lsp_buffer_exceeded/);
  });

  it("rejects malformed json bodies", () => {
    const parser = new LspFrameParser();
    expect(() =>
      parser.push(Buffer.from("Content-Length: 3\r\n\r\n{x}", "ascii")),
    ).toThrow(/lsp_malformed_json/);
  });

  it("identifies responses", () => {
    expect(isJsonRpcResponse({ jsonrpc: "2.0", id: 1, result: null })).toBe(
      true,
    );
    expect(isJsonRpcResponse({ jsonrpc: "2.0", method: "x" })).toBe(false);
  });
});
