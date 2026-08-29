import { describe, expect, it } from 'vitest';
import { AIDA_SCHEMA, reportDrift, upgradeSchema } from '../src/nocodb/schema.js';
import { FakeNocoDbApi } from './helpers/fake-nocodb.js';

describe('schema automation', () => {
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
    const tenantDef = AIDA_SCHEMA.find((t) => t.table_name === 'tenant')!;
    await api.createTable({
      ...tenantDef,
      columns: tenantDef.columns.filter((c) => c.column_name !== 'caller_id_number'),
    });
    const drift = await reportDrift(api);
    expect(drift.missingColumns).toContainEqual({ table: 'tenant', column: 'caller_id_number' });

    const result = await upgradeSchema(api);
    expect(result.addedColumns).toContainEqual({ table: 'tenant', column: 'caller_id_number' });
    expect((await reportDrift(api)).missingColumns).toEqual([]);
  });

  it('reports type mismatches without retyping', async () => {
    const api = new FakeNocoDbApi();
    const tenantDef = AIDA_SCHEMA.find((t) => t.table_name === 'tenant')!;
    await api.createTable({
      ...tenantDef,
      columns: tenantDef.columns.map((c) =>
        c.column_name === 'enabled' ? { ...c, uidt: 'SingleLineText' as const } : c,
      ),
    });
    const before = await upgradeSchema(api);
    expect(before.typeMismatches).toContainEqual({
      table: 'tenant',
      column: 'enabled',
      expected: 'Checkbox',
      actual: 'SingleLineText',
    });
    // The live column keeps its (wrong) type: strictly additive, never retyped.
    const columns = await api.listColumns(api.tableByName('tenant')!.info.id);
    expect(columns.find((c) => c.column_name === 'enabled')?.uidt).toBe('SingleLineText');
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

  it('stores no SIP secret column anywhere', () => {
    for (const table of AIDA_SCHEMA) {
      for (const column of table.columns) {
        expect(column.column_name.toLowerCase()).not.toContain('secret');
        expect(column.column_name.toLowerCase()).not.toMatch(/sip/);
      }
    }
    // The enrollment token is stored as a hash only.
    const extension = AIDA_SCHEMA.find((t) => t.table_name === 'extension')!;
    expect(extension.columns.some((c) => c.column_name === 'enrollment_token_hash')).toBe(true);
    expect(extension.columns.some((c) => c.column_name === 'enrollment_token')).toBe(false);
  });
});
