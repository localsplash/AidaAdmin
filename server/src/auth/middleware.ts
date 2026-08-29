import { createHash } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { AdminSession, SessionRepository } from './session-store.js';
import { readCookie, SESSION_COOKIE } from './routes.js';

declare module 'express-serve-static-core' {
  interface Request {
    session: AdminSession | null;
    /** The raw session cookie value (needed for revocation/selection). */
    sessionSid: string | null;
    /**
     * Non-secret session identifier (SHA-256 of the cookie value — the same
     * value PostgreSQL stores). Safe to forward for audit correlation; the
     * cookie value itself never leaves this process.
     */
    sessionRef: string | null;
  }
}

export function sessionMiddleware(store: SessionRepository) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const sid = readCookie(req, SESSION_COOKIE);
    req.session = null;
    req.sessionSid = null;
    req.sessionRef = null;
    if (!sid) {
      next();
      return;
    }
    store
      .get(sid)
      .then((session) => {
        req.session = session;
        if (session) {
          req.sessionSid = sid;
          req.sessionRef = createHash('sha256').update(sid).digest('hex');
        }
        next();
      })
      .catch(next);
  };
}
