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
import { resetDebugSessionsForTests } from "../src/debug/manager.js";
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
    "M83 CI browser E2E requires frontend/dist (build the frontend before backend tests)",
  );
}
if (process.env.CI === "true" && dockerOk && !chromiumPath) {
  throw new Error(
    "M83 CI browser E2E requires Playwright Chromium (npx playwright install --with-deps chromium)",
  );
}

const enabled = dockerOk && hasFrontend && !!chromiumPath;

const PY_SRC = "x = 1\ny = 2\nz = x + y\nprint(z)\n";
const JS_SRC = "const x = 1;\nconst y = 2;\nconst z = x + y;\nconsole.log(z);\n";

describe.skipIf(!enabled)("debug browser e2e (real Monaco + real adapters)", () => {
  let server: Server;
  let db: Db;
  let cfg: AppConfig;
  let base = "";
  let token = "";
  let username = "";
  const password = "secret123";
  let pythonProjectId = "";
  let nodeProjectId = "";

  beforeAll(async () => {
    cfg = makeTestConfig({
      frontendDist: join(repoRoot, "frontend", "dist"),
      debugStartupTimeoutMs: 45_000,
      debugRequestTimeoutMs: 45_000,
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

    username = `dbgb${Date.now().toString(36)}`;
    const regRes = await fetch(`${base}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    const reg = (await regRes.json()) as { token?: string };
    if (!regRes.ok || !reg.token) {
      throw new Error(`register failed: ${regRes.status}`);
    }
    token = reg.token;

    const py = await fetch(`${base}/api/projects/from-template`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ templateId: "python", name: "dbg-py-e2e" }),
    }).then((r) => r.json() as Promise<{ project?: { id: string } }>);
    if (!py.project?.id) throw new Error("python template project missing");
    pythonProjectId = py.project.id;

    const js = await fetch(`${base}/api/projects/from-template`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ templateId: "node", name: "dbg-js-e2e" }),
    }).then((r) => r.json() as Promise<{ project?: { id: string } }>);
    if (!js.project?.id) throw new Error("node template project missing");
    nodeProjectId = js.project.id;

    await writeFile(pythonProjectId, "main.py", PY_SRC);
    await writeFile(nodeProjectId, "main.js", JS_SRC);
  }, 60_000);

  afterAll(async () => {
    resetDebugSessionsForTests();
    try {
      await sandboxManager.cleanupAllSandboxes();
    } catch {}
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function writeFile(projectId: string, path: string, content: string) {
    const res = await fetch(`${base}/api/projects/${projectId}/file`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ path, content }),
    });
    if (!res.ok) {
      throw new Error(`write ${path} failed: ${res.status}`);
    }
  }

  async function openProject(projectId: string, fileName: string) {
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
    const tree = page.locator('[role="tree"]');
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
    await page
      .locator('[role="treeitem"]')
      .filter({ hasText: fileName })
      .first()
      .click();
    await page.waitForFunction(
      () => ((globalThis as any).monaco?.editor.getModels().length ?? 0) > 0,
      null,
      { timeout: 60_000 },
    );
    return { browser, page };
  }

  async function setActiveModelValue(
    page: import("playwright").Page,
    fileName: string,
    value: string,
  ) {
    await page.evaluate(
      ({ fileName, value }) => {
        const monaco = (globalThis as any).monaco;
        const models = monaco.editor.getModels();
        const needle = fileName.replace(/\\/g, "/").toLowerCase();
        const model = models.find((m: { uri: { path: string } }) => {
          const p = String(m.uri.path ?? "").replace(/\\/g, "/").toLowerCase();
          return p === needle || p.endsWith("/" + needle);
        });
        if (!model) throw new Error(`no model for ${fileName}`);
        const editor = monaco.editor.getEditors()[0];
        if (editor) editor.setModel(model);
        model.setValue(value);
      },
      { fileName, value },
    );
  }

  async function debugFlow(
    page: import("playwright").Page,
    fileName: string,
    src: string,
  ) {
    await setActiveModelValue(page, fileName, src);
    await page.click('[data-testid="debug-tab"]');
    await page.evaluate(
      ({ fileName }) => {
        const CE = (globalThis as any).CustomEvent;
        (globalThis as any).document.dispatchEvent(
          new CE("ide-debug-toggle-breakpoint", {
            detail: { path: fileName, line: 3 },
          }),
        );
      },
      { fileName },
    );
    await page.waitForFunction(
      (fileName) => {
        const keys = Object.keys((globalThis as any).localStorage).filter(
          (k: string) => k.startsWith("veyra_debug_bp_"),
        );
        return keys.some((k: string) =>
          ((globalThis as any).localStorage.getItem(k) ?? "").includes(fileName),
        );
      },
      fileName,
      { timeout: 15_000 },
    );
    await page.evaluate((fileName) => {
      (globalThis as any).document.dispatchEvent(
        new (globalThis as any).CustomEvent("ide-debug", {
          detail: { activeFile: fileName },
        }),
      );
    }, fileName);
    try {
      await page.waitForFunction(
        (fileName) => {
          const status = (globalThis as any).document.querySelector(
            '[data-testid="debug-status"]',
          )?.textContent;
          const stack = (globalThis as any).document.querySelector(
            '[data-testid="debug-stack"]',
          )?.textContent ?? "";
          return status === "Paused" && stack.includes(fileName);
        },
        fileName,
        { timeout: 90_000 },
      );
    } catch {
      const diag = await page.evaluate(() => ({
        status: (globalThis as any).document.querySelector(
          '[data-testid="debug-status"]',
        )?.textContent,
        message: (globalThis as any).document.querySelector(
          '[data-testid="debug-message"]',
        )?.textContent,
        stack: (globalThis as any).document.querySelector(
          '[data-testid="debug-stack"]',
        )?.textContent,
        vars: (globalThis as any).document.querySelector(
          '[data-testid="debug-variables"]',
        )?.textContent,
        output: (globalThis as any).document.querySelector(
          '[data-testid="debug-output"]',
        )?.textContent,
      }));
      throw new Error(
        `debug did not pause on ${fileName}: ${JSON.stringify(diag)}`,
      );
    }
    const varsText = await page.locator('[data-testid="debug-variables"]').innerText();
    expect(varsText.length).toBeGreaterThan(0);
    const stackText = await page.locator('[data-testid="debug-stack"]').innerText();
    expect(stackText).toMatch(new RegExp(fileName.replace(".", "\\.")));
    await page.click('[data-testid="debug-continue"]');
    await page.waitForFunction(
      () => {
        const t = (globalThis as any).document.querySelector(
          '[data-testid="debug-status"]',
        )?.textContent;
        return t === "Stopped" || t === "Idle";
      },
      null,
      { timeout: 60_000 },
    );
  }

  it(
    "Python: breakpoint, pause, variables, continue",
    async () => {
      const { browser, page } = await openProject(pythonProjectId, "main.py");
      try {
        await debugFlow(page, "main.py", PY_SRC);
      } finally {
        await browser.close();
      }
    },
    180_000,
  );

  it(
    "Node: breakpoint, pause, variables, continue",
    async () => {
      const { browser, page } = await openProject(nodeProjectId, "main.js");
      try {
        await debugFlow(page, "main.js", JS_SRC);
      } finally {
        await browser.close();
      }
    },
    180_000,
  );
});
