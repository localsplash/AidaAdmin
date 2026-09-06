import type { IdClient, PlatformTenant } from '../id/client.js';
import { randomBytes } from 'node:crypto';

export const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

/** Request-local projection of the authoritative Identity application session. */
export interface AdminSession {
  iUserId: number;
  email: string | null;
  displayName: string | null;
  /** Consumed from the id token response; never derived locally. */
  superAdmin: boolean;
  provider: string | null;
  /** The tenant this session currently operates on (staff runtime scope). */
  selectedTenantId: string | null;
  /** Fresh Identity membership/tenant snapshot from this request only. */
  platformTenants?: PlatformTenant[];
}

export type NewAdminSession = Omit<AdminSession, 'selectedTenantId'> & {
  selectedTenantId?: string | null;
  centralToken?: string;
};

/** Session adapter contract; production delegates every operation to Identity. */
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

/** Thin adapter: all live sessions and authorization are owned by Identity.
 * There is no session cache or fallback to a local user/membership store.
 */
export class IdentitySessionRepository implements SessionRepository {
  constructor(private readonly client: IdClient) {}
  async create(session: NewAdminSession): Promise<string> {
    if (!session.centralToken)
      throw new Error('Identity did not issue a platform application session');
    return session.centralToken;
  }
  async get(token: string): Promise<AdminSession | null> {
    if (!this.client.introspectSession) throw new Error('Identity session API is unavailable');
    const result = await this.client.introspectSession(token);
    if (!result.active) return null;
    const tenants = result.tenants.filter((tenant) => tenant.bEnabled);
    if (!result.user.superAdmin && tenants.length === 0) return null;
    return {
      ...result.user,
      provider: null,
      platformTenants: tenants,
      selectedTenantId: result.selectedTenantId == null ? null : String(result.selectedTenantId),
    };
  }
  async setSelectedTenant(token: string, tenantId: string | null): Promise<void> {
    if (!this.client.selectTenant) throw new Error('Identity tenant selection API is unavailable');
    const id = tenantId === null ? null : Number(tenantId);
    if (id !== null && (!Number.isSafeInteger(id) || id < 1))
      throw new Error('Invalid platform tenant ID');
    await this.client.selectTenant(token, id);
  }
  async revoke(token: string): Promise<void> {
    if (!this.client.revokeSession) throw new Error('Identity session API is unavailable');
    await this.client.revokeSession(token);
  }
}
