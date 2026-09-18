import { beforeEach, describe, expect, it } from 'vitest';
import type { NocoRecord } from '../src/nocodb/api.js';
import { DID as did, scopedApp } from './helpers/scoped-app.js';

const base = '/admin/tenants/7/profile-assignments';
let ctx: Awaited<ReturnType<typeof scopedApp>>;
let profile: NocoRecord;
beforeEach(async () => {
  ctx = await scopedApp();
  profile = await ctx.deps.repos!.assistantProfiles.create('7', {
    name: 'Reception',
    businessName: 'Acme',
    prompt: 'Take a message.',
    enabled: true,
  });
});
const send: typeof ctx.send = (...args) => ctx.send(...args);
const table = () => ctx.noco.tableByName('aida_tbl_ProfileAssignment')!;

describe('persisted profile assignments', () => {
  it('lists the PBX instance, authorized contexts and stored rows with blank DIDs normalized', async () => {
    expect((await send('get', base)).body).toEqual({
      pbxInstanceId: 'officepulse-test',
      contexts: ['acme', 'acme-branch'],
      assignments: [],
    });
    // NocoDB hands blank text back as null; the browser sees the '' key.
    await ctx.noco.createRecord(table().info.id, {
      id: '3d8b6c4e-5d0c-4b6a-9d3e-1f2a3b4c5d6e',
      created_at: 'x',
      updated_at: 'x',
      revision: 1,
      iTenantId: 7,
      pbx_instance_id: 'officepulse-test',
      context: 'acme',
      did: null,
      profile_id: profile.id,
      enabled: true,
    });
    expect((await send('get', base)).body.assignments).toEqual([
      {
        id: '3d8b6c4e-5d0c-4b6a-9d3e-1f2a3b4c5d6e',
        pbxInstanceId: 'officepulse-test',
        context: 'acme',
        did: '',
        profileId: profile.id,
        enabled: true,
        revision: 1,
      },
    ]);
    ctx.api.readinessSnapshot = { ...ctx.api.readinessSnapshot, reachable: false };
    expect((await send('get', base)).body.pbxInstanceId).toBeNull();
  });
  it('upserts a context default and a DID assignment by (instance, context, did) with audit', async () => {
    const created = await send('put', base, { context: 'acme', did: null, profileId: profile.id });
    expect(created.status).toBe(200);
    expect(created.body).toEqual({
      pbxInstanceId: 'officepulse-test',
      assignment: {
        id: expect.any(String),
        pbxInstanceId: 'officepulse-test',
        context: 'acme',
        did: '',
        profileId: profile.id,
        enabled: true,
        revision: 1,
      },
    });
    expect(table().records[0]).toMatchObject({
      iTenantId: 7,
      pbx_instance_id: 'officepulse-test',
      context: 'acme',
      did: '',
      profile_id: profile.id,
      enabled: true,
    });
    const other = await ctx.deps.repos!.assistantProfiles.create('7', {
      name: 'After hours',
      businessName: 'Acme',
      prompt: 'Take a message.',
      enabled: true,
    });
    const updated = await send('put', base, {
      context: 'acme',
      did: null,
      profileId: other.id,
      enabled: false,
    });
    expect(updated.body.assignment).toMatchObject({
      id: created.body.assignment.id,
      profileId: other.id,
      enabled: false,
      revision: 2,
    });
    const specific = await send('put', base, {
      context: 'acme-branch',
      did,
      profileId: profile.id,
    });
    expect(specific.status).toBe(200);
    expect(specific.body.assignment).toMatchObject({ context: 'acme-branch', did, revision: 1 });
    expect(table().records).toHaveLength(2);
    expect(ctx.state.audits.map((row) => [row.action, row.tenantId, row.entityType])).toEqual(
      Array(3).fill(['profile_assignment.save', '7', 'profile_assignment']),
    );
    expect(ctx.state.audits[2]).toMatchObject({
      actorIdentityUserId: 42,
      entityId: specific.body.assignment.id,
      correlationId: 'pbx-test-correlation',
      details: { pbxInstanceId: 'officepulse-test', context: 'acme-branch', did },
    });
    expect(JSON.stringify(ctx.state.audits)).not.toContain('Take a message');
  });
  it('refuses a context the tenant does not own and none at all', async () => {
    const forbidden = await send('put', base, {
      context: 'other-tenant',
      did: null,
      profileId: profile.id,
    });
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.error).toBe('context_forbidden');
    expect(
      (await send('put', base, { context: 'from-carrier', did: null, profileId: profile.id }))
        .status,
    ).toBe(403);
    const tenants = ctx.noco.tableByName('aida_tbl_TenantProfile')!;
    await ctx.noco.updateRecord(tenants.info.id, tenants.records[0]!.Id!, {
      asterisk_context: '',
      additional_contexts: '',
    });
    const missing = await send('put', base, { context: 'acme', did: null, profileId: profile.id });
    expect(missing.status).toBe(409);
    expect(missing.body).toMatchObject({
      error: 'pbx_scope_missing',
      message: "Assign this tenant's Asterisk context in Tenants first",
    });
    expect((await send('get', base)).body.contexts).toEqual([]);
    expect(table().records).toEqual([]);
  });
  it('accepts only the tenant’s enabled Identity voice numbers as DIDs', async () => {
    const unknown = await send('put', base, {
      context: 'acme',
      did: '+15559879999',
      profileId: profile.id,
    });
    expect(unknown.status).toBe(400);
    expect(unknown.body.message).toContain('did');
    expect(
      (await send('put', base, { context: 'acme', did: '5559870001', profileId: profile.id }))
        .status,
    ).toBe(400);
    ctx.state.numbers[0]!.bEnabled = false;
    expect((await send('put', base, { context: 'acme', did, profileId: profile.id })).status).toBe(
      400,
    );
    ctx.state.numbers[0]!.bEnabled = true;
    ctx.identity.listTenantNumbers = async () => {
      throw new Error('identity down');
    };
    const outage = await send('put', base, { context: 'acme', did, profileId: profile.id });
    expect(outage.status).toBe(503);
    expect(outage.body.error).toBe('identity_unavailable');
    expect(table().records).toEqual([]);
  });
  it('accepts only the tenant’s enabled profiles', async () => {
    const foreign = await ctx.deps.repos!.assistantProfiles.create('8', {
      name: 'Theirs',
      businessName: 'Other',
      prompt: 'Nope.',
      enabled: true,
    });
    const crossTenant = await send('put', base, {
      context: 'acme',
      did: null,
      profileId: foreign.id,
    });
    expect(crossTenant.status).toBe(404);
    expect(
      (await send('put', base, { context: 'acme', did: null, profileId: 'missing' })).status,
    ).toBe(404);
    const disabled = await ctx.deps.repos!.assistantProfiles.create('7', {
      name: 'Off',
      businessName: 'Acme',
      prompt: 'Nope.',
      enabled: false,
    });
    const off = await send('put', base, { context: 'acme', did: null, profileId: disabled.id });
    expect(off.status).toBe(400);
    expect(off.body.message).toContain('profileId');
    expect(table().records).toEqual([]);
  });
  it('needs the PBX instance from OfficePulse readiness to pin the scope', async () => {
    ctx.api.readinessSnapshot = { ...ctx.api.readinessSnapshot, reachable: false };
    const down = await send('put', base, { context: 'acme', did: null, profileId: profile.id });
    expect(down.status).toBe(503);
    expect(down.body.error).toBe('officepulse_unavailable');
    delete ctx.api.readinessSnapshot.pbxInstanceId;
    ctx.api.readinessSnapshot = { ...ctx.api.readinessSnapshot, reachable: true };
    expect(
      (await send('put', base, { context: 'acme', did: null, profileId: profile.id })).body.error,
    ).toBe('officepulse_unavailable');
    ctx.deps.officePulse = null;
    expect(
      (await send('put', base, { context: 'acme', did: null, profileId: profile.id })).status,
    ).toBe(503);
    expect(table().records).toEqual([]);
  });
  it.each([
    { did: null, profileId: 'x' },
    { context: 'acme', profileId: 'x' },
    { context: 'acme', did: null },
    { context: 'acme', did: null, profileId: 'x', tenantId: '8' },
    { context: 'acme', did: null, profileId: 'x', enabled: 'yes' },
  ])('validates the body %j before touching any dependency', async (body) => {
    expect((await send('put', base, body)).status).toBe(400);
    expect(ctx.api.readinessProbes).toBe(0);
  });
  it('deletes only the tenant’s own rows and audits it', async () => {
    const saved = await send('put', base, { context: 'acme', did: null, profileId: profile.id });
    const theirs = await ctx.deps.repos!.profileAssignments.upsert('8', {
      pbxInstanceId: 'officepulse-test',
      context: 'other',
      did: '',
      profileId: 'p',
      enabled: true,
    });
    expect((await send('delete', `${base}/${theirs.id}`)).status).toBe(404);
    expect((await send('delete', `${base}/not-a-uuid`)).status).toBe(400);
    expect((await send('delete', `${base}/${saved.body.assignment.id}`)).status).toBe(204);
    expect((await send('delete', `${base}/${saved.body.assignment.id}`)).status).toBe(404);
    expect(table().records.map((row) => row.id)).toEqual([theirs.id]);
    expect(ctx.state.audits.at(-1)).toMatchObject({
      action: 'profile_assignment.delete',
      entityId: saved.body.assignment.id,
      tenantId: '7',
    });
  });
  it('applies the PBX guard: selected tenant, session and PlatformConfig', async () => {
    if (!ctx.state.snapshot.active) throw new Error('fixture');
    ctx.state.snapshot.selectedTenantId = null;
    const unselected = await send('get', base);
    expect(unselected.status).toBe(403);
    expect(unselected.body.error).toBe('tenant_not_selected');
    ctx.state.snapshot = { active: false };
    expect((await send('get', base)).status).toBe(401);
    ctx = await scopedApp();
    ctx.deps.repos = null;
    expect((await send('get', base)).body.error).toBe('nocodb_not_configured');
  });
});
