import { describe, expect, it, vi, afterEach } from 'vitest';
import { resolveSettings, loadPlatformConfig } from '../src/platform-config.js';
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
const rows = Object.entries(admin).map(([key, value]) => setting('aida-admin', key, value));
afterEach(() => vi.restoreAllMocks());

describe('scoped database settings', () => {
  it('resolves its own DB_* rows without decoding the password', () => {
    const config = loadConfig(resolveSettings({ NODE_ENV: 'test' }, rows));
    expect(config.database?.user).toBe(admin.DB_USER);
    expect(config.database?.password).toBe(admin.DB_PASSWORD);
  });

  it("never borrows global, shared or another application's credentials", () => {
    const unrelated = ['*', 'aida', 'aida-pbx', 'aida-pbx-reader', 'aida-agent'].flatMap((app) =>
      Object.entries(admin).map(([key, value]) => setting(app, key, value)),
    );
    expect(resolveSettings({}, unrelated).DB_USER).toBeUndefined();
    expect(resolveSettings({ DB_HOST: 'override.test' }, rows).DB_HOST).toBe('override.test');
  });

  it('rejects duplicate and missing rows using key names only', () => {
    expect(() =>
      resolveSettings({}, [...rows, setting('aida-admin', 'DB_PASSWORD', 'dont-show-this')]),
    ).toThrow(/Duplicate.*aida-admin\/DB_PASSWORD/);
    expect(() => mysqlConnectionConfig({ DB_HOST: 'h' }, 'aida-admin')).toThrow(
      /aida-admin\/DB_USER/,
    );
  });

  it('loads its connection through the NocoDB startup path', async () => {
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
  });
});
