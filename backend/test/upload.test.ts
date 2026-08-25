import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { makeTestConfig, startTestApi, type TestApi } from "./helpers.js";
import type { AppConfig } from "../src/config.js";
import type { Db } from "../src/db.js";
import { createProject, deleteProject, getProject, workspacePath } from "../src/projects/service.js";
import { uploadProjectFiles, parseMultipartFormData } from "../src/files/upload.js";
import { readProjectFile, listFiles } from "../src/files/service.js";
import { queryAuditLogs } from "../src/audit.js";

describe("Milestone 24 — Direct Workspace File & Folder Upload", () => {
  let cfg: AppConfig;
  let db: Db;
  let api: TestApi;
  let ownerId: number;
  let ownerToken: string;
  let otherUserId: number;
  let otherUserToken: string;
  let projectId: string;
  let cwd: string;

  beforeEach(async () => {
    cfg = makeTestConfig();
    api = await startTestApi(cfg);
    db = api.db;

    const reg1 = await api.request("POST", "/api/auth/register", {
      body: { username: "uploadowner", password: "password123" },
    });
    ownerId = reg1.data.user.id;
    ownerToken = reg1.data.token;

    const reg2 = await api.request("POST", "/api/auth/register", {
      body: { username: "uploadintruder", password: "password123" },
    });
    otherUserId = reg2.data.user.id;
    otherUserToken = reg2.data.token;

    const proj = await createProject(cfg, db, ownerId, {
      name: "upload-test-project",
      language: "python",
    });
    projectId = proj.id;
    cwd = await workspacePath(cfg, projectId);
  });

  afterEach(async () => {
    await api.close();
    try {
      await fs.rm(cfg.dataDir, { recursive: true, force: true });
    } catch {}
  });

  it("1. owner uploads one file into workspace root", async () => {
    const result = await uploadProjectFiles(cfg, db, ownerId, projectId, {
      files: [{ path: "hello.txt", buffer: Buffer.from("Hello World!", "utf8") }],
    });

    expect(result.ok).toBe(true);
    expect(result.fileCount).toBe(1);
    expect(result.uploadedFiles).toEqual(["hello.txt"]);

    const file = await readProjectFile(cwd, "hello.txt");
    expect(file.content).toBe("Hello World!");

    // Audit log verification
    const logs = queryAuditLogs(db, { projectId, eventType: "PROJECT_FILES_UPLOADED" });
    expect(logs.total).toBe(1);
    expect(logs.logs[0].details.fileCount).toBe(1);
  });

  it("2. non-owner is denied upload with 403 forbidden", async () => {
    await expect(
      uploadProjectFiles(cfg, db, otherUserId, projectId, {
        files: [{ path: "hack.txt", buffer: Buffer.from("evil") }],
      }),
    ).rejects.toThrow(/project (owner permission required|not found)/);

    // Also via HTTP endpoint
    const res = await api.request("POST", `/api/projects/${projectId}/upload`, {
      token: otherUserToken,
      body: { files: [{ path: "hack.txt", content: "evil" }] },
    });
    expect([403, 404]).toContain(res.status);
  });

  it("3. uploads into nested target directory correctly", async () => {
    const result = await uploadProjectFiles(cfg, db, ownerId, projectId, {
      targetDir: "src/utils",
      files: [{ path: "math.ts", buffer: Buffer.from("export const add = (a, b) => a + b;") }],
    });

    expect(result.ok).toBe(true);
    expect(result.uploadedFiles).toEqual(["src/utils/math.ts"]);

    const file = await readProjectFile(cwd, "src/utils/math.ts");
    expect(file.content).toContain("export const add");
  });

  it("4. rejects path traversal attempts (../)", async () => {
    await expect(
      uploadProjectFiles(cfg, db, ownerId, projectId, {
        files: [{ path: "../../evil.sh", buffer: Buffer.from("rm -rf /") }],
      }),
    ).rejects.toThrow(/escapes the workspace/);

    await expect(
      uploadProjectFiles(cfg, db, ownerId, projectId, {
        targetDir: "subdir",
        files: [{ path: "../../../etc/passwd", buffer: Buffer.from("root:x:0:0") }],
      }),
    ).rejects.toThrow(/escapes the workspace/);
  });

  it("5. rejects absolute path attempts", async () => {
    await expect(
      uploadProjectFiles(cfg, db, ownerId, projectId, {
        files: [{ path: "/etc/shadow", buffer: Buffer.from("secret") }],
      }),
    ).rejects.toThrow(/escapes the workspace/);

    await expect(
      uploadProjectFiles(cfg, db, ownerId, projectId, {
        files: [{ path: "C:\\Windows\\System32\\cmd.exe", buffer: Buffer.from("binary") }],
      }),
    ).rejects.toThrow(/escapes the workspace/);
  });

  it("6. rejects null bytes in filenames", async () => {
    await expect(
      uploadProjectFiles(cfg, db, ownerId, projectId, {
        files: [{ path: "innocent.txt\0.exe", buffer: Buffer.from("payload") }],
      }),
    ).rejects.toThrow(/escapes the workspace/);
  });

  it("7. enforces aggregate upload byte limit", async () => {
    const customCfg = { ...cfg, maxAggregateUploadBytes: 100 };
    const bigData = Buffer.alloc(120, "x");

    await expect(
      uploadProjectFiles(customCfg, db, ownerId, projectId, {
        files: [{ path: "big.dat", buffer: bigData }],
      }),
    ).rejects.toThrow(/Aggregate upload size/);
  });

  it("8. enforces single-file upload byte limit", async () => {
    const customCfg = { ...cfg, maxSingleUploadFileBytes: 50, maxAggregateUploadBytes: 500 };
    const bigFile = Buffer.alloc(60, "x");

    await expect(
      uploadProjectFiles(customCfg, db, ownerId, projectId, {
        files: [{ path: "large.dat", buffer: bigFile }],
      }),
    ).rejects.toThrow(/exceeds single-file limit/);
  });

  it("9. enforces maximum file count limit", async () => {
    const customCfg = { ...cfg, maxUploadFileCount: 2 };
    const items = [
      { path: "f1.txt", buffer: Buffer.from("1") },
      { path: "f2.txt", buffer: Buffer.from("2") },
      { path: "f3.txt", buffer: Buffer.from("3") },
    ];

    await expect(
      uploadProjectFiles(customCfg, db, ownerId, projectId, {
        files: items,
      }),
    ).rejects.toThrow(/Exceeded maximum uploaded file count/);
  });

  it("10. preserves full multi-level folder structure on folder upload", async () => {
    const folderFiles = [
      { path: "components/Button/Button.tsx", buffer: Buffer.from("export const Button = () => null;") },
      { path: "components/Button/Button.css", buffer: Buffer.from(".btn { color: red; }") },
      { path: "components/Card/Card.tsx", buffer: Buffer.from("export const Card = () => null;") },
      { path: "components/index.ts", buffer: Buffer.from("export * from './Button/Button';") },
    ];

    const result = await uploadProjectFiles(cfg, db, ownerId, projectId, {
      targetDir: "src",
      files: folderFiles,
    });

    expect(result.ok).toBe(true);
    expect(result.fileCount).toBe(4);

    const btn = await readProjectFile(cwd, "src/components/Button/Button.tsx");
    expect(btn.content).toContain("Button");

    const css = await readProjectFile(cwd, "src/components/Button/Button.css");
    expect(css.content).toContain(".btn");

    const all = await listFiles(cwd);
    expect(all).toContain("src/components/Button/Button.tsx");
    expect(all).toContain("src/components/Button/Button.css");
    expect(all).toContain("src/components/Card/Card.tsx");
    expect(all).toContain("src/components/index.ts");
  });

  it("11. enforces overwrite policy: fails on existing file when overwrite=false and succeeds when overwrite=true", async () => {
    // Initial upload
    await uploadProjectFiles(cfg, db, ownerId, projectId, {
      files: [{ path: "app.py", buffer: Buffer.from("version = 1") }],
    });

    // Attempt overwrite without overwrite=true -> 409 conflict
    await expect(
      uploadProjectFiles(cfg, db, ownerId, projectId, {
        overwrite: false,
        files: [{ path: "app.py", buffer: Buffer.from("version = 2") }],
      }),
    ).rejects.toThrow(/File\(s\) already exist/);

    const unchanged = await readProjectFile(cwd, "app.py");
    expect(unchanged.content).toBe("version = 1");

    // Overwrite with overwrite=true -> succeeds
    const result = await uploadProjectFiles(cfg, db, ownerId, projectId, {
      overwrite: true,
      files: [{ path: "app.py", buffer: Buffer.from("version = 2") }],
    });
    expect(result.ok).toBe(true);

    const updated = await readProjectFile(cwd, "app.py");
    expect(updated.content).toBe("version = 2");
  });

  it("12. validation failure leaves workspace completely unchanged (atomic staging)", async () => {
    await uploadProjectFiles(cfg, db, ownerId, projectId, {
      files: [{ path: "initial.txt", buffer: Buffer.from("untouched") }],
    });

    const initialFilesBefore = await listFiles(cwd);

    // Batch containing 1 good file and 1 malicious traversal file
    await expect(
      uploadProjectFiles(cfg, db, ownerId, projectId, {
        files: [
          { path: "good.txt", buffer: Buffer.from("I should not be written") },
          { path: "../../escape.txt", buffer: Buffer.from("evil") },
        ],
      }),
    ).rejects.toThrow(/escapes the workspace/);

    const filesAfter = await listFiles(cwd);
    expect(filesAfter).toEqual(initialFilesBefore);
    expect(filesAfter).not.toContain("good.txt");
  });

  it("13. cleans staging directory on failure", async () => {
    const customCfg = { ...cfg, maxSingleUploadFileBytes: 10 };
    await expect(
      uploadProjectFiles(customCfg, db, ownerId, projectId, {
        files: [{ path: "toolarge.txt", buffer: Buffer.alloc(20, "x") }],
      }),
    ).rejects.toThrow(/exceeds single-file limit/);

    // Verify no stray tmp_upload_* directories in dataDir
    const entries = await fs.readdir(cfg.dataDir);
    const tmpUploads = entries.filter((e) => e.startsWith("tmp_upload_"));
    expect(tmpUploads.length).toBe(0);
  });

  it("14. handles concurrent uploads safely", async () => {
    const upload1 = uploadProjectFiles(cfg, db, ownerId, projectId, {
      files: [{ path: "file1.txt", buffer: Buffer.from("data1") }],
    });
    const upload2 = uploadProjectFiles(cfg, db, ownerId, projectId, {
      files: [{ path: "file2.txt", buffer: Buffer.from("data2") }],
    });

    const [r1, r2] = await Promise.all([upload1, upload2]);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);

    const f1 = await readProjectFile(cwd, "file1.txt");
    const f2 = await readProjectFile(cwd, "file2.txt");
    expect(f1.content).toBe("data1");
    expect(f2.content).toBe("data2");
  });

  it("15. binary file fidelity: preserves arbitrary binary bytes without corruption", async () => {
    // Create random 1KB binary buffer
    const binaryData = Buffer.alloc(1024);
    for (let i = 0; i < 1024; i++) {
      binaryData[i] = i % 256;
    }

    const result = await uploadProjectFiles(cfg, db, ownerId, projectId, {
      files: [{ path: "image.png", buffer: binaryData }],
    });
    expect(result.ok).toBe(true);

    const writtenBuffer = await fs.readFile(join(cwd, "image.png"));
    expect(Buffer.compare(binaryData, writtenBuffer)).toBe(0);
  });

  it("16. supports empty 0-byte file uploads", async () => {
    const result = await uploadProjectFiles(cfg, db, ownerId, projectId, {
      files: [{ path: "__init__.py", buffer: Buffer.alloc(0) }],
    });
    expect(result.ok).toBe(true);

    const file = await readProjectFile(cwd, "__init__.py");
    expect(file.content).toBe("");
    expect(file.size).toBe(0);
  });

  it("17. project deletion cleans workspace and associated resources", async () => {
    await uploadProjectFiles(cfg, db, ownerId, projectId, {
      files: [{ path: "data.txt", buffer: Buffer.from("hello") }],
    });

    await deleteProject(cfg, db, ownerId, projectId);
    expect(getProject(db, projectId)).toBeNull();
  });

  it("18. multipart/form-data parser parses fields and files accurately", () => {
    const boundary = "----WebKitFormBoundary7MA4YWxkTrZu0gW";
    const bodyStr =
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="targetDir"\r\n\r\n` +
      `src/sub\r\n` +
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="overwrite"\r\n\r\n` +
      `true\r\n` +
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="files"; filename="nested/app.py"\r\n` +
      `Content-Type: text/plain\r\n\r\n` +
      `print('hello world')\r\n` +
      `--${boundary}--\r\n`;

    const bodyBuffer = Buffer.from(bodyStr, "utf8");
    const contentType = `multipart/form-data; boundary=${boundary}`;

    const parsed = parseMultipartFormData(bodyBuffer, contentType);
    expect(parsed.fields.targetDir).toBe("src/sub");
    expect(parsed.fields.overwrite).toBe("true");
    expect(parsed.files.length).toBe(1);
    expect(parsed.files[0].path).toBe("nested/app.py");
    expect(parsed.files[0].buffer.toString("utf8")).toBe("print('hello world')");
  });

  it("19. HTTP POST /:id/upload endpoint accepts JSON payload and updates workspace", async () => {
    const res = await api.request("POST", `/api/projects/${projectId}/upload`, {
      token: ownerToken,
      body: {
        targetDir: "docs",
        files: [
          { path: "README.md", content: "# API Docs" },
          { path: "guide.txt", content: "Guide content" },
        ],
      },
    });

    expect(res.status).toBe(200);
    expect(res.data.ok).toBe(true);
    expect(res.data.fileCount).toBe(2);

    const readme = await readProjectFile(cwd, "docs/README.md");
    expect(readme.content).toBe("# API Docs");
  });

  it("20. HTTP POST /:id/upload handles multipart binary upload", async () => {
    const boundary = "----WebKitFormBoundaryUploadTest123";
    const bodyStr =
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="targetDir"\r\n\r\n` +
      `scripts\r\n` +
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="files"; filename="build.sh"\r\n` +
      `Content-Type: application/x-sh\r\n\r\n` +
      `#!/bin/bash\necho ok\n\r\n` +
      `--${boundary}--\r\n`;

    const res = await fetch(`${api.base}/api/projects/${projectId}/upload`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ownerToken}`,
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
      },
      body: Buffer.from(bodyStr, "utf8"),
    });

    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.ok).toBe(true);
    expect(data.uploadedFiles).toContain("scripts/build.sh");

    const file = await readProjectFile(cwd, "scripts/build.sh");
    expect(file.content).toContain("#!/bin/bash");
  });
});
