import { createHash, randomBytes, randomUUID } from 'node:crypto';
import mysql, { type Pool, type ResultSetHeader, type RowDataPacket } from 'mysql2/promise';
import type { AuthStateRepository } from '../auth/state-store.js';
import { STATE_TTL_MS } from '../auth/state-store.js';
import type { IdEvent } from '../id/client.js';
import type { IdentityEffects, IdentityEventStore } from '../id/event-store.js';
import type { AuditEntry } from '../nocodb/repos.js';

/** Admin owns only transient OAuth state, event receipts and its audit trail.
 * Users, organizations, memberships and application sessions belong to Identity.
 */
export function createPool(databaseUrl: string): Pool {
  const url = new URL(databaseUrl);
  if (url.protocol !== 'mysql:' || url.pathname !== '/aida_admin_db') {
    throw new Error(
      'AIDA_ADMIN_DATABASE_URL must use mysql and the dedicated aida_admin_db database',
    );
  }
  if (url.search || url.hash)
    throw new Error('AIDA_ADMIN_DATABASE_URL must not contain query or fragment overrides');
  const pool = mysql.createPool({
    host: url.hostname,
    port: Number(url.port || 3306),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: 'aida_admin_db',
    connectionLimit: 5,
    timezone: 'Z',
    charset: 'utf8mb4',
  });
  pool.on('connection', (connection) => {
    connection.query("SET time_zone = '+00:00'");
  });
  return pool;
}

export async function migrate(pool: Pool): Promise<void> {
  const connection = await pool.getConnection();
  let locked = false;
  try {
    const [rows] = await connection.query<RowDataPacket[]>(
      "SELECT GET_LOCK('aida_admin_db:migrate', 30) AS acquired",
    );
    if (Number(rows[0]?.acquired) !== 1) throw new Error('Admin schema migration lock unavailable');
    locked = true;
    // MySQL DDL commits implicitly: every statement is repeatable after interruption.
    for (const ddl of [
      `CREATE TABLE IF NOT EXISTS admin_tbl_Migration (
        iVersion INT PRIMARY KEY, dtApplied DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
      ) ENGINE=InnoDB`,
      `CREATE TABLE IF NOT EXISTS admin_tbl_AuthState (
        sStateHash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
        dtCreated DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        dtExpires DATETIME(3) NOT NULL, dtConsumed DATETIME(3) NULL
      ) ENGINE=InnoDB`,
      `CREATE TABLE IF NOT EXISTS admin_tbl_IdentityEvent (
        iEventId BIGINT UNSIGNED PRIMARY KEY, sEventType VARCHAR(80) NOT NULL,
        jPayload JSON NOT NULL, dtReceived DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        dtProcessed DATETIME(3) NULL
      ) ENGINE=InnoDB`,
      `CREATE TABLE IF NOT EXISTS admin_tbl_EventCursor (
        sSource VARCHAR(32) PRIMARY KEY, iLastEventId BIGINT UNSIGNED NOT NULL,
        dtUpdated DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
      ) ENGINE=InnoDB`,
      `CREATE TABLE IF NOT EXISTS admin_tbl_Audit (
        sAuditId CHAR(36) PRIMARY KEY, iTenantId BIGINT UNSIGNED NULL,
        iActorUserId BIGINT UNSIGNED NOT NULL, sAction VARCHAR(128) NOT NULL,
        sEntityType VARCHAR(80) NOT NULL, sEntityId VARCHAR(255) NOT NULL,
        jDetails JSON NOT NULL, sCorrelationId VARCHAR(128) NULL,
        dtCreated DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        INDEX audit_tenant_created (iTenantId, dtCreated)
      ) ENGINE=InnoDB`,
    ])
      await connection.query(ddl);
    await connection.query('INSERT IGNORE INTO admin_tbl_Migration (iVersion) VALUES (1)');
  } finally {
    if (locked)
      await connection.query("SELECT RELEASE_LOCK('aida_admin_db:migrate')").catch(() => {});
    connection.release();
  }
}

export async function ping(pool: Pool): Promise<boolean> {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export class MysqlAuthStateRepository implements AuthStateRepository {
  constructor(private readonly pool: Pool) {}
  async issue(): Promise<string> {
    const state = randomBytes(32).toString('base64url');
    await this.pool.execute(
      'INSERT INTO admin_tbl_AuthState (sStateHash, dtExpires) VALUES (?, ?)',
      [hashToken(state), new Date(Date.now() + STATE_TTL_MS)],
    );
    return state;
  }
  async consume(state: string): Promise<boolean> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      `UPDATE admin_tbl_AuthState SET dtConsumed = CURRENT_TIMESTAMP(3)
       WHERE sStateHash = ? AND dtConsumed IS NULL AND dtExpires > CURRENT_TIMESTAMP(3)`,
      [hashToken(state)],
    );
    return result.affectedRows === 1;
  }
}

export class MysqlIdentityEventStore implements IdentityEventStore {
  constructor(private readonly pool: Pool) {}
  async process(
    event: IdEvent,
    effects: (fx: IdentityEffects) => Promise<void>,
  ): Promise<'applied' | 'duplicate'> {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      try {
        await connection.execute(
          'INSERT INTO admin_tbl_IdentityEvent (iEventId, sEventType, jPayload) VALUES (?, ?, ?)',
          [event.id, event.type, JSON.stringify(event.data ?? {})],
        );
      } catch (error) {
        if ((error as { code?: string }).code !== 'ER_DUP_ENTRY') throw error;
        await connection.rollback();
        return 'duplicate';
      }
      // Identity has already applied session revocation/merge centrally. Every
      // browser request introspects there; no local authorization cache exists.
      await effects({ revokeUserSessions: async () => 0, mergeUserSessions: async () => 0 });
      await connection.execute(
        'UPDATE admin_tbl_IdentityEvent SET dtProcessed = CURRENT_TIMESTAMP(3) WHERE iEventId = ?',
        [event.id],
      );
      await connection.commit();
      return 'applied';
    } catch (error) {
      await connection.rollback().catch(() => {});
      throw error;
    } finally {
      connection.release();
    }
  }
  async checkpoint(): Promise<number> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      "SELECT iLastEventId FROM admin_tbl_EventCursor WHERE sSource = 'id'",
    );
    return Number(rows[0]?.iLastEventId ?? 0);
  }
  async advanceReplayCursor(eventId: number): Promise<void> {
    await this.pool.execute(
      `INSERT INTO admin_tbl_EventCursor (sSource, iLastEventId) VALUES ('id', ?)
       ON DUPLICATE KEY UPDATE iLastEventId = GREATEST(iLastEventId, ?), dtUpdated = CURRENT_TIMESTAMP(3)`,
      [eventId, eventId],
    );
  }
}

export class MysqlAuditLog {
  constructor(private readonly pool: Pool) {}
  async append(entry: AuditEntry): Promise<void> {
    await this.pool.execute(
      `INSERT INTO admin_tbl_Audit
       (sAuditId, iTenantId, iActorUserId, sAction, sEntityType, sEntityId, jDetails, sCorrelationId)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        randomUUID(),
        entry.tenantId,
        entry.actorIdentityUserId,
        entry.action,
        entry.entityType,
        entry.entityId,
        JSON.stringify(entry.details ?? {}),
        entry.correlationId ?? null,
      ],
    );
  }
}
