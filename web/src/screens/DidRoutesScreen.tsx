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

const EMPTY = {
  didE164: '',
  assistantProfileId: '',
  destinationType: 'EXTENSION' as 'EXTENSION' | 'RING_GROUP',
  destinationId: '',
  screeningEnabled: true,
  enabled: true,
};

export function DidRoutesScreen() {
  const { tenantId = '' } = useParams();
  const [routes, setRoutes] = useState<DidRoute[] | null>(null);
  const [profiles, setProfiles] = useState<AssistantProfile[]>([]);
  const [extensions, setExtensions] = useState<Extension[]>([]);
  const [ringGroups, setRingGroups] = useState<RingGroup[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [form, setForm] = useState(EMPTY);
  const [editing, setEditing] = useState<DidRoute | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    // Settled, not all: one failing list must not blank the destination
    // choices and leave the form unusable for an unrelated reason.
    void Promise.allSettled([
      adminApi.listDidRoutes(tenantId),
      adminApi.listProfiles(tenantId),
      adminApi.listExtensions(tenantId),
      adminApi.listRingGroups(tenantId),
    ]).then(([r, p, e, g]) => {
      if (r.status === 'fulfilled') setRoutes(r.value.didRoutes);
      else {
        setRoutes([]);
        setError(r.reason instanceof Error ? r.reason.message : 'Failed to load DID routes');
      }
      if (p.status === 'fulfilled') setProfiles(p.value.profiles);
      if (e.status === 'fulfilled') setExtensions(e.value.extensions);
      if (g.status === 'fulfilled') setRingGroups(g.value.ringGroups);
    });
  }, [tenantId]);

  useEffect(() => {
    load();
  }, [load]);

  const startEdit = (route: DidRoute) => {
    setEditing(route);
    setError(null);
    setStatus(null);
    setForm({
      didE164: route.did_e164,
      assistantProfileId: route.assistant_profile_id,
      destinationType: route.destination_type,
      destinationId:
        (route.destination_type === 'EXTENSION'
          ? route.destination_extension_id
          : route.destination_ring_group_id) ?? '',
      screeningEnabled: route.screening_enabled,
      enabled: route.enabled,
    });
  };

  const cancelEdit = () => {
    setEditing(null);
    setForm(EMPTY);
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setStatus(null);
    const input = { tenantId, ...form };
    try {
      if (editing) {
        await adminApi.updateDidRoute(editing.id, editing.revision, input);
        setStatus(`Saved ${form.didE164}`);
      } else {
        await adminApi.createDidRoute(input);
        setStatus(`Created ${form.didE164}`);
      }
      cancelEdit();
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save the DID route');
    } finally {
      setBusy(false);
    }
  };

  const destinations = form.destinationType === 'EXTENSION' ? extensions : ringGroups;
  const destinationNoun = form.destinationType === 'EXTENSION' ? 'extensions' : 'ring groups';

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
      {status ? <p role="status">{status}</p> : null}

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
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {routes.map((route) => (
              <tr key={route.id}>
                <td>{route.did_e164}</td>
                <td>{route.screening_enabled ? 'Aida screens' : 'Direct'}</td>
                <td>{route.fallbackPreview}</td>
                <td>{route.enabled ? 'Yes' : 'No'}</td>
                <td>
                  <button type="button" onClick={() => startEdit(route)}>
                    Edit
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2 id="route-form-heading">{editing ? `Edit ${editing.did_e164}` : 'New DID route'}</h2>
      <form aria-labelledby="route-form-heading" onSubmit={(e) => void submit(e)}>
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
        {profiles.length === 0 ? (
          <p>
            No assistant profiles for this tenant yet —{' '}
            <Link to={`/tenants/${tenantId}/profiles`}>create one</Link> first.
          </p>
        ) : null}
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
          {destinations.length === 0 ? (
            <p>
              No {destinationNoun} for this tenant yet — create one on the{' '}
              <Link
                to={`/tenants/${tenantId}/${
                  form.destinationType === 'EXTENSION' ? 'extensions' : 'ring-groups'
                }`}
              >
                {destinationNoun}
              </Link>{' '}
              page first.
            </p>
          ) : null}
        </fieldset>
        <label>
          <input
            type="checkbox"
            checked={form.screeningEnabled}
            onChange={(e) => setForm({ ...form, screeningEnabled: e.target.checked })}
          />
          Aida screening enabled
        </label>
        <label>
          <input
            type="checkbox"
            checked={form.enabled}
            onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
          />
          Enabled
        </label>
        <button type="submit" disabled={busy}>
          {busy ? 'Saving…' : editing ? 'Save DID route' : 'Create and provision'}
        </button>
        {editing ? (
          <button type="button" onClick={cancelEdit}>
            Cancel edit
          </button>
        ) : null}
      </form>
    </section>
  );
}
