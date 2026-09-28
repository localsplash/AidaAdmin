import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type { AppDeps } from '../deps.js';
import type { Logger } from '../logger.js';
import type { AuditEntry } from '../nocodb/repos.js';
import { OfficePulseError, type OfficePulseClient, type PbxScope } from '../officepulse/client.js';
import * as contract from '../officepulse/pbx-contract.js';
import { requireSuperAdmin } from './authz.js';
import {
  didScope,
  PbxResponseError,
  resolveTenantPbxScope,
  selectedTenant,
  type TenantPbxScope,
} from './pbx-scope.js';

interface Context {
  tenantId: string;
  iTenantId: number;
  api: OfficePulseClient;
  /** The PBX scope this request acts in; resolved from PlatformConfig, never the browser. */
  scope: TenantPbxScope;
  /** What non-DID OfficePulse calls receive: the context alone. */
  pbx: PbxScope;
}
const scopeQuery = z.object({ context: z.string().optional() }).strict();

/** Native PBX operations never read or write NocoDB desired-state records. */
export function pbxRoutes(logger: Logger, deps: AppDeps): Router {
  const router = Router();
  const base = '/admin/tenants/:tenantId';

  function officePulse(): OfficePulseClient {
    if (!deps.officePulse) {
      throw new PbxResponseError(
        503,
        'officepulse_not_configured',
        'OfficePulse PBX administration is not configured',
      );
    }
    return deps.officePulse;
  }

  async function context(req: Request): Promise<Context> {
    const tenant = selectedTenant(req);
    // A `?context=` choice selects among the tenant's own contexts; anything
    // else (including a made-up name) is refused before OfficePulse is called.
    const { context: requested } = scopeQuery.parse(req.query);
    const api = officePulse();
    const scope = await resolveTenantPbxScope(deps, tenant.tenantId, requested || undefined);
    return { ...tenant, api, scope, pbx: { context: scope.context } };
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
                'The PBX object is unavailable in this context; refresh the inventory',
              );
        case 409:
          return new PbxResponseError(
            409,
            'conflict',
            action === 'queue.delete'
              ? 'The queue may still be referenced by a DID route. Review routing in Numbers before deleting it'
              : 'The PBX configuration conflicts with this change. Refresh the inventory; manual routes and routes owned by another context cannot be adopted here',
          );
        case 400:
        case 422:
          return new PbxResponseError(
            422,
            'validation',
            'OfficePulse rejected these settings; check the context, queue names and ingress context',
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
      tenantId: req.params.tenantId === undefined ? null : String(req.params.tenantId),
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

  function reply(
    req: Request,
    res: Response,
    action: string,
    status: number,
    work: () => Promise<unknown>,
  ) {
    res.set('Cache-Control', 'no-store');
    return Promise.resolve()
      .then(work)
      .then(async (result) => {
        await audit(req, action, req.method === 'GET' ? 'read' : 'committed', status, result);
        if (status === 204) res.status(204).end();
        else res.status(status).json(result);
      })
      .catch(async (err: unknown) => {
        const safe = failure(err, action);
        await audit(req, action, safe.code, safe.status);
        res
          .status(safe.status)
          .json({ error: safe.code, message: safe.message, correlationId: req.correlationId });
      });
  }

  function route(
    method: 'get' | 'post' | 'put' | 'delete',
    path: string,
    action: string,
    status: number,
    work: (req: Request, ctx: Context) => Promise<unknown>,
  ) {
    router[method](base + path, (req: Request, res: Response) =>
      reply(req, res, action, status, async () => work(req, await context(req))),
    );
  }

  /** Inventories carry the authorized context list so the UI can offer a selector. */
  const scoped = <T extends object>(inventory: T, ctx: Context) => ({
    ...inventory,
    contexts: ctx.scope.contexts,
  });

  async function didInventory(req: Request, ctx: Context) {
    const scope = didScope(ctx.scope);
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
    // Identity is the canonical list, including disabled assignments. The
    // OfficePulse response determines whether the ingress context is usable.
    const numbers = directory.numbers.filter((number) => number.iTenantId === ctx.iTenantId);
    const inventory = await ctx.api.listDids(
      scope,
      req.correlationId,
      numbers.map((number) => number.phoneNumber),
    );
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
    return { inventory: { ...scoped(inventory, ctx), dids, numbers }, scope };
  }
  async function allowedDid(req: Request, ctx: Context, did: string) {
    const { inventory, scope } = await didInventory(req, ctx);
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
    return scope;
  }
  const empty = (req: Request) =>
    z
      .object({})
      .strict()
      .parse(req.body ?? {});

  // Every context on the PBX instance, for the Tenants form's datalist. Listing
  // a context grants nothing: assignment happens in Tenants, authorization in
  // resolveTenantPbxScope.
  router.get('/admin/pbx/contexts', requireSuperAdmin, (req, res) =>
    reply(req, res, 'context.list', 200, () => officePulse().listContexts(req.correlationId)),
  );
  route('get', '/extensions', 'extension.list', 200, async (req, ctx) =>
    scoped(await ctx.api.listExtensions(ctx.pbx, req.correlationId), ctx),
  );
  route('post', '/extensions', 'extension.create', 201, (req, ctx) =>
    ctx.api.createExtension(
      ctx.pbx,
      contract.createExtensionBody.parse(req.body),
      req.correlationId,
    ),
  );
  route('delete', '/extensions/:extension', 'extension.delete', 204, (req, ctx) => {
    empty(req);
    return ctx.api.deleteExtension(
      ctx.pbx,
      contract.extensionNumber.parse(req.params.extension),
      req.correlationId,
    );
  });
  route('get', '/queues', 'queue.list', 200, async (req, ctx) =>
    scoped(await ctx.api.listQueues(ctx.pbx, req.correlationId), ctx),
  );
  route('post', '/queues', 'queue.create', 201, (req, ctx) =>
    ctx.api.createQueue(ctx.pbx, contract.createQueueBody.parse(req.body), req.correlationId),
  );
  route('delete', '/queues/:queue', 'queue.delete', 204, (req, ctx) => {
    empty(req);
    return ctx.api.deleteQueue(
      ctx.pbx,
      contract.nativeName.parse(req.params.queue),
      req.correlationId,
    );
  });
  route('put', '/queues/:queue/members/:extension', 'queue_member.save', 200, (req, ctx) =>
    ctx.api.putQueueMember(
      ctx.pbx,
      contract.nativeName.parse(req.params.queue),
      contract.extensionNumber.parse(req.params.extension),
      contract.memberBody.parse(req.body),
      req.correlationId,
    ),
  );
  route('delete', '/queues/:queue/members/:extension', 'queue_member.delete', 204, (req, ctx) => {
    empty(req);
    return ctx.api.deleteQueueMember(
      ctx.pbx,
      contract.nativeName.parse(req.params.queue),
      contract.extensionNumber.parse(req.params.extension),
      req.correlationId,
    );
  });
  route(
    'get',
    '/did-routes',
    'did.list',
    200,
    async (req, ctx) => (await didInventory(req, ctx)).inventory,
  );
  route('put', '/did-routes/:did', 'did.save', 200, async (req, ctx) => {
    const did = contract.e164.parse(req.params.did);
    const settings = contract.didBody.parse(req.body);
    const scope = await allowedDid(req, ctx, did);
    return ctx.api.putDid(scope, did, settings, req.correlationId, [did]);
  });
  route('delete', '/did-routes/:did', 'did.delete', 204, async (req, ctx) => {
    empty(req);
    const did = contract.e164.parse(req.params.did);
    const scope = await allowedDid(req, ctx, did);
    return ctx.api.deleteDid(scope, did, req.correlationId, [did]);
  });
  return router;
}
