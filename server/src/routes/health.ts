import { Router } from 'express';
import type { AppConfig } from '../config.js';
import type { AppDeps } from '../deps.js';

export function healthRoutes(config: AppConfig, deps: AppDeps): Router {
  const router = Router();

  router.get('/healthz', (_req, res) => {
    res.json({ status: 'ok' });
  });

  router.get('/readyz', async (_req, res) => {
    // Production startup already fails on missing configuration, so outside
    // production this reports degraded-but-ready with variable names only.
    const configReady = config.nodeEnv !== 'production' || config.missingServiceConfig.length === 0;
    const databaseReady = await deps.dbReady();
    const ready = configReady && databaseReady;
    res.status(ready ? 200 : 503).json({
      status: ready ? 'ready' : 'not_ready',
      database: databaseReady ? 'ok' : 'unreachable',
      missingConfiguration: config.missingServiceConfig,
    });
  });

  return router;
}
