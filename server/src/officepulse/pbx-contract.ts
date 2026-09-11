import { z } from 'zod';

/** Canonical /v1/admin/pbx contract; PBX state is owned solely by OfficePulse. */
export const extensionNumber = z.string().regex(/^[0-9]{2,12}$/);
export const nativeName = z.string().regex(/^[a-zA-Z0-9_.-]{1,80}$/);
export const contextName = z.string().regex(/^[a-zA-Z0-9_.-]{1,40}$/);
export const e164 = z.string().regex(/^\+[1-9][0-9]{6,14}$/);
export const queueStrategy = z.enum([
  'ringall',
  'leastrecent',
  'fewestcalls',
  'random',
  'rrmemory',
  'linear',
  'wrandom',
]);
const days = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const weekdayPattern =
  /^(sun|mon|tue|wed|thu|fri|sat)(-(sun|mon|tue|wed|thu|fri|sat))?(&(sun|mon|tue|wed|thu|fri|sat)(-(sun|mon|tue|wed|thu|fri|sat))?)*$/;
export const weekdays = z
  .string()
  .max(128)
  .regex(weekdayPattern)
  .transform((value) => {
    const included = new Set<string>();
    for (const term of value.split('&')) {
      const [first, last = first] = term.split('-');
      let index = days.indexOf(first!);
      const end = days.indexOf(last!);
      for (;;) {
        included.add(days[index]!);
        if (index === end) break;
        index = (index + 1) % days.length;
      }
    }
    return days.filter((day) => included.has(day)).join('&');
  });
export const timezone = z
  .string()
  .max(64)
  .regex(/^(UTC|[A-Za-z0-9_+.-]+(?:\/[A-Za-z0-9_+.-]+)+)$/)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }, 'Choose a valid IANA timezone');
export const schedule = z
  .object({
    timeRange: z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]-([01][0-9]|2[0-3]):[0-5][0-9]$/),
    weekdays,
    timezone,
  })
  .strict();
export const createExtensionBody = z
  .object({
    extension: extensionNumber,
    displayName: z
      .string()
      .min(1)
      .max(33)
      .refine(
        (value) =>
          !/["<>\\]/.test(value) &&
          [...value].every(
            (character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
          ),
        'Display name contains unsupported characters',
      )
      .optional(),
    callerIdNumber: e164.optional(),
    context: contextName.optional(),
  })
  .strict()
  .superRefine((body, ctx) => {
    if (
      body.displayName &&
      body.displayName.length + (body.callerIdNumber ?? body.extension).length + 5 > 40
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['displayName'],
        message: 'Display name and caller ID exceed the native 40-character limit',
      });
    }
  });
export const createQueueBody = z
  .object({
    name: nativeName,
    strategy: queueStrategy.optional(),
  })
  .strict();
export const memberBody = z
  .object({
    penalty: z.number().int().min(0).max(100).optional(),
    paused: z.boolean().optional(),
    context: contextName.optional(),
  })
  .strict();
export const didBody = z
  .object({
    queue: nativeName,
    ringsBeforeAi: z.number().int().min(1).max(12),
    schedule: schedule.nullish(),
    livekitDestination: e164.optional(),
  })
  .strict();
export type CreateExtension = z.infer<typeof createExtensionBody>;
export type CreateQueue = z.infer<typeof createQueueBody>;
export type QueueMemberInput = z.infer<typeof memberBody>;
export type DidSettings = z.infer<typeof didBody>;

const applyState = z.enum(['committed', 'active', 'unknown']);
const inventory = {
  source: z.literal('asterisk'),
  iTenantId: z.number().int().positive(),
  provisioningEnabled: z.boolean(),
};
// Response schemas strip unknown properties, so inventories cannot accidentally
// disclose future secret-bearing fields returned by an upstream deployment.
export const extensionInventory = z.object({
  ...inventory,
  contexts: z.array(contextName),
  extensions: z.array(
    z.object({
      id: z.string(),
      extension: extensionNumber.nullish(),
      context: z.string(),
      callerId: z.string().nullable(),
      transport: z.string().nullable(),
      aors: z.string().nullable(),
      applyState,
    }),
  ),
});
export const extensionCreated = z.object({
  extension: extensionNumber,
  sipUsername: z.string().min(1),
  sipSecret: z.string().min(1),
  applyState,
});
export const queueInventory = z.object({
  ...inventory,
  queues: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      strategy: z.string().nullable(),
      applyState,
      members: z.array(
        z.object({
          interface: z.string(),
          memberName: z.string().nullable(),
          penalty: z.number(),
          paused: z.boolean(),
        }),
      ),
    }),
  ),
});
export const queueCreated = z.object({ name: nativeName, strategy: queueStrategy, applyState });
export const memberSaved = z.object({
  queue: nativeName,
  extension: extensionNumber,
  penalty: z.number(),
  paused: z.boolean(),
  applyState,
});
export const managedDid = z.object({
  did: e164,
  managed: z.literal(true),
  queue: nativeName,
  ringsBeforeAi: z.number().int(),
  schedule: schedule.nullish(),
  livekitDestination: e164,
  ringTimeoutSeconds: z.number().int(),
  applyState,
});
export const didInventory = z.object({
  ...inventory,
  dids: z.array(
    z.discriminatedUnion('managed', [
      managedDid,
      z.object({
        did: e164,
        managed: z.literal(false),
        availability: z.enum(['unconfigured', 'manual']),
        applyState,
      }),
    ]),
  ),
});
export type ExtensionInventory = z.infer<typeof extensionInventory>;
export type ExtensionCreated = z.infer<typeof extensionCreated>;
export type QueueInventory = z.infer<typeof queueInventory>;
export type QueueCreated = z.infer<typeof queueCreated>;
export type MemberSaved = z.infer<typeof memberSaved>;
export type ManagedDid = z.infer<typeof managedDid>;
export type DidInventory = z.infer<typeof didInventory>;
