import { randomUUID } from 'node:crypto';
import type { NocoDbApi, NocoRecord, NocoWhere } from './api.js';
import { AIDA_SCHEMA, UNIQUE_RULES } from './schema.js';
import type { TenantUserDirectory } from '../auth/tenant-directory.js';
import {
  normalizeE164,
  normalizeMac,
  requireNonEmpty,
  validateContext,
  validateSlug,
  ValidationError,
} from './validation.js';

export class NotFoundError extends Error {}
export class ConflictError extends Error {}
export class UniqueViolationError extends Error {
  constructor(readonly fields: string[]) {
    super(`A record with the same ${fields.join('+')} already exists`);
  }
}

/**
 * Table-name-addressed access to the AidaConfiguration base with the
 * cross-cutting rules every repository shares: logical UUID ids, ISO
 * timestamps, optimistic `revision` checks, uniqueness enforcement, and —
 * where a tenant id is given — tenant scope in every query. NocoDB cannot
 * express conditional updates, so the revision check is read-compare-write;
 * the POC accepts that window and the revision number still detects lost
 * updates across concurrent editors.
 */
export class NocoStore {
  private tableIds = new Map<string, string>();

  constructor(readonly api: NocoDbApi) {}

  private async tableId(tableName: string): Promise<string> {
    const cached = this.tableIds.get(tableName);
    if (cached) return cached;
    const tables = await this.api.listTables();
    for (const table of tables) this.tableIds.set(table.table_name, table.id);
    const id = this.tableIds.get(tableName);
    if (!id) throw new NotFoundError(`NocoDB table ${tableName} does not exist (run upgrade)`);
    return id;
  }

  async list(tableName: string, where: NocoWhere[] = []): Promise<NocoRecord[]> {
    return this.api.listRecords(await this.tableId(tableName), where);
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

  async create(tableName: string, values: Record<string, unknown>): Promise<NocoRecord> {
    await this.assertUnique(tableName, values);
    const now = new Date().toISOString();
    // Immutable tables (audit_log) have no updated_at/revision columns.
    const columns = new Set(
      AIDA_SCHEMA.find((t) => t.table_name === tableName)?.columns.map((c) => c.column_name) ?? [],
    );
    const record: Record<string, unknown> = { id: randomUUID(), created_at: now, ...values };
    if (columns.has('updated_at')) record.updated_at = now;
    if (columns.has('revision')) record.revision = 1;
    await this.api.createRecord(await this.tableId(tableName), record);
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
    await this.api.updateRecord(await this.tableId(tableName), existing.Id as number, values);
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

export interface TenantInput {
  name: string;
  slug: string;
  asteriskContext: string;
  callerIdName?: string | null | undefined;
  callerIdNumber?: string | null | undefined;
  enabled: boolean;
}

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

export type TenantUserRole = 'SUPER_ADMIN' | 'TENANT_ADMIN' | 'USER';

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
  constructor(private readonly tenantUsers: TenantUserRepository) {}

  async hasEnabledMembership(iUserId: number): Promise<boolean> {
    const rows = await this.tenantUsers.listForUser(iUserId);
    return rows.some((r) => Boolean(r.enabled));
  }
}

export interface ExtensionInput {
  identityUserId?: number | null | undefined;
  extensionNumber: string;
  displayName: string;
  callerIdName?: string | null | undefined;
  callerIdNumber?: string | null | undefined;
  asteriskContext: string;
  provisioningProfile?: string | null | undefined;
  enabled: boolean;
}

function extensionValues(tenantId: string, input: ExtensionInput): Record<string, unknown> {
  return {
    tenant_id: tenantId,
    identity_user_id: input.identityUserId ?? null,
    extension_number: requireNonEmpty('extensionNumber', input.extensionNumber),
    display_name: requireNonEmpty('displayName', input.displayName),
    caller_id_name: input.callerIdName ?? null,
    caller_id_number: input.callerIdNumber
      ? normalizeE164('callerIdNumber', input.callerIdNumber)
      : null,
    asterisk_context: validateContext('asteriskContext', input.asteriskContext),
    provisioning_profile: input.provisioningProfile ?? null,
    enabled: input.enabled,
  };
}

export class ExtensionRepository {
  constructor(private readonly store: NocoStore) {}

  listForTenant(tenantId: string): Promise<NocoRecord[]> {
    return this.store.list('extension', [{ field: 'tenant_id', op: 'eq', value: tenantId }]);
  }

  get(tenantId: string, extensionId: string): Promise<NocoRecord> {
    return this.store.getById('extension', extensionId, tenantId);
  }

  async create(tenantId: string, input: ExtensionInput): Promise<NocoRecord> {
    return this.store.create('extension', {
      ...extensionValues(tenantId, input),
      device_id: null,
      provisioning_mac: null,
      enrollment_token_hash: null,
      enrollment_expires_at: null,
      enrollment_consumed_at: null,
      device_credential_version: 1,
    });
  }

  async update(
    tenantId: string,
    extensionId: string,
    expectedRevision: number,
    input: ExtensionInput,
  ): Promise<NocoRecord> {
    return this.store.update(
      'extension',
      extensionId,
      expectedRevision,
      extensionValues(tenantId, input),
      tenantId,
    );
  }

  /** Stores the enrollment token HASH only — never the issued token. */
  async recordEnrollment(
    tenantId: string,
    extensionId: string,
    expectedRevision: number,
    fields: {
      deviceId: string;
      provisioningMac: string;
      enrollmentTokenHash: string;
      enrollmentExpiresAt: string;
    },
  ): Promise<NocoRecord> {
    return this.store.update(
      'extension',
      extensionId,
      expectedRevision,
      {
        device_id: fields.deviceId,
        provisioning_mac: normalizeMac('provisioningMac', fields.provisioningMac),
        enrollment_token_hash: fields.enrollmentTokenHash,
        enrollment_expires_at: fields.enrollmentExpiresAt,
        enrollment_consumed_at: null,
      },
      tenantId,
    );
  }

  async bumpCredentialVersion(
    tenantId: string,
    extensionId: string,
    expectedRevision: number,
    currentVersion: number,
  ): Promise<NocoRecord> {
    return this.store.update(
      'extension',
      extensionId,
      expectedRevision,
      { device_credential_version: currentVersion + 1 },
      tenantId,
    );
  }
}

export interface RingGroupInput {
  name: string;
  virtualExtension: string;
  asteriskContext: string;
  ringTimeoutSeconds?: number | undefined;
  musicOnHoldClass?: string | null | undefined;
  callerIdName?: string | null | undefined;
  callerIdNumber?: string | null | undefined;
  enabled: boolean;
}

export class RingGroupRepository {
  constructor(private readonly store: NocoStore) {}

  private values(tenantId: string, input: RingGroupInput): Record<string, unknown> {
    return {
      tenant_id: tenantId,
      name: requireNonEmpty('name', input.name),
      virtual_extension: requireNonEmpty('virtualExtension', input.virtualExtension),
      asterisk_context: validateContext('asteriskContext', input.asteriskContext),
      ring_strategy: 'RING_ALL',
      ring_timeout_seconds: input.ringTimeoutSeconds ?? 20,
      music_on_hold_class: input.musicOnHoldClass ?? null,
      caller_id_name: input.callerIdName ?? null,
      caller_id_number: input.callerIdNumber
        ? normalizeE164('callerIdNumber', input.callerIdNumber)
        : null,
      enabled: input.enabled,
    };
  }

  listForTenant(tenantId: string): Promise<NocoRecord[]> {
    return this.store.list('ring_group', [{ field: 'tenant_id', op: 'eq', value: tenantId }]);
  }

  get(tenantId: string, ringGroupId: string): Promise<NocoRecord> {
    return this.store.getById('ring_group', ringGroupId, tenantId);
  }

  async create(tenantId: string, input: RingGroupInput): Promise<NocoRecord> {
    return this.store.create('ring_group', this.values(tenantId, input));
  }

  async update(
    tenantId: string,
    ringGroupId: string,
    expectedRevision: number,
    input: RingGroupInput,
  ): Promise<NocoRecord> {
    return this.store.update(
      'ring_group',
      ringGroupId,
      expectedRevision,
      this.values(tenantId, input),
      tenantId,
    );
  }

  listMembers(tenantId: string, ringGroupId: string): Promise<NocoRecord[]> {
    return this.store.list('ring_group_member', [
      { field: 'tenant_id', op: 'eq', value: tenantId },
      { field: 'ring_group_id', op: 'eq', value: ringGroupId },
    ]);
  }

  async addMember(
    tenantId: string,
    ringGroupId: string,
    extensionId: string,
    sortOrder: number,
  ): Promise<NocoRecord> {
    // Cross-tenant references never resolve: both sides must be this tenant's.
    await this.store.getById('ring_group', ringGroupId, tenantId);
    await this.store.getById('extension', extensionId, tenantId);
    return this.store.create('ring_group_member', {
      tenant_id: tenantId,
      ring_group_id: ringGroupId,
      extension_id: extensionId,
      sort_order: sortOrder,
      enabled: true,
    });
  }

  /**
   * Replaces the member set: listed extensions become enabled members in the
   * given order; existing members not listed are disabled (NocoDB rows are
   * never deleted).
   */
  async setMembers(
    tenantId: string,
    ringGroupId: string,
    extensionIds: string[],
  ): Promise<NocoRecord[]> {
    const existing = await this.listMembers(tenantId, ringGroupId);
    const byExtension = new Map(existing.map((m) => [m.extension_id as string, m]));
    const wanted = new Set(extensionIds);

    for (const member of existing) {
      if (!wanted.has(member.extension_id as string) && member.enabled) {
        await this.store.update(
          'ring_group_member',
          member.id as string,
          Number(member.revision),
          { enabled: false },
          tenantId,
        );
      }
    }
    const result: NocoRecord[] = [];
    for (const [index, extensionId] of extensionIds.entries()) {
      const current = byExtension.get(extensionId);
      if (current) {
        result.push(
          await this.store.update(
            'ring_group_member',
            current.id as string,
            Number(current.revision),
            { enabled: true, sort_order: index + 1 },
            tenantId,
          ),
        );
      } else {
        result.push(await this.addMember(tenantId, ringGroupId, extensionId, index + 1));
      }
    }
    return result;
  }
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

export interface DidRouteInput {
  didE164: string;
  assistantProfileId: string;
  destinationType: 'EXTENSION' | 'RING_GROUP';
  destinationId: string;
  screeningEnabled: boolean;
  enabled: boolean;
}

export class DidRouteRepository {
  constructor(private readonly store: NocoStore) {}

  /**
   * Exactly one destination FK matches destination_type, and both the
   * assistant profile and the destination must belong to the same tenant.
   */
  private async values(tenantId: string, input: DidRouteInput): Promise<Record<string, unknown>> {
    await this.store.getById('assistant_profile', input.assistantProfileId, tenantId);
    if (input.destinationType === 'EXTENSION') {
      await this.store.getById('extension', input.destinationId, tenantId);
    } else if (input.destinationType === 'RING_GROUP') {
      await this.store.getById('ring_group', input.destinationId, tenantId);
    } else {
      throw new ValidationError(
        'destinationType',
        'destinationType must be EXTENSION or RING_GROUP',
      );
    }
    return {
      tenant_id: tenantId,
      did_e164: normalizeE164('didE164', input.didE164),
      assistant_profile_id: input.assistantProfileId,
      destination_type: input.destinationType,
      destination_extension_id: input.destinationType === 'EXTENSION' ? input.destinationId : null,
      destination_ring_group_id:
        input.destinationType === 'RING_GROUP' ? input.destinationId : null,
      screening_enabled: input.screeningEnabled,
      enabled: input.enabled,
    };
  }

  listForTenant(tenantId: string): Promise<NocoRecord[]> {
    return this.store.list('did_route', [{ field: 'tenant_id', op: 'eq', value: tenantId }]);
  }

  get(tenantId: string, didRouteId: string): Promise<NocoRecord> {
    return this.store.getById('did_route', didRouteId, tenantId);
  }

  async create(tenantId: string, input: DidRouteInput): Promise<NocoRecord> {
    return this.store.create('did_route', await this.values(tenantId, input));
  }

  async update(
    tenantId: string,
    didRouteId: string,
    expectedRevision: number,
    input: DidRouteInput,
  ): Promise<NocoRecord> {
    return this.store.update(
      'did_route',
      didRouteId,
      expectedRevision,
      await this.values(tenantId, input),
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
  tenants: TenantRepository;
  tenantUsers: TenantUserRepository;
  extensions: ExtensionRepository;
  ringGroups: RingGroupRepository;
  assistantProfiles: AssistantProfileRepository;
  didRoutes: DidRouteRepository;
  appearance: AppearanceRepository;
  audit: AuditLog;
}

export function createRepos(api: NocoDbApi): AidaConfigRepos {
  const store = new NocoStore(api);
  return {
    store,
    tenants: new TenantRepository(store),
    tenantUsers: new TenantUserRepository(store),
    extensions: new ExtensionRepository(store),
    ringGroups: new RingGroupRepository(store),
    assistantProfiles: new AssistantProfileRepository(store),
    didRoutes: new DidRouteRepository(store),
    appearance: new AppearanceRepository(store),
    audit: new AuditLog(store),
  };
}
