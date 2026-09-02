/**
 * "Retry provisioning" (issue #29): re-issue the provisioning call for a
 * record that already exists in NocoDB. Every call here is one OfficePulse
 * treats as idempotent — an extension UPDATE, a ring-group PUT, a DID PUT —
 * so a retry can never mint a second SIP secret; recovering a lost secret
 * is an explicit, separate rotation.
 */

import type { AppDeps } from '../deps.js';
import { NotFoundError, type AidaConfigRepos } from '../nocodb/repos.js';
import type { OfficePulseClient } from './client.js';
import { didPayload, extensionUpdatePayload, ringGroupPayload } from './payloads.js';

export type ProvisionableKind = 'EXTENSION' | 'RING_GROUP' | 'DID';

export interface ReprovisionResult {
  kind: ProvisionableKind;
  externalId: string;
  tenantId: string;
}

/**
 * `tenantId` scopes the lookup: a tenant administrator can only retry their
 * own records, and a record in another tenant is "not found" to them. A
 * Super Admin passes null and may retry any record.
 */
export async function reprovision(
  deps: AppDeps & { repos: AidaConfigRepos; officePulse: OfficePulseClient },
  kind: ProvisionableKind,
  externalId: string,
  tenantId: string | null,
): Promise<ReprovisionResult> {
  const { repos, officePulse } = deps;
  const scope = tenantId ?? undefined;

  switch (kind) {
    case 'EXTENSION': {
      const extension = await repos.store.getById('extension', externalId, scope);
      await officePulse.updateProvisionedExtension(externalId, extensionUpdatePayload(extension));
      return { kind, externalId, tenantId: extension.tenant_id as string };
    }
    case 'RING_GROUP': {
      const group = await repos.store.getById('ring_group', externalId, scope);
      const groupTenant = group.tenant_id as string;
      const members = (await repos.ringGroups.listMembers(groupTenant, externalId)).filter(
        (m) => m.enabled,
      );
      const numbers: string[] = [];
      for (const member of members) {
        const ext = await repos.extensions.get(groupTenant, member.extension_id as string);
        numbers.push(ext.extension_number as string);
      }
      await officePulse.provisionRingGroup(
        externalId,
        ringGroupPayload(groupTenant, group, numbers),
      );
      return { kind, externalId, tenantId: groupTenant };
    }
    case 'DID': {
      const route = await repos.store.getById('did_route', externalId, scope);
      const routeTenant = route.tenant_id as string;
      const tenant = await repos.tenants.get(routeTenant);
      await officePulse.provisionDid(
        externalId,
        didPayload(routeTenant, route, tenant.asterisk_context as string),
      );
      return { kind, externalId, tenantId: routeTenant };
    }
    default:
      throw new NotFoundError(`Unknown provisioning kind ${String(kind)}`);
  }
}
