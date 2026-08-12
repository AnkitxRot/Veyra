import React, { useState } from 'react';
// getToken is available for future use but not needed for iframe proxy (uses cookies)

export default function Preview({ project }: any) {
  const [port, setPort] = useState('3000');
  const [activeUrl, setActiveUrl] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const handleLoad = (e: React.FormEvent) => {
    e.preventDefault();
    if (!port || isNaN(Number(port))) return;
    setIsLoading(true);
    setActiveUrl(`/api/projects/${project.id}/proxy/${port}/?_t=${Date.now()}`);
  };

  return (
    <div className="panel-content" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <form onSubmit={handleLoad} style={{ display: 'flex', padding: '8px', gap: '8px', borderBottom: '1px solid var(--border)' }}>
        <input 
          type="text" 
          value={port} 
          onChange={(e) => setPort(e.target.value)} 
          placeholder="Port (e.g., 3000)" 
          style={{ padding: '4px 8px', background: 'var(--panel-2)', color: 'var(--fg)', border: '1px solid var(--border)', borderRadius: '4px', width: '120px' }}
        />
        <button type="submit" style={{ padding: '4px 12px', background: 'var(--accent)', color: '#111', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>
          Load Preview
        </button>
        <button type="button" onClick={() => { setActiveUrl(''); setIsLoading(false); }} style={{ padding: '4px 12px', background: 'var(--panel-2)', color: 'var(--fg)', border: '1px solid var(--border)', borderRadius: '4px', cursor: 'pointer' }}>
          Stop
        </button>
      </form>
      <div style={{ flex: 1, position: 'relative', background: '#fff' }}>
        {activeUrl ? (
          <>
            {isLoading && (
              <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(255, 255, 255, 0.8)', color: '#000', zIndex: 10 }}>
                Loading preview...
              </div>
            )}
            <iframe 
              src={activeUrl} 
              onLoad={() => setIsLoading(false)}
              style={{ width: '100%', height: '100%', border: 'none' }}
              title="Preview"
            />
          </>
        ) : (
          <div style={{ padding: '12px', color: '#000', textAlign: 'center', marginTop: '20px' }}>
            Enter the port your application is running on and click Load Preview.
          </div>
        )}
      </div>
    </div>
  );
}
