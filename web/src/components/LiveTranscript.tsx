import { useEffect, useState } from 'react';
import { Room, RoomEvent } from 'livekit-client';
import { runtimeApi, RuntimeApiError } from '../api/runtime';
import { receiveTranscript, type Segment } from '../runtime/transcript';
export function LiveTranscript({
  callId,
  ended,
  autoConnect = false,
}: {
  callId: string;
  ended: boolean;
  autoConnect?: boolean;
}) {
  const [enabled, setEnabled] = useState(autoConnect);
  const [status, setStatus] = useState('Not observing');
  const [rows, setRows] = useState<Segment[]>([]);
  useEffect(() => {
    if (!enabled || ended) return;
    let disposed = false;
    let generation = 0;
    let room: Room | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const releaseRoom = () => {
      const previous = room;
      room = undefined;
      void previous?.disconnect().catch(() => {});
    };
    const retry = (delay: number) => {
      generation += 1;
      clearTimeout(timer);
      releaseRoom();
      if (!disposed) timer = setTimeout(() => void connect(), delay);
    };
    const connect = async () => {
      if (disposed) return;
      const attempt = ++generation;
      setStatus('Connecting — earlier speech is unavailable');
      try {
        const credentials = await runtimeApi.observe(callId);
        if (disposed || attempt !== generation) return;
        const connection = new Room();
        room = connection;
        const current = () => !disposed && room === connection;
        connection.on(RoomEvent.DataReceived, (data, participant, _kind, topic) => {
          if (
            current() &&
            topic === 'transcript' &&
            participant?.sid === credentials.agentParticipantSid
          ) {
            setRows((old) => receiveTranscript(old, data, callId));
          }
        });
        connection.on(
          RoomEvent.Reconnecting,
          () => current() && setStatus('Reconnecting — speech during gaps is unavailable'),
        );
        connection.on(
          RoomEvent.Reconnected,
          () => current() && setStatus('Connected — live text only'),
        );
        connection.on(RoomEvent.Disconnected, () => {
          if (!current()) return;
          setStatus('Disconnected — reconnecting automatically');
          retry(3000);
        });
        await connection.connect(credentials.url, credentials.token, { autoSubscribe: false });
        if (!current()) {
          await connection.disconnect();
          return;
        }
        setStatus('Connected — live text only');
        // Renew authorization regularly, including for calls in background tabs.
        timer = setTimeout(() => retry(0), credentials.expiresIn * 1000);
      } catch (err) {
        if (disposed || attempt !== generation) return;
        releaseRoom();
        clearTimeout(timer);
        const terminal =
          err instanceof RuntimeApiError &&
          ([401, 403, 404].includes(err.status) || err.code === 'call_ended');
        if (terminal) setRows([]);
        const message =
          err instanceof RuntimeApiError ? err.message : 'LiveKit connection unavailable';
        setStatus(terminal ? message : `${message} — retrying automatically`);
        // Admission can precede the agent binding; wait and join when it is ready.
        if (!terminal) retry(3000);
      }
    };
    void connect();
    return () => {
      disposed = true;
      clearTimeout(timer);
      releaseRoom();
    };
  }, [callId, enabled, ended]);
  return (
    <section aria-label="Live transcript">
      <h3>Live transcript</h3>
      <p role="status">{ended ? 'Call ended' : status}</p>
      <button
        disabled={ended}
        onClick={() => {
          setEnabled(!enabled);
          if (enabled) {
            setRows([]);
            setStatus('Not observing');
          }
        }}
      >
        {enabled ? 'Stop observing' : 'Observe live transcript'}
      </button>
      <p>
        Text only; no microphone, camera or call audio. Earlier speech and reconnect gaps cannot be
        replayed. Only the latest 200 segments remain in memory; leaving clears them.
      </p>
      {rows.length > 0 && <p>Conversation text received from the bound agent.</p>}
      <ol className="transcript" aria-live="polite">
        {rows.map((row) => (
          <li key={row.key}>
            <strong>{row.speaker === 'caller' ? 'Caller' : 'Assistant'}</strong> (
            {row.isFinal ? 'final' : 'partial'}): {row.text}
          </li>
        ))}
      </ol>
    </section>
  );
}
