import { beforeEach, describe, expect, it } from 'vitest';
import {
  ConflictError,
  NotFoundError,
  UniqueViolationError,
  type AidaConfigRepos,
} from '../src/nocodb/repos.js';
import { AIDA_SCHEMA, UNIQUE_RULES, upgradeSchema } from '../src/nocodb/schema.js';
import { ValidationError } from '../src/nocodb/validation.js';
import { createRepos } from './helpers/fake-config-repos.js';
import { FakeNocoDbApi } from './helpers/fake-nocodb.js';

let repos: AidaConfigRepos;
let api: FakeNocoDbApi;
beforeEach(async () => {
  api = new FakeNocoDbApi();
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
      'aida_tbl_ProfileAssignment',
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

const assignment = {
  pbxInstanceId: 'officepulse-dev',
  context: 'acme',
  did: '',
  profileId: 'profile-1',
  enabled: true,
};
describe('profile assignments', () => {
  it('is keyed by PBX instance, context and DID with the blank DID as the context default', async () => {
    expect(UNIQUE_RULES.profile_assignment).toEqual([['pbx_instance_id', 'context', 'did']]);
    const first = await repos.profileAssignments.upsert('1', assignment);
    expect(first).toMatchObject({ tenant_id: '1', did: '', revision: 1 });
    const again = await repos.profileAssignments.upsert('1', { ...assignment, profileId: 'p2' });
    expect(again).toMatchObject({ id: first.id, profile_id: 'p2', revision: 2 });
    const specific = await repos.profileAssignments.upsert('1', {
      ...assignment,
      did: '+15105550100',
    });
    expect(specific.id).not.toBe(first.id);
    const elsewhere = await repos.profileAssignments.upsert('2', {
      ...assignment,
      pbxInstanceId: 'officepulse-other',
    });
    expect(elsewhere.id).not.toBe(first.id);
    expect(await repos.profileAssignments.listForTenant('1')).toHaveLength(2);
    // The same key on the same instance belongs to one tenant, blank DID included.
    await expect(repos.profileAssignments.upsert('2', assignment)).rejects.toBeInstanceOf(
      UniqueViolationError,
    );
    await expect(
      repos.store.create('profile_assignment', {
        tenant_id: 1,
        pbx_instance_id: assignment.pbxInstanceId,
        context: 'acme',
        did: '',
        profile_id: 'p3',
        enabled: true,
      }),
    ).rejects.toBeInstanceOf(UniqueViolationError);
  });
  it('normalizes a null DID from NocoDB to the context-default key', async () => {
    const table = api.tableByName('aida_tbl_ProfileAssignment')!;
    await api.createRecord(table.info.id, {
      id: 'row-1',
      created_at: 'x',
      updated_at: 'x',
      revision: 1,
      iTenantId: 1,
      pbx_instance_id: 'officepulse-dev',
      context: 'acme',
      did: null,
      profile_id: 'profile-1',
      enabled: 1,
    });
    expect(await repos.profileAssignments.listForTenant('1')).toEqual([
      expect.objectContaining({ id: 'row-1', did: '', enabled: true }),
    ]);
    const updated = await repos.profileAssignments.upsert('1', { ...assignment, profileId: 'p2' });
    expect(updated).toMatchObject({ id: 'row-1', revision: 2 });
  });
  it('validates the key and profile before writing', async () => {
    for (const bad of [
      { ...assignment, pbxInstanceId: 'bad id' },
      { ...assignment, context: 'a,b' },
      { ...assignment, did: '5105550100' },
      { ...assignment, profileId: ' ' },
    ]) {
      await expect(repos.profileAssignments.upsert('1', bad)).rejects.toBeInstanceOf(
        ValidationError,
      );
    }
    expect(api.tableByName('aida_tbl_ProfileAssignment')!.records).toEqual([]);
  });
  it('deletes only within the owning tenant', async () => {
    const row = await repos.profileAssignments.upsert('1', assignment);
    await expect(repos.profileAssignments.delete('2', row.id as string)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await repos.profileAssignments.delete('1', row.id as string);
    expect(await repos.profileAssignments.listForTenant('1')).toEqual([]);
    await expect(repos.profileAssignments.delete('1', row.id as string)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});
