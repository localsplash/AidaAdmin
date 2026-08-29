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

export type SessionState =
  | { kind: 'loading' }
  | { kind: 'unauthenticated' }
  | { kind: 'forbidden' }
  | { kind: 'error' }
  | { kind: 'authenticated'; session: SessionView };

function readCsrfCookie(): string {
  const match = /(?:^|;\s*)aida\.csrf=([^;]+)/.exec(document.cookie);
  return match?.[1] ?? '';
}

/** Revokes the local AidaAdmin session; resolves whether or not it succeeds. */
export async function logout(): Promise<void> {
  try {
    await fetch('/api/auth/logout', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'x-csrf-token': readCsrfCookie() },
    });
  } catch {
    // The caller re-fetches the session either way.
  }
}

export async function fetchSession(): Promise<SessionState> {
  try {
    const res = await fetch('/api/session', { credentials: 'same-origin' });
    if (res.status === 401) return { kind: 'unauthenticated' };
    if (res.status === 403) return { kind: 'forbidden' };
    if (!res.ok) return { kind: 'error' };
    const session = (await res.json()) as SessionView;
    return { kind: 'authenticated', session };
  } catch {
    return { kind: 'error' };
  }
}
