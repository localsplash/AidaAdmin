import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import type { AppConfig } from '../config.js';
import { parseCidrList } from '../config.js';
import type { Logger } from '../logger.js';
import type { SessionStore } from '../auth/session-store.js';
import { ipInCidrs, parseCidrs, resolveClientIp } from '../net/cidr.js';
import type { IdClient, IdEvent } from './client.js';

const RECENT_IDS_KEPT = 500;

/**
 * Durable identity-event cursor. Event IDs from `id` are monotonically
 * increasing; the cursor plus a recent-ID window makes processing idempotent
 * across duplicate webhook deliveries and the boot-time catch-up overlap.
 */
export class IdEventState {
  private lastEventId = 0;
  private recentIds = new Set<number>();

  constructor(private readonly filePath: string | null) {
    if (!filePath) return;
    try {
      const raw = JSON.parse(readFileSync(filePath, 'utf8')) as {
        lastEventId?: number;
        recentIds?: number[];
      };
      this.lastEventId = raw.lastEventId ?? 0;
      this.recentIds = new Set(raw.recentIds ?? []);
    } catch {
      // Missing or unreadable state file: start from zero.
    }
  }

  get cursor(): number {
    return this.lastEventId;
  }

  /** Returns false when the event was already processed. */
  markProcessed(eventId: number): boolean {
    if (this.recentIds.has(eventId)) return false;
    if (eventId <= this.lastEventId - RECENT_IDS_KEPT) return false;
    this.recentIds.add(eventId);
    if (eventId > this.lastEventId) this.lastEventId = eventId;
    for (const id of this.recentIds) {
      if (id <= this.lastEventId - RECENT_IDS_KEPT) this.recentIds.delete(id);
    }
    this.persist();
    return true;
  }

  private persist(): void {
    if (!this.filePath) return;
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    writeFileSync(
      this.filePath,
      JSON.stringify({ lastEventId: this.lastEventId, recentIds: [...this.recentIds] }),
    );
  }
}

export interface IdEventDeps {
  sessionStore: SessionStore;
  eventState: IdEventState;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Applies one identity event; safe to call with duplicates or reorderings. */
export function processIdEvent(event: IdEvent, deps: IdEventDeps, logger: Logger): void {
  if (!deps.eventState.markProcessed(event.id)) {
    return;
  }
  const data = event.data ?? {};
  switch (event.type) {
    case 'session.revoked': {
      const idSessionId = asString(data.sessionId) ?? asString(data.sSessionId);
      const iUserId = asNumber(data.iUserId) ?? asNumber(data.userId);
      let revoked = 0;
      if (idSessionId) revoked += deps.sessionStore.revokeByIdSession(idSessionId);
      if (iUserId !== null) revoked += deps.sessionStore.revokeByUser(iUserId);
      logger.info({ eventId: event.id, revoked }, 'id session.revoked applied');
      break;
    }
    case 'user.merged': {
      const from = asNumber(data.fromUserId) ?? asNumber(data.fromIUserId);
      const to = asNumber(data.toUserId) ?? asNumber(data.toIUserId);
      if (from !== null && to !== null) {
        const moved = deps.sessionStore.mergeUser(from, to);
        logger.info({ eventId: event.id, moved }, 'id user.merged applied');
      }
      break;
    }
    case 'identity.linked':
    case 'identity.unlinked':
      // No local identity copies exist; acknowledging keeps the cursor moving.
      logger.debug({ eventId: event.id, type: event.type }, 'id identity event acknowledged');
      break;
    case 'ping':
      break;
  }
}

/**
 * POST /id/events — inbound identity events. Trust is source-IPv4 only: the
 * resolved client (socket peer, or the proxy-appended forwarded address when
 * the peer is a trusted proxy) must fall inside ID_EVENT_SOURCE_CIDRS.
 */
export function idEventRoutes(config: AppConfig, logger: Logger, deps: IdEventDeps): Router {
  const router = Router();
  const sourceCidrs = parseCidrs(parseCidrList(config.serviceConfig.ID_EVENT_SOURCE_CIDRS));
  const proxyCidrs = parseCidrs(parseCidrList(config.serviceConfig.ID_TRUSTED_PROXY_CIDRS));

  router.post('/id/events', (req, res) => {
    const clientIp = resolveClientIp(
      req.socket.remoteAddress,
      req.header('x-forwarded-for'),
      proxyCidrs,
    );
    if (!clientIp || !ipInCidrs(clientIp, sourceCidrs)) {
      logger.warn({ correlationId: req.correlationId }, 'id event rejected by CIDR policy');
      res.status(403).json({ error: 'forbidden', correlationId: req.correlationId });
      return;
    }
    const body = req.body as Partial<IdEvent> | undefined;
    if (!body || asNumber(body.id) === null || asString(body.type) === null) {
      res.status(400).json({ error: 'invalid_event', correlationId: req.correlationId });
      return;
    }
    processIdEvent(body as IdEvent, deps, logger);
    res.json({ ok: true });
  });

  return router;
}

/** Boot-time catch-up: GET /api/events?since=<last durably processed id>. */
export async function catchUpIdEvents(
  idClient: IdClient,
  deps: IdEventDeps,
  logger: Logger,
): Promise<number> {
  const events = await idClient.listEvents(deps.eventState.cursor);
  let applied = 0;
  for (const event of events) {
    processIdEvent(event, deps, logger);
    applied += 1;
  }
  logger.info({ applied, cursor: deps.eventState.cursor }, 'id event catch-up complete');
  return applied;
}
