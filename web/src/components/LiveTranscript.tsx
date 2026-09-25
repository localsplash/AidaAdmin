import { useEffect, useState } from 'react';
import { Room, RoomEvent } from 'livekit-client';
import { runtimeApi, RuntimeApiError } from '../api/runtime';
import { loadTranscriptHistory, mergeTranscript, type Segment } from '../runtime/transcript';
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
    let streamAbort: AbortController | undefined;
    setRows([]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const releaseRoom = () => {
      streamAbort?.abort();
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
      setStatus('Connecting to live transcript…');
      let joined = false;
      try {
        const credentials = await runtimeApi.observe(callId);
        if (disposed || attempt !== generation) return;
        const connection = new Room();
        room = connection;
        const current = () => !disposed && room === connection;
        const abort = new AbortController();
        streamAbort = abort;
        let hydrating = true;
        let buffered: Segment[] = [];
        let hydration = 0;
        connection.registerTextStreamHandler('lk.transcription', async (reader, participant) => {
          const sender = connection.remoteParticipants.get(participant.identity);
          const attributes = reader.info.attributes ?? {};
          if (
            !current() ||
            sender?.sid !== credentials.agentParticipantSid ||
            attributes['aida.call_id'] !== callId
          )
            return;
          const key = attributes['lk.segment_id'];
          const speaker = attributes['aida.speaker'];
          const sequence = Number(attributes['aida.sequence']);
          if (
            !key ||
            (speaker !== 'caller' && speaker !== 'assistant') ||
            !Number.isSafeInteger(sequence) ||
            sequence < 1
          )
            return;
          const update = (text: string, isFinal: boolean) => {
            if (!current()) return;
            const row: Segment = {
              key,
              text,
              isFinal,
              sequence,
              speaker: speaker as Segment['speaker'],
            };
            if (hydrating) buffered = mergeTranscript(buffered, row);
            else setRows((old) => mergeTranscript(old, row));
          };
          let text = '';
          try {
            for await (const chunk of reader.withAbortSignal(abort.signal)) {
              if (!current()) return;
              text += chunk;
              if (text.length > 2 * 1024 * 1024) throw new Error('Transcript too large');
              update(text, false);
            }
            update(text, reader.info.attributes?.['lk.transcription_final'] === 'true');
          } catch {
            if (current()) {
              setStatus('Transcript interrupted — catching up automatically');
              retry(3000);
            }
          }
        });
        const hydrate = async () => {
          const revision = ++hydration;
          const valid = () => current() && revision === hydration;
          hydrating = true;
          buffered = [];
          setStatus('Catching up on this call…');
          const agent = [...connection.remoteParticipants.values()].find(
            (participant) => participant.sid === credentials.agentParticipantSid,
          );
          if (!agent) throw new Error('Agent unavailable');
          const history = await loadTranscriptHistory(
            (payload) =>
              connection.localParticipant.performRpc({
                destinationIdentity: agent.identity,
                method: 'get_transcript',
                payload,
                responseTimeout: 10000,
              }),
            callId,
            valid,
          ).catch((error) => {
            if (valid()) throw error;
            return [];
          });
          if (!valid()) return;
          setRows(buffered.reduce(mergeTranscript, history));
          buffered = [];
          hydrating = false;
          setStatus('Connected — history caught up, live text only');
        };
        connection.on(RoomEvent.Reconnecting, () => {
          if (current()) {
            hydration += 1;
            hydrating = true;
            setStatus('Reconnecting — history will catch up');
          }
        });
        connection.on(RoomEvent.Reconnected, () => {
          if (current())
            void hydrate().catch(() => {
              if (current()) {
                setStatus('Transcript history unavailable — retrying automatically');
                retry(3000);
              }
            });
        });
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
        joined = true;
        // Renew authorization regularly, including for calls in background tabs.
        timer = setTimeout(() => retry(0), credentials.expiresIn * 1000);
        await hydrate();
      } catch (err) {
        if (disposed || attempt !== generation) return;
        releaseRoom();
        clearTimeout(timer);
        const terminal =
          err instanceof RuntimeApiError &&
          ([401, 403, 404].includes(err.status) || err.code === 'call_ended');
        if (terminal) setRows([]);
        const message =
          err instanceof RuntimeApiError
            ? err.message
            : joined
              ? 'Transcript history unavailable'
              : 'LiveKit connection unavailable';
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
        Text only; no microphone, camera or call audio. History is loaded from the active agent when
        joining or reconnecting. Leaving clears this page’s transcript.
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
