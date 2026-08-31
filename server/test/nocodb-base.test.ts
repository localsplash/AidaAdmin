import { describe, expect, it } from 'vitest';
import {
  AIDA_BASE_NAME,
  BaseResolutionError,
  CachedBaseResolver,
  resolveBaseId,
} from '../src/nocodb/base.js';
import { FakeNocoDbApi } from './helpers/fake-nocodb.js';

describe('base resolution by name', () => {
  it('finds the base regardless of how it was capitalised', async () => {
    const api = new FakeNocoDbApi();
    api.bases = [{ id: 'b-9', title: 'aidaadmin' }];
    expect(await resolveBaseId(api)).toBe('b-9');

    api.bases = [{ id: 'b-10', title: '  AIDAADMIN ' }];
    expect(await resolveBaseId(api)).toBe('b-10');
  });

  it('ignores other bases in the instance', async () => {
    const api = new FakeNocoDbApi();
    api.bases = [
      { id: 'b-1', title: 'id' },
      { id: 'b-2', title: AIDA_BASE_NAME },
      { id: 'b-3', title: 'AidaAdminArchive' },
    ];
    expect(await resolveBaseId(api)).toBe('b-2');
  });

  it('creates the base when the instance has none', async () => {
    const api = new FakeNocoDbApi();
    api.bases = [];
    const id = await resolveBaseId(api);
    expect(api.createdBases).toEqual([AIDA_BASE_NAME]);
    expect(id).toBeTruthy();
  });

  it('refuses to guess between duplicates', async () => {
    const api = new FakeNocoDbApi();
    api.bases = [
      { id: 'b-1', title: 'AidaAdmin' },
      { id: 'b-2', title: 'aidaadmin' },
    ];
    await expect(resolveBaseId(api)).rejects.toBeInstanceOf(BaseResolutionError);
    await expect(resolveBaseId(api)).rejects.toThrow(/b-1, b-2/);
  });

  it('explains how to recover when creation is not permitted', async () => {
    const api = new FakeNocoDbApi();
    api.bases = [];
    api.refuseBaseCreation = true;
    await expect(resolveBaseId(api)).rejects.toThrow(/Create a base named AidaAdmin/);
  });
});

describe('CachedBaseResolver', () => {
  it('resolves once and reuses the answer', async () => {
    let calls = 0;
    const resolver = new CachedBaseResolver(async () => {
      calls += 1;
      return 'b-1';
    });
    const [a, b] = await Promise.all([resolver.resolve(), resolver.resolve()]);
    expect([a, b, await resolver.resolve()]).toEqual(['b-1', 'b-1', 'b-1']);
    expect(calls).toBe(1);
    expect(resolver.baseId).toBe('b-1');
  });

  it('does not cache a failure, so an outage at boot is retried', async () => {
    let calls = 0;
    const resolver = new CachedBaseResolver(async () => {
      calls += 1;
      if (calls === 1) throw new Error('NocoDB unreachable');
      return 'b-2';
    });
    await expect(resolver.resolve()).rejects.toThrow('NocoDB unreachable');
    expect(resolver.baseId).toBeNull();
    expect(await resolver.resolve()).toBe('b-2');
  });
});
