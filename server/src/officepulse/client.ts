/**
 * Private-LAN OfficePulseAidaIntegration provisioning API (normative
 * specification §2.3). Only AidaAdmin's server calls it. OfficePulse
 * generates SIP secrets, stores them solely in Asterisk's ps_auths, and
 * returns a new secret exactly once — AidaAdmin never persists it.
 */

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
  sipUsername: string;
  /** Returned once; displayed once; never stored. */
  sipSecret: string;
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
  sipSecret: string;
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

export interface ProvisionDidRequest {
  didE164: string;
  context: string;
  fastAgiPath: '/bootstrap';
  enabled: boolean;
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
}

export class OfficePulseError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export class HttpOfficePulseClient implements OfficePulseClient {
  constructor(private readonly baseUrl: string) {}

  private async request(path: string, method: string, body: unknown): Promise<unknown> {
    const res = await fetch(new URL(path, this.baseUrl), {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new OfficePulseError(`OfficePulse provisioning ${path} failed`, res.status);
    }
    return res.status === 204 ? null : res.json();
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
}
