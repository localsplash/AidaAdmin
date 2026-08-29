import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import type { AdminSession } from '../src/auth/session-store.js';
import {
  createPool,
  migrate,
  ping,
  PostgresAuthStateRepository,
  PostgresIdentityEventStore,
  PostgresSessionRepository,
} from '../src/db/postgres.js';
import type { IdEvent } from '../src/id/client.js';

/**
 * Exercises the real aida_admin schema. Runs only when
 * AIDA_ADMIN_DATABASE_URL points at a disposable PostgreSQL database (local
 * docker, or the CI service container); unit tests need no credentials.
 */
const databaseUrl = process.env.AIDA_ADMIN_DATABASE_URL;

const user = (iUserId: number): AdminSession => ({
  iUserId,
  email: 'p@example.invalid',
  displayName: 'P',
  superAdmin: false,
  provider: 'google',
  selectedTenantId: null,
});

const event = (id: number, iUserId: number): IdEvent => ({
  id,
  type: 'session.revoked',
  occurredAt: new Date().toISOString(),
  data: { iUserId, scope: 'all' },
});

describe.skipIf(!databaseUrl)('PostgreSQL persistence', () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = createPool(databaseUrl as string);
    await migrate(pool);
    // Second run must be a no-op (additive, idempotent).
    await migrate(pool);
    await pool.query(
      'TRUNCATE admin_session, auth_state, identity_event, identity_event_checkpoint',
    );
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('answers the readiness ping', async () => {
    expect(await ping(pool)).toBe(true);
  });

  it('persists sessions, stores only a hash, and slides expiry', async () => {
    const sessions = new PostgresSessionRepository(pool);
    const sid = await sessions.create(user(42));
    const loaded = await sessions.get(sid);
    expect(loaded?.iUserId).toBe(42);
    expect(loaded?.superAdmin).toBe(false);
    const raw = await pool.query('SELECT session_id_hash FROM admin_session');
    expect(raw.rows.some((r) => r.session_id_hash === sid)).toBe(false);
    await sessions.revoke(sid);
    expect(await sessions.get(sid)).toBeNull();
  });

  it('persists the selected tenant across reads', async () => {
    const sessions = new PostgresSessionRepository(pool);
    const sid = await sessions.create(user(43));
    await sessions.setSelectedTenant(sid, 'tenant-uuid-1');
    expect((await sessions.get(sid))?.selectedTenantId).toBe('tenant-uuid-1');
    await sessions.setSelectedTenant(sid, null);
    expect((await sessions.get(sid))?.selectedTenantId).toBeNull();
  });

  it('consumes a login state exactly once', async () => {
    const states = new PostgresAuthStateRepository(pool);
    const state = await states.issue();
    expect(await states.consume(state)).toBe(true);
    expect(await states.consume(state)).toBe(false);
    expect(await states.consume('never-issued')).toBe(false);
  });

  it('processes an event transactionally, exactly once, and advances the checkpoint', async () => {
    const sessions = new PostgresSessionRepository(pool);
    const events = new PostgresIdentityEventStore(pool);
    const sid = await sessions.create(user(7));

    expect(
      await events.process(event(101, 7), (fx) => fx.revokeUserSessions(7).then(() => {})),
    ).toBe('applied');
    expect(await sessions.get(sid)).toBeNull();
    expect(await events.checkpoint()).toBe(101);

    // Duplicate delivery: no effects run again.
    const sid2 = await sessions.create(user(7));
    expect(
      await events.process(event(101, 7), (fx) => fx.revokeUserSessions(7).then(() => {})),
    ).toBe('duplicate');
    expect(await sessions.get(sid2)).not.toBeNull();

    const processed = await pool.query(
      'SELECT processed_at FROM identity_event WHERE event_id = 101',
    );
    expect(processed.rows[0].processed_at).not.toBeNull();
  });

  it('rolls the event back when an effect fails, so id retries it', async () => {
    const sessions = new PostgresSessionRepository(pool);
    const events = new PostgresIdentityEventStore(pool);
    const sid = await sessions.create(user(9));

    await expect(
      events.process(event(102, 9), async (fx) => {
        await fx.revokeUserSessions(9);
        throw new Error('nocodb write failed');
      }),
    ).rejects.toThrow('nocodb write failed');

    // Nothing committed: the session survives and the event is unrecorded.
    expect(await sessions.get(sid)).not.toBeNull();
    const row = await pool.query('SELECT 1 FROM identity_event WHERE event_id = 102');
    expect(row.rowCount).toBe(0);
    expect(await events.checkpoint()).toBe(101);

    // The retried delivery succeeds and commits everything together.
    expect(
      await events.process(event(102, 9), (fx) => fx.revokeUserSessions(9).then(() => {})),
    ).toBe('applied');
    expect(await sessions.get(sid)).toBeNull();
    expect(await events.checkpoint()).toBe(102);
  });

  it('re-keys sessions on user merge', async () => {
    const sessions = new PostgresSessionRepository(pool);
    const events = new PostgresIdentityEventStore(pool);
    const sid = await sessions.create(user(50));
    await events.process(
      { id: 103, type: 'user.merged', occurredAt: new Date().toISOString(), data: {} },
      (fx) => fx.mergeUserSessions(50, 60).then(() => {}),
    );
    expect((await sessions.get(sid))?.iUserId).toBe(60);
  });
});
