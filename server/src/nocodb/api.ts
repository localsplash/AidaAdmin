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

export interface NocoBaseInfo {
  id: string;
  title: string;
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

/** The base-discovery surface, split out so the resolver needs nothing else. */
export interface NocoMetaApi {
  listBases(): Promise<NocoBaseInfo[]>;
  createBase(title: string): Promise<NocoBaseInfo>;
}

export interface NocoDbApi extends NocoMetaApi {
  listTables(): Promise<NocoTableInfo[]>;
  listColumns(tableId: string): Promise<NocoColumnInfo[]>;
  createTable(def: NocoTableDef): Promise<NocoTableInfo>;
  addColumn(tableId: string, def: NocoColumnDef): Promise<void>;
  listRecords(tableId: string, where: NocoWhere[], limit?: number): Promise<NocoRecord[]>;
  createRecord(tableId: string, values: Record<string, unknown>): Promise<NocoRecord>;
  updateRecord(tableId: string, recordId: number, values: Record<string, unknown>): Promise<void>;
  /**
   * PATCH with a caller-supplied key. External sources (the identity base's
   * MySQL tables) key on their own primary-key column — `iUserId`, not the
   * `Id` that NocoDB-owned tables carry — so the key travels in the body.
   */
  patchRecord(tableId: string, values: Record<string, unknown>): Promise<void>;
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
  /**
   * `resolveBaseId` is supplied rather than a configured id: the base is
   * addressed by name and discovered at runtime (see base.ts).
   */
  constructor(
    private readonly baseUrl: string,
    private readonly apiToken: string,
    private readonly resolveBaseId: () => Promise<string>,
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

  async listBases(): Promise<NocoBaseInfo[]> {
    const body = (await this.request('/api/v2/meta/bases')) as { list?: NocoBaseInfo[] };
    return body.list ?? [];
  }

  async createBase(title: string): Promise<NocoBaseInfo> {
    return (await this.request('/api/v2/meta/bases', {
      method: 'POST',
      body: JSON.stringify({ title }),
    })) as NocoBaseInfo;
  }

  async listTables(): Promise<NocoTableInfo[]> {
    const baseId = await this.resolveBaseId();
    const body = (await this.request(`/api/v2/meta/bases/${baseId}/tables`)) as {
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
    const baseId = await this.resolveBaseId();
    return (await this.request(`/api/v2/meta/bases/${baseId}/tables`, {
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
    await this.patchRecord(tableId, { Id: recordId, ...values });
  }

  async patchRecord(tableId: string, values: Record<string, unknown>): Promise<void> {
    await this.request(`/api/v2/tables/${tableId}/records`, {
      method: 'PATCH',
      body: JSON.stringify(values),
    });
  }
}
