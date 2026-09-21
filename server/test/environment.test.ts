import request from 'supertest';
import { afterEach, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { resolveSettings } from '../src/platform-config.js';
import { HttpOfficePulseClient } from '../src/officepulse/client.js';
import { scopedApp } from './helpers/scoped-app.js';

afterEach(() => vi.unstubAllGlobals());
it('resolves the global environment through PlatformConfig and allows blank/missing settings', () => {
  const rows = [{ app: '*', settingKey: 'ENVIRONMENT_NAME', settingValue: 'dev' }];
  expect(loadConfig(resolveSettings({}, rows)).environmentName).toBe('dev');
  expect(loadConfig(resolveSettings({ ENVIRONMENT_NAME: 'staging' }, rows)).environmentName).toBe(
    'staging',
  );
  expect(loadConfig({ ENVIRONMENT_NAME: '  ' }).environmentName).toBeNull();
  expect(loadConfig({}).environmentName).toBeNull();
  expect(() => loadConfig({ ENVIRONMENT_NAME: 'typo' })).toThrow(/ENVIRONMENT_NAME/);
});
it.each([
  ['dev', 'dev', true, false],
  ['prod', 'prod', true, false],
  ['dev', 'staging', true, true],
  [undefined, 'dev', true, false],
  ['dev', undefined, true, false],
  [undefined, undefined, true, false],
  ['dev', 'prod', false, false],
] as const)(
  'compares local %s and remote %s (reachable %s)',
  async (local, remote, reachable, mismatch) => {
    const ctx = await scopedApp(local ? { ENVIRONMENT_NAME: local } : {});
    ctx.api.readinessSnapshot = {
      ...ctx.api.readinessSnapshot,
      reachable,
      ...(remote ? { environmentName: remote } : {}),
    };
    const response = await ctx.send('get', '/api/environment');
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toEqual({
      environmentName: local ?? 'unknown',
      officePulse: {
        reachable,
        environmentName: reachable ? (remote ?? 'unknown') : 'unknown',
        pbxInstanceId: 'officepulse-test',
      },
      mismatch,
    });
    expect(JSON.stringify(response.body)).not.toContain('components');
  },
);
it('requires authentication and handles a missing/unreachable OfficePulse without a mismatch', async () => {
  const ctx = await scopedApp({ ENVIRONMENT_NAME: 'dev' });
  expect((await request(ctx.app).get('/api/environment')).status).toBe(401);
  ctx.deps.officePulse = null;
  expect((await ctx.send('get', '/api/environment')).body).toMatchObject({
    mismatch: false,
    officePulse: { reachable: false, environmentName: 'unknown' },
  });
  ctx.deps.officePulse = new HttpOfficePulseClient('https://officepulse.invalid');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('offline');
    }),
  );
  expect((await ctx.send('get', '/api/environment')).body).toMatchObject({
    mismatch: false,
    officePulse: { reachable: false },
  });
});
it.each([200, 503])('retains environment identity from readiness status %s', async (status) => {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            environmentName: 'prod',
            pbxInstanceId: 'officepulse-prod',
            ready: status === 200,
          }),
          { status },
        ),
    ),
  );
  const client = new HttpOfficePulseClient('https://officepulse.invalid');
  expect(await client.readiness()).toMatchObject({
    reachable: true,
    environmentName: 'prod',
    pbxInstanceId: 'officepulse-prod',
    ready: status === 200,
  });
});
