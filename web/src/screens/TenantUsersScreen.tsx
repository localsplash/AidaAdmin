import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { adminApi, type TenantUser } from '../api/admin';

const EMPTY = { email: '', displayName: '', role: 'USER', enabled: true };
const LABELS: Record<string, string> = {
  SUPER_ADMIN: 'Super Admin',
  TENANT_ADMIN: 'Tenant Admin',
  USER: 'User',
};
export function TenantUsersScreen() {
  const { tenantId = '' } = useParams();
  const [users, setUsers] = useState<TenantUser[] | null>(null);
  const [roles, setRoles] = useState<string[]>([]);
  const [canAdd, setCanAdd] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [editing, setEditing] = useState<TenantUser | null>(null);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');
  const load = useCallback(async () => {
    try {
      const r = await adminApi.listTenantUsers(tenantId);
      setUsers(r.users);
      setRoles(r.assignableRoles ?? ['TENANT_ADMIN', 'USER']);
      setCanAdd(r.canManageDirectory ?? false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load users');
    }
  }, [tenantId]);
  useEffect(() => {
    void load();
  }, [load]);
  const cancel = () => {
    setEditing(null);
    setForm(EMPTY);
    setOpen(false);
  };
  const edit = (user: TenantUser) => {
    setEditing(user);
    setForm({
      email: user.email ?? '',
      displayName: user.display_name ?? '',
      role: user.role,
      enabled: user.enabled,
    });
    setOpen(true);
    setError(null);
    setStatus(null);
  };
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const fields = {
        ...form,
        email: form.email.trim(),
        displayName: form.displayName.trim() || null,
      };
      if (editing)
        await adminApi.editTenantUser(tenantId, editing.identity_user_id, {
          ...fields,
          ...(editing.claimed ? { email: undefined } : {}),
        });
      else await adminApi.addTenantUser(tenantId, fields);
      setStatus(
        editing
          ? 'User updated.'
          : `Added ${form.email.trim()}. They can sign in with their linked account.`,
      );
      cancel();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the user');
    } finally {
      setBusy(false);
    }
  };
  const visible = (users ?? []).filter((u) =>
    [u.email, u.display_name, LABELS[u.role]].some((v) =>
      v?.toLowerCase().includes(query.toLowerCase()),
    ),
  );
  return (
    <section aria-labelledby="tenant-users-heading">
      <h1 id="tenant-users-heading">Users</h1>
      <p>
        Manage the people and permissions for this tenant. Super Admins have access to all tenants.
      </p>
      {error ? <p role="alert">{error}</p> : null}
      {status ? <p role="status">{status}</p> : null}
      <label className="list-filter">
        Find users
        <input
          type="search"
          placeholder="Name or email"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
      {users === null ? (
        <p role="status">Loading users…</p>
      ) : (
        <div className="table-scroll">
          <table>
            <caption className="visually-hidden">Users in this tenant</caption>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Email address</th>
                <th scope="col">Role</th>
                <th scope="col">Status</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((user) => (
                <tr key={user.id}>
                  <td>{user.display_name || 'Not provided'}</td>
                  <td>{user.email || 'Not provided'}</td>
                  <td>{LABELS[user.role] ?? user.role}</td>
                  <td>
                    {!user.enabled
                      ? 'Disabled'
                      : user.claimed === false
                        ? 'Awaiting first sign-in'
                        : 'Active'}
                  </td>
                  <td>
                    {roles.includes(user.role) ? (
                      <button
                        type="button"
                        aria-label={`Edit ${user.display_name || user.email || 'user'}`}
                        onClick={() => edit(user)}
                      >
                        Edit
                      </button>
                    ) : (
                      <span>Managed by Super Admin</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!visible.length ? (
            <p>
              {users.length ? 'No matching users.' : 'No users yet. Add your first user below.'}
            </p>
          ) : null}
        </div>
      )}
      {canAdd || editing ? (
        <details
          className="record-editor"
          open={open}
          onToggle={(e) => setOpen(e.currentTarget.open)}
        >
          <summary>
            {editing ? `Edit ${editing.display_name || editing.email}` : 'Add User…'}
          </summary>
          <form aria-label={editing ? 'Edit user' : 'Add user'} onSubmit={(e) => void save(e)}>
            <label>
              Display name
              <input
                value={form.displayName}
                onChange={(e) => setForm({ ...form, displayName: e.target.value })}
              />
            </label>
            <label>
              Email address
              <input
                required={!editing?.claimed}
                type="email"
                aria-label="Email address"
                readOnly={Boolean(editing?.claimed)}
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
              />
              {editing?.claimed ? (
                <small>This email belongs to a linked sign-in account.</small>
              ) : null}
            </label>
            <label>
              Role
              <select
                value={form.role}
                onChange={(e) =>
                  setForm({
                    ...form,
                    role: e.target.value,
                    enabled: e.target.value === 'SUPER_ADMIN' ? true : form.enabled,
                  })
                }
              >
                {roles.map((role) => (
                  <option key={role} value={role}>
                    {LABELS[role]}
                  </option>
                ))}
              </select>
            </label>
            {form.role === 'SUPER_ADMIN' ? (
              <p className="form-notice">
                Super Admin grants platform-wide access to every tenant.
              </p>
            ) : null}
            <label className="checkbox-label">
              <input
                type="checkbox"
                disabled={form.role === 'SUPER_ADMIN'}
                checked={form.enabled}
                onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
              />
              Enabled in this tenant
            </label>
            <div className="form-actions">
              <button type="submit" disabled={busy}>
                {busy ? 'Saving…' : editing ? 'Save user' : 'Add user'}
              </button>
              <button type="button" disabled={busy} onClick={cancel}>
                Cancel
              </button>
            </div>
          </form>
        </details>
      ) : null}
    </section>
  );
}
