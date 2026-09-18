import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NocoDbError } from '../src/nocodb/api.js';
import { HttpOfficePulseClient, OfficePulseError } from '../src/officepulse/client.js';
import { DID as did, STORED_PROFILE, scopedApp } from './helpers/scoped-app.js';

const schedule = { timeRange: '09:00-17:00', weekdays: 'mon-fri', timezone: 'America/Los_Angeles' };
const base = '/admin/tenants/7';
let ctx: Awaited<ReturnType<typeof scopedApp>>;
beforeEach(async () => {
  ctx = await scopedApp();
});
const send: typeof ctx.send = (...args) => ctx.send(...args);
const snapshot = () => {
  if (!ctx.state.snapshot.active) throw new Error('fixture');
  return ctx.state.snapshot;
};

describe('native PBX authorization', () => {
  it('revalidates the central session and refuses revoked access before OfficePulse', async () => {
    expect((await send('get', `${base}/extensions`)).status).toBe(200);
    ctx.api.requests = [];
    ctx.state.snapshot = { active: false };
    expect((await send('post', `${base}/extensions`, { extension: '100' })).status).toBe(401);
    expect(ctx.identity.introspectSession).toHaveBeenCalledTimes(2);
    expect(ctx.api.requests).toEqual([]);
  });
  it.each([
    'extensions/100',
    'queues/other.sales',
    'queues/other.sales/members/100',
    `did-routes/${encodeURIComponent(did)}`,
    'profile-assignments/8d9e8b2c-0f0e-4a1b-9f7d-2f2c2c9c1a1b',
  ])('refuses another tenant for %s without an upstream request', async (path) => {
    expect((await send('delete', `/admin/tenants/8/${path}`)).status).toBe(403);
    expect(ctx.api.requests).toEqual([]);
  });
  it('checks role, enabled membership and the selected tenant even for Super Admin', async () => {
    snapshot().tenants[0]!.role = 'USER';
    expect((await send('get', `${base}/extensions`)).status).toBe(401);
    snapshot().user.superAdmin = true;
    snapshot().selectedTenantId = null;
    expect((await send('get', `${base}/extensions`)).status).toBe(403);
    snapshot().selectedTenantId = 7;
    expect((await send('get', `${base}/extensions`)).status).toBe(200);
    snapshot().tenants[0]!.bEnabled = false;
    expect((await send('get', `${base}/extensions`)).status).toBe(403);
  });
  it('sends the PlatformConfig context, never a tenant id, and strips trust headers', async () => {
    const res = await send('post', `${base}/extensions`, { extension: '100' })
      .set('X-Aida-Tenant-Id', '999')
      .set('X-Aida-Role', 'SUPER_ADMIN');
    expect(res.status).toBe(201);
    expect(ctx.api.requests[0]).toMatchObject({ method: 'extension.create', context: 'acme' });
    expect(JSON.stringify(ctx.api.requests)).not.toContain('iTenantId');
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
      ['put', '/queues/acme.sales/members/100'],
      ['put', `/did-routes/${did}`],
      ['put', '/profile-assignments'],
    ] as const) {
      const client = request(ctx.app);
      const response = await client[method](base + path)
        .set('Cookie', 'aida.sid=central-session')
        .send({});
      expect(response.status).toBe(403);
      expect(response.body.error).toBe('csrf_token_invalid');
    }
    expect(ctx.api.requests).toEqual([]);
  });
});

describe('context scope resolution', () => {
  it('defaults to the primary context and lists every authorized context with the PBX instance', async () => {
    const res = await send('get', `${base}/extensions`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      source: 'asterisk',
      pbxInstanceId: 'officepulse-test',
      context: 'acme',
      contexts: ['acme', 'acme-branch'],
      provisioningEnabled: true,
      extensions: [],
    });
    expect(res.body).not.toHaveProperty('iTenantId');
    expect(ctx.api.requests).toEqual([
      { method: 'extension.list', context: 'acme', correlationId: 'pbx-test-correlation' },
    ]);
  });
  it('lets a multi-context tenant select a non-primary context for reads and writes', async () => {
    const queue = await send('post', `${base}/queues?context=acme-branch`, { name: 'sales' });
    expect(queue.status).toBe(201);
    expect(queue.body.name).toBe('acme-branch.sales');
    const list = await send('get', `${base}/queues?context=acme-branch`);
    expect(list.body).toMatchObject({ context: 'acme-branch', contexts: ['acme', 'acme-branch'] });
    expect(list.body.queues.map((row: { name: string }) => row.name)).toEqual([
      'acme-branch.sales',
    ]);
    expect((await send('get', `${base}/queues`)).body.queues).toEqual([]);
    expect(ctx.api.requests.map((row) => row.context)).toEqual([
      'acme-branch',
      'acme-branch',
      'acme',
    ]);
  });
  it.each(['other-tenant', 'from-carrier', 'a,b', 'ACME'])(
    'refuses a browser-supplied context %s that is not assigned to the tenant',
    async (context) => {
      const res = await send('get', `${base}/extensions?context=${encodeURIComponent(context)}`);
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({
        error: 'context_forbidden',
        correlationId: 'pbx-test-correlation',
      });
      expect(
        (await send('post', `${base}/extensions?context=${context}`, { extension: '100' })).status,
      ).toBe(403);
      expect(ctx.api.requests).toEqual([]);
      expect(ctx.state.audits.map((row) => row.details?.outcome)).toEqual([
        'context_forbidden',
        'context_forbidden',
      ]);
    },
  );
  it('rejects a repeated or unknown query parameter before resolving scope', async () => {
    expect((await send('get', `${base}/extensions?context=acme&context=acme`)).status).toBe(400);
    expect((await send('get', `${base}/extensions?ctx=acme`)).status).toBe(400);
    expect(ctx.api.requests).toEqual([]);
  });
  it('answers 409 pbx_scope_missing until Tenants assigns a primary context', async () => {
    const profile = ctx.noco.tableByName('aida_tbl_TenantProfile')!.records[0]!;
    await ctx.noco.updateRecord(
      ctx.noco.tableByName('aida_tbl_TenantProfile')!.info.id,
      profile.Id!,
      {
        asterisk_context: '',
        additional_contexts: '',
      },
    );
    const res = await send('get', `${base}/extensions`);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      error: 'pbx_scope_missing',
      message: "Assign this tenant's Asterisk context in Tenants first",
    });
    expect(ctx.api.requests).toEqual([]);
    ctx.noco.tableByName('aida_tbl_TenantProfile')!.records = [];
    expect((await send('get', `${base}/queues`)).body.error).toBe('pbx_scope_missing');
  });
  it('resolves scope from the stored profile alone, never the Identity directory', async () => {
    ctx.identity.directoryRequest = async () => {
      throw new Error('directory down');
    };
    expect((await send('get', `${base}/extensions`)).status).toBe(200);
    expect((await send('get', `${base}/did-routes`)).status).toBe(200);
    expect((await send('get', `${base}/profile-assignments`)).body.contexts).toEqual([
      'acme',
      'acme-branch',
    ]);
  });
  it('answers 503 nocodb_unavailable, not an empty scope, when PlatformConfig cannot be read', async () => {
    ctx.noco.listRecords = async () => {
      throw new NocoDbError('NocoDB request one-time-sip-secret failed', 502);
    };
    for (const path of ['/extensions', '/queues', '/did-routes', '/profile-assignments']) {
      const res = await send('get', base + path);
      expect(res.status).toBe(503);
      expect(res.body).toMatchObject({
        error: 'nocodb_unavailable',
        message: 'The NocoDB PlatformConfig base is unavailable; retry when service returns',
      });
    }
    expect(
      (
        await send('put', `${base}/profile-assignments`, {
          context: 'acme',
          did: null,
          profileId: 'x',
        })
      ).body.error,
    ).toBe('nocodb_unavailable');
    expect(ctx.api.requests).toEqual([]);
    expect(ctx.state.logs).not.toContain('one-time-sip-secret');
  });
  it('names a missing tenant profile table instead of asking for a context assignment', async () => {
    ctx.noco.listTables = async () => [];
    const res = await send('get', `${base}/extensions`);
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({
      error: 'platform_config_unavailable',
      message: 'NocoDB table aida_tbl_TenantProfile does not exist (run upgrade)',
    });
    expect((await send('get', `${base}/profile-assignments`)).body.error).toBe(
      'platform_config_unavailable',
    );
    expect(ctx.api.requests).toEqual([]);
  });
  it('requires the PlatformConfig base to know any scope', async () => {
    ctx.deps.repos = null;
    const res = await send('get', `${base}/extensions`);
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('nocodb_not_configured');
    expect(ctx.api.requests).toEqual([]);
  });
  it('maps a mismatched context echo or a missing PBX instance to 502', async () => {
    const inventory = {
      source: 'asterisk',
      pbxInstanceId: 'officepulse-live',
      context: 'acme',
      provisioningEnabled: true,
      contexts: ['acme'],
      extensions: [],
    };
    const upstream = vi.fn();
    vi.stubGlobal('fetch', upstream);
    ctx.deps.officePulse = new HttpOfficePulseClient('https://pbx.invalid');
    upstream.mockResolvedValueOnce(new Response(JSON.stringify(inventory)));
    expect((await send('get', `${base}/extensions`)).body).toMatchObject({
      pbxInstanceId: 'officepulse-live',
      context: 'acme',
      contexts: ['acme', 'acme-branch'],
    });
    upstream.mockResolvedValueOnce(
      new Response(JSON.stringify({ ...inventory, context: 'acme-branch' })),
    );
    const echoed = await send('get', `${base}/extensions`);
    expect(echoed.status).toBe(502);
    expect(echoed.body.error).toBe('officepulse_failed');
    // JSON drops the undefined key, so the upstream body has no pbxInstanceId.
    upstream.mockResolvedValueOnce(
      new Response(JSON.stringify({ ...inventory, pbxInstanceId: undefined })),
    );
    expect((await send('get', `${base}/extensions`)).status).toBe(502);
    expect(upstream.mock.calls.every(([url]) => String(url).includes('context=acme'))).toBe(true);
    vi.unstubAllGlobals();
  });
  it('lists the instance contexts for Super Admins only', async () => {
    ctx.api.knownContexts = ['from-carrier', 'other'];
    expect((await send('get', '/admin/pbx/contexts')).status).toBe(403);
    snapshot().user.superAdmin = true;
    const res = await send('get', '/admin/pbx/contexts');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      source: 'asterisk',
      pbxInstanceId: 'officepulse-test',
      contexts: ['acme', 'from-carrier', 'other'],
    });
    expect(ctx.state.audits.at(-1)).toMatchObject({
      action: 'pbx.context.list',
      tenantId: null,
      details: { outcome: 'read', status: 200 },
    });
    ctx.deps.officePulse = null;
    expect((await send('get', '/admin/pbx/contexts')).body.error).toBe(
      'officepulse_not_configured',
    );
  });
  it('names the tenant PBX context in the session banner view', async () => {
    const res = await request(ctx.app)
      .get('/api/session')
      .set('Cookie', 'aida.sid=central-session');
    expect(res.body.selectedTenant).toMatchObject({ tenantId: '7', pbxContext: 'acme' });
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
      sipUsername: '100-acme',
      sipSecret: 'one-time-sip-secret',
      applyState: 'committed',
    });
    expect(res.headers['cache-control']).toBe('no-store');
    const list = await send('get', `${base}/extensions`);
    expect(list.body.extensions[0]).toMatchObject({ applyState: 'unknown', managed: true });
    expect(
      JSON.stringify({
        audits: ctx.state.audits,
        logs: ctx.state.logs,
        requests: ctx.api.requests,
        list: list.body,
        nocodb: ctx.noco.tableByName('aida_tbl_TenantProfile')!.records,
      }),
    ).not.toContain('one-time-sip-secret');
    expect(ctx.state.audits[0]).toMatchObject({
      actorIdentityUserId: 42,
      tenantId: '7',
      action: 'pbx.extension.create',
      entityId: '100',
      correlationId: 'pbx-test-correlation',
      details: { outcome: 'committed', status: 201 },
    });
    expect((await send('delete', `${base}/extensions/100`)).status).toBe(204);
    expect((await send('get', `${base}/extensions`)).body.extensions).toEqual([]);
    // No PBX desired state lands in PlatformConfig: only the tenant's scope row.
    expect(ctx.noco.tableByName('aida_tbl_TenantProfile')!.records).toMatchObject([STORED_PROFILE]);
  });
  it('sends minimal native membership changes and bounded controls', async () => {
    const queue = await send('post', `${base}/queues`, { name: 'sales', strategy: 'ringall' });
    expect(queue.body.name).toBe('acme.sales');
    expect(
      (await send('put', `${base}/queues/acme.sales/members/100`, { penalty: 3, paused: true }))
        .body,
    ).toMatchObject({ penalty: 3, paused: true, applyState: 'committed' });
    expect((await send('delete', `${base}/queues/acme.sales/members/100`)).status).toBe(204);
    expect((await send('delete', `${base}/queues/acme.sales`)).status).toBe(204);
    expect(ctx.api.requests.map((row) => row.method)).toEqual([
      'queue.create',
      'member.save',
      'member.delete',
      'queue.delete',
    ]);
    expect(ctx.api.requests.every((row) => row.context === 'acme' && !row.didContext)).toBe(true);
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
    expect(ctx.api.requests).toEqual([]);
  });
  it.each([
    { penalty: -1 },
    { penalty: 101 },
    { penalty: 1.5 },
    { paused: 'true' },
    { context: 'a,b' },
    { tenantId: '8' },
  ])('rejects invalid member settings %j', async (body) => {
    expect((await send('put', `${base}/queues/acme.sales/members/100`, body)).status).toBe(400);
    expect(ctx.api.requests).toEqual([]);
  });
  it.each([404, 409, 422, 503, 500])(
    'maps upstream %s to a safe error and audit outcome',
    async (status) => {
      ctx.api.failNext = status;
      const res = await send('delete', `${base}/queues/acme.sales`);
      expect(res.status).toBe(status === 500 ? 502 : status);
      expect(res.body.correlationId).toBe('pbx-test-correlation');
      expect(res.body.message).not.toContain('pbx down');
      expect(ctx.state.audits[0]!.details!.status).toBe(res.status);
      if (status === 409) expect(res.body.message).toContain('DID route');
    },
  );
  it('preserves a committed result when audit storage fails without logging credentials', async () => {
    ctx.deps.audit!.append = async () => {
      throw new Error('storage one-time-sip-secret');
    };
    expect((await send('post', `${base}/extensions`, { extension: '100' })).status).toBe(201);
    expect(ctx.state.logs).not.toContain('one-time-sip-secret');
    expect(ctx.state.logs).toContain('PBX audit persistence failed');
  });
  it('distinguishes disabled configuration from empty inventory', async () => {
    expect((await send('get', `${base}/queues`)).body.queues).toEqual([]);
    ctx.deps.officePulse = null;
    const response = await send('get', `${base}/queues`);
    expect(response.status).toBe(503);
    expect(response.body.error).toBe('officepulse_not_configured');
  });
});

describe('Identity-authorized managed DID settings', () => {
  it('passes the ingress context alongside the extension context on every DID request', async () => {
    const list = await send('get', `${base}/did-routes`);
    expect(list.status).toBe(200);
    expect(list.body).toMatchObject({
      pbxInstanceId: 'officepulse-test',
      context: 'acme',
      didContext: 'from-carrier',
      contexts: ['acme', 'acme-branch'],
    });
    expect(list.body).not.toHaveProperty('scope');
    expect(ctx.api.requests).toEqual([
      {
        method: 'did.list',
        context: 'acme',
        didContext: 'from-carrier',
        correlationId: 'pbx-test-correlation',
        body: { authorizedDids: [did] },
      },
    ]);
    await send('put', `${base}/did-routes/${did}`, { queue: 'acme.sales', ringsBeforeAi: 4 });
    await send('delete', `${base}/did-routes/${did}`);
    expect(
      ctx.api.requests
        .filter((row) => row.method !== 'did.list')
        .map((row) => [row.method, row.context, row.didContext]),
    ).toEqual([
      ['did.save', 'acme', 'from-carrier'],
      ['did.delete', 'acme', 'from-carrier'],
    ]);
  });
  it('answers 409 pbx_scope_missing for DID routes until an ingress context is assigned', async () => {
    const table = ctx.noco.tableByName('aida_tbl_TenantProfile')!;
    await ctx.noco.updateRecord(table.info.id, table.records[0]!.Id!, { did_context: null });
    for (const [method, path, body] of [
      ['get', '/did-routes', undefined],
      ['put', `/did-routes/${did}`, { queue: 'acme.sales', ringsBeforeAi: 4 }],
      ['delete', `/did-routes/${did}`, undefined],
    ] as const) {
      const res = await send(method, base + path, body);
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({
        error: 'pbx_scope_missing',
        message: "Assign this tenant's inbound DID context first",
      });
    }
    expect(ctx.api.requests).toEqual([]);
    expect((await send('get', `${base}/extensions`)).status).toBe(200);
  });
  it('normalizes schedule, reads saved settings and deletes only PBX routing', async () => {
    const res = await send('put', `${base}/did-routes/${encodeURIComponent(did)}`, {
      queue: 'acme.sales',
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
          queue: 'acme.sales',
          ringsBeforeAi: 12,
          schedule: null,
        })
      ).status,
    ).toBe(200);
    expect((await send('delete', `${base}/did-routes/${did}`)).status).toBe(204);
    expect(ctx.state.numbers).toHaveLength(1);
    expect(ctx.state.numbers[0]!.bEnabled).toBe(true);
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
          queue: 'acme.sales',
          ringsBeforeAi: 4,
          ...extra,
        })
      ).status,
    ).toBe(400);
    expect(ctx.api.requests).toEqual([]);
  });
  it('requires enabled Identity voice assignment and authorizes new Numbers dynamically', async () => {
    ctx.state.numbers[0]!.bEnabled = false;
    expect(
      (await send('put', `${base}/did-routes/${did}`, { queue: 'acme.sales', ringsBeforeAi: 4 }))
        .status,
    ).toBe(404);
    expect((await send('get', `${base}/did-routes`)).body.numbers).toEqual(ctx.state.numbers);
    ctx.state.numbers[0]!.bEnabled = true;
    ctx.api.dids.set('acme', []);
    const saved = await send('put', `${base}/did-routes/${did}`, {
      queue: 'acme.sales',
      ringsBeforeAi: 4,
    });
    expect(saved.status).toBe(200);
    expect(ctx.api.requests.find((row) => row.method === 'did.save')?.body).toMatchObject({
      authorizedDids: [did],
    });
  });
  it('refuses manual routes on save and delete', async () => {
    ctx.api.dids.set('acme', [
      { did, managed: false, availability: 'manual', applyState: 'unknown' },
    ]);
    expect(
      (await send('put', `${base}/did-routes/${did}`, { queue: 'acme.sales', ringsBeforeAi: 4 }))
        .status,
    ).toBe(409);
    expect((await send('delete', `${base}/did-routes/${did}`)).status).toBe(409);
    expect(ctx.api.requests.every((row) => row.method === 'did.list')).toBe(true);
  });
  it('left joins and dynamically authorizes every tenant assignment, including disabled numbers', async () => {
    const numbers = ctx.state.numbers;
    numbers.push(
      { ...numbers[0]!, iPhoneNumberId: 2, phoneNumber: '+15559870002' },
      { ...numbers[0]!, iPhoneNumberId: 3, phoneNumber: '+15559870003', bEnabled: false },
    );
    ctx.api.dids.set('acme', [
      { did, managed: false, availability: 'unconfigured', applyState: 'unknown' },
      { did, managed: false, availability: 'unconfigured', applyState: 'unknown' },
      { did: '+15559879999', managed: false, availability: 'manual', applyState: 'unknown' },
    ]);
    const res = await send('get', `${base}/did-routes`);
    expect(res.status).toBe(200);
    expect(res.body.numbers).toEqual(numbers);
    expect(res.body.dids).toEqual([
      { did, managed: false, availability: 'unconfigured', applyState: 'unknown' },
      {
        did: numbers[1]!.phoneNumber,
        managed: false,
        availability: 'unconfigured',
        applyState: 'unknown',
      },
      {
        did: numbers[2]!.phoneNumber,
        managed: false,
        availability: 'unconfigured',
        applyState: 'unknown',
      },
    ]);
    expect((await send('delete', `${base}/did-routes/${numbers[1]!.phoneNumber}`)).status).toBe(
      204,
    );
    expect(ctx.api.requests.find((entry) => entry.method === 'did.delete')?.body).toMatchObject({
      authorizedDids: [numbers[1]!.phoneNumber],
    });
  });
  it('keeps the canonical Numbers endpoint available when OfficePulse fails', async () => {
    snapshot().user.superAdmin = true;
    ctx.api.failNext = 503;
    expect((await send('get', `${base}/did-routes`)).status).toBe(503);
    const res = await send('get', `${base}/numbers`);
    expect(res.status).toBe(200);
    expect(res.body.numbers).toEqual(ctx.state.numbers);
    ctx.deps.officePulse = null;
    expect((await send('get', `${base}/did-routes`)).status).toBe(503);
    expect((await send('get', `${base}/numbers`)).body.numbers).toEqual(ctx.state.numbers);
  });
  it('does not relay upstream error details or failed Identity bodies', async () => {
    ctx.identity.listTenantNumbers = async () => {
      throw new OfficePulseError('SQL one-time-sip-secret');
    };
    expect((await send('get', `${base}/did-routes`)).status).toBe(503);
    expect(ctx.state.logs).not.toContain('one-time-sip-secret');
    expect(ctx.api.requests).toEqual([]);
  });
});
