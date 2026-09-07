import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDb } from "../src/db.js";
import { resolveConfig } from "../src/config.js";
import { collaborationManager } from "../src/collab/manager.js";
import { createProject } from "../src/projects/service.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/** A minimal stand-in for a live client WebSocket. */
function makeMockWs() {
  return { readyState: 1, send: () => {}, close: () => {} } as any;
}

describe("M74 — CollaborationManager.roomOccupancy", () => {
  let db: any;
  let cfg: any;
  let tempWorkspacesDir: string;
  let tempDataDir: string;

  beforeEach(() => {
    tempWorkspacesDir = mkdtempSync(join(tmpdir(), "cloudide-m74-occ-ws-"));
    tempDataDir = mkdtempSync(join(tmpdir(), "cloudide-m74-occ-data-"));
    db = openDb(":memory:");
    cfg = {
      ...resolveConfig(),
      workspacesDir: tempWorkspacesDir,
      dataDir: tempDataDir,
    };
    collaborationManager.init(cfg, db);
  });

  afterEach(() => {
    try {
      rmSync(tempWorkspacesDir, { recursive: true, force: true });
    } catch {}
    try {
      rmSync(tempDataDir, { recursive: true, force: true });
    } catch {}
  });

  async function makeProject(name: string) {
    db.prepare(
      "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
    ).run(`${name}_owner`, "h", "user");
    return createProject(cfg, db, 1, { name });
  }

  it("unknown project (no room) → { liveClients: 0, distinctUsers: 0 }", async () => {
    const p = await makeProject("NoRoom");
    expect(collaborationManager.roomOccupancy(p.id)).toEqual({
      liveClients: 0,
      distinctUsers: 0,
    });
  });

  it("room exists but empty → { liveClients: 0, distinctUsers: 0 }", async () => {
    const p = await makeProject("EmptyRoom");
    collaborationManager.getOrCreateRoom(p.id);
    expect(collaborationManager.roomOccupancy(p.id)).toEqual({
      liveClients: 0,
      distinctUsers: 0,
    });
  });

  it("one socket → { liveClients: 1, distinctUsers: 1 }", async () => {
    const p = await makeProject("OneSocket");
    const room = collaborationManager.getOrCreateRoom(p.id);
    await room.addClient(makeMockWs(), {
      userId: 7,
      username: "solo",
      role: "editor",
    });
    expect(collaborationManager.roomOccupancy(p.id)).toEqual({
      liveClients: 1,
      distinctUsers: 1,
    });
  });

  it("two sockets, same user → { liveClients: 2, distinctUsers: 1 }", async () => {
    const p = await makeProject("SameUserTwoTabs");
    const room = collaborationManager.getOrCreateRoom(p.id);
    await room.addClient(makeMockWs(), {
      userId: 7,
      username: "multi",
      role: "editor",
    });
    await room.addClient(makeMockWs(), {
      userId: 7,
      username: "multi",
      role: "editor",
    });
    expect(collaborationManager.roomOccupancy(p.id)).toEqual({
      liveClients: 2,
      distinctUsers: 1,
    });
  });

  it("two sockets, different users → { liveClients: 2, distinctUsers: 2 }", async () => {
    const p = await makeProject("TwoUsers");
    const room = collaborationManager.getOrCreateRoom(p.id);
    await room.addClient(makeMockWs(), {
      userId: 7,
      username: "alice",
      role: "editor",
    });
    await room.addClient(makeMockWs(), {
      userId: 9,
      username: "bob",
      role: "editor",
    });
    expect(collaborationManager.roomOccupancy(p.id)).toEqual({
      liveClients: 2,
      distinctUsers: 2,
    });
  });

  it("reflects live changes, not a stale snapshot", async () => {
    const p = await makeProject("LiveChanges");
    const room = collaborationManager.getOrCreateRoom(p.id);
    const wsA = makeMockWs();
    const wsB = makeMockWs();
    await room.addClient(wsA, { userId: 7, username: "a", role: "editor" });
    await room.addClient(wsB, { userId: 9, username: "b", role: "editor" });
    expect(collaborationManager.roomOccupancy(p.id)).toEqual({
      liveClients: 2,
      distinctUsers: 2,
    });

    // A socket that died without a 'close' event still sits in this.clients
    // but must not be counted as an occupant.
    wsB.readyState = 3;
    expect(collaborationManager.roomOccupancy(p.id)).toEqual({
      liveClients: 1,
      distinctUsers: 1,
    });

    // A clean removal drops it to empty.
    room.removeClient(wsA);
    expect(collaborationManager.roomOccupancy(p.id)).toEqual({
      liveClients: 0,
      distinctUsers: 0,
    });
  });
});
