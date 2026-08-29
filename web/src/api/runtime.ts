import type { CallEvent } from '../runtime/callState';

export class RuntimeApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
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
    );
  }
  return parsed as T;
}

export interface ActiveCallSummary {
  callSessionId: string;
  callerNumber: string | null;
  state: string;
  version?: number;
  startedAt?: string;
}

export interface OperationalEvent {
  id: string | number;
  occurredAt?: string;
  message?: string;
  eventType?: string;
}

export const runtimeApi = {
  listCalls: (state: 'active' | 'recent') =>
    call<{ calls: ActiveCallSummary[] }>(`/runtime/calls?state=${state}`, 'GET'),
  listEvents: (callSessionId: string, since: number) =>
    call<{ events: CallEvent[] }>(
      `/runtime/calls/${encodeURIComponent(callSessionId)}/events?since=${since}`,
      'GET',
    ),
  submitCommand: (
    callSessionId: string,
    commandType: 'TAKEOVER' | 'GUIDE',
    expectedCallVersion: number,
    idempotencyKey: string,
    payload?: Record<string, unknown>,
  ) =>
    call<{ accepted?: boolean }>(
      `/runtime/calls/${encodeURIComponent(callSessionId)}/commands`,
      'POST',
      { commandType, expectedCallVersion, idempotencyKey, ...(payload ? { payload } : {}) },
    ),
  operationalEvents: () =>
    call<{ events: OperationalEvent[] }>('/runtime/operational-events', 'GET'),
};
