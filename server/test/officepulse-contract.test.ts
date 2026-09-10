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
const actions: Record<string, (body: unknown) => Promise<unknown>> = {
  listExtensions: () => client.listExtensions(7, cid),
  createExtension: (body) => client.createExtension(7, pbx.createExtensionBody.parse(body), cid),
  deleteExtension: () => client.deleteExtension(7, '100', cid),
  listQueues: () => client.listQueues(7, cid),
  createQueue: (body) => client.createQueue(7, pbx.createQueueBody.parse(body), cid),
  deleteQueue: () => client.deleteQueue(7, 't7.sales', cid),
  putQueueMember: (body) =>
    client.putQueueMember(7, 't7.sales', '100', pbx.memberBody.parse(body), cid),
  deleteQueueMember: () => client.deleteQueueMember(7, 't7.sales', '100', cid),
  listDids: () => client.listDids(7, cid),
  putDid: (body) => client.putDid(7, '+19496501147', pbx.didBody.parse(body), cid),
  deleteDid: () => client.deleteDid(7, '+19496501147', cid),
};
afterEach(() => vi.unstubAllGlobals());
describe('canonical native OfficePulse contract', () => {
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
      const path = new URL(entry.path, 'http://fixture').pathname;
      const matching = Object.keys(spec.paths).find((pattern) =>
        new RegExp(`^${pattern.replace(/\{[^}]+\}/g, '[^/]+')}$`).test(path),
      );
      expect(matching).toBeDefined();
      const operation = spec.paths[matching!][entry.method.toLowerCase()];
      expect(operation.responses[entry.status]).toBeDefined();
      expect(operation.parameters[0].name).toBe('iTenantId');
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
  it('retains no legacy routes or provider fields in the shared PBX schema', () => {
    expect(Object.keys(spec.paths).some((path) => path.includes('/v1/provisioning/'))).toBe(false);
    expect(Object.keys(spec.components.schemas.DidSettings.properties)).toEqual([
      'queue',
      'ringsBeforeAi',
      'schedule',
      'livekitDestination',
    ]);
    expect(pbx.queueStrategy.options).toEqual(
      spec.components.schemas.QueueCreate.properties.strategy.enum,
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
        await client.deleteQueue(7, 't7.sales', cid);
        throw new Error('Expected rejection');
      } catch (error) {
        expect(error).toBeInstanceOf(OfficePulseError);
        expect((error as OfficePulseError).status).toBe(status);
        expect(JSON.stringify(error) + String(error)).not.toContain('must-never-escape');
      }
    },
  );
  it('rejects mismatched tenant inventory and strips unexpected secret fields', async () => {
    const response = cases.find((entry) => entry.name === 'listExtensions')!.response as Record<
      string,
      unknown
    >;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ ...response, iTenantId: 8 }))),
    );
    await expect(client.listExtensions(7, cid)).rejects.toMatchObject({ status: 502 });
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => new Response(JSON.stringify({ ...response, sipSecret: 'not-for-inventory' })),
      ),
    );
    expect(JSON.stringify(await client.listExtensions(7, cid))).not.toContain('not-for-inventory');
  });
});
