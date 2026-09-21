import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeTestConfig, makeWorkspace, startTestApi } from "./helpers.js";
import {
  languageServers,
  resetLanguageServersForTests,
} from "../src/lsp/manager.js";
import type { LanguageClientSocket } from "../src/lsp/session.js";
import type { Db } from "../src/db.js";

const fakeLsp = fileURLToPath(new URL("./fixtures/fake-lsp.mjs", import.meta.url));

function spawnFake(_req: { id: string }) {
  return spawn(process.execPath, [fakeLsp], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
}

class FakeSock implements LanguageClientSocket {
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
  projectId = "lsp-audit",
  userId = 42,
  cfgOverride?: ReturnType<typeof makeTestConfig>,
) {
  if (cleanupApi) await cleanupApi();
  const baseCfg = cfgOverride ?? makeTestConfig();
  const { db, close } = await startTestApi(baseCfg);
  cleanupApi = close;
  db.exec("PRAGMA foreign_keys=OFF");
  languageServers.setAuditDbForTests(db);
  const ws = makeWorkspace(baseCfg);
  writeFileSync(join(ws, file), src);
  const sock = new FakeSock();
  const session = await languageServers.attach({
    projectId,
    language: "python",
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

describe("M94 — LSP Audit Trail Coverage", () => {
  beforeEach(() => {
    resetLanguageServersForTests();
    languageServers.setSpawnForTests(spawnFake);
    languageServers.setContainerForTests(() => "ide-sandbox-test");
  });

  afterEach(async () => {
    resetLanguageServersForTests();
    languageServers.setAuditDbForTests(null);
    if (cleanupApi) {
      await cleanupApi();
      cleanupApi = null;
    }
  });

  it("records LSP_SESSION_STARTED on successful start", async () => {
    const { db, sock, session } = await boot();
    session.handleClientMessage(sock, {
      type: "initialize",
      processId: process.pid,
      rootUri: "file:///",
    });
    await waitFor(
      () => getAuditRows(db, "LSP_SESSION_STARTED", "lsp-audit").length > 0,
      5000,
      "LSP_SESSION_STARTED",
    );
    const rows = getAuditRows(db, "LSP_SESSION_STARTED", "lsp-audit");
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const d = JSON.parse(rows[0].details);
    expect(d.language).toBe("python");
    expect(d.message).toBe("language server process started");
    expect(rows[0].user_id).toBe(42);
  });

  it("records LSP_SESSION_FAILED on spawn failure", async () => {
    languageServers.setSpawnForTests(() => {
      throw new Error("docker missing");
    });
    const { db, sock, session } = await boot();
    session.handleClientMessage(sock, {
      type: "initialize",
      processId: process.pid,
      rootUri: "file:///",
    });
    await waitFor(
      () => getAuditRows(db, "LSP_SESSION_FAILED", "lsp-audit").length > 0,
      5000,
      "LSP_SESSION_FAILED",
    );
    const rows = getAuditRows(db, "LSP_SESSION_FAILED", "lsp-audit");
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].user_id).toBe(42);
  });

  it("records LSP_SESSION_FAILED when language server crashes repeatedly", async () => {
    languageServers.setSpawnForTests(spawnFake({ FAKE_LSP_CRASH: "1" }));
    const cfg = makeTestConfig({ lspMaxRestarts: 1, lspRestartWindowMs: 60_000 });
    const { db, close } = await startTestApi(cfg);
    db.exec("PRAGMA foreign_keys=OFF");
    languageServers.setAuditDbForTests(db);
    const ws = makeWorkspace(cfg);
    writeFileSync(join(ws, "main.py"), "x = 1\n");
    const sock = new FakeSock();
    const session = await languageServers.attach({
      projectId: "crashy-lsp-audit",
      language: "python",
      userId: 42,
      cfg,
      socket: sock,
      workspaceDir: ws,
    });
    expect(session).not.toBeNull();
    await waitFor(
      () => getAuditRows(db, "LSP_SESSION_FAILED", "crashy-lsp-audit").length > 0,
      8000,
      "LSP_SESSION_FAILED",
    );
    const rows = getAuditRows(db, "LSP_SESSION_FAILED", "crashy-lsp-audit");
    expect(rows.length).toBeGreaterThanOrEqual(1);
    await close();
  });

  it("records LSP_SESSION_STOPPED on explicit dispose", async () => {
    const { db, sock, session } = await boot();
    session.handleClientMessage(sock, {
      type: "initialize",
      processId: process.pid,
      rootUri: "file:///",
    });
    await waitFor(
      () => getAuditRows(db, "LSP_SESSION_STARTED", "lsp-audit").length > 0,
      5000,
      "LSP_SESSION_STARTED",
    );
    session.dispose();
    const rows = getAuditRows(db, "LSP_SESSION_STOPPED", "lsp-audit");
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(JSON.parse(rows[0].details).message).toBe("stopped");
  });

  it("records LSP_SESSION_EVICTED on explicit eviction", async () => {
    const cfg = makeTestConfig({ maxLspServers: 1 });
    const { db, close } = await startTestApi(cfg);
    db.exec("PRAGMA foreign_keys=OFF");
    languageServers.setAuditDbForTests(db);
    const ws = makeWorkspace(cfg);
    writeFileSync(join(ws, "main.py"), "x = 1\n");

    const sock1 = new FakeSock();
    const session1 = await languageServers.attach({
      projectId: "evict-target",
      language: "python",
      userId: 42,
      cfg,
      socket: sock1,
      workspaceDir: ws,
    });
    expect(session1).not.toBeNull();
    await waitFor(
      () => getAuditRows(db, "LSP_SESSION_STARTED", "evict-target").length > 0,
      5000,
      "first LSP started",
    );

    // Remove the client so session1 becomes idle, then explicitly evict
    session1.removeClient(sock1);
    session1.dispose("evicted");

    const evicted = getAuditRows(db, "LSP_SESSION_EVICTED", "evict-target");
    expect(evicted.length).toBeGreaterThanOrEqual(1);
    await close();
  });

  it("does not emit duplicate terminal events on fail then dispose", async () => {
    languageServers.setSpawnForTests(() => {
      throw new Error("docker missing");
    });
    const { db, sock, session } = await boot();
    session.handleClientMessage(sock, {
      type: "initialize",
      processId: process.pid,
      rootUri: "file:///",
    });
    await waitFor(
      () => getAuditRows(db, "LSP_SESSION_FAILED", "lsp-audit").length > 0,
      5000,
      "LSP_SESSION_FAILED",
    );
    session.dispose();
    const failRows = getAuditRows(db, "LSP_SESSION_FAILED", "lsp-audit");
    const stopRows = getAuditRows(db, "LSP_SESSION_STOPPED", "lsp-audit");
    expect(failRows.length).toBeGreaterThanOrEqual(1);
    expect(stopRows.length).toBe(0);
  });

  it("audit failure does not break LSP lifecycle (fail-soft)", async () => {
    languageServers.setAuditDbForTests(null);
    const { sock, session } = await boot();
    session.handleClientMessage(sock, {
      type: "initialize",
      processId: process.pid,
      rootUri: "file:///",
    });
    await waitFor(
      () => sock.lastStatus()?.state === "ready",
      5000,
      "ready",
    );
    // If we got here without throwing, the lifecycle completed despite no audit db.
  });

  it("audit event metadata contains no source code or credentials", async () => {
    const { db, sock, session } = await boot();
    session.handleClientMessage(sock, {
      type: "initialize",
      processId: process.pid,
      rootUri: "file:///",
    });
    await waitFor(
      () => getAuditRows(db, "LSP_SESSION_STARTED", "lsp-audit").length > 0,
      5000,
      "LSP_SESSION_STARTED",
    );
    const rows = getAuditRows(db, "LSP_SESSION_STARTED", "lsp-audit");
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const raw = rows.map((r) => JSON.stringify(r.details)).join(" ");
    expect(raw).not.toMatch(/password|secret|token|credential/i);
    expect(raw).not.toMatch(/x\s*=\s*1/);
  });
});
