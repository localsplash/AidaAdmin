/** Same-origin admin API client. Mutations carry the double-submit CSRF token. */

export interface ApiFailure {
  status: number;
  error?: string;
  message?: string;
}

export class ApiError extends Error {
  constructor(readonly failure: ApiFailure) {
    super(failure.message ?? failure.error ?? `Request failed (${failure.status})`);
  }
}

function csrfToken(): string {
  return /(?:^|;\s*)aida\.csrf=([^;]+)/.exec(document.cookie)?.[1] ?? '';
}

async function call<T>(path: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(method !== 'GET' ? { 'x-csrf-token': csrfToken() } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const parsed = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new ApiError({
      status: res.status,
      error: typeof parsed.error === 'string' ? parsed.error : undefined,
      message: typeof parsed.message === 'string' ? parsed.message : undefined,
    });
  }
  return parsed as T;
}

export interface Tenant {
  id: string;
  name: string;
  slug: string;
  asterisk_context: string;
  caller_id_name: string | null;
  caller_id_number: string | null;
  enabled: boolean;
  revision: number;
}

export interface TenantUser {
  id: string;
  tenant_id: string | null;
  identity_user_id: number;
  role: string;
  enabled: boolean;
}

export interface DirectoryUser {
  iUserId: number;
  email: string | null;
  displayName: string | null;
  claimed: boolean;
}

export interface Extension {
  id: string;
  extension_number: string;
  display_name: string;
  identity_user_id: number | null;
  caller_id_name: string | null;
  caller_id_number: string | null;
  provisioning_mac: string | null;
  device_credential_version: number;
  enabled: boolean;
  revision: number;
}

export interface RingGroup {
  id: string;
  name: string;
  virtual_extension: string;
  ring_timeout_seconds: number;
  enabled: boolean;
  revision: number;
  members: Array<{ extension_id: string }>;
}

export interface TenantInput {
  name: string;
  slug: string;
  asteriskContext: string;
  enabled: boolean;
}

export const adminApi = {
  listTenants: () => call<{ tenants: Tenant[] }>('/admin/tenants', 'GET'),
  createTenant: (input: TenantInput) => call<{ tenant: Tenant }>('/admin/tenants', 'POST', input),
  updateTenant: (tenantId: string, expectedRevision: number, input: TenantInput) =>
    call<{ tenant: Tenant }>(`/admin/tenants/${tenantId}`, 'PUT', { ...input, expectedRevision }),

  listTenantUsers: (tenantId: string) =>
    call<{ users: TenantUser[] }>(`/admin/tenants/${tenantId}/users`, 'GET'),
  searchDirectory: (query: string) =>
    call<{ users: DirectoryUser[] }>(
      `/admin/directory/users?query=${encodeURIComponent(query)}`,
      'GET',
    ),
  ensureDirectoryUser: (email: string, displayName: string) =>
    call<{ user: DirectoryUser }>('/admin/directory/users', 'POST', { email, displayName }),
  saveTenantUser: (tenantId: string, identityUserId: number, role: string, enabled: boolean) =>
    call<{ tenantUser: TenantUser }>(`/admin/tenants/${tenantId}/users/${identityUserId}`, 'PUT', {
      role,
      enabled,
    }),

  listExtensions: (tenantId: string) =>
    call<{ extensions: Extension[] }>(`/admin/tenants/${tenantId}/extensions`, 'GET'),
  createExtension: (input: {
    tenantId: string;
    extensionNumber: string;
    displayName: string;
    enabled: boolean;
  }) =>
    call<{ extension: Extension; sipUsername: string; sipSecret: string }>(
      '/admin/extensions',
      'POST',
      input,
    ),
  rotateSecret: (extensionId: string, tenantId: string, reprovisionDevice: boolean) =>
    call<{ sipSecret: string }>(`/admin/extensions/${extensionId}/rotate-secret`, 'POST', {
      tenantId,
      reprovisionDevice,
    }),
  issueEnrollment: (extensionId: string, tenantId: string, provisioningMac: string) =>
    call<{ deviceId: string; enrollmentToken: string; expiresAt: string }>(
      `/admin/extensions/${extensionId}/handset-enrollment`,
      'POST',
      { tenantId, provisioningMac },
    ),

  listRingGroups: (tenantId: string) =>
    call<{ ringGroups: RingGroup[] }>(`/admin/tenants/${tenantId}/ring-groups`, 'GET'),
  createRingGroup: (input: {
    tenantId: string;
    name: string;
    virtualExtension: string;
    memberExtensionIds: string[];
    enabled: boolean;
  }) => call<{ ringGroup: RingGroup }>('/admin/ring-groups', 'POST', input),
};
