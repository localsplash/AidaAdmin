import { Router } from 'express';
import type { AppDeps } from '../deps.js';
import type { Logger } from '../logger.js';
import { requireSession } from '../admin/authz.js';

export interface SelectableTenant {
  tenantId: string;
  name: string;
  slug: string;
  role: 'SUPER_ADMIN' | 'TENANT_ADMIN' | 'USER';
}

/** The tenants this session may operate on, with the role held in each. */
export async function selectableTenants(
  deps: AppDeps,
  iUserId: number,
  superAdmin: boolean,
): Promise<SelectableTenant[]> {
  if (!deps.repos) return [];
  if (superAdmin) {
    const tenants = await deps.repos.tenants.list();
    return tenants
      .filter((t) => t.enabled)
      .map((t) => ({
        tenantId: t.id as string,
        name: t.name as string,
        slug: t.slug as string,
        role: 'SUPER_ADMIN' as const,
      }));
  }
  const memberships = (await deps.repos.tenantUsers.listForUser(iUserId)).filter(
    (m) => m.enabled && m.tenant_id,
  );
  const result: SelectableTenant[] = [];
  for (const membership of memberships) {
    try {
      const tenant = await deps.repos.tenants.get(membership.tenant_id as string);
      if (!tenant.enabled) continue;
      result.push({
        tenantId: tenant.id as string,
        name: tenant.name as string,
        slug: tenant.slug as string,
        role: membership.role as SelectableTenant['role'],
      });
    } catch {
      // A mapping to a missing tenant is simply not selectable.
    }
  }
  return result;
}

export function tenantSelectionRoutes(logger: Logger, deps: AppDeps): Router {
  const router = Router();

  router.get('/api/session/tenants', requireSession, async (req, res, next) => {
    try {
      const session = req.session!;
      res.json({ tenants: await selectableTenants(deps, session.iUserId, session.superAdmin) });
    } catch (err) {
      next(err);
    }
  });

  // CSRF-protected by the /api mutation guard.
  router.post('/api/session/tenant', requireSession, async (req, res, next) => {
    try {
      const session = req.session!;
      const tenantId = (req.body as Record<string, unknown> | undefined)?.tenantId;
      if (typeof tenantId !== 'string' || !tenantId) {
        res.status(400).json({
          error: 'validation',
          message: 'tenantId is required',
          correlationId: req.correlationId,
        });
        return;
      }
      const allowed = await selectableTenants(deps, session.iUserId, session.superAdmin);
      const selected = allowed.find((t) => t.tenantId === tenantId);
      if (!selected) {
        // Cross-tenant or disabled memberships fail here — before any proxying.
        logger.info({ correlationId: req.correlationId }, 'tenant selection denied');
        res.status(403).json({
          error: 'forbidden',
          message: 'You are not a member of that tenant',
          correlationId: req.correlationId,
        });
        return;
      }
      await deps.sessionStore.setSelectedTenant(req.sessionSid!, tenantId);
      res.json({ selectedTenant: selected });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
