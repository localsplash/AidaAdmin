import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OperationsScreen } from '../src/screens/OperationsScreen';
import type { CallDetail, RuntimeCall, RuntimeEvent } from '../src/api/runtime';

function call(id: string, callerNumber: string, overrides: Partial<RuntimeCall> = {}): RuntimeCall {
  return {
    id,
    asteriskLinkedId: `l-${id}`,
    officePulseInstanceId: 'op',
    tenantId: 'ten-1',
    didE164: '+15105550100',
    callerNumber,
    config: {
      didRouteId: 'r',
      didRouteRevision: 1,
      profileId: 'p',
      profileRevision: 1,
      tenantRevision: 1,
    },
    roomName: `aida-${id}`,
    agentParticipantSid: null,
    destinationType: 'EXTENSION',
    destinationId: 'ext-1',
    disposition: 'SCREEN',
    state: 'screening',
    version: 1,
    createdAt: '2026-09-02T10:00:00.000Z',
    endedAt: null,
    ...overrides,
  };
}

const ev = (
  sequenceNumber: number,
  eventType: string,
  payload: Record<string, unknown> | null = null,
): RuntimeEvent => ({
  sequenceNumber,
  eventType,
  payload,
  createdAt: 't',
});

interface Upstream {
  active: CallDetail[];
  commands: Array<{ url: string; body: Record<string, unknown> }>;
  failWith?: { status: number; body: unknown };
}

function mockRuntime(upstream: Upstream) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const respond = (status: number, body: unknown) =>
        new Response(JSON.stringify(body), { status });
      if (upstream.failWith) return respond(upstream.failWith.status, upstream.failWith.body);
      if (url.includes('/runtime/calls?state=active')) {
        return respond(200, { calls: upstream.active.map((d) => d.call) });
      }
      if (url.includes('/runtime/calls?state=recent')) return respond(200, { calls: [] });
      if (url.includes('/runtime/issues')) {
        return respond(200, {
          windowHours: 24,
          failedCommands: [],
          events: [],
          dependenciesDown: [],
        });
      }
      const commandMatch = /\/runtime\/calls\/([^/?]+)\/commands$/.exec(url);
      if (commandMatch && init?.method === 'POST') {
        upstream.commands.push({ url, body: JSON.parse(String(init.body)) });
        return respond(202, { accepted: true, duplicate: false, status: 'ringing' });
      }
      const detailMatch = /\/runtime\/calls\/([^/?]+)\?/.exec(url);
      if (detailMatch) {
        const detail = upstream.active.find((d) => d.call.id === detailMatch[1]);
        return detail ? respond(200, detail) : respond(404, { error: 'call_not_found' });
      }
      return respond(404, {});
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const detail = (
  c: RuntimeCall,
  events: RuntimeEvent[],
  commands: CallDetail['commands'] = [],
): CallDetail => ({
  call: c,
  events,
  commands,
  participants: [],
});

describe('OperationsScreen', () => {
  it('keeps simultaneous calls isolated in their own tabs', async () => {
    mockRuntime({
      active: [
        detail(call('call-a', '+15105550001'), [ev(1, 'bootstrapped'), ev(2, 'ringing')]),
        detail(call('call-b', '+15105550002'), [
          ev(1, 'fallback', { reason: 'nocodb-unavailable' }),
        ]),
      ],
      commands: [],
    });
    render(
      <MemoryRouter>
        <OperationsScreen />
      </MemoryRouter>,
    );
    const panelA = await screen.findByRole('tabpanel', { name: '+15105550001' });
    expect(within(panelA).getByText(/takeover — ringing/i)).toBeInTheDocument();
    expect(within(panelA).queryByText(/nocodb-unavailable/)).not.toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole('tab', { name: '+15105550002' }));
    const panelB = screen.getByRole('tabpanel', { name: '+15105550002' });
    expect(within(panelB).getByRole('alert')).toHaveTextContent(/nocodb-unavailable/);
    expect(within(panelB).queryByText(/takeover — ringing/i)).not.toBeInTheDocument();
  });

  it('renders nothing but the refusal when the runtime is forbidden', async () => {
    mockRuntime({
      active: [],
      commands: [],
      failWith: {
        status: 403,
        body: { error: 'tenant_not_selected', message: 'Select a tenant first' },
      },
    });
    render(
      <MemoryRouter>
        <OperationsScreen />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(/select a tenant/i);
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
  });

  it('names the missing variable when the runtime database is not configured', async () => {
    mockRuntime({
      active: [],
      commands: [],
      failWith: {
        status: 503,
        body: {
          error: 'runtime_db_not_configured',
          message: 'The OfficePulse runtime database is not configured',
          missingConfiguration: ['OFFICEPULSE_RUNTIME_DATABASE_URL'],
        },
      },
    });
    render(
      <MemoryRouter>
        <OperationsScreen />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(/OFFICEPULSE_RUNTIME_DATABASE_URL/);
  });

  it('submits a takeover once, with an idempotency key and no destination', async () => {
    const upstream: Upstream = {
      active: [detail(call('call-a', '+15105550001'), [ev(1, 'bootstrapped')])],
      commands: [],
    };
    mockRuntime(upstream);
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(
      <MemoryRouter>
        <OperationsScreen />
      </MemoryRouter>,
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /take over this call/i }));
    await waitFor(() => expect(upstream.commands).toHaveLength(1));
    expect(confirmSpy).toHaveBeenCalled();
    const body = upstream.commands[0]!.body;
    expect(body.commandType).toBe('TAKEOVER');
    expect(typeof body.idempotencyKey).toBe('string');
    expect(body).not.toHaveProperty('destinationId');
    expect(body).not.toHaveProperty('expectedCallVersion');

    // Disabled after submission — a second click cannot happen.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /takeover in progress/i })).toBeDisabled(),
    );
    expect(upstream.commands).toHaveLength(1);
  });

  it('does not submit when the confirmation is declined', async () => {
    const upstream: Upstream = {
      active: [detail(call('call-a', '+15105550001'), [ev(1, 'bootstrapped')])],
      commands: [],
    };
    mockRuntime(upstream);
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(
      <MemoryRouter>
        <OperationsScreen />
      </MemoryRouter>,
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /take over this call/i }));
    expect(upstream.commands).toHaveLength(0);
  });

  it('shows takeover progress from the durable command record, failures, and gaps', async () => {
    mockRuntime({
      active: [
        detail(
          call('call-a', '+15105550001'),
          [
            ev(1, 'bootstrapped'),
            // Sequence 2 is missing: the gap must be surfaced.
            ev(3, 'takeover-failed', { reason: 'destination did not answer' }),
          ],
          [
            {
              idempotencyKey: 'k1',
              commandType: 'TAKEOVER',
              payload: null,
              status: 'failed',
              result: { error: 'no-answer' },
              createdAt: 't',
              completedAt: 't',
            },
          ],
        ),
      ],
      commands: [],
    });
    render(
      <MemoryRouter>
        <OperationsScreen />
      </MemoryRouter>,
    );
    expect(
      await screen.findByText(/last attempt failed \(destination did not answer\)/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/timeline has a gap/i)).toBeInTheDocument();
    expect(screen.getByText(/takeover failed — no-answer/i)).toBeInTheDocument();
  });

  it('marks historical conversations as coming soon and says where transcripts live', async () => {
    mockRuntime({ active: [], commands: [] });
    render(
      <MemoryRouter>
        <OperationsScreen />
      </MemoryRouter>,
    );
    expect(
      await screen.findByRole('heading', { name: /historical conversations/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/coming soon/i)).toBeInTheDocument();
  });
});
