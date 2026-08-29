import type { NextFunction, Request, Response } from 'express';

export function requireSession(req: Request, res: Response, next: NextFunction): void {
  if (!req.session) {
    res.status(401).json({
      error: 'unauthenticated',
      message: 'Sign in required',
      correlationId: req.correlationId,
    });
    return;
  }
  next();
}

/**
 * Phase 4 administration is a Super Admin workflow. superAdmin was consumed
 * from the id token response at login and lives on the server-side session.
 */
export function requireSuperAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.session) {
    res.status(401).json({
      error: 'unauthenticated',
      message: 'Sign in required',
      correlationId: req.correlationId,
    });
    return;
  }
  if (!req.session.superAdmin) {
    res.status(403).json({
      error: 'forbidden',
      message: 'Super Admin access required',
      correlationId: req.correlationId,
    });
    return;
  }
  next();
}
