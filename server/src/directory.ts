/**
 * The central user directory as AidaAdmin sees it.
 *
 * There is exactly one platform person record (`id_tbl_User.iUserId`) and
 * AidaAdmin never copies it. What differs is which door it reaches that
 * record through, and the two doors are not interchangeable:
 *
 * - Reads (list, search, get) go to the NocoDB `AidaIdentity` base, which
 *   exposes id's MySQL directly. It returns the whole directory in one call
 *   rather than id's keyset-paged search, and it keeps working when id's
 *   HTTP API is unreachable. id's API is the fallback when that base is not
 *   connected.
 * - Editing a display name only exists here: id publishes no endpoint that
 *   updates a user, so this write has to go through NocoDB.
 * - Creating a user by email always goes to id's ensure endpoint. That is
 *   where the email-uniqueness advisory lock and the idempotency-key table
 *   live; inserting a row through NocoDB instead would trade a real
 *   guarantee for a race that produces duplicate people.
 */

import type { IdClient } from './id/client.js';
import type { IdentityUser, NocoIdentityStore } from './nocodb/identity.js';

export interface DirectoryUserView {
  iUserId: number;
  email: string | null;
  displayName: string | null;
  /** True once the person has signed in through the identity service. */
  claimed: boolean;
  lastLoginAt?: string | null;
}

/** Raised when the door a request needs is not connected in this deployment. */
export class DirectoryUnavailableError extends Error {
  constructor(
    message: string,
    readonly missing: string[] = [],
  ) {
    super(message);
  }
}

const NO_SOURCE = new DirectoryUnavailableError(
  'No user directory is reachable: connect the id MySQL database to NocoDB as a base ' +
    'named AidaIdentity, or set ID_BASE_URL.',
  ['AidaIdentity base', 'ID_BASE_URL'],
);

function fromIdentity(user: IdentityUser): DirectoryUserView {
  return {
    iUserId: user.iUserId,
    email: user.email,
    displayName: user.displayName,
    claimed: user.claimed,
    lastLoginAt: user.lastLoginAt,
  };
}

/**
 * Built from the two sources rather than stored beside them, so a
 * deployment (or a test) that swaps one out cannot leave a directory behind
 * that still points at the old one.
 */
export function userDirectory(sources: {
  identityStore: NocoIdentityStore | null;
  idClient: IdClient | null;
}): UserDirectory {
  return new UserDirectory(sources.identityStore, sources.idClient);
}

export class UserDirectory {
  constructor(
    private readonly identity: NocoIdentityStore | null,
    private readonly idClient: IdClient | null,
  ) {}

  /** Display names are editable only through the NocoDB identity base. */
  get canEditDisplayName(): boolean {
    return this.identity !== null;
  }

  /** True when a user can be created by email (id's ensure endpoint). */
  get canCreate(): boolean {
    return this.idClient !== null;
  }

  get available(): boolean {
    return this.identity !== null || this.idClient !== null;
  }

  async search(query: string): Promise<DirectoryUserView[]> {
    if (this.identity) return (await this.identity.list(query)).map(fromIdentity);
    if (this.idClient) return this.idClient.searchDirectoryUsers(query);
    throw NO_SOURCE;
  }

  async get(iUserId: number): Promise<DirectoryUserView | null> {
    if (this.identity) {
      const user = await this.identity.get(iUserId);
      return user ? fromIdentity(user) : null;
    }
    if (this.idClient) return this.idClient.getDirectoryUser(iUserId);
    throw NO_SOURCE;
  }

  async ensure(email: string, displayName: string | null): Promise<DirectoryUserView> {
    if (!this.idClient) {
      throw new DirectoryUnavailableError(
        'Creating a platform user requires the identity service: set ID_BASE_URL. ' +
          'The email-uniqueness guarantee lives there, so users are never inserted ' +
          'into the identity database directly.',
        ['ID_BASE_URL'],
      );
    }
    return this.idClient.ensureDirectoryUser(email, displayName);
  }

  async updateDisplayName(iUserId: number, displayName: string | null): Promise<DirectoryUserView> {
    if (!this.identity) {
      throw new DirectoryUnavailableError(
        'Editing a display name requires the NocoDB AidaIdentity base: the identity ' +
          'service publishes no endpoint that updates a user.',
        ['AidaIdentity base'],
      );
    }
    return fromIdentity(await this.identity.updateDisplayName(iUserId, displayName));
  }
}
