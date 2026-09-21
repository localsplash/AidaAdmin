import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExtensionsScreen } from '../src/screens/ExtensionsScreen';
import { QueuesScreen } from '../src/screens/QueuesScreen';
import { TenantNumbersScreen } from '../src/screens/TenantNumbersScreen';
import type { DidRoute, Extension, NativeQueue } from '../src/api/admin';

// Native DTO fixtures follow OfficePulse's published /v1/admin/pbx contract as
// the BFF relays it: the routing scope is the PBX instance and context, plus
// the tenant's authorized context list. No tenant id appears.
const native = {
  source: 'asterisk',
  pbxInstanceId: 'officepulse-test',
  context: 'office',
  contexts: ['office'],
  provisioningEnabled: true,
};
const extension: Extension = {
  id: '100-office',
  extension: '100',
  callerId: 'Front Desk',
  context: 'office',
  managed: true,
  applyState: 'unknown',
};
const second: Extension = { ...extension, id: '101-office', extension: '101', callerId: 'Sales' };
const third: Extension = {
  ...extension,
  id: '102-office',
  extension: '102',
  callerId: 'Support',
};
const queue: NativeQueue = {
  id: 't1.reception',
  name: 'reception',
  strategy: 'ringall',
  members: [],
  applyState: 'unknown',
};
const number = {
  iPhoneNumberId: 1,
  iTenantId: 1,
  phoneNumber: '+15105550100',
  label: 'Main',
  bVoice: true,
  bEnabled: true,
};
const unconfigured: DidRoute = {
  did: number.phoneNumber,
  managed: false,
  availability: 'unconfigured',
  applyState: 'unknown',
};
const managed: DidRoute = {
  did: number.phoneNumber,
  managed: true,
  queue: queue.id,
  ringsBeforeAi: 6,
  livekitDestination: number.phoneNumber,
  ringTimeoutSeconds: 30,
  applyState: 'committed',
  schedule: { timeRange: '09:00-17:00', weekdays: 'mon-fri', timezone: 'America/Los_Angeles' },
};
type Result = { status?: number; body?: unknown };
type Handler = (url: string, init: RequestInit) => Result | Promise<Result> | undefined;
function mockFetch(handler: Handler = () => undefined) {
  const fetcher = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    let result = await handler(url, init);
    // A selected context travels as a query; the default fixtures ignore it.
    const path = url.split('?')[0]!;
    if (!result && init.method === 'GET') {
      if (path.endsWith('/handsets')) result = { body: { handsets: [] } };
      if (path.endsWith('/numbers')) result = { body: { numbers: [number] } };
      if (path.endsWith('/extensions'))
        result = { body: { ...native, extensions: [extension, second, third] } };
      if (path.endsWith('/queues')) result = { body: { ...native, queues: [queue] } };
      if (path.endsWith('/did-routes'))
        result = {
          body: { ...native, didContext: 'from-carrier', dids: [unconfigured], numbers: [number] },
        };
      if (path.endsWith('/profiles')) result = { body: { profiles: [] } };
      if (path.endsWith('/profile-assignments'))
        result = {
          body: { pbxInstanceId: native.pbxInstanceId, contexts: ['office'], assignments: [] },
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
function renderScreen(kind: 'extensions' | 'queues' | 'numbers', element: React.ReactElement) {
  return render(
    <MemoryRouter initialEntries={[`/tenants/1/${kind}`]}>
      <Link to={`/tenants/2/${kind}`}>Switch test tenant</Link>
      <Routes>
        <Route path={`/tenants/:tenantId/${kind}`} element={element} />
      </Routes>
    </MemoryRouter>,
  );
}
const mutations = (fetcher: ReturnType<typeof mockFetch>) =>
  fetcher.mock.calls
    .filter(([, init]) => init?.method !== 'GET')
    .map(([url, init]) => ({
      url: String(url),
      method: init!.method,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    }));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
async function startExtension(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'Create extension' }));
  await user.type(screen.getByLabelText('Extension number'), '104');
  await user.type(screen.getByLabelText('Display name'), 'New Desk');
}

describe('native extensions', () => {
  it('discloses credentials once, supports copying, carries CSRF, and only reports committed', async () => {
    const fetcher = mockFetch((_url, init) =>
      init.method === 'POST'
        ? {
            status: 201,
            body: {
              extension: '104',
              sipUsername: '104-office',
              sipSecret: 'one-time-value',
              applyState: 'committed',
            },
          }
        : undefined,
    );
    const user = userEvent.setup();
    document.cookie = 'aida.csrf=test-proof';
    const store = vi.spyOn(Storage.prototype, 'setItem');
    renderScreen('extensions', <ExtensionsScreen />);
    await startExtension(user);
    expect(screen.queryByLabelText('Context')).not.toBeInTheDocument();
    expect(screen.getByText(/PBX instance/)).toHaveTextContent('officepulse-test');
    expect(screen.getByText(/PBX instance/)).toHaveTextContent('office');
    await user.click(screen.getByRole('button', { name: 'Create extension and show credentials' }));
    const panel = await screen.findByRole('alertdialog');
    expect(panel).toHaveFocus();
    expect(panel).toHaveTextContent('one-time-value');
    expect(panel).toHaveTextContent(/future secret rotation/);
    expect(screen.getByRole('button', { name: 'Create extension' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Copy SIP secret' }));
    expect(await screen.findByText('SIP secret copied.')).toBeInTheDocument();
    expect(await navigator.clipboard.readText()).toBe('one-time-value');
    await user.click(screen.getByRole('button', { name: 'I have copied the values' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(screen.queryByText('one-time-value')).not.toBeInTheDocument();
    expect(store).not.toHaveBeenCalled();
    expect(mutations(fetcher)).toEqual([
      {
        url: '/admin/tenants/1/extensions',
        method: 'POST',
        body: { extension: '104', displayName: 'New Desk' },
      },
    ]);
    expect(
      fetcher.mock.calls.find(([, init]) => init?.method === 'POST')![1]!.headers,
    ).toMatchObject({ 'x-csrf-token': 'test-proof' });
    expect(screen.getByText(/Committed to OfficePulse/)).toHaveTextContent(
      /not been verified active/,
    );
    expect(
      screen.queryByRole('button', { name: /rotate|enroll|edit extension/i }),
    ).not.toBeInTheDocument();
  });
  it('keeps the form on unavailable failure with support reference and offers authorized contexts only', async () => {
    const fetcher = mockFetch((url, init) => {
      const context = new URL(url, 'http://test').searchParams.get('context') ?? 'office';
      return init.method === 'POST'
        ? {
            status: 503,
            body: {
              message: 'OfficePulse is temporarily unavailable.',
              correlationId: 'support-123',
            },
          }
        : url.includes('/extensions')
          ? {
              body: {
                ...native,
                context,
                contexts: ['office', 'afterhours'],
                extensions: context === 'afterhours' ? [{ ...extension, context }] : [],
              },
            }
          : undefined;
    });
    const user = userEvent.setup();
    renderScreen('extensions', <ExtensionsScreen />);
    // Multi-context tenants pick a context; the list is the server's, not typed.
    const selector = await screen.findByLabelText('Context');
    expect(selector).toHaveValue('office');
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'office',
      'afterhours',
    ]);
    await user.selectOptions(selector, 'afterhours');
    expect(await screen.findByText('Front Desk')).toBeInTheDocument();
    await startExtension(user);
    expect(screen.getByText(/Created in context/)).toHaveTextContent('afterhours');
    await user.click(screen.getByRole('button', { name: 'Create extension and show credentials' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('OfficePulse unavailable');
    expect(screen.getByRole('alert')).toHaveTextContent('support-123');
    expect(screen.getByLabelText('Extension number')).toHaveValue('104');
    expect(mutations(fetcher)).toEqual([
      {
        url: '/admin/tenants/1/extensions?context=afterhours',
        method: 'POST',
        body: { extension: '104', displayName: 'New Desk' },
      },
    ]);
    expect(
      fetcher.mock.calls
        .filter(([url, init]) => init?.method === 'GET' && String(url).includes('/extensions'))
        .map(([url]) => String(url)),
    ).toEqual(['/admin/tenants/1/extensions', '/admin/tenants/1/extensions?context=afterhours']);
  });
  it('disables mutations when provisioning is disabled and distinguishes unavailability from empty inventory', async () => {
    mockFetch(() => ({
      body: { ...native, provisioningEnabled: false, extensions: [] },
    }));
    renderScreen('extensions', <ExtensionsScreen />);
    expect(await screen.findByText(/Inventory is read-only/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create extension' })).toBeDisabled();
  });
  it('confirms deletion, removes memberships warning, and keeps imported endpoints read-only', async () => {
    const confirm = vi
      .spyOn(window, 'confirm')
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    const fetcher = mockFetch((_url, init) =>
      init.method === 'DELETE'
        ? { status: 204 }
        : {
            // OfficePulse decides `managed` from its Dial route, not the id shape.
            body: {
              ...native,
              extensions: [extension, { ...second, id: '101-t1', managed: false }],
            },
          },
    );
    const user = userEvent.setup();
    renderScreen('extensions', <ExtensionsScreen />);
    await user.click(await screen.findByRole('button', { name: 'Delete extension 100' }));
    expect(mutations(fetcher)).toHaveLength(0);
    expect(screen.queryByRole('button', { name: 'Delete extension 101' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Delete extension 100' }));
    await waitFor(() => expect(mutations(fetcher)).toHaveLength(1));
    expect(confirm).toHaveBeenCalledWith(
      expect.stringContaining('Saved queue memberships will also be removed'),
    );
  });
});

describe('native queues', () => {
  it('creates a friendly queue with ringall default and refreshes inventory', async () => {
    const fetcher = mockFetch((_url, init) =>
      init.method === 'POST'
        ? { status: 201, body: { ...queue, applyState: 'committed' } }
        : undefined,
    );
    const user = userEvent.setup();
    renderScreen('queues', <QueuesScreen />);
    await user.click(await screen.findByRole('button', { name: 'Create queue' }));
    await user.type(screen.getByLabelText('Queue name / slug'), 'reception');
    expect(screen.getByLabelText('Strategy')).toHaveValue('ringall');
    await user.click(screen.getByRole('button', { name: 'Save queue' }));
    expect(await screen.findByText(/Committed to OfficePulse/)).toBeInTheDocument();
    expect(mutations(fetcher)).toEqual([
      {
        url: '/admin/tenants/1/queues',
        method: 'POST',
        body: { name: 'reception', strategy: 'ringall' },
      },
    ]);
  });
  it('sends minimal member PUT/DELETE changes with penalty and paused; unchanged members are untouched', async () => {
    const populated = {
      ...queue,
      members: [
        { interface: 'PJSIP/100-office', memberName: 'Front Desk', penalty: 0, paused: false },
        { interface: 'PJSIP/101-office', memberName: 'Sales', penalty: 0, paused: false },
      ],
    };
    const fetcher = mockFetch((url, init) =>
      init.method === 'PUT'
        ? { body: { applyState: 'committed' } }
        : init.method === 'DELETE'
          ? { status: 204 }
          : url.endsWith('/queues')
            ? { body: { ...native, queues: [populated] } }
            : undefined,
    );
    const user = userEvent.setup();
    renderScreen('queues', <QueuesScreen />);
    await user.click(await screen.findByRole('button', { name: 'Edit members of reception' }));
    await user.click(screen.getByLabelText('Include extension 101'));
    await user.click(screen.getByLabelText('Include extension 102'));
    await user.click(screen.getByText('Advanced member settings for 102'));
    await user.clear(screen.getByLabelText('Penalty for 102'));
    await user.type(screen.getByLabelText('Penalty for 102'), '5');
    await user.click(screen.getByLabelText('Paused for 102'));
    await user.click(screen.getByRole('button', { name: 'Save members' }));
    await waitFor(() => expect(mutations(fetcher)).toHaveLength(2));
    expect(mutations(fetcher)).toEqual([
      {
        url: '/admin/tenants/1/queues/t1.reception/members/101',
        method: 'DELETE',
        body: undefined,
      },
      {
        url: '/admin/tenants/1/queues/t1.reception/members/102',
        method: 'PUT',
        body: { penalty: 5, paused: true, context: 'office' },
      },
    ]);
  });
  it('preserves a partial membership baseline so retry sends only the remaining change', async () => {
    let fail = true;
    const fetcher = mockFetch((url, init) =>
      init.method === 'PUT'
        ? url.endsWith('/101') && fail
          ? { status: 503, body: { message: 'Temporarily unavailable' } }
          : { body: { applyState: 'committed' } }
        : undefined,
    );
    const user = userEvent.setup();
    renderScreen('queues', <QueuesScreen />);
    await user.click(await screen.findByRole('button', { name: 'Edit members of reception' }));
    await user.click(screen.getByLabelText('Include extension 100'));
    await user.click(screen.getByLabelText('Include extension 101'));
    await user.click(screen.getByRole('button', { name: 'Save members' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Temporarily unavailable');
    expect(screen.getByLabelText('Include extension 100')).toBeChecked();
    fail = false;
    await user.click(screen.getByRole('button', { name: 'Save members' }));
    await waitFor(() => expect(mutations(fetcher)).toHaveLength(3));
    expect(mutations(fetcher).filter((call) => call.url.endsWith('/100'))).toHaveLength(1);
  });
  it('scopes queue reads and writes to the selected context', async () => {
    const fetcher = mockFetch((url, init) => {
      const context = new URL(url, 'http://test').searchParams.get('context') ?? 'office';
      if (init.method === 'POST')
        return { status: 201, body: { ...queue, applyState: 'committed' } };
      if (init.method === 'DELETE') return { status: 204 };
      if (url.includes('/queues'))
        return {
          body: {
            ...native,
            context,
            contexts: ['office', 'afterhours'],
            queues: context === 'afterhours' ? [{ ...queue, name: 'afterhours.night' }] : [queue],
          },
        };
      if (url.includes('/extensions'))
        return { body: { ...native, context, contexts: ['office', 'afterhours'], extensions: [] } };
      return undefined;
    });
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderScreen('queues', <QueuesScreen />);
    await user.selectOptions(await screen.findByLabelText('Context'), 'afterhours');
    await user.click(await screen.findByRole('button', { name: 'Delete queue afterhours.night' }));
    await waitFor(() => expect(mutations(fetcher)).toHaveLength(1));
    expect(mutations(fetcher)[0]!.url).toBe(
      '/admin/tenants/1/queues/t1.reception?context=afterhours',
    );
    await user.click(screen.getByRole('button', { name: 'Create queue' }));
    await user.type(screen.getByLabelText('Queue name / slug'), 'night');
    await user.click(screen.getByRole('button', { name: 'Save queue' }));
    await waitFor(() => expect(mutations(fetcher)).toHaveLength(2));
    expect(mutations(fetcher)[1]!.url).toBe('/admin/tenants/1/queues?context=afterhours');
  });
  it('links DID routes on delete conflict and requires confirmation', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    mockFetch((_url, init) =>
      init.method === 'DELETE'
        ? {
            status: 409,
            body: { message: 'A managed DID references this queue.', correlationId: 'q-conflict' },
          }
        : undefined,
    );
    const user = userEvent.setup();
    renderScreen('queues', <QueuesScreen />);
    await user.click(await screen.findByRole('button', { name: 'Delete queue reception' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Conflict');
    expect(screen.getByRole('alert')).toHaveTextContent('q-conflict');
    expect(screen.getByRole('link', { name: 'Numbers' })).toHaveAttribute(
      'href',
      '/tenants/1/numbers',
    );
  });
});

describe('managed DID routes', () => {
  it('saves an enabled schedule normalized to Asterisk weekdays and reads returned timeout', async () => {
    let saved = false;
    const fetcher = mockFetch((url, init) =>
      init.method === 'PUT'
        ? ((saved = true), { body: { ...managed, ringTimeoutSeconds: 35, ringsBeforeAi: 7 } })
        : url.endsWith('/did-routes')
          ? {
              body: {
                ...native,
                numbers: [number],
                dids: [
                  saved ? { ...managed, ringTimeoutSeconds: 35, ringsBeforeAi: 7 } : unconfigured,
                ],
              },
            }
          : undefined,
    );
    const user = userEvent.setup();
    renderScreen('numbers', <TenantNumbersScreen />);
    await screen.findByLabelText('Queue');
    await user.selectOptions(screen.getByLabelText('Queue'), queue.id);
    await user.clear(screen.getByLabelText('Rings before LiveKit'));
    await user.type(screen.getByLabelText('Rings before LiveKit'), '7');
    await user.click(screen.getByLabelText('Enable business-hours schedule'));
    await user.type(screen.getByLabelText('IANA timezone'), 'America/Los_Angeles');
    expect(
      screen.getByText(/Outside scheduled hours: route directly to LiveKit/),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText(/provider/i)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save DID route' }));
    expect(
      await screen.findByText(/OfficePulse returned a queue timeout of 35 seconds/),
    ).toBeInTheDocument();
    expect(mutations(fetcher)).toEqual([
      {
        url: '/admin/tenants/1/did-routes/%2B15105550100',
        method: 'PUT',
        body: {
          queue: queue.id,
          ringsBeforeAi: 7,
          schedule: {
            timeRange: '09:00-17:00',
            weekdays: 'mon&tue&wed&thu&fri',
            timezone: 'America/Los_Angeles',
          },
        },
      },
    ]);
    expect(
      await screen.findByText(/OfficePulse’s saved queue timeout is 35 seconds/),
    ).toBeInTheDocument();
  });
  it('prefills managed settings, disables scheduling by omitting it, and preserves LiveKit-only copy', async () => {
    const fetcher = mockFetch((url, init) =>
      init.method === 'PUT'
        ? { body: { ...managed } }
        : url.endsWith('/did-routes')
          ? { body: { ...native, numbers: [number], dids: [managed] } }
          : undefined,
    );
    const user = userEvent.setup();
    renderScreen('numbers', <TenantNumbersScreen />);
    await screen.findByLabelText('Queue');
    expect(screen.getByLabelText('IANA timezone')).toHaveValue('America/Los_Angeles');
    expect(screen.getByLabelText('Monday')).toBeChecked();
    expect(screen.getByLabelText('Sunday')).not.toBeChecked();
    await user.click(screen.getByLabelText('Enable business-hours schedule'));
    expect(screen.queryByLabelText('IANA timezone')).not.toBeInTheDocument();
    expect(
      screen.getByText(/With no schedule: the queue is always open, then LiveKit/),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save DID route' }));
    await waitFor(() => expect(mutations(fetcher)).toHaveLength(1));
    expect(mutations(fetcher)[0]!.body).toEqual({ queue: queue.id, ringsBeforeAi: 6 });
  });
  it('validates weekday and timezone without sending a mutation', async () => {
    const fetcher = mockFetch();
    const user = userEvent.setup();
    renderScreen('numbers', <TenantNumbersScreen />);
    await screen.findByLabelText('Queue');
    await user.selectOptions(screen.getByLabelText('Queue'), queue.id);
    await user.click(screen.getByLabelText('Enable business-hours schedule'));
    await user.type(screen.getByLabelText('IANA timezone'), 'Unknown/Zone');
    for (const day of ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'])
      await user.click(screen.getByLabelText(day));
    await user.click(screen.getByRole('button', { name: 'Save DID route' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Select at least one weekday');
    await user.click(screen.getByLabelText('Monday'));
    await user.click(screen.getByRole('button', { name: 'Save DID route' }));
    expect(screen.getByRole('alert')).toHaveTextContent('valid IANA timezone');
    expect(mutations(fetcher)).toHaveLength(0);
  });
  it('refuses manual adoption and deletes only PBX routing after an explicit confirmation', async () => {
    const manual = { ...unconfigured, did: '+15105550101', availability: 'manual' };
    const assigned = [number, { ...number, iPhoneNumberId: 2, phoneNumber: manual.did }];
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const fetcher = mockFetch((url, init) =>
      init.method === 'DELETE'
        ? { status: 204 }
        : url.endsWith('/numbers')
          ? { body: { numbers: assigned } }
          : url.endsWith('/did-routes')
            ? {
                body: {
                  ...native,
                  numbers: assigned,
                  dids: [managed, manual],
                },
              }
            : undefined,
    );
    const user = userEvent.setup();
    renderScreen('numbers', <TenantNumbersScreen />);
    const card = await screen.findByRole('article', { name: manual.did });
    expect(card).toHaveTextContent('Manual / operator managed');
    expect(within(card).queryByRole('button', { name: 'Save DID route' })).not.toBeInTheDocument();
    expect(card).toHaveTextContent('Routing is read-only');
    await user.click(
      screen.getByRole('button', { name: `Disable PBX routing for ${number.phoneNumber}` }),
    );
    await waitFor(() => expect(mutations(fetcher)).toHaveLength(1));
    expect(confirm).toHaveBeenCalledWith(
      expect.stringContaining('preserves the Identity phone number'),
    );
    expect(mutations(fetcher)[0]!.url).toBe('/admin/tenants/1/did-routes/%2B15105550100');
  });
});

describe('unified Numbers routing', () => {
  it('opens the single-number editor without submitting defaults', async () => {
    const fetcher = mockFetch();
    renderScreen('numbers', <TenantNumbersScreen />);
    const form = await screen.findByRole('form', { name: `PBX routing for ${number.phoneNumber}` });
    expect(form.closest('details')).toHaveAttribute('open');
    expect(screen.getAllByRole('article')).toHaveLength(1);
    expect(screen.getAllByRole('heading', { name: number.phoneNumber })).toHaveLength(1);
    expect(screen.queryByLabelText('DID (E.164)')).not.toBeInTheDocument();
    expect(mutations(fetcher)).toEqual([]);
  });

  it('preserves an assigned number with missing PBX scope and prefills settings when scope later appears', async () => {
    let scoped = false;
    const fetcher = mockFetch((url) =>
      url.endsWith('/did-routes')
        ? { body: { ...native, numbers: scoped ? [number] : [], dids: scoped ? [managed] : [] } }
        : undefined,
    );
    const user = userEvent.setup();
    renderScreen('numbers', <TenantNumbersScreen />);
    const card = await screen.findByRole('article', { name: number.phoneNumber });
    await waitFor(() => expect(card).toHaveTextContent('PBX scope missing'));
    expect(screen.getAllByRole('article')).toHaveLength(1);
    expect(within(card).queryByRole('button', { name: 'Save DID route' })).not.toBeInTheDocument();
    expect(within(card).getByRole('button', { name: `Edit ${number.phoneNumber}` })).toBeEnabled();
    scoped = true;
    await user.click(screen.getByRole('button', { name: 'Refresh numbers and routing' }));
    expect(await screen.findByLabelText('IANA timezone')).toHaveValue('America/Los_Angeles');
    expect(screen.getByLabelText('Queue')).toHaveValue(queue.id);
    expect(mutations(fetcher)).toEqual([]);
  });

  it('keeps multiple numbers in separate cards with independent editors and no DID selector', async () => {
    const other = { ...number, iPhoneNumberId: 2, phoneNumber: '+15105550102' };
    const fetcher = mockFetch((url, init) =>
      init.method === 'PUT'
        ? { body: { ...managed, did: other.phoneNumber } }
        : url.endsWith('/numbers')
          ? { body: { numbers: [number, other] } }
          : url.endsWith('/did-routes')
            ? {
                body: {
                  ...native,
                  numbers: [number, other],
                  dids: [unconfigured, unconfigured, { ...unconfigured, did: other.phoneNumber }],
                },
              }
            : undefined,
    );
    const user = userEvent.setup();
    renderScreen('numbers', <TenantNumbersScreen />);
    const first = await screen.findByRole('article', { name: number.phoneNumber });
    const second = screen.getByRole('article', { name: other.phoneNumber });
    await waitFor(() =>
      expect(
        within(first).getByText('Configure PBX routing').closest('details'),
      ).not.toHaveAttribute('open'),
    );
    expect(screen.getAllByRole('article')).toHaveLength(2);
    await user.click(within(first).getByText('Configure PBX routing'));
    await user.selectOptions(within(first).getByLabelText('Queue'), queue.id);
    await user.clear(within(first).getByLabelText('Rings before LiveKit'));
    await user.type(within(first).getByLabelText('Rings before LiveKit'), '4');
    await user.click(within(second).getByText('Configure PBX routing'));
    expect(within(second).getByLabelText('Rings before LiveKit')).toHaveValue(6);
    await user.selectOptions(within(second).getByLabelText('Queue'), queue.id);
    await user.click(within(second).getByRole('button', { name: 'Save DID route' }));
    await waitFor(() => expect(mutations(fetcher)).toHaveLength(1));
    expect(mutations(fetcher)[0]).toMatchObject({
      url: '/admin/tenants/1/did-routes/%2B15105550102',
      body: { queue: queue.id, ringsBeforeAi: 6 },
    });
    await waitFor(() =>
      expect(within(second).getByRole('button', { name: 'Save DID route' })).toBeEnabled(),
    );
    expect(within(first).getByLabelText('Rings before LiveKit')).toHaveValue(4);
    expect(screen.queryByLabelText('DID (E.164)')).not.toBeInTheDocument();
  });

  it.each(['did-routes', 'queues'] as const)(
    'keeps Numbers available when %s fails',
    async (endpoint) => {
      const fetcher = mockFetch((url) =>
        url.endsWith(`/${endpoint}`)
          ? { status: 503, body: { message: 'OfficePulse unavailable' } }
          : undefined,
      );
      renderScreen('numbers', <TenantNumbersScreen />);
      const card = await screen.findByRole('article', { name: number.phoneNumber });
      await waitFor(() => expect(card).toHaveTextContent('PBX routing: Unavailable'));
      expect(
        within(card).getByRole('button', { name: `Edit ${number.phoneNumber}` }),
      ).toBeEnabled();
      expect(screen.queryByRole('button', { name: 'Save DID route' })).not.toBeInTheDocument();
      expect(screen.queryByText(/No numbers assigned yet/)).not.toBeInTheDocument();
      expect(mutations(fetcher)).toEqual([]);
    },
  );

  it('disables stale routing after a failed refresh while retaining the draft for recovery', async () => {
    let unavailable = false;
    const fetcher = mockFetch((url) =>
      unavailable && url.endsWith('/did-routes')
        ? { status: 503, body: { message: 'OfficePulse unavailable' } }
        : undefined,
    );
    const user = userEvent.setup();
    renderScreen('numbers', <TenantNumbersScreen />);
    await user.selectOptions(await screen.findByLabelText('Queue'), queue.id);
    await user.clear(screen.getByLabelText('Rings before LiveKit'));
    await user.type(screen.getByLabelText('Rings before LiveKit'), '8');
    unavailable = true;
    await user.click(screen.getByRole('button', { name: 'Refresh numbers and routing' }));
    await screen.findByRole('alert');
    expect(screen.getByRole('article')).toHaveTextContent('PBX routing: Unavailable');
    expect(screen.getByLabelText('Queue')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save DID route' })).toBeDisabled();
    unavailable = false;
    await user.click(screen.getByRole('button', { name: 'Refresh numbers and routing' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Save DID route' })).toBeEnabled(),
    );
    expect(screen.getByLabelText('Rings before LiveKit')).toHaveValue(8);
    expect(mutations(fetcher)).toEqual([]);
  });

  it('keeps disabled Identity numbers and their managed settings visible, with routing read-only', async () => {
    mockFetch((url) =>
      url.endsWith('/numbers')
        ? { body: { numbers: [{ ...number, bEnabled: false }] } }
        : url.endsWith('/did-routes')
          ? { body: { ...native, numbers: [], dids: [managed] } }
          : undefined,
    );
    renderScreen('numbers', <TenantNumbersScreen />);
    expect(await screen.findByLabelText('IANA timezone')).toHaveValue('America/Los_Angeles');
    expect(screen.getByRole('article')).toHaveTextContent('Configured');
    expect(screen.getByRole('button', { name: 'Save DID route' })).toBeDisabled();
    expect(
      screen.getByRole('button', { name: `Disable PBX routing for ${number.phoneNumber}` }),
    ).toBeDisabled();
  });

  it('confirms Identity disabling separately and never changes PBX routing', async () => {
    let enabled = true;
    const confirm = vi
      .spyOn(window, 'confirm')
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    const fetcher = mockFetch((url, init) =>
      init.method === 'PUT' && url.includes('/numbers/')
        ? ((enabled = false), { body: { number: { ...number, bEnabled: false } } })
        : url.endsWith('/numbers')
          ? { body: { numbers: [{ ...number, bEnabled: enabled, iVersion: 3 }] } }
          : url.endsWith('/did-routes')
            ? { body: { ...native, numbers: [number], dids: [managed] } }
            : undefined,
    );
    const user = userEvent.setup();
    renderScreen('numbers', <TenantNumbersScreen />);
    await user.click(await screen.findByRole('button', { name: `Edit ${number.phoneNumber}` }));
    await user.click(screen.getByLabelText('Enabled'));
    await user.click(screen.getByRole('button', { name: 'Save number' }));
    expect(mutations(fetcher)).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Save number' }));
    await waitFor(() => expect(mutations(fetcher)).toHaveLength(1));
    expect(confirm).toHaveBeenCalledWith(
      expect.stringContaining('PBX routing and carrier service are unchanged'),
    );
    expect(mutations(fetcher)[0]).toMatchObject({
      url: '/admin/tenants/1/numbers/1',
      method: 'PUT',
      body: { bEnabled: false, expectedVersion: 3 },
    });
    await waitFor(() => expect(screen.getByRole('article')).toHaveTextContent('Disabled'));
    expect(screen.getByRole('article')).toHaveTextContent('Configured');
    expect(
      screen.getByRole('button', { name: `Disable PBX routing for ${number.phoneNumber}` }),
    ).toBeDisabled();
  });
});

describe('tenant request isolation', () => {
  it.each(['extensions', 'queues', 'numbers'] as const)(
    'ignores a stale %s inventory after switching tenants',
    async (kind) => {
      let resolve!: (result: Result) => void;
      mockFetch((url) =>
        url === `/admin/tenants/1/${kind}`
          ? new Promise<Result>((done) => {
              resolve = done;
            })
          : url.startsWith('/admin/tenants/2/')
            ? {
                body: {
                  ...native,
                  context: 'second',
                  contexts: ['second'],
                  extensions: [],
                  queues: [],
                  dids: [],
                  numbers: [],
                  profiles: [],
                  assignments: [],
                },
              }
            : undefined,
      );
      const user = userEvent.setup();
      renderScreen(
        kind,
        kind === 'extensions' ? (
          <ExtensionsScreen />
        ) : kind === 'queues' ? (
          <QueuesScreen />
        ) : (
          <TenantNumbersScreen />
        ),
      );
      await user.click(screen.getByRole('link', { name: 'Switch test tenant' }));
      await waitFor(() => expect(screen.queryByText(`Loading ${kind}…`)).not.toBeInTheDocument());
      await act(async () =>
        resolve({
          body: {
            ...native,
            extensions: [extension],
            contexts: ['office'],
            queues: [queue],
            dids: [managed],
            numbers: [number],
          },
        }),
      );
      expect(screen.queryByText('Front Desk')).not.toBeInTheDocument();
      expect(screen.queryByText('reception')).not.toBeInTheDocument();
      expect(screen.queryByText(number.phoneNumber)).not.toBeInTheDocument();
    },
  );
  it('discards a stale extension creation secret after tenant change', async () => {
    let resolve!: (result: Result) => void;
    mockFetch((_url, init) =>
      init.method === 'POST'
        ? new Promise<Result>((done) => {
            resolve = done;
          })
        : undefined,
    );
    const user = userEvent.setup();
    renderScreen('extensions', <ExtensionsScreen />);
    await startExtension(user);
    await user.click(screen.getByRole('button', { name: 'Create extension and show credentials' }));
    expect(screen.getByRole('button', { name: 'Creating…' })).toBeDisabled();
    await user.click(screen.getByRole('link', { name: 'Switch test tenant' }));
    await act(async () =>
      resolve({
        status: 201,
        body: {
          extension: '104',
          sipUsername: '104-office',
          sipSecret: 'stale-secret',
          applyState: 'committed',
        },
      }),
    );
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(screen.queryByText('stale-secret')).not.toBeInTheDocument();
  });
});

describe('attached handsets', () => {
  const handset = {
    id: 'ed35265b-2199-46dd-9e46-99e3f9600111',
    pbxInstanceId: native.pbxInstanceId,
    context: 'office',
    endpointId: extension.id,
    extension: extension.extension,
    label: 'Front Desk',
    deviceModel: 'GXV3450',
    mac: 'ec74d7c92718',
    localIp: '192.168.6.97',
    publicIp: '203.0.113.1',
    attachedAt: '2026-09-20T10:00:00Z',
    lastSeenAt: '2026-09-20T10:01:00Z',
    appVersion: '1',
    revokedAt: null,
  };
  it('shows addresses and model on the matching endpoint, confirms revoke, then shows a reattached device', async () => {
    let handsets = [handset];
    const fetcher = mockFetch((url, init) => {
      if (url.includes('/handsets') && init.method === 'GET') return { body: { handsets } };
      if (url.includes('/handsets/') && init.method === 'DELETE') {
        handsets = [];
        return { status: 204 };
      }
      return undefined;
    });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    document.cookie = 'aida.csrf=handset-proof';
    const user = userEvent.setup();
    renderScreen('extensions', <ExtensionsScreen />);
    const row = await screen.findByRole('row', { name: /100 Front Desk/ });
    expect(within(row).getByText('GXV3450')).toBeInTheDocument();
    expect(row).toHaveTextContent('ec74d7c92718');
    expect(row).toHaveTextContent('192.168.6.97');
    expect(row).toHaveTextContent('203.0.113.1');
    expect(row).toHaveTextContent('2026-09-20T10:01:00Z');
    expect(
      within(screen.getByRole('row', { name: /101 Sales/ })).queryByRole('button', {
        name: /Revoke/,
      }),
    ).not.toBeInTheDocument();
    await user.click(within(row).getByRole('button', { name: /Revoke handset/ }));
    expect(mutations(fetcher)).toEqual([]);
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('not a lock'));
    confirm.mockReturnValue(true);
    await user.click(within(row).getByRole('button', { name: /Revoke handset/ }));
    await screen.findByText(/Handset revoked\./);
    expect(mutations(fetcher)).toEqual([
      {
        url: `/admin/tenants/1/handsets/${handset.id}?context=office`,
        method: 'DELETE',
        body: undefined,
      },
    ]);
    expect(
      fetcher.mock.calls.find(([, init]) => init?.method === 'DELETE')![1]!.headers,
    ).toMatchObject({ 'x-csrf-token': 'handset-proof' });
    expect(screen.queryByText('GXV3450')).not.toBeInTheDocument();
    handsets = [{ ...handset, id: 'new-session' }];
    await user.click(screen.getByRole('button', { name: 'Refresh inventory' }));
    expect(await screen.findByText('GXV3450')).toBeInTheDocument();
  });
  it('does not show revoked sessions, other contexts, or other PBX instances', async () => {
    mockFetch((url) =>
      url.includes('/handsets')
        ? {
            body: {
              handsets: [
                { ...handset, revokedAt: '2026-09-20T10:02:00Z' },
                { ...handset, id: 'other-context', context: 'branch' },
                { ...handset, id: 'other-pbx', pbxInstanceId: 'other-pbx' },
              ],
            },
          }
        : undefined,
    );
    renderScreen('extensions', <ExtensionsScreen />);
    await screen.findByRole('row', { name: /100 Front Desk/ });
    expect(screen.queryByText('GXV3450')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Revoke/ })).not.toBeInTheDocument();
  });
  it('keeps extension inventory usable when the handset API fails', async () => {
    mockFetch((url) =>
      url.includes('/handsets')
        ? {
            status: 502,
            body: {
              error: 'officepulse_unavailable',
              message: 'OfficePulse could not complete the handset request',
            },
          }
        : undefined,
    );
    renderScreen('extensions', <ExtensionsScreen />);
    expect(await screen.findByRole('alert')).toHaveTextContent('OfficePulse could not complete');
    expect(screen.getByRole('button', { name: 'Create extension' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: /Revoke/ })).not.toBeInTheDocument();
  });
});
