import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  adminApi,
  ApiError,
  type AssistantProfile,
  type DidRoute,
  type Extension,
  type RingGroup,
  type TenantNumber,
} from '../api/admin';

const EMPTY = {
  didE164: '',
  assistantProfileId: '',
  destinationType: 'EXTENSION' as 'EXTENSION' | 'RING_GROUP',
  destinationId: '',
  screeningEnabled: true,
  enabled: true,
};

export function DidRoutesScreen({ readOnly = true }: { readOnly?: boolean } = {}) {
  const { tenantId = '' } = useParams();
  const [routes, setRoutes] = useState<DidRoute[] | null>(null);
  const [numbers, setNumbers] = useState<TenantNumber[]>([]);
  const [profiles, setProfiles] = useState<AssistantProfile[]>([]);
  const [extensions, setExtensions] = useState<Extension[]>([]);
  const [ringGroups, setRingGroups] = useState<RingGroup[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [form, setForm] = useState(EMPTY);
  const [editing, setEditing] = useState<DidRoute | null>(null);
  const [busy, setBusy] = useState(false);
  const [formOpen, setFormOpen] = useState(false);

  const load = useCallback(() => {
    if (readOnly) {
      void adminApi
        .listDidRoutes(tenantId)
        .then((result) => setRoutes(result.didRoutes))
        .catch((err) => {
          setRoutes([]);
          setError(err instanceof Error ? err.message : 'Failed to read saved routing metadata');
        });
      return;
    }
    // Settled, not all: one failing list must not blank the destination
    // choices and leave the form unusable for an unrelated reason.
    void Promise.allSettled([
      adminApi.listDidRoutes(tenantId),
      adminApi.listProfiles(tenantId),
      adminApi.listExtensions(tenantId),
      adminApi.listRingGroups(tenantId),
      adminApi.listNumbers(tenantId),
    ]).then(([r, p, e, g, n]) => {
      if (r.status === 'fulfilled') setRoutes(r.value.didRoutes);
      else {
        setRoutes([]);
        setError(r.reason instanceof Error ? r.reason.message : 'Failed to load DID routes');
      }
      if (p.status === 'fulfilled') setProfiles(p.value.profiles);
      if (e.status === 'fulfilled') setExtensions(e.value.extensions);
      if (g.status === 'fulfilled') setRingGroups(g.value.ringGroups);
      if (n.status === 'fulfilled') setNumbers(n.value.numbers);
      else setError('Unable to load shared numbers. Refresh before saving a route.');
    });
  }, [tenantId, readOnly]);

  useEffect(() => {
    load();
  }, [load]);

  const startEdit = (route: DidRoute) => {
    setEditing(route);
    setFormOpen(true);
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
    setFormOpen(false);
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
        <Link to="/">← Dashboard</Link>
      </p>
      <h1 id="did-routes-heading">DID routes</h1>
      {readOnly ? (
        <p>
          Saved business routing metadata. PBX routing is managed in OfficePulse; editing is paused
          until destinations reference Asterisk extensions and queues.
        </p>
      ) : null}
      {!readOnly ? (
        <p>
          Inbound order is always: DID → recording disclosure → Aida screening → destination on
          takeover or failure.
        </p>
      ) : null}
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
              {!readOnly ? <th scope="col">Actions</th> : null}
            </tr>
          </thead>
          <tbody>
            {routes.map((route) => (
              <tr key={route.id}>
                <td>{route.did_e164}</td>
                <td>{route.screening_enabled ? 'Aida screens' : 'Direct'}</td>
                <td>{route.fallbackPreview}</td>
                <td>{route.enabled ? 'Yes' : 'No'}</td>
                {!readOnly ? (
                  <td>
                    <button type="button" onClick={() => startEdit(route)}>
                      Edit
                    </button>
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {!readOnly ? (
        <details
          className="record-editor"
          open={formOpen}
          onToggle={(e) => setFormOpen(e.currentTarget.open)}
        >
          <summary>{editing ? 'Edit record' : 'Add DID Route…'}</summary>
          <h2 id="route-form-heading">{editing ? `Edit ${editing.did_e164}` : 'New DID route'}</h2>
          <form aria-labelledby="route-form-heading" onSubmit={(e) => void submit(e)}>
            <label>
              DID (E.164)
              <select
                required
                value={form.didE164}
                onChange={(e) => setForm({ ...form, didE164: e.target.value })}
              >
                <option value="">Choose a tenant number…</option>
                {numbers.map((n) => (
                  <option
                    key={n.iPhoneNumberId}
                    value={n.phoneNumber}
                    disabled={!n.bEnabled && form.enabled}
                  >
                    {n.phoneNumber}
                    {n.label ? ` — ${n.label}` : ''}
                  </option>
                ))}
              </select>
              <Link to={`/tenants/${tenantId}/numbers`}>Manage shared numbers</Link>
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
                  onChange={() =>
                    setForm({ ...form, destinationType: 'EXTENSION', destinationId: '' })
                  }
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
              {busy ? 'Saving…' : editing ? 'Save DID route' : 'Save record'}
            </button>
            {editing ? (
              <button type="button" onClick={cancelEdit}>
                Cancel edit
              </button>
            ) : null}
          </form>
        </details>
      ) : null}
    </section>
  );
}
