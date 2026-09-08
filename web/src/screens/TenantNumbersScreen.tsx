import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { adminApi, type NumberInput, type TenantNumber } from '../api/admin';
const EMPTY: NumberInput = {
  phoneNumber: '',
  label: '',
  bVoice: true,
  bMessaging: true,
  bEnabled: true,
  accessPolicy: 'TENANT_MEMBERS',
};
export function TenantNumbersScreen() {
  const { tenantId = '' } = useParams();
  const [numbers, setNumbers] = useState<TenantNumber[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<TenantNumber | null>(null);
  const [form, setForm] = useState<NumberInput>(EMPTY);
  const load = useCallback(async () => {
    try {
      const result = await adminApi.listNumbers(tenantId);
      setNumbers(result.numbers);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load numbers');
    } finally {
      setLoading(false);
    }
  }, [tenantId]);
  useEffect(() => {
    void load();
  }, [load]);
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await adminApi.saveNumber(tenantId, editing?.iPhoneNumberId ?? null, {
        ...form,
        ...(editing ? { expectedVersion: editing.iVersion } : {}),
      });
      setEditing(null);
      setForm(EMPTY);
      setOpen(false);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save number');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section>
      <h1>Numbers</h1>
      <p>
        These are this tenant’s shared business numbers for voice and messaging. All enabled tenant
        members can use every enabled number in Echo, including users who cannot administer Aida.
      </p>
      <p>
        Adding a number records its assignment. Configure its DID route for voice and complete
        carrier setup before using it.
      </p>
      {error && <p role="alert">{error}</p>}
      {loading ? (
        <p role="status">Loading numbers…</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Number</th>
              <th>Label</th>
              <th>Access</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {numbers.map((n) => (
              <tr key={n.iPhoneNumberId}>
                <td>{n.phoneNumber}</td>
                <td>{n.label || '—'}</td>
                <td>All tenant members</td>
                <td>{n.bEnabled ? 'Enabled' : 'Disabled'}</td>
                <td>
                  <button
                    type="button"
                    onClick={() => {
                      setEditing(n);
                      setForm({
                        phoneNumber: n.phoneNumber,
                        label: n.label,
                        bVoice: true,
                        bMessaging: true,
                        bEnabled: n.bEnabled,
                        accessPolicy: 'TENANT_MEMBERS',
                      });
                      setOpen(true);
                      setError(null);
                    }}
                  >
                    Edit {n.phoneNumber}
                  </button>{' '}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {!loading && numbers.length === 0 && (
        <p>
          No numbers assigned yet. Members can sign in to Echo and will see a message to contact
          their admin.
        </p>
      )}
      <details
        open={open}
        onToggle={(e) => setOpen(e.currentTarget.open)}
        className="record-editor"
      >
        <summary>{editing ? 'Edit number' : 'Add Number…'}</summary>
        <form onSubmit={(e) => void save(e)}>
          <label>
            Phone number
            <input
              required
              pattern="\+1[2-9][0-9]{9}"
              placeholder="+17145550100"
              value={form.phoneNumber}
              readOnly={Boolean(editing)}
              onChange={(e) => setForm({ ...form, phoneNumber: e.target.value })}
            />
          </label>
          <label>
            Label
            <input
              maxLength={100}
              value={form.label}
              onChange={(e) => setForm({ ...form, label: e.target.value })}
            />
          </label>
          <p>Voice and messaging · All tenant members</p>
          <label>
            <input
              type="checkbox"
              checked={form.bEnabled}
              onChange={(e) => setForm({ ...form, bEnabled: e.target.checked })}
            />
            Enabled
          </label>
          <button disabled={busy} type="submit">
            {busy ? 'Saving…' : 'Save number'}
          </button>{' '}
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setEditing(null);
              setForm(EMPTY);
              setOpen(false);
            }}
          >
            Cancel
          </button>
        </form>
      </details>
    </section>
  );
}
