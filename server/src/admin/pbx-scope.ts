import type { Request } from 'express';
import type { AppDeps } from '../deps.js';
import { NotFoundError, tenantProfileContexts } from '../nocodb/repos.js';
import type { DidScope } from '../officepulse/client.js';
import { contextName } from '../officepulse/pbx-contract.js';

/** A refusal the browser should see: status, machine code and safe copy. */
export class PbxResponseError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface SelectedTenant {
  tenantId: string;
  iTenantId: number;
}

/**
 * The tenant a PBX request administers. sessionMiddleware introspects Identity
 * on every production request; its enabled tenant/role projection and the
 * centrally selected tenant are authoritative — browser claims are not. The
 * tenant is customer identity for authorization only; it never reaches
 * OfficePulse as a scope.
 */
export function selectedTenant(req: Request): SelectedTenant {
  const session = req.session;
  if (!session) throw new PbxResponseError(401, 'unauthenticated', 'Sign in required');
  const tenantId = String(req.params.tenantId);
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
  return { tenantId, iTenantId: tenant.iTenantId };
}

export interface TenantPbxScope {
  /** Every extension context this tenant may administer, primary first. */
  contexts: string[];
  /** The context this request acts in. */
  context: string;
  /** The carrier ingress context holding the tenant's managed DID routes. */
  didContext: string | null;
}

/** The contexts PlatformConfig assigns to a tenant, without judging them. */
export async function tenantContexts(
  deps: AppDeps,
  tenantId: string,
): Promise<Pick<TenantPbxScope, 'contexts' | 'didContext'>> {
  if (!deps.repos) {
    throw new PbxResponseError(
      503,
      'nocodb_not_configured',
      'The NocoDB PlatformConfig base is not configured',
    );
  }
  let tenant;
  try {
    tenant = await deps.repos.tenants.get(tenantId);
  } catch (err) {
    if (err instanceof NotFoundError) return { contexts: [], didContext: null };
    throw err;
  }
  const didContext = tenant.did_context;
  return {
    contexts: tenantProfileContexts(tenant).filter((row) => contextName.safeParse(row).success),
    didContext: typeof didContext === 'string' && didContext !== '' ? didContext : null,
  };
}

/**
 * Resolves the PBX scope a browser request may act in. The stored contexts
 * are the authorization; a `?context=` choice only selects among them, so a
 * context the browser made up never reaches OfficePulse.
 */
export async function resolveTenantPbxScope(
  deps: AppDeps,
  tenantId: string,
  requestedContext?: string,
): Promise<TenantPbxScope> {
  const { contexts, didContext } = await tenantContexts(deps, tenantId);
  const primary = contexts[0];
  if (primary === undefined) {
    throw new PbxResponseError(
      409,
      'pbx_scope_missing',
      "Assign this tenant's Asterisk context in Tenants first",
    );
  }
  if (requestedContext !== undefined && !contexts.includes(requestedContext)) {
    throw new PbxResponseError(
      403,
      'context_forbidden',
      'This tenant is not authorized for that Asterisk context',
    );
  }
  return { contexts, context: requestedContext ?? primary, didContext };
}

/** Managed DID operations also need the tenant's ingress context. */
export function didScope(scope: TenantPbxScope): DidScope {
  if (scope.didContext === null) {
    throw new PbxResponseError(
      409,
      'pbx_scope_missing',
      "Assign this tenant's inbound DID context first",
    );
  }
  return { context: scope.context, didContext: scope.didContext };
}
