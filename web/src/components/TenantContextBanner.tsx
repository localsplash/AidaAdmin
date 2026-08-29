import type { SessionView } from '../api/session';

/**
 * Persistent banner naming the tenant context every action applies to. A
 * Super Admin without a selected tenant sees that explicitly rather than an
 * empty banner.
 */
export function TenantContextBanner({ session }: { session: SessionView }) {
  const tenant = session.selectedTenant;
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
      )}
    </div>
  );
}
