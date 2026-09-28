import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { adminApi, ApiError, type Tenant, type TenantInput } from '../api/admin';

/** The form keeps the additional contexts as typed; they become a list on submit. */
interface TenantForm extends Omit<TenantInput, 'additionalContexts' | 'didContext'> {
  additionalContexts: string;
  didContext: string;
}
const EMPTY: TenantForm = {
  name: '',
  slug: '',
  asteriskContext: '',
  additionalContexts: '',
  didContext: '',
  enabled: true,
};
function toInput(form: TenantForm): TenantInput {
  return {
    ...form,
    additionalContexts: form.additionalContexts
      .split(',')
      .map((context) => context.trim())
      .filter((context) => context !== ''),
    didContext: form.didContext.trim() || null,
  };
}

/**
 * The list is scoped by the server: every tenant for a Super Admin, the ones
 * they administer for a tenant administrator. Only a Super Admin can create
 * one, so the form is an edit-only form for everyone else rather than a
 * button that leads to a refusal.
 */
export function TenantsScreen({ canCreate = true }: { canCreate?: boolean }) {
  const [tenants, setTenants] = useState<Tenant[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [form, setForm] = useState<TenantForm>(EMPTY);
  const [editing, setEditing] = useState<Tenant | null>(null);
  const [saving, setSaving] = useState(false);
  // Contexts present on the PBX instance, offered as suggestions to Super
  // Admins. Listing them grants nothing; the server still validates ownership.
  const [knownContexts, setKnownContexts] = useState<string[]>([]);

  const load = useCallback(() => {
    adminApi
      .listTenants()
      .then((res) => setTenants(res.tenants))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Failed to load'));
  }, []);

  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => {
    if (!canCreate) return;
    let active = true;
    adminApi
      .listPbxContexts()
      .then((res) => {
        if (active) setKnownContexts(res.contexts);
      })
      .catch(() => {
        // Suggestions only: an unreachable or unconfigured OfficePulse changes nothing.
      });
    return () => {
      active = false;
    };
  }, [canCreate]);

  const startEdit = (tenant: Tenant) => {
    setEditing(tenant);
    setStatus(null);
    setError(null);
    setForm({
      name: tenant.name,
      slug: tenant.slug,
      asteriskContext: tenant.asterisk_context,
      additionalContexts: tenant.additional_contexts.join(', '),
      didContext: tenant.did_context ?? '',
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
        await adminApi.updateTenant(editing.id, editing.revision, toInput(form));
        setStatus(`Saved ${form.name}`);
      } else {
        await adminApi.createTenant(toInput(form));
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
              <th scope="col">Contexts</th>
              <th scope="col">DID context</th>
              <th scope="col">Enabled</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {tenants.map((tenant) => (
              <tr key={tenant.id}>
                <td>{tenant.name}</td>
                <td>{tenant.slug}</td>
                <td>
                  {[tenant.asterisk_context, ...tenant.additional_contexts]
                    .filter(Boolean)
                    .join(', ') || '—'}
                </td>
                <td>{tenant.did_context ?? '—'}</td>
                <td>{tenant.enabled ? 'Yes' : 'No'}</td>
                <td>
                  <button type="button" onClick={() => startEdit(tenant)}>
                    Edit
                  </button>{' '}
                  <Link to={`/tenants/${tenant.id}/users`}>Users</Link>{' '}
                  <Link to={`/tenants/${tenant.id}/extensions`}>Extensions</Link>{' '}
                  <Link to={`/tenants/${tenant.id}/queues`}>Queues</Link>{' '}
                  <Link to={`/tenants/${tenant.id}/profiles`}>Profiles</Link>{' '}
                  <Link to={`/tenants/${tenant.id}/appearance`}>Appearance</Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {!canCreate && !editing ? null : (
        <>
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
                list="pbx-contexts"
                pattern="[a-zA-Z0-9_.\-]{1,40}"
                value={form.asteriskContext}
                onChange={(e) => setForm({ ...form, asteriskContext: e.target.value })}
              />
            </label>
            <label>
              Additional Asterisk contexts (comma-separated)
              <input
                value={form.additionalContexts}
                onChange={(e) => setForm({ ...form, additionalContexts: e.target.value })}
              />
            </label>
            <label>
              Inbound DID context
              <input
                list="pbx-contexts"
                pattern="[a-zA-Z0-9_.\-]{1,40}"
                placeholder="from-carrier"
                value={form.didContext}
                onChange={(e) => setForm({ ...form, didContext: e.target.value })}
              />
            </label>
            <small>
              Extension contexts belong to one tenant each and are the PBX routing scope. The
              inbound DID context is the shared carrier ingress context and must differ from them.
            </small>
            <datalist id="pbx-contexts">
              {knownContexts.map((context) => (
                <option key={context} value={context} />
              ))}
            </datalist>
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
        </>
      )}
    </section>
  );
}
