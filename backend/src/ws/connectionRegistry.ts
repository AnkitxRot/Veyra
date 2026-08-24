import type { WebSocket } from "ws";
import type { Socket } from "node:net";

/**
 * Tracks every live, authenticated WebSocket connection (terminal, execute,
 * collab, admin telemetry) by userId, plus every raw proxied socket (web
 * preview WebSocket upgrades). WS auth is only checked once, at upgrade
 * time (see ws/index.ts) — there is no per-message re-validation. Without
 * this registry, revoking a user's session (admin password reset, admin
 * user deletion) only stops *new* connections/requests from authenticating;
 * any WebSocket the user already had open keeps working indefinitely,
 * retaining full terminal shell access, code execution, and live
 * collaborative editing regardless of the revocation.
 */
const connectionsByUser = new Map<number, Set<WebSocket>>();
const proxySocketsByUser = new Map<number, Set<Socket>>();

export function registerConnection(userId: number, ws: WebSocket): void {
  let set = connectionsByUser.get(userId);
  if (!set) {
    set = new Set();
    connectionsByUser.set(userId, set);
  }
  set.add(ws);
}

export function unregisterConnection(userId: number, ws: WebSocket): void {
  const set = connectionsByUser.get(userId);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) {
    connectionsByUser.delete(userId);
  }
}

export function registerProxySocket(userId: number, socket: Socket): void {
  let set = proxySocketsByUser.get(userId);
  if (!set) {
    set = new Set();
    proxySocketsByUser.set(userId, set);
  }
  set.add(socket);
}

export function unregisterProxySocket(userId: number, socket: Socket): void {
  const set = proxySocketsByUser.get(userId);
  if (!set) return;
  set.delete(socket);
  if (set.size === 0) {
    proxySocketsByUser.delete(userId);
  }
}

const FORCE_TERMINATE_AFTER_MS = 1000;

/**
 * Forcibly closes every live WebSocket connection for a user. Call this
 * whenever a user's session/account is revoked outside the normal
 * expiry/logout flow (admin password reset, admin user deletion).
 *
 * `ws.close()` alone only starts a graceful close handshake: the socket
 * stays open and keeps processing inbound frames until the peer replies
 * or the library's own ~30s handshake timeout fires. A hostile client
 * holding a compromised session — exactly the threat this function exists
 * to cut off — can simply not reply and keep sending data for that whole
 * window. Back the graceful close with a short deferred `terminate()` so a
 * client that ignores the close frame still loses the connection quickly.
 */
export function closeAllConnectionsForUser(
  userId: number,
  code = 4401,
  reason = "Session revoked",
): void {
  const set = connectionsByUser.get(userId);
  if (set) {
    for (const ws of Array.from(set)) {
      try {
        ws.close(code, reason);
      } catch {}
      const timer = setTimeout(() => {
        try {
          ws.terminate();
        } catch {}
      }, FORCE_TERMINATE_AFTER_MS);
      timer.unref?.();
    }
  }

  // Raw proxied sockets (web preview WebSocket upgrades) have no WebSocket
  // close handshake — destroy them immediately rather than deferring, which
  // is both correct and strictly safer than the graceful-close-then-terminate
  // pattern above.
  const proxySet = proxySocketsByUser.get(userId);
  if (proxySet) {
    for (const socket of Array.from(proxySet)) {
      try {
        socket.destroy();
      } catch {}
    }
  }
}

/** Test/diagnostic use only. */
export function activeConnectionCountForUser(userId: number): number {
  return connectionsByUser.get(userId)?.size ?? 0;
}

/** Observability-only gauge: total live authenticated WS connections across all users. */
export function activeConnectionCount(): number {
  let total = 0;
  for (const set of connectionsByUser.values()) total += set.size;
  return total;
}
