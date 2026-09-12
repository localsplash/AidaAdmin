import { useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { adminApi, type NumberInput, type TenantNumber } from '../api/admin';
import { NumberRouting } from '../components/NumberRouting';
import { PbxDisabledNotice, PbxErrorNotice } from '../components/PbxNotice';
import { usePbxInventory } from '../hooks/usePbxInventory';
import { useNumberRouting } from '../hooks/useNumberRouting';
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
  return <TenantNumbers key={tenantId} tenantId={tenantId} />;
}
function TenantNumbers({ tenantId }: { tenantId: string }) {
  const identity = usePbxInventory(tenantId, adminApi.listNumbers);
  const routing = useNumberRouting(tenantId);
  const numbers = identity.data?.numbers ?? [];
  const lock = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<TenantNumber | null>(null);
  const [form, setForm] = useState<NumberInput>(EMPTY);
  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (lock.current || identity.error || identity.loading) return;
    if (
      editing?.bEnabled &&
      !form.bEnabled &&
      !window.confirm(
        `Disable Identity number ${editing.phoneNumber}? This removes members’ access to this number in Echo. PBX routing and carrier service are unchanged. Disable PBX routing first if you also want to stop routing calls.`,
      )
    )
      return;
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      await adminApi.saveNumber(tenantId, editing?.iPhoneNumberId ?? null, {
        ...form,
        ...(editing ? { expectedVersion: editing.iVersion } : {}),
      });
      if (!identity.current()) return;
      setEditing(null);
      setForm(EMPTY);
      setOpen(false);
      await identity.refresh();
      if (identity.current()) await routing.refresh();
    } catch (e) {
      if (identity.current()) setError(e instanceof Error ? e.message : 'Could not save number');
    } finally {
      lock.current = false;
      if (identity.current()) setBusy(false);
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
        Adding a Number / DID creates its globally unique Identity assignment. Configure its PBX
        routing below and complete carrier setup before using it.
      </p>
      {error && <p role="alert">{error}</p>}
      {!!identity.error && (
        <p role="alert">
          Could not load Identity numbers:{' '}
          {identity.error instanceof Error ? identity.error.message : 'Refresh and try again.'}
        </p>
      )}
      <PbxErrorNotice error={routing.error} />
      {!!routing.error && identity.data && !identity.error && (
        <p role="status">
          PBX routing is unavailable. Number assignments remain available; routing actions are
          disabled.
        </p>
      )}
      {routing.data && !routing.data.provisioningEnabled && <PbxDisabledNotice />}
      {identity.loading && <p role="status">Loading numbers…</p>}
      {numbers.map((n) => {
        const route = routing.data?.dids.find((entry) => entry.did === n.phoneNumber);
        return (
          <article
            key={n.iPhoneNumberId}
            aria-labelledby={`number-${n.iPhoneNumberId}`}
            className="number-card"
          >
            <h2 id={`number-${n.iPhoneNumberId}`}>{n.phoneNumber}</h2>
            <p>
              {n.label || 'No label'} · All tenant members · {n.bEnabled ? 'Enabled' : 'Disabled'}
            </p>
            <button
              type="button"
              disabled={busy || identity.loading || !!identity.error}
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
            </button>
            {routing.data ? (
              <NumberRouting
                tenantId={tenantId}
                number={n}
                route={
                  route ?? {
                    did: n.phoneNumber,
                    managed: false,
                    availability: 'scope_missing',
                    applyState: 'unknown',
                  }
                }
                inventory={routing}
                identityAvailable={!identity.error && !identity.loading && !busy}
                autoExpand={numbers.length === 1}
              />
            ) : (
              <p>PBX routing: {routing.loading ? 'Loading…' : 'Unavailable'}</p>
            )}
          </article>
        );
      })}
      {!identity.loading && !identity.error && numbers.length === 0 && (
        <p>
          No numbers assigned yet. Members can sign in to Echo and will see a message to contact
          their admin.
        </p>
      )}
      <button
        type="button"
        disabled={busy || identity.loading || routing.loading}
        onClick={() => {
          void identity.refresh();
          void routing.refresh();
        }}
      >
        Refresh numbers and routing
      </button>
      <details
        open={open}
        onToggle={(e) => setOpen(e.currentTarget.open)}
        className="record-editor"
      >
        <summary>{editing ? 'Edit number' : 'Add Number / DID…'}</summary>
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
          <button disabled={busy || identity.loading || !!identity.error} type="submit">
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
