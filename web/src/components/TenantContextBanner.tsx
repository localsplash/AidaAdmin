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
 * Persistent banner naming the tenant context every action applies to, with
 * the selector that scopes runtime views. A Super Admin without a selected
 * tenant sees that explicitly rather than an empty banner.
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
      {options.length > 0 ? (
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
