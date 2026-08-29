import { randomBytes } from 'node:crypto';

const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

export interface AdminSession {
  sid: string;
  iUserId: number;
  email: string | null;
  displayName: string | null;
  /** Consumed from the id token response; never derived locally. */
  superAdmin: boolean;
  /** id_tbl_Session identifier when id supplies one, for revocation events. */
  idSessionId: string | null;
  provider: string | null;
  createdAt: number;
  lastSeenAt: number;
}

/**
 * Server-side session persistence keyed by our own random session ID and by
 * `id` user.iUserId, so identity events (session.revoked, user.merged) can be
 * applied locally. In-memory is acceptable for the POC single-process server;
 * revocation events and the idle TTL bound staleness.
 */
export class SessionStore {
  private readonly sessions = new Map<string, AdminSession>();

  create(input: Omit<AdminSession, 'sid' | 'createdAt' | 'lastSeenAt'>): AdminSession {
    const now = Date.now();
    const session: AdminSession = {
      ...input,
      sid: randomBytes(32).toString('base64url'),
      createdAt: now,
      lastSeenAt: now,
    };
    this.sessions.set(session.sid, session);
    return session;
  }

  get(sid: string): AdminSession | null {
    const session = this.sessions.get(sid);
    if (!session) return null;
    if (Date.now() - session.lastSeenAt > SESSION_TTL_MS) {
      this.sessions.delete(sid);
      return null;
    }
    session.lastSeenAt = Date.now();
    return session;
  }

  revoke(sid: string): void {
    this.sessions.delete(sid);
  }

  revokeByUser(iUserId: number): number {
    let revoked = 0;
    for (const [sid, session] of this.sessions) {
      if (session.iUserId === iUserId) {
        this.sessions.delete(sid);
        revoked += 1;
      }
    }
    return revoked;
  }

  revokeByIdSession(idSessionId: string): number {
    let revoked = 0;
    for (const [sid, session] of this.sessions) {
      if (session.idSessionId === idSessionId) {
        this.sessions.delete(sid);
        revoked += 1;
      }
    }
    return revoked;
  }

  /** user.merged: sessions for the merged-away user now belong to the target. */
  mergeUser(fromUserId: number, toUserId: number): number {
    let moved = 0;
    for (const session of this.sessions.values()) {
      if (session.iUserId === fromUserId) {
        session.iUserId = toUserId;
        moved += 1;
      }
    }
    return moved;
  }

  count(): number {
    return this.sessions.size;
  }
}
