import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  adminApi,
  ApiError,
  type AssistantProfile,
  type DidRoute,
  type Extension,
  type RingGroup,
} from '../api/admin';

export function DidRoutesScreen() {
  const { tenantId = '' } = useParams();
  const [routes, setRoutes] = useState<DidRoute[] | null>(null);
  const [profiles, setProfiles] = useState<AssistantProfile[]>([]);
  const [extensions, setExtensions] = useState<Extension[]>([]);
  const [ringGroups, setRingGroups] = useState<RingGroup[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    didE164: '',
    assistantProfileId: '',
    destinationType: 'EXTENSION' as 'EXTENSION' | 'RING_GROUP',
    destinationId: '',
    screeningEnabled: true,
  });
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    Promise.all([
      adminApi.listDidRoutes(tenantId),
      adminApi.listProfiles(tenantId),
      adminApi.listExtensions(tenantId),
      adminApi.listRingGroups(tenantId),
    ])
      .then(([r, p, e, g]) => {
        setRoutes(r.didRoutes);
        setProfiles(p.profiles);
        setExtensions(e.extensions);
        setRingGroups(g.ringGroups);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Failed to load'));
  }, [tenantId]);

  useEffect(() => {
    load();
  }, [load]);

  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await adminApi.createDidRoute({ tenantId, ...form, enabled: true });
      setForm({ ...form, didE164: '', destinationId: '' });
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save the DID route');
    } finally {
      setBusy(false);
    }
  };

  const destinations = form.destinationType === 'EXTENSION' ? extensions : ringGroups;

  return (
    <section aria-labelledby="did-routes-heading">
      <p>
        <Link to="/tenants">← All tenants</Link>
      </p>
      <h1 id="did-routes-heading">DID routes</h1>
      <p>
        Inbound order is always: DID → recording disclosure → Aida screening → destination on
        takeover or failure.
      </p>
      {error ? <p role="alert">{error}</p> : null}

      {routes === null ? (
        <p role="status">Loading…</p>
      ) : routes.length === 0 ? (
        <p>No DID routes yet.</p>
      ) : (
        <table>
          <caption className="visually-hidden">DID routes for this tenant</caption>
          <thead>
            <tr>
              <th scope="col">DID</th>
              <th scope="col">Screening</th>
              <th scope="col">Fallback destination</th>
              <th scope="col">Enabled</th>
            </tr>
          </thead>
          <tbody>
            {routes.map((route) => (
              <tr key={route.id}>
                <td>{route.did_e164}</td>
                <td>{route.screening_enabled ? 'Aida screens' : 'Direct'}</td>
                <td>{route.fallbackPreview}</td>
                <td>{route.enabled ? 'Yes' : 'No'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2 id="new-route-heading">New DID route</h2>
      <form aria-labelledby="new-route-heading" onSubmit={(e) => void create(e)}>
        <label>
          DID (E.164)
          <input
            required
            placeholder="+15105550100"
            value={form.didE164}
            onChange={(e) => setForm({ ...form, didE164: e.target.value })}
          />
        </label>
        <label>
          Assistant profile
          <select
            required
            value={form.assistantProfileId}
            onChange={(e) => setForm({ ...form, assistantProfileId: e.target.value })}
          >
            <option value="">Choose a profile…</option>
            {profiles.map((profile) => (
              <option key={profile.id} value={profile.id} disabled={!profile.enabled}>
                {profile.name}
                {profile.enabled ? '' : ' (disabled)'}
              </option>
            ))}
          </select>
        </label>
        <fieldset>
          <legend>Destination on takeover or failure</legend>
          <label>
            <input
              type="radio"
              name="destinationType"
              checked={form.destinationType === 'EXTENSION'}
              onChange={() => setForm({ ...form, destinationType: 'EXTENSION', destinationId: '' })}
            />
            Extension
          </label>
          <label>
            <input
              type="radio"
              name="destinationType"
              checked={form.destinationType === 'RING_GROUP'}
              onChange={() =>
                setForm({ ...form, destinationType: 'RING_GROUP', destinationId: '' })
              }
            />
            Ring group
          </label>
          <label>
            Destination
            <select
              required
              value={form.destinationId}
              onChange={(e) => setForm({ ...form, destinationId: e.target.value })}
            >
              <option value="">Choose…</option>
              {destinations.map((d) => (
                <option key={d.id} value={d.id}>
                  {'extension_number' in d
                    ? `${d.extension_number} — ${d.display_name}`
                    : `${d.virtual_extension} — ${d.name}`}
                </option>
              ))}
            </select>
          </label>
        </fieldset>
        <label>
          <input
            type="checkbox"
            checked={form.screeningEnabled}
            onChange={(e) => setForm({ ...form, screeningEnabled: e.target.checked })}
          />
          Aida screening enabled
        </label>
        <button type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Create and provision'}
        </button>
      </form>
    </section>
  );
}
