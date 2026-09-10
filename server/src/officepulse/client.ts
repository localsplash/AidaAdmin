/** Server-only client for the canonical native PBX and call-control API. */
import { z } from 'zod';
import * as pbx from './pbx-contract.js';
const UPSTREAM_TIMEOUT_MS = 10_000;

/** The one staff command OfficePulse acts on; DRAIN_ACK is the agent's. */
export interface CallCommandRequest {
  commandType: 'TAKEOVER';
  expectedCallVersion?: number | undefined;
  idempotencyKey: string;
  ringTimeoutSeconds?: number | undefined;
  musicOnHoldClass?: string | undefined;
}

/**
 * A command's upstream answer, status and all: 202 accepted, 200 a replay
 * of a recorded outcome, 404/409/422 a refusal the caller should see.
 */
export interface UpstreamOutcome {
  status: number;
  body: Record<string, unknown>;
}

export interface OfficePulseComponent {
  ready: boolean;
  criticality: string;
  detail?: string;
  since?: string;
}

export interface OfficePulseReadiness {
  reachable: boolean;
  ready: boolean;
  fullyOperational: boolean;
  components: Record<string, OfficePulseComponent>;
}

export interface OfficePulseClient {
  listExtensions(iTenantId: number, correlationId: string): Promise<pbx.ExtensionInventory>;
  createExtension(
    iTenantId: number,
    input: pbx.CreateExtension,
    correlationId: string,
  ): Promise<pbx.ExtensionCreated>;
  deleteExtension(iTenantId: number, extension: string, correlationId: string): Promise<void>;
  listQueues(iTenantId: number, correlationId: string): Promise<pbx.QueueInventory>;
  createQueue(
    iTenantId: number,
    input: pbx.CreateQueue,
    correlationId: string,
  ): Promise<pbx.QueueCreated>;
  deleteQueue(iTenantId: number, queue: string, correlationId: string): Promise<void>;
  putQueueMember(
    iTenantId: number,
    queue: string,
    extension: string,
    input: pbx.QueueMemberInput,
    correlationId: string,
  ): Promise<pbx.MemberSaved>;
  deleteQueueMember(
    iTenantId: number,
    queue: string,
    extension: string,
    correlationId: string,
  ): Promise<void>;
  listDids(iTenantId: number, correlationId: string): Promise<pbx.DidInventory>;
  putDid(
    iTenantId: number,
    did: string,
    input: pbx.DidSettings,
    correlationId: string,
  ): Promise<pbx.ManagedDid>;
  deleteDid(iTenantId: number, did: string, correlationId: string): Promise<void>;
  submitCallCommand(callSessionId: string, req: CallCommandRequest): Promise<UpstreamOutcome>;
  /** OfficePulse's own /readyz: never throws — an unreachable service is a result. */
  readiness(): Promise<OfficePulseReadiness>;
}

export class OfficePulseError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    /** OfficePulse's `error` string when it sent one — a short phrase, never a body. */
    readonly upstreamError?: string,
  ) {
    super(message);
  }
}

const UNREACHABLE: OfficePulseReadiness = {
  reachable: false,
  ready: false,
  fullyOperational: false,
  components: {},
};

export class HttpOfficePulseClient implements OfficePulseClient {
  constructor(private readonly baseUrl: string) {}

  private async fetchJson(
    path: string,
    method: string,
    body?: unknown,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await fetch(new URL(path, this.baseUrl), {
      method,
      headers: {
        accept: 'application/json',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    const parsed = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: res.status, body: parsed };
  }

  private async pbxRequest<S extends z.ZodTypeAny>(
    iTenantId: number,
    parts: string[],
    method: string,
    correlationId: string,
    schema: S,
    input?: unknown,
  ): Promise<z.infer<S>> {
    const path = `/v1/admin/pbx/${parts.map(encodeURIComponent).join('/')}?iTenantId=${iTenantId}`;
    let response: Response;
    try {
      response = await fetch(new URL(path, this.baseUrl), {
        method,
        redirect: 'error',
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        headers: {
          accept: 'application/json',
          'x-aida-correlation-id': correlationId,
          ...(input === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(input === undefined ? {} : { body: JSON.stringify(input) }),
      });
    } catch {
      throw new OfficePulseError('OfficePulse could not be reached', 503);
    }
    if (!response.ok) {
      // Never retain an upstream error body: it may contain secrets or SQL.
      await response.body?.cancel().catch(() => {});
      throw new OfficePulseError('OfficePulse PBX request failed', response.status);
    }
    if (response.status === 204) return schema.parse(undefined) as z.infer<S>;
    const body: unknown = await response.json().catch(() => null);
    const parsed = schema.safeParse(body);
    if (!parsed.success)
      throw new OfficePulseError('OfficePulse returned an invalid PBX response', 502);
    if (
      parsed.data &&
      typeof parsed.data === 'object' &&
      'iTenantId' in parsed.data &&
      parsed.data.iTenantId !== iTenantId
    ) {
      throw new OfficePulseError('OfficePulse returned an invalid tenant scope', 502);
    }
    return parsed.data;
  }
  listExtensions(id: number, cid: string) {
    return this.pbxRequest(id, ['extensions'], 'GET', cid, pbx.extensionInventory);
  }
  createExtension(id: number, input: pbx.CreateExtension, cid: string) {
    return this.pbxRequest(id, ['extensions'], 'POST', cid, pbx.extensionCreated, input);
  }
  deleteExtension(id: number, extension: string, cid: string) {
    return this.pbxRequest(id, ['extensions', extension], 'DELETE', cid, z.void());
  }
  listQueues(id: number, cid: string) {
    return this.pbxRequest(id, ['queues'], 'GET', cid, pbx.queueInventory);
  }
  createQueue(id: number, input: pbx.CreateQueue, cid: string) {
    return this.pbxRequest(id, ['queues'], 'POST', cid, pbx.queueCreated, input);
  }
  deleteQueue(id: number, queue: string, cid: string) {
    return this.pbxRequest(id, ['queues', queue], 'DELETE', cid, z.void());
  }
  putQueueMember(
    id: number,
    queue: string,
    extension: string,
    input: pbx.QueueMemberInput,
    cid: string,
  ) {
    return this.pbxRequest(
      id,
      ['queues', queue, 'extensions', extension],
      'PUT',
      cid,
      pbx.memberSaved,
      input,
    );
  }
  deleteQueueMember(id: number, queue: string, extension: string, cid: string) {
    return this.pbxRequest(id, ['queues', queue, 'extensions', extension], 'DELETE', cid, z.void());
  }
  listDids(id: number, cid: string) {
    return this.pbxRequest(id, ['dids'], 'GET', cid, pbx.didInventory);
  }
  putDid(id: number, did: string, input: pbx.DidSettings, cid: string) {
    return this.pbxRequest(id, ['dids', did], 'PUT', cid, pbx.managedDid, input);
  }
  deleteDid(id: number, did: string, cid: string) {
    return this.pbxRequest(id, ['dids', did], 'DELETE', cid, z.void());
  }

  async submitCallCommand(
    callSessionId: string,
    req: CallCommandRequest,
  ): Promise<UpstreamOutcome> {
    const outcome = await this.fetchJson(
      `/v1/admin/calls/${encodeURIComponent(callSessionId)}/commands`,
      'POST',
      req,
    );
    if (outcome.status >= 500) {
      throw new OfficePulseError(
        'OfficePulse could not run the command',
        outcome.status,
        typeof outcome.body.error === 'string' ? outcome.body.error : undefined,
      );
    }
    return outcome;
  }

  async readiness(): Promise<OfficePulseReadiness> {
    try {
      // /readyz answers 200 when ready and 503 when a critical component is
      // down; both carry the same snapshot, so both are data here.
      const { body } = await this.fetchJson('/readyz', 'GET');
      const components = (body.components ?? {}) as Record<string, OfficePulseComponent>;
      return {
        reachable: true,
        ready: body.ready === true,
        fullyOperational: body.fullyOperational === true,
        components,
      };
    } catch {
      return UNREACHABLE;
    }
  }
}
