# Native PBX administration

AidaAdmin administers native OfficePulse/Asterisk records through its authenticated same-origin backend. Identity owns people, tenant roles, selected tenant and enabled voice-number assignment. OfficePulse owns native PBX configuration and effective routing; AidaAdmin does not write Asterisk SQL or files. Assistant profiles and appearance remain separate business configuration in PlatformConfig.

## Contract and authorization

The backend introspects the Identity application session on every request. Each PBX handler requires Tenant Admin access (or Super Admin), an enabled exact tenant, and that same selected tenant. The numeric `iTenantId` comes from this projection. Browser `X-Aida-*` headers are stripped; query/body tenant or role overrides are rejected. All browser mutations require the existing CSRF proof and cookie protections.

The server-only `OFFICEPULSE_API_BASE_URL` points to the admitted private OfficePulse API; the previous `OFFICEPULSE_PROVISIONING_BASE_URL` setting remains a compatibility alias. The canonical setting takes precedence. Never place the private URL or PBX credentials in Vite/browser configuration. Native requests have a ten-second timeout, forbid redirects, URL-encode path components (especially E.164 `+` as `%2B`), and carry the server correlation ID.

| Same-origin path under `/admin/tenants/:tenantId` | Method     | OfficePulse path under `/v1/admin/pbx`                                       |
| ------------------------------------------------- | ---------- | ---------------------------------------------------------------------------- |
| `/extensions`                                     | GET/POST   | `/extensions?iTenantId=N`                                                    |
| `/extensions/:extension`                          | DELETE     | `/extensions/:extension?iTenantId=N`                                         |
| `/queues`                                         | GET/POST   | `/queues?iTenantId=N`                                                        |
| `/queues/:queue`                                  | DELETE     | `/queues/:queue?iTenantId=N`                                                 |
| `/queues/:queue/members/:extension`               | PUT/DELETE | `/queues/:queue/extensions/:extension?iTenantId=N`                           |
| `/did-routes`                                     | GET        | `/dids?iTenantId=N` left-joined to all Identity-assigned tenant Numbers      |
| `/did-routes/:did`                                | PUT/DELETE | `/dids/:did?iTenantId=N` after rechecking Identity and OfficePulse ownership |

Request schemas and native response types are in `server/src/officepulse/pbx-contract.ts`. Shared OfficePulse OpenAPI and HTTP fixtures live in `server/test/fixtures`; changes must be copied from the companion repository and tested on both sides. Local validation returns 400, upstream validation 422, missing records 404, conflict 409, unavailable dependencies 503, and unrecognized upstream failures 502. Responses contain safe copy and a correlation ID, never raw upstream bodies/SQL. Audits record actor, tenant, action, object reference, correlation ID, status and outcome; create responses and credentials never enter audit payloads.

## Screens and lifecycle

- Extensions list native IDs, dialable numbers, caller ID, context and activation state. Create discloses SIP username/secret once. Dismissal or tenant navigation destroys that disclosure state; inventory/retries cannot reopen it, and no browser storage is used. Losing the secret requires a future rotation capability. Contexts and formatted caller IDs are constrained to the installed 40-character Asterisk columns. Create/delete operates on OfficePulse-generated `<extension>-tN` bundles; imported endpoints remain operator managed. Delete confirmation explains removal of saved queue memberships. Edit, rotation and handset-enrollment controls are retired.
- Queues replace Ring Groups. Friendly names become native `tN.slug` IDs, or explicitly mapped native legacy names. Membership edits compute minimal PUT/DELETE differences and retain a partial-success baseline for retry. Penalty is 0–100; paused is Boolean. Imported member interfaces remain read-only. A referenced-queue conflict links to Numbers.
- Numbers is the canonical tenant screen: every Identity assignment appears once, including disabled numbers. Each card attaches its PBX state: configured, unconfigured, manual/operator managed, PBX scope missing, or unavailable. Missing OfficePulse entries mean missing scope, not permission to create a route. Identity loads independently of DID/queue inventory; OfficePulse failures retain Numbers and metadata editing while disabling routing actions. A single number opens its routing editor automatically without submitting defaults; multiple numbers have independent expandable editors and no global DID selector. The separate DID navigation and unpublished page are removed without a redirect. Unconfigured routes in scope may be created only for enabled Identity voice numbers; manual and unknown routes cannot be adopted. The form requires an owned queue, 1–12 rings, and optionally local business hours, weekdays and a valid IANA timezone. The queue timeout is approximately five seconds per ring and the returned value is shown. LiveKit is the only destination provider; an advanced E.164 destination override defaults to the DID. Assistant profiles are not sent as PBX destinations.

During scheduled hours the queue rings before LiveKit; outside hours callers go directly to LiveKit. Without a schedule, the queue is always open before LiveKit. Disabling a managed DID route deletes PBX routing only; it does not disable/reassign the Identity number, carrier, messaging or assistant profile.

Every mutation disables duplicate submits. Recoverable failures preserve inputs. Successful writes refresh affected inventory. Tenant changes unmount forms/disclosures and ignore late responses. Controls have accessible labels, fieldsets and live errors/status; destructive operations require explicit browser confirmation.

`committed` means only that the OfficePulse database transaction committed. `active` may be displayed only if OfficePulse supplies verified effective state; this OfficePulse implementation never returns active. Native inventory can report activation unknown. A static DID in operator-owned `extensions.conf` can still win over Realtime rows, and PJSIP/queue caches can lag committed SQL. A database success must not be presented as proof of an active telephone route.

## Deployment, cleanup and rollback

1. Deploy the companion OfficePulse contract, least-privilege grants and explicit tenant ownership maps. An operator must install the shared `aida-managed-did-v1` include and one generic Realtime lookup on the reviewed ingress context before routing calls. Managed DID destinations, schedules, queues and fallbacks live in Realtime data rows; remove the corresponding DID-specific static route after its managed rows exist.
2. Deploy this backend with server-only OfficePulse URL, central Identity session/directory access and audit persistence. Verify a Tenant Admin and Super Admin across two tenants before exposing mutations.
3. Expose the UI after inventory and managed-DID readback succeed. `provisioningEnabled=false` keeps inventory read-only. An unavailable OfficePulse endpoint is not treated as empty inventory.

Legacy extension/ring-group/DID routes, payload builders and retry controls are removed. Runtime provisioning/fallback views and SQL accessors are retired. The former NocoDB PBX repositories and schema definitions are removed, preserving the existing DEV cleanup. Follow [DEV_RESET.md](DEV_RESET.md) for operator-managed removal of obsolete data. No data deletion or migration into native routing is automatic.

The disposable DEV cleanup removes `aida_tbl_Extension`, `aida_tbl_RingGroup`, `aida_tbl_RingGroupMember`, `aida_tbl_DidRoute`, and obsolete handset/projection fields using the exact scope in the reset runbook. Preserve `aida_tbl_AssistantProfile`, tenant business metadata, appearance, Identity assignments and audit history. Legacy records must never be silently replayed into PBX configuration.

Rollback hides/disables mutation UI or disables the OfficePulse writer, preserving existing PBX objects. A frontend/backend rollback must retain the compatible native API contract; never automatically reinstate the legacy NocoDB synchronization workflow. Restoring PBX routes is an independent operator-owned change using reviewed exports, not an AidaAdmin migration.

## Validation and limits

Run `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, then `npm run test:e2e`. The native browser tests use the real BFF authorization/session/CSRF handlers against disposable Identity and PBX fakes; they exercise create/disclosure, queues/members, schedule/readback, conflicts, deletion, tenant restriction and Super Admin switching. Unit tests additionally capture logs/audits for SIP-secret regression and check exact native method/path/body/error contracts.

These tests do not establish live Identity authentication, carrier calling, effective Asterisk reload/cache state, recording behavior or static-route precedence. External release evidence must cover overlapping extension numbers for two tenants, native queue membership, during/outside-hours calls, timeout-to-LiveKit, answered queue without AI, secret handling, cross-tenant denial and orphan-free deletion while Identity numbers remain assigned. Follow the companion OfficePulse runbook before calling the POC operationally complete.
