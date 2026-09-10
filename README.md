# AidaAdmin

AidaAdmin is the administration UI and backend for the shared Echo/Aida office
platform. OfficePulseAidaIntegration owns native PBX configuration and voice orchestration.
Identity owns every person, business, membership and staff application session.

## Storage and ownership

| Store                   | Owner                 | AidaAdmin access                                                      |
| ----------------------- | --------------------- | --------------------------------------------------------------------- |
| `platform_db`           | Identity              | Authenticated Identity API only                                       |
| NocoDB `PlatformConfig` | Platform applications | Business/assistant profiles, appearance and scoped settings           |
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
Extensions, native queues and managed DID routes use OfficePulse inventory and
tenant-authorized mutations. Generated extension credentials are disclosed once.
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

## Native PBX and runtime

AidaAdmin calls OfficePulse's canonical private `/v1/admin/pbx` API from its
same-origin backend. It creates/deletes extensions and native queues, edits saved
queue members and configures DID schedules/ring budgets before LiveKit. Identity
session, tenant/role, selected tenant and CSRF checks precede every mutation.
Managed DIDs require both enabled Identity voice assignment and OfficePulse scope.

Set server-only `OFFICEPULSE_API_BASE_URL` (the previous
`OFFICEPULSE_PROVISIONING_BASE_URL` remains a compatibility alias). Deploy the
OfficePulse contract and operator-owned Asterisk delegation first, then this
backend and UI. `committed` is a database result; it does not assert effective
Asterisk state is active. Read [native PBX administration](docs/NATIVE_PBX_ADMINISTRATION.md)
for schemas, one-time credentials, deployment order, static-route shadowing and
reviewed legacy-data cleanup/rollback.

Legacy provisioning, ring-group, update/rotation, handset enrollment and retry
controls are retired. No native PBX desired state is saved in NocoDB. Staff call
commands still use `/v1/admin/calls/:id/commands`; call/event/dependency views use
OfficePulse's read-only runtime SQL account. No AidaControl service is required.

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

DID routes choose from this same registry. The immutable E.164 value is their reference; managed routing settings are read from and committed to OfficePulse/Asterisk. Number assignment does not provision carrier service. Disable an existing DID route separately when stopping PBX routing; disabling the shared number removes Echo access and prevents PBX mutations for it until its enabled voice assignment is restored. Tenant/number reassignment is deliberately unsupported to protect historical messages and media.

Deploy Identity migration `0005_shared_phone_numbers` and import reviewed existing assignments before this Admin version. Runtime call history now uses `aidacalls_db`; `aida_admin_db` still stores this application’s local state. See the infrastructure repository’s shared-number rollout guide for a data-preserving existing-database migration.
