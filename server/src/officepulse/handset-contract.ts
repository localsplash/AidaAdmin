import { z } from 'zod';
import { contextName, instanceId } from './pbx-contract.js';

export const deviceId = z.string().uuid();
export const handset = z.object({
  id: deviceId,
  pbxInstanceId: instanceId,
  context: contextName,
  endpointId: z.string().min(1),
  extension: z.string().nullable(),
  label: z.string().nullable(),
  // Older OfficePulse versions omit the stored model from their admin DTO.
  deviceModel: z.string().optional(),
  mac: z.string().nullable(),
  publicIp: z.string(),
  localIp: z.string(),
  attachedAt: z.string(),
  lastSeenAt: z.string(),
  appVersion: z.string(),
  revokedAt: z.string().nullable(),
});
export const handsetInventory = z.object({ handsets: z.array(handset) });
export const handsetRevoked = z.object({ status: z.literal('revoked') });
export type Handset = z.infer<typeof handset>;
export type HandsetInventory = z.infer<typeof handsetInventory>;
