import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type { AppDeps } from '../deps.js';
import { DirectoryUnavailableError, userDirectory, type DirectoryUserView } from '../directory.js';
import type { Logger } from '../logger.js';
import { IdClientError } from '../id/client.js';
import { IdentityStoreError } from '../nocodb/identity.js';
import { BaseResolutionError } from '../nocodb/base.js';
import { ConflictError, NotFoundError, UniqueViolationError } from '../nocodb/repos.js';
import { ValidationError } from '../nocodb/validation.js';
import { OfficePulseError } from '../officepulse/client.js';
import { HandsetDeliveryError } from '../provisioning/handset-delivery.js';
import {
  requireAnyTenantAdmin,
  requireSession,
  requireSuperAdmin,
  requireTenantAdmin,
  tenantRole,
} from './authz.js';

const tenantBody = z.object({
  name: z.string(),
  slug: z.string(),
  asteriskContext: z.string(),
  callerIdName: z.string().nullish(),
  callerIdNumber: z.string().nullish(),
  enabled: z.boolean(),
});

const tenantUserBody = z.object({
  role: z.enum(['TENANT_ADMIN', 'USER']),
  enabled: z.boolean(),
});

const extensionBody = z.object({
  tenantId: z.string(),
  identityUserId: z.number().int().positive().nullish(),
  extensionNumber: z.string(),
  displayName: z.string(),
  callerIdName: z.string().nullish(),
  callerIdNumber: z.string().nullish(),
  provisioningProfile: z.string().nullish(),
  enabled: z.boolean().default(true),
});

const ringGroupBody = z.object({
  tenantId: z.string(),
  name: z.string(),
  virtualExtension: z.string(),
  ringTimeoutSeconds: z.number().int().min(1).max(300).default(20),
  musicOnHoldClass: z.string().nullish(),
  callerIdName: z.string().nullish(),
  callerIdNumber: z.string().nullish(),
  memberExtensionIds: z.array(z.string()).default([]),
  enabled: z.boolean().default(true),
});

const enrollmentBody = z.object({
  tenantId: z.string(),
  provisioningMac: z.string(),
  ttlSeconds: z.number().int().min(60).max(86400).default(900),
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
  } else if (err instanceof OfficePulseError) {
    res.status(502).json({
      error: 'provisioning_failed',
      message:
        'The record was saved, but PBX provisioning failed. Fix the PBX issue and retry; nothing reconciles in the background.',
      correlationId,
    });
  } else if (err instanceof HandsetDeliveryError) {
    res.status(502).json({
      error: 'handset_delivery_failed',
      message:
        'Enrollment was recorded, but delivery to the provisioning service failed. Issue a new enrollment to retry.',
      correlationId,
    });
  } else if (err instanceof IdClientError) {
    res.status(502).json({
      error: 'id_unavailable',
      message: 'The identity service call failed',
      correlationId,
    });
  } else if (err instanceof DirectoryUnavailableError) {
    res.status(503).json({
      error: 'directory_not_configured',
      message: err.message,
      missingConfiguration: err.missing,
      correlationId,
    });
  } else if (err instanceof BaseResolutionError || err instanceof IdentityStoreError) {
    // The identity base is absent or ambiguous: an operator action, named.
    res.status(503).json({
      error: 'identity_base_unavailable',
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
            ? `The NocoDB AidaAdmin base is not configured: set ${deps.missingNocoDb.join(', ')}`
            : 'The NocoDB AidaAdmin base is not configured',
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

  /**
   * An extension may name one platform user as the person who answers it,
   * and one user may answer several extensions. The user must already be a
   * member of the same tenant: an extension is not a way to grant someone a
   * tenant they were never given.
   */
  async function assertTenantMember(tenantId: string, identityUserId: number): Promise<void> {
    const memberships = await repos().tenantUsers.listForUser(identityUserId);
    if (!memberships.some((m) => m.tenant_id === tenantId)) {
      throw new ValidationError(
        'identityUserId',
        'That user is not a member of this tenant — add them on the tenant users screen first',
      );
    }
  }
  const anyTenantAdmin = requireAnyTenantAdmin(deps);

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
  router.get('/admin/tenants', async (req, res, next) => {
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

  router.put('/admin/tenants/:tenantId', tenantAdmin, async (req, res, next) => {
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

  router.get('/admin/directory/users', anyTenantAdmin, async (req, res, next) => {
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

  router.post('/admin/directory/users', anyTenantAdmin, async (req, res, next) => {
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

  /**
   * The one platform-user field AidaAdmin may change. Everything else about
   * a person — email, identities, credentials — belongs to id alone, and id
   * publishes no update endpoint at all, so this write goes through the
   * NocoDB identity base.
   */
  router.put('/admin/directory/users/:identityUserId', anyTenantAdmin, async (req, res, next) => {
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
  });

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
        people = await directory.search('');
      } catch (err) {
        directoryError = err instanceof Error ? err.message : 'The user directory is unavailable';
      }
      const byId = new Map(people.map((u) => [u.iUserId, u]));
      res.json({
        users: users.map((user) => {
          const person = byId.get(Number(user.identity_user_id));
          return {
            ...user,
            email: person?.email ?? null,
            display_name: person?.displayName ?? null,
            claimed: person?.claimed ?? null,
          };
        }),
        canEditDisplayName: directory.canEditDisplayName,
        directoryError,
      });
    } catch (err) {
      next(err);
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
        const identityUserId = Number(req.params.identityUserId);
        if (!Number.isInteger(identityUserId) || identityUserId <= 0) {
          res.status(400).json({
            error: 'validation',
            message: 'identityUserId must be a positive integer',
            correlationId: req.correlationId,
          });
          return;
        }
        // The mapping references the central user — never copies name/email.
        await repos().tenants.get(tenantId);
        if (directory.available && !(await directory.get(identityUserId))) {
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

  router.put('/admin/super-admins/:identityUserId', requireSuperAdmin, async (req, res, next) => {
    try {
      const body = parse(z.object({ enabled: z.boolean() }), req.body, res, req);
      if (!body) return;
      const identityUserId = Number(req.params.identityUserId);
      const mapping = await repos().tenantUsers.save(
        null,
        identityUserId,
        'SUPER_ADMIN',
        body.enabled,
      );
      await audit(req, 'super_admin.save', 'tenant_user', mapping.id as string, null);
      res.json({ tenantUser: mapping });
    } catch (err) {
      try {
        fail(res, req, err);
      } catch (unhandled) {
        next(unhandled);
      }
    }
  });

  // ── Extensions ────────────────────────────────────────────────────────────

  router.get('/admin/tenants/:tenantId/extensions', tenantAdmin, async (req, res, next) => {
    try {
      res.json({
        extensions: await repos().extensions.listForTenant(req.params.tenantId as string),
      });
    } catch (err) {
      next(err);
    }
  });

  router.post('/admin/extensions', tenantAdmin, async (req, res, next) => {
    try {
      const input = parse(extensionBody, req.body, res, req);
      if (!input) return;
      const tenant = await repos().tenants.get(input.tenantId);
      if (input.identityUserId) await assertTenantMember(input.tenantId, input.identityUserId);
      const extension = await repos().extensions.create(input.tenantId, {
        ...input,
        asteriskContext: tenant.asterisk_context as string,
      });
      await audit(req, 'extension.create', 'extension', extension.id as string, input.tenantId);
      if (!deps.officePulse) {
        // Not a failure: this deployment simply has no PBX wired up yet. The
        // record is saved; say plainly that nothing was provisioned and that
        // no SIP secret exists, rather than reporting an error over a
        // successful write.
        res.status(201).json({
          extension,
          provisioning: 'not_configured',
          message:
            'Extension saved. OFFICEPULSE_PROVISIONING_BASE_URL is not set, so no PBX endpoint was created and no SIP secret was issued.',
          correlationId: req.correlationId,
        });
        return;
      }
      // OfficePulse generates the SIP secret and returns it exactly once; it
      // is relayed to the administrator and never persisted or logged here.
      const provisioned = await deps.officePulse.provisionExtension({
        requestId: extension.id as string,
        tenantId: input.tenantId,
        extensionId: extension.id as string,
        extensionNumber: extension.extension_number as string,
        context: extension.asterisk_context as string,
        displayName: extension.display_name as string,
        callerIdName: (extension.caller_id_name as string | null) ?? null,
        callerIdNumber: (extension.caller_id_number as string | null) ?? null,
        provisioningProfile: (extension.provisioning_profile as string | null) ?? null,
      });
      res.status(201).json({
        extension,
        sipUsername: provisioned.sipUsername,
        sipSecret: provisioned.sipSecret,
        secretShownOnce: true,
      });
    } catch (err) {
      try {
        fail(res, req, err);
      } catch (unhandled) {
        next(unhandled);
      }
    }
  });

  router.put('/admin/extensions/:extensionId', tenantAdmin, async (req, res, next) => {
    try {
      const input = parse(extensionBody, req.body, res, req);
      if (!input) return;
      const revision = expectedRevision(req, res);
      if (revision === null) return;
      const tenant = await repos().tenants.get(input.tenantId);
      if (input.identityUserId) await assertTenantMember(input.tenantId, input.identityUserId);
      const extension = await repos().extensions.update(
        input.tenantId,
        req.params.extensionId as string,
        revision,
        { ...input, asteriskContext: tenant.asterisk_context as string },
      );
      await audit(req, 'extension.update', 'extension', extension.id as string, input.tenantId);
      if (deps.officePulse) {
        await deps.officePulse.updateProvisionedExtension(extension.id as string, {
          extensionNumber: extension.extension_number as string,
          context: extension.asterisk_context as string,
          displayName: extension.display_name as string,
          callerIdName: (extension.caller_id_name as string | null) ?? null,
          callerIdNumber: (extension.caller_id_number as string | null) ?? null,
          provisioningProfile: (extension.provisioning_profile as string | null) ?? null,
          enabled: Boolean(extension.enabled),
        });
      }
      res.json({ extension });
    } catch (err) {
      try {
        fail(res, req, err);
      } catch (unhandled) {
        next(unhandled);
      }
    }
  });

  router.post(
    '/admin/extensions/:extensionId/rotate-secret',
    tenantAdmin,
    async (req, res, next) => {
      try {
        const body = parse(
          z.object({ tenantId: z.string(), reprovisionDevice: z.boolean().default(false) }),
          req.body,
          res,
          req,
        );
        if (!body) return;
        const extension = await repos().extensions.get(
          body.tenantId,
          req.params.extensionId as string,
        );
        if (!deps.officePulse) {
          res
            .status(503)
            .json({ error: 'officepulse_not_configured', correlationId: req.correlationId });
          return;
        }
        const rotated = await deps.officePulse.rotateProvisionedExtensionSecret(
          extension.id as string,
          randomUUID(),
          body.reprovisionDevice,
        );
        if (body.reprovisionDevice) {
          // Invalidate previously issued device credentials.
          await repos().extensions.bumpCredentialVersion(
            body.tenantId,
            extension.id as string,
            Number(extension.revision),
            Number(extension.device_credential_version ?? 1),
          );
        }
        await audit(
          req,
          'extension.rotate_secret',
          'extension',
          extension.id as string,
          body.tenantId,
        );
        res.json({ sipSecret: rotated.sipSecret, secretShownOnce: true });
      } catch (err) {
        try {
          fail(res, req, err);
        } catch (unhandled) {
          next(unhandled);
        }
      }
    },
  );

  router.post(
    '/admin/extensions/:extensionId/handset-enrollment',
    tenantAdmin,
    async (req, res, next) => {
      try {
        const body = parse(enrollmentBody, req.body, res, req);
        if (!body) return;
        const extension = await repos().extensions.get(
          body.tenantId,
          req.params.extensionId as string,
        );
        if (!deps.handsetDelivery) {
          res.status(503).json({
            error: 'handset_provisioning_not_configured',
            correlationId: req.correlationId,
          });
          return;
        }
        const deviceId = randomUUID();
        const enrollmentToken = randomBytes(32).toString('base64url');
        const expiresAt = new Date(Date.now() + body.ttlSeconds * 1000).toISOString();
        // Only the hash reaches NocoDB; the plaintext goes once to the
        // provisioning service and once to the administrator's response.
        const updated = await repos().extensions.recordEnrollment(
          body.tenantId,
          extension.id as string,
          Number(extension.revision),
          {
            deviceId,
            provisioningMac: body.provisioningMac,
            enrollmentTokenHash: createHash('sha256').update(enrollmentToken).digest('hex'),
            enrollmentExpiresAt: expiresAt,
          },
        );
        await deps.handsetDelivery.deliver({
          deviceId,
          provisioningMac: updated.provisioning_mac as string,
          enrollmentToken,
          expiresAt,
        });
        await audit(
          req,
          'extension.handset_enrollment',
          'extension',
          extension.id as string,
          body.tenantId,
        );
        res.status(201).json({ deviceId, enrollmentToken, expiresAt, tokenShownOnce: true });
      } catch (err) {
        try {
          fail(res, req, err);
        } catch (unhandled) {
          next(unhandled);
        }
      }
    },
  );

  // ── Ring groups ───────────────────────────────────────────────────────────

  router.get('/admin/tenants/:tenantId/ring-groups', tenantAdmin, async (req, res, next) => {
    try {
      const tenantId = req.params.tenantId as string;
      const groups = await repos().ringGroups.listForTenant(tenantId);
      const withMembers = await Promise.all(
        groups.map(async (group) => ({
          ...group,
          members: (await repos().ringGroups.listMembers(tenantId, group.id as string)).filter(
            (m) => m.enabled,
          ),
        })),
      );
      res.json({ ringGroups: withMembers });
    } catch (err) {
      next(err);
    }
  });

  async function provisionRingGroup(
    tenantId: string,
    group: Record<string, unknown>,
  ): Promise<void> {
    if (!deps.officePulse) return;
    const members = (await repos().ringGroups.listMembers(tenantId, group.id as string)).filter(
      (m) => m.enabled,
    );
    const numbers: string[] = [];
    for (const member of members) {
      const ext = await repos().extensions.get(tenantId, member.extension_id as string);
      numbers.push(ext.extension_number as string);
    }
    await deps.officePulse.provisionRingGroup(group.id as string, {
      tenantId,
      virtualExtension: group.virtual_extension as string,
      context: group.asterisk_context as string,
      memberExtensions: numbers,
      ringTimeoutSeconds: Number(group.ring_timeout_seconds ?? 20),
      musicOnHoldClass: (group.music_on_hold_class as string | null) ?? null,
      callerIdName: (group.caller_id_name as string | null) ?? null,
      callerIdNumber: (group.caller_id_number as string | null) ?? null,
      enabled: Boolean(group.enabled),
    });
  }

  router.post('/admin/ring-groups', tenantAdmin, async (req, res, next) => {
    try {
      const input = parse(ringGroupBody, req.body, res, req);
      if (!input) return;
      const tenant = await repos().tenants.get(input.tenantId);
      const group = await repos().ringGroups.create(input.tenantId, {
        ...input,
        asteriskContext: tenant.asterisk_context as string,
      });
      await repos().ringGroups.setMembers(
        input.tenantId,
        group.id as string,
        input.memberExtensionIds,
      );
      await audit(req, 'ring_group.create', 'ring_group', group.id as string, input.tenantId);
      await provisionRingGroup(input.tenantId, group);
      res.status(201).json({ ringGroup: group });
    } catch (err) {
      try {
        fail(res, req, err);
      } catch (unhandled) {
        next(unhandled);
      }
    }
  });

  router.put('/admin/ring-groups/:ringGroupId', tenantAdmin, async (req, res, next) => {
    try {
      const input = parse(ringGroupBody, req.body, res, req);
      if (!input) return;
      const revision = expectedRevision(req, res);
      if (revision === null) return;
      const tenant = await repos().tenants.get(input.tenantId);
      const group = await repos().ringGroups.update(
        input.tenantId,
        req.params.ringGroupId as string,
        revision,
        { ...input, asteriskContext: tenant.asterisk_context as string },
      );
      await repos().ringGroups.setMembers(
        input.tenantId,
        group.id as string,
        input.memberExtensionIds,
      );
      await audit(req, 'ring_group.update', 'ring_group', group.id as string, input.tenantId);
      await provisionRingGroup(input.tenantId, group);
      res.json({ ringGroup: group });
    } catch (err) {
      try {
        fail(res, req, err);
      } catch (unhandled) {
        next(unhandled);
      }
    }
  });

  return router;
}
