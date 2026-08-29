/**
 * Client-side reduction of durable AidaControl call events into one call's
 * view. Events are ordered by `sequenceNumber` (unique per call session) and
 * may arrive duplicated or reordered across reconnect/replay; the reducer is
 * idempotent per sequence number, so replays never duplicate transcript
 * lines or command progress. A missing sequence number below the highest one
 * seen is a transcript gap — live-only transcripts cannot be recovered, so
 * the gap is surfaced, never papered over.
 */

export interface CallEvent {
  sequenceNumber: number;
  eventType: string;
  payload: Record<string, unknown>;
}

export type CommandStatus =
  'PENDING' | 'RINGING' | 'ANSWERED' | 'DRAINING' | 'COMPLETED' | 'FAILED';

export interface CommandView {
  idempotencyKey: string;
  commandType: string;
  status: CommandStatus;
  detail: string | null;
}

export interface TranscriptLine {
  sequenceNumber: number;
  speaker: string;
  text: string;
}

export interface CallView {
  callSessionId: string;
  callerNumber: string | null;
  state: string;
  version: number;
  transcript: TranscriptLine[];
  speechState: string | null;
  suggestions: string[];
  commands: CommandView[];
  /** transfer.failed reason; Aida has resumed the call. */
  transferFailedReason: string | null;
  /** True when a sequence gap was observed — earlier speech is unrecoverable. */
  transcriptGap: boolean;
  seenSequences: Set<number>;
  highestSequence: number;
}

export function emptyCallView(callSessionId: string): CallView {
  return {
    callSessionId,
    callerNumber: null,
    state: 'UNKNOWN',
    version: 0,
    transcript: [],
    speechState: null,
    suggestions: [],
    commands: [],
    transferFailedReason: null,
    transcriptGap: false,
    seenSequences: new Set(),
    highestSequence: 0,
  };
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

export function reduceEvent(view: CallView, event: CallEvent): CallView {
  // Idempotence: a duplicated or replayed event changes nothing.
  if (view.seenSequences.has(event.sequenceNumber)) return view;

  const next: CallView = {
    ...view,
    transcript: [...view.transcript],
    suggestions: [...view.suggestions],
    commands: [...view.commands],
    seenSequences: new Set(view.seenSequences),
  };
  next.seenSequences.add(event.sequenceNumber);
  next.highestSequence = Math.max(next.highestSequence, event.sequenceNumber);

  const payload = event.payload ?? {};
  switch (event.eventType) {
    case 'call.state': {
      next.state = str(payload.state) ?? next.state;
      const version = Number(payload.version);
      if (Number.isInteger(version)) next.version = Math.max(next.version, version);
      if (payload.callerNumber !== undefined) {
        next.callerNumber = str(payload.callerNumber);
      }
      break;
    }
    case 'transcript.segment': {
      const text = str(payload.text);
      if (text) {
        next.transcript.push({
          sequenceNumber: event.sequenceNumber,
          speaker: str(payload.speaker) ?? 'unknown',
          text,
        });
        next.transcript.sort((a, b) => a.sequenceNumber - b.sequenceNumber);
      }
      break;
    }
    case 'speech.state':
      next.speechState = str(payload.speaking);
      break;
    case 'suggestion': {
      const text = str(payload.text);
      if (text && !next.suggestions.includes(text)) next.suggestions.push(text);
      break;
    }
    case 'command.progress': {
      const key = str(payload.idempotencyKey);
      const status = str(payload.status) as CommandStatus | null;
      if (key && status) {
        const existing = next.commands.find((c) => c.idempotencyKey === key);
        if (existing) {
          existing.status = status;
          existing.detail = str(payload.detail);
        } else {
          next.commands.push({
            idempotencyKey: key,
            commandType: str(payload.commandType) ?? 'TAKEOVER',
            status,
            detail: str(payload.detail),
          });
        }
      }
      break;
    }
    case 'transfer.failed':
      // Aida resumed the call; show the reason.
      next.transferFailedReason = str(payload.reason) ?? 'unknown reason';
      break;
    default:
      // Unknown durable events advance the cursor without local effect.
      break;
  }

  // Gap detection: any missing sequence number at or below the highest seen
  // means live speech was lost for good.
  next.transcriptGap = next.seenSequences.size < next.highestSequence;
  return next;
}

export function reduceEvents(view: CallView, events: CallEvent[]): CallView {
  return events.reduce(reduceEvent, view);
}
