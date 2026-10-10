/**
 * Read-only view of AidaPbx's runtime state (calls,
 * events, commands, participants, webhook deliveries, dependency status).
 *
 * OfficePulse owns `aidacalls_db` and is its only client: AidaAdmin reads
 * these views through OfficePulse's private API (`/v1/admin/calls...` and
 * `/v1/admin/runtime/...`), never with a database login of its own. Staff
 * and tenant authorization happen here before a request goes out; the
 * tenant filter is always explicit.
 */

import { z } from 'zod';
import { OfficePulseError } from './client.js';

/** Observed runtime label; no routing intent is accepted by Admin. */
export type DestinationType = string;

export interface RuntimeCallSession {
  id: string;
  asteriskLinkedId: string;
  officePulseInstanceId: string;
  tenantId: string;
  didE164: string;
  callerNumber: string | null;
  /** The AidaAdmin ids and revisions this call actually used. */
  config: {
    didRouteId: string | null;
    didRouteRevision: number | null;
    profileId: string | null;
    profileRevision: number | null;
    tenantRevision: number | null;
  };
  roomName: string | null;
  agentParticipantSid: string | null;
  destinationType: DestinationType | null;
  destinationId: string | null;
  disposition: string;
  state: string;
  version: number;
  createdAt: string;
  endedAt: string | null;
}

export interface RuntimeCallEvent {
  sequenceNumber: number;
  eventType: string;
  payload: Record<string, unknown> | null;
  createdAt: string;
}

export interface RuntimeControlCommand {
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

export interface RuntimeWebhookDelivery {
  source: string;
  deliveryId: string;
  eventType: string;
  callSessionId: string | null;
  receivedAt: string;
}

export interface RuntimeDependencyStatus {
  name: string;
  ready: boolean;
  detail: string | null;
  changedAt: string;
}

/**
 * Which calls: `active` has not ended and is younger than the orphan
 * horizon; `orphaned` has not ended but is older than it (OfficePulse or
 * Asterisk lost track of it); `recent` has ended, newest first.
 */
export type CallListState = 'active' | 'recent' | 'orphaned' | 'all';

export interface CallListFilter {
  state: CallListState;
  /** Omitted only by a Super Admin asking for every tenant. */
  tenantId?: string | undefined;
  limit?: number | undefined;
}

export interface RuntimeReader {
  listCallSessions(filter: CallListFilter): Promise<RuntimeCallSession[]>;
  /** Tenant-scoped when a tenantId is given: another tenant's id is "not found". */
  getCallSession(callSessionId: string, tenantId?: string): Promise<RuntimeCallSession | null>;
  listCallEvents(callSessionId: string, sinceSequence?: number): Promise<RuntimeCallEvent[]>;
  listControlCommands(callSessionId: string): Promise<RuntimeControlCommand[]>;
  listParticipants(callSessionId: string): Promise<RuntimeParticipant[]>;
  listWebhookDeliveries(limit?: number): Promise<RuntimeWebhookDelivery[]>;
  listDependencyStatus(): Promise<RuntimeDependencyStatus[]>;
  /** Failed control commands across calls, newest first, for the issues view. */
  listFailedCommands(
    sinceHours: number,
    tenantId?: string,
  ): Promise<Array<RuntimeControlCommand & { callSessionId: string; tenantId: string }>>;
  /** Events of the given types across calls, newest first, for the issues view. */
  listEventsOfType(
    eventTypes: string[],
    sinceHours: number,
    tenantId?: string,
  ): Promise<Array<RuntimeCallEvent & { callSessionId: string; tenantId: string }>>;
}

/** Calls without an end older than this are presumed lost, not live (OfficePulse's rule). */
export const ORPHAN_HORIZON_HOURS = 6;

const UPSTREAM_TIMEOUT_MS = 10_000;

// OfficePulse omits absent optional fields; these schemas turn them into nulls.
const text = z.string();
const optional = z
  .string()
  .nullish()
  .transform((v) => v ?? null);
const optionalNumber = z
  .number()
  .nullish()
  .transform((v) => v ?? null);
const object = z
  .record(z.string(), z.unknown())
  .nullish()
  .transform((v) => v ?? null);

const session = z
  .object({
    id: text,
    asteriskLinkedId: text,
    officePulseInstanceId: text,
    tenantId: text,
    didE164: text,
    callerNumber: optional,
    config: z
      .object({
        didRouteId: optional,
        didRouteRevision: optionalNumber,
        profileId: optional,
        profileRevision: optionalNumber,
        tenantRevision: optionalNumber,
      })
      .default({}),
    roomName: optional,
    agentParticipantSid: optional,
    destinationType: optional,
    destinationId: optional,
    disposition: text,
    state: text,
    version: z.number(),
    createdAt: text,
    endedAt: optional,
  })
  .transform((s): RuntimeCallSession => s as RuntimeCallSession);
const event = z.object({
  sequenceNumber: z.number(),
  eventType: text,
  payload: object,
  createdAt: text,
});
const command = z.object({
  idempotencyKey: text,
  commandType: text,
  payload: object,
  status: text,
  result: object,
  createdAt: text,
  completedAt: optional,
});
const owner = { callSessionId: text, tenantId: text };
const participant = z.object({
  participantSid: text,
  identity: optional,
  kind: text,
  joinedAt: text,
  leftAt: optional,
});
const delivery = z.object({
  source: text,
  deliveryId: text,
  eventType: text,
  callSessionId: optional,
  receivedAt: text,
});
const dependency = z.object({ name: text, ready: z.boolean(), detail: optional, changedAt: text });

type Query = Record<string, string | number | string[] | undefined>;

export class HttpRuntimeReader implements RuntimeReader {
  constructor(private readonly baseUrl: string) {}

  private async get<S extends z.ZodTypeAny>(
    path: string,
    query: Query,
    key: string,
    item: S,
  ): Promise<Array<z.infer<S>>> {
    const params = new URLSearchParams();
    for (const [name, value] of Object.entries(query)) {
      if (value === undefined) continue;
      for (const one of Array.isArray(value) ? value : [value]) params.append(name, String(one));
    }
    const search = params.size > 0 ? `?${params}` : '';
    let response: Response;
    try {
      response = await fetch(new URL(`${path}${search}`, this.baseUrl), {
        redirect: 'error',
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
    } catch {
      throw new OfficePulseError('OfficePulse could not be reached', 503);
    }
    if (!response.ok) {
      // Never retain an upstream error body: it may carry internal detail.
      await response.body?.cancel().catch(() => {});
      throw new OfficePulseError('OfficePulse runtime read failed', response.status);
    }
    const body: unknown = await response.json().catch(() => null);
    const parsed = z.object({ [key]: z.array(item) }).safeParse(body);
    if (!parsed.success)
      throw new OfficePulseError('OfficePulse returned an invalid runtime response', 502);
    return parsed.data[key] as Array<z.infer<S>>;
  }

  private static call(id: string): string {
    return `/v1/admin/calls/${encodeURIComponent(id)}`;
  }

  listCallSessions(filter: CallListFilter): Promise<RuntimeCallSession[]> {
    return this.get(
      '/v1/admin/calls',
      { state: filter.state, tenantId: filter.tenantId, limit: filter.limit },
      'calls',
      session,
    );
  }

  async getCallSession(
    callSessionId: string,
    tenantId?: string,
  ): Promise<RuntimeCallSession | null> {
    let response: Response;
    try {
      response = await fetch(new URL(HttpRuntimeReader.call(callSessionId), this.baseUrl), {
        redirect: 'error',
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
    } catch {
      throw new OfficePulseError('OfficePulse could not be reached', 503);
    }
    if (response.status === 404) {
      await response.body?.cancel().catch(() => {});
      return null;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new OfficePulseError('OfficePulse runtime read failed', response.status);
    }
    const parsed = session.safeParse(await response.json().catch(() => null));
    if (!parsed.success)
      throw new OfficePulseError('OfficePulse returned an invalid runtime response', 502);
    // Another tenant's call is indistinguishable from a missing one.
    if (tenantId !== undefined && parsed.data.tenantId !== tenantId) return null;
    return parsed.data;
  }

  async listCallEvents(callSessionId: string, sinceSequence = 0): Promise<RuntimeCallEvent[]> {
    const events = await this.get(
      `${HttpRuntimeReader.call(callSessionId)}/events`,
      {},
      'events',
      event,
    );
    return events.filter((e) => e.sequenceNumber > sinceSequence);
  }

  listControlCommands(callSessionId: string): Promise<RuntimeControlCommand[]> {
    return this.get(`${HttpRuntimeReader.call(callSessionId)}/commands`, {}, 'commands', command);
  }

  listParticipants(callSessionId: string): Promise<RuntimeParticipant[]> {
    return this.get(
      `${HttpRuntimeReader.call(callSessionId)}/participants`,
      {},
      'participants',
      participant,
    );
  }

  listWebhookDeliveries(limit?: number): Promise<RuntimeWebhookDelivery[]> {
    return this.get('/v1/admin/runtime/webhook-deliveries', { limit }, 'deliveries', delivery);
  }

  listDependencyStatus(): Promise<RuntimeDependencyStatus[]> {
    return this.get('/v1/admin/runtime/dependencies', {}, 'dependencies', dependency);
  }

  listFailedCommands(sinceHours: number, tenantId?: string) {
    return this.get(
      '/v1/admin/runtime/failed-commands',
      { sinceHours, tenantId },
      'commands',
      command.extend(owner),
    );
  }

  async listEventsOfType(eventTypes: string[], sinceHours: number, tenantId?: string) {
    if (eventTypes.length === 0) return [];
    return this.get(
      '/v1/admin/runtime/events',
      { type: eventTypes, sinceHours, tenantId },
      'events',
      event.extend(owner),
    );
  }
}
