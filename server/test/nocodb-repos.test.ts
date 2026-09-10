import { beforeEach, describe, expect, it } from 'vitest';
import { ConflictError, NotFoundError, type AidaConfigRepos } from '../src/nocodb/repos.js';
import { AIDA_SCHEMA, upgradeSchema } from '../src/nocodb/schema.js';
import { createRepos } from './helpers/fake-config-repos.js';
import { FakeNocoDbApi } from './helpers/fake-nocodb.js';

let repos: AidaConfigRepos;
beforeEach(async () => {
  const api = new FakeNocoDbApi();
  await upgradeSchema(api);
  repos = createRepos(api);
});
const profile = {
  name: 'Reception',
  businessName: 'Acme',
  prompt: 'Take a message.',
  enabled: true,
};

describe('active business configuration', () => {
  it('keeps only business tables and never bootstraps the removed PBX graph', () => {
    expect(AIDA_SCHEMA.map((table) => table.table_name).sort()).toEqual([
      'aida_tbl_Appearance',
      'aida_tbl_AssistantProfile',
      'aida_tbl_TenantProfile',
    ]);
  });
  it('denies cross-tenant profile reads and writes', async () => {
    const row = await repos.assistantProfiles.create('1', profile);
    await expect(repos.assistantProfiles.get('2', String(row.id))).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(
      repos.assistantProfiles.update('2', String(row.id), 1, {
        ...profile,
        prompt: 'Wrong tenant',
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(await repos.assistantProfiles.listForTenant('2')).toEqual([]);
    expect((await repos.assistantProfiles.get('1', String(row.id))).prompt).toBe(profile.prompt);
  });
  it('rejects a stale profile update without replacing the saved prompt', async () => {
    const row = await repos.assistantProfiles.create('1', profile);
    await repos.assistantProfiles.update('1', String(row.id), 1, { ...profile, prompt: 'Updated' });
    await expect(
      repos.assistantProfiles.update('1', String(row.id), 1, { ...profile, prompt: 'Stale' }),
    ).rejects.toBeInstanceOf(ConflictError);
    expect((await repos.assistantProfiles.get('1', String(row.id))).prompt).toBe('Updated');
  });
});
