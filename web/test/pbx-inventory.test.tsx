import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { PbxInventoryScreen } from '../src/screens/PbxInventoryScreen';

afterEach(() => vi.unstubAllGlobals());

function mount(kind: 'extensions' | 'queues') {
  render(
    <MemoryRouter initialEntries={[`/tenants/7/${kind}`]}>
      <Routes>
        <Route path="/tenants/:tenantId/:kind" element={<PbxInventoryScreen kind={kind} />} />
      </Routes>
    </MemoryRouter>,
  );
}

it('shows native endpoint identifiers read-only without provisioning controls', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            source: 'asterisk',
            iTenantId: 7,
            extensions: [
              {
                id: 'pbx-endpoint-100',
                context: 'office',
                callerId: 'Reception',
                transport: null,
                aors: '100',
              },
            ],
          }),
        ),
    ),
  );
  mount('extensions');
  expect(await screen.findByText('pbx-endpoint-100')).toBeInTheDocument();
  expect(screen.getByText(/endpoint IDs may differ/)).toBeInTheDocument();
  expect(
    screen.queryByRole('button', { name: /create|edit|enroll|rotate|retry/i }),
  ).not.toBeInTheDocument();
});

it('shows queue strategy and persisted members without calling them ring groups', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            source: 'asterisk',
            iTenantId: 7,
            queues: [
              {
                id: 'support',
                name: 'Support',
                strategy: 'rrmemory',
                members: [
                  { interface: 'PJSIP/100', memberName: 'Reception', penalty: 1, paused: true },
                ],
              },
            ],
          }),
        ),
    ),
  );
  mount('queues');
  expect(await screen.findByText('Support')).toBeInTheDocument();
  expect(screen.getByText(/configured paused/)).toBeInTheDocument();
  expect(screen.queryByText(/ring groups/i)).not.toBeInTheDocument();
});

it('shows an API failure without presenting it as empty inventory', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () => new Response(JSON.stringify({ message: 'PBX unavailable' }), { status: 502 }),
    ),
  );
  mount('queues');
  expect(await screen.findByRole('alert')).toHaveTextContent('PBX unavailable');
  expect(screen.queryByText(/No queues configured/)).not.toBeInTheDocument();
});
