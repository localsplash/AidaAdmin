/**
 * Read/write access to the platform user table (`id_tbl_User`) through the
 * NocoDB `AidaIdentity` base — the `id` service's own MySQL database exposed
 * as an external NocoDB source.
 *
 * Two things make this the directory's read path rather than id's HTTP API:
 * the whole user list is available in one call instead of a keyset-paged
 * search, and id exposes no endpoint that updates a display name, so editing
 * one is only possible here.
 *
 * Nothing in this module is tolerant of guessing which table it is looking
 * at: the table is addressed by name, and a missing base or table is
 * reported with what an operator must do, never silently treated as "no
 * users".
 */

import type { NocoDbApi, NocoRecord, NocoWhere } from './api.js';

/** The `id`-owned table this reads. Named by id's own migrations. */
export const IDENTITY_USER_TABLE = 'id_tbl_User';

export class IdentityStoreError extends Error {}

export interface IdentityUser {
  iUserId: number;
  email: string | null;
  displayName: string | null;
  /**
   * True once the person has actually signed in. id derives `claimed` from
   * an attached identity row; `dtLastLogin` moves at the same moment and is
   * readable without a second table, so it stands in for it here.
   */
  claimed: boolean;
  lastLoginAt: string | null;
  createdAt: string | null;
}

/**
 * NocoDB keys record fields by column title, which for an external source is
 * whatever the underlying database calls the column. Case has bitten us
 * before, so every read goes through a case-insensitive lookup rather than
 * assuming one spelling.
 */
function field(record: NocoRecord, name: string): unknown {
  if (name in record) return record[name];
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(record)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}

function str(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null;
  if (value instanceof Date) return value.toISOString();
  return null;
}

export function toIdentityUser(record: NocoRecord): IdentityUser | null {
  const id = Number(field(record, 'iUserId'));
  if (!Number.isInteger(id) || id <= 0) return null;
  const lastLoginAt = str(field(record, 'dtLastLogin'));
  return {
    iUserId: id,
    email: str(field(record, 'email')),
    displayName: str(field(record, 'displayName')),
    claimed: lastLoginAt !== null,
    lastLoginAt,
    createdAt: str(field(record, 'dtCreated')),
  };
}

export class NocoIdentityStore {
  private tableId: string | null = null;

  constructor(private readonly api: NocoDbApi) {}

  /** Resolves `id_tbl_User` by name; matching ignores case, like the base. */
  private async table(): Promise<string> {
    if (this.tableId) return this.tableId;
    const wanted = IDENTITY_USER_TABLE.toLowerCase();
    const found = (await this.api.listTables()).find(
      (t) => t.table_name.toLowerCase() === wanted || t.title.toLowerCase() === wanted,
    );
    if (!found) {
      throw new IdentityStoreError(
        `The NocoDB identity base has no ${IDENTITY_USER_TABLE} table. Connect the ` +
          "id service's MySQL database as a source in that base.",
      );
    }
    this.tableId = found.id;
    return found.id;
  }

  private async rows(where: NocoWhere[], limit?: number): Promise<IdentityUser[]> {
    const records = await this.api.listRecords(await this.table(), where, limit);
    return records.map(toIdentityUser).filter((u): u is IdentityUser => u !== null);
  }

  /**
   * Every user, newest first, optionally narrowed by a case-insensitive
   * substring of email or display name. The filter is applied here rather
   * than in a NocoDB `where` because the comparison operators available to
   * us are equality only.
   */
  async list(query = '', limit = 200): Promise<IdentityUser[]> {
    const all = await this.rows([], limit);
    const needle = query.trim().toLowerCase();
    const matched = needle
      ? all.filter(
          (u) =>
            (u.email ?? '').toLowerCase().includes(needle) ||
            (u.displayName ?? '').toLowerCase().includes(needle),
        )
      : all;
    return matched.sort((a, b) => b.iUserId - a.iUserId);
  }

  /**
   * A NocoDB `where` has to spell the column exactly as the source does, and
   * reads here deliberately do not assume that spelling. So the filtered
   * query is the fast path and a scan is the fallback — one miss costs a
   * listing, a wrong guess about capitalisation would otherwise cost the
   * truth.
   */
  async get(iUserId: number): Promise<IdentityUser | null> {
    const filtered = await this.rows([{ field: 'iUserId', op: 'eq', value: iUserId }], 1);
    if (filtered[0]) return filtered[0];
    const all = await this.rows([], 500);
    return all.find((u) => u.iUserId === iUserId) ?? null;
  }

  async findByEmail(email: string): Promise<IdentityUser | null> {
    const wanted = email.trim().toLowerCase();
    if (!wanted) return null;
    const all = await this.rows([], 500);
    return all.find((u) => (u.email ?? '').toLowerCase() === wanted) ?? null;
  }

  /**
   * Writes the display name back to `id_tbl_User`. The record's own key
   * field is echoed from the row that was just read, so this works whether
   * NocoDB surfaces the external primary key as `iUserId` or as `Id`.
   */
  async updateDisplayName(iUserId: number, displayName: string | null): Promise<IdentityUser> {
    const tableId = await this.table();
    const filtered = await this.api.listRecords(
      tableId,
      [{ field: 'iUserId', op: 'eq', value: iUserId }],
      1,
    );
    const record =
      filtered[0] ??
      (await this.api.listRecords(tableId, [], 500)).find(
        (r) => Number(field(r, 'iUserId')) === iUserId,
      );
    if (!record) throw new IdentityStoreError(`No platform user ${iUserId} exists`);

    const key: Record<string, unknown> = {};
    if (record.Id !== undefined) key.Id = record.Id;
    if (field(record, 'iUserId') !== undefined) key.iUserId = field(record, 'iUserId');
    await this.api.patchRecord(tableId, { ...key, displayName });

    const updated = toIdentityUser({ ...record, displayName });
    if (!updated) throw new IdentityStoreError(`No platform user ${iUserId} exists`);
    return updated;
  }
}
