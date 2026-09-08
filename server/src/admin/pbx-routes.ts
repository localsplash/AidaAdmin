import { Router } from 'express';
import type { AppDeps } from '../deps.js';
import { requireSession, requireTenantAdmin } from './authz.js';

/** PBX configuration is read from Asterisk through OfficePulse, never copied locally. */
export function pbxRoutes(deps: AppDeps): Router {
  const router = Router();
  const tenantAdmin = requireTenantAdmin(deps);

  for (const kind of ['extensions', 'queues'] as const) {
    router.get(
      `/admin/tenants/:tenantId/pbx/${kind}`,
      requireSession,
      tenantAdmin,
      async (req, res) => {
        const tenantId = String(req.params.tenantId);
        const iTenantId = Number(tenantId);
        if (!/^[1-9]\d*$/.test(tenantId) || !Number.isSafeInteger(iTenantId)) {
          res.status(400).json({ error: 'invalid_tenant', correlationId: req.correlationId });
          return;
        }
        const client = deps.officePulse;
        if (!client?.listPbxExtensions || !client.listPbxQueues) {
          res.status(503).json({
            error: 'pbx_inventory_unavailable',
            message: 'OfficePulse PBX inventory is not configured.',
            correlationId: req.correlationId,
          });
          return;
        }
        try {
          const result =
            kind === 'extensions'
              ? await client.listPbxExtensions(iTenantId)
              : await client.listPbxQueues(iTenantId);
          res.set('Cache-Control', 'no-store').json(result);
        } catch {
          res.status(502).json({
            error: 'pbx_inventory_unavailable',
            message:
              'OfficePulse could not read this tenant’s PBX inventory. Check the PBX connection and tenant mapping in OfficePulse.',
            correlationId: req.correlationId,
          });
        }
      },
    );
  }

  return router;
}
