import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { getWebSocketUrl } from "../api";
import { TERMINAL_THEMES } from "../components/Terminal/terminalThemes";
import {
  TERMINAL_STATES,
  TERMINAL_ENDED_REASONS,
  RECONNECT_BASE_MS,
  RECONNECT_FACTOR,
  RECONNECT_MAX_MS,
  RECONNECT_MAX_ATTEMPTS,
  newTerminalId,
  type TerminalConnectionState,
  type TerminalEndedReason,
  type TerminalSession,
} from "./terminalSessionState";

/**
 * M79 — project-lifetime terminal session.
 *
 * Owns exactly one XTerm, one terminalId, one WebSocket, one reconnect timer,
 * and the last-received output sequence number for the lifetime of a project's
 * terminal session. The XTerm is created once (on first `ensureStarted`) and is
 * NEVER disposed on a socket reconnect or a panel visibility change — only on a
 * project change, an explicit new-session action, or hook teardown.
 *
 * A dropped socket triggers a bounded exponential-backoff reconnect that
 * reattaches to the same backend PTY (via `terminalId` + `lastSeq`); the server
 * replays only the output produced while detached. When the PTY is genuinely
 * gone the server sends `{type:"ended"}` and the reconnect loop stops — a fresh
 * shell then requires an explicit `retry()`.
 */
export function useTerminalSession(
  projectId: string,
  resolvedTheme: "dark" | "light",
): TerminalSession {
  const [state, setStateRaw] = useState<TerminalConnectionState>(
    TERMINAL_STATES.connecting,
  );
  const [endedReason, setEndedReason] = useState<TerminalEndedReason | null>(
    null,
  );

  const xtermRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const containerRef = useRef<HTMLElement | null>(null);
  const resizeObsRef = useRef<ResizeObserver | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const terminalIdRef = useRef<string>(newTerminalId());
  const lastSeqRef = useRef<number>(0);
  const attemptRef = useRef<number>(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startedRef = useRef(false);
  const disposedRef = useRef(false);
  const stateRef = useRef<TerminalConnectionState>(TERMINAL_STATES.connecting);
  const themeRef = useRef(resolvedTheme);
  themeRef.current = resolvedTheme;

  // Internal machinery held in refs so the connect <-> reconnect cycle never
  // needs a dependency edge and `ws` handlers always call the current impl.
  const connectRef = useRef<() => void>(() => {});
  const scheduleReconnectRef = useRef<() => void>(() => {});

  const setConnState = (s: TerminalConnectionState) => {
    stateRef.current = s;
    setStateRaw(s);
  };

  const clearReconnectTimer = () => {
    if (reconnectTimerRef.current !== null) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  };

  const detachWs = () => {
    const ws = wsRef.current;
    if (ws) {
      ws.onopen = null;
      ws.onclose = null;
      ws.onerror = null;
      ws.onmessage = null;
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
    wsRef.current = null;
  };

  const ensureXterm = (): XTerm => {
    if (xtermRef.current) return xtermRef.current;
    const term = new XTerm({
      theme: TERMINAL_THEMES[themeRef.current],
      fontFamily: "var(--font-mono)",
      fontSize: 13,
      lineHeight: 1.35,
      cursorBlink: true,
      cursorStyle: "block",
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    xtermRef.current = term;
    fitRef.current = fit;
    if (containerRef.current) {
      term.open(containerRef.current);
      try {
        fit.fit();
      } catch {
        /* pre-layout */
      }
    }
    term.onData((data) => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "data", data }));
      }
    });
    term.onResize(({ cols, rows }) => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "resize", cols, rows }));
      }
    });
    return term;
  };

  const endSession = (reason: string) => {
    clearReconnectTimer();
    detachWs();
    const r = (TERMINAL_ENDED_REASONS as string[]).includes(reason)
      ? (reason as TerminalEndedReason)
      : "unknown";
    setEndedReason(r);
    setConnState(TERMINAL_STATES.ended);
    try {
      xtermRef.current?.writeln(
        `\r\n\x1b[2m[terminal session ended — ${r}. start a new terminal to continue]\x1b[0m`,
      );
    } catch {
      /* ignore */
    }
  };

  const connect = () => {
    if (disposedRef.current) return;
    const term = ensureXterm();
    clearReconnectTimer();
    detachWs();

    setConnState(
      attemptRef.current > 0
        ? TERMINAL_STATES.reconnecting
        : TERMINAL_STATES.connecting,
    );

    const url = getWebSocketUrl("/ws/terminal", projectId, {
      terminalId: terminalIdRef.current,
      lastSeq: lastSeqRef.current,
    });
    const ws = new WebSocket(url);
    try {
      ws.binaryType = "arraybuffer";
    } catch {
      /* jsdom fake */
    }
    wsRef.current = ws;

    ws.onopen = () => {
      if (wsRef.current !== ws || disposedRef.current) {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        return;
      }
      attemptRef.current = 0;
      setConnState(TERMINAL_STATES.connected);
    };

    ws.onmessage = (e: MessageEvent) => {
      if (wsRef.current !== ws) return;
      let msg: {
        type?: string;
        data?: unknown;
        seq?: unknown;
        reason?: unknown;
      };
      try {
        const raw =
          typeof e.data === "string"
            ? e.data
            : new TextDecoder().decode(e.data as ArrayBuffer);
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      if (msg.type === "data" && typeof msg.data === "string") {
        if (typeof msg.seq === "number") lastSeqRef.current = msg.seq;
        term.write(msg.data);
      } else if (msg.type === "ended") {
        endSession(typeof msg.reason === "string" ? msg.reason : "unknown");
      }
    };

    ws.onerror = () => {
      // `onclose` always follows a real error; handle teardown there once.
    };

    ws.onclose = () => {
      if (wsRef.current !== ws || disposedRef.current) return;
      if (stateRef.current === TERMINAL_STATES.ended) return;
      scheduleReconnectRef.current();
    };
  };
  connectRef.current = connect;

  const scheduleReconnect = () => {
    if (disposedRef.current) return;
    clearReconnectTimer();
    if (attemptRef.current >= RECONNECT_MAX_ATTEMPTS) {
      setConnState(TERMINAL_STATES.reconnect_exhausted);
      return;
    }
    const n = attemptRef.current;
    attemptRef.current = n + 1;
    setConnState(TERMINAL_STATES.reconnecting);
    const delay = Math.min(
      RECONNECT_MAX_MS,
      Math.round(RECONNECT_BASE_MS * Math.pow(RECONNECT_FACTOR, n)),
    );
    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null;
      connectRef.current();
    }, delay);
  };
  scheduleReconnectRef.current = scheduleReconnect;

  // ---- public surface (stable identities) --------------------------------

  const bindContainer = useCallback((el: HTMLElement | null) => {
    containerRef.current = el;
    resizeObsRef.current?.disconnect();
    resizeObsRef.current = null;
    const term = xtermRef.current;
    if (el && term) {
      if (!(term as unknown as { element?: HTMLElement }).element) {
        term.open(el);
      }
      try {
        fitRef.current?.fit();
      } catch {
        /* pre-layout */
      }
      if (typeof ResizeObserver !== "undefined") {
        const obs = new ResizeObserver(() => {
          try {
            fitRef.current?.fit();
          } catch {
            /* ignore */
          }
        });
        obs.observe(el);
        resizeObsRef.current = obs;
      }
    }
  }, []);

  const ensureStarted = useCallback(() => {
    if (startedRef.current || disposedRef.current) return;
    startedRef.current = true;
    attemptRef.current = 0;
    lastSeqRef.current = 0;
    connectRef.current();
  }, []);

  const clear = useCallback(() => {
    xtermRef.current?.clear();
  }, []);

  const fit = useCallback(() => {
    try {
      fitRef.current?.fit();
    } catch {
      /* ignore */
    }
  }, []);

  const retry = useCallback(() => {
    if (disposedRef.current) return;
    // From `ended` this is an explicit new-shell request: the old backend
    // session is gone, so a brand-new terminalId + zeroed sequence is correct.
    if (stateRef.current === TERMINAL_STATES.ended) {
      terminalIdRef.current = newTerminalId();
      lastSeqRef.current = 0;
      setEndedReason(null);
    }
    attemptRef.current = 0;
    connectRef.current();
  }, []);

  // ---- lifecycle: project change is a hard session boundary --------------

  useEffect(() => {
    disposedRef.current = false;
    startedRef.current = false;
    terminalIdRef.current = newTerminalId();
    lastSeqRef.current = 0;
    attemptRef.current = 0;
    setEndedReason(null);
    setConnState(TERMINAL_STATES.connecting);

    return () => {
      disposedRef.current = true;
      clearReconnectTimer();
      detachWs();
      resizeObsRef.current?.disconnect();
      resizeObsRef.current = null;
      try {
        xtermRef.current?.dispose();
      } catch {
        /* ignore */
      }
      xtermRef.current = null;
      fitRef.current = null;
      containerRef.current = null;
    };
  }, [projectId]);

  // ---- M69: in-place theme, never a reconnect / new XTerm ---------------

  useEffect(() => {
    if (xtermRef.current) {
      xtermRef.current.options.theme = TERMINAL_THEMES[resolvedTheme];
    }
  }, [resolvedTheme]);

  return useMemo<TerminalSession>(
    () => ({
      state,
      endedReason,
      bindContainer,
      ensureStarted,
      clear,
      retry,
      fit,
    }),
    [state, endedReason, bindContainer, ensureStarted, clear, retry, fit],
  );
}
