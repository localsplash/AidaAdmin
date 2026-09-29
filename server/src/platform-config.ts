import { ConfigError, loadConfig, SERVICE_ENV_VARS, type AppConfig } from './config.js';
import { HttpNocoDbApi, type NocoDbApi, type NocoRecord } from './nocodb/api.js';
import { resolveBaseId } from './nocodb/base.js';

import {
  DATABASE_SETTING_KEYS,
  RUNTIME_DATABASE_SCOPE,
  type DatabaseSettingKey,
  type DatabaseSettings,
} from './db/config.js';

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
    'ENVIRONMENT_NAME',
  ];
  for (const key of keys) {
    if (env[key]?.trim()) continue;
    // Database credentials cannot fall through to another application's shared scope.
    const scopes = DATABASE_SETTING_KEYS.includes(key as DatabaseSettingKey)
      ? ['aida-admin']
      : SCOPES;
    for (const scope of scopes) {
      const value = indexed.get(`${scope}:${key}`);
      if (value?.trim()) {
        resolved[key] = value;
        break;
      }
    }
  }
  // The platform's own keys are read under their platform names: trustedCIDR
  // as itself (it is in SERVICE_ENV_VARS), PARENT_DOMAIN as ID_PARENT_DOMAIN.
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

/** The reader is a separate scoped DB_* configuration, not an alias of the writer. */
export function resolveRuntimeDatabaseSettings(rows: NocoRecord[]): DatabaseSettings {
  const settings: DatabaseSettings = {};
  const seen = new Set<string>();
  for (const row of rows) {
    const key = String(row.settingKey ?? '') as DatabaseSettingKey;
    if (row.app !== RUNTIME_DATABASE_SCOPE || !DATABASE_SETTING_KEYS.includes(key)) continue;
    if (seen.has(key))
      throw new ConfigError(`Duplicate PlatformConfig setting: ${RUNTIME_DATABASE_SCOPE}/${key}`);
    seen.add(key);
    const value = String(row.settingValue ?? '');
    if (value.trim()) settings[key] = value;
  }
  return settings;
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
  return loadConfig(resolveSettings(env, rows), resolveRuntimeDatabaseSettings(rows));
}
