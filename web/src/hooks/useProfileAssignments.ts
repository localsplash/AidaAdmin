import { adminApi } from '../api/admin';
import { usePbxInventory } from './usePbxInventory';

/** Stored assignments with the enabled profiles they may name; loads independently of PBX inventory. */
const loadAssignments = async (tenant: string) => {
  const [inventory, profiles] = await Promise.all([
    adminApi.listProfileAssignments(tenant),
    adminApi.listProfiles(tenant),
  ]);
  return { ...inventory, profiles: profiles.profiles.filter((profile) => profile.enabled) };
};

export function useProfileAssignments(tenantId: string) {
  return usePbxInventory(tenantId, loadAssignments);
}
