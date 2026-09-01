import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { makeTestConfig, startTestApi, type TestApi } from "./helpers.js";
import { collaborationHistorian } from "../src/collab/historian.js";

let api: TestApi;

async function reg(name: string): Promise<string> {
  const r = await api.request("POST", "/api/auth/register", {
    body: { username: name, password: "testpass123" },
  });
  return r.data.token as string;
}
async function proj(token: string, name: string): Promise<string> {
  const r = await api.request("POST", "/api/projects", {
    token,
    body: { name },
  });
  return r.data.project.id as string;
}

describe("M60 timeline API", () => {
  beforeAll(async () => {
    api = await startTestApi(
      makeTestConfig({ collabAwayMaxLookbackMs: 30 * 24 * 60 * 60 * 1000 }),
    );
  });
  afterAll(async () => {
    // createApp() re-inits the singleton historian; stop its timers so they
    // cannot fire against this now-closed db in a later test file.
    collaborationHistorian.stop();
    await api.close();
  });

  it("timeline requires access; a non-member is denied; the owner is allowed", async () => {
    const owner = await reg("m60owner1");
    const stranger = await reg("m60stranger1");
    const p = await proj(owner, "P1");

    const denied = await api.request(
      "GET",
      `/api/projects/${p}/collab/timeline`,
      { token: stranger },
    );
    expect([403, 404]).toContain(denied.status);

    const ok = await api.request("GET", `/api/projects/${p}/collab/timeline`, {
      token: owner,
    });
    expect(ok.status).toBe(200);
    expect(Array.isArray(ok.data.events)).toBe(true);
    expect(ok.data.nextBefore === null || typeof ok.data.nextBefore === "string").toBe(
      true,
    );
  });

  it("a viewer collaborator can read; a revoked collaborator cannot", async () => {
    const owner = await reg("m60owner2");
    await reg("m60collab2");
    const p = await proj(owner, "P2");
    await api.request("POST", `/api/projects/${p}/collaborators`, {
      token: owner,
      body: { username: "m60collab2", role: "viewer" },
    });
    const collabLogin = await api.request("POST", "/api/auth/login", {
      body: { username: "m60collab2", password: "testpass123" },
    });
    const collabToken = collabLogin.data.token as string;

    let r = await api.request("GET", `/api/projects/${p}/collab/timeline`, {
      token: collabToken,
    });
    expect(r.status).toBe(200);

    // revoke
    const collabUser = (
      await api.request("GET", `/api/projects/${p}/collaborators`, {
        token: owner,
      })
    ).data;
    const cid = collabUser.collaborators?.[0]?.userId;
    await api.request("DELETE", `/api/projects/${p}/collaborators/${cid}`, {
      token: owner,
    });

    r = await api.request("GET", `/api/projects/${p}/collab/timeline`, {
      token: collabToken,
    });
    expect([403, 404]).toContain(r.status);
  });

  it("cross-project isolation: project A's timeline never shows project B's rows", async () => {
    const u = await reg("m60owner3");
    const a = await proj(u, "A");
    const b = await proj(u, "B");
    api.db
      .prepare(
        `INSERT INTO collaboration_changes
         (id,project_id,author_user_id,file_path,kind,started_at,ended_at)
         VALUES ('bx', ?, ?, 'x.ts', 'edit_burst', ?, ?)`,
      )
      .run(
        b,
        (api.db.prepare("SELECT id FROM users WHERE username='m60owner3'").get() as {
          id: number;
        }).id,
        "2026-08-31T10:00:00.000Z",
        "2026-08-31T10:00:00.000Z",
      );
    const r = await api.request("GET", `/api/projects/${a}/collab/timeline`, {
      token: u,
    });
    expect(r.data.events.every((e: { id: string }) => e.id !== "collab:bx")).toBe(
      true,
    );
  });

  it("while-away + ack: a second call returns [] after ack", async () => {
    const owner = await reg("m60owner4");
    await reg("m60other4");
    const p = await proj(owner, "P4");
    const otherId = (
      api.db.prepare("SELECT id FROM users WHERE username='m60other4'").get() as {
        id: number;
      }
    ).id;
    api.db
      .prepare(
        `INSERT INTO collaboration_changes
         (id,project_id,author_user_id,file_path,kind,started_at,ended_at)
         VALUES ('wa1', ?, ?, 'y.ts', 'edit_burst', ?, ?)`,
      )
      .run(p, otherId, "2026-08-31T10:00:00.000Z", "2026-08-31T10:00:00.000Z");

    // owner's collab_last_seen must exist and be older than the event, else
    // the 24h clamp already filters it — set it explicitly
    api.db
      .prepare(
        `INSERT INTO collab_last_seen (project_id, user_id, last_seen_at) VALUES (?, ?, ?)`,
      )
      .run(
        p,
        (api.db.prepare("SELECT id FROM users WHERE username='m60owner4'").get() as {
          id: number;
        }).id,
        "2026-08-31T09:00:00.000Z",
      );

    const first = await api.request(
      "GET",
      `/api/projects/${p}/collab/while-away`,
      { token: owner },
    );
    expect(first.status).toBe(200);
    expect(first.data.events.length).toBeGreaterThan(0);

    await api.request("POST", `/api/projects/${p}/collab/while-away/ack`, {
      token: owner,
      body: { upTo: first.data.events[0].at },
    });

    const second = await api.request(
      "GET",
      `/api/projects/${p}/collab/while-away`,
      { token: owner },
    );
    expect(second.data.events.length).toBe(0);
  });
});
