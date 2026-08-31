import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { adminApi, ApiError, type Tenant, type TenantInput } from '../api/admin';

const EMPTY: TenantInput = { name: '', slug: '', asteriskContext: '', enabled: true };

export function TenantsScreen() {
  const [tenants, setTenants] = useState<Tenant[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [form, setForm] = useState<TenantInput>(EMPTY);
  const [editing, setEditing] = useState<Tenant | null>(null);
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

  const startEdit = (tenant: Tenant) => {
    setEditing(tenant);
    setStatus(null);
    setError(null);
    setForm({
      name: tenant.name,
      slug: tenant.slug,
      asteriskContext: tenant.asterisk_context,
      enabled: tenant.enabled,
    });
  };

  const cancelEdit = () => {
    setEditing(null);
    setForm(EMPTY);
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setStatus(null);
    try {
      if (editing) {
        // The revision guards against overwriting a concurrent edit.
        await adminApi.updateTenant(editing.id, editing.revision, form);
        setStatus(`Saved ${form.name}`);
      } else {
        await adminApi.createTenant(form);
        setStatus(`Created ${form.name}`);
      }
      cancelEdit();
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save the tenant');
    } finally {
      setSaving(false);
    }
  };

  return (
    <section aria-labelledby="tenants-heading">
      <h1 id="tenants-heading">Tenants</h1>
      {error ? <p role="alert">{error}</p> : null}
      {status ? <p role="status">{status}</p> : null}
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
              <th scope="col">Actions</th>
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
                  <button type="button" onClick={() => startEdit(tenant)}>
                    Edit
                  </button>{' '}
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

      <h2 id="tenant-form-heading">{editing ? `Edit ${editing.name}` : 'New tenant'}</h2>
      <form aria-labelledby="tenant-form-heading" onSubmit={(e) => void submit(e)}>
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
        <label>
          <input
            type="checkbox"
            checked={form.enabled}
            onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
          />
          Enabled
        </label>
        <button type="submit" disabled={saving}>
          {saving ? 'Saving…' : editing ? 'Save tenant' : 'Create tenant'}
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
