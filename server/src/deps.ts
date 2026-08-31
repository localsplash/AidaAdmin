import type pg from 'pg';
import {
  MemoryAuthDb,
  MemorySessionRepository,
  type SessionRepository,
} from './auth/session-store.js';
import { MemoryAuthStateRepository, type AuthStateRepository } from './auth/state-store.js';
import { EmptyTenantUserDirectory, type TenantUserDirectory } from './auth/tenant-directory.js';
import type { AppConfig, ServiceEnvVar } from './config.js';
import {
  createPool,
  migrate,
  ping,
  PostgresAuthStateRepository,
  PostgresIdentityEventStore,
  PostgresSessionRepository,
} from './db/postgres.js';
import { HttpIdClient, type IdClient } from './id/client.js';
import { MemoryIdentityEventStore, type IdentityEventStore } from './id/event-store.js';
import { HttpNocoDbApi } from './nocodb/api.js';
import { createRepos, NocoDbTenantUserDirectory, type AidaConfigRepos } from './nocodb/repos.js';
import { HttpOfficePulseClient, type OfficePulseClient } from './officepulse/client.js';
import {
  HttpHandsetProvisioningDelivery,
  type HandsetProvisioningDelivery,
} from './provisioning/handset-delivery.js';

export interface AppDeps {
  idClient: IdClient | null;
  sessionStore: SessionRepository;
  stateStore: AuthStateRepository;
  tenantDirectory: TenantUserDirectory;
  eventStore: IdentityEventStore;
  /** Non-null when the NocoDB AidaConfiguration base is configured. */
  repos: AidaConfigRepos | null;
  /** Names of the NocoDB variables that are missing when repos is null. */
  missingNocoDb: ServiceEnvVar[];
  /** Non-null when the OfficePulse provisioning API is configured. */
  officePulse: OfficePulseClient | null;
  /** Non-null when the handset provisioning service is configured. */
  handsetDelivery: HandsetProvisioningDelivery | null;
  /** Non-null when PostgreSQL persistence is configured. */
  pool: pg.Pool | null;
  /** Readiness probe for the persistence layer (always true without one). */
  dbReady: () => Promise<boolean>;
}

/** All three are required together; the base id is the easiest to forget. */
export const NOCODB_ENV_VARS: ServiceEnvVar[] = [
  'NOCODB_BASE_URL',
  'NOCODB_API_TOKEN',
  'NOCODB_BASE_ID',
];

export function missingNocoDbConfig(config: AppConfig): ServiceEnvVar[] {
  return NOCODB_ENV_VARS.filter((name) => !config.serviceConfig[name]);
}

function nocodbFromConfig(config: AppConfig): AidaConfigRepos | null {
  const { NOCODB_BASE_URL, NOCODB_API_TOKEN, NOCODB_BASE_ID } = config.serviceConfig;
  if (!NOCODB_BASE_URL || !NOCODB_API_TOKEN || !NOCODB_BASE_ID) return null;
  return createRepos(new HttpNocoDbApi(NOCODB_BASE_URL, NOCODB_API_TOKEN, NOCODB_BASE_ID));
}

/**
 * Persistence selection: with AIDA_ADMIN_DATABASE_URL, sessions, login
 * states, and identity events live in AidaAdmin's own PostgreSQL database
 * and survive restarts. Without it (credential-less dev and unit tests),
 * memory-backed equivalents with the same semantics are used.
 */
export function createDeps(config: AppConfig): AppDeps {
  const idBase = config.serviceConfig.ID_BASE_URL;
  const idClient = idBase ? new HttpIdClient(idBase) : null;
  const databaseUrl = config.serviceConfig.AIDA_ADMIN_DATABASE_URL;
  const repos = nocodbFromConfig(config);
  // With NocoDB configured, tenant_user backs the login directory; without
  // it there are no mappings, so non-super-admins stay denied (POC rule).
  const tenantDirectory = repos
    ? new NocoDbTenantUserDirectory(repos.tenantUsers)
    : new EmptyTenantUserDirectory();
  const officePulseBase = config.serviceConfig.OFFICEPULSE_PROVISIONING_BASE_URL;
  const officePulse = officePulseBase ? new HttpOfficePulseClient(officePulseBase) : null;
  const handsetUrl = config.serviceConfig.HANDSET_PROVISIONING_URL;
  const handsetDelivery = handsetUrl ? new HttpHandsetProvisioningDelivery(handsetUrl) : null;

  if (databaseUrl) {
    const pool = createPool(databaseUrl);
    return {
      idClient,
      sessionStore: new PostgresSessionRepository(pool),
      stateStore: new PostgresAuthStateRepository(pool),
      tenantDirectory,
      eventStore: new PostgresIdentityEventStore(pool),
      repos,
      missingNocoDb: missingNocoDbConfig(config),
      officePulse,
      handsetDelivery,
      pool,
      dbReady: () => ping(pool),
    };
  }

  const memoryDb = new MemoryAuthDb();
  return {
    idClient,
    sessionStore: new MemorySessionRepository(memoryDb),
    stateStore: new MemoryAuthStateRepository(),
    tenantDirectory,
    eventStore: new MemoryIdentityEventStore(memoryDb),
    repos,
    missingNocoDb: missingNocoDbConfig(config),
    officePulse,
    handsetDelivery,
    pool: null,
    dbReady: async () => true,
  };
}

export { migrate };
