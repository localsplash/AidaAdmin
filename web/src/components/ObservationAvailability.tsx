import { useEffect, useState } from 'react';
import { runtimeApi, type ObservationStatus } from '../api/runtime';

/** This section remains visible before the first call; a call card is not a setup screen. */
export function ObservationAvailability() {
  const [status, setStatus] = useState<ObservationStatus | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      try {
        const next = await runtimeApi.observationStatus();
        if (!disposed) {
          setStatus(next);
          setFailed(false);
        }
      } catch {
        if (!disposed) {
          setStatus(null);
          setFailed(true);
        }
      } finally {
        if (!disposed) timer = setTimeout(() => void refresh(), 15000);
      }
    };
    void refresh();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, []);
  return (
    <section aria-labelledby="transcription-heading" className="observation-availability">
      <h2 id="transcription-heading">Live transcription</h2>
      <p>
        Caller and Aida text appears here during an active Aida call. No handset app or microphone
        access is needed to observe.
      </p>
      <div role="status">
        {failed ? (
          <p>Transcription availability could not be checked. Try refreshing the page.</p>
        ) : !status ? (
          <p>Checking transcription availability…</p>
        ) : (
          <>
            <p>
              {status.observerConfigured
                ? 'Transcript observation is configured.'
                : 'Transcript observation is unavailable: LiveKit observation has not been configured for Admin.'}
            </p>
            {status.admissionReady === false && (
              <p>
                Telephone-to-Aida routing is unavailable. Calls cannot reach the agent until
                OfficePulse call admission is enabled.
              </p>
            )}
            {status.livekitReady === false && <p>The LiveKit voice connection is unavailable.</p>}
            {(status.admissionReady === null || status.livekitReady === null) && (
              <p>
                Telephone call readiness could not be verified. A successful call is not yet
                confirmed.
              </p>
            )}
          </>
        )}
      </div>
      <p>
        When a call reaches Aida, select it under Active calls and choose{' '}
        <strong>Observe live transcript</strong>. If there are no active calls, there is no live
        text to display. Earlier speech is not replayed.
      </p>
    </section>
  );
}
