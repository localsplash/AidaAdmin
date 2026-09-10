import type {
  CallCommandRequest,
  OfficePulseClient,
  OfficePulseReadiness,
  UpstreamOutcome,
} from '../../src/officepulse/client.js';
import { OfficePulseError } from '../../src/officepulse/client.js';
import type * as pbx from '../../src/officepulse/pbx-contract.js';

/** Tenant-scoped native API fake; captured requests never include returned credentials. */
export class FakeOfficePulse implements OfficePulseClient {
  requests: Array<{
    method: string;
    tenantId: number;
    object?: string;
    body?: unknown;
    correlationId: string;
  }> = [];
  extensions = new Map<number, pbx.ExtensionInventory['extensions']>();
  queues = new Map<number, pbx.QueueInventory['queues']>();
  dids = new Map<number, pbx.DidInventory['dids']>();
  commands: Array<{ callSessionId: string; body: CallCommandRequest }> = [];
  readinessProbes = 0;
  commandOutcome: UpstreamOutcome = { status: 202, body: { status: 'ringing' } };
  readinessSnapshot: OfficePulseReadiness = {
    reachable: true,
    ready: true,
    fullyOperational: true,
    components: { ari: { ready: true, criticality: 'critical' } },
  };
  failNext: boolean | number = false;
  provisioningEnabled = true;
  private check() {
    if (this.failNext) {
      const status = typeof this.failNext === 'number' ? this.failNext : 503;
      this.failNext = false;
      throw new OfficePulseError('pbx down', status);
    }
  }
  private record(
    method: string,
    tenantId: number,
    correlationId: string,
    object?: string,
    body?: unknown,
  ) {
    this.check();
    this.requests.push({
      method,
      tenantId,
      correlationId,
      ...(object === undefined ? {} : { object }),
      ...(body === undefined ? {} : { body }),
    });
  }
  async listExtensions(iTenantId: number, cid: string): Promise<pbx.ExtensionInventory> {
    this.record('extension.list', iTenantId, cid);
    return {
      source: 'asterisk',
      iTenantId,
      provisioningEnabled: this.provisioningEnabled,
      contexts: ['office-main'],
      extensions: this.extensions.get(iTenantId) ?? [],
    };
  }
  async createExtension(
    id: number,
    body: pbx.CreateExtension,
    cid: string,
  ): Promise<pbx.ExtensionCreated> {
    this.record('extension.create', id, cid, body.extension, body);
    const records = this.extensions.get(id) ?? [];
    if (records.some((row) => row.extension === body.extension))
      throw new OfficePulseError('duplicate', 409);
    const sipUsername = `${body.extension}-t${id}`;
    records.push({
      id: sipUsername,
      extension: body.extension,
      context: body.context ?? 'office-main',
      callerId: body.displayName ?? null,
      transport: 'transport-udp',
      aors: sipUsername,
      applyState: 'unknown',
    });
    this.extensions.set(id, records);
    return {
      extension: body.extension,
      sipUsername,
      sipSecret: 'one-time-sip-secret',
      applyState: 'committed',
    };
  }
  async deleteExtension(id: number, extension: string, cid: string) {
    this.record('extension.delete', id, cid, extension);
    const rows = this.extensions.get(id) ?? [];
    if (!rows.some((row) => row.extension === extension))
      throw new OfficePulseError('not found', 404);
    this.extensions.set(
      id,
      rows.filter((row) => row.extension !== extension),
    );
  }
  async listQueues(iTenantId: number, cid: string): Promise<pbx.QueueInventory> {
    this.record('queue.list', iTenantId, cid);
    return {
      source: 'asterisk',
      iTenantId,
      provisioningEnabled: this.provisioningEnabled,
      queues: this.queues.get(iTenantId) ?? [],
    };
  }
  async createQueue(id: number, body: pbx.CreateQueue, cid: string): Promise<pbx.QueueCreated> {
    this.record('queue.create', id, cid, body.name, body);
    const name = `t${id}.${body.name}`;
    const strategy = body.strategy ?? 'ringall';
    const rows = this.queues.get(id) ?? [];
    rows.push({ id: name, name, strategy, members: [], applyState: 'unknown' });
    this.queues.set(id, rows);
    return { name, strategy, applyState: 'committed' };
  }
  async deleteQueue(id: number, queue: string, cid: string) {
    this.record('queue.delete', id, cid, queue);
    if (!(this.queues.get(id) ?? []).some((row) => row.name === queue))
      throw new OfficePulseError('not found', 404);
    this.queues.set(
      id,
      this.queues.get(id)!.filter((row) => row.name !== queue),
    );
  }
  async putQueueMember(
    id: number,
    queue: string,
    extension: string,
    body: pbx.QueueMemberInput,
    cid: string,
  ): Promise<pbx.MemberSaved> {
    this.record('member.save', id, cid, `${queue}/${extension}`, body);
    if (!(this.queues.get(id) ?? []).some((row) => row.name === queue))
      throw new OfficePulseError('not found', 404);
    return {
      queue,
      extension,
      penalty: body.penalty ?? 0,
      paused: body.paused ?? false,
      applyState: 'committed',
    };
  }
  async deleteQueueMember(id: number, queue: string, extension: string, cid: string) {
    this.record('member.delete', id, cid, `${queue}/${extension}`);
    if (!(this.queues.get(id) ?? []).some((row) => row.name === queue))
      throw new OfficePulseError('not found', 404);
  }
  async listDids(iTenantId: number, cid: string): Promise<pbx.DidInventory> {
    this.record('did.list', iTenantId, cid);
    return {
      source: 'asterisk',
      iTenantId,
      provisioningEnabled: this.provisioningEnabled,
      dids: this.dids.get(iTenantId) ?? [],
    };
  }
  async putDid(
    id: number,
    did: string,
    body: pbx.DidSettings,
    cid: string,
  ): Promise<pbx.ManagedDid> {
    this.record('did.save', id, cid, did, body);
    const result: pbx.ManagedDid = {
      ...body,
      did,
      managed: true,
      livekitDestination: body.livekitDestination ?? did,
      ringTimeoutSeconds: body.ringsBeforeAi * 5,
      applyState: 'committed',
    };
    this.dids.set(id, [...(this.dids.get(id) ?? []).filter((row) => row.did !== did), result]);
    return result;
  }
  async deleteDid(id: number, did: string, cid: string) {
    this.record('did.delete', id, cid, did);
    this.dids.set(
      id,
      (this.dids.get(id) ?? []).map((row) =>
        row.did === did
          ? { did, managed: false, availability: 'unconfigured', applyState: 'unknown' }
          : row,
      ),
    );
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
