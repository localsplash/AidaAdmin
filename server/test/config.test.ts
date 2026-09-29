import { describe, expect, it } from 'vitest';
import { REQUIRED_DATABASE_KEYS, RUNTIME_DATABASE_SCOPE } from '../src/db/config.js';
import { ConfigError, loadConfig, REQUIRED_CIDR_VARS, SERVICE_ENV_VARS } from '../src/config.js';

const fullProductionEnv = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { NODE_ENV: 'production' };
  for (const name of SERVICE_ENV_VARS) {
    env[name] = `value-for-${name}`;
  }
  // CIDR allowlists must hold real IPv4 CIDRs in production.
  for (const name of REQUIRED_CIDR_VARS) {
    env[name] = '10.0.0.0/8, 192.0.2.10/32';
  }
  Object.assign(env, {
    DB_HOST: 'db.test',
    DB_PORT: '3306',
    DB_NAME: 'aida_admin_db',
    DB_USER: 'aida_admin_app',
    DB_PASSWORD: 'admin-password',
  });
  return env;
};

const runtimeSettings = {
  DB_HOST: 'runtime.test',
  DB_NAME: 'aidacalls_db',
  DB_USER: 'aidaadmin_ro',
  DB_PASSWORD: 'reader-password',
};

describe('loadConfig', () => {
  it('applies defaults outside production', () => {
    const config = loadConfig({ NODE_ENV: 'test' });
    expect(config.port).toBe(3001);
    expect(config.nodeEnv).toBe('test');
    expect(config.missingServiceConfig).toEqual([
      ...SERVICE_ENV_VARS.filter(
        (name) =>
          !name.startsWith('LIVEKIT_') &&
          ![
            'DB_PORT',
            'ID_CLIENT_SECRET',
            'ID_PUBLIC_BASE_URL',
            'OFFICEPULSE_PROVISIONING_BASE_URL',
          ].includes(name),
      ),
      ...REQUIRED_DATABASE_KEYS.map((key) => `${RUNTIME_DATABASE_SCOPE}/${key}`),
    ]);
  });

  it('accepts a fully configured production environment', () => {
    const config = loadConfig(fullProductionEnv(), runtimeSettings);
    expect(config.missingServiceConfig).toEqual([]);
  });

  it('fails production startup naming missing variables without values', () => {
    const env = fullProductionEnv();
    delete env.NOCODB_API_TOKEN;
    delete env.trustedCIDR;
    let message = '';
    try {
      loadConfig(env, runtimeSettings);
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      message = (err as Error).message;
    }
    expect(message).toContain('NOCODB_API_TOKEN');
    expect(message).toContain('trustedCIDR');
    // Names only: no configured value may leak into the error.
    expect(message).not.toContain('value-for-');
  });

  it('treats blank service values as missing', () => {
    const env = fullProductionEnv();
    env.DB_HOST = '   ';
    expect(() => loadConfig(env, runtimeSettings)).toThrowError(/DB_HOST/);
  });

  it('rejects the e2e fake session in production', () => {
    const env = fullProductionEnv();
    env.E2E_FAKE_SESSION = 'true';
    expect(() => loadConfig(env, runtimeSettings)).toThrowError(/E2E_FAKE_SESSION/);
  });

  it('parses boolean environment strings strictly', () => {
    // "false" must be false — z.coerce.boolean would treat it as true.
    expect(loadConfig({ NODE_ENV: 'test', E2E_FAKE_SESSION: 'false' }).e2eFakeSession).toBe(false);
    expect(loadConfig({ NODE_ENV: 'test', ID_REGISTER_WEBHOOK: '0' }).idRegisterWebhook).toBe(
      false,
    );
    expect(loadConfig({ NODE_ENV: 'test', E2E_FAKE_SESSION: 'true' }).e2eFakeSession).toBe(true);
    expect(loadConfig({ NODE_ENV: 'test', ID_REGISTER_WEBHOOK: '1' }).idRegisterWebhook).toBe(true);
    expect(() => loadConfig({ NODE_ENV: 'test', E2E_FAKE_SESSION: 'banana' })).toThrowError(
      /E2E_FAKE_SESSION/,
    );
  });

  it('rejects an invalid port', () => {
    expect(() => loadConfig({ NODE_ENV: 'test', PORT: 'not-a-port' })).toThrowError(ConfigError);
  });

  it('rejects production CIDR allowlists that are malformed', () => {
    const env = fullProductionEnv();
    env.trustedCIDR = 'not-a-cidr';
    expect(() => loadConfig(env, runtimeSettings)).toThrowError(/trustedCIDR/);
  });

  it('rejects production CIDR allowlists that are effectively empty', () => {
    const env = fullProductionEnv();
    env.ID_TRUSTED_PROXY_CIDRS = ' , ';
    expect(() => loadConfig(env, runtimeSettings)).toThrowError(/ID_TRUSTED_PROXY_CIDRS/);
  });
});

it('accepts canonical OfficePulse URL while preserving the existing server-only setting', () => {
  expect(
    loadConfig({
      NODE_ENV: 'test',
      OFFICEPULSE_API_BASE_URL: 'https://pbx.test',
      OFFICEPULSE_PROVISIONING_BASE_URL: 'https://old.test',
    }).serviceConfig.OFFICEPULSE_PROVISIONING_BASE_URL,
  ).toBe('https://pbx.test');
});

it('requires scoped runtime credentials in production without reusing the admin account', () => {
  expect(() => loadConfig(fullProductionEnv())).toThrow(/aida-admin-runtime\/DB_USER/);
});

it('uses literal DB fields for two isolated connections and defaults the port', () => {
  const password = " p@ss:%2F/'\\$()\n";
  const config = loadConfig(
    { ...fullProductionEnv(), DB_PASSWORD: password },
    { ...runtimeSettings, DB_PASSWORD: 'reader%40password' },
  );
  expect(config.database).toEqual({
    host: 'db.test',
    port: 3306,
    database: 'aida_admin_db',
    user: 'aida_admin_app',
    password,
  });
  expect(config.runtimeDatabase).toEqual({
    host: 'runtime.test',
    port: 3306,
    database: 'aidacalls_db',
    user: 'aidaadmin_ro',
    password: 'reader%40password',
  });
});

it('validates DB ports and schema boundaries without disclosing credentials', () => {
  for (const DB_PORT of ['0', '65536', '1.5', 'not-secret']) {
    expect(() => loadConfig({ ...fullProductionEnv(), DB_PORT }, runtimeSettings)).toThrow(
      /DB_PORT/,
    );
    expect(() => loadConfig(fullProductionEnv(), { ...runtimeSettings, DB_PORT })).toThrow(
      /aida-admin-runtime\/DB_PORT/,
    );
  }
  expect(() =>
    loadConfig({ ...fullProductionEnv(), DB_NAME: 'platform_db' }, runtimeSettings),
  ).toThrow(/aida-admin\/DB_NAME/);
  expect(() =>
    loadConfig(fullProductionEnv(), { ...runtimeSettings, DB_NAME: 'asterisk' }),
  ).toThrow(/aida-admin-runtime\/DB_NAME/);
});
