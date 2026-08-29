import { z } from 'zod';

/**
 * Strict environment boolean: "false"/"0"/"no" mean false. (z.coerce.boolean
 * would treat the string "false" as true — a real misconfiguration hazard.)
 */
const envBool = z.preprocess((value) => {
  if (value === undefined || value === null) return false;
  if (typeof value === 'boolean') return value;
  const text = String(value).trim().toLowerCase();
  if (['true', '1', 'yes'].includes(text)) return true;
  if (['false', '0', 'no', ''].includes(text)) return false;
  return value;
}, z.boolean());

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  /**
   * Enables the fake authenticated session used by the browser smoke test.
   * Refused outright in production (see loadConfig).
   */
  E2E_FAKE_SESSION: envBool,
  /** Register the /id/events webhook with id at startup. */
  ID_REGISTER_WEBHOOK: envBool,
  /** Where validated appearance assets (logos) are stored and served from. */
  ASSET_STORAGE_DIR: z.string().default('data/assets'),
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
  'AIDA_ADMIN_DATABASE_URL',
  'ID_BASE_URL',
  'ID_TRUSTED_APP_CIDRS',
  'ID_EVENT_SOURCE_CIDRS',
  'ID_TRUSTED_PROXY_CIDRS',
  'NOCODB_BASE_URL',
  'NOCODB_API_TOKEN',
  'NOCODB_BASE_ID',
  'OFFICEPULSE_PROVISIONING_BASE_URL',
  'HANDSET_PROVISIONING_URL',
  'AIDACONTROL_BASE_URL',
  'AIDACONTROL_TRUSTED_SERVER_CIDRS',
] as const;

export type ServiceEnvVar = (typeof SERVICE_ENV_VARS)[number];

/** CIDR allowlists that must be present and non-empty in production. */
export const REQUIRED_CIDR_VARS = [
  'ID_TRUSTED_APP_CIDRS',
  'ID_EVENT_SOURCE_CIDRS',
  'ID_TRUSTED_PROXY_CIDRS',
] as const;

const CIDR_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/;

export function parseCidrList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
  e2eFakeSession: boolean;
  idRegisterWebhook: boolean;
  assetStorageDir: string;
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

  const { NODE_ENV, PORT, LOG_LEVEL, E2E_FAKE_SESSION, ID_REGISTER_WEBHOOK, ASSET_STORAGE_DIR } =
    parsed.data;

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
    // The POC trust model is CIDR-based; an empty or malformed allowlist would
    // silently deny (or worse, misclassify) every peer, so refuse to start.
    for (const name of REQUIRED_CIDR_VARS) {
      const entries = parseCidrList(serviceConfig[name]);
      if (entries.length === 0) {
        throw new ConfigError(`Production configuration ${name} must list at least one CIDR`);
      }
      for (const entry of entries) {
        if (!CIDR_RE.test(entry)) {
          throw new ConfigError(`Production configuration ${name} contains an invalid IPv4 CIDR`);
        }
      }
    }
  }

  return {
    nodeEnv: NODE_ENV,
    port: PORT,
    logLevel: LOG_LEVEL,
    e2eFakeSession: E2E_FAKE_SESSION,
    idRegisterWebhook: ID_REGISTER_WEBHOOK,
    assetStorageDir: ASSET_STORAGE_DIR,
    serviceConfig,
    missingServiceConfig,
  };
}
