import { createHash, randomBytes } from 'node:crypto';
import pg from 'pg';
import type { AdminSession, NewAdminSession, SessionRepository } from '../auth/session-store.js';
import { SESSION_TTL_MS } from '../auth/session-store.js';
import type { AuthStateRepository } from '../auth/state-store.js';
import { STATE_TTL_MS } from '../auth/state-store.js';
import type { IdEvent } from '../id/client.js';
import type { IdentityEffects, IdentityEventStore } from '../id/event-store.js';

/**
 * AidaAdmin's own PostgreSQL database (`aida_admin` on the existing server;
 * a dedicated database and credential, fully separate from OfficePulse's
 * `aida_officepulse`). Holds durable sessions, single-use login states, and the
 * identity-event log/checkpoint, so container restarts lose nothing.
 */

export function createPool(databaseUrl: string): pg.Pool {
  return new pg.Pool({ connectionString: databaseUrl, max: 5 });
}

/** Additive, idempotent schema setup — safe to run at every boot. */
export async function migrate(pool: pg.Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_session (
      session_id_hash   TEXT PRIMARY KEY,
      identity_user_id  BIGINT NOT NULL,
      super_admin       BOOLEAN NOT NULL,
      email             TEXT,
      display_name      TEXT,
      provider          TEXT,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_seen_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at        TIMESTAMPTZ NOT NULL,
      revoked_at        TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS admin_session_user_idx
      ON admin_session (identity_user_id) WHERE revoked_at IS NULL;
    ALTER TABLE admin_session ADD COLUMN IF NOT EXISTS selected_tenant_id TEXT;

    CREATE TABLE IF NOT EXISTS auth_state (
      state_hash   TEXT PRIMARY KEY,
      redirect_uri TEXT,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at   TIMESTAMPTZ NOT NULL,
      consumed_at  TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS identity_event (
      event_id         BIGINT PRIMARY KEY,
      event_type       TEXT NOT NULL,
      payload          JSONB NOT NULL,
      received_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      processed_at     TIMESTAMPTZ,
      processing_error TEXT
    );

    CREATE TABLE IF NOT EXISTS identity_event_checkpoint (
      source        TEXT PRIMARY KEY,
      last_event_id BIGINT NOT NULL,
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

export async function ping(pool: pg.Pool): Promise<boolean> {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

/** The browser cookie value is never stored — only its SHA-256. */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export class PostgresSessionRepository implements SessionRepository {
  constructor(private readonly pool: pg.Pool) {}

  async create(session: NewAdminSession): Promise<string> {
    const sid = randomBytes(32).toString('base64url');
    await this.pool.query(
      `INSERT INTO admin_session
         (session_id_hash, identity_user_id, super_admin, email, display_name, provider,
          selected_tenant_id, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now() + $8::interval)`,
      [
        hashToken(sid),
        session.iUserId,
        session.superAdmin,
        session.email,
        session.displayName,
        session.provider,
        session.selectedTenantId ?? null,
        `${SESSION_TTL_MS} milliseconds`,
      ],
    );
    return sid;
  }

  async get(sid: string): Promise<AdminSession | null> {
    const result = await this.pool.query(
      `UPDATE admin_session
          SET last_seen_at = now(), expires_at = now() + $2::interval
        WHERE session_id_hash = $1 AND revoked_at IS NULL AND expires_at > now()
        RETURNING identity_user_id, super_admin, email, display_name, provider, selected_tenant_id`,
      [hashToken(sid), `${SESSION_TTL_MS} milliseconds`],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      iUserId: Number(row.identity_user_id),
      superAdmin: Boolean(row.super_admin),
      email: row.email ?? null,
      displayName: row.display_name ?? null,
      provider: row.provider ?? null,
      selectedTenantId: row.selected_tenant_id ?? null,
    };
  }

  async setSelectedTenant(sid: string, tenantId: string | null): Promise<void> {
    await this.pool.query(
      `UPDATE admin_session SET selected_tenant_id = $2
        WHERE session_id_hash = $1 AND revoked_at IS NULL`,
      [hashToken(sid), tenantId],
    );
  }

  async revoke(sid: string): Promise<void> {
    await this.pool.query(
      `UPDATE admin_session SET revoked_at = now()
        WHERE session_id_hash = $1 AND revoked_at IS NULL`,
      [hashToken(sid)],
    );
  }
}

export class PostgresAuthStateRepository implements AuthStateRepository {
  constructor(private readonly pool: pg.Pool) {}

  async issue(): Promise<string> {
    const state = randomBytes(32).toString('base64url');
    await this.pool.query(
      `INSERT INTO auth_state (state_hash, expires_at) VALUES ($1, now() + $2::interval)`,
      [hashToken(state), `${STATE_TTL_MS} milliseconds`],
    );
    return state;
  }

  async consume(state: string): Promise<boolean> {
    // Single-use: the row is claimed atomically; a replay finds consumed_at set.
    const result = await this.pool.query(
      `UPDATE auth_state SET consumed_at = now()
        WHERE state_hash = $1 AND consumed_at IS NULL AND expires_at > now()
        RETURNING state_hash`,
      [hashToken(state)],
    );
    return result.rowCount === 1;
  }
}

export class PostgresIdentityEventStore implements IdentityEventStore {
  constructor(private readonly pool: pg.Pool) {}

  async process(
    event: IdEvent,
    effects: (fx: IdentityEffects) => Promise<void>,
  ): Promise<'applied' | 'duplicate'> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const inserted = await client.query(
        `INSERT INTO identity_event (event_id, event_type, payload)
         VALUES ($1, $2, $3) ON CONFLICT (event_id) DO NOTHING`,
        [event.id, event.type, JSON.stringify(event.data ?? {})],
      );
      if (inserted.rowCount === 0) {
        await client.query('ROLLBACK');
        return 'duplicate';
      }

      // Effects run on the same transaction as the event record, so a failure
      // rolls everything back and the delivery is retried by id.
      await effects({
        async revokeUserSessions(iUserId) {
          const result = await client.query(
            `UPDATE admin_session SET revoked_at = now()
              WHERE identity_user_id = $1 AND revoked_at IS NULL`,
            [iUserId],
          );
          return result.rowCount ?? 0;
        },
        async mergeUserSessions(fromUserId, toUserId) {
          const result = await client.query(
            `UPDATE admin_session SET identity_user_id = $2
              WHERE identity_user_id = $1 AND revoked_at IS NULL`,
            [fromUserId, toUserId],
          );
          return result.rowCount ?? 0;
        },
      });

      await client.query(`UPDATE identity_event SET processed_at = now() WHERE event_id = $1`, [
        event.id,
      ]);
      await client.query(
        `INSERT INTO identity_event_checkpoint (source, last_event_id, updated_at)
         VALUES ('id', $1, now())
         ON CONFLICT (source) DO UPDATE
           SET last_event_id = GREATEST(identity_event_checkpoint.last_event_id, $1),
               updated_at = now()`,
        [event.id],
      );
      await client.query('COMMIT');
      return 'applied';
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      // Best-effort diagnostic outside the failed transaction; the event row
      // itself was rolled back, so record the failure keyed by event id only
      // if a prior delivery left a row (otherwise there is nothing to update).
      await this.pool
        .query(`UPDATE identity_event SET processing_error = $2 WHERE event_id = $1`, [
          event.id,
          err instanceof Error ? err.message : String(err),
        ])
        .catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async checkpoint(): Promise<number> {
    const result = await this.pool.query(
      `SELECT last_event_id FROM identity_event_checkpoint WHERE source = 'id'`,
    );
    return result.rows[0] ? Number(result.rows[0].last_event_id) : 0;
  }
}
