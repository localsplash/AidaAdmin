import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type { AppDeps } from '../deps.js';
import type { Logger } from '../logger.js';
import type { NocoRecord } from '../nocodb/api.js';
import {
  ConflictError,
  NotFoundError,
  UniqueViolationError,
  type AidaConfigRepos,
} from '../nocodb/repos.js';
import { ValidationError } from '../nocodb/validation.js';
import { e164 } from '../officepulse/pbx-contract.js';
import {
  PbxResponseError,
  resolveTenantPbxScope,
  selectedTenant,
  tenantContexts,
} from './pbx-scope.js';

const assignmentBody = z
  .object({
    context: z.string(),
    did: z.string().nullable(),
    profileId: z.string(),
    enabled: z.boolean().default(true),
  })
  .strict();

/** The browser view of a stored assignment; ids and names only, never prompts. */
function view(row: NocoRecord) {
  return {
    id: String(row.id),
    pbxInstanceId: String(row.pbx_instance_id),
    context: String(row.context),
    did: String(row.did ?? ''),
    profileId: String(row.profile_id),
    enabled: Boolean(row.enabled),
    revision: Number(row.revision),
  };
}

/**
 * Persisted context/DID → assistant profile assignments (contract §4/§6).
 * Guarded like the PBX routes: Tenant Admin or Super Admin with the tenant
 * selected. The routing key is the PBX instance and context; the tenant is
 * the customer identity that authorizes the write and owns the row.
 */
export function profileAssignmentRoutes(logger: Logger, deps: AppDeps): Router {
  const router = Router();
  const base = '/admin/tenants/:tenantId/profile-assignments';

  function repos(): AidaConfigRepos {
    if (!deps.repos) {
      throw new PbxResponseError(
        503,
        'nocodb_not_configured',
        'The NocoDB PlatformConfig base is not configured',
      );
    }
    return deps.repos;
  }

  /** The serving PBX instance, pinned from OfficePulse's own readiness. */
  async function pbxInstanceId(): Promise<string | null> {
    if (!deps.officePulse) return null;
    const live = await deps.officePulse.readiness();
    return live.reachable ? (live.pbxInstanceId ?? null) : null;
  }

  function failure(err: unknown): PbxResponseError {
    if (err instanceof PbxResponseError) return err;
    if (err instanceof z.ZodError) {
      return new PbxResponseError(
        400,
        'validation',
        err.issues
          .map(
            (issue) =>
              `${issue.path.join('.') || 'body'}: ${issue.code === 'unrecognized_keys' ? 'Unsupported fields' : issue.message}`,
          )
          .join('; '),
      );
    }
    if (err instanceof ValidationError)
      return new PbxResponseError(400, 'validation', `${err.field}: ${err.message}`);
    if (err instanceof UniqueViolationError)
      return new PbxResponseError(409, 'duplicate', err.message);
    if (err instanceof ConflictError)
      return new PbxResponseError(409, 'revision_conflict', err.message);
    if (err instanceof NotFoundError) return new PbxResponseError(404, 'not_found', err.message);
    return new PbxResponseError(500, 'internal_error', 'The request could not be completed');
  }

  async function audit(req: Request, action: string, entityId: string, details?: unknown) {
    if (!req.session) return;
    const entry = {
      actorIdentityUserId: req.session.iUserId,
      tenantId: String(req.params.tenantId),
      action,
      entityType: 'profile_assignment',
      entityId,
      correlationId: req.correlationId,
      ...(details ? { details: details as Record<string, unknown> } : {}),
    };
    try {
      await (deps.audit ?? repos().audit).append(entry);
    } catch {
      logger.error({ audit: entry }, 'Profile assignment audit persistence failed');
    }
  }

  function handle(
    method: 'get' | 'put' | 'delete',
    path: string,
    status: number,
    work: (req: Request, tenantId: string) => Promise<unknown>,
  ) {
    router[method](base + path, (req: Request, res: Response) => {
      res.set('Cache-Control', 'no-store');
      return Promise.resolve()
        .then(() => work(req, selectedTenant(req).tenantId))
        .then((result) =>
          status === 204 ? res.status(204).end() : res.status(status).json(result),
        )
        .catch((err: unknown) => {
          const safe = failure(err);
          res
            .status(safe.status)
            .json({ error: safe.code, message: safe.message, correlationId: req.correlationId });
        });
    });
  }
  handle('get', '', 200, async (req, tenantId) => {
    // PlatformConfig is checked once up front so a missing base is one refusal,
    // not one rejection per parallel read.
    const store = repos();
    const [instance, scope, rows] = await Promise.all([
      pbxInstanceId(),
      tenantContexts(deps, tenantId),
      store.profileAssignments.listForTenant(tenantId),
    ]);
    return {
      pbxInstanceId: instance,
      contexts: scope.contexts,
      assignments: rows.map(view),
    };
  });

  handle('put', '', 200, async (req, tenantId) => {
    const body = assignmentBody.parse(req.body);
    // The context must be one this tenant administers on this instance.
    const scope = await resolveTenantPbxScope(deps, tenantId, body.context);
    const did = body.did === null ? '' : e164.parse(body.did);
    if (did !== '') {
      if (!deps.idClient?.listTenantNumbers) {
        throw new PbxResponseError(
          503,
          'identity_unavailable',
          'Identity number assignment is unavailable',
        );
      }
      let numbers;
      try {
        numbers = (await deps.idClient.listTenantNumbers(tenantId)).numbers;
      } catch {
        throw new PbxResponseError(
          503,
          'identity_unavailable',
          'Identity number assignment could not be verified',
        );
      }
      const number = numbers.find(
        (row) => row.phoneNumber === did && String(row.iTenantId) === tenantId,
      );
      if (!number?.bEnabled || !number.bVoice) {
        throw new ValidationError('did', 'Choose an enabled Identity voice number of this tenant');
      }
    }
    const profile = await repos().assistantProfiles.get(tenantId, body.profileId);
    if (!profile.enabled)
      throw new ValidationError('profileId', 'Choose an enabled assistant profile');
    const instance = await pbxInstanceId();
    if (instance === null) {
      throw new PbxResponseError(
        503,
        'officepulse_unavailable',
        'OfficePulse did not report its PBX instance; retry when it is reachable',
      );
    }
    const saved = await repos().profileAssignments.upsert(tenantId, {
      pbxInstanceId: instance,
      context: scope.context,
      did,
      profileId: body.profileId,
      enabled: body.enabled,
    });
    await audit(req, 'profile_assignment.save', String(saved.id), {
      pbxInstanceId: instance,
      context: scope.context,
      did,
      profileId: body.profileId,
      enabled: body.enabled,
    });
    return { pbxInstanceId: instance, assignment: view(saved) };
  });

  handle('delete', '/:id', 204, async (req, tenantId) => {
    z.object({})
      .strict()
      .parse(req.body ?? {});
    const id = z.string().uuid().parse(req.params.id);
    await repos().profileAssignments.delete(tenantId, id);
    await audit(req, 'profile_assignment.delete', id);
  });

  return router;
}
