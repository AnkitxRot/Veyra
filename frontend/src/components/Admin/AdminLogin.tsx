import React, { useState } from 'react';
import { api } from '../../api';
import { User } from '../../types';
import { IconShield } from '../common/Icons';

export default function AdminLogin({
  onAuthed,
  onSwitchToUserLogin,
}: {
  onAuthed: (user: User) => void;
  onSwitchToUserLogin: () => void;
}) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password.trim()) {
      setError('Please provide administrative username and password.');
      return;
    }
    setError(null);
    setLoading(true);

    try {
      const res = await api<{ token: string; user: User }>('/api/auth/admin-login', {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      });
      onAuthed(res.user);
    } catch (err: any) {
      setError(err.message || 'Authentication failed. Administrative privileges required.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-wrap">
      <div className="auth-card" style={{ maxWidth: '420px', border: '1px solid rgba(243, 139, 168, 0.3)' }}>
        <div className="auth-header" style={{ textAlign: 'center', marginBottom: '20px' }}>
          <div
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: '48px',
              height: '48px',
              borderRadius: '14px',
              background: 'rgba(243, 139, 168, 0.15)',
              color: '#f38ba8',
              marginBottom: '12px',
              border: '1px solid rgba(243, 139, 168, 0.3)',
            }}
          >
            <IconShield size={24} />
          </div>
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '6px' }}>
            <span className="glass-badge" style={{ background: 'rgba(243, 139, 168, 0.2)', color: '#f38ba8', fontSize: '11px', letterSpacing: '0.05em' }}>
              OPERATOR CONTROL PLANE
            </span>
          </div>
          <h1 style={{ fontSize: '20px', fontWeight: 600, color: 'var(--fg-primary)', margin: '4px 0' }}>
            Administrative Gateway
          </h1>
          <p style={{ fontSize: '12px', color: 'var(--fg-muted)', margin: 0 }}>
            Restricted access for cloud infrastructure orchestration & platform governance.
          </p>
        </div>

        {error && (
          <div className="glass-banner glass-banner-error" role="alert" style={{ marginBottom: '16px', fontSize: '12px', padding: '10px 14px' }}>
            <span>{error}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <div className="glass-form-group">
            <label className="glass-label" htmlFor="admin-username" style={{ fontSize: '12px', fontWeight: 500 }}>
              Admin Identifier
            </label>
            <input
              id="admin-username"
              type="text"
              className="glass-input"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="e.g. admin"
              autoComplete="username"
              required
              autoFocus
              style={{ padding: '10px 12px', fontSize: '13px' }}
            />
          </div>

          <div className="glass-form-group">
            <label className="glass-label" htmlFor="admin-password" style={{ fontSize: '12px', fontWeight: 500 }}>
              Master Security Key / Password
            </label>
            <input
              id="admin-password"
              type="password"
              className="glass-input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••••••"
              autoComplete="current-password"
              required
              style={{ padding: '10px 12px', fontSize: '13px' }}
            />
          </div>

          <button
            type="submit"
            className="glass-btn glass-btn-primary"
            disabled={loading}
            style={{
              padding: '11px',
              fontSize: '13px',
              fontWeight: 600,
              justifyContent: 'center',
              background: 'linear-gradient(135deg, rgba(243, 139, 168, 0.4), rgba(203, 166, 247, 0.3))',
              border: '1px solid rgba(243, 139, 168, 0.4)',
              marginTop: '6px',
            }}
          >
            {loading ? 'Authenticating...' : 'Access Control Plane'}
          </button>
        </form>

        <div style={{ marginTop: '20px', paddingTop: '16px', borderTop: '1px solid var(--glass-border-subtle)', textAlign: 'center' }}>
          <button
            type="button"
            className="glass-btn glass-btn-ghost"
            onClick={onSwitchToUserLogin}
            style={{ fontSize: '12px', color: 'var(--fg-muted)', margin: 'auto' }}
          >
            ← Return to Developer IDE Login
          </button>
        </div>
      </div>
    </div>
  );
}
