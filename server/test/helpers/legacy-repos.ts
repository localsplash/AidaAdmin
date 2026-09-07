import { randomUUID } from 'node:crypto';
import type { TenantUserDirectory } from '../../src/auth/tenant-directory.js';
import type { NocoDbApi, NocoRecord, NocoWhere } from '../../src/nocodb/api.js';
import {
  NocoStore,
  createRepos as configRepos,
  type AuditEntry,
  type TenantInput,
  type TenantUserRole,
  type AidaConfigRepos,
  UniqueViolationError,
} from '../../src/nocodb/repos.js';
import {
  requireNonEmpty,
  validateSlug,
  validateContext,
  normalizeE164,
  ValidationError,
} from '../../src/nocodb/validation.js';
/** Append-only: there is deliberately no update or delete path. */
export class AuditLog {
  constructor(private readonly store: NocoStore) {}

  async append(entry: AuditEntry): Promise<void> {
    await this.store.create('audit_log', {
      tenant_id: entry.tenantId,
      actor_identity_user_id: entry.actorIdentityUserId,
      action: entry.action,
      entity_type: entry.entityType,
      entity_id: entry.entityId,
      details: JSON.stringify(entry.details ?? {}),
      correlation_id: entry.correlationId ?? null,
    });
  }
}

// ─── Entity repositories ────────────────────────────────────────────────────

function tenantValues(input: TenantInput): Record<string, unknown> {
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

export class TenantRepository {
  constructor(private readonly store: NocoStore) {}

  list(): Promise<NocoRecord[]> {
    return this.store.list('tenant');
  }

  get(tenantId: string): Promise<NocoRecord> {
    return this.store.getById('tenant', tenantId);
  }

  async create(input: TenantInput): Promise<NocoRecord> {
    return this.store.create('tenant', tenantValues(input));
  }

  async update(
    tenantId: string,
    expectedRevision: number,
    input: TenantInput,
  ): Promise<NocoRecord> {
    return this.store.update('tenant', tenantId, expectedRevision, tenantValues(input));
  }
}

export class TenantUserRepository {
  constructor(private readonly store: NocoStore) {}

  listForTenant(tenantId: string): Promise<NocoRecord[]> {
    return this.store.list('tenant_user', [{ field: 'tenant_id', op: 'eq', value: tenantId }]);
  }

  listForUser(identityUserId: number): Promise<NocoRecord[]> {
    return this.store.list('tenant_user', [
      { field: 'identity_user_id', op: 'eq', value: identityUserId },
    ]);
  }

  /**
   * Upserts the (tenant, user) mapping. tenant_id is null only for the
   * SUPER_ADMIN role record.
   */
  async save(
    tenantId: string | null,
    identityUserId: number,
    role: TenantUserRole,
    enabled: boolean,
  ): Promise<NocoRecord> {
    if (role === 'SUPER_ADMIN' ? tenantId !== null : tenantId === null) {
      throw new ValidationError('role', 'tenant_id is null exactly when role is SUPER_ADMIN');
    }
    const where: NocoWhere[] = [{ field: 'identity_user_id', op: 'eq', value: identityUserId }];
    if (tenantId !== null) where.push({ field: 'tenant_id', op: 'eq', value: tenantId });
    const existing = (await this.store.list('tenant_user', where)).find((r) =>
      tenantId === null ? !r.tenant_id : r.tenant_id === tenantId,
    );
    if (existing) {
      return this.store.update('tenant_user', existing.id as string, Number(existing.revision), {
        role,
        enabled,
      });
    }
    return this.store.create('tenant_user', {
      tenant_id: tenantId,
      identity_user_id: identityUserId,
      role,
      enabled,
    });
  }
}

/** The real phase-2 login directory, backed by tenant_user. */
export class NocoDbTenantUserDirectory implements TenantUserDirectory {
  constructor(private readonly tenantUsers: Pick<TenantUserRepository, 'listForUser'>) {}

  async hasEnabledMembership(iUserId: number): Promise<boolean> {
    const rows = await this.tenantUsers.listForUser(iUserId);
    return rows.some((r) => Boolean(r.enabled));
  }
}

class LegacyDirectoryStore extends NocoStore {
  override async create(table: string, values: Record<string, unknown>): Promise<NocoRecord> {
    const rules =
      table === 'tenant'
        ? [['slug'], ['asterisk_context']]
        : table === 'tenant_user'
          ? [['tenant_id', 'identity_user_id']]
          : [];
    for (const fields of rules) {
      if (fields.every((f) => values[f] != null)) {
        const existing = await this.list(
          table,
          fields.map((f) => ({ field: f, op: 'eq', value: values[f] as string | number })),
        );
        if (existing.length) throw new UniqueViolationError(fields);
      }
    }
    const def = (await this.api.listTables()).find((t) => t.table_name === table)!;
    const now = new Date().toISOString();
    const row = {
      id: table === 'tenant' ? String((await this.list('tenant')).length + 1) : randomUUID(),
      created_at: now,
      ...values,
      ...(table === 'audit_log' ? {} : { updated_at: now, revision: 1 }),
    };
    await this.api.createRecord(def.id, row);
    return row;
  }
}
export function createRepos(api: NocoDbApi): AidaConfigRepos {
  const store = new LegacyDirectoryStore(api);
  return configRepos(api, {
    tenants: new TenantRepository(store),
    tenantUsers: new TenantUserRepository(store),
    audit: new AuditLog(store),
  });
}
export * from '../../src/nocodb/repos.js';
