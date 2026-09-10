import { randomUUID } from 'node:crypto';
import type { NocoDbApi, NocoRecord, NocoWhere } from './api.js';
import { tableByCanonicalName } from './api.js';
import { LOGICAL_SCHEMA, FIELD_NAMES, TABLE_NAMES, UNIQUE_RULES } from './schema.js';
import { requireNonEmpty, ValidationError } from './validation.js';

export class NotFoundError extends Error {}
export class ConflictError extends Error {}
export class UniqueViolationError extends Error {
  constructor(readonly fields: string[]) {
    super(`A record with the same ${fields.join('+')} already exists`);
  }
}

/**
 * Table-name-addressed access to the PlatformConfig base with the
 * cross-cutting rules every repository shares: logical UUID ids, ISO
 * timestamps, optimistic `revision` checks, uniqueness enforcement, and —
 * where a tenant id is given — tenant scope in every query. NocoDB cannot
 * express conditional updates, so the revision check is read-compare-write;
 * this POC uses a single administrative writer. Concurrent editors require
 * a backing store with compare-and-swap before that guarantee is possible.
 */
export class NocoStore {
  private tableIds = new Map<string, string>();

  constructor(readonly api: NocoDbApi) {}

  private async tableId(tableName: string): Promise<string> {
    tableName = TABLE_NAMES[tableName] ?? tableName;
    const cached = this.tableIds.get(tableName);
    if (cached) return cached;
    const tables = await this.api.listTables();
    const id = tableByCanonicalName(tables, tableName)?.id;
    if (!id) throw new NotFoundError(`NocoDB table ${tableName} does not exist (run upgrade)`);
    this.tableIds.set(tableName, id);
    return id;
  }

  async list(tableName: string, where: NocoWhere[] = []): Promise<NocoRecord[]> {
    const physical = TABLE_NAMES[tableName] !== undefined;
    const rows = await this.api.listRecords(
      await this.tableId(tableName),
      where.map((filter) => ({
        ...filter,
        field: physical ? (FIELD_NAMES[filter.field] ?? filter.field) : filter.field,
      })),
    );
    if (!physical) return rows;
    return rows.map((row) =>
      Object.fromEntries(
        Object.entries(row).map(([field, value]) => {
          const logical =
            Object.entries(FIELD_NAMES).find(([, actual]) => actual === field)?.[0] ?? field;
          return [logical, logical === 'tenant_id' && value != null ? String(value) : value];
        }),
      ),
    );
  }

  async getById(tableName: string, id: string, tenantId?: string): Promise<NocoRecord> {
    const where: NocoWhere[] = [{ field: 'id', op: 'eq', value: id }];
    if (tenantId !== undefined) where.push({ field: 'tenant_id', op: 'eq', value: tenantId });
    const rows = await this.list(tableName, where);
    const row = rows[0];
    // A cross-tenant id never resolves: same result as a nonexistent record.
    if (!row) throw new NotFoundError(`${tableName} record not found`);
    return row;
  }

  private async assertUnique(
    tableName: string,
    values: Record<string, unknown>,
    excludeId?: string,
  ): Promise<void> {
    for (const fields of UNIQUE_RULES[tableName] ?? []) {
      const provided = fields.every(
        (f) => values[f] !== undefined && values[f] !== null && values[f] !== '',
      );
      if (!provided) continue;
      const where: NocoWhere[] = fields.map((f) => ({
        field: f,
        op: 'eq',
        value: values[f] as string | number,
      }));
      const clashes = (await this.list(tableName, where)).filter((r) => r.id !== excludeId);
      if (clashes.length > 0) throw new UniqueViolationError(fields);
    }
  }

  private physicalValues(
    tableName: string,
    values: Record<string, unknown>,
  ): Record<string, unknown> {
    if (!TABLE_NAMES[tableName]) return values;
    if (
      values.tenant_id != null &&
      (!Number.isSafeInteger(Number(values.tenant_id)) || Number(values.tenant_id) < 1)
    ) {
      throw new ValidationError('tenantId', 'A positive platform tenant ID is required');
    }
    return Object.fromEntries(
      Object.entries(values).map(([field, value]) => [
        FIELD_NAMES[field] ?? field,
        field === 'tenant_id' && value != null ? Number(value) : value,
      ]),
    );
  }

  async create(tableName: string, values: Record<string, unknown>): Promise<NocoRecord> {
    await this.assertUnique(tableName, values);
    const now = new Date().toISOString();
    // Immutable tables (audit_log) have no updated_at/revision columns.
    const columns = new Set(
      LOGICAL_SCHEMA.find((t) => t.table_name === tableName)?.columns.map((c) => c.column_name) ??
        [],
    );
    const record: Record<string, unknown> = { id: randomUUID(), created_at: now, ...values };
    if (columns.has('updated_at')) record.updated_at = now;
    if (columns.has('revision')) record.revision = 1;
    const valuesToStore = this.physicalValues(tableName, record);
    await this.api.createRecord(await this.tableId(tableName), valuesToStore);
    return record as NocoRecord;
  }

  async update(
    tableName: string,
    id: string,
    expectedRevision: number,
    patch: Record<string, unknown>,
    tenantId?: string,
  ): Promise<NocoRecord> {
    const existing = await this.getById(tableName, id, tenantId);
    if (Number(existing.revision) !== expectedRevision) {
      throw new ConflictError(
        `${tableName} was modified by someone else (expected revision ${expectedRevision})`,
      );
    }
    const merged = { ...existing, ...patch };
    await this.assertUnique(tableName, merged, id);
    const values = {
      ...patch,
      updated_at: new Date().toISOString(),
      revision: expectedRevision + 1,
    };
    await this.api.updateRecord(
      await this.tableId(tableName),
      existing.Id as number,
      this.physicalValues(tableName, values),
    );
    return { ...merged, ...values } as NocoRecord;
  }
}

export interface AuditEntry {
  tenantId: string | null;
  actorIdentityUserId: number;
  action: string;
  entityType: string;
  entityId: string;
  details?: Record<string, unknown>;
  correlationId?: string;
}

export interface TenantInput {
  name: string;
  slug: string;
  asteriskContext: string;
  callerIdName?: string | null | undefined;
  callerIdNumber?: string | null | undefined;
  enabled: boolean;
}
export type TenantUserRole = 'SUPER_ADMIN' | 'TENANT_ADMIN' | 'USER';
export interface TenantRepository {
  list(): Promise<NocoRecord[]>;
  get(tenantId: string): Promise<NocoRecord>;
  create(input: TenantInput): Promise<NocoRecord>;
  update(tenantId: string, expectedRevision: number, input: TenantInput): Promise<NocoRecord>;
}
export interface TenantUserRepository {
  listForTenant(tenantId: string): Promise<NocoRecord[]>;
  listForUser(iUserId: number): Promise<NocoRecord[]>;
  save(
    tenantId: string | null,
    iUserId: number,
    role: TenantUserRole,
    enabled: boolean,
  ): Promise<NocoRecord>;
}
export interface AuditLog {
  append(entry: AuditEntry): Promise<void>;
}

export interface AssistantProfileInput {
  name: string;
  businessName: string;
  prompt: string;
  tone?: string | null | undefined;
  objective?: string | null | undefined;
  openingStatement?: string | null | undefined;
  transferStatement?: string | null | undefined;
  failedTransferStatement?: string | null | undefined;
  enabled: boolean;
}

export class AssistantProfileRepository {
  constructor(private readonly store: NocoStore) {}

  private values(tenantId: string, input: AssistantProfileInput): Record<string, unknown> {
    return {
      tenant_id: tenantId,
      name: requireNonEmpty('name', input.name),
      business_name: requireNonEmpty('businessName', input.businessName),
      prompt: requireNonEmpty('prompt', input.prompt),
      tone: input.tone ?? null,
      objective: input.objective ?? null,
      opening_statement: input.openingStatement ?? null,
      transfer_statement: input.transferStatement ?? null,
      failed_transfer_statement: input.failedTransferStatement ?? null,
      enabled: input.enabled,
    };
  }

  listForTenant(tenantId: string): Promise<NocoRecord[]> {
    return this.store.list('assistant_profile', [
      { field: 'tenant_id', op: 'eq', value: tenantId },
    ]);
  }

  get(tenantId: string, profileId: string): Promise<NocoRecord> {
    return this.store.getById('assistant_profile', profileId, tenantId);
  }

  async create(tenantId: string, input: AssistantProfileInput): Promise<NocoRecord> {
    return this.store.create('assistant_profile', this.values(tenantId, input));
  }

  async update(
    tenantId: string,
    profileId: string,
    expectedRevision: number,
    input: AssistantProfileInput,
  ): Promise<NocoRecord> {
    return this.store.update(
      'assistant_profile',
      profileId,
      expectedRevision,
      this.values(tenantId, input),
      tenantId,
    );
  }
}

export interface AppearanceInput {
  brandName: string;
  primaryColor?: string | null | undefined;
  logoAssetPath?: string | null | undefined;
}

/** Single-brand POC appearance settings, one record per tenant. */
export class AppearanceRepository {
  constructor(private readonly store: NocoStore) {}

  async getForTenant(tenantId: string): Promise<NocoRecord | null> {
    const rows = await this.store.list('appearance', [
      { field: 'tenant_id', op: 'eq', value: tenantId },
    ]);
    return rows[0] ?? null;
  }

  async save(tenantId: string, input: AppearanceInput): Promise<NocoRecord> {
    if (input.primaryColor && !/^#[0-9a-fA-F]{6}$/.test(input.primaryColor)) {
      throw new ValidationError('primaryColor', 'primaryColor must be a #rrggbb value');
    }
    const values = {
      tenant_id: tenantId,
      brand_name: requireNonEmpty('brandName', input.brandName),
      primary_color: input.primaryColor ?? null,
      ...(input.logoAssetPath !== undefined ? { logo_asset_path: input.logoAssetPath } : {}),
    };
    const existing = await this.getForTenant(tenantId);
    if (existing) {
      return this.store.update(
        'appearance',
        existing.id as string,
        Number(existing.revision),
        values,
        tenantId,
      );
    }
    return this.store.create('appearance', { logo_asset_path: null, ...values });
  }
}

export interface AidaConfigRepos {
  store: NocoStore;
  tenants: Pick<TenantRepository, 'list' | 'get' | 'create' | 'update'>;
  tenantUsers: Pick<TenantUserRepository, 'listForTenant' | 'listForUser' | 'save'>;
  assistantProfiles: AssistantProfileRepository;
  appearance: AppearanceRepository;
  audit: Pick<AuditLog, 'append'>;
}

export function createRepos(
  api: NocoDbApi,
  authority: Pick<AidaConfigRepos, 'tenants' | 'tenantUsers' | 'audit'>,
): AidaConfigRepos {
  const store = new NocoStore(api);
  return {
    store,
    tenants: authority.tenants,
    tenantUsers: authority.tenantUsers,
    assistantProfiles: new AssistantProfileRepository(store),
    appearance: new AppearanceRepository(store),
    audit: authority.audit,
  };
}
