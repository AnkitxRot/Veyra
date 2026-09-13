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
import { resetLanguageServersForTests } from "../src/lsp/manager.js";
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
    "M82 CI browser E2E requires frontend/dist (build the frontend before backend tests)",
  );
}
if (process.env.CI === "true" && dockerOk && !chromiumPath) {
  throw new Error(
    "M82 CI browser E2E requires Playwright Chromium (npx playwright install --with-deps chromium)",
  );
}

const enabled = dockerOk && hasFrontend && !!chromiumPath;

describe.skipIf(!enabled)("lsp browser e2e (real Monaco + real language servers)", () => {
  let server: Server;
  let db: Db;
  let cfg: AppConfig;
  let base = "";
  let token = "";
  let pythonProjectId = "";
  let tsProjectId = "";

  beforeAll(async () => {
    cfg = makeTestConfig({
      frontendDist: join(repoRoot, "frontend", "dist"),
      lspStartupTimeoutMs: 30_000,
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
        username: `lspb${Date.now().toString(36)}`,
        password: "secret123",
      }),
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
      body: JSON.stringify({ templateId: "python", name: "lsp-py-e2e" }),
    }).then((r) => r.json() as Promise<{ project?: { id: string } }>);
    if (!py.project?.id) throw new Error("python template project missing");
    pythonProjectId = py.project.id;

    const ts = await fetch(`${base}/api/projects/from-template`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ templateId: "typescript", name: "lsp-ts-e2e" }),
    }).then((r) => r.json() as Promise<{ project?: { id: string } }>);
    if (!ts.project?.id) throw new Error("typescript template project missing");
    tsProjectId = ts.project.id;
  }, 60_000);

  afterAll(async () => {
    resetLanguageServersForTests();
    try {
      await sandboxManager.cleanupAllSandboxes();
    } catch {}
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function openProject(projectId: string) {
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
    await page.goto(`${base}/p/${projectId}`, { waitUntil: "domcontentloaded" });
    return { browser, page };
  }

  async function setActiveModelValue(page: import("playwright").Page, ext: string, value: string) {
    await page.evaluate(
      ({ ext, value }) => {
        const monaco = (globalThis as any).monaco;
        const models = monaco.editor.getModels();
        const model = models.find((m: { uri: { path: string } }) =>
          m.uri.path.toLowerCase().endsWith(ext),
        );
        if (!model) throw new Error(`no model ending with ${ext}`);
        const editor = monaco.editor.getEditors()[0];
        if (editor) editor.setModel(model);
        model.setValue(value);
        const rel = model.uri.path.startsWith("/")
          ? model.uri.path.slice(1)
          : model.uri.path;
        const CE = (globalThis as any).CustomEvent;
        (globalThis as any).document.dispatchEvent(
          new CE("ide-live-content-change", { detail: { path: rel } }),
        );
      },
      { ext, value },
    );
  }

  async function waitForMarker(
    page: import("playwright").Page,
    ext: string,
    pred: (message: string) => boolean,
    timeout = 30_000,
  ) {
    const start = Date.now();
    let last: string[] = [];
    while (Date.now() - start < timeout) {
      last = await page.evaluate(({ ext }) => {
        const monaco = (globalThis as any).monaco;
        const models = monaco.editor.getModels();
        const model = models.find((m: { uri: { path: string } }) =>
          m.uri.path.toLowerCase().endsWith(ext),
        );
        if (!model) return [];
        return monaco.editor
          .getModelMarkers({ resource: model.uri })
          .map((m: { message: string }) => m.message);
      }, { ext });
      if (last.some((m) => pred(m))) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(
      `timed out waiting for marker on *${ext}: ${last.join("; ")}`,
    );
  }

  async function triggerSuggest(page: import("playwright").Page, ext: string, line: number, column: number) {
    await page.evaluate(
      ({ ext, line, column }) => {
        const monaco = (globalThis as any).monaco;
        const models = monaco.editor.getModels();
        const model = models.find((m: { uri: { path: string } }) =>
          m.uri.path.toLowerCase().endsWith(ext),
        );
        const editors = monaco.editor.getEditors();
        const editor = editors[0];
        if (!model || !editor) throw new Error("no editor/model");
        editor.setModel(model);
        editor.setPosition({ lineNumber: line, column });
        editor.focus();
        editor.trigger("keyboard", "editor.action.triggerSuggest", {});
      },
      { ext, line, column },
    );
    await page.waitForFunction(
      () => {
        const doc = (globalThis as any).document;
        const w = doc.querySelector(".suggest-widget");
        if (!w) return false;
        if (w.classList.contains("hidden")) return false;
        return !!w.querySelector(".monaco-list-row");
      },
      null,
      { timeout: 20_000 },
    );
  }

  it(
    "Python: Monaco diagnostics and completion via real pylsp",
    async () => {
      const { browser, page } = await openProject(pythonProjectId);
      try {
        await page.waitForFunction(
          () =>
            ((globalThis as any).monaco?.editor.getModels().length ?? 0) > 0,
          null,
          { timeout: 60_000 },
        );
        await page.waitForSelector(
          '[data-testid="lsp-chip-python"] .capability-dot.ready',
          { timeout: 60_000 },
        );
        await setActiveModelValue(page, ".py", "undefined_name\n");
        await waitForMarker(page, ".py", (m) => /undefined/i.test(m));

        await setActiveModelValue(
          page,
          ".py",
          "def greet(name: str) -> str:\n    return name\ngre",
        );
        await new Promise((r) => setTimeout(r, 400));
        await triggerSuggest(page, ".py", 3, 4);

        await setActiveModelValue(
          page,
          ".py",
          "def greet(name: str) -> str:\n    return name\n",
        );
        const start = Date.now();
        let cleared = false;
        while (Date.now() - start < 30_000) {
          const messages: string[] = await page.evaluate(() => {
            const monaco = (globalThis as any).monaco;
            const models = monaco.editor.getModels();
            const py = models.find((m: { uri: { path: string } }) =>
              m.uri.path.endsWith(".py"),
            );
            if (!py) return [];
            return monaco.editor
              .getModelMarkers({ resource: py.uri })
              .map((m: { message: string }) => m.message);
          });
          if (!messages.some((m) => /undefined/i.test(m))) {
            cleared = true;
            break;
          }
          await new Promise((r) => setTimeout(r, 100));
        }
        expect(cleared).toBe(true);
      } finally {
        await browser.close();
      }
    },
    180_000,
  );

  it(
    "TypeScript: Monaco diagnostics and completion via real typescript-language-server",
    async () => {
      const { browser, page } = await openProject(tsProjectId);
      try {
        await page.waitForFunction(
          () =>
            ((globalThis as any).monaco?.editor.getModels().length ?? 0) > 0,
          null,
          { timeout: 60_000 },
        );
        await page.waitForSelector(
          '[data-testid="lsp-chip-typescript"] .capability-dot.ready',
          { timeout: 60_000 },
        );
        await setActiveModelValue(page, ".ts", 'const n: number = "nope";\n');
        await waitForMarker(page, ".ts", (m) => m.length > 0);

        await setActiveModelValue(
          page,
          ".ts",
          "export function greet(name: string): string { return name; }\ngre",
        );
        await new Promise((r) => setTimeout(r, 400));
        await triggerSuggest(page, ".ts", 2, 4);
      } finally {
        await browser.close();
      }
    },
    180_000,
  );
});
