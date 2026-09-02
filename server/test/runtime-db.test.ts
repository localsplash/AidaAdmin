import { describe, expect, it, vi, type Mock } from 'vitest';

const execute = vi.fn(async () => [[], []]);
const onConnection = vi.fn();
vi.mock('mysql2/promise', () => ({
  default: {
    createPool: vi.fn(() => ({ execute, pool: { on: onConnection }, end: vi.fn() })),
  },
}));

const { MysqlRuntimeReader, parseMysqlUrl, RuntimeDbError } =
  await import('../src/officepulse/runtime-db.js');

function statements(): Array<{ sql: string; params: unknown[] }> {
  return (execute as Mock).mock.calls.map(([sql, params]) => ({
    sql: String(sql),
    params: (params as unknown[]) ?? [],
  }));
}

describe('parseMysqlUrl', () => {
  it('reads every connection field from one URL', () => {
    expect(parseMysqlUrl('mysql://aidaadmin_ro:p%40ss@db.internal:3307/aida_officepulse')).toEqual({
      host: 'db.internal',
      port: 3307,
      user: 'aidaadmin_ro',
      password: 'p@ss',
      database: 'aida_officepulse',
    });
    expect(parseMysqlUrl('mysql://u:p@h/aida_officepulse').port).toBe(3306);
  });

  it('names the variable when the URL is unusable, never the value', () => {
    for (const bad of ['not a url', 'postgresql://u:p@h/db', 'mysql://u:p@h/']) {
      expect(() => parseMysqlUrl(bad)).toThrow(RuntimeDbError);
      expect(() => parseMysqlUrl(bad)).toThrow(/OFFICEPULSE_RUNTIME_DATABASE_URL/);
    }
  });
});

describe('MysqlRuntimeReader', () => {
  const reader = new MysqlRuntimeReader({
    host: 'h',
    port: 3306,
    user: 'aidaadmin_ro',
    password: 'p',
    database: 'aida_officepulse',
  });

  it('puts every pooled connection in READ ONLY mode', () => {
    expect(onConnection).toHaveBeenCalledWith('connection', expect.any(Function));
    const handler = (onConnection as Mock).mock.calls[0]![1] as (c: { query: Mock }) => void;
    const connection = { query: vi.fn() };
    handler(connection);
    expect(connection.query).toHaveBeenCalledWith('SET SESSION TRANSACTION READ ONLY');
  });

  it('issues nothing but SELECT statements, with user values as parameters', async () => {
    (execute as Mock).mockClear();
    await reader.listCallSessions({ state: 'active', tenantId: 'ten-1', limit: 10 });
    await reader.listCallSessions({ state: 'recent' });
    await reader.listCallSessions({ state: 'orphaned', tenantId: 'ten-1' });
    await reader.getCallSession("x'; DROP TABLE call_session; --", 'ten-1');
    await reader.listCallEvents('call-1', 4);
    await reader.listControlCommands('call-1');
    await reader.listParticipants('call-1');
    await reader.listWebhookDeliveries(20);
    await reader.listProvisioningOperations();
    await reader.listDependencyStatus();
    await reader.listDidFallbacks('ten-1');
    await reader.listFailedCommands(24, 'ten-1');
    await reader.listEventsOfType(['fallback', 'takeover-failed'], 24, 'ten-1');
    await reader.ping();

    const all = statements();
    expect(all.length).toBeGreaterThanOrEqual(14);
    for (const { sql } of all) {
      expect(sql.trimStart()).toMatch(/^SELECT /);
      expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE)\b/i);
    }
    // The hostile id travelled as a parameter, never spliced into SQL.
    const byId = all.find((s) => s.sql.includes('WHERE id = ?'))!;
    expect(byId.params).toEqual(["x'; DROP TABLE call_session; --", 'ten-1']);
    expect(byId.sql).not.toContain('DROP');
  });

  it('scopes by tenant when asked and not otherwise', async () => {
    (execute as Mock).mockClear();
    await reader.listCallSessions({ state: 'active', tenantId: 'ten-1' });
    await reader.listCallSessions({ state: 'active' });
    const [scoped, unscoped] = statements();
    expect(scoped!.sql).toContain('WHERE tenant_id = ?');
    expect(scoped!.params).toEqual(['ten-1']);
    expect(unscoped!.sql).not.toContain('tenant_id = ?');
    expect(unscoped!.params).toEqual([]);
  });

  it('clamps inlined limits to a sane integer', async () => {
    (execute as Mock).mockClear();
    await reader.listCallSessions({ state: 'all', limit: 99_999 });
    await reader.listCallSessions({ state: 'all', limit: -3 });
    await reader.listCallSessions({ state: 'all', limit: Number.NaN });
    const [huge, negative, nan] = statements();
    expect(huge!.sql).toMatch(/LIMIT 500$/);
    expect(negative!.sql).toMatch(/LIMIT 1$/);
    expect(nan!.sql).toMatch(/LIMIT 50$/);
  });

  it('maps rows onto the runtime view without leaking column names', async () => {
    (execute as Mock).mockResolvedValueOnce([
      [
        {
          id: 'call-1',
          asterisk_linked_id: 'l1',
          officepulse_instance_id: 'op',
          tenant_id: 'ten-1',
          did_e164: '+15105550100',
          caller_number: '+15105551234',
          config_did_route_id: 'r1',
          config_did_route_rev: 3,
          config_profile_id: 'p1',
          config_profile_rev: 2,
          config_tenant_rev: 1,
          room_name: 'aida-call-1',
          agent_participant_sid: null,
          destination_type: 'EXTENSION',
          destination_id: 'ext-1',
          disposition: 'SCREEN',
          state: 'screening',
          version: 2,
          created_at: new Date('2026-09-02T10:00:00Z'),
          ended_at: null,
        },
      ],
      [],
    ]);
    const session = await reader.getCallSession('call-1');
    expect(session).toEqual({
      id: 'call-1',
      asteriskLinkedId: 'l1',
      officePulseInstanceId: 'op',
      tenantId: 'ten-1',
      didE164: '+15105550100',
      callerNumber: '+15105551234',
      config: {
        didRouteId: 'r1',
        didRouteRevision: 3,
        profileId: 'p1',
        profileRevision: 2,
        tenantRevision: 1,
      },
      roomName: 'aida-call-1',
      agentParticipantSid: null,
      destinationType: 'EXTENSION',
      destinationId: 'ext-1',
      disposition: 'SCREEN',
      state: 'screening',
      version: 2,
      createdAt: '2026-09-02T10:00:00.000Z',
      endedAt: null,
    });
  });

  it('wraps driver failures without the SQL or connection details', async () => {
    (execute as Mock).mockRejectedValueOnce(
      Object.assign(new Error('Access denied for user aidaadmin_ro@10.0.0.5'), {
        code: 'ER_ACCESS_DENIED_ERROR',
      }),
    );
    await expect(reader.listDependencyStatus()).rejects.toThrow(RuntimeDbError);
    await expect(reader.listDependencyStatus()).resolves.toEqual([]);
    (execute as Mock).mockRejectedValueOnce(new Error('boom'));
    await expect(reader.listDependencyStatus()).rejects.not.toThrow(/aidaadmin_ro|10\.0\.0\.5/);
  });
});
