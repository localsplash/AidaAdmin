import { describe, expect, it, beforeAll } from 'vitest';
import { HttpNocoDbApi } from '../src/nocodb/api.js';
import { createRepos, type AidaConfigRepos } from '../src/nocodb/repos.js';
import { reportDrift, upgradeSchema } from '../src/nocodb/schema.js';

/**
 * Exercises the actual NocoDB AidaConfiguration base with dedicated,
 * clearly-labeled records. Runs only when the non-production NocoDB
 * credentials are configured (NOCODB_BASE_URL, NOCODB_API_TOKEN,
 * NOCODB_BASE_ID); unit tests never need them.
 */
const configured =
  process.env.NOCODB_BASE_URL && process.env.NOCODB_API_TOKEN && process.env.NOCODB_BASE_ID;

const SLUG = `it-${Date.now().toString(36)}`;

describe.skipIf(!configured)('NocoDB integration', () => {
  let repos: AidaConfigRepos;

  beforeAll(async () => {
    const api = new HttpNocoDbApi(
      process.env.NOCODB_BASE_URL as string,
      process.env.NOCODB_API_TOKEN as string,
      process.env.NOCODB_BASE_ID as string,
    );
    await upgradeSchema(api);
    expect((await reportDrift(api)).inSync).toBe(true);
    repos = createRepos(api);
  });

  it('creates, reads, updates, and revision-checks a dedicated tenant record', async () => {
    const tenant = await repos.tenants.create({
      name: `Integration Test Tenant ${SLUG}`,
      slug: SLUG,
      asteriskContext: SLUG,
      enabled: false,
    });
    const read = await repos.tenants.get(tenant.id as string);
    expect(read.slug).toBe(SLUG);

    const updated = await repos.tenants.update(tenant.id as string, 1, {
      name: `Integration Test Tenant ${SLUG} (updated)`,
      slug: SLUG,
      asteriskContext: SLUG,
      enabled: false,
    });
    expect(updated.revision).toBe(2);

    await expect(
      repos.tenants.update(tenant.id as string, 1, {
        name: 'stale',
        slug: SLUG,
        asteriskContext: SLUG,
        enabled: false,
      }),
    ).rejects.toThrow();
  });
});
