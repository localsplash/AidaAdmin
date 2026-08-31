import type {
  NocoBaseInfo,
  NocoColumnDef,
  NocoColumnInfo,
  NocoDbApi,
  NocoRecord,
  NocoTableDef,
  NocoTableInfo,
  NocoWhere,
} from '../../src/nocodb/api.js';

interface FakeTable {
  info: NocoTableInfo;
  columns: NocoColumnDef[];
  records: NocoRecord[];
  nextId: number;
}

/** In-memory NocoDB stand-in for unit tests (repository-interface isolation). */
export class FakeNocoDbApi implements NocoDbApi {
  private readonly tables = new Map<string, FakeTable>();
  private nextTableId = 1;
  /** Bases present in the instance; tests seed these to drive resolution. */
  bases: NocoBaseInfo[] = [{ id: 'base-1', title: 'AidaAdmin' }];
  createdBases: string[] = [];
  /** When set, createBase rejects — an operator token without base rights. */
  refuseBaseCreation = false;

  async listBases(): Promise<NocoBaseInfo[]> {
    return this.bases;
  }

  async createBase(title: string): Promise<NocoBaseInfo> {
    if (this.refuseBaseCreation) throw new Error('insufficient privileges');
    const base = { id: `base-${this.bases.length + 1}`, title };
    this.bases.push(base);
    this.createdBases.push(title);
    return base;
  }

  async listTables(): Promise<NocoTableInfo[]> {
    return [...this.tables.values()].map((t) => t.info);
  }

  async listColumns(tableId: string): Promise<NocoColumnInfo[]> {
    const table = this.byId(tableId);
    return table.columns.map((c, i) => ({
      id: `c${i}`,
      column_name: c.column_name,
      title: c.title,
      uidt: c.uidt,
    }));
  }

  async createTable(def: NocoTableDef): Promise<NocoTableInfo> {
    const info: NocoTableInfo = {
      id: `t${this.nextTableId++}`,
      table_name: def.table_name,
      title: def.title,
    };
    this.tables.set(info.id, { info, columns: [...def.columns], records: [], nextId: 1 });
    return info;
  }

  async addColumn(tableId: string, def: NocoColumnDef): Promise<void> {
    this.byId(tableId).columns.push(def);
  }

  async listRecords(tableId: string, where: NocoWhere[], limit = 200): Promise<NocoRecord[]> {
    return this.byId(tableId)
      .records.filter((record) =>
        where.every((w) => {
          const actual = record[w.field];
          const matches = String(actual) === String(w.value);
          return w.op === 'eq' ? matches : !matches;
        }),
      )
      .slice(0, limit);
  }

  async createRecord(tableId: string, values: Record<string, unknown>): Promise<NocoRecord> {
    const table = this.byId(tableId);
    const known = new Set(table.columns.map((c) => c.column_name));
    for (const key of Object.keys(values)) {
      if (!known.has(key)) throw new Error(`Unknown column ${key} in ${table.info.table_name}`);
    }
    const record: NocoRecord = { ...values, Id: table.nextId++ };
    table.records.push(record);
    return record;
  }

  async updateRecord(
    tableId: string,
    recordId: number,
    values: Record<string, unknown>,
  ): Promise<void> {
    const table = this.byId(tableId);
    const record = table.records.find((r) => r.Id === recordId);
    if (!record) throw new Error(`Record ${recordId} not found in ${table.info.table_name}`);
    const known = new Set(table.columns.map((c) => c.column_name));
    for (const key of Object.keys(values)) {
      if (!known.has(key)) throw new Error(`Unknown column ${key} in ${table.info.table_name}`);
    }
    Object.assign(record, values);
  }

  /** Test-only helpers. */
  tableByName(name: string): FakeTable | undefined {
    return [...this.tables.values()].find((t) => t.info.table_name === name);
  }

  private byId(tableId: string): FakeTable {
    const table = this.tables.get(tableId);
    if (!table) throw new Error(`Unknown table ${tableId}`);
    return table;
  }
}
