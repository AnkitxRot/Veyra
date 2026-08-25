// M5a load harness: one virtual user's behavior loop. Real HTTP requests via
// fetch, real WebSocket connections via `ws`, real Yjs sync-protocol frames
// (same wire format the frontend collab client speaks) — no protocol
// mocking. Each VU is a distinct registered user, so per-user quotas
// (maxConcurrentRuns, maxSandboxesPerUser, maxTerminalsPerUser) are
// exercised the same way real distinct users would exercise them.
import WebSocket from "ws";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { randomUUID } from "node:crypto";
import { MetricsCollector, type Outcome } from "./metrics.js";

const MESSAGE_SYNC = 0;

export type BehaviorName =
  | "idle"
  | "active_editor"
  | "collab_pair"
  | "busy_room"
  | "many_rooms_thin"
  | "execution_heavy"
  | "preview_heavy"
  | "reconnecting"
  | "rapid_typing"
  | "file_save_heavy"
  | "metadata_write_heavy";

export interface VirtualUserContext {
  baseUrl: string;
  wsBase: string;
  metrics: MetricsCollector;
  signal: AbortSignal;
  vuIndex: number;
  /** Pre-shared project ids for "busy_room" / "collab_pair" concentration. */
  sharedProjectIds: string[];
  /**
   * M5c write-contention cross-check only: when set, "file_save_heavy" VUs
   * write to this single pre-existing project/file instead of each creating
   * their own — concentrates every write onto the same DB row/file to
   * isolate write serialization from ordinary cross-project write spread.
   */
  sharedWriteTarget?: { projectId: string; path: string };
}

function classifyStatus(status: number, bodyText: string): Outcome {
  if (status >= 200 && status < 300) return "success";
  if (status === 429) return "clean_quota_rejection";
  // Sandbox-level quota errors (maxSandboxes / maxSandboxesPerUser) are
  // thrown as plain Errors in sandbox.ts and surface as generic 500s with a
  // fixed "internal server error" body (errors.ts swallows the real
  // message) — indistinguishable from a genuine crash purely client-side.
  // This is itself a finding, not a harness bug: see the evidence report.
  if (status === 500 && /internal server error/i.test(bodyText)) return "crash";
  return "crash";
}

async function timedFetch(
  ctx: VirtualUserContext,
  endpointClass: string,
  url: string,
  init: RequestInit,
): Promise<{ status: number; json: any } | null> {
  const start = performance.now();
  try {
    const res = await fetch(url, { ...init, signal: ctx.signal });
    const text = await res.text();
    const elapsed = performance.now() - start;
    ctx.metrics.recordRequest(
      endpointClass,
      elapsed,
      classifyStatus(res.status, text),
    );
    let json: any = {};
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, json };
  } catch (err: any) {
    const elapsed = performance.now() - start;
    if (ctx.signal.aborted) return null;
    const outcome: Outcome =
      err?.name === "AbortError" ? "timeout" : "connection_failure";
    ctx.metrics.recordRequest(endpointClass, elapsed, outcome);
    return null;
  }
}

async function registerAndLogin(
  ctx: VirtualUserContext,
): Promise<{ token: string; username: string } | null> {
  const username = `vu_${ctx.vuIndex}_${randomUUID().slice(0, 8)}`;
  const password = "load-test-password-1234";
  const reg = await timedFetch(
    ctx,
    "auth",
    `${ctx.baseUrl}/api/auth/register`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    },
  );
  if (!reg || reg.status !== 201) return null;
  return { token: reg.json.token as string, username };
}

async function createProject(
  ctx: VirtualUserContext,
  token: string,
): Promise<string | null> {
  const res = await timedFetch(
    ctx,
    "project_create",
    `${ctx.baseUrl}/api/projects`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ name: `loadtest-${randomUUID().slice(0, 8)}` }),
    },
  );
  return res?.json?.project?.id ?? null;
}

// Exported for direct unit testing of listener/resource lifecycle
// (backend/test/virtualUser.test.ts) — not used outside this module
// otherwise.
export async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    // Every sleep() call must remove its own "abort" listener before
    // resolving — otherwise a long-running VU (hundreds of edits, each
    // followed by a sleep()) permanently accumulates one listener per call
    // on the single shared AbortSignal, none of which are ever invoked
    // again after they fire once, but all of which stay reachable (and
    // retain their closure scope) until the signal itself is released.
    let t: NodeJS.Timeout;
    const onAbort = () => {
      clearTimeout(t);
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort);
  });
}

function jitter(baseMs: number, spreadMs: number): number {
  return baseMs + Math.random() * spreadMs;
}

/** Opens a real collab WS connection, authenticated via the session cookie. */
function connectCollab(
  wsBase: string,
  token: string,
  projectId: string,
): WebSocket {
  return new WebSocket(`${wsBase}/ws/collab?projectId=${projectId}`, {
    headers: { Cookie: `session_token=${token}` },
  });
}

async function runIdle(ctx: VirtualUserContext, token: string): Promise<void> {
  while (!ctx.signal.aborted) {
    await timedFetch(ctx, "auth_me", `${ctx.baseUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    await sleep(jitter(7000, 3000), ctx.signal);
  }
}

async function runActiveEditor(
  ctx: VirtualUserContext,
  token: string,
): Promise<void> {
  const projectId = await createProject(ctx, token);
  if (!projectId) return;
  let n = 0;
  while (!ctx.signal.aborted) {
    n++;
    const start = performance.now();
    await timedFetch(
      ctx,
      "file_save",
      `${ctx.baseUrl}/api/projects/${projectId}/file`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          path: "main.py",
          content: `print("edit ${n}")\n`,
        }),
      },
    );
    ctx.metrics.saveLatency.record(performance.now() - start);
    await sleep(jitter(2000, 1500), ctx.signal);
  }
}

/**
 * M5c write-contention workload: near-continuous real file saves (real
 * `UPDATE projects` + real file write per call, same endpoint as
 * runActiveEditor but at a much shorter interval — this is deliberately
 * concentrated write pressure, not an approximation of ordinary typing).
 * When `ctx.sharedWriteTarget` is set (the burst cross-check), every VU
 * writes to the SAME project/file instead of its own, to isolate write
 * serialization from cross-project write spread.
 */
async function runFileSaveHeavy(
  ctx: VirtualUserContext,
  token: string,
): Promise<void> {
  const target = ctx.sharedWriteTarget
    ? ctx.sharedWriteTarget
    : { projectId: await createProject(ctx, token), path: "main.py" };
  if (!target.projectId) return;
  let n = 0;
  while (!ctx.signal.aborted) {
    n++;
    const start = performance.now();
    await timedFetch(
      ctx,
      "file_save_heavy",
      `${ctx.baseUrl}/api/projects/${target.projectId}/file`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          path: target.path,
          content: `print("vu${ctx.vuIndex} edit ${n} at ${Date.now()}")\n`,
        }),
      },
    );
    ctx.metrics.saveLatency.record(performance.now() - start);
    await sleep(jitter(150, 150), ctx.signal);
  }
}

/**
 * M5c write-contention workload: repeated real snapshot creation — a real
 * INSERT into the `snapshots` table (a different table than file saves
 * touch) plus real gzip + filesystem work, exercising a distinct write path
 * under the same SQLite connection.
 */
async function runMetadataWriteHeavy(
  ctx: VirtualUserContext,
  token: string,
): Promise<void> {
  const projectId = await createProject(ctx, token);
  if (!projectId) return;
  await timedFetch(
    ctx,
    "file_save",
    `${ctx.baseUrl}/api/projects/${projectId}/file`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ path: "main.py", content: "print('seed')\n" }),
    },
  );
  let n = 0;
  while (!ctx.signal.aborted) {
    n++;
    await timedFetch(
      ctx,
      "snapshot_create",
      `${ctx.baseUrl}/api/projects/${projectId}/snapshots`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ name: `snap-${n}` }),
      },
    );
    await sleep(jitter(800, 600), ctx.signal);
  }
}

async function runExecutionHeavy(
  ctx: VirtualUserContext,
  token: string,
): Promise<void> {
  const projectId = await createProject(ctx, token);
  if (!projectId) return;
  await timedFetch(
    ctx,
    "file_save",
    `${ctx.baseUrl}/api/projects/${projectId}/file`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ path: "main.py", content: "print('hi')\n" }),
    },
  );
  while (!ctx.signal.aborted) {
    await timedFetch(
      ctx,
      "run",
      `${ctx.baseUrl}/api/projects/${projectId}/run`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ language: "python" }),
      },
    );
    await sleep(jitter(4000, 2000), ctx.signal);
  }
}

async function runPreviewHeavy(
  ctx: VirtualUserContext,
  token: string,
): Promise<void> {
  const projectId = await createProject(ctx, token);
  if (!projectId) return;
  while (!ctx.signal.aborted) {
    await timedFetch(
      ctx,
      "tree",
      `${ctx.baseUrl}/api/projects/${projectId}/tree`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    await timedFetch(
      ctx,
      "stats",
      `${ctx.baseUrl}/api/projects/${projectId}/stats`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    await sleep(jitter(1500, 1000), ctx.signal);
  }
}

/**
 * Real Yjs client wired to a collab WS socket — same shape as the
 * frontend's CollaborationClient / the M4 test helper `wireClientToRoom`.
 * Returns a disposer that removes exactly the two listeners this function
 * added (not `ws.removeAllListeners()`, which would also strip the `ws`
 * library's own internal listeners and could interfere with its close
 * handshake) — callers use this to guarantee the closure over `doc` does
 * not outlive the socket.
 */
export function wireYjsClient(ws: WebSocket, doc: Y.Doc): () => void {
  const onOpen = () => {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(encoder, doc);
    ws.send(encoding.toUint8Array(encoder));
  };
  const onMessage = (data: Buffer) => {
    const decoder = decoding.createDecoder(new Uint8Array(data));
    const messageType = decoding.readVarUint(decoder);
    if (messageType !== MESSAGE_SYNC) return;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.readSyncMessage(decoder, encoder, doc, ws);
    if (encoding.length(encoder) > 1) {
      ws.send(encoding.toUint8Array(encoder));
    }
  };
  ws.on("open", onOpen);
  ws.on("message", onMessage);
  return () => {
    ws.removeListener("open", onOpen);
    ws.removeListener("message", onMessage);
  };
}

/**
 * Waits for the socket to open, error, or the shared AbortSignal to fire —
 * whichever comes first — then removes every listener it registered
 * (including on `signal`, which lives for the whole run and would
 * otherwise accumulate one stale listener per call).
 */
export function waitForOpenOrAbort(
  ws: WebSocket,
  signal: AbortSignal,
): Promise<void> {
  return new Promise<void>((resolve) => {
    const cleanup = () => {
      ws.removeListener("open", onOpen);
      ws.removeListener("error", onError);
      signal.removeEventListener("abort", onAbort);
    };
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      resolve();
    };
    const onAbort = () => {
      cleanup();
      resolve();
    };
    ws.once("open", onOpen);
    ws.once("error", onError);
    signal.addEventListener("abort", onAbort);
  });
}

/**
 * Idempotent per-client teardown: releases exactly the listeners `unwire`
 * was given, closes the socket, and destroys the client's local Yjs
 * document — mirroring what a real browser tab does on navigation-away, so
 * no simulated peer replica (and the CRDT structure it accumulated) can
 * outlive its own virtual user. Safe to call more than once — e.g. once
 * from a `finally` block and again from an outer abort handler.
 */
export function disposeCollabClient(
  ws: WebSocket,
  doc: Y.Doc,
  unwire: () => void,
): () => void {
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    unwire();
    try {
      ws.close();
    } catch {}
    doc.destroy();
  };
}

function sendYjsInsert(
  ws: WebSocket,
  doc: Y.Doc,
  path: string,
  text: string,
): void {
  const before = Y.encodeStateVector(doc);
  doc.transact(() => {
    doc.getText(path).insert(doc.getText(path).length, text);
  });
  const update = Y.encodeStateAsUpdate(doc, before);
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  syncProtocol.writeUpdate(encoder, update);
  if (ws.readyState === WebSocket.OPEN) ws.send(encoding.toUint8Array(encoder));
}

export async function runCollabRoom(
  ctx: VirtualUserContext,
  token: string,
  projectId: string,
  editIntervalMs: number,
): Promise<void> {
  const doc = new Y.Doc();
  const ws = connectCollab(ctx.wsBase, token, projectId);
  const unwire = wireYjsClient(ws, doc);
  const dispose = disposeCollabClient(ws, doc, unwire);
  try {
    await waitForOpenOrAbort(ws, ctx.signal);

    let n = 0;
    while (!ctx.signal.aborted && ws.readyState === WebSocket.OPEN) {
      n++;
      sendYjsInsert(ws, doc, "shared.txt", `vu${ctx.vuIndex}e${n};`);
      await sleep(jitter(editIntervalMs, editIntervalMs / 2), ctx.signal);
    }
  } finally {
    // Runs on normal completion, on error, and on abort (the while loop's
    // own condition exits as soon as ctx.signal.aborted flips) — no
    // simulated client outlives this function call either way.
    dispose();
  }
}

async function runReconnecting(
  ctx: VirtualUserContext,
  token: string,
  projectId: string,
): Promise<void> {
  while (!ctx.signal.aborted) {
    const doc = new Y.Doc();
    const ws = connectCollab(ctx.wsBase, token, projectId);
    const unwire = wireYjsClient(ws, doc);
    const dispose = disposeCollabClient(ws, doc, unwire);
    try {
      await waitForOpenOrAbort(ws, ctx.signal);
      await sleep(jitter(1500, 1000), ctx.signal);
    } finally {
      // Each reconnect cycle creates a brand-new doc/socket pair — without
      // this, every single reconnect iteration (not just the VU's overall
      // lifetime) would leak its own replica.
      dispose();
    }
    await sleep(jitter(500, 500), ctx.signal);
  }
}

/**
 * Dedicated edit->peer latency probe: one sender + one listener in the same
 * room. The listener measures wall-clock time from the sender's send() call
 * (embedded as a timestamp marker in the inserted text) to its own message
 * receipt — this is the one metric ordinary VU traffic cannot self-measure,
 * since the server never echoes an update back to its origin.
 */
export async function runEditToPeerProbe(
  ctx: VirtualUserContext,
  token: string,
  projectId: string,
): Promise<() => void> {
  const senderDoc = new Y.Doc();
  const listenerDoc = new Y.Doc();
  const senderWs = connectCollab(ctx.wsBase, token, `${projectId}`);
  const listenerWs = connectCollab(ctx.wsBase, token, `${projectId}`);
  const unwireSender = wireYjsClient(senderWs, senderDoc);

  const onListenerOpen = () => {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(encoder, listenerDoc);
    listenerWs.send(encoding.toUint8Array(encoder));
  };
  const onListenerMessage = (data: Buffer) => {
    const decoder = decoding.createDecoder(new Uint8Array(data));
    const messageType = decoding.readVarUint(decoder);
    if (messageType !== MESSAGE_SYNC) return;
    const before = listenerDoc.getText("probe.txt").toString();
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.readSyncMessage(decoder, encoder, listenerDoc, listenerWs);
    const after = listenerDoc.getText("probe.txt").toString();
    if (after !== before) {
      const match = /t(\d+);$/.exec(after);
      if (match) {
        const sentAt = Number(match[1]);
        // sentAt was Math.round()-ed at the send site, which can introduce
        // up to ~0.5ms of rounding skew — clamp to 0 rather than report a
        // physically-impossible negative latency for near-zero same-process
        // round trips.
        ctx.metrics.collabEditToPeerLatency.record(
          Math.max(0, performance.now() - sentAt),
        );
      }
    }
  };
  listenerWs.on("open", onListenerOpen);
  listenerWs.on("message", onListenerMessage);

  await Promise.all([
    new Promise<void>((resolve) => {
      senderWs.once("open", () => resolve());
      senderWs.once("error", () => resolve());
    }),
    new Promise<void>((resolve) => {
      listenerWs.once("open", () => resolve());
      listenerWs.once("error", () => resolve());
    }),
  ]);

  const interval = setInterval(() => {
    if (ctx.signal.aborted || senderWs.readyState !== WebSocket.OPEN) return;
    sendYjsInsert(
      senderWs,
      senderDoc,
      "probe.txt",
      `t${Math.round(performance.now())};`,
    );
  }, 500);

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    clearInterval(interval);
    unwireSender();
    listenerWs.removeListener("open", onListenerOpen);
    listenerWs.removeListener("message", onListenerMessage);
    try {
      senderWs.close();
    } catch {}
    try {
      listenerWs.close();
    } catch {}
    senderDoc.destroy();
    listenerDoc.destroy();
  };
}

export async function runVirtualUser(
  behavior: BehaviorName,
  ctx: VirtualUserContext,
  /**
   * M5c write-burst cross-check only: when set, skips per-VU registration
   * and reuses this already-authenticated token instead. The shared write
   * target project is owned by this same identity, so every burst VU has
   * genuine edit access to it — without this, distinct freshly-registered
   * VUs would get 403s writing to a project they were never granted access
   * to, which is a test-setup gap, not real DB contention evidence.
   */
  presetToken?: string,
): Promise<void> {
  let token: string;
  if (presetToken) {
    token = presetToken;
  } else {
    const identity = await registerAndLogin(ctx);
    if (!identity) return;
    token = identity.token;
  }

  switch (behavior) {
    case "idle":
      return runIdle(ctx, token);
    case "active_editor":
      return runActiveEditor(ctx, token);
    case "file_save_heavy":
      return runFileSaveHeavy(ctx, token);
    case "metadata_write_heavy":
      return runMetadataWriteHeavy(ctx, token);
    case "execution_heavy":
      return runExecutionHeavy(ctx, token);
    case "preview_heavy":
      return runPreviewHeavy(ctx, token);
    case "collab_pair": {
      const projectId =
        ctx.sharedProjectIds[
          ctx.vuIndex % Math.max(1, ctx.sharedProjectIds.length)
        ] ?? (await createProject(ctx, token));
      if (!projectId) return;
      return runCollabRoom(ctx, token, projectId, 3000);
    }
    case "busy_room": {
      const projectId =
        ctx.sharedProjectIds[0] ?? (await createProject(ctx, token));
      if (!projectId) return;
      return runCollabRoom(ctx, token, projectId, 1500);
    }
    case "many_rooms_thin": {
      const projectId = await createProject(ctx, token);
      if (!projectId) return;
      return runCollabRoom(ctx, token, projectId, 5000);
    }
    case "rapid_typing": {
      const projectId =
        ctx.sharedProjectIds[0] ?? (await createProject(ctx, token));
      if (!projectId) return;
      return runCollabRoom(ctx, token, projectId, 200);
    }
    case "reconnecting": {
      const projectId =
        ctx.sharedProjectIds[0] ?? (await createProject(ctx, token));
      if (!projectId) return;
      return runReconnecting(ctx, token, projectId);
    }
  }
}
