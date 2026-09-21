import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { Db } from "../db.js";
import { encodeLspFrame, isJsonRpcNotification, isJsonRpcRequest, isJsonRpcResponse, LspFrameParser, type JsonRpcMessage } from "./jsonrpc.js";
import type { LspLanguageSpec } from "./languages.js";
import { resolveCanonicalText, type LspDocumentSource } from "./canonical.js";
import { CLIENT_REQUESTS, isAllowedClientNotification, isAllowedClientRequest, SERVER_NOTIFICATIONS_FORWARDED, SERVER_REQUESTS_HANDLED } from "./protocol.js";
import { fromWorkspaceUri, rewriteUris, toWorkspaceUri, WORKSPACE_ROOT_URI } from "./uri.js";
import type { LspSpawnFn } from "./process.js";
import { recordAuditLog, type AuditEventType } from "../audit.js";

export type LspSessionState =
  | "starting"
  | "ready"
  | "restarting"
  | "failed"
  | "unavailable"
  | "busy"
  | "stopped";

export interface LspClientSocket {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

const WS_OPEN = 1;

export interface LspSessionLimits {
  startupTimeoutMs: number;
  idleTimeoutMs: number;
  restartWindowMs: number;
  maxRestarts: number;
  messageMaxBytes: number;
  maxPendingPerClient: number;
}

export const DEFAULT_LSP_SESSION_LIMITS: LspSessionLimits = {
  startupTimeoutMs: 15_000,
  idleTimeoutMs: 120_000,
  restartWindowMs: 60_000,
  maxRestarts: 3,
  messageMaxBytes: 1024 * 1024,
  maxPendingPerClient: 64,
};

export interface LspStatusPayload {
  type: "status";
  state: LspSessionState;
  language: string;
  message?: string;
}

interface PendingClient {
  client: LspClientSocket;
  clientId: string | number;
}

interface TrackedClient {
  socket: LspClientSocket;
  /** Workspace-relative paths this socket opened. */
  openDocs: Set<string>;
  pendingCount: number;
}

interface OpenDoc {
  version: number;
  text: string;
  refs: number;
  languageId: string;
  unsubscribe: (() => void) | null;
}

export interface LspSessionHooks {
  spawn: LspSpawnFn;
  onDead: (session: LspSession) => void;
  now?: () => number;
  /**
   * Canonical document text (typically the live Yjs room). When present,
   * client didOpen/didChange payloads are ignored whenever the source has
   * the file — one authoritative stream per path, not last-socket-wins.
   */
  documentSource?: LspDocumentSource | null;
  auditDb?: Db;
}

/**
 * One language-server process for one (project, language). Multiple browser
 * sockets share it. The backend owns initialize/shutdown and URI rewriting.
 */
export class LspSession {
  readonly projectId: string;
  readonly userId: number;
  readonly language: LspLanguageSpec;
  readonly containerId: string;
  readonly limits: LspSessionLimits;

  private readonly hooks: LspSessionHooks;
  private child: ChildProcessWithoutNullStreams | null = null;
  private writeStdin: ((data: string | Buffer) => void) | null = null;
  private parser: LspFrameParser;
  private readonly clients = new Map<LspClientSocket, TrackedClient>();
  private readonly pending = new Map<number, PendingClient>();
  private readonly docs = new Map<string, OpenDoc>();
  private nextServerId = 1;
  private state: LspSessionState = "starting";
  private statusMessage: string | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private restartAt: number[] = [];
  private stderrTail = "";
  private disposed = false;
  private initializeSent = false;
  private readonly documentSource: LspDocumentSource | null;
  lastActivity = Date.now();
  private _auditTerminalLogged = false;
  private _startCount = 0;

  constructor(
    projectId: string,
    language: LspLanguageSpec,
    containerId: string,
    userId: number,
    hooks: LspSessionHooks,
    limits: Partial<LspSessionLimits> = {},
  ) {
    this.projectId = projectId;
    this.userId = userId;
    this.language = language;
    this.containerId = containerId;
    this.hooks = hooks;
    this.limits = { ...DEFAULT_LSP_SESSION_LIMITS, ...limits };
    this.parser = new LspFrameParser(this.limits.messageMaxBytes);
    this.documentSource = hooks.documentSource ?? null;
  }

  private recordAudit(eventType: AuditEventType, message: string): void {
    const db = this.hooks.auditDb;
    if (!db) return;
    try {
      recordAuditLog(db, {
        userId: this.userId,
        projectId: this.projectId,
        eventType,
        details: { language: this.language.id, message },
      });
    } catch {
      // Non-fatal: audit failure must not break the LSP lifecycle
    }
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  get clientCount(): number {
    return this.clients.size;
  }

  get currentState(): LspSessionState {
    return this.state;
  }

  start(): void {
    if (this.disposed) return;
    if (this.child) return;
    const isRestart = this._startCount > 0;
    this.setState("starting", "starting language server");
    try {
      this.child = this.hooks.spawn({
        spec: this.language,
        containerId: this.containerId,
      });
    } catch (err: any) {
      this.fail("unavailable", err?.message ?? "failed to spawn language server");
      return;
    }
    this._startCount++;
    if (isRestart) {
      this.recordAudit("LSP_SESSION_RESTARTED", "language server restarting");
    }
    this.recordAudit("LSP_SESSION_STARTED", "language server process started");
    const child = this.child;
    child.stdin.on("error", () => {});
    this.writeStdin = (data) => {
      if (child.stdin.writable) {
        child.stdin.write(data);
      }
    };
    child.stdout.on("data", (chunk: Buffer) => {
      try {
        const messages = this.parser.push(chunk);
        for (const msg of messages) this.onServerMessage(msg);
      } catch (err: any) {
        this.fail("failed", err?.message ?? "language server protocol error");
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const s = chunk.toString("utf8");
      this.stderrTail = (this.stderrTail + s).slice(-4000);
    });
    child.on("error", (err) => {
      this.fail("unavailable", err.message);
    });
    child.on("exit", () => {
      this.child = null;
      this.writeStdin = null;
      // Startup timeout / missing binary land in `unavailable`. Do not
      // treat that as a crash worth respawning — that is a restart storm.
      if (
        this.disposed ||
        this.state === "stopped" ||
        this.state === "failed" ||
        this.state === "unavailable"
      ) {
        return;
      }
      this.onChildExit();
    });
    this.armStartupTimer();
    this.sendInitialize();
  }

  addClient(socket: LspClientSocket): void {
    if (this.disposed) return;
    if (this.clients.has(socket)) return;
    this.clients.set(socket, {
      socket,
      openDocs: new Set(),
      pendingCount: 0,
    });
    this.touch();
    this.clearIdleTimer();
    this.sendStatus(socket);
    if (
      (this.state === "failed" || this.state === "unavailable") &&
      !this.child
    ) {
      const now = this.now();
      this.restartAt = this.restartAt.filter(
        (t) => now - t < this.limits.restartWindowMs,
      );
      if (this.restartAt.length < this.limits.maxRestarts) {
        this.restartAt.push(now);
        this.parser.reset();
        this.initializeSent = false;
        this.start();
      }
    }
  }

  removeClient(socket: LspClientSocket): void {
    const tracked = this.clients.get(socket);
    if (!tracked) return;
    this.clients.delete(socket);
    for (const [id, pending] of [...this.pending.entries()]) {
      if (pending.client === socket) this.pending.delete(id);
    }
    for (const rel of tracked.openDocs) {
      this.releaseDoc(rel);
    }
    if (this.clients.size === 0) this.armIdleTimer();
  }

  handleClientMessage(socket: LspClientSocket, raw: unknown): void {
    this.touch();
    const tracked = this.clients.get(socket);
    if (!tracked) return;
    if (!raw || typeof raw !== "object") return;
    const msg = raw as JsonRpcMessage;
    if (typeof (raw as { type?: unknown }).type === "string") {
      // Control frames (`status` etc.) are server → client only.
      return;
    }
    if (!msg.method || typeof msg.method !== "string") {
      return;
    }
    if (msg.method === "initialize" || msg.method === "initialized") return;
    if (msg.method === "shutdown" || msg.method === "exit") return;
    if (!clientMethodOk(msg.method)) return;
    if (this.state !== "ready") {
      if (typeof msg.id === "string" || typeof msg.id === "number") {
        this.sendTo(socket, {
          jsonrpc: "2.0",
          id: msg.id,
          error: {
            code: -32003,
            message: `language server ${this.state}`,
          },
        });
      }
      return;
    }

    if (isJsonRpcNotification(msg) && isAllowedClientNotification(msg.method)) {
      this.handleClientNotification(tracked, msg);
      return;
    }
    if (isJsonRpcRequest(msg) && isAllowedClientRequest(msg.method)) {
      this.handleClientRequest(tracked, msg);
    }
  }

  dispose(reason = "stopped"): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearIdleTimer();
    this.clearStartupTimer();
    this.state = "stopped";
    this.statusMessage = reason;
    this.broadcastStatus();
    for (const id of [...this.pending.keys()]) {
      const p = this.pending.get(id);
      this.pending.delete(id);
      if (p) {
        this.sendTo(p.client, {
          jsonrpc: "2.0",
          id: p.clientId,
          error: { code: -32002, message: reason },
        });
      }
    }
    this.sendServer({ jsonrpc: "2.0", id: this.nextServerId++, method: "shutdown", params: null });
    this.sendServer({ jsonrpc: "2.0", method: "exit" });
    const child = this.child;
    this.child = null;
    this.writeStdin = null;
    if (child && child.exitCode === null && child.signalCode === null) {
      try {
        child.kill("SIGKILL");
      } catch {}
    }
    for (const tracked of this.clients.values()) {
      try {
        tracked.socket.close(1000, reason);
      } catch {}
    }
    this.clients.clear();
    this.clearDocs();
    if (!this._auditTerminalLogged) {
      this._auditTerminalLogged = true;
      const eventType = reason === "evicted" ? "LSP_SESSION_EVICTED" : "LSP_SESSION_STOPPED";
      this.recordAudit(eventType, reason);
    }
    this.hooks.onDead(this);
  }

  private handleClientNotification(
    tracked: TrackedClient,
    msg: JsonRpcMessage & { method: string },
  ): void {
    if (msg.method === "textDocument/didOpen") {
      const doc = (msg.params as { textDocument?: { uri?: unknown; text?: unknown } })
        ?.textDocument;
      const rel = fromWorkspaceUri(doc?.uri);
      const text = typeof doc?.text === "string" ? doc.text : null;
      if (!rel || text === null) return;
      if (text.length > this.limits.messageMaxBytes) return;
      const alreadyTracked = tracked.openDocs.has(rel);
      tracked.openDocs.add(rel);
      const languageId = this.language.documentLanguageId(rel);
      const canonical = resolveCanonicalText(this.documentSource, rel, text);
      const existing = this.docs.get(rel);
      if (existing) {
        if (!alreadyTracked) existing.refs += 1;
        // Additional openers must not overwrite the authoritative stream
        // with a possibly-stale snapshot. If Yjs/collab has the file, sync
        // to that; otherwise keep the already-open buffer until a didChange.
        const fromSource = this.documentSource?.read(rel);
        if (fromSource !== null && fromSource !== undefined) {
          this.syncDocText(rel, existing, fromSource);
        }
      } else {
        this.openDoc(rel, languageId, canonical);
      }
      return;
    }
    if (msg.method === "textDocument/didChange") {
      const td = (msg.params as { textDocument?: { uri?: unknown } })?.textDocument;
      const rel = fromWorkspaceUri(td?.uri);
      const changes = (msg.params as { contentChanges?: { text?: unknown }[] })
        ?.contentChanges;
      const text =
        Array.isArray(changes) && typeof changes[0]?.text === "string"
          ? changes[0].text
          : null;
      if (!rel || text === null) return;
      if (!tracked.openDocs.has(rel)) return;
      if (text.length > this.limits.messageMaxBytes) return;
      const existing = this.docs.get(rel);
      if (!existing) return;
      const canonical = resolveCanonicalText(this.documentSource, rel, text);
      this.syncDocText(rel, existing, canonical);
      return;
    }
    if (msg.method === "textDocument/didClose") {
      const td = (msg.params as { textDocument?: { uri?: unknown } })?.textDocument;
      const rel = fromWorkspaceUri(td?.uri);
      if (!rel) return;
      if (!tracked.openDocs.has(rel)) return;
      tracked.openDocs.delete(rel);
      this.releaseDoc(rel);
      return;
    }
    if (msg.method === "$/cancelRequest") {
      this.sendServer(msg);
    }
  }

  private handleClientRequest(
    tracked: TrackedClient,
    msg: JsonRpcMessage & { method: string; id: string | number },
  ): void {
    if (tracked.pendingCount >= this.limits.maxPendingPerClient) {
      this.sendTo(tracked.socket, {
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32004, message: "too many in-flight language requests" },
      });
      return;
    }
    const rewritten = rewriteUris(msg.params, (uri) => {
      const rel = fromWorkspaceUri(uri);
      if (rel === null) return null;
      return toWorkspaceUri(rel);
    });
    if (!rewritten.ok) {
      this.sendTo(tracked.socket, {
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32602, message: "invalid document uri" },
      });
      return;
    }
    const serverId = this.nextServerId++;
    tracked.pendingCount += 1;
    this.pending.set(serverId, { client: tracked.socket, clientId: msg.id });
    this.sendServer({
      jsonrpc: "2.0",
      id: serverId,
      method: msg.method,
      params: rewritten.value,
    });
  }

  private onServerMessage(msg: JsonRpcMessage): void {
    this.touch();
    if (isJsonRpcRequest(msg)) {
      this.answerServerRequest(msg);
      return;
    }
    if (isJsonRpcResponse(msg)) {
      if (
        (this.state === "starting" || this.state === "restarting") &&
        msg.id === 1 &&
        this.initializeSent
      ) {
        this.clearStartupTimer();
        if (msg.error) {
          this.fail(
            "failed",
            msg.error.message || "language server initialize failed",
          );
          return;
        }
        this.sendServer({ jsonrpc: "2.0", method: "initialized", params: {} });
        this.setState("ready");
        this.recordAudit("LSP_SESSION_STARTED", "language server ready");
        return;
      }
      if (typeof msg.id !== "number") return;
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      const tracked = this.clients.get(pending.client);
      if (tracked) tracked.pendingCount = Math.max(0, tracked.pendingCount - 1);
      const rewritten = rewriteUris(
        "result" in msg ? msg.result : msg,
        (uri) => {
          const rel = fromWorkspaceUri(uri);
          return rel === null ? null : toWorkspaceUri(rel)!;
        },
      );
      if (!rewritten.ok) {
        this.sendTo(pending.client, {
          jsonrpc: "2.0",
          id: pending.clientId,
          error: { code: -32603, message: "language server returned an illegal uri" },
        });
        return;
      }
      if ("error" in msg && msg.error) {
        this.sendTo(pending.client, {
          jsonrpc: "2.0",
          id: pending.clientId,
          error: msg.error,
        });
        return;
      }
      this.sendTo(pending.client, {
        jsonrpc: "2.0",
        id: pending.clientId,
        result: "result" in msg ? rewritten.value : undefined,
      });
      return;
    }
    if (isJsonRpcNotification(msg)) {
      if (!SERVER_NOTIFICATIONS_FORWARDED.has(msg.method)) return;
      const rewritten = rewriteUris(msg.params, (uri) => {
        const rel = fromWorkspaceUri(uri);
        return rel === null ? null : toWorkspaceUri(rel)!;
      });
      if (!rewritten.ok) return;
      this.broadcast({
        jsonrpc: "2.0",
        method: msg.method,
        params: rewritten.value,
      });
    }
  }

  private answerServerRequest(
    msg: JsonRpcMessage & { method: string; id: string | number },
  ): void {
    if (!SERVER_REQUESTS_HANDLED.has(msg.method)) {
      this.sendServer({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32601, message: "Method not found" },
      });
      return;
    }
    if (msg.method === "workspace/workspaceFolders") {
      this.sendServer({
        jsonrpc: "2.0",
        id: msg.id,
        result: [{ uri: WORKSPACE_ROOT_URI, name: "workspace" }],
      });
      return;
    }
    if (msg.method === "workspace/configuration") {
      const items = (msg.params as { items?: unknown[] } | undefined)?.items;
      const n = Array.isArray(items) && items.length > 0 ? items.length : 1;
      this.sendServer({
        jsonrpc: "2.0",
        id: msg.id,
        result: Array.from({ length: n }, () => ({})),
      });
      return;
    }
    this.sendServer({ jsonrpc: "2.0", id: msg.id, result: null });
  }

  private sendInitialize(): void {
    this.initializeSent = true;
    this.nextServerId = 2;
    this.sendServer({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        processId: null,
        rootUri: WORKSPACE_ROOT_URI,
        rootPath: "/workspace",
        workspaceFolders: [{ uri: WORKSPACE_ROOT_URI, name: "workspace" }],
        capabilities: {
          workspace: {
            workspaceFolders: true,
            configuration: true,
          },
          textDocument: {
            synchronization: { dynamicRegistration: false, didSave: false },
            completion: { completionItem: { snippetSupport: false } },
            hover: { contentFormat: ["markdown", "plaintext"] },
            definition: { linkSupport: false },
            references: {},
            documentSymbol: {},
            signatureHelp: {},
            publishDiagnostics: {},
          },
        },
        initializationOptions: this.language.initializationOptions,
        trace: "off",
      },
    });
  }

  private openDoc(rel: string, languageId: string, text: string): void {
    const doc: OpenDoc = {
      version: 1,
      text,
      refs: 1,
      languageId,
      unsubscribe: null,
    };
    this.docs.set(rel, doc);
    this.sendServer({
      jsonrpc: "2.0",
      method: "textDocument/didOpen",
      params: {
        textDocument: {
          uri: toWorkspaceUri(rel),
          languageId,
          version: 1,
          text,
        },
      },
    });
    this.watchCanonical(rel, doc);
  }

  private syncDocText(rel: string, existing: OpenDoc, text: string): void {
    if (existing.text === text) return;
    existing.version += 1;
    existing.text = text;
    this.sendServer({
      jsonrpc: "2.0",
      method: "textDocument/didChange",
      params: {
        textDocument: { uri: toWorkspaceUri(rel), version: existing.version },
        contentChanges: [{ text }],
      },
    });
  }

  private watchCanonical(rel: string, doc: OpenDoc): void {
    if (!this.documentSource) return;
    doc.unsubscribe = this.documentSource.subscribe(rel, (text) => {
      if (this.disposed || this.state !== "ready") return;
      const current = this.docs.get(rel);
      if (!current || current !== doc) return;
      this.syncDocText(rel, current, text);
    });
  }

  private releaseDoc(rel: string): void {
    const existing = this.docs.get(rel);
    if (!existing) return;
    existing.refs -= 1;
    if (existing.refs > 0) return;
    if (existing.unsubscribe) {
      try {
        existing.unsubscribe();
      } catch {}
      existing.unsubscribe = null;
    }
    this.docs.delete(rel);
    if (this.state === "ready") {
      this.sendServer({
        jsonrpc: "2.0",
        method: "textDocument/didClose",
        params: { textDocument: { uri: toWorkspaceUri(rel) } },
      });
    }
  }

  private clearDocs(): void {
    for (const doc of this.docs.values()) {
      if (doc.unsubscribe) {
        try {
          doc.unsubscribe();
        } catch {}
        doc.unsubscribe = null;
      }
    }
    this.docs.clear();
  }

  private onChildExit(): void {
    this.clearStartupTimer();
    const now = this.now();
    this.restartAt = this.restartAt.filter(
      (t) => now - t < this.limits.restartWindowMs,
    );
    if (this.restartAt.length >= this.limits.maxRestarts) {
      this.fail(
        "failed",
        "language server crashed repeatedly; editor remains usable",
      );
      return;
    }
    this.restartAt.push(now);
    this.setState("restarting", "language server restarting");
    this.parser.reset();
    this.pending.clear();
    this.clearDocs();
    for (const tracked of this.clients.values()) {
      tracked.openDocs.clear();
      tracked.pendingCount = 0;
    }
    this.initializeSent = false;
    this.start();
  }

  private fail(state: "failed" | "unavailable", message: string): void {
    this.clearStartupTimer();
    this.parser.reset();
    this.initializeSent = false;
    const terminal = state === "failed" ? "crash" : "unavailable";
    if (!this._auditTerminalLogged) {
      this._auditTerminalLogged = true;
      this.recordAudit("LSP_SESSION_FAILED", terminal);
    }
    this.setState(state, message);
    const child = this.child;
    this.child = null;
    this.writeStdin = null;
    if (child) {
      try {
        child.kill("SIGKILL");
      } catch {}
    }
  }

  private setState(state: LspSessionState, message?: string): void {
    this.state = state;
    this.statusMessage = message;
    this.broadcastStatus();
  }

  private sendStatus(socket: LspClientSocket): void {
    this.sendTo(socket, {
      type: "status",
      state: this.state,
      language: this.language.id,
      message: this.statusMessage,
    } satisfies LspStatusPayload);
  }

  private broadcastStatus(): void {
    for (const tracked of this.clients.values()) this.sendStatus(tracked.socket);
  }

  private broadcast(payload: unknown): void {
    for (const tracked of this.clients.values()) this.sendTo(tracked.socket, payload);
  }

  private sendTo(socket: LspClientSocket, payload: unknown): void {
    if (socket.readyState !== WS_OPEN) return;
    try {
      socket.send(JSON.stringify(payload));
    } catch {}
  }

  private sendServer(msg: unknown): void {
    if (!this.writeStdin) return;
    try {
      this.writeStdin(encodeLspFrame(msg));
    } catch {}
  }

  private armStartupTimer(): void {
    this.clearStartupTimer();
    this.startupTimer = setTimeout(() => {
      this.startupTimer = null;
      if (this.state === "starting" || this.state === "restarting") {
        this.fail("unavailable", "language server startup timed out");
      }
    }, this.limits.startupTimeoutMs);
    this.startupTimer.unref?.();
  }

  private clearStartupTimer(): void {
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }
  }

  private armIdleTimer(): void {
    this.clearIdleTimer();
    if (this.disposed) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.clients.size === 0) this.dispose("idle");
    }, this.limits.idleTimeoutMs);
    this.idleTimer.unref?.();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private touch(): void {
    this.lastActivity = this.now();
  }

  private now(): number {
    return this.hooks.now ? this.hooks.now() : Date.now();
  }
}

function clientMethodOk(method: string): boolean {
  return (
    isAllowedClientNotification(method) || CLIENT_REQUESTS.has(method)
  );
}
