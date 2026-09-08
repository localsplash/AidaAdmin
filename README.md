# AidaAdmin

AidaAdmin is the administration UI and backend for the shared Echo/Aida office
platform. Asterisk owns PBX extensions, queues and their membership.
OfficePulseAidaIntegration owns PBX access and voice orchestration.
Identity owns every person, business, membership and staff application session.

## Storage and ownership

| Store                   | Owner                 | AidaAdmin access                                                      |
| ----------------------- | --------------------- | --------------------------------------------------------------------- |
| `platform_db`           | Identity              | Authenticated Identity API only                                       |
| NocoDB `PlatformConfig` | Platform applications | `aida_tbl_*` voice configuration; scoped settings                     |
| `aida_admin_db` (MySQL) | AidaAdmin             | OAuth state, Identity event receipts/replay cursor, append-only audit |
| `aidacalls_db` (MySQL)  | OfficePulse           | Read-only runtime views; commands through the private HTTP API        |
| Asterisk tables         | PBX project           | OfficePulse adapter only; no AidaAdmin DDL or direct writes           |

There is no AidaAdmin PostgreSQL dependency, local user/membership directory,
local authoritative session table, or NocoDB `AidaIdentity` access. The cookie
contains Identity's opaque application-session token. Every authenticated
request introspects that token, so membership removal and session/privilege
revocation take effect on the next request. Tenant selection is stored in the
central application session. An Identity outage denies authenticated work.

SUPER_ADMIN can see every business and assign Super Admin, Tenant Admin or User.
TENANT_ADMIN can add users by email and assign Tenant Admin or User in its own
enabled tenant. USER cannot sign in to AidaAdmin. Only Super Admins see the
Tenants menu and tenant selector; selecting a tenant updates both the central
session and the current tenant page. Tenant Admins enter their tenant automatically.

Users are listed with names, email addresses, roles and status. Add User is
expandable; Edit saves the profile and role together through Identity. Linked
sign-in emails are read-only; pending-user email addresses can be corrected.
Extensions and queues are read-only views of Asterisk through the OfficePulse API.
DID routing metadata is currently read-only pending native PBX destination references;
the Numbers page continues to manage the shared Identity number registry.
Identity enforces the role hierarchy on the server, including live demotion and
last-administrator protection. Global directory search remains Super Admin-only.

## Setup

Use Node 22 or the supplied Dockerfile. Set `NOCODB_BASE_URL` and
`NOCODB_API_TOKEN` as server-only bootstrap inputs. Settings are read from
`cfg_tbl_Setting` in `PlatformConfig`, with precedence:

1. Nonblank environment override.
2. `app=aida-admin`.
3. `app=aida`.
4. `app=*`.

Fields are `app`, `settingKey`, `settingValue`, `description`, `bSecret`,
`dtCreated`, `dtUpdated`. Blank rows are unset and duplicate applicable keys are
errors. `PARENT_DOMAIN` supplies `ID_PARENT_DOMAIN` when that key is absent.
Connection/settings changes require a process restart in this first release.
Runtime reads do not create a missing base or schema.

```sh
npm ci
npm run nocodb -w server -- create  # explicit first bootstrap
npm run nocodb -w server -- upgrade
npm run nocodb -w server -- validate
npm run typecheck
npm test
npm run build
npm start
```

The CLI only creates/upgrades Aida-owned tables; the platform bootstrap owns
`cfg_tbl_Setting`. Create businesses and memberships through Identity/AidaAdmin,
then configure each business's voice profile. Existing organizations without a
voice profile appear with revision 0 and can be configured using the normal
edit form. See [.env.example](.env.example) and the
[cutover guide](docs/PLATFORM_MIGRATION.md) before attaching existing data.

## PBX ownership and runtime

AidaAdmin reads tenant-scoped inventory through OfficePulse's private
`GET /v1/admin/pbx/extensions?iTenantId=N` and
`GET /v1/admin/pbx/queues?iTenantId=N` APIs. OfficePulse uses explicit,
operator-reviewed tenant/context and queue mappings; an unavailable or unmapped
PBX is an error. Endpoint IDs are not assumed to be dialable extension numbers.
This view reports saved configuration, not live registrations or queue state.

Legacy extension, ring-group, DID, SIP-secret, enrollment, and retry writes are
disabled before saving any local configuration. The application has no PBX
creation or synchronization status workflow in its default UI. Existing records
and compatibility code remain for reviewed rollback; `LEGACY_PBX_WRITES_ENABLED`
is false by default and must remain false for the Asterisk-owned POC.
The flag does not restore retired browser editors. See
[the ownership and cutover decision](docs/PBX_OWNERSHIP.md).

Staff takeover goes to
`/v1/admin/calls/:id/commands`, with the viewed call version and an idempotency
key. Call and event views use the read-only runtime SQL account.
The supplied host runbook identifies `asterisk.cdr` as native call history;
`aidacalls_db` is separate integration diagnostics and is not a replacement for
that history. Native CDR/recording API access and deployed validation remain open.
No AidaControl service is required.

AidaHandset and AidaAgent work is deferred. Existing enrollment and secret
rotation compatibility code is gated with the other legacy PBX writes.
Call commands remain explicit, auditable OfficePulse API operations.
NocoDB revision checks are read/compare/write, so this POC
requires one administrative writer; they do not promise SQL compare-and-swap.

## Health, deployment and validation

The container listens on port 3001. Map the chosen public origin, for example
`https://aida-admin.localsplash.dev`, to that port through Nginx Proxy Manager.
Identity's parent domain must allow the callback
`https://aida-admin.localsplash.dev/api/auth/callback`. Public branding and host
names remain deployment settings; use `X.TLD` for another operator.

`/healthz` is independent of authentication and dependencies. `/readyz` reports
Admin persistence and runtime database status. `/id/events` accepts only the
configured Identity source CIDRs. Webhooks durably record receipts but do not
advance the ordered replay cursor; missed lower event IDs remain replayable.
Browser mutations require the CSRF token, and browser-supplied `X-Aida-*`
headers are stripped.

Unit/component tests require no credentials. MySQL integration runs only with
`AIDA_ADMIN_TEST_DATABASE_URL` pointing at a **disposable** `aida_admin_db`.
NocoDB integration requires separate `NOCODB_TEST_BASE_URL` and
`NOCODB_TEST_API_TOKEN` values for a disposable PlatformConfig instance.
CI uses MySQL 8.4 and Node 22. A passing build does not validate the external
PBX, real Identity login, a carrier number or a physical Android handset.

## Shared numbers and Echo access

Manage each tenant’s **Numbers** in AidaAdmin. Identity owns the unique E.164 number-to-tenant assignment in `platform_db.identity_tbl_PhoneNumber`; every number supports both voice and messaging and explicitly grants access to all enabled tenant members. Enabled USER members can sign in to Echo even though they cannot use AidaAdmin. No separate Echo user or business provisioning grants access. Members without numbers see a contact-admin warning in Echo.

DID routes choose from this same registry. The immutable E.164 value is their reference; routing details remain in NocoDB. Number assignment does not provision carrier service. Use OfficePulse PBX operations to stop PBX routing; disabling the shared number removes Echo access and prevents saving it as an active route. Tenant/number reassignment is deliberately unsupported to protect historical messages and media.

Deploy Identity migration `0005_shared_phone_numbers` and import reviewed existing assignments before this Admin version. Runtime call history now uses `aidacalls_db`; `aida_admin_db` still stores this application’s local state. See the infrastructure repository’s shared-number rollout guide for a data-preserving existing-database migration.
