import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { encodeLspFrame, LspFrameParser } from "../lsp/jsonrpc.js";
import { assertInsideWorkspace, safeResolve } from "../files/service.js";
import {
  clipArray,
  clipString,
  DEBUG_MAX_OUTPUT_CHARS,
  DEBUG_MAX_PENDING,
  DEBUG_MAX_SCOPES,
  DEBUG_MAX_STACK_FRAMES,
  DEBUG_MAX_VARIABLES,
} from "./bounds.js";
import type { DebugLanguageSpec } from "./languages.js";
import {
  fromWorkspaceLocation,
  toWorkspaceFsPath,
} from "./paths.js";
import {
  ADAPTER_REQUESTS,
  CLIENT_COMMANDS,
  parseFrameId,
  parseLaunch,
  parseSetBreakpoints,
  parseVariablesReference,
  REJECTED_ADAPTER_REQUESTS,
  type LaunchConfig,
} from "./protocol.js";
import type { DebugSpawnFn } from "./process.js";
import { recordAuditLog, type AuditEventType } from "../audit.js";
import type { Db } from "../db.js";

export type DebugSessionState =
  | "idle"
  | "starting"
  | "running"
  | "paused"
  | "stopping"
  | "terminated"
  | "failed"
  | "unavailable";

export interface DebugClientSocket {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

const WS_OPEN = 1;

export interface DebugSessionLimits {
  startupTimeoutMs: number;
  requestTimeoutMs: number;
  sessionTimeoutMs: number;
  messageMaxBytes: number;
  maxStackFrames: number;
  maxVariables: number;
  maxOutputChars: number;
}

export const DEFAULT_DEBUG_SESSION_LIMITS: DebugSessionLimits = {
  startupTimeoutMs: 30_000,
  requestTimeoutMs: 10_000,
  sessionTimeoutMs: 30 * 60_000,
  messageMaxBytes: 256 * 1024,
  maxStackFrames: DEBUG_MAX_STACK_FRAMES,
  maxVariables: DEBUG_MAX_VARIABLES,
  maxOutputChars: DEBUG_MAX_OUTPUT_CHARS,
};

export interface DebugSessionHooks {
  spawn: DebugSpawnFn;
  onDead: (session: DebugSession) => void;
  /** Reserve a live debug slot (starting/running/paused). */
  tryAcquire: () => boolean;
  release: () => void;
  now?: () => number;
  auditDb?: Db;
}

interface PendingDap {
  command: string;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface ClientFrame {
  id: number;
  name: string;
  path: string | null;
  line: number;
  column: number;
  presentationHint?: string;
}

interface ClientScope {
  name: string;
  variablesReference: number;
  expensive?: boolean;
}

interface ClientVariable {
  name: string;
  value: string;
  type?: string;
  variablesReference: number;
}

function shouldPrefetchScope(name: string): boolean {
  const n = name.toLowerCase();
  return (
    n === "local" ||
    n === "locals" ||
    n === "closure" ||
    n === "arguments" ||
    n.startsWith("local ")
  );
}

/**
 * One user-owned debug session for one project. Isolation is the sandbox
 * container; ownership is (projectId, userId). Collaborators do not share it.
 */
export class DebugSession {
  readonly projectId: string;
  readonly userId: number;
  readonly workspaceDir: string;
  readonly limits: DebugSessionLimits;

  private readonly hooks: DebugSessionHooks;
  private socket: DebugClientSocket | null = null;
  private child: ChildProcessWithoutNullStreams | null = null;
  private writeStdin: ((data: string | Buffer) => void) | null = null;
  private parser: LspFrameParser;
  private nextSeq = 1;
  private pending = new Map<number, PendingDap>();
  private state: DebugSessionState = "idle";
  private statusMessage: string | undefined;
  private language: DebugLanguageSpec | null = null;
  private entryFile: string | null = null;
  private threadId = 1;
  private breakpoints = new Map<string, number[]>();
  private verified = new Map<string, { line: number; verified: boolean }[]>();
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private sessionTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private stderrTail = "";
  private outputChars = 0;
  private initializedEvent = false;
  private containerId: string;
  private acquired = false;
  /** Incremented on every launch so late child events cannot apply. */
  private generation = 0;
  private stopSerial = 0;
  private continueExpected = false;
  private stopInFlight = false;
  /** Drain js-debug's compiled-TS stop-on-entry before surfacing the user pause. */
  private drainEntryStop = false;
  private _auditTerminalLogged = false;

  constructor(
    projectId: string,
    userId: number,
    workspaceDir: string,
    containerId: string,
    hooks: DebugSessionHooks,
    limits: Partial<DebugSessionLimits> = {},
  ) {
    this.projectId = projectId;
    this.userId = userId;
    this.workspaceDir = workspaceDir;
    this.containerId = containerId;
    this.hooks = hooks;
    this.limits = { ...DEFAULT_DEBUG_SESSION_LIMITS, ...limits };
    this.parser = new LspFrameParser(this.limits.messageMaxBytes);
  }

  private recordAudit(eventType: AuditEventType, message: string): void {
    const db = this.hooks.auditDb;
    if (!db) return;
    try {
      recordAuditLog(db, {
        userId: this.userId,
        projectId: this.projectId,
        eventType,
        details: { language: this.language?.id ?? null, message },
      });
    } catch {
      // Non-fatal: audit failure must not break the DAP lifecycle
    }
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  get currentState(): DebugSessionState {
    return this.state;
  }

  get currentLanguage(): string | null {
    return this.language?.id ?? null;
  }

  setSocket(socket: DebugClientSocket): void {
    if (this.disposed) return;
    if (this.socket && this.socket !== socket) {
      try {
        this.socket.close(1000, "displaced");
      } catch {}
    }
    this.socket = socket;
    this.sendStatus();
  }

  clearSocket(socket: DebugClientSocket): void {
    if (this.socket !== socket) return;
    this.socket = null;
    if (
      this.state === "starting" ||
      this.state === "running" ||
      this.state === "paused"
    ) {
      this.dispose("disconnected");
    }
  }

  handleClientMessage(socket: DebugClientSocket, raw: unknown): void {
    if (this.disposed) return;
    if (this.socket !== socket) return;
    if (!raw || typeof raw !== "object") return;
    const o = raw as Record<string, unknown>;
    const type = o.type;
    if (typeof type !== "string" || !CLIENT_COMMANDS.has(type)) return;
    if (
      "executable" in o ||
      "adapter" in o ||
      "containerId" in o ||
      "cwd" in o ||
      "env" in o ||
      "pythonPath" in o ||
      "runtimeExecutable" in o
    ) {
      this.sendError("illegal debug field");
      return;
    }

    switch (type) {
      case "launch":
        void this.onLaunch(o);
        return;
      case "setBreakpoints":
        void this.onSetBreakpoints(o);
        return;
      case "continue":
        void this.control("continue");
        return;
      case "pause":
        void this.control("pause");
        return;
      case "next":
        void this.control("next");
        return;
      case "stepIn":
        void this.control("stepIn");
        return;
      case "stepOut":
        void this.control("stepOut");
        return;
      case "terminate":
        if (
          this.state === "starting" ||
          this.state === "running" ||
          this.state === "paused"
        ) {
          this.setState("stopping", "stopping");
        }
        this.finishTerminated("terminated");
        return;
      case "stackTrace":
        void this.sendStack();
        return;
      case "scopes":
        void this.sendScopes(parseFrameId(o.frameId));
        return;
      case "variables":
        void this.sendVariables(parseVariablesReference(o.variablesReference));
        return;
      default:
        return;
    }
  }

  dispose(reason = "stopped"): void {
    if (this.disposed) return;
    this.disposed = true;
    this.killAdapter(reason);
    this.releaseSlot();
    this.setState(
      reason === "unavailable"
        ? "unavailable"
        : reason === "failed"
          ? "failed"
          : "terminated",
      reason,
    );
    try {
      this.socket?.close(1000, reason);
    } catch {}
    this.socket = null;
    if (!this._auditTerminalLogged) {
      this._auditTerminalLogged = true;
      const eventType = reason === "session_timeout"
        ? "DEBUG_SESSION_TIMEOUT"
        : reason === "unavailable" || reason === "failed"
          ? "DEBUG_SESSION_FAILED"
          : "DEBUG_SESSION_STOPPED";
      this.recordAudit(eventType, reason);
    }
    this.hooks.onDead(this);
  }

  private async onLaunch(raw: Record<string, unknown>): Promise<void> {
    if (
      this.state === "starting" ||
      this.state === "running" ||
      this.state === "paused"
    ) {
      this.sendError("debug session already active");
      return;
    }
    const parsed = parseLaunch(raw);
    if (!parsed.ok) {
      this.sendError(parsed.error);
      return;
    }
    const cfg = parsed.value;
    try {
      const abs = safeResolve(this.workspaceDir, cfg.entryFile);
      await assertInsideWorkspace(this.workspaceDir, abs);
      await fs.access(abs);
      const st = await fs.stat(abs);
      if (!st.isFile()) {
        this.sendError("entry file is not a file");
        return;
      }
    } catch {
      this.sendError("entry file not found in workspace");
      return;
    }

    const notPersisted = await this.persistLiveEdits();
    if (this.disposed) return;
    if (notPersisted) {
      this.sendError(notPersisted);
      return;
    }

    await this.suspendLanguageServers();
    this.killAdapter("relaunch");
    this.releaseSlot();
    if (!this.hooks.tryAcquire()) {
      this.sendError("debug session capacity reached");
      this.setState("unavailable", "debug session capacity reached");
      return;
    }
    this.acquired = true;
    this.language = cfg.language;
    this.entryFile = cfg.entryFile;
    this.breakpoints = cfg.breakpoints;
    this.verified.clear();
    this.initializedEvent = false;
    this.outputChars = 0;
    this.stderrTail = "";
    this.parser.reset();
    this.nextSeq = 1;
    this.generation += 1;
    this.stopSerial = 0;
    this.continueExpected = false;
    this.stopInFlight = false;
    this.drainEntryStop = cfg.entryFile.toLowerCase().endsWith(".ts");
    this.setState("starting", "starting debugger");
    this.armStartupTimer();
    this.armSessionTimer();

    try {
      this.child = this.hooks.spawn({
        spec: cfg.language,
        containerId: this.containerId,
      });
    } catch (err: any) {
      this.fail("unavailable", err?.message ?? "failed to spawn debug adapter");
      return;
    }
    const child = this.child;
    child.stdin.on("error", () => {});
    this.writeStdin = (data) => {
      if (child.stdin.writable) child.stdin.write(data);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      if (this.child !== child) return;
      try {
        const messages = this.parser.push(chunk);
        for (const msg of messages) this.onAdapterMessage(msg);
      } catch (err: any) {
        this.fail("failed", err?.message ?? "debug adapter protocol error");
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (this.child !== child) return;
      this.stderrTail = (this.stderrTail + chunk.toString("utf8")).slice(-4000);
    });
    child.on("error", (err) => {
      if (this.child !== child) return;
      this.fail("unavailable", err.message);
    });
    child.on("exit", () => {
      if (this.child !== child) return;
      this.child = null;
      this.writeStdin = null;
      if (
        this.disposed ||
        this.state === "terminated" ||
        this.state === "failed" ||
        this.state === "unavailable" ||
        this.state === "idle"
      ) {
        // Expected termination (explicit dispose or already in terminal state)
        return;
      }
      this.fail("failed", "debug adapter exited unexpectedly");
    });

    try {
      await this.handshake(cfg);
    } catch (err: any) {
      if (!this.disposed) {
        this.fail(
          this.state === "unavailable" ? "unavailable" : "failed",
          err?.message ?? "debugger launch failed",
        );
      }
      return;
    }
  }

  private async handshake(cfg: LaunchConfig): Promise<void> {
    // vscode-js-debug does not respond to `launch` until configurationDone
    // *and* the debuggee has booted. That routinely exceeds the ordinary
    // DAP request timeout, so handshake uses the startup budget instead.
    const bootMs = this.limits.startupTimeoutMs;
    await this.dapRequest(
      "initialize",
      {
        adapterID: cfg.language.adapterId,
        clientID: "veyra",
        clientName: "Veyra",
        linesStartAt1: true,
        columnsStartAt1: true,
        pathFormat: "path",
        supportsVariableType: true,
        supportsVariablePaging: false,
        supportsRunInTerminalRequest: false,
        supportsStartDebuggingRequest: false,
        locale: "en-us",
      },
      bootMs,
    );

    const waitInit = this.waitForInitialized();
    const launchArgs = this.buildLaunchArgs(cfg);
    const launchPromise = this.dapRequest("launch", launchArgs, bootMs);

    await waitInit;
    await this.pushBreakpoints();
    await this.dapRequest("configurationDone", {}, bootMs);
    await launchPromise;
    this.clearStartupTimer();
    await this.refreshThreadId();
    if (this.state === "starting" && !this.stopInFlight) {
      this.setState("running");
    }
    this.recordAudit("DEBUG_SESSION_STARTED", "debug session running");
  }

  private waitForInitialized(): Promise<void> {
    if (this.initializedEvent) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const start = this.now();
      const poll = setInterval(() => {
        if (this.initializedEvent) {
          clearInterval(poll);
          resolve();
          return;
        }
        if (this.disposed || this.state === "failed" || this.state === "unavailable") {
          clearInterval(poll);
          reject(new Error("debugger failed during initialize"));
          return;
        }
        if (this.now() - start > this.limits.startupTimeoutMs) {
          clearInterval(poll);
          reject(new Error("debugger initialize timed out"));
        }
      }, 20);
      poll.unref?.();
    });
  }

  private buildLaunchArgs(cfg: LaunchConfig): Record<string, unknown> {
    const program = toWorkspaceFsPath(cfg.entryFile);
    if (!program) throw new Error("invalid entry file");
    if (cfg.language.id === "python") {
      const python = this.resolvePython();
      return {
        name: "Python",
        type: "debugpy",
        request: "launch",
        program,
        cwd: "/workspace",
        python,
        args: cfg.args,
        console: "internalConsole",
        justMyCode: true,
        stopOnEntry: false,
        redirectOutput: true,
        subProcess: false,
        gevent: false,
      };
    }
    return {
      name: "Node",
      type: "pwa-node",
      request: "launch",
      program,
      cwd: "/workspace",
      args: cfg.args,
      console: "internalConsole",
      sourceMaps: true,
      outFiles: ["/workspace/.cloudide-build-debug/**/*.js"],
      resolveSourceMapLocations: [
        "/workspace/**",
        "/workspace/.cloudide-build-debug/**",
        "!**/node_modules/**",
      ],
      skipFiles: [
        "<node_internals>/**",
        "/opt/debug/**",
        "/usr/local/lib/node_modules/tsx/**",
        "/usr/local/lib/node_modules/esbuild/**",
      ],
      autoAttachChildProcesses: false,
      stopOnEntry: false,
      enableContentValidation: false,
    };
  }

  /**
   * M86: the adapter reads sources from disk, which lags the collaboration
   * room by the persistence debounce. Returns an error message when the
   * room's latest edits could not be written, or null when disk is current.
   */
  private async persistLiveEdits(): Promise<string | null> {
    const { collaborationManager, describeUnpersistedLiveEdits } = await import(
      "../collab/manager.js"
    );
    const r = await collaborationManager.persistLiveEdits(this.projectId);
    return r.ok
      ? null
      : `${describeUnpersistedLiveEdits(r.unpersisted)}; debugger not started.`;
  }

  private async suspendLanguageServers(): Promise<void> {
    try {
      const { languageServers } = await import("../lsp/manager.js");
      languageServers.suspendForDebug(this.projectId, this.containerId);
    } catch {
      /* LSP manager unavailable in some unit tests */
    }
  }

  private resolvePython(): string {
    const venv = join(this.workspaceDir, ".venv", "bin", "python");
    if (existsSync(venv)) return "/workspace/.venv/bin/python";
    return "python3";
  }

  private async onSetBreakpoints(raw: Record<string, unknown>): Promise<void> {
    const parsed = parseSetBreakpoints(raw);
    if (!parsed.ok) {
      this.sendError(parsed.error);
      return;
    }
    this.breakpoints.set(parsed.value.path, parsed.value.lines);
    if (
      this.state === "starting" ||
      this.state === "running" ||
      this.state === "paused"
    ) {
      await this.pushBreakpointsFor(parsed.value.path, parsed.value.lines);
    } else {
      this.sendToSocket({
        type: "breakpoints",
        path: parsed.value.path,
        breakpoints: parsed.value.lines.map((line) => ({
          line,
          verified: false,
        })),
      });
    }
  }

  private async pushBreakpoints(): Promise<void> {
    for (const [path, lines] of this.breakpoints) {
      await this.pushBreakpointsFor(path, lines);
    }
  }

  private async pushBreakpointsFor(
    rel: string,
    lines: number[],
  ): Promise<void> {
    const fsPath = toWorkspaceFsPath(rel);
    if (!fsPath) return;
    try {
      const result = (await this.dapRequest("setBreakpoints", {
        source: { path: fsPath, name: rel.split("/").pop() },
        breakpoints: lines.map((line) => ({ line })),
        lines,
        sourceModified: false,
      })) as { breakpoints?: { line?: number; verified?: boolean }[] };
      const verified = (result?.breakpoints ?? []).map((bp, i) => ({
        line: typeof bp.line === "number" ? bp.line : lines[i] ?? 0,
        verified: bp.verified === true,
      }));
      this.verified.set(rel, verified);
      this.sendToSocket({ type: "breakpoints", path: rel, breakpoints: verified });
    } catch {
      this.sendToSocket({
        type: "breakpoints",
        path: rel,
        breakpoints: lines.map((line) => ({ line, verified: false })),
      });
    }
  }

  private async control(
    command: "continue" | "pause" | "next" | "stepIn" | "stepOut",
  ): Promise<void> {
    if (command === "pause") {
      if (this.state !== "running") {
        this.sendError("cannot pause unless the program is running");
        return;
      }
      await this.refreshThreadId();
    } else if (this.state !== "paused") {
      this.sendError("cannot step or continue unless the program is paused");
      return;
    }
    if (command === "continue") {
      this.continueExpected = true;
    }
    try {
      await this.dapRequest(command, { threadId: this.threadId });
      if (command === "continue" && this.state === "paused") {
        this.setState("running");
      }
    } catch (err: any) {
      if (command === "continue") this.continueExpected = false;
      this.sendError(err?.message ?? `${command} failed`);
    }
  }

  private async refreshThreadId(): Promise<boolean> {
    try {
      const result = (await this.dapRequest("threads", {}, 1_500)) as {
        threads?: { id?: number }[];
      };
      const threads = Array.isArray(result?.threads) ? result.threads : [];
      const id = threads.find((t) => typeof t?.id === "number")?.id;
      if (typeof id === "number") {
        this.threadId = id;
        return true;
      }
    } catch {
      /* some adapters only report a thread after the first stop */
    }
    return false;
  }

  private async sendStack(): Promise<void> {
    if (this.state !== "paused") {
      this.sendError("stack is only available while paused");
      return;
    }
    const frames = await this.fetchStack();
    this.sendToSocket({ type: "stack", frames });
  }

  private async sendScopes(frameId: number | null): Promise<void> {
    if (this.state !== "paused" || frameId === null) {
      this.sendError("invalid frame");
      return;
    }
    const scopes = await this.fetchScopes(frameId);
    this.sendToSocket({ type: "scopes", frameId, scopes });
  }

  private async sendVariables(ref: number | null): Promise<void> {
    if (this.state !== "paused" || ref === null) {
      this.sendError("invalid variables reference");
      return;
    }
    const variables = await this.fetchVariables(ref);
    this.sendToSocket({
      type: "variables",
      variablesReference: ref,
      variables,
    });
  }

  private async fetchStack(): Promise<ClientFrame[]> {
    try {
      const result = (await this.dapRequest("stackTrace", {
        threadId: this.threadId,
        startFrame: 0,
        levels: this.limits.maxStackFrames,
      })) as { stackFrames?: unknown[] };
      const raw = Array.isArray(result?.stackFrames) ? result.stackFrames : [];
      return clipArray(raw, this.limits.maxStackFrames)
        .map((f) => this.mapFrame(f))
        .filter((f): f is ClientFrame => f !== null);
    } catch {
      return [];
    }
  }

  private mapFrame(raw: unknown): ClientFrame | null {
    if (!raw || typeof raw !== "object") return null;
    const o = raw as Record<string, unknown>;
    if (typeof o.id !== "number") return null;
    const src = o.source as { path?: unknown; name?: unknown } | undefined;
    const mapped = src?.path != null ? fromWorkspaceLocation(src.path) : null;
    if (!mapped) return null;
    const line = typeof o.line === "number" ? o.line : 0;
    const column = typeof o.column === "number" ? o.column : 1;
    return {
      id: o.id,
      name: clipString(typeof o.name === "string" ? o.name : "(anonymous)", 128),
      path: mapped,
      line,
      column,
      presentationHint:
        typeof o.presentationHint === "string" ? o.presentationHint : undefined,
    };
  }

  private async fetchScopes(frameId: number): Promise<ClientScope[]> {
    try {
      const result = (await this.dapRequest("scopes", { frameId })) as {
        scopes?: unknown[];
      };
      const raw = Array.isArray(result?.scopes) ? result.scopes : [];
      const out: ClientScope[] = [];
      for (const s of clipArray(raw, DEBUG_MAX_SCOPES)) {
        if (!s || typeof s !== "object") continue;
        const o = s as Record<string, unknown>;
        if (typeof o.name !== "string") continue;
        if (typeof o.variablesReference !== "number") continue;
        out.push({
          name: clipString(o.name, 64),
          variablesReference: o.variablesReference,
          expensive: o.expensive === true,
        });
      }
      return out;
    } catch {
      return [];
    }
  }

  private async fetchVariables(ref: number): Promise<ClientVariable[]> {
    try {
      const result = (await this.dapRequest("variables", {
        variablesReference: ref,
        count: this.limits.maxVariables,
      })) as { variables?: unknown[] };
      const raw = Array.isArray(result?.variables) ? result.variables : [];
      const out: ClientVariable[] = [];
      for (const v of clipArray(raw, this.limits.maxVariables)) {
        if (!v || typeof v !== "object") continue;
        const o = v as Record<string, unknown>;
        if (typeof o.name !== "string") continue;
        out.push({
          name: clipString(o.name, 128),
          value: clipString(o.value, this.limits.maxVariables > 0 ? 512 : 512),
          type: typeof o.type === "string" ? clipString(o.type, 64) : undefined,
          variablesReference:
            typeof o.variablesReference === "number" ? o.variablesReference : 0,
        });
      }
      return out;
    } catch {
      return [];
    }
  }

  private isDeadState(): boolean {
    return (
      this.disposed ||
      this.state === "terminated" ||
      this.state === "failed" ||
      this.state === "unavailable" ||
      this.state === "stopping"
    );
  }

  private async onStopped(
    body: Record<string, unknown>,
    generation: number,
  ): Promise<void> {
    if (generation !== this.generation || this.isDeadState()) return;
    const serial = ++this.stopSerial;
    this.stopInFlight = true;
    this.continueExpected = false;
    if (typeof body.threadId === "number") this.threadId = body.threadId;
    this.clearStartupTimer();
    const reason = typeof body.reason === "string" ? body.reason : "pause";
    if (this.drainEntryStop) {
      const peek = await this.fetchStack();
      const userFrame = peek.find((f) => f.path);
      const bpLines =
        userFrame?.path != null
          ? (this.breakpoints.get(userFrame.path) ?? [])
          : [];
      const onUserBreakpoint =
        !!userFrame && bpLines.includes(userFrame.line);
      if (onUserBreakpoint) {
        this.drainEntryStop = false;
      } else if (!userFrame || reason === "entry") {
        this.drainEntryStop = false;
        if (generation !== this.generation || this.isDeadState()) return;
        await this.pushBreakpoints();
        if (generation !== this.generation || this.isDeadState()) return;
        this.continueExpected = true;
        this.stopInFlight = false;
        try {
          await this.dapRequest("continue", { threadId: this.threadId });
        } catch {
          this.continueExpected = false;
        }
        return;
      } else {
        this.drainEntryStop = false;
      }
    }
    const frames = await this.fetchStack();
    if (generation !== this.generation || this.stopSerial !== serial || this.isDeadState()) {
      return;
    }
    const top = frames.find((f) => f.path) ?? frames[0];
    let scopes: ClientScope[] = [];
    const variables: Record<number, ClientVariable[]> = {};
    if (top) {
      scopes = await this.fetchScopes(top.id);
      for (const scope of scopes) {
        if (scope.variablesReference <= 0) continue;
        if (!shouldPrefetchScope(scope.name)) continue;
        variables[scope.variablesReference] = await this.fetchVariables(
          scope.variablesReference,
        );
      }
    }
    if (generation !== this.generation || this.stopSerial !== serial || this.isDeadState()) {
      return;
    }
    this.stopInFlight = false;
    this.setState(
      "paused",
      typeof body.description === "string"
        ? body.description
        : reason,
    );
    this.sendToSocket({
      type: "stopped",
      reason,
      threadId: this.threadId,
      description: typeof body.description === "string" ? body.description : undefined,
      frames,
      scopes,
      variables,
    });
  }

  private onContinued(): void {
    if (this.isDeadState()) return;
    if (this.stopInFlight) return;
    if (this.state === "paused" && !this.continueExpected) return;
    if (this.state === "paused" || this.state === "starting") {
      this.setState("running");
    }
    this.continueExpected = false;
    this.sendToSocket({ type: "continued", threadId: this.threadId });
  }

  private onAdapterMessage(raw: unknown): void {
    if (!raw || typeof raw !== "object") return;
    const generation = this.generation;
    const msg = raw as Record<string, unknown>;
    const kind = msg.type;
    if (kind === "event") {
      this.onAdapterEvent(msg, generation);
      return;
    }
    if (kind === "response") {
      const reqSeq = msg.request_seq;
      if (typeof reqSeq !== "number") return;
      const pending = this.pending.get(reqSeq);
      if (!pending) return;
      this.pending.delete(reqSeq);
      clearTimeout(pending.timer);
      if (msg.success === false) {
        const message =
          typeof msg.message === "string"
            ? msg.message
            : `${pending.command} failed`;
        pending.reject(new Error(message));
        return;
      }
      pending.resolve(msg.body);
      return;
    }
    if (kind === "request") {
      this.onAdapterRequest(msg);
    }
  }

  private onAdapterEvent(
    msg: Record<string, unknown>,
    generation = this.generation,
  ): void {
    if (generation !== this.generation) return;
    if (this.isDeadState()) return;
    const event = msg.event;
    const body =
      msg.body && typeof msg.body === "object"
        ? (msg.body as Record<string, unknown>)
        : {};
    if (event === "initialized") {
      this.initializedEvent = true;
      return;
    }
    if (event === "stopped") {
      void this.onStopped(body, generation);
      return;
    }
    if (event === "continued") {
      this.onContinued();
      return;
    }
    if (event === "exited" || event === "terminated") {
      if (this.isDeadState()) return;
      const code = typeof body.exitCode === "number" ? body.exitCode : null;
      this.sendToSocket({ type: "exited", exitCode: code });
      this.finishTerminated("program exited");
      return;
    }
    if (event === "output") {
      this.onOutput(body);
      return;
    }
    if (event === "thread" && typeof body.threadId === "number") {
      this.threadId = body.threadId;
    }
  }

  private onOutput(body: Record<string, unknown>): void {
    const category =
      body.category === "stderr" || body.category === "console"
        ? body.category
        : "stdout";
    const text = typeof body.output === "string" ? body.output : "";
    if (!text) return;
    if (this.outputChars >= this.limits.maxOutputChars) return;
    const remaining = this.limits.maxOutputChars - this.outputChars;
    const clipped = text.length > remaining ? text.slice(0, remaining) : text;
    this.outputChars += clipped.length;
    this.sendToSocket({ type: "output", category, text: clipped });
  }

  private onAdapterRequest(msg: Record<string, unknown>): void {
    const command = msg.command;
    const seq = msg.seq;
    if (typeof command !== "string" || typeof seq !== "number") return;
    if (REJECTED_ADAPTER_REQUESTS.has(command)) {
      this.writeDap({
        seq: this.nextSeq++,
        type: "response",
        request_seq: seq,
        success: false,
        command,
        message: "not supported",
      });
      return;
    }
    this.writeDap({
      seq: this.nextSeq++,
      type: "response",
      request_seq: seq,
      success: true,
      command,
      body: {},
    });
  }

  private dapRequest(
    command: string,
    args: unknown,
    timeoutMs = this.limits.requestTimeoutMs,
  ): Promise<unknown> {
    if (!ADAPTER_REQUESTS.has(command)) {
      return Promise.reject(new Error("command not allowed"));
    }
    if (this.pending.size >= DEBUG_MAX_PENDING) {
      return Promise.reject(new Error("too many in-flight debug requests"));
    }
    if (!this.writeStdin) {
      return Promise.reject(new Error("debug adapter is not running"));
    }
    const seq = this.nextSeq++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(seq);
        reject(new Error(`${command} timed out`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(seq, { command, resolve, reject, timer });
      this.writeDap({
        seq,
        type: "request",
        command,
        arguments: args ?? {},
      });
    });
  }

  private writeDap(msg: unknown): void {
    if (!this.writeStdin) return;
    try {
      this.writeStdin(encodeLspFrame(msg));
    } catch {}
  }

  private killAdapter(reason: string): void {
    this.clearStartupTimer();
    this.clearSessionTimer();
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
    this.pending.clear();
    if (this.writeStdin) {
      try {
        this.writeDap({
          seq: this.nextSeq++,
          type: "request",
          command: "disconnect",
          arguments: { terminateDebuggee: true, restart: false },
        });
      } catch {}
    }
    const child = this.child;
    this.child = null;
    this.writeStdin = null;
    if (child && child.exitCode === null && child.signalCode === null) {
      const killTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {}
      }, 1500);
      killTimer.unref?.();
      try {
        child.kill("SIGTERM");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {}
      }
    }
  }

  private releaseSlot(): void {
    if (!this.acquired) return;
    this.acquired = false;
    try {
      this.hooks.release();
    } catch {}
  }

  private fail(state: "failed" | "unavailable", message: string): void {
    if (this.disposed) return;
    const extra = this.stderrTail.trim();
    const full = extra
      ? `${message}: ${clipString(extra, 400)}`
      : message;
    this.killAdapter(message);
    this.releaseSlot();
    this.setState(state, full);
    const isTimedOut = message.toLowerCase().includes("timed out");
    const failureType = state === "unavailable"
      ? (isTimedOut ? "DEBUG_SESSION_TIMEOUT" : "DEBUG_SESSION_FAILED")
      : isTimedOut
        ? "DEBUG_SESSION_TIMEOUT"
        : "DEBUG_SESSION_FAILED";
    this.recordAudit(failureType, full.slice(0, 200));
    this._auditTerminalLogged = true;
  }

  private finishTerminated(message: string): void {
    if (this.disposed) return;
    this.killAdapter(message);
    this.releaseSlot();
    this.setState("terminated", message);
  }

  private setState(state: DebugSessionState, message?: string): void {
    this.state = state;
    this.statusMessage = message;
    this.broadcastStatus();
  }

  private broadcastStatus(): void {
    this.sendStatus();
  }

  private sendStatus(): void {
    this.sendToSocket({
      type: "status",
      state: this.state,
      language: this.language?.id ?? null,
      entryFile: this.entryFile,
      message: this.statusMessage,
    });
  }

  private sendError(message: string): void {
    this.sendToSocket({ type: "error", message });
  }

  private sendToSocket(payload: unknown): void {
    if (!this.socket || this.socket.readyState !== WS_OPEN) return;
    try {
      this.socket.send(JSON.stringify(payload));
    } catch {}
  }

  private armStartupTimer(): void {
    this.clearStartupTimer();
    this.startupTimer = setTimeout(() => {
      this.startupTimer = null;
      if (this.state === "starting") {
        this.fail("unavailable", "debugger startup timed out");
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

  private armSessionTimer(): void {
    this.clearSessionTimer();
    this.sessionTimer = setTimeout(() => {
      this.sessionTimer = null;
      if (
        this.state === "starting" ||
        this.state === "running" ||
        this.state === "paused"
      ) {
        this.dispose("session_timeout");
      }
    }, this.limits.sessionTimeoutMs);
    this.sessionTimer.unref?.();
  }

  private clearSessionTimer(): void {
    if (this.sessionTimer) {
      clearTimeout(this.sessionTimer);
      this.sessionTimer = null;
    }
  }

  private now(): number {
    return this.hooks.now ? this.hooks.now() : Date.now();
  }
}
