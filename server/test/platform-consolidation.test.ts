import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createDeps } from '../src/deps.js';
import { createLogger } from '../src/logger.js';
import { HttpIdClient, type PlatformTenant } from '../src/id/client.js';
import { PlatformTenantRepository, PlatformMembershipRepository } from '../src/id/repositories.js';
import { IdentitySessionRepository } from '../src/auth/session-store.js';
import { createRepos, NocoStore } from '../src/nocodb/repos.js';
import { AIDA_SCHEMA, upgradeSchema } from '../src/nocodb/schema.js';
import { resolveSettings } from '../src/platform-config.js';
import { FakeNocoDbApi } from './helpers/fake-nocodb.js';

afterEach(() => vi.unstubAllGlobals());

describe('central authorization with PlatformConfig voice profiles', () => {
  it('refreshes memberships and SUPER_ADMIN privilege on each request and denies cross-business mutations', async () => {
    let active = true;
    let superAdmin = false;
    let enabled = true;
    const tenants: PlatformTenant[] = [
      { iTenantId: 11, name: 'Business A', slug: 'a', role: 'TENANT_ADMIN', bEnabled: true },
      { iTenantId: 22, name: 'Business B', slug: 'b', role: 'SUPER_ADMIN', bEnabled: true },
    ];
    const directoryTokens: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: URL, init: RequestInit) => {
        const path = url.pathname;
        if (path === '/api/sessions/introspect') {
          expect(JSON.parse(init.body as string).token).toBe('central-token');
          return new Response(
            JSON.stringify(
              active
                ? {
                    active: true,
                    user: {
                      iUserId: 7,
                      email: 'admin@example.invalid',
                      displayName: 'Admin',
                      superAdmin,
                    },
                    tenants: (superAdmin ? tenants : tenants.slice(0, 1)).map((t) => ({
                      ...t,
                      bEnabled: enabled,
                    })),
                    selectedTenantId: null,
                  }
                : { active: false },
            ),
          );
        }
        directoryTokens.push(new Headers(init.headers).get('authorization')!);
        if (path === '/api/directory/tenants')
          return new Response(
            JSON.stringify({ tenants: superAdmin ? tenants : tenants.slice(0, 1) }),
          );
        throw new Error(`Unexpected Identity path: ${path}`);
      }),
    );
    const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'fatal' });
    const deps = createDeps(config);
    const id = new HttpIdClient('https://identity.example.invalid');
    const noco = new FakeNocoDbApi();
    await upgradeSchema(noco);
    const store = new NocoStore(noco);
    for (const iTenantId of [11, 22])
      await store.create('tenant_profile', {
        tenant_id: iTenantId,
        asterisk_context: `business-${iTenantId}`,
      });
    deps.idClient = id;
    deps.sessionStore = new IdentitySessionRepository(id);
    deps.repos = createRepos(noco, {
      tenants: new PlatformTenantRepository(id, store),
      tenantUsers: new PlatformMembershipRepository(id),
      audit: { append: async () => {} },
    });
    const app = createApp(config, createLogger(config), deps);
    const cookie = ['aida.sid=central-token', 'aida.csrf=csrf-token'];
    const list = () => request(app).get('/admin/tenants').set('Cookie', cookie);
    expect((await list()).body.tenants.map((t: { id: string }) => t.id)).toEqual(['11']);
    const denied = await request(app)
      .post('/admin/extensions')
      .set('Cookie', cookie)
      .set('x-csrf-token', 'csrf-token')
      .send({ tenantId: '22', extensionNumber: '100', displayName: 'Forbidden' });
    expect(denied.status).toBe(403);
    expect(noco.tableByName('aida_tbl_Extension')!.records).toHaveLength(0);
    superAdmin = true;
    expect((await list()).body.tenants.map((t: { id: string }) => t.id)).toEqual(['11', '22']);
    superAdmin = false;
    enabled = false;
    expect((await list()).status).toBe(401);
    enabled = true;
    active = false;
    expect((await list()).status).toBe(401);
    expect(directoryTokens.every((token) => token === 'Bearer central-token')).toBe(true);
    expect(AIDA_SCHEMA.map((t) => t.table_name)).not.toContain('tenant_user');
    expect(noco.tableByName('aida_tbl_TenantProfile')!.records[0]).toMatchObject({ iTenantId: 11 });
    expect(noco.tableByName('aida_tbl_TenantProfile')!.records[0]).not.toHaveProperty('name');
  });
  it('fails closed on Identity outage while liveness remains available', async () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      LOG_LEVEL: 'fatal',
      ID_BASE_URL: 'https://identity.example.invalid',
    });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Identity down')));
    const app = createApp(config, createLogger(config));
    expect(
      (await request(app).get('/api/session').set('Cookie', 'aida.sid=central-token')).status,
    ).toBe(500);
    expect(
      (await request(app).get('/healthz').set('Cookie', 'aida.sid=central-token')).status,
    ).toBe(200);
  });
});

describe('PlatformConfig settings', () => {
  const setting = (app: string, settingKey: string, settingValue: string) => ({
    app,
    settingKey,
    settingValue,
  });
  it('uses nonblank env, service, voice and global values in that order', () => {
    const rows = [
      setting('*', 'ID_BASE_URL', 'https://global'),
      setting('aida', 'ID_BASE_URL', 'https://voice'),
      setting('aida-admin', 'ID_BASE_URL', 'https://admin'),
    ];
    expect(resolveSettings({}, rows).ID_BASE_URL).toBe('https://admin');
    expect(resolveSettings({ ID_BASE_URL: 'https://env' }, rows).ID_BASE_URL).toBe('https://env');
    rows[2]!.settingValue = ' ';
    expect(resolveSettings({}, rows).ID_BASE_URL).toBe('https://voice');
  });
  it('rejects duplicate applicable keys including blank rows', () => {
    expect(() =>
      resolveSettings({}, [
        setting('aida-admin', 'ID_BASE_URL', ''),
        setting('aida-admin', 'ID_BASE_URL', 'other'),
      ]),
    ).toThrow('Duplicate');
  });
});
