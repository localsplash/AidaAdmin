import { describe, expect, it } from 'vitest';
import { HttpNocoDbApi } from '../src/nocodb/api.js';
import { resolveBaseId } from '../src/nocodb/base.js';
import { NocoStore } from '../src/nocodb/repos.js';
import { reportDrift, upgradeSchema } from '../src/nocodb/schema.js';

// Separate explicit test credentials prevent an ambient production environment
// from creating fixture records in a live PlatformConfig base.
const configured = process.env.NOCODB_TEST_BASE_URL && process.env.NOCODB_TEST_API_TOKEN;
describe.skipIf(!configured)('NocoDB integration', () => {
  it('stores a voice profile using platform tenant references', async () => {
    const api: HttpNocoDbApi = new HttpNocoDbApi(
      process.env.NOCODB_TEST_BASE_URL!,
      process.env.NOCODB_TEST_API_TOKEN!,
      () => resolveBaseId(api),
    );
    await upgradeSchema(api);
    expect((await reportDrift(api)).inSync).toBe(true);
    const store = new NocoStore(api);
    const profile = await store.create('assistant_profile', {
      tenant_id: '987654321',
      name: `Integration ${Date.now()}`,
      business_name: 'Test fixture',
      prompt: 'Test',
      enabled: false,
    });
    const read = await store.getById('assistant_profile', profile.id as string, '987654321');
    expect(read.tenant_id).toBe('987654321');
    await expect(
      store.getById('assistant_profile', profile.id as string, '987654322'),
    ).rejects.toThrow();
  });
});
