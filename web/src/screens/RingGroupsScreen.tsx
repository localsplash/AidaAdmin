import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { adminApi, ApiError, type Extension, type RingGroup } from '../api/admin';

const EMPTY = { name: '', virtualExtension: '', ringTimeoutSeconds: 20, enabled: true };

export function RingGroupsScreen() {
  const { tenantId = '' } = useParams();
  const [groups, setGroups] = useState<RingGroup[] | null>(null);
  const [extensions, setExtensions] = useState<Extension[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [form, setForm] = useState(EMPTY);
  const [members, setMembers] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<RingGroup | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    // Settled rather than all: a failure in one list must not blank the other.
    void Promise.allSettled([
      adminApi.listRingGroups(tenantId),
      adminApi.listExtensions(tenantId),
    ]).then(([g, e]) => {
      if (g.status === 'fulfilled') setGroups(g.value.ringGroups);
      else setError(g.reason instanceof Error ? g.reason.message : 'Failed to load ring groups');
      if (e.status === 'fulfilled') setExtensions(e.value.extensions);
    });
  }, [tenantId]);

  useEffect(() => {
    load();
  }, [load]);

  const toggleMember = (id: string) => {
    const next = new Set(members);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setMembers(next);
  };

  const startEdit = (group: RingGroup) => {
    setEditing(group);
    setError(null);
    setStatus(null);
    setForm({
      name: group.name,
      virtualExtension: group.virtual_extension,
      ringTimeoutSeconds: group.ring_timeout_seconds,
      enabled: group.enabled,
    });
    setMembers(new Set(group.members.map((m) => m.extension_id)));
  };

  const cancelEdit = () => {
    setEditing(null);
    setForm(EMPTY);
    setMembers(new Set());
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setStatus(null);
    const input = { tenantId, ...form, memberExtensionIds: [...members] };
    try {
      if (editing) {
        await adminApi.updateRingGroup(editing.id, editing.revision, input);
        setStatus(`Saved ${form.name}`);
      } else {
        await adminApi.createRingGroup(input);
        setStatus(`Created ${form.name}`);
      }
      cancelEdit();
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save the ring group');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="ring-groups-heading">
      <p>
        <Link to="/tenants">← All tenants</Link>
      </p>
      <h1 id="ring-groups-heading">Ring groups</h1>
      {error ? <p role="alert">{error}</p> : null}
      {status ? <p role="status">{status}</p> : null}

      {groups === null ? (
        <p role="status">Loading…</p>
      ) : groups.length === 0 ? (
        <p>No ring groups yet.</p>
      ) : (
        <ul>
          {groups.map((group) => (
            <li key={group.id}>
              {group.name} — extension {group.virtual_extension}, rings {group.ring_timeout_seconds}
              s, {group.members.length} member(s)
              {group.enabled ? '' : ' (disabled)'}{' '}
              <button type="button" onClick={() => startEdit(group)}>
                Edit
              </button>
            </li>
          ))}
        </ul>
      )}

      <h2 id="ring-group-form-heading">
        {editing ? `Edit ${editing.name}` : 'New ring group (RING_ALL)'}
      </h2>
      <form aria-labelledby="ring-group-form-heading" onSubmit={(e) => void submit(e)}>
        <label>
          Name
          <input
            required
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
        </label>
        <label>
          Virtual extension
          <input
            required
            value={form.virtualExtension}
            onChange={(e) => setForm({ ...form, virtualExtension: e.target.value })}
          />
        </label>
        <label>
          Ring timeout (seconds)
          <input
            type="number"
            min={1}
            max={300}
            value={form.ringTimeoutSeconds}
            onChange={(e) => setForm({ ...form, ringTimeoutSeconds: Number(e.target.value) || 20 })}
          />
        </label>
        <fieldset>
          <legend>Members</legend>
          {extensions.length === 0 ? <p>Create extensions first.</p> : null}
          {extensions.map((extension) => (
            <label key={extension.id}>
              <input
                type="checkbox"
                checked={members.has(extension.id)}
                onChange={() => toggleMember(extension.id)}
              />
              {extension.extension_number} — {extension.display_name}
            </label>
          ))}
        </fieldset>
        <label>
          <input
            type="checkbox"
            checked={form.enabled}
            onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
          />
          Enabled
        </label>
        <button type="submit" disabled={busy}>
          {busy ? 'Saving…' : editing ? 'Save ring group' : 'Create and provision'}
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
