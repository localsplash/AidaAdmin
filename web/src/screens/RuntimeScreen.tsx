import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  runtimeApi,
  type CallListState,
  type DependencyRecord,
  type DidFallback,
  type LiveReadiness,
  type ProvisioningOperation,
  type RuntimeCall,
  type RuntimeParticipant,
  type WebhookDelivery,
} from '../api/runtime';
import type { SessionView } from '../api/session';
import { RuntimeErrorNotice } from '../components/RuntimeError';

type Section = 'calls' | 'dependencies' | 'provisioning' | 'fallbacks' | 'webhooks' | 'orphans';

/** Sections a tenant administrator can use; the rest are Super Admin. */
const TENANT_SECTIONS: Section[] = ['calls', 'provisioning', 'fallbacks'];

const SECTION_LABEL: Record<Section, string> = {
  calls: 'Calls',
  dependencies: 'Dependencies',
  provisioning: 'Provisioning',
  fallbacks: 'DID fail-safes',
  webhooks: 'Webhook deliveries',
  orphans: 'Orphaned calls',
};

/** Loads one section's data with its own loading / empty / error state. */
function useSection<T>(load: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const refresh = useCallback(() => {
    setLoading(true);
    load()
      .then((value) => {
        setData(value);
        setError(null);
      })
      .catch(setError)
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => {
    refresh();
  }, [refresh]);
  return { data, error, loading, refresh };
}

function CallsSection({ superAdmin }: { superAdmin: boolean }) {
  const [state, setState] = useState<CallListState>('active');
  const [tenant, setTenant] = useState<string>(superAdmin ? 'all' : '');
  const calls = useSection(
    () => runtimeApi.listCalls(state, superAdmin ? tenant || undefined : undefined),
    [state, tenant, superAdmin],
  );
  return (
    <>
      <form onSubmit={(e) => e.preventDefault()}>
        <label>
          Show
          <select value={state} onChange={(e) => setState(e.target.value as CallListState)}>
            <option value="active">Active</option>
            <option value="recent">Recent (ended)</option>
            {superAdmin ? <option value="orphaned">Orphaned</option> : null}
            {superAdmin ? <option value="all">All</option> : null}
          </select>
        </label>
        {superAdmin ? (
          <label>
            Tenant id (or all)
            <input value={tenant} onChange={(e) => setTenant(e.target.value)} />
          </label>
        ) : null}
        <button type="button" onClick={calls.refresh}>
          Refresh
        </button>
      </form>
      {calls.error ? <RuntimeErrorNotice error={calls.error} /> : null}
      {calls.data === null ? (
        <p role="status">{calls.loading ? 'Loading…' : ''}</p>
      ) : (
        <CallsTable calls={calls.data.calls} />
      )}
    </>
  );
}

function CallsTable({ calls }: { calls: RuntimeCall[] }) {
  if (calls.length === 0) return <p>No calls match.</p>;
  return (
    <table>
      <caption className="visually-hidden">Call sessions</caption>
      <thead>
        <tr>
          <th scope="col">Started</th>
          <th scope="col">Tenant</th>
          <th scope="col">DID</th>
          <th scope="col">Caller</th>
          <th scope="col">Disposition</th>
          <th scope="col">State</th>
          <th scope="col">Config (route rev / profile rev)</th>
          <th scope="col">Ended</th>
        </tr>
      </thead>
      <tbody>
        {calls.map((call) => (
          <tr key={call.id}>
            <td>
              <Link to={`/runtime/calls/${encodeURIComponent(call.id)}`}>{call.createdAt}</Link>
            </td>
            <td>{call.tenantId}</td>
            <td>{call.didE164}</td>
            <td>{call.callerNumber ?? '—'}</td>
            <td>{call.disposition}</td>
            <td>{call.state}</td>
            <td>
              {call.config.didRouteRevision ?? '—'} / {call.config.profileRevision ?? '—'}
            </td>
            <td>{call.endedAt ?? 'open'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function DependenciesSection() {
  const deps = useSection(() => runtimeApi.dependencies(), []);
  const [live, setLive] = useState<LiveReadiness | null>(null);
  const [testing, setTesting] = useState(false);
  const [testError, setTestError] = useState<unknown>(null);
  const snapshot = live ?? deps.data?.live ?? null;

  const test = async () => {
    setTesting(true);
    setTestError(null);
    try {
      setLive((await runtimeApi.testDependencies()).live);
    } catch (err) {
      setTestError(err);
    } finally {
      setTesting(false);
    }
  };

  return (
    <>
      <p>
        Recorded by OfficePulse on every transition (from <code>dependency_status</code>), beside a
        live probe of its <code>/readyz</code>.
      </p>
      <button type="button" disabled={testing} onClick={() => void test()}>
        {testing ? 'Testing…' : 'Test dependencies now'}
      </button>
      {deps.error ? <RuntimeErrorNotice error={deps.error} /> : null}
      {testError ? <RuntimeErrorNotice error={testError} /> : null}
      {deps.data ? <DependencyTable recorded={deps.data.recorded} live={snapshot} /> : null}
    </>
  );
}

function DependencyTable({
  recorded,
  live,
}: {
  recorded: DependencyRecord[];
  live: LiveReadiness | null;
}) {
  const names = new Set([...recorded.map((d) => d.name), ...Object.keys(live?.components ?? {})]);
  if (names.size === 0) {
    return (
      <p>
        No dependency status has been recorded yet
        {live && !live.reachable ? ', and OfficePulse is not reachable' : ''}.
      </p>
    );
  }
  const byName = new Map(recorded.map((d) => [d.name, d]));
  return (
    <>
      {live ? (
        <p role="status">
          OfficePulse live: {live.reachable ? (live.ready ? 'ready' : 'NOT ready') : 'unreachable'}
          {live.reachable && live.fullyOperational ? ' (fully operational)' : ''}
        </p>
      ) : null}
      <table>
        <caption className="visually-hidden">Dependency status</caption>
        <thead>
          <tr>
            <th scope="col">Dependency</th>
            <th scope="col">Recorded</th>
            <th scope="col">Detail</th>
            <th scope="col">Changed</th>
            <th scope="col">Live</th>
          </tr>
        </thead>
        <tbody>
          {[...names].sort().map((name) => {
            const rec = byName.get(name);
            const comp = live?.components[name];
            return (
              <tr key={name}>
                <td>{name}</td>
                <td>{rec ? (rec.ready ? 'ready' : 'DOWN') : '—'}</td>
                <td>{rec?.detail ?? comp?.detail ?? ''}</td>
                <td>{rec?.changedAt ?? ''}</td>
                <td>{comp ? `${comp.ready ? 'ready' : 'DOWN'} (${comp.criticality})` : '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}

function ProvisioningSection() {
  const ops = useSection(() => runtimeApi.provisioning(), []);
  const [status, setStatus] = useState<string | null>(null);
  const [retryError, setRetryError] = useState<unknown>(null);

  const retry = async (op: ProvisioningOperation) => {
    const kind = op.kind as 'EXTENSION' | 'RING_GROUP' | 'DID';
    setRetryError(null);
    try {
      await runtimeApi.retryProvisioning(kind, op.externalId);
      setStatus(`Re-issued ${kind} provisioning for ${op.externalId}`);
      ops.refresh();
    } catch (err) {
      setRetryError(err);
    }
  };

  return (
    <>
      <p>
        OfficePulse's provisioning record (idempotent by request id). Retrying re-issues the same
        update; a lost SIP secret is never re-served — rotate it explicitly instead.
      </p>
      {status ? <p role="status">{status}</p> : null}
      {ops.error ? <RuntimeErrorNotice error={ops.error} /> : null}
      {retryError ? <RuntimeErrorNotice error={retryError} /> : null}
      {ops.data ? (
        ops.data.operations.length === 0 ? (
          <p>No provisioning operations recorded.</p>
        ) : (
          <table>
            <caption className="visually-hidden">Provisioning operations</caption>
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Kind</th>
                <th scope="col">Record</th>
                <th scope="col">Action</th>
                <th scope="col">Status</th>
                <th scope="col">Retry</th>
              </tr>
            </thead>
            <tbody>
              {ops.data.operations.map((op) => (
                <tr key={op.requestId}>
                  <td>{op.createdAt}</td>
                  <td>{op.kind}</td>
                  <td>
                    <code>{op.externalId}</code>
                  </td>
                  <td>{op.action}</td>
                  <td>{op.status}</td>
                  <td>
                    {['EXTENSION', 'RING_GROUP', 'DID'].includes(op.kind) ? (
                      <button type="button" onClick={() => void retry(op)}>
                        Retry {op.kind.toLowerCase()}
                      </button>
                    ) : (
                      '—'
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      ) : null}
    </>
  );
}

function FallbacksSection() {
  const fallbacks = useSection(() => runtimeApi.fallbacks(), []);
  return (
    <>
      <p>
        Where each DID's caller goes when NocoDB or LiveKit is unavailable — projected by
        OfficePulse when the DID route was provisioned. A DID missing here has no local fail-safe:
        save its route again to project one.
      </p>
      {fallbacks.error ? <RuntimeErrorNotice error={fallbacks.error} /> : null}
      {fallbacks.data ? (
        fallbacks.data.fallbacks.length === 0 ? (
          <p>No DID fail-safes projected.</p>
        ) : (
          <FallbackTable rows={fallbacks.data.fallbacks} />
        )
      ) : null}
    </>
  );
}

function FallbackTable({ rows }: { rows: DidFallback[] }) {
  return (
    <table>
      <caption className="visually-hidden">DID fail-safe destinations</caption>
      <thead>
        <tr>
          <th scope="col">DID</th>
          <th scope="col">Tenant</th>
          <th scope="col">Destination</th>
          <th scope="col">Enabled</th>
          <th scope="col">Updated</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((f) => (
          <tr key={f.didRouteId}>
            <td>{f.didE164}</td>
            <td>{f.tenantId}</td>
            <td>
              {f.destinationType} <code>{f.destinationId}</code>
            </td>
            <td>{f.enabled ? 'yes' : 'no'}</td>
            <td>{f.updatedAt}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function WebhooksSection() {
  const hooks = useSection(() => runtimeApi.webhooks(), []);
  return (
    <>
      <p>
        Verified LiveKit webhook deliveries OfficePulse accepted; a repeated delivery id is
        suppressed there and never appears twice here.
      </p>
      {hooks.error ? <RuntimeErrorNotice error={hooks.error} /> : null}
      {hooks.data ? (
        hooks.data.deliveries.length === 0 ? (
          <p>No webhook deliveries recorded.</p>
        ) : (
          <WebhookTable rows={hooks.data.deliveries} />
        )
      ) : null}
    </>
  );
}

function WebhookTable({ rows }: { rows: WebhookDelivery[] }) {
  return (
    <table>
      <caption className="visually-hidden">Webhook deliveries</caption>
      <thead>
        <tr>
          <th scope="col">Received</th>
          <th scope="col">Source</th>
          <th scope="col">Event</th>
          <th scope="col">Call</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((d) => (
          <tr key={`${d.source}-${d.deliveryId}`}>
            <td>{d.receivedAt}</td>
            <td>{d.source}</td>
            <td>{d.eventType}</td>
            <td>
              {d.callSessionId ? (
                <Link to={`/runtime/calls/${encodeURIComponent(d.callSessionId)}`}>
                  {d.callSessionId}
                </Link>
              ) : (
                '—'
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function OrphansSection() {
  const orphans = useSection(() => runtimeApi.orphans(), []);
  return (
    <>
      <p>
        Calls that never ended and are older than the live horizon. Detection only: OfficePulse
        exposes no cleanup endpoint and AidaAdmin never writes to its tables.
      </p>
      {orphans.error ? <RuntimeErrorNotice error={orphans.error} /> : null}
      {orphans.data ? (
        orphans.data.orphans.length === 0 ? (
          <p>No orphaned calls.</p>
        ) : (
          <ul>
            {orphans.data.orphans.map(({ call, participantsPresent }) => (
              <li key={call.id}>
                <Link to={`/runtime/calls/${encodeURIComponent(call.id)}`}>{call.id}</Link> — tenant{' '}
                {call.tenantId}, started {call.createdAt}, state {call.state}
                {participantsPresent.length > 0
                  ? ` — still present: ${participantsPresent
                      .map((p: RuntimeParticipant) => p.identity ?? p.participantSid)
                      .join(', ')}`
                  : ''}
              </li>
            ))}
          </ul>
        )
      ) : null}
    </>
  );
}

/**
 * The OfficePulse runtime, read through the read-only database view, with
 * the few actions that go to its API. Tenant administrators get the
 * tenant-scoped sections; Super Admins get all of them.
 */
export function RuntimeScreen({ session }: { session: SessionView }) {
  const superAdmin = session.user.superAdmin;
  const sections: Section[] = superAdmin
    ? ['calls', 'dependencies', 'provisioning', 'fallbacks', 'webhooks', 'orphans']
    : TENANT_SECTIONS;
  const [section, setSection] = useState<Section>('calls');

  return (
    <section aria-labelledby="runtime-heading">
      <h1 id="runtime-heading">Runtime</h1>
      <p>
        OfficePulse's runtime record, read through a read-only account. Commands go to OfficePulse's
        API and are audited.
      </p>
      <div role="tablist" aria-label="Runtime sections" className="call-tabs">
        {sections.map((s) => (
          <button
            key={s}
            role="tab"
            id={`runtime-tab-${s}`}
            aria-selected={section === s}
            aria-controls="runtime-panel"
            onClick={() => setSection(s)}
          >
            {SECTION_LABEL[s]}
          </button>
        ))}
      </div>
      <div role="tabpanel" id="runtime-panel" aria-labelledby={`runtime-tab-${section}`}>
        <h2>{SECTION_LABEL[section]}</h2>
        {section === 'calls' ? <CallsSection superAdmin={superAdmin} /> : null}
        {section === 'dependencies' ? <DependenciesSection /> : null}
        {section === 'provisioning' ? <ProvisioningSection /> : null}
        {section === 'fallbacks' ? <FallbacksSection /> : null}
        {section === 'webhooks' ? <WebhooksSection /> : null}
        {section === 'orphans' ? <OrphansSection /> : null}
      </div>
    </section>
  );
}
