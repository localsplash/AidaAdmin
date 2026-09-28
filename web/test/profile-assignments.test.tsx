import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProfilesScreen } from '../src/screens/ProfilesScreen';
import { TenantNumbersScreen } from '../src/screens/TenantNumbersScreen';
import type { AssistantProfile, ProfileAssignment } from '../src/api/admin';

// Assignments are keyed by PBX instance, context and DID; the tenant only
// authorizes them. The blank DID row is the context default.
const instance = 'officepulse-test';
const native = {
  source: 'asterisk',
  pbxInstanceId: instance,
  context: 'office',
  contexts: ['office', 'afterhours'],
  provisioningEnabled: true,
};
const number = {
  iPhoneNumberId: 1,
  iTenantId: 1,
  phoneNumber: '+15105550100',
  label: 'Main',
  bVoice: true,
  bMessaging: true,
  bEnabled: true,
  accessPolicy: 'TENANT_MEMBERS',
  iVersion: 1,
};
const profile = (id: string, name: string, enabled = true): AssistantProfile => ({
  id,
  name,
  business_name: 'Acme',
  prompt: 'Take a message.',
  tone: null,
  objective: null,
  opening_statement: null,
  transfer_statement: null,
  failed_transfer_statement: null,
  enabled,
  revision: 1,
});
const profiles = [
  profile('p1', 'Reception'),
  profile('p2', 'After hours'),
  profile('p3', 'Off', false),
];
const stored: ProfileAssignment = {
  id: '3d8b6c4e-5d0c-4b6a-9d3e-1f2a3b4c5d6e',
  pbxInstanceId: instance,
  context: 'office',
  did: number.phoneNumber,
  profileId: 'p2',
  enabled: true,
  revision: 1,
};
type Result = { status?: number; body?: unknown };
function mockFetch(
  state: { assignments: ProfileAssignment[]; pbxInstanceId: string | null },
  handler: (url: string, init: RequestInit) => Result | undefined = () => undefined,
) {
  const fetcher = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const path = url.split('?')[0]!;
    let result = handler(url, init);
    if (!result && init.method === 'GET') {
      if (path.endsWith('/numbers')) result = { body: { numbers: [number] } };
      if (path.endsWith('/queues')) result = { body: { ...native, queues: [] } };
      if (path.endsWith('/did-routes'))
        result = { body: { ...native, didContext: 'from-carrier', dids: [], numbers: [number] } };
      if (path.endsWith('/profiles')) result = { body: { profiles } };
      if (path.endsWith('/profile-assignments'))
        result = {
          body: {
            pbxInstanceId: state.pbxInstanceId,
            contexts: native.contexts,
            assignments: state.assignments,
          },
        };
    }
    result ??= { status: 404, body: { message: 'Missing fixture' } };
    return new Response(result.status === 204 ? null : JSON.stringify(result.body ?? {}), {
      status: result.status ?? 200,
    });
  });
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}
const mutations = (fetcher: ReturnType<typeof mockFetch>) =>
  fetcher.mock.calls
    .filter(([, init]) => init?.method !== 'GET')
    .map(([url, init]) => ({
      url: String(url),
      method: init!.method,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    }));
function renderScreen(kind: 'numbers' | 'profiles') {
  return render(
    <MemoryRouter initialEntries={[`/tenants/1/${kind}`]}>
      <Routes>
        <Route
          path={`/tenants/:tenantId/${kind}`}
          element={kind === 'numbers' ? <TenantNumbersScreen /> : <ProfilesScreen />}
        />
      </Routes>
    </MemoryRouter>,
  );
}
afterEach(() => vi.unstubAllGlobals());

describe('per-number assistant profile', () => {
  it('assigns an enabled profile to the DID in the selected context and offers the context default', async () => {
    const state = { assignments: [] as ProfileAssignment[], pbxInstanceId: instance };
    const fetcher = mockFetch(state, (url, init) =>
      init.method === 'PUT' && url.endsWith('/profile-assignments')
        ? ((state.assignments = [{ ...stored, profileId: 'p1' }]),
          { body: { pbxInstanceId: instance, assignment: { ...stored, profileId: 'p1' } } })
        : undefined,
    );
    const user = userEvent.setup();
    renderScreen('numbers');
    const form = await screen.findByRole('form', {
      name: `Assistant profile for ${number.phoneNumber}`,
    });
    const select = within(form).getByLabelText('Assistant profile');
    expect(select).toHaveValue('');
    // Only enabled profiles are offered, after the context-default option.
    expect(
      within(select)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Use context default', 'Reception', 'After hours']);
    expect(within(form).getByRole('button', { name: 'Save assistant profile' })).toBeDisabled();
    await user.selectOptions(select, 'p1');
    await user.click(within(form).getByRole('button', { name: 'Save assistant profile' }));
    expect(await within(form).findByRole('status')).toHaveTextContent(
      `Assistant profile saved for ${number.phoneNumber} on PBX instance ${instance}`,
    );
    expect(mutations(fetcher)).toEqual([
      {
        url: '/admin/tenants/1/profile-assignments',
        method: 'PUT',
        body: { context: 'office', did: number.phoneNumber, profileId: 'p1' },
      },
    ]);
    await waitFor(() => expect(select).toHaveValue('p1'));
  });
  it('follows the selected context and removes the row when the context default is chosen', async () => {
    const state = { assignments: [stored], pbxInstanceId: instance };
    const fetcher = mockFetch(state, (url, init) => {
      const context = new URL(url, 'http://test').searchParams.get('context') ?? 'office';
      if (init.method === 'DELETE') {
        state.assignments = [];
        return { status: 204 };
      }
      if (init.method === 'PUT') return { body: { pbxInstanceId: instance, assignment: stored } };
      if (url.includes('/did-routes'))
        return {
          body: { ...native, context, didContext: 'from-carrier', dids: [], numbers: [number] },
        };
      if (url.includes('/queues')) return { body: { ...native, context, queues: [] } };
      return undefined;
    });
    const user = userEvent.setup();
    renderScreen('numbers');
    const form = await screen.findByRole('form', {
      name: `Assistant profile for ${number.phoneNumber}`,
    });
    await waitFor(() => expect(within(form).getByLabelText('Assistant profile')).toHaveValue('p2'));
    await user.selectOptions(screen.getByLabelText('Context'), 'afterhours');
    // The stored row belongs to office; afterhours has no DID assignment yet.
    await waitFor(() => expect(within(form).getByLabelText('Assistant profile')).toHaveValue(''));
    await user.selectOptions(within(form).getByLabelText('Assistant profile'), 'p1');
    await user.click(within(form).getByRole('button', { name: 'Save assistant profile' }));
    await waitFor(() => expect(mutations(fetcher)).toHaveLength(1));
    expect(mutations(fetcher)[0]!.body).toEqual({
      context: 'afterhours',
      did: number.phoneNumber,
      profileId: 'p1',
    });
    await user.selectOptions(screen.getByLabelText('Context'), 'office');
    await waitFor(() => expect(within(form).getByLabelText('Assistant profile')).toHaveValue('p2'));
    await user.selectOptions(within(form).getByLabelText('Assistant profile'), '');
    await user.click(within(form).getByRole('button', { name: 'Save assistant profile' }));
    await waitFor(() => expect(mutations(fetcher)).toHaveLength(2));
    expect(mutations(fetcher)[1]).toEqual({
      url: `/admin/tenants/1/profile-assignments/${stored.id}`,
      method: 'DELETE',
      body: undefined,
    });
    expect(await within(form).findByRole('status')).toHaveTextContent('Assignment removed');
  });
  it('refuses to save while OfficePulse has not reported its PBX instance and keeps the failure local', async () => {
    const state = { assignments: [] as ProfileAssignment[], pbxInstanceId: null };
    const fetcher = mockFetch(state, (_url, init) =>
      init.method === 'PUT'
        ? {
            status: 503,
            body: {
              error: 'officepulse_unavailable',
              message: 'OfficePulse did not report its PBX instance; retry when it is reachable',
              correlationId: 'assign-503',
            },
          }
        : undefined,
    );
    const user = userEvent.setup();
    renderScreen('numbers');
    const form = await screen.findByRole('form', {
      name: `Assistant profile for ${number.phoneNumber}`,
    });
    expect(form).toHaveTextContent('has not reported its PBX instance');
    await user.selectOptions(within(form).getByLabelText('Assistant profile'), 'p1');
    await user.click(within(form).getByRole('button', { name: 'Save assistant profile' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent('assign-503');
    expect(mutations(fetcher)).toHaveLength(1);
    expect(within(form).getByLabelText('Assistant profile')).toHaveValue('p1');
  });
  it('keeps Numbers usable when assignments cannot be loaded', async () => {
    mockFetch({ assignments: [], pbxInstanceId: instance }, (url) =>
      url.endsWith('/profile-assignments') ? { status: 503, body: {} } : undefined,
    );
    renderScreen('numbers');
    const card = await screen.findByRole('article', { name: number.phoneNumber });
    await waitFor(() => expect(card).toHaveTextContent('Assistant profile: Unavailable'));
    expect(screen.getByText(/assignments are unavailable/)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('context default profiles', () => {
  it('offers one default per authorized context and saves it with a null DID', async () => {
    const state = {
      assignments: [{ ...stored, id: 'default-1', did: '', profileId: 'p1' }],
      pbxInstanceId: instance,
    };
    const fetcher = mockFetch(state, (_url, init) =>
      init.method === 'PUT'
        ? { body: { pbxInstanceId: instance, assignment: { ...stored, did: '' } } }
        : undefined,
    );
    const user = userEvent.setup();
    renderScreen('profiles');
    const office = await screen.findByRole('form', { name: /for context office$/ });
    const afterhours = screen.getByRole('form', { name: /for context afterhours$/ });
    await waitFor(() =>
      expect(within(office).getByLabelText('Default profile for context office')).toHaveValue('p1'),
    );
    expect(within(afterhours).getByLabelText('Default profile for context afterhours')).toHaveValue(
      '',
    );
    expect(screen.getByText(/stored per PBX instance/)).toHaveTextContent(instance);
    await user.selectOptions(
      within(afterhours).getByLabelText('Default profile for context afterhours'),
      'p2',
    );
    await user.click(within(afterhours).getByRole('button', { name: 'Save assistant profile' }));
    await waitFor(() => expect(mutations(fetcher)).toHaveLength(1));
    expect(mutations(fetcher)[0]).toEqual({
      url: '/admin/tenants/1/profile-assignments',
      method: 'PUT',
      body: { context: 'afterhours', did: null, profileId: 'p2' },
    });
    expect(await within(afterhours).findByRole('status')).toHaveTextContent(
      'saved for context afterhours',
    );
  });
  it('points at Tenants when no context is assigned yet', async () => {
    mockFetch({ assignments: [], pbxInstanceId: instance }, (url) =>
      url.endsWith('/profile-assignments')
        ? { body: { pbxInstanceId: instance, contexts: [], assignments: [] } }
        : undefined,
    );
    renderScreen('profiles');
    expect(
      await screen.findByText(/Assign this tenant’s Asterisk context in Tenants first/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: /for context/ })).not.toBeInTheDocument();
  });
});
