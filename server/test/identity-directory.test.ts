import { afterEach, describe, expect, it, vi } from 'vitest';
import { UserDirectory } from '../src/directory.js';
import { HttpIdClient } from '../src/id/client.js';
import { identityActor } from '../src/id/context.js';

afterEach(() => vi.unstubAllGlobals());

describe('Identity-only directory', () => {
  it('requires the authenticated actor and sends edits only through Identity', async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          iUserId: 42,
          email: 'pat@example.invalid',
          displayName: 'Patricia',
          claimed: true,
        }),
      ),
    );
    vi.stubGlobal('fetch', fetch);
    const directory = new UserDirectory(
      new HttpIdClient('https://id.example.invalid', 'private-client-secret'),
    );
    await expect(directory.updateDisplayName(42, 'Patricia')).rejects.toThrow(
      'authenticated actor',
    );
    const updated = await identityActor.run({ token: 'central-session' }, () =>
      directory.updateDisplayName(42, 'Patricia'),
    );
    expect(updated.displayName).toBe('Patricia');
    expect(fetch).toHaveBeenCalledOnce();
    expect(String(fetch.mock.calls[0]?.[0])).toBe(
      'https://id.example.invalid/api/directory/users/42',
    );
    const init = fetch.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe('PATCH');
    expect(init.redirect).toBe('error');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer central-session');
    expect(new Headers(init.headers).get('X-Id-Client-Secret')).toBe('private-client-secret');
  });
  it('isolates actor tokens during simultaneous directory calls', async () => {
    const tokens: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init: RequestInit) => {
        tokens.push(new Headers(init.headers).get('authorization')!);
        return new Response(JSON.stringify({ items: [] }));
      }),
    );
    const client = new HttpIdClient('https://id.example.invalid');
    await Promise.all(
      ['one', 'two'].map((token) =>
        identityActor.run({ token }, () => client.searchDirectoryUsers('')),
      ),
    );
    expect(tokens.sort()).toEqual(['Bearer one', 'Bearer two']);
  });
  it('reports an absent Identity service without suggesting a database bypass', async () => {
    const directory = new UserDirectory(null);
    expect(directory.canCreate).toBe(false);
    expect(directory.canEditDisplayName).toBe(false);
    expect(() => directory.search('')).toThrow('ID_BASE_URL');
  });
});
