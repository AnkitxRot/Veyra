import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, writeFileSync, symlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { IS_WINDOWS } from "../src/config";
import { isDockerRunning } from "../src/tools.js";
import { makeTestConfig, startTestApi, type TestApi } from "./helpers.js";
import { collaborationManager } from "../src/collab/manager.js";

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
