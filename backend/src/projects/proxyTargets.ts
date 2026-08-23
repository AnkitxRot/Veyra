import type { RequestHandler } from "http-proxy-middleware";
import { createProxyMiddleware } from "http-proxy-middleware";
import type { Db } from "../db.js";
import type { AppConfig } from "../config.js";
import { ApiError } from "../errors.js";
import { requireOwnedProject } from "./service.js";
import { sandboxManager } from "../execution/sandbox.js";
import { ALLOWED_PREVIEW_PORTS } from "../execution/previewPorts.js";

export interface ProxyEntry {
  target: string;
  proxy: RequestHandler;
}

// Keyed by projectId+port (not by target): in non-containerized mode
// `getProxyTarget` embeds a Docker-assigned ephemeral host port that
// changes every time a sandbox is recreated (idle reap, manual restart,
// etc). Keying on the target itself would leave one permanently-cached
// http-proxy-middleware instance per historical target, growing without
// bound over the server's lifetime. Keying on the stable (projectId, port)
// pair instead means each restart just replaces the one existing entry.
const proxyCache = new Map<string, ProxyEntry>();

export async function resolveProxyEntry(
  db: Db,
  userId: number,
  projectId: string,
  portRaw: string,
  cfg: AppConfig,
): Promise<{ entry: ProxyEntry; port: number; prefix: string }> {
  const project = requireOwnedProject(db, userId, projectId);

  const port = parseInt(portRaw, 10);
  if (isNaN(port) || !ALLOWED_PREVIEW_PORTS.includes(port as any)) {
    throw new ApiError(400, "Invalid port", "invalid_port");
  }

  const target = await sandboxManager.getProxyTarget(
    project.id,
    port,
    cfg.containerized,
  );
  if (!target) {
    throw new ApiError(
      404,
      `Port ${port} is not published by the sandbox`,
      "not_found",
    );
  }

  const prefix = `/api/projects/${projectId}/proxy/${port}`;
  const cacheKey = `${projectId}:${port}`;
  let entry = proxyCache.get(cacheKey);
  if (!entry || entry.target !== target) {
    entry = {
      target,
      proxy: createProxyMiddleware({
        target,
        changeOrigin: true,
        pathRewrite: { [`^${prefix}`]: "" },
        // `ws: false` is load-bearing: `ws: true` would auto-subscribe this
        // middleware instance to the HTTP server's 'upgrade' event on the
        // first regular HTTP request through it, after which its own
        // exposed `.upgrade()` method silently becomes a no-op. ws/index.ts
        // calls `entry.proxy.upgrade(...)` explicitly after doing its own
        // authorization, so that call must remain the only path that ever
        // handles these upgrades.
        ws: false,
      }),
    };
    proxyCache.set(cacheKey, entry);
  }

  return { entry, port, prefix };
}
