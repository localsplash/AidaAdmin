import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  /**
   * Enables the fake authenticated session used by the browser smoke test.
   * Refused outright in production (see loadConfig).
   */
  E2E_FAKE_SESSION: z.coerce.boolean().default(false),
});

/**
 * External-service configuration consumed by later POC phases (id login,
 * NocoDB writes, OfficePulse provisioning, AidaControl proxying). None of it
 * is needed to run unit tests, but production startup requires every variable
 * to be present. Values are never logged — only names.
 */
export const SERVICE_ENV_VARS = [
  'PUBLIC_BASE_URL',
  'SESSION_SECRET',
  'ID_BASE_URL',
  'ID_TRUSTED_APP_CIDRS',
  'ID_EVENT_SOURCE_CIDRS',
  'ID_TRUSTED_PROXY_CIDRS',
  'NOCODB_BASE_URL',
  'NOCODB_API_TOKEN',
  'NOCODB_BASE_ID',
  'OFFICEPULSE_PROVISIONING_BASE_URL',
  'AIDACONTROL_BASE_URL',
  'AIDACONTROL_TRUSTED_SERVER_CIDRS',
] as const;

export type ServiceEnvVar = (typeof SERVICE_ENV_VARS)[number];

export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
  e2eFakeSession: boolean;
  /** Service variables present in the environment; values stay out of this object except where a later phase needs them. */
  serviceConfig: Partial<Record<ServiceEnvVar, string>>;
  /** Names (never values) of service variables absent from the environment. */
  missingServiceConfig: ServiceEnvVar[];
}

export class ConfigError extends Error {}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const names = parsed.error.issues.map((issue) => issue.path.join('.')).join(', ');
    throw new ConfigError(`Invalid environment configuration for: ${names}`);
  }

  const serviceConfig: Partial<Record<ServiceEnvVar, string>> = {};
  const missingServiceConfig: ServiceEnvVar[] = [];
  for (const name of SERVICE_ENV_VARS) {
    const value = env[name];
    if (value === undefined || value.trim() === '') {
      missingServiceConfig.push(name);
    } else {
      serviceConfig[name] = value;
    }
  }

  const { NODE_ENV, PORT, LOG_LEVEL, E2E_FAKE_SESSION } = parsed.data;

  if (NODE_ENV === 'production') {
    if (missingServiceConfig.length > 0) {
      // Name the variables so an operator can fix the deployment; never echo values.
      throw new ConfigError(
        `Missing required production configuration: ${missingServiceConfig.join(', ')}`,
      );
    }
    if (E2E_FAKE_SESSION) {
      throw new ConfigError('E2E_FAKE_SESSION must not be enabled in production');
    }
  }

  return {
    nodeEnv: NODE_ENV,
    port: PORT,
    logLevel: LOG_LEVEL,
    e2eFakeSession: E2E_FAKE_SESSION,
    serviceConfig,
    missingServiceConfig,
  };
}
