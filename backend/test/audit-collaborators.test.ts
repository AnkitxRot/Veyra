import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeTestConfig, startTestApi, type TestApi } from "./helpers.js";

describe("M97 — collaborator membership changes are audited", () => {
  let api: TestApi;
  let ownerToken: string;
  let ownerId: number;
  let guestId: number;
  let projectId: string;

  beforeEach(async () => {
    api = await startTestApi(makeTestConfig());
    const owner = await api.request("POST", "/api/auth/register", {
      body: { username: "m97_owner", password: "password123" },
    });
    ownerToken = owner.data.token;
    ownerId = owner.data.user.id;
    const guest = await api.request("POST", "/api/auth/register", {
      body: { username: "m97_guest", password: "password123" },
    });
    guestId = guest.data.user.id;
    const proj = await api.request("POST", "/api/projects", {
      token: ownerToken,
      body: { name: "m97" },
    });
    projectId = proj.data.project.id;
  });

  afterEach(async () => {
    await api.close();
  });

  function events(type: string): any[] {
    return api.db
      .prepare("SELECT * FROM audit_logs WHERE project_id = ? AND event_type = ? ORDER BY id ASC")
      .all(projectId, type) as any[];
  }

  it("records COLLABORATOR_ADDED with actor, target and role", async () => {
    const res = await api.request("POST", `/api/projects/${projectId}/collaborators`, {
      token: ownerToken,
      body: { username: "m97_guest", role: "viewer" },
    });
    expect(res.status).toBe(201);
    const rows = events("COLLABORATOR_ADDED");
    expect(rows).toHaveLength(1);
    expect(rows[0].user_id).toBe(ownerId);
    expect(JSON.parse(rows[0].details)).toMatchObject({
      targetUserId: guestId,
      role: "viewer",
    });
  });

  it("records COLLABORATOR_ROLE_CHANGED with the new role", async () => {
    await api.request("POST", `/api/projects/${projectId}/collaborators`, {
      token: ownerToken,
      body: { username: "m97_guest", role: "editor" },
    });
    const res = await api.request("PATCH", `/api/projects/${projectId}/collaborators/${guestId}`, {
      token: ownerToken,
      body: { role: "viewer" },
    });
    expect(res.status).toBe(200);
    const rows = events("COLLABORATOR_ROLE_CHANGED");
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].details)).toMatchObject({
      targetUserId: guestId,
      role: "viewer",
    });
  });

  it("records COLLABORATOR_REMOVED", async () => {
    await api.request("POST", `/api/projects/${projectId}/collaborators`, {
      token: ownerToken,
      body: { username: "m97_guest" },
    });
    const res = await api.request("DELETE", `/api/projects/${projectId}/collaborators/${guestId}`, {
      token: ownerToken,
    });
    expect(res.status).toBe(200);
    const rows = events("COLLABORATOR_REMOVED");
    expect(rows).toHaveLength(1);
    expect(rows[0].user_id).toBe(ownerId);
    expect(JSON.parse(rows[0].details)).toMatchObject({ targetUserId: guestId });
  });

  it("records nothing when the request is rejected", async () => {
    const res = await api.request("POST", `/api/projects/${projectId}/collaborators`, {
      token: ownerToken,
      body: { username: "nobody_here" },
    });
    expect(res.status).toBe(404);
    expect(events("COLLABORATOR_ADDED")).toHaveLength(0);
  });
});
