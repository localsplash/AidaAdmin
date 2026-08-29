import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { loadConfig, type AppConfig } from '../src/config.js';
import { createDeps, type AppDeps } from '../src/deps.js';
import {
  MemoryAuthDb,
  MemorySessionRepository,
  type AdminSession,
} from '../src/auth/session-store.js';
import type { IdClient, IdEvent, IdRedeemResult } from '../src/id/client.js';
import { MemoryIdentityEventStore } from '../src/id/event-store.js';
import { catchUpIdEvents, processIdEvent } from '../src/id/events.js';
import { createLogger } from '../src/logger.js';

const logger = createLogger({ logLevel: 'fatal' });

interface TestSetup {
  config: AppConfig;
  deps: AppDeps;
  db: MemoryAuthDb;
  sessions: MemorySessionRepository;
}

function setup(env: NodeJS.ProcessEnv = {}): TestSetup {
  const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'fatal', ...env });
  const db = new MemoryAuthDb();
  const sessions = new MemorySessionRepository(db);
  const deps: AppDeps = {
    ...createDeps(config),
    sessionStore: sessions,
    eventStore: new MemoryIdentityEventStore(db),
  };
  return { config, deps, db, sessions };
}

const user = (iUserId: number): AdminSession => ({
  iUserId,
  email: null,
  displayName: null,
  superAdmin: false,
  provider: null,
  selectedTenantId: null,
});

const revokeEvent = (id: number, iUserId: number, scope: 'one' | 'all' = 'all'): IdEvent => ({
  id,
  type: 'session.revoked',
  occurredAt: new Date().toISOString(),
  data: { iUserId, scope },
});

describe('POST /id/events CIDR policy', () => {
  it('accepts events from an allowed source and applies them before the 2xx', async () => {
    // Supertest connects from loopback.
    const s = setup({ ID_EVENT_SOURCE_CIDRS: '127.0.0.1/32' });
    const app = createApp(s.config, logger, s.deps);
    await s.sessions.create(user(42));
    const res = await request(app).post('/id/events').send(revokeEvent(1, 42));
    expect(res.status).toBe(200);
    expect(s.db.count()).toBe(0);
  });

  it('rejects events from a denied source', async () => {
    const s = setup({ ID_EVENT_SOURCE_CIDRS: '10.0.0.0/8' });
    const app = createApp(s.config, logger, s.deps);
    await s.sessions.create(user(42));
    const res = await request(app).post('/id/events').send(revokeEvent(1, 42));
    expect(res.status).toBe(403);
    expect(s.db.count()).toBe(1);
  });

  it('honors forwarding only from a trusted proxy peer', async () => {
    const s = setup({
      ID_EVENT_SOURCE_CIDRS: '203.0.113.0/24',
      ID_TRUSTED_PROXY_CIDRS: '127.0.0.1/32',
    });
    const app = createApp(s.config, logger, s.deps);
    const res = await request(app)
      .post('/id/events')
      .set('x-forwarded-for', '203.0.113.9')
      .send(revokeEvent(1, 1));
    expect(res.status).toBe(200);
  });

  it('ignores spoofed X-Forwarded-For from an untrusted peer', async () => {
    const s = setup({
      ID_EVENT_SOURCE_CIDRS: '203.0.113.0/24',
      // Loopback is NOT a trusted proxy here, so the forwarded value is spoofing.
    });
    const app = createApp(s.config, logger, s.deps);
    const res = await request(app)
      .post('/id/events')
      .set('x-forwarded-for', '203.0.113.9')
      .send(revokeEvent(1, 1));
    expect(res.status).toBe(403);
  });

  it('rejects malformed event bodies', async () => {
    const s = setup({ ID_EVENT_SOURCE_CIDRS: '127.0.0.1/32' });
    const app = createApp(s.config, logger, s.deps);
    const res = await request(app).post('/id/events').send({ type: 'session.revoked' });
    expect(res.status).toBe(400);
  });
});

describe('event processing', () => {
  it('is idempotent for duplicate deliveries', async () => {
    const s = setup();
    await s.sessions.create(user(42));
    expect(await processIdEvent(revokeEvent(5, 42), s.deps, logger)).toBe('applied');
    expect(s.db.count()).toBe(0);
    // The user signs in again; a duplicate of the old event must not revoke.
    await s.sessions.create(user(42));
    expect(await processIdEvent(revokeEvent(5, 42), s.deps, logger)).toBe('duplicate');
    expect(s.db.count()).toBe(1);
  });

  it('revokes every local session for the user on scope "one"', async () => {
    // id's /api/token response has no session id, so a targeted revocation
    // cannot be mapped; the POC revokes all local sessions for the user.
    const s = setup();
    await s.sessions.create(user(42));
    await s.sessions.create(user(42));
    await s.sessions.create(user(7));
    await processIdEvent(revokeEvent(6, 42, 'one'), s.deps, logger);
    expect(s.db.count()).toBe(1);
  });

  it('re-keys sessions on user.merged', async () => {
    const s = setup();
    const sid = await s.sessions.create(user(42));
    await processIdEvent(
      {
        id: 7,
        type: 'user.merged',
        occurredAt: new Date().toISOString(),
        data: { fromUserId: 42, toUserId: 99 },
      },
      s.deps,
      logger,
    );
    expect((await s.sessions.get(sid))?.iUserId).toBe(99);
  });

  it('acknowledges identity link events without local effect', async () => {
    const s = setup();
    await s.sessions.create(user(42));
    await processIdEvent(
      { id: 8, type: 'identity.linked', occurredAt: new Date().toISOString(), data: {} },
      s.deps,
      logger,
    );
    expect(s.db.count()).toBe(1);
    expect(await s.deps.eventStore.checkpoint()).toBe(8);
  });
});

describe('boot-time catch-up', () => {
  it('reads {items} pages after the durable checkpoint and applies each once', async () => {
    const s = setup();
    await s.sessions.create(user(42));
    await processIdEvent(revokeEvent(3, 1), s.deps, logger);

    const seen: number[] = [];
    const idClient: IdClient = {
      async redeemCode(): Promise<IdRedeemResult> {
        throw new Error('unused');
      },
      async listEvents(since: number): Promise<IdEvent[]> {
        seen.push(since);
        return since < 4 ? [revokeEvent(3, 1), revokeEvent(4, 42)] : [];
      },
      async registerWebhook(): Promise<void> {},
      async ensureDirectoryUser(): Promise<never> {
        throw new Error('unused');
      },
      async getDirectoryUser(): Promise<null> {
        return null;
      },
      async searchDirectoryUsers(): Promise<never[]> {
        return [];
      },
    };

    const applied = await catchUpIdEvents(idClient, s.deps, logger);
    expect(seen).toEqual([3]);
    expect(applied).toBe(1);
    expect(s.db.count()).toBe(0);
    expect(await s.deps.eventStore.checkpoint()).toBe(4);
  });
});
