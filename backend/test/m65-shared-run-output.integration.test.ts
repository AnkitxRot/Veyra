import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";
import { createServer, type Server } from "node:http";
import { WebSocket } from "ws";
import * as decoding from "lib0/decoding";
import { makeTestConfig } from "./helpers.js";
import { openDb, type Db } from "../src/db.js";
import type { AppConfig } from "../src/config.js";
import { createApp } from "../src/app.js";
import { setupWebSocketServer } from "../src/ws/index.js";
import { collaborationManager } from "../src/collab/manager.js";
import { handleExecutionConnection } from "../src/ws/execution.js";

// Mocked pipeline: `runProject` invokes the streaming callbacks so the M65
// shared-output path runs without Docker (mirrors m54-run-status.test.ts).
const mockRun: { impl?: (opts: any) => Promise<any> } = {};
vi.mock("../src/execution/pipeline.js", async (orig) => {
  const actual = (await orig()) as any;
  return {
    ...actual,
    runProject: vi.fn(async (_cfg, _pid, _cwd, opts) =>
      mockRun.impl
        ? mockRun.impl(opts)
        : {
            type: "success",
            language: "python",
            mainFile: "main.py",
            stdout: "",
            stderr: "",
            exitCode: 0,
            signal: null,
            timedOut: false,
            oom: false,
            durationMs: 1,
          },
    ),
  };
});
vi.mock("../src/projects/service.js", async (orig) => {
  const actual = (await orig()) as any;
  return { ...actual, workspacePath: vi.fn(async () => wsDir) };
});
let wsDir = "/tmp";

const MESSAGE_CUSTOM = 3;

function decodeCustomFrames(raw: Buffer | ArrayBuffer | Uint8Array): any[] {
  const out: any[] = [];
  try {
    const dec = decoding.createDecoder(new Uint8Array(raw as any));
    if (decoding.readVarUint(dec) === MESSAGE_CUSTOM) {
      out.push(JSON.parse(decoding.readVarString(dec)));
    }
  } catch {
    /* sync / awareness frame */
  }
  return out;
}

describe("M65 — shared run output: authorization + end-to-end", () => {
  let server: Server;
  let db: Db;
  let cfg: AppConfig;
  let base: string;
  let wsPort: number;

  let ownerTok: string;
  let ownerId: number;
  let editorTok: string;
  let editorId: number;
  let viewerTok: string;
  let viewerId: number;
  let strangerTok: string;
  let projectId: string;

  const register = async (username: string) => {
    const r = (await fetch(`${base}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password: "secret123" }),
    }).then((x) => x.json())) as { token: string; user: { id: number } };
    return r;
  };

  beforeAll(async () => {
    cfg = makeTestConfig();
    db = openDb(":memory:");
    const app = createApp(cfg, db);
    server = createServer(app);
    setupWebSocketServer(server, db, cfg);
    await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
    wsPort = (server.address() as { port: number }).port;
    base = `http://127.0.0.1:${wsPort}`;

    const o = await register("m65owner");
    ownerTok = o.token;
    ownerId = o.user.id;
    const e = await register("m65editor");
    editorTok = e.token;
    editorId = e.user.id;
    const v = await register("m65viewer");
    viewerTok = v.token;
    viewerId = v.user.id;
    const s = await register("m65stranger");
    strangerTok = s.token;

    const proj = (await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ownerTok}`,
      },
      body: JSON.stringify({ name: "m65-demo" }),
    }).then((x) => x.json())) as { project: { id: string } };
    projectId = proj.project.id;
    wsDir = `/tmp/m65-${projectId}`;

    db.prepare(
      `INSERT INTO project_collaborators (project_id, user_id, role) VALUES (?, ?, 'editor'), (?, ?, 'viewer')`,
    ).run(projectId, editorId, projectId, viewerId);
  });

  afterAll(async () => {
    collaborationManager.getRoom(projectId)?.dispose();
    await new Promise<void>((res) => server.close(() => res()));
  });

  beforeEach(() => {
    mockRun.impl = undefined;
  });

  const openCollab = (token: string) =>
    new Promise<{ ws: WebSocket; frames: any[] }>((resolve, reject) => {
      const frames: any[] = [];
      const ws = new WebSocket(
        `ws://127.0.0.1:${wsPort}/ws/collab?projectId=${projectId}`,
        { headers: { Cookie: `session_token=${token}` } },
      );
      ws.on("message", (d: any) => frames.push(...decodeCustomFrames(d)));
      ws.on("open", () => resolve({ ws, frames }));
      ws.on("error", reject);
      ws.on("unexpected-response", (_req, res) =>
        reject(new Error(`upgrade ${res.statusCode}`)),
      );
    });

  const tryUpgrade = (path: string, token: string) =>
    new Promise<number>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${wsPort}${path}`, {
        headers: { Cookie: `session_token=${token}` },
      });
      ws.on("open", () => {
        resolve(101);
        ws.close();
      });
      ws.on("unexpected-response", (_req, res) =>
        resolve(res.statusCode ?? 0),
      );
      ws.on("error", () => resolve(0));
    });

  it("a viewer cannot open /ws/execute (no stdin, no kill — editor+ only)", async () => {
    expect(await tryUpgrade(`/ws/execute?projectId=${projectId}`, viewerTok)).toBe(
      403,
    );
  });

  it("a non-member cannot open /ws/execute", async () => {
    expect(
      await tryUpgrade(`/ws/execute?projectId=${projectId}`, strangerTok),
    ).toBe(403);
  });

  it("a non-member cannot subscribe to the collaboration room", async () => {
    expect(
      await tryUpgrade(`/ws/collab?projectId=${projectId}`, strangerTok),
    ).toBe(403);
  });

  it("an editor can open /ws/execute", async () => {
    expect(
      await tryUpgrade(`/ws/execute?projectId=${projectId}`, editorTok),
    ).toBe(101);
  });

  it("an owner run streams output to an editor collaborator, never to a viewer", async () => {
    const editor = await openCollab(editorTok);
    const viewer = await openCollab(viewerTok);
    await new Promise((r) => setTimeout(r, 50));

    // Drive the real execution socket handler directly with a streaming mock.
    mockRun.impl = async (opts: any) => {
      opts.onStdout("shared line 1\n");
      opts.onStdout("shared line 2\n");
      opts.onStderr("a warning\n");
      return {
        type: "success",
        language: "python",
        mainFile: "main.py",
        stdout: "",
        stderr: "",
        exitCode: 0,
        signal: null,
        timedOut: false,
        oom: false,
        durationMs: 3,
      };
    };

    const execWs = makeFakeExecWs();
    await handleExecutionConnection(
      execWs as any,
      projectId,
      ownerId,
      "m65owner",
      cfg,
      db,
    );
    execWs.emit(
      "message",
      Buffer.from(
        JSON.stringify({ type: "start", language: "python", activeFile: "main.py" }),
      ),
    );

    await new Promise((r) => setTimeout(r, 250));

    const editorOut = editor.frames.filter((f) => f.type === "run_output");
    expect(editorOut.length).toBeGreaterThan(0);
    const text = editorOut
      .flatMap((f) => f.chunks.map((c: any) => c.data))
      .join("");
    expect(text).toContain("shared line 1");
    expect(text).toContain("shared line 2");
    expect(text).toContain("a warning");

    expect(viewer.frames.filter((f) => f.type === "run_output")).toHaveLength(0);
    // viewer still sees run status (M54)
    expect(
      viewer.frames.filter((f) => f.type === "run_status").length,
    ).toBeGreaterThan(0);

    editor.ws.close();
    viewer.ws.close();
  });
});

/** Minimal EventEmitter-shaped ws stand-in for handleExecutionConnection. */
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
