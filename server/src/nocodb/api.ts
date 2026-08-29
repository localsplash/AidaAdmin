/**
 * Server-only NocoDB v2 API surface. The API token never leaves this module's
 * HTTP client; browser code, AidaHandset, OfficePulse, and Asterisk never
 * talk to NocoDB directly.
 */

export interface NocoColumnDef {
  column_name: string;
  title: string;
  uidt: 'SingleLineText' | 'LongText' | 'Number' | 'Decimal' | 'Checkbox' | 'DateTime' | 'JSON';
}

export interface NocoTableDef {
  table_name: string;
  title: string;
  columns: NocoColumnDef[];
}

export interface NocoTableInfo {
  id: string;
  table_name: string;
  title: string;
}

export interface NocoColumnInfo {
  id: string;
  column_name: string;
  title: string;
  uidt: string;
  /** NocoDB system columns (Id, CreatedAt, …) are ignored by drift checks. */
  system?: boolean;
}

export type NocoRecord = Record<string, unknown> & { Id?: number };

export interface NocoWhere {
  field: string;
  op: 'eq' | 'neq';
  value: string | number | boolean;
}

export interface NocoDbApi {
  listTables(): Promise<NocoTableInfo[]>;
  listColumns(tableId: string): Promise<NocoColumnInfo[]>;
  createTable(def: NocoTableDef): Promise<NocoTableInfo>;
  addColumn(tableId: string, def: NocoColumnDef): Promise<void>;
  listRecords(tableId: string, where: NocoWhere[], limit?: number): Promise<NocoRecord[]>;
  createRecord(tableId: string, values: Record<string, unknown>): Promise<NocoRecord>;
  updateRecord(tableId: string, recordId: number, values: Record<string, unknown>): Promise<void>;
}

export class NocoDbError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

function whereClause(where: NocoWhere[]): string {
  return where.map((w) => `(${w.field},${w.op},${String(w.value)})`).join('~and');
}

export class HttpNocoDbApi implements NocoDbApi {
  constructor(
    private readonly baseUrl: string,
    private readonly apiToken: string,
    private readonly baseId: string,
  ) {}

  private async request(path: string, init?: RequestInit): Promise<unknown> {
    const res = await fetch(new URL(path, this.baseUrl), {
      ...init,
      headers: {
        'xc-token': this.apiToken,
        'content-type': 'application/json',
        ...(init?.headers ?? {}),
      },
    });
    if (!res.ok) {
      // Response bodies can echo request payloads; do not attach them.
      throw new NocoDbError(`NocoDB request ${path.split('?')[0]} failed`, res.status);
    }
    return res.status === 204 ? null : res.json();
  }

  async listTables(): Promise<NocoTableInfo[]> {
    const body = (await this.request(`/api/v2/meta/bases/${this.baseId}/tables`)) as {
      list?: NocoTableInfo[];
    };
    return body.list ?? [];
  }

  async listColumns(tableId: string): Promise<NocoColumnInfo[]> {
    const body = (await this.request(`/api/v2/meta/tables/${tableId}`)) as {
      columns?: NocoColumnInfo[];
    };
    return body.columns ?? [];
  }

  async createTable(def: NocoTableDef): Promise<NocoTableInfo> {
    return (await this.request(`/api/v2/meta/bases/${this.baseId}/tables`, {
      method: 'POST',
      body: JSON.stringify(def),
    })) as NocoTableInfo;
  }

  async addColumn(tableId: string, def: NocoColumnDef): Promise<void> {
    await this.request(`/api/v2/meta/tables/${tableId}/columns`, {
      method: 'POST',
      body: JSON.stringify(def),
    });
  }

  async listRecords(tableId: string, where: NocoWhere[], limit = 200): Promise<NocoRecord[]> {
    const params = new URLSearchParams({ limit: String(limit) });
    if (where.length > 0) params.set('where', whereClause(where));
    const body = (await this.request(`/api/v2/tables/${tableId}/records?${params}`)) as {
      list?: NocoRecord[];
    };
    return body.list ?? [];
  }

  async createRecord(tableId: string, values: Record<string, unknown>): Promise<NocoRecord> {
    return (await this.request(`/api/v2/tables/${tableId}/records`, {
      method: 'POST',
      body: JSON.stringify(values),
    })) as NocoRecord;
  }

  async updateRecord(
    tableId: string,
    recordId: number,
    values: Record<string, unknown>,
  ): Promise<void> {
    await this.request(`/api/v2/tables/${tableId}/records`, {
      method: 'PATCH',
      body: JSON.stringify({ Id: recordId, ...values }),
    });
  }
}
