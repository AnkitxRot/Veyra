import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { makeTestConfig, makeWorkspace } from "./helpers.js";
import {
  debugSessions,
  resetDebugSessionsForTests,
} from "../src/debug/manager.js";
import {
  languageServers,
  resetLanguageServersForTests,
} from "../src/lsp/manager.js";
import type { LspClientSocket } from "../src/lsp/session.js";
import type { DebugClientSocket } from "../src/debug/session.js";
import { isDockerRunning, isRunnerImageAvailable } from "../src/tools.js";
import { sandboxManager } from "../src/execution/sandbox.js";

const dockerOk = isDockerRunning() && isRunnerImageAvailable();
if (process.env.CI === "true" && !dockerOk) {
  throw new Error(
    "M83 CI requires Docker and cloudeeeide-runner:latest for live debugger tests",
  );
}

class LspSock implements LspClientSocket {
  readyState = 1;
  messages: any[] = [];
  send(data: string): void {
    this.messages.push(JSON.parse(data));
  }
  close(): void {
    this.readyState = 3;
  }
}

class FakeSock implements DebugClientSocket {
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
  ofType(type: string): any[] {
    return this.messages.filter((m) => m.type === type);
  }
}

async function waitFor(
  pred: () => boolean,
  ms = 40_000,
  label = "condition",
  hint?: () => unknown,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  const extra = hint ? ` last=${JSON.stringify(hint())}` : "";
  throw new Error(`timed out waiting for ${label}${extra}`);
}

async function waitPaused(sock: FakeSock, ms = 40_000, label = "paused"): Promise<any> {
  await waitFor(
    () => sock.lastStatus()?.state === "paused" && sock.ofType("stopped").length > 0,
    ms,
    label,
    () => ({
      status: sock.lastStatus(),
      types: sock.messages.map((m) => m.type),
      output: sock
        .ofType("output")
        .map((m) => m.text)
        .join("")
        .slice(-400),
    }),
  );
  return sock.ofType("stopped").at(-1);
}

describe.skipIf(!dockerOk)("debug real adapters in the sandbox", () => {
  let projectId = "";

  beforeEach(() => {
    resetDebugSessionsForTests();
  });

  afterEach(async () => {
    resetDebugSessionsForTests();
    resetLanguageServersForTests();
    if (projectId) {
      await sandboxManager.stopProjectSandbox(projectId);
      projectId = "";
    }
  });

  afterAll(async () => {
    resetDebugSessionsForTests();
    resetLanguageServersForTests();
    await sandboxManager.cleanupAllSandboxes();
  });

  it(
    "Python debugpy: breakpoint, locals, continue, terminate",
    async () => {
      const cfg = makeTestConfig({ debugStartupTimeoutMs: 30_000 });
      const ws = makeWorkspace(cfg);
      writeFileSync(
        join(ws, "main.py"),
        "x = 1\ny = 2\nz = x + y\nprint(z)\n",
      );
      projectId = `dbg-py-${randomUUID()}`;
      const sock = new FakeSock();
      const session = await debugSessions.attach({
        projectId,
        userId: 1,
        cfg,
        socket: sock,
        workspaceDir: ws,
      });
      expect(session).not.toBeNull();
      session!.handleClientMessage(sock, {
        type: "launch",
        language: "python",
        entryFile: "main.py",
        breakpoints: { "main.py": [3] },
      });
      const stopped = await waitPaused(sock, 40_000, "python paused");
      expect(stopped.frames[0].path).toBe("main.py");
      const names = Object.values(stopped.variables)
        .flat()
        .map((v: any) => v.name);
      expect(names).toEqual(expect.arrayContaining(["x", "y"]));
      session!.handleClientMessage(sock, { type: "next" });
      await waitFor(
        () => sock.ofType("stopped").length >= 2,
        20_000,
        "python step over",
      );
      session!.handleClientMessage(sock, { type: "continue" });
      await waitFor(
        () =>
          sock.lastStatus()?.state === "terminated" ||
          sock.ofType("exited").length > 0,
        20_000,
        "python exited",
      );
    },
    90_000,
  );

  it(
    "Python debugpy does not inherit backend secrets",
    async () => {
      const cfg = makeTestConfig({ debugStartupTimeoutMs: 30_000 });
      const ws = makeWorkspace(cfg);
      writeFileSync(
        join(ws, "main.py"),
        "import os\nkeys=sorted(os.environ)\nprint('ENV', ','.join(keys))\n",
      );
      projectId = `dbg-env-${randomUUID()}`;
      const sock = new FakeSock();
      const session = await debugSessions.attach({
        projectId,
        userId: 1,
        cfg,
        socket: sock,
        workspaceDir: ws,
      });
      session!.handleClientMessage(sock, {
        type: "launch",
        language: "python",
        entryFile: "main.py",
      });
      await waitFor(
        () =>
          sock.lastStatus()?.state === "terminated" ||
          sock.ofType("output").some((m) => String(m.text).includes("ENV")),
        40_000,
        "python env print",
      );
      const out = sock
        .ofType("output")
        .map((m) => m.text)
        .join("");
      expect(out).not.toMatch(/SECRETS_MASTER_KEY/);
      expect(out).not.toMatch(/ADMIN_PASSWORD/);
      expect(out).not.toMatch(/GIT_HTTPS/);
    },
    90_000,
  );

  it(
    "Node js-debug: breakpoint, variables, continue",
    async () => {
      const cfg = makeTestConfig({
        debugStartupTimeoutMs: 45_000,
        debugRequestTimeoutMs: 45_000,
      });
      const ws = makeWorkspace(cfg);
      writeFileSync(
        join(ws, "main.js"),
        "const x = 1;\nconst y = 2;\nconst z = x + y;\nconsole.log(z);\n",
      );
      projectId = `dbg-js-${randomUUID()}`;
      const sock = new FakeSock();
      const session = await debugSessions.attach({
        projectId,
        userId: 1,
        cfg,
        socket: sock,
        workspaceDir: ws,
      });
      session!.handleClientMessage(sock, {
        type: "launch",
        language: "node",
        entryFile: "main.js",
        breakpoints: { "main.js": [3] },
      });
      const stopped = await waitPaused(sock, 60_000, "node paused");
      expect(stopped.frames[0].path).toBe("main.js");
      const names = Object.values(stopped.variables ?? {})
        .flat()
        .map((v: any) => v.name);
      expect(names.length).toBeGreaterThan(0);
      session!.handleClientMessage(sock, { type: "continue" });
      await waitFor(
        () =>
          sock.lastStatus()?.state === "terminated" ||
          sock.ofType("exited").length > 0,
        20_000,
        "node exited",
      );
    },
    120_000,
  );

  it(
    "TypeScript: .ts breakpoint, mapped stack, variables, continue",
    async () => {
      const cfg = makeTestConfig({
        debugStartupTimeoutMs: 45_000,
        debugRequestTimeoutMs: 45_000,
      });
      const ws = makeWorkspace(cfg);
      mkdirSync(join(ws, "src"), { recursive: true });
      writeFileSync(
        join(ws, "src", "helper.ts"),
        [
          "export function add(a: number, b: number): number {",
          "  const sum = a + b;",
          "  return sum;",
          "}",
          "",
          "export function nested(n: number): number {",
          "  return add(n, 1);",
          "}",
          "",
        ].join("\n"),
      );
      writeFileSync(
        join(ws, "src", "main.ts"),
        [
          'import { add, nested } from "./helper";',
          "",
          "const x: number = 1;",
          "const y: number = 2;",
          "const z: number = add(x, y);",
          "const w: number = nested(z);",
          "console.log(z, w);",
          "",
        ].join("\n"),
      );
      projectId = `dbg-ts-${randomUUID()}`;
      const sock = new FakeSock();
      const session = await debugSessions.attach({
        projectId,
        userId: 1,
        cfg,
        socket: sock,
        workspaceDir: ws,
      });
      session!.handleClientMessage(sock, {
        type: "launch",
        language: "node",
        entryFile: "src/main.ts",
        breakpoints: { "src/main.ts": [5] },
      });
      const stopped = await waitPaused(sock, 60_000, "ts paused");
      expect(stopped.frames[0].path).toBe("src/main.ts");
      expect(stopped.frames[0].line).toBe(5);
      const locals = Object.values(stopped.variables ?? {})
        .flat()
        .map((v: any) => v.name);
      expect(locals).toEqual(expect.arrayContaining(["x", "y"]));
      session!.handleClientMessage(sock, { type: "stepIn" });
      await waitFor(
        () =>
          sock.ofType("stopped").length >= 2 &&
          sock
            .ofType("stopped")
            .at(-1)
            ?.frames?.some((f: { path?: string }) => f.path === "src/helper.ts"),
        20_000,
        "ts step into helper",
        () => ({
          frames: sock.ofType("stopped").at(-1)?.frames?.map((f: any) => f.path),
        }),
      );
      const stepped = sock.ofType("stopped").at(-1);
      expect(
        stepped.frames.some((f: { path?: string }) => f.path === "src/helper.ts"),
      ).toBe(true);
      const stepNames = Object.values(stepped.variables ?? {})
        .flat()
        .map((v: any) => v.name);
      expect(stepNames.length).toBeGreaterThan(0);
      session!.handleClientMessage(sock, { type: "continue" });
      await waitFor(
        () =>
          sock.lastStatus()?.state === "terminated" ||
          sock.ofType("exited").length > 0,
        20_000,
        "ts exited",
      );
    },
    120_000,
  );

  it(
    "TypeScript source maps stay inside /workspace across nested files",
    async () => {
      const cfg = makeTestConfig({
        debugStartupTimeoutMs: 45_000,
        debugRequestTimeoutMs: 45_000,
      });
      const ws = makeWorkspace(cfg);
      mkdirSync(join(ws, "src", "nested"), { recursive: true });
      writeFileSync(
        join(ws, "src", "nested", "deep.ts"),
        [
          "export type Id = number;",
          "export interface Box { value: Id }",
          "export function boxed(v: Id): Box {",
          "  const inner = v * 2;",
          "  return { value: inner };",
          "}",
          "",
        ].join("\n"),
      );
      writeFileSync(
        join(ws, "src", "nested", "app.ts"),
        [
          'import { boxed, type Box } from "./deep";',
          "const seed: Box = boxed(3);",
          "console.log(seed.value);",
          "",
        ].join("\n"),
      );
      projectId = `dbg-ts-map-${randomUUID()}`;
      const sock = new FakeSock();
      const session = await debugSessions.attach({
        projectId,
        userId: 1,
        cfg,
        socket: sock,
        workspaceDir: ws,
      });
      session!.handleClientMessage(sock, {
        type: "launch",
        language: "node",
        entryFile: "src/nested/app.ts",
        breakpoints: { "src/nested/app.ts": [2] },
      });
      const stopped = await waitPaused(sock, 60_000, "ts nested paused");
      expect(stopped.frames[0].path).toBe("src/nested/app.ts");
      expect(stopped.frames[0].line).toBe(2);
      for (const frame of stopped.frames) {
        expect(frame.path).toMatch(/^src\//);
        expect(frame.path).not.toMatch(/node_internals/);
        expect(frame.path).not.toMatch(/cloudide-build/);
        expect(frame.path).not.toMatch(/\.\./);
        expect(frame.path).not.toMatch(/^\/tmp\//);
        expect(frame.path).not.toMatch(/^\/etc\//);
      }
      session!.handleClientMessage(sock, { type: "terminate" });
      await waitFor(
        () => sock.lastStatus()?.state === "terminated",
        20_000,
        "ts nested terminate",
      );
    },
    120_000,
  );

  it(
    "TypeScript still pauses when tsserver was already running",
    async () => {
      const cfg = makeTestConfig({
        debugStartupTimeoutMs: 45_000,
        debugRequestTimeoutMs: 45_000,
      });
      const ws = makeWorkspace(cfg);
      mkdirSync(join(ws, "src"), { recursive: true });
      writeFileSync(
        join(ws, "src", "helper.ts"),
        "export function add(a: number, b: number): number {\n  return a + b;\n}\n",
      );
      writeFileSync(
        join(ws, "src", "main.ts"),
        'import { add } from "./helper";\nconst x: number = 1;\nconst y: number = 2;\nconst z: number = add(x, y);\nconsole.log(z);\n',
      );
      projectId = `dbg-ts-lsp-${randomUUID()}`;
      const lspSock = new LspSock();
      const lsp = await languageServers.attach({
        projectId,
        language: "typescript",
        userId: 1,
        cfg,
        socket: lspSock,
        workspaceDir: ws,
      });
      expect(lsp).not.toBeNull();
      await waitFor(
        () =>
          [...lspSock.messages]
            .reverse()
            .find((m) => m.type === "status")?.state === "ready",
        40_000,
        "tsserver ready",
      );
      const sock = new FakeSock();
      const session = await debugSessions.attach({
        projectId,
        userId: 1,
        cfg,
        socket: sock,
        workspaceDir: ws,
      });
      session!.handleClientMessage(sock, {
        type: "launch",
        language: "node",
        entryFile: "src/main.ts",
        breakpoints: { "src/main.ts": [4] },
      });
      const stopped = await waitPaused(sock, 60_000, "ts+lsp paused");
      expect(stopped.frames[0].path).toBe("src/main.ts");
      expect(stopped.frames[0].line).toBe(4);
    },
    120_000,
  );

  it("cannot debug another project's workspace via path escape", async () => {
    const cfg = makeTestConfig();
    const wsA = makeWorkspace(cfg);
    const wsB = makeWorkspace(cfg);
    mkdirSync(wsB, { recursive: true });
    writeFileSync(join(wsA, "main.py"), "print(1)\n");
    writeFileSync(join(wsB, "secret.py"), "print('other')\n");
    projectId = `dbg-iso-${randomUUID()}`;
    const sock = new FakeSock();
    const session = await debugSessions.attach({
      projectId,
      userId: 1,
      cfg,
      socket: sock,
      workspaceDir: wsA,
    });
    session!.handleClientMessage(sock, {
      type: "launch",
      language: "python",
      entryFile: "../" + "secret.py",
    });
    await waitFor(() => sock.messages.some((m) => m.type === "error"));
    expect(sock.messages.some((m) => m.type === "status" && m.state === "paused")).toBe(
      false,
    );
  });

  it(
    "Python debugpy: pause a running loop then terminate",
    async () => {
      const cfg = makeTestConfig({ debugStartupTimeoutMs: 30_000 });
      const ws = makeWorkspace(cfg);
      writeFileSync(
        join(ws, "main.py"),
        "import time\nx = 1\ny = 2\nwhile True:\n    time.sleep(0.2)\n",
      );
      projectId = `dbg-pause-${randomUUID()}`;
      const sock = new FakeSock();
      const session = await debugSessions.attach({
        projectId,
        userId: 1,
        cfg,
        socket: sock,
        workspaceDir: ws,
      });
      session!.handleClientMessage(sock, {
        type: "launch",
        language: "python",
        entryFile: "main.py",
      });
      await waitFor(
        () => sock.lastStatus()?.state === "running",
        40_000,
        "python running",
      );
      session!.handleClientMessage(sock, { type: "pause" });
      await waitPaused(sock, 20_000, "python pause");
      session!.handleClientMessage(sock, { type: "terminate" });
      await waitFor(
        () => sock.lastStatus()?.state === "terminated",
        20_000,
        "python terminate",
      );
    },
    90_000,
  );
});
