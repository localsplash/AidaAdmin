import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import type { SessionView } from '../api/session';
import { adminApi } from '../api/admin';

interface SelectableTenant {
  tenantId: string;
  name: string;
  slug: string;
  role: string;
}

export function TenantContextBanner({
  session,
  onTenantChanged,
}: {
  session: SessionView;
  onTenantChanged: () => void;
}) {
  const tenant = session.selectedTenant;
  const [options, setOptions] = useState<SelectableTenant[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  useEffect(() => {
    if (!session.user.superAdmin) return;
    let active = true;
    fetch('/api/session/tenants', { credentials: 'same-origin' })
      .then(async (r) => {
        if (!r.ok) throw new Error('Could not load tenants');
        return r.json() as Promise<{ tenants: SelectableTenant[] }>;
      })
      .then((body) => {
        if (active) setOptions(body.tenants);
      })
      .catch(() => {
        if (active) setError('Could not load tenants. Refresh to retry.');
      });
    return () => {
      active = false;
    };
  }, [session.user.iUserId, session.user.superAdmin]);
  const select = async (id: string) => {
    if (!id || busy) return;
    setBusy(true);
    setError(null);
    try {
      await adminApi.selectTenant(id);
      const next = /^\/tenants\/[^/]+\//.test(location.pathname)
        ? location.pathname.replace(/^\/tenants\/[^/]+\//, `/tenants/${id}/`)
        : location.pathname.startsWith('/runtime/calls/')
          ? '/runtime'
          : location.pathname;
      navigate(next, { replace: true });
      onTenantChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not change tenant');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="tenant-banner">
      <span role="status" aria-live="polite">
        {tenant ? (
          <>
            Tenant: <strong>{tenant.name}</strong> ({tenant.slug}) — role {tenant.role}
          </>
        ) : (
          <>No tenant selected{session.user.superAdmin ? ' — acting as Super Admin' : ''}</>
        )}
      </span>
      {session.user.superAdmin ? (
        <label>
          Switch tenant
          <select
            disabled={busy}
            value={tenant?.tenantId ?? ''}
            onChange={(e) => void select(e.target.value)}
          >
            <option value="">Choose…</option>
            {options.map((o) => (
              <option key={o.tenantId} value={o.tenantId}>
                {o.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
    </div>
  );
}
