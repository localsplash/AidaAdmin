/**
 * Same-origin client for the runtime views (issue #29). The server reads
 * OfficePulse's `aida_officepulse` database through a read-only account and
 * sends the few allowed actions to OfficePulse's private API; the browser
 * never sees either.
 */

export class RuntimeApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Server error code, e.g. runtime_db_not_configured. */
    readonly code?: string,
    readonly missingConfiguration: string[] = [],
  ) {
    super(message);
  }
}

function csrfToken(): string {
  return /(?:^|;\s*)aida\.csrf=([^;]+)/.exec(document.cookie)?.[1] ?? '';
}

async function call<T>(path: string, method: 'GET' | 'POST', body?: unknown): Promise<T> {
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
    throw new RuntimeApiError(
      res.status,
      typeof parsed.message === 'string'
        ? parsed.message
        : typeof parsed.error === 'string'
          ? parsed.error
          : `Request failed (${res.status})`,
      typeof parsed.error === 'string' ? parsed.error : undefined,
      Array.isArray(parsed.missingConfiguration) ? (parsed.missingConfiguration as string[]) : [],
    );
  }
  return parsed as T;
}

export interface RuntimeCall {
  id: string;
  asteriskLinkedId: string;
  officePulseInstanceId: string;
  tenantId: string;
  didE164: string;
  /** Already presented for the caller's role: full, or masked for staff. */
  callerNumber: string | null;
  config: {
    didRouteId: string | null;
    didRouteRevision: number | null;
    profileId: string | null;
    profileRevision: number | null;
    tenantRevision: number | null;
  };
  roomName: string | null;
  agentParticipantSid: string | null;
  destinationType: 'EXTENSION' | 'RING_GROUP' | null;
  destinationId: string | null;
  disposition: string;
  state: string;
  version: number;
  createdAt: string;
  endedAt: string | null;
}

export interface RuntimeEvent {
  sequenceNumber: number;
  eventType: string;
  payload: Record<string, unknown> | null;
  createdAt: string;
}

export interface RuntimeCommand {
  idempotencyKey: string;
  commandType: string;
  payload: Record<string, unknown> | null;
  status: string;
  result: Record<string, unknown> | null;
  createdAt: string;
  completedAt: string | null;
}

export interface RuntimeParticipant {
  participantSid: string;
  identity: string | null;
  kind: string;
  joinedAt: string;
  leftAt: string | null;
}

export interface CallDetail {
  call: RuntimeCall;
  events: RuntimeEvent[];
  commands: RuntimeCommand[];
  participants: RuntimeParticipant[];
}

export interface DependencyRecord {
  name: string;
  ready: boolean;
  detail: string | null;
  changedAt: string;
}

export interface LiveReadiness {
  reachable: boolean;
  ready: boolean;
  fullyOperational: boolean;
  components: Record<
    string,
    { ready: boolean; criticality: string; detail?: string; since?: string }
  >;
}

export interface ProvisioningOperation {
  requestId: string;
  kind: string;
  externalId: string;
  action: string;
  status: string;
  createdAt: string;
}

export interface WebhookDelivery {
  source: string;
  deliveryId: string;
  eventType: string;
  callSessionId: string | null;
  receivedAt: string;
}

export interface DidFallback {
  didRouteId: string;
  tenantId: string;
  didE164: string;
  destinationType: 'EXTENSION' | 'RING_GROUP';
  destinationId: string;
  enabled: boolean;
  updatedAt: string;
}

export interface Issues {
  windowHours: number;
  failedCommands: Array<RuntimeCommand & { callSessionId: string; tenantId: string }>;
  events: Array<RuntimeEvent & { callSessionId: string; tenantId: string }>;
  dependenciesDown: DependencyRecord[];
}

export interface CommandOutcome {
  accepted: boolean;
  duplicate: boolean;
  status?: string;
  error?: string;
}

export type CallListState = 'active' | 'recent' | 'orphaned' | 'all';

const tenantQuery = (tenant?: string) => (tenant ? `&tenant=${encodeURIComponent(tenant)}` : '');

export const runtimeApi = {
  listCalls: (state: CallListState, tenant?: string) =>
    call<{ calls: RuntimeCall[] }>(`/runtime/calls?state=${state}${tenantQuery(tenant)}`, 'GET'),
  getCall: (callSessionId: string, tenant?: string) =>
    call<CallDetail>(
      `/runtime/calls/${encodeURIComponent(callSessionId)}?x=1${tenantQuery(tenant)}`,
      'GET',
    ),
  listEvents: (callSessionId: string, since: number) =>
    call<{ events: RuntimeEvent[] }>(
      `/runtime/calls/${encodeURIComponent(callSessionId)}/events?since=${since}`,
      'GET',
    ),
  takeover: (callSessionId: string, idempotencyKey: string, ringTimeoutSeconds?: number) =>
    call<CommandOutcome>(`/runtime/calls/${encodeURIComponent(callSessionId)}/commands`, 'POST', {
      commandType: 'TAKEOVER',
      idempotencyKey,
      ...(ringTimeoutSeconds ? { ringTimeoutSeconds } : {}),
    }),
  issues: (tenant?: string) => call<Issues>(`/runtime/issues?x=1${tenantQuery(tenant)}`, 'GET'),
  dependencies: () =>
    call<{ recorded: DependencyRecord[]; live: LiveReadiness | null }>(
      '/runtime/dependencies',
      'GET',
    ),
  testDependencies: () => call<{ live: LiveReadiness }>('/runtime/dependencies/test', 'POST', {}),
  provisioning: (tenant?: string) =>
    call<{ operations: ProvisioningOperation[] }>(
      `/runtime/provisioning?x=1${tenantQuery(tenant)}`,
      'GET',
    ),
  retryProvisioning: (kind: 'EXTENSION' | 'RING_GROUP' | 'DID', externalId: string) =>
    call<{ retried: { kind: string; externalId: string; tenantId: string } }>(
      '/runtime/provisioning/retry',
      'POST',
      { kind, externalId },
    ),
  webhooks: () => call<{ deliveries: WebhookDelivery[] }>('/runtime/webhooks', 'GET'),
  fallbacks: (tenant?: string) =>
    call<{ fallbacks: DidFallback[] }>(`/runtime/fallbacks?x=1${tenantQuery(tenant)}`, 'GET'),
  orphans: () =>
    call<{ orphans: Array<{ call: RuntimeCall; participantsPresent: RuntimeParticipant[] }> }>(
      '/runtime/orphans',
      'GET',
    ),
};
