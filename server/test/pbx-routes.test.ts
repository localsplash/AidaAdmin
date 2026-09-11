import { Writable } from 'node:stream';
import request from 'supertest';
import { pino } from 'pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { createDeps, type AppDeps } from '../src/deps.js';
import { loadConfig } from '../src/config.js';
import { IdentitySessionRepository } from '../src/auth/session-store.js';
import { HttpIdClient, type PlatformNumber, type SessionIntrospection } from '../src/id/client.js';
import { REDACT_PATHS } from '../src/logger.js';
import type { AuditEntry } from '../src/nocodb/repos.js';
import { OfficePulseError } from '../src/officepulse/client.js';
import { FakeOfficePulse } from './helpers/fake-officepulse.js';

const did = '+15559870001';
const schedule = { timeRange: '09:00-17:00', weekdays: 'mon-fri', timezone: 'America/Los_Angeles' };
let snapshot: SessionIntrospection;
let numbers: PlatformNumber[];
let api: FakeOfficePulse;
let deps: AppDeps;
let app: ReturnType<typeof createApp>;
let audits: AuditEntry[];
let logs: string;
let identity: HttpIdClient;
const base = '/admin/tenants/7';
function send(method: 'get' | 'post' | 'put' | 'delete', path: string, body?: object) {
  const client = request(app);
  const call = client[method](path)
    .set('Cookie', ['aida.sid=central-session', 'aida.csrf=csrf-proof'])
    .set('x-csrf-token', 'csrf-proof')
    .set('x-correlation-id', 'pbx-test-correlation');
  return body === undefined ? call : call.send(body);
}
beforeEach(() => {
  snapshot = {
    active: true,
    user: { iUserId: 42, email: null, displayName: 'Admin', superAdmin: false },
    tenants: [{ iTenantId: 7, name: 'Acme', slug: 'acme', role: 'TENANT_ADMIN', bEnabled: true }],
    selectedTenantId: 7,
  };
  numbers = [
    {
      iPhoneNumberId: 1,
      iTenantId: 7,
      phoneNumber: did,
      label: 'Main',
      bVoice: true,
      bMessaging: true,
      bEnabled: true,
      accessPolicy: 'TENANT_MEMBERS',
      iVersion: 1,
    },
  ];
  identity = new HttpIdClient('https://id.invalid');
  identity.introspectSession = vi.fn(async () => snapshot);
  identity.listTenantNumbers = vi.fn(async () => ({ numbers }));
  api = new FakeOfficePulse();
  api.dids.set(7, [{ did, managed: false, availability: 'unconfigured', applyState: 'unknown' }]);
  audits = [];
  logs = '';
  const logger = pino(
    { level: 'info', redact: { paths: REDACT_PATHS, censor: '[REDACTED]' } },
    new Writable({
      write(chunk, _encoding, callback) {
        logs += String(chunk);
        callback();
      },
    }),
  );
  const config = loadConfig({ NODE_ENV: 'test' });
  deps = {
    ...createDeps(config),
    sessionStore: new IdentitySessionRepository(identity),
    idClient: identity,
    officePulse: api,
    audit: {
      append: async (entry) => {
        audits.push(entry);
      },
    },
  };
  app = createApp(config, logger, deps);
});

describe('native PBX authorization', () => {
  it('revalidates the central session and refuses revoked access before OfficePulse', async () => {
    expect((await send('get', `${base}/extensions`)).status).toBe(200);
    api.requests = [];
    snapshot = { active: false };
    expect((await send('post', `${base}/extensions`, { extension: '100' })).status).toBe(401);
    expect(identity.introspectSession).toHaveBeenCalledTimes(2);
    expect(api.requests).toEqual([]);
  });
  it.each([
    'extensions/100',
    'queues/t8.sales',
    'queues/t8.sales/members/100',
    `did-routes/${encodeURIComponent(did)}`,
  ])('refuses another tenant for %s without an upstream request', async (path) => {
    expect((await send('delete', `/admin/tenants/8/${path}`)).status).toBe(403);
    expect(api.requests).toEqual([]);
  });
  it('checks role, enabled membership and the selected tenant even for Super Admin', async () => {
    if (!snapshot.active) throw Error('fixture');
    snapshot.tenants[0]!.role = 'USER';
    expect((await send('get', `${base}/extensions`)).status).toBe(401);
    snapshot.user.superAdmin = true;
    snapshot.selectedTenantId = null;
    expect((await send('get', `${base}/extensions`)).status).toBe(403);
    snapshot.selectedTenantId = 7;
    expect((await send('get', `${base}/extensions`)).status).toBe(200);
    snapshot.tenants[0]!.bEnabled = false;
    expect((await send('get', `${base}/extensions`)).status).toBe(403);
  });
  it('uses only the numeric tenant resolved by Identity and strips trust headers', async () => {
    const res = await send('post', `${base}/extensions`, { extension: '100' })
      .set('X-Aida-Tenant-Id', '999')
      .set('X-Aida-Role', 'SUPER_ADMIN');
    expect(res.status).toBe(201);
    expect(api.requests[0]!.tenantId).toBe(7);
    expect(
      (await send('post', `${base}/extensions`, { extension: '101', iTenantId: 999 })).status,
    ).toBe(400);
    expect((await send('get', `${base}/extensions?iTenantId=999`)).status).toBe(400);
    expect((await send('get', '/admin/tenants/007/extensions')).status).toBe(403);
  });
  it('requires CSRF for every mutation', async () => {
    for (const [method, path] of [
      ['post', '/extensions'],
      ['delete', '/extensions/100'],
      ['post', '/queues'],
      ['put', '/queues/t7.sales/members/100'],
      ['put', `/did-routes/${did}`],
    ] as const) {
      const client = request(app);
      const response = await client[method](base + path)
        .set('Cookie', 'aida.sid=central-session')
        .send({});
      expect(response.status).toBe(403);
      expect(response.body.error).toBe('csrf_token_invalid');
    }
    expect(api.requests).toEqual([]);
  });
});

describe('native PBX writes and credential safety', () => {
  it('discloses a secret once without persisting it in logs, audit or inventory', async () => {
    const res = await send('post', `${base}/extensions`, {
      extension: '100',
      displayName: 'Front Desk',
    });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      extension: '100',
      sipUsername: '100-t7',
      sipSecret: 'one-time-sip-secret',
      applyState: 'committed',
    });
    expect(res.headers['cache-control']).toBe('no-store');
    const list = await send('get', `${base}/extensions`);
    expect(list.body.extensions[0].applyState).toBe('unknown');
    expect(JSON.stringify({ audits, logs, requests: api.requests, list: list.body })).not.toContain(
      'one-time-sip-secret',
    );
    expect(audits[0]).toMatchObject({
      actorIdentityUserId: 42,
      tenantId: '7',
      action: 'pbx.extension.create',
      entityId: '100',
      correlationId: 'pbx-test-correlation',
      details: { outcome: 'committed', status: 201 },
    });
    expect((await send('delete', `${base}/extensions/100`)).status).toBe(204);
    expect((await send('get', `${base}/extensions`)).body.extensions).toEqual([]);
    expect(deps.repos).toBeNull();
  });
  it('sends minimal native membership changes and bounded controls', async () => {
    const queue = await send('post', `${base}/queues`, { name: 'sales', strategy: 'ringall' });
    expect(queue.body.name).toBe('t7.sales');
    expect(
      (await send('put', `${base}/queues/t7.sales/members/100`, { penalty: 3, paused: true })).body,
    ).toMatchObject({ penalty: 3, paused: true, applyState: 'committed' });
    expect((await send('delete', `${base}/queues/t7.sales/members/100`)).status).toBe(204);
    expect((await send('delete', `${base}/queues/t7.sales`)).status).toBe(204);
    expect(api.requests.map((row) => row.method)).toEqual([
      'queue.create',
      'member.save',
      'member.delete',
      'queue.delete',
    ]);
  });
  it.each([
    ['/extensions', { extension: '1' }],
    ['/extensions', { extension: '100', displayName: 'bad\nname' }],
    ['/extensions', { extension: '100', callerIdNumber: '555' }],
    [
      '/extensions',
      { extension: '100', displayName: 'x'.repeat(25), callerIdNumber: '+19496501147' },
    ],
    ['/extensions', { extension: '100', role: 'SUPER_ADMIN' }],
    ['/queues', { name: 'sales', strategy: 'retell' }],
    ['/queues', { name: 'bad/name' }],
  ])('validates %s before upstream', async (path, body) => {
    expect((await send('post', base + path, body)).status).toBe(400);
    expect(api.requests).toEqual([]);
  });
  it.each([
    { penalty: -1 },
    { penalty: 101 },
    { penalty: 1.5 },
    { paused: 'true' },
    { context: 'a,b' },
    { tenantId: '8' },
  ])('rejects invalid member settings %j', async (body) => {
    expect((await send('put', `${base}/queues/t7.sales/members/100`, body)).status).toBe(400);
    expect(api.requests).toEqual([]);
  });
  it.each([404, 409, 422, 503, 500])(
    'maps upstream %s to a safe error and audit outcome',
    async (status) => {
      api.failNext = status;
      const res = await send('delete', `${base}/queues/t7.sales`);
      expect(res.status).toBe(status === 500 ? 502 : status);
      expect(res.body.correlationId).toBe('pbx-test-correlation');
      expect(res.body.message).not.toContain('pbx down');
      expect(audits[0]!.details!.status).toBe(res.status);
      if (status === 409) expect(res.body.message).toContain('DID route');
    },
  );
  it('preserves a committed result when audit storage fails without logging credentials', async () => {
    deps.audit!.append = async () => {
      throw new Error('storage one-time-sip-secret');
    };
    expect((await send('post', `${base}/extensions`, { extension: '100' })).status).toBe(201);
    expect(logs).not.toContain('one-time-sip-secret');
    expect(logs).toContain('PBX audit persistence failed');
  });
  it('distinguishes disabled configuration from empty inventory', async () => {
    expect((await send('get', `${base}/queues`)).body.queues).toEqual([]);
    deps.officePulse = null;
    const response = await send('get', `${base}/queues`);
    expect(response.status).toBe(503);
    expect(response.body.error).toBe('officepulse_not_configured');
  });
});

describe('Identity-authorized managed DID settings', () => {
  it('normalizes schedule, reads saved settings and deletes only PBX routing', async () => {
    const res = await send('put', `${base}/did-routes/${encodeURIComponent(did)}`, {
      queue: 't7.sales',
      ringsBeforeAi: 4,
      schedule,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      managed: true,
      ringTimeoutSeconds: 20,
      livekitDestination: did,
      schedule: { weekdays: 'mon&tue&wed&thu&fri' },
      applyState: 'committed',
    });
    expect((await send('get', `${base}/did-routes`)).body.dids[0]).toEqual(res.body);
    expect(
      (
        await send('put', `${base}/did-routes/${did}`, {
          queue: 't7.sales',
          ringsBeforeAi: 12,
          schedule: null,
        })
      ).status,
    ).toBe(200);
    expect((await send('delete', `${base}/did-routes/${did}`)).status).toBe(204);
    expect(numbers).toHaveLength(1);
    expect(numbers[0]!.bEnabled).toBe(true);
  });
  it.each([
    { ringsBeforeAi: 0 },
    { ringsBeforeAi: 13 },
    { provider: 'livekit' },
    { aiDestination: did },
    { schedule: { ...schedule, timezone: undefined } },
    { schedule: { ...schedule, timezone: 'EST5EDT' } },
    { schedule: { ...schedule, timezone: 'Mars/Base' } },
    { schedule: { ...schedule, weekdays: '' } },
    { schedule: { ...schedule, weekdays: 'mon,fri' } },
    { schedule: { ...schedule, timeRange: '24:00-17:00' } },
  ])('rejects invalid DID input %j before consulting upstream', async (extra) => {
    expect(
      (
        await send('put', `${base}/did-routes/${did}`, {
          queue: 't7.sales',
          ringsBeforeAi: 4,
          ...extra,
        })
      ).status,
    ).toBe(400);
    expect(api.requests).toEqual([]);
  });
  it('requires enabled Identity voice assignment and OfficePulse tenant scope', async () => {
    numbers[0]!.bEnabled = false;
    expect(
      (await send('put', `${base}/did-routes/${did}`, { queue: 't7.sales', ringsBeforeAi: 4 }))
        .status,
    ).toBe(404);
    expect((await send('get', `${base}/did-routes`)).body.dids).toEqual([]);
    numbers[0]!.bEnabled = true;
    api.dids.set(7, []);
    expect(
      (await send('put', `${base}/did-routes/${did}`, { queue: 't7.sales', ringsBeforeAi: 4 }))
        .status,
    ).toBe(404);
    expect(api.requests.some((row) => row.method === 'did.save')).toBe(false);
  });
  it('refuses manual routes on save and delete', async () => {
    api.dids.set(7, [{ did, managed: false, availability: 'manual', applyState: 'unknown' }]);
    expect(
      (await send('put', `${base}/did-routes/${did}`, { queue: 't7.sales', ringsBeforeAi: 4 }))
        .status,
    ).toBe(409);
    expect((await send('delete', `${base}/did-routes/${did}`)).status).toBe(409);
    expect(api.requests.every((row) => row.method === 'did.list')).toBe(true);
  });
  it('does not relay upstream error details or failed Identity bodies', async () => {
    identity.listTenantNumbers = async () => {
      throw new OfficePulseError('SQL one-time-sip-secret');
    };
    expect((await send('get', `${base}/did-routes`)).status).toBe(503);
    expect(logs).not.toContain('one-time-sip-secret');
    expect(api.requests).toEqual([]);
  });
});
