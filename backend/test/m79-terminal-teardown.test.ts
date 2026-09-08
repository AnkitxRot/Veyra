import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { makeTestConfig, startTestApi, type TestApi } from "./helpers.js";
import { terminalSessions } from "../src/execution/terminalSessions.js";
import { sandboxManager } from "../src/execution/sandbox.js";

/**
 * M79 — terminal sessions die with their sandbox / on role loss.
 *
 * These exercise the real module singletons (terminalSessions, sandboxManager)
 * — no Docker: `stopProjectSandbox`'s `docker rm -f` fails and is swallowed,
 * but the terminal reap runs first regardless.
 */

function fakePty() {
  return {
    onData: () => {},
    onExit: () => {},
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
  };
}

afterEach(() => {
  terminalSessions.disposeAll();
});

describe("M79 — sandbox teardown reaps terminal sessions", () => {
  it("B7/B8/B28: stopProjectSandbox kills every terminal session for that project", async () => {
    const p1 = fakePty();
    const p2 = fakePty();
    const other = fakePty();
    terminalSessions.create({
      userId: 1,
      projectId: "proj-teardown",
      terminalId: "a",
      pty: p1,
      containerId: "c",
    });
    terminalSessions.create({
      userId: 2,
      projectId: "proj-teardown",
      terminalId: "b",
      pty: p2,
      containerId: "c",
    });
    terminalSessions.detach(2, "proj-teardown", "b");
    terminalSessions.create({
      userId: 1,
      projectId: "proj-other",
      terminalId: "c",
      pty: other,
      containerId: "c2",
    });

    await sandboxManager.stopProjectSandbox("proj-teardown");

    expect(p1.kill).toHaveBeenCalledTimes(1);
    expect(p2.kill).toHaveBeenCalledTimes(1);
    expect(other.kill).not.toHaveBeenCalled();
    expect(terminalSessions.has(1, "proj-teardown", "a")).toBe(false);
    expect(terminalSessions.has(2, "proj-teardown", "b")).toBe(false);
    expect(terminalSessions.has(1, "proj-other", "c")).toBe(true);
  });

  it("disposeAll leaves no terminal registry entries", () => {
    for (let i = 0; i < 5; i++) {
      terminalSessions.create({
        userId: i,
        projectId: "p" + i,
        terminalId: "t",
        pty: fakePty(),
        containerId: "c",
      });
    }
    expect(terminalSessions.size()).toBe(5);
    terminalSessions.disposeAll();
    expect(terminalSessions.size()).toBe(0);
  });
});

describe("M79 — role loss reaps terminal sessions", () => {
  let api: TestApi;
  let ownerTok: string;
  let collabTok: string;
  let collabId: number;
  let projectId: string;

  beforeEach(async () => {
    api = await startTestApi(makeTestConfig());
    const o = await api.request("POST", "/api/auth/register", {
      body: { username: "m79owner", password: "pw-m79-owner-1" },
    });
    ownerTok = o.data.token;
    const c = await api.request("POST", "/api/auth/register", {
      body: { username: "m79collab", password: "pw-m79-collab-1" },
    });
    collabTok = c.data.token;
    collabId = c.data.user.id;
    const p = await api.request("POST", "/api/projects", {
      token: ownerTok,
      body: { name: "m79-roleloss", language: "python" },
    });
    projectId = p.data.project?.id ?? p.data.id;
    await api.request(
      "POST",
      `/api/projects/${projectId}/collaborators`,
      { token: ownerTok, body: { username: "m79collab", role: "editor" } },
    );
  });
  afterEach(() => api.close());

  it("B9/B27: removing a collaborator reaps their PTY in that project", async () => {
    const pty = fakePty();
    terminalSessions.create({
      userId: collabId,
      projectId,
      terminalId: "collab-term",
      pty,
      containerId: "c",
    });
    expect(terminalSessions.has(collabId, projectId, "collab-term")).toBe(true);

    const del = await api.request(
      "DELETE",
      `/api/projects/${projectId}/collaborators/${collabId}`,
      { token: ownerTok },
    );
    expect(del.status).toBe(200);

    expect(pty.kill).toHaveBeenCalledTimes(1);
    expect(terminalSessions.has(collabId, projectId, "collab-term")).toBe(false);
    void collabTok;
  });

  it("demoting a collaborator to viewer reaps their PTY", async () => {
    const pty = fakePty();
    terminalSessions.create({
      userId: collabId,
      projectId,
      terminalId: "demoted",
      pty,
      containerId: "c",
    });

    const patch = await api.request(
      "PATCH",
      `/api/projects/${projectId}/collaborators/${collabId}`,
      { token: ownerTok, body: { role: "viewer" } },
    );
    expect(patch.status).toBe(200);
    expect(pty.kill).toHaveBeenCalledTimes(1);
    expect(terminalSessions.has(collabId, projectId, "demoted")).toBe(false);
  });

  it("keeping editor role does NOT reap the PTY", async () => {
    const pty = fakePty();
    terminalSessions.create({
      userId: collabId,
      projectId,
      terminalId: "kept",
      pty,
      containerId: "c",
    });
    await api.request(
      "PATCH",
      `/api/projects/${projectId}/collaborators/${collabId}`,
      { token: ownerTok, body: { role: "editor" } },
    );
    expect(pty.kill).not.toHaveBeenCalled();
    expect(terminalSessions.has(collabId, projectId, "kept")).toBe(true);
  });
});
