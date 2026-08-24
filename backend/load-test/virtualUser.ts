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
  | "rapid_typing";

export interface VirtualUserContext {
  baseUrl: string;
  wsBase: string;
  metrics: MetricsCollector;
  signal: AbortSignal;
  vuIndex: number;
  /** Pre-shared project ids for "busy_room" / "collab_pair" concentration. */
  sharedProjectIds: string[];
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

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    });
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

/** Real Yjs client wired to a collab WS socket — same shape as the frontend's CollaborationClient / the M4 test helper `wireClientToRoom`. */
function wireYjsClient(ws: WebSocket, doc: Y.Doc): void {
  ws.on("open", () => {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(encoder, doc);
    ws.send(encoding.toUint8Array(encoder));
  });
  ws.on("message", (data: Buffer) => {
    const decoder = decoding.createDecoder(new Uint8Array(data));
    const messageType = decoding.readVarUint(decoder);
    if (messageType !== MESSAGE_SYNC) return;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.readSyncMessage(decoder, encoder, doc, ws);
    if (encoding.length(encoder) > 1) {
      ws.send(encoding.toUint8Array(encoder));
    }
  });
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

async function runCollabRoom(
  ctx: VirtualUserContext,
  token: string,
  projectId: string,
  editIntervalMs: number,
): Promise<void> {
  const doc = new Y.Doc();
  const ws = connectCollab(ctx.wsBase, token, projectId);
  wireYjsClient(ws, doc);
  await new Promise<void>((resolve) => {
    ws.once("open", () => resolve());
    ws.once("error", () => resolve());
    ctx.signal.addEventListener("abort", () => resolve());
  });

  let n = 0;
  while (!ctx.signal.aborted && ws.readyState === WebSocket.OPEN) {
    n++;
    sendYjsInsert(ws, doc, "shared.txt", `vu${ctx.vuIndex}e${n};`);
    await sleep(jitter(editIntervalMs, editIntervalMs / 2), ctx.signal);
  }
  try {
    ws.close();
  } catch {}
}

async function runReconnecting(
  ctx: VirtualUserContext,
  token: string,
  projectId: string,
): Promise<void> {
  while (!ctx.signal.aborted) {
    const doc = new Y.Doc();
    const ws = connectCollab(ctx.wsBase, token, projectId);
    wireYjsClient(ws, doc);
    await new Promise<void>((resolve) => {
      ws.once("open", () => resolve());
      ws.once("error", () => resolve());
      ctx.signal.addEventListener("abort", () => resolve());
    });
    await sleep(jitter(1500, 1000), ctx.signal);
    try {
      ws.close();
    } catch {}
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
  wireYjsClient(senderWs, senderDoc);

  listenerWs.on("open", () => {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(encoder, listenerDoc);
    listenerWs.send(encoding.toUint8Array(encoder));
  });
  listenerWs.on("message", (data: Buffer) => {
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
  });

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

  return () => {
    clearInterval(interval);
    try {
      senderWs.close();
    } catch {}
    try {
      listenerWs.close();
    } catch {}
  };
}

export async function runVirtualUser(
  behavior: BehaviorName,
  ctx: VirtualUserContext,
): Promise<void> {
  const identity = await registerAndLogin(ctx);
  if (!identity) return;
  const { token } = identity;

  switch (behavior) {
    case "idle":
      return runIdle(ctx, token);
    case "active_editor":
      return runActiveEditor(ctx, token);
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
