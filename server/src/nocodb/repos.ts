import { randomUUID } from 'node:crypto';
import type { NocoDbApi, NocoRecord, NocoWhere } from './api.js';
import { tableByCanonicalName } from './api.js';
import { LOGICAL_SCHEMA, FIELD_NAMES, TABLE_NAMES, UNIQUE_RULES } from './schema.js';
import {
  requireNonEmpty,
  splitContexts,
  validateContext,
  ValidationError,
  type TenantContexts,
} from './validation.js';

export class NotFoundError extends Error {}
export class ConflictError extends Error {}
export class UniqueViolationError extends Error {
  constructor(
    readonly fields: string[],
    message = `A record with the same ${fields.join('+')} already exists`,
  ) {
    super(message);
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
      const provided = fields.every((f) => values[f] !== undefined && values[f] !== null);
      if (!provided) continue;
      // NocoDB hands blank text back as null and cannot filter on it, so a
      // blank key part (a context-default assignment's did) is matched here.
      const where: NocoWhere[] = fields
        .filter((f) => values[f] !== '')
        .map((f) => ({ field: f, op: 'eq', value: values[f] as string | number }));
      const clashes = (await this.list(tableName, where)).filter(
        (r) => r.id !== excludeId && fields.every((f) => String(r[f] ?? '') === String(values[f])),
      );
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

  async delete(tableName: string, id: string, tenantId?: string): Promise<void> {
    const existing = await this.getById(tableName, id, tenantId);
    await this.api.deleteRecord(await this.tableId(tableName), existing.Id as number);
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
  /** Primary extension context: the default PBX routing scope on this instance. */
  asteriskContext: string;
  additionalContexts: string[];
  /** Shared carrier ingress context holding this tenant's managed DID routes. */
  didContext: string | null;
  callerIdName?: string | null | undefined;
  callerIdNumber?: string | null | undefined;
  enabled: boolean;
}

/** The extension contexts a stored tenant profile (or combined tenant record) owns. */
export function tenantProfileContexts(profile: NocoRecord | undefined): string[] {
  const primary = typeof profile?.asterisk_context === 'string' ? profile.asterisk_context : '';
  return [...(primary ? [primary] : []), ...splitContexts(profile?.additional_contexts)].filter(
    (context, index, all) => all.indexOf(context) === index,
  );
}

/**
 * No extension context may belong to two tenants: the same name on one PBX
 * instance would make both businesses' extensions and queues one scope.
 */
export function assertContextsUnclaimed(
  profiles: readonly NocoRecord[],
  contexts: TenantContexts,
  ownTenantId: string,
): void {
  for (const profile of profiles) {
    if (String(profile.tenant_id ?? profile.id) === ownTenantId) continue;
    const taken = tenantProfileContexts(profile).find((context) =>
      contexts.contexts.includes(context),
    );
    if (taken !== undefined) {
      throw new UniqueViolationError(
        ['asterisk_context'],
        `Asterisk context ${taken} already belongs to another tenant`,
      );
    }
  }
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

export interface ProfileAssignmentInput {
  pbxInstanceId: string;
  context: string;
  /** E.164 for a DID-specific assignment; '' is the context default. */
  did: string;
  profileId: string;
  enabled: boolean;
}

/**
 * Persisted context/DID → assistant profile assignments (contract §4). The
 * key is (pbx_instance_id, context, did); the tenant is customer identity for
 * authorization and consistency, never part of the routing key.
 */
export class ProfileAssignmentRepository {
  constructor(private readonly store: NocoStore) {}

  /** NocoDB returns blank text as null; '' is the context-default key. */
  private normalize(row: NocoRecord): NocoRecord {
    return { ...row, did: row.did ?? '', enabled: Boolean(row.enabled) };
  }

  private values(input: ProfileAssignmentInput): Record<string, unknown> {
    if (!/^[A-Za-z0-9_.-]{1,80}$/.test(input.pbxInstanceId))
      throw new ValidationError('pbxInstanceId', 'pbxInstanceId must be a PBX instance id');
    if (input.did !== '' && !/^\+[1-9][0-9]{6,14}$/.test(input.did))
      throw new ValidationError('did', 'did must be an E.164 number or null');
    return {
      pbx_instance_id: input.pbxInstanceId,
      context: validateContext('context', input.context),
      did: input.did,
      profile_id: requireNonEmpty('profileId', input.profileId),
      enabled: input.enabled,
    };
  }

  async listForTenant(tenantId: string): Promise<NocoRecord[]> {
    const rows = await this.store.list('profile_assignment', [
      { field: 'tenant_id', op: 'eq', value: tenantId },
    ]);
    return rows.map((row) => this.normalize(row));
  }

  async upsert(tenantId: string, input: ProfileAssignmentInput): Promise<NocoRecord> {
    const values = this.values(input);
    const rows = await this.store.list('profile_assignment', [
      { field: 'pbx_instance_id', op: 'eq', value: input.pbxInstanceId },
      { field: 'context', op: 'eq', value: input.context },
    ]);
    const existing = rows.map((row) => this.normalize(row)).find((row) => row.did === input.did);
    if (!existing) {
      return this.normalize(
        await this.store.create('profile_assignment', { tenant_id: tenantId, ...values }),
      );
    }
    // The key is unique per PBX instance, so a row another tenant left behind
    // is a conflict to resolve in Tenants, never something to take over.
    if (String(existing.tenant_id) !== tenantId) {
      throw new UniqueViolationError(
        ['pbx_instance_id', 'context', 'did'],
        'This context/DID assignment belongs to another tenant',
      );
    }
    return this.normalize(
      await this.store.update(
        'profile_assignment',
        existing.id as string,
        Number(existing.revision),
        values,
        tenantId,
      ),
    );
  }

  delete(tenantId: string, id: string): Promise<void> {
    return this.store.delete('profile_assignment', id, tenantId);
  }
}

export interface AidaConfigRepos {
  store: NocoStore;
  tenants: Pick<TenantRepository, 'list' | 'get' | 'create' | 'update'>;
  tenantUsers: Pick<TenantUserRepository, 'listForTenant' | 'listForUser' | 'save'>;
  assistantProfiles: AssistantProfileRepository;
  appearance: AppearanceRepository;
  profileAssignments: ProfileAssignmentRepository;
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
    profileAssignments: new ProfileAssignmentRepository(store),
    audit: authority.audit,
  };
}
