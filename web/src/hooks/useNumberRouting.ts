import { adminApi } from '../api/admin';
import { usePbxInventory } from './usePbxInventory';

const loadInventory = async (tenant: string, context?: string) => {
  const [dids, queues] = await Promise.all([
    adminApi.listDidRoutes(tenant, context),
    adminApi.listQueues(tenant, context),
  ]);
  return {
    ...dids,
    queues: queues.queues,
    provisioningEnabled: dids.provisioningEnabled && queues.provisioningEnabled,
  };
};

export function useNumberRouting(tenantId: string, context?: string) {
  return usePbxInventory(tenantId, loadInventory, context);
}
