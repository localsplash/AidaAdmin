# AidaAdmin

Administration UI and backend-for-frontend for the Aida Office POC. A React/TypeScript
single-page application is served by a Node.js (Express) server that owns every
credentialed integration — `id` sessions, NocoDB writes, OfficePulse provisioning, and
AidaControl runtime proxying. The browser talks only to same-origin AidaAdmin endpoints
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
credential on the existing server, fully separate from AidaControl's `aida_runtime`).
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

## NocoDB AidaConfiguration (POC phase 3)

AidaAdmin's server owns the NocoDB `AidaConfiguration` base (cloud NocoDB; configure
`NOCODB_BASE_URL`, `NOCODB_API_TOKEN`, `NOCODB_BASE_ID` — values never live in the
repo). Only server-side code holds the token; the browser, AidaHandset, OfficePulse,
and Asterisk never reach NocoDB. AidaControl reads the same base at call time.

Schema automation (versioned in `server/src/nocodb/schema.ts`):

```bash
npm run nocodb -w server -- create     # build the schema in an empty base
npm run nocodb -w server -- validate   # drift report; exits 1 on drift
npm run nocodb -w server -- upgrade    # additive apply; never drops or retypes
npm run nocodb -w server -- seed       # idempotent dedicated POC records
```

Upgrades are strictly additive: missing tables/columns are created, live-only
tables/columns are only reported, and a type mismatch is reported for a human —
nothing is ever dropped or retyped automatically. Repositories put the tenant scope
in every query, enforce the spec's uniqueness rules (NocoDB has no multi-column
unique constraints) and E.164/MAC/context normalization, use optimistic `revision`
checks on every update, and append immutable audit records. No SIP secret has a
column anywhere; extensions store only the enrollment token hash. With NocoDB
configured, `tenant_user` also backs the phase 2 login directory.

Unit tests isolate the repository interface with an in-memory NocoDB fake;
`server/test/nocodb.integration.test.ts` runs against the real base whenever the
three NocoDB variables are set (it creates dedicated, clearly-labeled records).

## POC phase status

This repository is being built in the ordered phases tracked as GitHub issues:

1. **#10 Bootstrap application and CI — done**
2. **#8 `id` login, sessions, CIDR-trusted events — done**
3. **#11 NocoDB AidaConfiguration schema and repositories — this change**
4. #12 Tenants, users, extensions, ring groups, provisioning
5. #13 Assistant profiles, DID routes, appearance
6. #9 AidaControl runtime proxy over CIDR trust
7. #14 Live operations and takeover UI
