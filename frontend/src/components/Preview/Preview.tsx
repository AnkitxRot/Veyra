import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../api';
import {
  IconRefresh,
  IconExternalLink,
  IconMonitor,
  IconTablet,
  IconSmartphone,
  IconClose,
} from '../common/Icons';

interface PreviewPortsResponse {
  ports: number[];
  sandbox: boolean;
}

const POLL_MS = 4000;

export default function Preview({ project }: any) {
  const [port, setPort] = useState('3000');
  const [activeUrl, setActiveUrl] = useState('');
  const [activePort, setActivePort] = useState<number | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [viewport, setViewport] = useState<'desktop' | 'tablet' | 'mobile'>('desktop');

  // Auto-detection state (server-side probe of ALLOWED_PREVIEW_PORTS only).
  const [detected, setDetected] = useState<number[]>([]);
  const [sandboxUp, setSandboxUp] = useState<boolean>(false);
  const [scanning, setScanning] = useState<boolean>(false);
  const [scanned, setScanned] = useState<boolean>(false);
  // consecutive polls the currently-loaded port has NOT been seen listening
  const missesRef = useRef(0);
  const activePortRef = useRef<number | null>(null);
  const [activePortStale, setActivePortStale] = useState(false);

  const projectId: string | undefined = project?.id;

  const handleLoad = (targetPort: string | number = port) => {
    const n = Number(targetPort);
    if (!targetPort || isNaN(n)) return;
    setIsLoading(true);
    setActivePort(n);
    activePortRef.current = n;
    setPort(String(n));
    missesRef.current = 0;
    setActivePortStale(false);
    setActiveUrl(`/api/projects/${projectId}/proxy/${n}/?_t=${Date.now()}`);
  };

  const handleStop = () => {
    setActiveUrl('');
    setActivePort(null);
    activePortRef.current = null;
    missesRef.current = 0;
    setActivePortStale(false);
    setIsLoading(false);
  };

  const scan = useCallback(async () => {
    if (!projectId) return;
    setScanning(true);
    try {
      const res = await api<PreviewPortsResponse>(
        `/api/projects/${projectId}/preview/ports`,
      );
      const ports = Array.isArray(res.ports)
        ? res.ports.filter((p) => typeof p === 'number')
        : [];
      setDetected(ports);
      setSandboxUp(!!res.sandbox);
      // Track whether the currently-open preview's port is still answering.
      const cur = activePortRef.current;
      if (cur == null || ports.includes(cur)) {
        missesRef.current = 0;
        setActivePortStale(false);
      } else {
        missesRef.current += 1;
        setActivePortStale(missesRef.current >= 2);
      }
    } catch {
      // Auth / network error — treat as "nothing detected", never crash.
      setDetected([]);
      setSandboxUp(false);
    } finally {
      setScanning(false);
      setScanned(true);
    }
  }, [projectId]);

  // Poll only while this panel is mounted (bottomTab === 'preview').
  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    const tick = () => {
      if (!cancelled) void scan();
    };
    tick();
    const id = window.setInterval(tick, POLL_MS);
    let runStartedTimer: number | undefined;
    const onRunStarted = () => {
      // a run just started — a dev server may be about to bind
      runStartedTimer = window.setTimeout(tick, 800);
    };
    document.addEventListener('run-started', onRunStarted);
    return () => {
      cancelled = true;
      window.clearInterval(id);
      if (runStartedTimer !== undefined) window.clearTimeout(runStartedTimer);
      document.removeEventListener('run-started', onRunStarted);
    };
  }, [projectId, scan]);

  const quickPorts = ['3000', '8000', '5173', '8080'];
  const offered =
    detected.length > 0
      ? detected.map(String)
      : quickPorts;

  return (
    <div className="panel-content" style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      {/* Browser Chrome Header */}
      <div className="preview-browser-chrome">
        <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
          <button
            className="glass-btn glass-btn-icon"
            onClick={() => handleLoad(activePort ?? port)}
            disabled={!activeUrl}
            title="Reload Preview"
            aria-label="Reload Preview"
          >
            <IconRefresh size={13} />
          </button>
          {activeUrl && (
            <button
              className="glass-btn glass-btn-icon"
              onClick={handleStop}
              title="Stop Preview"
              aria-label="Stop Preview"
            >
              <IconClose size={13} />
            </button>
          )}
        </div>

        {/* Address Bar */}
        <form
          onSubmit={(e) => { e.preventDefault(); handleLoad(); }}
          style={{ flex: 1, display: 'flex', gap: '6px' }}
        >
          <div className="preview-address-bar">
            <span style={{ color: 'var(--fg-muted)', userSelect: 'none' }}>proxy://port:</span>
            <input
              type="text"
              value={port}
              onChange={(e) => setPort(e.target.value)}
              placeholder="3000"
              aria-label="Preview server port"
              style={{
                background: 'transparent',
                border: 'none',
                color: 'var(--accent)',
                fontFamily: 'inherit',
                fontSize: 'inherit',
                fontWeight: 600,
                width: '60px',
                outline: 'none',
              }}
            />
            {activeUrl && (
              <span
                style={{
                  color: activePortStale ? '#fab387' : 'var(--fg-subtle)',
                  marginLeft: 'auto',
                  fontSize: '10px',
                }}
              >
                {activePortStale ? 'NOT RESPONDING' : 'LIVE SANDBOX'}
              </span>
            )}
          </div>
          <button type="submit" className="glass-btn glass-btn-primary" style={{ padding: '4px 10px', fontSize: '11px' }}>
            Go
          </button>
        </form>

        {/* Responsive Viewport Controls */}
        <div className="preview-viewport-controls">
          <button
            className={`glass-btn glass-btn-icon ${viewport === 'desktop' ? 'active' : ''}`}
            onClick={() => setViewport('desktop')}
            title="Desktop View (100%)"
            aria-label="Desktop View"
          >
            <IconMonitor size={14} />
          </button>
          <button
            className={`glass-btn glass-btn-icon ${viewport === 'tablet' ? 'active' : ''}`}
            onClick={() => setViewport('tablet')}
            title="Tablet View (768px)"
            aria-label="Tablet View"
          >
            <IconTablet size={14} />
          </button>
          <button
            className={`glass-btn glass-btn-icon ${viewport === 'mobile' ? 'active' : ''}`}
            onClick={() => setViewport('mobile')}
            title="Mobile View (375px)"
            aria-label="Mobile View"
          >
            <IconSmartphone size={14} />
          </button>
        </div>

        {/* Open in New Window */}
        {activeUrl && (
          <a
            href={activeUrl}
            target="_blank"
            rel="noreferrer"
            className="glass-btn glass-btn-icon"
            title="Open in New Tab"
            aria-label="Open in New Tab"
          >
            <IconExternalLink size={13} />
          </a>
        )}
      </div>

      {/* Detected-server bar — shown whenever a preview is open so the user can
          see a newly-started server and switch to it. */}
      {activeUrl && detected.length > 0 && (
        <div
          role="status"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            padding: '4px 10px',
            fontSize: '11px',
            color: 'var(--fg-muted)',
            borderBottom: '1px solid var(--glass-border-subtle)',
            flexWrap: 'wrap',
          }}
        >
          <span>Detected:</span>
          {detected.map((p) => (
            <button
              key={p}
              className={`glass-btn ${activePort === p ? 'active' : ''}`}
              style={{ fontSize: '10px', padding: '2px 7px' }}
              onClick={() => handleLoad(p)}
              title={`Open the preview server on port ${p}`}
            >
              :{p}
            </button>
          ))}
          <button
            className="glass-btn glass-btn-ghost"
            style={{ fontSize: '10px', padding: '2px 7px', marginLeft: 'auto' }}
            onClick={() => void scan()}
            disabled={scanning}
          >
            {scanning ? 'Scanning…' : 'Rescan'}
          </button>
        </div>
      )}

      {/* Preview Stage Area */}
      <div className="preview-stage">
        {activeUrl ? (
          <div className={`preview-frame-wrapper ${viewport}`}>
            {isLoading && (
              <div style={{
                position: 'absolute',
                inset: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: 'var(--surface-recessed)',
                color: 'var(--fg-primary)',
                zIndex: 10,
                backdropFilter: 'blur(4px)',
                fontSize: 'var(--text-sm)',
                gap: '8px'
              }}>
                <span style={{
                  width: '16px',
                  height: '16px',
                  border: '2px solid var(--border)',
                  borderTopColor: 'var(--accent)',
                  borderRadius: '50%',
                  animation: 'spin 1s linear infinite'
                }} />
                <span>Loading sandbox web preview...</span>
              </div>
            )}
            <iframe
              src={activeUrl}
              onLoad={() => setIsLoading(false)}
              sandbox="allow-scripts allow-forms allow-popups allow-modals"
              style={{ width: '100%', height: '100%', border: 'none' }}
              title="Sandbox Web Preview"
            />
          </div>
        ) : (
          <div className="preview-empty-stage">
            <div className="empty-state-icon" style={{ width: '42px', height: '42px' }}>
              <IconMonitor size={22} />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <h4 style={{ margin: 0, fontSize: 'var(--text-md)', fontWeight: 600, color: 'var(--fg-primary)' }}>
                {detected.length === 1
                  ? `Detected server on :${detected[0]}`
                  : detected.length > 1
                    ? `${detected.length} servers detected`
                    : scanned && sandboxUp
                      ? 'No running preview server detected'
                      : scanned && !sandboxUp
                        ? 'No sandbox running yet'
                        : 'No Active Web Preview'}
              </h4>
              <p style={{ margin: 0, fontSize: 'var(--text-xs)', color: 'var(--fg-muted)', maxWidth: '340px' }}>
                {detected.length > 0
                  ? 'Open it below, or enter a different allowed port manually.'
                  : sandboxUp
                    ? 'Start a web server in the Terminal (e.g. npm run dev, vite, or python3 -m http.server) — it will be detected automatically.'
                    : 'Run your project (or open a Terminal) to start its sandbox, then start a web server on an allowed port.'}
              </p>
            </div>

            <div style={{ display: 'flex', gap: '6px', marginTop: '6px', flexWrap: 'wrap', justifyContent: 'center' }}>
              {offered.map((p) => (
                <button
                  key={p}
                  className="glass-btn"
                  style={{
                    fontSize: '11px',
                    padding: '3px 8px',
                    ...(detected.includes(Number(p))
                      ? { borderColor: 'var(--accent)', color: 'var(--accent)' }
                      : {}),
                  }}
                  onClick={() => handleLoad(p)}
                  title={
                    detected.includes(Number(p))
                      ? `Open the detected server on port ${p}`
                      : `Try port ${p}`
                  }
                >
                  {detected.includes(Number(p)) ? `Open :${p}` : `Port ${p}`}
                </button>
              ))}
            </div>

            <button
              className="glass-btn glass-btn-ghost"
              style={{ fontSize: '11px', padding: '3px 10px', marginTop: '2px' }}
              onClick={() => void scan()}
              disabled={scanning}
            >
              {scanning ? 'Scanning…' : 'Rescan'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
