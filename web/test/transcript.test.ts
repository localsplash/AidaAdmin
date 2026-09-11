import { expect, it } from 'vitest';
import { receiveTranscript, type Segment } from '../src/runtime/transcript';
const packet = (overrides = {}) =>
  new TextEncoder().encode(
    JSON.stringify({
      type: 'transcript',
      callId: 'call',
      streamId: 'stream',
      segmentId: 'segment',
      sequence: 1,
      speaker: 'caller',
      text: 'Hello',
      isFinal: false,
      ...overrides,
    }),
  );
it('updates partials, deduplicates, and never regresses finals', () => {
  const first = receiveTranscript([], packet(), 'call');
  expect(receiveTranscript(first, packet(), 'call')).toBe(first);
  const final = receiveTranscript(
    first,
    packet({ sequence: 2, isFinal: true, text: 'Hello there' }),
    'call',
  );
  expect(final).toHaveLength(1);
  expect(final[0]!.text).toBe('Hello there');
  expect(receiveTranscript(final, packet({ sequence: 3 }), 'call')).toBe(final);
});
it('accepts late join and new streams, rejects foreign/malformed/oversized data and bounds memory', () => {
  let rows: Segment[] = [];
  for (let n = 50; n < 300; n++)
    rows = receiveTranscript(rows, packet({ segmentId: String(n), sequence: n }), 'call');
  expect(rows).toHaveLength(200);
  expect(receiveTranscript(rows, packet({ callId: 'other' }), 'call')).toBe(rows);
  expect(receiveTranscript(rows, new Uint8Array(16001), 'call')).toBe(rows);
  expect(receiveTranscript(rows, packet({ streamId: 'new' }), 'call').at(-1)!.key).toContain('new');
});
