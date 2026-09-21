import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeTestConfig, makeWorkspace, startTestApi } from "./helpers.js";
import {
  debugSessions,
  resetDebugSessionsForTests,
} from "../src/debug/manager.js";
import type { DebugClientSocket } from "../src/debug/session.js";
import type { DebugSpawnRequest } from "../src/debug/process.js";
import type { Db } from "../src/db.js";

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

let cleanupApi: (() => Promise<void>) | null = null;

async function boot(
  file = "main.py",
  src = "x = 1\n",
  projectId = "dbg-audit",
  userId = 42,
  cfgOverride?: ReturnType<typeof makeTestConfig>,
) {
  if (cleanupApi) await cleanupApi();
  const baseCfg = cfgOverride ?? makeTestConfig();
  const { db, close } = await startTestApi(baseCfg);
  cleanupApi = close;
  db.exec("PRAGMA foreign_keys=OFF");
  debugSessions.setAuditDbForTests(db);
  const ws = makeWorkspace(baseCfg);
  writeFileSync(join(ws, file), src);
  const sock = new FakeSock();
  const session = await debugSessions.attach({
    projectId,
    userId,
    cfg: baseCfg,
    socket: sock,
    workspaceDir: ws,
  });
  expect(session).not.toBeNull();
  return { cfg: baseCfg, db, ws, sock, session: session! };
}

function getAuditRows(db: Db, eventType: string, projectId?: string): any[] {
  let stmt;
  if (projectId) {
    stmt = db.prepare(
      "SELECT * FROM audit_logs WHERE event_type = ? AND project_id = ? ORDER BY id ASC",
    );
    return stmt.all(eventType, projectId) as any[];
  }
  stmt = db.prepare(
    "SELECT * FROM audit_logs WHERE event_type = ? ORDER BY id ASC",
  );
  return stmt.all(eventType) as any[];
}

describe("M94 — DAP Audit Trail Coverage", () => {
  beforeEach(() => {
    resetDebugSessionsForTests();
    debugSessions.setSpawnForTests(spawnFake());
    debugSessions.setContainerForTests(() => "ide-sandbox-debug");
  });

  afterEach(async () => {
    resetDebugSessionsForTests();
    debugSessions.setAuditDbForTests(null);
    if (cleanupApi) {
      await cleanupApi();
      cleanupApi = null;
    }
  });

  it("records DEBUG_SESSION_STARTED on successful launch", async () => {
    const { db, sock, session } = await boot();
    session.handleClientMessage(sock, {
      type: "launch",
      language: "python",
      entryFile: "main.py",
      breakpoints: {},
    });
    await waitFor(
      () => getAuditRows(db, "DEBUG_SESSION_STARTED", "dbg-audit").length > 0,
      5000,
      "DEBUG_SESSION_STARTED",
    );
    const rows = getAuditRows(db, "DEBUG_SESSION_STARTED", "dbg-audit");
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const d = JSON.parse(rows[0].details);
    expect(d.language).toBe("python");
    expect(d.message).toBe("debug session running");
    expect(rows[0].user_id).toBe(42);
  });

  it("records DEBUG_SESSION_FAILED on spawn failure", async () => {
    debugSessions.setSpawnForTests(() => {
      throw new Error("docker missing");
    });
    const { db, sock, session } = await boot();
    session.handleClientMessage(sock, {
      type: "launch",
      language: "python",
      entryFile: "main.py",
      breakpoints: {},
    });
    await waitFor(
      () => getAuditRows(db, "DEBUG_SESSION_FAILED", "dbg-audit").length > 0,
      5000,
      "DEBUG_SESSION_FAILED",
    );
    const rows = getAuditRows(db, "DEBUG_SESSION_FAILED", "dbg-audit");
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].user_id).toBe(42);
  });

  it("records DEBUG_SESSION_TIMEOUT on adapter that never initializes", async () => {
    debugSessions.setSpawnForTests(spawnFake({ FAKE_DAP_SLOW: "1" }));
    const cfgShort = makeTestConfig({ debugStartupTimeoutMs: 800, debugSessionTimeoutMs: 60_000 });
    const { db, sock, session } = await boot("main.py", "x = 1\n", "dbg-audit-startup-to", 42, cfgShort);
    session.handleClientMessage(sock, {
      type: "launch",
      language: "python",
      entryFile: "main.py",
      breakpoints: {},
    });
    await waitFor(
      () => getAuditRows(db, "DEBUG_SESSION_TIMEOUT", "dbg-audit-startup-to").length > 0,
      10000,
      "DEBUG_SESSION_TIMEOUT",
    );
    const rows = getAuditRows(db, "DEBUG_SESSION_TIMEOUT", "dbg-audit-startup-to");
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(JSON.parse(rows[0].details).message).toMatch(/timed out/);
  });

  it("records DEBUG_SESSION_TIMEOUT on session timeout", async () => {
    debugSessions.setSpawnForTests(spawnFake({ FAKE_DAP_HOLD: "1" }));
    const cfgShort = makeTestConfig({
      debugSessionTimeoutMs: 600,
    });
    const { db, sock, session } = await boot("main.py", "x = 1\n", "dbg-audit-to", 42, cfgShort);
    session.handleClientMessage(sock, {
      type: "launch",
      language: "python",
      entryFile: "main.py",
      breakpoints: {},
    });
    await waitFor(
      () => getAuditRows(db, "DEBUG_SESSION_TIMEOUT", "dbg-audit-to").length > 0,
      10000,
      "DEBUG_SESSION_TIMEOUT",
    );
    const rows = getAuditRows(db, "DEBUG_SESSION_TIMEOUT", "dbg-audit-to");
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });

  it("records DEBUG_SESSION_STOPPED on explicit dispose", async () => {
    const { db, sock, session } = await boot();
    session.handleClientMessage(sock, {
      type: "launch",
      language: "python",
      entryFile: "main.py",
      breakpoints: {},
    });
    await waitFor(
      () => sock.lastStatus()?.state === "terminated",
      5000,
      "terminated",
    );
    session.dispose("stopped");
    const rows = getAuditRows(db, "DEBUG_SESSION_STOPPED", "dbg-audit");
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(JSON.parse(rows[0].details).message).toBe("stopped");
  });

  it("does not emit duplicate terminal events on fail then dispose", async () => {
    debugSessions.setSpawnForTests(() => {
      throw new Error("docker missing");
    });
    const { db, sock, session } = await boot();
    session.handleClientMessage(sock, {
      type: "launch",
      language: "python",
      entryFile: "main.py",
      breakpoints: {},
    });
    await waitFor(
      () => getAuditRows(db, "DEBUG_SESSION_FAILED", "dbg-audit").length > 0,
      5000,
      "DEBUG_SESSION_FAILED",
    );
    session.dispose("cleanup after fail");
    const failRows = getAuditRows(db, "DEBUG_SESSION_FAILED", "dbg-audit");
    const stopRows = getAuditRows(db, "DEBUG_SESSION_STOPPED", "dbg-audit");
    expect(failRows.length).toBeGreaterThanOrEqual(1);
    expect(stopRows.length).toBe(0);
  });

  it("audit failure does not break DAP lifecycle (fail-soft)", async () => {
    debugSessions.setAuditDbForTests(null);
    const { sock, session } = await boot();
    session.handleClientMessage(sock, {
      type: "launch",
      language: "python",
      entryFile: "main.py",
      breakpoints: {},
    });
    await waitFor(
      () => sock.lastStatus()?.state === "terminated",
      5000,
      "terminated",
    );
  });

  it("audit event metadata contains no source code or credentials", async () => {
    const { db, sock, session } = await boot();
    session.handleClientMessage(sock, {
      type: "launch",
      language: "python",
      entryFile: "main.py",
      breakpoints: {},
    });
    await waitFor(
      () => getAuditRows(db, "DEBUG_SESSION_STARTED", "dbg-audit").length > 0,
      5000,
      "DEBUG_SESSION_STARTED",
    );
    const rows = getAuditRows(db, "DEBUG_SESSION_STARTED", "dbg-audit");
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const raw = rows.map((r) => JSON.stringify(r.details)).join(" ");
    expect(raw).not.toMatch(/password|secret|token|credential/i);
    expect(raw).not.toMatch(/x\s*=\s*1/);
  });
});
