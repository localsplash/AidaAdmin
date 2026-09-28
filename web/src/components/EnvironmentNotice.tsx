import { useEffect, useState } from 'react';

export interface EnvironmentView {
  environmentName: string;
  officePulse: { reachable: boolean; environmentName: string; pbxInstanceId: string };
  mismatch: boolean;
}

export function EnvironmentNotice() {
  const [environment, setEnvironment] = useState<EnvironmentView | null>(null);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    async function refresh() {
      try {
        const response = await fetch('/api/environment', {
          credentials: 'same-origin',
          signal: controller.signal,
        });
        if (!response.ok) throw new Error('Environment unavailable');
        const result = (await response.json()) as EnvironmentView;
        if (
          typeof result.environmentName !== 'string' ||
          !result.officePulse ||
          typeof result.officePulse.environmentName !== 'string'
        )
          throw new Error('Invalid environment response');
        if (active) setEnvironment(result);
      } catch {
        if (active) setEnvironment(null);
      }
    }
    void refresh();
    const timer = setInterval(() => void refresh(), 30000);
    return () => {
      active = false;
      controller.abort();
      clearInterval(timer);
    };
  }, []);
  return (
    <div className="environment-notice">
      <p className="environment-label">
        Environment: <strong>{environment?.environmentName ?? 'unknown'}</strong>
        {environment && (
          <>
            {' '}
            · OfficePulse:{' '}
            {environment.officePulse.reachable
              ? environment.officePulse.environmentName
              : 'unavailable'}
          </>
        )}
      </p>
      {environment?.mismatch && environment.officePulse.reachable && (
        <p role="alert" className="environment-mismatch">
          Environment mismatch: AidaAdmin is {environment.environmentName}, but OfficePulse is{' '}
          {environment.officePulse.environmentName} (PBX {environment.officePulse.pbxInstanceId}).
          Check the OfficePulse connection before making changes.
        </p>
      )}
    </div>
  );
}
