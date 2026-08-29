import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cookieParser from 'cookie-parser';
import express, { type Express } from 'express';
import { pinoHttp } from 'pino-http';
import { sessionMiddleware } from './auth/middleware.js';
import { authRoutes } from './auth/routes.js';
import type { AppConfig } from './config.js';
import { createDeps, type AppDeps } from './deps.js';
import { idEventRoutes } from './id/events.js';
import type { Logger } from './logger.js';
import { correlationMiddleware } from './middleware/correlation.js';
import { csrfProtection } from './middleware/csrf.js';
import { createErrorHandler } from './middleware/error-handler.js';
import { healthRoutes } from './routes/health.js';
import { sessionRoutes } from './routes/session.js';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

export function createApp(
  config: AppConfig,
  logger: Logger,
  deps: AppDeps = createDeps(config),
): Express {
  const app = express();

  app.disable('x-powered-by');
  app.use(correlationMiddleware);
  app.use(
    pinoHttp({
      logger,
      customProps: (req) => ({ correlationId: req.correlationId }),
      autoLogging: {
        ignore: (req) => req.url === '/healthz' || req.url === '/readyz',
      },
    }),
  );
  app.use(express.json({ limit: '256kb' }));
  app.use(cookieParser(config.serviceConfig.SESSION_SECRET));
  app.use(sessionMiddleware(deps.sessionStore));

  app.use(healthRoutes(config));

  // Trusted-network surface (id webhooks), guarded by CIDR policy — not by
  // the browser CSRF token.
  app.use(idEventRoutes(config, logger, deps));

  // Every state-changing browser API call must carry the double-submit CSRF
  // token. Applied before any /api or /admin handler so later phases inherit
  // the protection.
  app.use(['/api', '/admin'], csrfProtection);

  app.use(authRoutes(config, logger, deps));
  app.use(sessionRoutes(config));

  app.use('/api', (req, res) => {
    res.status(404).json({
      error: 'not_found',
      message: 'Unknown API route',
      correlationId: req.correlationId,
    });
  });

  // Serve the built web application when present (production container and
  // the e2e smoke test); unknown non-API GETs fall through to the SPA shell.
  const webDist = path.resolve(moduleDir, '../../web/dist');
  if (existsSync(webDist)) {
    app.use(express.static(webDist));
    app.use((req, res, next) => {
      if (req.method !== 'GET') {
        next();
        return;
      }
      res.sendFile(path.join(webDist, 'index.html'));
    });
  }

  app.use(createErrorHandler(logger));

  return app;
}
