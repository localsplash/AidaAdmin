import { Router } from 'express';
import type { AppConfig } from '../config.js';
import { parseCidrList } from '../config.js';
import type { Logger } from '../logger.js';
import { ipInCidrs, parseCidrs, resolveClientIp } from '../net/cidr.js';
import type { IdClient, IdEvent } from './client.js';
import type { IdentityEffects, IdentityEventStore } from './event-store.js';

/** id caps /api/events pages at this size; catch-up pages until drained. */
const EVENT_PAGE_SIZE = 200;

export interface IdEventDeps {
  eventStore: IdentityEventStore;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * The session/mapping changes one event requires. Runs inside the event
 * store's transaction: the event is recorded as processed only when every
 * effect here committed with it (id retries on any non-2xx, so failures are
 * safe to surface).
 */
async function applyEffects(event: IdEvent, fx: IdentityEffects, logger: Logger): Promise<void> {
  const data = event.data ?? {};
  switch (event.type) {
    case 'session.revoked': {
      // id's /api/token response carries no session identifier, so local
      // sessions cannot be tied to one id session. POC decision: any
      // session.revoked (scope "one" or "all") revokes every local session
      // for that user — strictly safer than under-revoking.
      const iUserId = asNumber(data.iUserId);
      if (iUserId !== null) {
        const revoked = await fx.revokeUserSessions(iUserId);
        logger.info(
          { eventId: event.id, revoked, scope: asString(data.scope) },
          'id session.revoked applied',
        );
      }
      break;
    }
    case 'user.merged': {
      const from = asNumber(data.fromUserId);
      const to = asNumber(data.toUserId);
      if (from !== null && to !== null) {
        const moved = await fx.mergeUserSessions(from, to);
        // Phase 3+: repoint NocoDB tenant_user mappings for `from` → `to`
        // here as well, before the event commits as processed.
        logger.info({ eventId: event.id, moved }, 'id user.merged applied');
      }
      break;
    }
    case 'identity.linked':
    case 'identity.unlinked':
      // No local identity copies exist; recording the event moves the cursor.
      logger.debug({ eventId: event.id, type: event.type }, 'id identity event acknowledged');
      break;
    case 'ping':
      break;
  }
}

/** Applies one identity event durably and idempotently. */
export async function processIdEvent(
  event: IdEvent,
  deps: IdEventDeps,
  logger: Logger,
): Promise<'applied' | 'duplicate'> {
  return deps.eventStore.process(event, (fx) => applyEffects(event, fx, logger));
}

/**
 * POST /id/events — inbound identity events. Trust is source-IPv4 only: the
 * resolved client (socket peer, or the proxy-appended forwarded address when
 * the peer is a trusted proxy) must fall inside ID_EVENT_SOURCE_CIDRS.
 * Responds 2xx only after the event and its effects committed; id retries on
 * anything else.
 */
export function idEventRoutes(config: AppConfig, logger: Logger, deps: IdEventDeps): Router {
  const router = Router();
  const sourceCidrs = parseCidrs(parseCidrList(config.serviceConfig.ID_EVENT_SOURCE_CIDRS));
  const proxyCidrs = parseCidrs(parseCidrList(config.serviceConfig.ID_TRUSTED_PROXY_CIDRS));

  router.post('/id/events', async (req, res, next) => {
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
    try {
      await processIdEvent(body as IdEvent, deps, logger);
      res.json({ ok: true });
    } catch (err) {
      // 5xx → id retries the delivery; nothing was committed.
      next(err);
    }
  });

  return router;
}

/**
 * Boot-time catch-up: read forward from the durable checkpoint, paging until
 * the log is drained (id serves at most EVENT_PAGE_SIZE per request).
 */
export async function catchUpIdEvents(
  idClient: IdClient,
  deps: IdEventDeps,
  logger: Logger,
): Promise<number> {
  let since = await deps.eventStore.checkpoint();
  let applied = 0;
  for (;;) {
    const events = await idClient.listEvents(since);
    if (events.length === 0) break;
    for (const event of events) {
      if ((await processIdEvent(event, deps, logger)) === 'applied') applied += 1;
    }
    const lastId = events[events.length - 1]?.id ?? since;
    if (lastId <= since) break;
    since = lastId;
    if (events.length < EVENT_PAGE_SIZE) break;
  }
  logger.info({ applied, cursor: since }, 'id event catch-up complete');
  return applied;
}
