import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  resolveSettings,
  resolveRuntimeDatabaseSettings,
  loadPlatformConfig,
} from '../src/platform-config.js';
import { loadConfig } from '../src/config.js';
import { mysqlConnectionConfig } from '../src/db/config.js';
import { FakeNocoDbApi } from './helpers/fake-nocodb.js';

const setting = (app: string, settingKey: string, settingValue: string) => ({
  app,
  settingKey,
  settingValue,
});
const admin = {
  DB_HOST: 'admin.test',
  DB_NAME: 'aida_admin_db',
  DB_USER: 'aida_admin_app',
  DB_PASSWORD: 'admin@%:/\n',
};
const reader = {
  DB_HOST: 'runtime.test',
  DB_NAME: 'aidacalls_db',
  DB_USER: 'aidaadmin_ro',
  DB_PASSWORD: ' reader@%:/\n',
};
const rows = [
  ...Object.entries(admin).map(([key, value]) => setting('aida-admin', key, value)),
  ...Object.entries(reader).map(([key, value]) => setting('aida-admin-runtime', key, value)),
];
afterEach(() => vi.restoreAllMocks());

describe('scoped database settings', () => {
  it('resolves independent DB_* rows without decoding either password', () => {
    const config = loadConfig(
      resolveSettings({ NODE_ENV: 'test' }, rows),
      resolveRuntimeDatabaseSettings(rows),
    );
    expect(config.database?.user).toBe(admin.DB_USER);
    expect(config.database?.password).toBe(admin.DB_PASSWORD);
    expect(config.runtimeDatabase?.user).toBe(reader.DB_USER);
    expect(config.runtimeDatabase?.password).toBe(reader.DB_PASSWORD);
  });

  it('never borrows global, shared, writer, or environment credentials for the reader', () => {
    const unrelated = ['*', 'aida', 'officepulse', 'aida-agent'].flatMap((app) =>
      Object.entries(admin).map(([key, value]) => setting(app, key, value)),
    );
    expect(resolveSettings({}, unrelated).DB_USER).toBeUndefined();
    expect(resolveRuntimeDatabaseSettings(unrelated)).toEqual({});
    expect(loadConfig({ NODE_ENV: 'test', ...admin }).runtimeDatabase).toBeNull();
    expect(resolveSettings({ DB_HOST: 'override.test' }, rows).DB_HOST).toBe('override.test');
    expect(resolveRuntimeDatabaseSettings(rows).DB_HOST).toBe('runtime.test');
  });

  it('rejects duplicate and missing reader rows using key names only', () => {
    expect(() =>
      resolveRuntimeDatabaseSettings([
        ...rows,
        setting('aida-admin-runtime', 'DB_PASSWORD', 'dont-show-this'),
      ]),
    ).toThrow(/Duplicate.*aida-admin-runtime\/DB_PASSWORD/);
    expect(() => mysqlConnectionConfig({ DB_HOST: 'h' }, 'reader')).toThrow(/reader\/DB_USER/);
  });

  it('loads both connections through the NocoDB startup path', async () => {
    const api = new FakeNocoDbApi();
    vi.spyOn(api, 'listTables').mockResolvedValue([
      { id: 'settings', title: 'cfg_tbl_Setting', table_name: 'cfg_tbl_Setting' },
    ]);
    vi.spyOn(api, 'listRecords').mockResolvedValue(rows);
    const config = await loadPlatformConfig(
      { NODE_ENV: 'test', NOCODB_BASE_URL: 'http://nocodb.test', NOCODB_API_TOKEN: 'token' },
      api,
    );
    expect(config.database?.host).toBe(admin.DB_HOST);
    expect(config.runtimeDatabase?.host).toBe(reader.DB_HOST);
  });
});
