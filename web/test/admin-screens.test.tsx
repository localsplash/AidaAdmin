import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExtensionsScreen } from '../src/screens/ExtensionsScreen';
import { TenantsScreen } from '../src/screens/TenantsScreen';

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
    await user.type(await screen.findByLabelText(/name/i), 'Acme');
    await user.type(screen.getByLabelText(/slug/i), 'acme');
    await user.type(screen.getByLabelText(/asterisk context/i), 'acme');
    await user.click(screen.getByRole('button', { name: /create tenant/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/same slug/i);
  });
});

function renderExtensions() {
  return render(
    <MemoryRouter initialEntries={['/tenants/ten-1/extensions']}>
      <Routes>
        <Route path="/tenants/:tenantId/extensions" element={<ExtensionsScreen />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('ExtensionsScreen', () => {
  it('shows the one-time SIP credentials exactly once after creation', async () => {
    mockFetch((url, init) => {
      if (url.endsWith('/admin/extensions') && init?.method === 'POST') {
        return {
          status: 201,
          body: {
            extension: { id: 'ext-1' },
            sipUsername: 'sip-100',
            sipSecret: 'shown-once-secret',
          },
        };
      }
      if (url.includes('/admin/tenants/ten-1/extensions')) {
        return { status: 200, body: { extensions: [] } };
      }
      return null;
    });
    renderExtensions();
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(/extension number/i), '100');
    await user.type(screen.getByLabelText(/display name/i), 'Front Desk');
    await user.click(screen.getByRole('button', { name: /create and provision/i }));

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('shown-once-secret');
    expect(dialog).toHaveTextContent(/shown once/i);

    await user.click(screen.getByRole('button', { name: /i have copied/i }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(screen.queryByText('shown-once-secret')).not.toBeInTheDocument();
  });

  it('reports a provisioning failure clearly', async () => {
    mockFetch((url, init) => {
      if (url.endsWith('/admin/extensions') && init?.method === 'POST') {
        return {
          status: 502,
          body: {
            error: 'provisioning_failed',
            message: 'The record was saved, but PBX provisioning failed.',
          },
        };
      }
      if (url.includes('/admin/tenants/ten-1/extensions')) {
        return { status: 200, body: { extensions: [] } };
      }
      return null;
    });
    renderExtensions();
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(/extension number/i), '100');
    await user.type(screen.getByLabelText(/display name/i), 'Front Desk');
    await user.click(screen.getByRole('button', { name: /create and provision/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/PBX provisioning failed/i);
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
    expect(screen.getByLabelText(/name/i)).toHaveValue('Acme');
    expect(screen.getByLabelText(/slug/i)).toHaveValue('acme');
    expect(screen.getByLabelText(/asterisk context/i)).toHaveValue('acme');

    await user.clear(screen.getByLabelText(/name/i));
    await user.type(screen.getByLabelText(/name/i), 'Acme Dental');
    await user.click(screen.getByRole('button', { name: /save tenant/i }));

    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]!.url).toBe('/admin/tenants/ten-1');
    expect(puts[0]!.body.name).toBe('Acme Dental');
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

describe('extension without a PBX', () => {
  it('reports the record as saved rather than failing', async () => {
    mockFetch((url, init) => {
      if (url.endsWith('/admin/extensions') && init?.method === 'POST') {
        return {
          status: 201,
          body: {
            extension: { id: 'ext-1' },
            provisioning: 'not_configured',
            message: 'Extension saved. OFFICEPULSE_PROVISIONING_BASE_URL is not set…',
          },
        };
      }
      if (url.includes('/admin/tenants/ten-1/extensions')) {
        return { status: 200, body: { extensions: [] } };
      }
      return null;
    });
    render(
      <MemoryRouter initialEntries={['/tenants/ten-1/extensions']}>
        <Routes>
          <Route path="/tenants/:tenantId/extensions" element={<ExtensionsScreen />} />
        </Routes>
      </MemoryRouter>,
    );
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(/extension number/i), '100');
    await user.type(screen.getByLabelText(/display name/i), 'Front Desk');
    await user.click(screen.getByRole('button', { name: /create and provision/i }));

    expect(await screen.findByRole('status')).toHaveTextContent(/Extension saved/i);
    // No credential panel, because no secret was issued.
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
