import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { makeTestConfig } from "./helpers.js";
import { openDb, type Db } from "../src/db.js";
import { createApp } from "../src/app.js";
import { setupWebSocketServer } from "../src/ws/index.js";
import { sandboxManager } from "../src/execution/sandbox.js";
import { collaborationManager } from "../src/collab/manager.js";
import { isDockerRunning, isRunnerImageAvailable } from "../src/tools.js";
import type { AppConfig } from "../src/config.js";

// M86 — the browser proof that Test Explorer runs what the editor shows:
// no Ctrl+S, and no waiting for the collaboration persistence debounce.

const dockerOk = isDockerRunning() && isRunnerImageAvailable();
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const frontendIndex = join(repoRoot, "frontend", "dist", "index.html");
const hasFrontend = existsSync(frontendIndex);

let chromiumPath: string | null = null;
try {
  const pw = await import("playwright");
  chromiumPath = pw.chromium.executablePath();
  if (!existsSync(chromiumPath)) chromiumPath = null;
} catch {
  chromiumPath = null;
}

if (process.env.CI === "true" && dockerOk && !hasFrontend) {
  throw new Error(
    "M86 CI browser E2E requires frontend/dist (build the frontend before backend tests)",
  );
}
if (process.env.CI === "true" && dockerOk && !chromiumPath) {
  throw new Error("M86 CI browser E2E requires Playwright Chromium");
}

const enabled = dockerOk && hasFrontend && !!chromiumPath;

const TEST_PATH = "tests/add.test.js";
const PKG = JSON.stringify({
  name: "m86-journey",
  scripts: { test: `node --test --test-reporter=tap ${TEST_PATH}` },
});
const BROKEN = "test('adds', () => { assert.strictEqual(1 + 1, 3); });";
const FIXED = "test('adds', () => { assert.strictEqual(1 + 1, 2); });";
const TEST_JS = [
  "const test = require('node:test');",
  "const assert = require('node:assert');",
  BROKEN,
  "test('stays green', () => { assert.ok(true); });",
  "",
].join("\n");

describe.skipIf(!enabled)("M86 Test Explorer runs what the editor shows (browser)", () => {
  let server: Server;
  let db: Db;
  let cfg: AppConfig;
  let base = "";
  let token = "";
  const execFrames: string[] = [];

  beforeAll(async () => {
    cfg = makeTestConfig({
      frontendDist: join(repoRoot, "frontend", "dist"),
      buildTimeoutMs: 45_000,
    });
    db = openDb(":memory:");
    const app = createApp(cfg, db);
    server = createServer(app);
    setupWebSocketServer(server, db, cfg);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address() as { port: number };
    base = `http://127.0.0.1:${address.port}`;

    const regRes = await fetch(`${base}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: `m86j${Date.now().toString(36)}`,
        password: "secret123",
      }),
    });
    const reg = (await regRes.json()) as { token?: string };
    if (!regRes.ok || !reg.token) throw new Error("register failed");
    token = reg.token;
  }, 60_000);

  afterAll(async () => {
    try {
      await sandboxManager.cleanupAllSandboxes();
    } catch {
      /* ignore */
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }, 120_000);

  async function createSeededProject(name: string): Promise<string> {
    const created = await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ name, language: "javascript" }),
    }).then((r) => r.json() as Promise<{ project?: { id: string } }>);
    if (!created.project?.id) throw new Error("project missing");
    const projectId = created.project.id;
    for (const [path, content] of [
      ["package.json", PKG],
      [TEST_PATH, TEST_JS],
    ] as const) {
      const res = await fetch(`${base}/api/projects/${projectId}/file`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ path, content }),
      });
      if (!res.ok) throw new Error(`write ${path} failed: ${res.status}`);
    }
    return projectId;
  }

  async function launch() {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-gpu"],
    });
    return browser;
  }

  async function openIde(
    browser: Awaited<ReturnType<typeof launch>>,
    projectId: string,
  ) {
    const context = await browser.newContext();
    await context.addCookies([
      {
        name: "session_token",
        value: token,
        url: base,
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);
    const page = await context.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", (err) => pageErrors.push(err.message));
    page.on("websocket", (ws) => {
      if (!ws.url().includes("/ws/execute")) return;
      ws.on("framesent", (f) => execFrames.push(`> ${String(f.payload).slice(0, 300)}`));
      ws.on("framereceived", (f) =>
        execFrames.push(`< ${String(f.payload).slice(0, 300)}`),
      );
      ws.on("close", () => execFrames.push("closed"));
    });
    await page.goto(`${base}/p/${projectId}`, { waitUntil: "load" });
    await page
      .locator(".file-tree-container ul.file-tree")
      .first()
      .waitFor({ timeout: 60_000 });
    return { page, pageErrors };
  }

  type Page = Awaited<ReturnType<typeof openIde>>["page"];

  async function openTests(page: Page) {
    await page.click('[data-testid="tests-tab"]');
    await page
      .locator('[data-testid="workflow-task-npm:test"]')
      .waitFor({ timeout: 15_000 });
  }

  /** Click Run all and wait for a finished run's per-test statuses. */
  async function runAll(page: Page): Promise<string[]> {
    await page.locator('[data-testid="workflow-run-all"]:not([disabled])').waitFor({
      timeout: 15_000,
    });
    await page.click('[data-testid="workflow-run-all"]');
    await page.waitForFunction(
      () =>
        (globalThis as any).document.querySelector(
          '[data-testid="workflow-status"]',
        )?.textContent === "Running",
      null,
      { timeout: 15_000 },
    );
    try {
      await page.waitForFunction(
        () => {
          const d = (globalThis as any).document;
          const status = d.querySelector('[data-testid="workflow-status"]')
            ?.textContent;
          return (
            status !== "Running" &&
            d.querySelectorAll('[data-testid="workflow-result"]').length >= 2
          );
        },
        null,
        { timeout: 90_000 },
      );
    } catch (err) {
      const diag = await page.evaluate(() => {
        const d = (globalThis as any).document;
        return {
          status: d.querySelector('[data-testid="workflow-status"]')?.textContent,
          results: d.querySelectorAll('[data-testid="workflow-result"]').length,
          panel: String(
            d.querySelector('[data-testid="test-explorer"]')?.innerText ?? "",
          ).slice(0, 800),
        };
      });
      throw new Error(
        `run did not finish: ${String(err)}\n${JSON.stringify(diag)}\n${execFrames.slice(-30).join("\n")}`,
      );
    }
    return page.evaluate(() =>
      Array.from(
        (globalThis as any).document.querySelectorAll(
          '[data-testid="workflow-result"]',
        ),
      ).map((el: any) => String(el.getAttribute("data-status"))),
    );
  }

  function roomText(projectId: string): string {
    return (
      collaborationManager.getRoom(projectId)?.doc.getText(TEST_PATH).toString() ??
      ""
    );
  }

  /** Open the test file through its failure location and apply the fix as a
   *  real Monaco edit (flows through y-monaco into the collaboration room).
   *  Resolves once the server room holds the fix. The collab client binds the
   *  model to the Y.Text after the REST load; an edit that lands before that
   *  bind is replaced by the room content, so it is re-applied — driven by
   *  the room's observable state, never by a fixed sleep. */
  async function fixInEditor(page: Page, projectId: string) {
    await page.locator('[data-testid="workflow-result-loc"]').first().click();
    for (let attempt = 0; attempt < 5; attempt++) {
      await page.waitForFunction(
        ({ path, broken }) => {
          const monaco = (globalThis as any).monaco;
          const model = monaco?.editor.getEditors?.()[0]?.getModel();
          return (
            !!model &&
            String(model.uri.path).endsWith(path) &&
            model.getValue().includes(broken)
          );
        },
        { path: TEST_PATH, broken: BROKEN },
        { timeout: 30_000 },
      );
      await page.evaluate(
        ({ broken, fixed }) => {
          const monaco = (globalThis as any).monaco;
          const editor = monaco.editor.getEditors()[0];
          const model = editor.getModel();
          const match = model.findMatches(broken, false, false, true, null, false)[0];
          if (match) {
            editor.executeEdits("m86-e2e", [{ range: match.range, text: fixed }]);
          }
        },
        { broken: BROKEN, fixed: FIXED },
      );
      const start = Date.now();
      while (Date.now() - start < 3_000) {
        if (roomText(projectId).includes(FIXED)) {
          expect(roomText(projectId)).not.toContain(BROKEN);
          return;
        }
        await new Promise((r) => setTimeout(r, 10));
      }
    }
    throw new Error(`room never received the fix: ${JSON.stringify(roomText(projectId))}`);
  }

  function diskContent(projectId: string) {
    return readFileSync(join(cfg.workspacesDir, projectId, TEST_PATH), "utf8");
  }

  it("fixing a failing test in the editor and running immediately (no save) passes", async () => {
    const projectId = await createSeededProject("m86-solo");
    const browser = await launch();
    try {
      const { page, pageErrors } = await openIde(browser, projectId);
      await openTests(page);

      const before = await runAll(page);
      expect(before).toContain("failed");

      await fixInEditor(page, projectId);
      const after = await runAll(page);

      expect(after.length).toBeGreaterThanOrEqual(2);
      expect(after.every((s) => s === "passed"), JSON.stringify(after)).toBe(true);
      expect(diskContent(projectId)).toContain(FIXED);
      expect(pageErrors).toEqual([]);
    } finally {
      await browser.close();
    }
  }, 240_000);

  it("a collaborator's unsaved fix is what runs when another tab starts the tests", async () => {
    const projectId = await createSeededProject("m86-collab");
    const browser = await launch();
    try {
      const runner = await openIde(browser, projectId);
      const editor = await openIde(browser, projectId);
      await openTests(runner.page);
      await openTests(editor.page);
      // Sandbox startup can outlast the 2s persistence debounce, which would
      // let the timer (not the barrier) land the fix. Freeze the debounce for
      // this room so the only way the run can see the fix is the server-side
      // read-your-writes barrier.
      const room = collaborationManager.getRoom(projectId);
      expect(room).toBeTruthy();
      (room as unknown as { scheduleDebouncedPersistence: () => void }).scheduleDebouncedPersistence =
        () => {};

      // The editor tab produces a failure location to open, then fixes it.
      const before = await runAll(editor.page);
      expect(before).toContain("failed");
      await fixInEditor(editor.page, projectId);

      // The server room holds the fix; the debounce has not written it yet.
      expect(diskContent(projectId)).toContain(BROKEN);

      // The runner tab never touched the file: only the server-side barrier
      // can make this run see the collaborator's edit.
      const after = await runAll(runner.page);

      expect(after.length).toBeGreaterThanOrEqual(2);
      expect(after.every((s) => s === "passed"), JSON.stringify(after)).toBe(true);
      expect(runner.pageErrors).toEqual([]);
      expect(editor.pageErrors).toEqual([]);
    } finally {
      await browser.close();
    }
  }, 240_000);
});
