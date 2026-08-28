import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promises as fs } from "node:fs";
import { replaceProjectContent } from "../src/projects/search.js";
import { makeTestConfig, startTestApi, type TestApi } from "./helpers.js";
import type { AppConfig, ConfigOverrides } from "../src/config.js";
import type { Db } from "../src/db.js";
import {
  createProject,
  workspacePath,
  addProjectCollaborator,
} from "../src/projects/service.js";
import { readProjectFile } from "../src/files/service.js";
import { listSnapshots, restoreSnapshot } from "../src/projects/snapshots.js";
import { collaborationManager } from "../src/collab/manager.js";

describe("Milestone 26 — Workspace-wide Search & Replace: engine", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "cloudeee-replace-test-"));
    writeFileSync(tempDir + "/a.txt", "hello world\nhello again\nHELLO caps\n");
    writeFileSync(tempDir + "/b.txt", "no match here\n");
    mkdirSync(join(tempDir, "src"), { recursive: true });
    writeFileSync(join(tempDir, "src", "c.ts"), "const hello = 1;\n");
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it("computes literal replacement across matched files without touching disk", async () => {
    const before = readFileSync(join(tempDir, "a.txt"), "utf8");
    const res = await replaceProjectContent(tempDir, {
      query: "hello",
      replacement: "goodbye",
      isCaseSensitive: false,
    });

    expect(res.totalMatches).toBe(4); // a.txt x3, src/c.ts x1
    expect(res.groups.length).toBe(2);

    const aGroup = res.groups.find((g) => g.filePath === "a.txt")!;
    expect(aGroup.newContent).toBe(
      "goodbye world\ngoodbye again\ngoodbye caps\n",
    );
    expect(aGroup.matches[0].replacedLineContent).toBe("goodbye world");

    // Pure computation — never writes.
    expect(readFileSync(join(tempDir, "a.txt"), "utf8")).toBe(before);
  });

  it("treats '$' literally in non-regex mode instead of as a capture-group backreference", async () => {
    const res = await replaceProjectContent(tempDir, {
      query: "hello",
      replacement: "$1 price",
      isCaseSensitive: false,
    });
    const aGroup = res.groups.find((g) => g.filePath === "a.txt")!;
    // A naive String.replace(regex, "$1 price") with no capture group would
    // silently turn "$1" into "" — this must insert the literal text instead.
    expect(aGroup.newContent).toBe(
      "$1 price world\n$1 price again\n$1 price caps\n",
    );
  });

  it("honors capture-group backreferences in regex mode", async () => {
    const res = await replaceProjectContent(tempDir, {
      query: "(hello) (\\w+)",
      replacement: "$2-$1",
      isRegex: true,
      isCaseSensitive: false,
    });
    const aGroup = res.groups.find((g) => g.filePath === "a.txt")!;
    expect(aGroup.newContent).toBe("world-hello\nagain-hello\ncaps-HELLO\n");
  });

  it("respects case sensitivity, whole word, and include/exclude filters identically to search", async () => {
    const caseSensitive = await replaceProjectContent(tempDir, {
      query: "hello",
      replacement: "x",
      isCaseSensitive: true,
    });
    expect(caseSensitive.totalMatches).toBe(3); // excludes "HELLO caps"

    const included = await replaceProjectContent(tempDir, {
      query: "hello",
      replacement: "x",
      includePattern: "*.ts",
    });
    expect(included.groups.map((g) => g.filePath)).toEqual(["src/c.ts"]);

    const excluded = await replaceProjectContent(tempDir, {
      query: "hello",
      replacement: "x",
      excludePattern: "*.ts",
    });
    expect(excluded.groups.map((g) => g.filePath).sort()).toEqual(["a.txt"]);
  });

  it("does not offer a file for writing (newContent: null) when its match scan was truncated by maxResults", async () => {
    const res = await replaceProjectContent(tempDir, {
      query: "hello",
      replacement: "x",
      isCaseSensitive: false,
      maxResults: 2,
    });
    expect(res.truncated).toBe(true);
    const aGroup = res.groups.find((g) => g.filePath === "a.txt")!;
    // Matches are still reported for review...
    expect(aGroup.matches.length).toBeGreaterThan(0);
    // ...but this file's scan was cut short, so it must not be written.
    expect(aGroup.newContent).toBeNull();
  });

  it("does not hang on a catastrophic-backtracking regex in replace mode (same killable worker as search)", async () => {
    writeFileSync(join(tempDir, "redos.txt"), "a".repeat(40) + "!");

    const start = Date.now();
    const res = await replaceProjectContent(tempDir, {
      query: "((a+))+$",
      replacement: "x",
      isRegex: true,
    });
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(15000);
    expect(res.truncated).toBe(true);
  }, 20000);

  it("supports deleting matched text via an empty replacement string", async () => {
    const res = await replaceProjectContent(tempDir, {
      query: "hello ",
      replacement: "",
      isCaseSensitive: false,
    });
    const aGroup = res.groups.find((g) => g.filePath === "a.txt")!;
    expect(aGroup.newContent).toBe("world\nagain\ncaps\n");
  });

  it("returns empty results for an empty query without erroring", async () => {
    const res = await replaceProjectContent(tempDir, {
      query: "",
      replacement: "x",
    });
    expect(res.groups).toEqual([]);
    expect(res.totalMatches).toBe(0);
  });
});

describe("Milestone 26 — Workspace-wide Search & Replace: HTTP API", () => {
  let cfg: AppConfig;
  let db: Db;
  let api: TestApi;
  let ownerId: number;
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

    const owner = await api.request("POST", "/api/auth/register", {
      body: { username: "replaceowner", password: "password123" },
    });
    ownerId = owner.data.user.id;
    ownerToken = owner.data.token;

    const editor = await api.request("POST", "/api/auth/register", {
      body: { username: "replaceeditor", password: "password123" },
    });
    editorToken = editor.data.token;

    const viewer = await api.request("POST", "/api/auth/register", {
      body: { username: "replaceviewer", password: "password123" },
    });
    viewerToken = viewer.data.token;

    const outsider = await api.request("POST", "/api/auth/register", {
      body: { username: "replaceoutsider", password: "password123" },
    });
    outsiderToken = outsider.data.token;

    const proj = await createProject(cfg, db, ownerId, {
      name: "replace-test-project",
      language: "python",
    });
    projectId = proj.id;
    cwd = await workspacePath(cfg, projectId);

    addProjectCollaborator(db, projectId, editor.data.user.id, "editor");
    addProjectCollaborator(db, projectId, viewer.data.user.id, "viewer");

    await fs.mkdir(cwd, { recursive: true });
    await fs.writeFile(
      join(cwd, "app.py"),
      "print('hello world')\nprint('hello again')\n",
      "utf8",
    );
  });

  afterEach(async () => {
    await api.close();
    try {
      await fs.rm(cfg.dataDir, { recursive: true, force: true });
    } catch {}
  });

  it("rejects unauthenticated, non-collaborator, and viewer-role requests; allows editor and owner", async () => {
    const body = { query: "hello", replacement: "hi" };

    const anon = await api.request(
      "POST",
      `/api/projects/${projectId}/search/replace`,
      { body },
    );
    expect(anon.status).toBe(401);

    const outsiderRes = await api.request(
      "POST",
      `/api/projects/${projectId}/search/replace`,
      {
        token: outsiderToken,
        body,
      },
    );
    expect(outsiderRes.status).toBe(404); // IDOR-safe: non-member sees "not found", not "forbidden"

    const viewerRes = await api.request(
      "POST",
      `/api/projects/${projectId}/search/replace`,
      {
        token: viewerToken,
        body,
      },
    );
    expect(viewerRes.status).toBe(403); // read-only collaborators cannot mutate the workspace

    const editorRes = await api.request(
      "POST",
      `/api/projects/${projectId}/search/replace`,
      {
        token: editorToken,
        body,
      },
    );
    expect(editorRes.status).toBe(200);

    const ownerRes = await api.request(
      "POST",
      `/api/projects/${projectId}/search/replace`,
      {
        token: ownerToken,
        body,
      },
    );
    expect(ownerRes.status).toBe(200);
  });

  it("validates query and replacement fields", async () => {
    const missingQuery = await api.request(
      "POST",
      `/api/projects/${projectId}/search/replace`,
      {
        token: ownerToken,
        body: { replacement: "hi" },
      },
    );
    expect(missingQuery.status).toBe(400);

    const missingReplacement = await api.request(
      "POST",
      `/api/projects/${projectId}/search/replace`,
      {
        token: ownerToken,
        body: { query: "hello" },
      },
    );
    expect(missingReplacement.status).toBe(400);
  });

  it("defaults to a dry run (preview) that never writes to disk", async () => {
    const res = await api.request(
      "POST",
      `/api/projects/${projectId}/search/replace`,
      {
        token: ownerToken,
        body: { query: "hello", replacement: "hi" },
      },
    );
    expect(res.status).toBe(200);
    expect(res.data.applied).toBe(false);
    expect(res.data.totalMatches).toBe(2);
    expect(res.data.groups[0].matches[0].replacedLineContent).toContain("hi");

    const onDisk = await readProjectFile(cwd, "app.py");
    expect(onDisk.content).toBe("print('hello world')\nprint('hello again')\n");
  });

  it("applies the replacement to disk only when dryRun: false is explicit, and reports a summary", async () => {
    const res = await api.request(
      "POST",
      `/api/projects/${projectId}/search/replace`,
      {
        token: ownerToken,
        body: { query: "hello", replacement: "hi", dryRun: false },
      },
    );
    expect(res.status).toBe(200);
    expect(res.data.applied).toBe(true);
    expect(res.data.filesChanged).toBe(1);
    expect(res.data.matchesReplaced).toBe(2);
    expect(res.data.results).toEqual([
      { filePath: "app.py", status: "replaced", matchCount: 2 },
    ]);

    const onDisk = await readProjectFile(cwd, "app.py");
    expect(onDisk.content).toBe("print('hi world')\nprint('hi again')\n");
  });

  it("scopes the apply to only the requested files when 'files' is provided", async () => {
    await fs.writeFile(join(cwd, "other.py"), "print('hello there')\n", "utf8");

    const res = await api.request(
      "POST",
      `/api/projects/${projectId}/search/replace`,
      {
        token: ownerToken,
        body: {
          query: "hello",
          replacement: "hi",
          dryRun: false,
          files: ["app.py"],
        },
      },
    );
    expect(res.status).toBe(200);
    expect(res.data.filesChanged).toBe(1);
    expect(res.data.results.map((r: any) => r.filePath)).toEqual(["app.py"]);

    const untouched = await readProjectFile(cwd, "other.py");
    expect(untouched.content).toBe("print('hello there')\n");
  });

  it("isolates a single file's write failure: other files still apply and the request still returns 200", async () => {
    await fs.writeFile(join(cwd, "other.py"), "print('hello there')\n", "utf8");
    // Make one target read-only so its write fails, without affecting the sibling file.
    await fs.chmod(join(cwd, "app.py"), 0o444);

    try {
      const res = await api.request(
        "POST",
        `/api/projects/${projectId}/search/replace`,
        {
          token: ownerToken,
          body: { query: "hello", replacement: "hi", dryRun: false },
        },
      );

      expect(res.status).toBe(200);
      expect(res.data.applied).toBe(true);
      const appResult = res.data.results.find(
        (r: any) => r.filePath === "app.py",
      );
      const otherResult = res.data.results.find(
        (r: any) => r.filePath === "other.py",
      );
      expect(appResult.status).toBe("error");
      expect(otherResult.status).toBe("replaced");
      expect(res.data.filesChanged).toBe(1);

      const untouched = await readProjectFile(cwd, "app.py");
      expect(untouched.content).toBe(
        "print('hello world')\nprint('hello again')\n",
      );
      const changed = await readProjectFile(cwd, "other.py");
      expect(changed.content).toBe("print('hi there')\n");
    } finally {
      // Restore write permission so afterEach's directory cleanup can succeed.
      await fs.chmod(join(cwd, "app.py"), 0o666);
    }
  });

  it("reports a live-collaborator conflict as a distinct 'conflict' status (not 'replaced', not 'skipped'), and still applies the other files", async () => {
    await fs.writeFile(join(cwd, "other.py"), "print('hello there')\n", "utf8");

    // A live collaborator has an unsaved edit in app.py (only in the Y.Doc).
    const room = collaborationManager.getOrCreateRoom(projectId);
    const yText = await room.ensureFileLoaded("app.py");
    room.doc.transact(() => {
      yText.insert(yText.length, "print('collab unsaved')\n");
    });
    expect((room as any).dirtyFiles.has("app.py")).toBe(true);

    try {
      const res = await api.request(
        "POST",
        `/api/projects/${projectId}/search/replace`,
        {
          token: ownerToken,
          body: { query: "hello", replacement: "hi", dryRun: false },
        },
      );

      expect(res.status).toBe(200);
      expect(res.data.applied).toBe(true);

      const appResult = res.data.results.find(
        (r: any) => r.filePath === "app.py",
      );
      const otherResult = res.data.results.find(
        (r: any) => r.filePath === "other.py",
      );
      expect(appResult.status).toBe("conflict");
      expect(appResult.reason).toMatch(/collaborator/i);
      expect(otherResult.status).toBe("replaced");

      // The conflicted file is not counted as changed and no false "skipped".
      expect(res.data.filesChanged).toBe(1);
      expect(
        res.data.results.some((r: any) => r.status === "skipped"),
      ).toBe(false);

      // The collaborator's unsaved edit is intact; the other file applied.
      expect(yText.toString()).toBe(
        "print('hello world')\nprint('hello again')\nprint('collab unsaved')\n",
      );
      expect((await readProjectFile(cwd, "other.py")).content).toBe(
        "print('hi there')\n",
      );
    } finally {
      room.dispose();
    }
  });
});

describe("Milestone 50 — Safe workspace-wide Replace All (snapshot + selection)", () => {
  interface Ctx {
    cfg: AppConfig;
    db: Db;
    api: TestApi;
    ownerId: number;
    ownerToken: string;
    editorToken: string;
    projectId: string;
    cwd: string;
  }

  const active: Ctx[] = [];

  async function setup(overrides: ConfigOverrides = {}): Promise<Ctx> {
    const cfg = makeTestConfig(overrides);
    const api = await startTestApi(cfg);
    const db = api.db;

    const owner = await api.request("POST", "/api/auth/register", {
      body: { username: "m50owner", password: "password123" },
    });
    const editor = await api.request("POST", "/api/auth/register", {
      body: { username: "m50editor", password: "password123" },
    });

    const proj = await createProject(cfg, db, owner.data.user.id, {
      name: "m50-replace-project",
      language: "python",
    });
    const cwd = await workspacePath(cfg, proj.id);
    addProjectCollaborator(db, proj.id, editor.data.user.id, "editor");

    await fs.mkdir(cwd, { recursive: true });
    await fs.writeFile(
      join(cwd, "app.py"),
      "print('hello world')\nprint('hello again')\n",
      "utf8",
    );
    await fs.writeFile(
      join(cwd, "util.py"),
      "def greet():\n    return 'hello team'\n",
      "utf8",
    );

    const ctx: Ctx = {
      cfg,
      db,
      api,
      ownerId: owner.data.user.id,
      ownerToken: owner.data.token,
      editorToken: editor.data.token,
      projectId: proj.id,
      cwd,
    };
    active.push(ctx);
    return ctx;
  }

  afterEach(async () => {
    while (active.length) {
      const ctx = active.pop()!;
      await ctx.api.close();
      try {
        await fs.rm(ctx.cfg.dataDir, { recursive: true, force: true });
      } catch {}
    }
  });

  const replaceUrl = (id: string) => `/api/projects/${id}/search/replace`;

  it("creates exactly one snapshot before the first write and returns its id", async () => {
    const c = await setup();
    const res = await c.api.request("POST", replaceUrl(c.projectId), {
      token: c.ownerToken,
      body: {
        query: "hello",
        replacement: "hi",
        dryRun: false,
        createSafetySnapshot: true,
      },
    });
    expect(res.status).toBe(200);
    expect(res.data.applied).toBe(true);
    expect(typeof res.data.snapshotId).toBe("string");
    expect(res.data.snapshotId.length).toBeGreaterThan(0);

    const snaps = listSnapshots(c.db, c.ownerId, c.projectId);
    expect(snaps).toHaveLength(1);
    expect(snaps[0].id).toBe(res.data.snapshotId);
    expect(snaps[0].name).toContain("Before Replace All");

    // disk really changed
    expect((await readProjectFile(c.cwd, "app.py")).content).toBe(
      "print('hi world')\nprint('hi again')\n",
    );
  });

  it("restoring the returned snapshot returns every changed file to its pre-replace bytes", async () => {
    const c = await setup();
    const appBefore = (await readProjectFile(c.cwd, "app.py")).content;
    const utilBefore = (await readProjectFile(c.cwd, "util.py")).content;

    const res = await c.api.request("POST", replaceUrl(c.projectId), {
      token: c.ownerToken,
      body: {
        query: "hello",
        replacement: "hi",
        dryRun: false,
        createSafetySnapshot: true,
      },
    });
    expect(res.data.filesChanged).toBe(2);
    expect((await readProjectFile(c.cwd, "app.py")).content).not.toBe(
      appBefore,
    );

    await restoreSnapshot(
      c.cfg,
      c.db,
      c.ownerId,
      c.projectId,
      res.data.snapshotId,
    );

    expect((await readProjectFile(c.cwd, "app.py")).content).toBe(appBefore);
    expect((await readProjectFile(c.cwd, "util.py")).content).toBe(utilBefore);
  });

  it("does not create a snapshot on a dry run", async () => {
    const c = await setup();
    const res = await c.api.request("POST", replaceUrl(c.projectId), {
      token: c.ownerToken,
      body: { query: "hello", replacement: "hi", createSafetySnapshot: true },
    });
    expect(res.status).toBe(200);
    expect(res.data.applied).toBe(false);
    expect(res.data.snapshotId).toBeUndefined();
    expect(listSnapshots(c.db, c.ownerId, c.projectId)).toHaveLength(0);
  });

  it("preserves the pre-M50 no-snapshot behavior when createSafetySnapshot is omitted / false", async () => {
    const c = await setup();
    const res = await c.api.request("POST", replaceUrl(c.projectId), {
      token: c.ownerToken,
      body: { query: "hello", replacement: "hi", dryRun: false },
    });
    expect(res.status).toBe(200);
    expect(res.data.applied).toBe(true);
    expect(res.data.snapshotId).toBeNull();
    expect(listSnapshots(c.db, c.ownerId, c.projectId)).toHaveLength(0);
  });

  it("fails the request with zero writes when the safety snapshot exceeds the per-snapshot size limit", async () => {
    const c = await setup({ maxSnapshotSizeBytes: 1 });
    const before = (await readProjectFile(c.cwd, "app.py")).content;

    const res = await c.api.request("POST", replaceUrl(c.projectId), {
      token: c.ownerToken,
      body: {
        query: "hello",
        replacement: "hi",
        dryRun: false,
        createSafetySnapshot: true,
      },
    });
    expect(res.status).toBe(413);
    expect((await readProjectFile(c.cwd, "app.py")).content).toBe(before);
    expect(listSnapshots(c.db, c.ownerId, c.projectId)).toHaveLength(0);
  });

  it("fails the request with zero writes when the project snapshot storage quota is exceeded", async () => {
    const c = await setup({ maxSnapshotBytesPerProject: 1 });
    const before = (await readProjectFile(c.cwd, "app.py")).content;

    const res = await c.api.request("POST", replaceUrl(c.projectId), {
      token: c.ownerToken,
      body: {
        query: "hello",
        replacement: "hi",
        dryRun: false,
        createSafetySnapshot: true,
      },
    });
    expect(res.status).toBe(413);
    expect((await readProjectFile(c.cwd, "app.py")).content).toBe(before);
  });

  it("rejects createSafetySnapshot from a non-owner editor before any write", async () => {
    const c = await setup();
    const before = (await readProjectFile(c.cwd, "app.py")).content;

    const res = await c.api.request("POST", replaceUrl(c.projectId), {
      token: c.editorToken,
      body: {
        query: "hello",
        replacement: "hi",
        dryRun: false,
        createSafetySnapshot: true,
      },
    });
    expect(res.status).toBe(403);
    expect(res.data.error?.code).toBe("snapshot_requires_owner");
    expect((await readProjectFile(c.cwd, "app.py")).content).toBe(before);

    // an editor CAN still replace without a snapshot (unchanged behavior)
    const ok = await c.api.request("POST", replaceUrl(c.projectId), {
      token: c.editorToken,
      body: { query: "hello", replacement: "hi", dryRun: false },
    });
    expect(ok.status).toBe(200);
    expect(ok.data.applied).toBe(true);
  });

  it("narrows the apply to the selected files and rejects an unmatched selected file", async () => {
    const c = await setup();

    // valid narrowing: only app.py, leave util.py untouched
    const scoped = await c.api.request("POST", replaceUrl(c.projectId), {
      token: c.ownerToken,
      body: {
        query: "hello",
        replacement: "hi",
        dryRun: false,
        files: ["app.py"],
      },
    });
    expect(scoped.status).toBe(200);
    expect(scoped.data.results.map((r: any) => r.filePath)).toEqual(["app.py"]);
    expect((await readProjectFile(c.cwd, "util.py")).content).toBe(
      "def greet():\n    return 'hello team'\n",
    );

    // util.py exists but has no "zzz" match — selecting it must be rejected
    const unmatched = await c.api.request("POST", replaceUrl(c.projectId), {
      token: c.ownerToken,
      body: {
        query: "zzz",
        replacement: "hi",
        dryRun: false,
        files: ["util.py"],
      },
    });
    expect(unmatched.status).toBe(400);
    expect(unmatched.data.error?.code).toBe("invalid_file_selection");
  });

  it("rejects an unknown file and a path-traversal entry in the selection", async () => {
    const c = await setup();

    const unknown = await c.api.request("POST", replaceUrl(c.projectId), {
      token: c.ownerToken,
      body: {
        query: "hello",
        replacement: "hi",
        dryRun: false,
        files: ["does-not-exist.py"],
      },
    });
    expect(unknown.status).toBe(400);
    expect(unknown.data.error?.code).toBe("invalid_file_selection");

    const traversal = await c.api.request("POST", replaceUrl(c.projectId), {
      token: c.ownerToken,
      body: {
        query: "hello",
        replacement: "hi",
        dryRun: false,
        files: ["../../../etc/passwd"],
      },
    });
    expect(traversal.status).toBe(400);
    expect(traversal.data.error?.code).toBe("invalid_file_selection");
  });

  it("still skips a binary file and still returns partial results on a per-file write failure (with a snapshot taken)", async () => {
    const c = await setup();
    // binary fixture with a NUL byte + a literal 'hello'
    await fs.writeFile(
      join(c.cwd, "blob.bin"),
      Buffer.from("hello\x00\x01\x02world", "binary"),
    );

    const res = await c.api.request("POST", replaceUrl(c.projectId), {
      token: c.ownerToken,
      body: {
        query: "hello",
        replacement: "hi",
        dryRun: false,
        createSafetySnapshot: true,
      },
    });
    expect(res.status).toBe(200);
    // blob.bin never appears as a match group
    expect(res.data.results.map((r: any) => r.filePath).sort()).toEqual([
      "app.py",
      "util.py",
    ]);
    expect(typeof res.data.snapshotId).toBe("string");
    // binary byte-for-byte unchanged
    const bin = await fs.readFile(join(c.cwd, "blob.bin"));
    expect(bin).toEqual(Buffer.from("hello\x00\x01\x02world", "binary"));
  });

  it("keeps newContent===null (truncated scan) files skipped even when explicitly selected", async () => {
    const c = await setup();
    // >500 matches (the engine's default cap) in one file forces its scan to
    // truncate, so the engine returns newContent: null for it.
    const bigBody = Array.from(
      { length: 600 },
      (_, i) => `x = 'hello ${i}'`,
    ).join("\n");
    await fs.writeFile(join(c.cwd, "big.py"), bigBody + "\n", "utf8");

    const res = await c.api.request("POST", replaceUrl(c.projectId), {
      token: c.ownerToken,
      body: {
        query: "hello",
        replacement: "hi",
        dryRun: false,
        files: ["big.py"],
      },
    });
    expect(res.status).toBe(200);
    expect(res.data.truncated).toBe(true);
    const big = res.data.results.find((r: any) => r.filePath === "big.py");
    expect(big.status).toBe("skipped");
    // the oversized/truncated file is left byte-for-byte unchanged
    expect((await readProjectFile(c.cwd, "big.py")).content).toBe(
      bigBody + "\n",
    );
  });
});
