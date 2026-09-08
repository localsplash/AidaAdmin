# Asterisk ownership and the POC boundary

Asterisk is the source of truth for PBX extensions, queues, queue membership,
trunks and effective PBX routing. OfficePulseAidaIntegration owns its PBX adapter
and the operations interface. AidaAdmin owns business and tenant administration:
Identity users, memberships, roles and number assignments, plus Aida business
profiles. There is no separate AidaOfficePbxAdmin application. AidaHandset and
AidaAgent work is deferred. See the [cross-project decision](https://github.com/localsplash/identity/blob/dev/docs/PBX_OWNERSHIP.md).

Queues are Asterisk queues. Existing `RING_GROUP` objects and `RING_ALL` behavior
are historical configuration, not queue definitions and not a safe automatic
conversion target. In particular, PJSIP endpoint IDs may differ from dialable
extension numbers and must not be used as dialplan destinations without review.

## Host runbook reconciliation

The supplied OfficePulse host runbook describes PJSIP Realtime endpoints in
MariaDB and genuine `queues` / `queue_members` tables. It also places effective
DID routing in `/etc/asterisk/extensions.conf` and some trunks in
`/etc/asterisk/pjsip_wizard.conf`. A database inventory cannot describe the whole
PBX. Do not overwrite file-owned routing or equate queue `ringall` strategy with
a legacy ring-group object.

Native call history is `asterisk.cdr`, recorded in UTC; `userfield` contains the
recording basename. `aidacalls_db` is a separate integration call-orchestration
store in this codebase, not the native CDR database and not proven deployed by
that runbook. Tenant-scoped native CDR and recording access still needs an
OfficePulse API contract, reviewed tenant mapping and file-access controls.
Do not infer tenant ownership from a browser-supplied recording name.

The host's TLS port 80 serves phone provisioning, while port 443 serves SIP TLS.
Deploy the private OfficePulse integration API behind its own reviewed ingress;
`OFFICEPULSE_PROVISIONING_BASE_URL` must point at that API, not at either existing
phone-facing listener. The runbook's customer/device inventory is not copied here.

## Implemented boundary

- Browser reads `/admin/tenants/:tenantId/pbx/extensions` and `.../queues`.
  Authentication and enabled tenant-administrator membership are checked before
  the API call. Only Super Admin can view other tenants.
- AidaAdmin calls fixed, private OfficePulse endpoints
  `/v1/admin/pbx/extensions?iTenantId=N` and `/v1/admin/pbx/queues?iTenantId=N`.
  It has no direct Asterisk MySQL access. The client validates the source and
  tenant ID and allowlists response fields, so SIP authentication data cannot
  pass through the inventory response.
- OfficePulse reads the vendor database with explicit operator-owned
  `PBX_INVENTORY_TENANTS_JSON` mappings of Identity tenant IDs to PBX contexts
  and queue names. Configure and validate those mappings before Admin rollout.
  Enable `PBX_INVENTORY_ENABLED` with dedicated SELECT-only
  `PBX_INVENTORY_MYSQL_USER` / `PBX_INVENTORY_MYSQL_PASSWORD` credentials.
  Missing mappings, vendor schema incompatibility and PBX outages are errors;
  the UI does not replace them with successful empty inventories.
- Inventory is current persisted PBX configuration, without an Admin copy or
  reconciliation ledger. Registrations and live queue membership require
  operational runtime evidence; this SQL view does not promise either.
- Extension, ring-group, DID, SIP-secret, enrollment and provisioning-retry
  writes return `409 pbx_owned_by_asterisk` before any local save by default.
  Extension and queue pages have read-only inventory. The default runtime UI
  has no provisioning-status or retry tab. Call diagnostics and idempotent
  call commands remain available.
- The shared Identity Numbers page remains editable. Historical DID routing
  metadata is read-only until its destination contract refers to verified native
  PBX identifiers. Current PBX routing must be checked in OfficePulse operations.

## Preserved compatibility and unfinished cutover

No PBX/NocoDB records, tables or grants are deleted. Existing local extension,
ring-group, DID, provisioning and enrollment code is retained for review and
rollback. `LEGACY_PBX_WRITES_ENABLED=true` explicitly re-enables old server
mutation routes; it is false by default and does not restore the retired browser
editors. Keep it false in this POC. Historical provisioning records may still be
read through the existing diagnostics API; they are not a new reconciliation
requirement. OfficePulse also needs its matching default write gate deployed.

Before business DID editing resumes, define a native extension/queue reference
contract, verify tenant isolation and effective queue fallback behavior, and
review existing references individually. Do not rename a ring-group UUID into
a queue name. The small OfficePulse operations UI and its human authentication
remain separate work; a CIDR-trusted service API is not sufficient browser
authorization. Do not expose that private API directly to browsers.

## Issue evidence and acceptance

[#31](https://github.com/localsplash/AidaAdmin/issues/31) already has Identity
directory proxies, numeric platform tenant IDs, tenant voice profiles, central
session introspection, scoped PlatformConfig loading and durable Identity event
receipts. The original extra membership lookup is superseded by fresh session
introspection on every request. Tenant disable removes access there. There is
no implemented tenant merge/remapping workflow: that remains open with
[identity #16](https://github.com/localsplash/identity/issues/16). A reviewed
legacy tenant/config mapping importer and actual migration evidence remain
open if source records exist; no source deletion is authorized by this cutover.
Old AidaControl device-MAC/session requirements are superseded and handset work
is deferred.

[#29](https://github.com/localsplash/AidaAdmin/issues/29) uses `aidacalls_db`,
not the historical `aida_officepulse` name. The read-only runtime repository,
call/event/dependency views and explicit OfficePulse call API are implemented.
Live-call acceptance is still required: one real DID arrival through screening,
queue takeover/fallback and hangup, two-tenant isolation, verified SELECT-only
SQL grants, and a deployed browser smoke test using the real OfficePulse API.
Unit/component tests prove the application boundary; they do not prove live
calls, vendor SQL compatibility, registrations or deployed credentials.
