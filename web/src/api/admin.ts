/** Same-origin admin API client. Mutations carry the double-submit CSRF token. */

export interface ApiFailure {
  status: number;
  error?: string;
  message?: string;
  correlationId?: string;
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
      correlationId:
        typeof parsed.correlationId === 'string'
          ? parsed.correlationId
          : (res.headers.get('x-correlation-id') ?? undefined),
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
  /** Joined from the central directory; null when it is unreachable. */
  email: string | null;
  display_name: string | null;
  claimed: boolean | null;
}

export interface DirectoryUser {
  iUserId: number;
  email: string | null;
  displayName: string | null;
  claimed: boolean;
  lastLoginAt?: string | null;
}

export type ApplyState = 'committed' | 'active' | 'unknown';
export interface Extension {
  id: string;
  extension: string | null;
  context: string;
  callerId: string | null;
  transport?: string | null;
  aors?: string | null;
  applyState: ApplyState;
}
export interface QueueMember {
  interface: string;
  memberName: string | null;
  penalty: number;
  paused: boolean;
}
export const QUEUE_STRATEGIES = [
  'ringall',
  'leastrecent',
  'fewestcalls',
  'random',
  'rrmemory',
  'linear',
  'wrandom',
] as const;
export type QueueStrategy = (typeof QUEUE_STRATEGIES)[number];
export interface NativeQueue {
  id: string;
  name: string;
  strategy: string | null;
  members: QueueMember[];
  applyState: ApplyState;
}
export interface NativeInventory {
  source: 'asterisk';
  iTenantId: number;
  provisioningEnabled: boolean;
}
export interface ExtensionInventory extends NativeInventory {
  extensions: Extension[];
  contexts: string[];
}
export interface QueueInventory extends NativeInventory {
  queues: NativeQueue[];
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

export interface DidSchedule {
  timeRange: string;
  weekdays: string;
  timezone: string;
}
export interface DidSettings {
  queue: string;
  ringsBeforeAi: number;
  schedule?: DidSchedule;
  livekitDestination?: string;
}
export type DidRoute =
  | {
      did: string;
      managed: true;
      queue: string;
      ringsBeforeAi: number;
      schedule?: DidSchedule;
      livekitDestination: string;
      ringTimeoutSeconds: number;
      applyState: ApplyState;
    }
  | {
      did: string;
      managed: false;
      availability: 'unconfigured' | 'manual' | 'unknown' | 'scope_missing';
      applyState: 'unknown';
    };
export interface DidInventory extends NativeInventory {
  dids: DidRoute[];
  numbers: TenantNumber[];
}

export interface Appearance {
  id: string;
  brand_name: string;
  primary_color: string | null;
  logo_asset_path: string | null;
  revision: number;
}

export interface ExtensionInput {
  extension: string;
  displayName: string;
  callerIdNumber?: string;
  context?: string;
}
export interface MemberInput {
  penalty: number;
  paused: boolean;
  context?: string;
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

export interface TenantNumber {
  iPhoneNumberId: number;
  iTenantId: number;
  phoneNumber: string;
  label: string;
  bVoice: true;
  bMessaging: true;
  bEnabled: boolean;
  accessPolicy: 'TENANT_MEMBERS';
  iVersion: number;
}
export type NumberInput = Omit<TenantNumber, 'iPhoneNumberId' | 'iTenantId' | 'iVersion'>;
export const adminApi = {
  listNumbers: (tenantId: string) =>
    call<{ numbers: TenantNumber[] }>(
      `/admin/tenants/${encodeURIComponent(tenantId)}/numbers`,
      'GET',
    ),
  saveNumber: (
    tenantId: string,
    numberId: number | null,
    input: NumberInput & { expectedVersion?: number },
  ) =>
    call<{ number: TenantNumber }>(
      `/admin/tenants/${encodeURIComponent(tenantId)}/numbers${numberId === null ? '' : '/' + numberId}`,
      numberId === null ? 'POST' : 'PUT',
      input,
    ),
  selectTenant: (tenantId: string) => call('/api/session/tenant', 'POST', { tenantId }),
  addTenantUser: (
    tenantId: string,
    input: { email: string; displayName: string | null; role: string; enabled: boolean },
  ) => call(`/admin/tenants/${tenantId}/users`, 'POST', input),
  editTenantUser: (
    tenantId: string,
    userId: number,
    input: { role: string; enabled: boolean; displayName?: string | null; email?: string },
  ) => call(`/admin/tenants/${tenantId}/users/${userId}`, 'PUT', input),
  listTenants: () => call<{ tenants: Tenant[] }>('/admin/tenants', 'GET'),
  createTenant: (input: TenantInput) => call<{ tenant: Tenant }>('/admin/tenants', 'POST', input),
  updateTenant: (tenantId: string, expectedRevision: number, input: TenantInput) =>
    call<{ tenant: Tenant }>(`/admin/tenants/${tenantId}`, 'PUT', { ...input, expectedRevision }),

  listTenantUsers: (tenantId: string) =>
    call<{
      users: TenantUser[];
      canEditDisplayName: boolean;
      canManageDirectory?: boolean;
      assignableRoles?: string[];
      directoryError: string | null;
    }>(`/admin/tenants/${tenantId}/users`, 'GET'),
  searchDirectory: (query: string) =>
    call<{ users: DirectoryUser[]; canEditDisplayName: boolean; canCreate: boolean }>(
      `/admin/directory/users?query=${encodeURIComponent(query)}`,
      'GET',
    ),
  updateDirectoryUser: (identityUserId: number, displayName: string | null) =>
    call<{ user: DirectoryUser }>(`/admin/directory/users/${identityUserId}`, 'PUT', {
      displayName,
    }),
  ensureDirectoryUser: (email: string, displayName: string | null) =>
    call<{ user: DirectoryUser }>('/admin/directory/users', 'POST', { email, displayName }),
  saveTenantUser: (tenantId: string, identityUserId: number, role: string, enabled: boolean) =>
    call<{ tenantUser: TenantUser }>(`/admin/tenants/${tenantId}/users/${identityUserId}`, 'PUT', {
      role,
      enabled,
    }),

  listExtensions: (tenantId: string) =>
    call<ExtensionInventory>(`/admin/tenants/${encodeURIComponent(tenantId)}/extensions`, 'GET'),
  createExtension: (tenantId: string, input: ExtensionInput) =>
    call<{ extension: string; sipUsername: string; sipSecret: string; applyState: ApplyState }>(
      `/admin/tenants/${encodeURIComponent(tenantId)}/extensions`,
      'POST',
      input,
    ),
  deleteExtension: (tenantId: string, extension: string) =>
    call<void>(
      `/admin/tenants/${encodeURIComponent(tenantId)}/extensions/${encodeURIComponent(extension)}`,
      'DELETE',
    ),
  listQueues: (tenantId: string) =>
    call<QueueInventory>(`/admin/tenants/${encodeURIComponent(tenantId)}/queues`, 'GET'),
  createQueue: (tenantId: string, input: { name: string; strategy: QueueStrategy }) =>
    call<{ name: string; strategy: QueueStrategy; applyState: ApplyState }>(
      `/admin/tenants/${encodeURIComponent(tenantId)}/queues`,
      'POST',
      input,
    ),
  deleteQueue: (tenantId: string, queue: string) =>
    call<void>(
      `/admin/tenants/${encodeURIComponent(tenantId)}/queues/${encodeURIComponent(queue)}`,
      'DELETE',
    ),
  setQueueMember: (tenantId: string, queue: string, extension: string, input: MemberInput) =>
    call<{ applyState: ApplyState }>(
      `/admin/tenants/${encodeURIComponent(tenantId)}/queues/${encodeURIComponent(queue)}/members/${encodeURIComponent(extension)}`,
      'PUT',
      input,
    ),
  deleteQueueMember: (tenantId: string, queue: string, extension: string) =>
    call<void>(
      `/admin/tenants/${encodeURIComponent(tenantId)}/queues/${encodeURIComponent(queue)}/members/${encodeURIComponent(extension)}`,
      'DELETE',
    ),

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
    call<DidInventory>(`/admin/tenants/${encodeURIComponent(tenantId)}/did-routes`, 'GET'),
  saveDidRoute: (tenantId: string, did: string, input: DidSettings) =>
    call<{ did: string; ringTimeoutSeconds: number; applyState: ApplyState }>(
      `/admin/tenants/${encodeURIComponent(tenantId)}/did-routes/${encodeURIComponent(did)}`,
      'PUT',
      input,
    ),
  deleteDidRoute: (tenantId: string, did: string) =>
    call<void>(
      `/admin/tenants/${encodeURIComponent(tenantId)}/did-routes/${encodeURIComponent(did)}`,
      'DELETE',
    ),

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
