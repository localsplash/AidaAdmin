import { adminApi } from '../api/admin';
import { usePbxInventory } from './usePbxInventory';

const loadInventory = async (tenant: string) => {
  const [dids, queues] = await Promise.all([
    adminApi.listDidRoutes(tenant),
    adminApi.listQueues(tenant),
  ]);
  return {
    ...dids,
    queues: queues.queues,
    provisioningEnabled: dids.provisioningEnabled && queues.provisioningEnabled,
  };
};

export function useNumberRouting(tenantId: string) {
  return usePbxInventory(tenantId, loadInventory);
}
