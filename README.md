# AidaAdmin

AidaAdmin handles business and tenant administration for Echo/Aida. Identity
owns users, tenants, roles, memberships, sessions and shared number assignments.
Asterisk owns PBX extensions, queues, queue membership and effective routing.
OfficePulseAidaIntegration supplies the private PBX inventory API.

## Active administration

Super Admins manage tenants and users; Tenant Admins manage their enabled tenant.
Identity introspection checks each authenticated request so disabled memberships,
revoked sessions and privilege changes take effect immediately. USER members can
use Echo but cannot sign in to AidaAdmin.

Numbers are the shared Identity E.164 registry. Assignment grants voice/messaging
access to enabled tenant members; it does not configure carrier service or PBX
routing. Assistant profiles and tenant appearance remain business configuration.

Extensions and queues are read-only OfficePulse API views of saved Asterisk
configuration. Endpoint IDs can differ from dialable extension numbers. Actual
registrations, queue execution and file-owned routing require PBX operations
verification. The existing live operations view and audited call-command modules
remain; takeover controls are unavailable until OfficePulse implements native
queue routing. Native DID editing, device
enrollment and handset administration are outside this release; the native
queue/AI contract and authenticated OfficePulse operations UI remain future work.

## Storage

| Store                   | Owner                 | AidaAdmin use                                                           |
| ----------------------- | --------------------- | ----------------------------------------------------------------------- |
| `platform_db`           | Identity              | Authenticated API only; no local directory/session copies               |
| NocoDB `PlatformConfig` | Platform applications | `cfg_tbl_Setting` plus three Aida business tables                       |
| `aida_admin_db`         | AidaAdmin             | OAuth state, Identity event receipts/cursor, audit and migration ledger |
| `aidacalls_db`          | OfficePulse           | Read-only integration call/event/dependency diagnostics                 |
| Asterisk MariaDB        | Asterisk              | Read-only inventory through OfficePulse; no direct Admin connection     |

The only Aida configuration tables are `aida_tbl_TenantProfile`,
`aida_tbl_AssistantProfile` and `aida_tbl_Appearance`. No extension, ring-group,
DID projection, provisioning/sync ledger or device enrollment schema is created.
The supplied host runbook identifies `asterisk.cdr` as native call history;
`aidacalls_db` is separate integration diagnostics. Native CDR/recording API access
and live-call validation remain open in [#29](https://github.com/localsplash/AidaAdmin/issues/29).

## Setup

Use Node 22 or the supplied Dockerfile. `NOCODB_BASE_URL` and `NOCODB_API_TOKEN`
are server-only bootstrap values. Settings load from PlatformConfig
`cfg_tbl_Setting` with precedence: nonblank environment, `app=aida-admin`,
`app=aida`, then `app=*`. Applicable duplicate keys are errors. Connection changes
require restart. Runtime never creates a missing base or schema.

`OFFICEPULSE_API_BASE_URL` is the canonical private API setting. It must point to
the integration API's own ingress, not the host's phone-provisioning TLS port 80
or SIP TLS port 443. There is no old provisioning-URL alias or legacy write flag.
See [.env.example](.env.example).

```sh
npm ci
npm run nocodb -w server -- create
npm run nocodb -w server -- upgrade
npm run nocodb -w server -- validate
npm run typecheck
npm test
npm run build
npm start
```

`create` is an explicit bootstrap command; the platform bootstrap owns
`cfg_tbl_Setting`. Numeric `iTenantId` values come from Identity. Tenant profile
revisions use read/compare/write and require a single administrative writer.

## DEV reset and validation

This deployment is disposable DEV. Remove obsolete objects and data using
[DEV_RESET.md](docs/DEV_RESET.md); historical backup/import/rollback-window
requirements are not prerequisites for this DEV cleanup. Deploy the matching
OfficePulse service with its obsolete configuration graph/provisioning readers removed
before deleting the shared NocoDB PBX graph. AidaHandset and AidaAgent are deferred.

The container listens on 3001. `/healthz` is liveness; `/readyz` reports persistence,
configuration and integration-runtime readiness. Browser mutations use CSRF
protection, browser `X-Aida-*` headers are stripped, and Identity webhook admission
uses configured source/proxy CIDRs. No arbitrary upstream proxy is exposed.

Unit/component tests use no credentials. MySQL integration requires a disposable
`AIDA_ADMIN_TEST_DATABASE_URL`; NocoDB integration requires dedicated test bootstrap
credentials. CI runs Node 22, MySQL integration, browser smoke and container smoke.
These checks do not prove real Identity login, PBX SQL compatibility, native call
history, recording authorization or live queue/call behavior.
