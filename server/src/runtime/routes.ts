import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { selectableTenants } from '../auth/tenant-selection.js';
import type { AppDeps } from '../deps.js';
import type { AppConfig } from '../config.js';
import type { Logger } from '../logger.js';

const UPSTREAM_TIMEOUT_MS = 10_000;

/**
 * Staff runtime proxy to AidaControl (POC phase 6, issue #9). AidaAdmin is
 * the only browser/session boundary: it resolves the session, selected
 * tenant, and role before every call, originates from an IPv4 inside
 * AIDACONTROL_TRUSTED_SERVER_CIDRS (deployment property, enforced by
 * AidaControl), and sends the verified X-Aida-* context headers. There is
 * deliberately no STAFF_TOKEN_SECRET or AidaAdmin-to-AidaControl shared
 * secret, and no arbitrary reverse proxy — only the routes below exist.
 */

const commandBody = z.object({
  // The staff surface supports takeover and guidance only.
  commandType: z.enum(['TAKEOVER', 'GUIDE']),
  expectedCallVersion: z.number().int().min(0),
  idempotencyKey: z.string().min(8).max(128),
  payload: z.record(z.string(), z.unknown()).optional(),
});

interface RuntimeContext {
  iUserId: number;
  tenantId: string;
  role: 'SUPER_ADMIN' | 'TENANT_ADMIN' | 'USER';
  sessionRef: string;
}

export function runtimeRoutes(config: AppConfig, logger: Logger, deps: AppDeps): Router {
  const router = Router();
  const baseUrl = config.serviceConfig.AIDACONTROL_BASE_URL;

  /**
   * Resolves the full staff context or answers the request itself. Every
   * check happens before anything is proxied.
   */
  async function resolveContext(req: Request, res: Response): Promise<RuntimeContext | null> {
    if (!req.session || !req.sessionRef) {
      res.status(401).json({ error: 'unauthenticated', correlationId: req.correlationId });
      return null;
    }
    if (!baseUrl) {
      res
        .status(503)
        .json({ error: 'aidacontrol_not_configured', correlationId: req.correlationId });
      return null;
    }
    const tenantId = req.session.selectedTenantId;
    if (!tenantId) {
      res.status(403).json({
        error: 'tenant_not_selected',
        message: 'Select a tenant before using runtime views',
        correlationId: req.correlationId,
      });
      return null;
    }
    // Membership and role are re-resolved on every call, so a revoked or
    // disabled tenant_user fails immediately — not at the next login.
    const allowed = await selectableTenants(deps, req.session.iUserId, req.session.superAdmin);
    const selected = allowed.find((t) => t.tenantId === tenantId);
    if (!selected) {
      res.status(403).json({ error: 'forbidden', correlationId: req.correlationId });
      return null;
    }
    return {
      iUserId: req.session.iUserId,
      tenantId,
      role: selected.role,
      sessionRef: req.sessionRef,
    };
  }

  /**
   * Forwards one allowlisted call. Headers are built fresh — browser-supplied
   * X-Aida-* trust headers are never copied — and the response is relayed
   * with a safe envelope on upstream failure.
   */
  async function forward(
    req: Request,
    res: Response,
    ctx: RuntimeContext,
    method: 'GET' | 'POST',
    upstreamPath: string,
    allowedParams: string[] = [],
    body?: unknown,
  ): Promise<void> {
    const url = new URL(upstreamPath, baseUrl);
    for (const param of allowedParams) {
      const value = req.query[param];
      if (typeof value === 'string') url.searchParams.set(param, value);
    }
    try {
      const upstream = await fetch(url, {
        method,
        headers: {
          accept: 'application/json',
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          'X-Aida-Identity-User-Id': String(ctx.iUserId),
          'X-Aida-Tenant-Id': ctx.tenantId,
          'X-Aida-Role': ctx.role,
          'X-Aida-Session-Id': ctx.sessionRef,
          'X-Aida-Correlation-Id': req.correlationId,
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
      const parsed = (await upstream.json().catch(() => null)) as Record<string, unknown> | null;
      if (!upstream.ok) {
        // Relay the status with only safe, known-string fields.
        res.status(upstream.status).json({
          error: typeof parsed?.error === 'string' ? parsed.error : 'aidacontrol_error',
          message: typeof parsed?.message === 'string' ? parsed.message : undefined,
          correlationId: req.correlationId,
        });
        return;
      }
      res.status(upstream.status).json(parsed ?? {});
    } catch (err) {
      if (err instanceof Error && err.name === 'TimeoutError') {
        logger.warn({ correlationId: req.correlationId }, 'AidaControl request timed out');
        res.status(504).json({
          error: 'aidacontrol_timeout',
          message: 'AidaControl did not answer in time',
          correlationId: req.correlationId,
        });
        return;
      }
      logger.error({ err, correlationId: req.correlationId }, 'AidaControl request failed');
      res.status(502).json({
        error: 'aidacontrol_unavailable',
        message: 'AidaControl could not be reached',
        correlationId: req.correlationId,
      });
    }
  }

  // ── Explicit endpoint allowlist ───────────────────────────────────────────

  router.get('/runtime/calls', async (req, res, next) => {
    try {
      const ctx = await resolveContext(req, res);
      if (!ctx) return;
      await forward(req, res, ctx, 'GET', '/v1/calls', ['state', 'limit']);
    } catch (err) {
      next(err);
    }
  });

  router.get('/runtime/calls/:callSessionId', async (req, res, next) => {
    try {
      const ctx = await resolveContext(req, res);
      if (!ctx) return;
      await forward(
        req,
        res,
        ctx,
        'GET',
        `/v1/calls/${encodeURIComponent(req.params.callSessionId as string)}`,
      );
    } catch (err) {
      next(err);
    }
  });

  router.get('/runtime/calls/:callSessionId/events', async (req, res, next) => {
    try {
      const ctx = await resolveContext(req, res);
      if (!ctx) return;
      await forward(
        req,
        res,
        ctx,
        'GET',
        `/v1/calls/${encodeURIComponent(req.params.callSessionId as string)}/events`,
        ['since', 'limit'],
      );
    } catch (err) {
      next(err);
    }
  });

  router.post('/runtime/calls/:callSessionId/commands', async (req, res, next) => {
    try {
      const ctx = await resolveContext(req, res);
      if (!ctx) return;
      const parsed = commandBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: 'validation',
          message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
          correlationId: req.correlationId,
        });
        return;
      }
      await forward(
        req,
        res,
        ctx,
        'POST',
        `/v1/calls/${encodeURIComponent(req.params.callSessionId as string)}/commands`,
        [],
        parsed.data,
      );
    } catch (err) {
      next(err);
    }
  });

  router.get('/runtime/operational-events', async (req, res, next) => {
    try {
      const ctx = await resolveContext(req, res);
      if (!ctx) return;
      await forward(req, res, ctx, 'GET', '/v1/operational-events', ['since', 'limit']);
    } catch (err) {
      next(err);
    }
  });

  // Anything else under /runtime is not proxied.
  router.use('/runtime', (req, res) => {
    res.status(404).json({ error: 'not_found', correlationId: req.correlationId });
  });

  return router;
}
