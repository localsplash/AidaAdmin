import type pg from 'pg';
import {
  MemoryAuthDb,
  MemorySessionRepository,
  type SessionRepository,
} from './auth/session-store.js';
import { MemoryAuthStateRepository, type AuthStateRepository } from './auth/state-store.js';
import { EmptyTenantUserDirectory, type TenantUserDirectory } from './auth/tenant-directory.js';
import type { AppConfig } from './config.js';
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

export interface AppDeps {
  idClient: IdClient | null;
  sessionStore: SessionRepository;
  stateStore: AuthStateRepository;
  tenantDirectory: TenantUserDirectory;
  eventStore: IdentityEventStore;
  /** Non-null when PostgreSQL persistence is configured. */
  pool: pg.Pool | null;
  /** Readiness probe for the persistence layer (always true without one). */
  dbReady: () => Promise<boolean>;
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

  if (databaseUrl) {
    const pool = createPool(databaseUrl);
    return {
      idClient,
      sessionStore: new PostgresSessionRepository(pool),
      stateStore: new PostgresAuthStateRepository(pool),
      tenantDirectory: new EmptyTenantUserDirectory(),
      eventStore: new PostgresIdentityEventStore(pool),
      pool,
      dbReady: () => ping(pool),
    };
  }

  const memoryDb = new MemoryAuthDb();
  return {
    idClient,
    sessionStore: new MemorySessionRepository(memoryDb),
    stateStore: new MemoryAuthStateRepository(),
    tenantDirectory: new EmptyTenantUserDirectory(),
    eventStore: new MemoryIdentityEventStore(memoryDb),
    pool: null,
    dbReady: async () => true,
  };
}

export { migrate };
