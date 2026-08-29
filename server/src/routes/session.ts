import { Router } from 'express';
import { selectableTenants } from '../auth/tenant-selection.js';
import type { AppConfig } from '../config.js';
import type { SessionView, TenantContextView } from '../contracts/index.js';
import type { AppDeps } from '../deps.js';
import { issueCsrfToken } from '../middleware/csrf.js';

/**
 * Session surface for the web shell. Backed by the id-login sessions from
 * POC phase 2 (issue #8); the non-production E2E fake session used by the
 * browser smoke test remains available.
 */
export function sessionRoutes(config: AppConfig, deps: AppDeps): Router {
  const router = Router();

  router.get('/api/session', async (req, res, next) => {
    issueCsrfToken(res, config.nodeEnv === 'production');
    if (req.session) {
      try {
        let selectedTenant: TenantContextView | null = null;
        if (req.session.selectedTenantId) {
          const allowed = await selectableTenants(
            deps,
            req.session.iUserId,
            req.session.superAdmin,
          );
          selectedTenant =
            allowed.find((t) => t.tenantId === req.session!.selectedTenantId) ?? null;
        }
        const session: SessionView = {
          authenticated: true,
          user: {
            iUserId: req.session.iUserId,
            displayName: req.session.displayName,
            email: req.session.email,
            superAdmin: req.session.superAdmin,
          },
          selectedTenant,
        };
        res.json(session);
      } catch (err) {
        next(err);
      }
      return;
    }
    if (config.e2eFakeSession && config.nodeEnv !== 'production') {
      const session: SessionView = {
        authenticated: true,
        user: {
          iUserId: 1,
          displayName: 'E2E Test Admin',
          email: 'e2e-admin@example.invalid',
          superAdmin: true,
        },
        selectedTenant: null,
      };
      res.json(session);
      return;
    }
    res.status(401).json({
      authenticated: false,
      error: 'unauthenticated',
      correlationId: req.correlationId,
    });
  });

  return router;
}
