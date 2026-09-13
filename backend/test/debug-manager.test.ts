import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeTestConfig, makeWorkspace } from "./helpers.js";
import {
  debugSessions,
  resetDebugSessionsForTests,
} from "../src/debug/manager.js";
import type { DebugClientSocket } from "../src/debug/session.js";
import type { DebugSpawnRequest } from "../src/debug/process.js";

const fakeDap = fileURLToPath(new URL("./fixtures/fake-dap.mjs", import.meta.url));

function spawnFake(env: Record<string, string> = {}) {
  return (_req: DebugSpawnRequest) =>
    spawn(process.execPath, [fakeDap], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...env },
      windowsHide: true,
    });
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

async function waitPaused(sock: FakeSock, ms = 5000): Promise<any> {
  await waitFor(
    () => sock.lastStatus()?.state === "paused" && sock.ofType("stopped").length > 0,
    ms,
    "paused",
  );
  return sock.ofType("stopped").at(-1);
}

describe("debug session lifecycle (fake adapter)", () => {
  beforeEach(() => {
    resetDebugSessionsForTests();
    debugSessions.setSpawnForTests(spawnFake());
    debugSessions.setContainerForTests(() => "ide-sandbox-debug");
  });
  afterEach(() => {
    resetDebugSessionsForTests();
  });

  async function boot(file = "main.py", src = "x = 1\ny = 2\nz = x + y\nprint(z)\n") {
    const cfg = makeTestConfig();
    const ws = makeWorkspace(cfg);
    writeFileSync(join(ws, file), src);
    const sock = new FakeSock();
    const session = await debugSessions.attach({
      projectId: "dbg",
      userId: 1,
      cfg,
      socket: sock,
      workspaceDir: ws,
    });
    expect(session).not.toBeNull();
    return { cfg, ws, sock, session: session! };
  }

  it("launches, hits a breakpoint, exposes stack/locals, continues, and terminates", async () => {
    const { sock, session } = await boot();
    session.handleClientMessage(sock, {
      type: "launch",
      language: "python",
      entryFile: "main.py",
      breakpoints: { "main.py": [3] },
    });
    const stopped = await waitPaused(sock);
    expect(stopped.frames[0].path).toBe("main.py");
    expect(stopped.frames[0].line).toBe(3);
    const locals = Object.values(stopped.variables).flat() as { name: string }[];
    expect(locals.map((v) => v.name)).toEqual(expect.arrayContaining(["x", "y"]));

    session.handleClientMessage(sock, { type: "next" });
    await waitFor(
      () => sock.ofType("stopped").length >= 2,
      3000,
      "step",
    );

    session.handleClientMessage(sock, { type: "continue" });
    await waitFor(
      () => sock.lastStatus()?.state === "terminated",
      3000,
      "terminated",
    );
  });

  it("reuses one session per user+project and isolates a second user", async () => {
    const cfg = makeTestConfig();
    const ws = makeWorkspace(cfg);
    writeFileSync(join(ws, "main.py"), "x = 1\n");
    const a = new FakeSock();
    const b = new FakeSock();
    const s1 = await debugSessions.attach({
      projectId: "p",
      userId: 1,
      cfg,
      socket: a,
      workspaceDir: ws,
    });
    const s1b = await debugSessions.attach({
      projectId: "p",
      userId: 1,
      cfg,
      socket: a,
      workspaceDir: ws,
    });
    expect(s1).toBe(s1b);
    const s2 = await debugSessions.attach({
      projectId: "p",
      userId: 2,
      cfg,
      socket: b,
      workspaceDir: ws,
    });
    expect(s2).not.toBe(s1);
    expect(debugSessions.sessionCount()).toBe(2);
  });

  it("does not let user B control user A's paused session", async () => {
    const cfg = makeTestConfig();
    const ws = makeWorkspace(cfg);
    writeFileSync(join(ws, "main.py"), "x = 1\ny = 2\nz = x + y\n");
    const a = new FakeSock();
    const b = new FakeSock();
    const sA = await debugSessions.attach({
      projectId: "p",
      userId: 1,
      cfg,
      socket: a,
      workspaceDir: ws,
    });
    const sB = await debugSessions.attach({
      projectId: "p",
      userId: 2,
      cfg,
      socket: b,
      workspaceDir: ws,
    });
    sA!.handleClientMessage(a, {
      type: "launch",
      language: "python",
      entryFile: "main.py",
      breakpoints: { "main.py": [3] },
    });
    await waitPaused(a);
    sB!.handleClientMessage(b, { type: "continue" });
    await new Promise((r) => setTimeout(r, 80));
    expect(a.lastStatus()?.state).toBe("paused");
    expect(sB!.handleClientMessage(a, { type: "continue" })).toBeUndefined();
    expect(a.lastStatus()?.state).toBe("paused");
  });

  it("rejects an entry file outside the workspace", async () => {
    const { sock, session } = await boot();
    session.handleClientMessage(sock, {
      type: "launch",
      language: "python",
      entryFile: "../secret.py",
    });
    await waitFor(() => sock.ofType("error").length > 0);
    expect(sock.lastStatus()?.state).not.toBe("starting");
  });

  it("rejects a missing entry file", async () => {
    const { sock, session } = await boot();
    session.handleClientMessage(sock, {
      type: "launch",
      language: "python",
      entryFile: "nope.py",
    });
    await waitFor(() => sock.ofType("error").length > 0);
    expect(sock.ofType("error")[0].message).toMatch(/not found/i);
  });

  it("ignores evaluate and adapter-selection fields", async () => {
    const { sock, session } = await boot();
    session.handleClientMessage(sock, {
      type: "launch",
      language: "python",
      entryFile: "main.py",
      executable: "/bin/sh",
      containerId: "ide-sandbox-other",
    });
    await waitFor(() => sock.ofType("error").length > 0);
    session.handleClientMessage(sock, {
      type: "evaluate",
      expression: "__import__('os').system('id')",
    });
    expect(sock.messages.some((m) => m.result === "should-never-run")).toBe(
      false,
    );
  });

  it("caps concurrent live sessions", async () => {
    const cfg = makeTestConfig({ maxDebugSessions: 1 });
    const ws = makeWorkspace(cfg);
    writeFileSync(join(ws, "main.py"), "x = 1\ny = 2\nz = x + y\n");
    const a = new FakeSock();
    const b = new FakeSock();
    const s1 = await debugSessions.attach({
      projectId: "p1",
      userId: 1,
      cfg,
      socket: a,
      workspaceDir: ws,
    });
    const s2 = await debugSessions.attach({
      projectId: "p2",
      userId: 2,
      cfg,
      socket: b,
      workspaceDir: ws,
    });
    s1!.handleClientMessage(a, {
      type: "launch",
      language: "python",
      entryFile: "main.py",
      breakpoints: { "main.py": [3] },
    });
    await waitPaused(a);
    s2!.handleClientMessage(b, {
      type: "launch",
      language: "python",
      entryFile: "main.py",
      breakpoints: { "main.py": [3] },
    });
    await waitFor(() =>
      b.messages.some(
        (m) =>
          m.type === "error" ||
          (m.type === "status" && m.state === "unavailable"),
      ),
    );
    expect(a.lastStatus()?.state).toBe("paused");
  });

  it("times out a hung adapter into unavailable without a restart storm", async () => {
    debugSessions.setSpawnForTests(spawnFake({ FAKE_DAP_SLOW: "1" }));
    const cfg = makeTestConfig({ debugStartupTimeoutMs: 200 });
    const ws = makeWorkspace(cfg);
    writeFileSync(join(ws, "main.py"), "x = 1\n");
    const sock = new FakeSock();
    const session = await debugSessions.attach({
      projectId: "slow",
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
      () => sock.lastStatus()?.state === "unavailable",
      3000,
      "unavailable",
    );
    expect(debugSessions.liveSessionCount()).toBe(0);
  });

  it("keeps launch in the startup budget when the adapter is slow to boot", async () => {
    debugSessions.setSpawnForTests(spawnFake({ FAKE_DAP_SLOW_LAUNCH: "1" }));
    const cfg = makeTestConfig({
      debugStartupTimeoutMs: 4000,
      debugRequestTimeoutMs: 200,
    });
    const ws = makeWorkspace(cfg);
    writeFileSync(join(ws, "main.py"), "x = 1\ny = 2\nz = x + y\nprint(z)\n");
    const sock = new FakeSock();
    const session = await debugSessions.attach({
      projectId: "slow-launch",
      userId: 1,
      cfg,
      socket: sock,
      workspaceDir: ws,
    });
    session!.handleClientMessage(sock, {
      type: "launch",
      language: "python",
      entryFile: "main.py",
      breakpoints: { "main.py": [3] },
    });
    await waitPaused(sock, 4000);
    expect(sock.lastStatus()?.state).toBe("paused");
  });

  it("reports adapter crash as failed", async () => {
    debugSessions.setSpawnForTests(spawnFake({ FAKE_DAP_CRASH: "1" }));
    const { sock, session } = await boot();
    session.handleClientMessage(sock, {
      type: "launch",
      language: "python",
      entryFile: "main.py",
      breakpoints: { "main.py": [3] },
    });
    await waitFor(
      () =>
        sock.lastStatus()?.state === "failed" ||
        sock.lastStatus()?.state === "unavailable",
      4000,
      "failed",
    );
  });

  it("truncates huge variable values", async () => {
    debugSessions.setSpawnForTests(spawnFake({ FAKE_DAP_HUGE_VAR: "1" }));
    const { sock, session } = await boot();
    session.handleClientMessage(sock, {
      type: "launch",
      language: "python",
      entryFile: "main.py",
      breakpoints: { "main.py": [3] },
    });
    await waitPaused(sock);
    const stopped = sock.ofType("stopped").at(-1);
    expect(stopped).toBeTruthy();
    const vars = Object.values(stopped.variables).flat() as { value: string }[];
    expect(vars[0].value.length).toBeLessThan(600);
  });

  it("disposes the session on project deletion", async () => {
    const { session } = await boot();
    expect(debugSessions.sessionCount()).toBe(1);
    debugSessions.disposeProject("dbg");
    expect(debugSessions.sessionCount()).toBe(0);
    expect(session.currentState).toBe("terminated");
  });

  it("disposes the session on user logout", async () => {
    const { session } = await boot();
    debugSessions.disposeUser(1);
    expect(debugSessions.sessionCount()).toBe(0);
    expect(session.currentState).toBe("terminated");
  });

  it("pauses a running program, then terminates", async () => {
    debugSessions.setSpawnForTests(spawnFake({ FAKE_DAP_HOLD: "1" }));
    const { sock, session } = await boot();
    session.handleClientMessage(sock, {
      type: "launch",
      language: "python",
      entryFile: "main.py",
    });
    await waitFor(() => sock.lastStatus()?.state === "running", 5000, "running");
    session.handleClientMessage(sock, { type: "pause" });
    await waitPaused(sock, 3000);
    session.handleClientMessage(sock, { type: "terminate" });
    await waitFor(
      () => sock.lastStatus()?.state === "terminated",
      3000,
      "terminated",
    );
    expect(debugSessions.liveSessionCount()).toBe(0);
  });

  it("stepIn / stepOut from a breakpoint", async () => {
    const { sock, session } = await boot();
    session.handleClientMessage(sock, {
      type: "launch",
      language: "python",
      entryFile: "main.py",
      breakpoints: { "main.py": [3] },
    });
    await waitPaused(sock);
    session.handleClientMessage(sock, { type: "stepIn" });
    await waitFor(() => sock.ofType("stopped").length >= 2, 3000, "stepIn");
    session.handleClientMessage(sock, { type: "stepOut" });
    await waitFor(() => sock.ofType("stopped").length >= 3, 3000, "stepOut");
    session.handleClientMessage(sock, { type: "terminate" });
    await waitFor(() => sock.lastStatus()?.state === "terminated");
  });

  it("disconnect while live disposes the session", async () => {
    const { sock, session } = await boot();
    session.handleClientMessage(sock, {
      type: "launch",
      language: "python",
      entryFile: "main.py",
      breakpoints: { "main.py": [3] },
    });
    await waitPaused(sock);
    session.clearSocket(sock);
    expect(session.currentState).toBe("terminated");
    expect(debugSessions.sessionCount()).toBe(0);
  });

  it("allows relaunch after terminate", async () => {
    const { sock, session } = await boot();
    session.handleClientMessage(sock, {
      type: "launch",
      language: "python",
      entryFile: "main.py",
      breakpoints: { "main.py": [3] },
    });
    await waitPaused(sock);
    session.handleClientMessage(sock, { type: "terminate" });
    await waitFor(() => sock.lastStatus()?.state === "terminated");
    session.handleClientMessage(sock, {
      type: "launch",
      language: "python",
      entryFile: "main.py",
      breakpoints: { "main.py": [3] },
    });
    await waitPaused(sock, 5000);
  });
});
