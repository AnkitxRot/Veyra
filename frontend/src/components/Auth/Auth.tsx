import React, { useState } from 'react';
import { api } from '../../api';
import { User } from '../../types';
import { IconLayers, IconSparkles } from '../common/Icons';

export default function Auth({
  onAuthed,
  onSwitchToAdminLogin,
}: {
  onAuthed: (u: User) => void;
  onSwitchToAdminLogin?: () => void;
}) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [demoBusy, setDemoBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password) return;
    if (mode === 'register' && password.length < 8) {
      setError('Password must be at least 8 characters long');
      return;
    }

    setBusy(true);
    setError('');
    try {
      const res = await api<{ token?: string; user: User }>('/api/auth/' + mode, {
        method: 'POST',
        body: JSON.stringify({ username: username.trim(), password }),
      });
      onAuthed(res.user);
    } catch (err: any) {
      setError(err.message || 'Authentication failed');
    } finally {
      setBusy(false);
    }
  };

  const handleDemoLogin = async () => {
    setDemoBusy(true);
    setError('');
    try {
      const res = await api<{ token?: string; user: User }>('/api/auth/demo', {
        method: 'POST',
      });
      onAuthed(res.user);
    } catch (err: any) {
      setError(err.message || 'Could not initialize demo sandbox');
    } finally {
      setDemoBusy(false);
    }
  };

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <div className="auth-brand">
          <div className="auth-logo">
            <IconLayers size={26} />
          </div>
          <h1 className="auth-title">CloudeeeIDE</h1>
          <p className="auth-subtitle">High-performance Docker sandboxed cloud IDE</p>
        </div>

        {/* 1-Click Instant Demo Entry for Evaluators */}
        <button
          type="button"
          className="glass-btn glass-btn-primary"
          style={{
            height: '42px',
            fontSize: 'var(--text-sm)',
            fontWeight: 700,
            background: 'linear-gradient(135deg, #a6e3a1 0%, #94e2d5 100%)',
            color: '#090b10',
            boxShadow: '0 4px 20px rgba(166, 227, 161, 0.3)',
            border: '1px solid rgba(255, 255, 255, 0.3)',
          }}
          onClick={handleDemoLogin}
          disabled={demoBusy || busy}
        >
          {demoBusy ? (
            <span>Provisioning Cloud Sandbox...</span>
          ) : (
            <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <IconSparkles size={16} />
              <span>⚡ Try Instant Demo (Zero Setup)</span>
            </span>
          )}
        </button>

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', margin: '2px 0' }}>
          <div style={{ flex: 1, height: '1px', background: 'var(--glass-border)' }} />
          <span style={{ fontSize: '11px', color: 'var(--fg-muted)', textTransform: 'uppercase' }}>or sign in</span>
          <div style={{ flex: 1, height: '1px', background: 'var(--glass-border)' }} />
        </div>

        <div className="glass-tabs-container" style={{ width: '100%' }}>
          <button
            type="button"
            className={`glass-tab ${mode === 'login' ? 'active' : ''}`}
            style={{ flex: 1, justifyContent: 'center' }}
            onClick={() => { setMode('login'); setError(''); }}
          >
            Log In
          </button>
          <button
            type="button"
            className={`glass-tab ${mode === 'register' ? 'active' : ''}`}
            style={{ flex: 1, justifyContent: 'center' }}
            onClick={() => { setMode('register'); setError(''); }}
          >
            Create Account
          </button>
        </div>

        <form className="auth-form" onSubmit={submit}>
          <div className="auth-field">
            <label className="auth-label" htmlFor="auth-username">Username</label>
            <input
              id="auth-username"
              className="glass-input"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="e.g. alex"
              required
            />
          </div>

          <div className="auth-field">
            <label className="auth-label" htmlFor="auth-password">Password</label>
            <input
              id="auth-password"
              className="glass-input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={mode === 'register' ? 'Min 8 characters' : 'Enter password'}
              required
            />
          </div>

          {error && (
            <div className="auth-error-banner">
              <span>⚠️</span>
              <span>{error}</span>
            </div>
          )}

          <button
            className="glass-btn glass-btn-primary auth-submit-btn"
            disabled={busy || demoBusy || !username.trim() || !password}
            type="submit"
          >
            {busy ? (
              <span>Authenticating...</span>
            ) : (
              <span>{mode === 'login' ? 'Sign In to Workspace' : 'Get Started'}</span>
            )}
          </button>

          <div className="auth-footer">
            <button
              type="button"
              className="link"
              onClick={() => {
                setMode(mode === 'login' ? 'register' : 'login');
                setError('');
              }}
            >
              {mode === 'login' ? "Don't have an account? Sign up" : 'Already registered? Log in'}
            </button>
            {onSwitchToAdminLogin && (
              <div style={{ marginTop: '8px' }}>
                <button
                  type="button"
                  className="link"
                  onClick={onSwitchToAdminLogin}
                  style={{ fontSize: '11px', color: 'var(--fg-muted)' }}
                >
                  🛡️ Admin Control Plane
                </button>
              </div>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}
