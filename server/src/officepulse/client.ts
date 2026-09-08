import { z } from 'zod';

/** Private OfficePulse inventory, readiness and audited call-command API. */
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

const pbxExtensionSchema = z.object({
  id: z.string(),
  context: z.string(),
  callerId: z.string().nullable(),
  transport: z.string().nullable(),
  aors: z.string().nullable(),
});
const pbxQueueSchema = z.object({
  id: z.string(),
  name: z.string(),
  strategy: z.string().nullable(),
  members: z.array(
    z.object({
      interface: z.string(),
      memberName: z.string().nullable(),
      penalty: z.number(),
      paused: z.boolean(),
    }),
  ),
});
export type PbxExtension = z.infer<typeof pbxExtensionSchema>;
export type PbxQueue = z.infer<typeof pbxQueueSchema>;

export interface OfficePulseClient {
  listPbxExtensions?(
    iTenantId: number,
  ): Promise<{ source: 'asterisk'; iTenantId: number; extensions: PbxExtension[] }>;
  listPbxQueues?(
    iTenantId: number,
  ): Promise<{ source: 'asterisk'; iTenantId: number; queues: PbxQueue[] }>;
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
    method: 'GET' | 'POST' = 'GET',
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

  private async request(path: string): Promise<unknown> {
    const { status, body: parsed } = await this.fetchJson(path);
    if (status < 200 || status >= 300) {
      throw new OfficePulseError(
        `OfficePulse ${path.split('?')[0]} failed`,
        status,
        typeof parsed.error === 'string' ? parsed.error : undefined,
      );
    }
    return parsed;
  }

  async listPbxExtensions(iTenantId: number) {
    const body = await this.request(`/v1/admin/pbx/extensions?iTenantId=${iTenantId}`);
    return z
      .object({
        source: z.literal('asterisk'),
        iTenantId: z.literal(iTenantId),
        extensions: z.array(pbxExtensionSchema),
      })
      .parse(body);
  }

  async listPbxQueues(iTenantId: number) {
    const body = await this.request(`/v1/admin/pbx/queues?iTenantId=${iTenantId}`);
    return z
      .object({
        source: z.literal('asterisk'),
        iTenantId: z.literal(iTenantId),
        queues: z.array(pbxQueueSchema),
      })
      .parse(body);
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
    const unavailable =
      outcome.status === 503 &&
      ['native_destination_unavailable', 'voice_unavailable'].includes(String(outcome.body.error));
    if (outcome.status >= 500 && !unavailable) {
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
      const { body } = await this.fetchJson('/readyz');
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
