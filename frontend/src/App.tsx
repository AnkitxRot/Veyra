import React, { useCallback, useEffect, useState, Suspense } from 'react';
import Auth from './components/Auth/Auth';
import IDE from './components/IDE/IDE';
const AdminDashboard = React.lazy(
  () => import('./components/Admin/AdminDashboard'),
);
import AdminLogin from './components/Admin/AdminLogin';
import { api } from './api';
import { User } from './types';
import { IconAlertTriangle } from './components/common/Icons';
import { parseProjectRoute, projectPath } from './utils/sessionStore';

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [checked, setChecked] = useState(false);
  const [route, setRoute] = useState<string>(window.location.pathname);

  // Sync client-side route navigation
  useEffect(() => {
    const handlePopState = () => {
      setRoute(window.location.pathname);
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  // Stable identity: IDE depends on `onNavigateProject` in effects; a fresh
  // function every render would thrash those.
  const navigate = useCallback((path: string) => {
    // No-op when we're already there — avoids a redundant history entry when
    // e.g. a deep-linked /p/<id> load re-affirms its own URL.
    if (path !== window.location.pathname) {
      window.history.pushState({}, '', path);
    }
    setRoute(path);
  }, []);

  const navigateProject = useCallback(
    (id: string | null) => navigate(id ? projectPath(id) : '/'),
    [navigate],
  );

  useEffect(() => {
    api<{ user: User }>('/api/auth/me')
      .then((r) => setUser(r.user))
      .catch(() => setUser(null))
      .finally(() => setChecked(true));
  }, []);

  const handleLogout = async () => {
    try {
      await api('/api/auth/logout', { method: 'POST' });
    } catch {}
    setUser(null);
  };

  if (!checked) {
    return (
      <div
        style={{
          display: 'flex',
          height: '100vh',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <div
          style={{
            width: '24px',
            height: '24px',
            border: '3px solid var(--border)',
            borderTopColor: 'var(--accent)',
            borderRadius: '50%',
            animation: 'spin 1s linear infinite',
          }}
        />
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  // --- ROUTE: /admin or /admin/login ---
  const isAdminRoute = route.startsWith('/admin');

  if (isAdminRoute) {
    if (!user) {
      return (
        <AdminLogin
          onAuthed={(authedUser) => {
            setUser(authedUser);
            navigate('/admin');
          }}
          onSwitchToUserLogin={() => navigate('/')}
        />
      );
    }

    if (user.role !== 'admin') {
      return (
        <div className="auth-wrap">
          <div
            className="auth-card"
            style={{
              textAlign: 'center',
              border: '1px solid rgba(243, 139, 168, 0.4)',
            }}
          >
            <div
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: '48px',
                height: '48px',
                borderRadius: '12px',
                background: 'rgba(243, 139, 168, 0.15)',
                color: '#f38ba8',
                marginBottom: '16px',
              }}
            >
              <IconAlertTriangle size={24} />
            </div>
            <h2
              style={{
                fontSize: '18px',
                fontWeight: 600,
                color: 'var(--fg-primary)',
                margin: '0 0 8px 0',
              }}
            >
              Access Forbidden (403)
            </h2>
            <p
              style={{
                fontSize: '13px',
                color: 'var(--fg-muted)',
                lineHeight: 1.5,
                marginBottom: '20px',
              }}
            >
              Your active session (<strong>{user.username}</strong>) does not
              have administrator privileges.
            </p>
            <div
              style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}
            >
              <button
                className="glass-btn glass-btn-primary"
                onClick={() => navigate('/')}
              >
                ← Return to Developer IDE Workspace
              </button>
              <button
                className="glass-btn glass-btn-ghost"
                onClick={async () => {
                  await handleLogout();
                  navigate('/admin/login');
                }}
                style={{ color: '#f38ba8' }}
              >
                Sign in with an Admin Account
              </button>
            </div>
          </div>
        </div>
      );
    }

    return (
      <Suspense fallback={<div className="auth-wrap" />}>
        <AdminDashboard
          user={user}
          onLogout={handleLogout}
          onSwitchToIde={() => navigate('/')}
        />
      </Suspense>
    );
  }

  // --- ROUTE: / (Developer IDE Workload Plane) ---
  if (!user) {
    return (
      <Auth
        onAuthed={setUser}
        onSwitchToAdminLogin={() => navigate('/admin/login')}
      />
    );
  }

  return (
    <IDE
      user={user}
      onLogout={handleLogout}
      onSwitchToAdmin={() => navigate('/admin')}
      routeProjectId={parseProjectRoute(route)}
      onNavigateProject={navigateProject}
    />
  );
}
