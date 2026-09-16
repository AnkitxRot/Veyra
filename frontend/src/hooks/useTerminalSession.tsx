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
import {
  clearTerminalResume,
  isPersistableTerminalUser,
  readTerminalResume,
  writeTerminalResume,
} from "../utils/terminalResume";

/**
 * M79 — project-lifetime terminal session.
 * M88 — same-tab remount (reload / switch-back) reuses the stored terminalId
 * so `/ws/terminal` reattaches inside the M79 grace window instead of minting
 * a second PTY.  `resume=1` tells the server not to silently spawn if the
 * session was already reaped.
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
  userId?: number,
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
  const mountFramesLeftRef = useRef(0);
  const wsRef = useRef<WebSocket | null>(null);
  // Start with a fresh id; the project-change useEffect overrides this with a
  // stored resume id (if any) on remount.  This way the very first connect
  // (before the effect runs) still has a valid terminalId.
  const terminalIdRef = useRef<string>(newTerminalId());
  const lastSeqRef = useRef<number>(0);
  /** Restored from sessionStorage: first connect of this mount must not spawn
   *  a silent replacement PTY if the session was already reaped. */
  const resumeRef = useRef(false);
  const persistedRef = useRef(false);
  const userIdRef = useRef(userId);
  userIdRef.current = userId;
  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;
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
  const mountRef = useRef<() => void>(() => {});
  const observeRef = useRef<(el: HTMLElement) => void>(() => {});

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

  const hostHasBox = (el: HTMLElement | null): el is HTMLElement =>
    !!el && el.clientHeight >= 24 && el.clientWidth >= 24;

  const safeFit = () => {
    if (!hostHasBox(containerRef.current)) return;
    try {
      fitRef.current?.fit();
    } catch {
      /* ignore */
    }
  };

  /**
   * Open the XTerm into its host — but only once the host actually has a box.
   * `<Terminal>` is mounted for the project lifetime and only display-toggled,
   * so `ensureXterm` can run while the panel is still `display:none`; opening
   * against a zero-size element leaves the renderer broken. Any write that
   * lands before this is buffered by xterm and flushed on open. Idempotent.
   *
   * The host gains its box a frame or two after `visible` flips (and a
   * `display:none → flex` ancestor change does NOT reliably fire this
   * element's ResizeObserver in Chrome), so while the XTerm exists but the
   * host is still 0×0 we re-poll on `requestAnimationFrame` for a bounded
   * number of frames — reset each time the panel is (re)shown.
   */
  const mountXtermIfReady = () => {
    if (disposedRef.current) return;
    const term = xtermRef.current;
    if (!term) return;
    const opened = !!(term as unknown as { element?: HTMLElement }).element;
    if (opened) {
      safeFit();
      return;
    }
    if (!hostHasBox(containerRef.current)) {
      if (mountFramesLeftRef.current > 0) {
        mountFramesLeftRef.current -= 1;
        requestAnimationFrame(mountXtermIfReady);
      }
      return;
    }
    term.open(containerRef.current);
    safeFit();
  };

  /** (Re)arm the bounded frame budget and kick a mount attempt — called when
   *  the panel is (re)shown or the host element (re)binds. ~2s at 60fps. */
  const scheduleMount = () => {
    mountFramesLeftRef.current = 120;
    requestAnimationFrame(mountXtermIfReady);
  };
  mountRef.current = scheduleMount;

  /** The single mechanism that recovers a correct size after the panel
   *  un-hides / the drawer re-expands: watch the host box, and whenever it
   *  gains room, (open and) re-fit the XTerm. Attached in `bindContainer`
   *  as soon as the host element exists — independent of the XTerm. */
  const observeContainer = (el: HTMLElement) => {
    resizeObsRef.current?.disconnect();
    resizeObsRef.current = null;
    if (typeof ResizeObserver === "undefined") return;
    const obs = new ResizeObserver(() => scheduleMount());
    obs.observe(el);
    resizeObsRef.current = obs;
  };
  observeRef.current = observeContainer;

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
    // Poll (bounded) for the host to gain a box, then open into it.
    scheduleMount();
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
    resumeRef.current = false;
    persistedRef.current = false;
    forgetStoredId();
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
      ...(resumeRef.current ? { resume: 1 } : {}),
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
        // Defense in depth against a double replay: the server already only
        // resends `seq > lastSeq`, but never write a frame we've applied.
        if (
          typeof msg.seq === "number" &&
          msg.seq <= lastSeqRef.current
        ) {
          return;
        }
        if (typeof msg.seq === "number") lastSeqRef.current = msg.seq;
        // Persist the terminalId after the first data frame — proof the backend
        // session exists, so a later reload can reattach instead of re-spawning.
        if (!persistedRef.current) {
          const uid = userIdRef.current;
          const pid = projectIdRef.current;
          if (isPersistableTerminalUser(uid) && pid) {
            writeTerminalResume(uid, pid, terminalIdRef.current);
          }
          persistedRef.current = true;
        }
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
    if (!el) {
      resizeObsRef.current?.disconnect();
      resizeObsRef.current = null;
      return;
    }
    // Watch the host from now on — the ResizeObserver kicks a mount attempt
    // when it gains a box (panel shown / drawer expanded).
    observeRef.current(el);
    mountRef.current();
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
    // Re-arm the bounded mount/fit poll — opens the XTerm into its host once
    // it has a box (panel just shown), or just re-fits if already open.
    mountRef.current();
  }, []);

  const persistChosenId = (terminalId: string) => {
    const uid = userIdRef.current;
    const pid = projectIdRef.current;
    if (!isPersistableTerminalUser(uid) || !pid) return;
    writeTerminalResume(uid, pid, terminalId);
  };

  const forgetStoredId = () => {
    const uid = userIdRef.current;
    const pid = projectIdRef.current;
    if (!isPersistableTerminalUser(uid) || !pid) return;
    clearTerminalResume(uid, pid);
  };

  const retry = useCallback(() => {
    if (disposedRef.current) return;
    // From `ended` this is an explicit new-shell request: the old backend
    // session is gone, so a brand-new terminalId + zeroed sequence is correct.
    // Clear the stored id so a future reload doesn't try to reattach to a
    // session that no longer exists.
    if (stateRef.current === TERMINAL_STATES.ended) {
      terminalIdRef.current = newTerminalId();
      lastSeqRef.current = 0;
      resumeRef.current = false;
      persistedRef.current = false;
      forgetStoredId();
      setEndedReason(null);
    }
    attemptRef.current = 0;
    connectRef.current();
  }, []);

  // ---- lifecycle: project (and user) change is a hard socket boundary ----
  // The backend PTY may still be in the M79 grace window.  Restoring the
  // stored terminalId + resume=1 reattaches; minting a new id would spawn a
  // second shell and let the first one expire.

  useEffect(() => {
    disposedRef.current = false;
    startedRef.current = false;
    lastSeqRef.current = 0;
    attemptRef.current = 0;
    // Restore a stored terminalId from sessionStorage if one exists for this
    // (userId, projectId) — enables reattach after same-tab reload.  Otherwise
    // mint a fresh id for a new session.
    const restored =
      isPersistableTerminalUser(userId) && projectId
        ? readTerminalResume(userId, projectId)
        : null;
    if (restored) {
      terminalIdRef.current = restored;
      resumeRef.current = true;
      persistedRef.current = true;
    } else {
      terminalIdRef.current = newTerminalId();
      resumeRef.current = false;
      persistedRef.current = false;
    }
    setEndedReason(null);
    setConnState(TERMINAL_STATES.connecting);

    return () => {
      disposedRef.current = true;
      mountFramesLeftRef.current = 0;
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
  }, [projectId, userId]);

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
