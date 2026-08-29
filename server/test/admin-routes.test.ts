import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createDeps, type AppDeps } from '../src/deps.js';
import type { DirectoryUser, IdClient, IdEvent, IdRedeemResult } from '../src/id/client.js';
import { createRepos } from '../src/nocodb/repos.js';
import { upgradeSchema } from '../src/nocodb/schema.js';
import type {
  OfficePulseClient,
  ProvisionExtensionRequest,
  ProvisionRingGroupRequest,
} from '../src/officepulse/client.js';
import { OfficePulseError } from '../src/officepulse/client.js';
import type {
  HandsetEnrollmentDelivery,
  HandsetProvisioningDelivery,
} from '../src/provisioning/handset-delivery.js';
import { createLogger } from '../src/logger.js';
import { FakeNocoDbApi } from './helpers/fake-nocodb.js';

const logger = createLogger({ logLevel: 'fatal' });

class FakeOfficePulse implements OfficePulseClient {
  provisioned: ProvisionExtensionRequest[] = [];
  ringGroups: ProvisionRingGroupRequest[] = [];
  failNext = false;

  private check() {
    if (this.failNext) {
      this.failNext = false;
      throw new OfficePulseError('pbx down', 503);
    }
  }

  async provisionExtension(req: ProvisionExtensionRequest) {
    this.check();
    this.provisioned.push(req);
    return { sipUsername: `sip-${req.extensionNumber}`, sipSecret: 'one-time-sip-secret' };
  }

  async updateProvisionedExtension() {
    this.check();
  }

  async rotateProvisionedExtensionSecret() {
    this.check();
    return { sipSecret: 'rotated-sip-secret' };
  }

  async provisionRingGroup(_id: string, req: ProvisionRingGroupRequest) {
    this.check();
    this.ringGroups.push(req);
  }

  async provisionDid() {
    this.check();
  }
}

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

describe('authorization', () => {
  it('requires a session', async () => {
    const res = await request(ctx.app).get('/admin/tenants');
    expect(res.status).toBe(401);
  });

  it('requires Super Admin', async () => {
    const sid = await ctx.deps.sessionStore.create({
      iUserId: 2,
      email: null,
      displayName: null,
      superAdmin: false,
      provider: null,
    });
    const res = await request(ctx.app)
      .get('/admin/tenants')
      .set('Cookie', [`aida.sid=${sid}`]);
    expect(res.status).toBe(403);
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

  it('grants and revokes Super Admin', async () => {
    const res = await put('/admin/super-admins/42', { enabled: true });
    expect(res.status).toBe(200);
    expect(res.body.tenantUser.role).toBe('SUPER_ADMIN');
    expect(res.body.tenantUser.tenant_id).toBeNull();
  });
});

describe('extensions and provisioning', () => {
  it('creates an extension and relays the one-time SIP secret without persisting it', async () => {
    const tenant = await createTenant();
    const res = await post('/admin/extensions', {
      tenantId: tenant.id,
      extensionNumber: '100',
      displayName: 'Front Desk',
      enabled: true,
    });
    expect(res.status).toBe(201);
    expect(res.body.sipUsername).toBe('sip-100');
    expect(res.body.sipSecret).toBe('one-time-sip-secret');
    expect(res.body.secretShownOnce).toBe(true);
    // The secret exists nowhere in NocoDB — not in any table's records.
    for (const table of ['extension', 'audit_log']) {
      expect(JSON.stringify(ctx.api.tableByName(table)!.records)).not.toContain(
        'one-time-sip-secret',
      );
    }
    expect(ctx.officePulse.provisioned[0]?.context).toBe('acme');
  });

  it('reports a PBX provisioning failure clearly with the record saved', async () => {
    const tenant = await createTenant();
    ctx.officePulse.failNext = true;
    const res = await post('/admin/extensions', {
      tenantId: tenant.id,
      extensionNumber: '100',
      displayName: 'Front Desk',
      enabled: true,
    });
    expect(res.status).toBe(502);
    expect(res.body.error).toBe('provisioning_failed');
    // The intended record was saved; no background reconciliation exists.
    expect(ctx.api.tableByName('extension')!.records).toHaveLength(1);
  });

  it('rotates the SIP secret and bumps the device credential version on reprovision', async () => {
    const tenant = await createTenant();
    const created = await post('/admin/extensions', {
      tenantId: tenant.id,
      extensionNumber: '100',
      displayName: 'Front Desk',
      enabled: true,
    });
    const extensionId = created.body.extension.id as string;
    const res = await post(`/admin/extensions/${extensionId}/rotate-secret`, {
      tenantId: tenant.id,
      reprovisionDevice: true,
    });
    expect(res.status).toBe(200);
    expect(res.body.sipSecret).toBe('rotated-sip-secret');
    const stored = ctx.api.tableByName('extension')!.records[0]!;
    expect(stored.device_credential_version).toBe(2);
    expect(JSON.stringify(ctx.api.tableByName('extension')!.records)).not.toContain(
      'rotated-sip-secret',
    );
  });

  it('issues a one-time handset enrollment: hash stored, plaintext delivered once', async () => {
    const tenant = await createTenant();
    const created = await post('/admin/extensions', {
      tenantId: tenant.id,
      extensionNumber: '100',
      displayName: 'Front Desk',
      enabled: true,
    });
    const extensionId = created.body.extension.id as string;
    const res = await post(`/admin/extensions/${extensionId}/handset-enrollment`, {
      tenantId: tenant.id,
      provisioningMac: 'aa:bb:cc:dd:ee:01',
    });
    expect(res.status).toBe(201);
    const token = res.body.enrollmentToken as string;
    expect(token.length).toBeGreaterThan(20);
    expect(res.body.tokenShownOnce).toBe(true);

    const stored = ctx.api.tableByName('extension')!.records[0]!;
    expect(stored.provisioning_mac).toBe('AABBCCDDEE01');
    expect(stored.enrollment_token_hash).not.toBe(token);
    expect(JSON.stringify(ctx.api.tableByName('extension')!.records)).not.toContain(token);

    expect(ctx.handset.deliveries).toHaveLength(1);
    expect(ctx.handset.deliveries[0]?.enrollmentToken).toBe(token);
    expect(ctx.handset.deliveries[0]?.deviceId).toBe(res.body.deviceId);
  });
});

describe('ring groups', () => {
  it('creates a ring group with members and provisions the member extension numbers', async () => {
    const tenant = await createTenant();
    const e1 = await post('/admin/extensions', {
      tenantId: tenant.id,
      extensionNumber: '100',
      displayName: 'A',
      enabled: true,
    });
    const e2 = await post('/admin/extensions', {
      tenantId: tenant.id,
      extensionNumber: '101',
      displayName: 'B',
      enabled: true,
    });
    const res = await post('/admin/ring-groups', {
      tenantId: tenant.id,
      name: 'Sales',
      virtualExtension: '600',
      memberExtensionIds: [e1.body.extension.id, e2.body.extension.id],
      enabled: true,
    });
    expect(res.status).toBe(201);
    expect(ctx.officePulse.ringGroups[0]?.memberExtensions).toEqual(['100', '101']);
    expect(ctx.officePulse.ringGroups[0]?.ringTimeoutSeconds).toBe(20);

    const list = await request(ctx.app)
      .get(`/admin/tenants/${tenant.id}/ring-groups`)
      .set('Cookie', ctx.cookies);
    expect(list.body.ringGroups[0].members).toHaveLength(2);
  });
});
