import request from 'supertest';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpOfficePulseClient } from '../src/officepulse/client.js';
import type { Handset } from '../src/officepulse/handset-contract.js';
import { scopedApp } from './helpers/scoped-app.js';

const device: Handset = {
  id: 'ed35265b-2199-46dd-9e46-99e3f9600111',
  pbxInstanceId: 'officepulse-test',
  context: 'acme',
  endpointId: '411',
  extension: '411',
  label: 'Desk',
  deviceModel: 'GXV3450',
  mac: 'ec74d7c92718',
  localIp: '192.168.6.97',
  publicIp: '203.0.113.1',
  attachedAt: '2026-09-20T10:00:00Z',
  lastSeenAt: '2026-09-20T10:01:00Z',
  appVersion: '1',
  revokedAt: null,
};
const base = '/admin/tenants/7/handsets';
afterEach(() => vi.unstubAllGlobals());

describe('tenant handset administration', () => {
  it('lists only the selected tenant context, including an authorized additional context', async () => {
    const ctx = await scopedApp();
    ctx.api.handsets.set('acme', [{ ...device }]);
    ctx.api.handsets.set('acme-branch', [{ ...device, context: 'acme-branch' }]);
    ctx.api.handsets.set('other', [{ ...device, context: 'other' }]);
    expect((await ctx.send('get', base)).body).toEqual({ handsets: [device] });
    expect((await ctx.send('get', `${base}?context=acme-branch`)).body.handsets[0].context).toBe(
      'acme-branch',
    );
    for (const method of ['get', 'delete'] as const) {
      expect(
        (
          await ctx.send(
            method,
            `${base}${method === 'delete' ? '/' + device.id : ''}?context=other`,
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await ctx.send(
            method,
            base.replace('/7/', '/8/') + (method === 'delete' ? '/' + device.id : ''),
          )
        ).status,
      ).toBe(403);
    }
    expect(ctx.api.requests.map((r) => r.context)).toEqual(['acme', 'acme-branch']);
  });
  it('refuses a foreign device ID in an authorized context and records the refusal', async () => {
    const ctx = await scopedApp();
    ctx.api.handsets.set('other', [{ ...device, context: 'other' }]);
    const response = await ctx.send('delete', `${base}/${device.id}?context=acme`);
    expect(response.status).toBe(404);
    expect(ctx.api.handsets.get('other')![0]!.revokedAt).toBeNull();
    expect(ctx.state.audits[0]).toMatchObject({
      action: 'handset.revoked',
      entityId: device.id,
      details: { outcome: 'not_found', status: 404 },
    });
  });
  it('revokes through the scoped API with CSRF and an audit record', async () => {
    const ctx = await scopedApp();
    ctx.api.handsets.set('acme', [{ ...device }]);
    expect(
      (
        await request(ctx.app)
          .delete(`${base}/${device.id}`)
          .set('Cookie', 'aida.sid=central-session')
      ).status,
    ).toBe(403);
    expect(ctx.api.requests).toEqual([]);
    const response = await ctx.send('delete', `${base}/${device.id}?context=acme`);
    expect(response.status).toBe(204);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(ctx.api.handsets.get('acme')![0]!.revokedAt).not.toBeNull();
    expect(ctx.state.audits[0]).toMatchObject({
      action: 'handset.revoked',
      tenantId: '7',
      actorIdentityUserId: 42,
      entityId: device.id,
      correlationId: 'pbx-test-correlation',
      details: { outcome: 'committed' },
    });
  });
  it('denies USER with 403 and requires Super Admin to select the tenant', async () => {
    const ctx = await scopedApp();
    if (!ctx.state.snapshot.active) throw new Error('fixture');
    ctx.state.snapshot.tenants[0]!.role = 'USER';
    expect((await ctx.send('get', base)).status).toBe(403);
    expect((await ctx.send('delete', `${base}/${device.id}`)).status).toBe(403);
    ctx.identity.revokeSession = vi.fn(async () => {});
    expect((await ctx.send('post', '/api/auth/logout')).status).toBe(204);
    expect(ctx.identity.revokeSession).toHaveBeenCalledWith('central-session');
    ctx.state.snapshot.user.superAdmin = true;
    ctx.state.snapshot.selectedTenantId = null;
    expect((await ctx.send('get', base)).status).toBe(403);
    expect((await ctx.send('delete', `${base}/${device.id}`)).status).toBe(403);
    expect(ctx.api.requests).toEqual([]);
    ctx.state.snapshot.selectedTenantId = 7;
    expect((await ctx.send('get', base)).status).toBe(200);
    ctx.state.snapshot = { active: false };
    expect((await ctx.send('get', base)).status).toBe(401);
  });
  it.each(['get', 'delete'] as const)(
    'returns a safe 502 for an OfficePulse outage during %s',
    async (method) => {
      const ctx = await scopedApp();
      ctx.deps.officePulse = new HttpOfficePulseClient('https://officepulse.invalid');
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          throw new Error('private-token-secret');
        }),
      );
      const response = await ctx.send(method, base + (method === 'delete' ? '/' + device.id : ''));
      expect(response.status).toBe(502);
      expect(response.body.message).toContain('OfficePulse');
      expect(JSON.stringify(response.body) + ctx.state.logs).not.toContain('private-token-secret');
    },
  );
  it('rejects malformed IDs, extra fields and repeated context parameters before OfficePulse', async () => {
    const ctx = await scopedApp();
    expect((await ctx.send('delete', `${base}/invalid`)).status).toBe(400);
    expect((await ctx.send('delete', `${base}/${device.id}`, { context: 'other' })).status).toBe(
      400,
    );
    expect((await ctx.send('get', `${base}?context=acme&context=other`)).status).toBe(400);
    expect(ctx.api.requests).toEqual([]);
  });
});

describe('OfficePulse handset contract', () => {
  const client = new HttpOfficePulseClient('https://officepulse.invalid');
  const scope = { context: 'acme' };
  it('uses the published paths, context query, response status and correlation header', async () => {
    const spec = JSON.parse(
      readFileSync(new URL('./fixtures/officepulse-openapi.json', import.meta.url), 'utf8'),
    );
    const fetcher = vi.fn(async (url: URL, init: RequestInit) => {
      expect(url.search).toBe('?context=acme');
      expect(init.redirect).toBe('error');
      expect(new Headers(init.headers).get('x-aida-correlation-id')).toBe('cid');
      expect(init.body).toBeUndefined();
      return new Response(
        JSON.stringify(
          init.method === 'GET'
            ? { handsets: [{ ...device, token: 'strip-me' }] }
            : { status: 'revoked' },
        ),
      );
    });
    vi.stubGlobal('fetch', fetcher);
    expect(await client.listHandsets(scope, 'cid')).toEqual({ handsets: [device] });
    await expect(client.revokeHandset(scope, device.id, 'cid')).resolves.toBeUndefined();
    expect(fetcher.mock.calls.map(([url, init]) => [url.pathname, init.method])).toEqual([
      ['/v1/admin/handsets', 'GET'],
      [`/v1/admin/handsets/${device.id}`, 'DELETE'],
    ]);
    for (const [path, method] of [
      ['/v1/admin/handsets', 'get'],
      ['/v1/admin/handsets/{id}', 'delete'],
    ]) {
      expect(spec.paths[path!][method!].responses['200']).toBeDefined();
      expect(spec.paths[path!][method!].parameters).toContainEqual(
        expect.objectContaining({ name: 'context', required: true }),
      );
    }
  });
  it('refuses leaked contexts and malformed responses, and tolerates older model-less responses', async () => {
    const serve = (body: unknown) =>
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(JSON.stringify(body))),
      );
    serve({ handsets: [{ ...device, context: 'other' }] });
    await expect(client.listHandsets(scope, 'cid')).rejects.toMatchObject({ status: 502 });
    serve({ handsets: [{ ...device, pbxInstanceId: undefined }] });
    await expect(client.listHandsets(scope, 'cid')).rejects.toMatchObject({ status: 502 });
    serve({ handsets: [{ ...device, deviceModel: undefined }] });
    expect((await client.listHandsets(scope, 'cid')).handsets).toHaveLength(1);
    serve({ status: 'unexpected' });
    await expect(client.revokeHandset(scope, device.id, 'cid')).rejects.toMatchObject({
      status: 502,
    });
  });
});
