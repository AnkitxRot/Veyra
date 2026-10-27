import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { debugSessions, resetDebugSessionsForTests } from "../src/debug/manager.js";
import {
  registerConnection,
  unregisterConnection,
  closeProjectConnectionsForUser,
} from "../src/ws/connectionRegistry.js";
import { makeTestConfig, makeWorkspace } from "./helpers.js";
import type { DebugClientSocket } from "../src/debug/session.js";
import type { WebSocket } from "ws";

class FakeDebugSock implements DebugClientSocket {
  readyState = 1;
  closed = false;
  send(): void {}
  close(): void {
    this.closed = true;
    this.readyState = 3;
  }
}

function fakeWs() {
  const ws = {
    closed: false,
    terminated: false,
    close() {
      this.closed = true;
    },
    terminate() {
      this.terminated = true;
    },
  };
  return ws as typeof ws & WebSocket;
}

describe("M116 access revocation", () => {
  beforeEach(() => {
    resetDebugSessionsForTests();
    debugSessions.setContainerForTests(() => "ide-sandbox-m116");
  });
  afterEach(() => resetDebugSessionsForTests());

  it("disposeUserProject ends only that user's session for that project", async () => {
    const cfg = makeTestConfig();
    const dir = makeWorkspace(cfg);
    const a = new FakeDebugSock();
    const b = new FakeDebugSock();
    const c = new FakeDebugSock();
    await debugSessions.attach({ projectId: "p1", userId: 1, cfg, socket: a, workspaceDir: dir });
    await debugSessions.attach({ projectId: "p1", userId: 2, cfg, socket: b, workspaceDir: dir });
    await debugSessions.attach({ projectId: "p2", userId: 1, cfg, socket: c, workspaceDir: dir });

    debugSessions.disposeUserProject(1, "p1");

    expect(a.closed).toBe(true);
    expect(b.closed).toBe(false);
    expect(c.closed).toBe(false);
    expect(debugSessions.sessionFor("p1", 1)).toBeUndefined();
    expect(debugSessions.sessionFor("p1", 2)).toBeDefined();
    expect(debugSessions.sessionFor("p2", 1)).toBeDefined();
  });

  it("closeProjectConnectionsForUser closes only that user's sockets for that project", () => {
    const target = fakeWs();
    const otherProject = fakeWs();
    const otherUser = fakeWs();
    const untagged = fakeWs();
    registerConnection(10, target, "p1");
    registerConnection(10, otherProject, "p2");
    registerConnection(11, otherUser, "p1");
    registerConnection(10, untagged);

    closeProjectConnectionsForUser(10, "p1");

    expect(target.closed).toBe(true);
    expect(otherProject.closed).toBe(false);
    expect(otherUser.closed).toBe(false);
    expect(untagged.closed).toBe(false);

    for (const [u, ws] of [
      [10, target],
      [10, otherProject],
      [11, otherUser],
      [10, untagged],
    ] as const) {
      unregisterConnection(u, ws);
    }
  });
});
