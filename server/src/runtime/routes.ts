import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { selectableTenants } from '../auth/tenant-selection.js';
import type { AppDeps } from '../deps.js';
import type { Logger } from '../logger.js';
import { NotFoundError } from '../nocodb/repos.js';
import { OfficePulseError } from '../officepulse/client.js';
import { reprovision, type ProvisionableKind } from '../officepulse/reprovision.js';
import { RuntimeDbError, type RuntimeCallSession } from '../officepulse/runtime-db.js';

/**
 * Runtime visibility and actions (issue #29). There is no AidaControl:
 * OfficePulseAidaIntegration orchestrates calls and owns the
 * `aida_officepulse` runtime database. AidaAdmin READS that database
 * through a read-only account and sends the few allowed ACTIONS to
 * OfficePulse's private HTTP API — never a proxy, never a table write.
 *
 * Every route re-resolves the session, tenant, and role before touching
 * anything, so a revoked membership fails now, not at the next login.
 * Call views are scoped to the selected tenant for everyone; the
 * platform-wide views (dependencies, provisioning history, webhook
 * deliveries, orphans) are Super Admin.
 */

const commandBody = z.object({
  commandType: z.literal('TAKEOVER'),
  idempotencyKey: z.string().min(8).max(120),
  ringTimeoutSeconds: z.number().int().min(5).max(300).optional(),
  musicOnHoldClass: z.string().max(80).optional(),
});

const retryBody = z.object({
  kind: z.enum(['EXTENSION', 'RING_GROUP', 'DID']),
  externalId: z.string().min(1).max(60),
});

/** Event types that mean a call did not go the way it was configured to. */
const ISSUE_EVENT_TYPES = ['takeover-failed', 'fallback', 'aida-lost'];
const ISSUE_WINDOW_HOURS = 24;

type Role = 'SUPER_ADMIN' | 'TENANT_ADMIN' | 'USER';

interface RuntimeContext {
  iUserId: number;
  /** Null only for a Super Admin who has not selected a tenant. */
  tenantId: string | null;
  role: Role;
  superAdmin: boolean;
}

/**
 * What a person sees of a caller. Administrators see the number; a USER
 * — staff answering calls — sees enough to recognise a repeat caller and
 * no more.
 */
export function presentCaller(callerNumber: string | null, role: Role): string | null {
  if (callerNumber === null) return null;
  if (role !== 'USER') return callerNumber;
  const digits = callerNumber.replace(/\D/g, '');
  return digits.length > 4 ? `•••${digits.slice(-4)}` : '•••';
}

export function runtimeRoutes(logger: Logger, deps: AppDeps): Router {
  const router = Router();

  async function resolveContext(req: Request, res: Response): Promise<RuntimeContext | null> {
    if (!req.session || !req.sessionRef) {
      res.status(401).json({ error: 'unauthenticated', correlationId: req.correlationId });
      return null;
    }
    const session = req.session;
    const tenantId = session.selectedTenantId;
    if (!tenantId) {
      if (session.superAdmin) {
        return { iUserId: session.iUserId, tenantId: null, role: 'SUPER_ADMIN', superAdmin: true };
      }
      res.status(403).json({
        error: 'tenant_not_selected',
        message: 'Select a tenant before using runtime views',
        correlationId: req.correlationId,
      });
      return null;
    }
    // Membership and role are re-resolved on every call.
    const allowed = await selectableTenants(deps, session.iUserId, session.superAdmin);
    const selected = allowed.find((t) => t.tenantId === tenantId);
    if (!selected) {
      res.status(403).json({ error: 'forbidden', correlationId: req.correlationId });
      return null;
    }
    return {
      iUserId: session.iUserId,
      tenantId,
      role: selected.role,
      superAdmin: session.superAdmin,
    };
  }

  function requireSuperAdmin(ctx: RuntimeContext, req: Request, res: Response): boolean {
    if (ctx.superAdmin) return true;
    res.status(403).json({
      error: 'forbidden',
      message: 'Super Admin access required',
      correlationId: req.correlationId,
    });
    return false;
  }

  /**
   * The tenant a read is scoped to. Undefined means "every tenant", which
   * only a Super Admin can ask for (`?tenant=all`, or no tenant selected).
   */
  function scopeFor(ctx: RuntimeContext, req: Request): string | undefined {
    if (!ctx.superAdmin) return ctx.tenantId as string;
    const requested = req.query.tenant;
    if (requested === 'all') return undefined;
    if (typeof requested === 'string' && requested) return requested;
    return ctx.tenantId ?? undefined;
  }

  function reader(req: Request, res: Response) {
    if (!deps.runtimeReader) {
      res.status(503).json({
        error: 'runtime_db_not_configured',
        message:
          'The OfficePulse runtime database is not configured: set OFFICEPULSE_RUNTIME_DATABASE_URL ' +
          'to the read-only aidaadmin_ro account on aida_officepulse',
        missingConfiguration: ['OFFICEPULSE_RUNTIME_DATABASE_URL'],
        correlationId: req.correlationId,
      });
      return null;
    }
    return deps.runtimeReader;
  }

  function officePulse(req: Request, res: Response) {
    if (!deps.officePulse) {
      res.status(503).json({
        error: 'officepulse_not_configured',
        message: 'OfficePulse is not configured: set OFFICEPULSE_PROVISIONING_BASE_URL',
        missingConfiguration: ['OFFICEPULSE_PROVISIONING_BASE_URL'],
        correlationId: req.correlationId,
      });
      return null;
    }
    return deps.officePulse;
  }

  function fail(res: Response, req: Request, err: unknown): void {
    const correlationId = req.correlationId;
    if (err instanceof RuntimeDbError) {
      logger.error({ err, correlationId }, 'runtime database read failed');
      res.status(502).json({
        error: 'runtime_db_unavailable',
        message: 'The OfficePulse runtime database could not be read',
        correlationId,
      });
    } else if (err instanceof OfficePulseError) {
      logger.error({ err, correlationId }, 'OfficePulse request failed');
      res.status(502).json({
        error: 'officepulse_unavailable',
        message: err.upstreamError
          ? `OfficePulse answered: ${err.upstreamError}`
          : 'OfficePulse could not be reached',
        correlationId,
      });
    } else if (err instanceof NotFoundError) {
      res.status(404).json({ error: 'not_found', message: err.message, correlationId });
    } else {
      throw err;
    }
  }

  const audit = (
    req: Request,
    ctx: RuntimeContext,
    action: string,
    entityType: string,
    entityId: string,
    tenantId: string | null,
    details?: Record<string, unknown>,
  ) =>
    deps.repos?.audit
      .append({
        tenantId,
        actorIdentityUserId: ctx.iUserId,
        action,
        entityType,
        entityId,
        ...(details ? { details } : {}),
        correlationId: req.correlationId,
      })
      .catch((err) => logger.error({ err }, 'audit append failed')) ?? Promise.resolve();

  function present(session: RuntimeCallSession, role: Role) {
    return { ...session, callerNumber: presentCaller(session.callerNumber, role) };
  }

  // ── Calls ──────────────────────────────────────────────────────────────────

  router.get('/runtime/calls', async (req, res, next) => {
    try {
      const ctx = await resolveContext(req, res);
      if (!ctx) return;
      const db = reader(req, res);
      if (!db) return;
      const state = req.query.state;
      const wanted =
        state === 'recent' || state === 'orphaned' || state === 'all' ? state : 'active';
      // Orphans and the unfiltered list are diagnostics, not a staff view.
      if ((wanted === 'orphaned' || wanted === 'all') && !requireSuperAdmin(ctx, req, res)) return;
      const limit = Number(req.query.limit);
      const calls = await db.listCallSessions({
        state: wanted,
        tenantId: scopeFor(ctx, req),
        limit: Number.isFinite(limit) ? limit : undefined,
      });
      res.json({ calls: calls.map((c) => present(c, ctx.role)) });
    } catch (err) {
      try {
        fail(res, req, err);
      } catch (unhandled) {
        next(unhandled);
      }
    }
  });

  /** Everything known about one call, in one round trip. */
  router.get('/runtime/calls/:callSessionId', async (req, res, next) => {
    try {
      const ctx = await resolveContext(req, res);
      if (!ctx) return;
      const db = reader(req, res);
      if (!db) return;
      const id = req.params.callSessionId as string;
      const call = await db.getCallSession(id, scopeFor(ctx, req));
      if (!call) {
        // Another tenant's call and a nonexistent one look identical.
        res.status(404).json({ error: 'call_not_found', correlationId: req.correlationId });
        return;
      }
      const [events, commands, participants] = await Promise.all([
        db.listCallEvents(id),
        db.listControlCommands(id),
        db.listParticipants(id),
      ]);
      res.json({ call: present(call, ctx.role), events, commands, participants });
    } catch (err) {
      try {
        fail(res, req, err);
      } catch (unhandled) {
        next(unhandled);
      }
    }
  });

  router.get('/runtime/calls/:callSessionId/events', async (req, res, next) => {
    try {
      const ctx = await resolveContext(req, res);
      if (!ctx) return;
      const db = reader(req, res);
      if (!db) return;
      const id = req.params.callSessionId as string;
      if (!(await db.getCallSession(id, scopeFor(ctx, req)))) {
        res.status(404).json({ error: 'call_not_found', correlationId: req.correlationId });
        return;
      }
      const since = Number(req.query.since);
      res.json({ events: await db.listCallEvents(id, Number.isFinite(since) ? since : 0) });
    } catch (err) {
      try {
        fail(res, req, err);
      } catch (unhandled) {
        next(unhandled);
      }
    }
  });

  /**
   * Takeover. The destination is not in the body on purpose: OfficePulse
   * routes to the destination pinned on the call session at bootstrap, so
   * a command cannot redirect a call — and certainly not across tenants.
   */
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
      const api = officePulse(req, res);
      if (!api) return;
      const id = req.params.callSessionId as string;

      // The call must be this tenant's before anything is sent. Without the
      // runtime database that cannot be established, so only a Super Admin
      // may proceed on trust.
      let tenantId: string | null = ctx.tenantId;
      if (deps.runtimeReader) {
        const call = await deps.runtimeReader.getCallSession(id, scopeFor(ctx, req));
        if (!call) {
          res.status(404).json({ error: 'call_not_found', correlationId: req.correlationId });
          return;
        }
        tenantId = call.tenantId;
      } else if (!ctx.superAdmin) {
        reader(req, res);
        return;
      }

      const outcome = await api.submitCallCommand(id, parsed.data);
      await audit(req, ctx, 'runtime.command', 'call_session', id, tenantId, {
        commandType: parsed.data.commandType,
        idempotencyKey: parsed.data.idempotencyKey,
        upstreamStatus: outcome.status,
      });
      // Relay only known-safe fields of OfficePulse's answer.
      const body = outcome.body;
      res.status(outcome.status).json({
        accepted: outcome.status === 202,
        duplicate: body.duplicate === true,
        status: typeof body.status === 'string' ? body.status : undefined,
        error: typeof body.error === 'string' ? body.error : undefined,
        details: Array.isArray(body.details) ? body.details : undefined,
        correlationId: req.correlationId,
      });
    } catch (err) {
      try {
        fail(res, req, err);
      } catch (unhandled) {
        next(unhandled);
      }
    }
  });

  // ── Issues: what went wrong recently, in one list ─────────────────────────

  router.get('/runtime/issues', async (req, res, next) => {
    try {
      const ctx = await resolveContext(req, res);
      if (!ctx) return;
      const db = reader(req, res);
      if (!db) return;
      const scope = scopeFor(ctx, req);
      const [failedCommands, events, dependencies] = await Promise.all([
        db.listFailedCommands(ISSUE_WINDOW_HOURS, scope),
        db.listEventsOfType(ISSUE_EVENT_TYPES, ISSUE_WINDOW_HOURS, scope),
        ctx.superAdmin ? db.listDependencyStatus() : Promise.resolve([]),
      ]);
      res.json({
        windowHours: ISSUE_WINDOW_HOURS,
        failedCommands,
        events,
        dependenciesDown: dependencies.filter((d) => !d.ready),
      });
    } catch (err) {
      try {
        fail(res, req, err);
      } catch (unhandled) {
        next(unhandled);
      }
    }
  });

  // ── Dependencies (Super Admin) ─────────────────────────────────────────────

  router.get('/runtime/dependencies', async (req, res, next) => {
    try {
      const ctx = await resolveContext(req, res);
      if (!ctx || !requireSuperAdmin(ctx, req, res)) return;
      const db = reader(req, res);
      if (!db) return;
      const [recorded, live] = await Promise.all([
        db.listDependencyStatus(),
        deps.officePulse ? deps.officePulse.readiness() : Promise.resolve(null),
      ]);
      res.json({ recorded, live });
    } catch (err) {
      try {
        fail(res, req, err);
      } catch (unhandled) {
        next(unhandled);
      }
    }
  });

  /** An on-demand probe of OfficePulse's own readiness — auditable. */
  router.post('/runtime/dependencies/test', async (req, res, next) => {
    try {
      const ctx = await resolveContext(req, res);
      if (!ctx || !requireSuperAdmin(ctx, req, res)) return;
      const api = officePulse(req, res);
      if (!api) return;
      const live = await api.readiness();
      await audit(req, ctx, 'runtime.dependency_test', 'officepulse', 'readyz', null, {
        reachable: live.reachable,
        ready: live.ready,
      });
      res.json({ live });
    } catch (err) {
      try {
        fail(res, req, err);
      } catch (unhandled) {
        next(unhandled);
      }
    }
  });

  // ── Provisioning history and retry ─────────────────────────────────────────

  /** The ids of every provisionable record in a tenant, for scoping. */
  async function tenantEntityIds(tenantId: string): Promise<Set<string>> {
    const repos = deps.repos;
    if (!repos) return new Set();
    const [extensions, groups, routes] = await Promise.all([
      repos.extensions.listForTenant(tenantId),
      repos.ringGroups.listForTenant(tenantId),
      repos.didRoutes.listForTenant(tenantId),
    ]);
    return new Set([...extensions, ...groups, ...routes].map((r) => r.id as string));
  }

  router.get('/runtime/provisioning', async (req, res, next) => {
    try {
      const ctx = await resolveContext(req, res);
      if (!ctx) return;
      if (ctx.role === 'USER') {
        res.status(403).json({ error: 'forbidden', correlationId: req.correlationId });
        return;
      }
      const db = reader(req, res);
      if (!db) return;
      const limit = Number(req.query.limit);
      let operations = await db.listProvisioningOperations(
        Number.isFinite(limit) ? limit : undefined,
      );
      const scope = scopeFor(ctx, req);
      if (scope !== undefined) {
        // provisioning_operation carries no tenant: scope by the tenant's
        // own record ids. Handsets are keyed by device id and stay
        // Super-Admin-only.
        const ids = await tenantEntityIds(scope);
        operations = operations.filter((op) => ids.has(op.externalId));
      }
      res.json({ operations });
    } catch (err) {
      try {
        fail(res, req, err);
      } catch (unhandled) {
        next(unhandled);
      }
    }
  });

  router.post('/runtime/provisioning/retry', async (req, res, next) => {
    try {
      const ctx = await resolveContext(req, res);
      if (!ctx) return;
      if (ctx.role === 'USER') {
        res.status(403).json({ error: 'forbidden', correlationId: req.correlationId });
        return;
      }
      const parsed = retryBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: 'validation',
          message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
          correlationId: req.correlationId,
        });
        return;
      }
      const api = officePulse(req, res);
      if (!api) return;
      if (!deps.repos) {
        res.status(503).json({
          error: 'nocodb_not_configured',
          message: 'Retrying provisioning needs the NocoDB AidaAdmin base',
          correlationId: req.correlationId,
        });
        return;
      }
      const result = await reprovision(
        { ...deps, repos: deps.repos, officePulse: api },
        parsed.data.kind as ProvisionableKind,
        parsed.data.externalId,
        ctx.superAdmin ? null : ctx.tenantId,
      );
      await audit(
        req,
        ctx,
        'runtime.reprovision',
        parsed.data.kind.toLowerCase(),
        parsed.data.externalId,
        result.tenantId,
      );
      res.json({ retried: result });
    } catch (err) {
      try {
        fail(res, req, err);
      } catch (unhandled) {
        next(unhandled);
      }
    }
  });

  // ── Webhooks, fallbacks, orphans ──────────────────────────────────────────

  router.get('/runtime/webhooks', async (req, res, next) => {
    try {
      const ctx = await resolveContext(req, res);
      if (!ctx || !requireSuperAdmin(ctx, req, res)) return;
      const db = reader(req, res);
      if (!db) return;
      const limit = Number(req.query.limit);
      res.json({
        deliveries: await db.listWebhookDeliveries(Number.isFinite(limit) ? limit : undefined),
      });
    } catch (err) {
      try {
        fail(res, req, err);
      } catch (unhandled) {
        next(unhandled);
      }
    }
  });

  /** Which DIDs have a local fail-safe destination projected at OfficePulse. */
  router.get('/runtime/fallbacks', async (req, res, next) => {
    try {
      const ctx = await resolveContext(req, res);
      if (!ctx) return;
      if (ctx.role === 'USER') {
        res.status(403).json({ error: 'forbidden', correlationId: req.correlationId });
        return;
      }
      const db = reader(req, res);
      if (!db) return;
      res.json({ fallbacks: await db.listDidFallbacks(scopeFor(ctx, req)) });
    } catch (err) {
      try {
        fail(res, req, err);
      } catch (unhandled) {
        next(unhandled);
      }
    }
  });

  /**
   * Calls that never ended, with the participants still marked present.
   * Detection only: OfficePulse exposes no cleanup endpoint, and this
   * service will not write to its tables, so there is nothing safe to
   * offer beyond seeing them.
   */
  router.get('/runtime/orphans', async (req, res, next) => {
    try {
      const ctx = await resolveContext(req, res);
      if (!ctx || !requireSuperAdmin(ctx, req, res)) return;
      const db = reader(req, res);
      if (!db) return;
      const calls = await db.listCallSessions({ state: 'orphaned', tenantId: scopeFor(ctx, req) });
      const orphans = await Promise.all(
        calls.map(async (call) => ({
          call: present(call, ctx.role),
          participantsPresent: (await db.listParticipants(call.id)).filter(
            (p) => p.leftAt === null,
          ),
        })),
      );
      res.json({ orphans });
    } catch (err) {
      try {
        fail(res, req, err);
      } catch (unhandled) {
        next(unhandled);
      }
    }
  });

  // Anything else under /runtime does not exist.
  router.use('/runtime', (req, res) => {
    res.status(404).json({ error: 'not_found', correlationId: req.correlationId });
  });

  return router;
}
