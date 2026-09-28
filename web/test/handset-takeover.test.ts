import { expect, it } from 'vitest';
import { handsetTakeoverExtension } from '../src/runtime/handsetTakeover';
import type { RuntimeCommand, RuntimeEvent } from '../src/api/runtime';

const command: RuntimeCommand = {
  idempotencyKey: 'k1',
  commandType: 'TAKEOVER',
  payload: { deviceId: 'phone', endpointId: '411' },
  status: 'completed',
  result: { status: 'ringing' },
  createdAt: '2026-09-20T10:00:00Z',
  completedAt: '2026-09-20T10:00:01Z',
};
const event = (
  sequenceNumber: number,
  eventType: string,
  payload: Record<string, unknown> | null = null,
): RuntimeEvent => ({ sequenceNumber, eventType, payload, createdAt: '2026-09-20T10:00:02Z' });
const requested = event(1, 'takeover-requested', { deviceId: 'phone', endpointId: '411' });
it('uses the command payload after a later bridge, including replayed events and ended calls', () => {
  expect(
    handsetTakeoverExtension([command], [event(3, 'hangup'), event(2, 'bridged'), requested]),
  ).toBe('411');
});
it.each(['ringing', 'takeover-failed', 'fallback', 'hangup'])(
  'does not call %s a successful handset takeover',
  (type) => {
    expect(handsetTakeoverExtension([command], [requested, event(2, type)])).toBeNull();
  },
);
it('does not attribute a later staff takeover to an earlier failed handset request', () => {
  expect(
    handsetTakeoverExtension(
      [command],
      [requested, event(2, 'takeover-failed'), event(3, 'takeover-requested'), event(4, 'bridged')],
    ),
  ).toBeNull();
});
it('recognizes an answered command but never labels a failed or non-handset command', () => {
  expect(handsetTakeoverExtension([{ ...command, result: { status: 'answered' } }], [])).toBe(
    '411',
  );
  expect(handsetTakeoverExtension([{ ...command, status: 'failed' }], [])).toBeNull();
  expect(
    handsetTakeoverExtension([{ ...command, payload: null, result: { status: 'answered' } }], []),
  ).toBeNull();
});
