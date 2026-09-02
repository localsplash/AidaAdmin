/**
 * Client-side reduction of OfficePulse's durable call events into one call's
 * view. Events are ordered by `sequenceNumber` (unique per call session)
 * and may arrive duplicated or reordered across reconnect/replay; the
 * reducer is idempotent per sequence number. A missing number below the
 * highest seen is a gap in the durable record and is surfaced as such.
 *
 * The vocabulary is OfficePulse's own (its takeover manager, orchestrator
 * and LiveKit webhook handler): bootstrapped, fallback, screening-started,
 * takeover-requested, ringing, answered, bridged, aida-connected,
 * aida-drained, aida-lost, takeover-failed, hangup, human-hangup, and
 * `livekit.<event>`. Live transcripts are NOT in this record — they travel
 * over LiveKit Data and are never persisted — so there is no transcript here
 * by design.
 */

export interface CallEvent {
  sequenceNumber: number;
  eventType: string;
  payload: Record<string, unknown> | null;
  createdAt?: string;
}

export type CallPhase =
  | 'bootstrapping'
  | 'screening'
  | 'fallback'
  | 'takeover-ringing'
  | 'human-connected'
  | 'ended'
  | 'unknown';

export interface TimelineEntry {
  sequenceNumber: number;
  eventType: string;
  at: string | null;
  detail: string | null;
}

export interface CallView {
  callSessionId: string;
  phase: CallPhase;
  timeline: TimelineEntry[];
  /** Why the last takeover or bootstrap did not go as configured. */
  failureReason: string | null;
  aidaPresent: boolean;
  humanPresent: boolean;
  /** True when a sequence gap was observed in the durable record. */
  sequenceGap: boolean;
  seenSequences: Set<number>;
  highestSequence: number;
}

export function emptyCallView(callSessionId: string): CallView {
  return {
    callSessionId,
    phase: 'unknown',
    timeline: [],
    failureReason: null,
    aidaPresent: false,
    humanPresent: false,
    sequenceGap: false,
    seenSequences: new Set(),
    highestSequence: 0,
  };
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

/** A one-line human reading of an event's payload, if it has one. */
function detailOf(eventType: string, payload: Record<string, unknown> | null): string | null {
  if (!payload) return null;
  const reason = str(payload.reason) ?? str(payload.error);
  if (reason) return reason;
  if (eventType === 'bootstrapped' && payload.profileId) {
    return `profile ${String(payload.profileId)} rev ${String(payload.profileRevision ?? '?')}`;
  }
  return null;
}

export function reduceEvent(view: CallView, event: CallEvent): CallView {
  // Idempotence: a duplicated or replayed event changes nothing.
  if (view.seenSequences.has(event.sequenceNumber)) return view;

  const next: CallView = {
    ...view,
    timeline: [...view.timeline],
    seenSequences: new Set(view.seenSequences),
  };
  next.seenSequences.add(event.sequenceNumber);
  next.highestSequence = Math.max(next.highestSequence, event.sequenceNumber);

  const payload = event.payload ?? null;
  next.timeline.push({
    sequenceNumber: event.sequenceNumber,
    eventType: event.eventType,
    at: event.createdAt ?? null,
    detail: detailOf(event.eventType, payload),
  });
  next.timeline.sort((a, b) => a.sequenceNumber - b.sequenceNumber);

  // Phase is derived from the latest event in sequence order, so a replay
  // that arrives out of order still lands on the same answer.
  const latest = next.timeline[next.timeline.length - 1];
  if (latest && latest.sequenceNumber === event.sequenceNumber) {
    applyEvent(next, event.eventType, payload);
  } else {
    // An older event filled in behind: recompute from the start.
    const rebuilt = next.timeline.reduce(
      (acc, entry) => {
        applyEvent(acc, entry.eventType, null, entry.detail);
        return acc;
      },
      { ...emptyCallView(view.callSessionId) },
    );
    next.phase = rebuilt.phase;
    next.failureReason = rebuilt.failureReason;
    next.aidaPresent = rebuilt.aidaPresent;
    next.humanPresent = rebuilt.humanPresent;
  }

  next.sequenceGap = next.seenSequences.size < next.highestSequence;
  return next;
}

function applyEvent(
  view: CallView,
  eventType: string,
  payload: Record<string, unknown> | null,
  detail: string | null = null,
): void {
  const reason = detail ?? detailOf(eventType, payload);
  switch (eventType) {
    case 'bootstrapped':
      view.phase = 'screening';
      view.aidaPresent = true;
      break;
    case 'screening-started':
    case 'aida-connected':
      view.phase = view.humanPresent ? 'human-connected' : 'screening';
      view.aidaPresent = true;
      break;
    case 'fallback':
      view.phase = 'fallback';
      view.aidaPresent = false;
      view.failureReason = reason ?? 'fallback';
      break;
    case 'takeover-requested':
    case 'ringing':
      view.phase = 'takeover-ringing';
      break;
    case 'answered':
    case 'bridged':
      view.phase = 'human-connected';
      view.humanPresent = true;
      view.failureReason = null;
      break;
    case 'aida-drained':
      view.aidaPresent = false;
      break;
    case 'aida-lost':
      // Aida's leg dropped. The caller keeps whoever is present.
      view.aidaPresent = false;
      view.failureReason = reason ?? 'aida-lost';
      if (!view.humanPresent) view.phase = 'fallback';
      break;
    case 'takeover-failed':
      view.phase = view.aidaPresent ? 'screening' : 'fallback';
      view.failureReason = reason ?? 'takeover-failed';
      break;
    case 'human-hangup':
      view.humanPresent = false;
      break;
    case 'hangup':
    case 'livekit.room_finished':
      view.phase = 'ended';
      view.aidaPresent = false;
      view.humanPresent = false;
      break;
    default:
      // livekit.* and unknown durable events advance the cursor only.
      break;
  }
}

export function reduceEvents(view: CallView, events: CallEvent[]): CallView {
  return events.reduce(reduceEvent, view);
}

/** Human labels for the phases, used by every screen that shows one. */
export const PHASE_LABEL: Record<CallPhase, string> = {
  bootstrapping: 'Bootstrapping',
  screening: 'Aida screening',
  fallback: 'Routed to fallback destination',
  'takeover-ringing': 'Takeover — ringing',
  'human-connected': 'Human connected',
  ended: 'Ended',
  unknown: 'Unknown',
};
