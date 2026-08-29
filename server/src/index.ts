import { createApp } from './app.js';
import { ConfigError, loadConfig } from './config.js';
import { createDeps, migrate } from './deps.js';
import { catchUpIdEvents } from './id/events.js';
import { createLogger } from './logger.js';

const SHUTDOWN_GRACE_MS = 10_000;

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      // Configuration errors name variables, never values.
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }

  const logger = createLogger(config);
  const deps = createDeps(config);

  if (deps.pool) {
    try {
      await migrate(deps.pool);
      logger.info('aida_admin schema is current');
    } catch (err) {
      logger.error({ err }, 'aida_admin schema migration failed');
      // Without persistence nothing durable can be promised; refuse to serve.
      process.exit(1);
    }
  }

  const app = createApp(config, logger, deps);

  const server = app.listen(config.port, () => {
    logger.info(
      { port: config.port, nodeEnv: config.nodeEnv, missing: config.missingServiceConfig },
      'AidaAdmin server listening',
    );
    if (deps.idClient) {
      const idClient = deps.idClient;
      // Catch up on identity events missed while down, then (optionally)
      // (re-)register the webhook receiver. Both are best-effort at boot;
      // failures are logged and the durable cursor retries next start.
      void catchUpIdEvents(idClient, deps, logger).catch((err) => {
        logger.error({ err }, 'id event catch-up failed');
      });
      const publicBase = config.serviceConfig.PUBLIC_BASE_URL;
      if (config.idRegisterWebhook && publicBase) {
        const webhookUrl = new URL('/id/events', publicBase).toString();
        void idClient.registerWebhook('AidaAdmin', webhookUrl).catch((err) => {
          logger.error({ err }, 'id webhook registration failed');
        });
      }
    }
  });

  let shuttingDown = false;
  function shutdown(signal: string): void {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    const forceExit = setTimeout(() => {
      logger.error('graceful shutdown timed out, exiting');
      process.exit(1);
    }, SHUTDOWN_GRACE_MS);
    forceExit.unref();
    server.close((err) => {
      if (err) {
        logger.error({ err }, 'error during shutdown');
        process.exit(1);
      }
      logger.info('shutdown complete');
      process.exit(0);
    });
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
