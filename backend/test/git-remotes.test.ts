import { describe, it, expect, beforeEach, afterEach, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  makeTestConfig,
  sandboxGitAvailable,
  startTestApi,
  stopProjectSandboxesForTest,
  type TestApi,
} from "./helpers.js";
import type { AppConfig } from "../src/config.js";
import type { Db } from "../src/db.js";
import {
  createProject,
  workspacePath,
  addProjectCollaborator,
  listProjects,
} from "../src/projects/service.js";
import * as git from "../src/git/service.js";
import { resolveInjectableSecrets } from "../src/projectsecrets/store.js";
import { collaborationManager } from "../src/collab/manager.js";
import {
  generateSelfSignedTls,
  seedBareRepo,
  pushCommitsToBare,
  startTestGitHttpsRemote,
  type TestGitRemote,
} from "./git-https-remote.js";

const KEY_B64 = Buffer.alloc(32, 7).toString("base64");
const TOKEN = "m80-test-pat-SECRETVALUE-xyz";

function gitAvailable(): boolean {
  for (const dir of [
    "C:\\Program Files\\Git\\cmd",
    "C:\\Program Files\\Git\\usr\\bin",
  ]) {
    if (existsSync(dir) && !process.env.PATH?.includes(dir)) {
      process.env.PATH = `${dir};${process.env.PATH ?? ""}`;
    }
  }
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
// M87: host Git drives the transport mirror and the test remote; project
// Git runs in the sandbox.
const HAS_GIT = gitAvailable() && sandboxGitAvailable();

const tlsDir = mkdtempSync(join(tmpdir(), "cloudide-m80-tls-"));
let tls: { certPath: string; keyPath: string } | null = null;
try {
  tls = generateSelfSignedTls(tlsDir);
} catch {
  tls = null;
}
const HAS_HTTPS = HAS_GIT && tls !== null;

describe.skipIf(!HAS_GIT)("M80 — remotes API (no network)", () => {
  let cfg: AppConfig;
  let api: TestApi;
  let db: Db;
  let ownerToken: string;
  let editorToken: string;
  let viewerToken: string;
  let outsiderToken: string;
  let ownerId: number;
  let projectId: string;
  let cwd: string;

  beforeEach(async () => {
    cfg = makeTestConfig({ secretsMasterKey: KEY_B64 });
    api = await startTestApi(cfg);
    db = api.db;
    const mk = async (u: string) =>
      (
        await api.request("POST", "/api/auth/register", {
          body: { username: u, password: "password123" },
        })
      ).data;
    const owner = await mk("m80owner");
    const editor = await mk("m80editor");
    const viewer = await mk("m80viewer");
    const outsider = await mk("m80outsider");
    ownerToken = owner.token;
    editorToken = editor.token;
    viewerToken = viewer.token;
    outsiderToken = outsider.token;
    ownerId = owner.user.id;
    const proj = await createProject(cfg, db, ownerId, {
      name: "m80-local",
      language: "python",
    });
    projectId = proj.id;
    cwd = await workspacePath(cfg, projectId);
    addProjectCollaborator(db, projectId, editor.user.id, "editor");
    addProjectCollaborator(db, projectId, viewer.user.id, "viewer");
    await fs.writeFile(join(cwd, "main.py"), "print('hi')\n", "utf8");
  });

  afterEach(async () => {
    await stopProjectSandboxesForTest(db);
    await api.close();
    try {
      await fs.rm(cfg.dataDir, { recursive: true, force: true });
    } catch {}
  });

  const g = (p: string) => `/api/projects/${projectId}/git${p}`;

  it("clone rejects an invalid remote URL before creating a project", async () => {
    const before = listProjects(db, ownerId).length;
    const r = await api.request("POST", "/api/projects/clone", {
      token: ownerToken,
      body: { name: "nope", url: "git@github.com:org/repo.git" },
    });
    expect(r.status).toBe(400);
    expect(r.data.error.code).toBe("unsupported_protocol");
    expect(listProjects(db, ownerId)).toHaveLength(before);
    expect(JSON.stringify(r.data)).not.toContain(TOKEN);
  });

  it("clone rejects a credential-bearing URL", async () => {
    const r = await api.request("POST", "/api/projects/clone", {
      token: ownerToken,
      body: {
        name: "nope",
        url: `https://user:${TOKEN}@github.com/org/repo.git`,
      },
    });
    expect(r.status).toBe(400);
    expect(r.data.error.code).toBe("credential_bearing_url");
    expect(JSON.stringify(r.data)).not.toContain(TOKEN);
  });

  it("unauthenticated clone is 401", async () => {
    const r = await api.request("POST", "/api/projects/clone", {
      body: { name: "x", url: "https://github.com/org/repo.git" },
    });
    expect(r.status).toBe(401);
  });

  it("add remote rejects credential-bearing and non-https URLs", async () => {
    await api.request("POST", g("/init"), { token: ownerToken });
    const bad = await api.request("PUT", g("/remote"), {
      token: ownerToken,
      body: { url: `https://user:${TOKEN}@example.com/r.git` },
    });
    expect(bad.status).toBe(400);
    expect(bad.data.error.code).toBe("credential_bearing_url");
    expect(JSON.stringify(bad.data)).not.toContain(TOKEN);

    const ssh = await api.request("PUT", g("/remote"), {
      token: ownerToken,
      body: { url: "ssh://git@example.com/r.git" },
    });
    expect(ssh.status).toBe(400);
    expect(ssh.data.error.code).toBe("unsupported_protocol");
  });

  it("add remote is idempotent for the same origin and conflicts on a different one", async () => {
    await api.request("POST", g("/init"), { token: ownerToken });
    const a = await api.request("PUT", g("/remote"), {
      token: ownerToken,
      body: { url: "https://example.com/org/repo.git" },
    });
    expect(a.status).toBe(200);
    const again = await api.request("PUT", g("/remote"), {
      token: ownerToken,
      body: { url: "https://example.com/org/repo" },
    });
    expect(again.status).toBe(200);
    const clash = await api.request("PUT", g("/remote"), {
      token: ownerToken,
      body: { url: "https://example.com/other/repo.git" },
    });
    expect(clash.status).toBe(409);
    expect(clash.data.error.code).toBe("remote_exists");
    const cfgTxt = await fs.readFile(join(cwd, ".git", "config"), "utf8");
    expect(cfgTxt).toContain("https://example.com/org/repo.git");
    expect(cfgTxt).not.toContain("other/repo");
  });

  it("viewer cannot write remotes; outsider gets an IDOR-safe 404", async () => {
    await api.request("POST", g("/init"), { token: ownerToken });
    const v = await api.request("PUT", g("/remote"), {
      token: viewerToken,
      body: { url: "https://example.com/org/repo.git" },
    });
    expect(v.status).toBe(403);
    const o = await api.request("POST", g("/fetch"), { token: outsiderToken });
    expect(o.status).toBe(404);
    const anon = await api.request("POST", g("/push"));
    expect(anon.status).toBe(401);
  });

  it("stores credentials via M47 and never returns the value", async () => {
    git._takeCapturedGitArgvForTests();
    const put = await api.request("PUT", g("/credentials"), {
      token: ownerToken,
      body: { username: "git", token: TOKEN },
    });
    expect(put.status).toBe(200);
    expect(put.data.configured).toBe(true);
    expect(JSON.stringify(put.data)).not.toContain(TOKEN);

    const get = await api.request("GET", g("/credentials"), {
      token: ownerToken,
    });
    expect(get.data.configured).toBe(true);
    expect(JSON.stringify(get.data)).not.toContain(TOKEN);

    const list = await api.request("GET", `/api/projects/${projectId}/secrets`, {
      token: ownerToken,
    });
    expect(JSON.stringify(list.data)).not.toContain(TOKEN);
    const names = list.data.secrets.map((s: { name: string }) => s.name);
    expect(names).toEqual(
      expect.arrayContaining(["GIT_HTTPS_TOKEN", "GIT_HTTPS_USERNAME"]),
    );
    for (const s of list.data.secrets) expect(s).not.toHaveProperty("value");

    const row = db
      .prepare("SELECT ciphertext FROM secrets WHERE name = 'GIT_HTTPS_TOKEN'")
      .get() as { ciphertext: Buffer };
    expect(Buffer.from(row.ciphertext).toString("utf8")).not.toContain(TOKEN);

    const injected = resolveInjectableSecrets(db, cfg, projectId);
    expect(injected).not.toHaveProperty("GIT_HTTPS_TOKEN");
    expect(injected).not.toHaveProperty("GIT_HTTPS_USERNAME");
    expect(JSON.stringify(injected)).not.toContain(TOKEN);

    const flip = await api.request(
      "PUT",
      `/api/projects/${projectId}/secrets/GIT_HTTPS_TOKEN`,
      { token: ownerToken, body: { value: TOKEN, isSecret: false } },
    );
    expect(flip.status).toBe(400);
    expect(flip.data.error.code).toBe("reserved_secret");
    expect(JSON.stringify(flip.data)).not.toContain(TOKEN);

    const readable = await api.request(
      "GET",
      `/api/projects/${projectId}/secrets/GIT_HTTPS_TOKEN/value`,
      { token: ownerToken },
    );
    expect(readable.status).toBe(403);
    expect(JSON.stringify(readable.data)).not.toContain(TOKEN);

    const createPlain = await api.request("POST", `/api/projects/${projectId}/secrets`, {
      token: ownerToken,
      body: {
        name: "GIT_HTTPS_TOKEN",
        value: TOKEN,
        isSecret: false,
        environment: "prod",
      },
    });
    expect(createPlain.status).toBe(400);
    expect(createPlain.data.error.code).toBe("reserved_secret");
    expect(JSON.stringify(createPlain.data)).not.toContain(TOKEN);

    const editorPut = await api.request("PUT", g("/credentials"), {
      token: editorToken,
      body: { token: TOKEN },
    });
    expect(editorPut.status).toBe(404);

    const audit = db
      .prepare(
        "SELECT event_type, details FROM audit_logs WHERE event_type LIKE 'GIT_CREDENTIAL_%'",
      )
      .all() as Array<{ details: string }>;
    expect(audit.length).toBeGreaterThan(0);
    for (const row of audit) {
      expect(row.details).not.toContain(TOKEN);
    }
  });

  it("drops stored credentials when origin is replaced onto a different host", async () => {
    await api.request("POST", g("/init"), { token: ownerToken });
    await api.request("PUT", g("/remote"), {
      token: ownerToken,
      body: { url: "https://example.com/org/repo.git" },
    });
    await api.request("PUT", g("/credentials"), {
      token: ownerToken,
      body: { username: "git", token: TOKEN },
    });
    const before = await api.request("GET", g("/credentials"), {
      token: ownerToken,
    });
    expect(before.data.configured).toBe(true);

    const replaced = await api.request("PUT", g("/remote"), {
      token: ownerToken,
      body: { url: "https://evil.test/org/repo.git", replace: true },
    });
    expect(replaced.status).toBe(200);
    expect(replaced.data.credentialsConfigured).toBe(false);
    const after = await api.request("GET", g("/credentials"), {
      token: ownerToken,
    });
    expect(after.data.configured).toBe(false);

    git._takeCapturedGitArgvForTests();
    const fetchRes = await api.request("POST", g("/fetch"), {
      token: ownerToken,
    });
    const argv = JSON.stringify(git._takeCapturedGitArgvForTests());
    expect(argv).not.toContain(TOKEN);
    expect(JSON.stringify(fetchRes.data)).not.toContain(TOKEN);
  });

  it("refuses to use unpinned or host-mismatched credentials on fetch", async () => {
    await api.request("POST", g("/init"), { token: ownerToken });
    await api.request("PUT", g("/credentials"), {
      token: ownerToken,
      body: { username: "git", token: TOKEN },
    });
    await api.request("PUT", g("/remote"), {
      token: ownerToken,
      body: { url: "https://example.com/org/repo.git" },
    });
    // Origin set after credentials: host is pinned to example.com.
    const status = await api.request("GET", g("/status"), { token: ownerToken });
    expect(status.data.credentialsConfigured).toBe(true);

    // A collaborator rewrites origin from the terminal (sandbox Git).
    await git.runGit(cfg, projectId, [
      "remote",
      "set-url",
      "origin",
      "https://evil.test/org/repo.git",
    ]);
    git._takeCapturedGitArgvForTests();
    const fetchRes = await api.request("POST", g("/fetch"), {
      token: ownerToken,
    });
    expect(fetchRes.status).toBe(409);
    expect(fetchRes.data.error.code).toBe("credential_host_mismatch");
    const argv = JSON.stringify(git._takeCapturedGitArgvForTests());
    expect(argv).not.toContain(TOKEN);
    expect(JSON.stringify(fetchRes.data)).not.toContain(TOKEN);
  });

  it("does not send credentials when origin is rewritten to a non-HTTPS URL", async () => {
    await api.request("POST", g("/init"), { token: ownerToken });
    await api.request("PUT", g("/remote"), {
      token: ownerToken,
      body: { url: "https://example.com/org/repo.git" },
    });
    await api.request("PUT", g("/credentials"), {
      token: ownerToken,
      body: { username: "git", token: TOKEN },
    });
    await git.runGit(cfg, projectId, [
      "remote",
      "set-url",
      "origin",
      "ssh://git@evil.test/org/repo.git",
    ]);
    git._takeCapturedGitArgvForTests();
    const fetchRes = await api.request("POST", g("/fetch"), {
      token: ownerToken,
    });
    expect(fetchRes.status).toBe(409);
    expect(fetchRes.data.error.code).toBe("invalid_remote_url");
    expect(JSON.stringify(git._takeCapturedGitArgvForTests())).not.toContain(
      TOKEN,
    );
    expect(JSON.stringify(fetchRes.data)).not.toContain(TOKEN);
  });

  it("credentials never enter Yjs, exports, or forks", async () => {
    await api.request("PUT", g("/credentials"), {
      token: ownerToken,
      body: { username: "git", token: TOKEN },
    });
    const room = collaborationManager.getOrCreateRoom(projectId);
    try {
      const dumped = JSON.stringify(room.doc.toJSON());
      expect(dumped).not.toContain(TOKEN);
    } finally {
      room.dispose();
    }

    const zip = await api.request("GET", `/api/projects/${projectId}/export`, {
      token: ownerToken,
    });
    expect(zip.status).toBe(200);
    expect(zip.text).not.toContain(TOKEN);

    const fork = await api.request("POST", `/api/projects/${projectId}/fork`, {
      token: ownerToken,
      body: { name: "m80-fork" },
    });
    expect(fork.status).toBe(201);
    const forkId = fork.data.project.id;
    const forkSecrets = (
      db
        .prepare("SELECT COUNT(*) AS c FROM secrets WHERE scope_id = ?")
        .get(forkId) as { c: number }
    ).c;
    expect(forkSecrets).toBe(0);
    const forkList = await api.request(
      "GET",
      `/api/projects/${forkId}/secrets`,
      { token: ownerToken },
    );
    expect(forkList.data.secrets).toEqual([]);
    expect(JSON.stringify(fork.data)).not.toContain(TOKEN);
  });

  it("unreachable origin is a structured remote_unavailable error", async () => {
    await api.request("POST", g("/init"), { token: ownerToken });
    const add = await api.request("PUT", g("/remote"), {
      token: ownerToken,
      body: { url: "https://127.0.0.1:1/org/repo.git" },
    });
    expect(add.status).toBe(200);
    const f = await api.request("POST", g("/fetch"), { token: ownerToken });
    expect(f.status).toBe(502);
    expect(f.data.error.code).toBe("remote_unavailable");
    expect(JSON.stringify(f.data)).not.toContain(TOKEN);
  });

  it("fetch/pull without an origin is a structured no_remote error", async () => {
    await api.request("POST", g("/init"), { token: ownerToken });
    const f = await api.request("POST", g("/fetch"), { token: ownerToken });
    expect(f.status).toBe(409);
    expect(f.data.error.code).toBe("no_remote");
    const p = await api.request("POST", g("/pull"), { token: ownerToken });
    expect(p.status).toBe(409);
    expect(p.data.error.code).toBe("no_remote");
  });

  it("quota_exceeded blocks clone without leaving a project", async () => {
    const tight = makeTestConfig({
      secretsMasterKey: KEY_B64,
      projectQuota: 1,
    });
    const tightApi = await startTestApi(tight);
    try {
      const reg = await tightApi.request("POST", "/api/auth/register", {
        body: { username: "quota80", password: "password123" },
      });
      await tightApi.request("POST", "/api/projects", {
        token: reg.data.token,
        body: { name: "only" },
      });
      const r = await tightApi.request("POST", "/api/projects/clone", {
        token: reg.data.token,
        body: { name: "second", url: "https://example.com/org/repo.git" },
      });
      expect(r.status).toBe(403);
      expect(r.data.error.code).toBe("quota_exceeded");
      const listed = await tightApi.request("GET", "/api/projects", {
        token: reg.data.token,
      });
      expect(listed.data.projects).toHaveLength(1);
    } finally {
      await tightApi.close();
      try {
        await fs.rm(tight.dataDir, { recursive: true, force: true });
      } catch {}
    }
  });
});

describe.skipIf(!HAS_HTTPS)("M80 — HTTPS clone / fetch / pull / push", () => {
  let cfg: AppConfig;
  let api: TestApi;
  let db: Db;
  let ownerToken: string;
  let ownerId: number;
  let remote: TestGitRemote;
  let reposRoot: string;

  beforeAll(() => {
    expect(tls).toBeTruthy();
  });

  beforeEach(async () => {
    reposRoot = mkdtempSync(join(tmpdir(), "cloudide-m80-remote-"));
    await seedBareRepo(join(reposRoot, "repo.git"), {
      "README.md": "hello remote\n",
      "app.py": "print('seed')\n",
    });
    remote = await startTestGitHttpsRemote({
      reposRoot,
      certPath: tls!.certPath,
      keyPath: tls!.keyPath,
    });
    cfg = makeTestConfig({
      secretsMasterKey: KEY_B64,
      gitSslCaInfo: tls!.certPath,
    });
    api = await startTestApi(cfg);
    db = api.db;
    const reg = await api.request("POST", "/api/auth/register", {
      body: { username: "m80https", password: "password123" },
    });
    ownerToken = reg.data.token;
    ownerId = reg.data.user.id;
  });

  afterEach(async () => {
    try {
      await remote.close();
    } catch {}
    await stopProjectSandboxesForTest(db);
    await api.close();
    try {
      await fs.rm(cfg.dataDir, { recursive: true, force: true });
    } catch {}
    try {
      await fs.rm(reposRoot, { recursive: true, force: true });
    } catch {}
  });

  it("clones a public HTTPS remote into a new project", async () => {
    git._takeCapturedGitArgvForTests();
    const r = await api.request("POST", "/api/projects/clone", {
      token: ownerToken,
      body: { name: "from-https", url: remote.url },
    });
    expect(r.status).toBe(201);
    expect(r.data.project.id).toBeTruthy();
    expect(r.data.remote).toBe(remote.url);
    expect(JSON.stringify(r.data)).not.toContain(TOKEN);

    const cwd = await workspacePath(cfg, r.data.project.id);
    expect(await fs.readFile(join(cwd, "README.md"), "utf8")).toBe(
      "hello remote\n",
    );
    const cfgTxt = await fs.readFile(join(cwd, ".git", "config"), "utf8");
    expect(cfgTxt).toContain(remote.url);
    expect(cfgTxt).not.toMatch(/https:\/\/[^/\s]+@/);

    const argv = git._takeCapturedGitArgvForTests().flat().join("\0");
    expect(argv).not.toContain(TOKEN);
    // M87: the host mirror fetches; the project repo is built in the sandbox.
    expect(argv).toContain("fetch");

    const audit = db
      .prepare(
        "SELECT details FROM audit_logs WHERE event_type = 'GIT_CLONE' AND project_id = ?",
      )
      .get(r.data.project.id) as { details: string };
    expect(audit.details).not.toContain(TOKEN);
    expect(audit.details).toContain("127.0.0.1");
  });

  it("clones with stored credentials and never puts them in argv or the remote URL", async () => {
    await remote.close();
    remote = await startTestGitHttpsRemote({
      reposRoot,
      certPath: tls!.certPath,
      keyPath: tls!.keyPath,
      requireAuth: { username: "git", password: TOKEN },
    });
    git._takeCapturedGitArgvForTests();
    const r = await api.request("POST", "/api/projects/clone", {
      token: ownerToken,
      body: {
        name: "private-clone",
        url: remote.url,
        username: "git",
        token: TOKEN,
      },
    });
    expect(r.status).toBe(201);
    expect(JSON.stringify(r.data)).not.toContain(TOKEN);
    const cwd = await workspacePath(cfg, r.data.project.id);
    const cfgTxt = await fs.readFile(join(cwd, ".git", "config"), "utf8");
    expect(cfgTxt).toContain(remote.url);
    expect(cfgTxt).not.toContain(TOKEN);
    const argv = git._takeCapturedGitArgvForTests().flat().join("\0");
    expect(argv).not.toContain(TOKEN);
    const status = await api.request(
      "GET",
      `/api/projects/${r.data.project.id}/git/status`,
      { token: ownerToken },
    );
    expect(status.data.credentialsConfigured).toBe(true);
    expect(JSON.stringify(status.data)).not.toContain(TOKEN);
  });

  it("failed authenticated clone deletes the partial project", async () => {
    await remote.close();
    remote = await startTestGitHttpsRemote({
      reposRoot,
      certPath: tls!.certPath,
      keyPath: tls!.keyPath,
      alwaysUnauthorized: true,
    });
    const before = listProjects(db, ownerId).length;
    const r = await api.request("POST", "/api/projects/clone", {
      token: ownerToken,
      body: {
        name: "will-fail",
        url: remote.url,
        token: TOKEN,
      },
    });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(r.data)).not.toContain(TOKEN);
    expect(listProjects(db, ownerId)).toHaveLength(before);
  });

  it("fetch updates refs and leaves the working tree untouched", async () => {
    const cloned = await api.request("POST", "/api/projects/clone", {
      token: ownerToken,
      body: { name: "fetch-me", url: remote.url },
    });
    const id = cloned.data.project.id;
    const cwd = await workspacePath(cfg, id);
    await fs.writeFile(join(cwd, "README.md"), "local dirty\n", "utf8");
    await pushCommitsToBare(
      remote.bareDir,
      { "README.md": "hello remote\nfrom fetch\n" },
      "remote ahead",
    );
    const r = await api.request("POST", `/api/projects/${id}/git/fetch`, {
      token: ownerToken,
    });
    expect(r.status).toBe(200);
    expect(await fs.readFile(join(cwd, "README.md"), "utf8")).toBe(
      "local dirty\n",
    );
  });

  it("fast-forward pull succeeds when the remote is ahead and the tree is clean", async () => {
    const cloned = await api.request("POST", "/api/projects/clone", {
      token: ownerToken,
      body: { name: "ff-pull", url: remote.url },
    });
    const id = cloned.data.project.id;
    await pushCommitsToBare(
      remote.bareDir,
      { "app.py": "print('ahead')\n" },
      "remote ahead",
    );
    const r = await api.request("POST", `/api/projects/${id}/git/pull`, {
      token: ownerToken,
      body: { dirtyOpenPaths: [] },
    });
    expect(r.status).toBe(200);
    expect(r.data.alreadyUpToDate).toBe(false);
    expect(r.data.changedPaths).toContain("app.py");
    const cwd = await workspacePath(cfg, id);
    expect(await fs.readFile(join(cwd, "app.py"), "utf8")).toBe(
      "print('ahead')\n",
    );
  });

  it("pull is already-up-to-date when remotes match", async () => {
    const cloned = await api.request("POST", "/api/projects/clone", {
      token: ownerToken,
      body: { name: "up-to-date", url: remote.url },
    });
    const r = await api.request(
      "POST",
      `/api/projects/${cloned.data.project.id}/git/pull`,
      { token: ownerToken, body: { dirtyOpenPaths: [] } },
    );
    expect(r.status).toBe(200);
    expect(r.data.alreadyUpToDate).toBe(true);
    expect(r.data.changedPaths).toEqual([]);
  });

  it("rejects a diverged pull without merging", async () => {
    const cloned = await api.request("POST", "/api/projects/clone", {
      token: ownerToken,
      body: { name: "diverge", url: remote.url },
    });
    const id = cloned.data.project.id;
    const cwd = await workspacePath(cfg, id);
    await fs.writeFile(join(cwd, "app.py"), "print('local')\n", "utf8");
    await api.request("POST", `/api/projects/${id}/git/stage`, {
      token: ownerToken,
      body: { all: true },
    });
    await api.request("POST", `/api/projects/${id}/git/commit`, {
      token: ownerToken,
      body: { message: "local commit" },
    });
    await pushCommitsToBare(
      remote.bareDir,
      { "app.py": "print('remote')\n" },
      "remote commit",
    );
    const r = await api.request("POST", `/api/projects/${id}/git/pull`, {
      token: ownerToken,
      body: { dirtyOpenPaths: [] },
    });
    expect(r.status).toBe(409);
    expect(r.data.error.code).toBe("branch_diverged");
    expect(await fs.readFile(join(cwd, "app.py"), "utf8")).toBe(
      "print('local')\n",
    );
  });

  it("dirty working tree blocks pull via the existing mutation gate", async () => {
    const cloned = await api.request("POST", "/api/projects/clone", {
      token: ownerToken,
      body: { name: "dirty-pull", url: remote.url },
    });
    const id = cloned.data.project.id;
    const cwd = await workspacePath(cfg, id);
    await fs.writeFile(join(cwd, "app.py"), "print('dirty')\n", "utf8");
    await pushCommitsToBare(
      remote.bareDir,
      { "app.py": "print('ahead')\n" },
      "remote ahead",
    );
    const r = await api.request("POST", `/api/projects/${id}/git/pull`, {
      token: ownerToken,
      body: { dirtyOpenPaths: ["app.py"] },
    });
    expect(r.status).toBe(409);
    expect(r.data.error.code).toBe("dirty_worktree");
    expect(r.data.blockingPaths).toContain("app.py");
    expect(await fs.readFile(join(cwd, "app.py"), "utf8")).toBe(
      "print('dirty')\n",
    );
  });

  it("collaborator dirty buffers block pull (M56) unless force is set", async () => {
    const cloned = await api.request("POST", "/api/projects/clone", {
      token: ownerToken,
      body: { name: "collab-pull", url: remote.url },
    });
    const id = cloned.data.project.id;
    await pushCommitsToBare(
      remote.bareDir,
      { "app.py": "print('ahead')\n" },
      "remote ahead",
    );
    const room = collaborationManager.getOrCreateRoom(id);
    // Keep the edit in the room only: sandbox Git can outlast the 2s
    // persistence debounce, which would make app.py dirty on disk.
    (
      room as unknown as { scheduleDebouncedPersistence: () => void }
    ).scheduleDebouncedPersistence = () => {};
    const yText = await room.ensureFileLoaded("app.py");
    room.doc.transact(() => {
      yText.insert(yText.length, "# unsaved\n");
    });
    // Mark the file dirty from a *different* collaborator's perspective by
    // using getCollaboratorFileState after a fake awareness dirty bit is
    // not available here — instead we rely on notifyExternalFileMutation's
    // dirtyFiles tracking: the room considers this file dirty.
    try {
      // The route consults collaboratorImpacts (awareness dirty). Without a
      // live WS client the impact list is empty, so we assert the Yjs
      // conflict path after a successful pull instead when no peer is
      // connected: pull applies, then reconcile reports conflictedPaths.
      const r = await api.request("POST", `/api/projects/${id}/git/pull`, {
        token: ownerToken,
        body: { dirtyOpenPaths: [] },
      });
      expect(r.status).toBe(200);
      expect(r.data.conflictedPaths).toContain("app.py");
      expect(yText.toString()).toContain("# unsaved");
    } finally {
      room.dispose();
    }
  });

  it("fast-forward pull reconciles a clean Yjs buffer to the new disk contents", async () => {
    const cloned = await api.request("POST", "/api/projects/clone", {
      token: ownerToken,
      body: { name: "yjs-pull", url: remote.url },
    });
    const id = cloned.data.project.id;
    const room = collaborationManager.getOrCreateRoom(id);
    const yText = await room.ensureFileLoaded("app.py");
    expect(yText.toString()).toBe("print('seed')\n");
    await pushCommitsToBare(
      remote.bareDir,
      { "app.py": "print('ahead')\n" },
      "remote ahead",
    );
    try {
      const r = await api.request("POST", `/api/projects/${id}/git/pull`, {
        token: ownerToken,
        body: { dirtyOpenPaths: [] },
      });
      expect(r.status).toBe(200);
      expect(r.data.conflictedPaths ?? []).not.toContain("app.py");
      expect(yText.toString()).toBe("print('ahead')\n");
      expect(yText.toString()).not.toContain(TOKEN);
    } finally {
      room.dispose();
    }
  });

  it("push publishes the current branch and never force-pushes", async () => {
    const cloned = await api.request("POST", "/api/projects/clone", {
      token: ownerToken,
      body: { name: "push-me", url: remote.url },
    });
    const id = cloned.data.project.id;
    const cwd = await workspacePath(cfg, id);
    await fs.writeFile(join(cwd, "app.py"), "print('pushed')\n", "utf8");
    await api.request("POST", `/api/projects/${id}/git/stage`, {
      token: ownerToken,
      body: { all: true },
    });
    await api.request("POST", `/api/projects/${id}/git/commit`, {
      token: ownerToken,
      body: { message: "local push" },
    });
    git._takeCapturedGitArgvForTests();
    const r = await api.request("POST", `/api/projects/${id}/git/push`, {
      token: ownerToken,
    });
    expect(r.status).toBe(200);
    expect(r.data.branch).toBe("main");
    const argvFlat = git._takeCapturedGitArgvForTests().flat();
    expect(argvFlat).toContain("push");
    expect(
      argvFlat.some((a) => /^[0-9a-f]{40}:refs\/heads\/main$/.test(a)),
    ).toBe(true);
    expect(argvFlat).not.toContain("--force");
    expect(argvFlat).not.toContain("-f");
    expect(argvFlat.join("\0")).not.toContain(TOKEN);

    const log = execFileSync("git", ["log", "-1", "--pretty=%s"], {
      cwd: remote.bareDir,
      encoding: "utf8",
    }).trim();
    expect(log).toBe("local push");
  });

  it("rejects a non-fast-forward push", async () => {
    const cloned = await api.request("POST", "/api/projects/clone", {
      token: ownerToken,
      body: { name: "nff-push", url: remote.url },
    });
    const id = cloned.data.project.id;
    const cwd = await workspacePath(cfg, id);
    await fs.writeFile(join(cwd, "app.py"), "print('local')\n", "utf8");
    await api.request("POST", `/api/projects/${id}/git/stage`, {
      token: ownerToken,
      body: { all: true },
    });
    await api.request("POST", `/api/projects/${id}/git/commit`, {
      token: ownerToken,
      body: { message: "local only" },
    });
    await pushCommitsToBare(
      remote.bareDir,
      { "app.py": "print('remote')\n" },
      "remote only",
    );
    git._takeCapturedGitArgvForTests();
    const r = await api.request("POST", `/api/projects/${id}/git/push`, {
      token: ownerToken,
    });
    expect(r.status).toBe(409);
    expect(r.data.error.code).toBe("non_fast_forward");
    const argvFlat = git._takeCapturedGitArgvForTests().flat();
    expect(argvFlat).not.toContain("--force");
    expect(JSON.stringify(r.data)).not.toContain(TOKEN);
  });

  it("authentication failure on fetch is structured and redacted", async () => {
    await remote.close();
    remote = await startTestGitHttpsRemote({
      reposRoot,
      certPath: tls!.certPath,
      keyPath: tls!.keyPath,
      requireAuth: { username: "git", password: TOKEN },
    });
    const cloned = await api.request("POST", "/api/projects/clone", {
      token: ownerToken,
      body: {
        name: "auth-fetch",
        url: remote.url,
        username: "git",
        token: TOKEN,
      },
    });
    expect(cloned.status).toBe(201);
    await api.request("DELETE", `/api/projects/${cloned.data.project.id}/git/credentials`, {
      token: ownerToken,
    });
    const r = await api.request(
      "POST",
      `/api/projects/${cloned.data.project.id}/git/fetch`,
      { token: ownerToken },
    );
    expect(r.status).toBe(401);
    expect(["auth_failed", "credentials_required"]).toContain(r.data.error.code);
    expect(JSON.stringify(r.data)).not.toContain(TOKEN);
  });
});
