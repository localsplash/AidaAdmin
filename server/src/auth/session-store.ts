import { randomBytes } from 'node:crypto';

export const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

/**
 * What a live AidaAdmin session carries. There is deliberately no id session
 * identifier: id's /api/token response does not include one, so on
 * `session.revoked` (any scope) the POC revokes every local session for the
 * user instead of trying to match a single one.
 */
export interface AdminSession {
  iUserId: number;
  email: string | null;
  displayName: string | null;
  /** Consumed from the id token response; never derived locally. */
  superAdmin: boolean;
  provider: string | null;
  /** The tenant this session currently operates on (staff runtime scope). */
  selectedTenantId: string | null;
}

export type NewAdminSession = Omit<AdminSession, 'selectedTenantId'> & {
  selectedTenantId?: string | null;
};

/**
 * Server-side session persistence. `create` returns the opaque browser
 * cookie value; implementations store only a hash of it. Backed by
 * PostgreSQL (`admin_session`) when AIDA_ADMIN_DATABASE_URL is configured,
 * with this in-memory fallback for credential-less dev and unit tests.
 */
export interface SessionRepository {
  create(session: NewAdminSession): Promise<string>;
  /** Returns the live session and slides its expiry, or null. */
  get(sid: string): Promise<AdminSession | null>;
  setSelectedTenant(sid: string, tenantId: string | null): Promise<void>;
  revoke(sid: string): Promise<void>;
}

interface MemorySessionRecord {
  session: AdminSession;
  expiresAt: number;
}

/** Shared by the memory repository and the memory identity-event effects. */
export class MemoryAuthDb {
  readonly sessions = new Map<string, MemorySessionRecord>();

  revokeByUser(iUserId: number): number {
    let revoked = 0;
    for (const [sid, record] of this.sessions) {
      if (record.session.iUserId === iUserId) {
        this.sessions.delete(sid);
        revoked += 1;
      }
    }
    return revoked;
  }

  mergeUser(fromUserId: number, toUserId: number): number {
    let moved = 0;
    for (const record of this.sessions.values()) {
      if (record.session.iUserId === fromUserId) {
        record.session.iUserId = toUserId;
        moved += 1;
      }
    }
    return moved;
  }

  count(): number {
    return this.sessions.size;
  }
}

export class MemorySessionRepository implements SessionRepository {
  constructor(readonly db: MemoryAuthDb = new MemoryAuthDb()) {}

  async create(session: NewAdminSession): Promise<string> {
    const sid = randomBytes(32).toString('base64url');
    this.db.sessions.set(sid, {
      session: { selectedTenantId: null, ...session },
      expiresAt: Date.now() + SESSION_TTL_MS,
    });
    return sid;
  }

  async setSelectedTenant(sid: string, tenantId: string | null): Promise<void> {
    const record = this.db.sessions.get(sid);
    if (record) record.session.selectedTenantId = tenantId;
  }

  async get(sid: string): Promise<AdminSession | null> {
    const record = this.db.sessions.get(sid);
    if (!record) return null;
    if (record.expiresAt < Date.now()) {
      this.db.sessions.delete(sid);
      return null;
    }
    record.expiresAt = Date.now() + SESSION_TTL_MS;
    return record.session;
  }

  async revoke(sid: string): Promise<void> {
    this.db.sessions.delete(sid);
  }
}
