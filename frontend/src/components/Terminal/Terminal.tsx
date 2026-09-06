import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal as XTerm, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { getWebSocketUrl } from '../../api';
import { IconTrash, IconRefresh } from '../common/Icons';

// M69 — the terminal palette per resolved appearance. Dark is the existing
// Catppuccin Mocha set; light is its Latte counterpart, matching the IDE
// chrome. Switching themes updates `term.options.theme` in place — the
// xterm instance and its WebSocket session are never recreated.
export const TERMINAL_THEMES: Record<'dark' | 'light', ITheme> = {
  dark: {
    background: '#090b10',
    foreground: '#cdd6f4',
    cursor: '#89b4fa',
    selectionBackground: 'rgba(137, 180, 250, 0.3)',
    black: '#45475a',
    red: '#f38ba8',
    green: '#a6e3a1',
    yellow: '#f9e2af',
    blue: '#89b4fa',
    magenta: '#f5c2e7',
    cyan: '#94e2d5',
    white: '#bac2de',
  },
  light: {
    background: '#eff1f5',
    foreground: '#4c4f69',
    cursor: '#1e66f5',
    selectionBackground: 'rgba(30, 102, 245, 0.25)',
    black: '#5c5f77',
    red: '#d20f39',
    green: '#40a02b',
    yellow: '#df8e1d',
    blue: '#1e66f5',
    magenta: '#ea76cb',
    cyan: '#179299',
    white: '#acb0be',
  },
};

export default function Terminal({
  project,
  resolvedTheme = 'dark',
}: {
  project: any;
  resolvedTheme?: 'dark' | 'light';
}) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const [connected, setConnected] = useState(false);
  // Ref so initTerminal (keyed on project only) reads the current theme
  // without a theme change re-running it and tearing down the session.
  const resolvedThemeRef = useRef(resolvedTheme);
  resolvedThemeRef.current = resolvedTheme;

  const initTerminal = useCallback(() => {
    if (cleanupRef.current) {
      cleanupRef.current();
      cleanupRef.current = null;
    }
    if (!terminalRef.current || !project) return;

    const term = new XTerm({
      theme: TERMINAL_THEMES[resolvedThemeRef.current],
      fontFamily: 'var(--font-mono)',
      fontSize: 13,
      lineHeight: 1.35,
      cursorBlink: true,
      cursorStyle: 'block',
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(terminalRef.current);
    fit.fit();
    xtermRef.current = term;

    const ws = new WebSocket(getWebSocketUrl('/ws/terminal', project.id));
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      term.writeln('\x1b[38;2;166;227;161m●\x1b[0m \x1b[1mCloudeeeIDE Docker Terminal Connected\x1b[0m\r\n');
    };

    ws.onclose = () => {
      setConnected(false);
      term.writeln('\r\n\x1b[38;2;243;139;168m●\x1b[0m \x1b[2m[Terminal Session Ended]\x1b[0m\r\n');
    };

    ws.onerror = () => {
      setConnected(false);
      term.writeln('\r\n\x1b[31m[Terminal Connection Error]\x1b[0m\r\n');
    };

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'data' && msg.data) {
          term.write(msg.data);
        }
      } catch {
        // ignore parse errors
      }
    };

    term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'data', data }));
      }
    });

    term.onResize(({ cols, rows }) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols, rows }));
      }
    });

    const resizeObserver = new ResizeObserver(() => {
      try { fit.fit(); } catch {}
    });
    resizeObserver.observe(terminalRef.current);

    const cleanup = () => {
      try { ws.close(); } catch {}
      try { term.dispose(); } catch {}
      resizeObserver.disconnect();
    };
    cleanupRef.current = cleanup;
    return cleanup;
  }, [project?.id]);

  useEffect(() => {
    initTerminal();
    return () => {
      if (cleanupRef.current) {
        cleanupRef.current();
        cleanupRef.current = null;
      }
    };
  }, [initTerminal]);

  // M69: apply the resolved appearance to the live terminal in place — the
  // xterm instance and its WebSocket session are untouched.
  useEffect(() => {
    if (xtermRef.current) {
      xtermRef.current.options.theme = TERMINAL_THEMES[resolvedTheme];
    }
  }, [resolvedTheme]);

  return (
    <div className="panel-content">
      {/* Terminal Toolbar */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '6px 12px',
        background: 'var(--glass-surface-2)',
        borderBottom: '1px solid var(--glass-border)',
        fontSize: 'var(--text-xs)'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span className={`glass-badge ${connected ? 'glass-badge-success' : 'glass-badge-error'}`}>
            <span className={`capability-dot ${connected ? 'ready' : 'error'}`} />
            <span>{connected ? 'bash (sandbox)' : 'Disconnected'}</span>
          </span>
          <span style={{ color: 'var(--fg-muted)', fontSize: '11px' }}>
            Docker container: /workspace
          </span>
        </div>

        <div style={{ display: 'flex', gap: '4px' }}>
          <button
            className="glass-btn glass-btn-icon"
            onClick={() => xtermRef.current?.clear()}
            title="Clear Terminal"
            aria-label="Clear Terminal"
          >
            <IconTrash size={12} />
          </button>
          <button
            className="glass-btn glass-btn-icon"
            onClick={initTerminal}
            title="Reconnect Terminal"
            aria-label="Reconnect Terminal"
          >
            <IconRefresh size={12} />
          </button>
        </div>
      </div>

      <div ref={terminalRef} className="terminal-container" />
    </div>
  );
}
