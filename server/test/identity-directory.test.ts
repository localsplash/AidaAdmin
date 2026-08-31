import { describe, expect, it } from 'vitest';
import { UserDirectory } from '../src/directory.js';
import type { DirectoryUser, IdClient, IdEvent, IdRedeemResult } from '../src/id/client.js';
import {
  BaseResolutionError,
  IDENTITY_BASE_NAME,
  resolveIdentityBaseId,
} from '../src/nocodb/base.js';
import { IDENTITY_USER_TABLE, NocoIdentityStore } from '../src/nocodb/identity.js';
import { FakeNocoDbApi } from './helpers/fake-nocodb.js';

const USER_COLUMNS = ['iUserId', 'email', 'displayName', 'dtCreated', 'dtLastLogin'];

async function identityApi(rows: Array<Record<string, unknown>>): Promise<FakeNocoDbApi> {
  const api = new FakeNocoDbApi();
  await api.seedTable(IDENTITY_USER_TABLE, USER_COLUMNS, rows);
  return api;
}

const PAT = {
  iUserId: 42,
  email: 'pat@example.invalid',
  displayName: 'Pat',
  dtCreated: '2026-01-01T00:00:00.000Z',
  dtLastLogin: '2026-02-01T00:00:00.000Z',
};
const SAM = {
  iUserId: 43,
  email: 'sam@example.invalid',
  displayName: null,
  dtCreated: '2026-01-02T00:00:00.000Z',
  dtLastLogin: null,
};

describe('identity base resolution', () => {
  it('finds the base by name whatever its capitalisation', async () => {
    const api = new FakeNocoDbApi();
    api.bases = [
      { id: 'b-1', title: 'AidaAdmin' },
      { id: 'b-7', title: 'aidaIDENTITY' },
    ];
    expect(await resolveIdentityBaseId(api)).toBe('b-7');
  });

  it('never creates the base, because it is a view onto id, not ours', async () => {
    const api = new FakeNocoDbApi();
    api.bases = [{ id: 'b-1', title: 'AidaAdmin' }];
    await expect(resolveIdentityBaseId(api)).rejects.toBeInstanceOf(BaseResolutionError);
    await expect(resolveIdentityBaseId(api)).rejects.toThrow(
      new RegExp(`No NocoDB base named ${IDENTITY_BASE_NAME} exists`),
    );
    expect(api.createdBases).toEqual([]);
  });
});

describe('NocoIdentityStore', () => {
  it('reads platform users, newest first, with sign-in state', async () => {
    const store = new NocoIdentityStore(await identityApi([PAT, SAM]));
    const users = await store.list();
    expect(users.map((u) => u.iUserId)).toEqual([43, 42]);
    expect(users[0]).toMatchObject({ email: 'sam@example.invalid', claimed: false });
    // dtLastLogin stands in for id's `claimed`: both move at first sign-in.
    expect(users[1]).toMatchObject({ displayName: 'Pat', claimed: true });
  });

  it('filters on email or display name, ignoring case', async () => {
    const store = new NocoIdentityStore(await identityApi([PAT, SAM]));
    expect((await store.list('PAT')).map((u) => u.iUserId)).toEqual([42]);
    expect((await store.list('sam@')).map((u) => u.iUserId)).toEqual([43]);
    expect(await store.list('nobody')).toEqual([]);
  });

  it('reads columns whatever case NocoDB surfaces them in', async () => {
    const api = new FakeNocoDbApi();
    await api.seedTable(
      IDENTITY_USER_TABLE,
      ['iuserid', 'Email', 'displayname', 'dtcreated', 'dtlastlogin'],
      [{ iuserid: 7, Email: 'lee@example.invalid', displayname: 'Lee', dtlastlogin: null }],
    );
    const user = await new NocoIdentityStore(api).get(7);
    expect(user).toMatchObject({ iUserId: 7, email: 'lee@example.invalid', displayName: 'Lee' });
  });

  it('writes a display name back through the record own key', async () => {
    const api = await identityApi([PAT]);
    const store = new NocoIdentityStore(api);
    const updated = await store.updateDisplayName(42, 'Patricia');
    expect(updated.displayName).toBe('Patricia');
    expect(api.tableByName(IDENTITY_USER_TABLE)!.records[0]!.displayName).toBe('Patricia');
    // Nothing else about the person is touched.
    expect(api.tableByName(IDENTITY_USER_TABLE)!.records[0]!.email).toBe('pat@example.invalid');
  });

  it('says what an operator must do when the table is not there', async () => {
    const store = new NocoIdentityStore(new FakeNocoDbApi());
    await expect(store.list()).rejects.toThrow(new RegExp(IDENTITY_USER_TABLE));
  });
});

class StubIdClient implements IdClient {
  ensured: Array<{ email: string; displayName: string | null }> = [];
  searched: string[] = [];

  async redeemCode(): Promise<IdRedeemResult> {
    throw new Error('unused');
  }
  async listEvents(): Promise<IdEvent[]> {
    return [];
  }
  async registerWebhook(): Promise<void> {}
  async ensureDirectoryUser(email: string, displayName?: string | null): Promise<DirectoryUser> {
    this.ensured.push({ email, displayName: displayName ?? null });
    return { iUserId: 99, email, displayName: displayName ?? null, claimed: false };
  }
  async getDirectoryUser(): Promise<DirectoryUser | null> {
    return { iUserId: 1, email: 'from-id@example.invalid', displayName: null, claimed: true };
  }
  async searchDirectoryUsers(query: string): Promise<DirectoryUser[]> {
    this.searched.push(query);
    return [{ iUserId: 1, email: 'from-id@example.invalid', displayName: null, claimed: true }];
  }
}

describe('UserDirectory', () => {
  it('reads from NocoDB when the identity base is connected', async () => {
    const idClient = new StubIdClient();
    const directory = new UserDirectory(new NocoIdentityStore(await identityApi([PAT])), idClient);
    expect((await directory.search('')).map((u) => u.iUserId)).toEqual([42]);
    expect(idClient.searched).toEqual([]);
    expect(directory.canEditDisplayName).toBe(true);
  });

  it('falls back to id when the identity base is not connected', async () => {
    const idClient = new StubIdClient();
    const directory = new UserDirectory(null, idClient);
    expect((await directory.search('a')).map((u) => u.iUserId)).toEqual([1]);
    expect(idClient.searched).toEqual(['a']);
    expect(directory.canEditDisplayName).toBe(false);
  });

  it('always creates through id, never by inserting into the identity base', async () => {
    const idClient = new StubIdClient();
    const api = await identityApi([PAT]);
    const directory = new UserDirectory(new NocoIdentityStore(api), idClient);
    const created = await directory.ensure('new@example.invalid', 'New');
    expect(created.iUserId).toBe(99);
    // id owns email uniqueness; the identity table is untouched by a create.
    expect(idClient.ensured).toEqual([{ email: 'new@example.invalid', displayName: 'New' }]);
    expect(api.tableByName(IDENTITY_USER_TABLE)!.records).toHaveLength(1);
  });

  it('names what is missing rather than failing opaquely', async () => {
    const noNocoDb = new UserDirectory(null, new StubIdClient());
    await expect(noNocoDb.updateDisplayName(42, 'X')).rejects.toThrow(/AidaIdentity/);

    const noId = new UserDirectory(new NocoIdentityStore(await identityApi([PAT])), null);
    await expect(noId.ensure('a@example.invalid', null)).rejects.toThrow(/ID_BASE_URL/);

    const neither = new UserDirectory(null, null);
    await expect(neither.search('')).rejects.toThrow(/AidaIdentity|ID_BASE_URL/);
  });
});
