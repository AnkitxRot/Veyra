#!/usr/bin/env node
/**
 * Minimal LSP stdio server for M81 tests. Speaks Content-Length framing.
 * Behaviour is selected via env:
 *   FAKE_LSP_CRASH=1     exit after initialize
 *   FAKE_LSP_SLOW=1      hang on initialize
 *   FAKE_LSP_MALFORMED=1 write garbage after initialize
 */

function encode(msg) {
  const body = Buffer.from(JSON.stringify(msg), "utf8");
  return Buffer.concat([
    Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"),
    body,
  ]);
}

let buf = Buffer.alloc(0);
const docs = new Map();

function send(msg) {
  process.stdout.write(encode(msg));
}

function onMessage(msg) {
  if (msg.method === "initialize") {
    if (process.env.FAKE_LSP_SLOW === "1") return;
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        capabilities: {
          textDocumentSync: 1,
          completionProvider: { triggerCharacters: ["."] },
          hoverProvider: true,
          definitionProvider: true,
          referencesProvider: true,
          documentSymbolProvider: true,
          signatureHelpProvider: { triggerCharacters: ["(", ","] },
          workspaceSymbolProvider: true,
        },
      },
    });
    if (process.env.FAKE_LSP_CRASH === "1") {
      setTimeout(() => process.exit(1), 20);
    }
    if (process.env.FAKE_LSP_MALFORMED === "1") {
      process.stdout.write("Content-Length: 5\r\n\r\n{{{{{\n");
    }
    return;
  }
  if (msg.method === "initialized" || msg.method === "exit") {
    if (msg.method === "exit") process.exit(0);
    return;
  }
  if (msg.method === "shutdown") {
    send({ jsonrpc: "2.0", id: msg.id, result: null });
    return;
  }
  if (msg.method === "textDocument/didOpen") {
    const td = msg.params?.textDocument;
    if (td?.uri) docs.set(td.uri, td.text ?? "");
    publish(td?.uri);
    return;
  }
  if (msg.method === "textDocument/didChange") {
    const uri = msg.params?.textDocument?.uri;
    const text = msg.params?.contentChanges?.[0]?.text;
    if (uri && typeof text === "string") docs.set(uri, text);
    publish(uri);
    return;
  }
  if (msg.method === "textDocument/didClose") {
    docs.delete(msg.params?.textDocument?.uri);
    return;
  }
  if (msg.method === "textDocument/completion") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        isIncomplete: false,
        items: [
          { label: "hello", kind: 3, insertText: "hello" },
          { label: "world", kind: 6, insertText: "world" },
        ],
      },
    });
    return;
  }
  if (msg.method === "textDocument/hover") {
    const uri = msg.params?.textDocument?.uri;
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        contents: { kind: "markdown", value: "fake hover for " + uri },
      },
    });
    return;
  }
  if (msg.method === "textDocument/definition") {
    const uri = msg.params?.textDocument?.uri;
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        uri,
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 5 },
        },
      },
    });
    return;
  }
  if (msg.method === "textDocument/references") {
    const uri = msg.params?.textDocument?.uri;
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: [
        {
          uri,
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 5 },
          },
        },
      ],
    });
    return;
  }
  if (msg.method === "textDocument/documentSymbol") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: [
        {
          name: "main",
          kind: 12,
          range: {
            start: { line: 0, character: 0 },
            end: { line: 10, character: 0 },
          },
          selectionRange: {
            start: { line: 0, character: 4 },
            end: { line: 0, character: 8 },
          },
        },
      ],
    });
    return;
  }
  if (msg.method === "workspace/symbol") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: [
        {
          name: "main",
          kind: 12,
          location: {
            uri: "file:///workspace/main.py",
            range: {
              start: { line: 0, character: 4 },
              end: { line: 0, character: 8 },
            },
          },
        },
      ],
    });
    return;
  }
  if (msg.method === "workspace/executeCommand") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: { executed: true, command: msg.params?.command },
    });
    return;
  }
  if (typeof msg.id === "number" || typeof msg.id === "string") {
    send({ jsonrpc: "2.0", id: msg.id, result: null });
  }
}

function publish(uri) {
  if (!uri) return;
  const text = docs.get(uri) ?? "";
  const diagnostics = [];
  if (text.includes("undefined_name")) {
    diagnostics.push({
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 14 },
      },
      severity: 1,
      source: "pyflakes",
      message: "undefined name 'undefined_name'",
    });
  }
  send({
    jsonrpc: "2.0",
    method: "textDocument/publishDiagnostics",
    params: { uri, diagnostics },
  });
}

process.stdin.on("data", (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  while (true) {
    const headerEnd = buf.indexOf("\r\n\r\n");
    if (headerEnd < 0) break;
    const header = buf.subarray(0, headerEnd).toString("ascii");
    const m = /Content-Length:\s*(\d+)/i.exec(header);
    if (!m) {
      buf = Buffer.alloc(0);
      break;
    }
    const len = Number(m[1]);
    const start = headerEnd + 4;
    if (buf.length < start + len) break;
    const body = buf.subarray(start, start + len).toString("utf8");
    buf = buf.subarray(start + len);
    try {
      onMessage(JSON.parse(body));
    } catch {
      /* ignore */
    }
  }
});
