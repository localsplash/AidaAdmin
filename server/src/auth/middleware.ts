import type { NextFunction, Request, Response } from 'express';
import type { AdminSession, SessionRepository } from './session-store.js';
import { readCookie, SESSION_COOKIE } from './routes.js';

declare module 'express-serve-static-core' {
  interface Request {
    session: AdminSession | null;
  }
}

export function sessionMiddleware(store: SessionRepository) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const sid = readCookie(req, SESSION_COOKIE);
    if (!sid) {
      req.session = null;
      next();
      return;
    }
    store
      .get(sid)
      .then((session) => {
        req.session = session;
        next();
      })
      .catch(next);
  };
}
