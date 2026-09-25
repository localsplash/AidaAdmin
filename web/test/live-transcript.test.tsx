import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { TextStreamReader } from 'livekit-client';
type Handler = (reader: TextStreamReader, participant: { identity: string }) => Promise<void>;
const mocks = vi.hoisted(() => ({
  rooms: [] as Array<{
    handlers: Map<string, (...args: unknown[]) => void>;
    streams: Map<string, Handler>;
    connect: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    localParticipant: { performRpc: ReturnType<typeof vi.fn> };
  }>,
  observe: vi.fn(),
  rpc: vi.fn(),
}));
vi.mock('../src/api/runtime', async (original) => ({
  ...(await original<object>()),
  runtimeApi: { observe: mocks.observe },
}));
vi.mock('livekit-client', () => ({
  RoomEvent: {
    Reconnecting: 'reconnecting',
    Reconnected: 'reconnected',
    Disconnected: 'disconnected',
  },
  Room: class {
    handlers = new Map();
    streams = new Map();
    remoteParticipants = new Map([
      ['agent-identity', { sid: 'agent', identity: 'agent-identity' }],
      ['stranger', { sid: 'other', identity: 'stranger' }],
    ]);
    localParticipant = { performRpc: mocks.rpc };
    connect = vi.fn().mockResolvedValue(undefined);
    disconnect = vi.fn().mockResolvedValue(undefined);
    constructor() {
      mocks.rooms.push(this);
    }
    on(name: string, handler: (...args: unknown[]) => void) {
      this.handlers.set(name, handler);
    }
    registerTextStreamHandler(topic: string, handler: Handler) {
      this.streams.set(topic, handler);
    }
  },
}));
import { RuntimeApiError } from '../src/api/runtime';
import { LiveTranscript } from '../src/components/LiveTranscript';
const item = (overrides = {}) => ({
  id: 'message',
  segment_id: 'segment',
  role: 'user',
  content: ['Earlier words'],
  sequence: 1,
  is_final: true,
  ...overrides,
});
const page = (items: unknown[]) =>
  JSON.stringify({
    snapshotId: 'snapshot',
    text: JSON.stringify({ callId: 'call', items }),
    nextOffset: null,
  });
function reader(text: string, attrs: Record<string, string> = {}): TextStreamReader {
  return {
    info: {
      attributes: {
        'lk.segment_id': 'segment',
        'lk.transcription_final': 'true',
        'aida.sequence': '1',
        'aida.speaker': 'caller',
        'aida.call_id': 'call',
        ...attrs,
      },
    },
    withAbortSignal() {
      return this;
    },
    async *[Symbol.asyncIterator]() {
      yield text;
    },
  } as unknown as TextStreamReader;
}
beforeEach(() => {
  mocks.rooms.length = 0;
  mocks.observe.mockReset().mockResolvedValue({
    url: 'wss://example.invalid',
    token: 'test',
    expiresIn: 60,
    agentParticipantSid: 'agent',
  });
  mocks.rpc.mockReset().mockResolvedValue(page([item()]));
});
afterEach(() => vi.useRealTimers());

it('hydrates from the bound agent and deduplicates native streams received while the RPC is pending', async () => {
  let resolve!: (value: string) => void;
  mocks.rpc.mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const rendered = render(<LiveTranscript callId="call" ended={false} autoConnect />);
  await waitFor(() => expect(mocks.rpc).toHaveBeenCalled());
  const room = mocks.rooms[0]!;
  expect(room.connect).toHaveBeenCalledWith('wss://example.invalid', 'test', {
    autoSubscribe: false,
  });
  expect(mocks.rpc.mock.calls[0]![0]).toMatchObject({
    destinationIdentity: 'agent-identity',
    method: 'get_transcript',
  });
  const stream = room.streams.get('lk.transcription')!;
  await act(() => stream(reader('Earlier words'), { identity: 'agent-identity' }));
  expect(screen.queryByText(/Earlier words/)).toBeNull();
  await act(async () => {
    resolve(page([item()]));
  });
  expect(screen.getAllByRole('listitem')).toHaveLength(1);
  expect(screen.getByRole('listitem')).toHaveTextContent('Earlier words');
  await act(() =>
    stream(reader('Spoofed', { 'lk.segment_id': 'spoof' }), { identity: 'stranger' }),
  );
  await act(() =>
    stream(reader('Foreign', { 'aida.call_id': 'other' }), { identity: 'agent-identity' }),
  );
  expect(screen.queryByText(/Spoofed|Foreign/)).toBeNull();
  await act(() =>
    stream(reader('Next utterance', { 'lk.segment_id': 'next', 'aida.sequence': '2' }), {
      identity: 'agent-identity',
    }),
  );
  expect(screen.getAllByRole('listitem')).toHaveLength(2);
  rendered.rerender(<LiveTranscript callId="call" ended autoConnect />);
  await waitFor(() => expect(room.disconnect).toHaveBeenCalled());
  expect(screen.getByRole('status')).toHaveTextContent('Call ended');
});

it('keeps a streaming utterance in one row when it is committed during history loading', async () => {
  mocks.rpc.mockResolvedValue(page([item({ is_final: false, content: ['Hel'] })]));
  render(<LiveTranscript callId="call" ended={false} autoConnect />);
  await screen.findByText(/history caught up/);
  await act(() =>
    mocks.rooms[0]!.streams.get('lk.transcription')!(
      reader('Hello there', { 'aida.sequence': '2' }),
      { identity: 'agent-identity' },
    ),
  );
  expect(screen.getAllByRole('listitem')).toHaveLength(1);
  expect(screen.getByRole('listitem')).toHaveTextContent('Hello there');
});

it('hydrates again after a LiveKit reconnect', async () => {
  render(<LiveTranscript callId="call" ended={false} autoConnect />);
  await screen.findByText(/history caught up/);
  mocks.rpc.mockResolvedValue(
    page([
      item(),
      item({ id: 'second', segment_id: 'second', content: ['Missed speech'], sequence: 2 }),
    ]),
  );
  act(() => mocks.rooms[0]!.handlers.get('reconnected')!());
  expect(await screen.findByText(/Missed speech/)).toBeInTheDocument();
  expect(mocks.rpc).toHaveBeenCalledTimes(2);
});

it('retries unavailable history, but never claims it caught up before success', async () => {
  vi.useFakeTimers();
  mocks.rpc.mockRejectedValueOnce(new Error('unsupported'));
  const rendered = render(<LiveTranscript callId="call" ended={false} autoConnect />);
  await act(async () => {});
  expect(screen.getByRole('status')).toHaveTextContent(
    'Transcript history unavailable — retrying automatically',
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000);
  });
  expect(mocks.rpc).toHaveBeenCalledTimes(2);
  expect(screen.getByRole('status')).toHaveTextContent('history caught up');
  rendered.unmount();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(65000);
  });
  expect(mocks.rpc).toHaveBeenCalledTimes(2);
});

it('retries agent admission and renews authorization, clearing text on revocation', async () => {
  vi.useFakeTimers();
  mocks.observe.mockRejectedValueOnce(
    new RuntimeApiError(409, 'Waiting for agent', 'agent_not_ready'),
  );
  render(<LiveTranscript callId="call" ended={false} autoConnect />);
  await act(async () => {});
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000);
  });
  expect(screen.getByRole('listitem')).toHaveTextContent('Earlier words');
  mocks.observe.mockRejectedValue(new RuntimeApiError(403, 'Access revoked'));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60001);
  });
  expect(mocks.rooms[0]!.disconnect).toHaveBeenCalled();
  expect(screen.getByRole('status')).toHaveTextContent('Access revoked');
  expect(screen.queryByRole('listitem')).toBeNull();
});

it('ignores history that resolves after leaving and allows pausing', async () => {
  let resolve!: (value: string) => void;
  mocks.rpc.mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const rendered = render(<LiveTranscript callId="call" ended={false} autoConnect />);
  await waitFor(() => expect(mocks.rpc).toHaveBeenCalled());
  fireEvent.click(screen.getByRole('button', { name: 'Stop observing' }));
  await act(async () => {
    resolve(page([item()]));
  });
  expect(screen.queryByRole('listitem')).toBeNull();
  rendered.unmount();
  render(<LiveTranscript callId="ended" ended autoConnect />);
  expect(mocks.observe).toHaveBeenCalledTimes(1);
});

it('ignores an old catch-up response if reconnection starts a newer snapshot', async () => {
  let resolve!: (value: string) => void;
  mocks.rpc.mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    }),
  );
  render(<LiveTranscript callId="call" ended={false} autoConnect />);
  await waitFor(() => expect(mocks.rpc).toHaveBeenCalledTimes(1));
  const room = mocks.rooms[0]!;
  act(() => room.handlers.get('reconnecting')!());
  mocks.rpc.mockResolvedValue(page([item({ content: ['Recovered history'] })]));
  act(() => room.handlers.get('reconnected')!());
  await screen.findByText(/Recovered history/);
  await act(async () => {
    resolve(page([item({ content: ['Stale history'] })]));
  });
  expect(screen.getByRole('listitem')).toHaveTextContent('Recovered history');
  expect(screen.queryByText(/Stale history/)).toBeNull();
});
