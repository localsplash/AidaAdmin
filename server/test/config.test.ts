import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, SERVICE_ENV_VARS } from '../src/config.js';

const fullProductionEnv = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { NODE_ENV: 'production' };
  for (const name of SERVICE_ENV_VARS) {
    env[name] = `value-for-${name}`;
  }
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
    env.AIDACONTROL_BASE_URL = '   ';
    expect(() => loadConfig(env)).toThrowError(/AIDACONTROL_BASE_URL/);
  });

  it('rejects the e2e fake session in production', () => {
    const env = fullProductionEnv();
    env.E2E_FAKE_SESSION = 'true';
    expect(() => loadConfig(env)).toThrowError(/E2E_FAKE_SESSION/);
  });

  it('rejects an invalid port', () => {
    expect(() => loadConfig({ NODE_ENV: 'test', PORT: 'not-a-port' })).toThrowError(ConfigError);
  });
});
