import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { makeTestConfig } from "./helpers.js";
import { openDb, type Db } from "../src/db.js";
import { createApp } from "../src/app.js";
import { setupWebSocketServer } from "../src/ws/index.js";
import { sandboxManager } from "../src/execution/sandbox.js";
import { isDockerRunning, isRunnerImageAvailable } from "../src/tools.js";
import type { AppConfig } from "../src/config.js";

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
    "M85 CI browser E2E requires frontend/dist (build the frontend before backend tests)",
  );
}
if (process.env.CI === "true" && dockerOk && !chromiumPath) {
  throw new Error("M85 CI browser E2E requires Playwright Chromium");
}

const enabled = dockerOk && hasFrontend && !!chromiumPath;

const PKG = JSON.stringify({
  name: "m85-journey",
  scripts: {
    test: "node --test --test-reporter=tap tests/add.test.js",
  },
});
const TEST_JS = [
  "const test = require('node:test');",
  "const assert = require('node:assert');",
  "test('adds', () => { assert.strictEqual(1 + 1, 2); });",
  "test('fails', () => { assert.strictEqual(1 + 1, 3); });",
  "",
].join("\n");
const MAIN_JS = "export function add(a, b) { return a + b; }\n";

describe.skipIf(!enabled)("M85 developer journey (browser)", () => {
  let server: Server;
  let db: Db;
  let cfg: AppConfig;
  let base = "";
  let token = "";
  let username = "";
  const password = "secret123";
  let projectId = "";

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

    username = `m85j${Date.now().toString(36)}`;
    const regRes = await fetch(`${base}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    const reg = (await regRes.json()) as { token?: string };
    if (!regRes.ok || !reg.token) throw new Error("register failed");
    token = reg.token;

    const created = await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ name: "m85-journey", language: "javascript" }),
    }).then((r) => r.json() as Promise<{ project?: { id: string } }>);
    if (!created.project?.id) throw new Error("project missing");
    projectId = created.project.id;

    await writeFile(projectId, "package.json", PKG);
    await writeFile(projectId, "tests/add.test.js", TEST_JS);
    await writeFile(projectId, "main.js", MAIN_JS);
  }, 60_000);

  afterAll(async () => {
    try {
      await sandboxManager.cleanupAllSandboxes();
    } catch {
      /* ignore */
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }, 120_000);

  async function writeFile(id: string, path: string, content: string) {
    const res = await fetch(`${base}/api/projects/${id}/file`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ path, content }),
    });
    if (!res.ok) throw new Error(`write ${path} failed: ${res.status}`);
  }

  async function authJson(method: string, path: string, body?: unknown) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: res.status, data };
  }

  async function openIde() {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-gpu"],
    });
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
    await page.goto(`${base}/p/${projectId}`, { waitUntil: "load" });
    const login = page.locator("#auth-username");
    const tree = page.locator(".file-tree-container ul.file-tree").first();
    await Promise.race([
      tree.waitFor({ timeout: 60_000 }),
      login.waitFor({ timeout: 60_000 }),
    ]);
    if (await login.isVisible().catch(() => false)) {
      await login.fill(username);
      await page.locator("#auth-password").fill(password);
      await page.locator('form.auth-form button[type="submit"]').click();
    }
    await tree.waitFor({ timeout: 60_000 });
    return { browser, page };
  }

  it("opens a file, runs tests, navigates a failure, and commits", async () => {
    const { browser, page } = await openIde();
    const pageErrors: string[] = [];
    page.on("pageerror", (err) => pageErrors.push(err.message));
    try {
      await page.click('[data-testid="tests-tab"]');
      await page.locator('[data-testid="test-explorer"]').waitFor({
        timeout: 15_000,
      });
      await page
        .locator('[data-testid="workflow-task-npm:test"]')
        .waitFor({ timeout: 15_000 });
      await page.click('[data-testid="workflow-task-npm:test"]');
      await page.waitForFunction(
        () => {
          const s = (globalThis as any).document.querySelector(
            '[data-testid="workflow-status"]',
          )?.textContent;
          return typeof s === "string" && s !== "Idle";
        },
        null,
        { timeout: 15_000 },
      );
      await page.waitForFunction(
        () =>
          (globalThis as any).document.querySelectorAll(
            '[data-testid="workflow-result"]',
          ).length >= 1,
        null,
        { timeout: 90_000 },
      );
      const loc = page.locator('[data-testid="workflow-result-loc"]').first();
      await loc.waitFor({ timeout: 15_000 });
      await loc.click();
      await page.waitForFunction(
        () => {
          const monaco = (globalThis as any).monaco;
          if (!monaco) return false;
          return monaco.editor.getModels().some((m: { uri: { path: string } }) =>
            String(m.uri.path ?? "").includes("add.test.js"),
          );
        },
        null,
        { timeout: 30_000 },
      );
    } catch (err) {
      const diag = await page.evaluate(() => {
        const d = (globalThis as any).document;
        return {
          status: d.querySelector('[data-testid="workflow-status"]')
            ?.textContent,
          results: d.querySelectorAll('[data-testid="workflow-result"]').length,
          locs: d.querySelectorAll('[data-testid="workflow-result-loc"]')
            .length,
          runDisabled: d.querySelector('[data-testid="workflow-run-all"]')
            ?.disabled,
        };
      });
      throw new Error(
        `journey failed: ${String(err)}\nstatus=${JSON.stringify(diag)}\npageErrors=${pageErrors.join("; ")}`,
      );
    } finally {
      await browser.close();
    }

    const init = await authJson("POST", `/api/projects/${projectId}/git/init`);
    expect(init.status).toBe(200);
    const stage = await authJson("POST", `/api/projects/${projectId}/git/stage`, {
      all: true,
    });
    expect(stage.status).toBe(200);
    const commit = await authJson(
      "POST",
      `/api/projects/${projectId}/git/commit`,
      { message: "m85 journey" },
    );
    expect(commit.status).toBe(200);
    expect(typeof commit.data.shortHash).toBe("string");
    const status = await authJson("GET", `/api/projects/${projectId}/git/status`);
    expect(status.data.hasCommits).toBe(true);
  }, 180_000);
});
