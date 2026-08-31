import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { adminApi, ApiError, type DirectoryUser, type TenantUser } from '../api/admin';

export function TenantUsersScreen() {
  const { tenantId = '' } = useParams();
  const [users, setUsers] = useState<TenantUser[] | null>(null);
  const [results, setResults] = useState<DirectoryUser[]>([]);
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteName, setInviteName] = useState('');
  const [inviteRole, setInviteRole] = useState('USER');
  const [inviting, setInviting] = useState(false);
  const [canEditNames, setCanEditNames] = useState(false);
  const [directoryError, setDirectoryError] = useState<string | null>(null);
  const [editingName, setEditingName] = useState<{ iUserId: number; value: string } | null>(null);

  const load = useCallback(() => {
    adminApi
      .listTenantUsers(tenantId)
      .then((res) => {
        setUsers(res.users);
        setCanEditNames(res.canEditDisplayName);
        setDirectoryError(res.directoryError);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Failed to load'));
  }, [tenantId]);

  useEffect(() => {
    load();
  }, [load]);

  const search = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    try {
      const res = await adminApi.searchDirectory(query);
      setResults(res.users);
      setStatus(`${res.users.length} matching platform user(s)`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Directory search failed');
    }
  };

  const assign = async (identityUserId: number, role: string, enabled = true) => {
    setError(null);
    try {
      await adminApi.saveTenantUser(tenantId, identityUserId, role, enabled);
      setStatus(`Saved user ${identityUserId}: ${role}${enabled ? '' : ' (disabled)'}`);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Assignment failed');
    }
  };

  const invite = async (event: React.FormEvent) => {
    event.preventDefault();
    setInviting(true);
    setError(null);
    try {
      const { user } = await adminApi.ensureDirectoryUser(
        inviteEmail.trim(),
        inviteName.trim() || null,
      );
      await assign(user.iUserId, inviteRole);
      setStatus(
        `Added ${inviteEmail.trim()} as ${inviteRole}. They gain access once they sign in ` +
          'with this address through identity.',
      );
      setInviteEmail('');
      setInviteName('');
      setInviteRole('USER');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not add that user');
    } finally {
      setInviting(false);
    }
  };

  const saveDisplayName = async () => {
    if (!editingName) return;
    setError(null);
    try {
      await adminApi.updateDirectoryUser(editingName.iUserId, editingName.value.trim() || null);
      setStatus(`Saved the display name for user ${editingName.iUserId}`);
      setEditingName(null);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save the display name');
    }
  };

  return (
    <section aria-labelledby="tenant-users-heading">
      <p>
        <Link to="/tenants">← All tenants</Link>
      </p>
      <h1 id="tenant-users-heading">Tenant users</h1>
      {error ? <p role="alert">{error}</p> : null}
      {status ? <p role="status">{status}</p> : null}
      {directoryError ? (
        <p role="alert">
          Names and emails are unavailable: {directoryError} Roles can still be changed.
        </p>
      ) : null}

      {users === null ? (
        <p role="status">Loading…</p>
      ) : users.length === 0 ? (
        <p>No users are mapped to this tenant yet.</p>
      ) : (
        <table>
          <caption className="visually-hidden">Users mapped to this tenant</caption>
          <thead>
            <tr>
              <th scope="col">Person</th>
              <th scope="col">Email</th>
              <th scope="col">Role</th>
              <th scope="col">Enabled</th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr key={user.id}>
                <td>
                  {editingName?.iUserId === user.identity_user_id ? (
                    <>
                      <label>
                        <span className="visually-hidden">
                          Display name for user {user.identity_user_id}
                        </span>
                        <input
                          value={editingName.value}
                          onChange={(e) =>
                            setEditingName({ ...editingName, value: e.target.value })
                          }
                        />
                      </label>{' '}
                      <button type="button" onClick={() => void saveDisplayName()}>
                        Save name
                      </button>{' '}
                      <button type="button" onClick={() => setEditingName(null)}>
                        Cancel
                      </button>
                    </>
                  ) : (
                    <>
                      {user.display_name ?? <em>no name</em>} (#{user.identity_user_id})
                      {user.claimed === false ? ' — not yet signed in' : ''}{' '}
                      {canEditNames ? (
                        <button
                          type="button"
                          onClick={() =>
                            setEditingName({
                              iUserId: user.identity_user_id,
                              value: user.display_name ?? '',
                            })
                          }
                        >
                          Edit name
                        </button>
                      ) : null}
                    </>
                  )}
                </td>
                <td>{user.email ?? '—'}</td>
                <td>
                  <label>
                    <span className="visually-hidden">Role for user {user.identity_user_id}</span>
                    <select
                      value={user.role}
                      onChange={(e) =>
                        void assign(user.identity_user_id, e.target.value, user.enabled)
                      }
                    >
                      <option value="TENANT_ADMIN">TENANT_ADMIN</option>
                      <option value="USER">USER</option>
                    </select>
                  </label>
                </td>
                <td>
                  <label>
                    <input
                      type="checkbox"
                      checked={user.enabled}
                      onChange={(e) =>
                        void assign(user.identity_user_id, user.role, e.target.checked)
                      }
                    />
                    <span className="visually-hidden">
                      Enabled for user {user.identity_user_id}
                    </span>
                  </label>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2 id="add-user-heading">Add a user by email</h2>
      <p>
        Any email address can be added — it does not need to already exist. The person gains access
        the first time they sign in with that address through identity.
      </p>
      <form aria-labelledby="add-user-heading" onSubmit={(e) => void invite(e)}>
        <label>
          Email
          <input
            required
            type="email"
            value={inviteEmail}
            onChange={(e) => setInviteEmail(e.target.value)}
          />
        </label>
        <label>
          Display name (optional)
          <input value={inviteName} onChange={(e) => setInviteName(e.target.value)} />
        </label>
        <label>
          Role
          <select value={inviteRole} onChange={(e) => setInviteRole(e.target.value)}>
            <option value="TENANT_ADMIN">TENANT_ADMIN</option>
            <option value="USER">USER</option>
          </select>
        </label>
        <button type="submit" disabled={inviting}>
          {inviting ? 'Adding…' : 'Add user'}
        </button>
      </form>

      <h2 id="find-user-heading">Find an existing platform user</h2>
      <form aria-labelledby="find-user-heading" onSubmit={(e) => void search(e)}>
        <label>
          Search by email or name
          <input value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
        <button type="submit">Search</button>
      </form>
      {results.length > 0 ? (
        <ul>
          {results.map((user) => (
            <li key={user.iUserId}>
              #{user.iUserId} {user.displayName ?? user.email ?? '(no name)'}
              {user.claimed ? '' : ' (not yet signed in)'}{' '}
              <button type="button" onClick={() => void assign(user.iUserId, 'TENANT_ADMIN')}>
                Make tenant admin
              </button>{' '}
              <button type="button" onClick={() => void assign(user.iUserId, 'USER')}>
                Make user
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
