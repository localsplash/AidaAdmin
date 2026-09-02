import type {
  CallCommandRequest,
  OfficePulseClient,
  OfficePulseReadiness,
  ProvisionDidRequest,
  ProvisionExtensionRequest,
  ProvisionRingGroupRequest,
  UpdateExtensionRequest,
  UpstreamOutcome,
} from '../../src/officepulse/client.js';
import { OfficePulseError } from '../../src/officepulse/client.js';

/** Records every call to OfficePulse's private API; never touches a network. */
export class FakeOfficePulse implements OfficePulseClient {
  provisioned: ProvisionExtensionRequest[] = [];
  updated: Array<{ extensionId: string; body: UpdateExtensionRequest }> = [];
  ringGroups: Array<{ ringGroupId: string; body: ProvisionRingGroupRequest }> = [];
  dids: Array<{ didRouteId: string; body: ProvisionDidRequest }> = [];
  commands: Array<{ callSessionId: string; body: CallCommandRequest }> = [];
  readinessProbes = 0;
  /** What the next call command answers with. */
  commandOutcome: UpstreamOutcome = { status: 202, body: { status: 'ringing' } };
  readinessSnapshot: OfficePulseReadiness = {
    reachable: true,
    ready: true,
    fullyOperational: true,
    components: { ari: { ready: true, criticality: 'critical' } },
  };
  failNext = false;

  private check() {
    if (this.failNext) {
      this.failNext = false;
      throw new OfficePulseError('pbx down', 503);
    }
  }

  async provisionExtension(req: ProvisionExtensionRequest) {
    this.check();
    this.provisioned.push(req);
    return { sipUsername: `sip-${req.extensionNumber}`, sipSecret: 'one-time-sip-secret' };
  }

  async updateProvisionedExtension(extensionId: string, body: UpdateExtensionRequest) {
    this.check();
    this.updated.push({ extensionId, body });
  }

  async rotateProvisionedExtensionSecret() {
    this.check();
    return { sipSecret: 'rotated-sip-secret' };
  }

  async provisionRingGroup(ringGroupId: string, body: ProvisionRingGroupRequest) {
    this.check();
    this.ringGroups.push({ ringGroupId, body });
  }

  async provisionDid(didRouteId: string, body: ProvisionDidRequest) {
    this.check();
    this.dids.push({ didRouteId, body });
  }

  async submitCallCommand(callSessionId: string, body: CallCommandRequest) {
    this.check();
    this.commands.push({ callSessionId, body });
    return this.commandOutcome;
  }

  async readiness() {
    this.readinessProbes += 1;
    return this.readinessSnapshot;
  }
}
