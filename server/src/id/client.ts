/**
 * Server-to-server client for the `id` identity service (normative
 * specification §2.1). Trust is TLS plus source-IPv4 allowlisting enforced by
 * `id` (ID_TRUSTED_APP_CIDRS); there is deliberately no ID_CLIENT_SECRET,
 * webhook HMAC, or password handling in this repository.
 */

export interface IdIdentity {
  provider: string;
  subject: string;
  email?: string | null;
}

export interface IdRedeemResult {
  user: {
    iUserId: number;
    email: string | null;
    displayName: string | null;
    /** Session-scoped value computed by id; never recalculated locally. */
    superAdmin: boolean;
  };
  identity: IdIdentity;
  identities: IdIdentity[];
}

export interface IdEvent {
  id: number;
  type: 'ping' | 'session.revoked' | 'user.merged' | 'identity.linked' | 'identity.unlinked';
  occurredAt: string;
  data: Record<string, unknown>;
}

export interface IdClient {
  redeemCode(code: string, redirectUri: string): Promise<IdRedeemResult>;
  listEvents(since: number): Promise<IdEvent[]>;
  registerWebhook(name: string, webhookUrl: string): Promise<void>;
  /** Idempotent create/locate in the central directory (CIDR-trusted). */
  ensureDirectoryUser(
    email: string,
    displayName?: string | null,
    idempotencyKey?: string | null,
  ): Promise<DirectoryUser>;
  getDirectoryUser(iUserId: number): Promise<DirectoryUser | null>;
  searchDirectoryUsers(query: string, limit?: number): Promise<DirectoryUser[]>;
}

/**
 * Minimal central-directory view (id's /api/directory/users*): never
 * identities, sessions, or credentials.
 */
export interface DirectoryUser {
  iUserId: number;
  email: string | null;
  displayName: string | null;
  claimed: boolean;
}

export class IdClientError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export class HttpIdClient implements IdClient {
  constructor(private readonly baseUrl: string) {}

  private async request(path: string, init?: RequestInit): Promise<unknown> {
    const res = await fetch(new URL(path, this.baseUrl), init);
    if (!res.ok) {
      // Do not include the response body: it is not ours to log.
      throw new IdClientError(`id request ${path} failed`, res.status);
    }
    return res.json();
  }

  async redeemCode(code: string, redirectUri: string): Promise<IdRedeemResult> {
    const body = await this.request('/api/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, redirect_uri: redirectUri }),
    });
    return body as IdRedeemResult;
  }

  async listEvents(since: number): Promise<IdEvent[]> {
    // id's contract (src/app.ts GET /api/events): { items: [...] }.
    const body = (await this.request(`/api/events?since=${since}`)) as { items?: IdEvent[] };
    return body.items ?? [];
  }

  async ensureDirectoryUser(
    email: string,
    displayName?: string | null,
    idempotencyKey?: string | null,
  ): Promise<DirectoryUser> {
    return (await this.request('/api/directory/users', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, displayName, idempotencyKey }),
    })) as DirectoryUser;
  }

  async getDirectoryUser(iUserId: number): Promise<DirectoryUser | null> {
    try {
      return (await this.request(`/api/directory/users/${iUserId}`)) as DirectoryUser;
    } catch (err) {
      if (err instanceof IdClientError && err.status === 404) return null;
      throw err;
    }
  }

  async searchDirectoryUsers(query: string, limit = 25): Promise<DirectoryUser[]> {
    const params = new URLSearchParams({ query, limit: String(limit) });
    const body = (await this.request(`/api/directory/users?${params}`)) as {
      items?: DirectoryUser[];
      list?: DirectoryUser[];
    };
    return body.items ?? body.list ?? [];
  }

  async registerWebhook(name: string, webhookUrl: string): Promise<void> {
    await this.request('/api/apps/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, webhook_url: webhookUrl }),
    });
  }
}
