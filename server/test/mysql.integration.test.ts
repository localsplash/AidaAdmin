import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import {
  createPool,
  migrate,
  ping,
  MysqlAuthStateRepository,
  MysqlIdentityEventStore,
  MysqlAuditLog,
} from '../src/db/mysql.js';
import type { IdEvent } from '../src/id/client.js';

// Explicit disposable test URL: never fall back to the application's live URL.
const databaseUrl = process.env.AIDA_ADMIN_TEST_DATABASE_URL;
const event = (id: number): IdEvent => ({
  id,
  type: 'session.revoked',
  occurredAt: new Date().toISOString(),
  data: { iUserId: 42 },
});

describe.skipIf(!databaseUrl)('MySQL Admin persistence', () => {
  let pool: Pool;
  beforeAll(async () => {
    pool = createPool(databaseUrl!);
    await migrate(pool);
    await migrate(pool);
    for (const table of [
      'admin_tbl_AuthState',
      'admin_tbl_IdentityEvent',
      'admin_tbl_EventCursor',
      'admin_tbl_Audit',
    ])
      await pool.query(`DELETE FROM ${table}`);
  });
  afterAll(async () => {
    await pool?.end();
  });
  it('is ready and creates no local authoritative sessions or users', async () => {
    expect(await ping(pool)).toBe(true);
    const [clock] = await pool.query<RowDataPacket[]>('SELECT @@session.time_zone AS zone');
    expect(clock[0]?.zone).toBe('+00:00');
    const [rows] = await pool.query<RowDataPacket[]>('SHOW TABLES');
    const names = rows.flatMap((row) => Object.values(row));
    expect(names).not.toContain('admin_session');
    expect(names).not.toContain('identity_tbl_User');
    expect(names).toContain('admin_tbl_Audit');
  });
  it('allows exactly one concurrent consumer of an unexpired hashed OAuth state', async () => {
    const states = new MysqlAuthStateRepository(pool);
    const token = await states.issue();
    const results = await Promise.all(Array.from({ length: 8 }, () => states.consume(token)));
    expect(results.filter(Boolean)).toHaveLength(1);
    const [rows] = await pool.query<RowDataPacket[]>('SELECT sStateHash FROM admin_tbl_AuthState');
    expect(rows[0]?.sStateHash).not.toBe(token);
    expect(await states.consume('unknown')).toBe(false);
  });
  it('does not let out-of-order webhooks skip ordered replay', async () => {
    const events = new MysqlIdentityEventStore(pool);
    expect(await events.process(event(100), async () => {})).toBe('applied');
    expect(await events.checkpoint()).toBe(0);
    expect(
      await events.process(event(100), async () => {
        throw new Error('duplicate');
      }),
    ).toBe('duplicate');
    expect(await events.process(event(99), async () => {})).toBe('applied');
    await events.advanceReplayCursor(100);
    expect(await events.checkpoint()).toBe(100);
  });
  it('rolls back a failed receipt so the delivery can retry', async () => {
    const events = new MysqlIdentityEventStore(pool);
    await expect(
      events.process(event(101), async () => {
        throw new Error('effect failed');
      }),
    ).rejects.toThrow('effect failed');
    const [rows] = await pool.query<RowDataPacket[]>(
      'SELECT * FROM admin_tbl_IdentityEvent WHERE iEventId = 101',
    );
    expect(rows).toHaveLength(0);
    expect(await events.process(event(101), async () => {})).toBe('applied');
  });
  it('persists a tenant-scoped audit without copying user profiles', async () => {
    await new MysqlAuditLog(pool).append({
      tenantId: '5',
      actorIdentityUserId: 42,
      action: 'extension.create',
      entityType: 'extension',
      entityId: 'ext-1',
    });
    const [rows] = await pool.query<RowDataPacket[]>(
      'SELECT iTenantId, iActorUserId FROM admin_tbl_Audit',
    );
    expect(Number(rows[0]?.iTenantId)).toBe(5);
    expect(Number(rows[0]?.iActorUserId)).toBe(42);
  });
});
