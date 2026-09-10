# Asterisk source of truth

Asterisk owns extensions, queues, queue membership, trunks and effective routing.
OfficePulseAidaIntegration owns the PBX integration API and its operations UI.
AidaAdmin owns business administration through Identity, business profiles and
appearance. There is no separate AidaOfficePbxAdmin application. AidaHandset and
AidaAgent work remains deferred. See the [cross-project decision](https://github.com/localsplash/identity/blob/dev/docs/PBX_OWNERSHIP.md).

## POC API boundary

Browser uses `/admin/tenants/:tenantId/extensions`, `.../queues` and
`.../did-routes`. AidaAdmin checks fresh Identity tenant-administrator membership
before calling the tenant-scoped OfficePulse `/v1/admin/pbx` API. Super Admin
can select other tenants. The client verifies the returned tenant and source
and strips unapproved fields. SIP secrets are never part of inventory; a newly
created extension's secret is disclosed once after its transaction commits.

OfficePulse uses a dedicated SELECT-only PBX account and explicit
`PBX_INVENTORY_TENANTS_JSON` tenant-to-context/queue mappings. Enable
`PBX_INVENTORY_ENABLED` and configure those reviewed mappings before rollout.
Missing mappings, query failures and incompatible schema produce errors.
Inventory describes persisted PBX configuration, not live registrations.

Native writes require OfficePulse's separately enabled writer and reviewed
tenant mappings. There is no local PBX projection, synchronization retry,
enrollment or secret-rotation API. No duplicate PBX state or sync status is
required. See [NATIVE_PBX_ADMINISTRATION.md](NATIVE_PBX_ADMINISTRATION.md) for the
extension, queue and managed DID contract. The existing live operations view and audited call-command modules
are retained. Takeover controls are unavailable until native queue routing exists;
OfficePulse returns `native_destination_unavailable` or `voice_unavailable` with
503 before it creates a command record. These are runtime call operations, not
a local PBX configuration. The obsolete local extension/ring-group/DID graph is removed
from code and must be deleted from this disposable DEV base.

## Host runbook evidence

The supplied runbook identifies PJSIP Realtime `ps_endpoints`, native `queues`
and `queue_members`. Queue `ringall` is a strategy, not a ring-group object.
Endpoint IDs are not automatically dialable extension numbers. Effective DID
routing also lives in `/etc/asterisk/extensions.conf`, while some trunks use
`pjsip_wizard.conf`; inventory SQL cannot describe or replace those files.

Native call history is UTC `asterisk.cdr`; `userfield` contains the recording
basename. `aidacalls_db` is separate integration diagnostics. Native CDR pagination,
verified tenant attribution and authorized recording access remain unfinished.
A filename supplied by a browser must not grant recording access.

TLS port 80 serves phone provisioning; TCP 443 serves SIP TLS. The integration
API needs separate private ingress. `OFFICEPULSE_API_BASE_URL` refers to that API,
not a phone-facing listener. The private service API's CIDR admission is not
human authorization for a browser operations UI.

## Remaining work

Native extension, queue and managed DID controls now use OfficePulse's native
API. AI-profile integration remains separate. OfficePulse owns how call handling
resolves native PBX destinations without the obsolete configuration graph.
Keep operator-managed PBX file routing intact; do not
reconstruct it from deleted UUID projections. Live-call, native history/recording
and authenticated operations-UI work remain in [#29](https://github.com/localsplash/AidaAdmin/issues/29).
Identity tenant merge semantics remain in [#31](https://github.com/localsplash/AidaAdmin/issues/31).

This DEV has no data-preservation or rollback-window requirement. Follow
[DEV_RESET.md](DEV_RESET.md) for exact obsolete object removal after the matching
application cleanup is deployed.
