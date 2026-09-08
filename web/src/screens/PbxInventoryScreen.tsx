import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { adminApi, type PbxExtension, type PbxQueue } from '../api/admin';

export function PbxInventoryScreen({ kind }: { kind: 'extensions' | 'queues' }) {
  const { tenantId = '' } = useParams();
  const [extensions, setExtensions] = useState<PbxExtension[]>([]);
  const [queues, setQueues] = useState<PbxQueue[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    setExtensions([]);
    setQueues([]);
    const load = async () => {
      try {
        if (kind === 'extensions') {
          const result = await adminApi.listPbxExtensions(tenantId);
          if (active) setExtensions(result.extensions);
        } else {
          const result = await adminApi.listPbxQueues(tenantId);
          if (active) setQueues(result.queues);
        }
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : 'Unable to read PBX inventory.');
      } finally {
        if (active) setLoading(false);
      }
    };
    void load();
    return () => {
      active = false;
    };
  }, [tenantId, kind, revision]);

  return (
    <section aria-labelledby="pbx-heading">
      <h1 id="pbx-heading">{kind === 'extensions' ? 'Extensions' : 'Queues'}</h1>
      <p>
        Asterisk is the source of truth. This read-only view comes from OfficePulse. PBX changes
        belong to OfficePulse operations.
      </p>
      <p>
        These are saved PBX settings. Use PBX operations to verify registrations, active queue
        members, and call health.
      </p>
      <button type="button" disabled={loading} onClick={() => setRevision((value) => value + 1)}>
        Refresh
      </button>
      {error ? <p role="alert">{error}</p> : null}
      {loading ? (
        <p role="status">Loading…</p>
      ) : !error && kind === 'extensions' ? (
        extensions.length === 0 ? (
          <p>No PBX endpoints configured for this tenant.</p>
        ) : (
          <table>
            <caption>
              PJSIP endpoints — endpoint IDs may differ from dialable extension numbers
            </caption>
            <thead>
              <tr>
                <th scope="col">Endpoint ID</th>
                <th scope="col">Caller ID</th>
                <th scope="col">Context</th>
                <th scope="col">Transport</th>
                <th scope="col">Address of record</th>
              </tr>
            </thead>
            <tbody>
              {extensions.map((extension) => (
                <tr key={extension.id}>
                  <td>{extension.id}</td>
                  <td>{extension.callerId ?? '—'}</td>
                  <td>{extension.context}</td>
                  <td>{extension.transport ?? '—'}</td>
                  <td>{extension.aors ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      ) : !error ? (
        queues.length === 0 ? (
          <p>No queues configured for this tenant.</p>
        ) : (
          <table>
            <caption>Asterisk queues and configured members</caption>
            <thead>
              <tr>
                <th scope="col">Queue</th>
                <th scope="col">Strategy</th>
                <th scope="col">Configured members</th>
              </tr>
            </thead>
            <tbody>
              {queues.map((queue) => (
                <tr key={queue.id}>
                  <td>{queue.name}</td>
                  <td>{queue.strategy ?? '—'}</td>
                  <td>
                    {queue.members
                      .map(
                        (member) =>
                          `${member.memberName ?? member.interface} (${member.interface}; penalty ${member.penalty}${member.paused ? '; configured paused' : ''})`,
                      )
                      .join(', ') || 'No configured members'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      ) : null}
    </section>
  );
}
