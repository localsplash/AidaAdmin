import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App';
import type { SessionView } from '../src/api/session';

const authenticatedSession: SessionView = {
  authenticated: true,
  user: { iUserId: 7, displayName: 'Ada Admin', email: 'ada@example.invalid', superAdmin: true },
  selectedTenant: null,
};

function mockSessionResponse(status: number, body: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status })),
  );
}

function renderApp(path = '/') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('App shell', () => {
  it('shows the loading state while the session is being fetched', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => {})),
    );
    renderApp();
    expect(screen.getByRole('status')).toHaveTextContent(/loading aidaadmin/i);
  });

  it('shows the login-required state for a 401 session response', async () => {
    mockSessionResponse(401, { authenticated: false });
    renderApp();
    expect(await screen.findByRole('heading', { name: /sign in required/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /sign in/i })).toBeInTheDocument();
  });

  it('shows the forbidden state for a 403 session response', async () => {
    mockSessionResponse(403, { error: 'forbidden' });
    renderApp();
    expect(await screen.findByRole('heading', { name: /access denied/i })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('shows a retryable error state when the session fetch fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      }),
    );
    renderApp();
    expect(
      await screen.findByRole('heading', { name: /something went wrong/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });

  it('renders the authenticated shell with the persistent tenant banner', async () => {
    mockSessionResponse(200, authenticatedSession);
    renderApp();
    expect(await screen.findByRole('heading', { name: /dashboard/i })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: /primary/i })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(
      /no tenant selected — acting as super admin/i,
    );
    expect(screen.getByText('Ada Admin')).toBeInTheDocument();
  });

  it('names the selected tenant in the banner', async () => {
    mockSessionResponse(200, {
      ...authenticatedSession,
      selectedTenant: {
        tenantId: 'ten-1',
        name: 'Acme Dental',
        slug: 'acme-dental',
        role: 'TENANT_ADMIN',
      },
    });
    renderApp();
    await screen.findByText(/acme dental/i);
    expect(screen.getByRole('status')).toHaveTextContent(/tenant_admin/i);
  });

  it('shows a not-found page for unknown routes when authenticated', async () => {
    mockSessionResponse(200, authenticatedSession);
    renderApp('/no-such-page');
    expect(await screen.findByRole('heading', { name: /page not found/i })).toBeInTheDocument();
  });
});
