import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDb } from "../src/db.js";
import { resolveConfig } from "../src/config.js";
import {
  DeterministicEngineeringProvider,
  type AIContextBundle,
} from "../src/ai/provider.js";
import { buildAIContext } from "../src/ai/context.js";
import { runAIVerification } from "../src/ai/verify.js";
import { collaborationManager } from "../src/collab/manager.js";
import {
  createProject,
  requireProjectAccess,
  projectDir,
} from "../src/projects/service.js";
import { promises as fs, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("M5 — Verification-Aware AI Engineering Assistant", () => {
  let db: any;
  let cfg: any;
  let tempWorkspacesDir: string;

  beforeEach(() => {
    tempWorkspacesDir = mkdtempSync(join(tmpdir(), "cloudide-m5-test-"));
    db = openDb(":memory:");
    cfg = {
      ...resolveConfig(),
      workspacesDir: tempWorkspacesDir,
    };
    collaborationManager.init(cfg, db);
  });

  afterEach(() => {
    try {
      rmSync(tempWorkspacesDir, { recursive: true, force: true });
    } catch {}
  });

  it("1. AI Provider Abstraction: Deterministic engine generates structured explanation & patch", async () => {
    const provider = new DeterministicEngineeringProvider();
    expect(provider.id).toBe("deterministic-engine");
    expect(provider.type).toBe("deterministic");

    const samplePythonCode = `def divide(a, b):\n    return a / b\n`;
    const context: AIContextBundle = {
      projectId: "proj-1",
      activeFilePath: "calc.py",
      fileContent: samplePythonCode,
      language: "python",
      diagnostics: [
        {
          message: "ZeroDivisionError: division by zero",
          line: 2,
          source: "python",
          severity: "error",
        },
      ],
      recentExecution: {
        exitCode: 1,
        stdout: "",
        stderr: "ZeroDivisionError: division by zero on line 2",
      },
    };

    // Test Explain
    const explainRes = await provider.executeAction("explain", context);
    expect(explainRes.action).toBe("explain");
    expect(explainRes.providerType).toBe("deterministic");
    expect(explainRes.rootCause).toContain("ZeroDivisionError");
    expect(explainRes.evidence.length).toBeGreaterThan(0);
    expect(explainRes.approxTokens.input).toBeGreaterThan(0);

    // Test Fix Error (Produces Structured Patch)
    const fixRes = await provider.executeAction("fix_error", context);
    expect(fixRes.patch).not.toBeNull();
    expect(fixRes.patch?.filePath).toBe("calc.py");
    expect(fixRes.patch?.modifiedContent).toContain("if b == 0:");
    expect(fixRes.patch?.explanation).toContain("guard");

    // Test Generate Tests
    const testRes = await provider.executeAction("generate_tests", context);
    expect(testRes.suggestedTests).toContain("import pytest");
    expect(testRes.patch?.filePath).toContain("_test.py");
  });

  it("2. Context Engine: Bounded, deduplicated context assembly", async () => {
    db.prepare(
      "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
    ).run("evaluator", "h", "user");
    const project = await createProject(cfg, db, 1, { name: "ContextTest" });
    const pDir = projectDir(cfg, project.id);
    await fs.writeFile(
      join(pDir, "main.py"),
      'print("Hello World")\n'.repeat(50),
      "utf-8",
    );

    // Record a failed run in database
    db.prepare(
      `INSERT INTO runs (id, project_id, user_id, language, file_path, status, exit_code, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("run-1", project.id, 1, "python", "main.py", "failed", 1, 120);

    const context = await buildAIContext(cfg, db, project.id, 1, {
      activeFilePath: "main.py",
      maxChars: 500,
    });

    expect(context.projectId).toBe(project.id);
    expect(context.activeFilePath).toBe("main.py");
    expect(context.language).toBe("python");
    expect(context.recentExecution?.stderr).toContain("failed");
    expect(context.fileContent.length).toBeLessThanOrEqual(600); // Enforces budget
  });

  it("2b. Context Engine: search step is bounded by the shared searchGate and degrades gracefully when exhausted", async () => {
    db.prepare(
      "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
    ).run("evaluator2", "h", "user");
    const project = await createProject(cfg, db, 1, { name: "GateTest" });
    const pDir = projectDir(cfg, project.id);
    await fs.writeFile(
      join(pDir, "main.py"),
      "def hello():\n    print('hi')\n",
      "utf-8",
    );

    const { searchGate } = await import("../src/execution/runGate.js");
    // Distinctive from the project's owner id (1): `searchGate` is a
    // process-wide singleton shared across all test files (each with its
    // own isolated in-memory DB, but the gate is keyed by raw numeric id
    // regardless of which DB it came from). Using an id no other suite
    // would plausibly assign avoids any cross-file interference on that
    // shared state.
    const userId = 999001;

    // Exhaust this user's search-worker budget before the call, as if a
    // burst of concurrent search/AI requests had already claimed every
    // slot. buildAIContext's search step spawns a real worker thread (see
    // search.ts), so it must respect the same per-user cap /search uses —
    // otherwise it would be an unbounded worker-thread-spawn path outside
    // that budget's coverage.
    const max = cfg.maxConcurrentRuns;
    for (let i = 0; i < max; i++) {
      expect(searchGate.acquire(userId, max)).toBe(true);
    }
    expect(searchGate.acquire(userId, max)).toBe(false); // confirms exhausted

    try {
      const context = await buildAIContext(cfg, db, project.id, userId, {
        activeFilePath: "main.py",
        searchQuery: "hello",
      });

      // Degrades gracefully: no search results, but the action's other
      // context (file content, language) is still assembled normally —
      // a busy search budget must not fail the whole AI action.
      expect(context.searchResults).toBeUndefined();
      expect(context.fileContent).toContain("hello");
    } finally {
      // Release the slots this test artificially held, so it doesn't leak
      // state into other tests sharing the process-wide searchGate.
      for (let i = 0; i < max; i++) {
        searchGate.release(userId);
      }
    }
  });

  it("3. Verification Pipeline: Explicit Skip Verification results in UNVERIFIED status with journal audit", async () => {
    db.prepare(
      "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
    ).run("evaluator", "h", "user");
    const project = await createProject(cfg, db, 1, { name: "SkipVerifTest" });

    const result = await runAIVerification(cfg, db, {
      projectId: project.id,
      userId: 1,
      action: "fix_error",
      providerType: "deterministic",
      modelName: "Deterministic-Engine",
      filePath: "main.py",
      explanation: "Applied zero guard",
      diffSummary: "+3 -1 lines",
      skipVerification: true,
    });

    // INVARIANT: Skipped verification MUST be classified as UNVERIFIED
    expect(result.status).toBe("UNVERIFIED");
    expect(result.skipReason).toBe("Verification skipped by user.");

    // Journal table record assertion
    const row = db
      .prepare("SELECT * FROM ai_verifications WHERE id = ?")
      .get(result.id) as any;
    expect(row).not.toBeUndefined();
    expect(row.status).toBe("UNVERIFIED");
    expect(row.skip_reason).toBe("Verification skipped by user.");
    expect(row.project_id).toBe(project.id);
  });

  it("4. Multi-Tenant Security: Unauthorized access rejected across user boundaries", async () => {
    db.prepare(
      "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
    ).run("alice", "h", "user"); // id 1
    db.prepare(
      "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
    ).run("bob", "h", "user"); // id 2

    const project = await createProject(cfg, db, 1, { name: "AliceProj" });

    // Alice has access
    expect(requireProjectAccess(db, 1, project.id, "editor").role).toBe(
      "owner",
    );

    // Bob has NO access
    expect(() =>
      requireProjectAccess(db, 2, project.id, "editor"),
    ).toThrowError(/not found/);
  });

  it("5. Multiplayer Yjs Integration: Accepted patch propagates via CRDT room", async () => {
    db.prepare(
      "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
    ).run("alice", "h", "user");
    const project = await createProject(cfg, db, 1, { name: "CollabAIPatch" });
    const pDir = projectDir(cfg, project.id);
    await fs.writeFile(
      join(pDir, "math.py"),
      "def calculate():\n    return 10 / 0\n",
      "utf-8",
    );

    // Connect room
    const room = collaborationManager.getOrCreateRoom(project.id);
    const yText = await room.ensureFileLoaded("math.py");
    expect(yText.toString()).toContain("10 / 0");

    // Apply AI Patch via external mutation
    const patchedContent =
      "def calculate():\n    # AI Patched\n    return 10\n";
    await fs.writeFile(join(pDir, "math.py"), patchedContent, "utf-8");
    await collaborationManager.notifyExternalFileMutation(
      project.id,
      "math.py",
      patchedContent,
    );

    // CRITICAL COLLABORATION INVARIANT: In-memory Y.Doc updates to match patched code
    expect(yText.toString()).toBe(patchedContent);
  });
});
