import { useEffect, useState } from 'react';
import type { SessionView } from '../api/session';

interface SelectableTenant {
  tenantId: string;
  name: string;
  slug: string;
  role: string;
}

function csrfToken(): string {
  return /(?:^|;\s*)aida\.csrf=([^;]+)/.exec(document.cookie)?.[1] ?? '';
}

/**
 * Persistent banner naming the tenant context every action applies to.
 *
 * The selector appears only for someone who genuinely has a choice: a Super
 * Admin, who works across tenants, or the rare person who administers more
 * than one. A tenant administrator of a single tenant is already in the only
 * context they have — the server puts them there — so offering them a
 * "switch tenant" control would only invite them to try leaving it.
 */
export function TenantContextBanner({
  session,
  onTenantChanged,
}: {
  session: SessionView;
  onTenantChanged: () => void;
}) {
  const tenant = session.selectedTenant;
  const [options, setOptions] = useState<SelectableTenant[]>([]);

  useEffect(() => {
    fetch('/api/session/tenants', { credentials: 'same-origin' })
      .then(async (res) =>
        res.ok ? ((await res.json()) as { tenants: SelectableTenant[] }) : null,
      )
      .then((body) => setOptions(body?.tenants ?? []))
      .catch(() => setOptions([]));
  }, [session.user.iUserId]);

  const select = async (tenantId: string) => {
    if (!tenantId) return;
    try {
      await fetch('/api/session/tenant', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken() },
        body: JSON.stringify({ tenantId }),
      });
    } finally {
      onTenantChanged();
    }
  };

  return (
    <div className="tenant-banner" role="status" aria-live="polite">
      {tenant ? (
        <span>
          Tenant: <strong>{tenant.name}</strong> ({tenant.slug}) — role {tenant.role}
        </span>
      ) : (
        <span>
          No tenant selected
          {session.user.superAdmin ? ' — acting as Super Admin' : ''}
        </span>
      )}{' '}
      {session.user.superAdmin || options.length > 1 ? (
        <label>
          Switch tenant
          <select value={tenant?.tenantId ?? ''} onChange={(e) => void select(e.target.value)}>
            <option value="">Choose…</option>
            {options.map((option) => (
              <option key={option.tenantId} value={option.tenantId}>
                {option.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}
    </div>
  );
}
