import { useCallback, useEffect, useState } from 'react';
import { NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { fetchSession, logout, type SessionState, type SessionView } from './api/session';
import {
  ErrorScreen,
  ForbiddenScreen,
  LoadingScreen,
  LoginRequiredScreen,
} from './components/StatusScreens';
import { TenantContextBanner } from './components/TenantContextBanner';
import { ExtensionsScreen } from './screens/ExtensionsScreen';
import { RingGroupsScreen } from './screens/RingGroupsScreen';
import { TenantsScreen } from './screens/TenantsScreen';
import { TenantUsersScreen } from './screens/TenantUsersScreen';

function DashboardScreen() {
  return (
    <section aria-labelledby="dashboard-heading">
      <h1 id="dashboard-heading">Dashboard</h1>
      <p>
        Welcome to AidaAdmin. Tenant, telephony, assistant, and live-operations management arrive in
        the following POC phases.
      </p>
    </section>
  );
}

function NotFoundScreen() {
  return (
    <section aria-labelledby="notfound-heading">
      <h1 id="notfound-heading">Page not found</h1>
      <p>The page you requested does not exist.</p>
    </section>
  );
}

function AuthenticatedShell({
  session,
  onLoggedOut,
}: {
  session: SessionView;
  onLoggedOut: () => void;
}) {
  const handleLogout = async () => {
    await logout();
    onLoggedOut();
  };
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>
      <header className="app-header">
        <span className="app-title">AidaAdmin</span>
        <nav aria-label="Primary">
          <NavLink to="/" end>
            Dashboard
          </NavLink>
          {session.user.superAdmin ? <NavLink to="/tenants">Tenants</NavLink> : null}
        </nav>
        <span className="app-user">{session.user.displayName ?? session.user.email ?? 'User'}</span>
        <button type="button" className="logout-button" onClick={() => void handleLogout()}>
          Sign out
        </button>
      </header>
      <TenantContextBanner session={session} />
      <main id="main-content" className="app-main">
        <Routes>
          <Route path="/" element={<DashboardScreen />} />
          <Route path="/tenants" element={<TenantsScreen />} />
          <Route path="/tenants/:tenantId/users" element={<TenantUsersScreen />} />
          <Route path="/tenants/:tenantId/extensions" element={<ExtensionsScreen />} />
          <Route path="/tenants/:tenantId/ring-groups" element={<RingGroupsScreen />} />
          <Route path="/forbidden" element={<ForbiddenScreen />} />
          <Route path="*" element={<NotFoundScreen />} />
        </Routes>
      </main>
    </div>
  );
}

export default function App() {
  const [state, setState] = useState<SessionState>({ kind: 'loading' });
  const location = useLocation();
  // The login callback redirects here with ?login=denied|error on failure.
  const loginFlag = new URLSearchParams(location.search).get('login');

  const load = useCallback(() => {
    setState({ kind: 'loading' });
    void fetchSession().then(setState);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  switch (state.kind) {
    case 'loading':
      return <LoadingScreen label="Loading AidaAdmin" />;
    case 'unauthenticated':
      if (loginFlag === 'denied') return <ForbiddenScreen />;
      return <LoginRequiredScreen failed={loginFlag === 'error'} />;
    case 'forbidden':
      return <ForbiddenScreen />;
    case 'error':
      return <ErrorScreen onRetry={load} />;
    case 'authenticated':
      return <AuthenticatedShell session={state.session} onLoggedOut={load} />;
  }
}
