import { Router, type Request, type Response } from 'express';
import type { AppConfig } from '../config.js';
import type { AppDeps } from '../deps.js';
import type { Logger } from '../logger.js';

export const SESSION_COOKIE = 'aida.sid';
const STATE_COOKIE = 'aida.authstate';

export function readCookie(req: Request, name: string): string | undefined {
  const signed = (req.signedCookies as Record<string, string> | undefined)?.[name];
  if (typeof signed === 'string') return signed;
  const plain = (req.cookies as Record<string, string> | undefined)?.[name];
  return typeof plain === 'string' ? plain : undefined;
}

function cookieOptions(config: AppConfig, httpOnly: boolean) {
  return {
    httpOnly,
    sameSite: 'lax' as const,
    secure: config.nodeEnv === 'production',
    signed: Boolean(config.serviceConfig.SESSION_SECRET),
    path: '/',
  };
}

function callbackUri(config: AppConfig): string | null {
  const base = config.serviceConfig.PUBLIC_BASE_URL;
  if (!base) return null;
  return new URL('/api/auth/callback', base).toString();
}

export function authRoutes(config: AppConfig, logger: Logger, deps: AppDeps): Router {
  const router = Router();

  router.get('/api/auth/login', async (req, res, next) => {
    try {
      const idBase = config.serviceConfig.ID_BASE_URL;
      const redirectUri = callbackUri(config);
      if (!idBase || !redirectUri || !deps.idClient) {
        // Name what is missing so the operator does not have to guess.
        const missing = [
          ...(idBase ? [] : ['ID_BASE_URL']),
          ...(redirectUri ? [] : ['PUBLIC_BASE_URL']),
        ];
        logger.error({ missing, correlationId: req.correlationId }, 'login is not configured');
        res.status(503).json({
          error: 'id_not_configured',
          message:
            missing.length > 0
              ? `Identity service is not configured: set ${missing.join(' and ')}`
              : 'Identity service is not configured',
          correlationId: req.correlationId,
        });
        return;
      }
      const state = await deps.stateStore.issue();
      res.cookie(STATE_COOKIE, state, cookieOptions(config, true));
      const authorize = new URL('/authorize', idBase);
      authorize.searchParams.set('redirect_uri', redirectUri);
      authorize.searchParams.set('state', state);
      res.redirect(authorize.toString());
    } catch (err) {
      next(err);
    }
  });

  router.get('/api/auth/callback', async (req, res, next) => {
    try {
      const redirectUri = callbackUri(config);
      if (!deps.idClient || !redirectUri) {
        failLogin(res, 'error');
        return;
      }
      const state = typeof req.query.state === 'string' ? req.query.state : '';
      const code = typeof req.query.code === 'string' ? req.query.code : '';
      const stateCookie = readCookie(req, STATE_COOKIE);
      res.clearCookie(STATE_COOKIE, cookieOptions(config, true));

      // Both the browser-bound cookie and the single-use server record must
      // match; a replayed or cross-browser state fails either check.
      if (!state || !code || state !== stateCookie || !(await deps.stateStore.consume(state))) {
        failLogin(res, 'error');
        return;
      }

      let redeemed;
      try {
        // The exact redirect_uri sent to /authorize is redeemed server-to-server.
        redeemed = await deps.idClient.redeemCode(code, redirectUri);
      } catch (err) {
        // Every redemption failure — HTTP rejection or network fault — exits
        // through the controlled login-error flow, never a generic 500.
        logger.warn({ err, correlationId: req.correlationId }, 'code redemption failed');
        failLogin(res, 'error');
        return;
      }

      const { user, identity } = redeemed;
      // superAdmin comes from the id response only — never recalculated here.
      if (!user.superAdmin && !(await deps.tenantDirectory.hasEnabledMembership(user.iUserId))) {
        logger.info({ correlationId: req.correlationId }, 'login denied: no enabled tenant_user');
        failLogin(res, 'denied');
        return;
      }

      const sid = await deps.sessionStore.create({
        iUserId: user.iUserId,
        email: user.email ?? null,
        displayName: user.displayName ?? null,
        superAdmin: user.superAdmin,
        provider: identity?.provider ?? null,
      });
      res.cookie(SESSION_COOKIE, sid, cookieOptions(config, true));
      res.redirect('/');
    } catch (err) {
      next(err);
    }
  });

  // CSRF-protected by the /api mutation guard in app.ts.
  router.post('/api/auth/logout', async (req, res, next) => {
    try {
      const sid = readCookie(req, SESSION_COOKIE);
      if (sid) await deps.sessionStore.revoke(sid);
      res.clearCookie(SESSION_COOKIE, cookieOptions(config, true));
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  return router;
}

function failLogin(res: Response, reason: 'error' | 'denied'): void {
  res.redirect(`/?login=${reason}`);
}
