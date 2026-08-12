import React, { useEffect, useRef, useState } from 'react';
import { getWebSocketUrl } from '../../api';

type LogLine = { type: 'stdout' | 'stderr' | 'system' | 'error'; text: string };

export default function Output({ project }: any) {
  const [logs, setLogs] = useState<LogLine[]>([]);
  const wsRef = useRef<WebSocket | null>(null);
  const logsEndRef = useRef<HTMLDivElement>(null);
  const [input, setInput] = useState('');
  const [isRunning, setIsRunning] = useState(false);

  const scrollToBottom = () => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [logs]);

  useEffect(() => {
    const handleRun = (e: Event) => {
      const { language, activeFile, langDisplay } = (e as CustomEvent).detail;
      if (!project) return;
      
      setLogs([{ type: 'system', text: `Starting execution (${activeFile ? `${activeFile} → ` : ''}${langDisplay || language})...` }]);
      setIsRunning(true);
      document.dispatchEvent(new Event('run-started'));

      if (wsRef.current && wsRef.current.readyState !== WebSocket.CLOSED) {
        wsRef.current.onclose = null;
        wsRef.current.onerror = null;
        wsRef.current.onmessage = null;
        wsRef.current.close();
      }

      const ws = new WebSocket(getWebSocketUrl('/ws/execute', project.id));
      wsRef.current = ws;
      let exitedNormally = false;

      ws.onopen = () => {
        ws.send(JSON.stringify({ type: 'start', language, activeFile }));
      };

      ws.onmessage = (msg) => {
        try {
          const parsed = JSON.parse(msg.data);
          
          const appendLog = (logLine: LogLine) => {
            setLogs(prev => {
              const next = [...prev, logLine];
              return next.length > 2000 ? next.slice(next.length - 2000) : next;
            });
          };

          if (parsed.type === 'stdout') {
            appendLog({ type: 'stdout', text: parsed.data });
          } else if (parsed.type === 'stderr') {
            appendLog({ type: 'stderr', text: parsed.data });
          } else if (parsed.type === 'status') {
            appendLog({ type: 'system', text: parsed.data });
          } else if (parsed.type === 'error') {
            appendLog({ type: 'error', text: parsed.data });
          } else if (parsed.type === 'exit') {
            exitedNormally = true;
            const { exitCode, signal, timedOut, oom } = parsed.result;
            let status = `Process exited with code ${exitCode}`;
            if (signal) status += ` (signal: ${signal})`;
            if (timedOut) status = 'Process timed out';
            if (oom) status = 'Process ran out of memory (OOM)';
            appendLog({ type: 'system', text: status });
            
            setIsRunning(false);
            document.dispatchEvent(new Event('run-stopped'));
          }
        } catch (err) {
          // Ignore parse errors
        }
      };

      ws.onclose = () => {
        if (!exitedNormally) {
          setLogs(prev => [...prev, { type: 'system', text: 'Connection closed' }]);
        }
        setIsRunning(false);
        document.dispatchEvent(new Event('run-stopped'));
      };
      
      ws.onerror = () => {
        setLogs(prev => [...prev, { type: 'error', text: 'WebSocket error occurred' }]);
        setIsRunning(false);
        document.dispatchEvent(new Event('run-stopped'));
      };
    };

    const handleStop = () => {
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'stop' }));
        setLogs(prev => [...prev, { type: 'system', text: 'Stopping process...' }]);
      }
    };

    document.addEventListener('ide-run-confirmed', handleRun);
    document.addEventListener('ide-stop', handleStop);

    return () => {
      document.removeEventListener('ide-run-confirmed', handleRun);
      document.removeEventListener('ide-stop', handleStop);
      if (wsRef.current && wsRef.current.readyState !== WebSocket.CLOSED) {
        wsRef.current.onclose = null;
        wsRef.current.onerror = null;
        wsRef.current.onmessage = null;
        wsRef.current.close();
      }
    };
  }, [project]);

  const handleInputSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'stdin', data: input + '\n' }));
      setLogs(prev => [...prev, { type: 'stdout', text: input + '\n' }]);
      setInput('');
    }
  };

  return (
    <div className="panel-content" style={{ display: 'flex', flexDirection: 'column' }}>
      <div className="output-log" style={{ flex: 1, overflowY: 'auto', whiteSpace: 'pre-wrap', paddingBottom: '12px' }}>
        {logs.length === 0 && <span className="muted">Output will appear here</span>}
        {logs.map((log, i) => (
          <span key={i} style={{ 
            color: log.type === 'stderr' ? 'var(--error)' : 
                   log.type === 'system' ? 'var(--accent)' : 
                   log.type === 'error' ? 'var(--error)' : 'inherit',
            display: 'inline-block', width: '100%' 
          }}>
            {log.text}
          </span>
        ))}
        <div ref={logsEndRef} />
      </div>
      {isRunning && (
        <form onSubmit={handleInputSubmit} style={{ display: 'flex', marginTop: '8px', borderTop: '1px solid var(--border)', paddingTop: '8px' }}>
          <span style={{ padding: '0 8px', display: 'flex', alignItems: 'center', color: 'var(--muted)' }}>&gt;</span>
          <input 
            value={input} 
            onChange={(e) => setInput(e.target.value)} 
            style={{ flex: 1, background: 'transparent', border: 'none', color: 'var(--fg)', outline: 'none' }} 
            placeholder="Type input and press Enter..." 
          />
        </form>
      )}
    </div>
  );
}
