import React, { useEffect, useState } from 'react';
import Auth from './components/Auth/Auth';
import IDE from './components/IDE/IDE';
import { api, getToken, clearToken } from './api';
import { User } from './types';

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    if (!getToken()) {
      setChecked(true);
      return;
    }
    api<{ user: User }>('/api/auth/me')
      .then((r) => setUser(r.user))
      .catch(() => clearToken())
      .finally(() => setChecked(true));
  }, []);

  if (!checked) return (
    <div style={{display: 'flex', height: '100vh', alignItems: 'center', justifyContent: 'center'}}>
      <div style={{ 
        width: '24px', height: '24px', 
        border: '3px solid var(--border)', 
        borderTopColor: 'var(--accent)', 
        borderRadius: '50%', 
        animation: 'spin 1s linear infinite' 
      }} />
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
  if (!user) return <Auth onAuthed={setUser} />;
  return <IDE user={user} onLogout={() => { clearToken(); setUser(null); }} />;
}
