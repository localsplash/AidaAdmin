# AidaAdmin

AidaAdmin is the administration UI and backend for the shared Echo/Aida office
platform. OfficePulseAidaIntegration owns native PBX configuration and voice orchestration.
Identity owns every person, business, membership and staff application session.

## Storage and ownership

| Store                   | Owner                 | AidaAdmin access                                                       |
| ----------------------- | --------------------- | ---------------------------------------------------------------------- |
| `platform_db`           | Identity              | Authenticated Identity API only                                        |
| NocoDB `PlatformConfig` | Platform applications | Tenant PBX scope, assistant profiles/assignments, appearance, settings |
| `aida_admin_db` (MySQL) | AidaAdmin             | OAuth state, Identity event receipts/replay cursor, append-only audit  |
| `aidacalls_db` (MySQL)  | OfficePulse           | Read-only runtime views; commands through the private HTTP API         |
| Asterisk tables         | PBX project           | OfficePulse adapter only; no AidaAdmin DDL or direct writes            |

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
tenant-authorized, context-scoped mutations. Generated extension credentials are
disclosed once.
Extensions also show attached AidaHandset devices, including model, registration MAC,
local/public addresses and last seen. Tenant Admins can revoke a session after
confirmation; the list refreshes every ten seconds. A registered phone attaches
again automatically, so revocation is for a phone that has left, not a lock.
Call details identify successful handset takeovers by their extension.

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

The rows this app reads, by the scope they belong in:

| Scope | Keys |
| --- | --- |
| `aida-admin` | `PUBLIC_BASE_URL`, `SESSION_SECRET`, `AIDA_ADMIN_DATABASE_URL`, `OFFICEPULSE_RUNTIME_DATABASE_URL`, `ID_BASE_URL` (and optionally `ID_PUBLIC_BASE_URL`), `ID_CLIENT_SECRET` (only while Identity runs in `secret`/`dual` mode), `ID_TRUSTED_PROXY_CIDRS` |
| `aida` | `OFFICEPULSE_API_BASE_URL`, `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` — shared with AidaAgent and OfficePulse |
| `*` | `PARENT_DOMAIN`, `trustedCIDR`, `ENVIRONMENT_NAME` |

`ID_BASE_URL` stays in the `aida-admin` scope on purpose: OfficePulse refuses
that key in any scope it reads. Inbound `/id/events` deliveries are admitted by
`trustedCIDR`, the platform-wide network policy every application reads;
`ID_TRUSTED_PROXY_CIDRS` is separate deployment policy naming the reverse
proxies whose `X-Forwarded-For` is believed when resolving that client.
Set `ENVIRONMENT_NAME` (`dev`, `staging`, or `prod`) in global scope `app=*`.
The persistent environment label compares this resolved setting with OfficePulse
`/readyz` every thirty seconds. A mismatch prominently names both environments and
the serving PBX instance. Missing values appear as `unknown` and never count as a
mismatch; an unreachable OfficePulse is an availability problem, not a mismatch.

Connection/settings changes require a process restart in this first release.
Runtime reads do not create a missing base or schema.

### Database account

`AIDA_ADMIN_DATABASE_URL` names the account AidaAdmin uses for `aida_admin_db`
(by convention `aida_admin_app`). On a shared MySQL, create it with
`scripts/db-users.sh`, which reads that same URL, decodes it the way the server
does, and needs only the server's admin password:

```sh
docker run --rm --network <network> -v "$PWD/scripts:/scripts:ro" \
  -e AIDA_ADMIN_DATABASE_URL=… -e MYSQL_ADMIN_PASSWORD=… \
  mysql:8.4 bash /scripts/db-users.sh
```

It creates the database if missing, and the account (`'%'`) with `ALL
PRIVILEGES` on it and nothing else. It is idempotent: grants converge on every
run, and a new password in the URL rotates it. `DB_HOST` overrides the URL's host
when you reach MySQL by another name. The read-only `aidaadmin_ro` account for
`OFFICEPULSE_RUNTIME_DATABASE_URL` is created by OfficePulse, which owns
`aidacalls_db`.

The Compose file's external networks and volumes are named per environment in
`.env`: `PLATFORM_NETWORK` (default `platform-local`) and `ADMIN_ASSETS_VOLUME`
(default `aida-admin-assets`, created once with `docker volume create`).

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

The CLI only creates/upgrades Aida-owned tables (`aida_tbl_TenantProfile`,
`aida_tbl_AssistantProfile`, `aida_tbl_ProfileAssignment`, `aida_tbl_Appearance`);
the platform bootstrap owns `cfg_tbl_Setting`. Create businesses and memberships
through Identity/AidaAdmin, then set each business's PBX scope in Tenants: its
primary Asterisk context (`asterisk_context`), any additional extension contexts
(`additional_contexts`) and the shared inbound DID context (`did_context`).
Existing organizations without a voice profile appear with revision 0 and can be
configured using the normal edit form. `upgrade` adds the context columns and the
assignment table to an existing base additively. See [.env.example](.env.example) and the
[cutover guide](docs/PLATFORM_MIGRATION.md) before attaching existing data.

## Native PBX and runtime

AidaAdmin calls OfficePulse's canonical private `/v1/admin/pbx` API from its
same-origin backend. It creates/deletes extensions and native queues, edits saved
queue members and configures DID schedules/ring budgets before LiveKit. Identity
session, tenant/role, selected tenant and CSRF checks precede every mutation.
The PBX scope sent to OfficePulse is `{pbxInstanceId, context}` — the Asterisk
extension context assigned to the tenant in Tenants — never the customer tenant
id, which stays the login/authorization identity. A browser may pick one of the
tenant's own contexts with `?context=`; anything else is refused before any
OfficePulse call. Managed DIDs require an enabled Identity voice assignment and
the tenant's inbound DID context. AidaAdmin sends the current Identity-owned
Numbers with each DID request, so new assignments require no per-number
OfficePulse environment change. Which assistant answers a call is a persisted
per-context/per-DID assignment (`aida_tbl_ProfileAssignment`) edited in Profiles
and Numbers; nobody edits environment JSON to select a profile. Former
`PBX_INVENTORY_TENANTS_JSON` and `AGENT_PROFILE_IDS_JSON` entries migrate as
described in [native PBX administration](docs/NATIVE_PBX_ADMINISTRATION.md).

Set server-only `OFFICEPULSE_API_BASE_URL` (the previous
`OFFICEPULSE_PROVISIONING_BASE_URL` remains a compatibility alias). Deploy the
OfficePulse contract and operator-owned Asterisk delegation first, then this
backend and UI. `committed` is a database result; it does not assert effective
Asterisk state is active. Read [native PBX administration](docs/NATIVE_PBX_ADMINISTRATION.md)
for schemas, one-time credentials, deployment order, static-route shadowing and
reviewed legacy-data cleanup/rollback.

Legacy provisioning, ring-group, update/rotation, handset enrollment codes and retry
controls are retired. Handsets attach through live SIP registration; AidaAdmin
proxies the private context-scoped handset list/revoke API. No native PBX desired state is saved in NocoDB. Staff call
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

Manage each tenant’s **Numbers** in AidaAdmin. The Add Number / DID form creates the assignment through Identity, which owns and enforces the globally unique E.164 number-to-tenant assignment in `platform_db.identity_tbl_PhoneNumber`; every number supports both voice and messaging and explicitly grants access to all enabled tenant members. Enabled USER members can sign in to Echo even though they cannot use AidaAdmin. No separate Echo user or business provisioning grants access. Members without numbers see a contact-admin warning in Echo.

Each Number shows its PBX routing state and an inline routing editor; single-number tenants open it by default. Identity assignments remain visible when PBX scope is missing or OfficePulse is unavailable, with routing actions disabled as appropriate. The immutable E.164 value is their reference; managed routing settings are read from and committed to OfficePulse/Asterisk. Number assignment does not provision carrier service. Disable an existing DID route separately when stopping PBX routing; disabling the shared number removes Echo access and prevents PBX mutations for it until its enabled voice assignment is restored. Tenant/number reassignment is deliberately unsupported to protect historical messages and media.

Deploy Identity migration `0005_shared_phone_numbers` and import reviewed existing assignments before this Admin version. Runtime call history now uses `aidacalls_db`; `aida_admin_db` still stores this application’s local state. See the infrastructure repository’s shared-number rollout guide for a data-preserving existing-database migration.

Live text observation and ordinary-telephone acceptance: [runbook](docs/LIVE_TRANSCRIPT_TESTING.md).

## Health version and Pacific timezone

The liveness response includes `version` (`YYYY.M.D.H.M`), full Git `revision`,
`sourceUpdatedAt` (ISO 8601 with Pacific offset), `timeZone` (`America/Los_Angeles`),
and `dirty`. Existing status fields and readiness behavior are preserved.
`GET /healthz` stays independent of authentication and external dependencies.

Versions use HEAD's committer timestamp in Pacific time (PST/PDT), never build time.
For example, `2026-09-14T21:30:42Z` becomes `2026.9.14.14.30` and
`sourceUpdatedAt: "2026-09-14T14:30:42-07:00"`. The clock belongs to the machine
creating the commit, including GitHub for web-created commits. Rebuilding a commit
preserves its version. Same-minute commits and the repeated autumn DST hour are
distinguished by `revision`; dates alone are not a monotonic sequence.

`npm run build` embeds identity in the artifact. Uncommitted/staged/untracked changes
append `-dirty`; commit before building releases. Unbuilt source development reports
`unbuilt` with null revision fields. Package and API contract versions stay separate.
Runtime `TZ` defaults to `America/Los_Angeles` and may be overridden explicitly;
version formatting always stays Pacific. Docker includes timezone data. Explicit UTC
storage/protocol timestamp contracts remain UTC to preserve existing data semantics.

Docker/source archive builds require all three values: `BUILD_REVISION` (full SHA),
`SOURCE_DATE_EPOCH` (Git committer epoch), and `BUILD_DIRTY` (`true` or `false`).
Missing or malformed identity fails the build. The wrapper derives them from Git:

```sh
scripts/with-build-info.sh sh -c 'docker build \
  --build-arg BUILD_REVISION --build-arg SOURCE_DATE_EPOCH --build-arg BUILD_DIRTY \
  -t aidaadmin:local .'
```

# Hardware settings commentary

For the live takeover button to immediately auto answer, handset may need special provisioning.

## Grandstream GXV 3450

Account (1) -> Call Settings -> Auto-Answer: "Intercom/Paging Only"

Config file shows following changes when this is set-

```<!-- Auto Answer Configuration for Account 1 -->
<P2981>1</P2981> <!-- Enable Auto Answer -->
<P2983>1</P2983> <!-- Enable Auto Answer Call Waiting -->
<P2860>1</P2860> <!-- Enable Intercom Barging -->
<P2862>3</P2862> <!-- Intercom Auto Answer Mode (Open Handset/Speakerphone) -->
<P2863>1</P2863> <!-- Mute on Intercom Auto Answer -->
```

External orchestrators building this Dockerfile must forward these same build args.
No runtime Git checkout or version environment override is needed.
