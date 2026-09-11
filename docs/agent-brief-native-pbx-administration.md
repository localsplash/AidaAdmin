# Agent implementation brief: AidaAdmin native PBX administration

## Objective

Replace AidaAdmin's retired/legacy PBX provisioning integration with tenant-authorized administration of OfficePulse's canonical `/v1/admin/pbx` API. Provide usable screens for extension create/delete, native queue create/delete and membership, and managed DID schedule/ring-to-LiveKit routing.

This brief is paired with the OfficePulseAidaIntegration native PBX provisioning brief. Implement against its accepted OpenAPI contract, not the historical `/v1/provisioning/*` client. If the upstream contract changes, update both repositories and their contract tests together.

## Required architectural decisions

- The browser calls only AidaAdmin's authenticated same-origin backend. It must never call the private OfficePulse listener directly.
- The AidaAdmin backend revalidates the Identity application session, tenant role, selected tenant, and CSRF proof before every mutation, then calls OfficePulse from its admitted server network.
- OfficePulse/Asterisk owns native extensions, queues, membership, and effective DID dialplan. Do not recreate these as NocoDB desired-state records or direct Asterisk SQL writes in AidaAdmin.
- Identity remains authoritative for tenant membership and E.164 number assignment. A DID can be managed only when it is an enabled voice number assigned to the selected tenant and OfficePulse also recognizes it in the tenant PBX scope.
- Native queues replace the prior ring-group administration path for this POC. Retire misleading ring-group creation/provisioning UI and client calls rather than silently translating simultaneous-dial records.
- LiveKit is the only AI provider. Do not expose a provider selector or retain a Retell option.
- Show the difference between an OfficePulse transaction being `committed` and effective Asterisk state being verified `active`. Never display a generic success that implies a reload/activation was confirmed when it was not.

## Backend-for-frontend contract

Create a narrow typed OfficePulse PBX client for:

- Listing native extensions, queues/members, and managed DID settings.
- Creating/deleting an extension.
- Creating/deleting a queue.
- Upserting/deleting a queue-extension mapping.
- Upserting/deleting managed DID settings.

Use the canonical Identity numeric tenant ID as `iTenantId`. URL-encode every path component, especially the leading `+` in an E.164 DID. Apply a bounded timeout and map OfficePulse 404/409/422/503 responses to safe, actionable AidaAdmin responses without exposing upstream bodies or database details.

Do not keep the historical interfaces and routes that call `/v1/provisioning/extensions`, `/v1/provisioning/ring-groups`, or `/v1/provisioning/dids`. Remove or clearly retire their retry/reprovision controls when the corresponding OfficePulse operation ledger no longer exists.

Expose same-origin AidaAdmin routes under the existing `/admin/tenants/:tenantId/...` authorization pattern. Every handler must:

1. Require an authenticated session and Tenant Admin access to that exact tenant; Super Admin remains allowed through the established policy.
2. Resolve the canonical numeric Identity tenant ID rather than trusting a browser-provided upstream ID.
3. Validate input locally with the same bounds as OfficePulse.
4. Invoke OfficePulse only after authorization and validation.
5. Append an audit record with actor, tenant, action, object type/reference, correlation ID, and outcome metadata that contains no SIP secret.

Do not persist a returned SIP secret in AidaAdmin, NocoDB, audit rows, logs, React state beyond the one-time disclosure lifecycle, browser storage, or analytics.

## Extensions screen

Replace the screen's native configuration source with OfficePulse extension inventory while preserving any separately owned Identity-person association only if it remains useful and clearly non-authoritative for PBX state.

Required operations:

- List native tenant extensions and show dialable extension, display/caller ID, context where useful, and apply/availability state supplied by OfficePulse.
- Create with extension number, display name, optional caller-ID number, and context only when the tenant has multiple approved contexts.
- Show returned SIP username and one-time secret in a modal/panel that cannot be reopened after dismissal. Include copy controls and a clear warning that losing it requires a future secret rotation capability, which is outside this scope.
- Delete with explicit confirmation that identifies the extension and notes that saved queue memberships will also be removed.

Do not offer edit, rotate-secret, or handset-enrollment actions unless their current upstream contracts still exist independently and are explicitly reconciled with the new native endpoint identity. Remove controls that would call absent legacy OfficePulse routes.

## Native queues screen

Replace or retire the Ring Groups navigation entry with `Queues`.

Required operations:

- List OfficePulse native queues and their saved members.
- Create a queue using a tenant-friendly name/slug and a small strategy selector matching the OfficePulse enum, defaulting to `ringall`.
- Delete only after confirmation. Surface the specific conflict when a DID still references the queue and link the user to DID routes.
- Edit membership using the current tenant extension inventory. Compute minimal changes and call the mapping PUT/DELETE operations; do not delete and recreate the entire queue for membership edits.
- Support optional bounded penalty and paused state without requiring advanced fields for the common case.
- Distinguish empty inventory from OfficePulse unavailable.

Avoid retaining NocoDB ring-group revisions, simultaneous-ring wording, music-on-hold controls, or background reprovision semantics in the new queue workflow unless the accepted OfficePulse contract explicitly supports them.

## DID routes screen

Rework the form around the managed DID behavior implemented by OfficePulse.

Source choices:

- DID selector: enabled voice numbers assigned to the selected tenant by Identity.
- Queue selector: current native OfficePulse queues for that tenant.
- Assistant profile association may remain an AidaAdmin-owned business/LiveKit concern, but it must not be presented as an Asterisk fallback destination or sent as an unsupported PBX provisioning field.

Editable PBX settings:

- `queue` (required).
- `ringsBeforeAi` (required integer 1 through 12). Explain that the POC derives a timeout using approximately five seconds per ring and show the derived timeout returned by OfficePulse.
- Optional business-hours schedule:
  - enable/disable schedule toggle;
  - local start and end time in `HH:MM` values normalized to `HH:MM-HH:MM`;
  - weekday selection normalized to the accepted OfficePulse/Asterisk representation;
  - required IANA timezone when schedule is enabled, defaulted from an existing tenant setting only when that setting is valid.
- Optional advanced LiveKit destination E.164, defaulting to the DID and normally hidden.

There is no provider field. User-facing copy should say:

- During scheduled hours: ring the selected queue, then LiveKit if unanswered.
- Outside scheduled hours: route directly to LiveKit.
- With no schedule: the queue is always open, then LiveKit.

Use OfficePulse's managed-DID GET response for editing. If an allowed Identity number is reported as unmanaged/manual, display that state and do not overwrite it without an explicit operator-safe adoption flow; adoption is outside this POC unless added to both contracts.

Deleting a managed DID route disables OfficePulse PBX routing only. It must not delete, disable, or reassign the Identity phone number, carrier service, message history, or assistant profile.

## State ownership cleanup

Audit the current NocoDB extension/ring-group/DID repositories, runtime provisioning/retry views, OfficePulse client, payload builders, tests, and documentation.

- Remove PBX-native desired-state and retry behavior that conflicts with the new direct OfficePulse API.
- Preserve AidaAdmin-owned business data, including assistant profiles and any clearly separated user-to-extension display association, only with an explicit ownership comment and no claim that it is effective PBX configuration.
- Do not run destructive data deletion automatically. Provide a reviewed migration/cleanup plan for obsolete NocoDB tables or fields and keep rollback/export guidance for existing data.
- Remove stale language claiming that the legacy `/v1/provisioning/*` API, `provisioning_operation`, or `did_fallback` remains canonical.

## UX and failure behavior

- Disable submit controls while a request is active and prevent duplicate submissions.
- Preserve form contents on a recoverable upstream failure.
- Present validation, conflict, unavailable, and unknown failures distinctly. Include the correlation ID for operator support, never raw upstream JSON.
- Refresh the affected inventory after a successful mutation. If the response is only `committed`, label it accordingly and do not promise the PBX is active.
- Tenant switching must cancel/ignore stale requests so records from one tenant cannot appear in another tenant's form.
- Maintain accessible labels, fieldsets, live status/error regions, keyboard operation, and confirmation semantics.

## Configuration and security

- Continue using the server-only OfficePulse base URL setting; do not expose it through Vite/browser configuration.
- Ensure browser-supplied `X-Aida-*`, `iTenantId`, or role claims cannot override server-resolved Identity authorization.
- Keep CSRF checks on all same-origin mutations and existing secure session-cookie behavior.
- Redact the one-time SIP secret from structured logging and error instrumentation. Add a regression test that searches captured logs/audit payloads for it.
- Do not add direct Asterisk database credentials, filesystem access, or Asterisk reload commands to AidaAdmin.

## Documentation and contract deliverables

- Update the typed client and server API documentation to the accepted OfficePulse `/v1/admin/pbx` contract.
- Update README/setup language to distinguish Identity number assignment, AidaAdmin business metadata, OfficePulse PBX mutations, and carrier provisioning.
- Document deployment ordering: OfficePulse contract and one-time Asterisk delegation first, AidaAdmin backend second, UI exposure last.
- Document rollback behavior: hide/disable mutation UI without deleting PBX objects; never attempt to restore the legacy synchronization workflow automatically.
- Add an operator note requiring DID-specific static routes to be removed after their managed Realtime rows exist, and explain why a database-committed result may not yet be verified active.

## Tests and acceptance criteria

Add backend tests for role/tenant authorization, canonical tenant resolution, input validation, URL encoding, exact OfficePulse method/path/body contracts, upstream error mapping, correlation/audit behavior, and SIP-secret redaction.

Add component tests for:

- Extension create/delete and one-time secret disclosure.
- Queue create/delete, member diffing, penalty/paused controls, and DID-reference conflict.
- DID schedule enabled/disabled forms, timezone and weekday validation, derived ring timeout copy, hardcoded LiveKit copy, and managed/manual states.
- Disabled/unavailable OfficePulse behavior, stale tenant request isolation, confirmation flows, and accessibility.

Add or update end-to-end coverage for a Tenant Admin restricted to its tenant and a Super Admin switching tenants. Contract fixtures must match OfficePulse's published OpenAPI rather than re-declaring a divergent legacy payload.

Before release, record integrated evidence that AidaAdmin can:

1. Create an extension and disclose its credentials once without persisting the secret.
2. Create a native queue and add/remove that extension.
3. Configure an allowed DID with a schedule and ring count.
4. Read the settings back after refresh.
5. Surface `committed` versus `active` accurately.
6. Refuse cross-tenant extension, queue, member, and DID attempts.
7. Delete the DID, queue, and extension without deleting the Identity number or leaving native PBX orphans.

## Explicit non-goals

- Editing `extensions.conf`, issuing Asterisk reload commands, or accessing Asterisk SQL from AidaAdmin.
- Provider selection or Retell support.
- Carrier number ordering/porting, messaging configuration, CDR/recording access, handset enrollment, extension update, or secret rotation.
- Automatic adoption of arbitrary/manual Asterisk routes.
- Reintroducing AidaControl or the retired provisioning synchronization/retry ledger.
