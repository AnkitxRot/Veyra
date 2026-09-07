import { describe, it, expect, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { isDockerRunning } from "../src/tools.js";
import { makeTestConfig, makeWorkspace } from "./helpers.js";
import { openDb } from "../src/db.js";
import {
  SandboxManager,
  sandboxManager,
  sandboxRun,
} from "../src/execution/sandbox.js";
import { collaborationManager } from "../src/collab/manager.js";

const execFileAsync = promisify(execFile);

async function containerExists(name: string): Promise<boolean> {
  try {
    await execFileAsync("docker", ["inspect", name]);
    return true;
  } catch {
    return false;
  }
}

const IDLE = 30 * 60_000; // 30 min — the production default
const GRACE = 120_000; // 2 min — the SANDBOX_ROOM_EMPTY_GRACE_MS default

type Occ = { liveClients: number; distinctUsers: number };

describe.skipIf(!isDockerRunning())("M74 — collaboration-aware sandbox lifecycle", () => {
  const created: Array<{ mgr: SandboxManager; projectId: string }> = [];

  afterAll(async () => {
    for (const { mgr, projectId } of created) {
      await mgr.stopProjectSandbox(projectId).catch(() => {});
    }
    await sandboxManager.cleanupAllSandboxes().catch(() => {});
  });

  async function freshSandbox(occ?: Map<string, Occ>) {
    const cfg = makeTestConfig();
    const mgr = new SandboxManager();
    if (occ) {
      mgr.setRoomOccupancyProvider(
        (pid) => occ.get(pid) ?? { liveClients: 0, distinctUsers: 0 },
      );
    }
    const projectId = `m74occ-${randomUUID()}`;
    const workspace = makeWorkspace(cfg);
    await mgr.ensureProjectSandbox(projectId, cfg, workspace, 1);
    created.push({ mgr, projectId });
    const T0 = Date.now();
    return { cfg, mgr, projectId, workspace, T0, name: `ide-sandbox-${projectId}` };
  }

  it("keeps an occupied room's sandbox warm across a long idle-timeout pass", async () => {
    const occ = new Map<string, Occ>();
    const { mgr, projectId, T0, name } = await freshSandbox(occ);
    occ.set(projectId, { liveClients: 2, distinctUsers: 2 });

    // 1h later, idle timeout 1s — but the room has live clients.
    const reaped = await mgr.reapIdleSandboxes(1_000, GRACE, T0 + 3_600_000);
    expect(reaped).toEqual([]);
    expect(await containerExists(name)).toBe(true);
  });

  it("retains a just-emptied room's sandbox during the grace window", async () => {
    const occ = new Map<string, Occ>();
    const { mgr, projectId, T0, name } = await freshSandbox(occ);

    occ.set(projectId, { liveClients: 1, distinctUsers: 1 });
    await mgr.reapIdleSandboxes(IDLE, GRACE, T0); // observe it occupied

    occ.set(projectId, { liveClients: 0, distinctUsers: 0 });
    // first empty observation records roomEmptyAt = T0 + 10s
    expect(await mgr.reapIdleSandboxes(IDLE, GRACE, T0 + 10_000)).toEqual([]);
    // 50s empty (< 120s grace), 60s since lastUsed (<< 30min idle) -> retained
    expect(await mgr.reapIdleSandboxes(IDLE, GRACE, T0 + 60_000)).toEqual([]);
    expect(await containerExists(name)).toBe(true);
  });

  it("reaps an emptied room's sandbox once the grace expires, before the idle timeout", async () => {
    const occ = new Map<string, Occ>();
    const { mgr, projectId, T0, name } = await freshSandbox(occ);

    occ.set(projectId, { liveClients: 1, distinctUsers: 1 });
    await mgr.reapIdleSandboxes(IDLE, GRACE, T0);

    occ.set(projectId, { liveClients: 0, distinctUsers: 0 });
    await mgr.reapIdleSandboxes(IDLE, GRACE, T0 + 5_000); // roomEmptyAt = T0 + 5s

    // T0 + 5s + 120s + 1s: 121s empty (> grace), 126s since lastUsed (> grace),
    // still far under the 30min idle timeout.
    const reaped = await mgr.reapIdleSandboxes(
      IDLE,
      GRACE,
      T0 + 5_000 + GRACE + 1_000,
    );
    expect(reaped).toContain(projectId);
    expect(await containerExists(name)).toBe(false);
  });

  it("a rejoin during the grace window resets roomEmptyAt and keeps the sandbox warm", async () => {
    const occ = new Map<string, Occ>();
    const { mgr, projectId, T0, name } = await freshSandbox(occ);

    occ.set(projectId, { liveClients: 1, distinctUsers: 1 });
    await mgr.reapIdleSandboxes(IDLE, GRACE, T0); // observed occupied

    // Room empties; the reaper records roomEmptyAt at T0 + 5s.
    occ.set(projectId, { liveClients: 0, distinctUsers: 0 });
    expect(await mgr.reapIdleSandboxes(IDLE, GRACE, T0 + 5_000)).toEqual([]);

    // A collaborator rejoins mid-grace (T0 + 60s, well before T0+5s+120s).
    // liveClients > 0 -> kept warm AND roomEmptyAt is cleared back to null.
    occ.set(projectId, { liveClients: 1, distinctUsers: 1 });
    expect(await mgr.reapIdleSandboxes(IDLE, GRACE, T0 + 60_000)).toEqual([]);
    expect(await containerExists(name)).toBe(true);

    // The room empties a SECOND time far past the original T0+5s deadline. A
    // fresh full grace must apply from here (T1), not the stale T0+5s clock —
    // this is the assertion that fails if the rejoin did not clear roomEmptyAt.
    occ.set(projectId, { liveClients: 0, distinctUsers: 0 });
    const T1 = T0 + 5_000 + GRACE + 10_000;
    await mgr.reapIdleSandboxes(IDLE, GRACE, T1); // fresh roomEmptyAt = T1
    // 30s into the new grace: still warm (stale-clock revert would reap here).
    expect(await mgr.reapIdleSandboxes(IDLE, GRACE, T1 + 30_000)).toEqual([]);
    expect(await containerExists(name)).toBe(true);
    // Past the new grace deadline: now reaped.
    const reaped = await mgr.reapIdleSandboxes(IDLE, GRACE, T1 + GRACE + 1_000);
    expect(reaped).toContain(projectId);
    expect(await containerExists(name)).toBe(false);
  });

  it("with no occupancy provider, preserves the pre-M74 idle-timeout rule", async () => {
    const { mgr, projectId, T0, name } = await freshSandbox(); // no provider

    expect(await mgr.reapIdleSandboxes(IDLE, GRACE, T0 + 60_000)).toEqual([]);
    const reaped = await mgr.reapIdleSandboxes(IDLE, GRACE, T0 + IDLE + 1_000);
    expect(reaped).toContain(projectId);
    expect(await containerExists(name)).toBe(false);
  });

  it("with a provider that never reports occupancy, still uses only the idle rule", async () => {
    const occ = new Map<string, Occ>(); // always resolves to { 0, 0 }
    const { mgr, projectId, T0 } = await freshSandbox(occ);

    // never observed occupied -> roomEverOccupied stays false -> no grace path
    expect(await mgr.reapIdleSandboxes(IDLE, GRACE, T0 + 5_000)).toEqual([]);
    expect(await mgr.reapIdleSandboxes(IDLE, GRACE, T0 + GRACE + 5_000)).toEqual(
      [],
    );
    const reaped = await mgr.reapIdleSandboxes(IDLE, GRACE, T0 + IDLE + 1_000);
    expect(reaped).toContain(projectId);
  });

  it("a dead socket (readyState !== 1) does not keep the sandbox warm", async () => {
    const cfg = makeTestConfig();
    const db = openDb(":memory:");
    db.prepare(
      "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
    ).run("occ_owner", "h", "user");
    collaborationManager.init(cfg, db);

    const mgr = new SandboxManager();
    mgr.setRoomOccupancyProvider((pid) =>
      collaborationManager.roomOccupancy(pid),
    );
    const projectId = `m74occ-dead-${randomUUID()}`;
    const workspace = makeWorkspace(cfg);
    await mgr.ensureProjectSandbox(projectId, cfg, workspace, 1);
    created.push({ mgr, projectId });
    const T0 = Date.now();

    const room = collaborationManager.getOrCreateRoom(projectId);
    const sock = { readyState: 1, send: () => {}, close: () => {} } as any;
    await room.addClient(sock, { userId: 1, username: "u", role: "editor" });

    // While the socket is live the container is kept warm past a 1s idle rule.
    expect(await mgr.reapIdleSandboxes(1_000, Infinity, T0 + 3_600_000)).toEqual(
      [],
    );

    // Socket dies without a close event: roomOccupancy now reports 0 live
    // clients, so the container is no longer "warm" and the base idle rule
    // reaps it.
    sock.readyState = 3;
    const reaped = await mgr.reapIdleSandboxes(
      1_000,
      Infinity,
      T0 + 3_600_000,
    );
    expect(reaped).toContain(projectId);
    room.dispose();
  });

  it("touches the sandbox on run completion so lastUsed reflects run end", async () => {
    const cfg = makeTestConfig();
    const projectId = `m74occ-touch-${randomUUID()}`;
    const workspace = makeWorkspace(cfg);
    await fs.writeFile(
      join(workspace, "main.py"),
      "import time\ntime.sleep(2)\nprint('done')\n",
    );
    // sandboxRun operates on the singleton sandboxManager.
    await sandboxManager.ensureProjectSandbox(projectId, cfg, workspace, 1);

    const runStart = Date.now();
    const res = await sandboxRun(projectId, workspace, {
      config: cfg,
      userId: 1,
      command: "python3",
      args: ["main.py"],
      cwd: workspace,
      kind: "run",
      timeoutMs: 15_000,
    });
    expect(res.exitCode).toBe(0);

    const entry = (await sandboxManager.getAllActiveSandboxes()).find(
      (s) => s.projectId === projectId,
    );
    expect(entry).toBeDefined();
    // The run took ~2s. With the completion touch, lastUsed is near run end
    // (well after runStart). Without it, lastUsed is frozen at run start.
    expect(entry!.lastUsed - runStart).toBeGreaterThan(1_500);

    await sandboxManager.stopProjectSandbox(projectId);
  });
});
