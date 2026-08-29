import { pino } from 'pino';
import type { AppConfig } from './config.js';

/**
 * Paths that must never reach log output. Covers session cookies, bearer
 * tokens, and any future secret-bearing headers or fields.
 */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  '*.password',
  '*.secret',
  '*.token',
  '*.sipSecret',
  '*.enrollmentToken',
  '*.apiToken',
];

export function createLogger(config: Pick<AppConfig, 'logLevel'>) {
  return pino({
    level: config.logLevel,
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    formatters: {
      level(label) {
        return { level: label };
      },
    },
  });
}

export type Logger = ReturnType<typeof createLogger>;
