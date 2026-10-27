import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { makeTestConfig } from "./helpers.js";
import { languageServers, resetLanguageServersForTests } from "../src/lsp/manager.js";
import { LSP_MAX_OPEN_DOCS_PER_CLIENT, type LspClientSocket } from "../src/lsp/session.js";
import type { LspSpawnRequest } from "../src/lsp/process.js";
import { toWorkspaceUri } from "../src/lsp/uri.js";
import { debugSessions, resetDebugSessionsForTests } from "../src/debug/manager.js";
import { DEBUG_MAX_BREAKPOINT_FILES } from "../src/debug/bounds.js";
import type { DebugClientSocket } from "../src/debug/session.js";

const fakeLsp = fileURLToPath(new URL("./fixtures/fake-lsp.mjs", import.meta.url));

class Sock implements LspClientSocket, DebugClientSocket {
  readyState = 1;
  messages: any[] = [];
  send(data: string): void {
    this.messages.push(JSON.parse(data));
  }
  close(): void {
    this.readyState = 3;
  }
  lastStatus(): any {
    return [...this.messages].reverse().find((m) => m.type === "status");
  }
}

async function waitFor(pred: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("timeout");
}

describe("M116 resource caps", () => {
  beforeEach(() => {
    resetLanguageServersForTests();
    resetDebugSessionsForTests();
    languageServers.setSpawnForTests((_req: LspSpawnRequest) =>
      spawn(process.execPath, [fakeLsp], {
        stdio: ["pipe", "pipe", "pipe"],
        env: process.env,
        windowsHide: true,
      }),
    );
    languageServers.setContainerForTests(() => "ide-sandbox-caps");
    debugSessions.setContainerForTests(() => "ide-sandbox-caps");
  });
  afterEach(() => {
    resetLanguageServersForTests();
    resetDebugSessionsForTests();
  });

  it("LSP drops didOpen beyond the per-socket document cap", async () => {
    const cfg = makeTestConfig();
    const sock = new Sock();
    const session = await languageServers.attach({
      projectId: "caps",
      language: "python",
      userId: 1,
      cfg,
      socket: sock,
      workspaceDir: cfg.workspacesDir,
    });
    await waitFor(() => sock.lastStatus()?.state === "ready");
    for (let i = 0; i < LSP_MAX_OPEN_DOCS_PER_CLIENT + 25; i++) {
      session!.handleClientMessage(sock, {
        jsonrpc: "2.0",
        method: "textDocument/didOpen",
        params: {
          textDocument: {
            uri: toWorkspaceUri(`f${i}.py`),
            languageId: "python",
            version: 1,
            text: "x = 1\n",
          },
        },
      });
    }
    expect(session!.openDocumentCount()).toBe(LSP_MAX_OPEN_DOCS_PER_CLIENT);
  });

  it("debug setBreakpoints rejects a new file past the cap but allows updating existing ones", async () => {
    const cfg = makeTestConfig();
    const sock = new Sock();
    const session = await debugSessions.attach({
      projectId: "caps",
      userId: 1,
      cfg,
      socket: sock,
      workspaceDir: cfg.workspacesDir,
    });
    for (let i = 0; i < DEBUG_MAX_BREAKPOINT_FILES; i++) {
      session!.handleClientMessage(sock, { type: "setBreakpoints", path: `f${i}.py`, lines: [1] });
    }
    await waitFor(
      () =>
        sock.messages.filter((m) => m.type === "breakpoints").length === DEBUG_MAX_BREAKPOINT_FILES,
    );
    session!.handleClientMessage(sock, { type: "setBreakpoints", path: "extra.py", lines: [1] });
    session!.handleClientMessage(sock, { type: "setBreakpoints", path: "f0.py", lines: [2] });
    await waitFor(
      () =>
        sock.messages.filter((m) => m.type === "breakpoints").length ===
        DEBUG_MAX_BREAKPOINT_FILES + 1,
    );
    expect(sock.messages.some((m) => m.type === "error" && /too many files/.test(m.message))).toBe(
      true,
    );
    expect(
      sock.messages.filter((m) => m.type === "breakpoints" && m.path === "extra.py"),
    ).toHaveLength(0);
  });
});

describe("M116b attach races and cancel isolation", () => {
  beforeEach(() => {
    resetLanguageServersForTests();
    resetDebugSessionsForTests();
    languageServers.setSpawnForTests((_req: LspSpawnRequest) =>
      spawn(process.execPath, [fakeLsp], {
        stdio: ["pipe", "pipe", "pipe"],
        env: process.env,
        windowsHide: true,
      }),
    );
    languageServers.setContainerForTests(() => "ide-sandbox-race");
    debugSessions.setContainerForTests(() => "ide-sandbox-race");
  });
  afterEach(() => {
    resetLanguageServersForTests();
    resetDebugSessionsForTests();
  });

  it("parallel debug attaches for one (project, user) share a single session", async () => {
    const cfg = makeTestConfig();
    debugSessions.setAttachDelayForTests(0);
    const socks = Array.from({ length: 10 }, () => new Sock());
    const sessions = await Promise.all(
      socks.map((socket) =>
        debugSessions.attach({
          projectId: "race",
          userId: 1,
          cfg,
          socket,
          workspaceDir: cfg.workspacesDir,
        }),
      ),
    );
    expect(debugSessions.sessionCount()).toBe(1);
    expect(new Set(sessions).size).toBe(1);
  });

  it("parallel LSP attaches for one (project, language) share a single session", async () => {
    const cfg = makeTestConfig();
    const socks = Array.from({ length: 10 }, () => new Sock());
    const sessions = await Promise.all(
      socks.map((socket) =>
        languageServers.attach({
          projectId: "race",
          language: "python",
          userId: 1,
          cfg,
          socket,
          workspaceDir: cfg.workspacesDir,
        }),
      ),
    );
    expect(languageServers.sessionCount()).toBe(1);
    expect(new Set(sessions).size).toBe(1);
    expect(sessions[0]!.clientCount).toBe(10);
  });

  it("$/cancelRequest only reaches the sender's own pending request, with the server id", async () => {
    const cfg = makeTestConfig();
    const a = new Sock();
    const b = new Sock();
    const attachOpts = {
      projectId: "cancel",
      language: "python",
      userId: 1,
      cfg,
      workspaceDir: cfg.workspacesDir,
    };
    const session = (await languageServers.attach({ ...attachOpts, socket: a }))!;
    await languageServers.attach({ ...attachOpts, userId: 2, socket: b });
    await waitFor(() => a.lastStatus()?.state === "ready");

    const sent: any[] = [];
    (session as any).sendServer = (m: any) => void sent.push(m);

    const hover = {
      jsonrpc: "2.0",
      id: 5,
      method: "textDocument/hover",
      params: {
        textDocument: { uri: toWorkspaceUri("a.py") },
        position: { line: 0, character: 0 },
      },
    };
    session.handleClientMessage(a, hover);
    const serverId = sent.find((m) => m.method === "textDocument/hover").id;

    // B guesses A's client id: nothing may reach the server.
    session.handleClientMessage(b, {
      jsonrpc: "2.0",
      method: "$/cancelRequest",
      params: { id: 5 },
    });
    expect(sent.filter((m) => m.method === "$/cancelRequest")).toHaveLength(0);

    // A cancels its own request: forwarded with the translated server id.
    session.handleClientMessage(a, {
      jsonrpc: "2.0",
      method: "$/cancelRequest",
      params: { id: 5 },
    });
    const cancels = sent.filter((m) => m.method === "$/cancelRequest");
    expect(cancels).toHaveLength(1);
    expect(cancels[0].params.id).toBe(serverId);
  });
});
