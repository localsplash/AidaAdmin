import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  rooms: [] as Array<{
    handlers: Map<string, (...args: unknown[]) => void>;
    connect: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
  }>,
  observe: vi.fn(),
}));
vi.mock('../src/api/runtime', async (original) => ({
  ...(await original<object>()),
  runtimeApi: { observe: mocks.observe },
}));
vi.mock('livekit-client', () => ({
  RoomEvent: {
    DataReceived: 'data',
    Reconnecting: 'reconnecting',
    Reconnected: 'reconnected',
    Disconnected: 'disconnected',
  },
  Room: class {
    handlers = new Map();
    connect = vi.fn().mockResolvedValue(undefined);
    disconnect = vi.fn().mockResolvedValue(undefined);
    constructor() {
      mocks.rooms.push(this);
    }
    on(name: string, handler: (...args: unknown[]) => void) {
      this.handlers.set(name, handler);
    }
  },
}));
import { LiveTranscript } from '../src/components/LiveTranscript';
beforeEach(() => {
  mocks.rooms.length = 0;
  mocks.observe.mockReset().mockResolvedValue({
    url: 'wss://example.invalid',
    token: 'test',
    expiresIn: 60,
    agentParticipantSid: 'agent',
  });
});
it('explicitly observes text only, validates sender/topic, shows reconnect and ends cleanly', async () => {
  const rendered = render(<LiveTranscript callId="call" ended={false} />);
  expect(mocks.observe).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Observe live transcript' }));
  await screen.findByText('Connected — live text only');
  const room = mocks.rooms[0]!;
  expect(room.connect).toHaveBeenCalledWith('wss://example.invalid', 'test', {
    autoSubscribe: false,
  });
  const packet = new TextEncoder().encode(
    JSON.stringify({
      type: 'transcript',
      callId: 'call',
      streamId: 's',
      segmentId: 'a',
      sequence: 1,
      speaker: 'caller',
      isFinal: false,
      text: 'Test speech',
    }),
  );
  act(() => room.handlers.get('data')!(packet, { sid: 'stranger' }, 0, 'transcript'));
  expect(screen.queryByText(/Test speech/)).toBeNull();
  act(() => room.handlers.get('data')!(packet, { sid: 'agent' }, 0, 'transcript'));
  expect(screen.getByText(/Test speech/)).toBeInTheDocument();
  act(() => room.handlers.get('reconnecting')!());
  expect(screen.getByRole('status')).toHaveTextContent('Reconnecting');
  rendered.rerender(<LiveTranscript callId="call" ended />);
  await waitFor(() => expect(room.disconnect).toHaveBeenCalled());
  expect(screen.getByRole('status')).toHaveTextContent('Call ended');
});
it('surfaces unavailable credentials without connecting', async () => {
  mocks.observe.mockRejectedValue(new Error('unavailable'));
  render(<LiveTranscript callId="call" ended={false} />);
  fireEvent.click(screen.getByRole('button', { name: 'Observe live transcript' }));
  await screen.findByText('LiveKit connection unavailable');
  expect(mocks.rooms).toHaveLength(0);
});
