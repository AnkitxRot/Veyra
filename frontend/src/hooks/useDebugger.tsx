import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { getWebSocketUrl } from "../api";
import {
  loadBreakpoints,
  saveBreakpoints,
  toggleLine,
  type BreakpointMap,
} from "../debug/breakpoints";
import { debugLanguageForPath } from "../debug/languages";
import {
  DEBUG_BREAKPOINTS_EVENT,
  DEBUG_EXECUTION_EVENT,
  DEBUG_STARTED_EVENT,
  DEBUG_STATUS_EVENT,
  DEBUG_STOPPED_EVENT,
  DEBUG_TOGGLE_BP_EVENT,
  type DebugFrame,
  type DebugScope,
  type DebugSessionState,
  type DebugVariable,
} from "../debug/types";

export interface DebugSessionValue {
  state: DebugSessionState;
  message?: string;
  language: string | null;
  frames: DebugFrame[];
  scopes: DebugScope[];
  variables: Record<number, DebugVariable[]>;
  output: { category: string; text: string }[];
  breakpoints: BreakpointMap;
  verified: Record<string, { line: number; verified: boolean }[]>;
  pausedPath: string | null;
  pausedLine: number | null;
  sourceMismatch: boolean;
  start: (entryFile: string) => void;
  continueRun: () => void;
  pause: () => void;
  stepOver: () => void;
  stepIn: () => void;
  stepOut: () => void;
  stop: () => void;
  toggleBreakpoint: (path: string, line: number) => void;
  expandVariables: (ref: number) => void;
  selectFrame: (frame: DebugFrame) => void;
}

const DebugSessionContext = createContext<DebugSessionValue | null>(null);

const LIVE = new Set<DebugSessionState>(["starting", "running", "paused"]);

function emitBreakpoints(
  path: string,
  lines: number[],
  verified: { line: number; verified: boolean }[] | undefined,
): void {
  const bps =
    verified && verified.length
      ? verified
      : lines.map((line) => ({ line, verified: false }));
  document.dispatchEvent(
    new CustomEvent(DEBUG_BREAKPOINTS_EVENT, {
      detail: { path, breakpoints: bps },
    }),
  );
}

function emitAllBreakpoints(
  map: BreakpointMap,
  verified: Record<string, { line: number; verified: boolean }[]>,
): void {
  for (const [path, lines] of Object.entries(map)) {
    emitBreakpoints(path, lines, verified[path]);
  }
}

/**
 * User-local debugger session. Not collaborative: DAP traffic, stack, and
 * breakpoints never enter Yjs. The socket is created lazily on Start.
 */
export function DebugSessionProvider({
  projectId,
  dirtyPaths,
  children,
}: React.PropsWithChildren<{
  projectId: string | null;
  dirtyPaths: string[];
}>) {
  const [state, setState] = useState<DebugSessionState>("idle");
  const [message, setMessage] = useState<string | undefined>();
  const [language, setLanguage] = useState<string | null>(null);
  const [frames, setFrames] = useState<DebugFrame[]>([]);
  const [scopes, setScopes] = useState<DebugScope[]>([]);
  const [variables, setVariables] = useState<Record<number, DebugVariable[]>>(
    {},
  );
  const [output, setOutput] = useState<{ category: string; text: string }[]>(
    [],
  );
  const [breakpoints, setBreakpoints] = useState<BreakpointMap>({});
  const [verified, setVerified] = useState<
    Record<string, { line: number; verified: boolean }[]>
  >({});
  const [pausedPath, setPausedPath] = useState<string | null>(null);
  const [pausedLine, setPausedLine] = useState<number | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const projectRef = useRef(projectId);
  projectRef.current = projectId;
  const bpRef = useRef(breakpoints);
  bpRef.current = breakpoints;
  const stateRef = useRef(state);
  stateRef.current = state;
  const socketReadyRef = useRef(false);

  useEffect(() => {
    const map = projectId ? loadBreakpoints(projectId) : {};
    setBreakpoints(map);
    setVerified({});
    setState("idle");
    setMessage(undefined);
    setFrames([]);
    setScopes([]);
    setVariables({});
    setOutput([]);
    setPausedPath(null);
    setPausedLine(null);
    socketReadyRef.current = false;
    emitAllBreakpoints(map, {});
    document.dispatchEvent(
      new CustomEvent(DEBUG_EXECUTION_EVENT, {
        detail: { path: null, line: null },
      }),
    );
    return () => {
      try {
        wsRef.current?.close();
      } catch {}
      wsRef.current = null;
    };
  }, [projectId]);

  useEffect(() => {
    if (projectId) saveBreakpoints(projectId, breakpoints);
  }, [projectId, breakpoints]);

  const sourceMismatch = useMemo(() => {
    if (!LIVE.has(state) || !pausedPath) return false;
    return dirtyPaths.includes(pausedPath);
  }, [state, pausedPath, dirtyPaths]);

  const send = useCallback((payload: unknown) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(payload));
  }, []);

  const handleMessage = useCallback((raw: string) => {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "status") {
      const next = msg.state as DebugSessionState;
      socketReadyRef.current = true;
      // Socket attach broadcasts idle. That means "ready to launch", not
      // "the session ended". Ignore it while the user has already started.
      if (next === "idle" && stateRef.current === "starting") {
        return;
      }
      setState(next);
      stateRef.current = next;
      setMessage(typeof msg.message === "string" ? msg.message : undefined);
      setLanguage(typeof msg.language === "string" ? msg.language : null);
      document.dispatchEvent(
        new CustomEvent(DEBUG_STATUS_EVENT, { detail: msg }),
      );
      if (LIVE.has(next)) {
        document.dispatchEvent(new Event(DEBUG_STARTED_EVENT));
      }
      if (
        next === "terminated" ||
        next === "failed" ||
        next === "unavailable"
      ) {
        setPausedPath(null);
        setPausedLine(null);
        document.dispatchEvent(
          new CustomEvent(DEBUG_EXECUTION_EVENT, {
            detail: { path: null, line: null },
          }),
        );
        document.dispatchEvent(new Event(DEBUG_STOPPED_EVENT));
      }
      return;
    }
    if (msg.type === "stopped") {
      const nextFrames: DebugFrame[] = Array.isArray(msg.frames)
        ? msg.frames
        : [];
      setFrames(nextFrames);
      setScopes(Array.isArray(msg.scopes) ? msg.scopes : []);
      setVariables(
        msg.variables && typeof msg.variables === "object" ? msg.variables : {},
      );
      setState("paused");
      const top = nextFrames[0];
      setPausedPath(top?.path ?? null);
      setPausedLine(top?.line ?? null);
      document.dispatchEvent(
        new CustomEvent(DEBUG_EXECUTION_EVENT, {
          detail: { path: top?.path ?? null, line: top?.line ?? null },
        }),
      );
      document.dispatchEvent(new Event(DEBUG_STARTED_EVENT));
      return;
    }
    if (msg.type === "continued") {
      setState("running");
      setPausedPath(null);
      setPausedLine(null);
      document.dispatchEvent(
        new CustomEvent(DEBUG_EXECUTION_EVENT, {
          detail: { path: null, line: null },
        }),
      );
      return;
    }
    if (msg.type === "stack") {
      setFrames(Array.isArray(msg.frames) ? msg.frames : []);
      return;
    }
    if (msg.type === "scopes") {
      setScopes(Array.isArray(msg.scopes) ? msg.scopes : []);
      return;
    }
    if (msg.type === "variables" && typeof msg.variablesReference === "number") {
      setVariables((prev) => ({
        ...prev,
        [msg.variablesReference]: Array.isArray(msg.variables)
          ? msg.variables
          : [],
      }));
      return;
    }
    if (msg.type === "breakpoints" && typeof msg.path === "string") {
      setVerified((prev) => ({ ...prev, [msg.path]: msg.breakpoints ?? [] }));
      emitBreakpoints(msg.path, [], msg.breakpoints);
      return;
    }
    if (msg.type === "output" && typeof msg.text === "string") {
      setOutput((prev) => {
        const next = [
          ...prev,
          { category: String(msg.category ?? "stdout"), text: msg.text },
        ];
        return next.length > 200 ? next.slice(next.length - 200) : next;
      });
      return;
    }
    if (msg.type === "exited") {
      setState("terminated");
      document.dispatchEvent(new Event(DEBUG_STOPPED_EVENT));
      return;
    }
    if (msg.type === "error" && typeof msg.message === "string") {
      setMessage(msg.message);
    }
  }, []);

  const ensureSocket = useCallback((): Promise<WebSocket> => {
    const id = projectRef.current;
    if (!id) return Promise.reject(new Error("no project"));
    const existing = wsRef.current;
    if (existing && existing.readyState === WebSocket.OPEN) {
      return Promise.resolve(existing);
    }
    if (existing && existing.readyState === WebSocket.CONNECTING) {
      return new Promise((resolve, reject) => {
        existing.addEventListener("open", () => resolve(existing), { once: true });
        existing.addEventListener("error", () => reject(new Error("ws")), {
          once: true,
        });
      });
    }
    const ws = new WebSocket(getWebSocketUrl("/ws/debug", id));
    wsRef.current = ws;
    socketReadyRef.current = false;
    ws.onmessage = (ev) => handleMessage(String(ev.data));
    ws.onclose = () => {
      if (wsRef.current === ws) wsRef.current = null;
      if (LIVE.has(stateRef.current)) {
        setState("terminated");
        document.dispatchEvent(new Event(DEBUG_STOPPED_EVENT));
      }
    };
    ws.onerror = () => {};
    return new Promise((resolve, reject) => {
      ws.addEventListener("open", () => resolve(ws), { once: true });
      ws.addEventListener("error", () => reject(new Error("debug socket failed")), {
        once: true,
      });
    });
  }, [handleMessage]);

  const start = useCallback(
    (entryFile: string) => {
      const lang = debugLanguageForPath(entryFile);
      if (!lang) {
        setState("unavailable");
        setMessage("this file type cannot be debugged");
        return;
      }
      setOutput([]);
      setFrames([]);
      setScopes([]);
      setVariables({});
      setState("starting");
      stateRef.current = "starting";
      void ensureSocket()
        .then(async (ws) => {
          const deadline = Date.now() + 30_000;
          while (!socketReadyRef.current && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 20));
          }
          if (stateRef.current === "unavailable") {
            throw new Error("debugger unavailable");
          }
          if (ws.readyState !== WebSocket.OPEN) {
            throw new Error("debug socket closed");
          }
          ws.send(
            JSON.stringify({
              type: "launch",
              language: lang,
              entryFile,
              breakpoints: bpRef.current,
            }),
          );
        })
        .catch((err) => {
          setState("unavailable");
          setMessage(err?.message ?? "debugger unavailable");
        });
    },
    [ensureSocket],
  );

  useEffect(() => {
    const onConfirmed = (e: Event) => {
      const file = (e as CustomEvent).detail?.activeFile as string | undefined;
      if (!file) return;
      start(file);
    };
    document.addEventListener("ide-debug-confirmed", onConfirmed);
    return () =>
      document.removeEventListener("ide-debug-confirmed", onConfirmed);
  }, [start]);

  const continueRun = useCallback(() => send({ type: "continue" }), [send]);
  const pause = useCallback(() => send({ type: "pause" }), [send]);
  const stepOver = useCallback(() => send({ type: "next" }), [send]);
  const stepIn = useCallback(() => send({ type: "stepIn" }), [send]);
  const stepOut = useCallback(() => send({ type: "stepOut" }), [send]);
  const stop = useCallback(() => {
    send({ type: "terminate" });
    setState("terminated");
    document.dispatchEvent(new Event(DEBUG_STOPPED_EVENT));
  }, [send]);

  const toggleBreakpoint = useCallback((path: string, line: number) => {
    setBreakpoints((prev) => {
      const next = toggleLine(prev, path, line);
      bpRef.current = next;
      const lines = next[path] ?? [];
      emitBreakpoints(path, lines, undefined);
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN && LIVE.has(stateRef.current)) {
        ws.send(JSON.stringify({ type: "setBreakpoints", path, lines }));
      }
      return next;
    });
  }, []);

  useEffect(() => {
    const onToggle = (e: Event) => {
      const d = (e as CustomEvent).detail as { path?: string; line?: number };
      if (!d?.path || typeof d.line !== "number") return;
      toggleBreakpoint(d.path, d.line);
    };
    document.addEventListener(DEBUG_TOGGLE_BP_EVENT, onToggle);
    return () => document.removeEventListener(DEBUG_TOGGLE_BP_EVENT, onToggle);
  }, [toggleBreakpoint]);

  const expandVariables = useCallback(
    (ref: number) => {
      send({ type: "variables", variablesReference: ref });
    },
    [send],
  );

  const selectFrame = useCallback(
    (frame: DebugFrame) => {
      setPausedPath(frame.path);
      setPausedLine(frame.line);
      send({ type: "scopes", frameId: frame.id });
      document.dispatchEvent(
        new CustomEvent(DEBUG_EXECUTION_EVENT, {
          detail: { path: frame.path, line: frame.line },
        }),
      );
      if (frame.path) {
        document.dispatchEvent(
          new CustomEvent("ide-open-and-reveal", {
            detail: { filePath: frame.path, line: frame.line, column: frame.column },
          }),
        );
      }
    },
    [send],
  );

  useEffect(() => {
    (globalThis as any).__VEYRA_DEBUG__ = {
      state,
      message,
      language,
      frames: frames.map((f) => ({ path: f.path, line: f.line, name: f.name })),
      output: output.slice(-12).map((o) => o.text).join(""),
    };
  }, [state, message, language, frames, output]);

  const value: DebugSessionValue = {
    state,
    message,
    language,
    frames,
    scopes,
    variables,
    output,
    breakpoints,
    verified,
    pausedPath,
    pausedLine,
    sourceMismatch,
    start,
    continueRun,
    pause,
    stepOver,
    stepIn,
    stepOut,
    stop,
    toggleBreakpoint,
    expandVariables,
    selectFrame,
  };

  return (
    <DebugSessionContext.Provider value={value}>
      {children}
    </DebugSessionContext.Provider>
  );
}

export function useDebugSession(): DebugSessionValue {
  const ctx = useContext(DebugSessionContext);
  if (!ctx) {
    throw new Error("useDebugSession requires DebugSessionProvider");
  }
  return ctx;
}

export function useOptionalDebugSession(): DebugSessionValue | null {
  return useContext(DebugSessionContext);
}
