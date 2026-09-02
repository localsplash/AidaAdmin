import type {
  CallListFilter,
  RuntimeCallEvent,
  RuntimeCallSession,
  RuntimeControlCommand,
  RuntimeDependencyStatus,
  RuntimeDidFallback,
  RuntimeParticipant,
  RuntimeProvisioningOperation,
  RuntimeReader,
  RuntimeWebhookDelivery,
} from '../../src/officepulse/runtime-db.js';
import { ORPHAN_HORIZON_HOURS, RuntimeDbError } from '../../src/officepulse/runtime-db.js';

const HOUR_MS = 60 * 60 * 1000;

/**
 * In-memory stand-in for the read-only `aida_officepulse` view. Tests seed
 * the public arrays directly; the query semantics (active/recent/orphaned,
 * tenant scoping) mirror the SQL in MysqlRuntimeReader.
 */
export class FakeRuntimeReader implements RuntimeReader {
  sessions: RuntimeCallSession[] = [];
  events = new Map<string, RuntimeCallEvent[]>();
  commands = new Map<string, RuntimeControlCommand[]>();
  participants = new Map<string, RuntimeParticipant[]>();
  webhooks: RuntimeWebhookDelivery[] = [];
  provisioning: RuntimeProvisioningOperation[] = [];
  dependencies: RuntimeDependencyStatus[] = [];
  fallbacks: RuntimeDidFallback[] = [];
  /** When set, every read throws — the database is unreachable. */
  down = false;
  now = () => Date.now();

  private guard(): void {
    if (this.down) throw new RuntimeDbError('aida_officepulse read failed (ECONNREFUSED)');
  }

  async listCallSessions(filter: CallListFilter): Promise<RuntimeCallSession[]> {
    this.guard();
    const horizon = this.now() - ORPHAN_HORIZON_HOURS * HOUR_MS;
    return this.sessions
      .filter((s) => filter.tenantId === undefined || s.tenantId === filter.tenantId)
      .filter((s) => {
        const started = Date.parse(s.createdAt);
        switch (filter.state) {
          case 'active':
            return s.endedAt === null && started >= horizon;
          case 'orphaned':
            return s.endedAt === null && started < horizon;
          case 'recent':
            return s.endedAt !== null;
          case 'all':
            return true;
        }
      })
      .slice(0, filter.limit ?? 50);
  }

  async getCallSession(
    callSessionId: string,
    tenantId?: string,
  ): Promise<RuntimeCallSession | null> {
    this.guard();
    const found = this.sessions.find((s) => s.id === callSessionId);
    if (!found) return null;
    if (tenantId !== undefined && found.tenantId !== tenantId) return null;
    return found;
  }

  async listCallEvents(callSessionId: string, sinceSequence = 0): Promise<RuntimeCallEvent[]> {
    this.guard();
    return (this.events.get(callSessionId) ?? []).filter((e) => e.sequenceNumber > sinceSequence);
  }

  async listControlCommands(callSessionId: string): Promise<RuntimeControlCommand[]> {
    this.guard();
    return this.commands.get(callSessionId) ?? [];
  }

  async listParticipants(callSessionId: string): Promise<RuntimeParticipant[]> {
    this.guard();
    return this.participants.get(callSessionId) ?? [];
  }

  async listWebhookDeliveries(limit = 100): Promise<RuntimeWebhookDelivery[]> {
    this.guard();
    return this.webhooks.slice(0, limit);
  }

  async listProvisioningOperations(limit = 100): Promise<RuntimeProvisioningOperation[]> {
    this.guard();
    return this.provisioning.slice(0, limit);
  }

  async listDependencyStatus(): Promise<RuntimeDependencyStatus[]> {
    this.guard();
    return this.dependencies;
  }

  async listDidFallbacks(tenantId?: string): Promise<RuntimeDidFallback[]> {
    this.guard();
    return this.fallbacks.filter((f) => tenantId === undefined || f.tenantId === tenantId);
  }

  async listFailedCommands(_sinceHours: number, tenantId?: string) {
    this.guard();
    const out: Array<RuntimeControlCommand & { callSessionId: string; tenantId: string }> = [];
    for (const [callSessionId, commands] of this.commands) {
      const session = this.sessions.find((s) => s.id === callSessionId);
      if (!session) continue;
      if (tenantId !== undefined && session.tenantId !== tenantId) continue;
      for (const command of commands) {
        if (command.status === 'failed') {
          out.push({ ...command, callSessionId, tenantId: session.tenantId });
        }
      }
    }
    return out;
  }

  async listEventsOfType(eventTypes: string[], _sinceHours: number, tenantId?: string) {
    this.guard();
    const wanted = new Set(eventTypes);
    const out: Array<RuntimeCallEvent & { callSessionId: string; tenantId: string }> = [];
    for (const [callSessionId, events] of this.events) {
      const session = this.sessions.find((s) => s.id === callSessionId);
      if (!session) continue;
      if (tenantId !== undefined && session.tenantId !== tenantId) continue;
      for (const event of events) {
        if (wanted.has(event.eventType)) {
          out.push({ ...event, callSessionId, tenantId: session.tenantId });
        }
      }
    }
    return out;
  }

  async ping(): Promise<boolean> {
    return !this.down;
  }
}

/** A minimal, consistent call session for tests. */
export function fakeSession(overrides: Partial<RuntimeCallSession> = {}): RuntimeCallSession {
  return {
    id: 'call-1',
    asteriskLinkedId: 'linked-1',
    officePulseInstanceId: 'op-1',
    tenantId: 'ten-1',
    didE164: '+15105550100',
    callerNumber: '+15105551234',
    config: {
      didRouteId: 'route-1',
      didRouteRevision: 3,
      profileId: 'profile-1',
      profileRevision: 2,
      tenantRevision: 1,
    },
    roomName: 'aida-call-1',
    agentParticipantSid: null,
    destinationType: 'EXTENSION',
    destinationId: 'ext-1',
    disposition: 'SCREEN',
    state: 'screening',
    version: 1,
    createdAt: new Date().toISOString(),
    endedAt: null,
    ...overrides,
  };
}
