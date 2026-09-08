import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createDeps, type AppDeps } from '../src/deps.js';
import { createLogger } from '../src/logger.js';
import { HttpOfficePulseClient } from '../src/officepulse/client.js';
import { FakeOfficePulse } from './helpers/fake-officepulse.js';

afterEach(() => vi.unstubAllGlobals());

async function setup(superAdmin = false) {
  const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'fatal' });
  const officePulse = Object.assign(new FakeOfficePulse(), {
    listPbxExtensions: vi.fn(async (iTenantId: number) => ({
      source: 'asterisk' as const,
      iTenantId,
      extensions: [
        { id: 'pbx-100', context: 'office', callerId: null, transport: null, aors: '100' },
      ],
    })),
    listPbxQueues: vi.fn(async (iTenantId: number) => ({
      source: 'asterisk' as const,
      iTenantId,
      queues: [],
    })),
  });
  const deps: AppDeps = { ...createDeps(config), officePulse };
  deps.repos = {
    tenantUsers: {
      listForUser: vi.fn(async () => [
        { tenant_id: '7', enabled: true, role: 'TENANT_ADMIN' },
        { tenant_id: '8', enabled: false, role: 'TENANT_ADMIN' },
        { tenant_id: '9', enabled: true, role: 'USER' },
      ]),
    },
  } as unknown as NonNullable<AppDeps['repos']>;
  const sid = await deps.sessionStore.create({
    iUserId: 1,
    email: null,
    displayName: null,
    superAdmin,
    provider: null,
  });
  const app = createApp(config, createLogger({ logLevel: 'fatal' }), deps);
  return { app, officePulse, cookies: [`aida.sid=${sid}`, 'aida.csrf=csrf'] };
}

describe('Asterisk inventory boundary', () => {
  it('requires authentication and denies another, disabled, or non-admin tenant before reading PBX data', async () => {
    const { app, cookies, officePulse } = await setup();
    expect((await request(app).get('/admin/tenants/7/pbx/extensions')).status).toBe(401);
    for (const tenantId of ['8', '9', '10']) {
      expect(
        (await request(app).get(`/admin/tenants/${tenantId}/pbx/extensions`).set('Cookie', cookies))
          .status,
      ).toBe(403);
    }
    expect(officePulse.listPbxExtensions).not.toHaveBeenCalled();
    const res = await request(app)
      .get('/admin/tenants/7/pbx/extensions?iTenantId=10')
      .set('Cookie', cookies)
      .set('X-Aida-Tenant-Id', '10');
    expect(res.status).toBe(200);
    expect(res.body.iTenantId).toBe(7);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(officePulse.listPbxExtensions).toHaveBeenCalledWith(7);
  });

  it('reports an unavailable PBX as an error rather than a successful empty inventory', async () => {
    const { app, cookies, officePulse } = await setup();
    officePulse.listPbxQueues.mockRejectedValueOnce(new Error('private SQL details'));
    const res = await request(app).get('/admin/tenants/7/pbx/queues').set('Cookie', cookies);
    expect(res.status).toBe(502);
    expect(res.body.error).toBe('pbx_inventory_unavailable');
    expect(JSON.stringify(res.body)).not.toContain('private SQL details');
  });

  it('rejects invalid platform IDs even for a super admin', async () => {
    const { app, cookies, officePulse } = await setup(true);
    for (const tenantId of ['uuid', '0', '9007199254740992']) {
      expect(
        (await request(app).get(`/admin/tenants/${tenantId}/pbx/queues`).set('Cookie', cookies))
          .status,
      ).toBe(400);
    }
    expect(officePulse.listPbxQueues).not.toHaveBeenCalled();
  });

  it('has no legacy saves, secret rotation, handset enrollment, or retry endpoints', async () => {
    const { app, cookies } = await setup(true);
    for (const path of [
      '/admin/extensions',
      '/admin/extensions/ext/rotate-secret',
      '/admin/extensions/ext/enrollment',
      '/admin/ring-groups',
      '/admin/did-routes',
      '/runtime/provisioning/retry',
    ]) {
      const res = await request(app)
        .post(path)
        .set('Cookie', cookies)
        .set('x-csrf-token', 'csrf')
        .send({ tenantId: '7' });
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('not_found');
    }
    for (const path of [
      '/admin/tenants/7/extensions',
      '/admin/tenants/7/ring-groups',
      '/admin/tenants/7/did-routes',
      '/runtime/provisioning',
      '/runtime/fallbacks',
    ]) {
      const res = await request(app).get(path).set('Cookie', cookies);
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('not_found');
    }
  });
});

describe('OfficePulse inventory contract', () => {
  it('uses only the fixed GET API and strips unapproved fields including secrets', async () => {
    const fetcher = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            source: 'asterisk',
            iTenantId: 7,
            extensions: [
              {
                id: 'pbx-100',
                context: 'office',
                callerId: null,
                transport: null,
                aors: '100',
                password: 'secret',
              },
            ],
            secret: 'secret',
          }),
        ),
    );
    vi.stubGlobal('fetch', fetcher);
    const result = await new HttpOfficePulseClient('http://officepulse:8080').listPbxExtensions(7);
    expect(String(fetcher.mock.calls[0]?.[0])).toBe(
      'http://officepulse:8080/v1/admin/pbx/extensions?iTenantId=7',
    );
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('refuses a response for another tenant', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => new Response(JSON.stringify({ source: 'asterisk', iTenantId: 8, queues: [] })),
      ),
    );
    await expect(
      new HttpOfficePulseClient('http://officepulse:8080').listPbxQueues(7),
    ).rejects.toThrow();
  });
});

describe('OfficePulse call availability', () => {
  it.each(['native_destination_unavailable', 'voice_unavailable'])(
    'retains an explicit %s refusal as a 503 response',
    async (error) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(JSON.stringify({ error }), { status: 503 })),
      );
      const client = new HttpOfficePulseClient('http://officepulse.private');
      expect(
        await client.submitCallCommand('call-1', {
          commandType: 'TAKEOVER',
          idempotencyKey: 'test-command',
        }),
      ).toEqual({ status: 503, body: { error } });
    },
  );
});
