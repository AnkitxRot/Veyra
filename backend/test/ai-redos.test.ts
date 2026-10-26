import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDb } from "../src/db.js";
import { resolveConfig } from "../src/config.js";
import {
  DeterministicEngineeringProvider,
  type AIContextBundle,
} from "../src/ai/provider.js";
import { buildAIContext } from "../src/ai/context.js";
import { collaborationManager } from "../src/collab/manager.js";
import { createProject, projectDir } from "../src/projects/service.js";
import { promises as fs, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("M97 — AI context/provider are bounded against pathological input", () => {
  let db: any;
  let cfg: any;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cloudide-ai-redos-"));
    db = openDb(":memory:");
    cfg = { ...resolveConfig(), workspacesDir: dir };
    collaborationManager.init(cfg, db);
  });

  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  });

  it("caps a selection window over one huge line to maxChars", async () => {
    db.prepare(
      "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
    ).run("redos", "h", "user");
    const project = await createProject(cfg, db, 1, { name: "Redos" });
    await fs.writeFile(
      join(projectDir(cfg, project.id), "x.py"),
      "a".repeat(1_000_000),
      "utf-8",
    );
    const ctx = await buildAIContext(cfg, db, project.id, 1, {
      activeFilePath: "x.py",
      selectionRange: { startLine: 1, endLine: 1, startColumn: 0, endColumn: 0 },
    });
    expect(ctx.fileContent.length).toBeLessThanOrEqual(16000 + 200);
  });

  it("fix_error rewrite stays fast on a large slash-free token", async () => {
    const bundle: AIContextBundle = {
      projectId: "p",
      activeFilePath: "x.py",
      fileContent: "a".repeat(200_000),
      language: "python",
      diagnostics: [
        { message: "ZeroDivisionError", line: 1, source: "x", severity: "error" },
      ],
    };
    const t0 = Date.now();
    await new DeterministicEngineeringProvider().executeAction("fix_error", bundle);
    expect(Date.now() - t0).toBeLessThan(500);
  });
});
