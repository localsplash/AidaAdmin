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
- `GET /api/session` — current session (401 until phase 2 wires real `id` login)

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

## POC phase status

This repository is being built in the ordered phases tracked as GitHub issues:

1. **#10 Bootstrap application and CI — this codebase**
2. #8 `id` login, sessions, CIDR-trusted events
3. #11 NocoDB AidaConfiguration schema and repositories
4. #12 Tenants, users, extensions, ring groups, provisioning
5. #13 Assistant profiles, DID routes, appearance
6. #9 AidaControl runtime proxy over CIDR trust
7. #14 Live operations and takeover UI
