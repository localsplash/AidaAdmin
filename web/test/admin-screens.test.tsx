import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TenantsScreen } from '../src/screens/TenantsScreen';
import { TenantUsersScreen } from '../src/screens/TenantUsersScreen';

type FetchHandler = (url: string, init?: RequestInit) => { status: number; body: unknown } | null;

function mockFetch(handler: FetchHandler) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const result = handler(url, init) ?? { status: 404, body: { error: 'not_found' } };
      return new Response(JSON.stringify(result.body), { status: result.status });
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const tenant = {
  id: 'ten-1',
  name: 'Acme',
  slug: 'acme',
  asterisk_context: 'acme',
  additional_contexts: ['acme-branch'],
  did_context: 'from-carrier',
  caller_id_name: null,
  caller_id_number: null,
  enabled: true,
  revision: 1,
};

describe('TenantsScreen', () => {
  it('lists tenants and links to management screens', async () => {
    mockFetch((url) =>
      url.endsWith('/admin/tenants') ? { status: 200, body: { tenants: [tenant] } } : null,
    );
    render(
      <MemoryRouter>
        <TenantsScreen />
      </MemoryRouter>,
    );
    expect(await screen.findByText('Acme')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /extensions/i })).toHaveAttribute(
      'href',
      '/tenants/ten-1/extensions',
    );
    expect(screen.getByText('acme, acme-branch')).toBeInTheDocument();
    expect(screen.getByText('from-carrier')).toBeInTheDocument();
  });

  it('creates a tenant with its extension contexts and DID context, suggesting instance contexts', async () => {
    const posts: unknown[] = [];
    mockFetch((url, init) => {
      if (url === '/admin/pbx/contexts')
        return {
          status: 200,
          body: {
            source: 'asterisk',
            pbxInstanceId: 'officepulse-test',
            contexts: ['from-carrier', 'other'],
          },
        };
      if (url.endsWith('/admin/tenants') && init?.method === 'POST') {
        posts.push(JSON.parse(String(init.body)));
        return { status: 201, body: { tenant } };
      }
      if (url.endsWith('/admin/tenants')) return { status: 200, body: { tenants: [] } };
      return null;
    });
    render(
      <MemoryRouter>
        <TenantsScreen />
      </MemoryRouter>,
    );
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(/^name/i), 'Acme');
    await user.type(screen.getByLabelText(/slug/i), 'acme');
    await user.type(screen.getByLabelText(/^asterisk context/i), 'acme');
    await user.type(
      screen.getByLabelText(/additional asterisk contexts/i),
      'acme-branch, acme-lab',
    );
    await user.type(screen.getByLabelText(/inbound did context/i), 'from-carrier');
    // The datalist is the Super Admin's view of the instance; it grants nothing.
    await waitFor(() =>
      expect(
        Array.from(document.querySelectorAll('datalist#pbx-contexts option')).map(
          (option) => (option as HTMLOptionElement).value,
        ),
      ).toEqual(['from-carrier', 'other']),
    );
    expect(screen.getByLabelText(/^asterisk context/i)).toHaveAttribute('list', 'pbx-contexts');
    await user.click(screen.getByRole('button', { name: /create tenant/i }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({
      name: 'Acme',
      slug: 'acme',
      asteriskContext: 'acme',
      additionalContexts: ['acme-branch', 'acme-lab'],
      didContext: 'from-carrier',
      enabled: true,
    });
  });

  it('surfaces a context claimed by another tenant', async () => {
    mockFetch((url, init) => {
      if (url.endsWith('/admin/tenants') && init?.method === 'POST') {
        return {
          status: 409,
          body: {
            error: 'duplicate',
            message: 'Asterisk context acme already belongs to another tenant',
          },
        };
      }
      if (url.endsWith('/admin/tenants')) return { status: 200, body: { tenants: [] } };
      return null;
    });
    render(
      <MemoryRouter>
        <TenantsScreen />
      </MemoryRouter>,
    );
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(/^name/i), 'Other');
    await user.type(screen.getByLabelText(/slug/i), 'other');
    await user.type(screen.getByLabelText(/^asterisk context/i), 'acme');
    await user.click(screen.getByRole('button', { name: /create tenant/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/already belongs to another tenant/);
  });

  it('surfaces a duplicate-slug failure from the server', async () => {
    mockFetch((url, init) => {
      if (url.endsWith('/admin/tenants') && init?.method === 'POST') {
        return {
          status: 409,
          body: { error: 'duplicate', message: 'A record with the same slug already exists' },
        };
      }
      if (url.endsWith('/admin/tenants')) return { status: 200, body: { tenants: [] } };
      return null;
    });
    render(
      <MemoryRouter>
        <TenantsScreen />
      </MemoryRouter>,
    );
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(/^name/i), 'Acme');
    await user.type(screen.getByLabelText(/slug/i), 'acme');
    await user.type(screen.getByLabelText(/^asterisk context/i), 'acme');
    await user.click(screen.getByRole('button', { name: /create tenant/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/same slug/i);
  });
});

describe('editing existing records', () => {
  it('prefills the tenant form and saves with the record revision', async () => {
    const puts: Array<{ url: string; body: Record<string, unknown> }> = [];
    mockFetch((url, init) => {
      if (url.endsWith('/admin/tenants') && init?.method === 'PUT') return null;
      if (init?.method === 'PUT') {
        puts.push({ url, body: JSON.parse(String(init.body)) });
        return { status: 200, body: { tenant } };
      }
      if (url.endsWith('/admin/tenants')) return { status: 200, body: { tenants: [tenant] } };
      return null;
    });
    render(
      <MemoryRouter>
        <TenantsScreen />
      </MemoryRouter>,
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /edit/i }));

    // The form is populated from the record, not blank.
    expect(screen.getByLabelText(/^name/i)).toHaveValue('Acme');
    expect(screen.getByLabelText(/slug/i)).toHaveValue('acme');
    expect(screen.getByLabelText(/^asterisk context/i)).toHaveValue('acme');
    expect(screen.getByLabelText(/additional asterisk contexts/i)).toHaveValue('acme-branch');
    expect(screen.getByLabelText(/inbound did context/i)).toHaveValue('from-carrier');

    await user.clear(screen.getByLabelText(/^name/i));
    await user.type(screen.getByLabelText(/^name/i), 'Acme Dental');
    await user.clear(screen.getByLabelText(/inbound did context/i));
    await user.click(screen.getByRole('button', { name: /save tenant/i }));

    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]!.url).toBe('/admin/tenants/ten-1');
    expect(puts[0]!.body.name).toBe('Acme Dental');
    expect(puts[0]!.body.additionalContexts).toEqual(['acme-branch']);
    // A cleared ingress context is stored as none, never as an empty name.
    expect(puts[0]!.body.didContext).toBeNull();
    // The revision is what stops a concurrent edit being overwritten.
    expect(puts[0]!.body.expectedRevision).toBe(1);
  });

  it('reports a stale revision from the server', async () => {
    mockFetch((url, init) => {
      if (init?.method === 'PUT') {
        return {
          status: 409,
          body: { error: 'revision_conflict', message: 'tenant was modified by someone else' },
        };
      }
      if (url.endsWith('/admin/tenants')) return { status: 200, body: { tenants: [tenant] } };
      return null;
    });
    render(
      <MemoryRouter>
        <TenantsScreen />
      </MemoryRouter>,
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /edit/i }));
    await user.click(screen.getByRole('button', { name: /save tenant/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/modified by someone else/i);
  });
});

function renderTenantUsers() {
  return render(
    <MemoryRouter initialEntries={['/tenants/ten-1/users']}>
      <Routes>
        <Route path="/tenants/:tenantId/users" element={<TenantUsersScreen />} />
      </Routes>
    </MemoryRouter>,
  );
}

const MEMBER = {
  id: 'tu-1',
  tenant_id: 'ten-1',
  identity_user_id: 42,
  role: 'USER',
  enabled: true,
  email: 'pat@example.invalid',
  display_name: 'Pat',
  claimed: true,
};

describe('tenant user management', () => {
  function members(superAdmin = false, claimed = true) {
    return {
      users: [{ ...MEMBER, claimed }],
      canManageDirectory: true,
      assignableRoles: superAdmin
        ? ['SUPER_ADMIN', 'TENANT_ADMIN', 'USER']
        : ['TENANT_ADMIN', 'USER'],
    };
  }
  it('adds a user and role together through the tenant-scoped endpoint', async () => {
    const posts: unknown[] = [];
    mockFetch((url, init) => {
      if (url !== '/admin/tenants/ten-1/users') return null;
      if (init?.method === 'POST') {
        posts.push(JSON.parse(String(init.body)));
        return { status: 201, body: {} };
      }
      return { status: 200, body: members(true) };
    });
    renderTenantUsers();
    const user = userEvent.setup();
    await user.click(await screen.findByText('Add User…'));
    await user.type(screen.getByLabelText('Email address'), 'new@example.invalid');
    await user.selectOptions(screen.getByLabelText('Role'), 'SUPER_ADMIN');
    await user.click(screen.getByRole('button', { name: 'Add user' }));
    await waitFor(() =>
      expect(posts).toEqual([
        { email: 'new@example.invalid', displayName: null, role: 'SUPER_ADMIN', enabled: true },
      ]),
    );
    expect(await screen.findByRole('status')).toHaveTextContent('Added new@example.invalid');
  });
  it('edits the whole record once, keeps linked email read-only, and limits tenant roles', async () => {
    const puts: unknown[] = [];
    mockFetch((url, init) => {
      if (init?.method === 'PUT') {
        expect(url).toBe('/admin/tenants/ten-1/users/42');
        puts.push(JSON.parse(String(init.body)));
        return { status: 200, body: {} };
      }
      return { status: 200, body: members() };
    });
    renderTenantUsers();
    const user = userEvent.setup();
    expect(await screen.findByText('pat@example.invalid')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Edit Pat' }));
    expect(screen.getByLabelText('Email address')).toHaveAttribute('readonly');
    expect(screen.queryByRole('option', { name: 'Super Admin' })).not.toBeInTheDocument();
    await user.clear(screen.getByLabelText('Display name'));
    await user.type(screen.getByLabelText('Display name'), 'Patricia');
    await user.selectOptions(screen.getByLabelText('Role'), 'TENANT_ADMIN');
    await user.click(screen.getByRole('button', { name: 'Save user' }));
    await waitFor(() =>
      expect(puts).toEqual([{ displayName: 'Patricia', role: 'TENANT_ADMIN', enabled: true }]),
    );
  });
  it('keeps the add form and email on a failed assignment', async () => {
    mockFetch((_url, init) =>
      init?.method === 'POST'
        ? { status: 409, body: { error: 'conflict', message: 'Account conflict' } }
        : { status: 200, body: members() },
    );
    renderTenantUsers();
    const user = userEvent.setup();
    await user.click(await screen.findByText('Add User…'));
    await user.type(screen.getByLabelText('Email address'), 'pending@example.invalid');
    await user.click(screen.getByRole('button', { name: 'Add user' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Account conflict');
    expect(screen.getByLabelText('Email address')).toHaveValue('pending@example.invalid');
  });
  it('shows pending sign-in status and prevents tenant admins editing Super Admins', async () => {
    const body = members(false, false);
    body.users[0]!.role = 'SUPER_ADMIN';
    mockFetch(() => ({ status: 200, body }));
    renderTenantUsers();
    expect(await screen.findByText('Awaiting first sign-in')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Edit/ })).not.toBeInTheDocument();
  });
});
