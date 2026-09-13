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
import { spawnSandboxLsp, sandboxLspArgv } from "../src/lsp/process.js";

const fakeLsp = fileURLToPath(new URL("./fixtures/fake-lsp.mjs", import.meta.url));

function spawnFake() {
  return (_req: LspSpawnRequest) =>
    spawn(process.execPath, [fakeLsp], {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
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

async function waitFor(pred: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("timeout");
}

describe("lsp security envelope", () => {
  beforeEach(() => {
    resetLanguageServersForTests();
    languageServers.setSpawnForTests(spawnFake());
    languageServers.setContainerForTests(() => "ide-sandbox-secure");
  });
  afterEach(() => {
    resetLanguageServersForTests();
  });

  it("ignores workspace/executeCommand from the client", async () => {
    const cfg = makeTestConfig();
    const sock = new FakeSock();
    const session = await languageServers.attach({
      projectId: "sec",
      language: "python",
      userId: 1,
      cfg,
      socket: sock,
      workspaceDir: cfg.workspacesDir,
    });
    await waitFor(() => sock.lastStatus()?.state === "ready");
    session!.handleClientMessage(sock, {
      jsonrpc: "2.0",
      id: 99,
      method: "workspace/executeCommand",
      params: { command: "shell", arguments: ["rm", "-rf", "/"] },
    });
    await new Promise((r) => setTimeout(r, 150));
    expect(sock.messages.some((m) => m.id === 99 && m.result?.executed)).toBe(
      false,
    );
    expect(
      sock.messages.some((m) => m.result && m.result.command === "shell"),
    ).toBe(false);
  });

  it("ignores client initialize/shutdown and does not let the client pick an executable", async () => {
    const cfg = makeTestConfig();
    const sock = new FakeSock();
    const session = await languageServers.attach({
      projectId: "sec",
      language: "python",
      userId: 1,
      cfg,
      socket: sock,
      workspaceDir: cfg.workspacesDir,
    });
    await waitFor(() => sock.lastStatus()?.state === "ready");
    session!.handleClientMessage(sock, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        processId: 1,
        rootUri: "file:///etc",
        initializationOptions: { command: "/bin/sh" },
      },
    });
    session!.handleClientMessage(sock, {
      jsonrpc: "2.0",
      method: "exit",
    });
    await new Promise((r) => setTimeout(r, 80));
    expect(session!.currentState).toBe("ready");
  });

  it("rejects hover against a uri outside the project workspace", async () => {
    const cfg = makeTestConfig();
    const sock = new FakeSock();
    const session = await languageServers.attach({
      projectId: "sec",
      language: "python",
      userId: 1,
      cfg,
      socket: sock,
      workspaceDir: cfg.workspacesDir,
    });
    await waitFor(() => sock.lastStatus()?.state === "ready");
    session!.handleClientMessage(sock, {
      jsonrpc: "2.0",
      id: 7,
      method: "textDocument/hover",
      params: {
        textDocument: { uri: "file:///etc/passwd" },
        position: { line: 0, character: 0 },
      },
    });
    await waitFor(() => sock.messages.some((m) => m.id === 7));
    const reply = sock.messages.find((m) => m.id === 7);
    expect(reply.error).toBeTruthy();
    expect(reply.error.message).toMatch(/invalid document uri/i);
  });

  it("does not accept a client-supplied languageServerExecutable", async () => {
    const cfg = makeTestConfig();
    const sock = new FakeSock();
    const session = await languageServers.attach({
      projectId: "sec",
      language: "python",
      userId: 1,
      cfg,
      socket: sock,
      workspaceDir: cfg.workspacesDir,
    });
    await waitFor(() => sock.lastStatus()?.state === "ready");
    session!.handleClientMessage(sock, {
      type: "start",
      languageServerExecutable: "../../some-secret-binary",
      args: ["-c", "evil"],
    });
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
    expect(session!.currentState).toBe("ready");
  });

  it("sandbox LSP argv is docker exec of the allowlisted binary only", () => {
    const argv = sandboxLspArgv({
      spec: {
        id: "python",
        monacoId: "python",
        displayName: "Python",
        extensions: ["py"],
        command: "pylsp",
        args: [],
      },
      containerId: "ide-sandbox-abc",
    });
    expect(argv).toContain("exec");
    expect(argv).toContain("pylsp");
    expect(argv).toContain("ide-sandbox-abc");
    expect(argv.join(" ")).not.toMatch(
      /SECRETS_MASTER_KEY|GIT_HTTPS_TOKEN|ADMIN_PASSWORD/,
    );
    const envFlags: string[] = [];
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === "-e" && argv[i + 1]) envFlags.push(argv[i + 1]);
    }
    expect(
      envFlags.every((e) => !/SECRET|TOKEN|PASSWORD|DATABASE/i.test(e)),
    ).toBe(true);
    expect(envFlags).toContain("HOME=/tmp");
  });

  it("rejects a malformed container id before spawn", () => {
    expect(() =>
      spawnSandboxLsp({
        spec: {
          id: "python",
          monacoId: "python",
          displayName: "Python",
          extensions: ["py"],
          command: "pylsp",
          args: [],
        },
        containerId: "ide-sandbox-abc; rm -rf /",
      }),
    ).toThrow(/invalid_container_id/);
  });
});
