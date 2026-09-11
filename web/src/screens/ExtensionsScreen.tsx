import { useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { adminApi, type Extension } from '../api/admin';
import { OneTimeSecret } from '../components/OneTimeSecret';
import {
  applyStateLabel,
  COMMITTED_NOTICE,
  PbxDisabledNotice,
  PbxErrorNotice,
} from '../components/PbxNotice';
import { usePbxInventory } from '../hooks/usePbxInventory';

const EMPTY = { extension: '', displayName: '', callerIdNumber: '', context: '' };
export function ExtensionsScreen() {
  const { tenantId = '' } = useParams();
  return <TenantExtensions key={tenantId} tenantId={tenantId} />;
}
function TenantExtensions({ tenantId }: { tenantId: string }) {
  const inventory = usePbxInventory(tenantId, adminApi.listExtensions);
  const [form, setForm] = useState(EMPTY);
  const [open, setOpen] = useState(false);
  const [secret, setSecret] = useState<{ username: string; secret: string } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const managed = (extension: Extension) =>
    !!extension.extension &&
    extension.id === `${extension.extension}-t${inventory.data?.iTenantId}`;
  const writable = inventory.data?.provisioningEnabled === true && !inventory.error;
  const callerIdLength = (form.callerIdNumber || form.extension).length;
  const displayNameMax = Math.min(33, Math.max(1, 40 - callerIdLength - 5));
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (lock.current || !writable || secret) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    setStatus('');
    try {
      const result = await adminApi.createExtension(tenantId, {
        extension: form.extension,
        displayName: form.displayName,
        ...(form.callerIdNumber ? { callerIdNumber: form.callerIdNumber } : {}),
        ...(inventory.data!.contexts.length > 1 ? { context: form.context } : {}),
      });
      if (!inventory.current()) return;
      // Credentials exist only in this disclosure lifecycle; dismiss/unmount destroys the state.
      setSecret({ username: result.sipUsername, secret: result.sipSecret });
      setStatus(result.applyState === 'active' ? 'Extension verified active.' : COMMITTED_NOTICE);
      setForm(EMPTY);
      setOpen(false);
      await inventory.refresh();
    } catch (err) {
      if (inventory.current()) setError(err);
    } finally {
      lock.current = false;
      if (inventory.current()) setBusy(false);
    }
  };
  const remove = async (extension: Extension) => {
    if (
      lock.current ||
      !writable ||
      !extension.extension ||
      !managed(extension) ||
      !window.confirm(
        `Delete extension ${extension.extension} (${extension.callerId ?? extension.id})? Saved queue memberships will also be removed.`,
      )
    )
      return;
    lock.current = true;
    setBusy(true);
    setError(null);
    setStatus('');
    try {
      await adminApi.deleteExtension(tenantId, extension.extension);
      if (!inventory.current()) return;
      setStatus(
        `Extension ${extension.extension} deletion committed. Effective Asterisk state has not been verified active.`,
      );
      await inventory.refresh();
    } catch (err) {
      if (inventory.current()) setError(err);
    } finally {
      lock.current = false;
      if (inventory.current()) setBusy(false);
    }
  };
  return (
    <section aria-labelledby="extensions-heading">
      <p>
        <Link to="/">← Dashboard</Link>
      </p>
      <h1 id="extensions-heading">Extensions</h1>
      <p>
        Native OfficePulse extensions. Inventory alone does not verify effective Asterisk state.
      </p>
      <PbxErrorNotice error={error || inventory.error} />
      {status && <p role="status">{status}</p>}
      {inventory.data && !inventory.data.provisioningEnabled && <PbxDisabledNotice />}
      {secret && (
        <OneTimeSecret
          title="SIP credentials for the new extension"
          values={[
            { label: 'SIP username', value: secret.username },
            { label: 'SIP secret', value: secret.secret },
          ]}
          onDismiss={() => setSecret(null)}
        />
      )}
      {inventory.loading && <p role="status">Loading extensions…</p>}
      {inventory.data &&
        (inventory.data.extensions.length === 0 ? (
          <p>No native extensions yet.</p>
        ) : (
          <div className="table-scroll">
            <table>
              <caption className="visually-hidden">Extensions for this tenant</caption>
              <thead>
                <tr>
                  <th scope="col">Extension</th>
                  <th scope="col">Display / caller ID</th>
                  <th scope="col">Context</th>
                  <th scope="col">Apply state</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {inventory.data.extensions.map((ext) => (
                  <tr key={ext.id}>
                    <td>{ext.extension ?? ext.id}</td>
                    <td>{ext.callerId ?? '—'}</td>
                    <td>{ext.context}</td>
                    <td>{applyStateLabel(ext.applyState)}</td>
                    <td>
                      {managed(ext) ? (
                        <button
                          type="button"
                          disabled={busy || !writable}
                          onClick={() => void remove(ext)}
                          aria-label={`Delete extension ${ext.extension}`}
                        >
                          Delete
                        </button>
                      ) : (
                        'Operator managed'
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      <button
        type="button"
        disabled={busy || inventory.loading}
        onClick={() => void inventory.refresh()}
      >
        Refresh inventory
      </button>{' '}
      <button type="button" disabled={!writable || busy || !!secret} onClick={() => setOpen(true)}>
        Create extension
      </button>
      {open && (
        <div className="record-editor">
          <h2>Create extension</h2>
          <form onSubmit={(event) => void submit(event)}>
            <fieldset disabled={busy || !writable}>
              <legend>Extension details</legend>
              <label>
                Extension number
                <input
                  required
                  inputMode="numeric"
                  pattern="[0-9]{2,12}"
                  minLength={2}
                  maxLength={12}
                  value={form.extension}
                  onChange={(event) => setForm({ ...form, extension: event.target.value })}
                />
              </label>
              <label>
                Display name
                <input
                  required
                  maxLength={displayNameMax}
                  value={form.displayName}
                  onChange={(event) => setForm({ ...form, displayName: event.target.value })}
                />
              </label>
              <label>
                Caller-ID number (optional E.164)
                <input
                  type="tel"
                  pattern="\+[1-9][0-9]{6,14}"
                  value={form.callerIdNumber}
                  onChange={(event) => setForm({ ...form, callerIdNumber: event.target.value })}
                />
              </label>
              {(inventory.data?.contexts.length ?? 0) > 1 && (
                <label>
                  Context
                  <select
                    required
                    value={form.context}
                    onChange={(event) => setForm({ ...form, context: event.target.value })}
                  >
                    <option value="">Choose an approved context…</option>
                    {inventory.data!.contexts.map((context) => (
                      <option key={context}>{context}</option>
                    ))}
                  </select>
                </label>
              )}
            </fieldset>
            <div className="form-actions">
              <button type="submit" disabled={busy || !writable}>
                {busy ? 'Creating…' : 'Create extension and show credentials'}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setOpen(false);
                  setForm(EMPTY);
                }}
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}
    </section>
  );
}
