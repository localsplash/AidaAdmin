/**
 * Authorization lookup for non-Super-Admin logins: does this id user have at
 * least one enabled `tenant_user` record?
 */
export interface TenantUserDirectory {
  hasEnabledMembership(iUserId: number): Promise<boolean>;
}

/**
 * Until phase 3 lands the NocoDB `tenant_user` repository there are no
 * tenant mappings, so every non-Super-Admin is denied — exactly the POC rule
 * ("a non-Super-Admin with no enabled tenant_user record is denied").
 */
export class EmptyTenantUserDirectory implements TenantUserDirectory {
  async hasEnabledMembership(_iUserId: number): Promise<boolean> {
    return false;
  }
}
