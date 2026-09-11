import { useEffect, useState } from 'react';
import { Room, RoomEvent } from 'livekit-client';
import { runtimeApi, RuntimeApiError } from '../api/runtime';
import { receiveTranscript, type Segment } from '../runtime/transcript';
export function LiveTranscript({ callId, ended }: { callId: string; ended: boolean }) {
  const [enabled, setEnabled] = useState(false);
  const [status, setStatus] = useState('Not observing');
  const [rows, setRows] = useState<Segment[]>([]);
  useEffect(() => {
    if (!enabled || ended) return;
    let disposed = false;
    let room: Room | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const connect = async () => {
      setStatus('Connecting — earlier speech is unavailable');
      try {
        const credentials = await runtimeApi.observe(callId);
        if (disposed) return;
        room = new Room();
        room.on(RoomEvent.DataReceived, (data, participant, _kind, topic) => {
          if (
            !disposed &&
            topic === 'transcript' &&
            participant?.sid === credentials.agentParticipantSid
          ) {
            setRows((old) => receiveTranscript(old, data, callId));
          }
        });
        room.on(
          RoomEvent.Reconnecting,
          () => !disposed && setStatus('Reconnecting — speech during gaps is unavailable'),
        );
        room.on(RoomEvent.Reconnected, () => !disposed && setStatus('Connected — live text only'));
        room.on(
          RoomEvent.Disconnected,
          () => !disposed && setStatus('Disconnected — stop and observe again to reconnect'),
        );
        await room.connect(credentials.url, credentials.token, { autoSubscribe: false });
        if (disposed) {
          await room.disconnect();
          return;
        }
        setStatus('Connected — live text only');
        timer = setTimeout(() => {
          void room?.disconnect();
          void connect();
        }, credentials.expiresIn * 1000);
      } catch (err) {
        if (disposed) return;
        if (err instanceof RuntimeApiError && [401, 403, 404].includes(err.status)) setRows([]);
        setStatus(err instanceof RuntimeApiError ? err.message : 'LiveKit connection unavailable');
      }
    };
    void connect();
    return () => {
      disposed = true;
      clearTimeout(timer);
      void room?.disconnect();
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
