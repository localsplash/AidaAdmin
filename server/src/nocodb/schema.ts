import type { NocoColumnDef, NocoDbApi, NocoTableDef } from './api.js';
import { tableByCanonicalName } from './api.js';

/** Aida-owned voice configuration in shared PlatformConfig. Enrollment hash
 * columns are retained for explicit legacy inspection; new grants live in
 * OfficePulse. Tenant identity, membership and audit are not stored here.
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

export const LOGICAL_SCHEMA: NocoTableDef[] = [
  {
    table_name: 'tenant_profile',
    title: 'tenant_profile',
    columns: [
      ...common,
      num('tenant_id'),
      text('legacy_tenant_id'),
      text('asterisk_context'),
      text('caller_id_name'),
      text('caller_id_number'),
    ],
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
];

/** Physical PlatformConfig names; browser and OfficePulse wire fields remain stable. */
export const TABLE_NAMES: Record<string, string> = {
  tenant_profile: 'aida_tbl_TenantProfile',
  extension: 'aida_tbl_Extension',
  ring_group: 'aida_tbl_RingGroup',
  ring_group_member: 'aida_tbl_RingGroupMember',
  assistant_profile: 'aida_tbl_AssistantProfile',
  did_route: 'aida_tbl_DidRoute',
  configuration_source: 'aida_tbl_ConfigurationSource',
  appearance: 'aida_tbl_Appearance',
};
export const FIELD_NAMES: Record<string, string> = {
  tenant_id: 'iTenantId',
  identity_user_id: 'iUserId',
};
export const AIDA_SCHEMA: NocoTableDef[] = LOGICAL_SCHEMA.map((table) => ({
  ...table,
  table_name: TABLE_NAMES[table.table_name]!,
  title: TABLE_NAMES[table.table_name]!,
  columns: table.columns.map((column) => ({
    ...column,
    column_name: FIELD_NAMES[column.column_name] ?? column.column_name,
    title: FIELD_NAMES[column.column_name] ?? column.title,
    ...(column.column_name === 'tenant_id' ? { uidt: 'Number' as const } : {}),
  })),
}));

/**
 * Logical uniqueness rules (spec §1.2). NocoDB exposes no multi-column
 * unique constraints through its API, so repositories enforce these on
 * write and `validate` documents them.
 */
export const UNIQUE_RULES: Record<string, string[][]> = {
  tenant_profile: [['tenant_id'], ['asterisk_context']],
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
  const canonicalNames = new Set(AIDA_SCHEMA.map((t) => t.table_name));

  const report: DriftReport = {
    missingTables: [],
    missingColumns: [],
    typeMismatches: [],
    extraTables: live
      .filter((table) => !canonicalNames.has(table.table_name) && !canonicalNames.has(table.title))
      .map((table) => table.table_name),
    extraColumns: [],
    inSync: false,
  };

  for (const table of AIDA_SCHEMA) {
    const liveTable = tableByCanonicalName(live, table.table_name);
    if (!liveTable) {
      report.missingTables.push(table.table_name);
      continue;
    }
    const liveColumns = (await api.listColumns(liveTable.id)).filter(
      (c) =>
        !c.system &&
        c.uidt !== 'ID' &&
        !SYSTEM_COLUMNS.has(c.title) &&
        !SYSTEM_COLUMNS.has(c.column_name),
    );
    const canonicalCols = new Set(table.columns.map((c) => c.column_name));
    for (const col of table.columns) {
      const matching = liveColumns.filter(
        (liveCol) => liveCol.title === col.title || liveCol.column_name === col.column_name,
      );
      if (matching.length > 1)
        throw new Error(`Ambiguous NocoDB column ${table.table_name}.${col.column_name}`);
      const liveCol = matching[0];
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
      if (!canonicalCols.has(liveCol.column_name) && !canonicalCols.has(liveCol.title)) {
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
    for (const missing of drift.missingColumns) {
      const liveTable = tableByCanonicalName(live, missing.table);
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
