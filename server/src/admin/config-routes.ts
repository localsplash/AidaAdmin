import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import express, { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import type { AppDeps } from '../deps.js';
import type { Logger } from '../logger.js';
import { IdClientError } from '../id/client.js';
import {
  ConflictError,
  NotFoundError,
  UniqueViolationError,
  type AidaConfigRepos,
} from '../nocodb/repos.js';
import { ValidationError } from '../nocodb/validation.js';
import { OfficePulseError } from '../officepulse/client.js';
import { HandsetDeliveryError } from '../provisioning/handset-delivery.js';
import { requireSuperAdmin } from './authz.js';

const profileBody = z.object({
  tenantId: z.string(),
  name: z.string(),
  businessName: z.string(),
  prompt: z.string(),
  tone: z.string().nullish(),
  objective: z.string().nullish(),
  openingStatement: z.string().nullish(),
  transferStatement: z.string().nullish(),
  failedTransferStatement: z.string().nullish(),
  enabled: z.boolean().default(true),
  // LiveKit model/STT/TTS/voice are deliberately absent: aida-prime
  // supplies the defaults and the POC neither stores nor sends them.
});

const didRouteBody = z.object({
  tenantId: z.string(),
  didE164: z.string(),
  assistantProfileId: z.string(),
  destinationType: z.enum(['EXTENSION', 'RING_GROUP']),
  destinationId: z.string(),
  screeningEnabled: z.boolean().default(true),
  enabled: z.boolean().default(true),
});

const appearanceBody = z.object({
  brandName: z.string(),
  primaryColor: z.string().nullish(),
});

function fail(res: Response, req: Request, err: unknown): void {
  const correlationId = req.correlationId;
  if (err instanceof ValidationError) {
    res
      .status(400)
      .json({ error: 'validation', field: err.field, message: err.message, correlationId });
  } else if (err instanceof UniqueViolationError) {
    res
      .status(409)
      .json({ error: 'duplicate', fields: err.fields, message: err.message, correlationId });
  } else if (err instanceof ConflictError) {
    res.status(409).json({ error: 'revision_conflict', message: err.message, correlationId });
  } else if (err instanceof NotFoundError) {
    res.status(404).json({ error: 'not_found', message: err.message, correlationId });
  } else if (err instanceof OfficePulseError) {
    res.status(502).json({
      error: 'provisioning_failed',
      message:
        'The route was saved, but DID provisioning failed. Fix the PBX issue and retry; nothing reconciles in the background.',
      correlationId,
    });
  } else if (err instanceof HandsetDeliveryError || err instanceof IdClientError) {
    res.status(502).json({ error: 'upstream_failed', correlationId });
  } else {
    throw err;
  }
}

function parse<S extends z.ZodTypeAny>(
  schema: S,
  body: unknown,
  res: Response,
  req: Request,
): z.output<S> | null {
  const result = schema.safeParse(body);
  if (!result.success) {
    res.status(400).json({
      error: 'validation',
      message: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      correlationId: req.correlationId,
    });
    return null;
  }
  return result.data;
}

function expectedRevision(req: Request, res: Response): number | null {
  const value = Number((req.body as Record<string, unknown> | undefined)?.expectedRevision);
  if (!Number.isInteger(value) || value < 1) {
    res.status(400).json({
      error: 'validation',
      message: 'expectedRevision (integer >= 1) is required for updates',
      correlationId: req.correlationId,
    });
    return null;
  }
  return value;
}

/** PNG or JPEG only, decided by magic bytes — never by the declared type. */
function sniffImage(buffer: Buffer): 'png' | 'jpg' | null {
  if (
    buffer.length > 8 &&
    buffer.subarray(0, 8).equals(Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'))
  ) {
    return 'png';
  }
  if (buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'jpg';
  }
  return null;
}

/**
 * Assistant profiles, DID routes, and appearance (POC phase 5, issue #13).
 * Super Admin + CSRF like the rest of /admin. CRM import and conversation
 * history are future scope and have no endpoints here by design.
 */
export function configRoutes(config: AppConfig, logger: Logger, deps: AppDeps): Router {
  const router = Router();

  router.use('/admin', requireSuperAdmin);
  router.use('/admin', (req, res, next) => {
    if (!deps.repos) {
      res.status(503).json({ error: 'nocodb_not_configured', correlationId: req.correlationId });
      return;
    }
    next();
  });

  const repos = (): AidaConfigRepos => deps.repos!;

  const audit = (
    req: Request,
    action: string,
    entityType: string,
    entityId: string,
    tenantId: string,
  ) =>
    repos()
      .audit.append({
        tenantId,
        actorIdentityUserId: req.session!.iUserId,
        action,
        entityType,
        entityId,
        correlationId: req.correlationId,
      })
      .catch((err) => logger.error({ err }, 'audit append failed'));

  // ── Assistant profiles ────────────────────────────────────────────────────

  router.get('/admin/tenants/:tenantId/profiles', async (req, res, next) => {
    try {
      res.json({
        profiles: await repos().assistantProfiles.listForTenant(req.params.tenantId as string),
      });
    } catch (err) {
      next(err);
    }
  });

  router.post('/admin/profiles', async (req, res, next) => {
    try {
      const input = parse(profileBody, req.body, res, req);
      if (!input) return;
      await repos().tenants.get(input.tenantId);
      const profile = await repos().assistantProfiles.create(input.tenantId, input);
      await audit(
        req,
        'assistant_profile.create',
        'assistant_profile',
        profile.id as string,
        input.tenantId,
      );
      res.status(201).json({ profile });
    } catch (err) {
      try {
        fail(res, req, err);
      } catch (unhandled) {
        next(unhandled);
      }
    }
  });

  router.put('/admin/profiles/:profileId', async (req, res, next) => {
    try {
      const input = parse(profileBody, req.body, res, req);
      if (!input) return;
      const revision = expectedRevision(req, res);
      if (revision === null) return;
      const profile = await repos().assistantProfiles.update(
        input.tenantId,
        req.params.profileId as string,
        revision,
        input,
      );
      await audit(
        req,
        'assistant_profile.update',
        'assistant_profile',
        profile.id as string,
        input.tenantId,
      );
      res.json({ profile });
    } catch (err) {
      try {
        fail(res, req, err);
      } catch (unhandled) {
        next(unhandled);
      }
    }
  });

  // ── DID routes ────────────────────────────────────────────────────────────

  /** Fallback preview: where the call lands on takeover or screening failure. */
  async function destinationPreview(tenantId: string, route: Record<string, unknown>) {
    try {
      if (route.destination_type === 'EXTENSION' && route.destination_extension_id) {
        const ext = await repos().extensions.get(
          tenantId,
          route.destination_extension_id as string,
        );
        return `Extension ${ext.extension_number} — ${ext.display_name}`;
      }
      if (route.destination_type === 'RING_GROUP' && route.destination_ring_group_id) {
        const group = await repos().ringGroups.get(
          tenantId,
          route.destination_ring_group_id as string,
        );
        return `Ring group ${group.virtual_extension} — ${group.name}`;
      }
    } catch {
      // Destination missing: surface that instead of failing the listing.
    }
    return 'Destination unavailable';
  }

  router.get('/admin/tenants/:tenantId/did-routes', async (req, res, next) => {
    try {
      const tenantId = req.params.tenantId as string;
      const routes = await repos().didRoutes.listForTenant(tenantId);
      const withPreview = await Promise.all(
        routes.map(async (route) => ({
          ...route,
          fallbackPreview: await destinationPreview(tenantId, route),
        })),
      );
      res.json({ didRoutes: withPreview });
    } catch (err) {
      next(err);
    }
  });

  async function saveDidRoute(req: Request, res: Response, routeId: string | null): Promise<void> {
    const input = parse(didRouteBody, req.body, res, req);
    if (!input) return;
    const tenant = await repos().tenants.get(input.tenantId);
    // Screening dispatches this profile; a disabled one must be enabled (or
    // the route pointed elsewhere) before the route can be saved as enabled.
    const profile = await repos().assistantProfiles.get(input.tenantId, input.assistantProfileId);
    if (input.enabled && !profile.enabled) {
      throw new ValidationError(
        'assistantProfileId',
        'The assistant profile is disabled; enable it or choose another profile',
      );
    }
    let route;
    if (routeId === null) {
      route = await repos().didRoutes.create(input.tenantId, input);
      await audit(req, 'did_route.create', 'did_route', route.id as string, input.tenantId);
    } else {
      const revision = expectedRevision(req, res);
      if (revision === null) return;
      route = await repos().didRoutes.update(input.tenantId, routeId, revision, input);
      await audit(req, 'did_route.update', 'did_route', route.id as string, input.tenantId);
    }
    if (deps.officePulse) {
      // Inbound order is DID -> disclosure -> screening -> destination; the
      // realtime dialplan rows send the DID to the FastAGI bootstrap.
      await deps.officePulse.provisionDid(route.id as string, {
        didE164: route.did_e164 as string,
        context: tenant.asterisk_context as string,
        fastAgiPath: '/bootstrap',
        enabled: Boolean(route.enabled),
      });
    }
    res.status(routeId === null ? 201 : 200).json({
      didRoute: { ...route, fallbackPreview: await destinationPreview(input.tenantId, route) },
    });
  }

  router.post('/admin/did-routes', async (req, res, next) => {
    try {
      await saveDidRoute(req, res, null);
    } catch (err) {
      try {
        fail(res, req, err);
      } catch (unhandled) {
        next(unhandled);
      }
    }
  });

  router.put('/admin/did-routes/:didRouteId', async (req, res, next) => {
    try {
      await saveDidRoute(req, res, req.params.didRouteId as string);
    } catch (err) {
      try {
        fail(res, req, err);
      } catch (unhandled) {
        next(unhandled);
      }
    }
  });

  // ── Appearance (single brand) ─────────────────────────────────────────────

  router.get('/admin/tenants/:tenantId/appearance', async (req, res, next) => {
    try {
      res.json({
        appearance: await repos().appearance.getForTenant(req.params.tenantId as string),
      });
    } catch (err) {
      next(err);
    }
  });

  router.put('/admin/tenants/:tenantId/appearance', async (req, res, next) => {
    try {
      const input = parse(appearanceBody, req.body, res, req);
      if (!input) return;
      const tenantId = req.params.tenantId as string;
      await repos().tenants.get(tenantId);
      const appearance = await repos().appearance.save(tenantId, input);
      await audit(req, 'appearance.save', 'appearance', appearance.id as string, tenantId);
      res.json({ appearance });
    } catch (err) {
      try {
        fail(res, req, err);
      } catch (unhandled) {
        next(unhandled);
      }
    }
  });

  // Same-origin validated asset upload: raw PNG/JPEG body, magic-byte
  // checked, content-addressed filename, served from /assets.
  router.post(
    '/admin/tenants/:tenantId/appearance/logo',
    express.raw({ type: ['image/png', 'image/jpeg'], limit: '512kb' }),
    async (req, res, next) => {
      try {
        const tenantId = req.params.tenantId as string;
        await repos().tenants.get(tenantId);
        const body = req.body as Buffer;
        if (!Buffer.isBuffer(body) || body.length === 0) {
          res.status(400).json({
            error: 'validation',
            message: 'Send the image bytes with content-type image/png or image/jpeg',
            correlationId: req.correlationId,
          });
          return;
        }
        const kind = sniffImage(body);
        if (!kind) {
          res.status(400).json({
            error: 'validation',
            message: 'The upload is not a valid PNG or JPEG image',
            correlationId: req.correlationId,
          });
          return;
        }
        const name = `logo-${createHash('sha256').update(body).digest('hex').slice(0, 16)}.${kind}`;
        mkdirSync(config.assetStorageDir, { recursive: true });
        writeFileSync(path.join(config.assetStorageDir, name), body);
        const assetPath = `/assets/${name}`;
        const existing = await repos().appearance.getForTenant(tenantId);
        const appearance = await repos().appearance.save(tenantId, {
          brandName: (existing?.brand_name as string | undefined) || 'Aida',
          primaryColor: (existing?.primary_color as string | null | undefined) ?? null,
          logoAssetPath: assetPath,
        });
        await audit(req, 'appearance.logo_upload', 'appearance', appearance.id as string, tenantId);
        res.status(201).json({ logoAssetPath: assetPath, appearance });
      } catch (err) {
        try {
          fail(res, req, err);
        } catch (unhandled) {
          next(unhandled);
        }
      }
    },
  );

  return router;
}
