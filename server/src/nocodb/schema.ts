import type { NocoColumnDef, NocoDbApi, NocoTableDef } from './api.js';

/**
 * Canonical AidaConfiguration schema (normative specification §1.2), plus:
 * - `revision` on mutable tables for optimistic-revision checks,
 * - `configuration_source`, `appearance`, and the immutable `audit_log`
 *   required by POC phase 3 (issue #11).
 * SIP secrets have no column anywhere by design; the extension table stores
 * only the enrollment token HASH, never an issued token.
 */

const text = (name: string): NocoColumnDef => ({
  column_name: name,
  title: name,
  uidt: 'SingleLineText',
});
const longText = (name: string): NocoColumnDef => ({
  column_name: name,
  title: name,
  uidt: 'LongText',
});
const num = (name: string): NocoColumnDef => ({ column_name: name, title: name, uidt: 'Number' });
const bool = (name: string): NocoColumnDef => ({
  column_name: name,
  title: name,
  uidt: 'Checkbox',
});
const dt = (name: string): NocoColumnDef => ({ column_name: name, title: name, uidt: 'DateTime' });

const common = [text('id'), dt('created_at'), dt('updated_at'), num('revision')];

export const AIDA_SCHEMA: NocoTableDef[] = [
  {
    table_name: 'tenant',
    title: 'tenant',
    columns: [
      ...common,
      text('name'),
      text('slug'),
      text('asterisk_context'),
      text('caller_id_name'),
      text('caller_id_number'),
      bool('enabled'),
    ],
  },
  {
    table_name: 'tenant_user',
    title: 'tenant_user',
    columns: [...common, text('tenant_id'), num('identity_user_id'), text('role'), bool('enabled')],
  },
  {
    table_name: 'extension',
    title: 'extension',
    columns: [
      ...common,
      text('tenant_id'),
      num('identity_user_id'),
      text('extension_number'),
      text('display_name'),
      text('caller_id_name'),
      text('caller_id_number'),
      text('asterisk_context'),
      text('provisioning_profile'),
      text('device_id'),
      text('provisioning_mac'),
      text('enrollment_token_hash'),
      dt('enrollment_expires_at'),
      dt('enrollment_consumed_at'),
      num('device_credential_version'),
      bool('enabled'),
    ],
  },
  {
    table_name: 'ring_group',
    title: 'ring_group',
    columns: [
      ...common,
      text('tenant_id'),
      text('name'),
      text('virtual_extension'),
      text('asterisk_context'),
      text('ring_strategy'),
      num('ring_timeout_seconds'),
      text('music_on_hold_class'),
      text('caller_id_name'),
      text('caller_id_number'),
      bool('enabled'),
    ],
  },
  {
    table_name: 'ring_group_member',
    title: 'ring_group_member',
    columns: [
      ...common,
      text('tenant_id'),
      text('ring_group_id'),
      text('extension_id'),
      num('sort_order'),
      bool('enabled'),
    ],
  },
  {
    table_name: 'assistant_profile',
    title: 'assistant_profile',
    columns: [
      ...common,
      text('tenant_id'),
      text('name'),
      text('business_name'),
      longText('prompt'),
      text('tone'),
      longText('objective'),
      longText('opening_statement'),
      longText('transfer_statement'),
      longText('failed_transfer_statement'),
      bool('enabled'),
    ],
  },
  {
    table_name: 'did_route',
    title: 'did_route',
    columns: [
      ...common,
      text('tenant_id'),
      text('did_e164'),
      text('assistant_profile_id'),
      text('destination_type'),
      text('destination_extension_id'),
      text('destination_ring_group_id'),
      bool('screening_enabled'),
      bool('enabled'),
    ],
  },
  {
    table_name: 'configuration_source',
    title: 'configuration_source',
    columns: [...common, text('tenant_id'), text('kind'), text('description')],
  },
  {
    table_name: 'appearance',
    title: 'appearance',
    columns: [
      ...common,
      text('tenant_id'),
      text('brand_name'),
      text('logo_asset_path'),
      text('primary_color'),
    ],
  },
  {
    // Immutable: the repository only ever appends; there is no update path.
    table_name: 'audit_log',
    title: 'audit_log',
    columns: [
      text('id'),
      dt('created_at'),
      text('tenant_id'),
      num('actor_identity_user_id'),
      text('action'),
      text('entity_type'),
      text('entity_id'),
      longText('details'),
      text('correlation_id'),
    ],
  },
];

/**
 * Logical uniqueness rules (spec §1.2). NocoDB exposes no multi-column
 * unique constraints through its API, so repositories enforce these on
 * write and `validate` documents them.
 */
export const UNIQUE_RULES: Record<string, string[][]> = {
  tenant: [['slug'], ['asterisk_context']],
  tenant_user: [['tenant_id', 'identity_user_id']],
  extension: [['tenant_id', 'extension_number'], ['device_id'], ['provisioning_mac']],
  ring_group: [['tenant_id', 'virtual_extension']],
  ring_group_member: [['ring_group_id', 'extension_id']],
  did_route: [['did_e164']],
};

export interface DriftReport {
  missingTables: string[];
  missingColumns: Array<{ table: string; column: string }>;
  /** Live type differs from canonical — never auto-fixed, only reported. */
  typeMismatches: Array<{ table: string; column: string; expected: string; actual: string }>;
  /** Live-only tables/columns — never dropped, only reported. */
  extraTables: string[];
  extraColumns: Array<{ table: string; column: string }>;
  inSync: boolean;
}

/** NocoDB-managed columns to ignore when comparing schemas. */
const SYSTEM_COLUMNS = new Set([
  'Id',
  'CreatedAt',
  'UpdatedAt',
  'created_by',
  'updated_by',
  'nc_order',
]);

export async function reportDrift(api: NocoDbApi): Promise<DriftReport> {
  const live = await api.listTables();
  const liveByName = new Map(live.map((t) => [t.table_name, t]));
  const canonicalNames = new Set(AIDA_SCHEMA.map((t) => t.table_name));

  const report: DriftReport = {
    missingTables: [],
    missingColumns: [],
    typeMismatches: [],
    extraTables: live.map((t) => t.table_name).filter((name) => !canonicalNames.has(name)),
    extraColumns: [],
    inSync: false,
  };

  for (const table of AIDA_SCHEMA) {
    const liveTable = liveByName.get(table.table_name);
    if (!liveTable) {
      report.missingTables.push(table.table_name);
      continue;
    }
    const liveColumns = (await api.listColumns(liveTable.id)).filter(
      (c) => !c.system && !SYSTEM_COLUMNS.has(c.column_name),
    );
    const liveByCol = new Map(liveColumns.map((c) => [c.column_name, c]));
    const canonicalCols = new Set(table.columns.map((c) => c.column_name));
    for (const col of table.columns) {
      const liveCol = liveByCol.get(col.column_name);
      if (!liveCol) {
        report.missingColumns.push({ table: table.table_name, column: col.column_name });
      } else if (liveCol.uidt !== col.uidt) {
        report.typeMismatches.push({
          table: table.table_name,
          column: col.column_name,
          expected: col.uidt,
          actual: liveCol.uidt,
        });
      }
    }
    for (const liveCol of liveColumns) {
      if (!canonicalCols.has(liveCol.column_name)) {
        report.extraColumns.push({ table: table.table_name, column: liveCol.column_name });
      }
    }
  }

  report.inSync =
    report.missingTables.length === 0 &&
    report.missingColumns.length === 0 &&
    report.typeMismatches.length === 0;
  return report;
}

export interface UpgradeResult {
  createdTables: string[];
  addedColumns: Array<{ table: string; column: string }>;
  /** Reported, never touched: upgrades are strictly additive. */
  typeMismatches: DriftReport['typeMismatches'];
}

/**
 * Additive upgrade: creates missing tables and adds missing columns. Never
 * drops or retypes anything — a type mismatch is reported for a human. A
 * second run against a current base is a no-op.
 */
export async function upgradeSchema(api: NocoDbApi): Promise<UpgradeResult> {
  const result: UpgradeResult = { createdTables: [], addedColumns: [], typeMismatches: [] };
  const drift = await reportDrift(api);
  result.typeMismatches = drift.typeMismatches;

  for (const tableName of drift.missingTables) {
    const def = AIDA_SCHEMA.find((t) => t.table_name === tableName);
    if (def) {
      await api.createTable(def);
      result.createdTables.push(tableName);
    }
  }

  if (drift.missingColumns.length > 0) {
    const live = await api.listTables();
    const liveByName = new Map(live.map((t) => [t.table_name, t]));
    for (const missing of drift.missingColumns) {
      const liveTable = liveByName.get(missing.table);
      const def = AIDA_SCHEMA.find((t) => t.table_name === missing.table)?.columns.find(
        (c) => c.column_name === missing.column,
      );
      if (liveTable && def) {
        await api.addColumn(liveTable.id, def);
        result.addedColumns.push({ table: missing.table, column: missing.column });
      }
    }
  }

  return result;
}
