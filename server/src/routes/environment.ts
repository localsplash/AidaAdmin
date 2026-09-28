import { Router } from 'express';
import { requireSession } from '../admin/authz.js';
import type { AppConfig } from '../config.js';
import type { AppDeps } from '../deps.js';

/** Only public environment identity reaches the shell, never dependency details/settings. */
export function environmentRoutes(config: AppConfig, deps: AppDeps): Router {
  const router = Router();
  router.get('/api/environment', requireSession, async (_req, res) => {
    const live = await deps.officePulse?.readiness().catch(() => null);
    const local = config.environmentName;
    const remote = live?.reachable ? live.environmentName?.trim() || null : null;
    res.set('Cache-Control', 'no-store').json({
      environmentName: local ?? 'unknown',
      officePulse: {
        reachable: live?.reachable === true,
        environmentName: remote ?? 'unknown',
        pbxInstanceId: live?.pbxInstanceId ?? 'unknown',
      },
      mismatch: !!local && !!remote && local !== remote,
    });
  });
  return router;
}
