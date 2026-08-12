import React, { useEffect, useRef } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { getWebSocketUrl } from '../../api';

export default function Terminal({ project }: any) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!terminalRef.current || !project) return;
    
    const term = new XTerm({ theme: { background: '#1e1e2e' } });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(terminalRef.current);
    fit.fit();
    xtermRef.current = term;

    const ws = new WebSocket(getWebSocketUrl('/ws/terminal', project.id));
    wsRef.current = ws;

    ws.onopen = () => {
      term.writeln('\x1b[32m[Terminal Connected]\x1b[0m');
    };

    ws.onclose = () => {
      term.writeln('\r\n\x1b[31m[Terminal Disconnected]\x1b[0m');
    };

    ws.onerror = () => {
      term.writeln('\r\n\x1b[31m[Terminal Connection Error]\x1b[0m');
    };

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'data' && msg.data) {
          term.write(msg.data);
        }
      } catch (err) {}
    };

    term.onData(data => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'data', data }));
      }
    });

    term.onResize(({ cols, rows }) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols, rows }));
      }
    });

    const resizeObserver = new ResizeObserver(() => fit.fit());
    resizeObserver.observe(terminalRef.current);

    return () => {
      ws.close();
      term.dispose();
      resizeObserver.disconnect();
    };
  }, [project]);

  return <div ref={terminalRef} className="terminal-container" />;
}
