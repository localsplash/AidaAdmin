import type { IdEvent } from './client.js';
import type { MemoryAuthDb } from '../auth/session-store.js';

/**
 * Session-affecting operations an identity event may perform. Implementations
 * bind these to the same transaction that records the event, so an event is
 * marked processed only when every persistent change committed with it.
 *
 * Phase 3+: when NocoDB tenant_user mappings exist, `user.merged` must also
 * repoint those before the event commits as processed — add that effect here
 * and complete it inside process(), never after the 2xx.
 */
export interface IdentityEffects {
  revokeUserSessions(iUserId: number): Promise<number>;
  mergeUserSessions(fromUserId: number, toUserId: number): Promise<number>;
}

/**
 * Durable, idempotent identity-event processing:
 *  1. record the event keyed by its id (a duplicate short-circuits),
 *  2. apply the effects,
 *  3. mark the event processed and advance the checkpoint,
 *  4. commit everything together.
 * Callers acknowledge (2xx) only after process() resolves.
 */
export interface IdentityEventStore {
  process(
    event: IdEvent,
    effects: (fx: IdentityEffects) => Promise<void>,
  ): Promise<'applied' | 'duplicate'>;
  /** Last durably processed event id — the catch-up `since` value. */
  checkpoint(): Promise<number>;
}

export class MemoryIdentityEventStore implements IdentityEventStore {
  private readonly seen = new Set<number>();
  private lastEventId = 0;

  constructor(private readonly db: MemoryAuthDb) {}

  async process(
    event: IdEvent,
    effects: (fx: IdentityEffects) => Promise<void>,
  ): Promise<'applied' | 'duplicate'> {
    if (this.seen.has(event.id)) return 'duplicate';
    const db = this.db;
    await effects({
      async revokeUserSessions(iUserId) {
        return db.revokeByUser(iUserId);
      },
      async mergeUserSessions(fromUserId, toUserId) {
        return db.mergeUser(fromUserId, toUserId);
      },
    });
    this.seen.add(event.id);
    if (event.id > this.lastEventId) this.lastEventId = event.id;
    return 'applied';
  }

  async checkpoint(): Promise<number> {
    return this.lastEventId;
  }
}
