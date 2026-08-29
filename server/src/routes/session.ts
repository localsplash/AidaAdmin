import { Router } from 'express';
import type { AppConfig } from '../config.js';
import type { SessionView } from '../contracts/index.js';
import { issueCsrfToken } from '../middleware/csrf.js';

/**
 * Session surface for the web shell. Real id-based login arrives in POC phase
 * 2 (issue #8); until then every request is unauthenticated, except under the
 * explicitly enabled non-production E2E fake session used by the browser
 * smoke test.
 */
export function sessionRoutes(config: AppConfig): Router {
  const router = Router();

  router.get('/api/session', (req, res) => {
    issueCsrfToken(res, config.nodeEnv === 'production');
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
