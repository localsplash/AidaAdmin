/**
 * Consumption boundary for cross-service contracts.
 *
 * Later POC phases generate contract types (NocoDB schema, the OfficePulse
 * provisioning and call-control API) into `generated/`. Application
 * code imports contract types only from this module, so the generated files
 * can land without rewiring imports — and their absence today is fine because
 * the hand-written interim types below cover phase 1.
 */

export interface SessionUserView {
  iUserId: number;
  displayName: string | null;
  email: string | null;
  superAdmin: boolean;
}

export interface TenantContextView {
  tenantId: string;
  name: string;
  slug: string;
  role: 'SUPER_ADMIN' | 'TENANT_ADMIN' | 'USER';
}

export interface SessionView {
  authenticated: boolean;
  user: SessionUserView;
  selectedTenant: TenantContextView | null;
}
