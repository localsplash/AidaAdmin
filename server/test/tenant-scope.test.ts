import { beforeEach, describe, expect, it } from 'vitest';
import type { PlatformTenant } from '../src/id/client.js';
import { assertContextsUnclaimed, UniqueViolationError } from '../src/nocodb/repos.js';
import { ValidationError, validateTenantContexts } from '../src/nocodb/validation.js';
import { PROFILE, STORED_PROFILE, scopedApp } from './helpers/scoped-app.js';

// Tenant 7 owns two extension contexts and names the shared ingress context.
// The rules under test: an extension context belongs to one tenant, and a
// tenant's DID context is never one of its own extension contexts.
const acme = {
  name: 'Acme',
  slug: 'acme',
  asteriskContext: PROFILE.asterisk_context,
  additionalContexts: [PROFILE.additional_contexts],
  didContext: PROFILE.did_context,
  enabled: true,
};
let ctx: Awaited<ReturnType<typeof scopedApp>>;
let directory: PlatformTenant[];
beforeEach(async () => {
  ctx = await scopedApp();
  if (!ctx.state.snapshot.active) throw new Error('fixture');
  ctx.state.snapshot.user.superAdmin = true;
  directory = [...ctx.state.snapshot.tenants];
  // Identity's directory: list, create and patch tenants; PlatformConfig keeps the scope.
  ctx.identity.directoryRequest = async <T>(path: string, method = 'GET'): Promise<T> => {
    if (path === 'tenants' && method === 'GET') return { tenants: directory } as T;
    if (path === 'tenants' && method === 'POST') {
      const tenant: PlatformTenant = {
        iTenantId: directory.length + 7,
        name: 'New',
        slug: 'new',
        role: 'SUPER_ADMIN',
        bEnabled: true,
      };
      directory.push(tenant);
      return tenant as T;
    }
    if (/^tenants\/\d+$/.test(path) && method === 'PATCH') return {} as T;
    throw new Error(`Unexpected Identity directory call ${method} ${path}`);
  };
});
const send: typeof ctx.send = (...args) => ctx.send(...args);
const profiles = () => ctx.noco.tableByName('aida_tbl_TenantProfile')!.records;

describe('tenant PBX scope through the tenant form', () => {
  it('lists the stored extension contexts and DID context per tenant', async () => {
    const res = await send('get', '/admin/tenants');
    expect(res.status).toBe(200);
    expect(res.body.tenants).toEqual([
      expect.objectContaining({
        id: '7',
        asterisk_context: 'acme',
        additional_contexts: ['acme-branch'],
        did_context: 'from-carrier',
      }),
    ]);
  });
  it('refuses an extension context another tenant owns, primary or additional', async () => {
    for (const body of [
      { ...acme, slug: 'other', asteriskContext: 'acme-branch', additionalContexts: [] },
      { ...acme, slug: 'other', asteriskContext: 'other', additionalContexts: ['acme'] },
      { ...acme, slug: 'other', asteriskContext: 'other', additionalContexts: ['acme-branch'] },
    ]) {
      const res = await send('post', '/admin/tenants', body);
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({
        error: 'duplicate',
        message: expect.stringContaining('already belongs to another tenant'),
      });
    }
    expect(directory).toHaveLength(1);
    expect(profiles()).toHaveLength(1);
  });
  it('keeps the DID ingress context distinct from every extension context', async () => {
    for (const body of [
      { ...acme, didContext: 'acme' },
      { ...acme, didContext: 'acme-branch' },
      {
        ...acme,
        slug: 'other',
        asteriskContext: 'other',
        additionalContexts: [],
        didContext: 'other',
      },
    ]) {
      const res = await send(
        body.slug === 'acme' ? 'put' : 'post',
        body.slug === 'acme' ? '/admin/tenants/7' : '/admin/tenants',
        body.slug === 'acme' ? { ...body, expectedRevision: 1 } : body,
      );
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: 'validation', field: 'didContext' });
    }
    expect(profiles()).toMatchObject([STORED_PROFILE]);
  });
  it.each(['bad name', 'a'.repeat(41), '', 'ctx/one', 'acme,other'])(
    'validates the shared context grammar for %j',
    async (context) => {
      expect(
        (
          await send('put', '/admin/tenants/7', {
            ...acme,
            asteriskContext: context,
            expectedRevision: 1,
          })
        ).status,
      ).toBe(400);
      // Blank additional entries are dropped rather than refused, so only a
      // non-blank bad name reaches the additional-context check.
      if (context !== '')
        expect(
          (
            await send('put', '/admin/tenants/7', {
              ...acme,
              additionalContexts: [context],
              expectedRevision: 1,
            })
          ).status,
        ).toBe(400);
      expect(profiles()).toMatchObject([STORED_PROFILE]);
    },
  );
  it('lets a tenant rearrange its own contexts and share the ingress context with another tenant', async () => {
    const swapped = await send('put', '/admin/tenants/7', {
      ...acme,
      asteriskContext: 'acme-branch',
      additionalContexts: ['acme', 'acme.lab', 'acme'],
      expectedRevision: 1,
    });
    expect(swapped.status).toBe(200);
    expect(swapped.body.tenant).toMatchObject({
      asterisk_context: 'acme-branch',
      additional_contexts: ['acme', 'acme.lab'],
      did_context: 'from-carrier',
      revision: 2,
    });
    expect(profiles()[0]).toMatchObject({
      asterisk_context: 'acme-branch',
      additional_contexts: 'acme,acme.lab',
      did_context: 'from-carrier',
    });
    // PBX routes now default to the new primary context.
    expect((await send('get', '/admin/tenants/7/extensions')).body).toMatchObject({
      context: 'acme-branch',
      contexts: ['acme-branch', 'acme', 'acme.lab'],
    });
    const other = await send('post', '/admin/tenants', {
      ...acme,
      slug: 'other',
      asteriskContext: 'other',
      additionalContexts: [],
    });
    expect(other.status).toBe(201);
    expect(other.body.tenant).toMatchObject({
      id: '8',
      asterisk_context: 'other',
      additional_contexts: [],
      did_context: 'from-carrier',
    });
    const cleared = await send('put', '/admin/tenants/8', {
      ...acme,
      slug: 'other',
      asteriskContext: 'other',
      additionalContexts: [],
      didContext: null,
      expectedRevision: 1,
    });
    expect(cleared.status).toBe(200);
    expect(cleared.body.tenant.did_context).toBeNull();
  });
});

describe('context scope validation helpers', () => {
  it('normalizes and deduplicates the tenant contexts', () => {
    expect(
      validateTenantContexts({
        asteriskContext: ' acme ',
        additionalContexts: ['acme', ' acme-branch ', '', 'acme-branch'],
        didContext: ' from-carrier ',
      }),
    ).toEqual({ contexts: ['acme', 'acme-branch'], didContext: 'from-carrier' });
    expect(
      validateTenantContexts({ asteriskContext: 'acme', additionalContexts: [], didContext: '  ' })
        .didContext,
    ).toBeNull();
    expect(() =>
      validateTenantContexts({
        asteriskContext: 'acme',
        additionalContexts: [],
        didContext: 'acme',
      }),
    ).toThrow(ValidationError);
    expect(() =>
      validateTenantContexts({ asteriskContext: '', additionalContexts: [], didContext: null }),
    ).toThrow(ValidationError);
  });
  it('treats the same context name on this instance as one tenant’s scope', () => {
    const stored = [
      { tenant_id: 7, asterisk_context: 'acme', additional_contexts: 'acme-branch' },
      { tenant_id: 8, asterisk_context: 'other', additional_contexts: null },
    ];
    const scope = { contexts: ['acme-branch'], didContext: null };
    expect(() => assertContextsUnclaimed(stored, scope, '8')).toThrow(UniqueViolationError);
    expect(() => assertContextsUnclaimed(stored, scope, '7')).not.toThrow();
    // Case matters: Asterisk compares contexts byte for byte, so does ownership.
    expect(() =>
      assertContextsUnclaimed(stored, { contexts: ['ACME'], didContext: null }, '8'),
    ).not.toThrow();
  });
});
