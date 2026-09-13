import { useEffect, useRef } from "react";
import { monaco } from "../monacoSetup";
import { getWebSocketUrl } from "../api";
import { throttleLatest } from "../utils/throttleLatest";
import type { Diagnostic } from "../utils/diagnostics";
import { LspBridge, createWebSocketTransport } from "../lsp/bridge";
import { ensureLspProviders, setActiveLspBridge } from "../lsp/providers";
import {
  LSP_DIAGNOSTICS_EVENT,
  LSP_STATUS_EVENT,
  type LspDiagnostic,
  type LspStatus,
} from "../lsp/types";
import { isPythonPath } from "../lsp/uri";

const CHANGE_WAIT_MS = 200;
const MARKER_OWNER = "lsp";
const MAX_RECONNECT = 5;

function pythonPaths(openFiles: { path: string }[]): string[] {
  return openFiles.map((f) => f.path).filter(isPythonPath);
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
      source: d.source || "pylsp",
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

/**
 * Project-scoped Python language-intelligence session. Opening or editing a
 * file never depends on this succeeding — a failed or missing server is a
 * status chip, not an editor error.
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
  const bridgeRef = useRef<LspBridge | null>(null);
  const openedRef = useRef(new Set<string>());
  const diagsRef = useRef(new Map<string, Diagnostic[]>());
  const attemptsRef = useRef(0);
  const reconnectRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const genRef = useRef(0);
  const hasPython = pythonPaths(openFiles).length > 0;

  useEffect(() => {
    ensureLspProviders();
  }, []);

  useEffect(() => {
    if (!projectId || !hasPython) {
      teardown();
      emitStatus({ state: "stopped", language: "python" });
      emitDiagnostics(new Map());
      return;
    }

    let cancelled = false;
    attemptsRef.current = 0;

    const connect = () => {
      if (cancelled) return;
      genRef.current += 1;
      const gen = genRef.current;
      const prev = bridgeRef.current;
      bridgeRef.current = null;
      setActiveLspBridge(null);
      if (prev) prev.dispose();
      const url = getWebSocketUrl("/ws/lsp", projectId, { language: "python" });
      const transport = createWebSocketTransport(url);
      const bridge = new LspBridge(transport);
      bridgeRef.current = bridge;
      setActiveLspBridge(bridge);
      openedRef.current = new Set();
      transport.onClose(() => {
        if (cancelled || genRef.current !== gen) return;
        if (attemptsRef.current >= MAX_RECONNECT) {
          emitStatus({
            state: "unavailable",
            language: "python",
            message: "language server disconnected",
          });
          return;
        }
        attemptsRef.current += 1;
        const delay = Math.min(1500 * attemptsRef.current, 8000);
        reconnectRef.current = setTimeout(() => connect(), delay);
      });
      bridge.onStatus = (status) => {
        if (cancelled) return;
        emitStatus(status);
        if (status.state === "ready") {
          attemptsRef.current = 0;
          syncDocuments(bridge, true);
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

    const syncDocuments = (bridge: LspBridge, forceOpen: boolean) => {
      if (bridge.status.state !== "ready") return;
      const live = pythonPaths(openRef.current);
      const opened = openedRef.current;
      for (const path of [...opened]) {
        if (!live.includes(path)) {
          bridge.didClose(path);
          opened.delete(path);
          diagsRef.current.delete(path);
          applyMarkers(path, []);
        }
      }
      for (const path of live) {
        const text = getLiveRef.current(path) ?? "";
        if (!opened.has(path) || forceOpen) {
          bridge.didOpen(path, text);
          opened.add(path);
        }
      }
      emitDiagnostics(diagsRef.current);
    };

    const change = throttleLatest((path: string) => {
      const bridge = bridgeRef.current;
      if (!bridge || bridge.status.state !== "ready") return;
      if (!openedRef.current.has(path)) return;
      const text = getLiveRef.current(path);
      if (text === null) return;
      bridge.didChange(path, text);
    }, CHANGE_WAIT_MS);

    const onContent = (e: Event) => {
      const path = (e as CustomEvent).detail?.path as string | undefined;
      if (!path || !isPythonPath(path)) return;
      change(path);
    };
    document.addEventListener("ide-live-content-change", onContent);

    connect();

    return () => {
      cancelled = true;
      document.removeEventListener("ide-live-content-change", onContent);
      change.cancel();
      if (reconnectRef.current) {
        clearTimeout(reconnectRef.current);
        reconnectRef.current = null;
      }
      teardown();
      emitStatus({ state: "stopped", language: "python" });
      emitDiagnostics(new Map());
    };

    function teardown() {
      genRef.current += 1;
      const prev = bridgeRef.current;
      bridgeRef.current = null;
      setActiveLspBridge(null);
      if (prev) prev.dispose();
      openedRef.current.clear();
      diagsRef.current.clear();
      clearAllLspMarkers();
    }
    // openFiles is synced via openRef; reconnecting on every tab change would
    // drop the language-server socket. Document open/close is handled by the
    // separate effect below. `hasPython` is the boolean that should start or
    // stop the socket (first .py opened / last .py closed).
  }, [projectId, hasPython]);

  useEffect(() => {
    const bridge = bridgeRef.current;
    if (!bridge) return;
    const live = pythonPaths(openFiles);
    if (live.length === 0) return;
    if (bridge.status.state !== "ready") return;
    const opened = openedRef.current;
    for (const path of [...opened]) {
      if (!live.includes(path)) {
        bridge.didClose(path);
        opened.delete(path);
        diagsRef.current.delete(path);
        applyMarkers(path, []);
      }
    }
    for (const path of live) {
      if (opened.has(path)) continue;
      bridge.didOpen(path, getLiveContent(path) ?? "");
      opened.add(path);
    }
    emitDiagnostics(diagsRef.current);
  }, [openFiles, getLiveContent]);
}
