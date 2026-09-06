import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { makeTestConfig, startTestApi, type TestApi } from "./helpers.js";
import { collaborationManager } from "../src/collab/manager.js";
import type { AppConfig } from "../src/config.js";
import type { Db } from "../src/db.js";
import { makeNoisyPng, makePng, makeSvg, multipart } from "./imageFixture.js";

interface Sess {
  id: number;
  token: string;
}

describe("M72 — avatar media API", () => {
  let cfg: AppConfig;
  let api: TestApi;
  let db: Db;
  let alice: Sess;
  let bob: Sess;

  async function register(username: string): Promise<Sess> {
    const r = await api.request("POST", "/api/auth/register", {
      body: { username, password: "password123" },
    });
    return { id: r.data.user.id, token: r.data.token };
  }

  /** POST a raw multipart body to the avatar endpoint. */
  async function postAvatar(
    token: string | null,
    body: Buffer,
    contentType: string,
  ): Promise<{ status: number; data: any; text: string; headers: Headers }> {
    const headers: Record<string, string> = { "Content-Type": contentType };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`${api.base}/api/auth/profile/avatar`, {
      method: "POST",
      headers,
      body,
    });
    const text = await res.text();
    let data: any = {};
    try {
      data = JSON.parse(text);
    } catch {}
    return { status: res.status, data, text, headers: res.headers };
  }

  beforeEach(async () => {
    cfg = makeTestConfig({
      profileMediaUploadMax: 3,
      profileMediaUploadWindowMs: 60_000,
    });
    api = await startTestApi(cfg);
    db = api.db;
    alice = await register("avatar_alice");
    bob = await register("avatar_bob");
  });

  afterEach(async () => {
    await api.close();
    vi.restoreAllMocks();
  });

  it("1. uploads a valid PNG and returns version + metadata, never a path", async () => {
    const { body, contentType } = multipart("a.png", makePng(96, 96));
    const r = await postAvatar(alice.token, body, contentType);
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({
      avatarVersion: 1,
      mime: "image/png",
      width: 96,
      height: 96,
    });
    expect(r.text).not.toMatch(/profile-media|storage_path|storagePath|dataDir/);
  });

  it("2. GET /api/auth/profile reflects the new avatarVersion", async () => {
    const { body, contentType } = multipart("a.png", makePng(64, 64));
    await postAvatar(alice.token, body, contentType);
    const g = await api.request("GET", "/api/auth/profile", {
      token: alice.token,
    });
    expect(g.data.profile.avatarVersion).toBe(1);
  });

  it("3. unauthenticated upload -> 401", async () => {
    const { body, contentType } = multipart("a.png", makePng(64, 64));
    const r = await postAvatar(null, body, contentType);
    expect(r.status).toBe(401);
  });

  it("4. an SVG payload is rejected (declared image/png)", async () => {
    const { body, contentType } = multipart("x.svg", makeSvg(), "image/png");
    const r = await postAvatar(alice.token, body, contentType);
    expect(r.status).toBe(400);
  });

  it("5. the declared part Content-Type is ignored — real PNG bytes win", async () => {
    const { body, contentType } = multipart("a.bin", makePng(64, 64), "image/gif");
    const r = await postAvatar(alice.token, body, contentType);
    expect(r.status).toBe(200);
    expect(r.data.mime).toBe("image/png");
  });

  it("6. a non-multipart body -> 400", async () => {
    const r = await postAvatar(
      alice.token,
      Buffer.from(JSON.stringify({ hi: 1 })),
      "application/json",
    );
    expect(r.status).toBe(400);
    expect(r.data.error.code).toBe("invalid_multipart");
  });

  it("7. a multipart body with no file part -> 400", async () => {
    const boundary = "----b";
    const body = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="x"\r\n\r\nnope\r\n--${boundary}--\r\n`,
    );
    const r = await postAvatar(
      alice.token,
      body,
      `multipart/form-data; boundary=${boundary}`,
    );
    expect(r.status).toBe(400);
  });

  it("8. an over-budget image -> 400 image_too_large", async () => {
    await api.close();
    cfg = makeTestConfig({ profileMediaAvatarMaxBytes: 2_048 });
    api = await startTestApi(cfg);
    db = api.db;
    alice = await register("tiny_budget_alice");
    const { body, contentType } = multipart("big.png", makeNoisyPng(100, 100));
    const r = await postAvatar(alice.token, body, contentType);
    expect(r.status).toBe(400);
    expect(r.data.error.code).toBe("image_too_large");
  });

  it("9. the per-user upload rate limit returns 429", async () => {
    for (let i = 0; i < 3; i++) {
      const { body, contentType } = multipart("a.png", makePng(64, 64));
      const ok = await postAvatar(alice.token, body, contentType);
      expect(ok.status).toBe(200);
    }
    const { body, contentType } = multipart("a.png", makePng(64, 64));
    const blocked = await postAvatar(alice.token, body, contentType);
    expect(blocked.status).toBe(429);
    expect(blocked.data.error.code).toBe("rate_limited");
  });

  it("10. GET /profile/avatar serves the bytes with a locked-down content type", async () => {
    const { body, contentType } = multipart("a.png", makePng(64, 64));
    await postAvatar(alice.token, body, contentType);
    const res = await fetch(`${api.base}/api/auth/profile/avatar`, {
      headers: { Authorization: `Bearer ${alice.token}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });

  it("11. removing an avatar 404s the subsequent GET and resets the version", async () => {
    const { body, contentType } = multipart("a.png", makePng(64, 64));
    await postAvatar(alice.token, body, contentType);
    const del = await api.request("DELETE", "/api/auth/profile/avatar", {
      token: alice.token,
    });
    expect(del.status).toBe(200);
    const res = await fetch(`${api.base}/api/auth/profile/avatar`, {
      headers: { Authorization: `Bearer ${alice.token}` },
    });
    expect(res.status).toBe(404);
    const g = await api.request("GET", "/api/auth/profile", {
      token: alice.token,
    });
    expect(g.data.profile.avatarVersion).toBe(0);
  });

  it("12. DELETE with no avatar is a no-op 200", async () => {
    const del = await api.request("DELETE", "/api/auth/profile/avatar", {
      token: bob.token,
    });
    expect(del.status).toBe(200);
    expect(del.data.ok).toBe(true);
  });

  it("13. a stranger cannot fetch another user's avatar (404, not 403)", async () => {
    const { body, contentType } = multipart("a.png", makePng(64, 64));
    await postAvatar(alice.token, body, contentType);
    const res = await fetch(`${api.base}/api/auth/profile/${alice.id}/avatar`, {
      headers: { Authorization: `Bearer ${bob.token}` },
    });
    expect(res.status).toBe(404);
  });

  it("14. a project collaborator can fetch the owner's avatar", async () => {
    const { body, contentType } = multipart("a.png", makePng(64, 64));
    await postAvatar(alice.token, body, contentType);
    const proj = await api.request("POST", "/api/projects", {
      token: alice.token,
      body: { name: "shared" },
    });
    db.prepare(
      "INSERT INTO project_collaborators (project_id, user_id, role) VALUES (?, ?, 'editor')",
    ).run(proj.data.project.id, bob.id);
    const res = await fetch(`${api.base}/api/auth/profile/${alice.id}/avatar`, {
      headers: { Authorization: `Bearer ${bob.token}` },
    });
    expect(res.status).toBe(200);
  });

  it("15. a non-numeric :id is a 404", async () => {
    const res = await fetch(`${api.base}/api/auth/profile/not-a-number/avatar`, {
      headers: { Authorization: `Bearer ${bob.token}` },
    });
    expect(res.status).toBe(404);
  });

  it("16. a successful upload broadcasts one profile_event for the user", async () => {
    const spy = vi.spyOn(
      collaborationManager,
      "broadcastProfileEventForUser",
    );
    const { body, contentType } = multipart("a.png", makePng(64, 64));
    await postAvatar(alice.token, body, contentType);
    expect(spy).toHaveBeenCalledWith(alice.id);
  });

  it("17. an upload writes a PROFILE_MEDIA_UPLOADED audit row without content", async () => {
    const { body, contentType } = multipart("a.png", makePng(64, 64));
    await postAvatar(alice.token, body, contentType);
    const row = db
      .prepare(
        "SELECT * FROM audit_logs WHERE user_id = ? AND event_type = 'PROFILE_MEDIA_UPLOADED'",
      )
      .get(alice.id) as any;
    expect(row).toBeTruthy();
    expect(row.details).toContain("avatar");
    expect(row.details).not.toMatch(/profile-media|storage_path/);
  });
});
