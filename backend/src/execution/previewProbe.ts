import type { AppConfig } from "../config.js";
import { ALLOWED_PREVIEW_PORTS } from "./previewPorts.js";
import { sandboxManager } from "./sandbox.js";

// Auto-detect which of the *fixed* ALLOWED_PREVIEW_PORTS have an HTTP server
// actually listening inside a given project's sandbox.
//
// This is NOT a port scanner:
//   - the port set is the hardcoded ALLOWED_PREVIEW_PORTS constant, never
//     anything a client supplies;
//   - each destination is resolved through the SAME
//     `sandboxManager.getProxyTarget(projectId, port, containerized)` the
//     preview proxy uses, so it is constrained to *this* project's sandbox
//     container / per-project Docker network — the caller cannot influence
//     the host or the port;
//   - callers must already be authorized for the project (the route uses the
//     same `requireOwnedProject` gate as `/api/projects/:id/proxy/:port`);
//   - results are cached per project for a short TTL so a fast-polling client
//     cannot turn this into repeated internal requests.

const PROBE_TIMEOUT_MS = 1500;
const CACHE_TTL_MS = 2000;

export interface PreviewDetection {
  /** subset of ALLOWED_PREVIEW_PORTS with a live HTTP server, in allowlist order */
  ports: number[];
  /** whether the project currently has a running sandbox at all */
  sandbox: boolean;
}

interface CacheEntry {
  at: number;
  detection: PreviewDetection;
}
const cache = new Map<string, CacheEntry>();

/**
 * One-shot probe of a single already-resolved target URL. "Listening" ==
 * the TCP connection was accepted and an HTTP response of any status came
 * back. Connection refused / DNS failure / reset-before-headers / timeout
 * all mean "not listening". The body is never buffered.
 */
export async function probeHttp(
  url: string,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "user-agent": "cloudeeeide-preview-probe" },
    });
    try {
      await res.body?.cancel();
    } catch {
      /* ignore */
    }
    return true;
  } catch {
    return false;
  }
}

export async function detectPreviewPorts(
  projectId: string,
  cfg: AppConfig,
  opts: {
    resolveTarget?: (port: number) => Promise<string | null>;
    probe?: (url: string) => Promise<boolean>;
    now?: () => number;
  } = {},
): Promise<PreviewDetection> {
  const now = opts.now ?? Date.now;

  const cached = cache.get(projectId);
  if (cached && now() - cached.at < CACHE_TTL_MS) {
    return cached.detection;
  }

  if (!sandboxManager.hasActiveSandbox(projectId)) {
    const detection: PreviewDetection = { ports: [], sandbox: false };
    cache.set(projectId, { at: now(), detection });
    return detection;
  }

  const resolveTarget =
    opts.resolveTarget ??
    ((port: number) =>
      sandboxManager.getProxyTarget(projectId, port, cfg.containerized));
  const probe = opts.probe ?? probeHttp;

  const perPort = await Promise.all(
    ALLOWED_PREVIEW_PORTS.map(async (port): Promise<number | null> => {
      const target = await resolveTarget(port);
      if (!target) return null;
      return (await probe(target)) ? port : null;
    }),
  );
  // `perPort` is aligned to ALLOWED_PREVIEW_PORTS order, so the surviving
  // entries are already in allowlist order — deterministic.
  const ports = perPort.filter((p): p is number => p !== null);

  const detection: PreviewDetection = { ports, sandbox: true };
  cache.set(projectId, { at: now(), detection });
  return detection;
}

/** test hook */
export function _clearPreviewDetectionCache(): void {
  cache.clear();
}
