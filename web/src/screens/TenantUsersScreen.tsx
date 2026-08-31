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

  const load = useCallback(() => {
    adminApi
      .listTenantUsers(tenantId)
      .then((res) => setUsers(res.users))
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
      setStatus(`${res.users.length} matching central user(s)`);
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

  return (
    <section aria-labelledby="tenant-users-heading">
      <p>
        <Link to="/tenants">← All tenants</Link>
      </p>
      <h1 id="tenant-users-heading">Tenant users</h1>
      {error ? <p role="alert">{error}</p> : null}
      {status ? <p role="status">{status}</p> : null}

      {users === null ? (
        <p role="status">Loading…</p>
      ) : users.length === 0 ? (
        <p>No users are mapped to this tenant yet.</p>
      ) : (
        <table>
          <caption className="visually-hidden">Users mapped to this tenant</caption>
          <thead>
            <tr>
              <th scope="col">Central user</th>
              <th scope="col">Role</th>
              <th scope="col">Enabled</th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr key={user.id}>
                <td>#{user.identity_user_id}</td>
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

      <h2 id="find-user-heading">Find a central user</h2>
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
              #{user.iUserId} {user.displayName ?? user.email ?? '(no name)'}{' '}
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
