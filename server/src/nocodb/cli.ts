/**
 * NocoDB AidaAdmin base schema commands:
 *
 *   npm run nocodb -w server -- create    build the schema in an empty base
 *   npm run nocodb -w server -- validate  drift report (exit 1 on drift)
 *   npm run nocodb -w server -- upgrade   additive apply; never drops/retypes
 *   npm run nocodb -w server -- seed      idempotent dedicated POC records
 *
 * Requires NOCODB_BASE_URL and NOCODB_API_TOKEN in the environment (see
 * .env.example); the base itself is found by name. Values are never printed.
 */
import { loadConfig } from '../config.js';
import { HttpNocoDbApi } from './api.js';
import { AIDA_BASE_NAME, CachedBaseResolver, resolveBaseId } from './base.js';
import { createRepos } from './repos.js';
import { reportDrift, upgradeSchema } from './schema.js';

const SEED_TENANT_SLUG = 'aida-poc-seed';

async function main(): Promise<void> {
  const command = process.argv[2];
  if (!command || !['create', 'validate', 'upgrade', 'seed'].includes(command)) {
    console.error('Usage: nocodb <create|validate|upgrade|seed>');
    process.exit(2);
  }

  const config = loadConfig();
  const { NOCODB_BASE_URL, NOCODB_API_TOKEN } = config.serviceConfig;
  if (!NOCODB_BASE_URL || !NOCODB_API_TOKEN) {
    console.error('Missing NocoDB configuration: NOCODB_BASE_URL, NOCODB_API_TOKEN');
    process.exit(2);
  }
  // The base is addressed by name; its id is discovered here exactly as the
  // server discovers it at startup.
  const api: HttpNocoDbApi = new HttpNocoDbApi(NOCODB_BASE_URL, NOCODB_API_TOKEN, () =>
    resolver.resolve(),
  );
  const resolver = new CachedBaseResolver(() => resolveBaseId(api));
  console.log(`Base ${AIDA_BASE_NAME}: ${await resolver.resolve()}`);

  if (command === 'validate') {
    const drift = await reportDrift(api);
    console.log(JSON.stringify(drift, null, 2));
    process.exit(drift.inSync ? 0 : 1);
  }

  if (command === 'create' || command === 'upgrade') {
    const result = await upgradeSchema(api);
    console.log(JSON.stringify(result, null, 2));
    if (result.typeMismatches.length > 0) {
      console.error('Type mismatches require a human decision; nothing was retyped.');
      process.exit(1);
    }
    return;
  }

  // seed — dedicated, clearly-labeled POC records; safe to run repeatedly.
  const repos = createRepos(api);
  const existing = (await repos.tenants.list()).find((t) => t.slug === SEED_TENANT_SLUG);
  if (existing) {
    console.log(
      `Seed tenant '${SEED_TENANT_SLUG}' already exists (${existing.id}); nothing to do.`,
    );
    return;
  }
  const tenant = await repos.tenants.create({
    name: 'Aida POC Seed Tenant',
    slug: SEED_TENANT_SLUG,
    asteriskContext: 'aida-poc-seed',
    enabled: false,
  });
  const profile = await repos.assistantProfiles.create(tenant.id as string, {
    name: 'Seed Screening Profile',
    businessName: 'Aida POC',
    prompt: 'You are Aida, screening inbound calls for the Aida POC seed tenant.',
    enabled: false,
  });
  console.log(JSON.stringify({ seededTenant: tenant.id, seededProfile: profile.id }, null, 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
