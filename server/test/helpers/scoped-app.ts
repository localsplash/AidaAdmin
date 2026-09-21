import { Writable } from 'node:stream';
import request from 'supertest';
import { pino } from 'pino';
import { vi } from 'vitest';
import { createApp } from '../../src/app.js';
import { createDeps, type AppDeps } from '../../src/deps.js';
import { loadConfig } from '../../src/config.js';
import { IdentitySessionRepository } from '../../src/auth/session-store.js';
import {
  HttpIdClient,
  type PlatformNumber,
  type PlatformTenant,
  type SessionIntrospection,
} from '../../src/id/client.js';
import {
  PlatformMembershipRepository,
  PlatformTenantRepository,
} from '../../src/id/repositories.js';
import { REDACT_PATHS } from '../../src/logger.js';
import { createRepos, NocoStore, type AuditEntry } from '../../src/nocodb/repos.js';
import { upgradeSchema } from '../../src/nocodb/schema.js';
import { FakeNocoDbApi } from './fake-nocodb.js';
import { FakeOfficePulse } from './fake-officepulse.js';

export const DID = '+15559870001';
/** Tenant 7's PlatformConfig scope: two extension contexts and a shared ingress context. */
export const PROFILE = {
  tenant_id: 7,
  asterisk_context: 'acme',
  additional_contexts: 'acme-branch',
  did_context: 'from-carrier',
};
/** The same row as NocoDB stores it (physical `iTenantId` column). */
const { tenant_id: storedTenantId, ...storedScope } = PROFILE;
export const STORED_PROFILE = { ...storedScope, iTenantId: storedTenantId };

/**
 * The BFF with a central Identity session, the real PlatformConfig tenant
 * repository over an in-memory NocoDB, and a context-scoped OfficePulse fake.
 */
export async function scopedApp(env: NodeJS.ProcessEnv = {}) {
  const state = {
    snapshot: {
      active: true,
      user: { iUserId: 42, email: null, displayName: 'Admin', superAdmin: false },
      tenants: [{ iTenantId: 7, name: 'Acme', slug: 'acme', role: 'TENANT_ADMIN', bEnabled: true }],
      selectedTenantId: 7,
    } as SessionIntrospection,
    numbers: [
      {
        iPhoneNumberId: 1,
        iTenantId: 7,
        phoneNumber: DID,
        label: 'Main',
        bVoice: true,
        bMessaging: true,
        bEnabled: true,
        accessPolicy: 'TENANT_MEMBERS',
        iVersion: 1,
      },
    ] as PlatformNumber[],
    audits: [] as AuditEntry[],
    logs: '',
  };
  const identity = new HttpIdClient('https://id.invalid');
  identity.introspectSession = vi.fn(async () => state.snapshot);
  identity.listTenantNumbers = vi.fn(async () => ({ numbers: state.numbers }));
  identity.directoryRequest = async <T>(path: string): Promise<T> => {
    if (path !== 'tenants') throw new Error(`Unexpected Identity directory call ${path}`);
    const tenants: PlatformTenant[] = state.snapshot.active ? state.snapshot.tenants : [];
    return { tenants } as T;
  };
  const noco = new FakeNocoDbApi();
  await upgradeSchema(noco);
  const store = new NocoStore(noco);
  await store.create('tenant_profile', PROFILE);
  const api = new FakeOfficePulse();
  api.dids.set('acme', [
    { did: DID, managed: false, availability: 'unconfigured', applyState: 'unknown' },
  ]);
  const logger = pino(
    { level: 'info', redact: { paths: REDACT_PATHS, censor: '[REDACTED]' } },
    new Writable({
      write(chunk, _encoding, callback) {
        state.logs += String(chunk);
        callback();
      },
    }),
  );
  const config = loadConfig({ NODE_ENV: 'test', ...env });
  const deps: AppDeps = {
    ...createDeps(config),
    sessionStore: new IdentitySessionRepository(identity),
    idClient: identity,
    officePulse: api,
    repos: createRepos(noco, {
      tenants: new PlatformTenantRepository(identity, store),
      tenantUsers: new PlatformMembershipRepository(identity),
      audit: { append: async () => {} },
    }),
    audit: {
      append: async (entry) => {
        state.audits.push(entry);
      },
    },
  };
  const app = createApp(config, logger, deps);
  function send(method: 'get' | 'post' | 'put' | 'delete', path: string, body?: object) {
    const client = request(app);
    const call = client[method](path)
      .set('Cookie', ['aida.sid=central-session', 'aida.csrf=csrf-proof'])
      .set('x-csrf-token', 'csrf-proof')
      .set('x-correlation-id', 'pbx-test-correlation');
    return body === undefined ? call : call.send(body);
  }
  return { app, deps, api, identity, noco, store, state, send };
}
