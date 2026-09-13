import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { makeTestConfig, makeWorkspace } from "./helpers.js";
import {
  languageServers,
  resetLanguageServersForTests,
} from "../src/lsp/manager.js";
import type { LspClientSocket } from "../src/lsp/session.js";
import { isDockerRunning, isRunnerImageAvailable } from "../src/tools.js";
import { sandboxManager } from "../src/execution/sandbox.js";

const dockerOk = isDockerRunning() && isRunnerImageAvailable();
if (process.env.CI === "true" && !dockerOk) {
  throw new Error(
    "M82 CI requires Docker and cloudeeeide-runner:latest for live language-server tests",
  );
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
  ms = 25_000,
  label = "condition",
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function diagsFor(sock: FakeSock, rel: string): any[] {
  const uri = `file:///workspace/${rel}`;
  const last = [...sock.messages]
    .reverse()
    .find(
      (m) =>
        m.method === "textDocument/publishDiagnostics" &&
        m.params?.uri === uri,
    );
  return last?.params?.diagnostics ?? [];
}

describe.skipIf(!dockerOk)("lsp real servers in the sandbox", () => {
  let projectId = "";

  beforeEach(() => {
    resetLanguageServersForTests();
  });

  afterEach(async () => {
    resetLanguageServersForTests();
    if (projectId) {
      await sandboxManager.stopProjectSandbox(projectId);
      projectId = "";
    }
  });

  afterAll(async () => {
    resetLanguageServersForTests();
    await sandboxManager.cleanupAllSandboxes();
  });

  it(
    "pylsp: initialize, diagnostics, completion, hover, definition, update",
    async () => {
      const cfg = makeTestConfig({ lspStartupTimeoutMs: 30_000 });
      const ws = makeWorkspace(cfg);
      writeFileSync(join(ws, "main.py"), "undefined_name\n");
      projectId = `lsp-py-${randomUUID()}`;
      const sock = new FakeSock();
      const session = await languageServers.attach({
        projectId,
        language: "python",
        userId: 1,
        cfg,
        socket: sock,
        workspaceDir: ws,
      });
      expect(session).not.toBeNull();
      await waitFor(
        () => sock.lastStatus()?.state === "ready",
        30_000,
        "pylsp ready",
      );

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
        () => diagsFor(sock, "main.py").length > 0,
        20_000,
        "python diagnostics",
      );
      expect(
        JSON.stringify(diagsFor(sock, "main.py")).toLowerCase(),
      ).toMatch(/undefined/);

      session!.handleClientMessage(sock, {
        jsonrpc: "2.0",
        id: 20,
        method: "textDocument/completion",
        params: {
          textDocument: { uri: "file:///workspace/main.py" },
          position: { line: 0, character: 0 },
        },
      });
      await waitFor(
        () => sock.messages.some((m) => m.id === 20),
        15_000,
        "python completion",
      );
      const completion = sock.messages.find((m) => m.id === 20);
      expect(completion.error).toBeFalsy();
      const items = completion.result?.items ?? completion.result ?? [];
      expect(Array.isArray(items)).toBe(true);

      session!.handleClientMessage(sock, {
        jsonrpc: "2.0",
        method: "textDocument/didChange",
        params: {
          textDocument: { uri: "file:///workspace/main.py" },
          contentChanges: [
            {
              text: "def greet(name: str) -> str:\n    return name\n",
            },
          ],
        },
      });
      await waitFor(() => {
        const d = diagsFor(sock, "main.py");
        return (
          d.length === 0 ||
          !JSON.stringify(d).toLowerCase().includes("undefined")
        );
      }, 20_000, "python diagnostics cleared");

      session!.handleClientMessage(sock, {
        jsonrpc: "2.0",
        id: 21,
        method: "textDocument/hover",
        params: {
          textDocument: { uri: "file:///workspace/main.py" },
          position: { line: 0, character: 4 },
        },
      });
      await waitFor(
        () => sock.messages.some((m) => m.id === 21),
        15_000,
        "python hover",
      );
      const hover = sock.messages.find((m) => m.id === 21);
      expect(hover.error).toBeFalsy();
      expect(hover.result).toBeTruthy();

      session!.handleClientMessage(sock, {
        jsonrpc: "2.0",
        id: 22,
        method: "textDocument/definition",
        params: {
          textDocument: { uri: "file:///workspace/main.py" },
          position: { line: 0, character: 4 },
        },
      });
      await waitFor(
        () => sock.messages.some((m) => m.id === 22),
        15_000,
        "python definition",
      );
      const def = sock.messages.find((m) => m.id === 22);
      expect(def.error).toBeFalsy();

      session!.handleClientMessage(sock, {
        jsonrpc: "2.0",
        id: 23,
        method: "textDocument/references",
        params: {
          textDocument: { uri: "file:///workspace/main.py" },
          position: { line: 0, character: 4 },
          context: { includeDeclaration: true },
        },
      });
      await waitFor(
        () => sock.messages.some((m) => m.id === 23),
        15_000,
        "python references",
      );
      expect(sock.messages.find((m) => m.id === 23).error).toBeFalsy();

      session!.handleClientMessage(sock, {
        jsonrpc: "2.0",
        id: 24,
        method: "textDocument/documentSymbol",
        params: { textDocument: { uri: "file:///workspace/main.py" } },
      });
      await waitFor(
        () => sock.messages.some((m) => m.id === 24),
        15_000,
        "python symbols",
      );
      const symbols = sock.messages.find((m) => m.id === 24);
      expect(symbols.error).toBeFalsy();
      expect(JSON.stringify(symbols.result ?? [])).toMatch(/greet/i);

      session!.handleClientMessage(sock, {
        jsonrpc: "2.0",
        method: "textDocument/didClose",
        params: { textDocument: { uri: "file:///workspace/main.py" } },
      });
      session!.handleClientMessage(sock, {
        jsonrpc: "2.0",
        method: "textDocument/didOpen",
        params: {
          textDocument: {
            uri: "file:///workspace/main.py",
            text: "def greet(name: str) -> str:\n    return name\n",
          },
        },
      });
      expect(session!.currentState).toBe("ready");
    },
    90_000,
  );

  it(
    "typescript-language-server: diagnostics, imports, completion, tsx",
    async () => {
      const cfg = makeTestConfig({ lspStartupTimeoutMs: 30_000 });
      const ws = makeWorkspace(cfg);
      mkdirSync(join(ws, "src"), { recursive: true });
      writeFileSync(
        join(ws, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            strict: true,
            jsx: "react-jsx",
            module: "ESNext",
            moduleResolution: "bundler",
            target: "ES2022",
            skipLibCheck: true,
            allowJs: true,
            checkJs: true,
          },
          include: ["src"],
        }),
      );
      writeFileSync(join(ws, "src/a.ts"), "export const foo = 1;\n");
      writeFileSync(
        join(ws, "src/b.ts"),
        'import { foo } from "./a";\nconst n: string = foo;\n',
      );
      writeFileSync(
        join(ws, "src/index.ts"),
        'export function greet(name: string): string {\n  return "hi " + name;\n}\nconst bad: number = "nope";\ngreet("Ada");\n',
      );
      writeFileSync(
        join(ws, "src/util.js"),
        "export function add(a, b) { return a + b; }\nconst n = add(1, 'x');\n",
      );
      writeFileSync(
        join(ws, "src/App.tsx"),
        "export function App(props: { title: string }) {\n  return <div>{props.title}</div>;\n}\nconst el = <App title={1} />;\n",
      );
      writeFileSync(
        join(ws, "src/missing.ts"),
        'import { z } from "zod";\nexport const t = z;\n',
      );
      projectId = `lsp-ts-${randomUUID()}`;
      const sock = new FakeSock();
      const session = await languageServers.attach({
        projectId,
        language: "typescript",
        userId: 1,
        cfg,
        socket: sock,
        workspaceDir: ws,
      });
      expect(session).not.toBeNull();
      await waitFor(
        () => sock.lastStatus()?.state === "ready",
        30_000,
        "tsserver ready",
      );

      session!.handleClientMessage(sock, {
        jsonrpc: "2.0",
        method: "textDocument/didOpen",
        params: {
          textDocument: {
            uri: "file:///workspace/src/index.ts",
            languageId: "typescript",
            text: 'export function greet(name: string): string {\n  return "hi " + name;\n}\nconst bad: number = "nope";\ngreet("Ada");\n',
          },
        },
      });
      await waitFor(
        () => diagsFor(sock, "src/index.ts").length > 0,
        25_000,
        "ts diagnostics",
      );

      session!.handleClientMessage(sock, {
        jsonrpc: "2.0",
        method: "textDocument/didOpen",
        params: {
          textDocument: {
            uri: "file:///workspace/src/a.ts",
            languageId: "typescript",
            text: "export const foo = 1;\n",
          },
        },
      });
      session!.handleClientMessage(sock, {
        jsonrpc: "2.0",
        method: "textDocument/didOpen",
        params: {
          textDocument: {
            uri: "file:///workspace/src/b.ts",
            languageId: "typescript",
            text: 'import { foo } from "./a";\nconst n: string = foo;\n',
          },
        },
      });
      await waitFor(
        () => diagsFor(sock, "src/b.ts").length > 0,
        25_000,
        "ts import type diagnostics",
      );

      session!.handleClientMessage(sock, {
        jsonrpc: "2.0",
        id: 30,
        method: "textDocument/completion",
        params: {
          textDocument: { uri: "file:///workspace/src/index.ts" },
          position: { line: 0, character: 16 },
        },
      });
      await waitFor(
        () => sock.messages.some((m) => m.id === 30),
        15_000,
        "ts completion",
      );
      const completion = sock.messages.find((m) => m.id === 30);
      expect(completion.error).toBeFalsy();

      session!.handleClientMessage(sock, {
        jsonrpc: "2.0",
        id: 31,
        method: "textDocument/hover",
        params: {
          textDocument: { uri: "file:///workspace/src/index.ts" },
          position: { line: 0, character: 16 },
        },
      });
      await waitFor(
        () => sock.messages.some((m) => m.id === 31),
        15_000,
        "ts hover",
      );
      expect(sock.messages.find((m) => m.id === 31).error).toBeFalsy();

      session!.handleClientMessage(sock, {
        jsonrpc: "2.0",
        id: 32,
        method: "textDocument/definition",
        params: {
          textDocument: { uri: "file:///workspace/src/b.ts" },
          position: { line: 0, character: 11 },
        },
      });
      await waitFor(
        () => sock.messages.some((m) => m.id === 32),
        15_000,
        "ts definition",
      );
      const def = sock.messages.find((m) => m.id === 32);
      expect(def.error).toBeFalsy();
      const defUri = JSON.stringify(def.result ?? {});
      expect(defUri).toMatch(/src\/a\.ts/);

      session!.handleClientMessage(sock, {
        jsonrpc: "2.0",
        id: 33,
        method: "textDocument/references",
        params: {
          textDocument: { uri: "file:///workspace/src/a.ts" },
          position: { line: 0, character: 13 },
          context: { includeDeclaration: true },
        },
      });
      await waitFor(
        () => sock.messages.some((m) => m.id === 33),
        15_000,
        "ts references",
      );
      expect(sock.messages.find((m) => m.id === 33).error).toBeFalsy();

      session!.handleClientMessage(sock, {
        jsonrpc: "2.0",
        id: 34,
        method: "textDocument/documentSymbol",
        params: { textDocument: { uri: "file:///workspace/src/index.ts" } },
      });
      await waitFor(
        () => sock.messages.some((m) => m.id === 34),
        15_000,
        "ts symbols",
      );
      expect(sock.messages.find((m) => m.id === 34).error).toBeFalsy();

      session!.handleClientMessage(sock, {
        jsonrpc: "2.0",
        id: 35,
        method: "textDocument/signatureHelp",
        params: {
          textDocument: { uri: "file:///workspace/src/index.ts" },
          position: { line: 3, character: 6 },
        },
      });
      await waitFor(
        () => sock.messages.some((m) => m.id === 35),
        15_000,
        "ts signature help",
      );
      expect(sock.messages.find((m) => m.id === 35).error).toBeFalsy();

      session!.handleClientMessage(sock, {
        jsonrpc: "2.0",
        id: 36,
        method: "workspace/symbol",
        params: { query: "greet" },
      });
      await waitFor(
        () => sock.messages.some((m) => m.id === 36),
        15_000,
        "ts workspace symbol",
      );
      expect(sock.messages.find((m) => m.id === 36).error).toBeFalsy();

      session!.handleClientMessage(sock, {
        jsonrpc: "2.0",
        method: "textDocument/didOpen",
        params: {
          textDocument: {
            uri: "file:///workspace/src/util.js",
            languageId: "javascript",
            text: "export function add(a, b) { return a + b; }\nconst n = add(1, 'x');\n",
          },
        },
      });
      session!.handleClientMessage(sock, {
        jsonrpc: "2.0",
        id: 37,
        method: "textDocument/completion",
        params: {
          textDocument: { uri: "file:///workspace/src/util.js" },
          position: { line: 0, character: 16 },
        },
      });
      await waitFor(
        () => sock.messages.some((m) => m.id === 37),
        15_000,
        "js completion",
      );
      expect(sock.messages.find((m) => m.id === 37).error).toBeFalsy();

      session!.handleClientMessage(sock, {
        jsonrpc: "2.0",
        method: "textDocument/didOpen",
        params: {
          textDocument: {
            uri: "file:///workspace/src/App.tsx",
            languageId: "typescriptreact",
            text: "export function App(props: { title: string }) {\n  return <div>{props.title}</div>;\n}\nconst el = <App title={1} />;\n",
          },
        },
      });
      await waitFor(
        () => diagsFor(sock, "src/App.tsx").length > 0,
        25_000,
        "tsx diagnostics",
      );

      session!.handleClientMessage(sock, {
        jsonrpc: "2.0",
        method: "textDocument/didOpen",
        params: {
          textDocument: {
            uri: "file:///workspace/src/missing.ts",
            languageId: "typescript",
            text: 'import { z } from "zod";\nexport const t = z;\n',
          },
        },
      });
      await waitFor(
        () => diagsFor(sock, "src/missing.ts").length > 0,
        25_000,
        "missing module diagnostics",
      );
      expect(
        JSON.stringify(diagsFor(sock, "src/missing.ts")).toLowerCase(),
      ).toMatch(/zod|module|find/);
      expect(session!.currentState).toBe("ready");
    },
    120_000,
  );

  it("missing language-server binary degrades to unavailable without a storm", async () => {
    const cfg = makeTestConfig({
      lspStartupTimeoutMs: 4_000,
      lspMaxRestarts: 3,
    });
    const ws = makeWorkspace(cfg);
    writeFileSync(join(ws, "main.py"), "x = 1\n");
    projectId = `lsp-miss-${randomUUID()}`;
    languageServers.setSpawnForTests(() => {
      throw new Error("ENOENT pylsp");
    });
    const sock = new FakeSock();
    const session = await languageServers.attach({
      projectId,
      language: "python",
      userId: 1,
      cfg,
      socket: sock,
      workspaceDir: ws,
    });
    expect(session?.currentState).toBe("unavailable");
    await new Promise((r) => setTimeout(r, 300));
    expect(session?.currentState).toBe("unavailable");
  });
});
