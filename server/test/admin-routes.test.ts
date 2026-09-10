import { seedLegacyDirectory } from './helpers/legacy-schema.js';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createDeps, type AppDeps } from '../src/deps.js';
import type { DirectoryUser, IdClient, IdEvent, IdRedeemResult } from '../src/id/client.js';
import { createRepos } from './helpers/legacy-repos.js';
import { upgradeSchema } from '../src/nocodb/schema.js';
import type {
  HandsetEnrollmentDelivery,
  HandsetProvisioningDelivery,
} from '../src/provisioning/handset-delivery.js';
import { createLogger } from '../src/logger.js';
import { FakeOfficePulse } from './helpers/fake-officepulse.js';
import { FakeNocoDbApi } from './helpers/fake-nocodb.js';

const logger = createLogger({ logLevel: 'fatal' });

class FakeHandsetDelivery implements HandsetProvisioningDelivery {
  deliveries: HandsetEnrollmentDelivery[] = [];
  async deliver(payload: HandsetEnrollmentDelivery) {
    this.deliveries.push(payload);
  }
}

class FakeDirectoryIdClient implements IdClient {
  users: DirectoryUser[] = [
    { iUserId: 42, email: 'pat@example.invalid', displayName: 'Pat', claimed: true },
  ];

  async redeemCode(): Promise<IdRedeemResult> {
    throw new Error('unused');
  }
  async listEvents(): Promise<IdEvent[]> {
    return [];
  }
  async registerWebhook(): Promise<void> {}
  async ensureDirectoryUser(email: string, displayName?: string | null): Promise<DirectoryUser> {
    const existing = this.users.find((u) => u.email === email);
    if (existing) return existing;
    const user = {
      iUserId: 100 + this.users.length,
      email,
      displayName: displayName ?? null,
      claimed: false,
    };
    this.users.push(user);
    return user;
  }
  async getDirectoryUser(iUserId: number): Promise<DirectoryUser | null> {
    return this.users.find((u) => u.iUserId === iUserId) ?? null;
  }
  async searchDirectoryUsers(query: string): Promise<DirectoryUser[]> {
    return this.users.filter((u) => (u.email ?? '').includes(query));
  }
}

interface Ctx {
  app: ReturnType<typeof createApp>;
  deps: AppDeps;
  api: FakeNocoDbApi;
  officePulse: FakeOfficePulse;
  handset: FakeHandsetDelivery;
  cookies: string[];
  csrf: string;
}

let ctx: Ctx;

beforeEach(async () => {
  const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'fatal' });
  const api = new FakeNocoDbApi();
  await upgradeSchema(api);
  await seedLegacyDirectory(api);
  const officePulse = new FakeOfficePulse();
  const handset = new FakeHandsetDelivery();
  const deps: AppDeps = {
    ...createDeps(config),
    repos: createRepos(api),
    officePulse,
    handsetDelivery: handset,
    idClient: new FakeDirectoryIdClient(),
  };
  const app = createApp(config, logger, deps);
  const sid = await deps.sessionStore.create({
    iUserId: 1,
    email: 'root@example.invalid',
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
    api,
    officePulse,
    handset,
    cookies: [`aida.sid=${sid}`, `aida.csrf=${csrf}`],
    csrf,
  };
});

function post(path: string, body: unknown) {
  return request(ctx.app)
    .post(path)
    .set('Cookie', ctx.cookies)
    .set('x-csrf-token', ctx.csrf)
    .send(body as object);
}

function put(path: string, body: unknown) {
  return request(ctx.app)
    .put(path)
    .set('Cookie', ctx.cookies)
    .set('x-csrf-token', ctx.csrf)
    .send(body as object);
}

async function createTenant(slug = 'acme') {
  const res = await post('/admin/tenants', {
    name: 'Acme',
    slug,
    asteriskContext: slug,
    enabled: true,
  });
  expect(res.status).toBe(201);
  return res.body.tenant as { id: string; revision: number };
}

/** A signed-in non-super-admin, optionally holding a role in one tenant. */
async function memberSession(
  iUserId: number,
  membership?: { tenantId: string; role: 'TENANT_ADMIN' | 'USER' },
) {
  if (membership) {
    await ctx.deps.repos!.tenantUsers.save(membership.tenantId, iUserId, membership.role, true);
  }
  const sid = await ctx.deps.sessionStore.create({
    iUserId,
    email: null,
    displayName: null,
    superAdmin: false,
    provider: null,
  });
  const session = await request(ctx.app)
    .get('/api/session')
    .set('Cookie', [`aida.sid=${sid}`]);
  const csrf = /aida\.csrf=([^;]+)/.exec(session.headers['set-cookie']?.[0] ?? '')?.[1] as string;
  const cookies = [`aida.sid=${sid}`, `aida.csrf=${csrf}`];
  return {
    cookies,
    get: (path: string) => request(ctx.app).get(path).set('Cookie', cookies),
    put: (path: string, body: unknown) =>
      request(ctx.app)
        .put(path)
        .set('Cookie', cookies)
        .set('x-csrf-token', csrf)
        .send(body as object),
    post: (path: string, body: unknown) =>
      request(ctx.app)
        .post(path)
        .set('Cookie', cookies)
        .set('x-csrf-token', csrf)
        .send(body as object),
  };
}

describe('authorization', () => {
  it('requires a session', async () => {
    const res = await request(ctx.app).get('/admin/tenants');
    expect(res.status).toBe(401);
  });

  it('shows a plain member no tenants and refuses platform-wide actions', async () => {
    const tenant = await createTenant();
    const member = await memberSession(2, { tenantId: tenant.id, role: 'USER' });

    // Tenant administration is a Super Admin surface.
    const list = await member.get('/admin/tenants');
    expect(list.status).toBe(403);

    // A USER membership is not an administrative role in their own tenant.
    expect((await member.get(`/admin/tenants/${tenant.id}/extensions`)).status).toBe(403);
    expect(
      (
        await member.post('/admin/tenants', {
          name: 'X',
          slug: 'x',
          asteriskContext: 'x',
          enabled: true,
        })
      ).status,
    ).toBe(403);
  });

  it('lets a tenant admin administer only their own tenant', async () => {
    const mine = await createTenant('mine');
    const theirs = await createTenant('theirs');
    const admin = await memberSession(3, { tenantId: mine.id, role: 'TENANT_ADMIN' });

    const list = await admin.get('/admin/tenants');
    expect(list.status).toBe(403);

    expect((await admin.get(`/admin/tenants/${mine.id}/profiles`)).status).toBe(200);

    expect((await admin.get(`/admin/tenants/${mine.id}/appearance`)).status).toBe(200);

    // Another tenant is refused whether it is named in the path or the body.
    expect((await admin.get(`/admin/tenants/${theirs.id}/extensions`)).status).toBe(403);
    const crossTenant = await admin.post('/admin/extensions', {
      tenantId: theirs.id,
      extensionNumber: '100',
      displayName: 'Nope',
      enabled: true,
    });
    expect(crossTenant.status).toBe(404);
    expect(ctx.api.tableByName('aida_tbl_Extension')!.records).toHaveLength(0);
  });

  it('keeps platform-wide actions to Super Admin', async () => {
    const tenant = await createTenant();
    const admin = await memberSession(4, { tenantId: tenant.id, role: 'TENANT_ADMIN' });
    expect((await admin.put('/admin/super-admins/42', { enabled: true })).status).toBe(403);
    expect(
      (
        await admin.post('/admin/tenants', {
          name: 'X',
          slug: 'x',
          asteriskContext: 'x',
          enabled: true,
        })
      ).status,
    ).toBe(403);
  });

  it('stops a tenant admin removing their own administrator access', async () => {
    const tenant = await createTenant();
    // 42 is a user the fake central directory knows, so the mapping is valid.
    const admin = await memberSession(42, { tenantId: tenant.id, role: 'TENANT_ADMIN' });
    const demote = await admin.put(`/admin/tenants/${tenant.id}/users/42`, {
      role: 'USER',
      enabled: true,
    });
    expect(demote.status).toBe(403);
    // A Super Admin is still free to do it.
    const byRoot = await put(`/admin/tenants/${tenant.id}/users/42`, {
      role: 'USER',
      enabled: true,
    });
    expect(byRoot.status).toBe(200);
  });
});

describe('tenants', () => {
  it('creates, lists, and updates with audit records', async () => {
    const tenant = await createTenant();
    const list = await request(ctx.app).get('/admin/tenants').set('Cookie', ctx.cookies);
    expect(list.body.tenants).toHaveLength(1);

    const updated = await put(`/admin/tenants/${tenant.id}`, {
      name: 'Acme 2',
      slug: 'acme',
      asteriskContext: 'acme',
      enabled: true,
      expectedRevision: 1,
    });
    expect(updated.status).toBe(200);
    expect(updated.body.tenant.revision).toBe(2);

    const auditRows = ctx.api.tableByName('audit_log')!.records;
    expect(auditRows.map((r) => r.action)).toEqual(['tenant.create', 'tenant.update']);
  });

  it('surfaces duplicates and stale revisions', async () => {
    const tenant = await createTenant();
    const dup = await post('/admin/tenants', {
      name: 'Other',
      slug: 'acme',
      asteriskContext: 'other',
      enabled: true,
    });
    expect(dup.status).toBe(409);
    const stale = await put(`/admin/tenants/${tenant.id}`, {
      name: 'X',
      slug: 'acme',
      asteriskContext: 'acme',
      enabled: true,
      expectedRevision: 99,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toBe('revision_conflict');
  });
});

describe('tenant users and directory', () => {
  it('assigns a role to an existing central user without copying name/email', async () => {
    const tenant = await createTenant();
    const res = await put(`/admin/tenants/${tenant.id}/users/42`, {
      role: 'TENANT_ADMIN',
      enabled: true,
    });
    expect(res.status).toBe(200);
    const stored = ctx.api.tableByName('tenant_user')!.records[0]!;
    expect(stored.identity_user_id).toBe(42);
    expect(JSON.stringify(stored)).not.toContain('pat@example.invalid');
  });

  it('rejects an unknown identity user', async () => {
    const tenant = await createTenant();
    const res = await put(`/admin/tenants/${tenant.id}/users/999`, {
      role: 'USER',
      enabled: true,
    });
    expect(res.status).toBe(404);
  });

  it('searches and ensures central users', async () => {
    const found = await request(ctx.app)
      .get('/admin/directory/users?query=pat')
      .set('Cookie', ctx.cookies);
    expect(found.body.users[0].iUserId).toBe(42);
    const ensured = await post('/admin/directory/users', { email: 'new@example.invalid' });
    expect(ensured.status).toBe(201);
    expect(ensured.body.user.claimed).toBe(false);
  });

  it('refuses to grant a platform privilege through local membership', async () => {
    const res = await put('/admin/super-admins/42', { enabled: true });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('identity_managed_privilege');
  });
});

describe('retired provisioning routes', () => {
  it('has no extension, ring-group, rotation or handset legacy mutation', async () => {
    for (const path of [
      '/admin/extensions',
      '/admin/ring-groups',
      '/admin/extensions/old/rotate-secret',
      '/admin/extensions/old/handset-enrollment',
    ]) {
      expect((await post(path, {})).status).toBe(404);
    }
  });
});

describe('unconfigured NocoDB', () => {
  it('names the missing variables instead of a bare not-configured message', async () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      LOG_LEVEL: 'fatal',
      NOCODB_BASE_URL: 'https://nocodb.example.invalid',
      // NOCODB_API_TOKEN deliberately absent.
    });
    const deps: AppDeps = createDeps(config);
    const app = createApp(config, logger, deps);
    const sid = await deps.sessionStore.create({
      iUserId: 1,
      email: null,
      displayName: 'Root',
      superAdmin: true,
      provider: null,
    });

    const res = await request(app)
      .get('/admin/tenants')
      .set('Cookie', [`aida.sid=${sid}`]);
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('nocodb_not_configured');
    expect(res.body.message).toContain('NOCODB_API_TOKEN');
    expect(res.body.missingConfiguration).toEqual(['NOCODB_API_TOKEN']);
    // No base id is ever configuration: the base is found by name.
    expect(JSON.stringify(res.body)).not.toContain('NOCODB_BASE_ID');
  });
});
