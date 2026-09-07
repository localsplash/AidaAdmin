import type { NocoColumnDef, NocoDbApi, NocoTableDef } from '../../src/nocodb/api.js';

/**
 * Canonical AidaAdmin base schema (normative specification §1.2), plus:
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

// Test-only stand-ins for the old UI directory fixtures. Never deployed.
export const LEGACY_DIRECTORY_SCHEMA: NocoTableDef[] = [
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
export async function seedLegacyDirectory(api: NocoDbApi): Promise<void> {
  for (const table of LEGACY_DIRECTORY_SCHEMA) await api.createTable(table);
}
