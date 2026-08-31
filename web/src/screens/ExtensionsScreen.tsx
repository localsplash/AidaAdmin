import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { adminApi, ApiError, type Extension } from '../api/admin';
import { OneTimeSecret } from '../components/OneTimeSecret';

interface Secret {
  title: string;
  values: Array<{ label: string; value: string }>;
}

const EMPTY = { extensionNumber: '', displayName: '', callerIdName: '', enabled: true };

export function ExtensionsScreen() {
  const { tenantId = '' } = useParams();
  const [extensions, setExtensions] = useState<Extension[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [secret, setSecret] = useState<Secret | null>(null);
  const [form, setForm] = useState(EMPTY);
  const [editing, setEditing] = useState<Extension | null>(null);
  const [macByExtension, setMacByExtension] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    adminApi
      .listExtensions(tenantId)
      .then((res) => setExtensions(res.extensions))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Failed to load'));
  }, [tenantId]);

  useEffect(() => {
    load();
  }, [load]);

  const startEdit = (extension: Extension) => {
    setEditing(extension);
    setError(null);
    setStatus(null);
    setForm({
      extensionNumber: extension.extension_number,
      displayName: extension.display_name,
      callerIdName: extension.caller_id_name ?? '',
      enabled: extension.enabled,
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
    const input = {
      tenantId,
      extensionNumber: form.extensionNumber,
      displayName: form.displayName,
      callerIdName: form.callerIdName || null,
      enabled: form.enabled,
    };
    try {
      if (editing) {
        await adminApi.updateExtension(editing.id, editing.revision, input);
        setStatus(`Saved extension ${form.extensionNumber}`);
      } else {
        const res = await adminApi.createExtension(input);
        if (res.sipSecret && res.sipUsername) {
          setSecret({
            title: 'SIP credentials for the new extension',
            values: [
              { label: 'SIP username', value: res.sipUsername },
              { label: 'SIP secret', value: res.sipSecret },
            ],
          });
        } else {
          // Saved, but this deployment has no PBX wired up.
          setStatus(res.message ?? 'Extension saved without PBX provisioning.');
        }
      }
      cancelEdit();
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save the extension');
    } finally {
      setBusy(false);
    }
  };

  const rotate = async (extension: Extension) => {
    if (!window.confirm(`Rotate the SIP secret for ${extension.extension_number}?`)) return;
    setError(null);
    try {
      const res = await adminApi.rotateSecret(extension.id, tenantId, false);
      setSecret({
        title: `New SIP secret for ${extension.extension_number}`,
        values: [{ label: 'SIP secret', value: res.sipSecret }],
      });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Rotation failed');
    }
  };

  const enroll = async (extension: Extension) => {
    const mac = macByExtension[extension.id] ?? '';
    setError(null);
    try {
      const res = await adminApi.issueEnrollment(extension.id, tenantId, mac);
      setSecret({
        title: `Handset enrollment for ${extension.extension_number}`,
        values: [
          { label: 'Device ID', value: res.deviceId },
          { label: 'Enrollment token', value: res.enrollmentToken },
          { label: 'Expires', value: res.expiresAt },
        ],
      });
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Enrollment failed');
    }
  };

  return (
    <section aria-labelledby="extensions-heading">
      <p>
        <Link to="/tenants">← All tenants</Link>
      </p>
      <h1 id="extensions-heading">Extensions</h1>
      {error ? <p role="alert">{error}</p> : null}
      {status ? <p role="status">{status}</p> : null}
      {secret ? (
        <OneTimeSecret
          title={secret.title}
          values={secret.values}
          onDismiss={() => setSecret(null)}
        />
      ) : null}

      {extensions === null ? (
        <p role="status">Loading…</p>
      ) : extensions.length === 0 ? (
        <p>No extensions yet.</p>
      ) : (
        <table>
          <caption className="visually-hidden">Extensions for this tenant</caption>
          <thead>
            <tr>
              <th scope="col">Number</th>
              <th scope="col">Name</th>
              <th scope="col">Enabled</th>
              <th scope="col">Handset MAC</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {extensions.map((extension) => (
              <tr key={extension.id}>
                <td>{extension.extension_number}</td>
                <td>{extension.display_name}</td>
                <td>{extension.enabled ? 'Yes' : 'No'}</td>
                <td>{extension.provisioning_mac ?? '—'}</td>
                <td>
                  <button type="button" onClick={() => startEdit(extension)}>
                    Edit
                  </button>{' '}
                  <button type="button" onClick={() => void rotate(extension)}>
                    Rotate SIP secret
                  </button>{' '}
                  <label>
                    MAC
                    <input
                      value={macByExtension[extension.id] ?? ''}
                      onChange={(e) =>
                        setMacByExtension({ ...macByExtension, [extension.id]: e.target.value })
                      }
                      placeholder="AA:BB:CC:DD:EE:FF"
                    />
                  </label>{' '}
                  <button type="button" onClick={() => void enroll(extension)}>
                    Issue handset enrollment
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2 id="extension-form-heading">
        {editing ? `Edit extension ${editing.extension_number}` : 'New extension'}
      </h2>
      <form aria-labelledby="extension-form-heading" onSubmit={(e) => void submit(e)}>
        <label>
          Extension number
          <input
            required
            value={form.extensionNumber}
            onChange={(e) => setForm({ ...form, extensionNumber: e.target.value })}
          />
        </label>
        <label>
          Display name
          <input
            required
            value={form.displayName}
            onChange={(e) => setForm({ ...form, displayName: e.target.value })}
          />
        </label>
        <label>
          Caller ID name
          <input
            value={form.callerIdName}
            onChange={(e) => setForm({ ...form, callerIdName: e.target.value })}
          />
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
          {busy ? 'Saving…' : editing ? 'Save extension' : 'Create and provision'}
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
