import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { makeTestConfig } from "./helpers.js";
import { openDb, type Db } from "../src/db.js";

/**
 * `POST /api/projects/:id/ai/verify` runs an authoritative sandbox execution
 * via `runProject`, so it must consume the same per-user `runGate` budget as
 * the REST run, WebSocket execute and install entry points. Without that gate
 * a client could loop this one route and spawn unbounded concurrent
 * `docker exec` processes, bypassing `maxConcurrentRuns` entirely.
 *
 * `runProject` is mocked so these stay Docker-independent. `workspacePath` is
 * mocked too: the real one throws ApiError(404) when the dir is absent, which
 * `runAIVerification`'s catch block would quietly turn into status 'FAILED' —
 * masking whether the gate did anything.
 */

// `runGate` is a process-wide singleton shared across every test file. Use ids
// no other suite would plausibly assign so concurrent files can't interfere.
const PROJECT_ID = "proj-ai-verify-gate";
const USER_ID = 999101;
const OTHER_USER_ID = 999102;

function baseRequest(userId: number = USER_ID) {
  return {
    projectId: PROJECT_ID,
    userId,
    action: "fix_error",
    providerType: "deterministic",
    modelName: "Deterministic-Engine",
    filePath: "main.py",
    explanation: "Applied zero guard",
    skipVerification: false,
  };
}

const OK_RESULT = {
  type: "ran",
  exitCode: 0,
  stdout: "ok",
  stderr: "",
} as const;

/**
 * Mocks the pipeline with a `runProject` that stays pending until `release()`
 * is called, letting a test hold one run in flight while it fires a second.
 */
async function loadVerifyWithPendingRun(result: Record<string, unknown>) {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const runProject = vi.fn(async () => {
    await gate;
    return result;
  });

  vi.doMock("../src/execution/pipeline.js", () => ({ runProject }));
  vi.doMock("../src/projects/service.js", () => ({
    workspacePath: async () => "/tmp/does-not-matter",
  }));

  const { runAIVerification } = await import("../src/ai/verify.js");
  return { runAIVerification, runProject, release };
}

/** Lets pending microtasks settle so in-flight calls reach their await point. */
async function flush() {
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe("AI verification honours the per-user runGate", () => {
  let db: Db;

  beforeEach(() => {
    vi.resetModules();
    db = openDb(":memory:");
    // ai_verifications has FK references to users(id) and projects(id), so the
    // journal INSERT needs these rows to exist. Inserted directly with explicit
    // ids because projects/service.js is mocked out below.
    for (const id of [USER_ID, OTHER_USER_ID]) {
      db.prepare(
        "INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)",
      ).run(id, `gate-user-${id}`, "h", "user");
    }
    db.prepare(
      "INSERT INTO projects (id, owner_id, name, language) VALUES (?, ?, ?, ?)",
    ).run(PROJECT_ID, USER_ID, "GateVerifyTest", "python");
  });

  afterEach(() => {
    vi.doUnmock("../src/execution/pipeline.js");
    vi.doUnmock("../src/projects/service.js");
    vi.resetModules();
  });

  it("blocks a second concurrent verification for the same user instead of running it", async () => {
    const cfg = makeTestConfig({ maxConcurrentRuns: 1 });
    const { runAIVerification, runProject, release } =
      await loadVerifyWithPendingRun(OK_RESULT);

    // First call takes the single slot and parks inside the mocked runProject.
    const first = runAIVerification(cfg as any, db, baseRequest() as any);
    await flush();
    expect(runProject).toHaveBeenCalledTimes(1);

    // Second call arrives while the first still holds the slot. Deliberately
    // not awaited yet: without the gate this would enter the mocked runProject
    // and hang on its pending promise, so awaiting here would surface as an
    // opaque 60s timeout instead of a clear call-count failure.
    const secondPromise = runAIVerification(
      cfg as any,
      db,
      baseRequest() as any,
    );
    await flush();

    // The gate must reject it outright — not queue it, not run it anyway.
    expect(runProject).toHaveBeenCalledTimes(1);

    const second = await secondPromise;
    expect(second.status).toBe("UNVERIFIED");
    expect(second.skipReason).toMatch(/too many concurrent/i);
    expect(second.exitCode).toBeNull();

    // Blocked attempts still degrade gracefully: journalled, not thrown.
    const row = db
      .prepare("SELECT * FROM ai_verifications WHERE id = ?")
      .get(second.id) as any;
    expect(row).not.toBeUndefined();
    expect(row.status).toBe("UNVERIFIED");
    expect(row.skip_reason).toMatch(/too many concurrent/i);

    // The first run still completes normally once unblocked.
    release();
    const firstResult = await first;
    expect(firstResult.status).toBe("VERIFIED");
    expect(firstResult.exitCode).toBe(0);
    expect(runProject).toHaveBeenCalledTimes(1);
  });

  it("releases the slot so sequential verifications for the same user both run", async () => {
    const cfg = makeTestConfig({ maxConcurrentRuns: 1 });
    const { runAIVerification, runProject, release } =
      await loadVerifyWithPendingRun(OK_RESULT);
    release(); // never pend: each call resolves immediately

    const first = await runAIVerification(cfg as any, db, baseRequest() as any);
    const second = await runAIVerification(
      cfg as any,
      db,
      baseRequest() as any,
    );

    // Non-overlapping requests must not be penalised by the gate.
    expect(runProject).toHaveBeenCalledTimes(2);
    expect(first.status).toBe("VERIFIED");
    expect(second.status).toBe("VERIFIED");
    expect(second.skipReason).toBeUndefined();
  });

  it("budgets per user, so one user's in-flight run does not block another", async () => {
    const cfg = makeTestConfig({ maxConcurrentRuns: 1 });
    const { runAIVerification, runProject, release } =
      await loadVerifyWithPendingRun(OK_RESULT);

    const mine = runAIVerification(cfg as any, db, baseRequest() as any);
    await flush();
    expect(runProject).toHaveBeenCalledTimes(1);

    const theirs = runAIVerification(
      cfg as any,
      db,
      baseRequest(OTHER_USER_ID) as any,
    );
    await flush();

    // Separate user, separate budget — must have been allowed to start.
    expect(runProject).toHaveBeenCalledTimes(2);

    release();
    expect((await mine).status).toBe("VERIFIED");
    expect((await theirs).status).toBe("VERIFIED");
  });

  it("does not consume a run slot when verification is explicitly skipped", async () => {
    const cfg = makeTestConfig({ maxConcurrentRuns: 1 });
    const { runAIVerification, runProject, release } =
      await loadVerifyWithPendingRun(OK_RESULT);
    release();

    const skipped = await runAIVerification(cfg as any, db, {
      ...baseRequest(),
      skipVerification: true,
    } as any);

    expect(skipped.status).toBe("UNVERIFIED");
    expect(skipped.skipReason).toBe("Verification skipped by user.");
    expect(runProject).not.toHaveBeenCalled();

    // Slot was never taken, so a real verification right after still runs.
    const after = await runAIVerification(cfg as any, db, baseRequest() as any);
    expect(runProject).toHaveBeenCalledTimes(1);
    expect(after.status).toBe("VERIFIED");
  });

  it("releases the slot even when the sandbox run throws", async () => {
    const cfg = makeTestConfig({ maxConcurrentRuns: 1 });
    const runProject = vi
      .fn()
      .mockRejectedValueOnce(new Error("sandbox exploded"))
      .mockResolvedValueOnce(OK_RESULT);

    vi.doMock("../src/execution/pipeline.js", () => ({ runProject }));
    vi.doMock("../src/projects/service.js", () => ({
      workspacePath: async () => "/tmp/does-not-matter",
    }));
    const { runAIVerification } = await import("../src/ai/verify.js");

    const failed = await runAIVerification(
      cfg as any,
      db,
      baseRequest() as any,
    );
    expect(failed.status).toBe("FAILED");

    // If the finally-release were missing, this second call would be starved
    // forever by the leaked slot.
    const recovered = await runAIVerification(
      cfg as any,
      db,
      baseRequest() as any,
    );
    expect(runProject).toHaveBeenCalledTimes(2);
    expect(recovered.status).toBe("VERIFIED");
  });
});
