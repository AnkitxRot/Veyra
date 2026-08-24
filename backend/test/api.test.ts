import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { existsSync, writeFileSync, symlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { IS_WINDOWS } from "../src/config";
import { isDockerRunning } from "../src/tools.js";
import { makeTestConfig, startTestApi, type TestApi } from "./helpers.js";
import { collaborationManager } from "../src/collab/manager.js";

// Mirrors backend/src/ai/routes.ts's computeRevision() so tests can compute
// the expected baseRevision for known content without importing internals.
function revOf(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

let api: TestApi;
let cfg: ReturnType<typeof makeTestConfig>;
let token: string;
let projectId: string;

beforeAll(async () => {
  cfg = makeTestConfig();
  api = await startTestApi(cfg);
  const reg = await api.request("POST", "/api/auth/register", {
    body: { username: "alice", password: "secret123" },
  });
  token = reg.data.token;
  const proj = await api.request("POST", "/api/projects", {
    token,
    body: { name: "demo" },
  });
  projectId = proj.data.project.id;
});

afterAll(async () => {
  await api?.close();
});

describe("auth", () => {
  it("rejects duplicate usernames", async () => {
    const r = await api.request("POST", "/api/auth/register", {
      body: { username: "alice", password: "x".repeat(8) },
    });
    expect(r.status).toBe(409);
  });

  it("rejects wrong passwords", async () => {
    const r = await api.request("POST", "/api/auth/login", {
      body: { username: "alice", password: "wrong" },
    });
    expect(r.status).toBe(401);
  });

  it("logs in and reports the current user", async () => {
    const login = await api.request("POST", "/api/auth/login", {
      body: { username: "alice", password: "secret123" },
    });
    expect(login.status).toBe(200);
    expect(login.data.user.username).toBe("alice");
    const me = await api.request("GET", "/api/auth/me", {
      token: login.data.token,
    });
    expect(me.status).toBe(200);
    expect(me.data.user.username).toBe("alice");
  });

  it("logout invalidates the session", async () => {
    const login = await api.request("POST", "/api/auth/login", {
      body: { username: "alice", password: "secret123" },
    });
    await api.request("POST", "/api/auth/logout", { token: login.data.token });
    const me = await api.request("GET", "/api/auth/me", {
      token: login.data.token,
    });
    expect(me.status).toBe(401);
  });

  it("M5a: a second authenticated request with the same token skips the DB session lookup (cache hit)", async () => {
    const login = await api.request("POST", "/api/auth/login", {
      body: { username: "alice", password: "secret123" },
    });
    const freshToken = login.data.token;

    const prepareSpy = vi.spyOn(api.db, "prepare");
    try {
      const first = await api.request("GET", "/api/auth/me", {
        token: freshToken,
      });
      expect(first.status).toBe(200);
      const sessionLookupCallsAfterFirst = prepareSpy.mock.calls.filter(
        (c) => typeof c[0] === "string" && c[0].includes("FROM sessions s"),
      ).length;
      expect(sessionLookupCallsAfterFirst).toBe(1);

      const second = await api.request("GET", "/api/auth/me", {
        token: freshToken,
      });
      expect(second.status).toBe(200);
      expect(second.data.user.username).toBe("alice");
      // The cache hit must not have issued a second session-lookup query.
      const sessionLookupCallsAfterSecond = prepareSpy.mock.calls.filter(
        (c) => typeof c[0] === "string" && c[0].includes("FROM sessions s"),
      ).length;
      expect(sessionLookupCallsAfterSecond).toBe(1);
    } finally {
      prepareSpy.mockRestore();
    }
  });

  it("requires authentication for projects", async () => {
    const r = await api.request("GET", "/api/projects");
    expect(r.status).toBe(401);
  });
});

describe("projects and files", () => {
  it("persists the workspace on local disk", () => {
    const dir = join(cfg.workspacesDir, projectId);
    expect(existsSync(dir)).toBe(true);
  });

  it("creates, lists, and reads back project files", async () => {
    await api.request("POST", `/api/projects/${projectId}/file`, {
      token,
      body: { path: "main.py", content: 'print("hi")\n' },
    });
    const got = await api.request(
      "GET",
      `/api/projects/${projectId}/file?path=main.py`,
      { token },
    );
    expect(got.status).toBe(200);
    expect(got.data.content).toBe('print("hi")\n');
    const tree = await api.request("GET", `/api/projects/${projectId}/tree`, {
      token,
    });
    expect(
      tree.data.tree.some((n: { path: string }) => n.path === "main.py"),
    ).toBe(true);
  });

  it("moves files", async () => {
    await api.request("POST", `/api/projects/${projectId}/move`, {
      token,
      body: { from: "main.py", to: "src/main.py" },
    });
    const got = await api.request(
      "GET",
      `/api/projects/${projectId}/file?path=src/main.py`,
      { token },
    );
    expect(got.data.content).toBe('print("hi")\n');
  });

  it("deletes files", async () => {
    await api.request("POST", `/api/projects/${projectId}/delete`, {
      token,
      body: { path: "src/main.py" },
    });
    const got = await api.request(
      "GET",
      `/api/projects/${projectId}/file?path=src/main.py`,
      { token },
    );
    expect(got.status).toBe(404);
  });

  it("deleting a file syncs any active CollaborationRoom, so it is not resurrected by the next flush", async () => {
    const proj = await api.request("POST", "/api/projects", {
      token,
      body: { name: "collab-delete" },
    });
    const pid = proj.data.project.id;
    await api.request("POST", `/api/projects/${pid}/file`, {
      token,
      body: { path: "app.js", content: 'console.log("v1")' },
    });

    // A collaborator has the file open with further, unsaved local edits.
    const room = collaborationManager.getOrCreateRoom(pid);
    const yText = await room.ensureFileLoaded("app.js");
    expect(yText.toString()).toBe('console.log("v1")');
    yText.delete(0, yText.length);
    yText.insert(0, 'console.log("unsaved local edit")');

    await api.request("POST", `/api/projects/${pid}/delete`, {
      token,
      body: { path: "app.js" },
    });

    // The room's live Y.Doc must reflect the deletion too, otherwise its
    // next debounced flush would silently rewrite the deleted file back to
    // disk from the collaborator's stale local edit.
    expect(yText.toString()).toBe("");
  });

  it("moving a file syncs any active CollaborationRoom's old and new paths", async () => {
    const proj = await api.request("POST", "/api/projects", {
      token,
      body: { name: "collab-move" },
    });
    const pid = proj.data.project.id;
    await api.request("POST", `/api/projects/${pid}/file`, {
      token,
      body: { path: "old.js", content: 'console.log("v1")' },
    });

    const room = collaborationManager.getOrCreateRoom(pid);
    const oldText = await room.ensureFileLoaded("old.js");
    expect(oldText.toString()).toBe('console.log("v1")');

    await api.request("POST", `/api/projects/${pid}/move`, {
      token,
      body: { from: "old.js", to: "new.js" },
    });

    // The old path's room entry must be cleared, otherwise the next flush
    // would resurrect the file at its old (now nonexistent) path.
    expect(oldText.toString()).toBe("");
    // The new path must reflect the moved content, not be left stuck on
    // stale or empty content from before the file was ever loaded there.
    const newText = await room.ensureFileLoaded("new.js");
    expect(newText.toString()).toBe('console.log("v1")');
  });
});

describe("path traversal protection", () => {
  const attempts = ["../escape.txt", "../../etc/passwd", "a/../../escape.txt"];

  for (const p of attempts) {
    it(`rejects write to "${p}"`, async () => {
      const r = await api.request("POST", `/api/projects/${projectId}/file`, {
        token,
        body: { path: p, content: "evil" },
      });
      expect(r.status).toBe(400);
    });
    it(`rejects read of "${p}"`, async () => {
      const r = await api.request(
        "GET",
        `/api/projects/${projectId}/file?path=${encodeURIComponent(p)}`,
        { token },
      );
      expect(r.status).toBe(400);
    });
  }

  // Skip symlink tests on Windows — symlinks require elevated privileges
  it.skipIf(IS_WINDOWS)("rejects symlink escapes", async () => {
    const secret = join(
      tmpdir(),
      `cloudide-secret-${Math.random().toString(36).slice(2)}.txt`,
    );
    writeFileSync(secret, "SECRET");
    const ws = join(cfg.workspacesDir, projectId);
    symlinkSync(secret, join(ws, "link.txt"));
    const r = await api.request(
      "GET",
      `/api/projects/${projectId}/file?path=link.txt`,
      { token },
    );
    expect(r.status).toBe(400);
  });

  it.skipIf(IS_WINDOWS)(
    "rejects write through a symlinked directory",
    async () => {
      const outside = join(
        tmpdir(),
        `cloudide-out-${Math.random().toString(36).slice(2)}`,
      );
      mkdirSync(outside, { recursive: true });
      const ws = join(cfg.workspacesDir, projectId);
      symlinkSync(outside, join(ws, "linkdir"));
      const r = await api.request("POST", `/api/projects/${projectId}/file`, {
        token,
        body: { path: "linkdir/x.txt", content: "evil" },
      });
      expect(r.status).toBe(400);
    },
  );
});

describe.skipIf(!isDockerRunning())("execution via API", () => {
  it("runs a python program through the HTTP API and returns real output", async () => {
    await api.request("POST", `/api/projects/${projectId}/file`, {
      token,
      body: { path: "main.py", content: 'print("api says hello")\n' },
    });
    const r = await api.request("POST", `/api/projects/${projectId}/run`, {
      token,
      body: {},
    });
    expect(r.status).toBe(200);
    expect(r.data.type).toBe("success");
    expect(r.data.stdout.trim()).toBe("api says hello");
    expect(r.data.exitCode).toBe(0);
  });
});

describe("dependency installation command selection", () => {
  function getCommand(text: string): string | null {
    const match = text.match(/^Running\s+(\S+)/m);
    return match ? match[1] : null;
  }

  it("case 1: package.json only → npm install", async () => {
    const p = await api.request("POST", "/api/projects", {
      token,
      body: { name: "npm-only" },
    });
    const pId = p.data.project.id;
    await api.request("POST", `/api/projects/${pId}/file`, {
      token,
      body: {
        path: "package.json",
        content: '{"name":"test","dependencies":{}}',
      },
    });
    const r = await api.request("POST", `/api/projects/${pId}/install`, {
      token,
      body: {},
    });
    expect(r.status).toBe(200);
    expect(getCommand(r.text)).toBe("npm");
  });

  it("case 2: requirements.txt only → Python venv install", async () => {
    const p = await api.request("POST", "/api/projects", {
      token,
      body: { name: "pip-only" },
    });
    const pId = p.data.project.id;
    await api.request("POST", `/api/projects/${pId}/file`, {
      token,
      body: { path: "requirements.txt", content: "six==1.17.0\n" },
    });
    const r = await api.request("POST", `/api/projects/${pId}/install`, {
      token,
      body: {},
    });
    expect(r.status).toBe(200);
    expect(getCommand(r.text)).toBe("sh");
  }, 120000);

  it("case 3: both manifests → Python venv install (Python takes precedence)", async () => {
    const p = await api.request("POST", "/api/projects", {
      token,
      body: { name: "both" },
    });
    const pId = p.data.project.id;
    await api.request("POST", `/api/projects/${pId}/file`, {
      token,
      body: { path: "package.json", content: '{"name":"test"}' },
    });
    await api.request("POST", `/api/projects/${pId}/file`, {
      token,
      body: { path: "requirements.txt", content: "six==1.17.0\n" },
    });
    const r = await api.request("POST", `/api/projects/${pId}/install`, {
      token,
      body: {},
    });
    expect(r.status).toBe(200);
    expect(getCommand(r.text)).toBe("sh");
  }, 120000);

  it("case 4: no manifests, language=node → npm install", async () => {
    const p = await api.request("POST", "/api/projects", {
      token,
      body: { name: "lang-node", language: "node" },
    });
    const pId = p.data.project.id;
    const r = await api.request("POST", `/api/projects/${pId}/install`, {
      token,
      body: {},
    });
    expect(r.status).toBe(200);
    expect(getCommand(r.text)).toBe("npm");
  });

  it("case 5: no manifests, language=python → Python venv install", async () => {
    const p = await api.request("POST", "/api/projects", {
      token,
      body: { name: "lang-python", language: "python" },
    });
    const pId = p.data.project.id;
    const r = await api.request("POST", `/api/projects/${pId}/install`, {
      token,
      body: {},
    });
    expect(r.status).toBe(200);
    expect(getCommand(r.text)).toBe("sh");
  }, 120000);

  it("case 6: no manifests, language=auto → no dependency configuration", async () => {
    const p = await api.request("POST", "/api/projects", {
      token,
      body: { name: "lang-auto" },
    });
    const pId = p.data.project.id;
    const r = await api.request("POST", `/api/projects/${pId}/install`, {
      token,
      body: {},
    });
    expect(r.status).toBe(200);
    expect(r.text).toContain("No dependency configuration found");
  });
});

describe("IDOR & Authorization Security", () => {
  let user2Token: string;

  beforeAll(async () => {
    const reg2 = await api.request("POST", "/api/auth/register", {
      body: { username: "bob", password: "secret123" },
    });
    user2Token = reg2.data.token;
  });

  it("rejects invalid tokens", async () => {
    const r = await api.request("GET", "/api/projects", {
      token: "invalid-token",
    });
    expect(r.status).toBe(401);
  });

  it("prevents user2 from accessing user1 project files (IDOR)", async () => {
    const r = await api.request("GET", `/api/projects/${projectId}/tree`, {
      token: user2Token,
    });
    expect(r.status).toBe(404);
  });

  it("prevents user2 from running user1 project", async () => {
    const r = await api.request("POST", `/api/projects/${projectId}/run`, {
      token: user2Token,
      body: {},
    });
    expect(r.status).toBe(404);
  });
});

describe.skipIf(!isDockerRunning())("Preview Proxy Security", () => {
  let user2Token: string;

  beforeAll(async () => {
    const reg = await api.request("POST", "/api/auth/register", {
      body: { username: "charlie", password: "secret123" },
    });
    user2Token = reg.data.token;
  });

  it("rejects unauthenticated requests to proxy", async () => {
    const r = await api.request(
      "GET",
      `/api/projects/${projectId}/proxy/3000/`,
    );
    expect(r.status).toBe(401);
  });

  it("rejects proxy access via query token", async () => {
    const r = await api.request(
      "GET",
      `/api/projects/${projectId}/proxy/3000/?token=${token}`,
    );
    expect(r.status).toBe(401);
  });

  it("allows proxy access via bearer token", async () => {
    const r = await api.request(
      "GET",
      `/api/projects/${projectId}/proxy/3000/`,
      { token },
    );
    expect(r.status).not.toBe(401);
  });

  it("prevents user2 from proxying user1 project", async () => {
    const r = await api.request(
      "GET",
      `/api/projects/${projectId}/proxy/3000/`,
      { token: user2Token },
    );
    expect(r.status).toBe(404);
  });

  it("rejects invalid port formats", async () => {
    const r = await api.request(
      "GET",
      `/api/projects/${projectId}/proxy/invalid/`,
      { token },
    );
    expect(r.status).toBe(400);
    expect(r.data.error.message).toBe("Invalid port");
  });

  it("rejects ports below 1024", async () => {
    const r = await api.request("GET", `/api/projects/${projectId}/proxy/80/`, {
      token,
    });
    expect(r.status).toBe(400);
  });
});

describe("search concurrency gate", () => {
  let gateCfg: ReturnType<typeof makeTestConfig>;
  let gateApi: TestApi;
  let gateToken: string;
  let gateProjectId: string;

  beforeAll(async () => {
    // A cap of 1 makes the limit deterministic: any second request that is
    // in flight while the first one's worker thread is alive must be
    // rejected, without depending on how fast the event loop drains.
    gateCfg = makeTestConfig({ maxConcurrentRuns: 1 });
    gateApi = await startTestApi(gateCfg);
    const reg = await gateApi.request("POST", "/api/auth/register", {
      body: { username: "gateuser", password: "secret123" },
    });
    gateToken = reg.data.token;
    const proj = await gateApi.request("POST", "/api/projects", {
      token: gateToken,
      body: { name: "search-gate" },
    });
    gateProjectId = proj.data.project.id;
    // Enough content that each search does real traversal work, so the
    // requests genuinely overlap rather than completing instantly.
    for (let i = 0; i < 6; i++) {
      await gateApi.request("POST", `/api/projects/${gateProjectId}/file`, {
        token: gateToken,
        body: {
          path: `src/file${i}.txt`,
          content: `needle line ${i}\nfiller\n`.repeat(200),
        },
      });
    }
  });

  afterAll(async () => {
    await gateApi?.close();
  });

  it("rejects searches beyond the per-user concurrent limit", async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        gateApi.request("POST", `/api/projects/${gateProjectId}/search`, {
          token: gateToken,
          body: { query: "needle" },
        }),
      ),
    );
    const rejected = results.filter((r) => r.status === 429);
    expect(rejected.length).toBeGreaterThan(0);
    for (const r of rejected) {
      expect(r.data.error.code).toBe("too_many_searches");
    }
    // The cap must not reject everything: at least one request gets through.
    expect(results.some((r) => r.status === 200)).toBe(true);
  });

  it("POST and GET share one per-user search budget", async () => {
    const results = await Promise.all([
      gateApi.request("POST", `/api/projects/${gateProjectId}/search`, {
        token: gateToken,
        body: { query: "needle" },
      }),
      gateApi.request("GET", `/api/projects/${gateProjectId}/search?q=needle`, {
        token: gateToken,
      }),
      gateApi.request("GET", `/api/projects/${gateProjectId}/search?q=needle`, {
        token: gateToken,
      }),
    ]);
    expect(results.filter((r) => r.status === 429).length).toBeGreaterThan(0);
  });

  it("releases the slot after each search completes", async () => {
    // Sequential searches must all succeed; a leaked slot would wedge the
    // user's budget permanently after the bursts above.
    for (let i = 0; i < 3; i++) {
      const r = await gateApi.request(
        "GET",
        `/api/projects/${gateProjectId}/search?q=needle`,
        { token: gateToken },
      );
      expect(r.status).toBe(200);
      expect(r.data.totalMatches).toBeGreaterThan(0);
    }
  });

  it("releases the slot when the search itself fails", async () => {
    const bad = await gateApi.request(
      "GET",
      `/api/projects/${gateProjectId}/search?q=${encodeURIComponent("(unclosed")}&regex=true`,
      { token: gateToken },
    );
    expect(bad.status).toBe(400);
    expect(bad.data.error.code).toBe("invalid_regex");
    const ok = await gateApi.request(
      "GET",
      `/api/projects/${gateProjectId}/search?q=needle`,
      { token: gateToken },
    );
    expect(ok.status).toBe(200);
  });
});

describe("AI apply-patch: requested safety snapshot must not fail silently", () => {
  // Own isolated config/server: the test deliberately corrupts the
  // snapshots directory location, which would otherwise break snapshot
  // creation for every other test sharing the top-level `cfg`.
  let snapCfg: ReturnType<typeof makeTestConfig>;
  let snapApi: TestApi;
  let snapToken: string;
  let snapProjectId: string;

  beforeAll(async () => {
    snapCfg = makeTestConfig();
    snapApi = await startTestApi(snapCfg);
    const reg = await snapApi.request("POST", "/api/auth/register", {
      body: { username: "snapuser", password: "secret123" },
    });
    snapToken = reg.data.token;
    const proj = await snapApi.request("POST", "/api/projects", {
      token: snapToken,
      body: { name: "snap-fail" },
    });
    snapProjectId = proj.data.project.id;
    await snapApi.request("POST", `/api/projects/${snapProjectId}/file`, {
      token: snapToken,
      body: { path: "main.py", content: 'print("original")\n' },
    });

    // createSnapshot() writes to join(cfg.dataDir, 'snapshots', projectId)
    // via fs.mkdir(dir, { recursive: true }). Pre-creating a plain FILE at
    // the 'snapshots' path component forces that mkdir to fail with
    // ENOTDIR — a genuine, realistic failure (e.g. disk/permission issue),
    // not a mock.
    writeFileSync(join(snapCfg.dataDir, "snapshots"), "not a directory");
  });

  afterAll(async () => {
    await snapApi?.close();
  });

  it("aborts the patch (does not write the file) when the requested safety snapshot cannot be created", async () => {
    const res = await snapApi.request(
      "POST",
      `/api/projects/${snapProjectId}/ai/apply-patch`,
      {
        token: snapToken,
        body: {
          filePath: "main.py",
          content: 'print("patched by AI")\n',
          createSafetySnapshot: true,
          explanation: "test patch",
          baseRevision: revOf('print("original")\n'),
        },
      },
    );

    // Must fail loudly, not return { ok: true, snapshotId: undefined } as
    // if nothing was requested.
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(res.data.error.code).toBe("snapshot_failed");

    // The patch must not have been applied: a requested-but-failed safety
    // net must not leave the caller with an unprotected, already-applied
    // change and no way to tell it happened.
    const got = await snapApi.request(
      "GET",
      `/api/projects/${snapProjectId}/file?path=main.py`,
      { token: snapToken },
    );
    expect(got.data.content).toBe('print("original")\n');
  });

  it("still applies the patch normally when no safety snapshot is requested", async () => {
    const res = await snapApi.request(
      "POST",
      `/api/projects/${snapProjectId}/ai/apply-patch`,
      {
        token: snapToken,
        body: {
          filePath: "main.py",
          content: 'print("patched without snapshot")\n',
          createSafetySnapshot: false,
          baseRevision: revOf('print("original")\n'),
        },
      },
    );
    expect(res.status).toBe(200);
    expect(res.data.ok).toBe(true);
    expect(res.data.snapshotId).toBeUndefined();

    const got = await snapApi.request(
      "GET",
      `/api/projects/${snapProjectId}/file?path=main.py`,
      { token: snapToken },
    );
    expect(got.data.content).toBe('print("patched without snapshot")\n');
  });
});

describe("AI apply-patch: stale-patch conflict detection", () => {
  async function makeProject(name: string): Promise<string> {
    const proj = await api.request("POST", "/api/projects", {
      token,
      body: { name },
    });
    return proj.data.project.id;
  }

  it("happy path: applying with a fresh baseRevision succeeds and writes the new content", async () => {
    const pid = await makeProject("stale-happy-path");
    const original = 'print("v1")\n';
    await api.request("POST", `/api/projects/${pid}/file`, {
      token,
      body: { path: "main.py", content: original },
    });

    const baseRevision = revOf(original);
    const res = await api.request(
      "POST",
      `/api/projects/${pid}/ai/apply-patch`,
      {
        token,
        body: {
          filePath: "main.py",
          content: 'print("v2, ai patch")\n',
          baseRevision,
        },
      },
    );

    expect(res.status).toBe(200);
    expect(res.data.ok).toBe(true);

    const got = await api.request(
      "GET",
      `/api/projects/${pid}/file?path=main.py`,
      { token },
    );
    expect(got.data.content).toBe('print("v2, ai patch")\n');
  });

  it("rejects with 409 stale_patch when the file was edited on disk after the patch's baseRevision was computed, and leaves the edit intact", async () => {
    const pid = await makeProject("stale-local-edit");
    const original = 'print("v1")\n';
    await api.request("POST", `/api/projects/${pid}/file`, {
      token,
      body: { path: "main.py", content: original },
    });

    // baseRevision reflects `original`, computed as of "patch generation time".
    const baseRevision = revOf(original);

    // An intervening edit lands on disk through the normal file-write path
    // before the AI patch is accepted.
    const editedContent = 'print("edited by someone else")\n';
    await api.request("POST", `/api/projects/${pid}/file`, {
      token,
      body: { path: "main.py", content: editedContent },
    });

    const res = await api.request(
      "POST",
      `/api/projects/${pid}/ai/apply-patch`,
      {
        token,
        body: {
          filePath: "main.py",
          content: 'print("ai patch, would clobber the edit")\n',
          baseRevision,
        },
      },
    );

    expect(res.status).toBe(409);
    expect(res.data.error.code).toBe("stale_patch");

    const got = await api.request(
      "GET",
      `/api/projects/${pid}/file?path=main.py`,
      { token },
    );
    expect(got.data.content).toBe(editedContent);
  });

  it("rejects with 409 stale_patch when a live collaborator has an unflushed edit after the patch's baseRevision was computed, and leaves the collaborator's Y.Text intact", async () => {
    const pid = await makeProject("stale-collab-edit");
    const filePath = "main.py";
    const original = 'print("v1")\n';
    await api.request("POST", `/api/projects/${pid}/file`, {
      token,
      body: { path: filePath, content: original },
    });

    // No collaboration room is active yet, so this baseRevision reflects
    // plain disk content.
    const baseRevision = revOf(original);

    // A live collaborator now opens the file (creating the room) and makes
    // an edit that has not been flushed to disk.
    const room = collaborationManager.getOrCreateRoom(pid);
    room.doc.transact(() => {
      room.doc.getText(filePath).insert(0, "unsaved collaborative edit ");
    });

    try {
      const res = await api.request(
        "POST",
        `/api/projects/${pid}/ai/apply-patch`,
        {
          token,
          body: {
            filePath,
            content: 'print("ai patch, would clobber the collaborator")\n',
            baseRevision,
          },
        },
      );

      expect(res.status).toBe(409);
      expect(res.data.error.code).toBe("stale_patch");

      expect(room.doc.getText(filePath).toString()).toBe(
        "unsaved collaborative edit ",
      );
    } finally {
      room.dispose();
    }
  });

  it("rejects a second acceptance of the same (now-stale) patch after the first acceptance already changed the authoritative content", async () => {
    const pid = await makeProject("stale-repeat-accept");
    const original = 'print("v1")\n';
    await api.request("POST", `/api/projects/${pid}/file`, {
      token,
      body: { path: "main.py", content: original },
    });

    const baseRevision = revOf(original);
    const applyBody = {
      filePath: "main.py",
      content: 'print("v2, ai patch")\n',
      baseRevision,
    };

    const first = await api.request(
      "POST",
      `/api/projects/${pid}/ai/apply-patch`,
      { token, body: applyBody },
    );
    expect(first.status).toBe(200);
    expect(first.data.ok).toBe(true);

    const second = await api.request(
      "POST",
      `/api/projects/${pid}/ai/apply-patch`,
      { token, body: applyBody },
    );
    expect(second.status).toBe(409);
    expect(second.data.error.code).toBe("stale_patch");
  });

  it("rejects with 400 invalid_base_revision when baseRevision is missing", async () => {
    const pid = await makeProject("stale-missing-revision");
    await api.request("POST", `/api/projects/${pid}/file`, {
      token,
      body: { path: "main.py", content: 'print("v1")\n' },
    });

    const res = await api.request(
      "POST",
      `/api/projects/${pid}/ai/apply-patch`,
      {
        token,
        body: {
          filePath: "main.py",
          content: 'print("v2, ai patch")\n',
        },
      },
    );

    expect(res.status).toBe(400);
    expect(res.data.error.code).toBe("invalid_base_revision");
  });
});

// ---------------------------------------------------------------------------
// M1 "save-truthfulness" backend contract.
//
// The frontend now persists whatever bytes the live editor model holds; this
// suite pins the server half of that contract: POST /file must store exactly
// the posted string and an immediate GET must return it byte-identically,
// including unicode, missing trailing newlines, and CRLF endings. Isolated
// `contract/` paths avoid collisions with the shared main.py fixtures above
// (which are moved and deleted by earlier tests in this file).
// ---------------------------------------------------------------------------
describe("save-truthfulness backend contract (M1)", () => {
  const readBack = async (path: string) =>
    api.request(
      "GET",
      `/api/projects/${projectId}/file?path=${encodeURIComponent(path)}`,
      { token },
    );

  it("persists exactly the bytes posted and reads them back byte-identically", async () => {
    const path = "contract/probe.txt";
    // Deliberate adversarial payload: BOM-free unicode, a lambda, emoji,
    // internal blank line, and NO trailing newline — none of which may be
    // normalized, trimmed, or re-encoded anywhere on the save path.
    const payload = [
      "// M1 canonical save contract probe",
      "const λ = 'üñíçø∂é → ✅';",
      "",
      "function trailing(noNewlineAtEof){return 1}",
    ].join("\n");

    const write = await api.request("POST", `/api/projects/${projectId}/file`, {
      token,
      body: { path, content: payload },
    });
    expect(write.status).toBe(200);

    const read = await readBack(path);
    expect(read.status).toBe(200);
    expect(read.data.content).toBe(payload);
    expect(read.data.size).toBe(Buffer.byteLength(payload, "utf8"));
  });

  it("round-trips CRLF line endings without normalization", async () => {
    const path = "contract/crlf.txt";
    const payload = "line1\r\nline2\r\n";

    const write = await api.request("POST", `/api/projects/${projectId}/file`, {
      token,
      body: { path, content: payload },
    });
    expect(write.status).toBe(200);

    const read = await readBack(path);
    expect(read.status).toBe(200);
    expect(read.data.content).toBe(payload);
    expect(read.data.size).toBe(Buffer.byteLength(payload, "utf8"));
  });

  it("an identical overwrite save is stable (idempotent re-save of the same bytes)", async () => {
    const path = "contract/stable.txt";
    const payload = "stable content\nno edits between saves\n";

    for (let i = 0; i < 2; i++) {
      const write = await api.request(
        "POST",
        `/api/projects/${projectId}/file`,
        { token, body: { path, content: payload } },
      );
      expect(write.status).toBe(200);
    }

    const read = await readBack(path);
    expect(read.status).toBe(200);
    expect(read.data.content).toBe(payload);
  });

  it("a second save over different content fully replaces the first (no merge/append artifacts)", async () => {
    const path = "contract/replace.txt";
    const first = "export const version = 1;\n";
    const second = "export const version = 2;\nexport const extra = true;\n";

    await api.request("POST", `/api/projects/${projectId}/file`, {
      token,
      body: { path, content: first },
    });
    await api.request("POST", `/api/projects/${projectId}/file`, {
      token,
      body: { path, content: second },
    });

    const read = await readBack(path);
    expect(read.status).toBe(200);
    expect(read.data.content).toBe(second);
  });
});
