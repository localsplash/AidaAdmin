import type { DirectoryUser, IdClient } from './id/client.js';

export interface DirectoryUserView extends DirectoryUser {
  lastLoginAt?: string | null;
}

export class DirectoryUnavailableError extends Error {
  constructor(
    message: string,
    readonly missing: string[] = [],
  ) {
    super(message);
  }
}

export function userDirectory(sources: { idClient: IdClient | null }): UserDirectory {
  return new UserDirectory(sources.idClient);
}

/** Identity is the sole directory reader/writer. No NocoDB identity source exists. */
export class UserDirectory {
  constructor(private readonly idClient: IdClient | null) {}
  get canEditDisplayName(): boolean {
    return Boolean(this.idClient?.updateDirectoryUser);
  }
  get canCreate(): boolean {
    return this.idClient !== null;
  }
  get available(): boolean {
    return this.idClient !== null;
  }
  private client(): IdClient {
    if (!this.idClient)
      throw new DirectoryUnavailableError('Platform directory requires ID_BASE_URL', [
        'ID_BASE_URL',
      ]);
    return this.idClient;
  }
  search(query: string): Promise<DirectoryUserView[]> {
    return this.client().searchDirectoryUsers(query);
  }
  get(iUserId: number): Promise<DirectoryUserView | null> {
    return this.client().getDirectoryUser(iUserId);
  }
  ensure(email: string, displayName: string | null): Promise<DirectoryUserView> {
    return this.client().ensureDirectoryUser(email, displayName);
  }
  updateDisplayName(iUserId: number, displayName: string | null): Promise<DirectoryUserView> {
    const client = this.client();
    if (!client.updateDirectoryUser)
      throw new DirectoryUnavailableError('Identity directory update API is unavailable', [
        'ID_BASE_URL',
      ]);
    return client.updateDirectoryUser(iUserId, displayName);
  }
}
