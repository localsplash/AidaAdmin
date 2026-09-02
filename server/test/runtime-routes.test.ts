import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { loadConfig, SERVICE_ENV_VARS } from '../src/config.js';
import { createDeps, type AppDeps } from '../src/deps.js';
import { createRepos } from '../src/nocodb/repos.js';
import { upgradeSchema } from '../src/nocodb/schema.js';
import { createLogger } from '../src/logger.js';
import { presentCaller } from '../src/runtime/routes.js';
import { FakeNocoDbApi } from './helpers/fake-nocodb.js';
import { FakeOfficePulse } from './helpers/fake-officepulse.js';
import { FakeRuntimeReader, fakeSession } from './helpers/fake-runtime.js';

const logger = createLogger({ logLevel: 'fatal' });
const HOUR_MS = 60 * 60 * 1000;

interface Actor {
  cookies: string[];
  csrf: string;
  get: (path: string) => request.Test;
  post: (path: string, body: unknown) => request.Test;
}

interface Ctx {
  app: ReturnType<typeof createApp>;
  deps: AppDeps;
  api: FakeNocoDbApi;
  runtime: FakeRuntimeReader;
  officePulse: FakeOfficePulse;
  acme: { id: string; extensionId: string };
  other: { id: string };
}

let ctx: Ctx;

async function actor(
  iUserId: number,
  superAdmin: boolean,
  selectTenant: string | null,
): Promise<Actor> {
  const sid = await ctx.deps.sessionStore.create({
    iUserId,
    email: null,
    displayName: null,
    superAdmin,
    provider: null,
  });
  const session = await request(ctx.app)
    .get('/api/session')
    .set('Cookie', [`aida.sid=${sid}`]);
  const csrf = /aida\.csrf=([^;]+)/.exec(session.headers['set-cookie']?.[0] ?? '')?.[1] as string;
  const cookies = [`aida.sid=${sid}`, `aida.csrf=${csrf}`];
  const me: Actor = {
    cookies,
    csrf,
    get: (path) => request(ctx.app).get(path).set('Cookie', cookies),
    post: (path, body) =>
      request(ctx.app)
        .post(path)
        .set('Cookie', cookies)
        .set('x-csrf-token', csrf)
        .send(body as object),
  };
  if (selectTenant) {
    const selected = await me.post('/api/session/tenant', { tenantId: selectTenant });
    expect(selected.status).toBe(200);
  }
  return me;
}

beforeEach(async () => {
  const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'fatal' });
  const api = new FakeNocoDbApi();
  await upgradeSchema(api);
  const repos = createRepos(api);
  const runtime = new FakeRuntimeReader();
  const officePulse = new FakeOfficePulse();
  const deps: AppDeps = {
    ...createDeps(config),
    repos,
    runtimeReader: runtime,
    officePulse,
  };
  const app = createApp(config, logger, deps);

  const acme = await repos.tenants.create({
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
  const extension = await repos.extensions.create(acme.id as string, {
    extensionNumber: '100',
    displayName: 'Front Desk',
    asteriskContext: 'acme',
    enabled: true,
  });

  // Members: 20 administers Acme, 21 is Acme staff, 30 administers Other.
  await repos.tenantUsers.save(acme.id as string, 20, 'TENANT_ADMIN', true);
  await repos.tenantUsers.save(acme.id as string, 21, 'USER', true);
  await repos.tenantUsers.save(other.id as string, 30, 'TENANT_ADMIN', true);

  runtime.sessions = [
    fakeSession({
      id: 'acme-live',
      tenantId: acme.id as string,
      destinationId: extension.id as string,
    }),
    fakeSession({
      id: 'acme-done',
      tenantId: acme.id as string,
      state: 'hangup',
      endedAt: new Date().toISOString(),
    }),
    fakeSession({
      id: 'acme-lost',
      tenantId: acme.id as string,
      createdAt: new Date(Date.now() - 9 * HOUR_MS).toISOString(),
    }),
    fakeSession({ id: 'other-live', tenantId: other.id as string, callerNumber: '+15105559999' }),
  ];
  runtime.events.set('acme-live', [
    { sequenceNumber: 1, eventType: 'bootstrapped', payload: null, createdAt: 'x' },
    { sequenceNumber: 2, eventType: 'ringing', payload: null, createdAt: 'x' },
  ]);
  runtime.events.set('other-live', [
    {
      sequenceNumber: 1,
      eventType: 'fallback',
      payload: { reason: 'livekit-unavailable' },
      createdAt: 'x',
    },
  ]);
  runtime.commands.set('acme-live', [
    {
      idempotencyKey: 'k-acme',
      commandType: 'TAKEOVER',
      payload: null,
      status: 'failed',
      result: { error: 'no-answer' },
      createdAt: 'x',
      completedAt: 'x',
    },
  ]);
  runtime.participants.set('acme-lost', [
    { participantSid: 'PA_1', identity: 'agent-aida', kind: 'AGENT', joinedAt: 'x', leftAt: null },
  ]);
  runtime.dependencies = [
    { name: 'ari', ready: true, detail: null, changedAt: 'x' },
    { name: 'livekit', ready: false, detail: 'timeout', changedAt: 'x' },
  ];
  runtime.provisioning = [
    {
      requestId: 'r1',
      kind: 'EXTENSION',
      externalId: extension.id as string,
      action: 'create',
      status: 'created',
      createdAt: 'x',
    },
    {
      requestId: 'r2',
      kind: 'HANDSET',
      externalId: 'device-9',
      action: 'provision',
      status: 'provisioned',
      createdAt: 'x',
    },
  ];
  runtime.fallbacks = [
    {
      didRouteId: 'route-a',
      tenantId: acme.id as string,
      didE164: '+15105550100',
      destinationType: 'EXTENSION',
      destinationId: extension.id as string,
      enabled: true,
      updatedAt: 'x',
    },
    {
      didRouteId: 'route-o',
      tenantId: other.id as string,
      didE164: '+15105550200',
      destinationType: 'RING_GROUP',
      destinationId: 'rg-1',
      enabled: true,
      updatedAt: 'x',
    },
  ];

  ctx = {
    app,
    deps,
    api,
    runtime,
    officePulse,
    acme: { id: acme.id as string, extensionId: extension.id as string },
    other: { id: other.id as string },
  };
});

const ids = (calls: Array<{ id: string }>) => calls.map((c) => c.id).sort();

describe('access', () => {
  it('requires a session, then a selected tenant for anyone but a Super Admin', async () => {
    expect((await request(ctx.app).get('/runtime/calls')).status).toBe(401);
    // Someone with no tenant at all: a member of exactly one tenant is placed
    // in it automatically on sign-in, so they never see this state.
    const member = await actor(99, false, null);
    const res = await member.get('/runtime/calls');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('tenant_not_selected');
    const root = await actor(1, true, null);
    expect((await root.get('/runtime/calls')).status).toBe(200);
  });

  it('shows a tenant administrator only their own tenant, however they ask', async () => {
    const admin = await actor(20, false, ctx.acme.id);
    expect(ids((await admin.get('/runtime/calls?state=active')).body.calls)).toEqual(['acme-live']);
    // `tenant=all` is a Super Admin affordance; for anyone else it is ignored.
    expect(ids((await admin.get('/runtime/calls?state=active&tenant=all')).body.calls)).toEqual([
      'acme-live',
    ]);
    // Another tenant's call by id does not exist as far as they can tell.
    expect((await admin.get('/runtime/calls/other-live')).status).toBe(404);
    expect((await admin.get('/runtime/calls/other-live/events')).status).toBe(404);
    expect((await admin.get('/runtime/calls/acme-live')).status).toBe(200);
  });

  it('lets a Super Admin see every tenant, or one, and the diagnostics views', async () => {
    const root = await actor(1, true, null);
    expect(ids((await root.get('/runtime/calls?state=active&tenant=all')).body.calls)).toEqual([
      'acme-live',
      'other-live',
    ]);
    expect(
      ids((await root.get(`/runtime/calls?state=active&tenant=${ctx.acme.id}`)).body.calls),
    ).toEqual(['acme-live']);
    expect(ids((await root.get('/runtime/calls?state=orphaned')).body.calls)).toEqual([
      'acme-lost',
    ]);
    expect(ids((await root.get('/runtime/calls?state=recent')).body.calls)).toEqual(['acme-done']);
  });

  it('keeps orphans, dependencies, webhooks and unfiltered lists to Super Admin', async () => {
    const admin = await actor(20, false, ctx.acme.id);
    for (const path of [
      '/runtime/calls?state=orphaned',
      '/runtime/calls?state=all',
      '/runtime/dependencies',
      '/runtime/webhooks',
      '/runtime/orphans',
    ]) {
      expect((await admin.get(path)).status, path).toBe(403);
    }
    expect((await admin.post('/runtime/dependencies/test', {})).status).toBe(403);
    expect(ctx.officePulse.readinessProbes).toBe(0);
  });

  it('serves nothing else under /runtime', async () => {
    const root = await actor(1, true, null);
    expect((await root.get('/runtime/anything')).status).toBe(404);
  });
});

describe('caller presentation', () => {
  it('masks the caller for staff and shows it to administrators', () => {
    expect(presentCaller('+15105551234', 'USER')).toBe('•••1234');
    expect(presentCaller('12', 'USER')).toBe('•••');
    expect(presentCaller('+15105551234', 'TENANT_ADMIN')).toBe('+15105551234');
    expect(presentCaller('+15105551234', 'SUPER_ADMIN')).toBe('+15105551234');
    expect(presentCaller(null, 'USER')).toBeNull();
  });

  it('applies the mask on the wire', async () => {
    const staff = await actor(21, false, ctx.acme.id);
    const list = await staff.get('/runtime/calls?state=active');
    expect(list.body.calls[0].callerNumber).toBe('•••1234');
    const detail = await staff.get('/runtime/calls/acme-live');
    expect(detail.body.call.callerNumber).toBe('•••1234');
    const admin = await actor(20, false, ctx.acme.id);
    expect((await admin.get('/runtime/calls/acme-live')).body.call.callerNumber).toBe(
      '+15105551234',
    );
  });
});

describe('call detail', () => {
  it('returns the session with its timeline, commands and participants', async () => {
    const admin = await actor(20, false, ctx.acme.id);
    const res = await admin.get('/runtime/calls/acme-live');
    expect(res.body.call.config).toEqual({
      didRouteId: 'route-1',
      didRouteRevision: 3,
      profileId: 'profile-1',
      profileRevision: 2,
      tenantRevision: 1,
    });
    expect(res.body.events.map((e: { eventType: string }) => e.eventType)).toEqual([
      'bootstrapped',
      'ringing',
    ]);
    expect(res.body.commands[0]).toMatchObject({ commandType: 'TAKEOVER', status: 'failed' });
    expect(res.body.participants).toEqual([]);
    const since = await admin.get('/runtime/calls/acme-live/events?since=1');
    expect(since.body.events.map((e: { sequenceNumber: number }) => e.sequenceNumber)).toEqual([2]);
  });
});

describe('takeover', () => {
  it('sends exactly the allowlisted command to OfficePulse and audits it', async () => {
    const staff = await actor(21, false, ctx.acme.id);
    const res = await staff.post('/runtime/calls/acme-live/commands', {
      commandType: 'TAKEOVER',
      idempotencyKey: 'k-12345678',
      ringTimeoutSeconds: 30,
      // Must not travel: the destination is pinned on the call session.
      destinationId: 'ext-of-someone-else',
      destinationType: 'EXTENSION',
    });
    expect(res.status).toBe(202);
    expect(res.body.accepted).toBe(true);
    expect(res.body.status).toBe('ringing');
    expect(ctx.officePulse.commands).toEqual([
      {
        callSessionId: 'acme-live',
        body: { commandType: 'TAKEOVER', idempotencyKey: 'k-12345678', ringTimeoutSeconds: 30 },
      },
    ]);
    const audit = ctx.api.tableByName('audit_log')!.records;
    expect(audit.map((r) => r.action)).toEqual(['runtime.command']);
    expect(audit[0]!.tenant_id).toBe(ctx.acme.id);
    expect(audit[0]!.actor_identity_user_id).toBe(21);
  });

  it('refuses a command on another tenant call before anything is sent', async () => {
    const admin = await actor(20, false, ctx.acme.id);
    const res = await admin.post('/runtime/calls/other-live/commands', {
      commandType: 'TAKEOVER',
      idempotencyKey: 'k-12345678',
    });
    expect(res.status).toBe(404);
    expect(ctx.officePulse.commands).toHaveLength(0);
  });

  it('accepts only TAKEOVER', async () => {
    const admin = await actor(20, false, ctx.acme.id);
    const res = await admin.post('/runtime/calls/acme-live/commands', {
      commandType: 'GUIDE',
      idempotencyKey: 'k-12345678',
    });
    expect(res.status).toBe(400);
    expect(ctx.officePulse.commands).toHaveLength(0);
  });

  it('relays an OfficePulse refusal with only its safe fields', async () => {
    ctx.officePulse.commandOutcome = {
      status: 409,
      body: { error: 'takeover already in progress', stack: 'internal', duplicate: false },
    };
    const admin = await actor(20, false, ctx.acme.id);
    const res = await admin.post('/runtime/calls/acme-live/commands', {
      commandType: 'TAKEOVER',
      idempotencyKey: 'k-12345678',
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('takeover already in progress');
    expect(res.body.stack).toBeUndefined();
  });

  it('reports a replayed command as a duplicate, not a second takeover', async () => {
    ctx.officePulse.commandOutcome = { status: 200, body: { status: 'answered', duplicate: true } };
    const admin = await actor(20, false, ctx.acme.id);
    const res = await admin.post('/runtime/calls/acme-live/commands', {
      commandType: 'TAKEOVER',
      idempotencyKey: 'k-12345678',
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ accepted: false, duplicate: true, status: 'answered' });
  });
});

describe('degraded states', () => {
  it('names the variable when the runtime database is not configured', async () => {
    ctx.deps.runtimeReader = null;
    const root = await actor(1, true, null);
    const res = await root.get('/runtime/calls');
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('runtime_db_not_configured');
    expect(res.body.missingConfiguration).toEqual(['OFFICEPULSE_RUNTIME_DATABASE_URL']);
    // A tenant admin cannot take over on trust without it; a Super Admin can.
    const admin = await actor(20, false, ctx.acme.id);
    const denied = await admin.post('/runtime/calls/acme-live/commands', {
      commandType: 'TAKEOVER',
      idempotencyKey: 'k-12345678',
    });
    expect(denied.status).toBe(503);
    expect(ctx.officePulse.commands).toHaveLength(0);
  });

  it('answers 502 when the runtime database is unreachable', async () => {
    ctx.runtime.down = true;
    const root = await actor(1, true, null);
    const res = await root.get('/runtime/calls');
    expect(res.status).toBe(502);
    expect(res.body.error).toBe('runtime_db_unavailable');
    expect(JSON.stringify(res.body)).not.toContain('ECONNREFUSED');
  });

  it('answers 502 when OfficePulse is down and 503 when it is not configured', async () => {
    const admin = await actor(20, false, ctx.acme.id);
    ctx.officePulse.failNext = true;
    const down = await admin.post('/runtime/calls/acme-live/commands', {
      commandType: 'TAKEOVER',
      idempotencyKey: 'k-12345678',
    });
    expect(down.status).toBe(502);
    expect(down.body.error).toBe('officepulse_unavailable');

    ctx.deps.officePulse = null;
    const unconfigured = await admin.post('/runtime/calls/acme-live/commands', {
      commandType: 'TAKEOVER',
      idempotencyKey: 'k-12345678',
    });
    expect(unconfigured.status).toBe(503);
    expect(unconfigured.body.missingConfiguration).toEqual(['OFFICEPULSE_PROVISIONING_BASE_URL']);
  });
});

describe('issues', () => {
  it('scopes failed commands and failure events to the tenant', async () => {
    const admin = await actor(20, false, ctx.acme.id);
    const res = await admin.get('/runtime/issues');
    expect(res.body.failedCommands.map((c: { callSessionId: string }) => c.callSessionId)).toEqual([
      'acme-live',
    ]);
    // The other tenant's fallback is invisible; dependencies are platform-wide
    // and therefore Super Admin.
    expect(res.body.events).toEqual([]);
    expect(res.body.dependenciesDown).toEqual([]);

    const root = await actor(1, true, null);
    const all = await root.get('/runtime/issues');
    expect(all.body.events.map((e: { callSessionId: string }) => e.callSessionId)).toEqual([
      'other-live',
    ]);
    expect(all.body.dependenciesDown.map((d: { name: string }) => d.name)).toEqual(['livekit']);
  });
});

describe('dependencies', () => {
  it('pairs the recorded history with a live probe and audits an explicit test', async () => {
    const root = await actor(1, true, null);
    const res = await root.get('/runtime/dependencies');
    expect(res.body.recorded.map((d: { name: string }) => d.name)).toEqual(['ari', 'livekit']);
    expect(res.body.live.reachable).toBe(true);

    const probe = await root.post('/runtime/dependencies/test', {});
    expect(probe.status).toBe(200);
    expect(ctx.officePulse.readinessProbes).toBe(2);
    expect(ctx.api.tableByName('audit_log')!.records.map((r) => r.action)).toEqual([
      'runtime.dependency_test',
    ]);
  });
});

describe('provisioning history and retry', () => {
  it('shows a tenant administrator only operations on their own records', async () => {
    const admin = await actor(20, false, ctx.acme.id);
    const res = await admin.get('/runtime/provisioning');
    expect(res.body.operations.map((o: { requestId: string }) => o.requestId)).toEqual(['r1']);
    const root = await actor(1, true, null);
    expect((await root.get('/runtime/provisioning')).body.operations).toHaveLength(2);
    const staff = await actor(21, false, ctx.acme.id);
    expect((await staff.get('/runtime/provisioning')).status).toBe(403);
  });

  it('retries with the idempotent update, never a create that would mint a secret', async () => {
    const admin = await actor(20, false, ctx.acme.id);
    const res = await admin.post('/runtime/provisioning/retry', {
      kind: 'EXTENSION',
      externalId: ctx.acme.extensionId,
    });
    expect(res.status).toBe(200);
    expect(ctx.officePulse.updated).toEqual([
      {
        extensionId: ctx.acme.extensionId,
        body: {
          extensionNumber: '100',
          context: 'acme',
          displayName: 'Front Desk',
          callerIdName: null,
          callerIdNumber: null,
          provisioningProfile: null,
          enabled: true,
        },
      },
    ]);
    expect(ctx.officePulse.provisioned).toHaveLength(0);
    expect(ctx.api.tableByName('audit_log')!.records.map((r) => r.action)).toEqual([
      'runtime.reprovision',
    ]);
  });

  it('will not retry another tenant record', async () => {
    const otherAdmin = await actor(30, false, ctx.other.id);
    const res = await otherAdmin.post('/runtime/provisioning/retry', {
      kind: 'EXTENSION',
      externalId: ctx.acme.extensionId,
    });
    expect(res.status).toBe(404);
    expect(ctx.officePulse.updated).toHaveLength(0);
  });
});

describe('fallbacks and orphans', () => {
  it('scopes DID fail-safes to the tenant', async () => {
    const admin = await actor(20, false, ctx.acme.id);
    const res = await admin.get('/runtime/fallbacks');
    expect(res.body.fallbacks.map((f: { didRouteId: string }) => f.didRouteId)).toEqual([
      'route-a',
    ]);
    const root = await actor(1, true, null);
    expect((await root.get('/runtime/fallbacks?tenant=all')).body.fallbacks).toHaveLength(2);
  });

  it('lists lost calls with whoever is still marked present, and offers no cleanup', async () => {
    const root = await actor(1, true, null);
    const res = await root.get('/runtime/orphans');
    expect(res.body.orphans).toHaveLength(1);
    expect(res.body.orphans[0].call.id).toBe('acme-lost');
    expect(res.body.orphans[0].participantsPresent.map((p: { kind: string }) => p.kind)).toEqual([
      'AGENT',
    ]);
    expect((await root.post('/runtime/orphans/cleanup', {})).status).toBe(404);
  });
});

describe('trust configuration', () => {
  it('has no AidaControl and no shared secret in the environment surface', () => {
    expect(SERVICE_ENV_VARS.some((name) => name.includes('AIDACONTROL'))).toBe(false);
    expect(SERVICE_ENV_VARS.some((name) => name.includes('STAFF'))).toBe(false);
  });
});
