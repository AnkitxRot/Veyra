import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { makeTestConfig, startTestApi, type TestApi } from "./helpers.js";
import type { AppConfig } from "../src/config.js";
import type { Db } from "../src/db.js";
import {
  createProject,
  workspacePath,
  addProjectCollaborator,
} from "../src/projects/service.js";
import * as git from "../src/git/service.js";

function gitAvailable(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
const HAS_GIT = gitAvailable();

describe.skipIf(!HAS_GIT)("Milestone 51 — Local Git: service engine", () => {
  let cfg: AppConfig;
  let api: TestApi;
  let db: Db;
  let ownerId: number;
  let projectId: string;
  let cwd: string;

  const user = { username: "gituser" };

  beforeEach(async () => {
    cfg = makeTestConfig();
    api = await startTestApi(cfg);
    db = api.db;
    const reg = await api.request("POST", "/api/auth/register", {
      body: { username: "gituser", password: "password123" },
    });
    ownerId = reg.data.user.id;
    const proj = await createProject(cfg, db, ownerId, {
      name: "git-engine",
      language: "python",
    });
    projectId = proj.id;
    cwd = await workspacePath(cfg, projectId);
    await fs.writeFile(join(cwd, "a.py"), "print('one')\n", "utf8");
    await fs.writeFile(join(cwd, "b.py"), "print('two')\n", "utf8");
  });

  afterEach(async () => {
    await api.close();
    try {
      await fs.rm(cfg.dataDir, { recursive: true, force: true });
    } catch {}
  });

  it("1. initializes a repository on main", async () => {
    expect(await git.isRepository(cfg, projectId)).toBe(false);
    const res = await git.initRepository(cfg, projectId, user);
    expect(res.initialized).toBe(true);
    expect(res.branch).toBe("main");
    expect(await git.isRepository(cfg, projectId)).toBe(true);
  });

  it("2. init is idempotent", async () => {
    await git.initRepository(cfg, projectId, user);
    const again = await git.initRepository(cfg, projectId, user);
    expect(again.initialized).toBe(false);
    expect(again.alreadyRepo).toBe(true);
  });

  it("3. status lists untracked files on a fresh repo", async () => {
    await git.initRepository(cfg, projectId, user);
    const st = await git.getStatus(cfg, projectId);
    expect(st.initialized).toBe(true);
    expect(st.branch).toBe("main");
    expect(st.hasCommits).toBe(false);
    expect(st.unstaged.map((f) => f.path).sort()).toEqual(["a.py", "b.py"]);
    expect(st.unstaged.every((f) => f.untracked)).toBe(true);
    expect(st.staged).toHaveLength(0);
  });

  it("4. distinguishes staged vs unstaged", async () => {
    await git.initRepository(cfg, projectId, user);
    await git.stage(cfg, projectId, { paths: ["a.py"] });
    const st = await git.getStatus(cfg, projectId);
    expect(st.staged.map((f) => f.path)).toEqual(["a.py"]);
    expect(st.unstaged.map((f) => f.path)).toEqual(["b.py"]);
  });

  it("5. worktree diff reports additions/deletions", async () => {
    await git.initRepository(cfg, projectId, user);
    await git.stage(cfg, projectId, { all: true });
    await git.commit(cfg, projectId, "init", user);
    await fs.writeFile(
      join(cwd, "a.py"),
      "print('one')\nprint('extra')\n",
      "utf8",
    );
    const diff = await git.getDiffStat(cfg, projectId, false);
    const a = diff.find((d) => d.path === "a.py")!;
    expect(a.additions).toBe(1);
    expect(a.deletions).toBe(0);
  });

  it("6. staged diff is separate from worktree diff", async () => {
    await git.initRepository(cfg, projectId, user);
    await git.stage(cfg, projectId, { all: true });
    await git.commit(cfg, projectId, "init", user);
    await fs.writeFile(join(cwd, "a.py"), "print('CHANGED')\n", "utf8");
    await git.stage(cfg, projectId, { paths: ["a.py"] });
    await fs.writeFile(
      join(cwd, "a.py"),
      "print('CHANGED')\nprint('more')\n",
      "utf8",
    );
    const stagedDiff = await git.getDiffStat(cfg, projectId, true);
    const worktreeDiff = await git.getDiffStat(cfg, projectId, false);
    expect(stagedDiff.find((d) => d.path === "a.py")).toBeTruthy();
    expect(worktreeDiff.find((d) => d.path === "a.py")).toBeTruthy();
  });

  it("7. file diff parses hunks with +/- lines", async () => {
    await git.initRepository(cfg, projectId, user);
    await git.stage(cfg, projectId, { all: true });
    await git.commit(cfg, projectId, "init", user);
    await fs.writeFile(join(cwd, "a.py"), "print('ONE')\n", "utf8");
    const fd = await git.getFileDiff(cfg, projectId, "a.py", false);
    expect(fd.hunks.length).toBeGreaterThan(0);
    const kinds = fd.hunks[0].lines.map((l) => l.type);
    expect(kinds).toContain("add");
    expect(kinds).toContain("del");
    const added = fd.hunks[0].lines.find((l) => l.type === "add")!;
    expect(added.content).toBe("print('ONE')");
  });

  it("8. stage moves a file into the index", async () => {
    await git.initRepository(cfg, projectId, user);
    await git.stage(cfg, projectId, { paths: ["a.py"] });
    expect(
      (await git.getStatus(cfg, projectId)).staged.map((f) => f.path),
    ).toEqual(["a.py"]);
  });

  it("9. unstage removes a file from the index", async () => {
    await git.initRepository(cfg, projectId, user);
    await git.stage(cfg, projectId, { all: true });
    await git.unstage(cfg, projectId, { paths: ["a.py"] });
    const st = await git.getStatus(cfg, projectId);
    expect(st.staged.map((f) => f.path)).toEqual(["b.py"]);
    expect(st.unstaged.map((f) => f.path)).toContain("a.py");
  });

  it("10. commit records a commit and returns a hash", async () => {
    await git.initRepository(cfg, projectId, user);
    await git.stage(cfg, projectId, { all: true });
    const c = await git.commit(cfg, projectId, "first commit", user);
    expect(c.hash).toMatch(/^[0-9a-f]{40}$/);
    expect(c.shortHash.length).toBeGreaterThanOrEqual(7);
    const st = await git.getStatus(cfg, projectId);
    expect(st.clean).toBe(true);
    expect(st.hasCommits).toBe(true);
  });

  it("11. empty commit message is rejected", async () => {
    await git.initRepository(cfg, projectId, user);
    await git.stage(cfg, projectId, { all: true });
    await expect(git.commit(cfg, projectId, "   ", user)).rejects.toMatchObject(
      {
        code: "invalid_message",
      },
    );
  });

  it("12. nothing-to-commit is rejected", async () => {
    await git.initRepository(cfg, projectId, user);
    await expect(
      git.commit(cfg, projectId, "noop", user),
    ).rejects.toMatchObject({ code: "nothing_to_commit" });
  });

  it("13. commit authorship uses <username>@veyra.local", async () => {
    await git.initRepository(cfg, projectId, { username: "alice" });
    await git.stage(cfg, projectId, { all: true });
    await git.commit(cfg, projectId, "by alice", { username: "alice" });
    const out = execFileSync(
      "git",
      ["log", "-1", "--pretty=format:%an <%ae>"],
      { cwd, encoding: "utf8" },
    );
    expect(out).toBe("alice <alice@veyra.local>");
  });

  it("14. log returns commits newest-first", async () => {
    await git.initRepository(cfg, projectId, user);
    await git.stage(cfg, projectId, { all: true });
    await git.commit(cfg, projectId, "c1", user);
    await fs.writeFile(join(cwd, "c.py"), "x\n", "utf8");
    await git.stage(cfg, projectId, { all: true });
    await git.commit(cfg, projectId, "c2", user);
    const log = await git.getLog(cfg, projectId, 10);
    expect(log.map((c) => c.subject)).toEqual(["c2", "c1"]);
    expect(log[0].author).toBe("gituser");
  });

  it("15. branch list includes the current branch", async () => {
    await git.initRepository(cfg, projectId, user);
    const { current, branches } = await git.listBranches(cfg, projectId);
    expect(current).toBe("main");
    expect(branches.find((b) => b.name === "main")?.current).toBe(true);
  });

  it("16. create branch", async () => {
    await git.initRepository(cfg, projectId, user);
    await git.stage(cfg, projectId, { all: true });
    await git.commit(cfg, projectId, "init", user);
    await git.createBranch(cfg, projectId, "feature/x");
    const { branches } = await git.listBranches(cfg, projectId);
    expect(branches.map((b) => b.name).sort()).toEqual(["feature/x", "main"]);
  });

  it("17. checkout switches branch", async () => {
    await git.initRepository(cfg, projectId, user);
    await git.stage(cfg, projectId, { all: true });
    await git.commit(cfg, projectId, "init", user);
    await git.createBranch(cfg, projectId, "dev");
    const r = await git.checkoutBranch(cfg, projectId, "dev", []);
    expect(r).toMatchObject({ ok: true, branch: "dev" });
    expect((await git.getCurrentBranch(cfg, projectId)).branch).toBe("dev");
  });

  it("18. delete branch", async () => {
    await git.initRepository(cfg, projectId, user);
    await git.stage(cfg, projectId, { all: true });
    await git.commit(cfg, projectId, "init", user);
    await git.createBranch(cfg, projectId, "temp");
    await git.deleteBranch(cfg, projectId, "temp", false);
    const { branches } = await git.listBranches(cfg, projectId);
    expect(branches.map((b) => b.name)).toEqual(["main"]);
  });

  it("19. cannot delete the current branch", async () => {
    await git.initRepository(cfg, projectId, user);
    await git.stage(cfg, projectId, { all: true });
    await git.commit(cfg, projectId, "init", user);
    await expect(
      git.deleteBranch(cfg, projectId, "main", false),
    ).rejects.toMatchObject({ code: "cannot_delete_current" });
  });

  it("19b. unmerged branch delete needs force", async () => {
    await git.initRepository(cfg, projectId, user);
    await git.stage(cfg, projectId, { all: true });
    await git.commit(cfg, projectId, "init", user);
    await git.createBranch(cfg, projectId, "unmerged");
    await git.checkoutBranch(cfg, projectId, "unmerged", []);
    await fs.writeFile(join(cwd, "x.py"), "y\n", "utf8");
    await git.stage(cfg, projectId, { all: true });
    await git.commit(cfg, projectId, "diverge", user);
    await git.checkoutBranch(cfg, projectId, "main", []);
    await expect(
      git.deleteBranch(cfg, projectId, "unmerged", false),
    ).rejects.toMatchObject({ code: "branch_not_merged" });
    const forced = await git.deleteBranch(cfg, projectId, "unmerged", true);
    expect(forced.forced).toBe(true);
  });

  it("20. invalid branch names are rejected before git runs", async () => {
    await git.initRepository(cfg, projectId, user);
    await git.stage(cfg, projectId, { all: true });
    await git.commit(cfg, projectId, "init", user);
    for (const bad of [
      "--force",
      "-D",
      "..",
      "feature/../escape",
      "with space",
      "trailing.lock",
      "control\u0001char",
      "a".repeat(300),
      "",
    ]) {
      await expect(git.createBranch(cfg, projectId, bad)).rejects.toMatchObject(
        { code: "invalid_branch_name" },
      );
    }
  });

  it("21. option-like pathspecs are rejected", async () => {
    await git.initRepository(cfg, projectId, user);
    for (const bad of ["--all", "-f", "--git-dir=/tmp"]) {
      await expect(
        git.stage(cfg, projectId, { paths: [bad] }),
      ).rejects.toMatchObject({ code: "invalid_path" });
    }
  });

  it("22. path traversal is rejected", async () => {
    await git.initRepository(cfg, projectId, user);
    for (const bad of ["../secret", "a/../../b", "..\\..\\x"]) {
      await expect(
        git.stage(cfg, projectId, { paths: [bad] }),
      ).rejects.toMatchObject({ code: "invalid_path" });
    }
  });

  it("23. absolute paths are rejected", async () => {
    await git.initRepository(cfg, projectId, user);
    for (const bad of ["/etc/passwd", "C:\\Windows\\win.ini"]) {
      await expect(
        git.stage(cfg, projectId, { paths: [bad] }),
      ).rejects.toMatchObject({ code: "invalid_path" });
    }
  });

  it("24. .git internal paths are rejected", async () => {
    await git.initRepository(cfg, projectId, user);
    for (const bad of [".git/config", ".git/hooks/pre-commit", ".git"]) {
      await expect(
        git.stage(cfg, projectId, { paths: [bad] }),
      ).rejects.toMatchObject({ code: "invalid_path" });
    }
    await expect(
      git.getFileDiff(cfg, projectId, ".git/config", false),
    ).rejects.toMatchObject({ code: "invalid_path" });
  });

  it("29. author identity cannot be supplied by the caller (only username)", async () => {
    // The service signature only accepts { username }. A crafted username
    // still lands in an @veyra.local address, never a caller-chosen domain.
    await git.initRepository(cfg, projectId, { username: "mallory" });
    await git.stage(cfg, projectId, { all: true });
    await git.commit(cfg, projectId, "x", { username: "mallory" });
    const email = execFileSync("git", ["log", "-1", "--pretty=%ae"], {
      cwd,
      encoding: "utf8",
    }).trim();
    expect(email).toBe("mallory@veyra.local");
  });

  it("30/31. system/global config and hooks are neutralized for backend git", async () => {
    await git.initRepository(cfg, projectId, user);
    // A malicious pre-commit hook committed by a terminal user must NOT run
    // when the backend commits.
    await fs.mkdir(join(cwd, ".git", "hooks"), { recursive: true });
    const sentinel = join(cfg.dataDir, "HOOK_RAN");
    await fs.writeFile(
      join(cwd, ".git", "hooks", "pre-commit"),
      `#!/bin/sh\necho ran > "${sentinel}"\nexit 0\n`,
      { mode: 0o755 },
    );
    await git.stage(cfg, projectId, { all: true });
    await git.commit(cfg, projectId, "no hook", user);
    let hookRan = true;
    try {
      await fs.access(sentinel);
    } catch {
      hookRan = false;
    }
    expect(hookRan).toBe(false);
  });

  it("33. checkout is refused when it would overwrite dirty tracked files", async () => {
    await git.initRepository(cfg, projectId, user);
    await git.stage(cfg, projectId, { all: true });
    await git.commit(cfg, projectId, "init", user);
    await git.createBranch(cfg, projectId, "other");
    await git.checkoutBranch(cfg, projectId, "other", []);
    await fs.writeFile(join(cwd, "a.py"), "print('OTHER-BRANCH')\n", "utf8");
    await git.stage(cfg, projectId, { all: true });
    await git.commit(cfg, projectId, "edit on other", user);
    await git.checkoutBranch(cfg, projectId, "main", []);
    // Now dirty a.py on main in a way that conflicts with 'other'
    await fs.writeFile(join(cwd, "a.py"), "print('UNCOMMITTED')\n", "utf8");
    const res = await git.checkoutBranch(cfg, projectId, "other", ["a.py"]);
    expect(res).toMatchObject({ ok: false, conflict: true });
    if (res.ok === false) expect(res.blockingPaths).toContain("a.py");
    // still on main, file untouched
    expect((await git.getCurrentBranch(cfg, projectId)).branch).toBe("main");
    expect(await fs.readFile(join(cwd, "a.py"), "utf8")).toBe(
      "print('UNCOMMITTED')\n",
    );
  });

  it("34. checkout reports changedPaths for clean reconciliation", async () => {
    await git.initRepository(cfg, projectId, user);
    await git.stage(cfg, projectId, { all: true });
    await git.commit(cfg, projectId, "init", user);
    await git.createBranch(cfg, projectId, "feature");
    await git.checkoutBranch(cfg, projectId, "feature", []);
    await fs.writeFile(join(cwd, "a.py"), "print('feature version')\n", "utf8");
    await git.stage(cfg, projectId, { all: true });
    await git.commit(cfg, projectId, "feature edit", user);
    const back = await git.checkoutBranch(cfg, projectId, "main", []);
    expect(back.ok).toBe(true);
    if (back.ok) expect(back.changedPaths).toContain("a.py");
    expect(await fs.readFile(join(cwd, "a.py"), "utf8")).toBe("print('one')\n");
  });

  it("39. file diff output is bounded (truncated flag on a huge change)", async () => {
    await git.initRepository(cfg, projectId, user);
    await git.stage(cfg, projectId, { all: true });
    await git.commit(cfg, projectId, "init", user);
    await fs.writeFile(
      join(cwd, "big.py"),
      Array.from({ length: 9000 }, (_, i) => `line ${i}`).join("\n") + "\n",
      "utf8",
    );
    const fd = await git.getFileDiff(cfg, projectId, "big.py", false);
    expect(fd.truncated).toBe(true);
    const totalLines = fd.hunks.reduce((n, h) => n + h.lines.length, 0);
    expect(totalLines).toBeLessThanOrEqual(4100);
  });

  it("40. operating on a non-repo project returns a structured error", async () => {
    await expect(git.getStatus(cfg, projectId)).resolves.toMatchObject({
      initialized: false,
    });
    await expect(git.commit(cfg, projectId, "x", user)).rejects.toMatchObject({
      code: "not_a_repo",
    });
    await expect(git.createBranch(cfg, projectId, "x")).rejects.toMatchObject({
      code: "not_a_repo",
    });
  });

  it("32. concurrent git mutations are serialized without corruption", async () => {
    await git.initRepository(cfg, projectId, user);
    await git.stage(cfg, projectId, { all: true });
    await git.commit(cfg, projectId, "init", user);
    const { withProjectSnapshotLock } =
      await import("../src/projects/snapshots.js");
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        withProjectSnapshotLock(projectId, async () => {
          await fs.writeFile(join(cwd, `f${i}.py`), `v${i}\n`, "utf8");
          await git.stage(cfg, projectId, { all: true });
          await git.commit(cfg, projectId, `commit ${i}`, user);
        }),
      ),
    );
    const log = await git.getLog(cfg, projectId, 20);
    expect(log).toHaveLength(9);
    const st = await git.getStatus(cfg, projectId);
    expect(st.clean).toBe(true);
  });
});

describe.skipIf(!HAS_GIT)(
  "Milestone 51 — Local Git: HTTP API + authorization",
  () => {
    let cfg: AppConfig;
    let api: TestApi;
    let db: Db;
    let ownerToken: string;
    let editorToken: string;
    let viewerToken: string;
    let outsiderToken: string;
    let projectId: string;
    let cwd: string;

    beforeEach(async () => {
      cfg = makeTestConfig();
      api = await startTestApi(cfg);
      db = api.db;
      const mk = async (u: string) =>
        (
          await api.request("POST", "/api/auth/register", {
            body: { username: u, password: "password123" },
          })
        ).data;
      const owner = await mk("gitowner");
      const editor = await mk("giteditor");
      const viewer = await mk("gitviewer");
      const outsider = await mk("gitoutsider");
      ownerToken = owner.token;
      editorToken = editor.token;
      viewerToken = viewer.token;
      outsiderToken = outsider.token;
      const proj = await createProject(cfg, db, owner.user.id, {
        name: "git-http",
        language: "python",
      });
      projectId = proj.id;
      cwd = await workspacePath(cfg, projectId);
      addProjectCollaborator(db, projectId, editor.user.id, "editor");
      addProjectCollaborator(db, projectId, viewer.user.id, "viewer");
      await fs.writeFile(join(cwd, "main.py"), "print('hi')\n", "utf8");
    });

    afterEach(async () => {
      await api.close();
      try {
        await fs.rm(cfg.dataDir, { recursive: true, force: true });
      } catch {}
    });

    const g = (p: string) => `/api/projects/${projectId}/git${p}`;

    it("25. viewer can read status; 26. viewer cannot write", async () => {
      await api.request("POST", g("/init"), { token: ownerToken });
      const st = await api.request("GET", g("/status"), { token: viewerToken });
      expect(st.status).toBe(200);
      expect(st.data.initialized).toBe(true);

      const stage = await api.request("POST", g("/stage"), {
        token: viewerToken,
        body: { all: true },
      });
      expect(stage.status).toBe(403);
      const commit = await api.request("POST", g("/commit"), {
        token: viewerToken,
        body: { message: "x" },
      });
      expect(commit.status).toBe(403);
      const init = await api.request("POST", g("/init"), {
        token: viewerToken,
      });
      expect(init.status).toBe(403);
    });

    it("27. editor can read and write", async () => {
      const init = await api.request("POST", g("/init"), {
        token: editorToken,
      });
      expect(init.status).toBe(200);
      const stage = await api.request("POST", g("/stage"), {
        token: editorToken,
        body: { all: true },
      });
      expect(stage.status).toBe(200);
      const commit = await api.request("POST", g("/commit"), {
        token: editorToken,
        body: { message: "editor commit" },
      });
      expect(commit.status).toBe(200);
      expect(commit.data.shortHash).toBeTruthy();
    });

    it("28. non-collaborator gets an IDOR-safe 404 (never 403)", async () => {
      for (const path of ["/status", "/branches", "/log"] as const) {
        const r = await api.request("GET", g(path), { token: outsiderToken });
        expect(r.status).toBe(404);
      }
      const w = await api.request("POST", g("/init"), { token: outsiderToken });
      expect(w.status).toBe(404);
      const anon = await api.request("GET", g("/status"));
      expect(anon.status).toBe(401);
    });

    it("commit author = the AUTHENTICATED user, not whoever ran init", async () => {
      await api.request("POST", g("/init"), { token: ownerToken });
      await api.request("POST", g("/stage"), {
        token: editorToken,
        body: { all: true },
      });
      await api.request("POST", g("/commit"), {
        token: editorToken,
        body: { message: "by the editor" },
      });
      const email = execFileSync("git", ["log", "-1", "--pretty=%ae"], {
        cwd,
        encoding: "utf8",
      }).trim();
      expect(email).toBe("giteditor@veyra.local");
    });

    it("records GIT_INIT / GIT_COMMIT / GIT_CHECKOUT audit events", async () => {
      await api.request("POST", g("/init"), { token: ownerToken });
      await api.request("POST", g("/stage"), {
        token: ownerToken,
        body: { all: true },
      });
      await api.request("POST", g("/commit"), {
        token: ownerToken,
        body: { message: "audited" },
      });
      await api.request("POST", g("/branches"), {
        token: ownerToken,
        body: { name: "b1" },
      });
      await api.request("POST", g("/checkout"), {
        token: ownerToken,
        body: { name: "b1" },
      });
      const types = (
        db
          .prepare(
            "SELECT event_type FROM audit_logs WHERE project_id = ? ORDER BY id",
          )
          .all(projectId) as Array<{ event_type: string }>
      ).map((r) => r.event_type);
      expect(types).toEqual(
        expect.arrayContaining([
          "GIT_INIT",
          "GIT_COMMIT",
          "GIT_BRANCH_CREATED",
          "GIT_CHECKOUT",
        ]),
      );
    });

    it("checkout conflict returns 409 with blockingPaths and does not switch", async () => {
      await api.request("POST", g("/init"), { token: ownerToken });
      await api.request("POST", g("/stage"), {
        token: ownerToken,
        body: { all: true },
      });
      await api.request("POST", g("/commit"), {
        token: ownerToken,
        body: { message: "init" },
      });
      await api.request("POST", g("/branches"), {
        token: ownerToken,
        body: { name: "feat" },
      });
      await api.request("POST", g("/checkout"), {
        token: ownerToken,
        body: { name: "feat" },
      });
      await fs.writeFile(join(cwd, "main.py"), "print('feat')\n", "utf8");
      await api.request("POST", g("/stage"), {
        token: ownerToken,
        body: { all: true },
      });
      await api.request("POST", g("/commit"), {
        token: ownerToken,
        body: { message: "feat edit" },
      });
      await api.request("POST", g("/checkout"), {
        token: ownerToken,
        body: { name: "main" },
      });
      await fs.writeFile(join(cwd, "main.py"), "print('dirty')\n", "utf8");
      const r = await api.request("POST", g("/checkout"), {
        token: ownerToken,
        body: { name: "feat", dirtyOpenPaths: ["main.py"] },
      });
      expect(r.status).toBe(409);
      expect(r.data.blockingPaths).toContain("main.py");
      expect(await fs.readFile(join(cwd, "main.py"), "utf8")).toBe(
        "print('dirty')\n",
      );
    });
  },
);

describe.skipIf(!HAS_GIT)(
  "Milestone 51 — Local Git: .git portability (local-only)",
  () => {
    let cfg: AppConfig;
    let api: TestApi;
    let db: Db;
    let ownerId: number;
    let ownerToken: string;
    let projectId: string;
    let cwd: string;
    const user = { username: "portuser" };

    beforeEach(async () => {
      cfg = makeTestConfig();
      api = await startTestApi(cfg);
      db = api.db;
      const reg = await api.request("POST", "/api/auth/register", {
        body: { username: "portuser", password: "password123" },
      });
      ownerId = reg.data.user.id;
      ownerToken = reg.data.token;
      const proj = await createProject(cfg, db, ownerId, {
        name: "port-src",
        language: "python",
      });
      projectId = proj.id;
      cwd = await workspacePath(cfg, projectId);
      await fs.writeFile(join(cwd, "keep.py"), "print('keep')\n", "utf8");
      await git.initRepository(cfg, projectId, user);
      await git.stage(cfg, projectId, { all: true });
      await git.commit(cfg, projectId, "history that must not travel", user);
    });

    afterEach(async () => {
      await api.close();
      try {
        await fs.rm(cfg.dataDir, { recursive: true, force: true });
      } catch {}
    });

    it("36. fork creates a project with NO inherited .git history", async () => {
      const { forkProject } = await import("../src/projects/fork.js");
      const { project: forked } = await forkProject(
        cfg,
        db,
        ownerId,
        projectId,
      );
      const forkedCwd = await workspacePath(cfg, forked.id);
      let hasGit = true;
      try {
        await fs.access(join(forkedCwd, ".git"));
      } catch {
        hasGit = false;
      }
      expect(hasGit).toBe(false);
      expect(await fs.readFile(join(forkedCwd, "keep.py"), "utf8")).toBe(
        "print('keep')\n",
      );
    });

    it("37. ZIP export excludes .git", async () => {
      const res = await api.request(
        "GET",
        `/api/projects/${projectId}/export`,
        {
          token: ownerToken,
        },
      );
      expect(res.status).toBe(200);
      // PKZIP central-directory filenames are stored as plain bytes; a `.git/`
      // entry would show up literally in the archive bytes.
      expect(res.text.includes(".git/")).toBe(false);
      expect(res.text.includes("keep.py")).toBe(true);
    });

    it("38. workspace backup archive excludes .git", async () => {
      const { createWorkspaceBackup, listWorkspaceBackups } =
        await import("../src/backup/workspaceBackup.js");
      await createWorkspaceBackup(cfg, db, projectId);
      const [backup] = await listWorkspaceBackups(cfg, projectId);
      const buf = await fs.readFile(backup.filePath);
      expect(buf.includes(Buffer.from("workspace/.git/"))).toBe(false);
      expect(buf.includes(Buffer.from("keep.py"))).toBe(true);
    });

    it("35. snapshot restore PRESERVES .git, its history and branches", async () => {
      const { createSnapshot, restoreSnapshot, listSnapshots } =
        await import("../src/projects/snapshots.js");
      await git.createBranch(cfg, projectId, "feature/keep-me");
      const snap = await createSnapshot(
        cfg,
        db,
        ownerId,
        projectId,
        "before change",
      );
      // Mutate ordinary files, add a new commit, then restore the snapshot.
      await fs.writeFile(join(cwd, "keep.py"), "print('changed')\n", "utf8");
      await fs.writeFile(join(cwd, "extra.py"), "x\n", "utf8");
      await git.stage(cfg, projectId, { all: true });
      await git.commit(cfg, projectId, "post-snapshot commit", user);

      await restoreSnapshot(cfg, db, ownerId, projectId, snap.id);

      // Ordinary files rolled back...
      expect(await fs.readFile(join(cwd, "keep.py"), "utf8")).toBe(
        "print('keep')\n",
      );
      // ...but .git is intact: repo still exists, history + the new commit
      // + the branch all survive (snapshots never captured .git).
      expect(await git.isRepository(cfg, projectId)).toBe(true);
      const log = await git.getLog(cfg, projectId, 10);
      expect(log.map((c) => c.subject)).toContain("post-snapshot commit");
      const { branches } = await git.listBranches(cfg, projectId);
      expect(branches.map((b) => b.name)).toContain("feature/keep-me");
      void listSnapshots;
    });

    it("the by-path file API refuses .git internals (read/write/delete/move)", async () => {
      const {
        readProjectFile,
        writeProjectFile,
        deleteProjectPath,
        moveProjectPath,
      } = await import("../src/files/service.js");
      await expect(readProjectFile(cwd, ".git/config")).rejects.toMatchObject({
        code: "invalid_path",
      });
      await expect(
        writeProjectFile(cwd, ".git/hooks/pre-commit", "#!/bin/sh\n"),
      ).rejects.toMatchObject({ code: "invalid_path" });
      await expect(deleteProjectPath(cwd, ".git")).rejects.toMatchObject({
        code: "invalid_path",
      });
      await expect(
        moveProjectPath(cwd, ".git/config", "stolen.txt"),
      ).rejects.toMatchObject({ code: "invalid_path" });
    });
  },
);
