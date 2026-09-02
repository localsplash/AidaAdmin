import { describe, expect, it } from 'vitest';
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
  env.OFFICEPULSE_RUNTIME_DATABASE_URL =
    'mysql://aidaadmin_ro:pw@db.example.invalid:3306/aida_officepulse';
  return env;
};

describe('loadConfig', () => {
  it('applies defaults outside production', () => {
    const config = loadConfig({ NODE_ENV: 'test' });
    expect(config.port).toBe(3001);
    expect(config.nodeEnv).toBe('test');
    expect(config.missingServiceConfig).toEqual([...SERVICE_ENV_VARS]);
  });

  it('accepts a fully configured production environment', () => {
    const config = loadConfig(fullProductionEnv());
    expect(config.missingServiceConfig).toEqual([]);
  });

  it('fails production startup naming missing variables without values', () => {
    const env = fullProductionEnv();
    delete env.NOCODB_API_TOKEN;
    delete env.ID_TRUSTED_APP_CIDRS;
    let message = '';
    try {
      loadConfig(env);
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      message = (err as Error).message;
    }
    expect(message).toContain('NOCODB_API_TOKEN');
    expect(message).toContain('ID_TRUSTED_APP_CIDRS');
    // Names only: no configured value may leak into the error.
    expect(message).not.toContain('value-for-');
  });

  it('treats blank service values as missing', () => {
    const env = fullProductionEnv();
    env.OFFICEPULSE_RUNTIME_DATABASE_URL = '   ';
    expect(() => loadConfig(env)).toThrowError(/OFFICEPULSE_RUNTIME_DATABASE_URL/);
  });

  it('rejects the e2e fake session in production', () => {
    const env = fullProductionEnv();
    env.E2E_FAKE_SESSION = 'true';
    expect(() => loadConfig(env)).toThrowError(/E2E_FAKE_SESSION/);
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
    env.ID_EVENT_SOURCE_CIDRS = 'not-a-cidr';
    expect(() => loadConfig(env)).toThrowError(/ID_EVENT_SOURCE_CIDRS/);
  });

  it('rejects production CIDR allowlists that are effectively empty', () => {
    const env = fullProductionEnv();
    env.ID_TRUSTED_PROXY_CIDRS = ' , ';
    expect(() => loadConfig(env)).toThrowError(/ID_TRUSTED_PROXY_CIDRS/);
  });
});
