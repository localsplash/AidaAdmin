import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpRuntimeReader } from '../src/officepulse/runtime.js';
import { OfficePulseError } from '../src/officepulse/client.js';

/** OfficePulse's wire shape: absent optional fields are omitted, not null. */
const wireSession = {
  id: 'call-1',
  asteriskLinkedId: 'l1',
  officePulseInstanceId: 'op',
  pbxContext: 'tenant-seven',
  tenantId: 'ten-1',
  didE164: '+15105550100',
  config: { didRouteId: 'r1', didRouteRevision: 3 },
  roomName: 'aida-call-1',
  destinationType: 'EXTENSION',
  disposition: 'SCREEN',
  state: 'screening',
  version: 2,
  createdAt: '2026-09-02T10:00:00.000Z',
};

let requests: string[] = [];
function answer(status: number, body: unknown) {
  requests = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: URL | string) => {
      requests.push(String(url));
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
}
afterEach(() => vi.unstubAllGlobals());

const reader = new HttpRuntimeReader('http://officepulse.internal:8085');
// OfficePulse's published OpenAPI document, copied verbatim (see officepulse-contract.test.ts).
const spec = JSON.parse(
  readFileSync(new URL('./fixtures/officepulse-openapi.json', import.meta.url), 'utf8'),
) as {
  paths: Record<string, Record<string, { parameters?: Array<{ name: string; in: string }> }>>;
};

/** The documented GET operation a concrete URL hits, matching `{id}` segments. */
function documented(url: string) {
  const { pathname, searchParams } = new URL(url);
  const entry = Object.entries(spec.paths).find(([template]) =>
    new RegExp(`^${template.replace(/\{[^}]+\}/g, '[^/]+')}$`).test(pathname),
  );
  const operation = entry?.[1].get;
  const names = (operation?.parameters ?? []).filter((p) => p.in === 'query').map((p) => p.name);
  return { operation, undocumented: [...searchParams.keys()].filter((k) => !names.includes(k)) };
}

describe('HttpRuntimeReader', () => {
  it('asks OfficePulse for each view with explicit filters', async () => {
    answer(200, {
      calls: [],
      events: [],
      commands: [],
      participants: [],
      deliveries: [],
      dependencies: [],
    });
    await reader.listCallSessions({ state: 'orphaned', tenantId: 'ten 1', limit: 20 });
    await reader.listCallSessions({ state: 'all' });
    await reader.listCallEvents('call/1');
    await reader.listControlCommands('call-1');
    await reader.listParticipants('call-1');
    await reader.listWebhookDeliveries(5);
    await reader.listDependencyStatus();
    await reader.listFailedCommands(24, 'ten-1');
    await reader.listEventsOfType(['fallback', 'aida-lost'], 6);
    expect(requests.map((url) => url.replace('http://officepulse.internal:8085', ''))).toEqual([
      '/v1/admin/calls?state=orphaned&tenantId=ten+1&limit=20',
      '/v1/admin/calls?state=all',
      '/v1/admin/calls/call%2F1/events',
      '/v1/admin/calls/call-1/commands',
      '/v1/admin/calls/call-1/participants',
      '/v1/admin/runtime/webhook-deliveries?limit=5',
      '/v1/admin/runtime/dependencies',
      '/v1/admin/runtime/failed-commands?sinceHours=24&tenantId=ten-1',
      '/v1/admin/runtime/events?type=fallback&type=aida-lost&sinceHours=6',
    ]);
    for (const url of requests) {
      const { operation, undocumented } = documented(url);
      expect(operation, url).toBeDefined();
      expect(undocumented, url).toEqual([]);
    }
  });

  it('maps omitted optional fields to nulls', async () => {
    answer(200, wireSession);
    expect(await reader.getCallSession('call-1')).toEqual({
      id: 'call-1',
      asteriskLinkedId: 'l1',
      officePulseInstanceId: 'op',
      tenantId: 'ten-1',
      didE164: '+15105550100',
      callerNumber: null,
      config: {
        didRouteId: 'r1',
        didRouteRevision: 3,
        profileId: null,
        profileRevision: null,
        tenantRevision: null,
      },
      roomName: 'aida-call-1',
      agentParticipantSid: null,
      destinationType: 'EXTENSION',
      destinationId: null,
      disposition: 'SCREEN',
      state: 'screening',
      version: 2,
      createdAt: '2026-09-02T10:00:00.000Z',
      endedAt: null,
    });
    answer(200, {
      commands: [
        {
          idempotencyKey: 'k',
          commandType: 'TAKEOVER',
          status: 'failed',
          createdAt: 't',
          callSessionId: 'call-1',
          tenantId: 'ten-1',
        },
      ],
    });
    expect(await reader.listFailedCommands(24)).toEqual([
      {
        idempotencyKey: 'k',
        commandType: 'TAKEOVER',
        payload: null,
        status: 'failed',
        result: null,
        createdAt: 't',
        completedAt: null,
        callSessionId: 'call-1',
        tenantId: 'ten-1',
      },
    ]);
  });

  it("treats a missing call and another tenant's call alike", async () => {
    answer(404, { error: 'not_found' });
    expect(await reader.getCallSession('missing')).toBeNull();
    answer(200, wireSession);
    expect(await reader.getCallSession('call-1', 'ten-2')).toBeNull();
    expect(await reader.getCallSession('call-1', 'ten-1')).not.toBeNull();
  });

  it('returns only events after the given sequence', async () => {
    answer(200, {
      events: [1, 2, 3].map((sequenceNumber) => ({
        sequenceNumber,
        eventType: 'e',
        createdAt: 't',
      })),
    });
    expect((await reader.listCallEvents('call-1', 1)).map((e) => e.sequenceNumber)).toEqual([2, 3]);
  });

  it('asks for nothing when no event types are wanted', async () => {
    answer(200, { events: [] });
    expect(await reader.listEventsOfType([], 24)).toEqual([]);
    expect(requests).toEqual([]);
  });

  it('turns upstream failures into OfficePulseError without keeping the body', async () => {
    answer(500, { error: 'ER_ACCESS_DENIED_ERROR at 10.0.0.5' });
    const failure = await reader.listDependencyStatus().catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(OfficePulseError);
    expect((failure as OfficePulseError).status).toBe(500);
    expect(String((failure as Error).message)).not.toMatch(/ER_ACCESS|10\.0\.0\.5/);

    answer(200, { dependencies: [{ name: 'ari' }] });
    await expect(reader.listDependencyStatus()).rejects.toMatchObject({ status: 502 });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );
    await expect(reader.listCallSessions({ state: 'all' })).rejects.toMatchObject({ status: 503 });
  });
});
