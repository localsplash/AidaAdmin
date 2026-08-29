import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

export const CSRF_COOKIE = 'aida.csrf';
export const CSRF_HEADER = 'x-csrf-token';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function issueCsrfToken(res: Response, secure: boolean): string {
  const token = randomBytes(32).toString('base64url');
  // Double-submit cookie: intentionally not httpOnly so same-origin browser
  // code can echo it in the request header. It carries no session authority.
  res.cookie(CSRF_COOKIE, token, {
    sameSite: 'strict',
    secure,
    httpOnly: false,
    path: '/',
  });
  return token;
}

function tokensMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

/**
 * Double-submit-cookie CSRF protection for state-changing API routes. The
 * request must present the CSRF cookie and a matching header; cross-site
 * pages cannot read the cookie, so they cannot forge the header.
 */
export function csrfProtection(req: Request, res: Response, next: NextFunction): void {
  if (SAFE_METHODS.has(req.method)) {
    next();
    return;
  }
  const cookieToken = (req.cookies as Record<string, string> | undefined)?.[CSRF_COOKIE];
  const headerToken = req.header(CSRF_HEADER);
  if (!cookieToken || !headerToken || !tokensMatch(cookieToken, headerToken)) {
    res.status(403).json({
      error: 'csrf_token_invalid',
      message: 'Missing or invalid CSRF token',
      correlationId: req.correlationId,
    });
    return;
  }
  next();
}
