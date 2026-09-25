import { expect, it, vi } from 'vitest';
import {
  loadTranscriptHistory,
  mergeTranscript,
  parseHistory,
  type Segment,
} from '../src/runtime/transcript';
const row: Segment = {
  key: 'segment-1',
  sequence: 1,
  text: 'Hello',
  isFinal: false,
  speaker: 'caller',
};
const snapshot = (overrides = {}) =>
  JSON.stringify({
    callId: 'call',
    items: [
      {
        id: 'message-1',
        segment_id: 'segment-1',
        role: 'user',
        content: ['Hello there'],
        is_final: true,
        sequence: 2,
        ...overrides,
      },
    ],
  });

it('deduplicates snapshots and streaming updates using the segment ID, never regressing finals', () => {
  const history = parseHistory(snapshot(), 'call');
  expect(mergeTranscript(history, row)).toBe(history);
  expect(mergeTranscript([row], history[0]!)).toEqual(history);
  expect(mergeTranscript(history, { ...history[0]! })).toBe(history);
  expect(mergeTranscript(history, { ...row, key: 'next', sequence: 3 })).toHaveLength(2);
});

it('updates chunks within a revision and rejects out-of-order revisions', () => {
  const updated = mergeTranscript([row], { ...row, text: 'Hello world' });
  expect(updated[0]!.text).toBe('Hello world');
  const newer = mergeTranscript(updated, { ...row, sequence: 3, text: 'Corrected' });
  expect(mergeTranscript(newer, { ...row, sequence: 2 })).toBe(newer);
});

it('rejects a foreign call or malformed snapshot', () => {
  expect(() => parseHistory(snapshot(), 'other')).toThrow();
  expect(() => parseHistory(snapshot({ content: [{ private: true }] }), 'call')).toThrow();
  expect(() => parseHistory(snapshot({ sequence: -1 }), 'call')).toThrow();
});

it('loads a complete paginated history with stable snapshot and offset validation', async () => {
  const text = snapshot({ content: ['Long call '.repeat(2000)] });
  const rpc = vi.fn(async (payload: string) => {
    const { offset, snapshotId } = JSON.parse(payload);
    if (offset > 0) expect(snapshotId).toBe('frozen');
    const end = Math.min(offset + 6000, text.length);
    return JSON.stringify({
      snapshotId: 'frozen',
      text: text.slice(offset, end),
      nextOffset: end < text.length ? end : null,
    });
  });
  expect((await loadTranscriptHistory(rpc, 'call', () => true))[0]!.text).toBe(
    'Long call '.repeat(2000),
  );
  expect(rpc.mock.calls.length).toBeGreaterThan(1);
  await expect(
    loadTranscriptHistory(
      async () => JSON.stringify({ snapshotId: 'x', text: 'a', nextOffset: 0 }),
      'call',
      () => true,
    ),
  ).rejects.toThrow('offset');
});
