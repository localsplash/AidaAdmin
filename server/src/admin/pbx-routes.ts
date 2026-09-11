import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type { AppDeps } from '../deps.js';
import type { Logger } from '../logger.js';
import type { AuditEntry } from '../nocodb/repos.js';
import { OfficePulseError, type OfficePulseClient } from '../officepulse/client.js';
import * as contract from '../officepulse/pbx-contract.js';

class PbxResponseError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
interface Context {
  tenantId: string;
  iTenantId: number;
  api: OfficePulseClient;
}

/** Native PBX operations never read or write NocoDB desired-state records. */
export function pbxRoutes(logger: Logger, deps: AppDeps): Router {
  const router = Router();
  const base = '/admin/tenants/:tenantId';

  function context(req: Request): Context {
    const session = req.session;
    if (!session) throw new PbxResponseError(401, 'unauthenticated', 'Sign in required');
    const tenantId = String(req.params.tenantId);
    // sessionMiddleware introspects Identity on every production request. Its
    // enabled tenant/role projection is authoritative; browser claims are not.
    const tenant = session.platformTenants?.find((row) => String(row.iTenantId) === tenantId);
    if (!tenant?.bEnabled || (!session.superAdmin && tenant.role !== 'TENANT_ADMIN')) {
      throw new PbxResponseError(403, 'forbidden', 'You do not administer that tenant');
    }
    if (session.selectedTenantId !== tenantId) {
      throw new PbxResponseError(
        403,
        'tenant_not_selected',
        'Select this tenant before administering its PBX',
      );
    }
    if (!Number.isSafeInteger(tenant.iTenantId) || tenant.iTenantId < 1) {
      throw new PbxResponseError(403, 'forbidden', 'A canonical Identity tenant is required');
    }
    z.object({}).strict().parse(req.query);
    if (!deps.officePulse) {
      throw new PbxResponseError(
        503,
        'officepulse_not_configured',
        'OfficePulse PBX administration is not configured',
      );
    }
    return { tenantId, iTenantId: tenant.iTenantId, api: deps.officePulse };
  }

  function failure(err: unknown, action: string): PbxResponseError {
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
    if (err instanceof OfficePulseError) {
      switch (err.status) {
        case 404:
          return action.endsWith('.list')
            ? new PbxResponseError(
                503,
                'officepulse_unavailable',
                'This OfficePulse inventory API is unavailable; verify provisioning enablement and deployment order',
              )
            : new PbxResponseError(
                404,
                'not_found',
                'The PBX object is unavailable in this tenant; refresh the inventory',
              );
        case 409:
          return new PbxResponseError(
            409,
            'conflict',
            action === 'queue.delete'
              ? 'The queue may still be referenced by a DID route. Review routing in Numbers before deleting it'
              : 'The PBX configuration conflicts with this change. Refresh the inventory; manual DID routes cannot be adopted here',
          );
        case 400:
        case 422:
          return new PbxResponseError(
            422,
            'validation',
            'OfficePulse rejected these settings; check approved contexts, queue names, and tenant ownership',
          );
        case 503:
          return new PbxResponseError(
            503,
            'officepulse_unavailable',
            'OfficePulse is unavailable or PBX mutations are disabled. Your form can be retried when service returns',
          );
        default:
          return new PbxResponseError(
            502,
            'officepulse_failed',
            'OfficePulse could not confirm this change. Refresh the inventory before retrying',
          );
      }
    }
    // Never log or relay arbitrary upstream exceptions: request/response bodies
    // can contain the one-time credential, including on malformed responses.
    return new PbxResponseError(500, 'internal_error', 'The request could not be completed');
  }

  async function audit(
    req: Request,
    action: string,
    outcome: string,
    status: number,
    result?: unknown,
  ) {
    if (!req.session) return;
    const record = result && typeof result === 'object' ? (result as Record<string, unknown>) : {};
    const createdRef =
      action === 'extension.create'
        ? record.extension
        : action === 'queue.create'
          ? record.name
          : undefined;
    const entityId = String(
      req.params.did ??
        (req.params.queue && req.params.extension
          ? `${req.params.queue}/${req.params.extension}`
          : (req.params.queue ?? req.params.extension)) ??
        createdRef ??
        'inventory',
    );
    const entry: AuditEntry = {
      actorIdentityUserId: req.session.iUserId,
      tenantId: String(req.params.tenantId),
      action: `pbx.${action}`,
      entityType: action.split('.')[0]!,
      entityId,
      correlationId: req.correlationId,
      details: { outcome, status },
    };
    try {
      const destination = deps.audit ?? deps.repos?.audit;
      if (destination) await destination.append(entry);
      else logger.info({ audit: entry }, 'PBX audit');
    } catch {
      logger.error({ audit: entry }, 'PBX audit persistence failed');
    }
  }

  function route(
    method: 'get' | 'post' | 'put' | 'delete',
    path: string,
    action: string,
    status: number,
    work: (req: Request, ctx: Context) => Promise<unknown>,
  ) {
    router[method](base + path, async (req: Request, res: Response) => {
      res.set('Cache-Control', 'no-store');
      try {
        const ctx = context(req);
        const result = await work(req, ctx);
        await audit(req, action, method === 'get' ? 'read' : 'committed', status, result);
        if (status === 204) res.status(204).end();
        else res.status(status).json(result);
      } catch (err) {
        const safe = failure(err, action);
        await audit(req, action, safe.code, safe.status);
        res
          .status(safe.status)
          .json({ error: safe.code, message: safe.message, correlationId: req.correlationId });
      }
    });
  }

  async function didScope(req: Request, ctx: Context) {
    if (!deps.idClient?.listTenantNumbers) {
      throw new PbxResponseError(
        503,
        'identity_unavailable',
        'Identity number assignment is unavailable',
      );
    }
    let directory;
    try {
      directory = await deps.idClient.listTenantNumbers(ctx.tenantId);
    } catch {
      throw new PbxResponseError(
        503,
        'identity_unavailable',
        'Identity number assignment could not be verified',
      );
    }
    // Identity is the canonical list, including disabled assignments. Absence
    // from OfficePulse means missing scope, never permission to create a route.
    const numbers = directory.numbers.filter((number) => number.iTenantId === ctx.iTenantId);
    const inventory = await ctx.api.listDids(ctx.iTenantId, req.correlationId);
    const routes = new Map(inventory.dids.map((route) => [route.did, route]));
    const dids = numbers.map(
      (number) =>
        routes.get(number.phoneNumber) ?? {
          did: number.phoneNumber,
          managed: false as const,
          availability: 'scope_missing' as const,
          applyState: 'unknown' as const,
        },
    );
    return { ...inventory, dids, numbers };
  }
  async function allowedDid(req: Request, ctx: Context, did: string) {
    const inventory = await didScope(req, ctx);
    const number = inventory.numbers.find((entry) => entry.phoneNumber === did);
    const current = inventory.dids.find((entry) => entry.did === did);
    if (
      !number?.bEnabled ||
      !number.bVoice ||
      !current ||
      (!current.managed && current.availability === 'scope_missing')
    )
      throw new PbxResponseError(
        404,
        'not_found',
        'Choose an enabled Identity voice number within this tenant’s OfficePulse scope',
      );
    if (!current.managed && current.availability !== 'unconfigured') {
      throw new PbxResponseError(
        409,
        'manual_route',
        'This DID has manual or unknown routing; operator adoption is outside this administration flow',
      );
    }
  }
  const empty = (req: Request) =>
    z
      .object({})
      .strict()
      .parse(req.body ?? {});
  route('get', '/extensions', 'extension.list', 200, (req, ctx) =>
    ctx.api.listExtensions(ctx.iTenantId, req.correlationId),
  );
  route('post', '/extensions', 'extension.create', 201, (req, ctx) =>
    ctx.api.createExtension(
      ctx.iTenantId,
      contract.createExtensionBody.parse(req.body),
      req.correlationId,
    ),
  );
  route('delete', '/extensions/:extension', 'extension.delete', 204, (req, ctx) => {
    empty(req);
    return ctx.api.deleteExtension(
      ctx.iTenantId,
      contract.extensionNumber.parse(req.params.extension),
      req.correlationId,
    );
  });
  route('get', '/queues', 'queue.list', 200, (req, ctx) =>
    ctx.api.listQueues(ctx.iTenantId, req.correlationId),
  );
  route('post', '/queues', 'queue.create', 201, (req, ctx) =>
    ctx.api.createQueue(ctx.iTenantId, contract.createQueueBody.parse(req.body), req.correlationId),
  );
  route('delete', '/queues/:queue', 'queue.delete', 204, (req, ctx) => {
    empty(req);
    return ctx.api.deleteQueue(
      ctx.iTenantId,
      contract.nativeName.parse(req.params.queue),
      req.correlationId,
    );
  });
  route('put', '/queues/:queue/members/:extension', 'queue_member.save', 200, (req, ctx) =>
    ctx.api.putQueueMember(
      ctx.iTenantId,
      contract.nativeName.parse(req.params.queue),
      contract.extensionNumber.parse(req.params.extension),
      contract.memberBody.parse(req.body),
      req.correlationId,
    ),
  );
  route('delete', '/queues/:queue/members/:extension', 'queue_member.delete', 204, (req, ctx) => {
    empty(req);
    return ctx.api.deleteQueueMember(
      ctx.iTenantId,
      contract.nativeName.parse(req.params.queue),
      contract.extensionNumber.parse(req.params.extension),
      req.correlationId,
    );
  });
  route('get', '/did-routes', 'did.list', 200, didScope);
  route('put', '/did-routes/:did', 'did.save', 200, async (req, ctx) => {
    const did = contract.e164.parse(req.params.did);
    const settings = contract.didBody.parse(req.body);
    await allowedDid(req, ctx, did);
    return ctx.api.putDid(ctx.iTenantId, did, settings, req.correlationId);
  });
  route('delete', '/did-routes/:did', 'did.delete', 204, async (req, ctx) => {
    empty(req);
    const did = contract.e164.parse(req.params.did);
    await allowedDid(req, ctx, did);
    return ctx.api.deleteDid(ctx.iTenantId, did, req.correlationId);
  });
  return router;
}
