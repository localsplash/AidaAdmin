import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionView } from '../src/api/session';
import { CallDetailScreen } from '../src/screens/CallDetailScreen';
import { RuntimeScreen } from '../src/screens/RuntimeScreen';

type Handler = (url: string, init?: RequestInit) => { status: number; body: unknown } | null;

function mockFetch(handler: Handler) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const result = handler(String(input), init) ?? { status: 404, body: { error: 'not_found' } };
      return new Response(JSON.stringify(result.body), { status: result.status });
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const superAdmin: SessionView = {
  authenticated: true,
  user: { iUserId: 1, displayName: 'Root', email: null, superAdmin: true },
  selectedTenant: null,
};

const tenantAdmin: SessionView = {
  authenticated: true,
  user: { iUserId: 20, displayName: 'Ada', email: null, superAdmin: false },
  selectedTenant: { tenantId: 'ten-1', name: 'Acme', slug: 'acme', role: 'TENANT_ADMIN' },
};

const emptyCalls = { status: 200, body: { calls: [] } };

describe('RuntimeScreen', () => {
  it('shows a tenant administrator only the tenant-scoped sections', async () => {
    mockFetch((url) => (url.startsWith('/runtime/calls?') ? emptyCalls : null));
    render(
      <MemoryRouter>
        <RuntimeScreen session={tenantAdmin} />
      </MemoryRouter>,
    );
    const tabs = within(await screen.findByRole('tablist', { name: /runtime sections/i }))
      .getAllByRole('tab')
      .map((t) => t.textContent);
    expect(tabs).toEqual(['Calls', 'Provisioning', 'DID fail-safes']);
    expect(screen.queryByRole('tab', { name: /dependencies/i })).not.toBeInTheDocument();
    expect(await screen.findByText(/no calls match/i)).toBeInTheDocument();
  });

  it('pairs recorded dependency status with a live probe and can test on demand', async () => {
    const posts: string[] = [];
    mockFetch((url, init) => {
      if (url.startsWith('/runtime/calls?')) return emptyCalls;
      if (url === '/runtime/dependencies') {
        return {
          status: 200,
          body: {
            recorded: [
              { name: 'livekit', ready: false, detail: 'timeout', changedAt: 't1' },
              { name: 'ari', ready: true, detail: null, changedAt: 't0' },
            ],
            live: {
              reachable: true,
              ready: true,
              fullyOperational: false,
              components: { ari: { ready: true, criticality: 'critical' } },
            },
          },
        };
      }
      if (url === '/runtime/dependencies/test' && init?.method === 'POST') {
        posts.push(url);
        return {
          status: 200,
          body: {
            live: { reachable: false, ready: false, fullyOperational: false, components: {} },
          },
        };
      }
      return null;
    });
    render(
      <MemoryRouter>
        <RuntimeScreen session={superAdmin} />
      </MemoryRouter>,
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: /dependencies/i }));
    const table = await screen.findByRole('table', { name: /dependency status/i });
    const livekit = within(table).getByRole('row', { name: /livekit/i });
    expect(livekit).toHaveTextContent(/DOWN/);
    expect(livekit).toHaveTextContent(/timeout/);
    expect(screen.getByRole('status')).toHaveTextContent(/officepulse live: ready/i);

    await user.click(screen.getByRole('button', { name: /test dependencies now/i }));
    await waitFor(() => expect(posts).toEqual(['/runtime/dependencies/test']));
    expect(await screen.findByText(/officepulse live: unreachable/i)).toBeInTheDocument();
  });

  it('retries provisioning through the explicit action, kind and id only', async () => {
    const posts: Array<Record<string, unknown>> = [];
    mockFetch((url, init) => {
      if (url.startsWith('/runtime/calls?')) return emptyCalls;
      if (url.startsWith('/runtime/provisioning?')) {
        return {
          status: 200,
          body: {
            operations: [
              {
                requestId: 'r1',
                kind: 'DID',
                externalId: 'route-9',
                action: 'provision',
                status: 'provisioned',
                createdAt: 't',
              },
              {
                requestId: 'r2',
                kind: 'HANDSET',
                externalId: 'dev-1',
                action: 'provision',
                status: 'provisioned',
                createdAt: 't',
              },
            ],
          },
        };
      }
      if (url === '/runtime/provisioning/retry' && init?.method === 'POST') {
        posts.push(JSON.parse(String(init.body)));
        return {
          status: 200,
          body: { retried: { kind: 'DID', externalId: 'route-9', tenantId: 'ten-1' } },
        };
      }
      return null;
    });
    render(
      <MemoryRouter>
        <RuntimeScreen session={superAdmin} />
      </MemoryRouter>,
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: /provisioning/i }));
    // Handsets are keyed by device and have no retry; DIDs do.
    expect(await screen.findAllByRole('button', { name: /^retry/i })).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: /retry did/i }));
    await waitFor(() => expect(posts).toEqual([{ kind: 'DID', externalId: 'route-9' }]));
    expect(await screen.findByRole('status')).toHaveTextContent(/re-issued DID provisioning/i);
  });

  it('names the missing variable when the runtime database is not configured', async () => {
    mockFetch(() => ({
      status: 503,
      body: {
        error: 'runtime_db_not_configured',
        message: 'The OfficePulse runtime database is not configured',
        missingConfiguration: ['OFFICEPULSE_RUNTIME_DATABASE_URL'],
      },
    }));
    render(
      <MemoryRouter>
        <RuntimeScreen session={superAdmin} />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(/OFFICEPULSE_RUNTIME_DATABASE_URL/);
  });

  it('shows orphans as detection only', async () => {
    mockFetch((url) => {
      if (url.startsWith('/runtime/calls?')) return emptyCalls;
      if (url === '/runtime/orphans') {
        return {
          status: 200,
          body: {
            orphans: [
              {
                call: { id: 'lost-1', tenantId: 'ten-1', createdAt: 't', state: 'screening' },
                participantsPresent: [
                  {
                    participantSid: 'PA1',
                    identity: 'agent-aida',
                    kind: 'AGENT',
                    joinedAt: 't',
                    leftAt: null,
                  },
                ],
              },
            ],
          },
        };
      }
      return null;
    });
    render(
      <MemoryRouter>
        <RuntimeScreen session={superAdmin} />
      </MemoryRouter>,
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: /orphaned calls/i }));
    expect(await screen.findByText(/still present: agent-aida/i)).toBeInTheDocument();
    expect(screen.getByText(/detection only/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /clean/i })).not.toBeInTheDocument();
  });
});

describe('CallDetailScreen', () => {
  it('shows the pinned configuration, timeline, commands and participants', async () => {
    mockFetch((url) =>
      url.startsWith('/runtime/calls/call-1?')
        ? {
            status: 200,
            body: {
              call: {
                id: 'call-1',
                asteriskLinkedId: 'l1',
                officePulseInstanceId: 'op',
                tenantId: 'ten-1',
                didE164: '+15105550100',
                callerNumber: '+15105551234',
                config: {
                  didRouteId: 'route-1',
                  didRouteRevision: 3,
                  profileId: 'profile-1',
                  profileRevision: 2,
                  tenantRevision: 1,
                },
                roomName: 'aida-call-1',
                agentParticipantSid: 'PA1',
                destinationType: 'EXTENSION',
                destinationId: 'ext-1',
                disposition: 'SCREEN',
                state: 'hangup',
                version: 3,
                createdAt: 't0',
                endedAt: 't9',
              },
              events: [
                {
                  sequenceNumber: 1,
                  eventType: 'bootstrapped',
                  payload: { profileId: 'profile-1', profileRevision: 2 },
                  createdAt: 't1',
                },
                { sequenceNumber: 2, eventType: 'answered', payload: null, createdAt: 't2' },
                { sequenceNumber: 3, eventType: 'hangup', payload: null, createdAt: 't3' },
              ],
              commands: [
                {
                  idempotencyKey: 'k1',
                  commandType: 'TAKEOVER',
                  payload: null,
                  status: 'completed',
                  result: { status: 'answered' },
                  createdAt: 't',
                  completedAt: 't',
                },
              ],
              participants: [
                {
                  participantSid: 'PA1',
                  identity: 'agent-aida',
                  kind: 'AGENT',
                  joinedAt: 't1',
                  leftAt: 't8',
                },
              ],
            },
          }
        : null,
    );
    render(
      <MemoryRouter initialEntries={['/runtime/calls/call-1']}>
        <Routes>
          <Route path="/runtime/calls/:callSessionId" element={<CallDetailScreen />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByRole('heading', { name: /call call-1/i })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(/ended/i);
    expect(screen.getByText(/profile-1 \(rev 2\)/)).toBeInTheDocument();
    expect(screen.getByText(/route-1 \(rev 3\)/)).toBeInTheDocument();
    const timeline = screen.getByRole('table', { name: /durable call events/i });
    expect(within(timeline).getAllByRole('row')).toHaveLength(4);
    expect(within(timeline).getByText('profile profile-1 rev 2')).toBeInTheDocument();
    const commands = screen.getByRole('table', { name: /control commands/i });
    expect(within(commands).getByText('completed')).toBeInTheDocument();
    const participants = screen.getByRole('table', { name: /livekit participants/i });
    expect(within(participants).getByText('agent-aida')).toBeInTheDocument();
  });

  it('reports another tenant call as not found', async () => {
    mockFetch(() => ({ status: 404, body: { error: 'call_not_found' } }));
    render(
      <MemoryRouter initialEntries={['/runtime/calls/nope']}>
        <Routes>
          <Route path="/runtime/calls/:callSessionId" element={<CallDetailScreen />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(/call_not_found/);
  });
});
