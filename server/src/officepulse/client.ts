/**
 * OfficePulseAidaIntegration's private-LAN HTTP API (its issue #9): the
 * provisioning routes AidaAdmin has always used, plus the call-control and
 * readiness routes that AidaControl used to front. Only AidaAdmin's server
 * calls it, from an address inside OfficePulse's TRUSTED_SERVER_CIDRS.
 *
 * OfficePulse generates SIP secrets, stores them solely in Asterisk's
 * ps_auths, and returns a new secret exactly once — AidaAdmin never persists
 * it, and a replayed create or rotation is answered "already applied", never
 * with the existing secret.
 */

const UPSTREAM_TIMEOUT_MS = 10_000;

export interface ProvisionExtensionRequest {
  requestId: string;
  tenantId: string;
  extensionId: string;
  extensionNumber: string;
  context: string;
  displayName: string;
  callerIdName?: string | null;
  callerIdNumber?: string | null;
  provisioningProfile?: string | null;
}

export interface ProvisionExtensionResult {
  status?: 'created' | 'already-applied';
  sipUsername: string;
  /** Returned once; displayed once; never stored. Absent on a replay. */
  sipSecret?: string;
  provisioningResult?: unknown;
}

export interface UpdateExtensionRequest {
  extensionNumber: string;
  context: string;
  displayName: string;
  callerIdName?: string | null;
  callerIdNumber?: string | null;
  provisioningProfile?: string | null;
  enabled: boolean;
}

export interface RotateSecretResult {
  status?: 'rotated' | 'already-applied';
  /** Absent on a replay: recovering a lost response needs a new rotation. */
  sipSecret?: string;
  provisioningResult?: unknown;
}

export interface ProvisionRingGroupRequest {
  tenantId: string;
  virtualExtension: string;
  context: string;
  memberExtensions: string[];
  ringTimeoutSeconds: number;
  musicOnHoldClass?: string | null;
  callerIdName?: string | null;
  callerIdNumber?: string | null;
  enabled: boolean;
}

/**
 * The fail-safe fields (tenantId, destinationType, destinationId) are what
 * OfficePulse projects into `did_fallback`: without them a DID has no
 * destination of its own when NocoDB or LiveKit is unavailable.
 */
export interface ProvisionDidRequest {
  didE164: string;
  context: string;
  fastAgiPath: '/bootstrap';
  enabled: boolean;
  tenantId: string;
  destinationType: 'EXTENSION' | 'RING_GROUP';
  destinationId: string;
}

/** The one staff command OfficePulse acts on; DRAIN_ACK is the agent's. */
export interface CallCommandRequest {
  commandType: 'TAKEOVER';
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
  provisionExtension(req: ProvisionExtensionRequest): Promise<ProvisionExtensionResult>;
  updateProvisionedExtension(extensionId: string, req: UpdateExtensionRequest): Promise<void>;
  rotateProvisionedExtensionSecret(
    extensionId: string,
    requestId: string,
    reprovisionDevice: boolean,
  ): Promise<RotateSecretResult>;
  provisionRingGroup(ringGroupId: string, req: ProvisionRingGroupRequest): Promise<void>;
  provisionDid(didRouteId: string, req: ProvisionDidRequest): Promise<void>;
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

  private async request(path: string, method: string, body: unknown): Promise<unknown> {
    const { status, body: parsed } = await this.fetchJson(path, method, body);
    if (status < 200 || status >= 300) {
      throw new OfficePulseError(
        `OfficePulse ${path.split('?')[0]} failed`,
        status,
        typeof parsed.error === 'string' ? parsed.error : undefined,
      );
    }
    return parsed;
  }

  async provisionExtension(req: ProvisionExtensionRequest): Promise<ProvisionExtensionResult> {
    return (await this.request(
      '/v1/provisioning/extensions',
      'POST',
      req,
    )) as ProvisionExtensionResult;
  }

  async updateProvisionedExtension(
    extensionId: string,
    req: UpdateExtensionRequest,
  ): Promise<void> {
    await this.request(`/v1/provisioning/extensions/${extensionId}`, 'PUT', req);
  }

  async rotateProvisionedExtensionSecret(
    extensionId: string,
    requestId: string,
    reprovisionDevice: boolean,
  ): Promise<RotateSecretResult> {
    return (await this.request(`/v1/provisioning/extensions/${extensionId}/rotate-secret`, 'POST', {
      requestId,
      reprovisionDevice,
    })) as RotateSecretResult;
  }

  async provisionRingGroup(ringGroupId: string, req: ProvisionRingGroupRequest): Promise<void> {
    await this.request(`/v1/provisioning/ring-groups/${ringGroupId}`, 'PUT', req);
  }

  async provisionDid(didRouteId: string, req: ProvisionDidRequest): Promise<void> {
    await this.request(`/v1/provisioning/dids/${didRouteId}`, 'PUT', req);
  }

  async submitCallCommand(
    callSessionId: string,
    req: CallCommandRequest,
  ): Promise<UpstreamOutcome> {
    const outcome = await this.fetchJson(
      `/v1/calls/${encodeURIComponent(callSessionId)}/commands`,
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
