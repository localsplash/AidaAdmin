import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { loadConfig, SERVICE_ENV_VARS } from '../src/config.js';
import { createDeps, type AppDeps } from '../src/deps.js';
import { createRepos } from '../src/nocodb/repos.js';
import { upgradeSchema } from '../src/nocodb/schema.js';
import { createLogger } from '../src/logger.js';
import { FakeNocoDbApi } from './helpers/fake-nocodb.js';

const logger = createLogger({ logLevel: 'fatal' });

interface CapturedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

let captured: CapturedCall[];
let upstreamResponse: () => Response | Promise<Response>;

interface Ctx {
  app: ReturnType<typeof createApp>;
  deps: AppDeps;
  tenantId: string;
  otherTenantId: string;
  superCookies: string[];
  superCsrf: string;
}

let ctx: Ctx;

beforeEach(async () => {
  captured = [];
  upstreamResponse = () =>
    new Response(JSON.stringify({ calls: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      captured.push({
        url: String(input),
        method: init?.method ?? 'GET',
        headers: Object.fromEntries(
          Object.entries((init?.headers ?? {}) as Record<string, string>),
        ),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return upstreamResponse();
    }),
  );

  const config = loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'fatal',
    AIDACONTROL_BASE_URL: 'https://aidacontrol.example.invalid',
  });
  const api = new FakeNocoDbApi();
  await upgradeSchema(api);
  const repos = createRepos(api);
  const deps: AppDeps = { ...createDeps(config), repos };
  const app = createApp(config, logger, deps);

  const tenant = await repos.tenants.create({
    name: 'Acme',
    slug: 'acme',
    asteriskContext: 'acme',
    enabled: true,
  });
  const other = await repos.tenants.create({
    name: 'Other',
    slug: 'other',
    asteriskContext: 'other',
    enabled: true,
  });

  const sid = await deps.sessionStore.create({
    iUserId: 1,
    email: null,
    displayName: 'Root',
    superAdmin: true,
    provider: null,
  });
  const session = await request(app)
    .get('/api/session')
    .set('Cookie', [`aida.sid=${sid}`]);
  const csrf = /aida\.csrf=([^;]+)/.exec(session.headers['set-cookie']?.[0] ?? '')?.[1] as string;

  ctx = {
    app,
    deps,
    tenantId: tenant.id as string,
    otherTenantId: other.id as string,
    superCookies: [`aida.sid=${sid}`, `aida.csrf=${csrf}`],
    superCsrf: csrf,
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function selectTenant(cookies: string[], csrf: string, tenantId: string) {
  return request(ctx.app)
    .post('/api/session/tenant')
    .set('Cookie', cookies)
    .set('x-csrf-token', csrf)
    .send({ tenantId });
}

async function memberSession(role: 'USER' | 'TENANT_ADMIN', enabled = true, iUserId = 7) {
  await ctx.deps.repos!.tenantUsers.save(ctx.tenantId, iUserId, role, enabled);
  const sid = await ctx.deps.sessionStore.create({
    iUserId,
    email: null,
    displayName: 'Member',
    superAdmin: false,
    provider: null,
  });
  const session = await request(ctx.app)
    .get('/api/session')
    .set('Cookie', [`aida.sid=${sid}`]);
  const csrf = /aida\.csrf=([^;]+)/.exec(session.headers['set-cookie']?.[0] ?? '')?.[1] as string;
  return { cookies: [`aida.sid=${sid}`, `aida.csrf=${csrf}`], csrf, sid };
}

describe('tenant selection', () => {
  it('lets a super admin select any enabled tenant', async () => {
    const res = await selectTenant(ctx.superCookies, ctx.superCsrf, ctx.tenantId);
    expect(res.status).toBe(200);
    expect(res.body.selectedTenant.role).toBe('SUPER_ADMIN');
    const session = await request(ctx.app).get('/api/session').set('Cookie', ctx.superCookies);
    expect(session.body.selectedTenant.slug).toBe('acme');
  });

  it('denies cross-tenant and disabled memberships before any proxying', async () => {
    const member = await memberSession('USER');
    const cross = await selectTenant(member.cookies, member.csrf, ctx.otherTenantId);
    expect(cross.status).toBe(403);

    const disabled = await memberSession('USER', false, 8);
    const denied = await selectTenant(disabled.cookies, disabled.csrf, ctx.tenantId);
    expect(denied.status).toBe(403);
    expect(captured).toHaveLength(0);
  });
});

describe('runtime proxy', () => {
  it('rejects unauthenticated and tenant-less sessions before proxying', async () => {
    const anon = await request(ctx.app).get('/runtime/calls');
    expect(anon.status).toBe(401);
    const noTenant = await request(ctx.app).get('/runtime/calls').set('Cookie', ctx.superCookies);
    expect(noTenant.status).toBe(403);
    expect(noTenant.body.error).toBe('tenant_not_selected');
    expect(captured).toHaveLength(0);
  });

  it('forwards with verified X-Aida context headers and never the session cookie value', async () => {
    await selectTenant(ctx.superCookies, ctx.superCsrf, ctx.tenantId);
    const res = await request(ctx.app)
      .get('/runtime/calls?state=active&evil=1')
      .set('Cookie', ctx.superCookies);
    expect(res.status).toBe(200);
    const call = captured[0]!;
    expect(call.url).toBe('https://aidacontrol.example.invalid/v1/calls?state=active');
    expect(call.headers['X-Aida-Identity-User-Id']).toBe('1');
    expect(call.headers['X-Aida-Tenant-Id']).toBe(ctx.tenantId);
    expect(call.headers['X-Aida-Role']).toBe('SUPER_ADMIN');
    expect(call.headers['X-Aida-Correlation-Id']).toBeTruthy();
    const sessionHeader = call.headers['X-Aida-Session-Id']!;
    expect(sessionHeader).toMatch(/^[0-9a-f]{64}$/);
    const rawSid = ctx.superCookies[0]!.replace('aida.sid=', '');
    expect(sessionHeader).not.toBe(rawSid);
    expect(JSON.stringify(call.headers)).not.toContain(rawSid);
  });

  it('ignores spoofed browser X-Aida headers', async () => {
    const member = await memberSession('USER');
    await selectTenant(member.cookies, member.csrf, ctx.tenantId);
    const res = await request(ctx.app)
      .get('/runtime/calls')
      .set('Cookie', member.cookies)
      .set('X-Aida-Role', 'SUPER_ADMIN')
      .set('X-Aida-Tenant-Id', ctx.otherTenantId)
      .set('X-Aida-Backdoor', 'yes');
    expect(res.status).toBe(200);
    const call = captured[0]!;
    expect(call.headers['X-Aida-Role']).toBe('USER');
    expect(call.headers['X-Aida-Tenant-Id']).toBe(ctx.tenantId);
    expect(call.headers['X-Aida-Backdoor']).toBeUndefined();
  });

  it('validates takeover commands and forwards only allowlisted types', async () => {
    await selectTenant(ctx.superCookies, ctx.superCsrf, ctx.tenantId);
    const bad = await request(ctx.app)
      .post('/runtime/calls/call-1/commands')
      .set('Cookie', ctx.superCookies)
      .set('x-csrf-token', ctx.superCsrf)
      .send({ commandType: 'HANGUP', expectedCallVersion: 3, idempotencyKey: 'k-12345678' });
    expect(bad.status).toBe(400);
    expect(captured).toHaveLength(0);

    const ok = await request(ctx.app)
      .post('/runtime/calls/call-1/commands')
      .set('Cookie', ctx.superCookies)
      .set('x-csrf-token', ctx.superCsrf)
      .send({ commandType: 'TAKEOVER', expectedCallVersion: 3, idempotencyKey: 'k-12345678' });
    expect(ok.status).toBe(200);
    expect(captured[0]!.url).toBe('https://aidacontrol.example.invalid/v1/calls/call-1/commands');
    expect(captured[0]!.body).toEqual({
      commandType: 'TAKEOVER',
      expectedCallVersion: 3,
      idempotencyKey: 'k-12345678',
    });
  });

  it('reports timeouts and unavailability safely', async () => {
    await selectTenant(ctx.superCookies, ctx.superCsrf, ctx.tenantId);
    upstreamResponse = () => {
      const err = new Error('timed out');
      err.name = 'TimeoutError';
      throw err;
    };
    const timeout = await request(ctx.app).get('/runtime/calls').set('Cookie', ctx.superCookies);
    expect(timeout.status).toBe(504);
    expect(timeout.body.error).toBe('aidacontrol_timeout');

    upstreamResponse = () => {
      throw new TypeError('fetch failed');
    };
    const down = await request(ctx.app).get('/runtime/calls').set('Cookie', ctx.superCookies);
    expect(down.status).toBe(502);
    expect(down.body.error).toBe('aidacontrol_unavailable');
  });

  it('relays upstream errors with a safe envelope', async () => {
    await selectTenant(ctx.superCookies, ctx.superCsrf, ctx.tenantId);
    upstreamResponse = () =>
      new Response(JSON.stringify({ error: 'call_not_found', internal: { stack: 'secret' } }), {
        status: 404,
      });
    const res = await request(ctx.app).get('/runtime/calls/nope').set('Cookie', ctx.superCookies);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('call_not_found');
    expect(res.body.internal).toBeUndefined();
  });

  it('proxies nothing outside the allowlist', async () => {
    await selectTenant(ctx.superCookies, ctx.superCsrf, ctx.tenantId);
    const res = await request(ctx.app)
      .get('/runtime/anything-else')
      .set('Cookie', ctx.superCookies);
    expect(res.status).toBe(404);
    expect(captured).toHaveLength(0);
  });
});

describe('trust configuration', () => {
  it('has no staff token or shared AidaControl secret', () => {
    expect(SERVICE_ENV_VARS.some((name) => name.includes('STAFF'))).toBe(false);
    expect(
      SERVICE_ENV_VARS.some((name) => name.startsWith('AIDACONTROL') && name.includes('SECRET')),
    ).toBe(false);
  });
});
