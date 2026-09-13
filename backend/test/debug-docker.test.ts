import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { makeTestConfig, makeWorkspace } from "./helpers.js";
import {
  debugSessions,
  resetDebugSessionsForTests,
} from "../src/debug/manager.js";
import type { DebugClientSocket } from "../src/debug/session.js";
import { isDockerRunning, isRunnerImageAvailable } from "../src/tools.js";
import { sandboxManager } from "../src/execution/sandbox.js";

const dockerOk = isDockerRunning() && isRunnerImageAvailable();
if (process.env.CI === "true" && !dockerOk) {
  throw new Error(
    "M83 CI requires Docker and cloudeeeide-runner:latest for live debugger tests",
  );
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
    if (projectId) {
      await sandboxManager.stopProjectSandbox(projectId);
      projectId = "";
    }
  });

  afterAll(async () => {
    resetDebugSessionsForTests();
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
      for (let i = 0; i < 8; i++) {
        if (
          sock.lastStatus()?.state === "terminated" ||
          sock.ofType("exited").length > 0
        ) {
          break;
        }
        if (sock.lastStatus()?.state === "paused") {
          session!.handleClientMessage(sock, { type: "continue" });
        }
        await waitFor(
          () =>
            sock.lastStatus()?.state === "terminated" ||
            sock.ofType("exited").length > 0 ||
            sock.ofType("stopped").length > i + 1 ||
            sock.lastStatus()?.state === "running",
          5_000,
          "node continue progress",
        );
      }
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
    "TypeScript via tsx: launches; source-mapped .ts breakpoints are PARTIAL",
    async () => {
      const cfg = makeTestConfig({
        debugStartupTimeoutMs: 45_000,
        debugRequestTimeoutMs: 45_000,
      });
      const ws = makeWorkspace(cfg);
      writeFileSync(
        join(ws, "main.ts"),
        "const x: number = 1;\nconst y: number = 2;\nconst z: number = x + y;\nconsole.log(z);\n",
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
        entryFile: "main.ts",
        breakpoints: { "main.ts": [3] },
      });
      await waitFor(
        () =>
          (sock.lastStatus()?.state === "paused" &&
            sock.ofType("stopped").length > 0) ||
          sock.lastStatus()?.state === "terminated" ||
          sock.ofType("exited").length > 0,
        45_000,
        "ts paused-or-exit",
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
      const stopped = sock.ofType("stopped").at(-1);
      if (stopped) {
        expect(stopped.frames[0].path).toBe("main.ts");
        session!.handleClientMessage(sock, { type: "continue" });
        await waitFor(
          () =>
            sock.lastStatus()?.state === "terminated" ||
            sock.ofType("exited").length > 0,
          20_000,
          "ts exited",
        );
      } else {
        expect(sock.lastStatus()?.state).toBe("terminated");
      }
    },
    90_000,
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
