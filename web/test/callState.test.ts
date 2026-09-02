import { describe, expect, it } from 'vitest';
import { emptyCallView, reduceEvent, reduceEvents, type CallEvent } from '../src/runtime/callState';

const ev = (
  sequenceNumber: number,
  eventType: string,
  payload: Record<string, unknown> | null = null,
): CallEvent => ({ sequenceNumber, eventType, payload, createdAt: `t${sequenceNumber}` });

describe('call state reducer (OfficePulse vocabulary)', () => {
  it('follows a screened call through takeover to hangup', () => {
    let view = emptyCallView('c1');
    view = reduceEvent(view, ev(1, 'bootstrapped', { profileId: 'p1', profileRevision: 2 }));
    expect(view.phase).toBe('screening');
    expect(view.aidaPresent).toBe(true);
    expect(view.timeline[0]!.detail).toBe('profile p1 rev 2');

    view = reduceEvents(view, [
      ev(2, 'aida-connected'),
      ev(3, 'takeover-requested'),
      ev(4, 'ringing'),
    ]);
    expect(view.phase).toBe('takeover-ringing');

    view = reduceEvents(view, [ev(5, 'answered'), ev(6, 'bridged'), ev(7, 'aida-drained')]);
    expect(view.phase).toBe('human-connected');
    expect(view.humanPresent).toBe(true);
    expect(view.aidaPresent).toBe(false);

    view = reduceEvent(view, ev(8, 'hangup'));
    expect(view.phase).toBe('ended');
    expect(view.humanPresent).toBe(false);
  });

  it('records why a takeover failed and leaves the caller with Aida', () => {
    const view = reduceEvents(emptyCallView('c1'), [
      ev(1, 'bootstrapped'),
      ev(2, 'ringing'),
      ev(3, 'takeover-failed', { reason: 'no-answer' }),
    ]);
    expect(view.phase).toBe('screening');
    expect(view.aidaPresent).toBe(true);
    expect(view.failureReason).toBe('no-answer');
  });

  it('shows a fallback with its reason', () => {
    const view = reduceEvents(emptyCallView('c1'), [
      ev(1, 'fallback', { reason: 'livekit-unavailable' }),
    ]);
    expect(view.phase).toBe('fallback');
    expect(view.failureReason).toBe('livekit-unavailable');
    expect(view.aidaPresent).toBe(false);
  });

  it('is idempotent and order-independent across replays', () => {
    const events = [ev(1, 'bootstrapped'), ev(2, 'ringing'), ev(3, 'answered'), ev(4, 'hangup')];
    const forward = reduceEvents(emptyCallView('c1'), events);
    const shuffled = reduceEvents(emptyCallView('c1'), [
      events[3]!,
      events[1]!,
      events[0]!,
      events[2]!,
    ]);
    const replayed = reduceEvents(forward, events);
    for (const view of [shuffled, replayed]) {
      expect(view.phase).toBe('ended');
      expect(view.timeline.map((t) => t.sequenceNumber)).toEqual([1, 2, 3, 4]);
      expect(view.timeline).toHaveLength(4);
    }
  });

  it('surfaces a gap in the durable record', () => {
    const view = reduceEvents(emptyCallView('c1'), [ev(1, 'bootstrapped'), ev(3, 'ringing')]);
    expect(view.sequenceGap).toBe(true);
    const filled = reduceEvent(view, ev(2, 'aida-connected'));
    expect(filled.sequenceGap).toBe(false);
    expect(filled.phase).toBe('takeover-ringing');
  });

  it('ignores livekit.* and unknown events beyond the cursor', () => {
    const view = reduceEvents(emptyCallView('c1'), [
      ev(1, 'bootstrapped'),
      ev(2, 'livekit.participant_joined'),
      ev(3, 'something-new'),
    ]);
    expect(view.phase).toBe('screening');
    expect(view.highestSequence).toBe(3);
    expect(reduceEvent(view, ev(4, 'livekit.room_finished')).phase).toBe('ended');
  });
});
