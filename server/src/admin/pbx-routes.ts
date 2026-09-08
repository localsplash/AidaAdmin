import { Router } from 'express';
import type { AppConfig } from '../config.js';
import type { AppDeps } from '../deps.js';
import { requireSession, requireTenantAdmin } from './authz.js';

/** PBX configuration is read from Asterisk through OfficePulse, never copied locally. */
export function pbxRoutes(config: AppConfig, deps: AppDeps): Router {
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

  // Applied before legacy routers: even stale clients cannot save local desired
  // state, rotate credentials, enroll handsets, or replay provisioning by default.
  router.use(
    ['/admin/extensions', '/admin/ring-groups', '/admin/did-routes', '/runtime/provisioning/retry'],
    requireSession,
    (req, res, next) => {
      if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || config.legacyPbxWritesEnabled) {
        next();
        return;
      }
      res.status(409).json({
        error: 'pbx_owned_by_asterisk',
        message:
          'PBX configuration is managed in OfficePulse. AidaAdmin reads extensions and queues from Asterisk.',
        correlationId: req.correlationId,
      });
    },
  );
  return router;
}
