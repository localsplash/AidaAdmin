import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { adminApi, ApiError, type Extension, type RingGroup } from '../api/admin';

export function RingGroupsScreen() {
  const { tenantId = '' } = useParams();
  const [groups, setGroups] = useState<RingGroup[] | null>(null);
  const [extensions, setExtensions] = useState<Extension[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ name: '', virtualExtension: '' });
  const [members, setMembers] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    Promise.all([adminApi.listRingGroups(tenantId), adminApi.listExtensions(tenantId)])
      .then(([g, e]) => {
        setGroups(g.ringGroups);
        setExtensions(e.extensions);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Failed to load'));
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

  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await adminApi.createRingGroup({
        tenantId,
        name: form.name,
        virtualExtension: form.virtualExtension,
        memberExtensionIds: [...members],
        enabled: true,
      });
      setForm({ name: '', virtualExtension: '' });
      setMembers(new Set());
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create the ring group');
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
            </li>
          ))}
        </ul>
      )}

      <h2 id="new-ring-group-heading">New ring group (RING_ALL)</h2>
      <form aria-labelledby="new-ring-group-heading" onSubmit={(e) => void create(e)}>
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
        <button type="submit" disabled={busy}>
          {busy ? 'Creating…' : 'Create and provision'}
        </button>
      </form>
    </section>
  );
}
