import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { adminApi, ApiError, type Tenant } from '../api/admin';

export function TenantsScreen() {
  const [tenants, setTenants] = useState<Tenant[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ name: '', slug: '', asteriskContext: '' });
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    adminApi
      .listTenants()
      .then((res) => setTenants(res.tenants))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Failed to load'));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await adminApi.createTenant({ ...form, enabled: true });
      setForm({ name: '', slug: '', asteriskContext: '' });
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create the tenant');
    } finally {
      setSaving(false);
    }
  };

  return (
    <section aria-labelledby="tenants-heading">
      <h1 id="tenants-heading">Tenants</h1>
      {error ? <p role="alert">{error}</p> : null}
      {tenants === null ? (
        <p role="status">Loading tenants…</p>
      ) : tenants.length === 0 ? (
        <p>No tenants yet.</p>
      ) : (
        <table>
          <caption className="visually-hidden">All tenants</caption>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Slug</th>
              <th scope="col">Context</th>
              <th scope="col">Enabled</th>
              <th scope="col">Manage</th>
            </tr>
          </thead>
          <tbody>
            {tenants.map((tenant) => (
              <tr key={tenant.id}>
                <td>{tenant.name}</td>
                <td>{tenant.slug}</td>
                <td>{tenant.asterisk_context}</td>
                <td>{tenant.enabled ? 'Yes' : 'No'}</td>
                <td>
                  <Link to={`/tenants/${tenant.id}/users`}>Users</Link>{' '}
                  <Link to={`/tenants/${tenant.id}/extensions`}>Extensions</Link>{' '}
                  <Link to={`/tenants/${tenant.id}/ring-groups`}>Ring groups</Link>{' '}
                  <Link to={`/tenants/${tenant.id}/profiles`}>Profiles</Link>{' '}
                  <Link to={`/tenants/${tenant.id}/did-routes`}>DID routes</Link>{' '}
                  <Link to={`/tenants/${tenant.id}/appearance`}>Appearance</Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2 id="new-tenant-heading">New tenant</h2>
      <form aria-labelledby="new-tenant-heading" onSubmit={(e) => void submit(e)}>
        <label>
          Name
          <input
            required
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
        </label>
        <label>
          Slug
          <input
            required
            value={form.slug}
            onChange={(e) => setForm({ ...form, slug: e.target.value })}
          />
        </label>
        <label>
          Asterisk context
          <input
            required
            value={form.asteriskContext}
            onChange={(e) => setForm({ ...form, asteriskContext: e.target.value })}
          />
        </label>
        <button type="submit" disabled={saving}>
          {saving ? 'Creating…' : 'Create tenant'}
        </button>
      </form>
    </section>
  );
}
