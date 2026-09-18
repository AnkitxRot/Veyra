/**
 * LSP stdio framing: `Content-Length: N\r\n\r\n<body>`.
 *
 * Bounded: a stream that exceeds `maxBytes` (headers + unread body) is
 * treated as a protocol failure so a noisy/malicious server cannot grow
 * the buffer without limit.
 */

export interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export const DEFAULT_LSP_MESSAGE_MAX_BYTES = 1024 * 1024;

export function encodeLspFrame(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii");
  return Buffer.concat([header, body]);
}

export class LspFrameParser {
  private buf = Buffer.alloc(0);
  private readonly maxBytes: number;

  constructor(maxBytes = DEFAULT_LSP_MESSAGE_MAX_BYTES) {
    this.maxBytes = maxBytes;
  }

  get bufferedBytes(): number {
    return this.buf.length;
  }

  push(chunk: Buffer): JsonRpcMessage[] {
    if (chunk.length === 0) return [];
    this.buf = Buffer.concat([this.buf, chunk]);
    if (this.buf.length > this.maxBytes) {
      this.buf = Buffer.alloc(0);
      throw new Error("lsp_buffer_exceeded");
    }

    const out: JsonRpcMessage[] = [];
    while (true) {
      const headerEnd = indexOfHeaderEnd(this.buf);
      if (headerEnd < 0) break;
      const header = this.buf.subarray(0, headerEnd).toString("ascii");
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) {
        this.buf = Buffer.alloc(0);
        throw new Error("lsp_malformed_header");
      }
      const len = Number(match[1]);
      if (!Number.isInteger(len) || len < 0 || len > this.maxBytes) {
        this.buf = Buffer.alloc(0);
        throw new Error("lsp_message_too_large");
      }
      const bodyStart = headerEnd + 4;
      if (this.buf.length < bodyStart + len) break;
      const body = this.buf.subarray(bodyStart, bodyStart + len).toString("utf8");
      this.buf = this.buf.subarray(bodyStart + len);
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        throw new Error("lsp_malformed_json");
      }
      if (!parsed || typeof parsed !== "object") {
        throw new Error("lsp_malformed_json");
      }
      out.push(parsed as JsonRpcMessage);
    }
    return out;
  }

  reset(): void {
    this.buf = Buffer.alloc(0);
  }
}

function indexOfHeaderEnd(buf: Buffer): number {
  for (let i = 0; i + 3 < buf.length; i++) {
    if (
      buf[i] === 13 &&
      buf[i + 1] === 10 &&
      buf[i + 2] === 13 &&
      buf[i + 3] === 10
    ) {
      return i;
    }
  }
  return -1;
}

export function isJsonRpcRequest(
  msg: JsonRpcMessage,
): msg is JsonRpcMessage & { method: string; id: string | number } {
  return (
    typeof msg.method === "string" &&
    (typeof msg.id === "string" || typeof msg.id === "number")
  );
}

export function isJsonRpcNotification(
  msg: JsonRpcMessage,
): msg is JsonRpcMessage & { method: string } {
  return typeof msg.method === "string" && msg.id === undefined;
}

export function isJsonRpcResponse(
  msg: JsonRpcMessage,
): boolean {
  return (
    (typeof msg.id === "string" || typeof msg.id === "number") &&
    msg.method === undefined &&
    ("result" in msg || "error" in msg)
  );
}
