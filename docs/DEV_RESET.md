# Disposable DEV canonical cleanup

The operator has explicitly designated this DEV disposable. This cleanup removes
obsolete objects and data; it does not retain a parallel PBX model, a legacy mode,
old import mappings or a rollback copy. Do not run it against an unidentified
production base.

## Remove after deploying matching application readers

Stop/update the old Admin and OfficePulse application containers before removing
these five tables from the shared **PlatformConfig** base by their verified
NocoDB table IDs:

- `aida_tbl_Extension`
- `aida_tbl_RingGroupMember`
- `aida_tbl_RingGroup`
- `aida_tbl_DidRoute`
- `aida_tbl_ConfigurationSource`

Remove the obsolete `legacy_tenant_id` column from `aida_tbl_TenantProfile`.
Use the NocoDB metadata API, so its metadata and backing SQL tables stay aligned.
Do not infer backing SQL names or drop only one side of a NocoDB table.

The only canonical Aida-owned NocoDB tables are `aida_tbl_TenantProfile`,
`aida_tbl_AssistantProfile` and `aida_tbl_Appearance`. `cfg_tbl_Setting` and other
applications' tables in PlatformConfig are outside this deletion set. Identity's
`platform_db` tenant/user/membership/shared-number tables are active authority.

Delete obsolete settings `LEGACY_PBX_WRITES_ENABLED` and `HANDSET_PROVISIONING_URL`
from applicable settings/env sources. Replace the old provisioning base URL key
with `OFFICEPULSE_API_BASE_URL`, then remove the old key. Native administration
accepts the old URL key as a temporary configuration alias, with the canonical
key taking precedence. The URL must be the separate private OfficePulse API ingress.

## Application/runtime scopes

AidaAdmin's `aida_admin_db` auth-state/event/cursor/audit/migration tables remain
active. This repository requires no SQL drop in that database. OfficePulse owns
cleanup of obsolete runtime provisioning/fallback/device objects and obsolete
Asterisk-side integration projection objects; apply its matching cleanup plan,
not a broad database drop. Asterisk vendor tables, real queues/endpoints, native
CDR and live routing files remain the source of truth.

The local Admin deployment uses `/opt/platform-local/admin/compose.yaml`, service
`aida-admin`, image `aida-admin:local`, and loopback port `18086` to container
`3001`. Its `admin-assets` volume contains active appearance assets. MySQL and
NocoDB state are external to that application container.

After cleanup, run the explicit NocoDB `upgrade` and `validate` commands. Confirm
only the three Aida business tables exist, removed API routes return 404, Identity
login and tenant/number/profile administration work, and PBX inventory either
returns the mapped tenant's actual rows or a clear unavailable response.
