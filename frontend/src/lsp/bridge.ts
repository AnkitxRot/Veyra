import type { JsonRpcMessage, LspDiagnostic, LspStatus } from "./types";
import { fromWorkspaceUri, toWorkspaceUri } from "./uri";

export interface LspTransport {
  send(payload: unknown): void;
  onMessage(cb: (payload: unknown) => void): () => void;
  onClose(cb: () => void): () => void;
  close(): void;
}

type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
};

const REQUEST_TIMEOUT_MS = 8_000;

/**
 * Browser-side JSON-RPC client for `/ws/lsp`. One instance per project
 * connection. Does not own Monaco providers (those are process-wide).
 */
export class LspBridge {
  private id = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly unsub: () => void;
  private disposed = false;
  onStatus: ((status: LspStatus) => void) | null = null;
  onDiagnostics: ((uri: string, items: LspDiagnostic[]) => void) | null = null;
  status: LspStatus = { state: "starting", language: "python" };

  constructor(private readonly transport: LspTransport) {
    this.unsub = transport.onMessage((payload) => this.onPayload(payload));
  }

  didOpen(relPath: string, text: string): void {
    const uri = toWorkspaceUri(relPath);
    if (!uri) return;
    this.notify("textDocument/didOpen", {
      textDocument: {
        uri,
        languageId: "python",
        version: 1,
        text,
      },
    });
  }

  didChange(relPath: string, text: string): void {
    const uri = toWorkspaceUri(relPath);
    if (!uri) return;
    this.notify("textDocument/didChange", {
      textDocument: { uri, version: 1 },
      contentChanges: [{ text }],
    });
  }

  didClose(relPath: string): void {
    const uri = toWorkspaceUri(relPath);
    if (!uri) return;
    this.notify("textDocument/didClose", {
      textDocument: { uri },
    });
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.disposed || this.status.state !== "ready") {
      return Promise.resolve(null);
    }
    const id = this.id++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(null);
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      this.transport.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsub();
    for (const p of this.pending.values()) p.resolve(null);
    this.pending.clear();
    this.transport.close();
  }

  private notify(method: string, params: unknown): void {
    if (this.disposed) return;
    this.transport.send({ jsonrpc: "2.0", method, params });
  }

  private onPayload(payload: unknown): void {
    if (!payload || typeof payload !== "object") return;
    const msg = payload as JsonRpcMessage & LspStatus & { type?: string };
    if (msg.type === "status") {
      this.status = {
        state: msg.state,
        language: msg.language,
        message: msg.message,
      };
      this.onStatus?.(this.status);
      return;
    }
    if (typeof msg.id === "number" && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      if (msg.error) p.resolve(null);
      else p.resolve(msg.result);
      return;
    }
    if (msg.method === "textDocument/publishDiagnostics") {
      const params = msg.params as { uri?: unknown; diagnostics?: unknown };
      const rel = fromWorkspaceUri(params?.uri);
      if (rel === null || rel === "") return;
      const items = Array.isArray(params.diagnostics)
        ? (params.diagnostics as LspDiagnostic[])
        : [];
      this.onDiagnostics?.(rel, items);
    }
  }
}

export function createWebSocketTransport(
  url: string,
  WebSocketImpl: typeof WebSocket = WebSocket,
): LspTransport {
  const ws = new WebSocketImpl(url);
  const listeners = new Set<(payload: unknown) => void>();
  const closeListeners = new Set<() => void>();
  const queue: unknown[] = [];
  ws.addEventListener("open", () => {
    for (const payload of queue) {
      try {
        ws.send(JSON.stringify(payload));
      } catch {}
    }
    queue.length = 0;
  });
  ws.addEventListener("message", (ev: MessageEvent) => {
    try {
      const data = typeof ev.data === "string" ? ev.data : String(ev.data);
      listeners.forEach((cb) => cb(JSON.parse(data)));
    } catch {
      /* malformed frames are ignored; the editor stays usable */
    }
  });
  ws.addEventListener("close", () => {
    for (const cb of closeListeners) {
      try {
        cb();
      } catch {}
    }
  });
  return {
    send(payload) {
      if (ws.readyState === WebSocketImpl.OPEN) {
        try {
          ws.send(JSON.stringify(payload));
        } catch {}
      } else if (ws.readyState === WebSocketImpl.CONNECTING) {
        queue.push(payload);
      }
    },
    onMessage(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    onClose(cb) {
      closeListeners.add(cb);
      return () => closeListeners.delete(cb);
    },
    close() {
      listeners.clear();
      closeListeners.clear();
      queue.length = 0;
      try {
        ws.close();
      } catch {}
    },
  };
}
