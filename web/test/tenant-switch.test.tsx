import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { TenantContextBanner } from '../src/components/TenantContextBanner';
import type { SessionView } from '../src/api/session';
const session: SessionView = {
  authenticated: true,
  user: { iUserId: 1, email: null, displayName: null, superAdmin: true },
  selectedTenant: { tenantId: '1', name: 'First', slug: 'first', role: 'SUPER_ADMIN' },
};
function Location() {
  return <output aria-label="Current path">{useLocation().pathname}</output>;
}
afterEach(() => vi.unstubAllGlobals());
it.each([200, 403])(
  'switches the tenant path only after a successful selection (%s)',
  async (status) => {
    const changed = vi.fn();
    const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).endsWith('/tenants'))
        return new Response(
          JSON.stringify({
            tenants: [
              { ...session.selectedTenant },
              { tenantId: '2', name: 'Second', slug: 'second', role: 'SUPER_ADMIN' },
            ],
          }),
        );
      expect(init?.method).toBe('POST');
      expect(JSON.parse(String(init?.body))).toEqual({ tenantId: '2' });
      return new Response(
        JSON.stringify(status === 200 ? {} : { error: 'forbidden', message: 'Selection refused' }),
        { status },
      );
    });
    vi.stubGlobal('fetch', fetcher);
    render(
      <MemoryRouter initialEntries={['/tenants/1/users']}>
        <TenantContextBanner session={session} onTenantChanged={changed} />
        <Location />
      </MemoryRouter>,
    );
    await screen.findByRole('option', { name: 'Second' });
    await userEvent.setup().selectOptions(screen.getByLabelText('Switch tenant'), '2');
    if (status === 200) {
      await waitFor(() => expect(changed).toHaveBeenCalledOnce());
      expect(screen.getByLabelText('Current path')).toHaveTextContent('/tenants/2/users');
    } else {
      expect(await screen.findByRole('alert')).toHaveTextContent('Selection refused');
      expect(changed).not.toHaveBeenCalled();
      expect(screen.getByLabelText('Current path')).toHaveTextContent('/tenants/1/users');
    }
  },
);
