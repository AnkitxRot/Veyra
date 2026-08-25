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
import type { AppConfig } from "../src/config.js";
import type { Db } from "../src/db.js";
import {
  createProject,
  workspacePath,
  addProjectCollaborator,
} from "../src/projects/service.js";
import { readProjectFile } from "../src/files/service.js";

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
});
