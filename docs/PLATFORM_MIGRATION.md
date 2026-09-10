# Platform directory and application state

Identity is the only authority for tenants, people, memberships, roles and staff
application sessions. AidaAdmin uses the directory API with the current opaque
application-session token; it does not own parallel directory rows or sessions.

- `POST /api/token` redeems the application code and returns `appSession.token`.
- `POST /api/sessions/introspect` checks the session on each authenticated request.
- `POST /api/sessions/select-tenant` stores tenant selection centrally.
- `POST /api/sessions/revoke` revokes the application session.
- `/api/directory/*` supplies tenant, membership and user administration.
- Directory calls use private-server admission and the user's bearer session.

Identity supplies safe numeric `iTenantId` values. String tenant IDs in browser
paths are canonical decimal representations. Aida tenant profiles contain only
application metadata and reference Identity through `iTenantId`.

AidaAdmin MySQL `aida_admin_db` contains OAuth state, durable Identity receipts,
ordered replay cursor, append-only audit and the migration ledger. Fresh
introspection handles membership/tenant disable and session revocation. Tenant
merge semantics remain tracked with identity #16; no merge workflow is claimed.

The deployed environment is disposable DEV. No old UUID directory importer,
archival copies, PBX desired-state compatibility or rollback-window retention is
required. [DEV_RESET.md](DEV_RESET.md) names the obsolete objects to remove after
the corresponding application readers are retired. Active Identity users,
tenants, memberships, numbers and the three business configuration tables are
separate from that obsolete PBX graph.
