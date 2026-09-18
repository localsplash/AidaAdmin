import type {
  CallCommandRequest,
  DidScope,
  OfficePulseClient,
  OfficePulseReadiness,
  PbxScope,
  UpstreamOutcome,
} from '../../src/officepulse/client.js';
import { OfficePulseError } from '../../src/officepulse/client.js';
import type * as pbx from '../../src/officepulse/pbx-contract.js';

export const FAKE_PBX_INSTANCE = 'officepulse-test';

/** Context-scoped native API fake; captured requests never include returned credentials. */
export class FakeOfficePulse implements OfficePulseClient {
  requests: Array<{
    method: string;
    context?: string;
    didContext?: string;
    object?: string;
    body?: unknown;
    correlationId: string;
  }> = [];
  pbxInstanceId = FAKE_PBX_INSTANCE;
  /** Inventory keyed by the owning extension context. */
  extensions = new Map<string, pbx.ExtensionInventory['extensions']>();
  queues = new Map<string, pbx.QueueInventory['queues']>();
  dids = new Map<string, pbx.DidInventory['dids']>();
  /** Extra contexts present on the instance beyond those with inventory. */
  knownContexts: string[] = [];
  commands: Array<{ callSessionId: string; body: CallCommandRequest }> = [];
  readinessProbes = 0;
  commandOutcome: UpstreamOutcome = { status: 202, body: { status: 'ringing' } };
  readinessSnapshot: OfficePulseReadiness = {
    reachable: true,
    ready: true,
    fullyOperational: true,
    components: { ari: { ready: true, criticality: 'critical' } },
    pbxInstanceId: FAKE_PBX_INSTANCE,
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
    scope: PbxScope | undefined,
    correlationId: string,
    object?: string,
    body?: unknown,
  ) {
    this.check();
    this.requests.push({
      method,
      correlationId,
      ...(scope === undefined ? {} : { context: scope.context }),
      ...(scope?.didContext === undefined ? {} : { didContext: scope.didContext }),
      ...(object === undefined ? {} : { object }),
      ...(body === undefined ? {} : { body }),
    });
  }
  private inventory(scope: PbxScope) {
    return {
      source: 'asterisk' as const,
      pbxInstanceId: this.pbxInstanceId,
      context: scope.context,
      provisioningEnabled: this.provisioningEnabled,
    };
  }
  async listContexts(cid: string): Promise<pbx.ContextInventory> {
    this.record('context.list', undefined, cid);
    const contexts = new Set([
      ...this.knownContexts,
      ...this.extensions.keys(),
      ...this.queues.keys(),
      ...this.dids.keys(),
    ]);
    return {
      source: 'asterisk',
      pbxInstanceId: this.pbxInstanceId,
      contexts: [...contexts].sort(),
    };
  }
  async listExtensions(scope: PbxScope, cid: string): Promise<pbx.ExtensionInventory> {
    this.record('extension.list', scope, cid);
    return {
      ...this.inventory(scope),
      contexts: [scope.context],
      extensions: this.extensions.get(scope.context) ?? [],
    };
  }
  async createExtension(
    scope: PbxScope,
    body: pbx.CreateExtension,
    cid: string,
  ): Promise<pbx.ExtensionCreated> {
    this.record('extension.create', scope, cid, body.extension, body);
    if (body.context !== undefined && body.context !== scope.context)
      throw new OfficePulseError('context mismatch', 422);
    const records = this.extensions.get(scope.context) ?? [];
    if (records.some((row) => row.extension === body.extension))
      throw new OfficePulseError('duplicate', 409);
    const sipUsername = `${body.extension}-${scope.context}`;
    records.push({
      id: sipUsername,
      extension: body.extension,
      context: scope.context,
      callerId: body.displayName ?? null,
      transport: 'transport-udp',
      aors: sipUsername,
      managed: true,
      applyState: 'unknown',
    });
    this.extensions.set(scope.context, records);
    return {
      extension: body.extension,
      sipUsername,
      sipSecret: 'one-time-sip-secret',
      applyState: 'committed',
    };
  }
  async deleteExtension(scope: PbxScope, extension: string, cid: string) {
    this.record('extension.delete', scope, cid, extension);
    const rows = this.extensions.get(scope.context) ?? [];
    if (!rows.some((row) => row.extension === extension))
      throw new OfficePulseError('not found', 404);
    this.extensions.set(
      scope.context,
      rows.filter((row) => row.extension !== extension),
    );
  }
  async listQueues(scope: PbxScope, cid: string): Promise<pbx.QueueInventory> {
    this.record('queue.list', scope, cid);
    return { ...this.inventory(scope), queues: this.queues.get(scope.context) ?? [] };
  }
  async createQueue(
    scope: PbxScope,
    body: pbx.CreateQueue,
    cid: string,
  ): Promise<pbx.QueueCreated> {
    this.record('queue.create', scope, cid, body.name, body);
    const name = `${scope.context}.${body.name}`;
    const strategy = body.strategy ?? 'ringall';
    const rows = this.queues.get(scope.context) ?? [];
    rows.push({ id: name, name, strategy, members: [], applyState: 'unknown' });
    this.queues.set(scope.context, rows);
    return { name, strategy, applyState: 'committed' };
  }
  async deleteQueue(scope: PbxScope, queue: string, cid: string) {
    this.record('queue.delete', scope, cid, queue);
    if (!(this.queues.get(scope.context) ?? []).some((row) => row.name === queue))
      throw new OfficePulseError('not found', 404);
    this.queues.set(
      scope.context,
      this.queues.get(scope.context)!.filter((row) => row.name !== queue),
    );
  }
  async putQueueMember(
    scope: PbxScope,
    queue: string,
    extension: string,
    body: pbx.QueueMemberInput,
    cid: string,
  ): Promise<pbx.MemberSaved> {
    this.record('member.save', scope, cid, `${queue}/${extension}`, body);
    if (!(this.queues.get(scope.context) ?? []).some((row) => row.name === queue))
      throw new OfficePulseError('not found', 404);
    return {
      queue,
      extension,
      penalty: body.penalty ?? 0,
      paused: body.paused ?? false,
      applyState: 'committed',
    };
  }
  async deleteQueueMember(scope: PbxScope, queue: string, extension: string, cid: string) {
    this.record('member.delete', scope, cid, `${queue}/${extension}`);
    if (!(this.queues.get(scope.context) ?? []).some((row) => row.name === queue))
      throw new OfficePulseError('not found', 404);
  }
  async listDids(
    scope: DidScope,
    cid: string,
    authorizedDids: readonly string[] = [],
  ): Promise<pbx.DidInventory> {
    this.record('did.list', scope, cid, undefined, { authorizedDids });
    const stored = this.dids.get(scope.context) ?? [];
    return {
      ...this.inventory(scope),
      didContext: scope.didContext,
      dids: authorizedDids.map(
        (did) =>
          stored.find((route) => route.did === did) ?? {
            did,
            managed: false,
            availability: 'unconfigured',
            applyState: 'unknown',
          },
      ),
    };
  }
  async putDid(
    scope: DidScope,
    did: string,
    body: pbx.DidSettings,
    cid: string,
    authorizedDids: readonly string[] = [],
  ): Promise<pbx.ManagedDid> {
    this.record('did.save', scope, cid, did, { settings: body, authorizedDids });
    const result: pbx.ManagedDid = {
      ...body,
      did,
      managed: true,
      livekitDestination: body.livekitDestination ?? did,
      ringTimeoutSeconds: body.ringsBeforeAi * 5,
      applyState: 'committed',
    };
    this.dids.set(scope.context, [
      ...(this.dids.get(scope.context) ?? []).filter((row) => row.did !== did),
      result,
    ]);
    return result;
  }
  async deleteDid(
    scope: DidScope,
    did: string,
    cid: string,
    authorizedDids: readonly string[] = [],
  ) {
    this.record('did.delete', scope, cid, did, { authorizedDids });
    this.dids.set(
      scope.context,
      (this.dids.get(scope.context) ?? []).map((row) =>
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
