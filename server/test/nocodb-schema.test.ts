import { describe, expect, it, vi } from 'vitest';
import { AIDA_SCHEMA, reportDrift, upgradeSchema } from '../src/nocodb/schema.js';
import { NocoStore } from '../src/nocodb/repos.js';
import { FakeNocoDbApi } from './helpers/fake-nocodb.js';

describe('schema automation', () => {
  it('recognizes canonical API titles when NocoDB prefixes SQL table and column names', async () => {
    const api = new FakeNocoDbApi();
    await upgradeSchema(api);
    const tables = await api.listTables();
    const listColumns = api.listColumns.bind(api);
    vi.spyOn(api, 'listTables').mockResolvedValue(
      tables.map((table) => ({ ...table, table_name: `nc_preview___${table.table_name}` })),
    );
    vi.spyOn(api, 'listColumns').mockImplementation(async (tableId) => [
      { id: 'system-id', column_name: 'id', title: 'Id', uidt: 'ID' },
      {
        id: 'system-created',
        column_name: 'created_at',
        title: 'CreatedAt',
        uidt: 'CreatedTime',
        system: true,
      },
      ...(await listColumns(tableId)).map((column) => ({
        ...column,
        column_name: ['id', 'created_at', 'updated_at'].includes(column.column_name)
          ? `${column.column_name}1`
          : column.column_name,
      })),
    ]);
    expect((await reportDrift(api)).inSync).toBe(true);
    expect((await upgradeSchema(api)).createdTables).toEqual([]);
    const store = new NocoStore(api);
    const profile = await store.create('tenant_profile', {
      tenant_id: 1,
      asterisk_context: 'preview',
    });
    expect((await store.getById('tenant_profile', String(profile.id), '1')).tenant_id).toBe('1');
  });

  it('rejects ambiguous canonical table titles before changing the schema', async () => {
    const api = new FakeNocoDbApi();
    await upgradeSchema(api);
    await api.createTable({
      table_name: 'duplicate_voice_profile',
      title: 'aida_tbl_TenantProfile',
      columns: [],
    });
    await expect(upgradeSchema(api)).rejects.toThrow('Ambiguous NocoDB table');
  });

  it('creates every table in an empty base', async () => {
    const api = new FakeNocoDbApi();
    const result = await upgradeSchema(api);
    expect(result.createdTables.sort()).toEqual(AIDA_SCHEMA.map((t) => t.table_name).sort());
    expect((await reportDrift(api)).inSync).toBe(true);
  });

  it('is a no-op on a second run', async () => {
    const api = new FakeNocoDbApi();
    await upgradeSchema(api);
    const second = await upgradeSchema(api);
    expect(second.createdTables).toEqual([]);
    expect(second.addedColumns).toEqual([]);
  });

  it('adds missing columns additively', async () => {
    const api = new FakeNocoDbApi();
    const tenantDef = AIDA_SCHEMA.find((t) => t.table_name === 'aida_tbl_TenantProfile')!;
    await api.createTable({
      ...tenantDef,
      columns: tenantDef.columns.filter((c) => c.column_name !== 'caller_id_number'),
    });
    const drift = await reportDrift(api);
    expect(drift.missingColumns).toContainEqual({
      table: 'aida_tbl_TenantProfile',
      column: 'caller_id_number',
    });

    const result = await upgradeSchema(api);
    expect(result.addedColumns).toContainEqual({
      table: 'aida_tbl_TenantProfile',
      column: 'caller_id_number',
    });
    expect((await reportDrift(api)).missingColumns).toEqual([]);
  });

  it('reports type mismatches without retyping', async () => {
    const api = new FakeNocoDbApi();
    const tenantDef = AIDA_SCHEMA.find((t) => t.table_name === 'aida_tbl_TenantProfile')!;
    await api.createTable({
      ...tenantDef,
      columns: tenantDef.columns.map((c) =>
        c.column_name === 'iTenantId' ? { ...c, uidt: 'SingleLineText' as const } : c,
      ),
    });
    const before = await upgradeSchema(api);
    expect(before.typeMismatches).toContainEqual({
      table: 'aida_tbl_TenantProfile',
      column: 'iTenantId',
      expected: 'Number',
      actual: 'SingleLineText',
    });
    // The live column keeps its (wrong) type: strictly additive, never retyped.
    const columns = await api.listColumns(api.tableByName('aida_tbl_TenantProfile')!.info.id);
    expect(columns.find((c) => c.column_name === 'iTenantId')?.uidt).toBe('SingleLineText');
  });

  it('reports live-only tables and columns without dropping them', async () => {
    const api = new FakeNocoDbApi();
    await upgradeSchema(api);
    await api.createTable({
      table_name: 'legacy_extra',
      title: 'legacy_extra',
      columns: [{ column_name: 'x', title: 'x', uidt: 'SingleLineText' }],
    });
    const drift = await reportDrift(api);
    expect(drift.extraTables).toEqual(['legacy_extra']);
    expect(drift.inSync).toBe(true);
    expect(api.tableByName('legacy_extra')).toBeDefined();
  });

  it('stores no PBX or enrollment configuration', () => {
    for (const table of AIDA_SCHEMA) {
      for (const column of table.columns) {
        expect(column.column_name.toLowerCase()).not.toContain('secret');
        expect(column.column_name.toLowerCase()).not.toMatch(/sip/);
      }
    }
  });
});
