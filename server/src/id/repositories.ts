import { HttpIdClient, type PlatformMembership, type PlatformTenant } from './client.js';
import { identityActor } from './context.js';
import type { NocoRecord } from '../nocodb/api.js';
import {
  NocoStore,
  NotFoundError,
  type TenantInput,
  type TenantUserRole,
} from '../nocodb/repos.js';
import { ValidationError, validateContext, normalizeE164 } from '../nocodb/validation.js';

export function platformTenantId(value: string): number {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1 || String(id) !== value) {
    throw new ValidationError(
      'tenantId',
      'A positive platform tenant ID is required; legacy UUIDs need an explicit migration mapping',
    );
  }
  return id;
}

/** Tenant identity is read from Identity; this app adds only voice configuration. */
export class PlatformTenantRepository {
  constructor(
    private readonly client: HttpIdClient,
    private readonly store: NocoStore,
  ) {}
  private async combine(tenant: PlatformTenant): Promise<NocoRecord> {
    const profile = (
      await this.store.list('tenant_profile', [
        { field: 'tenant_id', op: 'eq', value: tenant.iTenantId },
      ])
    )[0];
    return {
      ...profile,
      id: String(tenant.iTenantId),
      iTenantId: tenant.iTenantId,
      name: tenant.name,
      slug: tenant.slug,
      enabled: tenant.bEnabled,
      revision: profile?.revision ?? 0,
      asterisk_context: profile?.asterisk_context ?? '',
    };
  }
  async list(): Promise<NocoRecord[]> {
    const { tenants } = await this.client.directoryRequest<{ tenants: PlatformTenant[] }>(
      'tenants',
    );
    return Promise.all(tenants.map((tenant) => this.combine(tenant)));
  }
  async get(tenantId: string): Promise<NocoRecord> {
    platformTenantId(tenantId);
    const tenant = (await this.list()).find((row) => row.id === tenantId);
    if (!tenant) throw new NotFoundError('Platform tenant not found');
    return tenant;
  }
  private values(tenantId: number, input: TenantInput): NocoRecord {
    return {
      tenant_id: tenantId,
      asterisk_context: validateContext('asteriskContext', input.asteriskContext),
      caller_id_name: input.callerIdName ?? null,
      caller_id_number: input.callerIdNumber
        ? normalizeE164('callerIdNumber', input.callerIdNumber)
        : null,
    };
  }
  async create(input: TenantInput): Promise<NocoRecord> {
    // Validate voice intent before creating a platform business.
    this.values(1, input);
    const tenant = await this.client.directoryRequest<PlatformTenant>('tenants', 'POST', {
      name: input.name,
      slug: input.slug,
    });
    if (!input.enabled)
      await this.client.directoryRequest(`tenants/${tenant.iTenantId}`, 'PATCH', {
        bEnabled: false,
      });
    await this.store.create('tenant_profile', this.values(tenant.iTenantId, input));
    return this.get(String(tenant.iTenantId));
  }
  async update(
    tenantId: string,
    expectedRevision: number,
    input: TenantInput,
  ): Promise<NocoRecord> {
    const id = platformTenantId(tenantId);
    const existing = (
      await this.store.list('tenant_profile', [{ field: 'tenant_id', op: 'eq', value: id }])
    )[0];
    const values = this.values(id, input);
    // Profile updates remain separate from directory updates. Failures are explicit
    // and retryable; neither store is claimed to be in a cross-store transaction.
    if (existing)
      await this.store.update(
        'tenant_profile',
        existing.id as string,
        expectedRevision,
        values,
        tenantId,
      );
    else if (expectedRevision === 0) await this.store.create('tenant_profile', values);
    else throw new NotFoundError('Voice tenant profile not found');
    await this.client.directoryRequest(`tenants/${id}`, 'PATCH', {
      name: input.name,
      slug: input.slug,
      bEnabled: input.enabled,
    });
    return this.get(tenantId);
  }
}

export class PlatformMembershipRepository {
  constructor(private readonly client: HttpIdClient) {}
  async listForTenant(tenantId: string): Promise<NocoRecord[]> {
    const id = platformTenantId(tenantId);
    const { memberships } = await this.client.directoryRequest<{
      memberships: PlatformMembership[];
    }>(`tenants/${id}/memberships`);
    return memberships.map((member) => ({
      id: `${id}:${member.iUserId}`,
      tenant_id: tenantId,
      identity_user_id: member.iUserId,
      role: member.role,
      enabled: member.bEnabled,
      email: member.email,
      display_name: member.displayName,
      claimed: member.claimed,
    }));
  }
  async listForUser(iUserId: number): Promise<NocoRecord[]> {
    const token = identityActor.getStore()?.token;
    if (!token) return [];
    const session = await this.client.introspectSession(token);
    if (!session.active || session.user.iUserId !== iUserId) return [];
    return session.tenants
      .filter((t) => t.bEnabled)
      .map((tenant) => ({
        id: `${tenant.iTenantId}:${iUserId}`,
        tenant_id: String(tenant.iTenantId),
        identity_user_id: iUserId,
        role: tenant.role,
        enabled: true,
      }));
  }
  async save(
    tenantId: string | null,
    iUserId: number,
    role: TenantUserRole,
    enabled: boolean,
  ): Promise<NocoRecord> {
    if (tenantId === null || role === 'SUPER_ADMIN') {
      throw new ValidationError(
        'role',
        'SUPER_ADMIN is assigned by Identity, never by an application membership',
      );
    }
    const id = platformTenantId(tenantId);
    await this.client.directoryRequest(`tenants/${id}/memberships/${iUserId}`, 'PUT', {
      role,
      bEnabled: enabled,
    });
    return {
      id: `${id}:${iUserId}`,
      tenant_id: tenantId,
      identity_user_id: iUserId,
      role,
      enabled,
    };
  }
}
