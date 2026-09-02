/**
 * The one place an AidaAdmin record becomes an OfficePulse provisioning
 * payload. The admin routes use these when a record is saved and the
 * runtime "retry provisioning" action uses them again later, so the two
 * can never drift apart.
 */

import type { NocoRecord } from '../nocodb/api.js';
import type {
  ProvisionDidRequest,
  ProvisionExtensionRequest,
  ProvisionRingGroupRequest,
  UpdateExtensionRequest,
} from './client.js';

function text(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

export function extensionCreatePayload(
  extension: NocoRecord,
  tenantId: string,
): ProvisionExtensionRequest {
  return {
    requestId: extension.id as string,
    tenantId,
    extensionId: extension.id as string,
    extensionNumber: extension.extension_number as string,
    context: extension.asterisk_context as string,
    displayName: extension.display_name as string,
    callerIdName: text(extension.caller_id_name),
    callerIdNumber: text(extension.caller_id_number),
    provisioningProfile: text(extension.provisioning_profile),
  };
}

export function extensionUpdatePayload(extension: NocoRecord): UpdateExtensionRequest {
  return {
    extensionNumber: extension.extension_number as string,
    context: extension.asterisk_context as string,
    displayName: extension.display_name as string,
    callerIdName: text(extension.caller_id_name),
    callerIdNumber: text(extension.caller_id_number),
    provisioningProfile: text(extension.provisioning_profile),
    enabled: Boolean(extension.enabled),
  };
}

export function ringGroupPayload(
  tenantId: string,
  group: NocoRecord,
  memberExtensionNumbers: string[],
): ProvisionRingGroupRequest {
  return {
    tenantId,
    virtualExtension: group.virtual_extension as string,
    context: group.asterisk_context as string,
    memberExtensions: memberExtensionNumbers,
    ringTimeoutSeconds: Number(group.ring_timeout_seconds ?? 20),
    musicOnHoldClass: text(group.music_on_hold_class),
    callerIdName: text(group.caller_id_name),
    callerIdNumber: text(group.caller_id_number),
    enabled: Boolean(group.enabled),
  };
}

/**
 * Inbound order is DID -> disclosure -> screening -> destination; the
 * realtime dialplan rows send the DID to the FastAGI bootstrap. The
 * destination travels too, so OfficePulse can route this DID's caller to
 * this DID's own destination when the cloud is unavailable.
 */
export function didPayload(
  tenantId: string,
  route: NocoRecord,
  context: string,
): ProvisionDidRequest {
  const destinationType = route.destination_type as 'EXTENSION' | 'RING_GROUP';
  return {
    didE164: route.did_e164 as string,
    context,
    fastAgiPath: '/bootstrap',
    enabled: Boolean(route.enabled),
    tenantId,
    destinationType,
    destinationId:
      destinationType === 'EXTENSION'
        ? (route.destination_extension_id as string)
        : (route.destination_ring_group_id as string),
  };
}
