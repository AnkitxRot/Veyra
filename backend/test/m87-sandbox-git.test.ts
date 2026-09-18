/**
 * M87 — sandbox Git: boundary, transport, lifecycle, and confinement.
 *
 *  - argv / project binding invariants of the sandbox runner;
 *  - the host transport never reads the project repository and the PAT
 *    never enters the sandbox (proxy trap, credential helper, /proc scan);
 *  - a malicious remote cannot make the API echo the PAT (redaction);
 *  - pushed objects are fsck'd / connectivity-checked before leaving;
 *  - timeouts kill Git inside the container; sandbox teardown mid-operation
 *    fails fast and releases the project lock; reads run beside writes;
 *  - workspace replacement cannot leave a sandbox on the old directory;
 *  - host file I/O is confined even when the sandbox swaps symlinks between
 *    the path check and the open (Linux: symlinks from the container are
 *    real symlinks on the host).
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
  promises as fs,
} from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { sandboxGitAvailable } from "./helpers.js";
import { makeM87Fixture, type M87Fixture } from "./m87-fixture.js";
import {
  generateSelfSignedTls,
  seedBareRepo,
  startTestGitHttpsRemote,
  type TestGitRemote,
} from "./git-https-remote.js";
import * as git from "../src/git/service.js";
import {
  assertGitProjectId,
  sandboxGitArgv,
  setSandboxGitTimeoutForTests,
  _takeCapturedSandboxGitArgvForTests,
} from "../src/git/sandboxGit.js";
import { mirrorDir } from "../src/git/transport.js";
import { sandboxManager } from "../src/execution/sandbox.js";
import { collaborationManager } from "../src/collab/manager.js";
import {
  readConfinedFile,
  writeConfinedFile,
  setConfinedPortableCheckForTests,
} from "../src/files/confined.js";
import { readProjectFile, writeProjectFile } from "../src/files/service.js";
import { makeTestConfig, startTestApi } from "./helpers.js";
import { createProject } from "../src/projects/service.js";

const execFileAsync = promisify(execFile);
const SANDBOX_GIT = sandboxGitAvailable();
const LINUX = process.platform === "linux";
const KEY_B64 = Buffer.alloc(32, 9).toString("base64");
const TOKEN = "m87-pat-DO-NOT-LEAK-4c1e9b";
/** Matches TOKEN without containing it (so a scanner cannot match itself). */
const TOKEN_RE = "m8[7]-pat-DO-NOT-LEAK-4c1e9b";

function hostGitAvailable(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
const tlsDir = mkdtempSync(join(tmpdir(), "cloudide-m87-tls-"));
let tls: { certPath: string; keyPath: string } | null = null;
try {
  tls = generateSelfSignedTls(tlsDir);
} catch {
  tls = null;
}
const HTTPS = SANDBOX_GIT && hostGitAvailable() && tls !== null;

// ---------------------------------------------------------------------------
// Runner invariants (no Docker needed)
// ---------------------------------------------------------------------------

describe("M87 sandbox Git runner invariants", () => {
  it("builds a docker exec that isolates env, pins the repo, and bounds time", () => {
    const argv = sandboxGitArgv("ide-sandbox-abc", ["status"], {
      timeoutMs: 15_000,
    });
    expect(argv.slice(0, 7)).toEqual([
      "exec",
      "-i",
      "-u",
      "ide",
      "-w",
      "/workspace",
      "ide-sandbox-abc",
    ]);
    const envAt = argv.indexOf("/usr/bin/env");
    expect(argv[envAt + 1]).toBe("-i");
    const tAt = argv.indexOf("/usr/bin/timeout");
    expect(tAt).toBeGreaterThan(envAt);
    expect(argv.slice(tAt, tAt + 5)).toEqual([
      "/usr/bin/timeout",
      "-s",
      "KILL",
      "15",
      "/usr/bin/git",
    ]);
    const envVars = argv.slice(envAt + 2, tAt);
    expect(envVars).toEqual(
      expect.arrayContaining([
        "GIT_DIR=/workspace/.git",
        "GIT_WORK_TREE=/workspace",
        "GIT_CONFIG_GLOBAL=/dev/null",
        "GIT_ALLOW_PROTOCOL=",
        "HOME=/tmp",
      ]),
    );
    // Only fixed NAME=value pairs between env -i and timeout.
    for (const v of envVars) expect(v).toMatch(/^[A-Z_]+=/);
    expect(argv.slice(tAt + 5)).toEqual(
      expect.arrayContaining(["core.hooksPath=/dev/null", "core.fsmonitor=false"]),
    );
    expect(argv[argv.length - 1]).toBe("status");
  });

  it("rejects project ids that could address another container", () => {
    for (const bad of ["", "../x", "a b", "x;y", "-rf", "a/b", "é"]) {
      expect(() => assertGitProjectId(bad)).toThrow();
    }
    expect(() => assertGitProjectId("3f0e7c1a-1d2b-4c5d-9e8f-001122334455")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Project binding, lifecycle, bounds
// ---------------------------------------------------------------------------

describe.skipIf(!SANDBOX_GIT)("M87 sandbox Git lifecycle", () => {
  let f: M87Fixture;

  beforeEach(async () => {
    f = await makeM87Fixture();
    expect(
      (await f.api.request("POST", f.g("/init"), { token: f.ownerToken })).status,
    ).toBe(200);
    await f.plantPayload();
  });

  afterEach(async () => {
    setSandboxGitTimeoutForTests(null);
    await f.close();
  });

  const post = (p: string, body: unknown = {}) =>
    f.api.request("POST", f.g(p), { token: f.editorToken, body });
  const get = (p: string) =>
    f.api.request("GET", f.g(p), { token: f.editorToken });

  it("every Git process runs in this project's container as ide", async () => {
    _takeCapturedSandboxGitArgvForTests();
    await f.sh("echo a > a.txt");
    expect((await post("/stage", { all: true })).status).toBe(200);
    expect((await post("/commit", { message: "x" })).status).toBe(200);
    expect((await get("/status")).status).toBe(200);
    const all = _takeCapturedSandboxGitArgvForTests();
    expect(all.length).toBeGreaterThan(3);
    for (const argv of all) {
      expect(argv[0]).toBe("exec");
      expect(argv[argv.indexOf("-u") + 1]).toBe("ide");
      expect(argv[6]).toBe(`ide-sandbox-${f.projectId}`);
      expect(argv).toContain("/usr/bin/timeout");
      expect(argv.join(" ")).not.toContain(f.cwd);
    }
  });

  it("a Git call for a deleted project fails closed and starts no container", async () => {
    await sandboxManager.stopProjectSandbox(f.projectId);
    const del = await f.api.request("DELETE", `/api/projects/${f.projectId}`, {
      token: f.ownerToken,
    });
    expect([200, 204]).toContain(del.status);
    await expect(git.getStatus(f.cfg, f.projectId)).resolves.toMatchObject({
      initialized: false,
    });
    await expect(git.runGit(f.cfg, f.projectId, ["status"])).rejects.toMatchObject(
      { status: 404 },
    );
    expect(sandboxManager.hasActiveSandbox(f.projectId)).toBe(false);
    expect(existsSync(mirrorDir(f.cfg, f.projectId))).toBe(false);
  });

  it("a config without a registered owner resolver never runs Git", async () => {
    const other = makeTestConfig();
    try {
      await fs.mkdir(join(other.workspacesDir, f.projectId), { recursive: true });
      await expect(
        git.runGit(other, f.projectId, ["status"]),
      ).rejects.toMatchObject({ status: 404 });
    } finally {
      await fs.rm(other.dataDir, { recursive: true, force: true });
    }
  });

  it("a timeout kills Git and its filter inside the container and frees the lock", async () => {
    setSandboxGitTimeoutForTests(3000);
    await f.sh(
      `git config filter.slow.clean "sleep 47; cat" && printf 'slow.txt filter=slow\\n' > .gitattributes && echo s > slow.txt`,
    );
    const t0 = Date.now();
    const r = await post("/stage", { all: true });
    expect(r.status).toBe(504);
    expect(r.data.error.code).toBe("git_timeout");
    expect(Date.now() - t0).toBeLessThan(12_000);
    const procs = await f.sh(
      "for p in /proc/[0-9]*; do tr '\\0' ' ' < $p/cmdline 2>/dev/null; echo; done",
    );
    expect(procs).not.toContain("sleep 47");
    setSandboxGitTimeoutForTests(null);
    // The project lock was released: another write proceeds.
    await f.sh("rm .gitattributes && git config --unset filter.slow.clean");
    expect((await post("/stage", { all: true })).status).toBe(200);
  });

  it("sandbox teardown during Git fails fast and releases the lock", async () => {
    await f.sh(
      `git config filter.slow.clean "sleep 53; cat" && printf 'slow.txt filter=slow\\n' > .gitattributes && echo s > slow.txt`,
    );
    const t0 = Date.now();
    const pending = post("/stage", { all: true });
    // Wait until the filter is really running inside the container.
    for (let i = 0; i < 60; i++) {
      const ps = await f.sh(
        "for p in /proc/[0-9]*; do tr '\\0' ' ' < $p/cmdline 2>/dev/null; echo; done",
      );
      if (ps.includes("sleep 53")) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    await sandboxManager.stopProjectSandbox(f.projectId);
    const r = await pending;
    expect(r.status).toBe(503);
    expect(r.data.error.code).toBe("git_unavailable");
    expect(Date.now() - t0).toBeLessThan(20_000);
    // A fresh container serves the next locked operation, and the index
    // lock the killed Git left behind was cleared.
    await f.sh("rm .gitattributes && git config --unset filter.slow.clean");
    expect((await post("/stage", { all: true })).status).toBe(200);
  });

  it("output from repository-controlled textconv is bounded", async () => {
    // The first line differs per version; the 14 MB second line lands in
    // the diff context.
    await f.sh("cat > .m87/big.sh", {
      input: 'cat "$1"\nhead -c 14000000 /dev/zero | tr "\\0" a\necho\n',
    });
    await f.sh(
      `git config diff.big.textconv "sh .m87/big.sh" ` +
        `&& printf 'big.txt diff=big\\n' > .gitattributes && echo 1 > big.txt ` +
        "&& git add -A && git -c user.name=t -c user.email=t@t commit -qm b && echo 2 > big.txt",
    );
    const r = await get("/diff/file?path=big.txt");
    expect(r.status).toBe(413);
    expect(r.data.error.code).toBe("git_output_too_large");
  });

  it("status reads run beside serialized writes without lock errors", async () => {
    const writes = (async () => {
      const out: number[] = [];
      for (let i = 0; i < 4; i++) {
        await f.sh(`echo ${i} > w${i}.txt`);
        out.push((await post("/stage", { all: true })).status);
        out.push((await post("/commit", { message: `w${i}` })).status);
      }
      return out;
    })();
    const reads = (async () => {
      const out: number[] = [];
      for (let i = 0; i < 12; i++) out.push((await get("/status")).status);
      return out;
    })();
    const [w, rd] = await Promise.all([writes, reads]);
    expect(w.every((s) => s === 200)).toBe(true);
    expect(rd.every((s) => s === 200)).toBe(true);
    const log = await get("/log");
    expect(log.data.commits).toHaveLength(4);
  });

  it("a workspace restore cannot leave a sandbox bound to the old directory", async () => {
    const { createWorkspaceBackup } = await import(
      "../src/backup/workspaceBackup.js"
    );
    const { restoreWorkspaceBackup } = await import(
      "../src/backup/workspaceRestore.js"
    );
    await f.sh("echo before > keep.txt");
    const backup = await createWorkspaceBackup(f.cfg, f.db, f.projectId);
    await f.sh("echo after > keep.txt");
    // Right after restore's own pre-swap stop, a Git read (which takes no
    // restore lock) recreates the container on the directory that is about
    // to be swapped out.
    const realStop = sandboxManager.stopProjectSandbox.bind(sandboxManager);
    let stops = 0;
    const spy = vi
      .spyOn(sandboxManager, "stopProjectSandbox")
      .mockImplementation(async (id: string) => {
        await realStop(id);
        if (id === f.projectId && ++stops === 1) {
          await git.getStatus(f.cfg, f.projectId).catch(() => {});
          expect(sandboxManager.hasActiveSandbox(f.projectId)).toBe(true);
        }
      });
    try {
      await restoreWorkspaceBackup(f.cfg, f.db, f.projectId, backup.filename, {
        force: true,
      });
    } finally {
      spy.mockRestore();
    }
    expect(stops).toBeGreaterThanOrEqual(1);
    expect(sandboxManager.hasActiveSandbox(f.projectId)).toBe(false);
    // The next sandbox sees the restored workspace.
    expect((await f.sh("cat keep.txt")).trim()).toBe("before");
  });

  it("the transport mirror lives outside the workspace and the container", async () => {
    const m = mirrorDir(f.cfg, f.projectId);
    expect(relative(f.cwd, m).startsWith("..")).toBe(true);
    const seen = await f.sh(
      "find / -xdev -name 'git-transport' 2>/dev/null; ls -a /workspace",
    );
    expect(seen).not.toContain("git-transport");
  });
});

// ---------------------------------------------------------------------------
// Host transport: credentials and repository config
// ---------------------------------------------------------------------------

describe.skipIf(!HTTPS)("M87 host transport never trusts the project repository", () => {
  let f: M87Fixture;
  let remote: TestGitRemote;
  let reposRoot: string;
  let trap: Server;
  let trapHits = 0;

  beforeAll(() => {
    expect(tls).toBeTruthy();
  });

  beforeEach(async () => {
    reposRoot = mkdtempSync(join(tmpdir(), "cloudide-m87-remote-"));
    await seedBareRepo(join(reposRoot, "repo.git"), {
      "README.md": "hello\n",
    });
    remote = await startTestGitHttpsRemote({
      reposRoot,
      certPath: tls!.certPath,
      keyPath: tls!.keyPath,
      requireAuth: { username: "git", password: TOKEN },
    });
    trapHits = 0;
    trap = createHttpServer((_req, res) => {
      trapHits++;
      res.end();
    });
    trap.on("connect", (_req, socket) => {
      trapHits++;
      socket.destroy();
    });
    await new Promise<void>((r) => trap.listen(0, "127.0.0.1", r));
    f = await makeM87Fixture({
      secretsMasterKey: KEY_B64,
      gitSslCaInfo: tls!.certPath,
    });
  });

  afterEach(async () => {
    await f.close();
    await remote.close().catch(() => {});
    await new Promise<void>((r) => trap.close(() => r()));
    await fs.rm(reposRoot, { recursive: true, force: true }).catch(() => {});
  });

  async function cloneWithToken(): Promise<M87Fixture> {
    // Clone into a fresh project through the public API, then point the
    // fixture helpers at it.
    const r = await f.api.request("POST", "/api/projects/clone", {
      token: f.ownerToken,
      body: { name: "m87-clone", url: remote.url, username: "git", token: TOKEN },
    });
    expect(r.status).toBe(201);
    const id = r.data.project.id as string;
    const cwd = join(f.cfg.workspacesDir, id);
    const sh = async (script: string) => {
      const cid = await sandboxManager.ensureProjectSandbox(
        id,
        f.cfg,
        cwd,
        f.ownerId,
      );
      const { stdout } = await execFileAsync(
        "docker",
        ["exec", "-u", "ide", "-w", "/workspace", cid, "sh", "-c", `umask 0; ${script}`],
        { encoding: "utf8" },
      );
      return stdout;
    };
    await sh(
      `mkdir -p .m87 .git/info && printf '.m87/\\n' >> .git/info/exclude`,
    );
    return {
      ...f,
      projectId: id,
      cwd,
      g: (p: string) => `/api/projects/${id}/git${p}`,
      sh: async (s: string) => sh(s),
    };
  }

  it("fetch and push ignore proxy, TLS, askpass, and helper settings planted in the project", async () => {
    const p = await cloneWithToken();
    const host = remote.url.replace(/\/repo\.git$/, "");
    await p.sh(
      [
        `git config http.proxy http://127.0.0.1:${(trap.address() as { port: number }).port}`,
        `git config "http.${host}/.proxy" http://127.0.0.1:${(trap.address() as { port: number }).port}`,
        "git config http.sslVerify false",
        `git config credential.helper "!sh -c 'echo x > ${f.hostMarker}'"`,
        `git config core.askPass "sh -c 'echo x > ${f.hostMarker}'"`,
        `git config remote.origin.uploadpack "sh -c 'echo x > ${f.hostMarker}'"`,
        `git config remote.origin.receivepack "sh -c 'echo x > ${f.hostMarker}'"`,
        `git config core.sshCommand "sh -c 'echo x > ${f.hostMarker}'"`,
        `git config http.extraHeader "X-Leak: yes"`,
        "echo change >> README.md",
        "git add -A && git -c user.name=t -c user.email=t@t commit -qm local",
      ].join(" && "),
    );
    // The backend process's own Git environment is poisoned too: the host
    // transport must build its environment from scratch.
    const trapUrl = `http://127.0.0.1:${(trap.address() as { port: number }).port}`;
    const poisoned = join(f.cfg.dataDir, "poisoned.gitconfig");
    writeFileSync(poisoned, `[http]\n\tproxy = ${trapUrl}\n`);
    const saved = {
      GIT_CONFIG_PARAMETERS: process.env.GIT_CONFIG_PARAMETERS,
      GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
      HTTPS_PROXY: process.env.HTTPS_PROXY,
    };
    process.env.GIT_CONFIG_PARAMETERS = `'http.proxy'='${trapUrl}'`;
    process.env.GIT_CONFIG_GLOBAL = poisoned;
    process.env.HTTPS_PROXY = trapUrl;
    let fetched, pushed;
    try {
      fetched = await f.api.request("POST", p.g("/fetch"), {
        token: f.ownerToken,
      });
      pushed = await f.api.request("POST", p.g("/push"), {
        token: f.ownerToken,
      });
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
    expect(fetched.status).toBe(200);
    expect(pushed.status).toBe(200);
    expect(trapHits).toBe(0);
    expect(f.hostRan()).toBe(false);
    const log = execFileSync("git", ["log", "-1", "--pretty=%s"], {
      cwd: remote.bareDir,
      encoding: "utf8",
    }).trim();
    expect(log).toBe("local");
    // Upstream bookkeeping landed in the project repository.
    expect(
      (await p.sh("git rev-parse --abbrev-ref main@{upstream}")).trim(),
    ).toBe("origin/main");
  });

  it("the PAT never enters the sandbox, argv, responses, or audit logs", async () => {
    const p = await cloneWithToken();
    await p.sh(
      "echo more >> README.md && git add -A && git -c user.name=t -c user.email=t@t commit -qm scanned",
    );
    // A collaborator's background process scans everything it can read.
    const scan =
      `rm -f .m87/stop; : > .m87/leak; end=$(( $(date +%s) + 40 )); ` +
      `while [ $(date +%s) -lt $end ] && [ ! -f .m87/stop ]; do ` +
      `grep -a -l -E '${TOKEN_RE}' /proc/[0-9]*/environ /proc/[0-9]*/cmdline 2>/dev/null >> .m87/leak; ` +
      `grep -r -a -l -E '${TOKEN_RE}' /tmp /run /workspace/.git /home 2>/dev/null >> .m87/leak; ` +
      `done; echo done >> .m87/leak`;
    const scanner = p.sh(scan);
    _takeCapturedSandboxGitArgvForTests();
    const fetched = await f.api.request("POST", p.g("/fetch"), {
      token: f.ownerToken,
    });
    const pushed = await f.api.request("POST", p.g("/push"), {
      token: f.ownerToken,
    });
    const pulled = await f.api.request("POST", p.g("/pull"), {
      token: f.ownerToken,
      body: { dirtyOpenPaths: [] },
    });
    await p.sh("touch .m87/stop");
    await scanner;
    expect([fetched.status, pushed.status, pulled.status]).toEqual([200, 200, 200]);
    const leak = await p.sh("cat .m87/leak");
    expect(leak.trim()).toBe("done");
    const argv = JSON.stringify(git._takeCapturedGitArgvForTests());
    expect(argv).not.toContain(TOKEN);
    for (const r of [fetched, pushed, pulled]) {
      expect(r.text).not.toContain(TOKEN);
    }
    const audit = JSON.stringify(
      f.db.prepare("SELECT details FROM audit_logs").all(),
    );
    expect(audit).not.toContain(TOKEN);
    expect(readFileSync(join(p.cwd, ".git", "config"), "utf8")).not.toContain(TOKEN);
  });

  it("a remote that reflects the password back gets it redacted", async () => {
    const p = await cloneWithToken();
    await remote.close();
    const cert = readFileSync(tls!.certPath);
    const key = readFileSync(tls!.keyPath);
    const pkt = (s: string) =>
      (s.length + 4).toString(16).padStart(4, "0") + s;
    const evil = createHttpsServer({ cert, key }, (req, res) => {
      const auth = req.headers.authorization ?? "";
      if (!auth.startsWith("Basic ")) {
        res.writeHead(401, { "WWW-Authenticate": 'Basic realm="git"' });
        res.end();
        return;
      }
      const pass = Buffer.from(auth.slice(6), "base64").toString().split(":")[1];
      res.writeHead(200, {
        "Content-Type": "application/x-git-upload-pack-advertisement",
      });
      res.end(
        pkt("# service=git-upload-pack\n") + "0000" + pkt(`ERR leaked ${pass}\n`),
      );
    });
    const port = await new Promise<number>((r) =>
      evil.listen(0, "127.0.0.1", () =>
        r((evil.address() as { port: number }).port),
      ),
    );
    try {
      // Same host (127.0.0.1), so the pinned credentials apply.
      await p.sh(`git remote set-url origin https://127.0.0.1:${port}/repo.git`);
      const r = await f.api.request("POST", p.g("/fetch"), {
        token: f.ownerToken,
      });
      expect(r.status).toBeGreaterThanOrEqual(400);
      expect(r.text).not.toContain(TOKEN);
      expect(r.text).toContain("leaked ***");
    } finally {
      await new Promise<void>((r) => evil.close(() => r()));
    }
  });

  it("a malformed commit is caught by the host fsck and never pushed", async () => {
    const p = await cloneWithToken();
    // A well-formed pack carrying a commit object git's fsck rejects.
    await p.sh(
      "tree=$(git rev-parse HEAD^{tree}) && parent=$(git rev-parse HEAD) " +
        "&& sha=$(printf 'tree %s\\nparent %s\\nauthor nobody\\ncommitter nobody\\n\\nbad\\n' $tree $parent " +
        "| git hash-object -t commit -w --literally --stdin) " +
        "&& git update-ref refs/heads/main $sha",
    );
    const before = execFileSync("git", ["rev-parse", "main"], {
      cwd: remote.bareDir,
      encoding: "utf8",
    }).trim();
    const r = await f.api.request("POST", p.g("/push"), {
      token: f.ownerToken,
    });
    expect(r.status).toBe(422);
    expect(r.text).not.toContain(TOKEN);
    const after = execFileSync("git", ["rev-parse", "main"], {
      cwd: remote.bareDir,
      encoding: "utf8",
    }).trim();
    expect(after).toBe(before);
  });

  it("a corrupted local object is refused before anything is pushed", async () => {
    const p = await cloneWithToken();
    await p.sh(
      "echo corrupt >> README.md && git add -A && git -c user.name=t -c user.email=t@t commit -qm bad " +
        "&& blob=$(git rev-parse HEAD:README.md) " +
        '&& f=.git/objects/$(echo $blob | cut -c1-2)/$(echo $blob | cut -c3-) ' +
        '&& chmod u+w "$f" && printf "garbage" > "$f"',
    );
    const before = execFileSync("git", ["rev-parse", "main"], {
      cwd: remote.bareDir,
      encoding: "utf8",
    }).trim();
    const r = await f.api.request("POST", p.g("/push"), {
      token: f.ownerToken,
    });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.status).not.toBe(401);
    const after = execFileSync("git", ["rev-parse", "main"], {
      cwd: remote.bareDir,
      encoding: "utf8",
    }).trim();
    expect(after).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Confined host file I/O (the M86-deferred symlink swap)
// ---------------------------------------------------------------------------

describe.skipIf(!LINUX)("M87 confined workspace file I/O", () => {
  let base: string;
  let root: string;
  let outside: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "cloudide-m87-confined-"));
    root = join(base, "ws");
    outside = join(base, "host");
    mkdirSync(join(root, "dir"), { recursive: true });
    mkdirSync(join(root, ".git"), { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "secret.txt"), "HOST SECRET\n");
    writeFileSync(join(root, "dir", "ok.txt"), "inside\n");
  });

  afterEach(async () => {
    setConfinedPortableCheckForTests(false);
    vi.restoreAllMocks();
    await fs.rm(base, { recursive: true, force: true });
  });

  for (const portable of [false, true]) {
    const mode = portable ? "identity check" : "/proc check";

    it(`[${mode}] refuses reads and writes through a swapped-in directory symlink`, async () => {
      setConfinedPortableCheckForTests(portable);
      symlinkSync(outside, join(root, "evil"));
      await expect(
        readConfinedFile(root, join(root, "evil", "secret.txt")),
      ).rejects.toMatchObject({ code: "invalid_path" });
      await expect(
        writeConfinedFile(root, join(root, "evil", "secret.txt"), "pwned"),
      ).rejects.toMatchObject({ code: "invalid_path" });
      expect(readFileSync(join(outside, "secret.txt"), "utf8")).toBe(
        "HOST SECRET\n",
      );
    });

    it(`[${mode}] never follows a final symlink out of the workspace`, async () => {
      setConfinedPortableCheckForTests(portable);
      symlinkSync(join(outside, "secret.txt"), join(root, "to-secret"));
      symlinkSync(join(outside, "new.txt"), join(root, "dangling"));
      await expect(
        writeConfinedFile(root, join(root, "to-secret"), "pwned"),
      ).rejects.toMatchObject({ code: "invalid_path" });
      await expect(
        writeConfinedFile(root, join(root, "dangling"), "pwned"),
      ).rejects.toBeTruthy();
      expect(readFileSync(join(outside, "secret.txt"), "utf8")).toBe(
        "HOST SECRET\n",
      );
      expect(existsSync(join(outside, "new.txt"))).toBe(false);
    });

    it(`[${mode}] refuses a symlink into .git and allows in-workspace symlinks`, async () => {
      setConfinedPortableCheckForTests(portable);
      writeFileSync(join(root, ".git", "config"), "[core]\n");
      symlinkSync(join(root, ".git"), join(root, "g"));
      await expect(
        writeConfinedFile(root, join(root, "g", "config"), "[filter]"),
      ).rejects.toMatchObject({ code: "invalid_path" });
      symlinkSync(join(root, "dir", "ok.txt"), join(root, "alias.txt"));
      await writeConfinedFile(root, join(root, "alias.txt"), "via alias\n");
      expect(
        (await readConfinedFile(root, join(root, "alias.txt"))).content,
      ).toBe("via alias\n");
      expect(readFileSync(join(root, ".git", "config"), "utf8")).toBe("[core]\n");
    });
  }

  it("a FIFO cannot block a read", async () => {
    execFileSync("mkfifo", [join(root, "pipe")]);
    await expect(
      readConfinedFile(root, join(root, "pipe")),
    ).rejects.toMatchObject({ code: "not_a_file" });
  });

  it("REST write: a directory swapped for a symlink after the path check writes nothing outside", async () => {
    const realMkdir = fs.mkdir.bind(fs);
    vi.spyOn(fs, "mkdir").mockImplementation(async (p, o) => {
      const res = await realMkdir(p, o as never);
      // writeProjectFile's path check has passed; the sandbox swaps now.
      await fs.rm(join(root, "dir"), { recursive: true, force: true });
      symlinkSync(outside, join(root, "dir"));
      return res;
    });
    await expect(
      writeProjectFile(root, "dir/secret.txt", "pwned"),
    ).rejects.toMatchObject({ code: "invalid_path" });
    expect(readFileSync(join(outside, "secret.txt"), "utf8")).toBe(
      "HOST SECRET\n",
    );
  });

  it("REST read: a directory swapped for a symlink after the path check reads nothing outside", async () => {
    const realRealpath = fs.realpath.bind(fs);
    let calls = 0;
    vi.spyOn(fs, "realpath").mockImplementation(async (p, o) => {
      const res = await realRealpath(p as string, o as never);
      // assertInsideWorkspace resolves the root, then the target: swap
      // right after the target was approved.
      if (++calls === 2) {
        await fs.rm(join(root, "dir"), { recursive: true, force: true });
        symlinkSync(outside, join(root, "dir"));
      }
      return res;
    });
    writeFileSync(join(root, "dir", "secret.txt"), "inside twin\n");
    await expect(readProjectFile(root, "dir/secret.txt")).rejects.toMatchObject({
      code: "invalid_path",
    });
  });
});

// ---------------------------------------------------------------------------
// Symlinks committed to a branch (Linux host: container symlinks are real)
// ---------------------------------------------------------------------------

describe.skipIf(!SANDBOX_GIT || !LINUX)("M87 checked-out symlinks stay confined", () => {
  let f: M87Fixture;

  beforeEach(async () => {
    f = await makeM87Fixture();
    expect(
      (await f.api.request("POST", f.g("/init"), { token: f.ownerToken })).status,
    ).toBe(200);
  });

  afterEach(async () => {
    collaborationManager.getRoom(f.projectId)?.dispose();
    await f.close();
  });

  it("checkout reconciliation never reads a symlink target outside the workspace", async () => {
    const secretPath = join(f.cfg.dataDir, "host-secret.txt");
    writeFileSync(secretPath, "HOST-ONLY-SECRET-91ab\n");
    await f.sh(
      "echo base > base.txt && git add -A && git -c user.name=t -c user.email=t@t commit -qm base " +
        `&& git checkout -q -b leak && ln -s '${secretPath}' leak.txt ` +
        "&& git add -A && git -c user.name=t -c user.email=t@t commit -qm leak " +
        "&& git checkout -q main",
    );
    const room = collaborationManager.getOrCreateRoom(f.projectId);
    const r = await f.api.request("POST", f.g("/checkout"), {
      token: f.ownerToken,
      body: { name: "leak", dirtyOpenPaths: [] },
    });
    expect(r.status).toBe(200);
    expect(r.data.changedPaths).toContain("leak.txt");
    expect(JSON.stringify(r.data)).not.toContain("HOST-ONLY-SECRET");
    const text = room.doc.share.has("leak.txt")
      ? room.doc.getText("leak.txt").toString()
      : "";
    expect(text).not.toContain("HOST-ONLY-SECRET");
    const read = await f.api.request(
      "GET",
      `/api/projects/${f.projectId}/file?path=leak.txt`,
      { token: f.ownerToken },
    );
    expect(read.status).toBe(400);
    expect(read.text).not.toContain("HOST-ONLY-SECRET");
  });

  it("a .git symlink to a host directory is not a repository", async () => {
    const hostRepo = join(f.cfg.dataDir, "host-repo");
    execFileSync("git", ["init", "-q", hostRepo]);
    await f.sh(`rm -rf .git && ln -s '${join(hostRepo, ".git")}' .git`);
    const st = await f.api.request("GET", f.g("/status"), {
      token: f.ownerToken,
    });
    expect(st.status).toBe(200);
    expect(st.data.initialized).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Other host reads of the sandbox-writable workspace (same race, Linux)
// ---------------------------------------------------------------------------

describe.skipIf(!LINUX)("M87 confined host reads beyond Git", () => {
  let cfg: ReturnType<typeof makeTestConfig>;
  let api: Awaited<ReturnType<typeof startTestApi>>;
  let userId: number;
  let projectId: string;
  let cwd: string;
  let outside: string;
  const SECRET = "HOST-SECRET-e21d";

  beforeEach(async () => {
    cfg = makeTestConfig();
    api = await startTestApi(cfg);
    const reg = await api.request("POST", "/api/auth/register", {
      body: { username: `m87r${Date.now().toString(36)}`, password: "password123" },
    });
    userId = reg.data.user.id;
    const proj = await createProject(cfg, api.db, userId, { name: "m87-reads" });
    projectId = proj.id;
    cwd = join(cfg.workspacesDir, projectId);
    outside = join(cfg.dataDir, "host-private");
    mkdirSync(join(cwd, "dir"), { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(cwd, "dir", "secret.txt"), "inside twin\n");
    writeFileSync(join(outside, "secret.txt"), `${SECRET}\n`);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await api.close();
    await fs.rm(cfg.dataDir, { recursive: true, force: true });
  });

  /** The sandbox swaps `dir` for a host symlink as soon as the host
   *  first opens (or reads, or copies) a file below it. */
  function swapDirOnFirstRead() {
    const rm = fs.rm.bind(fs);
    let swapped = false;
    const swap = async (p: unknown) => {
      if (!swapped && String(p).includes("/dir/")) {
        swapped = true;
        await rm(join(cwd, "dir"), { recursive: true, force: true });
        symlinkSync(outside, join(cwd, "dir"));
      }
    };
    for (const name of ["open", "readFile", "copyFile"] as const) {
      const real = (fs[name] as (...a: unknown[]) => Promise<unknown>).bind(fs);
      vi.spyOn(fs, name).mockImplementation((async (...args: unknown[]) => {
        await swap(args[0]);
        return real(...args);
      }) as never);
    }
    return () => swapped;
  }

  async function zipContains(buf: Buffer, needle: string): Promise<boolean> {
    const dest = mkdtempSync(join(tmpdir(), "cloudide-m87-unzip-"));
    try {
      const { extractZipArchive } = await import("../src/projects/zip.js");
      const files = await extractZipArchive(buf, dest, cfg);
      for (const f of files) {
        if (f.isDir || !existsSync(f.absPath)) continue;
        if (readFileSync(f.absPath, "utf8").includes(needle)) return true;
      }
      return false;
    } finally {
      await fs.rm(dest, { recursive: true, force: true });
    }
  }

  it("project export never archives a host file", async () => {
    const { exportProjectZip } = await import("../src/projects/archive.js");
    const swapped = swapDirOnFirstRead();
    const r = await exportProjectZip(cfg, api.db, userId, projectId).catch(
      (e: unknown) => e,
    );
    expect(swapped()).toBe(true);
    if (!(r instanceof Error)) {
      expect(await zipContains((r as { zipBuffer: Buffer }).zipBuffer, SECRET)).toBe(false);
    }
  });

  it("workspace backup never archives a host file", async () => {
    const { createWorkspaceBackup } = await import(
      "../src/backup/workspaceBackup.js"
    );
    const swapped = swapDirOnFirstRead();
    const backup = await createWorkspaceBackup(cfg, api.db, projectId);
    vi.restoreAllMocks();
    expect(swapped()).toBe(true);
    expect(await zipContains(readFileSync(backup.filePath), SECRET)).toBe(false);
  });

  it("fork never copies a host file into the new project", async () => {
    const { forkProject } = await import("../src/projects/fork.js");
    const swapped = swapDirOnFirstRead();
    const r = await forkProject(cfg, api.db, userId, projectId).catch(
      (e: unknown) => e,
    );
    vi.restoreAllMocks();
    expect(swapped()).toBe(true);
    if (!(r instanceof Error)) {
      const forked = (r as { project: { id: string } }).project.id;
      const copied = join(cfg.workspacesDir, forked, "dir", "secret.txt");
      expect(
        existsSync(copied) ? readFileSync(copied, "utf8") : "",
      ).not.toContain(SECRET);
    }
  });

  it("AI context never includes a host file", async () => {
    const { buildAIContext } = await import("../src/ai/context.js");
    const swapped = swapDirOnFirstRead();
    const bundle = await buildAIContext(cfg, api.db, projectId, userId, {
      activeFilePath: "dir/secret.txt",
    });
    vi.restoreAllMocks();
    expect(swapped()).toBe(true);
    expect(JSON.stringify(bundle)).not.toContain(SECRET);
  });

  it("workflow discovery never parses a symlinked host package.json", async () => {
    const { discoverWorkflow } = await import("../src/workflow/discover.js");
    writeFileSync(
      join(outside, "package.json"),
      JSON.stringify({ scripts: { test: "echo host" } }),
    );
    symlinkSync(join(outside, "package.json"), join(cwd, "package.json"));
    const manifest = await discoverWorkflow(cwd);
    expect(manifest.tasks.some((t) => t.origin === "package.json")).toBe(false);
  });
});
