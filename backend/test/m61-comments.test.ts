import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { makeTestConfig, startTestApi, type TestApi } from "./helpers.js";
import { collaborationManager } from "../src/collab/manager.js";

const ANCHOR = {
  relStart: "QQ==",
  relEnd: "Qg==",
  slice: "const x = 1",
  startLine: 2,
  endLine: 2,
  prefixHash: "0".repeat(16),
};

async function register(api: TestApi, username: string): Promise<string> {
  const r = await api.request("POST", "/api/auth/register", {
    body: { username, password: "secret123" },
  });
  return r.data.token;
}

describe("M61-A comment REST", () => {
  let api: TestApi;
  let owner: string;
  let editor: string;
  let viewer: string;
  let stranger: string;
  let projectId: string;

  beforeAll(async () => {
    api = await startTestApi(makeTestConfig());
    owner = await register(api, "owner");
    editor = await register(api, "editor");
    viewer = await register(api, "viewer");
    stranger = await register(api, "stranger");
    const proj = await api.request("POST", "/api/projects", {
      token: owner,
      body: { name: "demo" },
    });
    projectId = proj.data.project.id;
    await api.request("POST", `/api/projects/${projectId}/collaborators`, {
      token: owner,
      body: { username: "editor", role: "editor" },
    });
    await api.request("POST", `/api/projects/${projectId}/collaborators`, {
      token: owner,
      body: { username: "viewer", role: "viewer" },
    });
  });

  afterAll(async () => {
    await api?.close();
  });

  const createThread = (token: string, body = "root comment", extra = {}) =>
    api.request("POST", `/api/projects/${projectId}/comments`, {
      token,
      body: { filePath: "src/a.ts", anchor: ANCHOR, body, mentions: [], ...extra },
    });

  it("editor creates; viewer reads; non-member 404; viewer cannot write (403)", async () => {
    const created = await createThread(editor);
    expect(created.status).toBe(200);
    expect(created.data.thread.root.body).toBe("root comment");

    const read = await api.request(
      "GET",
      `/api/projects/${projectId}/comments?file=src/a.ts`,
      { token: viewer },
    );
    expect(read.status).toBe(200);
    expect(read.data.threads.length).toBe(1);

    const strangerRead = await api.request(
      "GET",
      `/api/projects/${projectId}/comments?file=src/a.ts`,
      { token: stranger },
    );
    expect(strangerRead.status).toBe(404);

    const viewerWrite = await createThread(viewer);
    expect(viewerWrite.status).toBe(403);
  });

  it("mention: non-member/unknown dropped; member persisted", async () => {
    // resolve member ids
    const me = await api.request("GET", "/api/auth/me", { token: viewer });
    const viewerId = me.data.user.id;
    const created = await createThread(editor, "hey", {
      mentions: [viewerId, 99999],
    });
    expect(created.status).toBe(200);
    expect(created.data.thread.mentions).toEqual([
      { userId: viewerId, username: "viewer" },
    ]);
  });

  it("edit is author-only; delete is author-or-owner; replies survive", async () => {
    const t = await createThread(editor, "editable");
    const threadId = t.data.thread.id;
    const commentId = t.data.thread.root.id;

    const reply = await api.request(
      "POST",
      `/api/projects/${projectId}/comments/${threadId}/replies`,
      { token: owner, body: { body: "a reply", mentions: [] } },
    );
    expect(reply.status).toBe(200);

    const badEdit = await api.request(
      "PATCH",
      `/api/projects/${projectId}/comments/${commentId}`,
      { token: owner, body: { body: "hijacked" } },
    );
    expect(badEdit.status).toBe(403);

    const goodEdit = await api.request(
      "PATCH",
      `/api/projects/${projectId}/comments/${commentId}`,
      { token: editor, body: { body: "edited by author" } },
    );
    expect(goodEdit.status).toBe(200);
    expect(goodEdit.data.thread.root.body).toBe("edited by author");
    expect(goodEdit.data.thread.root.editedAt).not.toBeNull();

    // owner (not author) may delete
    const del = await api.request(
      "DELETE",
      `/api/projects/${projectId}/comments/${commentId}`,
      { token: owner },
    );
    expect(del.status).toBe(200);
    expect(del.data.thread.root.deletedAt).not.toBeNull();
    expect(del.data.thread.root.body).toBe("");
    expect(del.data.thread.replies.map((r: any) => r.body)).toEqual([
      "a reply",
    ]);
  });

  it("reactions: fixed set enforced (400 for 💩); PK dedupe; toggle off", async () => {
    const t = await createThread(editor, "react to me");
    const commentId = t.data.thread.root.id;
    const url = (e: string) =>
      `/api/projects/${projectId}/comments/${commentId}/reactions/${encodeURIComponent(e)}`;

    const bad = await api.request("PUT", url("\u{1F4A9}"), { token: editor });
    expect(bad.status).toBe(400);

    await api.request("PUT", url("\u{1F44D}"), { token: editor });
    const dup = await api.request("PUT", url("\u{1F44D}"), { token: editor });
    expect(dup.status).toBe(200);
    expect(
      dup.data.thread.root.reactions.find((r: any) => r.emoji === "\u{1F44D}")
        .userIds.length,
    ).toBe(1);

    const off = await api.request("DELETE", url("\u{1F44D}"), { token: editor });
    expect(off.data.thread.root.reactions.length).toBe(0);
  });

  it("body XSS payload is stored and returned literally", async () => {
    const payload = '<img src=x onerror=alert(1)> [x](javascript:evil)';
    const t = await createThread(editor, payload);
    expect(t.data.thread.root.body).toBe(payload);
    const read = await api.request(
      "GET",
      `/api/projects/${projectId}/comments?file=src/a.ts&status=all`,
      { token: viewer },
    );
    const bodies = read.data.threads.map((x: any) => x.root.body);
    expect(bodies).toContain(payload);
  });

  it("resolve/reopen idempotent; anchor-status advisory", async () => {
    const t = await createThread(editor, "resolve me");
    const threadId = t.data.thread.id;
    const r1 = await api.request(
      "POST",
      `/api/projects/${projectId}/comments/${threadId}/resolve`,
      { token: editor },
    );
    expect(r1.data.thread.resolvedBy).not.toBeNull();
    const r2 = await api.request(
      "POST",
      `/api/projects/${projectId}/comments/${threadId}/resolve`,
      { token: owner },
    );
    expect(r2.status).toBe(200);
    const reopen = await api.request(
      "POST",
      `/api/projects/${projectId}/comments/${threadId}/reopen`,
      { token: editor },
    );
    expect(reopen.data.thread.resolvedAt).toBeNull();

    const as = await api.request(
      "POST",
      `/api/projects/${projectId}/comments/${threadId}/anchor-status`,
      { token: editor, body: { status: "stale" } },
    );
    expect(as.status).toBe(200);
  });

  it("every successful mutation broadcasts a comment_event", async () => {
    const spy = vi.spyOn(collaborationManager, "broadcastCommentEvent");
    spy.mockClear();
    const t = await createThread(editor, "spy me");
    expect(spy).toHaveBeenCalledWith(
      projectId,
      expect.objectContaining({ kind: "created", filePath: "src/a.ts" }),
    );
    await api.request(
      "POST",
      `/api/projects/${projectId}/comments/${t.data.thread.id}/resolve`,
      { token: editor },
    );
    expect(spy).toHaveBeenCalledWith(
      projectId,
      expect.objectContaining({ kind: "resolved" }),
    );
    spy.mockRestore();
  });
});

describe("M61-A comment rate limiting", () => {
  it("31st write in the window → 429", async () => {
    const api = await startTestApi(
      makeTestConfig({ commentWriteMax: 3, commentWriteWindowMs: 60_000 }),
    );
    try {
      const token = await register(api, "rluser");
      const proj = await api.request("POST", "/api/projects", {
        token,
        body: { name: "rl" },
      });
      const pid = proj.data.project.id;
      const mk = () =>
        api.request("POST", `/api/projects/${pid}/comments`, {
          token,
          body: { filePath: "a.ts", anchor: ANCHOR, body: "x", mentions: [] },
        });
      expect((await mk()).status).toBe(200);
      expect((await mk()).status).toBe(200);
      expect((await mk()).status).toBe(200);
      expect((await mk()).status).toBe(429);
    } finally {
      await api.close();
    }
  });
});
