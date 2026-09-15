/**
 * M86 security — `.git` is unreachable through every workspace write path.
 *
 * Host-side Git honors the repository's own `.git/config` (a filter driver
 * runs a command during `git add`). The by-path guard compared only the raw
 * first segment, so normalized or case/Win32 variants reached `.git` through
 * REST (reproduced: `./.git/…`, `sub/../.git/…`, `.GIT/…` all returned 200),
 * upload had no `.git` check, and a symlink such as `link -> .git` bypasses
 * any lexical check. The guard now also runs on the real path inside
 * `assertInsideWorkspace`, which every file boundary shares.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { existsSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import WebSocket from "ws";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as encoding from "lib0/encoding";

import { makeTestConfig } from "./helpers.js";
import { openDb } from "../src/db.js";
import type { AppConfig } from "../src/config.js";
import { createApp } from "../src/app.js";
import { setupWebSocketServer } from "../src/ws/index.js";
import { collaborationManager } from "../src/collab/manager.js";

const BYPASSES = [
  "./.git/m86probe",
  "sub/../.git/m86probe",
  ".GIT/m86probe",
  ".git./m86probe",
  ".git /m86probe",
];

describe("M86 .git internals cannot be written through workspace paths", () => {
  let cfg: AppConfig;
  let server: Server;
  let base = "";
  let token = "";
  let projectId = "";
  let dir = "";

  async function api(method: string, path: string, body?: unknown) {
    const res = await fetch(base + path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data: any = await res.json().catch(() => ({}));
    return { status: res.status, data };
  }

  beforeAll(async () => {
    cfg = makeTestConfig();
    const db = openDb(":memory:");
    server = createServer(createApp(cfg, db));
    setupWebSocketServer(server, db, cfg);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const reg = await fetch(`${base}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "m86gitguard", password: "secret123" }),
    }).then((r) => r.json() as Promise<{ token: string }>);
    token = reg.token;
    const proj = await api("POST", "/api/projects", { name: "m86-git-guard" });
    projectId = proj.data.project.id;
    dir = join(cfg.workspacesDir, projectId);
    expect((await api("POST", `/api/projects/${projectId}/git/init`)).status).toBe(200);
  });

  afterAll(async () => {
    collaborationManager.getRoom(projectId)?.dispose();
    server.closeIdleConnections?.();
    await new Promise<void>((r) => server.close(() => r()));
  });

  const landed = () => existsSync(join(dir, ".git", "m86probe"));

  it.each(BYPASSES)("REST file write refuses %j", async (path) => {
    const r = await api("POST", `/api/projects/${projectId}/file`, {
      path,
      content: '[filter "x"]\n',
    });
    expect(r.status).toBe(400);
    expect(landed()).toBe(false);
  });

  it("REST file write refuses a symlink that points into .git", async () => {
    symlinkSync(
      join(dir, ".git"),
      join(dir, "gitlink"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const r = await api("POST", `/api/projects/${projectId}/file`, {
      path: "gitlink/m86probe",
      content: "x",
    });
    expect(r.status).toBe(400);
    expect(landed()).toBe(false);
  });

  it("upload refuses .git entries", async () => {
    const r = await api("POST", `/api/projects/${projectId}/upload`, {
      files: [{ path: "./.git/m86probe", content: "x" }],
    });
    expect(r.status).toBe(400);
    expect(landed()).toBe(false);
  });

  it("a collaborative key using a bypass form is never persisted", async () => {
    const ws = new WebSocket(
      `${base.replace(/^http/, "ws")}/ws/collab?projectId=${projectId}`,
      { headers: { Cookie: `session_token=${token}` } },
    );
    const step1 = new Promise<void>((r) => ws.once("message", () => r()));
    await new Promise<void>((r, e) => {
      ws.once("open", () => r());
      ws.once("error", e);
    });
    await step1;
    try {
      const doc = new Y.Doc();
      let update: Uint8Array | null = null;
      doc.on("update", (u: Uint8Array) => {
        update = u;
      });
      doc.transact(() => {
        doc.getText("sub/../.git/m86probe").insert(0, "[filter]\n");
        doc.getText("visible.txt").insert(0, "ok\n");
      });
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, 0);
      syncProtocol.writeUpdate(enc, update!);
      ws.send(encoding.toUint8Array(enc));

      const start = Date.now();
      while (
        collaborationManager.getRoom(projectId)?.doc.getText("visible.txt").toString() !==
        "ok\n"
      ) {
        if (Date.now() - start > 5000) throw new Error("edit never arrived");
        await new Promise((r) => setTimeout(r, 10));
      }
      await collaborationManager.getRoom(projectId)!.flushToDisk();

      expect(readFileSync(join(dir, "visible.txt"), "utf8")).toBe("ok\n");
      expect(landed()).toBe(false);
    } finally {
      ws.close();
    }
  });

  it("ordinary dotfiles that merely start with .git still work", async () => {
    for (const path of [".gitignore", ".github/workflows/ci.yml"]) {
      const r = await api("POST", `/api/projects/${projectId}/file`, {
        path,
        content: "x\n",
      });
      expect(r.status, path).toBe(200);
    }
  });
});
