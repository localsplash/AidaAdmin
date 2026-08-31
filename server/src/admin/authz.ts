import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { AppDeps } from '../deps.js';

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
 * Platform-wide administration: creating tenants, listing every tenant, and
 * granting Super Admin. superAdmin was consumed from the id token response
 * at login and lives on the server-side session.
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

/**
 * The tenant a request acts on. Tenant-scoped routes carry it either in the
 * path (`/admin/tenants/:tenantId/...`) or in the body (`POST /admin/
 * extensions`), so both are read — and a route that carries neither is
 * treated as having no tenant, which denies rather than admits.
 */
export function tenantIdFromRequest(req: Request): string | null {
  const fromParams = req.params.tenantId;
  if (typeof fromParams === 'string' && fromParams) return fromParams;
  const fromBody = (req.body as Record<string, unknown> | undefined)?.tenantId;
  return typeof fromBody === 'string' && fromBody ? fromBody : null;
}

/** The caller's enabled role in one tenant, or null when they hold none. */
export async function tenantRole(
  deps: AppDeps,
  iUserId: number,
  tenantId: string,
): Promise<string | null> {
  if (!deps.repos) return null;
  const memberships = await deps.repos.tenantUsers.listForUser(iUserId);
  const match = memberships.find((m) => m.tenant_id === tenantId && Boolean(m.enabled));
  return match ? (match.role as string) : null;
}

function deny(res: Response, req: Request, message: string): void {
  res.status(403).json({ error: 'forbidden', message, correlationId: req.correlationId });
}

/**
 * Administration of one tenant: a Super Admin may act on any tenant, a
 * TENANT_ADMIN only on the tenant they administer. A USER membership is not
 * an administrative role and is refused here even for their own tenant.
 *
 * The denial is deliberately the same 403 whether the tenant is someone
 * else's or does not exist — a non-member learns nothing about which tenants
 * are real.
 */
export function requireTenantAdmin(deps: AppDeps): RequestHandler {
  return (req, res, next) => {
    const session = req.session;
    if (!session) {
      res.status(401).json({
        error: 'unauthenticated',
        message: 'Sign in required',
        correlationId: req.correlationId,
      });
      return;
    }
    if (session.superAdmin) {
      next();
      return;
    }
    const tenantId = tenantIdFromRequest(req);
    if (!tenantId) {
      deny(res, req, 'Super Admin access required');
      return;
    }
    tenantRole(deps, session.iUserId, tenantId)
      .then((role) => {
        if (role !== 'TENANT_ADMIN') {
          deny(res, req, 'You do not administer that tenant');
          return;
        }
        next();
      })
      .catch(next);
  };
}

/**
 * Surfaces that are not scoped to one tenant but that a tenant
 * administrator legitimately needs — looking a person up in the central
 * directory before mapping them into their own tenant.
 */
export function requireAnyTenantAdmin(deps: AppDeps): RequestHandler {
  return (req, res, next) => {
    const session = req.session;
    if (!session) {
      res.status(401).json({
        error: 'unauthenticated',
        message: 'Sign in required',
        correlationId: req.correlationId,
      });
      return;
    }
    if (session.superAdmin) {
      next();
      return;
    }
    if (!deps.repos) {
      deny(res, req, 'Super Admin access required');
      return;
    }
    deps.repos.tenantUsers
      .listForUser(session.iUserId)
      .then((memberships) => {
        const administers = memberships.some(
          (m) => Boolean(m.enabled) && m.role === 'TENANT_ADMIN' && m.tenant_id,
        );
        if (!administers) {
          deny(res, req, 'Tenant administrator access required');
          return;
        }
        next();
      })
      .catch(next);
  };
}
