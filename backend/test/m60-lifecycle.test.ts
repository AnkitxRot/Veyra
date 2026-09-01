import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { makeTestConfig, startTestApi, type TestApi } from "./helpers.js";
import { collaborationHistorian } from "../src/collab/historian.js";

let api: TestApi;

async function reg(name: string): Promise<{ token: string; id: number }> {
  const r = await api.request("POST", "/api/auth/register", {
    body: { username: name, password: "testpass123" },
  });
  return { token: r.data.token, id: r.data.user.id };
}

describe("M60 lifecycle", () => {
  beforeAll(async () => {
    api = await startTestApi(makeTestConfig());
  });
  afterAll(async () => {
    await api.close();
    collaborationHistorian.stop();
  });

  it("deleting a project cascade-deletes its collaboration history and last-seen rows", async () => {
    const owner = await reg("m60life1");
    const p = (
      await api.request("POST", "/api/projects", {
        token: owner.token,
        body: { name: "L1" },
      })
    ).data.project.id as string;

    api.db
      .prepare(
        `INSERT INTO collaboration_changes
         (id,project_id,author_user_id,file_path,kind,started_at,ended_at)
         VALUES ('lc1', ?, ?, 'a.ts', 'edit_burst', ?, ?)`,
      )
      .run(p, owner.id, "2026-08-31T10:00:00.000Z", "2026-08-31T10:00:00.000Z");
    api.db
      .prepare(
        `INSERT INTO collab_last_seen (project_id, user_id, last_seen_at) VALUES (?, ?, ?)`,
      )
      .run(p, owner.id, "2026-08-31T09:00:00.000Z");

    const del = await api.request("DELETE", `/api/projects/${p}`, {
      token: owner.token,
    });
    expect([200, 204]).toContain(del.status);

    expect(
      (
        api.db
          .prepare(
            "SELECT COUNT(*) c FROM collaboration_changes WHERE project_id = ?",
          )
          .get(p) as { c: number }
      ).c,
    ).toBe(0);
    expect(
      (
        api.db
          .prepare(
            "SELECT COUNT(*) c FROM collab_last_seen WHERE project_id = ?",
          )
          .get(p) as { c: number }
      ).c,
    ).toBe(0);
  });

  it("disposeProject drains buffered bursts synchronously (no loss)", () => {
    const uid = (
      api.db
        .prepare("SELECT id FROM users WHERE username='m60life1'")
        .get() as { id: number }
    ).id;
    // a live project for this owner
    api.db
      .prepare("INSERT INTO projects (id, owner_id, name) VALUES ('lp2', ?, 'LP2')")
      .run(uid);
    collaborationHistorian.recordEdit({
      projectId: "lp2",
      authorUserId: uid,
      username: "m60life1",
      filePath: "z.ts",
      at: Date.now(),
      range: { startLine: 1, endLine: 1, contiguous: true },
      linesAdded: 1,
      linesRemoved: 0,
    });
    expect(collaborationHistorian._openBurstCount()).toBeGreaterThan(0);
    collaborationHistorian.disposeProject("lp2");
    expect(
      (
        api.db
          .prepare(
            "SELECT COUNT(*) c FROM collaboration_changes WHERE project_id='lp2'",
          )
          .get() as { c: number }
      ).c,
    ).toBe(1);
  });
});
