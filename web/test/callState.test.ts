import { describe, expect, it } from 'vitest';
import { emptyCallView, reduceEvents, type CallEvent } from '../src/runtime/callState';

const seg = (sequenceNumber: number, text: string, speaker = 'caller'): CallEvent => ({
  sequenceNumber,
  eventType: 'transcript.segment',
  payload: { speaker, text },
});

describe('call event reducer', () => {
  it('applies duplicate and reordered events exactly once, in order', () => {
    const events = [seg(2, 'second'), seg(1, 'first'), seg(2, 'second'), seg(3, 'third')];
    const view = reduceEvents(emptyCallView('c1'), events);
    expect(view.transcript.map((l) => l.text)).toEqual(['first', 'second', 'third']);
    expect(view.transcriptGap).toBe(false);

    // A full replay after reconnect changes nothing.
    const replayed = reduceEvents(view, events);
    expect(replayed.transcript).toHaveLength(3);
  });

  it('marks a sequence gap as unrecoverable', () => {
    const view = reduceEvents(emptyCallView('c1'), [seg(1, 'first'), seg(4, 'later')]);
    expect(view.transcriptGap).toBe(true);
    expect(view.transcript.map((l) => l.text)).toEqual(['first', 'later']);
  });

  it('tracks call state, version, speech state, and suggestions', () => {
    const view = reduceEvents(emptyCallView('c1'), [
      {
        sequenceNumber: 1,
        eventType: 'call.state',
        payload: { state: 'SCREENING', version: 3, callerNumber: '+15105550100' },
      },
      { sequenceNumber: 2, eventType: 'speech.state', payload: { speaking: 'aida' } },
      { sequenceNumber: 3, eventType: 'suggestion', payload: { text: 'Offer a callback' } },
      { sequenceNumber: 4, eventType: 'suggestion', payload: { text: 'Offer a callback' } },
    ]);
    expect(view.state).toBe('SCREENING');
    expect(view.version).toBe(3);
    expect(view.callerNumber).toBe('+15105550100');
    expect(view.speechState).toBe('aida');
    expect(view.suggestions).toEqual(['Offer a callback']);
  });

  it('keys command progress on the idempotency key so replays never duplicate commands', () => {
    const progress = (sequenceNumber: number, status: string): CallEvent => ({
      sequenceNumber,
      eventType: 'command.progress',
      payload: { idempotencyKey: 'k1', commandType: 'TAKEOVER', status },
    });
    const view = reduceEvents(emptyCallView('c1'), [
      progress(1, 'PENDING'),
      progress(2, 'RINGING'),
      progress(2, 'RINGING'),
      progress(3, 'ANSWERED'),
    ]);
    expect(view.commands).toHaveLength(1);
    expect(view.commands[0]?.status).toBe('ANSWERED');
  });

  it('surfaces failed transfers with Aida resuming', () => {
    const view = reduceEvents(emptyCallView('c1'), [
      { sequenceNumber: 1, eventType: 'transfer.failed', payload: { reason: 'no answer' } },
    ]);
    expect(view.transferFailedReason).toBe('no answer');
  });
});
