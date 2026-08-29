import { beforeEach, describe, expect, it } from 'vitest';
import type { NocoRecord } from '../src/nocodb/api.js';
import {
  AuditLog,
  ConflictError,
  createRepos,
  NocoDbTenantUserDirectory,
  NotFoundError,
  UniqueViolationError,
  type AidaConfigRepos,
} from '../src/nocodb/repos.js';
import { upgradeSchema } from '../src/nocodb/schema.js';
import { ValidationError } from '../src/nocodb/validation.js';
import { FakeNocoDbApi } from './helpers/fake-nocodb.js';

let api: FakeNocoDbApi;
let repos: AidaConfigRepos;
let tenantA: NocoRecord;
let tenantB: NocoRecord;

beforeEach(async () => {
  api = new FakeNocoDbApi();
  await upgradeSchema(api);
  repos = createRepos(api);
  tenantA = await repos.tenants.create({
    name: 'Tenant A',
    slug: 'tenant-a',
    asteriskContext: 'tenant-a',
    enabled: true,
  });
  tenantB = await repos.tenants.create({
    name: 'Tenant B',
    slug: 'tenant-b',
    asteriskContext: 'tenant-b',
    enabled: true,
  });
});

const aId = () => tenantA.id as string;
const bId = () => tenantB.id as string;

describe('tenant repository', () => {
  it('rejects duplicate slug and asterisk context', async () => {
    await expect(
      repos.tenants.create({
        name: 'X',
        slug: 'tenant-a',
        asteriskContext: 'other',
        enabled: true,
      }),
    ).rejects.toBeInstanceOf(UniqueViolationError);
    await expect(
      repos.tenants.create({
        name: 'X',
        slug: 'other',
        asteriskContext: 'tenant-a',
        enabled: true,
      }),
    ).rejects.toBeInstanceOf(UniqueViolationError);
  });

  it('validates slug, context, and caller id number', async () => {
    await expect(
      repos.tenants.create({ name: 'X', slug: 'Bad Slug', asteriskContext: 'ok', enabled: true }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      repos.tenants.create({
        name: 'X',
        slug: 'ok-slug',
        asteriskContext: 'bad context!',
        enabled: true,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      repos.tenants.create({
        name: 'X',
        slug: 'ok2',
        asteriskContext: 'ok2',
        callerIdNumber: 'not-a-number',
        enabled: true,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('enforces optimistic revision on update', async () => {
    const updated = await repos.tenants.update(aId(), 1, {
      name: 'Tenant A2',
      slug: 'tenant-a',
      asteriskContext: 'tenant-a',
      enabled: true,
    });
    expect(updated.revision).toBe(2);
    await expect(
      repos.tenants.update(aId(), 1, {
        name: 'Stale write',
        slug: 'tenant-a',
        asteriskContext: 'tenant-a',
        enabled: true,
      }),
    ).rejects.toBeInstanceOf(ConflictError);
  });
});

describe('tenant isolation', () => {
  it('never resolves another tenant’s records', async () => {
    const ext = await repos.extensions.create(aId(), {
      extensionNumber: '100',
      displayName: 'Front Desk',
      asteriskContext: 'tenant-a',
      enabled: true,
    });
    await expect(repos.extensions.get(bId(), ext.id as string)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(await repos.extensions.listForTenant(bId())).toEqual([]);
  });

  it('rejects cross-tenant ring-group membership', async () => {
    const ext = await repos.extensions.create(aId(), {
      extensionNumber: '100',
      displayName: 'Front Desk',
      asteriskContext: 'tenant-a',
      enabled: true,
    });
    const group = await repos.ringGroups.create(bId(), {
      name: 'Sales',
      virtualExtension: '600',
      asteriskContext: 'tenant-b',
      enabled: true,
    });
    await expect(
      repos.ringGroups.addMember(bId(), group.id as string, ext.id as string, 1),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('extension repository', () => {
  it('enforces per-tenant extension-number uniqueness but allows reuse across tenants', async () => {
    await repos.extensions.create(aId(), {
      extensionNumber: '100',
      displayName: 'A',
      asteriskContext: 'tenant-a',
      enabled: true,
    });
    await expect(
      repos.extensions.create(aId(), {
        extensionNumber: '100',
        displayName: 'Dup',
        asteriskContext: 'tenant-a',
        enabled: true,
      }),
    ).rejects.toBeInstanceOf(UniqueViolationError);
    await expect(
      repos.extensions.create(bId(), {
        extensionNumber: '100',
        displayName: 'B',
        asteriskContext: 'tenant-b',
        enabled: true,
      }),
    ).resolves.toBeTruthy();
  });

  it('normalizes the MAC and enforces its global uniqueness', async () => {
    const e1 = await repos.extensions.create(aId(), {
      extensionNumber: '101',
      displayName: 'A',
      asteriskContext: 'tenant-a',
      enabled: true,
    });
    const enrolled = await repos.extensions.recordEnrollment(aId(), e1.id as string, 1, {
      deviceId: 'device-1',
      provisioningMac: 'aa:bb:cc:dd:ee:ff',
      enrollmentTokenHash: 'hash-only',
      enrollmentExpiresAt: new Date().toISOString(),
    });
    expect(enrolled.provisioning_mac).toBe('AABBCCDDEEFF');

    const e2 = await repos.extensions.create(bId(), {
      extensionNumber: '101',
      displayName: 'B',
      asteriskContext: 'tenant-b',
      enabled: true,
    });
    await expect(
      repos.extensions.recordEnrollment(bId(), e2.id as string, 1, {
        deviceId: 'device-2',
        provisioningMac: 'AABB.CCDD.EEFF',
        enrollmentTokenHash: 'hash-only-2',
        enrollmentExpiresAt: new Date().toISOString(),
      }),
    ).rejects.toBeInstanceOf(UniqueViolationError);
  });
});

describe('did_route destination union', () => {
  it('requires the destination to match the type and the tenant', async () => {
    const profile = await repos.assistantProfiles.create(aId(), {
      name: 'P',
      businessName: 'Biz',
      prompt: 'Screen calls.',
      enabled: true,
    });
    const ext = await repos.extensions.create(aId(), {
      extensionNumber: '100',
      displayName: 'A',
      asteriskContext: 'tenant-a',
      enabled: true,
    });
    const route = await repos.didRoutes.create(aId(), {
      didE164: '+15105550100',
      assistantProfileId: profile.id as string,
      destinationType: 'EXTENSION',
      destinationId: ext.id as string,
      screeningEnabled: true,
      enabled: true,
    });
    expect(route.destination_extension_id).toBe(ext.id);
    expect(route.destination_ring_group_id).toBeNull();

    // A ring-group destination that is actually an extension id fails.
    await expect(
      repos.didRoutes.create(aId(), {
        didE164: '+15105550101',
        assistantProfileId: profile.id as string,
        destinationType: 'RING_GROUP',
        destinationId: ext.id as string,
        screeningEnabled: true,
        enabled: true,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);

    // Cross-tenant profile reference fails.
    await expect(
      repos.didRoutes.create(bId(), {
        didE164: '+15105550102',
        assistantProfileId: profile.id as string,
        destinationType: 'EXTENSION',
        destinationId: ext.id as string,
        screeningEnabled: true,
        enabled: true,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('enforces global DID uniqueness and E.164 normalization', async () => {
    const profile = await repos.assistantProfiles.create(aId(), {
      name: 'P',
      businessName: 'Biz',
      prompt: 'Screen calls.',
      enabled: true,
    });
    const ext = await repos.extensions.create(aId(), {
      extensionNumber: '100',
      displayName: 'A',
      asteriskContext: 'tenant-a',
      enabled: true,
    });
    const route = await repos.didRoutes.create(aId(), {
      didE164: '+1 (510) 555-0100',
      assistantProfileId: profile.id as string,
      destinationType: 'EXTENSION',
      destinationId: ext.id as string,
      screeningEnabled: true,
      enabled: true,
    });
    expect(route.did_e164).toBe('+15105550100');
    await expect(
      repos.didRoutes.create(aId(), {
        didE164: '+15105550100',
        assistantProfileId: profile.id as string,
        destinationType: 'EXTENSION',
        destinationId: ext.id as string,
        screeningEnabled: true,
        enabled: true,
      }),
    ).rejects.toBeInstanceOf(UniqueViolationError);
  });
});

describe('tenant_user and login directory', () => {
  it('upserts mappings and enforces the SUPER_ADMIN null-tenant rule', async () => {
    await repos.tenantUsers.save(aId(), 42, 'TENANT_ADMIN', true);
    const again = await repos.tenantUsers.save(aId(), 42, 'USER', true);
    expect(again.role).toBe('USER');
    expect((await repos.tenantUsers.listForTenant(aId())).length).toBe(1);

    await expect(repos.tenantUsers.save(aId(), 43, 'SUPER_ADMIN', true)).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(repos.tenantUsers.save(null, 43, 'USER', true)).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(repos.tenantUsers.save(null, 43, 'SUPER_ADMIN', true)).resolves.toBeTruthy();
  });

  it('backs hasEnabledMembership', async () => {
    const directory = new NocoDbTenantUserDirectory(repos.tenantUsers);
    expect(await directory.hasEnabledMembership(42)).toBe(false);
    await repos.tenantUsers.save(aId(), 42, 'USER', false);
    expect(await directory.hasEnabledMembership(42)).toBe(false);
    await repos.tenantUsers.save(aId(), 42, 'USER', true);
    expect(await directory.hasEnabledMembership(42)).toBe(true);
  });
});

describe('audit log', () => {
  it('appends immutable records', async () => {
    const audit = new AuditLog(repos.store);
    await audit.append({
      tenantId: aId(),
      actorIdentityUserId: 42,
      action: 'tenant.update',
      entityType: 'tenant',
      entityId: aId(),
      details: { field: 'name' },
      correlationId: 'corr-1',
    });
    const rows = api.tableByName('audit_log')!.records;
    expect(rows.length).toBe(1);
    expect(rows[0]?.action).toBe('tenant.update');
    // Immutable by construction: the audit table has no revision column and
    // AuditLog exposes no update/delete surface.
    expect(rows[0]?.revision).toBeUndefined();
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(audit))).toEqual([
      'constructor',
      'append',
    ]);
  });
});
