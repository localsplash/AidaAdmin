import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createDeps, type AppDeps } from '../src/deps.js';
import type { IdClient, IdEvent, IdRedeemResult } from '../src/id/client.js';
import { catchUpIdEvents, IdEventState, processIdEvent } from '../src/id/events.js';
import { createLogger } from '../src/logger.js';

const logger = createLogger({ logLevel: 'fatal' });

function eventsApp(env: NodeJS.ProcessEnv) {
  const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'fatal', ...env });
  const deps: AppDeps = createDeps(config);
  return { app: createApp(config, logger, deps), deps };
}

function makeSession(deps: AppDeps, iUserId: number) {
  return deps.sessionStore.create({
    iUserId,
    email: null,
    displayName: null,
    superAdmin: false,
    idSessionId: `id-session-${iUserId}`,
    provider: null,
  });
}

const revokeEvent = (id: number, iUserId: number): IdEvent => ({
  id,
  type: 'session.revoked',
  occurredAt: new Date().toISOString(),
  data: { iUserId },
});

describe('POST /id/events CIDR policy', () => {
  it('accepts events from an allowed source', async () => {
    // Supertest connects from loopback.
    const { app, deps } = eventsApp({ ID_EVENT_SOURCE_CIDRS: '127.0.0.1/32' });
    makeSession(deps, 42);
    const res = await request(app).post('/id/events').send(revokeEvent(1, 42));
    expect(res.status).toBe(200);
    expect(deps.sessionStore.count()).toBe(0);
  });

  it('rejects events from a denied source', async () => {
    const { app, deps } = eventsApp({ ID_EVENT_SOURCE_CIDRS: '10.0.0.0/8' });
    makeSession(deps, 42);
    const res = await request(app).post('/id/events').send(revokeEvent(1, 42));
    expect(res.status).toBe(403);
    expect(deps.sessionStore.count()).toBe(1);
  });

  it('honors forwarding only from a trusted proxy peer', async () => {
    const { app } = eventsApp({
      ID_EVENT_SOURCE_CIDRS: '203.0.113.0/24',
      ID_TRUSTED_PROXY_CIDRS: '127.0.0.1/32',
    });
    const res = await request(app)
      .post('/id/events')
      .set('x-forwarded-for', '203.0.113.9')
      .send(revokeEvent(1, 1));
    expect(res.status).toBe(200);
  });

  it('ignores spoofed X-Forwarded-For from an untrusted peer', async () => {
    const { app } = eventsApp({
      ID_EVENT_SOURCE_CIDRS: '203.0.113.0/24',
      // Loopback is NOT a trusted proxy here, so the forwarded value is spoofing.
    });
    const res = await request(app)
      .post('/id/events')
      .set('x-forwarded-for', '203.0.113.9')
      .send(revokeEvent(1, 1));
    expect(res.status).toBe(403);
  });

  it('rejects malformed event bodies', async () => {
    const { app } = eventsApp({ ID_EVENT_SOURCE_CIDRS: '127.0.0.1/32' });
    const res = await request(app).post('/id/events').send({ type: 'session.revoked' });
    expect(res.status).toBe(400);
  });
});

describe('event processing', () => {
  it('is idempotent for duplicate deliveries', () => {
    const deps = baseDeps();
    makeSession(deps, 42);
    processIdEvent(revokeEvent(5, 42), deps, logger);
    expect(deps.sessionStore.count()).toBe(0);
    // The user signs in again; a duplicate of the old event must not revoke.
    makeSession(deps, 42);
    processIdEvent(revokeEvent(5, 42), deps, logger);
    expect(deps.sessionStore.count()).toBe(1);
  });

  it('revokes by id session identifier', () => {
    const deps = baseDeps();
    makeSession(deps, 42);
    processIdEvent(
      {
        id: 6,
        type: 'session.revoked',
        occurredAt: new Date().toISOString(),
        data: { sessionId: 'id-session-42' },
      },
      deps,
      logger,
    );
    expect(deps.sessionStore.count()).toBe(0);
  });

  it('re-keys sessions on user.merged', () => {
    const deps = baseDeps();
    const session = makeSession(deps, 42);
    processIdEvent(
      {
        id: 7,
        type: 'user.merged',
        occurredAt: new Date().toISOString(),
        data: { fromUserId: 42, toUserId: 99 },
      },
      deps,
      logger,
    );
    expect(deps.sessionStore.get(session.sid)?.iUserId).toBe(99);
  });

  it('acknowledges identity link events without local effect', () => {
    const deps = baseDeps();
    makeSession(deps, 42);
    processIdEvent(
      { id: 8, type: 'identity.linked', occurredAt: new Date().toISOString(), data: {} },
      deps,
      logger,
    );
    expect(deps.sessionStore.count()).toBe(1);
    expect(deps.eventState.cursor).toBe(8);
  });
});

describe('boot-time catch-up', () => {
  it('requests events after the durable cursor and applies them once', async () => {
    const deps = baseDeps();
    makeSession(deps, 42);
    processIdEvent(revokeEvent(3, 1), deps, logger);

    const seen: number[] = [];
    const idClient: IdClient = {
      async redeemCode(): Promise<IdRedeemResult> {
        throw new Error('unused');
      },
      async listEvents(since: number): Promise<IdEvent[]> {
        seen.push(since);
        return [revokeEvent(3, 1), revokeEvent(4, 42)];
      },
      async registerWebhook(): Promise<void> {},
    };

    await catchUpIdEvents(idClient, deps, logger);
    expect(seen).toEqual([3]);
    expect(deps.sessionStore.count()).toBe(0);
    expect(deps.eventState.cursor).toBe(4);
  });
});

function baseDeps(): AppDeps {
  const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'fatal' });
  return { ...createDeps(config), eventState: new IdEventState(null) };
}
