import { randomUUID } from 'node:crypto';
import type { NocoDbApi, NocoRecord } from '../../src/nocodb/api.js';
import {
  createRepos as businessRepos,
  ConflictError,
  NotFoundError,
  UniqueViolationError,
  type AidaConfigRepos,
  type AuditEntry,
  type TenantInput,
} from '../../src/nocodb/repos.js';
import {
  requireNonEmpty,
  validateSlug,
  validateContext,
  normalizeE164,
} from '../../src/nocodb/validation.js';

interface DirectoryState {
  tenants: NocoRecord[];
  memberships: NocoRecord[];
  audit: AuditEntry[];
}
const states = new WeakMap<NocoDbApi, DirectoryState>();
export function directoryState(api: NocoDbApi): DirectoryState {
  return states.get(api)!;
}

/** In-memory Identity/audit collaborators; never create directory tables in NocoDB. */
export function createRepos(api: NocoDbApi): AidaConfigRepos {
  const state: DirectoryState = { tenants: [], memberships: [], audit: [] };
  states.set(api, state);
  function values(input: TenantInput): NocoRecord {
    return {
      name: requireNonEmpty('name', input.name),
      slug: validateSlug('slug', input.slug),
      asterisk_context: validateContext('asteriskContext', input.asteriskContext),
      caller_id_name: input.callerIdName ?? null,
      caller_id_number: input.callerIdNumber
        ? normalizeE164('callerIdNumber', input.callerIdNumber)
        : null,
      enabled: input.enabled,
    };
  }
  return businessRepos(api, {
    tenants: {
      list: async () => state.tenants,
      get: async (id) => {
        const row = state.tenants.find((row) => row.id === id);
        if (!row) throw new NotFoundError('Tenant not found');
        return row;
      },
      create: async (input) => {
        const row = values(input);
        for (const field of ['slug', 'asterisk_context'])
          if (state.tenants.some((existing) => existing[field] === row[field]))
            throw new UniqueViolationError([field]);
        const created = { id: String(state.tenants.length + 1), ...row, revision: 1 };
        state.tenants.push(created);
        return created;
      },
      update: async (id, revision, input) => {
        const row = state.tenants.find((row) => row.id === id);
        if (!row) throw new NotFoundError('Tenant not found');
        if (row.revision !== revision) throw new ConflictError('Tenant revision changed');
        Object.assign(row, values(input), { revision: revision + 1 });
        return row;
      },
    },
    tenantUsers: {
      listForTenant: async (id) => state.memberships.filter((row) => row.tenant_id === id),
      listForUser: async (id) => state.memberships.filter((row) => row.identity_user_id === id),
      save: async (tenantId, userId, role, enabled) => {
        let row = state.memberships.find(
          (row) => row.tenant_id === tenantId && row.identity_user_id === userId,
        );
        if (!row) {
          row = { id: randomUUID(), tenant_id: tenantId, identity_user_id: userId };
          state.memberships.push(row);
        }
        Object.assign(row, { role, enabled });
        return row;
      },
    },
    audit: {
      append: async (entry) => {
        state.audit.push(entry);
      },
    },
  });
}
