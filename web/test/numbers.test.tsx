import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { TenantNumbersScreen } from '../src/screens/TenantNumbersScreen';
afterEach(() => vi.unstubAllGlobals());
it('saves an explicit all-members assignment with both services and preserves immutable numbers during editing', async () => {
  const number = {
    iPhoneNumberId: 7,
    iTenantId: 1,
    phoneNumber: '+17145550100',
    label: 'Office',
    bEnabled: true,
    bVoice: true,
    bMessaging: true,
    accessPolicy: 'TENANT_MEMBERS',
    iVersion: 3,
  };
  const saved: unknown[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url, init?: RequestInit) => {
      if (!String(url).includes('/numbers')) return new Response('{}', { status: 503 });
      if (init?.method === 'PUT') {
        saved.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify({ number }));
      }
      return new Response(JSON.stringify({ numbers: [number] }));
    }),
  );
  render(
    <MemoryRouter initialEntries={['/tenants/1/numbers']}>
      <Routes>
        <Route path="/tenants/:tenantId/numbers" element={<TenantNumbersScreen />} />
      </Routes>
    </MemoryRouter>,
  );
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Edit +17145550100' }));
  expect(screen.getByLabelText('Phone number')).toHaveAttribute('readonly');
  await user.clear(screen.getByLabelText('Label'));
  await user.type(screen.getByLabelText('Label'), 'Reception');
  await user.click(screen.getByRole('button', { name: 'Save number' }));
  expect(saved).toEqual([
    {
      phoneNumber: '+17145550100',
      label: 'Reception',
      bEnabled: true,
      bVoice: true,
      bMessaging: true,
      accessPolicy: 'TENANT_MEMBERS',
      expectedVersion: 3,
    },
  ]);
});

it('creates a globally unique Number / DID through Identity and refreshes PBX routing', async () => {
  const created = {
    iPhoneNumberId: 8,
    iTenantId: 1,
    phoneNumber: '+19492799074',
    label: 'Main line',
    bEnabled: true,
    bVoice: true,
    bMessaging: true,
    accessPolicy: 'TENANT_MEMBERS',
    iVersion: 1,
  } as const;
  let numbers: unknown[] = [];
  const saved: unknown[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url, init?: RequestInit) => {
      const path = String(url);
      if (path.endsWith('/numbers')) {
        if (init?.method === 'POST') {
          saved.push(JSON.parse(String(init.body)));
          numbers = [created];
          return new Response(JSON.stringify({ number: created }));
        }
        return new Response(JSON.stringify({ numbers }));
      }
      if (path.endsWith('/did-routes')) {
        return new Response(
          JSON.stringify({
            source: 'asterisk',
            iTenantId: 1,
            provisioningEnabled: true,
            numbers,
            dids: numbers.map(() => ({
              did: created.phoneNumber,
              managed: false,
              availability: 'unconfigured',
              applyState: 'unknown',
            })),
          }),
        );
      }
      if (path.endsWith('/queues')) {
        return new Response(
          JSON.stringify({
            source: 'asterisk',
            iTenantId: 1,
            provisioningEnabled: true,
            queues: [],
          }),
        );
      }
      return new Response('{}', { status: 404 });
    }),
  );
  render(
    <MemoryRouter initialEntries={['/tenants/1/numbers']}>
      <Routes>
        <Route path="/tenants/:tenantId/numbers" element={<TenantNumbersScreen />} />
      </Routes>
    </MemoryRouter>,
  );
  const user = userEvent.setup();
  await user.click(await screen.findByText('Add Number / DID…'));
  await user.type(screen.getByLabelText('Phone number'), created.phoneNumber);
  await user.type(screen.getByLabelText('Label'), created.label);
  await user.click(screen.getByRole('button', { name: 'Save number' }));
  expect(saved).toEqual([
    {
      phoneNumber: created.phoneNumber,
      label: created.label,
      bEnabled: true,
      bVoice: true,
      bMessaging: true,
      accessPolicy: 'TENANT_MEMBERS',
    },
  ]);
  expect(await screen.findByText(created.phoneNumber)).toBeInTheDocument();
});
