# AidaAdmin

Administration UI and backend-for-frontend for the Aida Office POC. A React/TypeScript
single-page application is served by a Node.js (Express) server that owns every
credentialed integration — `id` sessions, NocoDB writes, OfficePulse provisioning, and
OfficePulse runtime reads and actions. The browser talks only to same-origin AidaAdmin endpoints
and never receives service credentials.

Normative specification:
[AIDA_POC_DATABASE_AND_INTERFACE_SPECIFICATION.md](https://github.com/localsplash/AidaInfrastructureSetupInstructions/blob/main/docs/AIDA_POC_DATABASE_AND_INTERFACE_SPECIFICATION.md)

## Repository layout

| Path                       | Contents                                                                             |
| -------------------------- | ------------------------------------------------------------------------------------ |
| `server/`                  | Express backend-for-frontend: config, logging, health, session surface               |
| `server/src/contracts/`    | Consumption boundary for generated cross-service contract types                      |
| `web/`                     | React application (Vite): shell, routing, tenant-context banner, status screens      |
| `e2e/`                     | Playwright browser smoke test                                                        |
| `.github/workflows/ci.yml` | Format, lint, typecheck, unit/component tests, build, browser smoke, container tests |

## Prerequisites

- Node.js >= 22 and npm
- Docker (only for building the container image)

## Local commands

```bash
npm ci                 # install all workspace dependencies
npm run dev            # start server (:3001) and Vite dev server (:5173, proxies /api)
npm test               # unit + component tests (no provider credentials needed)
npm run typecheck      # TypeScript across all workspaces
npm run lint           # ESLint
npm run format:check   # Prettier
npm run build          # compile server and bundle web
npm run test:e2e       # browser smoke test (requires npm run build first)
npm start              # run the built server (serves web/dist when present)
```

Unit and component tests run without any provider credentials. To exercise the app
against real non-production services, copy `.env.example` to `.env` and fill in the
documented non-production `id` and NocoDB values (never commit real values).

## Configuration

All configuration is environment variables, validated with Zod at startup
(`server/src/config.ts`). Outside production, missing service configuration is
tolerated and reported by name at `GET /readyz`. In production, startup fails and the
error names every missing variable — names only, never values. The complete variable
list with descriptions is in [`.env.example`](.env.example).

`E2E_FAKE_SESSION=true` (non-production only; production startup refuses it) makes
`GET /api/session` return a fake Super Admin session so the browser smoke test can
render the authenticated shell without credentials.

## Operational endpoints

- `GET /healthz` — liveness
- `GET /readyz` — readiness, including missing-configuration variable names
- `GET /api/session` — current session (401 when signed out)
- `GET /api/auth/login` — starts the `id` login redirect (`/authorize` with `state`)
- `GET /api/auth/callback` — redeems the one-time code server-to-server and creates the session
- `POST /api/auth/logout` — revokes the local session (CSRF-protected)
- `POST /id/events` — identity-event receiver, trusted by source IPv4 only
  (`ID_EVENT_SOURCE_CIDRS`, with `X-Forwarded-For` honored solely from
  `ID_TRUSTED_PROXY_CIDRS` peers)

## Authentication (POC phase 2)

Login is delegated to the platform `id` service: the browser is redirected to
`{ID_BASE_URL}/authorize` with a single-use `state` and the exact callback URL, and the
returned one-time code is redeemed server-to-server at `/api/token`. Trust is TLS plus
IPv4 allowlisting (`ID_TRUSTED_APP_CIDRS`, enforced by `id`); there is deliberately no
`ID_CLIENT_SECRET`, webhook HMAC, or password store in this repository. `superAdmin` is
consumed from the `id` token response and never recalculated locally. A Super Admin may
enter without a tenant mapping; every other user needs an enabled `tenant_user` record
(none exist until phase 3 lands the NocoDB repositories, so non-super-admins are denied).

Sessions, single-use login states, and the identity-event log live in AidaAdmin's own
PostgreSQL database (`AIDA_ADMIN_DATABASE_URL` — the `aida_admin` database with its own
credential on the existing server, fully separate from OfficePulse's `aida_officepulse`).
The browser holds only an opaque, httpOnly, signed session cookie; the database stores
a hash of it, never the value. The additive schema (`admin_session`, `auth_state`,
`identity_event`, `identity_event_checkpoint`) is migrated automatically at startup.
Without a database URL (credential-less dev and unit tests), memory-backed stores with
identical semantics are used.

Identity events (`session.revoked`, `user.merged`, `identity.linked/unlinked`) arrive
at `/id/events` and are processed in one transaction: record the event by `event_id`
(duplicates short-circuit), apply session revocation/merging, mark it processed, and
advance the checkpoint — committed together, with 2xx returned only after commit so
`id` retries anything that failed. Because `id`'s `/api/token` response carries no
session identifier, a `session.revoked` of any scope revokes **all** local sessions
for that user (the POC decision — strictly safer than under-revoking). On boot the
server catches up via `GET {ID_BASE_URL}/api/events?since=<checkpoint>` (paging past
id's 200-event response limit) and, when `ID_REGISTER_WEBHOOK=true`, re-registers the
receiver.

Every response carries an `x-correlation-id` header (inbound value echoed when
well-formed). Logs are structured JSON with credential-bearing fields redacted.
State-changing `/api` and `/admin` requests require the double-submit CSRF token
issued alongside `GET /api/session`.

## Container

```bash
docker build -t aida-admin .
docker run --rm -e NODE_ENV=test -p 3001:3001 aida-admin   # smoke-run without credentials
```

The runtime image is non-root (`USER node`) and contains production dependencies plus
built artifacts only. In production, supply every variable from `.env.example`;
startup fails otherwise, naming the missing variables.

## NocoDB AidaAdmin base (POC phase 3)

AidaAdmin's server owns its NocoDB configuration base. Only the instance and the
credential are configuration (`NOCODB_BASE_URL`, `NOCODB_API_TOKEN` — values never
live in the repo). Only server-side code holds the token; the browser, AidaHandset,
OfficePulse, and Asterisk never reach NocoDB. OfficePulse reads the same base at call
time (read-only, by name).

**The base is addressed by name, never by a configured id.** The name is hardcoded as
`AidaAdmin` (`server/src/nocodb/base.ts`); the id is discovered at startup and held for
the process lifetime. A base id is an opaque per-instance value nobody can know before
the base exists, so requiring it as configuration guarantees a broken first deployment.
On boot the server finds the base by name — matching ignores case, because NocoDB keeps
whatever capitalisation it was created with — creates it if absent, and brings the
schema up to date. Exactly one base may carry the name; two is an operator error the
server refuses to resolve by guessing. A NocoDB outage at boot is not fatal or sticky:
resolution is retried on the next configuration call.

Schema automation (versioned in `server/src/nocodb/schema.ts`):

```bash
npm run nocodb -w server -- validate   # drift report; exits 1 on drift
npm run nocodb -w server -- upgrade    # additive apply; never drops or retypes
npm run nocodb -w server -- seed       # idempotent dedicated POC records
npm run nocodb -w server -- create     # same as upgrade; startup does this for you
```

Startup already resolves the base and applies the schema, so none of these are
required for a normal deployment — `validate` and `seed` remain useful by hand.

Upgrades are strictly additive: missing tables/columns are created, live-only
tables/columns are only reported, and a type mismatch is reported for a human —
nothing is ever dropped or retyped automatically. Repositories put the tenant scope
in every query, enforce the spec's uniqueness rules (NocoDB has no multi-column
unique constraints) and E.164/MAC/context normalization, use optimistic `revision`
checks on every update, and append immutable audit records. No SIP secret has a
column anywhere; extensions store only the enrollment token hash. With NocoDB
configured, `tenant_user` also backs the phase 2 login directory.

## Platform users (the `AidaIdentity` base)

There is one platform person record — `id_tbl_User.iUserId` in the `id` service's MySQL
database — and AidaAdmin never copies it. Connect that database to NocoDB as a base named
**`AidaIdentity`** and AidaAdmin reads users from it directly. Like the AidaAdmin base it is
found by name, ignoring case, with nothing to configure; unlike it, it is **never created**,
because an auto-created empty base of that name would shadow the real one and report that the
platform has no users.

Which door each operation uses is deliberate:

| Operation                    | Source                                          | Why                                                                                                                                          |
| ---------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| List, search, look up a user | `AidaIdentity` base, falling back to `id`'s API | The whole directory in one call instead of a keyset-paged search, and it survives `id`'s API being unreachable                               |
| Edit a display name          | `AidaIdentity` base only                        | `id` publishes no endpoint that updates a user                                                                                               |
| Create a user by email       | `id`'s ensure endpoint only (`ID_BASE_URL`)     | The email-uniqueness advisory lock and idempotency keys live there; inserting a row directly would trade that guarantee for duplicate people |

Without the base, the directory still lists and creates through `id` — only display-name
editing is unavailable, and the screen says so rather than hiding the reason. The startup log
reports which of the two is in play.

## Roles

`superAdmin` comes from the `id` token response and is never recalculated locally; every other
role is a `tenant_user` record.

|                                                                                               | Super Admin | TENANT_ADMIN                          | USER  |
| --------------------------------------------------------------------------------------------- | ----------- | ------------------------------------- | ----- |
| Create tenants, grant Super Admin                                                             | yes         | no                                    | no    |
| See the tenants list                                                                          | all tenants | the ones they administer              | empty |
| Everything within a tenant — users, extensions, ring groups, profiles, DID routes, appearance | any tenant  | their own only                        | no    |
| Switch tenant context                                                                         | yes         | only if they administer more than one | n/a   |

A tenant administrator who belongs to exactly one tenant is placed in it by the server on
sign-in and is shown no tenant switcher — there is nothing to choose. They also cannot remove
their own administrator access to a tenant; only a Super Admin can. The tenant id a request
acts on is read from the route or the body, and a tenant-scoped route carrying neither is
denied rather than admitted.

Extensions carry an optional `identity_user_id`: one platform user answers an extension, and
one user may answer several. The user must already be a member of the same tenant, so an
extension can never be a back door into a tenant someone was never given.

Unit tests isolate the repository interface with an in-memory NocoDB fake;
`server/test/nocodb.integration.test.ts` runs against the real base whenever the
three NocoDB variables are set (it creates dedicated, clearly-labeled records).

## Tenant and telephony administration (POC phase 4)

Super Admin routes under `/admin` (session + `superAdmin` required, CSRF-protected)
cover the complete top-level workflow: tenant CRUD; central-user search/ensure via
`id`'s directory API with `tenant_user` role assignment (the mapping stores only
`iUserId` — never name or email); extension CRUD; RING_ALL ring groups with members
and a 20-second default timeout; and Super Admin grants.

Provisioning is transactional-per-request with no background reconciliation: the
intended record is saved to NocoDB, then OfficePulseAidaIntegration is invoked
immediately, and any PBX failure is returned to the administrator clearly. OfficePulse
generates each SIP secret, stores it only in Asterisk's `ps_auths`, and returns it
once — AidaAdmin relays it to the administrator a single time and never persists or
logs it. Handset enrollment issues a one-time token: NocoDB stores only its hash, the
plaintext goes once to the configured provisioning service
(`HANDSET_PROVISIONING_URL`) and once to the administrator's screen, and rotating with
`reprovisionDevice` bumps `device_credential_version` to revoke issued device
credentials.

## Screening configuration (POC phase 5)

Assistant profiles carry the complete inbound-screening configuration: business name,
prompt, tone, objective, and the opening/transfer/failed-transfer statements, with
explicit save/validation and an enabled state. LiveKit model, STT, TTS, and voice are
deliberately not configurable — the predefined `aida-prime` agent supplies those
defaults and the POC neither stores nor sends them.

DID routes bind a normalized, globally unique E.164 DID to exactly one profile and
exactly one EXTENSION or RING_GROUP destination (the takeover/failure fallback, shown
as a preview in the editor). Saving a route validates the destination union, tenant
scope, and profile state (an enabled route cannot reference a disabled profile) and
immediately provisions the DID to OfficePulse with the tenant context and the
`/bootstrap` FastAGI path; failures are reported clearly with the record saved.

Appearance is single-brand: brand name, primary color, and a same-origin validated
logo upload (PNG/JPEG only, magic-byte checked, 512 KB cap, content-addressed name
served from `/assets`; `ASSET_STORAGE_DIR` sets the storage location). CRM import and
conversation history are visibly marked as future scope.

## Runtime visibility and actions (issue #29)

For the POC there is no AidaControl: **OfficePulseAidaIntegration is the call
orchestrator** (its issue #9) and the sole writer of its `aida_officepulse` runtime
database. AidaAdmin gives Super Admins and tenant administrators enough visibility to
deploy and debug real calls without shell or database access, along two doors:

|                                                                                                                                                         | Door                                                                                 | Credential                                                                                        | Why                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Reads — calls, timelines, takeover progress, LiveKit participants, dependency status, provisioning history, webhook deliveries, DID fail-safes, orphans | `OFFICEPULSE_RUNTIME_DATABASE_URL` → `aida_officepulse`                              | the **read-only** `aidaadmin_ro` account from OfficePulse's `deploy/sql/grants.sql` (SELECT only) | one query answers what a proxy would need several calls for, and it works when OfficePulse's API is down |
| Actions — takeover, dependency test, retry provisioning                                                                                                 | `OFFICEPULSE_PROVISIONING_BASE_URL` → `/v1/calls/*`, `/readyz`, `/v1/provisioning/*` | private-LAN CIDR trust enforced by OfficePulse                                                    | commands stay HTTP actions; AidaAdmin never writes a runtime table                                       |

Read-only is a property of the grant, not of good behaviour: the reader also puts every
pooled connection in `READ ONLY` transaction mode and a test asserts it issues nothing but
`SELECT`. Column names are OfficePulse's verbatim (`deploy/sql/runtime-schema.sql`).

Scope: call views are scoped to the selected tenant for everyone — another tenant's call
is "not found", never "forbidden" — and a `USER` sees caller numbers masked to the last
four digits. Dependencies, webhook deliveries, orphans and the unfiltered call list are
Super Admin. The takeover body carries no destination: OfficePulse routes to the
destination pinned on the call at bootstrap, so a command cannot redirect a call. Every
action is audited with the actor, call, idempotency key and OfficePulse's answer.

**Orphans are detected, not cleaned.** OfficePulse exposes no cleanup endpoint and this
service will not write to its tables, so the orphans view shows lost calls and who is
still marked present, and nothing more.

**Live transcripts are not here.** They travel over LiveKit Data and OfficePulse never
persists them (no transcript table exists by design). The runtime record holds the call
lifecycle — bootstrap, screening, takeover, bridge, drain, hangup — which is what the
live-operations and call-detail screens show. Subscribing the browser to LiveKit Data
needs a viewer token endpoint and is not part of this work.

`npm run doctor -w server` and the startup log report whether each door is configured
and reachable.

## Live operations (POC phase 7)

The Live operations screen (visible once a tenant is selected) shows the active-call
list as one tab per simultaneous call, the recent-call list, and the operational error
log — all scoped by the selected tenant through the phase 6 proxy. Each call panel
renders the call state, the **live-only** transcript (explicitly not a historical
record), the current speech state, Aida's suggestions, and takeover command progress.

Durable control events are replayed per call from each call's own cursor, and the
client reducer is idempotent per sequence number: duplicated or reordered events and
reconnect replays never duplicate transcript lines or commands. A missing sequence
number is surfaced as an unrecoverable transcript gap rather than papered over.

Take over asks for confirmation, submits exactly once per attempt with
`expectedCallVersion` and a fresh idempotency key, and disables itself until the
command reaches a terminal state; ringing/answered/draining/completed/failed states
render from `command.progress` events. A `transfer.failed` event shows the reason and
that Aida resumed the call. Historical conversations are marked "Coming soon" — no
transcript-history UI exists. Browser acceptance against the deployed non-production
`id`, NocoDB, and OfficePulse services remains the final gate once those
environments are configured.

## Troubleshooting login

Run the preflight first — it prints the exact `redirect_uri` and `/authorize` URL this
deployment sends to `id`, plus anything that would break the round-trip (variable
names only, never values):

```bash
npm run doctor -w server
```

**`Invalid redirect_uri: must be an https URL under the configured parent domain.`**

This 400 comes from `id`, not from AidaAdmin. `id` accepts a redirect URI when the
host equals `PARENT_DOMAIN` **or ends with `.PARENT_DOMAIN`** — subdomain depth is not
limited, so `https://admin.aida.localsplash.ai/api/auth/callback` is valid under
`PARENT_DOMAIN=localsplash.ai` (and under `aida.localsplash.ai`). Seeing this error
therefore means the parent domain itself is wrong on the `id` side:

1. **It is empty** — the usual cause on a fresh deployment. `PARENT_DOMAIN` lives in
   NocoDB, in the `oAuthConfig` table of the `id` base (not in any `.env`); `id` seeds
   the table with empty values, and its setup wizard writes the value. Set it to the
   apex domain the apps live under, e.g. `localsplash.ai`, via `id`'s `/admin` page or
   directly in NocoDB.
2. **It has stray whitespace** — `id` lowercases the value and strips leading dots but
   does not trim it, so a trailing space or newline in the NocoDB cell makes every host
   fail to match.
3. **It names a different domain** than the one AidaAdmin is served from.

Set `ID_PARENT_DOMAIN` to the same value to have the preflight and startup check this
locally instead of leaving the browser 400 as the only signal.

## POC phase status

This repository is being built in the ordered phases tracked as GitHub issues:

1. **#10 Bootstrap application and CI — done**
2. **#8 `id` login, sessions, CIDR-trusted events — done**
3. **#11 NocoDB AidaAdmin schema and repositories — done**
4. **#12 Tenants, users, extensions, ring groups, provisioning — done**
5. **#13 Assistant profiles, DID routes, appearance — done**
6. **#9 Runtime proxy — superseded: OfficePulse runtime reads and actions (issue #29) — done**
7. **#14 Live operations and takeover UI — this change**
