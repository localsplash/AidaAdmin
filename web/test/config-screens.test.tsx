import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppearanceScreen } from '../src/screens/AppearanceScreen';
import { DidRoutesScreen } from '../src/screens/DidRoutesScreen';
import { ProfilesScreen } from '../src/screens/ProfilesScreen';

type FetchHandler = (url: string, init?: RequestInit) => { status: number; body: unknown } | null;

function mockFetch(handler: FetchHandler) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const result = handler(url, init) ?? { status: 404, body: {} };
      return new Response(JSON.stringify(result.body), { status: result.status });
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderAt(path: string, routePath: string, element: React.ReactElement) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path={routePath} element={element} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('ProfilesScreen', () => {
  it('offers statement fields but no LiveKit voice or model fields', async () => {
    mockFetch((url) =>
      url.includes('/profiles') ? { status: 200, body: { profiles: [] } } : null,
    );
    renderAt('/tenants/t1/profiles', '/tenants/:tenantId/profiles', <ProfilesScreen />);
    expect(await screen.findByLabelText(/prompt/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/failed-transfer statement/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/voice/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/model/i)).not.toBeInTheDocument();
    expect(screen.getByText(/aida-prime/)).toBeInTheDocument();
  });
});

describe('DidRoutesScreen', () => {
  it('lists routes with fallback previews and disables disabled profiles', async () => {
    mockFetch((url) => {
      if (url.includes('/did-routes')) {
        return {
          status: 200,
          body: {
            didRoutes: [
              {
                id: 'r1',
                did_e164: '+15105550100',
                screening_enabled: true,
                enabled: true,
                fallbackPreview: 'Extension 100 — Front Desk',
              },
            ],
          },
        };
      }
      if (url.includes('/profiles')) {
        return {
          status: 200,
          body: {
            profiles: [
              { id: 'p1', name: 'Reception', enabled: true },
              { id: 'p2', name: 'Old profile', enabled: false },
            ],
          },
        };
      }
      if (url.includes('/extensions')) return { status: 200, body: { extensions: [] } };
      if (url.includes('/ring-groups')) return { status: 200, body: { ringGroups: [] } };
      return null;
    });
    renderAt('/tenants/t1/did-routes', '/tenants/:tenantId/did-routes', <DidRoutesScreen />);
    expect(await screen.findByText('Extension 100 — Front Desk')).toBeInTheDocument();
    const disabledOption = screen.getByRole('option', { name: /old profile \(disabled\)/i });
    expect(disabledOption).toBeDisabled();
  });

  it('surfaces a duplicate-DID failure', async () => {
    mockFetch((url, init) => {
      if (url.endsWith('/admin/did-routes') && init?.method === 'POST') {
        return {
          status: 409,
          body: { error: 'duplicate', message: 'A record with the same did_e164 already exists' },
        };
      }
      if (url.includes('/did-routes')) return { status: 200, body: { didRoutes: [] } };
      if (url.includes('/profiles')) {
        return {
          status: 200,
          body: { profiles: [{ id: 'p1', name: 'Reception', enabled: true }] },
        };
      }
      if (url.includes('/extensions')) {
        return {
          status: 200,
          body: { extensions: [{ id: 'e1', extension_number: '100', display_name: 'Front Desk' }] },
        };
      }
      if (url.includes('/ring-groups')) return { status: 200, body: { ringGroups: [] } };
      return null;
    });
    renderAt('/tenants/t1/did-routes', '/tenants/:tenantId/did-routes', <DidRoutesScreen />);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(/did \(e\.164\)/i), '+15105550100');
    await user.selectOptions(screen.getByLabelText(/assistant profile/i), 'p1');
    await user.selectOptions(screen.getByLabelText(/^destination$/i), 'e1');
    await user.click(screen.getByRole('button', { name: /create and provision/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/same did_e164/i);
  });
});

describe('AppearanceScreen', () => {
  it('marks CRM import and history as future features', async () => {
    mockFetch((url) =>
      url.includes('/appearance') ? { status: 200, body: { appearance: null } } : null,
    );
    renderAt('/tenants/t1/appearance', '/tenants/:tenantId/appearance', <AppearanceScreen />);
    expect(await screen.findByText(/crm import/i)).toBeInTheDocument();
    expect(screen.getAllByText(/coming soon/i)).toHaveLength(2);
  });
});
