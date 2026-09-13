import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { makeTestConfig } from "./helpers.js";
import {
  languageServers,
  resetLanguageServersForTests,
} from "../src/lsp/manager.js";
import type { LspClientSocket } from "../src/lsp/session.js";
import type { LspSpawnRequest } from "../src/lsp/process.js";

const fakeLsp = fileURLToPath(new URL("./fixtures/fake-lsp.mjs", import.meta.url));

function spawnFake(extraEnv: NodeJS.ProcessEnv = {}) {
  return (_req: LspSpawnRequest) =>
    spawn(process.execPath, [fakeLsp], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...extraEnv },
      windowsHide: true,
    });
}

class FakeSock implements LspClientSocket {
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

async function waitFor(
  pred: () => boolean,
  ms = 5000,
  label = "condition",
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for ${label}`);
}

describe("lsp manager lifecycle", () => {
  beforeEach(() => {
    resetLanguageServersForTests();
    languageServers.setSpawnForTests(spawnFake());
    languageServers.setContainerForTests(() => "ide-sandbox-test");
  });
  afterEach(() => {
    resetLanguageServersForTests();
  });

  it("starts a session, reuses it, and reports ready", async () => {
    const cfg = makeTestConfig();
    const a = new FakeSock();
    const b = new FakeSock();
    const s1 = await languageServers.attach({
      projectId: "p1",
      language: "python",
      userId: 1,
      cfg,
      socket: a,
      workspaceDir: cfg.workspacesDir,
    });
    const s2 = await languageServers.attach({
      projectId: "p1",
      language: "python",
      userId: 2,
      cfg,
      socket: b,
      workspaceDir: cfg.workspacesDir,
    });
    expect(s1).toBe(s2);
    expect(languageServers.sessionCount()).toBe(1);
    await waitFor(() => a.lastStatus()?.state === "ready", 5000, "ready");
    expect(b.lastStatus()?.state).toBe("ready");
    expect(s1?.clientCount).toBe(2);
  });

  it("opens a document and publishes diagnostics without a process-per-keystroke", async () => {
    const cfg = makeTestConfig();
    const sock = new FakeSock();
    const session = await languageServers.attach({
      projectId: "p1",
      language: "python",
      userId: 1,
      cfg,
      socket: sock,
      workspaceDir: cfg.workspacesDir,
    });
    await waitFor(() => sock.lastStatus()?.state === "ready", 5000, "ready");
    const pid = session!.pid;
    session!.handleClientMessage(sock, {
      jsonrpc: "2.0",
      method: "textDocument/didOpen",
      params: {
        textDocument: {
          uri: "file:///workspace/main.py",
          text: "undefined_name\n",
        },
      },
    });
    await waitFor(
      () =>
        sock.messages.some(
          (m) =>
            m.method === "textDocument/publishDiagnostics" &&
            m.params?.diagnostics?.length > 0,
        ),
      5000,
      "diagnostics",
    );
    session!.handleClientMessage(sock, {
      jsonrpc: "2.0",
      method: "textDocument/didChange",
      params: {
        textDocument: { uri: "file:///workspace/main.py" },
        contentChanges: [{ text: "undefined_name = 1\n" }],
      },
    });
    expect(session!.pid).toBe(pid);
    expect(languageServers.activeProcessCount()).toBe(1);
  });

  it("answers completion, hover, definition, references, and symbols", async () => {
    const cfg = makeTestConfig();
    const sock = new FakeSock();
    const session = await languageServers.attach({
      projectId: "p1",
      language: "python",
      userId: 1,
      cfg,
      socket: sock,
      workspaceDir: cfg.workspacesDir,
    });
    await waitFor(() => sock.lastStatus()?.state === "ready", 5000, "ready");
    session!.handleClientMessage(sock, {
      jsonrpc: "2.0",
      method: "textDocument/didOpen",
      params: {
        textDocument: { uri: "file:///workspace/main.py", text: "def main():\n  pass\n" },
      },
    });
    const methods = [
      [10, "textDocument/completion"],
      [11, "textDocument/hover"],
      [12, "textDocument/definition"],
      [13, "textDocument/references"],
      [14, "textDocument/documentSymbol"],
      [15, "workspace/symbol"],
    ] as const;
    for (const [id, method] of methods) {
      session!.handleClientMessage(sock, {
        jsonrpc: "2.0",
        id,
        method,
        params: {
          textDocument: { uri: "file:///workspace/main.py" },
          position: { line: 0, character: 4 },
          query: "main",
          context: { includeDeclaration: true },
        },
      });
      await waitFor(() => sock.messages.some((m) => m.id === id), 3000, method);
    }
    const completion = sock.messages.find((m) => m.id === 10);
    expect(completion.result.items[0].label).toBe("hello");
    expect(sock.messages.find((m) => m.id === 11).result.contents.value).toMatch(
      /fake hover/,
    );
    expect(sock.messages.find((m) => m.id === 12).result.uri).toBe(
      "file:///workspace/main.py",
    );
    expect(sock.messages.find((m) => m.id === 13).result[0].uri).toBe(
      "file:///workspace/main.py",
    );
    expect(sock.messages.find((m) => m.id === 14).result[0].name).toBe("main");
    expect(sock.messages.find((m) => m.id === 15).result[0].name).toBe("main");
  });

  it("isolates projects: A cannot attach to B's session", async () => {
    const cfg = makeTestConfig();
    const a = new FakeSock();
    const b = new FakeSock();
    const sa = await languageServers.attach({
      projectId: "proj-a",
      language: "python",
      userId: 1,
      cfg,
      socket: a,
      workspaceDir: cfg.workspacesDir,
    });
    const sb = await languageServers.attach({
      projectId: "proj-b",
      language: "python",
      userId: 1,
      cfg,
      socket: b,
      workspaceDir: cfg.workspacesDir,
    });
    expect(sa).not.toBe(sb);
    expect(languageServers.sessionCount()).toBe(2);
    expect(sa?.projectId).toBe("proj-a");
    expect(sb?.projectId).toBe("proj-b");
  });

  it("disposes on project deletion and on disposeAll", async () => {
    const cfg = makeTestConfig();
    const sock = new FakeSock();
    await languageServers.attach({
      projectId: "gone",
      language: "python",
      userId: 1,
      cfg,
      socket: sock,
      workspaceDir: cfg.workspacesDir,
    });
    await waitFor(() => sock.lastStatus()?.state === "ready", 5000, "ready");
    languageServers.disposeProject("gone");
    expect(languageServers.sessionCount()).toBe(0);
    expect(sock.lastStatus()?.state).toBe("stopped");
  });

  it("idles out a session with no clients", async () => {
    const cfg = makeTestConfig({ lspIdleTimeoutMs: 80 });
    const sock = new FakeSock();
    const session = await languageServers.attach({
      projectId: "idle",
      language: "python",
      userId: 1,
      cfg,
      socket: sock,
      workspaceDir: cfg.workspacesDir,
    });
    await waitFor(() => sock.lastStatus()?.state === "ready", 5000, "ready");
    session!.removeClient(sock);
    await waitFor(() => languageServers.sessionCount() === 0, 2000, "idle reap");
  });

  it("surfaces a crash then stops restarting after the cap", async () => {
    languageServers.setSpawnForTests(spawnFake({ FAKE_LSP_CRASH: "1" }));
    const cfg = makeTestConfig({
      lspMaxRestarts: 1,
      lspRestartWindowMs: 60_000,
      lspStartupTimeoutMs: 3000,
    });
    const sock = new FakeSock();
    await languageServers.attach({
      projectId: "crashy",
      language: "python",
      userId: 1,
      cfg,
      socket: sock,
      workspaceDir: cfg.workspacesDir,
    });
    await waitFor(
      () => sock.lastStatus()?.state === "failed",
      8000,
      "failed after restart cap",
    );
  });

  it("times out a hung initialize without restarting", async () => {
    languageServers.setSpawnForTests(spawnFake({ FAKE_LSP_SLOW: "1" }));
    const cfg = makeTestConfig({ lspStartupTimeoutMs: 80, lspMaxRestarts: 3 });
    const sock = new FakeSock();
    const session = await languageServers.attach({
      projectId: "slow",
      language: "python",
      userId: 1,
      cfg,
      socket: sock,
      workspaceDir: cfg.workspacesDir,
    });
    expect(cfg.lspStartupTimeoutMs).toBe(80);
    expect(session?.limits.startupTimeoutMs).toBe(80);
    await waitFor(
      () => sock.lastStatus()?.state === "unavailable",
      3000,
      "startup timeout",
    );
    expect(session?.currentState).toBe("unavailable");
    expect(session?.pid).toBeUndefined();
    await new Promise((r) => setTimeout(r, 250));
    expect(sock.lastStatus()?.state).toBe("unavailable");
    expect(languageServers.sessionCount()).toBe(1);
  });

  it("rejects an unsupported language without spawning", async () => {
    const cfg = makeTestConfig();
    const sock = new FakeSock();
    const session = await languageServers.attach({
      projectId: "p1",
      language: "java",
      userId: 1,
      cfg,
      socket: sock,
      workspaceDir: cfg.workspacesDir,
    });
    expect(session).toBeNull();
    expect(languageServers.sessionCount()).toBe(0);
  });

  it("enforces the global process cap by refusing when none are idle", async () => {
    const cfg = makeTestConfig({ maxLspServers: 1 });
    const a = new FakeSock();
    const b = new FakeSock();
    await languageServers.attach({
      projectId: "one",
      language: "python",
      userId: 1,
      cfg,
      socket: a,
      workspaceDir: cfg.workspacesDir,
    });
    await waitFor(() => a.lastStatus()?.state === "ready", 5000, "ready");
    const second = await languageServers.attach({
      projectId: "two",
      language: "python",
      userId: 1,
      cfg,
      socket: b,
      workspaceDir: cfg.workspacesDir,
    });
    expect(second).toBeNull();
    expect(languageServers.sessionCount()).toBe(1);
  });

  it("reports unavailable when spawn throws", async () => {
    languageServers.setSpawnForTests(() => {
      throw new Error("docker missing");
    });
    const cfg = makeTestConfig();
    const sock = new FakeSock();
    const session = await languageServers.attach({
      projectId: "nospawn",
      language: "python",
      userId: 1,
      cfg,
      socket: sock,
      workspaceDir: cfg.workspacesDir,
    });
    expect(session).not.toBeNull();
    expect(sock.lastStatus()?.state).toBe("unavailable");
    expect(session!.pid).toBeUndefined();
  });

  it("fails closed on a malformed language-server frame", async () => {
    languageServers.setSpawnForTests(spawnFake({ FAKE_LSP_MALFORMED: "1" }));
    const cfg = makeTestConfig();
    const sock = new FakeSock();
    await languageServers.attach({
      projectId: "badframe",
      language: "python",
      userId: 1,
      cfg,
      socket: sock,
      workspaceDir: cfg.workspacesDir,
    });
    await waitFor(
      () =>
        sock.lastStatus()?.state === "failed" ||
        sock.lastStatus()?.state === "unavailable",
      5000,
      "malformed frame",
    );
  });

  it("runs python and typescript as two sessions in one project", async () => {
    const cfg = makeTestConfig();
    const py = new FakeSock();
    const ts = new FakeSock();
    const sPy = await languageServers.attach({
      projectId: "both",
      language: "python",
      userId: 1,
      cfg,
      socket: py,
      workspaceDir: cfg.workspacesDir,
    });
    const sTs = await languageServers.attach({
      projectId: "both",
      language: "typescript",
      userId: 1,
      cfg,
      socket: ts,
      workspaceDir: cfg.workspacesDir,
    });
    expect(sPy).not.toBe(sTs);
    expect(languageServers.sessionCount()).toBe(2);
    await waitFor(() => py.lastStatus()?.state === "ready", 5000, "py ready");
    await waitFor(() => ts.lastStatus()?.state === "ready", 5000, "ts ready");
  });

  it("enforces the per-project cap of two servers", async () => {
    const cfg = makeTestConfig({ maxLspServersPerProject: 1 });
    const a = new FakeSock();
    const b = new FakeSock();
    await languageServers.attach({
      projectId: "cap",
      language: "python",
      userId: 1,
      cfg,
      socket: a,
      workspaceDir: cfg.workspacesDir,
    });
    const second = await languageServers.attach({
      projectId: "cap",
      language: "typescript",
      userId: 1,
      cfg,
      socket: b,
      workspaceDir: cfg.workspacesDir,
    });
    expect(second).toBeNull();
    expect(languageServers.sessionCount()).toBe(1);
  });

  it("does not let a second opener clobber the canonical document", async () => {
    const cfg = makeTestConfig();
    const a = new FakeSock();
    const b = new FakeSock();
    const session = await languageServers.attach({
      projectId: "canon",
      language: "python",
      userId: 1,
      cfg,
      socket: a,
      workspaceDir: cfg.workspacesDir,
    });
    await languageServers.attach({
      projectId: "canon",
      language: "python",
      userId: 2,
      cfg,
      socket: b,
      workspaceDir: cfg.workspacesDir,
    });
    await waitFor(() => a.lastStatus()?.state === "ready", 5000, "ready");
    session!.handleClientMessage(a, {
      jsonrpc: "2.0",
      method: "textDocument/didOpen",
      params: {
        textDocument: {
          uri: "file:///workspace/main.py",
          text: "undefined_name\n",
        },
      },
    });
    await waitFor(
      () =>
        a.messages.some(
          (m) =>
            m.method === "textDocument/publishDiagnostics" &&
            m.params?.diagnostics?.length > 0,
        ),
      5000,
      "diags from A",
    );
    a.messages = a.messages.filter(
      (m) => m.method !== "textDocument/publishDiagnostics",
    );
    session!.handleClientMessage(b, {
      jsonrpc: "2.0",
      method: "textDocument/didOpen",
      params: {
        textDocument: {
          uri: "file:///workspace/main.py",
          text: "x = 1\n",
        },
      },
    });
    await new Promise((r) => setTimeout(r, 200));
    const cleared = a.messages.some(
      (m) =>
        m.method === "textDocument/publishDiagnostics" &&
        Array.isArray(m.params?.diagnostics) &&
        m.params.diagnostics.length === 0,
    );
    expect(cleared).toBe(false);
  });

  it("does not double-count refs when the same socket re-sends didOpen", async () => {
    const cfg = makeTestConfig();
    const sock = new FakeSock();
    const session = await languageServers.attach({
      projectId: "reopen",
      language: "python",
      userId: 1,
      cfg,
      socket: sock,
      workspaceDir: cfg.workspacesDir,
    });
    await waitFor(() => sock.lastStatus()?.state === "ready", 5000, "ready");
    const open = {
      jsonrpc: "2.0",
      method: "textDocument/didOpen",
      params: {
        textDocument: {
          uri: "file:///workspace/main.py",
          text: "undefined_name\n",
        },
      },
    };
    session!.handleClientMessage(sock, open);
    session!.handleClientMessage(sock, open);
    session!.handleClientMessage(sock, {
      jsonrpc: "2.0",
      method: "textDocument/didClose",
      params: { textDocument: { uri: "file:///workspace/main.py" } },
    });
    await new Promise((r) => setTimeout(r, 50));
    sock.messages = sock.messages.filter(
      (m) => m.method !== "textDocument/publishDiagnostics",
    );
    session!.handleClientMessage(sock, {
      jsonrpc: "2.0",
      method: "textDocument/didOpen",
      params: {
        textDocument: {
          uri: "file:///workspace/main.py",
          text: "x = 1\n",
        },
      },
    });
    await waitFor(
      () =>
        sock.messages.some(
          (m) =>
            m.method === "textDocument/publishDiagnostics" &&
            m.params?.uri === "file:///workspace/main.py",
        ),
      5000,
      "reopen after single close",
    );
  });

  it("applies canonical subscribe updates as didChange", async () => {
    const cfg = makeTestConfig();
    const sock = new FakeSock();
    let listener: ((text: string) => void) | null = null;
    const source = {
      read: () => "undefined_name\n",
      subscribe: (_path: string, onChange: (text: string) => void) => {
        listener = onChange;
        return () => {
          listener = null;
        };
      },
    };
    const session = await languageServers.attach({
      projectId: "sub",
      language: "python",
      userId: 1,
      cfg,
      socket: sock,
      workspaceDir: cfg.workspacesDir,
      documentSource: source,
    });
    await waitFor(() => sock.lastStatus()?.state === "ready", 5000, "ready");
    session!.handleClientMessage(sock, {
      jsonrpc: "2.0",
      method: "textDocument/didOpen",
      params: {
        textDocument: {
          uri: "file:///workspace/main.py",
          text: "x = 1\n",
        },
      },
    });
    await waitFor(
      () =>
        sock.messages.some(
          (m) =>
            m.method === "textDocument/publishDiagnostics" &&
            m.params?.diagnostics?.length > 0,
        ),
      5000,
      "open diags",
    );
    expect(listener).not.toBeNull();
    listener!("x = 1\n");
    await waitFor(() => {
      const last = [...sock.messages]
        .reverse()
        .find(
          (m) =>
            m.method === "textDocument/publishDiagnostics" &&
            m.params?.uri === "file:///workspace/main.py",
        );
      return Array.isArray(last?.params?.diagnostics) && last.params.diagnostics.length === 0;
    }, 5000, "subscribe cleared diags");
  });

  it("prefers the canonical document source over a stale client payload", async () => {
    const cfg = makeTestConfig();
    const sock = new FakeSock();
    const source = {
      read: () => "undefined_name\n",
      subscribe: () => () => {},
    };
    const session = await languageServers.attach({
      projectId: "yjs",
      language: "python",
      userId: 1,
      cfg,
      socket: sock,
      workspaceDir: cfg.workspacesDir,
      documentSource: source,
    });
    await waitFor(() => sock.lastStatus()?.state === "ready", 5000, "ready");
    session!.handleClientMessage(sock, {
      jsonrpc: "2.0",
      method: "textDocument/didOpen",
      params: {
        textDocument: {
          uri: "file:///workspace/main.py",
          text: "x = 1\n",
        },
      },
    });
    await waitFor(
      () =>
        sock.messages.some(
          (m) =>
            m.method === "textDocument/publishDiagnostics" &&
            m.params?.diagnostics?.length > 0,
        ),
      5000,
      "canonical diags",
    );
  });

  it("keeps the shared server when one collaborator disconnects", async () => {
    const cfg = makeTestConfig();
    const a = new FakeSock();
    const b = new FakeSock();
    const session = await languageServers.attach({
      projectId: "collab",
      language: "python",
      userId: 1,
      cfg,
      socket: a,
      workspaceDir: cfg.workspacesDir,
    });
    await languageServers.attach({
      projectId: "collab",
      language: "python",
      userId: 2,
      cfg,
      socket: b,
      workspaceDir: cfg.workspacesDir,
    });
    await waitFor(() => a.lastStatus()?.state === "ready", 5000, "ready");
    session!.removeClient(a);
    expect(languageServers.sessionCount()).toBe(1);
    expect(session!.clientCount).toBe(1);
    expect(session!.currentState).toBe("ready");
  });
});
