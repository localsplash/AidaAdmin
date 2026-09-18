import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpOfficePulseClient, OfficePulseError } from '../src/officepulse/client.js';
import * as pbx from '../src/officepulse/pbx-contract.js';

// These files are verbatim OfficePulse fixtures. Its HTTP suite proves it accepts
// every request and emits these responses; this suite proves the BFF agrees.
const cases = JSON.parse(
  readFileSync(new URL('./fixtures/native-pbx-contract.json', import.meta.url), 'utf8'),
) as {
  name: string;
  method: string;
  path: string;
  status: number;
  body?: unknown;
  response?: unknown;
}[];
const spec = JSON.parse(
  readFileSync(new URL('./fixtures/officepulse-openapi.json', import.meta.url), 'utf8'),
);
const client = new HttpOfficePulseClient('https://private.officepulse.invalid');
const cid = 'contract-correlation';
// The fixture's scope: one extension context and the shared carrier ingress
// context. The customer tenant is never part of any request.
const scope = { context: 'tenant-seven' };
const didScope = { context: 'tenant-seven', didContext: 'from-carrier' };
const queue = 'tenant-seven.sales';
const actions: Record<string, (body: unknown) => Promise<unknown>> = {
  listContexts: () => client.listContexts(cid),
  listExtensions: () => client.listExtensions(scope, cid),
  createExtension: (body) =>
    client.createExtension(scope, pbx.createExtensionBody.parse(body), cid),
  deleteExtension: () => client.deleteExtension(scope, '100', cid),
  listQueues: () => client.listQueues(scope, cid),
  createQueue: (body) => client.createQueue(scope, pbx.createQueueBody.parse(body), cid),
  deleteQueue: () => client.deleteQueue(scope, queue, cid),
  putQueueMember: (body) =>
    client.putQueueMember(scope, queue, '100', pbx.memberBody.parse(body), cid),
  deleteQueueMember: () => client.deleteQueueMember(scope, queue, '100', cid),
  listDids: () => client.listDids(didScope, cid, ['+19496501147']),
  putDid: (body) =>
    client.putDid(didScope, '+19496501147', pbx.didBody.parse(body), cid, ['+19496501147']),
  deleteDid: () => client.deleteDid(didScope, '+19496501147', cid, ['+19496501147']),
};
const parameters = (operation: { parameters?: Array<{ name: string; in: string }> }) =>
  (operation.parameters ?? []).filter((p) => p.in === 'query').map((p) => p.name);
afterEach(() => vi.unstubAllGlobals());
describe('canonical native OfficePulse contract', () => {
  it('covers every client action with a fixture entry', () => {
    expect(cases.map((entry) => entry.name).sort()).toEqual(Object.keys(actions).sort());
  });
  it.each(cases)(
    '$name matches the published method, encoded path, body and response',
    async (entry) => {
      const upstream = vi.fn(async (url: URL, init: RequestInit) => {
        expect(url.origin).toBe('https://private.officepulse.invalid');
        expect(url.pathname + url.search).toBe(entry.path);
        expect(init.method).toBe(entry.method);
        expect(init.body ? JSON.parse(String(init.body)) : undefined).toEqual(entry.body);
        expect(init.redirect).toBe('error');
        expect(init.signal).toBeInstanceOf(AbortSignal);
        expect(new Headers(init.headers).get('x-aida-correlation-id')).toBe(cid);
        return new Response(entry.status === 204 ? null : JSON.stringify(entry.response), {
          status: entry.status,
        });
      });
      vi.stubGlobal('fetch', upstream);
      expect(await actions[entry.name]!(entry.body)).toEqual(entry.response);
      expect(upstream).toHaveBeenCalledOnce();
      // The retired tenant scope appears nowhere on the wire.
      expect(entry.path).not.toContain('iTenantId');
      expect(JSON.stringify(entry.response ?? {})).not.toContain('iTenantId');
      const url = new URL(entry.path, 'http://fixture');
      const matching = Object.keys(spec.paths).find((pattern) =>
        new RegExp(`^${pattern.replace(/\{[^}]+\}/g, '[^/]+')}$`).test(url.pathname),
      );
      expect(matching).toBeDefined();
      const operation = spec.paths[matching!][entry.method.toLowerCase()];
      expect(operation.responses[entry.status]).toBeDefined();
      const query = parameters(operation);
      if (entry.name === 'listContexts') {
        expect(query).toEqual([]);
        expect(url.search).toBe('');
      } else {
        expect(query[0]).toBe('context');
        expect(url.searchParams.getAll('context')).toEqual([didScope.context]);
        expect(query.includes('didContext')).toBe(url.pathname.includes('/dids'));
        if (query.includes('didContext'))
          expect(url.searchParams.getAll('didContext')).toEqual([didScope.didContext]);
        else expect(url.searchParams.has('didContext')).toBe(false);
      }
      if (entry.response && typeof entry.response === 'object' && 'source' in entry.response) {
        expect(entry.response).toMatchObject({
          source: 'asterisk',
          pbxInstanceId: 'officepulse-fixture',
        });
        if (entry.name !== 'listContexts')
          expect(entry.response).toMatchObject({
            context: 'tenant-seven',
            provisioningEnabled: true,
          });
        if (entry.name === 'listDids')
          expect(entry.response).toMatchObject({ didContext: 'from-carrier' });
      }
      if (entry.body) {
        const key = operation.requestBody.content['application/json'].schema.$ref.split('/').at(-1);
        expect(Object.keys(entry.body)).toEqual(
          expect.arrayContaining(spec.components.schemas[key].required),
        );
        expect(
          Object.keys(entry.body).every(
            (field) => field in spec.components.schemas[key].properties,
          ),
        ).toBe(true);
      }
    },
  );
  it('retains no legacy routes, tenant parameters or provider fields in the shared PBX schema', () => {
    expect(Object.keys(spec.paths).some((path) => path.includes('/v1/provisioning/'))).toBe(false);
    for (const [path, operations] of Object.entries(spec.paths) as [string, object][]) {
      if (!path.startsWith('/v1/admin/pbx/')) continue;
      for (const operation of Object.values(operations))
        expect(parameters(operation as { parameters?: [] })).not.toContain('iTenantId');
    }
    expect(Object.keys(spec.components.schemas.DidSettings.properties)).toEqual([
      'queue',
      'ringsBeforeAi',
      'schedule',
      'livekitDestination',
    ]);
    expect(pbx.queueStrategy.options).toEqual(
      spec.components.schemas.QueueCreate.properties.strategy.enum,
    );
    expect(spec.components.schemas.Extension.properties.managed.type).toBe('boolean');
    expect(spec.components.schemas.ContextInventory.required).toEqual([
      'source',
      'pbxInstanceId',
      'contexts',
    ]);
    expect(spec.components.schemas.DidInventory.required).toContain('didContext');
    expect(spec.components.schemas.Readiness.properties.pbxInstanceId).toBeDefined();
    for (const name of ['ExtensionInventory', 'QueueInventory', 'DidInventory'])
      expect(spec.components.schemas[name].required).toEqual(
        expect.arrayContaining(['source', 'pbxInstanceId', 'context', 'provisioningEnabled']),
      );
  });
  it.each([404, 409, 422, 503, 500])(
    'maps status %s without retaining an upstream body',
    async (status) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('SQL secret=must-never-escape', { status })),
      );
      try {
        await client.deleteQueue(scope, queue, cid);
        throw new Error('Expected rejection');
      } catch (error) {
        expect(error).toBeInstanceOf(OfficePulseError);
        expect((error as OfficePulseError).status).toBe(status);
        expect(JSON.stringify(error) + String(error)).not.toContain('must-never-escape');
      }
    },
  );
  it('rejects a mismatched context echo, a missing instance, and strips unexpected secret fields', async () => {
    const response = cases.find((entry) => entry.name === 'listExtensions')!.response as Record<
      string,
      unknown
    >;
    const serve = (body: unknown) =>
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(JSON.stringify(body))),
      );
    serve({ ...response, context: 'tenant-eight' });
    await expect(client.listExtensions(scope, cid)).rejects.toMatchObject({ status: 502 });
    serve({ ...response, pbxInstanceId: undefined });
    await expect(client.listExtensions(scope, cid)).rejects.toMatchObject({ status: 502 });
    serve({ ...response, iTenantId: 7 });
    expect(await client.listExtensions(scope, cid)).not.toHaveProperty('iTenantId');
    serve({ ...response, sipSecret: 'not-for-inventory' });
    expect(JSON.stringify(await client.listExtensions(scope, cid))).not.toContain(
      'not-for-inventory',
    );
    const dids = cases.find((entry) => entry.name === 'listDids')!.response as Record<
      string,
      unknown
    >;
    serve({ ...dids, didContext: 'tenant-seven' });
    await expect(client.listDids(didScope, cid, ['+19496501147'])).rejects.toMatchObject({
      status: 502,
    });
  });
  it('reads the PBX instance from readiness and tolerates its absence', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ pbxInstanceId: 'officepulse-fixture', ready: true, components: {} }),
          ),
      ),
    );
    expect(await client.readiness()).toMatchObject({
      reachable: true,
      ready: true,
      pbxInstanceId: 'officepulse-fixture',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ ready: false, pbxInstanceId: 'bad id!' }))),
    );
    expect(await client.readiness()).not.toHaveProperty('pbxInstanceId');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('down');
      }),
    );
    expect(await client.readiness()).toMatchObject({ reachable: false });
  });
});
