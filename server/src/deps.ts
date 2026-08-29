import { SessionStore } from './auth/session-store.js';
import { LoginStateStore } from './auth/state-store.js';
import { EmptyTenantUserDirectory, type TenantUserDirectory } from './auth/tenant-directory.js';
import type { AppConfig } from './config.js';
import { HttpIdClient, type IdClient } from './id/client.js';
import { IdEventState } from './id/events.js';

export interface AppDeps {
  idClient: IdClient | null;
  sessionStore: SessionStore;
  stateStore: LoginStateStore;
  tenantDirectory: TenantUserDirectory;
  eventState: IdEventState;
}

export function createDeps(config: AppConfig): AppDeps {
  const idBase = config.serviceConfig.ID_BASE_URL;
  return {
    idClient: idBase ? new HttpIdClient(idBase) : null,
    sessionStore: new SessionStore(),
    stateStore: new LoginStateStore(),
    tenantDirectory: new EmptyTenantUserDirectory(),
    // Tests default to a memory-only cursor; real runs persist it.
    eventState: new IdEventState(config.nodeEnv === 'test' ? null : config.idEventStateFile),
  };
}
