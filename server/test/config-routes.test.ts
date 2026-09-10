import { HttpIdClient } from '../src/id/client.js';
import { seedLegacyDirectory } from './helpers/legacy-schema.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createDeps, type AppDeps } from '../src/deps.js';
import { createRepos } from './helpers/legacy-repos.js';
import { upgradeSchema } from '../src/nocodb/schema.js';
import { createLogger } from '../src/logger.js';
import { FakeOfficePulse } from './helpers/fake-officepulse.js';
import { FakeNocoDbApi } from './helpers/fake-nocodb.js';

const logger = createLogger({ logLevel: 'fatal' });

interface Ctx {
  app: ReturnType<typeof createApp>;
  api: FakeNocoDbApi;
  officePulse: FakeOfficePulse;
  cookies: string[];
  csrf: string;
  tenantId: string;
  profileId: string;
  extensionId: string;
}

let ctx: Ctx;

beforeEach(async () => {
  const config = loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'fatal',
    ASSET_STORAGE_DIR: mkdtempSync(path.join(tmpdir(), 'aida-assets-')),
  });
  const api = new FakeNocoDbApi();
  await upgradeSchema(api);
  await seedLegacyDirectory(api);
  const officePulse = new FakeOfficePulse();
  const repos = createRepos(api);
  const idClient = new HttpIdClient('https://id.test');
  idClient.listTenantNumbers = async (tenantId) => ({
    numbers: [
      {
        iPhoneNumberId: 1,
        iTenantId: Number(tenantId),
        phoneNumber: '+15105550100',
        label: '',
        bEnabled: true,
        bVoice: true,
        bMessaging: true,
        accessPolicy: 'TENANT_MEMBERS',
        iVersion: 1,
      },
    ],
  });
  const deps: AppDeps = { ...createDeps(config), repos, officePulse, idClient };
  const app = createApp(config, logger, deps);
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

  const tenant = await repos.tenants.create({
    name: 'Acme',
    slug: 'acme',
    asteriskContext: 'acme',
    enabled: true,
  });
  const profile = await repos.assistantProfiles.create(tenant.id as string, {
    name: 'Reception',
    businessName: 'Acme Dental',
    prompt: 'Screen calls politely.',
    enabled: true,
  });
  const extension = await repos.extensions.create(tenant.id as string, {
    extensionNumber: '100',
    displayName: 'Front Desk',
    asteriskContext: 'acme',
    enabled: true,
  });

  ctx = {
    app,
    api,
    officePulse,
    cookies: [`aida.sid=${sid}`, `aida.csrf=${csrf}`],
    csrf,
    tenantId: tenant.id as string,
    profileId: profile.id as string,
    extensionId: extension.id as string,
  };
});

function post(pathName: string, body: unknown) {
  return request(ctx.app)
    .post(pathName)
    .set('Cookie', ctx.cookies)
    .set('x-csrf-token', ctx.csrf)
    .send(body as object);
}

describe('assistant profiles', () => {
  it('creates and updates a profile with validation', async () => {
    const created = await post('/admin/profiles', {
      tenantId: ctx.tenantId,
      name: 'After hours',
      businessName: 'Acme Dental',
      prompt: 'Take a message.',
      tone: 'warm',
      enabled: true,
    });
    expect(created.status).toBe(201);

    const invalid = await post('/admin/profiles', {
      tenantId: ctx.tenantId,
      name: 'Empty',
      businessName: 'Acme Dental',
      prompt: '   ',
      enabled: true,
    });
    expect(invalid.status).toBe(400);
    expect(invalid.body.field).toBe('prompt');
  });

  it('never accepts LiveKit voice fields', async () => {
    const res = await post('/admin/profiles', {
      tenantId: ctx.tenantId,
      name: 'X',
      businessName: 'Acme',
      prompt: 'Hello.',
      enabled: true,
      voice: 'shimmer',
      model: 'gpt',
    });
    // Unknown fields are simply not part of the contract and are dropped.
    expect(res.status).toBe(201);
    const stored = ctx.api.tableByName('aida_tbl_AssistantProfile')!.records.at(-1)!;
    expect('voice' in stored).toBe(false);
    expect('model' in stored).toBe(false);
  });
});

describe('retired DID provisioning routes', () => {
  it('does not accept the former desired-state route', async () => {
    expect((await post('/admin/did-routes', { tenantId: ctx.tenantId })).status).toBe(404);
  });
});

describe('appearance', () => {
  it('saves brand settings with color validation', async () => {
    const bad = await request(ctx.app)
      .put(`/admin/tenants/${ctx.tenantId}/appearance`)
      .set('Cookie', ctx.cookies)
      .set('x-csrf-token', ctx.csrf)
      .send({ brandName: 'Acme', primaryColor: 'red' });
    expect(bad.status).toBe(400);

    const ok = await request(ctx.app)
      .put(`/admin/tenants/${ctx.tenantId}/appearance`)
      .set('Cookie', ctx.cookies)
      .set('x-csrf-token', ctx.csrf)
      .send({ brandName: 'Acme', primaryColor: '#1f5eda' });
    expect(ok.status).toBe(200);
    expect(ok.body.appearance.brand_name).toBe('Acme');
  });

  it('accepts a valid PNG logo and rejects a fake one', async () => {
    const png = Buffer.concat([Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'), Buffer.alloc(64, 1)]);
    const ok = await request(ctx.app)
      .post(`/admin/tenants/${ctx.tenantId}/appearance/logo`)
      .set('Cookie', ctx.cookies)
      .set('x-csrf-token', ctx.csrf)
      .set('content-type', 'image/png')
      .send(png);
    expect(ok.status).toBe(201);
    expect(ok.body.logoAssetPath).toMatch(/^\/assets\/logo-[0-9a-f]{16}\.png$/);

    const served = await request(ctx.app).get(ok.body.logoAssetPath as string);
    expect(served.status).toBe(200);

    const fake = await request(ctx.app)
      .post(`/admin/tenants/${ctx.tenantId}/appearance/logo`)
      .set('Cookie', ctx.cookies)
      .set('x-csrf-token', ctx.csrf)
      .set('content-type', 'image/png')
      .send(Buffer.from('<script>alert(1)</script>'));
    expect(fake.status).toBe(400);
  });
});
