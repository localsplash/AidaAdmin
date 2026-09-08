import { ConfigError, loadConfig, SERVICE_ENV_VARS, type AppConfig } from './config.js';
import { HttpNocoDbApi, type NocoDbApi, type NocoRecord } from './nocodb/api.js';
import { resolveBaseId } from './nocodb/base.js';

const SCOPES = ['aida-admin', 'aida', '*'];

/** Deterministic settings: environment > service > voice > global. Blank is unset. */
export function resolveSettings(env: NodeJS.ProcessEnv, rows: NocoRecord[]): NodeJS.ProcessEnv {
  const indexed = new Map<string, string>();
  for (const row of rows) {
    const app = String(row.app ?? '');
    const key = String(row.settingKey ?? '');
    if (!SCOPES.includes(app) || !key) continue;
    const index = `${app}:${key}`;
    if (indexed.has(index))
      throw new ConfigError(`Duplicate PlatformConfig setting: ${app}/${key}`);
    indexed.set(index, String(row.settingValue ?? ''));
  }
  const resolved: NodeJS.ProcessEnv = { ...env };
  const keys = [
    ...SERVICE_ENV_VARS,
    'ID_REGISTER_WEBHOOK',
    'ASSET_STORAGE_DIR',
    'LEGACY_PBX_WRITES_ENABLED',
  ];
  for (const key of keys) {
    if (env[key]?.trim()) continue;
    for (const scope of SCOPES) {
      const value = indexed.get(`${scope}:${key}`);
      if (value?.trim()) {
        resolved[key] = value;
        break;
      }
    }
  }
  // The public platform domain is deliberately shared; trust contexts are not.
  if (!resolved.ID_PARENT_DOMAIN?.trim()) {
    for (const scope of SCOPES) {
      const value = indexed.get(`${scope}:PARENT_DOMAIN`);
      if (value?.trim()) {
        resolved.ID_PARENT_DOMAIN = value;
        break;
      }
    }
  }
  return resolved;
}

export async function loadPlatformConfig(
  env: NodeJS.ProcessEnv = process.env,
  suppliedApi?: NocoDbApi,
): Promise<AppConfig> {
  const url = env.NOCODB_BASE_URL?.trim();
  const token = env.NOCODB_API_TOKEN?.trim();
  if (!url || !token) return loadConfig(env);
  const api: NocoDbApi = suppliedApi ?? new HttpNocoDbApi(url, token, () => resolveBaseId(api));
  const tables = (await api.listTables()).filter(
    (table) => table.table_name === 'cfg_tbl_Setting' || table.title === 'cfg_tbl_Setting',
  );
  if (tables.length !== 1)
    throw new ConfigError(
      'PlatformConfig requires exactly one cfg_tbl_Setting table; run platform bootstrap',
    );
  const rows = await api.listRecords(tables[0]!.id, []);
  return loadConfig(resolveSettings(env, rows));
}
