import { ObservationAvailability } from '../components/ObservationAvailability';
import { LiveTranscript } from '../components/LiveTranscript';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { runtimeApi, RuntimeApiError, type CallDetail } from '../api/runtime';
import { RuntimeErrorNotice } from '../components/RuntimeError';
import { emptyCallView, PHASE_LABEL, reduceEvents, type CallView } from '../runtime/callState';

const POLL_MS = 3000;

/** One in-flight takeover attempt; the key is minted once per attempt. */
interface TakeoverAttempt {
  idempotencyKey: string;
  submitting: boolean;
  submitted: boolean;
  error: string | null;
  outcome: string | null;
}

function CallPanel({
  detail,
  view,
  attempt,
  onTakeover,
  takeoverUnavailableReason,
}: {
  detail: CallDetail;
  view: CallView;
  attempt: TakeoverAttempt | undefined;
  onTakeover: () => void;
  takeoverUnavailableReason: string | null;
}) {
  const { call, commands, participants } = detail;
  // The durable record of takeover progress is OfficePulse's own
  // control_command row; the attempt state only covers the round trip.
  const command =
    commands.find((c) => c.idempotencyKey === attempt?.idempotencyKey) ??
    [...commands].reverse().find((c) => c.commandType === 'TAKEOVER');
  const terminal = Boolean(command && ['completed', 'failed'].includes(command.status));
  const busy = Boolean(attempt?.submitting) || Boolean(attempt?.submitted && !terminal);
  const ended = view.phase === 'ended' || call.endedAt !== null;
  const present = participants.filter((p) => p.leftAt === null);

  return (
    <div>
      <p role="status">
        <strong>{PHASE_LABEL[view.phase]}</strong>
        {call.callerNumber ? ` — caller ${call.callerNumber}` : ''} — DID {call.didE164}
        {' — '}
        <Link to={`/runtime/calls/${encodeURIComponent(call.id)}`}>details</Link>
      </p>

      {view.failureReason ? (
        <p role="alert">
          {view.phase === 'fallback'
            ? `Routed to the fallback destination (${view.failureReason}).`
            : `Last attempt failed (${view.failureReason}) — the caller stays with ${
                view.aidaPresent ? 'Aida' : 'whoever is connected'
              }.`}
        </p>
      ) : null}
      {view.sequenceGap ? (
        <p role="alert">
          Some durable events are missing from this record — the timeline has a gap.
        </p>
      ) : null}
      {attempt?.error ? <p role="alert">{attempt.error}</p> : null}

      <h3>Who is on the call</h3>
      <p>
        Aida: {view.aidaPresent ? 'present' : 'not present'}; human:{' '}
        {view.humanPresent ? 'connected' : 'not connected'}
        {present.length > 0
          ? ` — LiveKit participants: ${present.map((p) => p.identity ?? p.participantSid).join(', ')}`
          : ''}
      </p>

      <LiveTranscript callId={call.id} ended={ended} autoConnect />
      <details>
        <summary>Call timeline</summary>
        {view.timeline.length === 0 ? (
          <p>No events yet.</p>
        ) : (
          <ol className="transcript">
            {view.timeline.map((entry) => (
              <li key={entry.sequenceNumber}>
                <strong>{entry.eventType}</strong>
                {entry.detail ? ` — ${entry.detail}` : ''}
              </li>
            ))}
          </ol>
        )}
      </details>

      <h3>Take over</h3>
      {command ? (
        <p role="status">
          Takeover {command.status}
          {command.result && typeof command.result.error === 'string'
            ? ` — ${command.result.error}`
            : command.result && typeof command.result.status === 'string'
              ? ` — ${command.result.status}`
              : ''}
        </p>
      ) : null}
      {attempt?.outcome ? <p role="status">{attempt.outcome}</p> : null}
      {takeoverUnavailableReason ? (
        <p role="status">{takeoverUnavailableReason}</p>
      ) : (
        <button type="button" disabled={busy || ended} onClick={onTakeover}>
          {busy ? 'Takeover in progress…' : ended ? 'Call ended' : 'Take over this call'}
        </button>
      )}
    </div>
  );
}

/** The canonical POC cannot resolve a native queue destination yet. */
export function OperationsScreen({
  takeoverUnavailableReason = 'Native PBX queue routing is not configured. Call takeover is unavailable.',
}: {
  takeoverUnavailableReason?: string | null;
} = {}) {
  const [active, setActive] = useState<CallDetail[] | null>(null);
  const [views, setViews] = useState<Record<string, CallView>>({});
  const [attempts, setAttempts] = useState<Record<string, TakeoverAttempt>>({});
  const [selectedTab, setSelectedTab] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      try {
        const list = await runtimeApi.listCalls('active');
        if (disposed) return;
        const records = await Promise.all(
          list.calls.map(async (call) => {
            try {
              return await runtimeApi.getCall(call.id);
            } catch (err) {
              if (err instanceof RuntimeApiError && err.status === 404) return null;
              throw err;
            }
          }),
        );
        if (disposed) return;
        const details: CallDetail[] = [];
        const nextViews: Record<string, CallView> = {};
        for (const detail of records) {
          if (!detail) continue;
          const { call } = detail;
          const view = reduceEvents(emptyCallView(call.id), detail.events);
          // A call can end between the list and detail requests.
          if (
            call.endedAt !== null ||
            ['hangup', 'ended', 'completed'].includes(call.state) ||
            view.phase === 'ended'
          )
            continue;
          details.push(detail);
          nextViews[call.id] = view;
        }
        setError(null);
        setActive(details);
        setViews(nextViews);
        setAttempts((previous) =>
          Object.fromEntries(Object.entries(previous).filter(([id]) => nextViews[id])),
        );
        setSelectedTab((tab) =>
          tab && details.some((d) => d.call.id === tab) ? tab : (details[0]?.call.id ?? null),
        );
      } catch (err) {
        if (disposed) return;
        setError(err);
        // Do not present an old snapshot as live when its status cannot be checked.
        setActive([]);
        setViews({});
      } finally {
        if (!disposed) timer = setTimeout(() => void refresh(), POLL_MS);
      }
    };
    void refresh();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [refreshKey]);

  const takeover = async (detail: CallDetail) => {
    if (takeoverUnavailableReason) return;
    const call = detail.call;
    if (!window.confirm(`Take over the call ${call.callerNumber ?? call.id}?`)) return;
    const existing = attempts[call.id];
    // Debounce: an attempt in flight (or awaiting its terminal state) never
    // submits a second command.
    if (existing?.submitting || existing?.submitted) return;
    const idempotencyKey = crypto.randomUUID();
    setAttempts((a) => ({
      ...a,
      [call.id]: { idempotencyKey, submitting: true, submitted: false, error: null, outcome: null },
    }));
    try {
      const outcome = await runtimeApi.takeover(call.id, idempotencyKey, undefined, call.version);
      setAttempts((a) => ({
        ...a,
        [call.id]: {
          idempotencyKey,
          submitting: false,
          submitted: true,
          error: null,
          outcome: outcome.duplicate
            ? `Already submitted — ${outcome.status ?? 'in progress'}`
            : (outcome.status ?? null),
        },
      }));
    } catch (err) {
      setAttempts((a) => ({
        ...a,
        [call.id]: {
          idempotencyKey,
          submitting: false,
          submitted: false,
          error: err instanceof Error ? err.message : 'Takeover failed',
          outcome: null,
        },
      }));
    }
  };

  const forbidden =
    error instanceof RuntimeApiError && (error.status === 403 || error.status === 401);
  if (forbidden) {
    return (
      <section aria-labelledby="ops-heading">
        <h1 id="ops-heading">LIVE</h1>
        <RuntimeErrorNotice error={error} />
      </section>
    );
  }

  return (
    <section aria-labelledby="ops-heading">
      <h1 id="ops-heading">LIVE</h1>
      {error ? <RuntimeErrorNotice error={error} /> : null}
      <button type="button" onClick={() => setRefreshKey((key) => key + 1)}>
        Refresh now
      </button>

      <p>Calls appear automatically. Live transcripts connect for every active call.</p>
      {active?.length === 0 && !error ? <ObservationAvailability /> : null}

      <h2>Active calls</h2>
      {active === null ? (
        <p role="status">Loading…</p>
      ) : active.length === 0 ? (
        <p>{error ? 'Active call diagnostics unavailable.' : 'No active calls.'}</p>
      ) : (
        <>
          <div role="tablist" aria-label="Active calls" className="call-tabs">
            {active.map(({ call }) => (
              <button
                key={call.id}
                role="tab"
                id={`tab-${call.id}`}
                aria-selected={selectedTab === call.id}
                aria-controls={`panel-${call.id}`}
                tabIndex={selectedTab === call.id ? 0 : -1}
                onKeyDown={(event) => {
                  const index = active.findIndex((detail) => detail.call.id === call.id);
                  const next =
                    event.key === 'ArrowRight'
                      ? (index + 1) % active.length
                      : event.key === 'ArrowLeft'
                        ? (index + active.length - 1) % active.length
                        : event.key === 'Home'
                          ? 0
                          : event.key === 'End'
                            ? active.length - 1
                            : null;
                  if (next === null) return;
                  event.preventDefault();
                  const id = active[next]!.call.id;
                  setSelectedTab(id);
                  document.getElementById(`tab-${id}`)?.focus();
                }}
                onClick={() => setSelectedTab(call.id)}
              >
                <span className="live-call-indicator" aria-hidden="true" />
                <span className="visually-hidden">Live call: </span>
                {call.callerNumber ?? call.id}
              </button>
            ))}
          </div>
          {active.map((detail) => (
            <div
              key={detail.call.id}
              role="tabpanel"
              id={`panel-${detail.call.id}`}
              aria-labelledby={`tab-${detail.call.id}`}
              hidden={selectedTab !== detail.call.id}
            >
              <CallPanel
                detail={detail}
                view={views[detail.call.id] ?? emptyCallView(detail.call.id)}
                attempt={attempts[detail.call.id]}
                onTakeover={() => void takeover(detail)}
                takeoverUnavailableReason={takeoverUnavailableReason}
              />
            </div>
          ))}
        </>
      )}
    </section>
  );
}
