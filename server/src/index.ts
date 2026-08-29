import { createApp } from './app.js';
import { ConfigError, loadConfig } from './config.js';
import { createLogger } from './logger.js';

const SHUTDOWN_GRACE_MS = 10_000;

function main(): void {
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
  const app = createApp(config, logger);

  const server = app.listen(config.port, () => {
    logger.info(
      { port: config.port, nodeEnv: config.nodeEnv, missing: config.missingServiceConfig },
      'AidaAdmin server listening',
    );
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

main();
