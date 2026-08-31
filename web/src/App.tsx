import { useCallback, useEffect, useState } from 'react';
import { Link, NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { fetchSession, logout, type SessionState, type SessionView } from './api/session';
import {
  ErrorScreen,
  ForbiddenScreen,
  LoadingScreen,
  LoginRequiredScreen,
} from './components/StatusScreens';
import { TenantContextBanner } from './components/TenantContextBanner';
import { AppearanceScreen } from './screens/AppearanceScreen';
import { OperationsScreen } from './screens/OperationsScreen';
import { DidRoutesScreen } from './screens/DidRoutesScreen';
import { ExtensionsScreen } from './screens/ExtensionsScreen';
import { ProfilesScreen } from './screens/ProfilesScreen';
import { RingGroupsScreen } from './screens/RingGroupsScreen';
import { TenantsScreen } from './screens/TenantsScreen';
import { TenantUsersScreen } from './screens/TenantUsersScreen';

const TENANT_SCREENS = [
  { path: 'users', label: 'Users' },
  { path: 'extensions', label: 'Extensions' },
  { path: 'ring-groups', label: 'Ring groups' },
  { path: 'profiles', label: 'Profiles' },
  { path: 'did-routes', label: 'DID routes' },
  { path: 'appearance', label: 'Appearance' },
] as const;

/**
 * The landing page. For a tenant administrator this is the whole map of
 * what they can do — they administer one tenant and arrive already in it —
 * so the tenant's screens are listed here rather than only behind the
 * tenants list.
 */
function DashboardScreen({ session }: { session: SessionView }) {
  const tenant = session.selectedTenant;
  const administers = session.user.superAdmin || tenant?.role === 'TENANT_ADMIN';
  return (
    <section aria-labelledby="dashboard-heading">
      <h1 id="dashboard-heading">Dashboard</h1>
      {tenant && administers ? (
        <>
          <p>
            Managing <strong>{tenant.name}</strong>.
          </p>
          <nav aria-label={`${tenant.name} management`}>
            <ul>
              {TENANT_SCREENS.map((screen) => (
                <li key={screen.path}>
                  <Link to={`/tenants/${tenant.tenantId}/${screen.path}`}>{screen.label}</Link>
                </li>
              ))}
            </ul>
          </nav>
        </>
      ) : (
        <p>
          Welcome to AidaAdmin.{' '}
          {session.user.superAdmin
            ? 'Choose a tenant to manage, or open Tenants to create one.'
            : 'You have no tenant to manage yet — an administrator can map you to one.'}
        </p>
      )}
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
  onSessionChanged,
}: {
  session: SessionView;
  onLoggedOut: () => void;
  onSessionChanged: () => void;
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
          {/* The tenants list is scoped server-side, so it is the way in for
              both roles: every tenant for a Super Admin, their own for a
              tenant administrator. */}
          {session.user.superAdmin || session.selectedTenant?.role === 'TENANT_ADMIN' ? (
            <NavLink to="/tenants">Tenants</NavLink>
          ) : null}
          {session.selectedTenant ? <NavLink to="/operations">Live operations</NavLink> : null}
        </nav>
        <span className="app-user">{session.user.displayName ?? session.user.email ?? 'User'}</span>
        <button type="button" className="logout-button" onClick={() => void handleLogout()}>
          Sign out
        </button>
      </header>
      <TenantContextBanner session={session} onTenantChanged={onSessionChanged} />
      <main id="main-content" className="app-main">
        <Routes>
          <Route path="/" element={<DashboardScreen session={session} />} />
          <Route path="/tenants" element={<TenantsScreen canCreate={session.user.superAdmin} />} />
          <Route path="/tenants/:tenantId/users" element={<TenantUsersScreen />} />
          <Route path="/tenants/:tenantId/extensions" element={<ExtensionsScreen />} />
          <Route path="/tenants/:tenantId/ring-groups" element={<RingGroupsScreen />} />
          <Route path="/tenants/:tenantId/profiles" element={<ProfilesScreen />} />
          <Route path="/tenants/:tenantId/did-routes" element={<DidRoutesScreen />} />
          <Route path="/tenants/:tenantId/appearance" element={<AppearanceScreen />} />
          <Route path="/operations" element={<OperationsScreen />} />
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
      return (
        <AuthenticatedShell session={state.session} onLoggedOut={load} onSessionChanged={load} />
      );
  }
}
