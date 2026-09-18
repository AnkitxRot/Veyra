import { describe, it, expect, afterEach } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTestConfig, startTestApi, type TestApi } from "./helpers.js";
import { handleExecutionConnection } from "../src/ws/execution.js";
import {
  debugSessions,
  resetDebugSessionsForTests,
} from "../src/debug/manager.js";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { workspacePath } from "../src/projects/service.js";

const fakeDap = fileURLToPath(new URL("./fixtures/fake-dap.mjs", import.meta.url));

function makeFakeExecWs() {
  const listeners = new Map<string, Array<(...a: any[]) => void>>();
  return {
    OPEN: 1,
    CLOSED: 3,
    readyState: 1,
    sent: [] as string[],
    send(d: string) {
      this.sent.push(d);
    },
    close() {
      this.readyState = 3;
    },
    on(ev: string, fn: (...a: any[]) => void) {
      const arr = listeners.get(ev) ?? [];
      arr.push(fn);
      listeners.set(ev, arr);
      return this;
    },
    emit(ev: string, ...a: any[]) {
      for (const fn of listeners.get(ev) ?? []) fn(...a);
    },
  };
}

async function waitFor(
  pred: () => boolean,
  ms = 4000,
  label = "condition",
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for ${label}`);
}

describe("workflow security", () => {
  let api: TestApi | undefined;

  afterEach(async () => {
    resetDebugSessionsForTests();
    if (api) {
      await api.close();
      api = undefined;
    }
  });

  async function boot() {
    const cfg = makeTestConfig();
    api = await startTestApi(cfg);
    const user = `wf${Date.now().toString(36)}`;
    const reg = await api.request("POST", "/api/auth/register", {
      body: { username: user, password: "secret123" },
    });
    expect([200, 201]).toContain(reg.status);
    const token = reg.data.token as string;
    const created = await api.request("POST", "/api/projects", {
      token,
      body: { name: "wf-sec", language: "javascript" },
    });
    const projectId = created.data.project.id as string;
    const cwd = await workspacePath(cfg, projectId);
    writeFileSync(
      join(cwd, "package.json"),
      JSON.stringify({
        scripts: { test: "node --test", start: "node server.js" },
      }),
    );
    writeFileSync(join(cwd, "main.py"), "x = 1\nprint(x)\n");
    return { cfg, token, projectId, userId: reg.data.user.id as number, cwd };
  }

  it("GET /workflow requires auth and project membership", async () => {
    const { token, projectId } = await boot();
    const anon = await api!.request("GET", `/api/projects/${projectId}/workflow`);
    expect(anon.status).toBe(401);

    const other = await api!.request("POST", "/api/auth/register", {
      body: { username: `wf2${Date.now().toString(36)}`, password: "secret123" },
    });
    const cross = await api!.request(
      "GET",
      `/api/projects/${projectId}/workflow`,
      { token: other.data.token },
    );
    expect(cross.status).toBe(404);

    const ok = await api!.request("GET", `/api/projects/${projectId}/workflow`, {
      token,
    });
    expect(ok.status).toBe(200);
    expect(ok.data.tasks.map((t: { id: string }) => t.id)).toEqual(["npm:test"]);
  });

  it("does not expose a REST command-execution endpoint", async () => {
    const { token, projectId } = await boot();
    const post = await api!.request(
      "POST",
      `/api/projects/${projectId}/workflow`,
      { token, body: { command: "sh", args: ["-c", "id"] } },
    );
    expect(post.status).toBeGreaterThanOrEqual(400);
  });

  it("WS workflow rejects injected command/env/cwd and unknown scripts", async () => {
    const { cfg, projectId, userId } = await boot();
    const ws = makeFakeExecWs();
    await handleExecutionConnection(
      ws as any,
      projectId,
      userId,
      "wf",
      cfg,
      api!.db,
    );

    ws.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "start",
          workflow: { taskId: "npm:test", command: "/bin/sh", args: ["-c", "id"] },
        }),
      ),
    );
    await waitFor(
      () => ws.sent.some((s) => s.includes("invalid workflow")),
      2000,
      "reject extra keys",
    );

    const ws2 = makeFakeExecWs();
    await handleExecutionConnection(
      ws2 as any,
      projectId,
      userId,
      "wf",
      cfg,
      api!.db,
    );
    ws2.emit(
      "message",
      Buffer.from(
        JSON.stringify({ type: "start", workflow: { taskId: "npm:start" } }),
      ),
    );
    await waitFor(
      () =>
        ws2.sent.some((s) =>
          /unknown or disallowed|invalid task/i.test(s),
        ),
      2000,
      "reject start script",
    );
  });

  it("refuses workflow start while a debugger is live", async () => {
    const { cfg, projectId, userId, cwd } = await boot();
    debugSessions.setSpawnForTests(() =>
      spawn(process.execPath, [fakeDap], {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      }),
    );
    debugSessions.setContainerForTests(() => "ide-sandbox-wf");
    const sock = {
      readyState: 1,
      send() {},
      close() {
        this.readyState = 3;
      },
    };
    const session = await debugSessions.attach({
      projectId,
      userId,
      cfg,
      socket: sock as any,
      workspaceDir: cwd,
    });
    expect(session).not.toBeNull();
    session!.handleClientMessage(sock as any, {
      type: "launch",
      language: "python",
      entryFile: "main.py",
      breakpoints: {},
    });
    await waitFor(
      () => debugSessions.hasLiveForProject(projectId),
      4000,
      "live debug",
    );

    const ws = makeFakeExecWs();
    await handleExecutionConnection(
      ws as any,
      projectId,
      userId,
      "wf",
      cfg,
      api!.db,
    );
    ws.emit(
      "message",
      Buffer.from(
        JSON.stringify({ type: "start", workflow: { taskId: "npm:test" } }),
      ),
    );
    await waitFor(
      () => ws.sent.some((s) => s.includes("Debugger is active")),
      2000,
      "refuse during debug",
    );
  });
});
