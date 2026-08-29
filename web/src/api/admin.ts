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

export interface AssistantProfile {
  id: string;
  name: string;
  business_name: string;
  prompt: string;
  tone: string | null;
  objective: string | null;
  opening_statement: string | null;
  transfer_statement: string | null;
  failed_transfer_statement: string | null;
  enabled: boolean;
  revision: number;
}

export interface DidRoute {
  id: string;
  did_e164: string;
  assistant_profile_id: string;
  destination_type: 'EXTENSION' | 'RING_GROUP';
  screening_enabled: boolean;
  enabled: boolean;
  revision: number;
  fallbackPreview: string;
}

export interface Appearance {
  id: string;
  brand_name: string;
  primary_color: string | null;
  logo_asset_path: string | null;
  revision: number;
}

export interface ProfileInput {
  tenantId: string;
  name: string;
  businessName: string;
  prompt: string;
  tone?: string;
  objective?: string;
  openingStatement?: string;
  transferStatement?: string;
  failedTransferStatement?: string;
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

  listProfiles: (tenantId: string) =>
    call<{ profiles: AssistantProfile[] }>(`/admin/tenants/${tenantId}/profiles`, 'GET'),
  createProfile: (input: ProfileInput) =>
    call<{ profile: AssistantProfile }>('/admin/profiles', 'POST', input),
  updateProfile: (profileId: string, expectedRevision: number, input: ProfileInput) =>
    call<{ profile: AssistantProfile }>(`/admin/profiles/${profileId}`, 'PUT', {
      ...input,
      expectedRevision,
    }),

  listDidRoutes: (tenantId: string) =>
    call<{ didRoutes: DidRoute[] }>(`/admin/tenants/${tenantId}/did-routes`, 'GET'),
  createDidRoute: (input: {
    tenantId: string;
    didE164: string;
    assistantProfileId: string;
    destinationType: 'EXTENSION' | 'RING_GROUP';
    destinationId: string;
    screeningEnabled: boolean;
    enabled: boolean;
  }) => call<{ didRoute: DidRoute }>('/admin/did-routes', 'POST', input),

  getAppearance: (tenantId: string) =>
    call<{ appearance: Appearance | null }>(`/admin/tenants/${tenantId}/appearance`, 'GET'),
  saveAppearance: (tenantId: string, brandName: string, primaryColor: string | null) =>
    call<{ appearance: Appearance }>(`/admin/tenants/${tenantId}/appearance`, 'PUT', {
      brandName,
      primaryColor,
    }),
  uploadLogo: async (tenantId: string, file: File) => {
    const res = await fetch(`/admin/tenants/${tenantId}/appearance/logo`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': file.type, 'x-csrf-token': csrfToken() },
      body: file,
    });
    const parsed = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      throw new ApiError({
        status: res.status,
        message: typeof parsed.message === 'string' ? parsed.message : undefined,
      });
    }
    return parsed as { logoAssetPath: string };
  },
};
