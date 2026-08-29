import { useCallback, useEffect, useRef, useState } from 'react';
import {
  runtimeApi,
  RuntimeApiError,
  type ActiveCallSummary,
  type OperationalEvent,
} from '../api/runtime';
import { emptyCallView, reduceEvents, type CallView } from '../runtime/callState';

const POLL_MS = 3000;

/** One in-flight takeover attempt; the key is minted once per attempt. */
interface TakeoverAttempt {
  idempotencyKey: string;
  submitting: boolean;
  submitted: boolean;
  error: string | null;
}

function CallPanel({
  summary,
  view,
  attempt,
  onTakeover,
}: {
  summary: ActiveCallSummary;
  view: CallView;
  attempt: TakeoverAttempt | undefined;
  onTakeover: () => void;
}) {
  const command = view.commands.find(
    (c) => c.idempotencyKey === attempt?.idempotencyKey || c.commandType === 'TAKEOVER',
  );
  const terminal = Boolean(command && ['COMPLETED', 'FAILED'].includes(command.status));
  const busy = Boolean(attempt?.submitting) || Boolean(attempt?.submitted && !terminal);
  const takeoverDisabled = busy;

  return (
    <div>
      <p role="status">
        Call state: <strong>{view.state}</strong>
        {view.speechState ? ` — ${view.speechState} speaking` : ''}
        {summary.callerNumber ? ` — caller ${summary.callerNumber}` : ''}
      </p>

      {view.transferFailedReason ? (
        <p role="alert">Transfer failed ({view.transferFailedReason}) — Aida resumed the call.</p>
      ) : null}
      {view.transcriptGap ? (
        <p role="alert">Transcript gap detected — the missing speech is unrecoverable.</p>
      ) : null}
      {attempt?.error ? <p role="alert">{attempt.error}</p> : null}

      <h3>Live transcript</h3>
      <p className="transcript-note">
        Live view only — this transcript is not a historical record.
      </p>
      {view.transcript.length === 0 ? (
        <p>No speech yet.</p>
      ) : (
        <ol className="transcript">
          {view.transcript.map((line) => (
            <li key={line.sequenceNumber}>
              <strong>{line.speaker}:</strong> {line.text}
            </li>
          ))}
        </ol>
      )}

      {view.suggestions.length > 0 ? (
        <>
          <h3>Aida suggestions</h3>
          <ul>
            {view.suggestions.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        </>
      ) : null}

      <h3>Take over</h3>
      {command ? (
        <p role="status">
          Takeover {command.status.toLowerCase()}
          {command.detail ? ` — ${command.detail}` : ''}
        </p>
      ) : null}
      <button type="button" disabled={takeoverDisabled} onClick={onTakeover}>
        {busy ? 'Takeover in progress…' : 'Take over this call'}
      </button>
    </div>
  );
}

export function OperationsScreen() {
  const [activeCalls, setActiveCalls] = useState<ActiveCallSummary[] | null>(null);
  const [recentCalls, setRecentCalls] = useState<ActiveCallSummary[]>([]);
  const [opsEvents, setOpsEvents] = useState<OperationalEvent[]>([]);
  const [views, setViews] = useState<Record<string, CallView>>({});
  const [attempts, setAttempts] = useState<Record<string, TakeoverAttempt>>({});
  const [selectedTab, setSelectedTab] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState<string | null>(null);
  const viewsRef = useRef(views);
  viewsRef.current = views;

  const refresh = useCallback(async () => {
    try {
      const [active, recent, ops] = await Promise.all([
        runtimeApi.listCalls('active'),
        runtimeApi.listCalls('recent'),
        runtimeApi.operationalEvents(),
      ]);
      setForbidden(null);
      setError(null);
      setActiveCalls(active.calls);
      setRecentCalls(recent.calls);
      setOpsEvents(ops.events);

      // Replay durable events per call from each call's own cursor. A
      // reconnect simply replays from the cursor; the reducer is idempotent.
      const nextViews: Record<string, CallView> = {};
      for (const call of active.calls) {
        const current = viewsRef.current[call.callSessionId] ?? emptyCallView(call.callSessionId);
        try {
          const { events } = await runtimeApi.listEvents(
            call.callSessionId,
            current.highestSequence,
          );
          nextViews[call.callSessionId] = reduceEvents(current, events);
        } catch {
          nextViews[call.callSessionId] = current;
        }
      }
      setViews(nextViews);
      setSelectedTab((tab) =>
        tab && active.calls.some((c) => c.callSessionId === tab)
          ? tab
          : (active.calls[0]?.callSessionId ?? null),
      );
    } catch (err) {
      if (err instanceof RuntimeApiError && (err.status === 403 || err.status === 401)) {
        setForbidden(err.message);
        setActiveCalls([]);
      } else {
        setError(err instanceof Error ? err.message : 'Failed to load runtime state');
      }
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const takeover = async (call: ActiveCallSummary) => {
    if (!window.confirm(`Take over the call ${call.callerNumber ?? call.callSessionId}?`)) return;
    const existing = attempts[call.callSessionId];
    // Debounce: an attempt in flight (or awaiting its terminal state) never
    // submits a second command.
    if (existing?.submitting || existing?.submitted) return;
    const idempotencyKey = crypto.randomUUID();
    setAttempts((a) => ({
      ...a,
      [call.callSessionId]: { idempotencyKey, submitting: true, submitted: false, error: null },
    }));
    const view = viewsRef.current[call.callSessionId];
    try {
      await runtimeApi.submitCommand(
        call.callSessionId,
        'TAKEOVER',
        view?.version ?? call.version ?? 0,
        idempotencyKey,
      );
      setAttempts((a) => ({
        ...a,
        [call.callSessionId]: { idempotencyKey, submitting: false, submitted: true, error: null },
      }));
    } catch (err) {
      setAttempts((a) => ({
        ...a,
        [call.callSessionId]: {
          idempotencyKey,
          submitting: false,
          submitted: false,
          error: err instanceof Error ? err.message : 'Takeover failed',
        },
      }));
    }
  };

  if (forbidden) {
    return (
      <section aria-labelledby="ops-heading">
        <h1 id="ops-heading">Live operations</h1>
        <p role="alert">{forbidden}</p>
      </section>
    );
  }

  return (
    <section aria-labelledby="ops-heading">
      <h1 id="ops-heading">Live operations</h1>
      {error ? <p role="alert">{error}</p> : null}
      <button type="button" onClick={() => void refresh()}>
        Refresh now
      </button>

      <h2>Active calls</h2>
      {activeCalls === null ? (
        <p role="status">Loading…</p>
      ) : activeCalls.length === 0 ? (
        <p>No active calls.</p>
      ) : (
        <>
          <div role="tablist" aria-label="Active calls" className="call-tabs">
            {activeCalls.map((call) => (
              <button
                key={call.callSessionId}
                role="tab"
                id={`tab-${call.callSessionId}`}
                aria-selected={selectedTab === call.callSessionId}
                aria-controls={`panel-${call.callSessionId}`}
                onClick={() => setSelectedTab(call.callSessionId)}
              >
                {call.callerNumber ?? call.callSessionId}
              </button>
            ))}
          </div>
          {activeCalls.map((call) => (
            <div
              key={call.callSessionId}
              role="tabpanel"
              id={`panel-${call.callSessionId}`}
              aria-labelledby={`tab-${call.callSessionId}`}
              hidden={selectedTab !== call.callSessionId}
            >
              <CallPanel
                summary={call}
                view={views[call.callSessionId] ?? emptyCallView(call.callSessionId)}
                attempt={attempts[call.callSessionId]}
                onTakeover={() => void takeover(call)}
              />
            </div>
          ))}
        </>
      )}

      <h2>Recent calls</h2>
      {recentCalls.length === 0 ? (
        <p>No recent calls.</p>
      ) : (
        <ul>
          {recentCalls.map((call) => (
            <li key={call.callSessionId}>
              {call.callerNumber ?? call.callSessionId} — {call.state}
            </li>
          ))}
        </ul>
      )}

      <h2>Operational errors</h2>
      {opsEvents.length === 0 ? (
        <p>No operational errors.</p>
      ) : (
        <ul>
          {opsEvents.map((event) => (
            <li key={event.id}>
              {event.occurredAt ? `${event.occurredAt} — ` : ''}
              {event.message ?? event.eventType ?? 'event'}
            </li>
          ))}
        </ul>
      )}

      <h2>Historical conversations</h2>
      <p>Coming soon — live transcripts are not historical records.</p>
    </section>
  );
}
