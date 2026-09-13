import { describe, it, expect } from "vitest";
import { LspBridge, type LspTransport } from "../src/lsp/bridge";

function mockTransport(): LspTransport & {
  handlers: Set<(p: unknown) => void>;
  sent: unknown[];
  closed: boolean;
} {
  const handlers = new Set<(p: unknown) => void>();
  const closeHandlers = new Set<() => void>();
  return {
    handlers,
    sent: [] as unknown[],
    closed: false,
    send(payload) {
      this.sent.push(payload);
    },
    onMessage(cb) {
      handlers.add(cb);
      return () => handlers.delete(cb);
    },
    onClose(cb) {
      closeHandlers.add(cb);
      return () => closeHandlers.delete(cb);
    },
    close() {
      this.closed = true;
    },
  };
}

describe("LspBridge", () => {
  it("ignores traffic until status is ready, then requests complete", async () => {
    const t = mockTransport();
    const bridge = new LspBridge(t);
    const pending = bridge.request("textDocument/hover", { n: 1 });
    expect(t.sent).toHaveLength(0);
    t.handlers.forEach((cb) =>
      cb({ type: "status", state: "ready", language: "python" }),
    );
    const pending2 = bridge.request("textDocument/hover", {
      textDocument: { uri: "file:///workspace/main.py" },
    });
    expect(t.sent).toHaveLength(1);
    const req = t.sent[0] as { id: number };
    t.handlers.forEach((cb) =>
      cb({ jsonrpc: "2.0", id: req.id, result: { contents: "hi" } }),
    );
    expect(await pending).toBeNull();
    expect(await pending2).toEqual({ contents: "hi" });
    bridge.dispose();
    expect(t.closed).toBe(true);
  });

  it("forwards diagnostics for workspace uris and drops escapes", () => {
    const t = mockTransport();
    const bridge = new LspBridge(t);
    const seen: { uri: string; n: number }[] = [];
    bridge.onDiagnostics = (uri, items) => seen.push({ uri, n: items.length });
    t.handlers.forEach((cb) =>
      cb({
        jsonrpc: "2.0",
        method: "textDocument/publishDiagnostics",
        params: {
          uri: "file:///workspace/main.py",
          diagnostics: [{ message: "x", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }],
        },
      }),
    );
    t.handlers.forEach((cb) =>
      cb({
        jsonrpc: "2.0",
        method: "textDocument/publishDiagnostics",
        params: { uri: "file:///etc/passwd", diagnostics: [{ message: "nope" }] },
      }),
    );
    expect(seen).toEqual([{ uri: "main.py", n: 1 }]);
    bridge.dispose();
  });
});

describe("didOpen uses workspace uris", () => {
  it("never sends a client-supplied executable", () => {
    const t = mockTransport();
    const bridge = new LspBridge(t);
    t.handlers.forEach((cb) =>
      cb({ type: "status", state: "ready", language: "python" }),
    );
    bridge.didOpen("main.py", "print(1)\n", "python");
    expect(t.sent[0]).toMatchObject({
      method: "textDocument/didOpen",
      params: {
        textDocument: { uri: "file:///workspace/main.py", languageId: "python" },
      },
    });
    expect(JSON.stringify(t.sent)).not.toMatch(/pylsp|executable|docker/);
    bridge.dispose();
  });
});
