/** Credential-free test seam. Production login uses central introspection. */
export interface TenantUserDirectory {
  hasEnabledMembership(iUserId: number): Promise<boolean>;
}

/** Denies login when no configured Identity authority exists. */
export class EmptyTenantUserDirectory implements TenantUserDirectory {
  async hasEnabledMembership(_iUserId: number): Promise<boolean> {
    return false;
  }
}
