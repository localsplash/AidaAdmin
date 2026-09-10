import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppearanceScreen } from '../src/screens/AppearanceScreen';
import { ProfilesScreen } from '../src/screens/ProfilesScreen';

type FetchHandler = (url: string, init?: RequestInit) => { status: number; body: unknown } | null;

function mockFetch(handler: FetchHandler) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const result = handler(url, init) ??
        (url.endsWith('/numbers')
          ? {
              status: 200,
              body: {
                numbers: [
                  {
                    iPhoneNumberId: 1,
                    iTenantId: 1,
                    phoneNumber: '+15105550100',
                    label: '',
                    bEnabled: true,
                  },
                ],
              },
            }
          : null) ?? { status: 404, body: {} };
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
