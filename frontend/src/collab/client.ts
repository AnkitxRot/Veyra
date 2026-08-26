import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { MonacoBinding } from "y-monaco";
import { monaco } from "../monacoSetup";
import { User } from "../types";

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
// Reserved: y-protocols auth message type (received but not handled).
const _MESSAGE_AUTH = 2;
const MESSAGE_CUSTOM = 3;

export type CollabConnectionStatus =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "resynchronizing"
  | "disconnected"
  | "forbidden";

export interface CollaboratorPresence {
  clientId: number;
  userId: number;
  name: string;
  role: "owner" | "editor" | "viewer";
  color: string;
  activeFile?: string | null;
  cursor?: { line: number; column: number } | null;
}

export class CollaborationClient {
  public readonly projectId: string;
  public readonly doc: Y.Doc;
  public readonly awareness: awarenessProtocol.Awareness;
  public status: CollabConnectionStatus = "disconnected";

  private ws: WebSocket | null = null;
  private currentBinding: MonacoBinding | null = null;
  private boundModel: monaco.editor.ITextModel | null = null;
  private activeFilePath: string | null = null;
  private readonly listeners: Map<string, Set<(...args: any[]) => void>> =
    new Map();
  private reconnectAttempts = 0;
  private reconnectTimer: any = null;
  private isDisposed = false;
  private user: User;

  constructor(projectId: string, user: User) {
    this.projectId = projectId;
    this.user = user;
    this.doc = new Y.Doc();
    this.awareness = new awarenessProtocol.Awareness(this.doc);

    // Configure user awareness
    this.awareness.setLocalStateField("user", {
      id: user.id,
      name: user.username,
      color: getUserColor(user.id),
      role: user.role === "admin" ? "owner" : "editor",
    });

    // Notify local listeners when awareness changes
    this.awareness.on("change", () => {
      this.emit("awareness_change", this.getOnlineCollaborators());
    });

    // 1. Transmit local document updates to server
    this.doc.on("update", (update: Uint8Array, origin: any) => {
      if (origin !== this) {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_SYNC);
        syncProtocol.writeUpdate(encoder, update);
        this.send(encoding.toUint8Array(encoder));
      }
    });

    // 2. Transmit local awareness updates (cursor, selection, active file) to server
    this.awareness.on(
      "update",
      (
        {
          added,
          updated,
          removed,
        }: { added: number[]; updated: number[]; removed: number[] },
        origin: any,
      ) => {
        if (origin !== this) {
          const changedClients = added.concat(updated).concat(removed);
          const encoder = encoding.createEncoder();
          encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
          encoding.writeVarUint8Array(
            encoder,
            awarenessProtocol.encodeAwarenessUpdate(
              this.awareness,
              changedClients,
            ),
          );
          this.send(encoding.toUint8Array(encoder));
        }
      },
    );

    this.connect();
  }

  public connect(): void {
    if (this.isDisposed) return;
    this.setStatus(this.reconnectAttempts > 0 ? "reconnecting" : "connecting");

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const host = window.location.host;
    const wsUrl = `${protocol}//${host}/ws/collab?projectId=${encodeURIComponent(this.projectId)}`;

    try {
      this.ws = new WebSocket(wsUrl);
      this.ws.binaryType = "arraybuffer";

      this.ws.onopen = () => {
        this.reconnectAttempts = 0;
        this.setStatus("connected");

        // 1. Send Sync Step 1 (Client state vector)
        const syncEncoder = encoding.createEncoder();
        encoding.writeVarUint(syncEncoder, MESSAGE_SYNC);
        syncProtocol.writeSyncStep1(syncEncoder, this.doc);
        this.send(encoding.toUint8Array(syncEncoder));

        // 2. Broadcast local awareness
        const awarenessEncoder = encoding.createEncoder();
        encoding.writeVarUint(awarenessEncoder, MESSAGE_AWARENESS);
        encoding.writeVarUint8Array(
          awarenessEncoder,
          awarenessProtocol.encodeAwarenessUpdate(this.awareness, [
            this.doc.clientID,
          ]),
        );
        this.send(encoding.toUint8Array(awarenessEncoder));

        // 3. Notify active file if any
        if (this.activeFilePath) {
          this.notifyFileOpen(this.activeFilePath);
        }
      };

      this.ws.onmessage = (event) => {
        const u8 = new Uint8Array(event.data);
        this.handleMessage(u8);
      };

      this.ws.onclose = (event) => {
        if (event.code === 4403 || event.code === 4003) {
          this.setStatus("forbidden");
          return;
        }

        this.setStatus("disconnected");
        if (!this.isDisposed) {
          this.scheduleReconnect();
        }
      };

      this.ws.onerror = () => {
        this.setStatus("disconnected");
      };
    } catch {
      this.setStatus("disconnected");
      this.scheduleReconnect();
    }
  }

  private handleMessage(message: Uint8Array): void {
    try {
      const decoder = decoding.createDecoder(message);
      const messageType = decoding.readVarUint(decoder);

      switch (messageType) {
        case MESSAGE_SYNC: {
          const encoder = encoding.createEncoder();
          encoding.writeVarUint(encoder, MESSAGE_SYNC);
          syncProtocol.readSyncMessage(decoder, encoder, this.doc, this);
          if (encoding.length(encoder) > 1) {
            this.send(encoding.toUint8Array(encoder));
          }
          break;
        }

        case MESSAGE_AWARENESS: {
          awarenessProtocol.applyAwarenessUpdate(
            this.awareness,
            decoding.readVarUint8Array(decoder),
            this,
          );
          break;
        }
      }
    } catch (err) {
      console.error("[CollabClient] Error handling message:", err);
    }
  }

  public notifyFileOpen(filePath: string): void {
    this.activeFilePath = filePath;
    this.awareness.setLocalStateField("activeFile", filePath);

    // Send custom message to server
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_CUSTOM);
    encoding.writeVarString(
      encoder,
      JSON.stringify({ type: "file_open", path: filePath }),
    );
    this.send(encoding.toUint8Array(encoder));
  }

  /**
   * Binds Monaco Model to collaborative Y.Text
   */
  public bindMonacoModel(
    filePath: string,
    model: monaco.editor.ITextModel,
    editor: monaco.editor.IStandaloneCodeEditor,
    _isReadOnly: boolean = false,
  ): void {
    // A disposed client's doc/awareness/ws are already torn down. A stale
    // React prop reference could still reach this call in the brief window
    // between a project switch's cleanup and the new client replacing it in
    // state; without this guard it would seed the destroyed Y.Doc from
    // whatever model content happened to be passed in and build a binding
    // that can never sync anywhere.
    if (this.isDisposed) return;

    // Callers (Editor.tsx's model-management effect) re-run on every
    // keystroke because `openFiles` gets a new array/object reference per
    // edit. Without this guard, every keystroke would tear down and rebuild
    // the y-monaco binding and re-send a file_open message to the server.
    if (
      this.boundModel === model &&
      this.activeFilePath === filePath &&
      this.currentBinding
    ) {
      return;
    }

    this.unbindCurrentModel();

    this.activeFilePath = filePath;
    this.notifyFileOpen(filePath);

    const yText = this.doc.getText(filePath);

    // If local model has content but Y.Text is empty, sync model content into Y.Text
    if (yText.length === 0 && model.getValue().length > 0) {
      this.doc.transact(() => {
        yText.insert(0, model.getValue());
      }, "initial_model_sync");
    }

    try {
      const binding = new MonacoBinding(
        yText,
        model,
        new Set([editor]),
        this.awareness,
      );

      // Defer decoration re-rendering to next animation frame and guard against
      // re-entrant deltaDecorations calls triggered by Monaco cursor selection events.
      const origRerender = (binding as any)._rerenderDecorations;
      if (typeof origRerender === "function") {
        let isRerendering = false;
        let pendingRaf: number | null = null;
        const safeRerender = () => {
          if (isRerendering) return;
          if (pendingRaf !== null) return;
          pendingRaf = requestAnimationFrame(() => {
            pendingRaf = null;
            if (
              !this.isDisposed &&
              this.currentBinding === binding &&
              !isRerendering
            ) {
              isRerendering = true;
              try {
                origRerender();
              } catch {
              } finally {
                isRerendering = false;
              }
            }
          });
        };

        (binding as any)._rerenderDecorations = safeRerender;
        if (this.awareness) {
          this.awareness.off("change", origRerender);
          this.awareness.on("change", safeRerender);
        }
      }

      this.currentBinding = binding;
      this.boundModel = model;
    } catch (err) {
      console.error("[CollabClient] Failed to bind Monaco editor:", err);
    }
  }

  public unbindCurrentModel(): void {
    this.boundModel = null;
    if (this.currentBinding) {
      try {
        this.currentBinding.destroy();
      } catch {}
      this.currentBinding = null;
    }
  }

  public getOnlineCollaborators(): CollaboratorPresence[] {
    const states = this.awareness.getStates();
    const collaborators: CollaboratorPresence[] = [];

    for (const [clientId, state] of states.entries()) {
      if (state.user) {
        collaborators.push({
          clientId,
          userId: state.user.id,
          name: state.user.name || "Anonymous",
          role: state.user.role || "editor",
          color: state.user.color || getUserColor(state.user.id || 0),
          activeFile: state.activeFile,
          cursor: state.cursor,
        });
      }
    }

    return collaborators;
  }

  private cursorTimer: number | null = null;

  public updateCursorPosition(line: number, column: number): void {
    if (this.cursorTimer !== null) {
      cancelAnimationFrame(this.cursorTimer);
    }
    this.cursorTimer = requestAnimationFrame(() => {
      this.cursorTimer = null;
      if (!this.isDisposed) {
        this.awareness.setLocalStateField("cursor", { line, column });
      }
    });
  }

  private send(data: Uint8Array): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(data);
      } catch {}
    }
  }

  private setStatus(s: CollabConnectionStatus): void {
    this.status = s;
    this.emit("connection_change", s);
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(1.5, this.reconnectAttempts), 10000);
    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, delay);
  }

  public on(event: string, handler: (...args: any[]) => void): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(handler);
    return () => this.listeners.get(event)?.delete(handler);
  }

  private emit(event: string, ...args: any[]): void {
    const set = this.listeners.get(event);
    if (set) {
      for (const fn of set) {
        try {
          fn(...args);
        } catch {}
      }
    }
  }

  public dispose(): void {
    this.isDisposed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.cursorTimer !== null) {
      cancelAnimationFrame(this.cursorTimer);
      this.cursorTimer = null;
    }
    this.unbindCurrentModel();
    if (this.ws) {
      try {
        this.ws.close();
      } catch {}
      this.ws = null;
    }
    this.awareness.destroy();
    this.doc.destroy();
    this.listeners.clear();
  }
}

const USER_COLORS = [
  "#89b4fa", // Blue
  "#a6e3a1", // Green
  "#fab387", // Peach
  "#f38ba8", // Red
  "#cba6f7", // Mauve
  "#f9e2af", // Yellow
  "#94e2d5", // Teal
  "#f5c2e7", // Pink
];

export function getUserColor(userId: number): string {
  return USER_COLORS[Math.abs(userId) % USER_COLORS.length];
}
