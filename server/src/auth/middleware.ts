import { createHash } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { AdminSession, SessionRepository } from './session-store.js';
import { AdminAccessDenied } from './session-store.js';
import { readCookie, SESSION_COOKIE } from './routes.js';

declare module 'express-serve-static-core' {
  interface Request {
    session: AdminSession | null;
    /** The raw session cookie value (needed for revocation/selection). */
    sessionSid: string | null;
    /**
     * Non-secret session identifier (SHA-256 of the cookie value — the same
     * audit correlation value). Safe to forward for audit correlation; the
     * cookie value is forwarded only to Identity over its trusted API.
     */
    sessionRef: string | null;
  }
}

export function sessionMiddleware(store: SessionRepository) {
  return (req: Request, res: Response, next: NextFunction): void => {
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
      .catch((err: unknown) => {
        if (!(err instanceof AdminAccessDenied)) {
          next(err);
          return;
        }
        // Deny data APIs while still allowing a demoted user to load the
        // sign-in screen, sign out, or authenticate with another account.
        if (/^\/(api|admin|runtime)(\/|$)/.test(req.path) && !req.path.startsWith('/api/auth/')) {
          res.status(403).json({
            error: 'forbidden',
            message: 'Administrator access required',
            correlationId: req.correlationId,
          });
        } else next();
      });
  };
}
