import { Router } from 'express';
import type { AppConfig } from '../config.js';

export function healthRoutes(config: AppConfig): Router {
  const router = Router();

  router.get('/healthz', (_req, res) => {
    res.json({ status: 'ok' });
  });

  router.get('/readyz', (_req, res) => {
    // Production startup already fails on missing configuration, so outside
    // production this reports degraded-but-ready with variable names only.
    const ready = config.nodeEnv !== 'production' || config.missingServiceConfig.length === 0;
    res.status(ready ? 200 : 503).json({
      status: ready ? 'ready' : 'not_ready',
      missingConfiguration: config.missingServiceConfig,
    });
  });

  return router;
}
