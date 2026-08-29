import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { adminApi, ApiError, type AssistantProfile } from '../api/admin';

const EMPTY = {
  name: '',
  businessName: '',
  prompt: '',
  tone: '',
  objective: '',
  openingStatement: '',
  transferStatement: '',
  failedTransferStatement: '',
};

export function ProfilesScreen() {
  const { tenantId = '' } = useParams();
  const [profiles, setProfiles] = useState<AssistantProfile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [form, setForm] = useState(EMPTY);
  const [editing, setEditing] = useState<AssistantProfile | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    adminApi
      .listProfiles(tenantId)
      .then((res) => setProfiles(res.profiles))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Failed to load'));
  }, [tenantId]);

  useEffect(() => {
    load();
  }, [load]);

  const startEdit = (profile: AssistantProfile) => {
    setEditing(profile);
    setForm({
      name: profile.name,
      businessName: profile.business_name,
      prompt: profile.prompt,
      tone: profile.tone ?? '',
      objective: profile.objective ?? '',
      openingStatement: profile.opening_statement ?? '',
      transferStatement: profile.transfer_statement ?? '',
      failedTransferStatement: profile.failed_transfer_statement ?? '',
    });
  };

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setStatus(null);
    const input = { tenantId, ...form, enabled: true };
    try {
      if (editing) {
        await adminApi.updateProfile(editing.id, editing.revision, input);
        setStatus(`Saved profile ${form.name}`);
      } else {
        await adminApi.createProfile(input);
        setStatus(`Created profile ${form.name}`);
      }
      setEditing(null);
      setForm(EMPTY);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save the profile');
    } finally {
      setBusy(false);
    }
  };

  const field = (key: keyof typeof EMPTY, label: string, long = false, required = false) => (
    <label>
      {label}
      {long ? (
        <textarea
          required={required}
          rows={3}
          value={form[key]}
          onChange={(e) => setForm({ ...form, [key]: e.target.value })}
        />
      ) : (
        <input
          required={required}
          value={form[key]}
          onChange={(e) => setForm({ ...form, [key]: e.target.value })}
        />
      )}
    </label>
  );

  return (
    <section aria-labelledby="profiles-heading">
      <p>
        <Link to="/tenants">← All tenants</Link>
      </p>
      <h1 id="profiles-heading">Assistant profiles</h1>
      <p>
        Voice, speech recognition, and model settings are supplied by the predefined{' '}
        <code>aida-prime</code> agent and are not configured here.
      </p>
      {error ? <p role="alert">{error}</p> : null}
      {status ? <p role="status">{status}</p> : null}

      {profiles === null ? (
        <p role="status">Loading…</p>
      ) : profiles.length === 0 ? (
        <p>No profiles yet.</p>
      ) : (
        <ul>
          {profiles.map((profile) => (
            <li key={profile.id}>
              {profile.name} — {profile.business_name}
              {profile.enabled ? '' : ' (disabled)'}{' '}
              <button type="button" onClick={() => startEdit(profile)}>
                Edit
              </button>
            </li>
          ))}
        </ul>
      )}

      <h2 id="profile-form-heading">{editing ? `Edit ${editing.name}` : 'New profile'}</h2>
      <form aria-labelledby="profile-form-heading" onSubmit={(e) => void save(e)}>
        {field('name', 'Profile name', false, true)}
        {field('businessName', 'Business name', false, true)}
        {field('prompt', 'Prompt', true, true)}
        {field('tone', 'Tone')}
        {field('objective', 'Objective', true)}
        {field('openingStatement', 'Opening statement', true)}
        {field('transferStatement', 'Transfer statement', true)}
        {field('failedTransferStatement', 'Failed-transfer statement', true)}
        <button type="submit" disabled={busy}>
          {busy ? 'Saving…' : editing ? 'Save profile' : 'Create profile'}
        </button>
        {editing ? (
          <button
            type="button"
            onClick={() => {
              setEditing(null);
              setForm(EMPTY);
            }}
          >
            Cancel edit
          </button>
        ) : null}
      </form>
    </section>
  );
}
