import React, { useState } from 'react';
import { api, setToken } from '../../api';
import { User } from '../../types';

export default function Auth({ onAuthed }: { onAuthed: (u: User) => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const res = await api<{ token: string; user: User }>('/api/auth/' + mode, {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      });
      setToken(res.token);
      onAuthed(res.user);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <h1>CloudeeeIDE</h1>
        <form className="auth-form" onSubmit={submit}>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="Username"
            required
          />
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
            required
          />
          {error && <div className="error">{error}</div>}
          <button className="auth-btn" disabled={busy || !username || !password} type="submit">
            {mode === 'login' ? 'Log In' : 'Register'}
          </button>
          <div className="auth-switch">
            <button type="button" className="link" onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>
              {mode === 'login' ? "Don't have an account? Sign up" : 'Already have an account? Log in'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
