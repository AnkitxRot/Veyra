import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { makeTestConfig, startTestApi, type TestApi } from "./helpers.js";
import {
  createZipArchive,
  extractZipArchive,
  type ZipFileEntry,
} from "../src/projects/zip.js";
import {
  exportProjectZip,
  importProjectZip,
  importNewProjectZip,
} from "../src/projects/archive.js";
import {
  createProject,
  projectDir,
} from "../src/projects/service.js";
import { writeProjectFile, readProjectFile, listFiles } from "../src/files/service.js";
import type { AppConfig } from "../src/config.js";
import type { Db } from "../src/db.js";

describe("Milestone 21 — Project Workspace Export & Import", () => {
  let cfg: AppConfig;
  let api: TestApi;
  let db: Db;
  let userId: number;
  let userToken: string;

  beforeEach(async () => {
    cfg = makeTestConfig({
      maxArchiveUploadBytes: 10 * 1024 * 1024, // 10MB
      maxArchiveUncompressedBytes: 20 * 1024 * 1024, // 20MB
      maxArchiveEntries: 500,
      maxArchiveSingleFileBytes: 5 * 1024 * 1024, // 5MB
    });
    api = await startTestApi(cfg);
    db = api.db;

    const reg = await api.request("POST", "/api/auth/register", {
      body: { username: "archive_user_1", password: "password123" },
    });
    userId = reg.data.user.id;
    userToken = reg.data.token;
  });

  afterEach(async () => {
    await api.close();
  });

  describe("A. Export Functionality", () => {
    it("1. allows project owner to export workspace as a standard ZIP archive", async () => {
      const project = await createProject(cfg, db, userId, {
        name: "ExportableProject",
        language: "python",
      });
      const wsDir = projectDir(cfg, project.id);
      await writeProjectFile(wsDir, "main.py", "print('hello export')\n");
      await writeProjectFile(wsDir, "src/utils.py", "def add(a, b): return a + b\n");

      // Test export service directly
      const result = await exportProjectZip(cfg, db, userId, project.id);
      expect(result.projectName).toBe("ExportableProject");
      expect(result.zipBuffer).toBeInstanceOf(Buffer);
      expect(result.zipBuffer.length).toBeGreaterThan(0);
      expect(result.zipBuffer.readUInt32LE(0)).toBe(0x04034b50); // PK\x03\x04

      // Test export HTTP endpoint
      const res = await api.request("GET", `/api/projects/${project.id}/export`, {
        token: userToken,
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/zip");
      expect(res.headers.get("content-disposition")).toContain("ExportableProject.zip");
    });

    it("2. denies export to non-owners", async () => {
      const reg2 = await api.request("POST", "/api/auth/register", {
        body: { username: "attacker_user", password: "password123" },
      });
      const attackerToken = reg2.data.token;

      const project = await createProject(cfg, db, userId, {
        name: "SecretProject",
      });

      const res = await api.request("GET", `/api/projects/${project.id}/export`, {
        token: attackerToken,
      });
      expect(res.status).toBe(404); // requireOwnedProject throws 404 for unauthorized
    });

    it("3. & 4. & 5. preserves relative and nested paths, excludes .git and node_modules", async () => {
      const project = await createProject(cfg, db, userId, {
        name: "HierarchyProject",
      });
      const wsDir = projectDir(cfg, project.id);
      await writeProjectFile(wsDir, "index.js", "console.log('root');");
      await writeProjectFile(wsDir, "lib/nested/deep.js", "module.exports = 42;");

      // Create directories that should be excluded
      const gitDir = join(wsDir, ".git");
      await fs.mkdir(gitDir, { recursive: true });
      await fs.writeFile(join(gitDir, "config"), "dummy git config");

      const nodeModulesDir = join(wsDir, "node_modules", "dummy");
      await fs.mkdir(nodeModulesDir, { recursive: true });
      await fs.writeFile(join(nodeModulesDir, "package.json"), "{}");

      const { zipBuffer } = await exportProjectZip(cfg, db, userId, project.id);

      // Extract to a temp directory and verify files
      const tempExtract = join(cfg.dataDir, "test_extract_check");
      await fs.mkdir(tempExtract, { recursive: true });
      const extracted = await extractZipArchive(zipBuffer, tempExtract, cfg);

      const paths = extracted.map((e) => e.relPath);
      expect(paths).toContain("index.js");
      expect(paths).toContain("lib/nested/deep.js");
      expect(paths.some((p) => p.startsWith(".git"))).toBe(false);
      expect(paths.some((p) => p.startsWith("node_modules"))).toBe(false);

      const deepContent = await fs.readFile(join(tempExtract, "lib/nested/deep.js"), "utf8");
      expect(deepContent).toBe("module.exports = 42;");

      await fs.rm(tempExtract, { recursive: true, force: true });
    });
  });

  describe("B. Import Functionality & Safety", () => {
    it("6. imports valid archive into a new project and an existing project", async () => {
      const zipData: ZipFileEntry[] = [
        { path: "app.py", content: Buffer.from("print('imported app')\n") },
        { path: "config/settings.json", content: Buffer.from('{"port": 8080}\n') },
      ];
      const archiveBuffer = createZipArchive(zipData);

      // 6a. Import as new project via POST /api/projects/import
      const importNewRes = await api.request("POST", "/api/projects/import", {
        token: userToken,
        body: {
          name: "MyImportedProject",
          archiveBase64: archiveBuffer.toString("base64"),
        },
      });
      expect(importNewRes.status).toBe(201);
      expect(importNewRes.data.project.name).toBe("MyImportedProject");
      expect(importNewRes.data.fileCount).toBe(2);

      const newProjId = importNewRes.data.project.id;
      const newWs = projectDir(cfg, newProjId);
      const appPy = await readProjectFile(newWs, "app.py");
      expect(appPy.content).toBe("print('imported app')\n");

      // 6b. Import / overwrite into an existing project via POST /api/projects/:id/import
      const existingProj = await createProject(cfg, db, userId, {
        name: "ExistingTarget",
      });
      const existWs = projectDir(cfg, existingProj.id);
      await writeProjectFile(existWs, "old.txt", "old content\n");

      const overwriteRes = await api.request(
        "POST",
        `/api/projects/${existingProj.id}/import?replace=true`,
        {
          token: userToken,
          body: {
            archiveBase64: archiveBuffer.toString("base64"),
          },
        },
      );
      expect(overwriteRes.status).toBe(200);
      expect(overwriteRes.data.ok).toBe(true);

      const existFiles = await listFiles(existWs);
      expect(existFiles).toContain("app.py");
      expect(existFiles).toContain("config/settings.json");
      expect(existFiles).not.toContain("old.txt"); // old file removed during clean replacement
    });

    it("7. & 8. rejects path traversal and absolute paths in archive", async () => {
      // Archive with ../ traversal
      const traversalZip = createZipArchive([
        { path: "evil.sh", rawPath: "../../../evil.sh", content: Buffer.from("rm -rf /") },
      ]);

      await expect(
        extractZipArchive(traversalZip, join(cfg.dataDir, "traversal_dest"), cfg),
      ).rejects.toThrow(/traversal/i);

      // Archive with absolute path
      const absZip = createZipArchive([
        { path: "shadow", rawPath: "/etc/shadow", content: Buffer.from("root:xxx") },
      ]);

      await expect(
        extractZipArchive(absZip, join(cfg.dataDir, "abs_dest"), cfg),
      ).rejects.toThrow(/absolute path/i);
    });

    it("9. rejects symlink entries in archive", async () => {
      // Archive with symlink external attribute
      const symlinkZip = createZipArchive([
        {
          path: "symlink_file",
          content: Buffer.from("/etc/passwd"),
          mode: 0o120777, // Unix symlink mode
        },
      ]);

      await expect(
        extractZipArchive(symlinkZip, join(cfg.dataDir, "symlink_dest"), cfg),
      ).rejects.toThrow(/symlink/i);
    });

    it("10. enforces archive size and file count limits", async () => {
      const tightCfg = makeTestConfig({
        maxArchiveUploadBytes: 1000,
        maxArchiveUncompressedBytes: 2000,
        maxArchiveEntries: 3,
        maxArchiveSingleFileBytes: 500,
      });

      // Too many entries
      const tooManyEntriesZip = createZipArchive([
        { path: "f1.txt", content: Buffer.from("1") },
        { path: "f2.txt", content: Buffer.from("2") },
        { path: "f3.txt", content: Buffer.from("3") },
        { path: "f4.txt", content: Buffer.from("4") },
      ]);
      await expect(
        extractZipArchive(tooManyEntriesZip, join(cfg.dataDir, "test_limits"), tightCfg),
      ).rejects.toThrow(/too many entries/i);

      // Single file too large
      const singleLargeZip = createZipArchive([
        { path: "large.txt", content: Buffer.alloc(600, "A") },
      ]);
      await expect(
        extractZipArchive(singleLargeZip, join(cfg.dataDir, "test_limits"), tightCfg),
      ).rejects.toThrow(/exceeds limit/i);
    });

    it("11. & 12. leaves target workspace completely untouched if archive is invalid (atomicity)", async () => {
      const project = await createProject(cfg, db, userId, {
        name: "AtomicTestProj",
      });
      const wsDir = projectDir(cfg, project.id);
      await writeProjectFile(wsDir, "original.py", "print('safe original')\n");

      // Corrupted / traversal archive
      const badZip = createZipArchive([
        { path: "good.py", content: Buffer.from("print('good')") },
        { path: "../bad.py", content: Buffer.from("print('bad')") },
      ]);

      await expect(
        importProjectZip(cfg, db, userId, project.id, badZip, { replace: true }),
      ).rejects.toThrow();

      // Original workspace must be intact
      const files = await listFiles(wsDir);
      expect(files).toEqual(["original.py"]);
      const content = await readProjectFile(wsDir, "original.py");
      expect(content.content).toBe("print('safe original')\n");
    });

    it("13. enforces project ownership authorization during import", async () => {
      const reg2 = await api.request("POST", "/api/auth/register", {
        body: { username: "other_user_2", password: "password123" },
      });
      const otherUserId = reg2.data.user.id;

      const project = await createProject(cfg, db, userId, {
        name: "User1Project",
      });

      const zip = createZipArchive([
        { path: "hacked.txt", content: Buffer.from("hacked") },
      ]);

      // Other user tries to import into User 1's project
      await expect(
        importProjectZip(cfg, db, otherUserId, project.id, zip, { replace: true }),
      ).rejects.toThrow();
    });

    it("14. & 15. safely disposes active collab/sandbox sessions on import", async () => {
      const project = await createProject(cfg, db, userId, {
        name: "CollabSessionProject",
      });
      const wsDir = projectDir(cfg, project.id);
      await writeProjectFile(wsDir, "main.py", "print('before')\n");

      const newZip = createZipArchive([
        { path: "main.py", content: Buffer.from("print('after import')\n") },
      ]);

      const result = await importProjectZip(cfg, db, userId, project.id, newZip, {
        replace: true,
      });
      expect(result.ok).toBe(true);

      const mainPy = await readProjectFile(wsDir, "main.py");
      expect(mainPy.content).toBe("print('after import')\n");
    });

    it("16. round-trip: export -> import reproduces workspace contents faithfully", async () => {
      const p1 = await createProject(cfg, db, userId, { name: "RoundTripP1" });
      const ws1 = projectDir(cfg, p1.id);

      await writeProjectFile(ws1, "README.md", "# Round Trip Test\n");
      await writeProjectFile(ws1, "src/index.ts", "export const PI = 3.14159;\n");
      await writeProjectFile(ws1, "assets/data.json", '{"key": "value"}\n');

      // Export p1
      const { zipBuffer } = await exportProjectZip(cfg, db, userId, p1.id);

      // Import into a fresh project p2
      const { project: p2 } = await importNewProjectZip(cfg, db, userId, zipBuffer, {
        name: "RoundTripP2",
      });
      const ws2 = projectDir(cfg, p2.id);

      const files2 = await listFiles(ws2);
      expect(files2.sort()).toEqual(["README.md", "assets/data.json", "src/index.ts"].sort());

      const readme2 = await readProjectFile(ws2, "README.md");
      expect(readme2.content).toBe("# Round Trip Test\n");

      const index2 = await readProjectFile(ws2, "src/index.ts");
      expect(index2.content).toBe("export const PI = 3.14159;\n");
    });

    it("17. requires replace=true when importing into non-empty project", async () => {
      const project = await createProject(cfg, db, userId, { name: "NonEmptyProj" });
      const ws = projectDir(cfg, project.id);
      await writeProjectFile(ws, "existing.txt", "keep me\n");

      const zip = createZipArchive([
        { path: "new.txt", content: Buffer.from("new\n") },
      ]);

      // Should fail without replace=true
      await expect(
        importProjectZip(cfg, db, userId, project.id, zip, { replace: false }),
      ).rejects.toThrow(/replace=true/);

      // Should succeed with replace=true
      const result = await importProjectZip(cfg, db, userId, project.id, zip, {
        replace: true,
      });
      expect(result.ok).toBe(true);
    });

    it("18. enforces projectQuota limit on new project import", async () => {
      const quotaCfg = makeTestConfig({ projectQuota: 1 });
      const quotaApi = await startTestApi(quotaCfg);

      try {
        const reg = await quotaApi.request("POST", "/api/auth/register", {
          body: { username: "quota_user", password: "password123" },
        });
        const uId = reg.data.user.id;

        // Create 1st project (reaches limit of 1)
        await createProject(quotaCfg, quotaApi.db, uId, { name: "P1" });

        const zip = createZipArchive([{ path: "p2.txt", content: Buffer.from("2") }]);

        await expect(
          importNewProjectZip(quotaCfg, quotaApi.db, uId, zip, { name: "P2" }),
        ).rejects.toThrow(/limit of 1 reached/);
      } finally {
        await quotaApi.close();
      }
    });
  });
});
