/** Explicit schema bootstrap; runtime never creates or changes PlatformConfig. */
import { HttpNocoDbApi } from './api.js';
import { AIDA_BASE_NAME, CachedBaseResolver, resolveBaseId } from './base.js';
import { reportDrift, upgradeSchema } from './schema.js';

async function main(): Promise<void> {
  const command = process.argv[2];
  if (!command || !['create', 'validate', 'upgrade'].includes(command)) {
    throw new Error(
      'Usage: nocodb <create|validate|upgrade>. Create businesses through Identity/AidaAdmin after bootstrap.',
    );
  }
  const { NOCODB_BASE_URL, NOCODB_API_TOKEN } = process.env;
  if (!NOCODB_BASE_URL || !NOCODB_API_TOKEN)
    throw new Error('Set NOCODB_BASE_URL and NOCODB_API_TOKEN');
  const api: HttpNocoDbApi = new HttpNocoDbApi(NOCODB_BASE_URL, NOCODB_API_TOKEN, () =>
    resolver.resolve(),
  );
  const resolver = new CachedBaseResolver(() => resolveBaseId(api, command === 'create'));
  console.log(`Base ${AIDA_BASE_NAME}: ${await resolver.resolve()}`);
  if (command === 'validate') {
    const drift = await reportDrift(api);
    console.log(JSON.stringify(drift, null, 2));
    process.exitCode = drift.inSync ? 0 : 1;
    return;
  }
  const result = await upgradeSchema(api);
  console.log(JSON.stringify(result, null, 2));
  if (result.typeMismatches.length) process.exitCode = 1;
}
main().catch((err) => {
  console.error(err instanceof Error ? err.message : 'Schema command failed');
  process.exitCode = 1;
});
