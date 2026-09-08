import type {
  CallCommandRequest,
  OfficePulseClient,
  OfficePulseReadiness,
  UpstreamOutcome,
} from '../../src/officepulse/client.js';
import { OfficePulseError } from '../../src/officepulse/client.js';

export class FakeOfficePulse implements OfficePulseClient {
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
