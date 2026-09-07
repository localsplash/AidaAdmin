import { useEffect, useState, type ReactNode } from 'react';
import { useParams } from 'react-router-dom';
import type { SessionView } from '../api/session';
import { adminApi } from '../api/admin';
import { ForbiddenScreen, LoadingScreen } from './StatusScreens';

/** Direct links and the session banner must identify the same tenant before showing records. */
export function TenantPage({
  session,
  onChanged,
  children,
}: {
  session: SessionView;
  onChanged: () => void;
  children: ReactNode;
}) {
  const { tenantId } = useParams();
  const matches = tenantId === session.selectedTenant?.tenantId;
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (matches || !session.user.superAdmin || !tenantId) return;
    let active = true;
    void adminApi
      .selectTenant(tenantId)
      .then(() => {
        if (active) onChanged();
      })
      .catch((e: unknown) => {
        if (active) setError(e instanceof Error ? e.message : 'Could not select tenant');
      });
    return () => {
      active = false;
    };
  }, [matches, session.user.superAdmin, tenantId, onChanged]);
  if (!matches) {
    if (!session.user.superAdmin) return <ForbiddenScreen />;
    if (error) return <p role="alert">{error}</p>;
    return <LoadingScreen label="Selecting tenant" />;
  }
  return <>{children}</>;
}
