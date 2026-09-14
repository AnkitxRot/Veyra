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
    "M86 CI browser E2E requires frontend/dist (build the frontend before backend tests)",
  );
}
if (process.env.CI === "true" && dockerOk && !chromiumPath) {
  throw new Error("M86 CI browser E2E requires Playwright Chromium");
}

const enabled = dockerOk && hasFrontend && !!chromiumPath;

describe.skipIf(!enabled)("M86 terminal reload resume (browser)", () => {
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
      terminalDetachGraceMs: 90_000,
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

    username = `m86t${Date.now().toString(36)}`;
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
      body: JSON.stringify({ name: "m86-terminal", language: "javascript" }),
    }).then((r) => r.json() as Promise<{ project?: { id: string } }>);
    if (!created.project?.id) throw new Error("project missing");
    projectId = created.project.id;
  }, 60_000);

  afterAll(async () => {
    try {
      await sandboxManager.cleanupAllSandboxes();
    } catch {
      /* ignore */
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }, 120_000);

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

  it("reloads the IDE and reattaches the same sandbox PTY", async () => {
    const { browser, page } = await openIde();
    const terminalUrls: string[] = [];
    page.on("websocket", (ws) => {
      if (ws.url().includes("/ws/terminal")) terminalUrls.push(ws.url());
    });
    try {
      await page.click('[data-testid="terminal-tab"]');
      await page
        .getByTestId("terminal-status")
        .filter({ hasText: "bash (sandbox)" })
        .waitFor({ timeout: 60_000 });

      expect(terminalUrls.length).toBeGreaterThanOrEqual(1);
      const first = new URL(terminalUrls[0]);
      const firstId = first.searchParams.get("terminalId");
      expect(firstId).toBeTruthy();
      expect(first.searchParams.get("resume")).toBeNull();

      await page.waitForFunction(
        () =>
          Object.keys(sessionStorage).some((k) =>
            k.startsWith("cloudeee_terminal_"),
          ),
        null,
        { timeout: 30_000 },
      );
      const storedBefore = await page.evaluate(() => {
        const keys = Object.keys(sessionStorage).filter((k) =>
          k.startsWith("cloudeee_terminal_"),
        );
        return keys.map((k) => sessionStorage.getItem(k));
      });
      expect(storedBefore.length).toBeGreaterThanOrEqual(1);
      const storedId = storedBefore[0];
      expect(storedId).toBeTruthy();

      await page.reload({ waitUntil: "load" });
      const tree = page.locator(".file-tree-container ul.file-tree").first();
      await tree.waitFor({ timeout: 60_000 });
      await page.click('[data-testid="terminal-tab"]');
      await page
        .getByTestId("terminal-status")
        .filter({ hasText: "bash (sandbox)" })
        .waitFor({ timeout: 60_000 });

      const resumeUrls = terminalUrls.filter((u) =>
        new URL(u).searchParams.get("resume") === "1",
      );
      expect(resumeUrls.length).toBeGreaterThanOrEqual(1);
      const resumed = new URL(resumeUrls[0]);
      expect(resumed.searchParams.get("terminalId")).toBe(storedId);
      expect(resumed.searchParams.get("lastSeq")).toBe("0");

      const storedAfter = await page.evaluate(() => {
        const keys = Object.keys(sessionStorage).filter((k) =>
          k.startsWith("cloudeee_terminal_"),
        );
        return keys.map((k) => sessionStorage.getItem(k));
      });
      expect(storedAfter).toContain(storedId);
    } finally {
      await browser.close();
    }
  }, 180_000);
});
