/**
 * M87 browser journey: Source Control through the real UI, with a hostile
 * repository. A collaborator plants a clean filter from the sandbox; the
 * user initializes, stages, and commits in the Source Control panel. The
 * commit lands, the filter runs inside the sandbox, and nothing runs on the
 * host.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { makeTestConfig } from "./helpers.js";
import { openDb, type Db } from "../src/db.js";
import { createApp } from "../src/app.js";
import { setupWebSocketServer } from "../src/ws/index.js";
import { sandboxManager } from "../src/execution/sandbox.js";
import { isDockerRunning, isRunnerImageAvailable } from "../src/tools.js";
import type { AppConfig } from "../src/config.js";

const execFileAsync = promisify(execFile);
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
  throw new Error("M87 CI browser E2E requires frontend/dist");
}
if (process.env.CI === "true" && dockerOk && !chromiumPath) {
  throw new Error("M87 CI browser E2E requires Playwright Chromium");
}

const enabled = dockerOk && hasFrontend && !!chromiumPath;

describe.skipIf(!enabled)("M87 Source Control journey (browser)", () => {
  let server: Server;
  let db: Db;
  let cfg: AppConfig;
  let base = "";
  let token = "";
  let username = "";
  const password = "secret123";
  let projectId = "";
  let hostMarker = "";

  beforeAll(async () => {
    cfg = makeTestConfig({ frontendDist: join(repoRoot, "frontend", "dist") });
    hostMarker = join(cfg.dataDir, "HOST_EXECUTED").replace(/\\/g, "/");
    db = openDb(":memory:");
    server = createServer(createApp(cfg, db));
    setupWebSocketServer(server, db, cfg);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    username = `m87b${Date.now().toString(36)}`;
    const reg = await fetch(`${base}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    }).then((r) => r.json() as Promise<{ token?: string }>);
    if (!reg.token) throw new Error("register failed");
    token = reg.token;
    const created = await api("POST", "/api/projects", {
      name: "m87-journey",
      language: "python",
    });
    projectId = (created.data as { project: { id: string } }).project.id;
    const w = await api("POST", `/api/projects/${projectId}/file`, {
      path: "app.txt",
      content: "hello from the journey\n",
    });
    if (w.status !== 200) throw new Error(`write failed: ${w.status}`);
  }, 60_000);

  afterAll(async () => {
    try {
      await sandboxManager.stopProjectSandbox(projectId);
    } catch {
      /* ignore */
    }
    await new Promise<void>((r) => server.close(() => r()));
  }, 120_000);

  async function api(method: string, path: string, body?: unknown) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as unknown;
    return { status: res.status, data };
  }

  /** The collaborator's terminal. */
  async function sandboxSh(script: string, input = ""): Promise<string> {
    const owner = db
      .prepare("SELECT owner_id FROM projects WHERE id = ?")
      .get(projectId) as { owner_id: number };
    const cid = await sandboxManager.ensureProjectSandbox(
      projectId,
      cfg,
      join(cfg.workspacesDir, projectId),
      owner.owner_id,
    );
    const child = execFileAsync(
      "docker",
      ["exec", "-i", "-u", "ide", "-w", "/workspace", cid, "sh", "-c", `umask 0; ${script}`],
      { encoding: "utf8" },
    );
    child.child.stdin?.end(input);
    return (await child).stdout;
  }

  it("initializes, stages, and commits through the panel while a planted filter stays in the sandbox", async () => {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-gpu"],
    });
    const pageErrors: string[] = [];
    try {
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
      page.on("pageerror", (err) => pageErrors.push(err.message));
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

      await page.getByRole("tab", { name: /Source Control/ }).click();
      await page
        .getByRole("button", { name: "Initialize Git Repository" })
        .click();
      await page
        .locator("#git-commit-message")
        .waitFor({ timeout: 30_000 });

      // A collaborator plants a clean filter from their terminal.
      const payload = [
        "#!/bin/sh",
        'if [ -f /.dockerenv ] && [ -d /opt/debug/bin ]; then',
        "  echo ran >> /workspace/.m87-journey-ran",
        "else",
        `  echo host > '${hostMarker}'`,
        "fi",
        "cat",
        "",
      ].join("\n");
      await sandboxSh("cat > .m87-filter.sh", payload);
      await sandboxSh(
        "git config filter.j.clean 'sh .m87-filter.sh' && printf 'app.txt filter=j\\n' > .gitattributes " +
          "&& printf '.m87-*\\n' >> .git/info/exclude",
      );

      await page.getByRole("button", { name: "Refresh Source Control" }).click();
      const stageApp = page.getByRole("button", { name: "Stage app.txt" });
      await stageApp.waitFor({ timeout: 30_000 });
      await stageApp.click();
      await page
        .getByRole("button", { name: "Unstage app.txt" })
        .waitFor({ timeout: 30_000 });

      await page.locator("#git-commit-message").fill("journey through the sandbox");
      await page.getByRole("button", { name: "Commit", exact: true }).click();
      // A successful commit clears the message box; History then lists it.
      await page.waitForFunction(
        () => {
          const d = (globalThis as any).document;
          const box = d.querySelector("#git-commit-message");
          return (
            box !== null &&
            box.value === "" &&
            String(d.body.innerText).includes("journey through the sandbox")
          );
        },
        null,
        { timeout: 30_000 },
      );
    } catch (err) {
      throw new Error(
        `journey failed: ${String(err)}\npageErrors=${pageErrors.join("; ")}`,
      );
    } finally {
      await browser.close();
    }

    const log = await api("GET", `/api/projects/${projectId}/git/log`);
    const subjects = (log.data as { commits: Array<{ subject: string }> })
      .commits.map((c) => c.subject);
    expect(subjects).toContain("journey through the sandbox");
    const files = await sandboxSh("git show --name-only --pretty= HEAD");
    expect(files).toContain("app.txt");
    expect(await sandboxSh("cat .m87-journey-ran")).toContain("ran");
    expect(existsSync(hostMarker)).toBe(false);
    expect(pageErrors).toEqual([]);
  }, 180_000);
});
