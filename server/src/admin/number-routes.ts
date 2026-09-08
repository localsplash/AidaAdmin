import { Router } from 'express';
import { z } from 'zod';
import type { AppDeps } from '../deps.js';
import { IdClientError } from '../id/client.js';
import { requireTenantAdmin } from './authz.js';
const input = z
  .object({
    phoneNumber: z
      .string()
      .trim()
      .regex(/^\+1[2-9]\d{9}$/, 'Use a +1 number with ten digits'),
    label: z.string().trim().max(100).default(''),
    bVoice: z.literal(true).default(true),
    bMessaging: z.literal(true).default(true),
    bEnabled: z.boolean(),
    accessPolicy: z.literal('TENANT_MEMBERS'),
    expectedVersion: z.number().int().positive().optional(),
  })
  .strict();
export function numberRoutes(deps: AppDeps): Router {
  const router = Router();
  const guard = requireTenantAdmin(deps);
  router.get('/admin/tenants/:tenantId/numbers', guard, async (req, res, next) => {
    try {
      if (!deps.idClient?.listTenantNumbers) {
        res.status(503).json({ error: 'identity_unavailable' });
        return;
      }
      res.json(await deps.idClient.listTenantNumbers(String(req.params.tenantId)));
    } catch (e) {
      next(e);
    }
  });
  for (const method of ['post', 'put'] as const) {
    router[method](
      '/admin/tenants/:tenantId/numbers' + (method === 'put' ? '/:numberId' : ''),
      guard,
      async (req, res, next) => {
        const parsed = input.safeParse(req.body);
        if (!parsed.success || (method === 'put' && !parsed.data.expectedVersion)) {
          res
            .status(400)
            .json({ error: 'validation', message: 'Check the number and reload before saving.' });
          return;
        }
        try {
          if (!deps.idClient?.saveTenantNumber) {
            res.status(503).json({ error: 'identity_unavailable' });
            return;
          }
          const number = await deps.idClient.saveTenantNumber(
            String(req.params.tenantId),
            method === 'put' ? String(req.params.numberId) : null,
            parsed.data,
          );
          res.status(method === 'post' ? 201 : 200).json({ number });
        } catch (e) {
          if (e instanceof IdClientError) {
            res
              .status(e.status && [400, 401, 403, 404, 409].includes(e.status) ? e.status : 502)
              .json({
                error: 'number_save_failed',
                message: e.publicMessage ?? 'Unable to save number. Refresh and try again.',
              });
            return;
          }
          next(e);
        }
      },
    );
  }
  return router;
}
