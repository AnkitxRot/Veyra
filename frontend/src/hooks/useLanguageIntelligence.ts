import { useEffect, useRef } from "react";
import { monaco } from "../monacoSetup";
import { getWebSocketUrl } from "../api";
import { throttleDirtyPaths } from "../utils/throttleLatest";
import type { Diagnostic } from "../utils/diagnostics";
import { LspBridge, createWebSocketTransport } from "../lsp/bridge";
import {
  ensureLspProviders,
  setLspBridge,
} from "../lsp/providers";
import {
  LSP_DIAGNOSTICS_EVENT,
  LSP_STATUS_EVENT,
  type LspDiagnostic,
  type LspStatus,
} from "../lsp/types";
import {
  documentLanguageId,
  isLspPath,
  lspLanguageForPath,
  lspServerIdsForFiles,
  type LspServerId,
} from "../lsp/languages";

const CHANGE_WAIT_MS = 200;
const MARKER_OWNER = "lsp";
const MAX_RECONNECT = 5;

function pathsForServer(
  openFiles: { path: string }[],
  serverId: LspServerId,
): string[] {
  return openFiles
    .map((f) => f.path)
    .filter((p) => lspLanguageForPath(p)?.id === serverId);
}

function toDiagnostics(rel: string, items: LspDiagnostic[]): Diagnostic[] {
  return items.slice(0, 500).map((d, i) => {
    const sev =
      d.severity === 1 ? "error" : d.severity === 2 ? "warning" : "info";
    return {
      id: `lsp-${rel}-${d.range?.start?.line ?? 0}-${i}`,
      severity: sev,
      message: d.message || "issue",
      filePath: rel,
      line: (d.range?.start?.line ?? 0) + 1,
      column: (d.range?.start?.character ?? 0) + 1,
      endLine: (d.range?.end?.line ?? d.range?.start?.line ?? 0) + 1,
      endColumn: (d.range?.end?.character ?? 0) + 1,
      source: d.source || "lsp",
      code: d.code !== undefined ? String(d.code) : undefined,
    };
  });
}

function applyMarkers(rel: string, diags: Diagnostic[]): void {
  const uri = monaco.Uri.file(rel);
  const model = monaco.editor.getModel(uri);
  if (!model || model.isDisposed()) return;
  monaco.editor.setModelMarkers(
    model,
    MARKER_OWNER,
    diags.map((d) => ({
      severity:
        d.severity === "error"
          ? monaco.MarkerSeverity.Error
          : d.severity === "warning"
            ? monaco.MarkerSeverity.Warning
            : monaco.MarkerSeverity.Info,
      message: d.message,
      startLineNumber: d.line,
      startColumn: d.column || 1,
      endLineNumber: d.endLine || d.line,
      endColumn: d.endColumn || (d.column ? d.column + 1 : 1),
      source: d.source,
    })),
  );
}

function clearAllLspMarkers(): void {
  for (const model of monaco.editor.getModels()) {
    monaco.editor.setModelMarkers(model, MARKER_OWNER, []);
  }
}

function emitStatus(status: LspStatus): void {
  document.dispatchEvent(new CustomEvent(LSP_STATUS_EVENT, { detail: status }));
}

function emitDiagnostics(all: Map<string, Diagnostic[]>): void {
  const diagnostics = [...all.values()].flat();
  document.dispatchEvent(
    new CustomEvent(LSP_DIAGNOSTICS_EVENT, { detail: { diagnostics } }),
  );
}

interface ServerSession {
  id: LspServerId;
  bridge: LspBridge;
  opened: Set<string>;
  gen: number;
  attempts: number;
  reconnect: ReturnType<typeof setTimeout> | null;
}

/**
 * Project-scoped language-intelligence sessions (Python + TypeScript/JS).
 * Opening or editing a file never depends on this succeeding — a failed or
 * missing server is a status chip, not an editor error.
 */
export function useLanguageIntelligence(opts: {
  projectId?: string;
  openFiles: { path: string }[];
  getLiveContent: (path: string) => string | null;
}): void {
  const { projectId, openFiles, getLiveContent } = opts;
  const getLiveRef = useRef(getLiveContent);
  getLiveRef.current = getLiveContent;
  const openRef = useRef(openFiles);
  openRef.current = openFiles;
  const sessionsRef = useRef(new Map<LspServerId, ServerSession>());
  const gensRef = useRef(new Map<LspServerId, number>());
  const attemptsRef = useRef(new Map<LspServerId, number>());
  const diagsRef = useRef(new Map<string, Diagnostic[]>());
  const wanted = lspServerIdsForFiles(openFiles);
  const wantedKey = wanted.join(",");

  useEffect(() => {
    ensureLspProviders();
  }, []);

  useEffect(() => {
    const wantedIds = (
      wantedKey ? wantedKey.split(",") : []
    ) as LspServerId[];
    if (!projectId || wantedIds.length === 0) {
      teardownAll("stopped");
      emitDiagnostics(new Map());
      return;
    }

    let cancelled = false;

    const syncDocuments = (session: ServerSession, forceOpen: boolean) => {
      if (session.bridge.status.state !== "ready") return;
      const live = pathsForServer(openRef.current, session.id);
      const opened = session.opened;
      for (const path of [...opened]) {
        if (!live.includes(path)) {
          session.bridge.didClose(path);
          opened.delete(path);
          diagsRef.current.delete(path);
          applyMarkers(path, []);
        }
      }
      for (const path of live) {
        const text = getLiveRef.current(path) ?? "";
        if (!opened.has(path) || forceOpen) {
          session.bridge.didOpen(path, text, documentLanguageId(path));
          opened.add(path);
        }
      }
      emitDiagnostics(diagsRef.current);
    };

    const connect = (serverId: LspServerId) => {
      if (cancelled) return;
      dropSession(serverId, false);
      const gen = (gensRef.current.get(serverId) ?? 0) + 1;
      gensRef.current.set(serverId, gen);
      const session: ServerSession = {
        id: serverId,
        bridge: null as unknown as LspBridge,
        opened: new Set(),
        gen,
        attempts: attemptsRef.current.get(serverId) ?? 0,
        reconnect: null,
      };
      const url = getWebSocketUrl("/ws/lsp", projectId, { language: serverId });
      const transport = createWebSocketTransport(url);
      const bridge = new LspBridge(transport);
      session.bridge = bridge;
      sessionsRef.current.set(serverId, session);
      setLspBridge(serverId, bridge);
      transport.onClose(() => {
        if (cancelled) return;
        const current = sessionsRef.current.get(serverId);
        if (!current || current.gen !== session.gen) return;
        if (current.attempts >= MAX_RECONNECT) {
          emitStatus({
            state: "unavailable",
            language: serverId,
            message: "language server disconnected",
          });
          return;
        }
        current.attempts += 1;
        attemptsRef.current.set(serverId, current.attempts);
        const delay = Math.min(1500 * current.attempts, 8000);
        current.reconnect = setTimeout(() => connect(serverId), delay);
      });
      bridge.onStatus = (status) => {
        if (cancelled) return;
        emitStatus(status);
        if (status.state === "ready") {
          attemptsRef.current.set(serverId, 0);
          const current = sessionsRef.current.get(serverId);
          if (current) current.attempts = 0;
          syncDocuments(session, true);
        }
      };
      bridge.onDiagnostics = (rel, items) => {
        if (cancelled) return;
        const diags = toDiagnostics(rel, items);
        diagsRef.current.set(rel, diags);
        applyMarkers(rel, diags);
        emitDiagnostics(diagsRef.current);
      };
    };

    const wantedSet = new Set(wantedIds);
    for (const id of [...sessionsRef.current.keys()]) {
      if (!wantedSet.has(id)) dropSession(id, true);
    }
    for (const id of wantedIds) {
      if (!sessionsRef.current.has(id)) connect(id);
    }

    const change = throttleDirtyPaths((path: string) => {
      const spec = lspLanguageForPath(path);
      if (!spec) return;
      const session = sessionsRef.current.get(spec.id);
      if (!session || session.bridge.status.state !== "ready") return;
      if (!session.opened.has(path)) return;
      const text = getLiveRef.current(path);
      if (text === null) return;
      session.bridge.didChange(path, text);
    }, CHANGE_WAIT_MS);

    const onContent = (e: Event) => {
      const path = (e as CustomEvent).detail?.path as string | undefined;
      if (!path || !isLspPath(path)) return;
      change(path);
    };
    document.addEventListener("ide-live-content-change", onContent);

    return () => {
      cancelled = true;
      document.removeEventListener("ide-live-content-change", onContent);
      change.flush();
      change.cancel();
      teardownAll("stopped");
    };

    function dropSession(serverId: LspServerId, emitStopped: boolean) {
      const prev = sessionsRef.current.get(serverId);
      if (!prev) return;
      sessionsRef.current.delete(serverId);
      if (prev.reconnect) clearTimeout(prev.reconnect);
      setLspBridge(serverId, null);
      prev.bridge.dispose();
      for (const path of prev.opened) {
        diagsRef.current.delete(path);
        applyMarkers(path, []);
      }
      if (emitStopped) emitStatus({ state: "stopped", language: serverId });
    }

    function teardownAll(reason: "stopped") {
      for (const id of [...sessionsRef.current.keys()]) {
        dropSession(id, true);
      }
      diagsRef.current.clear();
      clearAllLspMarkers();
      if (reason === "stopped" && wantedIds.length === 0) {
        emitStatus({ state: "stopped", language: "python" });
        emitStatus({ state: "stopped", language: "typescript" });
      }
    }
    // Document open/close is handled by the effect below. `wantedKey` starts
    // or stops sockets as languages appear/disappear in open tabs.
  }, [projectId, wantedKey]);

  useEffect(() => {
    for (const session of sessionsRef.current.values()) {
      if (session.bridge.status.state !== "ready") continue;
      const live = pathsForServer(openFiles, session.id);
      const opened = session.opened;
      for (const path of [...opened]) {
        if (!live.includes(path)) {
          session.bridge.didClose(path);
          opened.delete(path);
          diagsRef.current.delete(path);
          applyMarkers(path, []);
        }
      }
      for (const path of live) {
        if (opened.has(path)) continue;
        session.bridge.didOpen(
          path,
          getLiveContent(path) ?? "",
          documentLanguageId(path),
        );
        opened.add(path);
      }
    }
    emitDiagnostics(diagsRef.current);
  }, [openFiles, getLiveContent]);
}
