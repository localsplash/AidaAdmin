/** Server-only client for the canonical native PBX and call-control API. */
import { z } from 'zod';
import * as pbx from './pbx-contract.js';
import * as handsets from './handset-contract.js';
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
  /** OFFICEPULSE_INSTANCE_ID of the serving PBX instance, when it reported one. */
  pbxInstanceId?: string;
  environmentName?: string;
}

/**
 * The PBX scope a request acts in: one extension context on the serving
 * instance, plus the carrier ingress context for managed DID operations.
 * The customer tenant is never sent — AidaAdmin authorizes it beforehand.
 */
export interface PbxScope {
  context: string;
  didContext?: string | undefined;
}
export type DidScope = PbxScope & { didContext: string };

export interface OfficePulseClient {
  listHandsets(scope: PbxScope, correlationId: string): Promise<handsets.HandsetInventory>;
  revokeHandset(scope: PbxScope, deviceId: string, correlationId: string): Promise<void>;
  listContexts(correlationId: string): Promise<pbx.ContextInventory>;
  listExtensions(scope: PbxScope, correlationId: string): Promise<pbx.ExtensionInventory>;
  createExtension(
    scope: PbxScope,
    input: pbx.CreateExtension,
    correlationId: string,
  ): Promise<pbx.ExtensionCreated>;
  deleteExtension(scope: PbxScope, extension: string, correlationId: string): Promise<void>;
  listQueues(scope: PbxScope, correlationId: string): Promise<pbx.QueueInventory>;
  createQueue(
    scope: PbxScope,
    input: pbx.CreateQueue,
    correlationId: string,
  ): Promise<pbx.QueueCreated>;
  deleteQueue(scope: PbxScope, queue: string, correlationId: string): Promise<void>;
  putQueueMember(
    scope: PbxScope,
    queue: string,
    extension: string,
    input: pbx.QueueMemberInput,
    correlationId: string,
  ): Promise<pbx.MemberSaved>;
  deleteQueueMember(
    scope: PbxScope,
    queue: string,
    extension: string,
    correlationId: string,
  ): Promise<void>;
  listDids(
    scope: DidScope,
    correlationId: string,
    authorizedDids?: readonly string[],
  ): Promise<pbx.DidInventory>;
  putDid(
    scope: DidScope,
    did: string,
    input: pbx.DidSettings,
    correlationId: string,
    authorizedDids?: readonly string[],
  ): Promise<pbx.ManagedDid>;
  deleteDid(
    scope: DidScope,
    did: string,
    correlationId: string,
    authorizedDids?: readonly string[],
  ): Promise<void>;
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

interface PbxRequest {
  root?: string;
  scope?: PbxScope | undefined;
  input?: unknown;
  authorizedDids?: readonly string[] | undefined;
}

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
    parts: string[],
    method: string,
    correlationId: string,
    schema: S,
    { scope, input, authorizedDids = [], root = '/v1/admin/pbx' }: PbxRequest = {},
  ): Promise<z.infer<S>> {
    const query = new URLSearchParams();
    if (scope) query.set('context', scope.context);
    if (scope?.didContext) query.set('didContext', scope.didContext);
    for (const did of authorizedDids) query.append('authorizedDid', did);
    const search = query.size > 0 ? `?${query}` : '';
    const path = `${root}/${parts.map(encodeURIComponent).join('/')}${search}`;
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
    // A missing pbxInstanceId fails the schema: an inventory that cannot name
    // its instance cannot be pinned to the scope this tenant administers.
    if (!parsed.success)
      throw new OfficePulseError('OfficePulse returned an invalid PBX response', 502);
    const data = parsed.data as Record<string, unknown> | undefined;
    if (
      scope &&
      data &&
      typeof data === 'object' &&
      (('context' in data && data.context !== scope.context) ||
        ('didContext' in data && data.didContext !== scope.didContext))
    ) {
      throw new OfficePulseError('OfficePulse returned an invalid PBX scope', 502);
    }
    return parsed.data;
  }
  listContexts(cid: string) {
    return this.pbxRequest(['contexts'], 'GET', cid, pbx.contextInventory);
  }
  async listHandsets(scope: PbxScope, cid: string) {
    const inventory = await this.pbxRequest(['handsets'], 'GET', cid, handsets.handsetInventory, {
      scope,
      root: '/v1/admin',
    });
    if (inventory.handsets.some((device) => device.context !== scope.context))
      throw new OfficePulseError('OfficePulse returned an invalid handset scope', 502);
    return inventory;
  }
  async revokeHandset(scope: PbxScope, deviceId: string, cid: string) {
    await this.pbxRequest(['handsets', deviceId], 'DELETE', cid, handsets.handsetRevoked, {
      scope,
      root: '/v1/admin',
    });
  }
  listExtensions(scope: PbxScope, cid: string) {
    return this.pbxRequest(['extensions'], 'GET', cid, pbx.extensionInventory, { scope });
  }
  createExtension(scope: PbxScope, input: pbx.CreateExtension, cid: string) {
    return this.pbxRequest(['extensions'], 'POST', cid, pbx.extensionCreated, { scope, input });
  }
  deleteExtension(scope: PbxScope, extension: string, cid: string) {
    return this.pbxRequest(['extensions', extension], 'DELETE', cid, z.void(), { scope });
  }
  listQueues(scope: PbxScope, cid: string) {
    return this.pbxRequest(['queues'], 'GET', cid, pbx.queueInventory, { scope });
  }
  createQueue(scope: PbxScope, input: pbx.CreateQueue, cid: string) {
    return this.pbxRequest(['queues'], 'POST', cid, pbx.queueCreated, { scope, input });
  }
  deleteQueue(scope: PbxScope, queue: string, cid: string) {
    return this.pbxRequest(['queues', queue], 'DELETE', cid, z.void(), { scope });
  }
  putQueueMember(
    scope: PbxScope,
    queue: string,
    extension: string,
    input: pbx.QueueMemberInput,
    cid: string,
  ) {
    return this.pbxRequest(
      ['queues', queue, 'extensions', extension],
      'PUT',
      cid,
      pbx.memberSaved,
      { scope, input },
    );
  }
  deleteQueueMember(scope: PbxScope, queue: string, extension: string, cid: string) {
    return this.pbxRequest(['queues', queue, 'extensions', extension], 'DELETE', cid, z.void(), {
      scope,
    });
  }
  listDids(scope: DidScope, cid: string, authorizedDids: readonly string[] = []) {
    return this.pbxRequest(['dids'], 'GET', cid, pbx.didInventory, { scope, authorizedDids });
  }
  putDid(
    scope: DidScope,
    did: string,
    input: pbx.DidSettings,
    cid: string,
    authorizedDids: readonly string[] = [],
  ) {
    return this.pbxRequest(['dids', did], 'PUT', cid, pbx.managedDid, {
      scope,
      input,
      authorizedDids,
    });
  }
  deleteDid(scope: DidScope, did: string, cid: string, authorizedDids: readonly string[] = []) {
    return this.pbxRequest(['dids', did], 'DELETE', cid, z.void(), { scope, authorizedDids });
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
      const instance = pbx.instanceId.safeParse(body.pbxInstanceId);
      return {
        reachable: true,
        ready: body.ready === true,
        fullyOperational: body.fullyOperational === true,
        components,
        ...(instance.success ? { pbxInstanceId: instance.data } : {}),
        ...(typeof body.environmentName === 'string' && body.environmentName.trim()
          ? { environmentName: body.environmentName.trim() }
          : {}),
      };
    } catch {
      return UNREACHABLE;
    }
  }
}
