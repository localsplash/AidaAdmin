import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type { AppDeps } from '../deps.js';
import type { Logger } from '../logger.js';
import type { AuditEntry } from '../nocodb/repos.js';
import { OfficePulseError } from '../officepulse/client.js';
import { deviceId } from '../officepulse/handset-contract.js';
import { PbxResponseError, resolveTenantPbxScope, selectedTenant } from './pbx-scope.js';

const scopeQuery = z.object({ context: z.string().optional() }).strict();

export function handsetRoutes(logger: Logger, deps: AppDeps): Router {
  const router = Router();
  const base = '/admin/tenants/:tenantId/handsets';

  async function context(req: Request) {
    const tenant = selectedTenant(req);
    const query = scopeQuery.parse(req.query);
    const scope = await resolveTenantPbxScope(deps, tenant.tenantId, query.context);
    if (!deps.officePulse)
      throw new PbxResponseError(
        503,
        'officepulse_not_configured',
        'OfficePulse is not configured',
      );
    return { api: deps.officePulse, scope: { context: scope.context } };
  }

  async function audit(req: Request, outcome: string, status: number) {
    if (!req.session) return;
    const entry: AuditEntry = {
      actorIdentityUserId: req.session.iUserId,
      tenantId: String(req.params.tenantId),
      action: 'handset.revoked',
      entityType: 'handset',
      entityId: String(req.params.deviceId),
      correlationId: req.correlationId,
      details: { outcome, status },
    };
    try {
      const destination = deps.audit ?? deps.repos?.audit;
      if (destination) await destination.append(entry);
      else logger.info({ audit: entry }, 'Handset audit');
    } catch {
      logger.error({ audit: entry }, 'Handset audit persistence failed');
    }
  }

  for (const method of ['get', 'delete'] as const) {
    router[method](
      method === 'get' ? base : `${base}/:deviceId`,
      async (req: Request, res: Response) => {
        res.set('Cache-Control', 'no-store');
        try {
          const { api, scope } = await context(req);
          if (method === 'get') {
            res.json(await api.listHandsets(scope, req.correlationId));
          } else {
            z.object({})
              .strict()
              .parse(req.body ?? {});
            // OfficePulse checks the device against this authorized context on revoke.
            await api.revokeHandset(scope, deviceId.parse(req.params.deviceId), req.correlationId);
            await audit(req, 'committed', 204);
            res.status(204).end();
          }
        } catch (err) {
          const safe =
            err instanceof PbxResponseError
              ? err
              : err instanceof z.ZodError
                ? new PbxResponseError(400, 'validation', 'Invalid handset request')
                : err instanceof OfficePulseError && err.status === 404 && method === 'delete'
                  ? new PbxResponseError(
                      404,
                      'not_found',
                      'The handset is unavailable in this context',
                    )
                  : new PbxResponseError(
                      502,
                      'officepulse_unavailable',
                      'OfficePulse could not complete the handset request. Refresh and try again',
                    );
          if (method === 'delete') await audit(req, safe.code, safe.status);
          res
            .status(safe.status)
            .json({ error: safe.code, message: safe.message, correlationId: req.correlationId });
        }
      },
    );
  }
  return router;
}
