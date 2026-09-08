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
    vi.fn(async (_url, init?: RequestInit) => {
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
