/**
 * Read-only view of OfficePulseAidaIntegration's `aida_officepulse` runtime
 * database (its issue #9; AidaAdmin issue #29).
 *
 * OfficePulse is the sole writer of that database. AidaAdmin connects as
 * the `aidaadmin_ro` account its `deploy/sql/grants.sql` creates — SELECT
 * on `aida_officepulse.*` and nothing else — so read-only is a property of
 * the grant, not of good behaviour here. Two further layers exist anyway:
 * every pooled connection is put in READ ONLY transaction mode, and this
 * module contains no statement that is not a SELECT (a test asserts it).
 *
 * Column names below are OfficePulse's, verbatim from its
 * `deploy/sql/runtime-schema.sql`; nothing is inferred.
 */

import mysql from 'mysql2/promise';

export type DestinationType = 'EXTENSION' | 'RING_GROUP';

export interface RuntimeCallSession {
  id: string;
  asteriskLinkedId: string;
  officePulseInstanceId: string;
  tenantId: string;
  didE164: string;
  callerNumber: string | null;
  /** The AidaAdmin ids and revisions this call actually used. */
  config: {
    didRouteId: string | null;
    didRouteRevision: number | null;
    profileId: string | null;
    profileRevision: number | null;
    tenantRevision: number | null;
  };
  roomName: string | null;
  agentParticipantSid: string | null;
  destinationType: DestinationType | null;
  destinationId: string | null;
  disposition: string;
  state: string;
  version: number;
  createdAt: string;
  endedAt: string | null;
}

export interface RuntimeCallEvent {
  sequenceNumber: number;
  eventType: string;
  payload: Record<string, unknown> | null;
  createdAt: string;
}

export interface RuntimeControlCommand {
  idempotencyKey: string;
  commandType: string;
  payload: Record<string, unknown> | null;
  status: string;
  result: Record<string, unknown> | null;
  createdAt: string;
  completedAt: string | null;
}

export interface RuntimeParticipant {
  participantSid: string;
  identity: string | null;
  kind: string;
  joinedAt: string;
  leftAt: string | null;
}

export interface RuntimeWebhookDelivery {
  source: string;
  deliveryId: string;
  eventType: string;
  callSessionId: string | null;
  receivedAt: string;
}

export interface RuntimeProvisioningOperation {
  requestId: string;
  kind: string;
  externalId: string;
  action: string;
  status: string;
  createdAt: string;
}

export interface RuntimeDependencyStatus {
  name: string;
  ready: boolean;
  detail: string | null;
  changedAt: string;
}

export interface RuntimeDidFallback {
  didRouteId: string;
  tenantId: string;
  didE164: string;
  destinationType: DestinationType;
  destinationId: string;
  enabled: boolean;
  updatedAt: string;
}

/**
 * Which calls: `active` has not ended and is younger than the orphan
 * horizon; `orphaned` has not ended but is older than it (OfficePulse or
 * Asterisk lost track of it); `recent` has ended, newest first.
 */
export type CallListState = 'active' | 'recent' | 'orphaned' | 'all';

export interface CallListFilter {
  state: CallListState;
  /** Omitted only by a Super Admin asking for every tenant. */
  tenantId?: string | undefined;
  limit?: number | undefined;
}

export interface RuntimeReader {
  listCallSessions(filter: CallListFilter): Promise<RuntimeCallSession[]>;
  /** Tenant-scoped when a tenantId is given: another tenant's id is "not found". */
  getCallSession(callSessionId: string, tenantId?: string): Promise<RuntimeCallSession | null>;
  listCallEvents(callSessionId: string, sinceSequence?: number): Promise<RuntimeCallEvent[]>;
  listControlCommands(callSessionId: string): Promise<RuntimeControlCommand[]>;
  listParticipants(callSessionId: string): Promise<RuntimeParticipant[]>;
  listWebhookDeliveries(limit?: number): Promise<RuntimeWebhookDelivery[]>;
  listProvisioningOperations(limit?: number): Promise<RuntimeProvisioningOperation[]>;
  listDependencyStatus(): Promise<RuntimeDependencyStatus[]>;
  listDidFallbacks(tenantId?: string): Promise<RuntimeDidFallback[]>;
  /** Failed control commands across calls, newest first, for the issues view. */
  listFailedCommands(
    sinceHours: number,
    tenantId?: string,
  ): Promise<Array<RuntimeControlCommand & { callSessionId: string; tenantId: string }>>;
  /** Events of the given types across calls, newest first, for the issues view. */
  listEventsOfType(
    eventTypes: string[],
    sinceHours: number,
    tenantId?: string,
  ): Promise<Array<RuntimeCallEvent & { callSessionId: string; tenantId: string }>>;
  ping(): Promise<boolean>;
}

export class RuntimeDbError extends Error {}

/** Calls without an end older than this are presumed lost, not live. */
export const ORPHAN_HORIZON_HOURS = 6;

export interface MysqlConnectionConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

/** `mysql://user:password@host:3306/aida_officepulse` → connection fields. */
export function parseMysqlUrl(url: string): MysqlConnectionConfig {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new RuntimeDbError('OFFICEPULSE_RUNTIME_DATABASE_URL is not a valid URL');
  }
  if (parsed.protocol !== 'mysql:') {
    throw new RuntimeDbError('OFFICEPULSE_RUNTIME_DATABASE_URL must start with mysql://');
  }
  const database = parsed.pathname.replace(/^\//, '');
  if (!parsed.hostname || !database) {
    throw new RuntimeDbError('OFFICEPULSE_RUNTIME_DATABASE_URL must name a host and a database');
  }
  return {
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 3306,
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database,
  };
}

/** A whole-number bound that is safe to inline into SQL. */
function clampInt(value: number | undefined, fallback: number, max: number): number {
  const n = Number.isFinite(value) ? Math.trunc(value as number) : fallback;
  return Math.min(Math.max(n, 1), max);
}

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return typeof value === 'string' ? value : '';
}

function isoOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return iso(value);
}

function json(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  return typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

type Row = Record<string, unknown>;
type Param = string | number | null;

function toSession(row: Row): RuntimeCallSession {
  return {
    id: String(row.id),
    asteriskLinkedId: String(row.asterisk_linked_id),
    officePulseInstanceId: String(row.officepulse_instance_id),
    tenantId: String(row.tenant_id),
    didE164: String(row.did_e164),
    callerNumber: (row.caller_number as string | null) ?? null,
    config: {
      didRouteId: (row.config_did_route_id as string | null) ?? null,
      didRouteRevision: (row.config_did_route_rev as number | null) ?? null,
      profileId: (row.config_profile_id as string | null) ?? null,
      profileRevision: (row.config_profile_rev as number | null) ?? null,
      tenantRevision: (row.config_tenant_rev as number | null) ?? null,
    },
    roomName: (row.room_name as string | null) ?? null,
    agentParticipantSid: (row.agent_participant_sid as string | null) ?? null,
    destinationType: (row.destination_type as DestinationType | null) ?? null,
    destinationId: (row.destination_id as string | null) ?? null,
    disposition: String(row.disposition),
    state: String(row.state),
    version: Number(row.version ?? 1),
    createdAt: iso(row.created_at),
    endedAt: isoOrNull(row.ended_at),
  };
}

const SESSION_COLUMNS =
  'id, asterisk_linked_id, officepulse_instance_id, tenant_id, did_e164, caller_number, ' +
  'config_did_route_id, config_did_route_rev, config_profile_id, config_profile_rev, ' +
  'config_tenant_rev, room_name, agent_participant_sid, destination_type, destination_id, ' +
  'disposition, state, version, created_at, ended_at';

/**
 * Executes SELECTs only. Limits and horizons are inlined after clamping to
 * a small integer because MySQL prepared statements do not bind LIMIT
 * reliably across server versions; every user-supplied value goes through
 * a parameter.
 */
export class MysqlRuntimeReader implements RuntimeReader {
  private readonly pool: mysql.Pool;

  constructor(config: MysqlConnectionConfig) {
    this.pool = mysql.createPool({
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      database: config.database,
      connectionLimit: 5,
      timezone: 'Z',
    });
    // Belt over the grant's braces: even a mis-granted account cannot write
    // through a connection this process opened.
    this.pool.pool.on('connection', (connection) => {
      connection.query('SET SESSION TRANSACTION READ ONLY');
    });
  }

  private async select(sql: string, params: Param[] = []): Promise<Row[]> {
    try {
      const [rows] = await this.pool.execute(sql, params);
      return rows as Row[];
    } catch (err) {
      // Never surface the SQL or the connection string.
      throw new RuntimeDbError(
        `aida_officepulse read failed (${(err as { code?: string }).code ?? 'unknown'})`,
      );
    }
  }

  async listCallSessions(filter: CallListFilter): Promise<RuntimeCallSession[]> {
    const limit = clampInt(filter.limit, 50, 500);
    const horizon = ORPHAN_HORIZON_HOURS;
    const where: string[] = [];
    const params: Param[] = [];
    if (filter.tenantId !== undefined) {
      where.push('tenant_id = ?');
      params.push(filter.tenantId);
    }
    let order = 'created_at DESC';
    switch (filter.state) {
      case 'active':
        where.push(`ended_at IS NULL AND created_at >= NOW() - INTERVAL ${horizon} HOUR`);
        break;
      case 'orphaned':
        where.push(`ended_at IS NULL AND created_at < NOW() - INTERVAL ${horizon} HOUR`);
        break;
      case 'recent':
        where.push('ended_at IS NOT NULL');
        order = 'ended_at DESC';
        break;
      case 'all':
        break;
    }
    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const rows = await this.select(
      `SELECT ${SESSION_COLUMNS} FROM call_session ${clause} ORDER BY ${order} LIMIT ${limit}`,
      params,
    );
    return rows.map(toSession);
  }

  async getCallSession(
    callSessionId: string,
    tenantId?: string,
  ): Promise<RuntimeCallSession | null> {
    const params: Param[] = [callSessionId];
    let clause = 'WHERE id = ?';
    if (tenantId !== undefined) {
      clause += ' AND tenant_id = ?';
      params.push(tenantId);
    }
    const rows = await this.select(`SELECT ${SESSION_COLUMNS} FROM call_session ${clause}`, params);
    return rows[0] ? toSession(rows[0]) : null;
  }

  async listCallEvents(callSessionId: string, sinceSequence = 0): Promise<RuntimeCallEvent[]> {
    const rows = await this.select(
      'SELECT sequence_number, event_type, payload, created_at FROM call_event ' +
        'WHERE call_session_id = ? AND sequence_number > ? ORDER BY sequence_number',
      [callSessionId, sinceSequence],
    );
    return rows.map((row) => ({
      sequenceNumber: Number(row.sequence_number),
      eventType: String(row.event_type),
      payload: json(row.payload),
      createdAt: iso(row.created_at),
    }));
  }

  async listControlCommands(callSessionId: string): Promise<RuntimeControlCommand[]> {
    const rows = await this.select(
      'SELECT idempotency_key, command_type, payload, status, result, created_at, completed_at ' +
        'FROM control_command WHERE call_session_id = ? ORDER BY created_at',
      [callSessionId],
    );
    return rows.map(toCommand);
  }

  async listParticipants(callSessionId: string): Promise<RuntimeParticipant[]> {
    const rows = await this.select(
      'SELECT participant_sid, identity, kind, joined_at, left_at FROM livekit_participant ' +
        'WHERE call_session_id = ? ORDER BY joined_at',
      [callSessionId],
    );
    return rows.map((row) => ({
      participantSid: String(row.participant_sid),
      identity: (row.identity as string | null) ?? null,
      kind: String(row.kind),
      joinedAt: iso(row.joined_at),
      leftAt: isoOrNull(row.left_at),
    }));
  }

  async listWebhookDeliveries(limit?: number): Promise<RuntimeWebhookDelivery[]> {
    const rows = await this.select(
      'SELECT source, delivery_id, event_type, call_session_id, received_at FROM webhook_delivery ' +
        `ORDER BY received_at DESC LIMIT ${clampInt(limit, 100, 500)}`,
    );
    return rows.map((row) => ({
      source: String(row.source),
      deliveryId: String(row.delivery_id),
      eventType: String(row.event_type),
      callSessionId: (row.call_session_id as string | null) ?? null,
      receivedAt: iso(row.received_at),
    }));
  }

  async listProvisioningOperations(limit?: number): Promise<RuntimeProvisioningOperation[]> {
    const rows = await this.select(
      'SELECT request_id, kind, external_id, action, status, created_at FROM provisioning_operation ' +
        `ORDER BY created_at DESC LIMIT ${clampInt(limit, 100, 500)}`,
    );
    return rows.map((row) => ({
      requestId: String(row.request_id),
      kind: String(row.kind),
      externalId: String(row.external_id),
      action: String(row.action),
      status: String(row.status),
      createdAt: iso(row.created_at),
    }));
  }

  async listDependencyStatus(): Promise<RuntimeDependencyStatus[]> {
    const rows = await this.select(
      'SELECT name, ready, detail, changed_at FROM dependency_status ORDER BY name',
    );
    return rows.map((row) => ({
      name: String(row.name),
      ready: Number(row.ready) === 1,
      detail: (row.detail as string | null) ?? null,
      changedAt: iso(row.changed_at),
    }));
  }

  async listDidFallbacks(tenantId?: string): Promise<RuntimeDidFallback[]> {
    const params: Param[] = [];
    let clause = '';
    if (tenantId !== undefined) {
      clause = 'WHERE tenant_id = ?';
      params.push(tenantId);
    }
    const rows = await this.select(
      'SELECT did_route_id, tenant_id, did_e164, destination_type, destination_id, enabled, updated_at ' +
        `FROM did_fallback ${clause} ORDER BY did_e164`,
      params,
    );
    return rows.map((row) => ({
      didRouteId: String(row.did_route_id),
      tenantId: String(row.tenant_id),
      didE164: String(row.did_e164),
      destinationType: String(row.destination_type) as DestinationType,
      destinationId: String(row.destination_id),
      enabled: Number(row.enabled) === 1,
      updatedAt: iso(row.updated_at),
    }));
  }

  async listFailedCommands(sinceHours: number, tenantId?: string) {
    const params: Param[] = [];
    let tenantClause = '';
    if (tenantId !== undefined) {
      tenantClause = 'AND s.tenant_id = ?';
      params.push(tenantId);
    }
    const rows = await this.select(
      'SELECT c.call_session_id, s.tenant_id, c.idempotency_key, c.command_type, c.payload, ' +
        'c.status, c.result, c.created_at, c.completed_at ' +
        'FROM control_command c JOIN call_session s ON s.id = c.call_session_id ' +
        `WHERE c.status = 'failed' AND c.created_at >= NOW() - INTERVAL ${clampInt(sinceHours, 24, 720)} HOUR ` +
        `${tenantClause} ORDER BY c.created_at DESC LIMIT 200`,
      params,
    );
    return rows.map((row) => ({
      ...toCommand(row),
      callSessionId: String(row.call_session_id),
      tenantId: String(row.tenant_id),
    }));
  }

  async listEventsOfType(eventTypes: string[], sinceHours: number, tenantId?: string) {
    if (eventTypes.length === 0) return [];
    const params: Param[] = [...eventTypes];
    let tenantClause = '';
    if (tenantId !== undefined) {
      tenantClause = 'AND s.tenant_id = ?';
      params.push(tenantId);
    }
    const placeholders = eventTypes.map(() => '?').join(', ');
    const rows = await this.select(
      'SELECT e.call_session_id, s.tenant_id, e.sequence_number, e.event_type, e.payload, e.created_at ' +
        'FROM call_event e JOIN call_session s ON s.id = e.call_session_id ' +
        `WHERE e.event_type IN (${placeholders}) AND e.created_at >= NOW() - INTERVAL ${clampInt(sinceHours, 24, 720)} HOUR ` +
        `${tenantClause} ORDER BY e.created_at DESC LIMIT 200`,
      params,
    );
    return rows.map((row) => ({
      sequenceNumber: Number(row.sequence_number),
      eventType: String(row.event_type),
      payload: json(row.payload),
      createdAt: iso(row.created_at),
      callSessionId: String(row.call_session_id),
      tenantId: String(row.tenant_id),
    }));
  }

  async ping(): Promise<boolean> {
    try {
      await this.pool.execute('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

function toCommand(row: Row): RuntimeControlCommand {
  return {
    idempotencyKey: String(row.idempotency_key),
    commandType: String(row.command_type),
    payload: json(row.payload),
    status: String(row.status),
    result: json(row.result),
    createdAt: iso(row.created_at),
    completedAt: isoOrNull(row.completed_at),
  };
}
