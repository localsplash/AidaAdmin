import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  runtimeApi,
  RuntimeApiError,
  type CallDetail,
  type Issues,
  type RuntimeCall,
} from '../api/runtime';
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
}: {
  detail: CallDetail;
  view: CallView;
  attempt: TakeoverAttempt | undefined;
  onTakeover: () => void;
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

      <h3>Timeline</h3>
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
      <p className="transcript-note">
        Live speech is not in this record: transcripts travel over LiveKit Data and are never
        stored.
      </p>

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
      <button type="button" disabled={busy || ended} onClick={onTakeover}>
        {busy ? 'Takeover in progress…' : ended ? 'Call ended' : 'Take over this call'}
      </button>
    </div>
  );
}

export function OperationsScreen() {
  const [active, setActive] = useState<CallDetail[] | null>(null);
  const [recent, setRecent] = useState<RuntimeCall[]>([]);
  const [issues, setIssues] = useState<Issues | null>(null);
  const [views, setViews] = useState<Record<string, CallView>>({});
  const [attempts, setAttempts] = useState<Record<string, TakeoverAttempt>>({});
  const [selectedTab, setSelectedTab] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const viewsRef = useRef(views);
  viewsRef.current = views;

  const refresh = useCallback(async () => {
    try {
      const list = await runtimeApi.listCalls('active');
      setError(null);
      // Each call's full record in one round trip; the reducer is
      // idempotent, so replaying the whole event list is always safe.
      const details: CallDetail[] = [];
      const nextViews: Record<string, CallView> = {};
      for (const call of list.calls) {
        try {
          const detail = await runtimeApi.getCall(call.id);
          details.push(detail);
          const current = viewsRef.current[call.id] ?? emptyCallView(call.id);
          nextViews[call.id] = reduceEvents(current, detail.events);
        } catch {
          // A call that vanished between the list and the detail is gone.
        }
      }
      setActive(details);
      setViews(nextViews);
      setSelectedTab((tab) =>
        tab && details.some((d) => d.call.id === tab) ? tab : (details[0]?.call.id ?? null),
      );
      const [recentList, issueList] = await Promise.allSettled([
        runtimeApi.listCalls('recent'),
        runtimeApi.issues(),
      ]);
      if (recentList.status === 'fulfilled') setRecent(recentList.value.calls);
      if (issueList.status === 'fulfilled') setIssues(issueList.value);
    } catch (err) {
      setError(err);
      if (err instanceof RuntimeApiError && (err.status === 403 || err.status === 401)) {
        setActive([]);
      }
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const takeover = async (detail: CallDetail) => {
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
      const outcome = await runtimeApi.takeover(call.id, idempotencyKey);
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
        <h1 id="ops-heading">Live operations</h1>
        <RuntimeErrorNotice error={error} />
      </section>
    );
  }

  return (
    <section aria-labelledby="ops-heading">
      <h1 id="ops-heading">Live operations</h1>
      {error ? <RuntimeErrorNotice error={error} /> : null}
      <button type="button" onClick={() => void refresh()}>
        Refresh now
      </button>

      <h2>Active calls</h2>
      {active === null ? (
        <p role="status">Loading…</p>
      ) : active.length === 0 ? (
        <p>No active calls.</p>
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
                onClick={() => setSelectedTab(call.id)}
              >
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
              />
            </div>
          ))}
        </>
      )}

      <h2>Recent calls</h2>
      {recent.length === 0 ? (
        <p>No recent calls.</p>
      ) : (
        <ul>
          {recent.map((call) => (
            <li key={call.id}>
              <Link to={`/runtime/calls/${encodeURIComponent(call.id)}`}>
                {call.callerNumber ?? call.id}
              </Link>{' '}
              — {call.state} ({call.disposition})
            </li>
          ))}
        </ul>
      )}

      <h2>Operational errors</h2>
      {!issues || (issues.failedCommands.length === 0 && issues.events.length === 0) ? (
        <p>No operational errors{issues ? ` in the last ${issues.windowHours} hours` : ''}.</p>
      ) : (
        <ul>
          {issues.failedCommands.map((c) => (
            <li key={`c-${c.callSessionId}-${c.idempotencyKey}`}>
              {c.createdAt} — takeover failed on{' '}
              <Link to={`/runtime/calls/${encodeURIComponent(c.callSessionId)}`}>
                {c.callSessionId}
              </Link>
              {c.result && typeof c.result.error === 'string' ? `: ${c.result.error}` : ''}
            </li>
          ))}
          {issues.events.map((e) => (
            <li key={`e-${e.callSessionId}-${e.sequenceNumber}`}>
              {e.createdAt} — {e.eventType} on{' '}
              <Link to={`/runtime/calls/${encodeURIComponent(e.callSessionId)}`}>
                {e.callSessionId}
              </Link>
              {e.payload && typeof e.payload.reason === 'string' ? `: ${e.payload.reason}` : ''}
            </li>
          ))}
        </ul>
      )}

      <h2>Historical conversations</h2>
      <p>Coming soon — live transcripts are not historical records.</p>
    </section>
  );
}
