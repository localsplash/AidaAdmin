# Platform consolidation cutover

This change requires the companion Identity platform-session/directory API and
OfficePulse native PBX API changes. Deploy those before
switching AidaAdmin. It does not alter an existing Echo service or database.

## Identity contracts

- Redeem: `POST /api/token {code,redirect_uri}` returns the existing user and
  identities plus `appSession:{token}`.
- Introspect: `POST /api/sessions/introspect {token}` returns `{active:false}`
  or `{active:true,user,tenants,selectedTenantId}`. Tenants carry numeric
  `iTenantId`, `name`, `slug`, `bEnabled` and `TENANT_ADMIN`, `USER` or synthetic
  `SUPER_ADMIN` role. Every request uses a fresh result.
- Select: `POST /api/sessions/select-tenant {token,iTenantId:number|null}`.
- Revoke: `POST /api/sessions/revoke {token}`.
- Directory routes use trusted-server admission **and**
  `Authorization: Bearer <application-session-token>`. Optional
  `ID_CLIENT_SECRET` is sent as `X-Id-Client-Secret`. Per-request async context
  keeps actors separate on the shared HTTP client.
- Tenant create/list/edit, memberships and user edits go only through
  `/api/directory/*`. No direct SQL/NocoDB fallback exists.

Identity returns safe JSON integer IDs. The string tenant IDs used in existing
browser/OfficePulse wire contracts are decimal renderings of `iTenantId`.
A legacy UUID is never interpreted as a platform tenant ID.

## Configuration mapping

| Former AidaAdmin object | New object                                              |
| ----------------------- | ------------------------------------------------------- |
| `tenant` master fields  | Identity business; no local name/slug/enabled authority |
| Tenant voice fields     | `aida_tbl_TenantProfile`                                |
| `tenant_user`           | Identity membership API                                 |
| `extension`             | Native OfficePulse; legacy `aida_tbl_Extension` archive |
| `ring_group`            | Native queues; legacy `aida_tbl_RingGroup` archive      |
| `ring_group_member`     | Native queue members; legacy table archive              |
| `assistant_profile`     | `aida_tbl_AssistantProfile`                             |
| `did_route`             | Native managed DID; legacy `aida_tbl_DidRoute` archive  |
| `configuration_source`  | `aida_tbl_ConfigurationSource`                          |
| `appearance`            | `aida_tbl_Appearance`                                   |
| `audit_log`             | MySQL `admin_tbl_Audit`                                 |

New configuration tables use numeric `iTenantId` instead of `tenant_id` and
`iUserId` instead of `identity_user_id`. Remaining configuration column and UUID
entity names are retained to keep the telephony contract small. TenantProfile
contains `id` (its own UUID), `iTenantId`, `legacy_tenant_id`, `asterisk_context`,
`caller_id_name`, `caller_id_number`, `created_at`, `updated_at`, `revision`.
It is looked up by `iTenantId`, never by equating its UUID with a platform ID.

Before importing remote POC records, export the legacy base and PostgreSQL
store. Build and verify explicit source-system/user and source-system/tenant
mapping files against Identity, then copy configuration with mapped IDs.
Preserve extension/group/route UUID references. Record the old tenant UUID in
`legacy_tenant_id`. Copy historic audit rows into a retained archive or a
reviewed importer; this PR does not silently discard or automatically import
unknown remote data. No source table/base/database is renamed or deleted.

The legacy enrollment hash fields remain available for explicit migration
inspection, but Admin no longer issues or consumes them. Native handset enrollment is outside this release. Do not copy old bearer
grants into new authority. Legacy native tables are for reviewed export only;
follow [native PBX cleanup and rollback](NATIVE_PBX_ADMINISTRATION.md).

## Admin MySQL

Use a dedicated MySQL credential and database named `aida_admin_db`. Startup
rejects PostgreSQL URLs or another database name. The repeatable migration uses
a MySQL advisory lock and records version 1. Its only tables are:

- `admin_tbl_AuthState`: hashed OAuth states, expiry, atomic one-time consume.
- `admin_tbl_IdentityEvent`: unique receipt and transactionally processed state.
- `admin_tbl_EventCursor`: ordered catch-up position, separate from webhooks.
- `admin_tbl_Audit`: immutable operation records and numeric actor/tenant refs.
- `admin_tbl_Migration`: migration ledger.

There is no local session migration target. Old AidaAdmin PostgreSQL session
cookies require a fresh Identity handoff; platform accounts and Identity login
remain intact. Existing Echo sessions are outside this change. Keep the old
AidaAdmin store until the cutover is verified and archived. A service rollback
also needs the matching config/directory version; new platform IDs cannot be
blindly fed into old local tenant tables.

## Acceptance before release

Verify one SUPER_ADMIN and two distinct business memberships, immediate access
removal after disable/revoke, tenant selection after Admin restart, and denial
of cross-business extension/call operations. Configure existing and new tenants,
then exercise native extension/queue/DID administration and its external call
acceptance. Inspect committed versus verified active state separately. Handset
enrollment and legacy reprovision/retry are outside this release. Confirm Echo sign-in and messaging with the
companion Identity change. Back up and restore platform, configuration and
runtime stores before retiring legacy copies.
