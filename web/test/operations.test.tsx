import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OperationsScreen } from '../src/screens/OperationsScreen';
import type { CallEvent } from '../src/runtime/callState';

interface Upstream {
  activeCalls: Array<{ callSessionId: string; callerNumber: string | null; state: string }>;
  eventsByCall: Record<string, CallEvent[]>;
  commands: Array<{ url: string; body: Record<string, unknown> }>;
  forbid?: boolean;
}

function mockRuntime(upstream: Upstream) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const respond = (status: number, body: unknown) =>
        new Response(JSON.stringify(body), { status });
      if (upstream.forbid) {
        return respond(403, { error: 'forbidden', message: 'Select a tenant first' });
      }
      if (url.includes('/runtime/calls?state=active')) {
        return respond(200, { calls: upstream.activeCalls });
      }
      if (url.includes('/runtime/calls?state=recent')) return respond(200, { calls: [] });
      if (url.includes('/runtime/operational-events')) return respond(200, { events: [] });
      const eventsMatch = /\/runtime\/calls\/([^/]+)\/events\?since=(\d+)/.exec(url);
      if (eventsMatch) {
        const since = Number(eventsMatch[2]);
        const all = upstream.eventsByCall[eventsMatch[1] as string] ?? [];
        return respond(200, { events: all.filter((e) => e.sequenceNumber > since) });
      }
      const commandMatch = /\/runtime\/calls\/([^/]+)\/commands$/.exec(url);
      if (commandMatch && init?.method === 'POST') {
        upstream.commands.push({ url, body: JSON.parse(String(init.body)) });
        return respond(200, { accepted: true });
      }
      return respond(404, {});
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const seg = (sequenceNumber: number, text: string): CallEvent => ({
  sequenceNumber,
  eventType: 'transcript.segment',
  payload: { speaker: 'caller', text },
});

describe('OperationsScreen', () => {
  it('keeps simultaneous calls isolated in their own tabs', async () => {
    mockRuntime({
      activeCalls: [
        { callSessionId: 'call-a', callerNumber: '+15105550001', state: 'SCREENING' },
        { callSessionId: 'call-b', callerNumber: '+15105550002', state: 'SCREENING' },
      ],
      eventsByCall: {
        'call-a': [seg(1, 'alpha words')],
        'call-b': [seg(1, 'bravo words')],
      },
      commands: [],
    });
    render(<OperationsScreen />);
    const panelA = await screen.findByRole('tabpanel', { name: '+15105550001' });
    expect(within(panelA).getByText(/alpha words/)).toBeInTheDocument();
    expect(within(panelA).queryByText(/bravo words/)).not.toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole('tab', { name: '+15105550002' }));
    const panelB = screen.getByRole('tabpanel', { name: '+15105550002' });
    expect(within(panelB).getByText(/bravo words/)).toBeInTheDocument();
    expect(within(panelB).queryByText(/alpha words/)).not.toBeInTheDocument();
  });

  it('never renders anything when the runtime is forbidden', async () => {
    mockRuntime({ activeCalls: [], eventsByCall: {}, commands: [], forbid: true });
    render(<OperationsScreen />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/select a tenant/i);
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
  });

  it('submits a takeover once with confirmation, version, and idempotency key', async () => {
    const upstream: Upstream = {
      activeCalls: [{ callSessionId: 'call-a', callerNumber: '+15105550001', state: 'SCREENING' }],
      eventsByCall: {
        'call-a': [
          {
            sequenceNumber: 1,
            eventType: 'call.state',
            payload: { state: 'SCREENING', version: 5 },
          },
        ],
      },
      commands: [],
    };
    mockRuntime(upstream);
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<OperationsScreen />);
    const user = userEvent.setup();
    const button = await screen.findByRole('button', { name: /take over this call/i });
    await user.click(button);
    await waitFor(() => expect(upstream.commands).toHaveLength(1));
    expect(confirmSpy).toHaveBeenCalled();
    const body = upstream.commands[0]!.body;
    expect(body.commandType).toBe('TAKEOVER');
    expect(body.expectedCallVersion).toBe(5);
    expect(typeof body.idempotencyKey).toBe('string');

    // The button is disabled after submission — a second click cannot happen.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /takeover in progress/i })).toBeDisabled(),
    );
    expect(upstream.commands).toHaveLength(1);
  });

  it('does not submit when the confirmation is declined', async () => {
    const upstream: Upstream = {
      activeCalls: [{ callSessionId: 'call-a', callerNumber: '+15105550001', state: 'SCREENING' }],
      eventsByCall: {},
      commands: [],
    };
    mockRuntime(upstream);
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<OperationsScreen />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /take over this call/i }));
    expect(upstream.commands).toHaveLength(0);
  });

  it('shows failed transfers with Aida resumed, transcript gaps, and takeover progress states', async () => {
    mockRuntime({
      activeCalls: [{ callSessionId: 'call-a', callerNumber: '+15105550001', state: 'SCREENING' }],
      eventsByCall: {
        'call-a': [
          seg(1, 'hello'),
          // Sequence 2 is missing: the gap must be surfaced.
          {
            sequenceNumber: 3,
            eventType: 'command.progress',
            payload: { idempotencyKey: 'k1', commandType: 'TAKEOVER', status: 'RINGING' },
          },
          {
            sequenceNumber: 4,
            eventType: 'transfer.failed',
            payload: { reason: 'destination did not answer' },
          },
        ],
      },
      commands: [],
    });
    render(<OperationsScreen />);
    expect(
      await screen.findByText(/transfer failed \(destination did not answer\) — aida resumed/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/transcript gap detected — the missing speech is unrecoverable/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/takeover ringing/i)).toBeInTheDocument();
  });

  it('marks historical conversations as coming soon', async () => {
    mockRuntime({ activeCalls: [], eventsByCall: {}, commands: [] });
    render(<OperationsScreen />);
    expect(
      await screen.findByRole('heading', { name: /historical conversations/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/coming soon/i)).toBeInTheDocument();
  });
});
