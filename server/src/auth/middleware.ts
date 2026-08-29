import type { NextFunction, Request, Response } from 'express';
import type { AdminSession, SessionStore } from './session-store.js';
import { readCookie, SESSION_COOKIE } from './routes.js';

declare module 'express-serve-static-core' {
  interface Request {
    session: AdminSession | null;
  }
}

export function sessionMiddleware(store: SessionStore) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const sid = readCookie(req, SESSION_COOKIE);
    req.session = sid ? store.get(sid) : null;
    next();
  };
}
