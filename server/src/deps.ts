import type { Pool } from 'mysql2/promise';
import {
  MemoryAuthDb,
  MemorySessionRepository,
  IdentitySessionRepository,
  type SessionRepository,
} from './auth/session-store.js';
import { MemoryAuthStateRepository, type AuthStateRepository } from './auth/state-store.js';
import { EmptyTenantUserDirectory, type TenantUserDirectory } from './auth/tenant-directory.js';
import type { AppConfig, ServiceEnvVar } from './config.js';
import {
  createPool,
  migrate,
  ping,
  MysqlAuthStateRepository,
  MysqlIdentityEventStore,
  MysqlAuditLog,
} from './db/mysql.js';
import { HttpIdClient, type IdClient } from './id/client.js';
import { PlatformTenantRepository, PlatformMembershipRepository } from './id/repositories.js';
import { MemoryIdentityEventStore, type IdentityEventStore } from './id/event-store.js';
import { HttpNocoDbApi } from './nocodb/api.js';
import { CachedBaseResolver, resolveBaseId } from './nocodb/base.js';
import { reportDrift } from './nocodb/schema.js';
import { createRepos, NocoStore, type AidaConfigRepos, type AuditLog } from './nocodb/repos.js';
import { HttpOfficePulseClient, type OfficePulseClient } from './officepulse/client.js';
import { MysqlRuntimeReader, parseMysqlUrl, type RuntimeReader } from './officepulse/runtime-db.js';
import {
  HttpHandsetProvisioningDelivery,
  type HandsetProvisioningDelivery,
} from './provisioning/handset-delivery.js';

export interface AppDeps {
  /** PBX auditing does not require a NocoDB configuration base. */
  audit?: AuditLog | null;
  idClient: IdClient | null;
  sessionStore: SessionRepository;
  stateStore: AuthStateRepository;
  /** Test-only login seam; production uses Identity introspection. */
  tenantDirectory: TenantUserDirectory;
  eventStore: IdentityEventStore;
  repos: AidaConfigRepos | null;
  missingNocoDb: ServiceEnvVar[];
  baseResolver: CachedBaseResolver | null;
  officePulse: OfficePulseClient | null;
  runtimeReader: RuntimeReader | null;
  handsetDelivery: HandsetProvisioningDelivery | null;
  pool: Pool | null;
  dbReady: () => Promise<boolean>;
  configReady?: () => Promise<boolean>;
}

export const NOCODB_ENV_VARS: ServiceEnvVar[] = ['NOCODB_BASE_URL', 'NOCODB_API_TOKEN'];
export function missingNocoDbConfig(config: AppConfig): ServiceEnvVar[] {
  return NOCODB_ENV_VARS.filter((name) => !config.serviceConfig[name]);
}

/** Only a real Identity client can wire the deployed directory repositories. */
export function nocodbFromConfig(
  config: AppConfig,
  idClient: HttpIdClient | null,
  pool: Pool | null,
): {
  repos: AidaConfigRepos;
  baseResolver: CachedBaseResolver;
} | null {
  const { NOCODB_BASE_URL, NOCODB_API_TOKEN } = config.serviceConfig;
  if (!NOCODB_BASE_URL || !NOCODB_API_TOKEN || !idClient) return null;
  const api: HttpNocoDbApi = new HttpNocoDbApi(NOCODB_BASE_URL, NOCODB_API_TOKEN, () =>
    resolver.resolve(),
  );
  const resolver = new CachedBaseResolver(() => resolveBaseId(api));
  const store = new NocoStore(api);
  return {
    repos: createRepos(api, {
      tenants: new PlatformTenantRepository(idClient, store),
      tenantUsers: new PlatformMembershipRepository(idClient),
      audit: pool ? new MysqlAuditLog(pool) : { append: async () => {} },
    }),
    baseResolver: resolver,
  };
}

export function createDeps(config: AppConfig): AppDeps {
  const idBase = config.serviceConfig.ID_BASE_URL;
  const idClient = idBase ? new HttpIdClient(idBase, config.serviceConfig.ID_CLIENT_SECRET) : null;
  const databaseUrl = config.serviceConfig.AIDA_ADMIN_DATABASE_URL;
  const pool = databaseUrl ? createPool(databaseUrl) : null;
  const nocodb = nocodbFromConfig(config, idClient, pool);
  const officePulseBase = config.serviceConfig.OFFICEPULSE_PROVISIONING_BASE_URL;
  const handsetUrl = config.serviceConfig.HANDSET_PROVISIONING_URL;
  const runtimeUrl = config.serviceConfig.OFFICEPULSE_RUNTIME_DATABASE_URL;
  const memoryDb = new MemoryAuthDb();
  return {
    idClient,
    audit: pool ? new MysqlAuditLog(pool) : null,
    // Memory sessions exist only in credential-free tests; configuring Identity
    // always selects centralized sessions, regardless of the local SQL store.
    sessionStore: idClient
      ? new IdentitySessionRepository(idClient)
      : new MemorySessionRepository(memoryDb),
    stateStore: pool ? new MysqlAuthStateRepository(pool) : new MemoryAuthStateRepository(),
    tenantDirectory: new EmptyTenantUserDirectory(),
    eventStore: pool ? new MysqlIdentityEventStore(pool) : new MemoryIdentityEventStore(memoryDb),
    repos: nocodb?.repos ?? null,
    missingNocoDb: missingNocoDbConfig(config),
    baseResolver: nocodb?.baseResolver ?? null,
    officePulse: officePulseBase ? new HttpOfficePulseClient(officePulseBase) : null,
    runtimeReader: runtimeUrl ? new MysqlRuntimeReader(parseMysqlUrl(runtimeUrl)) : null,
    handsetDelivery: handsetUrl ? new HttpHandsetProvisioningDelivery(handsetUrl) : null,
    pool,
    dbReady: pool ? () => ping(pool) : async () => true,
    configReady: nocodb
      ? async () => {
          try {
            return (await reportDrift(nocodb.repos.store.api)).inSync;
          } catch {
            return false;
          }
        }
      : async () => config.nodeEnv !== 'production',
  };
}
export { migrate };
