import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type { AppDeps } from '../deps.js';
import { DirectoryUnavailableError, userDirectory, type DirectoryUserView } from '../directory.js';
import type { Logger } from '../logger.js';
import { IdClientError } from '../id/client.js';
import { BaseResolutionError } from '../nocodb/base.js';
import { ConflictError, NotFoundError, UniqueViolationError } from '../nocodb/repos.js';
import { ValidationError } from '../nocodb/validation.js';
import { requireSession, requireSuperAdmin, requireTenantAdmin, tenantRole } from './authz.js';

const tenantBody = z.object({
  name: z.string(),
  slug: z.string(),
  asteriskContext: z.string(),
  callerIdName: z.string().nullish(),
  callerIdNumber: z.string().nullish(),
  enabled: z.boolean(),
});

const tenantUserBody = z.object({
  role: z.enum(['SUPER_ADMIN', 'TENANT_ADMIN', 'USER']),
  enabled: z.boolean(),
  displayName: z.string().trim().max(255).nullable().optional(),
  email: z.string().email().optional(),
});

/**
 * Maps domain errors to safe responses. Provisioning failures are reported
 * clearly and immediately — there is no background reconciliation in the POC.
 */
function fail(res: Response, req: Request, err: unknown): void {
  const correlationId = req.correlationId;
  if (err instanceof ValidationError) {
    res
      .status(400)
      .json({ error: 'validation', field: err.field, message: err.message, correlationId });
  } else if (err instanceof UniqueViolationError) {
    res
      .status(409)
      .json({ error: 'duplicate', fields: err.fields, message: err.message, correlationId });
  } else if (err instanceof ConflictError) {
    res.status(409).json({ error: 'revision_conflict', message: err.message, correlationId });
  } else if (err instanceof NotFoundError) {
    res.status(404).json({ error: 'not_found', message: err.message, correlationId });
  } else if (err instanceof IdClientError) {
    res
      .status(err.status && [400, 401, 403, 404, 409].includes(err.status) ? err.status : 502)
      .json({
        error: 'id_request_failed',
        message: err.publicMessage ?? 'The identity service call failed',
        correlationId,
      });
  } else if (err instanceof DirectoryUnavailableError) {
    res.status(503).json({
      error: 'directory_not_configured',
      message: err.message,
      missingConfiguration: err.missing,
      correlationId,
    });
  } else if (err instanceof BaseResolutionError) {
    // The identity base is absent or ambiguous: an operator action, named.
    res.status(503).json({
      error: 'platform_config_unavailable',
      message: err.message,
      correlationId,
    });
  } else {
    throw err;
  }
}

function parse<S extends z.ZodTypeAny>(
  schema: S,
  body: unknown,
  res: Response,
  req: Request,
): z.output<S> | null {
  const result = schema.safeParse(body);
  if (!result.success) {
    res.status(400).json({
      error: 'validation',
      message: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      correlationId: req.correlationId,
    });
    return null;
  }
  return result.data;
}

function expectedRevision(req: Request, res: Response): number | null {
  const value = Number((req.body as Record<string, unknown> | undefined)?.expectedRevision);
  if (!Number.isInteger(value) || value < 1) {
    res.status(400).json({
      error: 'validation',
      message: 'expectedRevision (integer >= 1) is required for updates',
      correlationId: req.correlationId,
    });
    return null;
  }
  return value;
}

export function adminRoutes(logger: Logger, deps: AppDeps): Router {
  const router = Router();

  // Administration is open to two roles, and which one a route needs is
  // stated on the route itself: platform-wide actions take requireSuperAdmin,
  // everything scoped to one tenant takes requireTenantAdmin, which admits a
  // Super Admin anywhere and a TENANT_ADMIN only in their own tenant.
  router.use('/admin', requireSession);

  router.use('/admin', (req, res, next) => {
    if (!deps.repos) {
      res.status(503).json({
        error: 'nocodb_not_configured',
        message:
          deps.missingNocoDb.length > 0
            ? `The NocoDB PlatformConfig base is not configured: set ${deps.missingNocoDb.join(', ')}`
            : 'The NocoDB PlatformConfig base is not configured',
        missingConfiguration: deps.missingNocoDb,
        correlationId: req.correlationId,
      });
      return;
    }
    next();
  });

  const repos = () => deps.repos!;
  const tenantAdmin = requireTenantAdmin(deps);
  const directory = userDirectory(deps);

  const audit = (
    req: Request,
    action: string,
    entityType: string,
    entityId: string,
    tenantId: string | null,
  ) =>
    repos()
      .audit.append({
        tenantId,
        actorIdentityUserId: req.session!.iUserId,
        action,
        entityType,
        entityId,
        correlationId: req.correlationId,
      })
      .catch((err) => logger.error({ err }, 'audit append failed'));

  // ── Tenants ───────────────────────────────────────────────────────────────

  /**
   * Scoped to what the caller may administer rather than gated outright: a
   * Super Admin sees every tenant, a TENANT_ADMIN sees the ones they
   * administer, and anyone else sees none. That makes this list the natural
   * entry point to a tenant's screens for both roles.
   */
  router.get('/admin/tenants', requireSuperAdmin, async (req, res, next) => {
    try {
      const session = req.session!;
      const tenants = await repos().tenants.list();
      if (session.superAdmin) {
        res.json({ tenants });
        return;
      }
      const memberships = await repos().tenantUsers.listForUser(session.iUserId);
      const administered = new Set(
        memberships
          .filter((m) => Boolean(m.enabled) && m.role === 'TENANT_ADMIN' && m.tenant_id)
          .map((m) => m.tenant_id as string),
      );
      res.json({ tenants: tenants.filter((t) => administered.has(t.id as string)) });
    } catch (err) {
      next(err);
    }
  });

  router.post('/admin/tenants', requireSuperAdmin, async (req, res, next) => {
    try {
      const input = parse(tenantBody, req.body, res, req);
      if (!input) return;
      const tenant = await repos().tenants.create(input);
      await audit(req, 'tenant.create', 'tenant', tenant.id as string, tenant.id as string);
      res.status(201).json({ tenant });
    } catch (err) {
      try {
        fail(res, req, err);
      } catch (unhandled) {
        next(unhandled);
      }
    }
  });

  router.put('/admin/tenants/:tenantId', requireSuperAdmin, async (req, res, next) => {
    try {
      const input = parse(tenantBody, req.body, res, req);
      if (!input) return;
      const revision = expectedRevision(req, res);
      if (revision === null) return;
      const tenant = await repos().tenants.update(req.params.tenantId as string, revision, input);
      await audit(req, 'tenant.update', 'tenant', tenant.id as string, tenant.id as string);
      res.json({ tenant });
    } catch (err) {
      try {
        fail(res, req, err);
      } catch (unhandled) {
        next(unhandled);
      }
    }
  });

  // ── Central directory + tenant users ──────────────────────────────────────

  router.get('/admin/directory/users', requireSuperAdmin, async (req, res, next) => {
    try {
      const query = typeof req.query.query === 'string' ? req.query.query : '';
      res.json({
        users: await directory.search(query),
        canEditDisplayName: directory.canEditDisplayName,
        canCreate: directory.canCreate,
      });
    } catch (err) {
      try {
        fail(res, req, err);
      } catch (unhandled) {
        next(unhandled);
      }
    }
  });

  router.post('/admin/directory/users', requireSuperAdmin, async (req, res, next) => {
    try {
      const body = parse(
        z.object({ email: z.string().email(), displayName: z.string().nullish() }),
        req.body,
        res,
        req,
      );
      if (!body) return;
      const user = await directory.ensure(body.email, body.displayName ?? null);
      res.status(201).json({ user });
    } catch (err) {
      try {
        fail(res, req, err);
      } catch (unhandled) {
        next(unhandled);
      }
    }
  });

  /** Authorized display-name edits go through Identity's audited API. */
  router.put(
    '/admin/directory/users/:identityUserId',
    requireSuperAdmin,
    async (req, res, next) => {
      try {
        const body = parse(
          z.object({ displayName: z.string().max(255).nullish() }),
          req.body,
          res,
          req,
        );
        if (!body) return;
        const identityUserId = Number(req.params.identityUserId);
        if (!Number.isInteger(identityUserId) || identityUserId <= 0) {
          res.status(400).json({
            error: 'validation',
            message: 'identityUserId must be a positive integer',
            correlationId: req.correlationId,
          });
          return;
        }
        const displayName = body.displayName?.trim() || null;
        const user = await directory.updateDisplayName(identityUserId, displayName);
        await audit(req, 'directory_user.update', 'identity_user', String(identityUserId), null);
        res.json({ user });
      } catch (err) {
        try {
          fail(res, req, err);
        } catch (unhandled) {
          next(unhandled);
        }
      }
    },
  );

  /**
   * The tenant's members, each resolved against the central directory so the
   * screen can show a person rather than a bare id. A directory that cannot
   * be reached degrades to ids alone instead of failing the listing.
   */
  router.get('/admin/tenants/:tenantId/users', tenantAdmin, async (req, res, next) => {
    try {
      const users = await repos().tenantUsers.listForTenant(req.params.tenantId as string);
      let people: DirectoryUserView[] = [];
      let directoryError: string | null = null;
      try {
        if (req.session!.superAdmin) people = await directory.search('');
      } catch (err) {
        directoryError = err instanceof Error ? err.message : 'The user directory is unavailable';
      }
      const byId = new Map(people.map((u) => [u.iUserId, u]));
      res.json({
        users: users.map((user) => {
          const person = byId.get(Number(user.identity_user_id));
          return {
            ...user,
            email: person?.email ?? user.email ?? null,
            display_name: person?.displayName ?? user.display_name ?? null,
            claimed: person?.claimed ?? user.claimed ?? null,
          };
        }),
        canEditDisplayName:
          Boolean(deps.idClient?.manageTenantMember) ||
          (req.session!.superAdmin && directory.canEditDisplayName),
        canManageDirectory: Boolean(deps.idClient?.addTenantMember) || req.session!.superAdmin,
        assignableRoles: req.session!.superAdmin
          ? ['SUPER_ADMIN', 'TENANT_ADMIN', 'USER']
          : ['TENANT_ADMIN', 'USER'],
        directoryError,
      });
    } catch (err) {
      next(err);
    }
  });

  router.post('/admin/tenants/:tenantId/users', tenantAdmin, async (req, res, next) => {
    try {
      const input = parse(
        tenantUserBody.extend({
          email: z.string().email(),
          displayName: z.string().trim().max(255).nullable(),
        }),
        req.body,
        res,
        req,
      );
      if (!input) return;
      if (input.role === 'SUPER_ADMIN' && !req.session!.superAdmin) {
        res
          .status(403)
          .json({ error: 'forbidden', message: 'Only a Super Admin can assign that role' });
        return;
      }
      if (!deps.idClient?.addTenantMember)
        throw new DirectoryUnavailableError('Identity membership management is unavailable');
      const user = await deps.idClient.addTenantMember(req.params.tenantId as string, input);
      res.status(201).json({ user });
    } catch (err) {
      try {
        fail(res, req, err);
      } catch (unhandled) {
        next(unhandled);
      }
    }
  });
  router.put(
    '/admin/tenants/:tenantId/users/:identityUserId',
    tenantAdmin,
    async (req, res, next) => {
      try {
        const input = parse(tenantUserBody, req.body, res, req);
        if (!input) return;
        const tenantId = req.params.tenantId as string;
        if (input.role === 'SUPER_ADMIN' && !req.session!.superAdmin) {
          res
            .status(403)
            .json({ error: 'forbidden', message: 'Only a Super Admin can assign that role' });
          return;
        }
        const identityUserId = Number(req.params.identityUserId);
        if (!Number.isInteger(identityUserId) || identityUserId <= 0) {
          res.status(400).json({
            error: 'validation',
            message: 'identityUserId must be a positive integer',
            correlationId: req.correlationId,
          });
          return;
        }
        if (deps.idClient?.manageTenantMember) {
          const member = await deps.idClient.manageTenantMember(tenantId, identityUserId, input);
          res.json({
            tenantUser: {
              identity_user_id: member.iUserId,
              role: member.role,
              enabled: member.bEnabled,
            },
          });
          return;
        }
        // The mapping references the central user — never copies name/email.
        await repos().tenants.get(tenantId);
        if (
          req.session!.superAdmin &&
          directory.available &&
          !(await directory.get(identityUserId))
        ) {
          res
            .status(404)
            .json({ error: 'unknown_identity_user', correlationId: req.correlationId });
          return;
        }
        // A tenant administrator must not be able to demote or lock out the
        // last administrator of their own tenant by editing themselves.
        if (!req.session!.superAdmin && identityUserId === req.session!.iUserId) {
          const current = await tenantRole(deps, identityUserId, tenantId);
          if (current === 'TENANT_ADMIN' && (input.role !== 'TENANT_ADMIN' || !input.enabled)) {
            res.status(403).json({
              error: 'forbidden',
              message: 'You cannot remove your own administrator access to this tenant',
              correlationId: req.correlationId,
            });
            return;
          }
        }
        const mapping = await repos().tenantUsers.save(
          tenantId,
          identityUserId,
          input.role,
          input.enabled,
        );
        await audit(req, 'tenant_user.save', 'tenant_user', mapping.id as string, tenantId);
        res.json({ tenantUser: mapping });
      } catch (err) {
        try {
          fail(res, req, err);
        } catch (unhandled) {
          next(unhandled);
        }
      }
    },
  );

  router.put('/admin/super-admins/:identityUserId', requireSuperAdmin, (req, res) => {
    res.status(403).json({
      error: 'identity_managed_privilege',
      message:
        'SUPER_ADMIN is managed by Identity; tenant memberships cannot grant platform privileges',
      correlationId: req.correlationId,
    });
  });

  return router;
}
