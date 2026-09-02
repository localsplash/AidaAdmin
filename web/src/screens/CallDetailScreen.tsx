import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { runtimeApi, type CallDetail } from '../api/runtime';
import { RuntimeErrorNotice } from '../components/RuntimeError';
import { emptyCallView, PHASE_LABEL, reduceEvents } from '../runtime/callState';

/**
 * One call, end to end: what it was configured with, what happened, who
 * was on it, and what was commanded. This is the page for diagnosing a
 * single real call from DID arrival to hangup (issue #29).
 */
export function CallDetailScreen() {
  const { callSessionId = '' } = useParams();
  const [detail, setDetail] = useState<CallDetail | null>(null);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(() => {
    runtimeApi
      .getCall(callSessionId)
      .then((res) => {
        setDetail(res);
        setError(null);
      })
      .catch(setError);
  }, [callSessionId]);

  useEffect(() => {
    load();
  }, [load]);

  // One section and one heading for every state, so the page's landmark
  // and title never re-mount as the data arrives.
  let body: ReactNode;
  if (error) {
    body = <RuntimeErrorNotice error={error} />;
  } else if (!detail) {
    body = <p role="status">Loading…</p>;
  } else {
    body = <Loaded detail={detail} onRefresh={load} />;
  }
  return (
    <section aria-labelledby="call-heading">
      <p>
        <Link to="/operations">← Live operations</Link> · <Link to="/runtime">Runtime</Link>
      </p>
      <h1 id="call-heading">Call {callSessionId}</h1>
      {body}
    </section>
  );
}

function Loaded({ detail, onRefresh }: { detail: CallDetail; onRefresh: () => void }) {
  const { call, events, commands, participants } = detail;
  const view = reduceEvents(emptyCallView(call.id), events);

  return (
    <>
      <p role="status">
        <strong>{PHASE_LABEL[view.phase]}</strong> — OfficePulse state <code>{call.state}</code>,
        disposition <code>{call.disposition}</code>, version {call.version}
      </p>
      {view.failureReason ? <p role="alert">Failure: {view.failureReason}</p> : null}
      {view.sequenceGap ? <p role="alert">The durable event record has a gap.</p> : null}
      <button type="button" onClick={onRefresh}>
        Refresh
      </button>

      <h2>Call</h2>
      <dl>
        <dt>Tenant</dt>
        <dd>{call.tenantId}</dd>
        <dt>DID</dt>
        <dd>{call.didE164}</dd>
        <dt>Caller</dt>
        <dd>{call.callerNumber ?? '—'}</dd>
        <dt>Started</dt>
        <dd>{call.createdAt}</dd>
        <dt>Ended</dt>
        <dd>{call.endedAt ?? 'still open'}</dd>
        <dt>Asterisk linked id</dt>
        <dd>
          <code>{call.asteriskLinkedId}</code>
        </dd>
        <dt>OfficePulse instance</dt>
        <dd>{call.officePulseInstanceId}</dd>
        <dt>LiveKit room</dt>
        <dd>{call.roomName ?? '—'}</dd>
        <dt>Agent participant</dt>
        <dd>{call.agentParticipantSid ?? '—'}</dd>
        <dt>Fallback destination</dt>
        <dd>
          {call.destinationType ? `${call.destinationType} ${call.destinationId ?? ''}` : '—'}
        </dd>
      </dl>

      <h2>Configuration pinned at bootstrap</h2>
      <p className="transcript-note">
        These are the ids and revisions this call actually used, so its behaviour stays explainable
        after the configuration is edited.
      </p>
      <dl>
        <dt>DID route</dt>
        <dd>
          {call.config.didRouteId ?? '—'}
          {call.config.didRouteRevision !== null ? ` (rev ${call.config.didRouteRevision})` : ''}
        </dd>
        <dt>Assistant profile</dt>
        <dd>
          {call.config.profileId ?? '—'}
          {call.config.profileRevision !== null ? ` (rev ${call.config.profileRevision})` : ''}
        </dd>
        <dt>Tenant revision</dt>
        <dd>{call.config.tenantRevision ?? '—'}</dd>
      </dl>

      <h2>Timeline</h2>
      {events.length === 0 ? (
        <p>No events recorded.</p>
      ) : (
        <table>
          <caption className="visually-hidden">Durable call events</caption>
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">At</th>
              <th scope="col">Event</th>
              <th scope="col">Detail</th>
            </tr>
          </thead>
          <tbody>
            {view.timeline.map((entry) => (
              <tr key={entry.sequenceNumber}>
                <td>{entry.sequenceNumber}</td>
                <td>{entry.at ?? ''}</td>
                <td>{entry.eventType}</td>
                <td>{entry.detail ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>Commands</h2>
      {commands.length === 0 ? (
        <p>No commands were issued.</p>
      ) : (
        <table>
          <caption className="visually-hidden">Control commands</caption>
          <thead>
            <tr>
              <th scope="col">Type</th>
              <th scope="col">Status</th>
              <th scope="col">Result</th>
              <th scope="col">Idempotency key</th>
              <th scope="col">Completed</th>
            </tr>
          </thead>
          <tbody>
            {commands.map((c) => (
              <tr key={c.idempotencyKey}>
                <td>{c.commandType}</td>
                <td>{c.status}</td>
                <td>{c.result ? JSON.stringify(c.result) : ''}</td>
                <td>
                  <code>{c.idempotencyKey}</code>
                </td>
                <td>{c.completedAt ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>LiveKit participants</h2>
      {participants.length === 0 ? (
        <p>No participants recorded.</p>
      ) : (
        <table>
          <caption className="visually-hidden">LiveKit participants</caption>
          <thead>
            <tr>
              <th scope="col">Identity</th>
              <th scope="col">Kind</th>
              <th scope="col">Joined</th>
              <th scope="col">Left</th>
            </tr>
          </thead>
          <tbody>
            {participants.map((p) => (
              <tr key={p.participantSid}>
                <td>{p.identity ?? p.participantSid}</td>
                <td>{p.kind}</td>
                <td>{p.joinedAt}</td>
                <td>{p.leftAt ?? 'present'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
