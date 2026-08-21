import React, { useState } from 'react';
import {
  IconRefresh,
  IconExternalLink,
  IconMonitor,
  IconTablet,
  IconSmartphone,
  IconClose,
} from '../common/Icons';

export default function Preview({ project }: any) {
  const [port, setPort] = useState('3000');
  const [activeUrl, setActiveUrl] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [viewport, setViewport] = useState<'desktop' | 'tablet' | 'mobile'>('desktop');

  const handleLoad = (targetPort = port) => {
    if (!targetPort || isNaN(Number(targetPort))) return;
    setIsLoading(true);
    const url = `/api/projects/${project.id}/proxy/${targetPort}/?_t=${Date.now()}`;
    setActiveUrl(url);
  };

  const handleStop = () => {
    setActiveUrl('');
    setIsLoading(false);
  };

  const quickPorts = ['3000', '8000', '5173', '8080'];

  return (
    <div className="panel-content" style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      {/* Browser Chrome Header */}
      <div className="preview-browser-chrome">
        <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
          <button
            className="glass-btn glass-btn-icon"
            onClick={() => handleLoad()}
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
              <span style={{ color: 'var(--fg-subtle)', marginLeft: 'auto', fontSize: '10px' }}>
                LIVE SANDBOX
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
                background: 'rgba(15, 18, 26, 0.85)',
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
                No Active Web Preview
              </h4>
              <p style={{ margin: 0, fontSize: 'var(--text-xs)', color: 'var(--fg-muted)', maxWidth: '320px' }}>
                Start a local web server in the terminal (e.g. Node, Vite, or Python http.server) and connect to its port.
              </p>
            </div>

            <div style={{ display: 'flex', gap: '6px', marginTop: '6px' }}>
              {quickPorts.map((p) => (
                <button
                  key={p}
                  className="glass-btn"
                  style={{ fontSize: '11px', padding: '3px 8px' }}
                  onClick={() => { setPort(p); handleLoad(p); }}
                >
                  Port {p}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
